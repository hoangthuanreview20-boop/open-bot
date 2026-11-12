/**
 * MCP marketplace (LOCAL, v0.3 wave 1).
 *
 * A curated catalogue of real, public MCP servers a user can install into
 * a workspace with one call. "Install" only writes a server entry into
 * `<workspaceDir>/.open-bot/mcp.json` (via the v0.2 loader, read → edit →
 * write, so other servers in the file are preserved). It never downloads
 * or runs anything itself — the server process is spawned later, on
 * demand, by the MCP client (see mcp/client.ts) when the user actually
 * uses it, typically via `npx -y <package>`.
 *
 * Registry file: `<baseDir>/marketplace/mcp-servers.json`, where `baseDir`
 * is the app-data directory passed in by the host (defaults to the
 * current working directory when omitted — the host should pass the real
 * user-data dir). On first use the file is seeded with the 8 built-in
 * entries below; afterwards the file is the source of truth, so a future
 * version (or the user, by hand) can extend it.
 *
 * SECURITY — no secrets here, ever:
 *  - The catalogue records only the NAME of a credential a server needs
 *    (`needsKey`, e.g. "BRAVE_API_KEY"), never a value.
 *  - `install()` never writes a key/token into mcp.json. For servers that
 *    need one it returns `nextSteps` telling the user exactly what to
 *    fill in themselves (env var name / placeholder arg) after install.
 *  - `install()`/`uninstall()` preserve every other server in mcp.json.
 *
 * LIMITS (local-only, v0.3): no central server, no ratings/downloads,
 * no auto-update, no sync between machines. Nothing here is fetched
 * from the network — the catalogue is a static local list.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { StdioMcpClient, StreamableHttpMcpClient } from './client';
import { loadMcpConfig, MCP_CONFIG_REL_PATH } from './config';
import type { McpConfig, McpListWarning, McpServerConfig, McpToolDef } from './types';
import {
  fetchRemoteRegistry,
  findRegistryServer,
  registryEntryToMcpConfig,
} from './registry';
import type { RegistryFetchFn, RegistryServerEntry } from './registry';

export const MARKETPLACE_REGISTRY_REL_PATH = path.join(
  'marketplace',
  'mcp-servers.json',
);

export type MarketplaceTransport = 'stdio' | 'http';

export interface MarketplaceServer {
  /** Stable id, also used as the key under `servers:` in mcp.json. */
  id: string;
  name: string;
  description: string;
  transport: MarketplaceTransport;
  /** Command for stdio servers, e.g. "npx". */
  command?: string;
  /** Args for `command`. May contain a "<placeholder>" the user must
   *  replace (e.g. an allowed directory, a db path); see `nextSteps`
   *  returned by install(). */
  args?: string[];
  /** URL for streamable-HTTP servers. */
  url?: string;
  /** Human-readable description of the credential this server needs,
   *  naming the env var / value — NEVER a real value. Absent when the
   *  server needs no credential. */
  needsKey?: string;
  tags: string[];
}

export interface InstallOverrides {
  /** Override the server key/name written to mcp.json (default: entry id). */
  name?: string;
  /** Replace the entry's default args (e.g. to set the allowed directory
   *  for the filesystem server). Must be an array of strings. */
  args?: string[];
}

export interface InstallResult {
  server: MarketplaceServer;
  /** The exact config entry written to mcp.json. */
  config: McpServerConfig;
  /** What the user still has to do by hand (fill in a key, replace a
   *  "<placeholder>" arg). Empty when the server works as installed. */
  nextSteps: string[];
}

const ID_RE = /^[A-Za-z0-9_-]+$/;

function assertId(id: string, what = 'id'): void {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new Error(
      `Invalid MCP marketplace ${what} "${id}": must match /^[A-Za-z0-9_-]+$/`,
    );
  }
}

function assertNonEmptyString(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid MCP marketplace: "${what}" must be a non-empty string`);
  }
}

/**
 * The 8 built-in catalogue entries. All are real public MCP servers:
 * the five `@modelcontextprotocol/server-*` reference servers, plus
 * Brave Search, GitHub and Postgres (all runnable via npx over stdio).
 */
export const DEFAULT_MARKETPLACE_SERVERS: MarketplaceServer[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    description:
      'Official MCP reference server: read/write files and list directories inside allowed folders.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '<allowed-directory>'],
    tags: ['files', 'official'],
  },
  {
    id: 'memory',
    name: 'Memory',
    description:
      'Official MCP reference server: a persistent knowledge graph the agent can remember facts in across sessions.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    tags: ['memory', 'official'],
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description:
      'Official MCP reference server: fetch web pages and convert them to markdown for the agent to read.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    tags: ['web', 'official'],
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description:
      'Official MCP reference server: query a local SQLite database (read-only queries plus schema inspection).',
    transport: 'stdio',
    command: 'npx',
    args: [
      '-y',
      '@modelcontextprotocol/server-sqlite',
      '--db-path',
      '<path-to-database.sqlite>',
    ],
    tags: ['database', 'official'],
  },
  {
    id: 'git',
    name: 'Git',
    description:
      'Official MCP reference server: read git history, diffs and status of a local repository.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-git', '--repository', '<path-to-repo>'],
    tags: ['git', 'official'],
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description:
      'Official MCP reference server: web search via the Brave Search API.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    needsKey:
      'BRAVE_API_KEY — a Brave Search API key (get one at https://brave.com/search/api/); set it as the BRAVE_API_KEY environment variable for this server in .open-bot/mcp.json',
    tags: ['web', 'search'],
  },
  {
    id: 'github',
    name: 'GitHub',
    description:
      'Official MCP reference server: read and manage GitHub repositories, issues and pull requests.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    needsKey:
      'GITHUB_PERSONAL_ACCESS_TOKEN — a GitHub personal access token (with repo scope); set it as the GITHUB_PERSONAL_ACCESS_TOKEN environment variable for this server in .open-bot/mcp.json',
    tags: ['git', 'github'],
  },
  {
    id: 'postgres',
    name: 'Postgres',
    description:
      'Official MCP reference server: query a PostgreSQL database (read-only queries plus schema inspection).',
    transport: 'stdio',
    command: 'npx',
    args: [
      '-y',
      '@modelcontextprotocol/server-postgres',
      '<postgresql-connection-string>',
    ],
    needsKey:
      'PostgreSQL connection string — pass it as the server argument, e.g. postgresql://user@localhost:5432/db; never commit a real password or connection string to a shared file',
    tags: ['database'],
  },
];

export function getMarketplaceRegistryPath(baseDir: string): string {
  assertNonEmptyString(baseDir, 'baseDir');
  return path.join(baseDir, MARKETPLACE_REGISTRY_REL_PATH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateMarketplaceEntry(raw: unknown, index: number): MarketplaceServer {
  if (!isRecord(raw)) {
    throw new Error(`Invalid MCP marketplace registry: entry #${index} must be an object`);
  }
  const id = raw['id'];
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new Error(
      `Invalid MCP marketplace registry: entry #${index} has an invalid "id" (must match /^[A-Za-z0-9_-]+$/)`,
    );
  }
  if (typeof raw['name'] !== 'string' || !(raw['name'] as string).trim()) {
    throw new Error(`Invalid MCP marketplace registry: entry "${id}" must have a non-empty "name"`);
  }
  if (typeof raw['description'] !== 'string' || !(raw['description'] as string).trim()) {
    throw new Error(
      `Invalid MCP marketplace registry: entry "${id}" must have a non-empty "description"`,
    );
  }
  if (raw['transport'] !== 'stdio' && raw['transport'] !== 'http') {
    throw new Error(
      `Invalid MCP marketplace registry: entry "${id}": "transport" must be "stdio" or "http"`,
    );
  }
  if (raw['command'] !== undefined && typeof raw['command'] !== 'string') {
    throw new Error(`Invalid MCP marketplace registry: entry "${id}": "command" must be a string`);
  }
  if (
    raw['args'] !== undefined &&
    (!Array.isArray(raw['args']) || raw['args'].some((a) => typeof a !== 'string'))
  ) {
    throw new Error(
      `Invalid MCP marketplace registry: entry "${id}": "args" must be an array of strings`,
    );
  }
  if (raw['url'] !== undefined && typeof raw['url'] !== 'string') {
    throw new Error(`Invalid MCP marketplace registry: entry "${id}": "url" must be a string`);
  }
  if (raw['needsKey'] !== undefined && typeof raw['needsKey'] !== 'string') {
    throw new Error(`Invalid MCP marketplace registry: entry "${id}": "needsKey" must be a string`);
  }
  if (
    raw['tags'] !== undefined &&
    (!Array.isArray(raw['tags']) || raw['tags'].some((t) => typeof t !== 'string'))
  ) {
    throw new Error(
      `Invalid MCP marketplace registry: entry "${id}": "tags" must be an array of strings`,
    );
  }
  const entry: MarketplaceServer = {
    id,
    name: raw['name'] as string,
    description: raw['description'] as string,
    transport: raw['transport'] as MarketplaceTransport,
    tags: Array.isArray(raw['tags']) ? [...(raw['tags'] as string[])] : [],
  };
  if (typeof raw['command'] === 'string') entry.command = raw['command'];
  if (Array.isArray(raw['args'])) entry.args = [...(raw['args'] as string[])];
  if (typeof raw['url'] === 'string') entry.url = raw['url'];
  if (typeof raw['needsKey'] === 'string') entry.needsKey = raw['needsKey'];
  return entry;
}

/** Deep copy of the built-in catalogue (callers must not mutate it). */
export function defaultMarketplaceServers(): MarketplaceServer[] {
  return DEFAULT_MARKETPLACE_SERVERS.map((s) => ({
    ...s,
    args: s.args ? [...s.args] : undefined,
    tags: [...s.tags],
  }));
}

/**
 * Load the registry file at `<baseDir>/marketplace/mcp-servers.json`.
 * Missing file → seed it with the 8 built-in entries and return them.
 * Invalid JSON / bad shape → clear Error (file content is never echoed).
 */
export function loadMarketplaceRegistry(baseDir: string): MarketplaceServer[] {
  const filePath = getMarketplaceRegistryPath(baseDir);
  if (!fs.existsSync(filePath)) {
    const defaults = defaultMarketplaceServers();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ servers: defaults }, null, 2) + '\n', 'utf8');
    return defaults;
  }
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read MCP marketplace registry: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid MCP marketplace registry: not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error('Invalid MCP marketplace registry: top level must be an object with a "servers" array');
  }
  const serversRaw = parsed['servers'];
  if (!Array.isArray(serversRaw)) {
    throw new Error('Invalid MCP marketplace registry: "servers" must be an array');
  }
  const seen = new Set<string>();
  return serversRaw.map((raw, i) => {
    const entry = validateMarketplaceEntry(raw, i);
    if (seen.has(entry.id)) {
      throw new Error(`Invalid MCP marketplace registry: duplicate server id "${entry.id}"`);
    }
    seen.add(entry.id);
    return entry;
  });
}

/**
 * List every server available in the catalogue. With no `baseDir` the
 * built-in list is returned (no file touched); with one, the registry
 * file under it is loaded (seeded on first use).
 */
export function listAvailable(baseDir?: string): MarketplaceServer[] {
  if (baseDir === undefined) return defaultMarketplaceServers();
  return loadMarketplaceRegistry(baseDir);
}

/** Find one catalogue entry by id, or `undefined` when unknown. */
export function getAvailable(id: string, baseDir?: string): MarketplaceServer | undefined {
  assertId(id);
  return listAvailable(baseDir).find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// Registry fingerprint + probe cache (v0.68a) — cache invalidation.
// ---------------------------------------------------------------------------

/**
 * Fingerprint of the catalogue content (v0.68a): SHA-256 over the
 * canonical JSON of the entries `listAvailable()` returns (keys in a
 * fixed order, so a whitespace-only rewrite of mcp-servers.json does
 * NOT change the fingerprint, but any semantic change — url, command,
 * args, needsKey, added/removed entry — does).
 *
 * The main process keys its session probe cache by
 * `serverId + fingerprint`, so a probe result cached under an old
 * catalogue is never served after the user edits the registry: the
 * fingerprint differs and the entry is a miss, not a hit.
 *
 * Returns `null` when the registry cannot be read/parsed — the caller
 * must then bypass the cache entirely (probe anyway and surface the
 * real registry error instead of serving a stale result).
 */
export function getMarketplaceRegistryFingerprint(baseDir?: string): string | null {
  let servers: MarketplaceServer[];
  try {
    servers = listAvailable(baseDir);
  } catch {
    return null;
  }
  const canonical = JSON.stringify(
    servers.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      transport: s.transport,
      command: s.command ?? null,
      args: s.args ?? null,
      url: s.url ?? null,
      needsKey: s.needsKey ?? null,
      tags: s.tags,
    })),
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Session cache for marketplace probe results (v0.68a), keyed by
 * server id + registry fingerprint. This is the cache the main
 * process uses for IPC `mcp-marketplace:tools`; it lives here (not
 * in main.ts) so the invalidation rule is unit-testable.
 *
 * Rules (same as the v0.67a main.ts Map, plus invalidation):
 *  - Only 'ok' and 'needs-key' results are stored — both are stable
 *    while the catalogue is unchanged. 'error' results are NEVER
 *    stored, so the user can retry after fixing the server.
 *  - `get()` returns a hit only when the fingerprint matches the one
 *    the entry was stored under. After any catalogue change the
 *    fingerprint differs and the old entry is a miss (the stale
 *    result is never returned); `set()` under the new fingerprint
 *    replaces it.
 */
export class MarketplaceProbeCache {
  private readonly entries = new Map<
    string,
    { fingerprint: string; result: MarketplaceProbeResult }
  >();

  get(serverId: string, fingerprint: string): MarketplaceProbeResult | undefined {
    const entry = this.entries.get(serverId);
    if (!entry || entry.fingerprint !== fingerprint) return undefined;
    return entry.result;
  }

  /** Store a result; returns false when it was not stored (status 'error'). */
  set(serverId: string, fingerprint: string, result: MarketplaceProbeResult): boolean {
    if (result.status === 'error') return false;
    this.entries.set(serverId, { fingerprint, result });
    return true;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

function buildNextSteps(entry: MarketplaceServer, config: McpServerConfig): string[] {
  const steps: string[] = [];
  for (const arg of config.args ?? []) {
    if (arg.startsWith('<') && arg.endsWith('>')) {
      steps.push(
        `Replace the placeholder arg "${arg}" in .open-bot/mcp.json (server "${config.name}") with a real value.`,
      );
    }
  }
  if (entry.needsKey) {
    steps.push(`This server needs a credential — ${entry.needsKey}.`);
    steps.push(
      'Open-bot never stores that credential for you: add it to .open-bot/mcp.json yourself (env for stdio servers, headers for HTTP servers).',
    );
  }
  return steps;
}

function buildServerConfig(entry: MarketplaceServer, overrides?: InstallOverrides): McpServerConfig {
  if (overrides?.name !== undefined) assertId(overrides.name, 'override name');
  if (
    overrides?.args !== undefined &&
    (!Array.isArray(overrides.args) || overrides.args.some((a) => typeof a !== 'string'))
  ) {
    throw new Error('Invalid MCP marketplace install overrides: "args" must be an array of strings');
  }
  const config: McpServerConfig = { name: overrides?.name ?? entry.id };
  if (entry.command) config.command = entry.command;
  const args = overrides?.args ?? entry.args;
  if (args) config.args = [...args];
  if (entry.url) config.url = entry.url;
  // NOTE: no env / headers are ever written here — credentials are the
  // user's to fill in afterwards (see buildNextSteps).
  return config;
}

/**
 * Read `<workspaceDir>/.open-bot/mcp.json` as raw JSON (preserving every
 * existing server entry verbatim), apply `mutate` to its `servers`
 * object, and write it back. Throws a clear error when the file holds
 * invalid JSON or a bad shape. Validates the result through the v0.2
 * loader so a broken file is never written.
 */
function editMcpJson(
  workspaceDir: string,
  mutate: (servers: Record<string, unknown>) => void,
): void {
  assertNonEmptyString(workspaceDir, 'workspaceDir');
  const filePath = path.join(workspaceDir, MCP_CONFIG_REL_PATH);
  let parsed: Record<string, unknown> = { servers: {} };
  if (fs.existsSync(filePath)) {
    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      throw new Error(`Cannot read MCP config at ${MCP_CONFIG_REL_PATH}: ${(err as Error).message}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `Invalid MCP config at ${MCP_CONFIG_REL_PATH}: not valid JSON: ${(err as Error).message}`,
      );
    }
    if (!isRecord(raw)) {
      throw new Error(
        `Invalid MCP config at ${MCP_CONFIG_REL_PATH}: top level must be an object with a "servers" field`,
      );
    }
    parsed = { ...raw };
    if (parsed['servers'] === undefined) parsed['servers'] = {};
    if (!isRecord(parsed['servers'])) {
      throw new Error(`Invalid MCP config at ${MCP_CONFIG_REL_PATH}: "servers" must be an object`);
    }
  }
  const servers = parsed['servers'] as Record<string, unknown>;
  mutate(servers);
  parsed['servers'] = servers;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  // Re-read through the real loader: proves the written file is valid
  // and that no other server was lost in the round-trip.
  loadMcpConfig(workspaceDir);
}

/**
 * Install a catalogue server into a workspace: writes its entry into
 * `<workspaceDir>/.open-bot/mcp.json`, keeping all other servers.
 * Throws when the id is unknown, invalid, or already installed.
 * Never writes a key/token — see the returned `nextSteps`.
 */
export function install(
  id: string,
  workspaceDir: string,
  overrides?: InstallOverrides,
  baseDir?: string,
): InstallResult {
  assertId(id);
  assertNonEmptyString(workspaceDir, 'workspaceDir');
  const entry = getAvailable(id, baseDir);
  if (!entry) {
    throw new Error(
      `Unknown MCP marketplace server "${id}": no such entry in the catalogue (see listAvailable())`,
    );
  }
  const config = buildServerConfig(entry, overrides);
  const key = config.name;
  const existing = loadMcpConfig(workspaceDir);
  if (Object.prototype.hasOwnProperty.call(existing.servers, key)) {
    throw new Error(
      `MCP server "${key}" is already installed in this workspace — uninstall it first to reinstall`,
    );
  }
  editMcpJson(workspaceDir, (servers) => {
    servers[key] = { ...config };
  });
  return { server: entry, config, nextSteps: buildNextSteps(entry, config) };
}

/**
 * Install một MCP server từ registry chuẩn (`server.json`, v0.13):
 * entry đã validate (qua `parseRegistryFile` / `parseServerJson` /
 * `loadRegistryFile`) được chuyển thành `McpServerConfig` qua
 * `registryEntryToMcpConfig` rồi ghi vào `<workspaceDir>/.open-bot/mcp.json`
 * như `install()` — giữ nguyên mọi server khác, không bao giờ ghi
 * key/token. Tên trong mcp.json là phần cuối của tên registry (sau `/`
 * cuối), trừ khi `overrides.name` đặt tên khác.
 */
export function installFromRegistryEntry(
  workspaceDir: string,
  entry: RegistryServerEntry,
  overrides?: InstallOverrides,
): InstallResult {
  assertNonEmptyString(workspaceDir, 'workspaceDir');
  const config = registryEntryToMcpConfig(entry);
  if (overrides?.name !== undefined) assertId(overrides.name, 'override name');
  const key = overrides?.name ?? config.name;
  const existing = loadMcpConfig(workspaceDir);
  if (Object.prototype.hasOwnProperty.call(existing.servers, key)) {
    throw new Error(
      `MCP server "${key}" is already installed in this workspace — uninstall it first to reinstall`,
    );
  }
  const finalConfig: McpServerConfig = {
    ...config,
    name: key,
    ...(overrides?.args !== undefined ? { args: overrides.args } : {}),
  };
  editMcpJson(workspaceDir, (servers) => {
    servers[key] = { ...finalConfig };
  });
  const server: MarketplaceServer = {
    id: key,
    name: entry.name,
    description: entry.description,
    transport: finalConfig.url ? 'http' : 'stdio',
    command: finalConfig.command,
    args: finalConfig.args,
    url: finalConfig.url,
    tags: [],
  };
  return { server, config: finalConfig, nextSteps: buildNextSteps(server, finalConfig) };
}

/**
 * Tải một remote registry (`server.json`, v0.13), tìm server theo tên
 * đầy đủ (`io.github.example/filesystem`) hoặc tên rút gọn (`filesystem`),
 * rồi cài vào workspace. `registryUrl` là bắt buộc — open-bot không
 * hard-code registry mặc định (tránh phụ thuộc vào một registry trung
 * tâm duy nhất). Cache local (TTL 1h mặc định) qua `cacheDir` khi có.
 */
export async function installRegistryServer(
  workspaceDir: string,
  idOrName: string,
  opts: {
    registryUrl: string;
    cacheDir?: string;
    overrides?: InstallOverrides;
    fetchFn?: RegistryFetchFn;
  },
): Promise<InstallResult> {
  assertNonEmptyString(workspaceDir, 'workspaceDir');
  if (!idOrName?.trim()) {
    throw new Error('installRegistryServer cần id hoặc tên server trong registry.');
  }
  if (!opts?.registryUrl?.trim()) {
    throw new Error(
      'installRegistryServer cần registryUrl — open-bot không có registry mặc định.',
    );
  }
  const { registry } = await fetchRemoteRegistry({
    url: opts.registryUrl,
    cacheDir: opts.cacheDir,
    fetchFn: opts.fetchFn,
  });
  const entry =
    findRegistryServer(registry, idOrName) ??
    registry.servers.find((s) => s.name.split('/').pop() === idOrName);
  if (!entry) {
    throw new Error(
      `Không tìm thấy server "${idOrName}" trong registry ${opts.registryUrl}.`,
    );
  }
  return installFromRegistryEntry(workspaceDir, entry, opts.overrides);
}

/**
 * Uninstall a server from a workspace: removes its entry from
 * `<workspaceDir>/.open-bot/mcp.json`, keeping all other servers.
 * Throws when the id is invalid or the server is not installed.
 * Returns the removed config.
 */
export function uninstall(id: string, workspaceDir: string): McpServerConfig {
  assertId(id);
  assertNonEmptyString(workspaceDir, 'workspaceDir');
  const existing = loadMcpConfig(workspaceDir);
  const removed = existing.servers[id];
  if (!removed) {
    throw new Error(`MCP server "${id}" is not installed in this workspace`);
  }
  editMcpJson(workspaceDir, (servers) => {
    delete servers[id];
  });
  return removed;
}

/** List the servers currently installed in a workspace (from mcp.json). */
export function listInstalled(workspaceDir: string): McpServerConfig[] {
  assertNonEmptyString(workspaceDir, 'workspaceDir');
  return Object.values(loadMcpConfig(workspaceDir).servers);
}

// ---------------------------------------------------------------------------
// Tool probe (v0.67a) — list the tools one catalogue server exposes.
// ---------------------------------------------------------------------------

/** Default per-probe wall-clock budget (initialize + tools/list). */
export const MARKETPLACE_PROBE_TIMEOUT_MS = 20_000;

/** Hard cap on tools returned by one probe (a runaway server must not
 *  flood the IPC channel with thousands of tool definitions). */
export const MARKETPLACE_PROBE_MAX_TOOLS = 200;

export type MarketplaceProbeStatus = 'ok' | 'needs-key' | 'error';

/** One tool, trimmed to what the marketplace UI renders. */
export interface MarketplaceToolSummary {
  name: string;
  description?: string;
  /** Raw JSON Schema for the tool's arguments (properties + required). */
  inputSchema?: Record<string, unknown>;
}

export interface MarketplaceProbeResult {
  serverId: string;
  status: MarketplaceProbeStatus;
  /** Empty unless status is 'ok'. */
  tools: MarketplaceToolSummary[];
  /** True when the server listed more tools than the cap. */
  truncated: boolean;
  /** Human-readable reason when status is 'error' (or 'needs-key'). */
  error?: string;
  /**
   * v0.73: warnings the client reported while listing tools — today
   * only the `-32602` tools/list rejection (see `McpListWarning` in
   * mcp/types.ts). Present only when at least one warning fired, so
   * an 'ok' probe with `tools: []` can still tell the caller WHY
   * the list came back empty instead of looking like a server with
   * no tools. Plain data (no functions), so it survives the
   * main-process IPC hop and the probe cache unchanged.
   */
  warnings?: McpListWarning[];
}

export interface ProbeMarketplaceServerToolsOptions {
  /** Per-probe timeout in ms (default MARKETPLACE_PROBE_TIMEOUT_MS). */
  timeoutMs?: number;
  /**
   * v0.73: called for each warning the client reports while listing
   * tools (same `McpListWarning` the client hands to
   * `McpServerConfig.onWarning`). The same warnings are also
   * collected into `MarketplaceProbeResult.warnings`, so a caller
   * that only reads the result still sees them; this callback is
   * for callers that want to stream/log them as they fire. A
   * throwing callback must not fail the probe (wrapped in
   * try/catch, like the client's own onWarning handling).
   */
  onWarning?: (warning: McpListWarning) => void;
}

function probeError(serverId: string, message: string): MarketplaceProbeResult {
  return { serverId, status: 'error', tools: [], truncated: false, error: message };
}

function toToolSummary(tool: McpToolDef): MarketplaceToolSummary {
  const summary: MarketplaceToolSummary = { name: tool.name };
  if (typeof tool.description === 'string' && tool.description) {
    summary.description = tool.description;
  }
  if (tool.inputSchema && typeof tool.inputSchema === 'object') {
    summary.inputSchema = tool.inputSchema;
  }
  return summary;
}

/**
 * Race a promise against a wall-clock timeout. The timeout rejects with
 * a clear message; the underlying work keeps running until the caller
 * closes the client (the probe's finally block does that), so a slow
 * server is killed promptly instead of lingering until its own
 * 30s request timeout.
 */
function withProbeTimeout<T>(
  promise: Promise<T>,
  ms: number,
  step: string,
  serverId: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for "${step}" from MCP server "${serverId}" after ${ms}ms — the server may be slow, stuck, or not an MCP server`,
        ),
      );
    }, ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Probe one catalogue server and list the tools it exposes.
 *
 * On demand only — the caller (main IPC `mcp-marketplace:tools`) runs
 * this when the user clicks "View tools" on one server, never for the
 * whole catalogue at once. Spawns the server exactly as catalogued
 * (stdio via command/args, HTTP via url), runs the `initialize`
 * handshake + `tools/list`, then closes the client (stdio child is
 * killed, HTTP session torn down) before returning.
 *
 * Fail-closed, never throws for a probe failure: spawn failure,
 * timeout, non-MCP output and protocol errors all come back as
 * `{ status: 'error', error }`. Only a bad id (invalid shape or
 * unknown in the catalogue) or a bad timeout throws, like install().
 *
 * SECURITY — no secrets here, ever:
 *  - A server with `needsKey` is NEVER probed: probing it would need
 *    its credential, and this function never reads the Vault or
 *    guesses a key. It returns `{ status: 'needs-key' }` instead.
 *  - A server whose args still contain a "<placeholder>" is never
 *    spawned either: running it with a literal placeholder path would
 *    be meaningless (and could touch an unintended directory). It
 *    returns an 'error' telling the user to configure it first.
 *  - No env / headers are ever attached to the probe config, so no
 *    credential can leak into the spawned process.
 */
export async function probeMarketplaceServerTools(
  id: string,
  baseDir?: string,
  opts?: ProbeMarketplaceServerToolsOptions,
): Promise<MarketplaceProbeResult> {
  assertId(id);
  const timeoutMs = opts?.timeoutMs ?? MARKETPLACE_PROBE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `Invalid MCP marketplace probe timeout "${String(opts?.timeoutMs)}": must be a positive number of milliseconds`,
    );
  }
  const entry = getAvailable(id, baseDir);
  if (!entry) {
    throw new Error(
      `Unknown MCP marketplace server "${id}": no such entry in the catalogue (see listAvailable())`,
    );
  }
  if (entry.needsKey) {
    return {
      serverId: id,
      status: 'needs-key',
      tools: [],
      truncated: false,
      error:
        `Server "${entry.name}" needs a credential before its tools can be listed — ${entry.needsKey}.`,
    };
  }
  const placeholderArg = (entry.args ?? []).find(
    (a) => a.startsWith('<') && a.endsWith('>'),
  );
  if (placeholderArg !== undefined) {
    return probeError(
      id,
      `Server "${entry.name}" needs configuration first: replace the placeholder arg "${placeholderArg}" with a real value (see the install next-steps), then try again.`,
    );
  }
  // v0.73: wire the client's -32602 list warning through — before
  // this the probe built its config with no `onWarning`, so a
  // server that rejected tools/list with -32602 made the probe
  // return `{ status: 'ok', tools: [] }` with the reason silently
  // swallowed (the client still returned [] by design). Warnings
  // are collected into the result AND forwarded to
  // `opts.onWarning` when the caller passed one.
  const warnings: McpListWarning[] = [];
  const config: McpServerConfig = {
    name: entry.id,
    onWarning: (warning) => {
      warnings.push(warning);
      try {
        opts?.onWarning?.(warning);
      } catch {
        // A failing warning callback must not fail the probe.
      }
    },
  };
  if (entry.transport === 'stdio') {
    if (!entry.command) {
      return probeError(id, `Server "${entry.name}" has no command to spawn (stdio transport).`);
    }
    config.command = entry.command;
    if (entry.args) config.args = [...entry.args];
  } else {
    if (!entry.url) {
      return probeError(id, `Server "${entry.name}" has no URL (http transport).`);
    }
    config.url = entry.url;
  }
  // Build the client directly (instead of connectMcp) so this function
  // owns the client handle: on timeout it can close() immediately and
  // kill the child instead of waiting for connectMcp's own handshake
  // to settle. No clientHandlers are registered — a probe only needs
  // initialize + tools/list.
  let client: StdioMcpClient | StreamableHttpMcpClient;
  try {
    client =
      config.command !== undefined
        ? new StdioMcpClient(config)
        : new StreamableHttpMcpClient(config);
  } catch (err) {
    return probeError(id, (err as Error).message);
  }
  try {
    await withProbeTimeout(client.initialize(), timeoutMs, 'initialize', id);
    const tools = await withProbeTimeout(client.listTools(), timeoutMs, 'tools/list', id);
    const summaries = tools.map(toToolSummary);
    return {
      serverId: id,
      status: 'ok',
      tools: summaries.slice(0, MARKETPLACE_PROBE_MAX_TOOLS),
      truncated: summaries.length > MARKETPLACE_PROBE_MAX_TOOLS,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (err) {
    const message = (err as Error).message;
    if (/HTTP 401\b/.test(message)) {
      // v0.69b: the probe never attaches a credential (no env /
      // headers / auth provider), so a 401 means this server requires
      // one — say so plainly instead of leaving the bare status code.
      // The probe still cannot list its tools; the user installs the
      // server and adds the credential to .open-bot/mcp.json
      // (headers for HTTP servers) so the bot runtime can use it.
      return probeError(
        id,
        `Server "${entry.name}" requires authentication (HTTP 401) — the probe never sends a credential, so it cannot list this server's tools; install the server and add the credential to .open-bot/mcp.json yourself (headers for HTTP servers), then the bot runtime will use it from there.`,
      );
    }
    return probeError(id, message);
  } finally {
    await client.close().catch(() => undefined);
  }
}
