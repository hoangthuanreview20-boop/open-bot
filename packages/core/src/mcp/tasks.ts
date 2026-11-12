/**
 * MCP tasks — client-side cho task dài của server (MCP spec 2025-11-25,
 * experimental, SEP-1686).
 *
 * Luồng chuẩn:
 *   1. client gửi request (vd `tools/call`) kèm `_meta.task` -> server
 *      trả ngay task handle `{ taskId, status, pollInterval }`
 *   2. client poll `tasks/get` theo `pollInterval` cho tới trạng thái cuối
 *   3. khi `completed`, lấy kết quả gốc qua `tasks/result` (blocking)
 *   4. huỷ bất cứ lúc nào qua `tasks/cancel`
 *
 * Trạng thái (theo spec): `working` | `input_required` | `completed` |
 * `failed` | `cancelled`. Trạng thái cuối: completed / failed / cancelled.
 * `input_required` nghĩa là server đang chờ input thêm — spec 2025-11-25
 * chưa có cách gửi input (`tasks/update` chỉ có ở extension 2026-07-28),
 * nên `waitForCompletion` báo lỗi rõ ràng thay vì treo.
 *
 * Module chỉ cần một transport tối thiểu (`request`) — điều phối viên nối
 * client MCP thật vào sau (không sửa `client.ts` ở đây). Mọi thứ đi qua
 * lớp `TaskHandle` này để khi spec đổi sang extension 2026-07-28
 * (bỏ `tasks/result`/`tasks/list`, `tasks/get` trả luôn kết quả) chỉ cần
 * đổi adapter bên trong, không sửa code gọi.
 *
 * P0-4 (v0.40): adapter thứ hai đã có sẵn — `specVersion: '2026-07-28'`
 * (extension chính thức `io.modelcontextprotocol/tasks`): `tasks/get`
 * trả luôn kết quả cuối (không gọi `tasks/result` nữa), `tasks/update`
 * gửi input cho task `input_required`, `tasks/list` không còn tồn tại,
 * server được trả task handle mà không cần client opt-in từng request
 * (`detectTaskHandle`). Code gọi dùng cùng API `TaskHandle` /
 * `createTask` / `runTaskToCompletion` cho cả hai backend — chỉ khác
 * `specVersion` truyền vào lúc tạo.
 */

export type TaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

/**
 * Phiên bản tasks mà `TaskHandle` đang nói chuyện:
 *  - `'2025-11-25'`: tasks experimental trong core (SEP-1686) — có
 *    `tasks/result` (blocking) + `tasks/list`, chưa có cách gửi input.
 *  - `'2026-07-28'`: extension chính thức `io.modelcontextprotocol/tasks`
 *    — bỏ `tasks/result`/`tasks/list`, `tasks/get` trả luôn kết quả,
 *    thêm `tasks/update` để gửi input. Không tương thích ngược.
 */
export type McpTaskSpecVersion = '2025-11-25' | '2026-07-28';

/** Tên extension tasks chính thức ở spec 2026-07-28. */
export const MCP_TASKS_EXTENSION_2026 = 'io.modelcontextprotocol/tasks';

/** Các method tasks theo spec 2025-11-25. */
export const MCP_TASK_METHODS = {
  get: 'tasks/get',
  result: 'tasks/result',
  cancel: 'tasks/cancel',
  list: 'tasks/list',
} as const;

/** Trạng thái cuối — poll dừng khi gặp một trong các trạng thái này. */
export const TASK_TERMINAL_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled'];

export function isTaskTerminal(status: TaskStatus): boolean {
  return (TASK_TERMINAL_STATUSES as readonly TaskStatus[]).includes(status);
}

/**
 * Transport tối thiểu mà module tasks cần: một hàm request JSON-RPC.
 * Client MCP thật (`StdioMcpClient` / `StreamableHttpMcpClient`) được
 * nối vào qua adapter ở tầng điều phối — không import `client.ts` ở đây.
 */
export interface McpTaskTransport {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** Lỗi liên quan tới task (tạo/poll/lấy kết quả/huỷ thất bại, timeout). */
export class TaskError extends Error {
  readonly taskId?: string;
  readonly status?: TaskStatus;
  constructor(message: string, taskId?: string, status?: TaskStatus) {
    super(message);
    this.name = 'TaskError';
    this.taskId = taskId;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Task handle thô do server trả (sau khi tạo task hoặc `tasks/get`). */
export interface TaskHandleData {
  taskId: string;
  status: TaskStatus;
  /** Gợi ý khoảng chờ giữa các lần poll (ms). */
  pollInterval?: number;
  /** Thời gian sống của task (ms) — server có thể xoá task sau đó. */
  ttl?: number;
  /**
   * Kết quả cuối của task — chỉ có ở extension 2026-07-28 (`tasks/get`
   * trả luôn kết quả khi `completed`); ở 2025-11-25 kết quả lấy riêng
   * qua `tasks/result`.
   */
  result?: unknown;
}

/**
 * Parse + validate trạng thái task. Ném `TaskError` khi giá trị lạ
 * (server trả status ngoài spec là lỗi protocol, không đoán mò).
 */
export function parseTaskStatus(value: unknown): TaskStatus {
  if (
    value === 'working' ||
    value === 'input_required' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  ) {
    return value;
  }
  throw new TaskError(`Task: trạng thái không hợp lệ: ${JSON.stringify(value)}`);
}

/**
 * Parse task handle do server trả. Ném `TaskError` khi thiếu `taskId`
 * hoặc `status` sai spec. `pollInterval`/`ttl` không hợp lệ thì bỏ qua
 * (dùng mặc định) thay vì fail cả task.
 */
export function parseTaskHandle(value: unknown): TaskHandleData {
  if (!isRecord(value)) {
    throw new TaskError('Task: server phải trả một object task handle');
  }
  if (typeof value['taskId'] !== 'string' || !value['taskId']) {
    throw new TaskError('Task: task handle thiếu "taskId"');
  }
  const status = parseTaskStatus(value['status']);
  const out: TaskHandleData = { taskId: value['taskId'] as string, status };
  const pollInterval = value['pollInterval'];
  if (typeof pollInterval === 'number' && Number.isFinite(pollInterval) && pollInterval > 0) {
    out.pollInterval = pollInterval;
  }
  const ttl = value['ttl'];
  if (typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0) {
    out.ttl = ttl;
  }
  // Extension 2026-07-28: `tasks/get` trả luôn kết quả cuối trong cùng
  // object — giữ lại để `waitForCompletion` dùng, không gọi `tasks/result`.
  if ('result' in value) out.result = value['result'];
  return out;
}

/**
 * Kiểm tra một kết quả request thường có phải là task handle do server
 * trả không cần opt-in không (extension 2026-07-28: server được trả
 * handle mà client không cần gửi `_meta.task` trước). Trả handle đã
 * parse khi đúng hình dạng, null khi không phải — caller dùng để bọc
 * kết quả `tools/call` thành `TaskHandle` thay vì coi là xong.
 */
export function detectTaskHandle(value: unknown): TaskHandleData | null {
  try {
    return parseTaskHandle(value);
  } catch {
    return null;
  }
}

/** Tuỳ chọn khi tạo task. */
export interface CreateTaskOptions {
  /** Thời gian sống mong muốn của task (ms) — gửi kèm `_meta.task.ttl`. */
  ttlMs?: number;
  /** Khoảng poll mặc định (ms) khi server không gợi ý `pollInterval`. */
  pollIntervalMs?: number;
  /**
   * Backend tasks đang nói chuyện (mặc định `'2025-11-25'`). Đổi sang
   * `'2026-07-28'` khi server dùng extension chính thức — cùng API
   * `TaskHandle`, chỉ khác đường lấy kết quả / gửi input bên trong.
   */
  specVersion?: McpTaskSpecVersion;
  /** Huỷ ngay cả bước tạo task. */
  signal?: AbortSignal;
}

/** Tuỳ chọn cho `waitForCompletion`. */
export interface WaitForCompletionOptions {
  /** Tổng thời gian chờ tối đa (ms); hết hạn -> ném `TaskError`. */
  timeoutMs?: number;
  /** Khoảng poll tối đa (ms) — backoff không vượt quá số này. */
  maxPollIntervalMs?: number;
  /** Gọi mỗi khi trạng thái task đổi sau một lần poll. */
  onStatusChange?: (status: TaskStatus, task: TaskHandleData) => void;
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    signal.throwIfAborted();
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    timer.unref?.();
    let onAbort: (() => void) | undefined;
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error('Task: đã bị huỷ'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Gửi một request dưới dạng task: thêm `_meta.task` vào params rồi gửi
 * qua transport; server trả ngay task handle thay vì kết quả.
 * `method` thường là `tools/call` (params `{ name, arguments }`).
 * Ném `TaskError` khi transport lỗi hoặc server không trả task handle.
 */
export async function createTask(
  transport: McpTaskTransport,
  method: string,
  params: Record<string, unknown> = {},
  options: CreateTaskOptions = {},
): Promise<TaskHandle> {
  options.signal?.throwIfAborted();
  const meta = isRecord(params['_meta']) ? { ...params['_meta'] } : {};
  const requestParams: Record<string, unknown> = {
    ...params,
    _meta: {
      ...meta,
      task: options.ttlMs !== undefined ? { ttl: options.ttlMs } : {},
    },
  };
  let raw: unknown;
  try {
    raw = await transport.request(method, requestParams);
  } catch (err) {
    throw new TaskError(
      `Task: tạo task cho "${method}" thất bại: ${(err as Error).message}`,
    );
  }
  const data = parseTaskHandle(raw);
  return new TaskHandle(transport, data, {
    pollIntervalMs: options.pollIntervalMs,
    specVersion: options.specVersion,
  });
}

/**
 * Tay cầm cho một task dài của server: poll trạng thái, lấy kết quả,
 * huỷ. Giữ trạng thái mới nhất trong `status` / `pollIntervalMs`.
 * `specVersion` chọn backend bên trong (2025-11-25 experimental hay
 * extension 2026-07-28) — code gọi không đổi.
 */
export class TaskHandle {
  readonly taskId: string;
  readonly specVersion: McpTaskSpecVersion;
  status: TaskStatus;
  pollIntervalMs: number;
  readonly ttl?: number;
  private readonly transport: McpTaskTransport;

  constructor(
    transport: McpTaskTransport,
    data: TaskHandleData,
    options: { pollIntervalMs?: number; specVersion?: McpTaskSpecVersion } = {},
  ) {
    this.transport = transport;
    this.taskId = data.taskId;
    this.status = data.status;
    this.specVersion = options.specVersion ?? '2025-11-25';
    this.pollIntervalMs = data.pollInterval ?? options.pollIntervalMs ?? 1000;
    this.ttl = data.ttl;
  }

  /** Task đã tới trạng thái cuối chưa. */
  get isTerminal(): boolean {
    return isTaskTerminal(this.status);
  }

  /**
   * Poll một lần: gọi `tasks/get`, cập nhật `status`/`pollIntervalMs`,
   * trả task handle mới nhất. Ném `TaskError` khi transport lỗi hoặc
   * server trả handle sai spec.
   */
  async poll(signal?: AbortSignal): Promise<TaskHandleData> {
    signal?.throwIfAborted();
    let raw: unknown;
    try {
      raw = await this.transport.request(MCP_TASK_METHODS.get, { taskId: this.taskId });
    } catch (err) {
      throw new TaskError(
        `Task "${this.taskId}": poll thất bại: ${(err as Error).message}`,
        this.taskId,
        this.status,
      );
    }
    const data = parseTaskHandle(raw);
    if (data.taskId !== this.taskId) {
      throw new TaskError(
        `Task: server trả taskId khác khi poll ("${data.taskId}" thay vì "${this.taskId}")`,
        this.taskId,
        this.status,
      );
    }
    this.status = data.status;
    if (data.pollInterval !== undefined) this.pollIntervalMs = data.pollInterval;
    return data;
  }

  /**
   * Lấy kết quả gốc của task qua `tasks/result` (blocking theo spec
   * 2025-11-25 — server giữ request tới khi task xong). Chỉ gọi khi
   * task đã `completed`; gọi sớm hơn sẽ chờ tới khi xong hoặc timeout
   * của transport. Ném `TaskError` khi task chưa xong mà server trả lỗi.
   *
   * Extension 2026-07-28 đã BỎ `tasks/result` — gọi hàm này ở backend
   * đó sẽ ném `TaskError` ngay; kết quả đã nằm trong `tasks/get` khi
   * `completed` (xem `waitForCompletion`).
   */
  async getResult(signal?: AbortSignal): Promise<unknown> {
    if (this.specVersion === '2026-07-28') {
      throw new TaskError(
        `Task "${this.taskId}": extension 2026-07-28 đã bỏ "tasks/result" — ` +
          `kết quả nằm trong "tasks/get" khi task completed`,
        this.taskId,
        this.status,
      );
    }
    signal?.throwIfAborted();
    try {
      return await this.transport.request(MCP_TASK_METHODS.result, { taskId: this.taskId });
    } catch (err) {
      throw new TaskError(
        `Task "${this.taskId}": lấy kết quả thất bại: ${(err as Error).message}`,
        this.taskId,
        this.status,
      );
    }
  }

  /**
   * Gửi input thêm cho task đang ở trạng thái `input_required` — chỉ có
   * ở extension 2026-07-28 (`tasks/update`, params `{ taskId, input }`).
   * Ở backend 2025-11-25 spec chưa có cách gửi input nên ném `TaskError`
   * rõ ràng thay vì gửi method server không hiểu.
   */
  async sendInput(input: unknown, signal?: AbortSignal): Promise<TaskHandleData> {
    if (this.specVersion !== '2026-07-28') {
      throw new TaskError(
        `Task "${this.taskId}": spec 2025-11-25 chưa hỗ trợ gửi input cho task ` +
          `đang chạy (cần extension 2026-07-28 "tasks/update")`,
        this.taskId,
        this.status,
      );
    }
    signal?.throwIfAborted();
    let raw: unknown;
    try {
      raw = await this.transport.request('tasks/update', {
        taskId: this.taskId,
        input,
      });
    } catch (err) {
      throw new TaskError(
        `Task "${this.taskId}": gửi input thất bại: ${(err as Error).message}`,
        this.taskId,
        this.status,
      );
    }
    const data = parseTaskHandle(raw);
    if (data.taskId !== this.taskId) {
      throw new TaskError(
        `Task: server trả taskId khác khi tasks/update ("${data.taskId}" thay vì "${this.taskId}")`,
        this.taskId,
        this.status,
      );
    }
    this.status = data.status;
    if (data.pollInterval !== undefined) this.pollIntervalMs = data.pollInterval;
    return data;
  }

  /**
   * Huỷ task qua `tasks/cancel`. Sau khi gọi, `status` = 'cancelled'
   * (kể cả khi server trả body rỗng — huỷ là best-effort, không ném lỗi
   * khi server chỉ xác nhận bằng object rỗng).
   */
  async cancel(): Promise<void> {
    let raw: unknown;
    try {
      raw = await this.transport.request(MCP_TASK_METHODS.cancel, { taskId: this.taskId });
    } catch (err) {
      throw new TaskError(
        `Task "${this.taskId}": huỷ thất bại: ${(err as Error).message}`,
        this.taskId,
        this.status,
      );
    }
    if (isRecord(raw) && raw['status'] !== undefined) {
      try {
        this.status = parseTaskStatus(raw['status']);
      } catch {
        this.status = 'cancelled';
      }
    } else {
      this.status = 'cancelled';
    }
  }

  /**
   * Poll tới khi task xong rồi trả kết quả:
   *  - `completed` -> `{ status: 'completed', result }` (2025-11-25:
   *    result lấy qua `tasks/result`; 2026-07-28: result nằm ngay trong
   *    `tasks/get`, không gọi thêm method nào)
   *  - `failed` -> ném `TaskError` (kèm status)
   *  - `cancelled` -> ném `TaskError` (kèm status)
   *  - `input_required` -> 2025-11-25: ném `TaskError` (spec chưa có
   *    cách gửi input); 2026-07-28: ném `TaskError` hướng dẫn gọi
   *    `sendInput()` (`tasks/update`) rồi poll tiếp
   *  - hết `timeoutMs` hoặc signal abort -> ném lỗi tương ứng
   *
   * Poll dùng backoff: khoảng chờ bắt đầu từ `pollIntervalMs` (server
   * gợi ý) và nhân đôi mỗi vòng, tối đa `maxPollIntervalMs` (mặc định
   * 30s) — server quá tải không bị client poll dồn dập.
   */
  async waitForCompletion(
    options: WaitForCompletionOptions = {},
  ): Promise<{ status: TaskStatus; result: unknown }> {
    const signal = options.signal;
    const maxPollIntervalMs = options.maxPollIntervalMs ?? 30_000;
    const deadline =
      options.timeoutMs !== undefined ? Date.now() + options.timeoutMs : undefined;
    let attempt = 0;
    for (;;) {
      signal?.throwIfAborted();
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new TaskError(
          `Task "${this.taskId}": hết thời gian chờ (${options.timeoutMs}ms) ở trạng thái "${this.status}"`,
          this.taskId,
          this.status,
        );
      }
      const data = await this.poll(signal);
      options.onStatusChange?.(data.status, data);
      if (data.status === 'completed') {
        // Extension 2026-07-28: kết quả đã nằm trong tasks/get.
        if (this.specVersion === '2026-07-28') {
          return { status: 'completed', result: data.result };
        }
        const result = await this.getResult(signal);
        return { status: 'completed', result };
      }
      if (data.status === 'failed') {
        throw new TaskError(`Task "${this.taskId}": server báo thất bại`, this.taskId, 'failed');
      }
      if (data.status === 'cancelled') {
        throw new TaskError(`Task "${this.taskId}": đã bị huỷ`, this.taskId, 'cancelled');
      }
      if (data.status === 'input_required') {
        if (this.specVersion === '2026-07-28') {
          throw new TaskError(
            `Task "${this.taskId}": server đang chờ input thêm (input_required) — ` +
              `gọi sendInput() (tasks/update) rồi poll tiếp`,
            this.taskId,
            'input_required',
          );
        }
        throw new TaskError(
          `Task "${this.taskId}": server đang chờ input thêm (input_required) — ` +
            `spec 2025-11-25 chưa hỗ trợ gửi input cho task đang chạy`,
          this.taskId,
          'input_required',
        );
      }
      const delay = Math.min(this.pollIntervalMs * 2 ** attempt, maxPollIntervalMs);
      attempt += 1;
      await sleep(delay, signal);
    }
  }
}

/**
 * Liệt kê task của server qua `tasks/list` (spec 2025-11-25).
 * Extension 2026-07-28 đã BỎ `tasks/list` nên gọi với backend đó sẽ
 * ném `TaskError` ngay thay vì gửi method server không còn hỗ trợ.
 */
export async function listTasks(
  transport: McpTaskTransport,
  specVersion: McpTaskSpecVersion = '2025-11-25',
): Promise<TaskHandleData[]> {
  if (specVersion === '2026-07-28') {
    throw new TaskError(
      'Task: extension 2026-07-28 đã bỏ "tasks/list" — không liệt kê được task của server',
    );
  }
  let raw: unknown;
  try {
    raw = await transport.request(MCP_TASK_METHODS.list);
  } catch (err) {
    throw new TaskError(`Task: liệt kê task thất bại: ${(err as Error).message}`);
  }
  if (!isRecord(raw) || !Array.isArray(raw['tasks'])) {
    throw new TaskError('Task: server phải trả { tasks: [...] } cho tasks/list');
  }
  return (raw['tasks'] as unknown[]).map((t) => parseTaskHandle(t));
}

/**
 * Tiện ích một dòng: tạo task cho `method` rồi chờ tới khi xong, trả
 * kết quả gốc. Ném `TaskError` khi task fail / bị huỷ / chờ input / timeout.
 */
export async function runTaskToCompletion(
  transport: McpTaskTransport,
  method: string,
  params: Record<string, unknown> = {},
  options: CreateTaskOptions & WaitForCompletionOptions = {},
): Promise<unknown> {
  const handle = await createTask(transport, method, params, options);
  const { result } = await handle.waitForCompletion(options);
  return result;
}
