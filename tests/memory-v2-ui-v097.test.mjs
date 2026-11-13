/**
 * UI tests for v0.97 (Team T4) — Memory v2 UI (static, no display).
 *
 * Part A (no display needed): i18n parity — every memoryV2.* and
 * memory.tabV2 key exists with a non-empty string in all 6 locales,
 * the key sets match exactly across locales, and placeholders match
 * vi; the MemoryV2View component only uses keys that exist; preload
 * exposes the memory-v2 API; main registers all `memory-v2:*` IPC
 * channels; MemoryV2View source contains the expected data-testids
 * (search / sleep toggle / sleep run / refresh) so the renderer smoke
 * tests of other waves can drive it; MemoryView wires the v2 tab.
 *
 * No CDP renderer part here: this VM has no DISPLAY, and the component
 * is fully covered statically (props + IPC + i18n). A live Electron
 * smoke run follows the same convention as
 * tests/memory-ui-v095d4.test.mjs when a display is available.
 *
 * Also covers the coordinator sleep hook statically: executeRun calls
 * maybeRunSleepAfterTurn after a successful run, and the hook is
 * best-effort (wrapped in try/catch, never on the turn path).
 *
 * Run: node --test tests/memory-v2-ui-v097.test.mjs
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

function read(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

function usedKeys(source) {
  // Key i18n luôn có dạng namespace.key (chứa dấu chấm) — regex hẹp để
  // không bắt nhầm các lời gọi `.split('...')` hay `.at('...')`.
  return [...source.matchAll(/t\('([a-z][a-zA-Z0-9_]*\.[a-zA-Z0-9_.]+)'/g)].map((m) => m[1]);
}

const EXPECTED_TESTIDS = [
  'memory-v2-refresh',
  'memory-v2-search-input',
  'memory-v2-search-button',
  'memory-v2-sleep-toggle',
  'memory-v2-sleep-run',
];

const EXPECTED_TAB_TESTIDS = ['memory-tabs', 'memory-tab-memories', 'memory-tab-blocks', 'memory-tab-v2'];

const EXPECTED_IPC_CHANNELS = [
  'memory-v2:graph',
  'memory-v2:search',
  'memory-v2:sleep',
  'memory-v2:provenance',
];

const EXPECTED_PRELOAD_METHODS = [
  'getMemoryV2Graph',
  'searchMemoryV2',
  'getMemoryV2Sleep',
  'getMemoryV2Provenance',
];

const EXPECTED_V2_KEYS = [
  'memory.tabV2',
  'memoryV2.disableSleep',
  'memoryV2.enableSleep',
  'memoryV2.graphStats',
  'memoryV2.graphTitle',
  'memoryV2.keywordOnly',
  'memoryV2.lastRun',
  'memoryV2.loadError',
  'memoryV2.no',
  'memoryV2.quotaExceeded',
  'memoryV2.quotaTitle',
  'memoryV2.quotaUsage',
  'memoryV2.quarantined',
  'memoryV2.quarantinedLabel',
  'memoryV2.refresh',
  'memoryV2.runSleepNow',
  'memoryV2.score',
  'memoryV2.search',
  'memoryV2.searchError',
  'memoryV2.searchPlaceholder',
  'memoryV2.searchResults',
  'memoryV2.searchTitle',
  'memoryV2.sleepEnabled',
  'memoryV2.sleepRan',
  'memoryV2.sleepSummary',
  'memoryV2.sleepTitle',
  'memoryV2.sleepUpdated',
  'memoryV2.stepsSinceRun',
  'memoryV2.stepsThreshold',
  'memoryV2.trust',
  'memoryV2.validFrom',
  'memoryV2.validTo',
  'memoryV2.yes',
  'memoryV2.saveError',
];

test('i18n: memoryV2.* + memory.tabV2 đầy đủ 6 locale, key set khớp nhau', () => {
  const locales = Object.fromEntries(LOCALES.map((l) => [l, readLocale(l)]));
  for (const locale of LOCALES) {
    const keys = Object.keys(locales[locale]).filter((k) => k.startsWith('memoryV2.') || k === 'memory.tabV2');
    assert.deepEqual([...keys].sort(), [...EXPECTED_V2_KEYS].sort(), `locale ${locale} thiếu/thừa key memoryV2`);
  }
  assert.equal(EXPECTED_V2_KEYS.length, 34, 'expected 34 memory-v2 keys');
  for (const locale of LOCALES) {
    for (const key of EXPECTED_V2_KEYS) {
      const value = locales[locale][key];
      assert.equal(typeof value, 'string', `${locale}:${key} phải là string`);
      assert.ok(value.trim() !== '', `${locale}:${key} không được rỗng`);
    }
    // Placeholder {name} trong các locale phải khớp vi (tránh lệch biến).
    for (const key of EXPECTED_V2_KEYS) {
      const viPlaceholders = [...locales.vi[key].matchAll(/\{[a-zA-Z]+\}/g)].map((m) => m[0]).sort();
      const placeholders = [...locales[locale][key].matchAll(/\{[a-zA-Z]+\}/g)].map((m) => m[0]).sort();
      assert.deepEqual(placeholders, viPlaceholders, `${locale}:${key} placeholder khác vi`);
    }
  }
  // Không có tiếng Việt trong comment/code của renderer component
  // (test i18n quét cả comment — quy tắc từ v0.96).
  const view = read('apps/desktop/src/renderer/components/MemoryV2View.tsx');
  const vietnameseInSource = view.match(/[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđĐ]/g);
  assert.equal(vietnameseInSource, null, 'MemoryV2View must not contain Vietnamese text (comments included)');
});

test('i18n: MemoryV2View chỉ dùng key đã tồn tại; MemoryView nối tab v2', () => {
  const vi = readLocale('vi');
  const view = read('apps/desktop/src/renderer/components/MemoryV2View.tsx');
  for (const key of usedKeys(view)) {
    assert.ok(key in vi, `MemoryV2View dùng key chưa có: ${key}`);
  }
  // Mọi key memoryV2.* đều được component dùng (không có key chết).
  for (const key of EXPECTED_V2_KEYS) {
    if (key === 'memory.tabV2') continue;
    assert.ok(view.includes(`'${key}'`), `key ${key} không được dùng trong MemoryV2View`);
  }
  const memoryView = read('apps/desktop/src/renderer/components/MemoryView.tsx');
  assert.ok(memoryView.includes('MemoryV2View'), 'MemoryView phải import MemoryV2View');
  assert.ok(memoryView.includes('memory-tab-v2'), 'MemoryView phải có tab memory v2');
  assert.ok(memoryView.includes("'v2'"), 'MemoryView tab union phải có v2');
});

test('ipc: main đăng ký đủ 4 kênh memory-v2:* + store helpers', () => {
  const main = read('apps/desktop/src/main/main.ts');
  for (const channel of EXPECTED_IPC_CHANNELS) {
    assert.ok(main.includes(`'${channel}'`), `main thiếu IPC channel ${channel}`);
  }
  assert.ok(main.includes('graphStoreForBot'), 'main phải có graphStoreForBot');
  assert.ok(main.includes('sleepAgentForBot'), 'main phải có sleepAgentForBot');
  assert.ok(main.includes('TemporalKnowledgeGraph'), 'main phải import TemporalKnowledgeGraph');
  assert.ok(main.includes('SleepTimeAgent'), 'main phải import SleepTimeAgent');
  assert.ok(main.includes('hybridSearch'), 'main phải import hybridSearch');
  // Embedding không bao giờ trả về renderer qua kênh này.
  const searchSection = main.slice(main.indexOf("'memory-v2:search'"));
  assert.ok(searchSection.includes('embedding'), 'search handler phải xử lý embedding');
  assert.ok(
    searchSection.includes('void _embedding') || searchSection.includes('slice(0, 500)'),
    'search handler phải strip embedding khỏi kết quả trả về',
  );
});

test('preload: expose đủ 4 method memory-v2 + global.d.ts mirror', () => {
  const preload = read('apps/desktop/src/main/preload.ts');
  const globalDts = read('apps/desktop/src/renderer/global.d.ts');
  for (const method of EXPECTED_PRELOAD_METHODS) {
    assert.ok(preload.includes(method), `preload thiếu method ${method}`);
    assert.ok(globalDts.includes(method), `global.d.ts thiếu method ${method}`);
  }
  for (const channel of EXPECTED_IPC_CHANNELS) {
    assert.ok(preload.includes(`'${channel}'`), `preload thiếu invoke channel ${channel}`);
  }
  // Preload mirror đầy đủ các view type.
  for (const name of [
    'MemoryV2EntityView',
    'MemoryV2RelationView',
    'MemoryV2GraphView',
    'MemoryV2SearchView',
    'MemoryV2SleepView',
    'MemoryV2ProvenanceView',
  ]) {
    assert.ok(preload.includes(name), `preload thiếu view type ${name}`);
  }
});

test('component: MemoryV2View có đủ data-testid cho các thao tác chính', () => {
  const source = read('apps/desktop/src/renderer/components/MemoryV2View.tsx');
  for (const testid of EXPECTED_TESTIDS) {
    assert.ok(source.includes(testid), `MemoryV2View thiếu data-testid ${testid}`);
  }
  const memoryView = read('apps/desktop/src/renderer/components/MemoryView.tsx');
  for (const testid of EXPECTED_TAB_TESTIDS) {
    assert.ok(memoryView.includes(testid), `MemoryView thiếu data-testid ${testid}`);
  }
  // Component gọi đúng 4 API preload, không gọi IPC trực tiếp.
  for (const method of EXPECTED_PRELOAD_METHODS) {
    assert.ok(source.includes(`window.openBot.${method}`), `MemoryV2View phải gọi window.openBot.${method}`);
  }
  assert.ok(!source.includes('ipcRenderer'), 'renderer component không được gọi ipcRenderer trực tiếp');
  // Hiển thị giải thích nguồn của hybrid search + cờ quarantine + quota.
  for (const fragment of ['explanation', 'quarantined', 'quotaUsage', 'sleepSummary', 'keywordOnly']) {
    assert.ok(source.includes(fragment), `MemoryV2View thiếu phần hiển thị ${fragment}`);
  }
});

test('types: renderer types có đủ MemoryV2* views', () => {
  const types = read('apps/desktop/src/renderer/types.ts');
  for (const name of [
    'MemoryV2EntityView',
    'MemoryV2RelationView',
    'MemoryV2GraphView',
    'MemoryV2SearchHitView',
    'MemoryV2SearchView',
    'MemoryV2SleepReportView',
    'MemoryV2SleepView',
    'MemoryV2ProvenanceView',
  ]) {
    assert.ok(types.includes(name), `types.ts thiếu ${name}`);
  }
});

test('coordinator: sleep hook nối sau run thành công, best-effort', () => {
  const coordinator = read('packages/core/src/coordinator/coordinator.ts');
  assert.ok(coordinator.includes('maybeRunSleepAfterTurn'), 'coordinator phải có maybeRunSleepAfterTurn');
  assert.ok(coordinator.includes('scheduleSleepAfterTurn'), 'coordinator phải dùng scheduleSleepAfterTurn');
  assert.ok(coordinator.includes('episodesFromHistory'), 'coordinator phải dùng episodesFromHistory');
  assert.ok(coordinator.includes('createMemoryV2Tools'), 'coordinator phải đăng ký createMemoryV2Tools');
  // Hook nằm trong executeRun sau runner.run, bọc try/catch riêng.
  const hookAt = coordinator.indexOf('maybeRunSleepAfterTurn(entry, botId)');
  assert.ok(hookAt > 0, 'executeRun phải gọi maybeRunSleepAfterTurn');
  const before = coordinator.slice(hookAt - 2000, hookAt);
  const after = coordinator.slice(hookAt, hookAt + 500);
  assert.ok(before.includes('runner.run(runText)'), 'hook phải chạy sau runner.run');
  assert.ok(after.includes('catch'), 'hook phải bọc try/catch (best-effort)');
  // Hook không chặn turn: không await scheduleSleepAfterTurn ở đây.
  assert.ok(!before.includes('await scheduleSleepAfterTurn'), 'sleep hook không được await trên đường turn');
});

test('registry: 8 tool memory-v2 đăng ký qua coordinator (215 tool)', () => {
  const toolsIndex = read('packages/tools/src/index.ts');
  assert.ok(toolsIndex.includes('createMemoryV2Tools'), 'tools index phải export createMemoryV2Tools');
  assert.ok(toolsIndex.includes('MEMORY_V2_TOOL_NAMES'), 'tools index phải export MEMORY_V2_TOOL_NAMES');
  const v2Tools = read('packages/tools/src/memoryV2Tools.ts');
  for (const name of [
    'memory_sleep_run',
    'memory_sleep_status',
    'memory_sleep_configure',
    'memory_graph_entity',
    'memory_graph_relation',
    'memory_graph_query',
    'memory_hybrid_search',
    'memory_provenance',
  ]) {
    assert.ok(v2Tools.includes(`'${name}'`), `memoryV2Tools thiếu tool ${name}`);
  }
  // Tool ghi cần duyệt, tool đọc không cần duyệt.
  assert.ok(v2Tools.includes("needsApproval: true"), 'tool ghi phải needsApproval: true');
});
