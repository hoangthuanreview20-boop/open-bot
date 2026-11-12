/**
 * Resource planner — chia tài nguyên máy cho các máy-tính-bot (sóng B,
 * đội platform).
 *
 * Module THUẦN (không I/O, không chạy gì): đầu vào là MachineProfile đã
 * probe + danh sách yêu cầu + backend đã dò; đầu ra là ComputerPlan.
 * Nhờ đó test được bằng dữ liệu giả mà không cần máy thật.
 *
 * NGUYÊN TẮC AN TOÀN — KHÔNG ẢNH HƯỞNG NGƯỜI DÙNG (yêu cầu cứng của Huy):
 * - CPU: chừa cho host `max(reserveCpuCores, 25% tổng core)` — bot chỉ
 *   được dùng phần còn lại.
 * - RAM: tính trên RAM TRỐNG hiện tại, trừ `max(reserveRamBytes, 25%
 *   tổng RAM)` — máy đang ít RAM trống thì bot được cấp ít theo.
 * - Đĩa: chừa `reserveDiskBytes` trên ổ hệ thống.
 * - Không bao giờ cấp vượt ngân sách: hết ngân sách thì yêu cầu sau bị
 *   từ chối kèm lý do rõ ràng (không cấp quá rồi hy vọng).
 * - Mức cách ly chọn theo sức máy: máy mạnh thì VM, máy thường thì
 *   container/namespace, máy yếu thì box. Mức yêu cầu không khả thi thì
 *   HẠ MỨC kèm cảnh báo (ghi `downgradedFrom`), không bịa là đã cấp mức cao.
 */

import type {
  BotComputerRequest,
  ComputerAllocation,
  ComputerBackend,
  ComputerBackendKind,
  ComputerLevel,
  ComputerPlan,
  MachineProfile,
  PlannerPolicy,
} from './types';

export const GB = 1024 ** 3;

/** Tài nguyên tối thiểu mỗi mức (mức sàn — yêu cầu thấp hơn vẫn lấy mức này). */
export const LEVEL_DEFAULTS: Record<
  ComputerLevel,
  { cpuCores: number; ramBytes: number; diskBytes: number }
> = {
  // Box chỉ là thư mục riêng + env allow-list: nhẹ nhất.
  box: { cpuCores: 0.5, ramBytes: 512 * 1024 ** 2, diskBytes: 1 * GB },
  // Container/namespace: cần thêm RAM cho runtime cách ly.
  container: { cpuCores: 1, ramBytes: 1 * GB, diskBytes: 2 * GB },
  // VM thật: nặng nhất — mỗi cái tốn hàng GB RAM, khởi động chậm.
  vm: { cpuCores: 2, ramBytes: 4 * GB, diskBytes: 10 * GB },
};

export const DEFAULT_PLANNER_POLICY: Required<PlannerPolicy> = {
  reserveCpuCores: 2,
  reserveRamRatio: 0.25,
  reserveRamBytes: 2 * GB,
  reserveDiskBytes: 5 * GB,
  maxComputers: 8,
  busyLoadPerCore: 0.8,
  busyMinFreeRamRatio: 0.15,
};

export function resolvePlannerPolicy(policy: PlannerPolicy = {}): Required<PlannerPolicy> {
  return { ...DEFAULT_PLANNER_POLICY, ...policy };
}

/** Thứ tự ưu tiên backend trong mỗi mức (mạnh/tiện nhất trước). */
const CONTAINER_BACKEND_ORDER: ComputerBackendKind[] = [
  'bwrap',
  'systemd-nspawn',
  'podman',
  'unshare',
];
const VM_BACKEND_ORDER: ComputerBackendKind[] = ['qemu', 'wsl', 'hyperv', 'macvm'];

function bestBackend(
  level: ComputerLevel,
  backends: ComputerBackend[],
): ComputerBackend | undefined {
  const order = level === 'container' ? CONTAINER_BACKEND_ORDER : VM_BACKEND_ORDER;
  const available = backends.filter((b) => b.level === level && b.available);
  for (const kind of order) {
    const found = available.find((b) => b.kind === kind);
    if (found) return found;
  }
  return available[0];
}

/**
 * Mức này có khả thi trên máy không (chỉ xét NĂNG LỰC, chưa xét tài
 * nguyên còn lại). Box luôn khả thi; container cần backend container;
 * VM cần CPU hỗ trợ ảo hoá + backend VM.
 */
export function levelFeasible(
  level: ComputerLevel,
  profile: MachineProfile,
  backends: ComputerBackend[],
): { ok: boolean; backend?: ComputerBackend; reason?: string } {
  if (level === 'box') {
    return { ok: true, backend: { kind: 'box', level: 'box', available: true, detail: 'thư mục riêng (không namespace)' } };
  }
  if (level === 'container') {
    const backend = bestBackend('container', backends);
    if (!backend) return { ok: false, reason: 'không có backend container nào (bwrap/unshare/nspawn/podman)' };
    return { ok: true, backend };
  }
  // vm
  if (!profile.virtualization.supported) {
    return { ok: false, reason: 'CPU/máy không hỗ trợ ảo hoá' };
  }
  const backend = bestBackend('vm', backends);
  if (!backend) {
    return { ok: false, reason: 'không có backend VM nào (QEMU/WSL2/Hyper-V/Virtualization.framework)' };
  }
  return { ok: true, backend };
}

/** Máy host có đang bận không (tải CPU/core cao hoặc RAM trống thấp). */
export function isHostBusy(
  profile: MachineProfile,
  policy: PlannerPolicy = {},
): { busy: boolean; reason?: string } {
  const p = resolvePlannerPolicy(policy);
  const load = profile.cpu.loadPerCore;
  if (load !== null && load > p.busyLoadPerCore) {
    return { busy: true, reason: `cpu-load (tải/core ${load.toFixed(2)} > ${p.busyLoadPerCore})` };
  }
  if (profile.memory.freeRatio < p.busyMinFreeRamRatio) {
    return {
      busy: true,
      reason: `low-memory (RAM trống ${Math.round(profile.memory.freeRatio * 100)}% < ${Math.round(p.busyMinFreeRamRatio * 100)}%)`,
    };
  }
  return { busy: false };
}

/** Ổ hệ thống: '/' (unix) hoặc 'C:' (Windows), fallback ổ đầu tiên. */
function systemDiskFreeBytes(profile: MachineProfile): number {
  if (profile.disks.length === 0) return 0;
  const sys =
    profile.disks.find((d) => d.mount === '/' || d.mount === 'C:' || d.mount === 'C:\\') ??
    profile.disks[0];
  return sys?.freeBytes ?? 0;
}

function clampRequestAmount(
  requested: number | undefined,
  floor: number,
): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return floor;
  return Math.max(requested, floor);
}

/**
 * Lập kế hoạch chia tài nguyên cho các yêu cầu. Yêu cầu được xử lý
 * theo độ ưu tiên giảm dần (cao trước); vượt `maxComputers` thì từ chối
 * kèm lý do. Mức yêu cầu không khả thi thì hạ mức (ghi downgradedFrom
 * + warning); hết ngân sách thì từ chối (không cấp quá).
 */
export function planComputers(
  profile: MachineProfile,
  requests: BotComputerRequest[],
  backends: ComputerBackend[],
  policy: PlannerPolicy = {},
): ComputerPlan {
  const p = resolvePlannerPolicy(policy);
  const warnings: string[] = [];
  const totalCores = Math.max(1, profile.cpu.logicalCores);
  // Chừa cho host nhiều nhất có thể, nhưng luôn để lại ít nhất 1 core
  // cho bot (máy 2 core vẫn chạy được box; máy 1 core thì bot được 0.5
  // core trong ngân sách — host vẫn còn nửa core còn lại).
  const reserveCores = Math.min(
    Math.max(totalCores - 1, 0),
    Math.max(p.reserveCpuCores, Math.ceil(totalCores * 0.25)),
  );
  let cpuLeft = Math.max(0, totalCores - reserveCores);
  // RAM: chừa max(reserveRamBytes, 25% tổng RAM) nhưng không bao giờ
  // chừa quá nửa RAM TRỐNG hiện tại (máy ít RAM vẫn chạy được box —
  // host luôn giữ ít nhất nửa RAM trống còn lại).
  const reserveRam = Math.min(
    Math.floor(profile.memory.freeBytes * 0.5),
    Math.max(p.reserveRamBytes, Math.floor(profile.memory.totalBytes * p.reserveRamRatio)),
  );
  let ramLeft = Math.max(0, profile.memory.freeBytes - reserveRam);
  let diskLeft = Math.max(0, systemDiskFreeBytes(profile) - p.reserveDiskBytes);

  const sorted = [...requests].sort((a, b) => {
    const pa = a.priority ?? 50;
    const pb = b.priority ?? 50;
    if (pb !== pa) return pb - pa;
    return a.botId.localeCompare(b.botId);
  });

  const allocations: ComputerAllocation[] = [];
  const rejected: ComputerPlan['rejected'] = [];

  for (const req of sorted) {
    if (allocations.length >= p.maxComputers) {
      rejected.push({
        botId: req.botId,
        reason: 'too-many-computers',
        reasonDetail: `Đã đủ ${p.maxComputers} máy-tính-bot cùng lúc (chính sách maxComputers).`,
      });
      continue;
    }
    const wanted: ComputerLevel | 'auto' =
      req.level === undefined || req.level === 'auto' ? 'auto' : req.level;
    // Mức 'auto': thử từ mạnh nhất xuống. Mức tường minh: thử mức đó
    // trước, rồi hạ dần xuống mức thấp hơn (mạnh nhất còn lại trước).
    const ordered: ComputerLevel[] =
      wanted === 'auto'
        ? ['vm', 'container', 'box']
        : [
            wanted,
            ...(['box', 'container', 'vm'] as ComputerLevel[])
              .filter((l) => l !== wanted)
              .sort((a, b) => levelRank(b) - levelRank(a)),
          ];
    let placed: ComputerAllocation | null = null;
    let lastCapabilityReason: string | undefined;
    for (const level of ordered) {
      const feasible = levelFeasible(level, profile, backends);
      if (!feasible.ok) {
        lastCapabilityReason = feasible.reason;
        continue;
      }
      const defaults = LEVEL_DEFAULTS[level];
      const cpuCores = clampRequestAmount(req.cpuCores, defaults.cpuCores);
      const ramBytes = clampRequestAmount(req.ramBytes, defaults.ramBytes);
      const diskBytes = clampRequestAmount(req.diskBytes, defaults.diskBytes);
      if (cpuCores > cpuLeft || ramBytes > ramLeft || diskBytes > diskLeft) continue;
      cpuLeft -= cpuCores;
      ramLeft -= ramBytes;
      diskLeft -= diskBytes;
      const backend = feasible.backend as ComputerBackend;
      placed = {
        botId: req.botId,
        level,
        ...(level !== wanted && wanted !== 'auto' ? { downgradedFrom: wanted as ComputerLevel } : {}),
        cpuCores,
        ramBytes,
        diskBytes,
        backend: backend.kind,
        backendDetail: backend.detail,
        priority: req.priority ?? 50,
      };
      if (placed.downgradedFrom) {
        warnings.push(
          `Bot "${req.botId}": hạ mức ${placed.downgradedFrom} -> ${level} (máy không đủ điều kiện cho mức ${placed.downgradedFrom}).`,
        );
      }
      break;
    }
    if (placed) {
      allocations.push(placed);
    } else {
      rejected.push({
        botId: req.botId,
        reason: 'insufficient-resources',
        reasonDetail:
          lastCapabilityReason ??
          `Không còn đủ CPU/RAM/đĩa trống sau khi chừa headroom cho host (còn ${cpuLeft.toFixed(1)} core / ${Math.round(ramLeft / GB)} GB RAM / ${Math.round(diskLeft / GB)} GB đĩa).`,
      });
    }
  }

  const busy = isHostBusy(profile, p);
  if (busy.busy) {
    warnings.push(`Máy host đang bận (${busy.reason}) — nên tạm dừng bot ưu tiên thấp trước khi chạy thêm.`);
  }

  return {
    profile,
    allocations,
    rejected,
    hostHeadroom: { cpuCores: cpuLeft, ramBytes: ramLeft, diskBytes: diskLeft },
    busy: busy.busy,
    busyReason: busy.reason,
    warnings,
    plannedAt: new Date().toISOString(),
  };
}

/** Thứ tự mức từ thấp đến cao (để sắp xếp ứng viên hạ mức). */
function levelRank(level: ComputerLevel): number {
  return level === 'box' ? 0 : level === 'container' ? 1 : 2;
}

/**
 * Thứ tự nên tạm dừng khi máy host bận: ưu tiên thấp trước, hoà thì
 * máy tốn RAM hơn dừng trước (giải phóng nhiều hơn). Caller tạm dừng
 * theo thứ tự này rồi probe lại máy sau mỗi lần dừng.
 */
export function suggestShedOrder(plan: ComputerPlan): string[] {
  return [...plan.allocations]
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return b.ramBytes - a.ramBytes;
    })
    .map((a) => a.botId);
}
