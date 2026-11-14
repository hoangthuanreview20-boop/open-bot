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
  HookCommandSettingsEntry,
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
  PostCompactEvent,
  PostToolUseEvent,
  PreCompactEvent,
  PreToolUseEvent,
  SessionEndEvent,
  SessionStartEvent,
  StopEvent,
  SubagentStartEvent,
  SubagentStopEvent,
  SubagentStopStatus,
  UserPromptSubmitEvent,
} from './types';
export {
  allowDecision,
  blockDecision,
  blockStopDecision,
  DEFAULT_HOOK_COMMAND_TIMEOUT_MS,
  HOOK_NAME_RE,
  HookRegistrationError,
  MAX_HOOK_COMMAND_TIMEOUT_MS,
  MIN_HOOK_COMMAND_TIMEOUT_MS,
  modifyAdditionalContextDecision,
  modifyArgsDecision,
  modifyContextDecision,
  modifyOutputDecision,
} from './types';

export {
  ALL_HOOK_EVENTS,
  HOOK_COMMANDS_FILE,
  HOOKS_ENABLED_FILE,
  HookRegistry,
} from './registry';
export type {
  ApplyCommandHookSettingsResult,
  ApplyHookSettingsResult,
  HookRegistryOptions,
  RegisterCommandHookOptions,
  RegisterScriptHookDef,
} from './registry';

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

export {
  buildHookCommandEnv,
  HOOK_COMMAND_BLOCK_EXIT_CODE,
  HOOK_COMMAND_SECRET_ENV_PATTERN,
  HOOK_EVENT_ENV_VAR,
  MAX_HOOK_COMMAND_STDERR_CHARS,
  MAX_HOOK_COMMAND_STDOUT_CHARS,
  parseHookDecisionLine,
  runHookCommand,
  runShellCommand,
  safeEnvForHookCommand,
  shellForPlatform,
  stdoutLines,
  validateHookCommandEntry,
  assertValidHookCommandEntry,
} from './shellCommandRunner';
export type {
  HookCommandOptions,
  HookCommandValidationIssue,
  HookCommandValidationResult,
  RunShellCommandOptions,
  ShellCommandResult,
} from './shellCommandRunner';

export {
  DEFAULT_HOOK_LOG_MAX_RECORDS,
  HOOK_LOG_FILE_KEEP_LINES,
  HookExecutionLog,
  MAX_HOOK_LOG_FILE_BYTES,
  MAX_HOOK_LOG_MAX_RECORDS,
  readHookLogFile,
  summarizeHookLogRecords,
} from './hookLog';
export type {
  HookExecutionLogOptions,
  HookExecutionRecord,
  HookLogListFilter,
  HookLogPerHookSummary,
} from './hookLog';

export {
  buildFailedSummary,
  buildTestGateAdditionalContext,
  createTestGateHook,
  DEFAULT_TEST_GATE_COMMAND,
  DEFAULT_TEST_GATE_MAX_OUTPUT_CHARS,
  DEFAULT_TEST_GATE_TIMEOUT_MS,
  MAX_TEST_GATE_COMMANDS,
  normalizeTestGateConfig,
  readTestGateConfig,
  runTestGate,
  TEST_GATE_CONFIG_FILE,
  TEST_GATE_HOOK_NAME,
  testGateCommands,
} from './testGate';
export type { CreateTestGateHookOptions, TestGateCommandResult, TestGateConfig, TestGateOptions, TestGateResult } from './testGate';

// --- v1.01: whole-settings validation (hooks commands + test gate) ---
export {
  validateHookCommandsList,
  validateHookSettings,
  validateHookSettingsFiles,
  validateTestGateInput,
} from './settingsValidation';
export type { HookSettingsInput, HookSettingsIssue } from './settingsValidation';

export {
  buildSampleEvent,
  describeSampleEvent,
  testRunHookCommand,
} from './testRun';
export type { HookTestRunResult, TestRunHookCommandOptions } from './testRun';

export type {
  CompactHookOutcome,
  HookErrorMode,
  HookRunResult,
  HookRunnerOptions,
  PostToolUseOutcome,
  PreToolUseOutcome,
  SessionHookOutcome,
  SubagentStartOutcome,
  SubagentStopOutcome,
  UserPromptSubmitOutcome,
} from './runner';
