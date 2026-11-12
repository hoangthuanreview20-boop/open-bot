/**
 * Dropbox connector (v0.89a, worker F3) — Dropbox API, OAuth 2.0 +
 * client đọc thật.
 *
 * Endpoints theo tài liệu Dropbox (dropbox.com/developers/documentation):
 * authorize `https://www.dropbox.com/oauth2/authorize` (host chuẩn là
 * www.dropbox.com; dropbox.com không có www sẽ redirect về đây),
 * token `https://api.dropboxapi.com/oauth2/token`.
 * Scope CHỈ ĐỌC (Dropbox dùng scope dạng `files.metadata.read` …):
 * `account_info.read` (userinfo), `files.metadata.read` +
 * `files.content.read` (liệt kê file — chưa có hàm tải nội dung file
 * trong đợt này, scope content.read được xin trước để hàm download
 * sau này không phải xin lại quyền).
 *
 * API đọc (chỉ đọc, không ghi) — Dropbox dùng POST có body JSON cho
 * cả endpoint đọc (không có GET); framework không retry POST sau 401
 * nên 401 ném TokenExpiredError ngay (xem ghi chú trong dropboxCall):
 *  - `POST /2/users/get_current_account` — tài khoản hiện tại.
 *  - `POST /2/files/list_folder` — liệt kê file/thư mục trong 1
 *    thư mục (`path: ''` = thư mục gốc). Trả về `has_more` + `cursor`
 *    khi còn trang sau — dùng `dropboxListFolderContinue` để lấy tiếp.
 *
 * Token lấy qua callback do host cấp (`getToken`, thường đọc Vault
 * namespace `connector`, key `dropbox`). Token chỉ đi trong header
 * `Authorization: Bearer …`, KHÔNG BAO GIỜ được log. Khi chưa có token,
 * hàm ném lỗi rõ ràng kèm hướng dẫn kết nối. Client id/secret KHÔNG
 * hardcode ở đây — host cấp qua Vault/config lúc đăng ký OAuth app.
 *
 * Không có live test với token thật trong repo — test dùng mock fetch.
 */
import type { ConnectorDefinition, ConnectorTokenProvider } from './framework';
import { callWithAutoRefresh, registerConnector } from './framework';

export const DROPBOX_API_BASE = 'https://api.dropboxapi.com/2';

/** Timeout cho một lần gọi Dropbox API (30 giây, như các connector khác). */
export const DROPBOX_API_TIMEOUT_MS = 30_000;

/** Scope chỉ đọc: userinfo + liệt kê/tải nội dung file. */
export const DROPBOX_SCOPES: string[] = [
  'account_info.read',
  'files.metadata.read',
  'files.content.read',
];

export const DROPBOX_CONNECTOR: ConnectorDefinition = {
  id: 'dropbox',
  label: 'Dropbox',
  authType: 'oauth2',
  scopes: [...DROPBOX_SCOPES],
  authUrl: 'https://www.dropbox.com/oauth2/authorize',
  tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
  description:
    'Đọc tài khoản + liệt kê file Dropbox bằng OAuth token của user (chỉ đọc: account_info.read + files.metadata.read + files.content.read). Cần tạo OAuth app trong Dropbox App Console trước.',
};

try {
  registerConnector(DROPBOX_CONNECTOR);
} catch {
  // Đã đăng ký (module nạp 2 lần trong test) — bỏ qua.
}

export type FetchFn = typeof fetch;

export interface DropboxApiOptions {
  /** OAuth access token Dropbox của user (callback do host cấp). */
  getToken: () => string | null | Promise<string | null>;
  /**
   * Provider token có auto-refresh (tạo bằng
   * createConnectorTokenProvider). Khi có, mỗi call lấy token qua
   * provider (tự refresh trước 5 phút, dedup); khi không có, dùng
   * getToken() như cũ. Lưu ý: Dropbox API chỉ có POST nên 401 không
   * được retry (framework chỉ retry GET) — token hết hạn giữa chừng
   * thì call lỗi và lần gọi sau sẽ dùng token mới đã refresh.
   */
  tokenProvider?: ConnectorTokenProvider;
  /** Fetch injectable (test dùng mock; mặc định global fetch). */
  fetchFn?: FetchFn;
}

/** Tài khoản Dropbox hiện tại. */
export interface DropboxAccount {
  accountId: string;
  displayName?: string;
  email?: string;
}

/** Một entry trong thư mục (file, thư mục, hoặc shared link đã xóa). */
export interface DropboxEntry {
  /** '.tag': 'file' | 'folder' | 'deleted'. */
  tag: string;
  id?: string;
  name: string;
  /** Đường dẫn đầy đủ, chữ thường (vd '/photos/a.jpg'). */
  pathLower?: string;
  /** Kích thước byte (chỉ file). */
  size?: number;
  clientModified?: string;
  serverModified?: string;
}

export interface DropboxListFolderResult {
  entries: DropboxEntry[];
  /** true khi còn trang sau — gọi dropboxListFolderContinue(cursor). */
  hasMore: boolean;
  cursor?: string;
}

function errorNoToken(): Error {
  return new Error(
    'Chưa kết nối Dropbox: chưa có OAuth token. ' +
      'Vào Settings → Connectors → Dropbox để kết nối (Dropbox OAuth, scope account_info.read + files.metadata.read + files.content.read), ' +
      'hoặc cấp token qua host getDropboxToken.',
  );
}

function throwDropboxHttpError(status: number, context: string): never {
  if (status === 403) {
    throw new Error(
      `Dropbox API: không đủ quyền (HTTP 403) cho ${context} — kiểm tra scope files.metadata.read của token và quyền xem thư mục.`,
    );
  }
  if (status === 404) {
    throw new Error(
      `Dropbox API: không tìm thấy (HTTP 404) ${context} — kiểm tra đường dẫn, hoặc file/thư mục đã bị xoá.`,
    );
  }
  if (status === 429) {
    throw new Error(
      `Dropbox API: bị rate limit (HTTP 429) cho ${context} — đợi một lúc rồi thử lại.`,
    );
  }
  throw new Error(`Dropbox API returned HTTP ${status} for ${context}.`);
}

async function dropboxCall(
  opts: DropboxApiOptions,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  // Auto-refresh (v0.9): tokenProvider tự refresh trước 5 phút.
  // Dropbox chỉ có POST nên 401 KHÔNG được retry (framework chỉ
  // retry GET, tránh gửi trùng) — ném TokenExpiredError ngay.
  const res = await callWithAutoRefresh({
    connectorId: 'dropbox',
    method: 'POST',
    getToken: opts.getToken,
    tokenProvider: opts.tokenProvider,
    noTokenError: errorNoToken(),
    fetchOnce: async (token) => {
      try {
        return await fetchFn(`${DROPBOX_API_BASE}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(DROPBOX_API_TIMEOUT_MS),
        });
      } catch (err) {
        if ((err as Error).name === 'TimeoutError') {
          throw new Error(`Dropbox API request timed out after ${DROPBOX_API_TIMEOUT_MS}ms.`);
        }
        throw new Error(`Dropbox API request failed: ${(err as Error).message}`);
      }
    },
  });
  if (!res.ok) throwDropboxHttpError(res.status, `POST ${path}`);
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error('Dropbox API returned a non-JSON response.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Dropbox API returned an unexpected response.');
  }
  return parsed as Record<string, unknown>;
}

function parseEntry(raw: unknown): DropboxEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec['.tag'] !== 'string' || typeof rec['name'] !== 'string') return null;
  return {
    tag: rec['.tag'] as string,
    id: typeof rec['id'] === 'string' ? (rec['id'] as string) : undefined,
    name: rec['name'] as string,
    pathLower: typeof rec['path_lower'] === 'string' ? (rec['path_lower'] as string) : undefined,
    size: typeof rec['size'] === 'number' ? (rec['size'] as number) : undefined,
    clientModified:
      typeof rec['client_modified'] === 'string' ? (rec['client_modified'] as string) : undefined,
    serverModified:
      typeof rec['server_modified'] === 'string' ? (rec['server_modified'] as string) : undefined,
  };
}

function parseListFolder(rec: Record<string, unknown>): DropboxListFolderResult {
  const entries = rec['entries'];
  return {
    entries: Array.isArray(entries)
      ? entries.map((e) => parseEntry(e)).filter((e): e is DropboxEntry => e !== null)
      : [],
    hasMore: rec['has_more'] === true,
    cursor: typeof rec['cursor'] === 'string' ? (rec['cursor'] as string) : undefined,
  };
}

/** Tài khoản hiện tại (`POST /2/users/get_current_account`). */
export async function dropboxGetCurrentAccount(
  opts: DropboxApiOptions,
): Promise<DropboxAccount> {
  const rec = await dropboxCall(opts, '/users/get_current_account', {});
  if (typeof rec['account_id'] !== 'string') {
    throw new Error('Dropbox API returned an unexpected account response.');
  }
  const name =
    typeof rec['name'] === 'object' && rec['name'] !== null
      ? (rec['name'] as Record<string, unknown>)
      : undefined;
  return {
    accountId: rec['account_id'] as string,
    displayName:
      typeof name?.['display_name'] === 'string' ? (name['display_name'] as string) : undefined,
    email: typeof rec['email'] === 'string' ? (rec['email'] as string) : undefined,
  };
}

/**
 * Liệt kê file/thư mục trong 1 thư mục (`POST /2/files/list_folder`).
 * `path` rỗng = thư mục gốc; vd '/Photos'. `recursive` mặc định false.
 * Trả về trang đầu + `hasMore`/`cursor` khi còn trang sau.
 */
export async function dropboxListFolder(
  opts: DropboxApiOptions,
  path = '',
  maxResults = 100,
  recursive = false,
): Promise<DropboxListFolderResult> {
  const capped = Math.min(Math.max(Math.floor(maxResults), 1), 2000);
  const rec = await dropboxCall(opts, '/files/list_folder', {
    path,
    recursive,
    limit: capped,
  });
  return parseListFolder(rec);
}

/** Lấy trang tiếp theo của list_folder (`POST /2/files/list_folder/continue`). */
export async function dropboxListFolderContinue(
  opts: DropboxApiOptions,
  cursor: string,
): Promise<DropboxListFolderResult> {
  if (!cursor) throw new Error('Dropbox list_folder cursor is required.');
  const rec = await dropboxCall(opts, '/files/list_folder/continue', { cursor });
  return parseListFolder(rec);
}
