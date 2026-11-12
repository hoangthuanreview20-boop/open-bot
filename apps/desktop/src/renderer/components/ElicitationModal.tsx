import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Elicitation modal (MCP 2025-11-25, v0.13) — shown when an MCP server
 * sends `elicitation/create` mid-tool-call and needs the user.
 *
 * Follows the ApprovalCard / AskUserCard pattern: a card in the chat
 * column (class "approval", role "alert"), all display strings through
 * `t()` — never hard-coded here. The field definitions come from the
 * server's JSON Schema (already parsed by `mcp/elicitation.ts` in core),
 * so this component only renders and collects values.
 *
 * Two modes:
 *  - form: render one input per schema field (text / select for enums /
 *    number / checkbox / checkbox group for multi-select enums), prefilled
 *    from field defaults, then send the filled object back.
 *  - url: show the out-of-band link (login / payment / verification) and
 *    let the user confirm once they finished on the website.
 *
 * The main process wires this through the `chat:elicitation-needed` IPC
 * channel (same shape as `chat:ask-user`); until that lands, App.tsx
 * subscribes defensively (see App.tsx).
 */

/** One form field, as parsed from the server's requestedSchema. */
export interface ElicitationFieldView {
  name: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'string-array';
  title?: string;
  description?: string;
  required: boolean;
  enum?: string[];
  default?: string | number | boolean | string[];
}

/** One elicitation request, as the renderer receives it from main. */
export interface ElicitationRequestView {
  botId: string;
  elicitationId: string;
  serverName: string;
  message: string;
  mode: 'form' | 'url';
  url?: string;
  fields?: ElicitationFieldView[];
}

/** Result sent back to main (and on to the MCP server). */
export interface ElicitationResultView {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}

interface Props {
  request: ElicitationRequestView;
  onRespond: (elicitationId: string, result: ElicitationResultView) => void;
}

function initialValues(fields: ElicitationFieldView[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.default !== undefined) values[field.name] = field.default;
    else if (field.type === 'string-array') values[field.name] = [];
    else if (field.type === 'boolean') values[field.name] = false;
  }
  return values;
}

function labelOf(field: ElicitationFieldView): string {
  return field.title ?? field.name;
}

export default function ElicitationModal({ request, onRespond }: Props) {
  const t = useT();
  const fields = request.mode === 'form' ? request.fields ?? [] : [];
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues(fields));
  const [error, setError] = useState('');

  const setValue = (name: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  };

  const toggleMulti = (field: ElicitationFieldView, option: string) => {
    const current = Array.isArray(values[field.name]) ? [...(values[field.name] as string[])] : [];
    const i = current.indexOf(option);
    if (i === -1) current.push(option);
    else current.splice(i, 1);
    setValue(field.name, current);
  };

  const submitForm = () => {
    const content: Record<string, unknown> = {};
    for (const field of fields) {
      const raw = values[field.name];
      const empty =
        raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0);
      if (empty) {
        if (field.required) {
          setError(`${labelOf(field)}: ${t('elicitation.requiredField')}`);
          return;
        }
        continue;
      }
      if (field.type === 'number' || field.type === 'integer') {
        const num = typeof raw === 'number' ? raw : Number(String(raw).trim());
        if (!Number.isFinite(num) || (field.type === 'integer' && !Number.isInteger(num))) {
          setError(`${labelOf(field)}: ${t('elicitation.invalidNumber')}`);
          return;
        }
        content[field.name] = num;
        continue;
      }
      if (field.type === 'boolean') {
        content[field.name] = raw === true;
        continue;
      }
      if (field.type === 'string-array') {
        if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string')) {
          setError(`${labelOf(field)}: ${t('elicitation.invalidValue')}`);
          return;
        }
        content[field.name] = [...(raw as string[])];
        continue;
      }
      content[field.name] = raw;
    }
    setError('');
    onRespond(request.elicitationId, { action: 'accept', content });
  };

  return (
    <div className="approval" role="alert">
      <h3>{t('elicitation.title')}</h3>
      <p className="hint" style={{ margin: '0 0 6px' }}>
        {t('elicitation.fromServer', { server: request.serverName })}
      </p>
      <p style={{ margin: '0 0 10px' }}>{request.message}</p>

      {request.mode === 'url' ? (
        <>
          {request.url && (
            <p style={{ margin: '0 0 10px' }}>
              <a className="btn" href={request.url} target="_blank" rel="noreferrer">
                {t('elicitation.openUrl')}
              </a>
            </p>
          )}
          <p className="hint" style={{ margin: '0 0 10px' }}>
            {t('elicitation.urlHint')}
          </p>
          <div className="row">
            <button className="btn ok" onClick={() => onRespond(request.elicitationId, { action: 'accept' })}>
              {t('elicitation.urlDone')}
            </button>
            <button className="btn danger" onClick={() => onRespond(request.elicitationId, { action: 'decline' })}>
              {t('elicitation.decline')}
            </button>
            <button className="btn secondary" onClick={() => onRespond(request.elicitationId, { action: 'cancel' })}>
              {t('elicitation.cancel')}
            </button>
          </div>
        </>
      ) : (
        <>
          {fields.map((field) => (
            <div key={field.name} style={{ margin: '0 0 10px' }}>
              <label style={{ display: 'block', fontSize: 13, marginBottom: 4 }}>
                {labelOf(field)}
                {field.required ? ' *' : ` (${t('elicitation.optional')})`}
              </label>
              {field.description && (
                <p className="hint" style={{ margin: '0 0 4px' }}>{field.description}</p>
              )}
              {field.type === 'boolean' ? (
                <input
                  type="checkbox"
                  checked={values[field.name] === true}
                  onChange={(e) => setValue(field.name, e.target.checked)}
                />
              ) : field.type === 'string' && field.enum ? (
                <select
                  value={typeof values[field.name] === 'string' ? (values[field.name] as string) : ''}
                  onChange={(e) => setValue(field.name, e.target.value)}
                  style={{ width: '100%', boxSizing: 'border-box' }}
                >
                  <option value="">{t('elicitation.selectPlaceholder')}</option>
                  {field.enum.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              ) : field.type === 'string-array' && field.enum ? (
                <div className="row wrap">
                  {field.enum.map((opt) => {
                    const selected = Array.isArray(values[field.name]) && (values[field.name] as string[]).includes(opt);
                    return (
                      <label key={opt} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 13 }}>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleMulti(field, opt)}
                        />
                        {opt}
                      </label>
                    );
                  })}
                </div>
              ) : field.type === 'number' || field.type === 'integer' ? (
                <input
                  type="number"
                  step={field.type === 'integer' ? 1 : 'any'}
                  value={
                    values[field.name] === undefined ? '' : String(values[field.name] as string | number)
                  }
                  onChange={(e) => setValue(field.name, e.target.value)}
                  style={{ width: '100%', boxSizing: 'border-box' }}
                />
              ) : (
                <input
                  type="text"
                  value={typeof values[field.name] === 'string' ? (values[field.name] as string) : ''}
                  onChange={(e) => setValue(field.name, e.target.value)}
                  style={{ width: '100%', boxSizing: 'border-box' }}
                />
              )}
            </div>
          ))}
          {error && (
            <p style={{ margin: '0 0 10px', color: '#c0392b', fontSize: 12 }}>{error}</p>
          )}
          <div className="row">
            <button className="btn ok" onClick={submitForm}>{t('elicitation.submit')}</button>
            <button className="btn danger" onClick={() => onRespond(request.elicitationId, { action: 'decline' })}>
              {t('elicitation.decline')}
            </button>
            <button className="btn secondary" onClick={() => onRespond(request.elicitationId, { action: 'cancel' })}>
              {t('elicitation.cancel')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
