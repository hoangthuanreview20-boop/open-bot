/**
 * Connectors OAuth framework (v0.7) — registry connector chung + OAuth2
 * dùng chung cho mọi tích hợp bên thứ ba.
 *
 * ROADMAP §2c: "Connectors (tích hợp dịch vụ bên thứ ba qua OAuth)".
 *
 * Thiết kế:
 *  - Mỗi connector khai báo: id, label, authType (oauth2 / bearer /
 *    apiKey), scopes, authUrl, tokenUrl, và (tuỳ chọn) hàm buildAuthUrl
 *    riêng khi nhà cung cấp cần tham số đặc biệt.
 *  - OAuth2 flow dùng chung nằm Ở ĐÂY: `buildAuthorizationUrl`,
 *    `exchangeAuthorizationCode`, `refreshAccessToken` (chuẩn
 *    RFC 6749, POST application/x-www-form-urlencoded tới tokenUrl).
 *    Các hàm này DELEGATE sang `../mcp/oauth.ts` — đó là bộ triển
 *    khai OAuth2 chuẩn duy nhất trong repo (PKCE, callback localhost,
 *    parse token response, timeout 30s). Framework chỉ giữ API riêng
 *    (TokenSet/TokenStore, expiresAt dạng ISO) và 1 fallback POST
 *    local cho trường hợp đổi code KHÔNG có code_verifier (plain
 *    flow, provider cũ) — mcp/oauth từ chối plain flow nên không
 *    delegate được trường hợp đó. `auth/oauth.ts` (đăng nhập Google
 *    của user) là luồng khác — đăng nhập, không phải connector —
 *    nên vẫn giữ riêng, chỉ chia sẻ ý tưởng RFC 8252.
 *  - Token KHÔNG lưu trong module này: host cấp callback `TokenStore`
 *    (đọc/ghi/xoá). `vaultTokenStore(vault)` là adapter có sẵn: lưu
 *    token JSON vào Vault namespace `connector`, key = connector id.
 *    (Vault chỉ cho tên namespace/key khớp
 *    /^[A-Za-z0-9][A-Za-z0-9._-]*$/ nên KHÔNG dùng được namespace
 *    `connector:<id>` có dấu hai chấm — dùng namespace `connector`
 *    + key `<id>` thay thế, ba loại credential vẫn tách riêng:
 *    token phiên / OAuth refresh token / API key không trộn lẫn.)
 *  - Token không bao giờ được log: lỗi từ token endpoint chỉ ghi HTTP
 *    status, không echo body (body có thể chứa token).
 *  - v0.9 auto-refresh: `getValidAccessToken` tự refresh trước 5 phút
 *    (REFRESH_BEFORE_MS), dedup refresh đang bay theo connector id;
 *    `createConnectorTokenProvider` bọc nó thành ConnectorTokenProvider
 *    cho connector dùng; `callWithAutoRefresh` là mẫu gọi API chung:
 *    GET 401 -> force refresh + retry 1 lần, POST không retry,
 *    invalid_grant -> TokenRevokedError (báo kết nối lại).
 */

import {
  buildAuthorizationUrl as buildMcpAuthorizationUrl,
  exchangeCodeForToken,
  refreshAccessToken as refreshMcpAccessToken,
  type McpOAuthToken,
} from '../mcp/oauth.js';

export type ConnectorAuthType = 'oauth2' | 'bearer' | 'apiKey';

export interface ConnectorDefinition {
  /** Id ổn định, vd 'slack', 'gmail', 'teams'. */
  id: string;
  /** Tên hiển thị, vd 'Slack'. */
  label: string;
  /** Cách xác thực của connector này. */
  authType: ConnectorAuthType;
  /** Scope OAuth2 cần xin (rỗng khi authType không phải oauth2). */
  scopes: string[];
  /** URL trang xin phép của nhà cung cấp (oauth2). */
  authUrl?: string;
  /** URL đổi code/refresh lấy token (oauth2). */
  tokenUrl?: string;
  /**
   * Builder URL xin phép riêng của nhà cung cấp (khi cần tham số đặc
   * biệt ngoài chuẩn). Khi không có, dùng `buildAuthorizationUrl` chung.
   */
  buildAuthUrl?: (params: AuthorizationUrlParams) => string;
  /** Mô tả ngắn cho UI / hướng dẫn kết nối. */
  description?: string;
}

export interface AuthorizationUrlParams {
  clientId: string;
  redirectUri: string;
  /** Chuỗi ngẫu nhiên chống CSRF — host sinh và kiểm tra khi callback. */
  state: string;
  /** PKCE S256 code_challenge (khuyến nghị khi provider hỗ trợ). */
  codeChallenge?: string;
  /** Scope ghi đè (mặc định lấy từ definition.scopes). */
  scopes?: string[];
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Thời điểm hết hạn (ISO) — tính từ expires_in khi đổi token. */
  expiresAt?: string;
  tokenType?: string;
  /** Scope thực tế provider trả về. */
  scope?: string;
}

/** Host cấp nơi lưu token (thường là Vault qua `vaultTokenStore`). */
export interface TokenStore {
  getToken(connectorId: string): Promise<TokenSet | null>;
  setToken(connectorId: string, token: TokenSet): Promise<void>;
  clearToken(connectorId: string): Promise<void>;
}

export type FetchFn = (
  url: string,
  init?: Record<string, unknown>,
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Refresh sớm trước khi token hết hạn (v0.9): 5 phút. Token còn hạn
 * dài hơn thì dùng tiếp; token hết hạn trong 5 phút tới thì refresh
 * ngay để không hết hạn giữa chừng khi API call đang bay.
 */
export const REFRESH_BEFORE_MS = 5 * 60_000;

/**
 * Token hết hạn và không tự refresh được (không có refresh token,
 * không lấy được token mới, hoặc API vẫn 401 với token cũ). Caller
 * nên báo user thử lại, nếu vẫn lỗi thì kết nối lại. Không bao giờ
 * chứa giá trị token trong message.
 */
export class TokenExpiredError extends Error {
  readonly code = 'TOKEN_EXPIRED';
  readonly connectorId: string;
  constructor(connectorId: string, detail?: string) {
    super(
      `Token của connector "${connectorId}" đã hết hạn${detail ? ` (${detail})` : ''} và không tự refresh được — ` +
        'hãy thử lại, nếu vẫn lỗi hãy kết nối lại trong Settings → Connectors.',
    );
    this.name = 'TokenExpiredError';
    this.connectorId = connectorId;
  }
}

/**
 * Token bị thu hồi / không còn được provider chấp nhận (invalid_grant,
 * hoặc token mới vừa refresh vẫn bị API từ chối). Retry thêm chỉ vô
 * ích — user phải kết nối lại. Không bao giờ chứa giá trị token.
 */
export class TokenRevokedError extends Error {
  readonly code = 'TOKEN_REVOKED';
  readonly connectorId: string;
  constructor(connectorId: string, detail?: string) {
    super(
      `Token của connector "${connectorId}" đã bị thu hồi hoặc không còn hợp lệ${detail ? ` (${detail})` : ''} — ` +
        'hãy kết nối lại trong Settings → Connectors.',
    );
    this.name = 'TokenRevokedError';
    this.connectorId = connectorId;
  }
}

function errorCode(err: unknown): unknown {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return (err as { code: unknown }).code;
  }
  return undefined;
}

export function isTokenExpiredError(err: unknown): err is TokenExpiredError {
  return err instanceof TokenExpiredError || errorCode(err) === 'TOKEN_EXPIRED';
}

export function isTokenRevokedError(err: unknown): err is TokenRevokedError {
  return err instanceof TokenRevokedError || errorCode(err) === 'TOKEN_REVOKED';
}

/** true khi lỗi (thường từ token endpoint) mang mã invalid_grant của OAuth2. */
function isInvalidGrantError(err: unknown): boolean {
  if (err instanceof TokenRevokedError) return true;
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /invalid_grant/i.test(message);
}

/** McpOAuthToken (expiresAt dạng epoch ms) -> TokenSet (expiresAt ISO). */
function toTokenSet(token: McpOAuthToken): TokenSet {
  const out: TokenSet = { accessToken: token.accessToken };
  if (token.refreshToken) out.refreshToken = token.refreshToken;
  if (token.tokenType) out.tokenType = token.tokenType;
  if (token.scope) out.scope = token.scope;
  if (token.expiresAt !== undefined) {
    out.expiresAt = new Date(token.expiresAt).toISOString();
  }
  return out;
}

/**
 * URL xin phép OAuth2 chuẩn (response_type=code, PKCE S256 khi có).
 * Có code_challenge -> delegate sang mcp/oauth (bộ triển khai chuẩn
 * duy nhất); không có -> plain flow, build local (mcp/oauth từ chối
 * plain flow, và API này không có chỗ trả code_verifier cho host).
 */
export function buildAuthorizationUrl(
  def: ConnectorDefinition,
  params: AuthorizationUrlParams,
): string {
  if (def.buildAuthUrl) return def.buildAuthUrl(params);
  if (!def.authUrl) {
    throw new Error(`Connector "${def.id}" has no authUrl — cannot build an authorization URL.`);
  }
  if (params.codeChallenge) {
    const scopes = params.scopes ?? def.scopes;
    return buildMcpAuthorizationUrl({
      authorizationEndpoint: def.authUrl,
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scope: scopes.length > 0 ? scopes.join(' ') : undefined,
    });
  }
  const url = new URL(def.authUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  const scopes = params.scopes ?? def.scopes;
  if (scopes.length > 0) url.searchParams.set('scope', scopes.join(' '));
  return url.toString();
}

interface TokenEndpointOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  fetchFn?: FetchFn;
}

function tokenSetFromBody(body: Record<string, unknown>): TokenSet {
  if (typeof body['access_token'] !== 'string' || !body['access_token']) {
    throw new Error('OAuth token endpoint did not return an access_token.');
  }
  const out: TokenSet = { accessToken: body['access_token'] };
  if (typeof body['refresh_token'] === 'string') out.refreshToken = body['refresh_token'];
  if (typeof body['token_type'] === 'string') out.tokenType = body['token_type'];
  if (typeof body['scope'] === 'string') out.scope = body['scope'];
  if (typeof body['expires_in'] === 'number') {
    out.expiresAt = new Date(Date.now() + body['expires_in'] * 1000).toISOString();
  }
  return out;
}

async function postTokenEndpoint(
  opts: TokenEndpointOptions,
  fields: Record<string, string>,
): Promise<TokenSet> {
  const fetchFn: FetchFn =
    opts.fetchFn ??
    ((globalThis.fetch as unknown) as FetchFn);
  const body = new URLSearchParams(fields);
  if (opts.clientSecret !== undefined) body.set('client_secret', opts.clientSecret);
  let res: Awaited<ReturnType<FetchFn>>;
  try {
    res = await fetchFn(opts.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    throw new Error(`OAuth token request failed: ${(err as Error).message}`);
  }
  if (!res.ok) {
    // Không echo body: body lỗi có thể chứa token hoặc chi tiết nhạy cảm.
    throw new Error(`OAuth token endpoint returned HTTP ${res.status}.`);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error('OAuth token endpoint returned a non-JSON response.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('OAuth token endpoint returned an unexpected response shape.');
  }
  return tokenSetFromBody(parsed as Record<string, unknown>);
}

/**
 * Đổi authorization code lấy TokenSet (grant_type=authorization_code).
 * Có code_verifier -> delegate sang mcp/oauth (bộ triển khai chuẩn);
 * không có -> fallback POST local (plain flow, provider cũ).
 */
export async function exchangeAuthorizationCode(
  opts: TokenEndpointOptions & {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  },
): Promise<TokenSet> {
  if (opts.codeVerifier) {
    return toTokenSet(
      await exchangeCodeForToken({
        tokenEndpoint: opts.tokenUrl,
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        code: opts.code,
        redirectUri: opts.redirectUri,
        codeVerifier: opts.codeVerifier,
        fetchFn: opts.fetchFn as
          | ((url: string, init?: RequestInit) => Promise<Response>)
          | undefined,
      }),
    );
  }
  const fields: Record<string, string> = {
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
  };
  return postTokenEndpoint(opts, fields);
}

/** Dùng refresh_token lấy access token mới (grant_type=refresh_token). */
export async function refreshAccessToken(
  opts: TokenEndpointOptions & { refreshToken: string },
): Promise<TokenSet> {
  return toTokenSet(
    await refreshMcpAccessToken({
      tokenEndpoint: opts.tokenUrl,
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      refreshToken: opts.refreshToken,
      fetchFn: opts.fetchFn as
        | ((url: string, init?: RequestInit) => Promise<Response>)
        | undefined,
    }),
  );
}

/**
 * Refresh đang bay theo connector id — nhiều call cùng lúc khi token
 * hết hạn chỉ tạo 1 request refresh (v0.9 dedup). Promise lỗi thì bị
 * xóa khỏi map (trong finally của getValidAccessToken) để lần sau thử
 * lại được.
 */
const refreshInFlight = new Map<string, Promise<TokenSet>>();

/**
 * Đổi refresh token lấy TokenSet mới rồi ghi lại vào store (giữ lại
 * refresh token cũ khi provider không rotate). Lỗi invalid_grant
 * nghĩa là refresh token đã bị thu hồi: xóa token đã lưu để lần sau
 * không retry vô hạn, rồi ném TokenRevokedError.
 */
async function refreshAndStoreToken(
  def: ConnectorDefinition,
  store: TokenStore,
  stored: TokenSet,
  opts: { clientId: string; clientSecret?: string; fetchFn?: FetchFn },
): Promise<TokenSet> {
  let fresh: TokenSet;
  try {
    fresh = await refreshAccessToken({
      tokenUrl: def.tokenUrl as string,
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      refreshToken: stored.refreshToken as string,
      fetchFn: opts.fetchFn,
    });
  } catch (err) {
    if (isInvalidGrantError(err)) {
      try {
        await store.clearToken(def.id);
      } catch {
        // Xóa best-effort: lỗi xóa không được che lỗi gốc.
      }
      throw new TokenRevokedError(def.id, 'invalid_grant');
    }
    throw err;
  }
  const merged: TokenSet = {
    ...fresh,
    refreshToken: fresh.refreshToken ?? stored.refreshToken,
  };
  await store.setToken(def.id, merged);
  return merged;
}

/**
 * Lấy access token còn hạn từ store, tự refresh khi sắp hết hạn (cần
 * refreshToken + tokenUrl). Trả null khi chưa có token nào.
 * Token mới sau refresh được ghi lại vào store.
 *
 *  - Ngưỡng refresh: 5 phút (REFRESH_BEFORE_MS), không phải 60 s —
 *    tránh hết hạn giữa chừng khi API call đang bay.
 *  - Token không có expiresAt (token trần kiểu cũ, Slack xoxb không
 *    hết hạn): dùng tiếp, không refresh.
 *  - Token hết hạn nhưng không refresh được: trả token cũ (hành vi cũ).
 *  - `forceRefresh: true`: refresh ngay bất kể hạn (dùng cho retry
 *    sau 401), miễn là có refreshToken + tokenUrl.
 *  - Refresh đang bay được dedup theo connector id.
 */
export async function getValidAccessToken(
  def: ConnectorDefinition,
  store: TokenStore,
  opts: { clientId: string; clientSecret?: string; fetchFn?: FetchFn; forceRefresh?: boolean },
): Promise<string | null> {
  const stored = await store.getToken(def.id);
  if (!stored) return null;
  const expiresMs =
    stored.expiresAt === undefined ? undefined : new Date(stored.expiresAt).getTime();
  // Không rõ hạn (undefined) -> dùng tiếp; hạn parse không được -> coi như hết hạn.
  const nearExpiry =
    expiresMs !== undefined &&
    (Number.isNaN(expiresMs) || expiresMs <= Date.now() + REFRESH_BEFORE_MS);
  if (!opts.forceRefresh && !nearExpiry) return stored.accessToken;
  if (!stored.refreshToken || !def.tokenUrl) return stored.accessToken; // không refresh được
  const inFlight = refreshInFlight.get(def.id);
  if (inFlight) {
    const merged = await inFlight;
    return merged.accessToken;
  }
  const pending = refreshAndStoreToken(def, store, stored, opts);
  refreshInFlight.set(def.id, pending);
  try {
    const merged = await pending;
    return merged.accessToken;
  } finally {
    if (refreshInFlight.get(def.id) === pending) refreshInFlight.delete(def.id);
  }
}

// ---------------------------------------------------------------------------
// Token provider — cầu nối giữa getValidAccessToken và các connector
// ---------------------------------------------------------------------------

/**
 * Nguồn access token có auto-refresh cho một connector (v0.9). Host
 * tạo bằng `createConnectorTokenProvider` với TokenStore + client
 * credentials của mình; connector chỉ gọi `getAccessToken()`, không
 * bao giờ cầm refresh token hay client secret.
 */
export interface ConnectorTokenProvider {
  /**
   * Access token còn hạn; tự refresh trước khi hết hạn (ngưỡng 5
   * phút, dedup refresh đang bay). `forceRefresh: true` bỏ qua hạn,
   * refresh ngay — dùng khi API vừa trả 401.
   */
  getAccessToken(opts?: { forceRefresh?: boolean }): Promise<string | null>;
}

export interface ConnectorTokenProviderOptions {
  clientId: string;
  clientSecret?: string;
  fetchFn?: FetchFn;
}

/** Tạo provider cho một connector từ store + client credentials của host. */
export function createConnectorTokenProvider(
  def: ConnectorDefinition,
  store: TokenStore,
  opts: ConnectorTokenProviderOptions,
): ConnectorTokenProvider {
  return {
    getAccessToken: (callOpts?: { forceRefresh?: boolean }) =>
      getValidAccessToken(def, store, {
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        fetchFn: opts.fetchFn,
        forceRefresh: callOpts?.forceRefresh,
      }),
  };
}

// ---------------------------------------------------------------------------
// Authenticated call — auto-refresh + retry 401 dùng chung 3 connector
// ---------------------------------------------------------------------------

/** Phản hồi tối thiểu mà callWithAutoRefresh cần: đủ để đọc status + body khi 401. */
export interface MinimalFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface AutoRefreshCallOptions<T extends MinimalFetchResponse> {
  connectorId: string;
  /** HTTP method của call (mặc định 'GET'). Chỉ GET được retry sau 401. */
  method?: string;
  getToken: () => string | null | Promise<string | null>;
  tokenProvider?: ConnectorTokenProvider;
  /** Lỗi ném khi không có token nào (mỗi connector có hướng dẫn kết nối riêng). */
  noTokenError: Error;
  /** Một lần gọi API thật với token đã cho (kèm wrap lỗi mạng của connector). */
  fetchOnce: (token: string) => Promise<T>;
}

/** true khi body lỗi mang mã thu hồi của OAuth2 (Google) hoặc Slack. */
function bodyIndicatesRevoked(text: string): boolean {
  return /invalid_grant/i.test(text) || /token_revoked/i.test(text);
}

async function readBodyText(res: MinimalFetchResponse): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * Một lần gọi API đã xác thực, có auto-refresh + retry 401 (v0.9):
 *  1. Lấy token qua tokenProvider (tự refresh trước khi hết hạn,
 *     ngưỡng 5 phút, dedup) hoặc fallback getToken() khi không có
 *     provider. Provider trả null thì fallback getToken().
 *  2. Gọi API; nếu 401 và body mang invalid_grant/token_revoked ->
 *     TokenRevokedError ngay, không retry.
 *  3. Nếu 401 và method là GET -> force refresh một lần, retry đúng
 *     1 lần với token mới (chỉ retry khi token mới khác token cũ —
 *     tránh gọi lại vô ích với cùng token). Retry vẫn 401 ->
 *     TokenRevokedError (token mới vẫn bị từ chối = đã bị thu hồi),
 *     không retry lần 3.
 *  4. Nếu 401 và method không phải GET (POST gửi tin/mail không
 *     idempotent) -> KHÔNG retry, ném TokenExpiredError để caller
 *     không gửi trùng.
 * Lỗi khác 401 được trả nguyên về cho connector xử lý như cũ.
 */
export async function callWithAutoRefresh<T extends MinimalFetchResponse>(
  opts: AutoRefreshCallOptions<T>,
): Promise<T> {
  const method = (opts.method ?? 'GET').toUpperCase();
  let token: string | null = null;
  if (opts.tokenProvider) token = await opts.tokenProvider.getAccessToken();
  if (!token) token = await opts.getToken();
  if (!token) throw opts.noTokenError;

  let res = await opts.fetchOnce(token);
  if (res.status !== 401) return res;
  if (bodyIndicatesRevoked(await readBodyText(res))) {
    throw new TokenRevokedError(opts.connectorId, 'invalid_grant');
  }
  if (method !== 'GET') {
    throw new TokenExpiredError(opts.connectorId, 'không retry POST để tránh gửi trùng');
  }
  let fresh: string | null = null;
  if (opts.tokenProvider) {
    fresh = await opts.tokenProvider.getAccessToken({ forceRefresh: true });
  } else {
    fresh = await opts.getToken();
  }
  if (!fresh || fresh === token) {
    throw new TokenExpiredError(opts.connectorId, 'không lấy được token mới');
  }
  res = await opts.fetchOnce(fresh);
  if (res.status !== 401) return res;
  if (bodyIndicatesRevoked(await readBodyText(res))) {
    throw new TokenRevokedError(opts.connectorId, 'invalid_grant');
  }
  throw new TokenRevokedError(opts.connectorId, 'token mới vẫn bị từ chối');
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ConnectorRegistry {
  private readonly connectors = new Map<string, ConnectorDefinition>();

  /** Đăng ký connector. Ném lỗi khi trùng id hoặc id không hợp lệ. */
  register(def: ConnectorDefinition): void {
    if (!def || typeof def.id !== 'string' || !ID_RE.test(def.id)) {
      throw new Error(
        'Connector id must be non-empty and match /^[A-Za-z0-9][A-Za-z0-9._-]*$/.',
      );
    }
    if (!def.label || typeof def.label !== 'string') {
      throw new Error(`Connector "${def.id}" must have a non-empty label.`);
    }
    if (def.authType === 'oauth2' && (!def.authUrl || !def.tokenUrl)) {
      throw new Error(
        `OAuth2 connector "${def.id}" needs both authUrl and tokenUrl.`,
      );
    }
    if (this.connectors.has(def.id)) {
      throw new Error(`Connector "${def.id}" is already registered.`);
    }
    this.connectors.set(def.id, { ...def, scopes: [...def.scopes] });
  }

  unregister(id: string): boolean {
    return this.connectors.delete(id);
  }

  get(id: string): ConnectorDefinition | undefined {
    const def = this.connectors.get(id);
    return def ? { ...def, scopes: [...def.scopes] } : undefined;
  }

  has(id: string): boolean {
    return this.connectors.has(id);
  }

  list(): ConnectorDefinition[] {
    return [...this.connectors.values()].map((d) => ({ ...d, scopes: [...d.scopes] }));
  }

  size(): number {
    return this.connectors.size;
  }
}

/** Registry mặc định của process (host dùng khi không tự tạo registry). */
export const defaultConnectorRegistry = new ConnectorRegistry();

/** Đăng ký connector vào registry mặc định. */
export function registerConnector(def: ConnectorDefinition): void {
  defaultConnectorRegistry.register(def);
}

/** Lấy connector từ registry mặc định (undefined khi chưa đăng ký). */
export function getConnector(id: string): ConnectorDefinition | undefined {
  return defaultConnectorRegistry.get(id);
}

/** Liệt kê connector trong registry mặc định. */
export function listConnectors(): ConnectorDefinition[] {
  return defaultConnectorRegistry.list();
}

// ---------------------------------------------------------------------------
// Vault-backed TokenStore
// ---------------------------------------------------------------------------

/**
 * Adapter TokenStore trên Vault: namespace `connector`, key = connector
 * id, giá trị = JSON của TokenSet (Vault tự mã hoá). Xem ghi chú đầu
 * file về vì sao không dùng namespace `connector:<id>`.
 *
 * `vault` chỉ cần shape `{ getSecret(ns,key) / setSecret(ns,key,value) /
 * deleteSecret(ns,key) }` — tương thích class Vault ở ../vault/vault.
 */
export function vaultTokenStore(vault: {
  getSecret(namespace: string, key: string): string | null;
  setSecret(namespace: string, key: string, value: string): void;
  deleteSecret(namespace: string, key: string): boolean;
}): TokenStore {
  return {
    async getToken(connectorId: string): Promise<TokenSet | null> {
      const raw = vault.getSecret('connector', connectorId);
      if (raw === null) return null;
      try {
        const parsed = JSON.parse(raw) as TokenSet;
        if (typeof parsed.accessToken !== 'string') return null;
        return parsed;
      } catch {
        return null;
      }
    },
    async setToken(connectorId: string, token: TokenSet): Promise<void> {
      vault.setSecret('connector', connectorId, JSON.stringify(token));
    },
    async clearToken(connectorId: string): Promise<void> {
      vault.deleteSecret('connector', connectorId);
    },
  };
}
