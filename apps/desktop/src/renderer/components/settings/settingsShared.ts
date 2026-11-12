/**
 * Shared render context for the Settings tabs (UI-4, v0.59).
 *
 * `SettingsView` still owns ALL state, IPC calls and handlers — the tab
 * components (`Settings*Tab.tsx`) are pure render: they receive this
 * context as a single `s` prop and destructure the fields they need, so
 * the section JSX moved verbatim and no logic, IPC channel or i18n key
 * changed. Because state lives in the parent, switching tabs (which
 * unmounts/remounts the tab JSX) cannot lose drafts, toggles or input.
 */
import type { Dispatch, SetStateAction } from 'react';
import type {
  ApiStatusView,
  DetectedEnginesView,
  HookView,
  ModelRegistryView,
  OnePasswordBrokerStatusView,
  PerfStatsView,
  PluginView,
  SettingsView as SettingsData,
  SpendStatusData,
  UpdateStatusView,
  WebhookView,
} from '../../types';
import type { TFunction } from '../../i18n/useT';

/** One auto-approve rule — same shape as in `SettingsView` (P1-7). */
export interface AutoApproveRuleView {
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
}

/** One provider identity (local account / OAuth), as in `SettingsView`. */
export interface IdentityView {
  providerId: string;
  identity: { id: string; displayName?: string; email?: string } | null;
}

export interface SettingsShared {
  t: TFunction;
  locale: string;
  data: SettingsData | null;
  /** Bot currently selected in the sidebar (small-model guard target). */
  selectedBot: SettingsData['bots'][number] | undefined;
  /** Draft provider settings (API key inputs are never the stored key). */
  draft: Record<string, { apiKey: string; baseUrl: string; defaultModel: string }>;
  setField: (id: string, field: 'apiKey' | 'baseUrl' | 'defaultModel', value: string) => void;
  testing: string | null;
  testResult: Record<string, string>;
  error: string;
  saved: boolean;
  save: () => Promise<void>;
  test: (id: string) => Promise<void>;
  changeLocale: (code: string) => Promise<void>;
  /** Opens the standalone Connected apps view (App passes it down). */
  onOpenConnectedApps?: () => void;

  // Small-model guard + auto-approve (bot-model tab).
  changeSmallModelGuard: (enabled: boolean) => Promise<void>;
  autoApproveRules: AutoApproveRuleView[];
  autoApproveError: string;
  /** v0.68c: true only while the first auto-approve load is in flight. */
  autoApproveLoading: boolean;
  /** v0.68c: re-run the auto-approve load (retry button after a load error). */
  reloadAutoApprove: () => Promise<void>;
  toggleAutoApproveRule: (id: string, enabled: boolean) => Promise<void>;
  removeAutoApproveRule: (id: string) => Promise<void>;
  addAutoApproveRule: () => Promise<void>;
  aaKind: 'shell' | 'tool';
  setAaKind: Dispatch<SetStateAction<'shell' | 'tool'>>;
  aaPattern: string;
  setAaPattern: Dispatch<SetStateAction<string>>;
  aaTool: string;
  setAaTool: Dispatch<SetStateAction<string>>;
  aaArgsPattern: string;
  setAaArgsPattern: Dispatch<SetStateAction<string>>;
  aaScope: 'global' | 'bot';
  setAaScope: Dispatch<SetStateAction<'global' | 'bot'>>;
  aaBotId: string;
  setAaBotId: Dispatch<SetStateAction<string>>;
  aaNote: string;
  setAaNote: Dispatch<SetStateAction<string>>;

  // Usage + spend limits (general tab).
  usage: SpendStatusData | null;
  costText: (cost: number | null | undefined) => string;
  /** v0.68c: true only while the first usage load is in flight. */
  usageLoading: boolean;
  /** v0.68c: non-empty when the usage load failed (retry via reloadUsage). */
  usageError: string;
  /** v0.68c: re-run the usage load (retry button after a load error). */
  reloadUsage: () => Promise<void>;
  limits: { dailyUsd?: number; monthlyUsd?: number };
  setLimits: Dispatch<SetStateAction<{ dailyUsd?: number; monthlyUsd?: number }>>;
  saveLimits: () => Promise<void>;
  resetUsage: (scope: 'day' | 'month' | 'all') => Promise<void>;
  /** v0.69c: true only while the first limits load is in flight. */
  limitsLoading: boolean;
  /** v0.69c: non-empty when the spend-limits load failed. */
  limitsError: string;
  /** v0.69c: re-run the limits load (retry button after a load error). */
  reloadLimits: () => Promise<void>;

  // Auth / profile / OAuth (security tab) + connectors (connections tab).
  profile: { userId: string; displayName: string; createdAt: number } | null;
  profileName: string;
  setProfileName: Dispatch<SetStateAction<string>>;
  saveProfileName: () => Promise<void>;
  identities: IdentityView[];
  /** v0.68c: true only while the first auth load is in flight. */
  authLoading: boolean;
  /** v0.68c: non-empty when the identities list failed to load. */
  authError: string;
  /** v0.68c: re-run the auth load (retry button after a load error). */
  reloadAuth: () => Promise<void>;
  signOutProvider: (providerId: string) => Promise<void>;
  oauthProviders: Array<{ id: string; label: string }>;
  oauthClientId: string;
  setOAuthClientId: Dispatch<SetStateAction<string>>;
  oauthClientSecret: string;
  setOAuthClientSecret: Dispatch<SetStateAction<string>>;
  oauthMessage: string;
  oauthBusy: boolean;
  startOAuth: (providerId: string) => Promise<void>;
  connectorClientId: Record<string, string>;
  setConnectorClientId: Dispatch<SetStateAction<Record<string, string>>>;
  connectorClientSecret: Record<string, string>;
  setConnectorClientSecret: Dispatch<SetStateAction<Record<string, string>>>;
  connectorMessage: string;
  connectorBusy: string | null;
  startConnector: (connectorId: string, providerId: string) => Promise<void>;

  // Updates (general tab).
  updateInfo: {
    available: boolean;
    currentVersion: string;
    latestVersion: string | null;
    latestTag: string | null;
    htmlUrl: string | null;
    checkFailed: boolean;
    error?: string;
  } | null;
  checkingUpdate: boolean;
  checkUpdate: () => Promise<void>;
  openUpdateDownload: () => Promise<void>;
  updateStatus: UpdateStatusView | null;
  updateTrack: string;
  changeUpdateTrack: (track: string) => Promise<void>;
  /** v0.68c: non-empty when the update-status load failed. */
  updateStatusError: string;
  /** v0.71 (audit): true only while the first update-status load is in flight. */
  updateStatusLoading: boolean;
  /** v0.68c: re-run the update-status load (retry button after a load error). */
  reloadUpdateStatus: () => Promise<void>;

  // Vault (security tab).
  vaultSecrets: Record<string, string[]>;
  deleteVaultKey: (ns: string, key: string) => Promise<void>;
  /** v0.68c: true only while the first Vault load is in flight. */
  vaultLoading: boolean;
  /** v0.68c: non-empty when the Vault list failed to load. */
  vaultError: string;
  /** v0.68c: re-run the Vault load (retry button after a load error). */
  reloadVault: () => Promise<void>;
  noStorage: boolean;
  changeNoStorage: (enabled: boolean) => Promise<void>;
  /** v0.69c: true only while the first NO_STORAGE load is in flight. */
  noStorageLoading: boolean;
  /** v0.69c: non-empty when the NO_STORAGE flag failed to load. */
  noStorageError: string;
  /** v0.69c: re-run the NO_STORAGE load (retry button after a load error). */
  reloadNoStorage: () => Promise<void>;

  // 1Password broker (security tab, v0.59).
  onePasswordStatus: OnePasswordBrokerStatusView | null;
  onePasswordBusy: boolean;
  onePasswordChecking: boolean;
  onePasswordError: string;
  toggleOnePassword: (enabled: boolean) => Promise<void>;
  checkOnePassword: () => Promise<void>;

  // Dream + performance (advanced tab).
  dream: { enabled: boolean; idleMinutes: number };
  changeDream: (next: { enabled: boolean; idleMinutes: number }) => Promise<void>;
  /** v0.69c: true only while the first Dream load is in flight. */
  dreamLoading: boolean;
  /** v0.69c: non-empty when the Dream settings failed to load. */
  dreamError: string;
  /** v0.69c: re-run the Dream load (retry button after a load error). */
  reloadDream: () => Promise<void>;
  perf: PerfStatsView | null;
  perfError: string;
  loadPerf: () => Promise<void>;
  /** v0.68c: true only while the first perf load is in flight. */
  perfLoading: boolean;
  clearing: boolean;
  onClearCache: () => Promise<void>;

  // Model registry + Ollama (bot-model tab).
  registry: ModelRegistryView | null;
  registryError: string;
  /** v0.68c: true only while the first registry load is in flight. */
  registryLoading: boolean;
  /** v0.68c: re-run the registry load (retry button after a load error). */
  reloadRegistry: () => Promise<void>;
  featureValue: (feature: string) => string;
  setModelChoice: (feature: string, providerId: string, model: string) => Promise<void>;
  changeFeatureModel: (feature: string, value: string) => Promise<void>;
  changeFeatureFlag: (name: string, enabled: boolean) => Promise<void>;
  ollamaModels: string[];
  ollamaInput: string;
  setOllamaInput: Dispatch<SetStateAction<string>>;
  pulling: boolean;
  pullOllama: () => Promise<void>;
  ollamaMessage: string;
  /** v0.68c: true only while the first Ollama list load is in flight. */
  ollamaLoading: boolean;
  /** v0.68c: non-empty when the Ollama list failed to load. */
  ollamaError: string;
  /** v0.68c: re-run the Ollama list load (retry button after a load error). */
  reloadOllama: () => Promise<void>;

  // Plugins + hooks (advanced tab).
  plugins: PluginView[];
  pluginErrors: Array<{ dir: string; error: string }>;
  pluginsError: string;
  /** v0.68c: true only while the first plugins load is in flight. */
  pluginsLoading: boolean;
  pluginNotice: string;
  togglePlugin: (id: string, enabled: boolean) => Promise<void>;
  templateModalOpen: boolean;
  setTemplateModalOpen: Dispatch<SetStateAction<boolean>>;
  loadPlugins: () => Promise<void>;
  hooks: HookView[];
  hooksError: string;
  /** v0.68c: true only while the first hooks load is in flight. */
  hooksLoading: boolean;
  /** v0.68c: re-run the hooks load (retry button after a load error). */
  reloadHooks: () => Promise<void>;
  toggleHook: (name: string, enabled: boolean) => Promise<void>;

  // Local API + token + webhooks (advanced tab).
  apiStatus: ApiStatusView | null;
  setApiStatus: Dispatch<SetStateAction<ApiStatusView | null>>;
  apiPort: number;
  setApiPort: Dispatch<SetStateAction<number>>;
  apiError: string;
  /** v0.68c: true only while the first API-status load is in flight. */
  apiLoading: boolean;
  /** v0.68c: re-run the API-status load (retry button after a load error). */
  reloadApi: () => Promise<void>;
  /** v0.68c: non-empty when the webhook list failed to load. */
  webhooksError: string;
  apiSaved: boolean;
  saveApi: () => Promise<void>;
  apiToken: string | null;
  setApiToken: Dispatch<SetStateAction<string | null>>;
  showApiToken: boolean;
  setShowApiToken: Dispatch<SetStateAction<boolean>>;
  showToken: () => Promise<void>;
  regenerateToken: () => Promise<void>;
  copied: string;
  copyAndMark: (text: string, flag: string) => Promise<void>;
  webhooks: WebhookView[];
  webhookUrl: string;
  setWebhookUrl: Dispatch<SetStateAction<string>>;
  webhookEvents: string[];
  setWebhookEvents: Dispatch<SetStateAction<string[]>>;
  addWebhook: () => Promise<void>;
  removeWebhook: (id: string) => Promise<void>;

  // Engines + custom CLIs (bot-model tab).
  engines: DetectedEnginesView | null;
  enginesError: string;
  /** v0.69c: true only while the first engines load is in flight. */
  enginesLoading: boolean;
  /** v0.69c: re-run the engines load (retry button after a load error). */
  reloadEngines: () => Promise<void>;
  redetecting: boolean;
  redetectEngines: () => Promise<void>;
  redetectingKind: string | null;
  toggleEngine: (kind: string, enabled: boolean) => Promise<void>;
  redetectOneEngine: (kind: string) => Promise<void>;
  editCustomCli: (engine: DetectedEnginesView['engines'][string]) => Promise<void>;
  removeCustomCli: (engine: DetectedEnginesView['engines'][string]) => Promise<void>;
  customEditingId: string | null;
  setCustomEditingId: Dispatch<SetStateAction<string | null>>;
  customId: string;
  setCustomId: Dispatch<SetStateAction<string>>;
  customLabel: string;
  setCustomLabel: Dispatch<SetStateAction<string>>;
  customBinaryPath: string;
  setCustomBinaryPath: Dispatch<SetStateAction<string>>;
  customAcpArgs: string;
  setCustomAcpArgs: Dispatch<SetStateAction<string>>;
  customStatusArgs: string;
  setCustomStatusArgs: Dispatch<SetStateAction<string>>;
  customSaving: boolean;
  saveCustomCli: () => Promise<void>;
}
