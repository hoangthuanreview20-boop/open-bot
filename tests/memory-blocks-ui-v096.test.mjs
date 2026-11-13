/**
 * UI tests for v0.96 (Đội T1) — memory blocks UI.
 *
 * Part A (no display needed): i18n parity — every memoryBlock.* and
 * memory.tab* key exists with a non-empty string in all 6 locales, and
 * the key sets match exactly across locales; the two components
 * (MemoryBlocksView, MemoryView tab) only use keys that exist; preload
 * exposes the memoryBlocks API; main registers all `memory-blocks:*`
 * IPC channels; MemoryBlocksView source contains the expected
 * data-testids (attach/detach/share/read-only/delete/export/import/
 * consolidate) so the renderer smoke tests of other waves can drive it.
 *
 * No CDP renderer part here: this VM has no DISPLAY, and the component
 * is fully covered statically (props + IPC + i18n). A live Electron
 * smoke run follows the same convention as
 * tests/memory-ui-v095d4.test.mjs when a display is available.
 *
 * Run: node --test tests/memory-blocks-ui-v096.test.mjs
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

const EXPECTED_TESTIDS = [
  'memory-blocks-bot-select',
  'memory-blocks-new-label',
  'memory-blocks-new-description',
  'memory-blocks-new-content',
  'memory-blocks-create',
  'memory-blocks-export',
  'memory-blocks-import',
  'memory-blocks-consolidate',
  'memory-blocks-consolidate-status',
  'memory-blocks-attached-list',
  'memory-blocks-detached-list',
];

// Tab chuyển Memories <-> Memory blocks sống trong MemoryView (không
// phải MemoryBlocksView).
const EXPECTED_TAB_TESTIDS = ['memory-tabs', 'memory-tab-memories', 'memory-tab-blocks'];

const EXPECTED_IPC_CHANNELS = [
  'memory-blocks:list',
  'memory-blocks:create',
  'memory-blocks:update',
  'memory-blocks:append',
  'memory-blocks:delete',
  'memory-blocks:attach',
  'memory-blocks:detach',
  'memory-blocks:share',
  'memory-blocks:read-only',
  'memory-blocks:export',
  'memory-blocks:import',
  'memory-blocks:consolidate',
];

const EXPECTED_PRELOAD_METHODS = [
  'listMemoryBlocks',
  'createMemoryBlock',
  'updateMemoryBlock',
  'appendMemoryBlock',
  'deleteMemoryBlock',
  'attachMemoryBlock',
  'detachMemoryBlock',
  'shareMemoryBlock',
  'setMemoryBlockReadOnly',
  'exportMemoryBlocks',
  'importMemoryBlocks',
  'consolidateMemory',
];

test('i18n: memoryBlock.* + memory.tab* đầy đủ 6 locale, key set khớp nhau', () => {
  const locales = Object.fromEntries(LOCALES.map((l) => [l, readLocale(l)]));
  const keySets = LOCALES.map((l) =>
    Object.keys(locales[l]).filter((k) => k.startsWith('memoryBlock.') || k.startsWith('memory.tab')),
  );
  const reference = keySets[0];
  assert.ok(reference.length >= 59, `expected >= 59 memoryBlock keys, got ${reference.length}`);
  for (let i = 1; i < LOCALES.length; i++) {
    assert.deepEqual(
      [...keySets[i]].sort(),
      [...reference].sort(),
      `locale ${LOCALES[i]} key set khác vi`,
    );
  }
  for (const locale of LOCALES) {
    for (const key of reference) {
      const value = locales[locale][key];
      assert.equal(typeof value, 'string', `${locale}:${key} phải là string`);
      assert.ok(value.trim() !== '', `${locale}:${key} không được rỗng`);
    }
    // Placeholder {name} trong các locale phải khớp vi (tránh lệch biến).
    for (const key of reference) {
      const viPlaceholders = [...locales.vi[key].matchAll(/\{[a-zA-Z]+\}/g)].map((m) => m[0]).sort();
      const placeholders = [...locales[locale][key].matchAll(/\{[a-zA-Z]+\}/g)].map((m) => m[0]).sort();
      assert.deepEqual(placeholders, viPlaceholders, `${locale}:${key} placeholder khác vi`);
    }
  }
});

test('i18n: MemoryBlocksView + MemoryView tab chỉ dùng key đã tồn tại', () => {
  const vi = readLocale('vi');
  const blocksView = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'MemoryBlocksView.tsx'),
    'utf8',
  );
  const memoryView = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'MemoryView.tsx'),
    'utf8',
  );
  for (const key of usedKeys(blocksView)) {
    assert.ok(key in vi, `MemoryBlocksView dùng key chưa có: ${key}`);
  }
  for (const key of usedKeys(memoryView)) {
    assert.ok(key in vi, `MemoryView dùng key chưa có: ${key}`);
  }
  // Tab blocks được nối vào MemoryView.
  assert.ok(memoryView.includes('MemoryBlocksView'), 'MemoryView phải import MemoryBlocksView');
  assert.ok(memoryView.includes("memory-tab-blocks"), 'MemoryView phải có tab memory blocks');
});

test('ipc: main đăng ký đủ 12 kênh memory-blocks:*', () => {
  const main = fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'main', 'main.ts'), 'utf8');
  for (const channel of EXPECTED_IPC_CHANNELS) {
    assert.ok(main.includes(`'${channel}'`), `main thiếu IPC channel ${channel}`);
  }
  assert.ok(main.includes('blocksStoreForBot'), 'main phải có blocksStoreForBot');
  assert.ok(main.includes('MemoryBlockStore'), 'main phải import MemoryBlockStore');
});

test('preload: expose đủ 12 method memoryBlocks + global.d.ts mirror', () => {
  const preload = fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'main', 'preload.ts'), 'utf8');
  const globalDts = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'global.d.ts'),
    'utf8',
  );
  for (const method of EXPECTED_PRELOAD_METHODS) {
    assert.ok(preload.includes(method), `preload thiếu method ${method}`);
    assert.ok(globalDts.includes(method), `global.d.ts thiếu method ${method}`);
  }
  for (const channel of EXPECTED_IPC_CHANNELS) {
    assert.ok(preload.includes(`'${channel}'`), `preload thiếu invoke channel ${channel}`);
  }
});

test('component: MemoryBlocksView có đủ data-testid cho các thao tác chính', () => {
  const source = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'MemoryBlocksView.tsx'),
    'utf8',
  );
  for (const testid of EXPECTED_TESTIDS) {
    assert.ok(source.includes(testid), `MemoryBlocksView thiếu data-testid ${testid}`);
  }
  const memoryView = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'MemoryView.tsx'),
    'utf8',
  );
  for (const testid of EXPECTED_TAB_TESTIDS) {
    assert.ok(memoryView.includes(testid), `MemoryView thiếu data-testid ${testid}`);
  }
  for (const fragment of [
    'memory-block-edit-',
    'memory-block-save-',
    'memory-block-attach-',
    'memory-block-share-all-',
    'memory-block-readonly-',
    'memory-block-delete-',
    'memory-block-delete-confirm-',
  ]) {
    assert.ok(source.includes(fragment), `MemoryBlocksView thiếu testid prefix ${fragment}`);
  }
});

test('types: renderer types có MemoryBlockView + export/import/consolidate views', () => {
  const types = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'types.ts'),
    'utf8',
  );
  for (const name of [
    'MemoryBlockView',
    'MemoryBlocksExportView',
    'MemoryBlocksImportView',
    'MemoryConsolidateView',
  ]) {
    assert.ok(types.includes(`interface ${name}`), `types.ts thiếu ${name}`);
  }
  assert.ok(types.includes('attachedBots: string[]'), 'MemoryBlockView phải có attachedBots');
});
