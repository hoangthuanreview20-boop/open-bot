/**
 * HookRunner (v0.10, P0-2).
 *
 * Executes the hooks in a `HookRegistry` for one lifecycle event, in
 * registration order. The runner is the safety contract of the hook
 * system:
 *
 * - DETERMINISTIC ORDER: hooks run in registration order; the first
 *   `block` wins and later hooks do not run; `modify` decisions chain
 *   (each hook sees the previous hook's rewritten args/output).
 * - A HOOK NEVER CRASHES THE RUN: a hook that throws, returns an
 *   invalid decision, or never resolves is recorded as a `HookError`
 *   (and logged) and then either lets the event through or blocks it,
 *   per `HookRunnerOptions.onHookError` (default `block` — fail-closed:
 *   a hook that cannot be trusted to answer must not silently let a
 *   dangerous tool call through; set `allow` explicitly only when a
 *   hook is non-critical and a failure must never wedge the agent).
 *   Session-boundary events (SessionStart/SessionEnd/Stop) never block
 *   on a hook failure regardless of this option — there is nothing
 *   left to stop there, so failures are only recorded.
 * - PER-HOOK TIMEOUT: each hook gets `timeoutMs` (default 5s). A hook
 *   that times out is treated exactly like a throwing hook. The late
 *   hook's promise is left to settle on its own (its rejection is
 *   swallowed so it can never become an unhandled rejection).
 * - NO THROW: every `run*` method resolves with an outcome object,
 *   even when every hook fails. The caller (later: `AgentRunner.
 *   executeCall`) only has to read the outcome.
 *
 * Intended wiring (NOT done here — coordinator-owned, later step):
 *   const outcome = await runner.runPreToolUse(
 *     { event: 'PreToolUse', toolName: call.name, toolCallId: call.id, args: call.args },
 *     { botId: bot.id, workspaceDir: bot.workspaceDir, runId },
 *   );
 *   if (outcome.decision === 'block') return { callId, ok: false, output: outcome.reason };
 *   const result = await tool.execute(outcome.args, ctx);
 *   const post = await runner.runPostToolUse({ ..., result }, ...);
 *   return { callId, ok: post.ok, output: post.output };
 */

import type { HookRegistry } from './registry';
import type { HookExecutionLog } from './hookLog';
import type {
  HookContext,
  HookDecision,
  HookError,
  HookEvent,
  HookEventKind,
  PostCompactEvent,
  PostToolUseEvent,
  PreCompactEvent,
  PreToolUseEvent,
  SessionEndEvent,
  SessionStartEvent,
  StopEvent,
  SubagentStartEvent,
  SubagentStopEvent,
  UserPromptSubmitEvent,
} from './types';

/** Default per-hook timeout: a hook that hangs longer than this is killed. */
export const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

/**
 * What happens when a hook throws, returns an invalid decision, or
 * times out. `block` (default): treat the failure as a block of the
 * event — fail-closed, so a broken hook can never silently let a
 * dangerous tool call through. `allow`: log it and let the event
 * through — opt in explicitly, only for hooks whose failure must
 * never wedge the agent.
 */
export type HookErrorMode = 'allow' | 'block';

export interface HookRunnerOptions {
  /** Per-hook timeout in ms. Default `DEFAULT_HOOK_TIMEOUT_MS` (5000). */
  timeoutMs?: number;
  /** What a hook failure means. Default `'block'` (fail-closed). */
  onHookError?: HookErrorMode;
  /**
   * Where hook failures are logged. Default: silent (the failure is
   * still recorded in every outcome's `hookErrors`). Pass `console.error`
   * (or a real logger) from the host to see failures in the app log.
   */
  logger?: (message: string) => void;
  /**
   * v1.01: execution log every hook invocation is recorded in (one
   * record per hook per event, via the single `invokeOne` choke point).
   * Absent = no recording (old behaviour). The log never throws and
   * never breaks a run.
   */
  executionLog?: HookExecutionLog;
}

/** Outcome of `runPreToolUse`. */
export interface PreToolUseOutcome {
  /** Final decision: what the caller should do with the tool call. */
  decision: 'allow' | 'block' | 'modify';
  /** Args to actually execute (original args, plus chained `modify`s). */
  args: Record<string, unknown>;
  /**
   * v0.41 (P0-3 — `hook_additional_contexts`, Grok `ToolCall` #54):
   * extra context lines injected into this tool call by PreToolUse
   * hooks (`modify` + `context`), in hook-run order. Empty when no
   * hook injected anything. The agent loop passes these to the tool
   * via `ToolContext.additionalContexts` and records them on the
   * ToolResult + trace span. A `block` outcome still carries the
   * contexts collected before the blocking hook (the call never runs,
   * but the loop may log them).
   */
  additionalContexts: string[];
  /** Reason for a `block` (or for the last `modify`), when given. */
  reason?: string;
  /** Name of the hook that blocked, when `decision === 'block'`. */
  blockedBy?: string;
  /** Hooks that threw / returned garbage / timed out (never fatal). */
  hookErrors: HookError[];
  /** Names of the hooks that ran, in order. */
  hooksRun: string[];
}

/** Outcome of `runPostToolUse`. */
export interface PostToolUseOutcome {
  /** Final ok flag: false when a hook blocked the result. */
  ok: boolean;
  /** Output the model should see (possibly rewritten by hooks). */
  output: string;
  /** True when at least one hook rewrote the output. */
  modified: boolean;
  /** Name of the hook that blocked, when one did. */
  blockedBy?: string;
  /** Reason for a block, when given. */
  reason?: string;
  hookErrors: HookError[];
  hooksRun: string[];
}

/** Outcome of `runSessionStart` / `runSessionEnd` / `runStop`. */
export interface SessionHookOutcome {
  /**
   * Extra context lines collected from SessionStart hooks (`modify` +
   * `context`). Always `[]` for SessionEnd/Stop — there is nothing to
   * inject context into after the session is over.
   */
  context: string[];
  hookErrors: HookError[];
  hooksRun: string[];
}

/**
 * v1.01 — outcome of `runSubagentStart`. A `block` cancels the spawn
 * (the loop creates no child runner). `context` lines come from
 * `modify` + `context` decisions and are appended to the subagent's
 * task when it does spawn.
 */
export interface SubagentStartOutcome {
  decision: 'allow' | 'block' | 'modify';
  /** Context lines injected into the subagent's task (in hook-run order). */
  context: string[];
  /** Reason for a `block` (or for the last `modify`), when given. */
  reason?: string;
  /** Name of the hook that blocked, when `decision === 'block'`. */
  blockedBy?: string;
  hookErrors: HookError[];
  hooksRun: string[];
}

/**
 * v1.01 — outcome of `runSubagentStop`. A `block` REJECTS the stop:
 * the loop sends the subagent back (one bounded retry) with
 * `additionalContext` appended to its task, and shows it to the lead
 * agent. `additionalContexts` collects every hook's `additionalContext`
 * in run order (a `modify` may add context without blocking);
 * `additionalContext` is the same lines joined for the caller.
 */
export interface SubagentStopOutcome {
  decision: 'allow' | 'block' | 'modify';
  /** `additionalContext` lines from all hooks that ran, in order. */
  additionalContexts: string[];
  /** `additionalContexts` joined with blank lines ('' when none). */
  additionalContext: string;
  /** Reason for a `block` (or for the last `modify`), when given. */
  reason?: string;
  /** Name of the hook that blocked, when `decision === 'block'`. */
  blockedBy?: string;
  hookErrors: HookError[];
  hooksRun: string[];
}

/**
 * v1.01 — outcome of `runPreCompact` / `runPostCompact`. A `block` on
 * PreCompact skips the round; a `block` on PostCompact reverts to the
 * pre-compaction messages. `context` lines come from `modify` +
 * `context` decisions (PreCompact: lines for the summary prompt;
 * PostCompact: hook notes appended after the summary).
 */
export interface CompactHookOutcome {
  decision: 'allow' | 'block' | 'modify';
  /** Context lines collected from `modify` decisions, in order. */
  context: string[];
  /** Reason for a `block` (or for the last `modify`), when given. */
  reason?: string;
  /** Name of the hook that blocked, when `decision === 'block'`. */
  blockedBy?: string;
  hookErrors: HookError[];
  hooksRun: string[];
}

/**
 * v1.01 — outcome of `runUserPromptSubmit`. A `block` refuses the turn
 * (the loop returns the reason as the answer, no provider call).
 * `context` lines come from `modify` + `context` decisions and are
 * prepended to the user prompt.
 */
export interface UserPromptSubmitOutcome {
  decision: 'allow' | 'block' | 'modify';
  /** Context lines prepended to the user prompt, in order. */
  context: string[];
  /** Reason for a `block` (or for the last `modify`), when given. */
  reason?: string;
  /** Name of the hook that blocked, when `decision === 'block'`. */
  blockedBy?: string;
  hookErrors: HookError[];
  hooksRun: string[];
}

/** One hook's raw result from `runHooks` (low-level, for tracing/debug). */
export interface HookRunResult {
  hookName: string;
  /** The hook's decision, when it returned a valid one. */
  decision?: HookDecision;
  /** Set when the hook threw, returned garbage, or timed out. */
  error?: HookError;
}

type InvokeResult =
  | { kind: 'decision'; decision: HookDecision }
  | { kind: 'error'; error: string; timedOut: boolean };

const VALID_ACTIONS = new Set(['allow', 'block', 'modify']);

function normalizeDecision(raw: unknown): HookDecision | null {
  if (raw === undefined || raw === null) return { action: 'allow' };
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const action = (raw as { action?: unknown }).action;
  if (typeof action !== 'string' || !VALID_ACTIONS.has(action)) return null;
  return raw as HookDecision;
}

export class HookRunner {
  private readonly registry: HookRegistry;
  private readonly opts: HookRunnerOptions;

  constructor(registry: HookRegistry, opts: HookRunnerOptions = {}) {
    this.registry = registry;
    this.opts = opts;
  }

  private timeoutMs(): number {
    return this.opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  }

  /**
   * Fail-closed is the default: only an explicit `onHookError: 'allow'`
   * lets a failed hook's event through.
   */
  private failClosed(): boolean {
    return this.opts.onHookError !== 'allow';
  }

  private log(message: string): void {
    this.opts.logger?.(message);
  }

  private recordError(
    errors: HookError[],
    hookName: string,
    event: HookEventKind,
    error: string,
    timedOut: boolean,
  ): void {
    errors.push({ hookName, event, error, timedOut });
    this.log(
      `[hooks] hook "${hookName}" failed on ${event}: ${error}` +
        (timedOut ? ' (timeout)' : ''),
    );
  }

  /**
   * Invoke one hook with a timeout. Never throws: every failure mode is
   * returned as `{ kind: 'error', … }`. Every invocation is recorded in
   * `opts.executionLog` when one is set (decision action or error,
   * duration, reason) — the single choke point, so all `run*` methods
   * are covered.
   */
  private async invokeOne(
    hookName: string,
    handler: (event: HookEvent, ctx: HookContext) => unknown,
    event: HookEvent,
    ctx: HookContext,
  ): Promise<InvokeResult> {
    const timeoutMs = this.timeoutMs();
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const settled = await Promise.race([
        Promise.resolve()
          .then(() => handler(event, ctx))
          .then(
            (raw): InvokeResult => {
              const decision = normalizeDecision(raw);
              if (decision === null) {
                return {
                  kind: 'error',
                  error: `hook "${hookName}" returned an invalid decision (expected { action: 'allow' | 'block' | 'modify' })`,
                  timedOut: false,
                };
              }
              return { kind: 'decision', decision };
            },
            (err: unknown): InvokeResult => ({
              kind: 'error',
              error: err instanceof Error ? err.message : String(err),
              timedOut: false,
            }),
          ),
        new Promise<InvokeResult>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                kind: 'error',
                error: `hook "${hookName}" timed out after ${timeoutMs}ms`,
                timedOut: true,
              }),
            timeoutMs,
          );
        }),
      ]);
      this.recordExecution(hookName, event.event, startedAt, settled);
      return settled;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Record one hook invocation in the execution log (when configured).
   * Never throws — a log failure must never break a run.
   */
  private recordExecution(
    hookName: string,
    event: HookEventKind,
    startedAt: number,
    result: InvokeResult,
  ): void {
    const log = this.opts.executionLog;
    if (!log) return;
    try {
      const durationMs = Date.now() - startedAt;
      if (result.kind === 'decision') {
        log.record({
          hookName,
          event,
          action: result.decision.action,
          durationMs,
          reason: result.decision.reason,
          timedOut: false,
        });
      } else {
        log.record({
          hookName,
          event,
          action: 'error',
          durationMs,
          error: result.error,
          timedOut: result.timedOut,
        });
      }
    } catch {
      // The log never breaks a run.
    }
  }

  /**
   * Low-level: run EVERY enabled hook for `event` (no early stop, no
   * chaining — each hook sees the original event) and return each
   * hook's raw result. For tracing/debugging; the agent loop should use
   * the `runPreToolUse` / `runPostToolUse` / `runSession*` methods,
   * which apply block-wins + modify-chaining semantics.
   */
  async runHooks(event: HookEvent, ctx: HookContext = {}): Promise<HookRunResult[]> {
    const results: HookRunResult[] = [];
    for (const hook of this.registry.listForEvent(event.event)) {
      const res = await this.invokeOne(hook.name, hook.handler, event, ctx);
      if (res.kind === 'decision') {
        results.push({ hookName: hook.name, decision: res.decision });
      } else {
        const hookError: HookError = {
          hookName: hook.name,
          event: event.event,
          error: res.error,
          timedOut: res.timedOut,
        };
        this.log(
          `[hooks] hook "${hook.name}" failed on ${event.event}: ${res.error}` +
            (res.timedOut ? ' (timeout)' : ''),
        );
        results.push({ hookName: hook.name, error: hookError });
      }
    }
    return results;
  }

  /**
   * PreToolUse: run hooks in order over the tool call. First `block`
   * wins (later hooks do not run); `modify` rewrites `args` for the
   * next hook and for the eventual tool execution. A `modify` may also
   * carry `context`: extra context lines injected into the tool call
   * (`hook_additional_contexts`, v0.41 P0-3) — collected in order into
   * `additionalContexts` and passed to the tool via ToolContext.
   */
  async runPreToolUse(
    input: Omit<PreToolUseEvent, 'event'>,
    ctx: HookContext = {},
  ): Promise<PreToolUseOutcome> {
    let args: Record<string, unknown> = { ...input.args };
    let modified = false;
    let reason: string | undefined;
    const additionalContexts: string[] = [];
    const hookErrors: HookError[] = [];
    const hooksRun: string[] = [];

    for (const hook of this.registry.listForEvent('PreToolUse')) {
      hooksRun.push(hook.name);
      const event: PreToolUseEvent = {
        event: 'PreToolUse',
        toolName: input.toolName,
        toolCallId: input.toolCallId,
        args,
      };
      const res = await this.invokeOne(hook.name, hook.handler, event, ctx);
      if (res.kind === 'error') {
        this.recordError(hookErrors, hook.name, 'PreToolUse', res.error, res.timedOut);
        if (this.failClosed()) {
          return {
            decision: 'block',
            args,
            additionalContexts,
            reason: `Hook "${hook.name}" failed: ${res.error}`,
            blockedBy: hook.name,
            hookErrors,
            hooksRun,
          };
        }
        continue;
      }
      const decision = res.decision;
      if (decision.action === 'block') {
        return {
          decision: 'block',
          args,
          additionalContexts,
          reason: decision.reason ?? `Blocked by hook "${hook.name}".`,
          blockedBy: hook.name,
          hookErrors,
          hooksRun,
        };
      }
      if (decision.action === 'modify') {
        if (decision.args !== undefined) {
          args = { ...args, ...decision.args };
          modified = true;
        }
        if (decision.context !== undefined && decision.context !== '') {
          additionalContexts.push(decision.context);
          modified = true;
        }
        if (decision.reason !== undefined) reason = decision.reason;
      }
    }

    return {
      decision: modified ? 'modify' : 'allow',
      args,
      additionalContexts,
      reason,
      hookErrors,
      hooksRun,
    };
  }

  /**
   * PostToolUse: run hooks in order over the tool result. `modify`
   * rewrites the output the model sees (chained); a `block` replaces
   * the result with a not-ok result carrying the reason (the tool
   * already ran — a block can only stop the result reaching the model).
   */
  async runPostToolUse(
    input: Omit<PostToolUseEvent, 'event'>,
    ctx: HookContext = {},
  ): Promise<PostToolUseOutcome> {
    let ok = input.result.ok;
    let output = input.result.output;
    let modified = false;
    const hookErrors: HookError[] = [];
    const hooksRun: string[] = [];

    for (const hook of this.registry.listForEvent('PostToolUse')) {
      hooksRun.push(hook.name);
      const event: PostToolUseEvent = {
        event: 'PostToolUse',
        toolName: input.toolName,
        toolCallId: input.toolCallId,
        args: input.args,
        result: { ok, output },
      };
      const res = await this.invokeOne(hook.name, hook.handler, event, ctx);
      if (res.kind === 'error') {
        this.recordError(hookErrors, hook.name, 'PostToolUse', res.error, res.timedOut);
        if (this.failClosed()) {
          return {
            ok: false,
            output: `Tool output blocked: hook "${hook.name}" failed: ${res.error}`,
            modified,
            blockedBy: hook.name,
            reason: res.error,
            hookErrors,
            hooksRun,
          };
        }
        continue;
      }
      const decision = res.decision;
      if (decision.action === 'block') {
        return {
          ok: false,
          output:
            decision.reason ??
            `Tool output blocked by hook "${hook.name}".`,
          modified,
          blockedBy: hook.name,
          reason: decision.reason,
          hookErrors,
          hooksRun,
        };
      }
      if (decision.action === 'modify' && decision.output !== undefined) {
        output = decision.output;
        modified = true;
      }
    }

    return { ok, output, modified, hookErrors, hooksRun };
  }

  /**
   * SessionStart: run hooks, collect `modify` + `context` strings for
   * injection into the session. A `block` is meaningless here (the
   * session already started) and is ignored; a failing hook is recorded
   * and never stops the session.
   */
  async runSessionStart(
    input: Omit<SessionStartEvent, 'event'> = {},
    ctx: HookContext = {},
  ): Promise<SessionHookOutcome> {
    return this.runSessionEvent('SessionStart', input, ctx, true);
  }

  /** SessionEnd: run hooks; failures are recorded, never thrown. */
  async runSessionEnd(
    input: Omit<SessionEndEvent, 'event'> = {},
    ctx: HookContext = {},
  ): Promise<SessionHookOutcome> {
    return this.runSessionEvent('SessionEnd', input, ctx, false);
  }

  /** Stop: run hooks; failures are recorded, never thrown. */
  async runStop(
    input: Omit<StopEvent, 'event'> = {},
    ctx: HookContext = {},
  ): Promise<SessionHookOutcome> {
    return this.runSessionEvent('Stop', input, ctx, false);
  }

  /**
   * v1.01 — SubagentStart: run hooks before a subagent spawns. First
   * `block` wins (the loop creates no child). A `modify` may carry
   * `context`: lines appended to the subagent's task. A hook failure is
   * fail-closed (block) by default — a subagent that cannot be vetted
   * must not spawn silently.
   */
  async runSubagentStart(
    input: Omit<SubagentStartEvent, 'event'>,
    ctx: HookContext = {},
  ): Promise<SubagentStartOutcome> {
    const context: string[] = [];
    let modified = false;
    let reason: string | undefined;
    const hookErrors: HookError[] = [];
    const hooksRun: string[] = [];

    for (const hook of this.registry.listForEvent('SubagentStart')) {
      hooksRun.push(hook.name);
      const event: SubagentStartEvent = { event: 'SubagentStart', ...input };
      const res = await this.invokeOne(hook.name, hook.handler, event, ctx);
      if (res.kind === 'error') {
        this.recordError(hookErrors, hook.name, 'SubagentStart', res.error, res.timedOut);
        if (this.failClosed()) {
          return {
            decision: 'block',
            context,
            reason: `Hook "${hook.name}" failed: ${res.error}`,
            blockedBy: hook.name,
            hookErrors,
            hooksRun,
          };
        }
        continue;
      }
      const decision = res.decision;
      if (decision.action === 'block') {
        return {
          decision: 'block',
          context,
          reason: decision.reason ?? `Subagent spawn blocked by hook "${hook.name}".`,
          blockedBy: hook.name,
          hookErrors,
          hooksRun,
        };
      }
      if (decision.action === 'modify') {
        if (decision.context !== undefined && decision.context !== '') {
          context.push(decision.context);
          modified = true;
        }
      }
      // An `allow` may also carry a reason (e.g. the test gate explaining
      // why it let the event through) — surface the last one given.
      if (decision.reason !== undefined) reason = decision.reason;
    }

    return { decision: modified ? 'modify' : 'allow', context, reason, hookErrors, hooksRun };
  }

  /**
   * v1.01 — SubagentStop: run hooks when a subagent finishes. First
   * `block` wins: the stop is REJECTED and the loop sends the subagent
   * back with the collected `additionalContext`. A `modify` may add
   * `additionalContext` without blocking (the lead agent still sees
   * it). A hook failure is fail-closed (block) by default.
   */
  async runSubagentStop(
    input: Omit<SubagentStopEvent, 'event'>,
    ctx: HookContext = {},
  ): Promise<SubagentStopOutcome> {
    const additionalContexts: string[] = [];
    let modified = false;
    let reason: string | undefined;
    const hookErrors: HookError[] = [];
    const hooksRun: string[] = [];

    for (const hook of this.registry.listForEvent('SubagentStop')) {
      hooksRun.push(hook.name);
      const event: SubagentStopEvent = { event: 'SubagentStop', ...input };
      const res = await this.invokeOne(hook.name, hook.handler, event, ctx);
      if (res.kind === 'error') {
        this.recordError(hookErrors, hook.name, 'SubagentStop', res.error, res.timedOut);
        if (this.failClosed()) {
          return {
            decision: 'block',
            additionalContexts,
            additionalContext: additionalContexts.join('\n\n'),
            reason: `Hook "${hook.name}" failed: ${res.error}`,
            blockedBy: hook.name,
            hookErrors,
            hooksRun,
          };
        }
        continue;
      }
      const decision = res.decision;
      if (decision.additionalContext !== undefined && decision.additionalContext !== '') {
        additionalContexts.push(decision.additionalContext);
      }
      if (decision.action === 'block') {
        return {
          decision: 'block',
          additionalContexts,
          additionalContext: additionalContexts.join('\n\n'),
          reason: decision.reason ?? `Subagent stop blocked by hook "${hook.name}".`,
          blockedBy: hook.name,
          hookErrors,
          hooksRun,
        };
      }
      if (decision.action === 'modify') {
        modified = true;
      }
      // An `allow` may also carry a reason — surface the last one given.
      if (decision.reason !== undefined) reason = decision.reason;
    }

    return {
      decision: modified ? 'modify' : 'allow',
      additionalContexts,
      additionalContext: additionalContexts.join('\n\n'),
      reason,
      hookErrors,
      hooksRun,
    };
  }

  /**
   * v1.01 — PreCompact: run hooks before a compaction round. First
   * `block` wins (the round is skipped, history untouched). A `modify`
   * may carry `context` (lines for the summary prompt). A hook failure
   * is fail-closed (block) by default — a compaction that cannot be
   * vetted is skipped, history is never lost silently.
   */
  async runPreCompact(
    input: Omit<PreCompactEvent, 'event'>,
    ctx: HookContext = {},
  ): Promise<CompactHookOutcome> {
    return this.runCompactEvent('PreCompact', input, ctx);
  }

  /**
   * v1.01 — PostCompact: run hooks after a compaction round. First
   * `block` wins (the loop REVERTS to the pre-compaction messages).
   * A `modify` may carry `context` (hook notes appended after the
   * summary). A hook failure is fail-closed (block → revert) by default.
   */
  async runPostCompact(
    input: Omit<PostCompactEvent, 'event'>,
    ctx: HookContext = {},
  ): Promise<CompactHookOutcome> {
    return this.runCompactEvent('PostCompact', input, ctx);
  }

  private async runCompactEvent(
    kind: 'PreCompact' | 'PostCompact',
    input: Omit<PreCompactEvent, 'event'> | Omit<PostCompactEvent, 'event'>,
    ctx: HookContext,
  ): Promise<CompactHookOutcome> {
    const context: string[] = [];
    let modified = false;
    let reason: string | undefined;
    const hookErrors: HookError[] = [];
    const hooksRun: string[] = [];

    for (const hook of this.registry.listForEvent(kind)) {
      hooksRun.push(hook.name);
      const event = { event: kind, ...input } as PreCompactEvent | PostCompactEvent;
      const res = await this.invokeOne(hook.name, hook.handler, event, ctx);
      if (res.kind === 'error') {
        this.recordError(hookErrors, hook.name, kind, res.error, res.timedOut);
        if (this.failClosed()) {
          return {
            decision: 'block',
            context,
            reason: `Hook "${hook.name}" failed: ${res.error}`,
            blockedBy: hook.name,
            hookErrors,
            hooksRun,
          };
        }
        continue;
      }
      const decision = res.decision;
      if (decision.action === 'block') {
        return {
          decision: 'block',
          context,
          reason:
            decision.reason ??
            (kind === 'PreCompact'
              ? `Compaction skipped by hook "${hook.name}".`
              : `Compaction reverted by hook "${hook.name}".`),
          blockedBy: hook.name,
          hookErrors,
          hooksRun,
        };
      }
      if (decision.action === 'modify') {
        if (decision.context !== undefined && decision.context !== '') {
          context.push(decision.context);
          modified = true;
        }
      }
      // An `allow` may also carry a reason (e.g. the test gate explaining
      // why it let the event through) — surface the last one given.
      if (decision.reason !== undefined) reason = decision.reason;
    }

    return { decision: modified ? 'modify' : 'allow', context, reason, hookErrors, hooksRun };
  }

  /**
   * v1.01 — UserPromptSubmit: run hooks when the user submits a prompt,
   * before the guardrail / provider call. First `block` wins (the turn
   * is refused with the reason as the answer). A `modify` may carry
   * `context` (lines prepended to the prompt). A hook failure is
   * fail-closed (block) by default — an unvetted prompt never reaches
   * the model silently.
   */
  async runUserPromptSubmit(
    input: Omit<UserPromptSubmitEvent, 'event'>,
    ctx: HookContext = {},
  ): Promise<UserPromptSubmitOutcome> {
    const context: string[] = [];
    let modified = false;
    let reason: string | undefined;
    const hookErrors: HookError[] = [];
    const hooksRun: string[] = [];

    for (const hook of this.registry.listForEvent('UserPromptSubmit')) {
      hooksRun.push(hook.name);
      const event: UserPromptSubmitEvent = { event: 'UserPromptSubmit', ...input };
      const res = await this.invokeOne(hook.name, hook.handler, event, ctx);
      if (res.kind === 'error') {
        this.recordError(hookErrors, hook.name, 'UserPromptSubmit', res.error, res.timedOut);
        if (this.failClosed()) {
          return {
            decision: 'block',
            context,
            reason: `Hook "${hook.name}" failed: ${res.error}`,
            blockedBy: hook.name,
            hookErrors,
            hooksRun,
          };
        }
        continue;
      }
      const decision = res.decision;
      if (decision.action === 'block') {
        return {
          decision: 'block',
          context,
          reason: decision.reason ?? `Prompt blocked by hook "${hook.name}".`,
          blockedBy: hook.name,
          hookErrors,
          hooksRun,
        };
      }
      if (decision.action === 'modify') {
        if (decision.context !== undefined && decision.context !== '') {
          context.push(decision.context);
          modified = true;
        }
      }
      // An `allow` may also carry a reason (e.g. the test gate explaining
      // why it let the event through) — surface the last one given.
      if (decision.reason !== undefined) reason = decision.reason;
    }

    return { decision: modified ? 'modify' : 'allow', context, reason, hookErrors, hooksRun };
  }

  private async runSessionEvent(
    kind: 'SessionStart' | 'SessionEnd' | 'Stop',
    input: { source?: string; reason?: string },
    ctx: HookContext,
    collectContext: boolean,
  ): Promise<SessionHookOutcome> {
    const context: string[] = [];
    const hookErrors: HookError[] = [];
    const hooksRun: string[] = [];

    for (const hook of this.registry.listForEvent(kind)) {
      hooksRun.push(hook.name);
      const event = { event: kind, ...input } as SessionStartEvent | SessionEndEvent | StopEvent;
      const res = await this.invokeOne(hook.name, hook.handler, event, ctx);
      if (res.kind === 'error') {
        // A failing session hook can never block the session: record + go on.
        this.recordError(hookErrors, hook.name, kind, res.error, res.timedOut);
        continue;
      }
      const decision = res.decision;
      if (decision.action === 'block') {
        // Nothing left to stop at session boundaries; ignore, but say so.
        this.log(`[hooks] hook "${hook.name}" returned block on ${kind}; ignored.`);
        continue;
      }
      if (collectContext && decision.action === 'modify' && decision.context !== undefined) {
        context.push(decision.context);
      }
    }

    return { context, hookErrors, hooksRun };
  }
}
