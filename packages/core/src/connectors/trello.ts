/**
 * Trello connector (v0.89a, worker F3) — Trello REST API, API key +
 * user token (nhập tay), KHÔNG phải OAuth 1.0a.
 *
 * LỰA CHỌN XÁC THỰC — đọc kỹ trước khi đổi:
 * Trello REST API KHÔNG hỗ trợ OAuth 2.0. Cách ủy quyền theo từng
 * user là OAuth 1.0a (HMAC-SHA1 ký từng request, qua 3 endpoint
 * `1/OAuthGetRequestToken`, `1/OAuthAuthorizeToken`,
 * `1/OAuthGetAccessToken` + application secret). Triển khai OAuth 1.0a
 * đúng chuẩn cần thêm bộ ký HMAC-SHA1 + quản lý request token — nặng
 * và không khớp framework OAuth2 dùng chung của repo (framework chỉ
 * biết authorization_code / refresh_token). Vì vậy connector này
 * KHÔNG giả vờ làm OAuth 1.0a.
 *
 * Thay vào đó dùng cách thủ công mà chính tài liệu Trello ghi nhận
 * (developer.atlassian.com/cloud/trello/guides/rest-api/authorization):
 *  1. User tạo Power-Up, lấy API key tại trello.com/power-ups/admin
 *     (tab Trello Auth → Generate a new API Key).
 *  2. Mở URL do `buildTrelloAuthorizeUrl(apiKey)` tạo
 *     (`https://trello.com/1/authorize?expiration=30days&scope=read&
 *     response_type=token&key=…`), bấm Allow, copy token hiện ra.
 *  3. Nhập API key + token vào Settings → Connectors → Trello (lưu
 *     vào Vault, namespace `connector`, key `trello` — token lưu
 *     dạng JSON `{ apiKey, accessToken }`, xem `TrelloStoredCredential`).
 * Token này có hạn 30 ngày (expiration chọn lúc authorize) và scope
 * chỉ đọc (`scope=read`); hết hạn thì user tạo lại theo 3 bước trên.
 * Khi nào cần OAuth 1.0a thật (nhiều user, token tự refresh) thì làm
 * module ký HMAC-SHA1 riêng — không nhét vào file này.
 *
 * API đọc (chỉ đọc, không ghi) — `https://api.trello.com/1`, auth
 * bằng query `?key=<apiKey>&token=<token>` (đây là cách Trello thiết
 * kế; KHÔNG BAO GIỜ log URL request vì URL chứa token):
 *  - `GET /members/me` — user hiện tại.
 *  - `GET /members/me/boards` — board đang mở của user.
 *  - `GET /boards/{boardId}/lists` — list trong 1 board.
 *
 * Token không tự refresh được (không có refresh token trong mô hình
 * này): 401 nghĩa là key/token sai hoặc hết hạn → báo user tạo token
 * mới, không retry vô ích. Rate limit Trello: 300 req/10s/key,
 * 100 req/10s/token (HTTP 429).
 *
 * Không có live test với token thật trong repo — test dùng mock fetch.
 */
import type { ConnectorDefinition } from './framework';
import { callWithAutoRefresh, isTokenExpiredError, isTokenRevokedError, registerConnector } from './framework';

export const TRELLO_API_BASE = 'https://api.trello.com/1';
export const TRELLO_AUTHORIZE_URL = 'https://trello.com/1/authorize';

/** Timeout cho một lần gọi Trello API (30 giây, như các connector khác). */
export const TRELLO_API_TIMEOUT_MS = 30_000;

/**
 * Trello không có OAuth scope (token scope `read` được chọn lúc
 * authorize qua URL, không phải lúc đăng ký connector).
 */
export const TRELLO_SCOPES: string[] = [];

export const TRELLO_CONNECTOR: ConnectorDefinition = {
  id: 'trello',
  label: 'Trello',
  authType: 'apiKey',
  scopes: [...TRELLO_SCOPES],
  description:
    'Đọc board/list Trello bằng API key + user token nhập tay (chỉ đọc, scope read, token hạn 30 ngày). Trello REST không có OAuth 2.0; OAuth 1.0a chưa triển khai (cần ký HMAC-SHA1) — xem ghi chú đầu file. Lấy key tại trello.com/power-ups/admin, lấy token qua buildTrelloAuthorizeUrl.',
};

try {
  registerConnector(TRELLO_CONNECTOR);
} catch {
  // Đã đăng ký (module nạp 2 lần trong test) — bỏ qua.
}

export type FetchFn = typeof fetch;

/**
 * Credential Trello lưu trong Vault (namespace `connector`, key
 * `trello`): API key (định danh app, không bí mật bằng token) +
 * user token (bí mật — cấp quyền đọc tài khoản, KHÔNG log).
 */
export interface TrelloStoredCredential {
  apiKey: string;
  accessToken: string;
}

export interface TrelloApiOptions {
  /** API key Trello của user (callback do host cấp, đọc từ Vault). */
  getApiKey: () => string | null | Promise<string | null>;
  /** User token Trello của user (callback do host cấp, đọc từ Vault). */
  getToken: () => string | null | Promise<string | null>;
  /** Fetch injectable (test dùng mock; mặc định global fetch). */
  fetchFn?: FetchFn;
}

/** User Trello hiện tại. */
export interface TrelloMember {
  id: string;
  username?: string;
  fullName?: string;
  /** Email chỉ trả về khi token có quyền (thường vắng). */
  email?: string;
}

/** Một board Trello đang mở. */
export interface TrelloBoard {
  id: string;
  name?: string;
  url?: string;
  shortUrl?: string;
  closed?: boolean;
}

/** Một list trong board. */
export interface TrelloList {
  id: string;
  name?: string;
  closed?: boolean;
}

/**
 * URL xin token Trello cho user mở trong trình duyệt: user bấm Allow
 * rồi copy token hiện ra, nhập vào Settings → Connectors → Trello.
 * `expiration` mặc định '30days' (token hết hạn thì tạo lại);
 * `scope` cố định 'read' (chỉ đọc).
 */
export function buildTrelloAuthorizeUrl(
  apiKey: string,
  opts: { expiration?: '1hour' | '1day' | '30days' | 'never'; name?: string } = {},
): string {
  if (!apiKey) throw new Error('Trello API key is required to build the authorize URL.');
  const url = new URL(TRELLO_AUTHORIZE_URL);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('name', opts.name ?? 'open-bot');
  url.searchParams.set('expiration', opts.expiration ?? '30days');
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('scope', 'read');
  return url.toString();
}

function errorNoCredentials(): Error {
  return new Error(
    'Chưa kết nối Trello: chưa có API key / user token. ' +
      'Vào Settings → Connectors → Trello: lấy API key tại trello.com/power-ups/admin (tab Trello Auth), ' +
      'mở URL authorize để lấy token (scope read, hạn 30 ngày), rồi nhập cả hai vào Settings.',
  );
}

function throwTrelloHttpError(status: number, context: string): never {
  if (status === 401) {
    throw new Error(
      `Trello API: API key/token không còn hợp lệ (HTTP 401) cho ${context} — ` +
        'token có thể đã hết hạn (mặc định 30 ngày): tạo token mới qua URL authorize rồi nhập lại trong Settings → Connectors → Trello.',
    );
  }
  if (status === 403) {
    throw new Error(
      `Trello API: không đủ quyền (HTTP 403) cho ${context} — kiểm tra token có scope read và user có quyền xem board.`,
    );
  }
  if (status === 404) {
    throw new Error(
      `Trello API: không tìm thấy (HTTP 404) ${context} — kiểm tra board id, hoặc board đã bị xoá / user không có quyền xem.`,
    );
  }
  if (status === 429) {
    throw new Error(
      `Trello API: bị rate limit (HTTP 429) cho ${context} — đợi một lúc rồi thử lại.`,
    );
  }
  throw new Error(`Trello API returned HTTP ${status} for ${context}.`);
}

async function trelloCall(opts: TrelloApiOptions, path: string): Promise<unknown> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const apiKey = await opts.getApiKey();
  if (!apiKey) throw errorNoCredentials();
  // Không có tokenProvider cho Trello (key+token không refresh được):
  // 401 -> framework ném TokenExpiredError (token mới = token cũ,
  // không retry vô ích) -> đổi thành thông báo Trello cụ thể.
  let res: Awaited<ReturnType<typeof fetchFn>>;
  try {
    res = await callWithAutoRefresh({
      connectorId: 'trello',
      method: 'GET',
      getToken: async () => {
        const token = await opts.getToken();
        if (!token) throw errorNoCredentials();
        return token;
      },
      noTokenError: errorNoCredentials(),
      fetchOnce: async (token) => {
        // Auth Trello nằm trong query (?key&token) theo thiết kế API
        // của Trello — KHÔNG log URL này (chứa token).
        const url = `${TRELLO_API_BASE}${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}`;
        try {
          return await fetchFn(url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(TRELLO_API_TIMEOUT_MS),
          });
        } catch (err) {
          if ((err as Error).name === 'TimeoutError') {
            throw new Error(`Trello API request timed out after ${TRELLO_API_TIMEOUT_MS}ms.`);
          }
          throw new Error(`Trello API request failed: ${(err as Error).message}`);
        }
      },
    });
  } catch (err) {
    if (isTokenExpiredError(err) || isTokenRevokedError(err)) {
      throw new Error(
        'Trello: API key/token không còn hợp lệ (token hết hạn hoặc bị thu hồi) — ' +
          'tạo token mới qua URL authorize rồi nhập lại trong Settings → Connectors → Trello.',
      );
    }
    throw err;
  }
  if (!res.ok) throwTrelloHttpError(res.status, path);
  try {
    return await res.json();
  } catch {
    throw new Error('Trello API returned a non-JSON response.');
  }
}

/** trelloCall cho endpoint trả về object JSON. */
async function trelloCallObject(
  opts: TrelloApiOptions,
  path: string,
): Promise<Record<string, unknown>> {
  const parsed = await trelloCall(opts, path);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Trello API returned an unexpected response.');
  }
  return parsed as Record<string, unknown>;
}

/** User hiện tại (`GET /members/me`). */
export async function trelloGetCurrentUser(opts: TrelloApiOptions): Promise<TrelloMember> {
  const rec = await trelloCallObject(opts, '/members/me?fields=id,username,fullName,email');
  if (typeof rec['id'] !== 'string') {
    throw new Error('Trello API returned an unexpected user response.');
  }
  return {
    id: rec['id'] as string,
    username: typeof rec['username'] === 'string' ? (rec['username'] as string) : undefined,
    fullName: typeof rec['fullName'] === 'string' ? (rec['fullName'] as string) : undefined,
    email: typeof rec['email'] === 'string' ? (rec['email'] as string) : undefined,
  };
}

/** Board đang mở của user (`GET /members/me/boards?filter=open`). */
export async function trelloListBoards(opts: TrelloApiOptions): Promise<TrelloBoard[]> {
  const parsed = await trelloCall(
    opts,
    '/members/me/boards?filter=open&fields=id,name,url,shortUrl,closed',
  );
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
    .filter((b) => typeof b['id'] === 'string')
    .map((b) => ({
      id: b['id'] as string,
      name: typeof b['name'] === 'string' ? (b['name'] as string) : undefined,
      url: typeof b['url'] === 'string' ? (b['url'] as string) : undefined,
      shortUrl: typeof b['shortUrl'] === 'string' ? (b['shortUrl'] as string) : undefined,
      closed: typeof b['closed'] === 'boolean' ? (b['closed'] as boolean) : undefined,
    }));
}

/** List trong 1 board (`GET /boards/{boardId}/lists`). */
export async function trelloListLists(
  opts: TrelloApiOptions,
  boardId: string,
): Promise<TrelloList[]> {
  if (!boardId) throw new Error('Trello boardId is required.');
  const parsed = await trelloCall(
    opts,
    `/boards/${encodeURIComponent(boardId)}/lists?fields=id,name,closed`,
  );
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((l): l is Record<string, unknown> => typeof l === 'object' && l !== null)
    .filter((l) => typeof l['id'] === 'string')
    .map((l) => ({
      id: l['id'] as string,
      name: typeof l['name'] === 'string' ? (l['name'] as string) : undefined,
      closed: typeof l['closed'] === 'boolean' ? (l['closed'] as boolean) : undefined,
    }));
}
