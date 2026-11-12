/**
 * MCP OAuth — OAuth 2.0 Authorization Code flow with PKCE for MCP servers
 * (v0.7, ROADMAP §2b "Xác thực MCP (OAuth cho MCP server)").
 *
 * This module is transport + crypto only. It NEVER touches the Vault
 * directly and NEVER logs a token: the host supplies a small store
 * (get/set/delete) whose keys live in the Vault namespace 'mcp-oauth'
 * (one key per server name). The host also opens the authorization URL
 * in the user's browser (or returns it for the user to open).
 *
 * Flow:
 *   1. `createPkcePair()` — random verifier + S256 challenge.
 *   2. `buildAuthorizationUrl(...)` — URL the user opens in a browser.
 *   3. `startCallbackListener(...)` — localhost HTTP listener on a
 *      random port; resolves with the `code` (+ validated `state`)
 *      when the provider redirects back, or rejects on timeout/error.
 *   4. `exchangeCodeForToken(...)` — POST the code, get the token set.
 *   5. `saveOAuthToken` / `loadOAuthToken` / `getValidAccessToken` —
 *      persist the token set through the host store; refresh it with
 *      `refreshAccessToken(...)` when expired (60s clock skew).
 *
 * Only http://127.0.0.1 loopback redirect URIs are used, and only
 * http(s) authorization/token endpoints are accepted. The `fetch`
 * implementation is injectable (`fetchFn`) so tests can use a mock
 * instead of a live provider.
 */
import { randomBytes, createHash } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export const MCP_OAUTH_VAULT_NAMESPACE = 'mcp-oauth';
/** Default callback wait: 5 minutes. The user must finish in the browser. */
export const DEFAULT_OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60_000;
/** Refresh a token this far before its real expiry (clock skew). */
export const OAUTH_EXPIRY_SKEW_MS = 60_000;

/** Token set returned by a token endpoint (subset of RFC 6749 §5.1). */
export interface McpOAuthToken {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  scope?: string;
  /** Absolute epoch ms when the access token expires (when known). */
  expiresAt?: number;
  /** Epoch ms when this token set was obtained. */
  obtainedAt: number;
}

/**
 * OAuth client config for one MCP server (public parts only — no secret
 * here). The host reads the config from its own store (e.g. the desktop
 * app's `<userData>/mcp-oauth.json`) and the client secret, when the
 * provider needs one, from the Vault (`mcp-oauth-client` namespace).
 * Passed to the coordinator inside CreateBotParams; never logged.
 */
export interface McpOAuthClientConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  /** Confidential clients only; the host reads it from the Vault. */
  clientSecret?: string;
  scope?: string;
  /** Revocation endpoint (RFC 7009), when discovered or configured. */
  revocationEndpoint?: string;
  /** Dynamic client registration endpoint (RFC 7591), when discovered. */
  registrationEndpoint?: string;
  /** Resource indicator (RFC 8707): the MCP server URL the token is for. */
  resource?: string;
}

/**
 * Minimal async key/value store supplied by the host. The host maps
 * `key` (a server name) to Vault namespace 'mcp-oauth' — e.g.
 * `vault.getSecret('mcp-oauth', serverName)`. This module never sees
 * the Vault itself and never logs a stored value.
 */
export interface McpOAuthStore {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
  delete(key: string): boolean | void | Promise<boolean | void>;
}

export type OAuthFetchFn = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

function base64url(bytes: Buffer): string {
  return bytes
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Normalise a single value / array / undefined into a string list. */
function asStringList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? [...value] : [value];
}

export interface PkcePair {
  /** Random high-entropy verifier (43–128 chars, RFC 7636). */
  verifier: string;
  /** BASE64URL(SHA-256(verifier)) — sent in the authorization request. */
  challenge: string;
}

/** Generate a fresh PKCE verifier/challenge pair (S256). */
export function createPkcePair(): PkcePair {
  const verifier = base64url(randomBytes(32)); // 43 chars
  const challenge = base64url(createHash('sha256').update(verifier, 'ascii').digest());
  return { verifier, challenge };
}

/** Random `state` value (CSRF protection for the callback). */
export function createOAuthState(): string {
  return base64url(randomBytes(16));
}

export interface AuthorizationUrlOptions {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  /** PKCE challenge (from `createPkcePair`). Required — plain flow is refused. */
  codeChallenge: string;
  scope?: string;
  state: string;
  /**
   * Resource indicator(s) (RFC 8707): the MCP server URL(s) the token
   * is bound to. Sent as one `resource` query param per value.
   */
  resource?: string | string[];
  /** Extra query params the provider needs (e.g. `audience`). Values must be strings. */
  extraParams?: Record<string, string>;
}

/**
 * Build the authorization URL the user opens in a browser.
 * Throws on a non-http(s) endpoint or missing clientId / challenge.
 * The URL itself contains no secret (only the public challenge).
 */
export function buildAuthorizationUrl(options: AuthorizationUrlOptions): string {
  const { authorizationEndpoint, clientId, redirectUri, codeChallenge, scope, state } =
    options;
  if (!clientId.trim()) throw new Error('MCP OAuth needs a clientId.');
  if (!codeChallenge.trim()) {
    throw new Error('MCP OAuth requires a PKCE code_challenge (plain flow is not supported).');
  }
  let url: URL;
  try {
    url = new URL(authorizationEndpoint);
  } catch {
    throw new Error('MCP OAuth authorization endpoint is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('MCP OAuth authorization endpoint must be http:// or https://.');
  }
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  if (scope) url.searchParams.set('scope', scope);
  for (const resource of asStringList(options.resource)) {
    url.searchParams.append('resource', resource);
  }
  for (const [key, value] of Object.entries(options.extraParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// Localhost callback listener
// ---------------------------------------------------------------------------

export interface CallbackListener {
  /** Redirect URI to put in the authorization request, e.g. `http://127.0.0.1:54321/`. */
  redirectUri: string;
  /** Port the listener actually bound to (random when `port` was 0/omitted). */
  port: number;
  /**
   * Resolves with the authorization `code` when the provider redirects
   * back with a matching `state`. Rejects on provider `error`, state
   * mismatch, or timeout. Call `close()` after the promise settles.
   */
  waitForCode(timeoutMs?: number): Promise<string>;
  /** Stop listening. Safe to call more than once. */
  close(): void;
}

/**
 * Listen on 127.0.0.1 for the OAuth redirect. The port is random by
 * default (`port: 0`) so concurrent flows never collide. Only the exact
 * `state` issued for this flow is accepted; anything else is rejected
 * with a clear error and the listener keeps waiting.
 */
export function startCallbackListener(options: {
  port?: number;
  state: string;
  /** Path the provider redirects to. Default: `/`. */
  path?: string;
}): CallbackListener {
  const { state, path: callbackPath = '/' } = options;
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (err: Error) => void = () => undefined;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // The promise may reject (bad state / provider error) before the
  // caller attaches waitForCode(); mark it handled so Node does not
  // report an unhandled rejection — waitForCode() still observes it.
  codePromise.catch(() => undefined);
  let settled = false;

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== callbackPath) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found — this is the open-bot OAuth callback listener.\n');
        return;
      }
      const error = url.searchParams.get('error');
      const errorDescription = url.searchParams.get('error_description');
      const returnedState = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<!doctype html><html><body><h1>Authorization failed</h1>' +
            '<p>The provider refused the authorization. You can close this tab.</p></body></html>',
        );
        if (!settled) {
          settled = true;
          rejectCode(
            new Error(
              `MCP OAuth authorization failed: ${error}` +
                (errorDescription ? ` — ${errorDescription}` : ''),
            ),
          );
        }
        return;
      }
      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<!doctype html><html><body><h1>State mismatch</h1>' +
            '<p>This authorization response does not match the request that started it. ' +
            'You can close this tab.</p></body></html>',
        );
        if (!settled) {
          settled = true;
          rejectCode(
            new Error(
              'MCP OAuth callback state mismatch: the response does not match this flow. ' +
                'The authorization may have been started by something else — try again.',
            ),
          );
        }
        return;
      }
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<!doctype html><html><body><h1>Missing code</h1>' +
            '<p>The provider redirected back without an authorization code. ' +
            'You can close this tab.</p></body></html>',
        );
        if (!settled) {
          settled = true;
          rejectCode(new Error('MCP OAuth callback arrived without an authorization code.'));
        }
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html><body><h1>Authorization complete</h1>' +
          '<p>open-bot received the authorization. You can close this tab and return to the app.</p></body></html>',
      );
      if (!settled) {
        settled = true;
        resolveCode(code);
      }
    } catch (err) {
      try {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Callback error.\n');
      } catch {
        // Response already gone.
      }
      if (!settled) {
        settled = true;
        rejectCode(err as Error);
      }
    }
  });

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      server.close();
    } catch {
      // Already closed.
    }
  };

  // Bind now; the redirect URI is only known once listening. Callers
  // must await `ready` before building the authorization URL.
  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });

  return {
    get redirectUri(): string {
      const address = server.address() as AddressInfo | null;
      const port = address ? address.port : (options.port ?? 0);
      return `http://127.0.0.1:${port}${callbackPath}`;
    },
    get port(): number {
      const address = server.address() as AddressInfo | null;
      return address ? address.port : (options.port ?? 0);
    },
    async waitForCode(timeoutMs: number = DEFAULT_OAUTH_CALLBACK_TIMEOUT_MS): Promise<string> {
      // Build the race (and mark it handled) SYNCHRONOUSLY, before
      // awaiting `ready`: the callback may reject the code promise
      // while the caller is still awaiting something else (e.g. the
      // fetch that triggers the redirect), and a rejection observed
      // only later would be reported as unhandled.
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `MCP OAuth callback timed out after ${timeoutMs}ms: ` +
                  'the authorization was not completed in the browser. Run mcp_auth again.',
              ),
            ),
          timeoutMs,
        );
        timer.unref?.();
      });
      const race = Promise.race([codePromise, timeout]);
      race.catch(() => undefined);
      await ready;
      try {
        return await race;
      } finally {
        if (timer) clearTimeout(timer);
        close();
      }
    },
    close,
  };
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

function assertTokenEndpoint(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('MCP OAuth token endpoint is not a valid URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('MCP OAuth token endpoint must be http:// or https://.');
  }
}

function parseTokenResponse(body: unknown, what: string): McpOAuthToken {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error(`MCP OAuth ${what}: token endpoint returned a non-object response.`);
  }
  const obj = body as Record<string, unknown>;
  if (typeof obj['error'] === 'string') {
    const desc = typeof obj['error_description'] === 'string' ? obj['error_description'] : '';
    throw new Error(
      `MCP OAuth ${what} failed: ${obj['error'] as string}${desc ? ` — ${desc}` : ''}`,
    );
  }
  if (typeof obj['access_token'] !== 'string' || !(obj['access_token'] as string)) {
    throw new Error(`MCP OAuth ${what}: token endpoint returned no access_token.`);
  }
  const obtainedAt = Date.now();
  const expiresIn =
    typeof obj['expires_in'] === 'number' && Number.isFinite(obj['expires_in'])
      ? (obj['expires_in'] as number)
      : undefined;
  const token: McpOAuthToken = {
    accessToken: obj['access_token'] as string,
    tokenType:
      typeof obj['token_type'] === 'string' ? (obj['token_type'] as string) : 'Bearer',
    obtainedAt,
  };
  if (typeof obj['refresh_token'] === 'string') token.refreshToken = obj['refresh_token'] as string;
  if (typeof obj['scope'] === 'string') token.scope = obj['scope'] as string;
  if (expiresIn !== undefined) token.expiresAt = obtainedAt + expiresIn * 1000;
  return token;
}

async function postTokenRequest(
  tokenEndpoint: string,
  params: Record<string, string | string[]>,
  fetchFn: OAuthFetchFn,
  what: string,
): Promise<McpOAuthToken> {
  assertTokenEndpoint(tokenEndpoint);
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const v of asStringList(value)) search.append(key, v);
  }
  const body = search.toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  timer.unref?.();
  let res: Response;
  try {
    res = await fetchFn(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`MCP OAuth ${what} timed out after 30s.`);
    }
    throw new Error(`MCP OAuth ${what} failed (network error: ${(err as Error).message}).`);
  } finally {
    clearTimeout(timer);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error(`MCP OAuth ${what}: token endpoint returned a non-JSON response (HTTP ${res.status}).`);
  }
  if (!res.ok) {
    // parseTokenResponse surfaces the provider's error field when present.
    parseTokenResponse(parsed, what);
    throw new Error(`MCP OAuth ${what} failed with HTTP ${res.status}.`);
  }
  return parseTokenResponse(parsed, what);
}

export interface ExchangeCodeOptions {
  tokenEndpoint: string;
  clientId: string;
  /** Confidential clients only; never put a secret in code — the host passes it. */
  clientSecret?: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  /** Resource indicator(s) (RFC 8707) sent with the token request. */
  resource?: string | string[];
  fetchFn?: OAuthFetchFn;
}

/** Exchange an authorization code for a token set (PKCE `code_verifier` required). */
export async function exchangeCodeForToken(
  options: ExchangeCodeOptions,
): Promise<McpOAuthToken> {
  const params: Record<string, string | string[]> = {
    grant_type: 'authorization_code',
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: options.clientId,
    code_verifier: options.codeVerifier,
  };
  if (options.clientSecret) params['client_secret'] = options.clientSecret;
  if (options.resource) params['resource'] = options.resource;
  return postTokenRequest(
    options.tokenEndpoint,
    params,
    options.fetchFn ?? fetch,
    'code exchange',
  );
}

export interface RefreshTokenOptions {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  scope?: string;
  /** Resource indicator(s) (RFC 8707) sent with the token request. */
  resource?: string | string[];
  fetchFn?: OAuthFetchFn;
}

/** Exchange a refresh token for a fresh token set. */
export async function refreshAccessToken(
  options: RefreshTokenOptions,
): Promise<McpOAuthToken> {
  const params: Record<string, string | string[]> = {
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
    client_id: options.clientId,
  };
  if (options.clientSecret) params['client_secret'] = options.clientSecret;
  if (options.scope) params['scope'] = options.scope;
  if (options.resource) params['resource'] = options.resource;
  return postTokenRequest(
    options.tokenEndpoint,
    params,
    options.fetchFn ?? fetch,
    'token refresh',
  );
}

// ---------------------------------------------------------------------------
// Persistence through the host store (Vault namespace 'mcp-oauth')
// ---------------------------------------------------------------------------

/** Serialize a token set for storage. The value is a JSON string; the host encrypts it in the Vault. */
export function serializeOAuthToken(token: McpOAuthToken): string {
  return JSON.stringify(token);
}

export function parseStoredOAuthToken(stored: string): McpOAuthToken | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['accessToken'] !== 'string' || !obj['accessToken']) return null;
  const token: McpOAuthToken = {
    accessToken: obj['accessToken'] as string,
    tokenType: typeof obj['tokenType'] === 'string' ? (obj['tokenType'] as string) : 'Bearer',
    obtainedAt: typeof obj['obtainedAt'] === 'number' ? (obj['obtainedAt'] as number) : Date.now(),
  };
  if (typeof obj['refreshToken'] === 'string') token.refreshToken = obj['refreshToken'] as string;
  if (typeof obj['scope'] === 'string') token.scope = obj['scope'] as string;
  if (typeof obj['expiresAt'] === 'number') token.expiresAt = obj['expiresAt'] as number;
  return token;
}

/** Save a token set for a server (host store key = server name). */
export async function saveOAuthToken(
  store: McpOAuthStore,
  serverName: string,
  token: McpOAuthToken,
): Promise<void> {
  await store.set(serverName, serializeOAuthToken(token));
}

/** Load a stored token set for a server, or null when never authorized / corrupt. */
export async function loadOAuthToken(
  store: McpOAuthStore,
  serverName: string,
): Promise<McpOAuthToken | null> {
  const stored = await store.get(serverName);
  if (stored === null || stored === undefined) return null;
  return parseStoredOAuthToken(stored);
}

/** Delete a stored token set for a server (e.g. on revoke / re-auth). */
export async function clearOAuthToken(
  store: McpOAuthStore,
  serverName: string,
): Promise<void> {
  await store.delete(serverName);
}

/** True when the access token is expired or expires within the skew window. */
export function isTokenExpired(token: McpOAuthToken, nowMs: number = Date.now()): boolean {
  if (token.expiresAt === undefined) return false; // no expiry info: assume valid
  return nowMs + OAUTH_EXPIRY_SKEW_MS >= token.expiresAt;
}

export interface ValidTokenOptions {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  /** Resource indicator(s) (RFC 8707) sent when refreshing. */
  resource?: string | string[];
  fetchFn?: OAuthFetchFn;
}

/**
 * Load a stored token and return a usable access token, refreshing it
 * first when expired (and a refresh token exists). The refreshed set is
 * saved back through the store. Returns null when the server was never
 * authorized. Throws when a refresh is needed but fails — the caller
 * should then run the full authorization flow again.
 */
export async function getValidAccessToken(
  store: McpOAuthStore,
  serverName: string,
  options: ValidTokenOptions,
): Promise<McpOAuthToken | null> {
  const token = await loadOAuthToken(store, serverName);
  if (!token) return null;
  if (!isTokenExpired(token)) return token;
  if (!token.refreshToken) {
    throw new Error(
      `MCP OAuth token for "${serverName}" is expired and has no refresh token. ` +
        'Run mcp_auth again to re-authorize.',
    );
  }
  const fresh = await refreshAccessToken({
    tokenEndpoint: options.tokenEndpoint,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    refreshToken: token.refreshToken,
    scope: token.scope,
    resource: options.resource,
    fetchFn: options.fetchFn,
  });
  // Keep the old refresh token when the provider does not rotate it.
  if (!fresh.refreshToken) fresh.refreshToken = token.refreshToken;
  await saveOAuthToken(store, serverName, fresh);
  return fresh;
}

// ===========================================================================
// OAuth discovery (v0.13, MCP spec 2025-11-25)
// RFC 9728 Protected Resource Metadata, RFC 8414 Authorization Server
// Metadata, OpenID Connect Discovery 1.0, RFC 7591 Dynamic Client
// Registration, SEP-991 Client ID Metadata Documents, SEP-835 step-up
// scope, RFC 8707 resource indicators (xem thêm ở trên).
//
// Nguyên tắc: chỉ tin metadata lấy từ URL https (hoặc http loopback
// trong test); không bao giờ log token; mọi lỗi đều là Error tiếng Việt
// rõ ràng để coordinator báo lại cho user.
// ===========================================================================

/** Timeout cho một lần fetch metadata discovery (ngắn hơn token flow). */
export const OAUTH_DISCOVERY_TIMEOUT_MS = 10_000;
/** Số lần thử tối đa cho step-up scope (tránh vòng lặp vô hạn). */
export const DEFAULT_STEP_UP_MAX_ATTEMPTS = 3;

/** Protected Resource Metadata (RFC 9728 §2). */
export interface ProtectedResourceMetadata {
  /** URL của resource — PHẢI khớp URL server đã hỏi. */
  resource: string;
  /** Authorization server(s) bảo vệ resource này. */
  authorizationServers: string[];
  scopesSupported?: string[];
  bearerMethodsSupported?: string[];
  resourceDocumentation?: string;
  /** Các field khác trong metadata được giữ nguyên, không diễn giải. */
  [key: string]: unknown;
}

/** Authorization Server Metadata (RFC 8414) / OIDC Discovery (subset). */
export interface AuthorizationServerMetadata {
  /** Issuer — PHẢI khớp origin của URL discovery khi kiểm tra được. */
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  responseTypesSupported?: string[];
  grantTypesSupported?: string[];
  codeChallengeMethodsSupported?: string[];
  [key: string]: unknown;
}

export type AuthorizationServerDiscoverySource = 'rfc8414' | 'oidc';

/** Kết quả discovery đầy đủ cho một MCP server (resource URL). */
export interface McpOAuthDiscovery {
  /** URL resource (MCP server) đã discovery. */
  resource: string;
  /** Metadata của resource, khi server công bố (có thể vắng). */
  resourceMetadata?: ProtectedResourceMetadata;
  /** Metadata của authorization server (luôn có khi discovery thành công). */
  authorizationServer: AuthorizationServerMetadata;
  /** Nguồn metadata của authorization server. */
  discoverySource: AuthorizationServerDiscoverySource;
  /** Endpoint rút gọn, lấy từ authorizationServer để dùng trực tiếp. */
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
}

/** Một challenge trong header `WWW-Authenticate` (vd `Bearer realm=...`). */
export interface WwwAuthenticateChallenge {
  scheme: string;
  params: Record<string, string>;
}

/**
 * Parse header `WWW-Authenticate` thành các challenge. Hỗ trợ nhiều
 * challenge nối nhau và giá trị có dấu ngoặc kép (vd
 * `Bearer resource_metadata="https://...", scope="read write"`).
 * Header hỏng → trả về mảng rỗng, không throw.
 */
export function parseWwwAuthenticate(header: string | null | undefined): WwwAuthenticateChallenge[] {
  if (!header || !header.trim()) return [];
  const challenges: WwwAuthenticateChallenge[] = [];
  let current: WwwAuthenticateChallenge | null = null;
  // Tách theo dấu phẩy ngoài dấu ngoặc kép, rồi tách scheme/param.
  const parts: string[] = [];
  let buf = '';
  let inQuotes = false;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i] as string;
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === ',' && !inQuotes) {
      parts.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) parts.push(buf);
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;
    const eqIdx = part.indexOf('=');
    if (eqIdx > 0 && current) {
      // Tham số key=value của challenge hiện tại.
      const key = part.slice(0, eqIdx).trim().toLowerCase();
      let value = part.slice(eqIdx + 1).trim();
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
      if (key) current.params[key] = value;
      continue;
    }
    // Challenge mới: "Scheme ..." hoặc "Scheme" đơn độc.
    const spaceIdx = part.indexOf(' ');
    const scheme = (spaceIdx >= 0 ? part.slice(0, spaceIdx) : part).trim();
    if (!scheme) continue;
    current = { scheme, params: {} };
    challenges.push(current);
    if (spaceIdx >= 0) {
      const rest = part.slice(spaceIdx + 1).trim();
      const restEq = rest.indexOf('=');
      if (restEq > 0) {
        const key = rest.slice(0, restEq).trim().toLowerCase();
        let value = rest.slice(restEq + 1).trim();
        if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
          value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
        if (key) current.params[key] = value;
      }
    }
  }
  return challenges;
}

/** Lấy challenge `Bearer` đầu tiên trong header `WWW-Authenticate`. */
export function findBearerChallenge(
  header: string | null | undefined,
): WwwAuthenticateChallenge | undefined {
  return parseWwwAuthenticate(header).find(
    (c) => c.scheme.toLowerCase() === 'bearer',
  );
}

/** Scope server đòi thêm (SEP-835 step-up), parse từ `WWW-Authenticate`. */
export function parseStepUpScope(header: string | null | undefined): string[] {
  const challenge = findBearerChallenge(header);
  const scope = challenge?.params['scope'];
  if (!scope) return [];
  return scope.split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

/** URL metadata của resource trong `WWW-Authenticate` (`resource_metadata`). */
export function parseResourceMetadataUrl(
  header: string | null | undefined,
): string | undefined {
  const challenge = findBearerChallenge(header);
  const url = challenge?.params['resource_metadata'];
  return url && url.trim() ? url.trim() : undefined;
}

function assertHttpUrl(url: string, what: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`MCP OAuth discovery: ${what} không phải URL hợp lệ.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`MCP OAuth discovery: ${what} phải là http:// hoặc https://.`);
  }
  return parsed;
}

async function fetchJsonDocument(
  url: string,
  fetchFn: OAuthFetchFn,
  what: string,
  timeoutMs: number = OAUTH_DISCOVERY_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  assertHttpUrl(url, what);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`MCP OAuth discovery: ${what} hết thời gian sau ${timeoutMs}ms.`);
    }
    throw new Error(`MCP OAuth discovery: không tải được ${what} (${(err as Error).message}).`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`MCP OAuth discovery: ${what} trả về HTTP ${res.status}.`);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error(`MCP OAuth discovery: ${what} không phải JSON hợp lệ.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`MCP OAuth discovery: ${what} không phải object JSON.`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Các URL well-known ứng viên cho một URL gốc, theo thứ tự ưu tiên của
 * spec 2025-11-25: chèn well-known vào trước path (path insertion) rồi
 * mới nối vào cuối path (path appending).
 * Vd resource `https://example.com/mcp` →
 * `https://example.com/.well-known/<name>/mcp`,
 * `https://example.com/mcp/.well-known/<name>`,
 * `https://example.com/.well-known/<name>` (gốc).
 */
export function wellKnownCandidateUrls(baseUrl: string, wellKnownName: string): string[] {
  const parsed = assertHttpUrl(baseUrl, 'URL gốc');
  const origin = `${parsed.protocol}//${parsed.host}`;
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  const candidates: string[] = [];
  if (cleanPath && cleanPath !== '/') {
    candidates.push(`${origin}/.well-known/${wellKnownName}${cleanPath}`);
    candidates.push(`${origin}${cleanPath}/.well-known/${wellKnownName}`);
  }
  candidates.push(`${origin}/.well-known/${wellKnownName}`);
  return [...new Set(candidates)];
}

function validateProtectedResourceMetadata(
  raw: Record<string, unknown>,
  resourceUrl: string,
): ProtectedResourceMetadata {
  if (typeof raw['resource'] !== 'string' || !(raw['resource'] as string).trim()) {
    throw new Error('MCP OAuth discovery: Protected Resource Metadata thiếu field "resource".');
  }
  if ((raw['resource'] as string) !== resourceUrl) {
    throw new Error(
      'MCP OAuth discovery: Protected Resource Metadata trả về resource khác với server đang hỏi ' +
        '— từ chối để tránh bị lừa sang authorization server lạ.',
    );
  }
  const servers = raw['authorization_servers'];
  if (
    !Array.isArray(servers) ||
    servers.length === 0 ||
    servers.some((s) => typeof s !== 'string' || !s.trim())
  ) {
    throw new Error(
      'MCP OAuth discovery: Protected Resource Metadata thiếu "authorization_servers" hợp lệ.',
    );
  }
  const metadata: ProtectedResourceMetadata = {
    resource: raw['resource'] as string,
    authorizationServers: [...(servers as string[])],
  };
  if (Array.isArray(raw['scopes_supported'])) {
    metadata.scopesSupported = (raw['scopes_supported'] as unknown[]).filter(
      (s): s is string => typeof s === 'string',
    );
  }
  if (Array.isArray(raw['bearer_methods_supported'])) {
    metadata.bearerMethodsSupported = (raw['bearer_methods_supported'] as unknown[]).filter(
      (s): s is string => typeof s === 'string',
    );
  }
  if (typeof raw['resource_documentation'] === 'string') {
    metadata.resourceDocumentation = raw['resource_documentation'] as string;
  }
  return metadata;
}

/**
 * Fetch Protected Resource Metadata (RFC 9728) cho một MCP server.
 * Thử lần lượt các URL well-known ứng viên; URL đầu tiên trả về
 * metadata hợp lệ sẽ được dùng. Ném lỗi khi không server nào trả về
 * metadata hợp lệ (caller quyết định fallback).
 */
export async function fetchProtectedResourceMetadata(
  resourceUrl: string,
  fetchFn: OAuthFetchFn = fetch,
): Promise<ProtectedResourceMetadata> {
  assertHttpUrl(resourceUrl, 'resource URL');
  const candidates = wellKnownCandidateUrls(resourceUrl, 'oauth-protected-resource');
  const errors: string[] = [];
  for (const url of candidates) {
    try {
      const raw = await fetchJsonDocument(url, fetchFn, 'Protected Resource Metadata');
      return validateProtectedResourceMetadata(raw, resourceUrl);
    } catch (err) {
      errors.push(`${url}: ${(err as Error).message}`);
    }
  }
  throw new Error(
    'MCP OAuth discovery: không tìm được Protected Resource Metadata cho server này. ' +
      errors.join(' | '),
  );
}

function validateAuthorizationServerMetadata(
  raw: Record<string, unknown>,
  what: string,
): AuthorizationServerMetadata {
  if (typeof raw['issuer'] !== 'string' || !(raw['issuer'] as string).trim()) {
    throw new Error(`MCP OAuth discovery: ${what} thiếu field "issuer".`);
  }
  if (typeof raw['authorization_endpoint'] !== 'string') {
    throw new Error(`MCP OAuth discovery: ${what} thiếu "authorization_endpoint".`);
  }
  if (typeof raw['token_endpoint'] !== 'string') {
    throw new Error(`MCP OAuth discovery: ${what} thiếu "token_endpoint".`);
  }
  assertHttpUrl(raw['authorization_endpoint'] as string, 'authorization_endpoint');
  assertHttpUrl(raw['token_endpoint'] as string, 'token_endpoint');
  const metadata: AuthorizationServerMetadata = {
    issuer: raw['issuer'] as string,
    authorizationEndpoint: raw['authorization_endpoint'] as string,
    tokenEndpoint: raw['token_endpoint'] as string,
  };
  if (typeof raw['revocation_endpoint'] === 'string') {
    metadata.revocationEndpoint = raw['revocation_endpoint'] as string;
  }
  if (typeof raw['registration_endpoint'] === 'string') {
    metadata.registrationEndpoint = raw['registration_endpoint'] as string;
  }
  for (const key of [
    'scopes_supported',
    'response_types_supported',
    'grant_types_supported',
    'code_challenge_methods_supported',
  ] as const) {
    if (Array.isArray(raw[key])) {
      const values = (raw[key] as unknown[]).filter((s): s is string => typeof s === 'string');
      if (key === 'scopes_supported') metadata.scopesSupported = values;
      else if (key === 'response_types_supported') metadata.responseTypesSupported = values;
      else if (key === 'grant_types_supported') metadata.grantTypesSupported = values;
      else metadata.codeChallengeMethodsSupported = values;
    }
  }
  return metadata;
}

/**
 * Fetch Authorization Server Metadata (RFC 8414) rồi OIDC Discovery
 * cho một authorization server. Thử RFC 8414 trước, OIDC sau — mỗi loại
 * thử đủ thứ tự well-known (insertion rồi appending), như spec 2025-11-25.
 */
export async function fetchAuthorizationServerMetadata(
  authorizationServerUrl: string,
  fetchFn: OAuthFetchFn = fetch,
): Promise<{
  metadata: AuthorizationServerMetadata;
  source: AuthorizationServerDiscoverySource;
}> {
  assertHttpUrl(authorizationServerUrl, 'authorization server URL');
  const attempts: Array<{
    name: string;
    source: AuthorizationServerDiscoverySource;
  }> = [
    { name: 'oauth-authorization-server', source: 'rfc8414' },
    { name: 'openid-configuration', source: 'oidc' },
  ];
  const errors: string[] = [];
  for (const attempt of attempts) {
    for (const url of wellKnownCandidateUrls(authorizationServerUrl, attempt.name)) {
      try {
        const raw = await fetchJsonDocument(url, fetchFn, 'Authorization Server Metadata');
        return {
          metadata: validateAuthorizationServerMetadata(raw, 'Authorization Server Metadata'),
          source: attempt.source,
        };
      } catch (err) {
        errors.push(`${url}: ${(err as Error).message}`);
      }
    }
  }
  throw new Error(
    'MCP OAuth discovery: không tìm được Authorization Server Metadata (RFC 8414 / OIDC). ' +
      errors.join(' | '),
  );
}

/**
 * Discovery đầy đủ cho một MCP server: PRM → authorization server →
 * AS metadata. Khi server không công bố PRM, fallback thử AS metadata
 * ngay tại origin của resource URL. Trả về endpoint để chạy flow OAuth
 * mà host không cần cấu hình tay.
 */
export async function discoverOAuthForResource(
  resourceUrl: string,
  fetchFn: OAuthFetchFn = fetch,
): Promise<McpOAuthDiscovery> {
  assertHttpUrl(resourceUrl, 'resource URL');
  let resourceMetadata: ProtectedResourceMetadata | undefined;
  let authorizationServerUrl: string | undefined;
  try {
    resourceMetadata = await fetchProtectedResourceMetadata(resourceUrl, fetchFn);
    authorizationServerUrl = resourceMetadata.authorizationServers[0];
  } catch {
    // Không có PRM: fallback — authorization server có thể ở cùng origin.
    authorizationServerUrl = resourceUrl;
  }
  const { metadata, source } = await fetchAuthorizationServerMetadata(
    authorizationServerUrl as string,
    fetchFn,
  );
  const discovery: McpOAuthDiscovery = {
    resource: resourceUrl,
    authorizationServer: metadata,
    discoverySource: source,
    authorizationEndpoint: metadata.authorizationEndpoint,
    tokenEndpoint: metadata.tokenEndpoint,
  };
  if (resourceMetadata) discovery.resourceMetadata = resourceMetadata;
  if (metadata.revocationEndpoint) discovery.revocationEndpoint = metadata.revocationEndpoint;
  if (metadata.registrationEndpoint) discovery.registrationEndpoint = metadata.registrationEndpoint;
  if (metadata.scopesSupported) discovery.scopesSupported = [...metadata.scopesSupported];
  return discovery;
}

/**
 * Discovery từ header `WWW-Authenticate` của một response 401: khi header
 * có `resource_metadata` thì fetch thẳng URL đó; nếu không thì discovery
 * PRM như thường. Trả về `null` khi header không có gì dùng được.
 */
export async function discoverFromWwwAuthenticate(
  wwwAuthenticate: string | null | undefined,
  resourceUrl: string,
  fetchFn: OAuthFetchFn = fetch,
): Promise<McpOAuthDiscovery | null> {
  const metadataUrl = parseResourceMetadataUrl(wwwAuthenticate);
  if (metadataUrl) {
    const raw = await fetchJsonDocument(metadataUrl, fetchFn, 'Protected Resource Metadata');
    const resourceMetadata = validateProtectedResourceMetadata(raw, resourceUrl);
    const authorizationServerUrl = resourceMetadata.authorizationServers[0] as string;
    const { metadata, source } = await fetchAuthorizationServerMetadata(
      authorizationServerUrl,
      fetchFn,
    );
    const discovery: McpOAuthDiscovery = {
      resource: resourceUrl,
      resourceMetadata,
      authorizationServer: metadata,
      discoverySource: source,
      authorizationEndpoint: metadata.authorizationEndpoint,
      tokenEndpoint: metadata.tokenEndpoint,
    };
    if (metadata.revocationEndpoint) discovery.revocationEndpoint = metadata.revocationEndpoint;
    if (metadata.registrationEndpoint) discovery.registrationEndpoint = metadata.registrationEndpoint;
    if (metadata.scopesSupported) discovery.scopesSupported = [...metadata.scopesSupported];
    return discovery;
  }
  if (!findBearerChallenge(wwwAuthenticate)) return null;
  return discoverOAuthForResource(resourceUrl, fetchFn);
}

// ---------------------------------------------------------------------------
// Client registration: Client ID Metadata Documents (SEP-991) + DCR (RFC 7591)
// ---------------------------------------------------------------------------

/** Client ID Metadata Document (SEP-991) — JSON tại URL dùng làm client_id. */
export interface ClientIdMetadataDocument {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  grantTypes?: string[];
  responseTypes?: string[];
  scope?: string;
  tokenEndpointAuthMethod?: string;
  [key: string]: unknown;
}

export interface DynamicClientRegistration {
  clientId: string;
  clientSecret?: string;
  clientIdIssuedAt?: number;
  clientSecretExpiresAt?: number;
  registrationAccessToken?: string;
  registrationClientUri?: string;
}

/**
 * Fetch và validate một Client ID Metadata Document: URL phải là https,
 * document phải là JSON object, `client_id` trong document PHẢI khớp
 * đúng URL đã fetch (chống giả mạo), và phải có `redirect_uris`.
 */
export async function fetchClientIdMetadataDocument(
  clientIdUrl: string,
  fetchFn: OAuthFetchFn = fetch,
): Promise<ClientIdMetadataDocument> {
  const parsed = assertHttpUrl(clientIdUrl, 'client_id URL');
  if (parsed.protocol !== 'https:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    // Spec yêu cầu HTTPS cho metadata document; loopback http chỉ chấp
    // nhận trong test/môi trường dev local.
    throw new Error(
      'MCP OAuth: Client ID Metadata Document phải ở URL https:// (chỉ cho phép http loopback khi test local).',
    );
  }
  const raw = await fetchJsonDocument(clientIdUrl, fetchFn, 'Client ID Metadata Document');
  if (typeof raw['client_id'] !== 'string' || (raw['client_id'] as string) !== clientIdUrl) {
    throw new Error(
      'MCP OAuth: Client ID Metadata Document có "client_id" không khớp URL đã fetch — từ chối.',
    );
  }
  if (
    !Array.isArray(raw['redirect_uris']) ||
    (raw['redirect_uris'] as unknown[]).length === 0 ||
    (raw['redirect_uris'] as unknown[]).some((u) => typeof u !== 'string')
  ) {
    throw new Error('MCP OAuth: Client ID Metadata Document thiếu "redirect_uris" hợp lệ.');
  }
  const doc: ClientIdMetadataDocument = {
    clientId: raw['client_id'] as string,
    redirectUris: [...(raw['redirect_uris'] as string[])],
  };
  if (typeof raw['client_name'] === 'string') doc.clientName = raw['client_name'] as string;
  if (Array.isArray(raw['grant_types'])) {
    doc.grantTypes = (raw['grant_types'] as unknown[]).filter((s): s is string => typeof s === 'string');
  }
  if (Array.isArray(raw['response_types'])) {
    doc.responseTypes = (raw['response_types'] as unknown[]).filter((s): s is string => typeof s === 'string');
  }
  if (typeof raw['scope'] === 'string') doc.scope = raw['scope'] as string;
  if (typeof raw['token_endpoint_auth_method'] === 'string') {
    doc.tokenEndpointAuthMethod = raw['token_endpoint_auth_method'] as string;
  }
  return doc;
}

export interface RegisterDynamicClientOptions {
  registrationEndpoint: string;
  clientName?: string;
  redirectUris: string[];
  grantTypes?: string[];
  responseTypes?: string[];
  scope?: string;
  tokenEndpointAuthMethod?: string;
  fetchFn?: OAuthFetchFn;
}

/**
 * Dynamic Client Registration (RFC 7591): POST metadata lên
 * `registration_endpoint`, nhận về `client_id` (và `client_secret`
 * nếu server cấp cho confidential client).
 */
export async function registerDynamicClient(
  options: RegisterDynamicClientOptions,
): Promise<DynamicClientRegistration> {
  assertHttpUrl(options.registrationEndpoint, 'registration_endpoint');
  if (!options.redirectUris.length) {
    throw new Error('MCP OAuth dynamic registration cần ít nhất một redirect_uri.');
  }
  const body: Record<string, unknown> = {
    redirect_uris: options.redirectUris,
    grant_types: options.grantTypes ?? ['authorization_code', 'refresh_token'],
    response_types: options.responseTypes ?? ['code'],
    token_endpoint_auth_method: options.tokenEndpointAuthMethod ?? 'none',
  };
  if (options.clientName) body['client_name'] = options.clientName;
  if (options.scope) body['scope'] = options.scope;
  const fetchFn = options.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_DISCOVERY_TIMEOUT_MS);
  timer.unref?.();
  let res: Response;
  try {
    res = await fetchFn(options.registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error('MCP OAuth dynamic registration hết thời gian sau 10s.');
    }
    throw new Error(`MCP OAuth dynamic registration thất bại (network: ${(err as Error).message}).`);
  } finally {
    clearTimeout(timer);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error('MCP OAuth dynamic registration trả về response không phải JSON.');
  }
  if (!res.ok) {
    const obj = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
    const desc = typeof obj['error_description'] === 'string' ? ` — ${obj['error_description'] as string}` : '';
    throw new Error(
      `MCP OAuth dynamic registration thất bại: HTTP ${res.status}` +
        (typeof obj['error'] === 'string' ? ` (${obj['error'] as string}${desc})` : desc),
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('MCP OAuth dynamic registration trả về response không phải object.');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['client_id'] !== 'string' || !(obj['client_id'] as string)) {
    throw new Error('MCP OAuth dynamic registration không trả về client_id.');
  }
  const registration: DynamicClientRegistration = {
    clientId: obj['client_id'] as string,
  };
  if (typeof obj['client_secret'] === 'string') {
    registration.clientSecret = obj['client_secret'] as string;
  }
  if (typeof obj['client_id_issued_at'] === 'number') {
    registration.clientIdIssuedAt = obj['client_id_issued_at'] as number;
  }
  if (typeof obj['client_secret_expires_at'] === 'number') {
    registration.clientSecretExpiresAt = obj['client_secret_expires_at'] as number;
  }
  if (typeof obj['registration_access_token'] === 'string') {
    registration.registrationAccessToken = obj['registration_access_token'] as string;
  }
  if (typeof obj['registration_client_uri'] === 'string') {
    registration.registrationClientUri = obj['registration_client_uri'] as string;
  }
  return registration;
}

export interface ResolveOAuthClientOptions {
  /** Client đã đăng ký trước (ưu tiên cao nhất). */
  preRegisteredClientId?: string;
  preRegisteredClientSecret?: string;
  /** URL của Client ID Metadata Document (SEP-991). */
  clientIdMetadataUrl?: string;
  /** Endpoint DCR (RFC 7591) — từ discovery. */
  registrationEndpoint?: string;
  clientName?: string;
  redirectUris: string[];
  scope?: string;
  fetchFn?: OAuthFetchFn;
}

export type ResolvedOAuthClientSource = 'pre-registered' | 'metadata-document' | 'dynamic-registration';

export interface ResolvedOAuthClient {
  clientId: string;
  clientSecret?: string;
  source: ResolvedOAuthClientSource;
}

/**
 * Chọn client theo thứ tự ưu tiên của spec 2025-11-25 (SEP-991):
 * pre-registered → Client ID Metadata Document → Dynamic Client
 * Registration. Khi không còn cách nào thì throw và bảo user nhập
 * client_id tay (coordinator hiển thị hướng dẫn).
 */
export async function resolveOAuthClient(
  options: ResolveOAuthClientOptions,
): Promise<ResolvedOAuthClient> {
  if (options.preRegisteredClientId?.trim()) {
    return {
      clientId: options.preRegisteredClientId.trim(),
      clientSecret: options.preRegisteredClientSecret,
      source: 'pre-registered',
    };
  }
  if (options.clientIdMetadataUrl) {
    const doc = await fetchClientIdMetadataDocument(
      options.clientIdMetadataUrl,
      options.fetchFn ?? fetch,
    );
    return { clientId: doc.clientId, source: 'metadata-document' };
  }
  if (options.registrationEndpoint) {
    const registration = await registerDynamicClient({
      registrationEndpoint: options.registrationEndpoint,
      clientName: options.clientName,
      redirectUris: options.redirectUris,
      scope: options.scope,
      fetchFn: options.fetchFn,
    });
    return {
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      source: 'dynamic-registration',
    };
  }
  throw new Error(
    'MCP OAuth: server yêu cầu client đăng ký nhưng không có client đăng ký trước, ' +
      'không có Client ID Metadata Document và không có registration endpoint. ' +
      'Hãy nhập client_id của server này tay (hoặc liên hệ quản trị server).',
  );
}

// ---------------------------------------------------------------------------
// Step-up scope (SEP-835)
// ---------------------------------------------------------------------------

/** Gộp scope cũ + scope mới, giữ thứ tự xuất hiện, không trùng lặp. */
export function mergeScopes(existingScope: string | undefined, requiredScopes: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const scope of [...(existingScope?.split(/\s+/) ?? []), ...requiredScopes]) {
    const s = scope.trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out.join(' ');
}

/** True khi token chưa có đủ mọi scope yêu cầu. */
export function tokenNeedsStepUp(
  token: McpOAuthToken,
  requiredScopes: string[],
): boolean {
  if (requiredScopes.length === 0) return false;
  const have = new Set((token.scope ?? '').split(/\s+/).filter(Boolean));
  return requiredScopes.some((s) => !have.has(s));
}

export interface StepUpScopeOptions {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  /** Scope server đang đòi thêm (vd parse từ `WWW-Authenticate`). */
  requiredScopes: string[];
  /** Resource indicator (RFC 8707) gửi kèm khi refresh. */
  resource?: string | string[];
  /** Số lần thử tối đa (mặc định 3). Mỗi lần thử chỉ đổi scope, không đổi token. */
  maxAttempts?: number;
  /**
   * Callback tùy chọn: sau mỗi lần refresh thất bại vì thiếu scope, trả
   * về scope bổ sung cho lần thử sau. Không có callback thì chỉ thử với
   * scope đã gộp một lần rồi dừng.
   */
  extraScopesForAttempt?: (attempt: number, error: Error) => string[];
  fetchFn?: OAuthFetchFn;
}

/**
 * Step-up scope: refresh token với scope mở rộng (scope cũ + scope server
 * đòi). Giới hạn số lần thử (`maxAttempts`, mặc định 3) để không lặp vô
 * hạn khi server cứ đòi thêm. Token mới được lưu lại qua store.
 * Trả về token mới, hoặc token cũ khi đã đủ scope và còn hạn.
 * Ném lỗi khi refresh thất bại (vd `invalid_grant` → cần đăng nhập lại).
 */
export async function refreshWithStepUpScope(
  store: McpOAuthStore,
  serverName: string,
  options: StepUpScopeOptions,
): Promise<McpOAuthToken> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_STEP_UP_MAX_ATTEMPTS;
  if (maxAttempts < 1) throw new Error('MCP OAuth step-up: maxAttempts phải >= 1.');
  const token = await loadOAuthToken(store, serverName);
  if (!token) {
    throw new Error(
      `MCP OAuth step-up: server "${serverName}" chưa được authorize (không có token lưu sẵn).`,
    );
  }
  if (!token.refreshToken) {
    throw new Error(
      `MCP OAuth step-up: token của "${serverName}" không có refresh token — ` +
        'cần authorize lại để xin thêm scope.',
    );
  }
  if (!tokenNeedsStepUp(token, options.requiredScopes) && !isTokenExpired(token)) {
    return token;
  }
  let extraScopes: string[] = [];
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const scope = mergeScopes(token.scope, [...options.requiredScopes, ...extraScopes]);
    try {
      const fresh = await refreshAccessToken({
        tokenEndpoint: options.tokenEndpoint,
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        refreshToken: token.refreshToken,
        scope,
        resource: options.resource,
        fetchFn: options.fetchFn,
      });
      if (!fresh.refreshToken) fresh.refreshToken = token.refreshToken;
      await saveOAuthToken(store, serverName, fresh);
      return fresh;
    } catch (err) {
      lastError = err as Error;
      const message = lastError.message;
      const isScopeError =
        message.includes('insufficient_scope') || message.includes('invalid_scope');
      if (!isScopeError || attempt >= maxAttempts || !options.extraScopesForAttempt) {
        throw lastError;
      }
      const more = options.extraScopesForAttempt(attempt, lastError) ?? [];
      if (more.length === 0) throw lastError;
      extraScopes = [...extraScopes, ...more];
    }
  }
  throw lastError ?? new Error('MCP OAuth step-up: refresh thất bại vì lý do không rõ.');
}

// ---------------------------------------------------------------------------
// Token revocation (RFC 7009) + auth status thật (v0.13)
// ---------------------------------------------------------------------------

export type RevocationTokenTypeHint = 'access_token' | 'refresh_token';

export interface RevokeTokenOptions {
  revocationEndpoint: string;
  token: string;
  tokenTypeHint?: RevocationTokenTypeHint;
  clientId: string;
  clientSecret?: string;
  fetchFn?: OAuthFetchFn;
}

/**
 * Thu hồi một token (RFC 7009): POST `token` + `token_type_hint` lên
 * revocation endpoint. Server trả 200/204 là thành công; theo RFC, token
 * không hợp lệ cũng có thể trả 200 (server không tiết lộ token có tồn
 * tại hay không) nên mọi 2xx đều tính là thành công.
 */
export async function revokeOAuthToken(options: RevokeTokenOptions): Promise<void> {
  assertTokenEndpoint(options.revocationEndpoint);
  if (!options.token) throw new Error('MCP OAuth revocation: thiếu token để thu hồi.');
  if (!options.clientId.trim()) throw new Error('MCP OAuth revocation: thiếu clientId.');
  const params = new URLSearchParams({
    token: options.token,
    token_type_hint: options.tokenTypeHint ?? 'access_token',
    client_id: options.clientId,
  });
  if (options.clientSecret) params.set('client_secret', options.clientSecret);
  const fetchFn = options.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_DISCOVERY_TIMEOUT_MS);
  timer.unref?.();
  let res: Response;
  try {
    res = await fetchFn(options.revocationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params.toString(),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error('MCP OAuth revocation hết thời gian sau 10s.');
    }
    throw new Error(`MCP OAuth revocation thất bại (network: ${(err as Error).message}).`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 200 || res.status === 204) return;
  let detail = '';
  try {
    const parsed: unknown = await res.json();
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj['error'] === 'string') detail = ` (${obj['error'] as string})`;
    }
  } catch {
    // Body không phải JSON: bỏ qua, chỉ báo status.
  }
  throw new Error(`MCP OAuth revocation thất bại: HTTP ${res.status}${detail}.`);
}

export interface RevokeStoredTokenOptions {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  /** Endpoint revocation; khi vắng sẽ thử discovery từ token endpoint. */
  revocationEndpoint?: string;
  fetchFn?: OAuthFetchFn;
}

/**
 * Thu hồi cả access token lẫn refresh token đã lưu của một server, rồi
 * xóa token khỏi store. Thu hồi refresh token trước, access token sau;
 * một token thu hồi lỗi không chặn token còn lại. Ném lỗi chỉ khi CẢ
 * hai đều thất bại. Trả về số token đã thu hồi thành công.
 */
export async function revokeStoredOAuthToken(
  store: McpOAuthStore,
  serverName: string,
  options: RevokeStoredTokenOptions,
): Promise<{ revokedCount: number; errors: string[] }> {
  const token = await loadOAuthToken(store, serverName);
  if (!token) return { revokedCount: 0, errors: [] };
  let revocationEndpoint = options.revocationEndpoint;
  if (!revocationEndpoint) {
    // Thử discovery: authorization server thường ở cùng origin với token endpoint.
    try {
      const discovery = await fetchAuthorizationServerMetadata(
        options.tokenEndpoint,
        options.fetchFn ?? fetch,
      );
      revocationEndpoint = discovery.metadata.revocationEndpoint;
    } catch {
      // Discovery thất bại: không có endpoint để thu hồi.
    }
  }
  if (!revocationEndpoint) {
    throw new Error(
      'MCP OAuth revocation: không biết revocation endpoint của server này ' +
        '(không cấu hình và discovery cũng không tìm thấy). Token local vẫn sẽ bị xóa.',
    );
  }
  const errors: string[] = [];
  let revokedCount = 0;
  const attempts: Array<{ value: string; hint: RevocationTokenTypeHint }> = [];
  if (token.refreshToken) attempts.push({ value: token.refreshToken, hint: 'refresh_token' });
  attempts.push({ value: token.accessToken, hint: 'access_token' });
  for (const attempt of attempts) {
    try {
      await revokeOAuthToken({
        revocationEndpoint: revocationEndpoint as string,
        token: attempt.value,
        tokenTypeHint: attempt.hint,
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        fetchFn: options.fetchFn,
      });
      revokedCount++;
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  await clearOAuthToken(store, serverName);
  if (revokedCount === 0 && errors.length > 0) {
    throw new Error(
      `MCP OAuth revocation: không thu hồi được token nào của "${serverName}": ${errors.join(' | ')}`,
    );
  }
  return { revokedCount, errors };
}

export type McpAuthStatusValue =
  | 'valid'
  | 'refreshed'
  | 'expired-no-refresh'
  | 'not-authorized'
  | 'needs-reauth';

export interface McpAuthStatus {
  serverName: string;
  status: McpAuthStatusValue;
  /** True khi token đã được refresh trong lần kiểm tra này. */
  refreshed: boolean;
  scope?: string;
  expiresAt?: number;
  /** Thông báo tiếng Việt để hiển thị cho user / agent. */
  message: string;
}

/**
 * Kiểm tra trạng thái auth THẬT của một MCP server (v0.13): không chỉ
 * đọc hạn lưu sẵn mà gọi refresh khi token đã hết hạn (hoặc sắp hết).
 * - Chưa authorize bao giờ → `not-authorized`.
 * - Còn hạn → `valid`.
 * - Hết hạn + refresh được → `refreshed` (token mới đã lưu lại).
 * - Hết hạn + không có refresh token → `expired-no-refresh`.
 * - Refresh thất bại vì `invalid_grant` (token bị thu hồi / hết hiệu
 *   lực) → `needs-reauth` (user cần chạy `mcp_auth` lại).
 * Lỗi mạng / lỗi khác khi refresh → throw để caller phân biệt với
 * "hết hạn thật".
 */
export async function checkMcpAuthStatus(
  store: McpOAuthStore,
  serverName: string,
  options: ValidTokenOptions,
): Promise<McpAuthStatus> {
  const token = await loadOAuthToken(store, serverName);
  if (!token) {
    return {
      serverName,
      status: 'not-authorized',
      refreshed: false,
      message: `MCP server "${serverName}" chưa được authorize qua OAuth. Chạy mcp_auth để đăng nhập.`,
    };
  }
  if (!isTokenExpired(token)) {
    return {
      serverName,
      status: 'valid',
      refreshed: false,
      scope: token.scope,
      expiresAt: token.expiresAt,
      message: `MCP server "${serverName}" đã authorize, token còn hạn.`,
    };
  }
  if (!token.refreshToken) {
    return {
      serverName,
      status: 'expired-no-refresh',
      refreshed: false,
      scope: token.scope,
      expiresAt: token.expiresAt,
      message:
        `Token của MCP server "${serverName}" đã hết hạn và không có refresh token. ` +
        'Chạy mcp_auth để đăng nhập lại.',
    };
  }
  let fresh: McpOAuthToken;
  try {
    fresh = await refreshAccessToken({
      tokenEndpoint: options.tokenEndpoint,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      refreshToken: token.refreshToken,
      scope: token.scope,
      resource: options.resource,
      fetchFn: options.fetchFn,
    });
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes('invalid_grant')) {
      return {
        serverName,
        status: 'needs-reauth',
        refreshed: false,
        scope: token.scope,
        expiresAt: token.expiresAt,
        message:
          `Token của MCP server "${serverName}" đã bị thu hồi hoặc hết hiệu lực ` +
          '(invalid_grant). Chạy mcp_auth để đăng nhập lại.',
      };
    }
    throw err;
  }
  if (!fresh.refreshToken) fresh.refreshToken = token.refreshToken;
  await saveOAuthToken(store, serverName, fresh);
  return {
    serverName,
    status: 'refreshed',
    refreshed: true,
    scope: fresh.scope,
    expiresAt: fresh.expiresAt,
    message: `Token của MCP server "${serverName}" đã hết hạn nhưng refresh thành công, token mới đã được lưu.`,
  };
}

/** Alias ngắn cho `checkMcpAuthStatus`. */
export const getMcpAuthStatus = checkMcpAuthStatus;
