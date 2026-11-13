/**
 * Tests for v0.98 (Đội T1) — temporal knowledge graph store:
 * packages/core/src/memory/graph/{types,store}.ts.
 *
 * Bao phủ: entity ensure/dedupe theo tên chuẩn hoá (+ alias), ingest
 * episode (chống trùng turnId, cắt text dài), addFact (validate,
 * scope), supersession bi-temporal (đóng validUntil, nối supersededBy
 * / supersedes, lịch sử truy vấn được), soft-delete, factHistory,
 * neighbours, quarantine add/review (approve thành fact / reject giữ
 * audit), share/unshare + read-only guard, scope filter (fact bot
 * khác không lọt ra), stats, backend in-memory.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-graph-v098.test.mjs
 *
 * No network. No model.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  TemporalGraphStore,
  InMemoryGraphBackend,
  GraphStoreError,
  isFactValidAt,
  normalizeGraphText,
  factDisplayText,
} from '../packages/core/dist/memory/graph/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memgraph-v098-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SCOPE_A = { userId: 'user-1', botId: 'bot-a', runId: 'run-1' };
const SCOPE_B = { userId: 'user-1', botId: 'bot-b', runId: 'run-2' };

function provenance(episodeId = 'ep-1', turnId = 'turn-1') {
  return { episodeId, turnId, runId: 'run-1', botId: 'bot-a', userId: 'user-1', at: '2026-11-13T10:00:00.000Z', sourceText: 'Tôi thích phở bò.' };
}

function makeStore() {
  return TemporalGraphStore.fromWorkspace(makeTempDir());
}

test('normalizeGraphText bỏ dấu tiếng Việt + chuẩn hoá khoảng trắng', () => {
  assert.equal(normalizeGraphText('  Phở   Bò! '), 'pho bo');
  assert.equal(normalizeGraphText('Đà Nẵng'), 'da nang');
  assert.equal(normalizeGraphText(''), '');
});

test('ensureEntity dedupe theo tên chuẩn hoá, alias khớp tên', () => {
  const store = makeStore();
  const e1 = store.ensureEntity('Hà Nội', 'place');
  const e2 = store.ensureEntity('ha noi', 'place');
  assert.equal(e1.id, e2.id);
  assert.equal(store.listEntities().length, 1);
  store.addAlias(e1.id, 'HCM');
  assert.equal(store.findEntityByName('hcm')?.id, e1.id);
  assert.equal(store.findEntityByName('không có'), undefined);
});

test('ensureEntity tên rỗng throw', () => {
  const store = makeStore();
  assert.throws(() => store.ensureEntity('   '), GraphStoreError);
});

test('ingestEpisode: ghi mới, chống trùng turnId, cắt text dài', () => {
  const store = makeStore();
  const first = store.ingestEpisode({ turnId: 't-1', runId: 'r-1', botId: 'bot-a', userId: 'user-1', role: 'user', text: 'Tôi thích phở bò.' });
  assert.equal(first.duplicate, false);
  const dup = store.ingestEpisode({ turnId: 't-1', runId: 'r-1', botId: 'bot-a', userId: 'user-1', role: 'user', text: 'Tôi thích phở bò.' });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.id, first.id);
  const otherBot = store.ingestEpisode({ turnId: 't-1', runId: 'r-1', botId: 'bot-b', userId: 'user-1', role: 'user', text: 'x' });
  assert.equal(otherBot.duplicate, false);
  const long = store.ingestEpisode({ turnId: 't-2', runId: 'r-1', botId: 'bot-a', userId: 'user-1', role: 'user', text: 'x'.repeat(9000) });
  assert.equal(store.getEpisode(long.id)?.text.length, 8000);
  assert.throws(
    () => store.ingestEpisode({ turnId: 't-3', runId: 'r-1', botId: 'bot-a', userId: 'user-1', role: 'user', text: '   ' }),
    GraphStoreError,
  );
});

test('addFact: tạo fact active, entity tân ngữ được nối objectId', () => {
  const store = makeStore();
  const fact = store.addFact({
    subjectName: 'user', predicate: 'lives_in', objectText: 'Hà Nội',
    objectIsEntity: true, confidence: 0.92, scope: SCOPE_A, provenance: provenance(),
  });
  assert.equal(fact.status, 'active');
  assert.equal(fact.validUntil, null);
  assert.equal(fact.predicate, 'lives_in');
  assert.ok(fact.objectId);
  assert.equal(store.getEntity(fact.objectId)?.name, 'Hà Nội');
  assert.equal(isFactValidAt(fact), true);
  assert.equal(factDisplayText(fact, 'user'), 'user —lives_in→ Hà Nội');
  const stats = store.stats(SCOPE_A);
  assert.equal(stats.activeFacts, 1);
  assert.equal(stats.entities, 2); // user + Hà Nội
});

test('addFact validate: predicate/object rỗng throw', () => {
  const store = makeStore();
  assert.throws(
    () => store.addFact({ subjectName: 'user', predicate: '  ', objectText: 'x', scope: SCOPE_A, provenance: provenance() }),
    GraphStoreError,
  );
  assert.throws(
    () => store.addFact({ subjectName: 'user', predicate: 'likes', objectText: '  ', scope: SCOPE_A, provenance: provenance() }),
    GraphStoreError,
  );
});

test('supersedeFact: đóng cửa sổ fact cũ, nối 2 chiều, lịch sử đầy đủ', () => {
  const store = makeStore();
  const oldFact = store.addFact({
    subjectName: 'user', predicate: 'lives_in', objectText: 'Hà Nội',
    confidence: 0.9, scope: SCOPE_A, provenance: provenance(),
  });
  const created = store.supersedeFact(oldFact.id, {
    subjectName: 'user', predicate: 'lives_in', objectText: 'TP. Hồ Chí Minh',
    confidence: 0.95, scope: SCOPE_A, provenance: provenance('ep-2', 'turn-2'),
  });
  const oldAfter = store.getFact(oldFact.id);
  assert.equal(oldAfter?.status, 'superseded');
  assert.ok(oldAfter?.validUntil !== null);
  assert.equal(oldAfter?.supersededBy, created.id);
  assert.equal(created.supersedes, oldFact.id);
  assert.equal(created.status, 'active');
  assert.equal(isFactValidAt(oldAfter), false);
  assert.equal(isFactValidAt(created), true);
  const history = store.factHistory(created.id);
  assert.deepEqual(history.map((f) => f.objectText), ['Hà Nội', 'TP. Hồ Chí Minh']);
  // Fact cũ không còn trong list active.
  assert.equal(store.listFacts({ ...SCOPE_A, status: 'active' }).length, 1);
  assert.equal(store.listFacts({ ...SCOPE_A, status: 'superseded' }).length, 1);
});

test('supersedeFact chỉ thay thế fact active', () => {
  const store = makeStore();
  const fact = store.addFact({ subjectName: 'user', predicate: 'likes', objectText: 'phở', scope: SCOPE_A, provenance: provenance() });
  store.deleteFact(fact.id, 'test');
  assert.throws(
    () => store.supersedeFact(fact.id, { subjectName: 'user', predicate: 'likes', objectText: 'bún', scope: SCOPE_A, provenance: provenance() }),
    GraphStoreError,
  );
});

test('deleteFact: xoá mềm, validUntil đóng, vẫn xem lại được', () => {
  const store = makeStore();
  const fact = store.addFact({ subjectName: 'user', predicate: 'likes', objectText: 'phở', scope: SCOPE_A, provenance: provenance() });
  const deleted = store.deleteFact(fact.id, 'user');
  assert.equal(deleted.status, 'deleted');
  assert.ok(deleted.validUntil !== null);
  assert.equal(isFactValidAt(deleted), false);
  assert.equal(store.listFacts({ ...SCOPE_A, status: 'deleted' }).length, 1);
  assert.equal(store.listFacts({ ...SCOPE_A, status: 'active' }).length, 0);
});

test('findActiveFacts + neighbours theo scope', () => {
  const store = makeStore();
  store.addFact({ subjectName: 'user', predicate: 'likes', objectText: 'phở', scope: SCOPE_A, provenance: provenance() });
  store.addFact({ subjectName: 'user', predicate: 'likes', objectText: 'bún chả', scope: SCOPE_B, provenance: { ...provenance(), botId: 'bot-b', runId: 'run-2' } });
  assert.equal(store.findActiveFacts('user', 'likes', SCOPE_A).length, 1);
  assert.equal(store.findActiveFacts('user', 'likes', SCOPE_B).length, 1);
  // Không lọc scope: thấy cả 2.
  assert.equal(store.findActiveFacts('user', 'likes', { includeOtherScopes: true }).length, 2);
  const user = store.findEntityByName('user');
  assert.ok(user);
  assert.equal(store.neighbours(user.id, SCOPE_A).length, 1);
});

test('markEpisodeProcessed + listUnprocessedEpisodes', () => {
  const store = makeStore();
  const { id } = store.ingestEpisode({ turnId: 't-1', runId: 'r-1', botId: 'bot-a', userId: 'user-1', role: 'user', text: 'Tôi thích phở.' });
  const scopeNoRun = { userId: 'user-1', botId: 'bot-a' };
  assert.equal(store.listUnprocessedEpisodes(scopeNoRun).length, 1);
  assert.equal(store.stats(scopeNoRun).unprocessedEpisodes, 1);
  store.markEpisodeProcessed(id, ['fact-1']);
  assert.equal(store.listUnprocessedEpisodes(scopeNoRun).length, 0);
  assert.deepEqual(store.getEpisode(id)?.factIds, ['fact-1']);
  assert.throws(() => store.markEpisodeProcessed('nope', []), GraphStoreError);
});

test('quarantine: add + approve thành fact, reject giữ audit', () => {
  const store = makeStore();
  const oldFact = store.addFact({ subjectName: 'user', predicate: 'lives_in', objectText: 'Hà Nội', confidence: 0.9, scope: SCOPE_A, provenance: provenance() });
  const item = store.addToQuarantine({
    candidate: { subjectName: 'user', predicate: 'lives_in', objectText: 'Đà Nẵng', confidence: 0.6 },
    reason: 'conflict',
    detail: 'Mâu thuẫn với Hà Nội.',
    conflictingFactId: oldFact.id,
    scope: SCOPE_A,
    provenance: provenance('ep-2', 'turn-2'),
  });
  assert.equal(item.status, 'pending');
  assert.equal(store.listQuarantine({ ...SCOPE_A, status: 'pending' }).length, 1);
  const approved = store.reviewQuarantine(item.id, 'approved', 'user');
  assert.equal(approved.item.status, 'approved');
  assert.ok(approved.fact);
  assert.equal(approved.fact?.objectText, 'Đà Nẵng');
  assert.equal(store.getFact(oldFact.id)?.status, 'superseded');
  // Duyệt lần 2 throw.
  assert.throws(() => store.reviewQuarantine(item.id, 'approved', 'user'), GraphStoreError);
  // Reject: không tạo fact.
  const item2 = store.addToQuarantine({
    candidate: { subjectName: 'user', predicate: 'likes', objectText: 'rắn độc', confidence: 0.4 },
    reason: 'suspicious-pattern',
    detail: 'Nghi ngờ.',
    scope: SCOPE_A,
    provenance: provenance('ep-3', 'turn-3'),
  });
  const rejected = store.reviewQuarantine(item2.id, 'rejected', 'user');
  assert.equal(rejected.item.status, 'rejected');
  assert.equal(rejected.fact, undefined);
  assert.equal(store.listFacts({ ...SCOPE_A, status: 'active' }).length, 1); // chỉ Đà Nẵng
});

test('share/unshare + read-only guard', () => {
  const store = makeStore();
  assert.equal(store.listShares().length, 0);
  const share = store.share('bot-b', true, 'user');
  assert.equal(share.readOnly, true);
  assert.equal(store.getShare('bot-b')?.targetBotId, 'bot-b');
  assert.equal(store.unshare('bot-b'), true);
  assert.equal(store.unshare('bot-b'), false);
});

test('store read-only: mọi ghi đều throw', () => {
  const dir = makeTempDir();
  const writer = TemporalGraphStore.fromWorkspace(dir);
  writer.share('bot-b', true, 'user');
  const reader = TemporalGraphStore.fromWorkspace(dir, { readOnly: true });
  assert.equal(reader.listFacts().length, 0);
  assert.throws(
    () => reader.ingestEpisode({ turnId: 't-1', runId: 'r-1', botId: 'bot-b', userId: 'u', role: 'user', text: 'x' }),
    GraphStoreError,
  );
  assert.throws(
    () => reader.addFact({ subjectName: 'user', predicate: 'likes', objectText: 'x', scope: SCOPE_B, provenance: provenance() }),
    GraphStoreError,
  );
});

test('file backend: reload từ đĩa giữ nguyên dữ liệu, mode 0600', () => {
  const dir = makeTempDir();
  const a = TemporalGraphStore.fromWorkspace(dir);
  a.addFact({ subjectName: 'user', predicate: 'likes', objectText: 'phở', scope: SCOPE_A, provenance: provenance() });
  const b = TemporalGraphStore.fromWorkspace(dir);
  assert.equal(b.listFacts({ ...SCOPE_A, status: 'active' }).length, 1);
  const stat = fs.statSync(path.join(dir, '.open-bot', 'memory-graph.json'));
  assert.equal(stat.mode & 0o777, 0o600);
});

test('in-memory backend: tách lớp cho memory2 (không chạm đĩa)', () => {
  const backend = new InMemoryGraphBackend();
  const store = new TemporalGraphStore(backend);
  store.addFact({ subjectName: 'user', predicate: 'likes', objectText: 'phở', scope: SCOPE_A, provenance: provenance() });
  assert.equal(store.listFacts({ ...SCOPE_A, status: 'active' }).length, 1);
  const store2 = new TemporalGraphStore(backend);
  assert.equal(store2.listFacts({ ...SCOPE_A, status: 'active' }).length, 1);
});

test('setFactEmbedding lưu vector xuống store', () => {
  const store = makeStore();
  const fact = store.addFact({ subjectName: 'user', predicate: 'likes', objectText: 'phở', scope: SCOPE_A, provenance: provenance() });
  store.setFactEmbedding(fact.id, [0.6, 0.8]);
  assert.deepEqual(store.getFact(fact.id)?.embedding, [0.6, 0.8]);
  assert.throws(() => store.setFactEmbedding('nope', [1]), GraphStoreError);
});
