/**
 * UI tests for v1.01 (Đội T4) — verbatim memory view.
 *
 * Part A (no display needed): i18n parity — every verbatim.* key exists
 * with a non-empty string in all 6 locales, key sets match exactly,
 * placeholders match en.json; the new component only uses keys that
 * exist; preload exposes the verbatim-memory API; main registers the
 * verbatim-memory:* IPC channels.
 *
 * Renderer part (Electron under xvfb) is intentionally NOT run here —
 * same convention as the other smoke tests when there is no DISPLAY;
 * the component is covered by typecheck + build of the desktop
 * workspace instead.
 *
 * Run: node --test tests/verbatim-memory-ui-v101.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const localesDir = path.join(repo, 'apps/desktop/src/renderer/i18n/locales');
const LOCALES = ['en', 'vi', 'es', 'fr', 'ja', 'zh'];

function loadLocale(loc) {
  return JSON.parse(fs.readFileSync(path.join(localesDir, `${loc}.json`), 'utf8'));
}

function placeholders(value) {
  return [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

const en = loadLocale('en');
const verbatimKeys = Object.keys(en).filter((k) => k.startsWith('verbatim.'));
const memoryTabKey = 'memory.tabVerbatim';

test('verbatim ui: verbatim.* keys exist in en + memory.tabVerbatim', () => {
  assert.ok(verbatimKeys.length >= 40, `expected >= 40 verbatim.* keys, got ${verbatimKeys.length}`);
  assert.ok(memoryTabKey in en);
  for (const key of verbatimKeys) {
    assert.equal(typeof en[key], 'string');
    assert.ok(en[key].trim() !== '', `${key} must be non-empty`);
  }
});

test('verbatim ui: all 6 locales have exactly the same verbatim.* keys + placeholders', () => {
  for (const loc of LOCALES) {
    const data = loadLocale(loc);
    const keys = Object.keys(data).filter((k) => k.startsWith('verbatim.'));
    assert.deepEqual([...keys].sort(), [...verbatimKeys].sort(), `${loc}: verbatim.* key set differs`);
    assert.ok(memoryTabKey in data, `${loc}: missing ${memoryTabKey}`);
    for (const key of verbatimKeys) {
      assert.equal(typeof data[key], 'string', `${loc}:${key} must be a string`);
      assert.ok(data[key].trim() !== '', `${loc}:${key} must be non-empty`);
      assert.deepEqual(placeholders(data[key]), placeholders(en[key]), `${loc}:${key} placeholders differ`);
    }
  }
});

test('verbatim ui: component uses only existing keys, no hard-coded Vietnamese', () => {
  const component = fs.readFileSync(
    path.join(repo, 'apps/desktop/src/renderer/components/VerbatimMemoryView.tsx'),
    'utf8',
  );
  const usedKeys = [...component.matchAll(/t\('(verbatim\.[a-zA-Z]+)'/g)].map((m) => m[1]);
  assert.ok(usedKeys.length > 10, `expected component to use verbatim.* keys, got ${usedKeys.length}`);
  const allKeys = new Set([...Object.keys(en)]);
  for (const key of new Set(usedKeys)) {
    assert.ok(allKeys.has(key), `component uses missing key ${key}`);
  }
  // Vietnamese lives only in locales/vi.json — component must not contain
  // Vietnamese display strings (same rule as i18n.test.mjs).
  const vietnamese = /[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/i;
  const lines = component.split('\n');
  for (const line of lines) {
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
    assert.ok(!vietnamese.test(line), `hard-coded Vietnamese in component: ${line.trim()}`);
  }
  // MemoryView wires the verbatim tab.
  const memoryView = fs.readFileSync(
    path.join(repo, 'apps/desktop/src/renderer/components/MemoryView.tsx'),
    'utf8',
  );
  assert.ok(memoryView.includes('VerbatimMemoryView'));
  assert.ok(memoryView.includes('memory-tab-verbatim'));
  assert.ok(memoryView.includes("setTab('verbatim')"));
});

test('verbatim ui: preload exposes verbatim API, main registers channels', () => {
  const preload = fs.readFileSync(path.join(repo, 'apps/desktop/src/main/preload.ts'), 'utf8');
  for (const fn of [
    'listVerbatimMemories',
    'searchVerbatimMemories',
    'deleteVerbatimMemory',
    'getVerbatimMemoryStats',
    'exportVerbatimMemories',
    'backfillVerbatimMemories',
    'consolidateVerbatimMemories',
    'applyVerbatimDedup',
  ]) {
    assert.ok(preload.includes(fn), `preload missing ${fn}`);
  }
  const main = fs.readFileSync(path.join(repo, 'apps/desktop/src/main/main.ts'), 'utf8');
  for (const channel of [
    'verbatim-memory:list',
    'verbatim-memory:search',
    'verbatim-memory:delete',
    'verbatim-memory:stats',
    'verbatim-memory:export',
    'verbatim-memory:backfill',
    'verbatim-memory:consolidate',
    'verbatim-memory:apply-dedup',
  ]) {
    assert.ok(main.includes(`'${channel}'`), `main missing IPC channel ${channel}`);
  }
  // Main strips embeddings before returning search hits to the renderer.
  assert.ok(main.includes('Strip vector embedding'), 'main must strip embeddings in verbatim-memory:search');
});

test('verbatim ui: renderer types mirror preload views', () => {
  const types = fs.readFileSync(path.join(repo, 'apps/desktop/src/renderer/types.ts'), 'utf8');
  for (const name of ['VerbatimRecordView', 'VerbatimSearchView', 'VerbatimStatsView', 'VerbatimConsolidateView']) {
    assert.ok(types.includes(name), `renderer/types.ts missing ${name}`);
  }
  const globalDts = fs.readFileSync(path.join(repo, 'apps/desktop/src/renderer/global.d.ts'), 'utf8');
  for (const fn of ['listVerbatimMemories', 'searchVerbatimMemories', 'getVerbatimMemoryStats']) {
    assert.ok(globalDts.includes(fn), `global.d.ts missing ${fn}`);
  }
});
