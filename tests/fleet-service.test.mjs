/**
 * Fleet service tests: vòng đời service thật (spawn worker thật),
 * token bắt buộc, port xung đột, tự restart tối đa 3 lần.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { FleetServiceManager } from '../packages/core/dist/fleet/service.js';

function randomPort() {
  return 18000 + Math.floor(Math.random() * 900);
}

function ws(overrides = {}) {
  return {
    id: `fw-${Math.random().toString(36).slice(2, 8)}`,
    name: 'alice',
    osUser: 'alice',
    serviceName: 'open-bot-alice',
    port: randomPort(),
    rootDir: path.join(os.tmpdir(), 'fleet-ws-test'),
    cpuCores: 1,
    ramBytes: 512 * 1024 ** 2,
    diskBytes: 10 * 1024 ** 3,
    members: [],
    status: 'active',
    serviceState: 'stopped',
    isolationLevel: 'directory',
    createdBy: 'root',
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z',
    ...overrides,
  };
}

function rawGet(port, pathName, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method: 'GET', headers, timeout: 2000 }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function waitFor(predicate, timeoutMs = 15000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

test('service: start thật → health → stop, start 2 lần idempotent', async () => {
  const manager = new FleetServiceManager();
  const workspace = ws();
  try {
    assert.deepEqual(manager.status(workspace.id), { workspaceId: workspace.id, state: 'stopped', restarts: 0 });
    const started = await manager.start(workspace);
    assert.equal(started.state, 'running');
    assert.ok(typeof started.pid === 'number' && started.pid > 0);
    const again = await manager.start(workspace);
    assert.equal(again.pid, started.pid);
    assert.equal(again.state, 'running');
    const health = await manager.health(workspace);
    assert.equal(health.pid, started.pid);
    assert.ok(health.uptimeMs >= 0);
    assert.equal(manager.isRunning(workspace.id), true);
    const stopped = await manager.stop(workspace.id);
    assert.equal(stopped.state, 'stopped');
    assert.equal(manager.isRunning(workspace.id), false);
    await assert.rejects(() => manager.health(workspace), /không chạy/);
    // stop idempotent.
    assert.equal((await manager.stop(workspace.id)).state, 'stopped');
  } finally {
    await manager.dispose();
  }
});

test('service: /health không token → 401, token sai → 401, route khác → 404', async () => {
  const manager = new FleetServiceManager();
  const workspace = ws();
  try {
    await manager.start(workspace);
    assert.equal(await rawGet(workspace.port, '/health'), 401);
    assert.equal(await rawGet(workspace.port, '/health', { authorization: 'Bearer sai-token' }), 401);
    assert.equal(await rawGet(workspace.port, '/other'), 404);
  } finally {
    await manager.dispose();
  }
});

test('service: restart đổi pid, token cũ hết hiệu lực', async () => {
  const manager = new FleetServiceManager();
  const workspace = ws();
  try {
    const first = await manager.start(workspace);
    const second = await manager.restart(workspace);
    assert.equal(second.state, 'running');
    assert.notEqual(second.pid, first.pid);
    assert.equal(manager.status(workspace.id).restarts, 0);
    await manager.stop(workspace.id);
  } finally {
    await manager.dispose();
  }
});

test('service: port bị chiếm → start throw kèm lý do, không tự restart', async () => {
  const port = randomPort();
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(port, '127.0.0.1', resolve));
  const manager = new FleetServiceManager();
  const workspace = ws({ port });
  try {
    await assert.rejects(() => manager.start(workspace), /thoát sớm|không ready/);
    assert.equal(manager.status(workspace.id).state, 'error');
    // Không tự restart khi start chưa từng thành công.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(manager.status(workspace.id).restarts, 0);
  } finally {
    blocker.close();
    await manager.dispose();
  }
});

test('service: worker chết bất ngờ → tự restart đúng 3 lần rồi state error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-dying-worker-'));
  const workerPath = path.join(dir, 'dying-worker.mjs');
  fs.writeFileSync(
    workerPath,
    `import http from 'node:http';
const port = Number(process.argv[3]);
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, uptimeMs: 1, pid: process.pid })); }
  else { res.writeHead(404); res.end(); }
});
server.listen(port, '127.0.0.1', () => setTimeout(() => process.exit(0), 250));
`,
    'utf8',
  );
  const manager = new FleetServiceManager({ workerPath });
  const workspace = ws();
  try {
    const started = await manager.start(workspace);
    assert.equal(started.state, 'running');
    // Chuỗi: chết sau ~250ms, restart backoff 200/1000/3000ms → hết 3 lần
    // trong ~5s; chờ tới khi state 'error' với restarts === 3.
    const reached = await waitFor(() => {
      const s = manager.status(workspace.id);
      return s.state === 'error' && s.restarts === 3;
    }, 20000);
    assert.equal(reached, true, `status cuối: ${JSON.stringify(manager.status(workspace.id))}`);
    assert.match(manager.status(workspace.id).lastError ?? '', /thoát bất ngờ/);
  } finally {
    await manager.dispose();
  }
});
