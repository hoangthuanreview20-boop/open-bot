/**
 * Streamable HTTP transport đầy đủ cho MCP (v0.13, spec 2025-11-25).
 *
 * Khác với client POST một lần trong `client.ts` (chỉ gửi request và đọc
 * response ngay), transport này là tầng truyền tải riêng, dùng được cho
 * client sau này nối vào:
 *   - POST JSON-RPC (JSON hoặc SSE trong response).
 *   - GET SSE stream để nhận message do server khởi xướng (notification /
 *     request) và resume sau khi mất kết nối bằng `Last-Event-ID`.
 *   - DELETE session để đóng session sạch phía server.
 *
 * Interface dùng chung: `send(request)` / `sendNotification(method)` /
 * `onMessage(handler)` nhận message server gửi / `close()`.
 *
 * Bảo mật: không log header Authorization hay body (có thể chứa token);
 * chỉ chấp nhận http(s); `fetch` inject được (`fetchFn`) để test dùng
 * server giả local thay vì mạng live.
 */
import { TextDecoder } from 'node:util';

export const MCP_STREAMABLE_HTTP_VERSION = '2025-11-25';
export const DEFAULT_TRANSPORT_TIMEOUT_MS = 30_000;
export const DEFAULT_TRANSPORT_RECONNECT_ATTEMPTS = 3;
export const DEFAULT_TRANSPORT_RECONNECT_DELAY_MS = 1_000;

export type TransportFetchFn = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Policy reconnect cho GET SSE stream (P0-4) — interface cấu trúc, do
 * `McpReconnectPolicy` trong `client.ts` implement (tránh cycle import:
 * transport không import client). Khi có policy, vòng reconnect của
 * transport dùng delay + tombstone của policy thay cho số lần / delay
 * cố định (`maxReconnectAttempts` / `reconnectDelayMs`); khi không có,
 * giữ nguyên hành vi cũ.
 */
export interface StreamableHttpReconnectPolicy {
  /** Delay cho lần nối lại tiếp theo (ms); -1 = hết lượt, dừng retry. */
  nextReconnectDelayMs(): number;
  /** Ghi nhận một lần session 404; true = tombstone (dừng retry). */
  recordSession404(): boolean;
  /** Session còn sống: reset đếm 404. */
  recordSessionOk(): void;
  /** Reset toàn bộ trạng thái (mở stream mới / resume tường minh). */
  reset(): void;
  /** Kết nối vừa đứt: mốc ổn định tính lại từ đầu (optional). */
  noteInstability?(): void;
}

/** Một event SSE đã parse: `id:`, `event:`, `data:` (nhiều dòng data nối bằng \n). */
export interface SseEvent {
  id?: string;
  event?: string;
  data: string;
}

/**
 * Parse một đoạn text SSE thành các event hoàn chỉnh. Chỉ những event
 * kết thúc bằng dòng trống mới được trả về; phần dở dang còn lại trả
 * qua `remainder` để lần parse sau nối tiếp.
 */
export function parseSseText(text: string): { events: SseEvent[]; remainder: string } {
  const events: SseEvent[] = [];
  // Tách theo dòng trống (chuẩn SSE: \n\n, chấp nhận cả \r\n\r\n).
  const chunks = text.split(/\r?\n\r?\n/);
  const remainder = chunks.pop() ?? '';
  for (const chunk of chunks) {
    const event: SseEvent = { data: '' };
    const dataLines: string[] = [];
    for (const rawLine of chunk.split(/\r?\n/)) {
      const line = rawLine;
      if (!line || line.startsWith(':')) continue; // comment / dòng trống
      const colonIdx = line.indexOf(':');
      const field = (colonIdx >= 0 ? line.slice(0, colonIdx) : line).trim();
      const value = colonIdx >= 0 ? line.slice(colonIdx + 1).replace(/^ /, '') : '';
      if (field === 'id') event.id = value;
      else if (field === 'event') event.event = value;
      else if (field === 'data') dataLines.push(value);
      // Các field khác (vd `retry:`) hiện không dùng.
    }
    event.data = dataLines.join('\n');
    if (event.data === '' && event.id === undefined && event.event === undefined) continue;
    events.push(event);
  }
  return { events, remainder };
}

/** Một message JSON-RPC (request / response / notification) đã parse. */
export type JsonRpcMessage = Record<string, unknown>;

export class McpTransportError extends Error {
  readonly status?: number;
  /** Header `WWW-Authenticate` của response 401 (để discovery / step-up). */
  readonly wwwAuthenticate?: string;
  constructor(message: string, status?: number, wwwAuthenticate?: string) {
    super(message);
    this.name = 'McpTransportError';
    this.status = status;
    this.wwwAuthenticate = wwwAuthenticate;
  }
}

export type ServerMessageHandler = (message: JsonRpcMessage) => void;

export interface StreamableHttpTransportOptions {
  url: string;
  headers?: Record<string, string>;
  /** Timeout cho một request POST (mặc định 30s). */
  timeoutMs?: number;
  /**
   * Lấy giá trị header `Authorization` (vd `Bearer ...`) cho mỗi request.
   * Khi vắng, chỉ gửi header tĩnh trong `headers`.
   */
  getAuthorization?: () => string | null | Promise<string | null>;
  /**
   * Khi POST bị 401: gọi để lấy token mới rồi retry đúng một lần.
   * Khi vắng, 401 sẽ throw `McpTransportError` kèm `wwwAuthenticate`.
   */
  refreshAuthorization?: () => string | null | Promise<string | null>;
  /** Số lần tự nối lại GET stream khi đứt (mặc định 3; 0 = không nối). */
  maxReconnectAttempts?: number;
  /** Delay giữa các lần nối lại GET stream (mặc định 1000ms). */
  reconnectDelayMs?: number;
  /**
   * P0-4: policy reconnect theo số liệu Grok (`McpReconnectPolicy` ở
   * client.ts) — retry nhanh 5 lần (5s→60s) rồi retry định kỳ (5→30
   * phút), session 404 quá 5 lần thì tombstone. Khi có policy, nó thắng
   * `maxReconnectAttempts` / `reconnectDelayMs`; khi không có, giữ
   * nguyên hành vi cũ (3 lần / 1s, 404 đầu tiên dừng ngay).
   */
  reconnectPolicy?: StreamableHttpReconnectPolicy;
  fetchFn?: TransportFetchFn;
  /**
   * Handler nhận message do server khởi xướng (notification / request
   * trong SSE, cả ở response POST lẫn GET stream). Có thể đăng ký sau
   * bằng `onMessage()` — handler đăng ký muộn vẫn nhận message sau đó.
   */
  onServerMessage?: ServerMessageHandler;
}

function assertTransportUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new McpTransportError('Streamable HTTP transport: URL không hợp lệ.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new McpTransportError(
      'Streamable HTTP transport: chỉ chấp nhận URL http:// hoặc https://.',
    );
  }
}

function isJsonRpcResponse(value: unknown): value is JsonRpcMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    ('result' in (value as Record<string, unknown>) ||
      'error' in (value as Record<string, unknown>))
  );
}

function isServerInitiated(value: unknown): value is JsonRpcMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  // Request/notification từ server: có `method`, không có `result`/`error`.
  // Request có `id`, notification không có `id`.
  return typeof obj['method'] === 'string';
}

/**
 * Streamable HTTP transport (MCP 2025-11-25).
 *
 * Luồng dùng:
 *   const t = new StreamableHttpTransport({ url, getAuthorization });
 *   t.onMessage((msg) => { ... });           // nhận notification/request
 *   await t.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params });
 *   await t.openStream();                     // GET SSE (chạy nền)
 *   await t.close();                          // DELETE session + dừng stream
 *
 * `send()` tự lưu `Mcp-Session-Id` và `Last-Event-ID` từ response để
 * `resume()` dùng lại khi stream đứt.
 */
export class StreamableHttpTransport {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectDelayMs: number;
  private readonly reconnectPolicy?: StreamableHttpReconnectPolicy;
  private readonly fetchFn: TransportFetchFn;
  private readonly getAuthorization?: () => string | null | Promise<string | null>;
  private readonly refreshAuthorization?: () => string | null | Promise<string | null>;
  private readonly handlers = new Set<ServerMessageHandler>();

  private sessionId: string | null = null;
  private lastEventId: string | null = null;
  private closed = false;
  private streamAbort: AbortController | null = null;
  private streamPromise: Promise<void> | null = null;
  private reconnectAttempts = 0;

  constructor(options: StreamableHttpTransportOptions) {
    assertTransportUrl(options.url);
    this.url = options.url;
    this.headers = { ...(options.headers ?? {}) };
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_TRANSPORT_RECONNECT_ATTEMPTS;
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_TRANSPORT_RECONNECT_DELAY_MS;
    this.reconnectPolicy = options.reconnectPolicy;
    this.fetchFn = options.fetchFn ?? fetch;
    this.getAuthorization = options.getAuthorization;
    this.refreshAuthorization = options.refreshAuthorization;
    if (options.onServerMessage) this.handlers.add(options.onServerMessage);
  }

  /** Session id server cấp (`Mcp-Session-Id`), null khi chưa có session. */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Ghi đè session id (v0.13, integration): client đã handshake qua
   * POST có session sẵn — transport GET stream phải dùng chung session
   * đó thay vì xin session mới (server strict sẽ từ chối GET không có
   * session đã initialize).
   */
  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  /** ID của SSE event cuối cùng nhận được — dùng để resume. */
  getLastEventId(): string | null {
    return this.lastEventId;
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** Stream GET có đang mở không. */
  isStreamOpen(): boolean {
    return this.streamAbort !== null && !this.closed;
  }

  /** Đăng ký handler nhận message do server khởi xướng. Trả về hàm hủy đăng ký. */
  onMessage(handler: ServerMessageHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private dispatchServerMessage(message: JsonRpcMessage): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(message);
      } catch {
        // Handler của caller lỗi không được làm chết transport.
      }
    }
  }

  private rememberSession(res: Response): void {
    const sessionId = res.headers.get('mcp-session-id');
    if (sessionId) this.sessionId = sessionId;
  }

  private buildHeaders(authValue: string | null, extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/event-stream',
      ...this.headers,
      ...(extra ?? {}),
    };
    if (authValue) headers['Authorization'] = authValue;
    else if (this.headers['Authorization']) headers['Authorization'] = this.headers['Authorization'];
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    return headers;
  }

  private async resolveAuth(): Promise<string | null> {
    if (!this.getAuthorization) return null;
    return (await this.getAuthorization()) ?? null;
  }

  /**
   * Xử lý body của một response POST: JSON thuần → trả về response đó;
   * SSE → event cuối có `result`/`error` là response của request, các
   * event còn lại (notification/request từ server) dispatch qua handler.
   * Trả về `null` khi server chỉ trả 202 rỗng (vd notification).
   */
  private handlePostBody(
    text: string,
    contentType: string,
  ): JsonRpcMessage | null {
    if (!text.trim()) return null;
    if (contentType.includes('text/event-stream') || text.includes('data:')) {
      const { events } = parseSseText(text.endsWith('\n\n') ? text : `${text}\n\n`);
      let response: JsonRpcMessage | null = null;
      for (const event of events) {
        if (event.id) this.lastEventId = event.id;
        if (!event.data.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          continue;
        }
        if (isJsonRpcResponse(parsed)) response = parsed;
        else if (isServerInitiated(parsed)) this.dispatchServerMessage(parsed);
      }
      return response;
    }
    const parsed: unknown = JSON.parse(text);
    if (isServerInitiated(parsed)) {
      this.dispatchServerMessage(parsed);
      return null;
    }
    return parsed as JsonRpcMessage;
  }

  private async postOnce(
    request: JsonRpcMessage,
    authValue: string | null,
  ): Promise<{ status: number; text: string; contentType: string; wwwAuthenticate: string | null }> {
    if (this.closed) {
      throw new McpTransportError('Streamable HTTP transport đã đóng.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const res = await this.fetchFn(this.url, {
        method: 'POST',
        headers: {
          ...this.buildHeaders(authValue),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      this.rememberSession(res);
      const text = await res.text();
      return {
        status: res.status,
        text,
        contentType: res.headers.get('content-type') ?? '',
        wwwAuthenticate: res.headers.get('www-authenticate'),
      };
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new McpTransportError(
          `Streamable HTTP request hết thời gian sau ${this.timeoutMs}ms.`,
        );
      }
      if (err instanceof McpTransportError) throw err;
      throw new McpTransportError(`Streamable HTTP request thất bại: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Gửi một JSON-RPC request qua POST và chờ response. Khi server trả
   * 401 và có `refreshAuthorization`, refresh token một lần rồi retry
   * một lần; nếu không, throw `McpTransportError` kèm `wwwAuthenticate`
   * để caller discovery/step-up scope.
   */
  async send(request: JsonRpcMessage): Promise<JsonRpcMessage | null> {
    if (typeof request !== 'object' || request === null || Array.isArray(request)) {
      throw new McpTransportError('Streamable HTTP transport: request phải là một JSON object.');
    }
    let authValue = await this.resolveAuth();
    let refreshed = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const outcome = await this.postOnce(request, authValue);
      if (outcome.status === 401 && this.refreshAuthorization && !refreshed) {
        refreshed = true;
        const fresh = await this.refreshAuthorization();
        if (!fresh) {
          throw new McpTransportError(
            'MCP server từ chối token (HTTP 401) và không lấy được token mới. ' +
              'Cần authorize lại.',
            401,
            outcome.wwwAuthenticate ?? undefined,
          );
        }
        authValue = fresh;
        continue;
      }
      if (outcome.status === 401) {
        throw new McpTransportError(
          'MCP server từ chối yêu cầu (HTTP 401). Cần authorize lại hoặc xin thêm scope.',
          401,
          outcome.wwwAuthenticate ?? undefined,
        );
      }
      if (outcome.status < 200 || outcome.status >= 300) {
        throw new McpTransportError(
          `MCP server trả về HTTP ${outcome.status}.`,
          outcome.status,
          outcome.wwwAuthenticate ?? undefined,
        );
      }
      let parsed: JsonRpcMessage | null;
      try {
        parsed = this.handlePostBody(outcome.text, outcome.contentType);
      } catch {
        throw new McpTransportError('MCP server trả về response không phải JSON hợp lệ.');
      }
      return parsed;
    }
    throw new McpTransportError('Streamable HTTP request thất bại: trạng thái retry không ngờ tới.');
  }

  /** Gửi một JSON-RPC notification (không có `id`, không chờ response). */
  async sendNotification(method: string, params?: unknown): Promise<void> {
    const request: JsonRpcMessage = { jsonrpc: '2.0', method };
    if (params !== undefined) request['params'] = params;
    await this.send(request);
  }

  /**
   * Mở GET SSE stream để nhận message do server khởi xướng. Chạy nền:
   * resolve ngay khi stream đã mở (đã nhận response headers), quá trình
   * đọc event chạy ngầm cho tới khi server đóng stream / `close()` /
   * hết số lần nối lại. Khi stream đứt mà chưa đóng, tự nối lại bằng
   * `Last-Event-ID` tối đa `maxReconnectAttempts` lần.
   */
  async openStream(): Promise<void> {
    if (this.closed) throw new McpTransportError('Streamable HTTP transport đã đóng.');
    if (this.streamPromise) {
      await this.waitForStreamStart();
      return;
    }
    this.reconnectAttempts = 0;
    this.streamUnsupported = false;
    this.reconnectPolicy?.reset();
    this.streamPromise = this.runStreamLoop();
    this.streamPromise.catch(() => undefined);
    // Chờ tới khi stream đầu tiên thực sự mở (hoặc lỗi ngay) thay vì
    // resolve ngay lập tức — caller biết chắc GET đã bắt đầu.
    await this.waitForStreamStart();
  }

  private streamStartError: Error | null = null;
  private streamUnsupported = false;
  private streamEverOpened = false;
  private streamSettled = false;

  private waitForStreamStart(): Promise<void> {
    if (this.streamStartError) {
      const err = this.streamStartError;
      this.streamStartError = null;
      throw err;
    }
    if (this.streamEverOpened || this.streamSettled || this.closed) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const check = setInterval(() => {
        if (this.streamStartError) {
          clearInterval(check);
          clearTimeout(timer);
          const err = this.streamStartError;
          this.streamStartError = null;
          reject(err);
          return;
        }
        if (this.streamEverOpened || this.streamSettled || this.closed) {
          clearInterval(check);
          clearTimeout(timer);
          resolve();
        }
      }, 5);
      const timer = setTimeout(() => {
        clearInterval(check);
        resolve();
      }, 5_000);
      timer.unref?.();
    });
  }

  /**
   * Chờ rồi nối lại GET stream sau khi đứt. Trả false khi phải dừng nối
   * lại (hết lượt / hết chu kỳ định kỳ). Khi có `reconnectPolicy`
   * (P0-4, Grok) thì delay theo policy (nhanh 5s→60s ×5 rồi định kỳ
   * 5→30 phút); không có thì giữ hành vi cũ (tối đa
   * `maxReconnectAttempts` lần, delay cố định).
   */
  private async sleepBeforeReconnect(): Promise<boolean> {
    if (this.reconnectPolicy) {
      const delay = this.reconnectPolicy.nextReconnectDelayMs();
      if (delay < 0) return false;
      this.reconnectPolicy.noteInstability?.();
      await this.sleep(delay);
      return true;
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return false;
    this.reconnectAttempts++;
    await this.sleep(this.reconnectDelayMs);
    return true;
  }

  private async runStreamLoop(): Promise<void> {
    this.streamSettled = false;
    try {
      while (!this.closed) {
        try {
          await this.runSingleStream();
          // Server đóng stream bình thường: nối lại nếu còn lượt.
          if (this.closed || this.streamUnsupported) break;
          if (!(await this.sleepBeforeReconnect())) break;
        } catch (err) {
          if (this.closed) break;
          if (err instanceof McpTransportError && err.status === 404) {
            // Session không còn tồn tại phía server (SEP-1699).
            if (this.reconnectPolicy) {
              // P0-4 (Grok): 404 chưa đủ ngưỡng tombstone thì vẫn nối
              // lại theo policy (server có thể chỉ mất stream tạm
              // thời); đủ 5 lần liên tiếp thì dọn session + dừng.
              if (this.reconnectPolicy.recordSession404()) {
                this.sessionId = null;
                this.lastEventId = null;
                break;
              }
              if (!(await this.sleepBeforeReconnect())) break;
              continue;
            }
            // Hành vi cũ (không policy): 404 đầu tiên dọn session + dừng.
            this.sessionId = null;
            this.lastEventId = null;
            break;
          }
          if (!(await this.sleepBeforeReconnect())) break;
        }
      }
    } finally {
      this.streamAbort = null;
      this.streamPromise = null;
      this.streamSettled = true;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  /** Một lần GET SSE: đọc tới khi server đóng stream hoặc bị abort. */
  private async runSingleStream(): Promise<void> {
    const authValue = await this.resolveAuth();
    const headers = this.buildHeaders(authValue);
    if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId;
    const controller = new AbortController();
    this.streamAbort = controller;
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
    } catch (err) {
      this.streamAbort = null;
      if ((err as Error).name === 'AbortError') return; // bị close() abort
      throw new McpTransportError(`Mở GET SSE stream thất bại: ${(err as Error).message}`);
    }
    this.rememberSession(res);
    if (res.status === 405) {
      // Server không hỗ trợ GET stream (chỉ POST): không phải lỗi chết
      // người — coi như stream không mở được, dừng nối lại.
      this.streamAbort = null;
      this.streamStartError = null;
      this.streamUnsupported = true;
      return;
    }
    if (res.status === 404) {
      this.streamAbort = null;
      throw new McpTransportError(
        'MCP session không còn tồn tại phía server (HTTP 404). Cần tạo session mới.',
        404,
      );
    }
    if (!res.ok) {
      this.streamAbort = null;
      throw new McpTransportError(
        `Mở GET SSE stream thất bại: HTTP ${res.status}.`,
        res.status,
        res.headers.get('www-authenticate') ?? undefined,
      );
    }
    if (!res.body) {
      this.streamAbort = null;
      return;
    }
    this.streamEverOpened = true;
    // Stream mở thành công: session còn sống — reset đếm 404 (P0-4).
    this.reconnectPolicy?.recordSessionOk();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, remainder } = parseSseText(buffer);
        buffer = remainder;
        for (const event of events) {
          if (event.id) this.lastEventId = event.id;
          if (!event.data.trim()) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(event.data);
          } catch {
            continue;
          }
          if (typeof parsed === 'object' && parsed !== null) {
            this.dispatchServerMessage(parsed as JsonRpcMessage);
          }
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        const { events } = parseSseText(`${buffer}\n\n`);
        for (const event of events) {
          if (event.id) this.lastEventId = event.id;
          if (!event.data.trim()) continue;
          try {
            const parsed = JSON.parse(event.data) as JsonRpcMessage;
            this.dispatchServerMessage(parsed);
          } catch {
            // Event cuối dở dang: bỏ qua.
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      throw err;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Reader đã đóng.
      }
      if (this.streamAbort === controller) this.streamAbort = null;
    }
  }

  /**
   * Nối lại GET stream từ event id cuối cùng đã nhận (`Last-Event-ID`).
   * Tương đương `openStream()` nhưng tường minh: dùng sau khi caller
   * phát hiện stream đứt, hoặc để kiểm tra server còn giữ session không.
   * Ném lỗi khi session đã mất (HTTP 404) — caller nên tạo session mới.
   */
  async resume(): Promise<void> {
    if (this.closed) throw new McpTransportError('Streamable HTTP transport đã đóng.');
    if (!this.lastEventId && !this.sessionId) {
      throw new McpTransportError(
        'Không thể resume: chưa có session hay event id nào (chưa từng kết nối).',
      );
    }
    // Dừng stream cũ (nếu còn) rồi mở stream mới kèm Last-Event-ID.
    if (this.streamAbort) {
      try {
        this.streamAbort.abort();
      } catch {
        // Đã abort.
      }
      this.streamAbort = null;
    }
    this.streamPromise = null;
    this.reconnectAttempts = 0;
    this.streamUnsupported = false;
    this.reconnectPolicy?.reset();
    this.streamPromise = this.runStreamLoop();
    this.streamPromise.catch(() => undefined);
    await this.waitForStreamStart();
  }

  /**
   * Đóng transport: dừng GET stream, gửi DELETE để server dọn session,
   * đánh dấu đã đóng. DELETE thất bại (server đã quên session) không
   * làm `close()` lỗi — session local vẫn được dọn sạch.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.streamAbort) {
      try {
        this.streamAbort.abort();
      } catch {
        // Đã abort.
      }
      this.streamAbort = null;
    }
    const sessionId = this.sessionId;
    const url = this.url;
    const headers = this.buildHeaders(null);
    this.sessionId = null;
    this.lastEventId = null;
    this.streamPromise = null;
    if (sessionId) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        timer.unref?.();
        try {
          await this.fetchFn(url, {
            method: 'DELETE',
            headers,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // Server đã đóng session / không tới được: bỏ qua, local đã sạch.
      }
    }
  }
}
