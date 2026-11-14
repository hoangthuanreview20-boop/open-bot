/**
 * Long-run compaction — keep a long run inside its budget (v1.02
 * rescue port of the v1.00 work).
 *
 * A long run accumulates history until the budget no longer fits.
 * `LongRunCompaction` watches the budget snapshot each turn and,
 * when usage crosses a threshold, prunes low-relevance turns and
 * keeps an extractive summary of what was dropped. The summary is
 * returned to the caller (the loop prepends it as a system note),
 * and the event is recorded in `CompactionHistory` so the user can
 * audit what was thrown away.
 */

import { randomUUID } from 'node:crypto';

import { measureContextBudget, type ContextBudgetSnapshot } from './budget';
import { pruneLowRelevanceTurns, type PrunableMessage } from './pruning';
import { CompactionHistory, type CompactionRecord } from './compactionStore';

export interface LongRunCompactionOptions {
  /** Usage ratio (used/limit) that triggers compaction (default 0.8). */
  triggerRatio?: number;
  /** History store for audit (optional; without it nothing is recorded). */
  history?: CompactionHistory;
  /** Number of recent messages never pruned (default 4). */
  keepRecent?: number;
}

export interface LongRunCompactionResult {
  compacted: boolean;
  snapshot: ContextBudgetSnapshot;
  /** Summary of dropped turns (empty when nothing was compacted). */
  summary: string;
  turnsDropped: number;
  tokensFreed: number;
  kept: PrunableMessage[];
}

/** Watches the budget each turn and compacts when it gets tight. */
export class LongRunCompaction {
  private readonly triggerRatio: number;
  private readonly history?: CompactionHistory;
  private readonly keepRecent: number;

  constructor(options: LongRunCompactionOptions = {}) {
    this.triggerRatio = options.triggerRatio ?? 0.8;
    this.history = options.history;
    this.keepRecent = options.keepRecent ?? 4;
  }

  /**
   * Check the budget for one turn; compact when usage is at or over
   * the trigger ratio. Returns the (possibly pruned) message list.
   */
  check(
    input: {
      model: string;
      systemPrompt?: string;
      messages: PrunableMessage[];
      tools?: Array<{ name: string; description?: string }>;
      reserveTokens?: number;
      contextLimitOverride?: number;
      botId?: string;
      runId?: string;
      latestUserText?: string;
    },
  ): LongRunCompactionResult {
    const snapshot = measureContextBudget(input);
    if (snapshot.usageRatio < this.triggerRatio) {
      return { compacted: false, snapshot, summary: '', turnsDropped: 0, tokensFreed: 0, kept: input.messages };
    }
    const tokensToFree = Math.max(0, snapshot.usedTokens - Math.floor(snapshot.limit * this.triggerRatio));
    const pruned = pruneLowRelevanceTurns(input.messages, tokensToFree, {
      keepRecent: this.keepRecent,
      latestUserText: input.latestUserText ?? '',
    });
    if (pruned.dropped.length === 0) {
      return { compacted: false, snapshot, summary: '', turnsDropped: 0, tokensFreed: 0, kept: input.messages };
    }
    const after = measureContextBudget({ ...input, messages: pruned.kept });
    if (this.history) {
      const record: CompactionRecord = {
        id: randomUUID(),
        at: new Date().toISOString(),
        botId: input.botId,
        runId: input.runId,
        tokensBefore: snapshot.usedTokens,
        tokensAfter: after.usedTokens,
        turnsDropped: pruned.dropped.length,
        summaryChars: pruned.summary.length,
        reason: 'long-run',
      };
      this.history.add(record);
    }
    return {
      compacted: true,
      snapshot: after,
      summary: pruned.summary,
      turnsDropped: pruned.dropped.length,
      tokensFreed: pruned.freedTokens,
      kept: pruned.kept,
    };
  }
}
