/**
 * AG-UI runtime integration tests (v0.97, Team T3).
 *
 * - The agent loop emits AG-UI events through an AgUiRuntimeEmitter
 *   (run lifecycle, text stream, tool call start/end/result) for an
 *   API provider, and emits nothing for provider `mock` (the emitter
 *   is inactive there — the v0.96 regression rule: a default-on
 *   feature must exempt mock + CLI).
 * - The coordinator creates emitters only for non-exempt providers
 *   and answers generative-UI components through the registry + bus
 *   (RPC `answerAgUiComponent` shape).
 * - A failing run still emits RUN_ERROR + RUN_FINISHED (failed).
 *
 * No network, no Ollama, no real provider: scripted providers only.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/agui-runtime-v097.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AgentRunner } from '../packages/core/dist/agent/loop.js';
import {
  AgUiEventBus,
  AgUiRuntimeEmitter,
  AgentCoordinator,
} from '../packages/core/dist/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-agui-runtime-'));
}

function scriptedProvider(id, responses) {
  let i = 0;
  return {
    id,
    label: id,
    async chat() {
      const r = responses[Math.min(i++, responses.length - 1)];
      return { text: r.text ?? '', toolCalls: r.toolCalls ?? [], usage: r.usage };
    },
    async listModels() {
      return [id];
    },
  };
}

function makeTool() {
  return {
    definition: {
      name: 'echo_tool',
      description: 'Echo tool for testing.',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
    },
    needsApproval: false,
    async execute(args) {
      return `echo:${args?.text ?? ''}`;
    },
  };
}

function makeEvents() {
  return {
    onText() {},
    onToolCall() {},
    onToolResult() {},
    onApprovalNeeded: async () => true,
  };
}

function makeBot(dir, providerId) {
  return {
    id: 'bot-1',
    name: 'Test',
    providerId,
    model: providerId,
    systemPrompt: 'You are a test bot.',
    workspaceDir: dir,
    autoApprove: true,
  };
}

function runLoop({ providerId, responses, tools = [makeTool()] }) {
  const dir = tmpDir();
  const bus = new AgUiEventBus();
  const seen = [];
  bus.subscribe({}, (event) => seen.push(event));
  const emitter = new AgUiRuntimeEmitter({
    bus,
    runId: 'run-1',
    botId: 'bot-1',
    providerId,
    model: providerId,
  });
  const runner = new AgentRunner(scriptedProvider(providerId, responses), tools, {
    bot: makeBot(dir, providerId),
    events: makeEvents(),
    agUiEmitter: emitter,
  });
  return { runner, bus, seen, emitter };
}

test('agui loop: API provider run emits the full AG-UI sequence', async () => {
  const { runner, seen } = runLoop({
    providerId: 'openai',
    responses: [
      { text: '', toolCalls: [{ id: 'c1', name: 'echo_tool', args: { text: 'hi' } }] },
      { text: 'done', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } },
    ],
  });
  const text = await runner.run('do the thing');
  assert.equal(text, 'done');
  const types = seen.map((e) => e.type);
  assert.equal(types[0], 'RUN_STARTED');
  assert.ok(types.includes('TEXT_MESSAGE_START'));
  assert.ok(types.includes('TEXT_MESSAGE_CONTENT'));
  assert.ok(types.includes('TEXT_MESSAGE_END'));
  assert.ok(types.includes('TOOL_CALL_START'));
  assert.ok(types.includes('TOOL_CALL_ARGS'));
  assert.ok(types.includes('TOOL_CALL_END'));
  assert.ok(types.includes('TOOL_CALL_RESULT'));
  assert.equal(types[types.length - 2], 'RUN_FINISHED');
  const started = seen.find((e) => e.type === 'RUN_STARTED');
  assert.equal(started.data.providerId, 'openai');
  assert.equal(started.data.title, 'do the thing');
  const args = seen.find((e) => e.type === 'TOOL_CALL_ARGS');
  assert.equal(args.data.toolName, 'echo_tool');
  assert.deepEqual(args.data.argKeys, ['text']);
  const result = seen.find((e) => e.type === 'TOOL_CALL_RESULT');
  assert.equal(result.data.ok, true);
  assert.match(result.data.outputPreview, /echo:hi/);
  const finished = seen.find((e) => e.type === 'RUN_FINISHED');
  assert.equal(finished.data.status, 'completed');
  assert.equal(finished.data.toolCalls, 1);
  assert.equal(finished.data.tokensUsed, 15);
  // State snapshots exist and the store-free bus replay works.
  assert.ok(seen.some((e) => e.type === 'STATE_SNAPSHOT'));
  assert.ok(seen.every((e) => typeof e.sequence === 'number'));
});

test('agui loop: mock provider run emits no AG-UI events (exemption)', async () => {
  const { runner, seen, emitter } = runLoop({
    providerId: 'mock',
    responses: [{ text: 'mock answer', toolCalls: [] }],
  });
  assert.equal(emitter.active, false);
  const text = await runner.run('hello');
  assert.equal(text, 'mock answer');
  assert.equal(seen.length, 0, 'mock runs must not publish AG-UI events');
});

test('agui loop: CLI provider run emits no AG-UI events (exemption)', async () => {
  const { runner, seen, emitter } = runLoop({
    providerId: 'claude-code',
    responses: [{ text: 'cli answer', toolCalls: [] }],
  });
  assert.equal(emitter.active, false);
  const text = await runner.run('hello');
  assert.equal(text, 'cli answer');
  assert.equal(seen.length, 0, 'CLI runs stream through the harness bus, not AG-UI');
});

test('agui loop: a run without an emitter behaves exactly as before', async () => {
  const dir = tmpDir();
  const runner = new AgentRunner(
    scriptedProvider('openai', [{ text: 'plain', toolCalls: [] }]),
    [],
    { bot: makeBot(dir, 'openai'), events: makeEvents() },
  );
  assert.equal(await runner.run('hello'), 'plain');
});

test('agui loop: provider error emits RUN_ERROR then RUN_FINISHED failed', async () => {
  const dir = tmpDir();
  const bus = new AgUiEventBus();
  const seen = [];
  bus.subscribe({}, (event) => seen.push(event));
  const emitter = new AgUiRuntimeEmitter({ bus, runId: 'run-err', botId: 'bot-1', providerId: 'openai' });
  const failing = {
    id: 'openai',
    label: 'openai',
    async chat() {
      throw new Error('provider exploded');
    },
    async listModels() {
      return ['openai'];
    },
  };
  const runner = new AgentRunner(failing, [], {
    bot: makeBot(dir, 'openai'),
    events: makeEvents(),
    agUiEmitter: emitter,
  });
  await assert.rejects(() => runner.run('hello'), /provider exploded/);
  const error = seen.find((e) => e.type === 'RUN_ERROR');
  assert.ok(error, 'RUN_ERROR must be emitted');
  assert.match(error.data.message, /provider exploded/);
  const finished = seen.find((e) => e.type === 'RUN_FINISHED');
  assert.equal(finished.data.status, 'failed');
});

test('agui coordinator: createAgUiEmitter returns null for mock/CLI, an emitter for API', () => {
  const coordinator = new AgentCoordinator({});
  assert.equal(
    coordinator.createAgUiEmitter({ runId: 'r1', botId: 'b1', providerId: 'mock' }),
    null,
  );
  assert.equal(
    coordinator.createAgUiEmitter({ runId: 'r1', botId: 'b1', providerId: 'codex' }),
    null,
  );
  const emitter = coordinator.createAgUiEmitter({
    runId: 'r1',
    botId: 'b1',
    providerId: 'gemini',
    model: 'gemini-2.5-flash',
  });
  assert.ok(emitter, 'API provider gets an emitter');
  assert.equal(emitter.active, true);
  const silent = coordinator.createAgUiEmitter({
    runId: 'r2',
    botId: 'b1',
    providerId: 'openai',
    silent: true,
  });
  assert.ok(silent, 'silent runs still get an emitter object');
  assert.equal(silent.active, false, 'but it never publishes');
  assert.equal(coordinator.getAgUiStats().published, 0);
});

test('agui coordinator: answering a generative-UI component publishes the response', () => {
  const coordinator = new AgentCoordinator({});
  const bus = coordinator.getAgUiBus();
  const seen = [];
  bus.subscribe({}, (event) => seen.push(event));
  const emitter = coordinator.createAgUiEmitter({ runId: 'run-1', botId: 'bot-1', providerId: 'openai' });
  const componentId = emitter.requestGenerativeUi({
    kind: 'confirm',
    title: 'Delete the file?',
    props: { summary: 'Deletes report.txt.' },
    blocking: true,
  });
  assert.ok(componentId);
  assert.equal(coordinator.getAgUiPendingComponents('run-1').length, 1);
  const answered = coordinator.answerAgUiComponent(componentId, { confirmed: true }, 'confirm');
  assert.equal(answered, true);
  assert.equal(coordinator.getAgUiPendingComponents('run-1').length, 0);
  assert.equal(coordinator.answerAgUiComponent(componentId, { confirmed: true }), false, 'no double answer');
  assert.equal(coordinator.answerAgUiComponent('missing', {}), false);
  const response = seen.find((e) => e.type === 'GENERATIVE_UI_RESPONSE');
  assert.ok(response, 'the answer is published on the bus for SSE clients');
  assert.equal(response.data.componentId, componentId);
  // RPC params-object shape (what the stdio dispatch calls).
  const decided = coordinator.decideAgUiComponent({
    componentId: 'also-missing',
    response: {},
  });
  assert.equal(decided.found, false);
  assert.throws(
    () => coordinator.decideAgUiComponent({ componentId: '', response: {} }),
    /componentId/,
  );
});

test('agui coordinator: bus replay + run state round-trip through the coordinator', () => {
  const coordinator = new AgentCoordinator({});
  const emitter = coordinator.createAgUiEmitter({ runId: 'run-1', botId: 'bot-1', providerId: 'ollama' });
  emitter.runStarted({ title: 'state test' });
  emitter.publishStateDelta([{ op: 'set', path: 'progress.current', value: 2 }]);
  const replayed = coordinator.replayAgUiEvents('run-1', 0);
  assert.ok(replayed.length >= 2);
  assert.ok(replayed.every((e) => e.runId === 'run-1'));
  const state = coordinator.getAgUiRunState('run-1');
  assert.equal(state?.state.status, 'running');
  assert.equal(state?.state.progress.current, 2);
  assert.equal(coordinator.getAgUiRunState('run-unknown'), undefined);
});
