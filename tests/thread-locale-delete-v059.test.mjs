/**
 * thread-locale-delete-v059.test.mjs — fix 2 lỗi còn lại của v0.59:
 *
 * (a) Tiêu đề thread mặc định luôn tiếng Việt kể cả khi locale là 'en':
 *     `defaultThreadTitle(locale)` + `createThread` / `listThreads` /
 *     `ensureDefaultThread` nhận `locale`; coordinator RPC
 *     `listThreads` / `createThread` truyền `locale` qua; main truyền
 *     `settings.locale` ở IPC `threads:list` / `threads:create`.
 *     Mở rộng v0.74d: 4 locale mới của Team C (zh/ja/es/fr) — giá trị
 *     lấy đúng từ `thread.new` trong file locale của renderer.
 * (b) Xoá bot không xoá thread/message của bot đó trong DB:
 *     `BotMemory.deleteBotData(botId)` xoá mọi dòng của bot (bots,
 *     threads, messages, memory_entries, tasks, goals, todos,
 *     projects, run_checkpoints) trong một transaction, theo botId —
 *     bot khác dùng chung DB không ảnh hưởng. `destroyBot` chỉ xoá
 *     khi `{ deleteData: true }` (đường xoá thật); không flag thì giữ
 *     dữ liệu (đường sửa bot / đổi provider / cài MCP cũng đi qua
 *     destroyBot và KHÔNG được mất history). RPC `deleteBotData`
 *     xoá theo workspaceDir, kể cả khi bot không còn entry đang chạy
 *     (xoá sau khi restart app mà chưa chạy bot).
 *
 * Run (after building core):
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/thread-locale-delete-v059.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BotMemory,
  DEFAULT_THREAD_TITLE,
  defaultThreadTitle,
} from '../packages/core/dist/agent/memory.js';
import { CoordinatorClient } from '../packages/core/dist/coordinator/client.js';

const tmpDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-thread-locale-'));
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

/** Seed one bot with a thread + messages + one row per related table. */
function seedBotData(mem, botId) {
  mem.saveBot({
    id: botId,
    name: `Bot ${botId}`,
    providerId: 'mock',
    model: 'mock',
    systemPrompt: '',
  });
  const thread = mem.createThread(botId, `Thread of ${botId}`);
  mem.saveMessage(botId, 'user', `hello from ${botId}`, thread.id);
  mem.saveMessage(botId, 'assistant', `reply to ${botId}`, thread.id);
  mem.setMemory(botId, 'note', `memory of ${botId}`);
  mem.createTask(botId, `Task of ${botId}`);
  mem.createGoal(botId, `Goal of ${botId}`);
  mem.createTodo(botId, `Todo of ${botId}`);
  mem.createProject(botId, `Project of ${botId}`);
  mem.insertCheckpointRow({
    runId: `run-${botId}`,
    botId,
    stepIndex: 0,
    messagesJson: '[]',
    toolCallsJson: '[]',
    tokensUsed: 1,
  });
  return thread;
}

// ---------------------------------------------------------------------------
// (a) Default thread title follows the locale — BotMemory directly
// ---------------------------------------------------------------------------

test('(a) defaultThreadTitle: en/zh/ja/es/fr → đúng locale, vi/unknown/missing → Vietnamese', () => {
  assert.equal(defaultThreadTitle('en'), 'New conversation');
  assert.equal(defaultThreadTitle('vi'), 'Cuộc trò chuyện mới');
  assert.equal(defaultThreadTitle('vi'), DEFAULT_THREAD_TITLE);
  assert.equal(defaultThreadTitle(), 'Cuộc trò chuyện mới');
  assert.equal(defaultThreadTitle(null), 'Cuộc trò chuyện mới');
  assert.equal(defaultThreadTitle(''), 'Cuộc trò chuyện mới');
  // v0.74d: 4 locale mới của Team C (v0.72c) — giá trị lấy đúng từ
  // `thread.new` trong file locale của renderer, không phải dịch mới.
  assert.equal(defaultThreadTitle('zh'), '新对话');
  assert.equal(defaultThreadTitle('ja'), '新しい会話');
  assert.equal(defaultThreadTitle('es'), 'Conversación nueva');
  assert.equal(defaultThreadTitle('fr'), 'Nouvelle conversation');
  // Mã lạ vẫn về tiếng Việt (mặc định của repo).
  assert.equal(defaultThreadTitle('de'), 'Cuộc trò chuyện mới');
  assert.equal(defaultThreadTitle('pt-BR'), 'Cuộc trò chuyện mới');
  // Chuẩn hoá: hoa/thường + khoảng trắng quanh mã không đổi kết quả.
  assert.equal(defaultThreadTitle('EN'), 'New conversation');
  assert.equal(defaultThreadTitle(' zh '), '新对话');
});

test('(a) createThread / listThreads name the default thread by locale', () => {
  const mem = new BotMemory(tmpDir());
  try {
    // Explicit title always wins, whatever the locale.
    const named = mem.createThread('bot-a', 'Tên tôi đặt tay', 'en');
    assert.equal(named.title, 'Tên tôi đặt tay');
    assert.equal(named.titleCustom, true);

    // No title + locale 'en' → English default, still auto-titling
    // (titleCustom false: the first user message may rename it).
    const tEn = mem.createThread('bot-a', undefined, 'en');
    assert.equal(tEn.title, 'New conversation');
    assert.equal(tEn.titleCustom, false);

    // No locale → Vietnamese default (old behaviour, unchanged).
    const tVi = mem.createThread('bot-a');
    assert.equal(tVi.title, 'Cuộc trò chuyện mới');
    assert.equal(tVi.titleCustom, false);
    const tVi2 = mem.createThread('bot-a', undefined, 'vi');
    assert.equal(tVi2.title, 'Cuộc trò chuyện mới');

    // v0.74d: 4 locale mới — createThread đặt title mặc định đúng
    // locale, vẫn auto-titling (titleCustom false).
    for (const [locale, expected] of [
      ['zh', '新对话'],
      ['ja', '新しい会話'],
      ['es', 'Conversación nueva'],
      ['fr', 'Nouvelle conversation'],
    ]) {
      const t = mem.createThread('bot-a', undefined, locale);
      assert.equal(t.title, expected, `createThread locale ${locale}`);
      assert.equal(t.titleCustom, false);
    }

    // listThreads creates the default thread of a fresh bot in locale.
    const freshEn = mem.listThreads('bot-en', 'en');
    assert.equal(freshEn.length, 1);
    assert.equal(freshEn[0].title, 'New conversation');
    const freshJa = mem.listThreads('bot-ja', 'ja');
    assert.equal(freshJa.length, 1);
    assert.equal(freshJa[0].title, '新しい会話');
    const freshDefault = mem.listThreads('bot-default');
    assert.equal(freshDefault.length, 1);
    assert.equal(freshDefault[0].title, 'Cuộc trò chuyện mới');
  } finally {
    mem.close();
  }
});

// ---------------------------------------------------------------------------
// (b) deleteBotData — BotMemory directly, two bots sharing one DB file
// ---------------------------------------------------------------------------

test('(b) deleteBotData wipes one bot, leaves a bot sharing the DB alone', () => {
  const mem = new BotMemory(tmpDir());
  try {
    const threadA = seedBotData(mem, 'bot-a');
    const threadB = seedBotData(mem, 'bot-b');

    const counts = mem.deleteBotData('bot-a');
    assert.equal(counts.bots, 1);
    assert.equal(counts.threads, 1);
    assert.equal(counts.messages, 2);
    assert.equal(counts.memory_entries, 1);
    assert.equal(counts.tasks, 1);
    assert.equal(counts.goals, 1);
    assert.equal(counts.todos, 1);
    assert.equal(counts.projects, 1);
    assert.equal(counts.run_checkpoints, 1);

    // Bot-a is gone from every table…
    assert.equal(mem.getBot('bot-a'), null);
    assert.equal(mem.getThread(threadA.id), null);
    assert.deepEqual(mem.getHistory('bot-a'), []);
    assert.deepEqual(mem.listTasks('bot-a'), []);
    assert.deepEqual(mem.listGoals('bot-a'), []);
    assert.deepEqual(mem.listTodos('bot-a'), []);
    assert.deepEqual(mem.listProjects('bot-a'), []);
    assert.equal(mem.getMemory('bot-a', 'note'), null);
    assert.deepEqual(mem.listCheckpointRows('run-bot-a'), []);
    assert.deepEqual(mem.searchThreads('bot-a', 'hello'), []);
    // (listThreads('bot-a') is NOT asserted here: it would recreate a
    // fresh default thread for the deleted bot by design.)

    // …while bot-b is untouched.
    assert.ok(mem.getBot('bot-b'));
    assert.ok(mem.getThread(threadB.id));
    assert.deepEqual(
      mem.getHistory('bot-b').map((m) => m.content),
      ['hello from bot-b', 'reply to bot-b'],
    );
    assert.equal(mem.listTasks('bot-b').length, 1);
    assert.equal(mem.getMemory('bot-b', 'note'), 'memory of bot-b');
    assert.equal(mem.listCheckpointRows('run-bot-b').length, 1);

    // Deleting again (or an unknown bot) reports zero rows, no throw.
    const again = mem.deleteBotData('bot-a');
    assert.deepEqual(Object.values(again).every((n) => n === 0), true);
    const unknown = mem.deleteBotData('no-such-bot');
    assert.deepEqual(Object.values(unknown).every((n) => n === 0), true);
  } finally {
    mem.close();
  }
});

// ---------------------------------------------------------------------------
// (a) + (b) through Coordinator RPC (real child process, mock provider)
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

test('(a) RPC: listThreads / createThread name the default thread by locale', async () => {
  const ws = tmpDir();
  await client.createBot({
    bot: botConfig('bot-loc', ws),
    provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'ok' }] },
  });

  const initialEn = await client.listThreads('bot-loc', 'en');
  assert.equal(initialEn.threads.length, 1);
  assert.equal(initialEn.threads[0].title, 'New conversation');

  const tEn = (await client.createThread('bot-loc', undefined, 'en')).thread;
  assert.equal(tEn.title, 'New conversation');

  // v0.74d: locale mới qua RPC — ja (đại diện 4 locale; cả 4 đã phủ
  // ở tầng BotMemory trực tiếp bên trên).
  const tJa = (await client.createThread('bot-loc', undefined, 'ja')).thread;
  assert.equal(tJa.title, '新しい会話');
  const listedJa = await client.listThreads('bot-loc', 'ja');
  assert.ok(
    listedJa.threads.some((th) => th.id === tJa.id && th.title === '新しい会話'),
    'listThreads phải trả lại thread ja vừa tạo',
  );

  const tDefault = (await client.createThread('bot-loc')).thread;
  assert.equal(tDefault.title, 'Cuộc trò chuyện mới');

  await client.destroyBot('bot-loc');
});

test('(b) RPC: destroyBot { deleteData: true } wipes threads/messages, other bot survives', async () => {
  // One shared workspace dir = one shared memory.db, so isolation is real.
  const ws = tmpDir();
  for (const id of ['bot-del-1', 'bot-del-2']) {
    await client.createBot({
      bot: botConfig(id, ws),
      provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'ok' }] },
    });
  }
  const t1 = (await client.createThread('bot-del-1', 'Thread one')).thread;
  const t2 = (await client.createThread('bot-del-2', 'Thread two')).thread;
  await client.saveMessage('bot-del-1', 'user', 'secret one', t1.id);
  await client.saveMessage('bot-del-1', 'assistant', 'reply one', t1.id);
  await client.saveMessage('bot-del-2', 'user', 'secret two', t2.id);

  const destroyed = await client.destroyBot('bot-del-1', { deleteData: true });
  assert.equal(destroyed.destroyed, true);
  assert.equal(destroyed.deletedRows.messages, 2);
  assert.equal(destroyed.deletedRows.threads, 1); // only 'Thread one' (no listThreads call made a default thread)
  assert.equal(destroyed.deletedRows.bots, 1);

  // Reopen the same DB file directly: bot-del-1 is gone, bot-del-2 intact.
  const reopened = new BotMemory(ws);
  try {
    assert.equal(reopened.getBot('bot-del-1'), null);
    assert.equal(reopened.getThread(t1.id), null);
    assert.deepEqual(reopened.getHistory('bot-del-1'), []);
    assert.ok(reopened.getBot('bot-del-2'));
    assert.ok(reopened.getThread(t2.id));
    assert.deepEqual(
      reopened.getHistory('bot-del-2').map((m) => m.content),
      ['secret two'],
    );
  } finally {
    reopened.close();
  }

  await client.destroyBot('bot-del-2');
});

test('(b) RPC: destroyBot WITHOUT deleteData keeps history (edit path safety)', async () => {
  const ws = tmpDir();
  await client.createBot({
    bot: botConfig('bot-keep', ws),
    provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'ok' }] },
  });
  const t = (await client.createThread('bot-keep', 'Keep me')).thread;
  await client.saveMessage('bot-keep', 'user', 'do not wipe me', t.id);

  // Plain destroyBot = what bot edit / provider change / MCP install do
  // via main invalidateRuntime: runtime goes, data must stay.
  const destroyed = await client.destroyBot('bot-keep');
  assert.equal(destroyed.destroyed, true);
  assert.equal(destroyed.deletedRows, undefined);

  const reopened = new BotMemory(ws);
  try {
    assert.ok(reopened.getBot('bot-keep'));
    assert.ok(reopened.getThread(t.id));
    assert.deepEqual(
      reopened.getHistory('bot-keep').map((m) => m.content),
      ['do not wipe me'],
    );
  } finally {
    reopened.close();
  }

  // deleteBotData RPC wipes the same bot by workspace dir even with no
  // live runtime entry left (the restart-then-delete case).
  const wiped = await client.deleteBotData({ botId: 'bot-keep', workspaceDir: ws });
  assert.equal(wiped.deletedRows.messages, 1);
  assert.equal(wiped.deletedRows.bots, 1);
  const reopened2 = new BotMemory(ws);
  try {
    assert.equal(reopened2.getBot('bot-keep'), null);
    assert.deepEqual(reopened2.getHistory('bot-keep'), []);
  } finally {
    reopened2.close();
  }
});

test('(b) RPC: deleteBotData on a workspace with no memory.db reports zeros', async () => {
  const emptyWs = tmpDir();
  const result = await client.deleteBotData({ botId: 'ghost', workspaceDir: emptyWs });
  assert.equal(result.botId, 'ghost');
  assert.deepEqual(Object.values(result.deletedRows).every((n) => n === 0), true);
  // And it created nothing: no .open-bot dir appeared.
  assert.equal(fs.existsSync(path.join(emptyWs, '.open-bot')), false);

  await assert.rejects(
    () => client.deleteBotData({ botId: 'x', workspaceDir: '' }),
    /deleteBotData cần params/,
  );
  await assert.rejects(
    () => client.destroyBot('no-such-bot', { deleteData: true }),
    /Chưa tạo bot/,
  );
});
