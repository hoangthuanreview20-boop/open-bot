/**
 * Egress control (P0-2) — public surface của `packages/core/src/egress/`.
 */
export type {
  EgressContext,
  EgressDecision,
  EgressErrorCode,
  EgressErrorKind,
  EgressMode,
  EgressPolicy,
  EgressTarget,
} from './types';
export { EgressError, EGRESS_ERROR_CODE_BY_KIND } from './types';
export {
  checkEgress,
  checkEgressSync,
  checkGithubCheckout,
  classifyEgressFetchError,
  createAllowPublicEgressPolicy,
  createDefaultEgressPolicy,
  extractNetworkTargets,
  hostAllowlisted,
  ipInRange,
  ipInRanges,
  isLoopbackTarget,
  isPrivateIp,
  matchAllowHost,
  mergeEgressPolicies,
  parseEgressTarget,
  validateEgressPolicy,
  GITHUB_HOSTS,
} from './policy';
export type { CheckEgressOptions } from './policy';
export { EgressTelemetry, defaultEgressTelemetry } from './telemetry';
export type { EgressTelemetryKind, EgressTelemetrySnapshot } from './telemetry';
