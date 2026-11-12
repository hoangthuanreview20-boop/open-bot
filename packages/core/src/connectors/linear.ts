/**
 * Linear connector (v0.73) — Linear API, OAuth 2.0 + client đọc thật (GraphQL).
 *
 * Endpoints theo tài liệu Linear (linear.app/developers, OAuth 2.0
 * authentication): authorize `https://linear.app/oauth/authorize`,
 * token `https://api.linear.app/oauth/token`. Lưu ý riêng của Linear:
 * scope nối bằng DẤU PHẨY (`read,write`), không phải khoảng trắng
 * như OAuth2 thông thường — buildAuthUrl riêng dưới đây xử lý việc
 * này (framework mặc định nối bằng khoảng trắng nên không dùng được).
 *
 * API đọc (chỉ đọc, không ghi) — GraphQL `POST https://api.linear.app/graphql`:
 *  - `linearListIssues` — `issues(first: N)` liệt kê issue mới nhất.
 *  - `linearGetIssue` — tìm issue theo identifier (vd `ENG-123`) qua
 *    `issues(filter: { identifier: { eq: ... } })`, vì field `issue(id:)`
 *    của Linear chỉ nhận UUID nội bộ, không nhận identifier hiển thị.
 * Lỗi GraphQL trả về trong mảng `errors` (kèm HTTP 200) nên client
 * kiểm tra `errors` riêng, không chỉ HTTP status.
 *
 * Token lấy qua callback do host cấp (`getToken`, thường đọc Vault
 * namespace `connector`, key `linear`). Token chỉ đi trong header
 * `Authorization: Bearer …`, KHÔNG BAO GIỜ được log. Khi chưa có token,
 * hàm ném lỗi rõ ràng kèm hướng dẫn kết nối.
 *
 * Không có live test với token thật trong repo — test dùng mock fetch.
 */
import type { ConnectorDefinition, ConnectorTokenProvider } from './framework';
import { callWithAutoRefresh, registerConnector } from './framework';

export const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

/** Timeout cho một lần gọi Linear API (30 giây, như các connector khác). */
export const LINEAR_API_TIMEOUT_MS = 30_000;

export const LINEAR_SCOPES: string[] = ['read', 'write'];

export const LINEAR_CONNECTOR: ConnectorDefinition = {
  id: 'linear',
  label: 'Linear',
  authType: 'oauth2',
  scopes: [...LINEAR_SCOPES],
  authUrl: 'https://linear.app/oauth/authorize',
  tokenUrl: 'https://api.linear.app/oauth/token',
  /**
   * Linear yêu cầu scope nối bằng dấu phẩy (vd `read,write`) —
   * framework mặc định nối bằng khoảng trắng nên phải build tay.
   */
  buildAuthUrl: (params: import('./framework').AuthorizationUrlParams): string => {
    const url = new URL('https://linear.app/oauth/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', params.clientId);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('state', params.state);
    const scopes = params.scopes ?? LINEAR_SCOPES;
    if (scopes.length > 0) url.searchParams.set('scope', scopes.join(','));
    if (params.codeChallenge) {
      url.searchParams.set('code_challenge', params.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  },
  description:
    'Đọc issue Linear bằng OAuth token của user (GraphQL). Cần tạo OAuth application trong Linear (Settings → Account → API → OAuth applications). API Linear là GraphQL tại api.linear.app/graphql.',
};

try {
  registerConnector(LINEAR_CONNECTOR);
} catch {
  // Đã đăng ký (module nạp 2 lần trong test) — bỏ qua.
}

export type FetchFn = typeof fetch;

export interface LinearApiOptions {
  /** OAuth access token Linear của user (callback do host cấp). */
  getToken: () => string | null | Promise<string | null>;
  /**
   * Provider token có auto-refresh (tạo bằng
   * createConnectorTokenProvider). Khi có, mỗi call lấy token qua
   * provider (tự refresh trước 5 phút, dedup); khi không có, dùng
   * getToken() như cũ. GraphQL là POST nên framework KHÔNG retry sau
   * 401 (tránh gửi trùng) — 401 ném TokenExpiredError để caller báo
   * user thử lại; provider tự refresh trước hạn nên hiếm gặp.
   */
  tokenProvider?: ConnectorTokenProvider;
  /** Fetch injectable (test dùng mock; mặc định global fetch). */
  fetchFn?: FetchFn;
}

export interface LinearIssue {
  id: string;
  /** Identifier hiển thị, vd `ENG-123`. */
  identifier: string;
  title?: string;
  /** Tên trạng thái, vd `In Progress`. */
  state?: string;
  /** Tên hiển thị người được giao. */
  assignee?: string;
  createdAt?: string;
}

function errorNoToken(): Error {
  return new Error(
    'Chưa kết nối Linear: chưa có OAuth token. ' +
      'Vào Settings → Connectors → Linear để kết nối (OAuth app Linear, scope read), ' +
      'hoặc cấp token qua host getLinearToken.',
  );
}

function throwLinearHttpError(status: number): never {
  if (status === 403) {
    throw new Error(
      'Linear API: không đủ quyền (HTTP 403) — kiểm tra scope read của token và quyền xem workspace.',
    );
  }
  if (status === 404) {
    throw new Error('Linear API: endpoint không tìm thấy (HTTP 404) — kiểm tra URL GraphQL.');
  }
  if (status === 429) {
    throw new Error('Linear API: bị rate limit (HTTP 429) — đợi một lúc rồi thử lại.');
  }
  throw new Error(`Linear API returned HTTP ${status}.`);
}

/**
 * Một lần gọi GraphQL (POST). Trả về `data` đã parse; ném lỗi khi
 * HTTP lỗi hoặc khi body có mảng `errors` (Linear trả lỗi GraphQL
 * kèm HTTP 200).
 */
async function linearGraphql(
  opts: LinearApiOptions,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const res = await callWithAutoRefresh({
    connectorId: 'linear',
    method: 'POST',
    getToken: opts.getToken,
    tokenProvider: opts.tokenProvider,
    noTokenError: errorNoToken(),
    fetchOnce: async (token) => {
      try {
        return await fetchFn(LINEAR_GRAPHQL_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(LINEAR_API_TIMEOUT_MS),
        });
      } catch (err) {
        if ((err as Error).name === 'TimeoutError') {
          throw new Error(`Linear API request timed out after ${LINEAR_API_TIMEOUT_MS}ms.`);
        }
        throw new Error(`Linear API request failed: ${(err as Error).message}`);
      }
    },
  });
  if (!res.ok) throwLinearHttpError(res.status);
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error('Linear API returned a non-JSON response.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Linear API returned an unexpected response.');
  }
  const rec = parsed as Record<string, unknown>;
  if (Array.isArray(rec['errors']) && rec['errors'].length > 0) {
    const first = rec['errors'][0] as Record<string, unknown>;
    const message = typeof first['message'] === 'string' ? first['message'] : 'unknown error';
    throw new Error(`Linear GraphQL error: ${message}`);
  }
  const data = rec['data'];
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('Linear API returned an unexpected response (missing data).');
  }
  return data as Record<string, unknown>;
}

function parseIssue(raw: unknown): LinearIssue | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec['id'] !== 'string' || typeof rec['identifier'] !== 'string') return null;
  const state =
    typeof rec['state'] === 'object' && rec['state'] !== null
      ? ((rec['state'] as Record<string, unknown>)['name'] as string | undefined)
      : undefined;
  const assignee =
    typeof rec['assignee'] === 'object' && rec['assignee'] !== null
      ? ((rec['assignee'] as Record<string, unknown>)['name'] as string | undefined)
      : undefined;
  return {
    id: rec['id'] as string,
    identifier: rec['identifier'] as string,
    title: typeof rec['title'] === 'string' ? (rec['title'] as string) : undefined,
    state: typeof state === 'string' ? state : undefined,
    assignee: typeof assignee === 'string' ? assignee : undefined,
    createdAt: typeof rec['createdAt'] === 'string' ? (rec['createdAt'] as string) : undefined,
  };
}

const ISSUE_FIELDS = 'id identifier title state { name } assignee { name } createdAt';

/** Liệt kê issue mới nhất (mặc định 10, tối đa 50). */
export async function linearListIssues(
  opts: LinearApiOptions,
  first = 10,
): Promise<LinearIssue[]> {
  const capped = Math.min(Math.max(Math.floor(first), 1), 50);
  const data = await linearGraphql(
    opts,
    `query ListIssues($first: Int!) { issues(first: $first) { nodes { ${ISSUE_FIELDS} } } }`,
    { first: capped },
  );
  const issues = data['issues'] as Record<string, unknown> | undefined;
  const nodes = issues?.['nodes'];
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((node) => parseIssue(node))
    .filter((issue): issue is LinearIssue => issue !== null);
}

/**
 * Đọc một issue theo identifier hiển thị (vd `ENG-123`). Linear không
 * có query trực tiếp theo identifier nên dùng filter `identifier.eq`.
 */
export async function linearGetIssue(
  opts: LinearApiOptions,
  identifier: string,
): Promise<LinearIssue> {
  if (!identifier) throw new Error('Linear identifier is required (vd "ENG-123").');
  const data = await linearGraphql(
    opts,
    `query GetIssue($identifier: String!) { issues(filter: { identifier: { eq: $identifier } }, first: 1) { nodes { ${ISSUE_FIELDS} } } }`,
    { identifier },
  );
  const issues = data['issues'] as Record<string, unknown> | undefined;
  const nodes = issues?.['nodes'];
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error(`Linear issue "${identifier}" not found.`);
  }
  const issue = parseIssue(nodes[0]);
  if (!issue) throw new Error('Linear API returned an unexpected issue response.');
  return issue;
}
