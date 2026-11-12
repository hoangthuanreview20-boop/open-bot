/**
 * Tests for v0.35 (P1-7): auto-approve rules — user-configured allowlist
 * rules that let safe tool calls run without a manual approval click.
 *
 * Covers `packages/core/src/approval/rules.ts` (matching, validation,
 * file-backed store), the loop wiring in `packages/core/src/agent/loop.ts`
 * (`autoApproveCheck` consulted before both approval branches, with a
 * trace span + log naming the rule), and the coordinator RPC
 * (`list/add/remove/setEnabled` + `executeRun` passing the check into
 * the runner).
 *
 * Safety properties tested here (fail-closed):
 *  - fresh store = no rules = everything still asks approval;
 *  - denylist beats auto-approve (a `rm` rule never auto-approves
 *    `rm -rf /`, and a blocked pattern cannot even be added);
 *  - compound / redirect / substitution commands never match a shell rule;
 *  - a disabled rule never matches; a bot-scoped rule never matches
 *    another bot.
 *
 * No real API key, no network. Mock provider + in-process coordinator.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   xvfb-run -a node --test tests/auto-approve-v035.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AUTO_APPROVE_RULES_FILE_NAME,
  AutoApproveRuleStore,
  findMatchingAutoApproveRule,
  matchAutoApproveRule,
  matchesArgsPattern,
  validateAutoApproveRuleInput,
} from '../packages/core/dist/approval/index.js';
import { AgentRunner } from '../packages/core/dist/agent/loop.js';
import { AgentPermissions } from '../packages/core/dist/agent/permissions.js';
import { Tracer } from '../packages/core/dist/tracing/index.js';
import { AgentCoordinator } from '../packages/core/dist/coordinator/coordinator.js';
import { createDenylistHook } from '../packages/tools/dist/sandbox.js';
import { HookRegistry, HookRunner } from '../packages/core/dist/hooks/index.js';

const tempDirs = [];
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Matching (pure)
// ---------------------------------------------------------------------------

test('mặc định tắt: store rỗng thì không rule nào khớp', () => {
  const store = new AutoApproveRuleStore();
  assert.deepEqual(store.list(), []);
  assert.equal(
    store.findMatch({ botId: 'b1', toolName: 'shell_exec', args: { command: 'npm test' } }),
    undefined,
  );
  assert.equal(
    findMatchingAutoApproveRule([], {
      botId: 'b1',
      toolName: 'write_file',
      args: { path: 'src/a.ts' },
    }),
    undefined,
  );
});

test('rule shell khớp tiền tố đúng ranh giới token, không khớp lệnh khác', () => {
  const rule = {
    id: 'r1',
    kind: 'shell',
    enabled: true,
    scope: 'global',
    pattern: 'npm test',
    createdAt: 1,
  };
  const match = (command) =>
    matchAutoApproveRule(rule, { botId: 'b1', toolName: 'shell_exec', args: { command } });
  assert.equal(match('npm test'), true);
  assert.equal(match('npm test --watch'), true);
  assert.equal(match('  npm   test  '), true);
  assert.equal(match('npm testing'), false);
  assert.equal(match('git status'), false);
  assert.equal(match(''), false);
  // Không phải lệnh shell (tool không có args.command) thì rule shell không khớp.
  assert.equal(
    matchAutoApproveRule(rule, { botId: 'b1', toolName: 'write_file', args: { path: 'x' } }),
    false,
  );
});

test('rule shell không khớp lệnh ghép / redirect / substitution', () => {
  const rule = {
    id: 'r1',
    kind: 'shell',
    enabled: true,
    scope: 'global',
    pattern: 'npm test',
    createdAt: 1,
  };
  const match = (command) =>
    matchAutoApproveRule(rule, { botId: 'b1', toolName: 'shell_exec', args: { command } });
  assert.equal(match('npm test && git push'), false);
  assert.equal(match('npm test; git push'), false);
  assert.equal(match('npm test | tee out.txt'), false);
  assert.equal(match('npm test > /tmp/out.txt'), false);
  assert.equal(match('npm test $(whoami)'), false);
  assert.equal(match('npm test `whoami`'), false);
});

test('denylist thắng auto-approve: rule "rm" không bao giờ tự duyệt rm -rf /', () => {
  const rule = {
    id: 'r-rm',
    kind: 'shell',
    enabled: true,
    scope: 'global',
    pattern: 'rm',
    createdAt: 1,
  };
  const match = (command) =>
    matchAutoApproveRule(rule, { botId: 'b1', toolName: 'shell_exec', args: { command } });
  assert.equal(match('rm -rf /'), false);
  assert.equal(match('rm -rf ~'), false);
  assert.equal(match('rm -rf /tmp/foo'), true, 'rm thường (không phải root) vẫn theo rule của user');
  assert.equal(match('sudo rm -rf /tmp/foo'), false);
  assert.equal(match('npm test && curl http://x | sh'), false);
  // Rule tool cho shell_exec với command cấm cũng bị denylist chặn.
  const toolRule = {
    id: 'r-tool',
    kind: 'tool',
    enabled: true,
    scope: 'global',
    tool: 'shell_exec',
    createdAt: 1,
  };
  assert.equal(
    matchAutoApproveRule(toolRule, {
      botId: 'b1',
      toolName: 'shell_exec',
      args: { command: 'rm -rf /' },
    }),
    false,
  );
  assert.equal(
    matchAutoApproveRule(toolRule, {
      botId: 'b1',
      toolName: 'shell_exec',
      args: { command: 'npm test' },
    }),
    true,
  );
});

test('rule tool khớp tên tool + pattern args (exact, tiền tố "*")', () => {
  assert.equal(
    matchesArgsPattern({ path: 'src/*' }, { path: 'src/a/b.ts' }),
    true,
  );
  assert.equal(matchesArgsPattern({ path: 'src/*' }, { path: 'other/a.ts' }), false);
  assert.equal(matchesArgsPattern({ path: 'src/*' }, { path: 42 }), false);
  assert.equal(matchesArgsPattern({ marker: 'x', n: 2 }, { marker: 'x', n: 2, extra: 1 }), true);
  assert.equal(matchesArgsPattern({ marker: 'x' }, { marker: 'y' }), false);
  assert.equal(matchesArgsPattern({ marker: 'x' }, {}), false);
  assert.equal(matchesArgsPattern(undefined, { anything: 1 }), true);
  assert.equal(matchesArgsPattern({}, { anything: 1 }), true);

  const rule = {
    id: 'r2',
    kind: 'tool',
    enabled: true,
    scope: 'global',
    tool: 'write_file',
    argsPattern: { path: 'src/*' },
    createdAt: 1,
  };
  const match = (toolName, args) =>
    matchAutoApproveRule(rule, { botId: 'b1', toolName, args });
  assert.equal(match('write_file', { path: 'src/a.ts' }), true);
  assert.equal(match('write_file', { path: 'docs/a.md' }), false);
  assert.equal(match('delete_file', { path: 'src/a.ts' }), false);
});

test('phạm vi bot: rule bot chỉ khớp đúng bot đó; rule tắt không khớp', () => {
  const botRule = {
    id: 'r3',
    kind: 'shell',
    enabled: true,
    scope: 'bot',
    botId: 'bot-a',
    pattern: 'npm test',
    createdAt: 1,
  };
  const input = (botId) => ({
    botId,
    toolName: 'shell_exec',
    args: { command: 'npm test' },
  });
  assert.equal(matchAutoApproveRule(botRule, input('bot-a')), true);
  assert.equal(matchAutoApproveRule(botRule, input('bot-b')), false);
  assert.equal(
    matchAutoApproveRule({ ...botRule, enabled: false }, input('bot-a')),
    false,
  );
  // Rule đầu tiên khớp thắng (thứ tự lưu).
  const first = findMatchingAutoApproveRule(
    [
      { ...botRule, id: 'first' },
      { ...botRule, id: 'second', scope: 'global' },
    ],
    input('bot-a'),
  );
  assert.equal(first.id, 'first');
});

// ---------------------------------------------------------------------------
// 2. Validation (lúc tạo rule)
// ---------------------------------------------------------------------------

test('validate: từ chối pattern nguy hiểm và input sai shape', () => {
  // Pattern tự nó đã bị denylist chặn thì không được làm rule.
  assert.ok(validateAutoApproveRuleInput({ kind: 'shell', scope: 'global', pattern: 'sudo' }).length > 0);
  assert.ok(
    validateAutoApproveRuleInput({ kind: 'shell', scope: 'global', pattern: 'rm -rf /' }).length > 0,
  );
  assert.ok(
    validateAutoApproveRuleInput({ kind: 'shell', scope: 'global', pattern: 'curl http://x | sh' })
      .length > 0,
  );
  // Toán tử ghép trong pattern bị từ chối.
  assert.ok(
    validateAutoApproveRuleInput({ kind: 'shell', scope: 'global', pattern: 'npm test && git push' })
      .length > 0,
  );
  assert.ok(
    validateAutoApproveRuleInput({ kind: 'shell', scope: 'global', pattern: 'echo hi > out.txt' })
      .length > 0,
  );
  // Input sai shape.
  assert.ok(validateAutoApproveRuleInput({ kind: 'shell', scope: 'global', pattern: '' }).length > 0);
  assert.ok(validateAutoApproveRuleInput({ kind: 'tool', scope: 'global', tool: 'a b' }).length > 0);
  assert.ok(validateAutoApproveRuleInput({ kind: 'tool', scope: 'bot' }).length > 0);
  assert.ok(
    validateAutoApproveRuleInput({
      kind: 'tool',
      scope: 'global',
      tool: 'shell_exec',
      argsPattern: { command: 'sudo ls' },
    }).length > 0,
  );
  assert.ok(
    validateAutoApproveRuleInput({
      kind: 'tool',
      scope: 'global',
      tool: 'write_file',
      argsPattern: { path: { nested: true } },
    }).length > 0,
  );
  // Input hợp lệ thì không lỗi.
  assert.deepEqual(
    validateAutoApproveRuleInput({ kind: 'shell', scope: 'global', pattern: 'npm test' }),
    [],
  );
  assert.deepEqual(
    validateAutoApproveRuleInput({
      kind: 'tool',
      scope: 'bot',
      botId: 'b1',
      tool: 'write_file',
      argsPattern: { path: 'src/*' },
      note: 'Chỉ duyệt ghi trong src/',
    }),
    [],
  );
});

// ---------------------------------------------------------------------------
// 3. Store: CRUD + persist + load lại + file hỏng fail-closed
// ---------------------------------------------------------------------------

test('store: thêm/xoá/bật-tắt + persist xuống file + load lại', () => {
  const dir = makeTempDir('open-bot-auto-approve-');
  const filePath = path.join(dir, AUTO_APPROVE_RULES_FILE_NAME);
  const store = new AutoApproveRuleStore(filePath);
  assert.deepEqual(store.list(), []);

  const shellRule = store.add({
    kind: 'shell',
    scope: 'global',
    pattern: 'npm test',
    note: 'Test chạy ngay',
  });
  assert.equal(typeof shellRule.id, 'string');
  assert.equal(shellRule.enabled, true);
  assert.equal(shellRule.pattern, 'npm test');
  assert.equal(shellRule.note, 'Test chạy ngay');
  assert.ok(fs.existsSync(filePath), 'thêm rule phải ghi file ngay');
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600, 'file rules mode 0600');

  const toolRule = store.add({
    kind: 'tool',
    scope: 'bot',
    botId: 'bot-a',
    tool: 'write_file',
    argsPattern: { path: 'src/*' },
    enabled: false,
  });
  assert.equal(toolRule.enabled, false);

  // Load lại từ cùng file: đủ cả hai rule.
  const reloaded = new AutoApproveRuleStore(filePath);
  assert.equal(reloaded.list().length, 2);
  assert.deepEqual(
    reloaded.list().map((r) => r.id),
    [shellRule.id, toolRule.id],
  );
  // Bật rule tool rồi load lại: trạng thái đã lưu.
  const updated = reloaded.setEnabled(toolRule.id, true);
  assert.equal(updated.enabled, true);
  assert.equal(new AutoApproveRuleStore(filePath).list()[1].enabled, true);
  // Xoá rule shell rồi load lại: chỉ còn rule tool.
  assert.equal(reloaded.remove(shellRule.id), true);
  assert.equal(reloaded.remove(shellRule.id), false, 'xoá lần 2 trả false');
  assert.equal(new AutoApproveRuleStore(filePath).list().length, 1);
  // setEnabled cho id lạ thì undefined.
  assert.equal(reloaded.setEnabled('no-such-id', true), undefined);
});

test('store: thêm rule nguy hiểm thì throw, không ghi file', () => {
  const dir = makeTempDir('open-bot-auto-approve-');
  const store = new AutoApproveRuleStore(path.join(dir, AUTO_APPROVE_RULES_FILE_NAME));
  assert.throws(
    () => store.add({ kind: 'shell', scope: 'global', pattern: 'sudo' }),
    /denylist/,
  );
  assert.deepEqual(store.list(), []);
});

test('store: file hỏng thì load rỗng, không throw (fail-closed)', () => {
  const dir = makeTempDir('open-bot-auto-approve-');
  const filePath = path.join(dir, AUTO_APPROVE_RULES_FILE_NAME);
  fs.writeFileSync(filePath, '{ không phải json');
  const store = new AutoApproveRuleStore(filePath);
  assert.deepEqual(store.list(), []);
  assert.equal(
    store.findMatch({ botId: 'b1', toolName: 'shell_exec', args: { command: 'npm test' } }),
    undefined,
  );
  // Thêm rule mới vẫn ghi đè file hỏng được.
  store.add({ kind: 'shell', scope: 'global', pattern: 'npm test' });
  assert.equal(new AutoApproveRuleStore(filePath).list().length, 1);
});

test('store: chỉ giữ trong bộ nhớ khi không có filePath', () => {
  const store = new AutoApproveRuleStore();
  assert.equal(store.path, undefined);
  const rule = store.add({ kind: 'shell', scope: 'global', pattern: 'git status' });
  assert.equal(store.list().length, 1);
  assert.equal(store.remove(rule.id), true);
  assert.deepEqual(store.list(), []);
});

// ---------------------------------------------------------------------------
// 4. Loop wiring: rule khớp thì chạy ngay (cả 2 nhánh approval), trace ghi rõ
// ---------------------------------------------------------------------------

function scriptedProvider(responses) {
  let i = 0;
  return {
    id: 'mock',
    label: 'Mock',
    async chat() {
      const r = responses[Math.min(i++, responses.length - 1)];
      return { text: r.text ?? '', toolCalls: r.toolCalls ?? [] };
    },
    async listModels() {
      return ['mock'];
    },
  };
}

function makeShellTool(executions) {
  return {
    definition: {
      name: 'shell_exec',
      description: 'Fake shell tool.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
    needsApproval: true,
    async execute(args) {
      executions.push(args.command);
      return `ran ${args.command}`;
    },
  };
}

const bot = {
  id: 'bot-aa',
  name: 'Bot AA',
  providerId: 'mock',
  model: 'mock',
  systemPrompt: 'You are a test bot.',
  workspaceDir: '/tmp',
  autoApprove: false,
};

test('loop: rule shell khớp thì tool needsApproval chạy ngay, không hỏi', async () => {
  const executions = [];
  let approvalAsked = 0;
  const tracer = new Tracer({ runId: 'run-1', botId: bot.id });
  const runner = new AgentRunner(scriptedProvider([
    { toolCalls: [{ id: 'c1', name: 'shell_exec', args: { command: 'npm test' } }] },
    { text: 'xong' },
  ]), [makeShellTool(executions)], {
    bot,
    events: {
      onText: () => undefined,
      onToolCall: () => undefined,
      onToolResult: () => undefined,
      onApprovalNeeded: async () => {
        approvalAsked += 1;
        return true;
      },
      onAskUser: async () => '',
      onProgress: () => undefined,
      onFinalSummary: () => undefined,
    },
    tracer,
    autoApproveCheck: (input) =>
      findMatchingAutoApproveRule(
        [
          {
            id: 'rule-npm-test',
            kind: 'shell',
            enabled: true,
            scope: 'global',
            pattern: 'npm test',
            createdAt: 1,
          },
        ],
        input,
      ),
  });
  const result = await runner.run('chạy test giúp tôi');
  assert.equal(result, 'xong');
  assert.deepEqual(executions, ['npm test']);
  assert.equal(approvalAsked, 0, 'rule khớp thì không được hỏi duyệt');
  const approvalSpans = tracer.spans.filter((s) => s.kind === 'approval');
  assert.equal(approvalSpans.length, 1, 'phải có 1 span approval ghi lần tự duyệt');
  assert.equal(approvalSpans[0].attributes?.autoApproved, true);
  assert.equal(approvalSpans[0].attributes?.ruleId, 'rule-npm-test');
  assert.equal(approvalSpans[0].status, 'ok');
});

test('loop: không rule khớp thì hỏi duyệt như cũ; từ chối thì tool không chạy', async () => {
  const executions = [];
  let approvalAsked = 0;
  const runner = new AgentRunner(scriptedProvider([
    { toolCalls: [{ id: 'c1', name: 'shell_exec', args: { command: 'git push' } }] },
    { text: 'không chạy' },
  ]), [makeShellTool(executions)], {
    bot,
    events: {
      onText: () => undefined,
      onToolCall: () => undefined,
      onToolResult: () => undefined,
      onApprovalNeeded: async () => {
        approvalAsked += 1;
        return false;
      },
      onAskUser: async () => '',
      onProgress: () => undefined,
      onFinalSummary: () => undefined,
    },
    autoApproveCheck: () => undefined,
  });
  await runner.run('push giúp tôi');
  assert.equal(approvalAsked, 1);
  assert.deepEqual(executions, [], 'từ chối thì tool không chạy');
});

test('loop: nhánh policy ask (tool không needsApproval) cũng được rule tự duyệt', async () => {
  const executions = [];
  let approvalAsked = 0;
  const permissions = new AgentPermissions();
  permissions.setBotPolicy(bot.id, { policies: { shell_exec: 'ask' } });
  const tool = makeShellTool(executions);
  tool.needsApproval = false;
  const runner = new AgentRunner(scriptedProvider([
    { toolCalls: [{ id: 'c1', name: 'shell_exec', args: { command: 'git status' } }] },
    { text: 'xong' },
  ]), [tool], {
    bot,
    events: {
      onText: () => undefined,
      onToolCall: () => undefined,
      onToolResult: () => undefined,
      onApprovalNeeded: async () => {
        approvalAsked += 1;
        return true;
      },
      onAskUser: async () => '',
      onProgress: () => undefined,
      onFinalSummary: () => undefined,
    },
    permissions,
    autoApproveCheck: (input) =>
      findMatchingAutoApproveRule(
        [
          {
            id: 'rule-git-status',
            kind: 'shell',
            enabled: true,
            scope: 'global',
            pattern: 'git status',
            createdAt: 1,
          },
        ],
        input,
      ),
  });
  await runner.run('xem status');
  assert.deepEqual(executions, ['git status']);
  assert.equal(approvalAsked, 0, 'policy ask nhưng rule khớp thì không hỏi');
});

test('loop: denylist hook chặn trước auto-approve (rule "rm" không cứu được rm -rf /)', async () => {
  const executions = [];
  let approvalAsked = 0;
  const registry = new HookRegistry();
  registry.register(createDenylistHook());
  const hookRunner = new HookRunner(registry);
  const runner = new AgentRunner(scriptedProvider([
    { toolCalls: [{ id: 'c1', name: 'shell_exec', args: { command: 'rm -rf /' } }] },
    { text: 'xong' },
  ]), [makeShellTool(executions)], {
    bot,
    events: {
      onText: () => undefined,
      onToolCall: () => undefined,
      onToolResult: () => undefined,
      onApprovalNeeded: async () => {
        approvalAsked += 1;
        return true;
      },
      onAskUser: async () => '',
      onProgress: () => undefined,
      onFinalSummary: () => undefined,
    },
    hooks: hookRunner,
    autoApproveCheck: (input) =>
      findMatchingAutoApproveRule(
        [
          {
            id: 'rule-rm',
            kind: 'shell',
            enabled: true,
            scope: 'global',
            pattern: 'rm',
            createdAt: 1,
          },
        ],
        input,
      ),
  });
  await runner.run('xoá giúp tôi');
  assert.deepEqual(executions, [], 'lệnh cấm không được chạy dù rule khớp tiền tố');
  assert.equal(approvalAsked, 0, 'lệnh cấm bị hook chặn, không hiện thẻ duyệt vô ích');
});

// ---------------------------------------------------------------------------
// 5. Coordinator RPC + run thật
// ---------------------------------------------------------------------------

function makeCoordinatorSetup(botId, dir, mockResponses, dataDir) {
  const events = [];
  const approvals = [];
  const executions = [];
  let coordinator;
  coordinator = new AgentCoordinator({
    dataDir,
    toolFactory: () => [
      {
        definition: {
          name: 'shell_exec',
          description: 'Fake shell tool.',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
        needsApproval: true,
        async execute(args) {
          executions.push(args.command);
          return `ran ${args.command}`;
        },
      },
    ],
    emit: (n) => {
      events.push(n);
      if (n.data?.kind === 'approval-needed') {
        approvals.push(n.data.payload);
        const callId = n.data.payload.callId;
        setTimeout(() => coordinator.respondApproval({ callId, approved: true }), 0);
      }
    },
  });
  const botConfig = {
    id: botId,
    name: `Bot ${botId}`,
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir: dir,
    autoApprove: false,
  };
  return {
    coordinator,
    events,
    approvals,
    executions,
    async createBot() {
      await coordinator.createBot({
        bot: botConfig,
        provider: { id: 'mock', label: 'Mock', mockResponses },
      });
    },
    async destroy() {
      try {
        await coordinator.destroyBot({ botId });
      } catch {
        // Best-effort cleanup.
      }
      coordinator.shutdown();
    },
  };
}

test('coordinator RPC: CRUD rule + run tự duyệt khi rule bật, hỏi lại khi tắt', async () => {
  const dir = makeTempDir('open-bot-auto-approve-coord-');
  const dataDir = makeTempDir('open-bot-auto-approve-data-');
  const botId = 'bot-aa-coord';
  const setup = makeCoordinatorSetup(botId, dir, [
    { toolCalls: [{ id: 'c1', name: 'shell_exec', args: { command: 'npm test' } }] },
    { text: 'run 1 xong' },
    { toolCalls: [{ id: 'c2', name: 'shell_exec', args: { command: 'npm test' } }] },
    { text: 'run 2 xong' },
  ], dataDir);
  try {
    await setup.createBot();
    // Mặc định tắt: chưa có rule nào.
    assert.deepEqual((await setup.coordinator.listAutoApproveRules()).rules, []);

    const { rule } = await setup.coordinator.addAutoApproveRule({
      kind: 'shell',
      scope: 'global',
      pattern: 'npm test',
      note: 'Cho test chạy ngay',
    });
    assert.equal(typeof rule.id, 'string');
    assert.equal(rule.enabled, true);
    // Rule đã persist xuống <dataDir>/auto-approve-rules.json.
    assert.ok(fs.existsSync(path.join(dataDir, AUTO_APPROVE_RULES_FILE_NAME)));
    assert.equal((await setup.coordinator.listAutoApproveRules()).rules.length, 1);

    // Run 1 — rule bật: không hiện thẻ approval, tool chạy luôn.
    const first = await setup.coordinator.run({ botId, text: 'chạy test' });
    assert.equal(first.text, 'run 1 xong');
    assert.deepEqual(setup.approvals, [], 'rule bật thì run không hiện thẻ approval');
    assert.deepEqual(setup.executions, ['npm test']);

    // Tắt rule → run 2 lại hỏi approval như cũ (responder đồng ý nên tool vẫn chạy).
    const toggled = await setup.coordinator.setAutoApproveRuleEnabled({
      id: rule.id,
      enabled: false,
    });
    assert.equal(toggled.rule.enabled, false);
    const second = await setup.coordinator.run({ botId, text: 'chạy test lần nữa' });
    assert.equal(second.text, 'run 2 xong');
    assert.equal(setup.approvals.length, 1, 'rule tắt thì run phải hỏi approval');
    assert.equal(setup.approvals[0].call.name, 'shell_exec');
    assert.deepEqual(setup.executions, ['npm test', 'npm test']);

    // Xoá rule → danh sách rỗng.
    assert.deepEqual(await setup.coordinator.removeAutoApproveRule({ id: rule.id }), {
      removed: true,
    });
    assert.deepEqual((await setup.coordinator.listAutoApproveRules()).rules, []);
    // Rule đã persist: coordinator mới cùng dataDir vẫn thấy danh sách rỗng (không còn rule).
    const fresh = new AutoApproveRuleStore(path.join(dataDir, AUTO_APPROVE_RULES_FILE_NAME));
    assert.deepEqual(fresh.list(), []);
  } finally {
    await setup.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('coordinator RPC: thêm rule nguy hiểm / bật rule lạ đều lỗi rõ', async () => {
  const dir = makeTempDir('open-bot-auto-approve-coord-');
  const dataDir = makeTempDir('open-bot-auto-approve-data-');
  const setup = makeCoordinatorSetup('bot-aa-err', dir, [], dataDir);
  try {
    await setup.createBot();
    // addAutoApproveRule / setAutoApproveRuleEnabled là method đồng bộ
    // (store trong process) nên lỗi ném ra đồng bộ — assert.throws.
    assert.throws(
      () =>
        setup.coordinator.addAutoApproveRule({
          kind: 'shell',
          scope: 'global',
          pattern: 'sudo',
        }),
      /denylist/,
    );
    assert.throws(
      () => setup.coordinator.setAutoApproveRuleEnabled({ id: 'no-such-id', enabled: true }),
      /Không có rule/,
    );
    assert.throws(
      () => setup.coordinator.removeAutoApproveRule({ id: '' }),
      /cần params/,
    );
  } finally {
    await setup.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('coordinator: rule "rm" không tự duyệt rm -rf / (denylist hook chặn, tool không chạy)', async () => {
  const dir = makeTempDir('open-bot-auto-approve-coord-');
  const dataDir = makeTempDir('open-bot-auto-approve-data-');
  const botId = 'bot-aa-deny';
  const setup = makeCoordinatorSetup(botId, dir, [
    { toolCalls: [{ id: 'c1', name: 'shell_exec', args: { command: 'rm -rf /' } }] },
    { text: 'run xong' },
  ], dataDir);
  try {
    await setup.createBot();
    await setup.coordinator.addAutoApproveRule({
      kind: 'shell',
      scope: 'global',
      pattern: 'rm',
    });
    const result = await setup.coordinator.run({ botId, text: 'xoá giúp tôi' });
    assert.equal(result.text, 'run xong');
    assert.deepEqual(setup.executions, [], 'lệnh cấm không được chạy dù có rule rm');
    assert.deepEqual(setup.approvals, [], 'lệnh cấm bị hook chặn trước cả thẻ duyệt');
  } finally {
    await setup.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('coordinator: rule tool theo bot chỉ tự duyệt đúng bot đó', async () => {
  const dirA = makeTempDir('open-bot-auto-approve-coord-');
  const dirB = makeTempDir('open-bot-auto-approve-coord-');
  const dataDir = makeTempDir('open-bot-auto-approve-data-');
  const events = [];
  const approvals = [];
  const executions = [];
  let coordinator;
  coordinator = new AgentCoordinator({
    dataDir,
    toolFactory: () => [
      {
        definition: {
          name: 'shell_exec',
          description: 'Fake shell tool.',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
        needsApproval: true,
        async execute(args) {
          executions.push(args.command);
          return `ran ${args.command}`;
        },
      },
    ],
    emit: (n) => {
      events.push(n);
      if (n.data?.kind === 'approval-needed') {
        approvals.push(n.data.payload);
        const callId = n.data.payload.callId;
        setTimeout(() => coordinator.respondApproval({ callId, approved: true }), 0);
      }
    },
  });
  const mkBot = (id, dir) => ({
    id,
    name: `Bot ${id}`,
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir: dir,
    autoApprove: false,
  });
  try {
    await coordinator.createBot({
      bot: mkBot('bot-a', dirA),
      provider: {
        id: 'mock',
        label: 'Mock',
        mockResponses: [
          { toolCalls: [{ id: 'c1', name: 'shell_exec', args: { command: 'npm test' } }] },
          { text: 'a xong' },
        ],
      },
    });
    await coordinator.createBot({
      bot: mkBot('bot-b', dirB),
      provider: {
        id: 'mock',
        label: 'Mock',
        mockResponses: [
          { toolCalls: [{ id: 'c2', name: 'shell_exec', args: { command: 'npm test' } }] },
          { text: 'b xong' },
        ],
      },
    });
    await coordinator.addAutoApproveRule({
      kind: 'shell',
      scope: 'bot',
      botId: 'bot-a',
      pattern: 'npm test',
    });
    const ra = await coordinator.run({ botId: 'bot-a', text: 'chạy test' });
    assert.equal(ra.text, 'a xong');
    assert.deepEqual(approvals, [], 'bot-a có rule riêng nên không hỏi');
    const rb = await coordinator.run({ botId: 'bot-b', text: 'chạy test' });
    assert.equal(rb.text, 'b xong');
    assert.equal(approvals.length, 1, 'bot-b không có rule nên vẫn hỏi');
    assert.deepEqual(executions, ['npm test', 'npm test']);
  } finally {
    try {
      await coordinator.destroyBot({ botId: 'bot-a' });
    } catch {
      // Best-effort.
    }
    try {
      await coordinator.destroyBot({ botId: 'bot-b' });
    } catch {
      // Best-effort.
    }
    coordinator.shutdown();
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});
