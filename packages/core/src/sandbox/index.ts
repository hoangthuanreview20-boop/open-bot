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
