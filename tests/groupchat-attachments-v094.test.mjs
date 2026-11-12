/**
 * Tests cho v0.94c — group chat bot-bot nhận ảnh đính kèm.
 *
 * Covers:
 *  - `groupchat/groupchat.ts`: `saveAttachment`/`readAttachment` (file
 *    trong `group-attachments`, tham chiếu trong JSON, không nhúng
 *    base64), text rỗng được khi có ảnh, entry attachments hỏng lúc
 *    load thì bỏ entry đó (không bỏ cả message), xoá nhóm / trim
 *    message cũ thì xoá luôn file ảnh.
 *  - `coordinator.ts` group chat RPC: `postGroupMessage` validate ảnh
 *    (cùng giới hạn vision channel), message ảnh-only được gửi,
 *    delegation run nhận đúng bytes ảnh (kiểm chứng qua history của
 *    bot được mention), `getGroupAttachment` đọc lại bytes + bền vững
 *    qua restart coordinator.
 *
 * KHÔNG dùng CLI thật, KHÔNG đọc tài khoản/credential thật, KHÔNG gọi
 * API ngoài: mock provider + thư mục tạm + ảnh PNG 1x1 giả.
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/groupchat-attachments-v094.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AgentCoordinator,
  GROUP_ATTACHMENTS_DIRNAME,
  GroupChatStore,
} from '../packages/core/dist/index.js';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-v094-groupattach-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// PNG 1x1 trong suốt (base64) — đủ để đi qua validator vision.
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const PNG_ATT = { mimeType: 'image/png', data: PNG_1X1, name: 'anh-test.png' };

test('GroupChatStore: save/read attachment round-trip, file nằm ngoài JSON', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'group-chats.json');
  const store = new GroupChatStore(file);
  // createGroup ghi file JSON ngay (saveAttachment một mình không ghi
  // JSON — JSON chỉ đổi khi có message tham chiếu tới ảnh).
  store.createGroup('Nhóm ảnh');
  const ref = store.saveAttachment(PNG_ATT);
  assert.equal(ref.mimeType, 'image/png');
  assert.equal(ref.name, 'anh-test.png');
  assert.equal(ref.sizeBytes, Buffer.from(PNG_1X1, 'base64').length);
  assert.match(ref.file, /^[0-9a-f-]+\.png$/);
  // File ảnh nằm trong group-attachments, JSON không chứa base64.
  const onDisk = fs.readFileSync(path.join(dir, GROUP_ATTACHMENTS_DIRNAME, ref.file));
  assert.deepEqual(onDisk, Buffer.from(PNG_1X1, 'base64'));
  const rawJson = fs.readFileSync(file, 'utf8');
  assert.equal(rawJson.includes(PNG_1X1), false, 'base64 không được nhúng vào JSON');
  // Đọc lại đúng bytes.
  const back = store.readAttachment(ref);
  assert.equal(back?.mimeType, 'image/png');
  assert.equal(back?.data, PNG_1X1);
  assert.equal(back?.name, 'anh-test.png');
  // MIME lạ thì throw, không ghi file.
  assert.throws(() => store.saveAttachment({ mimeType: 'image/bmp', data: PNG_1X1 }), /Không hỗ trợ/);
  // Đọc ref lạ / file mất thì null, không throw.
  assert.equal(store.readAttachment({ id: 'x', mimeType: 'image/png', sizeBytes: 1, file: '../evil.png' }), null);
  assert.equal(store.readAttachment({ id: 'x', mimeType: 'image/png', sizeBytes: 1, file: 'khong-co.png' }), null);
});

test('GroupChatStore: text rỗng được khi có ảnh; trim/xoá nhóm dọn file ảnh', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'group-chats.json');
  const store = new GroupChatStore(file);
  const group = store.createGroup('Nhóm ảnh', ['bot-a']);
  // Text rỗng + không ảnh vẫn throw như cũ.
  assert.throws(
    () => store.postMessage({ groupId: group.id, botName: 'Bạn', text: '   ' }),
    /nội dung không rỗng/,
  );
  // Text rỗng + có ảnh thì được.
  const ref = store.saveAttachment(PNG_ATT);
  const m = store.postMessage({
    groupId: group.id,
    botName: 'Bạn',
    text: '   ',
    attachments: [ref],
  });
  assert.equal(m.text, '');
  assert.equal(m.attachments?.length, 1);
  assert.equal(m.attachments?.[0].file, ref.file);
  // Reload: tham chiếu còn, đọc lại được bytes.
  const reloaded = new GroupChatStore(file);
  const [again] = reloaded.listMessages(group.id);
  assert.equal(again.attachments?.length, 1);
  assert.equal(reloaded.readAttachment(again.attachments[0])?.data, PNG_1X1);
  // Xoá nhóm thì file ảnh cũng mất.
  assert.equal(reloaded.deleteGroup(group.id), true);
  assert.equal(fs.existsSync(path.join(dir, GROUP_ATTACHMENTS_DIRNAME, ref.file)), false);
});

test('GroupChatStore: entry attachments hỏng lúc load thì bỏ entry, giữ message', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'group-chats.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      groups: [{ id: 'g1', name: 'Nhóm', botIds: [], createdAt: '2026-11-12T00:00:00.000Z' }],
      messages: [
        {
          id: 'm1',
          groupId: 'g1',
          botId: '',
          botName: 'Bạn',
          text: 'có ảnh hỏng',
          mentions: [],
          delegated: false,
          attachments: [
            { id: 'a1', mimeType: 'image/png', sizeBytes: 10, file: 'a1.png' },
            { id: 'a2', mimeType: 'image/png', sizeBytes: 10, file: '../thoat.png' },
            { id: 'a3', mimeType: 'image/png', file: 'a3.png' },
            'khong-phai-object',
          ],
          createdAt: '2026-11-12T00:00:00.000Z',
        },
      ],
    }),
    'utf8',
  );
  const store = new GroupChatStore(file);
  const [msg] = store.listMessages('g1');
  assert.equal(msg.text, 'có ảnh hỏng');
  assert.deepEqual(
    (msg.attachments ?? []).map((a) => a.id),
    ['a1'],
    'chỉ entry đủ shape được giữ',
  );
});

test('GroupChatStore: store chỉ-trong-bộ-nhớ vẫn save/read được ảnh', () => {
  const store = new GroupChatStore();
  const group = store.createGroup('Nhóm tạm');
  const ref = store.saveAttachment(PNG_ATT);
  assert.equal(store.readAttachment(ref)?.data, PNG_1X1);
  const m = store.postMessage({ groupId: group.id, botName: 'Bạn', text: '', attachments: [ref] });
  assert.equal(m.attachments?.length, 1);
  assert.equal(store.listMessages(group.id)[0].attachments?.[0].id, ref.id);
});

async function makeCoordinator(dataDir, recordPathB) {
  const coordinator = new AgentCoordinator({ dataDir, emit: () => {} });
  const mkBot = async (id, name, reply, extraProvider = {}) => {
    const ws = path.join(dataDir, 'ws', id);
    fs.mkdirSync(ws, { recursive: true });
    await coordinator.createBot({
      bot: { id, name, providerId: 'mock', model: 'mock', systemPrompt: 'test', workspaceDir: ws, autoApprove: true },
      provider: { id: 'mock', label: 'Mock', defaultModel: 'mock', mockResponses: [{ text: reply }], ...extraProvider },
    });
  };
  await mkBot('bot-a', 'Bot A', 'A trả lời');
  // v0.94c: Bot Bê là mock CÓ vision (mockSupportsVision) + ghi lại
  // mọi request (mockRecordPath) để kiểm chứng ảnh tới được provider.
  await mkBot('bot-b', 'Bot Bê', 'B trả lời: đã xem ảnh', {
    mockSupportsVision: true,
    ...(recordPathB ? { mockRecordPath: recordPathB } : {}),
  });
  return coordinator;
}

test('coordinator: post ảnh-only + @mention → delegation run nhận đúng bytes ảnh', async () => {
  const dataDir = makeTempDir('open-bot-v094-groupcoord-');
  const recordPathB = path.join(dataDir, 'mock-record-bot-b.jsonl');
  const coordinator = await makeCoordinator(dataDir, recordPathB);
  try {
    const { group } = coordinator.createGroupChat({ name: 'Nhóm ảnh', botIds: ['bot-a', 'bot-b'] });

    // Không text, không ảnh → lỗi rõ.
    await assert.rejects(
      () => coordinator.postGroupMessage({ groupId: group.id, text: '   ' }),
      /không rỗng hoặc ảnh đính kèm/,
    );
    // MIME không hỗ trợ → lỗi rõ, không ghi message.
    await assert.rejects(
      () =>
        coordinator.postGroupMessage({
          groupId: group.id,
          text: 'xem này',
          attachments: [{ mimeType: 'image/bmp', data: PNG_1X1 }],
        }),
      /không hỗ trợ/,
    );
    assert.equal(coordinator.listGroupMessages({ groupId: group.id }).messages.length, 0);
    // Quá 5 ảnh → lỗi rõ.
    await assert.rejects(
      () =>
        coordinator.postGroupMessage({
          groupId: group.id,
          text: 'nhiều ảnh',
          attachments: Array.from({ length: 6 }, () => ({ ...PNG_ATT })),
        }),
      /tối đa 5 ảnh/,
    );

    // Ảnh-only + @mention Bot Bê: message ghi được, delegation trả lời.
    const sent = await coordinator.postGroupMessage({
      groupId: group.id,
      text: '',
      attachments: [{ ...PNG_ATT }],
    });
    assert.equal(sent.message.text, '');
    assert.equal(sent.message.attachments?.length, 1);
    assert.equal(sent.message.attachments?.[0].mimeType, 'image/png');
    assert.deepEqual(sent.replies, [], 'không mention thì không delegation');

    const delegated = await coordinator.postGroupMessage({
      groupId: group.id,
      text: '@Bot Bê xem ảnh này',
      attachments: [{ ...PNG_ATT, name: 'anh-mention.png' }],
    });
    assert.deepEqual(delegated.message.mentions, ['bot-b']);
    assert.equal(delegated.replies.length, 1);
    assert.equal(delegated.replies[0].text, 'B trả lời: đã xem ảnh');

    // Bằng chứng mạnh nhất: request mock provider của Bot Bê nhận được
    // có đúng tin user kèm ảnh (bytes gốc) — tức ảnh đã đi qua
    // postGroupMessage → run() → loop → provider.
    const lines = fs.readFileSync(recordPathB, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1, 'delegation chạy đúng 1 lượt provider');
    const req = JSON.parse(lines[0]);
    const userMsg = req.messages.find((m) => m.role === 'user');
    assert.ok(userMsg, 'request phải có tin user');
    assert.equal(userMsg.attachments?.length, 1);
    assert.equal(userMsg.attachments[0].mimeType, 'image/png');
    assert.equal(userMsg.attachments[0].data, PNG_1X1);
    assert.equal(userMsg.attachments[0].name, 'anh-mention.png');

    // getGroupAttachment đọc lại bytes của ảnh trong message gốc.
    const att = delegated.message.attachments[0];
    const { attachment } = coordinator.getGroupAttachment({
      groupId: group.id,
      messageId: delegated.message.id,
      attachmentId: att.id,
    });
    assert.equal(attachment.mimeType, 'image/png');
    assert.equal(attachment.data, PNG_1X1);
    assert.equal(attachment.name, 'anh-mention.png');
    // Id lạ thì lỗi rõ.
    assert.throws(
      () => coordinator.getGroupAttachment({ groupId: group.id, messageId: 'nope', attachmentId: att.id }),
      /Không thấy message/,
    );
    assert.throws(
      () =>
        coordinator.getGroupAttachment({
          groupId: group.id,
          messageId: delegated.message.id,
          attachmentId: 'nope',
        }),
      /Không thấy ảnh/,
    );
  } finally {
    coordinator.shutdown();
  }
});

test('coordinator: bot không vision được @mention kèm ảnh → từ chối thân thiện, provider không bị gọi', async () => {
  const dataDir = makeTempDir('open-bot-v094-groupnovision-');
  const recordPathA = path.join(dataDir, 'mock-record-bot-a.jsonl');
  const coordinator = new AgentCoordinator({ dataDir, emit: () => {} });
  try {
    const ws = path.join(dataDir, 'ws', 'bot-a');
    fs.mkdirSync(ws, { recursive: true });
    await coordinator.createBot({
      bot: { id: 'bot-a', name: 'Bot A', providerId: 'mock', model: 'mock', systemPrompt: 'test', workspaceDir: ws, autoApprove: true },
      provider: { id: 'mock', label: 'Mock', defaultModel: 'mock', mockResponses: [{ text: 'A trả lời' }], mockRecordPath: recordPathA },
    });
    const { group } = coordinator.createGroupChat({ name: 'Nhóm', botIds: ['bot-a'] });
    const delegated = await coordinator.postGroupMessage({
      groupId: group.id,
      text: '@Bot A xem ảnh này',
      attachments: [{ ...PNG_ATT }],
    });
    assert.equal(delegated.replies.length, 1);
    assert.match(delegated.replies[0].text, /chưa xem được ảnh|không xem được ảnh/);
    assert.equal(fs.existsSync(recordPathA), false, 'provider không vision thì không được gọi');
  } finally {
    coordinator.shutdown();
  }
});

test('coordinator: ảnh nhóm bền vững qua restart (tham chiếu + bytes)', async () => {
  const dataDir = makeTempDir('open-bot-v094-grouppersist-');
  let groupId;
  let messageId;
  let attachmentId;
  const first = await makeCoordinator(dataDir);
  try {
    groupId = first.createGroupChat({ name: 'Nhóm bền', botIds: ['bot-a'] }).group.id;
    const sent = await first.postGroupMessage({
      groupId,
      text: 'ảnh bền',
      attachments: [{ ...PNG_ATT }],
    });
    messageId = sent.message.id;
    attachmentId = sent.message.attachments[0].id;
  } finally {
    first.shutdown();
  }
  const second = new AgentCoordinator({ dataDir, emit: () => {} });
  try {
    const { messages } = second.listGroupMessages({ groupId });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, messageId);
    assert.equal(messages[0].attachments?.length, 1);
    const { attachment } = second.getGroupAttachment({ groupId, messageId, attachmentId });
    assert.equal(attachment.data, PNG_1X1, 'bytes ảnh còn đủ sau restart');
  } finally {
    second.shutdown();
  }
});
