/**
 * Stuck-state detector (v0.96, Team T6 — UI + planning; v2 signals in
 * v0.98, Team T4 — planning v2).
 *
 * An agent run is "stuck" when it keeps doing the same thing without
 * making progress. This module detects the shapes that show up most
 * in practice, from the tool-call stream alone — no model call, no
 * extra tokens:
 *
 * 1. Repeated tool call — the same tool with the same argument
 *    signature N times in a row inside one step (default N = 3).
 *    The classic loop: `read_file` on the same path, `search` with
 *    the same query, `run_shell` with the same command, each time
 *    returning (nearly) the same result.
 * 2. No progress — M consecutive steps finish failed/skipped without
 *    a single step completing (default M = 3). The plan is moving
 *    but nothing lands.
 * 3. (v2) Stall — a running step makes no tool call for `stallMs`
 *    (default 120s). The run is alive but silent: the model is
 *    thinking in circles, the provider is slow, or the tool hung.
 *    Evaluated whenever a new event arrives or the run ends — the
 *    detector never polls by itself.
 * 4. (v2) Error repeat — the same (normalised) tool error K times
 *    in a row (default K = 3). Different from rule 1: the tool and
 *    its arguments may differ, but every attempt dies with the same
 *    error ("file not found", "permission denied").
 * 5. (v2) Tool cycle — a two-tool alternation A → B → A → B …
 *    (default: 2 full cycles). Shorter than a repeated call, longer
 *    than noise: `search` → `read_file` → `search` → `read_file`
 *    is a loop even though no single call repeats consecutively.
 *
 * The detector is deliberately small and pure: it only sees tool-call
 * signatures and step outcomes, so the coordinator, the UI, or a test
 * can drive it with the same code. When it fires it also suggests
 * what to do next — the caller (coordinator or UI) decides whether to
 * stop the run, ask the user, or skip the step.
 */

export type StuckReason =
  | 'repeated-tool-call'
  | 'no-progress'
  | 'stall'
  | 'error-repeat'
  | 'tool-cycle';

export interface StuckReport {
  reason: StuckReason;
  /** Human-readable detail (already localised by the caller, not here). */
  detail: string;
  /** The tool signature that kept repeating (repeated-tool-call only). */
  signature?: string;
  /** How many times the signature repeated consecutively. */
  repeatCount?: number;
  /** How many steps finished without progress (no-progress only). */
  failedSteps?: number;
  /** ms since the last tool activity (stall only). */
  stalledForMs?: number;
  /** The normalised error that kept repeating (error-repeat only). */
  error?: string;
  /** How many times the error repeated consecutively. */
  errorCount?: number;
  /** The two alternating signatures (tool-cycle only), e.g. "A ⇄ B". */
  cycle?: string;
  /** How many full A→B cycles were seen (tool-cycle only). */
  cycleCount?: number;
  /** What the caller could do next — ordered best-first. */
  suggestions: string[];
}

/** One recorded tool call, reduced to its repeat-detectable shape. */
export interface ToolCallRecord {
  tool: string;
  /** Stable signature of the arguments (see `toolCallSignature`). */
  signature: string;
  at: number;
}

export interface StuckDetectorOptions {
  /** Consecutive identical calls that count as stuck (default 3). */
  repeatThreshold?: number;
  /** Consecutive failed/skipped steps that count as stuck (default 3). */
  noProgressThreshold?: number;
  /** Silence (ms) with no tool call while a step runs (default 120_000). */
  stallMs?: number;
  /** Consecutive identical errors that count as stuck (default 3). */
  errorRepeatThreshold?: number;
  /** Full A→B cycles that count as stuck (default 2). */
  cycleThreshold?: number;
  /** Clock (tests inject a fake one; default Date.now). */
  now?: () => number;
}

/** Default stall threshold: 2 minutes of silence inside a running step. */
export const DEFAULT_STALL_MS = 120_000;

/**
 * Normalise a tool error for repeat detection: lowercase, collapse
 * whitespace, replace digit runs (paths, line numbers, ids change
 * between attempts but the error is the same) and truncate. Two
 * errors that differ only in a number or a path segment still match.
 */
export function normalizeToolError(error: string): string {
  return (error ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\d+/g, '#')
    .trim()
    .slice(0, 120);
}

/**
 * Count full A→B cycles in the trailing alternation of a signature
 * history. Returns the two signatures and the cycle count (0 when
 * the tail is not an alternation). Only the TAIL matters: `X A B A B`
 * reports `A ⇄ B × 2` — history before the alternation started is
 * irrelevant, and a run of identical signatures is a repeated call,
 * not a cycle (handled by rule 1).
 */
export function trailingCycle(
  history: ReadonlyArray<ToolCallRecord>,
): { a: string; b: string; cycles: number } {
  const empty = { a: '', b: '', cycles: 0 };
  if (history.length < 4) return empty;
  const sigs = history.map((r) => r.signature);
  const last = sigs[sigs.length - 1] as string;
  const prev = sigs[sigs.length - 2] as string;
  if (last === prev) return empty;
  // Walk backwards while the tail alternates between `last` and `prev`.
  let run = 2;
  for (let i = sigs.length - 3; i >= 0; i--) {
    const expected = run % 2 === 0 ? last : prev;
    if (sigs[i] !== expected) break;
    run++;
  }
  const cycles = Math.floor(run / 2);
  if (cycles < 1) return empty;
  return { a: prev, b: last, cycles };
}

/**
 * Stable signature for a tool call: `tool(key1=value1,key2=value2)`.
 * Keys are sorted; values are JSON-stringified and truncated so a
 * huge argument cannot blow up the history, and two calls that differ
 * only in argument ORDER still match. `undefined` values are dropped.
 * Non-serialisable values fall back to their `typeof`.
 */
export function toolCallSignature(tool: string, args: Record<string, unknown>): string {
  const name = (tool ?? '').trim() || 'unknown';
  const keys = Object.keys(args ?? {}).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const value = (args as Record<string, unknown>)[key];
    if (value === undefined) continue;
    let rendered: string;
    try {
      rendered = JSON.stringify(value) ?? 'null';
    } catch {
      rendered = typeof value;
    }
    if (rendered.length > 200) rendered = `${rendered.slice(0, 200)}…`;
    parts.push(`${key}=${rendered}`);
  }
  return `${name}(${parts.join(',')})`;
}

/**
 * Count the trailing run of identical signatures in a call history.
 * Returns the signature and its run length (0 when the history is
 * empty). Only the TAIL matters: `A A B B B` reports `B × 3`, not
 * `A × 2` — an agent that moved on to a new tool is not stuck on the
 * old one.
 */
export function trailingRepeatRun(
  history: ReadonlyArray<ToolCallRecord>,
): { signature: string; count: number } {
  if (history.length === 0) return { signature: '', count: 0 };
  const last = history[history.length - 1];
  if (!last) return { signature: '', count: 0 };
  let count = 1;
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i]?.signature !== last.signature) break;
    count++;
  }
  return { signature: last.signature, count };
}

/**
 * The detector itself. One instance per step (repeated-call rule) —
 * the caller keeps one per plan for the no-progress rule (see
 * `recordStepOutcome`). Both rules are also exposed as pure
 * functions below for callers that keep their own history.
 */
export class StuckDetector {
  private readonly repeatThreshold: number;
  private readonly noProgressThreshold: number;
  private readonly stallMs: number;
  private readonly errorRepeatThreshold: number;
  private readonly cycleThreshold: number;
  private readonly nowFn: () => number;
  private readonly calls: ToolCallRecord[] = [];
  /** Consecutive steps that ended failed/skipped (resets on a done). */
  private failedStreak = 0;
  /** Last tool activity (call or result) inside the current step. */
  private lastActivityAt: number | null = null;
  /** Normalised errors of consecutive failed tool results. */
  private readonly errors: string[] = [];

  constructor(options: StuckDetectorOptions = {}) {
    this.repeatThreshold = Math.max(2, Math.floor(options.repeatThreshold ?? 3));
    this.noProgressThreshold = Math.max(2, Math.floor(options.noProgressThreshold ?? 3));
    this.stallMs = Math.max(1_000, Math.floor(options.stallMs ?? DEFAULT_STALL_MS));
    this.errorRepeatThreshold = Math.max(2, Math.floor(options.errorRepeatThreshold ?? 3));
    this.cycleThreshold = Math.max(1, Math.floor(options.cycleThreshold ?? 2));
    this.nowFn = options.now ?? Date.now;
  }

  /** Record one tool call inside the current step. */
  recordToolCall(tool: string, args: Record<string, unknown>): ToolCallRecord {
    const record: ToolCallRecord = {
      tool,
      signature: toolCallSignature(tool, args),
      at: this.nowFn(),
    };
    this.calls.push(record);
    this.lastActivityAt = record.at;
    return record;
  }

  /**
   * Record a tool result. A failed result extends the error streak
   * with its normalised error; a success clears it (the tool worked
   * — whatever errored before is not the loop any more). Also
   * refreshes last-activity, so a slow-but-working tool never looks
   * stalled. `error` is the tool's error text (`result.output` when
   * `ok` is false is a good source); empty when unknown.
   */
  recordToolResult(tool: string, ok: boolean, error = ''): void {
    this.lastActivityAt = this.nowFn();
    if (ok) {
      this.errors.length = 0;
      return;
    }
    const normalised = normalizeToolError(error || tool);
    const last = this.errors[this.errors.length - 1];
    if (last !== undefined && last !== normalised) this.errors.length = 0;
    this.errors.push(normalised);
  }

  /**
   * Record observable run activity that is not a tool call (e.g. a
   * progress message): the run is alive, so the stall clock resets
   * even though no tool ran. Never marks a step stuck by itself.
   */
  recordActivity(): void {
    this.lastActivityAt = this.nowFn();
  }

  /** ms since the last tool activity in this step (null = no activity yet). */
  get idleMs(): number | null {
    if (this.lastActivityAt === null) return null;
    return Math.max(0, this.nowFn() - this.lastActivityAt);
  }

  /** How many tool calls this step has made so far. */
  get callCount(): number {
    return this.calls.length;
  }

  /** Forget the current step's call history (a new step starts). */
  resetStep(): void {
    this.calls.length = 0;
    this.errors.length = 0;
    this.lastActivityAt = null;
  }

  /**
   * Record how a step ended. A `done` step breaks the no-progress
   * streak; `failed` / `skipped` extend it. Returns a no-progress
   * report when the streak reaches the threshold, else null.
   */
  recordStepOutcome(outcome: 'done' | 'failed' | 'skipped'): StuckReport | null {
    if (outcome === 'done') {
      this.failedStreak = 0;
      return null;
    }
    this.failedStreak++;
    return checkNoProgress(this.failedStreak, this.noProgressThreshold);
  }

  /**
   * Check all rules right now. Order is deliberate — the most
   * specific diagnosis wins: repeated call names the exact loop,
   * then the cycle, then the error, then the stall, then the
   * plan-level no-progress streak. `now` defaults to the injected
   * clock (Date.now in production).
   */
  check(now?: number): StuckReport | null {
    const at = now ?? this.nowFn();
    const repeated = checkRepeatedCalls(this.calls, this.repeatThreshold);
    if (repeated) return repeated;
    const cycle = checkToolCycle(this.calls, this.cycleThreshold);
    if (cycle) return cycle;
    const errorRepeat = checkErrorRepeat(this.errors, this.errorRepeatThreshold);
    if (errorRepeat) return errorRepeat;
    if (this.lastActivityAt !== null) {
      const stall = checkStall(this.lastActivityAt, at, this.stallMs);
      if (stall) return stall;
    }
    return checkNoProgress(this.failedStreak, this.noProgressThreshold);
  }
}

/** Pure repeated-call rule over an explicit history. */
export function checkRepeatedCalls(
  history: ReadonlyArray<ToolCallRecord>,
  repeatThreshold = 3,
): StuckReport | null {
  const threshold = Math.max(2, Math.floor(repeatThreshold));
  const { signature, count } = trailingRepeatRun(history);
  if (count < threshold) return null;
  return {
    reason: 'repeated-tool-call',
    detail: `Same tool call ${count} times in a row: ${signature}`,
    signature,
    repeatCount: count,
    suggestions: [
      'try-different-tool',
      'ask-user',
      'skip-step',
    ],
  };
}

/** Pure no-progress rule over an explicit failed-step streak. */
export function checkNoProgress(
  failedStreak: number,
  noProgressThreshold = 3,
): StuckReport | null {
  const threshold = Math.max(2, Math.floor(noProgressThreshold));
  if (failedStreak < threshold) return null;
  return {
    reason: 'no-progress',
    detail: `${failedStreak} steps in a row finished without progress`,
    failedSteps: failedStreak,
    suggestions: [
      'ask-user',
      'replan',
      'skip-step',
    ],
  };
}

/** Pure stall rule: silence longer than `stallMs` since last activity. */
export function checkStall(
  lastActivityAt: number,
  now: number,
  stallMs: number = DEFAULT_STALL_MS,
): StuckReport | null {
  const idle = now - lastActivityAt;
  if (idle < Math.max(1_000, stallMs)) return null;
  return {
    reason: 'stall',
    detail: `No tool activity for ${Math.round(idle / 1000)}s while the step is running`,
    stalledForMs: idle,
    suggestions: ['ask-user', 'skip-step', 'replan'],
  };
}

/** Pure error-repeat rule over normalised consecutive errors. */
export function checkErrorRepeat(
  errors: ReadonlyArray<string>,
  errorRepeatThreshold = 3,
): StuckReport | null {
  const threshold = Math.max(2, Math.floor(errorRepeatThreshold));
  if (errors.length < threshold) return null;
  const last = errors[errors.length - 1] as string;
  let count = 1;
  for (let i = errors.length - 2; i >= 0; i--) {
    if (errors[i] !== last) break;
    count++;
  }
  if (count < threshold) return null;
  return {
    reason: 'error-repeat',
    detail: `Same tool error ${count} times in a row: ${last}`,
    error: last,
    errorCount: count,
    suggestions: ['try-different-tool', 'ask-user', 'replan'],
  };
}

/** Pure tool-cycle rule over an explicit call history. */
export function checkToolCycle(
  history: ReadonlyArray<ToolCallRecord>,
  cycleThreshold = 2,
): StuckReport | null {
  const threshold = Math.max(1, Math.floor(cycleThreshold));
  const { a, b, cycles } = trailingCycle(history);
  if (cycles < threshold) return null;
  return {
    reason: 'tool-cycle',
    detail: `Tools alternate ${cycles} full cycles without progress: ${a} ⇄ ${b}`,
    cycle: `${a} ⇄ ${b}`,
    cycleCount: cycles,
    suggestions: ['try-different-tool', 'replan', 'skip-step'],
  };
}
