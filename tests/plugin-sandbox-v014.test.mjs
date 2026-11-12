/**
 * Tests for the v0.14 out-of-process plugin sandbox
 * (packages/tools/src/plugins/sandbox.ts + sandboxWorker.ts).
 *
 * Run after building the tools package:
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/plugin-sandbox-v014.test.mjs
 *
 * All fixtures are local temp plugin dirs; no network, no API key.
 * Timeouts are small on purpose so the suite stays fast (the sandbox
 * default is 30s, tests pass 500-1000ms).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createSandboxedPluginHost } from '../packages/tools/dist/plugins/sandbox.js';

const tempDirs = [];
const hosts = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-sandbox-test-'));
  tempDirs.push(dir);
  return dir;
}
async function trackHost(host) {
  hosts.push(host);
  return host;
}
afterEach(async () => {
  while (hosts.length > 0) {
    try { await hosts.pop().dispose(); } catch { /* already dead */ }
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

/** Poll `cond()` until truthy (or timeout). Returns the truthy value. */
async function waitFor(cond, { timeoutMs = 10_000, intervalMs = 50 } = {}) {
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

/** Write a plugin directory: manifest.json + index.js (CommonJS). */
function writePlugin(dir, manifest, indexJs) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'index.js'), indexJs, 'utf8');
  return dir;
}

const ECHO_HANG_NOISY_JS = `
const echoTool = {
  definition: {
    name: 'echo',
    description: 'Echo the given text back.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo.' } },
      required: ['text'],
    },
  },
  needsApproval: false,
  execute: async (args) => String(args.text ?? ''),
};
const hangTool = {
  definition: {
    name: 'hang',
    description: 'Never resolves (for timeout tests).',
    parameters: { type: 'object', properties: {} },
  },
  needsApproval: false,
  execute: async () => new Promise(() => {}),
};
const noisyTool = {
  definition: {
    name: 'noisy',
    description: 'Writes to stderr, then returns ok.',
    parameters: { type: 'object', properties: {} },
  },
  needsApproval: false,
  execute: async () => {
    process.stderr.write('canh-bao-tu-plugin\\n');
    return 'ok-noisy';
  },
};
const floodTool = {
  definition: {
    name: 'flood',
    description: 'Writes 150KB to stderr (for the 100KB capture cap).',
    parameters: { type: 'object', properties: {} },
  },
  needsApproval: false,
  execute: async () => {
    process.stderr.write('x'.repeat(150000));
    return 'ok-flood';
  },
};
module.exports = { tools: [echoTool, hangTool, noisyTool, floodTool] };
`;

function comboManifest(id = 'combo-plugin') {
  return {
    id,
    name: 'Combo Plugin',
    version: '1.0.0',
    description: 'Echo + hang + noisy + flood tools for sandbox tests.',
    permissions: [],
    main: 'index.js',
    tools: ['echo', 'hang', 'noisy', 'flood'],
  };
}

function comboPluginDir() {
  return writePlugin(path.join(makeTempDir(), 'combo-plugin'), comboManifest(), ECHO_HANG_NOISY_JS);
}

// ---------------------------------------------------------------------------
// Basic: real tool call through the child process
// ---------------------------------------------------------------------------

test('sandbox: call tool thật qua child process (pid khác host), ping trả pong', async () => {
  const dir = comboPluginDir();
  const host = await trackHost(createSandboxedPluginHost({ pluginDir: dir }));

  const status = host.getStatus();
  assert.equal(status.status, 'running');
  assert.equal(typeof status.pid, 'number');
  assert.notEqual(status.pid, process.pid, 'plugin phải chạy ở process con, không phải process host');
  assert.equal(status.pluginId, 'combo-plugin');

  assert.equal(await host.callTool('echo', { text: 'xin chào sandbox' }), 'xin chào sandbox');
  assert.deepEqual(await host.ping(), { pong: true });

  const ready = host.getStatus();
  assert.deepEqual([...ready.tools].sort(), ['echo', 'flood', 'hang', 'noisy']);
});

test('sandbox: gọi tool không tồn tại trả lỗi rõ ràng, host vẫn sống', async () => {
  const dir = comboPluginDir();
  const host = await trackHost(createSandboxedPluginHost({ pluginDir: dir }));
  await assert.rejects(
    () => host.callTool('khong-co-tool-nay', {}),
    /không có tool "khong-co-tool-nay"/,
  );
  assert.equal(await host.callTool('echo', { text: 'van-song' }), 'van-song');
  assert.deepEqual(await host.ping(), { pong: true });
});

// ---------------------------------------------------------------------------
// max-old-space-size is passed to the child
// ---------------------------------------------------------------------------

test('sandbox: max-old-space-size được truyền đúng cho child (heap limit theo cấu hình)', async () => {
  const dir = comboPluginDir();
  const small = await trackHost(
    createSandboxedPluginHost({ pluginDir: dir, maxOldSpaceMb: 256 }),
  );
  const big = await trackHost(
    createSandboxedPluginHost({ pluginDir: dir, maxOldSpaceMb: 512 }),
  );
  await small.callTool('echo', { text: 'warmup' });
  await big.callTool('echo', { text: 'warmup' });

  const smallHeap = small.getStatus().heapSizeLimitMb;
  const bigHeap = big.getStatus().heapSizeLimitMb;
  assert.equal(typeof smallHeap, 'number');
  assert.equal(typeof bigHeap, 'number');
  // 256MB config -> heap limit quanh 256MB (cho sai số V8); 512MB phải lớn hơn hẳn.
  assert.ok(smallHeap >= 128 && smallHeap <= 512, `heap 256MB config: got ${smallHeap}MB`);
  assert.ok(bigHeap > smallHeap, `heap 512MB (${bigHeap}) phải lớn hơn heap 256MB (${smallHeap})`);
  assert.equal(small.getStatus().maxOldSpaceMb, 256);
  assert.equal(big.getStatus().maxOldSpaceMb, 512);
});

// ---------------------------------------------------------------------------
// stderr capture (100KB cap) + onChildStderr
// ---------------------------------------------------------------------------

test('sandbox: stderr của child được capture và đẩy qua onChildStderr', async () => {
  const dir = comboPluginDir();
  const chunks = [];
  const host = await trackHost(
    createSandboxedPluginHost({ pluginDir: dir, onChildStderr: (c) => chunks.push(c) }),
  );
  assert.equal(await host.callTool('noisy', {}), 'ok-noisy');
  await waitFor(() => chunks.join('').includes('canh-bao-tu-plugin'));
  assert.match(host.getStderrLog(), /canh-bao-tu-plugin/);
  assert.ok(host.getStatus().stderrChars > 0);
});

test('sandbox: stderr capture giới hạn 100KB (flood 150KB bị cắt)', async () => {
  const dir = comboPluginDir();
  const host = await trackHost(createSandboxedPluginHost({ pluginDir: dir }));
  assert.equal(await host.callTool('flood', {}), 'ok-flood');
  await waitFor(() => host.getStatus().stderrChars >= 100 * 1024, { timeoutMs: 5_000 });
  assert.ok(
    host.getStderrLog().length <= 100 * 1024,
    `stderr log phải <= 100KB, got ${host.getStderrLog().length}`,
  );
});

// ---------------------------------------------------------------------------
// Timeout kill + restart
// ---------------------------------------------------------------------------

test('sandbox: tool treo quá timeout thì SIGKILL child, báo lỗi tiếng Việt, host restart và chạy lại được', async () => {
  const dir = comboPluginDir();
  const host = await trackHost(
    createSandboxedPluginHost({ pluginDir: dir, callTimeoutMs: 1000 }),
  );
  await assert.rejects(
    () => host.callTool('hang', {}),
    /quá thời gian 1000ms/,
  );
  // Sau timeout host tự restart: echo chạy lại bình thường. (v0.72c:
  // timeout chỉ tính từ lúc worker ready nên call này không bị trừ thời
  // gian chờ restart — xem thêm test "khởi động chậm" bên dưới.)
  assert.equal(await host.callTool('echo', { text: 'sau-restart' }), 'sau-restart');
  assert.ok(host.getStatus().restarts >= 1, 'phải restart ít nhất 1 lần sau timeout kill');
  assert.equal(host.getStatus().status, 'running');
});

test('sandbox: callTimeoutMs không tính thời gian chờ worker khởi động (khởi động chậm không bị reject oan)', async () => {
  // Plugin ngủ 800ms ở top-level lúc tải (require chặn) nên worker chỉ
  // gửi ready sau ~800ms. Với callTimeoutMs=300ms, code cũ sẽ reject
  // oan ở 300ms với lỗi "đã SIGKILL" dù child chưa hề bị kill (timer
  // chạy từ lúc tạo request, lúc worker chưa ready); code mới chỉ tính
  // timeout từ lúc request đã gửi tới worker ready nên echo vẫn chạy
  // được và không restart oan.
  const slowJs = `
    const end = Date.now() + 800;
    while (Date.now() < end) { /* chặn lúc tải để worker ready chậm */ }
    module.exports = { tools: [{ definition: { name: 'echo', description: 'Echo.', parameters: { type: 'object', properties: { text: { type: 'string' } } } }, needsApproval: false, execute: async (args) => args.text }] };
  `;
  const dir = writePlugin(
    path.join(makeTempDir(), 'slow-plugin'),
    { id: 'slow-plugin', name: 'Slow', version: '1.0.0', description: 'Slow start.', permissions: [], main: 'index.js', tools: ['echo'] },
    slowJs,
  );
  const host = await trackHost(
    createSandboxedPluginHost({ pluginDir: dir, callTimeoutMs: 300 }),
  );
  assert.equal(await host.callTool('echo', { text: 'slow-start' }), 'slow-start');
  assert.equal(host.getStatus().restarts, 0, 'không được restart oan khi worker chỉ khởi động chậm');
  assert.equal(host.getStatus().status, 'running');
});

// ---------------------------------------------------------------------------
// Restart cap: 3 restarts then dead
// ---------------------------------------------------------------------------

test('sandbox: crash liên tiếp quá 3 lần restart thì dead, call sau báo lỗi rõ ràng, host không crash', async () => {
  const dir = comboPluginDir();
  const host = await trackHost(createSandboxedPluginHost({ pluginDir: dir }));
  assert.equal(await host.callTool('echo', { text: 'truoc-khi-chet' }), 'truoc-khi-chet');

  // Giết child 4 lần: 3 lần đầu restart (backoff 200ms/1s/3s), lần 4 -> dead.
  for (let i = 0; i < 4; i++) {
    const pid = await waitFor(() => {
      const s = host.getStatus();
      return s.status === 'running' && typeof s.pid === 'number' ? s.pid : null;
    }, { timeoutMs: 15_000 });
    process.kill(pid, 'SIGKILL');
    if (i < 3) {
      await waitFor(() => host.getStatus().restarts === i + 1, { timeoutMs: 15_000 });
    }
  }
  await waitFor(() => host.getStatus().status === 'dead', { timeoutMs: 15_000 });
  assert.equal(host.getStatus().restarts, 3, 'restart tối đa 3 lần');
  await assert.rejects(() => host.callTool('echo', { text: 'x' }), /đã chết sau 3 lần/);
  await assert.rejects(() => host.ping(), /đã chết/);
  // Host process (test process) vẫn sống: gọi tool ở host khác vẫn được.
  assert.equal(await host.callTool('echo', { text: 'x' }).catch((e) => e.message.includes('đã chết') ? 'host-van-song' : 'LA'), 'host-van-song');
});

test('sandbox: plugin không tải được thì restart tối đa 3 lần rồi dead (không crash host)', async () => {
  const badDir = makeTempDir();
  fs.writeFileSync(
    path.join(badDir, 'manifest.json'),
    JSON.stringify({
      id: 'bad-plugin', name: 'Bad', version: '1.0.0',
      description: 'Entry file missing.', permissions: [], main: 'khong-co.js',
    }),
    'utf8',
  );
  const host = await trackHost(createSandboxedPluginHost({ pluginDir: badDir }));
  // Trần 60s (không phải 20s): mỗi chu trình restart tốn 1 lần spawn
  // worker (fork node + tải worker) — dưới tải nặng mỗi lần spawn có
  // thể tốn vài giây, 4 chu trình (lần đầu + 3 restart) có thể vượt
  // 20s dù host vẫn restart đúng và chết đúng sau 3 lần. Hành vi được
  // assert (tối đa 3 restart rồi dead) không đổi, chỉ nới trần chờ.
  await waitFor(() => host.getStatus().status === 'dead', { timeoutMs: 60_000 });
  assert.ok(host.getStatus().restarts <= 3);
  await assert.rejects(() => host.callTool('echo', {}), /đã chết/);
});

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

test('sandbox: dispose kill child và dọn dẹp (gọi 2 lần vẫn an toàn)', async () => {
  const dir = comboPluginDir();
  const host = await trackHost(createSandboxedPluginHost({ pluginDir: dir }));
  assert.equal(await host.callTool('echo', { text: 'truoc-dispose' }), 'truoc-dispose');
  const pid = host.getStatus().pid;
  assert.equal(typeof pid, 'number');

  await host.dispose();
  await host.dispose(); // second dispose is safe
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, { timeoutMs: 5_000 });
  assert.equal(host.getStatus().status, 'dead');
  await assert.rejects(() => host.callTool('echo', { text: 'x' }), /dispose/);
});

// ---------------------------------------------------------------------------
// v0.15 (H1 audit): worker không kế thừa secret env của app
// ---------------------------------------------------------------------------

test('sandbox v0.15 (H1): plugin worker chỉ nhận env đã lọc — secret của app không lọt qua', async () => {
  const secretName = 'OPEN_BOT_TEST_SECRET_KEY';
  const secretValue = 'sk-test-khong-duoc-lo';
  const prev = process.env[secretName];
  process.env[secretName] = secretValue;
  try {
    const dir = writePlugin(
      path.join(makeTempDir(), 'env-plugin'),
      {
        id: 'env-plugin',
        name: 'Env Plugin',
        version: '1.0.0',
        description: 'Đọc env để test lọc secret.',
        permissions: [],
        main: 'index.js',
        tools: ['env_probe'],
      },
      `
const probeTool = {
  definition: {
    name: 'env_probe',
    description: 'Trả về secret test + PATH có mặt hay không.',
    parameters: { type: 'object', properties: {} },
  },
  needsApproval: false,
  execute: async () => JSON.stringify({
    secret: process.env.${secretName} ?? null,
    pathPresent: typeof process.env.PATH === 'string' && process.env.PATH.length > 0,
  }),
};
module.exports = { tools: [probeTool] };
`,
    );
    const host = await trackHost(createSandboxedPluginHost({ pluginDir: dir }));
    const out = await host.callTool('env_probe', {});
    const parsed = JSON.parse(out);
    assert.equal(parsed.secret, null, 'secret env của app không được lọt vào worker');
    assert.equal(parsed.pathPresent, true, 'PATH (allowlist) vẫn phải có để plugin chạy được');
  } finally {
    if (prev === undefined) delete process.env[secretName];
    else process.env[secretName] = prev;
  }
});

// ---------------------------------------------------------------------------
// Kill cả cây tiến trình (finding M3, audit v0.15) — rà soát đa nền tảng
// Trước đây worker fork không detached và killChild chỉ kill trực tiếp
// nên tiến trình cháu của plugin sống sót sau dispose/timeout. Nay
// worker fork detached (POSIX) + killChild dùng killProcessGroupOfChild
// (group kill / taskkill /T trên Windows) nên cả cây phải chết.
// ---------------------------------------------------------------------------

const SPAWN_GRANDCHILD_JS = `
const spawnGrandchildTool = {
  definition: {
    name: 'spawn_grandchild',
    description: 'Spawn a long-lived child and record its pid.',
    parameters: {
      type: 'object',
      properties: { pidFile: { type: 'string', description: 'Where to write the child pid.' } },
      required: ['pidFile'],
    },
  },
  needsApproval: false,
  execute: async (args) => {
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const g = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
    fs.writeFileSync(args.pidFile, String(g.pid));
    return 'spawned ' + g.pid;
  },
};
module.exports = { tools: [spawnGrandchildTool] };
`;

function grandchildPluginDir() {
  return writePlugin(
    path.join(makeTempDir(), 'grandchild-plugin'),
    {
      id: 'grandchild-plugin',
      name: 'Grandchild Plugin',
      version: '1.0.0',
      description: 'Spawns a grandchild for kill-tree tests.',
      // Plugin dùng fs.writeFileSync (ghi pid cháu) + child_process.spawn
      // nên manifest phải khai đủ quyền — loader quét source và từ chối
      // plugin thiếu quyền (không liên quan tới sandbox kill).
      permissions: ['fs', 'shell'],
      main: 'index.js',
      tools: ['spawn_grandchild'],
    },
    SPAWN_GRANDCHILD_JS,
  );
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

test('sandbox: dispose kill cả cây — tiến trình cháu của plugin cũng chết (M3)', async () => {
  const dir = grandchildPluginDir();
  const host = await trackHost(createSandboxedPluginHost({ pluginDir: dir }));
  const pidFile = path.join(makeTempDir(), 'grandchild.pid');
  const out = await host.callTool('spawn_grandchild', { pidFile });
  const grandchildPid = Number.parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, `pid cháu: ${out}`);
  assert.equal(isAlive(grandchildPid), true, 'cháu phải đang sống trước dispose');
  const workerPid = host.getStatus().pid;
  assert.ok(typeof workerPid === 'number' && workerPid > 0);

  await host.dispose();

  // Worker chết rồi thì cháu trong cùng process group (POSIX, worker
  // fork detached nên là group leader) / cây taskkill /T (Windows)
  // cũng phải chết theo.
  await waitFor(() => !isAlive(grandchildPid));
  assert.equal(isAlive(grandchildPid), false, 'cháu phải chết sau dispose');
  assert.equal(isAlive(workerPid), false, 'worker phải chết sau dispose');
});
