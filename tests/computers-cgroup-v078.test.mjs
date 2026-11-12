/**
 * Tests cho enforce RAM vật lý bằng cgroup v2 (v0.78a) —
 * packages/core/src/compute/cgroup.ts + nối dây vào
 * BotComputerRuntime (hook spawn của BotBoxManager).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/computers-cgroup-v078.test.mjs
 *
 * Mọi test đều dùng cgroup root GIẢ (thư mục tạm đóng vai
 * /sys/fs/cgroup: file `cgroup.controllers` + các file `memory.*` /
 * `cgroup.procs` là file thường) — KHÔNG chạm cgroup thật của máy,
 * KHÔNG cần quyền root. Test cuối chỉ kiểm tra probe thật trả về kết
 * quả có dạng đúng (không assert available/unavailable — tuỳ máy).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  BotComputerRuntime,
  CGROUP_MIN_MEMORY_BYTES,
  CgroupMemoryLimiter,
  fakeMachineProfile,
  planComputers,
  probeCgroupMemory,
} from '../packages/core/dist/index.js';

const GB = 1024 ** 3;
const MB = 1024 * 1024;
const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-cgroup-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

/**
 * Dựng cgroup root giả: thư mục tạm với `cgroup.controllers` chứa
 * 'memory' (mặc định) + tuỳ chọn ghi đè. Các file `memory.*` /
 * `cgroup.procs` trong từng cgroup con là file thường do limiter tự
 * tạo khi ghi — giống hệt cgroupfs ở mức API file.
 */
function fakeCgroupRoot(controllers = 'cpu io memory pids') {
  const root = makeTempDir();
  fs.writeFileSync(path.join(root, 'cgroup.controllers'), controllers, 'utf8');
  return root;
}

function fakeBackends() {
  return [
    { kind: 'box', level: 'box', available: true, detail: 'box' },
    { kind: 'bwrap', level: 'container', available: false, detail: 'không có bwrap' },
    { kind: 'qemu', level: 'vm', available: false, detail: 'không có qemu' },
    { kind: 'wsl', level: 'vm', available: false, detail: 'không thấy WSL2' },
    { kind: 'hyperv', level: 'vm', available: false, detail: 'Hyper-V chưa bật' },
    { kind: 'macvm', level: 'vm', available: false, detail: 'không có Virtualization.framework' },
  ];
}

// --- probeCgroupMemory ------------------------------------------------------

test('cgroup v0.78: probe available khi controllers có memory + ghi được memory.max', () => {
  const root = fakeCgroupRoot();
  const probe = probeCgroupMemory({ cgroupRoot: root });
  assert.equal(probe.available, true);
  assert.equal(probe.reason, undefined);
  // Probe tự dọn cgroup thử của nó.
  assert.deepEqual(fs.readdirSync(root), ['cgroup.controllers']);
});

test('cgroup v0.78: probe unavailable khi controllers thiếu memory', () => {
  const root = fakeCgroupRoot('cpu io pids');
  const probe = probeCgroupMemory({ cgroupRoot: root });
  assert.equal(probe.available, false);
  assert.match(probe.reason ?? '', /memory/);
});

test('cgroup v0.78: probe unavailable khi không có thư mục cgroup', () => {
  const probe = probeCgroupMemory({ cgroupRoot: path.join(makeTempDir(), 'no-such-dir') });
  assert.equal(probe.available, false);
  assert.match(probe.reason ?? '', /Không có thư mục cgroup/);
});

test('cgroup v0.78: probe thật trên máy này trả kết quả có dạng đúng', () => {
  const probe = probeCgroupMemory();
  assert.equal(typeof probe.available, 'boolean');
  if (!probe.available) assert.ok((probe.reason ?? '').length > 0, 'unavailable phải kèm lý do');
  // Trên máy dev này (userns không delegate controller nào) probe
  // phải là unavailable — nhưng không assert cứng để test không vỡ
  // trên máy khác có delegate memory.
});

// --- CgroupMemoryLimiter (cgroup root giả) -----------------------------------

test('cgroup v0.78: limiter create ghi memory.max + swap.max, addPid ghi cgroup.procs, readUsage đọc current/peak', () => {
  const root = fakeCgroupRoot();
  const limiter = new CgroupMemoryLimiter({ cgroupRoot: root, name: 'open-bot-bot1' });
  limiter.create(512 * MB);
  assert.equal(limiter.created, true);
  const dir = path.join(root, 'open-bot-bot1');
  assert.equal(fs.readFileSync(path.join(dir, 'memory.max'), 'utf8'), String(512 * MB));
  assert.equal(fs.readFileSync(path.join(dir, 'memory.swap.max'), 'utf8'), '0');
  limiter.addPid(12345);
  assert.equal(fs.readFileSync(path.join(dir, 'cgroup.procs'), 'utf8'), '12345');
  // readUsage: chưa có file memory.current/peak -> null.
  assert.equal(limiter.readUsage(), null);
  fs.writeFileSync(path.join(dir, 'memory.current'), '1048576\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'memory.peak'), '2097152\n', 'utf8');
  assert.deepEqual(limiter.readUsage(), { currentBytes: 1048576, peakBytes: 2097152 });
  // setLimit đổi giới hạn.
  limiter.setLimit(256 * MB);
  assert.equal(fs.readFileSync(path.join(dir, 'memory.max'), 'utf8'), String(256 * MB));
  limiter.destroy();
  assert.equal(limiter.created, false);
  assert.equal(fs.existsSync(dir), false);
});

test('cgroup v0.78: limiter từ chối tên/giới hạn/pid không hợp lệ', () => {
  const root = fakeCgroupRoot();
  assert.throws(() => new CgroupMemoryLimiter({ cgroupRoot: root, name: '../x' }), /Invalid cgroup name/);
  assert.throws(() => new CgroupMemoryLimiter({ cgroupRoot: root, name: '' }), /Invalid cgroup name/);
  const limiter = new CgroupMemoryLimiter({ cgroupRoot: root, name: 'open-bot-bot1' });
  assert.throws(() => limiter.create(512), /Invalid memory limit/);
  assert.throws(() => limiter.create(0), /Invalid memory limit/);
  assert.throws(() => limiter.create(1024.5), /Invalid memory limit/);
  assert.throws(() => limiter.addPid(0), /Invalid pid/);
  assert.throws(() => limiter.addPid(-5), /Invalid pid/);
  // addPid trước khi create -> lỗi rõ (chưa có cgroup).
  assert.throws(() => limiter.addPid(123), /chưa được tạo/);
  assert.equal(CGROUP_MIN_MEMORY_BYTES, MB);
});

// --- Runtime: nối dây cgroup -------------------------------------------------

test('cgroup v0.78: runtime với cgroup khả dụng — create tạo limiter, statusView báo cgroup-v2, destroy dọn', async () => {
  const rootDir = makeTempDir();
  const cgroupRoot = fakeCgroupRoot();
  const warnings = [];
  const runtime = new BotComputerRuntime({
    rootDir,
    backends: fakeBackends(),
    cgroupRoot,
    logger: { warn: (m) => warnings.push(m) },
  });
  assert.deepEqual(runtime.getMemoryProbe(), { available: true });
  const plan = planComputers(fakeMachineProfile(), [{ botId: 'bot1' }], fakeBackends());
  assert.equal(plan.allocations.length, 1);
  const created = runtime.createComputer(plan.allocations[0]);
  assert.equal(created.level, 'box');
  const cgroupDir = path.join(cgroupRoot, 'open-bot-bot1');
  assert.ok(fs.existsSync(cgroupDir), 'limiter dir phải được tạo khi createComputer');
  assert.equal(
    fs.readFileSync(path.join(cgroupDir, 'memory.max'), 'utf8'),
    String(created.ramBytes),
    'memory.max phải bằng RAM đã cấp',
  );
  const view = runtime.statusView('bot1');
  assert.equal(view?.memoryEnforcement, 'cgroup-v2');
  assert.equal(view?.memoryEnforcementReason, undefined);
  assert.equal(view?.memoryUsageBytes, null);
  // start + chạy lệnh thật: hook spawn đưa pid vào cgroup.procs.
  await runtime.startComputer('bot1');
  const res = await runtime.runInComputer('bot1', '/bin/echo', ['hi-cgroup']);
  assert.match(res.stdout, /hi-cgroup/);
  const procs = fs.readFileSync(path.join(cgroupDir, 'cgroup.procs'), 'utf8').trim();
  assert.match(procs, /^\d+$/, `cgroup.procs phải ghi pid của process box (thấy: ${procs})`);
  // destroy dọn cả cgroup.
  assert.equal(await runtime.destroyComputer('bot1'), true);
  assert.equal(fs.existsSync(cgroupDir), false);
  assert.equal(warnings.length, 0, `không được warn gì: ${warnings.join('; ')}`);
});

test('cgroup v0.78: runtime với cgroup KHÔNG khả dụng — giữ prlimit, statusView báo rõ lý do', async () => {
  const rootDir = makeTempDir();
  const cgroupRoot = fakeCgroupRoot('cpu io pids'); // thiếu memory
  const warnings = [];
  const runtime = new BotComputerRuntime({
    rootDir,
    backends: fakeBackends(),
    cgroupRoot,
    logger: { warn: (m) => warnings.push(m) },
  });
  assert.equal(runtime.getMemoryProbe().available, false);
  const plan = planComputers(fakeMachineProfile(), [{ botId: 'bot1' }], fakeBackends());
  runtime.createComputer(plan.allocations[0]);
  const view = runtime.statusView('bot1');
  assert.equal(view?.memoryEnforcement, 'prlimit-only');
  assert.match(view?.memoryEnforcementReason ?? '', /memory/);
  assert.equal(view?.memoryUsageBytes, null);
  // Không có thư mục cgroup nào được tạo.
  assert.deepEqual(fs.readdirSync(cgroupRoot), ['cgroup.controllers']);
  // Lệnh vẫn chạy được (prlimit best-effort như trước).
  await runtime.startComputer('bot1');
  const res = await runtime.runInComputer('bot1', '/bin/echo', ['hi-nocgroup']);
  assert.match(res.stdout, /hi-nocgroup/);
  assert.ok(warnings.length >= 1, 'phải warn 1 lần lúc tạo runtime vì cgroup không khả dụng');
});

test('cgroup v0.78: VM không dùng cgroup — statusView báo prlimit-only với lý do QEMU -m', async () => {
  const rootDir = makeTempDir();
  const cgroupRoot = fakeCgroupRoot();
  const runtime = new BotComputerRuntime({
    rootDir,
    backends: fakeBackends(),
    cgroupRoot,
    logger: { warn: () => undefined },
  });
  // Ép allocation mức VM (planner trên máy giả yếu vẫn có thể chọn VM;
  // dùng thẳng allocation để không phụ thuộc planner).
  const created = runtime.createComputer({
    botId: 'vm1',
    level: 'vm',
    cpuCores: 2,
    ramBytes: 4 * GB,
    diskBytes: 10 * GB,
    backend: 'qemu',
    backendDetail: 'qemu',
    priority: 50,
  });
  assert.equal(created.level, 'vm');
  assert.equal(fs.existsSync(path.join(cgroupRoot, 'open-bot-vm1')), false);
  const view = runtime.statusView('vm1');
  assert.equal(view?.memoryEnforcement, 'prlimit-only');
  assert.match(view?.memoryEnforcementReason ?? '', /QEMU -m/);
});
