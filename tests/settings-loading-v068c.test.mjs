/**
 * Tests for v0.68c — Settings loading / empty / error states for the
 * remaining sections (docs/ui-parity-review.md §3.6 T5, P2, continued
 * from v0.67b which covered Connected apps only).
 *
 * Audit (v0.67c): these sections rendered blank or misleading while
 * their IPC was not ready yet —
 *
 *   Settings top-level  getSettings rejects -> "loading" line stayed
 *                       on screen forever next to the error, no retry
 *   General/usage       getUsage fails -> the whole section vanished
 *                       (`usage &&` guarded the <section>)
 *   General/update      updates:get-status fails silently -> the track
 *                       selector sat on its default with no error
 *   BotModel/autoApprove rules still loading -> the empty line showed
 *   BotModel/models     registry still loading -> feature selects
 *                       rendered empty with no explanation
 *   BotModel/ollama     list fails silently -> "no models" line
 *   Connections/auth    identities still loading -> every connector
 *                       read "not connected", no login buttons
 *   Security/vault      list still loading -> "empty" line showed
 *   Security/1Password  load fails -> status line read "Signed out"
 *                       and the Check button was disabled while the
 *                       status was null, so no retry was possible
 *   Advanced/perf       stats still loading -> blank body; the Refresh
 *                       button only lived inside the loaded block,
 *                       so a failed load had no retry at all
 *   Advanced/plugins    list still loading -> the empty line showed
 *   Advanced/hooks      same as plugins, and the reload function was
 *                       never exposed to the tab (no retry possible)
 *   Advanced/api        status still loading -> unchecked "enabled"
 *                       box + "token not set" as if real state;
 *                       webhook list fails silently -> "no webhooks"
 *   SkillsView          load error + empty line showed together
 *
 * The fix follows the v0.67b pattern in every loader: a first-load
 * flag (true only while the first load is in flight, cleared in
 * `finally`), a `*LoadedOnce` ref so later refreshes do not flash
 * loading over loaded data, an error string + retry button per
 * section, and empty lines gated on `!loading && !error`.
 *
 * node:test, no Electron needed. Static contract checks (the renderer
 * TSX cannot run under plain node — same convention as
 * tests/connected-apps-v067b.test.mjs) + the locale files; the live
 * behaviour is covered by tests/settings-loading-v068c-renderer.test.mjs
 * (mocked shared state in a real Electron renderer).
 *
 * Run: node --test tests/settings-loading-v068c.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const renderer = join(repo, 'apps/desktop/src/renderer');
const components = join(renderer, 'components');
const localesDir = join(renderer, 'i18n/locales');

const vi = JSON.parse(readFileSync(join(localesDir, 'vi.json'), 'utf-8'));
const en = JSON.parse(readFileSync(join(localesDir, 'en.json'), 'utf-8'));

const VIEW = readFileSync(join(components, 'SettingsView.tsx'), 'utf-8');
const SHARED = readFileSync(join(components, 'settings/settingsShared.ts'), 'utf-8');
const GENERAL = readFileSync(join(components, 'SettingsGeneralTab.tsx'), 'utf-8');
const BOT_MODEL = readFileSync(join(components, 'SettingsBotModelTab.tsx'), 'utf-8');
const CONNECTIONS = readFileSync(join(components, 'SettingsConnectionsTab.tsx'), 'utf-8');
const SECURITY = readFileSync(join(components, 'SettingsSecurityTab.tsx'), 'utf-8');
const ADVANCED = readFileSync(join(components, 'SettingsAdvancedTab.tsx'), 'utf-8');
const SKILLS = readFileSync(join(components, 'SkillsView.tsx'), 'utf-8');

const NEW_KEYS = [
  'settings.retry',
  'settings.usageLoading',
  'settings.usageLoadError',
  'settings.vaultLoading',
  'settings.vaultLoadError',
  'settings.authLoading',
  'settings.authLoadError',
  'settings.oauthNoProviders',
  'settings.modelsLoading',
  'settings.modelsOllamaLoading',
  'settings.modelsOllamaLoadError',
  'settings.pluginsLoading',
  'settings.hooksLoading',
  'settings.autoApproveLoading',
  'settings.apiLoading',
  'settings.apiWebhooksLoadError',
  'settings.updateStatusLoadError',
  'perf.loading',
];

// ---------------------------------------------------------------------------
// SettingsView: first-load flags + reload functions for every loader
// ---------------------------------------------------------------------------

test('view: every IPC loader has a first-load flag that starts true and a loaded-once ref', () => {
  const flags = [
    ['usageLoading', 'usageLoadedOnce'],
    ['vaultLoading', 'vaultLoadedOnce'],
    ['authLoading', 'authLoadedOnce'],
    ['registryLoading', 'registryLoadedOnce'],
    ['ollamaLoading', 'ollamaLoadedOnce'],
    ['pluginsLoading', 'pluginsLoadedOnce'],
    ['hooksLoading', 'hooksLoadedOnce'],
    ['autoApproveLoading', 'autoApproveLoadedOnce'],
    ['perfLoading', 'perfLoadedOnce'],
    ['apiLoading', 'apiLoadedOnce'],
  ];
  for (const [flag, ref] of flags) {
    assert.ok(VIEW.includes(`const [${flag}, set${flag[0].toUpperCase()}${flag.slice(1)}] = useState(true)`), `${flag} must start true`);
    assert.ok(VIEW.includes(`const ${ref} = useRef(false)`), `${ref} must exist`);
  }
});

test('view: every loader clears its flag in a finally (a throw can never stick loading on)', () => {
  const setters = [
    'setUsageLoading(false)',
    'setVaultLoading(false)',
    'setAuthLoading(false)',
    'setRegistryLoading(false)',
    'setOllamaLoading(false)',
    'setPluginsLoading(false)',
    'setHooksLoading(false)',
    'setAutoApproveLoading(false)',
    'setPerfLoading(false)',
    'setApiLoading(false)',
  ];
  for (const setter of setters) {
    assert.ok(VIEW.includes(setter), `view must contain ${setter}`);
  }
  // Spot-check the finally placement for two loaders: the false-set
  // must come after the IPC call inside the same function.
  const usageFinally = VIEW.indexOf('setUsageLoading(false)');
  const usageCall = VIEW.indexOf('window.openBot.getUsage()');
  assert.ok(usageCall > -1 && usageFinally > usageCall, 'usage flag must clear after the getUsage call');
  const apiFinally = VIEW.indexOf('setApiLoading(false)');
  const apiCall = VIEW.indexOf("callOpenBot<ApiStatusView>('api:get'");
  assert.ok(apiCall > -1 && apiFinally > apiCall, 'api flag must clear after the api:get call');
});

test('view: failed loads report an error instead of looking like empty data', () => {
  for (const [fn, key] of [
    ['loadUsage', "t('settings.usageLoadError')"],
    ['loadVault', "t('settings.vaultLoadError')"],
    ['loadAuth', "t('settings.authLoadError')"],
    ['loadOllama', "t('settings.modelsOllamaLoadError')"],
    ['loadApi', "t('settings.apiWebhooksLoadError')"],
    ['loadUpdateStatus', "t('settings.updateStatusLoadError')"],
  ]) {
    assert.ok(VIEW.includes(fn), `view must define ${fn}`);
    assert.ok(VIEW.includes(key), `${fn} must report ${key}`);
  }
  // The old silent catches are gone: no loader may claim a section
  // "stays empty" any more.
  assert.ok(!VIEW.includes('the section stays empty'), 'no loader may leave a section silently empty');
  assert.ok(!VIEW.includes('Ollama list unavailable; the section stays empty'), 'Ollama load must report its failure');
  assert.ok(!VIEW.includes('Webhook list unavailable; the section stays empty'), 'webhook list load must report its failure');
});

test('view: top-level getSettings is a named loader with a retry screen', () => {
  assert.ok(VIEW.includes('const loadSettings = async ()'), 'getSettings must be a named loadSettings function');
  assert.ok(VIEW.includes('data-testid="settings-retry"'), 'failed top-level load must offer a retry button');
  assert.ok(VIEW.includes('void loadSettings()'), 'retry must re-run loadSettings');
  assert.ok(VIEW.includes("t('settings.retry')"), 'retry must use the shared settings.retry label');
  // The loading line only shows while there is no error.
  assert.ok(VIEW.includes("{!error && <p>{t('settings.loading')}</p>}"), 'loading line must hide once the load failed');
});

test('view: shared context exposes every new loading / error / reload field', () => {
  for (const field of [
    'usageLoading, usageError, reloadUsage: loadUsage',
    'authLoading, authError, reloadAuth: loadAuth',
    'updateStatusError, updateStatusLoading, reloadUpdateStatus: loadUpdateStatus',
    'vaultLoading, vaultError, reloadVault: loadVault',
    'perfLoading',
    'registryLoading, reloadRegistry: loadRegistry',
    'ollamaLoading, ollamaError, reloadOllama: loadOllama',
    'pluginsLoading',
    'hooksLoading, reloadHooks: loadHooks',
    'autoApproveLoading, reloadAutoApprove: loadAutoApproveRules',
    'apiLoading, reloadApi: loadApi, webhooksError',
  ]) {
    assert.ok(VIEW.includes(field), `shared object must include ${field}`);
  }
  for (const field of [
    'usageLoading: boolean;',
    'usageError: string;',
    'reloadUsage: () => Promise<void>;',
    'authLoading: boolean;',
    'authError: string;',
    'reloadAuth: () => Promise<void>;',
    'updateStatusError: string;',
    'updateStatusLoading: boolean;',
    'reloadUpdateStatus: () => Promise<void>;',
    'vaultLoading: boolean;',
    'vaultError: string;',
    'reloadVault: () => Promise<void>;',
    'perfLoading: boolean;',
    'registryLoading: boolean;',
    'reloadRegistry: () => Promise<void>;',
    'ollamaLoading: boolean;',
    'ollamaError: string;',
    'reloadOllama: () => Promise<void>;',
    'pluginsLoading: boolean;',
    'hooksLoading: boolean;',
    'reloadHooks: () => Promise<void>;',
    'autoApproveLoading: boolean;',
    'reloadAutoApprove: () => Promise<void>;',
    'apiLoading: boolean;',
    'reloadApi: () => Promise<void>;',
    'webhooksError: string;',
  ]) {
    assert.ok(SHARED.includes(field), `SettingsShared must declare ${field}`);
  }
});

// ---------------------------------------------------------------------------
// Tabs: one explicit state per section, no blank or misleading render
// ---------------------------------------------------------------------------

test('general tab: usage section always renders (loading / error + retry / data)', () => {
  assert.ok(GENERAL.includes("show('usage') && ("), 'usage section must render even when usage is null');
  assert.ok(!GENERAL.includes("show('usage') && usage && ("), 'usage section must not be gated on usage');
  assert.ok(GENERAL.includes('data-testid="usage-loading"'), 'usage loading line must carry a test id');
  assert.ok(GENERAL.includes("t('settings.usageLoading')"), 'usage loading must use settings.usageLoading');
  assert.ok(GENERAL.includes('data-testid="usage-retry"'), 'usage error must carry a retry button');
  assert.ok(GENERAL.includes('void reloadUsage()'), 'usage retry must call reloadUsage');
  assert.ok(GENERAL.includes('{usage && ('), 'usage data still renders when present');
});

test('general tab: failed update-status load reports an error + retry', () => {
  assert.ok(GENERAL.includes('data-testid="update-status-retry"'), 'update-status error must carry a retry button');
  // The tab renders the error string from shared state (the key lives
  // in the loader in SettingsView, asserted above).
  assert.ok(GENERAL.includes('<p className="error">{updateStatusError}</p>'), 'update-status error must render');
  assert.ok(GENERAL.includes('void reloadUpdateStatus()'), 'update-status retry must call reloadUpdateStatus');
});

test('bot-model tab: auto-approve / models / Ollama loading, error + retry, gated empty', () => {
  for (const [id, key, retry] of [
    ['auto-approve-loading', 'settings.autoApproveLoading', 'reloadAutoApprove'],
    ['models-loading', 'settings.modelsLoading', 'reloadRegistry'],
    ['ollama-loading', 'settings.modelsOllamaLoading', 'reloadOllama'],
  ]) {
    assert.ok(BOT_MODEL.includes(`data-testid="${id}"`), `missing test id ${id}`);
    assert.ok(BOT_MODEL.includes(`t('${key}')`), `missing key ${key}`);
    assert.ok(BOT_MODEL.includes(`void ${retry}()`), `missing retry call ${retry}`);
  }
  assert.ok(BOT_MODEL.includes('data-testid="auto-approve-retry"'), 'auto-approve error must carry a retry button');
  assert.ok(BOT_MODEL.includes('data-testid="models-retry"'), 'models error must carry a retry button');
  assert.ok(BOT_MODEL.includes('data-testid="ollama-retry"'), 'Ollama error must carry a retry button');
  // The tab renders the error string from shared state (the key lives
  // in the loader in SettingsView, asserted above).
  assert.ok(BOT_MODEL.includes('<p className="error">{ollamaError}</p>'), 'Ollama error must render');
  // Empty lines wait for a finished load without an error.
  assert.ok(BOT_MODEL.includes('!autoApproveLoading && !autoApproveError && autoApproveRules.length === 0'), 'auto-approve empty must wait for a finished load');
  assert.ok(BOT_MODEL.includes('!ollamaLoading && !ollamaError && ollamaModels.length === 0'), 'Ollama empty must wait for a finished load');
});

test('connections tab: connector status waits for the auth load', () => {
  assert.ok(CONNECTIONS.includes('data-testid="connectors-loading"'), 'connectors loading line must carry a test id');
  assert.ok(CONNECTIONS.includes("t('settings.authLoading')"), 'connectors loading must use settings.authLoading');
  assert.ok(CONNECTIONS.includes('data-testid="connectors-retry"'), 'connectors error must carry a retry button');
  assert.ok(CONNECTIONS.includes('void reloadAuth()'), 'connectors retry must call reloadAuth');
  assert.ok(CONNECTIONS.includes('!authLoading && !authError && <p>{t(\'settings.connectorNotConnected\')}</p>'), '"not connected" must wait for a finished auth load');
});

test('security tab: auth + vault loading, error + retry, gated empty', () => {
  for (const [id, key, retry] of [
    ['auth-loading', 'settings.authLoading', 'reloadAuth'],
    ['vault-loading', 'settings.vaultLoading', 'reloadVault'],
  ]) {
    assert.ok(SECURITY.includes(`data-testid="${id}"`), `missing test id ${id}`);
    assert.ok(SECURITY.includes(`t('${key}')`), `missing key ${key}`);
    assert.ok(SECURITY.includes(`void ${retry}()`), `missing retry call ${retry}`);
  }
  assert.ok(SECURITY.includes('data-testid="auth-retry"'), 'auth error must carry a retry button');
  assert.ok(SECURITY.includes('data-testid="vault-retry"'), 'vault error must carry a retry button');
  // The tab renders the error strings from shared state (the keys live
  // in the loaders in SettingsView, asserted above).
  assert.ok(SECURITY.includes('<p className="error">{authError}</p>'), 'auth error must render');
  assert.ok(SECURITY.includes('<p className="error">{vaultError}</p>'), 'vault error must render');
  assert.ok(SECURITY.includes('!authLoading && !authError && identities.filter((i) => i.identity).length === 0'), '"no identity" must wait for a finished auth load');
  assert.ok(SECURITY.includes('!vaultLoading && !vaultError && Object.keys(vaultSecrets).length === 0'), 'vault empty must wait for a finished load');
  assert.ok(SECURITY.includes("t('settings.oauthNoProviders')"), 'empty OAuth provider list must explain itself');
});

test('security tab: 1Password load failure reads as an error and the Check button can retry it', () => {
  // The status line shows the load error instead of "Signed out"
  // when the status never arrived.
  assert.ok(SECURITY.includes(': !onePasswordStatus\n                ? onePasswordError'), 'status line must show the load error when status is null');
  assert.ok(SECURITY.includes('data-testid="onepassword-check"'), 'Check button must carry a test id');
  // The button is disabled while checking or while a loaded broker is
  // disabled — but NOT merely because the status is null (that is the
  // failed-load case, where Check is the retry).
  assert.ok(SECURITY.includes('disabled={onePasswordChecking || (onePasswordStatus !== null && !onePasswordStatus.enabled)}'), 'Check must stay enabled when the status failed to load');
  assert.ok(!SECURITY.includes('disabled={onePasswordChecking || !onePasswordStatus?.enabled}'), 'old disabled rule must be gone');
});

test('advanced tab: perf / plugins / hooks / API loading, error + retry, gated empty', () => {
  for (const [id, key] of [
    ['perf-loading', 'perf.loading'],
    ['plugins-loading', 'settings.pluginsLoading'],
    ['hooks-loading', 'settings.hooksLoading'],
    ['api-loading', 'settings.apiLoading'],
  ]) {
    assert.ok(ADVANCED.includes(`data-testid="${id}"`), `missing test id ${id}`);
    assert.ok(ADVANCED.includes(`t('${key}')`), `missing key ${key}`);
  }
  for (const [id, call] of [
    ['perf-retry', 'loadPerf'],
    ['plugins-retry', 'loadPlugins'],
    ['hooks-retry', 'reloadHooks'],
    ['api-retry', 'reloadApi'],
  ]) {
    assert.ok(ADVANCED.includes(`data-testid="${id}"`), `missing retry button ${id}`);
    assert.ok(ADVANCED.includes(`void ${call}()`), `missing retry call ${call}`);
  }
  // The perf Refresh button is no longer trapped inside the loaded
  // block: a failed load gets its own retry row.
  assert.ok(ADVANCED.includes('{!perf && !perfLoading && ('), 'perf retry must show when stats never arrived');
  // Empty lines wait for a finished load without an error.
  assert.ok(ADVANCED.includes('!pluginsLoading && !pluginsError && plugins.length === 0'), 'plugins empty must wait for a finished load');
  assert.ok(ADVANCED.includes('!hooksLoading && !hooksError && hooks.length === 0'), 'hooks empty must wait for a finished load');
  assert.ok(ADVANCED.includes("t('settings.apiWebhooksLoadError')") || ADVANCED.includes('<p className="error">{webhooksError}</p>'), 'webhook list error must render');
  assert.ok(ADVANCED.includes('!apiLoading && !webhooksError && webhooks.length === 0'), 'webhooks empty must wait for a finished load');
});

test('skills view: empty line no longer shows next to the load error', () => {
  assert.ok(SKILLS.includes('data-testid="skills-loading"'), 'skills loading line must carry a test id');
  assert.ok(SKILLS.includes('{skills.length === 0 && !loading && !error && <p>{t(\'skills.empty\')}</p>}'), 'skills empty must require a finished load without an error');
});

// ---------------------------------------------------------------------------
// i18n + scope
// ---------------------------------------------------------------------------

test('i18n: every new key exists in vi and en, non-empty, no placeholders', () => {
  for (const key of NEW_KEYS) {
    assert.ok(key in vi && vi[key].trim().length > 0, `missing/empty in vi.json: ${key}`);
    assert.ok(key in en && en[key].trim().length > 0, `missing/empty in en.json: ${key}`);
    assert.ok(!/[{}]/.test(vi[key]) && !/[{}]/.test(en[key]), `new key ${key} must not need placeholders`);
  }
  assert.equal(Object.keys(vi).length, Object.keys(en).length, 'vi/en key counts must stay equal');
});

test('i18n: no hard-coded Vietnamese in the edited files (the i18n test scans comments too)', () => {
  const vietnamese = /[À-ỹđĐ]/;
  const files = [
    ['SettingsView.tsx', VIEW],
    ['settingsShared.ts', SHARED],
    ['SettingsGeneralTab.tsx', GENERAL],
    ['SettingsBotModelTab.tsx', BOT_MODEL],
    ['SettingsConnectionsTab.tsx', CONNECTIONS],
    ['SettingsSecurityTab.tsx', SECURITY],
    ['SettingsAdvancedTab.tsx', ADVANCED],
    ['SkillsView.tsx', SKILLS],
  ];
  for (const [name, src] of files) {
    for (const [i, line] of src.split('\n').entries()) {
      assert.ok(!vietnamese.test(line), `${name}:${i + 1} still has hard-coded Vietnamese: ${line.trim()}`);
    }
  }
});

test('scope: files of other milestones are untouched by this change', () => {
  const mcpView = readFileSync(join(components, 'McpMarketplaceView.tsx'), 'utf-8');
  const catalog = readFileSync(join(repo, 'packages/core/src/apps/catalog.ts'), 'utf-8');
  const main = readFileSync(join(repo, 'apps/desktop/src/main/main.ts'), 'utf-8');
  for (const marker of ['usageLoading', 'vaultLoading', 'authLoading', 'perfLoading', 'settings-retry', 'usage-retry']) {
    assert.ok(!mcpView.includes(marker), `McpMarketplaceView.tsx must not contain ${marker}`);
    assert.ok(!catalog.includes(marker), `apps/catalog.ts must not contain ${marker}`);
    assert.ok(!main.includes(marker), `main.ts must not contain ${marker} (no main change in this milestone)`);
  }
  // The Connected apps hook/view from v0.67b is untouched too.
  const hook = readFileSync(join(components, 'settings/useConnectedApps.ts'), 'utf-8');
  for (const marker of ['usageLoading', 'vaultLoading', 'settings-retry']) {
    assert.ok(!hook.includes(marker), `useConnectedApps.ts must not contain ${marker}`);
  }
});
