import type { A2aPersistStatusView } from '../types';
import { useT } from '../i18n/useT';

interface Props {
  status: A2aPersistStatusView;
  onDismiss: () => void;
}

/**
 * v0.28: warning banner when saving A2A tasks to disk fails after all
 * retries (3 attempts, 50ms -> 100ms backoff). Before this, the failure
 * only lived in the main-process stderr log — the user never saw it,
 * and tasks survived only in memory, lost silently on restart. The
 * banner shows plainly: what failed, how many attempts, when the last
 * attempt was, and that tasks will be lost on restart unless fixed
 * (e.g. app-data folder read-only / disk full). "Got it" only hides
 * the banner for this session — the next failed save shows it again.
 */
export default function A2aPersistAlert({ status, onDismiss }: Props) {
  const t = useT();
  if (status.ok) return null;
  return (
    <div className="app-alert" role="alert">
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong>{t('a2a.persistFailedTitle')}</strong>
        <p style={{ margin: '4px 0 0' }}>
          {t('a2a.persistFailedBody', {
            error: status.lastError ?? t('a2a.persistUnknownError'),
            attempts: String(status.lastAttempts),
          })}
        </p>
        <p style={{ margin: '4px 0 0', color: 'var(--text-dim)' }}>
          {t('a2a.persistFailedHint')}
          {status.lastAttemptAt ? ` ${t('a2a.persistFailedAt', { at: new Date(status.lastAttemptAt).toLocaleString() })}` : ''}
        </p>
      </div>
      <button className="btn secondary" onClick={onDismiss}>
        {t('a2a.persistDismiss')}
      </button>
    </div>
  );
}
