/**
 * Durable run journal — append-only JSONL record of an agent run
 * (v1.02 rescue port of the v0.99 work).
 *
 * Every step of a run is written to `<journalDir>/<runId>.journal.jsonl`
 * with a monotonic `seq` and an idempotency key per step, so a crash
 * mid-run never loses history and a finished step is never executed
 * twice. Secrets are redacted before writing (via the tracer's
 * `sanitizeValue`); corrupt lines are skipped on read.
 *
 * Entry kinds: `run_started`, `step_started`, `step_completed`,
 * `tool_call`, `tool_result`, `model_call`, `router_decision`,
 * `state_transition`, `error`, `retry`, `approval`, `cancel`,
 * `checkpoint`, `run_finished`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { sanitizeValue } from '../tracing/tracer';

export type JournalEntryKind =
  | 'run_started'
  | 'step_started'
  | 'step_completed'
  | 'tool_call'
  | 'tool_result'
  | 'model_call'
  | 'router_decision'
  | 'state_transition'
  | 'error'
  | 'retry'
  | 'approval'
  | 'cancel'
  | 'checkpoint'
  | 'run_finished';

export interface JournalEntry {
  seq: number;
  at: string;
  runId: string;
  kind: JournalEntryKind;
  /** Idempotency key (step id / tool call id). Duplicate keys are refused. */
  key?: string;
  /** Payload (sanitized on write). */
  data?: Record<string, unknown>;
}

export interface JournalCheckpointData {
  messages: unknown[];
  completedToolCalls: Array<{ call: unknown; result: unknown }>;
  tokensUsed: number;
  nextStepIndex: number;
}

export interface JournalVerification {
  ok: boolean;
  entries: number;
  badLines: number;
  issues: string[];
  hasCheckpoint: boolean;
  finished: boolean;
}

/** Append-only journal for one run. */
export class RunJournal {
  readonly runId: string;
  readonly filePath: string;
  private seq = 0;
  private readonly seenKeys = new Set<string>();
  private finished = false;

  constructor(runId: string, journalDir: string) {
    this.runId = runId;
    fs.mkdirSync(journalDir, { recursive: true });
    this.filePath = path.join(journalDir, `${runId}.journal.jsonl`);
    // Resume the sequence from an existing file (append after a restart).
    for (const entry of RunJournal.readEntries(this.filePath)) {
      this.seq = Math.max(this.seq, entry.seq);
      if (entry.key) this.seenKeys.add(entry.key);
      if (entry.kind === 'run_finished') this.finished = true;
    }
  }

  /** Append an entry. Returns false when the idempotency key was already recorded. */
  record(kind: JournalEntryKind, data?: Record<string, unknown>, key?: string): boolean {
    if (key !== undefined) {
      if (this.seenKeys.has(key)) return false;
      this.seenKeys.add(key);
    }
    const entry: JournalEntry = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      runId: this.runId,
      kind,
      ...(key !== undefined ? { key } : {}),
      ...(data !== undefined ? { data: sanitizeValue(data) as Record<string, unknown> } : {}),
    };
    fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    if (kind === 'run_finished') this.finished = true;
    return true;
  }

  recordStepStarted(stepIndex: number, description?: string): boolean {
    return this.record('step_started', { stepIndex, description }, `step:${stepIndex}:started`);
  }

  recordStepCompleted(stepIndex: number): boolean {
    return this.record('step_completed', { stepIndex }, `step:${stepIndex}:completed`);
  }

  recordToolCall(callId: string, toolName: string, args?: unknown): boolean {
    return this.record('tool_call', { toolName, args }, `tool:${callId}:call`);
  }

  recordToolResult(callId: string, toolName: string, result?: unknown): boolean {
    return this.record('tool_result', { toolName, result }, `tool:${callId}:result`);
  }

  recordModelCall(model: string, inputTokens?: number, outputTokens?: number): boolean {
    return this.record('model_call', { model, inputTokens, outputTokens });
  }

  recordRouterDecision(decision: string, reason?: string): boolean {
    return this.record('router_decision', { decision, reason });
  }

  recordError(message: string, stepIndex?: number): boolean {
    return this.record('error', { message, stepIndex });
  }

  /** Write a checkpoint snapshot (messages + finished tools + tokens). */
  checkpoint(data: JournalCheckpointData): boolean {
    return this.record('checkpoint', { checkpoint: data });
  }

  finish(result?: string): boolean {
    return this.record('run_finished', { result });
  }

  get isFinished(): boolean {
    return this.finished;
  }

  get entriesWritten(): number {
    return this.seq;
  }

  /** Read all valid entries of a journal file (bad lines skipped). */
  static readEntries(filePath: string): JournalEntry[] {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return [];
    }
    const entries: JournalEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed === 'object' && parsed !== null && typeof (parsed as JournalEntry).seq === 'number') {
          entries.push(parsed as JournalEntry);
        }
      } catch {
        // Bad line: skip, do not fail the read.
      }
    }
    return entries;
  }

  /** Rebuild state from the journal without executing anything. */
  static replayEntries(filePath: string): {
    entries: JournalEntry[];
    completedKeys: Set<string>;
    lastCheckpoint?: JournalCheckpointData;
    finished: boolean;
  } {
    const entries = RunJournal.readEntries(filePath);
    const completedKeys = new Set<string>();
    let lastCheckpoint: JournalCheckpointData | undefined;
    let finished = false;
    for (const entry of entries) {
      if (entry.key && (entry.kind === 'step_completed' || entry.kind === 'tool_result')) {
        completedKeys.add(entry.key);
      }
      if (entry.kind === 'checkpoint' && entry.data && typeof entry.data.checkpoint === 'object') {
        lastCheckpoint = entry.data.checkpoint as JournalCheckpointData;
      }
      if (entry.kind === 'run_finished') finished = true;
    }
    return { entries, completedKeys, lastCheckpoint, finished };
  }

  /** Diagnose a journal after a crash (monotonic seq, consistent runId, parseable checkpoint). */
  static verifyJournal(filePath: string): JournalVerification {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return { ok: false, entries: 0, badLines: 0, issues: ['journal file is missing'], hasCheckpoint: false, finished: false };
    }
    const issues: string[] = [];
    let entries = 0;
    let badLines = 0;
    let lastSeq = 0;
    let hasCheckpoint = false;
    let finished = false;
    let runId: string | undefined;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
        const entry = parsed as JournalEntry;
        entries++;
        if (runId === undefined) runId = entry.runId;
        else if (entry.runId !== runId) issues.push(`entry seq ${entry.seq} has a different runId`);
        if (typeof entry.seq !== 'number' || entry.seq <= lastSeq) {
          issues.push(`non-monotonic seq at entry ${entries}`);
        }
        lastSeq = Math.max(lastSeq, typeof entry.seq === 'number' ? entry.seq : 0);
        if (entry.kind === 'checkpoint') {
          hasCheckpoint = true;
          if (typeof entry.data?.checkpoint !== 'object') issues.push(`checkpoint at seq ${entry.seq} is not parseable`);
        }
        if (entry.kind === 'run_finished') finished = true;
      } catch {
        badLines++;
      }
    }
    if (badLines > 0) issues.push(`${badLines} corrupt line(s) skipped`);
    return { ok: issues.length === 0, entries, badLines, issues, hasCheckpoint, finished };
  }

  /** Delete journals of FINISHED runs, keeping the N newest. Never deletes unfinished runs. */
  static pruneJournals(journalDir: string, keepNewest = 20): { deleted: string[]; kept: string[] } {
    let files: string[] = [];
    try {
      files = fs.readdirSync(journalDir).filter((f) => f.endsWith('.journal.jsonl'));
    } catch {
      return { deleted: [], kept: [] };
    }
    const finished: Array<{ file: string; mtime: number }> = [];
    const kept: string[] = [];
    for (const file of files) {
      const full = path.join(journalDir, file);
      const verification = RunJournal.verifyJournal(full);
      if (!verification.finished) {
        kept.push(file);
        continue;
      }
      try {
        finished.push({ file, mtime: fs.statSync(full).mtimeMs });
      } catch {
        kept.push(file);
      }
    }
    finished.sort((a, b) => b.mtime - a.mtime);
    const deleted: string[] = [];
    for (const entry of finished.slice(keepNewest)) {
      try {
        fs.unlinkSync(path.join(journalDir, entry.file));
        deleted.push(entry.file);
      } catch {
        kept.push(entry.file);
      }
    }
    kept.push(...finished.slice(0, keepNewest).map((e) => e.file));
    return { deleted, kept };
  }

  /** Portable debug bundle: entries + replay + verification. */
  static exportBundle(filePath: string): {
    runId: string;
    entries: JournalEntry[];
    verification: JournalVerification;
    replay: ReturnType<typeof RunJournal.replayEntries>;
  } {
    const replay = RunJournal.replayEntries(filePath);
    const verification = RunJournal.verifyJournal(filePath);
    return {
      runId: replay.entries[0]?.runId ?? path.basename(filePath),
      entries: replay.entries,
      verification,
      replay,
    };
  }
}
