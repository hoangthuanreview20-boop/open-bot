/**
 * Tests for v0.95d4 — user profile store + long-term memory user/bot scope.
 *
 * Profile: CRUD qua identity.ts (profile.json), old-file compat,
 * context builder (memory/profile.ts). Memory: remember/recall theo
 * scope user/bot (includeShared), updateEntry/forgetById/export
 * (không kèm vector).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/profile-memory-v095d4.test.mjs
 *
 * No network, no real tokens. All state in temp dirs.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  getOrCreateLocalProfile,
  loadLocalProfile,
  updateLocalProfile,
  validateLocalProfile,
} from '../packages/core/dist/auth/identity.js';
import {
  buildProfileContext,
  hasProfileContext,
} from '../packages/core/dist/memory/profile.js';
import { LongTermMemory } from '../packages/core/dist/memory/longterm.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-profile-v095d4-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Fake embedder: vector 3 chiều theo từ khoá (deterministic). */
const keywordEmbedder = {
  model: 'fake-keyword',
  async isAvailable() {
    return true;
  },
  async embed(text) {
    const t = text.toLowerCase();
    const v = [0, 0, 0];
    if (t.includes('phở')) v[0] = 1;
    else if (t.includes('biển')) v[1] = 1;
    else v[2] = 1;
    return v;
  },
};

test('profile: tạo mới + cập nhật field cá nhân hoá, userId không đổi', () => {
  const dir = makeTempDir();
  const created = getOrCreateLocalProfile(dir);
  assert.equal(typeof created.userId, 'string');
  assert.ok(created.userId.length > 0);
  const updated = updateLocalProfile(dir, {
    displayName: 'Huy',
    addressForm: 'bạn',
    interests: ['phở bò', 'đọc sách', 'phở bò'],
    habits: ['chạy bộ sáng'],
    facts: ['làm việc khuya'],
  });
  assert.equal(updated.userId, created.userId);
  assert.equal(updated.displayName, 'Huy');
  assert.equal(updated.addressForm, 'bạn');
  assert.deepEqual(updated.interests, ['phở bò', 'đọc sách']);
  assert.deepEqual(updated.habits, ['chạy bộ sáng']);
  assert.deepEqual(updated.facts, ['làm việc khuya']);
  assert.equal(typeof updated.updatedAt, 'number');
  // Đọc lại từ disk: giữ nguyên.
  const reloaded = loadLocalProfile(dir);
  assert.deepEqual(reloaded, updated);
});

test('profile: validate strict — patch sai thì throw, không ghi gì', () => {
  const dir = makeTempDir();
  const before = getOrCreateLocalProfile(dir);
  assert.throws(() => updateLocalProfile(dir, { displayName: 'x'.repeat(201) }), /at most 200/);
  assert.throws(() => updateLocalProfile(dir, { interests: 'không phải mảng' }), /array of strings/);
  assert.throws(() => updateLocalProfile(dir, { addressForm: 'x'.repeat(201) }), /at most 200/);
  assert.deepEqual(loadLocalProfile(dir), before);
});

test('profile: file cũ (chỉ userId/displayName/createdAt) vẫn đọc được', () => {
  const dir = makeTempDir();
  fs.writeFileSync(
    path.join(dir, 'profile.json'),
    JSON.stringify({ userId: 'u-old', displayName: 'Huy cũ', createdAt: 1000 }),
  );
  const loaded = loadLocalProfile(dir);
  assert.equal(loaded.userId, 'u-old');
  assert.equal(loaded.displayName, 'Huy cũ');
  assert.equal(loaded.addressForm, undefined);
  assert.equal(loaded.interests, undefined);
  assert.equal(buildProfileContext(loaded).includes('Huy cũ'), true);
  // validateLocalProfile bỏ field lạ, không crash.
  const validated = validateLocalProfile({ userId: 'u', displayName: 'x', createdAt: 1, interests: [123, '  ', 'ok'] });
  assert.deepEqual(validated.interests, ['ok']);
});

test('profile context: trống thì rỗng; có nội dung thì đủ field + cắt ngân sách', () => {
  assert.equal(buildProfileContext(null), '');
  assert.equal(buildProfileContext({ userId: 'u', displayName: '', createdAt: 1 }), '');
  assert.equal(hasProfileContext({ userId: 'u', displayName: '', createdAt: 1 }), false);
  const ctx = buildProfileContext({
    userId: 'u',
    displayName: 'Huy',
    addressForm: 'bạn',
    interests: ['phở bò'],
    habits: ['chạy bộ sáng'],
    facts: ['thích làm việc khuya'],
    createdAt: 1,
  });
  assert.ok(ctx.includes('Huy'));
  assert.ok(ctx.includes('"bạn"'));
  assert.ok(ctx.includes('phở bò'));
  assert.ok(ctx.includes('chạy bộ sáng'));
  assert.ok(ctx.includes('thích làm việc khuya'));
  assert.equal(hasProfileContext({ userId: 'u', displayName: 'Huy', createdAt: 1 }), true);
  const long = buildProfileContext(
    { userId: 'u', displayName: 'x'.repeat(100), interests: ['y'.repeat(100)], createdAt: 1 },
    { maxChars: 50 },
  );
  assert.ok(long.length <= 50 + 1 + '…(đã rút gọn)'.length);
  assert.ok(long.includes('đã rút gọn'));
});

test('memory scope user: recall của user A thấy memory của A + legacy, không thấy của B', () => {
  const dir = makeTempDir();
  const store = new LongTermMemory(dir);
  store.remember({ key: 'a-only', value: 'của A', userId: 'user-a' });
  store.remember({ key: 'b-only', value: 'của B', userId: 'user-b' });
  store.remember({ key: 'legacy', value: 'chưa gắn user' });
  const forA = store.recall({ userId: 'user-a', limit: 100 }).map((e) => e.key);
  assert.ok(forA.includes('a-only'));
  assert.ok(forA.includes('legacy'));
  assert.ok(!forA.includes('b-only'));
  const forB = store.recall({ userId: 'user-b', limit: 100 }).map((e) => e.key);
  assert.ok(forB.includes('b-only'));
  assert.ok(forB.includes('legacy'));
  assert.ok(!forB.includes('a-only'));
  // Không lọc user = thấy tất cả.
  assert.equal(store.recall({ limit: 100 }).length, 3);
  // Ghi đè cùng (userId, botId, key) không tạo entry mới.
  store.remember({ key: 'a-only', value: 'của A v2', userId: 'user-a' });
  assert.equal(store.recall({ userId: 'user-a', limit: 100 }).length, 2);
  assert.equal(store.recall({ userId: 'user-a', query: 'a-only' })[0].value, 'của A v2');
});

test('memory scope bot: recall có includeShared lấy cả memory chung', () => {
  const dir = makeTempDir();
  const store = new LongTermMemory(dir);
  store.remember({ key: 'chung', value: 'mọi bot đều biết', botId: '' });
  store.remember({ key: 'riêng-a', value: 'chỉ bot A', botId: 'bot-a' });
  store.remember({ key: 'riêng-b', value: 'chỉ bot B', botId: 'bot-b' });
  const aOnly = store.recall({ botId: 'bot-a', limit: 100 }).map((e) => e.key);
  assert.deepEqual(aOnly.sort(), ['riêng-a']);
  const aShared = store.recall({ botId: 'bot-a', includeShared: true, limit: 100 }).map((e) => e.key);
  assert.deepEqual(aShared.sort(), ['chung', 'riêng-a']);
});

test('memory semantic: xếp hạng cosine theo embedder, fallback từ khoá khi không có embedder', async () => {
  const dir = makeTempDir();
  const store = new LongTermMemory(dir);
  await store.rememberWithEmbedding({ key: 'ăn uống', value: 'thích phở bò', tags: ['ăn uống'] }, keywordEmbedder);
  await store.rememberWithEmbedding({ key: 'du lịch', value: 'thích đi biển', tags: ['du lịch'] }, keywordEmbedder);
  await store.rememberWithEmbedding({ key: 'code', value: 'làm việc với TypeScript', tags: ['code'] }, keywordEmbedder);
  const sem = await store.recallSemantic('món phở bò ngon', { embedder: keywordEmbedder, limit: 5 });
  assert.equal(sem.usedFallback, false);
  assert.equal(sem.hits[0].entry.key, 'ăn uống');
  assert.ok(sem.hits[0].score > 0.99);
  // Không có embedder → fallback từ khoá, lý do rõ ràng.
  const kw = await store.recallSemantic('phở bò', { limit: 5 });
  assert.equal(kw.usedFallback, true);
  assert.equal(kw.fallbackReason, 'no-embedder');
  assert.equal(kw.hits[0].entry.key, 'ăn uống');
});

test('memory UI ops: updateEntry (đổi value xoá vector), forgetById, export không kèm vector', async () => {
  const dir = makeTempDir();
  const store = new LongTermMemory(dir);
  const saved = await store.rememberWithEmbedding(
    { key: 'ăn uống', value: 'thích phở bò', tags: ['ăn uống'] },
    keywordEmbedder,
  );
  assert.equal(saved.embedded, true);
  assert.ok(Array.isArray(saved.entry.embedding));
  const updated = store.updateEntry(saved.entry.id, { value: 'thích phở gà', tags: ['ăn uống', 'gà'] });
  assert.equal(updated.value, 'thích phở gà');
  assert.deepEqual(updated.tags, ['ăn uống', 'gà']);
  assert.equal(updated.embedding, undefined);
  assert.equal(store.updateEntry('id-khong-co', { value: 'x' }), null);
  assert.throws(() => store.updateEntry(saved.entry.id, { value: '   ' }), /must not be empty/);
  // Export: JSON đọc được, không chứa vector.
  const exported = store.exportMemories();
  const parsed = JSON.parse(exported);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.count, 1);
  assert.equal(exported.includes('embedding'), false);
  assert.equal(parsed.entries[0].value, 'thích phở gà');
  // Xoá theo id.
  assert.equal(store.forgetById(saved.entry.id), true);
  assert.equal(store.forgetById(saved.entry.id), false);
  assert.equal(store.list().length, 0);
});
