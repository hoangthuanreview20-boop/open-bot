/**
 * Tests for the v0.14 daemon cap (packages/tools/src/daemon/daemon.ts):
 * default max 4 parallel execs, FIFO queue instead of reject, queued execs
 * reported in output, streaming output chunks, env/option configuration,
 * and the startDaemon onOutputChunk hook (1MB buffer).
 *
 * Run after building the tools package:
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/daemon-cap-v014.test.mjs
 *
 * Localhost only, no network, no API key.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DaemonClient } from '../packages/tools/dist/daemon/index.js';
import {
  resolveDaemonMaxExecs,
  DEFAULT_DAEMON_MAX_EXECS,
} from '../packages/tools/dist/daemon/daemon.js';
import { matchBlockedCommandPattern } from '../packages/core/dist/agent/rules.js';

const DAEMON_JS = fileURLToPath(new URL('../packages/tools/dist/daemon/daemon.js', import.meta.url));

/** Poll `cond()` until truthy (or timeout). */
async function waitFor(cond, { timeoutMs = 10_000, intervalMs = 25 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await cond();
    if (value) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
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

/** node -e script that sleeps `ms` then prints `label`. */
const sleepPrint = (ms, label) =>
  `setTimeout(()=>process.stdout.write(${JSON.stringify(label + '\n')}),${ms})`;

// ---------------------------------------------------------------------------
// Default cap = 4, queue FIFO, all finish
// ---------------------------------------------------------------------------

test('daemon cap: mặc định tối đa 4 exec song song — 6 exec chỉ chạy 4 cùng lúc, tất cả hoàn thành', async () => {
  assert.equal(DEFAULT_DAEMON_MAX_EXECS, 4);
  assert.equal(resolveDaemonMaxExecs(), 4);
  await withClient(async (client) => {
    let maxRunning = 0;
    let stopPolling = false;
    const poller = (async () => {
      while (!stopPolling) {
        try {
          const running = await client.list();
          if (running.length > maxRunning) maxRunning = running.length;
        } catch { /* client đang dispose */ }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();

    const outputs = Array.from({ length: 6 }, () => '');
    const promises = outputs.map((_, i) =>
      client.exec(
        { command: process.execPath, args: ['-e', sleepPrint(400, `done-${i}`)] },
        { onStdout: (chunk) => { outputs[i] += chunk; } },
      ),
    );
    const results = await Promise.all(promises);
    stopPolling = true;
    await poller;

    assert.ok(results.every((r) => r.exitCode === 0), 'mọi exec đều exit 0');
    outputs.forEach((out, i) => {
      // Exec xếp hàng (i >= 4) còn nhận thêm chunk "[daemon] ... đang chờ"
      // trong stdout trước output thật — đó là thiết kế (báo rõ khi chờ).
      assert.ok(out.endsWith(`done-${i}\n`), `exec ${i} phải in đủ output thật, got: ${JSON.stringify(out)}`);
    });
    assert.match(outputs[4], /đang chờ/, 'exec xếp hàng phải được báo đang chờ trong output');
    assert.match(outputs[5], /đang chờ/, 'exec xếp hàng phải được báo đang chờ trong output');
    assert.ok(maxRunning <= 4, `không bao giờ quá 4 exec cùng lúc (thấy tối đa ${maxRunning})`);
    assert.equal(maxRunning, 4, 'phải có lúc đủ 4 exec chạy cùng lúc (cap = 4)');
  });
});

test('daemon cap: exec vượt cap xếp hàng FIFO — thứ tự bắt đầu đúng q1..q6', async () => {
  await withClient(async (client) => {
    const started = [];
    const queued = [];
    client.onEvent((event, data) => {
      if (event === 'exec.started' && data && typeof data.execId === 'string') {
        started.push(data.execId);
      }
      if (event === 'exec.queued' && data && typeof data.execId === 'string') {
        queued.push({ execId: data.execId, position: data.position });
      }
    });

    const ids = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'];
    const promises = ids.map((execId) =>
      client.exec(
        { command: process.execPath, args: ['-e', sleepPrint(500, execId)] },
        {},
        execId,
      ),
    );
    const results = await Promise.all(promises);
    assert.ok(results.every((r) => r.exitCode === 0));
    // 4 exec đầu chạy ngay, q5/q6 xếp hàng theo đúng thứ tự đến.
    assert.deepEqual(started, ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']);
    assert.deepEqual(queued, [
      { execId: 'q5', position: 1 },
      { execId: 'q6', position: 2 },
    ]);
  });
});

test('daemon cap: exec đang chờ được báo rõ trong output (chunk "đang chờ" + "hàng đợi")', async () => {
  await withClient(async (client) => {
    // Chiếm hết 4 slot trong 600ms.
    const blockers = Array.from({ length: 4 }, () =>
      client.exec({ command: 'sleep', args: ['0.6'] }),
    );
    await waitFor(async () => (await client.list()).length === 4);

    let queuedOutput = '';
    const queuedResult = await client.exec(
      { command: 'echo', args: ['hello-sau-khi-cho'] },
      { onStdout: (chunk) => { queuedOutput += chunk; } },
    );
    const blockerResults = await Promise.all(blockers);
    assert.ok(blockerResults.every((r) => r.exitCode === 0));
    assert.equal(queuedResult.exitCode, 0);
    assert.match(queuedOutput, /đang chờ/, 'output phải báo exec đang chờ');
    assert.match(queuedOutput, /hàng đợi/, 'output phải nói rõ hàng đợi');
    assert.match(queuedOutput, /hello-sau-khi-cho/, 'output thật vẫn phải có đủ');
  });
});

test('daemon cap: kill exec đang xếp hàng thì hủy nó, slot được giải phóng', async () => {
  await withClient(async (client) => {
    const blockers = Array.from({ length: 4 }, () =>
      client.exec({ command: 'sleep', args: ['0.8'] }),
    );
    await waitFor(async () => (await client.list()).length === 4);

    const queuedPromise = client.exec({ command: 'echo', args: ['khong-duoc-chay'] }, {}, 'queued-victim');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(await client.kill('queued-victim'), { killed: true });
    const queuedResult = await queuedPromise;
    assert.equal(queuedResult.exitCode, null);
    assert.equal(queuedResult.signal, 'SIGKILL');

    // Slot vẫn đủ 4 cho blockers; sau khi blockers xong, exec mới chạy ngay.
    const after = await client.exec({ command: 'echo', args: ['sau-khi-huy'] });
    assert.equal(after.exitCode, 0);
    const blockerResults = await Promise.all(blockers);
    assert.ok(blockerResults.every((r) => r.exitCode === 0));
  });
});

// ---------------------------------------------------------------------------
// Configuration: env + option
// ---------------------------------------------------------------------------

test('daemon cap: env OPENBOT_DAEMON_MAX_EXECS cấu hình được cap (env=2 → tối đa 2)', async () => {
  assert.equal(resolveDaemonMaxExecs({ maxExecs: 7 }), 7, 'option thắng env/mặc định');
  process.env.OPENBOT_DAEMON_MAX_EXECS = '2';
  try {
    assert.equal(resolveDaemonMaxExecs(), 2, 'env=2 phải cho cap 2');
    assert.equal(resolveDaemonMaxExecs({ maxExecs: 3 }), 3, 'option vẫn thắng env');
    const client = new DaemonClient();
    try {
      let maxRunning = 0;
      let stopPolling = false;
      const poller = (async () => {
        while (!stopPolling) {
          try {
            const running = await client.list();
            if (running.length > maxRunning) maxRunning = running.length;
          } catch { /* disposing */ }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      })();
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          client.exec({ command: 'sleep', args: ['0.4'] }),
        ),
      );
      stopPolling = true;
      await poller;
      assert.ok(results.every((r) => r.exitCode === 0));
      assert.ok(maxRunning <= 2, `env=2 thì tối đa 2 cùng lúc (thấy ${maxRunning})`);
      assert.equal(maxRunning, 2, 'phải có lúc đủ 2 exec chạy cùng lúc');
    } finally {
      await client.dispose();
    }
  } finally {
    delete process.env.OPENBOT_DAEMON_MAX_EXECS;
  }
  assert.equal(resolveDaemonMaxExecs(), 4, 'xóa env thì về mặc định 4');
});

// ---------------------------------------------------------------------------
// Streaming: output arrives in chunks, in order
// ---------------------------------------------------------------------------

test('daemon cap: output stream nhận đủ chunk theo thứ tự (20 dòng, nhiều chunk)', async () => {
  await withClient(async (client) => {
    const chunks = [];
    const result = await client.exec(
      {
        command: process.execPath,
        args: ['-e', "let i=0; const t=setInterval(()=>{process.stdout.write('line-'+(i++)+'\\n'); if(i>=20) clearInterval(t);},10);"],
      },
      { onStdout: (chunk) => { chunks.push(chunk); } },
    );
    assert.equal(result.exitCode, 0);
    const joined = chunks.join('');
    const expected = Array.from({ length: 20 }, (_, i) => `line-${i}\n`).join('');
    assert.equal(joined, expected, 'phải nhận đủ 20 dòng theo đúng thứ tự');
    assert.ok(chunks.length >= 2, `output phải stream thành nhiều chunk, chỉ thấy ${chunks.length} chunk`);
  });
});

// ---------------------------------------------------------------------------
// startDaemon option onOutputChunk (daemon-process side hook, 1MB buffer)
// ---------------------------------------------------------------------------

test('daemon cap: startDaemon({ onOutputChunk }) nhận từng chunk output của exec', async () => {
  // Spawn daemon trực tiếp (không qua DaemonClient) để truyền option
  // onOutputChunk vào startDaemon, rồi nói NDJSON-RPC qua stdin.
  const script =
    `const {startDaemon} = require(${JSON.stringify(DAEMON_JS)});` +
    `startDaemon({ maxExecs: 4, onOutputChunk: (execId, chunk) => {` +
    `  process.stderr.write('[onOutputChunk:' + execId + ']' + chunk);` +
    `} });`;
  const proc = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdoutBuf = '';
  let stderrBuf = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (c) => { stdoutBuf += c; });
  proc.stderr.on('data', (c) => { stderrBuf += c; });

  const send = (msg) => proc.stdin.write(JSON.stringify(msg) + '\n');
  const waitLine = (pred, timeoutMs = 5_000) =>
    waitFor(() => {
      const lines = stdoutBuf.split('\n').filter((l) => l.trim() !== '');
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (pred(parsed)) return parsed;
        } catch { /* chưa đủ 1 dòng JSON */ }
      }
      return null;
    }, { timeoutMs });

  try {
    send({ id: 'r-ping', method: 'ping', params: {} });
    const pong = await waitLine((m) => m.id === 'r-ping');
    assert.deepEqual(pong.result, { pong: true });

    send({
      id: 'r-exec', method: 'exec',
      params: { command: 'echo', args: ['chunk-test'], execId: 'e-chunk' },
    });
    const done = await waitLine((m) => m.id === 'r-exec');
    assert.equal(done.result.exitCode, 0);
    await waitFor(() => stderrBuf.includes('[onOutputChunk:e-chunk]chunk-test'), { timeoutMs: 5_000 });
    assert.match(stderrBuf, /\[onOutputChunk:e-chunk\]chunk-test/);
  } finally {
    try { send({ id: 'r-shutdown', method: 'shutdown', params: {} }); } catch { /* đã chết */ }
    await Promise.race([
      new Promise((resolve) => proc.on('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
});

// ---------------------------------------------------------------------------
// v0.15 (M1 + M2): daemon tự áp denylist + cwd confinement, env mặc định
// là safeEnv() — chỉ thêm test mới, không sửa test cũ ở trên.
// ---------------------------------------------------------------------------

import * as fs from 'node:fs';
import * as os from 'node:os';
import { resolveDaemonWorkspaceDir, resolveDaemonAllowedWorkspaceRoots } from '../packages/tools/dist/daemon/daemon.js';

function makeTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-daemon-ws-'));
}

/** Lệnh denylist nhưng vô hại khi (lỡ) chạy: `sudo -n true` chỉ kiểm tra
 *  quyền, không sửa gì trên máy (không dùng `rm -rf /` thật để test chặn
 *  — nếu daemon lỡ không chặn thì hậu quả là thật). */
const DENYLISTED_SHELL = { command: '/bin/sh', args: ['-c', 'sudo -n true'] };

/** Spawn daemon trực tiếp (không qua DaemonClient) để truyền option vào
 *  startDaemon() và nói NDJSON-RPC qua stdin. */
function spawnDaemonDirect(startOptions) {
  const script =
    `const {startDaemon} = require(${JSON.stringify(DAEMON_JS)});` +
    `startDaemon(${JSON.stringify(startOptions ?? {})});`;
  const proc = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdoutBuf = '';
  const execChunks = new Map(); // execId -> stdout đã nhận
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (c) => {
    stdoutBuf += c;
    for (const line of c.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const msg = JSON.parse(line);
        if (msg.event === 'exec.stdout' && typeof msg.data?.execId === 'string') {
          execChunks.set(msg.data.execId, (execChunks.get(msg.data.execId) ?? '') + msg.data.chunk);
        }
      } catch { /* chưa đủ 1 dòng JSON */ }
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', () => { /* diagnostics của daemon, bỏ qua */ });

  const send = (msg) => proc.stdin.write(JSON.stringify(msg) + '\n');
  const waitLine = (pred, timeoutMs = 5_000) =>
    waitFor(() => {
      const lines = stdoutBuf.split('\n').filter((l) => l.trim() !== '');
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (pred(parsed)) return parsed;
        } catch { /* chưa đủ 1 dòng JSON */ }
      }
      return null;
    }, { timeoutMs });
  const shutdown = async () => {
    try { send({ id: 'r-shutdown', method: 'shutdown', params: {} }); } catch { /* đã chết */ }
    await Promise.race([
      new Promise((resolve) => proc.on('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  };
  return { proc, send, waitLine, shutdown, execChunks };
}

test('daemon v0.15 M1: resolveDaemonWorkspaceDir — option thắng env, không có thì undefined', () => {
  assert.equal(resolveDaemonWorkspaceDir({ workspaceDir: '/tmp/ws-opt' }), '/tmp/ws-opt');
  process.env.OPENBOT_DAEMON_WORKSPACE_DIR = '/tmp/ws-env';
  try {
    assert.equal(resolveDaemonWorkspaceDir({ workspaceDir: '/tmp/ws-opt' }), '/tmp/ws-opt');
    assert.equal(resolveDaemonWorkspaceDir(), '/tmp/ws-env');
    assert.equal(resolveDaemonWorkspaceDir({}), '/tmp/ws-env');
  } finally {
    delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  }
  assert.equal(resolveDaemonWorkspaceDir(), undefined);
});

test('daemon v0.15 M1: có workspaceDir (qua env + DaemonClient) — gọi thẳng daemon.exec vẫn bị chặn denylist + cwd ngoài workspace', async () => {
  const ws = makeTempWorkspace();
  const inside = path.join(ws, 'sub');
  fs.mkdirSync(inside);
  process.env.OPENBOT_DAEMON_WORKSPACE_DIR = ws;
  const client = new DaemonClient();
  try {
    // Lệnh denylist qua shell (dạng shell_exec vẫn gửi): bị chặn.
    await assert.rejects(
      client.exec({ ...DENYLISTED_SHELL }),
      (err) => err.code === 'COMMAND_BLOCKED',
    );
    // Lệnh denylist gọi trực tiếp (không qua shell): cũng bị chặn.
    await assert.rejects(
      client.exec({ command: 'sudo', args: ['-n', 'true'] }),
      (err) => err.code === 'COMMAND_BLOCKED',
    );
    // cwd ngoài workspace: bị chặn, kể cả lệnh lành.
    await assert.rejects(
      client.exec({ command: 'echo', args: ['ngoai-ws'], cwd: '/etc' }),
      (err) => err.code === 'CWD_OUTSIDE_WORKSPACE',
    );
    // Lệnh lành + cwd trong workspace: chạy bình thường.
    let out = '';
    const ok = await client.exec(
      { command: 'echo', args: ['trong-ws'], cwd: inside },
      { onStdout: (chunk) => { out += chunk; } },
    );
    assert.equal(ok.exitCode, 0);
    assert.equal(out, 'trong-ws\n');
    // Session: cwd ngoài workspace cũng bị chặn, trong workspace thì mở được.
    await assert.rejects(
      client.startSession({ command: '/bin/sh', cwd: '/etc' }),
      (err) => err.code === 'CWD_OUTSIDE_WORKSPACE',
    );
    const session = await client.startSession({ command: '/bin/sh', cwd: inside });
    assert.equal(typeof session.sessionId, 'string');
    assert.deepEqual(await client.closeSession(session.sessionId), { closed: true });
    // Daemon vẫn sống sau các lần chặn (không throw làm chết daemon).
    assert.deepEqual(await client.ping(), { pong: true });
  } finally {
    delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
    await client.dispose();
  }
});

test('daemon v0.15 M1: có workspaceDir (option startDaemon) — exec không truyền cwd thì mặc định là workspace', async () => {
  const ws = makeTempWorkspace();
  const { send, waitLine, shutdown, execChunks } = spawnDaemonDirect({ workspaceDir: ws });
  try {
    send({ id: 'r-ping', method: 'ping', params: {} });
    assert.deepEqual((await waitLine((m) => m.id === 'r-ping')).result, { pong: true });

    // Lệnh denylist bị chặn.
    send({ id: 'r-blocked', method: 'exec', params: { ...DENYLISTED_SHELL, execId: 'e-blocked' } });
    const blocked = await waitLine((m) => m.id === 'r-blocked');
    assert.equal(blocked.error?.code, 'COMMAND_BLOCKED');

    // Không truyền cwd → chạy trong workspace: `pwd` in ra đúng workspace.
    send({ id: 'r-pwd', method: 'exec', params: { command: 'pwd', execId: 'e-pwd' } });
    const pwd = await waitLine((m) => m.id === 'r-pwd');
    assert.equal(pwd.result.exitCode, 0);
    assert.equal((execChunks.get('e-pwd') ?? '').trim(), ws);
  } finally {
    await shutdown();
  }
});

test('daemon v0.15 M1: method init đặt workspaceDir sau khi chạy; đổi sang thư mục khác bị từ chối, daemon vẫn sống', async () => {
  const ws = makeTempWorkspace();
  const other = makeTempWorkspace();
  const { send, waitLine, shutdown } = spawnDaemonDirect({});
  try {
    send({ id: 'r-ping', method: 'ping', params: {} });
    assert.deepEqual((await waitLine((m) => m.id === 'r-ping')).result, { pong: true });

    // Chưa init: lệnh denylist KHÔNG bị chặn (hành vi cũ).
    send({ id: 'r-before', method: 'exec', params: { ...DENYLISTED_SHELL, execId: 'e-before' } });
    const before = await waitLine((m) => m.id === 'r-before');
    assert.equal(before.error?.code, undefined, 'chưa init thì không được chặn denylist');

    // init đặt workspaceDir.
    send({ id: 'r-init', method: 'init', params: { workspaceDir: ws } });
    const init = await waitLine((m) => m.id === 'r-init');
    assert.deepEqual(init.result, { ok: true, workspaceDir: ws, allowedWorkspaceRoots: null, egressConfigured: false });

    // Sau init: lệnh denylist bị chặn.
    send({ id: 'r-after', method: 'exec', params: { ...DENYLISTED_SHELL, execId: 'e-after' } });
    const after = await waitLine((m) => m.id === 'r-after');
    assert.equal(after.error?.code, 'COMMAND_BLOCKED');

    // init lại cùng giá trị thì ok (idempotent); đổi sang thư mục khác thì bị từ chối.
    send({ id: 'r-init2', method: 'init', params: { workspaceDir: ws } });
    assert.deepEqual((await waitLine((m) => m.id === 'r-init2')).result, { ok: true, workspaceDir: ws, allowedWorkspaceRoots: null, egressConfigured: false });
    send({ id: 'r-init3', method: 'init', params: { workspaceDir: other } });
    const init3 = await waitLine((m) => m.id === 'r-init3');
    assert.equal(init3.error?.code, 'WORKSPACE_ALREADY_SET');

    // Daemon vẫn sống sau các lần chặn/từ chối.
    send({ id: 'r-ping2', method: 'ping', params: {} });
    assert.deepEqual((await waitLine((m) => m.id === 'r-ping2')).result, { pong: true });
  } finally {
    await shutdown();
  }
});

test('daemon v0.15 M1: không workspaceDir giữ hành vi cũ — lệnh denylist + cwd ngoài workspace đều chạy được', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  await withClient(async (client) => {
    // Lệnh denylist không bị daemon chặn nữa: hoặc chạy rồi exit != 0
    // (sudo -n true thiếu quyền), hoặc lệnh không tồn tại — nhưng KHÔNG
    // được trả về COMMAND_BLOCKED.
    try {
      const result = await client.exec({ ...DENYLISTED_SHELL });
      assert.notEqual(result.exitCode, undefined);
    } catch (err) {
      assert.notEqual(err.code, 'COMMAND_BLOCKED', 'không workspaceDir thì daemon không được chặn denylist');
    }
    // cwd ngoài workspace (mặc định là cwd của daemon, /etc vẫn chạy được).
    let out = '';
    const ok = await client.exec(
      { command: 'echo', args: ['ngoai-ws'], cwd: '/etc' },
      { onStdout: (chunk) => { out += chunk; } },
    );
    assert.equal(ok.exitCode, 0);
    assert.equal(out, 'ngoai-ws\n');
    assert.deepEqual(await client.ping(), { pong: true });
  });
});

test('daemon v0.15 M2: exec không truyền env → tiến trình con không thấy secret env của daemon; có truyền env thì dùng đúng env đó', async () => {
  process.env.OPENBOT_DAEMON_TEST_SECRET = 'bi-mat-daemon-xyz';
  try {
    await withClient(async (client) => {
      const printEnv = (name) =>
        `process.stdout.write(process.env[${JSON.stringify(name)}] ?? 'KHONG-THAY')`;
      // Không truyền env: secret của daemon không lọt xuống con...
      let out = '';
      const noEnv = await client.exec(
        { command: process.execPath, args: ['-e', printEnv('OPENBOT_DAEMON_TEST_SECRET')] },
        { onStdout: (chunk) => { out += chunk; } },
      );
      assert.equal(noEnv.exitCode, 0);
      assert.equal(out, 'KHONG-THAY', 'con không được thấy secret env của daemon');
      // ...nhưng biến allowlist (PATH) thì vẫn thấy.
      out = '';
      const pathCheck = await client.exec(
        { command: process.execPath, args: ['-e', "process.stdout.write(process.env.PATH ? 'CO-PATH' : 'KHONG-PATH')"] },
        { onStdout: (chunk) => { out += chunk; } },
      );
      assert.equal(pathCheck.exitCode, 0);
      assert.equal(out, 'CO-PATH');
      // Có truyền env: con thấy đúng env caller truyền, không thấy secret của daemon.
      out = '';
      const withEnv = await client.exec(
        {
          command: process.execPath,
          args: ['-e', printEnv('MY_VAR') + ';' + printEnv('OPENBOT_DAEMON_TEST_SECRET')],
          env: { MY_VAR: 'xin-chao', PATH: process.env.PATH ?? '' },
        },
        { onStdout: (chunk) => { out += chunk; } },
      );
      assert.equal(withEnv.exitCode, 0);
      assert.equal(out, 'xin-chaoKHONG-THAY');
    });
  } finally {
    delete process.env.OPENBOT_DAEMON_TEST_SECRET;
  }
});

// ---------------------------------------------------------------------------
// v0.16 (M1 đa bot): giam theo từng request — exec/session_start mang
// theo workspaceDir của bot gọi; daemon KHÔNG cấu hình workspaceDir chung.
// Thứ tự ưu tiên: request workspaceDir > daemon workspaceDir > không giam.
// ---------------------------------------------------------------------------

test('daemon v0.16 M1 đa bot: exec với workspaceDir A — lệnh trong A chạy, cwd ngoài A bị chặn, denylist bị chặn dù daemon không cấu hình workspaceDir chung', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  const wsA = makeTempWorkspace();
  const insideA = path.join(wsA, 'sub');
  fs.mkdirSync(insideA);
  const outside = makeTempWorkspace(); // thư mục khác, ngoài A
  await withClient(async (client) => {
    // Lệnh lành + cwd trong A: chạy.
    let out = '';
    const ok = await client.exec(
      { command: 'echo', args: ['trong-A'], cwd: insideA, workspaceDir: wsA },
      { onStdout: (chunk) => { out += chunk; } },
    );
    assert.equal(ok.exitCode, 0);
    assert.equal(out, 'trong-A\n');
    // Không truyền cwd → mặc định là chính workspaceDir A: `pwd` in ra A.
    out = '';
    const pwd = await client.exec(
      { command: 'pwd', workspaceDir: wsA },
      { onStdout: (chunk) => { out += chunk; } },
    );
    assert.equal(pwd.exitCode, 0);
    assert.equal(out.trim(), wsA);
    // cwd ngoài A (dù là thư mục tồn tại, lành): bị chặn.
    await assert.rejects(
      client.exec({ command: 'echo', args: ['ngoai-A'], cwd: outside, workspaceDir: wsA }),
      (err) => err.code === 'CWD_OUTSIDE_WORKSPACE',
    );
    // cwd là /etc: bị chặn.
    await assert.rejects(
      client.exec({ command: 'echo', args: ['etc'], cwd: '/etc', workspaceDir: wsA }),
      (err) => err.code === 'CWD_OUTSIDE_WORKSPACE',
    );
    // Lệnh denylist (qua shell, dạng shell_exec gửi): bị chặn.
    await assert.rejects(
      client.exec({ ...DENYLISTED_SHELL, workspaceDir: wsA }),
      (err) => err.code === 'COMMAND_BLOCKED',
    );
    // Lệnh denylist gọi trực tiếp: cũng bị chặn.
    await assert.rejects(
      client.exec({ command: 'sudo', args: ['-n', 'true'], workspaceDir: wsA }),
      (err) => err.code === 'COMMAND_BLOCKED',
    );
    // Daemon vẫn sống sau các lần chặn.
    assert.deepEqual(await client.ping(), { pong: true });
  });
});

test('daemon v0.16 M1 đa bot: hai bot hai workspace — exec của bot A không chạy được trong workspace B và ngược lại', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  const wsA = makeTempWorkspace();
  const wsB = makeTempWorkspace();
  await withClient(async (client) => {
    // A chạy trong A: ok. A chạy trong B: chặn.
    let out = '';
    const okA = await client.exec(
      { command: 'pwd', cwd: wsA, workspaceDir: wsA },
      { onStdout: (chunk) => { out += chunk; } },
    );
    assert.equal(okA.exitCode, 0);
    assert.equal(out.trim(), wsA);
    await assert.rejects(
      client.exec({ command: 'pwd', cwd: wsB, workspaceDir: wsA }),
      (err) => err.code === 'CWD_OUTSIDE_WORKSPACE',
    );
    // B chạy trong B: ok. B chạy trong A: chặn.
    out = '';
    const okB = await client.exec(
      { command: 'pwd', cwd: wsB, workspaceDir: wsB },
      { onStdout: (chunk) => { out += chunk; } },
    );
    assert.equal(okB.exitCode, 0);
    assert.equal(out.trim(), wsB);
    await assert.rejects(
      client.exec({ command: 'pwd', cwd: wsA, workspaceDir: wsB }),
      (err) => err.code === 'CWD_OUTSIDE_WORKSPACE',
    );
  });
});

test('daemon v0.16 M1 đa bot: session_start với workspaceDir — cwd ngoài bị chặn, trong workspace thì mở được', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  const ws = makeTempWorkspace();
  const inside = path.join(ws, 'sub');
  fs.mkdirSync(inside);
  await withClient(async (client) => {
    await assert.rejects(
      client.startSession({ command: '/bin/sh', cwd: '/etc', workspaceDir: ws }),
      (err) => err.code === 'CWD_OUTSIDE_WORKSPACE',
    );
    const session = await client.startSession({ command: '/bin/sh', cwd: inside, workspaceDir: ws });
    assert.equal(typeof session.sessionId, 'string');
    assert.deepEqual(await client.closeSession(session.sessionId), { closed: true });
    // Session không truyền cwd → mặc định là workspaceDir của request.
    const session2 = await client.startSession({ command: '/bin/sh', workspaceDir: ws });
    assert.equal(typeof session2.sessionId, 'string');
    assert.deepEqual(await client.closeSession(session2.sessionId), { closed: true });
    assert.deepEqual(await client.ping(), { pong: true });
  });
});

test('daemon v0.16 M1 đa bot: request workspaceDir thắng daemon workspaceDir; exec không có workspaceDir vẫn giữ hành vi cũ', async () => {
  const wsDaemon = makeTempWorkspace();
  const wsReq = makeTempWorkspace();
  process.env.OPENBOT_DAEMON_WORKSPACE_DIR = wsDaemon;
  const client = new DaemonClient();
  try {
    // Request có workspaceDir riêng (ngoài daemon workspaceDir): giam
    // theo request — chạy trong wsReq thì ok...
    let out = '';
    const ok = await client.exec(
      { command: 'pwd', cwd: wsReq, workspaceDir: wsReq },
      { onStdout: (chunk) => { out += chunk; } },
    );
    assert.equal(ok.exitCode, 0);
    assert.equal(out.trim(), wsReq);
    // ...nhưng cwd trong daemon workspaceDir (ngoài request workspaceDir)
    // thì bị chặn — chứng tỏ request workspaceDir thắng, không phải hợp
    // nhất hai workspace.
    await assert.rejects(
      client.exec({ command: 'pwd', cwd: wsDaemon, workspaceDir: wsReq }),
      (err) => err.code === 'CWD_OUTSIDE_WORKSPACE',
    );
    // Request KHÔNG có workspaceDir → giam theo daemon workspaceDir như cũ.
    await assert.rejects(
      client.exec({ command: 'echo', args: ['ngoai'], cwd: '/etc' }),
      (err) => err.code === 'CWD_OUTSIDE_WORKSPACE',
    );
    out = '';
    const okDaemon = await client.exec(
      { command: 'pwd', cwd: wsDaemon },
      { onStdout: (chunk) => { out += chunk; } },
    );
    assert.equal(okDaemon.exitCode, 0);
    assert.equal(out.trim(), wsDaemon);
    assert.deepEqual(await client.ping(), { pong: true });
  } finally {
    delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
    await client.dispose();
  }
});

test('daemon v0.16 M1 đa bot: không workspaceDir ở request lẫn daemon thì giữ hành vi cũ (không chặn)', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  await withClient(async (client) => {
    // Lệnh denylist không bị chặn (hành vi cũ): hoặc chạy rồi exit != 0,
    // hoặc không tìm thấy lệnh — nhưng KHÔNG được COMMAND_BLOCKED.
    try {
      await client.exec({ ...DENYLISTED_SHELL });
    } catch (err) {
      assert.notEqual(err.code, 'COMMAND_BLOCKED');
    }
    // cwd /etc vẫn chạy được.
    let out = '';
    const ok = await client.exec(
      { command: 'echo', args: ['ngoai-ws'], cwd: '/etc' },
      { onStdout: (chunk) => { out += chunk; } },
    );
    assert.equal(ok.exitCode, 0);
    assert.equal(out, 'ngoai-ws\n');
    // workspaceDir sai kiểu thì BAD_REQUEST (không làm chết daemon).
    await assert.rejects(
      client.exec({ command: 'echo', args: ['x'], workspaceDir: 123 }),
      (err) => err.code === 'BAD_REQUEST',
    );
    await assert.rejects(
      client.startSession({ command: '/bin/sh', workspaceDir: 123 }),
      (err) => err.code === 'BAD_REQUEST',
    );
    assert.deepEqual(await client.ping(), { pong: true });
  });
});

// ---------------------------------------------------------------------------
// Allowlist thư mục gốc (sau v0.18): daemon chỉ chấp nhận workspaceDir
// nằm trong (hoặc bằng) một root trong allowedWorkspaceRoots — chặn
// caller độc hại tự khai workspaceDir rộng (`/`) để thoát giam v0.16.
// Khi không cấu hình allowlist thì giữ hành vi cũ (không chặn thêm).
// ---------------------------------------------------------------------------

test('daemon allowlist: resolveDaemonAllowedWorkspaceRoots — option thắng env, env tách bằng path.delimiter, không có thì undefined', () => {
  assert.equal(resolveDaemonAllowedWorkspaceRoots(), undefined);
  process.env.OPENBOT_DAEMON_ALLOWED_ROOTS = ['/tmp/root-a', '/tmp/root-b'].join(path.delimiter);
  try {
    assert.deepEqual(resolveDaemonAllowedWorkspaceRoots(), ['/tmp/root-a', '/tmp/root-b']);
    assert.deepEqual(
      resolveDaemonAllowedWorkspaceRoots({ allowedWorkspaceRoots: ['/tmp/root-opt'] }),
      ['/tmp/root-opt'],
    );
    assert.deepEqual(resolveDaemonAllowedWorkspaceRoots({ allowedWorkspaceRoots: [] }), ['/tmp/root-a', '/tmp/root-b']);
  } finally {
    delete process.env.OPENBOT_DAEMON_ALLOWED_ROOTS;
  }
  assert.equal(resolveDaemonAllowedWorkspaceRoots(), undefined);
  assert.equal(resolveDaemonAllowedWorkspaceRoots({ allowedWorkspaceRoots: [] }), undefined);
});

test('daemon allowlist: có root — workspaceDir trong root chạy được, `/` và ngoài root bị từ chối WORKSPACE_NOT_ALLOWED, symlink trỏ ra ngoài cũng bị chặn', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  delete process.env.OPENBOT_DAEMON_ALLOWED_ROOTS;
  const root = makeTempWorkspace();
  const inside = path.join(root, 'bot-a');
  fs.mkdirSync(inside);
  const outside = makeTempWorkspace();
  const linkOutside = path.join(root, 'link-etc');
  fs.symlinkSync('/etc', linkOutside);
  const { send, waitLine, shutdown, execChunks } = spawnDaemonDirect({ allowedWorkspaceRoots: [root] });
  try {
    send({ id: 'r-ping', method: 'ping', params: {} });
    assert.deepEqual((await waitLine((m) => m.id === 'r-ping')).result, { pong: true });

    // Trong root: chạy, `pwd` in ra đúng workspace.
    send({ id: 'r-in', method: 'exec', params: { command: 'pwd', workspaceDir: inside, execId: 'e-in' } });
    const ok = await waitLine((m) => m.id === 'r-in');
    assert.equal(ok.result.exitCode, 0);
    assert.equal((execChunks.get('e-in') ?? '').trim(), inside);

    // `/`: bị từ chối.
    send({ id: 'r-slash', method: 'exec', params: { command: 'pwd', workspaceDir: '/', execId: 'e-slash' } });
    const slash = await waitLine((m) => m.id === 'r-slash');
    assert.equal(slash.error?.code, 'WORKSPACE_NOT_ALLOWED');

    // Ngoài root (thư mục tồn tại, lành): bị từ chối.
    send({ id: 'r-out', method: 'exec', params: { command: 'pwd', workspaceDir: outside, execId: 'e-out' } });
    const out = await waitLine((m) => m.id === 'r-out');
    assert.equal(out.error?.code, 'WORKSPACE_NOT_ALLOWED');

    // Symlink trong root nhưng trỏ ra /etc: bị chặn qua realpath.
    send({ id: 'r-link', method: 'exec', params: { command: 'pwd', workspaceDir: linkOutside, execId: 'e-link' } });
    const link = await waitLine((m) => m.id === 'r-link');
    assert.equal(link.error?.code, 'WORKSPACE_NOT_ALLOWED');

    // Session với workspaceDir ngoài root cũng bị chặn.
    send({ id: 'r-sess', method: 'session_start', params: { command: '/bin/sh', workspaceDir: outside } });
    const sess = await waitLine((m) => m.id === 'r-sess');
    assert.equal(sess.error?.code, 'WORKSPACE_NOT_ALLOWED');

    // Daemon vẫn sống sau các lần từ chối.
    send({ id: 'r-ping2', method: 'ping', params: {} });
    assert.deepEqual((await waitLine((m) => m.id === 'r-ping2')).result, { pong: true });
  } finally {
    await shutdown();
  }
});

test('daemon allowlist: init đặt allowedWorkspaceRoots (+ workspaceDir) sau khi chạy; đổi root khác bị từ chối, workspaceDir ngoài root bị từ chối', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  delete process.env.OPENBOT_DAEMON_ALLOWED_ROOTS;
  const root = makeTempWorkspace();
  const inside = path.join(root, 'bot-a');
  fs.mkdirSync(inside);
  const otherRoot = makeTempWorkspace();
  const { send, waitLine, shutdown, execChunks } = spawnDaemonDirect({});
  try {
    send({ id: 'r-ping', method: 'ping', params: {} });
    assert.deepEqual((await waitLine((m) => m.id === 'r-ping')).result, { pong: true });

    // init đặt cả root lẫn workspaceDir trong root.
    send({ id: 'r-init', method: 'init', params: { workspaceDir: inside, allowedWorkspaceRoots: [root] } });
    const init = await waitLine((m) => m.id === 'r-init');
    assert.deepEqual(init.result, { ok: true, workspaceDir: inside, allowedWorkspaceRoots: [root], egressConfigured: false });

    // Exec trong root (workspaceDir daemon) chạy được.
    send({ id: 'r-in', method: 'exec', params: { command: 'pwd', execId: 'e-in' } });
    const ok = await waitLine((m) => m.id === 'r-in');
    assert.equal(ok.result.exitCode, 0);
    assert.equal((execChunks.get('e-in') ?? '').trim(), inside);

    // Request workspaceDir ngoài root: bị từ chối.
    send({ id: 'r-out', method: 'exec', params: { command: 'pwd', workspaceDir: otherRoot, execId: 'e-out' } });
    const out = await waitLine((m) => m.id === 'r-out');
    assert.equal(out.error?.code, 'WORKSPACE_NOT_ALLOWED');

    // init lại cùng tập root thì ok (idempotent).
    send({ id: 'r-init2', method: 'init', params: { allowedWorkspaceRoots: [root] } });
    assert.deepEqual((await waitLine((m) => m.id === 'r-init2')).result, { ok: true, workspaceDir: inside, allowedWorkspaceRoots: [root], egressConfigured: false });

    // init đổi sang root khác thì bị từ chối.
    send({ id: 'r-init3', method: 'init', params: { allowedWorkspaceRoots: [otherRoot] } });
    const init3 = await waitLine((m) => m.id === 'r-init3');
    assert.equal(init3.error?.code, 'WORKSPACE_ROOTS_ALREADY_SET');

    // Daemon vẫn sống.
    send({ id: 'r-ping2', method: 'ping', params: {} });
    assert.deepEqual((await waitLine((m) => m.id === 'r-ping2')).result, { pong: true });
  } finally {
    await shutdown();
  }
});

test('daemon allowlist: init đặt workspaceDir ngoài allowlist đã có thì bị từ chối WORKSPACE_NOT_ALLOWED, không áp dụng', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  delete process.env.OPENBOT_DAEMON_ALLOWED_ROOTS;
  const root = makeTempWorkspace();
  const outside = makeTempWorkspace();
  const { send, waitLine, shutdown } = spawnDaemonDirect({ allowedWorkspaceRoots: [root] });
  try {
    send({ id: 'r-init', method: 'init', params: { workspaceDir: outside } });
    const init = await waitLine((m) => m.id === 'r-init');
    assert.equal(init.error?.code, 'WORKSPACE_NOT_ALLOWED');
    // Không áp dụng: init lại với workspaceDir trong root vẫn được.
    const inside = path.join(root, 'bot-a');
    fs.mkdirSync(inside);
    send({ id: 'r-init2', method: 'init', params: { workspaceDir: inside } });
    const init2 = await waitLine((m) => m.id === 'r-init2');
    assert.deepEqual(init2.result, { ok: true, workspaceDir: inside, allowedWorkspaceRoots: [root], egressConfigured: false });
    send({ id: 'r-ping', method: 'ping', params: {} });
    assert.deepEqual((await waitLine((m) => m.id === 'r-ping')).result, { pong: true });
  } finally {
    await shutdown();
  }
});

test('daemon allowlist: không cấu hình allowlist thì request workspaceDir /tmp/... bất kỳ vẫn chạy như cũ (không chặn thêm)', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  delete process.env.OPENBOT_DAEMON_ALLOWED_ROOTS;
  const wsA = makeTempWorkspace();
  const wsB = makeTempWorkspace();
  await withClient(async (client) => {
    // Hai workspace /tmp khác nhau đều chạy được, kể cả `/` làm cwd
    // mặc định của workspaceDir `/` (không có allowlist thì không chặn).
    let out = '';
    const a = await client.exec(
      { command: 'pwd', workspaceDir: wsA },
      { onStdout: (chunk) => { out += chunk; } },
    );
    assert.equal(a.exitCode, 0);
    assert.equal(out.trim(), wsA);
    out = '';
    const b = await client.exec(
      { command: 'pwd', workspaceDir: wsB },
      { onStdout: (chunk) => { out += chunk; } },
    );
    assert.equal(b.exitCode, 0);
    assert.equal(out.trim(), wsB);
    out = '';
    const slash = await client.exec(
      { command: 'pwd', workspaceDir: '/' },
      { onStdout: (chunk) => { out += chunk; } },
    );
    assert.equal(slash.exitCode, 0);
    assert.equal(out.trim(), '/');
    assert.deepEqual(await client.ping(), { pong: true });
  });
});

// ---------------------------------------------------------------------------
// DaemonClient.init() (v0.19): cấu hình allowlist qua client, không cần RPC thô
// ---------------------------------------------------------------------------

test('daemon allowlist: DaemonClient.init() đặt roots + workspaceDir — trong root chạy được, `/` bị từ chối, daemon vẫn sống', async () => {
  const root = makeTempWorkspace();
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws);
  await withClient(async (client) => {
    const res = await client.init({ allowedWorkspaceRoots: [root], workspaceDir: ws });
    assert.deepEqual(res, { ok: true, workspaceDir: ws, allowedWorkspaceRoots: [root], egressConfigured: false });
    let out = '';
    const ok = await client.exec(
      { command: 'pwd', workspaceDir: ws },
      { onStdout: (chunk) => { out += chunk; } },
    );
    assert.equal(ok.exitCode, 0);
    assert.equal(out.trim(), ws);
    await assert.rejects(
      client.exec({ command: 'pwd', workspaceDir: '/' }),
      (err) => err.code === 'WORKSPACE_NOT_ALLOWED',
    );
    assert.deepEqual(await client.ping(), { pong: true });
  });
});

// ---------------------------------------------------------------------------
// v0.20 (W13c): session_write kiểm tra denylist từng dòng stdin —
// session đang chạy không còn là đường chui qua denylist của
// exec/session_start. Chỉ thêm test mới, không sửa test cũ ở trên.
// ---------------------------------------------------------------------------

test('daemon v0.20 session_write: dòng cấm trong session đang chạy bị chặn COMMAND_BLOCKED, session vẫn sống, dòng lành sau đó vẫn chạy', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  const ws = makeTempWorkspace();
  await withClient(async (client) => {
    let sessionOut = '';
    let sessionErr = '';
    // Đăng ký trước khi mở session để không lỡ chunk nào.
    client.onEvent((event, data) => {
      if (event === 'session.stdout' && typeof data?.chunk === 'string') sessionOut += data.chunk;
      if (event === 'session.stderr' && typeof data?.chunk === 'string') sessionErr += data.chunk;
    });
    const session = await client.startSession({ command: '/bin/sh', cwd: ws, workspaceDir: ws });
    assert.equal(typeof session.sessionId, 'string');

    // Dòng cấm (vô hại khi lỡ chạy: `sudo -n true` chỉ kiểm tra quyền,
    // không sửa gì — không dùng `rm -rf /` thật vào shell sống, xem
    // test `cat` bên dưới cho chuỗi đó): bị chặn, không ghi vào stdin.
    await assert.rejects(
      client.writeSession(session.sessionId, 'sudo -n true\n'),
      (err) => err.code === 'COMMAND_BLOCKED',
    );
    // Session không bị kill khi bị chặn: vẫn trong danh sách, chưa exit.
    const listed = await client.listSessions();
    const stillThere = listed.find((s) => s.sessionId === session.sessionId);
    assert.ok(stillThere, 'session phải còn trong danh sách sau khi bị chặn');
    assert.equal(stillThere.exited, false, 'session không được exit khi bị chặn');
    assert.deepEqual(await client.ping(), { pong: true });

    // Dòng lành sau đó vẫn chạy bình thường trong cùng session.
    assert.deepEqual(await client.writeSession(session.sessionId, 'echo ok\n'), { ok: true });
    await waitFor(() => sessionOut.includes('ok\n'));
    assert.match(sessionOut, /ok\n/);
    // Không có output lạ từ lệnh cấm (sudo không được chạy nên không
    // có dòng "a password is required" hay gì khác trên stderr).
    assert.equal(sessionErr, '');

    assert.deepEqual(await client.closeSession(session.sessionId), { closed: true });
    assert.deepEqual(await client.ping(), { pong: true });
  });
});

test('daemon v0.20 session_write: dòng cấm không bao giờ tới stdin (session `cat` echo lại mọi dòng), dòng lành cùng lần ghi vẫn được ghi', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  const ws = makeTempWorkspace();
  await withClient(async (client) => {
    // Session chạy `cat` thay vì shell: mọi dòng tới stdin đều được echo
    // ra stdout — nên test được chuỗi nguy hiểm thật (`sudo rm -rf /`)
    // mà vẫn an toàn tuyệt đối: nếu daemon lỡ không chặn, `cat` chỉ echo
    // lại chuỗi đó chứ không chạy gì.
    let sessionOut = '';
    client.onEvent((event, data) => {
      if (event === 'session.stdout' && typeof data?.chunk === 'string') sessionOut += data.chunk;
    });
    const session = await client.startSession({ command: 'cat', cwd: ws, workspaceDir: ws });

    // Dòng text thường (dữ liệu, không khớp mẫu cấm) đi qua bình thường.
    assert.deepEqual(await client.writeSession(session.sessionId, 'just some text\n'), { ok: true });
    await waitFor(() => sessionOut.includes('just some text\n'));

    // Dòng cấm thật: bị chặn + KHÔNG xuất hiện trong output của `cat`
    // (chứng tỏ chưa bao giờ tới stdin). Đồng bộ bằng một dòng lành
    // ghi sau đó để chắc `cat` đã xử lý xong các dòng trước.
    await assert.rejects(
      client.writeSession(session.sessionId, 'sudo rm -rf /\n'),
      (err) => err.code === 'COMMAND_BLOCKED',
    );
    assert.deepEqual(await client.writeSession(session.sessionId, 'echo marker-1\n'), { ok: true });
    await waitFor(() => sessionOut.includes('echo marker-1\n'));
    assert.ok(!sessionOut.includes('sudo rm -rf /'), 'dòng cấm không được tới stdin của cat');

    // Một lần ghi trộn dòng lành + dòng cấm: trả lỗi COMMAND_BLOCKED
    // nhưng các dòng lành trong cùng lần ghi vẫn được ghi (cả trước và
    // sau dòng cấm), chỉ dòng cấm bị bỏ.
    await assert.rejects(
      client.writeSession(session.sessionId, 'echo hello\nsudo rm -rf /\necho after\n'),
      (err) => err.code === 'COMMAND_BLOCKED',
    );
    await waitFor(() => sessionOut.includes('echo after\n'));
    assert.ok(sessionOut.includes('echo hello\n'), 'dòng lành trước dòng cấm vẫn được ghi');
    assert.ok(sessionOut.includes('echo after\n'), 'dòng lành sau dòng cấm vẫn được ghi');
    assert.ok(!sessionOut.includes('sudo rm -rf /'), 'dòng cấm trong lần ghi trộn cũng không tới stdin');

    // Session vẫn sống sau các lần chặn.
    const listed = await client.listSessions();
    const stillThere = listed.find((s) => s.sessionId === session.sessionId);
    assert.ok(stillThere && stillThere.exited === false, 'session cat vẫn sống sau khi bị chặn');
    assert.deepEqual(await client.ping(), { pong: true });
    assert.deepEqual(await client.closeSession(session.sessionId), { closed: true });
  });
});

test('daemon v0.20 session_write: session không có workspaceDir giữ hành vi cũ — dòng cấm không bị chặn', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  await withClient(async (client) => {
    const session = await client.startSession({ command: '/bin/sh' });
    // Lệnh cấm vô hại (`sudo -n true` chỉ kiểm tra quyền): không có
    // workspaceDir thì daemon giữ hành vi cũ, write phải resolve ok.
    assert.deepEqual(await client.writeSession(session.sessionId, 'sudo -n true\n'), { ok: true });
    assert.deepEqual(await client.ping(), { pong: true });
    assert.deepEqual(await client.closeSession(session.sessionId), { closed: true });
  });
});

// ---------------------------------------------------------------------------
// v0.20 (W14c): đệm dòng dở qua các lần session_write — đóng lỗ tách
// nhỏ lệnh cấm qua nhiều lần ghi (gap W13c để lại: mỗi lần ghi chỉ
// kiểm tra các dòng của lần ghi đó). Chỉ giữ fragment cuối chưa có
// `\n`; dòng đầy đủ mới được kiểm tra + ghi. Chỉ thêm test mới, không
// sửa test cũ ở trên.
// ---------------------------------------------------------------------------

test('daemon v0.20 session_write (W14c): lệnh cấm tách nhỏ qua 2 lần ghi bị chặn — `su` + `do rm -rf /\\n` gộp thành `sudo rm -rf /`', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  const ws = makeTempWorkspace();
  await withClient(async (client) => {
    let sessionOut = '';
    let sessionErr = '';
    client.onEvent((event, data) => {
      if (event === 'session.stdout' && typeof data?.chunk === 'string') sessionOut += data.chunk;
      if (event === 'session.stderr' && typeof data?.chunk === 'string') sessionErr += data.chunk;
    });
    const session = await client.startSession({ command: '/bin/sh', cwd: ws, workspaceDir: ws });

    // Lần 1: `su` chưa có newline — chỉ được đệm, chưa chạy, chưa bị
    // chặn (chưa phải dòng hoàn chỉnh).
    assert.deepEqual(await client.writeSession(session.sessionId, 'su'), { ok: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(sessionOut, '', 'fragment chưa có newline thì shell chưa chạy gì');
    assert.equal(sessionErr, '');

    // Lần 2: hoàn thiện dòng thành `sudo rm -rf /` → bị chặn.
    await assert.rejects(
      client.writeSession(session.sessionId, 'do rm -rf /\n'),
      (err) => err.code === 'COMMAND_BLOCKED',
    );
    // Dòng gộp không chạy: sudo không in gì ra stderr (không prompt
    // password, không lỗi sudo). Đồng bộ bằng một dòng lành ghi sau.
    assert.deepEqual(await client.writeSession(session.sessionId, 'echo after-split\n'), { ok: true });
    await waitFor(() => sessionOut.includes('after-split\n'));
    assert.ok(!sessionErr.includes('sudo'), `sudo không được chạy, stderr: ${JSON.stringify(sessionErr)}`);
    assert.ok(!sessionErr.includes('password'), `sudo không được prompt password, stderr: ${JSON.stringify(sessionErr)}`);

    // Session vẫn sống sau khi bị chặn.
    const listed = await client.listSessions();
    const stillThere = listed.find((s) => s.sessionId === session.sessionId);
    assert.ok(stillThere && stillThere.exited === false, 'session vẫn sống sau khi chặn dòng gộp');
    assert.deepEqual(await client.closeSession(session.sessionId), { closed: true });
    assert.deepEqual(await client.ping(), { pong: true });
  });
});

test('daemon v0.20 session_write (W14c): dòng lành tách nhỏ qua 2 lần ghi vẫn chạy — `echo he` + `llo\\n` ra `hello`', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  const ws = makeTempWorkspace();
  await withClient(async (client) => {
    let sessionOut = '';
    client.onEvent((event, data) => {
      if (event === 'session.stdout' && typeof data?.chunk === 'string') sessionOut += data.chunk;
    });
    const session = await client.startSession({ command: '/bin/sh', cwd: ws, workspaceDir: ws });

    // Lần 1: fragment lành chưa có newline — đệm, chưa chạy.
    assert.deepEqual(await client.writeSession(session.sessionId, 'echo he'), { ok: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(sessionOut, '', 'dòng chưa hoàn chỉnh không được chạy trước khi có newline');
    // Lần 2: hoàn thiện dòng → chạy ra `hello`.
    assert.deepEqual(await client.writeSession(session.sessionId, 'llo\n'), { ok: true });
    await waitFor(() => sessionOut.includes('hello\n'));
    assert.match(sessionOut, /hello\n/);

    assert.deepEqual(await client.closeSession(session.sessionId), { closed: true });
    assert.deepEqual(await client.ping(), { pong: true });
  });
});

test('daemon v0.20 session_write (W14c): session đóng khi còn fragment lành → fragment được flush và chạy (shell echo)', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  const ws = makeTempWorkspace();
  await withClient(async (client) => {
    let sessionOut = '';
    client.onEvent((event, data) => {
      if (event === 'session.stdout' && typeof data?.chunk === 'string') sessionOut += data.chunk;
    });
    const session = await client.startSession({ command: '/bin/sh', cwd: ws, workspaceDir: ws });

    // Fragment lành chưa có newline: đệm, chưa chạy.
    assert.deepEqual(await client.writeSession(session.sessionId, 'echo flushed-ok'), { ok: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(sessionOut, '', 'fragment chưa flush thì chưa có output');
    // Đóng session → flush fragment (kèm newline) rồi shell chạy nốt.
    assert.deepEqual(await client.closeSession(session.sessionId), { closed: true });
    await waitFor(() => sessionOut.includes('flushed-ok\n'));
    assert.match(sessionOut, /flushed-ok\n/);
    assert.deepEqual(await client.ping(), { pong: true });
  });
});

test('daemon v0.20 session_write (W14c): fragment cấm còn lại khi đóng session bị bỏ, không flush', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  const ws = makeTempWorkspace();
  await withClient(async (client) => {
    let sessionOut = '';
    let sessionErr = '';
    client.onEvent((event, data) => {
      if (event === 'session.stdout' && typeof data?.chunk === 'string') sessionOut += data.chunk;
      if (event === 'session.stderr' && typeof data?.chunk === 'string') sessionErr += data.chunk;
    });
    const session = await client.startSession({ command: '/bin/sh', cwd: ws, workspaceDir: ws });

    // Fragment cấm chưa có newline: chỉ đệm, chưa bị chặn ngay (chưa
    // phải dòng hoàn chỉnh) — nhưng khi đóng cũng không được flush.
    assert.deepEqual(await client.writeSession(session.sessionId, 'sudo rm -rf /'), { ok: true });
    assert.deepEqual(await client.closeSession(session.sessionId), { closed: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(sessionOut, '', 'fragment cấm không được flush thành output');
    assert.ok(!sessionErr.includes('sudo'), `sudo không được chạy khi flush, stderr: ${JSON.stringify(sessionErr)}`);
    assert.deepEqual(await client.ping(), { pong: true });
  });
});

test('daemon v0.21 session_write: fragment vượt 64k không được giữ — ghi thẳng vào stdin ngay (cat echo), fragment cấm vượt cap bị chặn', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  const ws = makeTempWorkspace();
  await withClient(async (client) => {
    let sessionOut = '';
    client.onEvent((event, data) => {
      if (event === 'session.stdout' && typeof data?.chunk === 'string') sessionOut += data.chunk;
    });
    const session = await client.startSession({ command: 'cat', cwd: ws, workspaceDir: ws });

    // Fragment lành 65.000 ký tự, không newline: vượt cap → ghi thẳng
    // vào stdin ngay (cat echo lại) thay vì nằm trong pendingPartialLine.
    const big = 'x'.repeat(65_000);
    assert.deepEqual(await client.writeSession(session.sessionId, big), { ok: true });
    await waitFor(() => sessionOut.length >= 65_000);
    assert.equal(sessionOut.length, 65_000);
    // Hoàn thiện dòng → cat echo thêm newline.
    assert.deepEqual(await client.writeSession(session.sessionId, '\n'), { ok: true });
    await waitFor(() => sessionOut.endsWith('\n'));

    // Fragment cấm vượt cap: kiểm tra như một dòng → chặn ngay, không ghi.
    sessionOut = '';
    await assert.rejects(
      client.writeSession(session.sessionId, `sudo ${'y'.repeat(65_000)}`),
      (err) => err.code === 'COMMAND_BLOCKED',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(sessionOut, '', 'fragment cấm vượt cap không được ghi vào stdin');

    assert.deepEqual(await client.closeSession(session.sessionId), { closed: true });
    assert.deepEqual(await client.ping(), { pong: true });
  });
});

// ---------------------------------------------------------------------------
// (W18b): session_write — đóng lỗ ghép lệnh cấm bằng biến shell / heredoc
// nhiều dòng. Chỉ thêm test mới, không sửa test cũ ở trên.
//
// Quyết định được test ở đây (xem `decideSessionLine` trong daemon.ts):
//  - Gán biến đơn giản (`NAME="giá trị"`, giá trị không `$`/backtick)
//    được track và KHÔNG bị chặn vì giá trị chứa từ cấm — giá trị còn
//    trơ cho tới khi expand thành dòng lệnh, và chính dòng lệnh đó
//    (vd `$CMD`) mới bị chặn. `MSG="hello sudo world"` phải qua.
//  - Gán có giá trị chứa `$`/backtick thì KHÔNG track, kiểm tra raw
//    như cũ (fail-closed — `$(...)`/backtick thực thi ngay lúc gán).
//  - Nội dung heredoc qua kiểm tra denylist sau expand, từng dòng;
//    dòng vi phạm bị bỏ, dòng lành vẫn qua, session sống.
// ---------------------------------------------------------------------------

test('daemon session_write (W18b): `$CMD` / `${CMD}` sau khi gán `CMD="rm -rf /"` bị chặn, gán lành qua, session sống', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  const ws = makeTempWorkspace();
  await withClient(async (client) => {
    let sessionOut = '';
    client.onEvent((event, data) => {
      if (event === 'session.stdout' && typeof data?.chunk === 'string') sessionOut += data.chunk;
    });
    // Session `cat`: mọi dòng tới stdin đều echo ra — an toàn tuyệt đối
    // với chuỗi `rm -rf /` thật, và chứng minh được dòng nào tới stdin.
    const session = await client.startSession({ command: 'cat', cwd: ws, workspaceDir: ws });

    // Gán biến chứa lệnh cấm: KHÔNG bị chặn (giá trị còn trơ), được ghi
    // vào stdin (cat echo lại nguyên dòng gán) và được track.
    assert.deepEqual(await client.writeSession(session.sessionId, 'CMD="rm -rf /"\n'), { ok: true });
    await waitFor(() => sessionOut.includes('CMD="rm -rf /"\n'));
    assert.ok(sessionOut.includes('CMD="rm -rf /"\n'), 'dòng gán phải tới stdin của cat');

    // `$CMD` expand thành `rm -rf /` → chặn, không tới stdin (cat
    // không echo lại `$CMD`); session vẫn sống.
    await assert.rejects(
      client.writeSession(session.sessionId, '$CMD\n'),
      (err) => err.code === 'COMMAND_BLOCKED',
    );
    // `${CMD}` cũng vậy.
    await assert.rejects(
      client.writeSession(session.sessionId, '${CMD}\n'),
      (err) => err.code === 'COMMAND_BLOCKED',
    );
    // Đồng bộ bằng dòng lành ghi sau, rồi khẳng định `$CMD`/`${CMD}`
    // không bao giờ xuất hiện trong output của cat.
    assert.deepEqual(await client.writeSession(session.sessionId, 'echo marker-var-1\n'), { ok: true });
    await waitFor(() => sessionOut.includes('echo marker-var-1\n'));
    assert.ok(!sessionOut.includes('$CMD'), 'dòng `$CMD` không được tới stdin của cat');
    assert.ok(!sessionOut.includes('${CMD}'), 'dòng `${CMD}` không được tới stdin của cat');

    const listed = await client.listSessions();
    const stillThere = listed.find((s) => s.sessionId === session.sessionId);
    assert.ok(stillThere && stillThere.exited === false, 'session cat vẫn sống sau khi chặn `$CMD`');
    assert.deepEqual(await client.ping(), { pong: true });
    assert.deepEqual(await client.closeSession(session.sessionId), { closed: true });
  });
});

test('daemon session_write (W18b): `$CMD` trong shell thật bị chặn (sudo không chạy), dòng lành sau đó vẫn chạy', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  const ws = makeTempWorkspace();
  await withClient(async (client) => {
    let sessionOut = '';
    let sessionErr = '';
    client.onEvent((event, data) => {
      if (event === 'session.stdout' && typeof data?.chunk === 'string') sessionOut += data.chunk;
      if (event === 'session.stderr' && typeof data?.chunk === 'string') sessionErr += data.chunk;
    });
    const session = await client.startSession({ command: '/bin/sh', cwd: ws, workspaceDir: ws });

    // `sudo -n true` vô hại nếu lỡ chạy (chỉ kiểm tra quyền) — nhưng
    // phải bị chặn khi expand từ biến, không được chạy thật.
    assert.deepEqual(await client.writeSession(session.sessionId, 'CMD="sudo -n true"\n'), { ok: true });
    await assert.rejects(
      client.writeSession(session.sessionId, '$CMD\n'),
      (err) => err.code === 'COMMAND_BLOCKED',
    );
    assert.deepEqual(await client.writeSession(session.sessionId, 'echo after-var\n'), { ok: true });
    await waitFor(() => sessionOut.includes('after-var\n'));
    assert.ok(!sessionErr.includes('sudo'), `sudo không được chạy, stderr: ${JSON.stringify(sessionErr)}`);
    assert.ok(!sessionErr.includes('password'), `sudo không được prompt password, stderr: ${JSON.stringify(sessionErr)}`);

    assert.deepEqual(await client.closeSession(session.sessionId), { closed: true });
    assert.deepEqual(await client.ping(), { pong: true });
  });
});

test('daemon session_write (W18b): gán lại biến dùng giá trị mới — cấm → lành thì chạy, lành → cấm thì chặn', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  const ws = makeTempWorkspace();
  await withClient(async (client) => {
    let sessionOut = '';
    let sessionErr = '';
    client.onEvent((event, data) => {
      if (event === 'session.stdout' && typeof data?.chunk === 'string') sessionOut += data.chunk;
      if (event === 'session.stderr' && typeof data?.chunk === 'string') sessionErr += data.chunk;
    });
    const session = await client.startSession({ command: '/bin/sh', cwd: ws, workspaceDir: ws });

    // Gán cấm rồi dùng → chặn.
    assert.deepEqual(await client.writeSession(session.sessionId, 'CMD="sudo -n true"\n'), { ok: true });
    await assert.rejects(
      client.writeSession(session.sessionId, '$CMD\n'),
      (err) => err.code === 'COMMAND_BLOCKED',
    );
    // Ghi đè bằng giá trị lành rồi dùng → chạy ra `reassigned-ok`
    // (chứng tỏ daemon dùng giá trị MỚI, không kẹt giá trị cũ).
    assert.deepEqual(await client.writeSession(session.sessionId, 'CMD="echo reassigned-ok"\n'), { ok: true });
    assert.deepEqual(await client.writeSession(session.sessionId, '$CMD\n'), { ok: true });
    await waitFor(() => sessionOut.includes('reassigned-ok\n'));
    // Ghi đè lại bằng giá trị cấm rồi dùng → chặn lại.
    assert.deepEqual(await client.writeSession(session.sessionId, 'CMD="sudo -n true"\n'), { ok: true });
    await assert.rejects(
      client.writeSession(session.sessionId, '$CMD\n'),
      (err) => err.code === 'COMMAND_BLOCKED',
    );
    assert.deepEqual(await client.writeSession(session.sessionId, 'echo after-reassign\n'), { ok: true });
    await waitFor(() => sessionOut.includes('after-reassign\n'));
    assert.ok(!sessionErr.includes('sudo'), `sudo không được chạy, stderr: ${JSON.stringify(sessionErr)}`);

    assert.deepEqual(await client.closeSession(session.sessionId), { closed: true });
    assert.deepEqual(await client.ping(), { pong: true });
  });
});

test('daemon session_write (W18b): gán chuỗi lành chứa từ cấm KHÔNG bị chặn — `MSG="hello sudo world"`, `NOTE` chứa `rm -rf /`', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  const ws = makeTempWorkspace();
  await withClient(async (client) => {
    let sessionOut = '';
    client.onEvent((event, data) => {
      if (event === 'session.stdout' && typeof data?.chunk === 'string') sessionOut += data.chunk;
    });
    const session = await client.startSession({ command: 'cat', cwd: ws, workspaceDir: ws });

    // Gán lành chứa từ cấm nhưng không thực thi: phải qua và được cat
    // echo lại nguyên dòng (không như dòng lệnh `sudo ...` bị chặn).
    assert.deepEqual(await client.writeSession(session.sessionId, 'MSG="hello sudo world"\n'), { ok: true });
    await waitFor(() => sessionOut.includes('MSG="hello sudo world"\n'));
    assert.deepEqual(await client.writeSession(session.sessionId, "MSG2='hello sudo world'\n"), { ok: true });
    await waitFor(() => sessionOut.includes("MSG2='hello sudo world'\n"));
    // Cả chuỗi `rm -rf /` trong giá trị gán cũng vậy — còn trơ cho tới
    // khi expand thành lệnh (test `$CMD` ở trên chứng minh lệnh đó bị chặn).
    assert.deepEqual(await client.writeSession(session.sessionId, 'NOTE="please do not rm -rf / here"\n'), { ok: true });
    await waitFor(() => sessionOut.includes('NOTE="please do not rm -rf / here"\n'));
    // Tiền tố `export` cũng là gán đơn giản, phải qua.
    assert.deepEqual(await client.writeSession(session.sessionId, 'export TAG="hello sudo world"\n'), { ok: true });
    await waitFor(() => sessionOut.includes('export TAG="hello sudo world"\n'));

    assert.deepEqual(await client.closeSession(session.sessionId), { closed: true });
    assert.deepEqual(await client.ping(), { pong: true });
  });
});

test('daemon session_write (W18b): nội dung heredoc vi phạm bị chặn từng dòng, dòng lành vẫn qua, gán trong heredoc không được track', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  const ws = makeTempWorkspace();
  await withClient(async (client) => {
    let sessionOut = '';
    client.onEvent((event, data) => {
      if (event === 'session.stdout' && typeof data?.chunk === 'string') sessionOut += data.chunk;
    });
    const session = await client.startSession({ command: 'cat', cwd: ws, workspaceDir: ws });

    assert.deepEqual(await client.writeSession(session.sessionId, 'CMD="rm -rf /"\n'), { ok: true });
    await waitFor(() => sessionOut.includes('CMD="rm -rf /"\n'));

    // Mở heredoc, nội dung lành qua, nội dung cấm bị chặn từng dòng.
    assert.deepEqual(await client.writeSession(session.sessionId, 'cat <<EOF\n'), { ok: true });
    assert.deepEqual(await client.writeSession(session.sessionId, 'hello heredoc\n'), { ok: true });
    await waitFor(() => sessionOut.includes('hello heredoc\n'));
    await assert.rejects(
      client.writeSession(session.sessionId, 'sudo rm -rf /\n'),
      (err) => err.code === 'COMMAND_BLOCKED',
    );
    // Nội dung heredoc chứa `$CMD` cũng bị chặn (expand trước khi kiểm tra).
    await assert.rejects(
      client.writeSession(session.sessionId, '$CMD\n'),
      (err) => err.code === 'COMMAND_BLOCKED',
    );
    // Gán biến TRONG thân heredoc chỉ là dữ liệu: qua (echo lại) nhưng
    // KHÔNG được track — lưu ý: không dùng được giá trị chứa từ cấm
    // (vd `INNER="sudo -n true"`) để chứng minh việc này, vì nội dung
    // heredoc chứa `sudo` đã bị chặn ngay ở bước kiểm tra nội dung
    // (cùng tiêu chí denylist với mọi dòng dữ liệu từ v0.20); dùng
    // giá trị lành, và `$INNER` sau heredoc vẫn qua như dòng thường.
    assert.deepEqual(await client.writeSession(session.sessionId, 'INNER="echo inner-value"\n'), { ok: true });
    await waitFor(() => sessionOut.includes('INNER="echo inner-value"\n'));
    // Đóng heredoc bằng delimiter, rồi kiểm tra các dòng sau trở lại
    // là dòng thường: `$INNER` (không track) qua, gán mới được track.
    assert.deepEqual(await client.writeSession(session.sessionId, 'EOF\n'), { ok: true });
    assert.deepEqual(await client.writeSession(session.sessionId, '$INNER\n'), { ok: true });
    await waitFor(() => sessionOut.includes('$INNER\n'));
    assert.deepEqual(await client.writeSession(session.sessionId, 'CMD2="sudo -n true"\n'), { ok: true });
    await assert.rejects(
      client.writeSession(session.sessionId, '$CMD2\n'),
      (err) => err.code === 'COMMAND_BLOCKED',
    );
    // Đồng bộ rồi khẳng định nội dung cấm không tới stdin của cat.
    assert.deepEqual(await client.writeSession(session.sessionId, 'echo marker-heredoc\n'), { ok: true });
    await waitFor(() => sessionOut.includes('echo marker-heredoc\n'));
    assert.ok(!sessionOut.includes('sudo rm -rf /'), 'nội dung heredoc cấm không được tới stdin của cat');
    assert.ok(!sessionOut.includes('$CMD\n'), 'nội dung heredoc `$CMD` không được tới stdin của cat');

    // Delimiter có quote (`<<'EOF'`) và dạng `<<-EOF` cũng được track.
    assert.deepEqual(await client.writeSession(session.sessionId, "cat <<'EOF'\n"), { ok: true });
    await assert.rejects(
      client.writeSession(session.sessionId, 'sudo rm -rf /\n'),
      (err) => err.code === 'COMMAND_BLOCKED',
    );
    assert.deepEqual(await client.writeSession(session.sessionId, 'EOF\n'), { ok: true });
    assert.deepEqual(await client.writeSession(session.sessionId, 'cat <<-EOF\n'), { ok: true });
    assert.deepEqual(await client.writeSession(session.sessionId, 'hello dash-heredoc\n'), { ok: true });
    await waitFor(() => sessionOut.includes('hello dash-heredoc\n'));
    // `<<-` cho phép delimiter thụt đầu dòng (tab).
    assert.deepEqual(await client.writeSession(session.sessionId, '\tEOF\n'), { ok: true });
    assert.deepEqual(await client.writeSession(session.sessionId, 'echo marker-heredoc-2\n'), { ok: true });
    await waitFor(() => sessionOut.includes('echo marker-heredoc-2\n'));

    const listed = await client.listSessions();
    const stillThere = listed.find((s) => s.sessionId === session.sessionId);
    assert.ok(stillThere && stillThere.exited === false, 'session cat vẫn sống sau khi chặn nội dung heredoc');
    assert.deepEqual(await client.closeSession(session.sessionId), { closed: true });
    assert.deepEqual(await client.ping(), { pong: true });
  });
});

test('daemon session_write (W18b): heredoc trong shell thật — nội dung lành được `cat` in, nội dung cấm bị bỏ', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  const ws = makeTempWorkspace();
  await withClient(async (client) => {
    let sessionOut = '';
    client.onEvent((event, data) => {
      if (event === 'session.stdout' && typeof data?.chunk === 'string') sessionOut += data.chunk;
    });
    const session = await client.startSession({ command: '/bin/sh', cwd: ws, workspaceDir: ws });

    assert.deepEqual(await client.writeSession(session.sessionId, 'cat <<EOF\n'), { ok: true });
    assert.deepEqual(await client.writeSession(session.sessionId, 'hello-heredoc-shell\n'), { ok: true });
    await assert.rejects(
      client.writeSession(session.sessionId, 'sudo rm -rf /\n'),
      (err) => err.code === 'COMMAND_BLOCKED',
    );
    assert.deepEqual(await client.writeSession(session.sessionId, 'EOF\n'), { ok: true });
    assert.deepEqual(await client.writeSession(session.sessionId, 'echo heredoc-done\n'), { ok: true });
    await waitFor(() => sessionOut.includes('heredoc-done\n'));
    assert.ok(sessionOut.includes('hello-heredoc-shell\n'), 'nội dung heredoc lành phải được cat in ra');
    assert.ok(!sessionOut.includes('sudo rm -rf /'), 'nội dung heredoc cấm không được tới shell/cat');

    assert.deepEqual(await client.closeSession(session.sessionId), { closed: true });
    assert.deepEqual(await client.ping(), { pong: true });
  });
});

test('daemon session_write (W18b): biến không track được (giá trị chứa `$`/backtick) — `$VAR` giữ nguyên, dòng gốc vẫn qua denylist', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  const ws = makeTempWorkspace();
  await withClient(async (client) => {
    let sessionOut = '';
    client.onEvent((event, data) => {
      if (event === 'session.stdout' && typeof data?.chunk === 'string') sessionOut += data.chunk;
    });
    const session = await client.startSession({ command: 'cat', cwd: ws, workspaceDir: ws });

    // Giá trị chứa `$` → không track, nhưng dòng gán lành (raw không
    // khớp denylist) vẫn qua; `$GREET` sau đó cũng qua vì daemon giữ
    // nguyên `$GREET` khi kiểm tra (không expand ra gì), và cat echo
    // lại đúng `$GREET`.
    assert.deepEqual(await client.writeSession(session.sessionId, 'GREET="hello $USER"\n'), { ok: true });
    await waitFor(() => sessionOut.includes('GREET="hello $USER"\n'));
    assert.deepEqual(await client.writeSession(session.sessionId, '$GREET\n'), { ok: true });
    await waitFor(() => sessionOut.includes('$GREET\n'));

    // Giá trị chứa `$` NHƯNG raw đã khớp denylist → gán bị chặn ngay
    // (fail-closed, không chờ tới lúc dùng biến).
    await assert.rejects(
      client.writeSession(session.sessionId, 'DYN="sudo $HOME"\n'),
      (err) => err.code === 'COMMAND_BLOCKED',
    );
    // Giá trị chứa backtick (thực thi ngay lúc gán) cũng vậy.
    await assert.rejects(
      client.writeSession(session.sessionId, 'RUN=`sudo id`\n'),
      (err) => err.code === 'COMMAND_BLOCKED',
    );
    // Đồng bộ rồi khẳng định hai dòng gán đó không tới stdin của cat.
    assert.deepEqual(await client.writeSession(session.sessionId, 'echo marker-untracked\n'), { ok: true });
    await waitFor(() => sessionOut.includes('echo marker-untracked\n'));
    assert.ok(!sessionOut.includes('DYN='), 'gán `DYN="sudo $HOME"` không được tới stdin của cat');
    assert.ok(!sessionOut.includes('RUN='), 'gán backtick không được tới stdin của cat');

    assert.deepEqual(await client.closeSession(session.sessionId), { closed: true });
    assert.deepEqual(await client.ping(), { pong: true });
  });
});

test('daemon session_write (W18b): gán biến tách nhỏ qua 2 lần ghi vẫn được track — `$CMD` sau đó bị chặn', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  const ws = makeTempWorkspace();
  await withClient(async (client) => {
    let sessionOut = '';
    client.onEvent((event, data) => {
      if (event === 'session.stdout' && typeof data?.chunk === 'string') sessionOut += data.chunk;
    });
    const session = await client.startSession({ command: 'cat', cwd: ws, workspaceDir: ws });

    // Gán tách làm hai lần ghi (đệm fragment W14c gộp lại thành một
    // dòng đầy đủ rồi mới parse gán) → track được, `$CMD` bị chặn.
    assert.deepEqual(await client.writeSession(session.sessionId, 'CMD="rm -'), { ok: true });
    assert.deepEqual(await client.writeSession(session.sessionId, 'rf /"\n'), { ok: true });
    await waitFor(() => sessionOut.includes('CMD="rm -rf /"\n'));
    await assert.rejects(
      client.writeSession(session.sessionId, '$CMD\n'),
      (err) => err.code === 'COMMAND_BLOCKED',
    );
    assert.deepEqual(await client.writeSession(session.sessionId, 'echo marker-split-var\n'), { ok: true });
    await waitFor(() => sessionOut.includes('echo marker-split-var\n'));
    assert.ok(!sessionOut.includes('$CMD'), 'dòng `$CMD` không được tới stdin của cat');

    assert.deepEqual(await client.closeSession(session.sessionId), { closed: true });
    assert.deepEqual(await client.ping(), { pong: true });
  });
});

// ---------------------------------------------------------------------------
// Điều phối viên (v0.25): lỗ denylist `rm` trong quote/paren + wrapper
// eval / sh -c — W18b chỉ suy luận "vẫn bị chặn nhờ expand", chưa test.
// Probe đã chứng minh `sh -c "rm -rf /"`, `$(rm -rf /)`, `rm -rf "/"`
// đều lọt trước khi sửa pattern trong `packages/core/src/agent/rules.ts`.
// ---------------------------------------------------------------------------

test('denylist rm (điều phối viên): `rm -rf /` trong quote/paren/substitution đều bị chặn, đường dẫn con vẫn qua', () => {
  // Phải chặn: root/home dù viết trần, trong quote, qua sh -c, $(), backtick.
  for (const cmd of [
    'rm -rf /',
    'rm -rf "/"',
    "rm -rf '/'",
    'rm -rf ~',
    'rm -rf ~/ ',
    'rm -rf $HOME/',
    'sh -c "rm -rf /"',
    '$(rm -rf /)',
    '`rm -rf /`',
    'rm -rf /; echo xong',
  ]) {
    assert.ok(matchBlockedCommandPattern(cmd), `phải chặn: ${cmd}`);
  }
  // Phải qua: đường dẫn con (không phải root/home), lệnh lành.
  for (const cmd of [
    'rm -rf /tmp/foo',
    'rm -rf "/tmp/foo"',
    'rm -rf /home',
    'rm -rf ~/x',
    'rm -rf $HOME/x',
    'echo hello',
  ]) {
    assert.equal(matchBlockedCommandPattern(cmd), undefined, `phải qua: ${cmd}`);
  }
});

test('denylist Windows (rà soát đa nền tảng): lệnh phá hoại kiểu Windows bị chặn như rm -rf /, thư mục con vẫn qua', () => {
  // Phải chặn: tương đương Windows của `rm -rf /` — trước đợt rà soát
  // này các lệnh dưới đây đều lọt denylist trên máy Windows.
  for (const cmd of [
    'rm -rf C:\\',
    'rm -rf C:/',
    'rm -rf "C:\\"',
    'Remove-Item -Recurse -Force C:\\',
    'Remove-Item -Recurse -Force C:/',
    'Remove-Item C:\\ -Recurse -Force',
    'Remove-Item -Recurse $env:USERPROFILE',
    'Remove-Item -Recurse -Force $env:SystemDrive\\',
    'Remove-Item -Recurse C:\\Windows',
    'Remove-Item -Recurse -Force %USERPROFILE%',
    'powershell -Command "Remove-Item -Recurse -Force C:\\"',
    'rd /s /q C:\\',
    'rmdir /s /q C:\\',
    'rd C:\\ /s /q',
    'del /s /q C:\\',
    'del /f /s /q C:\\*.*',
    'erase /s C:\\',
    'format C:',
    'format C: /fs:ntfs /q',
    'format D: /y',
  ]) {
    assert.ok(matchBlockedCommandPattern(cmd), `phải chặn: ${cmd}`);
  }
  // Phải qua: thư mục con (kể cả trên ổ C/D), lệnh lành — giống quy
  // tắc `rm -rf /tmp/foo` vẫn qua.
  for (const cmd of [
    'Remove-Item -Recurse -Force C:\\Users\\test\\project\\node_modules',
    'Remove-Item C:\\Users\\test\\file.txt',
    'Remove-Item -Recurse C:\\Users\\test\\workspace\\build',
    'Remove-Item -Recurse -Force C:\\Windows\\Temp\\old',
    'Remove-Item -Recurse $env:USERPROFILE\\Downloads\\old',
    'rd /s /q C:\\Users\\test\\build',
    'del /s /q C:\\Users\\test\\*.tmp',
    'format C:\\Users\\test\\file.txt',
    'Remove-Item -Recurse -Force D:\\data\\old',
    'rd /s /q D:\\temp\\x',
    'echo hello',
  ]) {
    assert.equal(matchBlockedCommandPattern(cmd), undefined, `phải qua: ${cmd}`);
  }
});

test('daemon session_write (điều phối viên): `eval $CMD` và `sh -c "$CMD"` đều bị chặn sau khi expand, session sống', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  const ws = makeTempWorkspace();
  await withClient(async (client) => {
    let sessionOut = '';
    client.onEvent((event, data) => {
      if (event === 'session.stdout' && typeof data?.chunk === 'string') sessionOut += data.chunk;
    });
    // Session `cat` + `sudo -n true` vô hại nếu lỡ chạy (chỉ kiểm tra
    // quyền, không sửa gì) — như mẫu test W18b.
    const session = await client.startSession({ command: 'cat', cwd: ws, workspaceDir: ws });

    assert.deepEqual(await client.writeSession(session.sessionId, 'CMD="sudo -n true"\n'), { ok: true });
    await waitFor(() => sessionOut.includes('CMD="sudo -n true"\n'));

    // `eval $CMD` expand thành `eval sudo -n true` → `\bsudo\b` khớp → chặn.
    await assert.rejects(
      client.writeSession(session.sessionId, 'eval $CMD\n'),
      (err) => err.code === 'COMMAND_BLOCKED',
    );
    // `sh -c "$CMD"` expand thành `sh -c "sudo -n true"` → cũng chặn.
    await assert.rejects(
      client.writeSession(session.sessionId, 'sh -c "$CMD"\n'),
      (err) => err.code === 'COMMAND_BLOCKED',
    );
    // Dòng lành sau đó vẫn chạy; 2 dòng cấm không tới stdin của cat.
    assert.deepEqual(await client.writeSession(session.sessionId, 'echo marker-eval-shc\n'), { ok: true });
    await waitFor(() => sessionOut.includes('echo marker-eval-shc\n'));
    assert.ok(!sessionOut.includes('eval $CMD'), 'dòng `eval $CMD` không được tới stdin của cat');
    assert.ok(!sessionOut.includes('sh -c "$CMD"'), 'dòng `sh -c "$CMD"` không được tới stdin của cat');

    assert.deepEqual(await client.closeSession(session.sessionId), { closed: true });
    assert.deepEqual(await client.ping(), { pong: true });
  });
});

// ---------------------------------------------------------------------------
// v0.26 (W19d): shutdownDaemon flush dòng dở của session trước khi kill —
// giống handleSessionClose: fragment lành được ghi kèm `\n` để shell
// chạy nốt dòng cuối, fragment vi phạm bị bỏ + log stderr, đóng stdin
// (EOF) rồi chờ tối đa SESSION_CLOSE_KILL_DELAY_MS (500ms) cho shell tự
// thoát. Shell đã thoát trước khi shutdown thì không flush được (như cũ).
// Chỉ thêm test mới, không sửa test cũ ở trên.
// ---------------------------------------------------------------------------

test('daemon v0.26 shutdown (W19d): session còn fragment lành → shutdown flush và chạy nốt dòng cuối', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  const ws = makeTempWorkspace();
  const client = new DaemonClient();
  try {
    let sessionOut = '';
    client.onEvent((event, data) => {
      if (event === 'session.stdout' && typeof data?.chunk === 'string') sessionOut += data.chunk;
    });
    const session = await client.startSession({ command: '/bin/sh', cwd: ws, workspaceDir: ws });

    // Fragment lành chưa có newline: đệm, chưa chạy.
    assert.deepEqual(await client.writeSession(session.sessionId, 'echo marker-flush-ok'), { ok: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(sessionOut, '', 'fragment chưa flush thì chưa có output');

    // dispose() gửi shutdown: daemon flush fragment rồi mới thoát.
    const started = Date.now();
    await client.dispose();
    const elapsedMs = Date.now() - started;
    assert.ok(elapsedMs < 5000, `shutdown phải hoàn thành nhanh, mất ${elapsedMs}ms`);
    // Output của dòng đã flush có thể tới sau khi daemon thoát (pipe) —
    // đợi thêm cho marker xuất hiện rồi mới khẳng định.
    await waitFor(() => sessionOut.includes('marker-flush-ok\n'));
    assert.match(sessionOut, /marker-flush-ok\n/, 'dòng cuối phải chạy khi shutdown flush');
  } finally {
    // dispose() đã gọi trong try; gọi lại an toàn (idempotent).
    await client.dispose();
  }
});

test('daemon v0.26 shutdown (W19d): fragment vi phạm còn lại khi shutdown bị bỏ, không chạy (shell thật)', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  const ws = makeTempWorkspace();
  const client = new DaemonClient();
  try {
    let sessionOut = '';
    let sessionErr = '';
    client.onEvent((event, data) => {
      if (event === 'session.stdout' && typeof data?.chunk === 'string') sessionOut += data.chunk;
      if (event === 'session.stderr' && typeof data?.chunk === 'string') sessionErr += data.chunk;
    });
    const session = await client.startSession({ command: '/bin/sh', cwd: ws, workspaceDir: ws });

    // Fragment vi phạm: `echo marker-...` ĐẦU dòng để chứng minh dòng
    // có chạy hay không — nếu fragment bị flush thì shell in marker ra
    // stdout TRƯỚC khi sudo kịp lỗi; nếu bị bỏ thì không có gì. Cách
    // này đúng cả khi máy có passwordless sudo (không dựa vào stderr
    // của sudo để kết luận).
    assert.deepEqual(
      await client.writeSession(session.sessionId, 'echo marker-flush-blocked; sudo -n true'),
      { ok: true },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(sessionOut, '', 'fragment chưa flush thì chưa có output');

    const started = Date.now();
    await client.dispose();
    const elapsedMs = Date.now() - started;
    assert.ok(elapsedMs < 5000, `shutdown phải hoàn thành nhanh, mất ${elapsedMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(!sessionOut.includes('marker-flush-blocked'), 'fragment vi phạm không được flush thành output');
    assert.ok(!sessionErr.includes('sudo'), `sudo không được chạy khi shutdown, stderr: ${JSON.stringify(sessionErr)}`);
  } finally {
    await client.dispose();
  }
});

test('daemon v0.26 shutdown (W19d): fragment vi phạm không bao giờ tới stdin (session `cat` echo lại mọi dòng)', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  const ws = makeTempWorkspace();
  const client = new DaemonClient();
  try {
    let sessionOut = '';
    client.onEvent((event, data) => {
      if (event === 'session.stdout' && typeof data?.chunk === 'string') sessionOut += data.chunk;
    });
    // Session `cat`: mọi dòng tới stdin đều echo ra stdout — fragment
    // vi phạm mà bị flush thì sẽ xuất hiện trong output, dù là chuỗi
    // nguy hiểm thật (`sudo rm -rf /`) thì `cat` cũng chỉ echo lại.
    const session = await client.startSession({ command: 'cat', cwd: ws, workspaceDir: ws });

    // Dòng lành đầy đủ trước đó vẫn qua bình thường.
    assert.deepEqual(await client.writeSession(session.sessionId, 'echo marker-cat-ok\n'), { ok: true });
    await waitFor(() => sessionOut.includes('echo marker-cat-ok\n'));

    // Fragment vi phạm chưa có newline: chỉ đệm, chưa bị chặn ngay.
    assert.deepEqual(await client.writeSession(session.sessionId, 'sudo rm -rf /'), { ok: true });

    const started = Date.now();
    await client.dispose();
    const elapsedMs = Date.now() - started;
    assert.ok(elapsedMs < 5000, `shutdown phải hoàn thành nhanh, mất ${elapsedMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(sessionOut.includes('echo marker-cat-ok\n'), 'dòng lành trước đó vẫn phải có');
    assert.ok(!sessionOut.includes('sudo rm -rf /'), 'fragment vi phạm không được flush tới stdin của cat');
  } finally {
    await client.dispose();
  }
});

test('daemon v0.26 shutdown (W19d): session không có fragment thì shutdown như cũ — nhanh, dòng đầy đủ trước đó vẫn chạy', async () => {
  delete process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  const ws = makeTempWorkspace();
  const client = new DaemonClient();
  try {
    let sessionOut = '';
    client.onEvent((event, data) => {
      if (event === 'session.stdout' && typeof data?.chunk === 'string') sessionOut += data.chunk;
    });
    const session = await client.startSession({ command: '/bin/sh', cwd: ws, workspaceDir: ws });

    // Dòng đầy đủ (có `\n`) chạy bình thường; sau đó không còn
    // fragment nào — shutdown không có gì để flush, thoát ngay như cũ.
    assert.deepEqual(await client.writeSession(session.sessionId, 'echo before-stop\n'), { ok: true });
    await waitFor(() => sessionOut.includes('before-stop\n'));
    assert.deepEqual(await client.ping(), { pong: true });

    const started = Date.now();
    await client.dispose();
    const elapsedMs = Date.now() - started;
    assert.ok(elapsedMs < 3000, `shutdown không có fragment phải nhanh như cũ, mất ${elapsedMs}ms`);
    assert.match(sessionOut, /before-stop\n/, 'dòng đầy đủ trước shutdown vẫn phải chạy');
  } finally {
    await client.dispose();
  }
});
