/**
 * Interrupt (human-in-the-loop) cho agent run dài — P1-8 (§12.4).
 *
 * Ý tưởng lấy từ LangGraph `interrupt()`: run dừng ở một điểm an toàn
 * (đầu step, hoặc ngay trước một tool call), hỏi user, rồi tiếp tục đúng
 * điểm đó — không chạy lại step đã xong (checkpoint đã lưu, xem
 * `agent/checkpoints.ts`). Mở rộng plan-approval 1 bước hiện tại: plan
 * approval chỉ dừng ở MỘT điểm cố định (trước khi thực thi plan), còn
 * interrupt dừng được ở BẤT KỲ step nào, kể cả giữa run dài (grind mode),
 * và có thể mang theo câu hỏi + câu trả lời của user quay lại run.
 *
 * Thiết kế:
 *  - `InterruptController`: cờ "có yêu cầu dừng đang chờ" mà host/UI gọi
 *    `interrupt()` bất cứ lúc nào (kể cả giữa provider call đang bay —
 *    loop chỉ kiểm tra ở biên step nên không cắt ngang tool đang chạy).
 *  - `InterruptHandler`: callback host cung cấp; loop gọi nó khi gặp điểm
 *    dừng, handler trả `InterruptDecision` (tiếp tục / tiếp tục kèm
 *    message mới / từ chối tool này / hủy run). Không có handler thì run
 *    dừng an toàn (lưu checkpoint rồi trả text "đã tạm dừng") thay vì
 *    treo chờ mãi.
 *  - `interruptBeforeTools`: điểm dừng theo tool — tên tool hoặc predicate
 *    trên ToolCall; dùng cho tool nguy hiểm mà approval thường không đủ
 *    (vd cần hỏi user giữa chừng, không chỉ duyệt/từ chối).
 *
 * Module này thuần túy (không đọc DB, không gọi provider) nên test được
 * mà không cần Electron hay API key.
 */

import type { ToolCall } from '../types';

/** Vì sao run dừng lại để hỏi user. */
export type InterruptReason =
  | 'user-requested'
  | 'before-tool'
  | 'step-boundary'
  | 'grind-slice-boundary';

/** Một yêu cầu dừng đang chờ user trả lời. */
export interface InterruptRequest {
  /** Id run đang chạy (khớp `runId` của checkpoint). */
  runId: string;
  botId: string;
  /** Step mà run dừng lại (step này CHƯA chạy — resume chạy tiếp từ đây). */
  stepIndex: number;
  reason: InterruptReason;
  /** Câu hỏi hiển thị cho user (nếu có). */
  question?: string;
  /** Tool call sắp chạy khi dừng ở điểm `before-tool`. */
  toolCall?: ToolCall;
  createdAt: string;
}

/** Quyết định của user khi run dừng lại. */
export type InterruptDecision =
  | { action: 'continue' }
  | { action: 'continue-with-message'; message: string }
  | { action: 'deny-tool' }
  | { action: 'cancel' };

/** Callback host cung cấp: hỏi user rồi trả quyết định. */
export type InterruptHandler = (request: InterruptRequest) => Promise<InterruptDecision>;

/** Điểm dừng theo tool: tên tool, hoặc predicate trên ToolCall. */
export type InterruptPoint = string | ((call: ToolCall) => boolean);

/**
 * Cờ yêu cầu dừng của một run. Host gọi `request()` (vd nút "Tạm dừng
 * để hỏi" ở UI, hoặc `AgentRunner.interrupt()`), loop gọi `take()` ở
 * biên step để lấy và xoá yêu cầu. Một controller dùng cho một run.
 */
export class InterruptController {
  private pending: { reason: InterruptReason; question?: string } | null = null;

  /** Host/UI yêu cầu dừng run ở biên step an toàn tiếp theo. */
  request(reason: InterruptReason = 'user-requested', question?: string): void {
    this.pending = { reason, question };
  }

  /** true khi đang có yêu cầu dừng chưa được loop xử lý. */
  hasPending(): boolean {
    return this.pending !== null;
  }

  /** Lấy và xoá yêu cầu đang chờ (loop gọi ở biên step). null khi không có. */
  take(): { reason: InterruptReason; question?: string } | null {
    const req = this.pending;
    this.pending = null;
    return req;
  }

  /** Xoá yêu cầu đang chờ mà không xử lý (vd run đã kết thúc). */
  clear(): void {
    this.pending = null;
  }
}

/**
 * true khi tool call này chạm một điểm dừng `interruptBeforeTools`.
 * Chuỗi so khớp đúng tên tool; function thì gọi predicate (lỗi predicate
 * = không khớp, fail-open ở tầng matching — quyết định chặn thật vẫn do
 * handler + approval/denylist phía sau).
 */
export function matchesInterruptPoint(call: ToolCall, points: readonly InterruptPoint[]): boolean {
  for (const point of points) {
    if (typeof point === 'string') {
      if (point === call.name) return true;
    } else {
      try {
        if (point(call)) return true;
      } catch {
        // Predicate lỗi thì coi như không khớp điểm này.
      }
    }
  }
  return false;
}

/** Chuẩn hoá `interruptBeforeTools` ở options thành mảng (undefined → []). */
export function normalizeInterruptPoints(
  points?: InterruptPoint | readonly InterruptPoint[],
): InterruptPoint[] {
  if (!points) return [];
  if (typeof points === 'string' || typeof points === 'function') return [points];
  return [...points];
}

/** Text kết thúc run khi user hủy ở điểm interrupt (hiển thị cho user). */
export const INTERRUPT_CANCELLED_TEXT = 'Đã tạm dừng run theo yêu cầu (checkpoint đã lưu, có thể resume lại).';

/** Text kết thúc run khi interrupt không có handler để hỏi user. */
export function interruptNoHandlerText(stepIndex: number): string {
  return (
    `Đã tạm dừng run ở step ${stepIndex + 1} (checkpoint đã lưu, có thể resume lại) ` +
    `— không có handler để hỏi user nên run không tiếp tục.`
  );
}
