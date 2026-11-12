/**
 * Tests for v0.69b — MCP marketplace: HTTP probe, more real variants.
 *
 * Extends the v0.68a fake HTTP server
 * (tests/mcp-marketplace-probe-fake-http-server.mjs) with new modes:
 *   auth           401 unless `Authorization: Bearer <token>` (the
 *                  probe never sends one, so it always gets the 401)
 *   http500        every POST → HTTP 500 with a JSON error body
 *   http404        every POST → HTTP 404 with an HTML body
 *   bad-json       every POST → HTTP 200 with a non-JSON plain-text body
 *   record-headers like ok, but logs every POST's JSON-RPC method +
 *                  headers to a file, so tests can assert exactly
 *                  which headers the client sends by default.
 *
 * Covered here (all local, 127.0.0.1 only, no real keys):
 *  (a) Bearer-required server → fail-closed 'error' with a clear
 *      "requires authentication (HTTP 401)" message, never cached.
 *  (b) HTTP 500 / 404 → fail-closed 'error', never cached: after the
 *      server recovers (same URL, same registry, same fingerprint)
 *      a fresh probe returns 'ok' — the error never poisoned the cache.
 *  (c) Non-JSON-MCP body (404 HTML, 200 plain text) → clear error,
 *      no crash, and the error never leaks the response body.
 *  (d) Default headers, recorded live: no Authorization, Content-Type
 *      application/json, Accept application/json + text/event-stream,
 *      and Mcp-Session-Id on the calls after initialize.
 *  (e) Cache invalidation via a non-disk registry path: there is NO
 *      UI/code path that edits `marketplace/mcp-servers.json` — the
 *      only marketplace mutation the UI offers (install/uninstall via
 *      IPC `mcp-marketplace:install`/`uninstall`) writes the bot
 *      workspace's `.open-bot/mcp.json`, not the registry — so this
 *      test proves install/uninstall leaves the fingerprint and the
 *      cached probe untouched, while a registry edit that flips
 *      `needsKey` changes the fingerprint, misses the stale cache,
 *      and the probe returns the new status.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/mcp-marketplace-probe-http-v069b.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getMarketplaceRegistryFingerprint,
  install as installMcpServer,
  MarketplaceProbeCache,
  probeMarketplaceServerTools,
  uninstall as uninstallMcpServer,
} from '../packages/core/dist/mcp/marketplace.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_HTTP_SERVER = path.join(here, 'mcp-marketplace-probe-fake-http-server.mjs');

const tempDirs = [];
const httpServers = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-mkt-probe-http-v069b-'));
  tempDirs.push(dir);
  return dir;
}

/** Start one fake HTTP MCP server; resolves with its localhost port. */
function startFakeHttp(mode, port = 0, arg4) {
  return new Promise((resolve, reject) => {
    const args = [FAKE_HTTP_SERVER, mode, String(port)];
    if (arg4 !== undefined) args.push(arg4);
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    httpServers.push(child);
    let buffer = '';
    let stderr = '';
    const timer = setTimeout(
      () => reject(new Error(`fake HTTP MCP server (${mode}) did not print READY in 10s`)),
      10_000,
    );
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const m = buffer.match(/READY (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]) });
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!buffer.includes('READY')) {
        reject(
          new Error(
            `fake HTTP MCP server (${mode}) exited early (code ${code}): ${stderr.trim()}`,
          ),
        );
      }
    });
  });
}

/** Start a server on one fixed port, retrying briefly if the previous
 *  server on that port has not released it yet. */
async function startFakeHttpOnPort(mode, port, attempts = 5) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await startFakeHttp(mode, port);
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const done = () => resolve();
    child.once('exit', done);
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve();
    }, 3000).unref?.();
  });
}

afterEach(async () => {
  while (httpServers.length > 0) {
    await stopServer(httpServers.pop());
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function httpEntry(id, port) {
  return {
    id,
    name: `Fake HTTP ${id}`,
    description: 'Fake MCP server over streamable HTTP (probe test).',
    transport: 'http',
    url: `http://127.0.0.1:${port}/mcp`,
    tags: ['test'],
  };
}

/** Base dir whose registry file holds exactly the given entries. */
function baseDirWith(...entries) {
  const base = makeTempDir();
  fs.mkdirSync(path.join(base, 'marketplace'), { recursive: true });
  fs.writeFileSync(
    path.join(base, 'marketplace', 'mcp-servers.json'),
    JSON.stringify({ servers: entries }, null, 2),
    'utf8',
  );
  return base;
}

function writeRegistry(base, entries, indent = 2) {
  fs.writeFileSync(
    path.join(base, 'marketplace', 'mcp-servers.json'),
    JSON.stringify({ servers: entries }, null, indent) + '\n',
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// (a) Bearer-required server → fail-closed, clear auth message, not cached
// ---------------------------------------------------------------------------

test('probe http: server requiring Bearer auth fails closed, says so, is not cached', async () => {
  // Token is a fake test value; the probe never sends it (no
  // config.headers, no authProvider), so the server must answer 401.
  const { port } = await startFakeHttp('auth', 0, 'test-bearer-token');
  const base = baseDirWith(httpEntry('fake-http-auth', port));
  const result = await probeMarketplaceServerTools('fake-http-auth', base);
  assert.equal(result.serverId, 'fake-http-auth');
  assert.equal(result.status, 'error');
  assert.deepEqual(result.tools, []);
  assert.match(result.error, /requires authentication/i);
  assert.match(result.error, /401/);
  assert.doesNotMatch(result.error, /test-bearer-token/, 'error must never echo a credential');
  // An error result is never stored: the cache stays empty, so a later
  // retry (after the user configures the credential) is not blocked.
  const cache = new MarketplaceProbeCache();
  assert.equal(cache.set('fake-http-auth', 'fp1', result), false);
  assert.equal(cache.get('fake-http-auth', 'fp1'), undefined);
  assert.equal(cache.size, 0);
});

// ---------------------------------------------------------------------------
// (b) HTTP 500 → fail-closed, not cached; recovery re-probes to ok
// ---------------------------------------------------------------------------

test('probe http: HTTP 500 fails closed and is not cached — probe after recovery is ok', async () => {
  const failing = await startFakeHttp('http500');
  const port = failing.port;
  const base = baseDirWith(httpEntry('fake-http-500', port));
  const fingerprint = getMarketplaceRegistryFingerprint(base);
  assert.equal(typeof fingerprint, 'string');

  const cache = new MarketplaceProbeCache();
  const failed = await probeMarketplaceServerTools('fake-http-500', base);
  assert.equal(failed.status, 'error');
  assert.deepEqual(failed.tools, []);
  assert.match(failed.error, /HTTP 500/);
  // Error results are never stored, so the cache cannot serve this
  // failure later (this is the same rule the main IPC relies on).
  assert.equal(cache.set('fake-http-500', fingerprint, failed), false);
  assert.equal(cache.get('fake-http-500', fingerprint), undefined);
  assert.equal(cache.size, 0);

  // The server recovers: same URL, same registry file, same
  // fingerprint — a fresh probe must hit the live server and see ok,
  // not a cached error.
  await stopServer(failing.child);
  const recovered = await startFakeHttpOnPort('ok', port);
  assert.equal(recovered.port, port, 'recovered server must reuse the same URL');
  assert.equal(
    getMarketplaceRegistryFingerprint(base),
    fingerprint,
    'registry did not change while the server was down',
  );
  const ok = await probeMarketplaceServerTools('fake-http-500', base);
  assert.equal(ok.status, 'ok');
  assert.deepEqual(
    ok.tools.map((t) => t.name),
    ['http_echo', 'http_no_args'],
  );
  assert.equal(cache.set('fake-http-500', fingerprint, ok), true);
  assert.equal(cache.get('fake-http-500', fingerprint), ok);
});

// ---------------------------------------------------------------------------
// (c) Non-JSON-MCP bodies → clear error, no crash, no body leak
// ---------------------------------------------------------------------------

test('probe http: HTTP 404 with an HTML body fails closed without leaking the body', async () => {
  const { port } = await startFakeHttp('http404');
  const base = baseDirWith(httpEntry('fake-http-404', port));
  const result = await probeMarketplaceServerTools('fake-http-404', base);
  assert.equal(result.status, 'error');
  assert.deepEqual(result.tools, []);
  assert.match(result.error, /HTTP 404/);
  assert.doesNotMatch(result.error, /<html/, 'error must not include the response body');
  assert.doesNotMatch(result.error, /no MCP server at this path/);
  const cache = new MarketplaceProbeCache();
  assert.equal(cache.set('fake-http-404', 'fp1', result), false);
});

test('probe http: HTTP 200 with a body that is not JSON fails closed, no crash', async () => {
  const { port } = await startFakeHttp('bad-json');
  const base = baseDirWith(httpEntry('fake-http-badjson', port));
  const result = await probeMarketplaceServerTools('fake-http-badjson', base);
  assert.equal(result.status, 'error');
  assert.deepEqual(result.tools, []);
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0, 'error message must not be empty');
  assert.match(result.error, /JSON/);
});

// ---------------------------------------------------------------------------
// (d) Default headers, recorded live from the client
// ---------------------------------------------------------------------------

test('probe http: default headers are documented — no Authorization, JSON + SSE Accept, session id', async () => {
  const logFile = path.join(makeTempDir(), 'headers.log');
  const { port } = await startFakeHttp('record-headers', 0, logFile);
  const base = baseDirWith(httpEntry('fake-http-headers', port));
  const result = await probeMarketplaceServerTools('fake-http-headers', base);
  assert.equal(result.status, 'ok');

  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 2, `expected initialize + tools/list POSTs, got ${lines.length}`);
  const entries = lines.map((line) => JSON.parse(line));
  const init = entries.find((e) => e.method === 'initialize');
  assert.ok(init, 'initialize POST must have been recorded');
  // The probe attaches no credential: no Authorization header at all
  // (no config.headers, no authProvider — see StreamableHttpMcpClient
  // postRpcOnce: only Content-Type + Accept are always sent).
  assert.equal(init.headers.authorization, undefined);
  assert.equal(init.headers['content-type'], 'application/json');
  assert.match(init.headers.accept, /application\/json/);
  assert.match(init.headers.accept, /text\/event-stream/);
  // After initialize the server hands out a session id, which the
  // client sends back on later calls (tools/list here).
  const toolsList = entries.find((e) => e.method === 'tools/list');
  assert.ok(toolsList, 'tools/list POST must have been recorded');
  assert.equal(toolsList.headers['mcp-session-id'], 'fake-http-session-1');
  assert.equal(toolsList.headers.authorization, undefined);
});

// ---------------------------------------------------------------------------
// (e) Cache invalidation via a non-disk registry path
//
// Finding (v0.69b): there is NO UI/code path that edits the marketplace
// registry `marketplace/mcp-servers.json`. The only marketplace
// mutation the UI offers — install/uninstall via IPC
// `mcp-marketplace:install` / `mcp-marketplace:uninstall`
// (McpMarketplaceView → main.ts → installMcpServer/uninstallMcpServer)
// — writes the bot workspace's `.open-bot/mcp.json`, never the
// registry. So a registry change can only arrive by editing the file
// on disk, and the fingerprint covers every semantic field of every
// entry (url, command, args, needsKey, …), so any such change is a
// cache miss. These tests prove both halves.
// ---------------------------------------------------------------------------

test('cache invalidation: install/uninstall (the only UI mutation) leaves fingerprint + cached probe untouched', async () => {
  const { port } = await startFakeHttp('ok');
  const base = baseDirWith(httpEntry('fake-http', port));
  const workspace = makeTempDir();
  const cache = new MarketplaceProbeCache();

  const fingerprintBefore = getMarketplaceRegistryFingerprint(base);
  const probed = await probeMarketplaceServerTools('fake-http', base);
  assert.equal(probed.status, 'ok');
  assert.equal(cache.set('fake-http', fingerprintBefore, probed), true);

  const registryBefore = fs.readFileSync(
    path.join(base, 'marketplace', 'mcp-servers.json'),
    'utf8',
  );

  // Install: the UI path writes .open-bot/mcp.json in the workspace.
  const installed = installMcpServer('fake-http', workspace, undefined, base);
  assert.equal(installed.config.url, `http://127.0.0.1:${port}/mcp`);
  assert.ok(
    fs.existsSync(path.join(workspace, '.open-bot', 'mcp.json')),
    'install writes the workspace mcp.json',
  );
  assert.equal(
    getMarketplaceRegistryFingerprint(base),
    fingerprintBefore,
    'install must not change the registry fingerprint',
  );
  assert.equal(
    cache.get('fake-http', getMarketplaceRegistryFingerprint(base)),
    probed,
    'cached probe must still be served after install',
  );
  assert.equal(
    fs.readFileSync(path.join(base, 'marketplace', 'mcp-servers.json'), 'utf8'),
    registryBefore,
    'install must not rewrite the registry file',
  );

  // Uninstall: same — workspace only, registry untouched.
  uninstallMcpServer('fake-http', workspace);
  assert.equal(
    getMarketplaceRegistryFingerprint(base),
    fingerprintBefore,
    'uninstall must not change the registry fingerprint',
  );
  assert.equal(
    cache.get('fake-http', getMarketplaceRegistryFingerprint(base)),
    probed,
    'cached probe must still be served after uninstall',
  );
});

test('cache invalidation: flipping needsKey on the registry entry misses the stale cache', async () => {
  const { port } = await startFakeHttp('ok');
  const entry = httpEntry('fake-http', port);
  const base = baseDirWith(entry);
  const cache = new MarketplaceProbeCache();

  const fp1 = getMarketplaceRegistryFingerprint(base);
  const probed = await probeMarketplaceServerTools('fake-http', base);
  assert.equal(probed.status, 'ok');
  assert.equal(cache.set('fake-http', fp1, probed), true);

  // Registry edit: the same server now needs a credential.
  writeRegistry(base, [{ ...entry, needsKey: 'FAKE_API_KEY — test-key' }]);
  const fp2 = getMarketplaceRegistryFingerprint(base);
  assert.notEqual(fp2, fp1, 'fingerprint must change when needsKey is added');
  assert.equal(
    cache.get('fake-http', fp2),
    undefined,
    'stale ok result must NOT be served after the registry changed',
  );
  const keyed = await probeMarketplaceServerTools('fake-http', base);
  assert.equal(keyed.status, 'needs-key');
  assert.deepEqual(keyed.tools, []);
  assert.match(keyed.error, /needs a credential/);
  assert.equal(cache.set('fake-http', fp2, keyed), true);

  // Registry edit back: removing needsKey restores the original
  // catalogue, so the fingerprint comes back to fp1 — but the cache
  // holds ONE entry per server id, and storing the needs-key result
  // under fp2 already replaced the old ok entry (see the v0.68a
  // 'storing under a new fingerprint replaces the stale entry' test),
  // so the old ok is NOT resurrected from the cache: a fresh probe
  // runs and its ok result is cached under fp1 again.
  writeRegistry(base, [entry]);
  const fp3 = getMarketplaceRegistryFingerprint(base);
  assert.equal(fp3, fp1, 'fingerprint must return to fp1 when the edit is reverted');
  assert.equal(
    cache.get('fake-http', fp3),
    undefined,
    'old ok entry was replaced by the needs-key entry under fp2, not resurrected',
  );
  const probedAgain = await probeMarketplaceServerTools('fake-http', base);
  assert.equal(probedAgain.status, 'ok');
  assert.equal(cache.set('fake-http', fp3, probedAgain), true);
  assert.equal(cache.get('fake-http', fp3), probedAgain);
});
