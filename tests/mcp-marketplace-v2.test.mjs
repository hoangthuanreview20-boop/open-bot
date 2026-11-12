/**
 * Tests for Marketplace v2 — MCP versions + remote catalog + approvals
 * (packages/core/src/mcp/marketplaceVersions.ts,
 * marketplaceRemote.ts, marketplaceApproval.ts).
 *
 * ALL tests here are MOCK / LOCAL-ONLY: the "remote catalog" is a mock
 * fetch function returning canned JSON (no network), installs write
 * into temp dirs (no real workspace), and no credential is used
 * anywhere. Nothing here is a live test.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/mcp-marketplace-v2.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  checkForUpdates,
  compareVersions,
  getInstalledVersion,
  installVersion,
  isNewerVersion,
  isValidVersion,
  loadVersionedRegistry,
  parseVersion,
  satisfiesMinAppVersion,
  searchMarketplaceServers,
  updateInstalled,
} from '../packages/core/dist/mcp/marketplaceVersions.js';
import {
  fetchRemoteMarketplaceCatalog,
  loadRemoteCatalogHosts,
  mergeCatalogs,
  parseRemoteCatalog,
} from '../packages/core/dist/mcp/marketplaceRemote.js';
import {
  hasMarketplaceApproval,
  recordMarketplaceApproval,
  requireMarketplaceApproval,
} from '../packages/core/dist/mcp/marketplaceApproval.js';
import { install as installV03 } from '../packages/core/dist/mcp/marketplace.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-mkt-v2-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function registryPath(baseDir) {
  return path.join(baseDir, 'marketplace', 'mcp-servers.json');
}

/** Seed the registry, then stamp version fields onto chosen entries. */
function seedRegistryWithVersions(baseDir, versions) {
  loadVersionedRegistry(baseDir); // seeds the 8 built-ins
  const raw = JSON.parse(fs.readFileSync(registryPath(baseDir), 'utf8'));
  for (const server of raw.servers) {
    if (versions[server.id]) Object.assign(server, versions[server.id]);
  }
  fs.writeFileSync(registryPath(baseDir), JSON.stringify({ servers: raw.servers }, null, 2) + '\n', 'utf8');
}

function readMcpJson(workspaceDir) {
  return JSON.parse(
    fs.readFileSync(path.join(workspaceDir, '.open-bot', 'mcp.json'), 'utf8'),
  );
}

// ---------------------------------------------------------------------------
// Version parse / compare
// ---------------------------------------------------------------------------

test('parseVersion/compareVersions: semver ordering incl. pre-release', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.equal(compareVersions('1.0.0', '2.0.0'), -1);
  assert.equal(compareVersions('2.0.0', '1.0.0'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2'), -1);
  assert.equal(compareVersions('1.0.0+build.1', '1.0.0'), 0); // build ignored
  assert.equal(isNewerVersion('1.2.0', '1.1.9'), true);
  assert.equal(isNewerVersion('1.0.0', '1.0.0'), false);
  assert.equal(isValidVersion('1.2.3'), true);
  assert.equal(isValidVersion('1.2'), false);
  assert.equal(isValidVersion('v1.2.3'), false);
  assert.throws(() => parseVersion('1.2'), /semver/);
  assert.throws(() => parseVersion('banana'), /semver/);
});

test('satisfiesMinAppVersion: absent minimum is always satisfied', () => {
  assert.equal(satisfiesMinAppVersion(undefined, '0.1.0'), true);
  assert.equal(satisfiesMinAppVersion('1.0.0', undefined), true);
  assert.equal(satisfiesMinAppVersion('1.0.0', '1.0.0'), true);
  assert.equal(satisfiesMinAppVersion('2.0.0', '1.9.9'), false);
});

// ---------------------------------------------------------------------------
// Versioned registry + installVersion
// ---------------------------------------------------------------------------

test('loadVersionedRegistry: version/changelog/minAppVersion survive, missing version is 0.0.0', () => {
  const baseDir = makeTempDir();
  seedRegistryWithVersions(baseDir, {
    filesystem: { version: '1.2.0', changelog: 'Faster listing.', minAppVersion: '0.80.0' },
  });
  const servers = loadVersionedRegistry(baseDir);
  const fsEntry = servers.find((s) => s.id === 'filesystem');
  assert.equal(fsEntry.version, '1.2.0');
  assert.equal(fsEntry.changelog, 'Faster listing.');
  assert.equal(fsEntry.minAppVersion, '0.80.0');
  const memory = servers.find((s) => s.id === 'memory');
  assert.equal(memory.version, '0.0.0');
});

test('loadVersionedRegistry: bad version string is rejected', () => {
  const baseDir = makeTempDir();
  // seedRegistryWithVersions chỉ ghi JSON thô (không validate) —
  // validation nằm ở loadVersionedRegistry, đó mới là chỗ phải throw.
  seedRegistryWithVersions(baseDir, { filesystem: { version: 'banana' } });
  assert.throws(() => loadVersionedRegistry(baseDir), /"version" must be a semver/);
});

test('installVersion: installs latest, stamps mcp.json + sidecar record', () => {
  const baseDir = makeTempDir();
  const workspaceDir = makeTempDir();
  seedRegistryWithVersions(baseDir, { filesystem: { version: '1.2.0', changelog: 'Faster.' } });
  const result = installVersion('filesystem', workspaceDir, undefined, { baseDir });
  assert.equal(result.version, '1.2.0');
  assert.equal(result.config.name, 'filesystem');
  const mcpJson = readMcpJson(workspaceDir);
  assert.equal(mcpJson.servers.filesystem.marketplaceVersion, '1.2.0');
  assert.equal(getInstalledVersion('filesystem', workspaceDir, baseDir), '1.2.0');
  const sidecar = JSON.parse(
    fs.readFileSync(path.join(baseDir, 'marketplace', 'mcp-installed.json'), 'utf8'),
  );
  assert.equal(sidecar.filesystem.version, '1.2.0');
});

test('installVersion: a specific version must equal the catalogued version', () => {
  const baseDir = makeTempDir();
  const workspaceDir = makeTempDir();
  seedRegistryWithVersions(baseDir, { memory: { version: '2.0.0' } });
  const ok = installVersion('memory', workspaceDir, '2.0.0', { baseDir });
  assert.equal(ok.version, '2.0.0');
  const workspace2 = makeTempDir();
  assert.throws(
    () => installVersion('memory', workspace2, '1.0.0', { baseDir }),
    /version 1\.0\.0 is not available — the catalogue has version 2\.0\.0/,
  );
});

test('installVersion: minAppVersion newer than the app is refused', () => {
  const baseDir = makeTempDir();
  const workspaceDir = makeTempDir();
  seedRegistryWithVersions(baseDir, { fetch: { version: '3.0.0', minAppVersion: '99.0.0' } });
  assert.throws(
    () => installVersion('fetch', workspaceDir, undefined, { baseDir, appVersion: '0.89.0' }),
    /needs app version 99\.0\.0/,
  );
});

test('installVersion: installing twice is refused', () => {
  const baseDir = makeTempDir();
  const workspaceDir = makeTempDir();
  seedRegistryWithVersions(baseDir, { git: { version: '1.0.0' } });
  installVersion('git', workspaceDir, undefined, { baseDir });
  assert.throws(
    () => installVersion('git', workspaceDir, undefined, { baseDir }),
    /already installed/,
  );
});

// ---------------------------------------------------------------------------
// checkForUpdates / updateInstalled
// ---------------------------------------------------------------------------

test('checkForUpdates + updateInstalled: newer version found, env preserved on update', () => {
  const baseDir = makeTempDir();
  const workspaceDir = makeTempDir();
  seedRegistryWithVersions(baseDir, { 'brave-search': { version: '1.0.0' } });
  installVersion('brave-search', workspaceDir, undefined, { baseDir });
  // The user filled in the credential by hand after install.
  const mcpJson = readMcpJson(workspaceDir);
  mcpJson.servers['brave-search'].env = { BRAVE_API_KEY: 'user-filled-key' };
  fs.writeFileSync(
    path.join(workspaceDir, '.open-bot', 'mcp.json'),
    JSON.stringify(mcpJson, null, 2) + '\n',
    'utf8',
  );
  // A newer catalogued version appears.
  seedRegistryWithVersions(baseDir, {
    'brave-search': { version: '1.1.0', changelog: 'New search operators.' },
  });
  const updates = checkForUpdates(workspaceDir, { baseDir });
  const brave = updates.find((u) => u.id === 'brave-search');
  assert.equal(brave.installedVersion, '1.0.0');
  assert.equal(brave.latestVersion, '1.1.0');
  assert.equal(brave.updateAvailable, true);
  assert.equal(brave.changelog, 'New search operators.');
  assert.equal(brave.compatible, true);

  const updated = updateInstalled('brave-search', workspaceDir, { baseDir });
  assert.equal(updated.fromVersion, '1.0.0');
  assert.equal(updated.toVersion, '1.1.0');
  assert.equal(getInstalledVersion('brave-search', workspaceDir, baseDir), '1.1.0');
  // The hand-filled env survived the update (uninstall+reinstall would lose it).
  assert.equal(readMcpJson(workspaceDir).servers['brave-search'].env.BRAVE_API_KEY, 'user-filled-key');
  assert.equal(readMcpJson(workspaceDir).servers['brave-search'].marketplaceVersion, '1.1.0');
  // Second update: already up to date.
  assert.throws(() => updateInstalled('brave-search', workspaceDir, { baseDir }), /already up to date/);
});

test('checkForUpdates: no recorded version means no proven update', () => {
  const baseDir = makeTempDir();
  const workspaceDir = makeTempDir();
  seedRegistryWithVersions(baseDir, { sqlite: { version: '5.0.0' } });
  // Install WITHOUT the versioned path (plain v0.3 install): no sidecar record.
  installV03('sqlite', workspaceDir, undefined, baseDir);
  const updates = checkForUpdates(workspaceDir, { baseDir });
  const row = updates.find((u) => u.id === 'sqlite');
  assert.equal(row.installedVersion, 'unknown');
  assert.equal(row.updateAvailable, false);
});

test('checkForUpdates: incompatible latest version is flagged, update refused', () => {
  const baseDir = makeTempDir();
  const workspaceDir = makeTempDir();
  seedRegistryWithVersions(baseDir, { memory: { version: '1.0.0' } });
  installVersion('memory', workspaceDir, undefined, { baseDir });
  seedRegistryWithVersions(baseDir, { memory: { version: '2.0.0', minAppVersion: '99.0.0' } });
  const updates = checkForUpdates(workspaceDir, { baseDir, appVersion: '0.89.0' });
  const row = updates.find((u) => u.id === 'memory');
  assert.equal(row.updateAvailable, true);
  assert.equal(row.compatible, false);
  assert.throws(
    () => updateInstalled('memory', workspaceDir, { baseDir, appVersion: '0.89.0' }),
    /needs app version 99\.0\.0/,
  );
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

test('searchMarketplaceServers: diacritic-insensitive, token AND, tag filter', () => {
  const baseDir = makeTempDir();
  const servers = loadVersionedRegistry(baseDir);
  assert.equal(searchMarketplaceServers(servers, 'tim kiem', 'all').length, 0);
  const byName = searchMarketplaceServers(servers, 'filesystem', 'all');
  assert.equal(byName.length, 1);
  assert.equal(byName[0].id, 'filesystem');
  const byTag = searchMarketplaceServers(servers, '', 'database');
  assert.ok(byTag.length >= 2);
  assert.ok(byTag.every((s) => s.tags.includes('database')));
  const none = searchMarketplaceServers(servers, 'filesystem', 'database');
  assert.equal(none.length, 0);
});

// ---------------------------------------------------------------------------
// Remote catalog (MOCK fetch — no network)
// ---------------------------------------------------------------------------

const REMOTE_URL = 'https://catalog.example.com/mcp.json';

function mockFetchJson(body, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

test('parseRemoteCatalog: valid catalog parses; bad shapes are rejected', () => {
  const good = parseRemoteCatalog(
    JSON.stringify({
      servers: [
        {
          id: 'fetch',
          name: 'Fetch',
          description: 'Fetch web pages.',
          version: '2.0.0',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-fetch'],
          tags: ['web'],
        },
      ],
    }),
    REMOTE_URL,
  );
  assert.equal(good.length, 1);
  assert.equal(good[0].version, '2.0.0');
  assert.equal(good[0].source, 'remote');

  // Missing version.
  assert.throws(
    () =>
      parseRemoteCatalog(
        JSON.stringify({
          servers: [{ id: 'x', name: 'X', description: 'd', transport: 'stdio', command: 'npx' }],
        }),
        REMOTE_URL,
      ),
    /must have a "version" that is a semver/,
  );
  // http URL for an http server.
  assert.throws(
    () =>
      parseRemoteCatalog(
        JSON.stringify({
          servers: [
            { id: 'x', name: 'X', description: 'd', version: '1.0.0', transport: 'http', url: 'http://evil.example.com/mcp' },
          ],
        }),
        REMOTE_URL,
      ),
    /must be https:\/\//,
  );
  // Credentials smuggled in via env.
  assert.throws(
    () =>
      parseRemoteCatalog(
        JSON.stringify({
          servers: [
            { id: 'x', name: 'X', description: 'd', version: '1.0.0', transport: 'stdio', command: 'npx', env: { KEY: 'sekrit' } },
          ],
        }),
        REMOTE_URL,
      ),
    /must not carry "env" or "headers"/,
  );
  // Duplicate id.
  assert.throws(
    () =>
      parseRemoteCatalog(
        JSON.stringify({
          servers: [
            { id: 'x', name: 'X', description: 'd', version: '1.0.0', transport: 'stdio', command: 'npx' },
            { id: 'x', name: 'X2', description: 'd2', version: '1.0.1', transport: 'stdio', command: 'npx' },
          ],
        }),
        REMOTE_URL,
      ),
    /duplicate server id/,
  );
  // Top level is not an object/array.
  assert.throws(() => parseRemoteCatalog('{"nope": true}', REMOTE_URL), /bad shape/);
  assert.throws(() => parseRemoteCatalog('not json', REMOTE_URL), /not valid JSON/);
});

test('fetchRemoteMarketplaceCatalog (mock): allowlist enforced, http refused, non-2xx refused', async () => {
  const body = {
    servers: [
      { id: 'fetch', name: 'Fetch', description: 'Fetch.', version: '2.0.0', transport: 'stdio', command: 'npx', args: ['-y', 'server-fetch'] },
    ],
  };
  const fetchFn = mockFetchJson(body);
  // Allowlisted host: ok (also proves the second export path works).
  const ok = await fetchRemoteMarketplaceCatalog(REMOTE_URL, {
    allowedHosts: ['catalog.example.com'],
    fetchFn,
  });
  assert.equal(ok.length, 1);
  assert.equal(ok[0].id, 'fetch');

  // Host not on the allowlist: refused before any fetch happens.
  let fetched = false;
  const countingFetch = async (...args) => {
    fetched = true;
    return fetchFn(...args);
  };
  await assert.rejects(
    fetchRemoteMarketplaceCatalog(REMOTE_URL, { allowedHosts: ['other.example.com'], fetchFn: countingFetch }),
    /not allowlisted/,
  );
  assert.equal(fetched, false);

  // No allowlist configured at all: refused.
  await assert.rejects(
    fetchRemoteMarketplaceCatalog(REMOTE_URL, { allowedHosts: [], fetchFn }),
    /not allowlisted/,
  );

  // Plain http catalog URL: refused.
  await assert.rejects(
    fetchRemoteMarketplaceCatalog('http://catalog.example.com/mcp.json', {
      allowedHosts: ['catalog.example.com'],
      fetchFn,
    }),
    /must use https/,
  );

  // Non-2xx: refused with the status, body never parsed.
  await assert.rejects(
    fetchRemoteMarketplaceCatalog(REMOTE_URL, {
      allowedHosts: ['catalog.example.com'],
      fetchFn: mockFetchJson({ error: 'nope' }, 404),
    }),
    /HTTP 404/,
  );

  // Timeout: a fetch that never settles is aborted (mock honours the signal).
  const hangingFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  await assert.rejects(
    fetchRemoteMarketplaceCatalog(REMOTE_URL, {
      allowedHosts: ['catalog.example.com'],
      fetchFn: hangingFetch,
      timeoutMs: 10,
    }),
    /timed out after 10ms/,
  );
});

test('loadRemoteCatalogHosts: missing file means empty allowlist', () => {
  const baseDir = makeTempDir();
  assert.deepEqual(loadRemoteCatalogHosts(baseDir), []);
  fs.mkdirSync(path.join(baseDir, 'marketplace'), { recursive: true });
  fs.writeFileSync(
    path.join(baseDir, 'marketplace', 'remote-hosts.json'),
    JSON.stringify({ hosts: ['Catalog.Example.COM', '*.trusted.example.com'] }),
    'utf8',
  );
  assert.deepEqual(loadRemoteCatalogHosts(baseDir), [
    'catalog.example.com',
    '*.trusted.example.com',
  ]);
});

test('mergeCatalogs: remote wins on id collision, local-only entries kept', () => {
  const baseDir = makeTempDir();
  const local = loadVersionedRegistry(baseDir);
  const remote = [
    { ...local.find((s) => s.id === 'fetch'), version: '9.9.9', source: 'remote', catalogUrl: REMOTE_URL },
  ];
  const merged = mergeCatalogs(local, remote);
  assert.equal(merged.find((s) => s.id === 'fetch').version, '9.9.9');
  assert.equal(merged.find((s) => s.id === 'fetch').source, 'remote');
  assert.equal(merged.length, local.length);
});

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

test('marketplace approvals: record → has → require; version pinning is enforced', () => {
  const baseDir = makeTempDir();
  assert.equal(hasMarketplaceApproval(baseDir, 'mcp-install', 'filesystem'), false);
  assert.equal(hasMarketplaceApproval(baseDir, 'mcp-install', 'filesystem'), false);
  assert.throws(
    () => requireMarketplaceApproval(baseDir, 'mcp-install', 'filesystem'),
    /needs user approval first/,
  );
  assert.throws(
    () => requireMarketplaceApproval(baseDir, 'mcp-install', 'filesystem'),
    /needs user approval first/,
  );

  const decision = recordMarketplaceApproval(baseDir, {
    kind: 'mcp-install',
    targetId: 'filesystem',
    version: '1.2.0',
    source: 'local',
  });
  assert.equal(decision.kind, 'mcp-install');
  assert.equal(decision.targetId, 'filesystem');
  assert.equal(decision.version, '1.2.0');
  assert.ok(decision.id);
  assert.ok(decision.decidedAt);

  assert.equal(hasMarketplaceApproval(baseDir, 'mcp-install', 'filesystem', '1.2.0'), true);
  // A version-pinned decision does NOT authorize a different version…
  assert.equal(hasMarketplaceApproval(baseDir, 'mcp-install', 'filesystem', '2.0.0'), false);
  // …nor a different kind.
  assert.equal(hasMarketplaceApproval(baseDir, 'mcp-update', 'filesystem', '1.2.0'), false);
  requireMarketplaceApproval(baseDir, 'mcp-install', 'filesystem', '1.2.0'); // no throw
  assert.throws(
    () => requireMarketplaceApproval(baseDir, 'mcp-install', 'filesystem', '2.0.0'),
    /needs user approval first/,
  );

  // An unpinned decision authorizes any version.
  const decision2 = recordMarketplaceApproval(baseDir, { kind: 'plugin-install', targetId: 'my-plugin' });
  assert.equal(decision2.version, undefined);
  assert.equal(hasMarketplaceApproval(baseDir, 'plugin-install', 'my-plugin', '9.9.9'), true);

  // The decisions survive a re-read from disk.
  const again = JSON.parse(
    fs.readFileSync(path.join(baseDir, 'marketplace', 'approvals.json'), 'utf8'),
  );
  assert.equal(again.decisions.length, 2);
});
