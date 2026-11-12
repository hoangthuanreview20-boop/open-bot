/**
 * Scheduler cho máy-tính-bot (v0.90c, đội G gói C).
 *
 * Planner (`planner.ts`) là one-shot: hết ngân sách thì yêu cầu bị
 * từ chối và mất. Scheduler giữ các yêu cầu chưa đủ chỗ trong HÀNG
 * ĐỢI bền vững (lưu trong `computers.json`, xem `runtime.ts`), thử
 * lại khi capacity rảnh (runtime gọi `tryPromoteQueue` trong tick
 * refresh), và chọn máy để tự giảm tải khi host bận.
 *
 * Quy tắc hàng đợi:
 * - Mỗi bot có priority 0..100 (mặc định 50); thử lại theo priority
 *   giảm dần, FIFO trong cùng priority (theo `enqueuedAt`).
 * - Một bot chỉ có tối đa 1 entry trong hàng đợi (enqueue lại thì
 *   cập nhật request/priority, giữ nguyên `enqueuedAt`).
 * - Hàng đợi có trần (32 entry): đầy thì enqueue bot mới throw lỗi
 *   rõ — không để hàng đợi phình vô hạn.
 * - Khi host bận thì KHÔNG promote (chờ host rảnh) — tránh cấp thêm
 *   máy lúc máy đang quá tải.
 *
 * Tự giảm tải (auto-shed) là OPT-IN, mặc định TẮT (xem runtime):
 * scheduler chỉ CHỌN ứng viên; runtime mới là bên tạm dừng + ghi
 * audit log. Mỗi tick chỉ shed tối đa 1 máy (ưu tiên thấp nhất),
 * rồi probe lại ở tick sau.
 */

import { isHostBusy, planComputers } from './planner';
import type {
  BotComputerRequest,
  ComputerAllocation,
  ComputerBackend,
  ComputerQueueEntry,
  ComputerSchedulerState,
  MachineProfile,
  PlannerPolicy,
} from './types';

/** Số entry tối đa trong hàng đợi (tránh phình vô hạn). */
export const MAX_QUEUE_ENTRIES = 32;

/** Hành động audit khi scheduler tự tạm dừng máy (runtime ghi). */
export const COMPUTER_AUTO_SHED_AUDIT_ACTION = 'computer.auto-shed';

/** Priority mặc định khi request không ghi priority. */
export const DEFAULT_COMPUTER_PRIORITY = 50;

export function clampPriority(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_COMPUTER_PRIORITY;
  return Math.max(0, Math.min(100, Math.floor(value)));
}

export function emptySchedulerState(): ComputerSchedulerState {
  return { queue: [], autoShed: false };
}

/**
 * Đọc state scheduler từ object đã parse (vd từ computers.json).
 * Tolerant: field thiếu/sai thì bỏ qua entry đó, không throw —
 * file cũ (version 1, không có queue) đọc thành state rỗng.
 */
export function parseSchedulerState(raw: unknown): ComputerSchedulerState {
  const state = emptySchedulerState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return state;
  const rec = raw as Record<string, unknown>;
  if (rec.autoShed === true) state.autoShed = true;
  if (!Array.isArray(rec.queue)) return state;
  for (const item of rec.queue) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const e = item as Record<string, unknown>;
    if (typeof e.botId !== 'string' || e.botId.trim() === '') continue;
    if (typeof e.enqueuedAt !== 'string' || e.enqueuedAt.trim() === '') continue;
    const request: BotComputerRequest = { botId: e.botId };
    if (e.level === 'box' || e.level === 'container' || e.level === 'vm' || e.level === 'auto') {
      request.level = e.level;
    }
    if (typeof e.cpuCores === 'number' && Number.isFinite(e.cpuCores) && e.cpuCores > 0) {
      request.cpuCores = e.cpuCores;
    }
    if (typeof e.ramBytes === 'number' && Number.isFinite(e.ramBytes) && e.ramBytes > 0) {
      request.ramBytes = e.ramBytes;
    }
    if (typeof e.diskBytes === 'number' && Number.isFinite(e.diskBytes) && e.diskBytes > 0) {
      request.diskBytes = e.diskBytes;
    }
    const priority = clampPriority(e.priority);
    request.priority = priority;
    state.queue.push({
      botId: e.botId,
      request,
      priority,
      enqueuedAt: e.enqueuedAt,
      ...(typeof e.reason === 'string' && e.reason !== '' ? { reason: e.reason } : {}),
    });
  }
  state.queue = sortQueueEntries(state.queue);
  return state;
}

/** Thứ tự thử lại: priority cao trước, FIFO trong cùng priority. */
export function sortQueueEntries(entries: ComputerQueueEntry[]): ComputerQueueEntry[] {
  return [...entries].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const byTime = a.enqueuedAt.localeCompare(b.enqueuedAt);
    if (byTime !== 0) return byTime;
    return a.botId.localeCompare(b.botId);
  });
}

/**
 * Thêm/cập nhật một yêu cầu vào hàng đợi. Bot đã có entry thì cập
 * nhật request/priority (giữ `enqueuedAt` cũ — không nhảy lên đầu
 * hàng). Trả về entry sau khi thêm/cập nhật.
 */
export function enqueueRequest(
  state: ComputerSchedulerState,
  request: BotComputerRequest,
  now: string = new Date().toISOString(),
  reason?: string,
): ComputerQueueEntry {
  const botId = request.botId;
  if (typeof botId !== 'string' || botId.trim() === '') {
    throw new Error('enqueueRequest cần botId không rỗng.');
  }
  const priority = clampPriority(request.priority);
  const existing = state.queue.find((e) => e.botId === botId);
  if (existing) {
    existing.request = { ...request, priority };
    existing.priority = priority;
    if (reason !== undefined) existing.reason = reason;
    state.queue = sortQueueEntries(state.queue);
    return existing;
  }
  if (state.queue.length >= MAX_QUEUE_ENTRIES) {
    throw new Error(
      `Hàng đợi máy-tính-bot đã đầy (${MAX_QUEUE_ENTRIES} entry) — xoá bớt máy đang chờ trước khi thêm bot "${botId}".`,
    );
  }
  // FIFO phải giữ được cả khi 2 entry vào cùng 1 mili-giây (vd main
  // enqueue nhiều bot bị từ chối trong 1 vòng lặp): mốc thời gian
  // của entry mới luôn lớn hơn mọi entry đã có (tăng 1ms khi cần).
  let stamp = now;
  const maxExisting = state.queue.reduce(
    (max, e) => (e.enqueuedAt > max ? e.enqueuedAt : max),
    '',
  );
  if (maxExisting !== '' && stamp <= maxExisting) {
    stamp = new Date(Date.parse(maxExisting) + 1).toISOString();
  }
  const entry: ComputerQueueEntry = {
    botId,
    request: { ...request, priority },
    priority,
    enqueuedAt: stamp,
    ...(reason !== undefined ? { reason } : {}),
  };
  state.queue.push(entry);
  state.queue = sortQueueEntries(state.queue);
  return entry;
}

/** Xoá một bot khỏi hàng đợi (không có thì trả false). */
export function removeFromQueue(state: ComputerSchedulerState, botId: string): boolean {
  const before = state.queue.length;
  state.queue = state.queue.filter((e) => e.botId !== botId);
  return state.queue.length !== before;
}

/** Đổi priority của một entry đang chờ (không có thì trả false). */
export function setQueuePriority(
  state: ComputerSchedulerState,
  botId: string,
  priority: number,
): boolean {
  const entry = state.queue.find((e) => e.botId === botId);
  if (!entry) return false;
  entry.priority = clampPriority(priority);
  entry.request = { ...entry.request, priority: entry.priority };
  state.queue = sortQueueEntries(state.queue);
  return true;
}

/**
 * Thử promote các entry đang chờ bằng profile/backends hiện tại.
 * Host bận thì không promote gì (trả toàn bộ về `remaining`).
 * Mỗi entry được thử theo đúng thứ tự hàng đợi (priority cao trước,
 * FIFO trong cùng priority): chạy `planComputers` với các request đã
 * promote + ứng viên — ứng viên được cấp VÀ mọi entry đã nhận vẫn
 * còn được cấp thì promote, không thì ở lại hàng đợi. Trả về
 * allocation đã promote + entry còn chờ.
 * `alreadyAllocated`: tài nguyên đã cấp cho máy ĐÃ TỒN TẠI (vd
 * runtime truyền toàn bộ máy hiện có) — trừ vào ngân sách trước khi
 * thử, nếu không tick sẽ cấp vượt vì chỉ nhìn hàng đợi.
 */
export function tryPromoteQueue(
  profile: MachineProfile,
  queue: ComputerQueueEntry[],
  backends: ComputerBackend[],
  policy: PlannerPolicy = {},
  alreadyAllocated: BotComputerRequest[] = [],
): { promoted: ComputerAllocation[]; remaining: ComputerQueueEntry[] } {
  const ordered = sortQueueEntries(queue);
  if (isHostBusy(profile, policy).busy) {
    return { promoted: [], remaining: ordered };
  }
  const promoted: ComputerAllocation[] = [];
  const remaining: ComputerQueueEntry[] = [];
  const acceptedRequests: BotComputerRequest[] = [...alreadyAllocated];
  // Allocation theo botId, làm mới sau mỗi lần plan thành công — plan
  // sắp lại theo (priority, botId) nên ứng viên cùng priority nhưng
  // botId nhỏ hơn có thể chen lên trước entry đã nhận: chỉ nhận ứng
  // viên khi plan mới VẪN cấp đủ cho mọi entry đã nhận + ứng viên.
  const allocById = new Map<string, ComputerAllocation>();
  for (const entry of ordered) {
    const plan = planComputers(profile, [...acceptedRequests, entry.request], backends, policy);
    const allAllocated = [...acceptedRequests, entry.request].every((r) =>
      plan.allocations.some((a) => a.botId === r.botId),
    );
    if (allAllocated) {
      for (const allocation of plan.allocations) {
        allocById.set(allocation.botId, allocation);
      }
      acceptedRequests.push(entry.request);
    } else {
      remaining.push(entry);
    }
  }
  for (const entry of ordered) {
    const allocation = allocById.get(entry.botId);
    if (allocation) promoted.push(allocation);
  }
  return { promoted, remaining };
}

/**
 * Chọn máy để tự giảm tải khi host bận: ưu tiên thấp nhất trước,
 * hoà thì máy tốn RAM hơn dừng trước (cùng thứ tự `suggestShedOrder`
 * của planner). Chỉ trả tối đa `maxCount` botId (mặc định 1/tick).
 */
export function selectAutoShedCandidates(
  running: Array<{ botId: string; priority: number; ramBytes: number }>,
  maxCount = 1,
): string[] {
  return [...running]
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return b.ramBytes - a.ramBytes;
    })
    .slice(0, Math.max(0, maxCount))
    .map((c) => c.botId);
}
