/**
 * Salesforce read client (worker F2, v0.89b, stretch) — Salesforce REST API
 * (SOQL query), chỉ đọc.
 *
 * Wire shape theo tài liệu chính thức Salesforce REST API
 * (developer.salesforce.com/docs/apis/rest-api):
 *  - `GET {instanceUrl}/services/data/v59.0/query?q=SELECT ...` →
 *    `{ totalSize, done, records: [{ attributes: { type, url }, Id,
 *    Name, ... }] }`.
 *  - Auth: header `Authorization: Bearer <access token>` (OAuth 2.0).
 *  - `instanceUrl` là URL org của user, vd
 *    `https://mycompany.my.salesforce.com` (lấy từ kết quả login OAuth).
 *
 * Token chỉ đi trong header Authorization, KHÔNG BAO GIỜ được log.
 * SOQL chỉ cho phép câu SELECT (không INSERT/UPDATE/DELETE).
 *
 * Không có live test với token thật trong repo — test dùng mock fetch
 * (mock-verified, chưa đối chiếu live).
 */
import {
  arrayField,
  callJsonObject,
  isRecord,
  requireNonEmpty,
  type ReadClientOptions,
} from './common';

export const SALESFORCE_API_VERSION = 'v59.0';

export interface SalesforceApiOptions {
  /** URL org Salesforce, vd 'https://mycompany.my.salesforce.com'. */
  instanceUrl: string;
  /** OAuth access token của user. */
  token: string;
  /** Fetch injectable (test dùng mock; mặc định global fetch). */
  fetch?: import('./common').FetchFn;
}

export interface SalesforceQueryResult {
  totalSize: number;
  done: boolean;
  /** Records giữ nguyên shape JSON của API (fields theo câu SOQL). */
  records: Record<string, unknown>[];
}

function validateInstanceUrl(instanceUrl: string): string {
  requireNonEmpty(instanceUrl, 'Salesforce instanceUrl');
  let parsed: URL;
  try {
    parsed = new URL(instanceUrl);
  } catch {
    throw new Error('Salesforce instanceUrl is invalid (phải là URL đầy đủ, vd "https://mycompany.my.salesforce.com").');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Salesforce instanceUrl must use https.');
  }
  return instanceUrl.replace(/\/+$/, '');
}

/**
 * Chạy một câu SOQL SELECT (chỉ đọc). `soql` vd
 * `SELECT Id, Name FROM Account ORDER BY CreatedDate DESC LIMIT 10`.
 */
export async function salesforceQuery(
  opts: SalesforceApiOptions,
  soql: string,
): Promise<SalesforceQueryResult> {
  requireNonEmpty(soql, 'Salesforce SOQL');
  if (!/^\s*SELECT\b/i.test(soql)) {
    throw new Error('Salesforce SOQL must start with SELECT (client này chỉ đọc).');
  }
  const base = validateInstanceUrl(opts.instanceUrl);
  const params = new URLSearchParams({ q: soql });
  const rec = await callJsonObject(
    'Salesforce',
    opts,
    `${base}/services/data/${SALESFORCE_API_VERSION}/query?${params.toString()}`,
    'salesforceQuery',
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${opts.token}`, Accept: 'application/json' },
    },
  );
  return {
    totalSize: typeof rec['totalSize'] === 'number' ? (rec['totalSize'] as number) : 0,
    done: rec['done'] === true,
    records: arrayField(rec, 'records').filter((r): r is Record<string, unknown> => isRecord(r)),
  };
}
