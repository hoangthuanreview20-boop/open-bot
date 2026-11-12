/**
 * Tests for v0.70 — SEP-1303 extension (milestone 3).
 *
 *  (a) `-32602` (invalid params) is a tool-level error, not a protocol
 *      error, for the typed client methods beyond `tools/call` (v0.69d
 *      covered `tools/call` only):
 *        - `tools/list` / `resources/list` -> `[]` (no throw);
 *        - `resources/read` -> `MCP tool error: …` text (no throw);
 *      Other codes (e.g. `-32601`) still throw, and the raw
 *      `requestJsonRpc` path still throws for `-32602` as well — the
 *      adapters (tasks/prompts) handle that code themselves. Both
 *      transports (stdio + streamable HTTP) are covered.
 *
 *  (b) Per-server auth tool timeout: `mcp_authenticate_<server>` now
 *      takes a `timeoutSeconds` argument (1–600s) and honours the
 *      host-configured default (`authTimeoutSeconds`, default 300s)
 *      instead of always waiting the 300s default of `runMcpAuthFlow`
 *      on the no-openUrl path. A short timeout must cut the wait
 *      (timed, well under 300s), not just change a default somewhere.
 *
 * No live network, no real keys: fake MCP servers on stdio / localhost
 * HTTP, fake OAuth config, and NO openUrl — so the auth flow waits for
 * a browser callback that never comes and must time out on schedule.
 *
 * Run after building core + tools:
 *   npx tsc -p packages/core/tsconfig.json
 *   npx tsc -p packages/tools/tsconfig.json
 *   node --test tests/mcp-sep1303-v070.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectMcp } from '../packages/core/dist/mcp/client.js';
import { BotMemory, defaultToolFactory } from '../packages/core/dist/index.js';
import {
  createMcpTools,
  resolveMcpAuthTimeoutSeconds,
  DEFAULT_MCP_AUTH_TIMEOUT_SECONDS,
  MAX_MCP_AUTH_TIMEOUT_SECONDS,
} from '../packages/tools/dist/mcpTools.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_STDIO_SERVER = path.join(here, 'fixtures', 'fake-mcp-server.mjs');

const OAUTH_CONFIG = {
  authorizationEndpoint: 'https://auth.example.test/authorize',
  tokenEndpoint: 'https://auth.example.test/token',
  clientId: 'test-client-70',
  scope: 'read',
};

const tmpDirs = [];
const httpServers = [];
const clients = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Workspace with one HTTP MCP server `crm` in `.open-bot/mcp.json`. */
function makeMcpWorkspace() {
  const ws = makeTempDir('open-bot-mcp-sep1303-v070-');
  fs.mkdirSync(path.join(ws, '.open-bot'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, '.open-bot', 'mcp.json'),
    JSON.stringify({
      servers: { crm: { url: 'http://127.0.0.1:9/mcp' } },
    }),
  );
  return ws;
}

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `expected a tool named "${name}"`);
  return tool;
}

after(async () => {
  for (const client of clients) {
    await client.close().catch(() => undefined);
  }
  for (const { server } of httpServers) {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  for (const dir of tmpDirs) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

// --- (a) stdio: fake server that answers -32602 for list/read -----------

/**
 * Fake stdio MCP server. Mode from argv[2]:
 *  - 'all-32602' (default): tools/list, resources/list, resources/read
 *    and tools/call all answer -32602; anything else -32601.
 *  - 'list-32601': tools/list answers -32601 (control: other codes
 *    still throw); the rest behave like the shared fixture.
 */
const STRICT_STDIO_SERVER_SRC = `
import * as readline from 'node:readline';
const mode = process.argv[2] || 'all-32602';
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const result = (id, r) => send({ jsonrpc: '2.0', id, result: r });
const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return;
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return result(id, { protocolVersion: '2025-11-25', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'strict-fake-70', version: '0.1.0' } });
  }
  if (method === 'ping') return result(id, {});
  if (mode === 'all-32602') {
    if (method === 'tools/list') return error(id, -32602, 'Invalid params: cursor "bad-cursor" is not valid');
    if (method === 'resources/list') return error(id, -32602, 'Invalid params: cursor "bad-cursor" is not valid');
    if (method === 'resources/read') return error(id, -32602, 'Unknown resource: ' + params?.uri);
    if (method === 'tools/call') return error(id, -32602, 'Unknown tool: ' + params?.name);
    return error(id, -32601, 'Method not found: ' + method);
  }
  // mode 'list-32601': only tools/list fails, with the WRONG code.
  if (method === 'tools/list') return error(id, -32601, 'Method not found: tools/list');
  if (method === 'resources/list') return result(id, { resources: [{ uri: 'fake://greeting', name: 'greeting' }] });
  if (method === 'resources/read') return result(id, { contents: [{ uri: 'fake://greeting', text: 'Hello from fake MCP resource' }] });
  if (method === 'tools/call') return result(id, { content: [{ type: 'text', text: 'Echo: ' + (params?.arguments?.message ?? '') }], isError: false });
  return error(id, -32601, 'Method not found: ' + method);
});
`;

async function writeStrictStdioServer() {
  const dir = makeTempDir('open-bot-strict-mcp-v070-');
  const file = path.join(dir, 'strict-mcp-server.mjs');
  await fs.promises.writeFile(file, STRICT_STDIO_SERVER_SRC);
  return file;
}

test('v0.70 SEP-1303 (stdio): -32602 for tools/list + resources/list returns [] instead of throwing', async () => {
  const serverFile = await writeStrictStdioServer();
  const client = await connectMcp({
    name: 'strict',
    command: process.execPath,
    args: [serverFile, 'all-32602'],
  });
  clients.push(client);

  assert.deepEqual(await client.listTools(), [], 'tools/list -32602 must return an empty list, not throw');
  assert.deepEqual(await client.listResources(), [], 'resources/list -32602 must return an empty list, not throw');
});

test('v0.70 SEP-1303 (stdio): -32602 for resources/read returns tool-error text instead of throwing', async () => {
  const serverFile = await writeStrictStdioServer();
  const client = await connectMcp({
    name: 'strict',
    command: process.execPath,
    args: [serverFile, 'all-32602'],
  });
  clients.push(client);

  const text = await client.readResource('fake://nope');
  assert.match(text, /^MCP tool error:/, 'resources/read -32602 must return tool-error text, not throw');
  assert.match(text, /Unknown resource: fake:\/\/nope/, 'the server message must be visible');
  assert.match(text, /-32602/, 'the code must be visible');
});

test('v0.70 SEP-1303 (stdio): other codes still throw — -32601 for tools/list, and raw -32602 via requestJsonRpc', async () => {
  const serverFile = await writeStrictStdioServer();
  const client = await connectMcp({
    name: 'strict',
    command: process.execPath,
    args: [serverFile, 'list-32601'],
  });
  clients.push(client);

  await assert.rejects(
    () => client.listTools(),
    (err) => err.code === -32601,
    'a -32601 for tools/list must still throw McpError',
  );

  // The raw path keeps throwing for -32602 too: only the typed
  // methods convert it (adapters handle the code themselves).
  const strict32602 = await connectMcp({
    name: 'strict',
    command: process.execPath,
    args: [serverFile, 'all-32602'],
  });
  clients.push(strict32602);
  await assert.rejects(
    () => strict32602.requestJsonRpc('tools/list'),
    (err) => err.code === -32602,
    'requestJsonRpc must still throw on -32602 (raw path, no conversion)',
  );
  await assert.rejects(
    () => strict32602.requestJsonRpc('bogus/method'),
    (err) => err.code === -32601,
    'requestJsonRpc must still throw on -32601',
  );
});

test('v0.70 SEP-1303 (stdio): happy path unchanged — a working server still lists + reads', async () => {
  const client = await connectMcp({
    name: 'fake',
    command: process.execPath,
    args: [FAKE_STDIO_SERVER],
  });
  clients.push(client);
  const tools = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'echo');
  const resources = await client.listResources();
  assert.equal(resources.length, 1);
  assert.equal(resources[0].uri, 'fake://greeting');
  assert.equal(await client.readResource('fake://greeting'), 'Hello from fake MCP resource');
});

// --- (a) streamable HTTP ---------------------------------------------------

/**
 * Minimal streamable-HTTP MCP server. Mode selects which method gets
 * which error: 'all-32602' answers -32602 for tools/list,
 * resources/list, resources/read and tools/call; 'list-32601' answers
 * -32601 for tools/list only.
 */
function startFakeHttpStrict(mode) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(405);
      res.end();
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
        res.writeHead(400);
        res.end();
        return;
      }
      if (msg.id === undefined || msg.id === null) {
        res.writeHead(202);
        res.end();
        return;
      }
      const send = (payload) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'test-70',
        });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...payload }));
      };
      const err = (code, message) => send({ error: { code, message } });
      if (msg.method === 'initialize') {
        return send({
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: 'fake-http-70', version: '0.1.0' },
          },
        });
      }
      if (mode === 'all-32602') {
        if (msg.method === 'tools/list') return err(-32602, 'Invalid params: cursor "bad-cursor" is not valid');
        if (msg.method === 'resources/list') return err(-32602, 'Invalid params: cursor "bad-cursor" is not valid');
        if (msg.method === 'resources/read') return err(-32602, `Unknown resource: ${msg.params?.uri}`);
        if (msg.method === 'tools/call') return err(-32602, `Unknown tool: ${msg.params?.name}`);
        return err(-32601, `Method not found: ${msg.method}`);
      }
      if (msg.method === 'tools/list') return err(-32601, 'Method not found: tools/list');
      if (msg.method === 'resources/list') {
        return send({ result: { resources: [{ uri: 'fake://greeting', name: 'greeting' }] } });
      }
      if (msg.method === 'resources/read') {
        return send({ result: { contents: [{ uri: 'fake://greeting', text: 'Hello from fake MCP resource' }] } });
      }
      if (msg.method === 'tools/call') {
        return send({ result: { content: [{ type: 'text', text: 'ok' }], isError: false } });
      }
      return err(-32601, `Method not found: ${msg.method}`);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const entry = { server, url: `http://127.0.0.1:${server.address().port}/mcp` };
      httpServers.push(entry);
      resolve(entry);
    });
  });
}

test('v0.70 SEP-1303 (HTTP): -32602 for tools/list + resources/list + resources/read is a tool error, not a throw', async () => {
  const { url } = await startFakeHttpStrict('all-32602');
  const client = await connectMcp({ name: 'fake-http', url });
  clients.push(client);

  assert.deepEqual(await client.listTools(), [], 'tools/list -32602 must return an empty list, not throw');
  assert.deepEqual(await client.listResources(), [], 'resources/list -32602 must return an empty list, not throw');
  const text = await client.readResource('fake://nope');
  assert.match(text, /^MCP tool error:/);
  assert.match(text, /Unknown resource: fake:\/\/nope/);
  assert.match(text, /-32602/);
});

test('v0.70 SEP-1303 (HTTP): -32601 for tools/list still throws', async () => {
  const { url } = await startFakeHttpStrict('list-32601');
  const client = await connectMcp({ name: 'fake-http', url });
  clients.push(client);

  await assert.rejects(
    () => client.listTools(),
    (err) => err.code === -32601,
    'a -32601 for tools/list must still throw McpError',
  );
  // Happy path on the same server: the other methods still work.
  assert.equal((await client.listResources()).length, 1);
  assert.equal(await client.readResource('fake://greeting'), 'Hello from fake MCP resource');
});

// --- (b) per-server auth tool timeout --------------------------------------

test('v0.70 auth timeout: timeoutSeconds=1 cuts the no-openUrl wait to ~1s instead of 300s', async () => {
  const ws = makeMcpWorkspace();
  const tools = createMcpTools(ws, {
    oauthStore: {},
    getOAuthConfig: async () => OAUTH_CONFIG,
  });
  const authTool = toolByName(tools, 'mcp_authenticate_crm');
  // The tool now declares the timeout argument (was: no parameters).
  assert.ok(
    authTool.definition.parameters?.properties?.timeoutSeconds,
    'the per-server auth tool must declare a timeoutSeconds parameter',
  );

  const started = Date.now();
  const result = await authTool.execute({ timeoutSeconds: 1 }, { workspaceDir: ws });
  const elapsedMs = Date.now() - started;
  assert.match(String(result), /MCP OAuth callback timed out after 1000ms/, 'the flow must time out after the 1s requested');
  assert.ok(
    elapsedMs < 10_000,
    `the wait must be cut short by the timeout (took ${elapsedMs}ms, must be well under 300s)`,
  );
});

test('v0.70 auth timeout: host-configured authTimeoutSeconds=2 is the default when no argument is passed', async () => {
  const ws = makeMcpWorkspace();
  const tools = createMcpTools(ws, {
    oauthStore: {},
    getOAuthConfig: async () => OAUTH_CONFIG,
    authTimeoutSeconds: 2,
  });
  const authTool = toolByName(tools, 'mcp_authenticate_crm');
  const started = Date.now();
  const result = await authTool.execute({}, { workspaceDir: ws });
  const elapsedMs = Date.now() - started;
  assert.match(String(result), /MCP OAuth callback timed out after 2000ms/, 'the configured 2s default must be honoured');
  assert.ok(elapsedMs < 10_000, `took ${elapsedMs}ms, must be well under 300s`);
});

test('v0.70 auth timeout: a per-call timeoutSeconds overrides the configured default', async () => {
  const ws = makeMcpWorkspace();
  const tools = createMcpTools(ws, {
    oauthStore: {},
    getOAuthConfig: async () => OAUTH_CONFIG,
    authTimeoutSeconds: 2,
  });
  const authTool = toolByName(tools, 'mcp_authenticate_crm');
  const started = Date.now();
  const result = await authTool.execute({ timeoutSeconds: 1 }, { workspaceDir: ws });
  const elapsedMs = Date.now() - started;
  assert.match(String(result), /MCP OAuth callback timed out after 1000ms/, 'the 1s argument must win over the configured 2s');
  assert.ok(elapsedMs < 10_000, `took ${elapsedMs}ms, must be well under 300s`);
});

test('v0.70 auth timeout: a non-number timeoutSeconds is a tool error, not a hang', async () => {
  const ws = makeMcpWorkspace();
  const tools = createMcpTools(ws, {
    oauthStore: {},
    getOAuthConfig: async () => OAUTH_CONFIG,
  });
  const authTool = toolByName(tools, 'mcp_authenticate_crm');
  const result = await authTool.execute({ timeoutSeconds: 'soon' }, { workspaceDir: ws });
  assert.match(String(result), /must be a number/, 'a non-number timeout must fail fast with a clear error');
});

test('v0.70 auth timeout: resolveMcpAuthTimeoutSeconds — unset/invalid defaults to 300, valid values clamp to 1–600', () => {
  assert.equal(DEFAULT_MCP_AUTH_TIMEOUT_SECONDS, 300);
  assert.equal(MAX_MCP_AUTH_TIMEOUT_SECONDS, 600);
  assert.equal(resolveMcpAuthTimeoutSeconds(undefined), 300);
  assert.equal(resolveMcpAuthTimeoutSeconds(null), 300);
  assert.equal(resolveMcpAuthTimeoutSeconds('30'), 300);
  assert.equal(resolveMcpAuthTimeoutSeconds(Number.NaN), 300);
  assert.equal(resolveMcpAuthTimeoutSeconds(Number.POSITIVE_INFINITY), 300);
  assert.equal(resolveMcpAuthTimeoutSeconds(0), 300);
  assert.equal(resolveMcpAuthTimeoutSeconds(-5), 300);
  assert.equal(resolveMcpAuthTimeoutSeconds(1), 1);
  assert.equal(resolveMcpAuthTimeoutSeconds(2.7), 2);
  assert.equal(resolveMcpAuthTimeoutSeconds(300), 300);
  assert.equal(resolveMcpAuthTimeoutSeconds(900), 600);
});

test('v0.70 auth timeout: defaultToolFactory passes host.mcpAuthTimeoutSeconds to createMcpTools', async () => {
  const ws = makeMcpWorkspace();
  const mem = new BotMemory(ws);
  try {
    const tools = defaultToolFactory(mem, ws, 'bot-1', undefined, {
      getMcpOAuthStore: () => ({}),
      getMcpOAuthConfig: async () => OAUTH_CONFIG,
      mcpAuthTimeoutSeconds: 2,
    });
    const authTool = toolByName(tools, 'mcp_authenticate_crm');
    const started = Date.now();
    const result = await authTool.execute({}, { workspaceDir: ws });
    const elapsedMs = Date.now() - started;
    assert.match(String(result), /MCP OAuth callback timed out after 2000ms/, 'the factory-wired 2s default must be honoured');
    assert.ok(elapsedMs < 10_000, `took ${elapsedMs}ms, must be well under 300s`);
  } finally {
    mem.close?.();
  }
});
