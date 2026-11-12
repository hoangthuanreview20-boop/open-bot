/**
 * Tests for Composio user id (v0.88b): the app no longer hardcodes
 * 'local-user' for the Tool Router session — the user configures
 * their Composio user id in Settings → Composio (Vault), main seeds
 * it to the coordinator (RPC `composio.setUserId` / param
 * `composioUserId` of `createBot`), and changing it at runtime
 * drops the old session immediately (no app restart).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/composio-userid-v088b.test.mjs
 *
 * No live network, no real Composio account/key: the "key" is the
 * fake string FAKE_KEY, the "user id" is the fake string
 * FAKE_USER_ID (same shape as a real Composio id, `pg-test-...`),
 * the REST endpoint is a local http://127.0.0.1 server that only
 * serves POST /api/v3.1/tool_router/session, and the MCP client is
 * injected (no MCP HTTP server needed — the manager accepts a
 * `createMcpClient` override).
 */
import { test, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import http from 'node:http';

import {
  COMPOSIO_LOCAL_USER_ID,
  COMPOSIO_SEARCH_TOOL,
  COMPOSIO_TOOLKIT_SLUGS,
  ComposioSessionManager,
  clearComposioUserId,
  createComposioMetaTools,
  getComposioUserId,
  hasComposioUserId,
  resolveComposioUserId,
  setComposioUserId,
  validateComposioUserId,
} from '../packages/core/dist/composio/index.js';
import { AgentCoordinator } from '../packages/core/dist/coordinator/coordinator.js';
import { Vault } from '../packages/core/dist/vault/vault.js';

/** Fake key + fake user id — distinctive so tests can prove they never leak. */
const FAKE_KEY = 'ck_mock_USERID_12345_do_not_use';
/** Same shape as a real Composio user id (`pg-test-...`), but fake. */
const FAKE_USER_ID = 'pg-test-mock-0000-1111-2222-333344445555';

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
 * Mock Composio REST: only POST /api/v3.1/tool_router/session.
 * Records every `user_id` the session was created with, so tests
 * can prove which id the manager/coordinator actually used.
 */
function startMockComposio() {
  const state = { sessionCreates: 0, sessionUserIds: [] };
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
        if (req.headers['x-api-key'] !== FAKE_KEY) {
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
        state.sessionCreates += 1;
        state.sessionUserIds.push(parsed.user_id ?? null);
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
      // MCP endpoint tối thiểu (như mock v058): đủ cho connectMcp
      // thật nối + gọi COMPOSIO_SEARCH_TOOLS trong test d4.
      if (req.url === '/mcp' && req.method === 'POST') {
        if (req.headers['x-api-key'] !== FAKE_KEY) {
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
          res.writeHead(202);
          res.end();
          return;
        }
        const result = (id, resultObj) => sendJson(200, { jsonrpc: '2.0', id, result: resultObj });
        if (msg.method === 'initialize') {
          result(msg.id, {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: { name: 'mock-composio-tool-router', version: '0.1.0' },
          });
        } else if (msg.method === 'ping') {
          result(msg.id, {});
        } else if (msg.method === 'tools/list') {
          result(msg.id, {
            tools: ['COMPOSIO_SEARCH_TOOLS'].map((name) => ({
              name,
              description: `Mock meta-tool ${name}`,
              inputSchema: { type: 'object', properties: {} },
            })),
          });
        } else if (msg.method === 'tools/call' && msg.params?.name === 'COMPOSIO_SEARCH_TOOLS') {
          result(msg.id, {
            content: [
              { type: 'text', text: JSON.stringify({ tools: [{ slug: 'GMAIL_SEND_EMAIL' }] }) },
            ],
            isError: false,
          });
        } else {
          sendJson(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Unknown: ${msg.method}` } });
        }
        return;
      }
      res.writeHead(404);
      res.end();
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

/** Fake MCP client (injected via `createMcpClient`) — counts close() calls. */
function makeFakeMcpFactory(tracker) {
  return async () => {
    const client = {
      closed: false,
      async callTool() {
        return JSON.stringify({ tools: [{ slug: 'GMAIL_SEND_EMAIL' }] });
      },
      async close() {
        client.closed = true;
        tracker.closes += 1;
      },
    };
    tracker.clients.push(client);
    return client;
  };
}

function makeManager(mock, opts = {}) {
  const tracker = { closes: 0, clients: [] };
  const manager = new ComposioSessionManager({
    getApiKey: opts.getApiKey ?? (() => FAKE_KEY),
    ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
    getEnabledToolkits: opts.getEnabledToolkits ?? (() => ['gmail']),
    baseUrl: `http://127.0.0.1:${mock.port}/api/v3.1`,
    fetchFn: mockFetchFn(),
    createMcpClient: makeFakeMcpFactory(tracker),
  });
  return { manager, tracker };
}

function botConfig(id, ws) {
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

// ---------------------------------------------------------------------------
// A. Manager: mặc định 'local-user' khi chưa cấu hình (v0.88b yêu cầu 2)
// ---------------------------------------------------------------------------

test('composio v088b (a): chưa cấu hình user id → session dùng mặc định local-user', async () => {
  const mock = await startMockComposio();
  const { manager } = makeManager(mock);
  assert.equal(manager.getUserId(), COMPOSIO_LOCAL_USER_ID);
  assert.equal(manager.getUserId(), 'local-user');
  const tools = createComposioMetaTools({ manager });
  const search = tools.find((t) => t.definition.name === COMPOSIO_SEARCH_TOOL);
  const out = await search.execute(
    { query: 'gửi mail' },
    { workspaceDir: tmpDir('composio-v088b-ws-'), botId: 'bot-test' },
  );
  assert.ok(out.includes('GMAIL_SEND_EMAIL'));
  assert.equal(mock.state.sessionCreates, 1);
  assert.deepEqual(mock.state.sessionUserIds, ['local-user']);
  assert.equal(manager.sessionsCreated(), 1);
  assert.equal(manager.isConnected(), true);
  await manager.close();
});

// ---------------------------------------------------------------------------
// B. Manager: user id đã cấu hình được truyền tới lúc tạo session
// ---------------------------------------------------------------------------

test('composio v088b (b): user id đã cấu hình → session tạo với đúng id đó', async () => {
  const mock = await startMockComposio();
  const { manager } = makeManager(mock, { userId: FAKE_USER_ID });
  assert.equal(manager.getUserId(), FAKE_USER_ID);
  const tools = createComposioMetaTools({ manager });
  const search = tools.find((t) => t.definition.name === COMPOSIO_SEARCH_TOOL);
  await search.execute(
    { query: 'gửi mail' },
    { workspaceDir: tmpDir('composio-v088b-ws-'), botId: 'bot-test' },
  );
  assert.equal(mock.state.sessionCreates, 1);
  assert.deepEqual(mock.state.sessionUserIds, [FAKE_USER_ID]);
  await manager.close();
});

// ---------------------------------------------------------------------------
// C. Manager: đổi user id làm drop session cũ (có hiệu lực ngay)
// ---------------------------------------------------------------------------

test('composio v088b (c): đổi user id → session cũ bị huỷ, lần gọi sau tạo session mới đúng id', async () => {
  const mock = await startMockComposio();
  const { manager, tracker } = makeManager(mock, { userId: FAKE_USER_ID });
  const tools = createComposioMetaTools({ manager });
  const search = tools.find((t) => t.definition.name === COMPOSIO_SEARCH_TOOL);
  const ctx = { workspaceDir: tmpDir('composio-v088b-ws-'), botId: 'bot-test' };
  await search.execute({ query: 'gửi mail' }, ctx);
  assert.equal(manager.isConnected(), true);
  assert.equal(mock.state.sessionCreates, 1);

  // Đổi sang id khác → trả true, session cũ bị drop ngay (client bị close).
  const changed = await manager.setUserId('pg-test-mock-aaaa-bbbb-cccc-dddd');
  assert.equal(changed, true);
  assert.equal(manager.isConnected(), false);
  assert.equal(tracker.closes, 1);
  assert.equal(manager.getUserId(), 'pg-test-mock-aaaa-bbbb-cccc-dddd');

  // Lần gọi sau tạo session mới với id mới (không dùng tiếp session cũ).
  await search.execute({ query: 'gửi mail' }, ctx);
  assert.equal(mock.state.sessionCreates, 2);
  assert.deepEqual(mock.state.sessionUserIds, [
    FAKE_USER_ID,
    'pg-test-mock-aaaa-bbbb-cccc-dddd',
  ]);
  assert.equal(manager.isConnected(), true);

  // Đặt lại cùng id → trả false, session cũ giữ nguyên (không tạo mới thừa).
  const unchanged = await manager.setUserId('pg-test-mock-aaaa-bbbb-cccc-dddd');
  assert.equal(unchanged, false);
  assert.equal(manager.isConnected(), true);
  assert.equal(mock.state.sessionCreates, 2);

  // Xoá id (null) → về mặc định 'local-user', session cũ lại bị drop.
  const cleared = await manager.setUserId(null);
  assert.equal(cleared, true);
  assert.equal(manager.getUserId(), 'local-user');
  assert.equal(manager.isConnected(), false);
  assert.equal(tracker.closes, 2);
  await manager.close();
});

// ---------------------------------------------------------------------------
// D. Validate + Vault round-trip + RPC coordinator
// ---------------------------------------------------------------------------

test('composio v088b (d1): validate user id — rỗng/khoảng trắng/ký tự lạ lỗi rõ, pg-test-... được chấp nhận', () => {
  assert.equal(validateComposioUserId(FAKE_USER_ID), FAKE_USER_ID);
  assert.equal(validateComposioUserId('  pg-test-abc-123  '), 'pg-test-abc-123');
  assert.equal(validateComposioUserId('default'), 'default');
  assert.equal(validateComposioUserId('550e8400-e29b-41d4-a716-446655440000'), '550e8400-e29b-41d4-a716-446655440000');
  assert.throws(() => validateComposioUserId(''), /không được rỗng/);
  assert.throws(() => validateComposioUserId('   '), /không được rỗng/);
  assert.throws(() => validateComposioUserId(null), /không được rỗng/);
  assert.throws(() => validateComposioUserId(42), /không được rỗng/);
  assert.throws(() => validateComposioUserId('pg test id'), /khoảng trắng/);
  assert.throws(() => validateComposioUserId(`a${'\n'}b`), /khoảng trắng/);
  assert.throws(() => validateComposioUserId('x'.repeat(201)), /quá dài/);
  // resolve: null/rỗng → mặc định, không ném.
  assert.equal(resolveComposioUserId(null), 'local-user');
  assert.equal(resolveComposioUserId(undefined), 'local-user');
  assert.equal(resolveComposioUserId(''), 'local-user');
  assert.equal(resolveComposioUserId('   '), 'local-user');
  assert.equal(resolveComposioUserId(FAKE_USER_ID), FAKE_USER_ID);
  assert.throws(() => resolveComposioUserId('a b'), /khoảng trắng/);
});

test('composio v088b (d2): Vault round-trip — set/get/has/clear user id, không lộ giá trị ra status', () => {
  const dir = tmpDir('composio-v088b-vault-');
  const vault = new Vault({ storePath: path.join(dir, 'vault.json') });
  assert.equal(hasComposioUserId(vault), false);
  assert.equal(getComposioUserId(vault), null);
  assert.throws(() => setComposioUserId(vault, '   '), /không được rỗng/);
  assert.equal(hasComposioUserId(vault), false);
  setComposioUserId(vault, FAKE_USER_ID);
  assert.equal(hasComposioUserId(vault), true);
  assert.equal(getComposioUserId(vault), FAKE_USER_ID);
  assert.equal(clearComposioUserId(vault), true);
  assert.equal(hasComposioUserId(vault), false);
  assert.equal(getComposioUserId(vault), null);
  assert.equal(clearComposioUserId(vault), false);
});

// ---------------------------------------------------------------------------
// D (tiếp). Coordinator in-process: RPC setUserId/getUserIdStatus + createBot
// ---------------------------------------------------------------------------

let mock;
let coordinator;
const coordBots = [];
const botDirs = [];

before(async () => {
  mock = await startMockComposio();
  servers.splice(servers.indexOf(mock.server), 1);
  coordinator = new AgentCoordinator({
    composio: {
      baseUrl: `http://127.0.0.1:${mock.port}/api/v3.1`,
      fetchFn: mockFetchFn(),
    },
  });
});

after(async () => {
  for (const botId of coordBots.splice(0)) {
    try {
      await coordinator.destroyBot({ botId });
    } catch {
      // Bỏ qua.
    }
  }
  try {
    coordinator.shutdown();
  } catch {
    // Best-effort.
  }
  for (const dir of botDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  await new Promise((resolve) => mock.server.close(() => resolve()));
});

afterEach(async () => {
  // Trả Composio về TẮT + user id mặc định sau mỗi test.
  await coordinator.handle('composio.setState', { enabled: false, toolkits: [...COMPOSIO_TOOLKIT_SLUGS] });
  await coordinator.handle('composio.setUserId', { userId: null });
});

test('composio v088b (d3): RPC setUserId/getUserIdStatus — status chỉ boolean, không chứa id', async () => {
  const initial = await coordinator.handle('composio.getUserIdStatus', {});
  assert.deepEqual(initial, { userIdConfigured: false, usingDefaultUserId: true });

  const set = await coordinator.handle('composio.setUserId', { userId: FAKE_USER_ID });
  assert.deepEqual(set, { userIdConfigured: true, usingDefaultUserId: false });
  assert.ok(!JSON.stringify(set).includes(FAKE_USER_ID), 'status must not contain the user id');
  assert.deepEqual(await coordinator.handle('composio.getUserIdStatus', {}), set);

  // Sai định dạng → lỗi rõ, id cũ giữ nguyên.
  await assert.rejects(
    coordinator.handle('composio.setUserId', { userId: 'a b' }),
    /khoảng trắng/,
  );
  assert.deepEqual(await coordinator.handle('composio.getUserIdStatus', {}), {
    userIdConfigured: true,
    usingDefaultUserId: false,
  });

  // Xoá (null) → về mặc định.
  const cleared = await coordinator.handle('composio.setUserId', { userId: null });
  assert.deepEqual(cleared, { userIdConfigured: false, usingDefaultUserId: true });

  // Params sai kiểu → lỗi rõ.
  await assert.rejects(coordinator.handle('composio.setUserId', { userId: 42 }), /string, null/);
  await assert.rejects(coordinator.handle('composio.setUserId', null), /params/);
});

test('composio v088b (d4): createBot param composioUserId seed id; re-attach đổi id làm drop session cũ', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'composio-v088b-bot-'));
  botDirs.push(ws);
  const before = mock.state.sessionCreates;
  // Bật source để meta-tool chạy được (session tạo ở lần gọi tool đầu).
  await coordinator.handle('composio.setState', { enabled: true, toolkits: ['gmail'] });
  await coordinator.createBot({
    bot: botConfig('v088b-userid', ws),
    provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'hi' }] },
    // Seed cả key (coordinator này không có dataDir → không đọc được
    // file Vault; không seed key thì tool fail-closed trước khi tạo session).
    composioApiKey: FAKE_KEY,
    composioUserId: FAKE_USER_ID,
  });
  coordBots.push('v088b-userid');
  assert.deepEqual(await coordinator.handle('composio.getUserIdStatus', {}), {
    userIdConfigured: true,
    usingDefaultUserId: false,
  });
  // Gọi meta-tool search qua tool của bot đã tạo (đi qua session
  // manager dùng chung của coordinator): session phải tạo với id đã seed.
  const entry = coordinator.bots?.get?.('v088b-userid');
  assert.ok(entry, 'bot entry exists');
  const searchTool = entry.tools.find((t) => t.definition.name === COMPOSIO_SEARCH_TOOL);
  assert.ok(searchTool, 'composio search tool registered for the bot');
  await searchTool.execute(
    { query: 'gửi mail' },
    { workspaceDir: ws, botId: 'v088b-userid' },
  );
  assert.equal(mock.state.sessionCreates, before + 1);
  assert.equal(mock.state.sessionUserIds.at(-1), FAKE_USER_ID);

  // Re-attach (createBot lại cùng bot id) với id mới → session cũ bị drop,
  // lần gọi sau tạo session mới đúng id mới.
  await coordinator.createBot({
    bot: botConfig('v088b-userid', ws),
    provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'hi' }] },
    composioApiKey: FAKE_KEY,
    composioUserId: 'pg-test-mock-9999-8888-7777-6666',
  });
  assert.deepEqual(await coordinator.handle('composio.getUserIdStatus', {}), {
    userIdConfigured: true,
    usingDefaultUserId: false,
  });
  await searchTool.execute(
    { query: 'gửi mail' },
    { workspaceDir: ws, botId: 'v088b-userid' },
  );
  assert.equal(mock.state.sessionCreates, before + 2);
  assert.equal(mock.state.sessionUserIds.at(-1), 'pg-test-mock-9999-8888-7777-6666');
});

test('composio v088b (d5): constructor opts.composio.userId — coordinator khởi tạo với id đã cấu hình', async () => {
  const mock2 = await startMockComposio();
  const coord2 = new AgentCoordinator({
    composio: {
      baseUrl: `http://127.0.0.1:${mock2.port}/api/v3.1`,
      fetchFn: mockFetchFn(),
      userId: FAKE_USER_ID,
    },
  });
  try {
    assert.deepEqual(await coord2.handle('composio.getUserIdStatus', {}), {
      userIdConfigured: true,
      usingDefaultUserId: false,
    });
  } finally {
    try {
      coord2.shutdown();
    } catch {
      // Best-effort.
    }
    await new Promise((resolve) => mock2.server.close(() => resolve()));
  }
});
