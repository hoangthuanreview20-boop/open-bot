/**
 * Tests for the v0.6 shell & execution group (ROADMAP section 2b):
 * exec_task / shell sessions / sandbox_prepare (shellTools.ts),
 * computer-local tools (localTools.ts), and the daemon limits
 * (max 4 concurrent execs + FIFO queue, ~200k output cap, list API)
 * in daemon.ts (v0.14: cap 4, exec vượt cap xếp hàng thay vì reject).
 *
 * Run after building the tools package:
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/shell-v06.test.mjs
 *
 * All commands are real and local: echo / sleep / node -e / /bin/sh.
 * No network, no x.ai, no secrets.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DaemonClient } from '../packages/tools/dist/daemon/index.js';
import { ToolRegistry } from '../packages/tools/dist/registry.js';
import {
  SHELL_TOOLS,
  createShellTools,
  MAX_SESSIONS,
} from '../packages/tools/dist/shellTools.js';
import {
  LOCAL_TOOLS,
  createLocalTools,
} from '../packages/tools/dist/localTools.js';
import { createDefaultTools } from '../packages/tools/dist/tools.js';
import {
  DEFAULT_DAEMON_MAX_EXECS,
  MAX_CONCURRENT_EXECS,
  MAX_EXEC_OUTPUT_CHARS,
} from '../packages/tools/dist/daemon/index.js';

const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });
const shellTool = (tools, name) => tools.find((t) => t.definition.name === name);
const localTool = (tools, name) => tools.find((t) => t.definition.name === name);

const tempDirs = [];
function makeTempWorkspace(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-shell-v06-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 8000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(intervalMs);
  }
}

async function withClient(fn) {
  const client = new DaemonClient();
  try {
    return await fn(client);
  } finally {
    await client.dispose();
  }
}

function parseJsonToolOutput(out) {
  assert.doesNotMatch(out, /^Error:/, `expected JSON, got error: ${out}`);
  return JSON.parse(out);
}

// ---------------------------------------------------------------------------
// Registry / shape
// ---------------------------------------------------------------------------

test('registry: SHELL_TOOLS (9) + LOCAL_TOOLS (4) register with correct approval flags', () => {
  const reg = ToolRegistry.fromDefaults([...SHELL_TOOLS, ...LOCAL_TOOLS]);
  assert.equal(reg.size(), 13);
  // Run / destructive = approval; read-only = no approval.
  for (const name of [
    'exec_task',
    'exec_task_stop',
    'shell_session_start',
    'shell_session_write',
    'shell_session_close',
    'sandbox_prepare',
    'kill_process',
    'open_path',
    'shell_elevate',
  ]) {
    assert.equal(reg.get(name).needsApproval, true, name);
  }
  for (const name of [
    'exec_task_status',
    'shell_session_read',
    'system_info',
    'list_processes',
  ]) {
    assert.equal(reg.get(name).needsApproval, false, name);
  }
  for (const tool of [...SHELL_TOOLS, ...LOCAL_TOOLS]) {
    assert.equal(tool.definition.parameters.type, 'object');
    assert.ok(tool.definition.description.length > 0);
  }
});

// ---------------------------------------------------------------------------
// shell_exec sanity (item 1: it already works — verify, don't rebuild)
// ---------------------------------------------------------------------------

test('shell_exec: real echo + denylist + bad cwd (in-process path)', async () => {
  const dir = makeTempWorkspace();
  const tools = createDefaultTools();
  const shellExec = tools.find((t) => t.definition.name === 'shell_exec');
  assert.equal(shellExec.needsApproval, true);
  const ok = await shellExec.execute({ command: 'echo hello-shell' }, CTX(dir));
  assert.match(ok, /exit code: 0/);
  assert.match(ok, /hello-shell/);
  const denied = await shellExec.execute({ command: 'rm -rf /' }, CTX(dir));
  assert.match(denied, /^Error: Command blocked by sandbox denylist/);
  const badCwd = await shellExec.execute({ command: 'echo hi' }, CTX('/no-such-dir-xyz'));
  assert.match(badCwd, /^Error:/);
});

// ---------------------------------------------------------------------------
// exec_task (daemon-less, then via daemon)
// ---------------------------------------------------------------------------

test('exec_task: echo finishes, status shows partial output; sleep can be stopped', async () => {
  const dir = makeTempWorkspace();
  const tools = SHELL_TOOLS;
  const started = parseJsonToolOutput(
    await shellTool(tools, 'exec_task').execute({ command: 'echo hello-task' }, CTX(dir)),
  );
  assert.ok(started.taskId);
  assert.equal(started.status, 'running');
  const done = await waitFor(async () => {
    const out = parseJsonToolOutput(
      await shellTool(tools, 'exec_task_status').execute({ taskId: started.taskId }, CTX(dir)),
    );
    return out.status === 'done' ? out : null;
  });
  assert.equal(done.exitCode, 0);
  assert.match(done.stdout, /hello-task/);

  // Long task: still running on first poll, then stopped.
  const sleepTask = parseJsonToolOutput(
    await shellTool(tools, 'exec_task').execute({ command: 'sleep 30' }, CTX(dir)),
  );
  const running = parseJsonToolOutput(
    await shellTool(tools, 'exec_task_status').execute({ taskId: sleepTask.taskId }, CTX(dir)),
  );
  assert.equal(running.status, 'running');
  const stopped = parseJsonToolOutput(
    await shellTool(tools, 'exec_task_stop').execute({ taskId: sleepTask.taskId }, CTX(dir)),
  );
  assert.equal(stopped.stopped, true);
  const after = await waitFor(async () => {
    const out = parseJsonToolOutput(
      await shellTool(tools, 'exec_task_status').execute({ taskId: sleepTask.taskId }, CTX(dir)),
    );
    return out.status === 'stopped' ? out : null;
  });
  assert.equal(after.status, 'stopped');

  // Unknown task ids are clear errors, not crashes.
  const missing = await shellTool(tools, 'exec_task_status').execute(
    { taskId: 'no-such-task' },
    CTX(dir),
  );
  assert.match(missing, /^Error: Unknown exec task/);
  // Denylist still applies to background tasks.
  const denied = await shellTool(tools, 'exec_task').execute({ command: 'sudo ls' }, CTX(dir));
  assert.match(denied, /^Error: Command blocked by sandbox denylist/);
});

test('exec_task via daemon: echo finishes with exit 0', async () => {
  await withClient(async (client) => {
    const dir = makeTempWorkspace();
    const tools = createShellTools(() => client);
    const started = parseJsonToolOutput(
      await shellTool(tools, 'exec_task').execute({ command: 'echo hello-daemon-task' }, CTX(dir)),
    );
    const done = await waitFor(async () => {
      const out = parseJsonToolOutput(
        await shellTool(tools, 'exec_task_status').execute({ taskId: started.taskId }, CTX(dir)),
      );
      return out.status === 'done' ? out : null;
    });
    assert.equal(done.exitCode, 0);
    assert.match(done.stdout, /hello-daemon-task/);
  });
});

// ---------------------------------------------------------------------------
// shell sessions (daemon-less, then via daemon)
// ---------------------------------------------------------------------------

test('shell_session: real stdin round-trip (local spawn)', async () => {
  const dir = makeTempWorkspace();
  const tools = SHELL_TOOLS;
  const started = parseJsonToolOutput(
    await shellTool(tools, 'shell_session_start').execute({}, CTX(dir)),
  );
  const sessionId = started.sessionId;
  assert.ok(sessionId);
  await shellTool(tools, 'shell_session_write').execute(
    { sessionId, input: 'echo hi-session\n' },
    CTX(dir),
  );
  const read = await waitFor(async () => {
    const out = parseJsonToolOutput(
      await shellTool(tools, 'shell_session_read').execute({ sessionId }, CTX(dir)),
    );
    return out.output.includes('hi-session') ? out : null;
  });
  assert.match(read.output, /hi-session/);
  // Second read returns no new output (offset tracking works).
  const again = parseJsonToolOutput(
    await shellTool(tools, 'shell_session_read').execute({ sessionId }, CTX(dir)),
  );
  assert.match(again.output, /no new output/);
  // Exit the shell, then read reports exited.
  await shellTool(tools, 'shell_session_write').execute(
    { sessionId, input: 'exit\n' },
    CTX(dir),
  );
  const exited = await waitFor(async () => {
    const out = parseJsonToolOutput(
      await shellTool(tools, 'shell_session_read').execute({ sessionId }, CTX(dir)),
    );
    return out.exited ? out : null;
  });
  assert.equal(exited.exited, true);
  const closed = parseJsonToolOutput(
    await shellTool(tools, 'shell_session_close').execute({ sessionId }, CTX(dir)),
  );
  assert.equal(closed.closed, true);
  const closedAgain = parseJsonToolOutput(
    await shellTool(tools, 'shell_session_close').execute({ sessionId }, CTX(dir)),
  );
  assert.equal(closedAgain.closed, false);
});

test('shell_session via daemon: stdin round-trip through session events', async () => {
  await withClient(async (client) => {
    const dir = makeTempWorkspace();
    const tools = createShellTools(() => client);
    const started = parseJsonToolOutput(
      await shellTool(tools, 'shell_session_start').execute({}, CTX(dir)),
    );
    const sessionId = started.sessionId;
    await shellTool(tools, 'shell_session_write').execute(
      { sessionId, input: 'echo hi-daemon-session\n' },
      CTX(dir),
    );
    const read = await waitFor(async () => {
      const out = parseJsonToolOutput(
        await shellTool(tools, 'shell_session_read').execute({ sessionId }, CTX(dir)),
      );
      return out.output.includes('hi-daemon-session') ? out : null;
    });
    assert.match(read.output, /hi-daemon-session/);
    // The daemon itself lists the session.
    const listed = await client.listSessions();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].exited, false);
    assert.equal(typeof listed[0].pid, 'number');
    const closed = parseJsonToolOutput(
      await shellTool(tools, 'shell_session_close').execute({ sessionId }, CTX(dir)),
    );
    assert.equal(closed.closed, true);
    assert.deepEqual(await client.listSessions(), []);
  });
});

test('shell_session: max sessions enforced (maxSessions: 2)', async () => {
  const dir = makeTempWorkspace();
  const tools = createShellTools({ maxSessions: 2 });
  assert.equal(MAX_SESSIONS, 8, 'default cap is 8');
  const s1 = parseJsonToolOutput(
    await shellTool(tools, 'shell_session_start').execute({}, CTX(dir)),
  );
  const s2 = parseJsonToolOutput(
    await shellTool(tools, 'shell_session_start').execute({}, CTX(dir)),
  );
  const third = await shellTool(tools, 'shell_session_start').execute({}, CTX(dir));
  assert.match(third, /^Error: Too many open shell sessions \(2\)/);
  await shellTool(tools, 'shell_session_close').execute({ sessionId: s1.sessionId }, CTX(dir));
  await shellTool(tools, 'shell_session_close').execute({ sessionId: s2.sessionId }, CTX(dir));
});

// ---------------------------------------------------------------------------
// sandbox_prepare
// ---------------------------------------------------------------------------

test('sandbox_prepare: empty + template copy, env allowlist, limits metadata, refusals', async () => {
  const dir = makeTempWorkspace({
    'tpl/seed.txt': 'seed content\n',
    'tpl/sub/nested.txt': 'nested\n',
  });
  const tools = SHELL_TOOLS;

  const empty = parseJsonToolOutput(
    await shellTool(tools, 'sandbox_prepare').execute(
      { name: 'task-1', env_vars: ['MY_VAR'] },
      CTX(dir),
    ),
  );
  assert.equal(empty.path, '.open-bot/sandboxes/task-1');
  const envFile = JSON.parse(
    fs.readFileSync(path.join(dir, '.open-bot/sandboxes/task-1/env.allowlist.json'), 'utf8'),
  );
  assert.ok(envFile.allowedEnvVars.includes('MY_VAR'));
  assert.ok(envFile.allowedEnvVars.includes('PATH'));
  assert.ok(!JSON.stringify(envFile).includes('SECRET'));
  const meta = JSON.parse(
    fs.readFileSync(path.join(dir, '.open-bot/sandboxes/task-1/sandbox.json'), 'utf8'),
  );
  assert.equal(meta.template, 'empty');
  assert.equal(meta.limits.maxConcurrentExecs, 8);
  assert.equal(meta.limits.maxOutputChars, MAX_EXEC_OUTPUT_CHARS);

  const fromTpl = parseJsonToolOutput(
    await shellTool(tools, 'sandbox_prepare').execute(
      { name: 'task-2', template: 'tpl' },
      CTX(dir),
    ),
  );
  assert.equal(fromTpl.template, 'tpl');
  assert.equal(
    fs.readFileSync(path.join(dir, '.open-bot/sandboxes/task-2/seed.txt'), 'utf8'),
    'seed content\n',
  );
  assert.equal(
    fs.readFileSync(path.join(dir, '.open-bot/sandboxes/task-2/sub/nested.txt'), 'utf8'),
    'nested\n',
  );

  // Refusals: bad name, path escape via template, non-empty target, secret env name.
  assert.match(
    await shellTool(tools, 'sandbox_prepare').execute({ name: '../escape' }, CTX(dir)),
    /^Error: Invalid sandbox name/,
  );
  assert.match(
    await shellTool(tools, 'sandbox_prepare').execute(
      { name: 'task-3', template: '../outside' },
      CTX(dir),
    ),
    /^Error: Path escapes workspace/,
  );
  assert.match(
    await shellTool(tools, 'sandbox_prepare').execute({ name: 'task-1' }, CTX(dir)),
    /^Error: Sandbox "task-1" already exists and is not empty/,
  );
  assert.match(
    await shellTool(tools, 'sandbox_prepare').execute(
      { name: 'task-4', env_vars: ['MY_API_KEY'] },
      CTX(dir),
    ),
    /^Error: Env var name "MY_API_KEY" looks like a secret/,
  );
});

// ---------------------------------------------------------------------------
// Daemon limits: concurrency cap, output truncation, list API
// ---------------------------------------------------------------------------

test('daemon: max 4 concurrent execs — 5th queues FIFO and runs after a slot frees (v0.14)', async () => {
  assert.equal(DEFAULT_DAEMON_MAX_EXECS, 4);
  assert.equal(MAX_CONCURRENT_EXECS, 4);
  await withClient(async (client) => {
    const promises = [];
    for (let i = 0; i < 4; i++) {
      promises.push(client.exec({ command: 'sleep', args: ['30'] }));
    }
    await waitFor(async () => {
      const running = await client.list();
      return running.length === 4 ? running : null;
    });
    const running = await client.list();
    assert.equal(running.length, 4);
    assert.ok(running.every((e) => e.command === 'sleep'));
    assert.ok(running.every((e) => typeof e.pid === 'number'), 'list exposes pid');

    // Exec thứ 5 KHÔNG bị reject nữa (v0.14): xếp hàng, chưa chạy.
    let fifthDone = false;
    let fifthOut = '';
    const fifth = client
      .exec(
        { command: 'echo', args: ['fifth'] },
        { onStdout: (chunk) => { fifthOut += chunk; } },
      )
      .then((r) => {
        fifthDone = true;
        return r;
      });
    await sleep(500);
    assert.equal(fifthDone, false, '5th exec must still be queued while 4 slots are busy');
    assert.deepEqual(await client.ping(), { pong: true });

    // Giải phóng 1 slot -> exec xếp hàng chạy và hoàn thành.
    assert.deepEqual(await client.kill(running[0].execId), { killed: true });
    const fifthResult = await fifth;
    assert.equal(fifthResult.exitCode, 0);
    assert.match(fifthOut, /fifth/);

    for (const entry of running.slice(1)) {
      assert.deepEqual(await client.kill(entry.execId), { killed: true });
    }
    const results = await Promise.all(promises);
    assert.ok(results.every((r) => r.signal === 'SIGKILL'));
    assert.deepEqual(await client.list(), []);
    // After the slots free up, exec works again.
    const ok = await client.exec({ command: 'echo', args: ['free-again'] });
    assert.equal(ok.exitCode, 0);
  });
});

test('daemon: output over 200k chars is truncated with a marker, not buffered forever', async () => {
  await withClient(async (client) => {
    let stdout = '';
    const result = await client.exec(
      {
        command: process.execPath,
        args: ['-e', "process.stdout.write('x'.repeat(300000))"],
      },
      { onStdout: (chunk) => { stdout += chunk; } },
    );
    assert.equal(result.exitCode, 0);
    assert.ok(stdout.length <= MAX_EXEC_OUTPUT_CHARS + 200, `got ${stdout.length} chars`);
    assert.ok(stdout.length >= MAX_EXEC_OUTPUT_CHARS, `got only ${stdout.length} chars`);
    assert.match(stdout, /daemon output truncated at 200000 chars/);
  });
});

test('daemon: session_start/write/close/list via the client directly', async () => {
  await withClient(async (client) => {
    let output = '';
    const unsubscribe = client.onEvent((event, data) => {
      if (event === 'session.stdout' && data && typeof data.chunk === 'string') {
        output += data.chunk;
      }
    });
    try {
      const started = await client.startSession({});
      assert.ok(started.sessionId);
      assert.equal(typeof started.pid, 'number');
      assert.deepEqual(await client.listSessions().then((s) => s.map((x) => x.sessionId)), [
        started.sessionId,
      ]);
      await client.writeSession(started.sessionId, 'echo direct-session\n');
      await waitFor(() => (output.includes('direct-session') ? true : null));
      assert.match(output, /direct-session/);
      await assert.rejects(
        () => client.writeSession('no-such-session', 'x\n'),
        /unknown session/,
      );
      assert.deepEqual(await client.closeSession(started.sessionId), { closed: true });
      assert.deepEqual(await client.closeSession(started.sessionId), { closed: false });
      assert.deepEqual(await client.listSessions(), []);
    } finally {
      unsubscribe();
    }
  });
});

// ---------------------------------------------------------------------------
// Computer-local tools
// ---------------------------------------------------------------------------

test('system_info: real OS/CPU/RAM/disk fields, read-only', async () => {
  const dir = makeTempWorkspace();
  const out = parseJsonToolOutput(
    await localTool(LOCAL_TOOLS, 'system_info').execute({}, CTX(dir)),
  );
  assert.equal(out.platform, 'linux');
  assert.ok(out.cpuCores >= 1);
  assert.ok(out.memoryTotalBytes > 0);
  assert.ok(out.memoryFreeBytes > 0);
  assert.ok(out.disk.totalBytes === null || out.disk.totalBytes > 0);
});

test('list_processes: real process table with header and rows', async () => {
  const dir = makeTempWorkspace();
  const out = await localTool(LOCAL_TOOLS, 'list_processes').execute({}, CTX(dir));
  assert.match(out, /PID\s+PPID\s+CPU% MEM% COMMAND/);
  assert.match(out, /\bnode\b/);
  // (rà soát đa nền tảng) Hàng phải parse được cpu/mem dạng số và đã
  // sắp xếp theo CPU giảm dần — thay cho `--sort=-pcpu` của GNU ps
  // (không có trên macOS, xem localTools.ts:readProcessList).
  const rows = out
    .split('\n')
    .slice(2)
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)%\s+(\S+)%\s+(.+?)\s*$/.exec(line))
    .filter((m) => m !== null);
  assert.ok(rows.length > 0, 'phải có ít nhất 1 hàng process');
  const cpus = rows.map((m) => Number.parseFloat(m[3]));
  assert.ok(cpus.every((c) => Number.isFinite(c)), 'cpu phải là số');
  assert.ok(
    rows.every((m) => Number.isFinite(Number.parseFloat(m[4]))),
    'mem phải là số',
  );
  for (let i = 1; i < cpus.length; i++) {
    assert.ok(cpus[i - 1] >= cpus[i], `hàng chưa sắp theo CPU giảm dần: ${cpus[i - 1]} < ${cpus[i]}`);
  }
});

test('kill_process: refuses unknown pids and refuses everything without a daemon', async () => {
  const dir = makeTempWorkspace();
  // Daemon-less placeholder: ownership cannot be verified — refuse.
  const refused = await localTool(LOCAL_TOOLS, 'kill_process').execute({ pid: 1 }, CTX(dir));
  assert.match(refused, /^Error: Refusing to kill pid 1: no exec daemon connected/);

  await withClient(async (client) => {
    const tools = createLocalTools(() => client);
    // pid 1 (init) is never daemon-started.
    const refusedInit = await localTool(tools, 'kill_process').execute({ pid: 1 }, CTX(dir));
    assert.match(refusedInit, /^Error: Refusing to kill pid 1: it is not a daemon-started/);

    // A real daemon-started sleep CAN be killed by pid.
    const execPromise = client.exec({ command: 'sleep', args: ['30'] });
    const running = await waitFor(async () => {
      const list = await client.list();
      return list.length === 1 ? list : null;
    });
    const pid = running[0].pid;
    const killed = await localTool(tools, 'kill_process').execute({ pid }, CTX(dir));
    assert.match(killed, new RegExp(`Killed daemon exec .* \\(pid ${pid}`));
    const result = await execPromise;
    assert.equal(result.signal, 'SIGKILL');
    assert.deepEqual(await client.list(), []);
  });
});

test('open_path: refuses escapes and missing paths; opens a real workspace file', async () => {
  const dir = makeTempWorkspace({ 'note.txt': 'hello\n' });
  const escape = await localTool(LOCAL_TOOLS, 'open_path').execute(
    { path: '../outside.txt' },
    CTX(dir),
  );
  assert.match(escape, /^Error: Path escapes workspace/);
  const missing = await localTool(LOCAL_TOOLS, 'open_path').execute(
    { path: 'nope.txt' },
    CTX(dir),
  );
  assert.match(missing, /^Error: Path does not exist/);
  // xdg-open exists on this machine; the tool only waits for spawn, so
  // this is fast even though no window can be shown headless.
  const opened = await localTool(LOCAL_TOOLS, 'open_path').execute(
    { path: 'note.txt' },
    CTX(dir),
  );
  assert.match(opened, /Opened "note\.txt" with the system default application/);
});
