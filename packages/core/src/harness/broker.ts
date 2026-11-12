/**
 * Permission broker tập trung (M5) — phần M1/M2 còn nợ.
 *
 * CLI xin duyệt (Codex approval server→client, ACP
 * `session/request_permission`) thì request chảy về ĐÂY thay vì mỗi
 * driver tự từ chối trong im lặng:
 *
 * - Chính sách mặc định: TỪ CHỐI fail-closed. Không có UI handler
 *   (không ai nghe thẻ duyệt) → từ chối ngay, không chờ.
 * - Có UI handler: broker đưa request thành "thẻ duyệt đang chờ"
 *   (pending) và chờ quyết định của user qua EITHER `uiHandler`
 *   (promise) HOẶC `decide(requestId, allowed)` (UI gọi sau, vd từ
 *   Local API/WS). Hết `timeoutMs` (mặc định 120s) mà chưa có quyết
 *   định → TỪ CHỐI, không treo turn vĩnh viễn.
 * - Mọi quyết định đều ghi log (`decisions` + callback `onDecision`
 *   để bus/log NDJSON ghi lại): cho phép/từ chối + lý do + nguồn.
 * - TUYỆT ĐỐI KHÔNG có `bypassPermissions` hay auto-approve mặc định:
 *   `allowed=true` chỉ tới từ quyết định tường minh của user qua
 *   `uiHandler`/`decide()`. Một số method không có đường cho phép an
 *   toàn (`allowable=false`, vd Codex — shape allow chưa xác minh)
 *   thì broker từ chối ngay với lý do rõ, dù UI có muốn cho phép.
 * - `denyAll(botId?)`: bot bị xoá / shutdown trong lúc chờ → mọi
 *   request đang chờ bị từ chối (không treo CLI).
 */

import { randomUUID } from 'node:crypto';

import type {
  HarnessPermissionRequest,
  PermissionDecisionRecord,
  PermissionDecisionSource,
} from './types';

/** Timeout mặc định chờ user quyết (ms) — đủ để đọc thẻ, không treo turn. */
export const PERMISSION_DEFAULT_TIMEOUT_MS = 120_000;

export interface PermissionBrokerOptions {
  /** Timeout chờ quyết định (ms); mặc định 120s. */
  timeoutMs?: number;
  /**
   * Handler UI: nhận request đang chờ, trả true (cho phép) / false /
   * null (từ chối) — hoặc một promise. Không set = không có UI →
   * từ chối ngay (fail-closed). Handler throw thì coi như từ chối.
   */
  uiHandler?: (
    request: HarnessPermissionRequest,
  ) => boolean | null | undefined | Promise<boolean | null | undefined>;
  /** Callback mỗi khi có quyết định (để bus/log ghi audit). */
  onDecision?: (decision: PermissionDecisionRecord) => void;
  /** Callback mỗi khi có request mới (để bus publish approval_request). */
  onRequest?: (request: HarnessPermissionRequest) => void;
  /** Nơi ghi cảnh báo. */
  logger?: { warn(message: string): void };
}

export interface PermissionRequestInput {
  botId: string;
  threadId?: string;
  engine: string;
  method: string;
  detail?: string;
  /** False khi method không có đường cho phép an toàn (vd Codex). Mặc định true. */
  allowable?: boolean;
}

interface PendingPermission {
  request: HarnessPermissionRequest;
  resolve: (allowed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
}

export class PermissionBroker {
  private readonly timeoutMs: number;
  private readonly uiHandler?: PermissionBrokerOptions['uiHandler'];
  private readonly onDecision?: PermissionBrokerOptions['onDecision'];
  private readonly onRequest?: PermissionBrokerOptions['onRequest'];
  private readonly warn: (message: string) => void;
  private readonly pending = new Map<string, PendingPermission>();
  private readonly decisions: PermissionDecisionRecord[] = [];

  constructor(options: PermissionBrokerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? PERMISSION_DEFAULT_TIMEOUT_MS;
    this.uiHandler = options.uiHandler;
    this.onDecision = options.onDecision;
    this.onRequest = options.onRequest;
    this.warn = options.logger
      ? (message: string) => options.logger?.warn(message)
      : () => undefined;
  }

  /** Số request đang chờ quyết định. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Các request đang chờ (bản sao). */
  listPending(): HarnessPermissionRequest[] {
    return [...this.pending.values()].map((p) => ({ ...p.request }));
  }

  /** Toàn bộ quyết định đã ghi (bản sao, theo thứ tự thời gian). */
  listDecisions(): PermissionDecisionRecord[] {
    return [...this.decisions];
  }

  /**
   * Hỏi broker một permission request. Resolve `true` chỉ khi user
   * cho phép tường minh; mọi đường khác (không UI, timeout, shutdown,
   * method không cho phép được) đều resolve `false`. Không bao giờ
   * treo: luôn resolve trong `timeoutMs`.
   */
  async request(input: PermissionRequestInput): Promise<boolean> {
    const request: HarnessPermissionRequest = {
      requestId: randomUUID(),
      botId: input.botId,
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      engine: input.engine,
      method: input.method,
      ...(input.detail !== undefined ? { detail: input.detail.slice(0, 500) } : {}),
      allowable: input.allowable !== false,
      requestedAt: new Date().toISOString(),
    };
    if (!request.allowable) {
      this.record(request, false, 'method này chưa có đường cho phép an toàn (vd Codex: shape allow chưa xác minh) — từ chối.', 'allow-not-supported', 0);
      return false;
    }
    if (!this.uiHandler) {
      this.record(request, false, 'không có UI duyệt (không UI handler) — từ chối theo mặc định fail-closed.', 'default-deny', 0);
      return false;
    }
    try {
      this.onRequest?.(request);
    } catch {
      // Callback log lỗi không được làm hỏng quyết định.
    }
    const startedAt = Date.now();
    const promise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(request.requestId)) return;
        this.pending.delete(request.requestId);
        this.record(request, false, `hết ${this.timeoutMs}ms chờ user quyết — từ chối, không treo turn.`, 'timeout', Date.now() - startedAt);
        resolve(false);
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(request.requestId, { request, resolve, timer, startedAt });
    });
    // Hỏi UI (không await ở đây — decide() / timeout cũng resolve được).
    void Promise.resolve()
      .then(() => this.uiHandler?.(request))
      .then((answer) => {
        const pending = this.pending.get(request.requestId);
        if (!pending) return; // Đã quyết bằng decide()/timeout trước đó.
        this.pending.delete(request.requestId);
        clearTimeout(pending.timer);
        const allowed = answer === true;
        this.record(
          request,
          allowed,
          allowed ? 'user cho phép qua thẻ duyệt.' : 'user từ chối qua thẻ duyệt.',
          'ui',
          Date.now() - startedAt,
        );
        pending.resolve(allowed);
      })
      .catch((err: Error) => {
        const pending = this.pending.get(request.requestId);
        if (!pending) return;
        this.pending.delete(request.requestId);
        clearTimeout(pending.timer);
        this.record(request, false, `UI handler lỗi (${err.message}) — từ chối fail-closed.`, 'ui', Date.now() - startedAt);
        pending.resolve(false);
      });
    return promise;
  }

  /**
   * UI quyết một request đang chờ (đường thẻ duyệt qua Local API/WS:
   * user bấm Allow/Deny). Trả true khi request đang chờ thật.
   * Quyết định qua đây thắng UI handler (nếu handler chưa trả lời).
   */
  decide(requestId: string, allowed: boolean, reason?: string): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    this.record(
      pending.request,
      allowed,
      reason ?? (allowed ? 'user cho phép qua thẻ duyệt.' : 'user từ chối qua thẻ duyệt.'),
      'ui',
      Date.now() - pending.startedAt,
    );
    pending.resolve(allowed);
    return true;
  }

  /**
   * Từ chối mọi request đang chờ (toàn bộ, hoặc chỉ của một bot).
   * Dùng khi bot bị xoá / shutdown — CLI không treo chờ quyết định.
   */
  denyAll(botId?: string): number {
    let count = 0;
    for (const [requestId, pending] of [...this.pending]) {
      if (botId !== undefined && pending.request.botId !== botId) continue;
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      this.record(
        pending.request,
        false,
        botId !== undefined
          ? `bot "${botId}" bị xoá trong lúc chờ quyết — từ chối.`
          : 'harness shutdown trong lúc chờ quyết — từ chối.',
        'shutdown',
        Date.now() - pending.startedAt,
      );
      pending.resolve(false);
      count += 1;
    }
    return count;
  }

  private record(
    request: HarnessPermissionRequest,
    allowed: boolean,
    reason: string,
    source: PermissionDecisionSource,
    waitedMs: number,
  ): void {
    const decision: PermissionDecisionRecord = {
      requestId: request.requestId,
      botId: request.botId,
      engine: request.engine,
      method: request.method,
      ...(request.detail !== undefined ? { detail: request.detail } : {}),
      allowed,
      reason,
      source,
      decidedAt: new Date().toISOString(),
      waitedMs,
    };
    this.decisions.push(decision);
    try {
      this.onDecision?.(decision);
    } catch (err) {
      this.warn(`permission broker: onDecision lỗi: ${(err as Error).message}`);
    }
  }
}
