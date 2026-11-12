/**
 * WorkerPool — N worker chạy job agent/tool song song.
 *
 * Mỗi worker chạy một job tại một thời điểm; pool là một JobQueue có
 * concurrency = số worker. Giới hạn tài nguyên từng worker qua config:
 *
 * - `size`: số worker song song (mặc định = số CPU logic, tối đa 8 —
 *   desktop local-first không cần nhiều hơn; nhiều bot vẫn xếp hàng
 *   thay vì làm máy ì).
 * - `maxConcurrentToolExecs`: trần số lần thực thi tool đồng thời trên
 *   toàn pool. Concurrency hiệu dụng = min(size, maxConcurrentToolExecs)
 *   — đặt thấp hơn size khi tool nặng (shell, fetch) để tránh quá tải.
 * - `maxJobTimeMs`: timeout từng job (mặc định 5 phút); job quá hạn bị
 *   abort + fail, worker được giải phóng cho job sau.
 *
 * API: submit(fn, opts) → JobHandle (id/promise/cancel),
 * waitAll() → đợi mọi job xong, stats() → snapshot cho UI Settings.
 */
import { JobQueue } from './queue';
import type { EnqueueOptions, JobFn, JobHandle, JobQueueStats } from './queue';
import { cpus } from 'node:os';

export interface WorkerPoolOptions {
  /** Số worker. Default min(số CPU, 8), tối thiểu 1. */
  size?: number;
  /** Trần số lần thực thi tool đồng thời. Default = size. */
  maxConcurrentToolExecs?: number;
  /** Timeout từng job (ms). Default 5 phút, 0 = không timeout. */
  maxJobTimeMs?: number;
  onJobDone?: (jobId: string, label?: string) => void;
  onJobFailed?: (jobId: string, error: Error, label?: string) => void;
}

export interface WorkerPoolStats extends JobQueueStats {
  /** Số worker của pool. */
  workers: number;
  /** Số worker đang bận (== running khi mỗi worker 1 job). */
  busyWorkers: number;
  /** Số worker đang rảnh. */
  idleWorkers: number;
  /** Concurrency hiệu dụng = min(size, maxConcurrentToolExecs). */
  effectiveConcurrency: number;
  maxConcurrentToolExecs: number;
}

export const DEFAULT_MAX_JOB_TIME_MS = 5 * 60 * 1000;

export function defaultPoolSize(): number {
  try {
    return Math.min(Math.max(1, cpus().length), 8);
  } catch {
    return 4;
  }
}

export class WorkerPool {
  private readonly queue: JobQueue;
  private readonly size: number;
  private readonly maxConcurrentToolExecs: number;
  private readonly effectiveConcurrency: number;

  constructor(options: WorkerPoolOptions = {}) {
    this.size = Math.max(1, options.size ?? defaultPoolSize());
    this.maxConcurrentToolExecs = Math.max(1, options.maxConcurrentToolExecs ?? this.size);
    this.effectiveConcurrency = Math.min(this.size, this.maxConcurrentToolExecs);
    this.queue = new JobQueue({
      concurrency: this.effectiveConcurrency,
      defaultTimeoutMs: options.maxJobTimeMs ?? DEFAULT_MAX_JOB_TIME_MS,
      onJobDone: options.onJobDone,
      onJobFailed: options.onJobFailed,
    });
  }

  /** Đưa job vào pool. Trả về handle có id/promise/cancel. */
  submit<T>(fn: JobFn<T>, options: EnqueueOptions = {}): JobHandle<T> {
    return this.queue.enqueue(fn, options);
  }

  /** Đợi mọi job đã submit hoàn tất (xong/lỗi/huỷ). */
  waitAll(): Promise<void> {
    return this.queue.waitIdle();
  }

  pause(): void {
    this.queue.pause();
  }

  resume(): void {
    this.queue.resume();
  }

  stats(): WorkerPoolStats {
    const q = this.queue.stats();
    const busy = Math.min(q.running, this.size);
    return {
      ...q,
      workers: this.size,
      busyWorkers: busy,
      idleWorkers: this.size - busy,
      effectiveConcurrency: this.effectiveConcurrency,
      maxConcurrentToolExecs: this.maxConcurrentToolExecs,
    };
  }
}
