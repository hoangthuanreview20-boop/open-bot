/**
 * Asana connector (v0.73) — Asana API, OAuth 2.0 + client đọc thật.
 *
 * Endpoints theo tài liệu Asana (developers.asana.com, OAuth):
 * authorize `https://app.asana.com/-/oauth_authorize`, token
 * `https://app.asana.com/-/oauth_token`. Scope nối bằng khoảng trắng
 * (chuẩn OAuth2); scope `default` cho toàn quyền, ở đây xin hẹp hơn
 * theo tác vụ task/project để tối thiểu quyền.
 *
 * API đọc (chỉ đọc, không ghi) — `https://app.asana.com/api/1.0`,
 * response bọc trong `{ "data": ... }`:
 *  - `GET /users/me` — user hiện tại (kèm danh sách workspace gid).
 *  - `GET /projects?workspace={gid}` — liệt kê project trong workspace.
 *  - `GET /tasks?project={gid}` — liệt kê task trong project.
 *  - `GET /tasks/{task_gid}` — đọc một task.
 * `opt_fields` chọn trường trả về (name, completed, due_on, assignee).
 *
 * Token lấy qua callback do host cấp (`getToken`, thường đọc Vault
 * namespace `connector`, key `asana`). Token chỉ đi trong header
 * `Authorization: Bearer …`, KHÔNG BAO GIỜ được log. Khi chưa có token,
 * hàm ném lỗi rõ ràng kèm hướng dẫn kết nối.
 *
 * Không có live test với token thật trong repo — test dùng mock fetch.
 */
import type { ConnectorDefinition, ConnectorTokenProvider } from './framework';
import { callWithAutoRefresh, registerConnector } from './framework';

export const ASANA_API_BASE = 'https://app.asana.com/api/1.0';

/** Timeout cho một lần gọi Asana API (30 giây, như các connector khác). */
export const ASANA_API_TIMEOUT_MS = 30_000;

export const ASANA_CONNECTOR: ConnectorDefinition = {
  id: 'asana',
  label: 'Asana',
  authType: 'oauth2',
  scopes: ['projects:read', 'tasks:read', 'tasks:write'],
  authUrl: 'https://app.asana.com/-/oauth_authorize',
  tokenUrl: 'https://app.asana.com/-/oauth_token',
  description:
    'Đọc task/project Asana bằng OAuth token của user. Cần đăng ký OAuth app trong Asana Developer Console trước (chọn scope projects:read, tasks:read, tasks:write).',
};

try {
  registerConnector(ASANA_CONNECTOR);
} catch {
  // Đã đăng ký (module nạp 2 lần trong test) — bỏ qua.
}

export type FetchFn = typeof fetch;

export interface AsanaApiOptions {
  /** OAuth access token Asana của user (callback do host cấp). */
  getToken: () => string | null | Promise<string | null>;
  /**
   * Provider token có auto-refresh (tạo bằng
   * createConnectorTokenProvider). Khi có, mỗi call lấy token qua
   * provider (tự refresh trước 5 phút, dedup; 401 thì force refresh
   * + retry 1 lần cho GET); khi không có, dùng getToken() như cũ.
   */
  tokenProvider?: ConnectorTokenProvider;
  /** Fetch injectable (test dùng mock; mặc định global fetch). */
  fetchFn?: FetchFn;
}

export interface AsanaUser {
  gid: string;
  name?: string;
  email?: string;
  /** Gid các workspace user tham gia. */
  workspaceGids?: string[];
}

export interface AsanaProject {
  gid: string;
  name?: string;
  archived?: boolean;
}

export interface AsanaTask {
  gid: string;
  name?: string;
  completed?: boolean;
  /** Ngày đến hạn (YYYY-MM-DD) hoặc null. */
  dueOn?: string | null;
  /** Tên hiển thị người được giao. */
  assignee?: string;
}

function errorNoToken(): Error {
  return new Error(
    'Chưa kết nối Asana: chưa có OAuth token. ' +
      'Vào Settings → Connectors → Asana để kết nối (OAuth app Asana, scope projects:read + tasks:read), ' +
      'hoặc cấp token qua host getAsanaToken.',
  );
}

function throwAsanaHttpError(status: number, context: string): never {
  if (status === 403) {
    throw new Error(
      `Asana API: không đủ quyền (HTTP 403) cho ${context} — kiểm tra scope projects:read / tasks:read của token và quyền xem project/task.`,
    );
  }
  if (status === 404) {
    throw new Error(
      `Asana API: không tìm thấy (HTTP 404) ${context} — kiểm tra workspace/project/task gid, hoặc đối tượng đã bị xoá.`,
    );
  }
  if (status === 429) {
    throw new Error(
      'Asana API: bị rate limit (HTTP 429) — Asana giới hạn 1500 req/phút; đợi một lúc rồi thử lại.',
    );
  }
  throw new Error(`Asana API returned HTTP ${status} for ${context}.`);
}

async function asanaCall(
  opts: AsanaApiOptions,
  path: string,
): Promise<unknown> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  // Auto-refresh + retry 401 (v0.9): xem callWithAutoRefresh trong
  // framework.ts — GET retry 1 lần sau force refresh.
  const res = await callWithAutoRefresh({
    connectorId: 'asana',
    method: 'GET',
    getToken: opts.getToken,
    tokenProvider: opts.tokenProvider,
    noTokenError: errorNoToken(),
    fetchOnce: async (token) => {
      try {
        return await fetchFn(`${ASANA_API_BASE}${path}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(ASANA_API_TIMEOUT_MS),
        });
      } catch (err) {
        if ((err as Error).name === 'TimeoutError') {
          throw new Error(`Asana API request timed out after ${ASANA_API_TIMEOUT_MS}ms.`);
        }
        throw new Error(`Asana API request failed: ${(err as Error).message}`);
      }
    },
  });
  if (!res.ok) throwAsanaHttpError(res.status, path);
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error('Asana API returned a non-JSON response.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Asana API returned an unexpected response.');
  }
  const rec = parsed as Record<string, unknown>;
  if ('errors' in rec && Array.isArray(rec['errors']) && rec['errors'].length > 0) {
    const first = rec['errors'][0] as Record<string, unknown>;
    const message = typeof first['message'] === 'string' ? first['message'] : 'unknown error';
    throw new Error(`Asana API error: ${message}`);
  }
  // Mọi response Asana đều bọc trong `{ "data": ... }`.
  return rec['data'];
}

function parseDataArray(data: unknown): Record<string, unknown>[] {
  if (!Array.isArray(data)) return [];
  return data.filter(
    (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
  );
}

/** User hiện tại (kèm workspace gid — dùng cho asanaListProjects). */
export async function asanaGetCurrentUser(opts: AsanaApiOptions): Promise<AsanaUser> {
  const data = await asanaCall(opts, '/users/me?opt_fields=name,email,workspaces');
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('Asana API returned an unexpected user response.');
  }
  const rec = data as Record<string, unknown>;
  if (typeof rec['gid'] !== 'string') {
    throw new Error('Asana API returned an unexpected user response.');
  }
  const workspaces = rec['workspaces'];
  return {
    gid: rec['gid'] as string,
    name: typeof rec['name'] === 'string' ? (rec['name'] as string) : undefined,
    email: typeof rec['email'] === 'string' ? (rec['email'] as string) : undefined,
    workspaceGids: Array.isArray(workspaces)
      ? workspaces
          .filter((w): w is Record<string, unknown> => typeof w === 'object' && w !== null)
          .map((w) => w['gid'])
          .filter((gid): gid is string => typeof gid === 'string')
      : undefined,
  };
}

/**
 * Liệt kê project trong một workspace. `workspaceGid` lấy từ
 * asanaGetCurrentUser (workspaceGids).
 */
export async function asanaListProjects(
  opts: AsanaApiOptions,
  workspaceGid: string,
  limit = 10,
): Promise<AsanaProject[]> {
  if (!workspaceGid) throw new Error('Asana workspaceGid is required (lấy qua asanaGetCurrentUser).');
  const capped = Math.min(Math.max(Math.floor(limit), 1), 100);
  const params = new URLSearchParams({
    workspace: workspaceGid,
    limit: String(capped),
    opt_fields: 'name,archived',
  });
  const data = await asanaCall(opts, `/projects?${params.toString()}`);
  return parseDataArray(data)
    .filter((p) => typeof p['gid'] === 'string')
    .map((p) => ({
      gid: p['gid'] as string,
      name: typeof p['name'] === 'string' ? (p['name'] as string) : undefined,
      archived: typeof p['archived'] === 'boolean' ? (p['archived'] as boolean) : undefined,
    }));
}

/** Liệt kê task trong một project. */
export async function asanaListTasks(
  opts: AsanaApiOptions,
  projectGid: string,
  limit = 10,
): Promise<AsanaTask[]> {
  if (!projectGid) throw new Error('Asana projectGid is required (lấy qua asanaListProjects).');
  const capped = Math.min(Math.max(Math.floor(limit), 1), 100);
  const params = new URLSearchParams({
    project: projectGid,
    limit: String(capped),
    opt_fields: 'name,completed,due_on,assignee.name',
  });
  const data = await asanaCall(opts, `/tasks?${params.toString()}`);
  return parseDataArray(data).map((t) => parseTask(t)).filter((t): t is AsanaTask => t !== null);
}

function parseTask(raw: Record<string, unknown>): AsanaTask | null {
  if (typeof raw['gid'] !== 'string') return null;
  const assignee =
    typeof raw['assignee'] === 'object' && raw['assignee'] !== null
      ? ((raw['assignee'] as Record<string, unknown>)['name'] as string | undefined)
      : undefined;
  const dueOn = raw['due_on'];
  return {
    gid: raw['gid'] as string,
    name: typeof raw['name'] === 'string' ? (raw['name'] as string) : undefined,
    completed: typeof raw['completed'] === 'boolean' ? (raw['completed'] as boolean) : undefined,
    dueOn:
      typeof dueOn === 'string' ? dueOn : dueOn === null ? null : undefined,
    assignee: typeof assignee === 'string' ? assignee : undefined,
  };
}

/** Đọc một task theo gid. */
export async function asanaGetTask(
  opts: AsanaApiOptions,
  taskGid: string,
): Promise<AsanaTask> {
  if (!taskGid) throw new Error('Asana taskGid is required.');
  const params = new URLSearchParams({
    opt_fields: 'name,completed,due_on,assignee.name',
  });
  const data = await asanaCall(
    opts,
    `/tasks/${encodeURIComponent(taskGid)}?${params.toString()}`,
  );
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('Asana API returned an unexpected task response.');
  }
  const task = parseTask(data as Record<string, unknown>);
  if (!task) throw new Error('Asana API returned an unexpected task response.');
  return task;
}
