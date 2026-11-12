/**
 * Tests for v0.67a — MCP marketplace tool probe
 * (`probeMarketplaceServerTools` in packages/core/src/mcp/marketplace.ts).
 *
 * The probe spawns the catalogued server, runs initialize +
 * tools/list, then closes the client. Tests drive it against the
 * local fake MCP server script (tests/mcp-marketplace-probe-fake-server.mjs)
 * via a registry file written into a temp baseDir — no npx, no
 * network, no real keys anywhere.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/mcp-marketplace-probe-v067a.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MARKETPLACE_PROBE_TIMEOUT_MS,
  probeMarketplaceServerTools,
} from '../packages/core/dist/mcp/marketplace.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER = path.join(here, 'mcp-marketplace-probe-fake-server.mjs');

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-mkt-probe-v067a-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function fakeEntry(id, mode) {
  return {
    id,
    name: `Fake ${mode}`,
    description: `Fake MCP server in ${mode} mode (probe test).`,
    transport: 'stdio',
    command: process.execPath,
    args: [FAKE_SERVER, mode],
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

test('probe: ok fake server returns its tools with descriptions + input schemas', async () => {
  const base = baseDirWith(fakeEntry('fake-ok', 'ok'));
  const result = await probeMarketplaceServerTools('fake-ok', base);
  assert.equal(result.serverId, 'fake-ok');
  assert.equal(result.status, 'ok');
  assert.equal(result.truncated, false);
  assert.equal(result.error, undefined);
  assert.deepEqual(
    result.tools.map((t) => t.name),
    ['fake_echo', 'fake_no_args'],
  );
  const echo = result.tools[0];
  assert.equal(echo.description, 'Echoes the input text back.');
  assert.deepEqual(Object.keys(echo.inputSchema.properties), ['text']);
  assert.deepEqual(echo.inputSchema.required, ['text']);
  assert.equal(result.tools[1].description, 'Does nothing and takes no arguments.');
  assert.deepEqual(result.tools[1].inputSchema.properties, {});
});

test('probe: server that exits immediately comes back as a clear error, not a throw', async () => {
  const base = baseDirWith(fakeEntry('fake-dead', 'exit-early'));
  const result = await probeMarketplaceServerTools('fake-dead', base);
  assert.equal(result.status, 'error');
  assert.deepEqual(result.tools, []);
  assert.match(result.error, /fake-dead/);
});

test('probe: server that errors the handshake comes back as a clear error', async () => {
  const base = baseDirWith(fakeEntry('fake-bad', 'bad-handshake'));
  const result = await probeMarketplaceServerTools('fake-bad', base);
  assert.equal(result.status, 'error');
  assert.deepEqual(result.tools, []);
  assert.match(result.error, /Method not found/);
});

test('probe: hanging server times out fast (opts.timeoutMs) instead of hanging the caller', async () => {
  const base = baseDirWith(fakeEntry('fake-hang', 'hang'));
  const started = Date.now();
  const result = await probeMarketplaceServerTools('fake-hang', base, { timeoutMs: 500 });
  const elapsed = Date.now() - started;
  assert.equal(result.status, 'error');
  assert.match(result.error, /Timed out/);
  assert.ok(elapsed < 10_000, `probe must return well before the default timeout (took ${elapsed}ms)`);
});

test('probe: default timeout is 20s', () => {
  assert.equal(MARKETPLACE_PROBE_TIMEOUT_MS, 20_000);
});

test('probe: a server that needs a key is never probed (needs-key, no spawn)', async () => {
  // brave-search is a built-in catalogue entry with needsKey.
  const result = await probeMarketplaceServerTools('brave-search');
  assert.equal(result.status, 'needs-key');
  assert.deepEqual(result.tools, []);
  assert.match(result.error, /BRAVE_API_KEY/);
});

test('probe: a server with a placeholder arg is never spawned (clear error)', async () => {
  // filesystem is a built-in entry whose args hold <allowed-directory>.
  const result = await probeMarketplaceServerTools('filesystem');
  assert.equal(result.status, 'error');
  assert.deepEqual(result.tools, []);
  assert.match(result.error, /placeholder/);
  assert.match(result.error, /<allowed-directory>/);
});

test('probe: unknown id throws (like install)', async () => {
  await assert.rejects(
    () => probeMarketplaceServerTools('no-such-server'),
    /Unknown MCP marketplace server "no-such-server"/,
  );
});

test('probe: invalid id shape throws', async () => {
  await assert.rejects(() => probeMarketplaceServerTools('bad id!'), /Invalid MCP marketplace id/);
});

test('probe: non-positive timeout throws', async () => {
  const base = baseDirWith(fakeEntry('fake-ok', 'ok'));
  await assert.rejects(
    () => probeMarketplaceServerTools('fake-ok', base, { timeoutMs: 0 }),
    /positive number/,
  );
  await assert.rejects(
    () => probeMarketplaceServerTools('fake-ok', base, { timeoutMs: -5 }),
    /positive number/,
  );
});
