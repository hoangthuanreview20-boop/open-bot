/**
 * Tests for v0.67b — Connected apps (M7) loading / empty / error states
 * (docs/ui-parity-review.md §3.6 T5, P2).
 *
 * The apps list and the Composio section used to render blank while
 * their IPC was not ready yet: `connectedApps` starts as an empty
 * array and `composioState` starts as null, with no loading flag at
 * all. This milestone adds first-load flags to `useConnectedApps`
 * (`appsLoading` / `composioLoading`, plus `reloadApps` /
 * `reloadComposio` for the retry buttons) and renders an explicit
 * state for every case in `ConnectedAppsView`:
 *
 *   apps:     loading | loaded (list) | empty | error + retry
 *   composio: loading | loaded (section) | empty | error + retry
 *
 * node:test, no Electron needed. Static contract checks (the renderer
 * TSX cannot run under plain node — same convention as
 * tests/settings-ui4.test.mjs) + the locale files; the live behaviour
 * is covered by tests/connected-apps-v067b-renderer.test.mjs (mocked
 * `window.openBot` in a real Electron renderer) and
 * tests/connected-apps-v067b-smoke.test.mjs (real app).
 *
 * Run: node --test tests/connected-apps-v067b.test.mjs
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

const HOOK = readFileSync(join(components, 'settings/useConnectedApps.ts'), 'utf-8');
const VIEW = readFileSync(join(components, 'ConnectedAppsView.tsx'), 'utf-8');
const CONNECTIONS_TAB = readFileSync(join(components, 'SettingsConnectionsTab.tsx'), 'utf-8');

const NEW_KEYS = [
  'settings.appsLoading',
  'settings.appsEmpty',
  'settings.appsEmptyHint',
  'settings.appsRetry',
  'settings.composioLoading',
  'settings.composioEmpty',
  'settings.composioEmptyHint',
  // v0.68b: GitHub PAT form (token app).
  'settings.appsTokenLabel',
  'settings.appsTokenPlaceholder',
  'settings.appsTokenSave',
  'settings.appsTokenEmpty',
  'settings.appsTokenHint',
];

// ---------------------------------------------------------------------------
// Hook: new loading state, IPC / auth logic untouched
// ---------------------------------------------------------------------------

test('hook: exposes appsLoading + reloadApps and composioLoading + reloadComposio', () => {
  for (const field of ['appsLoading: boolean;', 'reloadApps: () => Promise<void>;', 'composioLoading: boolean;', 'reloadComposio: () => Promise<void>;']) {
    assert.ok(HOOK.includes(field), `ConnectedAppsData must declare ${field}`);
  }
  assert.ok(HOOK.includes('reloadApps: loadConnectedApps'), 'reloadApps must re-run the apps load');
  assert.ok(HOOK.includes('reloadComposio: loadComposioState'), 'reloadComposio must re-run the Composio load');
  // Both flags start true: the view shows loading on first paint.
  assert.ok(HOOK.includes('useState(true)') && HOOK.includes('const [appsLoading, setAppsLoading] = useState(true)'), 'appsLoading must start true');
  assert.ok(HOOK.includes('const [composioLoading, setComposioLoading] = useState(true)'), 'composioLoading must start true');
});

test('hook: loading covers the first load only and always settles', () => {
  // A "loaded once" marker per loader: later refreshes (after a
  // disconnect / toggle) must not flash loading over a loaded list.
  assert.ok(HOOK.includes('appsLoadedOnce'), 'apps load must remember a completed first load');
  assert.ok(HOOK.includes('composioLoadedOnce'), 'Composio load must remember a completed first load');
  // Both loaders set their flag true when the first load starts and
  // false in a finally, so a throw can never leave loading stuck on.
  for (const [setTrue, setFalse] of [
    ['setAppsLoading(true)', 'setAppsLoading(false)'],
    ['setComposioLoading(true)', 'setComposioLoading(false)'],
  ]) {
    assert.ok(HOOK.includes(setTrue), `hook must set ${setTrue}`);
    assert.ok(HOOK.includes(setFalse), `hook must set ${setFalse}`);
  }
  const appsFinally = HOOK.indexOf('setAppsLoading(false)');
  const appsTry = HOOK.indexOf("callOpenBot<ConnectedAppView[]>('apps:list'");
  assert.ok(appsTry > -1 && appsFinally > appsTry, 'appsLoading(false) must come after the apps:list call (finally)');
  const composioFinally = HOOK.indexOf('setComposioLoading(false)');
  const composioTry = HOOK.indexOf("callOpenBot<ComposioStateView>('composio:get-state'");
  assert.ok(composioTry > -1 && composioFinally > composioTry, 'composioLoading(false) must come after the get-state call (finally)');
});

test('hook: IPC channels, auth logic and degrade-on-missing-method are unchanged', () => {
  for (const channel of ['apps:list', 'apps:disconnect', 'composio:get-state', 'composio:set-enabled', 'composio:set-app-enabled', 'composio:set-key', 'composio:clear-key', 'auth:oauth-start']) {
    assert.ok(HOOK.includes(`'${channel}'`), `hook must still call IPC ${channel}`);
  }
  // callOpenBot still returns null when the preload side has not
  // exposed the method, so the UI degrades instead of crashing.
  assert.ok(HOOK.includes("if (typeof fn !== 'function') return null;"), 'callOpenBot must still return null for a missing method');
  // Error strings are unchanged.
  assert.ok(HOOK.includes("t('settings.appsLoadError')"), 'apps load error must keep settings.appsLoadError');
  assert.ok(HOOK.includes("t('settings.composioLoadError')"), 'Composio load error must keep settings.composioLoadError');
  // Disconnect still refreshes from the disconnect IPC result, and
  // Composio mutations still refresh the apps list.
  assert.ok(HOOK.includes("callOpenBot<ConnectedAppView[]>('apps:disconnect'"), 'disconnect must keep its IPC');
  assert.ok(HOOK.includes('await loadConnectedApps();'), 'Composio mutations must still refresh the apps list');
});

// ---------------------------------------------------------------------------
// View: one explicit state per section, no blank render
// ---------------------------------------------------------------------------

test('view: apps section renders loading, empty and error + retry (each with a test id)', () => {
  assert.ok(VIEW.includes('appsLoading'), 'view must read appsLoading from the hook');
  assert.ok(VIEW.includes('data-testid="apps-loading"'), 'apps loading line must carry data-testid="apps-loading"');
  assert.ok(VIEW.includes("t('settings.appsLoading')"), 'apps loading line must use settings.appsLoading');
  assert.ok(VIEW.includes('data-testid="apps-empty"'), 'apps empty state must carry data-testid="apps-empty"');
  assert.ok(VIEW.includes("t('settings.appsEmpty')"), 'apps empty state must use settings.appsEmpty');
  assert.ok(VIEW.includes("t('settings.appsEmptyHint')"), 'apps empty state must carry the short hint');
  assert.ok(VIEW.includes('data-testid="apps-retry"'), 'apps error must carry a retry button (data-testid="apps-retry")');
  assert.ok(VIEW.includes("t('settings.appsRetry')"), 'retry button must use settings.appsRetry');
  assert.ok(VIEW.includes('void reloadApps()'), 'apps retry must call the hook reload function');
  // Empty only when the load finished, without an error, and with no apps.
  assert.ok(VIEW.includes('!appsLoading && !appsError && connectedApps.length === 0'), 'empty must require loaded + no error + no apps');
  // Loading only when there is no list to show yet (no flash over a
  // loaded list during a later refresh).
  assert.ok(VIEW.includes('appsLoading && connectedApps.length === 0'), 'loading must require an empty list');
});

test('view: Composio section renders loading, empty and error + retry when state is null', () => {
  assert.ok(VIEW.includes('composioLoading'), 'view must read composioLoading from the hook');
  assert.ok(VIEW.includes('data-testid="composio-loading"'), 'Composio loading line must carry data-testid="composio-loading"');
  assert.ok(VIEW.includes("t('settings.composioLoading')"), 'Composio loading line must use settings.composioLoading');
  assert.ok(VIEW.includes('data-testid="composio-empty"'), 'Composio empty state must carry data-testid="composio-empty"');
  assert.ok(VIEW.includes("t('settings.composioEmpty')"), 'Composio empty state must use settings.composioEmpty');
  assert.ok(VIEW.includes("t('settings.composioEmptyHint')"), 'Composio empty state must carry the short hint');
  assert.ok(VIEW.includes('data-testid="composio-retry"'), 'Composio error must carry a retry button (data-testid="composio-retry")');
  assert.ok(VIEW.includes('void reloadComposio()'), 'Composio retry must call the hook reload function');
  // The error branch still shows the Composio error string from the hook.
  assert.ok(VIEW.includes('{composioError}'), 'Composio error branch must render composioError');
  // The full section still mounts when the state arrives.
  assert.ok(VIEW.includes('<ComposioAppsSection'), 'view must still mount ComposioAppsSection when state is present');
});

test('view: exactly one data-section marker per section (settings-ui4 counts them)', () => {
  assert.equal((VIEW.match(/data-section="apps"/g) ?? []).length, 1, 'exactly one literal data-section="apps"');
  assert.equal((VIEW.match(/data-section="composio"/g) ?? []).length, 1, 'exactly one literal data-section="composio"');
});

test('hook: token apps save a PAT via apps:set-token and clear the draft on success', () => {
  // v0.68b: GitHub (authType 'token') connects by pasting a PAT.
  for (const field of [
    'appTokenDraft: Record<string, string>;',
    'appTokenBusy: string | null;',
    'appTokenError: string;',
    'saveAppToken: (appId: string) => Promise<void>;',
  ]) {
    assert.ok(HOOK.includes(field), `ConnectedAppsData must declare ${field}`);
  }
  assert.ok(HOOK.includes("callOpenBot<ConnectedAppView[]>('apps:set-token'"), 'PAT save must use IPC apps:set-token');
  assert.ok(HOOK.includes("'setConnectedAppToken'"), 'PAT save must fall back to the camelCase alias');
  // Empty draft refuses with the locale key, never calls IPC.
  assert.ok(HOOK.includes("t('settings.appsTokenEmpty')"), 'empty PAT must use settings.appsTokenEmpty');
  // The draft for that app is cleared after a successful save so the
  // token never stays on screen; the list refreshes from the IPC result.
  assert.ok(HOOK.includes("setAppTokenDraft((prev) => ({ ...prev, [appId]: '' }))"), 'PAT draft must clear on success');
  // The token only leaves the renderer through the set-token IPC.
  assert.ok(!HOOK.includes('localStorage'), 'hook must not stash the PAT in localStorage');
});

test('view: token apps render a password PAT form + save, and a disconnect button when connected', () => {
  // v0.68b: the form only shows for token apps that are not connected;
  // the input is a password field (never shown back) with per-app
  // test ids for the renderer test.
  assert.ok(VIEW.includes("a.app.authType === 'token'"), 'view must branch on authType token');
  assert.ok(VIEW.includes('type="password"'), 'PAT input must be a password field');
  assert.ok(VIEW.includes('data-testid={`app-token-input-${a.app.id}`}'), 'PAT input must carry a per-app test id');
  assert.ok(VIEW.includes('data-testid={`app-token-save-${a.app.id}`}'), 'PAT save button must carry a per-app test id');
  assert.ok(VIEW.includes("t('settings.appsTokenLabel')"), 'PAT label must use settings.appsTokenLabel');
  assert.ok(VIEW.includes("t('settings.appsTokenPlaceholder')"), 'PAT placeholder must use settings.appsTokenPlaceholder');
  assert.ok(VIEW.includes("t('settings.appsTokenHint')"), 'PAT hint must use settings.appsTokenHint');
  assert.ok(VIEW.includes("t('settings.appsTokenSave')"), 'PAT save must use settings.appsTokenSave');
  assert.ok(VIEW.includes('void saveAppToken(a.app.id)'), 'PAT save button must call the hook save function');
  assert.ok(VIEW.includes('{appTokenError}'), 'PAT save error must render');
  // Disconnect is no longer OAuth-only: token apps disconnect too.
  assert.ok(
    VIEW.includes("(a.app.authType === 'oauth2' || a.app.authType === 'token')"),
    'disconnect button must cover token apps as well as OAuth2 apps',
  );
  assert.ok(VIEW.includes('data-testid={`app-disconnect-${a.app.id}`}'), 'disconnect button must carry a per-app test id');
});

test('view: no hard-coded Vietnamese in the edited files (i18n scans comments too)', () => {
  const vietnamese = /[À-ỹđĐ]/;
  for (const [name, src] of [['ConnectedAppsView.tsx', VIEW], ['useConnectedApps.ts', HOOK]]) {
    for (const [i, line] of src.split('\n').entries()) {
      assert.ok(!vietnamese.test(line), `${name}:${i + 1} still has hard-coded Vietnamese: ${line.trim()}`);
    }
  }
});

// ---------------------------------------------------------------------------
// i18n: new keys in both locales
// ---------------------------------------------------------------------------

test('i18n: every new key exists in vi and en, non-empty, no placeholders', () => {
  for (const key of NEW_KEYS) {
    assert.ok(key in vi && vi[key].trim().length > 0, `missing/empty in vi.json: ${key}`);
    assert.ok(key in en && en[key].trim().length > 0, `missing/empty in en.json: ${key}`);
    assert.ok(!/[{}]/.test(vi[key]) && !/[{}]/.test(en[key]), `new key ${key} must not need placeholders`);
  }
});

// ---------------------------------------------------------------------------
// Scope: Settings Connections tab has no such hook, so it needs no fix
// ---------------------------------------------------------------------------

test('scope: SettingsConnectionsTab does not use the hook (no empty-section issue there)', () => {
  assert.ok(!CONNECTIONS_TAB.includes('useConnectedApps'), 'Connections tab must not use useConnectedApps');
  assert.ok(!CONNECTIONS_TAB.includes('data-section="apps"'), 'Connections tab must not render the apps section');
  assert.ok(!CONNECTIONS_TAB.includes('connectedApps.map'), 'Connections tab must not render the apps list');
  assert.ok(CONNECTIONS_TAB.includes('settings.connectedAppsOpen'), 'Connections tab still links to the standalone view');
});

test('scope: files of other milestones are untouched by this change', () => {
  const mcpView = readFileSync(join(components, 'McpMarketplaceView.tsx'), 'utf-8');
  const catalog = readFileSync(join(repo, 'packages/core/src/apps/catalog.ts'), 'utf-8');
  for (const marker of ['appsLoading', 'composioLoading', 'apps-empty', 'composio-empty']) {
    assert.ok(!mcpView.includes(marker), `McpMarketplaceView.tsx must not contain ${marker}`);
    assert.ok(!catalog.includes(marker), `apps/catalog.ts must not contain ${marker}`);
  }
});
