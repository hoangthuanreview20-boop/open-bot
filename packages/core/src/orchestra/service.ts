/**
 * Orchestra service — the host-facing facade (v1.02 rescue port of
 * the v0.99 work).
 *
 * The coordinator (or a tool) talks to this service, not to the
 * supervisor directly: the service creates sessions, persists them
 * through the store, runs them through the supervisor with the
 * host's `runBot`, and cancels a running session by id. A session
 * that is cancelled mid-run stops after the current wave (the
 * supervisor checks the flag between waves).
 */

import { randomUUID } from 'node:crypto';

import type { OrchestraSession, WorkerCapability, WorkerResult } from './types';
import { Supervisor, type SupervisorOptions, type SupervisorRunResult } from './supervisor';
import { OrchestraStore } from './store';
import type { PlanStep } from './planAdapter';
import { planToSubtasks } from './planAdapter';
import type { HandoffEnvelope } from './handoff';

export interface OrchestraServiceOptions extends SupervisorOptions {
  /** Directory for session persistence. */
  storeDir: string;
}

export interface OrchestraRunRequest {
  goal: string;
  workers: WorkerCapability[];
  /** Subtasks given directly (skips decomposition). */
  subtasks?: PlanStep[];
  supervisorBotId?: string;
}

/** Host-facing orchestration: create, run, list, cancel sessions. */
export class OrchestraService {
  private readonly store: OrchestraStore;
  private readonly supervisorOptions: SupervisorOptions;
  private readonly cancelled = new Set<string>();

  constructor(options: OrchestraServiceOptions) {
    this.store = new OrchestraStore(options.storeDir);
    this.supervisorOptions = options;
  }

  /** Create a session (not started yet). */
  createSession(goal: string, supervisorBotId?: string): OrchestraSession {
    const now = new Date().toISOString();
    const session: OrchestraSession = {
      id: randomUUID(),
      goal,
      status: 'created',
      createdAt: now,
      updatedAt: now,
      subtaskIds: [],
      ...(supervisorBotId ? { supervisorBotId } : {}),
    };
    this.store.save(session, []);
    return session;
  }

  /** Run a session to completion (or cancellation). */
  async runSession(request: OrchestraRunRequest): Promise<SupervisorRunResult> {
    const session = this.createSession(request.goal, request.supervisorBotId);
    const supervisor = new Supervisor({
      ...this.supervisorOptions,
      runBot: this.supervisorOptions.runBot
        ? async (worker: WorkerCapability, envelope: HandoffEnvelope): Promise<WorkerResult> => {
            if (this.cancelled.has(session.id)) throw new Error('session cancelled');
            return this.supervisorOptions.runBot!(worker, envelope);
          }
        : undefined,
    });
    const subtaskInputs = request.subtasks;
    const result = await supervisor.run(session, request.workers, subtaskInputs);
    session.updatedAt = new Date().toISOString();
    this.store.save(result.session, result.subtasks);
    return result;
  }

  /** Run a session from plan steps (converted by the plan adapter). */
  async runPlan(goal: string, steps: PlanStep[], workers: WorkerCapability[]): Promise<SupervisorRunResult> {
    const session = this.createSession(goal);
    const subtasks = planToSubtasks(session.id, steps);
    const supervisor = new Supervisor(this.supervisorOptions);
    const result = await supervisor.run(
      session,
      workers,
      subtasks.map((s) => ({
        title: s.title,
        detail: s.detail,
        // Supervisor resolves dependency titles to ids itself.
        dependsOn: (s.dependsOn ?? []).map((dep) => subtasks.find((t) => t.id === dep)?.title ?? dep),
      })),
    );
    session.updatedAt = new Date().toISOString();
    this.store.save(result.session, result.subtasks);
    return result;
  }

  /** Mark a session cancelled (the run stops after the current wave). */
  cancel(sessionId: string): boolean {
    this.cancelled.add(sessionId);
    const stored = this.store.get(sessionId);
    if (!stored) return false;
    stored.session.status = 'cancelled';
    stored.session.updatedAt = new Date().toISOString();
    this.store.save(stored.session, stored.subtasks);
    return true;
  }

  get(sessionId: string) {
    return this.store.get(sessionId);
  }

  list(): OrchestraSession[] {
    return this.store.list();
  }
}
