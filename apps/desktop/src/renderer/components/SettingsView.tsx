import { useEffect, useRef, useState } from 'react';
import type {
  ApiStatusView,
  DetectedEnginesView,
  HookCommandView,
  HookLogView,
  HookTestRunView,
  HookView,
  ModelRegistryView,
  OnePasswordBrokerStatusView,
  PerfStatsView,
  PluginView,
  SettingsView as SettingsData,
  SpendStatusData,
  TestGateView,
  UpdateStatusView,
  WebhookView,
} from '../types';
import { setLocale } from '../i18n';
import { useLocale, useT } from '../i18n/useT';
import { clearStoresForNoStorage } from '../store/persistedStore';
import SettingsTabBar from './SettingsTabBar';
import ConfirmModal, { type PendingConfirm } from './ConfirmModal';
import SettingsGeneralTab from './SettingsGeneralTab';
import SettingsBotModelTab from './SettingsBotModelTab';
import SettingsConnectionsTab from './SettingsConnectionsTab';
import SettingsSecurityTab from './SettingsSecurityTab';
import SettingsAdvancedTab from './SettingsAdvancedTab';
import { SETTINGS_TABS, SECTION_TAB, filterSections, type SettingsSectionId, type SettingsTabId } from './settings/settingsTabs';
import type { SettingsShared } from './settings/settingsShared';

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

/** Copy text to the clipboard; returns false when the clipboard is unavailable. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* Fall through to the textarea fallback below. */
  }
  try {
    // Keep the tag name in a variable so the i18n key scan does not
    // mistake the fallback element creation for a translation call.
    const tag = 'textarea';
    const el = document.createElement(tag);
    el.value = text;
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

export const PROVIDER_META: Array<{ id: string; labelKey: string; needsKey: boolean; placeholderBaseUrl: string; cliKind?: string }> = [
  { id: 'openai', labelKey: 'settings.provider.openai', needsKey: true, placeholderBaseUrl: 'https://api.openai.com/v1' },
  { id: 'anthropic', labelKey: 'settings.provider.anthropic', needsKey: true, placeholderBaseUrl: 'https://api.anthropic.com' },
  { id: 'gemini', labelKey: 'settings.provider.gemini', needsKey: true, placeholderBaseUrl: 'https://generativelanguage.googleapis.com' },
  { id: 'xai', labelKey: 'settings.provider.xai', needsKey: true, placeholderBaseUrl: 'https://api.x.ai/v1' },
  // v0.97 (Team T6): dedicated OpenAI-compatible API providers — each
  // gets its own key field (Vault namespace 'provider', key = id) and
  // its own base URL / default model (see providers/index.ts). The
  // test button and the bot model picker pick them up generically.
  { id: 'deepseek', labelKey: 'settings.provider.deepseek', needsKey: true, placeholderBaseUrl: 'https://api.deepseek.com/v1' },
  { id: 'moonshot', labelKey: 'settings.provider.moonshot', needsKey: true, placeholderBaseUrl: 'https://api.moonshot.ai/v1' },
  { id: 'qwen', labelKey: 'settings.provider.qwen', needsKey: true, placeholderBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
  { id: 'mistral', labelKey: 'settings.provider.mistral', needsKey: true, placeholderBaseUrl: 'https://api.mistral.ai/v1' },
  { id: 'groq', labelKey: 'settings.provider.groq', needsKey: true, placeholderBaseUrl: 'https://api.groq.com/openai/v1' },
  { id: 'together', labelKey: 'settings.provider.together', needsKey: true, placeholderBaseUrl: 'https://api.together.xyz/v1' },
  { id: 'cohere', labelKey: 'settings.provider.cohere', needsKey: true, placeholderBaseUrl: 'https://api.cohere.ai/compatibility/v1' },
  { id: 'ollama', labelKey: 'settings.provider.ollama', needsKey: false, placeholderBaseUrl: 'http://localhost:11434' },
  { id: 'openai-compatible', labelKey: 'settings.provider.openaiCompatible', needsKey: true, placeholderBaseUrl: 'https://api.example.com/v1' },
  // M1: CLI provider — no API key, runs through the user's signed-in
  // CLI. `cliKind` is the kind of the matching detected engine; the
  // API key / base URL cards below skip this entry (it lives in the
  // Engines section), and BotForm only shows it while the engine is
  // both enabled and available.
  { id: 'claude-code', labelKey: 'settings.provider.claudeCode', needsKey: false, placeholderBaseUrl: '', cliKind: 'claude' },
  // M2: CLI provider Codex (app-server) + Grok CLI (ACP) — same pattern.
  { id: 'codex', labelKey: 'settings.provider.codex', needsKey: false, placeholderBaseUrl: '', cliKind: 'codex' },
  { id: 'grok-cli', labelKey: 'settings.provider.grokCli', needsKey: false, placeholderBaseUrl: '', cliKind: 'grok' },
  // M3: CLI providers over the shared ACP layer (OpenCode, Gemini CLI,
  // Cursor CLI) + one entry for any user-configured custom ACP CLI.
  // The custom entry uses cliKind 'custom-acp' as a prefix marker:
  // its engines have kinds 'custom-acp:<slug>'.
  { id: 'opencode', labelKey: 'settings.provider.opencode', needsKey: false, placeholderBaseUrl: '', cliKind: 'opencode' },
  { id: 'gemini-cli', labelKey: 'settings.provider.geminiCli', needsKey: false, placeholderBaseUrl: '', cliKind: 'gemini' },
  { id: 'cursor-cli', labelKey: 'settings.provider.cursorCli', needsKey: false, placeholderBaseUrl: '', cliKind: 'cursor' },
  { id: 'custom-acp', labelKey: 'settings.provider.customAcp', needsKey: false, placeholderBaseUrl: '', cliKind: 'custom-acp' },
];

/**
 * Connectors with a browser OAuth flow (W11b). `providerId` is the
 * OAuth provider to sign in with; `id` is the connector id the login
 * feeds (gmail signs in through provider google). Labels come from
 * i18n so the key scan in tests/i18n.test.mjs picks them up the same
 * way it picks up the PROVIDER_META entries above.
 */
export const CONNECTOR_META: Array<{ id: string; providerId: string; labelKey: string }> = [
  { id: 'slack', providerId: 'slack', labelKey: 'settings.connectorSlack' },
  { id: 'gmail', providerId: 'google', labelKey: 'settings.connectorGmail' },
  { id: 'teams', providerId: 'microsoft', labelKey: 'settings.connectorTeams' },
];

export const MODEL_FEATURES: Array<{ id: string; labelKey: string }> = [
  { id: 'chat', labelKey: 'settings.modelsFeatureChat' },
  { id: 'code', labelKey: 'settings.modelsFeatureCode' },
  { id: 'research', labelKey: 'settings.modelsFeatureResearch' },
  { id: 'voice', labelKey: 'settings.modelsFeatureVoice' },
  { id: 'vision', labelKey: 'settings.modelsFeatureVision' },
];

export const WEBHOOK_EVENTS: Array<{ id: string; labelKey: string }> = [
  { id: 'run.done', labelKey: 'settings.apiEventRunDone' },
  { id: 'run.error', labelKey: 'settings.apiEventRunError' },
  { id: 'approval.needed', labelKey: 'settings.apiEventApprovalNeeded' },
  { id: 'automation.notify', labelKey: 'settings.apiEventAutomationNotify' },
];

interface Props {
  onBack: () => void;
  /** Bot currently selected in the sidebar (if any) — the plugin toggle
   * applies to this running bot through `plugin:set-enabled`. */
  botId?: string | null;
  /** Open the standalone Connected apps view (wired by App). */
  onOpenConnectedApps?: () => void;
}

export default function SettingsView({ onBack, botId = null, onOpenConnectedApps }: Props) {
  const t = useT();
  const locale = useLocale();
  const [data, setData] = useState<SettingsData | null>(null);
  const [draft, setDraft] = useState<Record<string, { apiKey: string; baseUrl: string; defaultModel: string }>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  // v0.4: Vault + usage + limits + dream + performance.
  const [vaultSecrets, setVaultSecrets] = useState<Record<string, string[]>>({});
  const [usage, setUsage] = useState<SpendStatusData | null>(null);
  const [limits, setLimits] = useState<{ dailyUsd?: number; monthlyUsd?: number }>({});
  const [dream, setDream] = useState<{ enabled: boolean; idleMinutes: number }>({ enabled: false, idleMinutes: 15 });
  const [perf, setPerf] = useState<PerfStatsView | null>(null);
  const [perfError, setPerfError] = useState('');
  const [clearing, setClearing] = useState(false);
  // v0.5: model registry, Ollama, local API, webhooks, Vault NO_STORAGE.
  const [registry, setRegistry] = useState<ModelRegistryView | null>(null);
  const [registryError, setRegistryError] = useState('');
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaInput, setOllamaInput] = useState('');
  const [pulling, setPulling] = useState(false);
  const [ollamaMessage, setOllamaMessage] = useState('');
  const [apiStatus, setApiStatus] = useState<ApiStatusView | null>(null);
  const [apiPort, setApiPort] = useState(0);
  const [apiError, setApiError] = useState('');
  const [apiSaved, setApiSaved] = useState(false);
  const [apiToken, setApiToken] = useState<string | null>(null);
  const [showApiToken, setShowApiToken] = useState(false);
  const [copied, setCopied] = useState('');
  const [webhooks, setWebhooks] = useState<WebhookView[]>([]);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookEvents, setWebhookEvents] = useState<string[]>(['run.done']);
  const [noStorage, setNoStorage] = useState(false);
  // v0.7: multi-layer login (local account + provider identities),
  // browser OAuth, self-update.
  const [profile, setProfile] = useState<{ userId: string; displayName: string; createdAt: number } | null>(null);
  const [profileName, setProfileName] = useState('');
  const [identities, setIdentities] = useState<Array<{ providerId: string; identity: { id: string; displayName?: string; email?: string } | null }>>([]);
  const [oauthProviders, setOAuthProviders] = useState<Array<{ id: string; label: string }>>([]);
  const [oauthClientId, setOAuthClientId] = useState('');
  const [oauthClientSecret, setOAuthClientSecret] = useState('');
  const [oauthMessage, setOAuthMessage] = useState('');
  const [oauthBusy, setOAuthBusy] = useState(false);
  // W11b: per-connector OAuth (Slack / Gmail / Teams). Client
  // credentials are kept per connector, never prefilled from the
  // Vault, and the secret input is cleared after a successful login.
  const [connectorClientId, setConnectorClientId] = useState<Record<string, string>>({});
  const [connectorClientSecret, setConnectorClientSecret] = useState<Record<string, string>>({});
  const [connectorMessage, setConnectorMessage] = useState('');
  const [connectorBusy, setConnectorBusy] = useState<string | null>(null);
  // v0.59: 1Password broker — status (labels only, never a secret).
  // The section itself lives in the Security tab (SettingsSecurityTab).
  const [onePasswordStatus, setOnePasswordStatus] = useState<OnePasswordBrokerStatusView | null>(null);
  const [onePasswordBusy, setOnePasswordBusy] = useState(false);
  const [onePasswordChecking, setOnePasswordChecking] = useState(false);
  const [onePasswordError, setOnePasswordError] = useState('');
  const [updateInfo, setUpdateInfo] = useState<{ available: boolean; currentVersion: string; latestVersion: string | null; latestTag: string | null; htmlUrl: string | null; checkFailed: boolean; error?: string } | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  // v0.54 (P1-9): per-track updates — full status from the UpdateService.
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusView | null>(null);
  // v0.71 (audit): the update-status load is a first-load async load
  // like the other Settings sections — it used to have no loading
  // state at all, so the track selector showed its 'stable' default
  // as if that were the real track while IPC was still in flight.
  // Same first-load pattern as v0.68c (flag + *LoadedOnce ref +
  // finally); error + retry already existed (v0.68c).
  const [updateStatusLoading, setUpdateStatusLoading] = useState(true);
  const updateStatusLoadedOnce = useRef(false);
  const [updateTrack, setUpdateTrack] = useState('stable');
  // v0.68c (T5 follow-up): first-load flags for every Settings section
  // that loads over IPC — same pattern as `useConnectedApps` in v0.67b:
  // true only while the first load is in flight, cleared in `finally`
  // so a throw can never leave a section stuck on loading, and a
  // `*LoadedOnce` ref remembers a completed first load (even when IPC
  // answered null) so later refreshes do not flash loading over data
  // that is already on screen. A failed first load leaves the ref
  // unset, so a retry shows loading again.
  const [usageLoading, setUsageLoading] = useState(true);
  const usageLoadedOnce = useRef(false);
  const [usageError, setUsageError] = useState('');
  const [vaultLoading, setVaultLoading] = useState(true);
  const vaultLoadedOnce = useRef(false);
  const [vaultError, setVaultError] = useState('');
  const [authLoading, setAuthLoading] = useState(true);
  const authLoadedOnce = useRef(false);
  const [authError, setAuthError] = useState('');
  const [registryLoading, setRegistryLoading] = useState(true);
  const registryLoadedOnce = useRef(false);
  const [ollamaLoading, setOllamaLoading] = useState(true);
  const ollamaLoadedOnce = useRef(false);
  const [ollamaError, setOllamaError] = useState('');
  const [pluginsLoading, setPluginsLoading] = useState(true);
  const pluginsLoadedOnce = useRef(false);
  const [hooksLoading, setHooksLoading] = useState(true);
  const hooksLoadedOnce = useRef(false);
  const [autoApproveLoading, setAutoApproveLoading] = useState(true);
  const autoApproveLoadedOnce = useRef(false);
  const [perfLoading, setPerfLoading] = useState(true);
  const perfLoadedOnce = useRef(false);
  const [apiLoading, setApiLoading] = useState(true);
  const apiLoadedOnce = useRef(false);
  const [webhooksError, setWebhooksError] = useState('');
  const [updateStatusError, setUpdateStatusError] = useState('');
  // v0.69c: the four loaders v0.68c missed — engines, spend limits,
  // Dream, and the NO_STORAGE flag all loaded silently before: a
  // failed engines load left the generic loading line on screen next
  // to the error with no retry, and the other three showed their
  // defaults (no limits / Dream off / NO_STORAGE off) as if that
  // were the real state. Same first-load pattern as v0.68c.
  const [enginesLoading, setEnginesLoading] = useState(true);
  const enginesLoadedOnce = useRef(false);
  const [limitsLoading, setLimitsLoading] = useState(true);
  const limitsLoadedOnce = useRef(false);
  const [limitsError, setLimitsError] = useState('');
  const [dreamLoading, setDreamLoading] = useState(true);
  const dreamLoadedOnce = useRef(false);
  const [dreamError, setDreamError] = useState('');
  const [noStorageLoading, setNoStorageLoading] = useState(true);
  const noStorageLoadedOnce = useRef(false);
  const [noStorageError, setNoStorageError] = useState('');

  // v0.8: plugins (enable/disable from Settings).
  const [plugins, setPlugins] = useState<PluginView[]>([]);
  const [pluginErrors, setPluginErrors] = useState<Array<{ dir: string; error: string }>>([]);
  const [pluginsError, setPluginsError] = useState('');
  // v0.29 (P0-2): hooks (enable/disable from Settings).
  const [hooks, setHooks] = useState<HookView[]>([]);
  const [hooksError, setHooksError] = useState('');
  // v1.01 (T2): shell-command hooks + test gate + execution log.
  const [hookCommands, setHookCommands] = useState<HookCommandView[]>([]);
  const [hookCommandsError, setHookCommandsError] = useState('');
  const [hookCommandsLoading, setHookCommandsLoading] = useState(true);
  const hookCommandsLoadedOnce = useRef(false);
  const [testGate, setTestGate] = useState<TestGateView>({});
  const [testGateError, setTestGateError] = useState('');
  const [testGateSaved, setTestGateSaved] = useState(false);
  const [hookLog, setHookLog] = useState<HookLogView[]>([]);
  const [hookLogError, setHookLogError] = useState('');
  const [hookLogLoading, setHookLogLoading] = useState(true);
  const hookLogLoadedOnce = useRef(false);
  // v0.35 (P1-7): auto-approve rules (allowlist for safe tool calls).
  // Local mirror of the core AutoApproveRule shape (see global.d.ts).
  const [autoApproveRules, setAutoApproveRules] = useState<Array<{
    id: string;
    kind: 'shell' | 'tool';
    enabled: boolean;
    scope: 'global' | 'bot';
    botId?: string;
    pattern?: string;
    tool?: string;
    argsPattern?: Record<string, string | number | boolean>;
    note?: string;
    createdAt: number;
  }>>([]);
  const [autoApproveError, setAutoApproveError] = useState('');
  const [aaKind, setAaKind] = useState<'shell' | 'tool'>('shell');
  const [aaPattern, setAaPattern] = useState('');
  const [aaTool, setAaTool] = useState('');
  const [aaArgsPattern, setAaArgsPattern] = useState('');
  const [aaScope, setAaScope] = useState<'global' | 'bot'>('global');
  const [aaBotId, setAaBotId] = useState('');
  const [aaNote, setAaNote] = useState('');
  // v0.14: template plugin modal + outcome of the running-bot toggle.
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [pluginNotice, setPluginNotice] = useState('');
  // M1: detected CLI engines (Settings -> Engines).
  const [engines, setEngines] = useState<DetectedEnginesView | null>(null);
  const [enginesError, setEnginesError] = useState('');
  const [redetecting, setRedetecting] = useState(false);
  // M4: kind currently being re-detected one by one (its button spins).
  const [redetectingKind, setRedetectingKind] = useState<string | null>(null);
  // M3: "Set CLI…" form for a custom ACP CLI (add, or edit the one
  // being edited). Args are typed as one space-separated string and
  // split on save; the slug (id) cannot change while editing.
  const [customEditingId, setCustomEditingId] = useState<string | null>(null);
  const [customId, setCustomId] = useState('');
  const [customLabel, setCustomLabel] = useState('');
  const [customBinaryPath, setCustomBinaryPath] = useState('');
  const [customAcpArgs, setCustomAcpArgs] = useState('acp');
  const [customStatusArgs, setCustomStatusArgs] = useState('');
  const [customSaving, setCustomSaving] = useState(false);
  // UI-4 (v0.59): active Settings tab + search query. Both live here
  // (not in the tab components) so switching tabs cannot lose state.
  const [activeTab, setActiveTab] = useState<SettingsTabId>('general');
  const [query, setQuery] = useState('');

  // v0.68c: the identities list is the auth section's load signal —
  // the profile and the OAuth provider list are optional extras, so
  // their failures stay silent, but a missing/failed identities list
  // now reports `authError` instead of showing "not connected" for
  // every connector while IPC is still loading.
  const loadAuth = async () => {
    const showLoading = !authLoadedOnce.current;
    if (showLoading) {
      setAuthLoading(true);
      setAuthError('');
    }
    try {
      try {
        const p = await callOpenBot<{ userId: string; displayName: string; createdAt: number }>('auth:profile-get', 'getLocalProfile');
        if (p) {
          setProfile(p);
          setProfileName(p.displayName ?? '');
        }
      } catch {
        /* ignore */
      }
      try {
        const list = await callOpenBot<Array<{ providerId: string; identity: { id: string; displayName?: string; email?: string } | null }>>('auth:identities-list', 'listProviderIdentities');
        if (list) {
          setIdentities(list);
          setAuthError('');
          authLoadedOnce.current = true;
        } else {
          setAuthError(t('settings.authLoadError'));
        }
      } catch {
        setAuthError(t('settings.authLoadError'));
      }
      try {
        const supported = await callOpenBot<Array<{ id: string; label: string }>>('auth:oauth-supported', 'listOAuthProviders');
        if (supported) setOAuthProviders(supported);
      } catch {
        /* ignore */
      }
    } finally {
      if (showLoading) setAuthLoading(false);
    }
  };

  const saveProfileName = async () => {
    setError('');
    try {
      const next = await callOpenBot<{ userId: string; displayName: string; createdAt: number }>('auth:profile-set', 'setLocalProfile', { displayName: profileName });
      if (next) {
        setProfile(next);
        setSaved(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.saveError'));
    }
  };

  const signOutProvider = async (providerId: string) => {
    try {
      await callOpenBot<boolean>('auth:identity-delete', 'deleteProviderIdentity', { providerId });
      await loadAuth();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.saveError'));
    }
  };

  const startOAuth = async (providerId: string) => {
    setOAuthMessage('');
    setOAuthBusy(true);
    try {
      const res = await callOpenBot<{ ok: boolean; providerId: string; displayName?: string; error?: string }>('auth:oauth-start', 'startOAuthLogin', {
        providerId,
        clientId: oauthClientId || undefined,
        clientSecret: oauthClientSecret || undefined,
      });
      if (res?.ok) {
        setOAuthMessage(t('settings.oauthSuccess', { name: res.displayName ?? providerId }));
        setOAuthClientSecret('');
        await loadAuth();
      } else {
        setOAuthMessage(res?.error ?? t('settings.oauthFailed'));
      }
    } catch (e) {
      setOAuthMessage(e instanceof Error ? e.message : t('settings.oauthFailed'));
    } finally {
      setOAuthBusy(false);
    }
  };

  // W11b: connect one connector through the shared OAuth login
  // (same 'auth:oauth-start' channel as the Google login above, plus
  // connectorId so main stores the TokenSet under that connector).
  // Status comes from `identities` (loaded by loadAuth): main reports
  // a connector identity only while its TokenSet exists in the Vault.
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
        await loadAuth();
      } else {
        setConnectorMessage(res?.error ?? t('settings.oauthFailed'));
      }
    } catch (e) {
      setConnectorMessage(e instanceof Error ? e.message : t('settings.oauthFailed'));
    } finally {
      setConnectorBusy(null);
    }
  };

  const checkUpdate = async () => {
    setCheckingUpdate(true);
    try {
      // v0.54 (P1-9): check via the UpdateService (for the selected track) instead
      // of the old `update:check` (stable channel only); map back to the old shape so the
      // display below stays unchanged, while keeping the full status.
      const res = await callOpenBot<UpdateStatusView>('updates:check', 'checkForUpdates', 'manual');
      if (res) {
        setUpdateStatus(res);
        setUpdateTrack(res.track);
        setUpdateInfo({
          available: res.available,
          currentVersion: res.currentVersion,
          latestVersion: res.latestVersion,
          latestTag: res.latestTag,
          htmlUrl: res.htmlUrl,
          checkFailed: res.checkFailed,
          error: res.error,
        });
      } else {
        const legacy = await callOpenBot<{ available: boolean; currentVersion: string; latestVersion: string | null; latestTag: string | null; htmlUrl: string | null; checkFailed: boolean; error?: string }>('update:check', 'checkForUpdate');
        if (legacy) setUpdateInfo(legacy);
      }
    } catch (e) {
      setUpdateInfo({ available: false, currentVersion: '', latestVersion: null, latestTag: null, htmlUrl: null, checkFailed: true, error: e instanceof Error ? e.message : t('settings.updateFailed') });
    } finally {
      setCheckingUpdate(false);
    }
  };

  /** v0.54 (P1-9): change the update track (`setUpdateTrack`) — persisted in main. */
  const changeUpdateTrack = async (track: string) => {
    setUpdateTrack(track);
    try {
      const res = await callOpenBot<UpdateStatusView>('updates:set-track', 'setUpdateTrack', track);
      if (res) {
        setUpdateStatus(res);
        setUpdateTrack(res.track);
      }
    } catch {
      // A failed track change keeps the old track on the next load; the UI does not crash.
    }
  };

  /**
   * v0.54 (P1-9): load the update status when Settings opens (track +
   * latest check). v0.68c: a failed load now reports
   * `updateStatusError` (with a retry in the update section) instead
   * of silently leaving the track selector on its default.
   */
  const loadUpdateStatus = async () => {
    const showLoading = !updateStatusLoadedOnce.current;
    if (showLoading) {
      setUpdateStatusLoading(true);
      setUpdateStatusError('');
    }
    try {
      const res = await callOpenBot<UpdateStatusView>('updates:get-status', 'getUpdateStatus');
      if (res) {
        setUpdateStatus(res);
        setUpdateTrack(res.track);
        setUpdateStatusError('');
        updateStatusLoadedOnce.current = true;
      } else {
        setUpdateStatusError(t('settings.updateStatusLoadError'));
      }
    } catch {
      setUpdateStatusError(t('settings.updateStatusLoadError'));
    } finally {
      if (showLoading) setUpdateStatusLoading(false);
    }
  };

  useEffect(() => {
    void loadUpdateStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openUpdateDownload = async () => {
    if (!updateInfo?.htmlUrl) return;
    try {
      await callOpenBot<boolean>('update:open-download', 'openUpdateDownload', { url: updateInfo.htmlUrl });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.saveError'));
    }
  };

  const loadPerf = async () => {
    const showLoading = !perfLoadedOnce.current;
    if (showLoading) {
      setPerfLoading(true);
      setPerfError('');
    }
    try {
      const res = await window.openBot.getPerfStats();
      if (res.ok && res.pool) {
        setPerf({
          pool: res.pool as PerfStatsView['pool'],
          cache: (res.cache as PerfStatsView['cache']) ?? null,
        });
        setPerfError('');
        perfLoadedOnce.current = true;
      } else {
        setPerfError(t('perf.loadError'));
      }
    } catch {
      setPerfError(t('perf.loadError'));
    } finally {
      if (showLoading) setPerfLoading(false);
    }
  };

  const onClearCache = async () => {
    setClearing(true);
    try {
      const res = await window.openBot.clearCache();
      if (res.ok) await loadPerf();
      else setPerfError(res.error ?? t('perf.clearError'));
    } catch {
      setPerfError(t('perf.clearError'));
    } finally {
      setClearing(false);
    }
  };

  // ---- v0.5: model registry / Ollama / local API / webhooks / NO_STORAGE ----
  // Each load is guarded and best-effort: the preload side may not expose
  // the new methods yet while the coordinator works on main/preload.

  const loadRegistry = async () => {
    const showLoading = !registryLoadedOnce.current;
    if (showLoading) {
      setRegistryLoading(true);
      setRegistryError('');
    }
    try {
      const res = await callOpenBot<ModelRegistryView>('models:list', 'listModels');
      if (res) {
        setRegistry(res);
        setRegistryError('');
        registryLoadedOnce.current = true;
      } else setRegistryError(t('settings.modelsLoadError'));
    } catch {
      setRegistryError(t('settings.modelsLoadError'));
    } finally {
      if (showLoading) setRegistryLoading(false);
    }
  };

  const loadOllama = async () => {
    const showLoading = !ollamaLoadedOnce.current;
    if (showLoading) {
      setOllamaLoading(true);
      setOllamaError('');
    }
    try {
      const res = await callOpenBot<string[]>('models:ollama-list', 'listOllamaModels');
      if (res) {
        setOllamaModels(res);
        setOllamaError('');
        ollamaLoadedOnce.current = true;
      } else setOllamaError(t('settings.modelsOllamaLoadError'));
    } catch {
      setOllamaError(t('settings.modelsOllamaLoadError'));
    } finally {
      if (showLoading) setOllamaLoading(false);
    }
  };

  const loadApi = async () => {
    const showLoading = !apiLoadedOnce.current;
    if (showLoading) {
      setApiLoading(true);
      setApiError('');
      setWebhooksError('');
    }
    try {
      const res = await callOpenBot<ApiStatusView>('api:get', 'getApiStatus');
      if (res) {
        setApiStatus(res);
        setApiPort(res.port);
        // v0.90d: the API is enabled but the server is not running
        // (e.g. port busy after 5 restart attempts) — surface the
        // startup error instead of staying silent.
        setApiError(res.lastError ? t('settings.apiStartFailed', { error: res.lastError }) : '');
        apiLoadedOnce.current = true;
      } else {
        setApiError(t('settings.apiLoadError'));
      }
    } catch {
      setApiError(t('settings.apiLoadError'));
    }
    // v0.68c: a failed webhook list used to look exactly like "no
    // webhooks yet" — it now reports its own error line instead.
    try {
      const list = await callOpenBot<WebhookView[]>('api:webhooks-list', 'listWebhooks');
      if (list) {
        setWebhooks(list);
        setWebhooksError('');
      } else {
        setWebhooksError(t('settings.apiWebhooksLoadError'));
      }
    } catch {
      setWebhooksError(t('settings.apiWebhooksLoadError'));
    } finally {
      if (showLoading) setApiLoading(false);
    }
  };

  const loadNoStorage = async () => {
    const showLoading = !noStorageLoadedOnce.current;
    if (showLoading) {
      setNoStorageLoading(true);
      setNoStorageError('');
    }
    try {
      const res = await callOpenBot<{ enabled: boolean }>('vault:get-nostorage', 'getVaultNoStorage');
      if (res) {
        setNoStorage(res.enabled);
        setNoStorageError('');
        noStorageLoadedOnce.current = true;
      } else {
        setNoStorageError(t('settings.vaultNoStorageLoadError'));
      }
    } catch {
      setNoStorageError(t('settings.vaultNoStorageLoadError'));
    } finally {
      if (showLoading) setNoStorageLoading(false);
    }
  };

  /**
   * v0.59: load the 1Password broker status (labels only, never a
   * secret). Best-effort like loadNoStorage: a missing IPC channel
   * leaves the section showing the load error instead of blocking
   * Settings.
   */
  const loadOnePasswordStatus = async () => {
    try {
      const res = await callOpenBot<OnePasswordBrokerStatusView>('onepassword:status', 'onePasswordStatus');
      if (res) {
        setOnePasswordStatus(res);
        setOnePasswordError('');
      } else {
        setOnePasswordError(t('settings.onePasswordLoadError'));
      }
    } catch {
      setOnePasswordError(t('settings.onePasswordLoadError'));
    }
  };

  /** v0.59: check the 1Password connection again (re-reads status). */
  const checkOnePassword = async () => {
    setOnePasswordChecking(true);
    try {
      await loadOnePasswordStatus();
    } finally {
      setOnePasswordChecking(false);
    }
  };

  /** v0.59: enable/disable the 1Password broker; reverts on failure. */
  const toggleOnePassword = async (enabled: boolean) => {
    const prev = onePasswordStatus;
    setOnePasswordStatus((cur) => (cur ? { ...cur, enabled } : cur));
    setOnePasswordBusy(true);
    setOnePasswordError('');
    try {
      const res = await callOpenBot<{ enabled: boolean }>(
        'onepassword:set-enabled',
        'setOnePasswordEnabled',
        enabled,
      );
      if (res) {
        setOnePasswordStatus((cur) => (cur ? { ...cur, enabled: res.enabled } : cur));
        await loadOnePasswordStatus();
      } else {
        setOnePasswordStatus(prev);
        setOnePasswordError(t('settings.onePasswordSaveError'));
      }
    } catch {
      setOnePasswordStatus(prev);
      setOnePasswordError(t('settings.onePasswordSaveError'));
    } finally {
      setOnePasswordBusy(false);
    }
  };

  const loadPlugins = async () => {
    const showLoading = !pluginsLoadedOnce.current;
    if (showLoading) {
      setPluginsLoading(true);
      setPluginsError('');
    }
    try {
      const res = await callOpenBot<{ plugins: PluginView[]; errors: Array<{ dir: string; error: string }> }>(
        'plugins:list',
        'listPlugins',
      );
      if (res) {
        setPlugins(res.plugins);
        setPluginErrors(res.errors);
        setPluginsError('');
        pluginsLoadedOnce.current = true;
      } else {
        setPluginsError(t('settings.pluginsLoadError'));
      }
    } catch {
      setPluginsError(t('settings.pluginsLoadError'));
    } finally {
      if (showLoading) setPluginsLoading(false);
    }
  };

  /**
   * v0.29 (P0-2): load the built-in hooks (denylist + glob-rules) with
   * their enabled state. Best-effort like loadPlugins: a missing IPC
   * channel leaves the section empty instead of blocking Settings.
   */
  const loadHooks = async () => {
    const showLoading = !hooksLoadedOnce.current;
    if (showLoading) {
      setHooksLoading(true);
      setHooksError('');
    }
    try {
      const list = await callOpenBot<HookView[]>('hooks:list', 'listHooks');
      if (list) {
        setHooks(list);
        setHooksError('');
        hooksLoadedOnce.current = true;
      } else {
        setHooksError(t('settings.hooksLoadError'));
      }
    } catch {
      setHooksError(t('settings.hooksLoadError'));
    } finally {
      if (showLoading) setHooksLoading(false);
    }
  };

  /**
   * v0.35 (P1-7): load the auto-approve rules from the coordinator.
   * Best-effort like loadHooks: a missing IPC channel leaves the
   * section empty instead of blocking Settings.
   */
  const loadAutoApproveRules = async () => {
    const showLoading = !autoApproveLoadedOnce.current;
    if (showLoading) {
      setAutoApproveLoading(true);
      setAutoApproveError('');
    }
    try {
      const list = await callOpenBot<Array<{
        id: string;
        kind: 'shell' | 'tool';
        enabled: boolean;
        scope: 'global' | 'bot';
        botId?: string;
        pattern?: string;
        tool?: string;
        argsPattern?: Record<string, string | number | boolean>;
        note?: string;
        createdAt: number;
      }>>('auto-approve:list', 'listAutoApproveRules');
      if (list) {
        setAutoApproveRules(list);
        setAutoApproveError('');
        autoApproveLoadedOnce.current = true;
      } else {
        setAutoApproveError(t('settings.autoApproveLoadError'));
      }
    } catch {
      setAutoApproveError(t('settings.autoApproveLoadError'));
    } finally {
      if (showLoading) setAutoApproveLoading(false);
    }
  };

  /**
   * M1: load the detected engines list (Settings -> Engines).
   * v0.69c: same first-load pattern as the other loaders — before,
   * a failed load left the generic loading line on screen next to
   * the error (engines stayed null) and offered no retry.
   */
  const loadEngines = async () => {
    const showLoading = !enginesLoadedOnce.current;
    if (showLoading) {
      setEnginesLoading(true);
      setEnginesError('');
    }
    try {
      const res = await callOpenBot<DetectedEnginesView>('engines:list', 'listEngines');
      if (res) {
        setEngines(res);
        setEnginesError('');
        enginesLoadedOnce.current = true;
      } else {
        setEnginesError(t('settings.enginesLoadError'));
      }
    } catch {
      setEnginesError(t('settings.enginesLoadError'));
    } finally {
      if (showLoading) setEnginesLoading(false);
    }
  };

  /** M1: re-scan the machine for CLIs (Re-detect button). */
  const redetectEngines = async () => {
    setRedetecting(true);
    try {
      const res = await callOpenBot<DetectedEnginesView>('engines:redetect', 'redetectEngines');
      if (res) {
        setEngines(res);
        setEnginesError('');
      }
    } catch {
      setEnginesError(t('settings.enginesLoadError'));
    } finally {
      setRedetecting(false);
    }
  };

  /** M4: re-scan just one engine (per-engine Re-detect button). */
  const redetectOneEngine = async (kind: string) => {
    setRedetectingKind(kind);
    try {
      const res = await callOpenBot<DetectedEnginesView>('engines:redetect-one', 'redetectEngine', {
        kind,
      });
      if (res) {
        setEngines(res);
        setEnginesError('');
      }
    } catch {
      setEnginesError(t('settings.enginesLoadError'));
    } finally {
      setRedetectingKind(null);
    }
  };

  /** M1: enable/disable one source; reverts the checkbox when the IPC call fails. */
  const toggleEngine = async (kind: string, enabled: boolean) => {
    const prev = engines;
    setEngines((cur) =>
      cur
        ? {
            ...cur,
            engines: { ...cur.engines, [kind]: { ...cur.engines[kind], enabled } },
          }
        : cur,
    );
    try {
      const res = await callOpenBot<DetectedEnginesView>('engines:set-enabled', 'setEngineEnabled', {
        kind,
        enabled,
      });
      if (res === null) {
        setEngines(prev);
        setEnginesError(t('settings.enginesToggleError'));
        return;
      }
      setEngines(res);
    } catch {
      setEngines(prev);
      setEnginesError(t('settings.enginesToggleError'));
    }
  };

  /**
   * M3: save the "Set CLI…" form — add a new custom ACP CLI, or update
   * the one being edited. Args are split on whitespace; an empty
   * status-args field means "no sign-in check" (status 'unknown').
   * Errors come from the core validator (bad slug, missing binary,
   * secret-looking flag) and are shown verbatim — they carry no secret.
   */
  const saveCustomCli = async () => {
    const acpArgs = customAcpArgs.split(/\s+/).filter((s) => s.length > 0);
    const statusArgs = customStatusArgs.split(/\s+/).filter((s) => s.length > 0);
    setCustomSaving(true);
    try {
      const res = customEditingId
        ? await callOpenBot<DetectedEnginesView>('engines:custom-update', 'updateCustomCli', {
            id: customEditingId,
            label: customLabel.trim(),
            binaryPath: customBinaryPath.trim(),
            acpArgs,
            ...(statusArgs.length > 0 ? { statusArgs } : {}),
          })
        : await callOpenBot<DetectedEnginesView>('engines:custom-add', 'addCustomCli', {
            id: customId.trim(),
            label: customLabel.trim(),
            binaryPath: customBinaryPath.trim(),
            acpArgs,
            ...(statusArgs.length > 0 ? { statusArgs } : {}),
          });
      if (!res) {
        setEnginesError(t('settings.customCliSaveError'));
        return;
      }
      setEngines(res);
      setEnginesError('');
      setCustomEditingId(null);
      setCustomId('');
      setCustomLabel('');
      setCustomBinaryPath('');
      setCustomAcpArgs('acp');
      setCustomStatusArgs('');
    } catch (e) {
      setEnginesError(e instanceof Error ? e.message : t('settings.customCliSaveError'));
    } finally {
      setCustomSaving(false);
    }
  };

  /** M3: fill the "Set CLI…" form with a custom engine to edit it (args re-read from the stored config). */
  const editCustomCli = async (engine: DetectedEnginesView['engines'][string]) => {
    const slug = engine.kind.slice('custom-acp:'.length);
    let acpArgs = 'acp';
    let statusArgs = '';
    try {
      const list = await callOpenBot<
        Array<{ id: string; acpArgs: string[]; statusArgs?: string[] }>
      >('engines:custom-list', 'listCustomClis');
      const cfg = list?.find((c) => c.id === slug);
      if (cfg) {
        acpArgs = cfg.acpArgs.join(' ');
        statusArgs = (cfg.statusArgs ?? []).join(' ');
      }
    } catch {
      // Fall back to the defaults below; saving still validates.
    }
    setCustomEditingId(slug);
    setCustomId(slug);
    setCustomLabel(engine.label);
    setCustomBinaryPath(engine.binaryPath ?? '');
    setCustomAcpArgs(acpArgs);
    setCustomStatusArgs(statusArgs);
    setEnginesError('');
  };

  /** M3: remove a custom ACP CLI (after a confirm); bots using it fail closed afterwards. */
  const removeCustomCli = async (engine: DetectedEnginesView['engines'][string]) => {
    setPendingConfirm({
      title: t('settings.customCliTitle'),
      message: t('settings.customCliRemoveConfirm', { label: engine.label }),
      confirmLabel: t('settings.customCliRemove'),
      onConfirm: () => void doRemoveCustomCli(engine),
    });
  };

  const doRemoveCustomCli = async (engine: DetectedEnginesView['engines'][string]) => {
    try {
      const res = await callOpenBot<DetectedEnginesView>(
        'engines:custom-remove',
        'removeCustomCli',
        { id: engine.kind.slice('custom-acp:'.length) },
      );
      if (!res) {
        setEnginesError(t('settings.customCliSaveError'));
        return;
      }
      setEngines(res);
      setEnginesError('');
      if (customEditingId === engine.kind.slice('custom-acp:'.length)) {
        setCustomEditingId(null);
        setCustomId('');
        setCustomLabel('');
        setCustomBinaryPath('');
        setCustomAcpArgs('acp');
        setCustomStatusArgs('');
      }
    } catch (e) {
      setEnginesError(e instanceof Error ? e.message : t('settings.customCliSaveError'));
    }
  };

  /** Toggle one hook; reverts the checkbox when the IPC call fails. */
  const toggleHook = async (name: string, enabled: boolean) => {
    const prev = hooks;
    setHooks((list) => list.map((h) => (h.name === name ? { ...h, enabled } : h)));
    try {
      const res = await callOpenBot<boolean>('hooks:toggle', 'toggleHook', { name, enabled });
      if (res === null) {
        setHooks(prev);
        setHooksError(t('settings.hooksToggleError'));
        return;
      }
      setHooks((list) => list.map((h) => (h.name === name ? { ...h, enabled: res } : h)));
    } catch {
      setHooks(prev);
      setHooksError(t('settings.hooksToggleError'));
    }
  };

  /**
   * v1.01 (T2): load the shell-command hooks. Best-effort like
   * loadHooks: a missing IPC channel leaves the section empty instead
   * of blocking Settings.
   */
  const loadHookCommands = async () => {
    const showLoading = !hookCommandsLoadedOnce.current;
    if (showLoading) {
      setHookCommandsLoading(true);
      setHookCommandsError('');
    }
    try {
      const list = await callOpenBot<HookCommandView[]>('hooks:commands-list', 'listHookCommands');
      if (list) {
        setHookCommands(list);
        setHookCommandsError('');
        hookCommandsLoadedOnce.current = true;
      } else {
        setHookCommandsError(t('settings.hooksCommandLoadError'));
      }
    } catch {
      setHookCommandsError(t('settings.hooksCommandLoadError'));
    } finally {
      if (showLoading) setHookCommandsLoading(false);
    }
  };

  /**
   * v1.01 (T2): save (create or update) one shell-command hook.
   * Returns an error message when the save fails (validation error
   * from main), null on success. The list + built-in hooks list are
   * reloaded so the new hook shows up with its source.
   */
  const saveHookCommand = async (entry: HookCommandView): Promise<string | null> => {
    setHookCommandsError('');
    try {
      const saved = await callOpenBot<HookCommandView>('hooks:commands-save', 'saveHookCommand', entry);
      if (!saved) {
        setHookCommandsError(t('settings.hooksCommandSaveError'));
        return t('settings.hooksCommandSaveError');
      }
      setHookCommands((list) => {
        const idx = list.findIndex((c) => c.name === saved.name);
        if (idx >= 0) {
          const next = [...list];
          next[idx] = saved;
          return next;
        }
        return [...list, saved];
      });
      await loadHooks();
      return null;
    } catch (e) {
      const message = e instanceof Error ? e.message : t('settings.hooksCommandSaveError');
      setHookCommandsError(message);
      return message;
    }
  };

  /** v1.01 (T2): delete one shell-command hook. */
  const deleteHookCommand = async (name: string) => {
    setHookCommandsError('');
    try {
      const ok = await callOpenBot<boolean>('hooks:commands-delete', 'deleteHookCommand', name);
      if (ok === null) {
        setHookCommandsError(t('settings.hooksCommandSaveError'));
        return;
      }
      if (ok) {
        setHookCommands((list) => list.filter((c) => c.name !== name));
        await loadHooks();
      }
    } catch {
      setHookCommandsError(t('settings.hooksCommandSaveError'));
    }
  };

  /** v1.01 (T2): toggle one shell-command hook (same hooks:toggle channel). */
  const toggleHookCommand = async (name: string, enabled: boolean) => {
    const prev = hookCommands;
    setHookCommands((list) => list.map((c) => (c.name === name ? { ...c, enabled } : c)));
    try {
      const res = await callOpenBot<boolean>('hooks:toggle', 'toggleHook', { name, enabled });
      if (res === null) {
        setHookCommands(prev);
        setHookCommandsError(t('settings.hooksToggleError'));
        return;
      }
      setHookCommands((list) => list.map((c) => (c.name === name ? { ...c, enabled: res } : c)));
    } catch {
      setHookCommands(prev);
      setHookCommandsError(t('settings.hooksToggleError'));
    }
  };

  /**
   * v1.01 (T2): test-run one command hook with a sample event. Returns
   * null when the IPC channel is missing (Settings degrades instead of
   * crashing); the caller shows the error from the thrown message.
   */
  const testHookCommand = async (
    entry: HookCommandView,
    event?: string,
  ): Promise<HookTestRunView | null> => {
    try {
      return await callOpenBot<HookTestRunView>(
        'hooks:commands-test',
        'testHookCommand',
        { entry, event },
      );
    } catch (e) {
      setHookCommandsError(e instanceof Error ? e.message : t('settings.hooksCommandSaveError'));
      return null;
    }
  };

  /** v1.01 (T2): load the test-gate config (SubagentStop). */
  const loadTestGate = async () => {
    try {
      const config = await callOpenBot<TestGateView>('hooks:testgate-get', 'getTestGate');
      if (config) {
        setTestGate(config);
        setTestGateError('');
      }
    } catch {
      setTestGateError(t('settings.hooksTestGateLoadError'));
    }
  };

  /** v1.01 (T2): save the test-gate config. */
  const saveTestGate = async (config: TestGateView) => {
    setTestGateError('');
    setTestGateSaved(false);
    try {
      const saved = await callOpenBot<TestGateView>('hooks:testgate-save', 'saveTestGate', config);
      if (!saved) {
        setTestGateError(t('settings.hooksTestGateSaveError'));
        return;
      }
      setTestGate(saved);
      setTestGateSaved(true);
    } catch (e) {
      setTestGateError(e instanceof Error ? e.message : t('settings.hooksTestGateSaveError'));
    }
  };

  /** v1.01 (T2): load recent hook executions for the log view. */
  const loadHookLog = async () => {
    const showLoading = !hookLogLoadedOnce.current;
    if (showLoading) {
      setHookLogLoading(true);
      setHookLogError('');
    }
    try {
      const list = await callOpenBot<HookLogView[]>('hooks:log-list', 'listHookLog', 100);
      if (list) {
        setHookLog(list);
        setHookLogError('');
        hookLogLoadedOnce.current = true;
      } else {
        setHookLogError(t('settings.hooksLogLoadError'));
      }
    } catch {
      setHookLogError(t('settings.hooksLogLoadError'));
    } finally {
      if (showLoading) setHookLogLoading(false);
    }
  };

  /**
   * Toggle one plugin; reverts the checkbox when the IPC call fails.
   * v0.14: goes through `plugin:set-enabled` so the change also applies
   * to the running bot when one is selected. Main still writes
   * enabled.json first, so newly created bots always see the new state;
   * when no bot is running (or the coordinator cannot apply it) the UI
   * says so instead of pretending the running bot changed.
   */
  const togglePlugin = async (id: string, enabled: boolean) => {
    const prev = plugins;
    setPlugins((list) => list.map((p) => (p.id === id ? { ...p, enabled } : p)));
    setPluginNotice('');
    try {
      const res = await callOpenBot<{
        id: string;
        enabled: boolean;
        appliedToRunning: boolean;
        runningError?: string;
      }>('plugin:set-enabled', 'setPluginEnabled', {
        botId,
        pluginId: id,
        enabled,
      });
      if (res === null) {
        // Preload without the v0.14 channel: fall back to the old toggle
        // (enabled.json only, applies to bots created later).
        const legacy = await callOpenBot<{ id: string; enabled: boolean }>(
          'plugins:toggle',
          'togglePlugin',
          { id, enabled },
        );
        if (legacy === null) {
          setPlugins(prev);
          setPluginsError(t('settings.pluginsToggleError'));
          return;
        }
        setPlugins((list) => list.map((p) => (p.id === id ? { ...p, enabled: legacy.enabled } : p)));
        setPluginNotice(t('settings.pluginsAppliedNewOnly'));
        return;
      }
      setPlugins((list) => list.map((p) => (p.id === id ? { ...p, enabled: res.enabled } : p)));
      if (res.appliedToRunning) {
        setPluginNotice(t('settings.pluginsAppliedRunning'));
      } else if (res.runningError) {
        setPluginNotice(t('settings.pluginsAppliedRunningFailed', { message: res.runningError }));
      } else {
        setPluginNotice(t('settings.pluginsAppliedNewOnly'));
      }
    } catch {
      setPlugins(prev);
      setPluginsError(t('settings.pluginsToggleError'));
    }
  };

  /** Current "providerId:modelId" choice for a feature, or '' when unset. */
  const featureValue = (feature: string): string => {
    if (!registry) return '';
    for (const [pid, entry] of Object.entries(registry.providers)) {
      const assigned = entry.features?.[feature];
      if (!assigned) continue;
      if (assigned.includes(':')) return assigned;
      if (entry.models.some((m) => m.id === assigned)) return `${pid}:${assigned}`;
    }
    return '';
  };

  const setModelChoice = async (feature: string, providerId: string, model: string) => {
    try {
      const res = await callOpenBot<unknown>('models:set-feature', 'setModelFeature', {
        feature,
        providerId,
        model,
      });
      if (res === null) {
        setRegistryError(t('settings.modelsSaveError'));
        return;
      }
      setRegistry((prev) => {
        if (!prev) return prev;
        const providers = { ...prev.providers };
        for (const [pid, entry] of Object.entries(providers)) {
          const features = { ...entry.features };
          if (pid === providerId) features[feature] = model;
          else delete features[feature];
          providers[pid] = { ...entry, features };
        }
        if (feature === 'default') {
          providers[providerId] = { ...providers[providerId], defaultModel: model };
        }
        if (feature === 'fallback') {
          providers[providerId] = { ...providers[providerId], fallbackModel: model };
        }
        return { ...prev, providers };
      });
    } catch {
      setRegistryError(t('settings.modelsSaveError'));
    }
  };

  const changeFeatureModel = async (feature: string, value: string) => {
    if (!value) return;
    const sep = value.indexOf(':');
    if (sep < 0) return;
    await setModelChoice(feature, value.slice(0, sep), value.slice(sep + 1));
  };

  const changeFeatureFlag = async (name: string, enabled: boolean) => {
    try {
      const res = await callOpenBot<unknown>('models:set-flag', 'setFeatureFlag', { name, enabled });
      if (res === null) {
        setRegistryError(t('settings.modelsSaveError'));
        return;
      }
      setRegistry((prev) =>
        prev ? { ...prev, featureFlags: { ...prev.featureFlags, [name]: enabled } } : prev,
      );
    } catch {
      setRegistryError(t('settings.modelsSaveError'));
    }
  };

  const pullOllama = async () => {
    const model = ollamaInput.trim();
    if (!model || pulling) return;
    setPulling(true);
    setOllamaMessage('');
    try {
      const res = await callOpenBot<{ ok: boolean; error?: string }>('models:ollama-pull', 'pullOllamaModel', model);
      if (res === null) {
        setOllamaMessage(t('settings.modelsOllamaPullError', { message: t('settings.modelsLoadError') }));
      } else if (res.ok) {
        setOllamaMessage(t('settings.modelsOllamaPullOk'));
        setOllamaInput('');
        await loadOllama();
      } else {
        setOllamaMessage(
          t('settings.modelsOllamaPullError', { message: res.error ?? t('settings.testFailed') }),
        );
      }
    } catch (e) {
      setOllamaMessage(
        t('settings.modelsOllamaPullError', { message: e instanceof Error ? e.message : t('settings.testFailed') }),
      );
    } finally {
      setPulling(false);
    }
  };

  const saveApi = async () => {
    setApiError('');
    setApiSaved(false);
    try {
      const res = await callOpenBot<ApiStatusView>('api:set', 'setApiStatus', {
        enabled: apiStatus?.enabled ?? false,
        port: apiPort,
      });
      if (res === null) {
        setApiError(t('settings.apiSaveError'));
        return;
      }
      setApiStatus(res);
      setApiPort(res.port);
      setApiSaved(true);
    } catch {
      setApiError(t('settings.apiSaveError'));
    }
  };

  const showToken = async () => {
    try {
      const res = await callOpenBot<{ token: string | null }>('api:get-token', 'getApiToken');
      if (res?.token) {
        setApiToken(res.token);
        setShowApiToken(true);
      }
    } catch {
      setApiError(t('settings.apiLoadError'));
    }
  };

  const regenerateToken = async () => {
    setPendingConfirm({
      title: t('settings.apiTokenTitle'),
      message: t('settings.apiRegenerateConfirm'),
      confirmLabel: t('settings.apiRegenerateToken'),
      onConfirm: () => void doRegenerateToken(),
    });
  };

  const doRegenerateToken = async () => {
    try {
      const res = await callOpenBot<{ token: string }>('api:regenerate-token', 'regenerateApiToken');
      if (res?.token) {
        setApiToken(res.token);
        setShowApiToken(true);
        const status = await callOpenBot<ApiStatusView>('api:get', 'getApiStatus');
        if (status) setApiStatus(status);
      }
    } catch {
      setApiError(t('settings.apiSaveError'));
    }
  };

  const copyAndMark = async (text: string, flag: string) => {
    if (await copyText(text)) {
      setCopied(flag);
      window.setTimeout(() => setCopied((prev) => (prev === flag ? '' : prev)), 2000);
    }
  };

  const addWebhook = async () => {
    const url = webhookUrl.trim();
    if (!url || webhookEvents.length === 0) {
      setApiError(t('settings.apiWebhookAddError'));
      return;
    }
    setApiError('');
    try {
      const created = await callOpenBot<WebhookView>('api:webhooks-add', 'addWebhook', {
        url,
        events: webhookEvents,
      });
      if (!created) {
        setApiError(t('settings.apiWebhookAddError'));
        return;
      }
      setWebhooks((prev) => [...prev, created]);
      setWebhookUrl('');
      setWebhookEvents(['run.done']);
    } catch {
      setApiError(t('settings.apiWebhookAddError'));
    }
  };

  const removeWebhook = async (id: string) => {
    setPendingConfirm({
      title: t('settings.apiWebhooksTitle'),
      message: t('settings.apiWebhookDeleteConfirm'),
      confirmLabel: t('settings.apiWebhookDelete'),
      onConfirm: () => void doRemoveWebhook(id),
    });
  };

  const doRemoveWebhook = async (id: string) => {
    try {
      const ok = await callOpenBot<boolean>('api:webhooks-remove', 'removeWebhook', id);
      if (ok !== false) setWebhooks((prev) => prev.filter((w) => w.id !== id));
    } catch {
      setApiError(t('settings.apiSaveError'));
    }
  };

  const changeNoStorage = async (enabled: boolean) => {
    const prev = noStorage;
    // v0.71: turning NO_STORAGE off while temporary secrets exist asks
    // first — turning it off flushes those secrets to disk by default.
    // The two steps use the shared in-app ConfirmModal (v0.64 replaced
    // the other window.confirm calls; these last two native dialogs are
    // gone too): dialog 1 asks whether to turn it off, dialog 2 offers
    // deleting the temporary secrets instead of saving them. Cancelling
    // dialog 1 changes nothing; cancelling dialog 2 saves (flushes)
    // them. With no temporary secrets left, turn it off as before,
    // without asking. Covered by the real-click test
    // tests/vault-confirm-l5-click.test.mjs.
    if (!enabled && prev) {
      let pending = 0;
      try {
        const status = await callOpenBot<{ enabled: boolean; pendingSecrets?: number }>(
          'vault:get-nostorage',
          'getVaultNoStorage',
        );
        pending = status?.pendingSecrets ?? 0;
      } catch {
        // Could not ask how many temporary secrets exist (IPC error):
        // do not turn it off — report the error instead of turning it
        // off and flushing silently.
        setError(t('settings.vaultNoStorageError'));
        return;
      }
      if (pending > 0) {
        setPendingConfirm({
          title: t('settings.vaultTitle'),
          message: t('settings.vaultNoStorageFlushConfirm', { count: pending }),
          confirmLabel: t('interrupt.continue'),
          danger: false,
          onConfirm: () => {
            setPendingConfirm({
              title: t('settings.vaultTitle'),
              message: t('settings.vaultNoStorageDiscardConfirm', { count: pending }),
              confirmLabel: t('settings.vaultDelete'),
              onConfirm: () => void applyNoStorageChange(false, true),
              onCancel: () => void applyNoStorageChange(false, false),
            });
          },
        });
        return;
      }
    }
    await applyNoStorageChange(enabled, false);
  };

  /**
   * v0.71: the confirmed part of changeNoStorage — flips the toggle
   * (optimistically) and persists it through the vault IPC. Split out
   * so the two-step ConfirmModal flow above can run it from either
   * dialog 2 button (Confirm = delete the temporary secrets, Cancel =
   * save them), while the no-questions path calls it directly.
   */
  const applyNoStorageChange = async (enabled: boolean, discardTemporarySecrets: boolean) => {
    const prev = noStorage;
    setNoStorage(enabled);
    try {
      const res = await callOpenBot<{ enabled: boolean; pendingSecrets?: number }>(
        'vault:set-nostorage',
        'setVaultNoStorage',
        enabled,
        { discardTemporarySecrets },
      );
      if (res === null) {
        setNoStorage(prev);
        setError(t('settings.vaultNoStorageError'));
        return;
      }
      setNoStorage(res.enabled);
      // v0.54 (P1-10): enabling NO_STORAGE deletes every client-persisted store
      // of the renderer (chat drafts, UI layout, ...) — no data stays on disk.
      if (res.enabled) {
        try {
          clearStoresForNoStorage();
        } catch {
          // A failed store delete (telemetry already reported) still leaves the Vault toggle correct.
        }
      }
      if (!enabled && discardTemporarySecrets) {
        // Temporary secrets were deleted — refresh the vault list in the UI.
        try {
          setVaultSecrets(await window.openBot.listVaultSecrets());
        } catch {
          /* Vault list could not be refreshed; the toggle itself is correct. */
        }
      }
    } catch {
      setNoStorage(prev);
      setError(t('settings.vaultNoStorageError'));
    }
  };

  const changeDream = async (next: { enabled: boolean; idleMinutes: number }) => {
    setDream(next);
    try {
      await window.openBot.setDream(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.dreamSaveError'));
    }
  };

  /**
   * v0.20 (W14a): small-model guard toggle for the selected bot. The
   * bot is saved through the existing bots:update IPC (updateBot);
   * the checkbox updates optimistically and reverts when the save
   * fails. Unset in storage means guard on.
   */
  const changeSmallModelGuard = async (enabled: boolean) => {
    const bot = data?.bots.find((b) => b.id === botId);
    if (!bot) return;
    const prev = bot.smallModelGuard ?? true;
    setData((d) =>
      d ? { ...d, bots: d.bots.map((b) => (b.id === bot.id ? { ...b, smallModelGuard: enabled } : b)) } : d,
    );
    try {
      const updated = await window.openBot.updateBot({ ...bot, smallModelGuard: enabled });
      setData((d) =>
        d ? { ...d, bots: d.bots.map((b) => (b.id === updated.id ? updated : b)) } : d,
      );
    } catch (e) {
      setData((d) =>
        d ? { ...d, bots: d.bots.map((b) => (b.id === bot.id ? { ...b, smallModelGuard: prev } : b)) } : d,
      );
      setError(e instanceof Error ? e.message : t('settings.smallModelGuardError'));
    }
  };

  /**
   * v0.96 (Team T2): repo map toggle for the selected bot — same pattern
   * as changeSmallModelGuard above (optimistic update via bots:update,
   * revert on failure). Unset in storage means repo map on.
   */
  const changeRepoMapEnabled = async (enabled: boolean) => {
    const bot = data?.bots.find((b) => b.id === botId);
    if (!bot) return;
    const prev = bot.repoMapEnabled ?? true;
    setData((d) =>
      d ? { ...d, bots: d.bots.map((b) => (b.id === bot.id ? { ...b, repoMapEnabled: enabled } : b)) } : d,
    );
    try {
      const updated = await window.openBot.updateBot({ ...bot, repoMapEnabled: enabled });
      setData((d) =>
        d ? { ...d, bots: d.bots.map((b) => (b.id === updated.id ? updated : b)) } : d,
      );
    } catch (e) {
      setData((d) =>
        d ? { ...d, bots: d.bots.map((b) => (b.id === bot.id ? { ...b, repoMapEnabled: prev } : b)) } : d,
      );
      setError(e instanceof Error ? e.message : t('settings.repoMapError'));
    }
  };

  /**
   * v0.35 (P1-7): add one auto-approve rule from the form below.
   * Tool rules take an optional args pattern as JSON (empty = any
   * args). A rejected rule (dangerous pattern, bad JSON) shows the
   * coordinator error instead of adding a half-valid rule.
   */
  const addAutoApproveRule = async () => {
    setAutoApproveError('');
    let argsPattern: Record<string, string | number | boolean> | undefined;
    if (aaKind === 'tool' && aaArgsPattern.trim() !== '') {
      try {
        const parsed: unknown = JSON.parse(aaArgsPattern);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setAutoApproveError(t('settings.autoApproveArgsJsonError'));
          return;
        }
        argsPattern = parsed as Record<string, string | number | boolean>;
      } catch {
        setAutoApproveError(t('settings.autoApproveArgsJsonError'));
        return;
      }
    }
    const input: Record<string, unknown> = {
      kind: aaKind,
      scope: aaScope,
      ...(aaScope === 'bot' ? { botId: aaBotId } : {}),
      ...(aaKind === 'shell' ? { pattern: aaPattern.trim() } : { tool: aaTool.trim() }),
      ...(argsPattern ? { argsPattern } : {}),
      ...(aaNote.trim() !== '' ? { note: aaNote.trim() } : {}),
    };
    try {
      const created = await callOpenBot<{
        id: string;
        kind: 'shell' | 'tool';
        enabled: boolean;
        scope: 'global' | 'bot';
        botId?: string;
        pattern?: string;
        tool?: string;
        argsPattern?: Record<string, string | number | boolean>;
        note?: string;
        createdAt: number;
      }>('auto-approve:add', 'addAutoApproveRule', input);
      if (created) {
        setAutoApproveRules((prev) => [...prev, created]);
        setAaPattern('');
        setAaTool('');
        setAaArgsPattern('');
        setAaNote('');
      }
    } catch (e) {
      setAutoApproveError(e instanceof Error ? e.message : t('settings.autoApproveSaveError'));
    }
  };

  /** Toggle one rule; reverts the checkbox when the IPC call fails. */
  const toggleAutoApproveRule = async (id: string, enabled: boolean) => {
    const prev = autoApproveRules.find((r) => r.id === id);
    setAutoApproveRules((rules) => rules.map((r) => (r.id === id ? { ...r, enabled } : r)));
    try {
      const updated = await callOpenBot<{
        id: string;
        kind: 'shell' | 'tool';
        enabled: boolean;
        scope: 'global' | 'bot';
        botId?: string;
        pattern?: string;
        tool?: string;
        argsPattern?: Record<string, string | number | boolean>;
        note?: string;
        createdAt: number;
      }>('auto-approve:set-enabled', 'setAutoApproveRuleEnabled', id, enabled);
      if (updated) {
        setAutoApproveRules((rules) => rules.map((r) => (r.id === id ? updated : r)));
      }
    } catch (e) {
      if (prev) {
        setAutoApproveRules((rules) => rules.map((r) => (r.id === id ? prev : r)));
      }
      setAutoApproveError(e instanceof Error ? e.message : t('settings.autoApproveSaveError'));
    }
  };

  /** Delete one rule; reloads the list when the IPC call fails. */
  const removeAutoApproveRule = async (id: string) => {
    try {
      const removed = await callOpenBot<boolean>('auto-approve:remove', 'removeAutoApproveRule', id);
      if (removed !== false) {
        setAutoApproveRules((rules) => rules.filter((r) => r.id !== id));
      }
    } catch (e) {
      setAutoApproveError(e instanceof Error ? e.message : t('settings.autoApproveSaveError'));
      await loadAutoApproveRules();
    }
  };

  const saveLimits = async () => {
    try {
      const next = (await window.openBot.setSpendLimits({
        dailyUsd: limits.dailyUsd || undefined,
        monthlyUsd: limits.monthlyUsd || undefined,
      })) as { dailyUsd?: number; monthlyUsd?: number };
      setLimits(next ?? {});
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.saveError'));
    }
  };

  const resetUsage = async (scope: 'day' | 'month' | 'all') => {
    setPendingConfirm({
      title: t('settings.usageResetTitle'),
      message: t('settings.usageResetConfirm'),
      confirmLabel:
        scope === 'day'
          ? t('settings.usageResetDay')
          : scope === 'month'
            ? t('settings.usageResetMonth')
            : t('settings.usageResetAll'),
      onConfirm: () => void doResetUsage(scope),
    });
  };

  const doResetUsage = async (scope: 'day' | 'month' | 'all') => {
    try {
      const res = await window.openBot.resetUsage(scope);
      setUsage(res.status as SpendStatusData);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.saveError'));
    }
  };

  const deleteVaultKey = async (ns: string, key: string) => {
    setPendingConfirm({
      title: t('settings.vaultTitle'),
      message: t('settings.vaultDeleteConfirm', { key }),
      confirmLabel: t('settings.vaultDelete'),
      onConfirm: () => void doDeleteVaultKey(ns, key),
    });
  };

  const doDeleteVaultKey = async (ns: string, key: string) => {
    try {
      await window.openBot.deleteVaultSecret(ns, key);
      setVaultSecrets(await window.openBot.listVaultSecrets());
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.saveError'));
    }
  };

  /** Usage cost as display text; unknown when the model has no price. */
  const costText = (cost: number | null | undefined): string =>
    typeof cost === 'number' ? `$${cost.toFixed(2)}` : t('settings.usageUnknown');

  // v0.68c: the top-level load is a named function so the "could not
  // load settings" screen can offer a retry instead of leaving the
  // loading line on screen forever after a rejected `getSettings`.
  const loadSettings = async () => {
    setError('');
    try {
      const s = await window.openBot.getSettings();
      setData(s);
      if (s.locale) setLocale(s.locale);
      const d: typeof draft = {};
      for (const meta of PROVIDER_META) {
        const p = s.providers[meta.id];
        d[meta.id] = { apiKey: '', baseUrl: p?.baseUrl ?? '', defaultModel: p?.defaultModel ?? '' };
      }
      setDraft(d);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('settings.loadError'));
    }
  };

  useEffect(() => {
    void loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // v0.68c: usage and Vault used to load inline (and silently) inside
  // loadExtras — the usage section vanished entirely when `getUsage`
  // failed, and the Vault showed "empty" while still loading. Both
  // are named loaders now, with the same first-load pattern as the
  // other sections above.
  const loadUsage = async () => {
    const showLoading = !usageLoadedOnce.current;
    if (showLoading) {
      setUsageLoading(true);
      setUsageError('');
    }
    try {
      const u = await window.openBot.getUsage();
      if (u && typeof u === 'object') {
        setUsage(u as SpendStatusData);
        setUsageError('');
        usageLoadedOnce.current = true;
      } else {
        setUsageError(t('settings.usageLoadError'));
      }
    } catch {
      setUsageError(t('settings.usageLoadError'));
    } finally {
      if (showLoading) setUsageLoading(false);
    }
  };

  const loadVault = async () => {
    const showLoading = !vaultLoadedOnce.current;
    if (showLoading) {
      setVaultLoading(true);
      setVaultError('');
    }
    try {
      setVaultSecrets(await window.openBot.listVaultSecrets());
      setVaultError('');
      vaultLoadedOnce.current = true;
    } catch {
      setVaultError(t('settings.vaultLoadError'));
    } finally {
      if (showLoading) setVaultLoading(false);
    }
  };

  // v0.69c: spend limits and Dream used to load inline (and
  // silently) inside loadExtras — a failed load left the inputs /
  // toggle showing their defaults (no limits / Dream off) as if
  // that were the real state. Both are named loaders now, with the
  // same first-load pattern as the other sections above.
  const loadLimits = async () => {
    const showLoading = !limitsLoadedOnce.current;
    if (showLoading) {
      setLimitsLoading(true);
      setLimitsError('');
    }
    try {
      const l = await window.openBot.getSpendLimits();
      if (l && typeof l === 'object') {
        setLimits(l as { dailyUsd?: number; monthlyUsd?: number });
        setLimitsError('');
        limitsLoadedOnce.current = true;
      } else {
        setLimitsError(t('settings.limitsLoadError'));
      }
    } catch {
      setLimitsError(t('settings.limitsLoadError'));
    } finally {
      if (showLoading) setLimitsLoading(false);
    }
  };

  const loadDream = async () => {
    const showLoading = !dreamLoadedOnce.current;
    if (showLoading) {
      setDreamLoading(true);
      setDreamError('');
    }
    try {
      const d = await window.openBot.getDream();
      if (d && typeof d === 'object') {
        setDream({ enabled: d.enabled, idleMinutes: d.idleMinutes ?? 15 });
        setDreamError('');
        dreamLoadedOnce.current = true;
      } else {
        setDreamError(t('settings.dreamLoadError'));
      }
    } catch {
      setDreamError(t('settings.dreamLoadError'));
    } finally {
      if (showLoading) setDreamLoading(false);
    }
  };

  // v0.4 extras: Vault, usage, spend limits, Dream, performance. Each load
  // is independent and best-effort so one missing IPC does not block the rest.
  useEffect(() => {
    const loadExtras = async () => {
      await loadVault();
      await loadUsage();
      await loadLimits();
      await loadDream();
      await loadPerf();
      await loadRegistry();
      await loadOllama();
      await loadApi();
      await loadNoStorage();
      await loadOnePasswordStatus();
      await loadPlugins();
      await loadHooks();
      await loadHookCommands();
      await loadTestGate();
      await loadHookLog();
      await loadAutoApproveRules();
      await loadEngines();
      await loadAuth();
    };
    void loadExtras();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // M3: live engines snapshot pushed by main after redetect, toggle,
  // or a custom CLI change — refresh this list without a reload.
  useEffect(() => {
    if (typeof window.openBot.onEnginesChanged !== 'function') return undefined;
    return window.openBot.onEnginesChanged((snapshot) => setEngines(snapshot));
  }, []);

  const setField = (id: string, field: 'apiKey' | 'baseUrl' | 'defaultModel', value: string) => {
    setDraft((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
    setSaved(false);
  };

  /** Switch language immediately and persist it so it survives restarts. */
  const changeLocale = async (code: string) => {
    setLocale(code);
    setError('');
    try {
      const next = await window.openBot.setSettings({ locale: code });
      setData(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.saveError'));
    }
  };

  const save = async () => {
    setError('');
    try {
      const providers: Record<string, { apiKey?: string; baseUrl?: string; defaultModel?: string }> = {};
      for (const [id, v] of Object.entries(draft) as Array<
        [string, { apiKey: string; baseUrl: string; defaultModel: string }]
      >) {
        // Empty apiKey = keep the key already stored in main (the renderer
        // never receives the real key back).
        providers[id] = { apiKey: v.apiKey || undefined, baseUrl: v.baseUrl, defaultModel: v.defaultModel };
      }
      const next = await window.openBot.setSettings({ providers, locale });
      setData(next);
      setDraft((prev) => {
        const d = { ...prev };
        for (const id of Object.keys(d)) d[id] = { ...d[id], apiKey: '' };
        return d;
      });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.saveError'));
    }
  };

  const test = async (id: string) => {
    setTesting(id);
    setTestResult((prev) => ({ ...prev, [id]: '' }));
    try {
      // Save first so main tests with the key/baseUrl just entered.
      await save();
      const res = await window.openBot.testConnection(id);
      setTestResult((prev) => ({
        ...prev,
        [id]: res.ok
          ? t('settings.testSuccess')
          : t('common.error', { message: res.error ?? t('settings.testFailed') }),
      }));
    } catch (e) {
      setTestResult((prev) => ({
        ...prev,
        [id]: t('common.error', { message: e instanceof Error ? e.message : t('settings.testError') }),
      }));
    } finally {
      setTesting(null);
    }
  };

  // v0.68c: a failed top-level load used to leave the loading line on
  // screen forever next to the error — it now offers a retry instead.
  if (!data) {
    return (
      <div className="panel">
        {!error && <p>{t('settings.loading')}</p>}
        {error && (
          <>
            <p className="error">{error}</p>
            <button className="btn secondary" data-testid="settings-retry" onClick={() => void loadSettings()}>
              {t('settings.retry')}
            </button>
          </>
        )}
      </div>
    );
  }

  // v0.20 (W14a): bot currently selected in the sidebar — the
  // small-model guard toggle below applies to this bot only.
  const selectedBot = botId ? data.bots.find((b) => b.id === botId) : undefined;

  // UI-4 (v0.59): every tab is pure render over this shared context —
  // all state, IPC and handlers stay in this component, so switching
  // tabs (which unmounts/remounts the tab JSX) cannot lose drafts,
  // toggles or typed input.
  const shared: SettingsShared = {
    t, locale, data, selectedBot, draft, setField, testing, testResult, error, saved,
    save, test, changeLocale, onOpenConnectedApps,
    changeSmallModelGuard,
    changeRepoMapEnabled,
    autoApproveRules, autoApproveError, autoApproveLoading, reloadAutoApprove: loadAutoApproveRules,
    toggleAutoApproveRule, removeAutoApproveRule,
    addAutoApproveRule, aaKind, setAaKind, aaPattern, setAaPattern, aaTool, setAaTool,
    aaArgsPattern, setAaArgsPattern, aaScope, setAaScope, aaBotId, setAaBotId, aaNote, setAaNote,
    usage, costText, limits, setLimits, saveLimits, resetUsage,
    usageLoading, usageError, reloadUsage: loadUsage,
    limitsLoading, limitsError, reloadLimits: loadLimits,
    profile, profileName, setProfileName, saveProfileName, identities, signOutProvider,
    authLoading, authError, reloadAuth: loadAuth,
    oauthProviders, oauthClientId, setOAuthClientId, oauthClientSecret, setOAuthClientSecret,
    oauthMessage, oauthBusy, startOAuth,
    connectorClientId, setConnectorClientId, connectorClientSecret, setConnectorClientSecret,
    connectorMessage, connectorBusy, startConnector,
    updateInfo, checkingUpdate, checkUpdate, openUpdateDownload, updateStatus, updateTrack,
    changeUpdateTrack, updateStatusError, updateStatusLoading, reloadUpdateStatus: loadUpdateStatus,
    vaultSecrets, deleteVaultKey, noStorage, changeNoStorage,
    noStorageLoading, noStorageError, reloadNoStorage: loadNoStorage,
    vaultLoading, vaultError, reloadVault: loadVault,
    onePasswordStatus, onePasswordBusy, onePasswordChecking, onePasswordError,
    toggleOnePassword, checkOnePassword,
    dream, changeDream, dreamLoading, dreamError, reloadDream: loadDream,
    perf, perfError, loadPerf, perfLoading, clearing, onClearCache,
    registry, registryError, featureValue, setModelChoice, changeFeatureModel, changeFeatureFlag,
    registryLoading, reloadRegistry: loadRegistry,
    ollamaModels, ollamaInput, setOllamaInput, pulling, pullOllama, ollamaMessage,
    ollamaLoading, ollamaError, reloadOllama: loadOllama,
    plugins, pluginErrors, pluginsError, pluginNotice, togglePlugin,
    pluginsLoading,
    templateModalOpen, setTemplateModalOpen, loadPlugins, hooks, hooksError, toggleHook,
    hooksLoading, reloadHooks: loadHooks,
    hookCommands, hookCommandsError, hookCommandsLoading, reloadHookCommands: loadHookCommands,
    saveHookCommand, deleteHookCommand, toggleHookCommand, testHookCommand,
    testGate, testGateError, testGateSaved, saveTestGate,
    hookLog, hookLogError, hookLogLoading, reloadHookLog: loadHookLog,
    apiStatus, setApiStatus, apiPort, setApiPort, apiError, apiSaved, saveApi,
    apiLoading, reloadApi: loadApi, webhooksError,
    apiToken, setApiToken, showApiToken, setShowApiToken, showToken, regenerateToken,
    copied, copyAndMark, webhooks, webhookUrl, setWebhookUrl, webhookEvents, setWebhookEvents,
    addWebhook, removeWebhook,
    engines, enginesError, enginesLoading, reloadEngines: loadEngines, redetecting, redetectEngines, redetectingKind,
    toggleEngine, redetectOneEngine, editCustomCli, removeCustomCli,
    customEditingId, setCustomEditingId, customId, setCustomId, customLabel, setCustomLabel,
    customBinaryPath, setCustomBinaryPath, customAcpArgs, setCustomAcpArgs,
    customStatusArgs, setCustomStatusArgs, customSaving, saveCustomCli,
  };

  /** Render one tab; `onlySections` restricts it to search matches. */
  const renderTab = (tabId: SettingsTabId, onlySections?: SettingsSectionId[]) => {
    switch (tabId) {
      case 'general':
        return <SettingsGeneralTab s={shared} onlySections={onlySections} />;
      case 'bot-model':
        return <SettingsBotModelTab s={shared} onlySections={onlySections} />;
      case 'connections':
        return <SettingsConnectionsTab s={shared} onlySections={onlySections} />;
      case 'security':
        return <SettingsSecurityTab s={shared} onlySections={onlySections} />;
      case 'advanced':
        return <SettingsAdvancedTab s={shared} onlySections={onlySections} />;
    }
  };

  // UI-4: a non-empty query shows the matching sections from every tab
  // (grouped under their tab label) instead of the active tab.
  const matched: SettingsSectionId[] | null = query.trim() ? filterSections(query) : null;

  return (
    <div className="panel">
      <button className="btn secondary" onClick={onBack}>{t('settings.back')}</button>
      <h2>{t('settings.title')}</h2>
      <p style={{ color: 'var(--text-dim)' }}>
        {t('settings.intro')}
      </p>
      {error && <p className="error">{error}</p>}
      {saved && <p className="success">{t('settings.saved')}</p>}
      <SettingsTabBar
        tabs={SETTINGS_TABS}
        activeTab={activeTab}
        onSelect={setActiveTab}
        query={query}
        onQueryChange={setQuery}
      />
      {matched ? (
        matched.length === 0 ? (
          <p>{t('settings.searchNoResults', { query: query.trim() })}</p>
        ) : (
          SETTINGS_TABS.map((tab) => {
            const ids = matched.filter((id) => SECTION_TAB[id] === tab.id);
            if (ids.length === 0) return null;
            return (
              <div key={tab.id}>
                <h3>{t(tab.labelKey)}</h3>
                {renderTab(tab.id, ids)}
              </div>
            );
          })
        )
      ) : (
        renderTab(activeTab)
      )}
      {pendingConfirm && (
        <ConfirmModal
          title={pendingConfirm.title}
          message={pendingConfirm.message}
          confirmLabel={pendingConfirm.confirmLabel}
          danger={pendingConfirm.danger ?? true}
          onCancel={() => {
            const c = pendingConfirm;
            setPendingConfirm(null);
            c.onCancel?.();
          }}
          onConfirm={() => {
            const c = pendingConfirm;
            setPendingConfirm(null);
            c.onConfirm();
          }}
        />
      )}
    </div>
  );
}
