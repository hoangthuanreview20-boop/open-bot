/**
 * Supervisor — decompose a goal, assign workers, watch, merge (v1.02
 * rescue port of the v0.99 work).
 *
 * The supervisor owns the plan: it splits a goal into subtasks
 * (through a host-provided `decomposer`, or from a manual list),
 * assigns each subtask to the best-scoring worker that still has
 * capacity, runs waves through the fan-out planner, retries a failed
 * subtask on another worker, escalates to the supervisor after
 * repeated failures, and merges the results at the end.
 *
 * The supervisor never runs a worker itself: `runBot` is injected
 * by the host (coordinator). Without it, `run()` throws — a
 * supervisor with no workers is a configuration error, not a silent
 * no-op.
 */

import type { OrchestraSession, OrchestraSubtask, WorkerCapability, WorkerResult } from './types';
import { scoreWorkerForSubtask } from './types';
import { Blackboard } from './blackboard';
import { OrchestraEventLog } from './events';
import { buildHandoffEnvelope } from './handoff';
import { mergeResults, type MergedResult } from './merge';
import { planFanOut, runFanOutWave } from './fanout';
import { resolveOrchestraPolicy, shouldEscalate, shouldRetrySubtask, type OrchestraPolicy } from './policy';

export interface SupervisorOptions {
  policy?: Partial<OrchestraPolicy>;
  /** Split a goal into subtasks (when omitted, the caller passes subtasks manually). */
  decomposer?: (goal: string) => Promise<Array<{ title: string; detail?: string; dependsOn?: string[] }>>;
  /** Run one subtask on a worker (injected by the host). */
  runBot?: (
    worker: WorkerCapability,
    envelope: ReturnType<typeof buildHandoffEnvelope>,
  ) => Promise<WorkerResult>;
  /** Called when a subtask escalates (host decides what to do). */
  onEscalate?: (sessionId: string, subtask: OrchestraSubtask, error: string) => void;
}

export interface SupervisorRunResult {
  session: OrchestraSession;
  subtasks: OrchestraSubtask[];
  merged: MergedResult;
}

/** Decomposes goals, assigns workers, runs waves, merges results. */
export class Supervisor {
  private readonly policy: OrchestraPolicy;
  private readonly decomposer?: SupervisorOptions['decomposer'];
  private readonly runBot?: SupervisorOptions['runBot'];
  private readonly onEscalate?: SupervisorOptions['onEscalate'];
  private consecutiveFailures = 0;

  constructor(options: SupervisorOptions = {}) {
    this.policy = resolveOrchestraPolicy(options.policy);
    this.decomposer = options.decomposer;
    this.runBot = options.runBot;
    this.onEscalate = options.onEscalate;
  }

  /** Split a goal into subtasks (decomposer or one subtask per line). */
  async decompose(goal: string): Promise<Array<{ title: string; detail?: string; dependsOn?: string[] }>> {
    if (this.decomposer) return this.decomposer(goal);
    return goal
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((title) => ({ title }));
  }

  /**
   * Pick the best worker for a subtask: highest score among workers
   * that have not been tried yet and still have capacity.
   */
  assignWorker(
    subtask: OrchestraSubtask,
    workers: WorkerCapability[],
    load: Map<string, number>,
  ): { worker: WorkerCapability; score: number } | undefined {
    let best: { worker: WorkerCapability; score: number } | undefined;
    for (const worker of workers) {
      if (subtask.triedWorkerIds.includes(worker.id)) continue;
      const capacity = worker.maxParallel ?? 1;
      if (capacity > 0 && (load.get(worker.id) ?? 0) >= capacity) continue;
      const score = scoreWorkerForSubtask(worker, subtask);
      if (!best || score > best.score) best = { worker, score };
    }
    return best;
  }

  /** Run a full session: decompose, assign, fan out, merge. */
  async run(
    session: OrchestraSession,
    workers: WorkerCapability[],
    subtaskInputs?: Array<{ title: string; detail?: string; dependsOn?: string[] }>,
  ): Promise<SupervisorRunResult> {
    if (!this.runBot) throw new Error('Supervisor needs a runBot callback to execute workers');
    const runBot = this.runBot;
    const now = new Date().toISOString();
    session.status = 'running';
    session.startedAt = now;
    const events = new OrchestraEventLog();
    events.append({ sessionId: session.id, kind: 'session_started' });
    const blackboard = new Blackboard(session.id);
    const inputs = subtaskInputs ?? (await this.decompose(session.goal));
    if (inputs.length > this.policy.maxSubtasks) {
      throw new Error(`goal decomposes into ${inputs.length} subtasks, over the policy max ${this.policy.maxSubtasks}`);
    }
    // Dependencies may be given as titles (plan steps) or as ids;
    // resolve titles to the ids assigned below.
    const idByTitle = new Map<string, string>();
    inputs.forEach((input, index) => idByTitle.set(input.title, `st-${index + 1}`));
    const resolveDep = (dep: string): string => idByTitle.get(dep) ?? dep;
    const subtasks: OrchestraSubtask[] = inputs.map((input, index) => ({
      id: `st-${index + 1}`,
      sessionId: session.id,
      title: input.title,
      ...(input.detail ? { detail: input.detail } : {}),
      status: 'pending',
      dependsOn: (input.dependsOn ?? []).map(resolveDep),
      priority: this.policy.defaultPriority,
      attempts: 0,
      maxAttempts: this.policy.maxAttempts,
      triedWorkerIds: [],
      createdAt: now,
    }));
    const byId = new Map(subtasks.map((s) => [s.id, s]));
    const results = new Map<string, WorkerResult>();
    const load = new Map<string, number>();
    const plan = planFanOut(subtasks);
    const startedAtMs = Date.now();
    let failed = false;
    for (const wave of plan.waves) {
      if (this.policy.maxSessionMs > 0 && Date.now() - startedAtMs > this.policy.maxSessionMs) {
        failed = true;
        break;
      }
      await runFanOutWave(wave, async (subtaskId) => {
        const subtask = byId.get(subtaskId)!;
        // Skip when a dependency failed (the wave cannot produce a result).
        if ((subtask.dependsOn ?? []).some((dep) => byId.get(dep)?.status === 'failed' || byId.get(dep)?.status === 'escalated')) {
          subtask.status = 'skipped';
          events.append({ sessionId: session.id, kind: 'subtask_skipped', subtaskId, message: 'dependency failed' });
          return;
        }
        // Attempt loop: retry on another worker until the policy says stop.
        for (;;) {
          const assignment = this.assignWorker(subtask, workers, load);
          if (!assignment) {
            subtask.status = 'escalated';
            subtask.error = 'no worker available';
            events.append({ sessionId: session.id, kind: 'subtask_escalated', subtaskId, message: 'no worker available' });
            this.onEscalate?.(session.id, subtask, 'no worker available');
            return;
          }
          const { worker, score } = assignment;
          subtask.assigneeWorkerId = worker.id;
          subtask.routingScore = score;
          subtask.status = 'assigned';
          subtask.attempts++;
          subtask.triedWorkerIds.push(worker.id);
          load.set(worker.id, (load.get(worker.id) ?? 0) + 1);
          events.append({ sessionId: session.id, kind: 'subtask_assigned', subtaskId, workerId: worker.id });
          const context: Record<string, unknown> = {};
          for (const entry of blackboard.list()) context[entry.key] = entry.value;
          const dependencyResults: Record<string, WorkerResult> = {};
          for (const dep of subtask.dependsOn ?? []) {
            const depResult = results.get(dep);
            if (depResult) dependencyResults[dep] = depResult;
          }
          const envelope = buildHandoffEnvelope(session.id, subtask, context, dependencyResults);
          events.append({ sessionId: session.id, kind: 'handoff_sent', subtaskId, workerId: worker.id });
          subtask.status = 'running';
          subtask.startedAt = new Date().toISOString();
          events.append({ sessionId: session.id, kind: 'subtask_started', subtaskId, workerId: worker.id });
          try {
            const result = await runBot(worker, envelope);
            subtask.status = 'done';
            subtask.result = result;
            subtask.finishedAt = new Date().toISOString();
            results.set(subtask.id, result);
            this.consecutiveFailures = 0;
            events.append({ sessionId: session.id, kind: 'subtask_done', subtaskId, workerId: worker.id });
            blackboard.set(`result:${subtask.id}`, result.output, worker.id);
            return;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            subtask.error = message;
            this.consecutiveFailures++;
            if (shouldEscalate(this.policy, this.consecutiveFailures)) {
              subtask.status = 'escalated';
              events.append({ sessionId: session.id, kind: 'subtask_escalated', subtaskId, workerId: worker.id, message });
              this.onEscalate?.(session.id, subtask, message);
              return;
            }
            if (shouldRetrySubtask(this.policy, subtask.attempts, this.consecutiveFailures)) {
              events.append({ sessionId: session.id, kind: 'subtask_retried', subtaskId, workerId: worker.id, message });
              continue;
            }
            subtask.status = 'failed';
            events.append({ sessionId: session.id, kind: 'subtask_failed', subtaskId, workerId: worker.id, message });
            return;
          } finally {
            load.set(worker.id, Math.max(0, (load.get(worker.id) ?? 1) - 1));
          }
        }
      });
    }
    const merged = mergeResults(subtasks, results);
    const done = subtasks.filter((s) => s.status === 'done').length;
    const failedCount = subtasks.filter((s) => s.status === 'failed' || s.status === 'escalated').length;
    session.status = failed ? 'failed' : failedCount === 0 ? 'done' : done > 0 ? 'partial' : 'failed';
    session.finishedAt = new Date().toISOString();
    session.summary = merged.combinedOutput;
    events.append({ sessionId: session.id, kind: 'session_finished', message: `done=${done} failed=${failedCount}` });
    events.append({ sessionId: session.id, kind: 'merge_done' });
    return { session, subtasks, merged };
  }
}
