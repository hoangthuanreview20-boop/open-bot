/**
 * Hook execution log (v1.01, T2).
 *
 * Hooks are invisible automation unless someone can see what ran, what
 * it decided, and what failed. This module is the queryable record of
 * every hook invocation: an in-memory ring buffer (bounded, so a chatty
 * hook can never grow memory unboundedly) with optional best-effort
 * JSONL file append for the Settings UI's "recent hook runs" view and
 * for post-mortem debugging.
 *
 * The log NEVER throws and NEVER breaks a run: `record()` swallows file
 * errors, `list()` always returns what is in memory, and a full buffer
 * drops the oldest record. The runner wires it in through
 * `HookRunnerOptions.executionLog` (see `runner.ts` `invokeOne`) — one
 * choke point, so every `run*` method is covered, including the new
 * Subagent/Compact/Prompt events.
 *
 * A record is deliberately small and secret-free: hook name, event,
 * decision action, duration, reason, error message, timeout flag. Hook
 * stdout/stderr are NOT stored (they can contain workspace paths and,
 * for a misbehaving command, secrets) — the runner's logger callback
 * is the place for those.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HookDecisionAction, HookEventKind } from './types';

/** Default ring-buffer capacity (records kept in memory). */
export const DEFAULT_HOOK_LOG_MAX_RECORDS = 500;
/** Hard cap: a host cannot ask for an unbounded in-memory log. */
export const MAX_HOOK_LOG_MAX_RECORDS = 10_000;
/**
 * JSONL file size that triggers a prune (checked every 50 appends, so
 * the stat call costs nothing in practice). The file is rewritten
 * keeping only the newest `HOOK_LOG_FILE_KEEP_LINES` lines.
 */
export const MAX_HOOK_LOG_FILE_BYTES = 1_000_000;
export const HOOK_LOG_FILE_KEEP_LINES = 1000;
/** How many appends between file-size checks. */
const HOOK_LOG_FILE_CHECK_EVERY = 50;

/** Per-hook execution stats (one row per hook name). */
export interface HookLogPerHookSummary {
  hookName: string;
  total: number;
  blocks: number;
  errors: number;
  timeouts: number;
  /** Mean runtime in ms (rounded down). */
  avgDurationMs: number;
  /** ISO timestamp of the newest run, when any. */
  lastAt?: string;
}

/**
 * Summarise a list of hook execution records (e.g. read from the JSONL
 * file) into per-hook stats, most-run hook first. Pure — the CLI and
 * Settings both use it; the in-memory `HookExecutionLog.perHookSummary`
 * is the same computation over its buffer.
 */
export function summarizeHookLogRecords(records: HookExecutionRecord[]): HookLogPerHookSummary[] {
  const byName = new Map<
    string,
    {
      total: number;
      blocks: number;
      errors: number;
      timeouts: number;
      durationSum: number;
      lastAt: string;
      lastSeq: number;
    }
  >();
  for (const r of records) {
    const row = byName.get(r.hookName) ?? {
      total: 0,
      blocks: 0,
      errors: 0,
      timeouts: 0,
      durationSum: 0,
      lastAt: r.at,
      lastSeq: r.seq,
    };
    row.total += 1;
    if (r.action === 'block') row.blocks += 1;
    if (r.action === 'error') row.errors += 1;
    if (r.timedOut) row.timeouts += 1;
    row.durationSum += r.durationMs;
    if (r.seq >= row.lastSeq) {
      row.lastSeq = r.seq;
      row.lastAt = r.at;
    }
    byName.set(r.hookName, row);
  }
  return [...byName.entries()]
    .map(([hookName, row]) => ({
      hookName,
      total: row.total,
      blocks: row.blocks,
      errors: row.errors,
      timeouts: row.timeouts,
      avgDurationMs: row.total > 0 ? Math.floor(row.durationSum / row.total) : 0,
      lastAt: row.lastAt,
    }))
    .sort((a, b) => b.total - a.total || a.hookName.localeCompare(b.hookName));
}

/** One hook invocation, as recorded. */
export interface HookExecutionRecord {
  /** Monotonic sequence number (per log instance, starts at 1). */
  seq: number;
  /** ISO timestamp of when the hook finished. */
  at: string;
  /** Name of the hook that ran. */
  hookName: string;
  /** Event the hook ran for. */
  event: HookEventKind;
  /** What the hook decided (`error` when it threw / timed out / returned garbage). */
  action: HookDecisionAction | 'error';
  /** Wall-clock runtime in ms. */
  durationMs: number;
  /** Human-readable reason from the decision, when given. */
  reason?: string;
  /** Error message when `action === 'error'` (or a hook error that still allowed through). */
  error?: string;
  /** True when the hook was killed by the per-hook timeout. */
  timedOut: boolean;
}

/** Filters for `HookExecutionLog.list()`. All filters are ANDed. */
export interface HookLogListFilter {
  /** Only records for this event. */
  event?: HookEventKind;
  /** Only records for this hook name. */
  hookName?: string;
  /** Only records with this outcome. */
  action?: HookDecisionAction | 'error';
  /** Only records with `timedOut === true`. */
  timedOutOnly?: boolean;
  /** Max records returned (newest first). Default: all buffered. */
  limit?: number;
}

export interface HookExecutionLogOptions {
  /** Ring-buffer capacity. Default `DEFAULT_HOOK_LOG_MAX_RECORDS` (500). */
  maxRecords?: number;
  /**
   * JSONL file the log appends to (one record per line, best-effort).
   * The directory is created on first write. Omit for memory-only.
   */
  filePath?: string;
}

/**
 * Append-only (in memory) ring buffer of hook execution records, with
 * optional JSONL file persistence. Safe to share across threads of one
 * process — all methods are synchronous and never throw.
 */
export class HookExecutionLog {
  private readonly maxRecords: number;
  private readonly filePath?: string;
  private readonly records: HookExecutionRecord[] = [];
  private seq = 0;
  /** Appends since the last file-size check (prune trigger). */
  private appendsSinceCheck = 0;

  constructor(opts: HookExecutionLogOptions = {}) {
    const asked = opts.maxRecords ?? DEFAULT_HOOK_LOG_MAX_RECORDS;
    this.maxRecords = Math.min(
      Math.max(1, Math.floor(asked)),
      MAX_HOOK_LOG_MAX_RECORDS,
    );
    this.filePath = opts.filePath;
  }

  /** Capacity of the ring buffer. */
  capacity(): number {
    return this.maxRecords;
  }

  /** Number of records currently buffered. */
  size(): number {
    return this.records.length;
  }

  /**
   * Record one hook invocation. `at` defaults to now. Never throws:
   * a file-append failure is swallowed (the in-memory record stays).
   */
  record(input: Omit<HookExecutionRecord, 'seq' | 'at'> & { at?: string }): HookExecutionRecord {
    const record: HookExecutionRecord = {
      seq: this.seq + 1,
      at: input.at ?? new Date().toISOString(),
      hookName: input.hookName,
      event: input.event,
      action: input.action,
      durationMs: Math.max(0, Math.floor(input.durationMs)),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      timedOut: input.timedOut === true,
    };
    this.seq = record.seq;
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
    this.appendToFile(record);
    return record;
  }

  /**
   * Records matching the filter, NEWEST FIRST. `limit` caps the result
   * (default: everything buffered). Never throws.
   */
  list(filter: HookLogListFilter = {}): HookExecutionRecord[] {
    const out: HookExecutionRecord[] = [];
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i]!;
      if (filter.event !== undefined && r.event !== filter.event) continue;
      if (filter.hookName !== undefined && r.hookName !== filter.hookName) continue;
      if (filter.action !== undefined && r.action !== filter.action) continue;
      if (filter.timedOutOnly === true && !r.timedOut) continue;
      if (filter.limit !== undefined && out.length >= Math.max(0, filter.limit)) break;
      out.push(r);
    }
    return out;
  }

  /** Oldest buffered record, when any (useful for "log rotated" notes). */
  oldest(): HookExecutionRecord | undefined {
    return this.records[0];
  }

  /** Newest buffered record, when any. */
  newest(): HookExecutionRecord | undefined {
    return this.records[this.records.length - 1];
  }

  /** How many records errored / timed out / blocked, for a quick summary. */
  summary(): {
    total: number;
    errors: number;
    timeouts: number;
    blocks: number;
    byEvent: Partial<Record<HookEventKind, number>>;
  } {
    const byEvent: Partial<Record<HookEventKind, number>> = {};
    let errors = 0;
    let timeouts = 0;
    let blocks = 0;
    for (const r of this.records) {
      byEvent[r.event] = (byEvent[r.event] ?? 0) + 1;
      if (r.action === 'error') errors += 1;
      if (r.timedOut) timeouts += 1;
      if (r.action === 'block') blocks += 1;
    }
    return { total: this.records.length, errors, timeouts, blocks, byEvent };
  }

  /** Per-hook stats over the buffered records (see `summarizeHookLogRecords`). */
  perHookSummary(): HookLogPerHookSummary[] {
    return summarizeHookLogRecords(this.records);
  }

  /** All buffered records as JSONL (oldest first), for export / debugging. */
  toJSONL(): string {
    return this.records.map((r) => JSON.stringify(r)).join('\n');
  }

  /** Drop all buffered records (the file, when set, is left untouched). */
  clear(): void {
    this.records.length = 0;
  }

  private appendToFile(record: HookExecutionRecord): void {
    if (!this.filePath) return;
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
      this.appendsSinceCheck += 1;
      if (this.appendsSinceCheck >= HOOK_LOG_FILE_CHECK_EVERY) {
        this.appendsSinceCheck = 0;
        this.pruneFileIfNeeded();
      }
    } catch {
      // Best-effort persistence only: a read-only userData dir must
      // never break a run. The in-memory record is unaffected.
    }
  }

  /**
   * Rewrite the JSONL file keeping only the newest
   * `HOOK_LOG_FILE_KEEP_LINES` lines, when it grew past
   * `MAX_HOOK_LOG_FILE_BYTES`. Best-effort: any failure is swallowed
   * (the file keeps growing until the next check, which is harmless).
   */
  private pruneFileIfNeeded(): void {
    if (!this.filePath) return;
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size <= MAX_HOOK_LOG_FILE_BYTES) return;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      if (lines.length <= HOOK_LOG_FILE_KEEP_LINES) return;
      const kept = lines.slice(-HOOK_LOG_FILE_KEEP_LINES);
      fs.writeFileSync(this.filePath, `${kept.join('\n')}\n`, 'utf8');
    } catch {
      // Best-effort only.
    }
  }
}

/**
 * Read back the JSONL file a `HookExecutionLog` wrote (newest first,
 * capped at `limit`). Malformed lines are skipped, never thrown — a
 * half-written line from a killed process must not hide the rest.
 * Used by the main process for the Settings "recent hook runs" view.
 */
export function readHookLogFile(
  filePath: string,
  limit = 100,
): HookExecutionRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const out: HookExecutionRecord[] = [];
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0 && out.length < Math.max(0, limit); i--) {
    try {
      const parsed: unknown = JSON.parse(lines[i]!);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const rec = parsed as HookExecutionRecord;
      if (typeof rec.hookName !== 'string' || typeof rec.event !== 'string') continue;
      out.push(rec);
    } catch {
      continue;
    }
  }
  return out;
}
