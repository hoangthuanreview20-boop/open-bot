/**
 * Plugin marketplace v2 (worker F1, v0.89a).
 *
 * Installs plugins from a marketplace source — a local folder, an
 * https URL to a .zip bundle, or a git repo — with the same safety
 * shape as the MCP marketplace v2:
 *
 * - APPROVAL FIRST: every install/update calls
 *   `requireMarketplaceApproval()` (core) before anything is copied
 *   into the plugins directory. The caller (desktop main) records the
 *   decision after the user confirms in the UI. A download to a temp
 *   staging dir happens BEFORE the approval check (the id/version are
 *   only known after reading the manifest), but nothing is installed
 *   from staging until approval is verified, and staging is deleted
 *   on any failure.
 * - SECRET SCAN: before install, every source file is scanned for
 *   embedded secrets (api keys, tokens, private keys, AWS keys…).
 *   A hit blocks the install with the FILE + PATTERN NAME only — the
 *   matched value is never returned, logged, or written anywhere.
 * - MANIFEST FIRST: the plugin is fully validated by the existing
 *   loader (`loadPlugin` — manifest, require allowlist, permission
 *   signals) before it is copied in.
 * - SANDBOXED BY DEFAULT: a marketplace-installed plugin is recorded
 *   with `sandboxed: true`; the runtime is expected to load it via
 *   `PluginManager.loadSandboxed()` (out-of-process, see
 *   `loadMarketplacePluginSandboxed()`), never in-process. The record
 *   lives in `<pluginsDir>/marketplace-installed.json` next to the
 *   version + source, so the UI can show it.
 * - VERSIONS: installed versions are recorded; `checkPluginUpdates()`
 *   compares them against marketplace entries; `updatePlugin*`
 *   reinstalls with overwrite after a 'plugin-update' approval.
 *
 * LIMITS (honest): .zip extraction needs the `unzip` CLI on the machine
 * and git installs need the `git` CLI; a downloaded bundle is trusted
 * only as far as the static loader checks + secret scan go — the real
 * isolation is the out-of-process sandbox at run time, not this
 * installer.
 *
 * v0.93a (bundle signing + downgrade): every marketplace plugin is
 * signature-checked before it runs (see `./signing.ts` — Ed25519
 * `signature.json` over the sha256 of every file, trust store
 * `<userDataDir>/marketplace/trusted-keys.json`). A present-but-bad
 * signature is refused everywhere (install + bot start), fail-closed;
 * an unsigned bundle from a `url`/`git` source is refused unless the
 * user explicitly allows that unsigned install (`allowUnsigned`, never
 * default); an unsigned `local` source stays allowed (user's own disk).
 * Upgrades snapshot the previous version under
 * `<userDataDir>/plugin-previous-versions/<id>/<version>/`, so a bad
 * new version can be downgraded (`downgradePlugin`) and bot start
 * auto-rolls back to it when the new version fails verification or
 * fails to load (see coordinator `loadMarketplacePluginsAtStartup`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { compareVersions, requireMarketplaceApproval } from '@open-bot/core';
import { PluginManager } from './manager';
import { loadPlugin, readManifest } from './loader';
import {
  enforcePluginSignature,
  loadTrustedMarketplaceKeys,
  verifyPluginBundleSignature,
  PLUGIN_SIGNATURE_FILE,
  type PluginSignatureStatus,
  type PluginSignatureVerification,
  type TrustedMarketplaceKeys,
} from './signing';
import type { PluginInfo, PluginManifest } from './types';

export type PluginMarketplaceSourceKind = 'local' | 'url' | 'git';

export interface PluginMarketplaceSource {
  kind: PluginMarketplaceSourceKind;
  /** https URL for 'url' / 'git' sources. */
  url?: string;
  /** Local folder for 'local' sources. */
  path?: string;
}

/** One plugin as listed by a (local or remote) plugin catalog. */
export interface PluginMarketplaceEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  source: PluginMarketplaceSource;
  minAppVersion?: string;
  changelog?: string;
  /** Expected SHA-256 of the downloaded .zip (verified when present). */
  sha256?: string;
}

export interface PluginMarketplaceInfo extends PluginInfo {
  /** Version recorded at install time (manifest version when unknown). */
  version: string;
  /** Where this plugin came from (when installed via the marketplace). */
  source?: PluginMarketplaceSource;
  /** Marketplace plugins always run sandboxed (see header). */
  sandboxed: boolean;
  installedAt?: string;
  /**
   * v0.93a — signature status from the install RECORD (not a fresh
   * re-verification; bot start re-verifies for real): 'signed' when a
   * key id was recorded, 'unsigned-allowed' when the user explicitly
   * allowed this unsigned install, 'unsigned-local' for an unsigned
   * local-source install.
   */
  signatureStatus?: 'signed' | 'unsigned-allowed' | 'unsigned-local';
  /** Key id that signed the installed bundle (when signed). */
  signatureKeyId?: string;
  /** Version kept as the downgrade snapshot (when one exists). */
  previousVersion?: string;
}

export interface PluginUpdateInfo {
  id: string;
  name: string;
  installedVersion: string;
  latestVersion: string | null;
  changelog?: string;
  minAppVersion?: string;
  updateAvailable: boolean;
  compatible: boolean;
}

export interface SecretFinding {
  /** Path relative to the scanned directory. */
  file: string;
  /** Name of the pattern that matched — never the matched value. */
  pattern: string;
}

const ID_RE = /^[A-Za-z0-9_-]+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** Download budget for a plugin bundle. */
export const PLUGIN_DOWNLOAD_TIMEOUT_MS = 60_000;
/** Hard cap on a downloaded bundle (50 MiB). */
export const PLUGIN_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const PLUGIN_MARKETPLACE_INSTALLED_FILE = 'marketplace-installed.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid plugin marketplace: "${what}" must be a non-empty string`);
  }
}

/**
 * Validate one marketplace entry (same strictness as the MCP remote
 * catalog: id, name, description, semver version, and a well-formed
 * source — https URL for 'url'/'git', existing-looking path for
 * 'local'). Throws a clear Error on a bad shape.
 */
export function validatePluginMarketplaceEntry(raw: unknown, index = 0): PluginMarketplaceEntry {
  const where = `Plugin marketplace entry #${index}`;
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
  if (typeof raw['version'] !== 'string' || !SEMVER_RE.test(raw['version'])) {
    throw new Error(`${where} ("${id}") must have a "version" that is a semver string`);
  }
  if (!isRecord(raw['source'])) {
    throw new Error(`${where} ("${id}") must have a "source" object`);
  }
  const sourceRaw = raw['source'] as Record<string, unknown>;
  const kind = sourceRaw['kind'];
  if (kind !== 'local' && kind !== 'url' && kind !== 'git') {
    throw new Error(`${where} ("${id}"): "source.kind" must be "local", "url" or "git"`);
  }
  const source: PluginMarketplaceSource = { kind };
  if (kind === 'local') {
    if (typeof sourceRaw['path'] !== 'string' || !sourceRaw['path'].trim()) {
      throw new Error(`${where} ("${id}"): local sources need a non-empty "source.path"`);
    }
    source.path = sourceRaw['path'];
  } else {
    if (typeof sourceRaw['url'] !== 'string' || !sourceRaw['url'].trim()) {
      throw new Error(`${where} ("${id}"): "${kind}" sources need a non-empty "source.url"`);
    }
    let parsed: URL;
    try {
      parsed = new URL((sourceRaw['url'] as string).replace(/^git\+/, ''));
    } catch {
      throw new Error(`${where} ("${id}"): "source.url" is not a valid URL`);
    }
    if (parsed.protocol !== 'https:') {
      throw new Error(`${where} ("${id}"): "source.url" must use https://`);
    }
    if (parsed.username || parsed.password) {
      throw new Error(`${where} ("${id}"): "source.url" must not embed credentials`);
    }
    source.url = sourceRaw['url'] as string;
  }
  const entry: PluginMarketplaceEntry = {
    id,
    name: raw['name'],
    description: raw['description'],
    version: raw['version'],
    source,
  };
  if (typeof raw['author'] === 'string') entry.author = raw['author'];
  if (typeof raw['minAppVersion'] === 'string') {
    if (!SEMVER_RE.test(raw['minAppVersion'])) {
      throw new Error(`${where} ("${id}"): "minAppVersion" must be a semver string`);
    }
    entry.minAppVersion = raw['minAppVersion'];
  }
  if (typeof raw['changelog'] === 'string') entry.changelog = raw['changelog'];
  if (typeof raw['sha256'] === 'string') {
    if (!/^[0-9a-f]{64}$/i.test(raw['sha256'])) {
      throw new Error(`${where} ("${id}"): "sha256" must be a 64-char hex digest`);
    }
    entry.sha256 = raw['sha256'].toLowerCase();
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Secret scan
// ---------------------------------------------------------------------------

/** Pattern name + regex. The FINDING only ever carries the name. */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'api-key-assignment', re: /(api[_-]?key|apikey)\s*[:=]\s*['"][^'"]{8,}['"]/i },
  { name: 'password-assignment', re: /(password|passwd|pwd)\s*[:=]\s*['"][^'"]{6,}['"]/i },
  { name: 'secret-assignment', re: /(secret|client[_-]?secret)\s*[:=]\s*['"][^'"]{8,}['"]/i },
  { name: 'token-assignment', re: /(access[_-]?token|auth[_-]?token|bearer)\s*[:=]\s*['"][^'"]{8,}['"]/i },
  { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'openai-key', re: /sk-[A-Za-z0-9]{16,}/ },
  { name: 'slack-token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
];

const SCANNABLE_EXTS = new Set(['.js', '.cjs', '.mjs', '.json', '.ts', '.pem', '.key']);
const SECRET_SCAN_MAX_FILES = 200;
const SECRET_SCAN_MAX_FILE_BYTES = 1_048_576;

/**
 * Scan a plugin directory for embedded secrets. Returns one finding
 * per (file, pattern) — file paths are relative, and the matched
 * VALUE is never included. An empty array means "no secret found"
 * (static scan only: obfuscated values can evade it — the sandbox
 * at run time is the real isolation, not this scan).
 */
export function scanDirForSecrets(dir: string): SecretFinding[] {
  const absDir = path.resolve(dir);
  const findings: SecretFinding[] = [];
  let scanned = 0;
  const walk = (current: string): void => {
    if (scanned >= SECRET_SCAN_MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (findings.length >= 100) return;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && SCANNABLE_EXTS.has(path.extname(entry.name))) {
        if (scanned >= SECRET_SCAN_MAX_FILES) return;
        scanned += 1;
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.size > SECRET_SCAN_MAX_FILE_BYTES) continue;
        let text: string;
        try {
          text = fs.readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        for (const { name, re } of SECRET_PATTERNS) {
          if (re.test(text)) {
            findings.push({ file: path.relative(absDir, full), pattern: name });
          }
        }
      }
    }
  };
  walk(absDir);
  return findings;
}

// ---------------------------------------------------------------------------
// Installed-version records
// ---------------------------------------------------------------------------

interface InstalledPluginRecord {
  version: string;
  installedAt: string;
  source: PluginMarketplaceSource;
  sandboxed: boolean;
  /** Key id that signed the installed bundle (v0.93a, when signed). */
  signatureKeyId?: string;
  /**
   * True when this plugin was installed unsigned from a remote source
   * by an explicit user decision (v0.93a) — the load-time check
   * honours the recorded decision instead of re-refusing it.
   */
  allowUnsigned?: boolean;
  /** Version kept as the downgrade snapshot (v0.93a, when one exists). */
  previousVersion?: string;
}

function installedRecordsPath(pluginsDir: string): string {
  return path.join(pluginsDir, PLUGIN_MARKETPLACE_INSTALLED_FILE);
}

function readInstalledRecords(pluginsDir: string): Record<string, InstalledPluginRecord> {
  const filePath = installedRecordsPath(pluginsDir);
  if (!fs.existsSync(filePath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(
      `Invalid plugin marketplace records file: not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!isRecord(parsed)) return {};
  const out: Record<string, InstalledPluginRecord> = {};
  for (const [id, raw] of Object.entries(parsed)) {
    if (!ID_RE.test(id) || !isRecord(raw) || typeof raw['version'] !== 'string') continue;
    if (!isRecord(raw['source'])) continue;
    out[id] = {
      version: raw['version'],
      installedAt: typeof raw['installedAt'] === 'string' ? raw['installedAt'] : '',
      source: raw['source'] as unknown as PluginMarketplaceSource,
      sandboxed: raw['sandboxed'] === true,
      ...(typeof raw['signatureKeyId'] === 'string'
        ? { signatureKeyId: raw['signatureKeyId'] }
        : {}),
      ...(raw['allowUnsigned'] === true ? { allowUnsigned: true } : {}),
      ...(typeof raw['previousVersion'] === 'string'
        ? { previousVersion: raw['previousVersion'] }
        : {}),
    };
  }
  return out;
}

function writeInstalledRecords(
  pluginsDir: string,
  records: Record<string, InstalledPluginRecord>,
): void {
  fs.mkdirSync(pluginsDir, { recursive: true });
  const filePath = installedRecordsPath(pluginsDir);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * One installed marketplace record — the raw row of
 * `marketplace-installed.json` (see `readInstalledRecords`).
 */
export interface MarketplaceInstalledRecord {
  version: string;
  installedAt: string;
  source: PluginMarketplaceSource;
  sandboxed: boolean;
  /** Key id that signed the installed bundle (v0.93a, when signed). */
  signatureKeyId?: string;
  /** Explicit user decision to run this plugin unsigned (v0.93a). */
  allowUnsigned?: boolean;
  /** Version kept as the downgrade snapshot (v0.93a, when one exists). */
  previousVersion?: string;
}

/**
 * v0.92a: read the marketplace installed records WITHOUT scanning
 * plugin folders. Unlike `listMarketplacePlugins` (which re-scans the
 * directory in-process via the PluginManager), this only reads
 * `marketplace-installed.json`, so the coordinator can enforce the
 * marketplace sandbox policy at bot start without disturbing an
 * already-sandboxed scan. Throws on a corrupt records file — the
 * caller (bot start) must catch it and skip the marketplace step so
 * bot creation never fails because of the marketplace.
 */
export function listMarketplaceInstalledRecords(
  pluginsDir: string,
): Record<string, MarketplaceInstalledRecord> {
  return readInstalledRecords(pluginsDir);
}

function recordInstalledPlugin(
  pluginsDir: string,
  id: string,
  version: string,
  source: PluginMarketplaceSource,
  extras: {
    signatureKeyId?: string;
    allowUnsigned?: boolean;
    previousVersion?: string;
  } = {},
): void {
  const records = readInstalledRecords(pluginsDir);
  records[id] = {
    version,
    installedAt: new Date().toISOString(),
    source,
    sandboxed: true,
    ...(extras.signatureKeyId !== undefined
      ? { signatureKeyId: extras.signatureKeyId }
      : {}),
    ...(extras.allowUnsigned === true ? { allowUnsigned: true } : {}),
    ...(extras.previousVersion !== undefined
      ? { previousVersion: extras.previousVersion }
      : {}),
  };
  writeInstalledRecords(pluginsDir, records);
}

function removeInstalledRecord(pluginsDir: string, id: string): void {
  const records = readInstalledRecords(pluginsDir);
  if (!Object.prototype.hasOwnProperty.call(records, id)) return;
  delete records[id];
  writeInstalledRecords(pluginsDir, records);
}

// ---------------------------------------------------------------------------
// Prepare (download / stage) — no install happens here
// ---------------------------------------------------------------------------

export interface PreparedPlugin {
  /** Staging dir (temp copy for url/git; the source dir for local). */
  stagingDir: string;
  manifest: PluginManifest;
  source: PluginMarketplaceSource;
  /** True when stagingDir is a temp dir the caller must clean up. */
  tempDir: boolean;
  /**
   * v0.93a — signature verification of the staged bundle (enforced in
   * `preparePluginFromSource`, before any approval or install).
   */
  signature: PluginSignatureVerification;
}

export interface PreparePluginOptions {
  /** Injectable fetch (tests pass a mock; defaults to global fetch). */
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Root under which temp staging dirs are created (default os.tmpdir()). */
  stagingRoot?: string;
  /** Expected SHA-256 of a downloaded .zip (verified when present). */
  sha256?: string;
  /**
   * v0.93a — user-data dir holding the trusted-keys store
   * (`marketplace/trusted-keys.json`). When given, keys are loaded
   * from it; `trustedKeys` (below) wins when both are given. When
   * neither is given, no key is trusted.
   */
  userDataDir?: string;
  /** v0.93a — trusted publisher keys, as loaded by `loadTrustedMarketplaceKeys`. */
  trustedKeys?: TrustedMarketplaceKeys;
  /**
   * v0.93a — explicit user opt-in to prepare/install an UNSIGNED
   * bundle from a `url`/`git` source. Default false (fail-closed).
   * The UI/CLI must only set this after the user confirms it.
   */
  allowUnsigned?: boolean;
}

/** Resolve the trusted keys for a prepare/install call (explicit map wins). */
function trustedKeysFor(opts: PreparePluginOptions | InstallPluginOptions): TrustedMarketplaceKeys {
  if (opts.trustedKeys !== undefined) return opts.trustedKeys;
  const userDataDir = opts.userDataDir;
  if (userDataDir !== undefined) {
    try {
      return loadTrustedMarketplaceKeys(userDataDir);
    } catch (err) {
      // A corrupt trust store must not silently become "no keys" —
      // surface it: every signed plugin would fail anyway, and an
      // unsigned remote plugin must not slip through as "unsigned".
      throw new Error(
        `Cannot verify plugin signature: ${(err as Error).message}`,
      );
    }
  }
  return {};
}

function assertHttpsUrl(rawUrl: string, what: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.replace(/^git\+/, ''));
  } catch {
    throw new Error(`Invalid plugin marketplace ${what} "${rawUrl}": not a valid URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `Invalid plugin marketplace ${what}: URL must use https:// (got "${parsed.protocol}")`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Invalid plugin marketplace ${what}: URL must not embed credentials`);
  }
  return parsed;
}

async function downloadToFile(
  url: string,
  destFile: string,
  fetchFn: NonNullable<PreparePluginOptions['fetchFn']>,
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLUGIN_DOWNLOAD_TIMEOUT_MS);
  timer.unref?.();
  let res: Response;
  try {
    res = await fetchFn(url, { method: 'GET', signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Could not download plugin from ${url}: timed out after ${PLUGIN_DOWNLOAD_TIMEOUT_MS}ms.`);
    }
    throw new Error(`Could not download plugin from ${url}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`Could not download plugin from ${url}: HTTP ${res.status}.`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > PLUGIN_DOWNLOAD_MAX_BYTES) {
    throw new Error(
      `Plugin download from ${url} is too large (${buf.length} bytes > ${PLUGIN_DOWNLOAD_MAX_BYTES} cap) — refused.`,
    );
  }
  fs.writeFileSync(destFile, buf);
  return buf;
}

/**
 * Stage a plugin source for install: local folders are used as-is;
 * `url` downloads a .zip (sha256 verified when given) and extracts it
 * with the `unzip` CLI; `git` clones with the `git` CLI
 * (`--depth 1`, no terminal prompt). Returns the staging dir + the
 * validated manifest. NOTHING is installed by this function — the
 * caller must still pass approval + secret scan in
 * `installPreparedPlugin()`. On failure, temp staging is removed.
 *
 * v0.93a: the staged bundle's signature is enforced HERE, before any
 * approval or install (see `./signing.ts`): a present-but-bad
 * signature is refused for every source kind; an unsigned bundle
 * from `url`/`git` is refused unless `allowUnsigned` is explicitly
 * set; an unsigned `local` source is allowed (user's own disk).
 */
export async function preparePluginFromSource(
  source: PluginMarketplaceSource,
  opts: PreparePluginOptions = {},
): Promise<PreparedPlugin> {
  if (!isRecord(source)) throw new Error('Invalid plugin marketplace source: must be an object');
  const fetchFn = opts.fetchFn ?? fetch;
  const stagingRoot = opts.stagingRoot ?? os.tmpdir();
  const trustedKeys = trustedKeysFor(opts);
  const allowUnsigned = opts.allowUnsigned ?? false;
  if (source.kind === 'local') {
    assertNonEmptyString(source.path, 'source.path');
    const dir = path.resolve(source.path as string);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
      throw new Error(
        `Plugin source "${dir}" has no manifest.json — not a plugin folder`,
      );
    }
    const manifest = readManifest(dir);
    const signature = enforcePluginSignature(dir, 'local', { trustedKeys, allowUnsigned });
    return { stagingDir: dir, manifest, source, tempDir: false, signature };
  }
  if (source.kind === 'git') {
    assertNonEmptyString(source.url, 'source.url');
    const cleanUrl = (source.url as string).replace(/^git\+/, '');
    assertHttpsUrl(cleanUrl, 'git URL');
    const stagingDir = fs.mkdtempSync(path.join(stagingRoot, 'open-bot-plugin-git-'));
    try {
      execFileSync('git', ['clone', '--depth', '1', cleanUrl, stagingDir], {
        timeout: 120_000,
        stdio: 'pipe',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch (err) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw new Error(`Could not clone plugin git repo ${cleanUrl}: ${(err as Error).message}`);
    }
    if (!fs.existsSync(path.join(stagingDir, 'manifest.json'))) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw new Error(`Plugin git repo ${cleanUrl} has no manifest.json at its root`);
    }
    const manifest = readManifest(stagingDir);
    try {
      const signature = enforcePluginSignature(stagingDir, 'git', { trustedKeys, allowUnsigned });
      return { stagingDir, manifest, source, tempDir: true, signature };
    } catch (err) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw err;
    }
  }
  if (source.kind === 'url') {
    assertNonEmptyString(source.url, 'source.url');
    assertHttpsUrl(source.url as string, 'URL');
    const url = source.url as string;
    if (!url.split('?')[0]?.toLowerCase().endsWith('.zip')) {
      throw new Error(
        `Plugin URL "${url}" must point to a .zip bundle (or use a git source for repos)`,
      );
    }
    const stagingDir = fs.mkdtempSync(path.join(stagingRoot, 'open-bot-plugin-zip-'));
    try {
      const zipFile = path.join(stagingDir, 'bundle.zip');
      const buf = await downloadToFile(url, zipFile, fetchFn);
      if (opts.sha256) {
        const actual = createHash('sha256').update(buf).digest('hex');
        if (actual !== opts.sha256.toLowerCase()) {
          throw new Error('Plugin bundle failed SHA-256 verification — refused (may have been tampered with).');
        }
      }
      const extractDir = path.join(stagingDir, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });
      try {
        execFileSync('unzip', ['-q', zipFile, '-d', extractDir], { timeout: 60_000, stdio: 'pipe' });
      } catch {
        throw new Error(
          'Could not extract the plugin .zip bundle — the `unzip` command is missing or the file is not a valid zip.',
        );
      }
      // A bundle may contain a single top-level folder: use it.
      let root = extractDir;
      const entries = fs.readdirSync(extractDir, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory());
      if (dirs.length === 1 && entries.length === 1) root = path.join(extractDir, dirs[0]?.name as string);
      if (!fs.existsSync(path.join(root, 'manifest.json'))) {
        throw new Error(`Plugin bundle from ${url} has no manifest.json at its root`);
      }
      const manifest = readManifest(root);
      const signature = enforcePluginSignature(root, 'url', { trustedKeys, allowUnsigned });
      return { stagingDir: root, manifest, source, tempDir: true, signature };
    } catch (err) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw err;
    }
  }
  throw new Error(
    `Invalid plugin marketplace source kind "${String((source as Record<string, unknown>)['kind'])}": must be "local", "url" or "git"`,
  );
}

/** Remove a temp staging dir created by preparePluginFromSource(). */
export function discardPreparedPlugin(prepared: PreparedPlugin): void {
  if (!prepared.tempDir) return;
  // stagingDir may be a subdir of the mkdtemp dir (zip extraction);
  // remove the temp root (its parent) when it looks like ours.
  const dir = prepared.stagingDir;
  const parent = path.dirname(dir);
  const root = path.basename(parent).startsWith('open-bot-plugin-') ? parent : dir;
  fs.rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Install / update / uninstall / list
// ---------------------------------------------------------------------------

export interface InstallPluginOptions {
  /** Overwrite an already-installed plugin of the same id. */
  overwrite?: boolean;
  /** User-data dir holding marketplace/approvals.json (default: parent of pluginsDir). */
  userDataDir?: string;
  /** 'plugin-install' (default) or 'plugin-update'. */
  approvalKind?: 'plugin-install' | 'plugin-update';
  /** v0.93a — trusted publisher keys (explicit map wins over userDataDir). */
  trustedKeys?: TrustedMarketplaceKeys;
  /**
   * v0.93a — explicit user opt-in to install an UNSIGNED bundle from
   * a `url`/`git` source. Default false (fail-closed).
   */
  allowUnsigned?: boolean;
}

export interface InstallPluginResult {
  info: PluginInfo;
  version: string;
  /** Marketplace plugins always run sandboxed (see header). */
  sandboxed: true;
  source: PluginMarketplaceSource;
  /** v0.93a — signature verification of the installed bundle. */
  signature: PluginSignatureVerification;
  /**
   * v0.93a — version snapshotted as the downgrade backup by this
   * install (when an older version was overwritten), else undefined.
   */
  previousVersion?: string;
}

/** v0.93a: dir holding one downgrade snapshot per plugin id + version. */
export const PLUGIN_PREVIOUS_VERSIONS_DIR = 'plugin-previous-versions';

function previousVersionsRoot(userDataDir: string): string {
  return path.join(path.resolve(userDataDir), PLUGIN_PREVIOUS_VERSIONS_DIR);
}

function previousVersionDir(userDataDir: string, id: string, version: string): string {
  return path.join(previousVersionsRoot(userDataDir), id, version);
}

/**
 * v0.93a: snapshot the CURRENTLY installed version of a plugin before
 * it is overwritten, so it can be downgraded back to. Keeps exactly
 * ONE previous version per plugin (an older snapshot is replaced).
 * Returns the snapshotted version. Throws when the snapshot cannot be
 * made — the caller must not overwrite then, or the old version would
 * be lost. The snapshot is a plain copy (including its signature.json,
 * so a downgrade re-verifies it before restoring).
 */
function snapshotPreviousVersion(
  pluginsDir: string,
  id: string,
  userDataDir: string,
): string {
  const records = readInstalledRecords(pluginsDir);
  const installedDir = path.join(path.resolve(pluginsDir), id);
  let version = records[id]?.version;
  if (version === undefined) {
    try {
      version = readManifest(installedDir).version;
    } catch {
      throw new Error(
        `Cannot snapshot plugin "${id}" before update: no installed version is recorded and its manifest cannot be read.`,
      );
    }
  }
  const idRoot = path.join(previousVersionsRoot(userDataDir), id);
  try {
    fs.rmSync(idRoot, { recursive: true, force: true });
    const dest = path.join(idRoot, version);
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(installedDir, dest, { recursive: true });
  } catch (err) {
    throw new Error(
      `Cannot snapshot plugin "${id}" version ${version} before update: ${(err as Error).message} — refusing to overwrite the installed version.`,
    );
  }
  return version;
}

function userDataDirFor(pluginsDir: string, opts?: InstallPluginOptions): string {
  return opts?.userDataDir ?? path.dirname(path.resolve(pluginsDir));
}

/**
 * Install a PREPARED plugin (see preparePluginFromSource): requires a
 * recorded approval, runs the secret scan, validates the plugin with
 * the real loader, then copies it in via PluginManager. Returns the
 * installed info with `sandboxed: true` — the runtime must load it
 * with `loadSandboxed()` (see loadMarketplacePluginSandboxed).
 *
 * v0.93a: the staged bundle's signature is re-enforced here (defense
 * in depth — staging may be old, or come from another prepare path),
 * and when `overwrite` replaces an installed version, the old version
 * is snapshotted first (see `snapshotPreviousVersion`) so it can be
 * downgraded back to. The install is refused when the signature is
 * invalid, or when the snapshot cannot be made.
 */
export function installPreparedPlugin(
  prepared: PreparedPlugin,
  pluginsDir: string,
  opts: InstallPluginOptions = {},
): InstallPluginResult {
  const { manifest } = prepared;
  const kind = opts.approvalKind ?? 'plugin-install';
  requireMarketplaceApproval(
    userDataDirFor(pluginsDir, opts),
    kind,
    manifest.id,
    manifest.version,
  );
  // v0.93a: re-enforce the signature on the staged copy (the prepare
  // step already enforced it, but staging may be stale or hand-made).
  const trustedKeys = trustedKeysFor(opts);
  const signature = enforcePluginSignature(prepared.stagingDir, prepared.source.kind, {
    trustedKeys,
    allowUnsigned: opts.allowUnsigned ?? false,
  });
  const findings = scanDirForSecrets(prepared.stagingDir);
  if (findings.length > 0) {
    const summary = findings
      .slice(0, 5)
      .map((f) => `${f.file} (${f.pattern})`)
      .join(', ');
    throw new Error(
      `Plugin "${manifest.id}" was blocked: the secret scan found embedded secret(s) — ${summary}. Remove the secret from the plugin source and try again.`,
    );
  }
  // Full loader validation on the staged copy BEFORE anything is
  // copied into the plugins directory.
  loadPlugin(prepared.stagingDir);
  const userDataDir = userDataDirFor(pluginsDir, opts);
  const destDir = path.join(path.resolve(pluginsDir), manifest.id);
  const oldRecord = readInstalledRecords(pluginsDir)[manifest.id];
  let previousVersion: string | undefined;
  if ((opts.overwrite ?? false) && fs.existsSync(destDir)) {
    previousVersion = snapshotPreviousVersion(pluginsDir, manifest.id, userDataDir);
  }
  const manager = new PluginManager(pluginsDir);
  const info = manager.installFromDir(prepared.stagingDir, {
    overwrite: opts.overwrite ?? false,
  });
  recordInstalledPlugin(pluginsDir, manifest.id, manifest.version, prepared.source, {
    ...(signature.keyId !== undefined ? { signatureKeyId: signature.keyId } : {}),
    ...(signature.status === 'unsigned' && prepared.source.kind !== 'local'
      ? { allowUnsigned: true }
      : {}),
    ...(previousVersion !== undefined
      ? { previousVersion }
      : oldRecord?.previousVersion !== undefined
        ? { previousVersion: oldRecord.previousVersion }
        : {}),
  });
  return {
    info,
    version: manifest.version,
    sandboxed: true,
    source: prepared.source,
    signature,
    ...(previousVersion !== undefined ? { previousVersion } : {}),
  };
}

/**
 * One-step install from a source: prepare (download/clone when
 * needed) + installPreparedPlugin. The temp staging dir is removed
 * afterwards in all cases.
 */
export async function installPluginFromSource(
  source: PluginMarketplaceSource,
  pluginsDir: string,
  opts: InstallPluginOptions & PreparePluginOptions = {},
): Promise<InstallPluginResult> {
  const prepared = await preparePluginFromSource(source, opts);
  try {
    return installPreparedPlugin(prepared, pluginsDir, opts);
  } finally {
    discardPreparedPlugin(prepared);
  }
}

/**
 * Update a plugin from a source: prepares it, checks the staged
 * manifest id matches, then installs with overwrite after a
 * 'plugin-update' approval. Throws when the staged plugin is not
 * newer than the installed one (unless `allowSameVersion`).
 */
export async function updatePluginFromSource(
  id: string,
  source: PluginMarketplaceSource,
  pluginsDir: string,
  opts: (InstallPluginOptions & PreparePluginOptions) & { allowSameVersion?: boolean } = {},
): Promise<InstallPluginResult> {
  assertNonEmptyString(id, 'id');
  const prepared = await preparePluginFromSource(source, opts);
  try {
    if (prepared.manifest.id !== id) {
      throw new Error(
        `Plugin update mismatch: the source contains plugin "${prepared.manifest.id}", not "${id}".`,
      );
    }
    const records = readInstalledRecords(pluginsDir);
    const installedVersion = records[id]?.version;
    if (installedVersion && !opts.allowSameVersion) {
      if (compareVersions(prepared.manifest.version, installedVersion) <= 0) {
        throw new Error(
          `Plugin "${id}" is already up to date (installed ${installedVersion}, source ${prepared.manifest.version}).`,
        );
      }
    }
    return installPreparedPlugin(prepared, pluginsDir, {
      ...opts,
      overwrite: true,
      approvalKind: 'plugin-update',
    });
  } finally {
    discardPreparedPlugin(prepared);
  }
}

/** Uninstall a plugin: drop it from the manager + delete its folder + forget its record. */
export function uninstallMarketplacePlugin(
  id: string,
  pluginsDir: string,
  opts: { userDataDir?: string } = {},
): boolean {
  assertNonEmptyString(id, 'id');
  const manager = new PluginManager(pluginsDir);
  const removed = manager.uninstall(id);
  removeInstalledRecord(pluginsDir, id);
  // v0.93a: a downgrade snapshot of an uninstalled plugin is stale —
  // drop it too, so a later reinstall cannot resurrect an old version.
  const userDataDir = opts.userDataDir ?? path.dirname(path.resolve(pluginsDir));
  fs.rmSync(path.join(previousVersionsRoot(userDataDir), id), { recursive: true, force: true });
  return removed;
}

// ---------------------------------------------------------------------------
// v0.93a: signature check of an INSTALLED plugin + downgrade
// ---------------------------------------------------------------------------

export interface InstalledPluginSignatureCheck {
  /** True when the installed plugin may run under the v0.93a policy. */
  ok: boolean;
  status: PluginSignatureStatus | 'missing';
  keyId?: string;
  /** Clear reason when ok is false. */
  error?: string;
}

/**
 * v0.93a: policy-aware signature check of an INSTALLED marketplace
 * plugin (what bot start calls before loading it). Reads the install
 * record + the trusted-keys store (default userDataDir = parent of
 * pluginsDir) and applies the same policy as install time:
 * - signed + trusted key -> ok;
 * - signed with an unknown/untrusted key, or tampered -> not ok;
 * - unsigned -> ok only when the record says the source is `local`
 *   or the user explicitly allowed this unsigned install
 *   (`allowUnsigned` recorded at install time);
 * - no marketplace record (hand-installed) -> ok (unchanged trust
 *   model: the user placed the files on disk themselves);
 * - plugin folder missing -> not ok ('missing').
 * Never throws for a bad plugin — it returns `{ ok: false, error }`.
 */
export function verifyInstalledPluginSignature(
  pluginsDir: string,
  id: string,
  opts: { userDataDir?: string; trustedKeys?: TrustedMarketplaceKeys } = {},
): InstalledPluginSignatureCheck {
  assertNonEmptyString(id, 'id');
  const dir = path.join(path.resolve(pluginsDir), id);
  if (!fs.existsSync(dir)) {
    return { ok: false, status: 'missing', error: `Plugin "${id}" is not installed (folder "${dir}" is missing).` };
  }
  const record = readInstalledRecords(pluginsDir)[id];
  if (record === undefined) {
    // Hand-installed (no marketplace record): not subject to the
    // signature policy — same trust as before v0.93a.
    return { ok: true, status: 'unsigned' };
  }
  let trustedKeys: TrustedMarketplaceKeys;
  if (opts.trustedKeys !== undefined) {
    trustedKeys = opts.trustedKeys;
  } else {
    // Default userDataDir (parent of pluginsDir) is where the trust
    // store lives; a corrupt store fails closed here, never silently.
    const userDataDir = opts.userDataDir ?? path.dirname(path.resolve(pluginsDir));
    try {
      trustedKeys = loadTrustedMarketplaceKeys(userDataDir);
    } catch (err) {
      return { ok: false, status: 'invalid', error: (err as Error).message };
    }
  }
  const verification = verifyPluginBundleSignature(dir, trustedKeys);
  if (verification.status === 'signed') {
    return { ok: true, status: 'signed', keyId: verification.keyId };
  }
  if (verification.status === 'invalid') {
    return {
      ok: false,
      status: 'invalid',
      keyId: verification.keyId,
      error: `Plugin "${id}" was refused: bundle signature is invalid — ${verification.error ?? 'unknown reason'}`,
    };
  }
  // Unsigned: allowed only for a local source or a recorded explicit
  // unsigned decision — a remote plugin that lost its signature (or
  // was never signed and never explicitly allowed) is refused.
  if (record.source.kind === 'local' || record.allowUnsigned === true) {
    return { ok: true, status: 'unsigned' };
  }
  return {
    ok: false,
    status: 'unsigned',
    error:
      `Plugin "${id}" was refused: the installed bundle is UNSIGNED (no signature.json) and comes from a ` +
      `${record.source.kind} source — only signed plugins run from remote sources. ` +
      `Reinstall a signed version, trust the publisher's key, or explicitly allow this unsigned install.`,
  };
}

export interface PluginDowngradeInfo {
  id: string;
  currentVersion: string;
  previousVersion: string | null;
  canDowngrade: boolean;
  /** Clear reason when canDowngrade is false. */
  reason?: string;
}

/**
 * v0.93a: what version could this plugin be downgraded to? The answer
 * comes from the install record (`previousVersion`, set when an update
 * overwrote it) AND the snapshot actually being on disk — a record
 * without its snapshot cannot downgrade.
 */
export function getPluginDowngradeInfo(
  id: string,
  pluginsDir: string,
  opts: { userDataDir?: string } = {},
): PluginDowngradeInfo {
  assertNonEmptyString(id, 'id');
  const userDataDir = opts.userDataDir ?? path.dirname(path.resolve(pluginsDir));
  const record = readInstalledRecords(pluginsDir)[id];
  if (record === undefined) {
    return {
      id,
      currentVersion: '',
      previousVersion: null,
      canDowngrade: false,
      reason: `Plugin "${id}" is not installed via the marketplace — no previous version is kept.`,
    };
  }
  if (record.previousVersion === undefined) {
    return {
      id,
      currentVersion: record.version,
      previousVersion: null,
      canDowngrade: false,
      reason: `Plugin "${id}" has no previous version (it was never updated, or its snapshot was removed).`,
    };
  }
  const backupDir = previousVersionDir(userDataDir, id, record.previousVersion);
  if (!fs.existsSync(path.join(backupDir, 'manifest.json'))) {
    return {
      id,
      currentVersion: record.version,
      previousVersion: record.previousVersion,
      canDowngrade: false,
      reason: `Plugin "${id}" recorded previous version ${record.previousVersion}, but its snapshot is missing from disk.`,
    };
  }
  return {
    id,
    currentVersion: record.version,
    previousVersion: record.previousVersion,
    canDowngrade: true,
  };
}

export interface DowngradePluginResult {
  id: string;
  fromVersion: string;
  toVersion: string;
  /** Signature verification of the restored version. */
  signature: PluginSignatureVerification;
}

/**
 * v0.93a: downgrade a marketplace plugin to the snapshotted previous
 * version. Fail-closed, in order:
 * 1. the recorded previous version + its snapshot must exist;
 * 2. the snapshot is validated with the real loader (a broken backup
 *    is never installed over a working version);
 * 3. when the snapshot carries a signature, it is verified against
 *    the trusted keys — a tampered backup is refused;
 * 4. the CURRENT version is snapshotted first, so a downgrade can be
 *    undone by downgrading again (the two versions swap roles).
 * Returns `{ id, fromVersion, toVersion }`. Throws with a clear
 * message when there is nothing to downgrade to or the backup is bad.
 */
export function downgradePlugin(
  id: string,
  pluginsDir: string,
  opts: { userDataDir?: string; trustedKeys?: TrustedMarketplaceKeys } = {},
): DowngradePluginResult {
  assertNonEmptyString(id, 'id');
  const userDataDir = opts.userDataDir ?? path.dirname(path.resolve(pluginsDir));
  const info = getPluginDowngradeInfo(id, pluginsDir, { userDataDir });
  if (!info.canDowngrade || info.previousVersion === null) {
    throw new Error(
      `Cannot downgrade plugin "${id}": ${info.reason ?? 'no previous version is available.'}`,
    );
  }
  const toVersion = info.previousVersion;
  const fromVersion = info.currentVersion;
  const backupDir = previousVersionDir(userDataDir, id, toVersion);
  // Validate the backup BEFORE touching the installed version.
  const backupManifest = loadPlugin(backupDir).manifest;
  if (backupManifest.id !== id) {
    throw new Error(
      `Cannot downgrade plugin "${id}": the snapshot for version ${toVersion} contains plugin "${backupManifest.id}", not "${id}" — refusing to install it.`,
    );
  }
  if (backupManifest.version !== toVersion) {
    throw new Error(
      `Cannot downgrade plugin "${id}": the snapshot for version ${toVersion} actually contains version ${backupManifest.version} — refusing to install it.`,
    );
  }
  const trustedKeys = trustedKeysFor({
    ...(opts.trustedKeys !== undefined ? { trustedKeys: opts.trustedKeys } : {}),
    userDataDir,
  });
  const signature = fs.existsSync(path.join(backupDir, PLUGIN_SIGNATURE_FILE))
    ? verifyPluginBundleSignature(backupDir, trustedKeys)
    : { status: 'unsigned' as const };
  if (signature.status === 'invalid') {
    throw new Error(
      `Cannot downgrade plugin "${id}": the snapshot of version ${toVersion} has an invalid signature — ${signature.error ?? 'unknown reason'} — refusing to restore a tampered backup.`,
    );
  }
  // Swap: snapshot the current version first (replaces the old backup
  // only after the new one is validated above), then install the backup.
  // The backup is staged to a temp dir FIRST — snapshotting wipes the
  // whole previous-versions folder for this id, including the backup
  // being restored, so installing straight from backupDir would fail.
  const record = readInstalledRecords(pluginsDir)[id];
  if (record === undefined) {
    throw new Error(`Cannot downgrade plugin "${id}": its marketplace record is missing.`);
  }
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-plugin-downgrade-'));
  const stagedBackup = path.join(stagingRoot, id);
  try {
    fs.cpSync(backupDir, stagedBackup, { recursive: true });
    snapshotPreviousVersion(pluginsDir, id, userDataDir);
    const manager = new PluginManager(pluginsDir);
    const installed = manager.installFromDir(stagedBackup, { overwrite: true });
    if (installed.manifest.version !== toVersion) {
      throw new Error(
        `Cannot downgrade plugin "${id}": installed version ${installed.manifest.version}, expected ${toVersion}.`,
      );
    }
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
  recordInstalledPlugin(pluginsDir, id, toVersion, record.source, {
    ...(signature.keyId !== undefined ? { signatureKeyId: signature.keyId } : {}),
    ...(signature.status === 'unsigned' && record.source.kind !== 'local'
      ? { allowUnsigned: true }
      : {}),
    previousVersion: fromVersion,
  });
  return { id, fromVersion, toVersion, signature };
}

/**
 * List installed plugins, merged with their marketplace records
 * (version / source / sandboxed flag). Plugins installed by hand (no
 * record) get `sandboxed: false` and their manifest version.
 */
export function listMarketplacePlugins(pluginsDir: string): PluginMarketplaceInfo[] {
  const manager = new PluginManager(pluginsDir);
  const infos = manager.scanDir();
  const records = readInstalledRecords(pluginsDir);
  return infos.map((info) => {
    const record = records[info.manifest.id];
    const signatureStatus =
      record === undefined
        ? undefined
        : record.signatureKeyId !== undefined
          ? 'signed'
          : record.allowUnsigned === true
            ? 'unsigned-allowed'
            : 'unsigned-local';
    return {
      ...info,
      version: record?.version ?? info.manifest.version,
      ...(record ? { source: record.source, installedAt: record.installedAt } : {}),
      sandboxed: record?.sandboxed ?? false,
      ...(signatureStatus !== undefined ? { signatureStatus } : {}),
      ...(record?.signatureKeyId !== undefined
        ? { signatureKeyId: record.signatureKeyId }
        : {}),
      ...(record?.previousVersion !== undefined
        ? { previousVersion: record.previousVersion }
        : {}),
    };
  });
}

/** Load one marketplace-installed plugin sandboxed (out-of-process). */
export async function loadMarketplacePluginSandboxed(
  manager: PluginManager,
  id: string,
): Promise<PluginInfo> {
  return manager.loadSandboxed(id);
}

/**
 * Which installed plugins have a newer version in the given catalog
 * entries. Entries whose minAppVersion exceeds `appVersion` are
 * reported with `compatible: false`.
 */
export function checkPluginUpdates(
  entries: PluginMarketplaceEntry[],
  pluginsDir: string,
  appVersion?: string,
): PluginUpdateInfo[] {
  const installed = listMarketplacePlugins(pluginsDir);
  const byId = new Map(entries.map((e) => [e.id, e]));
  return installed.map((plugin) => {
    const entry = byId.get(plugin.manifest.id);
    if (!entry) {
      return {
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        installedVersion: plugin.version,
        latestVersion: null,
        updateAvailable: false,
        compatible: true,
      };
    }
    let updateAvailable = false;
    try {
      updateAvailable = compareVersions(entry.version, plugin.version) > 0;
    } catch {
      updateAvailable = false;
    }
    let compatible = true;
    if (entry.minAppVersion && appVersion) {
      try {
        compatible = compareVersions(appVersion, entry.minAppVersion) >= 0;
      } catch {
        compatible = true;
      }
    }
    return {
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      installedVersion: plugin.version,
      latestVersion: entry.version,
      ...(entry.changelog ? { changelog: entry.changelog } : {}),
      ...(entry.minAppVersion ? { minAppVersion: entry.minAppVersion } : {}),
      updateAvailable,
      compatible,
    };
  });
}

/** Case/diacritic-insensitive search over installed plugins (name/description/id). */
export function searchMarketplacePlugins(
  plugins: PluginMarketplaceInfo[],
  query = '',
): PluginMarketplaceInfo[] {
  const normalize = (text: string): string =>
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\u0111/g, 'd')
      .replace(/\u0110/g, 'd');
  const tokens = normalize(query ?? '')
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return [...plugins];
  return plugins.filter((plugin) => {
    const haystack = normalize(
      `${plugin.manifest.id} ${plugin.manifest.name} ${plugin.manifest.description}`,
    );
    return tokens.every((token) => haystack.includes(token));
  });
}
