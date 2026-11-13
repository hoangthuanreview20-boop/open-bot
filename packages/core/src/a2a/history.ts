/**
 * Task lifecycle history (v0.97, Đội T2) — bảng chuyển trạng thái
 * hợp lệ + lịch sử chuyển trạng thái của task A2A 1.0.
 *
 * A2A 1.0 khai capability `stateTransitionHistory`: client có thể
 * xem task đã đi qua những trạng thái nào, lúc nào. Trước sóng này
 * server chỉ lưu `status` hiện tại (capability báo false). Sóng này
 * server ghi mọi lần đổi trạng thái vào `task.transitions` và trả
 * kèm trong `tasks/get`/`tasks/list` — không cần thêm endpoint.
 *
 * Bảng chuyển trạng thái hợp lệ (theo lifecycle chuẩn A2A 1.0):
 *   submitted      → working, cancelled, rejected
 *   working        → working (tiến độ), input-required, completed,
 *                     failed, cancelled
 *   input-required → working, completed, failed, cancelled
 *   auth-required  → working, cancelled, rejected
 *   completed/failed/cancelled/rejected → (trạng thái cuối, không đi đâu)
 * Chuyển trạng thái không hợp lệ (vd completed → working) là lỗi
 * lập trình: `recordTransition` trả `legal: false` và caller log
 * cảnh báo, nhưng vẫn ghi lại (không giấu lịch sử) — server không
 * crash vì một lần chuyển sai.
 *
 * Event log: ring buffer trong bộ nhớ cho mọi event task của server
 * (tạo task, đổi trạng thái, artifact, lỗi) để debug và để UI
 * "activity" đọc sau này. Không lưu file (task đã có file store).
 */
import type { A2aTaskState, A2aTaskTransition } from './types';

export type { A2aTaskTransition };

/** Một event trong event log của server A2A. */
export interface A2aTaskEvent {
  /** Loại event: tạo task, đổi trạng thái, artifact, lỗi, hủy. */
  kind: 'task-created' | 'state-changed' | 'artifact' | 'error' | 'cancelled' | 'push-notified';
  taskId: string;
  contextId?: string;
  /** ISO-8601 lúc event xảy ra. */
  at: string;
  /** Trạng thái liên quan (khi có). */
  state?: A2aTaskState;
  /** Chi tiết ngắn gọn. */
  detail?: string;
}

/**
 * Bảng chuyển trạng thái hợp lệ. Trạng thái cuối không có đích đi —
 * mọi chuyển từ trạng thái cuối đều bất hợp lệ.
 */
export const A2A_LEGAL_TRANSITIONS: Readonly<Record<A2aTaskState, readonly A2aTaskState[]>> = {
  submitted: ['working', 'cancelled', 'rejected'],
  working: ['working', 'input-required', 'completed', 'failed', 'cancelled'],
  'input-required': ['working', 'completed', 'failed', 'cancelled'],
  'auth-required': ['working', 'cancelled', 'rejected'],
  completed: [],
  failed: [],
  cancelled: [],
  rejected: [],
};

/** true khi chuyển từ `from` sang `to` hợp lệ (from=null = tạo task). */
export function isLegalA2aTransition(
  from: A2aTaskState | null,
  to: A2aTaskState,
): boolean {
  if (from === null) return to === 'submitted';
  if (from === to && from === 'working') return true;
  const allowed = A2A_LEGAL_TRANSITIONS[from] ?? [];
  return (allowed as readonly A2aTaskState[]).includes(to);
}

/**
 * Tạo một transition record (không sửa lịch sử cũ). `at` mặc định
 * là thời điểm gọi.
 */
export function makeA2aTransition(
  from: A2aTaskState | null,
  to: A2aTaskState,
  at?: string,
  note?: string,
): A2aTaskTransition {
  return {
    from,
    to,
    at: at ?? new Date().toISOString(),
    legal: isLegalA2aTransition(from, to),
    ...(note !== undefined && note.length > 0 ? { note } : {}),
  };
}

/**
 * Thêm một transition vào cuối lịch sử (trả mảng mới, không sửa
 * mảng cũ). Lịch sử kẹp tối đa `maxEntries` (mặc định 50) — task
 * không bao giờ chuyển trạng thái nhiều tới vậy, kẹp chỉ để chống
 * phình khi runner gọi setState trong vòng lặp lỗi.
 */
export function appendA2aTransition(
  history: readonly A2aTaskTransition[] | undefined,
  transition: A2aTaskTransition,
  maxEntries = 50,
): A2aTaskTransition[] {
  const next = [...(history ?? []), transition];
  if (next.length <= maxEntries) return next;
  return next.slice(next.length - maxEntries);
}

/** Tóm tắt lịch sử thành chuỗi đọc được (vd "submitted → working → completed"). */
export function summarizeA2aTransitions(
  history: readonly A2aTaskTransition[] | undefined,
): string {
  if (!history || history.length === 0) return '(no transitions recorded)';
  const states: string[] = [];
  const first = history[0];
  if (first.from) states.push(first.from);
  for (const t of history) states.push(t.to);
  return states.join(' → ');
}

/** Số lần task vào một trạng thái (để thống kê/debug). */
export function countA2aStateVisits(
  history: readonly A2aTaskTransition[] | undefined,
  state: A2aTaskState,
): number {
  if (!history) return 0;
  return history.filter((t) => t.to === state).length;
}

/**
 * Ring buffer event log trong bộ nhớ: giữ tối đa `capacity` event
 * mới nhất (mặc định 500), event cũ nhất bị đẩy ra. Đọc bằng
 * `list()` (mới nhất trước) hoặc `forTask(taskId)`.
 */
export class A2aEventLog {
  private readonly capacity: number;
  private readonly events: A2aTaskEvent[] = [];

  constructor(capacity = 500) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  append(event: Omit<A2aTaskEvent, 'at'> & { at?: string }): A2aTaskEvent {
    const full: A2aTaskEvent = { ...event, at: event.at ?? new Date().toISOString() };
    this.events.push(full);
    while (this.events.length > this.capacity) this.events.shift();
    return full;
  }

  /** Mọi event, mới nhất trước. */
  list(): A2aTaskEvent[] {
    return [...this.events].reverse();
  }

  /** Event của một task, mới nhất trước. */
  forTask(taskId: string): A2aTaskEvent[] {
    return this.events.filter((e) => e.taskId === taskId).reverse();
  }

  /** Event theo kind, mới nhất trước. */
  byKind(kind: A2aTaskEvent['kind']): A2aTaskEvent[] {
    return this.events.filter((e) => e.kind === kind).reverse();
  }

  get size(): number {
    return this.events.length;
  }

  clear(): void {
    this.events.length = 0;
  }
}
