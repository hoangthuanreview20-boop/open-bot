/**
 * Tests for Composio minimal integration (v0.57): Tool Router client,
 * Vault key store, AppRegistry source (opt-in, per-toolkit toggle),
 * M7 cap applying to Composio tools, mock MCP Tool Router over the
 * REAL connectMcp client (streamable HTTP, no live network).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/composio-v057.test.mjs
 *
 * No live network, no real Composio account/key: the "key" is the fake
 * string FAKE_KEY below, the REST + MCP endpoints are a local
 * http://127.0.0.1 server, and the Vault used is a temp dir. One test
 * asserts the fake key never appears in the Vault file on disk nor in
 * any error message the router throws.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import http from 'node:http';

import {
  COMPOSIO_TOOLKIT_SLUGS,
  ComposioAppSource,
  ComposioError,
  ComposioToolRouter,
  clearComposioApiKey,
  createComposioAppDefinitions,
  getComposioApiKey,
  hasComposioApiKey,
  isTrustedComposioMcpUrl,
  setComposioApiKey,
} from '../packages/core/dist/composio/index.js';
import {
  AppRegistry,
  BUILTIN_APPS,
  DEFAULT_APP_TOOL_CAP,
  applyAppToolCaps,
} from '../packages/core/dist/apps/index.js';
import { connectMcp } from '../packages/core/dist/mcp/client.js';
import { Vault } from '../packages/core/dist/vault/vault.js';

/** Fake key — distinctive so tests can prove it never leaks. */
const FAKE_KEY = 'ck_mock_SECRET_12345_do_not_use';
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
 * Mock Composio backend on 127.0.0.1: BOTH the REST Tool Router API
 * (POST /api/v3.1/tool_router/session, GET .../tools) AND the MCP
 * endpoint the session URL points at (POST /mcp). The MCP side speaks
 * just enough JSON-RPC for the real connectMcp client: initialize,
 * tools/list (7 meta-tools), tools/call (SEARCH + MULTI_EXECUTE echo).
 * Every request must carry the fake x-api-key header — anything else
 * gets HTTP 401, like a real presigned session would reject a bad key.
 */
function startMockComposio() {
  const state = { sessionCreates: 0, searchCalls: 0, executeCalls: 0, lastExecuteArgs: null };
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
      // REST: create Tool Router session.
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
          session_id: 'sess-mock-1',
          mcp: {
            url: `${base}/mcp`,
            headers: { 'x-api-key': FAKE_KEY },
          },
          toolkits: parsed.toolkits?.enable ?? [],
        });
        return;
      }
      // REST: list session tools.
      if (
        req.url?.startsWith('/api/v3.1/tool_router/session/sess-mock-1/tools') &&
        req.method === 'GET'
      ) {
        if (req.headers['x-api-key'] !== FAKE_KEY) {
          sendJson(401, { error: 'invalid api key' });
          return;
        }
        sendJson(200, {
          items: [
            {
              slug: 'GMAIL_FETCH_EMAILS',
              description: 'Fetch emails',
              input_parameters: { type: 'object', properties: {} },
            },
            { slug: 'GMAIL_SEND_EMAIL', description: 'Send an email' },
          ],
          next_cursor: '',
        });
        return;
      }
      // MCP endpoint (presigned session URL).
      if (req.url !== '/mcp' || req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }
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
          } else if (name === 'COMPOSIO_MULTI_EXECUTE_TOOL') {
            state.executeCalls += 1;
            state.lastExecuteArgs = msg.params?.arguments ?? null;
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

function makeRouter(mock, apiKey = FAKE_KEY) {
  return new ComposioToolRouter({
    apiKey,
    baseUrl: `http://127.0.0.1:${mock.port}/api/v3.1`,
    fetchFn: async (url, init) => {
      const res = await fetch(url, init);
      return { status: res.status, text: async () => res.text() };
    },
  });
}

test('composio: key trong Vault — set/get/clear, chỉ boolean lộ ra, file đĩa không chứa key', () => {
  const dir = tmpDir('composio-vault-');
  const vault = new Vault({ storePath: path.join(dir, 'vault.json') });
  assert.equal(hasComposioApiKey(vault), false);
  assert.equal(getComposioApiKey(vault), null);
  setComposioApiKey(vault, FAKE_KEY);
  assert.equal(hasComposioApiKey(vault), true);
  assert.equal(getComposioApiKey(vault), FAKE_KEY);
  assert.deepEqual(vault.listSecrets('provider'), ['composio']);
  // File Vault trên đĩa chỉ chứa ciphertext — key plaintext không xuất hiện.
  const onDisk = fs.readFileSync(path.join(dir, 'vault.json'), 'utf8');
  assert.ok(!onDisk.includes(FAKE_KEY), 'vault file must not contain the plaintext key');
  assert.equal(clearComposioApiKey(vault), true);
  assert.equal(hasComposioApiKey(vault), false);
  assert.throws(() => setComposioApiKey(vault, '   '), /không được rỗng/);
});

test('composio: key thiếu → lỗi sạch ComposioError, không crash, không lộ key', async () => {
  const mock = await startMockComposio();
  const router = makeRouter(mock, null);
  assert.equal(router.hasApiKey(), false);
  await assert.rejects(
    router.createSession({ userId: FAKE_USER, toolkits: ['gmail'] }),
    (err) => {
      assert.ok(err instanceof ComposioError);
      assert.equal(err.code, 'composio_key_missing');
      assert.ok(!err.message.includes(FAKE_KEY));
      return true;
    },
  );
  // Key sai → HTTP 401 từ mock, message không chứa key.
  const badRouter = makeRouter(mock, 'ck_wrong_key');
  await assert.rejects(
    badRouter.createSession({ userId: FAKE_USER, toolkits: ['gmail'] }),
    (err) => {
      assert.ok(err instanceof ComposioError);
      assert.equal(err.code, 'composio_http_error');
      assert.ok(err.message.includes('401'));
      assert.ok(!err.message.includes('ck_wrong_key'));
      return true;
    },
  );
});

test('composio: tạo session qua mock REST — session_id + presigned MCP URL', async () => {
  const mock = await startMockComposio();
  const router = makeRouter(mock);
  const session = await router.createSession({ userId: FAKE_USER, toolkits: ['gmail', 'github'] });
  assert.equal(session.sessionId, 'sess-mock-1');
  assert.equal(session.userId, FAKE_USER);
  assert.ok(session.mcpUrl.startsWith('http://127.0.0.1:'));
  assert.deepEqual(session.toolkits, ['gmail', 'github']);
  assert.equal(mock.state.sessionCreates, 1);
  // buildMcpConfig: đúng shape cho connectMcp (url + headers mang key).
  const config = router.buildMcpConfig(session);
  assert.equal(config.name, 'composio-tool-router');
  assert.equal(config.url, session.mcpUrl);
  assert.equal(config.headers['x-api-key'], FAKE_KEY);
});

test('composio: createSession gửi toolkits dạng policy object {enable: [...]} — live v0.72', async () => {
  // Server thật trả HTTP 400 `Error in payload.toolkits: Invalid input`
  // khi toolkits là mảng string thẳng; wire shape đúng (theo docs
  // "Configuring sessions") là object policy `{enable: [...]}`.
  const bodies = [];
  const router = new ComposioToolRouter({
    apiKey: FAKE_KEY,
    fetchFn: async (_url, init) => {
      bodies.push(init?.body ?? '');
      return {
        status: 200,
        text: async () =>
          JSON.stringify({ session_id: 'sess-cap-1', mcp: { url: 'http://127.0.0.1:9/mcp', headers: {} } }),
      };
    },
  });
  await router.createSession({ userId: FAKE_USER, toolkits: ['gmail', 'github'] });
  assert.deepEqual(JSON.parse(bodies[0]), {
    user_id: FAKE_USER,
    toolkits: { enable: ['gmail', 'github'] },
  });
  // Không toolkit → bỏ hẳn field toolkits (mặc định server: không giới hạn).
  await router.createSession({ userId: FAKE_USER });
  assert.deepEqual(JSON.parse(bodies[1]), { user_id: FAKE_USER });
});

test('composio: listSessionTools qua mock REST trả slug + schema', async () => {
  const mock = await startMockComposio();
  const router = makeRouter(mock);
  const { items } = await router.listSessionTools('sess-mock-1');
  assert.deepEqual(
    items.map((i) => i.slug),
    ['GMAIL_FETCH_EMAILS', 'GMAIL_SEND_EMAIL'],
  );
  assert.equal(items[0].inputParameters?.type, 'object');
});

test('composio: MCP Tool Router mock qua connectMcp thật — list + search + execute', async () => {
  const mock = await startMockComposio();
  const router = makeRouter(mock);
  const session = await router.createSession({ userId: FAKE_USER, toolkits: ['gmail'] });
  const client = await connectMcp(router.buildMcpConfig(session));
  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        'COMPOSIO_GET_TOOL_SCHEMAS',
        'COMPOSIO_MANAGE_CONNECTIONS',
        'COMPOSIO_MULTI_EXECUTE_TOOL',
        'COMPOSIO_REMOTE_BASH_TOOL',
        'COMPOSIO_REMOTE_WORKBENCH',
        'COMPOSIO_SEARCH_TOOLS',
        'COMPOSIO_WAIT_FOR_CONNECTIONS',
      ].sort(),
    );
    // callTool của MCP client trả string thuần (không phải {text, isError}).
    const callTool = async (name, args) => {
      const text = await client.callTool(name, args);
      return { text, isError: text.startsWith('MCP tool error:') };
    };
    const found = await router.searchTools('gửi mail cho Lan', callTool);
    assert.ok(found.includes('GMAIL_SEND_EMAIL'));
    assert.equal(mock.state.searchCalls, 1);
    const out = await router.executeTool('GMAIL_SEND_EMAIL', { recipient_email: 'lan@example.com', subject: '[open-bot live test] mock', body: 'mock only' }, callTool);
    assert.ok(out.includes('mock-msg-1'));
    assert.equal(mock.state.executeCalls, 1);
    // MULTI_EXECUTE nhận đúng shape tools[] + arguments lồng nhau.
    // recipient_email là field THẬT (schema live v0.85: field chính,
    // 'to' chỉ là alias; subject/body: ít nhất 1 trong 2 phải có).
    assert.deepEqual(mock.state.lastExecuteArgs, {
      tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'lan@example.com', subject: '[open-bot live test] mock', body: 'mock only' } }],
    });
    // Giới hạn 50 tool/call của Tool Router được chặn ở client.
    const fiftyOne = Array.from({ length: 51 }, (_, i) => ({
      tool: 'GMAIL_FETCH_EMAILS',
      arguments: { n: i },
    }));
    await assert.rejects(router.executeTools(fiftyOne, callTool), /tối đa 50/);
  } finally {
    await client.close();
  }
});

test('composio: MCP URL lạ bị từ chối (chống SSRF qua session giả)', () => {
  assert.equal(isTrustedComposioMcpUrl('https://mcp.composio.dev/tool-router/abc'), true);
  assert.equal(isTrustedComposioMcpUrl('https://backend.composio.dev/tool_router/abc/mcp'), true);
  assert.equal(isTrustedComposioMcpUrl('http://127.0.0.1:9/mcp'), true);
  assert.equal(isTrustedComposioMcpUrl('https://evil.example.com/mcp'), false);
  assert.equal(isTrustedComposioMcpUrl('http://mcp.composio.dev/tool-router/abc'), false);
  assert.equal(isTrustedComposioMcpUrl('not a url'), false);
});

test('composio: source mặc định TẮT; bật → đăng ký router + 40 toolkit; tắt từng app; tắt source → gỡ hết', () => {
  const registry = new AppRegistry(BUILTIN_APPS);
  const source = new ComposioAppSource({ registry, hasApiKey: () => false });
  assert.equal(source.isEnabled(), false);
  assert.equal(registry.size(), 6);
  source.setEnabled(true);
  assert.equal(registry.size(), 47);
  assert.deepEqual(source.registeredAppIds(), [
    'composio',
    'composio-airtable',
    'composio-asana',
    'composio-bitbucket',
    'composio-box',
    'composio-calendly',
    'composio-clickup',
    'composio-confluence',
    'composio-discord',
    'composio-dropbox',
    'composio-freshdesk',
    'composio-github',
    'composio-gitlab',
    'composio-gmail',
    'composio-googlecalendar',
    'composio-googledocs',
    'composio-googledrive',
    'composio-googlesheets',
    'composio-hubspot',
    'composio-jira',
    'composio-linear',
    'composio-linkedin',
    'composio-mailchimp',
    'composio-monday',
    'composio-notion',
    'composio-outlook',
    'composio-pagerduty',
    'composio-reddit',
    'composio-salesforce',
    'composio-sendgrid',
    'composio-shopify',
    'composio-slack',
    'composio-stripe',
    'composio-telegram',
    'composio-trello',
    'composio-twilio',
    'composio-typeform',
    'composio-whatsapp',
    'composio-youtube',
    'composio-zendesk',
    'composio-zoom',
  ]);
  // Bật lại không đăng ký trùng.
  source.setEnabled(true);
  assert.equal(registry.size(), 47);
  // Tắt riêng Notion → gỡ đúng 1 app; bật lại → đăng ký lại.
  source.setToolkitEnabled('notion', false);
  assert.equal(registry.has('composio-notion'), false);
  assert.equal(registry.size(), 46);
  assert.deepEqual(source.enabledToolkits(), [
    'gmail',
    'github',
    'slack',
    'googlesheets',
    'googledrive',
    'googlecalendar',
    'jira',
    'linear',
    'discord',
    'telegram',
    'trello',
    'asana',
    'hubspot',
    'zoom',
    'salesforce',
    'zendesk',
    'airtable',
    'monday',
    'clickup',
    'dropbox',
    'outlook',
    'stripe',
    'shopify',
    'box',
    'confluence',
    'gitlab',
    'calendly',
    'mailchimp',
    'twilio',
    'googledocs',
    'youtube',
    'linkedin',
    'reddit',
    'whatsapp',
    'pagerduty',
    'typeform',
    'sendgrid',
    'bitbucket',
    'freshdesk',
  ]);
  source.setToolkitEnabled('notion', true);
  assert.equal(registry.size(), 47);
  // Toolkit lạ → lỗi rõ ràng.
  assert.throws(() => source.setToolkitEnabled('nope-toolkit', true), /Không rõ toolkit/);
  // Tắt source → gỡ hết app Composio, 6 app local còn nguyên.
  source.setEnabled(false);
  assert.equal(registry.size(), 6);
  assert.deepEqual(
    registry.list().map((a) => a.id).sort(),
    ['github', 'gmail', 'imessage', 'meeting', 'slack', 'teams'],
  );
  // Đường gọi khi tắt → lỗi sạch.
  assert.throws(() => source.requireEnabled(), (err) => err.code === 'composio_disabled');
});

test('composio: catalog 40 toolkit — source + authType + slug đã xác nhận, không đụng tool local', () => {
  const defs = createComposioAppDefinitions();
  assert.equal(defs.length, 41);
  const toolkits = defs.filter((d) => d.id !== 'composio');
  assert.deepEqual(
    toolkits.map((d) => d.toolkit).sort(),
    [...COMPOSIO_TOOLKIT_SLUGS].sort(),
  );
  for (const def of defs) {
    assert.equal(def.source, 'composio');
    assert.equal(def.authType, 'composio');
    assert.equal(def.connectorId, undefined);
  }
  const gmail = defs.find((d) => d.id === 'composio-gmail');
  assert.deepEqual(
    gmail.tools.map((t) => t.name),
    [
      'GMAIL_FETCH_EMAILS',
      'GMAIL_SEND_EMAIL',
      'GMAIL_LIST_THREADS',
      'GMAIL_GET_PROFILE',
      'GMAIL_SEARCH_PEOPLE',
      'GMAIL_CREATE_EMAIL_DRAFT',
      'GMAIL_SEND_DRAFT',
      'GMAIL_REPLY_TO_THREAD',
      'GMAIL_LIST_LABELS',
      'GMAIL_MOVE_TO_TRASH',
    ],
  );
  assert.equal(gmail.tools.find((t) => t.name === 'GMAIL_SEND_EMAIL').needsApproval, true);
  assert.equal(gmail.tools.find((t) => t.name === 'GMAIL_FETCH_EMAILS').needsApproval, false);
  // Tool Composio (slug HOA) không đụng tên tool local (thường) — cả hai cùng sống trong registry.
  const registry = new AppRegistry(BUILTIN_APPS);
  for (const def of defs) registry.register(def);
  assert.equal(registry.appIdForTool('email_read'), 'gmail');
  assert.equal(registry.appIdForTool('GMAIL_FETCH_EMAILS'), 'composio-gmail');
  assert.equal(registry.appIdForTool('COMPOSIO_SEARCH_TOOLS'), 'composio');
});

test('composio: cap M7 vẫn áp cho tool Composio; tool local không bị ảnh hưởng', () => {
  const registry = new AppRegistry(BUILTIN_APPS);
  const source = new ComposioAppSource({ registry, hasApiKey: () => true });
  source.setEnabled(true);
  // Giả lập 12 tool Composio Gmail (router discovery trả nhiều slug) + 2 tool local.
  const fake = (name) => ({ definition: { name } });
  const tools = [
    ...Array.from({ length: 12 }, (_, i) => fake(`GMAIL_TOOL_${i}`)),
    fake('email_read'),
    fake('slack_send'),
  ];
  // GMAIL_TOOL_* chưa đăng ký trong registry nên chưa thuộc app nào —
  // đăng ký thêm 1 app composio-gmail mở rộng để test cap theo app.
  // (Trong thực tế slug discovery được map về app toolkit trước khi cap.)
  const cappedBefore = applyAppToolCaps(tools, {}, registry);
  assert.equal(cappedBefore.tools.length, 14); // chưa thuộc app nào → chưa cap
  registry.unregister('composio-gmail');
  registry.register({
    id: 'composio-gmail',
    label: 'Gmail (via Composio)',
    description: 'test',
    icon: '✉️',
    authType: 'composio',
    source: 'composio',
    toolkit: 'gmail',
    tools: Array.from({ length: 12 }, (_, i) => ({
      name: `GMAIL_TOOL_${i}`,
      description: 'mock',
      needsApproval: false,
    })),
  });
  const { tools: kept, capped } = applyAppToolCaps(tools, {}, registry);
  assert.equal(kept.length, 12); // 10 composio + 2 local
  assert.equal(capped.length, 1);
  assert.equal(capped[0].appId, 'composio-gmail');
  assert.equal(capped[0].cap, DEFAULT_APP_TOOL_CAP);
  assert.equal(capped[0].droppedToolNames.length, 2);
  assert.ok(kept.some((t) => t.definition.name === 'email_read'));
  assert.ok(kept.some((t) => t.definition.name === 'slack_send'));
  // Ghi đè cap theo app vẫn tôn trọng (vd host muốn Gmail chỉ 3 tool/turn).
  const small = applyAppToolCaps(tools, { 'composio-gmail': 3 }, registry);
  assert.equal(small.tools.filter((t) => t.definition.name.startsWith('GMAIL_TOOL_')).length, 3);
});

test('composio: status view — chưa có key → not_connected; có key → connected; tắt source → rỗng', () => {
  let keyPresent = false;
  const registry = new AppRegistry(BUILTIN_APPS);
  const source = new ComposioAppSource({ registry, hasApiKey: () => keyPresent });
  source.setEnabled(true);
  let views = source.listStatusViews();
  assert.equal(views.length, 41);
  assert.ok(views.every((v) => v.authStatus === 'not_connected'));
  assert.ok(views.every((v) => v.toolCap === DEFAULT_APP_TOOL_CAP));
  keyPresent = true;
  views = source.listStatusViews();
  assert.ok(views.every((v) => v.authStatus === 'connected'));
  assert.ok(views.every((v) => v.app.source === 'composio'));
  source.setEnabled(false);
  assert.deepEqual(source.listStatusViews(), []);
});
