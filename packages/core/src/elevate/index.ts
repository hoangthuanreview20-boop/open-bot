/**
 * Elevate module re-exports (v0.86, P2-10 — privilege escalation
 * with mandatory per-call approval, fail-closed).
 */
export {
  buildElevatedArgv,
  formatElevatedResult,
  isElevateSupported,
  isPasswordRequiredError,
  validateElevateRequest,
  DEFAULT_ELEVATE_TIMEOUT_MS,
  ELEVATED_TOOL_NAME,
  ELEVATE_DENIED,
  ELEVATE_PASSWORD_REQUIRED,
  ELEVATE_UNSUPPORTED,
  MAX_ELEVATE_TIMEOUT_MS,
  MIN_ELEVATE_REASON_CHARS,
} from './elevate';
export type { ElevatedRunResult } from './elevate';
