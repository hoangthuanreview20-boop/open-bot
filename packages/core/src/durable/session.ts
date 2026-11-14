/**
 * Durable session — lifecycle of one running agent run (v1.02 rescue
 * port of the v0.99 work).
 *
 * `DurableSession` wraps a `RunJournal` + the active-run registry:
 * it writes `run_started`, heartbeats the registry (default every
 * 15s, unref'd timer), checkpoints on demand or periodically, and
 * finishes with `run_finished` + unregister (idempotent). `abandon()`
 * simulates a crash for tests (stops the heartbeat without writing
 * `run_finished`, so recovery can find the run).
 */

import { RunJournal, type JournalCheckpointData } from './journal';
import { ActiveRunRegistry } from './recovery';

export interface DurableSessionOptions {
  runId: string;
  botId?: string;
  journalDir: string;
  /** Registry file for active runs (optional; without it no heartbeat is kept). */
  registryFile?: string;
  /** Heartbeat interval in ms (default 15s). */
  heartbeatMs?: number;
  /** Checkpoint every N steps (0 = only on demand; default 0). */
  checkpointEverySteps?: number;
}

/** One running agent run, journaled + registered for crash recovery. */
export class DurableSession {
  readonly runId: string;
  readonly botId?: string;
  readonly journal: RunJournal;
  private readonly registry?: ActiveRunRegistry;
  private readonly heartbeatMs: number;
  private readonly checkpointEverySteps: number;
  private timer?: NodeJS.Timeout;
  private stepsSinceCheckpoint = 0;
  private finished = false;

  constructor(options: DurableSessionOptions) {
    this.runId = options.runId;
    this.botId = options.botId;
    this.journal = new RunJournal(options.runId, options.journalDir);
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.checkpointEverySteps = options.checkpointEverySteps ?? 0;
    if (options.registryFile) {
      this.registry = new ActiveRunRegistry(options.registryFile);
    }
  }

  /** Start the run: write `run_started`, register, start the heartbeat. */
  start(meta?: Record<string, unknown>): void {
    this.journal.record('run_started', { botId: this.botId, ...(meta ?? {}) });
    this.registry?.register(this.runId, this.botId);
    this.startHeartbeat();
  }

  /** Record a completed step; checkpoints periodically when configured. */
  stepCompleted(stepIndex: number, checkpoint?: JournalCheckpointData): void {
    this.journal.recordStepCompleted(stepIndex);
    this.stepsSinceCheckpoint++;
    if (checkpoint) this.checkpoint(checkpoint);
    else if (this.checkpointEverySteps > 0 && this.stepsSinceCheckpoint >= this.checkpointEverySteps) {
      this.stepsSinceCheckpoint = 0;
    }
  }

  /** Write a checkpoint snapshot now. */
  checkpoint(data: JournalCheckpointData): boolean {
    this.stepsSinceCheckpoint = 0;
    return this.journal.checkpoint(data);
  }

  /** Finish the run: `run_finished` + stop the timer + unregister (idempotent). */
  finish(result?: string): void {
    if (this.finished) return;
    this.finished = true;
    this.stopHeartbeat();
    this.journal.finish(result);
    this.registry?.unregister(this.runId);
  }

  /** Simulate a crash: stop the heartbeat WITHOUT finishing (for tests). */
  abandon(): void {
    this.stopHeartbeat();
  }

  get isFinished(): boolean {
    return this.finished;
  }

  private startHeartbeat(): void {
    if (!this.registry) return;
    this.timer = setInterval(() => {
      this.registry?.heartbeat(this.runId);
    }, this.heartbeatMs);
    this.timer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
