/**
 * Shared helpers cho direct read-only API clients (worker F2, v0.89b).
 *
 * Các client trong thư mục này gọi API công khai của từng app TRỰC TIẾP
 * (không qua Composio, không qua packages/core/src/connectors/* — đó là
 * khu vực OAuth của worker F3). Mỗi hàm chỉ ĐỌC, không có hàm ghi nào.
 *
 * Quy ước chung (theo mẫu packages/core/src/connectors/google.ts):
 *  - Hàm nhận `{ token, fetch }`: `fetch` tiêm được (test dùng mock),
 *    mặc định global fetch; `token` là access token / bot token của user.
 *  - Token/key chỉ đi trong header Authorization (trừ Trello: query
 *    key+token theo đúng thiết kế API Trello; Telegram: token nằm trong
 *    path `/bot<token>/...` theo đúng thiết kế Bot API) và KHÔNG BAO GIỜ
 *    được log hay đưa vào error message. Error message chỉ chứa tên
 *    operation (`context`), không chứa URL.
 *  - Lỗi HTTP map thành lỗi có mã rõ: 401/403/404/429/5xx.
 *  - Validate input: chuỗi rỗng → lỗi rõ ràng.
 *
 * Wire shape: theo tài liệu chính thức của từng API (ghi rõ version +
 * nguồn shape trong comment của từng file client).
 *
 * Không có live test với token thật trong repo — test dùng mock fetch
 * (mock-verified, chưa đối chiếu live).
 */
export type FetchFn = typeof fetch;

/** Options chung cho client dùng Bearer token. */
export interface ReadClientOptions {
  /** Access token / bot token của user (không log, không đưa vào lỗi). */
  token: string;
  /** Fetch injectable (test dùng mock; mặc định global fetch). */
  fetch?: FetchFn;
}

/** Timeout cho một lần gọi API (30 giây, như các connector khác). */
export const READ_CLIENT_TIMEOUT_MS = 30_000;

/** Ném lỗi rõ ràng khi chưa có token. */
export function requireToken(clientName: string, token: string | undefined): string {
  if (!token || typeof token !== 'string' || token.trim() === '') {
    throw new Error(
      `${clientName}: token is required — chưa có token, cấp token qua Vault/Settings trước khi gọi API.`,
    );
  }
  return token;
}

/** Ném lỗi rõ ràng khi một tham số chuỗi bắt buộc bị rỗng. */
export function requireNonEmpty(value: string | undefined, label: string): string {
  if (!value || typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required (chuỗi rỗng không hợp lệ).`);
  }
  return value;
}

/** Giới hạn số kết quả trong [1, max] (mặc định 10 khi không hợp lệ). */
export function capLimit(n: number, max: number): number {
  if (!Number.isFinite(n)) return 10;
  return Math.min(Math.max(Math.floor(n), 1), max);
}

/** Type guard: giá trị là object thường (không phải array/null). */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Đọc field chuỗi của một record, trả undefined khi không phải chuỗi. */
export function strField(rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key];
  return typeof v === 'string' ? v : undefined;
}

/** Đọc field số của một record, trả undefined khi không phải số. */
export function numField(rec: Record<string, unknown>, key: string): number | undefined {
  const v = rec[key];
  return typeof v === 'number' ? v : undefined;
}

/** Đọc field boolean của một record, trả undefined khi không phải boolean. */
export function boolField(rec: Record<string, unknown>, key: string): boolean | undefined {
  const v = rec[key];
  return typeof v === 'boolean' ? v : undefined;
}

/** Map lỗi HTTP thành lỗi có mã rõ. `context` là tên operation, không chứa URL/token. */
export function throwHttpError(clientName: string, status: number, context: string): never {
  if (status === 401) {
    throw new Error(
      `${clientName} API: xác thực thất bại (HTTP 401) cho ${context} — token/key không hợp lệ hoặc đã hết hạn.`,
    );
  }
  if (status === 403) {
    throw new Error(
      `${clientName} API: không đủ quyền (HTTP 403) cho ${context} — kiểm tra scope/quyền của token.`,
    );
  }
  if (status === 404) {
    throw new Error(
      `${clientName} API: không tìm thấy (HTTP 404) ${context} — kiểm tra id/đường dẫn.`,
    );
  }
  if (status === 429) {
    throw new Error(
      `${clientName} API: bị rate limit (HTTP 429) cho ${context} — đợi một lúc rồi thử lại.`,
    );
  }
  if (status >= 500) {
    throw new Error(
      `${clientName} API: lỗi phía server (HTTP ${status}) cho ${context} — thử lại sau.`,
    );
  }
  throw new Error(`${clientName} API returned HTTP ${status} for ${context}.`);
}

export interface CallJsonInit {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

/**
 * Gọi API và parse JSON. Caller tự build `url` + `headers` (mỗi API auth
 * khác nhau); hàm này chỉ validate token, gắn timeout, map lỗi HTTP và
 * parse JSON. Không bao giờ đưa URL vào error message (URL có thể chứa
 * token với Trello/Telegram).
 */
export async function callJson(
  clientName: string,
  opts: ReadClientOptions,
  url: string,
  context: string,
  init: CallJsonInit,
): Promise<unknown> {
  requireToken(clientName, opts.token);
  const fetchFn = opts.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: AbortSignal.timeout(READ_CLIENT_TIMEOUT_MS),
    });
  } catch (err) {
    if ((err as Error).name === 'TimeoutError') {
      throw new Error(
        `${clientName} API request timed out after ${READ_CLIENT_TIMEOUT_MS}ms (${context}).`,
      );
    }
    throw new Error(`${clientName} API request failed (${context}): ${(err as Error).message}`);
  }
  if (!res.ok) throwHttpError(clientName, res.status, context);
  try {
    return await res.json();
  } catch {
    throw new Error(`${clientName} API returned a non-JSON response (${context}).`);
  }
}

/** callJson cho endpoint trả về object JSON; ném lỗi khi shape không phải object. */
export async function callJsonObject(
  clientName: string,
  opts: ReadClientOptions,
  url: string,
  context: string,
  init: CallJsonInit,
): Promise<Record<string, unknown>> {
  const parsed = await callJson(clientName, opts, url, context, init);
  if (!isRecord(parsed)) {
    throw new Error(`${clientName} API returned an unexpected response (${context}).`);
  }
  return parsed;
}

/** Lấy mảng trong field của object JSON; trả [] khi field không phải mảng. */
export function arrayField(rec: Record<string, unknown>, key: string): unknown[] {
  const v = rec[key];
  return Array.isArray(v) ? v : [];
}
