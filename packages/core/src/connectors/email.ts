/**
 * Email connector (v0.7) — Gmail API công khai, OAuth token của user.
 *
 * ROADMAP §2c: "Tích hợp email (đọc inbox/thread, gửi/nhận)".
 *
 * KHÔNG dùng IMAP: dùng Gmail API (`gmail.googleapis.com`) với OAuth
 * token của user — IMAP cần mật khẩu/app-password, không hợp với mô
 * hình OAuth + Vault của open-bot.
 *
 * Token lấy qua callback do host cấp (`getToken`, thường đọc Vault
 * namespace `connector`, key `gmail`). Token chỉ đi trong header
 * `Authorization: Bearer …`, KHÔNG BAO GIỜ được log. Khi chưa có token,
 * hàm ném lỗi rõ ràng kèm hướng dẫn kết nối.
 *
 * Gửi mail: POST messages.send với `raw` = RFC 822 base64url.
 * Không có live test với token thật trong repo — test dùng mock fetch.
 */
import type { ConnectorDefinition, ConnectorTokenProvider } from './framework';
import { callWithAutoRefresh, registerConnector } from './framework';

export const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';

export const GMAIL_CONNECTOR: ConnectorDefinition = {
  id: 'gmail',
  label: 'Gmail',
  authType: 'oauth2',
  scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'],
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  description:
    'Đọc/gửi mail Gmail bằng OAuth token của user. Cần Google Cloud OAuth client — xem hướng dẫn kết nối trong lỗi khi chưa có token.',
};

try {
  registerConnector(GMAIL_CONNECTOR);
} catch {
  // Đã đăng ký (module nạp 2 lần trong test) — bỏ qua.
}

export type FetchFn = typeof fetch;

export interface GmailApiOptions {
  /** OAuth access token Gmail của user (callback do host cấp). */
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

export interface GmailMessageSummary {
  id: string;
  threadId?: string;
  snippet?: string;
  /** Header đã giải mã khi getMessage(full) — không có ở list. */
  subject?: string;
  from?: string;
  date?: string;
  body?: string;
}

function errorNoToken(): Error {
  return new Error(
    'Chưa kết nối Gmail: chưa có OAuth token. ' +
      'Vào Settings → Connectors → Gmail để kết nối (Google OAuth, scope gmail.readonly + gmail.send), ' +
      'hoặc cấp token qua host getGmailToken.',
  );
}

async function gmailCall(
  opts: GmailApiOptions,
  path: string,
  init: { method?: string; body?: Record<string, unknown> } = {},
): Promise<Record<string, unknown>> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const method = init.method ?? 'GET';
  // Auto-refresh + retry 401 (v0.9): xem callWithAutoRefresh trong
  // framework.ts — GET retry 1 lần sau force refresh, POST không retry.
  const res = await callWithAutoRefresh({
    connectorId: 'gmail',
    method,
    getToken: opts.getToken,
    tokenProvider: opts.tokenProvider,
    noTokenError: errorNoToken(),
    fetchOnce: async (token) => {
      try {
        return await fetchFn(`${GMAIL_API_BASE}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        });
      } catch (err) {
        throw new Error(`Gmail API request failed: ${(err as Error).message}`);
      }
    },
  });
  if (!res.ok) {
    // Không echo body: có thể chứa token hoặc nội dung mail.
    throw new Error(`Gmail API returned HTTP ${res.status} for ${path}.`);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error(`Gmail API returned a non-JSON response for ${path}.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Gmail API returned an unexpected response for ${path}.`);
  }
  return parsed as Record<string, unknown>;
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function encodeBase64Url(text: string): string {
  return Buffer.from(text, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Liệt kê tin trong inbox (mới nhất trước). `query` là cú pháp tìm Gmail. */
export async function gmailListMessages(
  opts: GmailApiOptions,
  query = '',
  maxResults = 10,
): Promise<GmailMessageSummary[]> {
  const capped = Math.min(Math.max(Math.floor(maxResults), 1), 100);
  const params = new URLSearchParams({ maxResults: String(capped) });
  if (query) params.set('q', query);
  const rec = await gmailCall(opts, `/users/me/messages?${params.toString()}`);
  const messages = rec['messages'];
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
    .filter((m) => typeof m['id'] === 'string')
    .map((m) => ({
      id: m['id'] as string,
      threadId: typeof m['threadId'] === 'string' ? m['threadId'] : undefined,
    }));
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!Array.isArray(headers)) return undefined;
  for (const h of headers) {
    if (
      typeof h === 'object' &&
      h !== null &&
      (h as Record<string, unknown>)['name'] === name &&
      typeof (h as Record<string, unknown>)['value'] === 'string'
    ) {
      return (h as Record<string, unknown>)['value'] as string;
    }
  }
  return undefined;
}

/** Đọc một message: subject/from/date + snippet + body text (nếu có). */
export async function gmailGetMessage(
  opts: GmailApiOptions,
  messageId: string,
): Promise<GmailMessageSummary> {
  if (!messageId) throw new Error('Gmail message id is required.');
  const rec = await gmailCall(opts, `/users/me/messages/${encodeURIComponent(messageId)}?format=full`);
  const payload = (rec['payload'] ?? {}) as Record<string, unknown>;
  const headers = payload['headers'];
  let body = '';
  const bodyData = (payload['body'] as Record<string, unknown> | undefined)?.['data'];
  if (typeof bodyData === 'string') {
    body = decodeBase64Url(bodyData);
  } else if (Array.isArray(payload['parts'])) {
    for (const part of payload['parts'] as Array<Record<string, unknown>>) {
      const partBody = part['body'] as Record<string, unknown> | undefined;
      const mime = part['mimeType'];
      if (mime === 'text/plain' && typeof partBody?.['data'] === 'string') {
        body = decodeBase64Url(partBody['data'] as string);
        break;
      }
    }
  }
  return {
    id: typeof rec['id'] === 'string' ? rec['id'] : messageId,
    threadId: typeof rec['threadId'] === 'string' ? rec['threadId'] : undefined,
    snippet: typeof rec['snippet'] === 'string' ? rec['snippet'] : undefined,
    subject: headerValue(headers, 'Subject'),
    from: headerValue(headers, 'From'),
    date: headerValue(headers, 'Date'),
    body: body === '' ? undefined : body,
  };
}

/**
 * Gửi một mail qua Gmail API. `to` có thể là một địa chỉ hoặc nhiều
 * địa chỉ cách nhau bằng dấu phẩy. Trả về id message đã gửi.
 */
export async function gmailSendMessage(
  opts: GmailApiOptions,
  args: { to: string; subject: string; body: string; cc?: string },
): Promise<{ id: string }> {
  if (!args.to) throw new Error('Gmail recipient ("to") is required.');
  if (!args.subject && !args.body) throw new Error('Gmail message needs a subject or a body.');
  const lines = [`To: ${args.to}`];
  if (args.cc) lines.push(`Cc: ${args.cc}`);
  lines.push(`Subject: ${args.subject}`, 'Content-Type: text/plain; charset="UTF-8"', '', args.body);
  const raw = encodeBase64Url(lines.join('\r\n'));
  const rec = await gmailCall(opts, '/users/me/messages/send', {
    method: 'POST',
    body: { raw },
  });
  if (typeof rec['id'] !== 'string') throw new Error('Gmail send did not return a message id.');
  return { id: rec['id'] };
}
