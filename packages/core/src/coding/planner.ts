/**
 * Task planner for coding runs (v1.02, Team T4).
 *
 * Turns a task description into a small, explicit plan before any
 * code changes happen. The plan is deterministic (no model call):
 * every task gets Explore -> Implement -> Verify -> Finish, and any
 * bulleted / numbered sub-tasks in the description become their own
 * implement steps. The agent loop marks steps as it goes, so a run's
 * progress is always visible in the event log.
 */

import { randomUUID } from 'node:crypto';

/** Lifecycle of one plan step. */
export type CodingPlanStepStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';

/** One step of a coding plan. */
export interface CodingPlanStep {
  id: string;
  kind: 'explore' | 'implement' | 'verify' | 'finish';
  description: string;
  status: CodingPlanStepStatus;
  note?: string;
}

/** A coding plan: ordered steps plus the task it came from. */
export interface CodingPlan {
  task: string;
  steps: CodingPlanStep[];
  createdAt: string;
}

/** Split a task description into explicit sub-tasks, if it lists any. */
export function extractSubTasks(task: string): string[] {
  const out: string[] = [];
  for (const line of task.split('\n')) {
    const m = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/);
    if (m?.[1]) out.push(m[1] as string);
  }
  return out;
}

/**
 * Build a plan for a task. Deterministic: the same task always
 * produces the same plan.
 */
export function createPlan(task: string): CodingPlan {
  const steps: CodingPlanStep[] = [];
  const add = (kind: CodingPlanStep['kind'], description: string): void => {
    steps.push({ id: randomUUID(), kind, description, status: 'pending' });
  };
  add('explore', 'Explore the workspace: list files relevant to the task');
  const subTasks = extractSubTasks(task);
  if (subTasks.length > 0) {
    for (const sub of subTasks) add('implement', sub);
  } else {
    add('implement', 'Implement the requested change');
  }
  add('verify', 'Verify the change: run the project checks');
  add('finish', 'Summarize the result and finish');
  return { task, steps, createdAt: new Date().toISOString() };
}

/** First step that still needs work, or null when the plan is done. */
export function nextPendingStep(plan: CodingPlan): CodingPlanStep | null {
  return plan.steps.find((s) => s.status === 'pending' || s.status === 'in_progress') ?? null;
}

/** Mark a step with a new status (mutates the plan in place). */
export function markStep(plan: CodingPlan, stepId: string, status: CodingPlanStepStatus, note?: string): void {
  const step = plan.steps.find((s) => s.id === stepId);
  if (!step) return;
  step.status = status;
  if (note !== undefined) step.note = note;
}

/** True when every step is done or skipped. */
export function isPlanComplete(plan: CodingPlan): boolean {
  return plan.steps.every((s) => s.status === 'done' || s.status === 'skipped');
}

/** Fraction of steps finished (0..1), for progress reporting. */
export function codingPlanProgress(plan: CodingPlan): number {
  if (plan.steps.length === 0) return 1;
  const done = plan.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  return done / plan.steps.length;
}
