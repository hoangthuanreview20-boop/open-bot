/**
 * Tests cho enforce egress trong VM (v0.78b) — `vmNetwork` của
 * BotComputer + `buildQemuBootArgs` nhận opts.network.
 *
 * Run sau khi build core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/computers-vm-network-v078.test.mjs
 *
 * Boot VM thật cần QEMU + image qcow2 của user (không có trên máy
 * này) nên mọi test dùng fake spawnFn bắt argv — kiểm chứng đúng
 * cờ `-nic` được truyền cho QEMU.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  BotComputerRuntime,
  buildQemuBootArgs,
  fakeMachineProfile,
  planComputers,
} from '../packages/core/dist/index.js';

const GB = 1024 ** 3;
const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-vmnet-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
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

/** Runtime VM với fake spawn bắt argv + image qcow2 giả trên đĩa. */
function makeVmRuntime() {
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
  return { runtime, spawnCalls };
}

function nicArg(args) {
  const i = args.indexOf('-nic');
  assert.notEqual(i, -1, 'argv QEMU phải có -nic');
  return args[i + 1];
}

// --- buildQemuBootArgs -------------------------------------------------------

test('vm-network v0.78: buildQemuBootArgs mặc định -nic none (fail-closed), nat -> -nic user', () => {
  const computer = { cpuCores: 2, ramBytes: 4 * GB };
  const def = buildQemuBootArgs('/data/vm.qcow2', computer, {});
  assert.equal(nicArg(def), 'none');
  const explicitNone = buildQemuBootArgs('/data/vm.qcow2', computer, { network: 'none' });
  assert.equal(nicArg(explicitNone), 'none');
  const nat = buildQemuBootArgs('/data/vm.qcow2', computer, { network: 'nat' });
  assert.equal(nicArg(nat), 'user');
  // Các cờ khác không đổi.
  assert.ok(nat.includes('-enable-kvm') === false);
  const kvm = buildQemuBootArgs('/data/vm.qcow2', computer, { enableKvm: true, network: 'nat' });
  assert.ok(kvm.includes('-enable-kvm'));
  assert.equal(nicArg(kvm), 'user');
});

// --- setVmNetwork + boot ------------------------------------------------------

test('vm-network v0.78: boot mặc định -nic none; setVmNetwork nat -> boot -nic user + statusView cảnh báo', async () => {
  const { runtime, spawnCalls } = makeVmRuntime();
  // Chưa đặt vmNetwork: bản ghi cũ cũng boot với -nic none.
  const started = await runtime.startComputer('vm1');
  assert.equal(started.state, 'running');
  assert.equal(spawnCalls.length, 1);
  assert.equal(nicArg(spawnCalls[0].args), 'none');
  let view = runtime.statusView('vm1');
  assert.equal(view?.vmNetworkWarning, undefined);
  // Đổi sang NAT: cần stop rồi boot lại mới có hiệu lực.
  await runtime.stopComputer('vm1');
  const updated = runtime.setVmNetwork('vm1', 'nat');
  assert.equal(updated.vmNetwork, 'nat');
  const restarted = await runtime.startComputer('vm1');
  assert.equal(restarted.state, 'running');
  assert.equal(spawnCalls.length, 2);
  assert.equal(nicArg(spawnCalls[1].args), 'user');
  view = runtime.statusView('vm1');
  assert.match(view?.vmNetworkWarning ?? '', /egress policy KHÔNG enforce/);
  // Đổi lại none: cảnh báo biến mất.
  await runtime.stopComputer('vm1');
  runtime.setVmNetwork('vm1', 'none');
  await runtime.startComputer('vm1');
  assert.equal(nicArg(spawnCalls[2].args), 'none');
  assert.equal(runtime.statusView('vm1')?.vmNetworkWarning, undefined);
});

test('vm-network v0.78: setVmNetwork từ chối máy không phải VM và giá trị lạ', () => {
  const rootDir = makeTempDir();
  const runtime = new BotComputerRuntime({ rootDir, backends: fakeBackends() });
  const plan = planComputers(fakeMachineProfile(), [{ botId: 'bot1' }], fakeBackends());
  runtime.createComputer(plan.allocations[0]);
  // bot1 trên máy giả mạnh được planner xếp mức VM, nhưng đổi allocation
  // sang box để kiểm tra nhánh "không phải VM".
  const boxRuntime = new BotComputerRuntime({
    rootDir: path.join(rootDir, 'box'),
    backends: fakeBackends(),
  });
  boxRuntime.createComputer({
    botId: 'box1',
    level: 'box',
    cpuCores: 1,
    ramBytes: 1 * GB,
    diskBytes: 2 * GB,
    backend: 'box',
    backendDetail: 'box',
    priority: 50,
  });
  assert.throws(() => boxRuntime.setVmNetwork('box1', 'nat'), /chỉ máy mức VM/);
  const { runtime: vmRuntime } = makeVmRuntime();
  assert.throws(
    () => (vmRuntime).setVmNetwork('vm1', 'bridged'),
    /không hợp lệ/,
  );
  assert.throws(() => vmRuntime.setVmNetwork('no-such-bot', 'nat'), /Không có máy-tính-bot/);
});
