/**
 * JSON-RPC 2.0 qua NDJSON trên stdio — transport dùng chung cho các
 * driver CLI nói JSON-RPC (M2: Codex app-server, Grok CLI qua ACP).
 *
 * Một dòng stdout = một message JSON-RPC:
 * - request từ phía ta: `{jsonrpc:'2.0', id, method, params}` — chờ
 *   response `{id, result}` / `{id, error}` (khớp theo id).
 * - notification từ server: `{jsonrpc:'2.0', method, params}` (không id).
 * - request từ server (server→client, vd xin duyệt): `{jsonrpc:'2.0',
 *   id, method, params}` — `onRequest` trả result (hoặc throw để trả
 *   JSON-RPC error); M2 dùng cơ chế này để TỪ CHỐI mọi yêu cầu duyệt
 *   của server khi chưa có permission broker (fail-closed).
 *
 * Lớp này chỉ lo vận chuyển + khớp id; ngữ nghĩa từng protocol
 * (Codex thread/turn, ACP session/…) nằm ở module riêng
 * (codexAppServer.ts, acp.ts). Không spawn process — caller giữ
 * ChildProcess (spawn qua process.ts) và gọi `failAll()` khi process
 * chết để mọi request đang chờ reject rõ ràng thay vì treo.
 *
 * Phòng thủ: dòng không phải JSON thì đếm vào stats (không crash cả
 * turn); message lạ (không id, không method) cũng chỉ đếm.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export interface JsonRpcStats {
  /** Số request ta đã gửi. */
  requestsSent: number;
  /** Số response/notification/request đã nhận và xử lý. */
  messagesReceived: number;
  /** Số dòng stdout không phải JSON object (đã bỏ qua). */
  malformedLines: number;
  /** Số message JSON hợp lệ nhưng không khớp dạng nào đã biết. */
  unknownMessages: number;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Lỗi JSON-RPC trả về từ phía server (hoặc do transport tạo ra). */
export class JsonRpcResponseError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(error: JsonRpcError) {
    super(`JSON-RPC lỗi ${error.code}: ${error.message}`);
    this.name = 'JsonRpcResponseError';
    this.code = error.code;
    this.data = error.data;
  }
}

export interface JsonRpcClientOptions {
  /**
   * Nhận notification từ server (method không có id).
   * Lỗi trong handler không được làm hỏng transport — handler tự bắt.
   */
  onNotification?: (method: string, params: unknown) => void;
  /**
   * Nhận request từ server (có id + method). Trả result để gửi về;
   * throw (Error hoặc JsonRpcResponseError) để trả JSON-RPC error.
   * Mọi request từ server mà không có handler đều bị trả lỗi
   * -32601 (method not found) — fail-closed, không bao giờ để
   * server treo chờ một câu trả lời không bao giờ tới.
   */
  onRequest?: (method: string, params: unknown) => Promise<unknown> | unknown;
  /** Nơi ghi cảnh báo (mặc định im lặng). */
  logger?: { warn(message: string): void };
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Client JSON-RPC 2.0 gắn vào một process con đã spawn sẵn (stdio pipe).
 * Không sở hữu process — caller spawn/kill (xem process.ts).
 */
export class JsonRpcStdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly onNotification?: JsonRpcClientOptions['onNotification'];
  private readonly onRequest?: JsonRpcClientOptions['onRequest'];
  private readonly warn: (message: string) => void;
  private readonly stats: JsonRpcStats = {
    requestsSent: 0,
    messagesReceived: 0,
    malformedLines: 0,
    unknownMessages: 0,
  };
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer = '';
  private readonly onData: (chunk: Buffer) => void;
  private closed = false;

  constructor(child: ChildProcessWithoutNullStreams, options: JsonRpcClientOptions = {}) {
    this.child = child;
    this.onNotification = options.onNotification;
    this.onRequest = options.onRequest;
    this.warn = options.logger
      ? (message: string) => options.logger?.warn(message)
      : () => undefined;
    this.onData = (chunk: Buffer) => this.feed(chunk.toString('utf8'));
    child.stdout.on('data', this.onData);
  }

  /** Bản sao stats hiện tại (để test + chẩn đoán). */
  getStats(): JsonRpcStats {
    return { ...this.stats };
  }

  /** True khi client đã đóng (ngừng đọc stdout). */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Gửi một request và chờ response. `timeoutMs` (mặc định 60s) chỉ
   * áp cho việc CHỜ response — caller nào chờ completion qua
   * notification (vd Codex turn/completed) thì không dùng timeout ở
   * đây mà dùng timer của turn (xem codexAppServer.ts).
   */
  request(method: string, params?: unknown, timeoutMs = 60_000): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error(`JSON-RPC: client đã đóng, không gửi được "${method}".`));
    }
    const id = this.nextId;
    this.nextId += 1;
    const line = `${JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })}\n`;
    const promise = new Promise<unknown>((resolve, reject) => {
      const entry: PendingRequest = { resolve, reject };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(new Error(`JSON-RPC: hết thời gian chờ ${timeoutMs}ms cho "${method}".`));
          }
        }, timeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
    });
    // Tránh unhandled rejection khi failAll chạy trước khi caller await.
    promise.catch(() => undefined);
    try {
      this.child.stdin.write(line);
    } catch (err) {
      this.pending.delete(id);
      return Promise.reject(
        new Error(`JSON-RPC: không ghi được "${method}" vào stdin: ${(err as Error).message}`),
      );
    }
    this.stats.requestsSent += 1;
    return promise;
  }

  /**
   * Gửi request mà KHÔNG chờ response (fire-and-forget, vd Codex
   * `turn/start` khi completion được báo qua notification). Response
   * (nếu có) vẫn được theo dõi: response lỗi sẽ reject promise trả về
   * — caller nên gắn `.catch()` để log, không để unhandled rejection.
   */
  requestNoWait(method: string, params?: unknown, timeoutMs = 60_000): Promise<unknown> {
    return this.request(method, params, timeoutMs);
  }

  /** Gửi một notification (không id, không chờ trả lời). */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} })}\n`);
    } catch (err) {
      this.warn(`JSON-RPC: không gửi được notification "${method}": ${(err as Error).message}`);
    }
  }

  /**
   * Reject toàn bộ request đang chờ (gọi khi process chết / abort /
   * dispose). Gọi nhiều lần cũng an toàn.
   */
  failAll(err: Error): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
  }

  /** Ngừng đọc stdout (không kill process — caller lo việc đó). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.stdout.off('data', this.onData);
    } catch {
      // stdout đã đóng.
    }
    this.failAll(new Error('JSON-RPC: client đã đóng.'));
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.handleLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      this.stats.malformedLines += 1;
      return;
    }
    if (!isRecord(parsed)) {
      this.stats.malformedLines += 1;
      return;
    }
    this.stats.messagesReceived += 1;
    const id = parsed['id'];
    const method = parsed['method'];
    if (typeof method === 'string') {
      if (typeof id === 'number' || typeof id === 'string') {
        // Request từ server → trả lời qua onRequest (hoặc lỗi -32601).
        void this.answerServerRequest(id, method, parsed['params']);
      } else {
        // Notification từ server.
        try {
          this.onNotification?.(method, parsed['params']);
        } catch (err) {
          this.warn(`JSON-RPC: handler notification "${method}" lỗi: ${(err as Error).message}`);
        }
      }
      return;
    }
    if (typeof id === 'number' || typeof id === 'string') {
      // Response cho request của ta.
      const entry = this.pending.get(id as number);
      if (!entry) {
        this.stats.unknownMessages += 1;
        return;
      }
      this.pending.delete(id as number);
      if (entry.timer) clearTimeout(entry.timer);
      const error = parsed['error'];
      if (isRecord(error)) {
        const code = typeof error['code'] === 'number' ? error['code'] : -32000;
        const message = typeof error['message'] === 'string' ? error['message'] : 'Lỗi JSON-RPC không rõ.';
        entry.reject(new JsonRpcResponseError({ code, message, data: error['data'] }));
      } else {
        entry.resolve(parsed['result']);
      }
      return;
    }
    this.stats.unknownMessages += 1;
  }

  private async answerServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    let result: unknown;
    try {
      if (!this.onRequest) {
        throw new JsonRpcResponseError({
          code: -32601,
          message: `Method not found: ${method}`,
        });
      }
      result = await this.onRequest(method, params);
    } catch (err) {
      const code =
        err instanceof JsonRpcResponseError ? err.code : -32000;
      const message = err instanceof Error ? err.message : String(err);
      this.sendRaw({ jsonrpc: '2.0', id, error: { code, message } });
      return;
    }
    this.sendRaw({ jsonrpc: '2.0', id, result: result ?? {} });
  }

  private sendRaw(obj: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(`${JSON.stringify(obj)}\n`);
    } catch (err) {
      this.warn(`JSON-RPC: không gửi được response: ${(err as Error).message}`);
    }
  }
}
