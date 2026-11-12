import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * NotificationsSection (v0.87c) — OS notification preferences, rendered
 * as one section of the General settings tab.
 *
 *  - One toggle per event kind (run complete / approval needed / run
 *    error / project update digest — v0.94c adds the last one), all ON
 *    by default. Toggles go through `settings:set` like any other
 *    setting and take effect immediately — the main process reads them
 *    on every notification.
 *  - "Send test" button: fires one sample run-complete notification
 *    through the main process (`notifications:test`). On a machine
 *    with no notification daemon (e.g. this headless Linux VM) the
 *    call returns `{ shown: false, reason: 'unsupported' }` and the
 *    section says so instead of pretending a popup appeared — the
 *    test only verifies the logic up to the Electron Notification
 *    constructor (see docs/notifications.md).
 *
 * The renderer never calls Electron Notification directly: every
 * notification goes through main-process IPC.
 *
 * Every display string goes through i18n (`settings.notifications.*`).
 */
export default function NotificationsSection() {
  const t = useT();
  const [settings, setSettingsState] = useState<{
    runComplete: boolean;
    approval: boolean;
    runError: boolean;
    projectUpdate: boolean;
  } | null>(null);
  const [toggling, setToggling] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const s = await window.openBot.getSettings();
      const n = (s as unknown as { notifications?: { runComplete?: boolean; approval?: boolean; runError?: boolean; projectUpdate?: boolean } }).notifications;
      setSettingsState({
        runComplete: n?.runComplete !== false,
        approval: n?.approval !== false,
        runError: n?.runError !== false,
        projectUpdate: n?.projectUpdate !== false,
      });
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.notificationsLoadError'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = async (key: 'runComplete' | 'approval' | 'runError' | 'projectUpdate', next: boolean) => {
    if (!settings) return;
    setToggling(true);
    setNotice('');
    try {
      await window.openBot.setSettings({ notifications: { ...settings, [key]: next } });
      setSettingsState({ ...settings, [key]: next });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.notificationsSaveError'));
    } finally {
      setToggling(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    setNotice('');
    setError('');
    try {
      const result = await window.openBot.testNotification('run-complete');
      if (result?.shown) {
        setNotice(t('settings.notificationsTestSent'));
      } else {
        setNotice(t('settings.notificationsTestNotShown', { reason: result?.reason ?? 'unknown' }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.notificationsSaveError'));
    } finally {
      setTesting(false);
    }
  };

  const toggles = [
    { key: 'runComplete' as const, labelKey: 'settings.notificationsRunCompleteLabel', testId: 'notifications-toggle-run-complete' },
    { key: 'approval' as const, labelKey: 'settings.notificationsApprovalLabel', testId: 'notifications-toggle-approval' },
    { key: 'runError' as const, labelKey: 'settings.notificationsRunErrorLabel', testId: 'notifications-toggle-run-error' },
    // v0.94c: periodic project-update digest (every 6 hours).
    { key: 'projectUpdate' as const, labelKey: 'settings.notificationsProjectUpdateLabel', testId: 'notifications-toggle-project-update' },
  ];

  return (
    <>
      <h3>{t('settings.notificationsTitle')}</h3>
      <p className="hint">{t('settings.notificationsIntro')}</p>
      <p className="hint">{t('settings.notificationsHeadlessNote')}</p>
      {loading && <p data-testid="notifications-loading">{t('settings.notificationsLoading')}</p>}
      {error && <p className="error">{error}</p>}
      {notice && <p>{notice}</p>}
      {!loading && settings && (
        <>
          {toggles.map(({ key, labelKey, testId }) => (
            <div className="field" key={key}>
              <label>
                <input
                  type="checkbox"
                  data-testid={testId}
                  checked={settings[key]}
                  disabled={toggling}
                  onChange={(e) => void toggle(key, e.target.checked)}
                />
                {' '}
                {t(labelKey)}
              </label>
            </div>
          ))}
          <button
            className="btn secondary"
            data-testid="notifications-test"
            disabled={testing}
            onClick={() => void sendTest()}
          >
            {t('settings.notificationsTestButton')}
          </button>
        </>
      )}
    </>
  );
}
