/**
 * JobQueue — hàng đợi FIFO có ưu tiên cho job agent/tool.
 *
 * - Job là hàm `(signal) => Promise<T>`; signal bị abort khi job bị
 *   cancel hoặc hết timeout.
 * - Ưu tiên: số lớn chạy trước; cùng ưu tiên thì FIFO (theo thứ tự
 *   enqueue). Job đang chạy không bị preempt bởi job ưu tiên cao hơn.
 * - Giới hạn concurrency: tối đa N job chạy cùng lúc, còn lại chờ.
 * - pause()/resume(): tạm dừng lấy job mới (job đang chạy vẫn chạy
 *   tiếp); resume bơm lại hàng đợi.
 * - Timeout/cancel từng job: job quá hạn bị abort + reject với lỗi
 *   timeout; cancel job đang chờ thì nó không bao giờ chạy; cancel job
 *   đang chạy thì abort signal của nó.
 * - Sự kiện onJobDone/onJobFailed (nhận jobId + label) để UI/telemetry
 *   theo dõi mà không cần poll.
 */
export type JobFn<T = unknown> = (signal: AbortSignal) => Promise<T>;

export interface EnqueueOptions {
  /** Ưu tiên — số lớn chạy trước. Default 0. */
  priority?: number;
  /** Timeout riêng cho job này (ms). Mặc định lấy defaultTimeoutMs của queue (0 = không timeout). */
  timeoutMs?: number;
  /** Nhãn hiển thị (tên bot/tool) cho log/stats. */
  label?: string;
}

export interface JobQueueOptions {
  /** Số job chạy đồng thời tối đa. Default 1. */
  concurrency?: number;
  /** Timeout mặc định cho job (ms). 0 = không timeout. Default 0. */
  defaultTimeoutMs?: number;
  onJobDone?: (jobId: string, label?: string) => void;
  onJobFailed?: (jobId: string, error: Error, label?: string) => void;
}

export interface JobQueueStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  paused: boolean;
  concurrency: number;
}

export interface JobHandle<T = unknown> {
  id: string;
  label?: string;
  promise: Promise<T>;
  /** Huỷ job: đang chờ thì gỡ khỏi hàng đợi, đang chạy thì abort. */
  cancel: () => void;
}

let jobCounter = 0;

interface QueueEntry {
  id: string;
  seq: number;
  priority: number;
  label?: string;
  fn: JobFn<unknown>;
  timeoutMs: number;
  controller: AbortController;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  state: 'pending' | 'running' | 'done';
  timer: ReturnType<typeof setTimeout> | null;
  /** True khi người gọi đã cancel (kể cả job đang chạy). */
  cancelRequested: boolean;
}

export class JobQueue {
  private readonly concurrency: number;
  private readonly defaultTimeoutMs: number;
  private readonly onJobDone?: (jobId: string, label?: string) => void;
  private readonly onJobFailed?: (jobId: string, error: Error, label?: string) => void;
  private readonly pending: QueueEntry[] = [];
  private readonly running = new Set<QueueEntry>();
  private seq = 0;
  private paused = false;
  private completed = 0;
  private failed = 0;
  private cancelled = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(options: JobQueueOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 0;
    this.onJobDone = options.onJobDone;
    this.onJobFailed = options.onJobFailed;
  }

  /** Đưa job vào hàng đợi. Trả về handle có id/promise/cancel. */
  enqueue<T>(fn: JobFn<T>, options: EnqueueOptions = {}): JobHandle<T> {
    const id = `job-${++jobCounter}-${Date.now().toString(36)}`;
    const controller = new AbortController();
    let resolveFn!: (value: T) => void;
    let rejectFn!: (err: Error) => void;
    const promise = new Promise<T>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    // Tránh unhandled rejection khi job bị cancel/timeout mà caller
    // chưa kịp await — promise gốc vẫn reject cho caller, nhưng đã có
    // một catch gắn sẵn để runtime không báo unhandled.
    promise.catch(() => undefined);
    const entry: QueueEntry = {
      id,
      seq: this.seq++,
      priority: options.priority ?? 0,
      label: options.label,
      fn: (signal) => fn(signal) as Promise<unknown>,
      timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
      controller,
      resolve: (value: unknown) => resolveFn(value as T),
      reject: rejectFn,
      state: 'pending',
      timer: null,
      cancelRequested: false,
    };
    this.pending.push(entry);
    // Ưu tiên cao trước, cùng ưu tiên thì seq nhỏ (vào trước) trước.
    this.pending.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    const handle: JobHandle<T> = {
      id,
      label: options.label,
      promise,
      cancel: () => this.cancelEntry(entry),
    };
    this.pump();
    return handle;
  }

  /** Tạm dừng lấy job mới (job đang chạy không bị dừng). */
  pause(): void {
    this.paused = true;
  }

  /** Tiếp tục lấy job. */
  resume(): void {
    this.paused = false;
    this.pump();
  }

  isPaused(): boolean {
    return this.paused;
  }

  pendingCount(): number {
    return this.pending.length;
  }

  runningCount(): number {
    return this.running.size;
  }

  /** Resolve khi không còn job chờ hay chạy. Resolve ngay nếu đã idle. */
  waitIdle(): Promise<void> {
    if (this.pending.length === 0 && this.running.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  stats(): JobQueueStats {
    return {
      pending: this.pending.length,
      running: this.running.size,
      completed: this.completed,
      failed: this.failed,
      cancelled: this.cancelled,
      paused: this.paused,
      concurrency: this.concurrency,
    };
  }

  // -- internals ----------------------------------------------------------

  private cancelEntry(entry: QueueEntry): void {
    if (entry.state === 'done') return;
    if (entry.state === 'pending') {
      const idx = this.pending.indexOf(entry);
      if (idx >= 0) this.pending.splice(idx, 1);
      entry.state = 'done';
      this.cancelled += 1;
      entry.controller.abort();
      entry.reject(new Error(`Job ${entry.id} đã bị huỷ.`));
      this.checkIdle();
      return;
    }
    // Đang chạy: abort signal; job tự kết thúc (resolve/reject của nó
    // vẫn đi qua finish() bình thường — không reject đúp).
    entry.cancelRequested = true;
    entry.controller.abort();
  }

  private pump(): void {
    if (this.paused) return;
    while (this.running.size < this.concurrency && this.pending.length > 0) {
      const entry = this.pending.shift();
      if (!entry) break;
      this.runEntry(entry);
    }
    this.checkIdle();
  }

  private runEntry(entry: QueueEntry): void {
    entry.state = 'running';
    this.running.add(entry);
    if (entry.timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        if (entry.state !== 'running') return;
        entry.controller.abort();
        // Đánh dấu fail do timeout ngay (kể cả khi job lì không chịu
        // dừng sau abort — kết quả muộn của nó sẽ bị bỏ).
        this.finish(entry, false, new Error(`Job ${entry.id} hết thời gian chờ sau ${entry.timeoutMs}ms.`));
      }, entry.timeoutMs);
    }
    void entry
      .fn(entry.controller.signal)
      .then((value) => this.finish(entry, true, null, value))
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        this.finish(entry, false, error);
      });
  }

  private finish(
    entry: QueueEntry,
    ok: boolean,
    error: Error | null,
    value?: unknown,
  ): void {
    if (entry.state === 'done') return; // đã timeout/cancel trước đó
    entry.state = 'done';
    if (entry.timer !== null) clearTimeout(entry.timer);
    this.running.delete(entry);
    if (ok) {
      this.completed += 1;
      entry.resolve(value);
      this.onJobDone?.(entry.id, entry.label);
    } else {
      // Job bị cancel tay trong lúc chạy thì tính là cancelled (kể cả
      // khi nó reject bằng AbortError), còn lại là failed. Timeout đã
      // gọi finish với lỗi timeout nên cũng rơi vào nhánh failed.
      if (entry.cancelRequested) {
        this.cancelled += 1;
      } else {
        this.failed += 1;
      }
      entry.reject(error ?? new Error(`Job ${entry.id} thất bại.`));
      this.onJobFailed?.(entry.id, error ?? new Error(`Job ${entry.id} thất bại.`), entry.label);
    }
    this.pump();
  }

  private checkIdle(): void {
    if (this.pending.length === 0 && this.running.size === 0 && this.idleWaiters.length > 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }
}
