/**
 * Tests cho sóng B (đội platform) — máy tính riêng cho từng bot:
 * probe + planner + runtime (packages/core/src/compute/) và giới hạn
 * prlimit của box (packages/core/src/sandbox/).
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/computers-b-platform.test.mjs
 *
 * Probe dùng dữ liệu giả (ProbeDeps) — không phụ thuộc máy chạy test.
 * Planner là hàm thuần — không I/O. Runtime dùng thư mục tạm + fake
 * box manager / fake spawn cho VM; chỉ 1 test chạy lệnh thật trong box
 * (node -e) trên máy chạy test, dùng binary thật của Node.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  BotComputerRuntime,
  BotBoxManager,
  buildQemuBootArgs,
  commandAvailable,
  detectComputerBackends,
  fakeMachineProfile,
  isHostBusy,
  levelFeasible,
  planComputers,
  probeMachine,
  suggestShedOrder,
} from '../packages/core/dist/index.js';

const GB = 1024 ** 3;
const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-computers-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

// --- Dữ liệu giả cho probe -------------------------------------------------

const LINUX_CPUINFO = [
  'processor\t: 0',
  'vendor_id\t: GenuineIntel',
  'model name\t: Intel(R) Core(TM) i7-12700H',
  'cpu cores\t: 4',
  'flags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush dts acpi mmx fxsr sse sse2 ss ht tm pbe syscall nx pdpe1gb rdtscp lm constant_tsc art arch_perfmon pebs bts rep_good nopl xtopology nonstop_tsc cpuid aperfmperf tsc_known_freq pni pclmulqdq dtes64 monitor ds_cpl vmx est tm2 ssse3 sdbg fma cx16 xtpr pdcm pcid sse4_1 sse4_2 x2apic movbe popcnt tsc_deadline_timer aes xsave avx f16c rdrand lahf_lm abm 3dnowprefetch cpuid_fault epb invpcid_single pti ssbd ibrs ibpb stibp tpr_shadow vnmi flexpriority ept vpid ept_ad fsgsbase tsc_adjust bmi1 avx2 smep bmi2 erms invpcid mpx rdseed adx smap clflushopt intel_pt xsaveopt xsavec xgetbv1 xsaves dtherm ida arat pln pts hwp hwp_notify hwp_act_window hwp_epp md_clear flush_l1d',
  '',
].join('\n');

const LINUX_DF = [
  'Filesystem     1024-blocks      Used Available Capacity Mounted on',
  '/dev/sda1         524288000  209715200 314572800      40% /',
  'tmpfs              16384000         0  16384000       0% /dev/shm',
  '',
].join('\n');

function linuxProbeDeps(overrides = {}) {
  return {
    platform: 'linux',
    arch: 'x64',
    hostname: 'linux-test',
    osVersion: 'Ubuntu 24.04.1 LTS',
    osRelease: '6.8.0-31-generic',
    totalmem: 16 * GB,
    freemem: 12 * GB,
    cpus: [
      { model: 'Intel(R) Core(TM) i7-12700H', speed: 2700 },
      { model: 'Intel(R) Core(TM) i7-12700H', speed: 2700 },
      { model: 'Intel(R) Core(TM) i7-12700H', speed: 2700 },
      { model: 'Intel(R) Core(TM) i7-12700H', speed: 2700 },
      { model: 'Intel(R) Core(TM) i7-12700H', speed: 2700 },
      { model: 'Intel(R) Core(TM) i7-12700H', speed: 2700 },
      { model: 'Intel(R) Core(TM) i7-12700H', speed: 2700 },
      { model: 'Intel(R) Core(TM) i7-12700H', speed: 2700 },
    ],
    loadavg: [1.0, 0.8, 0.6],
    networkInterfaces: {
      lo: [{ address: '127.0.0.1', internal: true, family: 'IPv4' }],
      eth0: [{ address: '192.168.1.10', internal: false, family: 'IPv4' }],
    },
    readFile: (p) => (p === '/proc/cpuinfo' ? LINUX_CPUINFO : null),
    fileExists: (p) => p === '/dev/kvm',
    run: async (command, args) => {
      if (command === 'df') return { code: 0, stdout: LINUX_DF, stderr: '', timedOut: false };
      if (command === 'lspci') {
        return {
          code: 0,
          stdout: '00:02.0 "VGA compatible controller" "Intel Corporation" "Alder Lake-P GT2 [Iris Xe Graphics]"\n',
          stderr: '',
          timedOut: false,
        };
      }
      return { code: 1, stdout: '', stderr: 'command not found', timedOut: false };
    },
    ...overrides,
  };
}

// --- Probe -----------------------------------------------------------------

test('B-computers probe: Linux giả — CPU/RAM/đĩa/ảo hoá/GPU đọc đúng', async () => {
  const profile = await probeMachine(linuxProbeDeps());
  assert.equal(profile.os, 'linux');
  assert.equal(profile.osVersion, 'Ubuntu 24.04.1 LTS');
  assert.equal(profile.cpu.model, 'Intel(R) Core(TM) i7-12700H');
  assert.equal(profile.cpu.logicalCores, 8);
  assert.equal(profile.cpu.physicalCores, 4);
  assert.deepEqual(profile.cpu.virtualizationFlags, ['vmx']);
  assert.equal(profile.cpu.loadAvg1m, 1.0);
  assert.equal(profile.cpu.loadPerCore, 0.125);
  assert.equal(profile.memory.totalBytes, 16 * GB);
  assert.equal(profile.memory.freeBytes, 12 * GB);
  assert.equal(profile.memory.freeRatio, 0.75);
  assert.equal(profile.disks.length, 1);
  assert.equal(profile.disks[0].mount, '/');
  assert.equal(profile.disks[0].totalBytes, 524288000 * 1024);
  assert.equal(profile.disks[0].freeBytes, 314572800 * 1024);
  assert.equal(profile.virtualization.supported, true);
  assert.equal(profile.virtualization.kvmAvailable, true);
  assert.equal(profile.gpus.length, 1);
  assert.match(profile.gpus[0].model, /Iris Xe/);
  assert.equal(profile.network.interfaces.length, 2);
  assert.deepEqual(profile.warnings, []);
});

test('B-computers probe: không có flag ảo hoá/KVM thì supported=false + warning', async () => {
  const noVirtCpuinfo = LINUX_CPUINFO.replace(' vmx ', ' ').replace('vmx ', '');
  const profile = await probeMachine(
    linuxProbeDeps({
      readFile: (p) => (p === '/proc/cpuinfo' ? noVirtCpuinfo : null),
      fileExists: () => false,
    }),
  );
  assert.equal(profile.virtualization.supported, false);
  assert.equal(profile.virtualization.kvmAvailable, false);
  assert.ok(profile.warnings.some((w) => w.includes('ảo hoá')));
});

test('B-computers probe: macOS Apple Silicon — ảo hoá luôn có, không cần flag', async () => {
  const profile = await probeMachine({
    platform: 'darwin',
    arch: 'arm64',
    hostname: 'mac-test',
    osVersion: 'macOS 15.5',
    totalmem: 16 * GB,
    freemem: 8 * GB,
    cpus: [{ model: 'Apple M4', speed: 0 }],
    loadavg: [0.5, 0.4, 0.3],
    networkInterfaces: {},
    readFile: () => null,
    fileExists: () => false,
    run: async (command, args) => {
      if (command === 'sysctl' && args[1] === 'hw.physicalcpu') {
        return { code: 0, stdout: '10\n', stderr: '', timedOut: false };
      }
      if (command === 'df') {
        return {
          code: 0,
          stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s1s1 100000000 50000000 50000000 50% /\n',
          stderr: '',
          timedOut: false,
        };
      }
      if (command === 'system_profiler') {
        return { code: 0, stdout: 'Chipset Model: Apple M4\n', stderr: '', timedOut: false };
      }
      return { code: 1, stdout: '', stderr: '', timedOut: false };
    },
  });
  assert.equal(profile.cpu.physicalCores, 10);
  assert.deepEqual(profile.cpu.virtualizationFlags, ['apple-silicon']);
  assert.equal(profile.virtualization.supported, true);
  assert.equal(profile.virtualization.appleVirtualization, true);
  assert.equal(profile.gpus[0].model, 'Apple M4');
});

test('B-computers probe: Windows giả — core vật lý/Hyper-V/WSL/ổ đĩa/GPU qua powershell', async () => {
  const profile = await probeMachine({
    platform: 'win32',
    arch: 'x64',
    hostname: 'win-test',
    osVersion: 'Microsoft Windows 11 Pro',
    totalmem: 32 * GB,
    freemem: 20 * GB,
    cpus: Array.from({ length: 16 }, () => ({ model: 'AMD Ryzen 9 7945HX', speed: 2500 })),
    loadavg: [0, 0, 0],
    networkInterfaces: {},
    readFile: () => null,
    fileExists: () => false,
    run: async (command, args) => {
      if (command !== 'powershell' && command !== 'wsl') {
        return { code: 1, stdout: '', stderr: '', timedOut: false };
      }
      if (command === 'wsl') return { code: 0, stdout: 'Default Distribution: Ubuntu\n', stderr: '', timedOut: false };
      const script = args[args.length - 1] ?? '';
      if (script.includes('NumberOfCores')) return { code: 0, stdout: '8\r\n', stderr: '', timedOut: false };
      if (script.includes('VirtualizationFirmwareEnabled')) return { code: 0, stdout: 'True\r\n', stderr: '', timedOut: false };
      if (script.includes('Microsoft-Hyper-V')) return { code: 0, stdout: 'Enabled\r\n', stderr: '', timedOut: false };
      if (script.includes('Win32_LogicalDisk')) {
        return {
          code: 0,
          stdout: JSON.stringify([{ DeviceID: 'C:', FreeSpace: 200 * GB, Size: 500 * GB }]),
          stderr: '',
          timedOut: false,
        };
      }
      if (script.includes('Win32_VideoController')) {
        return { code: 0, stdout: 'NVIDIA GeForce RTX 4060\r\n', stderr: '', timedOut: false };
      }
      return { code: 1, stdout: '', stderr: '', timedOut: false };
    },
  });
  assert.equal(profile.cpu.physicalCores, 8);
  assert.deepEqual(profile.cpu.virtualizationFlags, ['vmx']);
  assert.equal(profile.cpu.loadAvg1m, null);
  assert.equal(profile.virtualization.supported, true);
  assert.equal(profile.virtualization.hyperVAvailable, true);
  assert.equal(profile.virtualization.wslAvailable, true);
  assert.equal(profile.disks[0].mount, 'C:');
  assert.equal(profile.disks[0].freeBytes, 200 * GB);
  assert.equal(profile.gpus[0].model, 'NVIDIA GeForce RTX 4060');
});

test('B-computers probe: mọi lệnh đều lỗi thì vẫn trả profile + warnings, không throw', async () => {
  const profile = await probeMachine({
    platform: 'linux',
    arch: 'x64',
    hostname: 'broken-test',
    totalmem: 8 * GB,
    freemem: 4 * GB,
    cpus: [{ model: 'Unknown CPU', speed: 0 }],
    loadavg: [0, 0, 0],
    networkInterfaces: {},
    readFile: () => null,
    fileExists: () => false,
    run: async () => ({ code: 1, stdout: '', stderr: 'boom', timedOut: false }),
  });
  assert.equal(profile.os, 'linux');
  assert.equal(profile.cpu.physicalCores, null);
  assert.deepEqual(profile.disks, []);
  assert.deepEqual(profile.gpus, []);
  assert.equal(profile.virtualization.supported, false);
  assert.ok(profile.warnings.length >= 2);
});

// --- Planner ---------------------------------------------------------------

const BACKENDS_STRONG = [
  { kind: 'box', level: 'box', available: true, detail: 'box' },
  { kind: 'bwrap', level: 'container', available: true, detail: 'bwrap' },
  { kind: 'qemu', level: 'vm', available: true, detail: 'qemu + KVM' },
];
const BACKENDS_BOX_ONLY = [{ kind: 'box', level: 'box', available: true, detail: 'box' }];

test('B-computers planner: máy mạnh — 2 bot auto đều được VM, headroom còn lại đúng', () => {
  const profile = fakeMachineProfile();
  const plan = planComputers(profile, [{ botId: 'a' }, { botId: 'b' }], BACKENDS_STRONG);
  assert.equal(plan.allocations.length, 2);
  for (const a of plan.allocations) {
    assert.equal(a.level, 'vm');
    assert.equal(a.backend, 'qemu');
    assert.equal(a.cpuCores, 2);
    assert.equal(a.ramBytes, 4 * GB);
    assert.equal(a.diskBytes, 10 * GB);
  }
  assert.deepEqual(plan.rejected, []);
  // CPU: 8 core - chừa max(2, 25%*8=2) = 2 -> còn 6; 2 VM x 2 core = còn 2.
  assert.equal(plan.hostHeadroom.cpuCores, 2);
  // RAM: trống 12GB - chừa max(2GB, 25%*16GB=4GB) = 4GB -> còn 8GB; 2 VM x 4GB = còn 0.
  assert.equal(plan.hostHeadroom.ramBytes, 0);
  assert.equal(plan.busy, false);
});

test('B-computers planner: máy yếu (2 core, 4GB) vẫn chạy được box — không cấp quá headroom', () => {
  const profile = fakeMachineProfile({
    cpu: { logicalCores: 2, physicalCores: 2, loadAvg1m: 0.2, loadPerCore: 0.1 },
    memory: { totalBytes: 4 * GB, freeBytes: 2 * GB, freeRatio: 0.5 },
    virtualization: { supported: false, kvmAvailable: false, detail: 'không hỗ trợ ảo hoá' },
  });
  const plan = planComputers(profile, [{ botId: 'weak' }], BACKENDS_BOX_ONLY);
  assert.equal(plan.allocations.length, 1);
  assert.equal(plan.allocations[0].level, 'box');
  assert.equal(plan.allocations[0].backend, 'box');
  assert.equal(plan.allocations[0].cpuCores, 0.5);
  assert.equal(plan.allocations[0].ramBytes, 512 * 1024 ** 2);
  assert.deepEqual(plan.rejected, []);
  assert.ok(plan.hostHeadroom.cpuCores >= 0);
  assert.ok(plan.hostHeadroom.ramBytes >= 0);
});

test('B-computers planner: xin VM trên máy không ảo hoá thì hạ mức + ghi downgradedFrom', () => {
  const profile = fakeMachineProfile({
    virtualization: { supported: false, kvmAvailable: false, detail: 'không hỗ trợ ảo hoá' },
  });
  const plan = planComputers(profile, [{ botId: 'x', level: 'vm' }], BACKENDS_STRONG);
  assert.equal(plan.allocations.length, 1);
  assert.equal(plan.allocations[0].level, 'container');
  assert.equal(plan.allocations[0].downgradedFrom, 'vm');
  assert.ok(plan.warnings.some((w) => w.includes('hạ mức vm -> container')));
});

test('B-computers planner: hết tài nguyên thì từ chối kèm lý do, không cấp quá', () => {
  const profile = fakeMachineProfile();
  const plan = planComputers(
    profile,
    [
      { botId: 'big', ramBytes: 100 * GB },
      { botId: 'ok1' },
      { botId: 'ok2' },
      { botId: 'ok3' },
    ],
    BACKENDS_STRONG,
    { maxComputers: 2 },
  );
  assert.equal(plan.allocations.length, 2);
  const rejectedBig = plan.rejected.find((r) => r.botId === 'big');
  assert.ok(rejectedBig);
  assert.equal(rejectedBig.reason, 'insufficient-resources');
  assert.ok(rejectedBig.reasonDetail?.includes('headroom'));
  const rejectedMax = plan.rejected.find((r) => r.botId === 'ok3');
  assert.ok(rejectedMax);
  assert.equal(rejectedMax.reason, 'too-many-computers');
});

test('B-computers planner: ưu tiên cao được cấp trước; isHostBusy theo tải/RAM', () => {
  const profile = fakeMachineProfile();
  const plan = planComputers(
    profile,
    [
      { botId: 'low', priority: 10 },
      { botId: 'high', priority: 90 },
    ],
    BACKENDS_STRONG,
    { maxComputers: 1 },
  );
  assert.equal(plan.allocations[0].botId, 'high');
  assert.equal(plan.rejected[0].botId, 'low');

  assert.equal(isHostBusy(fakeMachineProfile()).busy, false);
  assert.equal(isHostBusy(fakeMachineProfile({ cpu: { loadAvg1m: 7.2, loadPerCore: 0.9 } })).busy, true);
  assert.equal(
    isHostBusy(fakeMachineProfile({ cpu: { loadAvg1m: 7.2, loadPerCore: 0.9 } })).reason?.startsWith('cpu-load'),
    true,
  );
  assert.equal(isHostBusy(fakeMachineProfile({ memory: { freeRatio: 0.1 } })).busy, true);
  assert.equal(
    isHostBusy(fakeMachineProfile({ memory: { freeRatio: 0.1 } })).reason?.startsWith('low-memory'),
    true,
  );
});

test('B-computers planner: suggestShedOrder — ưu tiên thấp trước, hoà thì RAM lớn trước', () => {
  const bigProfile = fakeMachineProfile({
    memory: { totalBytes: 32 * GB, freeBytes: 20 * GB, freeRatio: 0.625 },
  });
  const plan = planComputers(
    bigProfile,
    [
      { botId: 'a', priority: 80, level: 'box', ramBytes: 1 * GB },
      { botId: 'b', priority: 10, level: 'box', ramBytes: 2 * GB },
      { botId: 'c', priority: 10, level: 'box', ramBytes: 8 * GB },
    ],
    BACKENDS_STRONG,
  );
  assert.equal(plan.allocations.length, 3);
  assert.deepEqual(suggestShedOrder(plan), ['c', 'b', 'a']);
});

test('B-computers planner: levelFeasible — box luôn được, VM cần ảo hoá + backend', () => {
  const profile = fakeMachineProfile();
  assert.equal(levelFeasible('box', profile, BACKENDS_BOX_ONLY).ok, true);
  assert.equal(levelFeasible('container', profile, BACKENDS_BOX_ONLY).ok, false);
  assert.equal(levelFeasible('container', profile, BACKENDS_STRONG).ok, true);
  assert.equal(levelFeasible('vm', profile, BACKENDS_STRONG).ok, true);
  assert.equal(
    levelFeasible('vm', fakeMachineProfile({ virtualization: { supported: false } }), BACKENDS_STRONG).ok,
    false,
  );
});

// --- Runtime ---------------------------------------------------------------

function fakeBackends() {
  return detectComputerBackends(fakeMachineProfile(), {
    commandAvailable: (cmd) => cmd === 'bwrap' || cmd === 'qemu-system-x86_64',
  });
}

test('B-computers runtime: detect backends — box luôn có, qemu/bwrap theo máy', () => {
  const backends = fakeBackends();
  const byKind = Object.fromEntries(backends.map((b) => [b.kind, b]));
  assert.equal(byKind['box'].available, true);
  assert.equal(byKind['bwrap'].available, true);
  assert.equal(byKind['qemu'].available, true);
  assert.equal(byKind['podman'].available, false);
  assert.ok(byKind['qemu'].detail.includes('KVM'));
});

test('B-computers runtime: buildQemuBootArgs — RAM đổi MB, core lấy nguyên, KVM theo máy', () => {
  const args = buildQemuBootArgs('/data/vm.qcow2', { cpuCores: 2, ramBytes: 4 * GB }, { enableKvm: true });
  assert.equal(args[0], 'qemu-system-x86_64');
  assert.deepEqual(args.slice(1, 5), ['-m', '4096', '-smp', '2']);
  assert.ok(args.includes('-enable-kvm'));
  assert.ok(args.some((a) => a.includes('file=/data/vm.qcow2,format=qcow2,if=virtio')));
  const noKvm = buildQemuBootArgs('/data/vm.qcow2', { cpuCores: 1.5, ramBytes: 3 * GB }, {});
  assert.ok(!noKvm.includes('-enable-kvm'));
  assert.ok(noKvm.includes('3072'));
  assert.ok(noKvm.includes('1'));
});

test('B-computers runtime: vòng đời box — tạo/start/chạy lệnh/pause/resume/stop/destroy', async () => {
  const rootDir = makeTempDir();
  const runtime = new BotComputerRuntime({ rootDir, backends: fakeBackends() });
  const plan = planComputers(fakeMachineProfile(), [{ botId: 'bot1' }], fakeBackends());
  assert.equal(plan.allocations.length, 1);
  const created = runtime.createComputer(plan.allocations[0]);
  assert.equal(created.id, 'computer-bot1');
  assert.equal(created.state, 'stopped');
  assert.equal(created.level, 'vm'); // planner chọn VM trên máy mạnh giả
  // Máy-tính-bot mức VM chưa có image thì start báo lỗi rõ ràng, không giả vờ boot.
  const vmStarted = await runtime.startComputer('bot1');
  assert.equal(vmStarted.state, 'error');
  assert.match(vmStarted.lastError ?? '', /disk image/);

  // Đổi sang box để chạy lệnh thật.
  const boxRuntime = new BotComputerRuntime({
    rootDir: path.join(rootDir, 'box-runtime'),
    backends: fakeBackends(),
  });
  const boxPlan = planComputers(
    fakeMachineProfile({ virtualization: { supported: false, kvmAvailable: false } }),
    [{ botId: 'bot2' }],
    fakeBackends(),
  );
  const boxCreated = boxRuntime.createComputer(boxPlan.allocations[0]);
  assert.equal(boxCreated.level, 'container');
  const started = await boxRuntime.startComputer('bot2');
  assert.equal(started.state, 'running');
  assert.ok(started.diskUsedBytes !== null && started.diskUsedBytes >= 0);

  // Chạy lệnh thật trong máy-tính-bot (/bin/echo — nhẹ, không cần nhiều
  // bộ nhớ ảo; bwrap bind /bin nên thấy được).
  const result = await boxRuntime.runInComputer('bot2', '/bin/echo', ['hi-computer']);
  assert.match(result.stdout, /hi-computer/);
  assert.equal(result.exitCode, 0);
  assert.ok(result.limitsApplied);
  // Container 1 core x timeout 120s -> cpuSeconds = 120.
  assert.equal(result.limitsApplied.cpuSeconds, 120);
  // --as floor 4GB (máy cấp 1GB RAM nhưng Node cần ≥4GB địa chỉ ảo).
  assert.equal(result.limitsApplied.maxMemoryBytes, 4 * GB);
  assert.equal(result.limitsApplied.maxProcesses, 256);
  // prlimit chỉ enforce khi backend thật sự chạy. Lúc máy tải nặng,
  // backend có thể lỗi setup nhất thời (vd bwrap không tạo được
  // namespace) → runInBox thử lại rồi fallback chạy thường: khi đó
  // enforced=false + reason ghi rõ backend lỗi, stdout vẫn đủ.
  // Không được assert enforced=true mù — đó chính là flake đã gặp ở
  // full suite (bwrap exit 1, stdout rỗng, trước khi có retry/fallback).
  if (result.isolation.kind === 'none') {
    assert.equal(result.limitsApplied.enforced, false);
    assert.match(result.limitsApplied.reason ?? '', /backend/);
    assert.match(result.isolation.warning ?? '', /fallback/);
  } else {
    assert.equal(result.limitsApplied.enforced, commandAvailable('prlimit'));
    if (!result.limitsApplied.enforced) {
      assert.ok((result.limitsApplied.reason ?? '').includes('prlimit'));
    }
  }

  // Pause chặn lệnh mới; resume mở lại; stop dừng hẳn.
  boxRuntime.pauseComputer('bot2');
  assert.equal(boxRuntime.getComputer('bot2')?.state, 'paused');
  await assert.rejects(() => boxRuntime.runInComputer('bot2', process.execPath, ['-e', '1']), /paused/);
  boxRuntime.resumeComputer('bot2');
  assert.equal(boxRuntime.getComputer('bot2')?.state, 'running');
  const stopped = await boxRuntime.stopComputer('bot2');
  assert.equal(stopped.state, 'stopped');
  await assert.rejects(() => boxRuntime.runInComputer('bot2', process.execPath, ['-e', '1']), /stopped/);

  // Bền vững: runtime mới đọc lại computers.json; máy đang stopped giữ nguyên.
  const reloaded = new BotComputerRuntime({ rootDir: path.join(rootDir, 'box-runtime') });
  assert.equal(reloaded.getComputer('bot2')?.state, 'stopped');
  assert.equal(reloaded.getComputer('bot2')?.level, 'container');

  assert.equal(await boxRuntime.destroyComputer('bot2'), true);
  assert.equal(boxRuntime.getComputer('bot2'), undefined);
  assert.equal(await boxRuntime.destroyComputer('bot2'), false);
});

test('B-computers runtime: VM boot với image + fake spawn — argv QEMU đúng, pid được ghi', async () => {
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
  assert.equal(started.pid, 4242);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'qemu-system-x86_64');
  assert.ok(spawnCalls[0].args.includes('4096'));
  assert.ok(spawnCalls[0].args.includes('-enable-kvm'));
  assert.ok(spawnCalls[0].args.some((a) => a.includes(imagePath)));
  // Chạy lệnh trong VM chưa hỗ trợ — phải throw rõ ràng, không chạy trên host.
  await assert.rejects(
    () => runtime.runInComputer('vm1', process.execPath, ['-e', '1']),
    /guest agent/,
  );
  // Pause VM có pid: SIGSTOP (pid giả 4242 không tồn tại -> ESRCH -> stopped).
  const paused = runtime.pauseComputer('vm1');
  assert.ok(['paused', 'stopped'].includes(paused.state));
});

test('B-computers runtime: statusView hạ mức container xuống box khi máy không có namespace', () => {
  const rootDir = makeTempDir();
  // Fake box manager: box báo isolation 'none' (máy không có bwrap/unshare).
  const fakeBox = {
    id: 'box-fake-1',
    botId: 'c1',
    dir: path.join(rootDir, 'boxes', 'c1'),
    workspaceDir: path.join(rootDir, 'boxes', 'c1', 'workspace'),
    authDir: path.join(rootDir, 'boxes', 'c1', 'auth'),
    envAllowlist: [],
    limits: {},
    resetPerTurn: false,
    isolation: 'none',
    status: 'active',
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
  };
  fs.mkdirSync(fakeBox.workspaceDir, { recursive: true });
  const fakeManager = {
    createBox: () => fakeBox,
    getBox: () => fakeBox,
    destroyBox: () => true,
    runInBox: async () => {
      throw new Error('fake runInBox không dùng trong test này');
    },
  };
  const runtime = new BotComputerRuntime({
    rootDir,
    boxManager: fakeManager,
    backends: fakeBackends(),
  });
  runtime.createComputer({
    botId: 'c1',
    level: 'container',
    cpuCores: 1,
    ramBytes: 1 * GB,
    diskBytes: 2 * GB,
    backend: 'bwrap',
    backendDetail: 'bwrap (giả)',
    priority: 50,
  });
  const view = runtime.statusView('c1');
  assert.ok(view);
  assert.equal(view.effectiveLevel, 'box');
  assert.match(view.levelWarning ?? '', /không namespace|box thường/);
});

test('B-computers runtime: shedIfBusy tạm dừng máy ưu tiên thấp khi host bận', async () => {
  const rootDir = makeTempDir();
  const runtime = new BotComputerRuntime({ rootDir, backends: fakeBackends() });
  const plan = planComputers(
    fakeMachineProfile({ virtualization: { supported: false, kvmAvailable: false } }),
    [
      { botId: 'low', priority: 10 },
      { botId: 'high', priority: 90 },
    ],
    fakeBackends(),
  );
  for (const alloc of plan.allocations) {
    runtime.createComputer(alloc);
    await runtime.startComputer(alloc.botId);
  }
  // Host không bận -> không dừng máy nào.
  assert.deepEqual(await runtime.shedIfBusy(fakeMachineProfile()), []);
  // Host bận (tải cao) -> dừng máy ưu tiên thấp trước.
  const busyProfile = fakeMachineProfile({ cpu: { loadAvg1m: 7.2, loadPerCore: 0.9 } });
  const paused = await runtime.shedIfBusy(busyProfile);
  assert.deepEqual(paused, ['low', 'high']);
  assert.equal(runtime.getComputer('low')?.state, 'paused');
  assert.equal(runtime.getComputer('high')?.state, 'paused');
});

test('B-computers sandbox: spawn backend lỗi thì fallback chạy thường vẫn trả đủ stdout (race close)', async () => {
  // Hồi quy cho race trong BotBoxManager.runInBox: khi spawn backend lỗi
  // (vd hết tài nguyên lúc fork) và đã fallback sang tiến trình khác,
  // tiến trình cũ đóng lại không được kết thúc sớm bằng stdout rỗng —
  // fallback chưa kịp chạy đã finish. Test ép backend bwrap: máy không
  // có bwrap thì spawn lỗi -> fallback; máy có bwrap thì lệnh chạy
  // trong bwrap — cả hai đường đều phải in ra.
  const rootDir = makeTempDir();
  const manager = new BotBoxManager({ rootDir });
  manager.createBox('racebot', { isolation: 'bwrap' });
  const result = await manager.runInBox('racebot', '/bin/echo', ['hi-fallback']);
  assert.match(result.stdout, /hi-fallback/);
  assert.equal(result.exitCode, 0);
  if (result.isolation.kind === 'none') {
    assert.equal(result.isolation.isolated, false);
    assert.ok((result.isolation.warning ?? '').includes('fallback'));
  } else {
    assert.equal(result.isolation.kind, 'bwrap');
  }
});

test('B-computers sandbox: backend chạy nhưng lỗi setup (bwrap không tạo được namespace) thì thử lại rồi fallback chạy thường', async () => {
  // Hồi quy cho lỗi thật gặp ở full suite: bwrap ĐÃ CÓ trên máy nhưng
  // lúc tải nặng không tạo được namespace
  // ("bwrap: Creating new namespace failed: Resource temporarily
  // unavailable", exit 1, stdout rỗng). Spawn thành công nên đường
  // fallback spawn-lỗi không kích hoạt — runInBox phải nhận ra lỗi
  // setup qua stderr, thử lại cùng backend một lần, rồi fallback chạy
  // thường (ghi rõ, không giả vờ đã cách ly).
  // Fake bwrap: --version thì báo có (để detect nhận), còn lại in lỗi
  // setup thật rồi exit 1 (tool chưa hề chạy).
  const binDir = makeTempDir();
  const fakeBwrap = path.join(binDir, 'bwrap');
  fs.writeFileSync(
    fakeBwrap,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "bubblewrap 0.9.0"; exit 0; fi\necho "bwrap: Creating new namespace failed: Resource temporarily unavailable" >&2\nexit 1\n',
    'utf8',
  );
  fs.chmodSync(fakeBwrap, 0o755);
  const realPath = process.env.PATH ?? '';
  process.env.PATH = `${binDir}:${realPath}`;
  try {
    const rootDir = makeTempDir();
    const manager = new BotBoxManager({ rootDir });
    // Ép isolation bwrap + có giới hạn (để prlimit bọc như máy-tính-bot thật).
    manager.createBox('setupfail', {
      isolation: 'bwrap',
      limits: { cpuSeconds: 120, maxMemoryBytes: 4 * GB, maxProcesses: 256 },
    });
    const result = await manager.runInBox('setupfail', '/bin/echo', ['hi-fallback2']);
    assert.match(result.stdout, /hi-fallback2/);
    assert.equal(result.exitCode, 0);
    // Fallback chạy thường, ghi rõ — không giả vờ đã cách ly.
    assert.equal(result.isolation.kind, 'none');
    assert.equal(result.isolation.isolated, false);
    assert.match(result.isolation.warning ?? '', /fallback/);
    // prlimit không còn áp dụng sau fallback; stderr vẫn giữ dòng lỗi
    // setup để chẩn đoán (không xoá bằng chứng).
    assert.equal(result.limitsApplied?.enforced, false);
    assert.match(result.stderr, /Creating new namespace failed/);
  } finally {
    process.env.PATH = realPath;
  }
});

test('B-computers runtime: createComputer botId xấu thì throw; VM cần image mới set được', async () => {
  const rootDir = makeTempDir();
  const runtime = new BotComputerRuntime({ rootDir, backends: fakeBackends() });
  assert.throws(
    () =>
      runtime.createComputer({
        botId: '../evil',
        level: 'box',
        cpuCores: 0.5,
        ramBytes: 512 * 1024 ** 2,
        diskBytes: 1 * GB,
        backend: 'box',
        backendDetail: 'box',
        priority: 50,
      }),
    /Invalid botId/,
  );
  const plan = planComputers(
    fakeMachineProfile({ virtualization: { supported: false, kvmAvailable: false } }),
    [{ botId: 'boxy' }],
    fakeBackends(),
  );
  runtime.createComputer(plan.allocations[0]);
  assert.throws(() => runtime.setVmImage('boxy', '/tmp/x.qcow2'), /chỉ máy mức VM/);
  await assert.rejects(() => runtime.startComputer('nope'), /Không có máy-tính-bot/);
});
