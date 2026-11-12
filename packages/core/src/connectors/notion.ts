/**
 * Notion connector (v0.89a, worker F3) — Notion API, OAuth 2.0 (public
 * integration) + client đọc thật.
 *
 * Endpoints theo tài liệu Notion (developers.notion.com/docs/authorization):
 * authorize `https://api.notion.com/v1/oauth/authorize` (BẮT BUỘC thêm
 * `owner=user`), token `https://api.notion.com/v1/oauth/token`.
 * LƯU Ý: URL authorize đúng là `api.notion.com/v1/oauth/authorize` —
 * KHÔNG phải `notion.com/oauth/authorize`.
 *
 * Notion KHÔNG có OAuth scope: quyền đọc được quyết định bởi capability
 * của integration (chọn lúc tạo public integration) + trang/database nào
 * user chia sẻ cho integration lúc authorize. `scopes` ở dưới để rỗng
 * là đúng thiết kế của Notion, không phải thiếu sót.
 *
 * Notion cũng KHÔNG hỗ trợ PKCE: authorize endpoint không nhận
 * `code_challenge` — `buildAuthUrl` dưới đây cố tình không gắn PKCE
 * (khác với flow chuẩn của framework).
 *
 * Token endpoint của Notion chính thức yêu cầu HTTP Basic auth
 * (`client_id:client_secret`); bộ đổi code/refresh dùng chung trong
 * framework (`framework.ts` + `mcp/oauth.ts`) gửi `client_secret`
 * trong body form. Đọc API (các hàm dưới đây) không bị ảnh hưởng —
 * chỉ bước đổi code lấy token lúc kết nối cần host dùng Basic auth
 * (hoặc framework cần thêm đường Basic-auth riêng cho Notion).
 * Token Notion trước đây không hết hạn; từ 2026 Notion cấp kèm
 * refresh token khi authorize lại — framework xử lý cả hai trường
 * hợp (không có expiresAt thì dùng tiếp, có thì tự refresh trước
 * 5 phút qua tokenProvider).
 *
 * API đọc (chỉ đọc, không ghi) — mọi request cần header
 * `Notion-Version` (dùng `2022-06-28`, bản ổn định hỗ trợ search +
 * users/me):
 *  - `GET /v1/users/me` — user/bot của token hiện tại.
 *  - `POST /v1/search` — tìm page/database đã chia sẻ cho
 *    integration (POST là thiết kế của Notion API; framework không
 *    retry POST sau 401 — xem ghi chú trong notionCall).
 *
 * Token lấy qua callback do host cấp (`getToken`, thường đọc Vault
 * namespace `connector`, key `notion`). Token chỉ đi trong header
 * `Authorization: Bearer …`, KHÔNG BAO GIỜ được log. Khi chưa có token,
 * hàm ném lỗi rõ ràng kèm hướng dẫn kết nối. Client id/secret KHÔNG
 * hardcode ở đây — host cấp qua Vault/config lúc đăng ký OAuth app.
 *
 * Không có live test với token thật trong repo — test dùng mock fetch.
 */
import type { ConnectorDefinition, ConnectorTokenProvider } from './framework';
import { callWithAutoRefresh, registerConnector } from './framework';

export const NOTION_API_BASE = 'https://api.notion.com/v1';
/** Notion-Version header — bản ổn định, hỗ trợ /v1/search + /v1/users/me. */
export const NOTION_API_VERSION = '2022-06-28';

/** Timeout cho một lần gọi Notion API (30 giây, như các connector khác). */
export const NOTION_API_TIMEOUT_MS = 30_000;

/**
 * Notion không có OAuth scope (quyền nằm ở capability của integration
 * + nội dung user chia sẻ). Giữ mảng rỗng để nói rõ điều này.
 */
export const NOTION_SCOPES: string[] = [];

export const NOTION_CONNECTOR: ConnectorDefinition = {
  id: 'notion',
  label: 'Notion',
  authType: 'oauth2',
  scopes: [...NOTION_SCOPES],
  authUrl: 'https://api.notion.com/v1/oauth/authorize',
  tokenUrl: 'https://api.notion.com/v1/oauth/token',
  /**
   * Notion yêu cầu `owner=user` và KHÔNG chấp nhận PKCE: không gắn
   * `code_challenge`/`code_challenge_method` dù host có truyền
   * codeChallenge (Notion sẽ từ chối authorize request có tham số này).
   */
  buildAuthUrl: (params: import('./framework').AuthorizationUrlParams): string => {
    const url = new URL('https://api.notion.com/v1/oauth/authorize');
    url.searchParams.set('owner', 'user');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', params.clientId);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('state', params.state);
    const scopes = params.scopes ?? NOTION_SCOPES;
    if (scopes.length > 0) url.searchParams.set('scope', scopes.join(' '));
    return url.toString();
  },
  description:
    'Đọc page/database Notion đã chia sẻ cho integration bằng OAuth token của user (chỉ đọc; Notion không có scope — quyền nằm ở capability của integration). Cần tạo public integration tại notion.so/profile/integrations trước; token endpoint của Notion yêu cầu HTTP Basic auth khi đổi code.',
};

try {
  registerConnector(NOTION_CONNECTOR);
} catch {
  // Đã đăng ký (module nạp 2 lần trong test) — bỏ qua.
}

export type FetchFn = typeof fetch;

export interface NotionApiOptions {
  /** OAuth access token Notion của user (callback do host cấp). */
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

/** User (hoặc bot) đứng sau token hiện tại. */
export interface NotionUser {
  id: string;
  /** Tên hiển thị (user) hoặc tên integration (bot). */
  name?: string;
  /** 'person' | 'bot'. */
  type?: string;
  email?: string;
  avatarUrl?: string;
}

/** Một kết quả search: page hoặc database. */
export interface NotionSearchResult {
  object: 'page' | 'database';
  id: string;
  /** Tiêu đề page / tên database (lấy từ properties.title). */
  title?: string;
  url?: string;
  lastEditedTime?: string;
}

function errorNoToken(): Error {
  return new Error(
    'Chưa kết nối Notion: chưa có OAuth token. ' +
      'Vào Settings → Connectors → Notion để kết nối (tạo public integration tại notion.so/profile/integrations, authorize rồi chia sẻ page/database cho integration), ' +
      'hoặc cấp token qua host getNotionToken.',
  );
}

function throwNotionHttpError(status: number, context: string): never {
  if (status === 403) {
    throw new Error(
      `Notion API: không đủ quyền (HTTP 403) cho ${context} — page/database chưa được chia sẻ cho integration, hoặc integration thiếu capability đọc.`,
    );
  }
  if (status === 404) {
    throw new Error(
      `Notion API: không tìm thấy (HTTP 404) ${context} — kiểm tra id, hoặc nội dung đã bị xoá / chưa chia sẻ cho integration.`,
    );
  }
  if (status === 429) {
    throw new Error(
      `Notion API: bị rate limit (HTTP 429) cho ${context} — đợi một lúc rồi thử lại.`,
    );
  }
  throw new Error(`Notion API returned HTTP ${status} for ${context}.`);
}

async function notionCall(
  opts: NotionApiOptions,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  // Auto-refresh + retry 401 (v0.9): xem callWithAutoRefresh trong
  // framework.ts — chỉ GET được retry 1 lần sau force refresh; POST
  // (search) 401 thì ném TokenExpiredError ngay, không retry để tránh
  // gửi trùng.
  const res = await callWithAutoRefresh({
    connectorId: 'notion',
    method,
    getToken: opts.getToken,
    tokenProvider: opts.tokenProvider,
    noTokenError: errorNoToken(),
    fetchOnce: async (token) => {
      try {
        return await fetchFn(`${NOTION_API_BASE}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Notion-Version': NOTION_API_VERSION,
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(NOTION_API_TIMEOUT_MS),
        });
      } catch (err) {
        if ((err as Error).name === 'TimeoutError') {
          throw new Error(`Notion API request timed out after ${NOTION_API_TIMEOUT_MS}ms.`);
        }
        throw new Error(`Notion API request failed: ${(err as Error).message}`);
      }
    },
  });
  if (!res.ok) throwNotionHttpError(res.status, `${method} ${path}`);
  try {
    return await res.json();
  } catch {
    throw new Error('Notion API returned a non-JSON response.');
  }
}

/** notionCall cho endpoint trả về object JSON. */
async function notionCallObject(
  opts: NotionApiOptions,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const parsed = await notionCall(opts, method, path, body);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Notion API returned an unexpected response.');
  }
  return parsed as Record<string, unknown>;
}

function parseUserTitle(titleProp: unknown): string | undefined {
  // Page title: properties.title.title[].plain_text (nối lại).
  if (typeof titleProp !== 'object' || titleProp === null) return undefined;
  const rec = titleProp as Record<string, unknown>;
  const arr = rec['title'];
  if (!Array.isArray(arr)) return undefined;
  const parts = arr
    .map((t) =>
      typeof t === 'object' && t !== null && typeof (t as Record<string, unknown>)['plain_text'] === 'string'
        ? ((t as Record<string, unknown>)['plain_text'] as string)
        : '',
    )
    .join('');
  return parts || undefined;
}

/** User/bot hiện tại của token (`GET /v1/users/me`). */
export async function notionGetCurrentUser(opts: NotionApiOptions): Promise<NotionUser> {
  const rec = await notionCallObject(opts, 'GET', '/users/me');
  if (typeof rec['id'] !== 'string') {
    throw new Error('Notion API returned an unexpected user response.');
  }
  let email: string | undefined;
  const person =
    typeof rec['person'] === 'object' && rec['person'] !== null
      ? (rec['person'] as Record<string, unknown>)
      : undefined;
  if (typeof person?.['email'] === 'string') email = person['email'] as string;
  const bot =
    typeof rec['bot'] === 'object' && rec['bot'] !== null
      ? (rec['bot'] as Record<string, unknown>)
      : undefined;
  const owner =
    typeof bot?.['owner'] === 'object' && bot['owner'] !== null
      ? (bot['owner'] as Record<string, unknown>)
      : undefined;
  const ownerUser =
    typeof owner?.['user'] === 'object' && owner['user'] !== null
      ? (owner['user'] as Record<string, unknown>)
      : undefined;
  if (!email && typeof ownerUser?.['person'] === 'object' && ownerUser['person'] !== null) {
    const ownerPerson = ownerUser['person'] as Record<string, unknown>;
    if (typeof ownerPerson['email'] === 'string') email = ownerPerson['email'] as string;
  }
  return {
    id: rec['id'] as string,
    name: typeof rec['name'] === 'string' ? (rec['name'] as string) : undefined,
    type: typeof rec['type'] === 'string' ? (rec['type'] as string) : undefined,
    email,
    avatarUrl: typeof rec['avatar_url'] === 'string' ? (rec['avatar_url'] as string) : undefined,
  };
}

/**
 * Tìm page/database đã chia sẻ cho integration (`POST /v1/search`).
 * `query` rỗng thì trả về mọi thứ đã chia sẻ (mới sửa trước).
 * Chỉ trả về nội dung user đã chia sẻ cho integration — không phải
 * toàn bộ workspace.
 */
export async function notionSearch(
  opts: NotionApiOptions,
  query = '',
  maxResults = 10,
): Promise<NotionSearchResult[]> {
  const capped = Math.min(Math.max(Math.floor(maxResults), 1), 100);
  const rec = await notionCallObject(opts, 'POST', '/search', {
    query,
    page_size: capped,
    sort: { direction: 'descending', timestamp: 'last_edited_time' },
  });
  const results = rec['results'];
  if (!Array.isArray(results)) return [];
  return results
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
    .filter((r) => (r['object'] === 'page' || r['object'] === 'database') && typeof r['id'] === 'string')
    .map((r) => {
      const props =
        typeof r['properties'] === 'object' && r['properties'] !== null
          ? (r['properties'] as Record<string, unknown>)
          : {};
      return {
        object: r['object'] as 'page' | 'database',
        id: r['id'] as string,
        title: parseUserTitle(props['title']),
        url: typeof r['url'] === 'string' ? (r['url'] as string) : undefined,
        lastEditedTime:
          typeof r['last_edited_time'] === 'string' ? (r['last_edited_time'] as string) : undefined,
      };
    });
}
