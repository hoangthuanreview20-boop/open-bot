/**
 * Test v1.01 (Đội T1): replay engine — fold event → trạng thái run,
 * deterministic replay + digest.
 *
 * - fold tái tạo đúng prompt, transcript, tool call + kết quả, file
 *   change, compile error, số step/token, trạng thái cuối.
 * - Hai lần replay cùng log → cùng digest; replay lần 2 với digest
 *   của lần 1 → ok.
 * - Log khác nhau một ký tự → digest khác.
 * - replayDeterministically gọi đúng handler theo từng loại event,
 *   theo đúng thứ tự seq.
 * - Event type lạ (log phiên bản mới hơn) bị bỏ qua, fold vẫn chạy.
 *
 * Chỉ test thuần (không mạng). Build core trước:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/runlog-v101-replay.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RunLogStore } from '../packages/core/dist/event-log/store.js';
import { foldEvents, replayDeterministically, replayMatches } from '../packages/core/dist/event-log/replay.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-runlog-replay-'));
}

/** Log mẫu của một run hoàn chỉnh (ghi qua store để có hash chain thật). */
function seedFullRun() {
  const dir = tmpDir();
  const store = new RunLogStore({ logDir: path.join(dir, 'run-logs') });
  const runId = 'run-1';
  store.append(runId, { type: 'run.started', payload: { botId: 'bot-1', model: 'm', maxSteps: 5 } });
  store.append(runId, { type: 'run.prompt', payload: { text: 'viết file hello.txt' } });
  store.append(runId, {
    type: 'model.response',
    payload: {
      step: 0,
      text: 'Tôi sẽ tạo file.',
      toolCalls: [{ callId: 'c1', tool: 'write_file', argKeys: ['path'] }],
      inputTokens: 100,
      outputTokens: 20,
    },
  });
  store.append(runId, { type: 'tool.call', payload: { callId: 'c1', tool: 'write_file', argKeys: ['path'], step: 0, path: 'hello.txt' } });
  store.append(runId, {
    type: 'tool.result',
    payload: { callId: 'c1', tool: 'write_file', status: 'ok', outputPreview: 'Wrote hello.txt', durationMs: 12, step: 0 },
  });
  // Recorder suy ra file.change — ở đây ghi tay để test fold độc lập với recorder.
  store.append(runId, { type: 'file.change', payload: { kind: 'write', path: 'hello.txt', tool: 'write_file', callId: 'c1' } });
  store.append(runId, {
    type: 'model.response',
    payload: { step: 1, text: 'Xong rồi.', toolCalls: [], inputTokens: 50, outputTokens: 10 },
  });
  store.append(runId, { type: 'run.completed', payload: { finalText: 'Xong rồi.', steps: 2, toolCalls: 1, tokensUsed: 180, durationMs: 100 } });
  return { store, events: store.readRun(runId).events, runId };
}

test('fold: tái tạo đúng trạng thái run hoàn chỉnh', () => {
  const { events, runId } = seedFullRun();
  const state = foldEvents(runId, events);
  assert.equal(state.status, 'completed');
  assert.equal(state.botId, 'bot-1');
  assert.equal(state.prompt, 'viết file hello.txt');
  assert.equal(state.steps, 2);
  assert.equal(state.tokensUsed, 180);
  assert.equal(state.toolCalls.length, 1);
  assert.equal(state.toolCalls[0].tool, 'write_file');
  assert.equal(state.toolCalls[0].status, 'ok');
  assert.equal(state.toolCalls[0].outputPreview, 'Wrote hello.txt');
  assert.equal(state.fileChanges.length, 1);
  assert.equal(state.fileChanges[0].path, 'hello.txt');
  assert.deepEqual(state.errors, []);
  assert.equal(state.transcript.length, 5); // text, tool_call, tool_result, file_change, text
  assert.equal(state.transcript[0].kind, 'text');
  assert.equal(state.transcript[1].kind, 'tool_call');
  assert.equal(state.transcript[2].kind, 'tool_result');
  assert.equal(state.transcript[3].kind, 'file_change');
  assert.equal(state.transcript[4].kind, 'text');
  assert.match(state.digest, /^[0-9a-f]{64}$/);
  assert.ok(state.startedAt.length > 0);
  assert.ok(state.endedAt !== undefined);
});

test('fold: run lỗi + compile.error được gom vào errors', () => {
  const dir = tmpDir();
  const store = new RunLogStore({ logDir: path.join(dir, 'run-logs') });
  store.append('run-1', { type: 'run.started', payload: { botId: 'bot-1' } });
  store.append('run-1', { type: 'run.prompt', payload: { text: 'build đi' } });
  store.append('run-1', {
    type: 'model.response',
    payload: { step: 0, text: '', toolCalls: [{ callId: 'c1', tool: 'run_command', argKeys: ['command'] }] },
  });
  store.append('run-1', {
    type: 'tool.result',
    payload: { callId: 'c1', tool: 'run_command', status: 'error', outputPreview: 'error TS2322', durationMs: 3, step: 0 },
  });
  store.append('run-1', {
    type: 'compile.error',
    payload: { command: 'tsc', tool: 'run_command', callId: 'c1', firstError: 'error TS2322', errorCount: 1 },
  });
  store.append('run-1', { type: 'run.failed', payload: { message: 'build lỗi', steps: 1, toolCalls: 1, durationMs: 5 } });
  const state = foldEvents('run-1', store.readRun('run-1').events);
  assert.equal(state.status, 'failed');
  assert.equal(state.compileErrors.length, 1);
  assert.equal(state.compileErrors[0].firstError, 'error TS2322');
  assert.equal(state.errors.length, 3); // tool error + compile error + run.failed message
  assert.ok(state.errors.some((e) => e.includes('build lỗi')));
});

test('fold: tool.call trùng callId với model.response không nhân đôi', () => {
  const { events, runId } = seedFullRun();
  const state = foldEvents(runId, events);
  assert.equal(state.toolCalls.length, 1);
});

test('fold: event type lạ bị bỏ qua, fold vẫn chạy', () => {
  const { events, runId } = seedFullRun();
  const weird = [...events, { ...events[0], seq: 99, type: 'future.event', hash: 'x' }];
  const state = foldEvents(runId, weird);
  assert.equal(state.status, 'completed');
});

test('deterministic replay: hai lần cùng log → cùng digest, replayMatches true', () => {
  const { events, runId } = seedFullRun();
  const first = replayDeterministically(runId, events);
  assert.equal(first.ok, true);
  assert.equal(first.eventsReplayed, events.length);
  const second = replayDeterministically(runId, events, {}, first.digest);
  assert.equal(second.ok, true);
  assert.equal(second.digest, first.digest);
  assert.equal(replayMatches(first, second), true);
});

test('deterministic replay: digest sai → ok=false + báo digest', () => {
  const { events, runId } = seedFullRun();
  const bad = replayDeterministically(runId, events, {}, '0'.repeat(64));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /digest khác/);
});

test('deterministic replay: handler được gọi đúng loại + đúng thứ tự seq', () => {
  const { events, runId } = seedFullRun();
  const seen = [];
  const modelResponses = [];
  const toolResults = [];
  const result = replayDeterministically(runId, events, {
    onModelResponse: (e) => modelResponses.push(e.seq),
    onToolResult: (e) => toolResults.push(e.seq),
    onEvent: (e) => seen.push(e.seq),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(modelResponses, [3, 7]);
  assert.deepEqual(toolResults, [5]);
  assert.deepEqual(seen, [1, 2, 4, 6, 8]);
  // Thứ tự toàn cục vẫn là seq tăng dần (handler riêng từng loại).
  const all = [...modelResponses, ...toolResults, ...seen].sort((a, b) => a - b);
  assert.deepEqual(all, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('digest: log khác một ký tự → digest khác', () => {
  const { events, runId } = seedFullRun();
  const a = foldEvents(runId, events);
  const changed = events.map((e) =>
    e.seq === 2 ? { ...e, payload: { ...e.payload, text: 'viết file hello2.txt' } } : e,
  );
  const b = foldEvents(runId, changed);
  assert.notEqual(a.digest, b.digest);
});
