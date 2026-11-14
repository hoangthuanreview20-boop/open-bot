/**
 * Tests for the SubagentStop test gate (v1.01):
 * `packages/core/src/hooks/testGate.ts`.
 *
 * Under test:
 * - `runTestGate`: exit 0 = pass; non-zero = fail with a digest;
 *   timeout = fail flagged as timeout; empty command = unconfigured.
 * - `buildFailedSummary`: failure-looking lines win; else the tail.
 * - `buildTestGateAdditionalContext`: headline + digest + fix instruction.
 * - `createTestGateHook`: pass → allow; fail → block + additionalContext;
 *   non-done subagent → allow (nothing to gate); no command → allow
 *   with a reason (an unconfigured gate never wedges subagents);
 *   spawn failure → allow with a reason (fail-open, logged).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/hooks-testgate-v101.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildFailedSummary,
  buildTestGateAdditionalContext,
  createTestGateHook,
  normalizeTestGateConfig,
  readTestGateConfig,
  runTestGate,
  TEST_GATE_HOOK_NAME,
  testGateCommands,
} from '../packages/core/dist/hooks/index.js';
import { HookRegistry, HookRunner } from '../packages/core/dist/hooks/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-testgate-v101-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function runnerWithGate(opts) {
  const registry = new HookRegistry({ stateDir: makeTempDir() });
  registry.register(createTestGateHook(opts));
  return new HookRunner(registry);
}

const DONE_STOP = (overrides = {}) => ({
  subagentId: 'sub-1',
  name: 'worker',
  status: 'done',
  output: 'work finished',
  durationMs: 100,
  ...overrides,
});

// ---------------------------------------------------------------------------
// buildFailedSummary (pure)
// ---------------------------------------------------------------------------

test('buildFailedSummary: failure lines win over passing noise', () => {
  const output = [
    'ok 1 - first test',
    'ok 2 - second test',
    'not ok 3 - login flow',
    '  Error: expected 200, got 500',
    'ok 4 - cleanup',
    'FAIL src/login.test.ts',
  ].join('\n');
  const digest = buildFailedSummary(output, 4000);
  assert.match(digest, /not ok 3/);
  assert.match(digest, /expected 200/);
  assert.match(digest, /FAIL src\/login/);
  assert.ok(!digest.includes('ok 1 - first test'), 'passing lines must not crowd the digest');
});

test('buildFailedSummary: no failure line → tail lines; empty → empty', () => {
  assert.equal(buildFailedSummary('', 1000), '');
  const output = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
  const digest = buildFailedSummary(output, 4000);
  assert.ok(digest.includes('line 50'));
  assert.ok(!digest.includes('line 1\n'), 'tail only');
});

test('buildFailedSummary: capped at maxChars', () => {
  const output = `FAIL: ${'x'.repeat(5000)}`;
  assert.ok(buildFailedSummary(output, 100).length <= 100);
});

// ---------------------------------------------------------------------------
// buildTestGateAdditionalContext (pure)
// ---------------------------------------------------------------------------

test('buildTestGateAdditionalContext: fail headline + digest + fix instruction', () => {
  const ctx = buildTestGateAdditionalContext(
    {
      command: 'npm test',
      passed: false,
      exitCode: 1,
      signal: null,
      timedOut: false,
      durationMs: 4321,
      output: 'FAIL',
      failedSummary: 'not ok 1 - login',
    },
    'worker',
  );
  assert.match(ctx, /FAIL/);
  assert.match(ctx, /npm test/);
  assert.match(ctx, /exit code 1/);
  assert.match(ctx, /not ok 1 - login/);
  assert.match(ctx, /Hãy sửa các lỗi trên/);
  assert.match(ctx, /worker/);
});

test('buildTestGateAdditionalContext: timeout headline says the suite never finished', () => {
  const ctx = buildTestGateAdditionalContext({
    command: 'npm test',
    passed: false,
    exitCode: null,
    signal: 'SIGKILL',
    timedOut: true,
    durationMs: 300000,
    output: '',
    failedSummary: '',
  });
  assert.match(ctx, /TIMEOUT/);
  assert.match(ctx, /chưa chạy xong/);
});

// ---------------------------------------------------------------------------
// runTestGate (spawn)
// ---------------------------------------------------------------------------

test('runTestGate: exit 0 passes; output captured', async () => {
  const res = await runTestGate({ command: 'echo "all good"; echo "2 passed" >&2' });
  assert.equal(res.passed, true);
  assert.equal(res.exitCode, 0);
  assert.equal(res.failedSummary, '');
  assert.match(res.output, /all good/);
});

test('runTestGate: exit 1 fails with a digest', async () => {
  const res = await runTestGate({
    command: `echo "ok 1"; echo "FAIL: login is broken" >&2; exit 1`,
  });
  assert.equal(res.passed, false);
  assert.equal(res.exitCode, 1);
  assert.match(res.failedSummary, /FAIL: login is broken/);
});

test('runTestGate: timeout is a failure flagged as timeout', async () => {
  const res = await runTestGate({ command: 'sleep 30', timeoutMs: 200 });
  assert.equal(res.passed, false);
  assert.equal(res.timedOut, true);
});

test('runTestGate: empty command is unconfigured, not a pass', async () => {
  const res = await runTestGate({ command: '   ' });
  assert.equal(res.passed, false);
  assert.equal(res.command, '');
});

// ---------------------------------------------------------------------------
// createTestGateHook (SubagentStop)
// ---------------------------------------------------------------------------

test('createTestGateHook: passing tests → allow', async () => {
  const runner = runnerWithGate({ command: 'true' });
  const out = await runner.runSubagentStop(DONE_STOP());
  assert.equal(out.decision, 'allow');
  assert.match(out.reason ?? '', /PASS/);
});

test('createTestGateHook: failing tests → block + additionalContext for the subagent', async () => {
  const runner = runnerWithGate({
    command: `echo "not ok 1 - save draft"; echo "Error: cannot read property" >&2; exit 1`,
  });
  const out = await runner.runSubagentStop(DONE_STOP());
  assert.equal(out.decision, 'block');
  assert.equal(out.blockedBy, TEST_GATE_HOOK_NAME);
  assert.match(out.additionalContext, /FAIL/);
  assert.match(out.additionalContext, /not ok 1 - save draft/);
  assert.match(out.additionalContext, /Hãy sửa các lỗi trên/);
});

test('createTestGateHook: timeout → block flagged as timeout', async () => {
  const runner = runnerWithGate({ command: 'sleep 30', timeoutMs: 200 });
  const out = await runner.runSubagentStop(DONE_STOP());
  assert.equal(out.decision, 'block');
  assert.match(out.additionalContext, /TIMEOUT/);
});

test('createTestGateHook: timed-out subagent is not gated (allow)', async () => {
  let ran = false;
  const registry = new HookRegistry({ stateDir: makeTempDir() });
  registry.register(
    createTestGateHook({
      command: `echo ran; exit 1`,
      logger: () => {
        ran = true;
      },
    }),
  );
  // Replace the command with a marker: the gate must not spawn at all
  // for a non-done subagent — assert via the runner outcome only.
  const runner = new HookRunner(registry);
  const out = await runner.runSubagentStop(DONE_STOP({ status: 'timeout', output: '' }));
  assert.equal(out.decision, 'allow');
  assert.equal(ran, false, 'gate logger must not fire for a timed-out subagent');
});

test('createTestGateHook: errored subagent is not gated (allow)', async () => {
  const runner = runnerWithGate({ command: 'exit 1' });
  const out = await runner.runSubagentStop(
    DONE_STOP({ status: 'error', output: '', reason: 'crashed' }),
  );
  assert.equal(out.decision, 'allow');
});

test('createTestGateHook: no command configured → allow, never block', async () => {
  const runner = runnerWithGate({});
  const out = await runner.runSubagentStop(DONE_STOP());
  assert.equal(out.decision, 'allow');
  assert.match(out.reason ?? '', /chưa cấu hình/);
});

test('createTestGateHook: unspawnable command → allow with a reason (fail-open, logged)', async () => {
  const logged = [];
  // A directory as cwd cannot be spawned through... use a bad shell
  // construct instead: a command that kills its own shell instantly
  // with a signal still counts as a run; instead force a spawn failure
  // by pointing cwd at a file that does not exist.
  const runner = runnerWithGate({
    command: 'true',
    cwd: path.join(makeTempDir(), 'does-not-exist'),
    logger: (m) => logged.push(m),
  });
  const out = await runner.runSubagentStop(DONE_STOP());
  assert.equal(out.decision, 'allow');
  assert.match(out.reason ?? '', /Test gate lỗi/);
  assert.ok(logged.length > 0, 'spawn failure must be logged');
});

test('createTestGateHook: gate runs in the bot workspace (cwd from context)', async () => {
  const ws = makeTempDir();
  const marker = path.join(ws, 'gate-ran.txt');
  const registry = new HookRegistry({ stateDir: makeTempDir() });
  registry.register(
    createTestGateHook({ command: `pwd > "${marker}"; true` }),
  );
  const runner = new HookRunner(registry);
  await runner.runSubagentStop(DONE_STOP(), { workspaceDir: ws });
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), ws);
});

test('TEST_GATE_HOOK_NAME is the registry name', () => {
  assert.equal(TEST_GATE_HOOK_NAME, 'subagent-test-gate');
  const hook = createTestGateHook({ command: 'npm test' });
  assert.equal(hook.name, 'subagent-test-gate');
  assert.deepEqual(hook.events, ['SubagentStop']);
});

// ---------------------------------------------------------------------------
// Multi-command gate (v1.01 extension)
// ---------------------------------------------------------------------------

test('runTestGate multi-command: stops at first failure, results list what ran', async () => {
  const res = await runTestGate({
    commands: ['true', `echo "FAIL: boom" >&2; exit 1`, 'true'],
    cwd: makeTempDir(),
  });
  assert.equal(res.passed, false);
  assert.equal(res.command, `echo "FAIL: boom" >&2; exit 1`);
  assert.equal(res.exitCode, 1);
  assert.equal(res.results.length, 2, 'third command never ran');
  assert.deepEqual(
    res.results.map((r) => r.passed),
    [true, false],
  );
  assert.match(res.failedSummary, /FAIL: boom/);
  const ctx = buildTestGateAdditionalContext(res, 'sub-1');
  assert.match(ctx, /chuỗi 2 lệnh/);
  assert.match(ctx, /true → PASS/);
});

test('runTestGate multi-command: all pass → passed, results cover every command', async () => {
  const res = await runTestGate({ commands: ['true', 'echo ok'], cwd: makeTempDir() });
  assert.equal(res.passed, true);
  assert.equal(res.command, 'echo ok');
  assert.equal(res.results.length, 2);
  assert.ok(res.results.every((r) => r.passed));
  assert.equal(res.failedSummary, '');
});

test('runTestGate single command: no results array (shape unchanged)', async () => {
  const res = await runTestGate({ command: 'true', cwd: makeTempDir() });
  assert.equal(res.passed, true);
  assert.equal(res.results, undefined);
});

test('normalizeTestGateConfig: commands[] wins, trims, drops empties, caps at 10', () => {
  const cfg = normalizeTestGateConfig({
    command: 'npm test',
    commands: ['  npm run typecheck  ', '', 'npm test', 42, null],
    timeoutMs: 60000,
  });
  assert.deepEqual(cfg.commands, ['npm run typecheck', 'npm test']);
  assert.equal(cfg.command, 'npm test');
  assert.equal(cfg.timeoutMs, 60000);
  const many = normalizeTestGateConfig({ commands: Array.from({ length: 15 }, (_, i) => `cmd${i}`) });
  assert.equal(many.commands.length, 10);
  assert.equal(normalizeTestGateConfig({ command: '   ' }), null);
  assert.equal(normalizeTestGateConfig({ commands: ['  '] }), null);
  assert.equal(normalizeTestGateConfig({ command: 'npm test', timeoutMs: 50 }).timeoutMs, undefined);
  assert.equal(normalizeTestGateConfig({ command: 'npm test', timeoutMs: 50 }).command, 'npm test');
  assert.equal(normalizeTestGateConfig('nope'), null);
  assert.equal(normalizeTestGateConfig(null), null);
});

test('testGateCommands: commands[] > command > empty', () => {
  assert.deepEqual(testGateCommands({ commands: ['a', 'b'], command: 'c' }), ['a', 'b']);
  assert.deepEqual(testGateCommands({ command: 'npm test' }), ['npm test']);
  assert.deepEqual(testGateCommands({}), []);
  assert.deepEqual(testGateCommands(null), []);
});

test('readTestGateConfig: reads commands[] from file', () => {
  const dir = makeTempDir();
  fs.writeFileSync(
    path.join(dir, 'hooks-test-gate.json'),
    JSON.stringify({ commands: ['npm run typecheck', 'npm test'], timeoutMs: 120000 }),
    'utf8',
  );
  const cfg = readTestGateConfig(dir);
  assert.deepEqual(testGateCommands(cfg), ['npm run typecheck', 'npm test']);
  assert.equal(cfg.timeoutMs, 120000);
});

test('createTestGateHook with commands: first failure blocks with chain digest', async () => {
  const hook = createTestGateHook({
    commands: ['true', `echo "FAIL: type error" >&2; exit 2`],
    cwd: makeTempDir(),
  });
  assert.equal(hook.events[0], 'SubagentStop');
  assert.match(hook.description, /2 lệnh kiểm tra/);
  const decision = await hook.handler(
    {
      event: 'SubagentStop',
      subagentId: 's1',
      name: 'worker',
      status: 'done',
      output: 'ok',
      durationMs: 10,
    },
    { botId: 'b', workspaceDir: makeTempDir() },
  );
  assert.equal(decision.action, 'block');
  assert.match(decision.additionalContext, /chuỗi 2 lệnh/);
  assert.match(decision.additionalContext, /FAIL: type error/);
});

test('createTestGateHook with commands: all pass → allow mentioning the chain', async () => {
  const hook = createTestGateHook({ commands: ['true', 'true'], cwd: makeTempDir() });
  const decision = await hook.handler(
    {
      event: 'SubagentStop',
      subagentId: 's1',
      status: 'done',
      output: 'ok',
      durationMs: 10,
    },
    { botId: 'b', workspaceDir: makeTempDir() },
  );
  assert.equal(decision.action, 'allow');
  assert.match(decision.reason, /2 lệnh kiểm tra/);
});

test('createTestGateHook with empty commands: never blocks (unconfigured)', async () => {
  const hook = createTestGateHook({ commands: ['  ', ''] });
  const decision = await hook.handler(
    {
      event: 'SubagentStop',
      subagentId: 's1',
      status: 'done',
      output: 'ok',
      durationMs: 10,
    },
    { botId: 'b', workspaceDir: makeTempDir() },
  );
  assert.equal(decision.action, 'allow');
  assert.match(decision.reason, /chưa cấu hình/);
});
