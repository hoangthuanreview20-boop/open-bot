/**
 * MCP system tools for @open-bot/tools (v0.7, ROADMAP §2b):
 *  - `mcp_auth` — OAuth2 Authorization Code + PKCE flow for an MCP
 *    server: builds the authorization URL, opens it (via the host),
 *    waits for the localhost callback, exchanges the code for a
 *    token and stores it in the Vault namespace 'mcp-oauth'.
 *  - `mcp_auth_status` — shows whether an MCP server has a stored
 *    OAuth token and whether it is expired (never shows the token).
 *    v0.13: checks the REAL status — an expired token with a refresh
 *    token is refreshed on the spot and the tool says so.
 *  - `mcp_revoke` — revoke the stored OAuth tokens (access + refresh,
 *    RFC 7009) at the provider, then delete the stored token (v0.13).
 *  - `mcp_system_exec` — run a tool of the SYSTEM (sand) MCP server
 *    through a host-supplied callback, gated by an allowlist of tool
 *    names. The allowlist is empty by default: nothing runs until
 *    the host explicitly allows a tool name.
 *
 * How secrets reach these tools (never hard-coded, never read here):
 *  - OAuth tokens: the host passes `oauthStore` (get/set/delete) whose
 *    keys live in the Vault namespace 'mcp-oauth'. This module never
 *    touches the Vault or settings.json, and never logs a token.
 *  - OAuth client config (authorization/token endpoints, client id,
 *    optional client secret): the host passes `getOAuthConfig(server)`.
 *    The client secret — when a confidential client is used — comes
 *    from the host (Vault) the same way; it is never typed by the agent.
 *  - The authorization URL is opened by the host (`openUrl`) or, when
 *    no opener is wired, returned in the tool result for the user to
 *    open by hand.
 *
 * Factory (same pattern as createWebMediaTools / createGitTools):
 *   createMcpSystemTools(opts?) -> Tool[]   (bound, usable)
 *   MCP_SYSTEM_TOOLS                        (unbound placeholders)
 *
 * Approval: mcp_auth, mcp_revoke and mcp_system_exec change outside state (a token
 * is stored / revoked, a system tool runs) -> true. mcp_auth_status only reads
 * -> false.
 */
import type { Tool, ToolContext } from '@open-bot/core';
import {
  buildAuthorizationUrl,
  checkMcpAuthStatus,
  createOAuthState,
  createPkcePair,
  exchangeCodeForToken,
  getValidAccessToken,
  isTokenExpired,
  loadOAuthToken,
  revokeStoredOAuthToken,
  saveOAuthToken,
  startCallbackListener,
  DEFAULT_OAUTH_CALLBACK_TIMEOUT_MS,
} from '@open-bot/core/dist/mcp/oauth';
import type { McpOAuthStore, OAuthFetchFn } from '@open-bot/core/dist/mcp/oauth';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

// Shared helper: MAX_TOOL_RESULT_CHARS nay song o ./truncate (cung gia tri 20.000) —
// re-export de code import tu module nay khong phai sua.
export { MAX_TOOL_RESULT_CHARS };

/** OAuth client config for one MCP server, supplied by the host. */
export interface McpOAuthConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  /** Confidential clients only; the host reads it from the Vault. Never logged. */
  clientSecret?: string;
  scope?: string;
}

export type GetMcpOAuthConfig = (
  serverName: string,
) => McpOAuthConfig | null | Promise<McpOAuthConfig | null>;

/** Open the authorization URL in the user's browser (host). */
export type OpenUrlFn = (url: string) => void | Promise<void>;

/** Execute a tool of the system (sand) MCP server (host callback). */
export type CallSystemToolFn = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<string>;

export interface McpSystemToolOptions {
  /**
   * OAuth token store (host). Keys are server names; the host maps
   * them to Vault namespace 'mcp-oauth'. Required for mcp_auth /
   * mcp_auth_status; without it those tools explain the missing wiring.
   */
  oauthStore?: McpOAuthStore;
  /** OAuth client config per server (host). Required for mcp_auth. */
  getOAuthConfig?: GetMcpOAuthConfig;
  /** Open the authorization URL in the browser (host). Without it the URL is returned as text. */
  openUrl?: OpenUrlFn;
  /** Injectable fetch for the token endpoint (tests use a mock). Default: global fetch. */
  fetchFn?: OAuthFetchFn;
  /** Execute a system MCP tool (host). Required for mcp_system_exec. */
  callSystemTool?: CallSystemToolFn;
  /**
   * Allowlist of system tool names mcp_system_exec may run. Default:
   * [] (nothing allowed). The host must name each allowed tool.
   */
  allowedSystemTools?: string[];
  /** Fixed workspace directory (currently unused; kept for symmetry with other factories). */
  workspaceDir?: string;
}


function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getObjectArg(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = args[name];
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Argument "${name}" must be an object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

function getNumberArg(
  args: Record<string, unknown>,
  name: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

/**
 * Chạy đủ flow OAuth2 Authorization Code + PKCE cho một MCP server
 * (P0-4, tách ra từ `mcp_auth` để dùng chung): mở URL authorize qua
 * host (`openUrl`, hoặc trả URL trong kết quả khi không có opener),
 * chờ localhost callback, đổi code lấy token, lưu vào Vault namespace
 * 'mcp-oauth'. Trả text kết quả (không bao giờ chứa token). Ném lỗi
 * khi thiếu wiring / thiếu OAuth config / callback timeout.
 *
 * Cả `mcp_auth` và tool auth sinh riêng cho từng server (xem
 * `buildMcpServerAuthTool` trong mcpTools.ts — model tự gọi khi server
 * cần auth, theo mẫu Grok) đều gọi hàm này — một flow duy nhất.
 */
export async function runMcpAuthFlow(
  server: string,
  opts: McpSystemToolOptions,
  timeoutMs: number = 300_000,
): Promise<string> {
  if (!opts.oauthStore) {
    throw new Error(
      'MCP OAuth storage is not wired up (createMcpSystemTools needs oauthStore). ' +
        'The host must supply it — it maps server names to the Vault namespace \'mcp-oauth\'.',
    );
  }
  if (!opts.getOAuthConfig) {
    throw new Error(
      'MCP OAuth config is not wired up (createMcpSystemTools needs getOAuthConfig). ' +
        'The host must supply the authorization/token endpoints and client id per server.',
    );
  }
  const config = await opts.getOAuthConfig(server);
  if (!config) {
    throw new Error(
      `No OAuth config for MCP server "${server}": the host has no authorization/token ` +
        'endpoints + client id for it. Ask the user to configure the server\'s OAuth client first.',
    );
  }
  const pkce = createPkcePair();
  const state = createOAuthState();
  const listener = startCallbackListener({ state });
  try {
    // Wait one tick for the listener to bind so redirectUri has the real port.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OAuth callback listener failed to start.')), 5000);
      timer.unref?.();
      const check = (): void => {
        if (listener.port > 0) {
          clearTimeout(timer);
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });
    const authUrl = buildAuthorizationUrl({
      authorizationEndpoint: config.authorizationEndpoint,
      clientId: config.clientId,
      redirectUri: listener.redirectUri,
      codeChallenge: pkce.challenge,
      scope: config.scope,
      state,
    });
    let openedNote: string;
    if (opts.openUrl) {
      await opts.openUrl(authUrl);
      openedNote = 'The authorization page was opened in your browser.';
    } else {
      openedNote = `No browser opener is wired up — open this URL yourself:\n${authUrl}`;
    }
    // The user completes the authorization in the browser; the
    // provider redirects to the localhost listener with the code.
    const code = await listener.waitForCode(timeoutMs);
    const token = await exchangeCodeForToken({
      tokenEndpoint: config.tokenEndpoint,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      redirectUri: listener.redirectUri,
      codeVerifier: pkce.verifier,
      fetchFn: opts.fetchFn,
    });
    await saveOAuthToken(opts.oauthStore, server, token);
    const expiryNote =
      token.expiresAt !== undefined
        ? ` Access token expires at ${new Date(token.expiresAt).toISOString()}.`
        : ' No expiry was reported by the provider.';
    const refreshNote = token.refreshToken
      ? ' A refresh token was stored, so later calls can refresh silently.'
      : ' No refresh token was issued — re-authorize when this token expires.';
    return `MCP server "${server}" authorized via OAuth.${expiryNote}${refreshNote}\n${openedNote}`;
  } finally {
    listener.close();
  }
}

export function createMcpSystemTools(opts: McpSystemToolOptions = {}): Tool[] {
  const mcpAuth: Tool = {
    definition: toolDef(
      'mcp_auth',
      'Authorize open-bot with an MCP server via OAuth2 (Authorization Code + PKCE). ' +
        'Opens the provider authorization URL in the browser, waits for the localhost callback ' +
        '(up to timeoutSeconds), exchanges the code for a token and stores it in the Vault ' +
        '(namespace \'mcp-oauth\', one key per server). The token itself is never shown. ' +
        'Needs approval: it stores a credential and opens a browser URL.',
      {
        server: { type: 'string', description: 'MCP server name (as configured in .open-bot/mcp.json).' },
        timeoutSeconds: {
          type: 'number',
          description: 'How long to wait for the browser callback (30–600s). Default: 300.',
        },
      },
      ['server'],
    ),
    needsApproval: true,
    async execute(args, _ctx: ToolContext) {
      try {
        const server = getStringArg(args, 'server');
        const timeoutMs =
          getNumberArg(args, 'timeoutSeconds', 300, 30, 600) * 1000;
        return truncate(await runMcpAuthFlow(server, opts, timeoutMs));
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const mcpAuthStatus: Tool = {
    definition: toolDef(
      'mcp_auth_status',
      'Show the OAuth authorization status of an MCP server: whether a token is stored in the Vault ' +
        '(namespace \'mcp-oauth\'), whether it is expired, and its scope/expiry time. ' +
        'v0.13: checks the REAL status — an expired token with a refresh token is refreshed on the ' +
        'spot (and the tool says so); a refresh that fails with invalid_grant means re-authorize. ' +
        'The token value is never shown. Read-only.',
      {
        server: { type: 'string', description: 'MCP server name.' },
      },
      ['server'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const server = getStringArg(args, 'server');
        if (!opts.oauthStore) {
          return errorResult(
            'MCP OAuth storage is not wired up (createMcpSystemTools needs oauthStore).',
          );
        }
        // v0.13: real status — refreshes an expired token when a client
        // config is wired. Without a config we can only read the stored
        // token (no refresh endpoint known) — same output as before.
        // The output keeps the pre-v0.13 shape (status line, access
        // token, Expired, Expires at, Scope, Refresh token stored) so
        // existing consumers keep working; the real status only adds
        // the refresh note and the true expiry/scope after a refresh.
        const config = await opts.getOAuthConfig?.(server);
        if (config) {
          const status = await checkMcpAuthStatus(opts.oauthStore, server, {
            tokenEndpoint: config.tokenEndpoint,
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            fetchFn: opts.fetchFn,
          });
          if (status.status === 'not-authorized') {
            return `MCP server "${server}" is NOT authorized via OAuth (no token stored in the Vault namespace 'mcp-oauth'). Run mcp_auth to authorize it.`;
          }
          const stored = await loadOAuthToken(opts.oauthStore, server);
          const expired =
            status.status === 'expired-no-refresh' || status.status === 'needs-reauth';
          const lines = [
            `MCP server "${server}" OAuth status: authorized.`,
            status.message,
          ];
          if (status.refreshed) {
            lines.push('The expired token was refreshed just now and the new token was stored.');
          }
          if (stored) {
            lines.push(
              `- Access token: stored (value never shown), type: ${stored.tokenType}`,
            );
            lines.push(
              `- Expired: ${expired ? 'YES — refresh or re-authorize with mcp_auth' : 'no'}`,
            );
          }
          if (status.expiresAt !== undefined) {
            lines.push(`- Expires at: ${new Date(status.expiresAt).toISOString()}`);
          } else {
            lines.push('- Expires at: not reported by the provider');
          }
          if (status.scope) lines.push(`- Scope: ${status.scope}`);
          if (stored) {
            lines.push(`- Refresh token stored: ${stored.refreshToken ? 'yes' : 'no'}`);
          }
          return lines.join('\n');
        }
        const token = await loadOAuthToken(opts.oauthStore, server);
        if (!token) {
          return `MCP server "${server}" is NOT authorized via OAuth (no token stored in the Vault namespace 'mcp-oauth'). Run mcp_auth to authorize it.`;
        }
        const expired = isTokenExpired(token);
        const lines = [
          `MCP server "${server}" OAuth status: authorized.`,
          `- Access token: stored (value never shown), type: ${token.tokenType}`,
          `- Expired: ${expired ? 'YES — refresh or re-authorize with mcp_auth' : 'no'}`,
        ];
        if (token.expiresAt !== undefined) {
          lines.push(`- Expires at: ${new Date(token.expiresAt).toISOString()}`);
        } else {
          lines.push('- Expires at: not reported by the provider');
        }
        if (token.scope) lines.push(`- Scope: ${token.scope}`);
        lines.push(`- Refresh token stored: ${token.refreshToken ? 'yes' : 'no'}`);
        return lines.join('\n');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const mcpRevoke: Tool = {
    definition: toolDef(
      'mcp_revoke',
      'Revoke the stored OAuth tokens of an MCP server at the provider (RFC 7009: refresh token first, ' +
        'then access token) and delete the stored token from the Vault. Use when the user wants to ' +
        'disconnect a server or a token may be compromised. Needs approval: it destroys credentials.',
      {
        server: { type: 'string', description: 'MCP server name.' },
      },
      ['server'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const server = getStringArg(args, 'server');
        if (!opts.oauthStore) {
          return errorResult(
            'MCP OAuth storage is not wired up (createMcpSystemTools needs oauthStore).',
          );
        }
        const config = await opts.getOAuthConfig?.(server);
        if (!config) {
          return errorResult(
            `No OAuth client config for MCP server "${server}" — cannot find the revocation endpoint.`,
          );
        }
        const { revokedCount, errors } = await revokeStoredOAuthToken(
          opts.oauthStore,
          server,
          {
            tokenEndpoint: config.tokenEndpoint,
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            fetchFn: opts.fetchFn,
          },
        );
        if (revokedCount === 0 && errors.length === 0) {
          return `MCP server "${server}" had no stored OAuth token — nothing to revoke.`;
        }
        return (
          `Revoked ${revokedCount} token(s) for MCP server "${server}" at the provider ` +
          `and removed the stored token from the Vault.` +
          (errors.length > 0 ? ` Warnings: ${errors.join(' | ')}` : '')
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const mcpSystemExec: Tool = {
    definition: toolDef(
      'mcp_system_exec',
      'Execute a tool of the SYSTEM (sand) MCP server. Only tool names on the host-supplied allowlist ' +
        'may run (the allowlist is empty by default, so nothing runs until the host allows it). ' +
        'Needs approval: a system tool can act outside the machine. Output is truncated to 20,000 chars.',
      {
        tool: { type: 'string', description: 'Name of the system MCP tool to run (must be on the allowlist).' },
        arguments: {
          type: 'object',
          description: 'Arguments object for the tool (default: {}).',
          additionalProperties: true,
        },
      },
      ['tool'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const tool = getStringArg(args, 'tool');
        const toolArgs = getObjectArg(args, 'arguments');
        if (!opts.callSystemTool) {
          return errorResult(
            'No system MCP tool executor is wired up (createMcpSystemTools needs callSystemTool). ' +
              'The host must supply the callback that runs a tool on the system (sand) MCP server.',
          );
        }
        const allowlist = opts.allowedSystemTools ?? [];
        if (!allowlist.includes(tool)) {
          return errorResult(
            `System MCP tool "${tool}" is not on the allowlist` +
              (allowlist.length > 0
                ? ` (allowed: ${allowlist.join(', ')}).`
                : ' (the allowlist is empty — the host has allowed no system tools yet).'),
          );
        }
        const result = await opts.callSystemTool(tool, toolArgs);
        return truncate(result);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [mcpAuth, mcpAuthStatus, mcpRevoke, mcpSystemExec];
}

/** Unbound placeholders (same pattern as MCP_TOOLS / GIT_TOOLS). */
export const MCP_SYSTEM_TOOLS: Tool[] = createMcpSystemTools();

/**
 * Helper for hosts: refresh the stored token for a server when it is
 * expired, using the stored refresh token. Returns the usable token
 * set, or null when the server was never authorized. Re-exported here
 * so tool hosts do not need to import the core OAuth module directly.
 */
export { getValidAccessToken, DEFAULT_OAUTH_CALLBACK_TIMEOUT_MS };
