/**
 * Outlook connector (v0.89a, worker F3) — Microsoft Graph (Outlook mail
 * + OneDrive file, chỉ đọc) qua OAuth 2.0.
 *
 * Cùng endpoints Microsoft OAuth với connector 'teams'
 * (packages/core/src/connectors/teams.ts) và login provider
 * 'microsoft' (packages/core/src/auth/oauth.ts): authorize
 * `https://login.microsoftonline.com/common/oauth2/v2.0/authorize`,
 * token `https://login.microsoftonline.com/common/oauth2/v2.0/token`.
 * Login Microsoft có thể cấp token cho connector này qua
 * `connectorScopes.outlook` trong OAUTH_PROVIDERS (xem oauth.ts) —
 * cùng pattern với `connectorScopes.gmail` của Google.
 *
 * Scope CHỈ ĐỌC (Microsoft Graph, cần admin consent tuỳ tenant):
 * `Mail.Read` (đọc mail — hàm dưới đây), `Files.Read` (đọc file
 * OneDrive — hàm đọc file chưa có trong đợt này, scope xin trước để
 * khỏi xin lại quyền sau), `User.Read` (userinfo /me),
 * `offline_access` (để Microsoft trả refresh token).
 *
 * API đọc (chỉ đọc, không ghi) — Microsoft Graph v1.0:
 *  - `GET /v1.0/me` — user hiện tại.
 *  - `GET /v1.0/me/messages` — mail trong hộp thư (mới nhất trước).
 *
 * Token lấy qua callback do host cấp (`getToken`, thường đọc Vault
 * namespace `connector`, key `outlook`). Token chỉ đi trong header
 * `Authorization: Bearer …`, KHÔNG BAO GIỜ được log. Khi chưa có token,
 * hàm ném lỗi rõ ràng kèm hướng dẫn kết nối. Client id/secret KHÔNG
 * hardcode ở đây — host cấp qua Vault/config lúc đăng ký app Entra.
 *
 * Không có live test với token thật trong repo — test dùng mock fetch.
 */
import type { ConnectorDefinition, ConnectorTokenProvider } from './framework';
import { callWithAutoRefresh, registerConnector } from './framework';

export const OUTLOOK_API_BASE = 'https://graph.microsoft.com/v1.0';

/** Timeout cho một lần gọi Graph API (30 giây, như các connector khác). */
export const OUTLOOK_API_TIMEOUT_MS = 30_000;

/** Scope chỉ đọc (Mail.Read + Files.Read theo yêu cầu + User.Read + offline_access). */
export const OUTLOOK_SCOPES: string[] = [
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Files.Read',
  'https://graph.microsoft.com/User.Read',
  'offline_access',
];

export const OUTLOOK_CONNECTOR: ConnectorDefinition = {
  id: 'outlook',
  label: 'Outlook',
  authType: 'oauth2',
  scopes: [...OUTLOOK_SCOPES],
  authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  description:
    'Đọc mail Outlook + file OneDrive bằng OAuth token Microsoft của user (chỉ đọc: Mail.Read + Files.Read + User.Read). Dùng chung login Microsoft với connector Teams; cần đăng ký app trong Microsoft Entra admin center trước.',
};

try {
  registerConnector(OUTLOOK_CONNECTOR);
} catch {
  // Đã đăng ký (module nạp 2 lần trong test) — bỏ qua.
}

export type FetchFn = typeof fetch;

export interface OutlookApiOptions {
  /** OAuth access token Microsoft của user (callback do host cấp). */
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

/** User Microsoft hiện tại (Graph /me). */
export interface OutlookUser {
  id: string;
  displayName?: string;
  /** Email chính (mail, fallback userPrincipalName). */
  email?: string;
}

/** Một mail Outlook (chỉ field đọc). */
export interface OutlookMessage {
  id: string;
  subject?: string;
  /** Tên + địa chỉ người gửi. */
  from?: string;
  fromEmail?: string;
  receivedDateTime?: string;
  isRead?: boolean;
  /** Đoạn trích nội dung (bodyPreview). */
  bodyPreview?: string;
}

function errorNoToken(): Error {
  return new Error(
    'Chưa kết nối Outlook: chưa có OAuth token. ' +
      'Vào Settings → Connectors → Outlook để kết nối (đăng nhập Microsoft, scope Mail.Read + Files.Read + User.Read), ' +
      'hoặc cấp token qua host getOutlookToken.',
  );
}

function throwOutlookHttpError(status: number, context: string): never {
  if (status === 403) {
    throw new Error(
      `Outlook API: không đủ quyền (HTTP 403) cho ${context} — kiểm tra scope Mail.Read của token, quyền hộp thư, hoặc admin consent của tenant.`,
    );
  }
  if (status === 404) {
    throw new Error(
      `Outlook API: không tìm thấy (HTTP 404) ${context} — kiểm tra mail id, hoặc mail đã bị xoá.`,
    );
  }
  if (status === 429) {
    throw new Error(
      `Outlook API: bị rate limit (HTTP 429) cho ${context} — đợi một lúc rồi thử lại.`,
    );
  }
  throw new Error(`Outlook API returned HTTP ${status} for ${context}.`);
}

async function outlookCall(opts: OutlookApiOptions, path: string): Promise<unknown> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  // Auto-refresh + retry 401 (v0.9): xem callWithAutoRefresh trong
  // framework.ts — GET retry 1 lần sau force refresh.
  const res = await callWithAutoRefresh({
    connectorId: 'outlook',
    method: 'GET',
    getToken: opts.getToken,
    tokenProvider: opts.tokenProvider,
    noTokenError: errorNoToken(),
    fetchOnce: async (token) => {
      try {
        return await fetchFn(`${OUTLOOK_API_BASE}${path}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(OUTLOOK_API_TIMEOUT_MS),
        });
      } catch (err) {
        if ((err as Error).name === 'TimeoutError') {
          throw new Error(`Outlook API request timed out after ${OUTLOOK_API_TIMEOUT_MS}ms.`);
        }
        throw new Error(`Outlook API request failed: ${(err as Error).message}`);
      }
    },
  });
  if (!res.ok) throwOutlookHttpError(res.status, path);
  try {
    return await res.json();
  } catch {
    throw new Error('Outlook API returned a non-JSON response.');
  }
}

/** outlookCall cho endpoint trả về object JSON. */
async function outlookCallObject(
  opts: OutlookApiOptions,
  path: string,
): Promise<Record<string, unknown>> {
  const parsed = await outlookCall(opts, path);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Outlook API returned an unexpected response.');
  }
  return parsed as Record<string, unknown>;
}

/** User hiện tại (`GET /v1.0/me`). */
export async function outlookGetCurrentUser(opts: OutlookApiOptions): Promise<OutlookUser> {
  const rec = await outlookCallObject(opts, '/me');
  if (typeof rec['id'] !== 'string') {
    throw new Error('Outlook API returned an unexpected user response.');
  }
  return {
    id: rec['id'] as string,
    displayName: typeof rec['displayName'] === 'string' ? (rec['displayName'] as string) : undefined,
    email:
      typeof rec['mail'] === 'string'
        ? (rec['mail'] as string)
        : typeof rec['userPrincipalName'] === 'string'
          ? (rec['userPrincipalName'] as string)
          : undefined,
  };
}

/**
 * Liệt kê mail trong hộp thư (`GET /v1.0/me/messages`, mới nhất trước).
 * `folderId` mặc định là inbox ('inbox'); truyền 'sentitems', 'drafts'
 * … để đọc thư mục khác. Chỉ đọc metadata + bodyPreview, không tải
 * attachment.
 */
export async function outlookListMessages(
  opts: OutlookApiOptions,
  maxResults = 10,
  folderId = 'inbox',
): Promise<OutlookMessage[]> {
  const capped = Math.min(Math.max(Math.floor(maxResults), 1), 100);
  const params = new URLSearchParams({
    $top: String(capped),
    $orderby: 'receivedDateTime desc',
    $select: 'id,subject,from,receivedDateTime,isRead,bodyPreview',
  });
  const path =
    folderId === 'inbox'
      ? `/me/mailFolders/inbox/messages?${params.toString()}`
      : `/me/mailFolders/${encodeURIComponent(folderId)}/messages?${params.toString()}`;
  const rec = await outlookCallObject(opts, path);
  const items = rec['value'];
  if (!Array.isArray(items)) return [];
  return items
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
    .filter((m) => typeof m['id'] === 'string')
    .map((m) => {
      const from =
        typeof m['from'] === 'object' && m['from'] !== null
          ? (m['from'] as Record<string, unknown>)
          : undefined;
      const emailAddress =
        typeof from?.['emailAddress'] === 'object' && from['emailAddress'] !== null
          ? (from['emailAddress'] as Record<string, unknown>)
          : undefined;
      return {
        id: m['id'] as string,
        subject: typeof m['subject'] === 'string' ? (m['subject'] as string) : undefined,
        from: typeof emailAddress?.['name'] === 'string' ? (emailAddress['name'] as string) : undefined,
        fromEmail:
          typeof emailAddress?.['address'] === 'string' ? (emailAddress['address'] as string) : undefined,
        receivedDateTime:
          typeof m['receivedDateTime'] === 'string' ? (m['receivedDateTime'] as string) : undefined,
        isRead: typeof m['isRead'] === 'boolean' ? (m['isRead'] as boolean) : undefined,
        bodyPreview:
          typeof m['bodyPreview'] === 'string' ? (m['bodyPreview'] as string) : undefined,
      };
    });
}
