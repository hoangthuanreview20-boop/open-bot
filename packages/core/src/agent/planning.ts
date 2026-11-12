/**
 * PlanService — thin wrapper over BotMemory for plans, goals, todos and
 * projects (v0.2).
 *
 * A "plan" is a project plus its steps as tasks. Steps are linked to their
 * project through the task `tags` field (`project:<projectId>`), so no
 * extra column is needed on the tasks table.
 *
 * IMPORTANT — grind_run never executes anything: `grindRun()` only returns
 * the ordered list of steps for the caller (agent / UI) to execute one by
 * one. There is no infinite agent loop here by design.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  BotMemory,
  GoalItem,
  GoalStatus,
  ProjectItem,
  ProjectStatus,
  TaskItem,
  TaskStatus,
  TodoItem,
} from './memory';

export interface PlanStepInput {
  title: string;
  tags?: string;
}

export interface CreatedPlan {
  projectId: string;
  project: ProjectItem;
  taskIds: string[];
  tasks: TaskItem[];
}

export interface GrindRun {
  project: ProjectItem;
  /** Steps in execution order (oldest first). Execute them one by one. */
  steps: TaskItem[];
}

function normalizeSteps(steps: Array<string | PlanStepInput>): PlanStepInput[] {
  return steps.map((s) => (typeof s === 'string' ? { title: s } : s));
}

function projectTag(projectId: string): string {
  return `project:${projectId}`;
}

// ---------------------------------------------------------------------------
// Plan file (v0.11, P0-3) — the Markdown artifact of plan mode.
//
// The plan file is the reviewable artifact: the agent writes it with
// plan_create (in plan mode) and the user reads it in the desktop
// PlanReviewView before approving. The file is a snapshot for humans;
// the durable source of truth stays the PlanService project + tasks
// (and the approval state in coordination.ts).
// ---------------------------------------------------------------------------

/** Directory (relative to the bot workspace) holding submitted plan files. */
export const PLAN_FILE_DIR = '.open-bot/plans';

/** Workspace-relative path of a plan file, e.g. `.open-bot/plans/<id>.md`. */
export function planFileRelativePath(projectId: string): string {
  assertSafePlanId(projectId);
  return `${PLAN_FILE_DIR}/${projectId}.md`;
}

export interface PlanFileInput {
  projectId: string;
  title: string;
  detail?: string;
  steps: string[];
  decisions?: string[];
}

/** Project ids come from BotMemory (UUIDs); reject anything path-like. */
export function assertSafePlanId(projectId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(projectId)) {
    throw new Error(`projectId không hợp lệ cho tên file plan: "${projectId}"`);
  }
}

/**
 * Render a plan as Markdown: title + description, numbered steps, and
 * the open decisions the user must settle before execution.
 */
export function renderPlanMarkdown(input: PlanFileInput): string {
  const title = input.title.trim() || 'Kế hoạch (chưa đặt tên)';
  const detail = (input.detail ?? '').trim();
  const steps = input.steps.map((s) => s.trim()).filter((s) => s.length > 0);
  const decisions = (input.decisions ?? []).map((d) => d.trim()).filter((d) => d.length > 0);
  const lines: string[] = [
    `# Kế hoạch: ${title}`,
    '',
    `- Project: \`${input.projectId}\``,
    '- Trạng thái duyệt: chờ duyệt',
    `- Tạo lúc: ${new Date().toISOString()}`,
    '',
    '## Mô tả',
    '',
    detail || '_Không có mô tả._',
    '',
    '## Các bước',
    '',
  ];
  if (steps.length === 0) {
    lines.push('_Chưa có bước nào._', '');
  } else {
    steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push('');
  }
  lines.push('## Lựa chọn cần quyết', '');
  if (decisions.length === 0) {
    lines.push('_Không có lựa chọn nào cần quyết — thực thi theo đúng các bước trên._', '');
  } else {
    for (const d of decisions) lines.push(`- ${d}`);
    lines.push('');
  }
  lines.push(
    '---',
    '',
    '_Ghi bởi open-bot (plan mode). Người dùng duyệt plan ở màn hình Kế hoạch rồi agent mới thực thi._',
    '',
  );
  return lines.join('\n');
}

/**
 * Write (or overwrite) the plan file for a project. Creates
 * `<workspaceDir>/.open-bot/plans/` as needed. Returns the absolute
 * file path. Throws on an empty workspaceDir or an unsafe projectId.
 *
 * v0.79b (UI parity §7, plan diff): overwriting a plan that already
 * exists first snapshots the previous content into
 * `.open-bot/plans/.history/<projectId>-<timestamp>.md` (see
 * `snapshotPlanFile`) so the review screen can show what changed
 * since the previous version. The newest `PLAN_HISTORY_MAX_VERSIONS`
 * snapshots are kept; older ones are pruned.
 */
export function writePlanFile(workspaceDir: string, input: PlanFileInput): string {
  const dir = (workspaceDir ?? '').trim();
  if (!dir) throw new Error('writePlanFile cần workspaceDir không rỗng.');
  const rel = planFileRelativePath(input.projectId);
  const abs = path.resolve(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  snapshotPlanFile(workspaceDir, input.projectId);
  fs.writeFileSync(abs, renderPlanMarkdown(input), 'utf8');
  return abs;
}

/** Directory (relative to the bot workspace) holding previous plan versions. */
export const PLAN_HISTORY_DIR = '.open-bot/plans/.history';

/** How many previous versions of one plan are kept (newest first). */
export const PLAN_HISTORY_MAX_VERSIONS = 5;

/** File names under `.open-bot/plans/.history/` for one project. */
const PLAN_HISTORY_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*-[0-9TZ-]+-[0-9a-f]{4}\.md$/;

/**
 * Snapshot the CURRENT plan file (if one exists) into the history
 * directory before it is overwritten. No-op when there is no plan
 * file yet (first version has nothing to diff against) or when the
 * snapshot cannot be written (a failed snapshot must never block the
 * plan write itself — the caller still writes the new version).
 * Returns the snapshot path, or null when nothing was snapshotted.
 */
export function snapshotPlanFile(workspaceDir: string, projectId: string): string | null {
  const current = readPlanFile(workspaceDir, projectId);
  if (current === null) return null;
  const dir = (workspaceDir ?? '').trim();
  if (!dir) return null;
  try {
    assertSafePlanId(projectId);
    const historyDir = path.resolve(dir, PLAN_HISTORY_DIR);
    fs.mkdirSync(historyDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const suffix = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
    const name = `${projectId}-${stamp}-${suffix}.md`;
    const abs = path.join(historyDir, name);
    fs.writeFileSync(abs, current, 'utf8');
    prunePlanHistory(workspaceDir, projectId);
    return abs;
  } catch {
    return null;
  }
}

/** Delete all but the newest `PLAN_HISTORY_MAX_VERSIONS` snapshots of one plan. */
export function prunePlanHistory(workspaceDir: string, projectId: string): void {
  const files = listPlanHistoryFiles(workspaceDir, projectId);
  for (const extra of files.slice(PLAN_HISTORY_MAX_VERSIONS)) {
    try {
      fs.unlinkSync(extra);
    } catch {
      // One unremovable file must not break the plan write.
    }
  }
}

/**
 * Absolute paths of a plan's snapshots, NEWEST first.
 *
 * Sorted by file mtime (not filename): several snapshots can land in
 * the same millisecond, and the random suffix in the filename carries
 * no time order — sorting by name would put the newest snapshot in a
 * random position. mtime ties (same millisecond) break by filename,
 * newest first.
 * Returns [] when the workspace/history dir is missing or unreadable.
 */
export function listPlanHistoryFiles(workspaceDir: string, projectId: string): string[] {
  const dir = (workspaceDir ?? '').trim();
  if (!dir) return [];
  let names: string[];
  try {
    assertSafePlanId(projectId);
    names = fs.readdirSync(path.resolve(dir, PLAN_HISTORY_DIR));
  } catch {
    return [];
  }
  const historyDir = path.resolve(dir, PLAN_HISTORY_DIR);
  return names
    .filter((n) => PLAN_HISTORY_FILE_NAME.test(n) && n.startsWith(`${projectId}-`))
    .map((n) => ({ name: n, abs: path.join(historyDir, n) }))
    .map(({ name, abs }) => {
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(abs).mtimeMs;
      } catch {
        // Unstatable file sorts last (oldest) instead of breaking the list.
      }
      return { name, abs, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
    .map(({ abs }) => abs);
}

/** One list diff: items only in `cur` (added), only in `prev` (removed), in both (unchanged). */
export interface StringListDiff {
  added: string[];
  removed: string[];
  unchanged: string[];
}

/**
 * Diff two string lists by EXACT match (order-insensitive for
 * membership; `added`/`unchanged` keep `cur` order, `removed` keeps
 * `prev` order). Duplicates are counted once — plan steps are
 * compared as a set of lines, not a multiset.
 */
export function diffStringLists(prev: string[], cur: string[]): StringListDiff {
  const prevSet = new Set(prev);
  const curSet = new Set(cur);
  return {
    added: [...curSet].filter((s) => !prevSet.has(s)),
    removed: [...prevSet].filter((s) => !curSet.has(s)),
    unchanged: [...curSet].filter((s) => prevSet.has(s)),
  };
}

/** Diff of a whole plan version: steps + decisions, each a list diff. */
export interface PlanVersionDiff {
  steps: StringListDiff;
  decisions: StringListDiff;
}

/** Diff a previous plan version against the current one. */
export function diffPlanVersions(
  prev: { steps: string[]; decisions: string[] },
  cur: { steps: string[]; decisions: string[] },
): PlanVersionDiff {
  return {
    steps: diffStringLists(prev.steps, cur.steps),
    decisions: diffStringLists(prev.decisions, cur.decisions),
  };
}

/** Read a plan file back, or null when it does not exist / is unreadable. */
export function readPlanFile(workspaceDir: string, projectId: string): string | null {
  try {
    const dir = (workspaceDir ?? '').trim();
    if (!dir) return null;
    const abs = path.resolve(dir, planFileRelativePath(projectId));
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** Trạng thái quyết định của plan sau khi người dùng duyệt. */
export type PlanFileReviewStatus = 'approved' | 'rejected' | 'changes-requested';

/**
 * Dòng trạng thái tiếng Việt ghi vào file plan cho mỗi quyết định —
 * phải khớp tiền tố mà `planStatusFromText` trong main (desktop)
 * nhận ra khi đọc lại file: 'đã duyệt' / 'đã từ chối' / 'yêu cầu sửa'.
 */
export const PLAN_FILE_STATUS_TEXT: Record<PlanFileReviewStatus, string> = {
  approved: 'đã duyệt',
  rejected: 'đã từ chối',
  'changes-requested': 'yêu cầu sửa',
};

/**
 * Ghi quyết định duyệt vào file plan (v0.18, W10b follow-up): thay dòng
 * `- Trạng thái duyệt: ...` bằng trạng thái mới (thêm dòng đó ngay sau
 * `- Project:` khi file cũ không có). Trả true khi đã ghi, false khi
 * không có file plan / workspaceDir rỗng — caller (plan_update) không
 * được fail lượt duyệt chỉ vì không ghi được file; file là snapshot
 * cho người đọc, source of truth vẫn là approval state trong memory.
 */
export function updatePlanFileStatus(
  workspaceDir: string,
  projectId: string,
  status: PlanFileReviewStatus,
): boolean {
  const current = readPlanFile(workspaceDir, projectId);
  if (current === null) return false;
  const dir = (workspaceDir ?? '').trim();
  const line = `- Trạng thái duyệt: ${PLAN_FILE_STATUS_TEXT[status]}`;
  const lines = current.split(/\r?\n/);
  let replaced = false;
  const next = lines.map((l) => {
    if (/^-\s+Trạng thái duyệt:\s*/.test(l)) {
      replaced = true;
      return line;
    }
    return l;
  });
  if (!replaced) {
    const at = next.findIndex((l) => /^-\s+Project:\s*`[^`]+`\s*$/.test(l));
    if (at === -1) return false;
    next.splice(at + 1, 0, line);
  }
  try {
    fs.writeFileSync(path.resolve(dir, planFileRelativePath(projectId)), next.join('\n'), 'utf8');
    return true;
  } catch {
    return false;
  }
}

export class PlanService {
  constructor(private readonly memory: BotMemory) {}

  /**
   * Create a plan: one project plus one task per step. Returns the project
   * and the created tasks (newest first, as listTasks returns them).
   */
  createPlan(
    botId: string,
    title: string,
    detail = '',
    steps: Array<string | PlanStepInput> = [],
  ): CreatedPlan {
    const projectId = this.memory.createProject(botId, title, detail);
    const taskIds: string[] = [];
    for (const step of normalizeSteps(steps)) {
      const tags = step.tags
        ? `${projectTag(projectId)},${step.tags}`
        : projectTag(projectId);
      taskIds.push(this.memory.createTask(botId, step.title, tags));
    }
    const project = this.memory.getProject(projectId);
    if (!project) throw new Error(`Không tạo được project: ${projectId}`);
    const tasks = taskIds
      .map((id) => this.memory.getTask(id))
      .filter((t): t is TaskItem => t !== null);
    return { projectId, project, taskIds, tasks };
  }

  /**
   * Create a long-running ("grind") plan: same storage shape as
   * createPlan — a project plus its steps as tasks. Long-running only in
   * the sense that the project stays open across many turns; nothing runs
   * in the background here. Use grindRun() to fetch the steps to execute.
   */
  grindPlan(
    botId: string,
    title: string,
    detail = '',
    steps: Array<string | PlanStepInput> = [],
  ): CreatedPlan {
    return this.createPlan(botId, title, detail, steps);
  }

  /**
   * Return the steps of a plan in execution order (oldest first).
   * PLANNING ONLY — this does not execute any step and never loops.
   * The caller executes the steps one by one (e.g. via delegate_task or
   * the normal agent loop) and marks each task done as it finishes.
   */
  grindRun(projectId: string): GrindRun {
    const project = this.memory.getProject(projectId);
    if (!project) throw new Error(`Không thấy project: ${projectId}`);
    const steps = this.memory
      .listTasks(project.botId, { tag: projectTag(projectId) })
      .reverse(); // listTasks is newest-first; execution order is oldest-first
    return { project, steps };
  }

  // -- Pass-throughs (same BotMemory CRUD, one convenient surface) --------

  createGoal(botId: string, title: string, detail = ''): string {
    return this.memory.createGoal(botId, title, detail);
  }

  getGoal(id: string): GoalItem | null {
    return this.memory.getGoal(id);
  }

  listGoals(botId: string, status?: GoalStatus): GoalItem[] {
    return this.memory.listGoals(botId, status);
  }

  updateGoal(id: string, patch: { title?: string; detail?: string; status?: GoalStatus }): void {
    this.memory.updateGoal(id, patch);
  }

  deleteGoal(id: string): void {
    this.memory.deleteGoal(id);
  }

  createTodo(botId: string, title: string): string {
    return this.memory.createTodo(botId, title);
  }

  getTodo(id: string): TodoItem | null {
    return this.memory.getTodo(id);
  }

  listTodos(botId: string, done?: boolean): TodoItem[] {
    return this.memory.listTodos(botId, done);
  }

  updateTodo(id: string, patch: { title?: string; done?: boolean }): void {
    this.memory.updateTodo(id, patch);
  }

  deleteTodo(id: string): void {
    this.memory.deleteTodo(id);
  }

  createProject(botId: string, title: string, detail = ''): string {
    return this.memory.createProject(botId, title, detail);
  }

  getProject(id: string): ProjectItem | null {
    return this.memory.getProject(id);
  }

  listProjects(botId: string, status?: ProjectStatus): ProjectItem[] {
    return this.memory.listProjects(botId, status);
  }

  updateProject(
    id: string,
    patch: {
      title?: string;
      detail?: string;
      status?: ProjectStatus;
      updatesEnabled?: boolean;
      lastUpdateAt?: string | null;
    },
  ): void {
    this.memory.updateProject(id, patch);
  }

  deleteProject(id: string): void {
    this.memory.deleteProject(id);
  }

  createTask(botId: string, title: string, tags = ''): string {
    return this.memory.createTask(botId, title, tags);
  }

  getTask(id: string): TaskItem | null {
    return this.memory.getTask(id);
  }

  listTasks(botId: string, filter: { status?: TaskStatus; tag?: string } = {}): TaskItem[] {
    return this.memory.listTasks(botId, filter);
  }

  updateTaskFields(
    id: string,
    patch: { title?: string; status?: TaskStatus; tags?: string },
  ): void {
    this.memory.updateTaskFields(id, patch);
  }

  setTaskTags(id: string, tags: string): void {
    this.memory.setTaskTags(id, tags);
  }

  deleteTask(id: string): void {
    this.memory.deleteTask(id);
  }
}
