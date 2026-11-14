/**
 * Test v1.01 (Đội T1): tích hợp AgentRunner ↔ event-sourced run log.
 *
 * - Chạy một turn thật qua AgentRunner (provider scripted, tool thật):
 *   run log ghi đủ run.started → run.prompt → model.response →
 *   tool.call → tool.result (+ file.change suy ra) → run.completed,
 *   verify hash chain ok, replay cho đúng trạng thái.
 * - Tool ghi file: loop trích path từ args → recorder suy ra file.change.
 * - Tool build lỗi: loop ghi tool.result error → recorder suy ra compile.error.
 * - Pause giữa chừng: đóng gate sau step 1 (qua hook onText), run treo
 *   ở biên step 2 tới khi resume rồi chạy tiếp và hoàn thành.
 * - Không có runLogSink: loop chạy y như cũ, không lỗi.
 *
 * Chỉ test thuần (không mạng, provider scripted). Build core trước:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/runlog-v101-loop.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AgentRunner } from '../packages/core/dist/agent/loop.js';
import { RunLogStore } from '../packages/core/dist/event-log/store.js';
import { RunLogRecorder } from '../packages/core/dist/event-log/recorder.js';
import { foldEvents } from '../packages/core/dist/event-log/replay.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-runlog-loop-'));
}

function scriptedProvider(responses) {
  let i = 0;
  return {
    id: 'test-provider',
    label: 'test-provider',
    async chat() {
      const r = responses[Math.min(i++, responses.length - 1)];
      return { text: r.text ?? '', toolCalls: r.toolCalls ?? [], usage: r.usage };
    },
    async listModels() {
      return ['test-provider'];
    },
  };
}

function makeBot(dir) {
  return {
    id: 'bot-1',
    name: 'Test',
    providerId: 'test-provider',
    model: 'test-provider',
    systemPrompt: 'You are a test bot.',
    workspaceDir: dir,
    autoApprove: true,
  };
}

function makeEvents(hooks = {}) {
  return {
    onText: hooks.onText ?? (() => {}),
    onToolCall() {},
    onToolResult() {},
    onApprovalNeeded: async () => true,
  };
}

function writeFileTool() {
  return {
    definition: {
      name: 'write_file',
      description: 'Write a file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
    needsApproval: false,
    async execute(args) {
      return `Wrote ${args?.path ?? ''}`;
    },
  };
}

function buildTool() {
  return {
    definition: {
      name: 'run_command',
      description: 'Run a command.',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
    },
    needsApproval: false,
    async execute() {
      return 'src/a.ts(1,1): error TS2322: Type sai';
    },
  };
}

test('loop: turn đầy đủ ghi đủ event vào run log, verify ok, replay đúng', async () => {
  const dir = tmpDir();
  const store = new RunLogStore({ logDir: path.join(dir, 'run-logs') });
  const recorder = new RunLogRecorder({ runId: 'run-1', botId: 'bot-1', store, model: 'test-provider' });
  const { sink, gate } = recorder.asLoopSink();
  const runner = new AgentRunner(
    scriptedProvider([
      {
        text: 'Tôi sẽ tạo file.',
        toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'hello.txt' } }],
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      { text: 'Xong rồi.', toolCalls: [] },
    ]),
    [writeFileTool()],
    { bot: makeBot(dir), events: makeEvents(), runLogSink: sink, runLogGate: gate, runId: 'run-1' },
  );
  const text = await runner.run('tạo file hello.txt giúp tôi');
  assert.equal(text, 'Xong rồi.');
  recorder.complete(text);

  const events = store.readRun('run-1').events;
  // Lưu ý: `checkpoint.saved` chỉ ghi khi runner có cả memory + runId
  // (như coordinator truyền); test này không truyền memory nên không có.
  assert.deepEqual(events.map((e) => e.type), [
    'run.started',
    'run.prompt',
    'model.response',
    'tool.call',
    'tool.result',
    'file.change',
    'model.response',
    'run.completed',
  ]);
  assert.equal(store.verify('run-1').ok, true);
  const prompt = events.find((e) => e.type === 'run.prompt');
  assert.equal(prompt.payload.text, 'tạo file hello.txt giúp tôi');
  const modelResponse = events.find((e) => e.type === 'model.response');
  assert.equal(modelResponse.payload.toolCalls[0].tool, 'write_file');
  assert.deepEqual(modelResponse.payload.toolCalls[0].argKeys, ['path']);
  assert.equal(modelResponse.payload.inputTokens, 10);
  const fileChange = events.find((e) => e.type === 'file.change');
  assert.equal(fileChange.payload.path, 'hello.txt');
  assert.equal(fileChange.payload.kind, 'write');
  const state = foldEvents('run-1', events);
  assert.equal(state.status, 'completed');
  assert.equal(state.prompt, 'tạo file hello.txt giúp tôi');
  assert.equal(state.toolCalls.length, 1);
  assert.equal(state.toolCalls[0].status, 'ok');
  assert.equal(state.fileChanges.length, 1);
  assert.equal(state.tokensUsed, 15);
});

test('loop: tool build lỗi → compile.error trong log', async () => {
  const dir = tmpDir();
  const store = new RunLogStore({ logDir: path.join(dir, 'run-logs') });
  const recorder = new RunLogRecorder({ runId: 'run-1', botId: 'bot-1', store });
  const { sink, gate } = recorder.asLoopSink();
  // Tool build trả output lỗi nhưng ok=false: giả lập bằng execute ném lỗi
  // (loop biến thành ToolResult ok=false).
  const failingBuild = {
    definition: {
      name: 'run_command',
      description: 'Run a command.',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
    },
    needsApproval: false,
    async execute() {
      throw new Error('src/a.ts(1,1): error TS2322: Type sai');
    },
  };
  const runner = new AgentRunner(
    scriptedProvider([
      {
        text: '',
        toolCalls: [{ id: 'c1', name: 'run_command', args: { command: 'npm run build' } }],
      },
      { text: 'Build lỗi rồi.', toolCalls: [] },
    ]),
    [failingBuild],
    { bot: makeBot(dir), events: makeEvents(), runLogSink: sink, runLogGate: gate, runId: 'run-1' },
  );
  const text = await runner.run('build thử');
  assert.equal(text, 'Build lỗi rồi.');
  recorder.complete(text);
  const errors = store.queryRun('run-1', { types: ['compile.error'] }).events;
  assert.equal(errors.length, 1);
  assert.ok(errors[0].payload.firstError.includes('TS2322'));
  const results = store.queryRun('run-1', { types: ['tool.result'] }).events;
  assert.equal(results[0].payload.status, 'error');
});

test('loop: pause giữa chừng treo run ở biên step, resume chạy tiếp', async () => {
  const dir = tmpDir();
  const store = new RunLogStore({ logDir: path.join(dir, 'run-logs') });
  const recorder = new RunLogRecorder({ runId: 'run-1', botId: 'bot-1', store });
  const { sink, gate } = recorder.asLoopSink();
  let textCalls = 0;
  const events = makeEvents({
    onText: () => {
      textCalls += 1;
      // Sau text của step 1 thì pause: step 2 phải treo ở gate.
      // Step 1 phải có tool call để loop đi tiếp sang step 2 (text-only
      // mà không có tool call thì turn kết thúc ngay ở step 1).
      if (textCalls === 1) recorder.pause('test pause giữa chừng');
    },
  });
  const echoTool = {
    definition: {
      name: 'echo_tool',
      description: 'Echo.',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
    },
    needsApproval: false,
    async execute(args) {
      return `echo:${args?.text ?? ''}`;
    },
  };
  const runner = new AgentRunner(
    scriptedProvider([
      {
        text: 'Bước một xong.',
        toolCalls: [{ id: 'c1', name: 'echo_tool', args: { text: '1' } }],
      },
      { text: 'Bước hai xong.', toolCalls: [] },
    ]),
    [echoTool],
    { bot: makeBot(dir), events, runLogSink: sink, runLogGate: gate, runId: 'run-1' },
  );
  const runPromise = runner.run('đếm hai bước');
  // Chờ một chút: run phải đang treo (chưa xong) vì gate đóng.
  await new Promise((r) => setTimeout(r, 150));
  let finished = false;
  void runPromise.then(() => {
    finished = true;
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(finished, false, 'run phải treo ở gate khi đang pause');
  assert.equal(textCalls, 1, 'chỉ step 1 chạy trước khi pause');
  recorder.resume('test resume');
  const text = await runPromise;
  assert.equal(text, 'Bước hai xong.');
  assert.equal(textCalls, 2);
  recorder.complete(text);
  const types = store.readRun('run-1').events.map((e) => e.type);
  assert.ok(types.includes('run.paused'));
  assert.ok(types.includes('run.resumed'));
  assert.ok(types.includes('run.completed'));
  assert.equal(store.verify('run-1').ok, true);
});

test('loop: không có runLogSink thì chạy y như cũ', async () => {
  const dir = tmpDir();
  const runner = new AgentRunner(
    scriptedProvider([{ text: 'chào', toolCalls: [] }]),
    [],
    { bot: makeBot(dir), events: makeEvents() },
  );
  const text = await runner.run('chào');
  assert.equal(text, 'chào');
});

test('loop: sink throw cũng không làm hỏng run', async () => {
  const dir = tmpDir();
  const throwingSink = {
    runId: 'run-1',
    record() {
      throw new Error('sink hỏng');
    },
  };
  const runner = new AgentRunner(
    scriptedProvider([{ text: 'vẫn chạy', toolCalls: [] }]),
    [],
    { bot: makeBot(dir), events: makeEvents(), runLogSink: throwingSink },
  );
  const text = await runner.run('chào');
  assert.equal(text, 'vẫn chạy');
});
