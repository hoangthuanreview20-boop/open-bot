import { useState } from 'react';
import type { ApprovalRequest } from '../types';
import { useT } from '../i18n/useT';

interface Props {
  approval: ApprovalRequest;
  /** Display name of the bot (App looks it up from the bot list). */
  botName?: string;
  onRespond: (
    callId: string,
    approved: boolean,
    args?: Record<string, unknown>,
    allowAlways?: boolean,
  ) => void;
}

/** Keys that hold secrets — their values never appear on the card. */
const SECRET_KEY_RE = /api[_-]?key|token|secret|password|passwd|auth|bearer|private[_-]?key/i;

/** Mask secrets in args when the coordinator sent no argsSummary (renderer fallback). */
function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? '<redacted>' : maskSecrets(v);
    }
    return out;
  }
  return value;
}

function fallbackArgsSummary(args: Record<string, unknown>): string {
  let text: string;
  try {
    text = JSON.stringify(maskSecrets(args));
  } catch {
    text = '{}';
  }
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

/**
 * In-chat approval card (M8): when the agent needs a tool call approved
 * it shows an Allow/Deny card instead of a dialog. The card shows the
 * tool name, the reason, and redacted summarized args (secrets redacted
 * in the coordinator), with Allow once / Allow always (only this tool,
 * only this bot — creates a bot-scoped auto-approve rule) / Deny.
 * Editing args (JSON) hides behind a disclosure toggle (progressive
 * disclosure) so the default card stays airy.
 */
export default function ApprovalCard({ approval, botName, onRespond }: Props) {
  const t = useT();
  const toolName = String(approval.call.name ?? approval.call.tool ?? t('chat.unknownTool'));
  const botLabel = botName ?? approval.botId;
  const argsSummary = approval.argsSummary ?? fallbackArgsSummary(
    (approval.call.args ?? approval.call.arguments ?? {}) as Record<string, unknown>,
  );
  const initialArgs = JSON.stringify(approval.call.args ?? approval.call.arguments ?? {}, null, 2);
  const [argsText, setArgsText] = useState(initialArgs);
  const [jsonError, setJsonError] = useState('');
  const [showEdit, setShowEdit] = useState(false);
  const edited = argsText !== initialArgs;

  // v0.12 (interrupt_before): approve with edited args — parse a JSON
  // object; on failure show an inline error instead of sending.
  const approveEdited = () => {
    try {
      const parsed = JSON.parse(argsText) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('args must be a JSON object');
      }
      setJsonError('');
      onRespond(approval.callId, true, parsed as Record<string, unknown>);
    } catch {
      setJsonError(t('approval.invalidJson'));
    }
  };

  return (
    <div className="approval" role="alert">
      <h3>{t('approval.title')}</h3>
      <p style={{ margin: '0 0 4px' }}>
        {t('approval.requestLine', { bot: botLabel, tool: toolName })}
      </p>
      {approval.reason && (
        <p className="hint" style={{ margin: '0 0 6px' }}>{approval.reason}</p>
      )}
      {approval.risk && (
        <div
          data-testid="approval-risk"
          style={{
            margin: '0 0 8px',
            padding: '6px 8px',
            borderRadius: 6,
            fontSize: 12,
            background:
              approval.risk.level === 'high'
                ? '#fdecea'
                : approval.risk.level === 'medium'
                  ? '#fef6e0'
                  : '#eaf7ee',
            border: `1px solid ${
              approval.risk.level === 'high'
                ? '#e6a19a'
                : approval.risk.level === 'medium'
                  ? '#e3c878'
                  : '#9fd0ae'
            }`,
          }}
        >
          <strong>
            {t('risk.levelLabel')}: {t(`risk.${approval.risk.level}`)} ({approval.risk.score}
            /100)
          </strong>
          {approval.risk.reasons.length > 0 && (
            <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
              {approval.risk.reasons.slice(0, 4).map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <p style={{ margin: '0 0 10px', fontSize: 12, fontFamily: 'monospace', wordBreak: 'break-all' }}>
        <strong>{t('approval.argsLabel')}: </strong>
        {argsSummary}
      </p>
      <div className="row wrap">
        <button className="btn ok" onClick={() => onRespond(approval.callId, true)}>{t('approval.allowOnce')}</button>
        <button
          className="btn"
          title={t('approval.allowAlwaysScope', { tool: toolName, bot: botLabel })}
          onClick={() => onRespond(approval.callId, true, undefined, true)}
        >
          {t('approval.allowAlways')}
        </button>
        <button className="btn danger" onClick={() => onRespond(approval.callId, false)}>{t('approval.deny')}</button>
        <button className="btn secondary" onClick={() => setShowEdit((v) => !v)}>
          {t('approval.editArgs')}
        </button>
      </div>
      <p className="hint" style={{ margin: '8px 0 0' }}>
        {t('approval.allowAlwaysScope', { tool: toolName, bot: botLabel })}
      </p>
      <p className="hint" style={{ margin: '4px 0 0' }}>{t('approval.timeoutHint')}</p>
      {showEdit && (
        <div style={{ marginTop: 10 }}>
          <p className="hint" style={{ margin: '0 0 6px' }}>
            {t('approval.editArgsHint')}
          </p>
          <textarea
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            rows={6}
            spellCheck={false}
            style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, fontFamily: 'monospace', margin: '0 0 10px' }}
          />
          {jsonError && (
            <p style={{ margin: '0 0 10px', color: '#c0392b', fontSize: 12 }}>{jsonError}</p>
          )}
          {edited && (
            <button className="btn" onClick={approveEdited}>{t('approval.approveEdited')}</button>
          )}
        </div>
      )}
    </div>
  );
}
