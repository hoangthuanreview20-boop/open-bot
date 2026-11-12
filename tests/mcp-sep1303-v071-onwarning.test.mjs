/**
 * Tests for v0.71 — SEP-1303 follow-up: the `-32602` reason for
 * `tools/list` / `resources/list` must reach the caller.
 *
 * v0.70 made those two methods return `[]` instead of throwing, but
 * the return type is an array — the server's message had nowhere to
 * go, so the caller only saw "no tools/resources". v0.71 reports the
 * reason through the optional `McpServerConfig.onWarning` callback
 * (same pattern as the other runtime-injected config callbacks:
 * `authProvider`, `onAuthStepUp`); the return type stays `[]`.
 *
 * Covered here, on BOTH transports (stdio + streamable HTTP):
 *   - client level: listTools()/listResources() still return `[]`,
 *     AND onWarning receives `{ method, code: -32602, message,
 *     detail }` with the server's own message inside;
 *   - no callback passed: behaviour is unchanged (`[]`, no throw);
 *   - a throwing onWarning cannot turn the quiet `[]` into a throw;
 *   - other codes (-32601) still throw and never warn.
 * Tools level (stdio, through `createMcpTools` + the connection pool):
 *   - `mcp_list_tools` / `mcp_list_resources` show the reason when
 *     the list came back empty because of -32602;
 *   - a genuinely empty list (server answers `[]`) shows the plain
 *     "offers no tools/resources" with no reason attached;
 *   - the pool never shows a STALE warning: a server whose first
 *     tools/list is -32602 and whose second answers `[]` shows the
 *     reason on the first call only.
 *
 * No live network, no real keys: fake MCP servers on stdio /
 * localhost HTTP, like tests/mcp-sep1303-v070.test.mjs.
 *
 * Run after building core + tools:
 *   npx tsc -p packages/core/tsconfig.json
 *   npx tsc -p packages/tools/tsconfig.json
 *   node --test tests/mcp-sep1303-v071-onwarning.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectMcp } from '../packages/core/dist/mcp/client.js';
import { createMcpTools, closeMcpClientPool } from '../packages/tools/dist/mcpTools.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const tmpDirs = [];
const httpServers = [];
const clients = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
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
  await closeMcpClientPool().catch(() => undefined);
  for (const { server } of httpServers) {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  for (const dir of tmpDirs) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

// --- fake stdio server -----------------------------------------------------
//
// Modes from argv[2]:
//   - 'all-32602' (default): tools/list, resources/list, resources/read
//     and tools/call all answer -32602; anything else -32601.
//   - 'list-32601': tools/list answers -32601 (control: other codes
//     still throw, and onWarning must never fire for them).
//   - 'empty-list': tools/list and resources/list answer a genuine
//     empty list (no error) — the "server really has nothing" case.
//   - 'flaky-list': the FIRST tools/list answers -32602, later ones
//     answer a genuine empty list — the stale-warning control:
//     the reason must show on the first call only.
//   - 'happy': one tool + one resource (sanity: no warning at all).
const STDIO_SERVER_SRC = `
import * as readline from 'node:readline';
const mode = process.argv[2] || 'all-32602';
let listCalls = 0;
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
    return result(id, { protocolVersion: '2025-11-25', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'fake-71', version: '0.1.0' } });
  }
  if (method === 'ping') return result(id, {});
  if (mode === 'all-32602') {
    if (method === 'tools/list') return error(id, -32602, 'Invalid params: cursor "bad-cursor" is not valid');
    if (method === 'resources/list') return error(id, -32602, 'Invalid params: cursor "bad-cursor" is not valid');
    if (method === 'resources/read') return error(id, -32602, 'Unknown resource: ' + params?.uri);
    if (method === 'tools/call') return error(id, -32602, 'Unknown tool: ' + params?.name);
    return error(id, -32601, 'Method not found: ' + method);
  }
  if (mode === 'list-32601') {
    if (method === 'tools/list') return error(id, -32601, 'Method not found: tools/list');
    if (method === 'resources/list') return result(id, { resources: [{ uri: 'fake://greeting', name: 'greeting' }] });
    if (method === 'resources/read') return result(id, { contents: [{ uri: 'fake://greeting', text: 'Hello from fake MCP resource' }] });
    if (method === 'tools/call') return result(id, { content: [{ type: 'text', text: 'ok' }], isError: false });
    return error(id, -32601, 'Method not found: ' + method);
  }
  if (mode === 'empty-list') {
    if (method === 'tools/list') return result(id, { tools: [] });
    if (method === 'resources/list') return result(id, { resources: [] });
    return error(id, -32601, 'Method not found: ' + method);
  }
  if (mode === 'flaky-list') {
    if (method === 'tools/list') {
      listCalls += 1;
      if (listCalls === 1) return error(id, -32602, 'Invalid params: cursor "bad-cursor" is not valid');
      return result(id, { tools: [] });
    }
    if (method === 'resources/list') return result(id, { resources: [] });
    return error(id, -32601, 'Method not found: ' + method);
  }
  if (method === 'tools/list') return result(id, { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } }] });
  if (method === 'resources/list') return result(id, { resources: [{ uri: 'fake://greeting', name: 'greeting' }] });
  if (method === 'resources/read') return result(id, { contents: [{ uri: 'fake://greeting', text: 'Hello from fake MCP resource' }] });
  if (method === 'tools/call') return result(id, { content: [{ type: 'text', text: 'ok' }], isError: false });
  return error(id, -32601, 'Method not found: ' + method);
});
`;

async function writeStdioServer() {
  const dir = makeTempDir('open-bot-mcp-sep1303-v071-');
  const file = path.join(dir, 'fake-mcp-server.mjs');
  await fs.promises.writeFile(file, STDIO_SERVER_SRC);
  return file;
}

/** Workspace with one stdio MCP server `strict` in `.open-bot/mcp.json`. */
function makeStdioWorkspace(serverFile, mode) {
  const ws = makeTempDir('open-bot-mcp-sep1303-v071-ws-');
  fs.mkdirSync(path.join(ws, '.open-bot'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, '.open-bot', 'mcp.json'),
    JSON.stringify({
      servers: { strict: { command: process.execPath, args: [serverFile, mode] } },
    }),
  );
  return ws;
}

// --- fake streamable-HTTP server -------------------------------------------

function startFakeHttp(mode) {
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
          'Mcp-Session-Id': 'test-71',
        });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...payload }));
      };
      const err = (code, message) => send({ error: { code, message } });
      if (msg.method === 'initialize') {
        return send({
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: 'fake-http-71', version: '0.1.0' },
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

// --- client level: stdio ----------------------------------------------------

test('v0.71 onWarning (stdio): -32602 list rejections return [] AND report the reason', async () => {
  const serverFile = await writeStdioServer();
  const warnings = [];
  const client = await connectMcp({
    name: 'strict',
    command: process.execPath,
    args: [serverFile, 'all-32602'],
    onWarning: (w) => warnings.push(w),
  });
  clients.push(client);

  assert.deepEqual(await client.listTools(), [], 'tools/list -32602 still returns []');
  assert.deepEqual(await client.listResources(), [], 'resources/list -32602 still returns []');
  assert.equal(warnings.length, 2, 'one warning per rejected list call');

  const [toolsWarning, resourcesWarning] = warnings;
  assert.equal(toolsWarning.method, 'tools/list');
  assert.equal(toolsWarning.code, -32602);
  assert.match(toolsWarning.message, /rejected tools\/list/);
  assert.match(toolsWarning.message, /-32602/);
  assert.match(toolsWarning.message, /cursor "bad-cursor" is not valid/, 'the server detail must be in the message');
  assert.equal(toolsWarning.detail, 'Invalid params: cursor "bad-cursor" is not valid');
  assert.equal(resourcesWarning.method, 'resources/list');
  assert.equal(resourcesWarning.code, -32602);
  assert.match(resourcesWarning.message, /rejected resources\/list/);
  assert.match(resourcesWarning.message, /cursor "bad-cursor" is not valid/);
});

test('v0.71 onWarning (stdio): no callback passed — behaviour unchanged ([] , no throw)', async () => {
  const serverFile = await writeStdioServer();
  const client = await connectMcp({
    name: 'strict',
    command: process.execPath,
    args: [serverFile, 'all-32602'],
  });
  clients.push(client);

  assert.deepEqual(await client.listTools(), []);
  assert.deepEqual(await client.listResources(), []);
});

test('v0.71 onWarning (stdio): a throwing callback cannot turn the quiet [] into a throw', async () => {
  const serverFile = await writeStdioServer();
  const client = await connectMcp({
    name: 'strict',
    command: process.execPath,
    args: [serverFile, 'all-32602'],
    onWarning: () => {
      throw new Error('warning handler exploded');
    },
  });
  clients.push(client);

  assert.deepEqual(await client.listTools(), [], 'the list must still return [] when onWarning throws');
  assert.deepEqual(await client.listResources(), []);
});

test('v0.71 onWarning (stdio): -32601 still throws and never warns', async () => {
  const serverFile = await writeStdioServer();
  const warnings = [];
  const client = await connectMcp({
    name: 'strict',
    command: process.execPath,
    args: [serverFile, 'list-32601'],
    onWarning: (w) => warnings.push(w),
  });
  clients.push(client);

  await assert.rejects(
    () => client.listTools(),
    (err) => err.code === -32601,
    'a -32601 for tools/list must still throw',
  );
  assert.equal(warnings.length, 0, 'onWarning must only fire for -32602 list rejections');
  assert.equal((await client.listResources()).length, 1, 'the other methods still work');
});

test('v0.71 onWarning (stdio): happy path never warns', async () => {
  const serverFile = await writeStdioServer();
  const warnings = [];
  const client = await connectMcp({
    name: 'fake',
    command: process.execPath,
    args: [serverFile, 'happy'],
    onWarning: (w) => warnings.push(w),
  });
  clients.push(client);

  assert.equal((await client.listTools()).length, 1);
  assert.equal((await client.listResources()).length, 1);
  assert.equal(warnings.length, 0, 'a working server must not warn');
});

// --- client level: streamable HTTP ------------------------------------------

test('v0.71 onWarning (HTTP): -32602 list rejections return [] AND report the reason', async () => {
  const { url } = await startFakeHttp('all-32602');
  const warnings = [];
  const client = await connectMcp({ name: 'fake-http', url, onWarning: (w) => warnings.push(w) });
  clients.push(client);

  assert.deepEqual(await client.listTools(), [], 'tools/list -32602 still returns []');
  assert.deepEqual(await client.listResources(), [], 'resources/list -32602 still returns []');
  assert.equal(warnings.length, 2, 'one warning per rejected list call');
  assert.equal(warnings[0].method, 'tools/list');
  assert.equal(warnings[0].code, -32602);
  assert.match(warnings[0].message, /cursor "bad-cursor" is not valid/);
  assert.equal(warnings[1].method, 'resources/list');
  assert.match(warnings[1].message, /cursor "bad-cursor" is not valid/);
});

test('v0.71 onWarning (HTTP): -32601 still throws and never warns', async () => {
  const { url } = await startFakeHttp('list-32601');
  const warnings = [];
  const client = await connectMcp({ name: 'fake-http', url, onWarning: (w) => warnings.push(w) });
  clients.push(client);

  await assert.rejects(
    () => client.listTools(),
    (err) => err.code === -32601,
    'a -32601 for tools/list must still throw',
  );
  assert.equal(warnings.length, 0, 'onWarning must only fire for -32602 list rejections');
});

// --- tools level: mcp_list_tools / mcp_list_resources ------------------------

test('v0.71 tools: mcp_list_tools + mcp_list_resources show the -32602 reason instead of a bare "offers no"', async () => {
  const serverFile = await writeStdioServer();
  const ws = makeStdioWorkspace(serverFile, 'all-32602');
  const tools = createMcpTools(ws, {});
  const listTools = toolByName(tools, 'mcp_list_tools');
  const listResources = toolByName(tools, 'mcp_list_resources');

  const toolsResult = String(await listTools.execute({ server: 'strict' }, { workspaceDir: ws }));
  assert.match(toolsResult, /offers no tools/, 'the empty-list wording stays');
  assert.match(toolsResult, /cursor "bad-cursor" is not valid/, 'the server reason must be visible to the model');
  assert.match(toolsResult, /-32602/);

  const resourcesResult = String(await listResources.execute({ server: 'strict' }, { workspaceDir: ws }));
  assert.match(resourcesResult, /offers no resources/);
  assert.match(resourcesResult, /cursor "bad-cursor" is not valid/);
  assert.match(resourcesResult, /-32602/);
});

test('v0.71 tools: a genuinely empty list shows the plain message with no reason attached', async () => {
  const serverFile = await writeStdioServer();
  const ws = makeStdioWorkspace(serverFile, 'empty-list');
  const tools = createMcpTools(ws, {});
  const listTools = toolByName(tools, 'mcp_list_tools');
  const listResources = toolByName(tools, 'mcp_list_resources');

  assert.equal(
    String(await listTools.execute({ server: 'strict' }, { workspaceDir: ws })),
    'MCP server "strict" offers no tools.',
    'no warning exists, so the message must stay exactly as before',
  );
  assert.equal(
    String(await listResources.execute({ server: 'strict' }, { workspaceDir: ws })),
    'MCP server "strict" offers no resources.',
  );
});

test('v0.71 tools: the pool never shows a STALE warning — reason on the first call only', async () => {
  const serverFile = await writeStdioServer();
  const ws = makeStdioWorkspace(serverFile, 'flaky-list');
  const tools = createMcpTools(ws, {});
  const listTools = toolByName(tools, 'mcp_list_tools');

  const first = String(await listTools.execute({ server: 'strict' }, { workspaceDir: ws }));
  assert.match(first, /cursor "bad-cursor" is not valid/, 'first call: the -32602 reason shows');
  // Same pooled client, second call: the server now answers a genuine
  // empty list — without the per-call reset the first call's warning
  // would leak into this result.
  const second = String(await listTools.execute({ server: 'strict' }, { workspaceDir: ws }));
  assert.equal(
    second,
    'MCP server "strict" offers no tools.',
    'second call: no stale reason from the first call',
  );
});
