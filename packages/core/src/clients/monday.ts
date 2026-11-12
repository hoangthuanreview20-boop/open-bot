/**
 * monday.com read client (worker F2, v0.89b, stretch) — monday GraphQL API, chỉ đọc.
 *
 * Wire shape theo tài liệu chính thức monday API
 * (developer.monday.com/api-reference/reference/boards,
 *  items-page; API version header `API-Version: 2024-01`):
 *  - `POST /v2` body `{ query: "{ boards (limit: 25) { id name state } }" }`
 *    → `{ data: { boards: [{ id, name, state }] } }`.
 *  - `POST /v2` body `{ query: "query { boards (ids: [123]) { items_page
 *    (limit: 25) { items { id name } } } }" }` → `{ data: { boards: [{
 *    items_page: { items: [{ id, name }] } }] } }`.
 *  - Lỗi GraphQL: `{ errors: [{ message }] }` → client ném lỗi với message đó.
 *  - Auth: header `Authorization: Bearer <API token>`.
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

export const MONDAY_API_BASE = 'https://api.monday.com/v2';
export const MONDAY_API_VERSION = '2024-01';

export type MondayApiOptions = ReadClientOptions;

export interface MondayBoard {
  id: string;
  name?: string;
  state?: string;
}

export interface MondayItem {
  id: string;
  name?: string;
}

async function mondayGraphQL(
  opts: MondayApiOptions,
  query: string,
  context: string,
): Promise<Record<string, unknown>> {
  const rec = await callJsonObject('Monday', opts, MONDAY_API_BASE, context, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.token}`,
      'Content-Type': 'application/json',
      'API-Version': MONDAY_API_VERSION,
    },
    body: JSON.stringify({ query }),
  });
  const errors = rec['errors'];
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    const msg =
      isRecord(first) && typeof first['message'] === 'string'
        ? (first['message'] as string)
        : 'unknown GraphQL error';
    throw new Error(`Monday API GraphQL error for ${context}: ${msg}`);
  }
  const data = rec['data'];
  if (!isRecord(data)) {
    throw new Error(`Monday API returned an unexpected response (${context}).`);
  }
  return data;
}

/** Liệt kê boards của workspace. */
export async function mondayListBoards(
  opts: MondayApiOptions,
  limit = 25,
): Promise<MondayBoard[]> {
  const data = await mondayGraphQL(
    opts,
    `{ boards (limit: ${capLimit(limit, 100)}) { id name state } }`,
    'mondayListBoards',
  );
  return arrayField(data, 'boards')
    .filter((b): b is Record<string, unknown> => isRecord(b))
    .filter((b) => typeof b['id'] === 'string' || typeof b['id'] === 'number')
    .map((b) => ({
      id: String(b['id']),
      name: strField(b, 'name'),
      state: strField(b, 'state'),
    }));
}

/** Liệt kê items của một board (boardId là số, vd '1234567890'). */
export async function mondayListBoardItems(
  opts: MondayApiOptions,
  boardId: string,
  limit = 25,
): Promise<MondayItem[]> {
  requireNonEmpty(boardId, 'Monday boardId');
  if (!/^\d+$/.test(boardId.trim())) {
    throw new Error('Monday boardId is invalid (phải là id số của board, vd "1234567890").');
  }
  const data = await mondayGraphQL(
    opts,
    `query { boards (ids: [${boardId.trim()}]) { items_page (limit: ${capLimit(limit, 100)}) { items { id name } } } }`,
    'mondayListBoardItems',
  );
  const boards = arrayField(data, 'boards');
  if (boards.length === 0) return [];
  const first = boards[0];
  if (!isRecord(first)) return [];
  const itemsPage = first['items_page'];
  if (!isRecord(itemsPage)) return [];
  return arrayField(itemsPage, 'items')
    .filter((i): i is Record<string, unknown> => isRecord(i))
    .filter((i) => typeof i['id'] === 'string' || typeof i['id'] === 'number')
    .map((i) => ({
      id: String(i['id']),
      name: strField(i, 'name'),
    }));
}
