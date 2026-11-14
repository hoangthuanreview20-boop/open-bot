/**
 * sdk-query-v101.test.mjs — Agent SDK query() v1.01 (Team T6).
 * query(prompt, options) chạy AgentRunner trong process, trả async
 * iterator event + result() + abort(). Provider dùng fake object (không
 * gọi mạng, không cần key); mock provider thật chỉ dùng cho test
 * providerId lỗi. Run: build core rồi `node --test tests/sdk-query-v101.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../packages/core/dist/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fake provider trả text cố định, không gọi mạng. */
function textProvider(text, opts = {}) {
  let calls = 0;
  return {
    provider: {
      id: 'fake',
      label: 'Fake',
      async chat() {
        calls += 1;
        await sleep(1);
        return { text, toolCalls: [], ...(opts.usage ? { usage: opts.usage } : {}) };
      },
      async listModels() {
        return ['fake'];
      },
    },
    calls: () => calls,
  };
}

async function collectEvents(handle) {
  const events = [];
  for await (const event of handle) events.push(event);
  return events;
}

test('query: prompt rỗng / thiếu provider / maxTurns sai thì throw rõ', () => {
  assert.throws(() => query('   ', { provider: textProvider('x').provider }), /prompt không rỗng/);
  assert.throws(() => query('hi', {}), /cần provider/);
  assert.throws(
    () => query('hi', { provider: textProvider('x').provider, maxTurns: 0 }),
    /maxTurns > 0/,
  );
  assert.throws(
    () => query('hi', { providerId: 'khong-co-provider-nay', model: 'm' }),
    /Unknown provider|không hỗ trợ|provider/i,
  );
  assert.throws(
    () => query('hi', { providerId: 'openai' }),
    /cần model/,
  );
});

test('query: stream text + done, result() trả text/turns/toolCalls', async () => {
  const { provider } = textProvider('xin chào');
  const handle = query('chào bạn', { provider });
  const events = await collectEvents(handle);
  assert.deepEqual(
    events.map((e) => e.type),
    ['text', 'done'],
  );
  assert.equal(events[0].text, 'xin chào');
  assert.equal(events[1].turns, 1);
  assert.equal(events[1].toolCalls, 0);
  assert.equal(events[1].aborted, false);
  const result = await handle.result();
  assert.equal(result.text, 'xin chào');
  assert.equal(result.turns, 1);
  assert.equal(result.aborted, false);
  // treeSnapshot có sau khi run (root node duy nhất, chưa spawn con).
  const tree = handle.treeSnapshot();
  assert.equal(tree.totalNodes, 1);
  assert.equal(tree.root.name, 'root');
});

test('query: tool call chạy thật, tool_result + done ghi đủ số liệu', async () => {
  let executed = 0;
  const echoTool = {
    definition: {
      name: 'echo_tool',
      description: 'Trả lại input.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
    needsApproval: false,
    async execute(args) {
      executed += 1;
      return `echo:${String(args.word ?? '')}`;
    },
  };
  const provider = {
    id: 'fake',
    label: 'Fake',
    calls: 0,
    async chat() {
      this.calls += 1;
      if (this.calls === 1) {
        return { text: '', toolCalls: [{ id: 'c1', name: 'echo_tool', args: { word: 'hi' } }] };
      }
      return { text: 'xong, tool đã chạy', toolCalls: [] };
    },
    async listModels() {
      return ['fake'];
    },
  };
  // v1.01 merge (T3+T6): tool do caller cung cấp bị risk analyzer chấm
  // medium (tool lạ, fail-closed) nên ConfirmRisky mặc định yêu cầu duyệt;
  // SDK không có UI nên cần autoApprove: true tường minh để tool chạy.
  const handle = query('dùng tool echo', { provider, tools: [echoTool], autoApprove: true });
  const events = await collectEvents(handle);
  assert.equal(executed, 1);
  assert.ok(events.some((e) => e.type === 'tool_call' && e.call.name === 'echo_tool'));
  assert.ok(events.some((e) => e.type === 'tool_result' && e.result.ok === true));
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.turns, 2);
  assert.equal(done.toolCalls, 1);
  const result = await handle.result();
  assert.match(result.text, /xong, tool đã chạy/);
});

test('query: autoApprove=false thì tool cần duyệt bị từ chối, tool không chạy', async () => {
  let executed = 0;
  const writeTool = {
    definition: {
      name: 'write_tool',
      description: 'Ghi file (cần duyệt).',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
    needsApproval: true,
    async execute() {
      executed += 1;
      return 'đã ghi';
    },
  };
  const provider = {
    id: 'fake',
    label: 'Fake',
    calls: 0,
    async chat() {
      this.calls += 1;
      if (this.calls === 1) {
        return { text: '', toolCalls: [{ id: 'c1', name: 'write_tool', args: {} }] };
      }
      return { text: 'đã xong (tool bị từ chối nên không ghi)', toolCalls: [] };
    },
    async listModels() {
      return ['fake'];
    },
  };
  const handle = query('ghi file đi', { provider, tools: [writeTool], autoApprove: false });
  const result = await handle.result();
  assert.equal(executed, 0, 'tool cần duyệt phải bị từ chối khi autoApprove=false');
  // Loop dừng cả turn ngay khi approval bị từ chối (xem loop.ts).
  assert.equal(result.text, 'đã hủy');
  assert.equal(result.turns, 1);
  assert.equal(result.toolCalls, 1);
});

test('query: autoApprove=true thì tool cần duyệt được chạy', async () => {
  let executed = 0;
  const writeTool = {
    definition: {
      name: 'write_tool',
      description: 'Ghi file (cần duyệt).',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
    needsApproval: true,
    async execute() {
      executed += 1;
      return 'đã ghi';
    },
  };
  const provider = {
    id: 'fake',
    label: 'Fake',
    calls: 0,
    async chat() {
      this.calls += 1;
      if (this.calls === 1) {
        return { text: '', toolCalls: [{ id: 'c1', name: 'write_tool', args: {} }] };
      }
      return { text: 'đã ghi xong', toolCalls: [] };
    },
    async listModels() {
      return ['fake'];
    },
  };
  const handle = query('ghi file đi', { provider, tools: [writeTool], autoApprove: true });
  const result = await handle.result();
  assert.equal(executed, 1);
  assert.match(result.text, /đã ghi xong/);
});

test('query: abort() dừng run, result.aborted=true, iterator kết thúc', async () => {
  const provider = {
    id: 'fake',
    label: 'Fake',
    async chat(req) {
      // Treo cho tới khi signal abort (như provider thật làm).
      await new Promise((resolve, reject) => {
        if (req.signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        req.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return { text: 'không bao giờ tới đây', toolCalls: [] };
    },
    async listModels() {
      return ['fake'];
    },
  };
  const handle = query('chạy lâu', { provider, maxTurns: 5 });
  const eventsPromise = collectEvents(handle);
  await sleep(20);
  handle.abort();
  const events = await eventsPromise;
  assert.ok(events.some((e) => e.type === 'done' && e.aborted === true));
  const result = await handle.result();
  assert.equal(result.aborted, true);
  assert.equal(result.text, '');
});

test('query: onEvent callback nhận đủ event như iterator', async () => {
  const { provider } = textProvider('hello');
  const seen = [];
  const handle = query('hi', { provider, onEvent: (e) => seen.push(e.type) });
  await handle.result();
  assert.deepEqual(seen, ['text', 'done']);
});

test('query: subagent lồng nhau qua tool, treeSnapshot ghi đủ cây', async () => {
  // Tool spawn_next gọi ctx.runSubagent — con chạy trong cùng cây.
  const spawnNextTool = {
    definition: {
      name: 'spawn_next',
      description: 'Spawn subagent con.',
      parameters: {
        type: 'object',
        properties: { task: { type: 'string' } },
        required: ['task'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args, ctx) {
      if (!ctx.runSubagent) return 'Error: no runSubagent';
      return ctx.runSubagent(String(args.task ?? ''));
    },
  };
  const provider = {
    id: 'fake',
    label: 'Fake',
    calls: 0,
    async chat(req) {
      this.calls += 1;
      const userText = (req.messages ?? [])
        .filter((m) => m.role === 'user')
        .map((m) => m.content)
        .join('\n');
      // Cha vòng 1: spawn con. Con vòng 1: text cuối. Cha vòng 2: text cuối.
      if (userText.includes('child task')) return { text: 'child done', toolCalls: [] };
      if (this.calls === 1) {
        return { text: '', toolCalls: [{ id: 'c1', name: 'spawn_next', args: { task: 'child task' } }] };
      }
      return { text: 'parent done', toolCalls: [] };
    },
    async listModels() {
      return ['fake'];
    },
  };
  // v1.01 merge (T3+T6): như test echo ở trên — spawn_next là tool lạ
  // (medium risk) nên cần autoApprove: true để chạy không cần UI duyệt.
  const handle = query('làm việc có spawn con', {
    provider,
    tools: [spawnNextTool],
    subagentPolicy: { maxDepth: 5 },
    autoApprove: true,
  });
  const result = await handle.result();
  assert.match(result.text, /parent done/);
  const tree = handle.treeSnapshot();
  assert.equal(tree.totalNodes, 2, 'root + 1 con');
  assert.equal(tree.root.children.length, 1);
  assert.equal(tree.root.children[0].status, 'done');
  assert.equal(tree.policy.maxDepth, 5);
});

test('query: provider lỗi thì event error + result() reject', async () => {
  const provider = {
    id: 'fake',
    label: 'Fake',
    async chat() {
      throw new Error('provider sập mạng');
    },
    async listModels() {
      return ['fake'];
    },
  };
  const handle = query('hi', { provider });
  const events = await collectEvents(handle);
  assert.ok(events.some((e) => e.type === 'error' && /sập mạng/.test(e.message)));
  await assert.rejects(() => handle.result(), /sập mạng/);
});
