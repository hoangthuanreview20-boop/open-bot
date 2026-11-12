/**
 * Tests cho P0-4 (v0.40): MCP reconnect theo số liệu Grok
 * (`mcp_reconnect_config`, deep-dive §8.2) + auth-tool UX + tasks sau
 * abstraction (backend 2026-07-28) + elicitation coverage.
 *
 * Import package core/tools ĐÃ BUILD — build trước:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * rồi chạy: node --test tests/mcp-reconnect-p04.test.mjs
 *
 * Không chờ thật: policy dùng fake clock/random; timeout/keepalive dùng
 * config thu nhỏ (vài trăm ms); server đều là giả lập local
 * (stdio file tạm / HTTP 127.0.0.1). Không mạng live, không x.ai.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DEFAULT_MCP_RECONNECT_CONFIG,
  McpReconnectPolicy,
  connectMcp,
  resolveMcpReconnectConfig,
} from '../packages/core/dist/mcp/client.js';
import { StreamableHttpTransport } from '../packages/core/dist/mcp/transport.js';
import {
  TaskError,
  createTask,
  detectTaskHandle,
  listTasks,
  runTaskToCompletion,
} from '../packages/core/dist/mcp/tasks.js';
import { ElicitationUrlTracker } from '../packages/core/dist/mcp/elicitation.js';
import {
  buildMcpServerAuthTool,
  closeMcpClientPool,
  createMcpTools,
  getMcpAuthToolName,
  isMcpAuthFailureMessage,
  MCP_TOOLS,
} from '../packages/tools/dist/mcpTools.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fake clock/random cho policy — không chờ thật. */
function fakeClock(startMs = 1_000_000) {
  let now = startMs;
  let randomValue = 0.5;
  return {
    now: () => now,
    random: () => randomValue,
    advance: (ms) => {
      now += ms;
    },
    setRandom: (v) => {
      randomValue = v;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Policy: số liệu Grok
// ---------------------------------------------------------------------------

test('P0-4 reconnect: mặc định đúng số liệu mcp_reconnect_config của Grok', () => {
  const c = DEFAULT_MCP_RECONNECT_CONFIG;
  assert.equal(c.fastRetryBaseDelayMs, 5_000);
  assert.equal(c.fastRetryMaxDelayMs, 60_000);
  assert.equal(c.fastRetryMaxAttempts, 5);
  assert.equal(c.periodicRetryBaseDelayMs, 5 * 60_000);
  assert.equal(c.periodicRetryMaxDelayMs, 30 * 60_000);
  assert.equal(c.maxPeriodicCycles, null);
  assert.equal(c.streamableHttpSession404TombstoneThreshold, 5);
  assert.equal(c.healthProbeTimeoutMs, 10_000);
  assert.equal(c.toolCallBoundedTimeoutEnabled, true);
  assert.equal(c.toolCallIdleTimeoutMs, 120_000);
  assert.equal(c.toolCallMaxTotalTimeoutMs, 60 * 60_000);
  assert.equal(c.degradedProbeDelayMs, 30_000);
  assert.equal(c.maxDegradedProbeFailures, 3);
  assert.equal(c.keepaliveProbeDelayMs, 5 * 60_000);
  assert.equal(c.keepaliveJitterMs, 30_000);
  assert.equal(c.stabilityThresholdMs, 30_000);
  assert.equal(c.stdioConnectFailuresAreNonRetryable, true);
  // Override từng phần giữ các giá trị còn lại.
  const over = resolveMcpReconnectConfig({ fastRetryMaxAttempts: 2 });
  assert.equal(over.fastRetryMaxAttempts, 2);
  assert.equal(over.fastRetryBaseDelayMs, 5_000);
});

test('P0-4 reconnect: fast retry 5s→60s ×5 rồi periodic 5→30 phút (fake clock)', () => {
  const clock = fakeClock();
  const policy = new McpReconnectPolicy(DEFAULT_MCP_RECONNECT_CONFIG, clock);
  // Pha nhanh: 5s, 10s, 20s, 40s, 60s (trần).
  assert.deepEqual(
    [
      policy.nextReconnectDelayMs(),
      policy.nextReconnectDelayMs(),
      policy.nextReconnectDelayMs(),
      policy.nextReconnectDelayMs(),
      policy.nextReconnectDelayMs(),
    ],
    [5_000, 10_000, 20_000, 40_000, 60_000],
  );
  assert.equal(policy.isInPeriodicPhase(), true);
  // Pha định kỳ: 5 phút, 10 phút, 20 phút, 30 phút (trần), rồi giữ 30 phút.
  assert.deepEqual(
    [
      policy.nextReconnectDelayMs(),
      policy.nextReconnectDelayMs(),
      policy.nextReconnectDelayMs(),
      policy.nextReconnectDelayMs(),
      policy.nextReconnectDelayMs(),
    ],
    [300_000, 600_000, 1_200_000, 1_800_000, 1_800_000],
  );
});

test('P0-4 reconnect: maxPeriodicCycles hữu hạn thì trả -1 khi hết chu kỳ', () => {
  const clock = fakeClock();
  const policy = new McpReconnectPolicy(
    resolveMcpReconnectConfig({
      fastRetryMaxAttempts: 1,
      fastRetryBaseDelayMs: 10,
      periodicRetryBaseDelayMs: 20,
      maxPeriodicCycles: 2,
    }),
    clock,
  );
  assert.equal(policy.nextReconnectDelayMs(), 10); // nhanh ×1
  assert.equal(policy.nextReconnectDelayMs(), 20); // định kỳ 1
  assert.equal(policy.nextReconnectDelayMs(), 40); // định kỳ 2
  assert.equal(policy.nextReconnectDelayMs(), -1); // hết
});

test('P0-4 reconnect: session 404 tombstone sau 5 lần, reset khi session sống lại', () => {
  const clock = fakeClock();
  const policy = new McpReconnectPolicy(DEFAULT_MCP_RECONNECT_CONFIG, clock);
  assert.equal(policy.recordSession404(), false);
  assert.equal(policy.recordSession404(), false);
  assert.equal(policy.recordSession404(), false);
  assert.equal(policy.recordSession404(), false);
  assert.equal(policy.isTombstoned(), false);
  assert.equal(policy.recordSession404(), true); // lần 5: tombstone
  assert.equal(policy.isTombstoned(), true);
  policy.recordSessionOk();
  assert.equal(policy.isTombstoned(), false);
  assert.deepEqual(policy.snapshot(), {
    fastAttempts: 0,
    periodicCycles: 0,
    consecutiveSession404: 0,
    degradedProbeFailures: 0,
    degraded: false,
    tombstoned: false,
  });
});

test('P0-4 reconnect: keepalive 5 phút ± jitter 30s (fake random)', () => {
  const clock = fakeClock();
  const policy = new McpReconnectPolicy(DEFAULT_MCP_RECONNECT_CONFIG, clock);
  clock.setRandom(0);
  assert.equal(policy.nextKeepaliveDelayMs(), 270_000); // 5 phút - 30s
  clock.setRandom(1);
  assert.equal(policy.nextKeepaliveDelayMs(), 330_000); // 5 phút + 30s
  clock.setRandom(0.5);
  assert.equal(policy.nextKeepaliveDelayMs(), 300_000);
  // Jitter luôn nằm trong [270s, 330s].
  for (const r of [0.1, 0.25, 0.75, 0.9]) {
    clock.setRandom(r);
    const d = policy.nextKeepaliveDelayMs();
    assert.ok(d >= 270_000 && d <= 330_000, `keepalive ${d} ngoài ±30s`);
  }
});

test('P0-4 reconnect: degraded sau 3 probe fail, reset khi probe thành công', () => {
  const clock = fakeClock();
  const policy = new McpReconnectPolicy(DEFAULT_MCP_RECONNECT_CONFIG, clock);
  assert.equal(policy.recordDegradedProbeFailure(), false);
  assert.equal(policy.recordDegradedProbeFailure(), false);
  assert.equal(policy.isDegraded(), false);
  assert.equal(policy.recordDegradedProbeFailure(), true); // lần 3
  assert.equal(policy.isDegraded(), true);
  policy.recordDegradedProbeSuccess();
  assert.equal(policy.isDegraded(), false);
});

test('P0-4 reconnect: ổn định 30s thì reset bộ đếm retry (fake clock)', () => {
  const clock = fakeClock();
  const policy = new McpReconnectPolicy(DEFAULT_MCP_RECONNECT_CONFIG, clock);
  policy.nextReconnectDelayMs(); // fastAttempts = 1
  policy.nextReconnectDelayMs(); // fastAttempts = 2
  assert.equal(policy.recordStable(), false); // mốc ổn định vừa đặt
  clock.advance(29_000);
  assert.equal(policy.recordStable(), false); // chưa đủ 30s
  assert.equal(policy.snapshot().fastAttempts, 2);
  clock.advance(1_000);
  assert.equal(policy.recordStable(), true); // đủ 30s: recovered
  assert.equal(policy.snapshot().fastAttempts, 0);
  // Đứt lại thì mốc ổn định tính lại từ đầu.
  policy.nextReconnectDelayMs();
  policy.noteInstability();
  assert.equal(policy.recordStable(), false);
});

// ---------------------------------------------------------------------------
// 2. Tool-call timeouts (stdio fake server)
// ---------------------------------------------------------------------------

const SLOW_SERVER_SRC = `
import * as readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  const { id, method, params } = msg;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'slow-fake', version: '0.1.0' } } });
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/call') {
    if (params?.name === 'slow') return; // không bao giờ trả lời
    if (params?.name === 'chatty') {
      const token = params?._meta?.progressToken;
      let n = 0;
      const iv = setInterval(() => {
        n += 1;
        send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: n, total: 6 } });
        if (n >= 6) { clearInterval(iv); send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'done' }], isError: false } }); }
      }, 100);
      return;
    }
    return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool' } });
  }
  return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
});
`;

const tmpDirs = [];
async function writeSlowServer() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'open-bot-p04-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'slow-mcp-server.mjs');
  await fs.promises.writeFile(file, SLOW_SERVER_SRC);
  return file;
}
after(async () => {
  await closeMcpClientPool().catch(() => undefined);
  for (const dir of tmpDirs) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('P0-4 timeout: tool không có tiến độ thì huỷ ở idle (không chờ tổng)', async () => {
  const serverFile = await writeSlowServer();
  const client = await connectMcp({
    name: 'slow',
    command: process.execPath,
    args: [serverFile],
    reconnect: { toolCallIdleTimeoutMs: 200, toolCallMaxTotalTimeoutMs: 60_000 },
  });
  try {
    await assert.rejects(
      () => client.callToolStructured('slow', {}),
      /hết thời gian chờ idle \(200ms không có tiến độ\)/,
    );
  } finally {
    await client.close();
  }
});

test('P0-4 timeout: tiến độ reset idle — tool chatty hoàn thành dù idle ngắn', async () => {
  const serverFile = await writeSlowServer();
  const client = await connectMcp({
    name: 'slow',
    command: process.execPath,
    args: [serverFile],
    reconnect: { toolCallIdleTimeoutMs: 300, toolCallMaxTotalTimeoutMs: 60_000 },
  });
  try {
    // chatty: progress mỗi 100ms, xong ở ~600ms — idle 300ms không kịp
    // kích hoạt vì mỗi progress reset timer.
    const result = await client.callToolStructured('chatty', {});
    assert.equal(result.text, 'done');
  } finally {
    await client.close();
  }
});

test('P0-4 timeout: trần tổng huỷ tool dù vẫn có tiến độ', async () => {
  const serverFile = await writeSlowServer();
  const client = await connectMcp({
    name: 'slow',
    command: process.execPath,
    args: [serverFile],
    // idle dài hơn tổng: trần tổng phải là thứ kích hoạt.
    reconnect: { toolCallIdleTimeoutMs: 60_000, toolCallMaxTotalTimeoutMs: 300 },
  });
  try {
    await assert.rejects(
      () => client.callToolStructured('chatty', {}),
      /hết thời gian chờ tổng \(300ms\)/,
    );
  } finally {
    await client.close();
  }
});

test('P0-4 timeout: caller truyền timeoutMs riêng thì tôn trọng số đó', async () => {
  const serverFile = await writeSlowServer();
  const client = await connectMcp({
    name: 'slow',
    command: process.execPath,
    args: [serverFile],
  });
  try {
    await assert.rejects(
      () => client.callToolStructured('slow', {}, { timeoutMs: 150 }),
      /timed out after 150ms/,
    );
  } finally {
    await client.close();
  }
});

// ---------------------------------------------------------------------------
// 3. stdio lỗi không retry
// ---------------------------------------------------------------------------

test('P0-4 stdio: lỗi spawn đánh dấu nonRetryable (mặc định Grok)', async () => {
  await assert.rejects(
    () =>
      connectMcp({
        name: 'bad-stdio',
        command: '/nonexistent/definitely-not-a-command-p04',
      }),
    (err) => {
      assert.match(err.message, /failed to start/i);
      assert.equal(err.nonRetryable, true);
      return true;
    },
  );
});

test('P0-4 stdio: override stdioConnectFailuresAreNonRetryable=false thì không đánh dấu', async () => {
  await assert.rejects(
    () =>
      connectMcp({
        name: 'bad-stdio',
        command: '/nonexistent/definitely-not-a-command-p04',
        reconnect: { stdioConnectFailuresAreNonRetryable: false },
      }),
    (err) => {
      assert.equal(err.nonRetryable, false);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 4. Transport: policy điều khiển reconnect + tombstone (fake fetch)
// ---------------------------------------------------------------------------

function fakeFetch404() {
  let gets = 0;
  const fetchFn = async (url, init) => {
    if (init?.method === 'GET') {
      gets += 1;
      return new Response(null, { status: 404 });
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetchFn, getGets: () => gets };
}

test('P0-4 transport: 404 đủ ngưỡng tombstone thì dừng (policy), chưa đủ thì nối lại', async () => {
  const { fetchFn, getGets } = fakeFetch404();
  const clock = fakeClock();
  const policy = new McpReconnectPolicy(
    resolveMcpReconnectConfig({
      fastRetryBaseDelayMs: 10,
      fastRetryMaxDelayMs: 10,
      streamableHttpSession404TombstoneThreshold: 3,
    }),
    clock,
  );
  const transport = new StreamableHttpTransport({
    url: 'http://127.0.0.1:9/mcp',
    reconnectPolicy: policy,
    fetchFn,
  });
  await transport.openStream();
  // Mỗi GET 404 → nối lại; đủ 3 lần thì tombstone + dừng.
  await sleep(500);
  assert.equal(getGets(), 3);
  assert.equal(transport.getSessionId(), null);
  assert.equal(policy.isTombstoned(), true);
  await transport.close();
});

test('P0-4 transport: không policy thì giữ hành vi cũ (404 đầu tiên dừng)', async () => {
  const { fetchFn, getGets } = fakeFetch404();
  const transport = new StreamableHttpTransport({
    url: 'http://127.0.0.1:9/mcp',
    maxReconnectAttempts: 5,
    reconnectDelayMs: 10,
    fetchFn,
  });
  await transport.openStream();
  await sleep(300);
  assert.equal(getGets(), 1);
  await transport.close();
});

// ---------------------------------------------------------------------------
// 5. HTTP client: keepalive + degraded probe (fake HTTP MCP server)
// ---------------------------------------------------------------------------

/**
 * Fake HTTP MCP server local: đếm số lần `ping` được gọi; GET trả 405
 * (không hỗ trợ stream); POST khác trả JSON-RPC rỗng. `failPing` bật
 * thì mọi ping trả HTTP 500.
 */
function startFakeHttpMcp({ failPing = false } = {}) {
  let pingCount = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      let msg = {};
      try {
        msg = JSON.parse(body);
      } catch {
        // ignore
      }
      if (msg.method === 'ping') {
        pingCount += 1;
        if (failPing) {
          res.writeHead(500);
          res.end();
          return;
        }
      }
      const out =
        msg.method === 'initialize'
          ? {
              protocolVersion: '2025-11-25',
              capabilities: {},
              serverInfo: { name: 'fake-http', version: '0.1.0' },
            }
          : {};
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Mcp-Session-Id': 'sess-p04',
      });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? 1, result: out }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        getPingCount: () => pingCount,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('P0-4 keepalive: ping định kỳ sau initialize (config thu nhỏ)', async () => {
  const fake = await startFakeHttpMcp();
  try {
    const client = await connectMcp({
      name: 'fake-http',
      url: fake.url,
      reconnect: {
        keepaliveProbeDelayMs: 100,
        keepaliveJitterMs: 0,
        healthProbeTimeoutMs: 5_000,
        stabilityThresholdMs: 100,
      },
    });
    try {
      await sleep(450);
      assert.ok(fake.getPingCount() >= 2, `ping ${fake.getPingCount()} lần, cần >= 2`);
      assert.equal(client.getReconnectState().degraded, false);
    } finally {
      await client.close();
    }
  } finally {
    await fake.close();
  }
});

test('P0-4 degraded: ping fail 3 lần liên tiếp thì đánh dấu degraded', async () => {
  const fake = await startFakeHttpMcp({ failPing: true });
  try {
    const client = await connectMcp({
      name: 'fake-http',
      url: fake.url,
      reconnect: {
        keepaliveProbeDelayMs: 80,
        keepaliveJitterMs: 0,
        healthProbeTimeoutMs: 5_000,
        degradedProbeDelayMs: 80,
        maxDegradedProbeFailures: 3,
      },
    });
    try {
      await sleep(900);
      assert.ok(fake.getPingCount() >= 3, `ping ${fake.getPingCount()} lần, cần >= 3`);
      assert.equal(client.getReconnectState().degraded, true);
    } finally {
      await client.close();
    }
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------------------
// 6. Auth-tool UX
// ---------------------------------------------------------------------------

function memoryOAuthStore() {
  const map = new Map();
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => {
      map.set(k, v);
    },
    delete: async (k) => {
      map.delete(k);
    },
  };
}

async function writeWorkspaceMcpJson(servers) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'open-bot-p04-ws-'));
  tmpDirs.push(dir);
  await fs.promises.mkdir(path.join(dir, '.open-bot'), { recursive: true });
  await fs.promises.writeFile(
    path.join(dir, '.open-bot', 'mcp.json'),
    JSON.stringify({ servers }),
  );
  return dir;
}

const fakeCtx = (workspaceDir) => ({
  workspaceDir,
  botId: 'test-bot',
});

test('P0-4 auth tool: tên + mô tả theo mẫu Grok, sinh riêng cho từng HTTP server', async () => {
  assert.equal(getMcpAuthToolName('my-server'), 'mcp_authenticate_my_server');
  assert.equal(getMcpAuthToolName('a.b/c'), 'mcp_authenticate_a_b_c');
  const tool = buildMcpServerAuthTool('my-server', {});
  assert.equal(tool.definition.name, 'mcp_authenticate_my_server');
  assert.match(tool.definition.description, /Authenticate the MCP server "my-server" so its tools can be used/);
  assert.match(tool.definition.description, /needs authentication/);
  assert.equal(tool.needsApproval, true);
  assert.deepEqual(tool.definition.parameters.required, []);
});

test('P0-4 auth tool: createMcpTools sinh tool cho HTTP server khi có OAuth wiring', async () => {
  const ws = await writeWorkspaceMcpJson({
    'my-server': { name: 'my-server', url: 'http://127.0.0.1:9/mcp' },
    local: { name: 'local', command: 'node', args: ['x.mjs'] },
  });
  const tools = createMcpTools(ws, {
    oauthStore: memoryOAuthStore(),
    getOAuthConfig: async () => ({
      authorizationEndpoint: 'http://127.0.0.1:9/auth',
      tokenEndpoint: 'http://127.0.0.1:9/token',
      clientId: 'cid',
    }),
  });
  const names = tools.map((t) => t.definition.name);
  assert.ok(names.includes('mcp_authenticate_my_server'), `thiếu auth tool: ${names.join(', ')}`);
  assert.ok(!names.includes('mcp_authenticate_local'), 'stdio server không cần auth tool');
  // Không wiring thì không sinh tool nào.
  const noWiring = createMcpTools(ws, {});
  assert.ok(!noWiring.map((t) => t.definition.name).some((n) => n.startsWith('mcp_authenticate_')));
});

test('P0-4 auth tool: gọi tool khi server không có OAuth config thì lỗi rõ (không crash)', async () => {
  const ws = await writeWorkspaceMcpJson({
    'my-server': { name: 'my-server', url: 'http://127.0.0.1:9/mcp' },
  });
  const tools = createMcpTools(ws, {
    oauthStore: memoryOAuthStore(),
    getOAuthConfig: async () => null,
  });
  const tool = tools.find((t) => t.definition.name === 'mcp_authenticate_my_server');
  assert.ok(tool);
  const out = await tool.execute({}, fakeCtx(ws));
  assert.match(out, /No OAuth config for MCP server "my-server"/);
});

test('P0-4 auth tool: lỗi 401 ở mcp_list_tools kèm gợi ý gọi tool auth (thay vì chỉ báo lỗi)', async () => {
  // Fake HTTP MCP server: mọi POST trả 401.
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="x"' });
    res.end('unauthorized');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const ws = await writeWorkspaceMcpJson({
    'needs-auth': { name: 'needs-auth', url: `http://127.0.0.1:${port}/mcp` },
  });
  try {
    const tools = createMcpTools(ws, {
      oauthStore: memoryOAuthStore(),
      getOAuthConfig: async () => ({
        authorizationEndpoint: 'http://127.0.0.1:9/auth',
        tokenEndpoint: 'http://127.0.0.1:9/token',
        clientId: 'cid',
      }),
    });
    const listTools = tools.find((t) => t.definition.name === 'mcp_list_tools');
    const out = await listTools.execute({ server: 'needs-auth' }, fakeCtx(ws));
    assert.match(out, /401/);
    assert.match(out, /mcp_authenticate_needs_auth/);
    assert.match(out, /needs authentication/);
    // Helper nhận diện lỗi auth.
    assert.equal(isMcpAuthFailureMessage('HTTP 401 rejected'), true);
    assert.equal(isMcpAuthFailureMessage('Unknown tool: echo'), false);
  } finally {
    await closeMcpClientPool();
    await new Promise((r) => server.close(r));
  }
});

test('P0-4 auth tool: bản unbound MCP_TOOLS không sinh tool auth (không biết workspace)', () => {
  assert.equal(
    MCP_TOOLS.filter((t) => t.definition.name.startsWith('mcp_authenticate_')).length,
    0,
  );
});

// ---------------------------------------------------------------------------
// 7. Tasks sau abstraction: đổi backend 2025-11-25 ↔ 2026-07-28 không vỡ code gọi
// ---------------------------------------------------------------------------

/** Fake transport tasks 2025-11-25: tasks/get → trạng thái, tasks/result → kết quả. */
function fakeTasks2025Transport() {
  const methods = [];
  let polls = 0;
  return {
    methods,
    request: async (method, params) => {
      methods.push(method);
      if (method === 'tools/call') {
        return { taskId: 't-1', status: 'working', pollInterval: 10 };
      }
      if (method === 'tasks/get') {
        polls += 1;
        if (polls === 1) return { taskId: 't-1', status: 'working', pollInterval: 10 };
        return { taskId: 't-1', status: 'completed' };
      }
      if (method === 'tasks/result') return { content: [{ type: 'text', text: 'ket-qua-2025' }] };
      throw new Error(`method lạ: ${method}`);
    },
  };
}

/** Fake transport tasks extension 2026-07-28: tasks/get trả luôn kết quả, không có tasks/result/list. */
function fakeTasks2026Transport({ inputRequired = false } = {}) {
  const methods = [];
  let polls = 0;
  let inputSent = null;
  return {
    methods,
    getInputSent: () => inputSent,
    request: async (method, params) => {
      methods.push(method);
      if (method === 'tools/call') {
        return { taskId: 't-2', status: 'working', pollInterval: 10 };
      }
      if (method === 'tasks/get') {
        polls += 1;
        if (inputRequired && polls === 1) {
          return { taskId: 't-2', status: 'input_required' };
        }
        if (polls === 1) return { taskId: 't-2', status: 'working', pollInterval: 10 };
        return { taskId: 't-2', status: 'completed', result: { text: 'ket-qua-2026' } };
      }
      if (method === 'tasks/update') {
        inputSent = params?.input;
        return { taskId: 't-2', status: 'working', pollInterval: 10 };
      }
      if (method === 'tasks/result' || method === 'tasks/list') {
        throw new Error(`extension 2026-07-28 đã bỏ ${method}`);
      }
      throw new Error(`method lạ: ${method}`);
    },
  };
}

/** Cùng một đoạn code gọi cho cả hai backend — chỉ khác specVersion. */
async function driveTaskToCompletion(transport, specVersion) {
  const handle = await createTask(
    transport,
    'tools/call',
    { name: 'slow_tool', arguments: {} },
    { pollIntervalMs: 10, specVersion },
  );
  const { result } = await handle.waitForCompletion({ timeoutMs: 5_000, maxPollIntervalMs: 50 });
  return result;
}

test('P0-4 tasks: cùng code gọi chạy được cả hai backend, kết quả tương đương', async () => {
  const t2025 = fakeTasks2025Transport();
  const r2025 = await driveTaskToCompletion(t2025, '2025-11-25');
  assert.deepEqual(r2025, { content: [{ type: 'text', text: 'ket-qua-2025' }] });
  assert.ok(t2025.methods.includes('tasks/result'));

  const t2026 = fakeTasks2026Transport();
  const r2026 = await driveTaskToCompletion(t2026, '2026-07-28');
  assert.deepEqual(r2026, { text: 'ket-qua-2026' });
  // Backend 2026 không bao giờ gọi tasks/result — đổi spec không vỡ code gọi.
  assert.ok(!t2026.methods.includes('tasks/result'));
  assert.ok(t2026.methods.includes('tasks/get'));
});

test('P0-4 tasks: runTaskToCompletion dùng được cả hai backend', async () => {
  const r2026 = await runTaskToCompletion(
    fakeTasks2026Transport(),
    'tools/call',
    { name: 'slow_tool', arguments: {} },
    { pollIntervalMs: 10, specVersion: '2026-07-28', timeoutMs: 5_000, maxPollIntervalMs: 50 },
  );
  assert.deepEqual(r2026, { text: 'ket-qua-2026' });
});

test('P0-4 tasks: 2026-07-28 gửi input qua tasks/update khi input_required', async () => {
  const transport = fakeTasks2026Transport({ inputRequired: true });
  const handle = await createTask(
    transport,
    'tools/call',
    { name: 'slow_tool', arguments: {} },
    { pollIntervalMs: 10, specVersion: '2026-07-28' },
  );
  // Lần poll đầu: input_required → waitForCompletion báo rõ + hướng dẫn sendInput.
  await assert.rejects(() => handle.waitForCompletion({ timeoutMs: 5_000, maxPollIntervalMs: 50 }), /sendInput/);
  const after = await handle.sendInput({ answer: 'yes' });
  assert.equal(after.status, 'working');
  assert.equal(transport.getInputSent()?.answer, 'yes');
  assert.ok(transport.methods.includes('tasks/update'));
  // Poll tiếp → completed, kết quả từ tasks/get.
  const { result } = await handle.waitForCompletion({ timeoutMs: 5_000, maxPollIntervalMs: 50 });
  assert.deepEqual(result, { text: 'ket-qua-2026' });
});

test('P0-4 tasks: 2025-11-25 không có tasks/update; 2026-07-28 bỏ tasks/result + tasks/list', async () => {
  const h2025 = await createTask(fakeTasks2025Transport(), 'tools/call', {}, { pollIntervalMs: 10 });
  await assert.rejects(() => h2025.sendInput({}), /2025-11-25 chưa hỗ trợ gửi input/);
  await assert.rejects(
    () => listTasks(fakeTasks2026Transport(), '2026-07-28'),
    /đã bỏ "tasks\/list"/,
  );
  const h2026 = await createTask(fakeTasks2026Transport(), 'tools/call', {}, {
    pollIntervalMs: 10,
    specVersion: '2026-07-28',
  });
  await assert.rejects(() => h2026.getResult(), /đã bỏ "tasks\/result"/);
});

test('P0-4 tasks: detectTaskHandle nhận handle server trả không cần opt-in (2026-07-28)', () => {
  assert.deepEqual(
    detectTaskHandle({ taskId: 't-9', status: 'working', pollInterval: 500 }),
    { taskId: 't-9', status: 'working', pollInterval: 500 },
  );
  assert.equal(detectTaskHandle({ content: [{ type: 'text', text: 'xong' }] }), null);
  assert.equal(detectTaskHandle('not-a-task'), null);
});

// ---------------------------------------------------------------------------
// 8. Elicitation: cơ chế URL-mode tracker hoạt động (ghi chú: chưa nối live)
// ---------------------------------------------------------------------------

test('P0-4 elicitation: ElicitationUrlTracker chờ + nhận complete (cơ chế có sẵn)', async () => {
  const tracker = new ElicitationUrlTracker();
  assert.equal(tracker.pendingCount, 0);
  const waiting = tracker.waitForCompletion('elic-1', { timeoutMs: 5_000 });
  assert.equal(tracker.pendingCount, 1);
  assert.equal(tracker.complete('elic-khac'), false);
  assert.equal(tracker.complete('elic-1'), true);
  await waiting;
  assert.equal(tracker.pendingCount, 0);
});

test('P0-4 elicitation: tracker timeout + cancelAll reject lượt chờ', async () => {
  const tracker = new ElicitationUrlTracker();
  await assert.rejects(
    () => tracker.waitForCompletion('elic-timeout', { timeoutMs: 50 }),
    /hết thời gian chờ hoàn tất/,
  );
  const waiting = tracker.waitForCompletion('elic-2', { timeoutMs: 5_000 });
  tracker.cancelAll('đóng app');
  await assert.rejects(() => waiting, /đóng app/);
});
