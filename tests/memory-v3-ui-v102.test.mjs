/**
 * UI tests for v1.02 (Team T2) — memory v3 UI.
 *
 * Part A (no display needed): i18n parity — every memory.v3.* and
 * memory.tabV3 key exists with a non-empty string in all 6 locales,
 * and the key sets match exactly across locales; the MemoryV3View
 * and MemoryView tab only use keys that exist; preload exposes the
 * memory-v3 API; main registers all `memory-v3:*` IPC channels;
 * MemoryV3View source contains the expected data-testids (conflicts
 * list + keep/accept/merge resolve, contradictions search, block
 * history load + restore) so the renderer smoke tests of other waves
 * can drive it.
 *
 * No CDP renderer part here: this VM has no DISPLAY, and the
 * component is fully covered statically (props + IPC + i18n).
 *
 * Run: node --test tests/memory-v3-ui-v102.test.mjs
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
  return fs.readFileSync(path.join(REPO, ...rel), 'utf8');
}

function usedKeys(source) {
  // Key i18n luôn có dạng namespace.key (chứa dấu chấm).
  return [...source.matchAll(/t\('([a-z][a-zA-Z0-9_]*\.[a-zA-Z0-9_.]+)'/g)].map((m) => m[1]);
}

test('i18n parity: memory.v3.* + memory.tabV3 có đủ 6 locale, không rỗng', () => {
  const locales = Object.fromEntries(LOCALES.map((l) => [l, readLocale(l)]));
  const v3Keys = Object.keys(locales.en).filter((k) => k === 'memory.tabV3' || k.startsWith('memory.v3.'));
  assert.equal(v3Keys.length, 30, `expected 30 v3 keys, got ${v3Keys.length}`);
  for (const key of v3Keys) {
    for (const locale of LOCALES) {
      assert.ok(key in locales[locale], `${locale} thiếu key ${key}`);
      assert.equal(typeof locales[locale][key], 'string', `${locale}.${key} phải là string`);
      assert.ok(locales[locale][key].trim() !== '', `${locale}.${key} rỗng`);
    }
  }
  for (const locale of LOCALES.slice(1)) {
    const keys = Object.keys(locales[locale]).filter((k) => k === 'memory.tabV3' || k.startsWith('memory.v3.'));
    assert.deepEqual(keys.sort(), [...v3Keys].sort(), `key set v3 lệch ở ${locale}`);
  }
});

test('MemoryV3View + MemoryView chỉ dùng key i18n đã tồn tại', () => {
  const locales = readLocale('en');
  for (const file of [
    ['apps', 'desktop', 'src', 'renderer', 'components', 'MemoryV3View.tsx'],
    ['apps', 'desktop', 'src', 'renderer', 'components', 'MemoryView.tsx'],
  ]) {
    const source = read(file);
    for (const key of usedKeys(source)) {
      if (key === 'memory.tabV3' || key.startsWith('memory.v3.')) {
        assert.ok(key in locales, `${file.join('/')} dùng key chưa có: ${key}`);
      }
    }
  }
});

test('preload exposes the memory-v3 API; main registers memory-v3:* channels', () => {
  const preload = read(['apps', 'desktop', 'src', 'main', 'preload.ts']);
  for (const method of ['listMemoryV3Conflicts', 'findMemoryV3Contradictions', 'getMemoryV3BlockHistory']) {
    assert.ok(preload.includes(method), `preload thiếu ${method}`);
  }
  for (const channel of ['memory-v3:conflicts', 'memory-v3:contradictions', 'memory-v3:block-history']) {
    assert.ok(preload.includes(`'${channel}'`), `preload thiếu channel ${channel}`);
  }
  const main = read(['apps', 'desktop', 'src', 'main', 'main.ts']);
  for (const channel of ['memory-v3:conflicts', 'memory-v3:contradictions', 'memory-v3:block-history']) {
    assert.ok(main.includes(`'${channel}'`), `main thiếu handler ${channel}`);
  }
  const globalDts = read(['apps', 'desktop', 'src', 'renderer', 'global.d.ts']);
  for (const method of ['listMemoryV3Conflicts', 'findMemoryV3Contradictions', 'getMemoryV3BlockHistory']) {
    assert.ok(globalDts.includes(method), `global.d.ts thiếu ${method}`);
  }
});

test('MemoryV3View has the expected data-testids; MemoryView mounts the v3 tab', () => {
  const view = read(['apps', 'desktop', 'src', 'renderer', 'components', 'MemoryV3View.tsx']);
  for (const testid of [
    'memory-v3-view',
    'memory-v3-conflicts',
    'memory-v3-no-conflicts',
    'memory-v3-contradictions',
    'memory-v3-window-a-from',
    'memory-v3-window-a-to',
    'memory-v3-window-b-from',
    'memory-v3-window-b-to',
    'memory-v3-search-contradictions',
    'memory-v3-block-history',
    'memory-v3-block-label',
    'memory-v3-load-history',
  ]) {
    assert.ok(view.includes(testid), `MemoryV3View thiếu testid ${testid}`);
  }
  for (const snippet of ['memory-v3-keep-', 'memory-v3-accept-', 'memory-v3-merge-', 'memory-v3-restore-']) {
    assert.ok(view.includes(snippet), `MemoryV3View thiếu testid prefix ${snippet}`);
  }
  const memoryView = read(['apps', 'desktop', 'src', 'renderer', 'components', 'MemoryView.tsx']);
  assert.ok(memoryView.includes('memory-tab-v3'), 'MemoryView thiếu nút tab v3');
  assert.ok(memoryView.includes('MemoryV3View'), 'MemoryView chưa import MemoryV3View');
  assert.ok(memoryView.includes("setTab('v3')"), 'MemoryView chưa setTab v3');
});
