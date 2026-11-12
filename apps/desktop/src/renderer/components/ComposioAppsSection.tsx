/**
 * ComposioAppsSection (v0.57) — the Composio panel in Settings → Connected apps.
 *
 * Props-driven, it does NOT call IPC directly: the host (SettingsView) passes
 * state + callbacks; main connects the callbacks to the IPC channels
 * `composio:get-state` / `composio:set-enabled` / `composio:set-app-enabled` /
 * `composio:set-key` / `composio:clear-key` / `composio:set-user-id` /
 * `composio:clear-user-id` (see docs/composio-integration.md §6, §17).
 *
 * i18n: all display strings live in locales/*.json under `settings.composio.*`
 * and are read through useT() — no hard-coded strings in this file.
 */

import { useT } from '../i18n/useT';
import type { ComposioToolkitConnectionView } from '../types';

export interface ComposioAppToggle {
  /** Toolkit slug, e.g. 'gmail'. */
  toolkit: string;
  /** Display name, e.g. 'Gmail (via Composio)'. */
  label: string;
  /** Display icon. */
  icon: string;
  /** Whether the toolkit is enabled. */
  enabled: boolean;
}

export interface ComposioAppsSectionProps {
  /** Whether the whole Composio integration is enabled (off by default). */
  enabled: boolean;
  /** Whether a Composio API key is configured in the Vault (boolean only). */
  keyConfigured: boolean;
  /**
   * v0.88b: whether a Composio user id is configured in the Vault
   * (boolean only — the id itself is never shown in the UI).
   */
  userIdConfigured: boolean;
  /** The user id draft the user typed (never prefilled from the Vault). */
  userIdDraft: string;
  /** Update the user id draft. */
  onUserIdDraftChange: (next: string) => void;
  /** Save the typed user id (the host calls the set-user-id IPC). */
  onSaveUserId: () => void;
  /** Delete the user id from the Vault (back to 'local-user'). */
  onClearUserId: () => void;
  /** The 4 toolkits + each app's on/off state. */
  apps: ComposioAppToggle[];
  /** Busy (saving a toggle/key) — buttons are disabled while waiting. */
  busy: boolean;
  /** The latest error message (displayed, never contains a key). */
  error?: string;
  /** Toggle the whole source on/off. */
  onToggleEnabled: (next: boolean) => void;
  /** Toggle one toolkit. */
  onToggleApp: (toolkit: string, next: boolean) => void;
  /** Save a new key (the host opens the key input, then calls the set-key IPC). */
  onSetKey: () => void;
  /** Delete the key from the Vault. */
  onClearKey: () => void;
  /**
   * v0.89c (Team E): per-toolkit connection status — null = never
   * checked in this session (updated only when the user presses the
   * check button; see the note at the display block).
   */
  connectionStatus: ComposioToolkitConnectionView[] | null;
  /** v0.89c: true while a connection-status check is in flight. */
  connectionChecking: boolean;
  /** v0.89c: error from the most recent check (empty = no error). */
  connectionError?: string;
  /** v0.89c: check the status of the enabled toolkits. */
  onCheckConnectionStatus: () => void;
}

export function ComposioAppsSection(props: ComposioAppsSectionProps) {
  const t = useT();
  return (
    <section className="card">
      <h3>{t('settings.composio.title')}</h3>
      <p className="hint">{t('settings.composio.intro')}</p>
      <p className="hint">{t('settings.composio.custody')}</p>
      {props.error && <p className="error">{props.error}</p>}
      <div>
        <button
          className="btn secondary"
          disabled={props.busy}
          onClick={() => void props.onToggleEnabled(!props.enabled)}
        >
          {props.enabled ? t('settings.composio.disable') : t('settings.composio.enable')}
        </button>{' '}
        <span className="hint">
          {props.enabled ? t('settings.composio.appEnabled') : t('settings.composio.appDisabled')}
        </span>
      </div>
      <p className="hint">
        {props.keyConfigured ? t('settings.composio.keyConfigured') : t('settings.composio.keyMissing')}
      </p>
      <div>
        <button className="btn secondary" disabled={props.busy} onClick={() => void props.onSetKey()}>
          {t('settings.composio.setKey')}
        </button>{' '}
        {props.keyConfigured && (
          <button className="btn secondary" disabled={props.busy} onClick={() => void props.onClearKey()}>
            {t('settings.composio.clearKey')}
          </button>
        )}
      </div>
      {/* v0.88b: Composio user id — a session only sees the
          connections already linked in the dashboard when it uses
          that account's user id ('local-user' does not). The id is
          not a secret like the key, but the UI only reports
          configured/not-configured and never shows the value; the
          input is never prefilled from the Vault. Saving/clearing
          takes effect immediately (old session dropped), no app
          restart needed. */}
      <p className="hint">
        {props.userIdConfigured
          ? t('settings.composio.userIdConfigured')
          : t('settings.composio.userIdMissing')}
      </p>
      <p className="hint">{t('settings.composio.userIdHint')}</p>
      <div>
        <label htmlFor="composio-user-id">{t('settings.composio.userIdLabel')}</label>{' '}
        <input
          id="composio-user-id"
          type="text"
          autoComplete="off"
          value={props.userIdDraft}
          placeholder={t('settings.composio.userIdPlaceholder')}
          onChange={(e) => props.onUserIdDraftChange(e.target.value)}
        />{' '}
        <button className="btn secondary" disabled={props.busy} onClick={() => void props.onSaveUserId()}>
          {t('settings.composio.userIdSave')}
        </button>{' '}
        {props.userIdConfigured && (
          <button className="btn secondary" disabled={props.busy} onClick={() => void props.onClearUserId()}>
            {t('settings.composio.clearUserId')}
          </button>
        )}
      </div>
      {props.enabled && (
        <div>
          <h4>{t('settings.composio.appsTitle')}</h4>
          {!props.keyConfigured && <p className="hint">{t('settings.composio.needsKey')}</p>}
          {props.apps.map((app) => (
            <div key={app.toolkit}>
              <h4>
                {app.icon} {app.label} —{' '}
                {app.enabled ? t('settings.composio.appEnabled') : t('settings.composio.appDisabled')}
              </h4>
              <button
                className="btn secondary"
                disabled={props.busy || !props.keyConfigured}
                onClick={() => void props.onToggleApp(app.toolkit, !app.enabled)}
              >
                {app.enabled ? t('settings.composio.turnOff') : t('settings.composio.turnOn')}
              </button>
            </div>
          ))}

          {/* v0.89c (Team E): per-toolkit connection status —
              runs ONLY when the user presses "Check" (never on its
              own when Settings opens, because calling
              COMPOSIO_MANAGE_CONNECTIONS for a toolkit with no
              connection starts a pending connection flow — the link
              expires after 10 minutes and does nothing until the
              user completes it in the browser). */}
          <h4>{t('settings.composio.connectionTitle')}</h4>
          <p className="hint">{t('settings.composio.connectionHint')}</p>
          {props.connectionStatus === null && (
            <p className="hint">{t('settings.composio.connectionNotChecked')}</p>
          )}
          {props.connectionStatus !== null &&
            props.apps
              .filter((app) => app.enabled)
              .map((app) => {
                const found = props.connectionStatus?.find((s) => s.toolkit === app.toolkit);
                const status = found?.status ?? 'none';
                return (
                  <div key={app.toolkit}>
                    <span>
                      {app.icon} {app.label} —{' '}
                      {status === 'active'
                        ? t('settings.composio.connectionActive')
                        : status === 'initiated'
                          ? t('settings.composio.connectionInitiated')
                          : t('settings.composio.connectionNone')}
                      {status === 'active' && found?.accountLabel
                        ? ` (${t('settings.composio.connectionAccount', { label: found.accountLabel })})`
                        : ''}
                    </span>
                  </div>
                );
              })}
          {props.connectionError && <p className="error">{props.connectionError}</p>}
          <button
            className="btn secondary"
            disabled={props.busy || props.connectionChecking || !props.keyConfigured}
            onClick={() => void props.onCheckConnectionStatus()}
          >
            {props.connectionChecking
              ? t('settings.composio.connectionChecking')
              : t('settings.composio.connectionCheck')}
          </button>

          <p className="hint">{t('settings.composio.routerNote')}</p>
        </div>
      )}
    </section>
  );
}
