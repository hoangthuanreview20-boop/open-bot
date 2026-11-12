/**
 * Stored plans — plan files from previous sessions (v0.11, W10b).
 *
 * Moved out of main.ts for UI-12 (v0.60) so the reader is unit-testable
 * without Electron: this module imports only node:fs/path +
 * @open-bot/core. main.ts keeps just the thin `plans:list` IPC handler
 * (bot filter + workspace resolution) and calls
 * `listStoredPlansForBots` here.
 *
 * A plan file is `<bot workspace>/.open-bot/plans/<id>.md`, written by
 * plan_create (see renderPlanMarkdown in core). `id` is the same as
 * `projectId` and `path` the same as `filePath` — both spellings are
 * returned so callers can use whichever fits.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PLAN_FILE_DIR, diffPlanVersions, listPlanHistoryFiles } from '@open-bot/core';
import type { PlanVersionDiff } from '@open-bot/core';

export interface StoredPlan {
  id: string;
  projectId: string;
  botId: string;
  title: string;
  detail?: string;
  filePath: string;
  path: string;
  steps: string[];
  decisions: string[];
  status: 'pending' | 'approved' | 'rejected' | 'changes-requested';
  /** ISO timestamp from the file's "Tạo lúc" line (falls back to mtime). */
  createdAt: string;
  /** ISO timestamp of the file's last modification. */
  updatedAt: string;
  /**
   * v0.79b: the previous version of this plan (newest snapshot in
   * `.open-bot/plans/.history/`, written by `writePlanFile` before an
   * overwrite) — steps/decisions the review screen diffs against.
   * Absent when the plan was never rewritten (no previous version).
   */
  previous?: {
    steps: string[];
    decisions: string[];
    /** ISO timestamp of the snapshot file's last modification. */
    updatedAt: string;
  };
  /**
   * v0.79b: diff of this plan against `previous` (computed here with
   * core `diffPlanVersions`, so the renderer only renders it).
   * Absent when there is no previous version.
   */
  diff?: PlanVersionDiff;
}

/** File names under `.open-bot/plans/` — same safe-id rule as plan_create. */
const PLAN_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*\.md$/;

/** Map the Vietnamese status line in a plan file to a review status. */
export function planStatusFromText(text: string): StoredPlan['status'] {
  const t = text.trim().toLowerCase();
  if (t.startsWith('đã duyệt')) return 'approved';
  if (t.startsWith('đã từ chối') || t.startsWith('bị từ chối')) return 'rejected';
  if (t.startsWith('yêu cầu sửa') || t.startsWith('cần sửa')) return 'changes-requested';
  return 'pending';
}

/**
 * Parse one plan Markdown file (format written by renderPlanMarkdown in
 * core). Returns null for a file that is empty or has no plan heading —
 * the caller skips it instead of failing the whole list.
 */
export function parsePlanFile(
  content: string,
  fallbackId: string,
): Omit<StoredPlan, 'botId' | 'filePath' | 'path' | 'updatedAt'> | null {
  if (!content.trim()) return null;
  const lines = content.split(/\r?\n/);
  let title = '';
  let projectId = fallbackId;
  let status: StoredPlan['status'] = 'pending';
  let createdAt = '';
  const sections = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.*)$/);
    if (h1) {
      title = h1[1].replace(/^Kế hoạch:\s*/, '').trim();
      current = null;
      continue;
    }
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) {
      current = h2[1].trim();
      sections.set(current, []);
      continue;
    }
    if (current !== null) sections.get(current)?.push(line);
    const project = line.match(/^-\s+Project:\s+`([^`]+)`\s*$/);
    if (project) projectId = project[1].trim();
    const statusLine = line.match(/^-\s+Trạng thái duyệt:\s*(.+?)\s*$/);
    if (statusLine) status = planStatusFromText(statusLine[1]);
    const createdLine = line.match(/^-\s+Tạo lúc:\s*(.+?)\s*$/);
    if (createdLine) createdAt = createdLine[1].trim();
  }
  if (!title) return null;
  const sectionText = (name: string): string =>
    (sections.get(name) ?? []).join('\n').trim();
  const detailRaw = sectionText('Mô tả');
  const detail = detailRaw === '_Không có mô tả._' ? '' : detailRaw;
  const steps = (sections.get('Các bước') ?? [])
    .map((l) => l.match(/^\d+\.\s+(.+?)\s*$/)?.[1])
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
  const decisions = (sections.get('Lựa chọn cần quyết') ?? [])
    .map((l) => l.match(/^-\s+(.+?)\s*$/)?.[1])
    .filter(
      (s): s is string =>
        typeof s === 'string' &&
        s.length > 0 &&
        !s.startsWith('_Không có lựa chọn'),
    );
  return {
    id: projectId,
    projectId,
    title,
    detail: detail || undefined,
    steps,
    decisions,
    status,
    createdAt: createdAt && !Number.isNaN(Date.parse(createdAt)) ? createdAt : '',
  };
}

/**
 * v0.79b: the previous version of a plan — the newest snapshot in
 * `.open-bot/plans/.history/` (written by `writePlanFile` before an
 * overwrite), parsed the same way as a plan file. Returns undefined
 * when the plan was never rewritten, or when the newest snapshot is
 * missing/corrupt — the diff then simply has nothing to compare
 * against, and the plan itself is unaffected.
 */
export function readPreviousPlan(
  workspaceDir: string,
  projectId: string,
): StoredPlan['previous'] {
  const files = listPlanHistoryFiles(workspaceDir, projectId);
  if (files.length === 0) return undefined;
  try {
    const filePath = files[0];
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return undefined;
    const parsed = parsePlanFile(fs.readFileSync(filePath, 'utf8'), projectId);
    if (!parsed) return undefined;
    return {
      steps: parsed.steps,
      decisions: parsed.decisions,
      updatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return undefined;
  }
}

/**
 * Read every plan file of one bot's workspace. A missing plans directory
 * (or an empty/unresolvable workspace) means "no plans yet"; one
 * unreadable/corrupt file only drops that one entry — never the whole
 * list.
 */
export function listStoredPlans(botId: string, workspaceDir: string): StoredPlan[] {
  if (!workspaceDir) return [];
  const dir = path.join(workspaceDir, PLAN_FILE_DIR);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: StoredPlan[] = [];
  for (const name of names) {
    if (!PLAN_FILE_NAME.test(name)) continue;
    const filePath = path.join(dir, name);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      const parsed = parsePlanFile(fs.readFileSync(filePath, 'utf8'), name.slice(0, -3));
      if (!parsed) continue;
      const mtime = stat.mtime.toISOString();
      // v0.79b: previous version + its diff (computed here, so the
      // renderer only renders). A corrupt snapshot only drops the diff.
      const previous = readPreviousPlan(workspaceDir, parsed.projectId);
      out.push({
        ...parsed,
        botId,
        filePath,
        path: filePath,
        updatedAt: mtime,
        createdAt: parsed.createdAt || mtime,
        previous,
        diff: previous
          ? diffPlanVersions(
              { steps: previous.steps, decisions: previous.decisions },
              { steps: parsed.steps, decisions: parsed.decisions },
            )
          : undefined,
      });
    } catch {
      // One bad file must never break the whole list.
      continue;
    }
  }
  return out;
}

/**
 * Read the stored plans of several bots, newest first (file mtime), so
 * the review screen shows the latest plan on top. A bot whose workspace
 * cannot be read contributes nothing instead of failing the list.
 */
export function listStoredPlansForBots(
  bots: Array<{ id: string; workspaceDir: string }>,
): StoredPlan[] {
  const plans = bots.flatMap((bot) => listStoredPlans(bot.id, bot.workspaceDir));
  // Newest first (file mtime), so the review screen shows the latest
  // plan on top.
  plans.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return plans;
}
