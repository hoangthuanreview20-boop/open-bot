/**
 * Hooks lifecycle — types (v0.10, P0-2).
 *
 * A hook is deterministic automation that runs at a fixed point in the
 * agent lifecycle, OUTSIDE the model's decision loop: the model can
 * "forget" an instruction buried in its prompt, but a hook always runs.
 * This is the layer approval (asking a human every time) cannot replace.
 *
 * Events (modelled on Claude Code's hook lifecycle, re-implemented here
 * from scratch for open-bot):
 * - `PreToolUse`  — before a tool runs. Validate / block / rewrite the
 *   tool call, e.g. block `rm -rf`, block writes outside the workspace.
 * - `PostToolUse` — after a tool ran. Normalise the output, auto-format,
 *   run typecheck/lint, log. May rewrite the result the model sees.
 * - `SessionStart` — when a session/run starts. May inject extra context
 *   (e.g. load workspace rules) via a `modify` decision's `context`.
 * - `SessionEnd` — when a session/run ends normally.
 * - `Stop` — when the agent stops (user stop, abort, max-steps, …).
 *
 * A hook is a plain JS/TS function in code (v0.10 scope). It receives a
 * JSON event + a small context object and returns a decision. Running a
 * hook from an external script file is NOT in scope for v0.10 — that is
 * a later wave (out-of-process plugin sandbox, v0.14).
 *
 * Settings cannot hold functions, so a settings entry only DECLARES a
 * hook by name (`HookSettingsEntry`): which events it handles and whether
 * it is enabled. The function itself must already be registered in the
 * `HookRegistry` (from code or a plugin) — see registry.ts
 * `applySettings()`. Unknown names in settings are reported, never
 * thrown: a typo in settings must not break the agent.
 */

/** The five lifecycle points a hook can attach to. */
export type HookEventKind =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop';

/** Where a hook came from. */
export type HookSource = 'builtin' | 'settings' | 'plugin';

/** What a hook decides about the event it saw. */
export type HookDecisionAction = 'allow' | 'block' | 'modify';

/**
 * One hook decision.
 *
 * - `allow` — let the event proceed unchanged.
 * - `block` — stop it. PreToolUse: the tool never runs and the model gets
 *   a tool error carrying `reason`. PostToolUse: the tool already ran;
 *   the result is replaced by a not-ok result carrying `reason`.
 *   SessionStart/SessionEnd/Stop: `block` has no effect (there is nothing
 *   left to stop) and is ignored — a session hook that wants to add
 *   context uses `modify` + `context` instead.
 * - `modify` — change the event and continue. Which payload field applies
 *   depends on the event: `args` for PreToolUse (rewritten tool args),
 *   `output` for PostToolUse (rewritten tool output), `context` for
 *   SessionStart (extra context lines injected into the session).
 *   v0.41 (P0-3 — `hook_additional_contexts` của Grok `ToolCall` #54):
 *   `context` on PreToolUse ALSO applies: extra context lines injected
 *   into the tool call itself, collected in order into
 *   `PreToolUseOutcome.additionalContexts` and passed to the tool via
 *   `ToolContext.additionalContexts` (and recorded on the ToolResult +
 *   trace span). A `modify` without the payload field for its event is
 *   a no-op allow.
 *
 * `reason` is human-readable and is surfaced to the model/user whenever
 * a decision blocks or modifies something, so it should say WHY.
 */
export interface HookDecision {
  action: HookDecisionAction;
  /** Human-readable reason (required for `block`, recommended otherwise). */
  reason?: string;
  /** PreToolUse: replacement tool args (merged over the original args). */
  args?: Record<string, unknown>;
  /** PostToolUse: replacement tool output. */
  output?: string;
  /**
   * SessionStart: extra context lines to inject into the session.
   * PreToolUse (v0.40, P0-3): extra context lines to inject into the
   * tool call (`hook_additional_contexts`) — collected in order by
   * the runner, passed to the tool via `ToolContext.
   * additionalContexts`.
   */
  context?: string;
}

/** `allow`, optionally with a reason. */
export function allowDecision(reason?: string): HookDecision {
  return reason === undefined ? { action: 'allow' } : { action: 'allow', reason };
}

/** `block` with a mandatory reason — a block without a reason is a bug. */
export function blockDecision(reason: string): HookDecision {
  return { action: 'block', reason };
}

/** `modify` that rewrites tool args (PreToolUse). */
export function modifyArgsDecision(
  args: Record<string, unknown>,
  reason?: string,
): HookDecision {
  return reason === undefined
    ? { action: 'modify', args }
    : { action: 'modify', args, reason };
}

/** `modify` that rewrites tool output (PostToolUse). */
export function modifyOutputDecision(output: string, reason?: string): HookDecision {
  return reason === undefined
    ? { action: 'modify', output }
    : { action: 'modify', output, reason };
}

/** `modify` that injects extra context (SessionStart). */
export function modifyContextDecision(context: string, reason?: string): HookDecision {
  return reason === undefined
    ? { action: 'modify', context }
    : { action: 'modify', context, reason };
}

/**
 * Small context every hook receives alongside its event. Deliberately
 * narrow: a hook gets the ids it needs to log/route, plus the workspace
 * directory when it needs to judge paths — never secrets or keys.
 */
export interface HookContext {
  /** Bot the run belongs to (when known). */
  botId?: string;
  /** Workspace directory of the run (when known). */
  workspaceDir?: string;
  /** Run id (when the hook runs inside a run). */
  runId?: string;
  /** Session id (when the hook runs inside a session). */
  sessionId?: string;
}

/** PreToolUse: the model wants to call `toolName` with `args`. */
export interface PreToolUseEvent {
  event: 'PreToolUse';
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
}

/** PostToolUse: `toolName` ran; `result` is what it returned. */
export interface PostToolUseEvent {
  event: 'PostToolUse';
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  result: { ok: boolean; output: string };
}

/** SessionStart: a session/run is starting. */
export interface SessionStartEvent {
  event: 'SessionStart';
  /** Why the session started: 'startup' | 'resume' | 'compact' | … */
  source?: string;
}

/** SessionEnd: a session/run ended normally. */
export interface SessionEndEvent {
  event: 'SessionEnd';
  /** Why it ended, when known (e.g. 'done', 'cancelled'). */
  reason?: string;
}

/** Stop: the agent stopped (user stop, abort, max-steps, …). */
export interface StopEvent {
  event: 'Stop';
  /** Why it stopped, when known. */
  reason?: string;
}

/** Any event a hook can receive. Discriminated by `event`. */
export type HookEvent =
  | PreToolUseEvent
  | PostToolUseEvent
  | SessionStartEvent
  | SessionEndEvent
  | StopEvent;

/**
 * A hook handler: a plain function receiving a JSON event + context and
 * returning a decision (or nothing, which means `allow`). May be async.
 * It MUST NOT throw for expected rejections — return `block` instead.
 * If it does throw (or never resolves), the runner treats that as a hook
 * error, never as a run crash (see runner.ts `HookRunnerOptions`).
 */
export type HookFn = (
  event: HookEvent,
  ctx: HookContext,
) => HookDecision | void | Promise<HookDecision | void>;

/** Hook names: lowercase, digits, `-`/`_` (same rule as skill names). */
export const HOOK_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** One registered hook: identity + which events it handles + handler. */
export interface HookDefinition {
  /** Unique name (also the key settings/plugin entries refer to). */
  name: string;
  /** Human-readable description (shown in logs / future settings UI). */
  description?: string;
  /** Events this hook runs for. Must be non-empty. */
  events: HookEventKind[];
  handler: HookFn;
  /** Where the hook came from. */
  source: HookSource;
  /**
   * Whether the hook is enabled. Registry-managed: `register()` sets it
   * from persisted state (default true); use `enable()`/`disable()`.
   */
  enabled: boolean;
}

/**
 * A hook declaration in settings (JSON — no functions here). Refers to a
 * hook already registered in code or by a plugin, by name.
 */
export interface HookSettingsEntry {
  /** Name of a registered hook. Unknown names are reported, not fatal. */
  name: string;
  /** Default true. `false` disables the hook. */
  enabled?: boolean;
  /**
   * Restrict the hook to these events (subset of what it registered for).
   * Omit to keep the hook's registered events.
   */
  events?: HookEventKind[];
}

/** The `hooks` section of settings. */
export interface HookSettings {
  hooks?: HookSettingsEntry[];
}

/**
 * What went wrong with one hook invocation. A hook error NEVER crashes
 * the run: the runner records it here and either lets the event through
 * or blocks it, per `HookRunnerOptions.onHookError`.
 */
export interface HookError {
  hookName: string;
  event: HookEventKind;
  /** Error message (or `timeout after <ms>ms`). */
  error: string;
  /** True when the hook was killed by the per-hook timeout. */
  timedOut: boolean;
}

/** Thrown when a hook definition itself is invalid (bad name, no events…). */
export class HookRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HookRegistrationError';
  }
}
