/**
 * ACP client chung (M2, tái dùng chung từ M3) — Agent Client Protocol qua
 * JSON-RPC NDJSON trên stdio. M2 dùng cho Grok CLI (`grok … agent stdio`);
 * M3 tách thành tầng chung cho mọi CLI nói ACP (Grok, OpenCode,
 * Gemini CLI, Cursor CLI, custom ACP) qua `BaseAcpCliProvider`
 * (`acpProvider.ts`) — driver riêng chỉ khai báo lệnh spawn + env +
 * (tuỳ chọn) methodId `authenticate`.
 *
 * Protocol theo Agent Client Protocol công khai (agentclientprotocol.com)
 * — **CHƯA kiểm chứng trên Grok CLI thật** (máy này không có `grok`;
 * chỉ có lệnh spawn + cơ chế login từ docs/research-detected-cli-
 * providers.md §2.8 và docs/research-openmausbot.md §4.4, đã kiểm chứng
 * bằng code OpenMausBot với grok 1.0.0/1.0.25/1.0.41). Các tên
 * method/param dưới đây là ACP chuẩn, nhưng Grok CLI thật có thể khác
 * ở chi tiết (vd shape `usage_update`, field của `session/new`) —
 * client đã viết phòng thủ: field thiếu/lạ thì dùng giá trị rỗng thay
 * vì throw; cần chạy thật trên máy có Grok đăng nhập trước khi coi M2
 * là xong (xem providers/cli/README.md).
 *
 * Luồng một turn:
 *   initialize() → session/new (hoặc session/load để resume) →
 *   session/prompt → server gửi notification `session/update`
 *   (`agent_message_chunk` = text, `tool_call` = tool của CLI,
 *   `usage_update` = usage) rồi TRẢ RESPONSE `{stopReason}` — response
 *   này là tín hiệu turn kết thúc (khác Codex: Codex kết thúc bằng
 *   notification `turn/completed`).
 *
 * PERMISSION — fail-closed (permission broker ở mốc M5, xem
 * harness/broker.ts): server gửi request `session/request_permission`
 * (kèm `options` có `kind: allow_once | allow_always | reject_once |
 * reject_always`) thì client hỏi `permissionHandler` (broker) khi có;
 * broker cho phép (chỉ khi user quyết tường minh) thì chọn
 * `allow_once`, còn lại chọn `reject_once` (không có thì
 * `reject_always`, không nữa thì trả `{outcome: {outcome:
 * 'cancelled'}}`). Không có broker thì từ chối như M2. Mỗi request
 * đều emit event `approval_request` trước khi quyết, mỗi lần từ chối
 * đều emit event `approval_denied` để log/UI thấy.
 *
 * Các request khác từ server (`fs/read_text_file`,
 * `fs/write_text_file`, terminal…) đều bị trả JSON-RPC error -32601
 * (không cấp quyền đọc/ghi file hay terminal cho server ở M2).
 *
 * Lớp này chỉ lo protocol; vòng đời process/spawn/env/session nằm ở
 * `BaseAcpCliProvider` (acpProvider.ts) — driver ACP riêng chỉ khai
 * báo lệnh spawn + env + methodId authenticate (nếu có).
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { CliEvent } from './types';
import type { CliPermissionHandler } from './types';
import { JsonRpcResponseError, JsonRpcStdioClient } from './jsonRpc';

/**
 * ACP protocol version mà client này nói. ACP chuẩn dùng số nguyên
 * (1 = bản đầu tiên mà các CLI hiện tại dùng). Server trả
 * `protocolVersion` của nó trong response `initialize` — client chấp
 * nhận mọi version (chỉ cảnh báo khi khác) thay vì fail, vì các CLI
 * có thể báo version mới hơn mà vẫn tương thích.
 */
export const ACP_PROTOCOL_VERSION = 1;

/** stopReason mà ACP trả trong response của `session/prompt`. */
export type AcpStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export interface AcpPromptResult {
  text: string;
  stopReason: AcpStopReason;
  usage?: { inputTokens: number; outputTokens: number };
  /** Số approval đã bị từ chối trong turn này. */
  approvalsDenied: number;
}

export interface AcpClientOptions {
  /** Callback nhận event chuẩn của CLI (text/tool_call/result/error/approval_denied). */
  onCliEvent?: (event: CliEvent) => void;
  /**
   * M5 — handler permission tập trung (broker). Không set thì client
   * tự từ chối fail-closed như M2. Khi set, broker quyết (mặc định từ
   * chối; có UI thì chờ quyết, timeout → từ chối); broker cho phép
   * thì client chọn option `allow_once` (không có thì `allow_always`).
   */
  permissionHandler?: CliPermissionHandler;
  /** Nơi ghi cảnh báo. */
  logger?: { warn(message: string): void };
}

interface PendingPrompt {
  resolve: (res: AcpPromptResult) => void;
  reject: (err: Error) => void;
  sessionId: string;
  textParts: string[];
  usage?: { inputTokens: number; outputTokens: number };
  approvalsDenied: number;
}

/**
 * Client ACP gắn vào process CLI đã spawn sẵn ở chế độ ACP stdio.
 * Không sở hữu process.
 */
export class AcpClient {
  private readonly rpc: JsonRpcStdioClient;
  private readonly onCliEvent?: (event: CliEvent) => void;
  private readonly warn: (message: string) => void;
  private initialized = false;
  private pendingPrompt: PendingPrompt | null = null;
  /** Tổng số approval đã từ chối (mọi turn) — để test + chẩn đoán. */
  private totalApprovalsDenied = 0;
  /** M5 — handler permission tập trung (broker), xem options. */
  private permissionHandler?: CliPermissionHandler;
  /** protocolVersion mà server báo trong `initialize` (nếu có). */
  private serverProtocolVersion?: number;
  /** Thông tin agent mà server báo (tên/version, nếu có). */
  private agentInfo?: { name?: string; version?: string };

  constructor(child: ChildProcessWithoutNullStreams, options: AcpClientOptions = {}) {
    this.onCliEvent = options.onCliEvent;
    this.permissionHandler = options.permissionHandler;
    this.warn = options.logger
      ? (message: string) => options.logger?.warn(message)
      : (message: string) => console.warn(`[AcpClient] ${message}`);
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

  /** protocolVersion mà server báo (undefined khi chưa initialize). */
  get negotiatedProtocolVersion(): number | undefined {
    return this.serverProtocolVersion;
  }

  /** Thông tin agent mà server báo (nếu có). */
  get serverAgentInfo(): { name?: string; version?: string } | undefined {
    return this.agentInfo;
  }

  /**
   * Handshake `initialize`. Params theo ACP chuẩn:
   * `{protocolVersion, clientCapabilities: {fs: {readTextFile,
   * writeTextFile}}, clientInfo: {name, version}}`.
   */
  async initialize(): Promise<void> {
    const result = await this.rpc.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
      clientInfo: { name: 'open-bot', version: '0.44' },
    });
    if (!isRecord(result)) {
      throw new Error('ACP: `initialize` trả về không phải object.');
    }
    const serverVersion = asNumber(result['protocolVersion']);
    if (serverVersion !== undefined) {
      this.serverProtocolVersion = serverVersion;
      if (serverVersion !== ACP_PROTOCOL_VERSION) {
        this.warn(
          `ACP: server báo protocolVersion ${serverVersion} (client nói ${ACP_PROTOCOL_VERSION}) — tiếp tục với hy vọng tương thích.`,
        );
      }
    }
    const agentInfo = result['agentInfo'];
    if (isRecord(agentInfo)) {
      this.agentInfo = {
        name: asString(agentInfo['name']),
        version: asString(agentInfo['version']),
      };
    }
    this.initialized = true;
  }

  /**
   * M3 — ACP `authenticate` (tuỳ chọn, theo ACP chuẩn): một số agent
   * (vd Cursor CLI quảng cáo methodId `cursor_login`) yêu cầu client
   * gọi bước này sau `initialize` để kích hoạt login đã lưu của CLI.
   * Result trả về không có shape chuẩn nên caller bỏ qua nội dung —
   * chỉ quan tâm thành công hay lỗi. CHƯA kiểm chứng trên Cursor CLI
   * thật (xem cursorCli.ts).
   */
  async authenticate(methodId: string): Promise<void> {
    await this.rpc.request('authenticate', { methodId });
  }

  /**
   * Mở session mới (`session/new`). Trả session id.
   * ACP chuẩn không có chỗ cho system prompt ở đây (xem grok.ts —
   * system prompt được gộp vào prompt đầu của session mới).
   */
  async newSession(options: { cwd?: string }): Promise<string> {
    const params: Record<string, unknown> = { mcpServers: [] };
    if (options.cwd) params['cwd'] = options.cwd;
    const result = await this.rpc.request('session/new', params);
    const sessionId = isRecord(result) ? asString(result['sessionId']) : undefined;
    if (!sessionId) {
      throw new Error('ACP: `session/new` không trả sessionId.');
    }
    return sessionId;
  }

  /**
   * Resume session đã có (`session/load`). Throw khi server báo lỗi —
   * caller fallback sang newSession() + gửi lại history (xem grok.ts).
   */
  async loadSession(sessionId: string, options: { cwd?: string }): Promise<void> {
    const params: Record<string, unknown> = { sessionId, mcpServers: [] };
    if (options.cwd) params['cwd'] = options.cwd;
    await this.rpc.request('session/load', params);
  }

  /**
   * Gửi một prompt và chờ response `{stopReason}` (tín hiệu kết thúc
   * turn của ACP). Text chảy về qua notification `session/update`
   * trong lúc chờ. Chỉ một prompt chạy tại một thời điểm trên client này.
   */
  async prompt(sessionId: string, userTexts: string[]): Promise<AcpPromptResult> {
    if (this.pendingPrompt) {
      throw new Error('ACP: đã có một prompt đang chạy — chờ xong rồi gửi tiếp.');
    }
    const prompt = userTexts.map((text) => ({ type: 'text', text }));
    let resolvePrompt!: (res: AcpPromptResult) => void;
    let rejectPrompt!: (err: Error) => void;
    const promise = new Promise<AcpPromptResult>((resolve, reject) => {
      resolvePrompt = resolve;
      rejectPrompt = reject;
    });
    // Tránh unhandled rejection khi failPrompt chạy trước khi caller await.
    promise.catch(() => undefined);
    // Giữ reference local (không đọc lại this.pendingPrompt sau await —
    // TS narrow property về null vì assignment nằm trong callback).
    const pendingState: PendingPrompt = {
      resolve: resolvePrompt,
      reject: rejectPrompt,
      sessionId,
      textParts: [],
      approvalsDenied: 0,
    };
    this.pendingPrompt = pendingState;
    let result: unknown;
    try {
      result = await this.rpc.request('session/prompt', { sessionId, prompt });
    } catch (err) {
      // Request lỗi (server trả error / timeout / process chết): turn
      // fail — trừ khi turn đã kết thúc bằng cách khác trước đó.
      this.failPrompt(err as Error);
      throw err;
    }
    if (this.pendingPrompt !== pendingState) {
      // Turn đã kết thúc giữa chừng (vd process chết rồi failPrompt) —
      // request vừa resolve muộn, bỏ qua.
      throw new Error('ACP: turn đã kết thúc trước khi nhận response của `session/prompt`.');
    }
    this.pendingPrompt = null;
    const stopReason = parseStopReason(result);
    const text = pendingState.textParts.join('');
    if (stopReason === 'cancelled') {
      const err = new Error('ACP: turn bị hủy (server báo cancelled).');
      err.name = 'AbortError';
      throw err;
    }
    if (stopReason === 'refusal' && text.length === 0) {
      throw new Error('ACP: agent từ chối trả lời (stopReason=refusal, không có text).');
    }
    const res: AcpPromptResult = {
      text,
      stopReason,
      usage: pendingState.usage,
      approvalsDenied: pendingState.approvalsDenied,
    };
    this.emit({ type: 'result', text, usage: pendingState.usage });
    return res;
  }

  /** True khi đang có prompt chạy. */
  get hasPendingPrompt(): boolean {
    return this.pendingPrompt !== null;
  }

  /** Fail prompt đang chạy (process chết / abort / dispose). */
  failPrompt(err: Error): void {
    const pending = this.pendingPrompt;
    if (!pending) return;
    this.pendingPrompt = null;
    pending.reject(err);
  }

  /** Reject mọi request đang chờ của transport (gọi khi process chết). */
  failAllPending(err: Error): void {
    this.rpc.failAll(err);
    this.failPrompt(err);
  }

  /** Hủy session đang chạy (best-effort; lỗi thì bỏ qua — caller vẫn kill process). */
  async cancelSession(sessionId: string): Promise<void> {
    try {
      await this.rpc.request('session/cancel', { sessionId }, 5_000);
    } catch {
      // Hủy không được thì caller kill process group sau đó.
    }
  }

  /** Ngừng đọc stdout (không kill process — caller lo việc đó). */
  close(): void {
    this.rpc.close();
  }

  // ------------------------------------------------------------------
  // Server → client
  // ------------------------------------------------------------------

  private handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update') return; // M2 chỉ cần session/update.
    if (!isRecord(params)) return;
    const pending = this.pendingPrompt;
    const update = params['update'];
    if (!isRecord(update)) return;
    if (pending && asString(params['sessionId']) && params['sessionId'] !== pending.sessionId) return;
    const kind = asString(update['sessionUpdate']);
    switch (kind) {
      case 'agent_message_chunk': {
        // update.content = {type: 'text', text} (ACP chuẩn).
        const content = update['content'];
        if (pending && isRecord(content) && content['type'] === 'text') {
          const text = asString(content['text']);
          if (text) {
            pending.textParts.push(text);
            this.emit({ type: 'text', delta: text });
          }
        }
        break;
      }
      case 'tool_call': {
        // Tool của CLI — surface qua event, open-bot KHÔNG thực thi lại.
        if (pending) {
          const toolCallId = asString(update['toolCallId']) ?? '';
          const title = asString(update['title']) ?? asString(update['kind']) ?? '';
          if (title) {
            const rawInput = update['rawInput'];
            const args = isRecord(rawInput) ? (rawInput as Record<string, unknown>) : {};
            this.emit({
              type: 'tool_call',
              call: { id: toolCallId || `acp-${title}`, name: title, args },
            });
          }
        }
        break;
      }
      case 'usage_update': {
        // Shape usage_update chưa được kiểm chứng trên Grok thật —
        // thử vài vị trí thường gặp, thiếu thì bỏ qua (không crash).
        if (pending) {
          const usage = parseAcpUsage(update);
          if (usage) pending.usage = usage;
        }
        break;
      }
      default:
        // agent_thought_chunk, tool_call_update, plan,
        // current_mode_update, available_commands_update… — M2 chưa cần.
        break;
    }
  }

  /**
   * Trả lời request từ server. `session/request_permission` → hỏi
   * broker (M5): không có broker thì TỪ CHỐI fail-closed như M2;
   * broker cho phép (chỉ khi user quyết tường minh) thì chọn option
   * `allow_once` (không có thì `allow_always`), còn lại chọn
   * `reject_once` / `reject_always` / `cancelled` như cũ. Mọi thứ
   * khác → JSON-RPC error -32601.
   */
  private async handleServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'session/request_permission') {
      const toolCall = isRecord(params) ? params['toolCall'] : undefined;
      const title = isRecord(toolCall) ? asString(toolCall['title']) : undefined;
      const detail = title ? `tool=${title.slice(0, 200)}` : '';
      const options = isRecord(params) && Array.isArray(params['options']) ? params['options'] : [];
      this.emit({ type: 'approval_request', method, detail });
      let allowed = false;
      if (this.permissionHandler) {
        try {
          allowed = await this.permissionHandler({ method, detail, allowable: true });
        } catch (err) {
          this.warn(`permission broker lỗi: ${(err as Error).message} — từ chối fail-closed.`);
          allowed = false;
        }
      }
      if (allowed) {
        const allowOption = options.find(
          (o) => isRecord(o) && (o['kind'] === 'allow_once' || o['kind'] === 'allow_always'),
        );
        if (isRecord(allowOption) && typeof allowOption['id'] === 'string') {
          return { outcome: { outcome: 'selected', optionId: allowOption['id'] } };
        }
        // Broker cho phép nhưng server không đưa option allow nào →
        // không đoán shape: từ chối và ghi rõ (fail-closed).
        this.warn('permission broker cho phép nhưng ACP server không đưa option allow — từ chối.');
      }
      this.totalApprovalsDenied += 1;
      if (this.pendingPrompt) this.pendingPrompt.approvalsDenied += 1;
      this.emit({
        type: 'approval_denied',
        method,
        detail,
      });
      const rejectOption = options.find(
        (o) => isRecord(o) && (o['kind'] === 'reject_once' || o['kind'] === 'reject_always'),
      );
      if (isRecord(rejectOption) && typeof rejectOption['id'] === 'string') {
        return { outcome: { outcome: 'selected', optionId: rejectOption['id'] } };
      }
      // Không có option reject nào để chọn → hủy request.
      return { outcome: { outcome: 'cancelled' } };
    }
    // fs/read_text_file, fs/write_text_file, terminal/*… — không cấp
    // quyền cho server ở M2.
    throw new JsonRpcResponseError({
      code: -32601,
      message: `open-bot (M2) không hỗ trợ request "${method}" từ ACP server.`,
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

/** stopReason từ response `session/prompt` (phòng thủ: lạ thì coi là end_turn). */
function parseStopReason(result: unknown): AcpStopReason {
  if (isRecord(result)) {
    const raw = asString(result['stopReason']);
    if (
      raw === 'end_turn' ||
      raw === 'max_tokens' ||
      raw === 'max_turn_requests' ||
      raw === 'refusal' ||
      raw === 'cancelled'
    ) {
      return raw;
    }
  }
  return 'end_turn';
}

/**
 * Usage từ một `usage_update` (shape chưa kiểm chứng trên Grok thật —
 * thử `update.usage.{inputTokens,outputTokens}` rồi vài biến thể,
 * không thấy thì trả undefined).
 */
function parseAcpUsage(update: Record<string, unknown>): { inputTokens: number; outputTokens: number } | undefined {
  const candidates: unknown[] = [update['usage'], update['tokens'], update];
  for (const cand of candidates) {
    if (!isRecord(cand)) continue;
    const input = asNumber(cand['inputTokens']) ?? asNumber(cand['input_tokens']);
    const output = asNumber(cand['outputTokens']) ?? asNumber(cand['output_tokens']);
    if (input !== undefined || output !== undefined) {
      return { inputTokens: input ?? 0, outputTokens: output ?? 0 };
    }
  }
  return undefined;
}
