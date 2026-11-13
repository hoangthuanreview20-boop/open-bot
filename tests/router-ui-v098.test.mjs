/**
 * UI tests for v0.98 (Đội T2) — RouterPanel IPC wiring.
 *
 * Part A (no display needed): i18n parity — every `router.*` key
 * exists with a non-empty string in all 6 locales, and the key sets
 * match exactly across locales; RouterPanel only uses keys that
 * exist; preload exposes the router API (`getRouterDecisions` /
 * `getRouterStats` / `getRouterConfig` / `setRouterConfig` /
 * `clearRouterLog` / `getRouterTargets` / `onRouterChanged`) and
 * allows subscribing to `router:changed`; main registers all
 * `router:*` IPC channels and forwards `router.decision` events as
 * `router:changed`; RouterPanel source contains the expected
 * data-testids (panel / loading / error / retry / bot-filter /
 * clear-log / save-status / stats / targets / history /
 * local-fallback) and the per-bot filter + allow/disabled config
 * controls; renderer types + global.d.ts declare the router API.
 *
 * No CDP renderer part here: this VM has no DISPLAY, and the panel
 * is fully covered statically (props + IPC + i18n). A live Electron
 * smoke run follows the same convention as
 * tests/memory-ui-v095d4.test.mjs when a display is available.
 *
 * Run: node --test tests/router-ui-v098.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = ['vi', 'en', 'zh', 'ja', 'es', 'fr'];

function readLocale(locale) {
  return JSON.parse(
    fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales', `${locale}.json`), 'utf8'),
  );
}

function usedKeys(source) {
  // Key i18n luôn có dạng namespace.key (chứa dấu chấm) — regex hẹp để
  // không bắt nhầm các lời gọi `.split('...')` hay `.at('...')`.
  return [...source.matchAll(/t\('([a-z][a-zA-Z0-9_]*\.[a-zA-Z0-9_.]+)'/g)].map((m) => m[1]);
}

const PANEL = fs.readFileSync(
  path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'RouterPanel.tsx'),
  'utf8',
);
const PRELOAD = fs.readFileSync(
  path.join(REPO, 'apps', 'desktop', 'src', 'main', 'preload.ts'),
  'utf8',
);
const MAIN = fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'main', 'main.ts'), 'utf8');
const GLOBAL_DTS = fs.readFileSync(
  path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'global.d.ts'),
  'utf8',
);
const RENDERER_TYPES = fs.readFileSync(
  path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'types.ts'),
  'utf8',
);

const EXPECTED_TESTIDS = [
  'router-panel',
  'router-loading',
  'router-error',
  'router-retry',
  'router-local-fallback',
  'router-save-status',
  'router-stats',
  'router-targets',
  'router-history',
  'router-bot-filter',
  'router-clear-log',
];

const EXPECTED_IPC_CHANNELS = [
  'router:decisions',
  'router:stats',
  'router:get-config',
  'router:set-config',
  'router:clear-log',
  'router:targets',
  'router:changed',
];

const EXPECTED_PRELOAD_METHODS = [
  'getRouterDecisions',
  'getRouterStats',
  'getRouterConfig',
  'setRouterConfig',
  'clearRouterLog',
  'getRouterTargets',
  'onRouterChanged',
];

// Dynamic layer keys used via template literal (not caught by usedKeys).
const DYNAMIC_KEYS = ['router.layer.structural', 'router.layer.semantic', 'router.layer.decision'];

test('i18n: mọi key router.* tồn tại, non-empty, khớp nhau ở cả 6 locale', () => {
  const perLocale = {};
  for (const locale of LOCALES) {
    const data = readLocale(locale);
    const routerKeys = Object.keys(data).filter((k) => k.startsWith('router.'));
    assert.ok(routerKeys.length >= 40, `${locale}: phải có >= 40 key router.*, có ${routerKeys.length}`);
    for (const key of routerKeys) {
      assert.equal(typeof data[key], 'string', `${locale}:${key} phải là string`);
      assert.ok(data[key].trim().length > 0, `${locale}:${key} không được rỗng`);
    }
    perLocale[locale] = routerKeys.sort();
  }
  const base = perLocale['vi'];
  for (const locale of LOCALES) {
    assert.deepEqual(perLocale[locale], base, `key router.* của ${locale} phải khớp vi`);
  }
});

test('i18n: mọi key router.* RouterPanel dùng đều tồn tại trong locale', () => {
  const data = readLocale('vi');
  const used = [...new Set(usedKeys(PANEL))].filter((k) => k.startsWith('router.'));
  assert.ok(used.length >= 30, `panel phải dùng >= 30 key router.*, dùng ${used.length}`);
  for (const key of [...used, ...DYNAMIC_KEYS]) {
    assert.ok(key in data, `key ${key} panel dùng nhưng không có trong locale vi`);
    assert.ok(data[key].trim().length > 0, `key ${key} rỗng`);
  }
});

test('i18n: interpolation placeholders trong stats khớp giữa các locale', () => {
  const placeholders = (s) => [...s.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
  for (const key of ['router.statsLine', 'router.statsTotal', 'router.statsFallback', 'router.statsLatency', 'router.latencyLine']) {
    const base = placeholders(readLocale('en')[key]);
    for (const locale of LOCALES) {
      assert.deepEqual(placeholders(readLocale(locale)[key]), base, `${key} (${locale}) sai placeholder`);
    }
  }
});

test('preload: expose đủ API router + subscribe router:changed', () => {
  for (const method of EXPECTED_PRELOAD_METHODS) {
    assert.ok(PRELOAD.includes(`${method}:`), `preload thiếu method ${method}`);
    assert.ok(PRELOAD.includes(method), `preload thiếu ${method}`);
  }
  assert.ok(PRELOAD.includes("subscribe('router:changed'"), 'preload phải subscribe router:changed');
  assert.ok(PRELOAD.includes("'router:changed',"), 'preload phải cho phép channel router:changed');
  for (const channel of ['router:decisions', 'router:stats', 'router:get-config', 'router:set-config', 'router:clear-log', 'router:targets']) {
    assert.ok(PRELOAD.includes(`ipcRenderer.invoke('${channel}'`), `preload thiếu invoke ${channel}`);
  }
});

test('main: đăng ký đủ IPC router:* + forward router.decision → router:changed', () => {
  for (const channel of EXPECTED_IPC_CHANNELS.slice(0, 6)) {
    assert.ok(MAIN.includes(`ipcMain.handle(\n    '${channel}'`) || MAIN.includes(`ipcMain.handle('${channel}'`), `main thiếu IPC ${channel}`);
  }
  // router.decision là harness event (kind 'router.decision' trong
  // envelope 'harness.event'), KHÔNG phải AgentEvent — main forward nó
  // trong case 'harness.event' của routeCoordinatorEvent.
  assert.ok(MAIN.includes("streamEvent.kind === 'router.decision'"), 'main phải forward harness event router.decision trong case harness.event');
  assert.ok(MAIN.includes("sendToRenderer('router:changed'"), 'main phải đẩy router:changed về renderer');
  assert.ok(MAIN.includes('syncRouterToCoordinator'), 'main phải sync router xuống coordinator lúc spawn');
  assert.ok(MAIN.includes('seedRouterApiKeysToCoordinator'), 'main phải seed key provider cho router');
  assert.ok(MAIN.includes('settings.router'), 'main phải lưu cấu hình router vào settings.json');
});

test('main: Vault đổi key provider thì seed lại cho router', () => {
  const occurrences = (MAIN.match(/syncRouterApiKeyToCoordinator\(/g) ?? []).length;
  assert.ok(occurrences >= 4, `phải gọi syncRouterApiKeyToCoordinator ở >= 4 chỗ (định nghĩa + 3 site Vault), có ${occurrences}`);
});

test('RouterPanel: đủ data-testid + filter theo bot + allow/disabled + targets + clear log', () => {
  for (const testid of EXPECTED_TESTIDS) {
    assert.ok(PANEL.includes(`data-testid="${testid}"`), `panel thiếu testid ${testid}`);
  }
  assert.ok(PANEL.includes('botFilter'), 'panel phải có filter theo bot');
  assert.ok(PANEL.includes("setAllow('allowLocal'") || PANEL.includes("allowLocal"), 'panel phải có toggle allowLocal');
  assert.ok(PANEL.includes('allowCli'), 'panel phải có toggle allowCli');
  assert.ok(PANEL.includes('allowApi'), 'panel phải có toggle allowApi');
  assert.ok(PANEL.includes('toggleDisabledProvider'), 'panel phải có toggle disabledProviders');
  assert.ok(PANEL.includes('router-disable-provider-'), 'panel phải có testid disable từng provider');
  assert.ok(PANEL.includes('getRouterTargets'), 'panel phải kéo targets');
  assert.ok(PANEL.includes('clearRouterLog'), 'panel phải có clear log');
  assert.ok(PANEL.includes('onRouterChanged'), 'panel phải subscribe router:changed để cập nhật live');
  assert.ok(PANEL.includes('fallbackRate'), 'panel phải hiển thị tỉ lệ fallback');
  assert.ok(PANEL.includes('latencyP50Ms') && PANEL.includes('latencyP95Ms'), 'panel phải hiển thị p50/p95');
});

test('RouterPanel: không bịa số khi chưa có dữ liệu (empty state rõ ràng)', () => {
  assert.ok(PANEL.includes("t('router.empty')"), 'panel phải có empty state');
  assert.ok(PANEL.includes("t('router.loadError')"), 'panel phải có load error');
  assert.ok(PANEL.includes("t('router.localFallback')"), 'panel phải báo rõ khi IPC không khả dụng');
});

test('renderer types: khai báo đủ view + API router', () => {
  for (const name of ['RouterDecisionView', 'RouterStatsView', 'RouterConfigView', 'RouterTargetsView', 'RouterCliStatusView', 'RouterChangedPayloadView']) {
    assert.ok(RENDERER_TYPES.includes(`interface ${name}`), `types.ts thiếu ${name}`);
  }
  for (const method of EXPECTED_PRELOAD_METHODS) {
    assert.ok(GLOBAL_DTS.includes(`${method}(`), `global.d.ts thiếu ${method}`);
  }
  assert.ok(RENDERER_TYPES.includes('fallbackRate'), 'RouterStatsView phải có fallbackRate');
  assert.ok(RENDERER_TYPES.includes('latencyP50Ms'), 'RouterStatsView phải có latencyP50Ms');
  assert.ok(RENDERER_TYPES.includes('disabledProviders'), 'RouterConfigView phải có disabledProviders');
});

test('SettingsBotModelTab: truyền bots cho RouterPanel (filter theo bot)', () => {
  const tab = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'SettingsBotModelTab.tsx'),
    'utf8',
  );
  assert.ok(tab.includes('<RouterPanel t={t} bots={data?.bots}'), 'tab phải truyền bots cho RouterPanel');
});
