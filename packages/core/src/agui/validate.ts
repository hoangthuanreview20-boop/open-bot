/**
 * AG-UI validation + sanitisation (v0.97, Team T3).
 *
 * Every AG-UI event that crosses a trust boundary — bus ingress from
 * an untrusted producer, SSE ingress from an external client, IPC
 * ingress from the renderer — is validated here first. The runtime
 * emitter (runtime.ts) already produces well-formed events, but a
 * consumer must never trust shape alone: validate, then use.
 *
 * Sanitisation rules (shared with the harness layer's philosophy, but
 * implemented independently so this module has no dependency on it):
 * - Tool arguments are never transported as values: only key names,
 *   plus a truncated JSON string the emitter chose to include. A
 *   validator rejects an args payload that carries a secret-shaped
 *   value under a well-known secret key name.
 * - Strings are length-capped; over-long values are truncated, never
 *   silently dropped (the consumer can see the event was cut).
 * - Unknown top-level fields are dropped (strict envelope); unknown
 *   fields inside `data` are kept only for CUSTOM / GENERATIVE_UI
 *   props, where the component registry re-validates them.
 * - No HTML, no script, no `javascript:` URLs anywhere: generative-UI
 *   props are data only (see genui.ts), the renderer never injects
 *   event content as HTML.
 */

import {
  AG_UI_EVENT_TYPES,
  AG_UI_MAX_ARGS_CHARS,
  AG_UI_MAX_GENUI_ITEMS,
  AG_UI_MAX_RESULT_CHARS,
  AG_UI_MAX_STATE_DEPTH,
  AG_UI_MAX_STATE_KEYS,
  AG_UI_MAX_TEXT_CHARS,
  AG_UI_PROTOCOL_VERSION,
} from './types';
import type {
  AgUiEvent,
  AgUiEventFilter,
  AgUiEventType,
  AgUiStateOperation,
} from './types';

/** Key names that must never appear with a value in an event payload. */
export const AG_UI_SECRET_KEY_NAMES: readonly string[] = [
  'apiKey',
  'api_key',
  'apikey',
  'token',
  'accessToken',
  'access_token',
  'secret',
  'password',
  'passwd',
  'privateKey',
  'private_key',
  'clientSecret',
  'client_secret',
  'bearer',
  'authorization',
  'sessionKey',
  'refreshToken',
  'refresh_token',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSecretKeyName(key: string): boolean {
  const lower = key.toLowerCase();
  return AG_UI_SECRET_KEY_NAMES.some((name) => name.toLowerCase() === lower);
}

/** Truncate a string to `limit` chars, keeping a marker that it was cut. */
export function truncateAgUiString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= 3) return value.slice(0, limit);
  return `${value.slice(0, limit - 3)}...`;
}

/**
 * Deep-clone a JSON value, capping depth and dropping secret-shaped
 * entries. Returns `undefined` when the value itself is not JSON-safe
 * (function, symbol, bigint, circular — a circular value yields the
 * string `"[circular]"` at the point of the cycle instead of throwing).
 * Arrays are capped at 100 items; objects at AG_UI_MAX_STATE_KEYS keys.
 */
export function cloneAgUiJson(
  value: unknown,
  depth = AG_UI_MAX_STATE_DEPTH,
  seen: Set<object> = new Set(),
): unknown {
  if (value === null) return null;
  if (typeof value === 'string') return truncateAgUiString(value, AG_UI_MAX_TEXT_CHARS);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (value === undefined) return undefined;
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return '[circular]';
  if (depth <= 0) return '[truncated]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value.slice(0, 100)) {
        const cloned = cloneAgUiJson(item, depth - 1, seen);
        if (cloned !== undefined) out.push(cloned);
      }
      return out;
    }
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let kept = 0;
    for (const [key, entry] of Object.entries(record)) {
      if (kept >= AG_UI_MAX_STATE_KEYS) break;
      if (isSecretKeyName(key)) continue;
      const cloned = cloneAgUiJson(entry, depth - 1, seen);
      if (cloned === undefined) continue;
      out[key] = cloned;
      kept += 1;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/** Error thrown by the validators below; `message` is safe to show. */
export class AgUiValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgUiValidationError';
  }
}

function fail(message: string): never {
  throw new AgUiValidationError(message);
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    fail(`AG-UI event field "${key}" must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    fail(`AG-UI event field "${key}" is too long (max ${maxLength}).`);
  }
  return value;
}

/**
 * Free-text field: must be a non-empty string, truncated to `maxLength`
 * instead of rejected (a 9000-char model reply is still a valid event,
 * just a long one — the consumer sees the `...` marker).
 */
function requireText(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    fail(`AG-UI event field "${key}" must be a non-empty string.`);
  }
  return truncateAgUiString(value, maxLength);
}

/** Free-text field, optional: absent stays absent, present is truncated. */
function optionalText(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    fail(`AG-UI event field "${key}" must be a string when present.`);
  }
  return truncateAgUiString(value, maxLength);
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    fail(`AG-UI event field "${key}" must be a string when present.`);
  }
  if (value.length > maxLength) {
    fail(`AG-UI event field "${key}" is too long (max ${maxLength}).`);
  }
  return value;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`AG-UI event field "${key}" must be a finite number when present.`);
  }
  return value;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    fail(`AG-UI event field "${key}" must be a boolean when present.`);
  }
  return value;
}

/** Validate one state operation (STATE_DELTA payload). */
export function validateAgUiStateOperation(value: unknown): AgUiStateOperation {
  if (!isRecord(value)) fail('AG-UI state operation must be an object.');
  const op = value['op'];
  if (op !== 'set' && op !== 'delete' && op !== 'append') {
    fail('AG-UI state operation "op" must be "set", "delete" or "append".');
  }
  const path = value['path'];
  if (typeof path !== 'string' || path.length === 0 || path.length > 256) {
    fail('AG-UI state operation "path" must be a non-empty string (max 256).');
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(path) || path.startsWith('.') || path.endsWith('.')) {
    fail('AG-UI state operation "path" must be dot-separated identifiers.');
  }
  if (path.split('.').some((part) => part === '__proto__' || part === 'constructor' || part === 'prototype')) {
    fail('AG-UI state operation "path" must not touch prototype properties.');
  }
  if (op === 'delete' && value['value'] !== undefined) {
    fail('AG-UI state operation "delete" must not carry a value.');
  }
  const cloned = value['value'] === undefined ? undefined : cloneAgUiJson(value['value']);
  return {
    op,
    path,
    ...(cloned !== undefined ? { value: cloned } : {}),
  };
}

/**
 * Validate the `data` payload of one event type. Returns a cleaned copy
 * (strings truncated, secret keys dropped, unknown fields removed for
 * the strict types). Throws AgUiValidationError on a shape violation.
 */
export function validateAgUiEventData(
  type: AgUiEventType,
  data: unknown,
): Record<string, unknown> {
  if (!isRecord(data)) fail(`AG-UI event data for "${type}" must be an object.`);
  switch (type) {
    case 'RUN_STARTED': {
      return {
        ...(optionalText(data, 'title', 200) !== undefined
          ? { title: optionalText(data, 'title', 200) }
          : {}),
        ...(optionalString(data, 'providerId', 64) !== undefined
          ? { providerId: data['providerId'] }
          : {}),
        ...(optionalString(data, 'model', 128) !== undefined ? { model: data['model'] } : {}),
        ...(optionalNumber(data, 'toolCount') !== undefined
          ? { toolCount: Math.max(0, Math.floor(data['toolCount'] as number)) }
          : {}),
      };
    }
    case 'RUN_FINISHED': {
      const status = data['status'];
      if (status !== 'completed' && status !== 'stopped' && status !== 'failed' && status !== 'cancelled') {
        fail('AG-UI RUN_FINISHED "status" must be completed, stopped, failed or cancelled.');
      }
      return {
        status,
        ...(optionalText(data, 'finalText', AG_UI_MAX_TEXT_CHARS) !== undefined
          ? { finalText: optionalText(data, 'finalText', AG_UI_MAX_TEXT_CHARS) }
          : {}),
        ...(optionalNumber(data, 'steps') !== undefined
          ? { steps: Math.max(0, Math.floor(data['steps'] as number)) }
          : {}),
        ...(optionalNumber(data, 'toolCalls') !== undefined
          ? { toolCalls: Math.max(0, Math.floor(data['toolCalls'] as number)) }
          : {}),
        ...(optionalNumber(data, 'tokensUsed') !== undefined
          ? { tokensUsed: Math.max(0, Math.floor(data['tokensUsed'] as number)) }
          : {}),
        ...(optionalNumber(data, 'durationMs') !== undefined
          ? { durationMs: Math.max(0, Math.floor(data['durationMs'] as number)) }
          : {}),
      };
    }
    case 'RUN_ERROR': {
      const message = requireText(data, 'message', AG_UI_MAX_TEXT_CHARS);
      return {
        message,
        ...(optionalString(data, 'code', 64) !== undefined ? { code: data['code'] } : {}),
        ...(optionalBoolean(data, 'aborted') !== undefined ? { aborted: data['aborted'] } : {}),
      };
    }
    case 'TEXT_MESSAGE_START': {
      return {
        messageId: requireString(data, 'messageId', 128),
        ...(optionalString(data, 'role', 32) !== undefined ? { role: data['role'] } : {}),
      };
    }
    case 'TEXT_MESSAGE_CONTENT': {
      const delta = requireText(data, 'delta', AG_UI_MAX_TEXT_CHARS);
      return {
        messageId: requireString(data, 'messageId', 128),
        delta,
      };
    }
    case 'TEXT_MESSAGE_END': {
      return {
        messageId: requireString(data, 'messageId', 128),
        ...(optionalText(data, 'fullText', AG_UI_MAX_TEXT_CHARS) !== undefined
          ? { fullText: optionalText(data, 'fullText', AG_UI_MAX_TEXT_CHARS) }
          : {}),
      };
    }
    case 'TOOL_CALL_START': {
      return {
        toolCallId: requireString(data, 'toolCallId', 128),
        toolName: requireString(data, 'toolName', 128),
        ...(optionalNumber(data, 'step') !== undefined
          ? { step: Math.max(0, Math.floor(data['step'] as number)) }
          : {}),
      };
    }
    case 'TOOL_CALL_ARGS': {
      const argKeys = data['argKeys'];
      if (!Array.isArray(argKeys) || argKeys.some((k) => typeof k !== 'string')) {
        fail('AG-UI TOOL_CALL_ARGS "argKeys" must be an array of strings.');
      }
      if (argKeys.length > 64) fail('AG-UI TOOL_CALL_ARGS "argKeys" has too many entries.');
      for (const key of argKeys as string[]) {
        if (isSecretKeyName(key)) fail(`AG-UI TOOL_CALL_ARGS must not name a secret key: ${key}.`);
      }
      return {
        toolCallId: requireString(data, 'toolCallId', 128),
        toolName: requireString(data, 'toolName', 128),
        argKeys: [...(argKeys as string[])],
        ...(optionalText(data, 'argsJson', AG_UI_MAX_ARGS_CHARS) !== undefined
          ? { argsJson: optionalText(data, 'argsJson', AG_UI_MAX_ARGS_CHARS) }
          : {}),
        ...(optionalBoolean(data, 'complete') !== undefined ? { complete: data['complete'] } : {}),
      };
    }
    case 'TOOL_CALL_END': {
      const status = data['status'];
      if (status !== 'ok' && status !== 'error' && status !== 'denied') {
        fail('AG-UI TOOL_CALL_END "status" must be ok, error or denied.');
      }
      return {
        toolCallId: requireString(data, 'toolCallId', 128),
        toolName: requireString(data, 'toolName', 128),
        status,
        ...(optionalNumber(data, 'durationMs') !== undefined
          ? { durationMs: Math.max(0, Math.floor(data['durationMs'] as number)) }
          : {}),
      };
    }
    case 'TOOL_CALL_RESULT': {
      return {
        toolCallId: requireString(data, 'toolCallId', 128),
        toolName: requireString(data, 'toolName', 128),
        ok: (() => {
          if (typeof data['ok'] !== 'boolean') fail('AG-UI TOOL_CALL_RESULT "ok" must be a boolean.');
          return data['ok'] as boolean;
        })(),
        ...(optionalText(data, 'outputPreview', AG_UI_MAX_RESULT_CHARS) !== undefined
          ? { outputPreview: optionalText(data, 'outputPreview', AG_UI_MAX_RESULT_CHARS) }
          : {}),
      };
    }
    case 'STATE_SNAPSHOT': {
      const state = data['state'];
      if (!isRecord(state)) fail('AG-UI STATE_SNAPSHOT "state" must be an object.');
      const cloned = cloneAgUiJson(state);
      if (!isRecord(cloned)) fail('AG-UI STATE_SNAPSHOT "state" must clone to an object.');
      if (Object.keys(cloned).length > AG_UI_MAX_STATE_KEYS) {
        fail('AG-UI STATE_SNAPSHOT "state" has too many keys.');
      }
      return { state: cloned };
    }
    case 'STATE_DELTA': {
      const operations = data['operations'];
      if (!Array.isArray(operations) || operations.length === 0 || operations.length > 64) {
        fail('AG-UI STATE_DELTA "operations" must be a non-empty array (max 64).');
      }
      return {
        operations: operations.map((op) => validateAgUiStateOperation(op)),
        ...(optionalNumber(data, 'baseSequence') !== undefined
          ? { baseSequence: Math.max(0, Math.floor(data['baseSequence'] as number)) }
          : {}),
      };
    }
    case 'CUSTOM': {
      const name = requireString(data, 'name', 128);
      const value = data['value'];
      const cloned = value === undefined ? undefined : cloneAgUiJson(value);
      return {
        name,
        ...(cloned !== undefined && isRecord(cloned) ? { value: cloned } : {}),
      };
    }
    case 'GENERATIVE_UI': {
      // Shape is re-validated by genui.ts; here only the envelope fields
      // are checked so a malformed component never reaches the renderer.
      const componentId = requireString(data, 'componentId', 128);
      const kind = data['kind'];
      const known = ['confirm', 'options', 'form', 'table', 'progress', 'message'];
      if (typeof kind !== 'string' || !known.includes(kind)) {
        fail('AG-UI GENERATIVE_UI "kind" must be a known component kind.');
      }
      const title = requireText(data, 'title', 200);
      const props = data['props'];
      if (!isRecord(props)) fail('AG-UI GENERATIVE_UI "props" must be an object.');
      const cloned = cloneAgUiJson(props);
      if (!isRecord(cloned)) fail('AG-UI GENERATIVE_UI "props" must clone to an object.');
      const itemCount = countGenUiItems(cloned);
      if (itemCount > AG_UI_MAX_GENUI_ITEMS) {
        fail('AG-UI GENERATIVE_UI "props" carries too many items.');
      }
      return {
        componentId,
        kind,
        title: truncateAgUiString(title, 200),
        ...(optionalText(data, 'description', 1000) !== undefined
          ? { description: optionalText(data, 'description', 1000) }
          : {}),
        props: cloned,
        ...(optionalBoolean(data, 'blocking') !== undefined ? { blocking: data['blocking'] } : {}),
      };
    }
    case 'GENERATIVE_UI_RESPONSE': {
      const response = data['response'];
      if (!isRecord(response)) fail('AG-UI GENERATIVE_UI_RESPONSE "response" must be an object.');
      const cloned = cloneAgUiJson(response);
      if (!isRecord(cloned)) fail('AG-UI GENERATIVE_UI_RESPONSE "response" must clone to an object.');
      return {
        componentId: requireString(data, 'componentId', 128),
        response: cloned,
        ...(optionalString(data, 'action', 32) !== undefined ? { action: data['action'] } : {}),
      };
    }
    case 'ACTIVITY': {
      const kind = data['kind'];
      const known = [
        'planning',
        'thinking',
        'waiting-approval',
        'waiting-user',
        'compaction',
        'checkpoint',
        'routing',
        'subagent',
        'note',
      ];
      if (typeof kind !== 'string' || !known.includes(kind)) {
        fail('AG-UI ACTIVITY "kind" must be a known activity kind.');
      }
      const progress = optionalNumber(data, 'progress');
      if (progress !== undefined && (progress < 0 || progress > 1)) {
        fail('AG-UI ACTIVITY "progress" must be between 0 and 1.');
      }
      return {
        kind,
        label: requireText(data, 'label', 500),
        ...(optionalText(data, 'detail', 1000) !== undefined
          ? { detail: optionalText(data, 'detail', 1000) }
          : {}),
        ...(progress !== undefined ? { progress } : {}),
      };
    }
    default:
      fail(`Unknown AG-UI event type: ${String(type)}.`);
  }
}

function countGenUiItems(props: Record<string, unknown>): number {
  let count = 0;
  for (const key of ['options', 'rows', 'fields']) {
    const value = props[key];
    if (Array.isArray(value)) count += value.length;
  }
  return count;
}

/**
 * Validate a full AG-UI event envelope. Returns a cleaned copy with a
 * validated, truncated payload. `sequence`, when present, must be a
 * non-negative integer. Throws AgUiValidationError on any violation.
 */
export function validateAgUiEvent(value: unknown): AgUiEvent {
  if (!isRecord(value)) fail('AG-UI event must be an object.');
  if (value['protocol'] !== AG_UI_PROTOCOL_VERSION) {
    fail(`AG-UI event "protocol" must be "${AG_UI_PROTOCOL_VERSION}".`);
  }
  const type = value['type'];
  if (
    typeof type !== 'string' ||
    !(AG_UI_EVENT_TYPES as readonly string[]).includes(type)
  ) {
    fail('AG-UI event "type" must be one of the 16 standard types.');
  }
  const runId = requireString(value, 'runId', 128);
  const timestamp = value['timestamp'];
  if (typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) {
    fail('AG-UI event "timestamp" must be an ISO-8601 date string.');
  }
  const sequence = value['sequence'];
  if (
    sequence !== undefined &&
    (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 0)
  ) {
    fail('AG-UI event "sequence" must be a non-negative integer when present.');
  }
  const data = validateAgUiEventData(type as AgUiEventType, value['data']);
  return {
    protocol: AG_UI_PROTOCOL_VERSION,
    type: type as AgUiEventType,
    runId,
    ...(optionalString(value, 'botId', 128) !== undefined ? { botId: value['botId'] as string } : {}),
    ...(optionalString(value, 'threadId', 128) !== undefined
      ? { threadId: value['threadId'] as string }
      : {}),
    ...(optionalString(value, 'messageId', 128) !== undefined
      ? { messageId: value['messageId'] as string }
      : {}),
    ...(optionalString(value, 'toolCallId', 128) !== undefined
      ? { toolCallId: value['toolCallId'] as string }
      : {}),
    ...(sequence !== undefined ? { sequence: sequence as number } : {}),
    timestamp: timestamp as string,
    data,
  };
}

/** True when `value` passes full validation (never throws). */
export function isValidAgUiEvent(value: unknown): value is AgUiEvent {
  try {
    validateAgUiEvent(value);
    return true;
  } catch {
    return false;
  }
}

/** Validate an event filter (SSE query / bus subscribe filter). */
export function validateAgUiEventFilter(value: unknown): AgUiEventFilter {
  if (!isRecord(value)) fail('AG-UI event filter must be an object.');
  const types = value['types'];
  if (types !== undefined) {
    if (
      !Array.isArray(types) ||
      types.some(
        (t) => typeof t !== 'string' || !(AG_UI_EVENT_TYPES as readonly string[]).includes(t),
      )
    ) {
      fail('AG-UI event filter "types" must be an array of standard event types.');
    }
    if (types.length > AG_UI_EVENT_TYPES.length) fail('AG-UI event filter "types" is too long.');
  }
  const minSequence = value['minSequence'];
  if (
    minSequence !== undefined &&
    (typeof minSequence !== 'number' || !Number.isInteger(minSequence) || minSequence < 0)
  ) {
    fail('AG-UI event filter "minSequence" must be a non-negative integer when present.');
  }
  return {
    ...(optionalString(value, 'runId', 128) !== undefined ? { runId: value['runId'] as string } : {}),
    ...(optionalString(value, 'botId', 128) !== undefined ? { botId: value['botId'] as string } : {}),
    ...(optionalString(value, 'threadId', 128) !== undefined
      ? { threadId: value['threadId'] as string }
      : {}),
    ...(types !== undefined ? { types: [...(types as AgUiEventType[])] } : {}),
    ...(minSequence !== undefined ? { minSequence: minSequence as number } : {}),
  };
}
