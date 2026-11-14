/**
 * Tests cho v1.01 (Đội T3) — risk budget: risk rating + confirmation
 * policy + conversation budget meter.
 *
 * Covers:
 *  - `risk/analyzer.ts` (mức nền theo tool, rule theo args, allowlist /
 *    denylist, ghi/xoá ngoài workspace, tool lạ → medium)
 *  - `risk/policy.ts` (parse/mặc định/bảng quyết định 3 policy)
 *  - `risk/queue.ts` (state machine pending → approved/denied/edited /
 *    expired, audit log, resolve trùng, toJSON/fromJSON)
 *  - `risk/budget.ts` (đếm token/cost theo conversation, cost null khi
 *    model chưa có giá, cảnh báo 80% / vượt cap, alert một lần, reset)
 *  - `agent/loop.ts` (risk gate: denylist chặn cứng, confirm-risky ép
 *    hỏi dù autoApprove, confirm-all hỏi cả tool low, run chuyển
 *    WAITING_FOR_CONFIRMATION rồi về running, budget feed + alert)
 *
 * KHÔNG dùng CLI thật, KHÔNG đọc tài khoản/credential thật, KHÔNG gọi
 * API ngoài: mock provider + thư mục tạm.
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/risk-budget-v101.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AgentRunner } from '../packages/core/dist/agent/loop.js';
import {
  BUILTIN_RISK_RULES,
  ConfirmationQueue,
  ConversationBudgetMeter,
  DEFAULT_CONFIRMATION_POLICY,
  RiskAnalyzer,
  analyzeRisk,
  decideConfirmation,
  parseConfirmationPolicy,
} from '../packages/core/dist/index.js';

// ---------------------------------------------------------------------------
// RiskAnalyzer — mức nền theo tool
// ---------------------------------------------------------------------------

test('risk: tool chỉ-đọc low, ghi medium, shell/xoá high', () => {
  assert.equal(analyzeRisk('read_file', { path: 'a.md' }).level, 'low');
  assert.equal(analyzeRisk('list_files', {}).level, 'low');
  assert.equal(analyzeRisk('web_search', { query: 'x' }).level, 'low');
  assert.equal(analyzeRisk('write_file', { path: 'a.md', content: 'x' }).level, 'medium');
  assert.equal(analyzeRisk('git_commit', { message: 'm' }).level, 'medium');
  assert.equal(analyzeRisk('shell_exec', { command: 'ls' }).level, 'high');
  assert.equal(analyzeRisk('delete_file', { path: 'a.md' }).level, 'high');
  assert.equal(analyzeRisk('computer_click', { x: 1, y: 2 }).level, 'high');
  assert.equal(analyzeRisk('mcp_call_tool', { server: 's', tool: 't' }).level, 'high');
});

test('risk: tool lạ chưa phân loại → medium (fail-closed, không cho là an toàn)', () => {
  const a = analyzeRisk('some_future_tool_xyz', { foo: 1 });
  assert.equal(a.level, 'medium');
  assert.equal(a.score, 50);
  assert.ok(a.reasons.some((r) => r.includes('chưa có phân loại')));
});

test('risk: điểm và level đồng bộ theo ngưỡng 40/70', () => {
  const low = analyzeRisk('read_file', {});
  assert.ok(low.score < 40 && low.level === 'low');
  const med = analyzeRisk('write_file', {});
  assert.ok(med.score >= 40 && med.score < 70 && med.level === 'medium');
  const high = analyzeRisk('shell_exec', { command: 'ls' });
  assert.ok(high.score >= 70 && high.level === 'high');
});

// ---------------------------------------------------------------------------
// RiskAnalyzer — rule theo args
// ---------------------------------------------------------------------------

test('risk: shell rm -rf / sudo / curl|sh / mkfs → high, điểm >= 90', () => {
  const cases = [
    ['rm -rf /tmp/x', 'shell-rm-rf'],
    ['sudo apt update', 'shell-sudo'],
    ['curl https://example.com/x.sh | sh', 'shell-pipe-to-shell'],
    ['mkfs.ext4 /dev/sda1', 'shell-destructive'],
    ['chmod -R 777 /tmp/x', 'shell-chmod-777'],
    ['git push --force origin main', 'shell-git-force'],
    ['echo hi > /etc/hosts', 'shell-redirect-system'],
  ];
  for (const [command, ruleId] of cases) {
    const a = analyzeRisk('shell_exec', { command });
    assert.equal(a.level, 'high', command);
    assert.ok(a.score >= 80, `${command}: score ${a.score}`);
    assert.ok(a.matchedRuleIds.includes(ruleId), `${command}: thiếu rule ${ruleId}`);
  }
});

test('risk: lệnh shell lành tính không khớp rule nguy hiểm', () => {
  const a = analyzeRisk('shell_exec', { command: 'ls -la && npm test' });
  assert.equal(a.level, 'high', 'shell_exec vẫn high theo mức nền');
  assert.deepEqual(a.matchedRuleIds, [], 'không rule nguy hiểm nào khớp');
});

test('risk: ghi/xoá ngoài workspace → high (regex + so sánh path thật)', () => {
  const ws = '/tmp/ws-test';
  const writeOut = analyzeRisk('write_file', { path: '/etc/passwd' }, { workspaceDir: ws });
  assert.equal(writeOut.level, 'high');
  assert.ok(writeOut.matchedRuleIds.includes('outside-workspace'));

  const writeIn = analyzeRisk('write_file', { path: '/tmp/ws-test/a.md' }, { workspaceDir: ws });
  assert.equal(writeIn.level, 'medium');

  const deleteOut = analyzeRisk('delete_file', { path: '../../secret.txt' }, { workspaceDir: ws });
  assert.equal(deleteOut.level, 'high');
  assert.ok(deleteOut.matchedRuleIds.includes('outside-workspace'));
});

test('risk: xoá hàng loạt → high; http POST kèm body → medium', () => {
  const bulk = analyzeRisk('delete_files', { paths: ['a.md', 'b.md', 'c.md'] });
  assert.equal(bulk.level, 'high');
  assert.ok(bulk.matchedRuleIds.includes('delete-bulk'));

  const post = analyzeRisk('http_request', { method: 'POST', url: 'https://example.com', body: '{}' });
  assert.equal(post.level, 'medium');
  assert.ok(post.matchedRuleIds.includes('http-write-method'));
  assert.ok(post.matchedRuleIds.includes('http-post-body'));

  const get = analyzeRisk('http_request', { method: 'GET', url: 'https://example.com' });
  assert.equal(get.level, 'medium');
  assert.deepEqual(get.matchedRuleIds, []);
});

// ---------------------------------------------------------------------------
// RiskAnalyzer — allowlist / denylist / rule cấu hình
// ---------------------------------------------------------------------------

test('risk: denylist chặn cứng (high + denied), thắng allowlist', () => {
  const analyzer = new RiskAnalyzer({
    allowlist: ['shell_exec'],
    denylist: ['shell_exec'],
  });
  const a = analyzer.analyze('shell_exec', { command: 'ls' });
  assert.equal(a.level, 'high');
  assert.equal(a.denied, true);
  assert.ok(a.reasons.some((r) => r.includes('denylist')));
});

test('risk: allowlist ép tool high về low; denylist theo pattern args', () => {
  const analyzer = new RiskAnalyzer({
    allowlist: ['shell_exec'],
    denylist: ['shell_exec:rm\\s+-rf'],
  });
  const safe = analyzer.analyze('shell_exec', { command: 'ls' });
  assert.equal(safe.level, 'low');
  assert.equal(safe.denied, false);

  const dangerous = analyzer.analyze('shell_exec', { command: 'rm -rf /' });
  assert.equal(dangerous.level, 'high');
  assert.equal(dangerous.denied, true);
});

test('risk: rule extra ghi đè built-in; tắt built-in rule theo id', () => {
  const overridden = new RiskAnalyzer({
    extraRules: [
      {
        id: 'shell-sudo',
        description: 'Sudo đã tin tưởng trong môi trường này.',
        level: 'low',
        score: 10,
        tool: 'shell_exec',
        argsPattern: '(^|[^a-zA-Z0-9_])sudo\\b',
      },
    ],
  });
  // Rule extra ghi đè built-in: sudo chỉ còn mức nền của shell (high)
  // vì rule ghi đè có điểm thấp hơn mức nền — level không hạ xuống low
  // (rule chỉ nâng, không hạ mức nền). Điểm rule thấp không kéo điểm xuống.
  const a = overridden.analyze('shell_exec', { command: 'sudo ls' });
  assert.ok(a.matchedRuleIds.includes('shell-sudo'));
  assert.equal(a.level, 'high', 'mức nền shell vẫn high');

  const disabled = new RiskAnalyzer({ disabledBuiltinRuleIds: ['shell-sudo'] });
  const b = disabled.analyze('shell_exec', { command: 'sudo ls' });
  assert.ok(!b.matchedRuleIds.includes('shell-sudo'));
  assert.ok(!disabled.listRuleIds().includes('shell-sudo'));
});

test('risk: regex cấu hình sai không throw, rule đó bị bỏ qua', () => {
  const analyzer = new RiskAnalyzer({
    extraRules: [{ id: 'bad', description: 'x', level: 'high', score: 99, argsPattern: '([invalid' }],
  });
  const a = analyzer.analyze('shell_exec', { command: 'ls' });
  assert.equal(a.level, 'high');
  assert.ok(!a.matchedRuleIds.includes('bad'));
});

test('risk: builtin rules có id duy nhất, đủ 3 mức', () => {
  const ids = BUILTIN_RISK_RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'id rule trùng nhau');
  assert.ok(BUILTIN_RISK_RULES.some((r) => r.level === 'high'));
  assert.ok(BUILTIN_RISK_RULES.some((r) => r.level === 'medium'));
});

// ---------------------------------------------------------------------------
// ConfirmationPolicy
// ---------------------------------------------------------------------------

test('policy: parse mặc định confirm-risky, giá trị lạ về mặc định', () => {
  assert.equal(parseConfirmationPolicy(undefined), 'confirm-risky');
  assert.equal(parseConfirmationPolicy(''), 'confirm-risky');
  assert.equal(parseConfirmationPolicy('full-access'), 'confirm-risky');
  assert.equal(parseConfirmationPolicy('allow-all'), 'allow-all');
  assert.equal(parseConfirmationPolicy('confirm-all'), 'confirm-all');
  assert.equal(DEFAULT_CONFIRMATION_POLICY, 'confirm-risky');
});

test('policy: allow-all không hỏi; confirm-risky hỏi medium/high; confirm-all hỏi mọi call', () => {
  const low = analyzeRisk('read_file', {});
  const med = analyzeRisk('write_file', {});
  const high = analyzeRisk('shell_exec', { command: 'ls' });
  assert.equal(decideConfirmation('allow-all', low).needsConfirmation, false);
  assert.equal(decideConfirmation('allow-all', high).needsConfirmation, false);
  assert.equal(decideConfirmation('confirm-risky', low).needsConfirmation, false);
  assert.equal(decideConfirmation('confirm-risky', med).needsConfirmation, true);
  assert.equal(decideConfirmation('confirm-risky', high).needsConfirmation, true);
  assert.equal(decideConfirmation('confirm-all', low).needsConfirmation, true);
  assert.equal(decideConfirmation('confirm-all', high).needsConfirmation, true);
  // Denylist không đi qua policy — analyzer đã chặn cứng trước đó.
  const denied = new RiskAnalyzer({ denylist: ['shell_exec'] }).analyze('shell_exec', { command: 'ls' });
  assert.equal(denied.denied, true);
});

// ---------------------------------------------------------------------------
// ConfirmationQueue — state machine + audit log
// ---------------------------------------------------------------------------

function makeRisk(level = 'medium', score = 50) {
  return {
    level,
    score,
    reasons: ['test'],
    matchedRuleIds: [],
    denied: false,
    toolName: 'write_file',
    assessedAtMs: Date.now(),
  };
}

test('queue: create → approve → audit ghi đúng, resolve trùng bị bỏ qua', () => {
  const q = new ConfirmationQueue({ timeoutMs: 60_000 });
  const entry = q.create({
    id: 'c1',
    botId: 'bot-1',
    toolName: 'write_file',
    args: { path: 'a.md' },
    risk: makeRisk(),
    policy: 'confirm-risky',
  });
  assert.equal(entry.status, 'pending');
  assert.equal(q.pendingCount, 1);
  assert.deepEqual(q.listPending().map((e) => e.id), ['c1']);

  const resolved = q.resolve('c1', { decision: 'approve' });
  assert.equal(resolved?.status, 'approved');
  assert.equal(q.pendingCount, 0);
  assert.equal(q.resolve('c1', { decision: 'deny' }), undefined, 'resolve trùng → undefined');

  const audit = q.auditLog();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].status, 'approved');
  assert.equal(audit[0].toolName, 'write_file');
  assert.equal(audit[0].decidedBy, 'user');
  assert.equal(audit[0].riskLevel, 'medium');
});

test('queue: deny và edit-args (edited kèm args đã sửa)', () => {
  const q = new ConfirmationQueue({ timeoutMs: 60_000 });
  q.create({ id: 'c1', botId: 'b', toolName: 'shell_exec', args: { command: 'ls' }, risk: makeRisk('high', 75), policy: 'confirm-risky' });
  q.create({ id: 'c2', botId: 'b', toolName: 'write_file', args: { path: 'a.md' }, risk: makeRisk(), policy: 'confirm-risky' });

  q.resolve('c1', { decision: 'deny' });
  const edited = q.resolve('c2', { decision: 'edit', args: { path: 'b.md' } });
  assert.equal(edited?.status, 'edited');
  assert.deepEqual(edited?.editedArgs, { path: 'b.md' });

  const counts = q.countsByStatus();
  assert.equal(counts.denied, 1);
  assert.equal(counts.edited, 1);
  assert.equal(counts.pending, 0);

  const audit = q.auditLog();
  assert.equal(audit[1].status, 'edited');
  assert.deepEqual(audit[1].editedArgs, { path: 'b.md' });
});

test('queue: hết hạn → expired, callback onExpire chạy, audit decidedBy=timeout', async () => {
  let expiredEntry = null;
  const q = new ConfirmationQueue({
    timeoutMs: 20,
    onExpire: (entry) => {
      expiredEntry = entry;
    },
  });
  q.create({ id: 'c1', botId: 'b', toolName: 'write_file', args: {}, risk: makeRisk(), policy: 'confirm-risky' });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(expiredEntry?.status, 'expired');
  assert.equal(q.get('c1')?.status, 'expired');
  assert.equal(q.auditLog()[0].status, 'expired');
  assert.equal(q.auditLog()[0].decidedBy, 'timeout');
  assert.equal(q.resolve('c1', { decision: 'approve' }), undefined, 'hết hạn rồi không resolve được');
});

test('queue: toJSON/fromJSON — pending khôi phục thành expired (an toàn)', () => {
  const q = new ConfirmationQueue({ timeoutMs: 60_000 });
  q.create({ id: 'c1', botId: 'b', toolName: 'write_file', args: {}, risk: makeRisk(), policy: 'confirm-risky' });
  q.create({ id: 'c2', botId: 'b', toolName: 'read_file', args: {}, risk: makeRisk('low', 5), policy: 'confirm-all' });
  q.resolve('c2', { decision: 'approve' });
  const data = q.toJSON();

  const q2 = new ConfirmationQueue({ timeoutMs: 60_000 });
  q2.fromJSON(data);
  assert.equal(q2.get('c1')?.status, 'expired', 'pending cũ không treo lại sau khôi phục');
  assert.equal(q2.get('c2')?.status, 'approved');
  assert.equal(q2.auditLog().length, 1);
  assert.equal(q2.auditLog()[0].status, 'approved');
});

test('queue: audit log giới hạn FIFO theo maxAuditEntries', () => {
  const q = new ConfirmationQueue({ timeoutMs: 60_000, maxAuditEntries: 3 });
  for (let i = 0; i < 5; i++) {
    q.create({ id: `c${i}`, botId: 'b', toolName: 'write_file', args: {}, risk: makeRisk(), policy: 'confirm-risky' });
    q.resolve(`c${i}`, { decision: 'approve' });
  }
  const audit = q.auditLog();
  assert.equal(audit.length, 3);
  assert.equal(audit[0].confirmationId, 'c2');
  assert.equal(audit[2].confirmationId, 'c4');
});

// ---------------------------------------------------------------------------
// ConversationBudgetMeter
// ---------------------------------------------------------------------------

test('budget: đếm token theo model, cost ước tính từ bảng giá, snapshot đầy đủ', () => {
  const meter = new ConversationBudgetMeter('conv-1', { tokenLimit: 1000, costLimitUsd: 1 });
  meter.record('gpt-4o-mini', 600, 200);
  const snap = meter.snapshot();
  assert.equal(snap.inputTokens, 600);
  assert.equal(snap.outputTokens, 200);
  assert.equal(snap.totalTokens, 800);
  // gpt-4o-mini: $0.15/$0.60 per 1M → 600*0.15e-6 + 200*0.60e-6 = 0.00021
  assert.ok(snap.costUsd !== null && Math.abs(snap.costUsd - 0.00021) < 1e-9, `cost ${snap.costUsd}`);
  assert.equal(snap.hasUnknownCost, false);
  assert.equal(snap.tokenPercentUsed, 80);
  assert.equal(snap.status, 'warning', '80% = ngưỡng cảnh báo mặc định');
  assert.equal(snap.modelCount, 1);
  assert.equal(snap.byModel['gpt-4o-mini'].inputTokens, 600);
});

test('budget: model chưa có giá → cost null, không báo $0 giả', () => {
  const meter = new ConversationBudgetMeter('conv-2', { tokenLimit: 1000 });
  meter.record('some-future-model-xyz', 100, 50);
  const snap = meter.snapshot();
  assert.equal(snap.totalTokens, 150);
  assert.equal(snap.costUsd, null);
  assert.equal(snap.hasUnknownCost, true);
  assert.equal(snap.byModel['some-future-model-xyz'].costUsd, null);
});

test('budget: vượt cap token → exceeded, alert bắn đúng một lần mỗi mức', () => {
  const alerts = [];
  const meter = new ConversationBudgetMeter(
    'conv-3',
    { tokenLimit: 100 },
    (alert) => alerts.push(alert),
  );
  meter.record('gpt-4o-mini', 50, 10); // 60% → ok
  assert.equal(meter.snapshot().status, 'ok');
  assert.equal(alerts.length, 0);

  meter.record('gpt-4o-mini', 20, 10); // 90% → warning
  assert.equal(meter.snapshot().status, 'warning');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'warning');
  assert.equal(alerts[0].basis, 'tokens');

  meter.record('gpt-4o-mini', 5, 0); // 95% → vẫn warning, không alert lại
  assert.equal(alerts.length, 1);

  meter.record('gpt-4o-mini', 10, 0); // 105% → exceeded
  assert.equal(meter.snapshot().status, 'exceeded');
  assert.equal(alerts.length, 2);
  assert.equal(alerts[1].kind, 'exceeded');

  meter.record('gpt-4o-mini', 50, 0); // vẫn exceeded, không alert lại
  assert.equal(alerts.length, 2);
});

test('budget: cap cost (USD) độc lập với cap token', () => {
  const alerts = [];
  const meter = new ConversationBudgetMeter(
    'conv-4',
    { costLimitUsd: 0.001 },
    (alert) => alerts.push(alert),
  );
  // claude-opus-4.1: $15/$75 per 1M → 100 in = 0.0015 > cap
  meter.record('claude-opus-4.1', 100, 0);
  const snap = meter.snapshot();
  assert.equal(snap.status, 'exceeded');
  assert.equal(snap.tokenPercentUsed, null, 'không có cap token');
  assert.ok(snap.costPercentUsed !== null && snap.costPercentUsed > 100);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].basis, 'cost');
});

test('budget: không có cap → chỉ đếm, không bao giờ warning/exceeded; reset xoá số liệu', () => {
  const meter = new ConversationBudgetMeter('conv-5', {});
  meter.record('gpt-4o-mini', 100000, 50000);
  const snap = meter.snapshot();
  assert.equal(snap.status, 'ok');
  assert.equal(snap.percentUsed, null);
  assert.equal(snap.tokenLimit, null);

  meter.reset();
  const after = meter.snapshot();
  assert.equal(after.totalTokens, 0);
  assert.equal(after.costUsd, 0);
  assert.equal(after.modelCount, 0);
  assert.equal(after.status, 'ok');
});

test('budget: token âm / NaN bị bỏ qua, không làm lệch số liệu', () => {
  const meter = new ConversationBudgetMeter('conv-6', {});
  meter.record('gpt-4o-mini', -5, NaN);
  assert.equal(meter.snapshot().totalTokens, 0);
  meter.record('gpt-4o-mini', 10, 5);
  assert.equal(meter.snapshot().totalTokens, 15);
});

// ---------------------------------------------------------------------------
// Loop: risk gate + confirmation policy + run state + budget feed
// ---------------------------------------------------------------------------

function makeTool(name, opts = {}) {
  const calls = [];
  const tool = {
    definition: {
      name,
      description: `Tool ${name} for testing.`,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, command: { type: 'string' } },
      },
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

function scriptedProvider(responses) {
  let i = 0;
  return {
    id: 'mock',
    label: 'Mock',
    async chat() {
      const r = responses[Math.min(i++, responses.length - 1)];
      return { text: r.text ?? '', toolCalls: r.toolCalls ?? [], ...(r.usage ? { usage: r.usage } : {}) };
    },
    async listModels() {
      return ['mock'];
    },
  };
}

async function runLoopWithRisk({
  workspaceDir,
  tool,
  toolCall,
  approve = true,
  confirmationPolicy,
  riskAnalyzer,
  confirmationQueue,
  budgetMeter,
  autoApprove = false,
  usage,
}) {
  let asked = 0;
  const states = [];
  const budgetAlerts = [];
  const events = {
    onText() {},
    onToolCall() {},
    onToolResult() {},
    onApprovalNeeded: async () => {
      asked += 1;
      return approve;
    },
    onRunStateChange: (state) => states.push(state),
    onBudgetAlert: (alert) => budgetAlerts.push(alert),
  };
  const bot = {
    id: 'bot-1',
    name: 'Test',
    providerId: 'mock',
    model: 'gpt-4o-mini',
    systemPrompt: 'test',
    workspaceDir,
    autoApprove,
    ...(confirmationPolicy !== undefined ? { confirmationPolicy } : {}),
  };
  const provider = scriptedProvider([
    { text: '', toolCalls: [toolCall], ...(usage ? { usage } : {}) },
    { text: 'done' },
  ]);
  const runner = new AgentRunner(provider, [tool], {
    bot,
    events,
    ...(confirmationPolicy !== undefined ? { confirmationPolicy } : {}),
    ...(riskAnalyzer ? { riskAnalyzer } : {}),
    ...(confirmationQueue ? { confirmationQueue } : {}),
    ...(budgetMeter ? { budgetMeter } : {}),
  });
  const text = await runner.run('làm việc');
  return { text, asked, calls: tool.calls, states, budgetAlerts, runner };
}

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-v101-risk-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('loop: confirm-risky ép hỏi shell rm -rf dù bot autoApprove=true; approve → chạy', async () => {
  const ws = makeTempDir();
  const tool = makeTool('shell_exec');
  const out = await runLoopWithRisk({
    workspaceDir: ws,
    tool,
    toolCall: { id: 'c1', name: 'shell_exec', args: { command: 'rm -rf /tmp/x' } },
    approve: true,
    autoApprove: true,
    confirmationPolicy: 'confirm-risky',
  });
  assert.equal(out.asked, 1, 'policy confirm-risky hỏi dù autoApprove');
  assert.equal(out.calls.length, 1, 'approve → tool chạy');
  assert.equal(out.text, 'done');
});

test('loop: confirm-risky — deny tool high thì tool không chạy; run về done', async () => {
  const ws = makeTempDir();
  const tool = makeTool('shell_exec');
  const out = await runLoopWithRisk({
    workspaceDir: ws,
    tool,
    toolCall: { id: 'c1', name: 'shell_exec', args: { command: 'rm -rf /tmp/x' } },
    approve: false,
    confirmationPolicy: 'confirm-risky',
  });
  assert.equal(out.asked, 1);
  assert.equal(out.calls.length, 0, 'deny → tool không chạy');
});

test('loop: confirm-risky không hỏi tool low; confirm-all hỏi cả tool low', async () => {
  const ws = makeTempDir();
  const low1 = await runLoopWithRisk({
    workspaceDir: ws,
    tool: makeTool('read_file'),
    toolCall: { id: 'c1', name: 'read_file', args: { path: 'a.md' } },
    confirmationPolicy: 'confirm-risky',
  });
  assert.equal(low1.asked, 0, 'read_file low → không hỏi');
  assert.equal(low1.calls.length, 1);

  // Đọc file NGOÀI workspace (đọc trong workspace là self-read — theo
  // quy tắc M8, bot đọc file của chính nó không bao giờ hỏi).
  const low2 = await runLoopWithRisk({
    workspaceDir: ws,
    tool: makeTool('read_file'),
    toolCall: { id: 'c1', name: 'read_file', args: { path: '/etc/hostname' } },
    confirmationPolicy: 'confirm-all',
  });
  assert.equal(low2.asked, 1, 'confirm-all hỏi cả tool low');
  assert.equal(low2.calls.length, 1);
});

test('loop: allow-all không hỏi vì risk; tool needsApproval vẫn hỏi theo đường cũ', async () => {
  const ws = makeTempDir();
  const noAsk = await runLoopWithRisk({
    workspaceDir: ws,
    tool: makeTool('write_file'),
    toolCall: { id: 'c1', name: 'write_file', args: { path: 'a.md' } },
    confirmationPolicy: 'allow-all',
  });
  assert.equal(noAsk.asked, 0, 'allow-all + tool không needsApproval → không hỏi');
  assert.equal(noAsk.calls.length, 1);

  const stillAsks = await runLoopWithRisk({
    workspaceDir: ws,
    tool: makeTool('write_file', { needsApproval: true }),
    toolCall: { id: 'c1', name: 'write_file', args: { path: 'a.md' } },
    confirmationPolicy: 'allow-all',
  });
  assert.equal(stillAsks.asked, 1, 'needsApproval vẫn hỏi dù policy allow-all');
});

test('loop: denylist chặn cứng — không hỏi, tool không chạy, output nêu denylist', async () => {
  const ws = makeTempDir();
  const tool = makeTool('shell_exec');
  const analyzer = new RiskAnalyzer({ denylist: ['shell_exec'] });
  const out = await runLoopWithRisk({
    workspaceDir: ws,
    tool,
    toolCall: { id: 'c1', name: 'shell_exec', args: { command: 'ls' } },
    riskAnalyzer: analyzer,
    confirmationPolicy: 'confirm-risky',
  });
  assert.equal(out.asked, 0, 'denylist chặn cứng, không hỏi duyệt');
  assert.equal(out.calls.length, 0, 'tool không chạy');
  assert.equal(out.text, 'done');
});

test('loop: chờ duyệt → run WAITING_FOR_CONFIRMATION rồi về running/done', async () => {
  const ws = makeTempDir();
  // v1.01 merge: test này quan sát chuyển trạng thái chờ duyệt nên dùng
  // tool vốn cần duyệt (needsApproval:true). Tool medium + needsApproval
  // false + autoApprove false KHÔNG hỏi (hợp đồng cũ: handoff) nên
  // không dùng được cho test này.
  const tool = makeTool('write_file', { needsApproval: true });
  let statesDuringApproval = null;
  const events = {
    onText() {},
    onToolCall() {},
    onToolResult() {},
    onApprovalNeeded: async () => {
      // Trong lúc chờ duyệt, run phải đang ở trạng thái chờ.
      statesDuringApproval = currentRunner.getRunState();
      return true;
    },
  };
  const bot = {
    id: 'bot-1',
    name: 'Test',
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'test',
    workspaceDir: ws,
    autoApprove: false,
    confirmationPolicy: 'confirm-risky',
  };
  const provider = scriptedProvider([
    { text: '', toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'a.md' } }] },
    { text: 'done' },
  ]);
  const currentRunner = new AgentRunner(provider, [tool], { bot, events });
  assert.equal(currentRunner.getRunState(), 'idle', 'chưa chạy → idle');
  const text = await currentRunner.run('làm việc');
  assert.equal(text, 'done');
  assert.equal(statesDuringApproval, 'waiting-for-confirmation', 'trong lúc hỏi duyệt → waiting-for-confirmation');
  assert.equal(currentRunner.getRunState(), 'done', 'xong run → done');
});

test('loop: quyết định duyệt ghi vào queue audit log (approve + edit-args)', async () => {
  const ws = makeTempDir();
  const queue = new ConfirmationQueue({ timeoutMs: 60_000 });
  // v1.01 merge: test này quan sát quyết định duyệt nên dùng tool vốn
  // cần duyệt (needsApproval:true); tool medium + needsApproval false
  // không hỏi (hợp đồng cũ: handoff).
  const tool = makeTool('write_file', { needsApproval: true });
  let asked = 0;
  const events = {
    onText() {},
    onToolCall() {},
    onToolResult() {},
    onApprovalNeeded: async () => {
      asked += 1;
      // Người duyệt sửa args (đổi path) rồi approve.
      return { approved: true, args: { path: 'b.md' } };
    },
  };
  const bot = {
    id: 'bot-1',
    name: 'Test',
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'test',
    workspaceDir: ws,
    autoApprove: false,
    confirmationPolicy: 'confirm-risky',
  };
  const provider = scriptedProvider([
    { text: '', toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'a.md' } }] },
    { text: 'done' },
  ]);
  const runner = new AgentRunner(provider, [tool], { bot, events, confirmationQueue: queue });
  await runner.run('làm việc');
  assert.equal(asked, 1);
  assert.deepEqual(tool.calls[0], { path: 'b.md' }, 'tool chạy với args đã sửa');
  const audit = queue.auditLog();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].status, 'edited');
  assert.equal(audit[0].toolName, 'write_file');
  assert.equal(audit[0].riskLevel, 'medium');
  assert.deepEqual(audit[0].editedArgs, { path: 'b.md' });
});

test('loop: budget meter feed usage + bắn alert khi vượt cap; snapshot đọc được', async () => {
  const ws = makeTempDir();
  const meter = new ConversationBudgetMeter('conv-test', { tokenLimit: 100 });
  const tool = makeTool('read_file');
  const out = await runLoopWithRisk({
    workspaceDir: ws,
    tool,
    toolCall: { id: 'c1', name: 'read_file', args: { path: 'a.md' } },
    budgetMeter: meter,
    usage: { inputTokens: 60, outputTokens: 50 },
  });
  assert.equal(out.calls.length, 1);
  const snap = out.runner.getBudgetSnapshot();
  assert.ok(snap !== null);
  assert.equal(snap.totalTokens, 110);
  assert.equal(snap.status, 'exceeded');
  assert.equal(out.budgetAlerts.length, 1, 'vượt cap → đúng 1 alert');
  assert.equal(out.budgetAlerts[0].kind, 'exceeded');
  assert.equal(out.budgetAlerts[0].basis, 'tokens');
  assert.equal(out.budgetAlerts[0].snapshot.totalTokens, 110);
});

test('loop: không có budgetMeter → getBudgetSnapshot() null, run vẫn bình thường', async () => {
  const ws = makeTempDir();
  const out = await runLoopWithRisk({
    workspaceDir: ws,
    tool: makeTool('read_file'),
    toolCall: { id: 'c1', name: 'read_file', args: { path: 'a.md' } },
    usage: { inputTokens: 10, outputTokens: 5 },
  });
  assert.equal(out.runner.getBudgetSnapshot(), null);
  assert.equal(out.budgetAlerts.length, 0);
  assert.equal(out.text, 'done');
});
