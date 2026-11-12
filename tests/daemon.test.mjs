/**
 * local-exec-daemon tests (node:test). Spawns the REAL daemon process
 * and drives it through DaemonClient — imports the BUILT package, so
 * run the build first:
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/daemon.test.mjs
 *
 * All commands are safe, local, Linux-only fixtures: echo / node -e /
 * sleep. No network, no secrets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DaemonClient } from '../packages/tools/dist/daemon/index.js';
// The package root re-export must also expose the daemon API.
import { DaemonClient as RootDaemonClient } from '../packages/tools/dist/index.js';

async function withClient(fn) {
  const client = new DaemonClient();
  try {
    return await fn(client);
  } finally {
    await client.dispose();
  }
}

test('daemon API is re-exported from @open-bot/tools root', () => {
  assert.equal(RootDaemonClient, DaemonClient);
});

test('ping answers while daemon is alive', async () => {
  await withClient(async (client) => {
    assert.deepEqual(await client.ping(), { pong: true });
  });
});

test('exec echo hello: stdout streamed, exitCode 0', async () => {
  await withClient(async (client) => {
    let stdout = '';
    const result = await client.exec(
      { command: 'echo', args: ['hello'] },
      { onStdout: (chunk) => { stdout += chunk; } },
    );
    assert.equal(stdout, 'hello\n');
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    assert.equal(result.timedOut, false);
  });
});

test('exec node writing to stderr: stderr streamed, exit code kept', async () => {
  await withClient(async (client) => {
    let stdout = '';
    let stderr = '';
    const result = await client.exec(
      {
        command: process.execPath,
        args: ['-e', "process.stdout.write('out\\n'); process.stderr.write('boom-stderr\\n'); process.exit(3);"],
      },
      {
        onStdout: (chunk) => { stdout += chunk; },
        onStderr: (chunk) => { stderr += chunk; },
      },
    );
    assert.equal(stdout, 'out\n');
    assert.equal(stderr, 'boom-stderr\n');
    assert.equal(result.exitCode, 3);
    assert.equal(result.signal, null);
    assert.equal(result.timedOut, false);
  });
});

test('exec sleep then kill: killed=true, SIGKILL, second kill is safe', async () => {
  await withClient(async (client) => {
    // Run the kill from inside exec's streaming window via a raw
    // execId: start a long sleep through exec() and kill it by listing.
    const execPromise = client.exec({ command: 'sleep', args: ['30'] });
    // Give the daemon a moment to spawn, then find the running exec.
    // Poll instead of a fixed sleep: under full-suite load the daemon
    // has taken >300ms to spawn + register (flaky at load avg ~5.7),
    // so wait up to 5s for the exec to appear in list().
    let running = [];
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      running = await client.list();
      if (running.length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(running.length, 1);
    assert.equal(running[0].command, 'sleep');
    assert.deepEqual(running[0].args, ['30']);

    const killed = await client.kill(running[0].execId);
    assert.deepEqual(killed, { killed: true });

    const result = await execPromise;
    assert.equal(result.exitCode, null);
    assert.equal(result.signal, 'SIGKILL');
    assert.equal(result.timedOut, false);
    assert.deepEqual(await client.list(), []);

    // Killing the same (now finished) execId again is safe, not an error.
    assert.deepEqual(await client.kill(running[0].execId), { killed: false });
    // Killing an execId that never existed is safe too.
    assert.deepEqual(await client.kill('no-such-exec-id'), { killed: false });
  });
});

test('exec unknown command: clear error, daemon stays alive', async () => {
  await withClient(async (client) => {
    await assert.rejects(
      () => client.exec({ command: 'open-bot-no-such-command-xyz' }),
      /cannot run "open-bot-no-such-command-xyz"/,
    );
    assert.deepEqual(await client.ping(), { pong: true });
    // Daemon still runs commands after the failure.
    const result = await client.exec({ command: 'echo', args: ['still-alive'] });
    assert.equal(result.exitCode, 0);
  });
});

test('exec bad cwd: clear error, daemon stays alive', async () => {
  await withClient(async (client) => {
    await assert.rejects(
      () => client.exec({ command: 'echo', args: ['x'], cwd: '/no-such-dir-xyz-abc' }),
      /cwd does not exist/,
    );
    assert.deepEqual(await client.ping(), { pong: true });
  });
});

test('exec timeout: process killed, timedOut=true', async () => {
  await withClient(async (client) => {
    const result = await client.exec({ command: 'sleep', args: ['30'], timeoutMs: 300 });
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
    assert.equal(result.signal, 'SIGKILL');
    assert.deepEqual(await client.list(), []);
  });
});

test('two execs in parallel: outputs stay separate, both succeed', async () => {
  await withClient(async (client) => {
    let outA = '';
    let outB = '';
    const [resA, resB] = await Promise.all([
      client.exec(
        { command: process.execPath, args: ['-e', "setTimeout(()=>process.stdout.write('AAA\\n'),150)"] },
        { onStdout: (chunk) => { outA += chunk; } },
      ),
      client.exec(
        { command: 'echo', args: ['BBB'] },
        { onStdout: (chunk) => { outB += chunk; } },
      ),
    ]);
    assert.equal(outA, 'AAA\n');
    assert.equal(outB, 'BBB\n');
    assert.equal(resA.exitCode, 0);
    assert.equal(resB.exitCode, 0);
  });
});

test('list is empty when idle; dispose stops the daemon process', async () => {
  const client = new DaemonClient();
  try {
    assert.deepEqual(await client.list(), []);
    assert.deepEqual(await client.ping(), { pong: true });
  } finally {
    await client.dispose();
    // After dispose every call fails fast instead of hanging.
    await assert.rejects(() => client.ping(), /disposed/);
    await client.dispose(); // second dispose is safe
  }
});
