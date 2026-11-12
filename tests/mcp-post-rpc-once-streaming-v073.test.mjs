/**
 * Tests for v0.73 (P0 `postRpcOnce`): the Streamable-HTTP client must
 * NOT wait for the whole SSE body before returning.
 *
 * Bug: `postRpcOnce` did `await res.text()` — with a server that keeps
 * the SSE stream open after sending the response frame (more progress
 * notifications, or never closing), the client waited until timeout
 * even though the response had arrived long ago.
 *
 * Fix: read an SSE body as a stream, parse each `data:` frame as it
 * arrives, and resolve as soon as the frame matching the request id
 * is seen (server-initiated messages before it are still dispatched
 * by `parseRpcResponse`).
 *
 * The fake server mode `sse-hold-open`
 * (tests/mcp-marketplace-probe-fake-http-server.mjs) sends the
 * response frame, then HOLDS the stream open for 5s. A client with
 * the bug answers in ~5s; the fixed client answers in well under 2s.
 * No external server, no network beyond localhost, no real keys.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/mcp-post-rpc-once-streaming-v073.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { StreamableHttpMcpClient } from '../packages/core/dist/mcp/client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_HTTP_SERVER = path.join(here, 'mcp-marketplace-probe-fake-http-server.mjs');

// The fake server holds the SSE stream open this long after the
// response frame; the fixed client must answer far sooner than that.
const HOLD_OPEN_MS = 5000;
const FAST_ENOUGH_MS = 2000;

const httpServers = [];
const clients = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    try {
      await client.close();
    } catch {
      // Best-effort teardown — never fail the test run.
    }
  }
  for (const child of httpServers.splice(0)) {
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }
});

/** Start one fake HTTP MCP server in `sse-hold-open` mode. */
function startFakeHttp() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FAKE_HTTP_SERVER, 'sse-hold-open'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    httpServers.push(child);
    let buffer = '';
    const timer = setTimeout(
      () => reject(new Error('fake HTTP MCP server (sse-hold-open) did not print READY in 10s')),
      10_000,
    );
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const m = buffer.match(/READY (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function makeClient(port) {
  const client = new StreamableHttpMcpClient({
    name: 'fake-hold',
    url: `http://127.0.0.1:${port}/mcp`,
  });
  clients.push(client);
  return client;
}

/** Wait (up to `timeoutMs`) for `check()` to become true. */
async function waitFor(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}

test('v0.73 postRpcOnce: response on a held-open SSE stream returns fast (< 2s, stream held 5s)', async () => {
  const port = await startFakeHttp();
  const client = makeClient(port);

  const t0 = Date.now();
  const info = await client.initialize();
  const initMs = Date.now() - t0;
  assert.equal(info.name, 'fake-http-mcp');
  assert.ok(
    initMs < FAST_ENOUGH_MS,
    `initialize() took ${initMs}ms — expected < ${FAST_ENOUGH_MS}ms (stream held ${HOLD_OPEN_MS}ms)`,
  );

  const t1 = Date.now();
  const tools = await client.listTools();
  const listMs = Date.now() - t1;
  assert.deepEqual(
    tools.map((t) => t.name),
    ['http_echo', 'http_no_args'],
  );
  assert.ok(
    listMs < FAST_ENOUGH_MS,
    `listTools() took ${listMs}ms — expected < ${FAST_ENOUGH_MS}ms (stream held ${HOLD_OPEN_MS}ms)`,
  );
});

test('v0.73 postRpcOnce: progress notification sent before the response is still dispatched', async () => {
  const port = await startFakeHttp();
  const client = makeClient(port);
  await client.initialize();

  const seen = [];
  const t0 = Date.now();
  const echoed = await client.callTool(
    'http_echo',
    { text: 'hello hold-open' },
    { onProgress: (n) => seen.push(n) },
  );
  const callMs = Date.now() - t0;
  assert.equal(echoed, 'Echo: hello hold-open');
  assert.ok(
    callMs < FAST_ENOUGH_MS,
    `callTool() took ${callMs}ms — expected < ${FAST_ENOUGH_MS}ms (stream held ${HOLD_OPEN_MS}ms)`,
  );

  // Progress dispatch goes through the async dispatcher, so it may
  // land a tick after the call itself resolves — poll briefly.
  const dispatched = await waitFor(() => seen.length > 0);
  assert.ok(dispatched, 'expected the progress notification to reach onProgress');
  assert.equal(seen[0].progress, 1);
  assert.equal(seen[0].total, 2);
  assert.equal(seen[0].message, 'working');
});
