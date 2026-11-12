/**
 * Tests for v0.68a — MCP marketplace: HTTP probe live + probe-cache
 * invalidation when the registry changes.
 *
 *  - HTTP probe: `probeMarketplaceServerTools` against a LOCAL fake
 *    MCP server over streamable HTTP (tests/mcp-marketplace-probe-fake-http-server.mjs,
 *    plain JSON and SSE framing, hang timeout, non-MCP reply, bad
 *    handshake). No external server, no network beyond localhost,
 *    no real keys anywhere.
 *  - Fingerprint: `getMarketplaceRegistryFingerprint` changes on any
 *    semantic catalogue change (url / needsKey / added entry) and
 *    stays the same for a whitespace-only rewrite or an untouched
 *    registry; returns null for an unreadable registry.
 *  - Cache: `MarketplaceProbeCache` serves a hit only under the same
 *    fingerprint, never stores 'error', and the stale entry is a miss
 *    after the registry changes; an end-to-end test rewrites the
 *    registry to point the same server id at a different HTTP server
 *    and proves the second probe returns the NEW server's tools.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/mcp-marketplace-probe-http-v068a.test.mjs
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
  MarketplaceProbeCache,
  probeMarketplaceServerTools,
} from '../packages/core/dist/mcp/marketplace.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_HTTP_SERVER = path.join(here, 'mcp-marketplace-probe-fake-http-server.mjs');

const tempDirs = [];
const httpServers = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-mkt-probe-http-v068a-'));
  tempDirs.push(dir);
  return dir;
}

/** Start one fake HTTP MCP server; resolves with its localhost port. */
function startFakeHttp(mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FAKE_HTTP_SERVER, mode], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    httpServers.push(child);
    let buffer = '';
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
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!buffer.includes('READY')) {
        reject(new Error(`fake HTTP MCP server (${mode}) exited early (code ${code})`));
      }
    });
  });
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
// HTTP probe, live
// ---------------------------------------------------------------------------

test('probe http: ok fake server (plain JSON) returns its tools', async () => {
  const { port } = await startFakeHttp('ok');
  const base = baseDirWith(httpEntry('fake-http', port));
  const started = Date.now();
  const result = await probeMarketplaceServerTools('fake-http', base);
  const elapsed = Date.now() - started;
  assert.equal(result.serverId, 'fake-http');
  assert.equal(result.status, 'ok');
  assert.equal(result.truncated, false);
  assert.equal(result.error, undefined);
  assert.deepEqual(
    result.tools.map((t) => t.name),
    ['http_echo', 'http_no_args'],
  );
  const echo = result.tools[0];
  assert.equal(echo.description, 'Echoes the input text back (over HTTP).');
  assert.deepEqual(Object.keys(echo.inputSchema.properties), ['text']);
  assert.deepEqual(echo.inputSchema.required, ['text']);
  assert.equal(result.tools[1].description, 'Does nothing and takes no arguments (over HTTP).');
  assert.deepEqual(result.tools[1].inputSchema.properties, {});
  // The GET SSE stream is 405 on the fake server: the probe must stay
  // on POST and come back fast, not wait out the stream setup.
  assert.ok(elapsed < 15_000, `HTTP probe must return promptly (took ${elapsed}ms)`);
});

test('probe http: SSE-framed responses return the same tools', async () => {
  const { port } = await startFakeHttp('sse');
  const base = baseDirWith(httpEntry('fake-http-sse', port));
  const result = await probeMarketplaceServerTools('fake-http-sse', base);
  assert.equal(result.status, 'ok');
  assert.deepEqual(
    result.tools.map((t) => t.name),
    ['http_echo', 'http_no_args'],
  );
});

test('probe http: server that never answers times out fast (opts.timeoutMs)', async () => {
  const { port } = await startFakeHttp('hang');
  const base = baseDirWith(httpEntry('fake-http-hang', port));
  const started = Date.now();
  const result = await probeMarketplaceServerTools('fake-http-hang', base, { timeoutMs: 500 });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 'error');
  assert.deepEqual(result.tools, []);
  assert.match(result.error, /Timed out/);
  assert.ok(elapsed < 10_000, `probe must return well before the default timeout (took ${elapsed}ms)`);
});

test('probe http: non-MCP reply (HTML page) comes back as a clear error', async () => {
  const { port } = await startFakeHttp('non-mcp');
  const base = baseDirWith(httpEntry('fake-http-html', port));
  const result = await probeMarketplaceServerTools('fake-http-html', base);
  assert.equal(result.status, 'error');
  assert.deepEqual(result.tools, []);
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0, 'error message must not be empty');
});

test('probe http: server that errors the handshake comes back as a clear error', async () => {
  const { port } = await startFakeHttp('bad-handshake');
  const base = baseDirWith(httpEntry('fake-http-bad', port));
  const result = await probeMarketplaceServerTools('fake-http-bad', base);
  assert.equal(result.status, 'error');
  assert.deepEqual(result.tools, []);
  assert.match(result.error, /Method not found/);
});

// ---------------------------------------------------------------------------
// Registry fingerprint
// ---------------------------------------------------------------------------

test('fingerprint: stable when the registry is untouched', () => {
  const base = baseDirWith(httpEntry('fake-http', 18080));
  const a = getMarketplaceRegistryFingerprint(base);
  const b = getMarketplaceRegistryFingerprint(base);
  assert.equal(typeof a, 'string');
  assert.ok(a.length > 0);
  assert.equal(a, b);
});

test('fingerprint: whitespace-only rewrite does NOT change it', () => {
  const entries = [httpEntry('fake-http', 18080)];
  const base = baseDirWith(...entries);
  const before = getMarketplaceRegistryFingerprint(base);
  writeRegistry(base, entries, 4);
  const after = getMarketplaceRegistryFingerprint(base);
  assert.equal(after, before);
});

test('fingerprint: changing the server url changes it', () => {
  const base = baseDirWith(httpEntry('fake-http', 18080));
  const before = getMarketplaceRegistryFingerprint(base);
  writeRegistry(base, [httpEntry('fake-http', 18081)]);
  const after = getMarketplaceRegistryFingerprint(base);
  assert.notEqual(after, before);
});

test('fingerprint: adding needsKey / adding an entry changes it', () => {
  const base = baseDirWith(httpEntry('fake-http', 18080));
  const before = getMarketplaceRegistryFingerprint(base);
  const withKey = { ...httpEntry('fake-http', 18080), needsKey: 'TEST_API_KEY — test-key' };
  writeRegistry(base, [withKey]);
  assert.notEqual(getMarketplaceRegistryFingerprint(base), before);
  writeRegistry(base, [withKey, httpEntry('fake-http-2', 18081)]);
  assert.notEqual(getMarketplaceRegistryFingerprint(base), before);
});

test('fingerprint: missing registry file (defaults) is stable across calls', () => {
  const base = makeTempDir();
  const a = getMarketplaceRegistryFingerprint(base);
  const b = getMarketplaceRegistryFingerprint(base);
  assert.equal(typeof a, 'string');
  assert.equal(a, b);
  // No baseDir at all: the built-in catalogue fingerprint, also stable.
  assert.equal(getMarketplaceRegistryFingerprint(), getMarketplaceRegistryFingerprint());
});

test('fingerprint: invalid registry JSON returns null (cache must be bypassed)', () => {
  const base = makeTempDir();
  fs.mkdirSync(path.join(base, 'marketplace'), { recursive: true });
  fs.writeFileSync(path.join(base, 'marketplace', 'mcp-servers.json'), '{ not json', 'utf8');
  assert.equal(getMarketplaceRegistryFingerprint(base), null);
});

// ---------------------------------------------------------------------------
// Probe cache
// ---------------------------------------------------------------------------

function okResult(serverId, toolName) {
  return {
    serverId,
    status: 'ok',
    tools: [{ name: toolName }],
    truncated: false,
  };
}

test('cache: hit under the same fingerprint, miss under another or another server', () => {
  const cache = new MarketplaceProbeCache();
  const result = okResult('fake-http', 'http_echo');
  assert.equal(cache.set('fake-http', 'fp1', result), true);
  assert.equal(cache.get('fake-http', 'fp1'), result);
  assert.equal(cache.get('fake-http', 'fp2'), undefined);
  assert.equal(cache.get('other-server', 'fp1'), undefined);
  assert.equal(cache.size, 1);
});

test('cache: error results are never stored (retry stays possible)', () => {
  const cache = new MarketplaceProbeCache();
  const errorResult = { serverId: 'fake-http', status: 'error', tools: [], truncated: false, error: 'boom' };
  assert.equal(cache.set('fake-http', 'fp1', errorResult), false);
  assert.equal(cache.get('fake-http', 'fp1'), undefined);
  assert.equal(cache.size, 0);
});

test('cache: needs-key results are stored (stable while the catalogue is unchanged)', () => {
  const cache = new MarketplaceProbeCache();
  const result = { serverId: 'brave-search', status: 'needs-key', tools: [], truncated: false, error: 'needs a key' };
  assert.equal(cache.set('brave-search', 'fp1', result), true);
  assert.equal(cache.get('brave-search', 'fp1'), result);
});

test('cache: storing under a new fingerprint replaces the stale entry', () => {
  const cache = new MarketplaceProbeCache();
  const oldResult = okResult('fake-http', 'http_echo');
  const newResult = okResult('fake-http', 'http_alt_only');
  cache.set('fake-http', 'fp1', oldResult);
  cache.set('fake-http', 'fp2', newResult);
  assert.equal(cache.get('fake-http', 'fp1'), undefined);
  assert.equal(cache.get('fake-http', 'fp2'), newResult);
  assert.equal(cache.size, 1);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get('fake-http', 'fp2'), undefined);
});

// ---------------------------------------------------------------------------
// End to end: registry change invalidates the cached probe
// ---------------------------------------------------------------------------

test('cache invalidation end to end: same id, new url → fresh probe, new tools', async () => {
  const serverA = await startFakeHttp('ok');
  const serverB = await startFakeHttp('ok-alt');
  const cache = new MarketplaceProbeCache();
  const base = baseDirWith(httpEntry('fake-http', serverA.port));

  // First probe: server A tools, cached under fingerprint fp1.
  const fp1 = getMarketplaceRegistryFingerprint(base);
  const first = await probeMarketplaceServerTools('fake-http', base);
  assert.equal(first.status, 'ok');
  assert.deepEqual(first.tools.map((t) => t.name), ['http_echo', 'http_no_args']);
  assert.equal(cache.set('fake-http', fp1, first), true);
  assert.equal(cache.get('fake-http', fp1), first);

  // Registry changes: same id, now pointing at server B.
  writeRegistry(base, [httpEntry('fake-http', serverB.port)]);
  const fp2 = getMarketplaceRegistryFingerprint(base);
  assert.notEqual(fp2, fp1, 'fingerprint must change when the url changes');
  assert.equal(
    cache.get('fake-http', fp2),
    undefined,
    'stale cached result must NOT be served after the registry changed',
  );

  // Fresh probe under the new catalogue returns server B's tools.
  const second = await probeMarketplaceServerTools('fake-http', base);
  assert.equal(second.status, 'ok');
  assert.deepEqual(second.tools.map((t) => t.name), ['http_alt_only']);
  assert.equal(cache.set('fake-http', fp2, second), true);
  assert.equal(cache.get('fake-http', fp2), second);

  // Unchanged registry: the cache is still used (hit, no re-probe needed).
  writeRegistry(base, [httpEntry('fake-http', serverB.port)], 4);
  const fp3 = getMarketplaceRegistryFingerprint(base);
  assert.equal(fp3, fp2, 'whitespace-only rewrite must not invalidate the cache');
  assert.equal(cache.get('fake-http', fp3), second);
});
