/**
 * Public API of the local-exec-daemon (v0.3 wave 2).
 *
 * The daemon runs long shell commands in a separate process so a crash
 * or a hung command cannot take down the desktop app. Talk to it through
 * DaemonClient; the daemon entry itself is dist/daemon/daemon.js.
 */
export { DaemonClient } from './client';
export type { DaemonClientOptions, DaemonEventHandler } from './client';
export { startDaemon, resolveDaemonWorkspaceDir, resolveDaemonAllowedWorkspaceRoots, resolveDaemonEgressPolicy } from './daemon';
export type { DaemonOptions } from './daemon';
// v0.53 (P1-7): phone-tool allowlist (Grok §2.5) — the bridge checks it before dispatch.
export {
  PHONE_TOOL_ALLOWLIST,
  PHONE_TOOL_IDS,
  PHONE_ONLY_TOOL_IDS,
  isPhoneToolAllowed,
  isPhoneOnlyTool,
  phoneToolScope,
  assertPhoneToolAllowed,
} from './phoneTools';
export type { PhoneToolAllowlistEntry } from './phoneTools';
export type {
  ExecCallbacks,
  ExecRequest,
  ExecEvent,
  ExecResult,
  ExecResultWithId,
  ExecInfo,
  ExecParams,
  ShellDaemon,
  SessionStartRequest,
  SessionStartResult,
  SessionEvent,
  SessionExitEvent,
  SessionInfo,
  DaemonMethod,
  DaemonInitParams,
  DaemonInitResult,
  DaemonRequest,
  DaemonResponse,
  DaemonNotification,
} from './types';
export {
  DEFAULT_DAEMON_MAX_EXECS,
  MAX_CONCURRENT_EXECS,
  MAX_EXEC_OUTPUT_CHARS,
  EXEC_OUTPUT_TRUNCATED_MARKER,
} from './types';
