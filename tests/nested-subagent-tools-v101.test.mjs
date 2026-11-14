/**
 * nested-subagent-tools-v101.test.mjs — Tools nested subagent v1.01 (Team T6).
 * list_subagent_tree + fanout_tasks (packages/tools/src/nestedSubagentTools.ts):
 * parse args JSON, nối ctx.subagentTree / ctx.runFanOutWithGrading, lỗi rõ
 * khi thiếu wiring thay vì crash. Run: build tools rồi
 * `node --test tests/nested-subagent-tools-v101.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNestedSubagentTools,
  formatSubagentTree,
  NESTED_SUBAGENT_TOOLS,
} from '../packages/tools/dist/nestedSubagentTools.js';

function snapshotFixture() {
  return {
    root: {
      id: 'root',
      parentId: null,
      name: 'root',
      depth: 0,
      status: 'running',
      task: '',
      tokensUsed: 10,
      spawnsUsed: 1,
      startedAt: 1,
      overBudget: false,
      children: [
        {
          id: 'c1',
          parentId: 'root',
          name: 'researcher',
          depth: 1,
          status: 'done',
          task: 'tìm tài liệu',
          model: 'mock',
          tokensUsed: 40,
          spawnsUsed: 0,
          startedAt: 2,
          endedAt: 3,
          overBudget: false,
          children: [],
        },
      ],
    },
    totalNodes: 2,
    totalTokensUsed: 50,
    totalBudgetTokens: 1000,
    totalOverBudget: false,
    policy: { maxDepth: 5, maxSpawnsPerRoot: 50, maxSpawnsPerBranch: 10 },
  };
}

const CTX = { workspaceDir: process.cwd(), botId: 'bot-test' };

test('createNestedSubagentTools: 2 tool, tên + approval đúng', () => {
  const tools = createNestedSubagentTools();
  assert.equal(tools.length, 2);
  assert.deepEqual(
    tools.map((t) => t.definition.name),
    ['list_subagent_tree', 'fanout_tasks'],
  );
  assert.equal(tools.find((t) => t.definition.name === 'list_subagent_tree').needsApproval, false);
  assert.equal(tools.find((t) => t.definition.name === 'fanout_tasks').needsApproval, true);
  assert.equal(NESTED_SUBAGENT_TOOLS.length, 2, 'placeholder cùng shape');
});

test('formatSubagentTree: vẽ cây có thụt lề, trạng thái, token, cờ over-budget', () => {
  const text = formatSubagentTree(snapshotFixture().root);
  assert.match(text, /root \[đang chạy\] depth 0, 10 token, 1 con/);
  assert.match(text, /  - researcher \[xong\] depth 1, 40 token, 0 con · model mock/);
  const over = snapshotFixture().root;
  over.children[0].overBudget = true;
  assert.match(formatSubagentTree(over), /vượt context budget/);
});

test('list_subagent_tree: thiếu wiring thì lỗi rõ; có wiring thì in cây + budget', async () => {
  const [listTree] = createNestedSubagentTools();
  const noCtx = await listTree.execute({}, CTX);
  assert.match(noCtx, /Error: .*chưa được hỗ trợ/);
  const ok = await listTree.execute(
    {},
    { ...CTX, subagentTree: () => snapshotFixture() },
  );
  assert.match(ok, /Cây subagent: 2 node, 50\/1000 token/);
  assert.match(ok, /researcher/);
});

test('fanout_tasks: thiếu wiring thì lỗi rõ', async () => {
  const [, fanout] = createNestedSubagentTools();
  const out = await fanout.execute(
    {
      tasks: [{ name: 'a', task: 'x' }],
      rubric: { id: 'r', name: 'R', criteria: [{ id: 'c', label: 'C' }] },
    },
    CTX,
  );
  assert.match(out, /Error: .*chưa được hỗ trợ/);
});

test('fanout_tasks: parse tasks + rubric, grader keyword từ keywords trong rubric', async () => {
  const [, fanout] = createNestedSubagentTools();
  let captured = null;
  const fakeRun = async (tasks, rubric, opts) => {
    captured = { tasks, rubric, opts };
    // Chấm thử bằng grader đã nhận để kiểm chứng keyword rules.
    const { gradeOutput } = await import('../packages/core/dist/index.js');
    const grade = await gradeOutput('đáp án 42', rubric, opts.grader);
    return { summary: `fake summary, ratio=${grade.ratio}` };
  };
  const out = await fanout.execute(
    {
      tasks: [
        { name: 'a', task: 'viết báo cáo', instructions: 'ngắn gọn' },
        { name: 'b', task: 'kiểm tra', role: 'reviewer' },
      ],
      rubric: {
        id: 'r1',
        name: 'R',
        passThreshold: 0.5,
        criteria: [{ id: 'correct', label: 'Đúng', keywords: ['42'] }],
      },
      concurrency: 2,
      maxRounds: 2,
    },
    { ...CTX, runFanOutWithGrading: fakeRun },
  );
  assert.match(out, /fake summary, ratio=1/);
  assert.equal(captured.tasks.length, 2);
  assert.equal(captured.tasks[0].name, 'a');
  assert.equal(captured.tasks[0].spec.instructions, 'ngắn gọn');
  assert.equal(captured.tasks[1].spec.role, 'reviewer');
  assert.equal(captured.rubric.id, 'r1');
  assert.equal(captured.opts.concurrency, 2);
  assert.equal(captured.opts.maxRounds, 2);
  assert.equal(typeof captured.opts.grader, 'function');
});

test('fanout_tasks: JSON string cũng parse được; JSON hỏng / rubric sai thì lỗi rõ, không throw', async () => {
  const [, fanout] = createNestedSubagentTools();
  const fakeRun = async () => ({ summary: 'ok' });
  const ctx = { ...CTX, runFanOutWithGrading: fakeRun };
  const viaString = await fanout.execute(
    {
      tasks: JSON.stringify([{ name: 'a', task: 'x' }]),
      rubric: JSON.stringify({ id: 'r', name: 'R', criteria: [{ id: 'c', keywords: ['x'] }] }),
    },
    ctx,
  );
  assert.equal(viaString, 'ok');
  const badJson = await fanout.execute({ tasks: '{không json', rubric: {} }, ctx);
  assert.match(badJson, /Error: .*JSON hợp lệ/);
  const badRubric = await fanout.execute(
    { tasks: [{ name: 'a', task: 'x' }], rubric: { id: 'r', name: 'R', criteria: [] } },
    ctx,
  );
  assert.match(badRubric, /Error: .*criteria.*mảng không rỗng/);
  const dupNames = await fanout.execute(
    {
      tasks: [
        { name: 'dup', task: 'a' },
        { name: 'dup', task: 'b' },
      ],
      rubric: { id: 'r', name: 'R', criteria: [{ id: 'c' }] },
    },
    { ...ctx, runFanOutWithGrading: async () => { throw new Error('Tên subagent phải duy nhất'); } },
  );
  assert.match(dupNames, /Error: .*duy nhất/);
});

test('fanout_tasks: keywordRules riêng thắng keywords trong rubric', async () => {
  const [, fanout] = createNestedSubagentTools();
  let captured = null;
  const fakeRun = async (_tasks, _rubric, opts) => {
    captured = opts;
    const { gradeOutput } = await import('../packages/core/dist/index.js');
    // Output chứa 'từ khoá' (rule riêng) nhưng KHÔNG chứa 'không'
    // (keyword trong rubric) — ratio=1 chứng tỏ rule riêng thắng.
    const grade = await gradeOutput('đáp án dùng từ khoá chuẩn', { id: 'r', name: 'R', criteria: [{ id: 'c' }] }, opts.grader);
    return { summary: `ratio=${grade.ratio}` };
  };
  const out = await fanout.execute(
    {
      tasks: [{ name: 'a', task: 'x' }],
      rubric: { id: 'r', name: 'R', criteria: [{ id: 'c', keywords: ['không'] }] },
      keywordRules: { c: ['từ khoá'] },
    },
    { ...CTX, runFanOutWithGrading: fakeRun },
  );
  // 'từ khoá' xuất hiện trong output → ratio 1: rule riêng được dùng
  // (keyword trong rubric là 'không' sẽ cho ratio 0 với output này).
  assert.match(out, /ratio=1/);
  assert.equal(typeof captured.grader, 'function');
});
