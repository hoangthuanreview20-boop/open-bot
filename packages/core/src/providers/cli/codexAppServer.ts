/**
 * Codex app-server client (M2) — JSON-RPC trên stdio của `codex app-server`.
 *
 * Protocol đã KIỂM CHỨNG bằng chính CLI thật trên máy phát triển
 * (codex 0.164.0-alpha.9, chưa đăng nhập):
 * - `codex app-server generate-json-schema --out <dir>` sinh schema
 *   JSON của toàn bộ protocol (105 client request, 10 server request,
 *   85 server notification) — các tên method/param dưới đây lấy từ
 *   schema đó, không phải suy đoán.
 * - Probe live: `initialize` trả `{userAgent, codexHome,
 *   platformFamily, platformOs}`; `thread/start` với
 *   `{cwd, approvalPolicy:'on-request'}` trả `result.thread.id`
 *   (UUIDv7) + notification `thread/started` — KHÔNG cần đăng nhập
 *   để mở thread. `thread/resume` cho thread vừa tạo bởi process
 *   khác trả lỗi JSON-RPC -32600 "no rollout found for thread id …"
 *   (rollout chưa kịp ghi đĩa khi process cũ thoát) — vì vậy driver
 *   PHẢI fallback sang `thread/start` + gửi lại history khi resume
 *   lỗi (xem codex.ts).
 *
 * CHƯA kiểm chứng live (không có Codex đăng nhập trên máy này):
 * - `turn/start` + streaming `item/agentMessage/delta` +
 *   `turn/completed` khi chạy thật (tên method/param đã khớp schema
 *   sinh ra từ CLI thật, nhưng chưa thấy server thật gửi chúng).
 * - Hành vi approval khi turn thật cần duyệt (shape deny thì đã khớp
 *   schema: xem `denyApproval()`).
 *
 * Luồng một turn:
 *   initialize() → startThread()/resumeThread() → startTurn()
 *   → server gửi `item/agentMessage/delta` (text) rồi
 *   `turn/completed` (kèm `turn.error` khi lỗi, `turn.items` chứa
 *   agentMessage đầy đủ để fallback khi không nhận được delta nào).
 * Usage theo turn lấy từ notification `thread/tokenUsage/updated`
 * (`tokenUsage.last` — số của turn vừa rồi, không phải tổng chạy).
 *
 * APPROVAL — fail-closed (chưa có permission broker, mốc M5):
 * server gửi request xin duyệt (vd lệnh shell, sửa file) thì client
 * TRẢ LỜI TỪ CHỐI bằng đúng shape deny của từng method (lấy từ schema
 * thật của CLI), KHÔNG bao giờ approve, KHÔNG dùng bypass:
 * - `execCommandApproval` / `applyPatchApproval`:
 *   `{decision: {denied: {rejection: '…'}}}`.
 * - `item/commandExecution/requestApproval` /
 *   `item/fileChange/requestApproval`: `{decision: 'decline'}`
 *   (từ chối nhưng turn tiếp tục).
 * - Mọi request server→client khác (permissions, tool/requestUserInput,
 *   MCP elicitation, item/tool/call, attestation, refresh token…):
 *   trả JSON-RPC error -32000 (không hỗ trợ) — fail-closed.
 * Mỗi lần từ chối đều emit event `approval_denied` để log/UI thấy.
 *
 * Lớp này chỉ lo protocol; vòng đời process/spawn/env nằm ở codex.ts.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { ToolCall } from '../../types';
import type { CliEvent } from './types';
import type { CliPermissionHandler } from './types';
import { JsonRpcResponseError, JsonRpcStdioClient } from './jsonRpc';

/** Approval policy gửi kèm thread/start: hỏi khi cần (để ta từ chối tường minh). */
export const CODEX_APPROVAL_POLICY = 'on-request';

/** Số lần từ chối approval tối đa ghi vào event trước khi chỉ đếm (tránh spam log). */
const APPROVAL_EVENT_DETAIL_LIMIT = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Trả lời TỪ CHỐI cho một approval request của server, đúng shape deny
 * của từng method theo schema thật của Codex 0.164.0-alpha.9.
 * Trả `undefined` (= throw) khi method không có shape deny đã biết —
 * JsonRpcStdioClient sẽ trả JSON-RPC error thay cho result.
 */
export function denyCodexApproval(
  method: string,
  reason: string,
): Record<string, unknown> | undefined {
  switch (method) {
    case 'execCommandApproval':
    case 'applyPatchApproval':
      // ReviewDecision.DeniedReviewDecision (schema thật).
      return { decision: { denied: { rejection: reason } } };
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      // CommandExecutionApprovalDecision / FileChangeApprovalDecision:
      // 'decline' = từ chối, turn tiếp tục (không interrupt).
      return { decision: 'decline' };
    default:
      return undefined;
  }
}

/** True khi method là một approval request của server (cần trả lời deny). */
export function isCodexApprovalRequest(method: string): boolean {
  return (
    method === 'execCommandApproval' ||
    method === 'applyPatchApproval' ||
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval' ||
    method === 'item/permissions/requestApproval'
  );
}

export interface CodexTurnResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
  /** Số approval đã bị từ chối trong turn này. */
  approvalsDenied: number;
}

export interface CodexAppServerClientOptions {
  /** Callback nhận event chuẩn của CLI (text/tool_call/result/error/approval_denied). */
  onCliEvent?: (event: CliEvent) => void;
  /**
   * M5 — handler permission tập trung (broker). Không set thì client
   * tự từ chối fail-closed như M2. Khi set, broker vẫn là nơi quyết
   * (mặc định từ chối; timeout → từ chối); nhưng shape trả lời "cho
   * phép" của Codex chưa xác minh được từ schema thật nên broker luôn
   * gọi handler với `allowable: false` và client LUÔN đi đường deny
   * (ghi rõ lý do) — xem `handleServerRequest`.
   */
  permissionHandler?: CliPermissionHandler;
  /** Nơi ghi cảnh báo. */
  logger?: { warn(message: string): void };
}

interface PendingTurn {
  resolve: (res: CodexTurnResult) => void;
  reject: (err: Error) => void;
  threadId: string;
  textParts: string[];
  usage?: { inputTokens: number; outputTokens: number };
  approvalsDenied: number;
}

/**
 * Client protocol Codex app-server, gắn vào process `codex app-server`
 * đã spawn sẵn. Không sở hữu process.
 */
export class CodexAppServerClient {
  private readonly rpc: JsonRpcStdioClient;
  private readonly onCliEvent?: (event: CliEvent) => void;
  private readonly warn: (message: string) => void;
  private initialized = false;
  private pendingTurn: PendingTurn | null = null;
  /** Tổng số approval đã từ chối (mọi turn) — để test + chẩn đoán. */
  private totalApprovalsDenied = 0;
  /** M5 — handler permission tập trung (broker), xem options. */
  private permissionHandler?: CliPermissionHandler;

  constructor(child: ChildProcessWithoutNullStreams, options: CodexAppServerClientOptions = {}) {
    this.onCliEvent = options.onCliEvent;
    this.permissionHandler = options.permissionHandler;
    this.warn = options.logger
      ? (message: string) => options.logger?.warn(message)
      : (message: string) => console.warn(`[CodexAppServer] ${message}`);
    this.rpc = new JsonRpcStdioClient(child, {
      logger: { warn: this.warn },
      onNotification: (method, params) => this.handleNotification(method, params),
      onRequest: (method, params) => this.handleServerRequest(method, params),
    });
  }

  /** Stats transport (để test + chẩn đoán). */
  getStats(): ReturnType<JsonRpcStdioClient['getStats']> {
    return this.rpc.getStats();
  }

  /** Tổng số approval đã bị từ chối kể từ khi client này sống. */
  get approvalsDeniedTotal(): number {
    return this.totalApprovalsDenied;
  }

  /** M5 — gắn/đổi handler permission tập trung (broker) sau khi tạo client. */
  setPermissionHandler(handler: CliPermissionHandler | undefined): void {
    this.permissionHandler = handler;
  }

  /** True khi đã initialize xong. */
  get isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Handshake `initialize` + notification `initialized`.
   * Response thật: `{userAgent, codexHome, platformFamily, platformOs}`
   * (đã kiểm chứng live trên codex 0.164.0-alpha.9).
   */
  async initialize(): Promise<void> {
    const result = await this.rpc.request('initialize', {
      clientInfo: { name: 'open-bot', version: '0.44' },
    });
    if (!isRecord(result)) {
      throw new Error('Codex app-server: `initialize` trả về không phải object.');
    }
    this.initialized = true;
    this.rpc.notify('initialized');
  }

  /**
   * Mở thread mới. `baseInstructions` = system prompt của bot (đi vào
   * thread ngay từ đầu; đổi system prompt thì mở thread mới).
   * Trả thread id (`result.thread.id` — đã kiểm chứng live).
   */
  async startThread(options: { cwd?: string; baseInstructions?: string }): Promise<string> {
    const params: Record<string, unknown> = { approvalPolicy: CODEX_APPROVAL_POLICY };
    if (options.cwd) params['cwd'] = options.cwd;
    if (options.baseInstructions && options.baseInstructions.trim().length > 0) {
      params['baseInstructions'] = options.baseInstructions;
    }
    const result = await this.rpc.request('thread/start', params);
    const threadId = extractThreadId(result);
    if (!threadId) {
      throw new Error('Codex app-server: `thread/start` không trả thread id.');
    }
    return threadId;
  }

  /**
   * Resume thread đã có (resumeCursor = thread id). Throw khi server
   * báo lỗi (vd -32600 "no rollout found") — caller fallback sang
   * startThread() + gửi lại history (xem codex.ts).
   */
  async resumeThread(threadId: string, options: { cwd?: string } = {}): Promise<string> {
    const params: Record<string, unknown> = {
      threadId,
      approvalPolicy: CODEX_APPROVAL_POLICY,
    };
    if (options.cwd) params['cwd'] = options.cwd;
    const result = await this.rpc.request('thread/resume', params);
    const resumedId = extractThreadId(result) ?? threadId;
    return resumedId;
  }

  /**
   * Bắt đầu một turn: gửi `turn/start` với các user message mới.
   * Completion KHÔNG chờ response của request (server có thể ack sớm)
   * mà chờ notification `turn/completed`; response lỗi (nếu có) thì
   * fail turn ngay. Chỉ một turn chạy tại một thời điểm trên client này.
   */
  startTurn(threadId: string, userTexts: string[]): Promise<CodexTurnResult> {
    if (this.pendingTurn) {
      return Promise.reject(
        new Error('Codex app-server: đã có một turn đang chạy — chờ turn đó xong rồi gửi tiếp.'),
      );
    }
    const promise = new Promise<CodexTurnResult>((resolve, reject) => {
      this.pendingTurn = {
        resolve,
        reject,
        threadId,
        textParts: [],
        approvalsDenied: 0,
      };
    });
    // Tránh unhandled rejection khi failTurn chạy trước khi caller await.
    promise.catch(() => undefined);
    const input = userTexts.map((text) => ({ type: 'text', text }));
    // Không await: completion qua notification; chỉ bắt lỗi response.
    this.rpc
      .requestNoWait('turn/start', { threadId, input })
      .catch((err: Error) => {
        if (this.pendingTurn?.threadId === threadId) {
          this.failTurn(
            new Error(`Codex app-server: \`turn/start\` lỗi: ${err.message}`),
          );
        }
      });
    return promise;
  }

  /** True khi đang có turn chạy. */
  get hasPendingTurn(): boolean {
    return this.pendingTurn !== null;
  }

  /** Fail turn đang chạy (process chết / abort / dispose). */
  failTurn(err: Error): void {
    const turn = this.pendingTurn;
    if (!turn) return;
    this.pendingTurn = null;
    turn.reject(err);
  }

  /** Reject mọi request đang chờ của transport (gọi khi process chết). */
  failAllPending(err: Error): void {
    this.rpc.failAll(err);
    this.failTurn(err);
  }

  /** Ngừng đọc stdout (không kill process — caller lo việc đó). */
  close(): void {
    this.rpc.close();
  }

  // ------------------------------------------------------------------
  // Server → client
  // ------------------------------------------------------------------

  private handleNotification(method: string, params: unknown): void {
    const turn = this.pendingTurn;
    if (!isRecord(params)) {
      if (method === 'error') this.warn('Codex app-server gửi notification `error` không có params.');
      return;
    }
    switch (method) {
      case 'item/agentMessage/delta': {
        // Params thật: {delta, itemId, threadId, turnId} (schema).
        const delta = asString(params['delta']);
        if (turn && delta) {
          turn.textParts.push(delta);
          this.emit({ type: 'text', delta });
        }
        break;
      }
      case 'thread/tokenUsage/updated': {
        // Params thật: {tokenUsage: {last: {inputTokens, outputTokens}, total}}.
        const tokenUsage = params['tokenUsage'];
        if (turn && isRecord(tokenUsage)) {
          const last = tokenUsage['last'];
          if (isRecord(last)) {
            const inputTokens = asNumber(last['inputTokens']) ?? 0;
            const outputTokens = asNumber(last['outputTokens']) ?? 0;
            turn.usage = { inputTokens, outputTokens };
          }
        }
        break;
      }
      case 'turn/completed': {
        // Params thật: {threadId, turn: {error?, items}}.
        if (!turn) break;
        if (asString(params['threadId']) && params['threadId'] !== turn.threadId) break;
        const turnObj = params['turn'];
        if (!isRecord(turnObj)) {
          this.failTurn(new Error('Codex app-server: `turn/completed` không có thông tin turn.'));
          break;
        }
        const error = turnObj['error'];
        if (isRecord(error)) {
          const message = asString(error['message']) ?? 'Turn Codex lỗi (không rõ chi tiết).';
          this.failTurn(new Error(`Codex app-server: ${message.slice(0, 500)}`));
          break;
        }
        const text = turn.textParts.join('') || extractAgentMessageText(turnObj['items']);
        const result: CodexTurnResult = {
          text,
          usage: turn.usage,
          approvalsDenied: turn.approvalsDenied,
        };
        this.pendingTurn = null;
        this.emit({ type: 'result', text, usage: turn.usage });
        turn.resolve(result);
        break;
      }
      case 'item/completed': {
        // Item hoàn thành (vd tool call của Codex): surface qua event
        // tool_call để log/UI — open-bot KHÔNG thực thi lại (CLI sở
        // hữu vòng tool của nó, như driver Claude M1). Chỉ ghi nhận
        // khi item là command/fileChange/mcpToolCall có tên rõ.
        const item = params['item'];
        if (turn && isRecord(item)) {
          const callEvent = toToolCallEvent(item);
          if (callEvent) this.emit(callEvent);
        }
        break;
      }
      case 'error': {
        const message = asString(params['message']) ?? 'Codex app-server báo lỗi (không rõ chi tiết).';
        if (turn) {
          this.failTurn(new Error(`Codex app-server: ${message.slice(0, 500)}`));
        } else {
          this.warn(message);
        }
        break;
      }
      default:
        // thread/started, turn/started, item/started, plan/delta,
        // reasoning delta… — M2 chưa cần, bỏ qua (không crash turn).
        break;
    }
  }

  /**
   * Trả lời request từ server. Approval → hỏi broker (M5) rồi TỪ CHỐI
   * fail-closed (xem đầu file). Mọi thứ khác → JSON-RPC error (không hỗ trợ).
   *
   * Vì sao broker vẫn được hỏi dù kết quả luôn là deny: broker ghi
   * request + quyết định vào log audit, publish event approval_request
   * lên bus (UI thấy thẻ chờ rồi thấy quyết định từ chối + lý do),
   * và áp timeout — turn không treo chờ user với một request mà
   * open-bot không thể cho phép an toàn. "Cho phép" với Codex cần
   * shape allow đúng theo schema thật của CLI — chưa xác minh được
   * (chỉ có shape deny, xem `denyCodexApproval`) nên không đoán.
   */
  private async handleServerRequest(method: string, params: unknown): Promise<unknown> {
    const reason =
      'open-bot chưa có permission broker (mốc M5): mọi yêu cầu duyệt của Codex đều bị từ chối.';
    if (isCodexApprovalRequest(method)) {
      const detail = describeApprovalParams(params).slice(0, APPROVAL_EVENT_DETAIL_LIMIT);
      this.emit({ type: 'approval_request', method, detail });
      let brokerReason = reason;
      if (this.permissionHandler) {
        try {
          // allowable=false: broker từ chối ngay + ghi log (không chờ UI
          // cho một request không thể cho phép được).
          await this.permissionHandler({ method, detail, allowable: false });
          brokerReason =
            'permission broker: Codex chưa có đường cho phép an toàn (shape allow chưa xác minh từ schema thật) — từ chối.';
        } catch (err) {
          this.warn(`permission broker lỗi: ${(err as Error).message} — từ chối fail-closed.`);
        }
      }
      const denied = denyCodexApproval(method, brokerReason);
      this.totalApprovalsDenied += 1;
      if (this.pendingTurn) this.pendingTurn.approvalsDenied += 1;
      this.emit({
        type: 'approval_denied',
        method,
        detail,
      });
      if (denied) return denied;
      // Method approval nhưng chưa biết shape deny → trả lỗi JSON-RPC
      // (server coi như bị từ chối) thay vì đoán shape sai.
      throw new JsonRpcResponseError({
        code: -32000,
        message: brokerReason,
      });
    }
    // item/tool/call, item/tool/requestUserInput, mcp elicitation,
    // attestation, refresh token… — không hỗ trợ ở M2.
    throw new JsonRpcResponseError({
      code: -32601,
      message: `open-bot (M2) không hỗ trợ request "${method}" từ Codex app-server.`,
    });
  }

  private emit(event: CliEvent): void {
    try {
      this.onCliEvent?.(event);
    } catch {
      // Callback của caller lỗi không được làm hỏng turn.
    }
  }
}

/** Thread id từ result của thread/start hoặc thread/resume (`result.thread.id`). */
function extractThreadId(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  const thread = result['thread'];
  if (isRecord(thread)) return asString(thread['id']);
  // Phòng thủ: một số bản có thể trả threadId trực tiếp.
  return asString(result['threadId']) ?? asString(result['id']);
}

/**
 * Text đầy đủ của turn từ `turn.items` (fallback khi không nhận được
 * delta nào): nối các item `agentMessage` theo thứ tự.
 */
function extractAgentMessageText(items: unknown): string {
  if (!Array.isArray(items)) return '';
  const parts: string[] = [];
  for (const item of items) {
    if (isRecord(item) && item['type'] === 'agentMessage') {
      const text = asString(item['text']);
      if (text) parts.push(text);
    }
  }
  return parts.join('');
}

/**
 * Dịch một `item/completed` thành event tool_call (surface-only).
 * Chỉ nhận các item có tên tool rõ ràng; còn lại trả undefined.
 */
function toToolCallEvent(item: Record<string, unknown>): { type: 'tool_call'; call: ToolCall } | undefined {
  const type = asString(item['type']);
  if (!type) return undefined;
  // Các item tool của Codex: commandExecution, fileChange, mcpToolCall…
  if (type === 'commandExecution') {
    const command = asString(item['command']) ?? asString(item['cmd']) ?? '';
    if (!command) return undefined;
    return {
      type: 'tool_call',
      call: { id: asString(item['id']) ?? `codex-command`, name: 'commandExecution', args: { command } },
    };
  }
  if (type === 'fileChange') {
    return {
      type: 'tool_call',
      call: { id: asString(item['id']) ?? 'codex-fileChange', name: 'fileChange', args: {} },
    };
  }
  if (type === 'mcpToolCall') {
    const name = asString(item['toolName']) ?? asString(item['name']);
    if (!name) return undefined;
    const args = isRecord(item['arguments']) ? (item['arguments'] as Record<string, unknown>) : {};
    return {
      type: 'tool_call',
      call: { id: asString(item['id']) ?? `codex-${name}`, name, args },
    };
  }
  return undefined;
}

/** Mô tả ngắn gọn một approval request (để log — không chứa nội dung nhạy cảm dài). */
function describeApprovalParams(params: unknown): string {
  if (!isRecord(params)) return '';
  const callId = asString(params['callId']);
  const command = isRecord(params['command']) ? asString(params['command']['cmd']) : undefined;
  const bits: string[] = [];
  if (callId) bits.push(`callId=${callId}`);
  if (command) bits.push(`command=${command.slice(0, 200)}`);
  const reason = asString(params['reason']);
  if (reason) bits.push(`reason=${reason.slice(0, 200)}`);
  return bits.join('; ');
}
