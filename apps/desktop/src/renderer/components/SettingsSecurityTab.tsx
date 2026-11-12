/**
 * Security settings tab (UI-4, v0.59) — local account / provider
 * identities / browser OAuth + Vault (incl. NO_STORAGE) + 1Password broker.
 *
 * Pure render over `SettingsShared` (see `settings/settingsShared.ts`):
 * all state, IPC and handlers still live in `SettingsView`. The JSX
 * below moved verbatim from `SettingsView`; only a `data-section`
 * marker and the `onlySections` search filter were added.
 */
import type { SettingsSectionId } from './settings/settingsTabs';
import type { SettingsShared } from './settings/settingsShared';
import CrashReportsSection from './CrashReportsSection';

interface Props {
  s: SettingsShared;
  /** When set (search mode), render only these sections. */
  onlySections?: SettingsSectionId[];
}

export default function SettingsSecurityTab({ s, onlySections }: Props) {
  const {
    t, profile, profileName, setProfileName, saveProfileName, identities,
    authLoading, authError, reloadAuth,
    signOutProvider, oauthProviders, oauthClientId, setOAuthClientId,
    oauthClientSecret, setOAuthClientSecret, oauthBusy, startOAuth, oauthMessage,
    vaultSecrets, deleteVaultKey, noStorage, changeNoStorage,
    noStorageLoading, noStorageError, reloadNoStorage,
    vaultLoading, vaultError, reloadVault,
    onePasswordStatus, onePasswordBusy, onePasswordChecking, onePasswordError,
    toggleOnePassword, checkOnePassword,
  } = s;
  const show = (id: SettingsSectionId) => !onlySections || onlySections.includes(id);
  return (
    <>
      {show('auth') && (
        <section data-section="auth" className="card">
          <h3>{t('settings.authTitle')}</h3>
          <p className="hint">{t('settings.authIntro')}</p>
          {/* v0.68c: while the identities list is loading, the section
              used to claim "no identity" and show no login buttons —
              it now says it is loading, and a failed load reports an
              error + retry instead of "not connected" everywhere. */}
          {authLoading && (
            <p className="hint" data-testid="auth-loading">{t('settings.authLoading')}</p>
          )}
          {authError && (
            <>
              <p className="error">{authError}</p>
              <button className="btn secondary" data-testid="auth-retry" onClick={() => void reloadAuth()}>
                {t('settings.retry')}
              </button>
            </>
          )}
          {profile && (
            <div className="field">
              <label htmlFor="profile-name">{t('settings.authDisplayName')}</label>
              <input
                id="profile-name"
                value={profileName}
                placeholder={t('settings.authDisplayNamePlaceholder')}
                onChange={(e) => setProfileName(e.target.value)}
              />
              <p className="hint">{t('settings.authUserId', { userId: profile.userId })}</p>
              <button className="btn secondary" onClick={() => void saveProfileName()}>
                {t('settings.authSaveName')}
              </button>
            </div>
          )}
          <h4>{t('settings.authIdentitiesTitle')}</h4>
          {!authLoading && !authError && identities.filter((i) => i.identity).length === 0 && <p>{t('settings.authNoIdentity')}</p>}
          {identities.filter((i) => i.identity).map((i) => (
            <div key={i.providerId}>
              <strong>{i.providerId}</strong>
              {': '}
              {i.identity?.displayName ?? i.identity?.email ?? i.identity?.id}
              {' '}
              <button className="btn secondary" onClick={() => void signOutProvider(i.providerId)}>
                {t('settings.authSignOut')}
              </button>
            </div>
          ))}
          <h4>{t('settings.oauthTitle')}</h4>
          <p className="hint">{t('settings.oauthIntro')}</p>
          <div className="field">
            <label htmlFor="oauth-client-id">{t('settings.oauthClientId')}</label>
            <input
              id="oauth-client-id"
              value={oauthClientId}
              placeholder={t('settings.oauthClientIdPlaceholder')}
              onChange={(e) => setOAuthClientId(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="oauth-client-secret">{t('settings.oauthClientSecret')}</label>
            <input
              id="oauth-client-secret"
              type="password"
              value={oauthClientSecret}
              onChange={(e) => setOAuthClientSecret(e.target.value)}
            />
          </div>
          {oauthProviders.map((p) => (
            <button
              key={p.id}
              className="btn secondary"
              disabled={oauthBusy}
              onClick={() => void startOAuth(p.id)}
            >
              {oauthBusy ? t('settings.oauthLoggingIn') : t('settings.oauthLogin', { provider: p.label })}
            </button>
          ))}
          {!authLoading && !authError && oauthProviders.length === 0 && (
            <p className="hint">{t('settings.oauthNoProviders')}</p>
          )}
          {oauthMessage && <p>{oauthMessage}</p>}
        </section>
      )}

      {show('vault') && (
        <section data-section="vault" className="card">
          <h3>{t('settings.vaultTitle')}</h3>
          <p className="hint">{t('settings.vaultIntro')}</p>
          {/* v0.68c: the Vault used to show "empty" while its list was
              still loading, and a failed load looked exactly like an
              empty vault — loading and error + retry are explicit now. */}
          {vaultLoading && (
            <p className="hint" data-testid="vault-loading">{t('settings.vaultLoading')}</p>
          )}
          {vaultError && (
            <>
              <p className="error">{vaultError}</p>
              <button className="btn secondary" data-testid="vault-retry" onClick={() => void reloadVault()}>
                {t('settings.retry')}
              </button>
            </>
          )}
          {!vaultLoading && !vaultError && Object.keys(vaultSecrets).length === 0 && <p>{t('settings.vaultEmpty')}</p>}
          {Object.entries(vaultSecrets).map(([ns, keys]) => (
            <div key={ns}>
              <strong>{ns}</strong>
              <ul>
                {keys.map((k) => (
                  <li key={k}>
                    {k}{' '}
                    <button className="btn secondary" onClick={() => void deleteVaultKey(ns, k)}>
                      {t('settings.vaultDelete')}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="hint">{t('settings.vaultHint')}</p>
          {/* v0.69c: the NO_STORAGE flag used to load silently — a
              failed load left the toggle off, looking exactly like
              the mode being disabled. Loading and error + retry are
              explicit now, per source (the secrets list above has
              its own error + retry). */}
          {noStorageLoading && (
            <p className="hint" data-testid="nostorage-loading">{t('settings.vaultNoStorageLoading')}</p>
          )}
          {noStorageError && (
            <>
              <p className="error">{noStorageError}</p>
              <button className="btn secondary" data-testid="nostorage-retry" onClick={() => void reloadNoStorage()}>
                {t('settings.retry')}
              </button>
            </>
          )}
          <label>
            <input
              type="checkbox"
              checked={noStorage}
              onChange={(e) => void changeNoStorage(e.target.checked)}
            />
            {t('settings.vaultNoStorageLabel')}
          </label>
          <p className="hint">{t('settings.vaultNoStorageHint')}</p>
        </section>
      )}

      {show('onePassword') && (
        <section data-section="onePassword" className="card" data-testid="onepassword-section">
          <h3>{t('settings.onePasswordTitle')}</h3>
          <p className="hint">{t('settings.onePasswordIntro')}</p>
          {onePasswordError && <p className="error">{onePasswordError}</p>}
          {/* v0.68c: a failed status load used to read "Signed out"
              in the status line (the error only showed above it), and
              the Check button was disabled while the status was null,
              so the load could not be retried from here at all. */}
          <p data-testid="onepassword-status">
            {!onePasswordStatus && !onePasswordError
              ? t('settings.onePasswordChecking')
              : !onePasswordStatus
                ? onePasswordError
                : onePasswordStatus && !onePasswordStatus.enabled
                  ? t('settings.onePasswordDisabled')
                  : onePasswordStatus?.state === 'signed-in'
                    ? t('settings.onePasswordSignedIn', { accounts: onePasswordStatus.accounts.join(', ') })
                    : onePasswordStatus?.state === 'unavailable'
                      ? `${t('settings.onePasswordUnavailable')}${onePasswordStatus.reason ? ` — ${onePasswordStatus.reason}` : ''}`
                      : `${t('settings.onePasswordSignedOut')}${onePasswordStatus?.reason ? ` — ${onePasswordStatus.reason}` : ''}`}
          </p>
          {onePasswordStatus?.cliVersion && (
            <p className="hint">{t('settings.onePasswordCliVersion', { version: onePasswordStatus.cliVersion })}</p>
          )}
          {/* v0.73: while the status has not loaded yet (null) the
              checkbox used to render checked=true and enabled, so
              it claimed 1Password was on before anything was
              known — and toggling it called toggleOnePassword
              against a null status (a no-op state update plus a
              real set-enabled IPC call). Unknown now renders
              unchecked + disabled; the Check button stays the
              retry, as fixed in v0.68c. */}
          <label>
            <input
              type="checkbox"
              data-testid="onepassword-enable"
              checked={onePasswordStatus?.enabled ?? false}
              disabled={onePasswordBusy || onePasswordChecking || onePasswordStatus === null}
              onChange={(e) => void toggleOnePassword(e.target.checked)}
            />
            {t('settings.onePasswordEnableLabel')}
          </label>
          <div className="row">
            <button
              className="btn secondary"
              data-testid="onepassword-check"
              onClick={() => void checkOnePassword()}
              disabled={onePasswordChecking || (onePasswordStatus !== null && !onePasswordStatus.enabled)}
            >
              {onePasswordChecking ? t('settings.onePasswordChecking') : t('settings.onePasswordCheck')}
            </button>
          </div>
          <p className="hint">{t('settings.onePasswordGuide')}</p>
        </section>
      )}

      {show('crashReports') && (
        <section data-section="crashReports" className="card" data-testid="crash-reports-section">
          <CrashReportsSection />
        </section>
      )}
    </>
  );
}
