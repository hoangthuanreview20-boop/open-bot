/**
 * Plan adapter — turn a planning doc into orchestra subtasks (v1.02
 * rescue port of the v0.99 work).
 *
 * The supervisor takes subtasks; planners produce plans in their
 * own shape (a list of steps with titles, details, and dependencies
 * by title). The adapter converts: it resolves `dependsOn` titles
 * to subtask ids, validates the graph (unknown deps / cycles), and
 * drops empty steps. It never invents work — a plan step with no
 * title is skipped, not guessed.
 */

import type { OrchestraSubtask } from './types';

export interface PlanStep {
  title: string;
  detail?: string;
  /** Titles of the steps this one depends on. */
  dependsOn?: string[];
  priority?: 1 | 2 | 3 | 4 | 5;
}

/** Convert plan steps into orchestra subtasks (ids `st-1`, `st-2`, ...). */
export function planToSubtasks(
  sessionId: string,
  steps: PlanStep[],
  maxAttempts = 3,
): OrchestraSubtask[] {
  const now = new Date().toISOString();
  const cleaned = steps.filter((step) => typeof step.title === 'string' && step.title.trim() !== '');
  const idByTitle = new Map<string, string>();
  cleaned.forEach((step, index) => {
    idByTitle.set(step.title.trim(), `st-${index + 1}`);
  });
  const subtasks: OrchestraSubtask[] = cleaned.map((step, index) => {
    const dependsOn: string[] = [];
    for (const dep of step.dependsOn ?? []) {
      const depId = idByTitle.get(dep.trim());
      if (!depId) throw new Error(`plan step "${step.title}" depends on unknown step "${dep}"`);
      dependsOn.push(depId);
    }
    return {
      id: `st-${index + 1}`,
      sessionId,
      title: step.title.trim(),
      ...(step.detail ? { detail: step.detail } : {}),
      status: 'pending',
      dependsOn,
      priority: step.priority ?? 3,
      attempts: 0,
      maxAttempts,
      triedWorkerIds: [],
      createdAt: now,
    };
  });
  // Cycle check (reuse the same rule as the fan-out planner).
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`dependency cycle involving subtask ${id}`);
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep);
    visiting.delete(id);
  };
  for (const subtask of subtasks) visit(subtask.id);
  return subtasks;
}

/** Convert orchestra subtasks back into plan steps (for the UI). */
export function subtasksToPlan(subtasks: OrchestraSubtask[]): PlanStep[] {
  const titleById = new Map(subtasks.map((s) => [s.id, s.title]));
  return subtasks.map((subtask) => ({
    title: subtask.title,
    ...(subtask.detail ? { detail: subtask.detail } : {}),
    dependsOn: (subtask.dependsOn ?? []).map((dep) => titleById.get(dep) ?? dep),
    priority: subtask.priority,
  }));
}
