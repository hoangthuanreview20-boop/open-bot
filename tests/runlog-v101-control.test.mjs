/**
 * Test v1.01 (Đội T1): pause/resume/fork — RunPauseGate + control.
 *
 * - Gate mở: waitIfPaused trả về ngay. Gate đóng: waitIfPaused treo
 *   tới khi resume; abort thì reject RunGateAbortedError.
 * - pause/resume qua store: ghi đúng event `run.paused`/`run.resumed`,
 *   gọi hai lần không đổi trạng thái lần 2 (changed=false).
 * - fork: run con có started riêng (parentRunId + forkFromSeq),
 *   prefix sao chép đủ, `run.forked` ở cả hai phía, verify cả hai
 *   run đều ok, replay con tới điểm fork cho cùng prompt/tool call
 *   với cha.
 * - fork sai: run cha không tồn tại / seq ngoài khoảng / child đã
 *   tồn tại → throw.
 *
 * Chỉ test thuần (không mạng). Build core trước:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/runlog-v101-control.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RunLogStore } from '../packages/core/dist/event-log/store.js';
import {
  RunControlRegistry,
  RunGateAbortedError,
  RunPauseGate,
  forkRun,
  pauseRun,
  resumeRun,
} from '../packages/core/dist/event-log/control.js';
import { foldEvents } from '../packages/core/dist/event-log/replay.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-runlog-control-'));
}

function seedParent(store, runId = 'run-parent') {
  store.append(runId, { type: 'run.started', payload: { botId: 'bot-1' } });
  store.append(runId, { type: 'run.prompt', payload: { text: 'làm việc A' } });
  store.append(runId, {
    type: 'model.response',
    payload: { step: 0, text: 'ok', toolCalls: [{ callId: 'c1', tool: 'echo', argKeys: [] }] },
  });
  store.append(runId, { type: 'tool.call', payload: { callId: 'c1', tool: 'echo', argKeys: [], step: 0 } });
  store.append(runId, {
    type: 'tool.result',
    payload: { callId: 'c1', tool: 'echo', status: 'ok', outputPreview: 'echo', durationMs: 1, step: 0 },
  });
  return store.readRun(runId).events;
}

test('gate: mở thì wait trả về ngay, đóng thì treo tới khi resume', async () => {
  const gate = new RunPauseGate('run-1');
  assert.equal(gate.isPaused, false);
  await gate.waitIfPaused(); // Không treo.
  gate.pause();
  assert.equal(gate.isPaused, true);
  let released = false;
  const waiting = gate.waitIfPaused().then(() => {
    released = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(released, false); // Vẫn treo khi chưa resume.
  gate.resume();
  await waiting;
  assert.equal(released, true);
  assert.equal(gate.isPaused, false);
});

test('gate: pause hai lần / resume khi đang chạy đều no-op, abort reject waiter', async () => {
  const gate = new RunPauseGate('run-1');
  gate.pause();
  gate.pause();
  assert.equal(gate.isPaused, true);
  gate.resume();
  gate.resume();
  assert.equal(gate.isPaused, false);

  gate.pause();
  const waiting = gate.waitIfPaused();
  gate.abort();
  assert.equal(gate.isAborted, true);
  await assert.rejects(waiting, (err) => err instanceof RunGateAbortedError);
  // Abort rồi thì wait mới cũng reject ngay.
  await assert.rejects(gate.waitIfPaused(), (err) => err instanceof RunGateAbortedError);
});

test('registry: getOrCreate trả cùng gate, remove xoá', () => {
  const registry = new RunControlRegistry();
  const a = registry.getOrCreate('run-1');
  assert.equal(registry.getOrCreate('run-1'), a);
  assert.equal(registry.size, 1);
  registry.remove('run-1');
  assert.equal(registry.get('run-1'), undefined);
  assert.equal(registry.size, 0);
});

test('pauseRun/resumeRun: ghi event + đóng/mở gate, lần 2 changed=false', () => {
  const store = new RunLogStore({ logDir: path.join(tmpDir(), 'run-logs') });
  const registry = new RunControlRegistry();
  const gate = registry.getOrCreate('run-1');
  store.append('run-1', { type: 'run.started', payload: { botId: 'bot-1' } });
  const p1 = pauseRun(store, registry, 'run-1', { step: 0, reason: 'user bấm pause' });
  assert.equal(p1.changed, true);
  assert.equal(gate.isPaused, true);
  const p2 = pauseRun(store, registry, 'run-1', { step: 0 });
  assert.equal(p2.changed, false);
  const r1 = resumeRun(store, registry, 'run-1', { step: 0 });
  assert.equal(r1.changed, true);
  assert.equal(gate.isPaused, false);
  const r2 = resumeRun(store, registry, 'run-1', { step: 0 });
  assert.equal(r2.changed, false);
  const events = store.readRun('run-1').events;
  assert.deepEqual(events.map((e) => e.type), [
    'run.started',
    'run.paused',
    'run.paused',
    'run.resumed',
    'run.resumed',
  ]);
  assert.equal(store.meta('run-1').status, 'running');
  assert.equal(store.verify('run-1').ok, true);
});

test('forkRun: con kế thừa prefix, forked ở cả hai phía, verify ok', () => {
  const store = new RunLogStore({ logDir: path.join(tmpDir(), 'run-logs') });
  seedParent(store);
  const result = forkRun(store, 'run-parent', { childRunId: 'run-child' });
  assert.equal(result.parentRunId, 'run-parent');
  assert.equal(result.childRunId, 'run-child');
  assert.equal(result.forkFromSeq, 5);
  assert.equal(result.copiedEvents, 4); // prompt, model.response, tool.call, tool.result (trừ started + forked)

  const child = store.readRun('run-child').events;
  assert.deepEqual(child.map((e) => e.type), [
    'run.started',
    'run.prompt',
    'model.response',
    'tool.call',
    'tool.result',
    'run.forked',
  ]);
  assert.equal(child[0].payload.parentRunId, 'run-parent');
  assert.equal(child[0].payload.forkFromSeq, 5);
  assert.equal(child[5].payload.side, 'child');
  assert.equal(child[5].payload.otherRunId, 'run-parent');
  assert.equal(store.verify('run-child').ok, true);

  const parent = store.readRun('run-parent').events;
  assert.equal(parent[parent.length - 1].type, 'run.forked');
  assert.equal(parent[parent.length - 1].payload.side, 'parent');
  assert.equal(parent[parent.length - 1].payload.otherRunId, 'run-child');
  assert.equal(store.verify('run-parent').ok, true);

  // Replay con tới điểm fork cho cùng prompt + tool call với cha.
  const childState = foldEvents('run-child', child);
  const parentState = foldEvents('run-parent', parent.slice(0, 5));
  assert.equal(childState.prompt, parentState.prompt);
  assert.deepEqual(childState.toolCalls, parentState.toolCalls);
});

test('forkRun: fork giữa chừng chỉ sao chép tới seq chỉ định', () => {
  const store = new RunLogStore({ logDir: path.join(tmpDir(), 'run-logs') });
  seedParent(store);
  const result = forkRun(store, 'run-parent', { childRunId: 'run-child-mid', fromSeq: 2 });
  assert.equal(result.forkFromSeq, 2);
  assert.equal(result.copiedEvents, 1); // chỉ prompt (seq 2), trừ started
  const child = store.readRun('run-child-mid').events;
  assert.deepEqual(child.map((e) => e.type), ['run.started', 'run.prompt', 'run.forked']);
  assert.equal(store.verify('run-child-mid').ok, true);
});

test('forkRun: lỗi khi cha không có log / seq ngoài khoảng / con đã tồn tại', () => {
  const store = new RunLogStore({ logDir: path.join(tmpDir(), 'run-logs') });
  assert.throws(() => forkRun(store, 'run-khong-co'), /chưa có event/);
  seedParent(store);
  assert.throws(() => forkRun(store, 'run-parent', { fromSeq: 99 }), /ngoài khoảng/);
  assert.throws(() => forkRun(store, 'run-parent', { fromSeq: -1 }), /ngoài khoảng/);
  forkRun(store, 'run-parent', { childRunId: 'run-child' });
  assert.throws(() => forkRun(store, 'run-parent', { childRunId: 'run-child' }), /đã tồn tại/);
});
