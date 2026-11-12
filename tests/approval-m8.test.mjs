/**
 * Tests cho M8 — Approval card trong chat + mức approval theo bot +
 * quy tắc "bot đọc file của chính nó không bao giờ hỏi".
 *
 * Covers:
 *  - `approval/levels.ts` (parse/mặc định/bảng quyết định/shouldAskForCall)
 *  - `approval/selfRead.ts` (tool đọc trong/ngoài workspace, lệnh shell
 *    đọc đơn giản, dispatcher gom nhóm, redact args cho thẻ)
 *  - `agent/loop.ts` (mức + self-read trong executeCallInner: hỏi đúng
 *    lúc, Allow → chạy, Deny → dừng run, timeout broker → từ chối)
 *  - `coordinator.ts` (payload approval-needed có reason + argsSummary
 *    đã redact; "Allow always" = rule auto-approve phạm vi bot)
 *  - `harness/broker.ts` qua `LocalHarness` (uiHandler treo + decide()
 *    qua RPC → request resolve, không rò promise)
 *
 * KHÔNG dùng CLI thật, KHÔNG đọc tài khoản/credential thật, KHÔNG gọi
 * API ngoài: mock provider + thư mục tạm. Secret giả chỉ xuất hiện
 * trong args test để chứng minh thẻ redact được chúng.
 *
 * Run sau khi build core + tools:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 *   xvfb-run -a node --test tests/approval-m8.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AgentRunner } from '../packages/core/dist/agent/loop.js';
import {
  AgentCoordinator,
  LocalHarness,
  PermissionBroker,
  decideApprovalLevel,
  isSelfReadCall,
  isSelfReadShellCommand,
  parseBotApprovalLevel,
  shouldAskForCall,
  summarizeArgsForCard,
} from '../packages/core/dist/index.js';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-m8-approval-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Mức approval (pure)
// ---------------------------------------------------------------------------

test('mức approval: mặc định ask-for-writes, giá trị lạ về mặc định', () => {
  assert.equal(parseBotApprovalLevel(undefined), 'ask-for-writes');
  assert.equal(parseBotApprovalLevel(''), 'ask-for-writes');
  assert.equal(parseBotApprovalLevel('full-access'), 'ask-for-writes');
  assert.equal(parseBotApprovalLevel('ask-always'), 'ask-always');
  assert.equal(parseBotApprovalLevel('auto-approve-safe'), 'auto-approve-safe');
});

test('mức approval: bảng quyết định 3 mức', () => {
  // ask-always hỏi cả tool chỉ-đọc.
  assert.equal(decideApprovalLevel('ask-always', { isWrite: false, isReadOnly: true }), 'ask');
  assert.equal(decideApprovalLevel('ask-always', { isWrite: true, isReadOnly: false }), 'ask');
  // ask-for-writes: chỉ hỏi tool ghi.
  assert.equal(decideApprovalLevel('ask-for-writes', { isWrite: false, isReadOnly: true }), 'auto');
  assert.equal(decideApprovalLevel('ask-for-writes', { isWrite: true, isReadOnly: false }), 'ask');
  // auto-approve-safe: như ask-for-writes ở bảng này (khác ở policy ask).
  assert.equal(decideApprovalLevel('auto-approve-safe', { isWrite: false, isReadOnly: true }), 'auto');
  assert.equal(decideApprovalLevel('auto-approve-safe', { isWrite: true, isReadOnly: false }), 'ask');
});

test('shouldAskForCall: self-read thắng mọi mức, auto-approve-safe bỏ policy ask cho tool đọc', () => {
  // Self-read không hỏi dù ask-always.
  assert.equal(
    shouldAskForCall({ level: 'ask-always', askedByPolicyOrNeedsApproval: true, isReadOnly: true, isSelfRead: true }),
    false,
  );
  // auto-approve-safe + tool đọc + policy ask → không hỏi.
  assert.equal(
    shouldAskForCall({ level: 'auto-approve-safe', askedByPolicyOrNeedsApproval: true, isReadOnly: true, isSelfRead: false }),
    false,
  );
  // auto-approve-safe + tool ghi → vẫn hỏi.
  assert.equal(
    shouldAskForCall({ level: 'auto-approve-safe', askedByPolicyOrNeedsApproval: true, isReadOnly: false, isSelfRead: false }),
    true,
  );
  // ask-always hỏi cả khi loop chưa định hỏi.
  assert.equal(
    shouldAskForCall({ level: 'ask-always', askedByPolicyOrNeedsApproval: false, isReadOnly: true, isSelfRead: false }),
    true,
  );
  // Mặc định giữ nguyên quyết định cũ của loop.
  assert.equal(
    shouldAskForCall({ level: undefined, askedByPolicyOrNeedsApproval: false, isReadOnly: true, isSelfRead: false }),
    false,
  );
  assert.equal(
    shouldAskForCall({ level: 'ask-for-writes', askedByPolicyOrNeedsApproval: true, isReadOnly: false, isSelfRead: false }),
    true,
  );
});

// ---------------------------------------------------------------------------
// Quy tắc self-read (pure)
// ---------------------------------------------------------------------------

test('self-read: tool đọc trong workspace thì miễn, ngoài workspace thì hỏi', () => {
  const ws = path.join(os.tmpdir(), 'ws-self-read');
  assert.equal(isSelfReadCall('read_file', { path: 'notes/todo.md' }, ws), true);
  assert.equal(isSelfReadCall('read_file', { path: '/etc/passwd' }, ws), false);
  assert.equal(isSelfReadCall('read_file', { path: '../outside.txt' }, ws), false);
  assert.equal(isSelfReadCall('read_file', { path: 'a/../../outside.txt' }, ws), false);
  // list_files không tham số = liệt kê gốc workspace của nó → miễn.
  assert.equal(isSelfReadCall('list_files', {}, ws), true);
  assert.equal(isSelfReadCall('list_files', { path: '/tmp' }, ws), false);
  // Tool ghi KHÔNG BAO GIỜ được miễn, kể cả trong workspace.
  assert.equal(isSelfReadCall('write_file', { path: 'notes/todo.md' }, ws), false);
  assert.equal(isSelfReadCall('delete_file', { path: 'notes/todo.md' }, ws), false);
  // Tool đọc không có đường dẫn trong bảng → không miễn (fail-closed).
  assert.equal(isSelfReadCall('web_search', { query: 'x' }, ws), false);
  // Không rõ workspace → không miễn.
  assert.equal(isSelfReadCall('read_file', { path: 'notes/todo.md' }, undefined), false);
});

test('self-read: dispatcher gom nhóm (file/read_file) cũng miễn khi trong workspace', () => {
  const ws = path.join(os.tmpdir(), 'ws-grouped');
  assert.equal(
    isSelfReadCall('file', { operation: 'read_file', args: { path: 'a.md' } }, ws),
    true,
  );
  assert.equal(
    isSelfReadCall('file', { operation: 'write_file', args: { path: 'a.md' } }, ws),
    false,
  );
  assert.equal(
    isSelfReadCall('file', { operation: 'read_file', args: { path: '/etc/passwd' } }, ws),
    false,
  );
});

test('self-read: lệnh shell đọc đơn giản trong workspace thì miễn', () => {
  const ws = path.join(os.tmpdir(), 'ws-shell');
  assert.equal(isSelfReadShellCommand('cat notes/todo.md', ws), true);
  assert.equal(isSelfReadShellCommand('head -n 20 notes/todo.md', ws), true);
  assert.equal(isSelfReadShellCommand('grep -r "TODO" src', ws), true);
  assert.equal(isSelfReadShellCommand("sed -n '1,10p' notes/todo.md", ws), true);
  assert.equal(isSelfReadShellCommand('ls -la src', ws), true);
  // Ngoài workspace → hỏi.
  assert.equal(isSelfReadShellCommand('cat /etc/passwd', ws), false);
  assert.equal(isSelfReadShellCommand('cat ../secret.txt', ws), false);
  // Lệnh ghép / redirect / substitution → không miễn.
  assert.equal(isSelfReadShellCommand('cat notes/todo.md && rm notes/todo.md', ws), false);
  assert.equal(isSelfReadShellCommand('cat notes/todo.md > out.txt', ws), false);
  assert.equal(isSelfReadShellCommand('cat $(ls)', ws), false);
  // sed không -n / có -i là ghi → không miễn.
  assert.equal(isSelfReadShellCommand("sed 's/a/b/' notes/todo.md", ws), false);
  assert.equal(isSelfReadShellCommand("sed -i 's/a/b/' notes/todo.md", ws), false);
  // Lệnh không phải lệnh đọc → không miễn.
  assert.equal(isSelfReadShellCommand('rm -rf notes', ws), false);
  assert.equal(isSelfReadShellCommand('npm test', ws), false);
  // Lệnh đọc trần, không toán hạng đường dẫn tường minh → không miễn
  // (fail-closed: đọc cwd/stdin không rõ, hỏi như thường).
  assert.equal(isSelfReadShellCommand('ls', ws), false);
  assert.equal(isSelfReadShellCommand('ls -la', ws), false);
  assert.equal(isSelfReadShellCommand('cat', ws), false);
  assert.equal(isSelfReadShellCommand('grep "TODO"', ws), false);
});

test('summarizeArgsForCard: redact secret theo key và theo hình dạng giá trị', () => {
  const summary = summarizeArgsForCard({
    path: 'notes/todo.md',
    apiKey: 'sk-secret-value-123',
    token: 'abc123token',
    headers: { Authorization: 'Bearer my-bearer-token-xyz' },
    command: 'curl -H "Authorization: Bearer abc" https://example.com',
    normal: 'hello',
  });
  assert.ok(!summary.includes('sk-secret-value-123'), 'apiKey không được lộ');
  assert.ok(!summary.includes('abc123token'), 'token không được lộ');
  assert.ok(!summary.includes('my-bearer-token-xyz'), 'Bearer token không được lộ');
  assert.ok(summary.includes('<redacted>'), 'có marker redact');
  assert.ok(summary.includes('notes/todo.md'), 'giá trị thường giữ nguyên');
  assert.ok(summary.includes('hello'), 'giá trị thường giữ nguyên');
  // Dài thì cắt ngắn (tối đa ~500 ký tự + dấu …).
  const long = summarizeArgsForCard({ path: 'x'.repeat(1000) });
  assert.ok(long.length <= 510, `tóm tắt dài bị cắt, got ${long.length}`);
});

// ---------------------------------------------------------------------------
// Loop: mức + self-read trong executeCallInner
// ---------------------------------------------------------------------------

function makeTool(name, opts = {}) {
  const calls = [];
  const tool = {
    definition: {
      name,
      description: `Tool ${name} for testing.`,
      parameters: { type: 'object', properties: { path: { type: 'string' }, command: { type: 'string' } } },
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
      return { text: r.text ?? '', toolCalls: r.toolCalls ?? [] };
    },
    async listModels() {
      return ['mock'];
    },
  };
}

async function runLoop({ workspaceDir, approvalLevel, tool, toolCall, approve }) {
  let asked = 0;
  const events = {
    texts: [],
    onText(d) {
      events.texts.push(d);
    },
    onToolCall() {},
    onToolResult() {},
    onApprovalNeeded: async () => {
      asked += 1;
      return approve;
    },
  };
  const bot = {
    id: 'bot-1',
    name: 'Test',
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'test',
    workspaceDir,
    autoApprove: false,
    ...(approvalLevel !== undefined ? { approvalLevel } : {}),
  };
  const provider = scriptedProvider([
    { text: '', toolCalls: [toolCall] },
    { text: 'done' },
  ]);
  const runner = new AgentRunner(provider, [tool], { bot, events });
  const text = await runner.run('làm việc');
  return { text, asked, calls: tool.calls };
}

test('loop: bot đọc file của chính nó thì không hiện thẻ (kể cả needsApproval)', async () => {
  const ws = makeTempDir();
  fs.mkdirSync(path.join(ws, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'notes', 'todo.md'), 'todo');
  const tool = makeTool('read_file', { needsApproval: true });
  const out = await runLoop({
    workspaceDir: ws,
    tool,
    toolCall: { id: 'c1', name: 'read_file', args: { path: 'notes/todo.md' } },
    approve: false, // dù từ chối cũng không được hỏi
  });
  assert.equal(out.asked, 0, 'không hỏi khi đọc file của chính nó');
  assert.equal(out.calls.length, 1, 'tool vẫn chạy');
  assert.equal(out.text, 'done');
});

test('loop: đọc file ngoài workspace thì vẫn hỏi; Deny → dừng run', async () => {
  const ws = makeTempDir();
  const tool = makeTool('read_file', { needsApproval: true });
  const out = await runLoop({
    workspaceDir: ws,
    tool,
    toolCall: { id: 'c1', name: 'read_file', args: { path: '/etc/passwd' } },
    approve: false,
  });
  assert.equal(out.asked, 1, 'hỏi khi đọc file ngoài workspace');
  assert.equal(out.calls.length, 0, 'deny thì không chạy tool');
  assert.equal(out.text, 'đã hủy');
});

test('loop: Allow → tool chạy; mức ask-always hỏi cả tool chỉ-đọc không needsApproval', async () => {
  const ws = makeTempDir();
  const tool = makeTool('read_file', { needsApproval: false });
  const out = await runLoop({
    workspaceDir: ws,
    approvalLevel: 'ask-always',
    tool,
    toolCall: { id: 'c1', name: 'read_file', args: { path: '/etc/passwd' } },
    approve: true,
  });
  assert.equal(out.asked, 1, 'ask-always hỏi cả tool chỉ-đọc');
  assert.equal(out.calls.length, 1, 'allow thì chạy');
});

test('loop: ask-always vẫn KHÔNG hỏi khi bot đọc file của chính nó', async () => {
  const ws = makeTempDir();
  const tool = makeTool('read_file', { needsApproval: false });
  const out = await runLoop({
    workspaceDir: ws,
    approvalLevel: 'ask-always',
    tool,
    toolCall: { id: 'c1', name: 'read_file', args: { path: 'notes/todo.md' } },
    approve: false,
  });
  assert.equal(out.asked, 0, 'self-read thắng cả ask-always');
  assert.equal(out.calls.length, 1);
});

test('loop: auto-approve-safe tự chạy tool chỉ-đọc có needsApproval, vẫn hỏi tool ghi', async () => {
  const ws = makeTempDir();
  const readTool = makeTool('read_file', { needsApproval: true });
  const readOut = await runLoop({
    workspaceDir: ws,
    approvalLevel: 'auto-approve-safe',
    tool: readTool,
    toolCall: { id: 'c1', name: 'read_file', args: { path: '/etc/passwd' } },
    approve: false,
  });
  assert.equal(readOut.asked, 0, 'tool chỉ-đọc tự chạy ở auto-approve-safe');
  assert.equal(readOut.calls.length, 1);

  const writeTool = makeTool('write_file', { needsApproval: true });
  const writeOut = await runLoop({
    workspaceDir: ws,
    approvalLevel: 'auto-approve-safe',
    tool: writeTool,
    toolCall: { id: 'c2', name: 'write_file', args: { path: 'notes/x.md' } },
    approve: false,
  });
  assert.equal(writeOut.asked, 1, 'tool ghi vẫn hỏi ở auto-approve-safe');
  assert.equal(writeOut.calls.length, 0);
});

test('loop: shell_exec đọc file của nó (cat trong workspace) thì không hỏi', async () => {
  const ws = makeTempDir();
  const tool = makeTool('shell_exec', { needsApproval: true });
  const out = await runLoop({
    workspaceDir: ws,
    tool,
    toolCall: { id: 'c1', name: 'shell_exec', args: { command: 'cat notes/todo.md' } },
    approve: false,
  });
  assert.equal(out.asked, 0);
  assert.equal(out.calls.length, 1);
});

// ---------------------------------------------------------------------------
// Coordinator: payload thẻ duyệt + "Allow always" (rule phạm vi bot)
// ---------------------------------------------------------------------------

test('coordinator: approval-needed mang reason + argsSummary đã redact; Allow always tạo rule bot', async () => {
  const dataDir = makeTempDir('open-bot-m8-coord-');
  const ws = path.join(dataDir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const seen = [];
  const coordinator = new AgentCoordinator({
    dataDir,
    emit: (notification) => {
      if (notification.event === 'agent.event') seen.push(notification.data);
    },
  });
  try {
    await coordinator.createBot({
      bot: {
        id: 'bot-a',
        name: 'Bot A',
        providerId: 'mock',
        model: 'mock',
        systemPrompt: 'test',
        workspaceDir: ws,
        autoApprove: false,
      },
      provider: {
        id: 'mock',
        label: 'Mock',
        defaultModel: 'mock',
        mockResponses: [
          { text: '', toolCalls: [{ id: 'call-1', name: 'write_file', args: { path: 'x.md', apiKey: 'sk-should-not-leak-123' } }] },
          { text: 'xong' },
        ],
      },
    });
    // Run 1: thẻ hiện, deny → dừng.
    const runPromise = coordinator.run({ botId: 'bot-a', text: 'ghi file' });
    // Đợi event approval-needed rồi deny.
    const deadline = Date.now() + 5000;
    while (!seen.some((e) => e.kind === 'approval-needed') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const approvalEvent = seen.find((e) => e.kind === 'approval-needed');
    assert.ok(approvalEvent, 'coordinator emit approval-needed');
    const payload = approvalEvent.payload;
    assert.equal(typeof payload.reason, 'string');
    assert.ok(payload.reason.length > 0, 'thẻ có lý do');
    assert.equal(typeof payload.argsSummary, 'string');
    assert.ok(!payload.argsSummary.includes('sk-should-not-leak-123'), 'argsSummary redact secret');
    assert.ok(payload.argsSummary.includes('x.md'), 'argsSummary giữ path thường');
    coordinator.respondApproval({ callId: payload.callId, approved: false });
    const denied = await runPromise;
    assert.equal(denied.text, 'đã hủy');

    // "Allow always": tạo rule tool phạm vi bot rồi chạy lại — không hiện thẻ nữa.
    const { rule } = coordinator.addAutoApproveRule({
      kind: 'tool',
      scope: 'bot',
      botId: 'bot-a',
      tool: 'write_file',
    });
    assert.equal(rule.scope, 'bot');
    assert.equal(rule.botId, 'bot-a');
    seen.length = 0;
    const allowed = await coordinator.run({ botId: 'bot-a', text: 'ghi file' });
    assert.equal(allowed.text, 'xong');
    assert.equal(
      seen.filter((e) => e.kind === 'approval-needed').length,
      0,
      'rule Allow always thì không hiện thẻ nữa',
    );
  } finally {
    coordinator.shutdown();
  }
});

// ---------------------------------------------------------------------------
// Broker / harness: timeout → từ chối; uiHandler treo + decide() → resolve
// ---------------------------------------------------------------------------

test('broker: hết timeout thì từ chối (không treo turn)', async () => {
  const broker = new PermissionBroker({
    timeoutMs: 50,
    uiHandler: () => new Promise(() => {}), // UI không bao giờ trả lời
  });
  const started = Date.now();
  const allowed = await broker.request({ botId: 'b1', engine: 'acp', method: 'session/request_permission' });
  const waited = Date.now() - started;
  assert.equal(allowed, false);
  assert.ok(waited < 5000, `timeout phải resolve nhanh, waited=${waited}ms`);
  const decisions = broker.listDecisions();
  assert.equal(decisions[0].source, 'timeout');
});

test('broker: không có UI handler thì từ chối ngay (fail-closed)', async () => {
  const broker = new PermissionBroker({});
  const allowed = await broker.request({ botId: 'b1', engine: 'codex', method: 'execCommandApproval' });
  assert.equal(allowed, false);
  assert.equal(broker.listDecisions()[0].source, 'default-deny');
});

test('harness: uiHandler chỉ emit rồi chờ — decide() qua harness resolve request', async () => {
  const emitted = [];
  const harness = new LocalHarness({
    permissionUiHandler: (request) => {
      emitted.push(request);
      // Như desktop main: emit event rồi chờ user bấm thẻ ở tiến trình khác.
      return new Promise(() => {});
    },
  });
  const pending = harness.broker.request({
    botId: 'bot-h',
    engine: 'acp',
    method: 'session/request_permission',
    detail: 'read file',
  });
  // Broker gọi uiHandler qua microtask (sau khi đã ghi pending) nên chờ
  // tới khi handler chạy, không chờ pendingCount.
  const deadline = Date.now() + 5000;
  while (emitted.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(emitted.length, 1, 'uiHandler được gọi');
  const requestId = harness.broker.listPending()[0].requestId;
  const decided = harness.decidePermission(requestId, true, 'user cho phép qua thẻ duyệt.');
  assert.equal(decided.found, true);
  const allowed = await pending;
  assert.equal(allowed, true, 'decide(true) thì request resolve true');
  assert.equal(harness.listPermissionDecisions().length, 1);
});
