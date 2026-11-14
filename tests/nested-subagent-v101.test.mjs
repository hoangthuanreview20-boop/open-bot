/**
 * nested-subagent-v101.test.mjs — Nested subagents v1.01 (Team T6).
 * Module thuần (packages/core/src/subagents/nested.ts): policy, cây
 * SubagentTree, guard spawn (depth / budget root / budget branch /
 * context tổng / task trùng đang chạy), snapshot, tóm tắt cho cha.
 * Cộng thêm test tích hợp qua AgentRunner thật + mock provider: con
 * spawn cháu bị chặn ở maxDepth, cây ghi đúng node.
 * Run: build core rồi `node --test tests/nested-subagent-v101.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentRunner,
  createMockProvider,
  DEFAULT_NESTED_CONTEXT_BUDGET_PER_NODE,
  DEFAULT_NESTED_CONTEXT_BUDGET_TOTAL,
  DEFAULT_NESTED_MAX_DEPTH,
  DEFAULT_NESTED_MAX_SPAWNS_PER_BRANCH,
  DEFAULT_NESTED_MAX_SPAWNS_PER_ROOT,
  fingerprintTask,
  resolveNestedPolicy,
  SubagentTree,
  summarizeChildForParent,
} from '../packages/core/dist/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function botConfig(overrides = {}) {
  return {
    id: 'bot-test',
    name: 'bot-test',
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'Bạn là trợ lý test.',
    workspaceDir: process.cwd(),
    autoApprove: true,
    ...overrides,
  };
}

function events() {
  return {
    onText: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onApprovalNeeded: async () => true,
  };
}

test('resolveNestedPolicy: mặc định đúng, lỗi rõ khi policy sai', () => {
  const p = resolveNestedPolicy({});
  assert.equal(p.maxDepth, DEFAULT_NESTED_MAX_DEPTH);
  assert.equal(p.maxDepth, 5);
  assert.equal(p.maxSpawnsPerRoot, DEFAULT_NESTED_MAX_SPAWNS_PER_ROOT);
  assert.equal(p.maxSpawnsPerBranch, DEFAULT_NESTED_MAX_SPAWNS_PER_BRANCH);
  assert.equal(p.contextBudgetTokensPerNode, DEFAULT_NESTED_CONTEXT_BUDGET_PER_NODE);
  assert.equal(p.contextBudgetTokensTotal, DEFAULT_NESTED_CONTEXT_BUDGET_TOTAL);
  assert.equal(p.denyConcurrentDuplicateTasks, true);
  const custom = resolveNestedPolicy({
    maxDepth: 2,
    maxSpawnsPerRoot: 3,
    denyConcurrentDuplicateTasks: false,
  });
  assert.equal(custom.maxDepth, 2);
  assert.equal(custom.maxSpawnsPerRoot, 3);
  assert.equal(custom.denyConcurrentDuplicateTasks, false);
  assert.throws(() => resolveNestedPolicy({ maxDepth: 0 }), /maxDepth phải > 0/);
  assert.throws(() => resolveNestedPolicy({ maxSpawnsPerRoot: -1 }), /maxSpawnsPerRoot phải > 0/);
});

test('fingerprintTask: chuẩn hoá khoảng trắng/hoa-thường, cắt 200 ký tự', () => {
  assert.equal(fingerprintTask('  Làm   A  '), 'làm a');
  assert.equal(fingerprintTask('X'.repeat(300)).length, 200);
  assert.notEqual(fingerprintTask('làm A'), fingerprintTask('làm B'));
});

test('SubagentTree: spawn bình thường, depth tăng dần, snapshot lồng nhau', () => {
  const tree = new SubagentTree({ maxDepth: 2 });
  const rootId = tree.rootId;
  const child = tree.requestSpawn(rootId, 'task con 1', { name: 'child-1' });
  assert.equal(child.ok, true);
  assert.equal(child.node.depth, 1);
  assert.equal(child.node.status, 'running');
  assert.equal(tree.root.spawnsUsed, 1);
  const grandchild = tree.requestSpawn(child.node.id, 'task cháu', { name: 'gc' });
  assert.equal(grandchild.ok, true);
  assert.equal(grandchild.node.depth, 2);
  const snap = tree.snapshot();
  assert.equal(snap.totalNodes, 3);
  assert.equal(snap.root.children.length, 1);
  assert.equal(snap.root.children[0].children.length, 1);
  assert.equal(snap.root.children[0].name, 'child-1');
  assert.equal(snap.policy.maxDepth, 2);
  assert.equal(snap.totalOverBudget, false);
});

test('SubagentTree: maxDepth chặn spawn từ node ở độ sâu tối đa', () => {
  const tree = new SubagentTree({ maxDepth: 1 });
  const child = tree.requestSpawn(tree.rootId, 'con', { name: 'c1' });
  assert.equal(child.ok, true);
  const denied = tree.requestSpawn(child.node.id, 'cháu', { name: 'gc' });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'max-depth');
  assert.match(denied.message, /độ sâu lồng tối đa/);
  assert.equal(tree.totalNodes(), 2, 'node bị chặn không được tạo');
});

test('SubagentTree: maxSpawnsPerRoot + maxSpawnsPerBranch chặn đúng lúc', () => {
  const byRoot = new SubagentTree({ maxSpawnsPerRoot: 2 });
  assert.equal(byRoot.requestSpawn(byRoot.rootId, 'a', { name: 'a' }).ok, true);
  const second = byRoot.requestSpawn(byRoot.rootId, 'b', { name: 'b' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'max-spawns-root');

  const byBranch = new SubagentTree({ maxSpawnsPerBranch: 1 });
  assert.equal(byBranch.requestSpawn(byBranch.rootId, 'a', { name: 'a' }).ok, true);
  const denied = byBranch.requestSpawn(byBranch.rootId, 'b', { name: 'b' });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'max-spawns-branch');
  // Nhánh khác vẫn spawn được (budget tính theo cha, không phải toàn cây).
  const child = byBranch.snapshot().root.children[0];
  assert.equal(byBranch.requestSpawn(child.id, 'cháu', { name: 'gc' }).ok, true);
});

test('SubagentTree: task trùng đang chạy cùng cha bị chặn, xong rồi thì được', () => {
  const tree = new SubagentTree({});
  const first = tree.requestSpawn(tree.rootId, '  Làm báo cáo X  ', { name: 'a' });
  assert.equal(first.ok, true);
  const dup = tree.requestSpawn(tree.rootId, 'làm báo cáo x', { name: 'b' });
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'duplicate-task-running');
  // Task khác vẫn được.
  assert.equal(tree.requestSpawn(tree.rootId, 'làm báo cáo Y', { name: 'c' }).ok, true);
  // Con cũ xong → spawn lại task giống được (retry hợp lệ).
  tree.completeNode(first.node.id, 'done');
  assert.equal(tree.requestSpawn(tree.rootId, 'làm báo cáo x', { name: 'd' }).ok, true);
  // Tắt lớp chặn thì task trùng đang chạy vẫn spawn được.
  const open = new SubagentTree({ denyConcurrentDuplicateTasks: false });
  open.requestSpawn(open.rootId, 'task A', { name: 'a' });
  assert.equal(open.requestSpawn(open.rootId, 'task A', { name: 'b' }).ok, true);
});

test('SubagentTree: context budget tổng chặn spawn khi sắp hết', () => {
  const tree = new SubagentTree({ contextBudgetTokensTotal: 100 });
  // Task dài (~500 từ, ước lượng vài trăm token) vượt budget 100.
  const big = tree.requestSpawn(tree.rootId, 'word '.repeat(500), { name: 'big' });
  assert.equal(big.ok, false);
  assert.equal(big.reason, 'context-budget-total');
  // Task ngắn vẫn được.
  assert.equal(tree.requestSpawn(tree.rootId, 'hi', { name: 'small' }).ok, true);
});

test('SubagentTree: recordTokens + overBudget + completeNode', () => {
  const tree = new SubagentTree({ contextBudgetTokensPerNode: 10 });
  const child = tree.requestSpawn(tree.rootId, 'task', { name: 'c' });
  assert.equal(child.ok, true);
  const id = child.node.id;
  assert.equal(tree.recordTokens(id, 5), false);
  assert.equal(tree.isNodeOverBudget(id), false);
  assert.equal(tree.recordTokens(id, 6), true, '11 >= 10 → over budget');
  assert.equal(tree.isNodeOverBudget(id), true);
  assert.equal(tree.totalTokensUsed(), 11);
  const done = tree.completeNode(id, 'done');
  assert.equal(done?.status, 'done');
  assert.ok(done?.endedAt !== undefined);
  const failed = tree.completeNode('không-có-id', 'done');
  assert.equal(failed, undefined);
});

test('SubagentTree: completeNode chỉ ước lượng token khi chưa có usage thật', () => {
  const tree = new SubagentTree({});
  const child = tree.requestSpawn(tree.rootId, 'task', { name: 'c' });
  const id = child.node.id;
  tree.recordTokens(id, 50);
  tree.completeNode(id, 'done', { finalText: 'output dài '.repeat(100) });
  assert.equal(tree.getNode(id)?.tokensUsed, 50, 'không cộng ước lượng lên usage thật');

  const child2 = tree.requestSpawn(tree.rootId, 'task 2', { name: 'c2' });
  tree.completeNode(child2.node.id, 'done', { finalText: 'hello world' });
  assert.ok((tree.getNode(child2.node.id)?.tokensUsed ?? 0) > 0, 'mock provider: ước lượng từ output');
});

test('SubagentTree: requestSpawn với parent lạ → unknown-parent', () => {
  const tree = new SubagentTree({});
  const res = tree.requestSpawn('không-có', 'task', { name: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unknown-parent');
});

test('summarizeChildForParent: giữ trạng thái + cắt ngắn output dài', () => {
  const tree = new SubagentTree({});
  const child = tree.requestSpawn(tree.rootId, 'task', { name: 'worker' });
  tree.recordTokens(child.node.id, 42);
  tree.completeNode(child.node.id, 'done');
  const node = tree.getNode(child.node.id);
  const summary = summarizeChildForParent(node, 'kết quả '.repeat(500), 100);
  assert.match(summary, /worker \(depth 1\) — xong, 42 token/);
  assert.match(summary, /đã cắt ngắn/);
  const errSummary = summarizeChildForParent(
    { ...node, status: 'error', error: 'lỗi mạng' },
    '',
  );
  assert.match(errSummary, /lỗi mạng/);
});

test('AgentRunner tích hợp: con spawn cháu bị chặn ở maxDepth, cây ghi đúng', async () => {
  // Tool 'spawn_next' gọi ctx.runSubagent — con dùng nó để spawn cháu.
  // Ghi lại kết quả tool để kiểm chứng lý do chặn (không chỉ đếm node).
  const toolResults = [];
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
      const out = await ctx.runSubagent(String(args.task ?? ''));
      toolResults.push(out);
      return out;
    },
  };
  // Thứ tự provider.chat: cha vòng 1 (gọi spawn_next) → con vòng 1
  // (gọi spawn_next để spawn cháu) → con vòng 2 (text cuối) → cha vòng 2.
  const provider = createMockProvider([
    { text: '', toolCalls: [{ id: 'c1', name: 'spawn_next', args: { task: 'child task' } }] },
    { text: '', toolCalls: [{ id: 'c2', name: 'spawn_next', args: { task: 'grandchild task' } }] },
    { text: 'child done: cháu bị chặn' },
    { text: 'parent done' },
  ]);
  const runner = new AgentRunner(provider, [spawnNextTool], {
    bot: botConfig(),
    events: events(),
    maxSteps: 5,
    subagentPolicy: { maxDepth: 1 },
  });
  const text = await runner.run('làm việc có spawn lồng');
  assert.match(text, /parent done/);
  // Con đã thử spawn cháu và nhận lỗi maxDepth trong kết quả tool.
  // Thứ tự push: con chạy TRONG tool call của cha nên denial của cháu
  // được push trước, kết quả con (trả cho cha) push sau.
  assert.equal(toolResults.length, 2, 'cha spawn con + con thử spawn cháu');
  assert.match(toolResults[0], /độ sâu lồng tối đa/);
  const snap = runner.subagentTreeSnapshot();
  assert.equal(snap.totalNodes, 2, 'chỉ root + 1 con, cháu không được tạo');
  assert.equal(snap.root.children.length, 1);
  assert.equal(snap.root.children[0].status, 'done');
  assert.equal(snap.policy.maxDepth, 1);
  // Chờ một tick để các promise con hoàn tất hẳn (tránh leak qua test sau).
  await sleep(10);
});

test('SubagentTree: budget riêng từng node (spawn ghi đè policy)', () => {
  const tree = new SubagentTree({ contextBudgetTokensPerNode: 100 });
  const child = tree.requestSpawn(tree.rootId, 'task', { name: 'c', budgetTokens: 10 });
  assert.equal(child.ok, true);
  assert.equal(child.node.budgetTokens, 10);
  assert.equal(tree.getNode(child.node.id)?.budgetTokens, 10);
  // Budget ghi đè sai (<= 0) thì rơi về policy, không throw.
  const fallback = tree.requestSpawn(tree.rootId, 'task 2', { name: 'c2', budgetTokens: 0 });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.node.budgetTokens, 100);
  // Over-budget tính theo budget RIÊNG, không theo policy.
  tree.recordTokens(child.node.id, 9);
  assert.equal(tree.isNodeOverBudget(child.node.id), false);
  tree.recordTokens(child.node.id, 2);
  assert.equal(tree.isNodeOverBudget(child.node.id), true, '11 >= 10 (budget riêng)');
  // Node c2 (budget 100) chưa vượt dù tổng cây đã > 10.
  assert.equal(tree.isNodeOverBudget(fallback.node.id), false);
  const snap = tree.snapshot();
  assert.equal(snap.root.children[0].budgetTokens, 10);
});

test('AgentRunner tích hợp: subagent vượt budget context riêng thì dừng turn, cha không bị dừng', async () => {
  const toolResults = [];
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
      const out = await ctx.runSubagent(String(args.task ?? ''));
      toolResults.push(out);
      return out;
    },
  };
  // Cha vòng 1 gọi spawn_next → con vòng 1 trả text dài (ước lượng
  // > 5 token) → con bị dừng vì budget → cha vòng 2 trả text cuối.
  const provider = createMockProvider([
    { text: '', toolCalls: [{ id: 'c1', name: 'spawn_next', args: { task: 'child task' } }] },
    { text: 'con làm việc rất dài, viết rất nhiều chữ để tốn token' },
    { text: 'parent done' },
  ]);
  const runner = new AgentRunner(provider, [spawnNextTool], {
    bot: botConfig(),
    events: events(),
    maxSteps: 5,
    subagentPolicy: { contextBudgetTokensPerNode: 5 },
  });
  const text = await runner.run('spawn con với budget nhỏ');
  assert.match(text, /parent done/, 'cha chạy tới cuối, không bị dừng theo con');
  assert.match(toolResults[0], /\[context budget\]/, 'con dừng với thông báo budget rõ ràng');
  assert.match(toolResults[0], /vượt ngân sách 5 token/);
  const snap = runner.subagentTreeSnapshot();
  assert.equal(snap.root.children[0].overBudget, true);
  assert.equal(snap.root.overBudget, false, 'root không bị giới hạn budget per-node');
  await sleep(10);
});

test('AgentRunner tích hợp: policy mặc định cho spawn lồng tới depth 5', async () => {
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
  const provider = createMockProvider([
    { text: '', toolCalls: [{ id: 'c1', name: 'spawn_next', args: { task: 'child task' } }] },
    { text: 'child done ok' },
    { text: 'parent done' },
  ]);
  const runner = new AgentRunner(provider, [spawnNextTool], {
    bot: botConfig(),
    events: events(),
    maxSteps: 5,
  });
  const text = await runner.run('spawn 1 tầng');
  assert.match(text, /parent done/);
  const snap = runner.subagentTreeSnapshot();
  assert.equal(snap.totalNodes, 2);
  assert.equal(snap.policy.maxDepth, DEFAULT_NESTED_MAX_DEPTH);
  await sleep(10);
});
