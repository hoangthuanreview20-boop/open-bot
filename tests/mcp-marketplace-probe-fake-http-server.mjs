/**
 * Minimal fake MCP server (streamable HTTP) for the v0.68a
 * marketplace probe tests + the Electron smoke test.
 *
 * Usage: node mcp-marketplace-probe-fake-http-server.mjs [mode] [port]
 *
 * Modes:
 *   ok            (default) answer initialize + tools/list as plain JSON.
 *   ok-alt        like ok, but expose a DIFFERENT tool (http_alt_only)
 *                 so tests can tell two servers apart by their tools.
 *   sse           like ok, but wrap each JSON-RPC response in an SSE
 *                 `data:` frame (text/event-stream).
 *   sse-hold-open (v0.73) like sse, but the stream is HELD OPEN for
 *                 5s after the response frame is sent — a server that
 *                 keeps sending progress (or never closes the stream).
 *                 The client must return as soon as the frame matching
 *                 its request id arrives, NOT wait for the stream to
 *                 close. For `tools/call` it first sends a
 *                 `notifications/progress` frame (using the
 *                 `progressToken` from the request `_meta`, when one
 *                 is present) and answers the call with
 *                 `Echo: <text>`.
 *   hang          accept POSTs and never answer (probe timeout).
 *   non-mcp       answer 200 with a text/html page — not MCP at all.
 *   bad-handshake answer initialize with a JSON-RPC error.
 *   auth          (v0.69b) require `Authorization: Bearer <token>`
 *                 (token = argv[4], default 'test-bearer-token') on
 *                 every POST; anything else gets 401 JSON +
 *                 `WWW-Authenticate: Bearer`. A correct Bearer
 *                 behaves like ok. The probe never attaches a
 *                 credential, so it always gets the 401 here.
 *   http500       (v0.69b) every POST gets HTTP 500 with a JSON error
 *                 body — the server is up but failing.
 *   http404       (v0.69b) every POST gets HTTP 404 with an HTML body
 *                 — a wrong path / non-MCP endpoint that also fails
 *                 the status check (body is never surfaced).
 *   bad-json      (v0.69b) every POST gets HTTP 200 with a plain-text
 *                 body that is not JSON at all — the response is not
 *                 a JSON-RPC message.
 *   record-headers (v0.69b) like ok, but append one JSON line per
 *                 POST to the file at argv[4]:
 *                 `{ method, headers }` (method = the JSON-RPC
 *                 method, or '(notification)'). Lets tests assert
 *                 exactly which headers the client sends by default.
 *
 * The "ok"/"sse" server exposes two tools:
 *   http_echo    (inputSchema: { text: string, required }) and
 *   http_no_args (inputSchema with empty properties).
 *
 * Behaviour notes (matching what the real client expects):
 *  - POST with a JSON-RPC request id gets a JSON-RPC response;
 *    POST without an id is a notification → 202 with an empty body.
 *  - GET returns 405: this server offers no SSE stream, so the client
 *    keeps working over plain POST (per the transport's 405 rule).
 *  - DELETE returns 204 (session teardown from client.close()).
 *  - The initialize response carries an `Mcp-Session-Id` header, which
 *    the client stores and sends back on later requests.
 *
 * Listens on 127.0.0.1 only (port 0 = ephemeral by default) and prints
 * `READY <port>` on stdout once listening. No network beyond
 * localhost, no real MCP package, no secrets.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';

const mode = process.argv[2] ?? 'ok';
const requestedPort = Number(process.argv[3] ?? 0);
// v0.69b: bearer token for `auth` mode / headers-log file for
// `record-headers` mode (both read argv[4]; the modes never overlap).
const modeArg = process.argv[4];
const AUTH_TOKEN = modeArg ?? 'test-bearer-token';
const HEADERS_LOG_FILE = modeArg;

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

const TOOLS_ALT = [
  {
    name: 'http_alt_only',
    description: 'Only tool of the alternate fake HTTP server.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function toolsForMode() {
  return mode === 'ok-alt' ? TOOLS_ALT : TOOLS_OK;
}

function sendJsonRpc(res, id, result) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id, result });
  if (mode === 'sse') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${payload}\n\n`);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function sendJsonRpcError(res, id, code, message) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  if (mode === 'sse') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${payload}\n\n`);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(payload);
}

/**
 * v0.73 (`sse-hold-open`): write SSE frames, then HOLD the stream open
 * for 5s before ending — the client must not wait for the close. The
 * hold timer is cleared only when the response itself closes (client
 * disconnect / stream finished): NOT on request `close`, which fires
 * as soon as the request body is complete and would cancel the hold
 * before `res.end()` ever runs.
 */
function sendSseHoldOpen(res, frames) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Mcp-Session-Id': 'fake-http-session-1',
  });
  for (const frame of frames) {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  }
  const hold = setTimeout(() => {
    try {
      res.end();
    } catch {
      // Client already gone — nothing to close.
    }
  }, 5000);
  res.on('close', () => clearTimeout(hold));
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    // No SSE stream on this server — 405 tells the client to stay on POST.
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
  if (mode === 'hang') {
    // Never answer: hold the request open until the client times out.
    return;
  }
  if (mode === 'non-mcp') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>not an MCP server</h1></body></html>');
    return;
  }
  if (mode === 'auth') {
    // The probe sends no Authorization header (no config.headers, no
    // authProvider), so it always lands here; a caller WITH the right
    // Bearer token gets the normal ok behaviour below.
    if (req.headers.authorization !== `Bearer ${AUTH_TOKEN}`) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="fake-mcp", error="invalid_token"',
      });
      res.end(JSON.stringify({ error: 'unauthorized: a valid Bearer token is required' }));
      return;
    }
  }
  if (mode === 'http500') {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal server error (fake)' }));
    return;
  }
  if (mode === 'http404') {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>404 — no MCP server at this path</h1></body></html>');
    return;
  }
  if (mode === 'bad-json') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('this is not valid JSON, let alone a JSON-RPC message');
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
    if (mode === 'record-headers' && HEADERS_LOG_FILE) {
      // Best-effort: a failed append must never break the probe.
      try {
        fs.appendFileSync(
          HEADERS_LOG_FILE,
          JSON.stringify({
            method: typeof msg.method === 'string' ? msg.method : '(notification)',
            headers: req.headers,
          }) + '\n',
          'utf8',
        );
      } catch {
        // ignore — the probe behaviour under test is unaffected
      }
    }
    // Notification (no id): acknowledge with an empty 202.
    if (msg.id === undefined || msg.id === null) {
      res.writeHead(202);
      res.end();
      return;
    }
    if (mode === 'sse-hold-open') {
      // Response frame(s) first, stream held open 5s afterwards.
      const frames = [];
      if (msg.method === 'initialize') {
        frames.push({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'fake-http-mcp', version: '1.0.0' },
          },
        });
      } else if (msg.method === 'tools/list') {
        frames.push({ jsonrpc: '2.0', id: msg.id, result: { tools: toolsForMode() } });
      } else if (msg.method === 'tools/call') {
        const token = msg.params?._meta?.progressToken;
        if (token !== undefined) {
          frames.push({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { progressToken: token, progress: 1, total: 2, message: 'working' },
          });
        }
        const text = msg.params?.arguments?.text ?? msg.params?.text ?? '';
        frames.push({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: `Echo: ${text}` }] },
        });
      } else if (msg.method === 'ping') {
        frames.push({ jsonrpc: '2.0', id: msg.id, result: {} });
      } else {
        frames.push({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: 'Method not found' },
        });
      }
      sendSseHoldOpen(res, frames);
      return;
    }
    if (msg.method === 'initialize') {
      if (mode === 'bad-handshake') {
        sendJsonRpcError(res, msg.id, -32601, 'Method not found');
        return;
      }
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-http-mcp', version: '1.0.0' },
        },
      });
      const headers = {
        'Content-Type': mode === 'sse' ? 'text/event-stream' : 'application/json',
        'Mcp-Session-Id': 'fake-http-session-1',
      };
      res.writeHead(200, headers);
      res.end(mode === 'sse' ? `data: ${payload}\n\n` : payload);
      return;
    }
    if (msg.method === 'tools/list') {
      sendJsonRpc(res, msg.id, { tools: toolsForMode() });
      return;
    }
    if (msg.method === 'ping') {
      sendJsonRpc(res, msg.id, {});
      return;
    }
    sendJsonRpcError(res, msg.id, -32601, 'Method not found');
  });
});

server.listen(requestedPort, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(`READY ${address.port}\n`);
});
