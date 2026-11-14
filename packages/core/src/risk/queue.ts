/**
 * ConfirmationQueue (v1.01, Đội T3) — hàng đợi yêu cầu duyệt + audit log.
 *
 * State machine cho mỗi yêu cầu duyệt (id = callId của tool call):
 *
 *   pending ──approve──▶ approved
 *   pending ──deny─────▶ denied
 *   pending ──edit─────▶ edited (approved kèm args đã sửa)
 *   pending ──timeout──▶ expired (mặc định denied về mặt thực thi)
 *
 * Mọi chuyển trạng thái đều ghi một dòng vào audit log (append-only,
 * giữ trong bộ nhớ; host có thể persist bằng `toJSON()` / đọc lại
 * bằng `fromJSON()`). Quyết định timeout mặc định là DENY (fail-
 * closed, theo coordinator: hết 10 phút không trả lời → từ chối).
 *
 * Queue này KHÔNG thay thế `pendingApprovals` của coordinator (map
 * callId → resolve promise, điều khiển luồng run). Nó là lớp ghi sổ
 * + trạng thái để UI tra cứu và audit — coordinator tạo entry khi
 * emit thẻ duyệt và resolve entry khi `respondApproval` trả lời.
 */

import type {
  ConfirmationAuditEntry,
  ConfirmationPolicy,
  ConfirmationResolution,
  PendingConfirmation,
  PendingConfirmationStatus,
  RiskAssessment,
} from './types';

/** Hết hạn mặc định: 10 phút (khớp RESPONSE_TIMEOUT_MS của coordinator). */
export const DEFAULT_CONFIRMATION_TIMEOUT_MS = 10 * 60 * 1000;

export interface ConfirmationQueueOptions {
  /** Timeout cho mỗi yêu cầu (ms). Không đặt = 10 phút. */
  timeoutMs?: number;
  /**
   * Callback khi một yêu cầu hết hạn (để host resolve promise chờ).
   * Không throw: lỗi trong callback không phá queue.
   */
  onExpire?: (confirmation: PendingConfirmation) => void;
  /** Giới hạn audit log giữ trong bộ nhớ (mặc định 1000 dòng, FIFO). */
  maxAuditEntries?: number;
}

export class ConfirmationQueue {
  private readonly pending = new Map<string, PendingConfirmation>();
  private readonly audit: ConfirmationAuditEntry[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly timeoutMs: number;
  private readonly onExpire?: (confirmation: PendingConfirmation) => void;
  private readonly maxAuditEntries: number;

  constructor(options: ConfirmationQueueOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS;
    this.onExpire = options.onExpire;
    this.maxAuditEntries = options.maxAuditEntries ?? 1000;
  }

  /** Số yêu cầu đang chờ duyệt (entry đã resolve vẫn giữ để tra cứu). */
  get pendingCount(): number {
    let n = 0;
    for (const entry of this.pending.values()) if (entry.status === 'pending') n += 1;
    return n;
  }

  /** Tạo yêu cầu duyệt mới (trạng thái pending). Trùng id → trả entry cũ. */
  create(input: {
    id: string;
    botId: string;
    toolName: string;
    args: Record<string, unknown>;
    risk: RiskAssessment;
    policy: ConfirmationPolicy;
  }): PendingConfirmation {
    const existing = this.pending.get(input.id);
    if (existing) return existing;
    const entry: PendingConfirmation = {
      id: input.id,
      callId: input.id,
      botId: input.botId,
      toolName: input.toolName,
      args: input.args,
      risk: input.risk,
      policy: input.policy,
      status: 'pending',
      createdAtMs: Date.now(),
    };
    this.pending.set(entry.id, entry);
    const timer = setTimeout(() => this.expire(entry.id, 'timeout'), this.timeoutMs);
    // Không giữ process sống chỉ vì còn yêu cầu chờ duyệt.
    if (typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') {
      timer.unref();
    }
    this.timers.set(entry.id, timer);
    return entry;
  }

  /** Lấy một yêu cầu theo id (kể cả đã resolve — tra cứu audit). */
  get(id: string): PendingConfirmation | undefined {
    return this.pending.get(id);
  }

  /** Tất cả yêu cầu đang chờ (sắp xếp theo thời gian tạo). */
  listPending(): PendingConfirmation[] {
    return [...this.pending.values()]
      .filter((e) => e.status === 'pending')
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  /** Tất cả yêu cầu (chờ + đã resolve) theo thời gian tạo. */
  listAll(): PendingConfirmation[] {
    return [...this.pending.values()].sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  /**
   * Ghi quyết định cho một yêu cầu. Trả về entry đã cập nhật, hoặc
   * undefined khi id không tồn tại / đã resolve rồi (quyết định muộn
   * bị bỏ qua — run đã đi tiếp theo timeout).
   */
  resolve(
    id: string,
    resolution: ConfirmationResolution,
    decidedBy: 'user' | 'system' = 'user',
  ): PendingConfirmation | undefined {
    const entry = this.pending.get(id);
    if (!entry || entry.status !== 'pending') return undefined;
    this.clearTimer(id);
    entry.resolvedAtMs = Date.now();
    entry.decidedBy = decidedBy;
    if (resolution.decision === 'approve') {
      entry.status = 'approved';
    } else if (resolution.decision === 'deny') {
      entry.status = 'denied';
    } else {
      entry.status = 'edited';
      entry.editedArgs = resolution.args;
    }
    this.appendAudit(entry);
    return entry;
  }

  /**
   * Đánh dấu hết hạn (timeout). Mặc định denied về mặt thực thi —
   * caller (coordinator/loop) phải tự từ chối tool call tương ứng.
   */
  expire(id: string, decidedBy: 'timeout' | 'system' = 'timeout'): PendingConfirmation | undefined {
    const entry = this.pending.get(id);
    if (!entry || entry.status !== 'pending') return undefined;
    this.clearTimer(id);
    entry.status = 'expired';
    entry.resolvedAtMs = Date.now();
    entry.decidedBy = decidedBy;
    this.appendAudit(entry);
    try {
      this.onExpire?.(entry);
    } catch {
      // Callback hết hạn không được phá queue.
    }
    return entry;
  }

  /** Audit log đầy đủ (mới nhất cuối). */
  auditLog(): ConfirmationAuditEntry[] {
    return [...this.audit];
  }

  /** Audit log của một bot. */
  auditLogForBot(botId: string): ConfirmationAuditEntry[] {
    return this.audit.filter((e) => e.botId === botId);
  }

  /** Số quyết định theo trạng thái (để UI thống kê). */
  countsByStatus(): Record<PendingConfirmationStatus, number> {
    const counts: Record<PendingConfirmationStatus, number> = {
      pending: 0,
      approved: 0,
      denied: 0,
      edited: 0,
      expired: 0,
    };
    for (const entry of this.pending.values()) counts[entry.status] += 1;
    return counts;
  }

  /** Serialise audit + entries (để host persist ra file nếu muốn). */
  toJSON(): { entries: PendingConfirmation[]; audit: ConfirmationAuditEntry[] } {
    return { entries: this.listAll(), audit: this.auditLog() };
  }

  /** Khôi phục từ `toJSON()` (chỉ khôi phục audit + entry đã resolve;
   * entry pending được khôi phục thành expired — an toàn hơn là treo). */
  fromJSON(data: { entries?: PendingConfirmation[]; audit?: ConfirmationAuditEntry[] }): void {
    this.pending.clear();
    this.audit.length = 0;
    for (const entry of data.entries ?? []) {
      const restored: PendingConfirmation = {
        ...entry,
        status: entry.status === 'pending' ? 'expired' : entry.status,
        resolvedAtMs: entry.resolvedAtMs ?? Date.now(),
        decidedBy: entry.decidedBy ?? 'system',
      };
      this.pending.set(restored.id, restored);
    }
    for (const line of data.audit ?? []) this.appendAuditLine(line);
  }

  private appendAuditLine(line: ConfirmationAuditEntry): void {
    this.audit.push(line);
    while (this.audit.length > this.maxAuditEntries) this.audit.shift();
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  private appendAudit(entry: PendingConfirmation): void {
    const line: ConfirmationAuditEntry = {
      confirmationId: entry.id,
      callId: entry.callId,
      botId: entry.botId,
      toolName: entry.toolName,
      riskLevel: entry.risk.level,
      riskScore: entry.risk.score,
      policy: entry.policy,
      status: entry.status,
      decidedBy: entry.decidedBy ?? 'system',
      atMs: entry.resolvedAtMs ?? Date.now(),
      ...(entry.editedArgs !== undefined ? { editedArgs: entry.editedArgs } : {}),
    };
    // Một entry chỉ audit một lần (resolve rồi expire muộn không ghi đúp).
    const already = this.audit.some((a) => a.confirmationId === line.confirmationId);
    if (already) return;
    this.appendAuditLine(line);
  }
}
