/**
 * Tests for plugin marketplace bundle signing + downgrade (v0.93a).
 *
 * What is proven here (all MOCK / LOCAL-ONLY — no network, no key):
 *
 * - SIGNING (Ed25519, node:crypto): a correctly signed bundle
 *   verifies as `signed`; changing one file, adding an unsigned file,
 *   deleting a signed file, or transplanting the signature onto
 *   another plugin/version all verify as `invalid`; a signature from
 *   a key that is not in the trusted-keys store is `invalid`.
 * - POLICY (fail-closed): an unsigned bundle from a `url` source is
 *   refused at prepare/install, unless the caller explicitly passes
 *   `allowUnsigned: true` (recorded, so bot start honours it); an
 *   unsigned `local` source still installs; a signed bundle whose key
 *   is not trusted is refused.
 * - DOWNGRADE: updating v1 -> v2 snapshots v1; `downgradePlugin`
 *   restores v1 (tool output proves the old code runs again) and can
 *   be applied again to swap back to v2; with no previous version it
 *   throws a clear error; uninstall drops the snapshot.
 * - BOT START: `loadMarketplacePluginsAtStartup` verifies BEFORE
 *   loading — a tampered new version auto-rolls back to the previous
 *   working version (`rolledBack`), a version that fails to LOAD
 *   rolls back too, and a bad plugin with no previous version is
 *   skipped without breaking bot start; a signed marketplace plugin
 *   is never required in-process (pid proof, both scan modes).
 *
 * Run after building the tools + core packages:
 *   npm run build --workspace=@open-bot/tools
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/plugin-marketplace-signing-v093a.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import {
  disposePluginManagers,
  loadPlugins,
  loadMarketplacePluginsAtStartup,
} from '../packages/core/dist/coordinator/coordinator.js';
import { PluginManager } from '../packages/tools/dist/plugins/manager.js';
import {
  addTrustedMarketplaceKey,
  generateMarketplaceSigningKeyPair,
  listTrustedMarketplaceKeys,
  loadTrustedMarketplaceKeys,
  removeTrustedMarketplaceKey,
  signPluginBundle,
  verifyPluginBundleSignature,
} from '../packages/tools/dist/plugins/signing.js';
import {
  downgradePlugin,
  getPluginDowngradeInfo,
  installPluginFromSource,
  listMarketplacePlugins,
  preparePluginFromSource,
  uninstallMarketplacePlugin,
  updatePluginFromSource,
  verifyInstalledPluginSignature,
} from '../packages/tools/dist/plugins/marketplace.js';
import { recordMarketplaceApproval } from '../packages/core/dist/mcp/marketplaceApproval.js';

const PLUGIN_ID = 'sign-demo';
const TOOL_NAME = 'sign_demo_echo';
const MARKER_FILE = 'sign93-markers.log';

const tempDirs = [];
const managers = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function readLogLines(markerFile) {
  if (!fs.existsSync(markerFile)) return [];
  return fs.readFileSync(markerFile, 'utf8').split('\n').filter(Boolean);
}

function loadedPids(markerFile) {
  return readLogLines(markerFile)
    .filter((line) => line.startsWith('loaded:'))
    .map((line) => Number(line.slice('loaded:'.length)));
}

afterEach(async () => {
  for (const m of managers.splice(0)) {
    await m.disposeSandboxed().catch(() => undefined);
  }
  // Dispose sandbox hosts forked by direct loadPlugins() calls (see
  // plugin-marketplace-startup-v092a.test.mjs: SIGKILL-ing the worker
  // is NOT enough — the host restarts it, and the open IPC channel
  // keeps this test process alive forever).
  await disposePluginManagers();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

/** Build a minimal loadable plugin SOURCE folder (not yet installed). */
function makePluginSource(version, opts = {}) {
  const dir = makeTempDir(`open-bot-sign93-src-${version}-`);
  const manifest = {
    id: PLUGIN_ID,
    name: 'Signing Demo Plugin',
    version,
    description: 'Fixture plugin for bundle signing + downgrade.',
    permissions: ['fs'],
    main: 'index.js',
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  const indexJs = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const marker = path.join(__dirname, '${MARKER_FILE}');`,
    "fs.appendFileSync(marker, `loaded:${process.pid}\\n`);",
    'module.exports = { tools: [{',
    `  definition: { name: '${TOOL_NAME}', description: 'Echo (signing fixture).',`,
    "    parameters: { type: 'object', properties: { text: { type: 'string' } } } },",
    '  needsApproval: false,',
    '  execute: async (args) => {',
    "    fs.appendFileSync(marker, `called:${args?.text ?? ''}\\n`);",
    `    return \`v${version}:\${args?.text ?? ''}\`;`,
    '  },',
    '}] };',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'index.js'), opts.broken ? 'module.exports = { tools: [;' : indexJs, 'utf8');
  return dir;
}

function approve(userDataDir, kind, version) {
  recordMarketplaceApproval(userDataDir, {
    kind,
    targetId: PLUGIN_ID,
    version,
    source: 'local',
  });
}

function makeKeypair(userDataDir, label = 'test publisher') {
  const pair = generateMarketplaceSigningKeyPair(label);
  const keyId = addTrustedMarketplaceKey(userDataDir, pair.publicKey, label);
  assert.equal(keyId, pair.keyId, 'keyId must be derived from the key itself');
  return pair;
}

/** Zip a plugin source dir (uses the `zip` CLI, like the real url path uses `unzip`). */
function zipDir(srcDir) {
  const zipPath = path.join(makeTempDir('open-bot-sign93-zip-'), 'bundle.zip');
  execFileSync('zip', ['-qr', zipPath, '.'], { cwd: srcDir, stdio: 'pipe' });
  const bytes = fs.readFileSync(zipPath);
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function mockFetch(bytes) {
  return async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes,
  });
}

async function installSignedFixture(version, { signed = true } = {}) {
  const userDataDir = makeTempDir('open-bot-sign93-userdata-');
  const pluginsDir = path.join(userDataDir, 'plugins');
  const srcDir = makePluginSource(version);
  let pair = null;
  if (signed) {
    pair = makeKeypair(userDataDir);
    signPluginBundle(srcDir, pair.privateKey);
  }
  approve(userDataDir, 'plugin-install', version);
  await installPluginFromSource({ kind: 'local', path: srcDir }, pluginsDir, { userDataDir });
  const markerFile = path.join(pluginsDir, PLUGIN_ID, MARKER_FILE);
  fs.writeFileSync(markerFile, '', 'utf8');
  return { userDataDir, pluginsDir, markerFile, pair, srcDir };
}

// ---------------------------------------------------------------------------
// Signing primitives
// ---------------------------------------------------------------------------

test('sign + verify: ký đúng → signed, đúng keyId, đủ số file', () => {
  const userDataDir = makeTempDir('open-bot-sign93-keys-');
  const pair = makeKeypair(userDataDir);
  const dir = makePluginSource('1.0.0');
  const payload = signPluginBundle(dir, pair.privateKey);
  assert.equal(payload.algorithm, 'ed25519');
  assert.equal(payload.keyId, pair.keyId);
  assert.equal(payload.pluginId, PLUGIN_ID);
  assert.equal(payload.version, '1.0.0');
  assert.deepEqual(Object.keys(payload.files).sort(), ['index.js', 'manifest.json']);
  assert.ok(fs.existsSync(path.join(dir, 'signature.json')), 'signature.json must be written');

  const check = verifyPluginBundleSignature(dir, loadTrustedMarketplaceKeys(userDataDir));
  assert.equal(check.status, 'signed');
  assert.equal(check.keyId, pair.keyId);
  assert.equal(check.files, 2);
});

test('verify: sửa / thêm / xoá file sau khi ký → invalid (fail-closed)', () => {
  const userDataDir = makeTempDir('open-bot-sign93-keys-');
  const pair = makeKeypair(userDataDir);
  const keys = loadTrustedMarketplaceKeys(userDataDir);

  // (a) One byte changed in a signed file.
  const tampered = makePluginSource('1.0.0');
  signPluginBundle(tampered, pair.privateKey);
  fs.appendFileSync(path.join(tampered, 'index.js'), '\n// tampered\n');
  const a = verifyPluginBundleSignature(tampered, keys);
  assert.equal(a.status, 'invalid');
  assert.match(a.error, /index\.js.*changed after signing/);

  // (b) An extra file not covered by the signature.
  const extra = makePluginSource('1.0.0');
  signPluginBundle(extra, pair.privateKey);
  fs.writeFileSync(path.join(extra, 'evil.js'), 'module.exports = {};');
  const b = verifyPluginBundleSignature(extra, keys);
  assert.equal(b.status, 'invalid');
  assert.match(b.error, /unsigned code file\(s\) not covered by the signature/);
  assert.match(b.error, /evil\.js/);

  // (b2) An extra NON-code file (runtime data the plugin itself
  // wrote, e.g. a log) is tolerated — it cannot be required as code.
  const extraLog = makePluginSource('1.0.0');
  signPluginBundle(extraLog, pair.privateKey);
  fs.writeFileSync(path.join(extraLog, 'run.log'), 'loaded:1234\n');
  const b2 = verifyPluginBundleSignature(extraLog, keys);
  assert.equal(b2.status, 'signed');

  // (c) A signed file deleted.
  const deleted = makePluginSource('1.0.0');
  signPluginBundle(deleted, pair.privateKey);
  fs.rmSync(path.join(deleted, 'index.js'));
  const c = verifyPluginBundleSignature(deleted, keys);
  assert.equal(c.status, 'invalid');
  assert.match(c.error, /missing signed file/);
});

test('verify: key lạ (không tin tưởng) và signature tráo plugin/version → invalid', () => {
  const userDataDir = makeTempDir('open-bot-sign93-keys-');
  const trusted = makeKeypair(userDataDir, 'trusted publisher');
  const stranger = generateMarketplaceSigningKeyPair('stranger');
  const keys = loadTrustedMarketplaceKeys(userDataDir);

  // Signed by a key that is not in the trust store.
  const dir = makePluginSource('1.0.0');
  signPluginBundle(dir, stranger.privateKey);
  const unknown = verifyPluginBundleSignature(dir, keys);
  assert.equal(unknown.status, 'invalid');
  assert.match(unknown.error, /not trusted/);
  assert.equal(unknown.keyId, stranger.keyId);

  // Signature transplanted onto another version (re-sign, then bump
  // the manifest version without re-signing).
  const dir2 = makePluginSource('1.0.0');
  signPluginBundle(dir2, trusted.privateKey);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir2, 'manifest.json'), 'utf8'));
  manifest.version = '9.9.9';
  fs.writeFileSync(path.join(dir2, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  const transplanted = verifyPluginBundleSignature(dir2, keys);
  assert.equal(transplanted.status, 'invalid');
  assert.match(transplanted.error, /version "1\.0\.0", not "9\.9\.9"/);

  // No signature.json at all.
  const unsigned = makePluginSource('1.0.0');
  assert.deepEqual(verifyPluginBundleSignature(unsigned, keys), { status: 'unsigned' });
});

test('trusted keys store: add/list/remove, PEM hỏng bị từ chối', () => {
  const userDataDir = makeTempDir('open-bot-sign93-keys-');
  const pair = generateMarketplaceSigningKeyPair('publisher A');
  assert.deepEqual(listTrustedMarketplaceKeys(userDataDir), []);
  const keyId = addTrustedMarketplaceKey(userDataDir, pair.publicKey, 'publisher A');
  assert.equal(keyId, pair.keyId);
  const listed = listTrustedMarketplaceKeys(userDataDir);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].keyId, pair.keyId);
  assert.equal(listed[0].label, 'publisher A');
  // A non-Ed25519 key (RSA) is refused — it must never be recorded.
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsaPem = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  assert.throws(
    () => addTrustedMarketplaceKey(userDataDir, rsaPem),
    /must be Ed25519/,
  );
  assert.throws(() => addTrustedMarketplaceKey(userDataDir, 'not a pem'), /Cannot trust/);
  assert.equal(removeTrustedMarketplaceKey(userDataDir, pair.keyId), true);
  assert.equal(removeTrustedMarketplaceKey(userDataDir, pair.keyId), false);
  assert.deepEqual(listTrustedMarketplaceKeys(userDataDir), []);
  // A plugin signed by a REMOVED key fails verification afterwards.
  const pair2 = makeKeypair(userDataDir);
  const dir = makePluginSource('1.0.0');
  signPluginBundle(dir, pair2.privateKey);
  assert.equal(
    verifyPluginBundleSignature(dir, loadTrustedMarketplaceKeys(userDataDir)).status,
    'signed',
  );
  removeTrustedMarketplaceKey(userDataDir, pair2.keyId);
  const after = verifyPluginBundleSignature(dir, loadTrustedMarketplaceKeys(userDataDir));
  assert.equal(after.status, 'invalid');
  assert.match(after.error, /not trusted/);
});

// ---------------------------------------------------------------------------
// Install policy (fail-closed)
// ---------------------------------------------------------------------------

test('install: local unsigned vẫn cài; local đã ký nhưng key chưa trust → từ chối', async () => {
  // Unsigned local source: allowed (user's own disk).
  const userDataDir = makeTempDir('open-bot-sign93-userdata-');
  const pluginsDir = path.join(userDataDir, 'plugins');
  const srcUnsigned = makePluginSource('1.0.0');
  approve(userDataDir, 'plugin-install', '1.0.0');
  const installed = await installPluginFromSource(
    { kind: 'local', path: srcUnsigned },
    pluginsDir,
    { userDataDir },
  );
  assert.equal(installed.signature.status, 'unsigned');
  assert.equal(listMarketplacePlugins(pluginsDir)[0].signatureStatus, 'unsigned-local');

  // Signed local source, key NOT trusted: refused even for local —
  // a present-but-untrusted signature is worse than no signature.
  const stranger = generateMarketplaceSigningKeyPair('stranger');
  const srcSigned = makePluginSource('1.0.0');
  signPluginBundle(srcSigned, stranger.privateKey);
  await assert.rejects(
    installPluginFromSource({ kind: 'local', path: srcSigned }, pluginsDir, { userDataDir }),
    /signature is invalid.*not trusted/,
  );
});

test('install url (mock fetch zip): unsigned → từ chối; allowUnsigned → cài + ghi nhận; ký đúng → cài', async () => {
  const userDataDir = makeTempDir('open-bot-sign93-userdata-');
  const pluginsDir = path.join(userDataDir, 'plugins');
  const url = 'https://example.com/sign-demo.zip';

  // (a) Unsigned remote bundle: refused fail-closed.
  const zipUnsigned = zipDir(makePluginSource('1.0.0'));
  approve(userDataDir, 'plugin-install', '1.0.0');
  await assert.rejects(
    installPluginFromSource({ kind: 'url', url }, pluginsDir, {
      userDataDir,
      fetchFn: mockFetch(zipUnsigned.bytes),
      sha256: zipUnsigned.sha256,
    }),
    /UNSIGNED.*only signed plugins are installed from remote sources/,
  );

  // (b) Same bundle with an explicit unsigned opt-in: installs, and
  // the decision is recorded so bot start honours it.
  const allowed = await installPluginFromSource({ kind: 'url', url }, pluginsDir, {
    userDataDir,
    fetchFn: mockFetch(zipUnsigned.bytes),
    sha256: zipUnsigned.sha256,
    allowUnsigned: true,
  });
  assert.equal(allowed.signature.status, 'unsigned');
  assert.equal(listMarketplacePlugins(pluginsDir)[0].signatureStatus, 'unsigned-allowed');
  const check = verifyInstalledPluginSignature(pluginsDir, PLUGIN_ID, { userDataDir });
  assert.equal(check.ok, true, 'recorded allowUnsigned must pass the load-time check');

  // (c) Signed remote bundle with a trusted key: installs as signed.
  const pair = makeKeypair(userDataDir);
  const srcSigned = makePluginSource('1.0.0');
  signPluginBundle(srcSigned, pair.privateKey);
  const zipSigned = zipDir(srcSigned);
  approve(userDataDir, 'plugin-install', '1.0.0');
  const signed = await installPluginFromSource({ kind: 'url', url }, pluginsDir, {
    userDataDir,
    fetchFn: mockFetch(zipSigned.bytes),
    sha256: zipSigned.sha256,
    overwrite: true,
  });
  assert.equal(signed.signature.status, 'signed');
  assert.equal(signed.signature.keyId, pair.keyId);
  assert.equal(listMarketplacePlugins(pluginsDir)[0].signatureStatus, 'signed');
});

test('install url: zip đã ký nhưng sửa 1 file trong zip → từ chối (tampered)', async () => {
  const userDataDir = makeTempDir('open-bot-sign93-userdata-');
  const pluginsDir = path.join(userDataDir, 'plugins');
  const pair = makeKeypair(userDataDir);
  const srcDir = makePluginSource('1.0.0');
  signPluginBundle(srcDir, pair.privateKey);
  // Tamper AFTER signing, before zipping: the signature no longer
  // matches the bytes that travel over the wire.
  fs.appendFileSync(path.join(srcDir, 'index.js'), '\n// tampered in transit\n');
  const zipped = zipDir(srcDir);
  approve(userDataDir, 'plugin-install', '1.0.0');
  await assert.rejects(
    installPluginFromSource({ kind: 'url', url: 'https://example.com/sign-demo.zip' }, pluginsDir, {
      userDataDir,
      fetchFn: mockFetch(zipped.bytes),
      sha256: zipped.sha256,
    }),
    /signature is invalid.*changed after signing/,
  );
  assert.equal(listMarketplacePlugins(pluginsDir).length, 0, 'nothing must be installed');
});

test('prepare: unsigned url bị từ chối ngay ở prepare (trước approval)', async () => {
  const userDataDir = makeTempDir('open-bot-sign93-userdata-');
  const zipped = zipDir(makePluginSource('1.0.0'));
  const prepared = await assert.rejects(
    preparePluginFromSource({ kind: 'url', url: 'https://example.com/sign-demo.zip' }, {
      userDataDir,
      fetchFn: mockFetch(zipped.bytes),
      sha256: zipped.sha256,
    }),
    /UNSIGNED/,
  );
  assert.equal(prepared, undefined);
});

// ---------------------------------------------------------------------------
// Downgrade
// ---------------------------------------------------------------------------

test('update + downgrade: v1 → v2 snapshot v1; downgrade về v1 rồi swap lại v2', async () => {
  const { userDataDir, pluginsDir, pair: keypairV1 } = await installSignedFixture('1.0.0');
  const trustedKeyId = keypairV1.keyId;

  // No previous version yet.
  let info = getPluginDowngradeInfo(PLUGIN_ID, pluginsDir, { userDataDir });
  assert.equal(info.canDowngrade, false);
  assert.equal(info.previousVersion, null);
  assert.throws(
    () => downgradePlugin(PLUGIN_ID, pluginsDir, { userDataDir }),
    /no previous version/,
  );

  // Update to v2 (signed with a second trusted publisher key — v1's
  // keypair is fixture-local; what matters is that both versions are
  // signed by keys in the trust store).
  const pair2 = generateMarketplaceSigningKeyPair('publisher v2');
  addTrustedMarketplaceKey(userDataDir, pair2.publicKey, 'publisher v2');
  const srcV2 = makePluginSource('2.0.0');
  signPluginBundle(srcV2, pair2.privateKey);
  approve(userDataDir, 'plugin-update', '2.0.0');
  const updated = await updatePluginFromSource(
    PLUGIN_ID,
    { kind: 'local', path: srcV2 },
    pluginsDir,
    { userDataDir },
  );
  assert.equal(updated.version, '2.0.0');
  assert.equal(updated.previousVersion, '1.0.0');
  assert.equal(updated.signature.status, 'signed');

  info = getPluginDowngradeInfo(PLUGIN_ID, pluginsDir, { userDataDir });
  assert.equal(info.canDowngrade, true);
  assert.equal(info.currentVersion, '2.0.0');
  assert.equal(info.previousVersion, '1.0.0');
  assert.equal(listMarketplacePlugins(pluginsDir)[0].previousVersion, '1.0.0');

  // Downgrade restores v1 — and the v1 signature still verifies
  // (the snapshot kept its signature.json).
  const down = downgradePlugin(PLUGIN_ID, pluginsDir, { userDataDir });
  assert.deepEqual(
    { id: down.id, fromVersion: down.fromVersion, toVersion: down.toVersion },
    { id: PLUGIN_ID, fromVersion: '2.0.0', toVersion: '1.0.0' },
  );
  assert.equal(down.signature.status, 'signed');
  assert.equal(down.signature.keyId, trustedKeyId);
  assert.equal(listMarketplacePlugins(pluginsDir)[0].version, '1.0.0');
  const manager = new PluginManager(pluginsDir);
  managers.push(manager);
  const loaded = manager.scanDir();
  assert.equal(loaded.length, 1);
  const tool = manager.toolsForRegistry().find((t) => t.definition.name === TOOL_NAME);
  assert.equal(await tool.execute({ text: 'hi' }, {}), 'v1.0.0:hi');

  // Downgrading again swaps back to v2 (the downgrade is reversible).
  const up = downgradePlugin(PLUGIN_ID, pluginsDir, { userDataDir });
  assert.equal(up.fromVersion, '1.0.0');
  assert.equal(up.toVersion, '2.0.0');
  assert.equal(listMarketplacePlugins(pluginsDir)[0].version, '2.0.0');
  assert.equal(listMarketplacePlugins(pluginsDir)[0].previousVersion, '1.0.0');
});

test('downgrade: snapshot bị sửa (chữ ký hỏng) → từ chối, bản đang chạy giữ nguyên', async () => {
  const { userDataDir, pluginsDir } = await installSignedFixture('1.0.0');
  const pair2 = generateMarketplaceSigningKeyPair('publisher v2');
  addTrustedMarketplaceKey(userDataDir, pair2.publicKey, 'publisher v2');
  const srcV2 = makePluginSource('2.0.0');
  signPluginBundle(srcV2, pair2.privateKey);
  approve(userDataDir, 'plugin-update', '2.0.0');
  await updatePluginFromSource(
    PLUGIN_ID,
    { kind: 'local', path: srcV2 },
    pluginsDir,
    { userDataDir },
  );
  // Tamper the v1 snapshot on disk (its signature must fail now).
  const snapshotIndex = path.join(
    userDataDir,
    'plugin-previous-versions',
    PLUGIN_ID,
    '1.0.0',
    'index.js',
  );
  assert.ok(fs.existsSync(snapshotIndex), 'snapshot must exist after update');
  fs.appendFileSync(snapshotIndex, '\n// tampered snapshot\n');
  assert.throws(
    () => downgradePlugin(PLUGIN_ID, pluginsDir, { userDataDir }),
    /invalid signature.*tampered backup|snapshot.*invalid signature/,
  );
  assert.equal(
    listMarketplacePlugins(pluginsDir)[0].version,
    '2.0.0',
    'the running version must be untouched by a refused downgrade',
  );
});

test('uninstall xoá cả snapshot: không còn downgrade được nữa', async () => {
  const { userDataDir, pluginsDir } = await installSignedFixture('1.0.0');
  const pair2 = generateMarketplaceSigningKeyPair('publisher v2');
  addTrustedMarketplaceKey(userDataDir, pair2.publicKey, 'publisher v2');
  const srcV2 = makePluginSource('2.0.0');
  signPluginBundle(srcV2, pair2.privateKey);
  approve(userDataDir, 'plugin-update', '2.0.0');
  await updatePluginFromSource(
    PLUGIN_ID,
    { kind: 'local', path: srcV2 },
    pluginsDir,
    { userDataDir },
  );
  assert.equal(getPluginDowngradeInfo(PLUGIN_ID, pluginsDir, { userDataDir }).canDowngrade, true);
  assert.equal(uninstallMarketplacePlugin(PLUGIN_ID, pluginsDir, { userDataDir }), true);
  assert.equal(
    fs.existsSync(path.join(userDataDir, 'plugin-previous-versions', PLUGIN_ID)),
    false,
    'snapshot must be removed with the plugin',
  );
  assert.equal(
    getPluginDowngradeInfo(PLUGIN_ID, pluginsDir, { userDataDir }).canDowngrade,
    false,
  );
});

// ---------------------------------------------------------------------------
// Bot start: verify-before-load + auto-rollback
// ---------------------------------------------------------------------------

test('bot start: bản mới bị sửa (verify fail) → auto-rollback về v1, tool chạy được', async () => {
  const { userDataDir, pluginsDir, markerFile } = await installSignedFixture('1.0.0');
  const pair2 = generateMarketplaceSigningKeyPair('publisher v2');
  addTrustedMarketplaceKey(userDataDir, pair2.publicKey, 'publisher v2');
  const srcV2 = makePluginSource('2.0.0');
  signPluginBundle(srcV2, pair2.privateKey);
  approve(userDataDir, 'plugin-update', '2.0.0');
  await updatePluginFromSource(
    PLUGIN_ID,
    { kind: 'local', path: srcV2 },
    pluginsDir,
    { userDataDir },
  );
  // Tamper the installed v2 WITHOUT re-signing: verification fails.
  fs.appendFileSync(path.join(pluginsDir, PLUGIN_ID, 'index.js'), '\n// tampered after install\n');
  fs.writeFileSync(markerFile, '', 'utf8');

  const manager = new PluginManager(pluginsDir);
  managers.push(manager);
  const result = await loadMarketplacePluginsAtStartup(manager, pluginsDir);
  assert.deepEqual(result.loadedIds, [PLUGIN_ID]);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.rolledBack.length, 1);
  assert.equal(result.rolledBack[0].id, PLUGIN_ID);
  assert.equal(result.rolledBack[0].fromVersion, '2.0.0');
  assert.equal(result.rolledBack[0].toVersion, '1.0.0');
  assert.match(result.rolledBack[0].reason, /signature is invalid/);
  assert.equal(listMarketplacePlugins(pluginsDir)[0].version, '1.0.0');

  const tool = manager.toolsForRegistry().find((t) => t.definition.name === TOOL_NAME);
  assert.ok(tool, 'rolled-back plugin tool must be in the registry');
  assert.equal(await tool.execute({ text: 'rollback' }, {}), 'v1.0.0:rollback');
});

test('bot start: bản mới lỗi LOAD (main hỏng, ký vẫn đúng) → auto-rollback về v1', async () => {
  const { userDataDir, pluginsDir, markerFile } = await installSignedFixture('1.0.0');
  const pair2 = generateMarketplaceSigningKeyPair('publisher v2');
  addTrustedMarketplaceKey(userDataDir, pair2.publicKey, 'publisher v2');
  const srcV2 = makePluginSource('2.0.0');
  signPluginBundle(srcV2, pair2.privateKey);
  approve(userDataDir, 'plugin-update', '2.0.0');
  await updatePluginFromSource(
    PLUGIN_ID,
    { kind: 'local', path: srcV2 },
    pluginsDir,
    { userDataDir },
  );
  // Break v2's entry AFTER install, then RE-SIGN it: the signature
  // is valid, but the code cannot load — the rollback must trigger on
  // the load failure, not on verification.
  const installedIndex = path.join(pluginsDir, PLUGIN_ID, 'index.js');
  fs.writeFileSync(installedIndex, 'module.exports = { tools: [; // broken\n', 'utf8');
  signPluginBundle(path.join(pluginsDir, PLUGIN_ID), pair2.privateKey);
  fs.writeFileSync(markerFile, '', 'utf8');

  const manager = new PluginManager(pluginsDir);
  managers.push(manager);
  const result = await loadMarketplacePluginsAtStartup(manager, pluginsDir);
  assert.deepEqual(result.loadedIds, [PLUGIN_ID]);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.rolledBack.length, 1);
  assert.equal(result.rolledBack[0].fromVersion, '2.0.0');
  assert.equal(result.rolledBack[0].toVersion, '1.0.0');
  const tool = manager.toolsForRegistry().find((t) => t.definition.name === TOOL_NAME);
  assert.equal(await tool.execute({ text: 'loadfail' }, {}), 'v1.0.0:loadfail');
});

test('bot start: plugin hỏng KHÔNG có bản trước → skipped, bot vẫn start (loadPlugins không throw)', async () => {
  const { pluginsDir } = await installSignedFixture('1.0.0');
  // Tamper the only installed version: no snapshot exists.
  fs.appendFileSync(path.join(pluginsDir, PLUGIN_ID, 'index.js'), '\n// tampered\n');
  const { tools } = await loadPlugins(pluginsDir);
  assert.deepEqual(
    tools.map((t) => t.definition.name),
    [],
    'the bad plugin contributes no tools, and bot start still succeeds',
  );
  const manager = new PluginManager(pluginsDir);
  managers.push(manager);
  const result = await loadMarketplacePluginsAtStartup(manager, pluginsDir);
  assert.deepEqual(result.loadedIds, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].id, PLUGIN_ID);
  assert.match(result.skipped[0].error, /signature is invalid/);
  assert.deepEqual(result.rolledBack, []);
});

test('loadPlugins: plugin marketplace đã ký load sandboxed, không in-process', async () => {
  const { pluginsDir, markerFile } = await installSignedFixture('1.0.0');
  const { tools } = await loadPlugins(pluginsDir);
  const names = tools.map((t) => t.definition.name);
  assert.ok(names.includes(TOOL_NAME), `expected ${TOOL_NAME} in [${names.join(', ')}]`);
  const pids = loadedPids(markerFile);
  assert.ok(pids.length >= 1, 'sandbox worker phải require plugin ít nhất 1 lần');
  assert.ok(
    pids.every((pid) => pid !== process.pid),
    `plugin không được require in-process (pids: ${pids.join(', ')}, test pid: ${process.pid})`,
  );
  const tool = tools.find((t) => t.definition.name === TOOL_NAME);
  assert.equal(await tool.execute({ text: 'xin chao' }, {}), 'v1.0.0:xin chao');
  assert.ok(readLogLines(markerFile).includes('called:xin chao'));
});

test('loadPlugins với sandboxed:false: plugin marketplace VẪN chỉ chạy sandboxed (không còn in-process)', async () => {
  const { pluginsDir, markerFile } = await installSignedFixture('1.0.0');
  const { tools } = await loadPlugins(pluginsDir, { sandboxed: false });
  const names = tools.map((t) => t.definition.name);
  assert.ok(names.includes(TOOL_NAME), `expected ${TOOL_NAME} in [${names.join(', ')}]`);
  // v0.93a behaviour change (see BEYOND-ROADMAP v0.93a): marketplace
  // plugins are EXCLUDED from the generic scan and load only after
  // signature verification, so the legacy in-process load no longer
  // happens at all — exactly one distinct pid, never the test pid
  // (v0.92a asserted >= 2 pids here: in-process + sandbox).
  const pids = [...new Set(loadedPids(markerFile))];
  assert.deepEqual(
    pids.filter((pid) => pid === process.pid),
    [],
    `no in-process load allowed (pids: ${pids.join(', ')}, test pid: ${process.pid})`,
  );
  assert.ok(pids.length >= 1, 'sandbox worker phải require plugin ít nhất 1 lần');
  const tool = tools.find((t) => t.definition.name === TOOL_NAME);
  assert.equal(await tool.execute({ text: 'sandbox' }, {}), 'v1.0.0:sandbox');
  assert.ok(readLogLines(markerFile).includes('called:sandbox'));
});
