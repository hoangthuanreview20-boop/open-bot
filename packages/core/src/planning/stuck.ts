/**
 * Stuck-state detector (v0.96, Team T6 — UI + planning).
 *
 * An agent run is "stuck" when it keeps doing the same thing without
 * making progress. This module detects the two shapes that show up
 * most in practice, from the tool-call stream alone — no model call,
 * no extra tokens:
 *
 * 1. Repeated tool call — the same tool with the same argument
 *    signature N times in a row inside one step (default N = 3).
 *    The classic loop: `read_file` on the same path, `search` with
 *    the same query, `run_shell` with the same command, each time
 *    returning (nearly) the same result.
 * 2. No progress — M consecutive steps finish failed/skipped without
 *    a single step completing (default M = 3). The plan is moving
 *    but nothing lands.
 *
 * The detector is deliberately small and pure: it only sees tool-call
 * signatures and step outcomes, so the coordinator, the UI, or a test
 * can drive it with the same code. When it fires it also suggests
 * what to do next — the caller (coordinator or UI) decides whether to
 * stop the run, ask the user, or skip the step.
 */

export type StuckReason = 'repeated-tool-call' | 'no-progress';

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
  private readonly calls: ToolCallRecord[] = [];
  /** Consecutive steps that ended failed/skipped (resets on a done). */
  private failedStreak = 0;

  constructor(options: StuckDetectorOptions = {}) {
    this.repeatThreshold = Math.max(2, Math.floor(options.repeatThreshold ?? 3));
    this.noProgressThreshold = Math.max(2, Math.floor(options.noProgressThreshold ?? 3));
  }

  /** Record one tool call inside the current step. */
  recordToolCall(tool: string, args: Record<string, unknown>): ToolCallRecord {
    const record: ToolCallRecord = {
      tool,
      signature: toolCallSignature(tool, args),
      at: Date.now(),
    };
    this.calls.push(record);
    return record;
  }

  /** How many tool calls this step has made so far. */
  get callCount(): number {
    return this.calls.length;
  }

  /** Forget the current step's call history (a new step starts). */
  resetStep(): void {
    this.calls.length = 0;
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
   * Check both rules right now. The repeated-call rule looks at the
   * current step's history; the no-progress rule at the outcome
   * streak. Returns the first firing report (repeated-call wins —
   * it names the exact loop), else null.
   */
  check(): StuckReport | null {
    const repeated = checkRepeatedCalls(this.calls, this.repeatThreshold);
    if (repeated) return repeated;
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
