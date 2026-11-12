/**
 * Usage tracking + spend limits (v0.4).
 * Public surface of packages/core/src/usage/.
 */
export { UsageTracker, MeteredProvider, SpendLimitError } from './usage';
export type {
  LimitScope,
  LimitViolation,
  MeteredProviderOptions,
  SpendLimits,
  SpendStatus,
  SpendWindow,
  UsageRecord,
  UsageSummary,
  UsageTrackerOptions,
} from './usage';

export { estimateCost, getModelPrice, listPricedModels, registerPrice, unregisterPrice } from './pricing';
export type { ModelPrice } from './pricing';
