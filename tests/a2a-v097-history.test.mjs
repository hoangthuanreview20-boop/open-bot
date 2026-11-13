/**
 * Test v0.97 (Đội T2): task lifecycle history — bảng chuyển trạng thái
 * hợp lệ + lịch sử transitions + event log.
 *
 * Chỉ test thuần (không mạng).
 *
 * Build core trước khi chạy:
 *   npm run build --workspace=@open-bot/core
 * rồi: node --test tests/a2a-v097-history.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  A2A_LEGAL_TRANSITIONS,
  A2aEventLog,
  appendA2aTransition,
  countA2aStateVisits,
  isLegalA2aTransition,
  makeA2aTransition,
  summarizeA2aTransitions,
} from '../packages/core/dist/a2a/history.js';

test('bảng chuyển hợp lệ: lifecycle chuẩn A2A 1.0', () => {
  assert.deepEqual([...A2A_LEGAL_TRANSITIONS.submitted], ['working', 'cancelled', 'rejected']);
  assert.deepEqual([...A2A_LEGAL_TRANSITIONS.working], [
    'working',
    'input-required',
    'completed',
    'failed',
    'cancelled',
  ]);
  assert.deepEqual([...A2A_LEGAL_TRANSITIONS['input-required']], [
    'working',
    'completed',
    'failed',
    'cancelled',
  ]);
  // Trạng thái cuối không đi đâu được.
  for (const terminal of ['completed', 'failed', 'cancelled', 'rejected']) {
    assert.deepEqual([...A2A_LEGAL_TRANSITIONS[terminal]], [], terminal);
  }
});

test('isLegalA2aTransition: tạo task, tiến độ, trạng thái cuối', () => {
  assert.equal(isLegalA2aTransition(null, 'submitted'), true);
  assert.equal(isLegalA2aTransition(null, 'working'), false);
  assert.equal(isLegalA2aTransition('submitted', 'working'), true);
  assert.equal(isLegalA2aTransition('submitted', 'completed'), false);
  assert.equal(isLegalA2aTransition('working', 'working'), true);
  assert.equal(isLegalA2aTransition('working', 'input-required'), true);
  assert.equal(isLegalA2aTransition('input-required', 'working'), true);
  assert.equal(isLegalA2aTransition('input-required', 'submitted'), false);
  assert.equal(isLegalA2aTransition('completed', 'working'), false);
  assert.equal(isLegalA2aTransition('failed', 'cancelled'), false);
  assert.equal(isLegalA2aTransition('cancelled', 'cancelled'), false);
  assert.equal(isLegalA2aTransition('auth-required', 'rejected'), true);
  assert.equal(isLegalA2aTransition('auth-required', 'completed'), false);
});

test('make/append/summarize: lịch sử đầy đủ, kẹp 50 entry', () => {
  const t0 = makeA2aTransition(null, 'submitted', '2026-11-13T00:00:00.000Z');
  assert.equal(t0.legal, true);
  assert.equal(t0.from, null);
  const tBad = makeA2aTransition('completed', 'working');
  assert.equal(tBad.legal, false);
  let history = appendA2aTransition([], t0);
  history = appendA2aTransition(history, makeA2aTransition('submitted', 'working'));
  history = appendA2aTransition(history, makeA2aTransition('working', 'completed'));
  assert.equal(history.length, 3);
  assert.equal(summarizeA2aTransitions(history), 'submitted → working → completed');
  assert.equal(countA2aStateVisits(history, 'working'), 1);
  assert.equal(countA2aStateVisits(history, 'completed'), 1);
  assert.equal(countA2aStateVisits(history, 'failed'), 0);
  assert.equal(summarizeA2aTransitions([]), '(no transitions recorded)');
  // Kẹp: 60 lần working liên tiếp chỉ giữ 50 mới nhất.
  let long = [];
  for (let i = 0; i < 60; i++) {
    long = appendA2aTransition(long, makeA2aTransition('working', 'working'));
  }
  assert.equal(long.length, 50);
  // append không sửa mảng cũ.
  const before = [t0];
  const after = appendA2aTransition(before, makeA2aTransition('submitted', 'working'));
  assert.equal(before.length, 1);
  assert.equal(after.length, 2);
});

test('A2aEventLog: ring buffer, mới nhất trước, lọc theo task/kind', () => {
  const log = new A2aEventLog(3);
  log.append({ kind: 'task-created', taskId: 't1', state: 'submitted' });
  log.append({ kind: 'state-changed', taskId: 't1', state: 'working' });
  log.append({ kind: 'state-changed', taskId: 't2', state: 'working' });
  log.append({ kind: 'state-changed', taskId: 't1', state: 'completed' });
  assert.equal(log.size, 3);
  const all = log.list();
  assert.equal(all[0].state, 'completed');
  assert.equal(all[1].taskId, 't2');
  // Event cũ nhất (task-created t1) đã bị đẩy ra; event cũ nhất còn
  // lại là state-changed t1 → working.
  assert.equal(all[2].taskId, 't1');
  assert.equal(all[2].state, 'working');
  assert.equal(log.forTask('t1').length, 2);
  assert.equal(log.forTask('t2').length, 1);
  assert.equal(log.byKind('state-changed').length, 3);
  assert.equal(log.byKind('error').length, 0);
  log.clear();
  assert.equal(log.size, 0);
});
