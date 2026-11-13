/**
 * GenerativeUi — sandboxed renderer for AG-UI components (v0.97, Team T3).
 *
 * The agent asks for a component with a GENERATIVE_UI event; this
 * component renders it. The sandbox is the shape itself: only the six
 * allow-listed kinds render, only allow-listed fields are read, and
 * every string is rendered as React text — never as HTML, never
 * through `dangerouslySetInnerHTML`, never `eval`d. A prop that does
 * not match the expected shape renders as nothing for that field,
 * never as an error and never as code.
 *
 * Kinds:
 * - confirm: a yes/no card (blocking runs wait for the answer).
 * - options: pick one (or several) offered values.
 * - form: small typed fields (text / select / boolean).
 * - table: read-only columns + rows.
 * - progress: a progress bar (0..1).
 * - message: an informational card with a tone.
 *
 * Answers go back through `onAnswer(componentId, response, action)`;
 * the panel forwards them to main via IPC `agui:answer-component`.
 * Once answered, the card shows the recorded answer and its buttons
 * disable, so a component can never be answered twice from the UI.
 */
import { useState } from 'react';
import { useT } from '../../i18n/useT';

export interface GenerativeUiRequestView {
  componentId: string;
  kind: 'confirm' | 'options' | 'form' | 'table' | 'progress' | 'message';
  title: string;
  description?: string;
  props: Record<string, unknown>;
  blocking?: boolean;
  answered?: boolean;
  response?: Record<string, unknown>;
}

interface GenerativeUiProps {
  request: GenerativeUiRequestView;
  onAnswer: (componentId: string, response: Record<string, unknown>, action: string) => void;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function asOptionList(value: unknown): Array<{ value: string; label: string; hint?: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ value: string; label: string; hint?: string }> = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const optionValue = asString(record['value']);
    const label = asString(record['label']);
    if (!optionValue || !label) continue;
    out.push({
      value: optionValue,
      label,
      ...(asString(record['hint']) !== undefined ? { hint: asString(record['hint']) } : {}),
    });
  }
  return out;
}

interface FieldView {
  name: string;
  label: string;
  type: 'text' | 'select' | 'boolean';
  placeholder?: string;
  options?: string[];
  defaultValue?: string | boolean;
  required?: boolean;
}

function asFieldList(value: unknown): FieldView[] {
  if (!Array.isArray(value)) return [];
  const out: FieldView[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = asString(record['name']);
    const label = asString(record['label']);
    const type = record['type'];
    if (!name || !label || (type !== 'text' && type !== 'select' && type !== 'boolean')) continue;
    const field: FieldView = { name, label, type };
    if (asString(record['placeholder']) !== undefined) field.placeholder = asString(record['placeholder']);
    if (type === 'select') field.options = asStringList(record['options']);
    if (typeof record['defaultValue'] === 'string' || typeof record['defaultValue'] === 'boolean') {
      field.defaultValue = record['defaultValue'];
    }
    if (record['required'] === true) field.required = true;
    out.push(field);
  }
  return out;
}

function ConfirmCard({
  request,
  onAnswer,
}: GenerativeUiProps): React.ReactElement {
  const t = useT();
  const summary = asString(request.props['summary']);
  const confirmLabel = asString(request.props['confirmLabel']) ?? t('agui.genui.confirm');
  const dismissLabel = asString(request.props['dismissLabel']) ?? t('agui.genui.dismiss');
  return (
    <div>
      {summary ? <p>{summary}</p> : null}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button
          type="button"
          disabled={request.answered === true}
          onClick={() => onAnswer(request.componentId, { confirmed: true }, 'confirm')}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          disabled={request.answered === true}
          onClick={() => onAnswer(request.componentId, { confirmed: false }, 'dismiss')}
        >
          {dismissLabel}
        </button>
      </div>
    </div>
  );
}

function OptionsCard({
  request,
  onAnswer,
}: GenerativeUiProps): React.ReactElement {
  const t = useT();
  const options = asOptionList(request.props['options']);
  const multi = request.props['multi'] === true;
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (value: string): void => {
    if (request.answered === true) return;
    if (multi) {
      setSelected((prev) =>
        prev.includes(value) ? prev.filter((entry) => entry !== value) : [...prev, value],
      );
    } else {
      setSelected([value]);
    }
  };
  const submit = (): void => {
    if (selected.length === 0) return;
    onAnswer(
      request.componentId,
      { selected: multi ? selected : selected[0] },
      'submit',
    );
  };
  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {options.map((option) => {
          const active = selected.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              disabled={request.answered === true}
              aria-pressed={active}
              onClick={() => toggle(option.value)}
              style={{ textAlign: 'left', fontWeight: active ? 700 : 400 }}
            >
              {option.label}
              {option.hint ? <span> — {option.hint}</span> : null}
            </button>
          );
        })}
      </div>
      {options.length === 0 ? <p>{t('agui.genui.noOptions')}</p> : null}
      <button type="button" disabled={request.answered === true || selected.length === 0} onClick={submit}>
        {t('agui.genui.submit')}
      </button>
    </div>
  );
}

function FormCard({
  request,
  onAnswer,
}: GenerativeUiProps): React.ReactElement {
  const t = useT();
  const fields = asFieldList(request.props['fields']);
  const submitLabel = asString(request.props['submitLabel']) ?? t('agui.genui.submit');
  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    const initial: Record<string, string | boolean> = {};
    for (const field of fields) {
      if (field.defaultValue !== undefined) initial[field.name] = field.defaultValue;
      else if (field.type === 'boolean') initial[field.name] = false;
      else initial[field.name] = '';
    }
    return initial;
  });
  const [error, setError] = useState<string | null>(null);
  const submit = (): void => {
    for (const field of fields) {
      if (field.required === true) {
        const value = values[field.name];
        if (value === undefined || value === '') {
          setError(t('agui.genui.required'));
          return;
        }
      }
    }
    setError(null);
    onAnswer(request.componentId, { ...values }, 'submit');
  };
  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {fields.map((field) => (
          <label key={field.name} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>
              {field.label}
              {field.required === true ? ' *' : ''}
            </span>
            {field.type === 'select' ? (
              <select
                disabled={request.answered === true}
                value={typeof values[field.name] === 'string' ? (values[field.name] as string) : ''}
                onChange={(event) => setValues((prev) => ({ ...prev, [field.name]: event.target.value }))}
              >
                <option value="">{t('agui.genui.selectOption')}</option>
                {(field.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : field.type === 'boolean' ? (
              <input
                type="checkbox"
                disabled={request.answered === true}
                checked={values[field.name] === true}
                onChange={(event) => setValues((prev) => ({ ...prev, [field.name]: event.target.checked }))}
              />
            ) : (
              <input
                type="text"
                disabled={request.answered === true}
                placeholder={field.placeholder}
                value={typeof values[field.name] === 'string' ? (values[field.name] as string) : ''}
                onChange={(event) => setValues((prev) => ({ ...prev, [field.name]: event.target.value }))}
              />
            )}
          </label>
        ))}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <button type="button" disabled={request.answered === true} onClick={submit}>
        {submitLabel}
      </button>
    </div>
  );
}

function TableCard({ request }: GenerativeUiProps): React.ReactElement {
  const columnsRaw = request.props['columns'];
  const rowsRaw = request.props['rows'];
  const columns: Array<{ key: string; label: string }> = Array.isArray(columnsRaw)
    ? columnsRaw
        .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
        .map((entry) => ({
          key: asString(entry['key']) ?? '',
          label: asString(entry['label']) ?? '',
        }))
        .filter((column) => column.key.length > 0)
    : [];
  const rows: Array<Record<string, unknown>> = Array.isArray(rowsRaw)
    ? rowsRaw.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    : [];
  return (
    <div style={{ overflowX: 'auto' }}>
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => {
                const value = row[column.key];
                return (
                  <td key={column.key}>
                    {typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
                      ? String(value)
                      : ''}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProgressCard({ request }: GenerativeUiProps): React.ReactElement {
  const value = typeof request.props['value'] === 'number' ? request.props['value'] : 0;
  const clamped = Math.min(1, Math.max(0, value));
  const label = asString(request.props['label']);
  return (
    <div>
      {label ? <p>{label}</p> : null}
      <div role="progressbar" aria-valuenow={Math.round(clamped * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div style={{ width: `${Math.round(clamped * 100)}%` }} />
      </div>
      <span>{Math.round(clamped * 100)}%</span>
    </div>
  );
}

function MessageCard({ request }: GenerativeUiProps): React.ReactElement {
  const body = asString(request.props['body']) ?? '';
  const tone = asString(request.props['tone']) ?? 'info';
  return (
    <div data-tone={tone}>
      <p>{body}</p>
    </div>
  );
}

export default function GenerativeUi({ request, onAnswer }: GenerativeUiProps): React.ReactElement {
  const t = useT();
  return (
    <section aria-label={request.title}>
      <header>
        <strong>{request.title}</strong>
        {request.blocking === true ? <span> · {t('agui.genui.blocking')}</span> : null}
        {request.answered === true ? <span> · {t('agui.genui.answered')}</span> : null}
      </header>
      {request.description ? <p>{request.description}</p> : null}
      {request.kind === 'confirm' ? (
        <ConfirmCard request={request} onAnswer={onAnswer} />
      ) : request.kind === 'options' ? (
        <OptionsCard request={request} onAnswer={onAnswer} />
      ) : request.kind === 'form' ? (
        <FormCard request={request} onAnswer={onAnswer} />
      ) : request.kind === 'table' ? (
        <TableCard request={request} onAnswer={onAnswer} />
      ) : request.kind === 'progress' ? (
        <ProgressCard request={request} onAnswer={onAnswer} />
      ) : (
        <MessageCard request={request} onAnswer={onAnswer} />
      )}
      {request.answered === true && request.response ? (
        <p>
          {t('agui.genui.answered')}: {JSON.stringify(request.response)}
        </p>
      ) : null}
    </section>
  );
}
