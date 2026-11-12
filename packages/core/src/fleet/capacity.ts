/**
 * Kiểm tra sức chứa máy cho fleet (đội D).
 *
 * Tái dùng probe/planner của Team B (compute): `probeMachine` để dò
 * máy thật, `resolvePlannerPolicy` + `isHostBusy` để lấy chính sách
 * headroom và trạng thái bận. Phép tính ngân sách (chừa bao nhiêu
 * core/RAM/đĩa cho host) giữ cùng công thức với `planComputers`
 * (xem packages/core/src/compute/planner.ts) — chừa cho host nhiều
 * nhất có thể nhưng luôn để lại ít nhất 1 core cho bot; RAM chừa
 * max(reserveRamBytes, 25% tổng RAM) nhưng không quá nửa RAM trống
 * hiện tại. Không cấp quá ngân sách: hết là từ chối kèm lý do.
 */
import { isHostBusy, resolvePlannerPolicy } from '../compute/planner';
import type { MachineProfile, PlannerPolicy } from '../compute/types';
import type { FleetCapacityCheck, FleetWorkspace } from './types';

/** Tài nguyên đã cấp cho các workspace active (không tính suspended). */
export function sumAllocatedFleetResources(workspaces: FleetWorkspace[]): {
  cpuCores: number;
  ramBytes: number;
  diskBytes: number;
} {
  let cpuCores = 0;
  let ramBytes = 0;
  let diskBytes = 0;
  for (const ws of workspaces) {
    if (ws.status !== 'active') continue;
    cpuCores += ws.cpuCores;
    ramBytes += ws.ramBytes;
    diskBytes += ws.diskBytes;
  }
  return { cpuCores, ramBytes, diskBytes };
}

/**
 * Kiểm tra xem máy có đủ sức chứa thêm một workspace với yêu cầu cho
 * trước không. Thuần (không I/O) — caller tự probe máy rồi đưa vào.
 */
export function checkFleetCapacity(
  profile: MachineProfile,
  existing: FleetWorkspace[],
  request: { cpuCores: number; ramBytes: number; diskBytes: number },
  policy: PlannerPolicy = {},
): FleetCapacityCheck {
  const p = resolvePlannerPolicy(policy);
  const totalCores = Math.max(1, profile.cpu.logicalCores);
  // Chừa core cho host (cùng công thức planComputers).
  const reserveCores = Math.min(
    Math.max(totalCores - 1, 0),
    Math.max(p.reserveCpuCores, Math.ceil(totalCores * 0.25)),
  );
  const cpuBudget = Math.max(0, totalCores - reserveCores);
  // Chừa RAM cho host (cùng công thức planComputers).
  const reserveRam = Math.min(
    Math.max(p.reserveRamBytes, profile.memory.totalBytes * p.reserveRamRatio),
    profile.memory.freeBytes / 2,
  );
  const ramBudget = Math.max(0, profile.memory.freeBytes - reserveRam);
  // Đĩa: chừa reserveDiskBytes trên ổ hệ thống.
  const sysDisk = profile.disks.find((d) => d.mount === '/' || d.mount === 'C:' || d.mount === 'C:\\') ??
    profile.disks[0];
  const diskFree = sysDisk?.freeBytes ?? 0;
  const diskBudget = Math.max(0, diskFree - p.reserveDiskBytes);

  const allocated = sumAllocatedFleetResources(existing);
  const headroom = {
    cpuCores: Math.max(0, cpuBudget - allocated.cpuCores),
    ramBytes: Math.max(0, ramBudget - allocated.ramBytes),
    diskBytes: Math.max(0, diskBudget - allocated.diskBytes),
  };
  const busy = isHostBusy(profile, policy);

  const activeCount = existing.filter((ws) => ws.status === 'active').length;
  if (activeCount >= p.maxComputers) {
    return {
      ok: false,
      reason: 'too-many-workspaces',
      reasonDetail: `Đã có ${activeCount} workspace active (tối đa ${p.maxComputers}).`,
      headroom,
      allocated,
      requested: request,
      busy: busy.busy,
      ...(busy.reason ? { busyReason: busy.reason } : {}),
    };
  }
  if (request.cpuCores > headroom.cpuCores) {
    return {
      ok: false,
      reason: 'not-enough-cpu',
      reasonDetail: `Cần ${request.cpuCores} core, chỉ còn ${headroom.cpuCores} core sau khi chừa cho host.`,
      headroom,
      allocated,
      requested: request,
      busy: busy.busy,
      ...(busy.reason ? { busyReason: busy.reason } : {}),
    };
  }
  if (request.ramBytes > headroom.ramBytes) {
    return {
      ok: false,
      reason: 'not-enough-ram',
      reasonDetail: `Cần ${Math.round(request.ramBytes / 1024 ** 2)} MB RAM, chỉ còn ${Math.round(headroom.ramBytes / 1024 ** 2)} MB sau khi chừa cho host.`,
      headroom,
      allocated,
      requested: request,
      busy: busy.busy,
      ...(busy.reason ? { busyReason: busy.reason } : {}),
    };
  }
  if (request.diskBytes > headroom.diskBytes) {
    return {
      ok: false,
      reason: 'not-enough-disk',
      reasonDetail: `Cần ${Math.round(request.diskBytes / 1024 ** 3)} GB đĩa, chỉ còn ${Math.round(headroom.diskBytes / 1024 ** 3)} GB sau khi chừa cho host.`,
      headroom,
      allocated,
      requested: request,
      busy: busy.busy,
      ...(busy.reason ? { busyReason: busy.reason } : {}),
    };
  }
  return {
    ok: true,
    headroom,
    allocated,
    requested: request,
    busy: busy.busy,
    ...(busy.reason ? { busyReason: busy.reason } : {}),
  };
}
