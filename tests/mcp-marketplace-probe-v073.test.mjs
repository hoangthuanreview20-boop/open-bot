/**
 * Tests for v0.73 — marketplace probe forwards the client's -32602
 * tools/list warning (`probeMarketplaceServerTools` in
 * packages/core/src/mcp/marketplace.ts).
 *
 * Before v0.73 the probe built its `McpServerConfig` with no
 * `onWarning`, so a server rejecting tools/list with -32602 made
 * the probe return `{ status: 'ok', tools: [] }` and the reason was
 * silently swallowed — indistinguishable from a server with no
 * tools. Now the warning must reach the caller two ways: collected
 * into `result.warnings` and forwarded to `opts.onWarning`.
 *
 * Drives the probe against the local fake MCP server script
 * (tests/mcp-marketplace-probe-fake-server.mjs, mode 'list-32602')
 * via a registry file written into a temp baseDir — no npx, no
 * network, no real keys anywhere.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/mcp-marketplace-probe-v073.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeMarketplaceServerTools } from '../packages/core/dist/mcp/marketplace.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER = path.join(here, 'mcp-marketplace-probe-fake-server.mjs');

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-mkt-probe-v073-'));
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

test('probe: -32602 tools/list comes back ok + empty tools WITH the warning in result.warnings', async () => {
  const base = baseDirWith(fakeEntry('fake-32602', 'list-32602'));
  const result = await probeMarketplaceServerTools('fake-32602', base);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.tools, []);
  assert.equal(result.truncated, false);
  assert.equal(result.error, undefined);
  assert.equal(Array.isArray(result.warnings), true, 'warnings must be present when the list was rejected');
  assert.equal(result.warnings.length, 1);
  const [w] = result.warnings;
  assert.equal(w.method, 'tools/list');
  assert.equal(w.code, -32602);
  assert.match(w.message, /fake-32602/);
  assert.match(w.message, /tools\/list/);
  assert.match(w.message, /-32602/);
  assert.match(w.detail, /Invalid params/);
});

test('probe: opts.onWarning receives the same warning as it fires', async () => {
  const base = baseDirWith(fakeEntry('fake-32602', 'list-32602'));
  const seen = [];
  const result = await probeMarketplaceServerTools('fake-32602', base, {
    onWarning: (w) => seen.push(w),
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen, result.warnings);
});

test('probe: a throwing onWarning callback must not fail the probe', async () => {
  const base = baseDirWith(fakeEntry('fake-32602', 'list-32602'));
  const result = await probeMarketplaceServerTools('fake-32602', base, {
    onWarning: () => {
      throw new Error('callback boom');
    },
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.tools, []);
  assert.equal(result.warnings.length, 1);
});

test('probe: a healthy server reports no warnings field at all', async () => {
  const base = baseDirWith(fakeEntry('fake-ok', 'ok'));
  const result = await probeMarketplaceServerTools('fake-ok', base);
  assert.equal(result.status, 'ok');
  assert.equal(result.tools.length, 2);
  assert.equal(result.warnings, undefined);
});
