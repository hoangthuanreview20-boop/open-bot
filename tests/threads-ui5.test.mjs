/**
 * threads-ui5.test.mjs — threads / conversation list + search (v0.59 UI-5).
 *
 * Two levels:
 *   1. BotMemory directly (SQLite, temp dir): create / list / rename /
 *      delete / load thread history, search by title + content, default
 *      thread migration of legacy (pre-thread) history, auto-title from
 *      the first user message, delete isolation between threads.
 *   2. Coordinator RPC through a real CoordinatorClient child (mock
 *      provider, no network): listThreads / createThread / renameThread /
 *      deleteThread / getThreadHistory / searchThreads, plus saveMessage
 *      and getHistory scoped by threadId.
 *
 * Run (after building core + tools):
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/threads-ui5.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BotMemory } from '../packages/core/dist/agent/memory.js';
import { CoordinatorClient } from '../packages/core/dist/coordinator/client.js';

const tmpDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-threads-'));
  tmpDirs.push(dir);
  return dir;
}

function botConfig(id, workspaceDir) {
  return {
    id,
    name: `Bot ${id}`,
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir,
    autoApprove: true,
  };
}

// ---------------------------------------------------------------------------
// 1. BotMemory threads
// ---------------------------------------------------------------------------

test('threads: create/list/rename/delete/load — one bot, many threads', () => {
  const mem = new BotMemory(tmpDir());
  try {
    // No threads yet: listThreads creates the default thread.
    const initial = mem.listThreads('bot-a');
    assert.equal(initial.length, 1);
    assert.equal(initial[0].botId, 'bot-a');
    assert.equal(initial[0].messageCount, 0);

    const t1 = mem.createThread('bot-a', 'First chat');
    const t2 = mem.createThread('bot-a');
    assert.equal(t2.title, 'Cuộc trò chuyện mới');
    const listed = mem.listThreads('bot-a');
    assert.equal(listed.length, 3);
    // Newest first: the just-created thread comes first.
    assert.equal(listed[0].id, t2.id);

    mem.saveMessage('bot-a', 'user', 'hello thread one', t1.id);
    mem.saveMessage('bot-a', 'assistant', 'hi back', t1.id);
    mem.saveMessage('bot-a', 'user', 'hello thread two', t2.id);

    // Load the right thread when resuming (not the bot's whole history).
    const h1 = mem.getThreadHistory(t1.id);
    assert.deepEqual(
      h1.map((m) => m.content),
      ['hello thread one', 'hi back'],
    );
    const h2 = mem.getHistory('bot-a', 50, t2.id);
    assert.deepEqual(
      h2.map((m) => m.content),
      ['hello thread two'],
    );
    // Without a threadId the whole bot history still comes back
    // (legacy callers: search, handoff, transcript — unchanged).
    assert.equal(mem.getHistory('bot-a', 50).length, 3);

    const renamed = mem.renameThread(t1.id, 'Renamed chat');
    assert.equal(renamed.title, 'Renamed chat');
    assert.equal(renamed.titleCustom, true);
    assert.equal(mem.getThread(t1.id).title, 'Renamed chat');

    assert.equal(mem.deleteThread(t1.id), true);
    assert.equal(mem.getThread(t1.id), null);
    assert.equal(mem.deleteThread(t1.id), false);
    // Deleting a thread never deletes another thread's messages.
    assert.deepEqual(
      mem.getThreadHistory(t2.id).map((m) => m.content),
      ['hello thread two'],
    );
    assert.equal(mem.listThreads('bot-a').length, 2);
  } finally {
    mem.close();
  }
});

test('threads: default-thread migration keeps legacy history (no message lost)', () => {
  const dir = tmpDir();
  const mem = new BotMemory(dir);
  try {
    // Legacy rows: written before threads existed (threadId NULL).
    mem.saveMessage('bot-a', 'user', 'xin chào, đây là lịch sử cũ');
    mem.saveMessage('bot-a', 'assistant', 'chào bạn, tôi vẫn nhớ');
    mem.saveMessage('bot-b', 'user', 'bot khác, không liên quan');
  } finally {
    mem.close();
  }
  // Reopen the same DB (a fresh BotMemory on the same workspace dir).
  const reopened = new BotMemory(dir);
  try {
    const threads = reopened.listThreads('bot-a');
    assert.equal(threads.length, 1);
    const def = threads[0];
    // Auto-titled from the first user message.
    assert.equal(def.title, 'xin chào, đây là lịch sử cũ');
    assert.equal(def.messageCount, 2);
    assert.deepEqual(
      reopened.getThreadHistory(def.id).map((m) => m.content),
      ['xin chào, đây là lịch sử cũ', 'chào bạn, tôi vẫn nhớ'],
    );
    // The other bot's history migrated into ITS own default thread.
    const other = reopened.listThreads('bot-b');
    assert.equal(other.length, 1);
    assert.equal(other[0].messageCount, 1);
    assert.deepEqual(
      reopened.getThreadHistory(other[0].id).map((m) => m.content),
      ['bot khác, không liên quan'],
    );
  } finally {
    reopened.close();
  }
});

test('threads: auto-title from first user message; hand rename is never overwritten', () => {
  const mem = new BotMemory(tmpDir());
  try {
    const t = mem.createThread('bot-a');
    assert.equal(t.title, 'Cuộc trò chuyện mới');
    mem.saveMessage('bot-a', 'user', 'Làm sao nấu phở bò ngon? Tôi cần công thức chi tiết.', t.id);
    assert.equal(mem.getThread(t.id).title, 'Làm sao nấu phở bò ngon? Tôi cần công thức chi tiết.');
    // A later user message never renames the thread again.
    mem.saveMessage('bot-a', 'user', 'Còn món bún chả thì sao?', t.id);
    assert.equal(mem.getThread(t.id).title, 'Làm sao nấu phở bò ngon? Tôi cần công thức chi tiết.');

    const t2 = mem.createThread('bot-a', 'Tên tôi đặt tay');
    mem.saveMessage('bot-a', 'user', 'tin nhắn đầu nhưng tên đã đặt tay', t2.id);
    assert.equal(mem.getThread(t2.id).title, 'Tên tôi đặt tay');
    const renamed = mem.renameThread(t2.id, 'Đổi tên sau');
    assert.equal(renamed.titleCustom, true);
    mem.saveMessage('bot-a', 'user', 'tin nhắn sau khi đổi tên', t2.id);
    assert.equal(mem.getThread(t2.id).title, 'Đổi tên sau');
  } finally {
    mem.close();
  }
});

test('threads: rename validation + saveMessage to an unknown / foreign thread throws', () => {
  const mem = new BotMemory(tmpDir());
  try {
    const t = mem.createThread('bot-a', 'Chat A');
    assert.throws(() => mem.renameThread(t.id, '   '), /không được rỗng/);
    assert.throws(() => mem.renameThread('no-such-thread', 'x'), /Không tìm thấy thread/);
    assert.throws(() => mem.getThreadHistory('no-such-thread'), /Không tìm thấy thread/);
    assert.throws(
      () => mem.saveMessage('bot-a', 'user', 'hello', 'no-such-thread'),
      /Không tìm thấy thread/,
    );
    const other = mem.createThread('bot-b', 'Chat B');
    // A thread of bot-b must not accept bot-a messages.
    assert.throws(
      () => mem.saveMessage('bot-a', 'user', 'hello', other.id),
      /Không tìm thấy thread/,
    );
  } finally {
    mem.close();
  }
});

test('threads: search by title + content, case-insensitive, scoped per bot', () => {
  const mem = new BotMemory(tmpDir());
  try {
    const cooking = mem.createThread('bot-a', 'Nấu ăn cuối tuần');
    mem.saveMessage('bot-a', 'user', 'cách nấu phở bò', cooking.id);
    const code = mem.createThread('bot-a', 'Code review');
    mem.saveMessage('bot-a', 'user', 'review giúp hàm parse này', code.id);
    mem.saveMessage('bot-a', 'assistant', 'hàm parse chạy ổn', code.id);
    const otherBot = mem.createThread('bot-b', 'Nấu ăn');
    mem.saveMessage('bot-b', 'user', 'cách nấu phở bò', otherBot.id);

    // Title match (Vietnamese case-insensitive: "NẤU" matches "Nấu").
    const byTitle = mem.searchThreads('bot-a', 'NẤU ĂN');
    assert.equal(byTitle.length, 1);
    assert.equal(byTitle[0].thread.id, cooking.id);
    assert.equal(byTitle[0].snippet, 'Nấu ăn cuối tuần');

    // Content match: snippet is the matching message, count is per thread.
    const byContent = mem.searchThreads('bot-a', 'parse');
    assert.equal(byContent.length, 1);
    assert.equal(byContent[0].thread.id, code.id);
    assert.equal(byContent[0].matchCount, 2);
    assert.match(byContent[0].snippet, /parse/);

    // Scoped per bot: bot-b's identical message never leaks into bot-a.
    assert.equal(mem.searchThreads('bot-a', 'phở bò').length, 1);
    assert.equal(mem.searchThreads('bot-b', 'phở bò').length, 1);
    assert.equal(mem.searchThreads('bot-b', 'phở bò')[0].thread.id, otherBot.id);

    assert.deepEqual(mem.searchThreads('bot-a', 'không có gì khớp'), []);
    assert.deepEqual(mem.searchThreads('bot-a', '   '), []);
  } finally {
    mem.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Coordinator RPC (real child process, mock provider)
// ---------------------------------------------------------------------------

let client;
test.before(async () => {
  client = new CoordinatorClient();
  const pong = await client.ping();
  assert.equal(pong.pong, true, 'coordinator phải trả pong');
});

test.after(async () => {
  await client.dispose();
  await client.dispose();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('coordinator RPC: threads end-to-end (list/create/rename/delete/load/search)', async () => {
  const ws = tmpDir();
  const created = await client.createBot({
    bot: botConfig('bot-1', ws),
    provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'ok' }] },
  });
  assert.equal(created.botId, 'bot-1');

  // listThreads always yields at least the default thread.
  const initial = await client.listThreads('bot-1');
  assert.equal(initial.threads.length, 1);
  const def = initial.threads[0];

  const t1 = (await client.createThread('bot-1', 'RPC thread one')).thread;
  const t2 = (await client.createThread('bot-1')).thread;
  assert.equal(t2.title, 'Cuộc trò chuyện mới');

  await client.saveMessage('bot-1', 'user', 'first message in t1', t1.id);
  await client.saveMessage('bot-1', 'assistant', 'reply in t1', t1.id);
  await client.saveMessage('bot-1', 'user', 'only message in t2', t2.id);

  // Resume loads exactly the chosen thread.
  const h1 = await client.getThreadHistory(t1.id);
  assert.equal(h1.thread.id, t1.id);
  assert.deepEqual(
    h1.messages.map((m) => m.content),
    ['first message in t1', 'reply in t1'],
  );
  const h2 = await client.getHistory('bot-1', 50, t2.id);
  assert.deepEqual(
    h2.messages.map((m) => m.content),
    ['only message in t2'],
  );

  // Rename + search through the RPC.
  const renamed = (await client.renameThread(t1.id, 'RPC renamed')).thread;
  assert.equal(renamed.title, 'RPC renamed');
  const { hits } = await client.searchThreads('RPC renamed', 'bot-1');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].thread.id, t1.id);
  const { hits: contentHits } = await client.searchThreads('only message');
  assert.equal(contentHits.length, 1);
  assert.equal(contentHits[0].thread.id, t2.id);

  // Delete one thread: the others (and the default) survive untouched.
  const deleted = await client.deleteThread(t1.id);
  assert.equal(deleted.deleted, true);
  const after = await client.listThreads('bot-1');
  assert.equal(after.threads.length, 2);
  assert.ok(after.threads.some((th) => th.id === def.id));
  assert.ok(after.threads.some((th) => th.id === t2.id));
  const h2After = await client.getThreadHistory(t2.id);
  assert.deepEqual(
    h2After.messages.map((m) => m.content),
    ['only message in t2'],
  );

  // Unknown thread fails closed, like a bad botId.
  await assert.rejects(() => client.getThreadHistory('no-such-thread'), /Không tìm thấy thread/);
  await assert.rejects(() => client.renameThread('no-such-thread', 'x'), /Không tìm thấy thread/);
});
