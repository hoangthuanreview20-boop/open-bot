/**
 * Dropbox read client (worker F2, v0.89b) — Dropbox API v2, chỉ đọc.
 *
 * Wire shape theo tài liệu chính thức Dropbox API
 * (developers.dropbox.com/documentation/http/documentation):
 *  - `POST /2/files/list_folder` body `{ path, recursive, limit }` →
 *    `{ entries: [{ ".tag": "file"|"folder", name, path_lower, id, size,
 *    client_modified }], cursor, has_more }`.
 *  - `POST /2/files/list_folder/continue` body `{ cursor }` → cùng shape.
 *  - `POST /2/files/get_metadata` body `{ path }` → một entry như trên.
 *  - `POST /2/files/search_v2` body `{ query, options: { max_results } }`
 *    → `{ matches: [{ metadata: { metadata: <entry>, match_type } }] }`.
 *  - Auth: header `Authorization: Bearer <access token>`,
 *    `Content-Type: application/json`. `path` rỗng = thư mục gốc.
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

export const DROPBOX_API_BASE = 'https://api.dropboxapi.com/2';

export type DropboxApiOptions = ReadClientOptions;

export interface DropboxEntry {
  /** 'file' | 'folder' | 'deleted' (field `.tag` của API). */
  tag: string;
  name: string;
  pathLower?: string;
  id?: string;
  /** Kích thước file (bytes), chỉ có với file. */
  size?: number;
  clientModified?: string;
}

export interface DropboxListResult {
  entries: DropboxEntry[];
  cursor?: string;
  hasMore: boolean;
}

function dropboxHeaders(opts: DropboxApiOptions): Record<string, string> {
  return {
    Authorization: `Bearer ${opts.token}`,
    'Content-Type': 'application/json',
  };
}

function parseEntry(raw: unknown): DropboxEntry | null {
  if (!isRecord(raw)) return null;
  if (typeof raw['name'] !== 'string') return null;
  const size = raw['size'];
  return {
    tag: typeof raw['.tag'] === 'string' ? (raw['.tag'] as string) : 'unknown',
    name: raw['name'] as string,
    pathLower: strField(raw, 'path_lower'),
    id: strField(raw, 'id'),
    size: typeof size === 'number' ? size : undefined,
    clientModified: strField(raw, 'client_modified'),
  };
}

function parseListResult(rec: Record<string, unknown>): DropboxListResult {
  return {
    entries: arrayField(rec, 'entries')
      .map((e) => parseEntry(e))
      .filter((e): e is DropboxEntry => e !== null),
    cursor: strField(rec, 'cursor'),
    hasMore: rec['has_more'] === true,
  };
}

/**
 * Liệt kê thư mục (`path` rỗng = gốc). Truyền `cursor` để lấy trang tiếp
 * (gọi `/list_folder/continue`); `recursive` liệt kê đệ quy.
 */
export async function dropboxListFolder(
  opts: DropboxApiOptions,
  path = '',
  extra: { cursor?: string; recursive?: boolean; limit?: number } = {},
): Promise<DropboxListResult> {
  if (extra.cursor) {
    const rec = await callJsonObject(
      'Dropbox',
      opts,
      `${DROPBOX_API_BASE}/files/list_folder/continue`,
      'dropboxListFolder',
      {
        method: 'POST',
        headers: dropboxHeaders(opts),
        body: JSON.stringify({ cursor: extra.cursor }),
      },
    );
    return parseListResult(rec);
  }
  const rec = await callJsonObject(
    'Dropbox',
    opts,
    `${DROPBOX_API_BASE}/files/list_folder`,
    'dropboxListFolder',
    {
      method: 'POST',
      headers: dropboxHeaders(opts),
      body: JSON.stringify({
        path,
        recursive: extra.recursive ?? false,
        limit: capLimit(extra.limit ?? 100, 2000),
      }),
    },
  );
  return parseListResult(rec);
}

/** Lấy metadata (file/folder) của một đường dẫn. */
export async function dropboxGetMetadata(
  opts: DropboxApiOptions,
  path: string,
): Promise<DropboxEntry> {
  requireNonEmpty(path, 'Dropbox path');
  const rec = await callJsonObject(
    'Dropbox',
    opts,
    `${DROPBOX_API_BASE}/files/get_metadata`,
    'dropboxGetMetadata',
    {
      method: 'POST',
      headers: dropboxHeaders(opts),
      body: JSON.stringify({ path }),
    },
  );
  const entry = parseEntry(rec);
  if (!entry) throw new Error('Dropbox API returned an unexpected metadata response (dropboxGetMetadata).');
  return entry;
}

/** Tìm file/folder theo từ khoá. */
export async function dropboxSearch(
  opts: DropboxApiOptions,
  query: string,
  maxResults = 10,
): Promise<DropboxEntry[]> {
  requireNonEmpty(query, 'Dropbox query');
  const rec = await callJsonObject(
    'Dropbox',
    opts,
    `${DROPBOX_API_BASE}/files/search_v2`,
    'dropboxSearch',
    {
      method: 'POST',
      headers: dropboxHeaders(opts),
      body: JSON.stringify({ query, options: { max_results: capLimit(maxResults, 100) } }),
    },
  );
  const out: DropboxEntry[] = [];
  for (const match of arrayField(rec, 'matches')) {
    if (!isRecord(match)) continue;
    const meta = match['metadata'];
    if (!isRecord(meta)) continue;
    const entry = parseEntry(meta['metadata']);
    if (entry) out.push(entry);
  }
  return out;
}
