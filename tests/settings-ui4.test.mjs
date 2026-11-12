/**
 * Settings tabs + search + standalone Connected apps (UI-4, v0.59).
 *
 * node:test, no Electron needed. Static checks + the pure search
 * module, because the renderer TSX cannot run under plain node:
 *
 *  - every pre-UI-4 section still exists somewhere (no section lost),
 *    and the total `<section>` count is unchanged (25 before UI-4:
 *    19 groups + 6 provider cards + 1 nested Composio section; 26
 *    after, with the v0.59 1Password section added by a parallel wave)
 *  - tabs cover every section exactly once; each tab is non-empty
 *  - search (`filterSections`) finds the right section for "vault",
 *    "webhook", "composio", diacritic-insensitive queries, and more
 *  - tab switching cannot lose state: tab components hold no useState
 *    of their own — all state lives in SettingsView, which passes one
 *    shared context object to every tab
 *  - Connected apps opens from the sidebar (new view + route), and no
 *    longer lives inside Settings
 *  - every new i18n key exists in both locales
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SECTION_TAB,
  SETTINGS_SECTIONS,
  SETTINGS_TABS,
  filterSections,
} from '../apps/desktop/src/renderer/components/settings/settingsTabs.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const renderer = join(repo, 'apps/desktop/src/renderer');
const components = join(renderer, 'components');
const localesDir = join(renderer, 'i18n/locales');

const vi = JSON.parse(readFileSync(join(localesDir, 'vi.json'), 'utf-8'));
const en = JSON.parse(readFileSync(join(localesDir, 'en.json'), 'utf-8'));

function src(rel) {
  return readFileSync(join(components, rel), 'utf-8');
}

const SETTINGS_VIEW = src('SettingsView.tsx');
const TAB_FILES = [
  'SettingsGeneralTab.tsx',
  'SettingsBotModelTab.tsx',
  'SettingsConnectionsTab.tsx',
  'SettingsSecurityTab.tsx',
  'SettingsAdvancedTab.tsx',
];
const TAB_SOURCES = TAB_FILES.map((f) => src(f));
const CONNECTED_APPS_VIEW = src('ConnectedAppsView.tsx');
const COMPOSIO_SECTION = src('ComposioAppsSection.tsx');
const ALL_SETTINGS_SOURCES = [SETTINGS_VIEW, ...TAB_SOURCES, CONNECTED_APPS_VIEW, COMPOSIO_SECTION, src('NotificationsSection.tsx')];

/** Every `data-section="..."` marker across the Settings + Connected apps sources. */
function dataSections() {
  const found = [];
  for (const text of ALL_SETTINGS_SOURCES) {
    for (const m of text.matchAll(/data-section="([^"]+)"/g)) found.push(m[1]);
  }
  return found;
}

test('tabs: 5 tabs, every section in exactly one tab, no tab empty', () => {
  assert.deepEqual(
    SETTINGS_TABS.map((t) => t.id),
    ['general', 'bot-model', 'connections', 'security', 'advanced'],
  );
  const seen = new Map();
  for (const tab of SETTINGS_TABS) {
    assert.ok(tab.sections.length > 0, `tab ${tab.id} must not be empty`);
    assert.ok(tab.labelKey.startsWith('settings.tab.'), `tab ${tab.id} label must be an i18n key`);
    for (const section of tab.sections) {
      assert.ok(!seen.has(section), `section ${section} is in two tabs`);
      seen.set(section, tab.id);
      assert.equal(SECTION_TAB[section], tab.id, `SECTION_TAB[${section}] must be ${tab.id}`);
    }
  }
  assert.deepEqual([...seen.keys()].sort(), [...SETTINGS_SECTIONS].sort());
  // 19 pre-UI-4 groups + the v0.59 1Password section + the v0.61
  // appearance (manual theme) section + the v0.86 crashReports section
  // + the v0.87c notifications section.
  assert.equal(SETTINGS_SECTIONS.length, 23);
});

test('no section lost: all pre-UI-4 section titles still render somewhere', () => {
  const joined = ALL_SETTINGS_SOURCES.join('\n');
  // One entry per pre-UI-4 section (title key), incl. the provider
  // cards (PROVIDER_META labelKeys) and the nested Composio section.
  const titleKeys = [
    'settings.smallModelGuardTitle',
    'settings.autoApproveTitle',
    'settings.usageTitle',
    'settings.languageTitle',
    'settings.authTitle',
    'settings.connectorsTitle',
    'settings.appsTitle',
    'settings.updateTitle',
    'settings.vaultTitle',
    'settings.dreamTitle',
    'perf.title',
    'settings.modelsTitle',
    'settings.pluginsTitle',
    'settings.hooksTitle',
    'settings.apiTitle',
    'settings.enginesTitle',
    'settings.provider.openai',
    'settings.limitsTitle',
    'settings.usageResetTitle',
    'settings.composio.title',
    // v0.59 1Password section (parallel wave) also kept, in Security.
    'settings.onePasswordTitle',
    // v0.87c notifications section, in General.
    'settings.notificationsTitle',
  ];
  for (const key of titleKeys) {
    assert.ok(joined.includes(key), `section title key ${key} is gone from Settings/Connected apps`);
  }
});

test('no section lost: data-section markers — 29 sections, none duplicated', () => {
  const found = dataSections();
  // Literal markers (21). The 6 provider cards share one template
  // marker, `data-section={`provider-${meta.id}`}`, checked below.
  const expectedLiteral = [
    // General tab (7)
    'usage', 'language', 'notifications', 'appearance', 'update', 'limits', 'usageReset',
    // Bot & Model tab (4 groups)
    'smallModelGuard', 'autoApprove', 'models', 'engines',
    // Connections tab (1)
    'connectors',
    // Security tab (4)
    'auth', 'vault', 'onePassword', 'crashReports',
    // Advanced tab (5)
    'dream', 'perf', 'plugins', 'hooks', 'api',
    // Connected apps view (2)
    'apps', 'composio',
  ];
  assert.equal(found.length, expectedLiteral.length, `expected ${expectedLiteral.length} literal sections, found ${found.length}: ${found.join(', ')}`);
  assert.deepEqual([...found].sort(), [...expectedLiteral].sort());
  assert.equal(new Set(found).size, found.length, 'data-section markers must be unique');
  // Provider cards: one template marker, one card per non-CLI provider.
  const botModelTab = src('SettingsBotModelTab.tsx');
  assert.equal(
    (botModelTab.match(/data-section=\{`provider-\$\{meta\.id\}`\}/g) ?? []).length,
    1,
    'provider cards must carry data-section={`provider-${meta.id}`} once',
  );
  const nonCliProviders = ['openai', 'anthropic', 'gemini', 'xai', 'ollama', 'openai-compatible'];
  for (const id of nonCliProviders) {
    const line = SETTINGS_VIEW.split('\n').find((l) => l.includes(`id: '${id}'`) && l.includes('PROVIDER_META') === false && l.includes('labelKey'));
    assert.ok(line && !line.includes('cliKind'), `PROVIDER_META must list non-CLI provider ${id}`);
  }
  assert.equal(found.length + nonCliProviders.length, 29, 'total sections must be 29 (25 pre-UI-4 + 1Password + appearance + crashReports + notifications)');
});

test('search: filterSections finds the right section', () => {
  // "vault" also matches 1Password (a password vault) — both are right.
  assert.deepEqual(filterSections('vault'), ['vault', 'onePassword']);
  assert.deepEqual(filterSections('webhook'), ['api']);
  assert.deepEqual(filterSections('WEBHOOK'), ['api']);
  assert.deepEqual(filterSections('composio'), ['apps']);
  assert.deepEqual(filterSections('local api'), ['api']);
  // Diacritic-insensitive: "bao mat" matches "bảo mật".
  assert.ok(filterSections('bao mat').includes('vault'), '"bao mat" should find vault');
  assert.ok(filterSections('ngon ngu').includes('language'), '"ngon ngu" should find language');
  // "model" finds the model-related sections, not the vault.
  const model = filterSections('model');
  assert.ok(model.includes('models') && model.includes('providers') && model.includes('smallModelGuard'));
  assert.ok(!model.includes('vault'));
  // Empty / blank query matches nothing (caller shows the active tab).
  assert.deepEqual(filterSections(''), []);
  assert.deepEqual(filterSections('   '), []);
  // Unknown query matches nothing (caller shows the no-results line).
  assert.deepEqual(filterSections('zzz-no-such-setting'), []);
  // Multi-token queries require every token.
  assert.deepEqual(filterSections('api key'), ['providers']);
});

test('tab switching cannot lose state: tabs are stateless, state lives in SettingsView', () => {
  for (const [i, text] of TAB_SOURCES.entries()) {
    assert.ok(!/useState\s*\(/.test(text), `${TAB_FILES[i]} must not hold its own useState (state lives in SettingsView)`);
    assert.ok(!/useEffect\s*\(/.test(text), `${TAB_FILES[i]} must not load its own data (state lives in SettingsView)`);
  }
  // SettingsView renders every tab with the same shared context object.
  for (const tab of ['General', 'BotModel', 'Connections', 'Security', 'Advanced']) {
    assert.ok(
      SETTINGS_VIEW.includes(`<Settings${tab}Tab s={shared}`),
      `SettingsView must render Settings${tab}Tab with s={shared}`,
    );
  }
  // The tab + query state itself lives in SettingsView.
  assert.ok(SETTINGS_VIEW.includes("useState<SettingsTabId>('general')"), 'SettingsView must own activeTab');
  assert.ok(SETTINGS_VIEW.includes("useState('')"), 'SettingsView must own the search query');
  // Search results render matching sections from every tab.
  assert.ok(SETTINGS_VIEW.includes('filterSections(query)'), 'SettingsView must filter sections by query');
  assert.ok(SETTINGS_VIEW.includes('settings.searchNoResults'), 'SettingsView must show a no-results line');
});

test('Connected apps: standalone view, reachable from the sidebar, out of Settings', () => {
  // New view exists and carries the apps list + Composio section.
  assert.ok(CONNECTED_APPS_VIEW.includes('ComposioAppsSection'), 'ConnectedAppsView must mount ComposioAppsSection');
  assert.ok(CONNECTED_APPS_VIEW.includes("data-section=\"apps\""), 'ConnectedAppsView must render the apps section');
  assert.ok(CONNECTED_APPS_VIEW.includes("data-section=\"composio\""), 'ConnectedAppsView must render the Composio section');
  const hook = readFileSync(join(components, 'settings/useConnectedApps.ts'), 'utf-8');
  assert.ok(hook.includes('apps:disconnect'), 'useConnectedApps must keep the disconnect IPC');
  assert.ok(hook.includes('apps:list'), 'useConnectedApps must keep the apps-list IPC');
  assert.ok(hook.includes('composio:get-state'), 'useConnectedApps must keep the Composio IPC');
  // Settings no longer contains the apps section or its IPC.
  assert.ok(!SETTINGS_VIEW.includes('ComposioAppsSection'), 'SettingsView must no longer mount ComposioAppsSection');
  assert.ok(!SETTINGS_VIEW.includes("data-section=\"apps\""), 'SettingsView must no longer render the apps section');
  assert.ok(!SETTINGS_VIEW.includes('apps:list'), 'SettingsView must no longer load the apps list');
  // But Settings → Connections still links to the standalone view.
  assert.ok(
    src('SettingsConnectionsTab.tsx').includes('settings.connectedAppsOpen'),
    'Connections tab must link to Connected apps',
  );
  // Sidebar link + App route.
  const sidebar = src('Sidebar.tsx');
  assert.ok(sidebar.includes('onOpenConnectedApps'), 'Sidebar must accept onOpenConnectedApps');
  assert.ok(sidebar.includes("t('sidebar.connectedApps')"), 'Sidebar must label the Connected apps button');
  const app = readFileSync(join(renderer, 'App.tsx'), 'utf-8');
  assert.ok(app.includes("import ConnectedAppsView from './components/ConnectedAppsView'"), 'App must import ConnectedAppsView');
  assert.ok(app.includes("'connected-apps'"), 'App must have a connected-apps view');
  assert.ok(app.includes('<ConnectedAppsView onBack={() => setView(\'chat\')}'), 'App must render ConnectedAppsView');
  assert.ok(
    app.includes('onOpenConnectedApps={() => setView(\'connected-apps\')}'),
    'App must wire the sidebar button to the connected-apps view',
  );
});

test('new i18n keys exist in both locales', () => {
  const keys = [
    'settings.tab.general',
    'settings.tab.botModel',
    'settings.tab.connections',
    'settings.tab.security',
    'settings.tab.advanced',
    'settings.searchPlaceholder',
    'settings.searchNoResults',
    'settings.connectedAppsOpen',
    'settings.connectedAppsHint',
    'sidebar.connectedApps',
  ];
  for (const key of keys) {
    assert.ok(key in vi && vi[key].trim().length > 0, `missing/empty in vi.json: ${key}`);
    assert.ok(key in en && en[key].trim().length > 0, `missing/empty in en.json: ${key}`);
  }
});

test('tab bar + search input are wired in SettingsView', () => {
  assert.ok(SETTINGS_VIEW.includes('<SettingsTabBar'), 'SettingsView must render SettingsTabBar');
  const tabBar = src('SettingsTabBar.tsx');
  assert.ok(tabBar.includes('data-tab={tab.id}'), 'tab buttons must carry data-tab for tests/smoke');
  assert.ok(tabBar.includes('data-testid="settings-search"'), 'search input must carry a test id');
  assert.ok(tabBar.includes("t('settings.searchPlaceholder')"), 'search input must use the i18n placeholder');
});
