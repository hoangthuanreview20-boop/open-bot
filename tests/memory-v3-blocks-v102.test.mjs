/**
 * Tests for v1.02 (Team T2) — memory blocks v2:
 * packages/core/src/memory/{blocks,blockHistory,blockConflicts}.ts.
 *
 * Covers: version snapshots recorded on create/update/replace/append/
 * set-read-only (and a tombstone on delete), getHistory ordering,
 * restoreVersion (old content returns as a NEW version, history is
 * never rewritten), restore errors (unknown version, read-only),
 * conflict detection on promoted-fact lines (same subject+predicate,
 * different object), duplicate pending conflicts are not re-recorded,
 * resolution (keep-current / accept-new / merged) + resolution errors.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v3-blocks-v102.test.mjs
 *
 * No network. No model.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MemoryBlockStore,
  BlockConflictStore,
  parsePromotedLine,
  findConflictingLine,
  promotedFactLine,
} from '../packages/core/dist/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv3-blocks-v102-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeStore() {
  return new MemoryBlockStore(makeTempDir());
}

// --- Version history -----------------------------------------------------

test('block history: every write snapshots a version, oldest first', () => {
  const store = makeStore();
  const block = store.create({ label: 'human', description: 'about user', content: 'v1 content' }, 'user');
  store.update(block.id, { content: 'v2 content' }, 'user');
  store.append(block.id, 'extra line', 'user');
  store.replace(block.id, 'v4 content', 'user');
  store.setReadOnly(block.id, true, 'user');

  const history = store.getHistory(block.id);
  assert.equal(history.length, 5, JSON.stringify(history.map((h) => `${h.version}:${h.action}`)));
  assert.deepEqual(history.map((h) => h.version), [1, 2, 3, 4, 5]);
  assert.deepEqual(history.map((h) => h.action), ['create', 'update', 'append', 'replace', 'set-read-only']);
  assert.equal(history[0].content, 'v1 content');
  assert.equal(history[1].content, 'v2 content');
  assert.equal(history[2].content, 'v2 content\nextra line');
  assert.equal(history[3].content, 'v4 content');
  assert.equal(history[4].readOnly, true);
  // No-op update writes no snapshot.
  store.setReadOnly(block.id, true, 'user');
  assert.equal(store.getHistory(block.id).length, 5);
});

test('restoreVersion: old content returns as a NEW version, history intact', () => {
  const store = makeStore();
  const block = store.create({ label: 'human', content: 'original' }, 'user');
  store.replace(block.id, 'changed', 'user');
  store.replace(block.id, 'changed again', 'user');
  assert.equal(store.get(block.id).version, 3);

  const restored = store.restoreVersion(block.id, 1, 'user');
  assert.equal(restored.content, 'original');
  assert.equal(restored.version, 4);
  const history = store.getHistory(block.id);
  assert.equal(history.length, 4);
  assert.equal(history[3].version, 4);
  assert.equal(history[3].action, 'restore');
  assert.equal(history[3].content, 'original');
  // The old versions are still there — history was never rewritten.
  assert.equal(history[0].version, 1);
  assert.equal(history[0].content, 'original');
});

test('restoreVersion: errors on unknown version / read-only block / no-op', () => {
  const store = makeStore();
  const block = store.create({ label: 'human', content: 'v1' }, 'user');
  assert.throws(() => store.restoreVersion(block.id, 99, 'user'), /không có version 99/);
  const restored = store.restoreVersion(block.id, 1, 'user');
  assert.equal(restored.version, 1, 'restoring current content is a no-op');
  store.setReadOnly(block.id, true, 'user');
  assert.throws(() => store.restoreVersion(block.id, 1, 'user'), /read-only/);
});

test('block history: delete leaves a tombstone snapshot readable by id', () => {
  const store = makeStore();
  const block = store.create({ label: 'temp', content: 'to delete' }, 'user');
  store.delete(block.id, 'user');
  assert.equal(store.get(block.id), null);
  const history = store.getHistoryById(block.id);
  assert.equal(history.length, 2);
  assert.equal(history[1].action, 'delete');
  assert.equal(history[1].content, 'to delete');
});

// --- Conflicts -----------------------------------------------------------

test('parsePromotedLine + findConflictingLine: only promoted lines match', () => {
  assert.deepEqual(parsePromotedLine('- user: lives_in Hà Nội'), {
    subject: 'user',
    predicate: 'lives_in',
    object: 'Hà Nội',
  });
  assert.equal(parsePromotedLine('user lives in Ha Noi (free prose)'), null);
  assert.equal(parsePromotedLine('- user: lives_in'), null);

  const content = '- user: lives_in Hà Nội\n- user: likes phở bò\nFree prose about Ha Noi.';
  assert.equal(findConflictingLine(content, 'user', 'lives_in', 'TP. Hồ Chí Minh'), '- user: lives_in Hà Nội');
  assert.equal(findConflictingLine(content, 'user', 'lives_in', 'Hà Nội'), null, 'same object is not a conflict');
  assert.equal(findConflictingLine(content, 'user', 'lives_in', 'ha noi'), null, 'normalized same object is not a conflict');
  assert.equal(findConflictingLine(content, 'user', 'likes', 'bún chả'), '- user: likes phở bò');
  assert.equal(findConflictingLine(content, 'user', 'works_at', 'FPT'), null, 'no line for this predicate');
  assert.equal(findConflictingLine(content, 'bot', 'lives_in', 'Đà Nẵng'), null, 'different subject');
  assert.equal(promotedFactLine('user', 'lives_in', 'TP. Hồ Chí Minh'), '- user: lives_in TP. Hồ Chí Minh');
});

test('BlockConflictStore: checkAndRecord records a pending conflict with both sides', () => {
  const dir = makeTempDir();
  const blocks = new MemoryBlockStore(dir);
  const conflicts = new BlockConflictStore(dir);
  const block = blocks.create(
    { label: 'human', content: '- user: lives_in Hà Nội\n- user: likes phở bò' },
    'user',
  );
  const conflict = conflicts.checkAndRecord(
    block.id,
    block.label,
    block.content,
    block.version,
    'user',
    'lives_in',
    'TP. Hồ Chí Minh',
    { factId: 'fact-1', episodeId: 'ep-1', confidence: 0.95, at: '2026-11-12T10:00:00.000Z', actor: 'system:consolidate' },
  );
  assert.ok(conflict, 'conflict expected');
  assert.equal(conflict.status, 'pending');
  assert.equal(conflict.predicate, 'lives_in');
  assert.equal(conflict.oldSide.text, '- user: lives_in Hà Nội');
  assert.equal(conflict.oldSide.blockVersion, 1);
  assert.equal(conflict.newSide.text, '- user: lives_in TP. Hồ Chí Minh');
  assert.equal(conflict.newSide.factId, 'fact-1');
  assert.equal(conflict.newSide.episodeId, 'ep-1');
  assert.equal(conflict.newSide.confidence, 0.95);
  assert.equal(conflict.newSide.at, '2026-11-12T10:00:00.000Z');

  // No contradiction -> null (caller may append).
  assert.equal(
    conflicts.checkAndRecord(block.id, block.label, block.content, block.version, 'user', 'likes', 'phở bò', {}),
    null,
  );
  assert.equal(
    conflicts.checkAndRecord(block.id, block.label, block.content, block.version, 'user', 'works_at', 'FPT', {}),
    null,
  );
});

test('BlockConflictStore: identical pending conflict is not recorded twice', () => {
  const dir = makeTempDir();
  const conflicts = new BlockConflictStore(dir);
  const content = '- user: lives_in Hà Nội';
  const first = conflicts.checkAndRecord('block-1', 'human', content, 1, 'user', 'lives_in', 'TP. Hồ Chí Minh', {});
  const second = conflicts.checkAndRecord('block-1', 'human', content, 1, 'user', 'lives_in', 'TP. Hồ Chí Minh', {});
  assert.equal(first.id, second.id);
  assert.equal(conflicts.list({ status: 'pending' }).length, 1);
});

test('BlockConflictStore: resolve keep-current / accept-new / merged, with errors', () => {
  const dir = makeTempDir();
  const conflicts = new BlockConflictStore(dir);
  const mk = (object) =>
    conflicts.checkAndRecord('block-1', 'human', '- user: lives_in Hà Nội', 1, 'user', 'lives_in', object, {});

  const keep = mk('TP. Hồ Chí Minh');
  const resolvedKeep = conflicts.resolve(keep.id, 'keep-current', 'user');
  assert.equal(resolvedKeep.status, 'resolved');
  assert.equal(resolvedKeep.resolution, 'keep-current');
  assert.equal(resolvedKeep.resolvedBy, 'user');
  assert.ok(resolvedKeep.resolvedAt);
  assert.throws(() => conflicts.resolve(keep.id, 'keep-current', 'user'), /already resolved/);

  const accept = mk('Đà Nẵng');
  const resolvedAccept = conflicts.resolve(accept.id, 'accept-new', 'user');
  assert.equal(resolvedAccept.resolution, 'accept-new');

  const merged = mk('Huế');
  assert.throws(() => conflicts.resolve(merged.id, 'merged', 'user'), /needs the merged text/);
  const resolvedMerged = conflicts.resolve(merged.id, 'merged', 'user', '- user: lives_in Huế (từ 2026)');
  assert.equal(resolvedMerged.resolution, 'merged');
  assert.equal(resolvedMerged.resolvedText, '- user: lives_in Huế (từ 2026)');

  assert.throws(() => conflicts.resolve('no-such-id', 'keep-current', 'user'), /not found/);
  assert.equal(conflicts.list({ status: 'pending' }).length, 0);
  assert.equal(conflicts.list().length, 3);
  assert.equal(conflicts.get(keep.id).status, 'resolved');
  assert.equal(conflicts.get('no-such-id'), null);
});
