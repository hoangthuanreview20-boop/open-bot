/**
 * MCP tools for @open-bot/tools — expose MCP servers as agent tools.
 *
 * The agent never invents a server command: a stdio server is only ever
 * spawned with the `command`/`args` from the workspace's
 * `.open-bot/mcp.json` (see `loadMcpConfig` in @open-bot/core). The agent
 * only picks a configured server *name*, a tool name, and arguments.
 *
 * Limits (v0.9 — stated in each tool description too):
 *  - POOLED CONNECTIONS: clients are cached per (workspace, server)
 *    and reused between calls; idle clients close after 5 minutes and
 *    dead ones (stdio child exited) are evicted and reconnected.
 *  - OAuth: when the host wires `oauthStore` + `getOAuthConfig` into
 *    `createMcpTools`, the Vault-backed token is attached to every HTTP
 *    request and refreshed + retried once on HTTP 401. Without that
 *    wiring only a static `Authorization` header from mcp.json is sent.
 *    Header/token values are never logged and never appear in results.
 *  - Streamable HTTP only for remote servers; the legacy SSE transport
 *    is not supported.
 *  - `mcp_call_tool` needs approval: an external MCP tool can act
 *    outside the machine, so the user must approve each call.
 *  - Auth-tool UX (v0.40, P0-4 — mẫu Grok, deep-dive §8.3): mỗi HTTP
 *    server đã cấu hình có thêm một tool `mcp_authenticate_<server>`
 *    để model tự gọi khi server cần auth (chạy flow OAuth PKCE của
 *    `mcp_auth`); lỗi auth ở `mcp_list_tools` / `mcp_call_tool` /
 *    `mcp_list_resources` / `mcp_read_resource` kèm gợi ý gọi tool đó
 *    thay vì chỉ báo lỗi 401.
 */
import type { Tool, ToolContext } from '@open-bot/core';
import { connectMcp } from '@open-bot/core/dist/mcp/client';
import type { McpClient, McpAuthProvider, McpListWarning } from '@open-bot/core/dist/mcp/types';
import { loadMcpConfig } from '@open-bot/core/dist/mcp/config';
import type { McpServerConfig } from '@open-bot/core/dist/mcp/types';
import {
  getValidAccessToken,
  loadOAuthToken,
  refreshAccessToken,
  refreshWithStepUpScope,
  saveOAuthToken,
} from '@open-bot/core/dist/mcp/oauth';
import type { ElicitationPrompt } from '@open-bot/core/dist/mcp/elicitation';
import type { McpSamplingHandler, SamplingToolExecutor } from '@open-bot/core/dist/mcp/clientHandlers';
import type {
  McpOAuthClientConfig,
  McpOAuthStore,
  OAuthFetchFn,
} from '@open-bot/core/dist/mcp/oauth';
import { runMcpAuthFlow } from './mcpSystemTools';
import type { OpenUrlFn } from './mcpSystemTools';
import { MAX_MCP_RESULT_CHARS, truncateText as truncate } from './truncate';

// Shared helper: MAX_MCP_RESULT_CHARS nay song o ./truncate (cung gia tri 20.000) —
// re-export de code import tu module nay khong phai sua.
export { MAX_MCP_RESULT_CHARS };
/** Outer timeout for `mcp_call_tool` (the client itself times out each
 *  JSON-RPC request after 30s). */
export const MCP_CALL_TIMEOUT_MS = 60_000;
/** Pooled clients idle longer than this are closed (v0.9 pool). */
export const MCP_POOL_IDLE_TIMEOUT_MS = 5 * 60_000;
/** Max pooled clients; beyond this the least-recently-used are evicted. */
export const MCP_POOL_MAX_ENTRIES = 16;

const POOLED_CONNECTION_NOTE =
  'Connection note: connections are pooled per workspace + server and reused between calls; idle connections close after 5 minutes.';

/** Host wiring for MCP OAuth (same store/config `createMcpSystemTools`
 *  receives for `mcp_auth`; see coordinator — it passes the store it
 *  already has to `createMcpTools` too). Without these, only a static
 *  `Authorization` header from mcp.json is sent. */
export interface McpToolsOptions {
  /** Vault-backed OAuth token store (host). Keys are server names. */
  oauthStore?: McpOAuthStore;
  /** OAuth client config per server (host): token endpoint + client id. */
  getOAuthConfig?: (
    serverName: string,
  ) => McpOAuthClientConfig | null | Promise<McpOAuthClientConfig | null>;
  /** Injectable fetch for the token endpoint (tests use a mock). Default: global fetch. */
  fetchFn?: OAuthFetchFn;
  /**
   * Open the authorization URL in the user's browser (host) — dùng cho
   * tool auth sinh riêng cho từng server (`mcp_authenticate_<server>`).
   * Không có thì URL được trả trong kết quả tool để user tự mở (như
   * `mcp_auth`). Lưu ý: coordinator hiện chỉ truyền opener này cho
   * `createMcpSystemTools`, chưa truyền cho `createMcpTools` — tới khi
   * nối, tool auth dùng đường fallback trả URL.
   */
  openUrl?: OpenUrlFn;
  /**
   * v0.70: timeout chờ callback OAuth MẶC ĐỊNH (giây) cho tool auth
   * sinh riêng cho từng server (`mcp_authenticate_<server>`). Không đặt
   * thì 300s (mặc định của `runMcpAuthFlow`); đặt thì
   * `resolveMcpAuthTimeoutSeconds` kẹp về 1–600s. Trước v0.70 tool này
   * luôn chờ đủ 300s mặc định vì không nhận timeout nào. Tool vẫn nhận
   * `timeoutSeconds` riêng cho từng lần gọi để ghi đè giá trị này.
   */
  authTimeoutSeconds?: number;
  /**
   * v0.13: ask the user when an MCP server sends `elicitation/create`.
   * The coordinator passes its own prompt (event `mcp.elicitation-needed`
   * → renderer modal → RPC `respondElicitation`). Without it the client
   * answers elicitation with `-32601` (no handler) instead of hanging.
   */
  elicitationPrompt?: ElicitationPrompt;
  /**
   * v0.18 (W10c follow-up): handler cho `sampling/createMessage` của
   * MCP server — một provider thật của bot gọi tool này. Là callback
   * (không phải handler dựng sẵn) vì pool client được tạo lười khi tool
   * chạy, còn provider của bot chỉ chắc chắn có lúc đó; trả null thì
   * client không advertise sampling (như khi không có handler).
   * v0.23: pool truyền `opts.callServerTool` (client pool gọi ngược về
   * server) để caller nối vào handler — provider gọi tool trong
   * sampling được thực thi thật thay vì lỗi "không có đường gọi tool".
   */
  getSamplingHandler?: (opts?: { callServerTool?: SamplingToolExecutor }) => McpSamplingHandler | null;
}


function errorResult(message: string): string {
  return `Error: ${message}`;
}

/**
 * Số giây — lấy từ args, có mặc định, kẹp min/max, làm tròn xuống
 * (cùng semantics với `getNumberArg` của mcpSystemTools.ts; file này
 * không import nó vì hàm đó không export).
 */
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

/** Timeout chờ callback OAuth mặc định cho tool auth per-server (giây) — bằng mặc định của `mcp_auth` / `runMcpAuthFlow`. */
export const DEFAULT_MCP_AUTH_TIMEOUT_SECONDS = 300;
/** Trần chờ callback OAuth cho tool auth per-server (giây). */
export const MAX_MCP_AUTH_TIMEOUT_SECONDS = 600;

/**
 * Timeout (giây) cho tool auth per-server từ giá trị host cấu hình
 * (`McpToolsOptions.authTimeoutSeconds`): số hữu hạn > 0 thì kẹp về
 * 1–600s, còn lại (không đặt / không phải số / NaN / vô cực / ≤ 0)
 * thì 300s mặc định. Sàn là 1s chứ không phải 30s như `mcp_auth`:
 * giá trị này và argument `timeoutSeconds` của tool đều cho phép fail
 * nhanh (môi trường tự động / test); timeout quá ngắn chỉ làm flow
 * timeout và gọi lại được với số dài hơn, không mất mát gì.
 */
export function resolveMcpAuthTimeoutSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MCP_AUTH_TIMEOUT_SECONDS;
  }
  return Math.max(1, Math.min(MAX_MCP_AUTH_TIMEOUT_SECONDS, Math.floor(value)));
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

function getObjectArg(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = args[name];
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Argument "${name}" must be an object, got ${typeof value}`);
  }
  return value as Record<string, unknown>;
}

function getServerConfig(workspaceDir: string, serverName: string): McpServerConfig {
  const config = loadMcpConfig(workspaceDir);
  const server = config.servers[serverName];
  if (!server) {
    const known = Object.keys(config.servers);
    throw new Error(
      `MCP server "${serverName}" is not configured` +
        (known.length > 0
          ? `. Configured servers: ${known.join(', ')}.`
          : '. No MCP servers are configured yet — add one to .open-bot/mcp.json in the workspace.'),
    );
  }
  return server;
}

/**
 * Build the OAuth `authProvider` the HTTP client calls per request
 * (v0.9, research §4 item 1). Without a wired store/config this returns
 * undefined and the client falls back to the static header in mcp.json.
 * The provider never logs or returns the token except as the
 * `Authorization` header value the client sends to that server only.
 */
function buildAuthProvider(
  serverName: string,
  opts?: McpToolsOptions,
): McpAuthProvider | undefined {
  if (!opts?.oauthStore || !opts?.getOAuthConfig) return undefined;
  const { oauthStore, getOAuthConfig, fetchFn } = opts;
  return async (_name, { forceRefresh } = {}) => {
    const config = await getOAuthConfig(serverName);
    if (!config) return null;
    const tokenOpts = {
      tokenEndpoint: config.tokenEndpoint,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      fetchFn,
    };
    if (forceRefresh) {
      // The server rejected the current token (HTTP 401): refresh even
      // when it is not expired yet — returning the same rejected token
      // would just 401 again.
      const stored = await loadOAuthToken(oauthStore, serverName);
      if (!stored?.refreshToken) return null;
      const fresh = await refreshAccessToken({
        ...tokenOpts,
        refreshToken: stored.refreshToken,
        scope: stored.scope,
      });
      if (!fresh.refreshToken) fresh.refreshToken = stored.refreshToken;
      await saveOAuthToken(oauthStore, serverName, fresh);
      return `${fresh.tokenType} ${fresh.accessToken}`;
    }
    const token = await getValidAccessToken(oauthStore, serverName, tokenOpts);
    if (!token) return null;
    return `${token.tokenType} ${token.accessToken}`;
  };
}

/**
 * Build the OAuth step-up handler the HTTP client calls on 401 with a
 * `WWW-Authenticate` scope challenge (v0.13): refresh the stored token
 * with the old scope + the scope the server demands, save the fresh
 * token, and return its `Authorization` value. Any failure returns
 * null so the client falls back to the plain refresh in
 * `buildAuthProvider` — step-up must never break a call that the
 * plain refresh could still save. Without a wired store/config this
 * returns undefined and the client skips step-up entirely.
 */
function buildStepUpHandler(
  serverName: string,
  workspaceDir: string,
  opts?: McpToolsOptions,
): ((scopes: string[]) => Promise<string | null>) | undefined {
  if (!opts?.oauthStore || !opts?.getOAuthConfig) return undefined;
  const { oauthStore, getOAuthConfig, fetchFn } = opts;
  return async (scopes: string[]) => {
    try {
      const config = await getOAuthConfig(serverName);
      if (!config) return null;
      const server = getServerConfig(workspaceDir, serverName);
      const token = await refreshWithStepUpScope(oauthStore, serverName, {
        tokenEndpoint: config.tokenEndpoint,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        requiredScopes: scopes,
        resource: server.url,
        fetchFn,
      });
      return `${token.tokenType} ${token.accessToken}`;
    } catch {
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// Connection pool (v0.9, research §4 item 3)
// ---------------------------------------------------------------------------

interface PooledMcpClient {
  client: McpClient | null;
  connecting: Promise<McpClient> | null;
  lastUsedMs: number;
  /**
   * v0.71 (SEP-1303 follow-up): the latest `-32602` list warning the
   * pooled client reported through `McpServerConfig.onWarning`
   * (tools/list or resources/list rejected, list came back `[]`).
   * Reset before every pooled call so a tool only ever reports the
   * warning of ITS OWN list call, never a stale one from an earlier
   * call on the same pooled connection.
   */
  lastListWarning?: McpListWarning;
}

/**
 * Module-level pool, keyed by `(workspace, server)`. Lives in the tools
 * layer on purpose: the coordinator never sees it, and a pooled client
 * survives across agent tool calls in the same process. Entries are
 * evicted when idle past `MCP_POOL_IDLE_TIMEOUT_MS`, when the transport
 * dies, or when the pool grows past `MCP_POOL_MAX_ENTRIES`.
 */
const mcpClientPool = new Map<string, PooledMcpClient>();

function poolKey(workspaceDir: string, serverName: string): string {
  return `${workspaceDir}\0${serverName}`;
}

/** Number of pooled clients (tests + diagnostics). */
export function getMcpClientPoolSize(): number {
  return mcpClientPool.size;
}

/** Close every pooled client and empty the pool (tests / shutdown). */
export async function closeMcpClientPool(): Promise<void> {
  const entries = [...mcpClientPool.values()];
  mcpClientPool.clear();
  for (const entry of entries) {
    const client =
      entry.client ??
      (entry.connecting ? await entry.connecting.catch(() => null) : null);
    if (client) await client.close().catch(() => undefined);
  }
}

async function evictPoolEntry(key: string): Promise<void> {
  const entry = mcpClientPool.get(key);
  if (!entry) return;
  mcpClientPool.delete(key);
  const client =
    entry.client ??
    (entry.connecting ? await entry.connecting.catch(() => null) : null);
  if (client) await client.close().catch(() => undefined);
}

/** Close pool entries idle past the timeout, and drop the
 *  least-recently-used entries when the pool grows past its cap. */
async function sweepMcpClientPool(nowMs: number = Date.now()): Promise<void> {
  for (const [key, entry] of [...mcpClientPool.entries()]) {
    if (entry.connecting) continue;
    if (nowMs - entry.lastUsedMs > MCP_POOL_IDLE_TIMEOUT_MS) {
      await evictPoolEntry(key);
    }
  }
  if (mcpClientPool.size > MCP_POOL_MAX_ENTRIES) {
    const byUse = [...mcpClientPool.entries()].sort(
      (a, b) => a[1].lastUsedMs - b[1].lastUsedMs,
    );
    for (const [key] of byUse.slice(0, mcpClientPool.size - MCP_POOL_MAX_ENTRIES)) {
      await evictPoolEntry(key);
    }
  }
}

/**
 * Run `fn` with a pooled client for the server: reuse the cached
 * connection when it is alive, connect once when it is missing (concurrent
 * callers for the same server share the one pending connect), reconnect
 * when the transport died. `timeoutMs` bounds the whole operation
 * (connect + run). The client stays pooled afterwards — it is only
 * closed on idle eviction, transport death, or `closeMcpClientPool()`.
 */
/**
 * Run `fn` against the pooled client for one server (v0.9).
 *
 * v0.71 (SEP-1303 follow-up): `onListWarning` receives the `-32602`
 * list warning of THIS call, if the client's list came back `[]`
 * because the server rejected it — so `mcp_list_tools` /
 * `mcp_list_resources` can tell the model why the list is empty.
 * The pool entry's `lastListWarning` is reset before every call, so
 * a warning is never carried over from an earlier call.
 */
async function withMcpClient<T>(
  workspaceDir: string,
  serverName: string,
  fn: (client: McpClient) => Promise<T>,
  timeoutMs: number,
  oauthOpts?: McpToolsOptions,
  onListWarning?: (warning: McpListWarning) => void,
): Promise<T> {
  const server = getServerConfig(workspaceDir, serverName);
  await sweepMcpClientPool();
  const key = poolKey(workspaceDir, serverName);
  let entry = mcpClientPool.get(key);
  if (entry?.client?.isClosed()) {
    // Server died (stdio child exited) or client was closed: drop it so
    // the lines below reconnect fresh.
    await evictPoolEntry(key);
    entry = undefined;
  }
  if (!entry) {
    const fresh: PooledMcpClient = { client: null, connecting: null, lastUsedMs: Date.now() };
    mcpClientPool.set(key, fresh);
    entry = fresh;
    fresh.connecting = (async (): Promise<McpClient> => {
      const authProvider = buildAuthProvider(serverName, oauthOpts);
      const stepUp = buildStepUpHandler(serverName, workspaceDir, oauthOpts);
      // v0.18 (W10c follow-up): sampling dùng provider của bot gọi tool
      // (qua callback — bot chắc chắn tồn tại lúc tool chạy, không phải
      // lúc createMcpTools). Không có handler thì không advertise sampling.
      // v0.23: nối `callServerTool` — handler gọi tool ngược về chính
      // client pool này (`poolClient.callTool`). Handler được tạo TRƯỚC
      // khi client tồn tại nên dùng holder: sampling chỉ tới sau
      // initialize, lúc đó `poolClient` đã được gán (connectMcp xong).
      // Gọi trước lúc đó thì lỗi rõ thay vì treo. Mỗi lần kết nối mới
      // có holder riêng (nằm trong IIFE này) nên evict + reconnect
      // không dùng nhầm client cũ.
      let poolClient: McpClient | null = null;
      const samplingHandler =
        oauthOpts?.getSamplingHandler?.({
          callServerTool: async (name, args) => {
            if (!poolClient) {
              throw new Error('MCP sampling: client pool chưa kết nối xong.');
            }
            return poolClient.callTool(name, args);
          },
        }) ?? null;
      const client = await connectMcp({
        ...(authProvider ? { ...server, authProvider } : server),
        // v0.13: dispatcher handlers (elicitation via the host prompt,
        // roots = this workspace) + step-up scope on 401.
        clientHandlers: {
          serverName,
          workspaceDir,
          elicitationPrompt: oauthOpts?.elicitationPrompt,
          // v0.18 (W10c follow-up): sampling cũng nằm trong clientHandlers
          // (không phải top-level config) — handler lấy qua callback vì
          // provider của bot chỉ chắc chắn có lúc tool chạy.
          ...(samplingHandler ? { samplingHandler } : {}),
        },
        ...(stepUp ? { onAuthStepUp: stepUp } : {}),
        // v0.71 (SEP-1303 follow-up): record the -32602 list warning
        // on the pool entry so withMcpClient can hand it to the
        // caller of this call (see below) instead of dropping it.
        // `fresh` (not `entry`): a const alias, so the closure keeps
        // the type — `entry` is a `let` and TS cannot narrow it here.
        onWarning: (w: McpListWarning) => {
          fresh.lastListWarning = w;
        },
      });
      poolClient = client;
      fresh.client = client;
      fresh.connecting = null;
      return client;
    })();
    // A failed connect must not leave a dead entry behind: the next call
    // retries from scratch.
    fresh.connecting.catch(() => {
      if (mcpClientPool.get(key) === fresh) mcpClientPool.delete(key);
    });
  }
  let client = entry.client;
  if (!client) {
    if (!entry.connecting) {
      throw new Error(`MCP pool entry for "${serverName}" has no client and no pending connection`);
    }
    client = await entry.connecting;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`MCP operation on "${serverName}" timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref?.();
    });
    // v0.71: a fresh slot for this call's list warning — a warning
    // recorded here belongs to this fn() call only.
    entry.lastListWarning = undefined;
    const result = await Promise.race([fn(client), timeout]);
    entry.lastUsedMs = Date.now();
    if (onListWarning && entry.lastListWarning) onListWarning(entry.lastListWarning);
    return result;
  } catch (err) {
    // The transport died mid-operation: evict so the next call reconnects
    // instead of reusing a dead client. Tool-level errors (unknown tool,
    // bad arguments, tool `isError`) leave the client pooled.
    if (client.isClosed()) await evictPoolEntry(key);
    else entry.lastUsedMs = Date.now();
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Lỗi tool kèm gợi ý gọi tool auth khi lỗi là lỗi auth (P0-4): model
 * thấy cả lỗi lẫn tên tool cần gọi (`mcp_authenticate_<server>`) thay
 * vì chỉ một dòng 401 rồi dừng.
 */
function authHintedErrorResult(args: Record<string, unknown>, err: unknown): string {
  const message = (err as Error).message;
  if (!isMcpAuthFailureMessage(message)) return errorResult(message);
  const server = typeof args['server'] === 'string' ? (args['server'] as string) : '';
  if (!server) return errorResult(message);
  return errorResult(`${message}\n${mcpAuthFailureHint(server)}`);
}

function describeServer(name: string, server: McpServerConfig): string {
  if (server.command) {
    const args = (server.args ?? []).join(' ');
    return `${name} — stdio: ${server.command}${args ? ` ${args}` : ''}`;
  }
  return `${name} — streamable HTTP: ${server.url ?? ''}`;
}

// ---------------------------------------------------------------------------
// Auth-tool UX (P0-4, mẫu Grok — deep-dive §8.3)
// ---------------------------------------------------------------------------

/**
 * Tên tool auth sinh riêng cho một server: `mcp_authenticate_<server>`
 * (tên server sanitize về `[A-Za-z0-9_]`). Model gọi tool này khi server
 * cần auth, thay vì chỉ nhận lỗi 401 / "chưa authorize" rồi dừng.
 */
export function getMcpAuthToolName(serverName: string): string {
  const safe = serverName.replace(/[^A-Za-z0-9_]/g, '_') || 'server';
  return `mcp_authenticate_${safe}`;
}

/** Một lỗi có phải lỗi auth (401 / token hết / chưa authorize) không. */
export function isMcpAuthFailureMessage(message: string): boolean {
  return /401|unauthori[sz]ed|re-authorize|OAuth|authorize/i.test(message);
}

/**
 * Gợi ý model gọi tool auth của server khi gặp lỗi auth — thay cho lỗi
 * khô "401" mà model không biết phải làm gì tiếp.
 */
export function mcpAuthFailureHint(serverName: string): string {
  const toolName = getMcpAuthToolName(serverName);
  return (
    `Server "${serverName}" needs authentication — call the "${toolName}" tool ` +
      `to authorize it via OAuth (or run mcp_auth for "${serverName}"), then retry.`
  );
}

/**
 * Sinh tool auth riêng cho một MCP server (P0-4, mẫu Grok): khi server
 * cần auth, model tự gọi tool này — mô tả hướng model gọi khi trạng thái
 * / lỗi cho biết server cần authenticate, thay vì chỉ báo lỗi cho user.
 * Tool chạy đúng flow OAuth PKCE của `mcp_auth` (`runMcpAuthFlow`), lưu
 * token vào Vault namespace 'mcp-oauth', không bao giờ hiện token.
 * Không cần argument — server đã gắn trong tên tool.
 */
export function buildMcpServerAuthTool(serverName: string, opts?: McpToolsOptions): Tool {
  const toolName = getMcpAuthToolName(serverName);
  return {
    definition: {
      name: toolName,
      description:
        `Authenticate the MCP server "${serverName}" so its tools can be used. ` +
        `Call this tool when a tool call, status check, or error indicates this server ` +
        `needs authentication. It opens the provider authorization page, waits for the ` +
        `user to authorize in the browser (up to timeoutSeconds), and stores the OAuth token in the Vault ` +
        `(the token itself is never shown). After it succeeds, retry the failed call. ` +
        `Needs approval: it stores a credential and opens a browser URL.`,
      parameters: {
        type: 'object',
        properties: {
          // v0.70: timeout chờ callback — trước đây tool không nhận
          // timeout nên `runMcpAuthFlow` luôn dùng mặc định 300s.
          // Khoảng 1–600s (khác `mcp_auth` 30–600s: cho phép fail nhanh
          // khi host/model biết user sẽ không authorize kịp); mặc định
          // 300s hoặc timeout host đã cấu hình (`authTimeoutSeconds`).
          timeoutSeconds: {
            type: 'number',
            description:
              'How long to wait for the browser callback, in seconds (1–600). ' +
              'Default: 300, or the host-configured auth timeout when one is set.',
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args, _ctx) {
      try {
        // v0.70: đường không-openUrl tôn trọng timeout được cấu hình /
        // truyền vào thay vì chờ 300s mặc định của `runMcpAuthFlow`.
        const timeoutMs =
          getNumberArg(
            args,
            'timeoutSeconds',
            resolveMcpAuthTimeoutSeconds(opts?.authTimeoutSeconds),
            1,
            MAX_MCP_AUTH_TIMEOUT_SECONDS,
          ) * 1000;
        const result = await runMcpAuthFlow(
          serverName,
          {
            oauthStore: opts?.oauthStore,
            getOAuthConfig: opts?.getOAuthConfig,
            openUrl: opts?.openUrl,
            fetchFn: opts?.fetchFn,
          },
          timeoutMs,
        );
        return (
          truncate(result) +
          `\nMCP server "${serverName}" is now authorized — retry the failed call.`
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };
}

/**
 * Tool auth sinh riêng cho mọi HTTP server đã cấu hình, khi host đã nối
 * OAuth wiring (store + client config). Server stdio không cần OAuth nên
 * không sinh tool. Trả [] khi không có wiring / không đọc được mcp.json
 * (không làm hỏng tool list chính).
 */
export function buildMcpServerAuthTools(
  workspaceDir: string,
  opts?: McpToolsOptions,
): Tool[] {
  if (!opts?.oauthStore || !opts?.getOAuthConfig) return [];
  let config: ReturnType<typeof loadMcpConfig>;
  try {
    config = loadMcpConfig(workspaceDir);
  } catch {
    return [];
  }
  const tools: Tool[] = [];
  for (const [name, server] of Object.entries(config.servers)) {
    if (!server.url) continue; // stdio: không có OAuth qua HTTP
    tools.push(buildMcpServerAuthTool(name, opts));
  }
  return tools;
}

function makeMcpTools(workspaceDirOverride?: string, oauthOpts?: McpToolsOptions): Tool[] {
  const resolveWorkspace = (ctx: ToolContext): string =>
    workspaceDirOverride || ctx.workspaceDir;

  const listServersTool: Tool = {
    definition: {
      name: 'mcp_list_servers',
      description:
        `List the MCP servers configured in the workspace's .open-bot/mcp.json (name + transport). ${POOLED_CONNECTION_NOTE}`,
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(_args, ctx) {
      try {
        const config = loadMcpConfig(resolveWorkspace(ctx));
        const names = Object.keys(config.servers);
        if (names.length === 0) {
          return 'No MCP servers configured. Add servers to .open-bot/mcp.json in the workspace (see packages/core/src/mcp/config.ts for the format).';
        }
        return truncate(
          `Configured MCP servers (${names.length}):\n` +
            names.map((n) => `- ${describeServer(n, config.servers[n] as McpServerConfig)}`).join('\n'),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const listToolsTool: Tool = {
    definition: {
      name: 'mcp_list_tools',
      description:
        `List the tools offered by one configured MCP server. ${POOLED_CONNECTION_NOTE}`,
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Name of a configured MCP server (see mcp_list_servers).' },
        },
        required: ['server'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const server = getStringArg(args, 'server');
        // v0.71 (SEP-1303 follow-up): when the server rejects
        // tools/list with -32602 the list comes back [] AND the
        // reason arrives here — show it, or the model only sees
        // "offers no tools" and cannot tell an empty server from a
        // server that refused the list.
        let listWarning: McpListWarning | undefined;
        const tools = await withMcpClient(
          resolveWorkspace(ctx),
          server,
          (client) => client.listTools(),
          MCP_CALL_TIMEOUT_MS,
          oauthOpts,
          (w) => {
            listWarning = w;
          },
        );
        if (tools.length === 0) {
          return listWarning
            ? `MCP server "${server}" offers no tools — ${listWarning.message}`
            : `MCP server "${server}" offers no tools.`;
        }
        const lines = tools.map((t) => {
          const schema = t.inputSchema ? `\n  inputSchema: ${JSON.stringify(t.inputSchema)}` : '';
          return `- ${t.name}${t.description ? ` — ${t.description}` : ''}${schema}`;
        });
        return truncate(`Tools on MCP server "${server}" (${tools.length}):\n${lines.join('\n')}`);
      } catch (err) {
        return authHintedErrorResult(args, err);
      }
    },
  };

  const callToolTool: Tool = {
    definition: {
      name: 'mcp_call_tool',
      description:
        'Call a tool on a configured MCP server with the given arguments. ' +
        'The server and its command come only from .open-bot/mcp.json — the agent cannot choose an arbitrary command. ' +
        'Needs approval because an external MCP tool can act outside the machine. ' +
        POOLED_CONNECTION_NOTE,
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Name of a configured MCP server (see mcp_list_servers).' },
          tool: { type: 'string', description: 'Name of the tool on that server (see mcp_list_tools).' },
          arguments: {
            type: 'object',
            description: 'Arguments object for the tool (default: {}).',
            additionalProperties: true,
          },
        },
        required: ['server', 'tool'],
        additionalProperties: false,
      },
    },
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const server = getStringArg(args, 'server');
        const tool = getStringArg(args, 'tool');
        const toolArgs = getObjectArg(args, 'arguments');
        const result = await withMcpClient(
          resolveWorkspace(ctx),
          server,
          async (client) => {
            // v0.13: structured result when the client has it — text
            // already renders `resource_link` blocks; `isError` keeps
            // the same `MCP tool error:` prefix `callTool` used to add.
            if (typeof client.callToolStructured === 'function') {
              const structured = await client.callToolStructured(tool, toolArgs);
              return structured.isError
                ? `MCP tool error: ${structured.text || '(no message)'}`
                : structured.text;
            }
            return client.callTool(tool, toolArgs);
          },
          MCP_CALL_TIMEOUT_MS,
          oauthOpts,
        );
        return truncate(result);
      } catch (err) {
        return authHintedErrorResult(args, err);
      }
    },
  };

  const listResourcesTool: Tool = {
    definition: {
      name: 'mcp_list_resources',
      description:
        `List the resources offered by one configured MCP server. ${POOLED_CONNECTION_NOTE}`,
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Name of a configured MCP server (see mcp_list_servers).' },
        },
        required: ['server'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const server = getStringArg(args, 'server');
        // v0.71 (SEP-1303 follow-up): same as mcp_list_tools — a
        // -32602 resources/list rejection comes back as [] with the
        // reason attached here, not as a bare "offers no resources".
        let listWarning: McpListWarning | undefined;
        const resources = await withMcpClient(
          resolveWorkspace(ctx),
          server,
          (client) => client.listResources(),
          MCP_CALL_TIMEOUT_MS,
          oauthOpts,
          (w) => {
            listWarning = w;
          },
        );
        if (resources.length === 0) {
          return listWarning
            ? `MCP server "${server}" offers no resources — ${listWarning.message}`
            : `MCP server "${server}" offers no resources.`;
        }
        const lines = resources.map(
          (r) => `- ${r.uri}${r.name ? ` (${r.name})` : ''}${r.description ? ` — ${r.description}` : ''}`,
        );
        return truncate(`Resources on MCP server "${server}" (${resources.length}):\n${lines.join('\n')}`);
      } catch (err) {
        return authHintedErrorResult(args, err);
      }
    },
  };

  const readResourceTool: Tool = {
    definition: {
      name: 'mcp_read_resource',
      description:
        `Read one resource from a configured MCP server by URI. ${POOLED_CONNECTION_NOTE}`,
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Name of a configured MCP server (see mcp_list_servers).' },
          uri: { type: 'string', description: 'Resource URI from mcp_list_resources, e.g. "file:///path/to/file".' },
        },
        required: ['server', 'uri'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const server = getStringArg(args, 'server');
        const uri = getStringArg(args, 'uri');
        const text = await withMcpClient(
          resolveWorkspace(ctx),
          server,
          (client) => client.readResource(uri),
          MCP_CALL_TIMEOUT_MS,
          oauthOpts,
        );
        return truncate(text);
      } catch (err) {
        return authHintedErrorResult(args, err);
      }
    },
  };

  // P0-4 (auth-tool UX, mẫu Grok): một tool auth riêng cho mỗi HTTP
  // server đã cấu hình — model tự gọi khi server cần auth, thay vì
  // chỉ nhận lỗi. Chỉ sinh khi host đã nối OAuth wiring và factory đã
  // bound vào một workspace cụ thể (bản unbound MCP_TOOLS không biết
  // workspace lúc tạo nên không sinh).
  const authTools =
    workspaceDirOverride !== undefined
      ? buildMcpServerAuthTools(workspaceDirOverride, oauthOpts)
      : [];
  return [
    listServersTool,
    listToolsTool,
    callToolTool,
    listResourcesTool,
    readResourceTool,
    ...authTools,
  ];
}

/** MCP tools that use the workspace from the tool context (`ctx.workspaceDir`). */
export const MCP_TOOLS: Tool[] = makeMcpTools();

/**
 * MCP tools bound to a fixed workspace directory (its `.open-bot/mcp.json`
 * is where servers are configured). `opts` wires OAuth (store + client
 * config from the host) so HTTP servers get a Vault-backed token with
 * 401 → refresh → retry; without it only the static header in mcp.json
 * is sent. Prefer this factory when the caller already knows the
 * workspace; `MCP_TOOLS` is the context-based variant.
 */
export function createMcpTools(workspaceDir: string, opts?: McpToolsOptions): Tool[] {
  return makeMcpTools(workspaceDir, opts);
}
