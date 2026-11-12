/**
 * Harness live test Composio — 6 bước (v0.59, docs/composio-integration.md §7–§8).
 *
 * Đây là HARNESS CHẠY ĐƯỢC BẰNG MOCK — không key/tài khoản thật, không
 * mạng thật. Toàn bộ 6 bước trong §8 được đi hết bằng mock server
 * local (REST Tool Router + MCP endpoint trên 127.0.0.1), đúng thứ tự
 * live test thật sẽ chạy:
 *   (1) nhập key vào Vault (mock key),
 *   (2) bật source + toolkit GitHub, kiểm tra apps:list + badge,
 *   (3) tạo session thật qua mock → tools/list qua connectMcp thật →
 *       ghi lại 7 meta-tool + input schema thật của
 *       COMPOSIO_MULTI_EXECUTE_TOOL, bổ sung slug Slack/Notion thấy
 *       được vào catalog (xem chú thích MOCK-SLUG bên dưới),
 *   (4) SEARCH_TOOLS → execute GITHUB_CREATE_AN_ISSUE trên repo test
 *       (mock), kiểm tra + revoke (mock),
 *   (5) Gmail/Slack chỉ sau khi (4) xanh (mock, ghi rõ rủi ro custody),
 *   (6) đo độ trễ thêm 1 hop + tắt mạng tới Composio thì app local
 *       vẫn chạy.
 *
 * Chạy:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/composio-live-harness-v059.test.mjs
 *
 * MOCK-SLUG — ĐỌC KỸ: một số slug mà mock "phát hiện" ở bước (3)
 * (`SLACK_LIST_CHANNELS`, `NOTION_CREATE_PAGE`, `NOTION_SEARCH`) là
 * slug DO MOCK TỰ BỊA để harness chạy được, KHÔNG phải slug thật
 * của Composio. Chúng chỉ được ghi vào báo cáo harness
 * (`report.discoveredSlugs`, file JSON trong os.tmpdir), KHÔNG được
 * thêm vào `packages/core/src/composio/toolkits.ts` (catalog chỉ
 * nhận slug đã xác nhận từ response thật của Composio). Từ v0.85,
 * `SLACK_SEND_MESSAGE` đã là slug THẬT (schema live đã fetch — xem
 * docs §8.1) nên mock dùng nó thay cho slug bịa `SLACK_POST_MESSAGE`
 * cũ; args GitHub/GitHub-Slack/Gmail trong mock cũng theo đúng
 * schema thật (owner+repo+title riêng; channel không có '#';
 * recipient_email + subject/body). Từ v0.86, slug GitHub trong mock
 * cũng là slug THẬT `GITHUB_CREATE_AN_ISSUE` (xác nhận từ response
 * thật của Composio ở live test v0.72, shape {owner, repo, title})
 * — chỉ còn các slug Slack/Notion `SLACK_LIST_CHANNELS`,
 * `NOTION_CREATE_PAGE`, `NOTION_SEARCH` là mock-only (tự bịa).
 *
 * Bước (1) còn mô phỏng main seed key cho coordinator qua RPC
 * `composio.setApiKey` (đường chính v0.59) để các bước sau chạy qua
 * key đã seed như app thật, không chỉ qua file reader Vault.
 *
 * Live test thật CHỜ key Composio của Huy — harness này không hỏi
 * key, không nhập key thật vào đâu (xem docs §7–§8).
 */
import { test, before, after } from 'node:test';
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
  ComposioSessionManager,
  createComposioMetaTools,
  createComposioToolkitAppDefinitions,
  getComposioApiKey,
  hasComposioApiKey,
  setComposioApiKey,
} from '../packages/core/dist/composio/index.js';
import { ComposioToolRouter } from '../packages/core/dist/composio/router.js';
import { connectMcp } from '../packages/core/dist/mcp/client.js';
import { AgentCoordinator } from '../packages/core/dist/coordinator/coordinator.js';
import { Vault } from '../packages/core/dist/vault/vault.js';

/** Fake key — mock only, không phải key thật. */
const FAKE_KEY = 'ck_mock_HARNESS_13579_do_not_use';
const FAKE_USER = 'local-user-1';
/** Repo test (mock) — owner + repo RIÊNG theo schema thật của
 * GITHUB_CREATE_AN_ISSUE (v0.72: bắt buộc owner + repo + title,
 * không phải 1 field repo dạng 'owner/repo'). */
const TEST_OWNER = 'mock-org';
const TEST_REPO = 'mock-repo';

/**
 * Cảnh báo custody (bước 5): token OAuth của từng app (Gmail, Slack…)
 * nằm phía Composio (managed OAuth) và KHÔNG BAO GIỜ về máy này — xem
 * docs/composio-integration.md §9. Gmail/Slack chỉ dùng cho tài khoản
 * không nhạy cảm trước, sau khi bước (4) đã xanh.
 */
const CUSTODY_WARNING =
  'Rủi ro custody: token OAuth Gmail/Slack nằm phía Composio (managed OAuth), ' +
  'không lưu trên máy này; chỉ dùng cho tài khoản không nhạy cảm trước. ' +
  'Xem docs/composio-integration.md §9 (sự cố 05/2026).';

/** 7 meta-tool mà Tool Router phải trả qua tools/list. */
const EXPECTED_META_TOOLS = [
  'COMPOSIO_SEARCH_TOOLS',
  'COMPOSIO_GET_TOOL_SCHEMAS',
  'COMPOSIO_MULTI_EXECUTE_TOOL',
  'COMPOSIO_MANAGE_CONNECTIONS',
  'COMPOSIO_WAIT_FOR_CONNECTIONS',
  'COMPOSIO_REMOTE_WORKBENCH',
  'COMPOSIO_REMOTE_BASH_TOOL',
];

/** Báo cáo harness — mỗi bước ghi 'pass' + bằng chứng (không chứa key). */
const report = {
  harness: 'composio-live-harness-v059',
  mode: 'mock (không key/tài khoản/mạng thật)',
  steps: {},
  discoveredSlugs: { slack: [], notion: [] },
  multiExecuteInputSchema: null,
  issueCreated: null,
  latencyMs: {},
  custodyWarning: CUSTODY_WARNING,
};

function markStep(n, evidence) {
  report.steps[`step${n}`] = { status: 'pass', ...evidence };
}

let mock;
let coordDir;
let coordinator;
let botWs;
const botIds = [];
const harnessTmpDirs = [];

function harnessTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  harnessTmpDirs.push(dir);
  return dir;
}

/**
 * Mock Composio backend (mở rộng mock v0.58): REST session + liệt kê
 * tool session, MCP tools/list (7 meta-tool, kèm inputSchema thật
 * dạng của COMPOSIO_MULTI_EXECUTE_TOOL) + tools/call (search /
 * schemas / execute, có revoke).
 */
function startMockComposio() {
  const state = {
    sessionCreates: 0,
    searchCalls: 0,
    schemaCalls: 0,
    executeCalls: 0,
    lastExecuteArgs: null,
    revoked: false,
    sessions: new Map(),
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
      const url = new URL(req.url, base);
      if (url.pathname === '/api/v3.1/tool_router/session' && req.method === 'POST') {
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
        const sessionId = `sess-harness-${state.sessionCreates}`;
        state.sessions.set(sessionId, parsed.toolkits?.enable ?? []);
        sendJson(200, {
          session_id: sessionId,
          mcp: { url: `${base}/mcp`, headers: { 'x-api-key': req.headers['x-api-key'] } },
          toolkits: parsed.toolkits?.enable ?? [],
        });
        return;
      }
      // Liệt kê tool của session (REST) — mock "phát hiện" slug
      // Slack/Notion (MOCK-SLUG: chỉ để harness chạy, không phải thật).
      const toolsMatch = url.pathname.match(
        /^\/api\/v3\.1\/tool_router\/session\/([^/]+)\/tools$/,
      );
      if (toolsMatch && req.method === 'GET') {
        if (req.headers['x-api-key'] !== FAKE_KEY) {
          sendJson(401, { error: 'invalid api key' });
          return;
        }
        if (!state.sessions.has(toolsMatch[1])) {
          sendJson(404, { error: 'unknown session' });
          return;
        }
        sendJson(200, {
          items: [
            { slug: 'GMAIL_FETCH_EMAILS', description: 'Mock: fetch emails', input_parameters: { type: 'object', properties: {} } },
            { slug: 'GMAIL_SEND_EMAIL', description: 'Mock: send email', input_parameters: { type: 'object', properties: { recipient_email: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, cc: { type: 'array', items: { type: 'string' } }, bcc: { type: 'array', items: { type: 'string' } } } } },
            { slug: 'GITHUB_CREATE_AN_ISSUE', description: 'Mock server, slug THẬT (v0.72): create issue', input_parameters: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } } } },
            { slug: 'SLACK_SEND_MESSAGE', description: 'Mock-discovered Slack slug (THẬT từ v0.85 — schema live đã fetch)', input_parameters: { type: 'object', properties: { channel: { type: 'string' }, markdown_text: { type: 'string' }, fallback_text: { type: 'string' } } } },
            { slug: 'SLACK_LIST_CHANNELS', description: 'Mock-discovered Slack slug', input_parameters: { type: 'object', properties: {} } },
            { slug: 'NOTION_CREATE_PAGE', description: 'Mock-discovered Notion slug', input_parameters: { type: 'object', properties: { title: { type: 'string' } } } },
            { slug: 'NOTION_SEARCH', description: 'Mock-discovered Notion slug', input_parameters: { type: 'object', properties: { query: { type: 'string' } } } },
          ],
          next_cursor: '',
        });
        return;
      }
      if (url.pathname !== '/mcp' || req.method !== 'POST') {
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
        res.writeHead(202);
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
        case 'tools/list': {
          const inputSchemaFor = (name) => {
            if (name === 'COMPOSIO_MULTI_EXECUTE_TOOL') {
              return {
                type: 'object',
                properties: {
                  tools: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        tool_slug: { type: 'string', description: 'Slug tool Composio' },
                        arguments: { type: 'object', description: 'Arguments lồng nhau' },
                        account: { type: 'string', description: 'Tài khoản (nhiều account)' },
                      },
                      required: ['tool_slug', 'arguments'],
                    },
                  },
                },
                required: ['tools'],
              };
            }
            if (name === 'COMPOSIO_SEARCH_TOOLS') {
              return {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query'],
              };
            }
            if (name === 'COMPOSIO_GET_TOOL_SCHEMAS') {
              return {
                type: 'object',
                properties: { tools: { type: 'array', items: { type: 'string' } } },
                required: ['tools'],
              };
            }
            return { type: 'object', properties: {} };
          };
          result(msg.id, {
            tools: EXPECTED_META_TOOLS.map((name) => ({
              name,
              description: `Mock meta-tool ${name}`,
              inputSchema: inputSchemaFor(name),
            })),
          });
          break;
        }
        case 'tools/call': {
          const name = msg.params?.name;
          const args = msg.params?.arguments ?? {};
          if (state.revoked && name === 'COMPOSIO_MULTI_EXECUTE_TOOL') {
            result(msg.id, {
              content: [{ type: 'text', text: 'Connection revoked on Composio side' }],
              isError: true,
            });
            return;
          }
          if (name === 'COMPOSIO_SEARCH_TOOLS') {
            state.searchCalls += 1;
            const q = String(args.query ?? '').toLowerCase();
            let tools = [{ slug: 'GMAIL_SEND_EMAIL', description: 'Send an email' }];
            if (q.includes('issue') || q.includes('github')) {
              tools = [{ slug: 'GITHUB_CREATE_AN_ISSUE', description: 'Create a GitHub issue' }];
            } else if (q.includes('slack')) {
              tools = [{ slug: 'SLACK_SEND_MESSAGE', description: 'Post a Slack message' }];
            } else if (q.includes('notion')) {
              tools = [{ slug: 'NOTION_CREATE_PAGE', description: 'Create a Notion page' }];
            }
            result(msg.id, {
              content: [{ type: 'text', text: JSON.stringify({ tools }) }],
              isError: false,
            });
          } else if (name === 'COMPOSIO_GET_TOOL_SCHEMAS') {
            state.schemaCalls += 1;
            // v0.72 (live test thật): wire shape là `{tool_slugs: [...]}` —
            // server thật từ chối khi thiếu tool_slugs, mock bắt chước.
            const slugs = Array.isArray(args.tool_slugs) ? args.tool_slugs : null;
            if (!slugs) {
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
            // probe-write-schemas): `{successful, data: {tool_schemas:
            // {<slug>: {input_schema: {required, properties}}}}}` —
            // shape cũ `{schemas: [{slug, input_parameters}]}` là
            // mock bịa. Code thật hiện không parse response nên
            // shape cũ không gây bug chạy, nhưng mock phải theo
            // shape thật để parser tương lai không sai.
            const toolSchemas = {};
            for (const slug of slugs) {
              toolSchemas[slug] = {
                input_schema: {
                  type: 'object',
                  required:
                    slug === 'GITHUB_CREATE_AN_ISSUE'
                      ? ['owner', 'repo', 'title']
                      : slug === 'SLACK_SEND_MESSAGE'
                        ? ['channel']
                        : [],
                  properties:
                    slug === 'GITHUB_CREATE_AN_ISSUE'
                      ? { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }
                      : slug === 'GMAIL_SEND_EMAIL'
                        ? { recipient_email: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, cc: { type: 'array', items: { type: 'string' } }, bcc: { type: 'array', items: { type: 'string' } } }
                        : slug === 'SLACK_SEND_MESSAGE'
                          ? { channel: { type: 'string' }, markdown_text: { type: 'string' }, fallback_text: { type: 'string' } }
                          : {},
                },
              };
            }
            result(msg.id, {
              content: [{ type: 'text', text: JSON.stringify({ successful: true, data: { tool_schemas: toolSchemas } }) }],
              isError: false,
            });
          } else if (name === 'COMPOSIO_MULTI_EXECUTE_TOOL') {
            state.executeCalls += 1;
            state.lastExecuteArgs = args;
            const tools = Array.isArray(args.tools) ? args.tools : [];
            const results = tools.map((t) => {
              if (t.tool_slug === 'GITHUB_CREATE_AN_ISSUE') {
                return {
                  tool_slug: t.tool_slug,
                  successful: true,
                  data: {
                    number: 42,
                    url: `https://github.com/${TEST_OWNER}/${TEST_REPO}/issues/42`,
                    title: t.arguments?.title ?? '',
                  },
                };
              }
              if (t.tool_slug === 'GMAIL_SEND_EMAIL') {
                return { tool_slug: t.tool_slug, successful: true, data: { id: 'mock-msg-1' } };
              }
              if (t.tool_slug === 'SLACK_SEND_MESSAGE') {
                return { tool_slug: t.tool_slug, successful: true, data: { ok: true, ts: 'mock-ts-1' } };
              }
              return { tool_slug: t.tool_slug, successful: true, data: {} };
            });
            result(msg.id, {
              content: [{ type: 'text', text: JSON.stringify({ results }) }],
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
      resolve({
        server,
        state,
        port: server.address().port,
        revoke: () => {
          state.revoked = true;
        },
        unrevoke: () => {
          state.revoked = false;
        },
      });
    });
  });
}

function mockFetchFn() {
  return async (url, init) => {
    const res = await fetch(url, init);
    return { status: res.status, text: async () => res.text() };
  };
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

before(async () => {
  mock = await startMockComposio();
  coordDir = harnessTmp('composio-harness-v059-vault-');
  botWs = harnessTmp('composio-harness-v059-botws-');
  // Bước (1) cần Vault có key TRƯỚC khi coordinator đọc (đi qua bước 1
  // trong test đầu tiên); coordinator dựng ở đây với dataDir trỏ cùng
  // thư mục — file reader thấy key sau khi bước (1) ghi xong.
  coordinator = new AgentCoordinator({
    dataDir: coordDir,
    composio: {
      baseUrl: `http://127.0.0.1:${mock.port}/api/v3.1`,
      fetchFn: mockFetchFn(),
    },
  });
});

after(async () => {
  for (const botId of botIds.splice(0)) {
    try {
      await coordinator.destroyBot({ botId });
    } catch {
      // Bỏ qua.
    }
  }
  try {
    coordinator.shutdown();
  } catch {
    // Bỏ qua.
  }
  await new Promise((resolve) => mock.server.close(() => resolve()));
  for (const dir of harnessTmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Bước (1): nhập key vào Vault (mock key)
// ---------------------------------------------------------------------------

test('harness bước 1: nhập key (mock) vào Vault — hasApiKey true, file đĩa không chứa key plaintext', async () => {
  const vault = new Vault({ storePath: path.join(coordDir, 'vault.json') });
  assert.equal(hasComposioApiKey(vault), false);
  setComposioApiKey(vault, FAKE_KEY);
  assert.equal(hasComposioApiKey(vault), true);
  assert.equal(getComposioApiKey(vault), FAKE_KEY);
  // File vault.json trên đĩa KHÔNG chứa key plaintext (mã hoá LocalEncryptor).
  const onDisk = fs.readFileSync(path.join(coordDir, 'vault.json'), 'utf8');
  assert.ok(!onDisk.includes(FAKE_KEY), 'vault.json must not contain the key in plaintext');
  // Mô phỏng main seed key cho coordinator (đường chính v0.59, RPC
  // 'composio.setApiKey' — app thật dùng đường này, không dựa vào
  // file reader): các bước 2–6 sau đó phải chạy qua key đã seed.
  // Trước v0.59+fix này harness chỉ đi qua file reader (LocalEncryptor),
  // nên một lỗi ở đường seed vẫn cho harness xanh — đã sửa.
  const seeded = await coordinator.handle('composio.setApiKey', { apiKey: FAKE_KEY });
  assert.equal(seeded.hasKey, true);
  assert.equal(seeded.seeded, true);
  assert.equal(seeded.source, 'seeded');
  markStep(1, { keyInVault: true, vaultFileHasPlaintextKey: false, seeded: true, keySource: 'seeded' });
});

// ---------------------------------------------------------------------------
// Bước (2): bật source + toolkit GitHub, kiểm tra apps:list + badge
// ---------------------------------------------------------------------------

test('harness bước 2: bật source + toolkit GitHub — apps:list hiện app + badge via Composio', async () => {
  const applied = await coordinator.handle('composio.setState', {
    enabled: true,
    toolkits: ['github'],
  });
  assert.equal(applied.enabled, true);
  assert.deepEqual(applied.toolkits, ['github']);
  // apps:list tương đương: app id Composio đã đăng ký trong registry.
  assert.deepEqual(applied.registeredAppIds, ['composio', 'composio-github']);
  const current = await coordinator.handle('composio.getState', {});
  assert.deepEqual(current, applied);
  // Badge "via Composio": catalog def của app có source 'composio'.
  const defs = createComposioToolkitAppDefinitions();
  const githubDef = defs.find((d) => d.id === 'composio-github');
  assert.ok(githubDef, 'expected catalog def composio-github');
  assert.equal(githubDef.source, 'composio');
  // Bot tạo sau khi bật → có meta-tool trong tool list.
  const created = await coordinator.createBot({
    bot: botConfig('harness-bot', botWs),
    provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'hi' }] },
  });
  botIds.push('harness-bot');
  assert.ok(created.toolNames.includes(COMPOSIO_SEARCH_TOOL));
  assert.ok(created.toolNames.includes(COMPOSIO_MULTI_EXECUTE_TOOL));
  markStep(2, { registeredAppIds: applied.registeredAppIds, badgeSource: 'composio' });
});

// ---------------------------------------------------------------------------
// Bước (3): session thật qua mock → tools/list qua connectMcp thật
// ---------------------------------------------------------------------------

test('harness bước 3: session qua mock + tools/list qua connectMcp — ghi 7 meta-tool + schema MULTI_EXECUTE + slug Slack/Notion', async () => {
  const router = new ComposioToolRouter({
    apiKey: FAKE_KEY,
    baseUrl: `http://127.0.0.1:${mock.port}/api/v3.1`,
    fetchFn: mockFetchFn(),
  });
  const t0 = Date.now();
  const session = await router.createSession({
    userId: FAKE_USER,
    toolkits: ['github', 'gmail', 'slack', 'notion'],
  });
  assert.ok(session.sessionId.startsWith('sess-harness-'));
  assert.deepEqual(session.toolkits, ['github', 'gmail', 'slack', 'notion']);
  assert.ok(session.mcpUrl.startsWith('http://127.0.0.1'));

  // tools/list qua connectMcp THẬT (Streamable HTTP) — không qua mock client.
  const mcpClient = await connectMcp(router.buildMcpConfig(session));
  try {
    const tools = await mcpClient.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...EXPECTED_META_TOOLS].sort());
    // Input schema thật của COMPOSIO_MULTI_EXECUTE_TOOL (ghi lại để
    // đối chiếu shape tools[]/arguments khi live test thật chạy).
    const multi = tools.find((t) => t.name === 'COMPOSIO_MULTI_EXECUTE_TOOL');
    assert.ok(multi, 'expected COMPOSIO_MULTI_EXECUTE_TOOL in tools/list');
    const schema = multi.inputSchema;
    assert.equal(schema.type, 'object');
    assert.equal(schema.properties.tools.type, 'array');
    assert.deepEqual(
      Object.keys(schema.properties.tools.items.properties).sort(),
      ['account', 'arguments', 'tool_slug'],
    );
    assert.deepEqual(schema.properties.tools.items.required, ['tool_slug', 'arguments']);
    report.multiExecuteInputSchema = schema;
  } finally {
    await mcpClient.close();
  }

  // Liệt kê tool session qua REST — phát hiện slug Slack/Notion.
  // MOCK-SLUG: chỉ các slug Slack/Notion (SLACK_LIST_CHANNELS,
  // NOTION_CREATE_PAGE, NOTION_SEARCH) là do mock bịa, chỉ ghi vào
  // báo cáo harness, KHÔNG thêm vào toolkits.ts (xem ghi chú đầu
  // file). GITHUB_CREATE_AN_ISSUE là slug THẬT (v0.72) — không
  // thuộc nhóm mock-only này.
  const { items } = await router.listSessionTools(session.sessionId);
  const slugs = items.map((i) => i.slug);
  assert.ok(slugs.includes('GITHUB_CREATE_AN_ISSUE'));
  const slackSlugs = slugs.filter((s) => s.startsWith('SLACK_')).sort();
  const notionSlugs = slugs.filter((s) => s.startsWith('NOTION_')).sort();
  assert.deepEqual(slackSlugs, ['SLACK_LIST_CHANNELS', 'SLACK_SEND_MESSAGE']);
  assert.deepEqual(notionSlugs, ['NOTION_CREATE_PAGE', 'NOTION_SEARCH']);
  report.discoveredSlugs = { slack: slackSlugs, notion: notionSlugs };
  markStep(3, {
    sessionId: session.sessionId,
    metaTools: EXPECTED_META_TOOLS.length,
    discoveredSlugs: report.discoveredSlugs,
    sessionCreateMs: Date.now() - t0,
  });
});

// ---------------------------------------------------------------------------
// Bước (4): SEARCH → execute GITHUB_CREATE_AN_ISSUE (mock), kiểm tra + revoke
// ---------------------------------------------------------------------------

test('harness bước 4: SEARCH_TOOLS → GITHUB_CREATE_AN_ISSUE trên repo test (mock) → kiểm tra → revoke (mock)', async () => {
  const found = await coordinator.handle('runTool', {
    botId: 'harness-bot',
    tool: COMPOSIO_SEARCH_TOOL,
    args: { query: 'tìm issue GitHub' },
  });
  assert.ok(found.output.includes('GITHUB_CREATE_AN_ISSUE'));

  const schemas = await coordinator.handle('runTool', {
    botId: 'harness-bot',
    tool: COMPOSIO_GET_TOOL_SCHEMAS,
    args: { tools: ['GITHUB_CREATE_AN_ISSUE'] },
  });
  assert.ok(schemas.output.includes('GITHUB_CREATE_AN_ISSUE'));
  // v0.85: mock GET_TOOL_SCHEMAS trả shape THẬT
  // {data: {tool_schemas: {<slug>: {input_schema}}}} — parse được
  // và required đúng shape thật (owner + repo + title riêng).
  const parsedSchemas = JSON.parse(String(schemas.output));
  assert.deepEqual(
    parsedSchemas.data.tool_schemas['GITHUB_CREATE_AN_ISSUE'].input_schema.required,
    ['owner', 'repo', 'title'],
  );

  const executed = await coordinator.handle('runTool', {
    botId: 'harness-bot',
    tool: COMPOSIO_MULTI_EXECUTE_TOOL,
    args: {
      tools: [
        {
          tool: 'GITHUB_CREATE_AN_ISSUE',
          arguments: { owner: TEST_OWNER, repo: TEST_REPO, title: 'Harness test issue', body: 'mock only' },
        },
      ],
    },
  });
  assert.ok(executed.output.includes('42'), 'expected mock issue number 42');
  assert.ok(executed.output.includes(`${TEST_OWNER}/${TEST_REPO}/issues/42`));
  // Mock ghi lại đúng args đã gửi (owner + repo RIÊNG + title —
  // shape thật của GITHUB_CREATE_AN_ISSUE, không phải 1 field repo
  // dạng 'owner/repo').
  assert.equal(mock.state.lastExecuteArgs.tools[0].tool_slug, 'GITHUB_CREATE_AN_ISSUE');
  assert.equal(mock.state.lastExecuteArgs.tools[0].arguments.owner, TEST_OWNER);
  assert.equal(mock.state.lastExecuteArgs.tools[0].arguments.repo, TEST_REPO);
  assert.equal(mock.state.lastExecuteArgs.tools[0].arguments.title, 'Harness test issue');
  report.issueCreated = { number: 42, url: `https://github.com/${TEST_OWNER}/${TEST_REPO}/issues/42` };

  // Revoke connection phía Composio (mock) → app báo lỗi rõ, không crash.
  mock.revoke();
  await assert.rejects(
    coordinator.handle('runTool', {
      botId: 'harness-bot',
      tool: COMPOSIO_MULTI_EXECUTE_TOOL,
      args: {
        tools: [{ tool: 'GITHUB_CREATE_AN_ISSUE', arguments: { owner: TEST_OWNER, repo: TEST_REPO, title: 'x' } }],
      },
    }),
    (err) => {
      assert.ok(String(err.message).includes('revoked'));
      return true;
    },
  );
  // Mở lại cho bước (5) — live test thật thì revoke là bước cuối của
  // GitHub, không mở lại; ở mock cần session mới cho bước sau.
  mock.unrevoke();
  await coordinator.handle('composio.setState', { enabled: true, toolkits: ['github', 'gmail', 'slack'] });
  markStep(4, { issue: report.issueCreated, revokedThenFailedCleanly: true });
});

// ---------------------------------------------------------------------------
// Bước (5): Gmail/Slack chỉ sau khi (4) xanh (mock, ghi rõ rủi ro custody)
// ---------------------------------------------------------------------------

test('harness bước 5: Gmail/Slack chỉ chạy khi bước 4 đã xanh — gửi mail + Slack test (mock)', async () => {
  assert.equal(report.steps.step4?.status, 'pass', 'bước 5 chỉ chạy khi bước 4 đã xanh');
  assert.ok(report.custodyWarning.includes('managed OAuth'));
  assert.ok(report.custodyWarning.includes('không lưu trên máy này'));

  // Bật thêm gmail + slack (github giữ nguyên) rồi thực thi qua mock.
  const state = await coordinator.handle('composio.setState', {
    enabled: true,
    toolkits: ['github', 'gmail', 'slack'],
  });
  assert.deepEqual(state.registeredAppIds, [
    'composio',
    'composio-github',
    'composio-gmail',
    'composio-slack',
  ]);

  const mail = await coordinator.handle('runTool', {
    botId: 'harness-bot',
    tool: COMPOSIO_MULTI_EXECUTE_TOOL,
    args: {
      tools: [{ tool: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'lan@example.com', subject: '[open-bot live test] harness ping', body: 'harness ping' } }],
    },
  });
  assert.ok(mail.output.includes('mock-msg-1'));

  const slack = await coordinator.handle('runTool', {
    botId: 'harness-bot',
    tool: COMPOSIO_MULTI_EXECUTE_TOOL,
    args: {
      tools: [{ tool: 'SLACK_SEND_MESSAGE', arguments: { channel: 'test', markdown_text: '[open-bot live test] harness ping' } }],
    },
  });
  assert.ok(slack.output.includes('mock-ts-1'));
  markStep(5, { custodyWarningRecorded: true, gmailMockId: 'mock-msg-1', slackMockTs: 'mock-ts-1' });
});

// ---------------------------------------------------------------------------
// Bước (6): độ trễ 1 hop + tắt mạng tới Composio thì app local vẫn chạy
// ---------------------------------------------------------------------------

test('harness bước 6: đo trễ 1 hop; tắt mạng tới Composio → meta-tool lỗi sạch, app local vẫn chạy', async () => {
  // Đo trễ 1 hop qua Composio (mock): search qua session manager thật.
  const manager = new ComposioSessionManager({
    getApiKey: () => FAKE_KEY,
    userId: FAKE_USER,
    getEnabledToolkits: () => ['gmail'],
    baseUrl: `http://127.0.0.1:${mock.port}/api/v3.1`,
    fetchFn: mockFetchFn(),
  });
  const tools = createComposioMetaTools({ manager });
  const searchTool = tools.find((t) => t.definition.name === COMPOSIO_SEARCH_TOOL);
  const t0 = performance.now();
  const found = await searchTool.execute(
    { query: 'gửi mail cho Lan' },
    { workspaceDir: botWs, botId: 'harness-bot' },
  );
  const hopMs = performance.now() - t0;
  assert.ok(found.includes('GMAIL_SEND_EMAIL'));
  assert.ok(Number.isFinite(hopMs) && hopMs >= 0 && hopMs < 5000, `hop latency ${hopMs}ms`);
  report.latencyMs.oneHopMockMs = Math.round(hopMs * 10) / 10;
  await manager.close();

  // Tắt mạng tới Composio (trỏ sang port không ai nghe): meta-tool lỗi
  // sạch, không crash, không treo.
  const offlineManager = new ComposioSessionManager({
    getApiKey: () => FAKE_KEY,
    userId: FAKE_USER,
    getEnabledToolkits: () => ['gmail'],
    baseUrl: 'http://127.0.0.1:1/api/v3.1',
    fetchFn: mockFetchFn(),
  });
  const offlineTools = createComposioMetaTools({ manager: offlineManager });
  const offlineSearch = offlineTools.find((t) => t.definition.name === COMPOSIO_SEARCH_TOOL);
  await assert.rejects(
    offlineSearch.execute({ query: 'gửi mail' }, { workspaceDir: botWs, botId: 'harness-bot' }),
    (err) => {
      assert.equal(err.code, 'composio_session_failed');
      assert.ok(!err.message.includes(FAKE_KEY));
      return true;
    },
  );
  await offlineManager.close();

  // App local vẫn chạy khi Composio mất mạng: tool local glob_files
  // qua coordinator + trạng thái coordinator vẫn trả lời.
  const local = await coordinator.handle('runTool', {
    botId: 'harness-bot',
    tool: 'glob_files',
    args: { pattern: '*.md' },
  });
  assert.ok(typeof local.output === 'string' && local.output.includes('Glob'));
  const state = await coordinator.handle('composio.getState', {});
  assert.equal(state.enabled, true);
  const bots = await coordinator.handle('listBots', {});
  assert.ok(bots.botIds.includes('harness-bot'));
  markStep(6, {
    oneHopMockMs: report.latencyMs.oneHopMockMs,
    offlineMetaToolFailsCleanly: true,
    localToolStillWorks: true,
  });
});

// ---------------------------------------------------------------------------
// Báo cáo harness: đủ 6 bước xanh, không chứa key
// ---------------------------------------------------------------------------

test('harness: báo cáo đủ 6 bước pass, không chứa key, ghi ra file JSON tạm', () => {
  for (let n = 1; n <= 6; n += 1) {
    assert.equal(
      report.steps[`step${n}`]?.status,
      'pass',
      `bước ${n} phải pass trước khi kết luận harness xanh`,
    );
  }
  assert.ok(!JSON.stringify(report).includes(FAKE_KEY), 'report must not contain the key');
  const reportPath = path.join(os.tmpdir(), 'composio-live-harness-v059-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`[harness] 6/6 bước mock PASS — báo cáo: ${reportPath}`);
  console.log(
    `[harness] slug Slack/Notion (MOCK, chưa phải thật): ${JSON.stringify(report.discoveredSlugs)}`,
  );
  console.log(`[harness] độ trễ 1 hop (mock): ${report.latencyMs.oneHopMockMs}ms`);
});
