/**
 * AG-UI activity feed reducer (v0.97, Team T3).
 *
 * Pure functions (no React, no I/O) that turn a stream of AG-UI
 * events into the feed items the ActivityFeed renders. The reducer is
 * incremental: `appendAgUiEventToFeed` takes the current item list
 * and one event and returns the next list, merging streaming updates
 * into the item they belong to instead of appending a new row per
 * delta:
 *
 * - TEXT_MESSAGE_CONTENT deltas accumulate into one text item per
 *   message id (created by TEXT_MESSAGE_START, or lazily by the
 *   first content event when the start was missed).
 * - TOOL_CALL_START opens one tool item per call id; ARGS fills its
 *   argument keys, END sets its status, RESULT fills its preview.
 * - RUN_STARTED / RUN_FINISHED / RUN_ERROR open/close one run item.
 * - STATE_SNAPSHOT / STATE_DELTA update the shared-state item.
 * - GENERATIVE_UI opens one component item; GENERATIVE_UI_RESPONSE
 *   marks it answered.
 * - ACTIVITY / CUSTOM append one item each (bounded by the feed cap).
 *
 * The same module also bridges harness events into AG-UI events
 * (`harnessEventToAgUiView`, a renderer-side mirror of the core
 * bridge in agui/runtime.ts): CLI runs never get a loop emitter, so
 * their harness events are the only live signal, and the feed shows
 * them as text/tool activity with the harness thread as the run id.
 * The bridge never invents data it does not have.
 */

import type { AgUiEventView, HarnessEventView } from '../../types';

/** One row of the live activity feed. */
export type AgUiFeedItemKind =
  | 'run'
  | 'text'
  | 'tool'
  | 'activity'
  | 'state'
  | 'genui'
  | 'custom';

export interface AgUiFeedItem {
  /** Stable key for React (`run:<runId>`, `text:<messageId>`, ...). */
  id: string;
  kind: AgUiFeedItemKind;
  runId: string;
  botId?: string;
  /** ISO timestamp of the first event of this item. */
  startedAt: string;
  /** ISO timestamp of the latest event folded into this item. */
  updatedAt: string;
  /** Human-readable primary line (already localised by the caller when needed). */
  title: string;
  /** Secondary line (tool name, delta preview, activity detail...). */
  detail?: string;
  /** Accumulated streamed text (text items only). */
  text?: string;
  /** Tool name (tool items only). */
  toolName?: string;
  /** Tool-call status: pending while the call runs. */
  toolStatus?: 'running' | 'ok' | 'error' | 'denied';
  /** Argument key names (tool items only). */
  argKeys?: string[];
  /** Truncated tool output preview (tool items only). */
  outputPreview?: string;
  /** Run status (run items only). */
  runStatus?: 'running' | 'completed' | 'stopped' | 'failed' | 'cancelled';
  /** Activity kind (activity items only). */
  activityKind?: string;
  /** 0..1 progress fraction (activity / progress items only). */
  progress?: number;
  /** Shared state snapshot (state items only). */
  state?: Record<string, unknown>;
  /** Generative-UI component payload (genui items only). */
  component?: {
    componentId: string;
    kind: string;
    title: string;
    description?: string;
    props: Record<string, unknown>;
    blocking?: boolean;
    answered?: boolean;
    response?: Record<string, unknown>;
  };
  /** Custom event name (custom items only). */
  customName?: string;
  /** Sequence of the latest event folded into this item. */
  sequence?: number;
}

/** Engines whose harness events are bridged into AG-UI (CLI + mock only). */
export const AG_UI_BRIDGE_ENGINES: readonly string[] = [
  'mock',
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
 * True when a harness event should be bridged into an AG-UI event.
 * Only CLI-kind engines and mock: API providers already publish
 * their own AG-UI events, so bridging theirs would show every step
 * twice. A `custom-acp:<slug>` engine is also a CLI run.
 */
export function shouldBridgeHarnessEvent(event: HarnessEventView): boolean {
  const engine = event.engine;
  if (!engine) return false;
  if (engine.startsWith('custom-acp')) return true;
  return AG_UI_BRIDGE_ENGINES.includes(engine);
}

/** Maximum feed items kept (oldest drop off, run items are kept). */
export const AG_UI_FEED_CAP = 300;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function eventTitle(event: AgUiEventView): string {
  const data = event.data ?? {};
  switch (event.type) {
    case 'RUN_STARTED':
      return asString(data['title']) ?? event.runId;
    case 'RUN_FINISHED': {
      const status = asString(data['status']) ?? 'completed';
      return `Run ${status}`;
    }
    case 'RUN_ERROR':
      return asString(data['message']) ?? 'Run failed';
    case 'ACTIVITY':
      return asString(data['label']) ?? 'Activity';
    case 'CUSTOM':
      return asString(data['name']) ?? 'Custom event';
    default:
      return event.type;
  }
}

/**
 * Convert one sanitised harness event into the closest AG-UI event.
 * Returns null when the harness event has no AG-UI equivalent.
 * The caller supplies the run id (usually the harness thread id,
 * which is the bot id for loop runs).
 */
export function harnessEventToAgUiView(
  event: HarnessEventView,
  runId: string,
): AgUiEventView | null {
  const base = {
    protocol: 'agui/1.0',
    runId,
    botId: event.botId,
    threadId: event.threadId,
    timestamp: event.at,
  };
  const payload = event.payload ?? {};
  switch (event.kind) {
    case 'lifecycle': {
      const phase = asString(payload['phase']);
      if (phase === 'turn-start') {
        return { ...base, type: 'RUN_STARTED', data: { providerId: event.engine } };
      }
      if (phase === 'turn-end') {
        return {
          ...base,
          type: 'RUN_FINISHED',
          data: { status: payload['status'] === 'ok' ? 'completed' : 'failed' },
        };
      }
      return null;
    }
    case 'text': {
      const delta = asString(payload['text']) ?? asString(payload['delta']);
      if (!delta) return null;
      const messageId = `harness:${event.threadId}:${event.at}`;
      return {
        ...base,
        type: 'TEXT_MESSAGE_CONTENT',
        messageId,
        data: { messageId, delta },
      };
    }
    case 'tool_call': {
      const callId = asString(payload['callId']) ?? `harness:${event.at}`;
      const tool = asString(payload['tool']) ?? 'unknown';
      return {
        ...base,
        type: 'TOOL_CALL_START',
        toolCallId: callId,
        data: { toolCallId: callId, toolName: tool },
      };
    }
    case 'result': {
      const callId = asString(payload['callId']) ?? `harness:${event.at}`;
      const tool = asString(payload['tool']) ?? 'unknown';
      const output = asString(payload['output']) ?? asString(payload['text']);
      return {
        ...base,
        type: 'TOOL_CALL_RESULT',
        toolCallId: callId,
        data: {
          toolCallId: callId,
          toolName: tool,
          ok: payload['ok'] !== false,
          ...(output !== undefined ? { outputPreview: output } : {}),
        },
      };
    }
    case 'error': {
      return {
        ...base,
        type: 'RUN_ERROR',
        data: { message: asString(payload['message']) ?? 'Run failed.' },
      };
    }
    case 'abort': {
      return { ...base, type: 'RUN_FINISHED', data: { status: 'cancelled' } };
    }
    case 'approval_request':
    case 'permission_request': {
      return {
        ...base,
        type: 'ACTIVITY',
        data: {
          kind: 'waiting-approval',
          label: 'Waiting for approval',
          ...(asString(payload['detail']) ? { detail: asString(payload['detail']) } : {}),
        },
      };
    }
    case 'approval_denied':
    case 'permission_denied': {
      const callId = asString(payload['callId']);
      if (callId) {
        return {
          ...base,
          type: 'TOOL_CALL_END',
          toolCallId: callId,
          data: {
            toolCallId: callId,
            toolName: asString(payload['tool']) ?? 'unknown',
            status: 'denied',
          },
        };
      }
      return {
        ...base,
        type: 'ACTIVITY',
        data: { kind: 'waiting-approval', label: 'Approval denied' },
      };
    }
    case 'approval_decision': {
      return {
        ...base,
        type: 'ACTIVITY',
        data: {
          kind: 'note',
          label: payload['allowed'] === true ? 'Approval granted' : 'Approval decided',
        },
      };
    }
    default:
      return null;
  }
}

function upsert(items: AgUiFeedItem[], item: AgUiFeedItem): AgUiFeedItem[] {
  const index = items.findIndex((entry) => entry.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function capFeed(items: AgUiFeedItem[]): AgUiFeedItem[] {
  if (items.length <= AG_UI_FEED_CAP) return items;
  // Keep run items (they anchor the feed) and drop the oldest
  // non-run items first.
  const overflow = items.length - AG_UI_FEED_CAP;
  const kept: AgUiFeedItem[] = [];
  let dropped = 0;
  for (const item of items) {
    if (dropped < overflow && item.kind !== 'run') {
      dropped += 1;
      continue;
    }
    kept.push(item);
  }
  return kept.length > AG_UI_FEED_CAP ? kept.slice(kept.length - AG_UI_FEED_CAP) : kept;
}

/**
 * Fold one AG-UI event into the feed. Returns a new list (the input
 * is never mutated). Unknown event types are ignored. Text deltas
 * longer than the cap are truncated at the item level so one huge
 * message cannot grow the feed without bound.
 */
export function appendAgUiEventToFeed(
  items: AgUiFeedItem[],
  event: AgUiEventView,
): AgUiFeedItem[] {
  const data = event.data ?? {};
  const updatedAt = event.timestamp;
  const sequence = event.sequence;
  switch (event.type) {
    case 'RUN_STARTED': {
      const id = `run:${event.runId}`;
      const existing = items.find((entry) => entry.id === id);
      const item: AgUiFeedItem = {
        id,
        kind: 'run',
        runId: event.runId,
        ...(event.botId !== undefined ? { botId: event.botId } : {}),
        startedAt: existing?.startedAt ?? updatedAt,
        updatedAt,
        title: eventTitle(event),
        runStatus: 'running',
        ...(sequence !== undefined ? { sequence } : {}),
      };
      return capFeed(upsert(items, item));
    }
    case 'RUN_FINISHED': {
      const id = `run:${event.runId}`;
      const existing = items.find((entry) => entry.id === id);
      const status = asString(data['status']) ?? 'completed';
      const runStatus =
        status === 'completed' || status === 'stopped' || status === 'failed' || status === 'cancelled'
          ? (status as AgUiFeedItem['runStatus'])
          : 'completed';
      const item: AgUiFeedItem = {
        id,
        kind: 'run',
        runId: event.runId,
        ...(event.botId !== undefined ? { botId: event.botId } : {}),
        startedAt: existing?.startedAt ?? updatedAt,
        updatedAt,
        title: existing?.title ?? eventTitle(event),
        detail: asString(data['finalText']) ?? existing?.detail,
        runStatus,
        ...(sequence !== undefined ? { sequence } : {}),
      };
      return capFeed(upsert(items, item));
    }
    case 'RUN_ERROR': {
      const id = `run:${event.runId}`;
      const existing = items.find((entry) => entry.id === id);
      const item: AgUiFeedItem = {
        id,
        kind: 'run',
        runId: event.runId,
        ...(event.botId !== undefined ? { botId: event.botId } : {}),
        startedAt: existing?.startedAt ?? updatedAt,
        updatedAt,
        title: existing?.title ?? eventTitle(event),
        detail: asString(data['message']),
        runStatus: 'failed',
        ...(sequence !== undefined ? { sequence } : {}),
      };
      return capFeed(upsert(items, item));
    }
    case 'TEXT_MESSAGE_START': {
      const messageId = asString(data['messageId']) ?? event.messageId ?? event.runId;
      const id = `text:${messageId}`;
      if (items.some((entry) => entry.id === id)) return items;
      return capFeed([
        ...items,
        {
          id,
          kind: 'text',
          runId: event.runId,
          ...(event.botId !== undefined ? { botId: event.botId } : {}),
          startedAt: updatedAt,
          updatedAt,
          title: 'Assistant',
          text: '',
          ...(sequence !== undefined ? { sequence } : {}),
        },
      ]);
    }
    case 'TEXT_MESSAGE_CONTENT': {
      const messageId = asString(data['messageId']) ?? event.messageId ?? event.runId;
      const delta = asString(data['delta']) ?? '';
      const id = `text:${messageId}`;
      const existing = items.find((entry) => entry.id === id);
      const text = `${existing?.text ?? ''}${delta}`.slice(0, 20000);
      const item: AgUiFeedItem = {
        id,
        kind: 'text',
        runId: event.runId,
        ...(event.botId !== undefined ? { botId: event.botId } : {}),
        startedAt: existing?.startedAt ?? updatedAt,
        updatedAt,
        title: 'Assistant',
        text,
        ...(sequence !== undefined ? { sequence } : {}),
      };
      return capFeed(upsert(items, item));
    }
    case 'TEXT_MESSAGE_END': {
      const messageId = asString(data['messageId']) ?? event.messageId ?? event.runId;
      const id = `text:${messageId}`;
      const existing = items.find((entry) => entry.id === id);
      if (!existing) return items;
      const fullText = asString(data['fullText']);
      const item: AgUiFeedItem = {
        ...existing,
        updatedAt,
        ...(fullText !== undefined ? { text: fullText.slice(0, 20000) } : {}),
        ...(sequence !== undefined ? { sequence } : {}),
      };
      return upsert(items, item);
    }
    case 'TOOL_CALL_START': {
      const callId = asString(data['toolCallId']) ?? event.toolCallId ?? event.timestamp;
      const toolName = asString(data['toolName']) ?? 'unknown';
      const id = `tool:${callId}`;
      if (items.some((entry) => entry.id === id)) return items;
      return capFeed([
        ...items,
        {
          id,
          kind: 'tool',
          runId: event.runId,
          ...(event.botId !== undefined ? { botId: event.botId } : {}),
          startedAt: updatedAt,
          updatedAt,
          title: toolName,
          toolName,
          toolStatus: 'running',
          ...(sequence !== undefined ? { sequence } : {}),
        },
      ]);
    }
    case 'TOOL_CALL_ARGS': {
      const callId = asString(data['toolCallId']) ?? event.toolCallId;
      if (!callId) return items;
      const id = `tool:${callId}`;
      const existing = items.find((entry) => entry.id === id);
      if (!existing) return items;
      const argKeys = Array.isArray(data['argKeys'])
        ? (data['argKeys'] as unknown[]).filter((k): k is string => typeof k === 'string')
        : undefined;
      return upsert(items, {
        ...existing,
        updatedAt,
        ...(argKeys !== undefined ? { argKeys } : {}),
        ...(sequence !== undefined ? { sequence } : {}),
      });
    }
    case 'TOOL_CALL_END': {
      const callId = asString(data['toolCallId']) ?? event.toolCallId;
      if (!callId) return items;
      const id = `tool:${callId}`;
      const existing = items.find((entry) => entry.id === id);
      if (!existing) return items;
      const status = asString(data['status']);
      return upsert(items, {
        ...existing,
        updatedAt,
        toolStatus: status === 'ok' ? 'ok' : status === 'denied' ? 'denied' : 'error',
        ...(sequence !== undefined ? { sequence } : {}),
      });
    }
    case 'TOOL_CALL_RESULT': {
      const callId = asString(data['toolCallId']) ?? event.toolCallId;
      if (!callId) return items;
      const id = `tool:${callId}`;
      const existing = items.find((entry) => entry.id === id);
      if (!existing) return items;
      return upsert(items, {
        ...existing,
        updatedAt,
        toolStatus: data['ok'] === true ? 'ok' : 'error',
        ...(asString(data['outputPreview']) !== undefined
          ? { outputPreview: asString(data['outputPreview']) }
          : {}),
        ...(sequence !== undefined ? { sequence } : {}),
      });
    }
    case 'STATE_SNAPSHOT': {
      const id = `state:${event.runId}`;
      const state = (data['state'] ?? {}) as Record<string, unknown>;
      return capFeed(
        upsert(items, {
          id,
          kind: 'state',
          runId: event.runId,
          ...(event.botId !== undefined ? { botId: event.botId } : {}),
          startedAt: items.find((entry) => entry.id === id)?.startedAt ?? updatedAt,
          updatedAt,
          title: 'Run state',
          state: { ...state },
          ...(sequence !== undefined ? { sequence } : {}),
        }),
      );
    }
    case 'STATE_DELTA': {
      const id = `state:${event.runId}`;
      const existing = items.find((entry) => entry.id === id);
      if (!existing) return items;
      const operations = Array.isArray(data['operations']) ? data['operations'] : [];
      const nextState: Record<string, unknown> = { ...(existing.state ?? {}) };
      for (const raw of operations as Array<Record<string, unknown>>) {
        const op = asString(raw['op']);
        const path = asString(raw['path']);
        if (!op || !path) continue;
        const parts = path.split('.');
        const last = parts[parts.length - 1];
        let node: Record<string, unknown> = nextState;
        let ok = true;
        for (const part of parts.slice(0, -1)) {
          const next = node[part];
          if (next !== undefined && typeof next === 'object' && next !== null && !Array.isArray(next)) {
            node = next as Record<string, unknown>;
          } else if (next === undefined) {
            const created: Record<string, unknown> = {};
            node[part] = created;
            node = created;
          } else {
            ok = false;
            break;
          }
        }
        if (!ok || !last) continue;
        if (op === 'delete') delete node[last];
        else if (op === 'append') {
          const current = node[last];
          node[last] = Array.isArray(current) ? [...current, raw['value']] : [raw['value']];
        } else if (op === 'set') node[last] = raw['value'];
      }
      return upsert(items, { ...existing, updatedAt, state: nextState });
    }
    case 'GENERATIVE_UI': {
      const componentId = asString(data['componentId']) ?? event.timestamp;
      const kind = asString(data['kind']) ?? 'message';
      const id = `genui:${componentId}`;
      if (items.some((entry) => entry.id === id)) return items;
      return capFeed([
        ...items,
        {
          id,
          kind: 'genui',
          runId: event.runId,
          ...(event.botId !== undefined ? { botId: event.botId } : {}),
          startedAt: updatedAt,
          updatedAt,
          title: asString(data['title']) ?? 'Component',
          detail: asString(data['description']),
          component: {
            componentId,
            kind,
            title: asString(data['title']) ?? 'Component',
            ...(asString(data['description']) !== undefined
              ? { description: asString(data['description']) }
              : {}),
            props: (data['props'] ?? {}) as Record<string, unknown>,
            ...(data['blocking'] === true ? { blocking: true } : {}),
            answered: false,
          },
          ...(sequence !== undefined ? { sequence } : {}),
        },
      ]);
    }
    case 'GENERATIVE_UI_RESPONSE': {
      const componentId = asString(data['componentId']);
      if (!componentId) return items;
      const id = `genui:${componentId}`;
      const existing = items.find((entry) => entry.id === id);
      if (!existing || !existing.component) return items;
      return upsert(items, {
        ...existing,
        updatedAt,
        component: {
          ...existing.component,
          answered: true,
          response: (data['response'] ?? {}) as Record<string, unknown>,
        },
        ...(sequence !== undefined ? { sequence } : {}),
      });
    }
    case 'ACTIVITY': {
      const id = `activity:${event.runId}:${event.timestamp}:${event.sequence ?? 0}`;
      const progress = asNumber(data['progress']);
      return capFeed([
        ...items,
        {
          id,
          kind: 'activity',
          runId: event.runId,
          ...(event.botId !== undefined ? { botId: event.botId } : {}),
          startedAt: updatedAt,
          updatedAt,
          title: eventTitle(event),
          detail: asString(data['detail']),
          activityKind: asString(data['kind']),
          ...(progress !== undefined ? { progress } : {}),
          ...(sequence !== undefined ? { sequence } : {}),
        },
      ]);
    }
    case 'CUSTOM': {
      const id = `custom:${event.runId}:${event.timestamp}:${event.sequence ?? 0}`;
      return capFeed([
        ...items,
        {
          id,
          kind: 'custom',
          runId: event.runId,
          ...(event.botId !== undefined ? { botId: event.botId } : {}),
          startedAt: updatedAt,
          updatedAt,
          title: eventTitle(event),
          customName: asString(data['name']),
          ...(sequence !== undefined ? { sequence } : {}),
        },
      ]);
    }
    default:
      return items;
  }
}

/** Fold a whole list of events (in order) into feed items. */
export function buildAgUiFeed(events: AgUiEventView[]): AgUiFeedItem[] {
  let items: AgUiFeedItem[] = [];
  for (const event of events) items = appendAgUiEventToFeed(items, event);
  return items;
}

/** True when the event ends a run (the feed may mark the run closed). */
export function isTerminalAgUiEventView(event: AgUiEventView): boolean {
  return event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR';
}

/** Small counts summary for the feed header. */
export function summarizeAgUiFeed(items: AgUiFeedItem[]): {
  runs: number;
  runningRuns: number;
  toolCalls: number;
  failedTools: number;
  components: number;
  pendingComponents: number;
} {
  let runs = 0;
  let runningRuns = 0;
  let toolCalls = 0;
  let failedTools = 0;
  let components = 0;
  let pendingComponents = 0;
  for (const item of items) {
    if (item.kind === 'run') {
      runs += 1;
      if (item.runStatus === 'running') runningRuns += 1;
    }
    if (item.kind === 'tool') {
      toolCalls += 1;
      if (item.toolStatus === 'error' || item.toolStatus === 'denied') failedTools += 1;
    }
    if (item.kind === 'genui' && item.component) {
      components += 1;
      if (!item.component.answered) pendingComponents += 1;
    }
  }
  return { runs, runningRuns, toolCalls, failedTools, components, pendingComponents };
}
