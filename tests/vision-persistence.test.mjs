/**
 * Vision persistence (v0.65, option B — files + DB reference).
 *
 * Proves, through the REAL storage path (BotMemory on a temp dir:
 * real SQLite + real files, no mocked storage) that an image attached
 * to a user message survives an app reload and renders again:
 *   1. Save a message with attachments → close the store → open a
 *      FRESH BotMemory on the same dir (the reload) → getHistory with
 *      includeAttachments returns the images byte-identical
 *      (mime/name/base64), and the files exist on disk under
 *      `.open-bot/attachments/<messageId>/` while the DB file itself
 *      holds no image bytes at all.
 *   2. Default getHistory (no flag) returns NO attachments — run
 *      context seeding, export and every other reader stay text-only,
 *      so old images are never re-sent to a provider.
 *   3. Backwards compatibility: messages saved without attachments,
 *      and v0.63/v0.64 rows that carry the old "📷 Ảnh đính kèm …"
 *      metadata line in their text, load exactly as before.
 *   4. Fail-closed load: a deleted file, a tampered file (size no
 *      longer matches its row) or an unknown mime comes back as
 *      `{ data: '', unavailable: true }` — metadata intact, no throw.
 *   5. Caps are enforced at the storage boundary (6 images / oversize
 *      image / bad mime / bad base64 all throw) and a failed save
 *      leaves no orphan attachment directory behind.
 *   6. Deleting a thread or a bot's data removes its attachment rows
 *      AND files — no orphan bytes.
 *   7. `selectThreadHistory` strips attachments even when handed
 *      attachment-bearing history (history never reaches a provider).
 *   8. Coordinator RPC round-trip: `saveMessage` /
 *      `getHistory({ includeAttachments: true })` through a real
 *      AgentCoordinator carry the images end to end.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core && node --test tests/vision-persistence.test.mjs
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { BotMemory } from '../packages/core/dist/agent/memory.js';
import { selectThreadHistory } from '../packages/core/dist/agent/threadHistory.js';
import { AgentCoordinator } from '../packages/core/dist/coordinator/coordinator.js';
import {
  VISION_MAX_IMAGE_BYTES,
  VISION_MAX_IMAGES,
} from '../packages/core/dist/agent/vision.js';

const tempDirs = [];
function makeTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-vision-persist-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const PNG_BYTES = Buffer.from('fake-png-bytes-for-persistence-test');
const JPEG_BYTES = Buffer.from('fake-jpeg-bytes-for-persistence-test');
const PNG = { mimeType: 'image/png', data: PNG_BYTES.toString('base64'), name: 'cat.png' };
const JPEG = { mimeType: 'image/jpeg', data: JPEG_BYTES.toString('base64'), name: 'dog.jpg' };

function openMemory(dir, botId = 'bot-vision') {
  const memory = new BotMemory(dir);
  memory.saveBot({
    id: botId,
    name: 'Bot Vision',
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'test',
  });
  return memory;
}

/** Distinct base64 that must never appear in the DB file. */
const MARKER_B64 = Buffer.from('persistence-marker-bytes-xyz').toString('base64');
const MARKER = { mimeType: 'image/png', data: MARKER_B64, name: 'marker.png' };

test('vision persistence: attachments survive a reload byte-identical, DB holds no image bytes', () => {
  const dir = makeTempWorkspace();
  const botId = 'bot-vision';
  const memory = openMemory(dir, botId);
  const thread = memory.createThread(botId);
  const messageId = memory.saveMessage(botId, 'user', 'Trong ảnh có gì?', thread.id, [PNG, JPEG]);
  memory.saveMessage(botId, 'assistant', 'Trong ảnh có một con mèo.', thread.id);
  memory.close();

  // The reload: a FRESH BotMemory on the same directory.
  const reloaded = openMemory(dir, botId);
  try {
    const history = reloaded.getThreadHistory(thread.id, 50, { includeAttachments: true });
    assert.equal(history.length, 2);
    const [user, assistant] = history;
    assert.equal(user.content, 'Trong ảnh có gì?');
    assert.ok(!user.content.includes('Ảnh đính kèm'), 'saved text stays plain (no metadata line)');
    assert.equal(user.attachments?.length, 2);
    assert.deepEqual(user.attachments[0], PNG);
    assert.deepEqual(user.attachments[1], JPEG);
    assert.equal(assistant.attachments, undefined, 'assistant message has no attachments');

    // Files on disk: one dir per message, one file per image.
    const messageDir = path.join(dir, '.open-bot', 'attachments', messageId);
    assert.deepEqual(fs.readFileSync(path.join(messageDir, '0.png')), PNG_BYTES);
    assert.deepEqual(fs.readFileSync(path.join(messageDir, '1.jpg')), JPEG_BYTES);

    // The DB file itself holds no image bytes (neither raw nor base64).
    const dbBytes = fs.readFileSync(path.join(dir, '.open-bot', 'memory.db'));
    assert.ok(!dbBytes.includes(PNG_BYTES), 'DB must not contain raw PNG bytes');
    assert.ok(!dbBytes.includes(Buffer.from(PNG.data, 'base64')), 'DB must not contain PNG bytes');
    assert.ok(!dbBytes.toString('latin1').includes(PNG.data), 'DB must not contain PNG base64');
  } finally {
    reloaded.close();
  }
});

test('vision persistence: default getHistory returns no attachments (run-context invariant)', () => {
  const dir = makeTempWorkspace();
  const botId = 'bot-vision';
  const memory = openMemory(dir, botId);
  const thread = memory.createThread(botId);
  memory.saveMessage(botId, 'user', 'Xem ảnh này', thread.id, [PNG]);
  memory.close();

  const reloaded = openMemory(dir, botId);
  try {
    const history = reloaded.getThreadHistory(thread.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].attachments, undefined);
    const byBot = reloaded.getHistory(botId);
    assert.equal(byBot[0].attachments, undefined);
  } finally {
    reloaded.close();
  }
});

test('vision persistence: old messages load as before (no attachments, legacy metadata line kept)', () => {
  const dir = makeTempWorkspace();
  const botId = 'bot-vision';
  const memory = openMemory(dir, botId);
  const thread = memory.createThread(botId);
  memory.saveMessage(botId, 'user', 'chào bot', thread.id);
  // A v0.63/v0.64 row: the metadata line is part of the saved text.
  memory.saveMessage(
    botId,
    'user',
    'Trong ảnh có gì?\n📷 Ảnh đính kèm: test.png (image/png, 70 B)',
    thread.id,
  );
  memory.close();

  const reloaded = openMemory(dir, botId);
  try {
    const history = reloaded.getThreadHistory(thread.id, 50, { includeAttachments: true });
    assert.equal(history.length, 2);
    assert.equal(history[0].content, 'chào bot');
    assert.equal(history[0].attachments, undefined);
    assert.equal(
      history[1].content,
      'Trong ảnh có gì?\n📷 Ảnh đính kèm: test.png (image/png, 70 B)',
      'legacy metadata line is preserved verbatim',
    );
    assert.equal(history[1].attachments, undefined);
  } finally {
    reloaded.close();
  }
});

test('vision persistence: missing file loads as unavailable (fail-closed, no throw)', () => {
  const dir = makeTempWorkspace();
  const botId = 'bot-vision';
  const memory = openMemory(dir, botId);
  const thread = memory.createThread(botId);
  const messageId = memory.saveMessage(botId, 'user', 'Ảnh này đâu rồi?', thread.id, [PNG]);
  const filePath = path.join(dir, '.open-bot', 'attachments', messageId, '0.png');
  assert.ok(fs.existsSync(filePath));
  fs.rmSync(filePath);
  // Same instance (no reopen): the row is still there, the file is not.
  const history = memory.getThreadHistory(thread.id, 50, { includeAttachments: true });
  assert.equal(history[0].attachments?.length, 1);
  assert.deepEqual(history[0].attachments[0], {
    mimeType: 'image/png',
    name: 'cat.png',
    data: '',
    unavailable: true,
  });
  memory.close();
});

test('vision persistence: tampered file and unknown mime load as unavailable', () => {
  const dir = makeTempWorkspace();
  const botId = 'bot-vision';
  const memory = openMemory(dir, botId);
  const thread = memory.createThread(botId);
  const messageId = memory.saveMessage(botId, 'user', 'Ảnh bị sửa', thread.id, [PNG, JPEG]);
  // Tamper: overwrite the first file with different-size bytes.
  fs.writeFileSync(
    path.join(dir, '.open-bot', 'attachments', messageId, '0.png'),
    Buffer.from('totally different and longer bytes than the png'),
  );
  // Tamper: rewrite the second row's mime to something unknown.
  memory.close();
  const raw = new DatabaseSync(path.join(dir, '.open-bot', 'memory.db'));
  try {
    raw
      .prepare(`UPDATE message_attachments SET mimeType = 'image/bmp' WHERE messageId = ? AND idx = 1`)
      .run(messageId);
  } finally {
    raw.close();
  }
  const reloaded = openMemory(dir, botId);
  try {
    const history = reloaded.getThreadHistory(thread.id, 50, { includeAttachments: true });
    assert.equal(history[0].attachments?.length, 2);
    assert.equal(history[0].attachments[0].unavailable, true);
    assert.equal(history[0].attachments[0].data, '');
    assert.equal(history[0].attachments[0].name, 'cat.png');
    assert.equal(history[0].attachments[1].unavailable, true);
    assert.equal(history[0].attachments[1].data, '');
  } finally {
    reloaded.close();
  }
});

test('vision persistence: caps enforced at save, failed save leaves no orphan dir', () => {
  const dir = makeTempWorkspace();
  const botId = 'bot-vision';
  const memory = openMemory(dir, botId);
  const thread = memory.createThread(botId);
  try {
    const tooMany = Array.from({ length: VISION_MAX_IMAGES + 1 }, (_, i) => ({
      ...PNG,
      name: `img-${i}.png`,
    }));
    assert.throws(
      () => memory.saveMessage(botId, 'user', 'quá nhiều ảnh', thread.id, tooMany),
      /tối đa 5 ảnh/,
    );
    const oversize = {
      mimeType: 'image/png',
      data: Buffer.alloc(VISION_MAX_IMAGE_BYTES + 1).toString('base64'),
      name: 'huge.png',
    };
    assert.throws(
      () => memory.saveMessage(botId, 'user', 'ảnh quá lớn', thread.id, [oversize]),
      /quá lớn/,
    );
    assert.throws(
      () =>
        memory.saveMessage(botId, 'user', 'sai định dạng', thread.id, [
          { mimeType: 'image/svg+xml', data: PNG.data, name: 'x.svg' },
        ]),
      /không hỗ trợ/,
    );
    assert.throws(
      () =>
        memory.saveMessage(botId, 'user', 'base64 hỏng', thread.id, [
          { mimeType: 'image/png', data: '!!!not-base64!!!', name: 'x.png' },
        ]),
      /không phải base64/,
    );
    // Nothing was saved, and no orphan attachment directory exists.
    assert.equal(memory.getThreadHistory(thread.id).length, 0);
    const attachmentsDir = path.join(dir, '.open-bot', 'attachments');
    const leftovers = fs.existsSync(attachmentsDir) ? fs.readdirSync(attachmentsDir) : [];
    assert.deepEqual(leftovers, []);
  } finally {
    memory.close();
  }
});

test('vision persistence: deleteThread and deleteBotData remove attachment rows and files', () => {
  const dir = makeTempWorkspace();
  const botId = 'bot-vision';
  const memory = openMemory(dir, botId);
  const threadA = memory.createThread(botId);
  const threadB = memory.createThread(botId);
  const msgA = memory.saveMessage(botId, 'user', 'thread A', threadA.id, [PNG]);
  memory.saveMessage(botId, 'user', 'thread B', threadB.id, [JPEG]);
  const attachmentsDir = path.join(dir, '.open-bot', 'attachments');
  assert.ok(fs.existsSync(path.join(attachmentsDir, msgA, '0.png')));

  assert.equal(memory.deleteThread(threadA.id), true);
  assert.ok(!fs.existsSync(path.join(attachmentsDir, msgA)), 'thread A files are gone');
  const raw = new DatabaseSync(path.join(dir, '.open-bot', 'memory.db'));
  try {
    assert.equal(
      raw.prepare('SELECT COUNT(*) AS n FROM message_attachments WHERE messageId = ?').get(msgA).n,
      0,
      'thread A rows are gone',
    );
    assert.equal(
      raw.prepare('SELECT COUNT(*) AS n FROM message_attachments').get().n,
      1,
      'thread B row survives',
    );
  } finally {
    raw.close();
  }
  // Thread B's file is still there — deleting the bot removes it too.
  const msgB = memory.getThreadHistory(threadB.id)[0];
  assert.ok(msgB !== undefined);
  const counts = memory.deleteBotData(botId);
  assert.equal(counts.message_attachments, 1);
  assert.deepEqual(fs.existsSync(attachmentsDir) ? fs.readdirSync(attachmentsDir) : [], []);
  memory.close();
});

test('vision persistence: selectThreadHistory strips attachments (history never reaches a provider)', () => {
  const kept = selectThreadHistory(
    [
      { role: 'user', content: 'Xem ảnh này', attachments: [PNG] },
      { role: 'assistant', content: 'Thấy rồi.' },
      { role: 'user', content: 'Còn ảnh này?', attachments: [JPEG] },
    ],
    {},
  );
  assert.equal(kept.length, 3);
  for (const m of kept) assert.equal(m.attachments, undefined);
});

test('vision persistence: coordinator saveMessage/getHistory RPC round-trip', async (t) => {
  const dataDir = makeTempWorkspace();
  const ws = path.join(dataDir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const recordPath = path.join(dataDir, 'mock-record.jsonl');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const coordinator = new AgentCoordinator({ dataDir, emit: () => {} });
  try {
    await coordinator.createBot({
      bot: {
        id: 'bot-vision',
        name: 'Bot Vision',
        providerId: 'mock',
        model: 'mock',
        systemPrompt: 'test',
        workspaceDir: ws,
        autoApprove: true,
      },
      provider: {
        id: 'mock',
        label: 'Mock',
        defaultModel: 'mock',
        mockResponses: [{ text: 'xong' }],
        mockRecordPath: recordPath,
      },
    });
    const { thread } = coordinator.createThread({ botId: 'bot-vision' });
    const saved = coordinator.saveMessage({
      botId: 'bot-vision',
      role: 'user',
      content: 'Trong ảnh có gì?',
      threadId: thread.id,
      attachments: [MARKER],
    });
    assert.ok(saved.id);

    // The file is on disk under the bot workspace, the DB has no bytes.
    const filePath = path.join(ws, '.open-bot', 'attachments', saved.id, '0.png');
    assert.ok(fs.existsSync(filePath), 'attachment file must exist');
    assert.deepEqual(fs.readFileSync(filePath), Buffer.from('persistence-marker-bytes-xyz'));
    const dbBytes = fs.readFileSync(path.join(ws, '.open-bot', 'memory.db'));
    assert.ok(!dbBytes.toString('latin1').includes(MARKER_B64), 'DB must not contain marker base64');

    // Display reload: attachments come back byte-identical.
    const withImages = coordinator.getHistory({
      botId: 'bot-vision',
      limit: 50,
      threadId: thread.id,
      includeAttachments: true,
    });
    assert.equal(withImages.messages.length, 1);
    assert.deepEqual(withImages.messages[0].attachments, [MARKER]);
    // Default: text only.
    const plain = coordinator.getHistory({ botId: 'bot-vision', limit: 50, threadId: thread.id });
    assert.equal(plain.messages[0].attachments, undefined);
    // Same through getThreadHistory.
    const viaThread = coordinator.getThreadHistory({
      threadId: thread.id,
      limit: 50,
      includeAttachments: true,
    });
    assert.deepEqual(viaThread.messages[0].attachments, [MARKER]);

    // Invalid attachments are refused at the RPC boundary (fail-closed).
    assert.throws(
      () =>
        coordinator.saveMessage({
          botId: 'bot-vision',
          role: 'user',
          content: 'bad',
          threadId: thread.id,
          attachments: [{ mimeType: 'image/png', data: '!!!not-base64!!!', name: 'x.png' }],
        }),
      /không phải base64/,
    );
  } finally {
    try {
      coordinator.shutdown();
    } catch {
      // Ignore — the temp dir is removed by t.after either way.
    }
  }
});
