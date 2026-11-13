/**
 * McpTaskManager — điều phối NHIỀU MCP task dài cùng lúc (v0.98, sóng T6).
 *
 * `TaskHandle` trong ./tasks.ts chỉ lo MỘT task (poll/huỷ/chờ xong).
 * Manager này là lớp trên: tạo + theo dõi + huỷ + timeout + gửi input
 * cho nhiều task từ nhiều server, và phát snapshot cho UI (McpTasksView
 * qua IPC `mcp-tasks:list` / `mcp-tasks:cancel`).
 *
 * Mỗi task chạy một vòng chờ nền (`waitForCompletion`) với
 * AbortController riêng:
 *  - `completed` -> snapshot giữ `result` (2026-07-28: result nằm trong
 *    `tasks/get`; 2025-11-25: lấy qua `tasks/result` — xem TaskHandle).
 *  - `failed` / `cancelled` -> snapshot giữ `error`, trạng thái cuối.
 *  - `input_required` -> vòng chờ dừng, task vẫn tracked ở trạng thái
 *    `input_required`; gọi `sendInput()` rồi `resume()` để chạy tiếp
 *    (chỉ extension 2026-07-28 mới gửi được input — xem TaskHandle).
 *  - Hết `timeoutMs` -> snapshot `timedOut: true`, status `failed`,
 *    đồng thời huỷ task ở server (best-effort) để server không chạy
 *    mãi sau khi client đã bỏ.
 *  - `cancel()` huỷ cả vòng chờ (AbortController) lẫn task ở server
 *    (`tasks/cancel`).
 *
 * Snapshot không chứa TaskHandle (không serialize được qua IPC) — chỉ
 * dữ liệu hiển thị được. Manager giữ trong bộ nhớ của process tạo nó
 * (main process cho UI; tools layer cho `mcp_call_tool asTask`).
 */

import {
  TaskHandle,
  createTask,
  isTaskTerminal,
} from './tasks';
import type {
  CreateTaskOptions,
  McpTaskSpecVersion,
  McpTaskTransport,
  TaskStatus,
} from './tasks';

/** Số task tracked tối đa (vượt thì từ chối task mới, không lặng lẽ xoá cũ). */
export const MAX_TRACKED_TASKS = 50;

export interface TrackTaskMeta {
  /** Tên MCP server sở hữu task (để phân biệt taskId trùng nhau). */
  serverName: string;
  /** Tên method đã tạo task (vd `tools/call`). */
  method: string;
  /** Nhãn hiển thị (vd tên tool + tóm tắt args). */
  label: string;
  /** Tổng thời gian chờ tối đa (ms). Hết hạn -> failed + huỷ ở server. */
  timeoutMs?: number;
  /** Phiên bản tasks backend đang nói chuyện. */
  specVersion?: McpTaskSpecVersion;
  /** Khoảng poll mặc định khi server không gợi ý. */
  pollIntervalMs?: number;
}

/** Snapshot hiển thị được của một task (đi qua IPC ra renderer). */
export interface TaskSnapshot {
  /** Khóa duy nhất trong manager: `${serverName}:${taskId}`. */
  key: string;
  taskId: string;
  serverName: string;
  method: string;
  label: string;
  status: TaskStatus;
  specVersion: McpTaskSpecVersion;
  createdAt: number;
  updatedAt: number;
  /** Tổng thời gian chờ tối đa đã đặt (ms), nếu có. */
  timeoutMs?: number;
  /** True khi task kết thúc vì hết timeout (status lúc đó là failed). */
  timedOut: boolean;
  /** Khoảng poll hiện tại (ms) — UI hiện để user biết task poll thưa/dày cỡ nào. */
  pollIntervalMs: number;
  /** Kết quả cuối (chỉ khi completed). */
  result?: unknown;
  /** Thông báo lỗi (failed / cancelled / timeout / chờ input). */
  error?: string;
}

export type TaskChangeListener = (tasks: TaskSnapshot[]) => void;

interface TrackedEntry {
  handle: TaskHandle;
  snapshot: TaskSnapshot;
  controller: AbortController;
  /** Promise của vòng chờ nền (để `waitFor` bám vào). */
  done: Promise<void>;
  /** True khi vòng chờ nền đã kết thúc (dù task có thể resume được). */
  loopDone: boolean;
}

function taskKey(serverName: string, taskId: string): string {
  return `${serverName}:${taskId}`;
}

export class McpTaskManager {
  private readonly maxTracked: number;
  private readonly entries = new Map<string, TrackedEntry>();
  private readonly listeners = new Set<TaskChangeListener>();

  constructor(options: { maxTracked?: number } = {}) {
    this.maxTracked = Math.max(1, options.maxTracked ?? MAX_TRACKED_TASKS);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Đăng ký listener gọi mỗi khi snapshot của bất kỳ task nào đổi. Trả hàm huỷ đăng ký. */
  onChange(listener: TaskChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snapshot = this.list();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Một listener lỗi không được làm chết manager.
      }
    }
  }

  private update(entry: TrackedEntry, patch: Partial<TaskSnapshot>): void {
    entry.snapshot = { ...entry.snapshot, ...patch, updatedAt: Date.now() };
    this.emit();
  }

  /**
   * Tạo task qua transport rồi track ngay. Ném TaskError khi server
   * không trả task handle (xem createTask).
   */
  async create(
    transport: McpTaskTransport,
    method: string,
    params: Record<string, unknown>,
    meta: TrackTaskMeta,
    options: CreateTaskOptions = {},
  ): Promise<TaskSnapshot> {
    const handle = await createTask(transport, method, params, {
      ...options,
      specVersion: meta.specVersion ?? options.specVersion,
      pollIntervalMs: meta.pollIntervalMs ?? options.pollIntervalMs,
    });
    return this.track(handle, meta);
  }

  /**
   * Track một TaskHandle đã có (vd handle do `mcp_call_tool` tạo).
   * Ném khi đã đủ MAX_TRACKED_TASKS hoặc key đã tồn tại.
   */
  track(handle: TaskHandle, meta: TrackTaskMeta): TaskSnapshot {
    const key = taskKey(meta.serverName, handle.taskId);
    if (this.entries.has(key)) {
      throw new Error(`MCP task "${key}" đã được theo dõi.`);
    }
    if (this.entries.size >= this.maxTracked) {
      throw new Error(
        `Đã theo dõi tối đa ${this.maxTracked} MCP task — huỷ hoặc chờ task cũ xong trước.`,
      );
    }
    const now = Date.now();
    const entry: TrackedEntry = {
      handle,
      snapshot: {
        key,
        taskId: handle.taskId,
        serverName: meta.serverName,
        method: meta.method,
        label: meta.label,
        status: handle.status,
        specVersion: handle.specVersion,
        createdAt: now,
        updatedAt: now,
        timeoutMs: meta.timeoutMs,
        timedOut: false,
        pollIntervalMs: handle.pollIntervalMs,
      },
      controller: new AbortController(),
      done: Promise.resolve(),
      loopDone: false,
    };
    this.entries.set(key, entry);
    entry.done = this.runLoop(entry, meta.timeoutMs);
    this.emit();
    return { ...entry.snapshot };
  }

  /** Vòng chờ nền cho một task: cập nhật snapshot theo từng lần poll. */
  private async runLoop(entry: TrackedEntry, timeoutMs?: number): Promise<void> {
    const { handle } = entry;
    const startedAt = entry.snapshot.createdAt;
    try {
      const { result } = await handle.waitForCompletion({
        timeoutMs,
        signal: entry.controller.signal,
        onStatusChange: (status, data) => {
          this.update(entry, {
            status,
            pollIntervalMs: data.pollInterval ?? handle.pollIntervalMs,
            ...(data.result !== undefined ? { result: data.result } : {}),
          });
        },
      });
      this.update(entry, { status: 'completed', result });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      const status = handle.status;
      if (entry.controller.signal.aborted) {
        // Huỷ từ manager (cancel/cancelAll/stop): status do handle.cancel()
        // đặt, hoặc giữ nguyên nếu server chưa xác nhận.
        this.update(entry, {
          status: isTaskTerminal(status) ? status : 'cancelled',
          error: message,
        });
        return;
      }
      if (timeoutMs !== undefined && Date.now() - startedAt >= timeoutMs) {
        // Hết timeout: huỷ ở server để nó không chạy mãi sau khi client bỏ.
        try {
          await handle.cancel();
        } catch {
          // Best-effort — snapshot vẫn ghi timeout.
        }
        this.update(entry, {
          status: 'failed',
          timedOut: true,
          error: message,
        });
        return;
      }
      if (status === 'input_required') {
        // Server chờ input thêm: vòng chờ dừng, task vẫn tracked để
        // user gửi input rồi resume() (chỉ 2026-07-28).
        this.update(entry, { status: 'input_required', error: message });
        return;
      }
      this.update(entry, {
        status: isTaskTerminal(status) ? status : 'failed',
        error: message,
      });
    } finally {
      entry.loopDone = true;
    }
  }

  /** Chờ một task tới trạng thái cuối (hoặc vòng chờ hiện tại kết thúc). */
  async waitFor(key: string): Promise<TaskSnapshot> {
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`Không có MCP task "${key}" đang theo dõi.`);
    await entry.done;
    return { ...entry.snapshot };
  }

  /** Lấy snapshot một task (bản sao), hoặc undefined. */
  get(key: string): TaskSnapshot | undefined {
    const entry = this.entries.get(key);
    return entry ? { ...entry.snapshot } : undefined;
  }

  /** Danh sách snapshot, mới tạo nhất trước. */
  list(): TaskSnapshot[] {
    // Map giữ thứ tự chèn; đảo trước khi sort ổn định để hai task tạo
    // cùng 1 mili-giây (createdAt bằng nhau) vẫn xếp task tạo sau lên trước.
    return [...this.entries.values()]
      .reverse()
      .map((entry) => ({ ...entry.snapshot }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Số task chưa tới trạng thái cuối. */
  activeCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (!isTaskTerminal(entry.snapshot.status)) count += 1;
    }
    return count;
  }

  /**
   * Huỷ một task: dừng vòng chờ + gửi `tasks/cancel` tới server.
   * Best-effort: vòng chờ luôn dừng ngay cả khi server không trả lời.
   */
  async cancel(key: string): Promise<TaskSnapshot> {
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`Không có MCP task "${key}" đang theo dõi.`);
    if (isTaskTerminal(entry.snapshot.status)) return { ...entry.snapshot };
    entry.controller.abort();
    try {
      await entry.handle.cancel();
    } catch {
      // Server không xác nhận huỷ — snapshot vẫn ghi cancelled vì
      // client đã dừng chờ; lỗi ghi vào error để UI thấy.
      this.update(entry, { status: 'cancelled', error: 'Huỷ ở client; server không xác nhận.' });
      return { ...entry.snapshot };
    }
    this.update(entry, { status: entry.handle.status });
    await entry.done.catch(() => undefined);
    return { ...entry.snapshot };
  }

  /** Huỷ tất cả task chưa xong. */
  async cancelAll(): Promise<void> {
    const keys = [...this.entries.keys()].filter(
      (key) => !isTaskTerminal(this.entries.get(key)?.snapshot.status ?? 'completed'),
    );
    await Promise.all(keys.map((key) => this.cancel(key).catch(() => undefined)));
  }

  /**
   * Gửi input cho task đang `input_required` rồi chạy tiếp vòng chờ.
   * Chỉ extension 2026-07-28 hỗ trợ (xem TaskHandle.sendInput).
   */
  async sendInput(key: string, input: unknown): Promise<TaskSnapshot> {
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`Không có MCP task "${key}" đang theo dõi.`);
    if (entry.snapshot.status !== 'input_required') {
      throw new Error(
        `MCP task "${key}" đang ở trạng thái "${entry.snapshot.status}" — chỉ gửi input khi server chờ input (input_required).`,
      );
    }
    const data = await entry.handle.sendInput(input);
    this.update(entry, { status: data.status, error: undefined });
    return this.resume(key);
  }

  /**
   * Chạy lại vòng chờ cho task đang `input_required` (sau sendInput) —
   * hoặc task mà vòng chờ đã dừng vì lý do khác mà status chưa cuối.
   */
  resume(key: string): TaskSnapshot {
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`Không có MCP task "${key}" đang theo dõi.`);
    if (isTaskTerminal(entry.snapshot.status)) {
      throw new Error(`MCP task "${key}" đã ở trạng thái cuối (${entry.snapshot.status}) — không resume được.`);
    }
    if (!entry.loopDone) return { ...entry.snapshot };
    entry.controller = new AbortController();
    entry.loopDone = false;
    const remaining =
      entry.snapshot.timeoutMs !== undefined
        ? Math.max(0, entry.snapshot.timeoutMs - (Date.now() - entry.snapshot.createdAt))
        : undefined;
    entry.done = this.runLoop(entry, remaining);
    this.emit();
    return { ...entry.snapshot };
  }

  /**
   * Xoá task đã tới trạng thái cuối và xong trước `olderThanMs` (mặc
   * định: xoá ngay mọi task cuối). Task đang chạy không bao giờ bị xoá.
   * Trả số task đã xoá.
   */
  pruneTerminal(olderThanMs = 0): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of [...this.entries]) {
      if (isTaskTerminal(entry.snapshot.status) && now - entry.snapshot.updatedAt >= olderThanMs) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) this.emit();
    return removed;
  }

  /** Dừng mọi vòng chờ (dùng khi shutdown): huỷ tất cả task chưa xong. */
  async stop(): Promise<void> {
    await this.cancelAll();
  }
}
