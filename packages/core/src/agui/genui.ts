/**
 * Generative UI — component registry + validation (v0.97, Team T3).
 *
 * The agent asks the renderer to show an interactive component by
 * emitting a GENERATIVE_UI event; the user answers it and the renderer
 * emits GENERATIVE_UI_RESPONSE. This module is the contract between
 * the two sides:
 *
 * - Six component kinds, each with a strict props shape. Anything
 *   outside the shape is rejected here, before it reaches a renderer.
 * - Components are DATA ONLY: no HTML strings, no scripts, no URLs
 *   except plain `https://` links in table cells, no code execution.
 *   The renderer renders from the validated shape with normal React
 *   elements; there is no `dangerouslySetInnerHTML`, no `eval`, no
 *   dynamic component loading. A component that tries to smuggle
 *   markup in a label is rendered as plain text.
 * - A component instance has a lifecycle: `requested` -> `answered` /
 *   `dismissed` / `expired`. The registry tracks pending components
 *   per run so the agent (or a later event) can tell whether the user
 *   already answered, and so a stale component cannot be answered
 *   twice.
 * - Blocking components pause the run (the loop waits for the
 *   response); non-blocking ones are informational and the run
 *   continues. The registry does not implement the waiting itself —
 *   the loop owns that — it only records the request and the answer.
 *
 * Sandboxing note: the "sandbox" here is the shape itself. The
 * renderer never executes anything from an event; it only renders
 * allow-listed fields as text / buttons / inputs. That is the whole
 * point of A2UI-style declarative UI, and it is why this module is
 * strict about rejecting anything it does not understand.
 */

import { AG_UI_MAX_GENUI_ITEMS } from './types';
import type { AgUiComponentKind, AgUiGenerativeUiData } from './types';
import { cloneAgUiJson } from './validate';

/** A single option in an `options` component. */
export interface AgUiOption {
  /** Value sent back in the response. */
  value: string;
  /** Label shown to the user. */
  label: string;
  /** Optional one-line hint shown under the label. */
  hint?: string;
}

/** A single field in a `form` component. */
export interface AgUiFormField {
  /** Field name, used as the response key. */
  name: string;
  /** Label shown next to the field. */
  label: string;
  /** Field type — `text` is a one-line input, `select` a dropdown. */
  type: 'text' | 'select' | 'boolean';
  /** Placeholder shown inside an empty text input. */
  placeholder?: string;
  /** Options for a `select` field (required when type is `select`). */
  options?: string[];
  /** Default value (string for text/select, boolean for boolean). */
  defaultValue?: string | boolean;
  /** True when the user must fill this field before submitting. */
  required?: boolean;
}

/** One column of a `table` component. */
export interface AgUiTableColumn {
  /** Key into each row object. */
  key: string;
  /** Header label shown in the table head. */
  label: string;
}

/** Validated props of a `confirm` component. */
export interface AgUiConfirmProps {
  /** Text of the confirm button (default: the renderer's locale string). */
  confirmLabel?: string;
  /** Text of the dismiss button. */
  dismissLabel?: string;
  /** Short summary of what confirming will do. */
  summary?: string;
}

/** Validated props of an `options` component. */
export interface AgUiOptionsProps {
  options: AgUiOption[];
  /** True when the user may pick more than one option. */
  multi?: boolean;
}

/** Validated props of a `form` component. */
export interface AgUiFormProps {
  fields: AgUiFormField[];
  /** Text of the submit button. */
  submitLabel?: string;
}

/** Validated props of a `table` component. */
export interface AgUiTableProps {
  columns: AgUiTableColumn[];
  rows: Array<Record<string, string | number | boolean>>;
}

/** Validated props of a `progress` component. */
export interface AgUiProgressProps {
  /** 0..1 fraction done. */
  value: number;
  /** Label shown next to the bar. */
  label?: string;
}

/** Validated props of a `message` component. */
export interface AgUiMessageProps {
  /** Body text of the message card. */
  body: string;
  /** Visual tone of the card. */
  tone?: 'info' | 'success' | 'warning' | 'error';
}

export type AgUiComponentProps =
  | AgUiConfirmProps
  | AgUiOptionsProps
  | AgUiFormProps
  | AgUiTableProps
  | AgUiProgressProps
  | AgUiMessageProps;

/** A validated generative-UI request, ready for the renderer. */
export interface AgUiComponentRequest {
  componentId: string;
  kind: AgUiComponentKind;
  title: string;
  description?: string;
  props: AgUiComponentProps;
  blocking?: boolean;
  runId: string;
  botId?: string;
}

/** Lifecycle state of one component instance. */
export type AgUiComponentStatus = 'requested' | 'answered' | 'dismissed' | 'expired';

/** One tracked component instance, with its answer when present. */
export interface AgUiComponentRecord {
  request: AgUiComponentRequest;
  status: AgUiComponentStatus;
  requestedAt: string;
  /** The user's response, once answered. */
  response?: Record<string, unknown>;
  /** Action the user took (`confirm`, `dismiss`, `submit`, ...). */
  action?: string;
  answeredAt?: string;
}

export class AgUiGenUiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgUiGenUiError';
  }
}

function fail(message: string): never {
  throw new AgUiGenUiError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireLabel(value: unknown, what: string, max = 200): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`Generative UI ${what} must be a non-empty string.`);
  }
  if (value.length > max) fail(`Generative UI ${what} is too long (max ${max}).`);
  if (/javascript:/i.test(value) || /<script/i.test(value)) {
    fail(`Generative UI ${what} must not contain scripts or javascript: URLs.`);
  }
  return value;
}

function optionalLabel(value: unknown, what: string, max = 200): string | undefined {
  if (value === undefined) return undefined;
  return requireLabel(value, what, max);
}

function validateOptions(props: Record<string, unknown>): AgUiOptionsProps {
  const raw = props['options'];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > AG_UI_MAX_GENUI_ITEMS) {
    fail('Generative UI "options" must be a non-empty array (max 50).');
  }
  const seen = new Set<string>();
  const options: AgUiOption[] = raw.map((item, index) => {
    if (!isRecord(item)) fail(`Generative UI option #${index} must be an object.`);
    const value = requireLabel(item['value'], `option #${index} "value"`, 128);
    const label = requireLabel(item['label'], `option #${index} "label"`, 200);
    if (seen.has(value)) fail(`Generative UI options must not repeat value "${value}".`);
    seen.add(value);
    return {
      value,
      label,
      ...(optionalLabel(item['hint'], `option #${index} "hint"`, 200) !== undefined
        ? { hint: item['hint'] as string }
        : {}),
    };
  });
  const multi = props['multi'];
  if (multi !== undefined && typeof multi !== 'boolean') {
    fail('Generative UI "multi" must be a boolean when present.');
  }
  return { options, ...(multi === true ? { multi: true } : {}) };
}

function validateForm(props: Record<string, unknown>): AgUiFormProps {
  const raw = props['fields'];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > AG_UI_MAX_GENUI_ITEMS) {
    fail('Generative UI "fields" must be a non-empty array (max 50).');
  }
  const seen = new Set<string>();
  const fields: AgUiFormField[] = raw.map((item, index) => {
    if (!isRecord(item)) fail(`Generative UI field #${index} must be an object.`);
    const name = requireLabel(item['name'], `field #${index} "name"`, 64);
    if (!/^[A-Za-z0-9_]+$/.test(name)) {
      fail(`Generative UI field name "${name}" must be letters, digits or underscore.`);
    }
    if (seen.has(name)) fail(`Generative UI fields must not repeat name "${name}".`);
    seen.add(name);
    const label = requireLabel(item['label'], `field #${index} "label"`, 200);
    const type = item['type'];
    if (type !== 'text' && type !== 'select' && type !== 'boolean') {
      fail('Generative UI field "type" must be text, select or boolean.');
    }
    const field: AgUiFormField = { name, label, type };
    if (item['placeholder'] !== undefined) {
      field.placeholder = requireLabel(item['placeholder'], `field #${index} "placeholder"`, 200);
    }
    if (type === 'select') {
      const options = item['options'];
      if (!Array.isArray(options) || options.length === 0 || options.length > 50) {
        fail('Generative UI select field needs a non-empty "options" array (max 50).');
      }
      if (options.some((o) => typeof o !== 'string' || o.length === 0)) {
        fail('Generative UI select "options" must be non-empty strings.');
      }
      field.options = [...(options as string[])];
    }
    if (item['defaultValue'] !== undefined) {
      const dv = item['defaultValue'];
      if (type === 'boolean' && typeof dv !== 'boolean') {
        fail('Generative UI boolean field "defaultValue" must be a boolean.');
      }
      if (type !== 'boolean' && typeof dv !== 'string') {
        fail('Generative UI field "defaultValue" must be a string.');
      }
      field.defaultValue = dv as string | boolean;
    }
    if (item['required'] !== undefined) {
      if (typeof item['required'] !== 'boolean') {
        fail('Generative UI field "required" must be a boolean when present.');
      }
      if (item['required'] === true) field.required = true;
    }
    return field;
  });
  return {
    fields,
    ...(optionalLabel(props['submitLabel'], '"submitLabel"', 100) !== undefined
      ? { submitLabel: props['submitLabel'] as string }
      : {}),
  };
}

function validateTable(props: Record<string, unknown>): AgUiTableProps {
  const columnsRaw = props['columns'];
  if (!Array.isArray(columnsRaw) || columnsRaw.length === 0 || columnsRaw.length > 20) {
    fail('Generative UI "columns" must be a non-empty array (max 20).');
  }
  const columns: AgUiTableColumn[] = columnsRaw.map((item, index) => {
    if (!isRecord(item)) fail(`Generative UI column #${index} must be an object.`);
    return {
      key: requireLabel(item['key'], `column #${index} "key"`, 64),
      label: requireLabel(item['label'], `column #${index} "label"`, 200),
    };
  });
  const keys = new Set(columns.map((c) => c.key));
  if (keys.size !== columns.length) fail('Generative UI table columns must have unique keys.');
  const rowsRaw = props['rows'];
  if (!Array.isArray(rowsRaw) || rowsRaw.length > AG_UI_MAX_GENUI_ITEMS) {
    fail('Generative UI "rows" must be an array (max 50).');
  }
  const rows: Array<Record<string, string | number | boolean>> = rowsRaw.map((item, index) => {
    if (!isRecord(item)) fail(`Generative UI row #${index} must be an object.`);
    const row: Record<string, string | number | boolean> = {};
    for (const column of columns) {
      const value = item[column.key];
      if (value === undefined) continue;
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        fail(`Generative UI row #${index} value for "${column.key}" must be a string, number or boolean.`);
      }
      if (typeof value === 'string' && value.length > 500) {
        fail(`Generative UI row #${index} value for "${column.key}" is too long.`);
      }
      row[column.key] = value;
    }
    return row;
  });
  return { columns, rows };
}

function validateProgress(props: Record<string, unknown>): AgUiProgressProps {
  const value = props['value'];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    fail('Generative UI progress "value" must be a number between 0 and 1.');
  }
  return {
    value,
    ...(optionalLabel(props['label'], 'progress "label"', 200) !== undefined
      ? { label: props['label'] as string }
      : {}),
  };
}

function validateMessage(props: Record<string, unknown>): AgUiMessageProps {
  const body = requireLabel(props['body'], 'message "body"', 2000);
  const tone = props['tone'];
  if (tone !== undefined && tone !== 'info' && tone !== 'success' && tone !== 'warning' && tone !== 'error') {
    fail('Generative UI message "tone" must be info, success, warning or error.');
  }
  return { body, ...(tone !== undefined ? { tone: tone as AgUiMessageProps['tone'] } : {}) };
}

function validateConfirm(props: Record<string, unknown>): AgUiConfirmProps {
  return {
    ...(optionalLabel(props['confirmLabel'], 'confirm "confirmLabel"', 100) !== undefined
      ? { confirmLabel: props['confirmLabel'] as string }
      : {}),
    ...(optionalLabel(props['dismissLabel'], 'confirm "dismissLabel"', 100) !== undefined
      ? { dismissLabel: props['dismissLabel'] as string }
      : {}),
    ...(optionalLabel(props['summary'], 'confirm "summary"', 1000) !== undefined
      ? { summary: props['summary'] as string }
      : {}),
  };
}

/**
 * Validate a GENERATIVE_UI event payload into a renderer-ready request.
 * Throws AgUiGenUiError on any shape violation. `props` are cloned
 * through the JSON sanitiser first, so secret keys and over-long
 * strings never reach this point.
 */
export function validateGenerativeUiRequest(
  data: AgUiGenerativeUiData & Record<string, unknown>,
  runId: string,
  botId?: string,
): AgUiComponentRequest {
  const componentId = data['componentId'];
  if (typeof componentId !== 'string' || componentId.length === 0 || componentId.length > 128) {
    fail('Generative UI "componentId" must be a non-empty string (max 128).');
  }
  const kind = data['kind'] as AgUiComponentKind;
  const known: AgUiComponentKind[] = ['confirm', 'options', 'form', 'table', 'progress', 'message'];
  if (!known.includes(kind)) fail('Generative UI "kind" must be a known component kind.');
  const title = requireLabel(data['title'], '"title"', 200);
  const description = optionalLabel(data['description'], '"description"', 1000);
  const rawProps = data['props'];
  if (!isRecord(rawProps)) fail('Generative UI "props" must be an object.');
  const cloned = cloneAgUiJson(rawProps);
  if (!isRecord(cloned)) fail('Generative UI "props" must clone to an object.');
  let props: AgUiComponentProps;
  switch (kind) {
    case 'confirm':
      props = validateConfirm(cloned);
      break;
    case 'options':
      props = validateOptions(cloned);
      break;
    case 'form':
      props = validateForm(cloned);
      break;
    case 'table':
      props = validateTable(cloned);
      break;
    case 'progress':
      props = validateProgress(cloned);
      break;
    case 'message':
      props = validateMessage(cloned);
      break;
    default:
      fail(`Generative UI kind "${String(kind)}" is not supported.`);
  }
  const blocking = data['blocking'];
  if (blocking !== undefined && typeof blocking !== 'boolean') {
    fail('Generative UI "blocking" must be a boolean when present.');
  }
  return {
    componentId,
    kind,
    title,
    ...(description !== undefined ? { description } : {}),
    props,
    ...(blocking === true ? { blocking: true } : {}),
    runId,
    ...(botId !== undefined ? { botId } : {}),
  };
}

/** Validate a GENERATIVE_UI_RESPONSE payload for one component. */
export function validateGenerativeUiResponse(
  data: Record<string, unknown>,
  request: AgUiComponentRequest,
): { response: Record<string, unknown>; action?: string } {
  const componentId = data['componentId'];
  if (componentId !== request.componentId) {
    fail('Generative UI response "componentId" does not match the pending component.');
  }
  const responseRaw = data['response'];
  if (!isRecord(responseRaw)) fail('Generative UI response "response" must be an object.');
  const cloned = cloneAgUiJson(responseRaw);
  if (!isRecord(cloned)) fail('Generative UI response "response" must clone to an object.');
  const action = data['action'];
  if (action !== undefined && (typeof action !== 'string' || action.length > 32)) {
    fail('Generative UI response "action" must be a short string when present.');
  }
  // Per-kind response shape checks.
  switch (request.kind) {
    case 'confirm': {
      if (typeof cloned['confirmed'] !== 'boolean') {
        fail('Generative UI confirm response needs a boolean "confirmed".');
      }
      break;
    }
    case 'options': {
      const selected = cloned['selected'];
      const multi = (request.props as AgUiOptionsProps).multi === true;
      const allowed = new Set((request.props as AgUiOptionsProps).options.map((o) => o.value));
      if (multi) {
        if (!Array.isArray(selected) || selected.some((v) => typeof v !== 'string' || !allowed.has(v))) {
          fail('Generative UI options response "selected" must be an array of offered values.');
        }
      } else if (typeof selected !== 'string' || !allowed.has(selected)) {
        fail('Generative UI options response "selected" must be one of the offered values.');
      }
      break;
    }
    case 'form': {
      const fields = (request.props as AgUiFormProps).fields;
      for (const field of fields) {
        const value = cloned[field.name];
        if (field.required === true && (value === undefined || value === '')) {
          fail(`Generative UI form response is missing required field "${field.name}".`);
        }
        if (value !== undefined) {
          if (field.type === 'boolean' && typeof value !== 'boolean') {
            fail(`Generative UI form field "${field.name}" must be a boolean.`);
          }
          if (field.type !== 'boolean' && typeof value !== 'string') {
            fail(`Generative UI form field "${field.name}" must be a string.`);
          }
          if (field.type === 'select' && typeof value === 'string' && field.options && !field.options.includes(value)) {
            fail(`Generative UI form field "${field.name}" must be one of its options.`);
          }
        }
      }
      break;
    }
    default:
      break;
  }
  return {
    response: cloned,
    ...(action !== undefined ? { action: action as string } : {}),
  };
}

/**
 * Registry of pending generative-UI components, per run. The renderer
 * (and the SSE layer) reads pending components from here; the loop
 * answers them through `answer()`. Expired components (older than the
 * TTL, default 10 minutes) are answered as `dismissed` by `expire()`
 * so a run never waits forever on a component the user closed.
 */
export class AgUiGenerativeUiRegistry {
  private readonly components = new Map<string, AgUiComponentRecord>();
  private readonly ttlMs: number;

  constructor(opts?: { ttlMs?: number }) {
    this.ttlMs = opts?.ttlMs !== undefined && opts.ttlMs > 0 ? opts.ttlMs : 10 * 60_000;
  }

  /** Number of components ever registered (including answered ones). */
  get size(): number {
    return this.components.size;
  }

  /** Register a validated request as pending. Re-registering the same id replaces it. */
  request(request: AgUiComponentRequest): AgUiComponentRecord {
    const record: AgUiComponentRecord = {
      request,
      status: 'requested',
      requestedAt: new Date().toISOString(),
    };
    this.components.set(request.componentId, record);
    return record;
  }

  /** Pending (unanswered, unexpired) components of a run, oldest first. */
  pendingForRun(runId: string): AgUiComponentRecord[] {
    return [...this.components.values()]
      .filter((c) => c.request.runId === runId && c.status === 'requested')
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  /** All components of a run (any status), oldest first. */
  forRun(runId: string): AgUiComponentRecord[] {
    return [...this.components.values()]
      .filter((c) => c.request.runId === runId)
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  /** Look up one component by id. */
  get(componentId: string): AgUiComponentRecord | undefined {
    return this.components.get(componentId);
  }

  /**
   * Answer a pending component. Validates the response against the
   * request shape; a second answer to the same component is rejected.
   * Returns the updated record.
   */
  answer(
    componentId: string,
    data: Record<string, unknown>,
  ): AgUiComponentRecord {
    const record = this.components.get(componentId);
    if (!record) fail(`No generative UI component with id "${componentId}".`);
    if (record.status !== 'requested') {
      fail(`Generative UI component "${componentId}" is already ${record.status}.`);
    }
    const validated = validateGenerativeUiResponse(data, record.request);
    record.status = validated.action === 'dismiss' ? 'dismissed' : 'answered';
    record.response = validated.response;
    if (validated.action !== undefined) record.action = validated.action;
    record.answeredAt = new Date().toISOString();
    return record;
  }

  /** Dismiss a pending component without an answer (user closed it). */
  dismiss(componentId: string): AgUiComponentRecord {
    const record = this.components.get(componentId);
    if (!record) fail(`No generative UI component with id "${componentId}".`);
    if (record.status !== 'requested') {
      fail(`Generative UI component "${componentId}" is already ${record.status}.`);
    }
    record.status = 'dismissed';
    record.action = 'dismiss';
    record.answeredAt = new Date().toISOString();
    return record;
  }

  /**
   * Expire pending components older than the TTL. Returns the expired
   * records (now `expired`, so a waiting run can continue with a
   * "no answer" outcome instead of hanging).
   */
  expire(now = Date.now()): AgUiComponentRecord[] {
    const expired: AgUiComponentRecord[] = [];
    for (const record of this.components.values()) {
      if (record.status !== 'requested') continue;
      if (now - Date.parse(record.requestedAt) > this.ttlMs) {
        record.status = 'expired';
        record.action = 'expired';
        record.answeredAt = new Date().toISOString();
        expired.push(record);
      }
    }
    return expired;
  }

  /** Forget answered/dismissed/expired components of one run. */
  clearRun(runId: string): void {
    for (const [id, record] of [...this.components.entries()]) {
      if (record.request.runId === runId && record.status !== 'requested') {
        this.components.delete(id);
      }
    }
  }

  /** Forget everything. */
  clearAll(): void {
    this.components.clear();
  }
}
