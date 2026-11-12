/**
 * Agent-to-agent coordination helpers for @open-bot/core (v0.6).
 *
 * Pure logic over BotMemory — no provider calls, no network, no loop.
 * The agent loop NEVER calls anything here by itself; the `reflect` /
 * `grind_*` tools call these functions only when the model invokes them.
 *
 * Contents:
 *  - reflectOnProgress / saveReflection: structured self-reflection
 *    (what is done, what is stuck, what is next) derived from history
 *    + tasks, saved back into memory as a note.
 *  - Grind: long-running goal executed in slices. A grind is a plan
 *    (project + step tasks, via PlanService) plus a durable checkpoint
 *    stored in BotMemory (`memory_entries` key `grind:<projectId>`), so
 *    a grind survives process restarts and can be resumed.
 *    Execution is slice-by-slice: advanceGrind() runs ONE slice (at
 *    most `sliceSize` pending steps) through an optional `runStep`
 *    callback, marks each finished step done, then checkpoints. With
 *    no callback it only returns the next slice to execute (planning
 *    only, same rule as PlanService.grindRun — it never loops forever).
 */

import type { BotMemory, TaskItem } from './memory';
import { PlanService } from './planning';
import type { BotConfig } from '../types';

// ---------------------------------------------------------------------------
// Agent modes (set_agent_mode tool). The mode lives on the bot config as
// an optional field; BotConfig itself is NOT extended here (types.ts is
// the shared contract and is untouched by v0.6) — hosts store the mode
// via the createAgentTools callbacks / BotMemory key `agent:mode`.
// ---------------------------------------------------------------------------

export type AgentMode = 'chat' | 'plan' | 'grind' | 'review';

export const AGENT_MODES: readonly AgentMode[] = ['chat', 'plan', 'grind', 'review'];

export function isAgentMode(value: string): value is AgentMode {
  return (AGENT_MODES as readonly string[]).includes(value);
}

/** BotConfig plus the optional working mode (defined here, not in types.ts). */
export type BotConfigWithMode = Partial<BotConfig> & { mode?: AgentMode };

// ---------------------------------------------------------------------------
// Reflect
// ---------------------------------------------------------------------------

export interface ReflectionSummary {
  botId: string;
  generatedAt: string;
  /** Titles of tasks already done. */
  done: string[];
  /** Titles of in-progress tasks + recent messages that mention an error. */
  blocked: string[];
  /** Titles of pending tasks, in execution order (what to do next). */
  nextSteps: string[];
  counts: {
    messages: number;
    tasksDone: number;
    tasksInProgress: number;
    tasksPending: number;
  };
  /** One-paragraph human-readable summary. */
  summary: string;
}

const ERROR_KEYWORDS = ['lỗi', 'error', 'failed', 'thất bại', 'không thể', 'không làm được'];

/**
 * Structured self-reflection from a bot's history + tasks. Pure read:
 * it never writes to memory (use saveReflection for that) and never
 * calls a provider — the "thinking" is a deterministic summary of what
 * the bot has actually recorded, so it cannot hallucinate progress.
 */
export function reflectOnProgress(
  memory: BotMemory,
  botId: string,
  opts: { historyLimit?: number } = {},
): ReflectionSummary {
  const history = memory.getHistory(botId, opts.historyLimit ?? 50);
  const tasks = memory.listTasks(botId);
  // listTasks is newest-first; execution order is oldest-first.
  const ordered = [...tasks].reverse();
  const done = ordered.filter((t) => t.status === 'done').map((t) => t.title);
  const inProgress = ordered.filter((t) => t.status === 'in_progress').map((t) => t.title);
  const pending = ordered.filter((t) => t.status === 'pending').map((t) => t.title);
  const blocked: string[] = [...inProgress];
  // Recent assistant/tool messages mentioning an error count as "stuck".
  for (const msg of history.slice(-20)) {
    if (msg.role !== 'assistant' && msg.role !== 'tool') continue;
    const lower = msg.content.toLowerCase();
    if (!ERROR_KEYWORDS.some((k) => lower.includes(k))) continue;
    const snippet = msg.content.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (snippet) blocked.push(`tin nhắn: "${snippet}"`);
  }
  const nextSteps = pending.slice(0, 5);
  const generatedAt = new Date().toISOString();
  const summary =
    `Bot ${botId}: đã xong ${done.length} task` +
    (done.length > 0 ? ` (${done.slice(0, 3).join('; ')}${done.length > 3 ? '; …' : ''})` : '') +
    `, đang làm dở ${inProgress.length} task, còn ${pending.length} task chờ.` +
    (blocked.length > 0
      ? ` Đang kẹt ở: ${blocked.slice(0, 3).join('; ')}.`
      : ' Không thấy dấu hiệu kẹt.') +
    (nextSteps.length > 0
      ? ` Bước tiếp theo: ${nextSteps.join(' → ')}.`
      : ' Không còn bước tiếp theo.');
  return {
    botId,
    generatedAt,
    done,
    blocked,
    nextSteps,
    counts: {
      messages: history.length,
      tasksDone: done.length,
      tasksInProgress: inProgress.length,
      tasksPending: pending.length,
    },
    summary,
  };
}

/**
 * Save a reflection into memory as a note (memory_entries, NOT a chat
 * message — it must not pollute the conversation history). Keeps both a
 * `reflection:latest` pointer and a timestamped copy. Returns the keys
 * written.
 */
export function saveReflection(memory: BotMemory, reflection: ReflectionSummary): string[] {
  const json = JSON.stringify(reflection, null, 2);
  const latestKey = 'reflection:latest';
  const stampedKey = `reflection:${reflection.generatedAt}`;
  memory.setMemory(reflection.botId, latestKey, json);
  memory.setMemory(reflection.botId, stampedKey, json);
  return [latestKey, stampedKey];
}

// ---------------------------------------------------------------------------
// Grind — long-running goal, executed in slices, checkpointed in memory.
// ---------------------------------------------------------------------------

export type GrindStatus = 'running' | 'paused' | 'done' | 'stopped';

export interface GrindState {
  projectId: string;
  botId: string;
  goal: string;
  status: GrindStatus;
  sliceSize: number;
  /** Index of the next slice to execute (0-based). */
  currentSlice: number;
  totalSlices: number;
  completedStepIds: string[];
  /** Human-readable checkpoint note (last durable state). */
  checkpoint: string;
  updatedAt: string;
}

export interface GrindStatusReport {
  state: GrindState;
  totalSteps: number;
  doneSteps: number;
  pendingSteps: number;
  /** Titles of the steps in the next slice (empty when finished). */
  nextSlice: string[];
}

export interface GrindAdvanceResult {
  state: GrindState;
  /** Steps in the slice that was (or would be) executed. */
  slice: TaskItem[];
  /** One result line per executed step; empty when planning-only. */
  results: string[];
}

export function grindMemoryKey(projectId: string): string {
  return `grind:${projectId}`;
}

function saveGrindState(memory: BotMemory, state: GrindState): void {
  state.updatedAt = new Date().toISOString();
  memory.setMemory(state.botId, grindMemoryKey(state.projectId), JSON.stringify(state));
}

/** Load a grind checkpoint for a bot, or null when it does not exist. */
export function loadGrindStateForBot(memory: BotMemory, botId: string, projectId: string): GrindState | null {
  const raw = memory.getMemory(botId, grindMemoryKey(projectId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as GrindState;
    if (typeof parsed !== 'object' || parsed === null || parsed.projectId !== projectId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function planSteps(memory: BotMemory, projectId: string): TaskItem[] {
  return new PlanService(memory).grindRun(projectId).steps;
}

/**
 * Start a grind: create the plan (project + one task per step) and
 * write the first checkpoint. Nothing is executed here — execution
 * happens slice by slice via advanceGrind().
 */
export function startGrind(
  memory: BotMemory,
  botId: string,
  goal: string,
  steps: string[],
  opts: { sliceSize?: number; detail?: string } = {},
): { state: GrindState; projectId: string; firstSlice: TaskItem[] } {
  const trimmedGoal = goal.trim();
  if (!trimmedGoal) throw new Error('grind_start cần mục tiêu (goal) không rỗng.');
  const cleanSteps = steps.map((s) => s.trim()).filter((s) => s.length > 0);
  if (cleanSteps.length === 0) throw new Error('grind_start cần ít nhất một bước (steps).');
  const sliceSize = Math.max(1, Math.floor(opts.sliceSize ?? 3));
  const plan = new PlanService(memory).grindPlan(botId, trimmedGoal, opts.detail ?? '', cleanSteps);
  const totalSlices = Math.ceil(cleanSteps.length / sliceSize);
  const state: GrindState = {
    projectId: plan.projectId,
    botId,
    goal: trimmedGoal,
    status: 'running',
    sliceSize,
    currentSlice: 0,
    totalSlices,
    completedStepIds: [],
    checkpoint: `Đã lập kế hoạch "${trimmedGoal}": ${cleanSteps.length} bước, ${totalSlices} lát cắt (mỗi lát ${sliceSize} bước). Chưa thực thi lát nào.`,
    updatedAt: new Date().toISOString(),
  };
  saveGrindState(memory, state);
  return { state, projectId: plan.projectId, firstSlice: planSteps(memory, plan.projectId).slice(0, sliceSize) };
}

/** Durable status of a grind (state + step counts + next slice titles). */
export function getGrindStatus(memory: BotMemory, botId: string, projectId: string): GrindStatusReport {
  const state = loadGrindStateForBot(memory, botId, projectId);
  if (!state) throw new Error(`Không thấy grind: "${projectId}" (chưa grind_start hoặc đã xoá checkpoint).`);
  const steps = planSteps(memory, projectId);
  const doneSteps = steps.filter((s) => s.status === 'done').length;
  const pending = steps.filter((s) => s.status !== 'done' && s.status !== 'cancelled');
  return {
    state,
    totalSteps: steps.length,
    doneSteps,
    pendingSteps: pending.length,
    nextSlice: pending.slice(0, state.sliceSize).map((s) => s.title),
  };
}

/**
 * Execute (or preview) ONE slice of a grind.
 * - With `runStep`: each pending step in the slice is marked
 *   in_progress, run through `runStep(step)`, then marked done; the
 *   checkpoint is written AFTER the whole slice, so a crash mid-slice
 *   resumes from the previous checkpoint. A step that throws stays
 *   in_progress, its error is recorded, and the slice stops there.
 * - Without `runStep`: planning only — returns the next slice without
 *   changing any task or checkpoint.
 * When no pending steps remain the grind becomes `done`.
 */
export async function advanceGrind(
  memory: BotMemory,
  botId: string,
  projectId: string,
  runStep?: (step: TaskItem) => Promise<string> | string,
): Promise<GrindAdvanceResult> {
  const state = loadGrindStateForBot(memory, botId, projectId);
  if (!state) throw new Error(`Không thấy grind: "${projectId}".`);
  if (state.status === 'stopped') throw new Error(`Grind "${projectId}" đã dừng — grind_start lại để chạy mục tiêu mới.`);
  // v0.54 (P1-8): grind đang tạm dừng (pause/interrupt HITL giữa các lát)
  // thì advance từ chối rõ ràng — phải resume (resumeGrind) trước, tránh
  // chạy tiếp lát mới khi user đang muốn dừng lại hỏi.
  if (state.status === 'paused') {
    throw new Error(
      `Grind "${projectId}" đang tạm dừng ở lát ${state.currentSlice + 1}/${state.totalSlices} ` +
        `— dùng resumeGrind (hoặc grind_status) để tiếp tục, không advance khi đang pause.`,
    );
  }
  if (state.status === 'done') {
    return { state, slice: [], results: ['Grind đã hoàn tất, không còn lát nào.'] };
  }
  const steps = planSteps(memory, projectId);
  const pending = steps.filter((s) => s.status !== 'done' && s.status !== 'cancelled');
  if (pending.length === 0) {
    state.status = 'done';
    state.checkpoint = `Hoàn tất mục tiêu "${state.goal}": ${steps.length}/${steps.length} bước xong.`;
    saveGrindState(memory, state);
    return { state, slice: [], results: ['Hoàn tất: không còn bước chờ.'] };
  }
  const slice = pending.slice(0, state.sliceSize);
  if (!runStep) {
    // Planning only: no task changes, no checkpoint write.
    return { state, slice, results: [] };
  }
  const results: string[] = [];
  for (const step of slice) {
    memory.updateTask(step.id, 'in_progress');
    try {
      const out = await runStep(step);
      memory.updateTask(step.id, 'done');
      state.completedStepIds.push(step.id);
      results.push(`done: ${step.title} — ${String(out).slice(0, 500)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push(`error: ${step.title} — ${message}`);
      state.checkpoint =
        `Lát ${state.currentSlice + 1}/${state.totalSlices} dừng giữa chừng ở bước "${step.title}": ${message}. ` +
        `Đã xong ${state.completedStepIds.length}/${steps.length} bước — resume sẽ chạy tiếp từ bước này.`;
      saveGrindState(memory, state);
      return { state, slice, results };
    }
  }
  state.currentSlice += 1;
  state.checkpoint =
    `Checkpoint lát ${state.currentSlice}/${state.totalSlices}: ` +
    `đã xong ${state.completedStepIds.length}/${steps.length} bước của "${state.goal}". ` +
    (state.currentSlice >= state.totalSlices
      ? 'Đã hết lát — lần advance tiếp theo sẽ đánh dấu hoàn tất.'
      : `Lát tiếp theo: ${pending.slice(state.sliceSize, state.sliceSize * 2).map((s) => s.title).join(', ') || '—'}.`);
  if (state.completedStepIds.length >= steps.length) state.status = 'done';
  saveGrindState(memory, state);
  return { state, slice, results };
}

/** Stop a grind. The checkpoint is kept, so the plan/tasks stay readable. */
export function stopGrind(memory: BotMemory, botId: string, projectId: string, reason = ''): GrindState {
  const state = loadGrindStateForBot(memory, botId, projectId);
  if (!state) throw new Error(`Không thấy grind: "${projectId}".`);
  state.status = 'stopped';
  state.checkpoint =
    `Đã dừng grind "${state.goal}" ở lát ${state.currentSlice + 1}/${state.totalSlices} ` +
    `(${state.completedStepIds.length} bước đã xong).` +
    (reason ? ` Lý do: ${reason}` : ' Có thể grind_start lại mục tiêu mới; checkpoint cũ vẫn lưu trong memory.');
  saveGrindState(memory, state);
  return state;
}

/**
 * v0.54 (P1-8): tạm dừng một grind (interrupt HITL cho run dài nhất).
 * Khác `stopGrind` ở chỗ pause GIỮ nguyên trạng thái để resume: status
 * `paused`, checkpoint ghi rõ đang dừng ở lát nào + câu hỏi (nếu có) để
 * user trả lời rồi `resumeGrind` chạy tiếp lát sau — không mất bước nào,
 * không cần lập plan mới. Pause một grind đã `done`/`stopped` thì lỗi rõ.
 * Gọi pause khi grind đã paused thì giữ nguyên (idempotent, không lỗi).
 */
export function pauseGrind(
  memory: BotMemory,
  botId: string,
  projectId: string,
  question = '',
): GrindState {
  const state = loadGrindStateForBot(memory, botId, projectId);
  if (!state) throw new Error(`Không thấy grind: "${projectId}".`);
  if (state.status === 'done') throw new Error(`Grind "${projectId}" đã hoàn tất — không pause được.`);
  if (state.status === 'stopped') throw new Error(`Grind "${projectId}" đã dừng — không pause được.`);
  state.status = 'paused';
  state.checkpoint =
    `Đã tạm dừng grind "${state.goal}" ở lát ${state.currentSlice + 1}/${state.totalSlices} ` +
    `(${state.completedStepIds.length} bước đã xong). ` +
    (question ? `Câu hỏi chờ user: ${question} ` : '') +
    `Dùng resumeGrind để tiếp tục từ lát tiếp theo.`;
  saveGrindState(memory, state);
  return state;
}

/** Resume info for a grind: its durable state plus the next slice to run. */
export function resumeGrind(
  memory: BotMemory,
  botId: string,
  projectId: string,
): { state: GrindState; nextSlice: TaskItem[] } {
  const state = loadGrindStateForBot(memory, botId, projectId);
  if (!state) throw new Error(`Không thấy grind: "${projectId}".`);
  if (state.status === 'stopped') throw new Error(`Grind "${projectId}" đã dừng — không resume được.`);
  // v0.54 (P1-8): resume từ pause (interrupt HITL) — mở lại status
  // `running` để advanceGrind chạy tiếp lát sau; resume từ `running`
  // thì không đổi gì (chỉ đọc lại next slice).
  if (state.status === 'paused') {
    state.status = 'running';
    state.checkpoint =
      `Đã tiếp tục grind "${state.goal}" sau khi tạm dừng ở lát ${state.currentSlice + 1}/${state.totalSlices} ` +
      `(${state.completedStepIds.length} bước đã xong).`;
    saveGrindState(memory, state);
  }
  const steps = planSteps(memory, projectId);
  const pending = steps.filter((s) => s.status !== 'done' && s.status !== 'cancelled');
  return { state, nextSlice: pending.slice(0, state.sliceSize) };
}

/**
 * Object-oriented wrapper over the grind functions above, for hosts
 * that prefer holding one session per grind instead of passing
 * (memory, botId, projectId) every call.
 */
export class GrindSession {
  private state: GrindState | null = null;

  constructor(
    private readonly memory: BotMemory,
    private readonly botId: string,
  ) {}

  start(goal: string, steps: string[], opts: { sliceSize?: number; detail?: string } = {}): GrindState {
    const { state } = startGrind(this.memory, this.botId, goal, steps, opts);
    this.state = state;
    return state;
  }

  status(): GrindStatusReport {
    if (!this.state) throw new Error('GrindSession chưa start — gọi start() trước.');
    return getGrindStatus(this.memory, this.botId, this.state.projectId);
  }

  advance(runStep?: (step: TaskItem) => Promise<string> | string): Promise<GrindAdvanceResult> {
    if (!this.state) throw new Error('GrindSession chưa start — gọi start() trước.');
    return advanceGrind(this.memory, this.botId, this.state.projectId, runStep).then((r) => {
      this.state = r.state;
      return r;
    });
  }

  stop(reason = ''): GrindState {
    if (!this.state) throw new Error('GrindSession chưa start — gọi start() trước.');
    this.state = stopGrind(this.memory, this.botId, this.state.projectId, reason);
    return this.state;
  }

  /** v0.54 (P1-8): tạm dừng grind này (xem `pauseGrind`). */
  pause(question = ''): GrindState {
    if (!this.state) throw new Error('GrindSession chưa start — gọi start() trước.');
    this.state = pauseGrind(this.memory, this.botId, this.state.projectId, question);
    return this.state;
  }

  resume(): { state: GrindState; nextSlice: TaskItem[] } {
    if (!this.state) throw new Error('GrindSession chưa start — gọi start() trước.');
    return resumeGrind(this.memory, this.botId, this.state.projectId);
  }
}

// ---------------------------------------------------------------------------
// Plan approval (v0.11, P0-3) — plan mode thật.
//
// Flow: agent (plan mode) submits a plan with plan_create -> the plan
// file is written (planning.ts) and a `pending` approval state is stored
// here in BotMemory (`plan:approval:<projectId>` + the per-bot pending
// index `plans:pending`). The user reviews the plan in the desktop
// PlanReviewView and answers approve / reject / request-changes; the
// agent applies the answer with plan_update { reviewDecision }.
//
// Only `approve` changes the working mode: it flips `agent:mode` to
// `chat`, so execution starts on the NEXT run (the mode is read once
// per run by the coordinator). Reject / request-changes leave the mode
// at `plan` so the agent can revise and re-submit.
//
// Durable in BotMemory like the grind checkpoint, so a pending plan
// survives restarts. This module never executes a step itself.
// ---------------------------------------------------------------------------

export type PlanReviewDecision = 'approve' | 'reject' | 'request-changes';

export const PLAN_REVIEW_DECISIONS: readonly PlanReviewDecision[] = [
  'approve',
  'reject',
  'request-changes',
];

export function isPlanReviewDecision(value: string): value is PlanReviewDecision {
  return (PLAN_REVIEW_DECISIONS as readonly string[]).includes(value);
}

export type PlanApprovalStatus = 'pending' | 'approved' | 'rejected' | 'changes-requested';

export interface PlanApprovalState {
  projectId: string;
  botId: string;
  title: string;
  /** Workspace-relative plan file path (`.open-bot/plans/<id>.md`), '' when no file was written. */
  filePath: string;
  steps: string[];
  decisions: string[];
  status: PlanApprovalStatus;
  /** Note left with the last decision (mainly for `request-changes`). */
  note: string;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
}

export interface PlanReviewResult {
  state: PlanApprovalState;
  /** Working mode after the decision ('chat' after approve, unchanged otherwise). */
  mode: AgentMode;
}

export function planApprovalMemoryKey(projectId: string): string {
  return `plan:approval:${projectId}`;
}

/** Per-bot pending-plan index: JSON array of projectIds awaiting review. */
export function pendingPlansMemoryKey(): string {
  return 'plans:pending';
}

function readPendingIndex(memory: BotMemory, botId: string): string[] {
  const raw = memory.getMemory(botId, pendingPlansMemoryKey());
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

function writePendingIndex(memory: BotMemory, botId: string, ids: string[]): void {
  memory.setMemory(botId, pendingPlansMemoryKey(), JSON.stringify([...new Set(ids)]));
}

function savePlanApprovalState(memory: BotMemory, state: PlanApprovalState): void {
  state.updatedAt = new Date().toISOString();
  memory.setMemory(
    state.botId,
    planApprovalMemoryKey(state.projectId),
    JSON.stringify(state),
  );
}

/**
 * Record a freshly submitted plan as `pending` review. Throws on an
 * empty projectId/title. Re-submitting the same projectId resets it to
 * pending (the agent revised the plan) and keeps a single index entry.
 */
export function submitPlanForReview(
  memory: BotMemory,
  botId: string,
  input: {
    projectId: string;
    title: string;
    filePath?: string;
    steps?: string[];
    decisions?: string[];
  },
): PlanApprovalState {
  const projectId = input.projectId.trim();
  const title = input.title.trim();
  if (!projectId) throw new Error('submitPlanForReview cần projectId không rỗng.');
  if (!title) throw new Error('submitPlanForReview cần title không rỗng.');
  const now = new Date().toISOString();
  const state: PlanApprovalState = {
    projectId,
    botId,
    title,
    filePath: (input.filePath ?? '').trim(),
    steps: (input.steps ?? []).map((s) => s.trim()).filter((s) => s.length > 0),
    decisions: (input.decisions ?? []).map((d) => d.trim()).filter((d) => d.length > 0),
    status: 'pending',
    note: '',
    createdAt: now,
    updatedAt: now,
  };
  savePlanApprovalState(memory, state);
  const index = readPendingIndex(memory, botId);
  if (!index.includes(projectId)) writePendingIndex(memory, botId, [...index, projectId]);
  return state;
}

/** Load one plan's approval state, or null when it was never submitted. */
export function getPlanApproval(
  memory: BotMemory,
  botId: string,
  projectId: string,
): PlanApprovalState | null {
  const raw = memory.getMemory(botId, planApprovalMemoryKey(projectId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PlanApprovalState;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      parsed.projectId !== projectId ||
      parsed.botId !== botId
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Plans of this bot still waiting for a user decision, in submit order. */
export function listPendingPlans(memory: BotMemory, botId: string): PlanApprovalState[] {
  const out: PlanApprovalState[] = [];
  for (const projectId of readPendingIndex(memory, botId)) {
    const state = getPlanApproval(memory, botId, projectId);
    if (state && state.status === 'pending') out.push(state);
  }
  return out;
}

/** Current working mode of a bot as stored in memory (default `chat`). */
export function getBotMode(memory: BotMemory, botId: string): AgentMode {
  const raw = memory.getMemory(botId, 'agent:mode');
  return typeof raw === 'string' && isAgentMode(raw) ? raw : 'chat';
}

/**
 * Apply the user's review decision to a pending plan.
 * - `approve`: status `approved`, mode flips to `chat` (execution starts next run).
 * - `reject`: status `rejected`, mode unchanged (stays `plan`).
 * - `request-changes`: status `changes-requested` + note, mode unchanged.
 * The plan leaves the pending index on any decision. Throws when the
 * plan was never submitted or was already decided.
 */
export function reviewPlan(
  memory: BotMemory,
  botId: string,
  projectId: string,
  decision: PlanReviewDecision,
  note = '',
): PlanReviewResult {
  const state = getPlanApproval(memory, botId, projectId);
  if (!state) throw new Error(`Không thấy plan đang chờ duyệt: "${projectId}".`);
  if (state.status !== 'pending') {
    throw new Error(
      `Plan "${projectId}" đã có quyết định rồi (trạng thái: ${state.status}) — không duyệt lại được.`,
    );
  }
  const modeBefore = getBotMode(memory, botId);
  let mode = modeBefore;
  if (decision === 'approve') {
    state.status = 'approved';
    mode = 'chat';
    memory.setMemory(botId, 'agent:mode', 'chat');
  } else if (decision === 'reject') {
    state.status = 'rejected';
  } else {
    state.status = 'changes-requested';
    state.note = note.trim();
  }
  state.decidedAt = new Date().toISOString();
  savePlanApprovalState(memory, state);
  writePendingIndex(
    memory,
    botId,
    readPendingIndex(memory, botId).filter((id) => id !== projectId),
  );
  return { state, mode };
}
