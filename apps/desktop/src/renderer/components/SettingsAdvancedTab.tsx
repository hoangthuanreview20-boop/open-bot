/**
 * Advanced settings tab (UI-4, v0.59) — Dream, performance, plugins,
 * hooks, Local API + token + webhooks.
 *
 * Pure render over `SettingsShared` (see `settings/settingsShared.ts`):
 * all state, IPC and handlers still live in `SettingsView`. The JSX
 * below moved verbatim from `SettingsView`; only a `data-section`
 * marker and the `onlySections` search filter were added.
 */
import TemplatePluginModal from './TemplatePluginModal';
import { WEBHOOK_EVENTS } from './SettingsView';
import type { SettingsSectionId } from './settings/settingsTabs';
import type { SettingsShared } from './settings/settingsShared';

interface Props {
  s: SettingsShared;
  /** When set (search mode), render only these sections. */
  onlySections?: SettingsSectionId[];
}

export default function SettingsAdvancedTab({ s, onlySections }: Props) {
  const {
    t, dream, changeDream, dreamLoading, dreamError, reloadDream,
    perf, perfError, loadPerf, perfLoading, clearing, onClearCache,
    plugins, pluginErrors, pluginsError, pluginsLoading, pluginNotice, togglePlugin,
    templateModalOpen, setTemplateModalOpen, loadPlugins,
    hooks, hooksError, hooksLoading, reloadHooks, toggleHook,
    apiStatus, setApiStatus, apiPort, setApiPort, apiError, apiSaved, saveApi,
    apiLoading, reloadApi, webhooksError,
    apiToken, setApiToken, showApiToken, setShowApiToken, showToken, regenerateToken,
    copied, copyAndMark, webhooks, webhookUrl, setWebhookUrl, webhookEvents,
    setWebhookEvents, addWebhook, removeWebhook,
  } = s;
  const show = (id: SettingsSectionId) => !onlySections || onlySections.includes(id);
  return (
    <>
      {show('dream') && (
        <section data-section="dream" className="card">
          <h3>{t('settings.dreamTitle')}</h3>
          <p>{t('settings.dreamIntro')}</p>
          {/* v0.69c: the Dream settings used to load silently — a
              failed load left the toggle off, looking exactly like
              Dream being disabled. Loading and error + retry are
              explicit now. */}
          {dreamLoading && (
            <p className="hint" data-testid="dream-loading">{t('settings.dreamLoading')}</p>
          )}
          {dreamError && (
            <>
              <p className="error">{dreamError}</p>
              <button className="btn secondary" data-testid="dream-retry" onClick={() => void reloadDream()}>
                {t('settings.retry')}
              </button>
            </>
          )}
          <label>
            <input
              type="checkbox"
              checked={dream.enabled}
              onChange={(e) => void changeDream({ ...dream, enabled: e.target.checked })}
            />
            {t('settings.dreamEnableLabel')}
          </label>
          <div className="field">
            <label htmlFor="dream-idle">{t('settings.dreamIdleLabel')}</label>
            <input
              id="dream-idle"
              type="number"
              min={5}
              max={240}
              step={5}
              value={dream.idleMinutes}
              disabled={!dream.enabled}
              onChange={(e) => void changeDream({ ...dream, idleMinutes: Number(e.target.value) || 15 })}
            />
          </div>
          <p className="hint">{t('settings.dreamModelNote')}</p>
        </section>
      )}

      {show('perf') && (
        <section data-section="perf" className="card">
          <h3>{t('perf.title')}</h3>
          {/* v0.68c: the section body used to be blank until the stats
              arrived, and the Refresh button only lived inside the
              loaded block — so a failed load had no retry at all. */}
          {perfLoading && (
            <p className="hint" data-testid="perf-loading">{t('perf.loading')}</p>
          )}
          {perfError && <p className="error">{perfError}</p>}
          {!perf && !perfLoading && (
            <div className="row">
              <button className="btn secondary" data-testid="perf-retry" onClick={() => void loadPerf()}>{t('perf.refresh')}</button>
            </div>
          )}
          {perf && (
            <div>
              <p>{t('perf.workers', { busy: perf.pool.busyWorkers, total: perf.pool.workers })}</p>
              <p>{t('perf.queue', { pending: perf.pool.pending, running: perf.pool.running })}</p>
              <p>{t('perf.jobs', { done: perf.pool.completed, failed: perf.pool.failed })}</p>
              <p>
                {perf.cache
                  ? t('perf.cache', { entries: perf.cache.entries, hits: perf.cache.hits, misses: perf.cache.misses })
                  : t('perf.cacheUnavailable')}
              </p>
              <div className="row">
                <button className="btn secondary" onClick={() => void loadPerf()}>{t('perf.refresh')}</button>
                <button className="btn secondary" onClick={() => void onClearCache()} disabled={clearing}>
                  {clearing ? t('perf.clearing') : t('perf.clearCache')}
                </button>
              </div>
              <p className="hint">{t('perf.cacheHint')}</p>
            </div>
          )}
        </section>
      )}

      {show('plugins') && (
        <section data-section="plugins" className="card">
          <h3>{t('settings.pluginsTitle')}</h3>
          <p className="hint">{t('settings.pluginsIntro')}</p>
          <button className="btn secondary" onClick={() => setTemplateModalOpen(true)}>
            {t('settings.pluginsFromTemplate')}
          </button>
          {templateModalOpen && (
            <TemplatePluginModal
              onClose={() => setTemplateModalOpen(false)}
              onInstalled={() => void loadPlugins()}
            />
          )}
          {pluginsError && (
            <>
              <p className="error">{pluginsError}</p>
              <button className="btn secondary" data-testid="plugins-retry" onClick={() => void loadPlugins()}>
                {t('settings.retry')}
              </button>
            </>
          )}
          {pluginNotice && <p className="success">{pluginNotice}</p>}
          {/* v0.68c: the empty line used to show while the list was
              still loading — it now waits for a finished load. */}
          {pluginsLoading && (
            <p className="hint" data-testid="plugins-loading">{t('settings.pluginsLoading')}</p>
          )}
          {!pluginsLoading && !pluginsError && plugins.length === 0 && <p>{t('settings.pluginsEmpty')}</p>}
          {plugins.map((p) => (
            <div key={p.id}>
              <strong>{p.name}</strong> v{p.version}
              {p.author ? ` (${p.author})` : ''}
              <p>{p.description}</p>
              {p.tools.length > 0 && (
                <p className="hint">{t('settings.pluginsTools', { tools: p.tools.join(', ') })}</p>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={p.enabled}
                  onChange={(e) => void togglePlugin(p.id, e.target.checked)}
                />
                {t('settings.pluginsEnableLabel')}
              </label>
            </div>
          ))}
          {pluginErrors.length > 0 && (
            <div>
              <p>{t('settings.pluginsErrorsTitle')}</p>
              <ul>
                {pluginErrors.map((e) => (
                  <li key={e.dir}>
                    {e.dir}: {e.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {show('hooks') && (
        <section data-section="hooks" className="card">
          <h3>{t('settings.hooksTitle')}</h3>
          <p className="hint">{t('settings.hooksIntro')}</p>
          <p className="hint">{t('settings.hooksApplyNote')}</p>
          {/* v0.68c: same gap as plugins — the empty line showed while
              loading, and a failed load had no retry (the reload
              function was never exposed to the tab before). */}
          {hooksLoading && (
            <p className="hint" data-testid="hooks-loading">{t('settings.hooksLoading')}</p>
          )}
          {hooksError && (
            <>
              <p className="error">{hooksError}</p>
              <button className="btn secondary" data-testid="hooks-retry" onClick={() => void reloadHooks()}>
                {t('settings.retry')}
              </button>
            </>
          )}
          {!hooksLoading && !hooksError && hooks.length === 0 && <p>{t('settings.hooksEmpty')}</p>}
          {hooks.map((h) => (
            <div key={h.name}>
              <strong>{h.name}</strong>
              {h.source === 'builtin' ? ` (${t('settings.hooksSourceBuiltin')})` : ''}
              <p>{h.description}</p>
              {h.events.length > 0 && (
                <p className="hint">{t('settings.hooksEvents', { events: h.events.join(', ') })}</p>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={h.enabled}
                  onChange={(e) => void toggleHook(h.name, e.target.checked)}
                />
                {t('settings.hooksEnableLabel')}
              </label>
            </div>
          ))}
        </section>
      )}

      {show('api') && (
        <section data-section="api" className="card">
          <h3>{t('settings.apiTitle')}</h3>
          <p className="hint">{t('settings.apiIntro')}</p>
          {/* v0.68c: while the API status was loading, the section
              showed an unchecked "enabled" box and "token not set"
              as if that were the real state — loading and error +
              retry are explicit now. */}
          {apiLoading && (
            <p className="hint" data-testid="api-loading">{t('settings.apiLoading')}</p>
          )}
          {apiError && (
            <>
              <p className="error">{apiError}</p>
              <button className="btn secondary" data-testid="api-retry" onClick={() => void reloadApi()}>
                {t('settings.retry')}
              </button>
            </>
          )}
          {apiSaved && <p className="success">{t('settings.apiSaved')}</p>}
          <label>
            <input
              type="checkbox"
              checked={apiStatus?.enabled ?? false}
              onChange={(e) => setApiStatus((prev) => (prev ? { ...prev, enabled: e.target.checked } : { enabled: e.target.checked, port: apiPort, tokenSet: false }))}
            />
            {t('settings.apiEnabledLabel')}
          </label>
          <div className="field">
            <label htmlFor="api-port">{t('settings.apiPortLabel')}</label>
            <input
              id="api-port"
              type="number"
              min={1}
              max={65535}
              value={apiPort || ''}
              onChange={(e) => setApiPort(Number(e.target.value) || 0)}
            />
          </div>
          <button className="btn secondary" onClick={() => void saveApi()}>{t('settings.apiSave')}</button>

          <h3>{t('settings.apiTokenTitle')}</h3>
          <p>{apiStatus?.tokenSet ? t('settings.apiTokenSet') : t('settings.apiTokenNotSet')}</p>
          {showApiToken && apiToken && (
            <div className="field">
              <label htmlFor="api-token">{t('settings.apiTokenLabel')}</label>
              <input id="api-token" type="password" readOnly value={apiToken} autoComplete="off" />
            </div>
          )}
          <div className="row wrap">
            {showApiToken && apiToken ? (
              <button className="btn secondary" onClick={() => { setShowApiToken(false); setApiToken(null); }}>
                {t('settings.apiHideToken')}
              </button>
            ) : (
              <button className="btn secondary" onClick={() => void showToken()}>{t('settings.apiShowToken')}</button>
            )}
            {showApiToken && apiToken && (
              <button className="btn secondary" onClick={() => void copyAndMark(apiToken, 'api-token')}>
                {copied === 'api-token' ? t('settings.apiCopied') : t('settings.apiCopyToken')}
              </button>
            )}
            <button className="btn secondary" onClick={() => void regenerateToken()}>{t('settings.apiRegenerateToken')}</button>
          </div>

          <h3>{t('settings.apiWebhooksTitle')}</h3>
          {/* v0.68c: a failed webhook list used to look exactly like
              "no webhooks yet" — it now reports its own error line. */}
          {webhooksError && <p className="error">{webhooksError}</p>}
          {!apiLoading && !webhooksError && webhooks.length === 0 && <p>{t('settings.apiWebhooksEmpty')}</p>}
          <ul>
            {webhooks.map((w) => (
              <li key={w.id}>
                {w.url} ({w.events.join(', ')}){' '}
                <button className="btn secondary" onClick={() => void removeWebhook(w.id)}>
                  {t('settings.apiWebhookDelete')}
                </button>
              </li>
            ))}
          </ul>
          <div className="field">
            <label htmlFor="webhook-url">{t('settings.apiWebhookUrlLabel')}</label>
            <input
              id="webhook-url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder={t('settings.apiWebhookUrlPlaceholder')}
            />
          </div>
          <div className="field">
            <span>{t('settings.apiWebhookEventsLabel')}</span>
            {WEBHOOK_EVENTS.map((ev) => (
              <label key={ev.id} style={{ display: 'block' }}>
                <input
                  type="checkbox"
                  checked={webhookEvents.includes(ev.id)}
                  onChange={(e) =>
                    setWebhookEvents((prev) =>
                      e.target.checked ? [...prev, ev.id] : prev.filter((x) => x !== ev.id),
                    )
                  }
                />
                {t(ev.labelKey)}
              </label>
            ))}
          </div>
          <button className="btn secondary" onClick={() => void addWebhook()}>{t('settings.apiWebhookAdd')}</button>
        </section>
      )}
    </>
  );
}
