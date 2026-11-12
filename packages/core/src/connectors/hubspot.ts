/**
 * HubSpot connector (v0.73) — HubSpot CRM API, OAuth 2.0 + client đọc thật.
 *
 * Endpoints theo tài liệu HubSpot (developers.hubspot.com, Working
 * with OAuth): authorize `https://app.hubspot.com/oauth/authorize`,
 * token `https://api.hubapi.com/oauth/v1/token`. Scope `oauth` luôn
 * bắt buộc kèm theo (để verify token). Lưu ý: HubSpot KHÔNG hỗ trợ
 * PKCE — luồng dùng confidential client (client_id + client_secret,
 * secret ở phía server); host không truyền code_challenge khi dùng
 * connector này.
 *
 * API đọc (chỉ đọc, không ghi) — CRM v3 `https://api.hubapi.com/crm/v3`:
 *  - `GET /objects/contacts?limit=&properties=email,firstname,lastname`
 *    — liệt kê contact.
 *  - `GET /objects/companies?limit=&properties=name,domain` — liệt kê
 *    company.
 *  - `POST /objects/contacts/search` — tìm contact theo chuỗi truy vấn
 *    (HubSpot search API chỉ có POST; body `{ query, limit, properties }`).
 *
 * Token lấy qua callback do host cấp (`getToken`, thường đọc Vault
 * namespace `connector`, key `hubspot`). Token chỉ đi trong header
 * `Authorization: Bearer …`, KHÔNG BAO GIỜ được log. Khi chưa có token,
 * hàm ném lỗi rõ ràng kèm hướng dẫn kết nối.
 *
 * Không có live test với token thật trong repo — test dùng mock fetch.
 */
import type { ConnectorDefinition, ConnectorTokenProvider } from './framework';
import { callWithAutoRefresh, registerConnector } from './framework';

export const HUBSPOT_API_BASE = 'https://api.hubapi.com/crm/v3';

/** Timeout cho một lần gọi HubSpot API (30 giây, như các connector khác). */
export const HUBSPOT_API_TIMEOUT_MS = 30_000;

export const HUBSPOT_CONNECTOR: ConnectorDefinition = {
  id: 'hubspot',
  label: 'HubSpot',
  authType: 'oauth2',
  scopes: [
    'crm.objects.contacts.read',
    'crm.objects.contacts.write',
    'crm.objects.companies.read',
    'oauth',
  ],
  authUrl: 'https://app.hubspot.com/oauth/authorize',
  tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
  description:
    'Đọc contact/company HubSpot bằng OAuth token của user. Cần tạo public app trong HubSpot Developer Account trước. HubSpot không hỗ trợ PKCE — dùng luồng confidential client với client secret.',
};

try {
  registerConnector(HUBSPOT_CONNECTOR);
} catch {
  // Đã đăng ký (module nạp 2 lần trong test) — bỏ qua.
}

export type FetchFn = typeof fetch;

export interface HubSpotApiOptions {
  /** OAuth access token HubSpot của user (callback do host cấp). */
  getToken: () => string | null | Promise<string | null>;
  /**
   * Provider token có auto-refresh (tạo bằng
   * createConnectorTokenProvider). Khi có, mỗi call lấy token qua
   * provider (tự refresh trước 5 phút, dedup; 401 thì force refresh
   * + retry 1 lần cho GET); khi không có, dùng getToken() như cũ.
   * Search là POST nên framework KHÔNG retry sau 401 (tránh gửi
   * trùng) — 401 ném TokenExpiredError để caller báo user thử lại.
   */
  tokenProvider?: ConnectorTokenProvider;
  /** Fetch injectable (test dùng mock; mặc định global fetch). */
  fetchFn?: FetchFn;
}

export interface HubSpotContact {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}

export interface HubSpotCompany {
  id: string;
  name?: string;
  domain?: string;
}

function errorNoToken(): Error {
  return new Error(
    'Chưa kết nối HubSpot: chưa có OAuth token. ' +
      'Vào Settings → Connectors → HubSpot để kết nối (public app HubSpot, scope crm.objects.contacts.read + crm.objects.companies.read + oauth), ' +
      'hoặc cấp token qua host getHubSpotToken.',
  );
}

function throwHubSpotHttpError(status: number, context: string): never {
  if (status === 403) {
    throw new Error(
      `HubSpot API: không đủ quyền (HTTP 403) cho ${context} — kiểm tra scope crm.objects.contacts.read / crm.objects.companies.read của token.`,
    );
  }
  if (status === 404) {
    throw new Error(
      `HubSpot API: không tìm thấy (HTTP 404) ${context} — kiểm tra object id hoặc endpoint.`,
    );
  }
  if (status === 429) {
    throw new Error(
      'HubSpot API: bị rate limit (HTTP 429) — HubSpot giới hạn 100 req/10s; đợi một lúc rồi thử lại.',
    );
  }
  throw new Error(`HubSpot API returned HTTP ${status} for ${context}.`);
}

async function hubspotCall(
  opts: HubSpotApiOptions,
  path: string,
  init: { method?: string; body?: Record<string, unknown> } = {},
): Promise<Record<string, unknown>> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const method = init.method ?? 'GET';
  // Auto-refresh + retry 401 (v0.9): xem callWithAutoRefresh trong
  // framework.ts — GET retry 1 lần sau force refresh, POST không retry.
  const res = await callWithAutoRefresh({
    connectorId: 'hubspot',
    method,
    getToken: opts.getToken,
    tokenProvider: opts.tokenProvider,
    noTokenError: errorNoToken(),
    fetchOnce: async (token) => {
      try {
        return await fetchFn(`${HUBSPOT_API_BASE}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
          signal: AbortSignal.timeout(HUBSPOT_API_TIMEOUT_MS),
        });
      } catch (err) {
        if ((err as Error).name === 'TimeoutError') {
          throw new Error(`HubSpot API request timed out after ${HUBSPOT_API_TIMEOUT_MS}ms.`);
        }
        throw new Error(`HubSpot API request failed: ${(err as Error).message}`);
      }
    },
  });
  if (!res.ok) throwHubSpotHttpError(res.status, path);
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error('HubSpot API returned a non-JSON response.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('HubSpot API returned an unexpected response.');
  }
  return parsed as Record<string, unknown>;
}

function propertiesOf(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null) return {};
  const props = (raw as Record<string, unknown>)['properties'];
  if (typeof props !== 'object' || props === null) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function parseResults<T>(
  rec: Record<string, unknown>,
  map: (id: string, props: Record<string, string>) => T,
): T[] {
  const results = rec['results'];
  if (!Array.isArray(results)) return [];
  const out: T[] = [];
  for (const item of results) {
    if (typeof item !== 'object' || item === null) continue;
    const id = (item as Record<string, unknown>)['id'];
    if (typeof id !== 'string') continue;
    out.push(map(id, propertiesOf(item)));
  }
  return out;
}

/** Liệt kê contact (mới nhất trước, mặc định 10, tối đa 100). */
export async function hubspotListContacts(
  opts: HubSpotApiOptions,
  limit = 10,
): Promise<HubSpotContact[]> {
  const capped = Math.min(Math.max(Math.floor(limit), 1), 100);
  const params = new URLSearchParams({
    limit: String(capped),
    properties: 'email,firstname,lastname',
  });
  const rec = await hubspotCall(opts, `/objects/contacts?${params.toString()}`);
  return parseResults(rec, (id, props) => ({
    id,
    email: props['email'],
    firstName: props['firstname'],
    lastName: props['lastname'],
  }));
}

/** Liệt kê company (mặc định 10, tối đa 100). */
export async function hubspotListCompanies(
  opts: HubSpotApiOptions,
  limit = 10,
): Promise<HubSpotCompany[]> {
  const capped = Math.min(Math.max(Math.floor(limit), 1), 100);
  const params = new URLSearchParams({
    limit: String(capped),
    properties: 'name,domain',
  });
  const rec = await hubspotCall(opts, `/objects/companies?${params.toString()}`);
  return parseResults(rec, (id, props) => ({
    id,
    name: props['name'],
    domain: props['domain'],
  }));
}

/**
 * Tìm contact theo chuỗi truy vấn (tìm trong email/tên). HubSpot
 * search API chỉ có POST — dùng `hubspotListContacts` khi chỉ cần
 * liệt kê.
 */
export async function hubspotSearchContacts(
  opts: HubSpotApiOptions,
  query: string,
  limit = 10,
): Promise<HubSpotContact[]> {
  if (!query) throw new Error('HubSpot search query is required.');
  const capped = Math.min(Math.max(Math.floor(limit), 1), 100);
  const rec = await hubspotCall(opts, '/objects/contacts/search', {
    method: 'POST',
    body: {
      query,
      limit: capped,
      properties: ['email', 'firstname', 'lastname'],
    },
  });
  return parseResults(rec, (id, props) => ({
    id,
    email: props['email'],
    firstName: props['firstname'],
    lastName: props['lastname'],
  }));
}
