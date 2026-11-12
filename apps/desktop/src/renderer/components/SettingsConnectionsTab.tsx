/**
 * Connections settings tab (UI-4, v0.59) — OAuth connectors
 * (Slack / Gmail / Teams) + a link card to the standalone
 * Connected apps view (the apps list itself moved out of Settings).
 *
 * Pure render over `SettingsShared` (see `settings/settingsShared.ts`):
 * all state, IPC and handlers still live in `SettingsView`. The
 * connectors JSX below moved verbatim from `SettingsView`; only a
 * `data-section` marker and the `onlySections` search filter were added.
 */
import { CONNECTOR_META } from './SettingsView';
import type { SettingsSectionId } from './settings/settingsTabs';
import type { SettingsShared } from './settings/settingsShared';

interface Props {
  s: SettingsShared;
  /** When set (search mode), render only these sections. */
  onlySections?: SettingsSectionId[];
}

export default function SettingsConnectionsTab({ s, onlySections }: Props) {
  const {
    t, identities, authLoading, authError, reloadAuth,
    connectorClientId, setConnectorClientId,
    connectorClientSecret, setConnectorClientSecret, connectorBusy,
    startConnector, signOutProvider, connectorMessage, onOpenConnectedApps,
  } = s;
  const show = (id: SettingsSectionId) => !onlySections || onlySections.includes(id);
  return (
    <>
      {show('connectors') && (
        <section data-section="connectors" className="card">
          <h3>{t('settings.connectorsTitle')}</h3>
          <p className="hint">{t('settings.connectorsIntro')}</p>
          {/* v0.68c: while the identities list is loading (or failed),
              every connector used to read "not connected" — the status
              line now waits for the load, and a failed load reports
              an error + retry. */}
          {authLoading && (
            <p className="hint" data-testid="connectors-loading">{t('settings.authLoading')}</p>
          )}
          {authError && (
            <>
              <p className="error">{authError}</p>
              <button className="btn secondary" data-testid="connectors-retry" onClick={() => void reloadAuth()}>
                {t('settings.retry')}
              </button>
            </>
          )}
          {CONNECTOR_META.map((c) => {
            const entry = identities.find((i) => i.providerId === c.id);
            const connected = entry?.identity ?? null;
            return (
              <div key={c.id}>
                <h4>{t(c.labelKey)}</h4>
                {connected ? (
                  <p>{t('settings.connectorConnectedAs', { name: connected.displayName ?? connected.email ?? connected.id })}</p>
                ) : (
                  !authLoading && !authError && <p>{t('settings.connectorNotConnected')}</p>
                )}
                <div className="field">
                  <label htmlFor={`connector-client-id-${c.id}`}>{t('settings.oauthClientId')}</label>
                  <input
                    id={`connector-client-id-${c.id}`}
                    value={connectorClientId[c.id] ?? ''}
                    placeholder={t('settings.connectorClientIdPlaceholder')}
                    onChange={(e) => setConnectorClientId((prev) => ({ ...prev, [c.id]: e.target.value }))}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`connector-client-secret-${c.id}`}>{t('settings.oauthClientSecret')}</label>
                  <input
                    id={`connector-client-secret-${c.id}`}
                    type="password"
                    value={connectorClientSecret[c.id] ?? ''}
                    onChange={(e) => setConnectorClientSecret((prev) => ({ ...prev, [c.id]: e.target.value }))}
                  />
                </div>
                <button
                  className="btn secondary"
                  disabled={connectorBusy !== null}
                  onClick={() => void startConnector(c.id, c.providerId)}
                >
                  {connectorBusy === c.id ? t('settings.oauthLoggingIn') : t('settings.connectorConnect')}
                </button>
                {connected && (
                  <button className="btn secondary" onClick={() => void signOutProvider(c.id)}>
                    {t('settings.connectorDisconnect')}
                  </button>
                )}
              </div>
            );
          })}
          {connectorMessage && <p>{connectorMessage}</p>}
        </section>
      )}

      {show('apps') && onOpenConnectedApps && (
        <div className="card">
          <h3>{t('settings.appsTitle')}</h3>
          <p className="hint">{t('settings.connectedAppsHint')}</p>
          <button className="btn secondary" onClick={onOpenConnectedApps}>
            {t('settings.connectedAppsOpen')}
          </button>
        </div>
      )}
    </>
  );
}
