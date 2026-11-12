/**
 * Tests cho v0.94c — project updates gửi thật (gap 2/2).
 *
 * Trước v0.94c, `project_set_updates` chỉ lưu cờ `updatesEnabled` vào
 * DB — không có kênh gửi nào đọc cờ đó, nên không một cập nhật nào
 * được gửi đi (xem `BotMemory.setProjectUpdates` lúc đó). Sóng này nối
 * kênh gửi thật:
 *  - `project/updates.ts`: `buildProjectDigest` (tóm tắt tiến độ:
 *    số task theo trạng thái + task vừa xong + task còn mở),
 *    `listDueProjectUpdates` (project bật updates + tới hạn 6 giờ),
 *    `markProjectUpdateSent` (ghi `lastUpdateAt`).
 *  - Coordinator RPC `projectUpdatesDue` / `projectUpdatesMarkSent`
 *    (main gọi theo timer 15 phút để gửi thông báo + tin chat).
 *  - Tool `project_set_updates` mô tả đúng kênh gửi thật + trả thời
 *    điểm digest kế tiếp.
 *
 * KHÔNG dùng CLI thật, KHÔNG đọc tài khoản/credential thật, KHÔNG gọi
 * API ngoài: mock provider + thư mục tạm.
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/project-updates-v094.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AgentCoordinator,
  BotMemory,
  PROJECT_UPDATES_INTERVAL_MS,
  buildProjectDigest,
  listDueProjectUpdates,
  markProjectUpdateSent,
  nextProjectDigestAt,
} from '../packages/core/dist/index.js';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-v094-projupd-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeMemory() {
  const dir = makeTempDir();
  const memory = new BotMemory(path.join(dir, 'memory.db'));
  memory.saveBot({
    id: 'bot-1',
    name: 'Bot 1',
    providerId: 'mock',
    model: 'mock',
    systemPrompt: '',
    workspaceDir: dir,
    autoApprove: true,
  });
  return { dir, memory };
}

/** Seed 1 project + 4 task (2 done, 1 pending, 1 in_progress). */
function seedProject(memory, botId = 'bot-1') {
  const projectId = memory.createProject(botId, 'Làm web bán hàng', 'Web cho shop');
  const tag = `project:${projectId}`;
  const t1 = memory.createTask(botId, 'Thiết kế trang chủ', tag);
  const t2 = memory.createTask(botId, 'Viết API giỏ hàng', tag);
  const t3 = memory.createTask(botId, 'Deploy lên VPS', tag);
  const t4 = memory.createTask(botId, 'Viết docs', tag);
  memory.updateTask(t1, 'done');
  memory.updateTask(t2, 'done');
  memory.updateTask(t3, 'in_progress');
  return { projectId, tasks: { t1, t2, t3, t4 } };
}

test('digest: đếm đúng task theo trạng thái + liệt kê task vừa xong / còn mở', () => {
  const { memory } = makeMemory();
  const { projectId } = seedProject(memory);
  const d = buildProjectDigest(memory, 'bot-1', projectId);
  assert.ok(d, 'digest phải có khi project tồn tại');
  assert.equal(d.title, 'Làm web bán hàng');
  assert.deepEqual(d.counts, { total: 4, done: 2, pending: 1, inProgress: 1, cancelled: 0 });
  assert.match(d.digest, /Làm web bán hàng/);
  assert.match(d.digest, /2\/4 task xong/);
  assert.match(d.digest, /Thiết kế trang chủ/);
  assert.match(d.digest, /Viết API giỏ hàng/);
  assert.match(d.digest, /Deploy lên VPS/);
  assert.match(d.summary, /2\/4 task xong/);
  assert.equal(buildProjectDigest(memory, 'bot-1', 'khong-co'), null, 'project lạ → null');
  assert.equal(buildProjectDigest(memory, 'bot-khac', projectId), null, 'bot khác → null');
});

test('digest: project chưa có task vẫn có digest (0 task)', () => {
  const { memory } = makeMemory();
  const projectId = memory.createProject('bot-1', 'Project trống');
  const d = buildProjectDigest(memory, 'bot-1', projectId);
  assert.ok(d);
  assert.deepEqual(d.counts, { total: 0, done: 0, pending: 0, inProgress: 0, cancelled: 0 });
  assert.match(d.digest, /0\/0 task xong/);
});

test('due: chỉ project bật updates mới tới hạn; gửi xong thì hết hạn tới khi đủ 6 giờ', () => {
  assert.equal(PROJECT_UPDATES_INTERVAL_MS, 6 * 60 * 60 * 1000, 'chu kỳ mặc định 6 giờ');
  const { memory } = makeMemory();
  const { projectId } = seedProject(memory);
  const now = new Date('2026-11-12T10:00:00.000Z');
  assert.deepEqual(listDueProjectUpdates(memory, 'bot-1', now), [], 'chưa bật → không tới hạn');
  assert.equal(nextProjectDigestAt(memory.getProject(projectId), now), null, 'chưa bật → không có digest kế tiếp');

  memory.setProjectUpdates(projectId, true);
  const due1 = listDueProjectUpdates(memory, 'bot-1', now);
  assert.equal(due1.length, 1, 'bật + chưa gửi lần nào → tới hạn ngay');
  assert.equal(due1[0].projectId, projectId);
  assert.equal(nextProjectDigestAt(memory.getProject(projectId), now), now.toISOString(), 'chưa gửi → tới hạn ngay');

  assert.equal(markProjectUpdateSent(memory, projectId, now), true);
  assert.equal(memory.getProject(projectId).lastUpdateAt, now.toISOString(), 'ghi dấu lastUpdateAt');
  assert.deepEqual(listDueProjectUpdates(memory, 'bot-1', now), [], 'vừa gửi → chưa tới hạn');
  assert.deepEqual(
    listDueProjectUpdates(memory, 'bot-1', new Date(now.getTime() + 5 * 60 * 60 * 1000)),
    [],
    'sau 5 giờ vẫn chưa tới hạn',
  );
  const dueLater = listDueProjectUpdates(memory, 'bot-1', new Date(now.getTime() + 7 * 60 * 60 * 1000));
  assert.equal(dueLater.length, 1, 'sau 7 giờ → tới hạn lại');
  assert.equal(markProjectUpdateSent(memory, 'khong-co', now), false, 'project lạ → false');
});

test('lastUpdateAt bền vững qua reload memory', () => {
  const { dir, memory } = makeMemory();
  const { projectId } = seedProject(memory);
  memory.setProjectUpdates(projectId, true);
  const at = new Date('2026-11-12T10:00:00.000Z');
  markProjectUpdateSent(memory, projectId, at);
  memory.close?.();
  const reloaded = new BotMemory(path.join(dir, 'memory.db'));
  try {
    const p = reloaded.getProject(projectId);
    assert.equal(p.lastUpdateAt, at.toISOString());
    assert.equal(p.updatesEnabled, true);
    assert.deepEqual(listDueProjectUpdates(reloaded, 'bot-1', at), [], 'reload xong vẫn nhớ vừa gửi');
  } finally {
    reloaded.close?.();
  }
});

test('digest: chỉ liệt kê task xong KỂ TỪ digest trước (không lặp lại)', async () => {
  const { memory } = makeMemory();
  const { projectId, tasks } = seedProject(memory);
  memory.setProjectUpdates(projectId, true);
  // updatedAt có độ phân giải mili-giây: nghỉ 10ms giữa các bước để
  // thứ tự thời gian (xong trước / sau digest) chắc chắn đúng.
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await sleep(10);
  const first = new Date();
  markProjectUpdateSent(memory, projectId, first);
  await sleep(10);
  // Sau digest đầu, xong thêm 1 task nữa.
  memory.updateTask(tasks.t3, 'done');
  const d = buildProjectDigest(memory, 'bot-1', projectId, new Date(first.getTime() + 7 * 60 * 60 * 1000));
  assert.ok(d);
  assert.match(d.digest, /Deploy lên VPS/, 'task xong sau digest trước phải xuất hiện');
  assert.doesNotMatch(d.digest, /Thiết kế trang chủ/, 'task xong TRƯỚC digest trước không lặp lại');
});

async function makeCoordinator(dataDir) {
  const coordinator = new AgentCoordinator({ dataDir, emit: () => {} });
  const ws = path.join(dataDir, 'ws', 'bot-1');
  fs.mkdirSync(ws, { recursive: true });
  await coordinator.createBot({
    bot: { id: 'bot-1', name: 'Bot 1', providerId: 'mock', model: 'mock', systemPrompt: 'test', workspaceDir: ws, autoApprove: true },
    provider: { id: 'mock', label: 'Mock', defaultModel: 'mock', mockResponses: [{ text: 'xong' }] },
  });
  return coordinator;
}

test('coordinator RPC: runTool project_set_updates → due → markSent → hết due', async () => {
  const dataDir = makeTempDir('open-bot-v094-projupdcoord-');
  const coordinator = await makeCoordinator(dataDir);
  try {
    const created = await coordinator.runTool({
      botId: 'bot-1',
      tool: 'project_create',
      args: { title: 'Project RPC', detail: 'kiểm tra kênh gửi' },
    });
    const project = JSON.parse(created.output);
    assert.ok(project.id, 'project_create trả id');
    // Chưa bật → không due.
    assert.deepEqual((await coordinator.projectUpdatesDue()).updates, []);
    // Bật qua tool thật: output phải có nextDigestAt + mô tả kênh gửi.
    const enabled = await coordinator.runTool({
      botId: 'bot-1',
      tool: 'project_set_updates',
      args: { projectId: project.id, enabled: true },
    });
    const enabledJson = JSON.parse(enabled.output);
    assert.equal(enabledJson.updatesEnabled, true);
    assert.ok(enabledJson.nextDigestAt, 'tool trả thời điểm digest kế tiếp');
    assert.doesNotMatch(enabled.output, /chưa có kênh gửi/, 'không còn câu "chưa có kênh gửi"');
    // Due ngay (chưa gửi lần nào) — digest có nội dung thật.
    const due = await coordinator.projectUpdatesDue();
    assert.equal(due.updates.length, 1);
    assert.equal(due.updates[0].projectId, project.id);
    assert.match(due.updates[0].digest, /Project RPC/);
    assert.match(due.updates[0].digest, /0\/0 task xong/);
    assert.ok(due.updates[0].summary.length > 0);
    // Đánh dấu đã gửi → hết due; tắt → vẫn hết due.
    const marked = await coordinator.projectUpdatesMarkSent({ botId: 'bot-1', projectId: project.id });
    assert.equal(marked.marked, true);
    assert.ok(marked.nextDueAt, 'markSent trả nextDueAt');
    assert.deepEqual((await coordinator.projectUpdatesDue()).updates, []);
    await coordinator.runTool({
      botId: 'bot-1',
      tool: 'project_set_updates',
      args: { projectId: project.id, enabled: false },
    });
    assert.deepEqual((await coordinator.projectUpdatesDue()).updates, [], 'tắt thì dừng hẳn');
    // Bot lạ / project lạ → lỗi rõ. (RPC này là hàm sync nên bọc
    // trong arrow async để assert.rejects bắt được throw.)
    await assert.rejects(
      async () => coordinator.projectUpdatesMarkSent({ botId: 'bot-la', projectId: project.id }),
      /Chưa tạo bot/,
    );
    await assert.rejects(
      async () => coordinator.projectUpdatesMarkSent({ botId: 'bot-1', projectId: 'khong-co' }),
      /Không thấy project/,
    );
  } finally {
    coordinator.shutdown();
  }
});
