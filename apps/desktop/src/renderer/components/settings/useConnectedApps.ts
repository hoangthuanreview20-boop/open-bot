/**
 * Connected-apps data hook (UI-4, v0.59; v0.67b loading states).
 *
 * Owns the state + IPC that used to live in `SettingsView` for the
 * Connected apps section (M7 `apps:list` / `apps:disconnect`,
 * v0.57 Composio `composio:*`, W11b per-connector OAuth). The logic
 * moved verbatim — only the host changed, from Settings to the
 * standalone `ConnectedAppsView`. No IPC channel, handler or i18n key
 * changed; no secret is stored here (the Composio key draft is cleared
 * after a successful save, as before).
 *
 * v0.67b: the hook also reports first-load state (`appsLoading` /
 * `composioLoading`, true only while the first load is in flight) and
 * exposes `reloadApps` / `reloadComposio`, so the view can show a
 * loading line, an empty state, or an error + retry instead of a blank
 * section while IPC is not ready yet (ui-parity-review.md §3.6 T5).
 */
import { useEffect, useRef, useState } from 'react';
import type { ComposioStateView, ComposioToolkitConnectionView, ConnectedAppView } from '../../types';
import { useT } from '../../i18n/useT';

/**
 * Call a v0.5 window.openBot method by its IPC channel name, falling back
 * to the camelCase spelling. Returns null when the preload side has not
 * exposed the method yet, so the UI degrades instead of crashing.
 */
async function callOpenBot<T>(channel: string, camel: string, ...args: unknown[]): Promise<T | null> {
  const api = window.openBot as unknown as Record<string, unknown>;
  const fn = api[channel] ?? api[camel];
  if (typeof fn !== 'function') return null;
  return (fn as (...a: unknown[]) => Promise<T>).apply(window.openBot, args);
}

export interface ConnectedAppsData {
  connectedApps: ConnectedAppView[];
  appsError: string;
  appsBusy: string | null;
  /** v0.67b: true only while the first `apps:list` load is in flight. */
  appsLoading: boolean;
  /** v0.67b: re-run the apps load (retry button after a load error). */
  reloadApps: () => Promise<void>;
  disconnectApp: (appId: string) => Promise<void>;
  appStatusText: (status: ConnectedAppView['authStatus']) => string;
  /**
   * v0.68b: PAT draft per token app (e.g. GitHub), typed by the user
   * and never prefilled from the Vault. Cleared for that app after a
   * successful save, like the Composio key draft below.
   */
  appTokenDraft: Record<string, string>;
  setAppTokenDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  /** v0.68b: app id whose PAT save is in flight (null when idle). */
  appTokenBusy: string | null;
  /** v0.68b: last PAT save error (empty string when none). */
  appTokenError: string;
  /** v0.68b: save the typed PAT of one token app into the Vault (IPC 'apps:set-token'). */
  saveAppToken: (appId: string) => Promise<void>;
  connectorClientId: Record<string, string>;
  setConnectorClientId: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  connectorClientSecret: Record<string, string>;
  setConnectorClientSecret: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  connectorMessage: string;
  connectorBusy: string | null;
  startConnector: (connectorId: string, providerId: string) => Promise<void>;
  composioState: ComposioStateView | null;
  composioBusy: boolean;
  composioError: string;
  /** v0.67b: true only while the first Composio state load is in flight. */
  composioLoading: boolean;
  /** v0.67b: re-run the Composio state load (retry button after a load error). */
  reloadComposio: () => Promise<void>;
  composioKeyDraft: string;
  setComposioKeyDraft: React.Dispatch<React.SetStateAction<string>>;
  toggleComposioEnabled: (next: boolean) => Promise<void>;
  toggleComposioApp: (toolkit: string, next: boolean) => Promise<void>;
  saveComposioKey: () => Promise<void>;
  clearComposioKey: () => Promise<void>;
  /**
   * v0.88b: Composio user id draft — typed by the user, NEVER
   * prefilled from the Vault (like the key draft). Cleared after a
   * successful save so the id does not stay on screen.
   */
  composioUserIdDraft: string;
  setComposioUserIdDraft: React.Dispatch<React.SetStateAction<string>>;
  /** v0.88b: save the typed user id into the Vault (IPC 'composio:set-user-id'). */
  saveComposioUserId: () => Promise<void>;
  /** v0.88b: delete the user id from the Vault, back to 'local-user' (IPC 'composio:clear-user-id'). */
  clearComposioUserId: () => Promise<void>;
  /**
   * v0.89c (Team E): per-toolkit connection status (IPC
   * 'composio:get-connection-status') — null = never checked in
   * this session; updated only when the user presses the check
   * button.
   */
  composioConnectionStatus: ComposioToolkitConnectionView[] | null;
  /** v0.89c: true while a connection-status check is in flight. */
  composioConnectionChecking: boolean;
  /** v0.89c: error from the most recent check (empty = no error). */
  composioConnectionError: string;
  /** v0.89c: check the status of the enabled toolkits. */
  refreshComposioConnectionStatus: () => Promise<void>;
}

export function useConnectedApps(): ConnectedAppsData {
  const t = useT();
  // M7: connected apps — catalog + auth status + disconnect.
  const [connectedApps, setConnectedApps] = useState<ConnectedAppView[]>([]);
  const [appsError, setAppsError] = useState('');
  const [appsBusy, setAppsBusy] = useState<string | null>(null);
  // v0.67b: first-load flags. The refs remember a load that already
  // completed (even when IPC answered null, i.e. the method is not
  // exposed yet), so later refreshes after a mutation do not flash
  // the loading line over a list that is already on screen. A failed
  // first load leaves the ref unset, so a retry shows loading again.
  const [appsLoading, setAppsLoading] = useState(true);
  const appsLoadedOnce = useRef(false);
  // v0.57: Composio — opt-in integration state (key draft never leaves
  // this component except through the set-key IPC into the Vault).
  const [composioState, setComposioState] = useState<ComposioStateView | null>(null);
  const [composioBusy, setComposioBusy] = useState(false);
  const [composioError, setComposioError] = useState('');
  const [composioLoading, setComposioLoading] = useState(true);
  const composioLoadedOnce = useRef(false);
  const [composioKeyDraft, setComposioKeyDraft] = useState('');
  // v0.88b: Composio user id draft (like the key draft — never prefilled from the Vault).
  const [composioUserIdDraft, setComposioUserIdDraft] = useState('');
  // v0.89c (Team E): per-toolkit connection status — null = never
  // checked in this session; never auto-runs when Settings opens
  // (calling COMPOSIO_MANAGE_CONNECTIONS for a toolkit with no
  // connection starts a pending connection flow — the link expires
  // after 10 minutes and does nothing until the user completes it
  // in the browser).
  const [composioConnectionStatus, setComposioConnectionStatus] = useState<ComposioToolkitConnectionView[] | null>(null);
  const [composioConnectionChecking, setComposioConnectionChecking] = useState(false);
  const [composioConnectionError, setComposioConnectionError] = useState('');
  // W11b: per-connector OAuth (Slack / Gmail / Teams). Client
  // credentials are kept per connector, never prefilled from the
  // Vault, and the secret input is cleared after a successful login.
  const [connectorClientId, setConnectorClientId] = useState<Record<string, string>>({});
  const [connectorClientSecret, setConnectorClientSecret] = useState<Record<string, string>>({});
  const [connectorMessage, setConnectorMessage] = useState('');
  const [connectorBusy, setConnectorBusy] = useState<string | null>(null);
  // v0.68b: PAT drafts for token apps (e.g. GitHub). Same rules as the
  // OAuth secrets above: typed by the user, never prefilled from the
  // Vault, cleared for that app after a successful save.
  const [appTokenDraft, setAppTokenDraft] = useState<Record<string, string>>({});
  const [appTokenBusy, setAppTokenBusy] = useState<string | null>(null);
  const [appTokenError, setAppTokenError] = useState('');

  // M7: load the connected-apps catalog + auth status (IPC 'apps:list').
  // v0.67b: the loading flag covers the first load only (and a retry
  // after a failed first load); the error is cleared when such a load
  // starts so the view shows loading instead of a stale error.
  const loadConnectedApps = async () => {
    const showLoading = !appsLoadedOnce.current;
    if (showLoading) {
      setAppsLoading(true);
      setAppsError('');
    }
    try {
      const list = await callOpenBot<ConnectedAppView[]>('apps:list', 'listConnectedApps');
      if (list) {
        setConnectedApps(list);
        setAppsError('');
      }
      appsLoadedOnce.current = true;
    } catch {
      setAppsError(t('settings.appsLoadError'));
    } finally {
      if (showLoading) setAppsLoading(false);
    }
  };

  // M7: disconnect one app — the token is deleted from the Vault and
  // from the coordinator's shared store, so every bot loses access at
  // once. Returns the fresh app list so the UI updates without reload.
  const disconnectApp = async (appId: string) => {
    setAppsBusy(appId);
    try {
      const list = await callOpenBot<ConnectedAppView[]>('apps:disconnect', 'disconnectConnectedApp', { appId });
      if (list) setConnectedApps(list);
    } catch (e) {
      setAppsError(e instanceof Error ? e.message : t('settings.saveError'));
    } finally {
      setAppsBusy(null);
    }
  };

  // v0.68b: save the PAT of one token app (e.g. GitHub) — the token
  // goes to the Vault via IPC 'apps:set-token' and is never returned
  // to the renderer. Returns the fresh app list so the UI flips to
  // connected without reload; the draft for that app is cleared on
  // success so the token never stays on screen.
  const saveAppToken = async (appId: string) => {
    const draft = (appTokenDraft[appId] ?? '').trim();
    if (!draft) {
      setAppTokenError(t('settings.appsTokenEmpty'));
      return;
    }
    setAppTokenError('');
    setAppTokenBusy(appId);
    try {
      const list = await callOpenBot<ConnectedAppView[]>('apps:set-token', 'setConnectedAppToken', { appId, token: draft });
      setAppTokenDraft((prev) => ({ ...prev, [appId]: '' }));
      if (list) setConnectedApps(list);
    } catch (e) {
      setAppTokenError(e instanceof Error ? e.message : t('settings.saveError'));
    } finally {
      setAppTokenBusy(null);
    }
  };

  // v0.57: Composio — load state, toggle source/app, save/clear the key.
  // Every mutation refreshes `apps:list` too, because enabling or
  // disabling Composio registers or unregisters apps in the catalog.
  const loadComposioState = async () => {
    const showLoading = !composioLoadedOnce.current;
    if (showLoading) {
      setComposioLoading(true);
      setComposioError('');
    }
    try {
      const state = await callOpenBot<ComposioStateView>('composio:get-state', 'getComposioState');
      if (state) {
        setComposioState(state);
        setComposioError('');
      }
      composioLoadedOnce.current = true;
    } catch {
      setComposioError(t('settings.composioLoadError'));
    } finally {
      if (showLoading) setComposioLoading(false);
    }
  };

  // v0.89c (Team E): check the connection status of the enabled
  // toolkits — ONLY when the user presses the button (see the note
  // at the state above).
  const refreshComposioConnectionStatus = async () => {
    if (!composioState) return;
    const enabled = composioState.apps.filter((a) => a.enabled).map((a) => a.toolkit);
    if (enabled.length === 0) return;
    setComposioConnectionChecking(true);
    setComposioConnectionError('');
    try {
      const out = await callOpenBot<ComposioToolkitConnectionView[]>(
        'composio:get-connection-status',
        'getComposioConnectionStatus',
        { toolkits: enabled },
      );
      if (out) setComposioConnectionStatus(out);
    } catch {
      setComposioConnectionError(t('settings.composio.connectionCheckError'));
    } finally {
      setComposioConnectionChecking(false);
    }
  };

  const applyComposioState = async (next: ComposioStateView | null) => {
    if (next) setComposioState(next);
    await loadConnectedApps();
  };

  const toggleComposioEnabled = async (next: boolean) => {
    setComposioBusy(true);
    setComposioError('');
    try {
      const state = await callOpenBot<ComposioStateView>('composio:set-enabled', 'setComposioEnabled', next);
      await applyComposioState(state);
    } catch (e) {
      setComposioError(e instanceof Error ? e.message : t('settings.saveError'));
    } finally {
      setComposioBusy(false);
    }
  };

  const toggleComposioApp = async (toolkit: string, next: boolean) => {
    setComposioBusy(true);
    setComposioError('');
    try {
      const state = await callOpenBot<ComposioStateView>('composio:set-app-enabled', 'setComposioAppEnabled', toolkit, next);
      await applyComposioState(state);
    } catch (e) {
      setComposioError(e instanceof Error ? e.message : t('settings.saveError'));
    } finally {
      setComposioBusy(false);
    }
  };

  const saveComposioKey = async () => {
    if (!composioKeyDraft.trim()) {
      setComposioError(t('settings.composioKeyEmpty'));
      return;
    }
    setComposioBusy(true);
    setComposioError('');
    try {
      const state = await callOpenBot<ComposioStateView>('composio:set-key', 'setComposioKey', composioKeyDraft);
      setComposioKeyDraft('');
      if (state) setComposioState(state);
    } catch (e) {
      setComposioError(e instanceof Error ? e.message : t('settings.saveError'));
    } finally {
      setComposioBusy(false);
    }
  };

  const clearComposioKey = async () => {
    setComposioBusy(true);
    setComposioError('');
    try {
      const state = await callOpenBot<ComposioStateView>('composio:clear-key', 'clearComposioKey');
      if (state) setComposioState(state);
    } catch (e) {
      setComposioError(e instanceof Error ? e.message : t('settings.saveError'));
    } finally {
      setComposioBusy(false);
    }
  };

  // v0.88b: Composio user id — save/clear like the key (draft never
  // prefilled, cleared after a successful save so the id does not
  // stay on screen; changing the id takes effect immediately —
  // main re-seeds the coordinator and the old session is dropped,
  // no app restart needed).
  const saveComposioUserId = async () => {
    if (!composioUserIdDraft.trim()) {
      setComposioError(t('settings.composioUserIdEmpty'));
      return;
    }
    setComposioBusy(true);
    setComposioError('');
    try {
      const state = await callOpenBot<ComposioStateView>('composio:set-user-id', 'setComposioUserId', composioUserIdDraft);
      setComposioUserIdDraft('');
      // v0.89c: changing the user id = changing the account, so the old connection status no longer applies.
      setComposioConnectionStatus(null);
      if (state) setComposioState(state);
    } catch (e) {
      setComposioError(e instanceof Error ? e.message : t('settings.saveError'));
    } finally {
      setComposioBusy(false);
    }
  };

  const clearComposioUserId = async () => {
    setComposioBusy(true);
    setComposioError('');
    try {
      const state = await callOpenBot<ComposioStateView>('composio:clear-user-id', 'clearComposioUserId');
      // v0.89c: back to 'local-user' — the old connection status no longer applies.
      setComposioConnectionStatus(null);
      if (state) setComposioState(state);
    } catch (e) {
      setComposioError(e instanceof Error ? e.message : t('settings.saveError'));
    } finally {
      setComposioBusy(false);
    }
  };

  // W11b: connect one connector through the shared OAuth login
  // (same 'auth:oauth-start' channel as the Google login, plus
  // connectorId so main stores the TokenSet under that connector).
  const startConnector = async (connectorId: string, providerId: string) => {
    setConnectorMessage('');
    setConnectorBusy(connectorId);
    try {
      const res = await callOpenBot<{ ok: boolean; providerId: string; displayName?: string; error?: string }>('auth:oauth-start', 'startOAuthLogin', {
        providerId,
        connectorId,
        clientId: connectorClientId[connectorId] || undefined,
        clientSecret: connectorClientSecret[connectorId] || undefined,
      });
      if (res?.ok) {
        setConnectorMessage(t('settings.oauthSuccess', { name: res.displayName ?? connectorId }));
        setConnectorClientSecret((prev) => ({ ...prev, [connectorId]: '' }));
        await loadConnectedApps();
      } else {
        setConnectorMessage(res?.error ?? t('settings.oauthFailed'));
      }
    } catch (e) {
      setConnectorMessage(e instanceof Error ? e.message : t('settings.oauthFailed'));
    } finally {
      setConnectorBusy(null);
    }
  };

  /** M7: auth-status label of a connected app (literal keys so the i18n test can scan them). */
  const appStatusText = (status: ConnectedAppView['authStatus']): string => {
    if (status === 'connected') return t('settings.appsStatusConnected');
    if (status === 'expired') return t('settings.appsStatusExpired');
    if (status === 'error') return t('settings.appsStatusError');
    if (status === 'local') return t('settings.appsStatusLocal');
    return t('settings.appsStatusNotConnected');
  };

  useEffect(() => {
    void loadConnectedApps();
    void loadComposioState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    connectedApps,
    appsError,
    appsBusy,
    appsLoading,
    reloadApps: loadConnectedApps,
    disconnectApp,
    appStatusText,
    appTokenDraft,
    setAppTokenDraft,
    appTokenBusy,
    appTokenError,
    saveAppToken,
    connectorClientId,
    setConnectorClientId,
    connectorClientSecret,
    setConnectorClientSecret,
    connectorMessage,
    connectorBusy,
    startConnector,
    composioState,
    composioBusy,
    composioError,
    composioLoading,
    reloadComposio: loadComposioState,
    composioKeyDraft,
    setComposioKeyDraft,
    toggleComposioEnabled,
    toggleComposioApp,
    saveComposioKey,
    clearComposioKey,
    composioUserIdDraft,
    setComposioUserIdDraft,
    saveComposioUserId,
    clearComposioUserId,
    composioConnectionStatus,
    composioConnectionChecking,
    composioConnectionError,
    refreshComposioConnectionStatus,
  };
}
