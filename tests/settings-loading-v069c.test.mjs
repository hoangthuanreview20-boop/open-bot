/**
 * Tests for v0.69c — Settings loading / empty / error states for the
 * four sections v0.68c missed (docs/ui-parity-review.md §3.6 T5, P2,
 * continued from v0.68c).
 *
 * Audit (v0.69c, systematic re-check of every Settings async load):
 *
 *   BotModel/engines   engines:list fails with engines === null ->
 *                      the error showed AND the generic "loading"
 *                      line stayed on screen forever, with no retry
 *                      button (Re-detect is a re-scan, not a retry);
 *                      the loader had no first-load flag / ref at all
 *   General/limits     getSpendLimits failed silently (inline
 *                      try/catch in loadExtras) -> the inputs stayed
 *                      empty, looking exactly like "no limits set"
 *   Advanced/dream     getDream failed silently (same inline
 *                      pattern) -> the toggle stayed off, looking
 *                      exactly like Dream being disabled
 *   Security/vault     vault:get-nostorage failed silently
 *                      (loadNoStorage) -> the NO_STORAGE toggle
 *                      stayed off, looking exactly like the mode
 *                      being disabled
 *
 * The v0.68c BEYOND-ROADMAP entry claimed limits/dream "do not go
 * through IPC" and engines "was already sufficient" — both claims
 * were wrong (limits loads via getSpendLimits, dream via getDream,
 * and the engines failure left the loading line stuck).
 *
 * Everything else re-checked in v0.69c and found sufficient (no
 * change): top-level getSettings, usage, update-status, auto-approve,
 * models, Ollama, connectors/auth, vault list, 1Password, perf,
 * plugins, hooks, API + webhooks, SkillsView, Connected apps /
 * Composio, McpMarketplaceView; language / appearance / usageReset /
 * smallModelGuard / providers render from local state or the
 * top-level load. TemplatePluginModal (opened from the plugins
 * section) shows its load error but has no loading line and no retry
 * except close/reopen — a modal, not a Settings section, left as a
 * noted minor gap for a later wave, not fixed here.
 *
 * The fix follows the v0.67b/v0.68c pattern in every loader: a
 * first-load flag (true only while the first load is in flight,
 * cleared in `finally`), a `*LoadedOnce` ref so later refreshes do
 * not flash loading over loaded data, an error string + retry button
 * per section, and empty lines gated on `!loading && !error`.
 *
 * node:test, no Electron needed. Static contract checks (the renderer
 * TSX cannot run under plain node — same convention as
 * tests/settings-loading-v068c.test.mjs) + the locale files; the live
 * behaviour is covered by tests/settings-loading-v069c-renderer.test.mjs
 * (mocked shared state in a real Electron renderer, scenarios added
 * to the v0.68c harness fixture).
 *
 * Run: node --test tests/settings-loading-v069c.test.mjs
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
const SECURITY = readFileSync(join(components, 'SettingsSecurityTab.tsx'), 'utf-8');
const ADVANCED = readFileSync(join(components, 'SettingsAdvancedTab.tsx'), 'utf-8');

const NEW_KEYS = [
  'settings.enginesLoading',
  'settings.limitsLoading',
  'settings.limitsLoadError',
  'settings.dreamLoading',
  'settings.dreamLoadError',
  'settings.vaultNoStorageLoading',
  'settings.vaultNoStorageLoadError',
];

// ---------------------------------------------------------------------------
// SettingsView: first-load flags + reload functions for the four loaders
// ---------------------------------------------------------------------------

test('view: every fixed loader has a first-load flag that starts true and a loaded-once ref', () => {
  const flags = [
    ['enginesLoading', 'enginesLoadedOnce'],
    ['limitsLoading', 'limitsLoadedOnce'],
    ['dreamLoading', 'dreamLoadedOnce'],
    ['noStorageLoading', 'noStorageLoadedOnce'],
  ];
  for (const [flag, ref] of flags) {
    assert.ok(VIEW.includes(`const [${flag}, set${flag[0].toUpperCase()}${flag.slice(1)}] = useState(true)`), `${flag} must start true`);
    assert.ok(VIEW.includes(`const ${ref} = useRef(false)`), `${ref} must exist`);
  }
});

test('view: every fixed loader clears its flag in a finally (a throw can never stick loading on)', () => {
  const setters = [
    'setEnginesLoading(false)',
    'setLimitsLoading(false)',
    'setDreamLoading(false)',
    'setNoStorageLoading(false)',
  ];
  for (const setter of setters) {
    assert.ok(VIEW.includes(setter), `view must contain ${setter}`);
  }
  // Spot-check the finally placement for two loaders: the false-set
  // must come after the IPC call inside the same function.
  const enginesFinally = VIEW.indexOf('setEnginesLoading(false)');
  const enginesCall = VIEW.indexOf("callOpenBot<DetectedEnginesView>('engines:list'");
  assert.ok(enginesCall > -1 && enginesFinally > enginesCall, 'engines flag must clear after the engines:list call');
  const limitsFinally = VIEW.indexOf('setLimitsLoading(false)');
  const limitsCall = VIEW.indexOf('window.openBot.getSpendLimits()');
  assert.ok(limitsCall > -1 && limitsFinally > limitsCall, 'limits flag must clear after the getSpendLimits call');
});

test('view: failed loads report an error instead of showing defaults as if they were real', () => {
  for (const [fn, key] of [
    ['loadEngines', "t('settings.enginesLoadError')"],
    ['loadLimits', "t('settings.limitsLoadError')"],
    ['loadDream', "t('settings.dreamLoadError')"],
    ['loadNoStorage', "t('settings.vaultNoStorageLoadError')"],
  ]) {
    assert.ok(VIEW.includes(fn), `view must define ${fn}`);
    assert.ok(VIEW.includes(key), `${fn} must report ${key}`);
  }
  // The old silent loads are gone: limits and Dream are named loaders
  // called from loadExtras, and NO_STORAGE no longer swallows its error.
  assert.ok(VIEW.includes('await loadLimits();'), 'loadExtras must call the named loadLimits');
  assert.ok(VIEW.includes('await loadDream();'), 'loadExtras must call the named loadDream');
  assert.ok(!VIEW.includes('NO_STORAGE state unavailable; the toggle stays off.'), 'loadNoStorage must report its failure');
  assert.ok(!VIEW.includes('leaves the Engines section empty instead of blocking Settings'), 'loadEngines must report its failure');
});

test('view: shared context exposes every new loading / error / reload field', () => {
  for (const field of [
    'enginesLoading, reloadEngines: loadEngines',
    'limitsLoading, limitsError, reloadLimits: loadLimits',
    'dreamLoading, dreamError, reloadDream: loadDream',
    'noStorageLoading, noStorageError, reloadNoStorage: loadNoStorage',
  ]) {
    assert.ok(VIEW.includes(field), `shared object must include ${field}`);
  }
  for (const field of [
    'enginesLoading: boolean;',
    'reloadEngines: () => Promise<void>;',
    'limitsLoading: boolean;',
    'limitsError: string;',
    'reloadLimits: () => Promise<void>;',
    'dreamLoading: boolean;',
    'dreamError: string;',
    'reloadDream: () => Promise<void>;',
    'noStorageLoading: boolean;',
    'noStorageError: string;',
    'reloadNoStorage: () => Promise<void>;',
  ]) {
    assert.ok(SHARED.includes(field), `SettingsShared must declare ${field}`);
  }
});

// ---------------------------------------------------------------------------
// Tabs: one explicit state per section, no blank or misleading render
// ---------------------------------------------------------------------------

test('general tab: limits loading, error + retry', () => {
  assert.ok(GENERAL.includes('data-testid="limits-loading"'), 'limits loading line must carry a test id');
  assert.ok(GENERAL.includes("t('settings.limitsLoading')"), 'limits loading must use settings.limitsLoading');
  assert.ok(GENERAL.includes('data-testid="limits-retry"'), 'limits error must carry a retry button');
  assert.ok(GENERAL.includes('void reloadLimits()'), 'limits retry must call reloadLimits');
  assert.ok(GENERAL.includes('<p className="error">{limitsError}</p>'), 'limits error must render');
});

test('bot-model tab: engines loading, error + retry, gated empty, no stuck loading line', () => {
  assert.ok(BOT_MODEL.includes('data-testid="engines-loading"'), 'engines loading line must carry a test id');
  assert.ok(BOT_MODEL.includes("t('settings.enginesLoading')"), 'engines loading must use settings.enginesLoading');
  assert.ok(BOT_MODEL.includes('data-testid="engines-retry"'), 'engines error must carry a retry button');
  assert.ok(BOT_MODEL.includes('void reloadEngines()'), 'engines retry must call reloadEngines');
  assert.ok(BOT_MODEL.includes('<p className="error">{enginesError}</p>'), 'engines error must render');
  // The empty line waits for a finished load without an error.
  assert.ok(BOT_MODEL.includes('!enginesLoading && !enginesError && engines && Object.keys(engines.engines).length === 0'), 'engines empty must wait for a finished load');
  // The old stuck line is gone: the engines section must no longer
  // render the generic settings.loading while engines is null.
  assert.ok(!BOT_MODEL.includes("t('settings.loading')"), 'engines section must not use the generic loading line');
});

test('security tab: NO_STORAGE loading, error + retry inside the vault section', () => {
  assert.ok(SECURITY.includes('data-testid="nostorage-loading"'), 'NO_STORAGE loading line must carry a test id');
  assert.ok(SECURITY.includes("t('settings.vaultNoStorageLoading')"), 'NO_STORAGE loading must use settings.vaultNoStorageLoading');
  assert.ok(SECURITY.includes('data-testid="nostorage-retry"'), 'NO_STORAGE error must carry a retry button');
  assert.ok(SECURITY.includes('void reloadNoStorage()'), 'NO_STORAGE retry must call reloadNoStorage');
  assert.ok(SECURITY.includes('<p className="error">{noStorageError}</p>'), 'NO_STORAGE error must render');
});

test('advanced tab: dream loading, error + retry', () => {
  assert.ok(ADVANCED.includes('data-testid="dream-loading"'), 'dream loading line must carry a test id');
  assert.ok(ADVANCED.includes("t('settings.dreamLoading')"), 'dream loading must use settings.dreamLoading');
  assert.ok(ADVANCED.includes('data-testid="dream-retry"'), 'dream error must carry a retry button');
  assert.ok(ADVANCED.includes('void reloadDream()'), 'dream retry must call reloadDream');
  assert.ok(ADVANCED.includes('<p className="error">{dreamError}</p>'), 'dream error must render');
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
    ['SettingsSecurityTab.tsx', SECURITY],
    ['SettingsAdvancedTab.tsx', ADVANCED],
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
  for (const marker of ['enginesLoading', 'limitsLoading', 'dreamLoading', 'noStorageLoading', 'engines-retry', 'limits-retry']) {
    assert.ok(!mcpView.includes(marker), `McpMarketplaceView.tsx must not contain ${marker}`);
    assert.ok(!catalog.includes(marker), `apps/catalog.ts must not contain ${marker}`);
    assert.ok(!main.includes(marker), `main.ts must not contain ${marker} (no main change in this milestone)`);
  }
  // The Connected apps hook/view from v0.67b is untouched too.
  const hook = readFileSync(join(components, 'settings/useConnectedApps.ts'), 'utf-8');
  for (const marker of ['enginesLoading', 'limitsLoading', 'dreamLoading']) {
    assert.ok(!hook.includes(marker), `useConnectedApps.ts must not contain ${marker}`);
  }
});
