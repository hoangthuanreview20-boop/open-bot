/**
 * Tests cho v0.90c (đội G gói C) — scheduler máy-tính-bot:
 * hàng đợi chờ + thử lại khi rảnh + auto-shed opt-in + bền vững
 * qua restart (packages/core/src/compute/scheduler.ts + runtime.ts).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/computers-scheduler-v090c.test.mjs
 *
 * Runtime dùng thư mục tạm + box thật (nhẹ, như test sóng B); VM
 * không cần image/QEMU ở đây (chỉ mức box). Không CLI/key/mạng thật.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  BotComputerRuntime,
  COMPUTER_AUTO_SHED_AUDIT_ACTION,
  clampPriority,
  emptySchedulerState,
  enqueueRequest,
  fakeMachineProfile,
  parseSchedulerState,
  selectAutoShedCandidates,
  setQueuePriority,
  sortQueueEntries,
  tryPromoteQueue,
} from '../packages/core/dist/index.js';

const GB = 1024 ** 3;
const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-scheduler-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function fakeBackends() {
  return [
    { kind: 'box', level: 'box', available: true, detail: 'box' },
    { kind: 'bwrap', level: 'container', available: false, detail: 'không có bwrap' },
    { kind: 'qemu', level: 'vm', available: true, detail: 'qemu' },
  ];
}

/** Máy nhỏ: chỉ đủ RAM cho đúng 1 box (512MB) — box thứ 2 phải chờ. */
function smallProfile(overrides = {}) {
  return fakeMachineProfile({
    cpu: { logicalCores: 2, physicalCores: 1, loadAvg1m: 0.2, loadPerCore: 0.1 },
    memory: { totalBytes: 2 * GB, freeBytes: Math.floor(1.2 * GB), freeRatio: 0.6 },
    ...overrides,
  });
}

/** Máy bận: tải/core cao (isHostBusy = true). */
function busyProfile() {
  return fakeMachineProfile({
    cpu: { logicalCores: 8, physicalCores: 4, loadAvg1m: 7.2, loadPerCore: 0.9 },
  });
}

// --- Scheduler thuần ---------------------------------------------------------

test('scheduler v0.90c: enqueue dedupe + clamp priority + FIFO trong cùng priority', () => {
  const state = emptySchedulerState();
  const first = enqueueRequest(state, { botId: 'bot-a', level: 'box', priority: 50 }, '2026-11-11T00:00:00.000Z');
  assert.equal(first.enqueuedAt, '2026-11-11T00:00:00.000Z');
  // Enqueue lại cùng bot: cập nhật priority, giữ enqueuedAt cũ.
  const updated = enqueueRequest(state, { botId: 'bot-a', level: 'box', priority: 90 }, '2026-11-11T01:00:00.000Z');
  assert.equal(state.queue.length, 1);
  assert.equal(updated.enqueuedAt, '2026-11-11T00:00:00.000Z');
  assert.equal(updated.priority, 90);
  assert.equal(updated.request.priority, 90);
  // Priority lạ được clamp về 0..100, không phải số -> 50.
  assert.equal(clampPriority(150), 100);
  assert.equal(clampPriority(-5), 0);
  assert.equal(clampPriority(Number.NaN), 50);
  assert.equal(clampPriority('high'), 50);
  // Thứ tự: priority cao trước; cùng priority thì vào trước thử trước.
  enqueueRequest(state, { botId: 'bot-b', level: 'box', priority: 50 }, '2026-11-11T00:00:01.000Z');
  enqueueRequest(state, { botId: 'bot-c', level: 'box', priority: 50 }, '2026-11-11T00:00:02.000Z');
  assert.deepEqual(
    sortQueueEntries(state.queue).map((e) => e.botId),
    ['bot-a', 'bot-b', 'bot-c'],
  );
  assert.equal(setQueuePriority(state, 'bot-c', 95), true);
  assert.deepEqual(
    sortQueueEntries(state.queue).map((e) => e.botId),
    ['bot-c', 'bot-a', 'bot-b'],
  );
  assert.equal(setQueuePriority(state, 'bot-nope', 10), false);
});

test('scheduler v0.90c: parseSchedulerState tolerant — file cũ v1 + entry hỏng', () => {
  assert.deepEqual(parseSchedulerState(null), { queue: [], autoShed: false });
  assert.deepEqual(parseSchedulerState({ version: 1, computers: [] }), { queue: [], autoShed: false });
  const parsed = parseSchedulerState({
    version: 2,
    computers: [],
    autoShed: true,
    queue: [
      { botId: 'ok', request: { botId: 'ok' }, priority: 70, enqueuedAt: '2026-11-11T00:00:00.000Z', reason: 'het cho' },
      { botId: '', priority: 10, enqueuedAt: '2026-11-11T00:00:00.000Z' },
      { botId: 'no-date', priority: 10 },
      'khong-phai-object',
      { botId: 'clamped', priority: 999, enqueuedAt: '2026-11-11T00:00:01.000Z' },
    ],
  });
  assert.equal(parsed.autoShed, true);
  assert.deepEqual(
    parsed.queue.map((e) => [e.botId, e.priority]),
    [
      ['clamped', 100],
      ['ok', 70],
    ],
  );
});

test('scheduler v0.90c: tryPromoteQueue — host bận thì không promote; đủ chỗ thì theo FIFO', () => {
  const backends = fakeBackends();
  const queue = [
    { botId: 'bot-z', request: { botId: 'bot-z', level: 'box', priority: 50 }, priority: 50, enqueuedAt: '2026-11-11T00:00:00.000Z' },
    { botId: 'bot-a', request: { botId: 'bot-a', level: 'box', priority: 50 }, priority: 50, enqueuedAt: '2026-11-11T00:00:01.000Z' },
  ];
  // Host bận: không promote gì cả.
  const busy = tryPromoteQueue(busyProfile(), queue, backends);
  assert.deepEqual(busy.promoted, []);
  assert.deepEqual(
    busy.remaining.map((e) => e.botId),
    ['bot-z', 'bot-a'],
  );
  // Máy nhỏ: chỉ đủ 1 box. bot-z vào trước (FIFO) được cấp dù bot-a
  // có botId nhỏ hơn (planner sắp theo botId) — không được chen lên.
  const small = tryPromoteQueue(smallProfile(), queue, backends);
  assert.deepEqual(
    small.promoted.map((a) => a.botId),
    ['bot-z'],
  );
  assert.deepEqual(
    small.remaining.map((e) => e.botId),
    ['bot-a'],
  );
  // Máy mạnh: cả 2 được cấp.
  const big = tryPromoteQueue(fakeMachineProfile(), queue, backends);
  assert.deepEqual(
    big.promoted.map((a) => a.botId),
    ['bot-z', 'bot-a'],
  );
  assert.deepEqual(big.remaining, []);
});

test('scheduler v0.90c: selectAutoShedCandidates — ưu tiên thấp trước, hoà thì RAM lớn trước', () => {
  const running = [
    { botId: 'high', priority: 90, ramBytes: 4 * GB },
    { botId: 'low-big', priority: 10, ramBytes: 2 * GB },
    { botId: 'low-small', priority: 10, ramBytes: 512 * 1024 ** 2 },
    { botId: 'mid', priority: 50, ramBytes: 1 * GB },
  ];
  assert.deepEqual(selectAutoShedCandidates(running, 1), ['low-big']);
  assert.deepEqual(selectAutoShedCandidates(running, 2), ['low-big', 'low-small']);
  assert.deepEqual(selectAutoShedCandidates(running, 10), ['low-big', 'low-small', 'mid', 'high']);
  assert.deepEqual(selectAutoShedCandidates([], 1), []);
});

// --- Runtime: hàng đợi bền vững + tick ---------------------------------------

test('scheduler v0.90c: runtime — hàng đợi + autoShed bền vững qua restart (computers.json)', () => {
  const rootDir = makeTempDir();
  const runtime = new BotComputerRuntime({ rootDir, backends: fakeBackends() });
  assert.equal(runtime.getAutoShed(), false, 'auto-shed mặc định TẮT');
  runtime.setAutoShed(true);
  assert.equal(runtime.getAutoShed(), true);
  runtime.enqueueComputer({ botId: 'wait-1', level: 'box', priority: 80 }, 'het cho luc tao');
  runtime.enqueueComputer({ botId: 'wait-2', level: 'box', priority: 30 });
  assert.deepEqual(
    runtime.getQueue().map((e) => e.botId),
    ['wait-1', 'wait-2'],
  );
  // Đọc lại từ đĩa: file là version 2, có queue + autoShed.
  const file = JSON.parse(fs.readFileSync(path.join(rootDir, 'computers.json'), 'utf8'));
  assert.equal(file.version, 2);
  assert.equal(file.autoShed, true);
  assert.equal(file.queue.length, 2);
  // Restart: runtime mới đọc lại đúng hàng đợi + cờ.
  const reloaded = new BotComputerRuntime({ rootDir, backends: fakeBackends() });
  assert.equal(reloaded.getAutoShed(), true);
  assert.deepEqual(
    reloaded.getQueue().map((e) => [e.botId, e.priority]),
    [
      ['wait-1', 80],
      ['wait-2', 30],
    ],
  );
  // Bot đã có máy thì enqueue throw (không xếp hàng đợi vô nghĩa).
  reloaded.createComputer({
    botId: 'has-pc',
    level: 'box',
    cpuCores: 0.5,
    ramBytes: 512 * 1024 ** 2,
    diskBytes: 1 * GB,
    backend: 'box',
    backendDetail: 'box',
    priority: 50,
  });
  assert.throws(() => reloaded.enqueueComputer({ botId: 'has-pc', level: 'box' }), /đã có máy-tính-bot/);
  // Đổi priority của entry đang chờ: wait-2 lên 95 thì lên đầu hàng.
  reloaded.setComputerPriority('wait-2', 95);
  assert.deepEqual(
    reloaded.getQueue().map((e) => e.botId),
    ['wait-2', 'wait-1'],
  );
});

test('scheduler v0.90c: runtime tick — promote khi rảnh, chờ khi hết chỗ, tạo lại sau khi máy được xoá', async () => {
  const rootDir = makeTempDir();
  const runtime = new BotComputerRuntime({ rootDir, backends: fakeBackends() });
  runtime.enqueueComputer({ botId: 'bot-z', level: 'box', priority: 50 });
  runtime.enqueueComputer({ botId: 'bot-a', level: 'box', priority: 50 });
  // Máy nhỏ: tick 1 chỉ promote bot-z (FIFO), tạo bản ghi stopped.
  const tick1 = runtime.tickScheduler(smallProfile(), fakeBackends());
  assert.deepEqual(tick1.promoted, ['bot-z']);
  assert.deepEqual(tick1.autoShedPaused, []);
  assert.equal(runtime.getComputer('bot-z')?.state, 'stopped');
  assert.deepEqual(
    runtime.getQueue().map((e) => e.botId),
    ['bot-a'],
  );
  // Tick 2: vẫn hết chỗ (bot-z chiếm RAM) — bot-a ở lại hàng đợi.
  const tick2 = runtime.tickScheduler(smallProfile(), fakeBackends());
  assert.deepEqual(tick2.promoted, []);
  assert.deepEqual(
    runtime.getQueue().map((e) => e.botId),
    ['bot-a'],
  );
  // Xoá máy bot-z rồi tick: bot-a được cấp.
  assert.equal(await runtime.destroyComputer('bot-z'), true);
  const tick3 = runtime.tickScheduler(smallProfile(), fakeBackends());
  assert.deepEqual(tick3.promoted, ['bot-a']);
  assert.deepEqual(runtime.getQueue(), []);
  // Hàng đợi trống + máy rảnh: tick không làm gì.
  const tick4 = runtime.tickScheduler(smallProfile(), fakeBackends());
  assert.deepEqual(tick4, { promoted: [], autoShedPaused: [] });
});

test('scheduler v0.90c: runtime tick — auto-shed TẮT thì không dừng máy; BẬT thì dừng 1 máy ưu tiên thấp nhất + ghi audit', async () => {
  const rootDir = makeTempDir();
  const auditEvents = [];
  const runtime = new BotComputerRuntime({
    rootDir,
    backends: fakeBackends(),
    onAutoShed: (event) => auditEvents.push(event),
  });
  // 2 máy box đang chạy: low (priority 10) + high (priority 90).
  for (const [botId, priority] of [['low', 10], ['high', 90]]) {
    runtime.createComputer({
      botId,
      level: 'box',
      cpuCores: 0.5,
      ramBytes: 512 * 1024 ** 2,
      diskBytes: 1 * GB,
      backend: 'box',
      backendDetail: 'box',
      priority,
    });
    const started = await runtime.startComputer(botId);
    assert.equal(started.state, 'running');
  }
  // Host bận nhưng auto-shed đang TẮT (mặc định): tick không dừng gì.
  const off = runtime.tickScheduler(busyProfile(), fakeBackends());
  assert.deepEqual(off, { promoted: [], autoShedPaused: [] });
  assert.equal(auditEvents.length, 0);
  assert.equal(runtime.getComputer('low')?.state, 'running');
  // Bật auto-shed: tick dừng đúng máy ưu tiên thấp nhất, ghi lý do + audit.
  runtime.setAutoShed(true);
  const on = runtime.tickScheduler(busyProfile(), fakeBackends());
  assert.deepEqual(on.autoShedPaused, ['low']);
  assert.equal(runtime.getComputer('low')?.state, 'paused');
  assert.match(runtime.getComputer('low')?.lastPauseReason ?? '', /Tự giảm tải/);
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0].botId, 'low');
  assert.match(auditEvents[0].reason, /Tự giảm tải/);
  assert.equal(COMPUTER_AUTO_SHED_AUDIT_ACTION, 'computer.auto-shed');
  // Máy high vẫn chạy. Tick tiếp (host vẫn bận): dừng tiếp high (chỉ 1/tick).
  const on2 = runtime.tickScheduler(busyProfile(), fakeBackends());
  assert.deepEqual(on2.autoShedPaused, ['high']);
  assert.equal(auditEvents.length, 2);
  // Resume thì xoá lý do tạm dừng.
  runtime.resumeComputer('low');
  assert.equal(runtime.getComputer('low')?.state, 'running');
  assert.equal(runtime.getComputer('low')?.lastPauseReason, undefined);
  // Host hết bận: tick không shed nữa.
  const calm = runtime.tickScheduler(fakeMachineProfile(), fakeBackends());
  assert.deepEqual(calm.autoShedPaused, []);
});
