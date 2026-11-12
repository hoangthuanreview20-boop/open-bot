/**
 * Tests for v0.12 workflow graph (W4c):
 *   packages/core/src/agent/workflow.ts
 *   packages/core/src/agent/workflows/ (research-brief, plan-edit-test-fix)
 *
 * Build riêng core rồi chạy:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/workflow-v012.test.mjs
 * Không cần API key thật, không gọi mạng (runner giả, không provider thật).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  defineWorkflow,
  evaluateCondition,
  getStateField,
  renderTemplate,
  runWorkflow,
  validateWorkflow,
} from '../packages/core/dist/agent/workflow.js';
import {
  planEditTestFixWorkflow,
  researchBriefWorkflow,
} from '../packages/core/dist/agent/workflows/index.js';

// ---------------------------------------------------------------------------
// Runner giả: giả lập agent + tool, không gọi provider/network.
// ---------------------------------------------------------------------------

/** Runner ghi lại mọi node đã chạy; hành vi theo node.id / toolName. */
function makeFakeRunner(behavior = {}) {
  const calls = [];
  const runner = async ({ node, state }) => {
    calls.push({ id: node.id, kind: node.kind, prompt: node.prompt, toolName: node.toolName, args: node.args });
    const fn = behavior[node.id] ?? behavior[`tool:${node.toolName}`] ?? behavior.default;
    if (typeof fn === 'function') return fn({ node, state, calls });
    if (node.kind === 'agent') return { output: `agent:${node.id}: ${node.prompt ?? ''}` };
    if (node.kind === 'tool') return { output: `tool:${node.toolName ?? node.id}(${JSON.stringify(node.args ?? {})})` };
    throw new Error(`runner giả không biết chạy node ${node.id} (${node.kind})`);
  };
  runner.calls = calls;
  return runner;
}

const linearWorkflow = defineWorkflow({
  id: 'linear',
  name: 'Tuyến tính',
  startNodeId: 'a',
  nodes: [
    { id: 'a', kind: 'agent', prompt: 'làm bước a với {{input}}' },
    { id: 'b', kind: 'tool', toolName: 'shell_exec', args: { command: 'echo {{a}}' } },
    { id: 'end', kind: 'end' },
  ],
  edges: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'end' },
  ],
});

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

test('validateWorkflow: 2 workflow mẫu đều hợp lệ', () => {
  for (const wf of [researchBriefWorkflow, planEditTestFixWorkflow]) {
    const v = validateWorkflow(wf);
    assert.equal(v.ok, true, `${wf.id}: ${v.errors.join(' | ')}`);
    assert.deepEqual(v.errors, []);
  }
  assert.equal(validateWorkflow(linearWorkflow).ok, true);
});

test('validateWorkflow: start không tồn tại, edge tới node lạ, node thiếu trường', () => {
  const badStart = defineWorkflow({ ...linearWorkflow, startNodeId: 'khong-co' });
  assert.match(validateWorkflow(badStart).errors.join(' '), /bắt đầu/);

  const badEdge = defineWorkflow({
    ...linearWorkflow,
    edges: [{ from: 'a', to: 'khong-co' }, { from: 'b', to: 'end' }],
  });
  assert.match(validateWorkflow(badEdge).errors.join(' '), /không tồn tại/);

  const noPrompt = defineWorkflow({
    id: 'x', name: 'x', startNodeId: 'a',
    nodes: [{ id: 'a', kind: 'agent' }, { id: 'end', kind: 'end' }],
    edges: [{ from: 'a', to: 'end' }],
  });
  assert.match(validateWorkflow(noPrompt).errors.join(' '), /prompt/);

  const noTool = defineWorkflow({
    id: 'x', name: 'x', startNodeId: 'a',
    nodes: [{ id: 'a', kind: 'tool' }, { id: 'end', kind: 'end' }],
    edges: [{ from: 'a', to: 'end' }],
  });
  assert.match(validateWorkflow(noTool).errors.join(' '), /toolName/);

  const dup = defineWorkflow({
    ...linearWorkflow,
    nodes: [...linearWorkflow.nodes, { id: 'a', kind: 'agent', prompt: 'trùng' }],
  });
  assert.match(validateWorkflow(dup).errors.join(' '), /Trùng id/);
});

test('validateWorkflow: cycle không điều kiện bị chặn, cycle có điều kiện được phép', () => {
  const unconditionalCycle = defineWorkflow({
    id: 'loop-xau', name: 'loop xấu', startNodeId: 'a',
    nodes: [
      { id: 'a', kind: 'agent', prompt: 'a' },
      { id: 'b', kind: 'agent', prompt: 'b' },
      { id: 'end', kind: 'end' },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' }, // cycle toàn edge không điều kiện
      { from: 'b', to: 'end', condition: { field: 'x', equals: 1 } },
    ],
  });
  // Lưu ý: edge b→end có điều kiện nhưng cycle a→b→a thì không — vẫn bị chặn.
  assert.equal(validateWorkflow(unconditionalCycle).ok, false);
  assert.match(validateWorkflow(unconditionalCycle).errors.join(' '), /Cycle không có lối thoát/);

  // plan→edit→test→fix mẫu: cycle test→check→fix→test có edge điều kiện → hợp lệ (đã assert ở trên).
  assert.equal(validateWorkflow(planEditTestFixWorkflow).ok, true);
});

test('validateWorkflow: node mồ côi, node không có edge đi ra, 2 edge mặc định', () => {
  const orphan = defineWorkflow({
    id: 'x', name: 'x', startNodeId: 'a',
    nodes: [
      { id: 'a', kind: 'agent', prompt: 'a' },
      { id: 'mo-coi', kind: 'agent', prompt: 'không ai tới' },
      { id: 'end', kind: 'end' },
    ],
    edges: [{ from: 'a', to: 'end' }],
  });
  assert.match(validateWorkflow(orphan).errors.join(' '), /mồ côi/);

  const stuck = defineWorkflow({
    id: 'x', name: 'x', startNodeId: 'a',
    nodes: [{ id: 'a', kind: 'agent', prompt: 'a' }, { id: 'end', kind: 'end' }],
    edges: [],
  });
  assert.match(validateWorkflow(stuck).errors.join(' '), /không có edge đi ra/);

  const ambiguous = defineWorkflow({
    id: 'x', name: 'x', startNodeId: 'a',
    nodes: [
      { id: 'a', kind: 'agent', prompt: 'a' },
      { id: 'b', kind: 'agent', prompt: 'b' },
      { id: 'end', kind: 'end' },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'end' },
      { from: 'b', to: 'end' },
    ],
  });
  assert.match(validateWorkflow(ambiguous).errors.join(' '), /edge mặc định/);
});

test('validateWorkflow: parallel cần ≥2 nhánh, nhánh phải tồn tại', () => {
  const bad = defineWorkflow({
    id: 'x', name: 'x', startNodeId: 'p',
    nodes: [
      { id: 'p', kind: 'parallel', branches: ['chi-mot'] },
      { id: 'end', kind: 'end' },
    ],
    edges: [{ from: 'p', to: 'end' }],
  });
  const v = validateWorkflow(bad);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /ít nhất 2 nhánh|không tồn tại/);
});

// ---------------------------------------------------------------------------
// Condition + template
// ---------------------------------------------------------------------------

test('evaluateCondition + getStateField + renderTemplate', () => {
  const state = { test: 'FAIL: 2 test lỗi', nested: { passed: true, count: 3 } };
  assert.equal(evaluateCondition(undefined, state), true);
  assert.equal(evaluateCondition({ field: 'test', contains: 'fail' }, state), true);
  assert.equal(evaluateCondition({ field: 'test', contains: 'PASS' }, state), false);
  assert.equal(evaluateCondition({ field: 'test', notContains: 'fail' }, state), false);
  assert.equal(evaluateCondition({ field: 'test', notContains: 'pass' }, state), true);
  assert.equal(evaluateCondition({ field: 'nested.passed', equals: true }, state), true);
  assert.equal(evaluateCondition({ field: 'nested.count', notEquals: 3 }, state), false);
  assert.equal(evaluateCondition({ field: 'missing', exists: false }, state), true);
  assert.equal(evaluateCondition({ field: 'missing', exists: true }, state), false);
  assert.equal(evaluateCondition({ field: 'nested.passed', truthy: true }, state), true);
  assert.equal(evaluateCondition({ field: 'test', matches: '^FAIL' }, state), true);
  assert.equal(evaluateCondition({ field: 'test', matches: '(regex lỗi' }, state), false);
  assert.equal(evaluateCondition({ field: 'nested', equals: { passed: true, count: 3 } }, state), true);

  assert.equal(getStateField(state, 'nested.count'), 3);
  assert.equal(getStateField(state, 'khong.co'), undefined);
  assert.equal(renderTemplate('Chủ đề: {{topic}} — kết quả: {{test}}', { topic: 'AI', test: 'ok' }), 'Chủ đề: AI — kết quả: ok');
  assert.equal(renderTemplate('Giữ nguyên {{thieu}}', {}), 'Giữ nguyên {{thieu}}');
});

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

test('runWorkflow: tuyến tính truyền output node trước làm input node sau', async () => {
  const runner = makeFakeRunner();
  const result = await runWorkflow(linearWorkflow, runner, { initialState: { input: 'xin chào' } });
  assert.equal(result.status, 'done');
  assert.equal(result.endNodeId, 'end');
  assert.deepEqual(result.history.map((h) => h.nodeId), ['a', 'b', 'end']);
  assert.ok(result.history.every((h) => h.status === 'ok'));
  // Prompt node a đã render {{input}}; args node b đã render {{a}} từ output node a.
  assert.match(runner.calls[0].prompt, /xin chào/);
  assert.match(runner.calls[1].args.command, /agent:a:/);
  assert.equal(result.output, result.state.lastOutput);
});

test('runWorkflow: research→brief chạy đủ search → read song song → synthesize', async () => {
  const runner = makeFakeRunner({
    search: () => ({
      output: { results: [{ url: 'https://nguon-1.example' }, { url: 'https://nguon-2.example' }] },
    }),
    'read-source-1': ({ node }) => ({ output: `nội dung nguồn 1 (${node.args.url})` }),
    'read-source-2': ({ node }) => ({ output: `nội dung nguồn 2 (${node.args.url})` }),
    synthesize: ({ node }) => ({ output: `BRIEF về ${node.prompt.slice(0, 30)}…` }),
  });
  const result = await runWorkflow(researchBriefWorkflow, runner, { initialState: { topic: 'trí tuệ nhân tạo' } });
  assert.equal(result.status, 'done');
  assert.match(String(result.output), /BRIEF/);
  const ids = result.history.map((h) => h.nodeId);
  assert.deepEqual(ids, ['search', 'read-source-1', 'read-source-2', 'read', 'synthesize', 'end']);
  // 2 nhánh read có parentId là node parallel `read`.
  const branches = result.history.filter((h) => h.parentId === 'read');
  assert.equal(branches.length, 2);
  // URL đã render từ kết quả search.
  assert.match(String(result.state['read-source-1']), /nguon-1\.example/);
  assert.match(String(result.state['read-source-2']), /nguon-2\.example/);
  // Prompt synthesize đã render topic + nội dung 2 nguồn.
  const synthCall = runner.calls.find((c) => c.id === 'synthesize');
  assert.match(synthCall.prompt, /trí tuệ nhân tạo/);
  assert.match(synthCall.prompt, /nguồn 1/);
});

test('runWorkflow: plan→edit→test→fix lặp tới khi test pass', async () => {
  let testRuns = 0;
  const runner = makeFakeRunner({
    plan: () => ({ output: 'plan: sửa file a.ts' }),
    edit: () => ({ output: 'đã sửa file a.ts' }),
    test: () => {
      testRuns += 1;
      return { output: testRuns < 3 ? `FAIL: lỗi ${testRuns}` : 'PASS: 10/10 test pass' };
    },
    fix: () => ({ output: 'đã fix lỗi' }),
  });
  const result = await runWorkflow(planEditTestFixWorkflow, runner, {
    initialState: { task: 'sửa lỗi đăng nhập', files: 'a.ts' },
  });
  assert.equal(result.status, 'done');
  assert.equal(testRuns, 3);
  assert.deepEqual(
    result.history.filter((h) => h.nodeId === 'fix').map((h) => h.status),
    ['ok', 'ok'],
  );
  assert.equal(result.state.test, 'PASS: 10/10 test pass');
});

test('runWorkflow: test fail mãi → dừng ở max-iterations, không lặp vô hạn', async () => {
  const runner = makeFakeRunner({
    plan: () => ({ output: 'plan' }),
    edit: () => ({ output: 'đã sửa' }),
    test: () => ({ output: 'FAIL: vẫn lỗi' }),
    fix: () => ({ output: 'đã fix (vẫn lỗi)' }),
  });
  const result = await runWorkflow(planEditTestFixWorkflow, runner, {
    initialState: { task: 'x', files: '' },
  });
  assert.equal(result.status, 'max-iterations');
  assert.match(result.error, /vượt giới hạn 4/);
  // Node test chạy đúng 4 lần (giới hạn của workflow mẫu), không hơn.
  assert.equal(result.history.filter((h) => h.nodeId === 'test').length, 4);
});

test('runWorkflow: runner throw → status error + history ghi lỗi, state giữ lại để debug', async () => {
  const runner = makeFakeRunner({
    a: () => ({ output: 'xong a' }),
    b: () => { throw new Error('tool shell_exec lỗi kết nối'); },
  });
  const result = await runWorkflow(linearWorkflow, runner, { initialState: { input: 'v' } });
  assert.equal(result.status, 'error');
  assert.match(result.error, /shell_exec/);
  assert.equal(result.state.a, 'xong a');
  const failed = result.history.find((h) => h.nodeId === 'b');
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /lỗi kết nối/);
  assert.equal(result.endNodeId, undefined);
});

test('runWorkflow: workflow không hợp lệ → error ngay, không chạy node nào', async () => {
  const bad = defineWorkflow({ ...linearWorkflow, startNodeId: 'khong-co' });
  const runner = makeFakeRunner();
  const result = await runWorkflow(bad, runner);
  assert.equal(result.status, 'error');
  assert.equal(result.history.length, 0);
  assert.equal(runner.calls.length, 0);
});

test('runWorkflow: abort giữa chừng → stopped', async () => {
  const controller = new AbortController();
  const runner = makeFakeRunner({
    a: async () => {
      controller.abort();
      return { output: 'xong a' };
    },
    b: () => ({ output: 'không được chạy' }),
  });
  const result = await runWorkflow(linearWorkflow, runner, {
    initialState: { input: 'v' },
    signal: controller.signal,
  });
  assert.equal(result.status, 'stopped');
  assert.equal(runner.calls.some((c) => c.id === 'b'), false);
});

test('runWorkflow: runner gợi ý next thắng edge của graph', async () => {
  const wf = defineWorkflow({
    id: 'next-win', name: 'next thắng', startNodeId: 'a',
    nodes: [
      { id: 'a', kind: 'agent', prompt: 'a' },
      { id: 'b', kind: 'agent', prompt: 'b' },
      { id: 'end', kind: 'end' },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'end' },
    ],
  });
  const runner = makeFakeRunner({
    a: () => ({ output: 'nhảy thẳng tới end', next: 'end' }),
    b: () => ({ output: 'không được chạy' }),
  });
  const result = await runWorkflow(wf, runner);
  assert.equal(result.status, 'done');
  assert.deepEqual(result.history.map((h) => h.nodeId), ['a', 'end']);
});

test('runWorkflow: onStep được gọi sau mỗi node', async () => {
  const seen = [];
  const result = await runWorkflow(linearWorkflow, makeFakeRunner(), {
    initialState: { input: 'v' },
    onStep: (rec) => seen.push(rec.nodeId),
  });
  assert.equal(result.status, 'done');
  assert.deepEqual(seen, ['a', 'b', 'end']);
});
