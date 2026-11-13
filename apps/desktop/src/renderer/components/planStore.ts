/**
 * UI plan store (v0.96, Team T6) — PlanView state.
 *
 * The renderer keeps plans as plain JSON in localStorage
 * (`open-bot:plans-v096`) so PlanView works without a new IPC
 * channel and without importing the core engine into the bundle
 * (the renderer mirrors core types elsewhere too — see
 * ComputersView / FleetView). The lifecycle mirrors
 * `packages/core/src/planning/engine.ts` exactly:
 *
 *   pending → running → done
 *                  ↘ failed → pending (retry) | skipped
 *   pending → skipped
 *
 * …and the stuck rules mirror `packages/core/src/planning/stuck.ts`:
 * the same tool signature 3× in a row inside a step, or 3 steps in
 * a row finishing failed/skipped without a done step. `PlanView`
 * shows the report as a banner with the suggested next step; the
 * store never stops anything by itself — the user decides.
 *
 * A tool-call history is kept per step (signatures only, never raw
 * arguments) and trimmed to the last 50 calls so the stored JSON
 * stays small.
 */

export type UiPlanStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface UiPlanStep {
  id: string;
  title: string;
  detail?: string;
  status: UiPlanStepStatus;
  assigneeBotId?: string | null;
  attempts: number;
  error?: string;
}

export interface UiPlan {
  id: string;
  title: string;
  detail?: string;
  ownerBotId?: string | null;
  steps: UiPlanStep[];
  createdAt: number;
  updatedAt: number;
}

export type UiStuckReason = 'repeated-tool-call' | 'no-progress';

export interface UiStuckReport {
  reason: UiStuckReason;
  detail: string;
  signature?: string;
  repeatCount?: number;
  failedSteps?: number;
  suggestions: string[];
}

export const PLAN_STORE_KEY = 'open-bot:plans-v096';
export const PLAN_STUCK_REPEAT_THRESHOLD = 3;
export const PLAN_STUCK_NO_PROGRESS_THRESHOLD = 3;
/** Tool-call signatures kept per step (oldest drop off). */
export const PLAN_TOOL_HISTORY_CAP = 50;

export function newPlanId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

/** Signature for a tool call — same shape as the core detector. */
export function planToolSignature(tool: string, args: Record<string, unknown>): string {
  const name = (tool ?? '').trim() || 'unknown';
  const keys = Object.keys(args ?? {}).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const value = (args as Record<string, unknown>)[key];
    if (value === undefined) continue;
    let rendered: string;
    try {
      rendered = JSON.stringify(value) ?? 'null';
    } catch {
      rendered = typeof value;
    }
    if (rendered.length > 200) rendered = `${rendered.slice(0, 200)}…`;
    parts.push(`${key}=${rendered}`);
  }
  return `${name}(${parts.join(',')})`;
}

/** Trailing run of identical signatures (see core stuck.ts). */
export function planTrailingRepeat(
  history: readonly string[],
): { signature: string; count: number } {
  if (history.length === 0) return { signature: '', count: 0 };
  const last = history[history.length - 1] as string;
  let count = 1;
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i] !== last) break;
    count++;
  }
  return { signature: last, count };
}

export function planRepeatedCallReport(
  history: readonly string[],
  threshold = PLAN_STUCK_REPEAT_THRESHOLD,
): UiStuckReport | null {
  const { signature, count } = planTrailingRepeat(history);
  if (count < Math.max(2, threshold)) return null;
  return {
    reason: 'repeated-tool-call',
    detail: `Same tool call ${count} times in a row: ${signature}`,
    signature,
    repeatCount: count,
    suggestions: ['try-different-tool', 'ask-user', 'skip-step'],
  };
}

export function planNoProgressReport(
  steps: readonly UiPlanStep[],
  threshold = PLAN_STUCK_NO_PROGRESS_THRESHOLD,
): UiStuckReport | null {
  let streak = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    const status = steps[i]?.status;
    if (status === 'failed' || status === 'skipped') streak++;
    else if (status === 'done') break;
  }
  if (streak < Math.max(2, threshold)) return null;
  return {
    reason: 'no-progress',
    detail: `${streak} steps in a row finished without progress`,
    failedSteps: streak,
    suggestions: ['ask-user', 'replan', 'skip-step'],
  };
}

export interface PlanStore {
  plans: UiPlan[];
  /** stepId → recent tool-call signatures (newest last). */
  toolHistory: Record<string, string[]>;
}

export function emptyPlanStore(): PlanStore {
  return { plans: [], toolHistory: {} };
}

export function createUiPlan(
  title: string,
  opts: { detail?: string; ownerBotId?: string | null; steps?: string[] } = {},
): UiPlan {
  const clean = title.trim();
  if (!clean) throw new Error('Plan title must not be empty.');
  const now = Date.now();
  return {
    id: newPlanId(),
    title: clean,
    detail: opts.detail?.trim() ? opts.detail.trim() : undefined,
    ownerBotId: opts.ownerBotId ?? null,
    steps: (opts.steps ?? [])
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => ({
        id: newPlanId(),
        title: s,
        status: 'pending' as const,
        attempts: 0,
      })),
    createdAt: now,
    updatedAt: now,
  };
}

export function planProgressOf(plan: UiPlan): {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  running: number;
  pending: number;
  percent: number;
  finished: boolean;
} {
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
  return {
    total,
    done,
    failed,
    skipped,
    running,
    pending: total - done - failed - skipped - running,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    finished: total > 0 && done + skipped === total,
  };
}

function withPlan(store: PlanStore, planId: string, fn: (plan: UiPlan) => void): PlanStore {
  const plan = store.plans.find((p) => p.id === planId);
  if (!plan) throw new Error(`Unknown plan: ${planId}`);
  const next: UiPlan = {
    ...plan,
    steps: plan.steps.map((s) => ({ ...s })),
    updatedAt: Date.now(),
  };
  fn(next);
  return { ...store, plans: store.plans.map((p) => (p.id === planId ? next : p)) };
}

function findStep(plan: UiPlan, stepId: string): UiPlanStep {
  const step = plan.steps.find((s) => s.id === stepId);
  if (!step) throw new Error(`Unknown step: ${stepId}`);
  return step;
}

export function addUiPlan(store: PlanStore, plan: UiPlan): PlanStore {
  return { ...store, plans: [plan, ...store.plans] };
}

export function deleteUiPlan(store: PlanStore, planId: string): PlanStore {
  const plan = store.plans.find((p) => p.id === planId);
  const toolHistory = { ...store.toolHistory };
  if (plan) for (const step of plan.steps) delete toolHistory[step.id];
  return { plans: store.plans.filter((p) => p.id !== planId), toolHistory };
}

export function addUiStep(store: PlanStore, planId: string, title: string): PlanStore {
  const clean = title.trim();
  if (!clean) throw new Error('Step title must not be empty.');
  return withPlan(store, planId, (plan) => {
    plan.steps.push({ id: newPlanId(), title: clean, status: 'pending', attempts: 0 });
  });
}

export function assignUiStep(
  store: PlanStore,
  planId: string,
  stepId: string,
  botId: string | null,
): PlanStore {
  return withPlan(store, planId, (plan) => {
    const step = findStep(plan, stepId);
    if (step.status === 'running') throw new Error('Cannot reassign a running step.');
    step.assigneeBotId = botId;
  });
}

export function startUiStep(store: PlanStore, planId: string, stepId: string): PlanStore {
  const toolHistory = { ...store.toolHistory };
  const next = withPlan(store, planId, (plan) => {
    const step = findStep(plan, stepId);
    if (step.status === 'running') throw new Error(`Step is already running: ${step.title}`);
    if (step.status === 'done') throw new Error(`Step is already done: ${step.title}`);
    if (step.status === 'skipped') throw new Error(`Step was skipped: ${step.title}`);
    if (step.assigneeBotId) {
      const clash = plan.steps.find(
        (s) => s.id !== step.id && s.status === 'running' && s.assigneeBotId === step.assigneeBotId,
      );
      if (clash) throw new Error(`Bot is already running step: ${clash.title}`);
    }
    step.status = 'running';
    step.attempts++;
    step.error = undefined;
  });
  toolHistory[stepId] = [];
  return { ...next, toolHistory };
}

export function completeUiStep(store: PlanStore, planId: string, stepId: string): PlanStore {
  return withPlan(store, planId, (plan) => {
    const step = findStep(plan, stepId);
    if (step.status !== 'running') throw new Error(`Step is not running: ${step.title}`);
    step.status = 'done';
  });
}

export function failUiStep(
  store: PlanStore,
  planId: string,
  stepId: string,
  error?: string,
): PlanStore {
  return withPlan(store, planId, (plan) => {
    const step = findStep(plan, stepId);
    if (step.status !== 'running') throw new Error(`Step is not running: ${step.title}`);
    step.status = 'failed';
    if (error?.trim()) step.error = error.trim().slice(0, 500);
  });
}

export function retryUiStep(store: PlanStore, planId: string, stepId: string): PlanStore {
  return withPlan(store, planId, (plan) => {
    const step = findStep(plan, stepId);
    if (step.status !== 'failed') throw new Error(`Only a failed step can be retried: ${step.title}`);
    step.status = 'pending';
    step.error = undefined;
  });
}

export function skipUiStep(store: PlanStore, planId: string, stepId: string): PlanStore {
  return withPlan(store, planId, (plan) => {
    const step = findStep(plan, stepId);
    if (step.status === 'running') throw new Error('Stop a running step before skipping it.');
    if (step.status === 'done') throw new Error(`Step is already done: ${step.title}`);
    step.status = 'skipped';
  });
}

/**
 * Multi-agent dispatch for the UI: claim the next step for a bot —
 * its own assigned pending step first, then the oldest unassigned
 * pending step. Returns the updated store plus the claimed step (or
 * null when the bot already runs a step / nothing is claimable).
 */
export function dispatchUiStep(
  store: PlanStore,
  planId: string,
  botId: string,
): { store: PlanStore; step: UiPlanStep | null } {
  const plan = store.plans.find((p) => p.id === planId);
  if (!plan) throw new Error(`Unknown plan: ${planId}`);
  if (!botId.trim()) throw new Error('dispatch needs a botId.');
  if (plan.steps.some((s) => s.status === 'running' && s.assigneeBotId === botId)) {
    return { store, step: null };
  }
  const next =
    plan.steps.find((s) => s.status === 'pending' && s.assigneeBotId === botId) ??
    plan.steps.find((s) => s.status === 'pending' && !s.assigneeBotId);
  if (!next) return { store, step: null };
  const claimed = { ...next, assigneeBotId: botId };
  const withAssign = assignUiStep(store, planId, next.id, botId);
  const started = startUiStep(withAssign, planId, next.id);
  return { store: started, step: claimed };
}

/**
 * Record a tool call for a step and check the repeated-call rule.
 * Returns the updated store plus a stuck report when the rule fires.
 */
export function recordUiToolCall(
  store: PlanStore,
  stepId: string,
  tool: string,
  args: Record<string, unknown>,
): { store: PlanStore; stuck: UiStuckReport | null } {
  const signature = planToolSignature(tool, args);
  const history = [...(store.toolHistory[stepId] ?? []), signature].slice(-PLAN_TOOL_HISTORY_CAP);
  const next = { ...store, toolHistory: { ...store.toolHistory, [stepId]: history } };
  return { store: next, stuck: planRepeatedCallReport(history) };
}

/** Check both stuck rules for a plan (repeated call needs a step id). */
export function checkUiPlanStuck(
  store: PlanStore,
  planId: string,
  stepId?: string,
): UiStuckReport | null {
  const plan = store.plans.find((p) => p.id === planId);
  if (!plan) throw new Error(`Unknown plan: ${planId}`);
  if (stepId) {
    const repeated = planRepeatedCallReport(store.toolHistory[stepId] ?? []);
    if (repeated) return repeated;
  }
  return planNoProgressReport(plan.steps);
}

// -- persistence (localStorage, defensive like the rest of the UI) --------

export function parsePlanStore(raw: string | null | undefined): PlanStore {
  if (!raw) return emptyPlanStore();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return emptyPlanStore();
    }
    const data = parsed as { plans?: unknown; toolHistory?: unknown };
    const plans = Array.isArray(data.plans)
      ? (data.plans as Array<Record<string, unknown>>)
          .filter((p) => typeof p['id'] === 'string' && typeof p['title'] === 'string')
          .map((p) => ({
            id: p['id'] as string,
            title: p['title'] as string,
            detail: typeof p['detail'] === 'string' ? p['detail'] : undefined,
            ownerBotId: typeof p['ownerBotId'] === 'string' ? p['ownerBotId'] : null,
            steps: Array.isArray(p['steps'])
              ? (p['steps'] as Array<Record<string, unknown>>)
                  .filter((s) => typeof s['id'] === 'string' && typeof s['title'] === 'string')
                  .map((s) => ({
                    id: s['id'] as string,
                    title: s['title'] as string,
                    detail: typeof s['detail'] === 'string' ? s['detail'] : undefined,
                    status: (['pending', 'running', 'done', 'failed', 'skipped'].includes(
                      String(s['status']),
                    )
                      ? (s['status'] as UiPlanStepStatus)
                      : 'pending') as UiPlanStepStatus,
                    assigneeBotId:
                      typeof s['assigneeBotId'] === 'string' ? s['assigneeBotId'] : null,
                    attempts: typeof s['attempts'] === 'number' ? s['attempts'] : 0,
                    error: typeof s['error'] === 'string' ? s['error'] : undefined,
                  }))
              : [],
            createdAt: typeof p['createdAt'] === 'number' ? p['createdAt'] : Date.now(),
            updatedAt: typeof p['updatedAt'] === 'number' ? p['updatedAt'] : Date.now(),
          }))
      : [];
    const toolHistory: Record<string, string[]> = {};
    if (typeof data.toolHistory === 'object' && data.toolHistory !== null) {
      for (const [stepId, history] of Object.entries(
        data.toolHistory as Record<string, unknown>,
      )) {
        if (!Array.isArray(history)) continue;
        const sigs = history
          .filter((s): s is string => typeof s === 'string')
          .slice(-PLAN_TOOL_HISTORY_CAP);
        if (sigs.length > 0) toolHistory[stepId] = sigs;
      }
    }
    return { plans, toolHistory };
  } catch {
    return emptyPlanStore();
  }
}

export function stringifyPlanStore(store: PlanStore): string {
  return JSON.stringify({ plans: store.plans, toolHistory: store.toolHistory });
}
