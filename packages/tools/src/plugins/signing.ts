/**
 * Plugin bundle signing — v0.93a (worker A sóng v0.93).
 *
 * Marketplace plugins come from REMOTE provenance (an https .zip or a
 * git repo) — a SHA-256 of the download (v0.89a) only proves the bytes
 * survived the transfer, not WHO published them. A signature proves
 * both: the bundle bytes are exactly what the holder of a trusted
 * private key signed, and any later change (one byte, one added file)
 * fails verification.
 *
 * Design (no new dependency — Node's built-in Ed25519):
 *
 * - Signature file: `signature.json` at the plugin root, next to
 *   `manifest.json`, copied along with the plugin on install. It
 *   carries the publisher's `keyId`, a base64 Ed25519 `signature`,
 *   and a `files` map of EVERY file in the bundle (relative POSIX
 *   path -> sha256 hex, except `signature.json` itself, `node_modules`
 *   and `.git`). The signature covers the canonical JSON of
 *   `{ algorithm, keyId, pluginId, version, files }` — so the signed
 *   payload names the plugin + version it belongs to, and a signature
 *   cannot be transplanted onto another plugin or version.
 * - Trust store: `<userDataDir>/marketplace/trusted-keys.json`
 *   (`{ "<keyId>": { publicKey: "<SPKI PEM>", label?, addedAt } }`).
 *   A keyId is the sha256 hex of the SPKI DER — derived from the key
 *   itself, never caller-supplied, so two different keys can never
 *   share an id. Adding a key is an explicit user decision (desktop
 *   IPC `plugin-marketplace:add-trusted-key`, or editing the file);
 *   removing a key makes plugins signed by it fail verification at
 *   the next load (fail-closed).
 * - What counts as tampering: a signed file that is missing or
 *   changed is always refused. A file ADDED after signing is refused
 *   only when it could be loaded as code (`.js`, `.cjs`, `.mjs`,
 *   `.node`, `.json` — the extensions Node `require()`s by default):
 *   a plugin that globs its own directory could execute an added
 *   code file. Other added files (logs, caches, runtime data the
 *   plugin itself writes into its own folder) are tolerated — an
 *   attacker who can write into the plugin directory can already
 *   modify a signed file, which IS caught, so refusing every added
 *   log file would only brick plugins that log, not add safety.
 *   This rule is pinned by tests (added `evil.js` → invalid; added
 *   `*.log` → still signed).
 * - Policy (decided v0.93a, see `enforcePluginSignature` and
 *   `docs/plugin-marketplace-signing.md`): a signature that is
 *   PRESENT is always verified — bad/unknown-key/tampered is refused
 *   everywhere, even for local sources. A signature that is ABSENT is
 *   refused for `url`/`git` sources unless the caller passes an
 *   explicit `allowUnsigned: true` (the UI must only set that after
 *   the user confirms "install unsigned plugin"); a `local` source
 *   without a signature is allowed — the user copied it from their
 *   own disk, the same trust as a hand-installed plugin.
 *   Hand-installed plugins (no marketplace record) are NOT checked
 *   at all — unchanged trust model, same as before.
 *
 * This module is pure: it never reads the network and never decides
 * policy on its own — `enforcePluginSignature` is the single policy
 * choke point, and the install/load paths call it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createHash,
  createPublicKey,
  createPrivateKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

/** Name of the signature file at the plugin root. */
export const PLUGIN_SIGNATURE_FILE = 'signature.json';
/** Name of the trusted-keys file under the user-data dir. */
export const PLUGIN_TRUSTED_KEYS_FILE = 'marketplace/trusted-keys.json';
/** Signature algorithm — the only one supported (v0.93a). */
export const PLUGIN_SIGNATURE_ALGORITHM = 'ed25519' as const;
/**
 * Extensions Node `require()`s as code by default. A file with one
 * of these extensions that was ADDED after signing is refused (it
 * could be loaded as code); other added files are runtime data and
 * are tolerated (see header).
 */
export const PLUGIN_SIGNATURE_CODE_EXTS: ReadonlySet<string> = new Set([
  '.js',
  '.cjs',
  '.mjs',
  '.node',
  '.json',
]);

/** Verification outcome for one plugin directory. */
export type PluginSignatureStatus = 'signed' | 'unsigned' | 'invalid';

export interface PluginSignatureVerification {
  status: PluginSignatureStatus;
  /** Key id that signed the bundle (when signed, or attempted). */
  keyId?: string;
  /** Clear reason when status is 'invalid'. */
  error?: string;
  /** Number of files covered by the signature (when signed). */
  files?: number;
}

/** One signature.json payload (as stored on disk). */
export interface PluginBundleSignature {
  algorithm: typeof PLUGIN_SIGNATURE_ALGORITHM;
  keyId: string;
  pluginId: string;
  version: string;
  /** Relative POSIX path -> sha256 hex of file bytes. */
  files: Record<string, string>;
  /** Base64 Ed25519 signature over the canonical signed payload. */
  signature: string;
}

/** One entry of the trusted-keys store. */
export interface TrustedMarketplaceKey {
  /** SPKI PEM of the Ed25519 public key. */
  publicKey: string;
  label?: string;
  addedAt: string;
}

export type TrustedMarketplaceKeys = Record<string, TrustedMarketplaceKey>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Canonical JSON: object keys sorted recursively, so the same payload
 * always signs/verifies to the same bytes on every machine.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Key id = sha256 hex of the SPKI DER (derived from the key itself). */
export function marketplaceKeyId(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Trusted marketplace keys must be Ed25519 keys.');
  }
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
}

/**
 * Generate a fresh Ed25519 signing key pair for a plugin publisher.
 * The PRIVATE key must stay with the publisher and is never stored by
 * open-bot; only the public key goes into the trusted-keys store.
 * Returns the keyId (sha256 of the SPKI DER) plus both PEMs.
 */
export function generateMarketplaceSigningKeyPair(label?: string): {
  keyId: string;
  publicKey: string;
  privateKey: string;
  label?: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const keyId = marketplaceKeyId(publicPem);
  return {
    keyId,
    publicKey: publicPem,
    privateKey: privatePem,
    ...(label !== undefined ? { label } : {}),
  };
}

/**
 * Hash every file of a plugin directory (relative POSIX path ->
 * sha256 hex), excluding `signature.json` itself, `node_modules` and
 * `.git`. Sorted walk, so the result is deterministic.
 */
export function hashPluginBundleFiles(dir: string): Record<string, string> {
  const absDir = path.resolve(dir);
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const rel = path.relative(absDir, full).split(path.sep).join('/');
        if (rel === PLUGIN_SIGNATURE_FILE) continue;
        out[rel] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      }
    }
  };
  walk(absDir);
  return out;
}

/** The exact bytes that get signed (canonical JSON, no `signature` field). */
export function signedPayloadFor(
  signature: Omit<PluginBundleSignature, 'signature'>,
): string {
  return canonicalJson({
    algorithm: signature.algorithm,
    keyId: signature.keyId,
    pluginId: signature.pluginId,
    version: signature.version,
    files: signature.files,
  });
}

function readPluginIdAndVersion(dir: string): { pluginId: string; version: string } {
  const manifestPath = path.join(path.resolve(dir), 'manifest.json');
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `Cannot sign plugin in "${dir}": manifest.json is missing or not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!isRecord(raw) || typeof raw['id'] !== 'string' || typeof raw['version'] !== 'string') {
    throw new Error(`Cannot sign plugin in "${dir}": manifest.json has no string "id"/"version".`);
  }
  return { pluginId: raw['id'], version: raw['version'] };
}

/**
 * Sign a plugin directory: hash every file, sign the canonical
 * payload with the publisher's Ed25519 private key, and write
 * `signature.json` at the plugin root. Returns the written payload.
 * The keyId is derived from the private key's public half — a caller
 * cannot claim a signature belongs to a different key.
 */
export function signPluginBundle(
  dir: string,
  privateKeyPem: string,
  opts: { keyId?: string } = {},
): PluginBundleSignature {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch (err) {
    throw new Error(`Cannot sign plugin: invalid private key: ${(err as Error).message}`);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Cannot sign plugin: the private key must be an Ed25519 key.');
  }
  const publicKey = createPublicKey(privateKey);
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const keyId = marketplaceKeyId(publicPem);
  if (opts.keyId !== undefined && opts.keyId !== keyId) {
    throw new Error(
      'Cannot sign plugin: the given keyId does not match the private key (a signature must name its own key).',
    );
  }
  const { pluginId, version } = readPluginIdAndVersion(dir);
  const files = hashPluginBundleFiles(dir);
  const unsigned: Omit<PluginBundleSignature, 'signature'> = {
    algorithm: PLUGIN_SIGNATURE_ALGORITHM,
    keyId,
    pluginId,
    version,
    files,
  };
  const signature = sign(null, Buffer.from(signedPayloadFor(unsigned), 'utf8'), privateKey);
  const payload: PluginBundleSignature = {
    ...unsigned,
    signature: signature.toString('base64'),
  };
  fs.writeFileSync(
    path.join(path.resolve(dir), PLUGIN_SIGNATURE_FILE),
    JSON.stringify(payload, null, 2) + '\n',
    'utf8',
  );
  return payload;
}

/**
 * Verify a plugin directory against trusted keys. Never throws for a
 * bad signature — it returns `{ status: 'invalid', error }` so callers
 * can fail closed with a clear message. Throws only when the directory
 * itself cannot be read at all.
 */
export function verifyPluginBundleSignature(
  dir: string,
  trustedKeys: TrustedMarketplaceKeys | Map<string, string> | Record<string, string>,
): PluginSignatureVerification {
  const absDir = path.resolve(dir);
  const sigPath = path.join(absDir, PLUGIN_SIGNATURE_FILE);
  if (!fs.existsSync(sigPath)) return { status: 'unsigned' };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(sigPath, 'utf8'));
  } catch (err) {
    return {
      status: 'invalid',
      error: `signature.json is not valid JSON: ${(err as Error).message}`,
    };
  }
  if (!isRecord(raw)) {
    return { status: 'invalid', error: 'signature.json must be a JSON object.' };
  }
  const keyId = typeof raw['keyId'] === 'string' ? raw['keyId'] : undefined;
  if (raw['algorithm'] !== PLUGIN_SIGNATURE_ALGORITHM) {
    return {
      status: 'invalid',
      ...(keyId !== undefined ? { keyId } : {}),
      error: `unsupported signature algorithm ${JSON.stringify(raw['algorithm'])} (expected "ed25519").`,
    };
  }
  if (!keyId) {
    return { status: 'invalid', error: 'signature.json has no "keyId".' };
  }
  if (
    typeof raw['pluginId'] !== 'string' ||
    typeof raw['version'] !== 'string' ||
    !isRecord(raw['files']) ||
    typeof raw['signature'] !== 'string'
  ) {
    return {
      status: 'invalid',
      keyId,
      error: 'signature.json is missing "pluginId", "version", "files" or "signature".',
    };
  }
  // The signature must name the plugin + version on disk — a signature
  // transplanted from another plugin or version is refused.
  const { pluginId, version } = readPluginIdAndVersionSafe(absDir);
  if (pluginId !== undefined && raw['pluginId'] !== pluginId) {
    return {
      status: 'invalid',
      keyId,
      error: `signature is for plugin "${raw['pluginId']}", not "${pluginId}" — refused.`,
    };
  }
  if (version !== undefined && raw['version'] !== version) {
    return {
      status: 'invalid',
      keyId,
      error: `signature is for version "${raw['version']}", not "${version}" — refused.`,
    };
  }
  const files = raw['files'] as Record<string, unknown>;
  for (const [rel, hash] of Object.entries(files)) {
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
      return { status: 'invalid', keyId, error: `signature.json has a bad hash for file "${rel}".` };
    }
  }
  let actual: Record<string, string>;
  try {
    actual = hashPluginBundleFiles(absDir);
  } catch (err) {
    return { status: 'invalid', keyId, error: `cannot hash plugin files: ${(err as Error).message}` };
  }
  const expectedPaths = Object.keys(files).sort();
  const actualPaths = Object.keys(actual).sort();
  const missing = expectedPaths.filter((p) => !(p in actual));
  if (missing.length > 0) {
    return {
      status: 'invalid',
      keyId,
      error: `bundle is missing signed file(s): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ''} — refused.`,
    };
  }
  const extra = actualPaths.filter((p) => !(p in files));
  // v0.93a: only added files that could be loaded as code are
  // refused — runtime data the plugin itself writes (logs, caches)
  // is tolerated (see header for the reasoning).
  const extraCode = extra.filter((p) => PLUGIN_SIGNATURE_CODE_EXTS.has(path.extname(p)));
  if (extraCode.length > 0) {
    return {
      status: 'invalid',
      keyId,
      error: `bundle has unsigned code file(s) not covered by the signature: ${extraCode.slice(0, 5).join(', ')}${extraCode.length > 5 ? ` (+${extraCode.length - 5} more)` : ''} — refused.`,
    };
  }
  for (const p of expectedPaths) {
    if (actual[p] !== files[p]) {
      return {
        status: 'invalid',
        keyId,
        error: `file "${p}" was changed after signing — refused.`,
      };
    }
  }
  const publicKeyPem = lookupTrustedKeyPem(trustedKeys, keyId);
  if (publicKeyPem === undefined) {
    return {
      status: 'invalid',
      keyId,
      error:
        `signing key "${keyId}" is not trusted (no matching public key in the trusted-keys store) — ` +
        `add the publisher's public key first, or refuse the plugin.`,
    };
  }
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch (err) {
    return {
      status: 'invalid',
      keyId,
      error: `trusted public key "${keyId}" is not a valid key: ${(err as Error).message}`,
    };
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    return { status: 'invalid', keyId, error: `trusted key "${keyId}" is not an Ed25519 key.` };
  }
  const unsigned: Omit<PluginBundleSignature, 'signature'> = {
    algorithm: PLUGIN_SIGNATURE_ALGORITHM,
    keyId,
    pluginId: raw['pluginId'] as string,
    version: raw['version'] as string,
    files: files as Record<string, string>,
  };
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(raw['signature'] as string, 'base64');
  } catch {
    return { status: 'invalid', keyId, error: 'signature.json has a "signature" that is not base64.' };
  }
  let ok = false;
  try {
    ok = verify(null, Buffer.from(signedPayloadFor(unsigned), 'utf8'), publicKey, signatureBytes);
  } catch (err) {
    return { status: 'invalid', keyId, error: `signature verification failed: ${(err as Error).message}` };
  }
  if (!ok) {
    return { status: 'invalid', keyId, error: 'signature does not match the signed bundle — refused.' };
  }
  return { status: 'signed', keyId, files: expectedPaths.length };
}

function readPluginIdAndVersionSafe(
  absDir: string,
): { pluginId?: string; version?: string } {
  try {
    return readPluginIdAndVersion(absDir);
  } catch {
    return {};
  }
}

function lookupTrustedKeyPem(
  trustedKeys: TrustedMarketplaceKeys | Map<string, string> | Record<string, string>,
  keyId: string,
): string | undefined {
  if (trustedKeys instanceof Map) return trustedKeys.get(keyId);
  const entry = (trustedKeys as Record<string, unknown>)[keyId];
  if (typeof entry === 'string') return entry;
  if (isRecord(entry) && typeof entry['publicKey'] === 'string') {
    return entry['publicKey'] as string;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Trusted-keys store
// ---------------------------------------------------------------------------

function trustedKeysPath(userDataDir: string): string {
  return path.join(path.resolve(userDataDir), PLUGIN_TRUSTED_KEYS_FILE);
}

/**
 * Load the trusted-keys store. A missing file means "no trusted keys"
 * (empty store); a corrupt file throws with a clear message — a
 * silently-ignored corrupt store would fail closed later in a
 * confusing way, so surface it here.
 */
export function loadTrustedMarketplaceKeys(userDataDir: string): TrustedMarketplaceKeys {
  const filePath = trustedKeysPath(userDataDir);
  if (!fs.existsSync(filePath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(
      `Invalid trusted-keys file "${filePath}": not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!isRecord(parsed)) return {};
  const out: TrustedMarketplaceKeys = {};
  for (const [keyId, raw] of Object.entries(parsed)) {
    if (!isRecord(raw) || typeof raw['publicKey'] !== 'string') continue;
    out[keyId] = {
      publicKey: raw['publicKey'],
      ...(typeof raw['label'] === 'string' ? { label: raw['label'] } : {}),
      addedAt: typeof raw['addedAt'] === 'string' ? raw['addedAt'] : '',
    };
  }
  return out;
}

function writeTrustedMarketplaceKeys(userDataDir: string, keys: TrustedMarketplaceKeys): void {
  const filePath = trustedKeysPath(userDataDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(keys, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

/** List trusted publisher keys (public keys only — no private material lives here). */
export function listTrustedMarketplaceKeys(
  userDataDir: string,
): Array<{ keyId: string; label?: string; addedAt: string }> {
  const keys = loadTrustedMarketplaceKeys(userDataDir);
  return Object.entries(keys)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([keyId, entry]) => ({
      keyId,
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      addedAt: entry.addedAt,
    }));
}

/**
 * Trust a publisher's Ed25519 public key (SPKI PEM). The keyId is
 * derived from the key itself. Returns the keyId. Throws on a bad PEM
 * or a non-Ed25519 key — a bad key must never be recorded as trusted.
 */
export function addTrustedMarketplaceKey(
  userDataDir: string,
  publicKeyPem: string,
  label?: string,
): string {
  let keyId: string;
  try {
    keyId = marketplaceKeyId(publicKeyPem);
  } catch (err) {
    throw new Error(`Cannot trust marketplace key: ${(err as Error).message}`);
  }
  const keys = loadTrustedMarketplaceKeys(userDataDir);
  keys[keyId] = {
    publicKey: publicKeyPem,
    ...(label !== undefined ? { label } : {}),
    addedAt: new Date().toISOString(),
  };
  writeTrustedMarketplaceKeys(userDataDir, keys);
  return keyId;
}

/** Stop trusting a publisher key. Returns true when a key was removed. */
export function removeTrustedMarketplaceKey(userDataDir: string, keyId: string): boolean {
  const keys = loadTrustedMarketplaceKeys(userDataDir);
  if (!Object.prototype.hasOwnProperty.call(keys, keyId)) return false;
  delete keys[keyId];
  writeTrustedMarketplaceKeys(userDataDir, keys);
  return true;
}

// ---------------------------------------------------------------------------
// Policy — the single choke point (see header)
// ---------------------------------------------------------------------------

export type PluginMarketplaceSourceKindForPolicy = 'local' | 'url' | 'git';

export interface EnforcePluginSignatureOptions {
  trustedKeys: TrustedMarketplaceKeys | Map<string, string> | Record<string, string>;
  /**
   * Explicit user opt-in to install/load an UNSIGNED plugin from a
   * remote source. Default false. The UI/CLI must only set this after
   * the user confirms "install unsigned plugin" — it is never set by
   * default, and the decision is recorded in marketplace-installed.json.
   */
  allowUnsigned?: boolean;
}

/**
 * Enforce the v0.93a signature policy for one plugin directory.
 * Returns the verification (callers record `status`/`keyId`).
 * THROWS (fail-closed) when the plugin must be refused:
 * - signature present but invalid (tampered / unknown key / wrong
 *   plugin or version / bad format) — for EVERY source kind,
 *   including local;
 * - signature absent and source is `url`/`git` without an explicit
 *   `allowUnsigned` — the plugin is refused, with a message that
 *   names the missing signature and the way out (sign it, trust the
 *   publisher's key, or explicitly allow unsigned).
 * Allowed without throwing: a valid signature, and an unsigned `local`
 * source (user's own disk — same trust as hand-installed).
 */
export function enforcePluginSignature(
  dir: string,
  sourceKind: PluginMarketplaceSourceKindForPolicy,
  opts: EnforcePluginSignatureOptions,
): PluginSignatureVerification {
  const verification = verifyPluginBundleSignature(dir, opts.trustedKeys);
  const { pluginId } = readPluginIdAndVersionSafe(path.resolve(dir));
  const idLabel = pluginId !== undefined ? `Plugin "${pluginId}"` : 'Plugin';
  if (verification.status === 'invalid') {
    throw new Error(
      `${idLabel} was refused: bundle signature is invalid — ${verification.error ?? 'unknown reason'}`,
    );
  }
  if (verification.status === 'signed') return verification;
  // Unsigned.
  if (sourceKind === 'local') return verification;
  if (opts.allowUnsigned === true) return verification;
  throw new Error(
    `${idLabel} was refused: the bundle is UNSIGNED (no signature.json) and comes from a ` +
      `${sourceKind} source — only signed plugins are installed from remote sources. ` +
      `Ask the publisher to sign it (Ed25519, see docs/plugin-marketplace-signing.md), ` +
      `or explicitly allow this unsigned install after reviewing the source.`,
  );
}
