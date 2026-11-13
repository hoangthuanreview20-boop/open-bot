/**
 * Run ↔ plan binding (v0.98, Team T4 — planning v2).
 *
 * This is the piece v0.96 was missing: PlanView and PlanEngine
 * existed, but no code ever connected a plan to a live coordinator
 * run. `RunPlanBinding` owns that connection:
 *
 * - `bindRun(runId, botId, planId)` dispatches the plan's next step
 *   to the bot when the run starts — the same dispatch the UI used
 *   by hand in v0.96, now driven by the run itself.
 * - `onToolCall` / `onToolResult` feed every tool call of the run
 *   into the plan's stuck detector (signatures only, never raw
 *   arguments) and emit a `stuck` event the moment a rule fires.
 * - `endRun` settles the running step from the run's outcome:
 *   success → done, error → failed, stopped → released back to
 *   pending so another run can pick it up.
 * - When a stuck report fires and `autoReplan` is `'suggest'`
 *   (the default), a replan proposal is built and emitted as
 *   `replan-proposed` — nothing is applied until `decideReplan`
 *   approves it, following the app's existing approval flow.
 * - Every mutation emits a `PlanRunEvent` carrying a full plan
 *   snapshot, and persists the plan (when a store is configured),
 *   so the UI can render live state from events alone — no polling.
 *
 * The coordinator wires this into `executeRun` (see
 * `coordinator.ts`): `bindRun` at run start, the two `on*` hooks
 * inside the run's `AgentEvents`, `endRun` in the `finally` block
 * (which runs on every exit path — success, error, stop).
 */

import { PlanEngine, planProgress, type Plan, type PlanProgress } from './engine';
import { applyReplan, proposeReplan, rejectReplan, type ReplanProposal } from './replan';
import type { PlanFileStore, StoredRunPlan } from './persistence';
import type { StuckDetectorOptions, StuckReport } from './stuck';

export type PlanRunEventType =
  | 'run-started'
  | 'step-started'
  | 'step-done'
  | 'step-failed'
  | 'run-finished'
  | 'run-stopped'
  | 'stuck'
  | 'replan-proposed'
  | 'replan-applied'
  | 'replan-rejected'
  | 'plan-finished';

export interface PlanRunEvent {
  type: PlanRunEventType;
  runId: string;
  botId: string;
  planId: string;
  /** Full plan snapshot at emit time (deep copy — safe to keep). */
  plan: Plan;
  progress: PlanProgress;
  /** Step this event is about (when there is one). */
  stepId?: string;
  /** Stuck report (stuck / replan-proposed only). */
  stuck?: StuckReport;
  /** Replan proposal (replan-* only). */
  proposal?: ReplanProposal;
}

export interface RunPlanBindingOptions {
  /** Engine to use (tests inject one; default is a fresh engine). */
  engine?: PlanEngine;
  /** Persistence (null = in-memory only, e.g. tests without a dataDir). */
  store?: PlanFileStore | null;
  /** 'suggest' (default): propose a replan when stuck. 'off': only report stuck. */
  autoReplan?: 'suggest' | 'off';
  /** Stuck-detector options forwarded to the engine. */
  stuck?: StuckDetectorOptions;
  /** Called for every plan event (the coordinator forwards these as `plan.event`). */
  onEvent?: (event: PlanRunEvent) => void;
}

export interface EndRunOutcome {
  stopped?: boolean;
  error?: string;
}

interface Binding {
  planId: string;
  botId: string;
  stepId: string | null;
}

function snapshot(plan: Plan): Plan {
  return JSON.parse(JSON.stringify(plan)) as Plan;
}

export class RunPlanBinding {
  private readonly engine: PlanEngine;
  private readonly store: PlanFileStore | null;
  private readonly autoReplan: 'suggest' | 'off';
  private readonly onEvent?: (event: PlanRunEvent) => void;
  private readonly bindings = new Map<string, Binding>();
  private readonly proposals = new Map<string, ReplanProposal>();
  /** Tool name of each run's most recent tool call (ToolResult has no name). */
  private readonly lastToolByRun = new Map<string, string>();
  /** `${stepId}:${reason}` already reported — a stuck step reports once per reason. */
  private readonly reportedStuck = new Set<string>();

  constructor(options: RunPlanBindingOptions = {}) {
    this.engine = options.engine ?? new PlanEngine({ stuck: options.stuck });
    this.store = options.store ?? null;
    this.autoReplan = options.autoReplan ?? 'suggest';
    this.onEvent = options.onEvent;
  }

  /** The engine behind this binding (tests / coordinator read plans through it). */
  get planEngine(): PlanEngine {
    return this.engine;
  }

  // -- plans ---------------------------------------------------------------

  createPlan(
    botId: string,
    title: string,
    opts: { detail?: string; steps?: string[]; templateId?: string | null } = {},
  ): Plan {
    const plan = this.engine.createPlan(title, {
      detail: opts.detail,
      ownerBotId: botId,
      steps: opts.steps ?? [],
    });
    this.persist(plan, null, botId, opts.templateId ?? null);
    return snapshot(plan);
  }

  getPlan(planId: string): Plan | null {
    const plan = this.engine.getPlan(planId);
    return plan ? snapshot(plan) : null;
  }

  listPlans(): Plan[] {
    return this.engine.listPlans().map((p) => snapshot(p));
  }

  deletePlan(planId: string): boolean {
    for (const [runId, binding] of this.bindings) {
      if (binding.planId === planId) this.bindings.delete(runId);
    }
    for (const [id, proposal] of this.proposals) {
      if (proposal.planId === planId) this.proposals.delete(id);
    }
    const deleted = this.engine.deletePlan(planId);
    if (deleted) this.store?.delete(planId);
    return deleted;
  }

  /** Load persisted plans into the engine (restart resume). */
  resumeStoredPlans(): { resumed: StoredRunPlan[]; untouched: StoredRunPlan[]; skipped: string[] } {
    if (!this.store) return { resumed: [], untouched: [], skipped: [] };
    // A plan with a run still alive keeps its running step — resetting
    // it here would corrupt the live run (the step would flip to
    // pending on disk and in the engine under the running turn).
    const livePlanIds = new Set([...this.bindings.values()].map((b) => b.planId));
    const result = this.store.resumePlans(livePlanIds);
    for (const stored of [...result.resumed, ...result.untouched]) {
      try {
        this.engine.fromJSON(stored.plan);
      } catch {
        // A stored plan the engine cannot read stays on disk only.
      }
    }
    return result;
  }

  // -- run lifecycle ---------------------------------------------------------

  /**
   * Attach a plan to a run that just started. Dispatches the next
   * step to the bot (or none when the plan is finished / empty) and
   * emits `run-started` (+ `step-started` when a step was claimed).
   * Returns false when the plan does not exist.
   */
  bindRun(runId: string, botId: string, planId: string): boolean {
    const plan = this.engine.getPlan(planId);
    if (!plan) return false;
    let stepId: string | null = null;
    try {
      const step = this.engine.dispatch(planId, botId);
      stepId = step?.id ?? null;
    } catch {
      stepId = null;
    }
    this.bindings.set(runId, { planId, botId, stepId });
    this.emit('run-started', runId, botId, planId);
    if (stepId) this.emit('step-started', runId, botId, planId, stepId);
    this.persist(plan, runId, botId);
    return true;
  }

  /**
   * Feed one tool call of a bound run into the stuck detector.
   * Emits `stuck` (once per step+reason) and, when auto-replan is
   * on, `replan-proposed` with the proposal built from the report.
   */
  onToolCall(runId: string, tool: string, args: Record<string, unknown>): StuckReport | null {
    const binding = this.bindings.get(runId);
    if (!binding || !binding.stepId) return null;
    this.lastToolByRun.set(runId, tool);
    let report: StuckReport | null = null;
    try {
      report = this.engine.recordStepToolCall(binding.planId, binding.stepId, tool, args);
    } catch {
      return null;
    }
    if (report) this.handleStuck(runId, binding, report);
    return report;
  }

  /**
   * Feed one tool result of a bound run into the detector (v2
   * error-repeat rule) and re-check the stall rule. The tool name
   * comes from the run's most recent tool call (`ToolResult` carries
   * no tool name — only a call id). `error` is the tool's error text
   * when `ok` is false.
   */
  onToolResult(runId: string, ok: boolean, error = ''): StuckReport | null {
    const binding = this.bindings.get(runId);
    if (!binding || !binding.stepId) return null;
    const tool = this.lastToolByRun.get(runId) ?? 'unknown';
    let report: StuckReport | null = null;
    try {
      report = this.engine.recordStepToolResult(binding.planId, binding.stepId, tool, ok, error);
    } catch {
      return null;
    }
    if (!report) {
      // A successful result may still leave a stall pending from
      // before — checkStuck re-evaluates every rule.
      try {
        report = this.engine.checkStuck(binding.planId, binding.stepId);
      } catch {
        report = null;
      }
    }
    if (report) this.handleStuck(runId, binding, report);
    return report;
  }

  /** Refresh the stall clock for a bound run (progress, not a tool call). */
  noteActivity(runId: string): void {
    const binding = this.bindings.get(runId);
    if (!binding || !binding.stepId) return;
    try {
      this.engine.recordStepActivity(binding.planId, binding.stepId);
    } catch {
      // Observer-only: never break the run.
    }
  }

  /** Evaluate the stall rule for a bound run right now (any event may trigger it). */
  checkStall(runId: string, at?: number): StuckReport | null {
    const binding = this.bindings.get(runId);
    if (!binding || !binding.stepId) return null;
    let report: StuckReport | null = null;
    try {
      report = this.engine.checkStuck(binding.planId, binding.stepId, at);
    } catch {
      return null;
    }
    if (report) this.handleStuck(runId, binding, report);
    return report;
  }

  /**
   * Settle the running step from the run's outcome. Always safe to
   * call — an unknown runId is a no-op. Emits `step-done` /
   * `step-failed` / `run-finished` / `run-stopped`, plus
   * `plan-finished` when the last step landed.
   */
  endRun(runId: string, outcome: EndRunOutcome = {}): Plan | null {
    const binding = this.bindings.get(runId);
    if (!binding) return null;
    this.bindings.delete(runId);
    this.lastToolByRun.delete(runId);
    const updated0 = this.engine.getPlan(binding.planId);
    if (!updated0) return null;
    let emittedStopped = false;
    if (binding.stepId) {
      const step = updated0.steps.find((s) => s.id === binding.stepId);
      if (step?.status === 'running') {
        if (outcome.stopped) {
          this.engine.release(binding.planId, binding.botId);
          this.emit('run-stopped', runId, binding.botId, binding.planId, binding.stepId);
          emittedStopped = true;
        } else if (outcome.error) {
          this.engine.failStep(binding.planId, binding.stepId, outcome.error);
          this.emit('step-failed', runId, binding.botId, binding.planId, binding.stepId);
        } else {
          this.engine.completeStep(binding.planId, binding.stepId);
          this.emit('step-done', runId, binding.botId, binding.planId, binding.stepId);
        }
        this.clearStuckMarks(binding.stepId);
      }
    }
    const updated = this.engine.getPlan(binding.planId);
    if (!updated) return null;
    this.persist(updated, null, binding.botId);
    if (outcome.stopped) {
      // A stop with no running step still needs the event.
      if (!emittedStopped) this.emit('run-stopped', runId, binding.botId, binding.planId);
    } else {
      this.emit('run-finished', runId, binding.botId, binding.planId);
    }
    if (planProgress(updated).finished) {
      this.emit('plan-finished', runId, binding.botId, binding.planId);
    }
    return snapshot(updated);
  }

  // -- replan decisions ------------------------------------------------------

  /** Pending proposals for a plan (newest first). */
  listProposals(planId: string): ReplanProposal[] {
    return [...this.proposals.values()]
      .filter((p) => p.planId === planId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((p) => JSON.parse(JSON.stringify(p)) as ReplanProposal);
  }

  getProposal(proposalId: string): ReplanProposal | null {
    const proposal = this.proposals.get(proposalId);
    return proposal ? (JSON.parse(JSON.stringify(proposal)) as ReplanProposal) : null;
  }

  /**
   * Decide a pending proposal. Approve applies it to the plan and
   * emits `replan-applied`; reject drops it and emits
   * `replan-rejected`. Throws when the proposal is unknown or
   * already decided.
   */
  decideReplan(
    proposalId: string,
    decision: 'approve' | 'reject',
    runId?: string,
  ): { proposal: ReplanProposal; plan: Plan | null } {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error(`Unknown replan proposal: ${proposalId}`);
    if (proposal.decision !== 'pending') {
      throw new Error(`Replan proposal ${proposalId} was already decided.`);
    }
    const binding = runId !== undefined ? this.bindings.get(runId) : undefined;
    const emitRunId = runId ?? '';
    const emitBotId = binding?.botId ?? '';
    if (decision === 'reject') {
      rejectReplan(proposal);
      this.emit('replan-rejected', emitRunId, emitBotId, proposal.planId, undefined, undefined, proposal);
      return { proposal: this.getProposal(proposalId) as ReplanProposal, plan: this.getPlan(proposal.planId) };
    }
    const updated = applyReplan(this.engine, proposal);
    this.persist(updated, runId ?? null, updated.ownerBotId ?? null);
    this.emit('replan-applied', emitRunId, emitBotId, proposal.planId, undefined, undefined, proposal);
    return { proposal: this.getProposal(proposalId) as ReplanProposal, plan: snapshot(updated) };
  }

  // -- internals -------------------------------------------------------------

  private handleStuck(runId: string, binding: Binding, report: StuckReport): void {
    const key = `${binding.stepId ?? ''}:${report.reason}`;
    const alreadyReported = this.reportedStuck.has(key);
    if (!alreadyReported) {
      this.reportedStuck.add(key);
      this.emit('stuck', runId, binding.botId, binding.planId, binding.stepId ?? undefined, report);
    }
    if (this.autoReplan === 'suggest' && !alreadyReported) {
      const plan = this.engine.getPlan(binding.planId);
      if (!plan) return;
      const hasPending = [...this.proposals.values()].some(
        (p) => p.planId === binding.planId && p.decision === 'pending',
      );
      if (hasPending) return;
      const proposal = proposeReplan(plan, report);
      if (!proposal) return;
      this.proposals.set(proposal.id, proposal);
      this.emit('replan-proposed', runId, binding.botId, binding.planId, binding.stepId ?? undefined, report, proposal);
    }
  }

  private clearStuckMarks(stepId: string): void {
    for (const key of [...this.reportedStuck]) {
      if (key.startsWith(`${stepId}:`)) this.reportedStuck.delete(key);
    }
  }

  private emit(
    type: PlanRunEventType,
    runId: string,
    botId: string,
    planId: string,
    stepId?: string,
    stuck?: StuckReport,
    proposal?: ReplanProposal,
  ): void {
    if (!this.onEvent) return;
    const plan = this.engine.getPlan(planId);
    if (!plan) return;
    const event: PlanRunEvent = {
      type,
      runId,
      botId,
      planId,
      plan: snapshot(plan),
      progress: planProgress(plan),
      ...(stepId !== undefined ? { stepId } : {}),
      ...(stuck !== undefined ? { stuck } : {}),
      ...(proposal !== undefined
        ? { proposal: JSON.parse(JSON.stringify(proposal)) as ReplanProposal }
        : {}),
    };
    try {
      this.onEvent(event);
    } catch {
      // A listener must never break the run it observes.
    }
  }

  private persist(plan: Plan, runId: string | null, botId: string | null, templateId?: string | null): void {
    if (!this.store) return;
    try {
      this.store.save({ plan: snapshot(plan), runId, botId, templateId: templateId ?? null, savedAt: Date.now() });
    } catch {
      // Persistence is best-effort: a failed write must not break the run.
    }
  }
}
