/**
 * Tests for v0.95d4 — turn context: profile + long-term memory recall
 * nối vào system prompt (memory/turnContext.ts).
 *
 * Bao phủ: profile inject, recall ngữ nghĩa xếp hạng, ngân sách ký tự
 * (profile ưu tiên, recall cắt theo hit), fallback khi Ollama chết
 * (probe nhanh, không treo), turn trống (không query) thì section rỗng.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/turn-context-v095d4.test.mjs
 *
 * No network. Fake embedder deterministic theo từ khoá.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LongTermMemory } from '../packages/core/dist/memory/longterm.js';
import { buildMemoryTurnContext } from '../packages/core/dist/memory/turnContext.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-turnctx-v095d4-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

const downEmbedder = {
  model: 'fake-down',
  async isAvailable() {
    return false;
  },
  async embed() {
    throw new Error('Ollama is down — must never be called');
  },
};

const PROFILE = {
  userId: 'user-1',
  displayName: 'Huy',
  addressForm: 'bạn',
  interests: ['phở bò'],
  createdAt: 1,
};

async function seedStore(dir) {
  const store = new LongTermMemory(dir);
  await store.rememberWithEmbedding(
    { key: 'ăn uống', value: 'thích phở bò, không ăn cay', tags: ['ăn uống'] },
    keywordEmbedder,
  );
  await store.rememberWithEmbedding(
    { key: 'du lịch', value: 'thích đi biển Đà Nẵng', tags: ['du lịch'] },
    keywordEmbedder,
  );
  return store;
}

test('turn context: profile + recall ngữ nghĩa vào section, đúng thứ hạng', async () => {
  const store = await seedStore(makeTempDir());
  const ctx = await buildMemoryTurnContext({
    profile: PROFILE,
    store,
    botId: 'bot-a',
    userId: 'user-1',
    userText: 'tối nay ăn phở ở đâu ngon?',
    embedder: keywordEmbedder,
  });
  assert.equal(ctx.profileIncluded, true);
  assert.equal(ctx.embedded, true);
  assert.equal(ctx.usedFallback, false);
  assert.ok(ctx.section.includes('Huy'));
  assert.ok(ctx.section.includes('"bạn"'));
  assert.ok(ctx.section.includes('thích phở bò'));
  assert.equal(ctx.recalled[0].entry.key, 'ăn uống');
  assert.ok(!ctx.section.includes('Đà Nẵng'), 'memory không liên quan không vào turn');
});

test('turn context: không có profile/store thì section rỗng, không throw', async () => {
  const empty = await buildMemoryTurnContext({ userText: 'xin chào' });
  assert.equal(empty.section, '');
  assert.deepEqual(empty.recalled, []);
  const noQuery = await buildMemoryTurnContext({
    profile: PROFILE,
    store: await seedStore(makeTempDir()),
    userText: '   ',
  });
  assert.ok(noQuery.section.includes('Huy'), 'profile vẫn inject khi không có query');
  assert.deepEqual(noQuery.recalled, []);
});

test('turn context: Ollama chết thì fallback từ khoá, nhanh (probe cache, không gọi embed)', async () => {
  const store = await seedStore(makeTempDir());
  const started = Date.now();
  const ctx = await buildMemoryTurnContext({
    profile: null,
    store,
    userText: 'phở bò',
    embedder: downEmbedder,
  });
  assert.ok(Date.now() - started < 5000, 'probe timeout 1.5s, không treo 30s');
  assert.equal(ctx.usedFallback, true);
  assert.equal(ctx.fallbackReason, 'no-embedder');
  assert.equal(ctx.embedded, false);
  assert.equal(ctx.recalled[0].entry.key, 'ăn uống');
  assert.ok(ctx.section.includes('thích phở bò'));
});

test('turn context: ngân sách ký tự — profile giữ nguyên, recall cắt, báo truncated', async () => {
  const store = await seedStore(makeTempDir());
  const ctx = await buildMemoryTurnContext({
    profile: PROFILE,
    store,
    userText: 'phở bò',
    embedder: keywordEmbedder,
    maxChars: 120,
  });
  assert.equal(ctx.truncated, true);
  assert.ok(ctx.section.length <= 120 + 1 + '…(đã rút gọn theo ngân sách bộ nhớ)'.length);
  assert.ok(ctx.section.includes('Huy'), 'profile được ưu tiên trước recall');
});

test('turn context: recall chỉ lấy memory của user/bot đó + chung', async () => {
  const dir = makeTempDir();
  const store = new LongTermMemory(dir);
  await store.rememberWithEmbedding(
    { key: 'của A', value: 'thích phở bò', userId: 'user-1', botId: '' },
    keywordEmbedder,
  );
  await store.rememberWithEmbedding(
    { key: 'của B', value: 'thích phở bò', userId: 'user-2', botId: '' },
    keywordEmbedder,
  );
  const ctx = await buildMemoryTurnContext({
    profile: null,
    store,
    botId: 'bot-a',
    userId: 'user-1',
    userText: 'phở bò',
    embedder: keywordEmbedder,
  });
  assert.equal(ctx.recalled.length, 1);
  assert.equal(ctx.recalled[0].entry.key, 'của A');
});

test('turn context: kho rỗng thì không probe Ollama, không embed (fast path v0.95 merge)', async () => {
  // Hồi quy tests/ws-control.test.mjs: probe mạng (GET /api/tags) có độ
  // trễ biến động 5–823ms trên đường setup của turn — turn đầu tiên của
  // bot chưa có memory nào sẽ trả chậm và stopRun trong lúc setup thấy
  // run "chưa bắt đầu". Kho rỗng thì không có gì để recall nên phải bỏ
  // qua cả probe lẫn embed.
  const store = new LongTermMemory(makeTempDir());
  let probeCalls = 0;
  let embedCalls = 0;
  const countingEmbedder = {
    model: 'fake-counting',
    async isAvailable() {
      probeCalls++;
      return true;
    },
    async embed() {
      embedCalls++;
      throw new Error('embed không được gọi khi kho rỗng');
    },
  };
  const started = Date.now();
  const ctx = await buildMemoryTurnContext({
    profile: null,
    store,
    botId: 'bot-a',
    userId: 'user-1',
    userText: 'tối nay ăn gì?',
    embedder: countingEmbedder,
  });
  assert.ok(Date.now() - started < 1000, 'fast path đồng bộ, không chờ mạng');
  assert.equal(probeCalls, 0, 'không probe Ollama khi kho rỗng');
  assert.equal(embedCalls, 0, 'không embed khi kho rỗng');
  assert.deepEqual(ctx.recalled, []);
  assert.equal(ctx.section, '');
});
