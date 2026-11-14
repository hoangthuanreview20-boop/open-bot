/**
 * Long-running tasks — state machine + heartbeats (v1.02 rescue
 * port of the v1.00 work).
 *
 * A long task is work that outlives one agent turn (a big refactor,
 * a research sweep, a multi-hour job). `LongTask` tracks its state
 * (created -> running -> paused -> running ... -> done/failed/
 * cancelled), its progress (done/total steps), and a heartbeat so a
 * crashed host can tell a live task from a dead one. The task itself
 * is executed by the host; this module only owns the bookkeeping,
 * so a crash never loses the "what was done" record.
 */

export type LongTaskStatus = 'created' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';

export interface LongTaskSnapshot {
  id: string;
  title: string;
  status: LongTaskStatus;
  createdAt: string;
  updatedAt: string;
  lastHeartbeatAt: string;
  stepsDone: number;
  stepsTotal: number;
  /** Human-readable current step (shown in the UI). */
  currentStep?: string;
  error?: string;
  result?: string;
}

/** A task is stale when its heartbeat is older than this (default 5 min). */
export const LONG_TASK_STALE_MS = 5 * 60 * 1000;

/** Bookkeeping for one long-running task (pure, in-memory). */
export class LongTask {
  private snapshot: LongTaskSnapshot;

  constructor(id: string, title: string, stepsTotal = 0) {
    const now = new Date().toISOString();
    this.snapshot = {
      id,
      title,
      status: 'created',
      createdAt: now,
      updatedAt: now,
      lastHeartbeatAt: now,
      stepsDone: 0,
      stepsTotal,
    };
  }

  get state(): LongTaskSnapshot {
    return { ...this.snapshot };
  }

  get status(): LongTaskStatus {
    return this.snapshot.status;
  }

  /** 0..1 progress (1 when done, 0 when no steps are known). */
  get progress(): number {
    if (this.snapshot.status === 'done') return 1;
    if (this.snapshot.stepsTotal <= 0) return 0;
    return Math.min(1, this.snapshot.stepsDone / this.snapshot.stepsTotal);
  }

  start(): void {
    if (this.snapshot.status !== 'created' && this.snapshot.status !== 'paused') {
      throw new Error(`cannot start a long task in status ${this.snapshot.status}`);
    }
    this.snapshot.status = 'running';
    this.touch();
  }

  pause(): void {
    if (this.snapshot.status !== 'running') {
      throw new Error(`cannot pause a long task in status ${this.snapshot.status}`);
    }
    this.snapshot.status = 'paused';
    this.touch();
  }

  /** Advance one step (optionally describing the next step). */
  advance(currentStep?: string): void {
    if (this.snapshot.status !== 'running') {
      throw new Error(`cannot advance a long task in status ${this.snapshot.status}`);
    }
    this.snapshot.stepsDone += 1;
    if (currentStep !== undefined) this.snapshot.currentStep = currentStep;
    this.touch();
  }

  setTotal(stepsTotal: number): void {
    this.snapshot.stepsTotal = Math.max(0, stepsTotal);
    this.touch();
  }

  complete(result?: string): void {
    this.snapshot.status = 'done';
    if (result !== undefined) this.snapshot.result = result;
    this.touch();
  }

  fail(error: string): void {
    this.snapshot.status = 'failed';
    this.snapshot.error = error;
    this.touch();
  }

  cancel(): void {
    if (this.snapshot.status === 'done' || this.snapshot.status === 'failed') {
      throw new Error(`cannot cancel a long task in status ${this.snapshot.status}`);
    }
    this.snapshot.status = 'cancelled';
    this.touch();
  }

  /** Refresh the heartbeat (call while the task is alive). */
  heartbeat(): void {
    this.touch();
  }

  /** True when the heartbeat is older than `staleMs` (default 5 min). */
  isStale(now = Date.now(), staleMs = LONG_TASK_STALE_MS): boolean {
    return now - Date.parse(this.snapshot.lastHeartbeatAt) > staleMs;
  }

  /** Restore a task from a snapshot (e.g. after a restart). */
  static fromSnapshot(snapshot: LongTaskSnapshot): LongTask {
    const task = new LongTask(snapshot.id, snapshot.title, snapshot.stepsTotal);
    task.snapshot = { ...snapshot };
    return task;
  }

  private touch(): void {
    const now = new Date().toISOString();
    this.snapshot.updatedAt = now;
    this.snapshot.lastHeartbeatAt = now;
  }
}
