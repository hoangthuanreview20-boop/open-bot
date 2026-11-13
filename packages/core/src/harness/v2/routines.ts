/**
 * Harness v2 — routines v2 (v0.97, Team T5).
 *
 * A routine is `schedule/trigger + action` with an explicit queue and
 * retry with exponential backoff. Compared with v1 automations:
 *
 * - Queue: triggers (schedule tick, signed webhook, named event,
 *   manual run) enqueue a run instead of executing inline. A bounded
 *   FIFO queue (default 10 waiting runs per routine) absorbs bursts;
 *   extra triggers are dropped and counted, never piled up.
 * - One at a time: a routine never runs twice concurrently. While a
 *   run is in flight, further triggers queue behind it.
 * - Retry: a failed run retries with exponential backoff
 *   (`retryBackoffMs * 2^attempt`, capped at 5 minutes) until
 *   `maxAttempts` is exhausted; each attempt is a new run record
 *   linked by `retriedFromRunId` so the history stays readable.
 * - Missed runs: a scheduled run whose time passed while the app was
 *   off is recorded as `skipped` (never a catch-up burst) and the
 *   routine is rescheduled from now — same policy as v1 automations.
 * - Per-run status: every run is `queued → running → ok | error |
 *   skipped`, with `retrying` while a retry is scheduled. The UI
 *   reads the same records the scheduler writes.
 *
 * Persistence: one JSON file `<stateDir>/routines-v2.json`
 * (`{ routines: [...], runs: [...] }`), atomic-ish write (temp file +
 * rename). A corrupt file loads as empty and is kept as `.corrupt`
 * for inspection. Run history is capped (newest 200).
 *
 * The manager never runs a provider itself: the host supplies an
 * executor (`RoutineExecutor`) that performs the action — normally
 * the coordinator's agent/tool path, so approval and sandbox rules
 * still apply. The executor is also where the mock/CLI exemption
 * lives: a host that routes through the provider router must skip
 * routing for provider 'mock' and CLI-kind bots (v0.96 lesson).
 * Health probes never run on the turn path (v0.95 lesson): the
 * manager's `tick()` is timer-driven and async, and a slow executor
 * only delays later queued runs, never a chat turn.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { isValidCronExpression, nextCronOccurrence } from '../../automations/engine';
import type { Routine, RoutineQueueStatus, RoutineRun, RoutineTrigger } from './types';
import { ROUTINES_FILE } from './types';

/** Cap on stored routine run records (history shows the newest 200). */
export const MAX_ROUTINE_RUN_HISTORY = 200;
/** Default max attempts per run (including the first). */
export const DEFAULT_ROUTINE_MAX_ATTEMPTS = 3;
/** Default base backoff between attempts (ms). */
export const DEFAULT_ROUTINE_RETRY_BACKOFF_MS = 5_000;
/** Cap on a single backoff delay (ms). */
export const MAX_ROUTINE_BACKOFF_MS = 5 * 60_000;
/** Default max queued (not yet started) runs per routine. */
export const DEFAULT_ROUTINE_MAX_QUEUED = 10;
/** Grace window for a missed scheduled run (60 minutes, like v1 cron). */
export const ROUTINE_MISSED_GRACE_MS = 60 * 60_000;
/** Max output chars kept on a run record. */
const MAX_RUN_OUTPUT_CHARS = 4_000;

/** Host-supplied executor: performs one routine action, resolves to its output text. */
export type RoutineExecutor = (routine: Routine, input: unknown) => Promise<string>;

/** Minimal store interface so tests can substitute an in-memory store. */
export interface RoutineStore {
  list(): Routine[];
  save(routine: Routine): void;
  remove(id: string): boolean;
  listRuns(routineId?: string): RoutineRun[];
  appendRun(run: RoutineRun): void;
  updateRun(run: RoutineRun): void;
}

/** JSON-file store (see header). */
export class JsonFileRoutineStore implements RoutineStore {
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, ROUTINES_FILE);
  }

  private read(): { routines: Routine[]; runs: RoutineRun[] } {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return { routines: [], runs: [] };
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      const doc = parsed as { routines?: unknown; runs?: unknown };
      return {
        routines: Array.isArray(doc.routines) ? (doc.routines as Routine[]) : [],
        runs: Array.isArray(doc.runs) ? (doc.runs as RoutineRun[]) : [],
      };
    } catch {
      try {
        fs.writeFileSync(`${this.file}.corrupt`, raw, 'utf8');
      } catch {
        // Best effort only.
      }
      return { routines: [], runs: [] };
    }
  }

  private write(doc: { routines: Routine[]; runs: RoutineRun[] }): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  list(): Routine[] {
    return this.read().routines;
  }

  save(routine: Routine): void {
    const doc = this.read();
    const i = doc.routines.findIndex((r) => r.id === routine.id);
    if (i >= 0) doc.routines[i] = routine;
    else doc.routines.push(routine);
    this.write(doc);
  }

  remove(id: string): boolean {
    const doc = this.read();
    const before = doc.routines.length;
    doc.routines = doc.routines.filter((r) => r.id !== id);
    if (doc.routines.length === before) return false;
    this.write(doc);
    return true;
  }

  listRuns(routineId?: string): RoutineRun[] {
    const runs = this.read().runs;
    return routineId === undefined ? runs : runs.filter((r) => r.routineId === routineId);
  }

  appendRun(run: RoutineRun): void {
    const doc = this.read();
    doc.runs.push(run);
    if (doc.runs.length > MAX_ROUTINE_RUN_HISTORY) {
      doc.runs = doc.runs.slice(doc.runs.length - MAX_ROUTINE_RUN_HISTORY);
    }
    this.write(doc);
  }

  updateRun(run: RoutineRun): void {
    const doc = this.read();
    const i = doc.runs.findIndex((r) => r.id === run.id);
    if (i >= 0) {
      doc.runs[i] = run;
    } else {
      doc.runs.push(run);
      if (doc.runs.length > MAX_ROUTINE_RUN_HISTORY) {
        doc.runs = doc.runs.slice(doc.runs.length - MAX_ROUTINE_RUN_HISTORY);
      }
    }
    this.write(doc);
  }
}

/** In-memory store for tests and for hosts that persist elsewhere. */
export class MemoryRoutineStore implements RoutineStore {
  private routines: Routine[] = [];
  private runs: RoutineRun[] = [];

  list(): Routine[] {
    return [...this.routines];
  }

  save(routine: Routine): void {
    const i = this.routines.findIndex((r) => r.id === routine.id);
    if (i >= 0) this.routines[i] = routine;
    else this.routines.push(routine);
  }

  remove(id: string): boolean {
    const before = this.routines.length;
    this.routines = this.routines.filter((r) => r.id !== id);
    return this.routines.length !== before;
  }

  listRuns(routineId?: string): RoutineRun[] {
    return routineId === undefined
      ? [...this.runs]
      : this.runs.filter((r) => r.routineId === routineId);
  }

  appendRun(run: RoutineRun): void {
    this.runs.push(run);
    if (this.runs.length > MAX_ROUTINE_RUN_HISTORY) {
      this.runs = this.runs.slice(this.runs.length - MAX_ROUTINE_RUN_HISTORY);
    }
  }

  updateRun(run: RoutineRun): void {
    const i = this.runs.findIndex((r) => r.id === run.id);
    if (i >= 0) this.runs[i] = run;
    else this.appendRun(run);
  }
}

/** Validate a routine definition. Returns a list of problems (empty = valid). */
export function validateRoutine(routine: Routine): string[] {
  const errors: string[] = [];
  if (routine.id.trim() === '') errors.push('Routine id must not be empty.');
  if (routine.name.trim() === '') errors.push('Routine name must not be empty.');
  const trigger = routine.trigger;
  if (trigger.kind === 'interval') {
    if (!Number.isInteger(trigger.minutes) || trigger.minutes < 1) {
      errors.push('Interval trigger needs minutes >= 1.');
    }
  }
  if (trigger.kind === 'cron' && !isValidCronExpression(trigger.expression)) {
    errors.push(`Invalid cron expression: ${JSON.stringify(trigger.expression)}.`);
  }
  if (trigger.kind === 'webhook' && trigger.keyId.trim() === '') {
    errors.push('Webhook trigger needs a keyId.');
  }
  if (trigger.kind === 'event' && trigger.event.trim() === '') {
    errors.push('Event trigger needs an event name.');
  }
  const action = routine.action;
  if (action.kind === 'run-agent') {
    if (action.botId.trim() === '') errors.push('run-agent action needs a botId.');
    if (action.prompt.trim() === '') errors.push('run-agent action needs a prompt.');
  }
  if (action.kind === 'run-tool' && action.tool.trim() === '') {
    errors.push('run-tool action needs a tool name.');
  }
  if (action.kind === 'notify' && action.message.trim() === '') {
    errors.push('notify action needs a message.');
  }
  if (
    routine.maxAttempts !== undefined &&
    (!Number.isInteger(routine.maxAttempts) || routine.maxAttempts < 1 || routine.maxAttempts > 10)
  ) {
    errors.push('maxAttempts must be an integer between 1 and 10.');
  }
  if (
    routine.retryBackoffMs !== undefined &&
    (!Number.isInteger(routine.retryBackoffMs) || routine.retryBackoffMs < 0)
  ) {
    errors.push('retryBackoffMs must be a non-negative integer.');
  }
  if (
    routine.maxQueuedRuns !== undefined &&
    (!Number.isInteger(routine.maxQueuedRuns) || routine.maxQueuedRuns < 1)
  ) {
    errors.push('maxQueuedRuns must be an integer >= 1.');
  }
  return errors;
}

/** Next scheduled run for a routine, or null for non-scheduled triggers. */
export function nextRoutineRunAt(routine: Routine, from: Date): Date | null {
  const trigger: RoutineTrigger = routine.trigger;
  if (trigger.kind === 'interval') {
    if (!routine.lastRunAt) return new Date(from.getTime());
    const next = new Date(new Date(routine.lastRunAt).getTime() + trigger.minutes * 60_000);
    return next.getTime() <= from.getTime() ? new Date(from.getTime()) : next;
  }
  if (trigger.kind === 'cron') {
    const fromPoint = routine.lastRunAt
      ? new Date(Math.max(new Date(routine.lastRunAt).getTime(), from.getTime() - 1000))
      : from;
    return nextCronOccurrence(trigger.expression, fromPoint);
  }
  return null;
}

/** Is a scheduled routine due at `now`? Manual/webhook/event triggers are never due. */
export function routineDue(routine: Routine, now: Date): boolean {
  if (!routine.enabled) return false;
  if (routine.trigger.kind !== 'interval' && routine.trigger.kind !== 'cron') return false;
  if (routine.nextRunAt) return now.getTime() >= new Date(routine.nextRunAt).getTime();
  if (!routine.lastRunAt) return true;
  const next = nextRoutineRunAt(routine, now);
  return next !== null && now.getTime() >= next.getTime();
}

/** Backoff delay before attempt `attempt` (1-based, next attempt). Deterministic, no jitter. */
export function routineBackoffMs(baseMs: number, attempt: number): number {
  const delay = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(delay, MAX_ROUTINE_BACKOFF_MS);
}

function truncateOutput(text: string): string {
  return text.length > MAX_RUN_OUTPUT_CHARS
    ? `${text.slice(0, MAX_RUN_OUTPUT_CHARS)}…[truncated]`
    : text;
}

function sanitizeTriggerInput(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  try {
    const text = typeof input === 'string' ? input : JSON.stringify(input);
    return truncateOutput(text);
  } catch {
    return '[unserializable trigger input]';
  }
}

export interface RoutineManagerOptions {
  /** How often `tick()` runs automatically once started. Default 60_000 ms. */
  tickMs?: number;
  /** True while the user has a chat running — the manager will not fire scheduled runs then. */
  isChatActive?: () => boolean;
  /** Clock override (tests). Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Called after every run record is written (queued / started / finished). Must never throw. */
  onRunChanged?: (run: RoutineRun) => void;
  /** Called when a trigger is dropped because the queue is full. */
  onTriggerDropped?: (routineId: string, source: string) => void;
  /** Called when a scheduled run is skipped as missed. */
  onRunSkipped?: (run: RoutineRun) => void;
}

/**
 * Owns routines, their queues and their run history. The queue is
 * processed sequentially per routine (one worker per routine, started
 * lazily); `tick()` only enqueues due scheduled runs and retries due
 * `retrying` runs — it never executes an action inline.
 */
export class RoutineManager {
  private readonly store: RoutineStore;
  private readonly executor: RoutineExecutor;
  private readonly opts: RoutineManagerOptions;
  /** Waiting runs per routine id (FIFO, oldest first). */
  private readonly queues = new Map<string, Array<{ run: RoutineRun; input?: unknown }>>();
  /** Routine ids with a worker currently running. */
  private readonly working = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Triggers dropped because the queue was full, per routine id. */
  private readonly droppedCounts = new Map<string, number>();

  constructor(store: RoutineStore, executor: RoutineExecutor, opts: RoutineManagerOptions = {}) {
    this.store = store;
    this.executor = executor;
    this.opts = opts;
  }

  // --- CRUD ---------------------------------------------------------------

  list(): Routine[] {
    return this.store.list();
  }

  get(id: string): Routine | undefined {
    return this.store.list().find((r) => r.id === id);
  }

  create(input: Omit<Routine, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Routine {
    const now = this.now();
    const routine: Routine = {
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const errors = validateRoutine(routine);
    if (errors.length > 0) throw new Error(`Invalid routine: ${errors.join(' ')}`);
    try {
      routine.nextRunAt = nextRoutineRunAt(routine, now)?.toISOString() ?? null;
    } catch {
      routine.nextRunAt = null;
    }
    this.store.save(routine);
    return routine;
  }

  update(routine: Routine): Routine {
    if (!this.get(routine.id)) throw new Error(`No routine with id ${routine.id}.`);
    const errors = validateRoutine(routine);
    if (errors.length > 0) throw new Error(`Invalid routine: ${errors.join(' ')}`);
    const next: Routine = { ...routine, updatedAt: this.now().toISOString() };
    try {
      next.nextRunAt = nextRoutineRunAt(next, this.now())?.toISOString() ?? null;
    } catch {
      next.nextRunAt = null;
    }
    this.store.save(next);
    return next;
  }

  remove(id: string): boolean {
    this.queues.delete(id);
    return this.store.remove(id);
  }

  setEnabled(id: string, enabled: boolean): Routine {
    const routine = this.get(id);
    if (!routine) throw new Error(`No routine with id ${id}.`);
    if (enabled) {
      const errors = validateRoutine(routine);
      if (errors.length > 0) {
        throw new Error(`Cannot enable routine "${routine.name}": ${errors.join(' ')}`);
      }
    }
    const next: Routine = { ...routine, enabled, updatedAt: this.now().toISOString() };
    try {
      next.nextRunAt = nextRoutineRunAt(next, this.now())?.toISOString() ?? null;
    } catch {
      next.nextRunAt = null;
    }
    this.store.save(next);
    return next;
  }

  listRuns(routineId?: string): RoutineRun[] {
    return this.store.listRuns(routineId);
  }

  /** Queue status for one routine (UI + CLI). */
  queueStatus(routineId: string): RoutineQueueStatus {
    const queued = this.queues.get(routineId) ?? [];
    return {
      routineId,
      queued: queued.length,
      running: this.working.has(routineId),
      queuedRunIds: queued.map((item) => item.run.id),
    };
  }

  /** Queue status for every routine that has a queue or a worker. */
  allQueueStatuses(): RoutineQueueStatus[] {
    const ids = new Set([...this.queues.keys(), ...this.working]);
    return [...ids].map((id) => this.queueStatus(id));
  }

  /** Triggers dropped because the queue was full, per routine id. */
  droppedTriggerCounts(): Record<string, number> {
    return Object.fromEntries(this.droppedCounts);
  }

  // --- Enqueueing ---------------------------------------------------------

  /**
   * Enqueue a run for a routine. Returns the run record, or null when
   * the routine is disabled / missing / its queue is full (the drop
   * is counted and reported via `onTriggerDropped`).
   */
  enqueue(
    routineId: string,
    source: RoutineRun['source'],
    input?: unknown,
  ): RoutineRun | null {
    const routine = this.get(routineId);
    if (!routine) return null;
    if (!routine.enabled) return null;
    const maxQueued = routine.maxQueuedRuns ?? DEFAULT_ROUTINE_MAX_QUEUED;
    const queue = this.queues.get(routineId) ?? [];
    if (queue.length >= maxQueued) {
      this.droppedCounts.set(routineId, (this.droppedCounts.get(routineId) ?? 0) + 1);
      try {
        this.opts.onTriggerDropped?.(routineId, source);
      } catch {
        // Callback must never break enqueueing.
      }
      return null;
    }
    const now = this.now();
    const run: RoutineRun = {
      id: randomUUID(),
      routineId,
      source,
      status: 'queued',
      attempt: 1,
      maxAttempts: routine.maxAttempts ?? DEFAULT_ROUTINE_MAX_ATTEMPTS,
      queuedAt: now.toISOString(),
      ...(sanitizeTriggerInput(input) !== undefined
        ? { triggerInput: sanitizeTriggerInput(input) }
        : {}),
    };
    this.store.appendRun(run);
    this.emitRunChanged(run);
    queue.push({ run, input });
    this.queues.set(routineId, queue);
    void this.pump(routineId);
    return run;
  }

  /** Run one routine right now (manual trigger). Throws when missing/disabled. */
  runNow(id: string, input?: unknown): RoutineRun {
    const routine = this.get(id);
    if (!routine) throw new Error(`No routine with id ${id}.`);
    if (!routine.enabled) throw new Error(`Routine "${routine.name}" is disabled.`);
    const run = this.enqueue(id, 'manual', input);
    if (!run) throw new Error(`Routine "${routine.name}" queue is full — try again shortly.`);
    return run;
  }

  /**
   * Deliver a verified webhook payload to a webhook-trigger routine.
   * Auth must already have happened (the receiver verifies before
   * calling this); this only enqueues. Returns null when the routine
   * does not listen for webhooks.
   */
  deliverWebhook(routineId: string, payload: unknown): RoutineRun | null {
    const routine = this.get(routineId);
    if (!routine) return null;
    if (routine.trigger.kind !== 'webhook') return null;
    return this.enqueue(routineId, 'webhook', payload);
  }

  /** Deliver a named event to every enabled event-trigger routine listening for it. */
  notifyEvent(eventName: string, input?: unknown): RoutineRun[] {
    const runs: RoutineRun[] = [];
    for (const routine of this.store.list()) {
      if (!routine.enabled) continue;
      if (routine.trigger.kind !== 'event') continue;
      if (routine.trigger.event !== eventName) continue;
      const run = this.enqueue(routine.id, 'event', input);
      if (run) runs.push(run);
    }
    return runs;
  }

  /**
   * Retry a failed run with the same trigger input. Creates a new run
   * linked by `retriedFromRunId`; the old run keeps its `error`
   * status. Throws when the run does not exist or did not fail.
   */
  retryRun(runId: string): RoutineRun {
    const run = this.store.listRuns().find((r) => r.id === runId);
    if (!run) throw new Error(`No routine run with id ${runId}.`);
    if (run.status !== 'error') {
      throw new Error(`Run ${runId} did not fail (status: ${run.status}) — only failed runs can be retried.`);
    }
    const routine = this.get(run.routineId);
    if (!routine) throw new Error(`Routine ${run.routineId} no longer exists.`);
    if (!routine.enabled) throw new Error(`Routine "${routine.name}" is disabled.`);
    let input: unknown;
    if (run.triggerInput !== undefined) {
      try {
        input = JSON.parse(run.triggerInput) as unknown;
      } catch {
        input = run.triggerInput;
      }
    }
    const next = this.enqueue(run.routineId, 'manual', input);
    if (!next) throw new Error(`Routine "${routine.name}" queue is full — try again shortly.`);
    next.retriedFromRunId = run.id;
    this.store.updateRun(next);
    return next;
  }

  /** Latest failed run of a routine not yet resolved by a successful retry. */
  lastFailedRun(routineId: string): RoutineRun | undefined {
    const runs = this.store.listRuns(routineId);
    const resolved = new Set(
      runs.filter((r) => r.status === 'ok' && r.retriedFromRunId).map((r) => r.retriedFromRunId as string),
    );
    const failed = runs.filter((r) => r.status === 'error' && !resolved.has(r.id));
    if (failed.length === 0) return undefined;
    return failed[failed.length - 1];
  }

  // --- Scheduling ---------------------------------------------------------

  /** Start the periodic timer. Safe to call twice. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, this.opts.tickMs ?? 60_000);
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as { unref(): void }).unref();
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * One scheduler pass: enqueue due scheduled routines (or record a
   * `skipped` run when too late) and re-enqueue retries whose backoff
   * has elapsed. No-op while a chat is active. Never executes an
   * action inline — execution happens in the per-routine workers.
   */
  async tick(): Promise<RoutineRun[]> {
    if (this.opts.isChatActive?.()) return [];
    const now = this.now();
    const produced: RoutineRun[] = [];
    for (const routine of this.store.list()) {
      let due: boolean;
      try {
        due = routineDue(routine, now);
      } catch {
        continue;
      }
      if (!due) continue;
      const nextAt = routine.nextRunAt ? new Date(routine.nextRunAt).getTime() : now.getTime();
      if (now.getTime() - nextAt > ROUTINE_MISSED_GRACE_MS) {
        produced.push(this.recordSkipped(routine, now, nextAt));
        continue;
      }
      const run = this.enqueue(routine.id, 'schedule');
      if (run) produced.push(run);
      // Reschedule from now so the next tick computes the following slot.
      this.reschedule(routine, now);
    }
    // Retries whose backoff elapsed go back on the queue. A run that
    // already produced a retry (another run points at it via
    // retriedFromRunId) is skipped, so one failed attempt spawns
    // exactly one retry.
    const alreadyRetried = new Set(
      this.store
        .listRuns()
        .filter((r) => r.retriedFromRunId !== undefined)
        .map((r) => r.retriedFromRunId as string),
    );
    for (const run of this.store.listRuns()) {
      if (run.status !== 'retrying') continue;
      if (alreadyRetried.has(run.id)) continue;
      if (!run.nextRetryAt || new Date(run.nextRetryAt).getTime() > now.getTime()) continue;
      const routine = this.get(run.routineId);
      if (!routine || !routine.enabled) continue;
      const queue = this.queues.get(run.routineId) ?? [];
      if (queue.some((item) => item.run.id === run.id)) continue;
      const retry: RoutineRun = {
        ...run,
        id: randomUUID(),
        status: 'queued',
        attempt: run.attempt + 1,
        source: 'retry',
        queuedAt: now.toISOString(),
        startedAt: undefined,
        finishedAt: undefined,
        nextRetryAt: undefined,
        retriedFromRunId: run.id,
      };
      this.store.appendRun(retry);
      this.emitRunChanged(retry);
      queue.push({ run: retry, input: this.parseTriggerInput(run) });
      this.queues.set(run.routineId, queue);
      produced.push(retry);
      void this.pump(run.routineId);
    }
    return produced;
  }

  /**
   * Reconcile runs left `running` / `queued` by an interrupted app
   * (crash while a run was in flight). They are marked `error` with a
   * clear note so history never shows a run as running forever.
   * Idempotent; only fixes runs already in the store at call time.
   */
  reconcileInterruptedRuns(now: Date = this.now()): RoutineRun[] {
    const interrupted = this.store
      .listRuns()
      .filter((r) => r.status === 'running' || r.status === 'queued' || r.status === 'retrying');
    const fixed: RoutineRun[] = [];
    for (const run of interrupted) {
      const next: RoutineRun = {
        ...run,
        status: 'error',
        finishedAt: now.toISOString(),
        error: 'Interrupted — the app stopped while this run was still in flight.',
      };
      this.store.updateRun(next);
      fixed.push(next);
    }
    this.queues.clear();
    this.working.clear();
    return fixed;
  }

  // --- Internals ----------------------------------------------------------

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private emitRunChanged(run: RoutineRun): void {
    const cb = this.opts.onRunChanged;
    if (!cb) return;
    try {
      cb(run);
    } catch (err) {
      console.error('[open-bot] routine onRunChanged failed:', err instanceof Error ? err.message : err);
    }
  }

  private parseTriggerInput(run: RoutineRun): unknown {
    if (run.triggerInput === undefined) return undefined;
    try {
      return JSON.parse(run.triggerInput) as unknown;
    } catch {
      return run.triggerInput;
    }
  }

  private reschedule(routine: Routine, now: Date): void {
    let next: Date | null = null;
    try {
      next = nextRoutineRunAt({ ...routine, lastRunAt: now.toISOString() }, now);
    } catch {
      next = null;
    }
    this.store.save({
      ...routine,
      lastRunAt: now.toISOString(),
      nextRunAt: next?.toISOString() ?? null,
      updatedAt: now.toISOString(),
    });
  }

  private recordSkipped(routine: Routine, now: Date, missedAtMs: number): RoutineRun {
    const run: RoutineRun = {
      id: randomUUID(),
      routineId: routine.id,
      source: 'schedule',
      status: 'skipped',
      attempt: 1,
      maxAttempts: routine.maxAttempts ?? DEFAULT_ROUTINE_MAX_ATTEMPTS,
      queuedAt: now.toISOString(),
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      output:
        `Skipped: scheduled run for ${new Date(missedAtMs).toISOString()} was missed by more than ` +
        `the grace window (${Math.round(ROUTINE_MISSED_GRACE_MS / 60_000)} min) — app was off or busy. ` +
        `Rescheduled from now; no catch-up run.`,
    };
    this.store.appendRun(run);
    this.emitRunChanged(run);
    this.reschedule(routine, now);
    try {
      this.opts.onRunSkipped?.(run);
    } catch {
      // Callback must never break the tick.
    }
    return run;
  }

  /**
   * Per-routine worker: takes the next queued run, executes it, and
   * keeps going until the queue is empty. Sequential per routine,
   * concurrent across routines. A slow or throwing executor only
   * delays this routine's later runs.
   */
  private async pump(routineId: string): Promise<void> {
    if (this.working.has(routineId)) return;
    this.working.add(routineId);
    try {
      for (;;) {
        const queue = this.queues.get(routineId) ?? [];
        const item = queue.shift();
        if (!item) break;
        await this.executeOne(routineId, item.run, item.input);
      }
    } finally {
      this.working.delete(routineId);
      if ((this.queues.get(routineId) ?? []).length > 0) {
        void this.pump(routineId);
      }
    }
  }

  private async executeOne(routineId: string, run: RoutineRun, input: unknown): Promise<void> {
    const routine = this.get(routineId);
    if (!routine) {
      const dead: RoutineRun = {
        ...run,
        status: 'error',
        finishedAt: this.now().toISOString(),
        error: `Routine ${routineId} no longer exists.`,
      };
      this.store.updateRun(dead);
      this.emitRunChanged(dead);
      return;
    }
    const started: RoutineRun = {
      ...run,
      status: 'running',
      startedAt: this.now().toISOString(),
    };
    this.store.updateRun(started);
    this.emitRunChanged(started);
    try {
      const output = await this.executor(routine, input);
      const finished: RoutineRun = {
        ...started,
        status: 'ok',
        finishedAt: this.now().toISOString(),
        output: truncateOutput(output),
      };
      this.store.updateRun(finished);
      this.emitRunChanged(finished);
      this.reschedule(routine, this.now());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (started.attempt < started.maxAttempts) {
        const delay = routineBackoffMs(
          routine.retryBackoffMs ?? DEFAULT_ROUTINE_RETRY_BACKOFF_MS,
          started.attempt,
        );
        const retrying: RoutineRun = {
          ...started,
          status: 'retrying',
          finishedAt: this.now().toISOString(),
          error: truncateOutput(message),
          nextRetryAt: new Date(this.now().getTime() + delay).toISOString(),
        };
        this.store.updateRun(retrying);
        this.emitRunChanged(retrying);
      } else {
        const failed: RoutineRun = {
          ...started,
          status: 'error',
          finishedAt: this.now().toISOString(),
          error: truncateOutput(message),
        };
        this.store.updateRun(failed);
        this.emitRunChanged(failed);
        this.reschedule(routine, this.now());
      }
    }
  }
}
