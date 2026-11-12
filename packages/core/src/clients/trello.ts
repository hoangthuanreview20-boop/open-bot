/**
 * Trello read client (worker F2, v0.89b) — Trello REST API, chỉ đọc.
 *
 * Wire shape theo tài liệu chính thức Trello API
 * (developer.atlassian.com/cloud/trello/rest/):
 *  - `GET /1/members/me/boards?fields=id,name,url,closed` → `[{ id, name,
 *    url, closed }]`.
 *  - `GET /1/boards/{boardId}/lists?fields=id,name,closed` → `[{ id, name,
 *    closed }]`.
 *  - `GET /1/lists/{listId}/cards?fields=id,name,shortLink,url,closed` →
 *    `[{ id, name, shortLink, url, closed }]`.
 *  - `GET /1/boards/{boardId}/cards?fields=id,name,shortLink,url,closed` →
 *    cùng shape card.
 *  - Auth: query `?key=<apiKey>&token=<token>` — đây là thiết kế của
 *    Trello API (không có header Bearer). Key/token chỉ đi trong query
 *    của request, KHÔNG BAO GIỜ được log hay đưa vào error message
 *    (error chỉ chứa tên operation).
 *
 * Không có live test với key/token thật trong repo — test dùng mock fetch
 * (mock-verified, chưa đối chiếu live).
 */
import {
  boolField,
  callJson,
  capLimit,
  isRecord,
  requireNonEmpty,
  strField,
} from './common';
import type { FetchFn } from './common';

export const TRELLO_API_BASE = 'https://api.trello.com/1';

export interface TrelloApiOptions {
  /** Trello API key của user. */
  key: string;
  /** Trello token của user. */
  token: string;
  /** Fetch injectable (test dùng mock; mặc định global fetch). */
  fetch?: FetchFn;
}

export interface TrelloBoard {
  id: string;
  name?: string;
  url?: string;
  closed?: boolean;
}

export interface TrelloList {
  id: string;
  name?: string;
  closed?: boolean;
}

export interface TrelloCard {
  id: string;
  name?: string;
  shortLink?: string;
  url?: string;
  closed?: boolean;
}

function trelloAuthQuery(opts: TrelloApiOptions): string {
  requireNonEmpty(opts.key, 'Trello key');
  requireNonEmpty(opts.token, 'Trello token');
  const params = new URLSearchParams({ key: opts.key, token: opts.token });
  return params.toString();
}

async function trelloGet(opts: TrelloApiOptions, path: string, context: string): Promise<unknown> {
  const sep = path.includes('?') ? '&' : '?';
  return callJson('Trello', opts, `${TRELLO_API_BASE}${path}${sep}${trelloAuthQuery(opts)}`, context, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
}

/** Liệt kê boards của user hiện tại (mới nhất không đảm bảo thứ tự — Trello không sort). */
export async function trelloListBoards(opts: TrelloApiOptions): Promise<TrelloBoard[]> {
  const parsed = await trelloGet(opts, '/members/me/boards?fields=id,name,url,closed', 'trelloListBoards');
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((b): b is Record<string, unknown> => isRecord(b))
    .filter((b) => typeof b['id'] === 'string')
    .map((b) => ({
      id: b['id'] as string,
      name: strField(b, 'name'),
      url: strField(b, 'url'),
      closed: boolField(b, 'closed'),
    }));
}

/** Liệt kê lists của một board. */
export async function trelloListLists(
  opts: TrelloApiOptions,
  boardId: string,
): Promise<TrelloList[]> {
  requireNonEmpty(boardId, 'Trello boardId');
  const parsed = await trelloGet(
    opts,
    `/boards/${encodeURIComponent(boardId)}/lists?fields=id,name,closed`,
    'trelloListLists',
  );
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((l): l is Record<string, unknown> => isRecord(l))
    .filter((l) => typeof l['id'] === 'string')
    .map((l) => ({
      id: l['id'] as string,
      name: strField(l, 'name'),
      closed: boolField(l, 'closed'),
    }));
}

function parseCards(parsed: unknown): TrelloCard[] {
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((c): c is Record<string, unknown> => isRecord(c))
    .filter((c) => typeof c['id'] === 'string')
    .map((c) => ({
      id: c['id'] as string,
      name: strField(c, 'name'),
      shortLink: strField(c, 'shortLink'),
      url: strField(c, 'url'),
      closed: boolField(c, 'closed'),
    }));
}

/** Liệt kê cards của một list. */
export async function trelloListCards(
  opts: TrelloApiOptions,
  listId: string,
): Promise<TrelloCard[]> {
  requireNonEmpty(listId, 'Trello listId');
  const parsed = await trelloGet(
    opts,
    `/lists/${encodeURIComponent(listId)}/cards?fields=id,name,shortLink,url,closed`,
    'trelloListCards',
  );
  return parseCards(parsed);
}

/** Liệt kê tất cả cards của một board (không cần qua từng list). */
export async function trelloListBoardCards(
  opts: TrelloApiOptions,
  boardId: string,
  limit = 100,
): Promise<TrelloCard[]> {
  requireNonEmpty(boardId, 'Trello boardId');
  const parsed = await trelloGet(
    opts,
    `/boards/${encodeURIComponent(boardId)}/cards?fields=id,name,shortLink,url,closed&limit=${capLimit(limit, 1000)}`,
    'trelloListBoardCards',
  );
  return parseCards(parsed);
}
