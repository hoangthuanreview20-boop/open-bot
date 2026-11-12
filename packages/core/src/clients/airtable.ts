/**
 * Airtable read client (worker F2, v0.89b) — Airtable API, chỉ đọc.
 *
 * Wire shape theo tài liệu chính thức Airtable API
 * (airtable.com/developers/web/api):
 *  - `GET /v0/{baseId}/{tableIdOrName}?maxRecords=N&pageSize=N&
 *    filterByFormula=...&sort[0][field]=...&sort[0][direction]=asc|desc`
 *    → `{ records: [{ id, createdTime, fields: { ... } }], offset }`.
 *  - `GET /v0/{baseId}/{tableIdOrName}/{recordId}` → `{ id, createdTime,
 *    fields: { ... } }`.
 *  - Auth: header `Authorization: Bearer <personal access token>`
 *    (scope `data.records:read`).
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

export const AIRTABLE_API_BASE = 'https://api.airtable.com/v0';

export type AirtableApiOptions = ReadClientOptions;

export interface AirtableRecord {
  id: string;
  createdTime?: string;
  /** Giá trị các field (giữ nguyên kiểu JSON của API). */
  fields: Record<string, unknown>;
}

export interface AirtableListResult {
  records: AirtableRecord[];
  /** Offset phân trang — truyền lại vào lần gọi sau để lấy trang tiếp. */
  offset?: string;
}

export interface AirtableListParams {
  filterByFormula?: string;
  sortField?: string;
  sortDirection?: 'asc' | 'desc';
  maxRecords?: number;
  pageSize?: number;
  offset?: string;
}

function parseRecord(raw: unknown): AirtableRecord | null {
  if (!isRecord(raw) || typeof raw['id'] !== 'string') return null;
  const fields = raw['fields'];
  return {
    id: raw['id'] as string,
    createdTime: strField(raw, 'createdTime'),
    fields: isRecord(fields) ? fields : {},
  };
}

/** Liệt kê records của một table (có filter/sort/phân trang). */
export async function airtableListRecords(
  opts: AirtableApiOptions,
  baseId: string,
  tableIdOrName: string,
  params: AirtableListParams = {},
): Promise<AirtableListResult> {
  requireNonEmpty(baseId, 'Airtable baseId');
  requireNonEmpty(tableIdOrName, 'Airtable tableIdOrName');
  const qs = new URLSearchParams();
  if (params.filterByFormula) qs.set('filterByFormula', params.filterByFormula);
  if (params.sortField) {
    qs.set('sort[0][field]', params.sortField);
    qs.set('sort[0][direction]', params.sortDirection ?? 'asc');
  }
  if (params.maxRecords !== undefined) qs.set('maxRecords', String(capLimit(params.maxRecords, 100)));
  if (params.pageSize !== undefined) qs.set('pageSize', String(capLimit(params.pageSize, 100)));
  if (params.offset) qs.set('offset', params.offset);
  const query = qs.toString();
  const rec = await callJsonObject(
    'Airtable',
    opts,
    `${AIRTABLE_API_BASE}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}${query ? `?${query}` : ''}`,
    'airtableListRecords',
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${opts.token}`, Accept: 'application/json' },
    },
  );
  return {
    records: arrayField(rec, 'records')
      .map((r) => parseRecord(r))
      .filter((r): r is AirtableRecord => r !== null),
    offset: strField(rec, 'offset'),
  };
}

/** Đọc một record theo id. */
export async function airtableGetRecord(
  opts: AirtableApiOptions,
  baseId: string,
  tableIdOrName: string,
  recordId: string,
): Promise<AirtableRecord> {
  requireNonEmpty(baseId, 'Airtable baseId');
  requireNonEmpty(tableIdOrName, 'Airtable tableIdOrName');
  requireNonEmpty(recordId, 'Airtable recordId');
  const rec = await callJsonObject(
    'Airtable',
    opts,
    `${AIRTABLE_API_BASE}/${encodeURIComponent(baseId)}/${encodeURIComponent(tableIdOrName)}/${encodeURIComponent(recordId)}`,
    'airtableGetRecord',
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${opts.token}`, Accept: 'application/json' },
    },
  );
  const record = parseRecord(rec);
  if (!record) throw new Error('Airtable API returned an unexpected record response (airtableGetRecord).');
  return record;
}
