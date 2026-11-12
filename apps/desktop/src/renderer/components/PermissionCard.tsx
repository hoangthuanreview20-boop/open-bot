import type { HarnessPermissionRequestView } from '../types';
import { useT } from '../i18n/useT';

interface Props {
  request: HarnessPermissionRequestView;
  /** Display name of the bot (App looks it up from the bot list). */
  botName?: string;
  onRespond: (requestId: string, allowed: boolean) => void;
}

/**
 * Permission card for a CLI engine (M8): when Codex/ACP asks permission
 * through the harness broker, an Allow/Deny card appears in chat — same
 * family as ApprovalCard, but for a permission (no args to edit, just
 * allow / deny one stated action). A method with no safe allow path
 * (`allowable: false`, e.g. Codex) only gets a deny button. No answer
 * within 120s and the broker denies by itself (fail-closed).
 */
export default function PermissionCard({ request, botName, onRespond }: Props) {
  const t = useT();
  return (
    <div className="approval" role="alert">
      <h3>{t('permission.title')}</h3>
      <p style={{ margin: '0 0 4px' }}>
        <strong>{t('permission.botLabel')}: </strong>
        {botName ?? request.botId}
        {' · '}
        {request.engine}
      </p>
      <p style={{ margin: '0 0 4px' }}>
        <strong>{t('permission.methodLabel')}: </strong>
        {request.method}
      </p>
      {request.detail && (
        <p style={{ margin: '0 0 10px', fontSize: 12, fontFamily: 'monospace', wordBreak: 'break-all' }}>
          <strong>{t('permission.detailLabel')}: </strong>
          {request.detail}
        </p>
      )}
      {!request.allowable && (
        <p className="hint" style={{ margin: '0 0 10px' }}>{t('permission.notAllowable')}</p>
      )}
      <div className="row wrap">
        {request.allowable && (
          <button className="btn ok" onClick={() => onRespond(request.requestId, true)}>
            {t('permission.allow')}
          </button>
        )}
        <button className="btn danger" onClick={() => onRespond(request.requestId, false)}>
          {t('permission.deny')}
        </button>
      </div>
      <p className="hint" style={{ margin: '8px 0 0' }}>{t('permission.timeoutHint')}</p>
    </div>
  );
}
