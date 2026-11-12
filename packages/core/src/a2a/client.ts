/**
 * A2A client (v0.13, mục 13) — gọi agent ngoài theo chuẩn A2A 1.0.
 *
 * Chỉ dùng global `fetch` + Node stdlib, không thêm dependency.
 *  - Đọc Agent Card từ `/.well-known/agent-card.json` (discovery).
 *  - Gửi task qua JSON-RPC `message:send`.
 *  - Theo dõi tiến độ qua SSE (`message:stream`) hoặc polling
 *    `tasks/get`, nhận artifact khi task xong.
 *
 * Lỗi mạng / timeout / HTTP lỗi / JSON-RPC lỗi đều trả về `A2aError`
 * với message rõ ràng (ghi rõ method, URL, lý do) — không throw
 * khó hiểu, không crash khi server trả JSON lạ.
 */
import {
  A2aError,
  isA2aTerminalState,
  makeTextMessage,
  type A2aAgentCard,
  type A2aArtifact,
  type A2aTask,
  type A2aTaskState,
} from './types';

export { A2aError };
export type { A2aAgentCard, A2aTask, A2aArtifact, A2aTaskState };

/** Timeout mặc định cho một request A2A (30s, cùng MCP client). */
export const A2A_CLIENT_TIMEOUT_MS = 30_000;
/** Timeout mặc định khi poll task tới trạng thái cuối (5 phút). */
export const A2A_POLL_TIMEOUT_MS = 300_000;
/** Khoảng poll mặc định (1s). */
export const A2A_POLL_INTERVAL_MS = 1_000;

export interface A2aClientOptions {
  /** URL gốc của agent (vd http://127.0.0.1:PORT/). Card URL suy ra từ đây. */
  baseUrl: string;
  /** Timeout mỗi request HTTP (ms). */
  timeoutMs?: number;
  /** Bearer token tùy chọn (server có auth thì gửi kèm). */
  token?: string;
}

export interface A2aSendOptions {
  contextId?: string;
  metadata?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface A2aStreamOptions extends A2aSendOptions {
  /** Gọi mỗi khi server đẩy tiến độ từng phần (text). */
  onProgress?: (partialText: string) => void;
  /** Gọi mỗi khi server đẩy artifact (chưa chắc là artifact cuối). */
  onArtifact?: (artifact: A2aArtifact) => void;
  /** Gọi mỗi khi trạng thái task đổi. */
  onStatus?: (state: A2aTaskState) => void;
}

export interface A2aPollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  onProgress?: (task: A2aTask) => void;
}

/** Params `tasks/list` — khớp server (`listParams` trong server.ts). */
export interface A2aListTasksParams {
  /** Số task tối đa một trang (mặc định 50, server kẹp tối đa 100). */
  limit?: number;
  /** Vị trí bắt đầu (mặc định 0); `cursor` thắng `offset` khi cả hai có. */
  offset?: number;
  /** Con trỏ trang do server trả ở `nextCursor` (chuỗi số thập phân). */
  cursor?: string;
  /** Chỉ liệt kê task thuộc context này. */
  contextId?: string;
  /** `true` → mỗi task chỉ có `id`/`status`/`contextId`/`createdAt`/`updatedAt`,
   *  không kèm `history`/`artifacts`. Mặc định `false` → full task. */
  summary?: boolean;
  /** Timeout riêng cho request này (ms); không gửi lên server. */
  timeoutMs?: number;
}

export interface A2aListTasksResult {
  /** Task trong trang, mới nhất trước. */
  tasks: A2aTask[];
  /** Tổng số task khớp bộ lọc (trước khi cắt trang). */
  total: number;
  /** Con trỏ trang tiếp theo, `null` khi hết trang. */
  nextCursor: string | null;
}

function joinUrl(base: string, suffix: string): string {
  return base.replace(/\/+$/, '') + suffix;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Đọc Agent Card của một agent từ URL gốc của nó. Lỗi mạng/timeout/
 * HTTP/JSON đều thành `A2aError` rõ ràng — không throw lỗi fetch thô.
 */
export async function fetchAgentCard(
  baseUrl: string,
  options: { timeoutMs?: number; token?: string } = {},
): Promise<A2aAgentCard> {
  const timeoutMs = options.timeoutMs ?? A2A_CLIENT_TIMEOUT_MS;
  const url = joinUrl(baseUrl, '/.well-known/agent-card.json');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new A2aError(`Đọc Agent Card tại ${url} timed out sau ${timeoutMs}ms — agent có đang chạy không?`);
    }
    throw new A2aError(
      `Không đọc được Agent Card tại ${url}: ${(err as Error).message} — kiểm tra URL và mạng.`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new A2aError(
      `Agent tại ${url} trả HTTP ${res.status} khi đọc Agent Card — agent này có thể không phải A2A server.`,
      undefined,
      res.status,
    );
  }
  let card: unknown;
  try {
    card = await res.json();
  } catch {
    throw new A2aError(`Agent tại ${url} trả Agent Card không phải JSON hợp lệ.`);
  }
  if (!isRecord(card) || typeof card['name'] !== 'string' || typeof card['url'] !== 'string') {
    throw new A2aError(`Agent Card tại ${url} thiếu field bắt buộc "name" hoặc "url".`);
  }
  return card as unknown as A2aAgentCard;
}

/** Client A2A cho một agent ngoài (đã biết URL gốc của nó). */
export class A2aClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly token: string | undefined;
  private nextId = 1;
  private cardCache: A2aAgentCard | null = null;

  constructor(options: A2aClientOptions) {
    if (!options.baseUrl || typeof options.baseUrl !== 'string') {
      throw new A2aError('A2A client cần "baseUrl" là URL gốc của agent (vd http://127.0.0.1:PORT/).');
    }
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new A2aError(`A2A baseUrl không hợp lệ: "${options.baseUrl}".`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new A2aError(`A2A chỉ gọi qua http(s) — baseUrl "${options.baseUrl}" dùng protocol khác.`);
    }
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs ?? A2A_CLIENT_TIMEOUT_MS;
    this.token = options.token;
  }

  /** Agent Card đã đọc (null khi chưa discover). */
  get card(): A2aAgentCard | null {
    return this.cardCache;
  }

  /** Đọc (và cache) Agent Card của agent này. */
  async discover(): Promise<A2aAgentCard> {
    this.cardCache = await fetchAgentCard(this.baseUrl, {
      timeoutMs: this.timeoutMs,
      token: this.token,
    });
    return this.cardCache;
  }

  /** Endpoint JSON-RPC: `url` trong card (nếu đã discover) hoặc baseUrl. */
  private rpcUrl(): string {
    return this.cardCache?.url ?? this.baseUrl;
  }

  /** Một round-trip HTTP POST JSON-RPC (không parse SSE). */
  private async postRpc(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const url = this.rpcUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const id = this.nextId++;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'A2A-Version': '1.0',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new A2aError(
          `A2A request "${method}" tới ${url} timed out sau ${timeoutMs}ms — agent phản hồi chậm hoặc đã chết.`,
        );
      }
      throw new A2aError(`A2A request "${method}" tới ${url} thất bại: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new A2aError(
        `Agent tại ${url} trả HTTP ${res.status} cho "${method}" — kiểm tra URL và auth (Bearer token).`,
        undefined,
        res.status,
      );
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new A2aError(`Agent tại ${url} trả response không phải JSON hợp lệ cho "${method}".`);
    }
    if (!isRecord(body)) {
      throw new A2aError(`Agent tại ${url} trả JSON-RPC response không phải object cho "${method}".`);
    }
    if (isRecord(body['error'])) {
      const err = body['error'] as Record<string, unknown>;
      throw new A2aError(
        `Agent lỗi khi "${method}": ${typeof err['message'] === 'string' ? (err['message'] as string) : JSON.stringify(err)}`,
        typeof err['code'] === 'number' ? (err['code'] as number) : undefined,
      );
    }
    if (!('result' in body)) {
      throw new A2aError(`Agent tại ${url} trả JSON-RPC response thiếu "result" cho "${method}".`);
    }
    return body['result'] as Record<string, unknown>;
  }

  /** Gửi một message text, đợi task chạy xong, trả Task cuối cùng. */
  async sendMessage(text: string, options: A2aSendOptions = {}): Promise<A2aTask> {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new A2aError('A2A sendMessage cần text không rỗng.');
    }
    const message = makeTextMessage('user', text);
    const result = await this.postRpc(
      'message:send',
      {
        message,
        ...(options.contextId ? { contextId: options.contextId } : {}),
        ...(options.metadata ? { metadata: options.metadata } : {}),
      },
      options.timeoutMs ?? this.timeoutMs,
    );
    return result as unknown as A2aTask;
  }

  /** Lấy trạng thái một task theo id. */
  async getTask(taskId: string): Promise<A2aTask> {
    if (!taskId) throw new A2aError('A2A getTask cần taskId không rỗng.');
    const result = await this.postRpc('tasks/get', { id: taskId }, this.timeoutMs);
    return result as unknown as A2aTask;
  }

  /** Hủy một task đang chạy (server trả task sau khi hủy). */
  async cancelTask(taskId: string): Promise<A2aTask> {
    if (!taskId) throw new A2aError('A2A cancelTask cần taskId không rỗng.');
    const result = await this.postRpc('tasks/cancel', { id: taskId }, this.timeoutMs);
    return result as unknown as A2aTask;
  }

  /**
   * Liệt kê task, mới nhất trước — qua `tasks/list`. Trả
   * `{ tasks, total, nextCursor }`; `nextCursor` null khi hết trang.
   * Param sai kiểu (vd `limit: 0`, `summary: "yes"`) thì server trả
   * lỗi JSON-RPC -32602, `postRpc` đổi thành `A2aError` có `code`.
   */
  async listTasks(params: A2aListTasksParams = {}): Promise<A2aListTasksResult> {
    const { timeoutMs, ...listParams } = params;
    const result = await this.postRpc(
      'tasks/list',
      listParams,
      timeoutMs ?? this.timeoutMs,
    );
    return result as unknown as A2aListTasksResult;
  }

  /**
   * Gửi message qua `message:stream`, theo dõi SSE: gọi `onProgress`
   * khi có text từng phần, `onArtifact` khi có artifact, `onStatus`
   * khi trạng thái đổi. Trả Task cuối cùng. Nếu server không hỗ trợ
   * stream (trả JSON thường thay vì SSE), fallback về task trong
   * response đó thay vì lỗi.
   */
  async streamMessage(text: string, options: A2aStreamOptions = {}): Promise<A2aTask> {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new A2aError('A2A streamMessage cần text không rỗng.');
    }
    const timeoutMs = options.timeoutMs ?? A2A_POLL_TIMEOUT_MS;
    const url = this.rpcUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const id = this.nextId++;
    const message = makeTextMessage('user', text);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'A2A-Version': '1.0',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'message:stream',
          params: {
            message,
            ...(options.contextId ? { contextId: options.contextId } : {}),
            ...(options.metadata ? { metadata: options.metadata } : {}),
          },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new A2aError(
          `A2A stream "message:stream" tới ${url} timed out sau ${timeoutMs}ms — task chạy quá lâu.`,
        );
      }
      throw new A2aError(`A2A stream tới ${url} thất bại: ${(err as Error).message}`);
    }
    try {
      if (!res.ok) {
        throw new A2aError(
          `Agent tại ${url} trả HTTP ${res.status} cho "message:stream" — kiểm tra URL và auth (Bearer token).`,
          undefined,
          res.status,
        );
      }
      const contentType = res.headers.get('content-type') ?? '';
      // Server không stream mà trả JSON thường → dùng task trong đó.
      if (contentType.includes('application/json')) {
        const body = (await res.json()) as Record<string, unknown>;
        if (isRecord(body['error'])) {
          const err = body['error'] as Record<string, unknown>;
          throw new A2aError(
            `Agent lỗi khi "message:stream": ${typeof err['message'] === 'string' ? (err['message'] as string) : JSON.stringify(err)}`,
            typeof err['code'] === 'number' ? (err['code'] as number) : undefined,
          );
        }
        return body['result'] as unknown as A2aTask;
      }
      if (!res.body) {
        throw new A2aError(`Agent tại ${url} trả stream rỗng cho "message:stream".`);
      }
      return await this.readSseStream(res.body, options);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Đọc SSE stream (Web ReadableStream) thành Task cuối cùng. */
  private async readSseStream(
    body: ReadableStream<Uint8Array>,
    options: A2aStreamOptions,
  ): Promise<A2aTask> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastTask: A2aTask | null = null;
    const handleEvent = (raw: string): void => {
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice('data:'.length).trim();
        if (!data) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue; // Frame SSE lạ: bỏ qua, không crash.
        }
        const result = isRecord(parsed) ? parsed['result'] : undefined;
        if (!isRecord(result)) continue;
        if (result['kind'] === 'task' && isRecord(result['task'])) {
          lastTask = result['task'] as unknown as A2aTask;
          options.onStatus?.(lastTask.status.state);
        } else if (result['kind'] === 'status-update' && isRecord(result['status'])) {
          const status = result['status'] as Record<string, unknown>;
          if (typeof status['state'] === 'string') {
            options.onStatus?.(status['state'] as A2aTaskState);
          }
          const msg = status['message'];
          if (isRecord(msg) && Array.isArray(msg['parts'])) {
            const text = (msg['parts'] as { kind?: string; text?: string }[])
              .filter((p) => p.kind === 'text' && typeof p.text === 'string')
              .map((p) => p.text as string)
              .join('\n');
            if (text) options.onProgress?.(text);
          }
          if (result['final'] === true && lastTask) {
            lastTask = { ...lastTask, status: status as unknown as A2aTask['status'] };
          }
        } else if (result['kind'] === 'artifact-update' && isRecord(result['artifact'])) {
          options.onArtifact?.(result['artifact'] as unknown as A2aArtifact);
        }
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handleEvent(raw);
      }
    }
    if (buffer.trim()) handleEvent(buffer);
    if (!lastTask) {
      throw new A2aError('A2A stream kết thúc mà không có task nào — server có thể đã ngắt giữa chừng.');
    }
    return lastTask;
  }

  /**
   * Poll `tasks/get` tới khi task tới trạng thái cuối. Gọi
   * `onProgress` mỗi lần poll thấy task đổi. Hết timeout → `A2aError`
   * rõ ràng (ghi task id + thời gian đã đợi).
   */
  async pollTask(taskId: string, options: A2aPollOptions = {}): Promise<A2aTask> {
    if (!taskId) throw new A2aError('A2A pollTask cần taskId không rỗng.');
    const intervalMs = options.intervalMs ?? A2A_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? A2A_POLL_TIMEOUT_MS;
    const started = Date.now();
    let last: A2aTask | null = null;
    for (;;) {
      const task = await this.getTask(taskId);
      if (!last || task.status.state !== last.status.state) {
        options.onProgress?.(task);
      }
      last = task;
      if (isA2aTerminalState(task.status.state)) return task;
      if (Date.now() - started > timeoutMs) {
        throw new A2aError(
          `Poll task "${taskId}" timed out sau ${timeoutMs}ms — task vẫn ở trạng thái "${task.status.state}".`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
