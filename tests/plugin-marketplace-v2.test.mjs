/**
 * Tests for Marketplace v2 — plugin marketplace
 * (packages/tools/src/plugins/marketplace.ts).
 *
 * ALL tests here are MOCK / LOCAL-ONLY: plugins are built in temp
 * dirs, "remote" sources are rejected before any network (non-https /
 * non-.zip), and no credential is used anywhere. Nothing here is a
 * live test.
 *
 * Run after building the tools + core packages:
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/plugin-marketplace-v2.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  checkPluginUpdates,
  installPluginFromSource,
  installPreparedPlugin,
  listMarketplacePlugins,
  preparePluginFromSource,
  scanDirForSecrets,
  searchMarketplacePlugins,
  uninstallMarketplacePlugin,
  updatePluginFromSource,
  validatePluginMarketplaceEntry,
} from '../packages/tools/dist/plugins/marketplace.js';
import { recordMarketplaceApproval } from '../packages/core/dist/mcp/marketplaceApproval.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-plugin-mkt-v2-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

/** Build a minimal loadable plugin folder in a temp dir. */
function makePluginFixture(id, version, extraFiles = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `open-bot-plugin-fixture-${id}-`));
  tempDirs.push(dir);
  const manifest = {
    id,
    name: `Test Plugin ${id}`,
    version,
    description: `A test plugin (${id}).`,
    permissions: [],
    main: 'index.js',
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    `module.exports = { tools: [{ definition: { name: '${id}_echo', description: 'Echo.', parameters: { type: 'object', properties: {} } }, needsApproval: false, execute: async (args) => 'hi' }] };\n`,
    'utf8',
  );
  for (const [name, content] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

function approve(userDataDir, kind, targetId, version) {
  return recordMarketplaceApproval(userDataDir, { kind, targetId, version, source: 'local' });
}

// ---------------------------------------------------------------------------
// Entry validation
// ---------------------------------------------------------------------------

test('validatePluginMarketplaceEntry: good entry passes, bad shapes throw', () => {
  const entry = validatePluginMarketplaceEntry({
    id: 'my-plugin',
    name: 'My Plugin',
    description: 'Does things.',
    version: '1.2.0',
    source: { kind: 'url', url: 'https://example.com/my-plugin.zip' },
  });
  assert.equal(entry.id, 'my-plugin');
  assert.equal(entry.source.kind, 'url');

  assert.throws(
    () => validatePluginMarketplaceEntry({ id: 'x', name: 'X', description: 'd', version: 'banana', source: { kind: 'local', path: '/tmp' } }),
    /must have a "version" that is a semver/,
  );
  assert.throws(
    () => validatePluginMarketplaceEntry({ id: 'x', name: 'X', description: 'd', version: '1.0.0', source: { kind: 'url', url: 'http://example.com/p.zip' } }),
    /must use https/,
  );
  assert.throws(
    () => validatePluginMarketplaceEntry({ id: 'x', name: 'X', description: 'd', version: '1.0.0', source: { kind: 'carrier-pigeon' } }),
    /"source.kind" must be/,
  );
  assert.throws(
    () => validatePluginMarketplaceEntry({ id: 'bad id!', name: 'X', description: 'd', version: '1.0.0', source: { kind: 'local', path: '/tmp' } }),
    /invalid "id"/,
  );
});

// ---------------------------------------------------------------------------
// Secret scan
// ---------------------------------------------------------------------------

test('scanDirForSecrets: finds embedded secrets, never returns the value', () => {
  const dir = makePluginFixture('secret-plugin', '1.0.0', {
    'leak.js': `const api_key = "12345678abcdefgh";\nmodule.exports = {};\n`,
    'key.pem': '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n',
    'clean.js': 'module.exports = { tools: [] };\n',
  });
  const findings = scanDirForSecrets(dir);
  const patterns = findings.map((f) => f.pattern).sort();
  assert.ok(patterns.includes('api-key-assignment'), `expected api-key finding, got ${patterns}`);
  assert.ok(patterns.includes('private-key-block'), `expected private-key finding, got ${patterns}`);
  // No finding may contain the secret value itself.
  for (const finding of findings) {
    assert.ok(!JSON.stringify(finding).includes('12345678abcdefgh'));
    assert.ok(!JSON.stringify(finding).includes('MIIEowIBAAKCAQEA'));
  }
  assert.ok(findings.every((f) => f.file === 'leak.js' || f.file === 'key.pem'));
});

test('scanDirForSecrets: clean plugin has no findings', () => {
  const dir = makePluginFixture('clean-plugin', '1.0.0');
  assert.deepEqual(scanDirForSecrets(dir), []);
});

// ---------------------------------------------------------------------------
// Prepare + install (local source)
// ---------------------------------------------------------------------------

test('preparePluginFromSource (local): reads the manifest, rejects a folder without one', async () => {
  const src = makePluginFixture('prep-plugin', '1.0.0');
  const prepared = await preparePluginFromSource({ kind: 'local', path: src });
  assert.equal(prepared.manifest.id, 'prep-plugin');
  assert.equal(prepared.manifest.version, '1.0.0');
  assert.equal(prepared.tempDir, false);

  const empty = makeTempDir();
  await assert.rejects(
    preparePluginFromSource({ kind: 'local', path: empty }),
    /has no manifest\.json/,
  );
});

test('preparePluginFromSource (url/git): non-https and non-zip sources are refused before any network', async () => {
  await assert.rejects(
    preparePluginFromSource({ kind: 'url', url: 'http://example.com/p.zip' }),
    /must use https/,
  );
  await assert.rejects(
    preparePluginFromSource({ kind: 'url', url: 'https://example.com/plugin.tar.gz' }),
    /must point to a \.zip bundle/,
  );
  await assert.rejects(
    preparePluginFromSource({ kind: 'git', url: 'http://example.com/repo.git' }),
    /must use https/,
  );
  await assert.rejects(
    preparePluginFromSource({ kind: 'smoke-signal', url: 'https://example.com/x' }),
    /must be "local", "url" or "git"/,
  );
});

test('installPreparedPlugin: approval is REQUIRED before anything is installed', async () => {
  const userDataDir = makeTempDir();
  const pluginsDir = path.join(userDataDir, 'plugins');
  const src = makePluginFixture('needs-approval', '1.0.0');
  const prepared = await preparePluginFromSource({ kind: 'local', path: src });

  assert.throws(
    () => installPreparedPlugin(prepared, pluginsDir),
    /needs user approval first/,
  );
  assert.equal(fs.existsSync(path.join(pluginsDir, 'needs-approval')), false);

  approve(userDataDir, 'plugin-install', 'needs-approval', '1.0.0');
  const result = installPreparedPlugin(prepared, pluginsDir, { userDataDir });
  assert.equal(result.version, '1.0.0');
  assert.equal(result.sandboxed, true);
  assert.equal(result.info.manifest.id, 'needs-approval');
  assert.ok(fs.existsSync(path.join(pluginsDir, 'needs-approval', 'manifest.json')));
  // The marketplace record was written next to the plugin.
  const record = JSON.parse(
    fs.readFileSync(path.join(pluginsDir, 'marketplace-installed.json'), 'utf8'),
  );
  assert.equal(record['needs-approval'].version, '1.0.0');
  assert.equal(record['needs-approval'].sandboxed, true);
});

test('installPreparedPlugin: a version-pinned approval does not authorize another version', async () => {
  const userDataDir = makeTempDir();
  const pluginsDir = path.join(userDataDir, 'plugins');
  const src = makePluginFixture('pinned-plugin', '2.0.0');
  const prepared = await preparePluginFromSource({ kind: 'local', path: src });
  approve(userDataDir, 'plugin-install', 'pinned-plugin', '1.0.0');
  assert.throws(
    () => installPreparedPlugin(prepared, pluginsDir, { userDataDir }),
    /needs user approval first/,
  );
});

test('installPluginFromSource (local): secret scan blocks the install', async () => {
  const userDataDir = makeTempDir();
  const pluginsDir = path.join(userDataDir, 'plugins');
  const src = makePluginFixture('leaky-plugin', '1.0.0', {
    'leak.js': `const api_key = "12345678abcdefgh";\n`,
  });
  approve(userDataDir, 'plugin-install', 'leaky-plugin', '1.0.0');
  await assert.rejects(
    installPluginFromSource({ kind: 'local', path: src }, pluginsDir, { userDataDir }),
    /secret scan found embedded secret/,
  );
  assert.equal(fs.existsSync(path.join(pluginsDir, 'leaky-plugin')), false);
});

// ---------------------------------------------------------------------------
// List / search / updates / uninstall
// ---------------------------------------------------------------------------

test('list + search + checkPluginUpdates + update + uninstall (local sources)', async () => {
  const userDataDir = makeTempDir();
  const pluginsDir = path.join(userDataDir, 'plugins');

  const srcV1 = makePluginFixture('updatable-plugin', '1.0.0');
  approve(userDataDir, 'plugin-install', 'updatable-plugin', '1.0.0');
  await installPluginFromSource({ kind: 'local', path: srcV1 }, pluginsDir, { userDataDir });

  const listed = listMarketplacePlugins(pluginsDir);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].manifest.id, 'updatable-plugin');
  assert.equal(listed[0].version, '1.0.0');
  assert.equal(listed[0].sandboxed, true);
  assert.equal(searchMarketplacePlugins(listed, 'updatable').length, 1);
  assert.equal(searchMarketplacePlugins(listed, 'nothing-matches').length, 0);

  // No update when the catalog has the same version.
  const noUpdate = checkPluginUpdates(
    [{ id: 'updatable-plugin', name: 'Updatable', description: 'd', version: '1.0.0', source: { kind: 'local', path: srcV1 } }],
    pluginsDir,
  );
  assert.equal(noUpdate[0].updateAvailable, false);

  // A newer catalog entry is an update; an incompatible one is flagged.
  const withUpdate = checkPluginUpdates(
    [{ id: 'updatable-plugin', name: 'Updatable', description: 'd', version: '1.1.0', changelog: 'Bug fixes.', minAppVersion: '0.89.0', source: { kind: 'local', path: srcV1 } }],
    pluginsDir,
    '0.89.0',
  );
  assert.equal(withUpdate[0].updateAvailable, true);
  assert.equal(withUpdate[0].latestVersion, '1.1.0');
  assert.equal(withUpdate[0].compatible, true);
  const incompatible = checkPluginUpdates(
    [{ id: 'updatable-plugin', name: 'Updatable', description: 'd', version: '2.0.0', minAppVersion: '99.0.0', source: { kind: 'local', path: srcV1 } }],
    pluginsDir,
    '0.89.0',
  );
  assert.equal(incompatible[0].compatible, false);

  // Update needs its own 'plugin-update' approval (install approval is not enough).
  const srcV2 = makePluginFixture('updatable-plugin', '1.1.0');
  await assert.rejects(
    updatePluginFromSource('updatable-plugin', { kind: 'local', path: srcV2 }, pluginsDir, { userDataDir }),
    /needs user approval first/,
  );
  approve(userDataDir, 'plugin-update', 'updatable-plugin', '1.1.0');
  const updated = await updatePluginFromSource(
    'updatable-plugin',
    { kind: 'local', path: srcV2 },
    pluginsDir,
    { userDataDir },
  );
  assert.equal(updated.version, '1.1.0');
  assert.equal(listMarketplacePlugins(pluginsDir)[0].version, '1.1.0');

  // Updating again to the same version is refused (already up to date).
  await assert.rejects(
    updatePluginFromSource('updatable-plugin', { kind: 'local', path: srcV2 }, pluginsDir, { userDataDir }),
    /already up to date/,
  );

  assert.equal(uninstallMarketplacePlugin('updatable-plugin', pluginsDir), true);
  assert.equal(listMarketplacePlugins(pluginsDir).length, 0);
  assert.equal(fs.existsSync(path.join(pluginsDir, 'updatable-plugin')), false);
  assert.equal(uninstallMarketplacePlugin('updatable-plugin', pluginsDir), false);
});
