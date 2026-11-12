/**
 * Harness entry for tests/settings-loading-v068c-renderer.test.mjs.
 *
 * Bundled with esbuild (see the test) and mounted in a bare Electron
 * window — no main process, no preload. Two mounting modes:
 *
 * 1. `__mountSettingsTab(tab, scenario)` mounts one real Settings tab
 *    component with a fake `SettingsShared` object, so each scenario
 *    controls exactly what the tab sees (loading / error / loaded).
 *    Every reload stub records its call and re-mounts the same tab
 *    with the matching "loaded" scenario, so a retry click must turn
 *    the error state into the loaded state.
 *
 * 2. `__mountSettingsTopError()` mounts the real `SettingsView` with
 *    a mocked `window.openBot` whose `getSettings` rejects once and
 *    answers on the retry, covering the top-level load failure.
 *
 * 3. `__mountSkills(scenario)` mounts the real `SkillsView` with a
 *    mocked `window.openBot` controlling `listSkills`.
 *
 * The mock data holds no secret and no real account. The tab `t`
 * function reads the real vi.json so assertions can check the real
 * Vietnamese strings, exactly like the v0.67b harness.
 *
 * Comments are English only: the i18n test scans TSX files for
 * Vietnamese diacritics, comments included.
 */
import { createRoot, type Root } from 'react-dom/client';
import SettingsView from '../../apps/desktop/src/renderer/components/SettingsView';
import SettingsGeneralTab from '../../apps/desktop/src/renderer/components/SettingsGeneralTab';
import SettingsBotModelTab from '../../apps/desktop/src/renderer/components/SettingsBotModelTab';
import SettingsConnectionsTab from '../../apps/desktop/src/renderer/components/SettingsConnectionsTab';
import SettingsSecurityTab from '../../apps/desktop/src/renderer/components/SettingsSecurityTab';
import SettingsAdvancedTab from '../../apps/desktop/src/renderer/components/SettingsAdvancedTab';
import SkillsView from '../../apps/desktop/src/renderer/components/SkillsView';
import type { SettingsShared } from '../../apps/desktop/src/renderer/components/settings/settingsShared';
import vi from '../../apps/desktop/src/renderer/i18n/locales/vi.json';

export type SettingsTabId = 'general' | 'bot-model' | 'connections' | 'security' | 'advanced';

type TFn = (key: string, vars?: Record<string, unknown>) => string;
const t: TFn = (key, vars) => {
  let s: string = (vi as Record<string, string>)[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
};

const noop = (): void => {};
const asyncNoop = async (): Promise<void> => {};
const neverSettles = (): Promise<never> => new Promise(() => {
  // Intentionally never resolves: the loading state must stay visible.
});

const SAMPLE_USAGE = {
  today: { inputTokens: 10, outputTokens: 5, costUsd: 0.01, calls: 1, unpricedCalls: 0, percentUsed: null },
  month: { inputTokens: 20, outputTokens: 10, costUsd: 0.02, calls: 2, unpricedCalls: 0, percentUsed: null },
  total: { inputTokens: 30, outputTokens: 15, costUsd: 0.03, calls: 3, unpricedCalls: 0, percentUsed: null },
};

const SAMPLE_REGISTRY = {
  providers: {
    openai: {
      models: [{ id: 'gpt-x', label: 'GPT X' }],
      defaultModel: 'gpt-x',
      fallbackModel: 'gpt-x',
      features: {},
    },
  },
  featureFlags: {},
};

const SAMPLE_PERF = {
  pool: {
    workers: 2, busyWorkers: 0, idleWorkers: 2, pending: 0, running: 0,
    completed: 1, failed: 0, cancelled: 0, effectiveConcurrency: 2,
  },
  cache: null,
};

let root: Root | null = null;
const calls: string[] = [];
let currentTab: SettingsTabId = 'general';

function reloadStub(name: string, nextScenario: string): () => Promise<void> {
  return async () => {
    calls.push(name);
    mountTab(currentTab, nextScenario);
  };
}

function baseShared(): Record<string, unknown> {
  return {
    t,
    locale: 'vi',
    data: { providers: {}, bots: [], locale: 'vi' },
    selectedBot: undefined,
    draft: {},
    setField: noop,
    testing: null,
    testResult: {},
    error: '',
    saved: false,
    save: asyncNoop,
    test: asyncNoop,
    changeLocale: asyncNoop,
    onOpenConnectedApps: noop,
    changeSmallModelGuard: asyncNoop,
    autoApproveRules: [],
    autoApproveError: '',
    autoApproveLoading: false,
    reloadAutoApprove: reloadStub('reloadAutoApprove', 'auto-approve-loaded'),
    toggleAutoApproveRule: asyncNoop,
    removeAutoApproveRule: asyncNoop,
    addAutoApproveRule: asyncNoop,
    aaKind: 'shell',
    setAaKind: noop,
    aaPattern: '',
    setAaPattern: noop,
    aaTool: '',
    setAaTool: noop,
    aaArgsPattern: '',
    setAaArgsPattern: noop,
    aaScope: 'global',
    setAaScope: noop,
    aaBotId: '',
    setAaBotId: noop,
    aaNote: '',
    setAaNote: noop,
    usage: null,
    costText: (c: number | null | undefined) => (typeof c === 'number' ? `$${c.toFixed(2)}` : 'unknown'),
    limits: {},
    setLimits: noop,
    saveLimits: asyncNoop,
    resetUsage: asyncNoop,
    limitsLoading: false,
    limitsError: '',
    reloadLimits: reloadStub('reloadLimits', 'limits-loaded'),
    usageLoading: false,
    usageError: '',
    reloadUsage: reloadStub('reloadUsage', 'usage-loaded'),
    profile: null,
    profileName: '',
    setProfileName: noop,
    saveProfileName: asyncNoop,
    identities: [],
    authLoading: false,
    authError: '',
    reloadAuth: reloadStub('reloadAuth', 'auth-loaded'),
    signOutProvider: asyncNoop,
    oauthProviders: [],
    oauthClientId: '',
    setOAuthClientId: noop,
    oauthClientSecret: '',
    setOAuthClientSecret: noop,
    oauthMessage: '',
    oauthBusy: false,
    startOAuth: asyncNoop,
    connectorClientId: {},
    setConnectorClientId: noop,
    connectorClientSecret: {},
    setConnectorClientSecret: noop,
    connectorMessage: '',
    connectorBusy: null,
    startConnector: asyncNoop,
    updateInfo: null,
    checkingUpdate: false,
    checkUpdate: asyncNoop,
    openUpdateDownload: asyncNoop,
    updateStatus: null,
    updateTrack: 'stable',
    changeUpdateTrack: asyncNoop,
    updateStatusError: '',
    reloadUpdateStatus: reloadStub('reloadUpdateStatus', 'update-loaded'),
    vaultSecrets: {},
    deleteVaultKey: asyncNoop,
    noStorage: false,
    changeNoStorage: asyncNoop,
    noStorageLoading: false,
    noStorageError: '',
    reloadNoStorage: reloadStub('reloadNoStorage', 'nostorage-loaded'),
    vaultLoading: false,
    vaultError: '',
    reloadVault: reloadStub('reloadVault', 'vault-loaded'),
    onePasswordStatus: null,
    onePasswordBusy: false,
    onePasswordChecking: false,
    onePasswordError: '',
    toggleOnePassword: asyncNoop,
    checkOnePassword: reloadStub('checkOnePassword', 'onepassword-loaded'),
    dream: { enabled: false, idleMinutes: 15 },
    changeDream: asyncNoop,
    dreamLoading: false,
    dreamError: '',
    reloadDream: reloadStub('reloadDream', 'dream-loaded'),
    perf: null,
    perfError: '',
    loadPerf: reloadStub('loadPerf', 'perf-loaded'),
    perfLoading: false,
    clearing: false,
    onClearCache: asyncNoop,
    registry: null,
    registryError: '',
    registryLoading: false,
    reloadRegistry: reloadStub('reloadRegistry', 'models-loaded'),
    featureValue: () => '',
    setModelChoice: asyncNoop,
    changeFeatureModel: asyncNoop,
    changeFeatureFlag: asyncNoop,
    ollamaModels: [],
    ollamaInput: '',
    setOllamaInput: noop,
    pulling: false,
    pullOllama: asyncNoop,
    ollamaMessage: '',
    ollamaLoading: false,
    ollamaError: '',
    reloadOllama: reloadStub('reloadOllama', 'ollama-loaded'),
    plugins: [],
    pluginErrors: [],
    pluginsError: '',
    pluginsLoading: false,
    pluginNotice: '',
    togglePlugin: asyncNoop,
    templateModalOpen: false,
    setTemplateModalOpen: noop,
    loadPlugins: reloadStub('loadPlugins', 'plugins-loaded'),
    hooks: [],
    hooksError: '',
    hooksLoading: false,
    reloadHooks: reloadStub('reloadHooks', 'hooks-loaded'),
    toggleHook: asyncNoop,
    apiStatus: null,
    setApiStatus: noop,
    apiPort: 0,
    setApiPort: noop,
    apiError: '',
    apiSaved: false,
    saveApi: asyncNoop,
    apiLoading: false,
    reloadApi: reloadStub('reloadApi', 'api-loaded'),
    webhooksError: '',
    apiToken: null,
    setApiToken: noop,
    showApiToken: false,
    setShowApiToken: noop,
    showToken: asyncNoop,
    regenerateToken: asyncNoop,
    copied: '',
    copyAndMark: asyncNoop,
    webhooks: [],
    webhookUrl: '',
    setWebhookUrl: noop,
    webhookEvents: ['run.done'],
    setWebhookEvents: noop,
    addWebhook: asyncNoop,
    removeWebhook: asyncNoop,
    engines: null,
    enginesError: '',
    enginesLoading: false,
    reloadEngines: reloadStub('reloadEngines', 'engines-loaded'),
    redetecting: false,
    redetectEngines: asyncNoop,
    redetectingKind: null,
    toggleEngine: asyncNoop,
    redetectOneEngine: asyncNoop,
    editCustomCli: asyncNoop,
    removeCustomCli: asyncNoop,
    customEditingId: null,
    setCustomEditingId: noop,
    customId: '',
    setCustomId: noop,
    customLabel: '',
    setCustomLabel: noop,
    customBinaryPath: '',
    setCustomBinaryPath: noop,
    customAcpArgs: 'acp',
    setCustomAcpArgs: noop,
    customStatusArgs: '',
    setCustomStatusArgs: noop,
    customSaving: false,
    saveCustomCli: asyncNoop,
  };
}

function sharedFor(tab: SettingsTabId, scenario: string): SettingsShared {
  const s = baseShared();
  // Per-tab scenario overrides on top of the loaded-by-default base.
  if (tab === 'general') {
    if (scenario === 'usage-loading') s.usageLoading = true;
    if (scenario === 'usage-error') s.usageError = 'Không tải được mức sử dụng.';
    if (scenario === 'usage-loaded') s.usage = SAMPLE_USAGE;
    if (scenario === 'update-status-error') s.updateStatusError = 'Không tải được trạng thái cập nhật.';
    // v0.69c: spend-limits scenarios.
    if (scenario === 'limits-loading') s.limitsLoading = true;
    if (scenario === 'limits-error') s.limitsError = 'Không tải được giới hạn chi tiêu.';
    if (scenario === 'limits-loaded') s.limits = { dailyUsd: 5, monthlyUsd: 10 };
  }
  if (tab === 'security') {
    if (scenario === 'auth-loading') s.authLoading = true;
    if (scenario === 'auth-error') s.authError = 'Không tải được thông tin đăng nhập.';
    if (scenario === 'auth-loaded') {
      s.identities = [{ providerId: 'google', identity: { id: 'u1', displayName: 'Test User' } }];
      s.oauthProviders = [{ id: 'google', label: 'Google' }];
    }
    if (scenario === 'vault-loading') s.vaultLoading = true;
    if (scenario === 'vault-error') s.vaultError = 'Không tải được danh sách secret trong Vault.';
    if (scenario === 'vault-loaded') s.vaultSecrets = { api: ['key-1'] };
    if (scenario === 'onepassword-error') s.onePasswordError = 'Không tải được trạng thái 1Password.';
    if (scenario === 'onepassword-loaded') {
      s.onePasswordStatus = { state: 'signed-out', available: false, signedIn: false, enabled: true, accounts: [] };
    }
    // v0.69c: NO_STORAGE scenarios.
    if (scenario === 'nostorage-loading') s.noStorageLoading = true;
    if (scenario === 'nostorage-error') s.noStorageError = 'Không tải được chế độ không lưu trữ.';
    if (scenario === 'nostorage-loaded') s.noStorage = true;
  }
  if (tab === 'bot-model') {
    if (scenario === 'auto-approve-loading') s.autoApproveLoading = true;
    if (scenario === 'auto-approve-error') s.autoApproveError = 'Không tải được danh sách rule auto-approve.';
    if (scenario === 'auto-approve-loaded') {
      s.autoApproveRules = [{ id: 'r1', kind: 'shell', enabled: true, scope: 'global', pattern: 'echo hi', createdAt: 0 }];
    }
    if (scenario === 'models-loading') s.registryLoading = true;
    if (scenario === 'models-error') s.registryError = 'Không tải được model registry.';
    if (scenario === 'models-loaded') s.registry = SAMPLE_REGISTRY;
    if (scenario === 'ollama-loading') s.ollamaLoading = true;
    if (scenario === 'ollama-error') s.ollamaError = 'Không tải được danh sách model Ollama.';
    if (scenario === 'ollama-loaded') s.ollamaModels = ['llama3'];
    // v0.69c: engines scenarios.
    if (scenario === 'engines-loading') s.enginesLoading = true;
    if (scenario === 'engines-error') s.enginesError = 'Không tải được danh sách engines.';
    if (scenario === 'engines-loaded') {
      s.engines = {
        engines: {
          claude: {
            kind: 'claude', label: 'Claude Code', binary: 'claude', binaryPath: '/usr/bin/claude',
            version: '1.0.0', minVersion: '1.0.0', status: 'available', authMethod: 'oauth',
            detectedAt: '', enabled: true,
          },
        },
        detectedAt: '',
      };
    }
    if (scenario === 'engines-empty') s.engines = { engines: {}, detectedAt: '' };
  }
  if (tab === 'advanced') {
    // v0.69c: Dream scenarios.
    if (scenario === 'dream-loading') s.dreamLoading = true;
    if (scenario === 'dream-error') s.dreamError = 'Không tải được cài đặt Dream.';
    if (scenario === 'dream-loaded') s.dream = { enabled: true, idleMinutes: 30 };
    if (scenario === 'perf-loading') s.perfLoading = true;
    if (scenario === 'perf-error') s.perfError = 'Không tải được trạng thái hiệu năng.';
    if (scenario === 'perf-loaded') s.perf = SAMPLE_PERF;
    if (scenario === 'plugins-loading') s.pluginsLoading = true;
    if (scenario === 'plugins-error') s.pluginsError = 'Không tải được danh sách plugin.';
    if (scenario === 'plugins-loaded') {
      s.plugins = [{ id: 'p1', name: 'Sample Plugin', description: 'A sample.', version: '1.0', author: null, enabled: true, tools: [] }];
    }
    if (scenario === 'hooks-loading') s.hooksLoading = true;
    if (scenario === 'hooks-error') s.hooksError = 'Không tải được danh sách hook.';
    if (scenario === 'hooks-loaded') {
      s.hooks = [{ name: 'sample-hook', description: 'A sample hook.', events: ['run.done'], source: 'builtin', enabled: true }];
    }
    if (scenario === 'api-loading') s.apiLoading = true;
    if (scenario === 'api-error') s.apiError = 'Không tải được trạng thái API.';
    if (scenario === 'api-loaded') {
      s.apiStatus = { enabled: true, port: 8080, tokenSet: false };
      // The tab renders the port from the shared apiPort field, not
      // from apiStatus — the real loader sets both, so must the mock.
      s.apiPort = 8080;
    }
    if (scenario === 'webhooks-error') {
      s.apiStatus = { enabled: true, port: 8080, tokenSet: false };
      s.apiPort = 8080;
      s.webhooksError = 'Không tải được danh sách webhook.';
    }
  }
  if (tab === 'connections') {
    // The auth reload is shared with the Security tab, but the loaded
    // scenario differs per tab: re-point the stub at this tab's one.
    s.reloadAuth = reloadStub('reloadAuth', 'connectors-loaded');
    if (scenario === 'connectors-loading') s.authLoading = true;
    if (scenario === 'connectors-error') s.authError = 'Không tải được thông tin đăng nhập.';
    if (scenario === 'connectors-loaded') {
      s.identities = [{ providerId: 'slack', identity: { id: 'u1', displayName: 'Ann' } }];
    }
  }
  return s as unknown as SettingsShared;
}

function renderIntoRoot(node: React.ReactNode): boolean {
  const el = document.getElementById('root');
  if (!el) return false;
  if (root) {
    root.unmount();
    root = null;
  }
  root = createRoot(el);
  root.render(node);
  return true;
}

function mountTab(tab: SettingsTabId, scenario: string): boolean {
  currentTab = tab;
  const s = sharedFor(tab, scenario);
  switch (tab) {
    case 'general':
      return renderIntoRoot(<SettingsGeneralTab s={s} />);
    case 'bot-model':
      return renderIntoRoot(<SettingsBotModelTab s={s} />);
    case 'connections':
      return renderIntoRoot(<SettingsConnectionsTab s={s} />);
    case 'security':
      return renderIntoRoot(<SettingsSecurityTab s={s} />);
    case 'advanced':
      return renderIntoRoot(<SettingsAdvancedTab s={s} />);
  }
}

// --- Top-level SettingsView: getSettings rejects once, answers on retry ---

let settingsCalls = 0;

function installSettingsMock(): void {
  settingsCalls = 0;
  const getSettings = () => {
    settingsCalls += 1;
    if (settingsCalls === 1) return Promise.reject(new Error('settings failed'));
    return Promise.resolve({ providers: {}, bots: [], locale: 'vi' });
  };
  const api: Record<string, unknown> = {
    getSettings,
    setSettings: () => Promise.resolve({ providers: {}, bots: [], locale: 'vi' }),
    listVaultSecrets: () => Promise.resolve({}),
    getUsage: () => Promise.resolve(null),
    getSpendLimits: () => Promise.resolve({}),
    getDream: () => Promise.resolve({ enabled: false, idleMinutes: 15 }),
    getPerfStats: () => Promise.resolve({ ok: false }),
    testConnection: () => Promise.resolve({ ok: false, error: 'no key' }),
    updateBot: (b: unknown) => Promise.resolve(b),
    'models:list': () => Promise.resolve({ providers: {}, featureFlags: {} }),
    listModels: () => Promise.resolve({ providers: {}, featureFlags: {} }),
    'models:ollama-list': () => Promise.resolve([]),
    listOllamaModels: () => Promise.resolve([]),
    'api:get': () => Promise.resolve({ enabled: false, port: 0, tokenSet: false }),
    getApiStatus: () => Promise.resolve({ enabled: false, port: 0, tokenSet: false }),
    'api:webhooks-list': () => Promise.resolve([]),
    listWebhooks: () => Promise.resolve([]),
    'vault:get-nostorage': () => Promise.resolve({ enabled: false }),
    getVaultNoStorage: () => Promise.resolve({ enabled: false }),
    'onepassword:status': () => Promise.resolve(null),
    onePasswordStatus: () => Promise.resolve(null),
    'plugins:list': () => Promise.resolve({ plugins: [], errors: [] }),
    listPlugins: () => Promise.resolve({ plugins: [], errors: [] }),
    'hooks:list': () => Promise.resolve([]),
    listHooks: () => Promise.resolve([]),
    'auto-approve:list': () => Promise.resolve([]),
    listAutoApproveRules: () => Promise.resolve([]),
    'engines:list': () => Promise.resolve({ engines: {}, detectedAt: '' }),
    listEngines: () => Promise.resolve({ engines: {}, detectedAt: '' }),
    'auth:profile-get': () => Promise.resolve(null),
    getLocalProfile: () => Promise.resolve(null),
    'auth:identities-list': () => Promise.resolve([]),
    listProviderIdentities: () => Promise.resolve([]),
    'auth:oauth-supported': () => Promise.resolve([]),
    listOAuthProviders: () => Promise.resolve([]),
    'updates:get-status': () => Promise.resolve(null),
    getUpdateStatus: () => Promise.resolve(null),
  };
  (window as unknown as { openBot: unknown }).openBot = api;
}

function mountSettingsTopError(): boolean {
  installSettingsMock();
  return renderIntoRoot(<SettingsView onBack={() => {}} />);
}

// --- SkillsView: listSkills controlled per scenario ---

function mountSkills(scenario: string): boolean {
  const listSkills = () => {
    if (scenario === 'skills-loading') return neverSettles();
    // SkillsView shows the thrown message verbatim, so the mock
    // rejects with a distinct message the test can look for.
    if (scenario === 'skills-error') return Promise.reject(new Error('skills list failed'));
    if (scenario === 'skills-empty') return Promise.resolve([]);
    return Promise.resolve([
      { name: 'notes', description: 'A sample skill.', version: '1', whenToUse: '', tools: [], source: 'builtin', pluginId: null, enabled: true },
    ]);
  };
  const api: Record<string, unknown> = {
    listSkills,
    toggleSkill: () => Promise.resolve(undefined),
    reloadSkills: () => Promise.resolve({ errors: [] }),
    readSkill: () => Promise.resolve({ content: 'sample content' }),
    installSkill: () => Promise.resolve({ name: 'notes' }),
  };
  (window as unknown as { openBot: unknown }).openBot = api;
  return renderIntoRoot(<SkillsView onBack={() => {}} />);
}

function unmount(): void {
  if (root) {
    root.unmount();
    root = null;
  }
}

(window as unknown as Record<string, unknown>).__mountSettingsTab = mountTab;
(window as unknown as Record<string, unknown>).__mountSettingsTopError = mountSettingsTopError;
(window as unknown as Record<string, unknown>).__mountSkills = mountSkills;
(window as unknown as Record<string, unknown>).__reloadCalls = () => [...calls];
(window as unknown as Record<string, unknown>).__unmountSettings = unmount;
