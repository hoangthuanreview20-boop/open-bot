/**
 * Connected apps — standalone view (UI-4, v0.59; v0.67b loading states).
 *
 * The Connected apps section used to be buried inside the long Settings
 * page (docs/ui-parity-review.md §3.6 T2); it now has its own screen,
 * reachable from the sidebar and from Settings → Connections. Data +
 * IPC live in `settings/useConnectedApps.ts` (moved verbatim from
 * `SettingsView`); this file is pure render. The per-app Connect
 * button still uses the OAuth client id/secret inputs — they moved
 * here next to the button (they used to live in the Connectors
 * section of Settings); the `ComposioAppsSection` moved here with the
 * apps list, as specified.
 *
 * v0.67b: neither section ever renders blank while IPC is not ready
 * yet (§3.6 T5). The apps list shows a loading line, an empty state,
 * or the load error with a retry button; the Composio section shows
 * the same three states (loading / empty / error + retry) when its
 * state is still null.
 */
import { useT } from '../i18n/useT';
import { CONNECTOR_META } from './SettingsView';
import { ComposioAppsSection } from './ComposioAppsSection';
import { ComposioPollingSection } from './ComposioPollingSection';
import { useConnectedApps } from './settings/useConnectedApps';

interface Props {
  onBack: () => void;
}

export default function ConnectedAppsView({ onBack }: Props) {
  const t = useT();
  const {
    connectedApps, appsError, appsBusy, appsLoading, reloadApps, disconnectApp, appStatusText,
    appTokenDraft, setAppTokenDraft, appTokenBusy, appTokenError, saveAppToken,
    connectorClientId, setConnectorClientId, connectorClientSecret, setConnectorClientSecret,
    connectorMessage, connectorBusy, startConnector,
    composioState, composioBusy, composioError, composioLoading, reloadComposio, composioKeyDraft, setComposioKeyDraft,
    composioUserIdDraft, setComposioUserIdDraft,
    toggleComposioEnabled, toggleComposioApp, saveComposioKey, clearComposioKey,
    saveComposioUserId, clearComposioUserId,
    composioConnectionStatus, composioConnectionChecking, composioConnectionError,
    refreshComposioConnectionStatus,
    composioPollStatus, composioPollLoading, composioPollBusy, composioPollError,
    reloadComposioPollStatus, pollComposioNow, setComposioPollEnabled, setComposioPollInterval,
  } = useConnectedApps();

  return (
    <div className="panel">
      <button className="btn secondary" onClick={onBack}>{t('settings.back')}</button>
      <h2>{t('settings.appsTitle')}</h2>
      <p style={{ color: 'var(--text-dim)' }}>
        {t('settings.appsIntro')}
      </p>

      <section data-section="apps" className="card">
        {/* v0.67b: the list never renders blank — loading while the
            first `apps:list` call is in flight, an empty state when it
            answered with no apps, an error + retry when it failed. A
            refresh over an already-loaded list keeps the list on
            screen (no loading flash); the key row below stays visible
            in every state. */}
        {appsLoading && connectedApps.length === 0 && (
          <p className="hint" data-testid="apps-loading">{t('settings.appsLoading')}</p>
        )}
        {appsError && (
          <>
            <p className="error">{appsError}</p>
            <button className="btn secondary" data-testid="apps-retry" onClick={() => void reloadApps()}>
              {t('settings.appsRetry')}
            </button>
          </>
        )}
        {!appsLoading && !appsError && connectedApps.length === 0 && (
          <>
            <p data-testid="apps-empty">{t('settings.appsEmpty')}</p>
            <p className="hint">{t('settings.appsEmptyHint')}</p>
          </>
        )}
        {connectedApps.map((a) => {
          const meta = CONNECTOR_META.find((c) => c.id === a.app.id);
          return (
            <div key={a.app.id}>
              <h4>
                {a.app.icon} {a.app.label} — {appStatusText(a.authStatus)}
                {a.app.source === 'composio' && (
                  <span title={t('settings.appsComposioTokenNote')}>
                    {' '}
                    · via Composio
                  </span>
                )}
              </h4>
              {/* v0.70: status detail — GitHub token no longer valid
                  + re-paste guidance, or the reason it could not be
                  checked (network/rate-limit) while keeping the old
                  status. This string comes from main, never contains a token. */}
              {a.authStatusDetail && (
                <p className="hint" data-testid={`app-status-detail-${a.app.id}`}>{a.authStatusDetail}</p>
              )}
              <p className="hint">{a.app.description}</p>
              {a.accountLabel && <p>{t('settings.appsConnectedAs', { name: a.accountLabel })}</p>}
              <p className="hint">{t('settings.appsToolCap', { cap: a.toolCap })}</p>
              <details>
                <summary>{t('settings.appsTools', { count: a.app.tools.length })}</summary>
                <ul>
                  {a.app.tools.map((tool) => (
                    <li key={tool.name}>
                      {tool.name} — {tool.description}
                      {tool.needsApproval ? ` (${t('settings.appsNeedsApproval')})` : ''}
                    </li>
                  ))}
                </ul>
              </details>
              {/* v0.68b: token apps (e.g. GitHub) connect by pasting a
                  personal access token. The input is a password field
                  and is cleared after a successful save — the token is
                  never shown back. The hint tells the user where to
                  create the token; the token itself only lives in the
                  Vault on this machine. */}
              {a.app.authType === 'token' && a.authStatus !== 'connected' && (
                <div>
                  <div className="field">
                    <label htmlFor={`connected-app-token-${a.app.id}`}>{t('settings.appsTokenLabel')}</label>
                    <input
                      id={`connected-app-token-${a.app.id}`}
                      data-testid={`app-token-input-${a.app.id}`}
                      type="password"
                      autoComplete="off"
                      value={appTokenDraft[a.app.id] ?? ''}
                      placeholder={t('settings.appsTokenPlaceholder')}
                      onChange={(e) => setAppTokenDraft((prev) => ({ ...prev, [a.app.id]: e.target.value }))}
                    />
                  </div>
                  <p className="hint">{t('settings.appsTokenHint')}</p>
                  <button
                    className="btn secondary"
                    data-testid={`app-token-save-${a.app.id}`}
                    disabled={appTokenBusy !== null || appsBusy !== null}
                    onClick={() => void saveAppToken(a.app.id)}
                  >
                    {appTokenBusy === a.app.id ? t('settings.oauthLoggingIn') : t('settings.appsTokenSave')}
                  </button>
                </div>
              )}
              {a.app.authType === 'oauth2' && meta && a.authStatus !== 'connected' && (
                <div>
                  <div className="field">
                    <label htmlFor={`connected-app-client-id-${a.app.id}`}>{t('settings.oauthClientId')}</label>
                    <input
                      id={`connected-app-client-id-${a.app.id}`}
                      value={connectorClientId[a.app.id] ?? ''}
                      placeholder={t('settings.connectorClientIdPlaceholder')}
                      onChange={(e) => setConnectorClientId((prev) => ({ ...prev, [a.app.id]: e.target.value }))}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`connected-app-client-secret-${a.app.id}`}>{t('settings.oauthClientSecret')}</label>
                    <input
                      id={`connected-app-client-secret-${a.app.id}`}
                      type="password"
                      value={connectorClientSecret[a.app.id] ?? ''}
                      onChange={(e) => setConnectorClientSecret((prev) => ({ ...prev, [a.app.id]: e.target.value }))}
                    />
                  </div>
                  <button
                    className="btn secondary"
                    disabled={connectorBusy !== null || appsBusy !== null}
                    onClick={() => void startConnector(a.app.id, meta.providerId)}
                  >
                    {connectorBusy === a.app.id ? t('settings.oauthLoggingIn') : t('settings.appsConnect')}
                  </button>
                </div>
              )}
              {(a.app.authType === 'oauth2' || a.app.authType === 'token') && a.authStatus !== 'not_connected' && (
                <button
                  className="btn secondary"
                  data-testid={`app-disconnect-${a.app.id}`}
                  disabled={appsBusy !== null}
                  onClick={() => void disconnectApp(a.app.id)}
                >
                  {appsBusy === a.app.id ? t('settings.oauthLoggingIn') : t('settings.appsDisconnect')}
                </button>
              )}
            </div>
          );
        })}
        {appTokenError && <p className="error">{appTokenError}</p>}
        {connectorMessage && <p>{connectorMessage}</p>}
        {/* v0.57: Composio — key input (password, never stored in the
            renderer) + section with source/app toggles. The section
            carries its own vi/en strings; only the key row below uses
            locale keys. */}
        <div>
          <label htmlFor="composio-key">{t('settings.composioKeyLabel')}</label>{' '}
          <input
            id="composio-key"
            type="password"
            autoComplete="off"
            value={composioKeyDraft}
            placeholder={t('settings.composioKeyPlaceholder')}
            onChange={(e) => setComposioKeyDraft(e.target.value)}
          />{' '}
          <button className="btn secondary" disabled={composioBusy} onClick={() => void saveComposioKey()}>
            {t('settings.composioKeySave')}
          </button>
        </div>
      </section>

      {/* v0.67b: the Composio section keeps one wrapper (and one
          section marker) in every state — loading while the first
          state load is in flight, the full section once the state
          arrives, an error + retry when the load failed, an empty
          state when it answered with no state. */}
      <div data-section="composio">
        {composioLoading && !composioState ? (
          <>
            <h3>{t('settings.composio.title')}</h3>
            <p className="hint" data-testid="composio-loading">{t('settings.composioLoading')}</p>
          </>
        ) : composioState ? (
          <>
            <ComposioAppsSection
              enabled={composioState.enabled}
              keyConfigured={composioState.keyConfigured}
              userIdConfigured={composioState.userIdConfigured}
              userIdDraft={composioUserIdDraft}
              onUserIdDraftChange={setComposioUserIdDraft}
              onSaveUserId={() => void saveComposioUserId()}
              onClearUserId={() => void clearComposioUserId()}
              apps={composioState.apps}
              busy={composioBusy}
              error={composioError || undefined}
              onToggleEnabled={(next) => void toggleComposioEnabled(next)}
              onToggleApp={(toolkit, next) => void toggleComposioApp(toolkit, next)}
              onSetKey={() => void saveComposioKey()}
              onClearKey={() => void clearComposioKey()}
              connectionStatus={composioConnectionStatus}
              connectionChecking={composioConnectionChecking}
              connectionError={composioConnectionError || undefined}
              onCheckConnectionStatus={() => void refreshComposioConnectionStatus()}
            />
            {/* v0.98 (Team T3): Composio background polling — new mail
                automatically becomes an event that runs automations,
                no manual polling needed. */}
            <ComposioPollingSection
              statuses={composioPollStatus}
              loading={composioPollLoading}
              busy={composioPollBusy || composioBusy}
              error={composioPollError || undefined}
              keyConfigured={composioState.keyConfigured}
              onRefresh={() => void reloadComposioPollStatus()}
              onPollNow={(name) => void pollComposioNow(name)}
              onSetEnabled={(name, next) => void setComposioPollEnabled(name, next)}
              onSetInterval={(name, minutes) => void setComposioPollInterval(name, minutes)}
            />
          </>
        ) : composioError ? (
          <>
            <h3>{t('settings.composio.title')}</h3>
            <p className="error">{composioError}</p>
            <button className="btn secondary" data-testid="composio-retry" onClick={() => void reloadComposio()}>
              {t('settings.appsRetry')}
            </button>
          </>
        ) : (
          <>
            <h3>{t('settings.composio.title')}</h3>
            <p data-testid="composio-empty">{t('settings.composioEmpty')}</p>
            <p className="hint">{t('settings.composioEmptyHint')}</p>
          </>
        )}
      </div>
    </div>
  );
}
