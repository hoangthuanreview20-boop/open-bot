/**
 * MCP 2.0 stateless transport (v0.97, Team T1).
 *
 * Spec 2026-07-28 (MCP 2.0): the `initialize` handshake and the
 * `Mcp-Session-Id` header are gone. Every request is self-contained:
 * it carries the protocol version and the client capabilities in
 * `_meta`, so any server instance can answer any request — the server
 * behaves like an ordinary stateless web service and can scale
 * horizontally behind a load balancer.
 *
 * What this module provides (ideas only — no code copied from any
 * MCP implementation, SDK, or the Grok Bot / Cursor installers):
 *   - `MCP_PROTOCOL_VERSION_2026` + negotiation against the 2025 list.
 *   - `buildStatelessMeta` / `parseStatelessMeta`: the per-request
 *     `_meta` envelope (protocol version + client capabilities +
 *     optional round-trip / task continuation, see `mrtr.ts` and
 *     `taskStore.ts`).
 *   - `discoverServer`: the `server/discover` method — a server
 *     describes its own capabilities and protocol version without
 *     any handshake. Works against any client exposing the
 *     `requestJsonRpc` raw call (both built-in clients do).
 *   - `requestStateless`: one self-contained request through a client.
 *   - `buildServerDiscoverResult`: what the built-in server answers
 *     for `server/discover` (used by `server.ts`).
 *
 * Backward compatibility: the old `initialize` handshake keeps
 * working unchanged. A client opts into stateless mode per server
 * (`McpServerConfig.stateless`); `connectMcp` then skips the
 * handshake and calls `server/discover` instead. Servers that do
 * not know `server/discover` answer `-32601` (method not found) —
 * the client treats that as "stateless-capable server, no discovery
 * document" and keeps going, because every later request still
 * carries `_meta` and works without a session.
 *
 * Security: `_meta` never carries credentials. Auth (OAuth issuer
 * validation) still runs on every request, exactly as before — the
 * token provider is consulted per request by the HTTP client, not
 * once per session. Nothing here logs headers or tokens.
 */

export const MCP_PROTOCOL_VERSION_2026 = '2026-07-28';

/** Protocol versions this client can speak, newest first. */
export const MCP_PROTOCOL_VERSIONS_2026: readonly string[] = [
  MCP_PROTOCOL_VERSION_2026,
  '2025-11-25',
  '2025-06-18',
  '2024-11-05',
];

/** The `server/discover` method name (MCP 2.0). */
export const MCP_SERVER_DISCOVER_METHOD = 'server/discover';

/**
 * Capabilities a stateless client declares in `_meta`. This is the
 * same shape the old `initialize` call advertised, minus anything
 * that only made sense for a long-lived session (server-initiated
 * streams). MRTR follow-ups are declared here too: a client that
 * can answer `needs_input` / `needs_sampling` / `needs_elicitation`
 * follow-ups says so, and the server only asks for what the client
 * declared (see `mrtr.ts`).
 */
export interface StatelessClientCapabilities {
  /** Client can answer MRTR follow-up rounds. */
  multiRoundTrip?: boolean;
  /** Client can handle `tasks/*` long-running handles. */
  tasks?: boolean;
  /** Client can render MCP Apps (sandboxed HTML). */
  apps?: boolean;
  /** Client still answers the deprecated callbacks (sampling / roots). */
  deprecatedCallbacks?: boolean;
  /** Free-form extension markers, e.g. `{ "experimental": {} }`. */
  experimental?: Record<string, unknown>;
}

/** The per-request `_meta` envelope for a stateless MCP 2.0 request. */
export interface StatelessRequestMeta {
  /** Protocol version the client speaks for this request. */
  protocolVersion: string;
  /** Capabilities the client offers for this request. */
  clientCapabilities?: StatelessClientCapabilities;
  /** Client name / version, for the server's logs only. */
  clientInfo?: { name: string; version: string };
  /** MRTR continuation (see `mrtr.ts`); absent on the first round. */
  roundTrip?: { roundTripId: string; round: number };
  /** Task handle this request continues (see `tasks.ts`). */
  task?: { taskId: string };
}

/** Minimal client surface the stateless helpers need. */
export interface StatelessCapableClient {
  requestJsonRpc(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown>;
}

/** What `server/discover` returns. */
export interface ServerDiscoverResult {
  /** Protocol version the server speaks. */
  protocolVersion: string;
  /** Protocol versions the server also accepts. */
  supportedVersions?: string[];
  /** Capabilities the server offers (tools / resources / prompts / tasks / apps). */
  capabilities: {
    tools?: Record<string, unknown>;
    resources?: Record<string, unknown>;
    prompts?: Record<string, unknown>;
    tasks?: Record<string, unknown>;
    apps?: Record<string, unknown>;
    logging?: Record<string, unknown>;
    experimental?: Record<string, unknown>;
  };
  /** Server identity. */
  serverInfo: { name: string; version: string };
  /** MCP 2.0 extensions the server supports, e.g. `io.modelcontextprotocol/tasks`. */
  extensions?: string[];
  /** Human-readable note when the server runs in a degraded mode. */
  note?: string;
}

export class StatelessMcpError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = 'StatelessMcpError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Pick the best shared protocol version. Prefers the newest version
 * both sides list; falls back to the client's newest when the server
 * lists nothing usable (a 2025 server answers `2025-11-25`).
 * Never throws — negotiation failure degrades to the client default.
 */
export function negotiateStatelessVersion(
  serverVersion: string | undefined,
  serverSupported: readonly string[] | undefined,
  clientPreferred: string = MCP_PROTOCOL_VERSION_2026,
): string {
  const offered = new Set<string>(serverSupported ?? []);
  if (serverVersion) offered.add(serverVersion);
  if (offered.size === 0) return clientPreferred;
  for (const candidate of MCP_PROTOCOL_VERSIONS_2026) {
    if (offered.has(candidate)) return candidate;
  }
  // No overlap: the client still speaks its preferred version and
  // lets the server answer with its own version in the result.
  return clientPreferred;
}

/** True when the version string is one this client understands. */
export function isKnownProtocolVersion(version: unknown): boolean {
  return (
    typeof version === 'string' &&
    (MCP_PROTOCOL_VERSIONS_2026 as readonly string[]).includes(version)
  );
}

/**
 * Build the `_meta` envelope for one stateless request. Callers pass
 * the capabilities they honestly offer; defaults declare the full
 * MCP 2.0 client surface of this build (MRTR + tasks + apps).
 */
export function buildStatelessMeta(
  options: {
    protocolVersion?: string;
    capabilities?: StatelessClientCapabilities;
    clientInfo?: { name: string; version: string };
    roundTrip?: StatelessRequestMeta['roundTrip'];
    task?: StatelessRequestMeta['task'];
  } = {},
): StatelessRequestMeta {
  const meta: StatelessRequestMeta = {
    protocolVersion: options.protocolVersion ?? MCP_PROTOCOL_VERSION_2026,
    clientCapabilities: options.capabilities ?? {
      multiRoundTrip: true,
      tasks: true,
      apps: true,
    },
  };
  if (options.clientInfo) meta.clientInfo = options.clientInfo;
  if (options.roundTrip) meta.roundTrip = options.roundTrip;
  if (options.task) meta.task = options.task;
  return meta;
}

/**
 * Parse + validate a `_meta` envelope received by a server. Returns
 * null when the envelope is absent or malformed (the caller then
 * falls back to the legacy `initialize` gate). Unknown extra fields
 * are ignored — forward compatibility.
 */
export function parseStatelessMeta(value: unknown): StatelessRequestMeta | null {
  if (!isRecord(value)) return null;
  const version = value['protocolVersion'];
  if (typeof version !== 'string' || version.length === 0) return null;
  const meta: StatelessRequestMeta = { protocolVersion: version };
  if (isRecord(value['clientCapabilities'])) {
    const caps = value['clientCapabilities'];
    meta.clientCapabilities = {
      multiRoundTrip: caps['multiRoundTrip'] === true,
      tasks: caps['tasks'] === true,
      apps: caps['apps'] === true,
      deprecatedCallbacks: caps['deprecatedCallbacks'] === true,
      ...(isRecord(caps['experimental']) ? { experimental: caps['experimental'] } : {}),
    };
  }
  if (isRecord(value['clientInfo'])) {
    const info = value['clientInfo'];
    if (typeof info['name'] === 'string' && typeof info['version'] === 'string') {
      meta.clientInfo = { name: info['name'], version: info['version'] };
    }
  }
  if (isRecord(value['roundTrip'])) {
    const rt = value['roundTrip'];
    if (typeof rt['roundTripId'] === 'string' && typeof rt['round'] === 'number') {
      meta.roundTrip = { roundTripId: rt['roundTripId'], round: rt['round'] };
    }
  }
  if (isRecord(value['task'])) {
    const task = value['task'];
    if (typeof task['taskId'] === 'string') meta.task = { taskId: task['taskId'] };
  }
  return meta;
}

/**
 * Attach a stateless `_meta` envelope to request params. The params
 * object is copied, never mutated — the caller's object may be reused
 * for retries. Existing `_meta` fields the caller set (e.g. a
 * progress token) are preserved and merged under the new envelope.
 */
export function withStatelessMeta(
  params: Record<string, unknown> | undefined,
  meta: StatelessRequestMeta,
): Record<string, unknown> {
  const base: Record<string, unknown> = params ? { ...params } : {};
  const existing = isRecord(base['_meta']) ? base['_meta'] : {};
  base['_meta'] = { ...existing, ...meta };
  return base;
}

/**
 * Parse a `server/discover` result. Throws `StatelessMcpError` when
 * the shape is unusable (missing protocol version / server info) so
 * the caller can fall back to the legacy handshake instead of
 * trusting a half-formed discovery document.
 */
export function parseServerDiscoverResult(value: unknown): ServerDiscoverResult {
  if (!isRecord(value)) {
    throw new StatelessMcpError('server/discover returned a non-object result');
  }
  const protocolVersion = value['protocolVersion'];
  if (typeof protocolVersion !== 'string' || protocolVersion.length === 0) {
    throw new StatelessMcpError('server/discover result has no protocolVersion');
  }
  const serverInfo = isRecord(value['serverInfo']) ? value['serverInfo'] : {};
  if (typeof serverInfo['name'] !== 'string' || typeof serverInfo['version'] !== 'string') {
    throw new StatelessMcpError('server/discover result has no serverInfo { name, version }');
  }
  const capabilities = isRecord(value['capabilities']) ? value['capabilities'] : {};
  const supportedVersions = Array.isArray(value['supportedVersions'])
    ? value['supportedVersions'].filter((v): v is string => typeof v === 'string')
    : undefined;
  const extensions = Array.isArray(value['extensions'])
    ? value['extensions'].filter((v): v is string => typeof v === 'string')
    : undefined;
  return {
    protocolVersion,
    ...(supportedVersions ? { supportedVersions } : {}),
    capabilities: {
      ...(isRecord(capabilities['tools']) ? { tools: capabilities['tools'] } : {}),
      ...(isRecord(capabilities['resources']) ? { resources: capabilities['resources'] } : {}),
      ...(isRecord(capabilities['prompts']) ? { prompts: capabilities['prompts'] } : {}),
      ...(isRecord(capabilities['tasks']) ? { tasks: capabilities['tasks'] } : {}),
      ...(isRecord(capabilities['apps']) ? { apps: capabilities['apps'] } : {}),
      ...(isRecord(capabilities['logging']) ? { logging: capabilities['logging'] } : {}),
      ...(isRecord(capabilities['experimental']) ? { experimental: capabilities['experimental'] } : {}),
    },
    serverInfo: { name: serverInfo['name'], version: serverInfo['version'] },
    ...(extensions ? { extensions } : {}),
    ...(typeof value['note'] === 'string' ? { note: value['note'] } : {}),
  };
}

/**
 * Ask a server to describe itself (`server/discover`). No handshake
 * is needed first — the request carries its own `_meta`. A server
 * that does not know the method answers `-32601`; that is NOT an
 * error here, it only means "no discovery document" and the caller
 * gets null so it can continue with plain stateless requests.
 */
export async function discoverServer(
  client: StatelessCapableClient,
  options: {
    protocolVersion?: string;
    capabilities?: StatelessClientCapabilities;
    clientInfo?: { name: string; version: string };
  } = {},
): Promise<ServerDiscoverResult | null> {
  const meta = buildStatelessMeta(options);
  let raw: unknown;
  try {
    raw = await client.requestJsonRpc(MCP_SERVER_DISCOVER_METHOD, {
      _meta: meta,
    });
  } catch (err) {
    // Method-not-found (-32601) = pre-2.0 server. Any other failure
    // (transport down, timeout) is real and propagates.
    if (err instanceof Error && /-32601|Method not found/i.test(err.message)) return null;
    throw err;
  }
  return parseServerDiscoverResult(raw);
}

/**
 * One self-contained stateless request through any client. The
 * `_meta` envelope is attached, no session id is sent, and no
 * handshake state is required or consulted. Use for servers that
 * speak MCP 2.0; legacy servers still accept it because `_meta` is
 * ignored by the 2025-11-25 spec when present.
 */
export async function requestStateless(
  client: StatelessCapableClient,
  method: string,
  params?: Record<string, unknown>,
  metaOptions: {
    protocolVersion?: string;
    capabilities?: StatelessClientCapabilities;
    clientInfo?: { name: string; version: string };
    roundTrip?: StatelessRequestMeta['roundTrip'];
    task?: StatelessRequestMeta['task'];
  } = {},
): Promise<unknown> {
  return client.requestJsonRpc(
    method,
    withStatelessMeta(params, buildStatelessMeta(metaOptions)),
  );
}

/**
 * Build the `server/discover` answer for the built-in server
 * (`server.ts`). The server lists exactly what it can do — tools,
 * resources, prompts, the tasks extension and MCP Apps — so a
 * stateless client can decide what to call without any handshake.
 */
export function buildServerDiscoverResult(options: {
  name: string;
  version: string;
  protocolVersion?: string;
  supportedVersions?: string[];
  hasTools: boolean;
  hasResources: boolean;
  hasPrompts: boolean;
  tasksSupported: boolean;
  appsSupported: boolean;
  note?: string;
}): ServerDiscoverResult {
  return {
    protocolVersion: options.protocolVersion ?? MCP_PROTOCOL_VERSION_2026,
    supportedVersions: options.supportedVersions ?? [...MCP_PROTOCOL_VERSIONS_2026],
    capabilities: {
      ...(options.hasTools ? { tools: {} } : {}),
      ...(options.hasResources ? { resources: {} } : {}),
      ...(options.hasPrompts ? { prompts: {} } : {}),
      ...(options.tasksSupported ? { tasks: { extension: 'io.modelcontextprotocol/tasks' } } : {}),
      ...(options.appsSupported ? { apps: { extension: 'io.modelcontextprotocol/apps' } } : {}),
    },
    serverInfo: { name: options.name, version: options.version },
    extensions: [
      ...(options.tasksSupported ? ['io.modelcontextprotocol/tasks'] : []),
      ...(options.appsSupported ? ['io.modelcontextprotocol/apps'] : []),
    ],
    ...(options.note ? { note: options.note } : {}),
  };
}
