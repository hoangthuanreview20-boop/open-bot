/**
 * Jira connector (v0.73) — Jira Cloud API, OAuth 2.0 (3LO) + client đọc thật.
 *
 * Endpoints theo tài liệu Atlassian (developer.atlassian.com, OAuth 2.0
 * 3LO): authorize `https://auth.atlassian.com/authorize` (cần thêm
 * `audience=api.atlassian.com` + `prompt=consent`), token
 * `https://auth.atlassian.com/oauth/token`.
 *
 * API đọc (chỉ đọc, không ghi):
 *  - `GET /oauth/token/accessible-resources` — liệt kê site Jira Cloud
 *    mà token được cấp (trả về `cloudId` cho mỗi site). Mọi API Jira
 *    đều cần cloudId nên phải gọi hàm này trước, hoặc lấy cloudId từ
 *    Settings → Connectors → Jira (host lưu lại sau lần kết nối).
 *  - `GET /ex/jira/{cloudId}/rest/api/3/search?jql=...` — tìm issue
 *    bằng JQL (vd `project = ENG ORDER BY updated DESC`).
 *  - `GET /ex/jira/{cloudId}/rest/api/3/issue/{issueIdOrKey}` — đọc
 *    một issue theo key (vd `ENG-123`) hoặc id.
 *
 * Token lấy qua callback do host cấp (`getToken`, thường đọc Vault
 * namespace `connector`, key `jira`). Token chỉ đi trong header
 * `Authorization: Bearer …`, KHÔNG BAO GIỜ được log. Khi chưa có token,
 * hàm ném lỗi rõ ràng kèm hướng dẫn kết nối.
 *
 * Chỉ Jira Cloud, không hỗ trợ Jira Server/Data Center (API khác).
 * Không có live test với token thật trong repo — test dùng mock fetch.
 */
import type { ConnectorDefinition, ConnectorTokenProvider } from './framework';
import { callWithAutoRefresh, registerConnector } from './framework';

export const JIRA_API_BASE = 'https://api.atlassian.com';
export const JIRA_ACCESSIBLE_RESOURCES_URL = `${JIRA_API_BASE}/oauth/token/accessible-resources`;

/** Timeout cho một lần gọi Jira API (30 giây, như các connector khác). */
export const JIRA_API_TIMEOUT_MS = 30_000;

export const JIRA_SCOPES: string[] = [
  'read:jira-user',
  'read:jira-work',
  'write:jira-work',
  'offline_access',
];

export const JIRA_CONNECTOR: ConnectorDefinition = {
  id: 'jira',
  label: 'Jira',
  authType: 'oauth2',
  scopes: [...JIRA_SCOPES],
  authUrl: 'https://auth.atlassian.com/authorize',
  tokenUrl: 'https://auth.atlassian.com/oauth/token',
  /**
   * Atlassian yêu cầu thêm `audience=api.atlassian.com` (không có
   * thì token không gọi được Jira API) và `prompt=consent` (để cấp
   * refresh token với scope offline_access).
   */
  buildAuthUrl: (params: import('./framework').AuthorizationUrlParams): string => {
    const url = new URL('https://auth.atlassian.com/authorize');
    url.searchParams.set('audience', 'api.atlassian.com');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', params.clientId);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('state', params.state);
    url.searchParams.set('prompt', 'consent');
    const scopes = params.scopes ?? JIRA_SCOPES;
    if (scopes.length > 0) url.searchParams.set('scope', scopes.join(' '));
    if (params.codeChallenge) {
      url.searchParams.set('code_challenge', params.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  },
  description:
    'Đọc issue Jira Cloud bằng OAuth token của user (3LO). Cần đăng ký OAuth app trong Atlassian Developer Console trước; gọi API cần cloudId của site (lấy qua jiraListAccessibleResources). Chỉ Jira Cloud, không hỗ trợ Jira Server.',
};

try {
  registerConnector(JIRA_CONNECTOR);
} catch {
  // Đã đăng ký (module nạp 2 lần trong test) — bỏ qua.
}

export type FetchFn = typeof fetch;

export interface JiraApiOptions {
  /** OAuth access token Jira của user (callback do host cấp). */
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

/** Một site Jira Cloud mà token được cấp (lấy qua accessible-resources). */
export interface JiraAccessibleResource {
  /** cloudId — dùng trong URL `/ex/jira/{cloudId}/...` cho mọi API Jira. */
  id: string;
  name?: string;
  url?: string;
  scopes?: string[];
}

export interface JiraIssue {
  id: string;
  /** Key hiển thị, vd `ENG-123`. */
  key: string;
  summary?: string;
  /** Tên trạng thái, vd `In Progress`. */
  status?: string;
  /** Tên hiển thị người được giao. */
  assignee?: string;
  updated?: string;
}

function errorNoToken(): Error {
  return new Error(
    'Chưa kết nối Jira: chưa có OAuth token. ' +
      'Vào Settings → Connectors → Jira để kết nối (Jira Cloud OAuth 3LO, scope read:jira-user + read:jira-work + offline_access), ' +
      'hoặc cấp token qua host getJiraToken.',
  );
}

function throwJiraHttpError(status: number, context: string): never {
  if (status === 403) {
    throw new Error(
      `Jira API: không đủ quyền (HTTP 403) cho ${context} — kiểm tra scope read:jira-work của token và quyền xem project/issue.`,
    );
  }
  if (status === 404) {
    throw new Error(
      `Jira API: không tìm thấy (HTTP 404) ${context} — kiểm tra cloudId và key/JQL, hoặc issue đã bị xoá.`,
    );
  }
  if (status === 429) {
    throw new Error(
      `Jira API: bị rate limit (HTTP 429) cho ${context} — đợi một lúc rồi thử lại.`,
    );
  }
  throw new Error(`Jira API returned HTTP ${status} for ${context}.`);
}

async function jiraCall(opts: JiraApiOptions, url: string): Promise<unknown> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  // Auto-refresh + retry 401 (v0.9): xem callWithAutoRefresh trong
  // framework.ts — GET retry 1 lần sau force refresh.
  const res = await callWithAutoRefresh({
    connectorId: 'jira',
    method: 'GET',
    getToken: opts.getToken,
    tokenProvider: opts.tokenProvider,
    noTokenError: errorNoToken(),
    fetchOnce: async (token) => {
      try {
        return await fetchFn(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(JIRA_API_TIMEOUT_MS),
        });
      } catch (err) {
        if ((err as Error).name === 'TimeoutError') {
          throw new Error(`Jira API request timed out after ${JIRA_API_TIMEOUT_MS}ms.`);
        }
        throw new Error(`Jira API request failed: ${(err as Error).message}`);
      }
    },
  });
  if (!res.ok) throwJiraHttpError(res.status, url);
  try {
    return await res.json();
  } catch {
    throw new Error('Jira API returned a non-JSON response.');
  }
}

/** jiraCall cho endpoint trả về object JSON (search / issue). */
async function jiraCallObject(
  opts: JiraApiOptions,
  url: string,
): Promise<Record<string, unknown>> {
  const parsed = await jiraCall(opts, url);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Jira API returned an unexpected response.');
  }
  return parsed as Record<string, unknown>;
}

function parseIssue(raw: unknown): JiraIssue | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec['id'] !== 'string' || typeof rec['key'] !== 'string') return null;
  const fields =
    typeof rec['fields'] === 'object' && rec['fields'] !== null
      ? (rec['fields'] as Record<string, unknown>)
      : {};
  const status =
    typeof fields['status'] === 'object' && fields['status'] !== null
      ? ((fields['status'] as Record<string, unknown>)['name'] as string | undefined)
      : undefined;
  const assignee =
    typeof fields['assignee'] === 'object' && fields['assignee'] !== null
      ? ((fields['assignee'] as Record<string, unknown>)['displayName'] as string | undefined)
      : undefined;
  return {
    id: rec['id'] as string,
    key: rec['key'] as string,
    summary: typeof fields['summary'] === 'string' ? (fields['summary'] as string) : undefined,
    status: typeof status === 'string' ? status : undefined,
    assignee: typeof assignee === 'string' ? assignee : undefined,
    updated: typeof fields['updated'] === 'string' ? (fields['updated'] as string) : undefined,
  };
}

/**
 * Liệt kê site Jira Cloud mà token được cấp — mỗi site có `cloudId`
 * dùng cho mọi API Jira sau này. Gọi hàm này trước khi search/get
 * issue nếu chưa biết cloudId.
 */
export async function jiraListAccessibleResources(
  opts: JiraApiOptions,
): Promise<JiraAccessibleResource[]> {
  // Endpoint này trả về mảng JSON trực tiếp (không bọc trong object).
  const parsed = await jiraCall(opts, JIRA_ACCESSIBLE_RESOURCES_URL);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
    .filter((r) => typeof r['id'] === 'string')
    .map((r) => ({
      id: r['id'] as string,
      name: typeof r['name'] === 'string' ? (r['name'] as string) : undefined,
      url: typeof r['url'] === 'string' ? (r['url'] as string) : undefined,
      scopes: Array.isArray(r['scopes'])
        ? (r['scopes'] as unknown[]).filter((s): s is string => typeof s === 'string')
        : undefined,
    }));
}

/**
 * Tìm issue bằng JQL. `jql` vd `project = ENG ORDER BY updated DESC`.
 * `cloudId` lấy từ jiraListAccessibleResources.
 */
export async function jiraSearchIssues(
  opts: JiraApiOptions,
  cloudId: string,
  jql: string,
  maxResults = 10,
): Promise<JiraIssue[]> {
  if (!cloudId) throw new Error('Jira cloudId is required (lấy qua jiraListAccessibleResources).');
  if (!jql) throw new Error('Jira JQL is required (vd "project = ENG ORDER BY updated DESC").');
  const capped = Math.min(Math.max(Math.floor(maxResults), 1), 100);
  const params = new URLSearchParams({
    jql,
    maxResults: String(capped),
    fields: 'summary,status,assignee,updated',
  });
  const rec = await jiraCallObject(
    opts,
    `${JIRA_API_BASE}/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3/search?${params.toString()}`,
  );
  const issues = rec['issues'];
  if (!Array.isArray(issues)) return [];
  return issues
    .map((issue) => parseIssue(issue))
    .filter((issue): issue is JiraIssue => issue !== null);
}

/** Đọc một issue theo key (vd `ENG-123`) hoặc id. */
export async function jiraGetIssue(
  opts: JiraApiOptions,
  cloudId: string,
  issueKey: string,
): Promise<JiraIssue> {
  if (!cloudId) throw new Error('Jira cloudId is required (lấy qua jiraListAccessibleResources).');
  if (!issueKey) throw new Error('Jira issueKey is required (vd "ENG-123").');
  const rec = await jiraCallObject(
    opts,
    `${JIRA_API_BASE}/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,status,assignee,updated`,
  );
  const issue = parseIssue(rec);
  if (!issue) throw new Error('Jira API returned an unexpected issue response.');
  return issue;
}
