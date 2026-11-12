/**
 * Notion read client (worker F2, v0.89b) — Notion API, chỉ đọc.
 *
 * Wire shape theo tài liệu chính thức Notion API
 * (developers.notion.com/reference, API version 2022-06-28):
 *  - `POST /v1/search` body `{ query, page_size }` → `{ results: [{ object:
 *    'page'|'database', id, properties, url }], has_more, next_cursor }`.
 *  - `GET /v1/pages/{page_id}` → page object `{ id, object: 'page',
 *    properties, url }`.
 *  - `POST /v1/databases/{database_id}/query` body `{ page_size }` →
 *    `{ results: [page objects], has_more, next_cursor }`.
 *  - Auth: header `Authorization: Bearer <integration token>` +
 *    `Notion-Version: 2022-06-28`.
 *  - Page title: property có `type: 'title'`, mảng `title` chứa
 *    `{ plain_text }` (xem hàm extractNotionTitle).
 *
 * Token là Notion integration token (internal integration), chỉ đi trong
 * header Authorization, KHÔNG BAO GIỜ được log.
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

export const NOTION_API_BASE = 'https://api.notion.com/v1';
export const NOTION_API_VERSION = '2022-06-28';

export type NotionApiOptions = ReadClientOptions;

export interface NotionSearchResult {
  id: string;
  /** 'page' | 'database' (theo field `object` của API). */
  object: string;
  /** Title trích từ properties (undefined khi API không trả title). */
  title?: string;
  url?: string;
}

export interface NotionPage {
  id: string;
  title?: string;
  url?: string;
}

function notionHeaders(opts: NotionApiOptions): Record<string, string> {
  return {
    Authorization: `Bearer ${opts.token}`,
    'Notion-Version': NOTION_API_VERSION,
    'Content-Type': 'application/json',
  };
}

/**
 * Trích title của một page/database từ `properties`: tìm property có
 * `type: 'title'`, lấy `plain_text` của các phần tử trong mảng `title`.
 */
export function extractNotionTitle(properties: unknown): string | undefined {
  if (!isRecord(properties)) return undefined;
  for (const prop of Object.values(properties)) {
    if (!isRecord(prop) || prop['type'] !== 'title') continue;
    const titleArr = prop['title'];
    if (!Array.isArray(titleArr)) continue;
    const parts = titleArr
      .filter((t): t is Record<string, unknown> => isRecord(t))
      .map((t) => (typeof t['plain_text'] === 'string' ? (t['plain_text'] as string) : ''))
      .filter((s) => s !== '');
    if (parts.length > 0) return parts.join('');
  }
  return undefined;
}

function parseSearchResult(raw: unknown): NotionSearchResult | null {
  if (!isRecord(raw)) return null;
  if (typeof raw['id'] !== 'string') return null;
  return {
    id: raw['id'] as string,
    object: typeof raw['object'] === 'string' ? (raw['object'] as string) : 'unknown',
    title: extractNotionTitle(raw['properties']),
    url: strField(raw, 'url'),
  };
}

/** Tìm pages/databases theo từ khoá (`query` rỗng = liệt kê tất cả). */
export async function notionSearch(
  opts: NotionApiOptions,
  query = '',
  pageSize = 10,
): Promise<NotionSearchResult[]> {
  const rec = await callJsonObject('Notion', opts, `${NOTION_API_BASE}/search`, 'notionSearch', {
    method: 'POST',
    headers: notionHeaders(opts),
    body: JSON.stringify({ query, page_size: capLimit(pageSize, 100) }),
  });
  return arrayField(rec, 'results')
    .map((r) => parseSearchResult(r))
    .filter((r): r is NotionSearchResult => r !== null);
}

/** Đọc một page theo id. */
export async function notionGetPage(
  opts: NotionApiOptions,
  pageId: string,
): Promise<NotionPage> {
  requireNonEmpty(pageId, 'Notion pageId');
  const rec = await callJsonObject(
    'Notion',
    opts,
    `${NOTION_API_BASE}/pages/${encodeURIComponent(pageId)}`,
    'notionGetPage',
    { method: 'GET', headers: notionHeaders(opts) },
  );
  if (typeof rec['id'] !== 'string') {
    throw new Error('Notion API returned an unexpected page response (notionGetPage).');
  }
  return {
    id: rec['id'] as string,
    title: extractNotionTitle(rec['properties']),
    url: strField(rec, 'url'),
  };
}

/** Liệt kê các row (page) trong một database. */
export async function notionQueryDatabase(
  opts: NotionApiOptions,
  databaseId: string,
  pageSize = 10,
): Promise<NotionPage[]> {
  requireNonEmpty(databaseId, 'Notion databaseId');
  const rec = await callJsonObject(
    'Notion',
    opts,
    `${NOTION_API_BASE}/databases/${encodeURIComponent(databaseId)}/query`,
    'notionQueryDatabase',
    {
      method: 'POST',
      headers: notionHeaders(opts),
      body: JSON.stringify({ page_size: capLimit(pageSize, 100) }),
    },
  );
  return arrayField(rec, 'results')
    .map((r): NotionPage | null => {
      if (!isRecord(r) || typeof r['id'] !== 'string') return null;
      return {
        id: r['id'] as string,
        title: extractNotionTitle(r['properties']),
        url: strField(r, 'url'),
      };
    })
    .filter((r): r is NotionPage => r !== null);
}

/** Kiểm tra một search result có phải database không (dùng cho filter ở tầng trên). */
export function isNotionDatabase(result: NotionSearchResult): boolean {
  return result.object === 'database';
}
