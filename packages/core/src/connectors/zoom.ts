/**
 * Zoom connector (v0.89a, worker F3) — Zoom API, OAuth 2.0 + client
 * đọc thật.
 *
 * Endpoints theo tài liệu Zoom (developers.zoom.us/docs):
 * authorize `https://zoom.us/oauth/authorize`,
 * token `https://zoom.us/oauth/token`.
 * Scope CHỈ ĐỌC (Zoom OAuth scope, chọn lúc tạo OAuth app trong
 * Zoom Marketplace): `user:read` (userinfo /v2/users/me),
 * `meeting:read` (liệt kê meeting). Chưa xin scope ghi nào.
 *
 * API đọc (chỉ đọc, không ghi) — `https://api.zoom.us/v2`:
 *  - `GET /v2/users/me` — user hiện tại.
 *  - `GET /v2/users/me/meetings?type=scheduled` — meeting đã lên
 *    lịch của user (mới nhất trước, phân trang bằng page_number).
 *
 * Token lấy qua callback do host cấp (`getToken`, thường đọc Vault
 * namespace `connector`, key `zoom`). Token chỉ đi trong header
 * `Authorization: Bearer …`, KHÔNG BAO GIỜ được log. Khi chưa có token,
 * hàm ném lỗi rõ ràng kèm hướng dẫn kết nối. Client id/secret KHÔNG
 * hardcode ở đây — host cấp qua Vault/config lúc đăng ký OAuth app.
 *
 * Không có live test với token thật trong repo — test dùng mock fetch.
 */
import type { ConnectorDefinition, ConnectorTokenProvider } from './framework';
import { callWithAutoRefresh, registerConnector } from './framework';

export const ZOOM_API_BASE = 'https://api.zoom.us/v2';

/** Timeout cho một lần gọi Zoom API (30 giây, như các connector khác). */
export const ZOOM_API_TIMEOUT_MS = 30_000;

/** Scope chỉ đọc: user:read + meeting:read. */
export const ZOOM_SCOPES: string[] = ['user:read', 'meeting:read'];

export const ZOOM_CONNECTOR: ConnectorDefinition = {
  id: 'zoom',
  label: 'Zoom',
  authType: 'oauth2',
  scopes: [...ZOOM_SCOPES],
  authUrl: 'https://zoom.us/oauth/authorize',
  tokenUrl: 'https://zoom.us/oauth/token',
  description:
    'Đọc user + liệt kê meeting Zoom bằng OAuth token của user (chỉ đọc: user:read + meeting:read). Cần tạo OAuth app trong Zoom Marketplace trước.',
};

try {
  registerConnector(ZOOM_CONNECTOR);
} catch {
  // Đã đăng ký (module nạp 2 lần trong test) — bỏ qua.
}

export type FetchFn = typeof fetch;

export interface ZoomApiOptions {
  /** OAuth access token Zoom của user (callback do host cấp). */
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

/** User Zoom hiện tại. */
export interface ZoomUser {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  /** Loại tài khoản: 1 = Basic, 2 = Licensed, 3 = On-prem. */
  type?: number;
}

/** Một meeting Zoom đã lên lịch. */
export interface ZoomMeeting {
  id: number;
  uuid?: string;
  topic?: string;
  startTime?: string;
  /** Thời lượng phút. */
  duration?: number;
  joinUrl?: string;
  status?: string;
}

function errorNoToken(): Error {
  return new Error(
    'Chưa kết nối Zoom: chưa có OAuth token. ' +
      'Vào Settings → Connectors → Zoom để kết nối (Zoom OAuth, scope user:read + meeting:read), ' +
      'hoặc cấp token qua host getZoomToken.',
  );
}

function throwZoomHttpError(status: number, context: string): never {
  if (status === 403) {
    throw new Error(
      `Zoom API: không đủ quyền (HTTP 403) cho ${context} — kiểm tra scope meeting:read của token và quyền xem meeting.`,
    );
  }
  if (status === 404) {
    throw new Error(
      `Zoom API: không tìm thấy (HTTP 404) ${context} — kiểm tra user/meeting id, hoặc meeting đã bị xoá.`,
    );
  }
  if (status === 429) {
    throw new Error(
      `Zoom API: bị rate limit (HTTP 429) cho ${context} — đợi một lúc rồi thử lại.`,
    );
  }
  throw new Error(`Zoom API returned HTTP ${status} for ${context}.`);
}

async function zoomCall(opts: ZoomApiOptions, path: string): Promise<unknown> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  // Auto-refresh + retry 401 (v0.9): xem callWithAutoRefresh trong
  // framework.ts — GET retry 1 lần sau force refresh.
  const res = await callWithAutoRefresh({
    connectorId: 'zoom',
    method: 'GET',
    getToken: opts.getToken,
    tokenProvider: opts.tokenProvider,
    noTokenError: errorNoToken(),
    fetchOnce: async (token) => {
      try {
        return await fetchFn(`${ZOOM_API_BASE}${path}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(ZOOM_API_TIMEOUT_MS),
        });
      } catch (err) {
        if ((err as Error).name === 'TimeoutError') {
          throw new Error(`Zoom API request timed out after ${ZOOM_API_TIMEOUT_MS}ms.`);
        }
        throw new Error(`Zoom API request failed: ${(err as Error).message}`);
      }
    },
  });
  if (!res.ok) throwZoomHttpError(res.status, path);
  try {
    return await res.json();
  } catch {
    throw new Error('Zoom API returned a non-JSON response.');
  }
}

/** zoomCall cho endpoint trả về object JSON. */
async function zoomCallObject(
  opts: ZoomApiOptions,
  path: string,
): Promise<Record<string, unknown>> {
  const parsed = await zoomCall(opts, path);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Zoom API returned an unexpected response.');
  }
  return parsed as Record<string, unknown>;
}

/** User hiện tại (`GET /v2/users/me`). */
export async function zoomGetCurrentUser(opts: ZoomApiOptions): Promise<ZoomUser> {
  const rec = await zoomCallObject(opts, '/users/me');
  if (typeof rec['id'] !== 'string') {
    throw new Error('Zoom API returned an unexpected user response.');
  }
  return {
    id: rec['id'] as string,
    firstName: typeof rec['first_name'] === 'string' ? (rec['first_name'] as string) : undefined,
    lastName: typeof rec['last_name'] === 'string' ? (rec['last_name'] as string) : undefined,
    email: typeof rec['email'] === 'string' ? (rec['email'] as string) : undefined,
    type: typeof rec['type'] === 'number' ? (rec['type'] as number) : undefined,
  };
}

/**
 * Liệt kê meeting đã lên lịch của user (`GET /v2/users/me/meetings`,
 * mới nhất trước). `type` mặc định 'scheduled'; truyền 'live' /
 * 'upcoming' để lọc theo trạng thái.
 */
export async function zoomListMeetings(
  opts: ZoomApiOptions,
  maxResults = 10,
  type: 'scheduled' | 'live' | 'upcoming' | 'previous' = 'scheduled',
): Promise<ZoomMeeting[]> {
  const capped = Math.min(Math.max(Math.floor(maxResults), 1), 300);
  const params = new URLSearchParams({
    type,
    page_size: String(capped),
    page_number: '1',
  });
  const rec = await zoomCallObject(opts, `/users/me/meetings?${params.toString()}`);
  const meetings = rec['meetings'];
  if (!Array.isArray(meetings)) return [];
  return meetings
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
    .filter((m) => typeof m['id'] === 'number')
    .map((m) => ({
      id: m['id'] as number,
      uuid: typeof m['uuid'] === 'string' ? (m['uuid'] as string) : undefined,
      topic: typeof m['topic'] === 'string' ? (m['topic'] as string) : undefined,
      startTime: typeof m['start_time'] === 'string' ? (m['start_time'] as string) : undefined,
      duration: typeof m['duration'] === 'number' ? (m['duration'] as number) : undefined,
      joinUrl: typeof m['join_url'] === 'string' ? (m['join_url'] as string) : undefined,
      status: typeof m['status'] === 'string' ? (m['status'] as string) : undefined,
    }));
}
