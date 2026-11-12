/**
 * Tests cho M8 — Group chat bot-bot.
 *
 * Covers:
 *  - `groupchat/groupchat.ts` (store CRUD + bền vững file JSON,
 *    `parseGroupMentions` khớp id/tên, giới hạn message)
 *  - `coordinator.ts` group chat RPC (tạo nhóm, thêm bot, post message
 *    + delegation qua run() đã có: bot được @mention chạy silent run
 *    và trả lời trong thread; câu trả lời không parse mention tiếp)
 *  - Lịch sử bền vững: coordinator mới cùng dataDir đọc lại đủ history.
 *
 * KHÔNG dùng CLI thật, KHÔNG đọc tài khoản/credential thật, KHÔNG gọi
 * API ngoài: mock provider + thư mục tạm.
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   xvfb-run -a node --test tests/groupchat-m8.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AgentCoordinator,
  GroupChatStore,
  parseGroupMentions,
} from '../packages/core/dist/index.js';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-m8-group-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const BOTS = [
  { id: 'bot-a', name: 'Bot A' },
  { id: 'bot-b', name: 'Bot Bê' },
  { id: 'bot-c', name: 'Trợ Lý' },
];

test('parseGroupMentions: khớp id và tên (không phân biệt hoa/thường, tên có khoảng trắng)', () => {
  assert.deepEqual(parseGroupMentions('@Bot A làm việc này nhé', BOTS), ['bot-a']);
  assert.deepEqual(parseGroupMentions('@bot-b giúp mình', BOTS), ['bot-b']);
  assert.deepEqual(parseGroupMentions('@TrợLý tóm tắt giúp', BOTS), ['bot-c']);
  assert.deepEqual(parseGroupMentions('@Bot A và @bot-b cùng làm', BOTS), ['bot-a', 'bot-b']);
  assert.deepEqual(parseGroupMentions('@Bot A @Bot A lặp lại', BOTS), ['bot-a']);
  assert.deepEqual(parseGroupMentions('không có mention', BOTS), []);
  assert.deepEqual(parseGroupMentions('@nguoi-la ai đó?', BOTS), []);
  // @files/@docs là mention file (v0.16), không phải mention bot.
  assert.deepEqual(parseGroupMentions('@files notes.txt', BOTS), []);
});

test('GroupChatStore: CRUD + message bền vững qua reload file', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'group-chats.json');
  const store = new GroupChatStore(file);
  const group = store.createGroup('Nhóm làm việc', ['bot-a']);
  assert.equal(group.name, 'Nhóm làm việc');
  assert.deepEqual(group.botIds, ['bot-a']);
  assert.equal(store.addBot(group.id, 'bot-b'), true);
  assert.equal(store.addBot(group.id, 'bot-b'), false, 'thêm trùng thì false');
  assert.equal(store.addBot('nope', 'bot-b'), false, 'nhóm không có thì false');
  const m1 = store.postMessage({
    groupId: group.id,
    botName: 'Bạn',
    text: 'Chào @Bot A',
    mentions: ['bot-a'],
  });
  assert.equal(m1.botId, '', 'message của user có botId rỗng');
  assert.deepEqual(m1.mentions, ['bot-a']);
  store.postMessage({ groupId: group.id, botId: 'bot-a', botName: 'Bot A', text: 'Chào bạn', delegated: true });

  // Reload từ cùng file: nhóm + history còn đủ.
  const reloaded = new GroupChatStore(file);
  assert.equal(reloaded.listGroups().length, 1);
  assert.deepEqual(reloaded.getGroup(group.id).botIds, ['bot-a', 'bot-b']);
  const messages = reloaded.listMessages(group.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].text, 'Chào @Bot A');
  assert.equal(messages[1].botName, 'Bot A');
  assert.equal(messages[1].delegated, true);

  assert.equal(store.removeBot(group.id, 'bot-b'), true);
  assert.equal(store.deleteGroup(group.id), true);
  assert.equal(store.listGroups().length, 0);
  assert.equal(store.listMessages(group.id).length, 0, 'xoá nhóm thì xoá cả history');
});

test('GroupChatStore: file hỏng thì về rỗng, không crash; tên rỗng / text rỗng thì throw', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'group-chats.json');
  fs.writeFileSync(file, '{json hỏng', 'utf8');
  const store = new GroupChatStore(file);
  assert.equal(store.listGroups().length, 0);
  assert.throws(() => store.createGroup('   '), /tên không rỗng/);
  const group = store.createGroup('Nhóm');
  assert.throws(() => store.postMessage({ groupId: group.id, botName: 'Bạn', text: '   ' }), /nội dung không rỗng/);
  assert.throws(() => store.postMessage({ groupId: 'nope', botName: 'Bạn', text: 'hi' }), /Không thấy nhóm chat/);
});

async function makeCoordinator(dataDir) {
  const coordinator = new AgentCoordinator({ dataDir, emit: () => {} });
  const mkBot = async (id, name, reply) => {
    const ws = path.join(dataDir, 'ws', id);
    fs.mkdirSync(ws, { recursive: true });
    await coordinator.createBot({
      bot: { id, name, providerId: 'mock', model: 'mock', systemPrompt: 'test', workspaceDir: ws, autoApprove: true },
      provider: { id: 'mock', label: 'Mock', defaultModel: 'mock', mockResponses: [{ text: reply }] },
    });
  };
  await mkBot('bot-a', 'Bot A', 'A trả lời');
  await mkBot('bot-b', 'Bot Bê', 'B trả lời: đã xong việc');
  return coordinator;
}

test('coordinator group chat: @mention đúng bot → delegation, history bền vững', async () => {
  const dataDir = makeTempDir('open-bot-m8-groupcoord-');
  const coordinator = await makeCoordinator(dataDir);
  try {
    const { group } = coordinator.createGroupChat({ name: 'Nhóm việc', botIds: ['bot-a', 'bot-b'] });
    assert.equal(group.botIds.length, 2);

    // Message không mention → không delegation.
    const plain = await coordinator.postGroupMessage({ groupId: group.id, text: 'Chào cả nhóm' });
    assert.equal(plain.message.botName, 'Bạn');
    assert.deepEqual(plain.message.mentions, []);
    assert.deepEqual(plain.replies, []);

    // @mention Bot Bê → bot B chạy silent run, trả lời trong thread.
    const delegated = await coordinator.postGroupMessage({
      groupId: group.id,
      text: '@Bot Bê tóm tắt giúp mình',
    });
    assert.deepEqual(delegated.message.mentions, ['bot-b']);
    assert.equal(delegated.replies.length, 1);
    assert.equal(delegated.replies[0].botId, 'bot-b');
    assert.equal(delegated.replies[0].botName, 'Bot Bê');
    assert.equal(delegated.replies[0].text, 'B trả lời: đã xong việc');
    assert.equal(delegated.replies[0].delegated, true);

    // History đủ cả 3 message tới lúc này, theo thứ tự.
    const { messages } = coordinator.listGroupMessages({ groupId: group.id });
    assert.equal(messages.length, 3);
    assert.deepEqual(
      messages.map((m) => m.botName),
      ['Bạn', 'Bạn', 'Bot Bê'],
    );
    assert.equal(messages[2].text, 'B trả lời: đã xong việc');

    // @mention Bot A (trong nhóm) → delegation cho bot A.
    const delegatedA = await coordinator.postGroupMessage({ groupId: group.id, text: '@Bot A làm giúp' });
    assert.deepEqual(delegatedA.message.mentions, ['bot-a']);
    assert.equal(delegatedA.replies.length, 1, 'bot A trong nhóm nên delegation');
    assert.equal(delegatedA.replies[0].text, 'A trả lời');
    // Mention người lạ → không mention bot nào, không delegation.
    const stranger = await coordinator.postGroupMessage({ groupId: group.id, text: '@nguoi-la ơi' });
    assert.deepEqual(stranger.message.mentions, []);
    assert.deepEqual(stranger.replies, []);
  } finally {
    coordinator.shutdown();
  }
});

test('coordinator group chat: coordinator mới cùng dataDir đọc lại đủ history', async () => {
  const dataDir = makeTempDir('open-bot-m8-grouppersist-');
  const first = await makeCoordinator(dataDir);
  let groupId;
  try {
    groupId = first.createGroupChat({ name: 'Nhóm bền', botIds: ['bot-a'] }).group.id;
    await first.postGroupMessage({ groupId, text: 'Tin bền vững 1' });
    await first.postGroupMessage({ groupId, text: 'Tin bền vững 2' });
  } finally {
    first.shutdown();
  }
  const second = new AgentCoordinator({ dataDir, emit: () => {} });
  try {
    const { groups } = second.listGroupChats();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].id, groupId);
    const { messages } = second.listGroupMessages({ groupId });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].text, 'Tin bền vững 1');
    assert.equal(messages[1].text, 'Tin bền vững 2');
  } finally {
    second.shutdown();
  }
});

test('coordinator group chat: lỗi rõ khi nhóm/bot không có', async () => {
  const dataDir = makeTempDir('open-bot-m8-grouperr-');
  const coordinator = await makeCoordinator(dataDir);
  try {
    assert.throws(() => coordinator.createGroupChat({ name: '  ' }), /không rỗng/);
    assert.throws(
      () => coordinator.createGroupChat({ name: 'X', botIds: ['bot-la'] }),
      /Không rõ bot/,
    );
    const { group } = coordinator.createGroupChat({ name: 'Nhóm' });
    assert.throws(
      () => coordinator.addBotToGroupChat({ groupId: group.id, botId: 'bot-la' }),
      /Không rõ bot/,
    );
    await assert.rejects(
      coordinator.postGroupMessage({ groupId: 'nope', text: 'hi' }),
      /Không thấy nhóm chat/,
    );
    assert.throws(
      () => coordinator.listGroupMessages({ groupId: 'nope' }),
      /Không thấy nhóm chat/,
    );
  } finally {
    coordinator.shutdown();
  }
});
