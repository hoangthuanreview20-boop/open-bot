/**
 * MCP (Model Context Protocol) types for @open-bot/core.
 *
 * Hand-written, no MCP SDK dependency. Covers the two transports this
 * client supports: stdio (spawn a local server process) and streamable
 * HTTP (POST JSON-RPC to a URL).
 *
 * Auth (v0.9): a server that needs OAuth gets its token through
 * `McpServerConfig.authProvider` — a callback the tools layer wires to
 * the Vault-backed OAuth store (`getValidAccessToken`). The static
 * `Authorization` header in `.open-bot/mcp.json` still works as a
 * fallback for servers without an OAuth flow. Tokens / headers are
 * never logged.
 */

/**
 * Provides the `Authorization` header value (e.g. `Bearer <token>`) for
 * one MCP server, or null when the server was never authorized.
 * The client calls it once per HTTP request and once more (with
 * `forceRefresh: true`) after an HTTP 401, so the provider must
 * refresh the token on force-refresh instead of returning the same
 * rejected token. Implementations must never log the token.
 */
export type McpAuthProvider = (
  serverName: string,
  options?: { forceRefresh?: boolean },
) => Promise<string | null>;

/**
 * A list call the server rejected with `-32602` (invalid params)
 * instead of answering (v0.71, SEP-1303 follow-up). `listTools()` /
 * `listResources()` still return `[]` in that case — the return type
 * is an array, so the server's reason has nowhere to go — and the
 * client reports it through `McpServerConfig.onWarning` instead, so
 * the caller can see WHY the list came back empty. `message` is the
 * full human-readable reason (server name + method + code + the
 * server's own detail); `detail` is the server's message alone.
 */
export interface McpListWarning {
  /** The list method the server rejected: 'tools/list' or 'resources/list'. */
  method: 'tools/list' | 'resources/list';
  /** The JSON-RPC error code the server answered with (-32602). */
  code: number;
  /** Full human-readable reason, ready to show or log. */
  message: string;
  /** The server's own error message, without the client-added prefix. */
  detail: string;
}

export interface McpServerConfig {
  /** Server name — defaults to the key under `servers:` in mcp.json. */
  name: string;
  /** Command to spawn for the stdio transport, e.g. "npx" / "node". */
  command?: string;
  /** Arguments for `command`. */
  args?: string[];
  /** Extra environment variables for the spawned process. */
  env?: Record<string, string>;
  /** URL for the streamable-HTTP transport, e.g. "https://example.com/mcp". */
  url?: string;
  /** Extra HTTP headers for the streamable-HTTP transport, e.g. a static
   *  `Authorization: Bearer <token>` the user filled in themselves.
   *  NEVER log these values. */
  headers?: Record<string, string>;
  /**
   * OAuth token provider for the streamable-HTTP transport (v0.9).
   * When set, its `Authorization` value is sent on every request and
   * takes precedence over a static `Authorization` header in `headers`.
   * Not serializable — never put it in mcp.json; the tools layer injects
   * it at runtime from the Vault-backed OAuth store. Ignored by stdio.
   */
  authProvider?: McpAuthProvider;
  /**
   * v0.13: step-up OAuth — called on HTTP 401 when the server's
   * `WWW-Authenticate` challenge asks for more scope. Must refresh
   * with the wider scope and return the fresh `Authorization` value
   * (or null when it cannot). The client falls back to
   * `authProvider({ forceRefresh: true })` when this is absent or
   * returns null. Not serializable — injected at runtime like
   * `authProvider`. Ignored by stdio.
   */
  onAuthStepUp?: (scopes: string[]) => Promise<string | null>;
  /**
   * v0.71 (SEP-1303 follow-up): called when `tools/list` or
   * `resources/list` is rejected with `-32602` (invalid params) and
   * the client returns `[]` instead of throwing. Without this the
   * caller only sees "no tools/resources" and never learns why.
   * Optional — callers that do not care ignore it, and the return
   * type of the list methods stays `[]`. Not serializable — injected
   * at runtime like `authProvider`. The tools layer wires it in
   * `withMcpClient` so `mcp_list_tools` / `mcp_list_resources` show
   * the reason to the model; the marketplace probe wires it too.
   * Never called for other error codes (those still throw).
   */
  onWarning?: (warning: McpListWarning) => void;
  /**
   * v0.13: server-initiated handlers (elicitation / roots / sampling).
   * When set, `connectMcp` registers them on the client's dispatcher
   * BEFORE `initialize()` and advertises the matching capabilities
   * (see `buildMcpClientCapabilities`). Not serializable — injected
   * at runtime like `authProvider`.
   */
  clientHandlers?: import('./clientHandlers').McpClientHandlerOptions;
  /**
   * v0.13: capabilities advertised in `initialize`. Defaults to the
   * capabilities matching `clientHandlers` (elicitation / roots /
   * sampling only when their handler exists) — set explicitly to
   * override. Never claim a capability the client cannot honour.
   */
  capabilities?: Record<string, unknown>;
  /**
   * v0.97 (MCP 2.0): stateless mode — skip the `initialize` handshake
   * and send every request with its own `_meta` (protocol version +
   * client capabilities) instead of a session id. `connectMcp` calls
   * `server/discover` (best-effort) instead of `initialize`. Opt-in
   * per server; default false keeps the legacy handshake. A server
   * that does not know `server/discover` still works — every later
   * request carries `_meta` and needs no session.
   */
  stateless?: boolean;
  /**
   * v0.40 (P0-4): cấu hình reconnect / resilience từng phần — gộp lên
   * mặc định Grok (`DEFAULT_MCP_RECONNECT_CONFIG` trong client.ts:
   * retry nhanh 5s→60s ×5, retry định kỳ 5→30 phút, tombstone 404 ×5,
   * keepalive 5 phút ±30s, tool idle 120s / tổng 60 phút, stdio lỗi
   * không retry). Không truyền thì dùng toàn bộ mặc định.
   */
  reconnect?: Partial<import('./client').McpReconnectConfig>;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

export interface McpToolDef {
  name: string;
  description?: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema?: Record<string, unknown>;
  /** Human-readable display title (spec 2025-06-18, `title` field). */
  title?: string;
  /**
   * Hints the agent/UI uses to decide approval and display (spec
   * 2025-06-18): read-only, destructive, idempotent, open-world.
   * All hints are advisory — a missing hint means "unknown", never
   * "safe". Never treat `readOnlyHint: true` as a security guarantee.
   */
  annotations?: McpToolAnnotations;
  /**
   * JSON Schema (2020-12) for the tool's `structuredContent` (spec
   * 2025-06-18). When present, `callToolStructured` validates the
   * structured output against it and falls back to text on mismatch.
   */
  outputSchema?: Record<string, unknown>;
  /** Icons for the tool (SEP-973, spec 2025-11-25). */
  icons?: McpToolIcon[];
}

/**
 * Tool annotations (spec 2025-06-18). Every field is an optional hint;
 * clients must not assume a default when a hint is absent.
 */
export interface McpToolAnnotations {
  /** Display title for the tool (also carried as `McpToolDef.title`). */
  title?: string;
  /** The tool only reads, never mutates state. */
  readOnlyHint?: boolean;
  /** The tool may delete / irreversibly change data. */
  destructiveHint?: boolean;
  /** Repeated calls with the same arguments have the same effect. */
  idempotentHint?: boolean;
  /** The tool may touch the outside world (network, external APIs). */
  openWorldHint?: boolean;
}

/** One icon for a tool / resource / prompt (SEP-973, spec 2025-11-25). */
export interface McpToolIcon {
  /** URL (usually `data:` or `https:`) of the icon image. */
  src: string;
  mimeType?: string;
  /** Sizes such as `"48x48"`; the spec allows a list of them. */
  sizes?: string[];
  /** `"light"` / `"dark"` — which UI theme the icon is drawn for. */
  theme?: string;
}

/**
 * A `resource_link` content block (spec 2025-06-18): a tool result can
 * point at a resource instead of inlining it, so the UI can render a
 * link and the agent can read it later with `resources/read`.
 */
export interface McpResourceLink {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  annotations?: McpToolAnnotations;
  icons?: McpToolIcon[];
}

export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  /** Size in bytes, when the server reports it. */
  size?: number;
  annotations?: McpToolAnnotations;
  icons?: McpToolIcon[];
}

export interface McpServerInfo {
  name: string;
  version: string;
  protocolVersion?: string;
}

/** One content block inside a `tools/call` result. */
export interface McpContentBlock {
  type: string;
  text?: string;
  uri?: string;
  mimeType?: string;
  data?: string;
  /** `resource_link` blocks (spec 2025-06-18). */
  name?: string;
  title?: string;
  description?: string;
  /** `resource` blocks may nest the resource: `{ resource: { uri, text } }`. */
  resource?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
  icons?: McpToolIcon[];
  [key: string]: unknown;
}

/**
 * Progress report from the server for one long-running request (spec
 * 2024-11-05, `notifications/progress`). `progressToken` is the token
 * the client sent in `_meta` when it started the request, so the
 * callback can be routed to exactly that call.
 */
export interface McpProgressNotification {
  progressToken: string | number;
  /** Units completed so far (interpretation is server-defined). */
  progress: number;
  /** Total units, when the server knows it. */
  total?: number;
  /** Human-readable progress message, when the server sends one. */
  message?: string;
}

/** Receives one `notifications/progress` for a request the caller started. */
export type McpProgressCallback = (progress: McpProgressNotification) => void;

/**
 * Options for one `tools/call` (v0.13, W5a).
 * - `progressToken`: token sent in `_meta` so the server can report
 *   progress for this call. Generated automatically when `onProgress`
 *   is given and no token is supplied.
 * - `onProgress`: called for every `notifications/progress` carrying
 *   this call's token, until the call settles.
 * - `signal`: aborting it cancels the in-flight call — the client
 *   sends `notifications/cancelled` (`{ requestId }`) and rejects
 *   with an `McpError` saying the call was cancelled.
 * - `timeoutMs`: per-call timeout (default `MCP_REQUEST_TIMEOUT_MS`).
 * - `outputSchema`: JSON Schema to validate `structuredContent`
 *   against in `callToolStructured` (normally taken from `tools/list`).
 */
export interface McpCallToolOptions {
  progressToken?: string | number;
  onProgress?: McpProgressCallback;
  signal?: AbortSignal;
  timeoutMs?: number;
  outputSchema?: Record<string, unknown>;
}

/**
 * Options for one raw JSON-RPC request (v0.13): the same timeout /
 * progress / cancel knobs as `McpCallToolOptions`, minus the
 * tool-specific `outputSchema`. Used by `requestJsonRpc` and by the
 * tasks / prompts adapters.
 */
export interface McpRequestOptions {
  progressToken?: string | number;
  onProgress?: McpProgressCallback;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Full result of one `tools/call` (v0.13, W5a) — text plus everything
 * structured the server sent, so the agent/UI can use the JSON
 * directly instead of re-parsing text.
 */
export interface McpToolCallResult {
  /** Content blocks merged into plain text (same as `callTool`). */
  text: string;
  /** `isError: true` from the server (SEP-1303: tool error, not protocol). */
  isError: boolean;
  /** Raw content blocks, as sent by the server. */
  content: McpContentBlock[];
  /**
   * `structuredContent` when the server sent it AND it validates
   * against the tool's `outputSchema` (or no schema was given).
   * `undefined` when absent or when validation failed — see
   * `structuredContentError`; `text` always stays usable as fallback.
   */
  structuredContent?: unknown;
  /** True when `structuredContent` was present and passed validation. */
  structuredContentValid: boolean;
  /** Why validation failed, when it did (Vietnamese, for logs/UI). */
  structuredContentError?: string;
  /** `resource_link` blocks pulled out of `content` for the UI. */
  resourceLinks: McpResourceLink[];
}

export interface McpClient {
  /** Run the MCP `initialize` handshake. Must be called before other methods
   *  (except `close()`). `connectMcp()` in client.ts does this for you. */
  initialize(): Promise<McpServerInfo>;
  /**
   * v0.97 (MCP 2.0): ask the server to describe itself
   * (`server/discover`) without any handshake. Returns null when the
   * server does not know the method (pre-2.0 server). Optional so
   * minimal clients keep working.
   */
  discover?(): Promise<import('./stateless').ServerDiscoverResult | null>;
  /** MCP `ping` — throws on timeout / transport failure. */
  ping(): Promise<void>;
  /**
   * Dispatcher for server-initiated messages (v0.13): the coordinator
   * registers elicitation / sampling / roots handlers here (see
   * `mcp/clientHandlers.ts`). Optional so minimal clients keep working.
   */
  getDispatcher?(): import('./dispatcher').McpDispatcher;
  /**
   * Raw JSON-RPC request (v0.13): the tasks / prompts adapters
   * (`mcp/clientAdapters.ts`) use this to speak `tasks/*`,
   * `prompts/*`, `resources/subscribe` and `completion/complete`
   * through any real client. Same options as the typed methods.
   * Optional so minimal clients keep working.
   */
  requestJsonRpc?(
    method: string,
    params?: Record<string, unknown>,
    options?: McpRequestOptions,
  ): Promise<unknown>;
  /**
   * MCP `tools/list`. v0.70 (SEP-1303 mở rộng): server trả `-32602`
   * thì trả `[]` thay vì throw (lỗi ở tầng tool/list, không phải lỗi
   * protocol); các mã khác vẫn throw. v0.71: khi trả `[]` vì `-32602`,
   * lý do của server được báo qua `McpServerConfig.onWarning` để
   * caller thấy được — kiểu trả về vẫn là mảng, không đổi.
   */
  listTools(): Promise<McpToolDef[]>;
  /**
   * MCP `tools/call`. Returns the result content merged into plain text.
   * `options` (v0.13, W5a) enables progress reporting (`progressToken` /
   * `onProgress`) and cancellation via `signal`.
   */
  callTool(name: string, args?: Record<string, unknown>, options?: McpCallToolOptions): Promise<string>;
  /**
   * MCP `tools/call` with the full structured result (v0.13, W5a):
   * text + validated `structuredContent` + `resourceLinks`.
   * Optional so older / minimal clients keep working.
   */
  callToolStructured?(
    name: string,
    args?: Record<string, unknown>,
    options?: McpCallToolOptions,
  ): Promise<McpToolCallResult>;
  /**
   * Cancel an in-flight request (v0.13, W5a): sends
   * `notifications/cancelled` (`{ requestId, reason? }`) to the server.
   * On stdio it also rejects the pending call; on HTTP it only sends
   * the notification (the HTTP request itself is aborted via the
   * `signal` passed to `callTool`). Returns true when a pending
   * request was found (stdio) or a notification was attempted (HTTP).
   */
  cancelRequest?(requestId: number | string, reason?: string): boolean;
  /**
   * MCP `resources/list`. v0.70 (SEP-1303 mở rộng): như `listTools` —
   * server trả `-32602` thì trả `[]` thay vì throw; các mã khác vẫn throw.
   * v0.71: lý do của server được báo qua `McpServerConfig.onWarning`.
   */
  listResources(): Promise<McpResource[]>;
  /**
   * MCP `resources/read`. Returns the resource contents merged into text.
   * v0.70 (SEP-1303 mở rộng): server trả `-32602` thì trả text
   * `MCP tool error: …` thay vì throw (như `callTool`); các mã khác vẫn throw.
   */
  readResource(uri: string): Promise<string>;
  /** Close the transport (kill the stdio child / drop HTTP state).
   *  Safe to call more than once. */
  close(): Promise<void>;
  /** True when the transport is dead or was closed (stdio child exited,
   *  `close()` called). The tools-layer connection pool uses this to
   *  evict dead clients instead of reusing them. */
  isClosed(): boolean;
  /**
   * Protocol version agreed during `initialize()` (the server's reply
   * when it is one we support, else the version we requested). Undefined
   * before `initialize()` runs.
   */
  negotiatedProtocolVersion?: string;
}
