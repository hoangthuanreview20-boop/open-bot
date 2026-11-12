/**
 * Tests for hook scripts (v0.18): external script files run
 * out-of-process via `packages/core/src/hooks/scriptRunner.ts` and
 * registered with `HookRegistry.registerScriptHook()`.
 *
 * Protocol under test: the script reads ONE JSON line
 * `{ event, ...input }` on stdin and prints its decision as the LAST
 * non-empty stdout line (`{ action: 'allow' | 'block' | 'modify',
 * reason?, args?, output?, context? }`).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/hook-script-v018.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DEFAULT_HOOK_SCRIPT_TIMEOUT_MS,
  HookRegistrationError,
  HookRegistry,
  HookRunner,
  runHookScript,
} from '../packages/core/dist/hooks/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-hook-script-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function writeScript(dir, name, code) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, code, 'utf8');
  return file;
}

/** Script that records what it received on stdin, then answers `decision`. */
function recordingScript(outFile, decisionJson) {
  return `
    const fs = require('node:fs');
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => {
      fs.writeFileSync(${JSON.stringify(outFile)}, buf.trim(), 'utf8');
      console.log(JSON.stringify(${decisionJson}));
    });
  `;
}

function registryIn(dir) {
  return new HookRegistry({ stateDir: makeTempDir() });
}

const PRE = (toolName, args, toolCallId = 'call-1') => ({
  toolName,
  toolCallId,
  args,
});

// ---------------------------------------------------------------------------
// (1) allow: the script runs, and the event input reaches it
// ---------------------------------------------------------------------------

test('script hook returning allow runs, and the event input reaches the script', async () => {
  const dir = makeTempDir();
  const seenFile = path.join(dir, 'seen.json');
  const script = writeScript(
    dir,
    'allow-hook.cjs',
    recordingScript(seenFile, `{ action: 'allow', reason: 'fine by script' }`),
  );
  const registry = registryIn(dir);
  registry.registerScriptHook(
    { name: 'allow-script', events: ['PreToolUse'], workspaceDir: dir },
    script,
  );
  const runner = new HookRunner(registry, { timeoutMs: 15000 });
  const out = await runner.runPreToolUse(PRE('shell_exec', { command: 'echo hi' }), {
    workspaceDir: dir,
  });
  assert.equal(out.decision, 'allow');
  assert.deepEqual(out.hookErrors, []);
  assert.deepEqual(out.hooksRun, ['allow-script']);

  const seen = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
  assert.equal(seen.event, 'PreToolUse');
  assert.equal(seen.toolName, 'shell_exec');
  assert.equal(seen.toolCallId, 'call-1');
  assert.deepEqual(seen.args, { command: 'echo hi' });
});

// ---------------------------------------------------------------------------
// (2) block + reason: the runner blocks, debug stdout lines are ignored
// ---------------------------------------------------------------------------

test('script hook returning block + reason blocks the call (last stdout line wins)', async () => {
  const dir = makeTempDir();
  const seenFile = path.join(dir, 'seen.json');
  const script = writeScript(
    dir,
    'block-hook.cjs',
    `
    const fs = require('node:fs');
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => {
      fs.writeFileSync(${JSON.stringify(seenFile)}, buf.trim(), 'utf8');
      console.log('debug: checking the call...'); // not JSON — must be ignored
      console.log(JSON.stringify({ decision: 'block', reason: 'blocked by script' }));
    });
  `,
  );
  const registry = registryIn(dir);
  registry.registerScriptHook(
    { name: 'block-script', events: ['PreToolUse'], workspaceDir: dir },
    script,
  );
  const runner = new HookRunner(registry, { timeoutMs: 15000 });
  const out = await runner.runPreToolUse(PRE('shell_exec', { command: 'rm -rf /' }), {
    workspaceDir: dir,
  });
  assert.equal(out.decision, 'block');
  assert.equal(out.blockedBy, 'block-script');
  assert.equal(out.reason, 'blocked by script');
  assert.deepEqual(out.hookErrors, []);
  assert.ok(fs.existsSync(seenFile), 'script still received the event');
});

// ---------------------------------------------------------------------------
// (2b) modify: a script can rewrite tool args through the runner
// ---------------------------------------------------------------------------

test('script hook returning modify rewrites the tool args', async () => {
  const dir = makeTempDir();
  const script = writeScript(
    dir,
    'modify-hook.cjs',
    `
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => {
      const ev = JSON.parse(buf);
      console.log(JSON.stringify({
        action: 'modify',
        args: { command: ev.args.command + ' --verbose' },
        reason: 'added flag',
      }));
    });
  `,
  );
  const registry = registryIn(dir);
  registry.registerScriptHook(
    { name: 'modify-script', events: ['PreToolUse'], workspaceDir: dir },
    script,
  );
  const runner = new HookRunner(registry, { timeoutMs: 15000 });
  const out = await runner.runPreToolUse(PRE('shell_exec', { command: 'npm test' }), {
    workspaceDir: dir,
  });
  assert.equal(out.decision, 'modify');
  assert.equal(out.args.command, 'npm test --verbose');
  assert.equal(out.reason, 'added flag');
  assert.deepEqual(out.hookErrors, []);
});

// ---------------------------------------------------------------------------
// (3) failing script: non-zero exit / timeout / garbage output
// ---------------------------------------------------------------------------

test('script exiting non-zero is a clear hook error, not a run crash', async () => {
  const dir = makeTempDir();
  const script = writeScript(
    dir,
    'boom-hook.cjs',
    `
    process.stdin.resume();
    console.error('script blew up: something went wrong');
    process.exit(3);
  `,
  );
  const registry = registryIn(dir);
  registry.registerScriptHook(
    { name: 'boom-script', events: ['PreToolUse'], workspaceDir: dir },
    script,
  );
  const runner = new HookRunner(registry, { timeoutMs: 15000, onHookError: 'allow' });
  const started = Date.now();
  const out = await runner.runPreToolUse(PRE('shell_exec', { command: 'echo hi' }), {
    workspaceDir: dir,
  });
  assert.ok(Date.now() - started < 10000, 'must not hang');
  assert.equal(out.decision, 'allow', 'onHookError=allow lets the call through');
  assert.equal(out.hookErrors.length, 1);
  assert.equal(out.hookErrors[0].hookName, 'boom-script');
  assert.match(out.hookErrors[0].error, /exited with code 3/);
  assert.match(out.hookErrors[0].error, /script blew up/);
});

test('sleeping script times out fast (short timeout in test) and is killed, run continues', async () => {
  const dir = makeTempDir();
  const script = writeScript(
    dir,
    'sleep-hook.cjs',
    `process.stdin.resume(); setTimeout(() => {}, 60000); // never answers`,
  );
  const registry = registryIn(dir);
  registry.registerScriptHook(
    { name: 'sleep-script', events: ['PreToolUse'], workspaceDir: dir, timeoutMs: 300 },
    script,
  );
  // Runner timeout (15s) is longer than the script timeout (300ms), so
  // the script runner's own timeout is what fires. onHookError=allow so
  // the run continues past the failed script hook (default is fail-closed).
  const runner = new HookRunner(registry, { timeoutMs: 15000, onHookError: 'allow' });
  const started = Date.now();
  const out = await runner.runPreToolUse(PRE('shell_exec', { command: 'echo hi' }), {
    workspaceDir: dir,
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `must not wait for the 60s sleep (took ${elapsed}ms)`);
  assert.equal(out.decision, 'allow');
  assert.equal(out.hookErrors.length, 1);
  assert.equal(out.hookErrors[0].hookName, 'sleep-script');
  assert.match(out.hookErrors[0].error, /timed out after 300ms/);
});

test('runHookScript rejects directly on timeout and on garbage stdout', async () => {
  const dir = makeTempDir();
  const sleep = writeScript(
    dir,
    'sleep.cjs',
    `process.stdin.resume(); setTimeout(() => {}, 60000);`,
  );
  await assert.rejects(
    runHookScript(sleep, 'PreToolUse', { toolName: 'x', toolCallId: 'c', args: {} }, { timeoutMs: 200, workspaceDir: dir }),
    /timed out after 200ms/,
  );

  const garbage = writeScript(
    dir,
    'garbage.cjs',
    `process.stdin.resume(); console.log('hello, not json');`,
  );
  await assert.rejects(
    runHookScript(garbage, 'PreToolUse', { toolName: 'x', toolCallId: 'c', args: {} }, { workspaceDir: dir }),
    /invalid JSON|invalid decision/,
  );
});

// ---------------------------------------------------------------------------
// (4) path confinement: missing file / file outside the allowed dirs
// ---------------------------------------------------------------------------

test('registerScriptHook rejects a missing script file and a script outside the allowed dirs', () => {
  const dir = makeTempDir();
  const otherDir = makeTempDir();
  const outsideScript = writeScript(
    otherDir,
    'outside.cjs',
    `console.log(JSON.stringify({ action: 'allow' }));`,
  );
  const registry = registryIn(dir);

  assert.throws(
    () =>
      registry.registerScriptHook(
        { name: 'ghost', events: ['PreToolUse'], workspaceDir: dir },
        path.join(dir, 'does-not-exist.cjs'),
      ),
    (e) => e instanceof HookRegistrationError && /does not exist/.test(e.message),
  );

  // Outside the workspace dir (no allowedDirs given): refused.
  assert.throws(
    () =>
      registry.registerScriptHook(
        { name: 'outside', events: ['PreToolUse'], workspaceDir: dir },
        outsideScript,
      ),
    (e) => e instanceof HookRegistrationError && /outside the allowed directories/.test(e.message),
  );

  // Same file IS allowed when its dir is listed in allowedDirs
  // (the bundle-dir case: script lives in the bundle, not the workspace).
  const registered = registry.registerScriptHook(
    {
      name: 'bundle-script',
      events: ['PreToolUse'],
      workspaceDir: dir,
      allowedDirs: [otherDir],
    },
    outsideScript,
  );
  assert.equal(registered.name, 'bundle-script');
  assert.equal(registry.get('bundle-script')?.source, 'plugin');
});

// ---------------------------------------------------------------------------
// (5) child env: the script never sees the parent's secrets
// ---------------------------------------------------------------------------

test('child env does not contain secret-looking vars (names only, never values)', async () => {
  const dir = makeTempDir();
  const envFile = path.join(dir, 'env-keys.json');
  const script = writeScript(
    dir,
    'env-hook.cjs',
    `
    const fs = require('node:fs');
    process.stdin.resume();
    // Write only the VARIABLE NAMES the child can see — never values.
    fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(Object.keys(process.env).sort()), 'utf8');
    console.log(JSON.stringify({ action: 'allow' }));
  `,
  );
  // Fake secret markers in the PARENT env (fake values, test-only names).
  const fakeSecretName = 'OPEN_BOT_TEST_FAKE_API_KEY';
  const fakeMarkerName = 'OPEN_BOT_TEST_CUSTOM_MARKER';
  process.env[fakeSecretName] = 'fake-value-not-a-real-secret';
  process.env[fakeMarkerName] = 'fake-marker';
  try {
    const registry = registryIn(dir);
    registry.registerScriptHook(
      { name: 'env-script', events: ['PreToolUse'], workspaceDir: dir },
      script,
    );
    const runner = new HookRunner(registry, { timeoutMs: 15000 });
    const out = await runner.runPreToolUse(PRE('shell_exec', { command: 'echo hi' }), {
      workspaceDir: dir,
    });
    assert.equal(out.decision, 'allow');
    assert.deepEqual(out.hookErrors, []);

    const visibleNames = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    assert.ok(Array.isArray(visibleNames));
    assert.ok(!visibleNames.includes(fakeSecretName), 'secret-looking name must not leak');
    assert.ok(!visibleNames.includes(fakeMarkerName), 'non-allowlisted name must not leak');
    assert.ok(visibleNames.includes('PATH'), 'minimal safe env (PATH) is still passed');
  } finally {
    delete process.env[fakeSecretName];
    delete process.env[fakeMarkerName];
  }
});

// ---------------------------------------------------------------------------
// Defaults / exports sanity
// ---------------------------------------------------------------------------

test('default script timeout is 10s', () => {
  assert.equal(DEFAULT_HOOK_SCRIPT_TIMEOUT_MS, 10_000);
});
