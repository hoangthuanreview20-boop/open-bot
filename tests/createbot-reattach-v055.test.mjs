/**
 * Tests cho v0.55 — createBot idempotent (re-attach) ở coordinator.
 *
 * Main lúc khởi động có thể gọi `createBot` 2 lần cho cùng bot (2 đường
 * `getOrCreateRuntime` chạy song song, đều thấy bot chưa có rồi cùng gọi
 * sang coordinator con) — trước đây lần 2 ném `Bot "<id>" đã tồn tại`
 * (cảnh báo benign nhưng ồn); nay lần 2 trả về handle của bot đã tạo.
 * Hai lần gọi song song thì chờ chung một promise nên chỉ dựng một lần.
 * Tạo lại với cấu hình KHÁC (provider/model/workspace đổi) thì vẫn ném
 * lỗi như cũ — đổi cấu hình phải `destroyBot` trước.
 *
 * Chạy sau khi build core + tools:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/createbot-reattach-v055.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentCoordinator } from '../packages/core/dist/index.js';

const tmpDirs = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function botConfig(id, workspaceDir, extra = {}) {
  return {
    id,
    name: `Bot ${id}`,
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir,
    autoApprove: true,
    ...extra,
  };
}

function mockProvider(text) {
  return { id: 'mock', label: 'Mock', mockResponses: [{ text }] };
}

test('createBot: gọi lại cùng params thì re-attach, không ném, không nhân đôi bot', async () => {
  const ws = tmpDir('open-bot-reattach-');
  const coord = new AgentCoordinator({ dataDir: tmpDir('open-bot-reattach-data-') });
  try {
    const first = await coord.createBot({ bot: botConfig('bot-1', ws), provider: mockProvider('ok') });
    assert.equal(first.botId, 'bot-1');
    const second = await coord.createBot({ bot: botConfig('bot-1', ws), provider: mockProvider('ok') });
    assert.equal(second.botId, 'bot-1');
    assert.equal(second.toolCount, first.toolCount, 're-attach trả đúng số tool của bot đã tạo');
    assert.deepEqual(second.toolNames, first.toolNames);
    assert.deepEqual(coord.listBots().botIds, ['bot-1'], 'chỉ có đúng một bot');
    // Bot re-attach vẫn chạy được như thường.
    const res = await coord.run({ botId: 'bot-1', text: 'chào' });
    assert.equal(res.text, 'ok');
  } finally {
    coord.shutdown();
  }
});

test('createBot: hai lần gọi song song cùng bot thì chỉ dựng một lần', async () => {
  const ws = tmpDir('open-bot-reattach-');
  const coord = new AgentCoordinator({ dataDir: tmpDir('open-bot-reattach-data-') });
  try {
    const [a, b] = await Promise.all([
      coord.createBot({ bot: botConfig('bot-1', ws), provider: mockProvider('ok') }),
      coord.createBot({ bot: botConfig('bot-1', ws), provider: mockProvider('ok') }),
    ]);
    assert.equal(a.botId, 'bot-1');
    assert.equal(b.botId, 'bot-1');
    assert.equal(a.toolCount, b.toolCount);
    assert.deepEqual(coord.listBots().botIds, ['bot-1']);
    const res = await coord.run({ botId: 'bot-1', text: 'chào' });
    assert.equal(res.text, 'ok');
  } finally {
    coord.shutdown();
  }
});

test('createBot: cùng id nhưng model khác thì vẫn ném lỗi (đổi cấu hình phải destroyBot trước)', async () => {
  const ws = tmpDir('open-bot-reattach-');
  const coord = new AgentCoordinator({ dataDir: tmpDir('open-bot-reattach-data-') });
  try {
    await coord.createBot({ bot: botConfig('bot-1', ws), provider: mockProvider('ok') });
    await assert.rejects(
      coord.createBot({
        bot: botConfig('bot-1', ws, { model: 'other-model' }),
        provider: mockProvider('ok'),
      }),
      /đã tồn tại với cấu hình khác/,
    );
    await assert.rejects(
      coord.createBot({
        bot: botConfig('bot-1', tmpDir('open-bot-reattach-')),
        provider: mockProvider('ok'),
      }),
      /đã tồn tại với cấu hình khác/,
    );
    // Bot cũ vẫn nguyên, chạy được.
    assert.deepEqual(coord.listBots().botIds, ['bot-1']);
    const res = await coord.run({ botId: 'bot-1', text: 'chào' });
    assert.equal(res.text, 'ok');
  } finally {
    coord.shutdown();
  }
});

test('createBot: destroyBot rồi tạo lại cùng id vẫn được (không kẹt re-attach)', async () => {
  const ws = tmpDir('open-bot-reattach-');
  const coord = new AgentCoordinator({ dataDir: tmpDir('open-bot-reattach-data-') });
  try {
    await coord.createBot({ bot: botConfig('bot-1', ws), provider: mockProvider('ok') });
    coord.destroyBot({ botId: 'bot-1' });
    assert.deepEqual(coord.listBots().botIds, []);
    const recreated = await coord.createBot({
      bot: botConfig('bot-1', ws, { model: 'other-model' }),
      provider: mockProvider('ok2'),
    });
    assert.equal(recreated.botId, 'bot-1');
    const res = await coord.run({ botId: 'bot-1', text: 'chào' });
    assert.equal(res.text, 'ok2');
  } finally {
    coord.shutdown();
  }
});
