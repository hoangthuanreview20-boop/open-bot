/**
 * Coding agent loop (v1.02, Team T4).
 *
 * OpenHands-style event-stream loop:
 *
 *   plan -> reason -> action -> environment executes -> observe -> repeat
 *
 * Every step is written to the event store (see `store.ts`) as it
 * happens, so a run is inspectable live and replayable afterwards.
 * The loop stops when the agent finishes, when a configured check
 * fails one too many times, or when any budget runs out.
 *
 * The loop never invents file contents and never runs a shell: file
 * edits go through the confined `Workspace`, commands go through the
 * sandboxed executor as argv arrays.
 */

import { randomUUID } from 'node:crypto';
import type { CodingAction, ActionObservation } from './actions';
import { ActionExecutor, describeAction } from './actions';
import { BudgetTracker, type BudgetUsage, type CodingBudget } from './budget';
import { capText, EVENT_OUTPUT_CAP, EVENT_TEXT_CAP } from './events';
import type { CodingEvent, CodingRunStatus } from './events';
import type { CodingPlan } from './planner';
import { createPlan, markStep, nextPendingStep } from './planner';
import type { ReasonInput, ReasonOutput, Reasoner } from './reasoner';
import { CodingEventStore } from './store';
import type { RunSummary, RunTrace, TraceStep } from './trace';
import { buildTrace } from './trace';
import { Workspace } from './workspace';
import { estimateCost } from '../usage/pricing';

/** A check the loop runs to verify the agent's work. */
export interface CodingCheck {
  name: string;
  argv: string[];
}

export interface CodingAgentOptions {
  /** Workspace root the run is confined to (created when missing). */
  workspaceRoot: string;
  reasoner: Reasoner;
  budget?: CodingBudget;
  /** Checks to verify against (matched by exact argv). */
  checks?: CodingCheck[];
  /** Directory to persist the JSONL event log in. */
  persistDir?: string;
  /** Extra env vars visible to sandboxed commands. */
  env?: Record<string, string>;
  /** Called for every event as it is recorded (live inspection). */
  onEvent?: (event: CodingEvent) => void;
  /** How many recent observations the reasoner sees (default 8). */
  historyLimit?: number;
}

/** The result of one coding run. */
export interface CodingRunResult {
  runId: string;
  status: CodingRunStatus;
  summary: string;
  stepsUsed: number;
  /** Files changed during the run (final state per path). */
  filesChanged: Array<{ path: string; kind: string }>;
  plan: CodingPlan;
  events: CodingEvent[];
  trace: RunTrace;
  usage: BudgetUsage;
  durationMs: number;
  /** The event store, for replay / export after the run. */
  store: CodingEventStore;
}

function argvKey(argv: string[]): string {
  return argv.join('\u0000');
}

/**
 * The coding agent: plans a task, then loops reason -> act ->
 * observe until done or out of budget. One instance per run.
 */
export class CodingAgent {
  private readonly options: CodingAgentOptions;

  constructor(options: CodingAgentOptions) {
    this.options = options;
  }

  async run(task: string): Promise<CodingRunResult> {
    const startedAt = Date.now();
    const runId = randomUUID();
    const { reasoner } = this.options;
    const workspace = new Workspace(this.options.workspaceRoot);
    const executor = new ActionExecutor(workspace, { env: this.options.env });
    const store = new CodingEventStore(runId, { persistDir: this.options.persistDir });
    const tracker = new BudgetTracker(reasoner.model, this.options.budget);
    const checks = this.options.checks ?? [];
    const checksByArgv = new Map(checks.map((c) => [argvKey(c.argv), c]));
    const historyLimit = this.options.historyLimit ?? 8;

    const emit = (event: CodingEvent): void => {
      this.options.onEvent?.(event);
    };
    const append = (
      type: Parameters<CodingEventStore['append']>[0],
      payload: Parameters<CodingEventStore['append']>[1],
      step = 0,
    ): CodingEvent => {
      const event = store.append(type, payload, step);
      emit(event);
      return event;
    };

    const plan = createPlan(task);
    append('run.started', {
      task,
      workspaceRoot: workspace.root,
      model: reasoner.model,
      maxSteps: tracker.budget.maxSteps,
    });
    append('plan.created', {
      stepIds: plan.steps.map((s) => s.id),
      steps: plan.steps.map((s) => s.description),
    });

    const history: ActionObservation[] = [];
    const traceSteps: TraceStep[] = [];
    const filesChanged = new Map<string, string>();
    let lastCheckFailure: { name: string; detail: string } | undefined;
    let consecutiveReasonErrors = 0;
    let status: CodingRunStatus = 'running';
    let summary = '';

    const finish = (finalStatus: CodingRunStatus, finalSummary: string): CodingRunResult => {
      status = finalStatus;
      summary = finalSummary;
      const usage = tracker.usage();
      const durationMs = Date.now() - startedAt;
      append('run.finished', {
        status,
        summary,
        stepsUsed: usage.stepsUsed,
        filesChanged: filesChanged.size,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: usage.costUsd,
        durationMs,
      }, usage.stepsUsed);
      const trace = buildTrace(runId, task, reasoner.model, status, summary, traceSteps, usage, durationMs);
      return {
        runId,
        status,
        summary,
        stepsUsed: usage.stepsUsed,
        filesChanged: [...filesChanged.entries()].map(([path, kind]) => ({ path, kind })),
        plan,
        events: store.all(),
        trace,
        usage,
        durationMs,
        store,
      };
    };

    for (let step = 1; step <= tracker.budget.maxSteps; step += 1) {
      // Budget check at the top of every step.
      const exceeded = tracker.checkExceeded();
      if (exceeded) {
        append('budget.exceeded', exceeded, step);
        return finish('budget-exceeded', `Budget exceeded: ${exceeded.budget} (${exceeded.used}/${exceeded.limit}).`);
      }
      tracker.recordStep();
      const stepStartedAt = Date.now();

      // --- Reason ---
      const input: ReasonInput = {
        task,
        plan,
        step,
        files: workspace.listFiles(),
        history: history.slice(-historyLimit),
        lastCheckFailure,
        fixAttempts: tracker.usage().fixAttempts,
        canFix: tracker.canFix,
      };
      let output: ReasonOutput;
      try {
        output = await reasoner.reason(input);
        consecutiveReasonErrors = 0;
      } catch (e) {
        consecutiveReasonErrors += 1;
        const message = e instanceof Error ? e.message : String(e);
        const observation: ActionObservation = {
          ok: false,
          summary: `reasoning failed: ${message}`,
          detail: message,
        };
        history.push(observation);
        append('observation', { ok: false, summary: observation.summary, detail: capText(message) }, step);
        traceSteps.push({
          step,
          thought: '(reasoning error)',
          action: '(none)',
          actionKind: 'finish',
          observationOk: false,
          observation: observation.summary,
          durationMs: Date.now() - stepStartedAt,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: null,
        });
        if (consecutiveReasonErrors >= 3) {
          return finish('failed', `Reasoning failed ${consecutiveReasonErrors} times in a row: ${message}`);
        }
        continue;
      }
      tracker.recordTokens(output.inputTokens, output.outputTokens);
      append('reasoning', { thought: capText(output.thought, EVENT_TEXT_CAP) }, step);
      append('action.proposed', {
        kind: output.action.kind,
        summary: describeAction(output.action),
        args: sanitizeActionArgs(output.action),
      }, step);

      // Mark the current plan step in progress.
      const pending = nextPendingStep(plan);
      if (pending && pending.status === 'pending') {
        markStep(plan, pending.id, 'in_progress');
        append('plan.step.updated', { stepId: pending.id, status: 'in_progress' }, step);
      }

      // --- Act + observe ---
      const action: CodingAction = output.action;
      const observation = await executor.execute(action);
      history.push(observation);
      append('action.executed', {
        kind: action.kind,
        summary: describeAction(action),
        args: sanitizeActionArgs(action),
        ok: observation.ok,
        error: observation.ok ? undefined : observation.summary,
      }, step);
      append('observation', {
        ok: observation.ok,
        summary: observation.summary,
        detail: capText(observation.detail, EVENT_OUTPUT_CAP),
      }, step);

      const stepUsage = tracker.usage();
      const stepCost = costOfStep(output, reasoner.model);
      traceSteps.push({
        step,
        thought: output.thought,
        action: describeAction(action),
        actionKind: action.kind,
        observationOk: observation.ok,
        observation: observation.summary,
        durationMs: Date.now() - stepStartedAt,
        inputTokens: output.inputTokens,
        outputTokens: output.outputTokens,
        costUsd: stepCost,
      });

      if (observation.fileChange) {
        filesChanged.set(observation.fileChange.path, observation.fileChange.kind);
        append('file.changed', {
          path: observation.fileChange.path,
          kind: observation.fileChange.kind,
          linesAdded: observation.fileChange.linesAdded,
          linesRemoved: observation.fileChange.linesRemoved,
        }, step);
      }
      if (observation.commandResult) {
        const result = observation.commandResult;
        append('command.result', {
          argv: result.argv,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          stdout: capText(result.stdout, EVENT_OUTPUT_CAP),
          stderr: capText(result.stderr, EVENT_OUTPUT_CAP),
        }, step);
        const check = checksByArgv.get(argvKey(result.argv));
        if (check) {
          const passed = result.exitCode === 0 && !result.timedOut;
          append('check.result', {
            name: check.name,
            passed,
            argv: result.argv,
            durationMs: result.durationMs,
          }, step);
          if (!passed) {
            if (tracker.canFix) {
              tracker.recordFixAttempt();
              lastCheckFailure = { name: check.name, detail: observation.detail };
              append('fix.attempted', {
                attempt: stepUsage.fixAttempts + 1,
                maxAttempts: tracker.budget.maxFixAttempts,
                reason: `check "${check.name}" failed`,
              }, step);
            } else {
              return finish('failed', `Check "${check.name}" failed and no fix attempts remain.`);
            }
          } else {
            lastCheckFailure = undefined;
            const verifyStep = plan.steps.find((s) => s.kind === 'verify');
            if (verifyStep) {
              markStep(plan, verifyStep.id, 'done');
              append('plan.step.updated', { stepId: verifyStep.id, status: 'done' }, step);
            }
          }
        }
      }

      // Advance the plan for successful file actions.
      if (observation.ok && (action.kind === 'create_file' || action.kind === 'write_file' || action.kind === 'edit_file' || action.kind === 'delete_file')) {
        const implementStep = plan.steps.find((s) => s.kind === 'implement' && s.status !== 'done');
        if (implementStep) {
          markStep(plan, implementStep.id, 'done');
          append('plan.step.updated', { stepId: implementStep.id, status: 'done' }, step);
        }
      }
      if (observation.ok && pending?.kind === 'explore' && step === 1) {
        markStep(plan, pending.id, 'done');
        append('plan.step.updated', { stepId: pending.id, status: 'done' }, step);
      }

      // --- Stop conditions ---
      if (action.kind === 'finish') {
        for (const s of plan.steps) {
          if (s.status === 'pending' || s.status === 'in_progress') {
            markStep(plan, s.id, action.success ? 'done' : 'failed');
          }
        }
        return finish(
          action.success ? 'succeeded' : 'failed',
          action.summary,
        );
      }
    }

    // Ran out of steps without finishing.
    append('budget.exceeded', { budget: 'steps', used: tracker.budget.maxSteps, limit: tracker.budget.maxSteps }, tracker.budget.maxSteps);
    return finish('budget-exceeded', `Step budget exhausted (${tracker.budget.maxSteps} steps) without finishing.`);
  }
}

/** Estimated cost of one reasoning step, null when the model has no known price. */
function costOfStep(output: ReasonOutput, model: string): number | null {
  if (output.inputTokens === 0 && output.outputTokens === 0) return 0;
  return estimateCost(model, output.inputTokens, output.outputTokens);
}

/**
 * Action args as stored in events: file contents are capped so the
 * log stays small and never becomes a copy of the workspace.
 */
function sanitizeActionArgs(action: CodingAction): Record<string, unknown> {
  switch (action.kind) {
    case 'create_file':
    case 'write_file':
      return { path: action.path, content: capText(action.content, 500) };
    case 'edit_file':
      return { path: action.path, oldText: capText(action.oldText, 500), newText: capText(action.newText, 500) };
    case 'delete_file':
      return { path: action.path };
    case 'run_command':
      return { argv: action.argv, timeoutMs: action.timeoutMs };
    case 'finish':
      return { summary: action.summary, success: action.success };
  }
}

/** Build a run summary from a finished result (for stats aggregation). */
export function toRunSummary(result: CodingRunResult, failureReason?: string): RunSummary {
  return {
    runId: result.runId,
    task: result.trace.task,
    model: result.trace.model,
    status: result.status,
    summary: result.summary,
    stepsUsed: result.stepsUsed,
    filesChanged: result.filesChanged.length,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: result.usage.costUsd,
    durationMs: result.durationMs,
    failureReason,
  };
}
