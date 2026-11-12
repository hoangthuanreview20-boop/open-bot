/**
 * TraceStore — JSONL persistence for run traces (v0.10, P0-6).
 *
 * STORAGE CHOICE — one JSON line per finished trace, in
 * `<userData>/traces.jsonl` (path supplied by the caller; the desktop
 * main process passes `app.getPath('userData')`). JSONL, not SQLite:
 * a trace is written once, read whole, and never updated — exactly the
 * append-mostly shape `usage.json` already uses for the same reason,
 * and a human can `tail` the file while debugging. The file only ever
 * holds span SUMMARIES (the tracer sanitises them first), but it is
 * still written mode 0600 on rewrite — same posture as usage.json.
 *
 * CAP — `maxTraces` (default 100) bounds disk use: appending past the
 * cap drops the OLDEST traces (rewrite via temp file + rename, so a
 * crash mid-prune cannot corrupt the file). Reads tolerate corrupt
 * lines (a half-written line from a killed process is skipped, the
 * rest of the file still loads).
 *
 * No Electron import: the caller supplies the file path, so the store
 * is unit-testable under plain node:test.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SpanKind, Trace, TraceSpan, TraceStatus } from './tracer';

/** Default file name under userData (the main process joins it onto the userData dir). */
export const TRACES_FILE = 'traces.jsonl';
/** Default cap: how many finished traces are kept on disk. */
export const DEFAULT_MAX_TRACES = 100;
/** Hard guard: a single trace never stores more spans than this. */
export const MAX_SPANS_PER_TRACE = 1000;

export interface TraceStoreOptions {
  /** Full path of the JSONL file, e.g. `<userData>/traces.jsonl`. */
  filePath: string;
  /** How many traces to keep (oldest dropped first). Defaults to 100. */
  maxTraces?: number;
}

/** List view: everything the trace list UI needs, without the spans. */
export interface TraceSummary {
  traceId: string;
  runId: string;
  botId: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  status: TraceStatus;
  spanCount: number;
  /** Span kinds present in this trace, in first-seen order. */
  kinds: SpanKind[];
  /** Token usage summed over the trace's finished spans (0 when unreported). */
  totalInputTokens: number;
  /** Token usage summed over the trace's finished spans (0 when unreported). */
  totalOutputTokens: number;
}

export interface ListTracesFilter {
  botId?: string;
  runId?: string;
  /** Max summaries to return (newest first). Defaults to all. */
  limit?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SPAN_KINDS: ReadonlySet<string> = new Set([
  'llm',
  'tool',
  'handoff',
  'guardrail',
  'approval',
  'error',
]);

/** Validate one parsed line; returns the trace or null when malformed. */
function parseTrace(value: unknown): Trace | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.traceId !== 'string' ||
    typeof value.runId !== 'string' ||
    typeof value.botId !== 'string' ||
    typeof value.startedAt !== 'number' ||
    !Array.isArray(value.spans)
  ) {
    return null;
  }
  const spans: TraceSpan[] = [];
  for (const raw of value.spans as unknown[]) {
    if (!isRecord(raw)) return null;
    if (
      typeof raw.id !== 'string' ||
      typeof raw.traceId !== 'string' ||
      typeof raw.runId !== 'string' ||
      typeof raw.botId !== 'string' ||
      typeof raw.kind !== 'string' ||
      !SPAN_KINDS.has(raw.kind) ||
      typeof raw.name !== 'string' ||
      typeof raw.startedAt !== 'number' ||
      (raw.endedAt !== null && typeof raw.endedAt !== 'number') ||
      (raw.durationMs !== null && typeof raw.durationMs !== 'number') ||
      (raw.status !== 'ok' && raw.status !== 'error' && raw.status !== 'pending' && raw.status !== 'blocked')
    ) {
      return null;
    }
    spans.push(raw as unknown as TraceSpan);
  }
  return {
    traceId: value.traceId,
    runId: value.runId,
    botId: value.botId,
    startedAt: value.startedAt,
    endedAt: typeof value.endedAt === 'number' ? value.endedAt : null,
    durationMs: typeof value.durationMs === 'number' ? value.durationMs : null,
    status: value.status === 'ok' || value.status === 'error' ? value.status : 'running',
    // v0.33 (P0-6): traces written before token totals existed read as 0.
    totalInputTokens: typeof value.totalInputTokens === 'number' ? value.totalInputTokens : 0,
    totalOutputTokens: typeof value.totalOutputTokens === 'number' ? value.totalOutputTokens : 0,
    spans,
  };
}

export class TraceStore {
  private readonly filePath: string;
  private readonly maxTraces: number;

  constructor(options: TraceStoreOptions) {
    if (!options.filePath) throw new Error('TraceStore needs a filePath.');
    this.filePath = options.filePath;
    this.maxTraces =
      typeof options.maxTraces === 'number' && Number.isInteger(options.maxTraces) && options.maxTraces > 0
        ? options.maxTraces
        : DEFAULT_MAX_TRACES;
  }

  /** Path of the JSONL store file. */
  get path(): string {
    return this.filePath;
  }

  /**
   * Append one finished trace (one JSON line). Spans past
   * `MAX_SPANS_PER_TRACE` are dropped oldest-first so a runaway run
   * cannot grow the file without bound. Appending past `maxTraces`
   * prunes the oldest traces. Returns the trace as stored.
   */
  appendTrace(trace: Trace): Trace {
    if (!trace || typeof trace.traceId !== 'string' || trace.traceId.length === 0) {
      throw new Error('TraceStore.appendTrace needs a trace with a traceId.');
    }
    if (
      typeof trace.runId !== 'string' ||
      trace.runId.length === 0 ||
      typeof trace.botId !== 'string' ||
      trace.botId.length === 0
    ) {
      throw new Error('TraceStore.appendTrace needs a trace with runId and botId.');
    }
    const stored: Trace = {
      ...trace,
      spans: trace.spans.slice(-MAX_SPANS_PER_TRACE),
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
    this.pruneIfNeeded();
    return stored;
  }

  /** Summaries of stored traces, newest first (optional bot/run filter + limit). */
  listTraces(filter: ListTracesFilter = {}): TraceSummary[] {
    const traces = this.readAll();
    const filtered = traces.filter(
      (t) =>
        (filter.botId === undefined || t.botId === filter.botId) &&
        (filter.runId === undefined || t.runId === filter.runId),
    );
    const newestFirst = filtered.reverse();
    const limited =
      typeof filter.limit === 'number' && filter.limit > 0 ? newestFirst.slice(0, filter.limit) : newestFirst;
    return limited.map((t) => toSummary(t));
  }

  /** Full trace (with spans) by trace id, or null when not stored. */
  getTrace(traceId: string): Trace | null {
    if (typeof traceId !== 'string' || traceId.length === 0) return null;
    const traces = this.readAll();
    for (let i = traces.length - 1; i >= 0; i -= 1) {
      if (traces[i].traceId === traceId) return traces[i];
    }
    return null;
  }

  /** Full trace (with spans) by run id, or null when not stored. */
  getTraceByRunId(runId: string): Trace | null {
    if (typeof runId !== 'string' || runId.length === 0) return null;
    const traces = this.readAll();
    for (let i = traces.length - 1; i >= 0; i -= 1) {
      if (traces[i].runId === runId) return traces[i];
    }
    return null;
  }

  /** How many traces are stored (corrupt lines excluded). */
  count(): number {
    return this.readAll().length;
  }

  /** Delete the whole store file (manual, user-initiated cleanup). */
  clear(): void {
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch {
      // Best-effort: a missing file is already clear.
    }
  }

  // --- Internals ------------------------------------------------------------

  /** All stored traces in file order (oldest first); corrupt lines are skipped. */
  private readAll(): Trace[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: Trace[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = parseTrace(JSON.parse(trimmed));
        if (parsed) out.push(parsed);
      } catch {
        // Corrupt line (e.g. killed mid-append): skip it, keep the rest.
        continue;
      }
    }
    return out;
  }

  /** Rewrite the file keeping only the newest `maxTraces` traces (no-op when under the cap). */
  private pruneIfNeeded(): void {
    const traces = this.readAll();
    if (traces.length <= this.maxTraces) return;
    this.rewrite(traces.slice(-this.maxTraces));
  }

  /** Atomic rewrite: temp file + rename, mode 0600. */
  private rewrite(traces: Trace[]): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp-${process.pid}`;
    const body = traces.map((t) => JSON.stringify(t)).join('\n');
    fs.writeFileSync(tmpPath, body.length > 0 ? `${body}\n` : '', { mode: 0o600 });
    fs.renameSync(tmpPath, this.filePath);
  }
}

function toSummary(trace: Trace): TraceSummary {
  const kinds: SpanKind[] = [];
  for (const span of trace.spans) {
    if (!kinds.includes(span.kind)) kinds.push(span.kind);
  }
  return {
    traceId: trace.traceId,
    runId: trace.runId,
    botId: trace.botId,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    durationMs: trace.durationMs,
    status: trace.status,
    spanCount: trace.spans.length,
    kinds,
    totalInputTokens: trace.totalInputTokens ?? 0,
    totalOutputTokens: trace.totalOutputTokens ?? 0,
  };
}
