/**
 * Tests for v0.88c (P0 `postRpcOnce` streaming — follow-up verification).
 *
 * Context: the bug found in v0.71 (`postRpcOnce` did `await res.text()`,
 * so a server holding the SSE stream open after sending the response
 * frame made every request wait for the stream to close — GitMCP held
 * ~10s, an infinitely-held stream hit the 30s timeout) was ALREADY
 * fixed in v0.73a (commit 0220330: `readRpcBody` reads the SSE body as
 * a stream, resolves as soon as the frame matching the request id
 * arrives, then `reader.cancel()`s). The v0.73 test only asserted the
 * client-side timing (< 2s). This file closes the verification gaps
 * the v0.73 test left open:
 *
 *   (a) the SERVER must observe the client disconnecting promptly
 *       after the early resolve (i.e. `reader.cancel()` really tears
 *       the connection down, the socket is not left dangling until
 *       the server's 5s hold expires);
 *   (b) a plain-JSON (non-SSE) response still works exactly as before;
 *   (c) error frames, wrong-id frames and timeouts keep the old
 *       behaviour (error surfaces with its code, a wrong id is
 *       ignored, a stream that never yields the matching frame still
 *       times out) — plus a frame split across TCP chunks.
 *
 * Fake server is in-process (`node:http` on 127.0.0.1, ephemeral
 * port); no external server, no network beyond localhost, no keys.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/mcp-client-streaming-v088c.test.mjs
 */
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';

import { StreamableHttpMcpClient } from '../packages/core/dist/mcp/client.js';

// The fake server holds the SSE stream open this long after the
// response frame; the fixed client must answer (and disconnect) far
// sooner than that.
const HOLD_OPEN_MS = 5000;
const FAST_ENOUGH_MS = 2000;

const TOOLS_OK = [
  {
    name: 'http_echo',
    description: 'Echoes the input text back (over HTTP).',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'http_no_args',
    description: 'Does nothing and takes no arguments (over HTTP).',
    inputSchema: { type: 'object', properties: {} },
  },
];

/**
 * One fake server per test file run; `mode` is switched per test.
 * Modes (behaviour of `tools/list`; `initialize` is always answered
 * with the matching frame at once):
 *   hold-open    SSE frame with the matching id, then hold 5s.
 *   json         plain `application/json` response, stream closed.
 *   json-error   plain JSON error frame (-32601), stream closed.
 *   sse-error    SSE error frame (-32601) with the matching id, then hold 5s.
 *   wrong-id     SSE frame with a WRONG id first, then the matching
 *                frame 50ms later, then hold 5s.
 *   never-match  only wrong-id frames + SSE heartbeats, hold 5s
 *                (never yields the matching frame → client timeout).
 *   split-frame  the matching `data:` line split across two TCP
 *                writes 100ms apart, then hold 5s.
 */
let mode = 'hold-open';
// Server-side observations, per JSON-RPC method: { frameSentAt, closedAt }.
let observations = {};

function note(method, patch) {
  observations[method] = { ...(observations[method] ?? {}), ...patch };
}

function holdOpen(res, method) {
  const hold = setTimeout(() => {
    try {
      res.end();
    } catch {
      // Client already gone — nothing to close.
    }
  }, HOLD_OPEN_MS);
  hold.unref?.();
  res.on('close', () => {
    clearTimeout(hold);
    note(method, { closedAt: Date.now() });
  });
}

function sseResultFrame(id) {
  return { jsonrpc: '2.0', id, result: { tools: TOOLS_OK } };
}

function initializeFrame(id) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-http-mcp', version: '1.0.0' },
    },
  };
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    // No GET SSE stream — 405 tells the client to stay on POST.
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }
  if (req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad JSON' }));
      return;
    }
    // Notification (no id): acknowledge with an empty 202.
    if (msg.id === undefined || msg.id === null) {
      res.writeHead(202);
      res.end();
      return;
    }
    const method = msg.method;
    if (method === 'initialize') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(initializeFrame(msg.id))}\n\n`);
      note(method, { frameSentAt: Date.now() });
      holdOpen(res, method);
      return;
    }
    if (method !== 'tools/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: 'Method not found' },
        }),
      );
      return;
    }
    switch (mode) {
      case 'json': {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(sseResultFrame(msg.id)));
        note(method, { frameSentAt: Date.now(), closedAt: Date.now() });
        break;
      }
      case 'json-error': {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: 'Method not found' },
          }),
        );
        note(method, { frameSentAt: Date.now(), closedAt: Date.now() });
        break;
      }
      case 'sse-error': {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: 'Method not found' },
          })}\n\n`,
        );
        note(method, { frameSentAt: Date.now() });
        holdOpen(res, method);
        break;
      }
      case 'wrong-id': {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: 999999,
            result: { tools: [{ name: 'wrong_id_tool' }] },
          })}\n\n`,
        );
        note(method, { frameSentAt: Date.now() });
        holdOpen(res, method);
        setTimeout(() => {
          try {
            res.write(`data: ${JSON.stringify(sseResultFrame(msg.id))}\n\n`);
          } catch {
            // Client already gone — nothing to write.
          }
        }, 50).unref?.();
        break;
      }
      case 'never-match': {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const beat = setInterval(() => {
          try {
            res.write(
              `data: ${JSON.stringify({
                jsonrpc: '2.0',
                id: 999999,
                result: { tools: [] },
              })}\n\n: ping\n\n`,
            );
          } catch {
            clearInterval(beat);
          }
        }, 200);
        beat.unref?.();
        res.on('close', () => clearInterval(beat));
        note(method, { frameSentAt: Date.now() });
        holdOpen(res, method);
        break;
      }
      case 'split-frame': {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const line = `data: ${JSON.stringify(sseResultFrame(msg.id))}\n\n`;
        const cut = Math.floor(line.length / 2);
        res.write(line.slice(0, cut));
        note(method, { frameSentAt: Date.now() });
        holdOpen(res, method);
        setTimeout(() => {
          try {
            res.write(line.slice(cut));
          } catch {
            // Client already gone — nothing to write.
          }
        }, 100).unref?.();
        break;
      }
      case 'hold-open':
      default: {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify(sseResultFrame(msg.id))}\n\n`);
        note(method, { frameSentAt: Date.now() });
        holdOpen(res, method);
        break;
      }
    }
  });
});

let port;
const clients = [];

async function startServer() {
  if (port !== undefined) return port;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  return port;
}

function makeClient() {
  const client = new StreamableHttpMcpClient({
    name: 'fake-hold-v088c',
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

afterEach(async () => {
  for (const client of clients.splice(0)) {
    try {
      await client.close();
    } catch {
      // Best-effort teardown — never fail the test run.
    }
  }
  observations = {};
});

after(async () => {
  // No test leaves a client behind (afterEach closes them); drop any
  // socket a held-open stream is still using so the process can exit.
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
});

test('v0.88c postRpcOnce: server sees the client disconnect promptly after the early resolve', async () => {
  await startServer();
  mode = 'hold-open';
  const client = makeClient();

  const t0 = Date.now();
  await client.initialize();
  const tools = await client.listTools();
  const callMs = Date.now() - t0;
  assert.deepEqual(
    tools.map((t) => t.name),
    ['http_echo', 'http_no_args'],
  );
  assert.ok(
    callMs < FAST_ENOUGH_MS,
    `initialize()+listTools() took ${callMs}ms — expected < ${FAST_ENOUGH_MS}ms (stream held ${HOLD_OPEN_MS}ms)`,
  );

  // The server must observe the response stream closing far sooner
  // than the 5s hold expiring: reader.cancel() has to tear the
  // connection down, not just stop the client reading. The FIN takes
  // a few ms to reach the server after the client-side resolve, so
  // poll briefly for the server-side observation.
  const closed = await waitFor(() => observations['tools/list']?.closedAt !== undefined);
  assert.ok(closed, 'server should have observed the tools/list stream close');
  const obs = observations['tools/list'];
  const closeAfterFrameMs = obs.closedAt - obs.frameSentAt;
  assert.ok(
    closeAfterFrameMs < FAST_ENOUGH_MS,
    `server saw tools/list stream close ${closeAfterFrameMs}ms after the frame — ` +
      `expected < ${FAST_ENOUGH_MS}ms (hold is ${HOLD_OPEN_MS}ms)`,
  );
});

test('v0.88c postRpcOnce: plain JSON response still works exactly as before', async () => {
  await startServer();
  mode = 'json';
  const client = makeClient();

  const info = await client.initialize();
  assert.equal(info.name, 'fake-http-mcp');
  const tools = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ['http_echo', 'http_no_args'],
  );
});

test('v0.88c postRpcOnce: SSE error frame with the matching id surfaces (fast, stream held open)', async () => {
  await startServer();
  mode = 'sse-error';
  const client = makeClient();
  await client.initialize();

  const t0 = Date.now();
  await assert.rejects(
    () => client.requestJsonRpc('tools/list'),
    (err) => {
      assert.match(err.message, /-32601/);
      assert.match(err.message, /Method not found/);
      return true;
    },
  );
  const callMs = Date.now() - t0;
  assert.ok(
    callMs < FAST_ENOUGH_MS,
    `error frame took ${callMs}ms to surface — expected < ${FAST_ENOUGH_MS}ms (stream held ${HOLD_OPEN_MS}ms)`,
  );
});

test('v0.88c postRpcOnce: plain JSON error frame still surfaces with its code', async () => {
  await startServer();
  mode = 'json-error';
  const client = makeClient();
  await client.initialize();

  await assert.rejects(
    () => client.requestJsonRpc('tools/list'),
    (err) => {
      assert.match(err.message, /-32601/);
      assert.match(err.message, /Method not found/);
      return true;
    },
  );
});

test('v0.88c postRpcOnce: frame with a wrong id is ignored, the matching frame still resolves fast', async () => {
  await startServer();
  mode = 'wrong-id';
  const client = makeClient();
  await client.initialize();

  const t0 = Date.now();
  const tools = await client.listTools();
  const callMs = Date.now() - t0;
  assert.deepEqual(
    tools.map((t) => t.name),
    ['http_echo', 'http_no_args'],
  );
  assert.ok(
    callMs < FAST_ENOUGH_MS,
    `listTools() took ${callMs}ms — expected < ${FAST_ENOUGH_MS}ms (stream held ${HOLD_OPEN_MS}ms)`,
  );
});

test('v0.88c postRpcOnce: stream that never yields the matching frame still times out', async () => {
  await startServer();
  mode = 'never-match';
  const client = makeClient();
  await client.initialize();

  const t0 = Date.now();
  await assert.rejects(
    () => client.requestJsonRpc('tools/list', undefined, { timeoutMs: 1500 }),
    (err) => {
      assert.match(err.message, /timed out after 1500ms/);
      return true;
    },
  );
  const callMs = Date.now() - t0;
  assert.ok(
    callMs >= 1000,
    `timed out after only ${callMs}ms — expected to wait ~1500ms for the timeout`,
  );
  assert.ok(
    callMs < 4000,
    `timeout took ${callMs}ms — expected < 4000ms (stream held ${HOLD_OPEN_MS}ms)`,
  );
});

test('v0.88c postRpcOnce: response frame split across TCP chunks still resolves fast', async () => {
  await startServer();
  mode = 'split-frame';
  const client = makeClient();
  await client.initialize();

  const t0 = Date.now();
  const tools = await client.listTools();
  const callMs = Date.now() - t0;
  assert.deepEqual(
    tools.map((t) => t.name),
    ['http_echo', 'http_no_args'],
  );
  assert.ok(
    callMs < FAST_ENOUGH_MS,
    `listTools() took ${callMs}ms — expected < ${FAST_ENOUGH_MS}ms (stream held ${HOLD_OPEN_MS}ms)`,
  );
});
