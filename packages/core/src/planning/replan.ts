/**
 * Auto-replan (v0.98, Team T4 — planning v2).
 *
 * When a run gets stuck, the worst response is to keep pushing the
 * same plan harder. `proposeReplan()` builds a *proposal* — a small,
 * deterministic edit to the plan, chosen by the stuck reason — and
 * nothing is applied until the proposal is decided:
 *
 *   propose → pending → approved (applyReplan) | rejected (drop)
 *
 * This mirrors the approval flow the app already uses for plan
 * review and tool calls: the coordinator emits the proposal as a
 * `plan.event` (`replan-proposed`), the UI shows it with Approve /
 * Reject, and the decision comes back through the `plan.decideReplan`
 * RPC. A proposal never executes a tool, never edits a file, and
 * never restarts a run by itself — it only rewrites plan steps.
 *
 * Strategies (rule-based, no model call):
 * - repeated-tool-call / tool-cycle: the current step's approach is
 *   exhausted — skip the stuck step, insert an explicit
 *   "gather context another way" step, then a fresh retry step.
 * - error-repeat: the same error on every attempt — insert a
 *   "find why this error happens" step before retrying, and skip
 *   the stuck step if it already failed twice.
 * - stall: the run went silent — insert a "check the environment /
 *   state, then continue" step and keep the stuck step pending so
 *   the next run retries it from a known state.
 * - no-progress: the tail of the plan is not landing — drop the
 *   failed/skipped tail and insert one "re-scope the remaining
 *   work" step so the next run starts from a smaller plan.
 */

import type { Plan, PlanEngine } from './engine';
import type { StuckReport } from './stuck';

export type ReplanChangeType = 'insert' | 'replace' | 'skip' | 'remove';

export interface ReplanChange {
  type: ReplanChangeType;
  /** Step the change applies to (insert = after this step; null = at the start). */
  stepId: string | null;
  /** Title of the step to insert / replace with. */
  title?: string;
  /** Detail of the step to insert / replace with. */
  detail?: string;
  /** Human-readable reason for this single change. */
  reason: string;
}

export type ReplanDecision = 'pending' | 'approved' | 'rejected';

export interface ReplanProposal {
  id: string;
  planId: string;
  /** Step the run was stuck on (null when the stuck state is plan-level). */
  stuckStepId: string | null;
  reason: StuckReport['reason'];
  /** One-line summary shown in the UI. */
  summary: string;
  changes: ReplanChange[];
  decision: ReplanDecision;
  createdAt: number;
  decidedAt?: number | null;
}

export interface ReplanProposalOptions {
  idFactory?: () => string;
}

function defaultId(): string {
  return `replan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function now(): number {
  return Date.now();
}

/** The step the run is stuck on: the running step, else the last failed one. */
export function stuckStepOf(plan: Plan): string | null {
  const running = plan.steps.find((s) => s.status === 'running');
  if (running) return running.id;
  for (let i = plan.steps.length - 1; i >= 0; i--) {
    if (plan.steps[i]?.status === 'failed') return plan.steps[i]?.id ?? null;
  }
  return null;
}

/**
 * Build a replan proposal for a stuck plan. Pure except for the id:
 * the same plan + report always yields the same changes. Returns
 * null when there is nothing sensible to change (e.g. a plan whose
 * steps are all done already).
 */
export function proposeReplan(
  plan: Plan,
  report: StuckReport,
  options: ReplanProposalOptions = {},
): ReplanProposal | null {
  const idFactory = options.idFactory ?? defaultId;
  const stuckStepId = stuckStepOf(plan);
  const stuckStep = plan.steps.find((s) => s.id === stuckStepId) ?? null;
  const changes: ReplanChange[] = [];
  let summary = '';

  switch (report.reason) {
    case 'repeated-tool-call':
    case 'tool-cycle': {
      if (!stuckStep) return null;
      summary =
        report.reason === 'repeated-tool-call'
          ? `The step "${stuckStep.title}" keeps repeating the same tool call — skip it, gather context another way, then retry.`
          : `The step "${stuckStep.title}" cycles between the same tools — skip it, gather context another way, then retry.`;
      changes.push({
        type: 'skip',
        stepId: stuckStep.id,
        reason: 'The current approach is exhausted; retrying it as-is will loop again.',
      });
      changes.push({
        type: 'insert',
        stepId: stuckStep.id,
        title: `Gather context for "${stuckStep.title}" a different way`,
        detail: 'Use another tool or source than the one that kept repeating.',
        reason: 'A fresh angle breaks the loop before retrying.',
      });
      changes.push({
        type: 'insert',
        stepId: stuckStep.id,
        title: `Retry "${stuckStep.title}" with the new context`,
        detail: 'One attempt with the different approach; if it fails, ask the user.',
        reason: 'Retry only after the approach changed.',
      });
      break;
    }
    case 'error-repeat': {
      if (!stuckStep) return null;
      summary = `The step "${stuckStep.title}" fails with the same error every time — find out why before retrying.`;
      changes.push({
        type: 'insert',
        stepId: stuckStep.id,
        title: `Find why "${stuckStep.title}" fails: ${report.error ?? 'same error'}`,
        detail: 'Check the exact error, the inputs and the environment; do not retry blind.',
        reason: 'The error is the same on every attempt, so the cause is systematic.',
      });
      if (stuckStep.attempts >= 2) {
        changes.push({
          type: 'skip',
          stepId: stuckStep.id,
          reason: 'Already attempted twice with the same error — move on instead of looping.',
        });
      }
      break;
    }
    case 'stall': {
      if (!stuckStep) return null;
      summary = `The step "${stuckStep.title}" went silent — check the state, then continue from a known point.`;
      changes.push({
        type: 'insert',
        stepId: stuckStep.id,
        title: `Check the current state before continuing "${stuckStep.title}"`,
        detail: 'Verify the environment, files and partial results, then continue.',
        reason: 'A silent run may have partial progress worth keeping.',
      });
      break;
    }
    case 'no-progress': {
      const tail = [...plan.steps].reverse().filter((s) => s.status === 'failed' || s.status === 'skipped');
      if (tail.length === 0) return null;
      summary = `${tail.length} steps in a row finished without progress — drop the failing tail and re-scope what is left.`;
      for (const step of tail) {
        changes.push({
          type: 'remove',
          stepId: step.id,
          reason: 'Part of the failing tail; re-scope instead of retrying it as-is.',
        });
      }
      const anchor = plan.steps.find((s) => s.status === 'done') ?? null;
      changes.push({
        type: 'insert',
        stepId: anchor?.id ?? null,
        title: 'Re-scope the remaining work into smaller steps',
        detail: 'Split what is left so each step has one clear, verifiable outcome.',
        reason: 'Smaller steps make the next run land instead of failing as a block.',
      });
      break;
    }
  }

  if (changes.length === 0) return null;
  return {
    id: idFactory(),
    planId: plan.id,
    stuckStepId,
    reason: report.reason,
    summary,
    changes,
    decision: 'pending',
    createdAt: now(),
    decidedAt: null,
  };
}

/**
 * Apply an approved proposal to the engine's plan. Applies changes
 * in order: skips and removes first (they target existing steps),
 * then inserts (in proposal order, after the anchor step). The
 * proposal is marked approved; applying a non-pending proposal or
 * a proposal for another plan throws. Returns the updated plan.
 */
export function applyReplan(engine: PlanEngine, proposal: ReplanProposal): Plan {
  if (proposal.decision !== 'pending') {
    throw new Error(`Replan proposal ${proposal.id} was already decided.`);
  }
  const plan = engine.getPlan(proposal.planId);
  if (!plan) throw new Error(`Unknown plan: ${proposal.planId}`);

  // Skips / removes first: they address steps by id, and inserts
  // anchor after a step that a remove might delete.
  for (const change of proposal.changes) {
    if (change.type === 'skip' && change.stepId) {
      const step = plan.steps.find((s) => s.id === change.stepId);
      if (!step) continue;
      if (step.status === 'running') {
        // A running step cannot be skipped directly — mark it failed
        // first so the engine's state machine stays valid.
        engine.failStep(plan.id, step.id, 'Skipped by approved replan.');
      }
      if (step.status === 'pending' || step.status === 'failed') {
        engine.skipStep(plan.id, step.id);
      }
    } else if (change.type === 'remove' && change.stepId) {
      const step = plan.steps.find((s) => s.id === change.stepId);
      if (!step) continue;
      if (step.status === 'running') {
        engine.failStep(plan.id, step.id, 'Removed by approved replan.');
      }
      engine.removeStep(plan.id, step.id);
    }
  }
  // Inserts in proposal order, each after its anchor (or at the
  // start when there is no anchor). Later inserts anchor after the
  // previously inserted step so the order in the proposal is kept.
  let lastInsertedId: string | null = null;
  for (const change of proposal.changes) {
    if (change.type !== 'insert' && change.type !== 'replace') continue;
    if (!change.title?.trim()) continue;
    const anchorId = lastInsertedId ?? change.stepId;
    const current = engine.getPlan(proposal.planId);
    if (!current) throw new Error(`Unknown plan: ${proposal.planId}`);
    const anchorIndex =
      anchorId === null
        ? -1
        : current.steps.findIndex((s) => s.id === anchorId);
    const inserted = engine.insertStepAt(
      proposal.planId,
      anchorIndex + 1,
      change.title,
      change.detail,
    );
    lastInsertedId = inserted.id;
    if (change.type === 'replace' && change.stepId) {
      const step = engine.getPlan(proposal.planId)?.steps.find((s) => s.id === change.stepId);
      if (step && step.status !== 'running' && step.status !== 'done') {
        try {
          engine.removeStep(proposal.planId, step.id);
        } catch {
          // Already gone (e.g. removed above) — the replacement stands.
        }
      }
    }
  }
  proposal.decision = 'approved';
  proposal.decidedAt = now();
  const updated = engine.getPlan(proposal.planId);
  if (!updated) throw new Error(`Unknown plan: ${proposal.planId}`);
  return updated;
}

/** Mark a proposal rejected (no plan change). Throws when already decided. */
export function rejectReplan(proposal: ReplanProposal): ReplanProposal {
  if (proposal.decision !== 'pending') {
    throw new Error(`Replan proposal ${proposal.id} was already decided.`);
  }
  proposal.decision = 'rejected';
  proposal.decidedAt = now();
  return proposal;
}
