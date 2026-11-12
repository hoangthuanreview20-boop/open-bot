import { useEffect, useState } from 'react';
import type { CrashReportSummaryView, CrashReportView } from '../types';
import { useT } from '../i18n/useT';

/**
 * CrashReportsSection (v0.86, P2-7) — opt-in crash reporting UI,
 * rendered as one section of the Security settings tab.
 *
 *  - Opt-in toggle (default OFF): only when the user turns it on does
 *    the main process record crash reports locally; turning it off
 *    stops recording immediately (old reports stay on disk until the
 *    user deletes them). The toggle goes through `settings:set` like
 *    any other setting.
 *  - Local report list (summary: time, source, kind, redacted
 *    message), open for detail (message + stack + platform +
 *    appVersion), delete one / delete all (two-step confirm, never
 *    window.confirm).
 *  - No send button, no endpoint: this wave only collects + stores
 *    locally + views/deletes. Reports never leave the machine (see
 *    docs/crash-reporting.md).
 *
 * Every display string goes through i18n (`settings.crashReports.*`).
 */
export default function CrashReportsSection() {
  const t = useT();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [toggling, setToggling] = useState(false);
  const [reports, setReports] = useState<CrashReportSummaryView[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [viewing, setViewing] = useState<CrashReportView | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState('');
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const settings = await window.openBot.getSettings();
      setEnabled(settings?.crashReportingEnabled === true);
      setReports(await window.openBot.listCrashReports());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.crashReportsLoadError'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleEnabled = async (next: boolean) => {
    setToggling(true);
    setNotice('');
    try {
      await window.openBot.setSettings({ crashReportingEnabled: next });
      setEnabled(next);
      setNotice(next ? t('settings.crashReportsEnabledNotice') : t('settings.crashReportsDisabledNotice'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.crashReportsToggleError'));
    } finally {
      setToggling(false);
    }
  };

  const openReport = async (id: string) => {
    setViewLoading(true);
    setNotice('');
    try {
      setViewing(await window.openBot.getCrashReport(id));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.crashReportsReadError'));
      setViewing(null);
    } finally {
      setViewLoading(false);
    }
  };

  const deleteReport = async (id: string) => {
    try {
      await window.openBot.deleteCrashReport(id);
      setConfirmDeleteId('');
      if (viewing?.id === id) setViewing(null);
      setNotice(t('settings.crashReportsDeleted'));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.crashReportsDeleteError'));
    }
  };

  const deleteAll = async () => {
    try {
      const result = await window.openBot.deleteAllCrashReports();
      setConfirmDeleteAll(false);
      setViewing(null);
      setNotice(t('settings.crashReportsDeletedAll', { count: String(result.deleted) }));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.crashReportsDeleteError'));
    }
  };

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  const kindLabel = (kind: CrashReportSummaryView['kind']) => {
    if (kind === 'uncaughtException') return t('settings.crashReportsKindUncaught');
    if (kind === 'unhandledRejection') return t('settings.crashReportsKindRejection');
    return t('settings.crashReportsKindRenderer');
  };

  return (
    <>
      <h3>{t('settings.crashReportsTitle')}</h3>
      <p className="hint">{t('settings.crashReportsIntro')}</p>
      <p className="hint">{t('settings.crashReportsPrivacy')}</p>
      <p className="hint">{t('settings.crashReportsNoSend')}</p>
      {loading && <p data-testid="crash-reports-loading">{t('settings.crashReportsLoading')}</p>}
      {error && <p className="error">{error}</p>}
      {notice && <p>{notice}</p>}
      {!loading && (
        <div className="field">
          <label>
            <input
              type="checkbox"
              data-testid="crash-reports-toggle"
              checked={enabled === true}
              disabled={enabled === null || toggling}
              onChange={(e) => void toggleEnabled(e.target.checked)}
            />
            {' '}
            {t('settings.crashReportsEnableLabel')}
          </label>
        </div>
      )}

      {!loading && !error && reports.length === 0 && !viewing && (
        <p data-testid="crash-reports-empty">{t('settings.crashReportsEmpty')}</p>
      )}

      {!viewing && reports.map((r) => (
        <div key={r.id} className="card" data-testid={`crash-report-item-${r.id}`}>
          <p>
            <strong>{formatDate(r.createdAt)}</strong>
            {' · '}
            {r.source === 'main' ? t('settings.crashReportsSourceMain') : t('settings.crashReportsSourceRenderer')}
            {' · '}
            {kindLabel(r.kind)}
          </p>
          <p data-testid={`crash-report-message-${r.id}`}>{r.message}</p>
          <button
            className="btn secondary"
            data-testid={`crash-report-open-${r.id}`}
            onClick={() => void openReport(r.id)}
          >
            {t('settings.crashReportsOpen')}
          </button>
          {confirmDeleteId === r.id ? (
            <>
              <button
                className="btn"
                data-testid={`crash-report-delete-confirm-${r.id}`}
                onClick={() => void deleteReport(r.id)}
              >
                {t('settings.crashReportsDeleteConfirm')}
              </button>
              <button className="btn secondary" onClick={() => setConfirmDeleteId('')}>
                {t('settings.crashReportsDeleteCancel')}
              </button>
            </>
          ) : (
            <button
              className="btn secondary"
              data-testid={`crash-report-delete-${r.id}`}
              onClick={() => setConfirmDeleteId(r.id)}
            >
              {t('settings.crashReportsDelete')}
            </button>
          )}
        </div>
      ))}

      {viewLoading && <p>{t('settings.crashReportsLoading')}</p>}
      {viewing && (
        <section className="card" data-testid="crash-report-detail">
          <h4>{formatDate(viewing.createdAt)}</h4>
          <p>
            {viewing.source === 'main' ? t('settings.crashReportsSourceMain') : t('settings.crashReportsSourceRenderer')}
            {' · '}
            {kindLabel(viewing.kind)}
            {' · '}
            {viewing.platform}
            {viewing.appVersion ? ` · ${t('settings.crashReportsAppVersion', { version: viewing.appVersion })}` : ''}
            {viewing.nodeVersion ? ` · ${viewing.nodeVersion}` : ''}
          </p>
          <p>{t('settings.crashReportsSent', { sent: viewing.sent ? t('settings.crashReportsSentYes') : t('settings.crashReportsSentNo') })}</p>
          <pre
            data-testid="crash-report-message-full"
            style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '30vh', overflow: 'auto' }}
          >
            {viewing.message}
          </pre>
          {viewing.stack && (
            <pre
              data-testid="crash-report-stack"
              style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '50vh', overflow: 'auto' }}
            >
              {viewing.stack}
            </pre>
          )}
          <button className="btn secondary" onClick={() => setViewing(null)}>
            {t('settings.crashReportsClose')}
          </button>
        </section>
      )}

      {!loading && reports.length > 0 && !viewing && (
        confirmDeleteAll ? (
          <>
            <button
              className="btn"
              data-testid="crash-reports-delete-all-confirm"
              onClick={() => void deleteAll()}
            >
              {t('settings.crashReportsDeleteAllConfirm')}
            </button>
            <button className="btn secondary" onClick={() => setConfirmDeleteAll(false)}>
              {t('settings.crashReportsDeleteCancel')}
            </button>
          </>
        ) : (
          <button
            className="btn secondary"
            data-testid="crash-reports-delete-all"
            onClick={() => setConfirmDeleteAll(true)}
          >
            {t('settings.crashReportsDeleteAll')}
          </button>
        )
      )}
    </>
  );
}
