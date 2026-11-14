/**
 * Tests for shell-command hooks (v1.01):
 * `packages/core/src/hooks/shellCommandRunner.ts` +
 * `HookRegistry.registerCommandHook` / `applyCommandSettings`.
 *
 * Protocol under test (see shellCommandRunner.ts):
 * - stdin: one JSON line `{ event, ...input }`.
 * - exit 0 → JSON decision on the last stdout line, or plain allow.
 * - exit 2 → block (reason = last plain-text line, else stderr, else default).
 * - any other non-zero exit / timeout / spawn failure → hook error.
 * - env: safe allowlist only; secret-looking names never reach the child;
 *   `OPENBOT_HOOK_EVENT` carries the event kind.
 * - config validation: name / command / events / timeoutMs / env.
 *
 * Shell commands use `/bin/sh -c` on this machine (POSIX). Windows uses
 * `cmd.exe /c` — the same tests use only portable shell constructs
 * (`echo`, `exit`, `cat`, `sleep`, `printenv`/`env`) where possible.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/hooks-command-v101.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildHookCommandEnv,
  HOOK_COMMAND_BLOCK_EXIT_CODE,
  HookRegistry,
  HookRunner,
  parseHookDecisionLine,
  runHookCommand,
  runShellCommand,
  safeEnvForHookCommand,
  validateHookCommandEntry,
} from '../packages/core/dist/hooks/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-hook-cmd-v101-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function registryWithCommand(entry, opts = {}) {
  const registry = new HookRegistry({ stateDir: makeTempDir() });
  registry.registerCommandHook(entry, opts);
  return registry;
}

// ---------------------------------------------------------------------------
// Decision parsing
// ---------------------------------------------------------------------------

test('parseHookDecisionLine: accepts {action}, {decision} string, nested {decision:{action}}', () => {
  assert.deepEqual(parseHookDecisionLine('{"action":"block","reason":"no"}'), {
    action: 'block',
    reason: 'no',
  });
  assert.deepEqual(parseHookDecisionLine('{"decision":"allow"}'), { action: 'allow' });
  assert.deepEqual(
    parseHookDecisionLine('{"decision":{"action":"modify","context":"ctx"}}'),
    { action: 'modify', context: 'ctx' },
  );
  assert.deepEqual(
    parseHookDecisionLine('{"action":"modify","args":{"path":"/tmp/x"},"additionalContext":"fix it"}'),
    { action: 'modify', args: { path: '/tmp/x' }, additionalContext: 'fix it' },
  );
  assert.equal(parseHookDecisionLine('not json'), null);
  assert.equal(parseHookDecisionLine('{"action":"explode"}'), null);
  assert.equal(parseHookDecisionLine(''), null);
  assert.equal(parseHookDecisionLine('{"action":123}'), null);
});

// ---------------------------------------------------------------------------
// Safe env
// ---------------------------------------------------------------------------

test('safeEnvForHookCommand: allowlist only, secret-looking names dropped', () => {
  const env = safeEnvForHookCommand({
    PATH: '/usr/bin',
    HOME: '/home/x',
    GEMINI_API_KEY: 'sk-secret',
    MY_TOKEN: 'tok',
    FOO: 'bar',
    LANG: 'en_US.UTF-8',
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/x');
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.MY_TOKEN, undefined);
  assert.equal(env.FOO, undefined);
});

test('buildHookCommandEnv: event marker + validated extra vars, secrets dropped', () => {
  const env = buildHookCommandEnv('PreToolUse', { MY_FLAG: '1', API_KEY: 'nope' }, { PATH: '/bin' });
  assert.equal(env.OPENBOT_HOOK_EVENT, 'PreToolUse');
  assert.equal(env.MY_FLAG, '1');
  assert.equal(env.API_KEY, undefined);
});

// ---------------------------------------------------------------------------
// runShellCommand (low level)
// ---------------------------------------------------------------------------

test('runShellCommand: exit code, stdout/stderr, duration', async () => {
  const ok = await runShellCommand('echo hello; echo err >&2', { timeoutMs: 5000 });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.signal, null);
  assert.equal(ok.timedOut, false);
  assert.match(ok.stdout, /hello/);
  assert.match(ok.stderr, /err/);
  assert.ok(ok.durationMs >= 0);

  const fail = await runShellCommand('exit 3', { timeoutMs: 5000 });
  assert.equal(fail.exitCode, 3);
  assert.equal(fail.timedOut, false);
});

test('runShellCommand: timeout kills the command', async () => {
  const res = await runShellCommand('sleep 30', { timeoutMs: 200 });
  assert.equal(res.timedOut, true);
  assert.ok(res.durationMs < 5000, `took ${res.durationMs}ms`);
});

// ---------------------------------------------------------------------------
// runHookCommand (exit-code protocol)
// ---------------------------------------------------------------------------

test('runHookCommand: exit 0 with no output → allow', async () => {
  const d = await runHookCommand('true', 'PreToolUse', { toolName: 'x', toolCallId: '1', args: {} });
  assert.deepEqual(d, { action: 'allow' });
});

test('runHookCommand: exit 0 with JSON decision line → that decision', async () => {
  const d = await runHookCommand(
    `echo "debug line"; echo '{"action":"modify","context":"injected"}'`,
    'PreToolUse',
    { toolName: 'x', toolCallId: '1', args: {} },
  );
  assert.equal(d.action, 'modify');
  assert.equal(d.context, 'injected');
});

test('runHookCommand: exit 0 with plain-text stdout → allow (output is not a decision)', async () => {
  const d = await runHookCommand(`echo "just checking"`, 'SessionStart', {});
  assert.deepEqual(d, { action: 'allow' });
});

test('runHookCommand: exit 2 → block with the plain-text line as reason', async () => {
  const d = await runHookCommand(
    `echo "dangerous path, refusing"; exit 2`,
    'PreToolUse',
    { toolName: 'x', toolCallId: '1', args: {} },
  );
  assert.equal(d.action, 'block');
  assert.match(d.reason, /dangerous path/);
});

test('runHookCommand: exit 2 with a JSON block decision → that decision', async () => {
  const d = await runHookCommand(
    `echo '{"action":"block","reason":"json reason","additionalContext":"fix this"}'; exit 2`,
    'SubagentStop',
    { subagentId: 's', status: 'done', output: '', durationMs: 1 },
  );
  assert.equal(d.action, 'block');
  assert.equal(d.reason, 'json reason');
  assert.equal(d.additionalContext, 'fix this');
});

test('runHookCommand: exit 2 with no output → block with a default reason', async () => {
  const d = await runHookCommand('exit 2', 'Stop', {});
  assert.equal(d.action, 'block');
  assert.match(d.reason, /exit 2/);
});

test('runHookCommand: exit 3 → rejects (hook error)', async () => {
  await assert.rejects(
    runHookCommand('echo "boom" >&2; exit 3', 'PreToolUse', {}),
    /exited with code 3/,
  );
});

test('runHookCommand: timeout → rejects with a timeout error', async () => {
  await assert.rejects(
    runHookCommand('sleep 30', 'PreToolUse', {}, { timeoutMs: 200 }),
    /timed out after 200ms/,
  );
});

test('runHookCommand: event JSON arrives on stdin; env marker is set', async () => {
  const dir = makeTempDir();
  const seenFile = path.join(dir, 'seen.json');
  const seenEnv = path.join(dir, 'seen-env.txt');
  const script = [
    `cat > "${seenFile}"`,
    `echo "$OPENBOT_HOOK_EVENT" > "${seenEnv}"`,
    `echo '{"action":"allow"}'`,
  ].join('\n');
  const d = await runHookCommand(script, 'PostToolUse', {
    toolName: 'write_file',
    toolCallId: 'c-9',
    args: { path: 'a.txt' },
    result: { ok: true, output: 'ok' },
  });
  assert.equal(d.action, 'allow');
  const seen = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
  assert.equal(seen.event, 'PostToolUse');
  assert.equal(seen.toolName, 'write_file');
  assert.equal(seen.toolCallId, 'c-9');
  assert.deepEqual(seen.args, { path: 'a.txt' });
  assert.equal(fs.readFileSync(seenEnv, 'utf8').trim(), 'PostToolUse');
});

test('runHookCommand: secret env vars never reach the child', async () => {
  const dir = makeTempDir();
  const outFile = path.join(dir, 'env.txt');
  // Even if the parent process carries a key, the child must not see it.
  process.env.OPENBOT_TEST_LEAK_KEY = 'should-not-leak';
  try {
    await runHookCommand(`env > "${outFile}"; exit 0`, 'SessionStart', {});
    const envText = fs.readFileSync(outFile, 'utf8');
    assert.ok(!envText.includes('should-not-leak'), 'parent secret leaked to hook command');
    assert.ok(!envText.includes('OPENBOT_TEST_LEAK_KEY'));
  } finally {
    delete process.env.OPENBOT_TEST_LEAK_KEY;
  }
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

test('validateHookCommandEntry: valid entry is normalised with defaults', () => {
  const r = validateHookCommandEntry({
    name: ' my-gate ',
    command: ' npm test ',
    events: ['SubagentStop', 'SubagentStop', 'PreToolUse'],
  });
  assert.equal(r.valid, true);
  assert.deepEqual(r.entry, {
    name: 'my-gate',
    command: 'npm test',
    events: ['SubagentStop', 'PreToolUse'],
    enabled: true,
    timeoutMs: 10000,
  });
});

test('validateHookCommandEntry: collects every problem', () => {
  const r = validateHookCommandEntry({
    name: 'Bad Name!',
    command: '   ',
    events: [],
    timeoutMs: 5,
    env: { API_KEY: 'x', OK_VAR: 123 },
    enabled: 'yes',
  });
  assert.equal(r.valid, false);
  const fields = r.issues.map((i) => i.field);
  assert.ok(fields.includes('name'));
  assert.ok(fields.includes('command'));
  assert.ok(fields.includes('events'));
  assert.ok(fields.includes('timeoutMs'));
  assert.ok(fields.some((f) => f === 'env.API_KEY'));
  assert.ok(fields.some((f) => f === 'env.OK_VAR'));
  assert.ok(fields.includes('enabled'));
  assert.equal(r.entry, undefined);
});

test('validateHookCommandEntry: non-object input is invalid, never throws', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    const r = validateHookCommandEntry(bad);
    assert.equal(r.valid, false);
    assert.ok(r.issues.length > 0);
  }
});

// ---------------------------------------------------------------------------
// Registry: registerCommandHook / applyCommandSettings
// ---------------------------------------------------------------------------

test('registerCommandHook: exit-2 command blocks PreToolUse through the runner', async () => {
  const registry = registryWithCommand({
    name: 'deny-all',
    command: `echo "no tools allowed"; exit 2`,
    events: ['PreToolUse'],
  });
  const runner = new HookRunner(registry);
  const out = await runner.runPreToolUse({ toolName: 'shell_exec', toolCallId: 'c1', args: {} });
  assert.equal(out.decision, 'block');
  assert.equal(out.blockedBy, 'deny-all');
  assert.match(out.reason, /no tools allowed/);
  assert.deepEqual(registry.listCommandHooks().map((h) => h.name), ['deny-all']);
});

test('registerCommandHook: command runs with the bot workspace as cwd', async () => {
  const ws = makeTempDir();
  const marker = path.join(ws, 'cwd-check.txt');
  const registry = registryWithCommand({
    name: 'cwd-check',
    command: `pwd > "${marker}"; echo '{"action":"allow"}'`,
    events: ['SessionStart'],
  });
  const runner = new HookRunner(registry);
  const out = await runner.runSessionStart(
    { source: 'chat' },
    { workspaceDir: ws },
  );
  assert.equal(out.hooksRun.length, 1);
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), ws);
});

test('registerCommandHook: bad config throws at registration time', () => {
  const registry = new HookRegistry({ stateDir: makeTempDir() });
  assert.throws(
    () => registry.registerCommandHook({ name: 'x', command: '', events: ['PreToolUse'] }),
    /không hợp lệ/,
  );
  assert.throws(
    () =>
      registry.registerCommandHook({
        name: 'x',
        command: 'true',
        events: ['PreToolUse'],
        env: { SECRET_KEY: 'v' },
      }),
    /secret/,
  );
});

test('registerCommandHook: disabled entry does not run, enable() re-enables it', async () => {
  const registry = registryWithCommand({
    name: 'gate',
    command: 'exit 2',
    events: ['PreToolUse'],
    enabled: false,
  });
  const runner = new HookRunner(registry);
  const off = await runner.runPreToolUse({ toolName: 't', toolCallId: '1', args: {} });
  assert.equal(off.decision, 'allow');
  assert.deepEqual(off.hooksRun, []);

  assert.equal(registry.enable('gate'), true);
  const on = await runner.runPreToolUse({ toolName: 't', toolCallId: '1', args: {} });
  assert.equal(on.decision, 'block');
});

test('applyCommandSettings: add / update / remove / report invalid', async () => {
  const registry = new HookRegistry({ stateDir: makeTempDir() });
  const first = registry.applyCommandSettings({
    commands: [
      { name: 'a', command: 'echo a; exit 2', events: ['PreToolUse'] },
      { name: 'b', command: 'true', events: ['SessionStart'] },
      { name: 'bad name!', command: '', events: [] },
    ],
  });
  assert.deepEqual(first.applied.sort(), ['a', 'b']);
  assert.deepEqual(first.removed, []);
  assert.equal(first.invalid.length, 1);
  assert.equal(registry.list().length, 2);

  // Update 'a' (new command), drop 'b', keep the invalid entry reported.
  const second = registry.applyCommandSettings({
    commands: [{ name: 'a', command: 'true', events: ['PreToolUse'] }],
  });
  assert.deepEqual(second.applied, ['a']);
  assert.deepEqual(second.removed, ['b']);
  assert.deepEqual(second.invalid, []);
  assert.deepEqual(registry.listCommandHooks().map((h) => h.name), ['a']);
  const runner = new HookRunner(registry);
  const out = await runner.runPreToolUse({ toolName: 't', toolCallId: '1', args: {} });
  assert.equal(out.decision, 'allow', 'updated command must be the one that runs');
});

test('applyCommandSettings: a failing command hook is a hook error, not a crash', async () => {
  const registry = new HookRegistry({ stateDir: makeTempDir() });
  registry.applyCommandSettings({
    commands: [{ name: 'exploder', command: 'exit 7', events: ['PreToolUse'] }],
  });
  const runner = new HookRunner(registry);
  const out = await runner.runPreToolUse({ toolName: 't', toolCallId: '1', args: {} });
  assert.equal(out.decision, 'block', 'fail-closed by default');
  assert.equal(out.hookErrors.length, 1);
  assert.match(out.hookErrors[0].error, /exited with code 7/);
});

test('HOOK_COMMAND_BLOCK_EXIT_CODE is 2', () => {
  assert.equal(HOOK_COMMAND_BLOCK_EXIT_CODE, 2);
});
