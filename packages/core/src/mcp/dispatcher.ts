/**
 * MCP dispatcher — route mọi message do server khởi xướng (v0.13, W5a).
 *
 * Vấn đề: trước đây client lặng lẽ bỏ qua mọi message từ server không
 * phải response cho request của mình (sampling, elicitation, roots,
 * notifications/progress, ping...). Dispatcher này là tầng duy nhất
 * nhận các message đó và route tới handler đã đăng ký theo `method`.
 *
 * Không phụ thuộc transport: dispatcher chỉ nhận message object (đã
 * parse JSON) và trả response object (hoặc `null` cho notification).
 * Transport (stdio / Streamable HTTP) tự lo việc ghi response trả về.
 *
 * Quy tắc JSON-RPC 2.0 / MCP 2025-11-25:
 *  - Request (có `id` + `method`): bắt buộc phải trả lời — có handler
 *    thì trả `{ result }`, không có handler thì trả lỗi `-32601`
 *    method-not-found, handler ném lỗi thì trả `-32603` internal error.
 *    Không bao giờ crash vì message lạ.
 *  - Notification (có `method`, không có `id`): gọi handler (nếu có)
 *    rồi bỏ qua kết quả, luôn trả `null` — không trả lời.
 *  - Message không có `method` (response cho request của client) hoặc
 *    không phải object: không phải việc của dispatcher, trả `null`.
 *
 * Handler đăng ký được theo từng method, có thể thay thế (đăng ký lại
 * cùng method) hoặc gỡ (`unregister`). Handler mặc định duy nhất là
 * `ping` → `{}` (theo spec, ping trả result rỗng); coordinator sẽ đăng
 * ký thêm elicitation/sampling/... khi làm W5b (không thuộc W5a).
 */
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

/** Một JSON-RPC response mà dispatcher trả về cho transport ghi đi. */
export interface McpJsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Bối cảnh truyền cho handler: method được gọi và id của request
 * (`null` khi là notification — notification không có id).
 */
export interface McpDispatchContext {
  method: string;
  requestId: number | string | null;
}

/**
 * Handler cho một server-initiated method. Nhận `params` của message
 * (có thể `undefined`) và trả result — giá trị trả về thành `result`
 * của JSON-RPC response. Với notification, giá trị trả về bị bỏ qua.
 * Ném lỗi thì dispatcher chuyển thành lỗi `-32603`.
 */
export type McpServerRequestHandler = (
  params: unknown,
  context: McpDispatchContext,
) => unknown | Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True khi message là JSON-RPC request (có `id` khác null + `method`). */
export function isJsonRpcRequest(message: unknown): message is Record<string, unknown> {
  if (!isRecord(message)) return false;
  const id = message['id'];
  return (
    typeof message['method'] === 'string' &&
    (typeof id === 'number' || typeof id === 'string')
  );
}

/** True khi message là JSON-RPC notification (có `method`, không có `id`). */
export function isJsonRpcNotification(message: unknown): message is Record<string, unknown> {
  if (!isRecord(message)) return false;
  const id = message['id'];
  return (
    typeof message['method'] === 'string' && (id === undefined || id === null)
  );
}

export class McpDispatcher {
  private readonly handlers = new Map<string, McpServerRequestHandler>();

  constructor() {
    // Ping là request duy nhất mọi server đều có thể gửi mà client phải
    // trả lời ngay cả khi chưa đăng ký handler nào (spec: result rỗng).
    // Đăng ký lại `ping` sẽ thay thế handler mặc định này.
    this.handlers.set('ping', () => ({}));
  }

  /**
   * Đăng ký handler cho một method. Đăng ký lại cùng method sẽ thay
   * thế handler cũ (để coordinator đổi elicitation/sampling handler
   * lúc runtime mà không cần tạo dispatcher mới).
   */
  register(method: string, handler: McpServerRequestHandler): void {
    if (typeof method !== 'string' || !method.trim()) {
      throw new Error('McpDispatcher.register: method phải là chuỗi không rỗng');
    }
    if (typeof handler !== 'function') {
      throw new Error(`McpDispatcher.register: handler cho "${method}" phải là function`);
    }
    this.handlers.set(method, handler);
  }

  /** Gỡ handler của một method. Trả true khi method đã từng đăng ký. */
  unregister(method: string): boolean {
    return this.handlers.delete(method);
  }

  /** True khi đã có handler cho method này. */
  has(method: string): boolean {
    return this.handlers.has(method);
  }

  /** Danh sách method đã đăng ký (kể cả `ping` mặc định). */
  methods(): string[] {
    return [...this.handlers.keys()];
  }

  /** Gỡ toàn bộ handler đã đăng ký (kể cả `ping` mặc định). */
  clear(): void {
    this.handlers.clear();
  }

  /**
   * Dispatch một message đã parse từ server.
   *  - Request → Promise<response> (luôn có response, kể cả lỗi).
   *  - Notification / response của client / message lạ → `null`.
   * Không bao giờ throw vì message xấu — message lạ chỉ bị bỏ qua.
   */
  async dispatch(message: unknown): Promise<McpJsonRpcResponse | null> {
    if (!isRecord(message) || typeof message['method'] !== 'string') {
      return null; // response cho request của client, hoặc message lạ
    }
    const method = message['method'] as string;
    const params = message['params'];
    const id = message['id'];
    const isRequest =
      typeof id === 'number' || typeof id === 'string';

    const handler = this.handlers.get(method);
    const context: McpDispatchContext = { method, requestId: isRequest ? id : null };

    if (!isRequest) {
      // Notification: gọi handler nếu có, nuốt mọi lỗi, không trả lời.
      if (handler) {
        try {
          await handler(params, context);
        } catch {
          // Notification lỗi thì không có ai để báo — bỏ qua lặng lẽ.
        }
      }
      return null;
    }

    if (!handler) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: JSON_RPC_METHOD_NOT_FOUND,
          message: `Method not found: ${method}`,
        },
      };
    }
    try {
      const result = await handler(params, context);
      return {
        jsonrpc: '2.0',
        id,
        result: result === undefined ? {} : result,
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: JSON_RPC_INTERNAL_ERROR,
          message: `Internal error handling "${method}": ${(err as Error).message}`,
        },
      };
    }
  }
}

/** Tạo dispatcher mới (bí danh cho `new McpDispatcher()`). */
export function createMcpDispatcher(): McpDispatcher {
  return new McpDispatcher();
}
