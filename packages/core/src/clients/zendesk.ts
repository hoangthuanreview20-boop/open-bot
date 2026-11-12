/**
 * Zendesk read client (worker F2, v0.89b, stretch) — Zendesk API v2, chỉ đọc.
 *
 * Wire shape theo tài liệu chính thức Zendesk API
 * (developer.zendesk.com/api-reference/ticketing/tickets/tickets/):
 *  - `GET /api/v2/tickets.json?page[size]=25` → `{ tickets: [{ id,
 *    subject, status, requester_id, created_at, updated_at }], next_page }`.
 *  - `GET /api/v2/tickets/{id}.json` → `{ ticket: { ... } }`.
 *  - `GET /api/v2/search.json?query=type:ticket ...` → `{ results:
 *    [{ id, subject, status, ... }], count }`.
 *  - Auth: header `Authorization: Bearer <OAuth access token>`
 *    (hoặc API token qua Basic — client này dùng Bearer OAuth).
 *  - Base URL: `https://{subdomain}.zendesk.com/api/v2`.
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
  type FetchFn,
} from './common';

export const ZENDESK_API_VERSION = 'v2';

export interface ZendeskApiOptions {
  /** Subdomain Zendesk, vd 'mycompany' cho mycompany.zendesk.com. */
  subdomain: string;
  /** OAuth access token của user. */
  token: string;
  /** Fetch injectable (test dùng mock; mặc định global fetch). */
  fetch?: FetchFn;
}

export interface ZendeskTicket {
  id: number;
  subject?: string;
  status?: string;
  requesterId?: number;
  createdAt?: string;
  updatedAt?: string;
}

function zendeskBase(opts: ZendeskApiOptions): string {
  requireNonEmpty(opts.subdomain, 'Zendesk subdomain');
  if (!/^[a-z0-9-]+$/i.test(opts.subdomain.trim())) {
    throw new Error('Zendesk subdomain is invalid (chỉ chữ, số và dấu gạch ngang).');
  }
  return `https://${opts.subdomain.trim().toLowerCase()}.zendesk.com/api/v2`;
}

function zendeskHeaders(opts: ZendeskApiOptions): Record<string, string> {
  return {
    Authorization: `Bearer ${opts.token}`,
    Accept: 'application/json',
  };
}

function parseTicket(raw: unknown): ZendeskTicket | null {
  if (!isRecord(raw) || typeof raw['id'] !== 'number') return null;
  return {
    id: raw['id'] as number,
    subject: strField(raw, 'subject'),
    status: strField(raw, 'status'),
    requesterId: typeof raw['requester_id'] === 'number' ? (raw['requester_id'] as number) : undefined,
    createdAt: strField(raw, 'created_at'),
    updatedAt: strField(raw, 'updated_at'),
  };
}

/** Liệt kê tickets (mới nhất không đảm bảo thứ tự — Zendesk trả theo id). */
export async function zendeskListTickets(
  opts: ZendeskApiOptions,
  pageSize = 25,
): Promise<ZendeskTicket[]> {
  const params = new URLSearchParams({ 'page[size]': String(capLimit(pageSize, 100)) });
  const rec = await callJsonObject(
    'Zendesk',
    opts,
    `${zendeskBase(opts)}/tickets.json?${params.toString()}`,
    'zendeskListTickets',
    { method: 'GET', headers: zendeskHeaders(opts) },
  );
  return arrayField(rec, 'tickets')
    .map((t) => parseTicket(t))
    .filter((t): t is ZendeskTicket => t !== null);
}

/** Đọc một ticket theo id. */
export async function zendeskGetTicket(
  opts: ZendeskApiOptions,
  ticketId: number,
): Promise<ZendeskTicket> {
  if (!Number.isInteger(ticketId) || ticketId <= 0) {
    throw new Error('Zendesk ticketId is invalid (phải là số nguyên dương).');
  }
  const rec = await callJsonObject(
    'Zendesk',
    opts,
    `${zendeskBase(opts)}/tickets/${ticketId}.json`,
    'zendeskGetTicket',
    { method: 'GET', headers: zendeskHeaders(opts) },
  );
  const ticket = parseTicket(rec['ticket']);
  if (!ticket) throw new Error('Zendesk API returned an unexpected ticket response (zendeskGetTicket).');
  return ticket;
}

/**
 * Tìm tickets (`query` là phần sau `type:ticket`, vd 'status<solved
 * "refund"'). Trả về tối đa `count` kết quả của API.
 */
export async function zendeskSearchTickets(
  opts: ZendeskApiOptions,
  query: string,
): Promise<ZendeskTicket[]> {
  requireNonEmpty(query, 'Zendesk query');
  const params = new URLSearchParams({ query: `type:ticket ${query}` });
  const rec = await callJsonObject(
    'Zendesk',
    opts,
    `${zendeskBase(opts)}/search.json?${params.toString()}`,
    'zendeskSearchTickets',
    { method: 'GET', headers: zendeskHeaders(opts) },
  );
  return arrayField(rec, 'results')
    .map((t) => parseTicket(t))
    .filter((t): t is ZendeskTicket => t !== null);
}
