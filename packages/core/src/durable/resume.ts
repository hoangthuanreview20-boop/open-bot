/**
 * Resume from a journal — rebuild a run's state and re-execute only
 * what is missing (v1.02 rescue port of the v0.99 work).
 *
 * `resumeRunFromJournal` replays the journal into a
 * `DurableResumeState` (messages from the last checkpoint, finished
 * tool calls, tokens used, next step index, completed idempotency
 * keys). `DurableRunner` then executes each step/tool at most once
 * per key: a key already in the journal returns the stored result
 * instead of calling the executor again. Retries only happen for
 * work with no recorded result.
 */

import { RunJournal, type JournalCheckpointData } from './journal';

export interface DurableResumeState {
  runId: string;
  /** Messages from the last checkpoint (empty when no checkpoint). */
  messages: unknown[];
  /** Finished tool calls with their results. */
  completedToolCalls: Array<{ call: unknown; result: unknown }>;
  tokensUsed: number;
  nextStepIndex: number;
  completedKeys: string[];
  finished: boolean;
}

/** Rebuild the resume state of a run from its journal file. */
export function resumeRunFromJournal(journalPath: string, runId?: string): DurableResumeState | undefined {
  const replay = RunJournal.replayEntries(journalPath);
  if (replay.entries.length === 0) return undefined;
  const checkpoint: JournalCheckpointData | undefined = replay.lastCheckpoint;
  // The journal sanitizer stringifies deeply nested values (the call
  // object sits at depth 4 inside a checkpoint entry); parse it back
  // so DurableRunner can match it by call id.
  const completedToolCalls = (checkpoint?.completedToolCalls ?? []).map((entry) => {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { call?: unknown }).call === 'string'
    ) {
      try {
        return { ...entry, call: JSON.parse((entry as { call: string }).call) };
      } catch {
        return entry;
      }
    }
    return entry;
  });
  return {
    runId: runId ?? replay.entries[0].runId,
    messages: checkpoint?.messages ?? [],
    completedToolCalls,
    tokensUsed: checkpoint?.tokensUsed ?? 0,
    nextStepIndex: checkpoint?.nextStepIndex ?? 0,
    completedKeys: [...replay.completedKeys],
    finished: replay.finished,
  };
}

/** Guard: has this idempotency key already finished? */
export class ReplayGuard {
  private readonly completedKeys: Set<string>;

  constructor(completedKeys: Iterable<string> = []) {
    this.completedKeys = new Set(completedKeys);
  }

  isDone(key: string): boolean {
    return this.completedKeys.has(key);
  }

  markDone(key: string): void {
    this.completedKeys.add(key);
  }

  get size(): number {
    return this.completedKeys.size;
  }
}

/**
 * Executes steps and tool calls at most once per idempotency key.
 * A key already recorded in the journal returns the stored result
 * (or a marker when the journal holds no result for it).
 */
export class DurableRunner {
  private readonly journal: RunJournal;
  private readonly guard: ReplayGuard;
  private readonly storedResults = new Map<string, unknown>();

  constructor(journal: RunJournal, resumeState?: DurableResumeState) {
    this.journal = journal;
    this.guard = new ReplayGuard(resumeState?.completedKeys ?? []);
    for (const entry of resumeState?.completedToolCalls ?? []) {
      const call = entry.call as { id?: string } | undefined;
      if (call && typeof call.id === 'string') this.storedResults.set(`tool:${call.id}:result`, entry.result);
    }
  }

  /** Run one step exactly once (by key). The executor runs only when the key is new. */
  async runStep<T>(stepIndex: number, executor: () => Promise<T>): Promise<{ result: T | undefined; executed: boolean }> {
    const key = `step:${stepIndex}:completed`;
    if (this.guard.isDone(key)) return { result: undefined, executed: false };
    this.journal.recordStepStarted(stepIndex);
    const result = await executor();
    this.journal.recordStepCompleted(stepIndex);
    this.guard.markDone(key);
    return { result, executed: true };
  }

  /** Run one tool call exactly once (by call id). Returns the stored result when replayed. */
  async runToolCall<T>(
    callId: string,
    toolName: string,
    executor: () => Promise<T>,
  ): Promise<{ result: T | undefined; executed: boolean }> {
    const key = `tool:${callId}:result`;
    if (this.guard.isDone(key)) {
      return { result: this.storedResults.get(key) as T | undefined, executed: false };
    }
    this.journal.recordToolCall(callId, toolName);
    const result = await executor();
    this.journal.recordToolResult(callId, toolName, result);
    this.guard.markDone(key);
    this.storedResults.set(key, result);
    return { result, executed: true };
  }
}
