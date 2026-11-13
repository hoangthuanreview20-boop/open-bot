/**
 * AG-UI runtime emitter + harness bridge (v0.97, Team T3).
 *
 * The emitter is the single place that turns agent-loop moments into
 * AG-UI events. The loop calls it (via the `agUiSink` option) at the
 * same points where it already emits harness events — run start/end,
 * text, tool calls — so the two streams can never drift apart in
 * meaning, only in shape.
 *
 * Exemption rule (hard lesson from v0.96, where a default-on router
 * routed mock bots to a real local Ollama): AG-UI emission is ON by
 * default for API providers, but it is OFF for provider `mock` and
 * for every CLI-kind provider (`claude-code`, `codex`, `grok-cli`,
 * `opencode`, `gemini-cli`, `cursor-cli`, `custom-acp*`, `aider`,
 * `continue-cli`, `amazon-q`, `copilot-cli`, `windsurf`, `kiro-cli`).
 * CLI runs already stream their own events through the harness bus
 * (the CLI driver owns the run), and mock runs are tests — emitting
 * AG-UI for them would double-report runs and, worse, make test runs
 * look like real user-visible activity. `shouldEmitAgUiForProvider`
 * is the single authority; the coordinator and the loop both call it.
 * No network probe and no Ollama call happens anywhere in this file:
 * emission is pure event construction + a synchronous bus publish.
 *
 * The harness bridge (`harnessEventToAgUi`) converts a sanitised
 * harness event into the closest AG-UI event, so a renderer that only
 * sees harness events (the existing `harness:event` IPC channel) can
 * still build an AG-UI activity feed, and so CLI runs — which never
 * get an AG-UI emitter — still show up in the feed as text/tool
 * activity. The bridge never invents data it does not have: a
 * harness `text` event becomes TEXT_MESSAGE_CONTENT with the delta
 * it carries; a `lifecycle` turn-start becomes RUN_STARTED only when
 * the payload says `phase: 'turn-start'`.
 */

import { randomUUID } from 'node:crypto';
import { AgUiEventBus } from './bus';
import { AgUiGenerativeUiRegistry, validateGenerativeUiRequest } from './genui';
import { AgUiStateStore } from './state';
import { makeAgUiEvent } from './types';
import type { AgUiEvent, AgUiEventType } from './types';
import { AG_UI_MAX_ARGS_CHARS, AG_UI_MAX_RESULT_CHARS, AG_UI_MAX_TEXT_CHARS } from './types';
import { truncateAgUiString, validateAgUiEvent } from './validate';
import type { HarnessEvent } from '../harness/types';

/** Provider ids served by a CLI driver (kind `cli` in PROVIDERS). */
export const AG_UI_CLI_PROVIDER_IDS: readonly string[] = [
  'claude-code',
  'codex',
  'grok-cli',
  'opencode',
  'gemini-cli',
  'cursor-cli',
  'custom-acp',
  'aider',
  'continue-cli',
  'amazon-q',
  'copilot-cli',
  'windsurf',
  'kiro-cli',
];

/**
 * True when AG-UI events must NOT be emitted for this provider.
 * `mock` is the test provider; CLI providers stream through the
 * harness bus already. A `custom-acp:<slug>` id is also a CLI run.
 * Everything else (openai, anthropic, gemini, xai, ollama,
 * openai-compatible, ...) emits.
 */
export function isAgUiExemptProvider(providerId: string | undefined): boolean {
  if (!providerId) return false;
  if (providerId === 'mock') return true;
  if (providerId.startsWith('custom-acp')) return true;
  return (AG_UI_CLI_PROVIDER_IDS as readonly string[]).includes(providerId);
}

/** True when AG-UI emission is allowed for this provider (the default). */
export function shouldEmitAgUiForProvider(providerId: string | undefined): boolean {
  return !isAgUiExemptProvider(providerId);
}

/**
 * True when a harness event from this engine should be bridged into
 * an AG-UI event (main process + SSE). Only CLI-kind engines and the
 * mock provider: API providers already publish their own AG-UI events
 * from the loop emitter, so bridging theirs would show every step
 * twice (once under the real run id, once under the harness thread).
 * CLI runs never get a loop emitter, so the bridge is their only
 * live signal into the AG-UI feed.
 */
export function isAgUiBridgeEngine(engine: string | undefined): boolean {
  if (!engine) return false;
  return isAgUiExemptProvider(engine);
}

/** Arguments for the emitter constructor. */
export interface AgUiRuntimeEmitterOptions {
  bus: AgUiEventBus;
  stateStore?: AgUiStateStore;
  genUiRegistry?: AgUiGenerativeUiRegistry;
  runId: string;
  botId: string;
  threadId?: string;
  providerId?: string;
  model?: string;
  /** True when this run is silent (automation/dream) — nothing is emitted. */
  silent?: boolean;
}

/**
 * Emits AG-UI events for one run. Every method is best-effort: a
 * validation failure or a bus error is swallowed (a run must never
 * fail because its activity feed failed) and counted in `errors`.
 * The emitter keeps the small per-run bookkeeping the loop would
 * otherwise have to repeat: the current text message id, the
 * in-flight tool calls (start time + name), step/tool counters, and
 * the run start time for duration reporting.
 */
export class AgUiRuntimeEmitter {
  private readonly bus: AgUiEventBus;
  private readonly stateStore: AgUiStateStore | undefined;
  private readonly genUiRegistry: AgUiGenerativeUiRegistry | undefined;
  private readonly runId: string;
  private readonly botId: string;
  private readonly threadId: string;
  private readonly providerId: string | undefined;
  private readonly model: string | undefined;
  private readonly silent: boolean;
  private readonly startedAtMs: number;
  private readonly toolCalls = new Map<string, { name: string; startedAtMs: number }>();
  private currentMessageId: string | undefined;
  private currentMessageText = '';
  private steps = 0;
  private toolCallCount = 0;
  private tokensUsed = 0;
  private started = false;
  private finished = false;
  private emitErrors = 0;

  constructor(opts: AgUiRuntimeEmitterOptions) {
    this.bus = opts.bus;
    this.stateStore = opts.stateStore;
    this.genUiRegistry = opts.genUiRegistry;
    this.runId = opts.runId;
    this.botId = opts.botId;
    this.threadId = opts.threadId ?? opts.botId;
    this.providerId = opts.providerId;
    this.model = opts.model;
    this.silent = opts.silent === true;
    this.startedAtMs = Date.now();
  }

  /** Run id this emitter serves. */
  get id(): string {
    return this.runId;
  }

  /** Number of emit failures swallowed so far (validation / bus). */
  get errors(): number {
    return this.emitErrors;
  }

  /** True when this emitter will actually publish (not silent, not exempt). */
  get active(): boolean {
    return !this.silent && shouldEmitAgUiForProvider(this.providerId);
  }

  /** Current text message id, when a message is open. */
  get openMessageId(): string | undefined {
    return this.currentMessageId;
  }

  /** Tool calls currently in flight (call id -> name). */
  inFlightToolCalls(): Array<{ toolCallId: string; toolName: string }> {
    return [...this.toolCalls.entries()].map(([toolCallId, entry]) => ({
      toolCallId,
      toolName: entry.name,
    }));
  }

  /** Emit RUN_STARTED + an initial STATE_SNAPSHOT (once per run). */
  runStarted(opts?: { title?: string; toolCount?: number }): void {
    if (this.started || !this.active) return;
    this.started = true;
    this.publish('RUN_STARTED', {
      ...(opts?.title !== undefined ? { title: opts.title } : {}),
      ...(this.providerId !== undefined ? { providerId: this.providerId } : {}),
      ...(this.model !== undefined ? { model: this.model } : {}),
      ...(opts?.toolCount !== undefined ? { toolCount: opts.toolCount } : {}),
    });
    this.publishStateSnapshot({
      status: 'running',
      step: 0,
      toolCalls: 0,
      startedAt: new Date(this.startedAtMs).toISOString(),
    });
  }

  /** Emit RUN_FINISHED (once) and close any open text message. */
  runFinished(status: 'completed' | 'stopped' | 'failed' | 'cancelled', finalText?: string): void {
    if (this.finished) return;
    this.finished = true;
    this.closeTextMessage();
    if (!this.active) return;
    this.publish('RUN_FINISHED', {
      status,
      ...(finalText !== undefined
        ? { finalText: truncateAgUiString(finalText, AG_UI_MAX_TEXT_CHARS) }
        : {}),
      steps: this.steps,
      toolCalls: this.toolCallCount,
      ...(this.tokensUsed > 0 ? { tokensUsed: this.tokensUsed } : {}),
      durationMs: Date.now() - this.startedAtMs,
    });
    this.publishStateSnapshot({
      status,
      step: this.steps,
      toolCalls: this.toolCallCount,
      finishedAt: new Date().toISOString(),
    });
  }

  /** Emit RUN_ERROR (a failed run also counts as finished afterwards). */
  runError(message: string, opts?: { code?: string; aborted?: boolean }): void {
    if (!this.active) return;
    this.publish('RUN_ERROR', {
      message: truncateAgUiString(message, AG_UI_MAX_TEXT_CHARS),
      ...(opts?.code !== undefined ? { code: opts.code } : {}),
      ...(opts?.aborted === true ? { aborted: true } : {}),
    });
  }

  /** Open a text message (TEXT_MESSAGE_START). Returns the message id. */
  textStart(): string {
    const messageId = randomUUID();
    this.currentMessageId = messageId;
    this.currentMessageText = '';
    if (!this.active) return messageId;
    this.publish('TEXT_MESSAGE_START', { messageId, role: 'assistant' }, { messageId });
    return messageId;
  }

  /**
   * Append streamed text (TEXT_MESSAGE_CONTENT). Opens a message
   * first when none is open, so a provider that delivers text without
   * a prior start still produces a well-formed stream.
   */
  textContent(delta: string): string {
    const messageId = this.currentMessageId ?? this.textStart();
    if (delta.length === 0) return messageId;
    this.currentMessageText += delta;
    if (!this.active) return messageId;
    this.publish(
      'TEXT_MESSAGE_CONTENT',
      {
        messageId,
        delta: truncateAgUiString(delta, AG_UI_MAX_TEXT_CHARS),
      },
      { messageId },
    );
    return messageId;
  }

  /** Close the open text message (TEXT_MESSAGE_END). No-op when none is open. */
  textEnd(): void {
    this.closeTextMessage();
  }

  /** Record token usage reported by the provider (for RUN_FINISHED). */
  noteUsage(inputTokens: number, outputTokens: number): void {
    if (Number.isFinite(inputTokens)) this.tokensUsed += Math.max(0, Math.floor(inputTokens));
    if (Number.isFinite(outputTokens)) this.tokensUsed += Math.max(0, Math.floor(outputTokens));
  }

  /** Record that a provider round-trip (step) started. */
  noteStep(): void {
    this.steps += 1;
    this.publishStateDelta([
      { op: 'set', path: 'step', value: this.steps },
    ]);
  }

  /** Emit TOOL_CALL_START + TOOL_CALL_ARGS for one call. */
  toolCallStart(toolCallId: string, toolName: string, args?: Record<string, unknown>): void {
    this.toolCalls.set(toolCallId, { name: toolName, startedAtMs: Date.now() });
    this.toolCallCount += 1;
    if (!this.active) return;
    this.publish(
      'TOOL_CALL_START',
      { toolCallId, toolName, step: this.steps },
      { toolCallId },
    );
    const argKeys = args ? Object.keys(args) : [];
    let argsJson: string | undefined;
    if (args && argKeys.length > 0) {
      try {
        const safeArgs: Record<string, unknown> = {};
        for (const key of argKeys) {
          const value = args[key];
          safeArgs[key] =
            typeof value === 'string'
              ? truncateAgUiString(value, 500)
              : typeof value === 'number' || typeof value === 'boolean'
                ? value
                : `[${Array.isArray(value) ? 'array' : typeof value}]`;
        }
        argsJson = truncateAgUiString(JSON.stringify(safeArgs), AG_UI_MAX_ARGS_CHARS);
      } catch {
        argsJson = undefined;
      }
    }
    this.publish(
      'TOOL_CALL_ARGS',
      {
        toolCallId,
        toolName,
        argKeys,
        ...(argsJson !== undefined ? { argsJson } : {}),
        complete: true,
      },
      { toolCallId },
    );
  }

  /** Emit TOOL_CALL_END for a call (ok / error / denied). */
  toolCallEnd(toolCallId: string, status: 'ok' | 'error' | 'denied'): void {
    const entry = this.toolCalls.get(toolCallId);
    const toolName = entry?.name ?? 'unknown';
    const durationMs = entry ? Date.now() - entry.startedAtMs : undefined;
    this.toolCalls.delete(toolCallId);
    if (!this.active) return;
    this.publish(
      'TOOL_CALL_END',
      {
        toolCallId,
        toolName,
        status,
        ...(durationMs !== undefined ? { durationMs } : {}),
      },
      { toolCallId },
    );
    this.publishStateDelta([{ op: 'set', path: 'toolCalls', value: this.toolCallCount }]);
  }

  /** Emit TOOL_CALL_RESULT with a truncated output preview. */
  toolCallResult(toolCallId: string, toolName: string, ok: boolean, output?: string): void {
    if (!this.active) return;
    this.publish(
      'TOOL_CALL_RESULT',
      {
        toolCallId,
        toolName,
        ok,
        ...(output !== undefined
          ? { outputPreview: truncateAgUiString(output, AG_UI_MAX_RESULT_CHARS) }
          : {}),
      },
      { toolCallId },
    );
  }

  /** Emit a STATE_SNAPSHOT event and store it in the state store. */
  publishStateSnapshot(state: Record<string, unknown>): void {
    if (!this.active) return;
    const cleaned = cleanState(state);
    this.stateStore?.applySnapshot(this.runId, cleaned, this.bus.lastEvent(this.runId)?.sequence ?? 0, {
      botId: this.botId,
    });
    this.publish('STATE_SNAPSHOT', { state: cleaned });
  }

  /** Emit a STATE_DELTA event and apply it in the state store. */
  publishStateDelta(
    operations: Array<{ op: 'set' | 'delete' | 'append'; path: string; value?: unknown }>,
  ): void {
    if (!this.active || operations.length === 0) return;
    try {
      this.stateStore?.applyDelta(
        this.runId,
        operations,
        this.bus.lastEvent(this.runId)?.sequence ?? 0,
        { botId: this.botId },
      );
    } catch {
      // State store failure must not break the run; the event still goes out.
    }
    this.publish('STATE_DELTA', { operations });
  }

  /** Emit a CUSTOM event for an extension namespace. */
  custom(name: string, value?: Record<string, unknown>): void {
    if (!this.active) return;
    this.publish('CUSTOM', {
      name,
      ...(value !== undefined ? { value: cleanState(value) } : {}),
    });
  }

  /** Emit an ACTIVITY event (planning, waiting, compaction, ...). */
  activity(
    kind: 'planning' | 'thinking' | 'waiting-approval' | 'waiting-user' | 'compaction' | 'checkpoint' | 'routing' | 'subagent' | 'note',
    label: string,
    opts?: { detail?: string; progress?: number },
  ): void {
    if (!this.active) return;
    this.publish('ACTIVITY', {
      kind,
      label,
      ...(opts?.detail !== undefined ? { detail: opts.detail } : {}),
      ...(opts?.progress !== undefined ? { progress: opts.progress } : {}),
    });
  }

  /**
   * Request a generative-UI component: validates the request, records
   * it in the registry, and emits the GENERATIVE_UI event. Returns the
   * component id, or `null` when the request is invalid / inactive.
   */
  requestGenerativeUi(
    data: {
      componentId?: string;
      kind: 'confirm' | 'options' | 'form' | 'table' | 'progress' | 'message';
      title: string;
      description?: string;
      props: Record<string, unknown>;
      blocking?: boolean;
    },
  ): string | null {
    if (!this.active) return null;
    try {
      const request = validateGenerativeUiRequest(
        {
          componentId: data.componentId ?? randomUUID(),
          kind: data.kind,
          title: data.title,
          ...(data.description !== undefined ? { description: data.description } : {}),
          props: data.props,
          ...(data.blocking === true ? { blocking: true } : {}),
        },
        this.runId,
        this.botId,
      );
      this.genUiRegistry?.request(request);
      this.publish('GENERATIVE_UI', {
        componentId: request.componentId,
        kind: request.kind,
        title: request.title,
        ...(request.description !== undefined ? { description: request.description } : {}),
        props: request.props as Record<string, unknown>,
        ...(request.blocking === true ? { blocking: true } : {}),
      });
      return request.componentId;
    } catch {
      this.emitErrors += 1;
      return null;
    }
  }

  /**
   * Record a generative-UI answer: validates it against the pending
   * request, updates the registry, and emits GENERATIVE_UI_RESPONSE.
   * Returns false when there is no such pending component.
   */
  answerGenerativeUi(componentId: string, response: Record<string, unknown>, action?: string): boolean {
    if (!this.active) return false;
    try {
      const record = this.genUiRegistry?.get(componentId);
      if (!record) return false;
      this.genUiRegistry?.answer(componentId, {
        componentId,
        response,
        ...(action !== undefined ? { action } : {}),
      });
      this.publish('GENERATIVE_UI_RESPONSE', {
        componentId,
        response,
        ...(action !== undefined ? { action } : {}),
      });
      return true;
    } catch {
      this.emitErrors += 1;
      return false;
    }
  }

  private closeTextMessage(): void {
    const messageId = this.currentMessageId;
    if (!messageId) return;
    this.currentMessageId = undefined;
    if (!this.active) return;
    this.publish(
      'TEXT_MESSAGE_END',
      {
        messageId,
        fullText: truncateAgUiString(this.currentMessageText, AG_UI_MAX_TEXT_CHARS),
      },
      { messageId },
    );
    this.currentMessageText = '';
  }

  private publish(
    type: AgUiEventType,
    data: Record<string, unknown>,
    opts?: { messageId?: string; toolCallId?: string },
  ): void {
    if (!this.active) return;
    try {
      const event = makeAgUiEvent(type, this.runId, data, {
        botId: this.botId,
        threadId: this.threadId,
        ...(opts?.messageId !== undefined ? { messageId: opts.messageId } : {}),
        ...(opts?.toolCallId !== undefined ? { toolCallId: opts.toolCallId } : {}),
      });
      validateAgUiEvent(event);
      const published = this.bus.publish(event);
      if (published === null) this.emitErrors += 1;
    } catch {
      this.emitErrors += 1;
    }
  }
}

function cleanState(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state).slice(0, 64)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    try {
      out[key] = JSON.parse(JSON.stringify(value)) ?? null;
    } catch {
      out[key] = '[unserializable]';
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Harness bridge: harness event -> AG-UI event (renderer feed fallback)
// ---------------------------------------------------------------------------

/**
 * Convert one sanitised harness event into the closest AG-UI event.
 * Returns `null` when the harness event has no AG-UI equivalent
 * (router decisions, permission bookkeeping, ...). The bridge is
 * lossy by design: it only maps what the harness payload actually
 * carries, and it never invents a run id — the caller supplies the
 * run id for the turn (usually the bot id, matching the harness
 * thread convention).
 *
 * Mapping:
 * - lifecycle turn-start -> RUN_STARTED; turn-end -> RUN_FINISHED
 *   (status from payload `status`: `ok` -> completed, else failed).
 * - text -> TEXT_MESSAGE_CONTENT (delta from payload `text`/`delta`).
 * - tool_call -> TOOL_CALL_START (+ TOOL_CALL_ARGS is not emitted:
 *   the harness payload only carries arg key names, which the
 *   renderer shows from the start event).
 * - result -> TOOL_CALL_RESULT (preview from payload `output`/`text`).
 * - error -> RUN_ERROR.
 * - abort -> RUN_FINISHED with status `cancelled`.
 * - approval_request -> ACTIVITY waiting-approval; approval_denied /
 *   permission_denied -> TOOL_CALL_END denied (when a call id is
 *   present) or ACTIVITY; approval_decision -> ACTIVITY note.
 */
/** Minimal shape the harness bridge needs (HarnessEvent and HarnessStreamEvent both satisfy it). */
export interface HarnessEventLike {
  botId: string;
  threadId: string;
  engine?: string;
  kind: string;
  payload: Record<string, unknown>;
  at: string;
}

export function harnessEventToAgUi(
  event: HarnessEventLike,
  runId: string,
): AgUiEvent | null {
  const base = {
    botId: event.botId,
    threadId: event.threadId,
    timestamp: event.at,
  };
  const payload = event.payload ?? {};
  const asString = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;
  switch (event.kind) {
    case 'lifecycle': {
      const phase = asString(payload['phase']);
      if (phase === 'turn-start') {
        return makeAgUiEvent('RUN_STARTED', runId, { title: undefined, providerId: event.engine } as unknown as Record<string, unknown>, base);
      }
      if (phase === 'turn-end') {
        const status = payload['status'] === 'ok' ? 'completed' : 'failed';
        return makeAgUiEvent('RUN_FINISHED', runId, { status }, base);
      }
      return null;
    }
    case 'text': {
      const delta = asString(payload['text']) ?? asString(payload['delta']);
      if (!delta) return null;
      const messageId = `harness:${event.threadId}:${event.at}`;
      return makeAgUiEvent(
        'TEXT_MESSAGE_CONTENT',
        runId,
        { messageId, delta: truncateAgUiString(delta, AG_UI_MAX_TEXT_CHARS) },
        { ...base, messageId },
      );
    }
    case 'tool_call': {
      const callId = asString(payload['callId']) ?? `harness:${event.at}`;
      const tool = asString(payload['tool']) ?? 'unknown';
      return makeAgUiEvent(
        'TOOL_CALL_START',
        runId,
        { toolCallId: callId, toolName: tool },
        { ...base, toolCallId: callId },
      );
    }
    case 'result': {
      const callId = asString(payload['callId']) ?? `harness:${event.at}`;
      const tool = asString(payload['tool']) ?? 'unknown';
      const output = asString(payload['output']) ?? asString(payload['text']);
      return makeAgUiEvent(
        'TOOL_CALL_RESULT',
        runId,
        {
          toolCallId: callId,
          toolName: tool,
          ok: payload['ok'] !== false,
          ...(output !== undefined
            ? { outputPreview: truncateAgUiString(output, AG_UI_MAX_RESULT_CHARS) }
            : {}),
        },
        { ...base, toolCallId: callId },
      );
    }
    case 'error': {
      const message = asString(payload['message']) ?? 'Run failed.';
      return makeAgUiEvent('RUN_ERROR', runId, { message }, base);
    }
    case 'abort': {
      return makeAgUiEvent('RUN_FINISHED', runId, { status: 'cancelled' }, base);
    }
    case 'approval_request':
    case 'permission_request': {
      return makeAgUiEvent(
        'ACTIVITY',
        runId,
        {
          kind: 'waiting-approval',
          label: 'Waiting for approval',
          ...(asString(payload['detail']) ? { detail: asString(payload['detail']) } : {}),
        },
        base,
      );
    }
    case 'approval_denied':
    case 'permission_denied': {
      const callId = asString(payload['callId']);
      if (callId) {
        return makeAgUiEvent(
          'TOOL_CALL_END',
          runId,
          { toolCallId: callId, toolName: asString(payload['tool']) ?? 'unknown', status: 'denied' },
          { ...base, toolCallId: callId },
        );
      }
      return makeAgUiEvent(
        'ACTIVITY',
        runId,
        { kind: 'waiting-approval', label: 'Approval denied' },
        base,
      );
    }
    case 'approval_decision': {
      return makeAgUiEvent(
        'ACTIVITY',
        runId,
        {
          kind: 'note',
          label: payload['allowed'] === true ? 'Approval granted' : 'Approval decided',
        },
        base,
      );
    }
    default:
      return null;
  }
}
