/**
 * Tests cho M6 — Bot box / sandbox theo turn + egress gate (local).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   xvfb-run -a node --test tests/sandbox-m6.test.mjs
 *
 * KHÔNG dùng CLI thật, KHÔNG đọc tài khoản/credential thật, KHÔNG gọi
 * API ngoài: mọi lệnh chạy trong box là /bin/sh, sleep, dd, printenv
 * trên thư mục tạm; egress gate test dùng forwardFn/connectFn fake +
 * server local; "public" test dùng lookupFn fake trỏ example.com về
 * IP public giả (không có kết nối thật ra ngoài). Secret giả chỉ xuất
 * hiện để chứng minh env/log redact được chúng — không bao giờ là key thật.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  BotBoxManager,
  EgressGate,
  LocalHarness,
  attachBoxToSession,
  boxDaemonExecRequest,
  buildBoxEnv,
  createAllowPublicEgressPolicy,
  createSession,
  detectIsolation,
  publishBoxLifecycle,
  readSignInState,
  syncSignInState,
  validateBoxEnvNames,
  waitSettled,
  writeSignInState,
} from '../packages/core/dist/index.js';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-m6-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
  delete process.env.OPENBOT_TEST_LEAK;
});

const PUBLIC_LOOKUP = async (hostname) => {
  if (hostname === 'example.com') return [{ address: '93.184.216.34' }];
  throw new Error(`ENOTFOUND ${hostname}`);
};

function fakeForward(bodyText) {
  return async () => ({
    status: 200,
    headers: { 'content-type': 'text/plain' },
    body: Buffer.from(bodyText, 'utf8'),
  });
}

/** Gửi request qua proxy gate (absolute-form). */
function proxyGet(gatePort, url) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: gatePort, method: 'GET', path: url },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// --- Box: tạo / layout / quyền ----------------------------------------------

test('M6 box: tạo box theo bot — thư mục riêng, auth 0700, idempotent', () => {
  const root = makeTempDir();
  const mgr = new BotBoxManager({ rootDir: root });
  const box = mgr.createBox('bot-a', { envAllowlist: ['MY_FLAG'] });
  assert.equal(box.botId, 'bot-a');
  assert.ok(fs.existsSync(box.workspaceDir));
  assert.ok(fs.existsSync(box.authDir));
  assert.equal(fs.statSync(box.authDir).mode & 0o777, 0o700);
  assert.ok(fs.existsSync(path.join(box.dir, 'box.json')));
  assert.deepEqual(box.envAllowlist, ['MY_FLAG']);
  // Idempotent: tạo lại cùng bot trả về box cũ.
  const again = mgr.createBox('bot-a');
  assert.equal(again.id, box.id);
  // Bot khác có workspace khác.
  const boxB = mgr.createBox('bot-b');
  assert.notEqual(boxB.workspaceDir, box.workspaceDir);
  assert.equal(mgr.listBoxes().length, 2);
  assert.throws(() => mgr.createBox('../escape'), /Invalid botId/);
  assert.equal(mgr.destroyBox('bot-a'), true);
  assert.equal(fs.existsSync(box.dir), false);
  assert.equal(mgr.destroyBox('bot-a'), false);
});

test('M6 env: biến lạ không lọt, secret phải qua Vault, allow-list validate', () => {
  const box = { id: 'box-x', botId: 'x', workspaceDir: '/tmp/ws', dir: '/tmp/box' };
  process.env.OPENBOT_TEST_LEAK = 'leak-value';
  const env = buildBoxEnv(box, { allowlist: ['MY_FLAG'], values: { MY_FLAG: 'yes' } });
  assert.equal(env.MY_FLAG, 'yes');
  assert.equal(env.OPENBOT_TEST_LEAK, undefined);
  assert.equal(env.HOME, '/tmp/ws');
  assert.equal(env.OPENBOT_BOT_ID, 'x');
  // Biến allow-list không có giá trị đưa vào thì không xuất hiện.
  const env2 = buildBoxEnv(box, { allowlist: ['MY_FLAG'] });
  assert.equal(env2.MY_FLAG, undefined);
  // Secret qua values thường bị từ chối, qua vaultSecrets được phép.
  assert.throws(() => buildBoxEnv(box, { values: { MY_API_KEY: 'x' } }), /vaultSecrets/);
  const env3 = buildBoxEnv(box, { vaultSecrets: { MY_API_KEY: 'vault-value' } });
  assert.equal(env3.MY_API_KEY, 'vault-value');
  assert.throws(() => validateBoxEnvNames(['SOME_TOKEN']), /looks like a secret/);
  assert.throws(() => validateBoxEnvNames(['bad-name!']), /Invalid env var name/);
});

test('M6 isolation: detect trên VM Linux này thấy bwrap', () => {
  const info = detectIsolation();
  assert.equal(info.kind, 'bwrap');
  assert.equal(info.isolated, true);
});

// --- Box: chạy lệnh -----------------------------------------------------------

test('M6 run: bwrap chạy lệnh, env lạ không lọt, /tmp host không thấy', async () => {
  const root = makeTempDir();
  const mgr = new BotBoxManager({ rootDir: root });
  const box = mgr.createBox('bot-run');
  process.env.OPENBOT_TEST_LEAK = 'leak-value';
  // Marker ngoài box (trong /tmp host) — trong box không được thấy.
  const marker = `m6-marker-${process.pid}.txt`;
  fs.writeFileSync(path.join(os.tmpdir(), marker), 'host-secret', 'utf8');
  try {
    const r = await mgr.runInBox('bot-run', '/bin/sh', [
      '-c',
      `echo "leak=[$OPENBOT_TEST_LEAK]"; pwd; test -e /tmp/${marker} && echo MARKER-VISIBLE || echo MARKER-HIDDEN`,
    ]);
    assert.equal(r.isolation.kind, 'bwrap');
    assert.equal(r.isolation.isolated, true);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /leak=\[\]/);
    assert.match(r.stdout, /MARKER-HIDDEN/);
    assert.ok(!r.stdout.includes('leak-value'));
    assert.ok(r.stdout.includes(box.workspaceDir));
    // File ghi trong box nằm đúng workspace của bot.
    const r2 = await mgr.runInBox('bot-run', '/bin/sh', ['-c', 'echo hello-box > note.txt']);
    assert.equal(r2.exitCode, 0);
    assert.equal(fs.readFileSync(path.join(box.workspaceDir, 'note.txt'), 'utf8').trim(), 'hello-box');
  } finally {
    fs.rmSync(path.join(os.tmpdir(), marker), { force: true });
  }
});

test('M6 run: timeout kill process group, cap ghi kill khi vượt', async () => {
  const root = makeTempDir();
  const mgr = new BotBoxManager({ rootDir: root });
  mgr.createBox('bot-limits');
  const slow = await mgr.runInBox('bot-limits', 'sleep', ['5'], { timeoutMs: 300 });
  assert.equal(slow.timedOut, true);
  assert.ok(slow.durationMs < 4000, `timeout kill quá chậm: ${slow.durationMs}ms`);
  const big = await mgr.runInBox(
    'bot-limits',
    '/bin/sh',
    [
      '-c',
      // Ghi chậm theo vòng lặp (mỗi vòng ~100KB + ngủ 50ms) để poll cap
      // (200ms) chắc chắn bắt được lúc vượt — dd một lần ghi 10MB quá
      // nhanh, xong trước cả lần poll đầu tiên.
      'i=0; while [ $i -lt 100 ]; do dd if=/dev/zero of=big.bin bs=1024 count=100 seek=$((i*100)) conv=notrunc 2>/dev/null; i=$((i+1)); sleep 0.05; done; echo done',
    ],
    { maxWriteBytes: 200 * 1024, timeoutMs: 15000 },
  );
  assert.equal(big.writeCapExceeded, true);
  assert.ok(big.workspaceBytes < 11 * 1024 * 1024, 'cap kill không kịp, file phình quá lớn');
});

test('M6 run: fallback none — trạng thái "không cách ly" rõ ràng', async () => {
  const root = makeTempDir();
  const mgr = new BotBoxManager({ rootDir: root });
  mgr.createBox('bot-plain');
  const r = await mgr.runInBox('bot-plain', '/bin/sh', ['-c', 'echo plain-ok'], { isolation: 'none' });
  assert.equal(r.isolation.kind, 'none');
  assert.equal(r.isolation.isolated, false);
  assert.ok(r.isolation.warning);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /plain-ok/);
});

test('M6 turn: resetPerTurn xoá workspace nhưng giữ auth', async () => {
  const root = makeTempDir();
  const mgr = new BotBoxManager({ rootDir: root });
  const box = mgr.createBox('bot-turn', { resetPerTurn: true });
  writeSignInState(box.authDir, {
    provider: 'claude',
    accountLabel: 'huy@example.com',
    status: 'signed-in',
    observedAt: new Date().toISOString(),
  });
  await mgr.runInBox('bot-turn', '/bin/sh', ['-c', 'echo work > work.txt']);
  assert.ok(fs.existsSync(path.join(box.workspaceDir, 'work.txt')));
  mgr.beginTurn('bot-turn');
  assert.equal(fs.existsSync(path.join(box.workspaceDir, 'work.txt')), false);
  assert.equal(readSignInState(box.authDir, 'claude')?.status, 'signed-in');
  // Box không resetPerTurn thì beginTurn giữ file.
  const box2 = mgr.createBox('bot-keep');
  await mgr.runInBox('bot-keep', '/bin/sh', ['-c', 'echo keep > keep.txt']);
  mgr.beginTurn('bot-keep');
  assert.ok(fs.existsSync(path.join(box2.workspaceDir, 'keep.txt')));
});

// --- Sign-in sync --------------------------------------------------------------

test('M6 signin: ghi atomic, quyền 0600, chặn secret, settled 2s', async () => {
  const root = makeTempDir();
  const authDir = path.join(root, 'auth');
  const file = writeSignInState(authDir, {
    provider: 'codex',
    accountLabel: 'user@example.com',
    status: 'signed-in',
    observedAt: new Date().toISOString(),
    source: 'cli-probe',
  });
  assert.equal(fs.statSync(authDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const back = readSignInState(authDir, 'codex');
  assert.equal(back?.accountLabel, 'user@example.com');
  assert.equal(back?.status, 'signed-in');
  // Không bao giờ cho token lọt vào state.
  assert.throws(
    () =>
      writeSignInState(authDir, {
        provider: 'codex',
        status: 'signed-in',
        observedAt: new Date().toISOString(),
        refreshToken: 'tok-123',
      }),
    /must not contain secret field/,
  );
  assert.equal(readSignInState(authDir, 'nope'), null);
  // waitSettled: file ổn định → true; file đổi liên tục → false.
  const stable = path.join(root, 'stable.txt');
  fs.writeFileSync(stable, 'v1');
  assert.equal(await waitSettled(stable, { settleMs: 200, timeoutMs: 3000 }), true);
  const changing = path.join(root, 'changing.txt');
  fs.writeFileSync(changing, 'v1');
  const changer = setInterval(() => {
    try {
      fs.writeFileSync(changing, `v${Date.now()}`);
    } catch { /* thư mục tạm đã xoá */ }
  }, 50);
  try {
    assert.equal(await waitSettled(changing, { settleMs: 500, timeoutMs: 1200 }), false);
  } finally {
    clearInterval(changer);
  }
  // syncSignInState với sourceFile settled → ghi state, trả đường dẫn.
  const synced = await syncSignInState(
    authDir,
    { provider: 'grok-cli', status: 'signed-out', observedAt: new Date().toISOString() },
    { sourceFile: stable, settleMs: 200, timeoutMs: 3000 },
  );
  assert.ok(synced && fs.existsSync(synced));
  assert.equal(readSignInState(authDir, 'grok-cli')?.status, 'signed-out');
});

// --- Egress gate ---------------------------------------------------------------

test('M6 gate: chặn loopback/LAN/metadata, cho public qua fake forward, log không secret', async () => {
  const gate = new EgressGate('box-gate-1', {
    policy: createAllowPublicEgressPolicy(),
    lookupFn: PUBLIC_LOOKUP,
    forwardFn: fakeForward('fake-public-body'),
  });
  const info = await gate.start();
  try {
    assert.ok(info.port > 0);
    // Public (lookup fake → IP public) → qua, body từ fake forward.
    const ok = await proxyGet(info.port, 'http://example.com/some/path?api_key=SECRET-XYZ');
    assert.equal(ok.status, 200);
    assert.equal(ok.body, 'fake-public-body');
    // Loopback / LAN / metadata → 403.
    for (const url of [
      'http://127.0.0.1:9/x',
      'http://localhost:8080/x',
      'http://192.168.1.1/admin',
      'http://10.0.0.5/x',
      'http://169.254.169.254/latest/meta-data/',
    ]) {
      const denied = await proxyGet(info.port, url);
      assert.equal(denied.status, 403, `phải chặn ${url}`);
    }
    const decisions = gate.decisions();
    assert.ok(decisions.some((d) => d.host === 'example.com' && d.allowed));
    assert.ok(decisions.some((d) => d.host === '127.0.0.1' && !d.allowed));
    assert.ok(decisions.some((d) => d.host === '169.254.169.254' && !d.allowed));
    // Log không chứa URL đầy đủ / secret trong query.
    assert.ok(!JSON.stringify(decisions).includes('SECRET-XYZ'));
    assert.ok(!JSON.stringify(decisions).includes('/some/path'));
    // proxyEnv trỏ vào gate trên loopback.
    const env = gate.proxyEnv();
    assert.equal(env.http_proxy, `http://127.0.0.1:${info.port}`);
  } finally {
    await gate.stop();
  }
});

test('M6 gate: CONNECT public qua tunnel fake, CONNECT loopback bị chặn', async () => {
  // Echo server local — tunnel fake nối tới đây (không phải đích thật).
  const echo = net.createServer((socket) => {
    socket.on('data', (d) => socket.write(d));
  });
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const echoPort = echo.address().port;
  const gate = new EgressGate('box-gate-2', {
    policy: createAllowPublicEgressPolicy(),
    lookupFn: PUBLIC_LOOKUP,
    connectFn: async () =>
      new Promise((resolve, reject) => {
        const s = net.connect(echoPort, '127.0.0.1');
        s.once('connect', () => resolve(s));
        s.once('error', reject);
      }),
  });
  const info = await gate.start();
  try {
    // CONNECT tới host public → 200 + tunnel echo được.
    const tunneled = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: info.port,
        method: 'CONNECT',
        path: 'example.com:443',
      });
      req.on('connect', (_res, socket) => {
        socket.write('ping-tunnel');
        socket.once('data', (d) => {
          const text = d.toString();
          socket.destroy();
          resolve(text);
        });
        socket.once('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(tunneled, 'ping-tunnel');
    // CONNECT tới loopback → 403 (socket đóng).
    const denied = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port: info.port,
        method: 'CONNECT',
        path: '127.0.0.1:443',
      });
      req.on('connect', (res) => resolve(res.statusCode));
      req.on('error', () => resolve('error'));
      req.on('response', (res) => resolve(res.statusCode));
      req.end();
      setTimeout(() => resolve('timeout'), 3000);
    });
    assert.ok(denied === 403 || denied === 'error', `CONNECT loopback phải bị chặn, got ${denied}`);
    assert.ok(gate.decisions().some((d) => d.method === 'CONNECT' && d.host === 'example.com' && d.allowed));
    assert.ok(gate.decisions().some((d) => d.method === 'CONNECT' && d.host === '127.0.0.1' && !d.allowed));
  } finally {
    await gate.stop();
    echo.close();
  }
});

test('M6 gate: forward thật tới server local khi policy cho phép (mechanics-only)', async () => {
  // Server local thật + policy allowPrivateDestinations: chỉ kiểm cơ
  // chế proxy forward, KHÔNG phải luật "chỉ public" (luật đó đã kiểm ở test trên).
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('local-server-body');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const localPort = server.address().port;
  const policy = { ...createAllowPublicEgressPolicy(), allowPrivateDestinations: true };
  const gate = new EgressGate('box-gate-3', { policy });
  const info = await gate.start();
  try {
    const res = await proxyGet(info.port, `http://127.0.0.1:${localPort}/hello`);
    assert.equal(res.status, 200);
    assert.equal(res.body, 'local-server-body');
  } finally {
    await gate.stop();
    server.close();
  }
});

// --- Nối: harness / session / daemon -------------------------------------------

test('M6 wiring: box lifecycle lên bus + NDJSON log của harness', async () => {
  const root = makeTempDir();
  const harness = new LocalHarness({ dataDir: path.join(root, 'harness') });
  const seen = [];
  const unsub = harness.bus.subscribe({ kinds: ['lifecycle'] }, (e) => seen.push(e));
  const mgr = new BotBoxManager({ rootDir: path.join(root, 'boxes') });
  const box = mgr.createBox('bot-wire');
  publishBoxLifecycle(harness, box, 'box_created', { engine: 'mock' });
  publishBoxLifecycle(harness, box, 'box_destroyed', { engine: 'mock' });
  unsub();
  assert.equal(seen.length, 2);
  assert.equal(seen[0].kind, 'lifecycle');
  assert.equal(seen[0].payload.action, 'box_created');
  assert.equal(seen[0].payload.boxId, box.id);
  assert.equal(seen[0].botId, 'bot-wire');
  // NDJSON log có event box.
  const page = harness.readThreadLog('bot-wire', { kinds: ['lifecycle'] });
  assert.equal(page.total, 2);
  assert.equal(page.entries[0].payload.action, 'box_created');
});

test('M6 wiring: box dưới session + ExecRequest cho daemon', () => {
  const root = makeTempDir();
  const session = createSession(root, { name: 'sess-m6' });
  const box = attachBoxToSession(root, session.id, 'bot-sess', { envAllowlist: ['MY_FLAG'] });
  assert.ok(box.workspaceDir.startsWith(session.workspaceDir));
  assert.ok(box.workspaceDir.includes('boxes'));
  // ExecRequest cho daemon: cwd/workspaceDir trong box, env không rò secret host.
  process.env.OPENBOT_TEST_LEAK = 'leak-value';
  const req = boxDaemonExecRequest(box, 'node', ['--version'], {
    envValues: { MY_FLAG: '1' },
    vaultSecrets: { MY_API_KEY: 'vault-value' },
  });
  assert.equal(req.command, 'node');
  assert.deepEqual(req.args, ['--version']);
  assert.equal(req.cwd, box.workspaceDir);
  assert.equal(req.workspaceDir, box.workspaceDir);
  assert.equal(req.env.MY_FLAG, '1');
  assert.equal(req.env.MY_API_KEY, 'vault-value');
  assert.equal(req.env.OPENBOT_TEST_LEAK, undefined);
});
