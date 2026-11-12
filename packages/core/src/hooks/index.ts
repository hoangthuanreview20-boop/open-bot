/**
 * @open-bot/core hooks — public surface for the hooks module (v0.10).
 *
 * Deterministic lifecycle hooks (P0-2): PreToolUse / PostToolUse /
 * SessionStart / SessionEnd / Stop. Imported directly as
 * `@open-bot/core/dist/hooks/index.js` (same pattern as skills) and
 * re-exported from the core barrel (`src/index.ts`).
 *
 * Wiring into `AgentRunner.executeCall` is NOT part of this module —
 * the coordinator does that in a later step, using `HookRunner`:
 * `runPreToolUse` before executing a tool call, `runPostToolUse` after.
 */

export type {
  HookContext,
  HookDecision,
  HookDecisionAction,
  HookDefinition,
  HookError,
  HookEvent,
  HookEventKind,
  HookFn,
  HookSettings,
  HookSettingsEntry,
  HookSource,
  PostToolUseEvent,
  PreToolUseEvent,
  SessionEndEvent,
  SessionStartEvent,
  StopEvent,
} from './types';
export {
  allowDecision,
  blockDecision,
  HOOK_NAME_RE,
  HookRegistrationError,
  modifyArgsDecision,
  modifyContextDecision,
  modifyOutputDecision,
} from './types';

export { ALL_HOOK_EVENTS, HookRegistry, HOOKS_ENABLED_FILE } from './registry';
export type { ApplyHookSettingsResult, HookRegistryOptions, RegisterScriptHookDef } from './registry';

export { DEFAULT_HOOK_TIMEOUT_MS, HookRunner } from './runner';
export {
  DEFAULT_HOOK_SCRIPT_TIMEOUT_MS,
  MAX_HOOK_SCRIPT_STDERR_CHARS,
  MAX_HOOK_SCRIPT_STDOUT_CHARS,
  resolveHookScriptPath,
  runHookScript,
  safeEnvForHookScript,
} from './scriptRunner';
export type { HookScriptOptions } from './scriptRunner';

export type {
  HookErrorMode,
  HookRunResult,
  HookRunnerOptions,
  PostToolUseOutcome,
  PreToolUseOutcome,
  SessionHookOutcome,
} from './runner';
