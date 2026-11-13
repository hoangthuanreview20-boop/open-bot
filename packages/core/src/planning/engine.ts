/**
 * Plan engine (v0.96, Team T6 — UI + planning).
 *
 * A plan is an ordered list of steps with a lifecycle, designed after
 * the multi-agent planning flow (one plan, many workers): each step
 * can be assigned to a different bot, steps run one at a time per
 * bot, and the engine — not the model — owns the state machine, so a
 * step can never be "running" in two places and a stuck run is
 * visible as data, not as a feeling.
 *
 *   pending → running → done
 *                  ↘ failed → pending (retry) | skipped
 *   pending → skipped
 *
 * The engine is in-memory and synchronous: persistence is the
 * caller's job (the desktop keeps plans in localStorage; the
 * coordinator keeps them in BotMemory via PlanService). `toJSON` /
 * `fromJSON` round-trip a plan so either store can save it verbatim.
 *
 * Multi-agent dispatch: `dispatch(botId)` claims the next step for a
 * bot — its own assigned pending step first, then the oldest
 * unassigned pending step — and marks it running. A bot that already
 * has a running step gets nothing back (one step at a time per bot);
 * a step assigned to another bot is never stolen. `release(botId)`
 * returns a bot's running step to pending (e.g. the bot went away).
 *
 * Stuck detection rides along: every tool call a step makes is
 * recorded (signature only — never raw arguments, which may hold
 * secrets), and `checkStuck` reports a repeated-call loop or a
 * no-progress streak. See `stuck.ts` for the rules.
 */

import {
  StuckDetector,
  checkNoProgress,
  checkRepeatedCalls,
  toolCallSignature,
  type StuckDetectorOptions,
  type StuckReport,
  type ToolCallRecord,
} from './stuck';

export type { StuckReason, StuckReport, ToolCallRecord } from './stuck';
export { toolCallSignature } from './stuck';

export type PlanStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface PlanStep {
  id: string;
  title: string;
  detail?: string;
  status: PlanStepStatus;
  /** Bot the step is assigned to (multi-agent dispatch). */
  assigneeBotId?: string | null;
  /** How many times the step has been started (retries included). */
  attempts: number;
  /** Last failure message, if any. */
  error?: string;
  startedAt?: number | null;
  finishedAt?: number | null;
}

export interface Plan {
  id: string;
  title: string;
  detail?: string;
  /** Bot that owns the plan (the planner); steps may go to others. */
  ownerBotId?: string | null;
  steps: PlanStep[];
  createdAt: number;
  updatedAt: number;
}

export interface PlanProgress {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  running: number;
  pending: number;
  /** Done / total, 0 when the plan has no steps. */
  percent: number;
  finished: boolean;
}

export interface PlanEngineOptions {
  stuck?: StuckDetectorOptions;
  /** id factory (tests inject a deterministic one). */
  idFactory?: () => string;
}

function defaultId(): string {
  return `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function now(): number {
  return Date.now();
}

function blankStep(title: string, idFactory: () => string): PlanStep {
  return { id: idFactory(), title: title.trim(), status: 'pending', attempts: 0 };
}

export function planProgress(plan: Plan): PlanProgress {
  const total = plan.steps.length;
  let done = 0;
  let failed = 0;
  let skipped = 0;
  let running = 0;
  for (const step of plan.steps) {
    if (step.status === 'done') done++;
    else if (step.status === 'failed') failed++;
    else if (step.status === 'skipped') skipped++;
    else if (step.status === 'running') running++;
  }
  const pending = total - done - failed - skipped - running;
  return {
    total,
    done,
    failed,
    skipped,
    running,
    pending,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    finished: total > 0 && done + skipped === total,
  };
}

/**
 * In-memory plan store + state machine. One engine per scope that
 * owns plans (one desktop window, one coordinator). Plans are
 * returned by reference — callers that render them should copy or
 * re-read after a mutation (the UI does this through `toJSON`).
 */
export class PlanEngine {
  private readonly plans = new Map<string, Plan>();
  /** Per-step tool-call history for the stuck detector. */
  private readonly detectors = new Map<string, StuckDetector>();
  private readonly stuckOptions: StuckDetectorOptions;
  private readonly idFactory: () => string;

  constructor(options: PlanEngineOptions = {}) {
    this.stuckOptions = options.stuck ?? {};
    this.idFactory = options.idFactory ?? defaultId;
  }

  // -- plans ---------------------------------------------------------------

  createPlan(
    title: string,
    opts: { detail?: string; ownerBotId?: string | null; steps?: string[] } = {},
  ): Plan {
    const cleanTitle = title.trim();
    if (!cleanTitle) throw new Error('Plan title must not be empty.');
    const plan: Plan = {
      id: this.idFactory(),
      title: cleanTitle,
      detail: opts.detail?.trim() ? opts.detail.trim() : undefined,
      ownerBotId: opts.ownerBotId ?? null,
      steps: (opts.steps ?? []).map((s) => blankStep(s, this.idFactory)).filter((s) => s.title),
      createdAt: now(),
      updatedAt: now(),
    };
    this.plans.set(plan.id, plan);
    return plan;
  }

  getPlan(planId: string): Plan | null {
    return this.plans.get(planId) ?? null;
  }

  listPlans(): Plan[] {
    return [...this.plans.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  deletePlan(planId: string): boolean {
    const plan = this.plans.get(planId);
    if (!plan) return false;
    for (const step of plan.steps) this.detectors.delete(step.id);
    return this.plans.delete(planId);
  }

  renamePlan(planId: string, title: string): Plan {
    const plan = this.requirePlan(planId);
    const clean = title.trim();
    if (!clean) throw new Error('Plan title must not be empty.');
    plan.title = clean;
    plan.updatedAt = now();
    return plan;
  }

  // -- steps ---------------------------------------------------------------

  addStep(planId: string, title: string, detail?: string): PlanStep {
    const plan = this.requirePlan(planId);
    const step = blankStep(title, this.idFactory);
    if (!step.title) throw new Error('Step title must not be empty.');
    if (detail?.trim()) step.detail = detail.trim();
    plan.steps.push(step);
    plan.updatedAt = now();
    return step;
  }

  removeStep(planId: string, stepId: string): boolean {
    const plan = this.requirePlan(planId);
    const i = plan.steps.findIndex((s) => s.id === stepId);
    if (i === -1) return false;
    if (plan.steps[i]?.status === 'running') {
      throw new Error('Cannot remove a running step — stop it first.');
    }
    plan.steps.splice(i, 1);
    this.detectors.delete(stepId);
    plan.updatedAt = now();
    return true;
  }

  moveStep(planId: string, stepId: string, toIndex: number): PlanStep {
    const plan = this.requirePlan(planId);
    const from = plan.steps.findIndex((s) => s.id === stepId);
    if (from === -1) throw new Error(`Unknown step: ${stepId}`);
    const [step] = plan.steps.splice(from, 1);
    if (!step) throw new Error(`Unknown step: ${stepId}`);
    const clamped = Math.max(0, Math.min(toIndex, plan.steps.length));
    plan.steps.splice(clamped, 0, step);
    plan.updatedAt = now();
    return step;
  }

  /** Assign a step to a bot (or unassign with null). Running steps keep their assignee. */
  assignStep(planId: string, stepId: string, botId: string | null): PlanStep {
    const step = this.requireStep(planId, stepId);
    if (step.status === 'running') {
      throw new Error('Cannot reassign a running step — stop it first.');
    }
    step.assigneeBotId = botId;
    this.requirePlan(planId).updatedAt = now();
    return step;
  }

  /** Start a step. A failed step may be retried (attempts increments). */
  startStep(planId: string, stepId: string): PlanStep {
    const plan = this.requirePlan(planId);
    const step = this.requireStep(planId, stepId);
    if (step.status === 'running') throw new Error(`Step is already running: ${step.title}`);
    if (step.status === 'done') throw new Error(`Step is already done: ${step.title}`);
    if (step.status === 'skipped') throw new Error(`Step was skipped: ${step.title}`);
    // One running step per assignee: a bot cannot run two steps at once.
    if (step.assigneeBotId) {
      const clash = plan.steps.find(
        (s) => s.id !== step.id && s.status === 'running' && s.assigneeBotId === step.assigneeBotId,
      );
      if (clash) {
        throw new Error(`Bot ${step.assigneeBotId} is already running step: ${clash.title}`);
      }
    }
    step.status = 'running';
    step.attempts++;
    step.error = undefined;
    step.startedAt = now();
    step.finishedAt = null;
    this.detectorFor(step.id).resetStep();
    plan.updatedAt = now();
    return step;
  }

  completeStep(planId: string, stepId: string): PlanStep {
    const step = this.requireStep(planId, stepId);
    if (step.status !== 'running') throw new Error(`Step is not running: ${step.title}`);
    step.status = 'done';
    step.finishedAt = now();
    this.detectorFor(step.id).recordStepOutcome('done');
    this.requirePlan(planId).updatedAt = now();
    return step;
  }

  failStep(planId: string, stepId: string, error?: string): PlanStep {
    const step = this.requireStep(planId, stepId);
    if (step.status !== 'running') throw new Error(`Step is not running: ${step.title}`);
    step.status = 'failed';
    step.finishedAt = now();
    if (error?.trim()) step.error = error.trim().slice(0, 500);
    this.detectorFor(step.id).recordStepOutcome('failed');
    this.requirePlan(planId).updatedAt = now();
    return step;
  }

  /** A failed step goes back to pending so it can be retried. */
  retryStep(planId: string, stepId: string): PlanStep {
    const step = this.requireStep(planId, stepId);
    if (step.status !== 'failed') throw new Error(`Only a failed step can be retried: ${step.title}`);
    step.status = 'pending';
    step.error = undefined;
    step.finishedAt = null;
    this.requirePlan(planId).updatedAt = now();
    return step;
  }

  skipStep(planId: string, stepId: string): PlanStep {
    const step = this.requireStep(planId, stepId);
    if (step.status === 'running') throw new Error(`Stop a running step before skipping it: ${step.title}`);
    if (step.status === 'done') throw new Error(`Step is already done: ${step.title}`);
    step.status = 'skipped';
    step.finishedAt = now();
    this.detectorFor(step.id).recordStepOutcome('skipped');
    this.requirePlan(planId).updatedAt = now();
    return step;
  }

  progress(planId: string): PlanProgress {
    return planProgress(this.requirePlan(planId));
  }

  // -- multi-agent dispatch -------------------------------------------------

  /**
   * Claim the next step for a bot. Own assigned pending step first
   * (oldest), then the oldest unassigned pending step. Returns null
   * when the bot already runs a step, or when no step is claimable.
   * The claimed step is marked running — the caller executes it and
   * reports back with complete/failStep.
   */
  dispatch(planId: string, botId: string): PlanStep | null {
    const plan = this.requirePlan(planId);
    if (!botId.trim()) throw new Error('dispatch needs a botId.');
    const alreadyRunning = plan.steps.some(
      (s) => s.status === 'running' && s.assigneeBotId === botId,
    );
    if (alreadyRunning) return null;
    const own = plan.steps.find((s) => s.status === 'pending' && s.assigneeBotId === botId);
    const next = own ?? plan.steps.find((s) => s.status === 'pending' && !s.assigneeBotId);
    if (!next) return null;
    // Claiming an unassigned step assigns it to this bot.
    if (!next.assigneeBotId) next.assigneeBotId = botId;
    return this.startStep(planId, next.id);
  }

  /**
   * A bot went away (or its run was aborted): its running step goes
   * back to pending, unassigned, so another bot can pick it up.
   * Returns the released step, or null when the bot ran nothing.
   */
  release(planId: string, botId: string): PlanStep | null {
    const plan = this.requirePlan(planId);
    const running = plan.steps.find((s) => s.status === 'running' && s.assigneeBotId === botId);
    if (!running) return null;
    running.status = 'pending';
    running.assigneeBotId = null;
    running.startedAt = null;
    running.finishedAt = null;
    plan.updatedAt = now();
    return running;
  }

  // -- stuck detection ------------------------------------------------------

  /**
   * Record a tool call made while executing a step. Only the
   * signature is kept (see `toolCallSignature`) — never raw
   * arguments. Returns a stuck report the moment the repeated-call
   * rule fires, else null.
   */
  recordStepToolCall(
    planId: string,
    stepId: string,
    tool: string,
    args: Record<string, unknown>,
  ): StuckReport | null {
    const step = this.requireStep(planId, stepId);
    if (step.status !== 'running') return null;
    const detector = this.detectorFor(step.id);
    detector.recordToolCall(tool, args);
    return detector.check();
  }

  /** Check both stuck rules for a step right now (no new record). */
  checkStuck(planId: string, stepId: string): StuckReport | null {
    this.requireStep(planId, stepId);
    return this.detectorFor(stepId).check();
  }

  /** Plan-level no-progress check: consecutive failed/skipped steps. */
  checkPlanStuck(planId: string): StuckReport | null {
    const plan = this.requirePlan(planId);
    let streak = 0;
    for (let i = plan.steps.length - 1; i >= 0; i--) {
      const status = plan.steps[i]?.status;
      if (status === 'failed' || status === 'skipped') streak++;
      else if (status === 'done') break;
      // pending / running steps do not break or extend the streak.
    }
    return checkNoProgress(streak, this.stuckOptions.noProgressThreshold ?? 3);
  }

  // -- serialisation ---------------------------------------------------------

  toJSON(planId: string): Plan {
    const plan = this.requirePlan(planId);
    return JSON.parse(JSON.stringify(plan)) as Plan;
  }

  /** Restore a plan saved with `toJSON` (step history is not kept). */
  fromJSON(data: Plan): Plan {
    if (!data || typeof data.id !== 'string' || !Array.isArray(data.steps)) {
      throw new Error('Invalid plan JSON.');
    }
    const plan: Plan = {
      id: data.id,
      title: data.title,
      detail: data.detail,
      ownerBotId: data.ownerBotId ?? null,
      steps: data.steps.map((s) => ({
        id: s.id,
        title: s.title,
        detail: s.detail,
        status: s.status,
        assigneeBotId: s.assigneeBotId ?? null,
        attempts: s.attempts ?? 0,
        error: s.error,
        startedAt: s.startedAt ?? null,
        finishedAt: s.finishedAt ?? null,
      })),
      createdAt: data.createdAt ?? now(),
      updatedAt: data.updatedAt ?? now(),
    };
    this.plans.set(plan.id, plan);
    return plan;
  }

  // -- internals -------------------------------------------------------------

  private requirePlan(planId: string): Plan {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`Unknown plan: ${planId}`);
    return plan;
  }

  private requireStep(planId: string, stepId: string): PlanStep {
    const plan = this.requirePlan(planId);
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`Unknown step: ${stepId}`);
    return step;
  }

  private detectorFor(stepId: string): StuckDetector {
    let detector = this.detectors.get(stepId);
    if (!detector) {
      detector = new StuckDetector(this.stuckOptions);
      this.detectors.set(stepId, detector);
    }
    return detector;
  }
}

/** Re-exported for callers that keep their own history (see stuck.ts). */
export { checkRepeatedCalls, checkNoProgress };
export type { ToolCallRecord as PlanToolCallRecord };
