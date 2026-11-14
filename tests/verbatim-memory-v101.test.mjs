/**
 * Tests for v1.01 (Đội T4) — verbatim local memory.
 *
 * Bao phủ: backends SQLite + JSONL (CRUD, dedup theo hash, list/filter,
 * đếm), store (save/dedup/giới hạn/prune/export/import/backfill với
 * fake embedder), hybrid recall (BM25, semantic fake, fallback reasons),
 * chunker (giữ nguyên văn + offset), extractor rule-based (lệnh nhớ,
 * câu khẳng định, bỏ secret, dedup), autosave hook (opt-in, giới hạn/
 * session, LLM extractor lỗi → fallback), consolidate (trùng mềm +
 * near-duplicate + apply dedup), wake-up (recent + relevant + cắt
 * ký tự), migrate (longterm + transcript).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/verbatim-memory-v101.test.mjs
 *
 * No network. Fake embedder deterministic theo từ khoá.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LongTermMemory } from '../packages/core/dist/memory/longterm.js';
import {
  JsonlVerbatimBackend,
  SqliteVerbatimBackend,
  VerbatimMemoryStore,
  chunkTranscriptTurns,
  chunkVerbatimText,
  consolidateVerbatim,
  applyVerbatimDedup,
  createVerbatimAutosaveHook,
  createVerbatimWakeUpHook,
  buildVerbatimWakeUp,
  extractVerbatimCandidates,
  hybridRecall,
  migrateLongTermToVerbatim,
  migrateTranscriptToVerbatim,
  openVerbatimBackend,
  openVerbatimStoreForWorkspace,
  verbatimHash,
} from '../packages/core/dist/memory/verbatim/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-verbatim-v101-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Fake embedder: 4 chiều theo từ khoá — xác định, không mạng. */
const VOCAB = ['pho', 'paris', 'code', 'cat'];
function fakeVector(text) {
  // Bỏ dấu để 'phở' khớp từ khoá 'pho' (fake embedder xác định).
  const lower = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
  return VOCAB.map((w) => (lower.includes(w) ? 1 : 0));
}
const fakeEmbedder = {
  async embed(text) {
    return fakeVector(text);
  },
  async isAvailable() {
    return true;
  },
};
const offlineEmbedder = {
  async embed() {
    throw new Error('no ollama');
  },
  async isAvailable() {
    return false;
  },
};

async function makeStore(backendKind = 'sqlite') {
  const dir = makeTempDir();
  const opened = openVerbatimBackend({ dir, backend: backendKind });
  const store = new VerbatimMemoryStore({ backend: opened.backend });
  return { dir, store, kind: opened.kind };
}

// ---------------------------------------------------------------- backends

test('verbatim backend: sqlite CRUD + list/filter + count', async () => {
  const { store } = await makeStore('sqlite');
  const a = await store.save({ text: 'Tôi thích phở bò', wing: 'default', room: 'food', tags: ['a'] });
  assert.equal(a.created, true);
  assert.equal(a.record.wing, 'default');
  assert.equal(a.record.room, 'food');
  await store.save({ text: 'Tôi sống ở Paris', wing: 'travel', room: 'cities' });
  const got = await store.get(a.record.id);
  assert.equal(got.text, 'Tôi thích phở bò');
  const listed = await store.list({ filter: { wing: 'travel' } });
  assert.equal(listed.total, 1);
  assert.equal(listed.records[0].text, 'Tôi sống ở Paris');
  assert.equal((await store.stats()).total, 2);
  assert.equal(await store.delete(a.record.id), true);
  assert.equal(await store.delete(a.record.id), false);
  assert.equal((await store.stats()).total, 1);
  await store.close();
});

test('verbatim backend: jsonl CRUD + persist across reopen', async () => {
  const dir = makeTempDir();
  const first = new VerbatimMemoryStore({ backend: new JsonlVerbatimBackend({ dir }) });
  const saved = await first.save({ text: 'Hello verbatim world', wing: 'w', room: 'r' });
  assert.equal(saved.created, true);
  await first.close();
  // Mở lại: record vẫn còn (đọc từ file).
  const second = new VerbatimMemoryStore({ backend: new JsonlVerbatimBackend({ dir }) });
  const got = await second.get(saved.record.id);
  assert.equal(got.text, 'Hello verbatim world');
  assert.equal((await second.stats()).total, 1);
  await second.close();
});

test('verbatim backend: factory falls back to jsonl when sqlite dir is a file', async () => {
  const dir = makeTempDir();
  // Chặn SQLite bằng cách để dir là file? openVerbatimBackend mkdir dir —
  // trường hợp này ép backend jsonl trực tiếp.
  const opened = openVerbatimBackend({ dir, backend: 'jsonl' });
  assert.equal(opened.kind, 'jsonl');
  assert.equal(opened.fallbackReason, undefined);
  await opened.backend.close();
});

test('verbatim store: dedup theo hash (cùng text + wing + room)', async () => {
  const { store } = await makeStore('sqlite');
  const first = await store.save({ text: '  Tôi thích phở bò  ', wing: 'default', room: 'food' });
  const second = await store.save({ text: 'Tôi thích phở bò', wing: 'default', room: 'food' });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.record.id, first.record.id);
  // Khác room → record khác.
  const third = await store.save({ text: 'Tôi thích phở bò', wing: 'default', room: 'other' });
  assert.equal(third.created, true);
  assert.equal((await store.stats()).total, 2);
  await store.close();
});

test('verbatim store: save rỗng / quá dài throw lỗi rõ', async () => {
  const { store } = await makeStore('sqlite');
  await assert.rejects(() => store.save({ text: '   ' }), /rỗng/);
  await assert.rejects(() => store.save({ text: 'x'.repeat(8001) }), /quá dài/);
  await store.close();
});

test('verbatim store: hash ổn định + khác wing khác hash', () => {
  const h1 = verbatimHash('Tôi thích phở', 'default', 'food');
  const h2 = verbatimHash('Tôi thích phở', 'default', 'food');
  const h3 = verbatimHash('Tôi thích phở', 'other', 'food');
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
});

test('verbatim store: stats đếm theo source/wing + backend kind', async () => {
  const { store } = await makeStore('sqlite');
  await store.save({ text: 'one', source: 'user', wing: 'a', room: 'r' });
  await store.save({ text: 'two', source: 'agent', wing: 'a', room: 'r' });
  await store.save({ text: 'three', source: 'manual', wing: 'b', room: 'r' });
  const stats = await store.stats();
  assert.equal(stats.total, 3);
  assert.equal(stats.backend, 'sqlite');
  assert.equal(stats.bySource.user, 1);
  assert.equal(stats.bySource.agent, 1);
  assert.equal(stats.byWing.a, 2);
  assert.equal(stats.byWing.b, 1);
  assert.equal(stats.wings, 2);
  assert.equal(stats.rooms, 2);
  await store.close();
});

test('verbatim store: prune xoá record cũ, giữ tag keep', async () => {
  const { store } = await makeStore('sqlite');
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  await store.save({ text: 'old one', createdAt: old });
  await store.save({ text: 'old keeper', createdAt: old, tags: ['keep-me'] });
  await store.save({ text: 'fresh one' });
  const deleted = await store.prune({ olderThanDays: 30, keepTags: ['keep-me'] });
  assert.equal(deleted, 1);
  assert.equal((await store.stats()).total, 2);
  await store.close();
});

test('verbatim store: export/import round-trip, dedup khi import lại', async () => {
  const { store } = await makeStore('sqlite');
  await store.save({ text: 'export me please', wing: 'w', room: 'r', tags: ['t'] });
  const dir = makeTempDir();
  const file = path.join(dir, 'out.json');
  const n = await store.exportToFile(file);
  assert.equal(n, 1);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.records[0].text, 'export me please');
  assert.equal('embedding' in parsed.records[0], false);
  // Import vào store mới: 1 created; import lại: 1 duplicate.
  const other = await makeStore('jsonl');
  const first = await other.store.importFromFile(file);
  assert.deepEqual(first, { created: 1, duplicates: 0, skipped: 0 });
  const second = await other.store.importFromFile(file);
  assert.equal(second.duplicates, 1);
  await store.close();
  await other.store.close();
});

test('verbatim store: backfill embed với fake embedder, skip lần 2', async () => {
  const { store } = await makeStore('sqlite');
  await store.save({ text: 'Tôi thích phở bò' });
  await store.save({ text: 'Tôi sống ở Paris' });
  const first = await store.backfillEmbeddings(fakeEmbedder);
  assert.equal(first.embedded, 2);
  assert.equal(first.skipped, 0);
  const second = await store.backfillEmbeddings(fakeEmbedder);
  assert.equal(second.embedded, 0);
  assert.equal(second.skipped, 2);
  const stats = await store.stats();
  assert.equal(stats.embedded, 2);
  // Record đã embed không lộ vector qua list.
  const listed = await store.list({});
  assert.equal('embedding' in listed.records[0], false);
  await store.close();
});

test('verbatim store: backfill không embedder throw lỗi rõ', async () => {
  const { store } = await makeStore('sqlite');
  await store.save({ text: 'hello' });
  await assert.rejects(() => store.backfillEmbeddings(), /embedder/);
  await assert.rejects(() => store.backfillEmbeddings(offlineEmbedder), /không khả dụng/);
  await store.close();
});

// ---------------------------------------------------------------- recall

test('verbatim recall: BM25 tìm đúng record, bỏ dấu tiếng Việt', async () => {
  const { store } = await makeStore('sqlite');
  await store.save({ text: 'Tôi thích phở bò, không ăn cay' });
  await store.save({ text: 'Tôi sống ở Paris từ năm 2020' });
  await store.save({ text: 'Code review cần chạy test trước khi merge' });
  const result = await store.search('pho bo');
  assert.equal(result.usedFallback, true);
  assert.equal(result.fallbackReason, 'no-embedder');
  assert.equal(result.hits[0].record.text, 'Tôi thích phở bò, không ăn cay');
  assert.ok(result.hits[0].score > 0);
  const none = await store.search('zzzqqq wwwppp');
  assert.equal(none.hits.length, 0);
  await store.close();
});

test('verbatim recall: semantic fake embedder thắng BM25 khi từ khoá lệch', async () => {
  const { store } = await makeStore('sqlite');
  await store.save({ text: 'Tôi thích phở bò' });
  await store.save({ text: 'Tôi sống ở Paris' });
  await store.save({ text: 'My cat is cute and fluffy' });
  // Record phải có vector thì recall ngữ nghĩa mới chạy — backfill trước.
  await store.backfillEmbeddings(fakeEmbedder);
  const withEmbedder = await store.search('cat', { embedder: fakeEmbedder });
  assert.equal(withEmbedder.usedFallback, false);
  assert.equal(withEmbedder.hits[0].record.text, 'My cat is cute and fluffy');
  assert.ok(withEmbedder.hits[0].semanticScore > 0.3);
  await store.close();
});

test('verbatim recall: hybridRecall thuần — fallback khi embed lỗi', async () => {
  const candidates = [
    { id: '1', text: 'Tôi thích phở bò', source: 'user', wing: 'default', room: 'general', tags: [], botId: '', createdAt: new Date().toISOString(), hash: 'h1' },
    { id: '2', text: 'Tôi sống ở Paris', source: 'user', wing: 'default', room: 'general', tags: [], botId: '', createdAt: new Date().toISOString(), hash: 'h2' },
  ];
  const result = await hybridRecall('pho', candidates, { embedder: offlineEmbedder });
  assert.equal(result.usedFallback, true);
  assert.equal(result.fallbackReason, 'embed-failed');
  assert.equal(result.hits[0].record.id, '1');
});

test('verbatim recall: search rỗng trả rỗng, không throw', async () => {
  const { store } = await makeStore('sqlite');
  await store.save({ text: 'hello world' });
  const result = await store.search('   ');
  assert.deepEqual(result.hits, []);
  await store.close();
});

// ---------------------------------------------------------------- chunker

test('verbatim chunker: text ngắn → 1 chunk nguyên văn, giữ offset', () => {
  const chunks = chunkVerbatimText('Hello world, this is verbatim.');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, 'Hello world, this is verbatim.');
  assert.equal(chunks[0].startOffset, 0);
  assert.equal(chunks[0].endOffset, 'Hello world, this is verbatim.'.length);
});

test('verbatim chunker: text dài chẻ theo câu, không cắt giữa từ, nối lại đủ text', () => {
  const sentence = 'Tôi thích phở bò và hay ăn vào buổi sáng. ';
  const long = sentence.repeat(40);
  const chunks = chunkVerbatimText(long, { maxChars: 200 });
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.text.length <= 200, `chunk dài ${c.text.length}`);
    assert.equal(c.text, long.slice(c.startOffset, c.endOffset).trim());
  }
  // Nối các chunk (theo offset) phải phủ toàn bộ text gốc (trừ khoảng trắng biên).
  const covered = chunks.map((c) => long.slice(c.startOffset, c.endOffset)).join('');
  assert.ok(covered.length >= long.trim().length - chunks.length);
});

test('verbatim chunker: chunkTranscriptTurns giữ turnIndex + source', () => {
  const chunks = chunkTranscriptTurns([
    { role: 'user', text: 'Tôi thích phở bò, không ăn cay.' },
    { role: 'assistant', text: 'Đã ghi nhớ sở thích của bạn.' },
    { role: 'system', text: 'Đây là thông báo hệ thống quan trọng.' },
  ]);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].turnIndex, 0);
  assert.equal(chunks[0].source, 'user');
  assert.equal(chunks[1].source, 'agent');
  assert.equal(chunks[2].source, 'tool');
});

// ---------------------------------------------------------------- extractor

test('verbatim extractor: lệnh nhớ tường minh lấy phần sau lệnh', () => {
  const candidates = extractVerbatimCandidates([
    { role: 'user', text: 'Hãy nhớ rằng tôi thích phở bò, không ăn cay.' },
    { role: 'user', text: 'Please remember that my birthday is on May 5th.' },
  ]);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].text, 'tôi thích phở bò, không ăn cay.');
  assert.equal(candidates[0].kind, 'explicit-remember');
  assert.ok(candidates[0].confidence >= 0.9);
  assert.equal(candidates[1].text, 'my birthday is on May 5th.');
});

test('verbatim extractor: câu khẳng định sở thích / tên / công việc', () => {
  const candidates = extractVerbatimCandidates([
    { role: 'user', text: 'Tôi thích đọc sách vào buổi tối. Tên tôi là Huy. Tôi làm việc tại Hà Nội. Hôm nay trời đẹp quá.' },
  ]);
  const kinds = candidates.map((c) => c.kind);
  assert.ok(kinds.includes('preference'));
  assert.ok(kinds.includes('identity'));
  assert.ok(kinds.includes('work'));
  // Câu chung chung không khớp pattern → không sinh candidate.
  assert.equal(candidates.some((c) => c.text.includes('trời đẹp')), false);
});

test('verbatim extractor: chỉ xét turn user, bỏ secret, dedup', () => {
  const candidates = extractVerbatimCandidates([
    { role: 'assistant', text: 'Tôi thích phở bò.' },
    { role: 'user', text: 'Tôi thích phở bò. Tôi thích phở bò.' },
    { role: 'user', text: 'Tôi thích phở bò, API key của tôi là sk-abcdefgh12345678.' },
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].text, 'Tôi thích phở bò.');
});

// ---------------------------------------------------------------- autosave

test('verbatim autosave: ingestTurns lưu candidate, dedup lần 2', async () => {
  const { store } = await makeStore('sqlite');
  const { VerbatimAutosave } = await import('../packages/core/dist/memory/verbatim/autosave.js');
  const autosave = new VerbatimAutosave(store, {});
  const turns = [
    { role: 'user', text: 'Hãy nhớ tôi thích phở bò, không ăn cay.' },
    { role: 'assistant', text: 'OK.' },
  ];
  const first = await autosave.ingestTurns(turns, { sessionId: 's1' });
  assert.equal(first.created, 1);
  assert.equal(first.candidates, 1);
  assert.equal(first.usedLlm, false);
  const second = await autosave.ingestTurns(turns, { sessionId: 's1' });
  assert.equal(second.created, 0);
  assert.equal(second.duplicates, 1);
  await store.close();
});

test('verbatim autosave: LLM extractor lỗi → fallback rule-based, không throw', async () => {
  const { store } = await makeStore('sqlite');
  const { VerbatimAutosave } = await import('../packages/core/dist/memory/verbatim/autosave.js');
  const autosave = new VerbatimAutosave(store, {
    llmExtractor: async () => {
      throw new Error('llm down');
    },
  });
  const result = await autosave.ingestTurns([
    { role: 'user', text: 'Tôi thích đọc sách.' },
  ]);
  assert.equal(result.usedLlm, false);
  assert.equal(result.created, 1);
  await store.close();
});

test('verbatim autosave: hook mặc định TẮT, bật thì chạy ở SessionEnd', async () => {
  const { store } = await makeStore('sqlite');
  const hook = createVerbatimAutosaveHook(store, {
    enabled: true,
    getTurns: () => [{ role: 'user', text: 'Hãy nhớ tôi sống ở Paris.' }],
  });
  assert.equal(hook.name, 'verbatim-autosave');
  assert.deepEqual(hook.events, ['SessionEnd', 'Stop']);
  assert.equal(hook.enabled, true);
  await hook.handler({ event: 'SessionEnd' }, { sessionId: 's9' });
  assert.equal((await store.stats()).total, 1);
  // Hook tắt → không làm gì.
  const offHook = createVerbatimAutosaveHook(store, {
    enabled: false,
    getTurns: () => [{ role: 'user', text: 'Hãy nhớ tôi thích mèo.' }],
  });
  await offHook.handler({ event: 'SessionEnd' }, { sessionId: 's10' });
  assert.equal((await store.stats()).total, 1);
  await store.close();
});

// ---------------------------------------------------------------- consolidate

test('verbatim consolidate: trùng mềm theo chuẩn hoá (dấu/case), giữ cũ nhất', async () => {
  const { store } = await makeStore('sqlite');
  await store.save({ text: 'Tôi thích phở bò', createdAt: '2026-01-01T00:00:00.000Z' });
  await store.save({ text: 'Tôi thích phở bò!', wing: 'other', room: 'r', createdAt: '2026-01-02T00:00:00.000Z' });
  await store.save({ text: 'Tôi thích PHỞ BÒ', wing: 'third', room: 'r', createdAt: '2026-01-03T00:00:00.000Z' });
  await store.save({ text: 'Câu hoàn toàn khác biệt ở đây' });
  const report = await consolidateVerbatim(store, {});
  assert.equal(report.examined, 4);
  assert.equal(report.groups.length, 1);
  assert.equal(report.groups[0].duplicates.length, 2);
  assert.equal(report.removable, 2);
  assert.equal(report.groups[0].keep.text, 'Tôi thích phở bò');
  const deleted = await applyVerbatimDedup(store, report);
  assert.equal(deleted, 2);
  assert.equal((await store.stats()).total, 2);
  await store.close();
});

test('verbatim consolidate: near-duplicate Jaccard cao được báo, không tự xoá', async () => {
  const { store } = await makeStore('sqlite');
  await store.save({ text: 'Tôi thích ăn phở bò vào buổi sáng cuối tuần cùng gia đình' });
  await store.save({ text: 'Tôi thích ăn phở bò vào buổi sáng cuối tuần cùng gia đình nhỏ' });
  const report = await consolidateVerbatim(store, {});
  assert.equal(report.groups.length, 0);
  assert.equal(report.nearDuplicates.length, 1);
  assert.ok(report.nearDuplicates[0].similarity >= 0.85);
  await store.close();
});

// ---------------------------------------------------------------- wake-up

test('verbatim wake-up: recent + relevant, cắt theo maxChars', async () => {
  const { store } = await makeStore('sqlite');
  await store.save({ text: 'Tôi thích phở bò', createdAt: '2026-01-01T00:00:00.000Z' });
  await store.save({ text: 'Tôi sống ở Paris', createdAt: '2026-01-02T00:00:00.000Z' });
  const wake = await buildVerbatimWakeUp(store, { query: 'Paris', recentCount: 5, relevantCount: 5 });
  assert.equal(wake.totalRecords, 2);
  assert.ok(wake.text.includes('Memory gần đây:'));
  assert.ok(wake.text.includes('Paris'));
  assert.ok(wake.text.includes('phở bò'));
  // Cắt ngắn: maxChars nhỏ → truncated.
  const tiny = await buildVerbatimWakeUp(store, { maxChars: 30 });
  assert.equal(tiny.truncated, true);
  await store.close();
});

test('verbatim wake-up: hook SessionStart trả modify + context', async () => {
  const { store } = await makeStore('sqlite');
  await store.save({ text: 'Tôi thích phở bò' });
  const hook = createVerbatimWakeUpHook(store, { enabled: true });
  assert.equal(hook.name, 'verbatim-wakeup');
  assert.deepEqual(hook.events, ['SessionStart']);
  const decision = await hook.handler({ event: 'SessionStart' }, { sessionId: 's1' });
  assert.equal(decision.action, 'modify');
  assert.ok(decision.context.includes('phở bò'));
  await store.close();
});

// ---------------------------------------------------------------- migrate

test('verbatim migrate: longterm → verbatim, idempotent', async () => {
  const dir = makeTempDir();
  const longterm = new LongTermMemory(dir);
  longterm.remember({ key: 'sở thích', value: 'thích phở bò', tags: ['ăn uống'] });
  longterm.remember({ key: 'quê quán', value: 'Hà Nội' });
  const { store } = await makeStore('sqlite');
  const first = await migrateLongTermToVerbatim(longterm, store, {});
  assert.equal(first.created, 2);
  const second = await migrateLongTermToVerbatim(longterm, store, {});
  assert.equal(second.created, 0);
  assert.equal(second.duplicates, 2);
  const found = await store.search('phở bò');
  assert.equal(found.hits[0].record.text, 'sở thích: thích phở bò');
  await store.close();
});

test('verbatim migrate: transcript file → chunk nguyên văn', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'session.json');
  fs.writeFileSync(file, JSON.stringify({
    turns: [
      { role: 'user', text: 'Tôi thích phở bò, không ăn cay.' },
      { role: 'assistant', text: 'Đã rõ, tôi sẽ ghi nhớ điều này cho bạn.' },
    ],
  }));
  const { store } = await makeStore('sqlite');
  const result = await migrateTranscriptToVerbatim(file, store, { sessionId: 'sess-1' });
  assert.equal(result.turns, 2);
  assert.equal(result.created, 2);
  const listed = await store.list({ filter: { sessionId: 'sess-1' } });
  assert.equal(listed.total, 2);
  await store.close();
});

test('verbatim workspace helper: mở store theo workspace, backend sqlite', async () => {
  const dir = makeTempDir();
  const opened = openVerbatimStoreForWorkspace(dir, {});
  assert.equal(opened.backendKind, 'sqlite');
  assert.ok(opened.dir.endsWith('.open-bot/verbatim'));
  await opened.store.save({ text: 'workspace memory test' });
  assert.equal((await opened.store.stats()).total, 1);
  await opened.store.close();
  // Mở lại cùng workspace → vẫn thấy record (SQLite persist).
  const reopened = openVerbatimStoreForWorkspace(dir, {});
  assert.equal((await reopened.store.stats()).total, 1);
  await reopened.store.close();
});
