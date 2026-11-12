/**
 * Tests cho guest agent của VM (v0.78c) —
 * packages/core/src/compute/guestAgent.ts (host client) +
 * packages/core/src/compute/guest-agent.mjs (script chạy trong VM) +
 * nối dây vào BotComputerRuntime (bootVm chardev, runInComputer VM).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/computers-guest-agent-v078.test.mjs
 *
 * Không có QEMU/VM thật trên máy này nên mọi test dùng Unix socket:
 * fake guest = server Node nói NDJSON; script guest THẬT được chạy
 * thật (spawn `node guest-agent.mjs <socket>`) và nói chuyện với
 * server test đóng vai QEMU/host.
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
  GUEST_AGENT_PORT_NAME,
  GuestAgentClient,
  buildQemuBootArgs,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-guest-test-'));
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
 * Fake guest: server Unix socket nói NDJSON. `handler(req)` trả
 * reply object, hoặc 'malformed' (gửi dòng không phải JSON), hoặc
 * 'disconnect' (cắt socket), hoặc null/undefined (không trả gì).
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
          if (out === 'malformed') sock.write('not json\n');
          else if (out === 'disconnect') sock.destroy();
          else if (out) sock.write(`${JSON.stringify(out)}\n`);
        }
        i = buf.indexOf('\n');
      }
    });
  });
  closables.push(server);
  return new Promise((resolve) => server.listen(socketPath, () => resolve(server)));
}

function echoHandler(req) {
  if (req.command === 'echo') {
    return { id: req.id, type: 'result', code: 0, stdout: `${req.args.join(' ')}\n`, stderr: '' };
  }
  if (req.command === 'fail') {
    return { id: req.id, type: 'result', code: 3, stdout: '', stderr: 'nope\n' };
  }
  return { id: req.id, type: 'error', message: `lệnh lạ: ${req.command}` };
}

// --- GuestAgentClient vs fake guest ------------------------------------------

test('guest-agent v0.78: client exec echo -> stdout, fail -> code != 0, lệnh lạ -> lỗi', async () => {
  const dir = makeTempDir();
  const sock = path.join(dir, 'a.sock');
  await startFakeGuest(sock, echoHandler);
  const client = new GuestAgentClient(sock);
  closables.push(client);
  await client.connect();
  assert.equal(client.connected, true);
  const ok = await client.exec('echo', ['hello', 'guest']);
  assert.deepEqual(ok, { code: 0, stdout: 'hello guest\n', stderr: '' });
  const failed = await client.exec('fail', []);
  assert.equal(failed.code, 3);
  assert.match(failed.stderr, /nope/);
  await assert.rejects(() => client.exec('nope', []), /lệnh lạ/);
  client.close();
  assert.equal(client.connected, false);
});

test('guest-agent v0.78: exec timeout khi guest không trả lời; ngắt giữa chừng -> lỗi', async () => {
  const dir = makeTempDir();
  const sock = path.join(dir, 'a.sock');
  await startFakeGuest(sock, () => null); // không bao giờ trả lời
  const client = new GuestAgentClient(sock);
  closables.push(client);
  await client.connect();
  await assert.rejects(() => client.exec('echo', ['x'], { timeoutMs: 100 }), /timeout/);
  client.close();

  const sock2 = path.join(dir, 'b.sock');
  await startFakeGuest(sock2, () => 'disconnect');
  const client2 = new GuestAgentClient(sock2);
  closables.push(client2);
  await client2.connect();
  await assert.rejects(() => client2.exec('echo', ['x']), /ngắt kết nối|Socket guest agent lỗi/);
  client2.close();
});

test('guest-agent v0.78: guest gửi dòng không phải JSON -> client báo lỗi protocol + đóng socket', async () => {
  const dir = makeTempDir();
  const sock = path.join(dir, 'a.sock');
  await startFakeGuest(sock, () => 'malformed');
  const client = new GuestAgentClient(sock);
  closables.push(client);
  await client.connect();
  await assert.rejects(() => client.exec('echo', ['x']), /không phải JSON/);
  assert.equal(client.connected, false);
});

test('guest-agent v0.78: connect tới socket không tồn tại -> lỗi rõ, exec khi chưa connect -> lỗi', async () => {
  const client = new GuestAgentClient(path.join(makeTempDir(), 'nope.sock'));
  closables.push(client);
  await assert.rejects(() => client.connect(200), /Không kết nối được tới guest agent/);
  await assert.rejects(() => client.exec('echo', []), /chưa kết nối/);
});

// --- Script guest THẬT ---------------------------------------------------------

test('guest-agent v0.78: script guest thật chạy echo + exit code + timeout qua Unix socket', async () => {
  const dir = makeTempDir();
  const sock = path.join(dir, 'guest.sock');
  // Server đóng vai QEMU/host: nhận kết nối từ script guest rồi gửi request.
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
  // echo thật trong process con của guest.
  guestConn.write(`${JSON.stringify({ id: 1, type: 'exec', command: process.execPath, args: ['-e', "process.stdout.write('hi-real-guest')"], timeoutMs: 5000 })}\n`);
  const r1 = await nextReply();
  assert.deepEqual(r1, { id: 1, type: 'result', code: 0, stdout: 'hi-real-guest', stderr: '' });
  // exit code != 0.
  guestConn.write(`${JSON.stringify({ id: 2, type: 'exec', command: process.execPath, args: ['-e', 'process.exit(3)'], timeoutMs: 5000 })}\n`);
  const r2 = await nextReply();
  assert.equal(r2.code, 3);
  assert.equal(r2.type, 'result');
  // timeout: lệnh ngủ 5s, timeout 200ms.
  guestConn.write(`${JSON.stringify({ id: 3, type: 'exec', command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 5000)'], timeoutMs: 200 })}\n`);
  const r3 = await nextReply();
  assert.equal(r3.type, 'error');
  assert.match(r3.message, /timeout/);
  guestConn.destroy();
  guest.kill();
});

// --- buildQemuBootArgs ----------------------------------------------------------

test('guest-agent v0.78: buildQemuBootArgs thêm chardev guest agent khi có socket path', () => {
  const computer = { cpuCores: 2, ramBytes: 4 * GB };
  const withAgent = buildQemuBootArgs('/data/vm.qcow2', computer, {
    guestAgentSocketPath: '/tmp/vm1.agent.sock',
  });
  assert.ok(withAgent.includes('-chardev'));
  assert.ok(withAgent.some((a) => a === 'socket,path=/tmp/vm1.agent.sock,server=on,wait=off,id=agent0'));
  assert.ok(withAgent.includes('virtio-serial-pci'));
  assert.ok(withAgent.includes(`virtserialport,chardev=agent0,name=${GUEST_AGENT_PORT_NAME}`));
  const withoutAgent = buildQemuBootArgs('/data/vm.qcow2', computer, {});
  assert.ok(!withoutAgent.includes('-chardev'));
});

// --- Runtime: boot VM + runInComputer qua guest agent --------------------------

test('guest-agent v0.78: runtime boot VM truyền chardev, runInComputer chạy qua guest, stop ngắt kết nối', async () => {
  const rootDir = makeTempDir();
  const imagePath = path.join(rootDir, 'vm.qcow2');
  fs.writeFileSync(imagePath, 'fake-qcow2-image', 'utf8');
  const spawnCalls = [];
  const runtime = new BotComputerRuntime({
    rootDir,
    backends: fakeBackends(),
    profile: fakeMachineProfile(),
    spawnFn: (command, args) => {
      spawnCalls.push({ command, args });
      return { pid: 4242, on: () => undefined, unref: () => undefined };
    },
  });
  const plan = planComputers(fakeMachineProfile(), [{ botId: 'vm1', level: 'vm' }], fakeBackends());
  runtime.createComputer(plan.allocations[0]);
  runtime.setVmImage('vm1', imagePath);
  const started = await runtime.startComputer('vm1');
  assert.equal(started.state, 'running');
  const sockPath = runtime.guestAgentSocketPath('vm1');
  assert.equal(sockPath, path.join(rootDir, 'vm1.agent.sock'));
  assert.ok(spawnCalls[0].args.includes(`socket,path=${sockPath},server=on,wait=off,id=agent0`));
  // Chưa có guest: chạy lệnh -> lỗi rõ kèm hướng dẫn cài guest.
  await assert.rejects(
    () => runtime.runInComputer('vm1', '/bin/echo', ['x']),
    /guest-agent\.mjs/,
  );
  assert.equal(runtime.guestAgentStatus('vm1').connected, false);
  // Fake guest lắng nghe đúng socket path của runtime (đóng vai QEMU+guest).
  await startFakeGuest(sockPath, echoHandler);
  const res = await runtime.runInComputer('vm1', 'echo', ['hi-vm']);
  assert.equal(res.stdout, 'hi-vm\n');
  assert.equal(res.exitCode, 0);
  assert.equal(res.isolation.kind, 'vm');
  assert.equal(res.isolation.isolated, true);
  assert.equal(res.limitsApplied?.maxMemoryBytes, 4 * GB);
  assert.equal(runtime.statusView('vm1')?.guestAgentConnected, true);
  // stop ngắt guest agent.
  await runtime.stopComputer('vm1');
  assert.equal(runtime.guestAgentStatus('vm1').connected, false);
  assert.equal(runtime.statusView('vm1')?.guestAgentConnected, false);
});

test('guest-agent v0.78: runtime runInComputer VM timeout -> kết quả timedOut thay vì throw', async () => {
  const rootDir = makeTempDir();
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
  await runtime.startComputer('vm1');
  await startFakeGuest(runtime.guestAgentSocketPath('vm1'), () => null);
  const res = await runtime.runInComputer('vm1', 'echo', ['x'], { timeoutMs: 100 });
  assert.equal(res.timedOut, true);
  assert.equal(res.exitCode, null);
  assert.equal(res.isolation.kind, 'vm');
  // Dọn: stop ngắt guest agent — nếu không client socket còn mở sẽ
  // giữ event loop sống và tiến trình test không thoát được.
  await runtime.stopComputer('vm1');
  assert.equal(runtime.guestAgentStatus('vm1').connected, false);
});
