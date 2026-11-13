/**
 * General settings tab (UI-4, v0.59) — usage, language, updates,
 * spend limits, usage reset.
 *
 * Pure render over `SettingsShared` (see `settings/settingsShared.ts`):
 * all state, IPC and handlers still live in `SettingsView`. The JSX
 * below moved verbatim from `SettingsView`; only a `data-section`
 * marker and the `onlySections` search filter were added.
 */
import { useState } from 'react';
import { LOCALES } from '../i18n';
import NotificationsSection from './NotificationsSection';
import ProfileSection from './ProfileSection';
import type { SettingsSectionId } from './settings/settingsTabs';
import type { SettingsShared } from './settings/settingsShared';
import {
  applyThemeMode,
  readThemeMode,
  saveThemeMode,
  type ThemeMode,
} from './theme';

/** localStorage may be unavailable — never crash on it. */
function safeLocalStorage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

interface Props {
  s: SettingsShared;
  /** When set (search mode), render only these sections. */
  onlySections?: SettingsSectionId[];
}

export default function SettingsGeneralTab({ s, onlySections }: Props) {
  const {
    t, locale, usage, costText, limits, setLimits, saveLimits, resetUsage,
    usageLoading, usageError, reloadUsage,
    limitsLoading, limitsError, reloadLimits,
    changeLocale, updateTrack, changeUpdateTrack, updateStatus, updateInfo,
    checkingUpdate, checkUpdate, openUpdateDownload,
    updateStatusError, updateStatusLoading, reloadUpdateStatus,
  } = s;
  const show = (id: SettingsSectionId) => !onlySections || onlySections.includes(id);
  // v0.62 (UI-13): manual theme — renderer-only (localStorage), no IPC.
  // Changing it applies immediately (data-theme on <html>); App applies
  // the stored choice on mount so it survives restarts.
  const [theme, setTheme] = useState<ThemeMode>(() => readThemeMode(safeLocalStorage()));
  const changeTheme = (mode: ThemeMode) => {
    setTheme(mode);
    saveThemeMode(safeLocalStorage(), mode);
    try {
      applyThemeMode(mode, document.documentElement);
    } catch {
      // A missing document (tests) — the choice is still saved.
    }
  };
  return (
    <>
      {/* v0.95d4 (Team D4): user profile — personalization (name, how
          to address the user, interests, habits, facts), stored locally. */}
      {show('profile') && <ProfileSection />}
      {/* v0.68c: the usage section used to vanish entirely while the
          usage load was in flight or had failed — it now always
          renders, with a loading line, an error + retry, or the data. */}
      {show('usage') && (
        <section data-section="usage" className="card">
          <h3>{t('settings.usageTitle')}</h3>
          {usageLoading && !usage && (
            <p className="hint" data-testid="usage-loading">{t('settings.usageLoading')}</p>
          )}
          {usageError && (
            <>
              <p className="error">{usageError}</p>
              <button className="btn secondary" data-testid="usage-retry" onClick={() => void reloadUsage()}>
                {t('settings.retry')}
              </button>
            </>
          )}
          {usage && (
            <>
          <p>
            {t('settings.usageToday', {
              cost: costText(usage.today.costUsd),
              tokens: String(usage.today.inputTokens + usage.today.outputTokens),
            })}
          </p>
          <p>
            {t('settings.usageMonth', {
              cost: costText(usage.month.costUsd),
              tokens: String(usage.month.inputTokens + usage.month.outputTokens),
            })}
          </p>
          {usage.today.limitUsd !== undefined && usage.today.percentUsed !== null && (
            <p className={usage.today.percentUsed >= 100 ? 'error' : ''}>
              {t('settings.usageDailyLimit', {
                percent: usage.today.percentUsed.toFixed(0),
                limit: usage.today.limitUsd.toFixed(2),
              })}
            </p>
          )}
          {usage.today.unpricedCalls > 0 && (
            <p className="hint">{t('settings.usageUnpriced', { count: String(usage.today.unpricedCalls) })}</p>
          )}
            </>
          )}
        </section>
      )}

      {show('language') && (
        <section data-section="language" className="card">
          <h3>{t('settings.languageTitle')}</h3>
          <div className="field">
            <label htmlFor="locale">{t('settings.languageLabel')}</label>
            <select id="locale" value={locale} onChange={(e) => void changeLocale(e.target.value)}>
              {LOCALES.map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
            <p className="hint">{t('settings.languageHint')}</p>
          </div>
        </section>
      )}

      {show('notifications') && (
        <section data-section="notifications" className="card" data-testid="notifications-section">
          <NotificationsSection />
        </section>
      )}

      {show('appearance') && (
        <section data-section="appearance" className="card">
          <h3>{t('settings.themeTitle')}</h3>
          <div className="field">
            <label htmlFor="theme">{t('settings.themeLabel')}</label>
            <select
              id="theme"
              value={theme}
              data-testid="theme-select"
              onChange={(e) => changeTheme(e.target.value as ThemeMode)}
            >
              <option value="system">{t('settings.themeSystem')}</option>
              <option value="light">{t('settings.themeLight')}</option>
              <option value="dark">{t('settings.themeDark')}</option>
            </select>
            <p className="hint">{t('settings.themeHint')}</p>
          </div>
        </section>
      )}

      {show('update') && (
        <section data-section="update" className="card">
          <h3>{t('settings.updateTitle')}</h3>
          <p className="hint">{t('settings.updateIntro')}</p>
          <label>
            {t('settings.updateTrackLabel')}{' '}
            <select value={updateTrack} onChange={(e) => void changeUpdateTrack(e.target.value)}>
              <option value="stable">{t('settings.updateTrackStable')}</option>
              <option value="dogfood">{t('settings.updateTrackDogfood')}</option>
              <option value="nightly">{t('settings.updateTrackNightly')}</option>
              <option value="lab">{t('settings.updateTrackLab')}</option>
            </select>
          </label>
          {updateStatus?.feedStatus === 'stub-no-feed' && (
            <p className="hint">{t('settings.updateTrackStubHint')}</p>
          )}
          {updateStatus?.updateRequiredByPolicy && (
            <p className="error">{t('settings.updateRequired')}</p>
          )}
          {/* v0.71 (audit): the track selector above showed its
              'stable' default while the status was still loading —
              the loading line now says so, like the other sections. */}
          {updateStatusLoading && (
            <p className="hint" data-testid="update-status-loading">{t('settings.updateStatusLoading')}</p>
          )}
          {/* v0.68c: a failed `updates:get-status` load used to fail
              silently, leaving the track selector on its default — it
              now reports the error with a retry. */}
          {updateStatusError && (
            <>
              <p className="error">{updateStatusError}</p>
              <button className="btn secondary" data-testid="update-status-retry" onClick={() => void reloadUpdateStatus()}>
                {t('settings.retry')}
              </button>
            </>
          )}
          <div style={{ marginTop: 8 }}>
            <button className="btn secondary" disabled={checkingUpdate} onClick={() => void checkUpdate()}>
              {checkingUpdate ? t('settings.updateChecking') : t('settings.updateCheck')}
            </button>
          </div>
          {updateInfo && !updateInfo.checkFailed && !updateInfo.available && (
            <p>{t('settings.updateUpToDate', { version: updateInfo.currentVersion })}</p>
          )}
          {updateInfo && updateInfo.available && (
            <div>
              <p>{t('settings.updateAvailable', { version: updateInfo.latestVersion ?? updateInfo.latestTag ?? '' })}</p>
              <button className="btn secondary" onClick={() => void openUpdateDownload()}>
                {t('settings.updateDownload')}
              </button>
            </div>
          )}
          {updateInfo && updateInfo.checkFailed && (
            <p className="error">{updateInfo.error ?? t('settings.updateFailed')}</p>
          )}
        </section>
      )}

      {show('limits') && (
        <section data-section="limits" className="card">
          <h3>{t('settings.limitsTitle')}</h3>
          {/* v0.69c: the limits used to load silently — a failed load
              left the inputs empty, looking exactly like "no limits
              set". Loading and error + retry are explicit now. */}
          {limitsLoading && (
            <p className="hint" data-testid="limits-loading">{t('settings.limitsLoading')}</p>
          )}
          {limitsError && (
            <>
              <p className="error">{limitsError}</p>
              <button className="btn secondary" data-testid="limits-retry" onClick={() => void reloadLimits()}>
                {t('settings.retry')}
              </button>
            </>
          )}
          <div className="field">
            <label htmlFor="limit-daily">{t('settings.limitsDailyLabel')}</label>
            <input
              id="limit-daily"
              type="number"
              min="0"
              step="0.01"
              value={limits.dailyUsd ?? ''}
              onChange={(e) => setLimits((prev) => ({ ...prev, dailyUsd: e.target.value === '' ? undefined : Number(e.target.value) }))}
            />
          </div>
          <div className="field">
            <label htmlFor="limit-monthly">{t('settings.limitsMonthlyLabel')}</label>
            <input
              id="limit-monthly"
              type="number"
              min="0"
              step="0.01"
              value={limits.monthlyUsd ?? ''}
              onChange={(e) => setLimits((prev) => ({ ...prev, monthlyUsd: e.target.value === '' ? undefined : Number(e.target.value) }))}
            />
          </div>
          <p className="hint">{t('settings.limitsHint')}</p>
          <button className="btn secondary" onClick={() => void saveLimits()}>{t('settings.limitsSave')}</button>
        </section>
      )}

      {show('usageReset') && (
        <section data-section="usageReset" className="card">
          <h3>{t('settings.usageResetTitle')}</h3>
          <div className="row wrap">
            <button className="btn secondary" onClick={() => void resetUsage('day')}>{t('settings.usageResetDay')}</button>
            <button className="btn secondary" onClick={() => void resetUsage('month')}>{t('settings.usageResetMonth')}</button>
            <button className="btn secondary" onClick={() => void resetUsage('all')}>{t('settings.usageResetAll')}</button>
          </div>
        </section>
      )}
    </>
  );
}
