/**
 * Tests for v0.86 (P2-10): elevate — run one command with higher
 * privileges, with mandatory per-call approval, fail-closed.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/elevate-v086.test.mjs
 *
 * NO real sudo is ever executed here: the tool is tested with an
 * injected fake runner, and the argv builder is tested pure. The only
 * test that touches the real `sudo` binary checks `defaultElevateRunner`
 * against a FAKE sudo script on PATH (prints a canned line, exits 0)
 * — never the system sudo, never a privileged command.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildElevatedArgv,
  formatElevatedResult,
  isElevateSupported,
  isPasswordRequiredError,
  validateElevateRequest,
  ELEVATED_TOOL_NAME,
  ELEVATE_PASSWORD_REQUIRED,
} from '../packages/core/dist/elevate/index.js';
import {
  findMatchingAutoApproveRule,
  matchAutoApproveRule,
  validateAutoApproveRuleInput,
} from '../packages/core/dist/approval/rules.js';
import { AgentRunner } from '../packages/core/dist/agent/loop.js';
import { createShellTools, defaultElevateRunner } from '../packages/tools/dist/shellTools.js';

const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });
const REASON = 'cài đặt gói hệ thống cho bot';
const tool = (tools, name) => tools.find((t) => t.definition.name === name);

function fakeRunnerFactory(seen) {
  return async (argv, opts) => {
    seen.push({ argv, opts });
    return { exitCode: 0, signal: null, stdout: 'fake-elevated-ok\n', stderr: '', timedOut: false };
  };
}

// --- pure helpers ------------------------------------------------------------

test('elevate: tool name + argv shape (sudo -n, no shell interpolation)', () => {
  assert.equal(ELEVATED_TOOL_NAME, 'shell_elevate');
  assert.deepEqual(buildElevatedArgv('apt-get install -y foo'), [
    'sudo',
    '-n',
    '/bin/sh',
    '-c',
    'apt-get install -y foo',
  ]);
  assert.equal(isElevateSupported('linux'), true);
  assert.equal(isElevateSupported('darwin'), true);
  assert.equal(isElevateSupported('win32'), false);
  assert.throws(() => buildElevatedArgv('whoami', 'win32'), /không hỗ trợ trên Windows/);
});

test('validateElevateRequest: needs command + real reason + denylist still applies', () => {
  assert.deepEqual(validateElevateRequest({ command: 'apt-get update', reason: REASON }), []);
  assert.ok(validateElevateRequest({ command: '', reason: REASON }).length > 0, 'empty command rejected');
  assert.ok(validateElevateRequest({ command: 'id', reason: 'x' }).length > 0, 'one-char reason rejected');
  assert.ok(validateElevateRequest({ command: 'id' }).length > 0, 'missing reason rejected');
  // Denylist: rm -rf / is blocked even elevated.
  const blocked = validateElevateRequest({ command: 'rm -rf /', reason: REASON });
  assert.ok(blocked.some((e) => e.includes('denylist')), `rm -rf / must be denylisted, got: ${blocked}`);
  // Nested sudo is blocked (no invisible second escalation).
  const nested = validateElevateRequest({ command: 'sudo id', reason: REASON });
  assert.ok(nested.length > 0, 'nested sudo rejected');
  // Windows fails closed.
  const win = validateElevateRequest({ command: 'id', reason: REASON }, 'win32');
  assert.ok(win.some((e) => e.includes('ELEVATE_UNSUPPORTED')));
});

test('isPasswordRequiredError: detects sudo -n password failures only', () => {
  assert.equal(isPasswordRequiredError('sudo: a password is required', 1), true);
  assert.equal(isPasswordRequiredError('sudo: A password is required', 1), true);
  assert.equal(isPasswordRequiredError('sudo: a password is required', 0), false);
  assert.equal(isPasswordRequiredError('permission denied', 1), false);
  assert.equal(isPasswordRequiredError('', 1), false);
});

test('formatElevatedResult: password failure becomes a clean code, never a hang', () => {
  const out = JSON.parse(
    formatElevatedResult(
      { exitCode: 1, signal: null, stdout: '', stderr: 'sudo: a password is required', timedOut: false },
      'apt-get update',
      false,
    ),
  );
  assert.equal(out.ok, false);
  assert.equal(out.code, ELEVATE_PASSWORD_REQUIRED);
  assert.ok(out.message.includes('không bao giờ hỏi hay lưu password'));
  const ok = JSON.parse(
    formatElevatedResult(
      { exitCode: 0, signal: null, stdout: 'done\n', stderr: '', timedOut: false },
      'id',
      false,
    ),
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.stdout, 'done\n');
  const timedOut = JSON.parse(
    formatElevatedResult(
      { exitCode: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true },
      'sleep 999',
      true,
    ),
  );
  assert.equal(timedOut.code, 'ELEVATE_TIMEOUT');
});

// --- auto-approve can never cover elevate ------------------------------------

test('auto-approve: no rule can ever match shell_elevate (match + validate)', () => {
  const rule = {
    id: 'r1',
    kind: 'tool',
    enabled: true,
    scope: 'global',
    tool: 'shell_elevate',
    createdAt: 1,
  };
  assert.equal(
    matchAutoApproveRule(rule, { botId: 'b', toolName: 'shell_elevate', args: { command: 'id', reason: REASON } }),
    false,
    'a matching rule must NOT match elevate',
  );
  assert.equal(
    findMatchingAutoApproveRule([rule], {
      botId: 'b',
      toolName: 'shell_elevate',
      args: { command: 'id', reason: REASON },
    }),
    undefined,
  );
  const errors = validateAutoApproveRuleInput({ kind: 'tool', scope: 'global', tool: 'shell_elevate' });
  assert.ok(errors.some((e) => e.includes('không bao giờ được auto-approve')), `got: ${errors}`);
  // A rule for an ordinary tool still works (the guard is elevate-only).
  const normal = {
    id: 'r2',
    kind: 'tool',
    enabled: true,
    scope: 'global',
    tool: 'exec_task',
    createdAt: 1,
  };
  assert.equal(
    matchAutoApproveRule(normal, { botId: 'b', toolName: 'exec_task', args: {} }),
    true,
  );
  assert.deepEqual(validateAutoApproveRuleInput({ kind: 'tool', scope: 'global', tool: 'exec_task' }), []);
});

// --- the tool ----------------------------------------------------------------

test('shell_elevate tool: needsApproval, reason required, runs via injected runner', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-elevate-'));
  const seen = [];
  const tools = createShellTools({ elevateRunner: fakeRunnerFactory(seen) });
  const elevate = tool(tools, 'shell_elevate');
  assert.ok(elevate, 'shell_elevate must be registered');
  assert.equal(elevate.needsApproval, true, 'elevate must require approval');
  assert.ok(elevate.definition.parameters.required.includes('reason'), 'reason is required');
  assert.ok(elevate.definition.parameters.required.includes('command'), 'command is required');

  const out = JSON.parse(
    await elevate.execute({ command: 'id', reason: REASON }, CTX(ws)),
  );
  assert.equal(out.ok, true);
  assert.equal(out.stdout, 'fake-elevated-ok\n');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].argv, ['sudo', '-n', '/bin/sh', '-c', 'id']);
  assert.equal(seen[0].opts.cwd, ws);
  assert.ok(!JSON.stringify(seen[0].opts.env).includes('FAKE'), 'env is the safe allowlist env');
  fs.rmSync(ws, { recursive: true, force: true });
});

test('shell_elevate tool: denied without a reason; denied for denylisted commands', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-elevate-deny-'));
  const seen = [];
  const tools = createShellTools({ elevateRunner: fakeRunnerFactory(seen) });
  const elevate = tool(tools, 'shell_elevate');

  const noReason = await elevate.execute({ command: 'id' }, CTX(ws));
  assert.ok(noReason.startsWith('Error:'), 'missing reason must fail');
  assert.ok(noReason.includes('reason'), noReason);
  assert.equal(seen.length, 0, 'nothing runs when the reason is missing');

  const blocked = await elevate.execute({ command: 'rm -rf /', reason: REASON }, CTX(ws));
  assert.ok(blocked.startsWith('Error:'), 'denylisted command must fail');
  assert.ok(blocked.includes('denylist'), blocked);
  assert.equal(seen.length, 0, 'denylisted command never reaches the runner');

  const nested = await elevate.execute({ command: 'sudo rm /tmp/x', reason: REASON }, CTX(ws));
  assert.ok(nested.startsWith('Error:'), 'nested sudo must fail');
  assert.equal(seen.length, 0);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('shell_elevate tool: sudo needing a password fails cleanly, no hang', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-elevate-pw-'));
  const tools = createShellTools({
    elevateRunner: async () => ({
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'sudo: a password is required',
      timedOut: false,
    }),
  });
  const elevate = tool(tools, 'shell_elevate');
  const out = JSON.parse(await elevate.execute({ command: 'apt-get update', reason: REASON }, CTX(ws)));
  assert.equal(out.ok, false);
  assert.equal(out.code, ELEVATE_PASSWORD_REQUIRED);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('shell_elevate tool: runner failure / non-zero exit is reported, not thrown', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-elevate-fail-'));
  const tools = createShellTools({
    elevateRunner: async () => ({
      exitCode: 3,
      signal: null,
      stdout: '',
      stderr: 'E: unable to locate package nope',
      timedOut: false,
    }),
  });
  const elevate = tool(tools, 'shell_elevate');
  const out = JSON.parse(await elevate.execute({ command: 'apt-get install -y nope', reason: REASON }, CTX(ws)));
  assert.equal(out.ok, false);
  assert.equal(out.exitCode, 3);
  assert.ok(out.stderr.includes('unable to locate package'));
  fs.rmSync(ws, { recursive: true, force: true });
});

test('shell_elevate tool: timeout_ms is capped at 10 minutes', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-elevate-timeout-'));
  const seen = [];
  const tools = createShellTools({ elevateRunner: fakeRunnerFactory(seen) });
  const elevate = tool(tools, 'shell_elevate');
  await elevate.execute({ command: 'id', reason: REASON, timeout_ms: 99999999 }, CTX(ws));
  assert.equal(seen[0].opts.timeoutMs, 600000, 'timeout is capped at MAX_ELEVATE_TIMEOUT_MS');
  fs.rmSync(ws, { recursive: true, force: true });
});

// --- loop: elevate always asks, even with bot autoApprove + a rule ------

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

async function runLoopOnce({ tool, toolCall, approve, autoApprove, autoApproveCheck }) {
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
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-elevate-loop-'));
  const bot = {
    id: 'bot-1',
    name: 'Test',
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'test',
    workspaceDir: ws,
    autoApprove,
  };
  const provider = scriptedProvider([
    { text: '', toolCalls: [toolCall] },
    { text: 'done' },
  ]);
  const runner = new AgentRunner(provider, [tool], {
    bot,
    events,
    ...(autoApproveCheck ? { autoApproveCheck } : {}),
  });
  try {
    const text = await runner.run('làm việc');
    return { text, asked, ws };
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

test('loop: elevate asks even when the bot has autoApprove on AND a rule matches', async () => {
  const seen = [];
  const tools = createShellTools({ elevateRunner: fakeRunnerFactory(seen) });
  const elevate = tool(tools, 'shell_elevate');
  // A rule that WOULD auto-approve elevate if any layer let it through.
  const fakeRule = {
    id: 'r-elevate',
    kind: 'tool',
    enabled: true,
    scope: 'global',
    tool: 'shell_elevate',
    createdAt: 1,
  };
  const out = await runLoopOnce({
    tool: elevate,
    toolCall: { id: 'c1', name: 'shell_elevate', args: { command: 'id', reason: REASON } },
    approve: false,
    autoApprove: true,
    autoApproveCheck: () => fakeRule,
  });
  assert.equal(out.asked, 1, 'elevate must show the approval card despite autoApprove + a matching rule');
  assert.equal(seen.length, 0, 'denied elevate never runs');
});

test('loop: elevate runs after the user approves (one call, one approval)', async () => {
  const seen = [];
  const tools = createShellTools({ elevateRunner: fakeRunnerFactory(seen) });
  const elevate = tool(tools, 'shell_elevate');
  const out = await runLoopOnce({
    tool: elevate,
    toolCall: { id: 'c1', name: 'shell_elevate', args: { command: 'id', reason: REASON } },
    approve: true,
    autoApprove: true,
  });
  assert.equal(out.asked, 1, 'exactly one approval card for one elevate call');
  assert.equal(seen.length, 1, 'approved elevate runs once');
  assert.equal(out.text, 'done');
});

test('loop: control — an ordinary needsApproval tool is NOT asked when autoApprove is on', async () => {
  const calls = [];
  const ordinary = {
    definition: {
      name: 'exec_task',
      description: 'Ordinary tool for control.',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
    },
    needsApproval: true,
    async execute(args) {
      calls.push(args);
      return 'ok:exec_task';
    },
  };
  const out = await runLoopOnce({
    tool: ordinary,
    toolCall: { id: 'c1', name: 'exec_task', args: { command: 'echo hi' } },
    approve: false, // must never be consulted
    autoApprove: true,
  });
  assert.equal(out.asked, 0, 'ordinary tools skip the card under autoApprove — only elevate is special');
  assert.equal(calls.length, 1, 'ordinary tool runs without approval under autoApprove');
});

// --- default runner against a FAKE sudo (never the real one) -----------------

test('defaultElevateRunner: runs argv through a fake sudo on PATH, caps + kills on timeout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-elevate-runner-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  // Fake sudo: prints its args, exits 0 — proves argv + env + cwd flow
  // without ever touching the real sudo.
  const fakeSudo = path.join(binDir, 'sudo');
  fs.writeFileSync(
    fakeSudo,
    '#!/bin/sh\necho "FAKE-SUDO args: $@"\necho "FAKE-SUDO pwd: $(pwd)"\nexit 0\n',
    { mode: 0o755 },
  );
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws);
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDir}:${savedPath}`;
  try {
    const result = await defaultElevateRunner(['sudo', '-n', '/bin/sh', '-c', 'id'], {
      timeoutMs: 5000,
      cwd: ws,
      env: { PATH: process.env.PATH, HOME: '/nonexistent' },
    });
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes('FAKE-SUDO args: -n /bin/sh -c id'), result.stdout);
    assert.ok(result.stdout.includes(`FAKE-SUDO pwd: ${ws}`), 'cwd is honoured');
    assert.equal(result.timedOut, false);

    // Timeout: fake sudo that sleeps must be killed, not awaited.
    fs.writeFileSync(fakeSudo, '#!/bin/sh\nsleep 30\nexit 0\n', { mode: 0o755 });
    const started = Date.now();
    const slow = await defaultElevateRunner(['sudo', '-n', '/bin/sh', '-c', 'sleep 30'], {
      timeoutMs: 300,
      cwd: ws,
      env: { PATH: process.env.PATH },
    });
    assert.ok(Date.now() - started < 5000, 'timed-out run must return promptly');
    assert.equal(slow.timedOut, true);
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
