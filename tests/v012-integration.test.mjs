/**
 * Tests for the v0.12 coordinator integration step (nối W4a + W4b + W4c + W4d):
 *   packages/core/src/agent/loop.ts — checkpoint sau mỗi step + resume,
 *     compaction, structured output, interrupt_before (sửa args khi duyệt),
 *     subagent chuyên biệt (runSubagent mở rộng + runSpecializedSubagents).
 *   packages/core/src/agent/workflow-runner.ts — runner thật cho workflow.
 *   packages/core/src/coordinator/coordinator.ts — transfer_to_X (handoff),
 *     run_workflow, delegate_specialized, resume qua run params,
 *     respondApproval kèm args, prune checkpoint sau run.
 *   packages/core/src/index.ts — barrel exports các module v0.12.
 *   Desktop: ApprovalCard sửa được args + IPC respondApproval kèm args.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 *   xvfb-run -a node --test tests/v012-integration.test.mjs
 * Không cần API key thật, không gọi mạng (mock provider + tool giả).
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AgentRunner } from '../packages/core/dist/agent/loop.js';
import { AgentPermissions } from '../packages/core/dist/agent/permissions.js';
import { AgentCoordinator } from '../packages/core/dist/coordinator/coordinator.js';
import { createWorkflowRunner } from '../packages/core/dist/agent/workflow-runner.js';
import { runWorkflow } from '../packages/core/dist/agent/workflow.js';
// Barrel wiring: import này tự fail nếu tên export gõ sai.
import {
  BotMemory,
  contextLimitForModel,
  createHandoff,
  getTriageTemplate,
  listCheckpoints,
  planEditTestFixWorkflow,
  researchBriefWorkflow,
  resumeFromCheckpoint,
  transferToolNameFor,
} from '../packages/core/dist/index.js';

const tempDirs = [];
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTool(name, opts = {}) {
  const calls = [];
  const tool = {
    definition: {
      name,
      description: opts.description ?? `Tool ${name} for testing.`,
      parameters: { type: 'object', properties: {} },
    },
    needsApproval: opts.needsApproval ?? false,
    calls,
    async execute(args) {
      calls.push(args);
      return opts.output ?? `ok:${name}`;
    },
  };
  return tool;
}

let callSeq = 0;
function scriptedProvider(responses, seenRequests = []) {
  let i = 0;
  return {
    id: 'mock',
    label: 'Mock',
    async chat(req) {
      seenRequests.push(req);
      const r = responses[Math.min(i++, responses.length - 1)];
      return { text: r.text ?? '', toolCalls: r.toolCalls ?? [] };
    },
    async listModels() {
      return ['mock'];
    },
  };
}

function makeEvents(overrides = {}) {
  return {
    texts: [],
    toolCalls: [],
    toolResults: [],
    onText(d) {
      this.texts.push(d);
    },
    onToolCall(c) {
      this.toolCalls.push(c);
    },
    onToolResult(r) {
      this.toolResults.push(r);
    },
    onApprovalNeeded: async () => true,
    ...overrides,
  };
}

function makeBot(workspaceDir, overrides = {}) {
  return {
    id: 'bot-1',
    name: 'Test',
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir,
    autoApprove: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Checkpoint sau mỗi step + resume không chạy lại tool đã xong
// ---------------------------------------------------------------------------

test('v0.12 integration: loop lưu checkpoint mỗi step, resume chạy tiếp không gọi lại tool', async () => {
  const ws = makeTempDir('open-bot-v012-');
  const memory = new BotMemory(ws);
  const readFile = makeTool('read_file', { output: 'nội dung a.txt' });
  const provider = scriptedProvider([
    {
      text: '',
      toolCalls: [{ id: `call-${++callSeq}`, name: 'read_file', args: { path: 'a.txt' } }],
    },
    { text: 'đọc xong' },
  ]);
  const runner = new AgentRunner(provider, [readFile], {
    bot: makeBot(ws),
    events: makeEvents(),
    memory,
    runId: 'run-ck-1',
  });
  const result = await runner.run('đọc file a.txt');
  assert.equal(result, 'đọc xong');
  assert.equal(readFile.calls.length, 1);

  const checkpoints = listCheckpoints(memory, 'run-ck-1');
  assert.ok(checkpoints.length >= 2, 'mỗi step (tool + text cuối) đều có checkpoint');
  const latest = checkpoints[checkpoints.length - 1];
  assert.ok(
    latest.messages.some((m) => m.role === 'tool' && String(m.content).includes('nội dung a.txt')),
    'checkpoint phải chứa kết quả tool đã chạy',
  );

  // Resume từ checkpoint mới nhất với provider chỉ trả text cuối.
  const state = resumeFromCheckpoint(memory, 'run-ck-1', 'latest');
  assert.ok(state, 'phải resume được từ checkpoint');
  assert.equal(state.nextStepIndex, latest.stepIndex + 1);
  const resumeRunner = new AgentRunner(scriptedProvider([{ text: 'xong-resume' }]), [readFile], {
    bot: makeBot(ws),
    events: makeEvents(),
    memory,
    runId: 'run-ck-2',
  });
  const resumed = await resumeRunner.resumeFrom(state.messages, state.nextStepIndex);
  assert.equal(resumed, 'xong-resume');
  assert.equal(readFile.calls.length, 1, 'resume không gọi lại tool đã xong');
});

// ---------------------------------------------------------------------------
// 2. Structured output qua loop: trích JSON + thử lại khi sai
// ---------------------------------------------------------------------------

test('v0.12 integration: structured output — trích JSON trong lời giải thích', async () => {
  const ws = makeTempDir('open-bot-v012-');
  const schema = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  };
  const runner = new AgentRunner(scriptedProvider([{ text: 'Đây nhé: {"answer": "42"}' }]), [], {
    bot: makeBot(ws),
    events: makeEvents(),
    structuredOutput: { schema },
  });
  assert.equal(await runner.run('trả lời'), '{"answer":"42"}');
});

test('v0.12 integration: structured output — sai thì nhắc sửa, tối đa 2 lần thử lại', async () => {
  const ws = makeTempDir('open-bot-v012-');
  const schema = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  };
  const seen = [];
  const runner = new AgentRunner(
    scriptedProvider(
      [{ text: 'không phải json' }, { text: '{"answer": 1}' }, { text: '{"answer": "ok"}' }],
      seen,
    ),
    [],
    {
      bot: makeBot(ws),
      events: makeEvents(),
      structuredOutput: { schema, maxRetries: 2 },
    },
  );
  assert.equal(await runner.run('trả lời'), '{"answer":"ok"}');
  assert.equal(seen.length, 3, '1 lần đầu + 2 lần thử lại');
});

// ---------------------------------------------------------------------------
// 3. Interrupt_before: duyệt kèm args đã sửa; sửa thành lệnh cấm thì bị chặn
// ---------------------------------------------------------------------------

test('v0.12 integration: interrupt_before — duyệt với args đã sửa, tool chạy args mới', async () => {
  const ws = makeTempDir('open-bot-v012-');
  const shell = makeTool('shell_exec');
  const permissions = new AgentPermissions();
  permissions.setBotPolicy('bot-1', {});
  const provider = scriptedProvider([
    {
      text: '',
      toolCalls: [{ id: `call-${++callSeq}`, name: 'shell_exec', args: { command: 'git push' } }],
    },
    { text: 'xong' },
  ]);
  const runner = new AgentRunner(provider, [shell], {
    bot: makeBot(ws),
    events: makeEvents({
      onApprovalNeeded: async () => ({ approved: true, args: { command: 'ls' } }),
    }),
    permissions,
  });
  assert.equal(await runner.run('đẩy code'), 'xong');
  assert.equal(shell.calls.length, 1);
  assert.deepEqual(shell.calls[0], { command: 'ls' }, 'tool chạy với args người duyệt đã sửa');
});

test('v0.12 integration: interrupt_before — sửa thành lệnh cấm thì bị từ chối, tool không chạy', async () => {
  const ws = makeTempDir('open-bot-v012-');
  const shell = makeTool('shell_exec');
  const permissions = new AgentPermissions();
  permissions.setBotPolicy('bot-1', {});
  const events = makeEvents({
    onApprovalNeeded: async () => ({ approved: true, args: { command: 'rm -rf /' } }),
  });
  const provider = scriptedProvider([
    {
      text: '',
      toolCalls: [{ id: `call-${++callSeq}`, name: 'shell_exec', args: { command: 'git push' } }],
    },
    { text: 'xong' },
  ]);
  const runner = new AgentRunner(provider, [shell], {
    bot: makeBot(ws),
    events,
    permissions,
  });
  assert.equal(await runner.run('đẩy code'), 'xong');
  assert.equal(shell.calls.length, 0, 'args sửa thành lệnh cấm thì tool không được chạy');
  assert.equal(events.toolResults[0].ok, false);
});

// ---------------------------------------------------------------------------
// 4. Compaction qua loop: vượt ngưỡng thì tóm tắt, lượt sau thấy bản tóm tắt
// ---------------------------------------------------------------------------

test('v0.12 integration: compaction — vượt ngưỡng thì gọi tóm tắt, lượt sau thấy summary', async () => {
  const ws = makeTempDir('open-bot-v012-');
  const seen = [];
  const longOutput = 'x'.repeat(600);
  const readFile = makeTool('read_file', { output: longOutput });
  const provider = scriptedProvider(
    [
      {
        text: '',
        toolCalls: [{ id: `call-${++callSeq}`, name: 'read_file', args: { path: 'big.txt' } }],
      },
      { text: 'TÓM TẮT NGẮN.' },
      { text: 'xong' },
    ],
    seen,
  );
  const runner = new AgentRunner(provider, [readFile], {
    bot: makeBot(ws),
    events: makeEvents(),
    compaction: { contextLimit: 100, keepRecent: 1 },
  });
  assert.equal(await runner.run('đọc file dài'), 'xong');
  assert.equal(seen.length, 3, 'chat 1 (tool) + chat tóm tắt + chat 2');
  const thirdCallMessages = seen[2].messages;
  assert.ok(
    thirdCallMessages.some((m) => typeof m.content === 'string' && m.content.includes('TÓM TẮT NGẮN')),
    'lượt chat sau compaction phải thấy bản tóm tắt',
  );
});

// ---------------------------------------------------------------------------
// 5. Subagent chuyên biệt song song qua ctx của tool
// ---------------------------------------------------------------------------

test('v0.12 integration: delegate song song — 2 subagent chuyên biệt chạy rồi gộp', async () => {
  const ws = makeTempDir('open-bot-v012-');
  const delegateTool = {
    definition: {
      name: 'delegate_test',
      description: 'test delegate',
      parameters: { type: 'object', properties: {} },
    },
    needsApproval: false,
    async execute(_args, ctx) {
      if (!ctx.runSpecializedSubagents) return 'Error: không có ctx.';
      return ctx.runSpecializedSubagents([
        { spec: { name: 'researcher', instructions: 'Nghiên cứu kỹ.' }, task: 'tìm hiểu A' },
        { spec: { name: 'writer', instructions: 'Viết ngắn gọn.' }, task: 'viết về A' },
      ]);
    },
  };
  const provider = scriptedProvider([
    { text: '', toolCalls: [{ id: `call-${++callSeq}`, name: 'delegate_test', args: {} }] },
    { text: 'nội dung subagent' },
    { text: 'xong' },
  ]);
  const events = makeEvents();
  const runner = new AgentRunner(provider, [delegateTool], {
    bot: makeBot(ws),
    events,
  });
  assert.equal(await runner.run('làm việc lớn'), 'xong');
  const merged = events.toolResults[0].output;
  assert.match(merged, /researcher/);
  assert.match(merged, /writer/);
  assert.match(merged, /2 xong/);
});

// ---------------------------------------------------------------------------
// 6. Workflow runner thật: node agent → node tool → end
// ---------------------------------------------------------------------------

test('v0.12 integration: workflow runner thật chạy agent rồi tool', async () => {
  const ws = makeTempDir('open-bot-v012-');
  const webSearch = makeTool('web_search', { output: 'kết quả tìm kiếm: mèo' });
  const runner = createWorkflowRunner({
    provider: scriptedProvider([{ text: 'agent đã trả lời' }]),
    tools: [webSearch],
    bot: makeBot(ws),
    events: makeEvents(),
  });
  const result = await runWorkflow(
    {
      id: 'test-wf',
      name: 'Test workflow',
      startNodeId: 'ask',
      nodes: [
        { id: 'ask', kind: 'agent', prompt: 'trả lời ngắn: {{topic}}' },
        { id: 'search', kind: 'tool', toolName: 'web_search', args: { query: '{{topic}}' } },
        { id: 'end', kind: 'end' },
      ],
      edges: [
        { from: 'ask', to: 'search' },
        { from: 'search', to: 'end' },
      ],
    },
    runner,
    { initialState: { topic: 'mèo' } },
  );
  assert.equal(result.status, 'done');
  assert.equal(result.state.ask, 'agent đã trả lời');
  assert.equal(result.state.search, 'kết quả tìm kiếm: mèo');
  assert.deepEqual(webSearch.calls[0], { query: 'mèo' });
});

// ---------------------------------------------------------------------------
// 7. Coordinator: handoff transfer_to_X + resume qua run params
// ---------------------------------------------------------------------------

function coordinatorBotConfig(id, name, workspaceDir) {
  return {
    id,
    name,
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir,
    autoApprove: true,
  };
}

test('v0.12 integration: coordinator handoff — A chuyển cho B, kết quả B quay về A', async () => {
  const notifications = [];
  const coordinator = new AgentCoordinator({
    toolFactory: () => [],
    emit: (n) => notifications.push(n),
  });
  await coordinator.createBot({
    bot: coordinatorBotConfig('hf-a', 'Trợ lý A', makeTempDir('open-bot-v012-')),
    provider: {
      id: 'mock',
      mockResponses: [
        {
          text: '',
          toolCalls: [
            {
              id: 'c1',
              name: 'transfer_to_chuyen_gia_b',
              args: { task: 'làm X giúp', reason: 'đúng chuyên môn' },
            },
          ],
        },
        { text: 'đã nhận kết quả' },
      ],
    },
  });
  await coordinator.createBot({
    bot: coordinatorBotConfig('hf-b', 'Chuyên gia B', makeTempDir('open-bot-v012-')),
    provider: { id: 'mock', mockResponses: [{ text: 'B đã làm xong X' }] },
  });
  const result = await coordinator.run({ botId: 'hf-a', text: 'cần làm X' });
  assert.equal(result.text, 'đã nhận kết quả');
  // Kết quả handoff nằm trong tool result của tool transfer (model thấy
  // nó ở lượt sau, text cuối là câu model tự trả nên không chứa nó).
  const transferResults = notifications.filter(
    (n) => n.data?.kind === 'toolresult' && String(n.data?.payload?.output ?? '').includes('Chuyên gia B'),
  );
  assert.ok(transferResults.length >= 1, 'phải có tool result của transfer_to_X');
  assert.match(
    String(transferResults[0].data.payload.output),
    /B đã làm xong X/,
    'kết quả của bot đích phải quay về bot nguồn qua tool result',
  );
});

test('v0.12 integration: coordinator resume — chạy tiếp từ checkpoint qua run params', async () => {
  const coordinator = new AgentCoordinator({ toolFactory: () => [] });
  await coordinator.createBot({
    bot: coordinatorBotConfig('rs-1', 'Bot resume', makeTempDir('open-bot-v012-')),
    provider: { id: 'mock', mockResponses: [{ text: 'xong lần 1' }] },
  });
  const first = await coordinator.run({ botId: 'rs-1', text: 'làm việc', runId: 'run-rs-1' });
  assert.equal(first.text, 'xong lần 1');
  const resumed = await coordinator.run({ botId: 'rs-1', text: '', resumeRunId: 'run-rs-1' });
  assert.equal(resumed.text, 'xong lần 1', 'resume chạy tiếp từ checkpoint, mock trả lại text cuối');
  await assert.rejects(
    coordinator.run({ botId: 'rs-1', text: '', resumeRunId: 'run-khong-ton-tai' }),
    /Không resume được/,
  );
});

// ---------------------------------------------------------------------------
// 8. Barrel exports + context limit + workflow mẫu + triage template
// ---------------------------------------------------------------------------

test('v0.12 integration: barrel export đủ helper mới + context limit + workflow mẫu', () => {
  for (const [name, fn] of [
    ['createHandoff', createHandoff],
    ['transferToolNameFor', transferToolNameFor],
    ['resumeFromCheckpoint', resumeFromCheckpoint],
    ['listCheckpoints', listCheckpoints],
    ['getTriageTemplate', getTriageTemplate],
    ['researchBriefWorkflow', researchBriefWorkflow],
    ['planEditTestFixWorkflow', planEditTestFixWorkflow],
  ]) {
    assert.notEqual(typeof fn, 'undefined', `${name} phải được export từ core barrel`);
  }
  assert.equal(transferToolNameFor('Chuyên gia B'), 'transfer_to_chuyen_gia_b');
  assert.equal(transferToolNameFor('Nghiên cứu'), 'transfer_to_nghien_cuu');
  assert.equal(contextLimitForModel('xai', 'grok-4.7'), 262144);
  assert.equal(contextLimitForModel('ollama', 'qwen2.5:0.5b'), 32768);
  assert.equal(contextLimitForModel('anthropic', 'claude-sonnet-4-5'), 200000);
  // v0.22: tên ghi rõ context nhỏ thắng nhánh theo họ model — để guard
  // small-model trong loop thấy được limit ≤ 8k qua đường coordinator.
  assert.equal(contextLimitForModel('ollama', 'qwen2.5:0.5b-4k'), 4000);
  assert.equal(contextLimitForModel('ollama', 'llama-4096'), 4096);
  assert.equal(contextLimitForModel('ollama', 'my-model-ctx8192'), 8192);
  assert.equal(contextLimitForModel('ollama', 'qwen2.5:0.5b-8k'), 8000);
  assert.ok(researchBriefWorkflow.nodes.length > 0);
  assert.ok(planEditTestFixWorkflow.nodes.length > 0);
  const triage = getTriageTemplate();
  assert.ok(triage, 'phải có template triage');
});
