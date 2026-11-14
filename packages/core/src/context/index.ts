/**
 * Context engineering — public surface of `packages/core/src/context/`.
 *
 * Pure, model-free helpers the agent loop uses to stay inside the
 * model window: token estimation, budget measurement, pruning with
 * extractive summaries, prompt-cache hints, compaction history,
 * lead-agent delegation, long-task bookkeeping, task checkpoints, a
 * scoped virtual computer, and long-run compaction.
 */
export {
  DEFAULT_CONTEXT_LIMIT_TOKENS,
  ESTIMATED_CHARS_PER_TOKEN,
  KNOWN_MODEL_CONTEXT_LIMITS,
  MESSAGE_OVERHEAD_TOKENS,
  SMALL_CONTEXT_THRESHOLD_TOKENS,
  SmallModelContextError,
  effectiveContextLimit,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTokens,
  inferContextLimitFromModelName,
  isSmallContextModel,
} from './estimator';
export {
  DEFAULT_RESERVE_TOKENS,
  assertBudgetFits,
  formatBudgetSummary,
  measureContextBudget,
} from './budget';
export type { ContextBudgetInput, ContextBudgetSnapshot } from './budget';
export { buildExtractiveSummary, pruneLowRelevanceTurns, relevanceScore } from './pruning';
export type { PrunableMessage, PruneResult } from './pruning';
export { PROMPT_CACHE_PROVIDERS, PromptCacheTracker, cacheSupportForProvider } from './cacheHints';
export type { CacheObservation } from './cacheHints';
export { CompactionHistory } from './compactionStore';
export type { CompactionRecord } from './compactionStore';
export { LeadAgent } from './leadAgent';
export type { LeadDelegate, LeadRunResult, LeadSubtask, LeadSubtaskResult } from './leadAgent';
export { LONG_TASK_STALE_MS, LongTask } from './longTask';
export type { LongTaskSnapshot, LongTaskStatus } from './longTask';
export { TaskCheckpointStore } from './taskCheckpoints';
export type { TaskCheckpoint, TaskCheckpointStoreOptions } from './taskCheckpoints';
export { VirtualComputer } from './virtualComputer';
export type { VirtualComputerOptions, VirtualComputerRunResult } from './virtualComputer';
export { LongRunCompaction } from './longRunCompaction';
export type { LongRunCompactionOptions, LongRunCompactionResult } from './longRunCompaction';
