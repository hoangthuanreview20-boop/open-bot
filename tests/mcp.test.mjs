/**
 * MCP tests (node:test). Imports the BUILT packages — run the builds first:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/mcp.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMcpConfig } from '../packages/core/dist/mcp/config.js';
import {
  MCP_CLIENT_CAPABILITIES,
  MCP_PROTOCOL_VERSION,
  StdioMcpClient,
  connectMcp,
  negotiateProtocolVersion,
  toolResultToText,
} from '../packages/core/dist/mcp/client.js';
import { saveOAuthToken } from '../packages/core/dist/mcp/oauth.js';
import {
  createMcpTools,
  MCP_TOOLS,
  closeMcpClientPool,
  getMcpClientPoolSize,
} from '../packages/tools/dist/mcpTools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER = path.join(__dirname, 'fixtures', 'fake-mcp-server.mjs');

function makeWorkspace(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-mcp-test-'));
  if (config !== undefined) {
    fs.mkdirSync(path.join(dir, '.open-bot'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.open-bot', 'mcp.json'),
      typeof config === 'string' ? config : JSON.stringify(config),
      'utf8',
    );
  }
  return dir;
}

function fakeServerConfig() {
  return { servers: { fake: { command: 'node', args: [FAKE_SERVER] } } };
}

const ctx = (dir) => ({ workspaceDir: dir, botId: 'test-bot' });
const toolByName = (tools, name) => tools.find((t) => t.definition.name === name);

// --- loadMcpConfig ---------------------------------------------------------

test('loadMcpConfig: missing file -> empty servers', () => {
  const dir = makeWorkspace(undefined);
  assert.deepEqual(loadMcpConfig(dir), { servers: {} });
});

test('loadMcpConfig: invalid JSON -> clear error', () => {
  const dir = makeWorkspace('{not json');
  assert.throws(() => loadMcpConfig(dir), /Invalid MCP config.*not valid JSON/);
});

test('loadMcpConfig: server without command or url -> clear error', () => {
  const dir = makeWorkspace({ servers: { bad: {} } });
  assert.throws(() => loadMcpConfig(dir), /must have "command".*or "url"/);
});

test('loadMcpConfig: server with bad url -> clear error', () => {
  const dir = makeWorkspace({ servers: { bad: { url: 'ftp://example.com/mcp' } } });
  assert.throws(() => loadMcpConfig(dir), /must be http:\/\/ or https:\/\//);
});

test('loadMcpConfig: valid stdio config loads, name defaults to key', () => {
  const dir = makeWorkspace(fakeServerConfig());
  const cfg = loadMcpConfig(dir);
  assert.equal(cfg.servers.fake.name, 'fake');
  assert.equal(cfg.servers.fake.command, 'node');
  assert.deepEqual(cfg.servers.fake.args, [FAKE_SERVER]);
});

// --- stdio client ----------------------------------------------------------

test('stdio client: initialize, ping, list, call echo, read resource', async () => {
  const client = new StdioMcpClient({ name: 'fake', command: 'node', args: [FAKE_SERVER] });
  try {
    const info = await client.initialize();
    assert.equal(info.name, 'fake-mcp-server');
    assert.equal(info.version, '0.1.0');
    await client.ping();
    const tools = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'echo');
    assert.equal(tools[0].description, 'Echo back the input message');
    const echoed = await client.callTool('echo', { message: 'hello mcp' });
    assert.equal(echoed, 'Echo: hello mcp');
    const resources = await client.listResources();
    assert.equal(resources.length, 1);
    assert.equal(resources[0].uri, 'fake://greeting');
    const text = await client.readResource('fake://greeting');
    assert.equal(text, 'Hello from fake MCP resource');
    // v0.69d (SEP-1303): JSON-RPC -32602 cho tools/call không throw nữa
    // mà trả về dạng tool-error text để model thấy và sửa args gọi lại
    // (trước đây assert.rejects /Unknown tool/).
    const noTool = await client.callTool('no-such-tool', {});
    assert.match(noTool, /^MCP tool error:/);
    assert.match(noTool, /Unknown tool: no-such-tool/);
  } finally {
    await client.close();
  }
});

test('connectMcp factory: initializes and returns a working client', async () => {
  const client = await connectMcp({ name: 'fake', command: 'node', args: [FAKE_SERVER] });
  try {
    assert.equal(await client.callTool('echo', { message: 'via factory' }), 'Echo: via factory');
  } finally {
    await client.close();
  }
});

test('connectMcp: no command or url -> clear error', async () => {
  await assert.rejects(() => connectMcp({ name: 'bad' }), /must have "command"/);
});

// --- mcpTools --------------------------------------------------------------

test('MCP_TOOLS exports the 5 MCP tools; mcp_call_tool needs approval', () => {
  const names = MCP_TOOLS.map((t) => t.definition.name).sort();
  assert.deepEqual(names, [
    'mcp_call_tool',
    'mcp_list_resources',
    'mcp_list_servers',
    'mcp_list_tools',
    'mcp_read_resource',
  ]);
  const callTool = toolByName(MCP_TOOLS, 'mcp_call_tool');
  assert.equal(callTool.needsApproval, true);
  // No way for the agent to pass an arbitrary command: no "command" arg.
  assert.equal('command' in (callTool.definition.parameters.properties ?? {}), false);
  for (const t of MCP_TOOLS) {
    assert.equal(t.needsApproval, t.definition.name === 'mcp_call_tool');
  }
});

test('mcpTools via fake server: list servers/tools/resources, call echo, read resource', async () => {
  const dir = makeWorkspace(fakeServerConfig());
  const tools = createMcpTools(dir);
  assert.equal(tools.length, 5);

  const servers = await toolByName(tools, 'mcp_list_servers').execute({}, ctx(dir));
  assert.match(servers, /fake — stdio: node/);

  const listed = await toolByName(tools, 'mcp_list_tools').execute({ server: 'fake' }, ctx(dir));
  assert.match(listed, /echo — Echo back the input message/);

  const called = await toolByName(tools, 'mcp_call_tool').execute(
    { server: 'fake', tool: 'echo', arguments: { message: 'hello mcp' } },
    ctx(dir),
  );
  assert.equal(called, 'Echo: hello mcp');

  const resources = await toolByName(tools, 'mcp_list_resources').execute({ server: 'fake' }, ctx(dir));
  assert.match(resources, /fake:\/\/greeting/);

  const read = await toolByName(tools, 'mcp_read_resource').execute(
    { server: 'fake', uri: 'fake://greeting' },
    ctx(dir),
  );
  assert.equal(read, 'Hello from fake MCP resource');
});

test('mcpTools: unknown server -> Error string, not a throw', async () => {
  const dir = makeWorkspace(fakeServerConfig());
  const tools = createMcpTools(dir);
  const out = await toolByName(tools, 'mcp_list_tools').execute({ server: 'ghost' }, ctx(dir));
  assert.match(out, /^Error: MCP server "ghost" is not configured/);
});

test('mcpTools: no servers configured -> helpful message', async () => {
  const dir = makeWorkspace(undefined);
  const tools = createMcpTools(dir);
  const out = await toolByName(tools, 'mcp_list_servers').execute({}, ctx(dir));
  assert.match(out, /No MCP servers configured/);
});

// --- v0.9b MCP functional fixes -------------------------------------------
// Pooled stdio children from the fake-server tests would keep the test
// process alive; close the pool once the whole file is done.
after(async () => {
  await closeMcpClientPool();
});

/** In-memory OAuth store (same shape the host maps to Vault 'mcp-oauth'). */
function makeOAuthStore() {
  const map = new Map();
  return {
    get: (key) => (map.has(key) ? map.get(key) : null),
    set: (key, value) => {
      map.set(key, value);
    },
    delete: (key) => map.delete(key),
  };
}

/**
 * Mock Streamable-HTTP MCP server + OAuth token endpoint, for the v0.9b
 * OAuth/pool tests. `tools/call` only accepts `Bearer fresh-access-token`
 * (anything else -> HTTP 401); the token endpoint exchanges refresh
 * token `old-refresh-token` for that fresh token. Tracks initialize
 * count/params, auth headers seen, and token-endpoint hits.
 */
function startMockOAuthMcpServer() {
  const state = {
    initializeCount: 0,
    initializeParams: null,
    initializeAuthHeaders: [],
    toolCallAuthHeaders: [],
    tokenHits: 0,
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const sendJson = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/token' && req.method === 'POST') {
        state.tokenHits += 1;
        const params = new URLSearchParams(body);
        if (
          params.get('grant_type') === 'refresh_token' &&
          params.get('refresh_token') === 'old-refresh-token'
        ) {
          sendJson(200, {
            access_token: 'fresh-access-token',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'fresh-refresh-token',
            scope: 'read',
          });
        } else {
          sendJson(400, { error: 'invalid_grant', error_description: 'bad refresh token' });
        }
        return;
      }
      if (req.url !== '/mcp' || req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      if (msg.id === undefined || msg.id === null) {
        res.writeHead(202); // notification (e.g. notifications/initialized)
        res.end();
        return;
      }
      const auth = req.headers.authorization ?? null;
      const result = (id, resultObj) => sendJson(200, { jsonrpc: '2.0', id, result: resultObj });
      const error = (id, code, message) =>
        sendJson(200, { jsonrpc: '2.0', id, error: { code, message } });
      switch (msg.method) {
        case 'initialize':
          state.initializeCount += 1;
          state.initializeParams = msg.params;
          state.initializeAuthHeaders.push(auth);
          result(msg.id, {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: { name: 'mock-oauth-mcp', version: '0.1.0' },
          });
          break;
        case 'ping':
          result(msg.id, {});
          break;
        case 'tools/list':
          result(msg.id, {
            tools: [
              {
                name: 'echo',
                description: 'Echo back the input message',
                inputSchema: {
                  type: 'object',
                  properties: { message: { type: 'string' } },
                  required: ['message'],
                },
              },
              {
                name: 'boom',
                description: 'Always fails as a tool error',
                inputSchema: { type: 'object', properties: {}, required: [] },
              },
            ],
          });
          break;
        case 'tools/call': {
          state.toolCallAuthHeaders.push(auth);
          if (auth !== 'Bearer fresh-access-token') {
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('unauthorized');
            break;
          }
          if (msg.params?.name === 'echo') {
            result(msg.id, {
              content: [{ type: 'text', text: `Echo: ${msg.params.arguments?.message ?? ''}` }],
              isError: false,
            });
          } else if (msg.params?.name === 'boom') {
            result(msg.id, {
              content: [{ type: 'text', text: 'boom failed: bad input' }],
              isError: true,
            });
          } else {
            error(msg.id, -32602, `Unknown tool: ${msg.params?.name}`);
          }
          break;
        }
        default:
          error(msg.id, -32601, `Method not found: ${msg.method}`);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        state,
        mcpUrl: `http://127.0.0.1:${port}/mcp`,
        tokenUrl: `http://127.0.0.1:${port}/token`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function mockOAuthConfig(mock) {
  return (server) =>
    server === 'mock'
      ? {
          authorizationEndpoint: `${mock.tokenUrl}/auth`,
          tokenEndpoint: mock.tokenUrl,
          clientId: 'test-client',
        }
      : null;
}

test('v0.9b protocol: client offers 2025-11-25, negotiates older server versions', () => {
  assert.equal(MCP_PROTOCOL_VERSION, '2025-11-25');
  assert.deepEqual(MCP_CLIENT_CAPABILITIES, { experimental: {} });
  assert.equal(negotiateProtocolVersion('2025-11-25'), '2025-11-25');
  assert.equal(negotiateProtocolVersion('2024-11-05'), '2024-11-05');
  assert.equal(negotiateProtocolVersion('1999-01-01'), '2025-11-25');
  assert.equal(negotiateProtocolVersion(undefined), '2025-11-25');
});

test('v0.9b protocol fallback: stdio server answering 2024-11-05 still works', async () => {
  const client = new StdioMcpClient({ name: 'fake', command: 'node', args: [FAKE_SERVER] });
  try {
    const info = await client.initialize();
    assert.equal(info.protocolVersion, '2024-11-05');
    assert.equal(client.negotiatedProtocolVersion, '2024-11-05');
    assert.equal(await client.callTool('echo', { message: 'fallback' }), 'Echo: fallback');
  } finally {
    await client.close();
  }
});

test('v0.9b SEP-1303: tool isError returns text, does not throw', () => {
  const out = toolResultToText({
    content: [{ type: 'text', text: 'bad input: missing x' }],
    isError: true,
  });
  assert.match(out, /MCP tool error: bad input: missing x/);
  assert.equal(
    toolResultToText({ content: [{ type: 'text', text: 'ok' }], isError: false }),
    'ok',
  );
  // Transport / protocol errors still throw: a non-object result.
  assert.throws(() => toolResultToText(42), /non-object/);
});

test('v0.9b OAuth: 401 on tools/call refreshes once and retries with the fresh token', async () => {
  const mock = await startMockOAuthMcpServer();
  try {
    const oauthStore = makeOAuthStore();
    // Valid (not expired) but revoked server-side: the first tools/call
    // 401s, the client refreshes, the retry succeeds.
    await saveOAuthToken(oauthStore, 'mock', {
      accessToken: 'revoked-token',
      tokenType: 'Bearer',
      refreshToken: 'old-refresh-token',
      scope: 'read',
      expiresAt: Date.now() + 3600_000,
      obtainedAt: Date.now(),
    });
    const dir = makeWorkspace({ servers: { mock: { url: mock.mcpUrl } } });
    const tools = createMcpTools(dir, {
      oauthStore,
      getOAuthConfig: mockOAuthConfig(mock),
    });
    const out = await toolByName(tools, 'mcp_call_tool').execute(
      { server: 'mock', tool: 'echo', arguments: { message: 'hello oauth' } },
      ctx(dir),
    );
    assert.equal(out, 'Echo: hello oauth');
    assert.equal(mock.state.tokenHits, 1);
    assert.deepEqual(mock.state.toolCallAuthHeaders, [
      'Bearer revoked-token',
      'Bearer fresh-access-token',
    ]);
    // initialize offered the new protocol version + honest capabilities.
    // v0.13: the pooled client also advertises roots (the workspace is
    // wired into clientHandlers) — roots/list is a real handler.
    assert.equal(mock.state.initializeParams.protocolVersion, '2025-11-25');
    assert.deepEqual(mock.state.initializeParams.capabilities, {
      experimental: {},
      roots: { listChanged: false },
    });
  } finally {
    await closeMcpClientPool();
    await mock.close();
  }
});

test('v0.9b OAuth: expired token is refreshed before the first request (no 401)', async () => {
  const mock = await startMockOAuthMcpServer();
  try {
    const oauthStore = makeOAuthStore();
    await saveOAuthToken(oauthStore, 'mock', {
      accessToken: 'stale-token',
      tokenType: 'Bearer',
      refreshToken: 'old-refresh-token',
      scope: 'read',
      expiresAt: Date.now() - 1000,
      obtainedAt: Date.now() - 7200_000,
    });
    const dir = makeWorkspace({ servers: { mock: { url: mock.mcpUrl } } });
    const tools = createMcpTools(dir, {
      oauthStore,
      getOAuthConfig: mockOAuthConfig(mock),
    });
    const listed = await toolByName(tools, 'mcp_list_tools').execute({ server: 'mock' }, ctx(dir));
    assert.match(listed, /echo/);
    assert.equal(mock.state.tokenHits, 1);
    assert.deepEqual(mock.state.toolCallAuthHeaders, []);
    assert.deepEqual(mock.state.initializeAuthHeaders, ['Bearer fresh-access-token']);
  } finally {
    await closeMcpClientPool();
    await mock.close();
  }
});

test('v0.9b pool + SEP-1303: connections are reused and tool errors come back as text', async () => {
  const mock = await startMockOAuthMcpServer();
  try {
    const oauthStore = makeOAuthStore();
    await saveOAuthToken(oauthStore, 'mock', {
      accessToken: 'fresh-access-token',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 3600_000,
      obtainedAt: Date.now(),
    });
    const dir = makeWorkspace({ servers: { mock: { url: mock.mcpUrl } } });
    const tools = createMcpTools(dir, {
      oauthStore,
      getOAuthConfig: mockOAuthConfig(mock),
    });
    const before = getMcpClientPoolSize();
    const listed1 = await toolByName(tools, 'mcp_list_tools').execute({ server: 'mock' }, ctx(dir));
    assert.match(listed1, /echo/);
    const listed2 = await toolByName(tools, 'mcp_list_tools').execute({ server: 'mock' }, ctx(dir));
    assert.match(listed2, /boom/);
    // Two calls, one handshake: the second reused the pooled connection.
    assert.equal(mock.state.initializeCount, 1);
    assert.equal(getMcpClientPoolSize(), before + 1);
    // Tool-level error is text for the model, not an exception — and the
    // pooled connection survives it.
    const boom = await toolByName(tools, 'mcp_call_tool').execute(
      { server: 'mock', tool: 'boom', arguments: {} },
      ctx(dir),
    );
    assert.match(boom, /MCP tool error: boom failed: bad input/);
    assert.equal(mock.state.initializeCount, 1);
    // Closing the pool drops the client; the next call re-initializes.
    await closeMcpClientPool();
    assert.equal(getMcpClientPoolSize(), 0);
    await toolByName(tools, 'mcp_list_tools').execute({ server: 'mock' }, ctx(dir));
    assert.equal(mock.state.initializeCount, 2);
  } finally {
    await closeMcpClientPool();
    await mock.close();
  }
});

test('v0.9b OAuth: without wiring, a server demanding auth fails with a clear Error string', async () => {
  const mock = await startMockOAuthMcpServer();
  try {
    const dir = makeWorkspace({ servers: { mock: { url: mock.mcpUrl } } });
    const tools = createMcpTools(dir); // no oauthStore / getOAuthConfig
    const out = await toolByName(tools, 'mcp_call_tool').execute(
      { server: 'mock', tool: 'echo', arguments: { message: 'hi' } },
      ctx(dir),
    );
    assert.match(out, /^Error: MCP server "mock" HTTP 401/);
  } finally {
    await closeMcpClientPool();
    await mock.close();
  }
});
