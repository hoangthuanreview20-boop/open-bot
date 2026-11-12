/**
 * Tests for Composio main-seed key for the coordinator (v0.59):
 * main seeds the key in memory via RPC `composio.setApiKey` / param
 * `composioApiKey` of `createBot`, following the existing token-seed
 * pattern (`connectorTokenSets`, `mcpOAuthTokens`, `xBearer`,
 * `githubToken`). Seeded key wins over the Vault-file fallback; the
 * file reader stays as fallback when nothing was seeded.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/composio-seed-v059.test.mjs
 *
 * No live network, no real Composio account/key: the "keys" are the
 * fake strings FAKE_KEY / FAKE_KEY_2, the REST + MCP endpoints are a
 * local http://127.0.0.1 server (same shape as tests/composio-v058).
 *
 * What "simulates safeStorage" here: the coordinator is created with
 * NO dataDir, so `createComposioVaultFileKeyReader` returns null for
 * every read — exactly the failure mode of a main Vault backed by
 * Electron safeStorage / NO_STORAGE, where the child cannot open the
 * file. The meta-tool must still run when ONLY a seeded key exists.
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
  ComposioSessionManager,
  createComposioMetaTools,
  createComposioSeededKeyReader,
  createComposioVaultFileKeyReader,
  setComposioApiKey,
} from '../packages/core/dist/composio/index.js';
import { AgentCoordinator } from '../packages/core/dist/coordinator/coordinator.js';
import { CoordinatorClient } from '../packages/core/dist/coordinator/client.js';
import { Vault } from '../packages/core/dist/vault/vault.js';

/** Fake keys — distinctive so tests can prove they never leak. */
const FAKE_KEY = 'ck_mock_SEED_11111_do_not_use';
const FAKE_KEY_2 = 'ck_mock_SEED_22222_rotated';
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
 * Mock Composio backend on 127.0.0.1 (như v0.58): REST Tool Router +
 * MCP endpoint. Khác v0.58: ghi lại `lastSessionApiKey` (key nào đã
 * tạo session gần nhất) để chứng minh key xoay được dùng thật.
 */
function startMockComposio() {
  const state = {
    sessionCreates: 0,
    searchCalls: 0,
    executeCalls: 0,
    lastSessionApiKey: null,
    lastExecuteArgs: null,
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
        state.sessionCreates += 1;
        state.lastSessionApiKey = req.headers['x-api-key'];
        sendJson(200, {
          session_id: `sess-mock-${state.sessionCreates}`,
          mcp: {
            url: `${base}/mcp`,
            headers: { 'x-api-key': req.headers['x-api-key'] },
          },
          toolkits: parsed.toolkits ?? [],
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
                    results: [{ tool: 'GMAIL_SEND_EMAIL', successful: true, data: { id: 'mock-msg-1' } }],
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

// ---------------------------------------------------------------------------
// A. Seeded reader — unit (không coordinator, không mạng)
// ---------------------------------------------------------------------------

test('composio v059 seed: seeded key thắng fallback; clear seed → về fallback; seed rỗng = clear', () => {
  let fallbackKey = 'ck_fallback_000';
  const reader = createComposioSeededKeyReader(() => fallbackKey);
  assert.equal(reader(), 'ck_fallback_000');
  assert.equal(reader.hasSeededKey(), false);

  assert.equal(reader.seed(FAKE_KEY), true);
  assert.equal(reader(), FAKE_KEY);
  assert.equal(reader.hasSeededKey(), true);

  // Fallback đổi cũng không thắng key đã seed.
  fallbackKey = 'ck_fallback_999';
  assert.equal(reader(), FAKE_KEY);

  // Seed key mới ghi đè (xoay) — không cần clear trước.
  assert.equal(reader.seed(FAKE_KEY_2), true);
  assert.equal(reader(), FAKE_KEY_2);

  // Seed null / rỗng / khoảng trắng → xoá seed, về fallback.
  assert.equal(reader.seed(null), false);
  assert.equal(reader(), 'ck_fallback_999');
  reader.seed(FAKE_KEY);
  assert.equal(reader(), FAKE_KEY);
  reader.seed('   ');
  assert.equal(reader(), 'ck_fallback_999');
  assert.equal(reader.hasSeededKey(), false);
  reader.seed(FAKE_KEY);
  reader.clearSeed();
  assert.equal(reader(), 'ck_fallback_999');
  assert.equal(reader.hasSeededKey(), false);

  // Fallback ném lỗi → null (fail-closed), không crash.
  const throwing = createComposioSeededKeyReader(() => {
    throw new Error('vault unreadable');
  });
  assert.equal(throwing(), null);
});

// ---------------------------------------------------------------------------
// B–E. Coordinator in-process: seed qua createBot / RPC, fallback file
// ---------------------------------------------------------------------------

let mock;
let coordinator; // KHÔNG dataDir → file reader luôn null (mô phỏng safeStorage).
let seededBotWs;
const seededBots = [];
/** Workspace của bot phải sống suốt file (afterEach dọn tmpDirs). */
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
  for (const botId of seededBots.splice(0)) {
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
  // Trả Composio về TẮT sau mỗi test (registry dùng chung về mặc định).
  await coordinator.handle('composio.setState', { enabled: false, toolkits: [...COMPOSIO_TOOLKIT_SLUGS] });
});

async function createSeededBot(id, composioApiKey) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `composio-v059-bot-${id}-`));
  botDirs.push(ws);
  seededBotWs = ws;
  const created = await coordinator.createBot({
    bot: botConfig(id, ws),
    provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'hi' }] },
    ...(composioApiKey !== undefined ? { composioApiKey } : {}),
  });
  seededBots.push(id);
  return created;
}

test('composio v059 seed: chỉ có seeded key (KHÔNG file Vault đọc được) → meta-tool chạy được', async () => {
  // Chưa seed, chưa có file → trạng thái key là none, tool fail-closed.
  const before = await coordinator.handle('composio.getKeyStatus', {});
  assert.deepEqual(before, { hasKey: false, seeded: false, source: 'none' });

  // Seed qua param createBot (đúng mẫu xBearer/githubToken).
  await createSeededBot('v059-seed', FAKE_KEY);
  const status = await coordinator.handle('composio.getKeyStatus', {});
  assert.deepEqual(status, { hasKey: true, seeded: true, source: 'seeded' });
  // Kết quả RPC không chứa key.
  assert.ok(!JSON.stringify(status).includes(FAKE_KEY));

  await coordinator.handle('composio.setState', { enabled: true, toolkits: ['gmail'] });
  const found = await coordinator.handle('runTool', {
    botId: 'v059-seed',
    tool: COMPOSIO_SEARCH_TOOL,
    args: { query: 'gửi mail cho Lan' },
  });
  assert.ok(found.output.includes('GMAIL_SEND_EMAIL'));
  // Session thật được tạo bằng key đã seed (mock ghi lại key).
  assert.equal(mock.state.lastSessionApiKey, FAKE_KEY);
  assert.equal(mock.state.sessionCreates, 1);

  const executed = await coordinator.handle('runTool', {
    botId: 'v059-seed',
    tool: COMPOSIO_MULTI_EXECUTE_TOOL,
    args: { tools: [{ tool: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'lan@example.com' } }] },
  });
  assert.ok(executed.output.includes('mock-msg-1'));
  // Cache: 2 runTool chỉ tạo 1 session.
  assert.equal(mock.state.sessionCreates, 1);
});

test('composio v059 seed: key xoay qua RPC setApiKey → lần gọi sau dùng key mới, không cần destroyBot', async () => {
  const sessionsBefore = mock.state.sessionCreates;
  // RPC seed key 2 (ghi đè key 1 đã seed ở test trước — cùng coordinator).
  const rotated = await coordinator.handle('composio.setApiKey', { apiKey: FAKE_KEY_2 });
  assert.deepEqual(rotated, { hasKey: true, seeded: true, source: 'seeded' });
  assert.ok(!JSON.stringify(rotated).includes(FAKE_KEY_2));

  await coordinator.handle('composio.setState', { enabled: true, toolkits: ['gmail'] });
  const found = await coordinator.handle('runTool', {
    botId: 'v059-seed',
    tool: COMPOSIO_SEARCH_TOOL,
    args: { query: 'gửi mail cho Lan' },
  });
  assert.ok(found.output.includes('GMAIL_SEND_EMAIL'));
  // Session mới tạo bằng key đã xoay (session cũ bị huỷ khi seed đổi key).
  assert.equal(mock.state.sessionCreates, sessionsBefore + 1);
  assert.equal(mock.state.lastSessionApiKey, FAKE_KEY_2);

  // Xoay lại qua createBot re-attach (cùng bot id, không destroyBot):
  // seed đặt TRƯỚC re-attach check nên key mới vẫn áp dụng.
  await coordinator.createBot({
    bot: botConfig('v059-seed', seededBotWs),
    provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'hi' }] },
    composioApiKey: FAKE_KEY,
  });
  const back = await coordinator.handle('composio.getKeyStatus', {});
  assert.deepEqual(back, { hasKey: true, seeded: true, source: 'seeded' });
  const found2 = await coordinator.handle('runTool', {
    botId: 'v059-seed',
    tool: COMPOSIO_SEARCH_TOOL,
    args: { query: 'gửi mail' },
  });
  assert.ok(found2.output.includes('GMAIL_SEND_EMAIL'));
  assert.equal(mock.state.lastSessionApiKey, FAKE_KEY);
});

test('composio v059 seed: clear seed (setApiKey null) → về none, tool báo composio_key_missing', async () => {
  const cleared = await coordinator.handle('composio.setApiKey', { apiKey: null });
  assert.deepEqual(cleared, { hasKey: false, seeded: false, source: 'none' });

  await coordinator.handle('composio.setState', { enabled: true, toolkits: ['gmail'] });
  await assert.rejects(
    coordinator.handle('runTool', {
      botId: 'v059-seed',
      tool: COMPOSIO_SEARCH_TOOL,
      args: { query: 'gửi mail' },
    }),
    (err) => {
      assert.ok(String(err.message).includes('composio_key_missing') || String(err).includes('Chưa cấu hình'));
      assert.ok(!String(err.message).includes(FAKE_KEY));
      assert.ok(!String(err.message).includes(FAKE_KEY_2));
      return true;
    },
  );

  // Seed lại để các test sau (và afterEach) không bị ảnh hưởng.
  await coordinator.handle('composio.setApiKey', { apiKey: FAKE_KEY });
  const status = await coordinator.handle('composio.getKeyStatus', {});
  assert.deepEqual(status, { hasKey: true, seeded: true, source: 'seeded' });
});

test('composio v059 seed: bật source khi chưa có key → emit event composio.key-needed (xin seed lại)', async () => {
  const events = [];
  const coord2 = new AgentCoordinator({
    emit: (notification) => {
      events.push(notification);
    },
    composio: {
      baseUrl: `http://127.0.0.1:${mock.port}/api/v3.1`,
      fetchFn: mockFetchFn(),
    },
  });
  try {
    // Chưa seed, không dataDir → không có key.
    assert.deepEqual(await coord2.handle('composio.getKeyStatus', {}), {
      hasKey: false,
      seeded: false,
      source: 'none',
    });
    await coord2.handle('composio.setState', { enabled: true, toolkits: ['gmail'] });
    const keyNeeded = events.filter(
      (n) => n.event === 'agent.event' && n.data?.kind === 'composio.key-needed',
    );
    assert.equal(keyNeeded.length, 1);
    assert.equal(keyNeeded[0].data.botId, '');
    assert.deepEqual(keyNeeded[0].data.payload, { reason: 'composio_key_missing' });
    assert.ok(!JSON.stringify(keyNeeded[0]).includes(FAKE_KEY));

    // Tắt source thì KHÔNG emit thêm (không spam).
    const countBefore = events.length;
    await coord2.handle('composio.setState', { enabled: false, toolkits: [] });
    assert.equal(events.length, countBefore);

    // Đã seed key rồi bật lại → không emit nữa.
    await coord2.handle('composio.setApiKey', { apiKey: FAKE_KEY });
    await coord2.handle('composio.setState', { enabled: true, toolkits: ['gmail'] });
    assert.equal(
      events.filter((n) => n.event === 'agent.event' && n.data?.kind === 'composio.key-needed').length,
      1,
    );
  } finally {
    try {
      coord2.shutdown();
    } catch {
      // Bỏ qua.
    }
  }
});

test('composio v059 seed: không seed → vẫn fallback file reader như cũ (LocalEncryptor)', async () => {
  const dir = tmpDir('composio-v059-vault-');
  const vault = new Vault({ storePath: path.join(dir, 'vault.json') });
  setComposioApiKey(vault, FAKE_KEY);
  const coord3 = new AgentCoordinator({
    dataDir: dir,
    composio: {
      baseUrl: `http://127.0.0.1:${mock.port}/api/v3.1`,
      fetchFn: mockFetchFn(),
    },
  });
  try {
    // Không seed: nguồn là vault-file (fallback v0.58 còn nguyên).
    const status = await coord3.handle('composio.getKeyStatus', {});
    assert.deepEqual(status, { hasKey: true, seeded: false, source: 'vault-file' });

    const ws = tmpDir('composio-v059-fallback-bot-');
    await coord3.createBot({
      bot: botConfig('v059-fallback', ws),
      provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'hi' }] },
    });
    await coord3.handle('composio.setState', { enabled: true, toolkits: ['gmail'] });
    const found = await coord3.handle('runTool', {
      botId: 'v059-fallback',
      tool: COMPOSIO_SEARCH_TOOL,
      args: { query: 'gửi mail' },
    });
    assert.ok(found.output.includes('GMAIL_SEND_EMAIL'));

    // Seed sau đó thắng fallback (key seed khác key file).
    await coord3.handle('composio.setApiKey', { apiKey: FAKE_KEY_2 });
    assert.deepEqual(await coord3.handle('composio.getKeyStatus', {}), {
      hasKey: true,
      seeded: true,
      source: 'seeded',
    });
    // Clear seed → về lại fallback file.
    await coord3.handle('composio.setApiKey', { apiKey: null });
    assert.deepEqual(await coord3.handle('composio.getKeyStatus', {}), {
      hasKey: true,
      seeded: false,
      source: 'vault-file',
    });
  } finally {
    try {
      await coord3.destroyBot({ botId: 'v059-fallback' });
    } catch {
      // Bỏ qua.
    }
    try {
      coord3.shutdown();
    } catch {
      // Bỏ qua.
    }
  }
});

test('composio v059 seed: setApiKey với params sai → lỗi rõ, trạng thái không đổi', async () => {
  await assert.rejects(
    coordinator.handle('composio.setApiKey', { apiKey: 123 }),
    /cần apiKey là string/,
  );
  await assert.rejects(
    coordinator.handle('composio.setApiKey', null),
    /cần params/,
  );
  // Trạng thái giữ nguyên (key FAKE_KEY đã seed lại ở test clear).
  assert.deepEqual(await coordinator.handle('composio.getKeyStatus', {}), {
    hasKey: true,
    seeded: true,
    source: 'seeded',
  });
});

// ---------------------------------------------------------------------------
// F. Key không xuất hiện trong log / RPC log
// ---------------------------------------------------------------------------

test('composio v059 seed: key không xuất hiện trong stderr, getState, hay error message', async () => {
  const captured = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    captured.push(String(chunk));
    return originalWrite(chunk, ...rest);
  };
  try {
    await coordinator.handle('composio.setApiKey', { apiKey: FAKE_KEY_2 });
    await coordinator.handle('composio.setState', { enabled: true, toolkits: ['gmail'] });
    const state = await coordinator.handle('composio.getState', {});
    assert.ok(!JSON.stringify(state).includes(FAKE_KEY_2));
    await coordinator.handle('runTool', {
      botId: 'v059-seed',
      tool: COMPOSIO_SEARCH_TOOL,
      args: { query: 'gửi mail' },
    });
    // Seed lại key 1 cho các test chạy sau (nếu có).
    await coordinator.handle('composio.setApiKey', { apiKey: FAKE_KEY });
  } finally {
    process.stderr.write = originalWrite;
  }
  const joined = captured.join('');
  assert.ok(!joined.includes(FAKE_KEY), 'stderr must not contain the seeded key');
  assert.ok(!joined.includes(FAKE_KEY_2), 'stderr must not contain the rotated key');
});

// ---------------------------------------------------------------------------
// G. CoordinatorClient qua NDJSON-RPC thật (tiến trình con)
// ---------------------------------------------------------------------------

test('composio v059 seed: client setApiKey/getKeyStatus qua NDJSON-RPC — không key trong kết quả', async () => {
  const client = new CoordinatorClient();
  try {
    const pong = await client.ping();
    assert.equal(pong.pong, true);
    // Tiến trình con mới spawn: chưa seed, không có Vault file trong
    // userData mặc định của test → none.
    const initial = await client.getComposioKeyStatus();
    assert.equal(initial.hasKey, false);
    assert.equal(initial.seeded, false);
    assert.equal(initial.source, 'none');

    const seeded = await client.setComposioApiKey(FAKE_KEY);
    assert.deepEqual(seeded, { hasKey: true, seeded: true, source: 'seeded' });
    assert.ok(!JSON.stringify(seeded).includes(FAKE_KEY));
    assert.deepEqual(await client.getComposioKeyStatus(), seeded);

    // Seed qua createBot param cũng qua được NDJSON-RPC.
    const ws = tmpDir('composio-v059-rpc-bot-');
    const created = await client.createBot({
      bot: botConfig('v059-rpc', ws),
      provider: { id: 'mock', label: 'Mock', mockResponses: [{ text: 'hi' }] },
      composioApiKey: FAKE_KEY_2,
    });
    assert.ok(created.botId === 'v059-rpc');
    // Key đã xoay thành FAKE_KEY_2 trong con (status vẫn seeded, không lộ key).
    const afterCreate = await client.getComposioKeyStatus();
    assert.deepEqual(afterCreate, { hasKey: true, seeded: true, source: 'seeded' });
    assert.ok(!JSON.stringify(afterCreate).includes(FAKE_KEY_2));
    await client.destroyBot('v059-rpc');

    // Clear qua RPC → về none.
    const cleared = await client.setComposioApiKey(null);
    assert.deepEqual(cleared, { hasKey: false, seeded: false, source: 'none' });
  } finally {
    await client.dispose();
  }
});
