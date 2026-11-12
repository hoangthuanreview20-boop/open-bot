/**
 * v0.13 integration tests (BEYOND-ROADMAP v0.13, items 1–14):
 *
 * - Dispatcher handlers wired by connectMcp: elicitation/create (fake
 *   prompt) + roots/list over stdio, with the advertised capabilities
 *   recorded by the fake server.
 * - Streamable-HTTP client: GET SSE stream delivers a server-initiated
 *   elicitation request; the client's answer is POSTed back.
 * - OAuth step-up: HTTP 401 with WWW-Authenticate scope challenge ->
 *   onAuthStepUp refreshes with the wider scope -> retry succeeds.
 * - Registry -> marketplace: installFromRegistryEntry +
 *   installRegistryServer (local fake registry).
 * - Local API mount: MCP server (POST /mcp) + A2A server (Agent Card
 *   public, POST /a2a, GET /a2a/tasks/:id) round-trip.
 * - mcp_auth_status really refreshes an expired token; mcp_revoke
 *   revokes both tokens (RFC 7009) and clears the store.
 * - Adapters: clientAsRpcTransport (prompts + notification fan-out)
 *   and clientAsTaskTransport (createTask).
 * - WS control: elicitation-needed event + input-required +
 *   elicitation-response control message.
 * - Barrel: core index exports the v0.13 modules.
 *
 * Local fake servers only (127.0.0.1 / stdio script in a temp dir):
 * no real API key, no live x.ai.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/v013-integration.test.mjs
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { connectMcp, StreamableHttpMcpClient } from '../packages/core/dist/mcp/client.js';
import { McpDispatcher } from '../packages/core/dist/mcp/dispatcher.js';
import { createMcpServer } from '../packages/core/dist/mcp/server.js';
import { createA2aServer } from '../packages/core/dist/a2a/server.js';
import { createApiServer } from '../packages/core/dist/api/server.js';
import { listPrompts } from '../packages/core/dist/mcp/prompts.js';
import { createTask } from '../packages/core/dist/mcp/tasks.js';
import { clientAsRpcTransport, clientAsTaskTransport } from '../packages/core/dist/mcp/clientAdapters.js';
import { parseServerJson } from '../packages/core/dist/mcp/registry.js';
import {
  installFromRegistryEntry,
  installRegistryServer,
} from '../packages/core/dist/mcp/marketplace.js';
import { loadMcpConfig } from '../packages/core/dist/mcp/config.js';
import { saveOAuthToken, loadOAuthToken } from '../packages/core/dist/mcp/oauth.js';
import { createMcpSystemTools } from '../packages/tools/dist/mcpSystemTools.js';
import * as coreIndex from '../packages/core/dist/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitFor(fn, timeoutMs = 5000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = fn();
    if (got) return got;
    if (Date.now() > deadline) throw new Error('timeout chờ điều kiện sau ' + timeoutMs + 'ms');
    await sleep(stepMs);
  }
}

const closers = [];
afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop();
    try {
      await close();
    } catch {
      // best-effort
    }
  }
});

// ---------------------------------------------------------------------------
// 1. Dispatcher handlers over stdio: elicitation + roots + capabilities
// ---------------------------------------------------------------------------

const FAKE_STDIO_SERVER = `
import * as fs from 'node:fs';
const outPath = process.argv[2];
const results = { capabilities: null, responses: [] };
let buf = '';
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      results.capabilities = msg.params?.capabilities ?? null;
      fs.writeFileSync(outPath, JSON.stringify(results));
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'fake', version: '1.0.0' } } });
    } else if (msg.method === 'notifications/initialized') {
      setTimeout(() => {
        send({ jsonrpc: '2.0', id: 99, method: 'elicitation/create', params: { message: 'Tên của bạn là gì?', requestedSchema: { type: 'object', properties: { name: { type: 'string', title: 'Tên' } }, required: ['name'] } } });
        send({ jsonrpc: '2.0', id: 100, method: 'roots/list', params: {} });
      }, 50);
    } else if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      results.responses.push(msg);
      fs.writeFileSync(outPath, JSON.stringify(results));
      if (results.responses.length >= 2) process.exit(0);
    }
  }
});
setTimeout(() => process.exit(0), 8000);
`;

test('v0.13: connectMcp registers elicitation + roots handlers; capabilities advertised', async () => {
  const dir = tmpDir('v013-stdio-');
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const serverPath = path.join(dir, 'fake-server.mjs');
  fs.writeFileSync(serverPath, FAKE_STDIO_SERVER, 'utf8');
  const outPath = path.join(dir, 'results.json');

  const client = await connectMcp({
    name: 'fake',
    command: process.execPath,
    args: [serverPath, outPath],
    clientHandlers: {
      serverName: 'fake',
      workspaceDir: ws,
      elicitationPrompt: async () => ({ action: 'accept', content: { name: 'An' } }),
    },
  });
  closers.push(() => client.close());
  await waitFor(() => {
    if (!fs.existsSync(outPath)) return null;
    // The fake server rewrites this file with writeFileSync on every
    // response — a poll can catch it mid-write (empty / partial JSON).
    // Treat a torn read as "not ready yet" and keep polling instead of
    // throwing. (Flaked once in the full run at the end of wave
    // v0.51–v0.58; passes in isolation.)
    let data;
    try {
      data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    } catch {
      return null;
    }
    return data.responses.length >= 2 ? data : null;
  });

  // The server exits after the 2nd response, so the file is stable now —
  // but retry the parse briefly anyway in case the exit is still in flight.
  let data;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      break;
    } catch {
      await sleep(50);
    }
  }
  // Capability quảng cáo đúng handler thật có.
  assert.deepEqual(data.capabilities.elicitation, {});
  assert.deepEqual(data.capabilities.roots, { listChanged: false });
  assert.equal(data.capabilities.sampling, undefined);
  // elicitation/create được trả lời bằng kết quả của prompt.
  const elicitation = data.responses.find((r) => r.id === 99);
  assert.equal(elicitation.result.action, 'accept');
  assert.deepEqual(elicitation.result.content, { name: 'An' });
  // roots/list trả đúng workspace root.
  const roots = data.responses.find((r) => r.id === 100);
  assert.equal(roots.result.roots.length, 1);
  assert.ok(roots.result.roots[0].uri.startsWith('file://'));
  assert.ok(roots.result.roots[0].uri.includes('ws'));
});

// ---------------------------------------------------------------------------
// 2. Streamable HTTP: GET stream + dispatcher reply via POST
// ---------------------------------------------------------------------------

test('v0.13: HTTP client answers a server-initiated elicitation over the GET stream', async () => {
  const seen = { response: null, getOpened: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      if (req.method === 'GET') {
        seen.getOpened = true;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Mcp-Session-Id': 'sess-1',
        });
        setTimeout(() => {
          res.write('id: evt-1\n');
          res.write(
            'data: {"jsonrpc":"2.0","id":7,"method":"elicitation/create","params":{"message":"Mã xác nhận?","requestedSchema":{"type":"object","properties":{"code":{"type":"string"}},"required":["code"]}}}\n\n',
          );
        }, 100);
        return;
      }
      if (req.method === 'DELETE') {
        res.writeHead(200);
        res.end();
        return;
      }
      const msg = body ? JSON.parse(body) : {};
      if (msg.method === 'initialize') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'sess-1',
        });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              serverInfo: { name: 'fake-http', version: '1' },
            },
          }),
        );
      } else if (msg.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
      } else if (msg.result !== undefined || msg.error !== undefined) {
        seen.response = msg;
        res.writeHead(202);
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result: {} }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;

  const client = await connectMcp({
    name: 'fake-http',
    url,
    clientHandlers: {
      serverName: 'fake-http',
      elicitationPrompt: async () => ({ action: 'accept', content: { code: '123456' } }),
    },
  });
  closers.push(() => client.close());

  await waitFor(() => seen.response);
  assert.equal(seen.getOpened, true);
  assert.equal(seen.response.id, 7);
  assert.equal(seen.response.result.action, 'accept');
  assert.deepEqual(seen.response.result.content, { code: '123456' });
});

// ---------------------------------------------------------------------------
// 3. OAuth step-up on 401 with WWW-Authenticate scope challenge
// ---------------------------------------------------------------------------

test('v0.13: HTTP 401 + scope challenge -> onAuthStepUp -> retry succeeds', async () => {
  let seenScopes = null;
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(405);
        res.end();
        return;
      }
      if (req.method === 'DELETE') {
        res.writeHead(200);
        res.end();
        return;
      }
      const msg = body ? JSON.parse(body) : {};
      calls += 1;
      const auth = req.headers.authorization ?? '';
      if (msg.method === 'initialize' && auth === 'Bearer old') {
        res.writeHead(401, {
          'WWW-Authenticate': 'Bearer realm="test", scope="read write", error="insufficient_scope"',
        });
        res.end();
        return;
      }
      if (msg.method === 'initialize' && auth === 'Bearer stepped') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              serverInfo: { name: 's', version: '1' },
            },
          }),
        );
        return;
      }
      if (msg.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result: {} }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;

  const client = new StreamableHttpMcpClient({
    name: 's',
    url,
    authProvider: async () => 'Bearer old',
    onAuthStepUp: async (scopes) => {
      seenScopes = scopes;
      return 'Bearer stepped';
    },
  });
  closers.push(() => client.close());
  const info = await client.initialize();
  assert.equal(info.protocolVersion, '2025-11-25');
  assert.ok(seenScopes.includes('read') && seenScopes.includes('write'));
  assert.ok(calls >= 2, 'phải retry sau 401');
});

// ---------------------------------------------------------------------------
// 4. Registry -> marketplace install
// ---------------------------------------------------------------------------

test('v0.13: installFromRegistryEntry + installRegistryServer (fake registry)', async () => {
  const ws = tmpDir('v013-reg-');
  const entry = parseServerJson(
    JSON.stringify({
      name: 'io.example/fake-fs',
      description: 'Fake fs server',
      version: '1.0.0',
      packages: [
        {
          registryType: 'npm',
          identifier: '@example/fake-fs',
          version: '1.0.0',
          transport: { type: 'stdio' },
        },
      ],
    }),
  );
  const installed = installFromRegistryEntry(ws, entry);
  assert.equal(installed.config.command, 'npx');
  assert.deepEqual(installed.config.args, ['-y', '@example/fake-fs']);
  assert.equal(loadMcpConfig(ws).servers['fake-fs'].command, 'npx');

  const registryFile = {
    version: '1.0.0',
    servers: [
      {
        name: 'io.example/remote',
        description: 'Remote server',
        version: '2.0.0',
        remotes: [{ transportType: 'streamable-http', url: 'https://example.com/mcp' }],
      },
    ],
  };
  const regServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(registryFile));
  });
  await new Promise((resolve) => regServer.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => regServer.close(resolve)));
  const ws2 = tmpDir('v013-reg2-');
  const remote = await installRegistryServer(ws2, 'remote', {
    registryUrl: `http://127.0.0.1:${regServer.address().port}/registry.json`,
    cacheDir: path.join(ws2, '.cache'),
  });
  assert.equal(remote.config.url, 'https://example.com/mcp');
  assert.equal(loadMcpConfig(ws2).servers['remote'].url, 'https://example.com/mcp');
});

// ---------------------------------------------------------------------------
// 5. Local API mount: MCP server + A2A server
// ---------------------------------------------------------------------------

test('v0.13: Local API mounts MCP server + A2A server', async () => {
  const ws = tmpDir('v013-api-');
  fs.writeFileSync(path.join(ws, 'hello.txt'), 'xin chao v0.13', 'utf8');
  const mcpServer = createMcpServer({ workspaceDir: ws });
  const a2aServer = createA2aServer({
    // L2 (audit v0.15): A2A bắt buộc token — dùng cùng token Local API
    // ('test-token-v013'). Auth khi mount do Local API thực thi.
    token: 'test-token-v013',
    runner: async (input) => ({ text: `echo:${input.text}` }),
  });
  const server = createApiServer({
    port: 0,
    token: 'test-token-v013',
    handlers: {
      listBots: async () => [],
      runBot: async () => ({ text: '' }),
      getHistory: async () => [],
      listTasks: async () => [],
    },
    mcpServer,
    a2aServer,
  });
  await server.start();
  closers.push(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;
  const auth = { Authorization: 'Bearer test-token-v013' };

  // Agent Card public (không cần auth).
  const cardRes = await fetch(`${base}/.well-known/agent-card.json`);
  assert.equal(cardRes.status, 200);
  const card = await cardRes.json();
  assert.equal(card.name, 'open-bot');
  assert.ok(Array.isArray(card.skills));

  // /mcp cần auth; initialize + tools/list + tools/call đọc file.
  assert.equal(
    (await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status,
    401,
  );
  const initRes = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    }),
  });
  assert.equal(initRes.status, 200);
  const init = await initRes.json();
  assert.equal(init.result.protocolVersion, '2025-11-25');
  const listRes = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  const list = await listRes.json();
  assert.ok(list.result.tools.some((t) => t.name === 'workspace_read_file'));
  const callRes = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'workspace_read_file', arguments: { path: 'hello.txt' } },
    }),
  });
  const call = await callRes.json();
  assert.equal(call.result.isError, false);
  assert.ok(JSON.stringify(call.result.content).includes('xin chao v0.13'));
  // GET /mcp (SSE) bị từ chối rõ ràng.
  assert.equal((await fetch(`${base}/mcp`, { headers: auth })).status, 405);

  // /a2a: message:send chạy tới xong, tasks/get đọc lại được.
  const sendRes = await fetch(`${base}/a2a`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'message:send',
      params: {
        message: { role: 'user', parts: [{ kind: 'text', text: 'hello a2a' }] },
      },
    }),
  });
  assert.equal(sendRes.status, 200);
  const sent = await sendRes.json();
  assert.equal(sent.result.status.state, 'completed');
  assert.ok(JSON.stringify(sent.result.artifacts).includes('echo:hello a2a'));
  const taskId = sent.result.id;
  const getRes = await fetch(`${base}/a2a/tasks/${taskId}`, { headers: auth });
  assert.equal(getRes.status, 200);
  const got = await getRes.json();
  assert.equal(got.id, taskId);
  assert.equal((await fetch(`${base}/a2a/tasks/nope`, { headers: auth })).status, 404);
});

// ---------------------------------------------------------------------------
// 6. mcp_auth_status (real refresh) + mcp_revoke
// ---------------------------------------------------------------------------

test('v0.13: mcp_auth_status refreshes expired token; mcp_revoke revokes both', async () => {
  const revokeCalls = [];
  const oauthServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/.well-known/oauth-authorization-server') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer: `http://127.0.0.1:${oauthServer.address().port}`,
            authorization_endpoint: `http://127.0.0.1:${oauthServer.address().port}/authorize`,
            token_endpoint: `http://127.0.0.1:${oauthServer.address().port}/token`,
            revocation_endpoint: `http://127.0.0.1:${oauthServer.address().port}/revoke`,
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/token') {
        const params = new URLSearchParams(body);
        assert.equal(params.get('grant_type'), 'refresh_token');
        assert.equal(params.get('refresh_token'), 'r1');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'new-access',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'r2',
            scope: 'read',
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/revoke') {
        revokeCalls.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve) => oauthServer.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => oauthServer.close(resolve)));
  const base = `http://127.0.0.1:${oauthServer.address().port}`;

  const storeMap = new Map();
  const store = {
    get: (k) => storeMap.get(k) ?? null,
    set: (k, v) => {
      storeMap.set(k, v);
    },
    delete: (k) => storeMap.delete(k),
  };
  await saveOAuthToken(store, 'srv', {
    accessToken: 'old',
    tokenType: 'Bearer',
    refreshToken: 'r1',
    expiresAt: Date.now() - 5000,
    scope: 'read',
    obtainedAt: Date.now() - 10000,
  });
  const tools = createMcpSystemTools({
    oauthStore: store,
    getOAuthConfig: () => ({
      authorizationEndpoint: `${base}/authorize`,
      tokenEndpoint: `${base}/token`,
      clientId: 'c1',
    }),
  });
  const byName = (name) => tools.find((t) => t.definition.name === name);
  assert.ok(byName('mcp_revoke'), 'mcp_revoke phải tồn tại');

  const status = await byName('mcp_auth_status').execute({ server: 'srv' }, {});
  assert.match(status, /refreshed/);
  const refreshed = await loadOAuthToken(store, 'srv');
  assert.equal(refreshed.accessToken, 'new-access');

  const revoked = await byName('mcp_revoke').execute({ server: 'srv' }, {});
  assert.match(revoked, /Revoked 2 token/);
  assert.equal(revokeCalls.length, 2);
  assert.equal(await loadOAuthToken(store, 'srv'), null);
});

// ---------------------------------------------------------------------------
// 7. Adapters: prompts/tasks qua client thật (fake)
// ---------------------------------------------------------------------------

test('v0.13: client adapters bridge tasks + prompts + notifications', async () => {
  const dispatcher = new McpDispatcher();
  const calls = [];
  const fakeClient = {
    requestJsonRpc: async (method, params) => {
      calls.push([method, params]);
      if (method === 'prompts/list') {
        return {
          prompts: [
            { name: 'greet', description: 'Chào', arguments: [{ name: 'name', required: true }] },
          ],
        };
      }
      // createTask gửi method gốc (tools/call) kèm _meta.task — server
      // trả task handle thay vì kết quả.
      if (method === 'tools/call') return { taskId: 't-1', status: 'working' };
      if (method === 'tasks/get') {
        return { taskId: 't-1', status: 'completed' };
      }
      if (method === 'tasks/result') {
        return { content: [{ type: 'text', text: 'done' }] };
      }
      throw new Error('unknown ' + method);
    },
    getDispatcher: () => dispatcher,
  };

  const rpc = clientAsRpcTransport(fakeClient);
  const prompts = await listPrompts(rpc);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].name, 'greet');

  let seen = null;
  const off = rpc.onNotification((method, params) => {
    seen = [method, params];
  });
  await dispatcher.dispatch({
    jsonrpc: '2.0',
    method: 'notifications/resources/updated',
    params: { uri: 'file:///x' },
  });
  assert.deepEqual(seen, ['notifications/resources/updated', { uri: 'file:///x' }]);
  off();

  const taskTransport = clientAsTaskTransport(fakeClient);
  const handle = await createTask(taskTransport, 'tools/call', {
    name: 'echo',
    arguments: {},
  });
  assert.equal(handle.taskId, 't-1');
  const done = await handle.waitForCompletion({ timeoutMs: 3000 });
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.result, { content: [{ type: 'text', text: 'done' }] });
});

// ---------------------------------------------------------------------------
// 8. Barrel exports
// ---------------------------------------------------------------------------

test('v0.13: core barrel exports the new modules', () => {
  for (const name of [
    'createMcpServer',
    'createA2aServer',
    'A2aClient',
    'registerDefaultMcpClientHandlers',
    'buildMcpClientCapabilities',
    'clientAsRpcTransport',
    'clientAsTaskTransport',
    'StreamableHttpTransport',
    'ElicitationUrlTracker',
    'createElicitationHandler',
    'installMcpServerFromRemoteRegistry',
    'installMcpServerFromRegistryEntry',
    'checkMcpAuthStatus',
    'revokeStoredOAuthToken',
    'refreshWithStepUpScope',
    'discoverOAuthForResource',
    'createTask',
    'TaskHandle',
    'listPrompts',
    'getPrompt',
    'ResourceWatcher',
  ]) {
    assert.equal(typeof coreIndex[name], 'function', `barrel thiếu ${name}`);
  }
});

// ---------------------------------------------------------------------------
// 9. WS control: elicitation-needed + elicitation-response
// ---------------------------------------------------------------------------

test('v0.13: WS elicitation-needed event + elicitation-response control message', async () => {
  const answered = { promise: null, resolve: null };
  answered.promise = new Promise((resolve) => {
    answered.resolve = resolve;
  });
  const calls = { respondElicitation: [] };
  const handlers = {
    listBots: async () => [{ id: 'bot-1', name: 'T', providerId: 'ollama', model: 'q' }],
    runBot: async () => ({ text: '' }),
    runBotStream: async (_botId, _text, emit) => {
      emit({
        kind: 'elicitation-needed',
        data: {
          elicitationId: 'el-1',
          serverName: 'srv',
          message: 'Tên?',
          mode: 'form',
          fields: [{ name: 'name', type: 'string', required: true }],
        },
      });
      await answered.promise;
      emit({ kind: 'summary', data: 'done' });
      return { text: 'done' };
    },
    respondElicitation: async (elicitationId, action, content) => {
      calls.respondElicitation.push([elicitationId, action, content]);
      answered.resolve();
      return { found: true };
    },
    getHistory: async () => [],
    listTasks: async () => [],
  };
  const server = createApiServer({ port: 0, token: 'tok-v013-ws', handlers });
  await server.start();
  closers.push(() => server.stop());

  const ws = new WebSocket(
    `ws://127.0.0.1:${server.port}/v1/bots/bot-1/run/stream?text=${encodeURIComponent('hi')}`,
    { headers: { Authorization: 'Bearer tok-v013-ws' } },
  );
  const messages = [];
  const waiters = [];
  closers.push(async () => {
    try {
      ws.close();
    } catch {
      // ignore
    }
  });
  const waitForMsg = (pred, timeoutMs = 5000) =>
    new Promise((resolve, reject) => {
      const found = messages.find(pred);
      if (found) return resolve(found);
      const timer = setTimeout(() => reject(new Error('timeout chờ WS message')), timeoutMs);
      waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    messages.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        waiters.splice(i, 1)[0].resolve(msg);
      }
    }
  };

  const ev = await waitForMsg((m) => m.kind === 'elicitation-needed');
  assert.equal(ev.data.elicitationId, 'el-1');
  const waiting = await waitForMsg(
    (m) => m.kind === 'input-required' && m.data.waitingFor === 'elicitation-needed',
  );
  assert.equal(waiting.data.elicitationId, 'el-1');
  ws.send(
    JSON.stringify({
      type: 'elicitation-response',
      elicitationId: 'el-1',
      action: 'accept',
      content: { name: 'An' },
    }),
  );
  await waitForMsg((m) => m.kind === 'summary');
  assert.deepEqual(calls.respondElicitation[0], ['el-1', 'accept', { name: 'An' }]);
});
