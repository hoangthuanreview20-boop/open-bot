/**
 * Context budget — measure how much of the model window a prompt
 * uses, and whether a reply still fits (v1.02 rescue port of the
 * v0.99 work).
 *
 * The budget is purely arithmetic on the estimator (chars/4): it
 * never calls a model. The agent loop uses it before sending a
 * request (to trigger pruning/compaction) and after (to record the
 * real usage when the provider reports it).
 */

import {
  effectiveContextLimit,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTokens,
  SmallModelContextError,
} from './estimator';

export interface ContextBudgetInput {
  model: string;
  /** System prompt text (may be empty). */
  systemPrompt?: string;
  messages: Array<{ role: string; content?: string; toolCalls?: unknown[] }>;
  /** Tool definitions available to the model (name + description). */
  tools?: Array<{ name: string; description?: string }>;
  /** Tokens to reserve for the reply (default 4096). */
  reserveTokens?: number;
  /** Explicit context limit override. */
  contextLimitOverride?: number;
}

export interface ContextBudgetSnapshot {
  model: string;
  limit: number;
  usedTokens: number;
  reservedTokens: number;
  remainingTokens: number;
  /** used / limit, 0..1+ (over 1 means over budget). */
  usageRatio: number;
  fits: boolean;
  breakdown: {
    systemTokens: number;
    messageTokens: number;
    toolTokens: number;
  };
  /** When the budget does not fit, how many tokens must be freed. */
  overflowTokens: number;
}

/** Default tokens reserved for the model reply. */
export const DEFAULT_RESERVE_TOKENS = 4096;

/** Measure the context budget for one request. */
export function measureContextBudget(input: ContextBudgetInput): ContextBudgetSnapshot {
  const limit = effectiveContextLimit(input.model, input.contextLimitOverride);
  const reserved = input.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
  const systemTokens = estimateTokens(input.systemPrompt ?? '');
  const messageTokens = estimateMessagesTokens(input.messages);
  const toolTokens = (input.tools ?? []).reduce(
    (sum, tool) => sum + estimateTokens(tool.name) + estimateTokens(tool.description ?? ''),
    0,
  );
  const used = systemTokens + messageTokens + toolTokens;
  const remaining = limit - used - reserved;
  const fits = remaining >= 0;
  return {
    model: input.model,
    limit,
    usedTokens: used,
    reservedTokens: reserved,
    remainingTokens: remaining,
    usageRatio: limit > 0 ? used / limit : 0,
    fits,
    breakdown: { systemTokens, messageTokens, toolTokens },
    overflowTokens: fits ? 0 : -remaining,
  };
}

/** Throw when the prompt cannot fit even with zero history. */
export function assertBudgetFits(snapshot: ContextBudgetSnapshot): void {
  if (!snapshot.fits && snapshot.breakdown.messageTokens === 0) {
    throw new SmallModelContextError(snapshot.limit, snapshot.usedTokens);
  }
}

/** Tokens one message costs (re-exported for callers that only need one). */
export { estimateMessageTokens };

/** Compact summary of a budget snapshot for logs / UI. */
export function formatBudgetSummary(snapshot: ContextBudgetSnapshot): string {
  const pct = (snapshot.usageRatio * 100).toFixed(1);
  return `${snapshot.usedTokens}/${snapshot.limit} tokens (${pct}%)` +
    (snapshot.fits ? '' : ` — over by ${snapshot.overflowTokens} tokens`);
}
