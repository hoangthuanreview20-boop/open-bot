/**
 * Test v1.01 (Đội T1): audit trail — query xuyên run + verify toàn bộ.
 *
 * - queryAudit lọc theo bot/type/khoảng thời gian, trả đúng runId/botId.
 * - summarizeAudit đếm đúng theo loại + theo bot + số run chạm tới.
 * - verifyAllRuns: mọi run ok → runsOk đầy đủ; một run bị sửa → báo
 *   đúng run lỗi, các run khác vẫn ok.
 * - replayRunState: tái tạo trạng thái từ log; run không có log → null.
 *
 * Chỉ test thuần (không mạng). Build core trước:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/runlog-v101-audit.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RunLogStore } from '../packages/core/dist/event-log/store.js';
import { RunLogRecorder } from '../packages/core/dist/event-log/recorder.js';
import { queryAudit, replayRunState, summarizeAudit, verifyAllRuns } from '../packages/core/dist/event-log/audit.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-runlog-audit-'));
}

function seedStore() {
  const dir = tmpDir();
  const store = new RunLogStore({ logDir: path.join(dir, 'run-logs') });
  const r1 = new RunLogRecorder({ runId: 'run-1', botId: 'bot-a', store });
  r1.recordPrompt('việc A');
  r1.recordModelResponse({ step: 0, text: 'ok A', toolCalls: [] });
  r1.complete('xong A');
  const r2 = new RunLogRecorder({ runId: 'run-2', botId: 'bot-b', store });
  r2.recordPrompt('việc B');
  r2.recordToolCall({ callId: 'c1', tool: 'run_command', args: { command: 'tsc' }, step: 0 });
  r2.recordToolResult({ callId: 'c1', tool: 'run_command', status: 'error', output: 'error TS1', step: 0 });
  r2.fail('build lỗi');
  const r3 = new RunLogRecorder({ runId: 'run-3', botId: 'bot-a', store });
  r3.recordPrompt('việc C');
  r3.complete('xong C');
  return { dir, store };
}

test('queryAudit: lọc theo bot', () => {
  const { store } = seedStore();
  const onlyA = queryAudit(store, { botId: 'bot-a' });
  assert.ok(onlyA.length > 0);
  assert.ok(onlyA.every((e) => e.botId === 'bot-a'));
  assert.ok(onlyA.every((e) => e.runId === 'run-1' || e.runId === 'run-3'));
  const onlyB = queryAudit(store, { botId: 'bot-b' });
  assert.ok(onlyB.every((e) => e.botId === 'bot-b'));
  assert.ok(onlyB.every((e) => e.runId === 'run-2'));
});

test('queryAudit: lọc theo loại event + giới hạn', () => {
  const { store } = seedStore();
  const prompts = queryAudit(store, { types: ['run.prompt'] });
  assert.equal(prompts.length, 3);
  assert.ok(prompts.every((e) => e.event.type === 'run.prompt'));
  const limited = queryAudit(store, { limit: 2 });
  assert.equal(limited.length, 2);
  // Kết quả theo thứ tự thời gian tăng dần.
  const all = queryAudit(store, {});
  const ats = all.map((e) => e.event.at);
  const sorted = [...ats].sort();
  assert.deepEqual(ats, sorted);
});

test('queryAudit: lọc theo khoảng thời gian', () => {
  // Seed riêng với timestamp tường minh (append trong cùng một
  // mili-giây cho cùng `at`, nên test này không dùng store seed chung).
  const dir = tmpDir();
  const store = new RunLogStore({ logDir: path.join(dir, 'run-logs') });
  const stamps = [
    '2026-11-14T00:00:00.000Z',
    '2026-11-14T00:00:10.000Z',
    '2026-11-14T00:00:20.000Z',
  ];
  stamps.forEach((at, i) => {
    store.append('run-1', { type: 'run.prompt', payload: { text: `p${i}` }, at });
  });
  const all = queryAudit(store, {});
  assert.equal(all.length, 3);
  const mid = stamps[1];
  const fromMid = queryAudit(store, { fromAt: mid });
  assert.equal(fromMid.length, 2);
  assert.ok(fromMid.every((e) => e.event.at >= mid));
  const toMid = queryAudit(store, { toAt: mid });
  assert.equal(toMid.length, 2);
  assert.ok(toMid.every((e) => e.event.at <= mid));
  const window = queryAudit(store, { fromAt: stamps[1], toAt: stamps[1] });
  assert.equal(window.length, 1);
});

test('summarizeAudit: đếm đúng theo loại/bot/run', () => {
  const { store } = seedStore();
  const summary = summarizeAudit(store, {});
  // run-1: started+prompt+model.response+completed = 4; run-2:
  // started+prompt+tool.call+tool.result+compile.error+failed = 6;
  // run-3: started+prompt+completed = 3. Tổng 13.
  assert.equal(summary.totalEvents, 13);
  assert.equal(summary.byType['run.prompt'], 3);
  assert.equal(summary.byType['run.started'], 3);
  assert.equal(summary.byType['compile.error'], 1);
  assert.equal(summary.byType['tool.result'], 1);
  assert.equal(summary.byBot['bot-a'], 7);
  assert.equal(summary.byBot['bot-b'], 6);
  assert.equal(summary.runsTouched, 3);
  assert.ok(summary.earliestAt <= summary.latestAt);
  const onlyFailed = summarizeAudit(store, { status: 'failed' });
  assert.equal(onlyFailed.runsTouched, 1);
  assert.equal(onlyFailed.byBot['bot-b'], 6);
});

test('verifyAllRuns: mọi run ok → runsOk đầy đủ', () => {
  const { store } = seedStore();
  const report = verifyAllRuns(store);
  assert.equal(report.runsChecked, 3);
  assert.equal(report.runsOk, 3);
  assert.equal(report.runsBad, 0);
  assert.deepEqual(report.badRuns, []);
  assert.equal(report.totalEvents, 13);
  assert.equal(report.corruptLines, 0);
});

test('verifyAllRuns: một run bị sửa → báo đúng run đó, run khác vẫn ok', () => {
  const { dir, store } = seedStore();
  const file = store.runFilePath('run-2');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const tampered = JSON.parse(lines[1]);
  tampered.payload.text = 'đã sửa';
  lines[1] = JSON.stringify(tampered);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const fresh = new RunLogStore({ logDir: path.join(dir, 'run-logs') });
  const report = verifyAllRuns(fresh);
  assert.equal(report.runsChecked, 3);
  assert.equal(report.runsOk, 2);
  assert.equal(report.runsBad, 1);
  assert.equal(report.badRuns[0].runId, 'run-2');
  assert.equal(report.badRuns[0].ok, false);
});

test('replayRunState: tái tạo trạng thái từ log; run lạ → null', () => {
  const { store } = seedStore();
  const state = replayRunState(store, 'run-2');
  assert.equal(state.status, 'failed');
  assert.equal(state.prompt, 'việc B');
  assert.equal(state.toolCalls.length, 1);
  assert.equal(state.compileErrors.length, 1);
  assert.equal(replayRunState(store, 'run-khong-co'), null);
});

test('audit trên store rỗng: không lỗi, số 0', () => {
  const store = new RunLogStore({ logDir: path.join(tmpDir(), 'run-logs') });
  assert.deepEqual(queryAudit(store, {}), []);
  const summary = summarizeAudit(store, {});
  assert.equal(summary.totalEvents, 0);
  assert.equal(summary.runsTouched, 0);
  const report = verifyAllRuns(store);
  assert.equal(report.runsChecked, 0);
  assert.equal(report.runsOk, 0);
});
