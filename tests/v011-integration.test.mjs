/**
 * Tests for the v0.11 coordinator integration step (nối W3a + W3b + W3c):
 *   packages/core/src/agent/loop.ts — checkToolCall nhận args + workspaceDir
 *     (rule engine v0.11c có hiệu lực trong run thật).
 *   packages/core/src/coordinator/coordinator.ts — setBotPolicy khi tạo bot
 *     (true → 'all', false/không set → 'safe-only'); glob-rules hook đăng ký
 *     một lần với RulesStore riêng cho mỗi workspace.
 *   packages/core/src/agent/toolFilter.ts — plan_create/plan_update hiện ở
 *     plan mode.
 *   packages/core/src/index.ts (+ skills/index.ts) — barrel re-export các
 *     helper mới (rules, workspace rules, plan helpers, skill helpers).
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 *   xvfb-run -a node --test tests/v011-integration.test.mjs
 * Không cần API key thật, không gọi mạng (mock provider + tool giả).
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AgentRunner } from '../packages/core/dist/agent/loop.js';
import { AgentPermissions, resolveAutoApproveMode } from '../packages/core/dist/agent/permissions.js';
import {
  createGlobRulesHook,
  RulesStore,
} from '../packages/core/dist/agent/rules.js';
import { filterTools, isReadOnlyTool } from '../packages/core/dist/agent/toolFilter.js';
import { HookRegistry, HookRunner } from '../packages/core/dist/hooks/index.js';
// Barrel wiring: import này tự fail nếu tên export gõ sai.
import {
  classifyCommand,
  loadSkillDir,
  loadWorkspaceRules,
  parseYaml,
  renderPlanMarkdown,
  submitPlanForReview,
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
// 1. Rule engine qua AgentPermissions (đường mà loop dùng)
// ---------------------------------------------------------------------------

test('v0.11 integration: checkToolCall với args — safe chạy, sensitive hỏi, blocked từ chối', () => {
  const permissions = new AgentPermissions();
  // Policy trống = 'safe-only' (mặc định mới khi coordinator không set gì).
  permissions.setBotPolicy('bot-1', {});
  const ws = makeTempDir('open-bot-v011-');

  const safe = permissions.checkToolCall('bot-1', 'shell_exec', { command: 'ls -la' }, { workspaceDir: ws });
  assert.equal(safe.policy, 'allow');
  assert.equal(safe.allowed, true);

  const sensitive = permissions.checkToolCall('bot-1', 'shell_exec', { command: 'git push' }, { workspaceDir: ws });
  assert.equal(sensitive.policy, 'ask');
  assert.equal(sensitive.allowed, true);

  // `sudo` nằm ở mức blocked (chặn cứng), không phải sensitive.
  const sudo = permissions.checkToolCall('bot-1', 'shell_exec', { command: 'sudo apt update' }, { workspaceDir: ws });
  assert.equal(sudo.allowed, false);
  assert.equal(sudo.policy, 'deny');

  const blocked = permissions.checkToolCall('bot-1', 'shell_exec', { command: 'rm -rf /' }, { workspaceDir: ws });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.policy, 'deny');

  // Không có args → hành vi y hệt cũ (không phân loại lệnh).
  const noArgs = permissions.checkToolCall('bot-1', 'shell_exec');
  assert.equal(noArgs.allowed, true);
  assert.equal(noArgs.policy, 'allow');
});

test('v0.11 integration: mapping autoApprove của coordinator — true → all, false → safe-only', () => {
  // Đây là mapping coordinator dùng khi setBotPolicy (true → 'all',
  // false/không set → để trống → resolve ra 'safe-only'). 'none' chỉ khi
  // policy đặt chuỗi 'none' trực tiếp — không map từ boolean false.
  assert.equal(resolveAutoApproveMode(true), 'all');
  assert.equal(resolveAutoApproveMode(undefined), 'safe-only');
  assert.equal(resolveAutoApproveMode('none'), 'none');

  const permissions = new AgentPermissions();
  permissions.setBotPolicy('bot-all', { autoApprove: 'all' });
  permissions.setBotPolicy('bot-default', {});
  permissions.setBotPolicy('bot-none', { autoApprove: 'none' });
  const ws = makeTempDir('open-bot-v011-');

  // 'all' chạy lệnh thường ngay, nhưng blocked vẫn bị từ chối.
  assert.equal(permissions.checkToolCall('bot-all', 'shell_exec', { command: 'ls' }, { workspaceDir: ws }).policy, 'allow');
  assert.equal(permissions.checkToolCall('bot-all', 'shell_exec', { command: 'rm -rf /' }, { workspaceDir: ws }).allowed, false);
  // Mặc định ('safe-only'): lệnh an toàn chạy ngay.
  assert.equal(permissions.checkToolCall('bot-default', 'shell_exec', { command: 'npm test' }, { workspaceDir: ws }).policy, 'allow');
  // 'none': hỏi cả lệnh an toàn.
  assert.equal(permissions.checkToolCall('bot-none', 'shell_exec', { command: 'ls' }, { workspaceDir: ws }).policy, 'ask');
});

// ---------------------------------------------------------------------------
// 2. Loop thật: lệnh blocked bị từ chối TRƯỚC khi tool chạy
// ---------------------------------------------------------------------------

test('v0.11 integration: loop từ chối lệnh blocked, tool không bao giờ chạy', async () => {
  const ws = makeTempDir('open-bot-v011-');
  const shell = makeTool('shell_exec', { needsApproval: false });
  const permissions = new AgentPermissions();
  permissions.setBotPolicy('bot-1', {});
  const provider = scriptedProvider([
    {
      text: '',
      toolCalls: [{ id: `call-${++callSeq}`, name: 'shell_exec', args: { command: 'rm -rf /' } }],
    },
    { text: 'đã chặn' },
  ]);
  const events = makeEvents();
  const runner = new AgentRunner(provider, [shell], {
    bot: makeBot(ws),
    events,
    permissions,
  });
  await runner.run('xóa hết đi');
  assert.equal(shell.calls.length, 0, 'tool bị chặn không được chạy');
  // Lý do từ chối nằm trong tool result trả cho model (không phải text cuối).
  assert.equal(events.toolResults.length, 1);
  assert.equal(events.toolResults[0].ok, false);
  assert.match(events.toolResults[0].output, /rm -rf|bị cấm|không được|từ chối/i);
});

test('v0.11 integration: loop hỏi phê duyệt lệnh sensitive rồi mới chạy', async () => {
  const ws = makeTempDir('open-bot-v011-');
  const shell = makeTool('shell_exec', { needsApproval: false });
  const permissions = new AgentPermissions();
  permissions.setBotPolicy('bot-1', {});
  const asked = [];
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
      onApprovalNeeded: async (call) => {
        asked.push(call);
        return true;
      },
    }),
    permissions,
  });
  const result = await runner.run('đẩy code lên');
  assert.equal(result, 'xong');
  assert.equal(asked.length, 1, 'lệnh sensitive phải hỏi phê duyệt');
  assert.equal(asked[0].name, 'shell_exec');
  assert.equal(shell.calls.length, 1, 'được duyệt thì tool chạy');
  assert.deepEqual(shell.calls[0], { command: 'git push' });
});

// ---------------------------------------------------------------------------
// 3. Plan tools hiện ở plan mode
// ---------------------------------------------------------------------------

test('v0.11 integration: plan_create/plan_update là read-only, hiện ở plan mode', () => {
  assert.equal(isReadOnlyTool('plan_create'), true);
  assert.equal(isReadOnlyTool('plan_update'), true);
  const tools = ['read_file', 'write_file', 'shell_exec', 'plan_create', 'plan_update'].map((name) =>
    makeTool(name),
  );
  const visible = filterTools(tools, { mode: 'plan', group: false }).map((t) => t.definition.name);
  assert.ok(visible.includes('plan_create'), 'plan_create phải hiện ở plan mode');
  assert.ok(visible.includes('plan_update'), 'plan_update phải hiện ở plan mode');
  assert.ok(visible.includes('read_file'));
  assert.ok(!visible.includes('write_file'), 'write_file vẫn bị lọc ở plan mode');
  assert.ok(!visible.includes('shell_exec'), 'shell_exec vẫn bị lọc ở plan mode');
});

// ---------------------------------------------------------------------------
// 4. Glob-rules hook theo từng workspace (mẫu wiring của coordinator)
// ---------------------------------------------------------------------------

test('v0.11 integration: glob hook dùng RulesStore của đúng workspace', async () => {
  const wsA = makeTempDir('open-bot-v011-a-');
  const wsB = makeTempDir('open-bot-v011-b-');
  // Chỉ workspace A có rule riêng cho *.md (B không có file rules nên chỉ
  // còn rule mặc định **/*.ts → không khớp file .md).
  fs.mkdirSync(path.join(wsA, '.open-bot'), { recursive: true });
  fs.writeFileSync(
    path.join(wsA, '.open-bot', 'rules.json'),
    JSON.stringify({
      rules: [{ glob: '**/*.md', action: 'run', command: 'echo A-RULE' }],
    }),
  );
  // Cùng mẫu wiring như coordinator.getHookRunner: một hook, một
  // RulesStore riêng cho mỗi workspace (cache theo mtime).
  const stores = new Map();
  const registry = new HookRegistry();
  registry.register(
    createGlobRulesHook((workspaceDir) => {
      if (!workspaceDir) return [];
      let store = stores.get(workspaceDir);
      if (!store) {
        store = new RulesStore(workspaceDir);
        stores.set(workspaceDir, store);
      }
      return store.getRules();
    }),
  );
  const runner = new HookRunner(registry);

  const event = {
    toolName: 'write_file',
    toolCallId: 'c1',
    args: { path: 'docs/a.md' },
    result: { ok: true, output: 'đã ghi file' },
  };
  const inA = await runner.runPostToolUse(event, { botId: 'bot-1', workspaceDir: wsA });
  assert.equal(inA.modified, true);
  assert.match(inA.output, /\[rule\]/);
  assert.match(inA.output, /echo A-RULE/);

  const inB = await runner.runPostToolUse(event, { botId: 'bot-1', workspaceDir: wsB });
  assert.equal(inB.modified, false, 'workspace B không có rule cho .md thì output giữ nguyên');
  assert.equal(inB.output, 'đã ghi file');
});

// ---------------------------------------------------------------------------
// 5. Barrel exports của v0.11
// ---------------------------------------------------------------------------

test('v0.11 integration: barrel export đủ helper mới (rules / plan / skills)', () => {
  for (const [name, fn] of [
    ['classifyCommand', classifyCommand],
    ['loadSkillDir', loadSkillDir],
    ['loadWorkspaceRules', loadWorkspaceRules],
    ['parseYaml', parseYaml],
    ['renderPlanMarkdown', renderPlanMarkdown],
    ['submitPlanForReview', submitPlanForReview],
  ]) {
    assert.equal(typeof fn, 'function', `${name} phải được export từ core barrel`);
  }
  // parseYaml thật (YAML parser mới của W3a) qua barrel.
  assert.deepEqual(parseYaml('name: test\nversion: 1'), { name: 'test', version: 1 });
});
