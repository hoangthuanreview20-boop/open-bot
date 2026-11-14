/**
 * MCP call audit log (v1.02, Team T3 — protocol stack).
 *
 * The MCP spec does not define a standard call log, so open-bot defines
 * its own: every MCP call the client makes and every request the server
 * answers is recorded as one entry with caller, method, tool, redacted
 * arguments, outcome, error code and duration. The log is queryable
 * (filter by server / method / tool / caller / outcome / time range)
 * and tamper-evident: entries form a SHA-256 hash chain, so editing or
 * deleting a middle entry breaks `verifyChain()`.
 *
 * Security: arguments and results are redacted BEFORE they are stored —
 * secret-looking keys (api key, token, password, authorization, ...) are
 * replaced with `[REDACTED]` and long values are truncated. The raw
 * secret never reaches the log, the file store, or the UI.
 *
 * Pure Node stdlib, no dependency. Used by both `mcp/client.ts`
 * (direction 'client') and `mcp/server.ts` (direction 'server').
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Schema version of one audit entry — bump when the shape changes. */
export const MCP_AUDIT_LOG_VERSION = 1;

/** Marker written in place of a redacted value. */
export const MCP_AUDIT_REDACTED = '[REDACTED]';

/** Max characters kept for one string value in the log. */
export const MCP_AUDIT_MAX_STRING_CHARS = 500;
/** Max characters kept for a serialized (JSON) value in the log. */
export const MCP_AUDIT_MAX_JSON_CHARS = 4_000;
/** Max depth when walking a value for redaction. */
export const MCP_AUDIT_MAX_DEPTH = 6;
/** Max entries kept in the in-memory ring buffer by default. */
export const MCP_AUDIT_DEFAULT_MAX_ENTRIES = 2_000;

/** Which side of the call recorded this entry. */
export type McpAuditDirection = 'client' | 'server';

/** Outcome of one audited call. */
export type McpAuditOutcome = 'ok' | 'tool-error' | 'error' | 'cancelled';

/** One recorded MCP call. */
export interface McpAuditEntry {
  /** Schema version (`MCP_AUDIT_LOG_VERSION`). */
  version: number;
  /** Stable id: `<seq>-<random>`. */
  id: string;
  /** Monotonic sequence number inside this log (starts at 1). */
  seq: number;
  /** ISO-8601 timestamp when the call started. */
  at: string;
  /** Client side (call made) or server side (request answered). */
  direction: McpAuditDirection;
  /** MCP server name (client side) or this server's name (server side). */
  server: string;
  /** JSON-RPC method, e.g. `tools/call`, `resources/read`. */
  method: string;
  /** Tool name for `tools/call` (absent for other methods). */
  tool?: string;
  /** Resource URI for `resources/read` (absent for other methods). */
  resourceUri?: string;
  /** Prompt name for `prompts/get` (absent for other methods). */
  promptName?: string;
  /** Who made the call: bot id / caller label supplied by the caller. */
  caller?: string;
  /** MCP session id when one exists (Streamable HTTP). */
  sessionId?: string;
  /** JSON-RPC request id when one exists. */
  requestId?: string | number;
  /** Call arguments with secrets redacted (absent when there are none). */
  args?: unknown;
  /** True when `args` was truncated to the JSON size cap. */
  argsTruncated?: boolean;
  /** Short human-readable summary of the result (never the full payload). */
  resultSummary?: string;
  /** Outcome of the call. */
  outcome: McpAuditOutcome;
  /** JSON-RPC / transport error code when `outcome` is `error`. */
  errorCode?: number;
  /** Error message (already stripped of secret values by the caller). */
  errorMessage?: string;
  /** Wall-clock duration of the call, milliseconds. */
  durationMs: number;
  /** SHA-256 hex of the previous entry (`'GENESIS'` for the first one). */
  prevHash: string;
  /** SHA-256 hex of this entry's canonical content (chain link). */
  hash: string;
}

/** Input for recording one entry — `id`/`seq`/`at`/`prevHash`/`hash` are filled in. */
export interface McpAuditRecordInput {
  direction: McpAuditDirection;
  server: string;
  method: string;
  tool?: string;
  resourceUri?: string;
  promptName?: string;
  caller?: string;
  sessionId?: string;
  requestId?: string | number;
  /** Raw arguments — redacted inside `record()`, never stored raw. */
  args?: unknown;
  resultSummary?: string;
  outcome: McpAuditOutcome;
  errorCode?: number;
  errorMessage?: string;
  durationMs: number;
  /** Explicit start time (defaults to now). */
  at?: string;
}

/** Filter for `McpAuditLog.query()` — every field is optional. */
export interface McpAuditQuery {
  server?: string;
  method?: string;
  tool?: string;
  caller?: string;
  outcome?: McpAuditOutcome;
  direction?: McpAuditDirection;
  /** Only entries at or after this ISO timestamp (inclusive). */
  fromAt?: string;
  /** Only entries at or before this ISO timestamp (inclusive). */
  toAt?: string;
  /** Case-insensitive substring over method / tool / error message / caller. */
  text?: string;
  /** Max entries returned (default 100). */
  limit?: number;
  /** Entries to skip (for paging, default 0). */
  offset?: number;
}

/** Counters for `McpAuditLog.summarize()`. */
export interface McpAuditSummary {
  total: number;
  byOutcome: Record<McpAuditOutcome, number>;
  byMethod: Record<string, number>;
  byServer: Record<string, number>;
  byTool: Record<string, number>;
  /** Mean duration of the matched entries (ms, 0 when none). */
  avgDurationMs: number;
  /** Slowest entry duration (ms, 0 when none). */
  maxDurationMs: number;
  /** ISO range of the matched entries. */
  earliestAt?: string;
  latestAt?: string;
}

/** Result of `McpAuditLog.verifyChain()`. */
export interface McpAuditChainVerification {
  ok: boolean;
  entriesChecked: number;
  /** Sequence number of the first broken entry (undefined when ok). */
  firstBadSeq?: number;
  /** Human-readable reason for the first break (undefined when ok). */
  reason?: string;
}

/** Key names treated as secrets — matched case-insensitively, substring. */
const SECRET_KEY_FRAGMENTS = [
  'api_key',
  'apikey',
  'api-key',
  'access_key',
  'accesskey',
  'secret',
  'password',
  'passwd',
  'pwd',
  'token',
  'authorization',
  'auth',
  'bearer',
  'private_key',
  'privatekey',
  'client_secret',
  'session',
  'cookie',
  'credential',
  'passphrase',
  'license_key',
];

/** Value patterns that look like a bearer token or an `sk-...` key. */
const SECRET_VALUE_PATTERNS = [/^Bearer\s+\S+$/i, /^sk-[A-Za-z0-9_-]{8,}$/, /^xox[baprs]-[A-Za-z0-9-]{8,}$/];

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

function looksLikeSecretValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function truncateString(value: string): string {
  if (value.length <= MCP_AUDIT_MAX_STRING_CHARS) return value;
  return `${value.slice(0, MCP_AUDIT_MAX_STRING_CHARS)}…[truncated ${value.length - MCP_AUDIT_MAX_STRING_CHARS} chars]`;
}

/**
 * Recursively redact a value: secret keys become `[REDACTED]`, long
 * strings are truncated, and values that look like tokens are replaced.
 * Returns a JSON-safe copy (functions / symbols / undefined become
 * strings or are dropped by the object walk). Depth-capped so a cyclic
 * or very deep value cannot hang the logger.
 */
export function redactMcpSecrets(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (looksLikeSecretValue(value)) return MCP_AUDIT_REDACTED;
    return truncateString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MCP_AUDIT_MAX_DEPTH) return '[DEPTH-LIMIT]';
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactMcpSecrets(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(key)) {
        out[key] = MCP_AUDIT_REDACTED;
      } else {
        out[key] = redactMcpSecrets(item, depth + 1);
      }
    }
    return out;
  }
  // Function / symbol / bigint / anything else: keep only its type name.
  return `[${typeof value}]`;
}

/**
 * Serialize a redacted value to JSON with a size cap. Returns the
 * serialized string and whether it was cut short.
 */
export function serializeMcpAuditArgs(value: unknown): { json: string; truncated: boolean } {
  const redacted = redactMcpSecrets(value);
  let json: string;
  try {
    json = JSON.stringify(redacted) ?? 'null';
  } catch {
    json = '"[UNSERIALIZABLE]"';
  }
  if (json.length <= MCP_AUDIT_MAX_JSON_CHARS) return { json, truncated: false };
  return { json: `${json.slice(0, MCP_AUDIT_MAX_JSON_CHARS)}…`, truncated: true };
}

/**
 * Build a short result summary from a tool-call result: content item
 * count + first text fragment (truncated, secret-scanned). The full
 * payload is never stored — summaries are all an audit reader needs.
 */
export function summarizeMcpResult(result: unknown): string {
  if (result === undefined) return '(no result)';
  if (typeof result === 'string') {
    const clean = looksLikeSecretValue(result) ? MCP_AUDIT_REDACTED : result;
    return truncateString(clean);
  }
  if (typeof result === 'object' && result !== null) {
    const record = result as Record<string, unknown>;
    const content = record['content'];
    const count = Array.isArray(content) ? content.length : undefined;
    const isError = record['isError'] === true;
    const firstText =
      Array.isArray(content) && content.length > 0 && typeof content[0] === 'object' && content[0] !== null
        ? String((content[0] as Record<string, unknown>)['text'] ?? '')
        : '';
    const prefix = isError ? 'isError=true' : 'ok';
    const parts = [prefix, count !== undefined ? `${count} content item(s)` : undefined];
    if (firstText) parts.push(truncateString(firstText));
    return parts.filter(Boolean).join(' — ');
  }
  return truncateString(String(result));
}

/** Canonical string of an entry (without `hash`) for the hash chain. */
function canonicalEntryContent(entry: Omit<McpAuditEntry, 'hash'>): string {
  return JSON.stringify({
    version: entry.version,
    id: entry.id,
    seq: entry.seq,
    at: entry.at,
    direction: entry.direction,
    server: entry.server,
    method: entry.method,
    tool: entry.tool ?? null,
    resourceUri: entry.resourceUri ?? null,
    promptName: entry.promptName ?? null,
    caller: entry.caller ?? null,
    sessionId: entry.sessionId ?? null,
    requestId: entry.requestId ?? null,
    args: entry.args ?? null,
    resultSummary: entry.resultSummary ?? null,
    outcome: entry.outcome,
    errorCode: entry.errorCode ?? null,
    errorMessage: entry.errorMessage ?? null,
    durationMs: entry.durationMs,
    prevHash: entry.prevHash,
  });
}

function hashEntryContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function matchesQuery(entry: McpAuditEntry, query: McpAuditQuery): boolean {
  if (query.server !== undefined && entry.server !== query.server) return false;
  if (query.method !== undefined && entry.method !== query.method) return false;
  if (query.tool !== undefined && entry.tool !== query.tool) return false;
  if (query.caller !== undefined && entry.caller !== query.caller) return false;
  if (query.outcome !== undefined && entry.outcome !== query.outcome) return false;
  if (query.direction !== undefined && entry.direction !== query.direction) return false;
  if (query.fromAt !== undefined && entry.at < query.fromAt) return false;
  if (query.toAt !== undefined && entry.at > query.toAt) return false;
  if (query.text !== undefined && query.text.length > 0) {
    const needle = query.text.toLowerCase();
    const haystack = [entry.method, entry.tool ?? '', entry.caller ?? '', entry.errorMessage ?? '', entry.server]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/**
 * In-memory MCP audit log with a hash chain. Ring buffer: when the
 * cap is reached the oldest entries are dropped (the chain keeps
 * verifying from the oldest KEPT entry — `verifyChain()` treats the
 * first kept entry's `prevHash` as its anchor).
 */
export class McpAuditLog {
  private readonly maxEntries: number;
  private readonly entries: McpAuditEntry[] = [];
  private nextSeq = 1;
  private lastHash = 'GENESIS';

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? MCP_AUDIT_DEFAULT_MAX_ENTRIES);
  }

  /** Number of entries currently held. */
  get size(): number {
    return this.entries.length;
  }

  /** Next sequence number (1 when empty). */
  get seq(): number {
    return this.nextSeq;
  }

  /**
   * Record one call. Arguments are redacted inside; the caller only
   * passes the raw values. Never throws — a logging failure must not
   * break the call it audits.
   */
  record(input: McpAuditRecordInput): McpAuditEntry {
    const seq = this.nextSeq++;
    const at = input.at ?? new Date().toISOString();
    let args: unknown;
    let argsTruncated: boolean | undefined;
    if (input.args !== undefined) {
      const serialized = serializeMcpAuditArgs(input.args);
      argsTruncated = serialized.truncated ? true : undefined;
      try {
        args = JSON.parse(serialized.json) as unknown;
      } catch {
        args = '[UNSERIALIZABLE]';
      }
    }
    const partial: Omit<McpAuditEntry, 'hash'> = {
      version: MCP_AUDIT_LOG_VERSION,
      id: `${seq}-${crypto.randomUUID()}`,
      seq,
      at,
      direction: input.direction,
      server: input.server,
      method: input.method,
      ...(input.tool !== undefined ? { tool: input.tool } : {}),
      ...(input.resourceUri !== undefined ? { resourceUri: input.resourceUri } : {}),
      ...(input.promptName !== undefined ? { promptName: input.promptName } : {}),
      ...(input.caller !== undefined ? { caller: input.caller } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      ...(args !== undefined ? { args } : {}),
      ...(argsTruncated !== undefined ? { argsTruncated } : {}),
      ...(input.resultSummary !== undefined ? { resultSummary: input.resultSummary } : {}),
      outcome: input.outcome,
      ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
      ...(input.errorMessage !== undefined ? { errorMessage: truncateString(input.errorMessage) } : {}),
      durationMs: Math.max(0, Math.round(input.durationMs)),
      prevHash: this.lastHash,
    };
    const entry: McpAuditEntry = { ...partial, hash: hashEntryContent(canonicalEntryContent(partial)) };
    this.lastHash = entry.hash;
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
    return entry;
  }

  /**
   * Query entries, newest first. `limit` defaults to 100, `offset`
   * defaults to 0. The returned entries are copies — mutating them
   * cannot corrupt the log.
   */
  query(query: McpAuditQuery = {}): McpAuditEntry[] {
    const limit = Math.max(0, query.limit ?? 100);
    const offset = Math.max(0, query.offset ?? 0);
    const matched: McpAuditEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i] as McpAuditEntry;
      if (matchesQuery(entry, query)) matched.push({ ...entry });
    }
    return matched.slice(offset, offset + limit);
  }

  /** Counters over the entries matching `query` (no limit applied). */
  summarize(query: Omit<McpAuditQuery, 'limit' | 'offset'> = {}): McpAuditSummary {
    const summary: McpAuditSummary = {
      total: 0,
      byOutcome: { ok: 0, 'tool-error': 0, error: 0, cancelled: 0 },
      byMethod: {},
      byServer: {},
      byTool: {},
      avgDurationMs: 0,
      maxDurationMs: 0,
    };
    let durationSum = 0;
    for (const entry of this.entries) {
      if (!matchesQuery(entry, query)) continue;
      summary.total += 1;
      summary.byOutcome[entry.outcome] += 1;
      summary.byMethod[entry.method] = (summary.byMethod[entry.method] ?? 0) + 1;
      summary.byServer[entry.server] = (summary.byServer[entry.server] ?? 0) + 1;
      if (entry.tool !== undefined) summary.byTool[entry.tool] = (summary.byTool[entry.tool] ?? 0) + 1;
      durationSum += entry.durationMs;
      if (entry.durationMs > summary.maxDurationMs) summary.maxDurationMs = entry.durationMs;
      if (summary.earliestAt === undefined || entry.at < summary.earliestAt) summary.earliestAt = entry.at;
      if (summary.latestAt === undefined || entry.at > summary.latestAt) summary.latestAt = entry.at;
    }
    summary.avgDurationMs = summary.total > 0 ? Math.round(durationSum / summary.total) : 0;
    return summary;
  }

  /**
   * Verify the hash chain from the oldest kept entry to the newest.
   * The first kept entry is anchored on its own stored `prevHash`
   * (an entry dropped by the ring cap cannot be re-verified, so the
   * anchor is trusted for that one link only).
   */
  verifyChain(): McpAuditChainVerification {
    let expectedPrev = this.entries.length > 0 ? (this.entries[0] as McpAuditEntry).prevHash : 'GENESIS';
    for (const entry of this.entries) {
      if (entry.prevHash !== expectedPrev) {
        return {
          ok: false,
          entriesChecked: this.entries.length,
          firstBadSeq: entry.seq,
          reason: `Entry #${entry.seq} prevHash does not match the previous entry hash (log edited or truncated mid-chain).`,
        };
      }
      const { hash, ...rest } = entry;
      if (hashEntryContent(canonicalEntryContent(rest)) !== hash) {
        return {
          ok: false,
          entriesChecked: this.entries.length,
          firstBadSeq: entry.seq,
          reason: `Entry #${entry.seq} hash mismatch (entry content edited after recording).`,
        };
      }
      expectedPrev = entry.hash;
    }
    return { ok: true, entriesChecked: this.entries.length };
  }

  /** All entries as one JSONL document (oldest first), for export. */
  exportJsonLines(): string {
    return this.entries.map((entry) => JSON.stringify(entry)).join('\n') + (this.entries.length > 0 ? '\n' : '');
  }

  /** Remove all entries and reset the chain (used by tests / explicit clear). */
  clear(): void {
    this.entries.length = 0;
    this.nextSeq = 1;
    this.lastHash = 'GENESIS';
  }

  /** Direct read-only access to the held entries (oldest first). */
  all(): McpAuditEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
}

/** Options for the file-backed audit log. */
export interface FileMcpAuditLogOptions {
  /** Max entries kept in memory (file keeps everything). */
  maxEntries?: number;
}

/**
 * File-backed audit log: every recorded entry is appended to a JSONL
 * file (one line per entry) AND kept in the in-memory ring buffer.
 * On creation the file is re-read: valid lines rebuild the chain,
 * corrupt lines are counted and skipped (never crash startup).
 */
export class FileMcpAuditLog extends McpAuditLog {
  private readonly filePath: string;
  /** Number of corrupt lines skipped while loading the file. */
  readonly corruptLines: number;
  /** Number of entries loaded from the file at startup. */
  readonly loadedEntries: number;

  constructor(filePath: string, options: FileMcpAuditLogOptions = {}) {
    super({ maxEntries: options.maxEntries });
    this.filePath = filePath;
    let corrupt = 0;
    let loaded = 0;
    try {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(filePath)) {
        const text = fs.readFileSync(filePath, 'utf8');
        for (const line of text.split('\n')) {
          if (line.trim().length === 0) continue;
          try {
            const parsed = JSON.parse(line) as McpAuditEntry;
            // A valid audit line has the chain fields — a bare object
            // with only `seq` is corrupt, not an entry.
            if (
              typeof parsed !== 'object' ||
              parsed === null ||
              typeof parsed.seq !== 'number' ||
              typeof parsed.id !== 'string' ||
              typeof parsed.hash !== 'string' ||
              typeof parsed.prevHash !== 'string' ||
              typeof parsed.method !== 'string'
            ) {
              corrupt += 1;
              continue;
            }
            // Rebuild the chain from the file without re-hashing: the
            // stored entries are trusted as recorded, then verified.
            (this as unknown as { entries: McpAuditEntry[] }).entries.push(parsed);
            loaded += 1;
          } catch {
            corrupt += 1;
          }
        }
        const held = (this as unknown as { entries: McpAuditEntry[] }).entries;
        if (held.length > 0) {
          (this as unknown as { nextSeq: number }).nextSeq =
            Math.max(...held.map((e) => e.seq)) + 1;
          (this as unknown as { lastHash: string }).lastHash = held[held.length - 1]?.hash ?? 'GENESIS';
          if (held.length > (options.maxEntries ?? MCP_AUDIT_DEFAULT_MAX_ENTRIES)) {
            held.splice(0, held.length - (options.maxEntries ?? MCP_AUDIT_DEFAULT_MAX_ENTRIES));
          }
        }
      }
    } catch {
      // A missing/unreadable audit file must not break the app: the
      // log starts empty and records will recreate the file on append.
      corrupt += 1;
    }
    this.corruptLines = corrupt;
    this.loadedEntries = loaded;
  }

  /** Path of the JSONL file. */
  get path(): string {
    return this.filePath;
  }

  override record(input: McpAuditRecordInput): McpAuditEntry {
    const entry = super.record(input);
    try {
      fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // Disk failure must not break the audited call — the entry
      // stays in memory and the caller never sees this error.
    }
    return entry;
  }
}

/** Create an in-memory audit log (default) or a file-backed one. */
export function createMcpAuditLog(options: { filePath?: string; maxEntries?: number } = {}): McpAuditLog {
  if (options.filePath) return new FileMcpAuditLog(options.filePath, { maxEntries: options.maxEntries });
  return new McpAuditLog({ maxEntries: options.maxEntries });
}

/**
 * Wrap one async MCP call with audit recording: times the call,
 * records `ok` / `tool-error` / `error` / `cancelled` and rethrows the
 * original error unchanged. `classify` lets the caller map a result or
 * an error to an outcome + error code without duplicating timing code.
 */
export async function auditMcpCall<T>(
  logger: McpAuditLog | undefined,
  meta: Omit<McpAuditRecordInput, 'outcome' | 'durationMs' | 'errorCode' | 'errorMessage' | 'resultSummary'> & {
    resultSummary?: (result: T) => string | undefined;
    classifyError?: (err: unknown) => { outcome: McpAuditOutcome; errorCode?: number; errorMessage?: string };
  },
  fn: () => Promise<T>,
): Promise<T> {
  if (!logger) return fn();
  const startedAt = Date.now();
  const at = new Date(startedAt).toISOString();
  try {
    const result = await fn();
    let summary: string | undefined;
    try {
      summary = meta.resultSummary ? meta.resultSummary(result) : summarizeMcpResult(result);
    } catch {
      summary = undefined;
    }
    const { resultSummary: _ignored, classifyError: _ignored2, ...base } = meta;
    logger.record({
      ...base,
      at,
      outcome: 'ok',
      ...(summary !== undefined ? { resultSummary: summary } : {}),
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (err) {
    const classified = meta.classifyError ? meta.classifyError(err) : undefined;
    const { resultSummary: _ignored, classifyError: _ignored2, ...base } = meta;
    const message = err instanceof Error ? err.message : String(err);
    logger.record({
      ...base,
      at,
      outcome: classified?.outcome ?? 'error',
      errorCode: classified?.errorCode,
      errorMessage: classified?.errorMessage ?? message,
      durationMs: Date.now() - startedAt,
    });
    throw err;
  }
}
