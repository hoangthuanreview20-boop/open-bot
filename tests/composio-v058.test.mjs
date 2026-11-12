/**
 * Tests for Composio execution path (v0.58): runnable meta-tools,
 * session/MCP client caching, defaultToolFactory gate, coordinator
 * RPC `composio.setState` / `composio.getState` (in-process + qua
 * NDJSON-RPC thật), key đọc trực tiếp từ file Vault của main.
 *
 * Run after building core + tools:
 *   npm run build
 *   node --test tests/composio-v058.test.mjs
 *
 * No live network, no real Composio account/key: the "key" is the fake
 * string FAKE_KEY below, the REST + MCP endpoints are a local
 * http://127.0.0.1 server (mở rộng từ tests/composio-v057.test.mjs
 * thêm COMPOSIO_GET_TOOL_SCHEMAS + lỗi isError), and the Vault used
 * is a temp dir (LocalEncryptor — đúng trường hợp coordinator đọc
 * được file; trường hợp main dùng safeStorage thì reader trả null,
 * xem docs/composio-integration.md §11, không test được ở đây vì
 * không có Electron).
 */
import { test, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import http from 'node:http';

import {
  COMPOSIO_GET_TOOL_SCHEMAS,
  COMPOSIO_MULTI_EXECUTE_TOOL,
  COMPOSIO_SEARCH_TOOL,
  COMPOSIO_TOOLKIT_SLUGS,
  ComposioAppSource,
  ComposioError,
  ComposioSessionManager,
  createComposioMetaTools,
  createComposioVaultFileKeyReader,
  setComposioApiKey,
} from '../packages/core/dist/composio/index.js';
import {
  AppRegistry,
  BUILTIN_APPS,
  applyAppToolCaps,
} from '../packages/core/dist/apps/index.js';
import { filterTools } from '../packages/core/dist/agent/toolFilter.js';
import { AgentCoordinator, defaultToolFactory } from '../packages/core/dist/coordinator/coordinator.js';
import { CoordinatorClient } from '../packages/core/dist/coordinator/client.js';
import { BotMemory } from '../packages/core/dist/agent/memory.js';
import { Vault } from '../packages/core/dist/vault/vault.js';

/** Fake key — distinctive so tests can prove it never leaks. */
const FAKE_KEY = 'ck_mock_SECRET_12345_do_not_use';
const FAKE_KEY_2 = 'ck_mock_SECRET_67890_rotated';
const FAKE_USER = 'local-user-1';

const tmpDirs = [];
const servers = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Mock Composio backend on 127.0.0.1 (như v0.57, thêm
 * COMPOSIO_GET_TOOL_SCHEMAS + lỗi isError khi execute slug lạ).
 * REST Tool Router + MCP endpoint mà session URL trỏ tới.
 */
function startMockComposio() {
  const state = {
    sessionCreates: 0,
    searchCalls: 0,
    schemaCalls: 0,
    executeCalls: 0,
    lastExecuteArgs: null,
    lastSchemaArgs: null,
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
      const base = `http://127.0.0.1:${server.address().port}`;
      if (req.url === '/api/v3.1/tool_router/session' && req.method === 'POST') {
        if (req.headers['x-api-key'] !== FAKE_KEY && req.headers['x-api-key'] !== FAKE_KEY_2) {
          sendJson(401, { error: 'invalid api key' });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          sendJson(400, { error: 'bad json' });
          return;
        }
        // v0.72 (live test thật): wire shape là policy object
        // `{toolkits: {enable: [...]}}` — mảng string thẳng bị server
        // thật trả HTTP 400, mock bắt chước để regression bị bắt.
        if (
          parsed.toolkits !== undefined &&
          (typeof parsed.toolkits !== 'object' ||
            parsed.toolkits === null ||
            !Array.isArray(parsed.toolkits.enable))
        ) {
          sendJson(400, { error: 'Error in payload.toolkits: Invalid input' });
          return;
        }
        state.sessionCreates += 1;
        sendJson(200, {
          session_id: `sess-mock-${state.sessionCreates}`,
          mcp: {
            url: `${base}/mcp`,
            headers: { 'x-api-key': req.headers['x-api-key'] },
          },
          toolkits: parsed.toolkits?.enable ?? [],
        });
        return;
      }
      if (req.url !== '/mcp' || req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.headers['x-api-key'] !== FAKE_KEY && req.headers['x-api-key'] !== FAKE_KEY_2) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('unauthorized');
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
      const result = (id, resultObj) => sendJson(200, { jsonrpc: '2.0', id, result: resultObj });
      const error = (id, code, message) =>
        sendJson(200, { jsonrpc: '2.0', id, error: { code, message } });
      switch (msg.method) {
        case 'initialize':
          result(msg.id, {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: { name: 'mock-composio-tool-router', version: '0.1.0' },
          });
          break;
        case 'ping':
          result(msg.id, {});
          break;
        case 'tools/list':
          result(msg.id, {
            tools: [
              'COMPOSIO_SEARCH_TOOLS',
              'COMPOSIO_GET_TOOL_SCHEMAS',
              'COMPOSIO_MULTI_EXECUTE_TOOL',
              'COMPOSIO_MANAGE_CONNECTIONS',
              'COMPOSIO_WAIT_FOR_CONNECTIONS',
              'COMPOSIO_REMOTE_WORKBENCH',
              'COMPOSIO_REMOTE_BASH_TOOL',
            ].map((name) => ({
              name,
              description: `Mock meta-tool ${name}`,
              inputSchema: { type: 'object', properties: {} },
            })),
          });
          break;
        case 'tools/call': {
          const name = msg.params?.name;
          if (name === 'COMPOSIO_SEARCH_TOOLS') {
            state.searchCalls += 1;
            result(msg.id, {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    tools: [{ slug: 'GMAIL_SEND_EMAIL', description: 'Send an email' }],
                  }),
                },
              ],
              isError: false,
            });
          } else if (name === 'COMPOSIO_GET_TOOL_SCHEMAS') {
            state.schemaCalls += 1;
            state.lastSchemaArgs = msg.params?.arguments ?? null;
            // v0.72 (live test thật): wire shape là `{tool_slugs: [...]}` —
            // server thật từ chối khi thiếu tool_slugs, mock bắt chước.
            const wireSlugs = msg.params?.arguments?.tool_slugs;
            if (!Array.isArray(wireSlugs)) {
              result(msg.id, {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      successful: false,
                      data: {},
                      error:
                        'Invalid request for COMPOSIO_GET_TOOL_SCHEMAS: Validation error: Required at "tool_slugs"',
                    }),
                  },
                ],
                isError: true,
              });
              return;
            }
            // v0.85: shape response THẬT (live v0.72 + fetch lại ở
            // probe-write-schemas): `{successful, data:
            // {tool_schemas: {<slug>: {input_schema}}}}` — shape cũ
            // `{schemas: [{slug, input_parameters}]}` là mock bịa.
            result(msg.id, {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    successful: true,
                    data: {
                      tool_schemas: {
                        GMAIL_SEND_EMAIL: {
                          input_schema: {
                            type: 'object',
                            required: [],
                            properties: {
                              recipient_email: { type: 'string' },
                              subject: { type: 'string' },
                              body: { type: 'string' },
                              cc: { type: 'array', items: { type: 'string' } },
                              bcc: { type: 'array', items: { type: 'string' } },
                            },
                          },
                        },
                      },
                    },
                  }),
                },
              ],
              isError: false,
            });
          } else if (name === 'COMPOSIO_MULTI_EXECUTE_TOOL') {
            state.executeCalls += 1;
            state.lastExecuteArgs = msg.params?.arguments ?? null;
            const tools = msg.params?.arguments?.tools ?? [];
            const unknown = tools.find((t) => t.tool_slug === 'UNKNOWN_SLUG');
            if (unknown) {
              result(msg.id, {
                content: [{ type: 'text', text: 'Tool UNKNOWN_SLUG not found' }],
                isError: true,
              });
            } else {
              result(msg.id, {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      results: [{ tool_slug: 'GMAIL_SEND_EMAIL', successful: true, data: { id: 'mock-msg-1' } }],
                    }),
                  },
                ],
                isError: false,
              });
            }
          } else {
            error(msg.id, -32602, `Unknown tool: ${name}`);
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
      servers.push(server);
      resolve({ server, state, port: server.address().port });
    });
  });
}

function mockFetchFn() {
  return async (url, init) => {
    const res = await fetch(url, init);
    return { status: res.status, text: async () => res.text() };
  };
}

function makeManager(mock, opts = {}) {
  return new ComposioSessionManager({
    getApiKey: opts.getApiKey ?? (() => FAKE_KEY),
    userId: FAKE_USER,
    getEnabledToolkits: opts.getEnabledToolkits ?? (() => ['gmail']),
    baseUrl: `http://127.0.0.1:${mock.port}/api/v3.1`,
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : { fetchFn: mockFetchFn() }),
  });
}

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `expected tool ${name} in [${tools.map((t) => t.definition.name).join(', ')}]`);
  return tool;
}

// ---------------------------------------------------------------------------
// A. Meta-tool runnable qua session manager (mock REST + MCP thật)
// ---------------------------------------------------------------------------

test('composio v058: search → schemas → multi-execute end-to-end, 1 session cho cả 3 call', async () => {
  const mock = await startMockComposio();
  const manager = makeManager(mock);
  const tools = createComposioMetaTools({ manager });
  assert.deepEqual(
    tools.map((t) => t.definition.name).sort(),
    [COMPOSIO_GET_TOOL_SCHEMAS, COMPOSIO_MULTI_EXECUTE_TOOL, COMPOSIO_SEARCH_TOOL].sort(),
  );
  assert.equal(toolByName(tools, COMPOSIO_MULTI_EXECUTE_TOOL).needsApproval, true);
  assert.equal(toolByName(tools, COMPOSIO_SEARCH_TOOL).needsApproval, false);
  assert.equal(toolByName(tools, COMPOSIO_GET_TOOL_SCHEMAS).needsApproval, false);

  const ctx = { workspaceDir: tmpDir('composio-v058-ws-'), botId: 'bot-test' };
  const found = await toolByName(tools, COMPOSIO_SEARCH_TOOL).execute({ query: 'gửi mail cho Lan' }, ctx);
  assert.ok(found.includes('GMAIL_SEND_EMAIL'));
  const schemas = await toolByName(tools, COMPOSIO_GET_TOOL_SCHEMAS).execute(
    { tools: ['GMAIL_SEND_EMAIL'] },
    ctx,
  );
  assert.ok(schemas.includes('recipient_email'));
  // v0.85: mock GET_TOOL_SCHEMAS trả shape THẬT
  // {data: {tool_schemas: {<slug>: {input_schema}}}}.
  assert.deepEqual(
    JSON.parse(schemas).data.tool_schemas['GMAIL_SEND_EMAIL'].input_schema.properties,
    {
      recipient_email: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
      cc: { type: 'array', items: { type: 'string' } },
      bcc: { type: 'array', items: { type: 'string' } },
    },
  );
  assert.deepEqual(mock.state.lastSchemaArgs, { tool_slugs: ['GMAIL_SEND_EMAIL'] });
  const out = await toolByName(tools, COMPOSIO_MULTI_EXECUTE_TOOL).execute(
    { tools: [{ tool: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'lan@example.com', subject: '[open-bot live test] mock', body: 'mock only' } }] },
    ctx,
  );
  assert.ok(out.includes('mock-msg-1'));
  assert.deepEqual(mock.state.lastExecuteArgs, {
    tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'lan@example.com', subject: '[open-bot live test] mock', body: 'mock only' } }],
  });
  // Session + MCP client được cache: 3 meta-tool call chỉ tạo 1 session.
  assert.equal(mock.state.sessionCreates, 1);
  assert.equal(manager.sessionsCreated(), 1);
  assert.equal(manager.isConnected(), true);
  assert.equal(mock.state.searchCalls, 1);
  assert.equal(mock.state.schemaCalls, 1);
  assert.equal(mock.state.executeCalls, 1);
  await manager.close();
});

test('composio v058: key thiếu → lỗi sạch composio_key_missing, không crash, không lộ key', async () => {
  const mock = await startMockComposio();
  const manager = makeManager(mock, { getApiKey: () => null });
  const tools = createComposioMetaTools({ manager });
  const ctx = { workspaceDir: tmpDir('composio-v058-ws-'), botId: 'bot-test' };
  await assert.rejects(
    toolByName(tools, COMPOSIO_SEARCH_TOOL).execute({ query: 'gửi mail' }, ctx),
    (err) => {
      assert.ok(err instanceof ComposioError);
      assert.equal(err.code, 'composio_key_missing');
      assert.ok(!err.message.includes(FAKE_KEY));
      return true;
    },
  );
  await assert.rejects(
    toolByName(tools, COMPOSIO_MULTI_EXECUTE_TOOL).execute(
      { tools: [{ tool: 'GMAIL_SEND_EMAIL', arguments: {} }] },
      ctx,
    ),
    (err) => err instanceof ComposioError && err.code === 'composio_key_missing',
  );
  // Không tạo session nào khi chưa có key.
  assert.equal(mock.state.sessionCreates, 0);
  assert.equal(manager.isConnected(), false);
  await manager.close();
});

test('composio v058: fetch lỗi mang theo key → message ném ra đã lọc key', async () => {
  const mock = await startMockComposio();
  const manager = makeManager(mock, {
    fetchFn: async () => {
      throw new Error(`network boom ${FAKE_KEY} end`);
    },
  });
  const tools = createComposioMetaTools({ manager });
  const ctx = { workspaceDir: tmpDir('composio-v058-ws-'), botId: 'bot-test' };
  await assert.rejects(
    toolByName(tools, COMPOSIO_SEARCH_TOOL).execute({ query: 'gửi mail' }, ctx),
    (err) => {
      assert.ok(err instanceof ComposioError);
      assert.ok(!err.message.includes(FAKE_KEY), 'error must not contain the key');
      assert.ok(err.message.includes('[composio-key-redacted]'));
      return true;
    },
  );
  await manager.close();
});

test('composio v058: validate args — rỗng/sai shape → lỗi rõ, không gọi mạng', async () => {
  const mock = await startMockComposio();
  const manager = makeManager(mock);
  const tools = createComposioMetaTools({ manager });
  const ctx = { workspaceDir: tmpDir('composio-v058-ws-'), botId: 'bot-test' };
  await assert.rejects(
    toolByName(tools, COMPOSIO_SEARCH_TOOL).execute({ query: '   ' }, ctx),
    /cần `query`/,
  );
  await assert.rejects(
    toolByName(tools, COMPOSIO_GET_TOOL_SCHEMAS).execute({ tools: [] }, ctx),
    /cần `tools`/,
  );
  await assert.rejects(
    toolByName(tools, COMPOSIO_MULTI_EXECUTE_TOOL).execute({ tools: [] }, ctx),
    /cần `tools`/,
  );
  await assert.rejects(
    toolByName(tools, COMPOSIO_MULTI_EXECUTE_TOOL).execute(
      { tools: [{ tool: 'GMAIL_SEND_EMAIL', arguments: 'not-an-object' }] },
      ctx,
    ),
    /cần `arguments` là object/,
  );
  // >50 tool bị chặn trước khi gọi mạng (router).
  const fiftyOne = Array.from({ length: 51 }, () => ({
    tool: 'GMAIL_FETCH_EMAILS',
    arguments: {},
  }));
  await assert.rejects(
    toolByName(tools, COMPOSIO_MULTI_EXECUTE_TOOL).execute({ tools: fiftyOne }, ctx),
    /tối đa 50/,
  );
  assert.equal(mock.state.sessionCreates, 0);
  await manager.close();
});

test('composio v058: toolkit đổi / invalidate() → session mới ở lần gọi sau', async () => {
  const mock = await startMockComposio();
  let toolkits = ['gmail'];
  const manager = makeManager(mock, { getEnabledToolkits: () => [...toolkits] });
  const tools = createComposioMetaTools({ manager });
  const ctx = { workspaceDir: tmpDir('composio-v058-ws-'), botId: 'bot-test' };
  await toolByName(tools, COMPOSIO_SEARCH_TOOL).execute({ query: 'gửi mail' }, ctx);
  assert.equal(mock.state.sessionCreates, 1);
  toolkits = ['gmail', 'github'];
  await toolByName(tools, COMPOSIO_SEARCH_TOOL).execute({ query: 'tạo issue' }, ctx);
  assert.equal(mock.state.sessionCreates, 2);
  await manager.invalidate();
  assert.equal(manager.isConnected(), false);
  await toolByName(tools, COMPOSIO_SEARCH_TOOL).execute({ query: 'gửi mail' }, ctx);
  assert.equal(mock.state.sessionCreates, 3);
  await manager.close();
});

test('composio v058: MCP báo isError → ComposioError sạch, không crash turn', async () => {
  const mock = await startMockComposio();
  const manager = makeManager(mock);
  const tools = createComposioMetaTools({ manager });
  const ctx = { workspaceDir: tmpDir('composio-v058-ws-'), botId: 'bot-test' };
  await assert.rejects(
    toolByName(tools, COMPOSIO_MULTI_EXECUTE_TOOL).execute(
      { tools: [{ tool: 'UNKNOWN_SLUG', arguments: {} }] },
      ctx,
    ),
    (err) => {
      assert.ok(err instanceof ComposioError);
      assert.equal(err.code, 'composio_session_failed');
      assert.ok(err.message.includes('UNKNOWN_SLUG'));
      return true;
    },
  );
  await manager.close();
});

// ---------------------------------------------------------------------------
// B. Key reader đọc trực tiếp file Vault (LocalEncryptor)
// ---------------------------------------------------------------------------

test('composio v058: key reader — không dataDir → null; key đổi trên đĩa được thấy; file hỏng/mất → null', () => {
  assert.equal(createComposioVaultFileKeyReader(null)(), null);
  assert.equal(createComposioVaultFileKeyReader(undefined)(), null);
  const dir = tmpDir('composio-v058-vault-');
  const vault = new Vault({ storePath: path.join(dir, 'vault.json') });
  setComposioApiKey(vault, FAKE_KEY);
  const readKey = createComposioVaultFileKeyReader(dir);
  assert.equal(readKey(), FAKE_KEY);
  // Key xoay trong main (Vault instance khác, cùng file) → reader thấy ở lần đọc sau.
  const vault2 = new Vault({ storePath: path.join(dir, 'vault.json') });
  setComposioApiKey(vault2, FAKE_KEY_2);
  assert.equal(readKey(), FAKE_KEY_2);
  // File mất → null (fail-closed); file hỏng → null, không ném.
  fs.rmSync(path.join(dir, 'vault.json'));
  assert.equal(readKey(), null);
  fs.writeFileSync(path.join(dir, 'vault.json'), 'not json {{{');
  assert.equal(readKey(), null);
});

// ---------------------------------------------------------------------------
// C. Gate trong defaultToolFactory + cap/filter
// ---------------------------------------------------------------------------

test('composio v058: gate defaultToolFactory — không tiêm host → vắng; tiêm → có mặt', async () => {
  const mock = await startMockComposio();
  const manager = makeManager(mock);
  const metaTools = createComposioMetaTools({ manager });
  const ws = tmpDir('composio-v058-gate-');
  const memory = new BotMemory(ws);
  try {
    const offTools = defaultToolFactory(memory, ws, 'bot-gate');
    const offNames = offTools.map((t) => t.definition.name);
    assert.ok(!offNames.includes(COMPOSIO_SEARCH_TOOL));
    assert.ok(!offNames.includes(COMPOSIO_GET_TOOL_SCHEMAS));
    assert.ok(!offNames.includes(COMPOSIO_MULTI_EXECUTE_TOOL));

    const onTools = defaultToolFactory(memory, ws, 'bot-gate', undefined, {
      getComposioTools: () => metaTools,
    });
    const onNames = onTools.map((t) => t.definition.name);
    assert.ok(onNames.includes(COMPOSIO_SEARCH_TOOL));
    assert.ok(onNames.includes(COMPOSIO_GET_TOOL_SCHEMAS));
    assert.ok(onNames.includes(COMPOSIO_MULTI_EXECUTE_TOOL));
  } finally {
    memory.close();
    await manager.close();
  }
});

test('composio v058: meta-tool thuộc app composio → cap M7 + filterTools áp như tool local', async () => {
  const mock = await startMockComposio();
  const manager = makeManager(mock);
  const metaTools = createComposioMetaTools({ manager });
  const ws = tmpDir('composio-v058-cap-');
  const memory = new BotMemory(ws);
  try {
    const registry = new AppRegistry(BUILTIN_APPS);
    const source = new ComposioAppSource({ registry, hasApiKey: () => true });
    source.setEnabled(true);
    assert.equal(registry.appIdForTool(COMPOSIO_SEARCH_TOOL), 'composio');
    assert.equal(registry.appIdForTool(COMPOSIO_MULTI_EXECUTE_TOOL), 'composio');
    // Cap riêng cho app composio (2) cắt đúng 1 meta-tool, như cap M7 ở loop.
    const tools = defaultToolFactory(memory, ws, 'bot-cap', undefined, {
      getComposioTools: () => metaTools,
    });
    const { tools: kept, capped } = applyAppToolCaps(tools, { composio: 2 }, registry);
    assert.equal(kept.filter((t) => t.definition.name.startsWith('COMPOSIO_')).length, 2);
    const composioCap = capped.find((c) => c.appId === 'composio');
    assert.ok(composioCap, 'expected a cap report for app composio');
    assert.equal(composioCap.cap, 2);
    assert.equal(composioCap.droppedToolNames.length, 1);
    // filterTools allowlist giữ / bỏ meta-tool như tool thường.
    const allowed = filterTools(tools, { allowedTools: [COMPOSIO_SEARCH_TOOL] });
    assert.ok(allowed.some((t) => t.definition.name === COMPOSIO_SEARCH_TOOL));
    assert.ok(!allowed.some((t) => t.definition.name === COMPOSIO_MULTI_EXECUTE_TOOL));
  } finally {
    memory.close();
    await manager.close();
  }
});

// ---------------------------------------------------------------------------
// D. Coordinator RPC in-process (handle trực tiếp)
// ---------------------------------------------------------------------------

let coordMock;
let coordDir;
let coordinator;
const coordBots = [];
/**
 * Fixture dùng chung cho section D — KHÔNG đi qua tmpDir()/servers
 * (afterEach ở trên dọn 2 mảng đó sau mỗi test, fixture này phải sống
 * suốt file nên dọn riêng trong after()).
 */
const coordTmpDirs = [];

before(async () => {
  coordMock = await startMockComposio();
  servers.splice(servers.indexOf(coordMock.server), 1);
  coordDir = fs.mkdtempSync(path.join(os.tmpdir(), 'composio-v058-coord-'));
  coordTmpDirs.push(coordDir);
  const vault = new Vault({ storePath: path.join(coordDir, 'vault.json') });
  setComposioApiKey(vault, FAKE_KEY);
  coordinator = new AgentCoordinator({
    dataDir: coordDir,
    composio: {
      baseUrl: `http://127.0.0.1:${coordMock.port}/api/v3.1`,
      fetchFn: mockFetchFn(),
    },
  });
});

after(async () => {
  for (const botId of coordBots.splice(0)) {
    try {
      await coordinator.destroyBot({ botId });
    } catch {
      // Bot có thể đã bị xoá — bỏ qua.
    }
  }
  try {
    coordinator.shutdown();
  } catch {
    // Bỏ qua — shutdown là best-effort ở đây.
  }
  await new Promise((resolve) => coordMock.server.close(() => resolve()));
  for (const dir of coordTmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(async () => {
  // Reset Composio về TẮT sau mỗi test (trả registry dùng chung về mặc định)
  // — giữ nguyên selection đủ 22 toolkit để lần bật sau mở đủ app.
  await coordinator.handle('composio.setState', { enabled: false, toolkits: [...COMPOSIO_TOOLKIT_SLUGS] });
});

function coordBotConfig(id, ws) {
  return {
    id,
    name: `Bot ${id}`,
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir: ws,
    autoApprove: true,
  };
}

async function coordCreateBot(id) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `composio-v058-bot-${id}-`));
  coordTmpDirs.push(ws);
  const created = await coordinator.createBot({
    bot: coordBotConfig(id, ws),
    provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'hi' }] },
  });
  coordBots.push(id);
  return created;
}

test('composio v058: RPC set/get state — toggle, toolkit lạ lỗi và không đổi trạng thái', async () => {
  const initial = await coordinator.handle('composio.getState', {});
  assert.equal(initial.enabled, false);
  assert.deepEqual(initial.registeredAppIds, []);
  assert.deepEqual(initial.toolkits, [...COMPOSIO_TOOLKIT_SLUGS]);

  const applied = await coordinator.handle('composio.setState', {
    enabled: true,
    toolkits: ['gmail', 'github'],
  });
  assert.equal(applied.enabled, true);
  assert.deepEqual(applied.toolkits, ['gmail', 'github']);
  assert.deepEqual(applied.registeredAppIds, ['composio', 'composio-github', 'composio-gmail']);

  const current = await coordinator.handle('composio.getState', {});
  assert.deepEqual(current, applied);

  // Toolkit lạ → lỗi rõ ràng, trạng thái cũ giữ nguyên.
  await assert.rejects(
    coordinator.handle('composio.setState', { enabled: true, toolkits: ['nope-toolkit'] }),
    /Không rõ toolkit Composio "nope-toolkit"/,
  );
  const afterBad = await coordinator.handle('composio.getState', {});
  assert.deepEqual(afterBad, applied);

  // Tắt từng toolkit: chỉ gỡ đúng app đó.
  const narrowed = await coordinator.handle('composio.setState', {
    enabled: true,
    toolkits: ['gmail'],
  });
  assert.deepEqual(narrowed.registeredAppIds, ['composio', 'composio-gmail']);
});

test('composio v058: bot tạo sau khi bật → có meta-tool; runTool chạy thật qua mock; tắt → bot đã tạo mất tool', async () => {
  const offBot = await coordCreateBot('v058-off');
  assert.ok(!offBot.toolNames.includes(COMPOSIO_SEARCH_TOOL));

  await coordinator.handle('composio.setState', { enabled: true, toolkits: ['gmail'] });
  const onBot = await coordCreateBot('v058-on');
  assert.ok(onBot.toolNames.includes(COMPOSIO_SEARCH_TOOL));
  assert.ok(onBot.toolNames.includes(COMPOSIO_GET_TOOL_SCHEMAS));
  assert.ok(onBot.toolNames.includes(COMPOSIO_MULTI_EXECUTE_TOOL));

  // Chạy thật qua runTool: search → execute, key đọc từ file Vault của coordinator.
  const baselineSessions = coordMock.state.sessionCreates;
  const found = await coordinator.handle('runTool', {
    botId: 'v058-on',
    tool: COMPOSIO_SEARCH_TOOL,
    args: { query: 'gửi mail cho Lan' },
  });
  assert.ok(found.output.includes('GMAIL_SEND_EMAIL'));
  const executed = await coordinator.handle('runTool', {
    botId: 'v058-on',
    tool: COMPOSIO_MULTI_EXECUTE_TOOL,
    args: { tools: [{ tool: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'lan@example.com', subject: '[open-bot live test] mock', body: 'mock only' } }] },
  });
  assert.ok(executed.output.includes('mock-msg-1'));
  // Cache: 2 runTool chỉ tạo 1 session mới.
  assert.equal(coordMock.state.sessionCreates, baselineSessions + 1);

  // Tắt source → bot đã tạo mất meta-tool ngay (rebuild), bot tạo sau cũng không có.
  await coordinator.handle('composio.setState', { enabled: false, toolkits: [] });
  await assert.rejects(
    coordinator.handle('runTool', {
      botId: 'v058-on',
      tool: COMPOSIO_SEARCH_TOOL,
      args: { query: 'gửi mail' },
    }),
    /Không tìm thấy tool/,
  );
  const afterOff = await coordCreateBot('v058-after-off');
  assert.ok(!afterOff.toolNames.includes(COMPOSIO_SEARCH_TOOL));
});

// ---------------------------------------------------------------------------
// E. CoordinatorClient qua NDJSON-RPC thật (tiến trình con)
// ---------------------------------------------------------------------------

test('composio v058: client set/get state qua NDJSON-RPC — đúng hợp đồng main sẽ gọi', async () => {
  const client = new CoordinatorClient();
  try {
    const pong = await client.ping();
    assert.equal(pong.pong, true);
    const initial = await client.getComposioState();
    assert.equal(initial.enabled, false);
    assert.deepEqual(initial.registeredAppIds, []);

    const applied = await client.setComposioState({ enabled: true, toolkits: ['slack'] });
    assert.equal(applied.enabled, true);
    assert.deepEqual(applied.toolkits, ['slack']);
    assert.deepEqual(applied.registeredAppIds, ['composio', 'composio-slack']);
    assert.deepEqual(await client.getComposioState(), applied);

    await assert.rejects(
      client.setComposioState({ enabled: true, toolkits: ['nope-toolkit'] }),
      /Không rõ toolkit Composio "nope-toolkit"/,
    );

    // Bot tạo trong tiến trình con sau khi bật → có meta-tool trong tool list.
    const ws = tmpDir('composio-v058-rpc-bot-');
    const created = await client.createBot({
      bot: coordBotConfig('v058-rpc', ws),
      provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'hi' }] },
    });
    assert.ok(created.toolNames.includes(COMPOSIO_SEARCH_TOOL));
    assert.ok(created.toolNames.includes(COMPOSIO_MULTI_EXECUTE_TOOL));
    await client.destroyBot('v058-rpc');

    const off = await client.setComposioState({ enabled: false, toolkits: [] });
    assert.equal(off.enabled, false);
    assert.deepEqual(off.registeredAppIds, []);
  } finally {
    await client.dispose();
  }
});
