# Protocol stack v1.02 — MCP + A2A + ANP

Team T3, wave v1.02. Four pieces, all local-first, no X data, no Grok
Imagine, no cloud VM / accounts / payments.

## 1. MCP audit log (`packages/core/src/mcp/auditLog.ts`)

The MCP spec defines no standard call log, so open-bot defines its own.

**Entry** (`McpAuditEntry`, schema version 1): `seq`, `at` (ISO),
`direction` (`client` | `server`), `server`, `method`, `tool` /
`resourceUri` / `promptName` (when applicable), `caller`, `sessionId`,
`requestId`, `args` (**redacted**), `resultSummary`, `outcome`
(`ok` | `tool-error` | `error` | `cancelled`), `errorCode`,
`errorMessage`, `durationMs`, plus `prevHash` / `hash` (SHA-256 chain).

**Redaction** (`redactMcpSecrets`): keys matching `api_key`, `token`,
`secret`, `password`, `authorization`, `bearer`, `private_key`,
`client_secret`, `session`, `cookie`, `credential`, … are replaced with
`[REDACTED]` (recursive, depth-capped); `Bearer …` / `sk-…` values are
replaced too; long strings / payloads are truncated (500 chars per
string, 4 000 chars per serialized args object). Redaction happens
**before** storage — a raw secret never reaches the log, the file, or
the UI. `McpAuditLog.exportJsonLines()` is safe to share.

**Storage**: `McpAuditLog` is an in-memory ring buffer (default 2 000
entries); `FileMcpAuditLog` appends every entry to a JSONL file and
rebuilds the chain on load (corrupt lines counted and skipped).
`verifyChain()` detects edits to any kept entry.

**Query** (`query` / `summarize`): filter by server, method, tool,
caller, outcome, direction, time range (`fromAt` / `toAt`), free text,
with `limit` / `offset` paging. Results are newest first.

**Wiring**: pass `auditLogger` in `McpServerConfig` (client) or
`McpServerOptions` (server). The client audits every `request()` call
except `ping` (keepalive noise); the server audits every
`handleJsonRpc()` message. Both sides never let a logging failure
break the call. `caller` labels entries with a bot id.

## 2. MCP notifications (`packages/core/src/mcp/notifications.ts`)

Before v1.02 the server silently dropped every notification except
`notifications/initialized`, and clients kept stale tool lists.

- `McpNotificationHub` (server side): `emitListChanged('tools' |
  'resources' | 'prompts')`, `emitLogMessage`, `emitCancelled`
  (tracks cancelled request ids — `isCancelled(id)` lets a long task
  stop early). Throwing listeners are isolated via `onListenerError`.
- `McpServer` emits `list_changed` on every `registerTool` /
  `registerResource` / `registerPrompt`, handles `logging/setLevel`
  (levels `debug` … `emergency`, spec default `info`, gated by
  `notifyLogMessage`), and records `notifications/cancelled`.
- Client side: `McpServerConfig.onListsChanged` fires when the server
  announces a list change (registered on the client's dispatcher via
  `registerMcpListChangedHandlers`); the caller drops its cached list
  and re-fetches. Note: `startMcpHttpServer` does **not** yet forward
  hub events to SSE clients — the hub exists, the HTTP broadcast is
  follow-up work.

## 3. A2A multi-tenancy (`packages/core/src/a2a/tenancy.ts`)

Opt-in via `createA2aServer({ multiTenant: true })`. Off = exactly the
old single-tenant behaviour.

- Tenant id: 1–64 chars, `[A-Za-z0-9._-]` only (`normalizeA2aTenantId`
  throws on anything else — fail fast, never silently fall back to
  another tenant's space).
- Resolution order: `X-A2A-Tenant` header → `_meta.tenantId` in
  JSON-RPC params → explicit id → `defaultTenant` (`'default'`).
- Tasks carry optional `tenantId` (absent = default tenant, so tasks
  persisted before tenancy stay visible). A tenant only sees its own
  tasks: `getTask` / `listTasks` / `cancelTask` / `resubscribe` /
  `subscribeToTask` / `startStream` are all scoped, and cross-tenant
  lookups answer "not found" (never revealing ownership). Malformed
  tenant ids are `-32602` (JSON-RPC) or `400` (HTTP GET routes).
- `A2aClient({ tenantId })` sends the header and `_meta.tenantId` on
  every request (`message:send`, `tasks/*`, `message:stream`, event
  resubscribe). `scopeA2aContextId` namespaces context ids per tenant
  (default tenant keeps bare ids, backward compatible).

## 4. ANP discovery (`packages/core/src/anp/`)

Minimal, extensible stub — the ANP spec is still evolving, so only the
stable core is implemented (shapes written from the public DID Core /
`did:key` descriptions, no code copied from any implementation).

- `anp/did.ts`: `did:key` identity from Ed25519
  (`did:key:z` + base58btc(`0xed01` + 32-byte pubkey)), minimal DID
  document, Ed25519 sign/verify. Private keys never leave the machine.
- `anp/registry.ts`: local registry (`AnpRegistry` in-memory,
  `FileAnpRegistry` JSON 0600, atomic write): register / resolve by
  DID / find by skill or name / remove. Loading tolerates corrupt files.
- `anp/discovery.ts`: `discoverAnpAgent(baseUrl)` fetches
  `/.well-known/anp/did.json` (http(s) only, 10 s timeout, 64 KiB cap),
  validates the document (id and key must match the DID), optionally
  registers it; `announceAnpAgent` registers the local identity;
  `resolveAnpDid` is a pure local lookup. Remote ANP mechanisms (peer
  exchange, relays, signed announcements) are future work — they plug
  in without changing callers.

## i18n

`protocols.*` keys (13) added to all 6 locales (`en`, `vi`, `zh`,
`ja`, `es`, `fr`): audit-log viewer labels, ANP discovery labels,
tenant label. 2678 keys per locale.

## Tests

- `tests/mcp-audit-log-v102.test.mjs` — redaction, query, summary,
  hash chain + tamper detection, file store, ring buffer.
- `tests/mcp-notifications-v102.test.mjs` — hub, log levels, dispatcher
  wiring, server `logging/setLevel` + cancelled tracking.
- `tests/a2a-tenancy-v102.test.mjs` — validation, resolution order,
  server isolation (direct + HTTP), single-tenant compatibility.
- `tests/anp-discovery-v102.test.mjs` — base58, identity, DID document,
  signing, registry, file registry, loopback discovery.
- `tests/mcp-audit-integration-v102.test.mjs` — real server + real
  Streamable-HTTP client over loopback, both sides audited.
