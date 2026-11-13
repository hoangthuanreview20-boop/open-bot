/**
 * UI tests for v0.98 (Đội T1) — temporal knowledge graph UI.
 *
 * Part A (no display needed): i18n parity — every memoryGraph.* and
 * memory.tabGraph key exists with a non-empty string in all 6 locales,
 * and the key sets match exactly across locales; the GraphView and
 * MemoryView tab only use keys that exist; preload exposes the
 * memory-graph API; main registers all `memory-graph:*` IPC channels;
 * GraphView source contains the expected data-testids (search /
 * fact history+delete / quarantine approve+reject / share / sleep
 * run+toggle) so the renderer smoke tests of other waves can drive it.
 *
 * No CDP renderer part here: this VM has no DISPLAY, and the component
 * is fully covered statically (props + IPC + i18n). A live Electron
 * smoke run follows the same convention as
 * tests/memory-blocks-ui-v096.test.mjs when a display is available.
 *
 * Run: node --test tests/memory-graph-ui-v098.test.mjs
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

function usedTemplateKeys(source) {
  // Key dạng template: t(`memoryGraph.quarantineReason.${...}`) — bắt
  // prefix tới trước `${` (bỏ dấu chấm thừa ở cuối nếu có).
  return [...source.matchAll(/t\(`([a-z][a-zA-Z0-9_]*\.[a-zA-Z0-9_.]+)\$\{/g)].map((m) => m[1].replace(/\.+$/, ''));
}

test('i18n parity: memoryGraph.* + memory.tabGraph có đủ 6 locale, không rỗng', () => {
  const locales = Object.fromEntries(LOCALES.map((l) => [l, readLocale(l)]));
  const graphKeys = Object.keys(locales.en).filter((k) => k === 'memory.tabGraph' || k.startsWith('memoryGraph.'));
  assert.ok(graphKeys.length >= 55, `expected >=55 graph keys, got ${graphKeys.length}`);
  for (const key of graphKeys) {
    for (const locale of LOCALES) {
      assert.ok(key in locales[locale], `${locale} thiếu key ${key}`);
      assert.equal(typeof locales[locale][key], 'string', `${locale}.${key} phải là string`);
      assert.ok(locales[locale][key].trim() !== '', `${locale}.${key} rỗng`);
    }
  }
  // Key sets memoryGraph.* khớp nhau giữa các locale.
  for (const locale of LOCALES.slice(1)) {
    const keys = Object.keys(locales[locale]).filter((k) => k === 'memory.tabGraph' || k.startsWith('memoryGraph.'));
    assert.deepEqual(keys.sort(), graphKeys.sort(), `key set lệch ở locale ${locale}`);
  }
});

test('i18n: mọi key GraphView/MemoryView dùng đều tồn tại (kể cả key template)', () => {
  const en = readLocale('en');
  for (const file of ['GraphView.tsx', 'MemoryView.tsx']) {
    const source = fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', file), 'utf8');
    for (const key of usedKeys(source)) {
      if (key.startsWith('memoryGraph.') || key === 'memory.tabGraph') {
        assert.ok(key in en, `${file} dùng key không tồn tại: ${key}`);
      }
    }
    for (const prefix of usedTemplateKeys(source)) {
      // Key template phải có ít nhất một key thật bắt đầu bằng prefix.
      const matches = Object.keys(en).filter((k) => k.startsWith(`${prefix}.`));
      assert.ok(matches.length > 0, `${file} dùng prefix template không có key thật: ${prefix}`);
    }
  }
});

test('i18n vars: placeholder {…} trong key memoryGraph.* khớp nhau 6 locale', () => {
  const locales = Object.fromEntries(LOCALES.map((l) => [l, readLocale(l)]));
  const varsOf = (s) => [...s.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]).sort();
  for (const key of Object.keys(locales.en).filter((k) => k.startsWith('memoryGraph.'))) {
    const base = varsOf(locales.en[key]);
    for (const locale of LOCALES.slice(1)) {
      assert.deepEqual(varsOf(locales[locale][key]), base, `${key} lệch placeholder ở ${locale}`);
    }
  }
});

test('preload expose memory-graph API (interface + implementation)', () => {
  const source = fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'main', 'preload.ts'), 'utf8');
  for (const method of [
    'searchMemoryGraph', 'ingestMemoryGraph', 'listMemoryGraphFacts', 'listMemoryGraphEntities',
    'getMemoryGraphHistory', 'getMemoryGraphStats', 'deleteMemoryGraphFact',
    'reviewMemoryGraphQuarantine', 'shareMemoryGraph', 'searchSharedMemoryGraph', 'getMemoryGraphSleep',
  ]) {
    assert.ok(source.includes(method), `preload thiếu method ${method}`);
  }
  for (const channel of [
    'memory-graph:search', 'memory-graph:ingest', 'memory-graph:list', 'memory-graph:entities',
    'memory-graph:history', 'memory-graph:stats', 'memory-graph:delete', 'memory-graph:quarantine',
    'memory-graph:share', 'memory-graph:shared-search', 'memory-graph:sleep',
  ]) {
    assert.ok(source.includes(`'${channel}'`), `preload thiếu channel ${channel}`);
  }
  for (const view of ['GraphFactView', 'GraphSearchView', 'GraphStatsView', 'GraphSleepStatusView']) {
    assert.ok(source.includes(view), `preload thiếu view ${view}`);
  }
});

test('main đăng ký đủ IPC memory-graph:* + strip embedding', () => {
  const source = fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'main', 'main.ts'), 'utf8');
  for (const channel of [
    'memory-graph:search', 'memory-graph:ingest', 'memory-graph:list', 'memory-graph:entities',
    'memory-graph:history', 'memory-graph:stats', 'memory-graph:delete', 'memory-graph:quarantine',
    'memory-graph:share', 'memory-graph:shared-search', 'memory-graph:sleep',
  ]) {
    assert.ok(source.includes(`'${channel}'`), `main thiếu IPC ${channel}`);
  }
  assert.ok(source.includes('stripFactEmbedding'), 'main phải strip embedding trước khi trả fact về renderer');
  assert.ok(source.includes('TemporalGraphStore'), 'main phải dùng TemporalGraphStore');
  assert.ok(source.includes('createGraphSleepAgent'), 'main phải nối sleep agent');
});

test('GraphView có đủ data-testid để smoke test điều khiển', () => {
  const source = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'GraphView.tsx'), 'utf8',
  );
  for (const testid of [
    'memory-graph-view', 'memory-graph-stats', 'memory-graph-bot-select', 'memory-graph-status-filter',
    'memory-graph-search-input', 'memory-graph-search-button', 'memory-graph-search-results',
    'memory-graph-entities', 'memory-graph-share-target', 'memory-graph-share-button',
    'memory-graph-shares', 'memory-graph-sleep-status', 'memory-graph-sleep-run', 'memory-graph-sleep-toggle',
    'memory-graph-sleep-run-log', 'memory-graph-history-view', 'memory-graph-history-close',
  ]) {
    assert.ok(source.includes(`data-testid="${testid}"`), `GraphView thiếu testid ${testid}`);
  }
  // Testid động theo id fact/quarantine.
  for (const prefix of [
    'memory-graph-fact-', 'memory-graph-history-', 'memory-graph-delete-',
    'memory-graph-quarantine-', 'memory-graph-quarantine-approve-', 'memory-graph-quarantine-reject-',
  ]) {
    assert.ok(source.includes(prefix), `GraphView thiếu testid động ${prefix}…`);
  }
  assert.ok(source.includes('memoryGraph.quarantineTitle'), 'GraphView phải render mục quarantine');
  assert.ok(source.includes('window.openBot.searchMemoryGraph'), 'GraphView phải gọi searchMemoryGraph');
  assert.ok(source.includes('window.openBot.reviewMemoryGraphQuarantine'), 'GraphView phải gọi quarantine review');
});

test('MemoryView có tab đồ thị, renderer types + global.d.ts mirror đủ', () => {
  const memoryView = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'MemoryView.tsx'), 'utf8',
  );
  assert.ok(memoryView.includes("data-testid=\"memory-tab-graph\""), 'MemoryView thiếu tab graph');
  assert.ok(memoryView.includes("t('memory.tabGraph')"), 'MemoryView thiếu nhãn memory.tabGraph');
  assert.ok(memoryView.includes('GraphView'), 'MemoryView chưa mount GraphView');
  const types = fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'types.ts'), 'utf8');
  for (const view of ['GraphFactView', 'GraphEntityView', 'GraphSearchView', 'GraphStatsView', 'GraphQuarantineView', 'GraphShareView', 'GraphSleepConfigView', 'GraphSleepRunView']) {
    assert.ok(types.includes(view), `renderer/types.ts thiếu ${view}`);
  }
  assert.ok(!types.includes("from '@open-bot/core'"), 'renderer/types.ts phải tự chứa (không import core)');
  const globalDts = fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'global.d.ts'), 'utf8');
  for (const method of ['searchMemoryGraph', 'listMemoryGraphFacts', 'getMemoryGraphSleep', 'reviewMemoryGraphQuarantine']) {
    assert.ok(globalDts.includes(method), `global.d.ts thiếu ${method}`);
  }
});

test('tools registry: memory_graph_* đã đăng ký trong coordinator (guarded)', () => {
  const source = fs.readFileSync(path.join(REPO, 'packages', 'core', 'src', 'coordinator', 'coordinator.ts'), 'utf8');
  assert.ok(source.includes('createMemoryGraphTools'), 'coordinator chưa đăng ký createMemoryGraphTools');
  assert.ok(source.includes('TemporalGraphStore.fromWorkspace'), 'coordinator chưa nối graph store theo workspace');
  assert.ok(source.includes('createGraphSleepAgent'), 'coordinator chưa nối sleep agent');
  assert.ok(source.includes('graphStore.ingestEpisode'), 'coordinator chưa ingest turn vào graph lúc setup');
  assert.ok(source.includes('sleepAgent.maybeRun()'), 'coordinator chưa kích sleep agent sau turn');
});
