/**
 * UI tests for v1.01 (Đội T5) — evolving notes UI.
 *
 * Part A (no display needed): i18n parity — every notes.* and
 * memory.tabNotes key exists with a non-empty string in all 6 locales,
 * and the key sets match exactly across locales; MemoryNotesView and
 * MemoryView only use keys that exist; preload exposes the memory-notes
 * API; main registers all `memory-notes:*` IPC channels; MemoryNotesView
 * source contains the expected data-testids; coordinator registers the
 * notes tools (guarded).
 *
 * No CDP renderer part here: this VM has no DISPLAY, and the component
 * is fully covered statically (props + IPC + i18n). A live Electron
 * smoke run follows the same convention as
 * tests/memory-blocks-ui-v096.test.mjs when a display is available.
 *
 * Run: node --test tests/memory-notes-ui-v101.test.mjs
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
  return [...source.matchAll(/t\('([a-z][a-zA-Z0-9_]*\.[a-zA-Z0-9_.]+)'/g)].map((m) => m[1]);
}

test('i18n parity: notes.* + memory.tabNotes có đủ 6 locale, không rỗng', () => {
  const locales = Object.fromEntries(LOCALES.map((l) => [l, readLocale(l)]));
  const notesKeys = Object.keys(locales.en).filter((k) => k === 'memory.tabNotes' || k.startsWith('notes.'));
  assert.ok(notesKeys.length >= 80, `expected >=80 notes keys, got ${notesKeys.length}`);
  for (const key of notesKeys) {
    for (const locale of LOCALES) {
      assert.ok(key in locales[locale], `${locale} thiếu key ${key}`);
      assert.equal(typeof locales[locale][key], 'string', `${locale}.${key} phải là string`);
      assert.ok(locales[locale][key].trim() !== '', `${locale}.${key} rỗng`);
    }
  }
  for (const locale of LOCALES.slice(1)) {
    const keys = Object.keys(locales[locale]).filter((k) => k === 'memory.tabNotes' || k.startsWith('notes.'));
    assert.deepEqual(keys.sort(), notesKeys.sort(), `key set lệch ở locale ${locale}`);
  }
});

test('i18n: mọi key MemoryNotesView/MemoryView dùng đều tồn tại', () => {
  const en = readLocale('en');
  for (const file of ['MemoryNotesView.tsx', 'MemoryView.tsx']) {
    const source = fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', file), 'utf8');
    for (const key of usedKeys(source)) {
      if (key.startsWith('notes.') || key === 'memory.tabNotes') {
        assert.ok(key in en, `${file} dùng key không tồn tại: ${key}`);
      }
    }
  }
  // Key kind động: kindLabel() ghép `notes.kind${Kind}` — 8 kind phải có đủ.
  for (const kind of ['Fact', 'Preference', 'Event', 'Project', 'Person', 'Place', 'Idea', 'Other']) {
    assert.ok(`notes.kind${kind}` in en, `thiếu key notes.kind${kind}`);
  }
  // Key link-kind động: linkKindLabel() ghép theo kind.
  for (const kind of ['Related', 'Supports', 'Contradicts', 'Supersedes', 'PartOf']) {
    assert.ok(`notes.linkKind${kind}` in en, `thiếu key notes.linkKind${kind}`);
  }
});

test('preload expose memory-notes API (interface + implementation)', () => {
  const source = fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'main', 'preload.ts'), 'utf8');
  for (const method of [
    'listMemoryNotes', 'searchMemoryNotes', 'getMemoryNote', 'createMemoryNote',
    'updateMemoryNote', 'deleteMemoryNote', 'restoreMemoryNote', 'linkMemoryNote',
    'suggestMemoryNoteLinks', 'getMemoryNotesGraph', 'getMemoryNotesTimeline',
    'getMemoryNotesStats', 'revisitMemoryNote', 'reviewMemoryNoteConflicts',
    'runMemoryNotesBenchmark', 'importMemoryNotes',
  ]) {
    assert.ok(source.includes(method), `preload thiếu method ${method}`);
  }
  for (const channel of [
    'memory-notes:list', 'memory-notes:search', 'memory-notes:get', 'memory-notes:create',
    'memory-notes:update', 'memory-notes:delete', 'memory-notes:restore', 'memory-notes:link',
    'memory-notes:suggest-links', 'memory-notes:graph', 'memory-notes:timeline',
    'memory-notes:stats', 'memory-notes:revisit', 'memory-notes:conflicts',
    'memory-notes:benchmark', 'memory-notes:import',
  ]) {
    assert.ok(source.includes(`'${channel}'`), `preload thiếu channel ${channel}`);
  }
  for (const view of ['NoteView', 'NotesGraphView', 'NotesStatsView', 'NoteConflictView', 'BenchmarkReportView']) {
    assert.ok(source.includes(view), `preload thiếu view ${view}`);
  }
});

test('main đăng ký đủ IPC memory-notes:* + dùng EvolvingNoteStore', () => {
  const source = fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'main', 'main.ts'), 'utf8');
  for (const channel of [
    'memory-notes:list', 'memory-notes:search', 'memory-notes:get', 'memory-notes:create',
    'memory-notes:update', 'memory-notes:delete', 'memory-notes:restore', 'memory-notes:link',
    'memory-notes:suggest-links', 'memory-notes:graph', 'memory-notes:timeline',
    'memory-notes:stats', 'memory-notes:revisit', 'memory-notes:conflicts',
    'memory-notes:benchmark', 'memory-notes:import',
  ]) {
    assert.ok(source.includes(`'${channel}'`), `main thiếu IPC ${channel}`);
  }
  assert.ok(source.includes('EvolvingNoteStore'), 'main phải dùng EvolvingNoteStore');
  assert.ok(source.includes('notesStoreForBot'), 'main phải có notesStoreForBot');
  assert.ok(source.includes('RevisitEngine'), 'main phải nối RevisitEngine cho revisit IPC');
  assert.ok(source.includes('runBenchmarkOnStore'), 'main phải chạy benchmark trên store in-memory riêng');
});

test('MemoryNotesView có đủ data-testid để smoke test điều khiển', () => {
  const source = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'MemoryNotesView.tsx'), 'utf8',
  );
  for (const testid of [
    'memory-notes-view', 'notes-stats', 'notes-import', 'notes-graph-toggle',
    'notes-timeline-toggle', 'notes-save', 'notes-search', 'notes-detail',
    'notes-suggest-links', 'notes-graph', 'notes-timeline', 'notes-benchmark',
    'notes-run-benchmark',
  ]) {
    assert.ok(source.includes(`data-testid="${testid}"`), `MemoryNotesView thiếu testid ${testid}`);
  }
  for (const prefix of ['notes-item-', 'notes-conflict-']) {
    assert.ok(source.includes(prefix), `MemoryNotesView thiếu testid động ${prefix}…`);
  }
  assert.ok(source.includes('window.openBot.searchMemoryNotes'), 'MemoryNotesView phải gọi searchMemoryNotes');
  assert.ok(source.includes('window.openBot.revisitMemoryNote'), 'MemoryNotesView phải gọi revisitMemoryNote');
  assert.ok(source.includes('window.openBot.runMemoryNotesBenchmark'), 'MemoryNotesView phải gọi runMemoryNotesBenchmark');
  assert.ok(source.includes('window.openBot.reviewMemoryNoteConflicts'), 'MemoryNotesView phải gọi reviewMemoryNoteConflicts');
});

test('MemoryView có tab notes, renderer types + global.d.ts mirror đủ', () => {
  const memoryView = fs.readFileSync(
    path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'components', 'MemoryView.tsx'), 'utf8',
  );
  assert.ok(memoryView.includes('data-testid="memory-tab-notes"'), 'MemoryView thiếu tab notes');
  assert.ok(memoryView.includes("t('memory.tabNotes')"), 'MemoryView thiếu nhãn memory.tabNotes');
  assert.ok(memoryView.includes('MemoryNotesView'), 'MemoryView chưa mount MemoryNotesView');
  const types = fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'types.ts'), 'utf8');
  for (const view of ['NoteView', 'NoteSearchHitView', 'NotesGraphView', 'NotesStatsView', 'NoteConflictView', 'RevisitAnalysisView', 'BenchmarkReportView']) {
    assert.ok(types.includes(view), `renderer/types.ts thiếu ${view}`);
  }
  assert.ok(!types.includes("from '@open-bot/core'"), 'renderer/types.ts phải tự chứa (không import core)');
  const globalDts = fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'global.d.ts'), 'utf8');
  for (const method of ['listMemoryNotes', 'searchMemoryNotes', 'getMemoryNote', 'revisitMemoryNote', 'runMemoryNotesBenchmark']) {
    assert.ok(globalDts.includes(method), `global.d.ts thiếu ${method}`);
  }
});

test('tools registry: notes_* đã đăng ký trong coordinator (guarded)', () => {
  const source = fs.readFileSync(path.join(REPO, 'packages', 'core', 'src', 'coordinator', 'coordinator.ts'), 'utf8');
  assert.ok(source.includes('createMemoryNotesTools'), 'coordinator chưa đăng ký createMemoryNotesTools');
  assert.ok(source.includes('EvolvingNoteStore.fromWorkspace'), 'coordinator chưa nối notes store theo workspace');
  const toolsIndex = fs.readFileSync(path.join(REPO, 'packages', 'tools', 'src', 'index.ts'), 'utf8');
  assert.ok(toolsIndex.includes('createMemoryNotesTools'), 'tools/index.ts chưa export createMemoryNotesTools');
  assert.ok(toolsIndex.includes('MEMORY_NOTES_TOOL_NAMES'), 'tools/index.ts chưa export MEMORY_NOTES_TOOL_NAMES');
});
