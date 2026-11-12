/**
 * Tests cho v0.79a — trạng thái bot trong group chat (UI parity §7).
 *
 * Covers:
 *  - `GroupBotStatusTracker` (in-memory by default; v0.82 adds an
 *    optional file snapshot — see tests/group-bot-status-v082.test.mjs):
 *    markRunning / markIdle / isRunning / getStatus (chỉ entry running,
 *    sắp theo `since`) / clearGroup + cô lập giữa các nhóm.
 *  - Coordinator RPC `getGroupBotStatus`: nhóm không có thì throw;
 *    lúc rảnh trả `running: []`; GIỮA delegation run (mock provider
 *    delayMs) thì bot được @mention hiện `running`, và sau khi run xong
 *    thì về `[]` (finally gỡ dấu — kể cả khi run lỗi).
 *
 * KHÔNG dùng CLI thật, KHÔNG gọi API ngoài: mock provider + thư mục tạm.
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   xvfb-run -a node --test tests/group-bot-status-v079.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AgentCoordinator,
  GroupBotStatusTracker,
} from '../packages/core/dist/index.js';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('GroupBotStatusTracker: mark/idle/status/clear + cô lập nhóm', () => {
  const tracker = new GroupBotStatusTracker();
  assert.deepEqual(tracker.getStatus('g1'), []);
  assert.equal(tracker.isRunning('g1', 'bot-a'), false);

  tracker.markRunning('g1', 'bot-a');
  assert.equal(tracker.isRunning('g1', 'bot-a'), true);
  assert.equal(tracker.isRunning('g1', 'bot-b'), false);
  assert.equal(tracker.isRunning('g2', 'bot-a'), false);
  const status = tracker.getStatus('g1');
  assert.equal(status.length, 1);
  assert.equal(status[0].botId, 'bot-a');
  assert.equal(status[0].status, 'running');
  assert.ok(!Number.isNaN(Date.parse(status[0].since)), 'since là ISO timestamp');

  // Bot thứ hai cùng nhóm: cả hai đều running, sắp theo `since`.
  tracker.markRunning('g1', 'bot-b');
  assert.equal(tracker.getStatus('g1').length, 2);

  // Idle một bot không ảnh hưởng bot còn lại; idle bot lạ không crash.
  tracker.markIdle('g1', 'bot-a');
  assert.deepEqual(tracker.getStatus('g1').map((e) => e.botId), ['bot-b']);
  tracker.markIdle('g1', 'bot-la');
  assert.equal(tracker.getStatus('g1').length, 1);

  // clearGroup chỉ xoá nhóm đó.
  tracker.markRunning('g2', 'bot-a');
  tracker.clearGroup('g1');
  assert.deepEqual(tracker.getStatus('g1'), []);
  assert.equal(tracker.getStatus('g2').length, 1);

  // markRunning/markIdle với id rỗng là no-op, không crash.
  tracker.markRunning('', 'bot-a');
  tracker.markRunning('g3', '');
  assert.deepEqual(tracker.getStatus('g3'), []);
});

async function makeCoordinator(dataDir, replyDelayMs = 0) {
  const coordinator = new AgentCoordinator({ dataDir, emit: () => {} });
  const mkBot = async (id, name, reply) => {
    const ws = path.join(dataDir, 'ws', id);
    fs.mkdirSync(ws, { recursive: true });
    await coordinator.createBot({
      bot: { id, name, providerId: 'mock', model: 'mock', systemPrompt: 'test', workspaceDir: ws, autoApprove: true },
      provider: { id: 'mock', label: 'Mock', defaultModel: 'mock', mockResponses: [{ text: reply, delayMs: replyDelayMs }] },
    });
  };
  await mkBot('bot-a', 'Bot A', 'A trả lời');
  await mkBot('bot-b', 'Bot Bê', 'B trả lời: đã xong việc');
  return coordinator;
}

test('coordinator getGroupBotStatus: rảnh → []; giữa run → running; xong → []', async () => {
  const dataDir = makeTempDir('open-bot-v079-groupstatus-');
  const coordinator = await makeCoordinator(dataDir, 800);
  try {
    const { group } = coordinator.createGroupChat({ name: 'Nhóm việc', botIds: ['bot-a', 'bot-b'] });

    // Lúc rảnh: không bot nào running, không bot nào bị gián đoạn.
    assert.deepEqual(coordinator.getGroupBotStatus({ groupId: group.id }), {
      groupId: group.id,
      running: [],
      interrupted: [],
    });
    assert.throws(() => coordinator.getGroupBotStatus({ groupId: 'nope' }), /Không thấy nhóm chat/);
    assert.throws(() => coordinator.getGroupBotStatus({}), /cần params/);

    // Bắt đầu delegation cho Bot Bê (mock delay 800ms) mà KHÔNG await:
    // poll trạng thái phải thấy bot-b running trước khi run xong.
    const posting = coordinator.postGroupMessage({ groupId: group.id, text: '@Bot Bê tóm tắt giúp mình' });
    let sawRunning = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const s = coordinator.getGroupBotStatus({ groupId: group.id });
      if (s.running.some((e) => e.botId === 'bot-b' && e.status === 'running')) {
        sawRunning = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(sawRunning, true, 'phải thấy bot-b running giữa delegation run');
    // Bot A không được mention nên không running.
    assert.equal(
      coordinator.getGroupBotStatus({ groupId: group.id }).running.some((e) => e.botId === 'bot-a'),
      false,
    );

    const result = await posting;
    assert.equal(result.replies.length, 1);
    assert.equal(result.replies[0].text, 'B trả lời: đã xong việc');
    // Run xong: trạng thái về rỗng (finally gỡ dấu).
    assert.deepEqual(coordinator.getGroupBotStatus({ groupId: group.id }).running, []);
  } finally {
    coordinator.shutdown();
  }
});

test('coordinator getGroupBotStatus: nhóm bị xoá thì trạng thái cũng hết', async () => {
  const dataDir = makeTempDir('open-bot-v079-groupstatus-del-');
  const coordinator = await makeCoordinator(dataDir);
  try {
    const { group } = coordinator.createGroupChat({ name: 'Nhóm tạm', botIds: ['bot-a'] });
    assert.deepEqual(coordinator.getGroupBotStatus({ groupId: group.id }).running, []);
    coordinator.deleteGroupChat({ groupId: group.id });
    assert.throws(() => coordinator.getGroupBotStatus({ groupId: group.id }), /Không thấy nhóm chat/);
  } finally {
    coordinator.shutdown();
  }
});
