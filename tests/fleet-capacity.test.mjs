/**
 * Fleet capacity tests: kiểm tra sức chứa máy (tái dùng probe/planner
 * của compute) — headroom cho host, từ chối khi hết ngân sách.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeMachineProfile } from '../packages/core/dist/compute/probe.js';
import { checkFleetCapacity, sumAllocatedFleetResources } from '../packages/core/dist/fleet/capacity.js';

const GB = 1024 ** 3;

function ws(overrides = {}) {
  return {
    id: 'fw-test',
    name: 'alice',
    osUser: 'alice',
    serviceName: 'open-bot-alice',
    port: 18001,
    rootDir: '/tmp/fleet-ws-alice',
    cpuCores: 1,
    ramBytes: 512 * 1024 ** 2,
    diskBytes: 10 * GB,
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

test('capacity: máy mặc định (8 core, 16GB RAM) đủ cho workspace nhỏ', () => {
  const profile = fakeMachineProfile();
  const check = checkFleetCapacity(profile, [], { cpuCores: 1, ramBytes: 512 * 1024 ** 2, diskBytes: 10 * GB });
  assert.equal(check.ok, true);
  // Ngân sách: CPU 8-2=6 core, RAM 12GB-4GB=8GB, đĩa 300-5=295GB.
  // headroom = ngân sách trừ phần ĐÃ cấp (chưa trừ request này).
  assert.equal(check.headroom.cpuCores, 6);
  assert.equal(check.headroom.ramBytes, 8 * GB);
  assert.equal(check.busy, false);
});

test('capacity: hết RAM thì từ chối kèm lý do, decision có thể ghi từ đó', () => {
  const profile = fakeMachineProfile();
  const check = checkFleetCapacity(profile, [], { cpuCores: 1, ramBytes: 9 * GB, diskBytes: 10 * GB });
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'not-enough-ram');
  assert.match(check.reasonDetail ?? '', /MB RAM/);
});

test('capacity: hết CPU / hết đĩa / quá số workspace tối đa', () => {
  const profile = fakeMachineProfile();
  const cpu = checkFleetCapacity(profile, [], { cpuCores: 7, ramBytes: 512 * 1024 ** 2, diskBytes: 10 * GB });
  assert.equal(cpu.ok, false);
  assert.equal(cpu.reason, 'not-enough-cpu');
  const disk = checkFleetCapacity(profile, [], { cpuCores: 1, ramBytes: 512 * 1024 ** 2, diskBytes: 400 * GB });
  assert.equal(disk.ok, false);
  assert.equal(disk.reason, 'not-enough-disk');
  const many = Array.from({ length: 8 }, (_, i) => ws({ id: `fw-${i}`, name: `w${i}`, osUser: `u${i}`, serviceName: `s${i}`, port: 18010 + i, rootDir: `/tmp/fleet-ws-${i}` }));
  const full = checkFleetCapacity(profile, many, { cpuCores: 1, ramBytes: 512 * 1024 ** 2, diskBytes: 10 * GB });
  assert.equal(full.ok, false);
  assert.equal(full.reason, 'too-many-workspaces');
});

test('capacity: workspace suspended không tính vào ngân sách đã cấp', () => {
  const profile = fakeMachineProfile();
  const suspended = ws({ status: 'suspended', cpuCores: 5, ramBytes: 7 * GB, diskBytes: 200 * GB });
  const check = checkFleetCapacity(profile, [suspended], { cpuCores: 1, ramBytes: 512 * 1024 ** 2, diskBytes: 10 * GB });
  assert.equal(check.ok, true);
  assert.deepEqual(sumAllocatedFleetResources([suspended]), { cpuCores: 0, ramBytes: 0, diskBytes: 0 });
  assert.deepEqual(sumAllocatedFleetResources([ws()]), { cpuCores: 1, ramBytes: 512 * 1024 ** 2, diskBytes: 10 * GB });
});

test('capacity: host đang bận (tải cao / RAM trống thấp) vẫn cấp được nhưng báo busy', () => {
  const busyCpu = fakeMachineProfile({ cpu: { loadAvg1m: 7.5, loadPerCore: 0.94 } });
  const check = checkFleetCapacity(busyCpu, [], { cpuCores: 1, ramBytes: 512 * 1024 ** 2, diskBytes: 10 * GB });
  assert.equal(check.ok, true);
  assert.equal(check.busy, true);
  assert.match(check.busyReason ?? '', /cpu-load/);
  const lowRam = fakeMachineProfile({ memory: { totalBytes: 16 * GB, freeBytes: 1 * GB, freeRatio: 0.0625 } });
  const check2 = checkFleetCapacity(lowRam, [], { cpuCores: 1, ramBytes: 512 * 1024 ** 2, diskBytes: 10 * GB });
  assert.equal(check2.busy, true);
  assert.match(check2.busyReason ?? '', /low-memory/);
});

test('capacity: máy yếu (2 core, 4GB RAM) vẫn cấp được box nhỏ, không cấp hết', () => {
  const weak = fakeMachineProfile({
    cpu: { logicalCores: 2, physicalCores: 2, loadAvg1m: 0.2, loadPerCore: 0.1 },
    memory: { totalBytes: 4 * GB, freeBytes: 3 * GB, freeRatio: 0.75 },
    disks: [{ mount: '/', totalBytes: 100 * GB, freeBytes: 50 * GB, freeRatio: 0.5 }],
  });
  const ok = checkFleetCapacity(weak, [], { cpuCores: 0.5, ramBytes: 512 * 1024 ** 2, diskBytes: 1 * GB });
  assert.equal(ok.ok, true);
  // Chừa 1 core cho host (ngân sách CPU = 2-1=1) → headroom vẫn 1 (chưa trừ request).
  assert.equal(ok.headroom.cpuCores, 1);
  const tooBig = checkFleetCapacity(weak, [], { cpuCores: 2, ramBytes: 512 * 1024 ** 2, diskBytes: 1 * GB });
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.reason, 'not-enough-cpu');
});
