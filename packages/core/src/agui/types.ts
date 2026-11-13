/**
 * AG-UI 1.0 — agent-to-user interface event types (v0.97, Team T3).
 *
 * Idea only, learned from the public AG-UI protocol description in
 * docs/repo-survey-v097.md section 3: an event-based protocol where a
 * backend agent emits a stream of typed events and a frontend consumes
 * them to show — and let the user steer — a run in progress, instead of
 * only showing the final text. No code, text or asset from any other
 * repo is copied here; the shapes below are open-bot's own design,
 * written from the protocol idea (run lifecycle, text streaming, tool
 * calls, state, custom events, generative UI).
 *
 * The three protocols form one stack, not competitors: MCP is
 * agent-to-tool, A2A is agent-to-agent, AG-UI is agent-to-user.
 *
 * Design rules for this module:
 * - Every event is a plain JSON object (no functions, no class
 *   instances) so it can travel over the harness bus, NDJSON logs,
 *   IPC, WebSocket and SSE unchanged.
 * - Payloads are already sanitised by the emitter (see runtime.ts):
 *   tool arguments carry key names only by default, long strings are
 *   truncated, secret-shaped values are never included. Validators in
 *   validate.ts enforce the shape again at every boundary (bus ingress,
 *   SSE ingress, IPC ingress).
 * - A run is identified by `runId`; a bot by `botId`; a conversation
 *   thread by `threadId`. `sequence` is a per-run monotonic counter
 *   assigned by the bus, so a consumer can detect gaps and reorder.
 * - `timestamp` is an ISO-8601 string, assigned by the emitter.
 */

export const AG_UI_PROTOCOL_VERSION = 'agui/1.0';

/** Maximum length of a single text delta / payload string (chars). */
export const AG_UI_MAX_TEXT_CHARS = 8000;
/** Maximum length of a tool-call argument JSON string (chars). */
export const AG_UI_MAX_ARGS_CHARS = 4000;
/** Maximum length of a tool result preview (chars). */
export const AG_UI_MAX_RESULT_CHARS = 4000;
/** Maximum number of keys in a state snapshot / delta object. */
export const AG_UI_MAX_STATE_KEYS = 64;
/** Maximum depth of a state value when it is cloned for transport. */
export const AG_UI_MAX_STATE_DEPTH = 4;
/** Maximum number of generative-UI options / table rows per event. */
export const AG_UI_MAX_GENUI_ITEMS = 50;

/**
 * The 16 standard AG-UI event types of open-bot.
 *
 * Run lifecycle (3): a run starts, finishes (with its final text and
 * usage when known) or errors.
 * Text streaming (3): a text message starts, streams content deltas,
 * then ends. A non-streaming provider emits start + one content event
 * holding the full text + end, so consumers never need a second path.
 * Tool calls (4): a call starts (name known), its arguments arrive
 * (possibly in chunks), the call ends (ok / error / denied), and the
 * result preview follows. `TOOL_CALL_END` and `TOOL_CALL_RESULT` are
 * separate on purpose: END is the control signal (the call is done,
 * the UI can stop its spinner), RESULT is the data signal (what the
 * tool returned, truncated).
 * State (2): a full snapshot of the run's shared state, and a delta
 * (JSON-patch-style operations) applied on top of it.
 * Generative UI (2): the agent asks the renderer to show an
 * interactive component, and the user answers it.
 * Misc (2): a free-form custom event for extensions, and a generic
 * activity/progress event for steps that are neither text nor a tool
 * call (planning, compaction, waiting for approval, ...).
 */
export const AG_UI_EVENT_TYPES = [
  'RUN_STARTED',
  'RUN_FINISHED',
  'RUN_ERROR',
  'TEXT_MESSAGE_START',
  'TEXT_MESSAGE_CONTENT',
  'TEXT_MESSAGE_END',
  'TOOL_CALL_START',
  'TOOL_CALL_ARGS',
  'TOOL_CALL_END',
  'TOOL_CALL_RESULT',
  'STATE_SNAPSHOT',
  'STATE_DELTA',
  'CUSTOM',
  'GENERATIVE_UI',
  'GENERATIVE_UI_RESPONSE',
  'ACTIVITY',
] as const;

export type AgUiEventType = (typeof AG_UI_EVENT_TYPES)[number];

/** True when `value` is one of the 16 standard AG-UI event types. */
export function isAgUiEventType(value: unknown): value is AgUiEventType {
  return (
    typeof value === 'string' &&
    (AG_UI_EVENT_TYPES as readonly string[]).includes(value)
  );
}

/** Run lifecycle outcome reported by RUN_FINISHED / RUN_ERROR. */
export type AgUiRunStatus = 'completed' | 'stopped' | 'failed' | 'cancelled';

/** Tool-call outcome reported by TOOL_CALL_END. */
export type AgUiToolCallStatus = 'ok' | 'error' | 'denied';

/** Generative-UI component kinds the renderer may render (see genui.ts). */
export type AgUiComponentKind =
  | 'confirm'
  | 'options'
  | 'form'
  | 'table'
  | 'progress'
  | 'message';

/** Activity kinds for the generic ACTIVITY event. */
export type AgUiActivityKind =
  | 'planning'
  | 'thinking'
  | 'waiting-approval'
  | 'waiting-user'
  | 'compaction'
  | 'checkpoint'
  | 'routing'
  | 'subagent'
  | 'note';

/** One JSON-patch-style operation inside a STATE_DELTA payload. */
export interface AgUiStateOperation {
  /** `set` replaces a path, `delete` removes it, `append` pushes to a list. */
  op: 'set' | 'delete' | 'append';
  /** Dot-separated path inside the run state, e.g. `progress.current`. */
  path: string;
  /** New value for `set` / `append`; absent for `delete`. */
  value?: unknown;
}

/** Payload of RUN_STARTED. */
export interface AgUiRunStartedData {
  /** Human-readable title of the run (first user words, truncated). */
  title?: string;
  /** Provider id that serves this run (never a CLI/mock run — see runtime). */
  providerId?: string;
  /** Model id that serves this run. */
  model?: string;
  /** Number of tools visible to the model in this run. */
  toolCount?: number;
}

/** Payload of RUN_FINISHED. */
export interface AgUiRunFinishedData {
  status: AgUiRunStatus;
  /** Final assistant text (truncated), when the run produced one. */
  finalText?: string;
  /** Total provider round-trips (steps) in this run. */
  steps?: number;
  /** Tool calls executed in this run. */
  toolCalls?: number;
  /** Tokens used in this run, when the provider reported usage. */
  tokensUsed?: number;
  /** Wall-clock duration of the run in milliseconds. */
  durationMs?: number;
}

/** Payload of RUN_ERROR. */
export interface AgUiRunErrorData {
  /** Short, user-facing error message (already sanitised). */
  message: string;
  /** Machine-readable error code when the emitter knows one. */
  code?: string;
  /** True when the run was stopped by the user (abort), not a failure. */
  aborted?: boolean;
}

/** Payload of TEXT_MESSAGE_START. */
export interface AgUiTextMessageStartData {
  /** Id of the text message; content/end events carry the same id. */
  messageId: string;
  /** Role of the message author (always `assistant` for agent text). */
  role?: string;
}

/** Payload of TEXT_MESSAGE_CONTENT. */
export interface AgUiTextMessageContentData {
  messageId: string;
  /** One chunk of streamed text (may be the whole text at once). */
  delta: string;
}

/** Payload of TEXT_MESSAGE_END. */
export interface AgUiTextMessageEndData {
  messageId: string;
  /** Full text of the finished message (truncated), when known. */
  fullText?: string;
}

/** Payload of TOOL_CALL_START. */
export interface AgUiToolCallStartData {
  toolCallId: string;
  /** Tool name, e.g. `read_file`. */
  toolName: string;
  /** Step number (0-based) of the run this call belongs to. */
  step?: number;
}

/** Payload of TOOL_CALL_ARGS. */
export interface AgUiToolCallArgsData {
  toolCallId: string;
  toolName: string;
  /** Argument key names only (never values) — see runtime.ts. */
  argKeys: string[];
  /** Truncated JSON of the arguments; absent when args are empty. */
  argsJson?: string;
  /** True when this is the last args chunk for this call. */
  complete?: boolean;
}

/** Payload of TOOL_CALL_END. */
export interface AgUiToolCallEndData {
  toolCallId: string;
  toolName: string;
  status: AgUiToolCallStatus;
  /** Duration of the call in milliseconds. */
  durationMs?: number;
}

/** Payload of TOOL_CALL_RESULT. */
export interface AgUiToolCallResultData {
  toolCallId: string;
  toolName: string;
  /** True when the tool reported success. */
  ok: boolean;
  /** Truncated preview of the tool output. */
  outputPreview?: string;
}

/** Payload of STATE_SNAPSHOT. */
export interface AgUiStateSnapshotData {
  /** Full shared state of the run (cloned, depth-capped). */
  state: Record<string, unknown>;
}

/** Payload of STATE_DELTA. */
export interface AgUiStateDeltaData {
  /** Operations to apply on top of the last snapshot, in order. */
  operations: AgUiStateOperation[];
  /** Sequence of the snapshot this delta applies to (0 = initial). */
  baseSequence?: number;
}

/** Payload of CUSTOM. */
export interface AgUiCustomData {
  /** Extension namespace, e.g. `open-bot.memory`. */
  name: string;
  /** Extension payload (JSON values only, depth-capped). */
  value?: Record<string, unknown>;
}

/** Payload of GENERATIVE_UI. */
export interface AgUiGenerativeUiData {
  /** Id of the component instance; the response carries the same id. */
  componentId: string;
  /** Which component the renderer should render. */
  kind: AgUiComponentKind;
  /** Title shown on the component card. */
  title: string;
  /** Optional supporting text shown under the title. */
  description?: string;
  /** Component data (options, rows, fields — see genui.ts). */
  props: Record<string, unknown>;
  /** True when the run waits for the user's answer before continuing. */
  blocking?: boolean;
}

/** Payload of GENERATIVE_UI_RESPONSE. */
export interface AgUiGenerativeUiResponseData {
  componentId: string;
  /** What the user picked / typed (JSON values only). */
  response: Record<string, unknown>;
  /** `confirm` / `dismiss` for confirm cards; `submit` otherwise. */
  action?: string;
}

/** Payload of ACTIVITY. */
export interface AgUiActivityData {
  kind: AgUiActivityKind;
  /** Short human-readable activity label. */
  label: string;
  /** Optional detail line shown under the label. */
  detail?: string;
  /** 0..1 progress fraction, when the activity is measurable. */
  progress?: number;
}

/**
 * Payload of any AG-UI event, keyed by type. `CUSTOM` is the escape
 * hatch: extensions put their own shape under `value`.
 */
export type AgUiEventData =
  | AgUiRunStartedData
  | AgUiRunFinishedData
  | AgUiRunErrorData
  | AgUiTextMessageStartData
  | AgUiTextMessageContentData
  | AgUiTextMessageEndData
  | AgUiToolCallStartData
  | AgUiToolCallArgsData
  | AgUiToolCallEndData
  | AgUiToolCallResultData
  | AgUiStateSnapshotData
  | AgUiStateDeltaData
  | AgUiCustomData
  | AgUiGenerativeUiData
  | AgUiGenerativeUiResponseData
  | AgUiActivityData;

/**
 * One AG-UI event — the envelope every producer emits and every
 * consumer (bus, renderer feed, SSE client) reads.
 *
 * `data` is typed loosely on purpose: the wire format is JSON, and
 * validate.ts is the authority on shape (a consumer that trusts the
 * static type without validating an untrusted source is a bug).
 */
export interface AgUiEvent {
  /** Protocol marker, always `agui/1.0`. */
  protocol: typeof AG_UI_PROTOCOL_VERSION;
  /** One of the 16 standard types. */
  type: AgUiEventType;
  /** Id of the run this event belongs to. */
  runId: string;
  /** Id of the bot running; absent for run-less custom events. */
  botId?: string;
  /** Id of the conversation thread; defaults to `botId` when absent. */
  threadId?: string;
  /** Id of the text message (text events) or component (generative UI). */
  messageId?: string;
  /** Id of the tool call (tool events). */
  toolCallId?: string;
  /** Per-run monotonic sequence, assigned by the bus (0-based). */
  sequence?: number;
  /** ISO-8601 timestamp, assigned by the emitter. */
  timestamp: string;
  /** Type-specific payload (see the `AgUi*Data` interfaces). */
  data: AgUiEventData & Record<string, unknown>;
}

/** Filter a subscriber (or an SSE client) applies to the event stream. */
export interface AgUiEventFilter {
  runId?: string;
  botId?: string;
  threadId?: string;
  types?: readonly AgUiEventType[];
  /** Only events with sequence >= this value (replay / resume). */
  minSequence?: number;
}

/** A handler that receives AG-UI events. It must never throw into the bus. */
export type AgUiEventHandler = (event: AgUiEvent) => void;

/** Build a minimal event; the bus fills `sequence` when it publishes. */
export function makeAgUiEvent(
  type: AgUiEventType,
  runId: string,
  data: AgUiEventData & Record<string, unknown>,
  opts?: {
    botId?: string;
    threadId?: string;
    messageId?: string;
    toolCallId?: string;
    timestamp?: string;
  },
): AgUiEvent {
  return {
    protocol: AG_UI_PROTOCOL_VERSION,
    type,
    runId,
    ...(opts?.botId !== undefined ? { botId: opts.botId } : {}),
    ...(opts?.threadId !== undefined ? { threadId: opts.threadId } : {}),
    ...(opts?.messageId !== undefined ? { messageId: opts.messageId } : {}),
    ...(opts?.toolCallId !== undefined ? { toolCallId: opts.toolCallId } : {}),
    timestamp: opts?.timestamp ?? new Date().toISOString(),
    data,
  };
}

/** True when the event type belongs to the run-lifecycle group. */
export function isAgUiRunLifecycleType(type: AgUiEventType): boolean {
  return type === 'RUN_STARTED' || type === 'RUN_FINISHED' || type === 'RUN_ERROR';
}

/** True when the event type belongs to the text-streaming group. */
export function isAgUiTextType(type: AgUiEventType): boolean {
  return (
    type === 'TEXT_MESSAGE_START' ||
    type === 'TEXT_MESSAGE_CONTENT' ||
    type === 'TEXT_MESSAGE_END'
  );
}

/** True when the event type belongs to the tool-call group. */
export function isAgUiToolCallType(type: AgUiEventType): boolean {
  return (
    type === 'TOOL_CALL_START' ||
    type === 'TOOL_CALL_ARGS' ||
    type === 'TOOL_CALL_END' ||
    type === 'TOOL_CALL_RESULT'
  );
}

/** True when the event type belongs to the state group. */
export function isAgUiStateType(type: AgUiEventType): boolean {
  return type === 'STATE_SNAPSHOT' || type === 'STATE_DELTA';
}

/** True when the event type belongs to the generative-UI group. */
export function isAgUiGenerativeUiType(type: AgUiEventType): boolean {
  return type === 'GENERATIVE_UI' || type === 'GENERATIVE_UI_RESPONSE';
}
