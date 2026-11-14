/**
 * Task checkpoints — durable per-task progress records (v1.02 rescue
 * port of the v1.00 work).
 *
 * Different from the run-step checkpoints in `agent/checkpoints.ts`
 * (one SQLite row per agent-loop step): a task checkpoint is a JSON
 * file per long task holding the task state + the latest compacted
 * summary, so a task can resume after a restart without replaying
 * the whole agent history. Writes are atomic (temp + rename).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { LongTaskSnapshot } from './longTask';

export interface TaskCheckpoint {
  id: string;
  taskId: string;
  createdAt: string;
  /** Monotonic sequence within the task (later = newer). */
  seq: number;
  task: LongTaskSnapshot;
  /** Compacted summary of the work done so far (kept short). */
  summary?: string;
  /** Arbitrary small state the host wants to resume from. */
  state?: Record<string, unknown>;
}

export interface TaskCheckpointStoreOptions {
  /** Directory holding one `<taskId>.checkpoints.json` file per task. */
  dir: string;
  /** Max checkpoints kept per task (default 20, oldest dropped). */
  maxPerTask?: number;
}

/** File-backed task checkpoint store. */
export class TaskCheckpointStore {
  private readonly dir: string;
  private readonly maxPerTask: number;

  constructor(options: TaskCheckpointStoreOptions) {
    this.dir = options.dir;
    this.maxPerTask = options.maxPerTask ?? 20;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Write a checkpoint for a task (seq auto-increments). */
  save(taskId: string, task: LongTaskSnapshot, summary?: string, state?: Record<string, unknown>): TaskCheckpoint {
    const existing = this.list(taskId);
    const checkpoint: TaskCheckpoint = {
      id: randomUUID(),
      taskId,
      createdAt: new Date().toISOString(),
      seq: (existing[existing.length - 1]?.seq ?? 0) + 1,
      task,
      ...(summary !== undefined ? { summary } : {}),
      ...(state !== undefined ? { state } : {}),
    };
    const next = [...existing, checkpoint].slice(-this.maxPerTask);
    this.writeFile(taskId, next);
    return checkpoint;
  }

  /** All checkpoints of a task, oldest first. */
  list(taskId: string): TaskCheckpoint[] {
    try {
      const raw = fs.readFileSync(this.filePath(taskId), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (entry): entry is TaskCheckpoint =>
          typeof entry === 'object' && entry !== null && typeof (entry as TaskCheckpoint).id === 'string',
      );
    } catch {
      return [];
    }
  }

  /** The newest checkpoint of a task (undefined when none). */
  latest(taskId: string): TaskCheckpoint | undefined {
    const checkpoints = this.list(taskId);
    return checkpoints[checkpoints.length - 1];
  }

  /** Delete all checkpoints of a task. */
  clear(taskId: string): void {
    try {
      fs.unlinkSync(this.filePath(taskId));
    } catch {
      // Already gone.
    }
  }

  private filePath(taskId: string): string {
    const safe = taskId.replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(this.dir, `${safe}.checkpoints.json`);
  }

  private writeFile(taskId: string, checkpoints: TaskCheckpoint[]): void {
    const filePath = this.filePath(taskId);
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(checkpoints, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  }
}
