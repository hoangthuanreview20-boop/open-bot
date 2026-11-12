/**
 * Outlook read client (worker F2, v0.89b) — Microsoft Graph v1.0, chỉ đọc.
 *
 * Wire shape theo tài liệu chính thức Microsoft Graph
 * (learn.microsoft.com/en-us/graph/api/resources/message,
 *  mailfolder; API v1.0):
 *  - `GET /v1.0/me/messages?$top=N&$select=id,subject,from,receivedDateTime,
 *    isRead&$orderby=receivedDateTime desc` → `{ value: [{ id, subject,
 *    from: { emailAddress: { address, name } }, receivedDateTime, isRead }],
 *    "@odata.nextLink" }`.
 *  - `GET /v1.0/me/mailFolders?$select=id,displayName,totalItemCount,
 *    unreadItemCount` → `{ value: [{ id, displayName, totalItemCount,
 *    unreadItemCount }] }`.
 *  - `GET /v1.0/me/messages?$search="..."&$top=N&$select=...` → cùng shape
 *    message (search dùng KQL, giá trị phải đặt trong dấu `"`).
 *  - Auth: header `Authorization: Bearer <access token>` (scope
 *    `Mail.Read`).
 *
 * Token chỉ đi trong header Authorization, KHÔNG BAO GIỜ được log.
 *
 * Không có live test với token thật trong repo — test dùng mock fetch
 * (mock-verified, chưa đối chiếu live).
 */
import {
  arrayField,
  callJsonObject,
  capLimit,
  isRecord,
  requireNonEmpty,
  strField,
  type ReadClientOptions,
} from './common';

export const OUTLOOK_GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

export type OutlookApiOptions = ReadClientOptions;

export interface OutlookMessage {
  id: string;
  subject?: string;
  fromAddress?: string;
  fromName?: string;
  receivedDateTime?: string;
  isRead?: boolean;
}

export interface OutlookFolder {
  id: string;
  displayName?: string;
  totalItemCount?: number;
  unreadItemCount?: number;
}

const MESSAGE_SELECT = 'id,subject,from,receivedDateTime,isRead';

function outlookHeaders(opts: OutlookApiOptions): Record<string, string> {
  return {
    Authorization: `Bearer ${opts.token}`,
    Accept: 'application/json',
  };
}

function parseMessage(raw: unknown): OutlookMessage | null {
  if (!isRecord(raw) || typeof raw['id'] !== 'string') return null;
  const from = isRecord(raw['from']) ? raw['from'] : undefined;
  const emailAddress = from && isRecord(from['emailAddress']) ? from['emailAddress'] : undefined;
  return {
    id: raw['id'] as string,
    subject: strField(raw, 'subject'),
    fromAddress: emailAddress ? strField(emailAddress, 'address') : undefined,
    fromName: emailAddress ? strField(emailAddress, 'name') : undefined,
    receivedDateTime: strField(raw, 'receivedDateTime'),
    isRead: typeof raw['isRead'] === 'boolean' ? (raw['isRead'] as boolean) : undefined,
  };
}

function parseMessages(rec: Record<string, unknown>): OutlookMessage[] {
  return arrayField(rec, 'value')
    .map((m) => parseMessage(m))
    .filter((m): m is OutlookMessage => m !== null);
}

/** Liệt kê mail mới nhất trong hộp thư của user. */
export async function outlookListMessages(
  opts: OutlookApiOptions,
  maxResults = 10,
): Promise<OutlookMessage[]> {
  const params = new URLSearchParams({
    $top: String(capLimit(maxResults, 100)),
    $select: MESSAGE_SELECT,
    $orderby: 'receivedDateTime desc',
  });
  const rec = await callJsonObject(
    'Outlook',
    opts,
    `${OUTLOOK_GRAPH_API_BASE}/me/messages?${params.toString()}`,
    'outlookListMessages',
    { method: 'GET', headers: outlookHeaders(opts) },
  );
  return parseMessages(rec);
}

/** Liệt kê các mail folder (Inbox, SentItems, Drafts, ...). */
export async function outlookListFolders(opts: OutlookApiOptions): Promise<OutlookFolder[]> {
  const params = new URLSearchParams({
    $select: 'id,displayName,totalItemCount,unreadItemCount',
  });
  const rec = await callJsonObject(
    'Outlook',
    opts,
    `${OUTLOOK_GRAPH_API_BASE}/me/mailFolders?${params.toString()}`,
    'outlookListFolders',
    { method: 'GET', headers: outlookHeaders(opts) },
  );
  return arrayField(rec, 'value')
    .filter((f): f is Record<string, unknown> => isRecord(f))
    .filter((f) => typeof f['id'] === 'string')
    .map((f) => ({
      id: f['id'] as string,
      displayName: strField(f, 'displayName'),
      totalItemCount: typeof f['totalItemCount'] === 'number' ? (f['totalItemCount'] as number) : undefined,
      unreadItemCount:
        typeof f['unreadItemCount'] === 'number' ? (f['unreadItemCount'] as number) : undefined,
    }));
}

/** Tìm mail theo từ khoá (KQL `$search`, vd 'from:boss subject:report'). */
export async function outlookSearchMessages(
  opts: OutlookApiOptions,
  query: string,
  maxResults = 10,
): Promise<OutlookMessage[]> {
  requireNonEmpty(query, 'Outlook query');
  const params = new URLSearchParams({
    $search: `"${query}"`,
    $top: String(capLimit(maxResults, 100)),
    $select: MESSAGE_SELECT,
  });
  const rec = await callJsonObject(
    'Outlook',
    opts,
    `${OUTLOOK_GRAPH_API_BASE}/me/messages?${params.toString()}`,
    'outlookSearchMessages',
    { method: 'GET', headers: outlookHeaders(opts) },
  );
  return parseMessages(rec);
}
