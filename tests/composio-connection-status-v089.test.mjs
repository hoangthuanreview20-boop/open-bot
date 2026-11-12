/**
 * Tests for Composio connection status + pre-check (v0.89c, Team E).
 *
 * v0.88b made the Composio user id configurable, but the app still
 * had no way to SHOW whether each toolkit is actually connected,
 * and a tool execution against a toolkit with no Active connection
 * failed with the server's cryptic "No active connection found".
 * This wave adds:
 *   (a) `ComposioSessionManager.getConnectionStatus()` — per-toolkit
 *       {toolkit, status: 'active'|'initiated'|'none', accountLabel?}
 *       via COMPOSIO_MANAGE_CONNECTIONS (no redirect_url, no user
 *       id, no key in the output);
 *   (b) a pre-check in `executeTools()`: before the first execution
 *       of each session, the needed toolkits (from the slug prefix)
 *       must be Active, otherwise a clear ComposioError
 *       'composio_connection_inactive' names the toolkit and tells
 *       the user to connect in the dashboard / check the user id;
 *   (c) coordinator RPC `composio.getConnectionStatus` + client
 *       method (same shape, for the Settings UI).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/composio-connection-status-v089.test.mjs
 *
 * No live network, no real Composio account/key: the "key" is the
 * fake string FAKE_KEY, the REST endpoint is a local
 * http://127.0.0.1 server that only serves POST
 * /api/v3.1/tool_router/session, and the MCP client is either
 * injected (manager tests) or the real connectMcp against the mock
 * /mcp endpoint (coordinator RPC test).
 */
import { test, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import {
  COMPOSIO_MANAGE_CONNECTIONS_TOOL,
  COMPOSIO_MULTI_EXECUTE_TOOL,
  ComposioSessionManager,
  createComposioMetaTools,
} from '../packages/core/dist/composio/index.js';
import { AgentCoordinator } from '../packages/core/dist/coordinator/coordinator.js';

/** Fake key — distinctive so tests can prove it never leaks. */
const FAKE_KEY = 'ck_mock_CONNSTATUS_12345_do_not_use';
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

function mockFetchFn() {
  return async (url, init) => {
    const res = await fetch(url, init);
    return { status: res.status, text: async () => res.text() };
  };
}

/**
 * Mock Composio REST + MCP. The /mcp endpoint answers tools/call
 * for COMPOSIO_MANAGE_CONNECTIONS from the mutable `manageState`
 * (tests flip a toolkit active/initiated to prove the mapping) and
 * for COMPOSIO_MULTI_EXECUTE_TOOL with a canned success envelope.
 */
function startMockComposio(manageState) {
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
            tools: [COMPOSIO_MANAGE_CONNECTIONS_TOOL, COMPOSIO_MULTI_EXECUTE_TOOL].map((name) => ({
              name,
              description: `Mock meta-tool ${name}`,
              inputSchema: { type: 'object', properties: {} },
            })),
          });
        } else if (msg.method === 'tools/call' && msg.params?.name === COMPOSIO_MANAGE_CONNECTIONS_TOOL) {
          result(msg.id, {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ successful: true, data: { results: manageState.results } }),
              },
            ],
            isError: false,
          });
        } else if (msg.method === 'tools/call' && msg.params?.name === COMPOSIO_MULTI_EXECUTE_TOOL) {
          result(msg.id, {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  successful: true,
                  data: {
                    results: (msg.params?.arguments?.tools ?? []).map((item, index) => ({
                      response: { successful: true, data: { ok: true } },
                      tool_slug: item.tool_slug ?? item.tool,
                      index,
                    })),
                  },
                }),
              },
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

/**
 * Fake MCP client (injected into the manager) — scriptable
 * MANAGE_CONNECTIONS answers + canned MULTI_EXECUTE success.
 * `manage` is a mutable record the test controls:
 *   { github: { status: 'active', current_user_info: { login } }, ... }
 * `failManage` (boolean) makes the MANAGE call throw (transport error).
 */
function makeFakeMcpFactory(tracker, manage) {
  return async () => {
    const client = {
      closed: false,
      async callTool(name, args) {
        tracker.calls.push({ name, args });
        if (name === COMPOSIO_MANAGE_CONNECTIONS_TOOL) {
          tracker.manageCalls += 1;
          if (manage.failManage) throw new Error('boom transport');
          if (manage.errorText) return manage.errorText;
          const payload = manage.payload ?? {
            successful: true,
            data: { results: manage.results },
          };
          return typeof payload === 'string' ? payload : JSON.stringify(payload);
        }
        if (name === COMPOSIO_MULTI_EXECUTE_TOOL) {
          tracker.executeCalls += 1;
          tracker.executed.push(args);
          const tools = args?.tools ?? [];
          return JSON.stringify({
            successful: true,
            data: {
              results: tools.map((item, index) => ({
                response: { successful: true, data: { ok: true } },
                tool_slug: item.tool_slug ?? item.tool,
                index,
              })),
            },
          });
        }
        return '{}';
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
  const tracker = { closes: 0, clients: [], calls: [], manageCalls: 0, executeCalls: 0, executed: [] };
  const manage = opts.manage ?? {
    results: {
      github: { status: 'active', current_user_info: { login: 'octo-mock' } },
      gmail: { status: 'active', current_user_info: { email: 'a@b.mock' } },
      slack: { status: 'active', current_user_info: { team: 'team-mock' } },
    },
  };
  const manager = new ComposioSessionManager({
    getApiKey: opts.getApiKey ?? (() => FAKE_KEY),
    ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
    getEnabledToolkits: opts.getEnabledToolkits ?? (() => ['github', 'gmail', 'slack']),
    baseUrl: `http://127.0.0.1:${mock.port}/api/v3.1`,
    fetchFn: mockFetchFn(),
    createMcpClient: makeFakeMcpFactory(tracker, manage),
  });
  return { manager, tracker, manage };
}

// ---------------------------------------------------------------------------
// A. getConnectionStatus — parse MANAGE_CONNECTIONS
// ---------------------------------------------------------------------------

test('composio v089c (a1): getConnectionStatus map active/initiated/none + account label, không lộ redirect_url', async () => {
  const mock = await startMockComposio({});
  const { manager, tracker, manage } = makeManager(mock);
  manage.results = {
    github: {
      status: 'active',
      connected_account_id: 'ca_mock_github',
      current_user_info: { login: 'octo-mock', id: '1' },
      redirect_url: 'https://connect.composio.dev/link/SECRET_MUST_NOT_LEAK',
    },
    gmail: { status: 'initiated', redirect_url: 'https://connect.composio.dev/link/SECRET2' },
    // slack vắng khỏi results → 'none'.
  };
  const out = await manager.getConnectionStatus(['github', 'gmail', 'slack']);
  assert.deepEqual(out, [
    { toolkit: 'github', status: 'active', accountLabel: 'octo-mock' },
    { toolkit: 'gmail', status: 'initiated' },
    { toolkit: 'slack', status: 'none' },
  ]);
  assert.ok(!JSON.stringify(out).includes('connect.composio.dev'), 'no redirect_url in output');
  assert.ok(!JSON.stringify(out).includes('ca_mock_github'), 'no connected account id in output');
  assert.equal(tracker.manageCalls, 1);
  await manager.close();
});

test('composio v089c (a2): getConnectionStatus — nhãn từ email/team/name; rỗng toolkit → [] không tạo session', async () => {
  const mock = await startMockComposio({});
  const { manager } = makeManager(mock);
  const out = await manager.getConnectionStatus([]);
  assert.deepEqual(out, []);
  assert.equal(mock.state.sessionCreates, 0);

  const out2 = await manager.getConnectionStatus(['gmail', 'slack', 'notion']);
  // manage.results mặc định của makeManager: gmail email, slack team; notion vắng.
  assert.deepEqual(out2, [
    { toolkit: 'gmail', status: 'active', accountLabel: 'a@b.mock' },
    { toolkit: 'slack', status: 'active', accountLabel: 'team-mock' },
    { toolkit: 'notion', status: 'none' },
  ]);
  await manager.close();
});

test('composio v089c (a3): getConnectionStatus — MCP error → lỗi session_failed rõ; JSON stringify 2 lần vẫn parse được', async () => {
  const mock = await startMockComposio({});
  const { manager, manage } = makeManager(mock);
  manage.errorText = 'MCP tool error: {"error":"boom"}';
  await assert.rejects(manager.getConnectionStatus(['github']), /boom/);
  await manager.close();

  // Fake trả JSON đã stringify 2 lần (như MCP thật đôi khi trả).
  const payload = {
    successful: true,
    data: { results: { github: { status: 'active', current_user_info: { login: 'octo2' } } } },
  };
  const { manager: m3, manage: manage3 } = makeManager(mock);
  manage3.payload = JSON.stringify(JSON.stringify(payload));
  const out = await m3.getConnectionStatus(['github']);
  assert.deepEqual(out, [{ toolkit: 'github', status: 'active', accountLabel: 'octo2' }]);
  await m3.close();
});

// ---------------------------------------------------------------------------
// B. executeTools — pre-check trước lần thực thi đầu tiên
// ---------------------------------------------------------------------------

test('composio v089c (b1): thực thi khi toolkit chưa Active → lỗi composio_connection_inactive rõ ràng, không thực thi', async () => {
  const mock = await startMockComposio({});
  const { manager, tracker, manage } = makeManager(mock);
  manage.results = {
    github: { status: 'initiated' },
    gmail: { status: 'active', current_user_info: { email: 'a@b.mock' } },
  };
  const tools = createComposioMetaTools({ manager });
  const exec = tools.find((t) => t.definition.name === COMPOSIO_MULTI_EXECUTE_TOOL);
  const ctx = { workspaceDir: tmpDir('composio-v089c-ws-'), botId: 'bot-test' };
  await assert.rejects(
    exec.execute(
      { tools: [{ tool_slug: 'GITHUB_CREATE_AN_ISSUE', arguments: { owner: 'o', repo: 'r', title: 't' } }] },
      ctx,
    ),
    (err) => {
      assert.equal(err.code, 'composio_connection_inactive');
      assert.match(err.message, /github/);
      assert.match(err.message, /dashboard/);
      assert.match(err.message, /user id/);
      return true;
    },
  );
  assert.equal(tracker.executeCalls, 0, 'must not execute when inactive');
  await manager.close();
});

test('composio v089c (b2): thực thi khi Active → chạy; kiểm tra chỉ 1 lần mỗi session', async () => {
  const mock = await startMockComposio({});
  const { manager, tracker } = makeManager(mock);
  const tools = createComposioMetaTools({ manager });
  const exec = tools.find((t) => t.definition.name === COMPOSIO_MULTI_EXECUTE_TOOL);
  const ctx = { workspaceDir: tmpDir('composio-v089c-ws-'), botId: 'bot-test' };
  const args = { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'a@b.mock' } }] };
  const out1 = await exec.execute(args, ctx);
  assert.ok(out1.includes('ok'));
  const out2 = await exec.execute(args, ctx);
  assert.ok(out2.includes('ok'));
  assert.equal(tracker.manageCalls, 1, 'MANAGE_CONNECTIONS checked once per session');
  assert.equal(tracker.executeCalls, 2);
  await manager.close();
});

test('composio v089c (b3): đổi user id → kiểm tra lại (cache cũ không dùng tiếp)', async () => {
  const mock = await startMockComposio({});
  const { manager, tracker } = makeManager(mock);
  const tools = createComposioMetaTools({ manager });
  const exec = tools.find((t) => t.definition.name === COMPOSIO_MULTI_EXECUTE_TOOL);
  const ctx = { workspaceDir: tmpDir('composio-v089c-ws-'), botId: 'bot-test' };
  const args = { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'a@b.mock' } }] };
  await exec.execute(args, ctx);
  assert.equal(tracker.manageCalls, 1);
  await manager.setUserId(FAKE_USER_ID);
  await exec.execute(args, ctx);
  assert.equal(tracker.manageCalls, 2, 'user id change re-checks');
  await manager.close();
});

test('composio v089c (b4): kiểm tra trạng thái lỗi vì mạng → fail-open, thực thi vẫn chạy; slug lạ → không chặn', async () => {
  const mock = await startMockComposio({});
  const { manager, tracker, manage } = makeManager(mock);
  manage.failManage = true;
  const tools = createComposioMetaTools({ manager });
  const exec = tools.find((t) => t.definition.name === COMPOSIO_MULTI_EXECUTE_TOOL);
  const ctx = { workspaceDir: tmpDir('composio-v089c-ws-'), botId: 'bot-test' };
  const out = await exec.execute(
    { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'a@b.mock' } }] },
    ctx,
  );
  assert.ok(out.includes('ok'), 'fail-open: execution proceeds when the check itself errors');
  assert.equal(tracker.executeCalls, 1);
  await manager.close();

  // Slug không thuộc toolkit Composio nào → không suy được toolkit → không chặn.
  const { manager: manager2, tracker: tracker2 } = makeManager(mock);
  const tools2 = createComposioMetaTools({ manager: manager2 });
  const exec2 = tools2.find((t) => t.definition.name === COMPOSIO_MULTI_EXECUTE_TOOL);
  await exec2.execute({ tools: [{ tool_slug: 'CUSTOM_DO_THING', arguments: {} }] }, ctx);
  assert.equal(tracker2.manageCalls, 0, 'unknown slug prefix skips the check');
  assert.equal(tracker2.executeCalls, 1);
  await manager2.close();
});

// ---------------------------------------------------------------------------
// C. Coordinator RPC composio.getConnectionStatus (mock MCP thật)
// ---------------------------------------------------------------------------

let mock;
let coordinator;
const coordBots = [];
const botDirs = [];
const manageState = { results: {} };

before(async () => {
  manageState.results = {
    github: { status: 'active', current_user_info: { login: 'octo-mock' } },
    gmail: { status: 'active', current_user_info: { email: 'a@b.mock' } },
    slack: { status: 'initiated' },
  };
  mock = await startMockComposio(manageState);
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
  await coordinator.handle('composio.setState', { enabled: false, toolkits: ['github', 'gmail', 'slack'] });
  await coordinator.handle('composio.setUserId', { userId: null });
});

test('composio v089c (c1): RPC getConnectionStatus — trả đúng shape, không chứa user id', async () => {
  await coordinator.handle('composio.setApiKey', { apiKey: FAKE_KEY });
  await coordinator.handle('composio.setState', { enabled: true, toolkits: ['github', 'gmail', 'slack'] });
  const out = await coordinator.handle('composio.getConnectionStatus', {
    toolkits: ['github', 'gmail', 'slack'],
  });
  assert.deepEqual(out, [
    { toolkit: 'github', status: 'active', accountLabel: 'octo-mock' },
    { toolkit: 'gmail', status: 'active', accountLabel: 'a@b.mock' },
    { toolkit: 'slack', status: 'initiated' },
  ]);
  assert.ok(!JSON.stringify(out).includes(FAKE_USER_ID), 'RPC result must not contain the user id');
  assert.ok(!JSON.stringify(out).includes(FAKE_KEY), 'RPC result must not contain the key');
});

test('composio v089c (c2): RPC getConnectionStatus — toolkit lạ → lỗi rõ; vắng toolkits → dùng toolkit đang bật', async () => {
  await coordinator.handle('composio.setApiKey', { apiKey: FAKE_KEY });
  await coordinator.handle('composio.setState', { enabled: true, toolkits: ['github', 'gmail', 'slack'] });
  await assert.rejects(
    coordinator.handle('composio.getConnectionStatus', { toolkits: ['nope'] }),
    /Không rõ toolkit/,
  );
  const out = await coordinator.handle('composio.getConnectionStatus', {});
  assert.equal(out.length, 3);
  assert.deepEqual(
    out.map((o) => o.toolkit).sort(),
    ['github', 'gmail', 'slack'],
  );
});

// ---------------------------------------------------------------------------
// D. i18n — key trạng thái connection có đủ 6 locale
// ---------------------------------------------------------------------------

test('composio v089c (d): key i18n settings.composio.connection* có đủ 6 locale, không rỗng', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const localesDir = path.join(here, '..', 'apps/desktop/src/renderer/i18n/locales');
  const keys = [
    'settings.composio.connectionTitle',
    'settings.composio.connectionCheck',
    'settings.composio.connectionChecking',
    'settings.composio.connectionActive',
    'settings.composio.connectionInitiated',
    'settings.composio.connectionNone',
    'settings.composio.connectionNotChecked',
    'settings.composio.connectionCheckError',
    'settings.composio.connectionHint',
    'settings.composio.connectionAccount',
  ];
  for (const code of ['vi', 'en', 'zh', 'ja', 'es', 'fr']) {
    const dict = JSON.parse(fs.readFileSync(path.join(localesDir, `${code}.json`), 'utf-8'));
    for (const key of keys) {
      assert.equal(typeof dict[key], 'string', `${code} missing ${key}`);
      assert.ok(dict[key].trim().length > 0, `${code} empty ${key}`);
    }
  }
});
