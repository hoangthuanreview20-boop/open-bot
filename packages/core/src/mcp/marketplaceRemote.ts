/**
 * MCP marketplace v2 — remote catalog (worker F1, v0.89a).
 *
 * Fetches a marketplace catalog over HTTPS and validates it before
 * anything in it can be installed. Fail-closed by design:
 *
 * - Only `https:` URLs, and only when the host is on an allowlist.
 *   The allowlist is configured by the user/host in
 *   `<baseDir>/marketplace/remote-hosts.json`
 *   (`{ "hosts": ["catalog.example.com"] }`, exact host match, or a
 *   `"*.example.com"` wildcard for subdomains). With no allowlist
 *   configured, EVERY remote fetch is refused — there is no default
 *   central catalog, so a fresh install cannot be pointed at an
 *   attacker's server by a stray URL.
 * - 15s timeout (AbortController), 1 MiB body cap, non-2xx refused.
 * - Strict schema validation: top level `{ "servers": [...] }` (a bare
 *   array is also accepted); every entry must have `id`, `name`,
 *   `description`, `version` (strict semver), `transport`
 *   ("stdio" | "http"), and `command` + `args` for stdio or `url`
 *   (https only) for http. A wrong shape is a clear Error naming the
 *   entry — never a partial install, never the raw body in the error.
 * - No credential is ever accepted from a catalog: an entry carrying
 *   `env` / `headers` / a URL with embedded credentials is rejected
 *   outright.
 *
 * This module never writes to mcp.json — it only returns validated
 * entries. `marketplaceVersions.installVersion()` installs from them
 * (via `opts.catalog`), and `mergeCatalogs()` overlays them on the
 * local registry (remote wins on an id collision, and the entry keeps
 * `source: 'remote'` + `catalogUrl` so the UI can show where it came
 * from).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VersionedMarketplaceServer } from './marketplaceVersions';
import { isValidVersion } from './marketplaceVersions';
import type { RegistryFetchFn } from './registry';

/** Default per-fetch wall-clock budget. */
export const REMOTE_CATALOG_TIMEOUT_MS = 15_000;
/** Hard cap on a catalog body (a catalog is a small JSON list). */
export const REMOTE_CATALOG_MAX_BYTES = 1_048_576;

export const REMOTE_CATALOG_HOSTS_REL_PATH = path.join(
  'marketplace',
  'remote-hosts.json',
);

const ID_RE = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Hosts allowed to serve remote catalogs. Missing file → [] (nothing
 * allowed). Invalid JSON / bad shape → Error (fail-closed: a broken
 * allowlist file must be fixed by hand, not treated as "allow all").
 */
export function loadRemoteCatalogHosts(baseDir: string): string[] {
  if (typeof baseDir !== 'string' || !baseDir.trim()) {
    throw new Error('Invalid remote catalog: "baseDir" must be a non-empty string');
  }
  const filePath = path.join(baseDir, REMOTE_CATALOG_HOSTS_REL_PATH);
  if (!fs.existsSync(filePath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(
      `Invalid remote catalog allowlist: not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['hosts'])) {
    throw new Error(
      'Invalid remote catalog allowlist: top level must be an object with a "hosts" array',
    );
  }
  const hosts: string[] = [];
  for (const host of parsed['hosts'] as unknown[]) {
    if (typeof host !== 'string' || !host.trim()) {
      throw new Error('Invalid remote catalog allowlist: every "hosts" entry must be a non-empty string');
    }
    hosts.push(host.trim().toLowerCase());
  }
  return hosts;
}

/** True when `host` matches an allowlist entry (exact or `*.domain`). */
export function isAllowedCatalogHost(host: string, allowedHosts: string[]): boolean {
  const lower = host.toLowerCase();
  return allowedHosts.some((entry) => {
    const e = entry.toLowerCase();
    if (e.startsWith('*.')) return lower.endsWith(e.slice(1)) && lower !== e.slice(2);
    return lower === e;
  });
}

function validateRemoteEntry(raw: unknown, index: number, catalogUrl: string): VersionedMarketplaceServer {
  const where = `Remote catalog entry #${index} from ${catalogUrl}`;
  if (!isRecord(raw)) throw new Error(`${where} must be an object`);
  const id = raw['id'];
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new Error(`${where} has an invalid "id" (must match /^[A-Za-z0-9_-]+$/)`);
  }
  if (typeof raw['name'] !== 'string' || !raw['name'].trim()) {
    throw new Error(`${where} ("${id}") must have a non-empty "name"`);
  }
  if (typeof raw['description'] !== 'string' || !raw['description'].trim()) {
    throw new Error(`${where} ("${id}") must have a non-empty "description"`);
  }
  if (typeof raw['version'] !== 'string' || !isValidVersion(raw['version'])) {
    throw new Error(
      `${where} ("${id}") must have a "version" that is a semver string (MAJOR.MINOR.PATCH)`,
    );
  }
  if (raw['transport'] !== 'stdio' && raw['transport'] !== 'http') {
    throw new Error(`${where} ("${id}"): "transport" must be "stdio" or "http"`);
  }
  if (raw['env'] !== undefined || raw['headers'] !== undefined) {
    throw new Error(
      `${where} ("${id}") must not carry "env" or "headers" — catalogs never provide credentials`,
    );
  }
  const entry: VersionedMarketplaceServer = {
    id,
    name: raw['name'],
    description: raw['description'],
    version: raw['version'],
    transport: raw['transport'],
    tags: [],
    source: 'remote',
    catalogUrl,
  };
  if (raw['transport'] === 'stdio') {
    if (typeof raw['command'] !== 'string' || !raw['command'].trim()) {
      throw new Error(`${where} ("${id}"): stdio servers must have a non-empty "command"`);
    }
    entry.command = raw['command'];
    if (raw['args'] !== undefined) {
      if (!Array.isArray(raw['args']) || raw['args'].some((a) => typeof a !== 'string')) {
        throw new Error(`${where} ("${id}"): "args" must be an array of strings`);
      }
      entry.args = [...(raw['args'] as string[])];
    }
  } else {
    if (typeof raw['url'] !== 'string' || !raw['url'].trim()) {
      throw new Error(`${where} ("${id}"): http servers must have a non-empty "url"`);
    }
    let parsed: URL;
    try {
      parsed = new URL(raw['url']);
    } catch {
      throw new Error(`${where} ("${id}"): "url" is not a valid URL`);
    }
    if (parsed.protocol !== 'https:') {
      throw new Error(`${where} ("${id}"): "url" must be https://`);
    }
    if (parsed.username || parsed.password) {
      throw new Error(`${where} ("${id}"): "url" must not embed credentials`);
    }
    entry.url = raw['url'];
  }
  if (typeof raw['needsKey'] === 'string') entry.needsKey = raw['needsKey'];
  if (Array.isArray(raw['tags'])) {
    if (raw['tags'].some((t) => typeof t !== 'string')) {
      throw new Error(`${where} ("${id}"): "tags" must be an array of strings`);
    }
    entry.tags = [...(raw['tags'] as string[])];
  }
  if (raw['changelog'] !== undefined) {
    if (typeof raw['changelog'] !== 'string') {
      throw new Error(`${where} ("${id}"): "changelog" must be a string`);
    }
    entry.changelog = raw['changelog'];
  }
  if (raw['minAppVersion'] !== undefined) {
    if (typeof raw['minAppVersion'] !== 'string' || !isValidVersion(raw['minAppVersion'])) {
      throw new Error(`${where} ("${id}"): "minAppVersion" must be a semver string`);
    }
    entry.minAppVersion = raw['minAppVersion'];
  }
  return entry;
}

/**
 * Validate a single versioned entry supplied by an untrusted caller
 * (e.g. the renderer passing back a remote-catalog entry it wants
 * installed). Same rules as `parseRemoteCatalog`, for one entry.
 */
export function validateVersionedMarketplaceServer(raw: unknown): VersionedMarketplaceServer {
  return validateRemoteEntry(raw, 0, 'renderer-supplied entry');
}

/**
 * Parse + validate a catalog body (exported for tests and for callers
 * that already have the text, e.g. a cached copy). Accepts
 * `{ "servers": [...] }` or a bare `[...]` array. Throws a clear Error
 * on any shape problem; duplicate ids are rejected.
 */
export function parseRemoteCatalog(text: string, catalogUrl: string): VersionedMarketplaceServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Remote catalog from ${catalogUrl} is not valid JSON: ${(err as Error).message}`);
  }
  const serversRaw = isRecord(parsed) ? parsed['servers'] : Array.isArray(parsed) ? parsed : undefined;
  if (!Array.isArray(serversRaw)) {
    throw new Error(
      `Remote catalog from ${catalogUrl} has a bad shape: top level must be an object with a "servers" array`,
    );
  }
  const seen = new Set<string>();
  return serversRaw.map((raw, i) => {
    const entry = validateRemoteEntry(raw, i, catalogUrl);
    if (seen.has(entry.id)) {
      throw new Error(`Remote catalog from ${catalogUrl} has a duplicate server id "${entry.id}"`);
    }
    seen.add(entry.id);
    return entry;
  });
}

export interface FetchRemoteCatalogOptions {
  /** Explicit allowlist (takes precedence over `baseDir`). */
  allowedHosts?: string[];
  /** User-data dir: the allowlist is read from it when `allowedHosts` is absent. */
  baseDir?: string;
  /** Per-fetch timeout in ms (default REMOTE_CATALOG_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Injectable fetch (tests pass a mock; defaults to global fetch). */
  fetchFn?: RegistryFetchFn;
  /** Body cap in bytes (default REMOTE_CATALOG_MAX_BYTES). */
  maxBytes?: number;
}

/**
 * Fetch a remote catalog: https-only, host must be allowlisted,
 * 15s timeout, body cap, strict schema validation. Any failure is a
 * clear Error; nothing is installed or cached by this function.
 */
export async function fetchRemoteMarketplaceCatalog(
  url: string,
  opts: FetchRemoteCatalogOptions = {},
): Promise<VersionedMarketplaceServer[]> {
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('Invalid remote catalog URL: must be a non-empty string');
  }
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error(`Invalid remote catalog URL "${url}": not a valid URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `Remote catalog URL must use https:// (got "${parsed.protocol}") — plain http is refused`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error('Remote catalog URL must not embed credentials');
  }
  const allowedHosts =
    opts.allowedHosts ?? (opts.baseDir !== undefined ? loadRemoteCatalogHosts(opts.baseDir) : []);
  if (allowedHosts.length === 0) {
    throw new Error(
      `Remote catalog host "${parsed.hostname}" is not allowlisted — add it to marketplace/remote-hosts.json first (no hosts are allowlisted by default).`,
    );
  }
  if (!isAllowedCatalogHost(parsed.hostname, allowedHosts)) {
    throw new Error(
      `Remote catalog host "${parsed.hostname}" is not allowlisted — add it to marketplace/remote-hosts.json first.`,
    );
  }
  const timeoutMs = opts.timeoutMs ?? REMOTE_CATALOG_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid remote catalog timeout "${String(opts.timeoutMs)}": must be a positive number of milliseconds`);
  }
  const maxBytes = opts.maxBytes ?? REMOTE_CATALOG_MAX_BYTES;
  const fetchFn = opts.fetchFn ?? fetch;
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
      throw new Error(`Could not fetch remote catalog from ${url}: timed out after ${timeoutMs}ms.`);
    }
    throw new Error(`Could not fetch remote catalog from ${url}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`Could not fetch remote catalog from ${url}: HTTP ${res.status}.`);
  }
  const body = await res.text();
  if (body.length > maxBytes) {
    throw new Error(
      `Remote catalog from ${url} is too large (${body.length} bytes > ${maxBytes} cap) — refused.`,
    );
  }
  return parseRemoteCatalog(body, url);
}

/**
 * Overlay remote entries on the local registry: remote wins on an id
 * collision (it is the newer source by construction — the caller
 * fetched it just now), local entries not present remotely are kept.
 */
export function mergeCatalogs(
  local: VersionedMarketplaceServer[],
  remote: VersionedMarketplaceServer[],
): VersionedMarketplaceServer[] {
  const byId = new Map<string, VersionedMarketplaceServer>();
  for (const entry of local) byId.set(entry.id, entry);
  for (const entry of remote) byId.set(entry.id, entry);
  return [...byId.values()];
}
