/**
 * MCP marketplace v2 — versions (worker F1, v0.89a).
 *
 * What the v0.3 marketplace lacked: any notion of a version. A server
 * was installed once and never updated, and nothing recorded which
 * version was installed. This module adds that layer on top of the
 * v0.3 catalogue (`marketplace.ts`) without changing its install
 * contract:
 *
 * - `VersionedMarketplaceServer`: a catalogue entry plus `version`
 *   (semver, required in a versioned registry), `changelog` and
 *   `minAppVersion` (the oldest app version this server version works
 *   with — an update whose minAppVersion is newer than the running app
 *   is reported as incompatible and refused).
 * - `parseVersion` / `compareVersions`: strict semver comparison
 *   (numeric MAJOR.MINOR.PATCH, pre-release < release, build metadata
 *   ignored for precedence).
 * - Installed versions are recorded in TWO places, deliberately:
 *   (1) the authoritative sidecar `<baseDir>/marketplace/
 *   mcp-installed.json` (`{ "<id>": { version, installedAt, source } }`),
 *   (2) a `marketplaceVersion` field on the server's entry in the
 *   workspace's `.open-bot/mcp.json` (human-readable in the file; the
 *   v0.2 loader ignores unknown fields, so the sidecar is what code
 *   reads). No credential is ever written to either place — install
 *   still never writes env/headers.
 * - `checkForUpdates()` compares installed vs catalogued versions;
 *   `updateInstalled()` swaps the entry's command/args/url in place,
 *   preserving any env/headers the user filled in by hand (an
 *   uninstall + reinstall would have destroyed them).
 * - `searchMarketplaceServers()` is the main-process search used by
 *   IPC `mcp-marketplace:search` (diacritic-insensitive, same
 *   algorithm as the renderer's `filterMarketplaceServers`).
 *
 * LIMITS (honest): a registry file holds ONE version per server id —
 * the latest. `installVersion()` with an older version therefore fails
 * with the available version named; there is no version-history store
 * and no downgrade path beyond editing the registry file by hand.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  getAvailable,
  install as installMarketplaceServer,
  listAvailable,
  listInstalled,
  loadMarketplaceRegistry,
  type InstallOverrides,
  type InstallResult,
  type MarketplaceServer,
} from './marketplace';
import { loadMcpConfig, MCP_CONFIG_REL_PATH } from './config';
import type { McpServerConfig } from './types';

export const MARKETPLACE_INSTALLED_VERSIONS_REL_PATH = path.join(
  'marketplace',
  'mcp-installed.json',
);

/** Field written onto the server's entry in the workspace mcp.json. */
export const MCP_JSON_VERSION_FIELD = 'marketplaceVersion';

/** A catalogue entry with version metadata (v2). */
export interface VersionedMarketplaceServer extends MarketplaceServer {
  /** Semver version of this catalogue entry (e.g. "1.2.0"). */
  version: string;
  /** Human-readable notes about this version (shown in the UI). */
  changelog?: string;
  /** Oldest app version this server version works with (semver). */
  minAppVersion?: string;
  /** Where the entry came from (local registry file vs remote catalog). */
  source?: 'local' | 'remote';
  /** Catalog URL the entry came from (remote entries only). */
  catalogUrl?: string;
}

export interface InstalledVersionRecord {
  version: string;
  installedAt: string;
  source?: 'local' | 'remote';
}

export interface McpUpdateInfo {
  id: string;
  name: string;
  /** Installed version, or "unknown" when nothing recorded it. */
  installedVersion: string;
  /** Latest catalogued version, or null when the server left the catalogue. */
  latestVersion: string | null;
  changelog?: string;
  minAppVersion?: string;
  /** True when a newer version exists in the catalogue. */
  updateAvailable: boolean;
  /** False when the latest version needs a newer app than the running one. */
  compatible: boolean;
}

const ID_RE = /^[A-Za-z0-9_-]+$/;
/** Strict semver: MAJOR.MINOR.PATCH, optional -prerelease / +build. */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifiers (empty = a release). */
  prerelease: string[];
}

/** Parse a strict semver string; throws on anything else. */
export function parseVersion(version: string): ParsedVersion {
  if (typeof version !== 'string') {
    throw new Error(`Invalid version "${String(version)}": must be a semver string (MAJOR.MINOR.PATCH)`);
  }
  const match = SEMVER_RE.exec(version.trim());
  if (!match) {
    throw new Error(
      `Invalid version "${version}": must be a semver string (MAJOR.MINOR.PATCH, e.g. "1.2.0")`,
    );
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/** True when the string parses as a strict semver version. */
export function isValidVersion(version: unknown): version is string {
  if (typeof version !== 'string') return false;
  try {
    parseVersion(version);
    return true;
  } catch {
    return false;
  }
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // a release outranks its pre-release
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (i >= a.length) return -1; // shorter pre-release is smaller
    if (i >= b.length) return 1;
    const x = a[i] as string;
    const y = b[i] as string;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn) return -1; // numeric identifiers sort before alphanumeric
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Compare two semver strings: -1 when a < b, 0 when equal, 1 when
 * a > b. Throws on an invalid version (callers that compare untrusted
 * data should use `isValidVersion` first).
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/** True when `candidate` is strictly newer than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/**
 * True when the running app (`appVersion`) satisfies an entry's
 * `minAppVersion` — or when either side is absent/unparsable (an
 * entry without a declared minimum is installable anywhere; an
 * unparsable minimum is treated as "no minimum" here, and the
 * registry validator in `marketplaceRemote.ts` rejects such entries
 * at the remote-catalog boundary instead).
 */
export function satisfiesMinAppVersion(
  minAppVersion: string | undefined,
  appVersion: string | undefined,
): boolean {
  if (!minAppVersion || !appVersion) return true;
  try {
    return compareVersions(appVersion, minAppVersion) >= 0;
  } catch {
    return true;
  }
}

function assertId(id: string, what = 'id'): void {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new Error(`Invalid MCP marketplace ${what} "${id}": must match /^[A-Za-z0-9_-]+$/`);
  }
}

function assertNonEmptyString(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid MCP marketplace versions: "${what}" must be a non-empty string`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getInstalledVersionsPath(baseDir: string): string {
  assertNonEmptyString(baseDir, 'baseDir');
  return path.join(baseDir, MARKETPLACE_INSTALLED_VERSIONS_REL_PATH);
}

/**
 * Load the versioned registry: the same file the v0.3 loader reads
 * (`<baseDir>/marketplace/mcp-servers.json`, seeded with the 8
 * built-ins on first use), plus the optional per-entry `version` /
 * `changelog` / `minAppVersion` fields. Entries without a `version`
 * get "0.0.0" — they predate versioning, so no update can be proven
 * for them until the registry records a version.
 */
export function loadVersionedRegistry(baseDir: string): VersionedMarketplaceServer[] {
  assertNonEmptyString(baseDir, 'baseDir');
  // Validates the file (and seeds it) exactly like v0.3.
  const base = loadMarketplaceRegistry(baseDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      fs.readFileSync(path.join(baseDir, 'marketplace', 'mcp-servers.json'), 'utf8'),
    );
  } catch (err) {
    throw new Error(`Cannot read MCP marketplace registry: ${(err as Error).message}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['servers'])) {
    throw new Error('Invalid MCP marketplace registry: "servers" must be an array');
  }
  const byId = new Map(base.map((s) => [s.id, s]));
  return (parsed['servers'] as unknown[]).map((raw) => {
    const entry = byId.get((raw as Record<string, unknown>)['id'] as string);
    if (!entry) throw new Error('Invalid MCP marketplace registry: entry mismatch after validation');
    const versioned: VersionedMarketplaceServer = {
      ...entry,
      version: '0.0.0',
      source: 'local',
    };
    if (isRecord(raw)) {
      if (raw['version'] !== undefined) {
        if (typeof raw['version'] !== 'string' || !isValidVersion(raw['version'])) {
          throw new Error(
            `Invalid MCP marketplace registry: entry "${entry.id}": "version" must be a semver string`,
          );
        }
        versioned.version = raw['version'];
      }
      if (raw['changelog'] !== undefined) {
        if (typeof raw['changelog'] !== 'string') {
          throw new Error(
            `Invalid MCP marketplace registry: entry "${entry.id}": "changelog" must be a string`,
          );
        }
        versioned.changelog = raw['changelog'];
      }
      if (raw['minAppVersion'] !== undefined) {
        if (typeof raw['minAppVersion'] !== 'string' || !isValidVersion(raw['minAppVersion'])) {
          throw new Error(
            `Invalid MCP marketplace registry: entry "${entry.id}": "minAppVersion" must be a semver string`,
          );
        }
        versioned.minAppVersion = raw['minAppVersion'];
      }
    }
    return versioned;
  });
}

/** The versioned entry for one id, or undefined when unknown. */
export function getVersionedAvailable(
  id: string,
  baseDir?: string,
  catalog?: VersionedMarketplaceServer[],
): VersionedMarketplaceServer | undefined {
  assertId(id);
  if (catalog) {
    const hit = catalog.find((s) => s.id === id);
    if (hit) return hit;
  }
  if (baseDir === undefined) {
    // No registry file: the built-ins, all unversioned ("0.0.0").
    const plain = getAvailable(id);
    return plain ? { ...plain, version: '0.0.0', source: 'local' as const } : undefined;
  }
  return loadVersionedRegistry(baseDir).find((s) => s.id === id);
}

function readInstalledVersions(baseDir: string): Record<string, InstalledVersionRecord> {
  const filePath = getInstalledVersionsPath(baseDir);
  if (!fs.existsSync(filePath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(
      `Invalid MCP installed-versions file: not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(
      'Invalid MCP installed-versions file: top level must be an object keyed by server id',
    );
  }
  const out: Record<string, InstalledVersionRecord> = {};
  for (const [id, raw] of Object.entries(parsed)) {
    if (!ID_RE.test(id) || !isRecord(raw) || typeof raw['version'] !== 'string') continue;
    out[id] = {
      version: raw['version'],
      installedAt: typeof raw['installedAt'] === 'string' ? raw['installedAt'] : '',
      ...(raw['source'] === 'local' || raw['source'] === 'remote'
        ? { source: raw['source'] as 'local' | 'remote' }
        : {}),
    };
  }
  return out;
}

function writeInstalledVersions(
  baseDir: string,
  records: Record<string, InstalledVersionRecord>,
): void {
  const filePath = getInstalledVersionsPath(baseDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

/** Record (or replace) the installed version of one server. */
export function recordInstalledVersion(
  baseDir: string,
  id: string,
  version: string,
  source?: 'local' | 'remote',
): void {
  assertId(id);
  parseVersion(version);
  const records = readInstalledVersions(baseDir);
  records[id] = {
    version,
    installedAt: new Date().toISOString(),
    ...(source ? { source } : {}),
  };
  writeInstalledVersions(baseDir, records);
}

/** Forget the installed-version record of one server (on uninstall). */
export function removeInstalledVersion(baseDir: string, id: string): void {
  assertId(id);
  const records = readInstalledVersions(baseDir);
  if (!Object.prototype.hasOwnProperty.call(records, id)) return;
  delete records[id];
  writeInstalledVersions(baseDir, records);
}

/**
 * The installed version of a server: the sidecar record first; when
 * there is none, the `marketplaceVersion` field on the raw mcp.json
 * entry (written by installVersion/updateInstalled); `null` when
 * neither exists (installed before versioning, or by hand).
 */
export function getInstalledVersion(
  id: string,
  workspaceDir: string,
  baseDir?: string,
): string | null {
  assertId(id);
  assertNonEmptyString(workspaceDir, 'workspaceDir');
  if (baseDir !== undefined) {
    const record = readInstalledVersions(baseDir)[id];
    if (record) return record.version;
  }
  const filePath = path.join(workspaceDir, MCP_CONFIG_REL_PATH);
  if (!fs.existsSync(filePath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed['servers'])) return null;
  const entry = (parsed['servers'] as Record<string, unknown>)[id];
  if (!isRecord(entry)) return null;
  const version = entry[MCP_JSON_VERSION_FIELD];
  return typeof version === 'string' && isValidVersion(version) ? version : null;
}

/** Next-steps for an install, mirroring marketplace.ts (placeholders + key). */
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

function buildServerConfig(
  entry: MarketplaceServer,
  overrides?: InstallOverrides,
): McpServerConfig {
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
  return config;
}

/**
 * Write one server entry into `<workspaceDir>/.open-bot/mcp.json`
 * (raw JSON round-trip, so every other server — including any
 * env/headers the user filled in — is preserved verbatim), stamp it
 * with `marketplaceVersion`, and re-validate through the v0.2 loader.
 * Used for remote-catalog installs (whose entries are not in the
 * local registry) and by updateInstalled().
 */
function writeServerToMcpJson(
  workspaceDir: string,
  key: string,
  config: McpServerConfig,
  version: string,
): void {
  const filePath = path.join(workspaceDir, MCP_CONFIG_REL_PATH);
  let parsed: Record<string, unknown> = { servers: {} };
  if (fs.existsSync(filePath)) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
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
  servers[key] = { ...config, [MCP_JSON_VERSION_FIELD]: version };
  parsed['servers'] = servers;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  loadMcpConfig(workspaceDir);
}

export interface InstallVersionOptions {
  baseDir?: string;
  overrides?: InstallOverrides;
  /** Remote-catalog entries to install from (checked before the local registry). */
  catalog?: VersionedMarketplaceServer[];
  /** Running app version, for the minAppVersion check. */
  appVersion?: string;
}

/**
 * Install a specific version of a catalogue server. When `version`
 * is omitted the catalogued (latest) version is installed. The
 * requested version must equal the catalogued version — a registry
 * holds one version per id, so an older version cannot be installed
 * from here (the error names the available version).
 *
 * The caller (main IPC) must have called `requireMarketplaceApproval`
 * first; this function only writes.
 */
export function installVersion(
  id: string,
  workspaceDir: string,
  version?: string,
  opts: InstallVersionOptions = {},
): InstallResult & { version: string } {
  assertId(id);
  assertNonEmptyString(workspaceDir, 'workspaceDir');
  if (version !== undefined) parseVersion(version);
  const entry = getVersionedAvailable(id, opts.baseDir, opts.catalog);
  if (!entry) {
    throw new Error(
      `Unknown MCP marketplace server "${id}": no such entry in the catalogue (see listAvailable())`,
    );
  }
  if (version !== undefined && compareVersions(version, entry.version) !== 0) {
    throw new Error(
      `MCP server "${id}" version ${version} is not available — the catalogue has version ${entry.version}.`,
    );
  }
  if (!satisfiesMinAppVersion(entry.minAppVersion, opts.appVersion)) {
    throw new Error(
      `MCP server "${id}" version ${entry.version} needs app version ${entry.minAppVersion} or newer (running ${opts.appVersion ?? 'unknown'}).`,
    );
  }
  const existing = loadMcpConfig(workspaceDir);
  const key = opts.overrides?.name ?? entry.id;
  if (Object.prototype.hasOwnProperty.call(existing.servers, key)) {
    throw new Error(
      `MCP server "${key}" is already installed in this workspace — uninstall it first to reinstall`,
    );
  }
  const config = buildServerConfig(entry, opts.overrides);
  let result: InstallResult;
  if (opts.catalog === undefined && opts.baseDir !== undefined) {
    // Local-registry entry: reuse the v0.3 install (same validation,
    // same next-steps), then stamp the version.
    result = installMarketplaceServer(id, workspaceDir, opts.overrides, opts.baseDir);
    writeServerToMcpJson(workspaceDir, key, result.config, entry.version);
  } else if (opts.catalog === undefined && opts.baseDir === undefined) {
    result = installMarketplaceServer(id, workspaceDir, opts.overrides);
    writeServerToMcpJson(workspaceDir, key, result.config, entry.version);
  } else {
    // Remote-catalog entry (not in the local registry file).
    writeServerToMcpJson(workspaceDir, key, config, entry.version);
    result = { server: entry, config, nextSteps: buildNextSteps(entry, config) };
  }
  if (opts.baseDir !== undefined) {
    recordInstalledVersion(opts.baseDir, id, entry.version, entry.source ?? 'local');
  }
  return { ...result, version: entry.version };
}

/**
 * Which installed servers have a newer catalogued version.
 * Servers that left the catalogue get `latestVersion: null` and
 * `updateAvailable: false`; servers with no recorded installed
 * version get `installedVersion: "unknown"` and no proven update.
 */
export function checkForUpdates(
  workspaceDir: string,
  opts: { baseDir?: string; catalog?: VersionedMarketplaceServer[]; appVersion?: string } = {},
): McpUpdateInfo[] {
  assertNonEmptyString(workspaceDir, 'workspaceDir');
  const installed = listInstalled(workspaceDir);
  const catalogued: VersionedMarketplaceServer[] =
    opts.catalog ??
    (opts.baseDir !== undefined
      ? loadVersionedRegistry(opts.baseDir)
      : listAvailable().map((s): VersionedMarketplaceServer => ({ ...s, version: '0.0.0', source: 'local' })));
  return installed.map((config) => {
    const id = config.name;
    const entry = catalogued.find((s) => s.id === id);
    const installedVersion = getInstalledVersion(id, workspaceDir, opts.baseDir) ?? 'unknown';
    if (!entry) {
      return {
        id,
        name: id,
        installedVersion,
        latestVersion: null,
        updateAvailable: false,
        compatible: true,
      };
    }
    let updateAvailable = false;
    if (installedVersion !== 'unknown') {
      try {
        updateAvailable = isNewerVersion(entry.version, installedVersion);
      } catch {
        updateAvailable = false;
      }
    }
    return {
      id,
      name: entry.name,
      installedVersion,
      latestVersion: entry.version,
      ...(entry.changelog ? { changelog: entry.changelog } : {}),
      ...(entry.minAppVersion ? { minAppVersion: entry.minAppVersion } : {}),
      updateAvailable,
      compatible: satisfiesMinAppVersion(entry.minAppVersion, opts.appVersion),
    };
  });
}

export interface UpdateInstalledResult extends InstallResult {
  fromVersion: string | null;
  toVersion: string;
}

/**
 * Update one installed server to the latest catalogued version.
 * Throws when no newer version exists, or when the latest version
 * needs a newer app than the running one. The entry's command/args/
 * url are replaced in place; env/headers the user filled in are
 * preserved. The caller (main IPC) must have called
 * `requireMarketplaceApproval` with kind 'mcp-update' first.
 */
export function updateInstalled(
  id: string,
  workspaceDir: string,
  opts: { baseDir?: string; catalog?: VersionedMarketplaceServer[]; appVersion?: string } = {},
): UpdateInstalledResult {
  assertId(id);
  assertNonEmptyString(workspaceDir, 'workspaceDir');
  const entry = getVersionedAvailable(id, opts.baseDir, opts.catalog);
  if (!entry) {
    throw new Error(
      `Unknown MCP marketplace server "${id}": no such entry in the catalogue (see listAvailable())`,
    );
  }
  const installed = loadMcpConfig(workspaceDir).servers[id];
  if (!installed) {
    throw new Error(`MCP server "${id}" is not installed in this workspace`);
  }
  const fromVersion = getInstalledVersion(id, workspaceDir, opts.baseDir);
  if (fromVersion !== null) {
    try {
      if (!isNewerVersion(entry.version, fromVersion)) {
        throw new Error(
          `MCP server "${id}" is already up to date (installed ${fromVersion}, latest ${entry.version}).`,
        );
      }
    } catch (err) {
      if ((err as Error).message.includes('already up to date')) throw err;
      // Unparsable installed version: proceed — the update replaces it.
    }
  }
  if (!satisfiesMinAppVersion(entry.minAppVersion, opts.appVersion)) {
    throw new Error(
      `MCP server "${id}" version ${entry.version} needs app version ${entry.minAppVersion} or newer (running ${opts.appVersion ?? 'unknown'}).`,
    );
  }
  // Preserve the user's own env/headers; replace command/args/url.
  const next: McpServerConfig = { name: id };
  if (entry.command) next.command = entry.command;
  if (entry.args) next.args = [...entry.args];
  if (entry.url) next.url = entry.url;
  if (installed.env) next.env = { ...installed.env };
  if (installed.headers) next.headers = { ...installed.headers };
  writeServerToMcpJson(workspaceDir, id, next, entry.version);
  if (opts.baseDir !== undefined) {
    recordInstalledVersion(opts.baseDir, id, entry.version, entry.source ?? 'local');
  }
  return {
    server: entry,
    config: next,
    nextSteps: buildNextSteps(entry, next),
    fromVersion,
    toVersion: entry.version,
  };
}

// ---------------------------------------------------------------------------
// Search (main-process side; mirrors the renderer's filterMarketplaceServers)
// ---------------------------------------------------------------------------

function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'd');
}

/**
 * Servers matching a search query AND a tag filter. Every whitespace
 * token of the query must appear in the normalized id/name/description/
 * tags. Empty query matches everything; tag 'all' (or empty) disables
 * the tag filter.
 */
export function searchMarketplaceServers(
  servers: MarketplaceServer[],
  query = '',
  tag = 'all',
): MarketplaceServer[] {
  const tokens = normalizeSearchText(query ?? '')
    .split(/\s+/)
    .filter((token) => token.length > 0);
  return servers.filter((server) => {
    if (tag && tag !== 'all' && !(server.tags ?? []).includes(tag)) return false;
    if (tokens.length === 0) return true;
    const haystack = normalizeSearchText(
      `${server.id} ${server.name} ${server.description} ${(server.tags ?? []).join(' ')}`,
    );
    return tokens.every((token) => haystack.includes(token));
  });
}
