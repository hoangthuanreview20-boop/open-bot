/**
 * Google connector (v0.72a Team A) — Google Workspace API công khai,
 * OAuth token của user: Drive + Sheets + Calendar (chỉ đọc).
 *
 * Cùng endpoints Google OAuth với connector 'gmail' (accounts.google.com
 * / oauth2.googleapis.com) nhưng scope riêng cho Drive/Sheets/Calendar
 * — đọc file, đọc giá trị sheet, liệt kê sự kiện lịch. Scope chỉ đọc
 * (readonly) để tối thiểu quyền; tool ghi sau này cần xin thêm scope.
 *
 * Token lấy qua callback do host cấp (`getToken`, thường đọc Vault
 * namespace `connector`, key `google`). Token chỉ đi trong header
 * `Authorization: Bearer …`, KHÔNG BAO GIỜ được log. Khi chưa có token,
 * hàm ném lỗi rõ ràng kèm hướng dẫn kết nối.
 *
 * Không có live test với token thật trong repo — test dùng mock fetch.
 */
import type { ConnectorDefinition, ConnectorTokenProvider } from './framework';
import { callWithAutoRefresh, registerConnector } from './framework';

export const GOOGLE_DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
export const GOOGLE_SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
export const GOOGLE_CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';

export const GOOGLE_CONNECTOR: ConnectorDefinition = {
  id: 'google',
  label: 'Google Workspace',
  authType: 'oauth2',
  scopes: [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/calendar.events.readonly',
  ],
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  description:
    'Đọc Google Drive/Sheets/Calendar bằng OAuth token của user (chỉ đọc). Cần Google Cloud OAuth client — xem hướng dẫn kết nối trong lỗi khi chưa có token.',
};

try {
  registerConnector(GOOGLE_CONNECTOR);
} catch {
  // Đã đăng ký (module nạp 2 lần trong test) — bỏ qua.
}

export type FetchFn = typeof fetch;

export interface GoogleApiOptions {
  /** OAuth access token Google của user (callback do host cấp). */
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

export interface GoogleDriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
}

export interface GoogleCalendarEvent {
  id: string;
  summary?: string;
  start?: string;
  end?: string;
}

function errorNoToken(): Error {
  return new Error(
    'Chưa kết nối Google: chưa có OAuth token. ' +
      'Vào Settings → Connectors → Google Workspace để kết nối (Google OAuth, scope drive.readonly + spreadsheets.readonly + calendar.events.readonly), ' +
      'hoặc cấp token qua host getGoogleToken.',
  );
}

async function googleCall(
  opts: GoogleApiOptions,
  url: string,
): Promise<Record<string, unknown>> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  // Auto-refresh + retry 401 (v0.9): xem callWithAutoRefresh trong
  // framework.ts — GET retry 1 lần sau force refresh.
  const res = await callWithAutoRefresh({
    connectorId: 'google',
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
            'Content-Type': 'application/json',
          },
        });
      } catch (err) {
        throw new Error(`Google API request failed: ${(err as Error).message}`);
      }
    },
  });
  if (!res.ok) {
    // Không echo body: có thể chứa token hoặc nội dung file.
    throw new Error(`Google API returned HTTP ${res.status}.`);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error('Google API returned a non-JSON response.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Google API returned an unexpected response.');
  }
  return parsed as Record<string, unknown>;
}

/** Liệt kê file Drive (mới nhất trước). `query` là cú pháp tìm Drive. */
export async function googleDriveListFiles(
  opts: GoogleApiOptions,
  query = '',
  maxResults = 10,
): Promise<GoogleDriveFile[]> {
  const capped = Math.min(Math.max(Math.floor(maxResults), 1), 100);
  const params = new URLSearchParams({
    pageSize: String(capped),
    fields: 'files(id,name,mimeType,modifiedTime)',
    orderBy: 'modifiedTime desc',
  });
  if (query) params.set('q', query);
  const rec = await googleCall(opts, `${GOOGLE_DRIVE_API_BASE}/files?${params.toString()}`);
  const files = rec['files'];
  if (!Array.isArray(files)) return [];
  return files
    .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
    .filter((f) => typeof f['id'] === 'string')
    .map((f) => ({
      id: f['id'] as string,
      name: typeof f['name'] === 'string' ? (f['name'] as string) : undefined,
      mimeType: typeof f['mimeType'] === 'string' ? (f['mimeType'] as string) : undefined,
      modifiedTime:
        typeof f['modifiedTime'] === 'string' ? (f['modifiedTime'] as string) : undefined,
    }));
}

/** Đọc giá trị một vùng trong Google Sheet. `range` vd 'Sheet1!A1:D10'. */
export async function googleSheetsGetValues(
  opts: GoogleApiOptions,
  spreadsheetId: string,
  range: string,
): Promise<{ range?: string; values: string[][] }> {
  if (!spreadsheetId) throw new Error('Google Sheets spreadsheetId is required.');
  if (!range) throw new Error('Google Sheets range is required.');
  const rec = await googleCall(
    opts,
    `${GOOGLE_SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
  );
  const values = rec['values'];
  const rows: string[][] = Array.isArray(values)
    ? values.map((row) =>
        Array.isArray(row) ? row.map((cell) => (typeof cell === 'string' ? cell : String(cell ?? ''))) : [],
      )
    : [];
  return {
    range: typeof rec['range'] === 'string' ? (rec['range'] as string) : undefined,
    values: rows,
  };
}

/**
 * Liệt kê sự kiện lịch (mặc định lịch chính 'primary'). `timeMin` /
 * `timeMax` là ISO (vd '2026-11-11T00:00:00+07:00'); không truyền thì
 * lấy sự kiện sắp tới.
 */
export async function googleCalendarListEvents(
  opts: GoogleApiOptions,
  calendarId = 'primary',
  timeMin?: string,
  timeMax?: string,
  maxResults = 10,
): Promise<GoogleCalendarEvent[]> {
  if (!calendarId) throw new Error('Google Calendar calendarId is required.');
  const capped = Math.min(Math.max(Math.floor(maxResults), 1), 100);
  const params = new URLSearchParams({
    maxResults: String(capped),
    singleEvents: 'true',
    orderBy: 'startTime',
  });
  if (timeMin) params.set('timeMin', timeMin);
  if (timeMax) params.set('timeMax', timeMax);
  const rec = await googleCall(
    opts,
    `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
  );
  const items = rec['items'];
  if (!Array.isArray(items)) return [];
  return items
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .filter((e) => typeof e['id'] === 'string')
    .map((e) => {
      const start = e['start'] as Record<string, unknown> | undefined;
      const end = e['end'] as Record<string, unknown> | undefined;
      const startText =
        typeof start?.['dateTime'] === 'string'
          ? (start['dateTime'] as string)
          : typeof start?.['date'] === 'string'
            ? (start['date'] as string)
            : undefined;
      const endText =
        typeof end?.['dateTime'] === 'string'
          ? (end['dateTime'] as string)
          : typeof end?.['date'] === 'string'
            ? (end['date'] as string)
            : undefined;
      return {
        id: e['id'] as string,
        summary: typeof e['summary'] === 'string' ? (e['summary'] as string) : undefined,
        start: startText,
        end: endText,
      };
    });
}
