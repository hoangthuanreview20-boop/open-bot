/**
 * ClickUp read client (worker F2, v0.89b, stretch) — ClickUp API v2, chỉ đọc.
 *
 * Wire shape theo tài liệu chính thức ClickUp API
 * (developer.clickup.com/reference):
 *  - `GET /api/v2/list/{list_id}/task` → `{ tasks: [{ id, name,
 *    status: { status }, url, date_created, assignees }] }`.
 *  - `GET /api/v2/task/{task_id}` → `{ id, name, status: { status },
 *    description, url, date_created }` (task object trực tiếp, không bọc).
 *  - Auth: header `Authorization: <API token>` — token thô, KHÔNG có
 *    tiền tố `Bearer` (theo đúng thiết kế ClickUp API).
 *
 * Token chỉ đi trong header Authorization, KHÔNG BAO GIỜ được log.
 *
 * Không có live test với token thật trong repo — test dùng mock fetch
 * (mock-verified, chưa đối chiếu live).
 */
import {
  arrayField,
  callJsonObject,
  isRecord,
  requireNonEmpty,
  strField,
  type ReadClientOptions,
} from './common';

export const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';

export type ClickUpApiOptions = ReadClientOptions;

export interface ClickUpTask {
  id: string;
  name?: string;
  status?: string;
  description?: string;
  url?: string;
  dateCreated?: string;
}

function clickupHeaders(opts: ClickUpApiOptions): Record<string, string> {
  // ClickUp dùng token thô trong header Authorization (không có 'Bearer ').
  return {
    Authorization: opts.token,
    Accept: 'application/json',
  };
}

function parseTask(raw: unknown): ClickUpTask | null {
  if (!isRecord(raw) || typeof raw['id'] !== 'string') return null;
  const status = isRecord(raw['status']) ? raw['status'] : undefined;
  return {
    id: raw['id'] as string,
    name: strField(raw, 'name'),
    status: status ? strField(status, 'status') : undefined,
    description: strField(raw, 'description'),
    url: strField(raw, 'url'),
    dateCreated: strField(raw, 'date_created'),
  };
}

/** Liệt kê tasks của một list. */
export async function clickupListTasks(
  opts: ClickUpApiOptions,
  listId: string,
): Promise<ClickUpTask[]> {
  requireNonEmpty(listId, 'ClickUp listId');
  const rec = await callJsonObject(
    'ClickUp',
    opts,
    `${CLICKUP_API_BASE}/list/${encodeURIComponent(listId)}/task`,
    'clickupListTasks',
    { method: 'GET', headers: clickupHeaders(opts) },
  );
  return arrayField(rec, 'tasks')
    .map((t) => parseTask(t))
    .filter((t): t is ClickUpTask => t !== null);
}

/** Đọc một task theo id. */
export async function clickupGetTask(
  opts: ClickUpApiOptions,
  taskId: string,
): Promise<ClickUpTask> {
  requireNonEmpty(taskId, 'ClickUp taskId');
  const rec = await callJsonObject(
    'ClickUp',
    opts,
    `${CLICKUP_API_BASE}/task/${encodeURIComponent(taskId)}`,
    'clickupGetTask',
    { method: 'GET', headers: clickupHeaders(opts) },
  );
  const task = parseTask(rec);
  if (!task) throw new Error('ClickUp API returned an unexpected task response (clickupGetTask).');
  return task;
}
