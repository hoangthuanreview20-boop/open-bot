/**
 * Generic OAuth login via the system browser + localhost callback
 * (v0.7, ROADMAP §2d: "Đăng nhập OAuth qua trình duyệt/callback").
 *
 * Flow (RFC 8252 loopback, no custom protocol needed):
 *   1. Host builds the provider auth URL (buildAuthUrl) and opens it
 *      in the SYSTEM browser (main process: shell.openExternal).
 *   2. A temporary http server listens on 127.0.0.1:<random port> and
 *      serves GET /oauth/callback?code=...&state=... — it validates
 *      the `state` (CSRF), resolves the code, then shuts itself down.
 *   3. Host exchanges the code for tokens (exchangeCodeForTokens)
 *      and stores ONLY the refresh token in the Vault namespace
 *      'oauth-refresh' (see credentials.ts). The access token is
 *      short-lived and is never persisted.
 *
 * Supported providers: Google, Slack, Microsoft. xAI has no public
 * user-OAuth flow usable from a desktop app (API-key auth only), so
 * `isOAuthSupported('xai')` is false and the UI must not offer it.
 * Adding a provider = one entry in OAUTH_PROVIDERS (auth URL,
 * token URL, scopes) — no flow code changes.
 *
 * Provider-specific notes (checked against the connectors in
 * `packages/core/src/connectors/` — scopes must cover what the
 * connector actually calls, not just what the task draft listed):
 *  - Slack (`connectors/slack.ts`): conversations.list (public AND
 *    private channels) needs `channels:read` + `groups:read`,
 *    conversations.history needs `channels:history`, chat.postMessage
 *    needs `chat:write`. Slack matches `redirect_uri` EXACTLY against
 *    the URLs registered in the Slack app, so this provider pins a
 *    fixed loopback port (`callbackPort`) — the user must register
 *    `http://127.0.0.1:54321/oauth/callback` in api.slack.com/apps.
 *    Slack returns no refresh token unless token rotation is enabled
 *    in the app; a token without `expires_in` is treated as
 *    non-expiring (see framework.ts) and used as-is.
 *  - Microsoft (`connectors/teams.ts`, Microsoft Graph): /me/joinedTeams
 *    needs `Team.ReadBasic.All`, /teams/{id}/channels needs
 *    `Team.ReadBasic.All` (or `Channel.ReadBasic.All` — both are
 *    requested), sending a channel message needs
 *    `ChannelMessage.Send`. `Chat.ReadWrite` (1:1 chats) is NOT
 *    requested: no Teams tool calls /me/chats. `User.Read` is only
 *    for the best-effort display name via /me — login still succeeds
 *    if the admin did not grant it. `offline_access` is what makes
 *    Microsoft return a refresh token. The same login can feed the
 *    Outlook connector (`connectors/outlook.ts`) via
 *    `connectorScopes.outlook` (Mail.Read + Files.Read + User.Read,
 *    read-only) — same pattern as `connectorScopes.gmail`.
 *  - Google: the default scopes (`openid profile email`) are for the
 *    user-identity login only. Gmail (`connectors/email.ts`) needs
 *    `gmail.readonly` + `gmail.send`, requested via
 *    `connectorScopes.gmail` when the host logs in for connector
 *    `gmail` (see `buildAuthUrl` `scopesOverride`) — the plain Google
 *    login keeps its narrow scopes and never gains Gmail access.
 *
 * This module never opens a browser itself and never touches the
 * Vault: the host owns both, so the flow stays testable with a real
 * localhost callback server and a mock fetch.
 */
import * as http from 'node:http';
import { randomBytes } from 'node:crypto';

export interface OAuthProviderConfig {
  id: string;
  label: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Optional userinfo endpoint (best-effort display name / email). */
  userinfoUrl?: string;
  /**
   * Extra authorize-endpoint params for this provider (merged over the
   * standard ones). Google needs `access_type=offline` for a refresh
   * token; Slack ignores both Google params, Microsoft only honours
   * `prompt`. Defaults to the Google pair when omitted.
   */
  authParams?: Record<string, string>;
  /**
   * Connector id this provider feeds (host writes the exchanged
   * TokenSet to Vault `connector`/`<connectorId>` after login).
   * Absent for Google: it serves the identity login, and Gmail via
   * `connectorScopes` below.
   */
  connectorId?: string;
  /**
   * Scope sets for a connector login through this provider, keyed by
   * connector id. The host passes the connector's scopes as
   * `scopesOverride` to buildAuthUrl; the plain identity login keeps
   * `scopes`. E.g. google + connector `gmail` -> Gmail API scopes.
   */
  connectorScopes?: Record<string, string[]>;
  /**
   * Which fields of the userinfo JSON carry the id / display name /
   * email. A list means "first present string wins". Defaults are the
   * OpenID names (`sub` / `name` / `email`); Slack answers
   * `auth.test` (`user_id` / `user`), Microsoft Graph /me answers
   * (`id` / `displayName` / `mail`, falling back to
   * `userPrincipalName`).
   */
  userinfoFields?: {
    id?: string | string[];
    name?: string | string[];
    email?: string | string[];
  };
  /**
   * Fixed loopback port for the callback server, when the provider
   * requires the redirect URI to be pre-registered exactly (Slack).
   * Omit for providers that accept any loopback port (Google,
   * Microsoft): the OS picks a free port.
   */
  callbackPort?: number;
  /** Short hint shown when no OAuth client id is configured. */
  clientSetupHint?: string;
}

/** Providers with a known OAuth flow. xAI is intentionally absent. */
export const OAUTH_PROVIDERS: Readonly<Record<string, OAuthProviderConfig>> = {
  google: {
    id: 'google',
    label: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'profile', 'email'],
    userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    authParams: { access_type: 'offline', prompt: 'consent' },
    connectorScopes: {
      gmail: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
      ],
    },
    clientSetupHint:
      'Tạo OAuth client loại Desktop app trong Google Cloud Console (console.cloud.google.com).',
  },
  slack: {
    id: 'slack',
    label: 'Slack',
    authUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    // groups:read is needed for the private channels that
    // conversations.list returns (see connectors/slack.ts).
    scopes: ['channels:read', 'groups:read', 'channels:history', 'chat:write'],
    userinfoUrl: 'https://slack.com/api/auth.test',
    authParams: {},
    connectorId: 'slack',
    userinfoFields: { id: 'user_id', name: 'user' },
    // Slack matches redirect_uri exactly: fixed port, register this
    // exact URL in the Slack app settings.
    callbackPort: 54321,
    clientSetupHint:
      'Tạo Slack app tại api.slack.com/apps, bật OAuth & Permissions, và đăng ký redirect URI http://127.0.0.1:54321/oauth/callback.',
  },
  microsoft: {
    id: 'microsoft',
    label: 'Microsoft',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: [
      'https://graph.microsoft.com/Team.ReadBasic.All',
      'https://graph.microsoft.com/Channel.ReadBasic.All',
      'https://graph.microsoft.com/ChannelMessage.Send',
      'https://graph.microsoft.com/ChannelMessage.Read.All',
      'https://graph.microsoft.com/User.Read',
      'offline_access',
    ],
    userinfoUrl: 'https://graph.microsoft.com/v1.0/me',
    authParams: { prompt: 'consent' },
    connectorId: 'teams',
    connectorScopes: {
      outlook: [
        'https://graph.microsoft.com/Mail.Read',
        'https://graph.microsoft.com/Files.Read',
        'https://graph.microsoft.com/User.Read',
        'offline_access',
      ],
    },
    userinfoFields: { id: 'id', name: 'displayName', email: ['mail', 'userPrincipalName'] },
    clientSetupHint:
      'Đăng ký app trong Microsoft Entra admin center (entra.microsoft.com), loại public client / mobile & desktop, redirect URI http://localhost.',
  },
};

export function isOAuthSupported(providerId: string): boolean {
  return providerId in OAUTH_PROVIDERS;
}

export function getOAuthProvider(providerId: string): OAuthProviderConfig {
  const cfg = OAUTH_PROVIDERS[providerId];
  if (!cfg) {
    throw new Error(
      `Provider "${providerId}" chưa hỗ trợ đăng nhập OAuth (hiện chỉ có: ${Object.keys(OAUTH_PROVIDERS).join(', ')}).`,
    );
  }
  return cfg;
}

/** Build the provider authorization URL (user opens it in a browser). */
export function buildAuthUrl(
  provider: OAuthProviderConfig,
  opts: {
    clientId: string;
    redirectUri: string;
    state: string;
    /** Scope set to request instead of `provider.scopes` (connector login, e.g. Gmail). */
    scopesOverride?: string[];
    extraParams?: Record<string, string>;
  },
): string {
  const url = new URL(provider.authUrl);
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', (opts.scopesOverride ?? provider.scopes).join(' '));
  url.searchParams.set('state', opts.state);
  // Provider-specific authorize params (Google: access_type offline +
  // prompt consent; Microsoft: prompt consent; Slack: none). Extra
  // params from the caller win over the provider defaults.
  for (const [k, v] of Object.entries(provider.authParams ?? { access_type: 'offline', prompt: 'consent' })) {
    url.searchParams.set(k, v);
  }
  for (const [k, v] of Object.entries(opts.extraParams ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

/** Random `state` value (CSRF protection for the callback). */
export function newOAuthState(): string {
  return randomBytes(16).toString('hex');
}

export interface OAuthCallbackServer {
  /** Full redirect URI to register in the auth URL, e.g. http://127.0.0.1:54321/oauth/callback */
  readonly redirectUri: string;
  readonly port: number;
  /** Resolves with the redirect URI once the server is listening (port is 0 before this). */
  whenReady(): Promise<string>;
  /** Resolves with the `code` when the provider redirects back; rejects on error/timeout. */
  waitForCode(): Promise<string>;
  stop(): Promise<void>;
}

export interface CreateOAuthCallbackServerOptions {
  /** 0 = let the OS pick a free port (default). */
  port?: number;
  /** Expected `state` value; a mismatch rejects the callback. */
  state: string;
  /** Give up after this long (default 5 minutes). */
  timeoutMs?: number;
}

/**
 * Temporary localhost callback server. Serves exactly one callback,
 * answers the browser with a short success/error page, then closes.
 * Only binds 127.0.0.1 — the code never crosses a network.
 */
export function createOAuthCallbackServer(
  options: CreateOAuthCallbackServerOptions,
): OAuthCallbackServer {
  const { state, timeoutMs = 5 * 60_000 } = options;
  let server: http.Server | null = null;
  let boundPort = 0;
  let settled = false;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectCode(new Error('Hết thời gian chờ đăng nhập OAuth (5 phút).'));
      void stopServer();
    }
  }, timeoutMs);
  timer.unref?.();

  async function stopServer(): Promise<void> {
    if (!server) return;
    const srv = server;
    server = null;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  const srv = http.createServer((req, res) => {
    const send = (status: number, title: string, body: string): void => {
      const html = `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:sans-serif;padding:2em"><h1>${title}</h1><p>${body}</p></body>`;
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    };
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/oauth/callback') {
        send(404, 'Không tìm thấy', 'Đường dẫn callback không đúng.');
        return;
      }
      const errParam = url.searchParams.get('error');
      if (errParam) {
        settled = true;
        send(400, 'Đăng nhập thất bại', 'Provider báo lỗi, bạn có thể đóng tab này.');
        rejectCode(new Error(`OAuth provider báo lỗi: ${errParam}`));
        void stopServer();
        return;
      }
      const gotState = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      if (gotState !== state) {
        settled = true;
        send(400, 'State không khớp', 'Yêu cầu đăng nhập không hợp lệ, bạn có thể đóng tab này.');
        rejectCode(new Error('OAuth state không khớp (có thể bị tấn công CSRF).'));
        void stopServer();
        return;
      }
      if (!code) {
        settled = true;
        send(400, 'Thiếu mã xác thực', 'Provider không trả về mã code, bạn có thể đóng tab này.');
        rejectCode(new Error('OAuth callback thiếu mã code.'));
        void stopServer();
        return;
      }
      settled = true;
      send(200, 'Đăng nhập xong', 'Bạn có thể đóng tab này và quay lại open-bot.');
      resolveCode(code);
      void stopServer();
    } catch {
      if (!settled) {
        settled = true;
        rejectCode(new Error('OAuth callback không hợp lệ.'));
        void stopServer();
      }
    }
  });
  server = srv;

  const ready = new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(options.port ?? 0, '127.0.0.1', () => {
      boundPort = (srv.address() as { port: number }).port;
      resolve();
    });
  });

  return {
    get redirectUri() {
      return `http://127.0.0.1:${boundPort}/oauth/callback`;
    },
    get port() {
      return boundPort;
    },
    async whenReady(): Promise<string> {
      await ready;
      return `http://127.0.0.1:${boundPort}/oauth/callback`;
    },
    async waitForCode(): Promise<string> {
      await ready;
      return codePromise;
    },
    async stop(): Promise<void> {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        rejectCode(new Error('OAuth callback server đã dừng.'));
      }
      await stopServer();
    },
  };
}

export interface TokenExchangeResult {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  /** Raw fields the provider returned (id_token etc.) — host decides what to use. */
  raw: Record<string, unknown>;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Exchange an authorization code for tokens (POST form-encoded, the
 * standard OAuth2 token endpoint shape). The caller passes its own
 * fetch (global fetch in main, a mock in tests). Throws on a
 * non-2xx response; the error message never includes the code.
 */
export async function exchangeCodeForTokens(opts: {
  tokenUrl: string;
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret?: string;
  fetchImpl?: FetchLike;
}): Promise<TokenExchangeResult> {
  const fetchFn: FetchLike =
    opts.fetchImpl ??
    (globalThis.fetch as unknown as FetchLike);
  if (typeof fetchFn !== 'function') throw new Error('OAuth cần fetch để đổi code lấy token.');
  const body = new URLSearchParams({
    code: opts.code,
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    grant_type: 'authorization_code',
  });
  // Only send client_secret when one was configured: public clients
  // (e.g. a Microsoft Entra native/desktop app) must NOT send an
  // (empty) secret, while confidential clients need theirs.
  if (opts.clientSecret) body.set('client_secret', opts.clientSecret);
  const res = await fetchFn(opts.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const desc = typeof data['error_description'] === 'string' ? data['error_description'] : '';
    const err = typeof data['error'] === 'string' ? data['error'] : `HTTP ${res.status}`;
    throw new Error(`Đổi OAuth code lấy token thất bại: ${err}${desc ? ` — ${desc}` : ''}`);
  }
  return {
    accessToken: typeof data['access_token'] === 'string' ? data['access_token'] : undefined,
    refreshToken: typeof data['refresh_token'] === 'string' ? data['refresh_token'] : undefined,
    expiresIn: typeof data['expires_in'] === 'number' ? data['expires_in'] : undefined,
    tokenType: typeof data['token_type'] === 'string' ? data['token_type'] : undefined,
    raw: data,
  };
}
