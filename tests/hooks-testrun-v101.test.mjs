/**
 * Tests for the hook test-run (v1.01):
 * `packages/core/src/hooks/testRun.ts` + the headless CLI
 * (`open-bot hooks list|test|log|gate` in `apps/cli/src/cli.ts`).
 *
 * Under test:
 * - `buildSampleEvent`: one read-only payload per event kind (all 10).
 * - `testRunHookCommand`: exit 0 allow / JSON modify / exit 2 block /
 *   non-zero exit error / timeout / wrong event rejected / bad config
 *   rejected; sample payload reaches the command on stdin.
 * - CLI (spawned for real, temp data dir, no network, no key):
 *   `hooks list` (empty + with a hook), `hooks test` (allow + block +
 *   unknown hook → exit 1), `hooks log` (empty), `hooks gate`
 *   (unconfigured), `--help` mentions hooks.
 *
 * Run after building core + cli:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/cli
 *   node --test tests/hooks-testrun-v101.test.mjs
 */
import { test, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  ALL_HOOK_EVENTS,
  buildSampleEvent,
  describeSampleEvent,
  testRunHookCommand,
} from '../packages/core/dist/hooks/index.js';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-testrun-v101-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// buildSampleEvent / describeSampleEvent (pure)
// ---------------------------------------------------------------------------

test('buildSampleEvent: a payload for every event kind, all read-only', () => {
  for (const kind of ALL_HOOK_EVENTS) {
    const payload = buildSampleEvent(kind);
    assert.equal(typeof payload, 'object');
    assert.ok(!('password' in payload) && !('apiKey' in payload));
    const text = JSON.stringify(payload);
    assert.ok(!text.includes('rm -rf'), `sample for ${kind} must stay read-only`);
    assert.ok(describeSampleEvent(kind).startsWith(kind), kind);
  }
  assert.equal(buildSampleEvent('PreToolUse').toolName, 'read_file');
  assert.equal(buildSampleEvent('SubagentStop').status, 'done');
  assert.equal(buildSampleEvent('UserPromptSubmit').prompt, 'Hello, please summarise README.md.');
  assert.equal(buildSampleEvent('PostCompact').fallbackUsed, false);
});

test('buildSampleEvent: unknown kind returns an empty payload', () => {
  assert.deepEqual(buildSampleEvent('Nope'), {});
});

// ---------------------------------------------------------------------------
// testRunHookCommand (spawn)
// ---------------------------------------------------------------------------

const ALLOW_ENTRY = {
  name: 'allow-er',
  command: 'true',
  events: ['PreToolUse'],
};
const BLOCK_ENTRY = {
  name: 'block-er',
  command: `echo "refusing this one"; exit 2`,
  events: ['PreToolUse', 'SubagentStop'],
};
const MODIFY_ENTRY = {
  name: 'modify-er',
  command: `echo '{"action":"modify","context":"injected by test run"}'`,
  events: ['SessionStart'],
};

test('testRunHookCommand: exit 0 no output → allow, with cwd + event', async () => {
  const ws = makeTempDir();
  const res = await testRunHookCommand(ALLOW_ENTRY, { workspaceDir: ws });
  assert.equal(res.ok, true);
  assert.equal(res.name, 'allow-er');
  assert.equal(res.event, 'PreToolUse');
  assert.equal(res.cwd, ws);
  assert.deepEqual(res.decision, { action: 'allow' });
  assert.equal(res.exitCode, 0);
  assert.equal(res.timedOut, false);
  assert.ok(res.durationMs >= 0);
});

test('testRunHookCommand: JSON decision on stdout is honoured', async () => {
  const res = await testRunHookCommand(MODIFY_ENTRY);
  assert.equal(res.ok, true);
  assert.equal(res.event, 'SessionStart');
  assert.equal(res.decision.action, 'modify');
  assert.equal(res.decision.context, 'injected by test run');
});

test('testRunHookCommand: exit 2 → block with the plain-text reason', async () => {
  const res = await testRunHookCommand(BLOCK_ENTRY);
  assert.equal(res.ok, true);
  assert.equal(res.decision.action, 'block');
  assert.match(res.decision.reason, /refusing this one/);
  assert.equal(res.exitCode, 2);
});

test('testRunHookCommand: exit 2 on SubagentStop keeps additionalContext', async () => {
  const res = await testRunHookCommand(
    {
      name: 'gate',
      command: `echo '{"action":"block","reason":"tests failed","additionalContext":"FAIL: login"}'; exit 2`,
      events: ['SubagentStop'],
    },
    { event: 'SubagentStop' },
  );
  assert.equal(res.ok, true);
  assert.equal(res.decision.action, 'block');
  assert.equal(res.decision.additionalContext, 'FAIL: login');
});

test('testRunHookCommand: non-zero exit → ok false with an error, stdout kept', async () => {
  const res = await testRunHookCommand({
    name: 'exploder',
    command: `echo "some output"; echo "bad thing" >&2; exit 7`,
    events: ['Stop'],
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /exited with code 7/);
  assert.match(res.stdout, /some output/);
  assert.match(res.stderr, /bad thing/);
  assert.equal(res.decision, undefined);
});

test('testRunHookCommand: timeout → ok false, timedOut true', async () => {
  const res = await testRunHookCommand(
    { name: 'slow', command: 'sleep 30', events: ['Stop'] },
    { timeoutMs: 200 },
  );
  assert.equal(res.ok, false);
  assert.equal(res.timedOut, true);
  assert.match(res.error, /timed out/);
});

test('testRunHookCommand: event outside the hook events is rejected', async () => {
  await assert.rejects(
    testRunHookCommand(ALLOW_ENTRY, { event: 'SessionStart' }),
    /không chạy cho event/,
  );
});

test('testRunHookCommand: invalid entry is rejected before spawning', async () => {
  await assert.rejects(
    testRunHookCommand({ name: 'x', command: '', events: ['PreToolUse'] }),
    /không hợp lệ/,
  );
});

test('testRunHookCommand: the sample payload arrives on stdin', async () => {
  const dir = makeTempDir();
  const seenFile = path.join(dir, 'seen.json');
  const res = await testRunHookCommand({
    name: 'recorder',
    command: `cat > "${seenFile}"; echo '{"action":"allow"}'`,
    events: ['PreToolUse'],
  });
  assert.equal(res.ok, true);
  const seen = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
  assert.equal(seen.event, 'PreToolUse');
  assert.equal(seen.toolName, 'read_file');
  assert.equal(seen.args.path, 'README.md');
});

// ---------------------------------------------------------------------------
// CLI: open-bot hooks … (spawned for real)
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const cli = path.join(repo, 'apps', 'cli', 'dist', 'cli.js');

const cliDirs = [];
function makeCliDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-hooks-cli-v101-'));
  cliDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of cliDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function runCli(args, dataDir) {
  return spawnSync(process.execPath, [cli, ...args, '--data-dir', dataDir], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, OPENBOT_DATA_DIR: dataDir },
  });
}

function writeCommands(dataDir, commands) {
  fs.writeFileSync(
    path.join(dataDir, 'hooks-commands.json'),
    JSON.stringify(commands, null, 2),
    'utf8',
  );
}

test('cli hooks: --help mentions the hooks commands', () => {
  const res = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /hooks list/);
  assert.match(res.stdout, /hooks test/);
  assert.match(res.stdout, /hooks log/);
});

test('cli hooks list: empty data dir → empty message, exit 0', () => {
  const dir = makeCliDir();
  const res = runCli(['hooks', 'list'], dir);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Chưa có hook lệnh nào/);
});

test('cli hooks list: lists command hooks + test gate', () => {
  const dir = makeCliDir();
  writeCommands(dir, [
    { name: 'my-gate', command: 'npm test', events: ['SubagentStop'], timeoutMs: 60000 },
    { name: 'bad name!', command: '', events: [] },
  ]);
  fs.writeFileSync(
    path.join(dir, 'hooks-test-gate.json'),
    JSON.stringify({ command: 'npm test' }),
    'utf8',
  );
  const res = runCli(['hooks', 'list'], dir);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /my-gate/);
  assert.match(res.stdout, /SubagentStop/);
  assert.match(res.stdout, /npm test/);
  assert.ok(!res.stdout.includes('bad name!'), 'invalid entries are skipped');
  assert.match(res.stdout, /Test gate: npm test/);
});

test('cli hooks list --json: machine-readable', () => {
  const dir = makeCliDir();
  writeCommands(dir, [{ name: 'a', command: 'true', events: ['PreToolUse'] }]);
  const res = runCli(['hooks', 'list', '--json'], dir);
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.commands.length, 1);
  assert.equal(parsed.commands[0].name, 'a');
});

test('cli hooks test: allow hook → exit 0, block hook → exit 0 with block decision', () => {
  const dir = makeCliDir();
  writeCommands(dir, [
    { name: 'allow-er', command: 'true', events: ['PreToolUse'] },
    { name: 'block-er', command: `echo "nope"; exit 2`, events: ['PreToolUse'] },
  ]);
  const allow = runCli(['hooks', 'test', 'allow-er'], dir);
  assert.equal(allow.status, 0);
  assert.match(allow.stdout, /decision: allow/);
  assert.match(allow.stdout, /exit: 0/);

  const block = runCli(['hooks', 'test', 'block-er'], dir);
  assert.equal(block.status, 0, 'a block decision is a successful test run');
  assert.match(block.stdout, /decision: block/);
  assert.match(block.stdout, /nope/);
});

test('cli hooks test: failing hook → exit 1; unknown hook → exit 1', () => {
  const dir = makeCliDir();
  writeCommands(dir, [{ name: 'exploder', command: 'exit 7', events: ['Stop'] }]);
  const fail = runCli(['hooks', 'test', 'exploder'], dir);
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /ERROR/);
  assert.match(fail.stdout, /exited with code 7/);

  const unknown = runCli(['hooks', 'test', 'nope'], dir);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Không tìm thấy hook lệnh "nope"/);
});

test('cli hooks test: --event picks the sample event; bad event → exit 1', () => {
  const dir = makeCliDir();
  writeCommands(dir, [
    { name: 'multi', command: `echo "event=$OPENBOT_HOOK_EVENT"; exit 2`, events: ['PreToolUse', 'SessionStart'] },
  ]);
  const res = runCli(['hooks', 'test', 'multi', '--event', 'SessionStart'], dir);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /SessionStart/);

  const bad = runCli(['hooks', 'test', 'multi', '--event', 'Nope'], dir);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Event không hợp lệ/);
});

test('cli hooks log: empty → message; with records → rows', () => {
  const dir = makeCliDir();
  const empty = runCli(['hooks', 'log'], dir);
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /Chưa có lần hook chạy nào/);

  fs.writeFileSync(
    path.join(dir, 'hook-executions.jsonl'),
    JSON.stringify({
      seq: 1,
      at: '2026-11-14T00:00:00.000Z',
      hookName: 'my-gate',
      event: 'SubagentStop',
      action: 'block',
      durationMs: 42,
      reason: 'tests failed',
      timedOut: false,
    }) + '\n',
    'utf8',
  );
  const res = runCli(['hooks', 'log'], dir);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /my-gate/);
  assert.match(res.stdout, /SubagentStop/);
  assert.match(res.stdout, /block/);
  assert.match(res.stdout, /tests failed/);

  const json = runCli(['hooks', 'log', '--json'], dir);
  assert.equal(json.status, 0);
  assert.equal(JSON.parse(json.stdout).length, 1);
});

test('cli hooks gate: unconfigured vs configured', () => {
  const dir = makeCliDir();
  const empty = runCli(['hooks', 'gate'], dir);
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /chưa cấu hình/);

  fs.writeFileSync(
    path.join(dir, 'hooks-test-gate.json'),
    JSON.stringify({ command: 'npm run typecheck', timeoutMs: 120000 }),
    'utf8',
  );
  const res = runCli(['hooks', 'gate'], dir);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /npm run typecheck/);
  assert.match(res.stdout, /120000/);
});

test('cli hooks: no subcommand → usage error, exit 1', () => {
  const dir = makeCliDir();
  const res = runCli(['hooks'], dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /hooks cần subcommand/);
});

test('cli hooks gate: multi-command config lists every command in order', () => {
  const dir = makeCliDir();
  fs.writeFileSync(
    path.join(dir, 'hooks-test-gate.json'),
    JSON.stringify({ commands: ['npm run typecheck', 'npm test'], timeoutMs: 120000 }),
    'utf8',
  );
  const res = runCli(['hooks', 'gate'], dir);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /2 lệnh/);
  assert.match(res.stdout, /1\. npm run typecheck/);
  assert.match(res.stdout, /2\. npm test/);
  assert.match(res.stdout, /120000/);
  assert.ok(res.stdout.indexOf('npm run typecheck') < res.stdout.indexOf('npm test'));
});
