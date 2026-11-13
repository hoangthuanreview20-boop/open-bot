/**
 * MCP Tasks — server-side task store (v0.97, Team T1).
 *
 * The client side of Tasks already exists in `tasks.ts` (TaskHandle,
 * `tasks/get` / `tasks/result` / `tasks/cancel`, plus the official
 * 2026-07-28 extension adapter with `tasks/update`). This module is
 * the other half: the store a *server* uses to run long work in the
 * background and let clients poll it.
 *
 *   1. The server accepts a long job via `submit()` and returns a
 *      handle `{ taskId, status: 'working', pollInterval }` at once.
 *   2. The client polls `tasks/get` (served by `toTaskHandleData()`)
 *      until a terminal status.
 *   3. On the 2026-07-28 extension, `tasks/get` returns the final
 *      result directly when `completed`; on the 2025-11-25 shape the
 *      client fetches it with `tasks/result` (see `tasks.ts`).
 *   4. The client may `tasks/cancel` at any time, or send more input
 *      to an `input_required` task with `tasks/update`.
 *
 * Design notes:
 *   - In-memory only, no persistence: tasks are execution state, not
 *     user data. A server restart drops them (clients see "unknown
 *     task" and retry the work). The store caps its size so a
 *     misbehaving client cannot grow it without bound.
 *   - Cancellation is cooperative: `cancel()` marks the task and the
 *     runner checks `isCancelled(taskId)` / the abort signal between
 *     steps. A runner that ignores the signal still finishes, but its
 *     result is discarded and the stored status stays `cancelled`.
 *   - TTL expiry runs lazily on every read/write plus a `sweep()`
 *     the server calls on a timer; expired tasks vanish instead of
 *     accumulating.
 *   - `input_required` is a first-class status: `requestInput()`
 *     parks the task, `update()` delivers the client's answer and
 *     resumes it to `working`. This is what the 2026 extension's
 *     `tasks/update` method needs.
 */

import { randomUUID } from 'node:crypto';

export type ServerTaskStatus =
  | 'working'
  | 'input_required'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const SERVER_TASK_TERMINAL_STATUSES: readonly ServerTaskStatus[] = [
  'completed',
  'failed',
  'cancelled',
];

export function isServerTaskTerminal(status: ServerTaskStatus): boolean {
  return (SERVER_TASK_TERMINAL_STATUSES as readonly ServerTaskStatus[]).includes(status);
}

/** Maximum tasks the store keeps (oldest completed ones evict first). */
export const MCP_TASK_STORE_MAX_TASKS_DEFAULT = 200;
/** Default TTL for a finished task before it expires (10 minutes). */
export const MCP_TASK_STORE_DEFAULT_TTL_MS = 10 * 60_000;
/** Default suggested poll interval handed to clients (1 second). */
export const MCP_TASK_STORE_DEFAULT_POLL_INTERVAL_MS = 1_000;

/** One stored task, as the server sees it. */
export interface StoredMcpTask {
  taskId: string;
  /** Method that created the task, e.g. `tools/call`. */
  method: string;
  /** Parameters the task was created with (for debugging / resume). */
  params: Record<string, unknown>;
  status: ServerTaskStatus;
  /** Final result (only when `completed`, 2026-07-28 shape). */
  result?: unknown;
  /** Failure message (only when `failed`). */
  error?: string;
  /** What the task is waiting for (only when `input_required`). */
  inputRequest?: { prompt?: string; schema?: Record<string, unknown> };
  /** Monotonic progress 0..1 when the runner reports it. */
  progress?: number;
  /** Human-readable progress note. */
  progressMessage?: string;
  createdAtMs: number;
  updatedAtMs: number;
  /** Expires at (ms epoch); undefined = never expires while working. */
  expiresAtMs?: number;
}

/** The handle shape clients receive (`tasks/get` / creation reply). */
export interface ServerTaskHandleData {
  taskId: string;
  status: ServerTaskStatus;
  pollInterval?: number;
  ttl?: number;
  result?: unknown;
  error?: string;
  progress?: number;
  progressMessage?: string;
}

export class TaskStoreError extends Error {
  readonly taskId?: string;
  constructor(message: string, taskId?: string) {
    super(message);
    this.name = 'TaskStoreError';
    this.taskId = taskId;
  }
}

/** Runner for a submitted job. Receives a context to report progress and check cancellation. */
export interface McpTaskRunnerContext {
  taskId: string;
  /** True once `cancel()` has been called for this task. */
  isCancelled(): boolean;
  /** AbortSignal that fires on cancel (runners may pass it to fetch etc.). */
  signal: AbortSignal;
  /** Report progress 0..1 with an optional note. */
  reportProgress(progress: number, message?: string): void;
  /** Park the task in `input_required` until the client sends input. */
  requestInput(prompt?: string, schema?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface McpTaskStoreOptions {
  maxTasks?: number;
  defaultTtlMs?: number;
  defaultPollIntervalMs?: number;
  /** Clock injection for tests (defaults to `Date.now`). */
  nowMs?: () => number;
}

/**
 * In-memory store for server-side long-running MCP tasks.
 * One store per server instance. All methods are synchronous except
 * `submit`, which starts the runner in the background.
 */
export class McpTaskStore {
  private readonly tasks = new Map<string, StoredMcpTask>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly inputWaiters = new Map<
    string,
    { resolve: (value: Record<string, unknown>) => void; reject: (err: Error) => void }
  >();
  private readonly maxTasks: number;
  private readonly defaultTtlMs: number;
  private readonly defaultPollIntervalMs: number;
  private readonly nowMs: () => number;

  constructor(options: McpTaskStoreOptions = {}) {
    this.maxTasks = options.maxTasks ?? MCP_TASK_STORE_MAX_TASKS_DEFAULT;
    this.defaultTtlMs = options.defaultTtlMs ?? MCP_TASK_STORE_DEFAULT_TTL_MS;
    this.defaultPollIntervalMs =
      options.defaultPollIntervalMs ?? MCP_TASK_STORE_DEFAULT_POLL_INTERVAL_MS;
    this.nowMs = options.nowMs ?? Date.now;
  }

  /** Number of tasks currently stored (including expired-but-unswept). */
  get size(): number {
    return this.tasks.size;
  }

  /**
   * Submit a job to run in the background. Returns the handle at
   * once; the runner executes asynchronously. The runner's return
   * value becomes the task result; a thrown error becomes `failed`.
   * A runner that returns while cancelled keeps status `cancelled`
   * and its result is discarded.
   */
  submit(
    method: string,
    params: Record<string, unknown>,
    runner: (ctx: McpTaskRunnerContext) => Promise<unknown>,
    options: { pollIntervalMs?: number; ttlMs?: number } = {},
  ): ServerTaskHandleData {
    this.sweepExpired();
    if (this.tasks.size >= this.maxTasks) this.evictOldestFinished();
    const taskId = randomUUID();
    const now = this.nowMs();
    const task: StoredMcpTask = {
      taskId,
      method,
      params: { ...params },
      status: 'working',
      createdAtMs: now,
      updatedAtMs: now,
    };
    this.tasks.set(taskId, task);
    const controller = new AbortController();
    this.abortControllers.set(taskId, controller);
    const ctx: McpTaskRunnerContext = {
      taskId,
      isCancelled: () => controller.signal.aborted,
      signal: controller.signal,
      reportProgress: (progress, message) => {
        const current = this.tasks.get(taskId);
        if (!current || isServerTaskTerminal(current.status)) return;
        current.progress = Math.max(0, Math.min(1, progress));
        if (message !== undefined) current.progressMessage = message;
        current.updatedAtMs = this.nowMs();
      },
      requestInput: (prompt, schema) => this.requestInput(taskId, prompt, schema),
    };
    void runner(ctx)
      .then((result) => {
        const current = this.tasks.get(taskId);
        if (!current) return;
        if (controller.signal.aborted || current.status === 'cancelled') {
          current.status = 'cancelled';
        } else if (current.status === 'input_required') {
          // Runner returned while parked: the input answer arrived
          // but the runner ignored it — treat the return as the result.
          current.status = 'completed';
          current.result = result;
        } else {
          current.status = 'completed';
          current.result = result;
        }
        current.updatedAtMs = this.nowMs();
        current.expiresAtMs = this.nowMs() + (options.ttlMs ?? this.defaultTtlMs);
        this.abortControllers.delete(taskId);
      })
      .catch((err: unknown) => {
        const current = this.tasks.get(taskId);
        if (!current) return;
        if (controller.signal.aborted || current.status === 'cancelled') {
          current.status = 'cancelled';
        } else {
          current.status = 'failed';
          current.error = err instanceof Error ? err.message : 'Task failed.';
        }
        current.updatedAtMs = this.nowMs();
        current.expiresAtMs = this.nowMs() + (options.ttlMs ?? this.defaultTtlMs);
        this.abortControllers.delete(taskId);
      });
    return this.toHandleData(task, options.pollIntervalMs);
  }

  /** Park a task in `input_required` and wait for the client's answer. */
  requestInput(
    taskId: string,
    prompt?: string,
    schema?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const task = this.getOrThrow(taskId);
    if (isServerTaskTerminal(task.status)) {
      return Promise.reject(
        new TaskStoreError(`Task ${taskId} is ${task.status}; cannot request input.`, taskId),
      );
    }
    task.status = 'input_required';
    if (prompt !== undefined || schema !== undefined) {
      task.inputRequest = {
        ...(prompt !== undefined ? { prompt } : {}),
        ...(schema !== undefined ? { schema } : {}),
      };
    }
    task.updatedAtMs = this.nowMs();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.inputWaiters.set(taskId, { resolve, reject });
    });
  }

  /**
   * Deliver input to an `input_required` task (`tasks/update`).
   * The parked runner resumes with the answer; the task returns to
   * `working`. Throws when the task is not waiting for input.
   */
  update(taskId: string, input: Record<string, unknown>): ServerTaskHandleData {
    const task = this.getOrThrow(taskId);
    if (task.status !== 'input_required') {
      throw new TaskStoreError(
        `Task ${taskId} is ${task.status}; tasks/update needs input_required.`,
        taskId,
      );
    }
    const waiter = this.inputWaiters.get(taskId);
    this.inputWaiters.delete(taskId);
    task.status = 'working';
    task.inputRequest = undefined;
    task.updatedAtMs = this.nowMs();
    waiter?.resolve({ ...input });
    return this.toHandleData(task);
  }

  /**
   * Cancel a task (`tasks/cancel`). Working tasks are marked at once
   * and their abort signal fires; already-terminal tasks stay as
   * they are (cancelling a completed task is a no-op, not an error).
   * A parked `input_required` waiter is rejected so its runner can
   * unwind instead of hanging forever.
   */
  cancel(taskId: string): ServerTaskHandleData {
    const task = this.getOrThrow(taskId);
    if (!isServerTaskTerminal(task.status)) {
      task.status = 'cancelled';
      task.updatedAtMs = this.nowMs();
      task.expiresAtMs = this.nowMs() + this.defaultTtlMs;
      this.abortControllers.get(taskId)?.abort();
      const waiter = this.inputWaiters.get(taskId);
      if (waiter) {
        this.inputWaiters.delete(taskId);
        waiter.reject(new TaskStoreError(`Task ${taskId} was cancelled.`, taskId));
      }
    }
    return this.toHandleData(task);
  }

  /** Read one task (`tasks/get`). Throws `TaskStoreError` when unknown. */
  get(taskId: string): StoredMcpTask {
    return this.getOrThrow(taskId);
  }

  /** List tasks, newest first, optionally filtered by status. */
  list(status?: ServerTaskStatus): StoredMcpTask[] {
    this.sweepExpired();
    const all = [...this.tasks.values()].sort((a, b) => b.createdAtMs - a.createdAtMs);
    return status ? all.filter((t) => t.status === status) : all;
  }

  /** The client-facing handle for a stored task. */
  toHandleData(task: StoredMcpTask, pollIntervalMs?: number): ServerTaskHandleData {
    const out: ServerTaskHandleData = {
      taskId: task.taskId,
      status: task.status,
      pollInterval: pollIntervalMs ?? this.defaultPollIntervalMs,
    };
    if (task.expiresAtMs !== undefined) {
      out.ttl = Math.max(0, task.expiresAtMs - this.nowMs());
    }
    if (task.status === 'completed' && task.result !== undefined) out.result = task.result;
    if (task.status === 'failed' && task.error !== undefined) out.error = task.error;
    if (task.progress !== undefined) out.progress = task.progress;
    if (task.progressMessage !== undefined) out.progressMessage = task.progressMessage;
    return out;
  }

  /** Remove expired tasks. Returns how many were removed. */
  sweepExpired(nowMs: number = this.nowMs()): number {
    let removed = 0;
    for (const [id, task] of this.tasks) {
      if (task.expiresAtMs !== undefined && task.expiresAtMs <= nowMs) {
        this.tasks.delete(id);
        this.abortControllers.delete(id);
        const waiter = this.inputWaiters.get(id);
        if (waiter) {
          this.inputWaiters.delete(id);
          waiter.reject(new TaskStoreError(`Task ${id} expired.`, id));
        }
        removed += 1;
      }
    }
    return removed;
  }

  private getOrThrow(taskId: string): StoredMcpTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new TaskStoreError(`Unknown task: ${taskId}`, taskId);
    if (task.expiresAtMs !== undefined && task.expiresAtMs <= this.nowMs()) {
      this.tasks.delete(taskId);
      throw new TaskStoreError(`Unknown task: ${taskId} (expired)`, taskId);
    }
    return task;
  }

  private evictOldestFinished(): void {
    const finished = [...this.tasks.values()]
      .filter((t) => isServerTaskTerminal(t.status))
      .sort((a, b) => a.updatedAtMs - b.updatedAtMs);
    const victim = finished[0];
    if (victim) {
      this.tasks.delete(victim.taskId);
      this.abortControllers.delete(victim.taskId);
      return;
    }
    // No finished task to evict (all working): refuse to grow — the
    // caller gets a clear error instead of silent unbounded growth.
    throw new TaskStoreError(
      `Task store is full (${this.maxTasks} working tasks); try again later.`,
    );
  }
}
