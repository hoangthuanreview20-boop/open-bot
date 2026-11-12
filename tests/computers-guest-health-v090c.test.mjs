/**
 * Tests cho v0.90c (đội G gói C) — guest agent hoàn thiện hơn:
 * ping/info (2 phía), tương thích guest cũ ('unknown', không crash),
 * reconnect có giới hạn, runtime checkGuestHealth + statusView.
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/computers-guest-health-v090c.test.mjs
 *
 * Guest giả = server Unix socket nói NDJSON; script guest THẬT chạy
 * trên host qua Unix socket (như test v0.78). VM thật không cần
 * QEMU/image qcow2 — runtime VM dùng fake spawn (pid giả).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  BotComputerRuntime,
  GUEST_AGENT_VERSION,
  GuestAgentClient,
  fakeMachineProfile,
  planComputers,
} from '../packages/core/dist/index.js';

const GB = 1024 ** 3;
const GUEST_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'core',
  'src',
  'compute',
  'guest-agent.mjs',
);
const tempDirs = [];
const closables = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-guest-health-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const c of closables.splice(0)) {
    try {
      if (typeof c.close === 'function') c.close();
      if (typeof c.kill === 'function') c.kill();
    } catch {
      // Dọn best-effort.
    }
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function fakeBackends() {
  return [
    { kind: 'box', level: 'box', available: true, detail: 'box' },
    { kind: 'bwrap', level: 'container', available: false, detail: 'không có bwrap' },
    { kind: 'qemu', level: 'vm', available: true, detail: 'qemu' },
    { kind: 'wsl', level: 'vm', available: false, detail: 'không thấy WSL2' },
    { kind: 'hyperv', level: 'vm', available: false, detail: 'Hyper-V chưa bật' },
    { kind: 'macvm', level: 'vm', available: false, detail: 'không có Virtualization.framework' },
  ];
}

/**
 * Fake guest: server Unix socket nói NDJSON. `handler(req)` trả reply
 * object, 'disconnect' (cắt socket), hoặc null (không trả gì).
 * `newGuestHandler`: hỗ trợ exec + ping + info (guest mới v0.90c).
 * `oldGuestHandler`: chỉ exec, ping/info trả lỗi như guest trước v0.90c.
 */
function startFakeGuest(socketPath, handler) {
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i = buf.indexOf('\n');
      while (i !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line !== '') {
          const req = JSON.parse(line);
          const out = handler(req, sock);
          if (out === 'disconnect') sock.destroy();
          else if (out) sock.write(`${JSON.stringify(out)}\n`);
        }
        i = buf.indexOf('\n');
      }
    });
  });
  closables.push(server);
  return new Promise((resolve) => server.listen(socketPath, () => resolve(server)));
}

function newGuestHandler(req) {
  if (req.type === 'ping') {
    return { id: req.id, type: 'pong', version: GUEST_AGENT_VERSION, uptimeSeconds: 42 };
  }
  if (req.type === 'info') {
    return {
      id: req.id,
      type: 'info',
      version: GUEST_AGENT_VERSION,
      uptimeSeconds: 42,
      node: 'v22.0.0',
      platform: 'linux',
      arch: 'x64',
    };
  }
  if (req.type === 'exec' && req.command === 'echo') {
    return { id: req.id, type: 'result', code: 0, stdout: `${req.args.join(' ')}\n`, stderr: '' };
  }
  return { id: req.id, type: 'error', message: `lệnh lạ: ${req.command ?? req.type}` };
}

function oldGuestHandler(req) {
  if (req.type === 'exec' && req.command === 'echo') {
    return { id: req.id, type: 'result', code: 0, stdout: `${req.args.join(' ')}\n`, stderr: '' };
  }
  // Guest trước v0.90c: chỉ biết exec, type khác trả lỗi.
  return { id: req.id, type: 'error', message: 'Yêu cầu phải có type "exec".' };
}

// --- Client: ping/info ---------------------------------------------------------

test('guest-health v0.90c: client ping/info với guest mới — ok + version/uptime', async () => {
  const dir = makeTempDir();
  const sock = path.join(dir, 'a.sock');
  await startFakeGuest(sock, newGuestHandler);
  const client = new GuestAgentClient(sock);
  closables.push(client);
  await client.connect();
  const ping = await client.ping();
  assert.equal(ping.status, 'ok');
  assert.equal(ping.version, GUEST_AGENT_VERSION);
  assert.equal(ping.uptimeSeconds, 42);
  assert.ok(typeof ping.rttMs === 'number' && ping.rttMs >= 0);
  const info = await client.info();
  assert.deepEqual(info, {
    version: GUEST_AGENT_VERSION,
    uptimeSeconds: 42,
    nodeVersion: 'v22.0.0',
    platform: 'linux',
    arch: 'x64',
  });
  // exec vẫn chạy bình thường sau ping/info (không hỏng protocol).
  const res = await client.exec('echo', ['hi']);
  assert.equal(res.stdout, 'hi\n');
  client.close();
});

test('guest-health v0.90c: guest CŨ không biết ping/info — ping unknown, info null, không crash', async () => {
  const dir = makeTempDir();
  const sock = path.join(dir, 'old.sock');
  await startFakeGuest(sock, oldGuestHandler);
  const client = new GuestAgentClient(sock);
  closables.push(client);
  await client.connect();
  const ping = await client.ping();
  assert.equal(ping.status, 'unknown');
  assert.equal(await client.info(), null);
  // Client vẫn sống + exec vẫn chạy sau khi guest cũ trả lỗi.
  assert.equal(client.connected, true);
  const res = await client.exec('echo', ['still-alive']);
  assert.equal(res.stdout, 'still-alive\n');
  client.close();
});

test('guest-health v0.90c: ping timeout khi guest không trả lời — unknown, không throw', async () => {
  const dir = makeTempDir();
  const sock = path.join(dir, 'silent.sock');
  await startFakeGuest(sock, () => null);
  const client = new GuestAgentClient(sock);
  closables.push(client);
  await client.connect();
  const started = Date.now();
  const ping = await client.ping(100);
  assert.equal(ping.status, 'unknown');
  assert.ok(Date.now() - started < 5000, 'ping timeout phải nhanh, không chờ hết timeout exec mặc định');
  client.close();
});

// --- Client: reconnect ---------------------------------------------------------

test('guest-health v0.90c: reconnect — nối lại được sau khi đóng; hết lần thử thì false (không vòng lặp vô hạn)', async () => {
  const dir = makeTempDir();
  const sock = path.join(dir, 're.sock');
  await startFakeGuest(sock, newGuestHandler);
  const client = new GuestAgentClient(sock);
  closables.push(client);
  await client.connect();
  assert.equal(client.connected, true);
  client.close();
  assert.equal(client.connected, false);
  // Socket vẫn lắng nghe: reconnect thành công.
  assert.equal(await client.reconnect({ maxAttempts: 3, delayMs: 10 }), true);
  assert.equal(client.connected, true);
  const ping = await client.ping();
  assert.equal(ping.status, 'ok');
  client.close();

  // Socket không tồn tại: reconnect thử đúng số lần rồi trả false.
  const dead = new GuestAgentClient(path.join(dir, 'nope.sock'));
  closables.push(dead);
  const started = Date.now();
  assert.equal(await dead.reconnect({ maxAttempts: 2, delayMs: 10, connectTimeoutMs: 100 }), false);
  assert.ok(Date.now() - started < 5000, 'reconnect hết lần thử phải dừng nhanh');
});

// --- Script guest THẬT ---------------------------------------------------------

test('guest-health v0.90c: script guest thật trả pong/info + exec vẫn chạy', async () => {
  const dir = makeTempDir();
  const sock = path.join(dir, 'guest.sock');
  const server = net.createServer();
  closables.push(server);
  await new Promise((resolve) => server.listen(sock, resolve));
  const guest = spawn(process.execPath, [GUEST_SCRIPT, sock], { stdio: ['ignore', 'pipe', 'pipe'] });
  closables.push(guest);
  const guestConn = await new Promise((resolve, reject) => {
    server.once('connection', resolve);
    server.once('error', reject);
    setTimeout(() => reject(new Error('script guest không kết nối tới socket sau 5s')), 5000);
  });
  let buf = '';
  const replies = [];
  guestConn.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i = buf.indexOf('\n');
    while (i !== -1) {
      replies.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
      i = buf.indexOf('\n');
    }
  });
  const nextReply = async () => {
    const started = Date.now();
    while (replies.length === 0) {
      if (Date.now() - started > 5000) throw new Error('guest không trả lời sau 5s');
      await new Promise((r) => setTimeout(r, 10));
    }
    return replies.shift();
  };
  guestConn.write(`${JSON.stringify({ id: 1, type: 'ping' })}\n`);
  const pong = await nextReply();
  assert.equal(pong.type, 'pong');
  assert.equal(pong.version, GUEST_AGENT_VERSION);
  assert.ok(typeof pong.uptimeSeconds === 'number' && pong.uptimeSeconds >= 0);
  guestConn.write(`${JSON.stringify({ id: 2, type: 'info' })}\n`);
  const info = await nextReply();
  assert.equal(info.type, 'info');
  assert.equal(info.version, GUEST_AGENT_VERSION);
  assert.equal(info.platform, process.platform);
  assert.equal(info.arch, process.arch);
  assert.match(info.node, /^v\d+\./);
  // exec sau ping/info vẫn chạy (hồi quy).
  guestConn.write(`${JSON.stringify({ id: 3, type: 'exec', command: process.execPath, args: ['-e', "process.stdout.write('hi-real-guest')"], timeoutMs: 5000 })}\n`);
  const r3 = await nextReply();
  assert.deepEqual(r3, { id: 3, type: 'result', code: 0, stdout: 'hi-real-guest', stderr: '' });
});

// --- Runtime: checkGuestHealth + statusView ------------------------------------

function makeVmRuntime(rootDir) {
  const imagePath = path.join(rootDir, 'vm.qcow2');
  fs.writeFileSync(imagePath, 'fake-qcow2-image', 'utf8');
  const runtime = new BotComputerRuntime({
    rootDir,
    backends: fakeBackends(),
    profile: fakeMachineProfile(),
    spawnFn: () => ({ pid: 4242, on: () => undefined, unref: () => undefined }),
  });
  const plan = planComputers(fakeMachineProfile(), [{ botId: 'vm1', level: 'vm' }], fakeBackends());
  runtime.createComputer(plan.allocations[0]);
  runtime.setVmImage('vm1', imagePath);
  return runtime;
}

test('guest-health v0.90c: runtime checkGuestHealth — ok (guest mới) / unknown (guest cũ) / missing (chưa boot, không socket)', async () => {
  const rootDir = makeTempDir();
  const runtime = makeVmRuntime(rootDir);
  // VM chưa chạy -> missing (không cố kết nối).
  const notRunning = await runtime.checkGuestHealth('vm1');
  assert.equal(notRunning.status, 'missing');
  assert.match(notRunning.hint ?? '', /chưa chạy/);

  await runtime.startComputer('vm1');
  assert.equal(runtime.getComputer('vm1')?.state, 'running');
  // VM chạy nhưng chưa có socket guest -> missing + hint cài guest.
  const noSocket = await runtime.checkGuestHealth('vm1');
  assert.equal(noSocket.status, 'missing');
  assert.match(noSocket.hint ?? '', /guest-agent\.mjs/);
  assert.equal(runtime.statusView('vm1')?.guestAgentHealth?.status, 'missing');

  // Guest mới trên socket -> ok + version; statusView thấy health.
  await startFakeGuest(runtime.guestAgentSocketPath('vm1'), newGuestHandler);
  const ok = await runtime.checkGuestHealth('vm1');
  assert.equal(ok.status, 'ok');
  assert.equal(ok.version, GUEST_AGENT_VERSION);
  assert.equal(ok.uptimeSeconds, 42);
  const view = runtime.statusView('vm1');
  assert.equal(view?.guestAgentHealth?.status, 'ok');
  assert.equal(view?.guestAgentConnected, true);
  await runtime.stopComputer('vm1');
  assert.equal(runtime.guestAgentStatus('vm1').connected, false);
});

test('guest-health v0.90c: runtime checkGuestHealth với guest cũ — unknown, không crash, gợi ý cập nhật', async () => {
  const rootDir = makeTempDir();
  const runtime = makeVmRuntime(rootDir);
  await runtime.startComputer('vm1');
  await startFakeGuest(runtime.guestAgentSocketPath('vm1'), oldGuestHandler);
  const health = await runtime.checkGuestHealth('vm1');
  assert.equal(health.status, 'unknown');
  assert.match(health.hint ?? '', /bản cũ/);
  assert.equal(runtime.statusView('vm1')?.guestAgentHealth?.status, 'unknown');
  await runtime.stopComputer('vm1');
});

test('guest-health v0.90c: runtime refreshGuestHealth throttle — lần 2 trong 15s dùng cache, không ping lại', async () => {
  const rootDir = makeTempDir();
  let pingCount = 0;
  const countingHandler = (req) => {
    if (req.type === 'ping') pingCount += 1;
    return newGuestHandler(req);
  };
  const runtime = makeVmRuntime(rootDir);
  await runtime.startComputer('vm1');
  await startFakeGuest(runtime.guestAgentSocketPath('vm1'), countingHandler);
  const first = await runtime.refreshGuestHealth('vm1');
  assert.equal(first.status, 'ok');
  assert.equal(pingCount, 1);
  const second = await runtime.refreshGuestHealth('vm1');
  assert.equal(second.status, 'ok');
  assert.equal(pingCount, 1, 'lần refresh thứ 2 trong 15s phải dùng cache, không ping lại');
  await runtime.stopComputer('vm1');
});

test('guest-health v0.90c: runtime reconnectGuestAgent — có guest thì true, không socket thì false', async () => {
  const rootDir = makeTempDir();
  const runtime = makeVmRuntime(rootDir);
  // Không phải VM / không có máy -> false.
  assert.equal(await runtime.reconnectGuestAgent('nope'), false);
  await runtime.startComputer('vm1');
  // Chưa có socket guest -> false (không chờ lâu).
  assert.equal(await runtime.reconnectGuestAgent('vm1', 2, 100), false);
  // Có guest -> true.
  await startFakeGuest(runtime.guestAgentSocketPath('vm1'), newGuestHandler);
  assert.equal(await runtime.reconnectGuestAgent('vm1', 2, 1000), true);
  assert.equal(runtime.guestAgentStatus('vm1').connected, true);
  await runtime.stopComputer('vm1');
});
