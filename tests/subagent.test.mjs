/**
 * subagent.test.mjs — delegate_task / agent_status / stop_agent / ask_user /
 * send_* / await_condition qua AgentRunner (mock provider, không gọi mạng)
 * và qua factory createSubagentTools trực tiếp.
 * Run: node --test tests/subagent.test.mjs (after building core + tools)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentRunner } from '../packages/core/dist/agent/loop.js';
import { SUBAGENT_TOOLS, createSubagentTools } from '../packages/tools/dist/subagentTools.js';

const BOT = {
  id: 'bot-test',
  name: 'Test',
  providerId: 'mock',
  model: 'mock',
  systemPrompt: 'You are a test bot.',
  workspaceDir: '',
  autoApprove: true,
};

let callSeq = 0;
function toolCall(name, args) {
  return { id: `call-${++callSeq}`, name, args };
}

/** Provider trả về các response đã soạn sẵn theo thứ tự gọi chat(). */
function scriptedProvider(responses) {
  let i = 0;
  return {
    id: 'mock',
    label: 'Mock',
    async chat() {
      const r = responses[Math.min(i++, responses.length - 1)];
      if (typeof r === 'function') return r();
      return { text: r.text ?? '', toolCalls: r.toolCalls ?? [] };
    },
    async listModels() {
      return ['mock'];
    },
  };
}

function makeEvents(extra = {}) {
  const events = {
    texts: [],
    toolCalls: [],
    toolResults: [],
    progress: [],
    summaries: [],
    onText(delta) {
      events.texts.push(delta);
    },
    onToolCall(call) {
      events.toolCalls.push(call);
    },
    onToolResult(r) {
      events.toolResults.push(r);
    },
    onApprovalNeeded: async () => true,
    onProgress(message) {
      events.progress.push(message);
    },
    onFinalSummary(summary) {
      events.summaries.push(summary);
    },
    ...extra,
  };
  return events;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-subagent-'));
}

function toolByName(tools, name) {
  const t = tools.find((x) => x.definition.name === name);
  assert.ok(t, `missing tool ${name}`);
  return t;
}

test('loop: delegate_task chạy agent con (mock provider) và trả tóm tắt', async () => {
  const dir = tmpDir();
  const provider = scriptedProvider([
    { toolCalls: [toolCall('delegate_task', { task: 'viết câu chào' })] },
    { text: 'child result: xin chào' },
    { text: 'parent done' },
  ]);
  const events = makeEvents();
  const runner = new AgentRunner(provider, createSubagentTools(), {
    bot: { ...BOT, workspaceDir: dir },
    events,
  });
  const out = await runner.run('giao việc đi');
  assert.equal(out, 'parent done');
  const delegateResult = events.toolResults.find(
    (r) => events.toolCalls.some((c) => c.id === r.callId && c.name === 'delegate_task'),
  );
  assert.ok(delegateResult, 'không thấy tool result của delegate_task');
  assert.equal(delegateResult.ok, true);
  assert.match(delegateResult.output, /\[subagent .+\] done:/);
  assert.match(delegateResult.output, /child result: xin chào/);
});

test('loop: agent_status thấy agent con đã xong; stop_agent với id lạ báo lỗi rõ', async () => {
  const dir = tmpDir();
  const provider = scriptedProvider([
    { toolCalls: [toolCall('delegate_task', { task: 'việc nhanh' })] },
    { text: 'xong việc con' },
    { text: 'turn 1 xong' },
    { toolCalls: [toolCall('agent_status', {})] },
    { text: 'turn 2 xong' },
    { toolCalls: [toolCall('stop_agent', { agentId: 'không-tồn-tại' })] },
    { text: 'turn 3 xong' },
  ]);
  const events = makeEvents();
  const runner = new AgentRunner(provider, createSubagentTools(), {
    bot: { ...BOT, workspaceDir: dir },
    events,
  });
  await runner.run('turn 1');
  await runner.run('turn 2');
  const statusResult = events.toolResults.filter((r) =>
    events.toolCalls.some((c) => c.id === r.callId && c.name === 'agent_status'),
  ).at(-1);
  assert.ok(statusResult);
  const list = JSON.parse(statusResult.output);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'done');

  await runner.run('turn 3');
  const stopResult = events.toolResults.filter((r) =>
    events.toolCalls.some((c) => c.id === r.callId && c.name === 'stop_agent'),
  ).at(-1);
  assert.ok(stopResult);
  assert.equal(stopResult.ok, false);
  assert.match(stopResult.output, /không thấy agent con/);
});

test('loop: delegate_task timeout trả tóm tắt timeout (không treo)', async () => {
  const dir = tmpDir();
  const provider = scriptedProvider([
    { toolCalls: [toolCall('delegate_task', { task: 'việc chậm', timeoutMs: 200 })] },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { text: 'quá muộn', toolCalls: [] };
    },
    { text: 'parent xong' },
  ]);
  const events = makeEvents();
  const runner = new AgentRunner(provider, createSubagentTools(), {
    bot: { ...BOT, workspaceDir: dir },
    events,
  });
  const out = await runner.run('giao việc chậm');
  assert.equal(out, 'parent xong');
  const delegateResult = events.toolResults.find((r) =>
    events.toolCalls.some((c) => c.id === r.callId && c.name === 'delegate_task'),
  );
  assert.match(delegateResult.output, /timeout sau 200ms/);
});

test('loop: ask_user qua events.onAskUser; thiếu handler thì lỗi rõ, không crash', async () => {
  const dir = tmpDir();
  // Có handler: câu trả lời chảy vào tool result.
  const provider = scriptedProvider([
    { toolCalls: [toolCall('ask_user', { question: 'Màu nào?', options: ['đỏ', 'xanh'] })] },
    { text: 'bạn chọn xanh' },
  ]);
  const events = makeEvents({
    onAskUser: async (question, options) => {
      assert.equal(question, 'Màu nào?');
      assert.deepEqual(options, ['đỏ', 'xanh']);
      return 'xanh';
    },
  });
  const runner = new AgentRunner(provider, createSubagentTools(), {
    bot: { ...BOT, workspaceDir: dir },
    events,
  });
  const out = await runner.run('hỏi đi');
  assert.equal(out, 'bạn chọn xanh');
  assert.equal(events.toolResults[0].ok, true);
  assert.equal(events.toolResults[0].output, 'xanh');

  // Không có handler: lỗi rõ, turn vẫn kết thúc bình thường.
  const provider2 = scriptedProvider([
    { toolCalls: [toolCall('ask_user', { question: 'Màu nào?' })] },
    { text: 'không hỏi được' },
  ]);
  const events2 = makeEvents();
  delete events2.onAskUser;
  const runner2 = new AgentRunner(provider2, createSubagentTools(), {
    bot: { ...BOT, workspaceDir: dir },
    events: events2,
  });
  const out2 = await runner2.run('hỏi đi');
  assert.equal(out2, 'không hỏi được');
  assert.equal(events2.toolResults[0].ok, false);
  assert.match(events2.toolResults[0].output, /chưa hỗ trợ hỏi người dùng/);
});

test('loop: send_message_to_user / send_progress_update / send_final_summary qua events', async () => {
  const dir = tmpDir();
  const provider = scriptedProvider([
    {
      toolCalls: [
        toolCall('send_progress_update', { message: 'đang làm 50%' }),
        toolCall('send_final_summary', { summary: 'xong hết' }),
        toolCall('send_message_to_user', { message: 'chào bạn' }),
      ],
    },
    { text: 'done' },
  ]);
  const events = makeEvents();
  const runner = new AgentRunner(provider, createSubagentTools(), {
    bot: { ...BOT, workspaceDir: dir },
    events,
  });
  await runner.run('gửi đi');
  assert.deepEqual(events.progress, ['đang làm 50%']);
  assert.deepEqual(events.summaries, ['xong hết']);
  assert.ok(events.texts.includes('chào bạn'));
  assert.ok(events.toolResults.every((r) => r.ok));
});

test('factory: ask_user / send_* / stop_agent / agent_status với callback mock', async () => {
  const dir = tmpDir();
  const seen = { asked: [], progress: [], summaries: [], messages: [] };
  const tools = createSubagentTools({
    askUser: async (q) => {
      seen.asked.push(q);
      return 'đáp án mock';
    },
    onProgress: (m) => seen.progress.push(m),
    onFinalSummary: (s) => seen.summaries.push(s),
    onUserMessage: (m) => seen.messages.push(m),
    stopSubagent: (id) => id === 'a1',
    subagentStatus: () => [{ id: 'a1', status: 'running' }],
  });
  const ctx = { workspaceDir: dir, botId: BOT.id };

  assert.equal(
    await toolByName(tools, 'ask_user').execute({ question: 'Q?' }, ctx),
    'đáp án mock',
  );
  assert.deepEqual(seen.asked, ['Q?']);
  await toolByName(tools, 'send_progress_update').execute({ message: 'p1' }, ctx);
  await toolByName(tools, 'send_final_summary').execute({ summary: 's1' }, ctx);
  await toolByName(tools, 'send_message_to_user').execute({ message: 'm1' }, ctx);
  assert.deepEqual(seen.progress, ['p1']);
  assert.deepEqual(seen.summaries, ['s1']);
  assert.deepEqual(seen.messages, ['m1']);

  const status = JSON.parse(await toolByName(tools, 'agent_status').execute({}, ctx));
  assert.deepEqual(status, [{ id: 'a1', status: 'running' }]);
  assert.match(await toolByName(tools, 'stop_agent').execute({ agentId: 'a1' }, ctx), /Đã dừng/);
  assert.match(
    await toolByName(tools, 'stop_agent').execute({ agentId: 'zz' }, ctx),
    /Không thấy agent con/,
  );
  // delegate_task không có ctx.runSubagent -> lỗi rõ, không crash.
  assert.match(
    await toolByName(tools, 'delegate_task').execute({ task: 'x' }, ctx),
    /chưa được hỗ trợ/,
  );
});

test('factory: await_condition file_exists + task_status, timeout trả false', async () => {
  const dir = tmpDir();
  const tools = createSubagentTools({
    getTaskStatus: (taskId) => (taskId === 't1' ? 'done' : 'pending'),
  });
  const ctx = { workspaceDir: dir, botId: BOT.id };
  const awaitTool = toolByName(tools, 'await_condition');

  fs.writeFileSync(path.join(dir, 'ready.txt'), 'ok');
  assert.match(
    await awaitTool.execute({ kind: 'file_exists', path: 'ready.txt' }, ctx),
    /^true:/,
  );
  // File ngoài workspace phải bị chặn (resolveWithin).
  assert.match(
    await awaitTool.execute({ kind: 'file_exists', path: '../escape.txt' }, ctx),
    /escapes workspace/,
  );
  // task_status đạt ngay.
  assert.match(
    await awaitTool.execute({ kind: 'task_status', taskId: 't1', status: 'done' }, ctx),
    /^true:/,
  );
  // task_status không đạt -> false sau timeout ngắn.
  const started = Date.now();
  const out = await awaitTool.execute(
    { kind: 'task_status', taskId: 't1', status: 'pending', timeoutMs: 600 },
    ctx,
  );
  assert.match(out, /^false: hết timeout 600ms/);
  assert.ok(Date.now() - started >= 500, 'poll phải chờ ít nhất ~500ms');
});

test('subagent tools: SUBAGENT_TOOLS có đủ 8 tool; needsApproval đúng', () => {
  const names = SUBAGENT_TOOLS.map((t) => t.definition.name);
  for (const n of [
    'delegate_task', 'agent_status', 'stop_agent', 'ask_user',
    'send_message_to_user', 'send_progress_update', 'send_final_summary',
    'await_condition',
  ]) {
    assert.ok(names.includes(n), `thiếu tool ${n}`);
  }
  for (const t of SUBAGENT_TOOLS) {
    const needs = ['delegate_task', 'stop_agent'].includes(t.definition.name);
    assert.equal(t.needsApproval, needs, `${t.definition.name} needsApproval sai`);
  }
});
