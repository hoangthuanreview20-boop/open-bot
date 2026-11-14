/**
 * Bot box / sandbox theo turn + egress gate (M6) — public surface của
 * `packages/core/src/sandbox/`. Xem README.md trong thư mục này.
 */
export { BotBoxManager, BOXES_REL_DIR, DEFAULT_BOX_LIMITS, dirFileCount, dirSizeBytes } from './box';
export type { BoxManagerOptions, RunInBoxOptions } from './box';
export {
  DEFAULT_BOX_ENV_VARS,
  buildBoxEnv,
  commandAvailable,
  defaultBoxEnvValues,
  detectIsolation,
  isolationKindAvailable,
  validateBoxEnvNames,
} from './env';
export type { BuildBoxEnvOptions } from './env';
export { EgressGate } from './gate';
export type { EgressGateInfo } from './gate';
export {
  SIGNIN_SETTLE_MS,
  listSignInStates,
  readSignInState,
  signInStateFileName,
  syncSignInState,
  waitSettled,
  writeSignInState,
} from './signin';
export type {
  AppliedResourceLimits,
  BotBox,
  BotBoxOptions,
  BoxResourceLimits,
  BoxRunResult,
  EgressGateOptions,
  GateDecisionLog,
  IsolationInfo,
  IsolationKind,
  ResolvedBoxLimits,
  SignInState,
  SignInStatus,
} from './types';
export {
  attachBoxToSession,
  boxDaemonExecRequest,
  publishBoxLifecycle,
} from './wiring';
export type { BoxDaemonExecRequest, BoxLifecycleAction } from './wiring';

// --- v1.02 (rescue port of v0.99): sandbox hardening v2 ---
export { checkAllowlist, isCommandAllowed, isHostAllowed, isPathAllowed } from './allowlist';
export type { SandboxAllowlist } from './allowlist';
export {
  BUILTIN_SANDBOX_PROFILES,
  SANDBOX_PROFILE_PERMISSIVE,
  SANDBOX_PROFILE_STANDARD,
  SANDBOX_PROFILE_STRICT,
  getBuiltinSandboxProfile,
  validateSandboxProfile,
} from './profiles';
export type { SandboxProfile } from './profiles';
export { DEFAULT_SANDBOX_QUOTA, SandboxQuotaTracker } from './quota';
export type { SandboxQuota, SandboxUsage } from './quota';
export { SandboxAuditLogger } from './audit';
export type { SandboxAuditEntry } from './audit';
export { SANDBOX_DENIED_PATH_PATTERNS, SandboxDeniedError, SandboxEnforcer } from './enforce';
export type { SandboxEnforcerOptions } from './enforce';
export { SANDBOX_CONFIG_FILE, SandboxConfigStore } from './store';
export type { SandboxConfigFile } from './store';
