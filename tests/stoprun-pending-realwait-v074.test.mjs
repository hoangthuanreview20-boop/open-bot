/**
 * stoprun-pending-realwait-v074.test.mjs — v0.74a follow-up: chờ THẬT
 * qua cửa sổ pending-stop của `pendingStopByRunId`.
 *
 * Test v0.74a gốc (`tests/stoprun-pending-v074.test.mjs`) chỉ chứng
 * minh stop-trước-run có hiệu lực khi run tới NGAY sau stop — nó
 * không chứng minh được cửa sổ 30s là thời gian thật (một
 * implementation ghi nhớ "mãi mãi" cũng qua test đó). Test này dùng
 * cửa sổ ngắn qua `CoordinatorOptions.pendingStopWindowMs` (mặc
 * định 30s, production không đổi) và chờ thật bằng `setTimeout`:
 *
 *   - stop → chờ thật 2s (vẫn trong cửa sổ 3s) → run mang id đó
 *     PHẢI dừng ngay (provider delay 5s, run kết thúc < 2s).
 *   - stop → chờ thật 1.6s (đã qua cửa sổ 1.2s) → run mang id đó
 *     PHẢI chạy bình thường (stop đã hết hạn, không giết run muộn).
 *
 * Tổng thời gian chờ thật ~3.6s + overhead — không làm suite chậm
 * quá ~10s cho file này. Không mock `Date.now`, không giả thời gian.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/stoprun-pending-realwait-v074.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { AgentCoordinator } from '../packages/core/dist/coordinator/coordinator.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmpDirs = [];
function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-stoprun-realwait-v074-'));
  tmpDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

function mockProvider(text, extra = {}) {
  return { id: 'mock', label: 'Mock', mockResponses: [{ text, ...extra }] };
}

async function createMockBot(coordinator, id, text, extra = {}) {
  await coordinator.createBot({
    bot: botConfig(id, tmpWorkspace()),
    provider: mockProvider(text, extra),
  });
}

test('stop ghi nhớ VẪN hiệu lực sau khi chờ thật 2s (trong cửa sổ 3s)', async () => {
  const coordinator = new AgentCoordinator({
    toolFactory: () => [],
    pendingStopWindowMs: 3000,
  });
  await createMockBot(
    coordinator,
    'bot-realwait-inside',
    'CÂU TRẢ LỜI ĐẦY ĐỦ (stop đã mất)',
    { delayMs: 5000 },
  );
  const runId = randomUUID();
  const stopped = coordinator.stopRun({ runId });
  assert.equal(stopped.stopped, false);
  assert.match(stopped.reason ?? '', /ghi lại/);

  // Chờ THẬT 2s — không mock thời gian: nếu implementation chỉ ghi
  // nhớ "tới lượt run kế tiếp bất kể thời gian" thì test này vẫn qua,
  // nhưng test hết-hạn bên dưới sẽ bắt nó (xem test thứ hai).
  await sleep(2000);

  const t0 = Date.now();
  const result = await coordinator.run({
    botId: 'bot-realwait-inside',
    text: 'câu hỏi tới sau 2s chờ thật',
    runId,
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2000, `run phải dừng ngay sau stop (<2s), thực tế ${elapsed}ms`);
  assert.equal(result.stopped, true, 'stop trong cửa sổ phải dừng run dù đã chờ thật 2s');
  assert.match(result.text ?? '', /Đã dừng/);
  await coordinator.destroyBot({ botId: 'bot-realwait-inside' });
});

test('stop HẾT HẠN sau khi chờ thật qua cửa sổ 1.2s — run muộn chạy bình thường', async () => {
  const coordinator = new AgentCoordinator({
    toolFactory: () => [],
    pendingStopWindowMs: 1200,
  });
  await createMockBot(coordinator, 'bot-realwait-expired', 'trả lời bình thường');
  const runId = randomUUID();
  const stopped = coordinator.stopRun({ runId });
  assert.equal(stopped.stopped, false);

  // Chờ THẬT 1.6s > cửa sổ 1.2s: stop phải hết hạn. Một implementation
  // ghi nhớ mãi mãi (không kiểm tra thời gian thật) sẽ dừng run này
  // và FAIL ở assert bên dưới — đó chính là điều test này bắt.
  await sleep(1600);

  const result = await coordinator.run({
    botId: 'bot-realwait-expired',
    text: 'chào bạn',
    runId,
  });
  assert.equal(result.stopped, false, 'stop đã hết hạn sau 1.6s thì không được giết run');
  assert.equal(result.text, 'trả lời bình thường');
  await coordinator.destroyBot({ botId: 'bot-realwait-expired' });
});

test('pendingStopWindowMs không hợp lệ rơi về mặc định 30s (không throw)', async () => {
  const coordinator = new AgentCoordinator({
    toolFactory: () => [],
    pendingStopWindowMs: 0,
  });
  await createMockBot(coordinator, 'bot-realwait-default', 'trả lời bình thường');
  // Cửa sổ mặc định 30s: stop rồi chạy ngay vẫn phải dừng (chứng minh
  // giá trị 0 không biến cửa sổ thành 0 — nếu thành 0 thì run này
  // đã chạy bình thường).
  const runId = randomUUID();
  await coordinator.stopRun({ runId });
  const result = await coordinator.run({
    botId: 'bot-realwait-default',
    text: 'chào',
    runId,
  });
  assert.equal(result.stopped, true, 'window 0 phải rơi về 30s mặc định, stop vẫn hiệu lực');
  await coordinator.destroyBot({ botId: 'bot-realwait-default' });
});
