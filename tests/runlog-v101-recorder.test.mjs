/**
 * Test v1.01 (Đội T1): RunLogRecorder — API cao cấp + suy luận event phụ.
 *
 * - Ghi đủ vòng đời: started → prompt → model.response → tool.call →
 *   tool.result → completed; meta đúng số liệu.
 * - Tool ghi file + ok → tự suy ra `file.change` (path từ args).
 * - Tool build + lỗi → tự suy ra `compile.error` (dòng lỗi đầu tiên).
 * - Secret trong prompt/output/tool args KHÔNG vào log: key secret →
 *   '<redacted>', `sk-…` → redact, tool args chỉ giữ tên key.
 * - complete/fail/abort: chỉ lần đầu có hiệu lực, ghi đúng event kết thúc.
 * - record() không throw khi store lỗi (droppedEvents tăng).
 * - pause/resume qua recorder đóng/mở gate.
 *
 * Chỉ test thuần (không mạng). Build core trước:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/runlog-v101-recorder.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RunLogStore } from '../packages/core/dist/event-log/store.js';
import { RunLogRecorder } from '../packages/core/dist/event-log/recorder.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-runlog-recorder-'));
}

function makeRecorder(runId = 'run-1') {
  const dir = tmpDir();
  const store = new RunLogStore({ logDir: path.join(dir, 'run-logs') });
  const recorder = new RunLogRecorder({ runId, botId: 'bot-1', store, model: 'm', maxSteps: 5 });
  return { dir, store, recorder };
}

test('recorder: vòng đời đầy đủ, meta đúng số liệu', () => {
  const { store, recorder } = makeRecorder();
  recorder.recordPrompt('viết file a.txt');
  recorder.recordModelResponse({
    step: 0,
    text: 'đang viết',
    toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'a.txt', content: 'hello' } }],
    inputTokens: 10,
    outputTokens: 5,
  });
  recorder.recordToolCall({ callId: 'c1', tool: 'write_file', args: { path: 'a.txt' }, step: 0, path: 'a.txt' });
  recorder.recordToolResult({ callId: 'c1', tool: 'write_file', status: 'ok', output: 'Wrote a.txt', step: 0 });
  recorder.complete('xong');
  const events = store.readRun('run-1').events;
  assert.deepEqual(events.map((e) => e.type), [
    'run.started',
    'run.prompt',
    'model.response',
    'tool.call',
    'tool.result',
    'file.change',
    'run.completed',
  ]);
  const meta = store.meta('run-1');
  assert.equal(meta.status, 'completed');
  assert.equal(meta.toolCalls, 1);
  assert.equal(meta.fileChanges, 1);
  const completed = events[events.length - 1];
  assert.equal(completed.payload.steps, 1);
  assert.equal(completed.payload.toolCalls, 1);
  assert.equal(completed.payload.tokensUsed, 15);
  assert.equal(store.verify('run-1').ok, true);
});

test('recorder: tool ghi file suy ra file.change với đúng path + kind', () => {
  const { store, recorder } = makeRecorder();
  recorder.recordToolCall({ callId: 'c1', tool: 'edit_file', args: { path: 'b.ts' }, step: 0, path: 'b.ts' });
  recorder.recordToolResult({ callId: 'c1', tool: 'edit_file', status: 'ok', output: 'ok', step: 0 });
  recorder.recordToolCall({ callId: 'c2', tool: 'delete_file', args: { path: 'c.txt' }, step: 0, path: 'c.txt' });
  recorder.recordToolResult({ callId: 'c2', tool: 'delete_file', status: 'ok', output: 'ok', step: 0 });
  const changes = store.queryRun('run-1', { types: ['file.change'] }).events;
  assert.equal(changes.length, 2);
  assert.equal(changes[0].payload.kind, 'edit');
  assert.equal(changes[0].payload.path, 'b.ts');
  assert.equal(changes[1].payload.kind, 'delete');
  assert.equal(changes[1].payload.path, 'c.txt');
});

test('recorder: tool build lỗi suy ra compile.error với dòng lỗi đầu tiên', () => {
  const { store, recorder } = makeRecorder();
  recorder.recordToolCall({ callId: 'c1', tool: 'run_command', args: { command: 'npm run build' }, step: 0 });
  recorder.recordToolResult({
    callId: 'c1',
    tool: 'run_command',
    status: 'error',
    output: 'src/a.ts(3,5): error TS2322: Type sai\nsrc/b.ts(1,1): error TS2307: không tìm thấy module\n',
    step: 0,
  });
  const errors = store.queryRun('run-1', { types: ['compile.error'] }).events;
  assert.equal(errors.length, 1);
  assert.equal(errors[0].payload.firstError, 'src/a.ts(3,5): error TS2322: Type sai');
  assert.equal(errors[0].payload.errorCount, 2);
});

test('recorder: tool không phải build/file thì không suy ra event phụ', () => {
  const { store, recorder } = makeRecorder();
  recorder.recordToolCall({ callId: 'c1', tool: 'echo_tool', args: { text: 'hi' }, step: 0 });
  recorder.recordToolResult({ callId: 'c1', tool: 'echo_tool', status: 'error', output: 'lỗi gì đó', step: 0 });
  assert.equal(store.queryRun('run-1', { types: ['file.change'] }).total, 0);
  assert.equal(store.queryRun('run-1', { types: ['compile.error'] }).total, 0);
});

test('recorder: secret không vào log — prompt, output, key args đều redact', () => {
  const { store, recorder } = makeRecorder();
  recorder.recordPrompt('dùng key sk-abcdefgh12345678 để gọi API, password=hunter2');
  recorder.recordModelResponse({
    step: 0,
    text: 'token là Bearer abcdefghij123456',
    toolCalls: [{ id: 'c1', name: 'some_tool', args: { apiKey: 'sk-secret-value', query: 'x' } }],
  });
  recorder.recordToolCall({ callId: 'c1', tool: 'some_tool', args: { apiKey: 'sk-secret-value', query: 'x' }, step: 0 });
  recorder.recordToolResult({ callId: 'c1', tool: 'some_tool', status: 'ok', output: 'apiKey: sk-xyz123456789', step: 0 });
  const jsonl = store.exportJsonl('run-1');
  assert.ok(!jsonl.includes('sk-abcdefgh12345678'), 'key trong prompt phải bị redact');
  assert.ok(!jsonl.includes('hunter2'), 'password trong prompt phải bị redact');
  assert.ok(!jsonl.includes('sk-secret-value'), 'value của tool args không bao giờ vào log');
  assert.ok(!jsonl.includes('abcdefghij123456'), 'Bearer token phải bị redact');
  assert.ok(!jsonl.includes('sk-xyz123456789'), 'key trong output phải bị redact');
  assert.ok(jsonl.includes('<redacted>'), 'phải có marker redact');
  // Tên key args vẫn được giữ (chỉ value bị bỏ).
  const modelEvent = store.queryRun('run-1', { types: ['model.response'] }).events[0];
  assert.deepEqual(modelEvent.payload.toolCalls[0].argKeys, ['apiKey', 'query']);
});

test('recorder: complete/fail/abort chỉ lần đầu có hiệu lực', () => {
  const { store, recorder } = makeRecorder();
  recorder.complete('xong');
  recorder.fail('lỗi muộn');
  recorder.abort('huỷ muộn');
  const ends = store.queryRun('run-1', { types: ['run.completed', 'run.failed', 'run.aborted'] }).events;
  assert.equal(ends.length, 1);
  assert.equal(ends[0].type, 'run.completed');
  assert.equal(recorder.isEnded, true);

  const second = makeRecorder('run-2');
  second.recorder.fail('lỗi thật');
  second.recorder.complete('xong muộn');
  const ends2 = second.store.queryRun('run-2', { types: ['run.completed', 'run.failed', 'run.aborted'] }).events;
  assert.equal(ends2.length, 1);
  assert.equal(ends2[0].type, 'run.failed');
  assert.equal(ends2[0].payload.message, 'lỗi thật');
});

test('recorder: record() không throw khi store lỗi — droppedEvents tăng', () => {
  const dir = tmpDir();
  const store = new RunLogStore({ logDir: path.join(dir, 'run-logs') });
  const recorder = new RunLogRecorder({ runId: 'run-1', botId: 'bot-1', store });
  // Phá store: xoá thư mục log giữa chừng rồi làm nó thành file để append lỗi.
  fs.rmSync(path.join(dir, 'run-logs'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'run-logs'), 'không phải thư mục');
  assert.doesNotThrow(() => recorder.recordPrompt('hello'));
  assert.doesNotThrow(() => recorder.recordModelResponse({ step: 0, text: 'x', toolCalls: [] }));
  assert.ok(recorder.droppedEvents >= 2);
});

test('recorder: key đếm token (tokensUsed/inputTokens/outputTokens) không bị redact', () => {
  const { store, recorder } = makeRecorder();
  recorder.recordModelResponse({ step: 0, text: 'x', toolCalls: [], inputTokens: 7, outputTokens: 3 });
  recorder.complete('xong');
  const completed = store.queryRun('run-1', { types: ['run.completed'] }).events[0];
  assert.equal(completed.payload.tokensUsed, 10);
  const model = store.queryRun('run-1', { types: ['model.response'] }).events[0];
  assert.equal(model.payload.inputTokens, 7);
  assert.equal(model.payload.outputTokens, 3);
});

test('recorder: pause/resume qua recorder đóng/mở gate', async () => {
  const { store, recorder } = makeRecorder();
  const gate = recorder.pauseGate;
  recorder.pause('test pause');
  assert.equal(gate.isPaused, true);
  let released = false;
  const waiting = gate.waitIfPaused().then(() => {
    released = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(released, false);
  recorder.resume('test resume');
  await waiting;
  assert.equal(released, true);
  const types = store.readRun('run-1').events.map((e) => e.type);
  assert.ok(types.includes('run.paused'));
  assert.ok(types.includes('run.resumed'));
});

test('recorder: asLoopSink ghi event qua sink, gate chờ pause', async () => {
  const { store, recorder } = makeRecorder();
  const { sink, gate } = recorder.asLoopSink();
  assert.equal(sink.runId, 'run-1');
  sink.record('run.prompt', { text: 'qua sink' });
  assert.equal(store.queryRun('run-1', { types: ['run.prompt'] }).total, 1);
  assert.doesNotThrow(() => sink.record('model.response', { step: 0, text: 'x', toolCalls: [] }));
  gate.pause();
  let released = false;
  const waiting = gate.waitIfPaused().then(() => {
    released = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(released, false);
  gate.resume();
  await waiting;
  assert.equal(released, true);
});
