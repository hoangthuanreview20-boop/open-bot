/**
 * Tests for the v0.19 Local API MCP mount tool selection
 * (packages/core/src/api/server.ts: `mcpTools` / `allowWriteTools`).
 *
 * The mount used to expose exactly the 5 read-only default tools of
 * `createMcpServer()` and nothing else. The host can now configure
 * which tools the mount exposes — without mutating the mounted MCP
 * server itself (its own allowlist / other transports keep working).
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/api-mcp-mount-v019.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createApiServer } from '../packages/core/dist/api/server.js';
import { createMcpServer } from '../packages/core/dist/mcp/server.js';

const TOKEN = 'test-token-mcp-mount-v019';

/** The 5 read-only default tools of createMcpServer(). */
const DEFAULT_TOOLS = [
  'bot_info',
  'time_now',
  'echo',
  'workspace_list_files',
  'workspace_read_file',
];

function mockHandlers() {
  return {
    listBots: async () => [],
    runBot: async () => ({ text: '' }),
    getHistory: async () => [],
    listTasks: async () => [],
  };
}

const servers = [];
async function startApi(options) {
  const server = createApiServer({
    port: 0,
    token: TOKEN,
    handlers: mockHandlers(),
    ...options,
  });
  await server.start();
  servers.push(server);
  return server;
}
afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop().stop();
  }
});

/** Write tools registered on the mounted MCP server (as a host would bridge agent tools). */
function writeToolDefs() {
  return [
    {
      name: 'shell_exec',
      description: 'Chạy một lệnh shell (tool ghi, chỉ dùng cho test).',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      handler: async () => 'shell ran',
    },
    {
      name: 'write_file',
      description: 'Ghi một file (tool ghi, chỉ dùng cho test).',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      handler: async () => 'wrote file',
    },
  ];
}

/** A write tool with an innocuous name: only its MCP annotations say it writes. */
function annotationOnlyWriteToolDef() {
  return {
    name: 'deploy_prod',
    description: 'Deploy lên production (tool ghi chỉ lộ qua annotation, chỉ dùng cho test).',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: async () => 'deployed',
  };
}

function mcpWithWriteTools(extraTools = []) {
  return createMcpServer({ tools: [...writeToolDefs(), ...extraTools] });
}

async function mcpRpc(server, body) {
  const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, `POST /mcp -> ${res.status}`);
  return res.json();
}

async function mcpInitialize(server) {
  const init = await mcpRpc(server, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  });
  assert.equal(init.result.protocolVersion, '2025-11-25');
}

async function mcpListToolNames(server) {
  const list = await mcpRpc(server, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.equal(list.error, undefined, JSON.stringify(list));
  return list.result.tools.map((t) => t.name);
}

async function mcpCallTool(server, name, args = {}) {
  return mcpRpc(server, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

// ---------------------------------------------------------------------------
// Default mount: still exactly the 5 read-only tools
// ---------------------------------------------------------------------------

test('mount mặc định vẫn expose đúng 5 tool read-only', async () => {
  const server = await startApi({ mcpServer: createMcpServer({}) });
  await mcpInitialize(server);
  assert.deepEqual([...(await mcpListToolNames(server))].sort(), [...DEFAULT_TOOLS].sort());
});

test('mount mặc định không expose tool ghi đã đăng ký thêm, và tools/call tool ghi bị chặn (-32602)', async () => {
  const server = await startApi({ mcpServer: mcpWithWriteTools() });
  await mcpInitialize(server);
  // Call TRƯỚC khi list: gate theo tên phải chặn ngay, không cần annotation cache.
  const blocked = await mcpCallTool(server, 'shell_exec', { command: 'echo hi' });
  assert.equal(blocked.error.code, -32602);
  assert.match(blocked.error.message, /shell_exec/);
  assert.match(blocked.error.message, /allowWriteTools/);
  // List cũng không lộ tool ghi.
  assert.deepEqual([...(await mcpListToolNames(server))].sort(), [...DEFAULT_TOOLS].sort());
  // Tool ghi còn lại cũng bị chặn.
  const blockedWrite = await mcpCallTool(server, 'write_file', { path: 'x.txt' });
  assert.equal(blockedWrite.error.code, -32602);
});

test("mcpTools 'all-read-only' tường minh = mount mặc định (5 tool, không tool ghi)", async () => {
  const server = await startApi({ mcpServer: mcpWithWriteTools(), mcpTools: 'all-read-only' });
  await mcpInitialize(server);
  assert.deepEqual([...(await mcpListToolNames(server))].sort(), [...DEFAULT_TOOLS].sort());
});

// ---------------------------------------------------------------------------
// Explicit list: exactly those tools
// ---------------------------------------------------------------------------

test('mount với danh sách cụ thể chỉ expose đúng tool đó; tool ngoài danh sách bị chặn cả list lẫn call', async () => {
  const server = await startApi({ mcpServer: createMcpServer({}), mcpTools: ['echo'] });
  await mcpInitialize(server);
  assert.deepEqual(await mcpListToolNames(server), ['echo']);

  // Tool trong danh sách vẫn gọi được.
  const ok = await mcpCallTool(server, 'echo', { message: 'ping' });
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  assert.equal(ok.result.isError, false);
  assert.ok(JSON.stringify(ok.result.content).includes('ping'));

  // Tool read-only nhưng ngoài danh sách: không list, gọi bị chặn -32602.
  const blocked = await mcpCallTool(server, 'workspace_read_file', { path: 'x.txt' });
  assert.equal(blocked.error.code, -32602);
  assert.match(blocked.error.message, /workspace_read_file/);
});

test('tool không tồn tại trong danh sách → lỗi cấu hình rõ lúc mount (createApiServer throw)', () => {
  assert.throws(
    () =>
      createApiServer({
        port: 0,
        token: TOKEN,
        handlers: mockHandlers(),
        mcpServer: createMcpServer({}),
        mcpTools: ['echo', 'khong_co_tool_nay'],
      }),
    /không tồn tại.*khong_co_tool_nay/,
  );
  assert.throws(
    () =>
      createApiServer({
        port: 0,
        token: TOKEN,
        handlers: mockHandlers(),
        mcpServer: createMcpServer({}),
        mcpTools: ['khong_co_tool_nay'],
      }),
    /khong_co_tool_nay/,
  );
});

test('mcpTools đặt mà không mount MCP server → lỗi cấu hình rõ lúc mount', () => {
  assert.throws(
    () =>
      createApiServer({
        port: 0,
        token: TOKEN,
        handlers: mockHandlers(),
        mcpTools: ['echo'],
      }),
    /mcpTools.*mcpServer|không mount MCP server/,
  );
});

// ---------------------------------------------------------------------------
// Write tools: blocked without allowWriteTools, exposed with it
// ---------------------------------------------------------------------------

test('xin tool ghi trong danh sách mà không có allowWriteTools → bị chặn lúc mount', () => {
  assert.throws(
    () =>
      createApiServer({
        port: 0,
        token: TOKEN,
        handlers: mockHandlers(),
        mcpServer: mcpWithWriteTools(),
        mcpTools: ['shell_exec'],
      }),
    /shell_exec.*allowWriteTools|allowWriteTools/,
  );
  assert.throws(
    () =>
      createApiServer({
        port: 0,
        token: TOKEN,
        handlers: mockHandlers(),
        mcpServer: mcpWithWriteTools(),
        mcpTools: ['echo', 'write_file'],
      }),
    /write_file/,
  );
});

test("mcpTools 'all' không có allowWriteTools → bị chặn lúc mount", () => {
  assert.throws(
    () =>
      createApiServer({
        port: 0,
        token: TOKEN,
        handlers: mockHandlers(),
        mcpServer: mcpWithWriteTools(),
        mcpTools: 'all',
      }),
    /"all".*allowWriteTools/,
  );
});

test('có allowWriteTools: true → tool ghi được expose (list + call) trong danh sách cụ thể', async () => {
  const server = await startApi({
    mcpServer: mcpWithWriteTools(),
    mcpTools: ['shell_exec', 'write_file'],
    allowWriteTools: true,
  });
  await mcpInitialize(server);
  assert.deepEqual([...(await mcpListToolNames(server))].sort(), ['shell_exec', 'write_file']);

  const ran = await mcpCallTool(server, 'shell_exec', { command: 'echo hi' });
  assert.equal(ran.error, undefined, JSON.stringify(ran));
  assert.equal(ran.result.isError, false);
  assert.ok(JSON.stringify(ran.result.content).includes('shell ran'));

  const wrote = await mcpCallTool(server, 'write_file', { path: 'x.txt' });
  assert.equal(wrote.error, undefined, JSON.stringify(wrote));
  assert.ok(JSON.stringify(wrote.result.content).includes('wrote file'));
});

test("mcpTools 'all' + allowWriteTools: true → expose tất cả tool (5 mặc định + tool ghi)", async () => {
  const server = await startApi({
    mcpServer: mcpWithWriteTools(),
    mcpTools: 'all',
    allowWriteTools: true,
  });
  await mcpInitialize(server);
  assert.deepEqual(
    [...(await mcpListToolNames(server))].sort(),
    [...DEFAULT_TOOLS, 'shell_exec', 'write_file'].sort(),
  );
});

// ---------------------------------------------------------------------------
// Annotation-only write tool: hidden by tools/list filtering + call blocking
// ---------------------------------------------------------------------------

test('tool ghi chỉ lộ qua annotation (tên lạ, không nằm trong danh mục tên) vẫn bị ẩn khỏi list và bị chặn khi gọi', async () => {
  const server = await startApi({
    mcpServer: mcpWithWriteTools([annotationOnlyWriteToolDef()]),
  });
  await mcpInitialize(server);
  // tools/list lọc theo annotation: deploy_prod không lộ.
  assert.deepEqual([...(await mcpListToolNames(server))].sort(), [...DEFAULT_TOOLS].sort());
  // Sau khi đã list (annotation đã quan sát được), tools/call bị chặn.
  const blocked = await mcpCallTool(server, 'deploy_prod');
  assert.equal(blocked.error.code, -32602);
  assert.match(blocked.error.message, /deploy_prod/);
});

test('tool ghi chỉ lộ qua annotation: allowWriteTools: true + danh sách cụ thể → được expose', async () => {
  const server = await startApi({
    mcpServer: mcpWithWriteTools([annotationOnlyWriteToolDef()]),
    mcpTools: ['deploy_prod'],
    allowWriteTools: true,
  });
  await mcpInitialize(server);
  assert.deepEqual(await mcpListToolNames(server), ['deploy_prod']);
  const ran = await mcpCallTool(server, 'deploy_prod');
  assert.equal(ran.error, undefined, JSON.stringify(ran));
  assert.ok(JSON.stringify(ran.result.content).includes('deployed'));
});

// ---------------------------------------------------------------------------
// W13e: annotation-before-list — defs đọc được đồng bộ lúc mount
// ---------------------------------------------------------------------------

/** Tool tên lạ, KHÔNG có annotation nào: gate chỉ còn theo tên. */
function strangeNoAnnotationToolDef() {
  return {
    name: 'frobnicate',
    description: 'Tool tên lạ, không gắn annotation (chỉ dùng cho test).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => 'frobbed',
  };
}

test('listToolDefinitions() trả chỉ tên + annotations (không schema/handler), đúng annotation ghi', () => {
  const server = createMcpServer({ tools: [annotationOnlyWriteToolDef()] });
  const defs = server.listToolDefinitions();
  assert.equal(defs.length, DEFAULT_TOOLS.length + 1);
  for (const def of defs) {
    assert.deepEqual(
      Object.keys(def).sort(),
      def.annotations ? ['annotations', 'name'] : ['name'],
    );
    assert.equal('inputSchema' in def, false);
    assert.equal('handler' in def, false);
  }
  const deploy = defs.find((d) => d.name === 'deploy_prod');
  assert.equal(deploy.annotations.destructiveHint, true);
  assert.equal(deploy.annotations.readOnlyHint, false);
  const echo = defs.find((d) => d.name === 'echo');
  assert.equal(echo.annotations.readOnlyHint, true);
  assert.equal(echo.annotations.destructiveHint, false);
  // listToolNames vẫn khớp defs (cùng tập tool, cùng allowlist).
  assert.deepEqual(
    [...server.listToolNames()].sort(),
    defs.map((d) => d.name).sort(),
  );
});

test('W13e: tool ghi tên lạ có destructiveHint: true → mount mặc định không expose, và tools/call TRƯỚC khi list vẫn bị chặn (-32602)', async () => {
  const server = await startApi({
    mcpServer: createMcpServer({ tools: [annotationOnlyWriteToolDef()] }),
  });
  await mcpInitialize(server);
  // Case trước đây lọt: gọi TRƯỚC khi list — lúc mount chưa thấy
  // annotation qua tools/list, chỉ có defs đọc đồng bộ lúc mount.
  const blocked = await mcpCallTool(server, 'deploy_prod');
  assert.equal(blocked.error.code, -32602);
  assert.match(blocked.error.message, /deploy_prod/);
  assert.match(blocked.error.message, /allowWriteTools/);
  // Handler không được chạy (không có result 'deployed').
  assert.equal(blocked.result, undefined);
  // List sau đó cũng không lộ tool ghi.
  assert.deepEqual([...(await mcpListToolNames(server))].sort(), [...DEFAULT_TOOLS].sort());
});

test('W13e: xin tool ghi tên lạ (chỉ lộ qua annotation) trong danh sách mà không có allowWriteTools → bị chặn ngay lúc mount', () => {
  assert.throws(
    () =>
      createApiServer({
        port: 0,
        token: TOKEN,
        handlers: mockHandlers(),
        mcpServer: mcpWithWriteTools([annotationOnlyWriteToolDef()]),
        mcpTools: ['deploy_prod'],
      }),
    /deploy_prod.*allowWriteTools|allowWriteTools/,
  );
});

// ---------------------------------------------------------------------------
// W14d: tool ghi đăng ký SAU lúc mount — defs phải đọc lại mỗi lần gọi
// ---------------------------------------------------------------------------

/** Tool ghi đăng ký muộn: tên lạ, chỉ lộ qua annotation ghi. */
function lateDeployToolDef(onRun) {
  return {
    name: 'deploy_late',
    description: 'Deploy lên production, đăng ký SAU lúc mount (chỉ dùng cho test).',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: async () => {
      onRun();
      return 'deployed late';
    },
  };
}

test('W14d: tool ghi đăng ký SAU lúc mount → tools/call TRƯỚC bất kỳ tools/list nào vẫn bị chặn (-32602), handler không chạy; tools/list sau đó cũng không lộ tool đó', async () => {
  const mcpServer = createMcpServer({});
  const server = await startApi({ mcpServer });
  await mcpInitialize(server);
  // Đăng ký SAU lúc mount, TRƯỚC bất kỳ tools/list nào của client.
  // Gap W13e để lại: defs lúc mount không có tool này, nên trước
  // W14d nó chỉ bị chặn sau khi client đã tools/list một lần.
  // W14d: mount đọc lại listToolDefinitions() mỗi lần xử lý
  // tools/list / tools/call nên annotation ghi mới vẫn bị chặn ngay.
  let deployLateRan = false;
  mcpServer.registerTool(lateDeployToolDef(() => {
    deployLateRan = true;
  }));
  // Gọi TRƯỚC khi list: phải bị chặn ngay bằng gate annotation
  // (thông báo allowWriteTools), không phải chỉ bằng snapshot
  // allowedNames lúc mount, và handler không được chạy.
  const blocked = await mcpCallTool(server, 'deploy_late');
  assert.equal(blocked.error.code, -32602);
  assert.match(blocked.error.message, /deploy_late/);
  assert.match(blocked.error.message, /allowWriteTools/);
  assert.equal(blocked.result, undefined);
  assert.equal(deployLateRan, false);
  // tools/list sau đó cũng không lộ tool ghi đăng ký muộn này.
  assert.deepEqual([...(await mcpListToolNames(server))].sort(), [...DEFAULT_TOOLS].sort());
  assert.equal(deployLateRan, false);
});

test('W13e: tool tên lạ KHÔNG annotation → vẫn theo gate tên như cũ (được expose, gọi trước list vẫn chạy)', async () => {
  const server = await startApi({
    mcpServer: createMcpServer({ tools: [strangeNoAnnotationToolDef()] }),
  });
  await mcpInitialize(server);
  // Không annotation ghi, tên không nằm trong danh mục tên ghi:
  // mount mặc định coi là read-only — gọi TRƯỚC khi list vẫn chạy.
  const ok = await mcpCallTool(server, 'frobnicate');
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  assert.equal(ok.result.isError, false);
  assert.ok(JSON.stringify(ok.result.content).includes('frobbed'));
  // List cũng lộ tool này (giới hạn đã biết: tool ghi không gắn
  // annotation thì mount không nhận diện được — xem server.ts).
  assert.deepEqual(
    [...(await mcpListToolNames(server))].sort(),
    [...DEFAULT_TOOLS, 'frobnicate'].sort(),
  );
});

// ---------------------------------------------------------------------------
// W17c: allowedNames tự làm mới theo defs hiện tại (gap v0.22 để lại:
// refresh W14d chỉ làm mới tập annotation-write, tool read-only
// đăng ký sau lúc mount không expose tới khi mount lại)
// ---------------------------------------------------------------------------

/**
 * W17c: fake mount tối thiểu (đủ `MountedMcpServer`) mà defs có thể
 * đổi giữa chừng — `createMcpServer` thật không có cách gỡ tool
 * (không có unregister) nên không dựng được case "tool bị gỡ" bằng
 * server thật. Fake này tách riêng 2 thứ:
 * - `defs`: nguồn cho `listToolNames()` / `listToolDefinitions()`
 *   (cũng là nguồn cho `tools/list` trả về);
 * - `handlers`: map tên -> handler cho `tools/call`, KHÔNG đổi khi
 *   tool bị gỡ khỏi defs — để chứng minh chính mount
 *   (`currentAllowedNames`) chặn `tools/call` của tool đã gỡ, chứ
 *   không phải server dưới (nếu mount không cắt allowedNames thì
 *   call sẽ chạy handler và trả kết quả về).
 * `setThrowOnDefs(true)` làm `listToolDefinitions()` throw để mô
 * phỏng lỗi đọc defs.
 */
function fakeMcpMount(initialTools = []) {
  const defs = new Map(); // name -> def (name/description/inputSchema/annotations)
  const handlers = new Map(); // name -> handler
  let throwOnDefs = false;
  for (const t of initialTools) {
    defs.set(t.name, t);
    handlers.set(t.name, t.handler);
  }
  const mount = {
    listToolNames() {
      return [...defs.keys()];
    },
    listToolDefinitions() {
      if (throwOnDefs) throw new Error('fake defs boom (chỉ dùng cho test)');
      return [...defs.values()].map((t) =>
        t.annotations ? { name: t.name, annotations: { ...t.annotations } } : { name: t.name },
      );
    },
    async handleJsonRpc(msg) {
      if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return null;
      if (msg.method === 'initialize') {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'fake', version: '1' },
          },
        };
      }
      if (msg.method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [...defs.values()].map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
              ...(t.annotations ? { annotations: t.annotations } : {}),
            })),
          },
        };
      }
      if (msg.method === 'tools/call') {
        const name = msg.params?.name;
        const handler = handlers.get(name);
        if (!handler) {
          return {
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32602, message: `Không có tool tên "${name}".` },
          };
        }
        const text = await handler(msg.params?.arguments ?? {});
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text }], isError: false },
        };
      }
      return { jsonrpc: '2.0', id: msg.id, result: {} };
    },
    // Test-only: đổi defs giữa chừng.
    registerFakeTool(tool) {
      defs.set(tool.name, tool);
      handlers.set(tool.name, tool.handler);
    },
    unregisterFakeTool(name) {
      defs.delete(name); // CỐ TÌNH giữ handler: server dưới vẫn chạy được nếu mount không chặn.
    },
    setThrowOnDefs(value) {
      throwOnDefs = value;
    },
  };
  return mount;
}

function fakeReadOnlyToolDef(name, onRun) {
  return {
    name,
    description: `Tool read-only giả ${name} (chỉ dùng cho test).`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async () => {
      onRun?.();
      return `ran ${name}`;
    },
  };
}

/** Tool read-only đăng ký muộn trên server thật (dùng cho test W17c). */
function lateReadOnlyToolDef(name, onRun) {
  return {
    name,
    description: `Tool read-only đăng ký sau lúc mount (chỉ dùng cho test).`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async () => {
      onRun?.();
      return `ran ${name}`;
    },
  };
}

/** Tool ghi đăng ký muộn trên server thật: tên lạ, chỉ lộ qua annotation ghi. */
function lateWriteToolDef(name, onRun) {
  return {
    name,
    description: `Tool ghi đăng ký sau lúc mount (chỉ dùng cho test).`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: async () => {
      onRun?.();
      return `ran ${name}`;
    },
  };
}

test('W17c: tool read-only đăng ký SAU lúc mount → tools/call TRƯỚC khi list đã gọi được, tools/list sau đó cũng thấy nó', async () => {
  const mcpServer = createMcpServer({});
  const server = await startApi({ mcpServer });
  await mcpInitialize(server);
  let lateRan = false;
  mcpServer.registerTool(lateReadOnlyToolDef('late_readonly', () => {
    lateRan = true;
  }));
  // Gọi TRƯỚC khi list: mount đọc lại defs trong tools/call nên
  // allowedNames đã có tool mới (trước W17c: snapshot lúc mount
  // không có nó → -32602 "không được expose").
  const ok = await mcpCallTool(server, 'late_readonly');
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  assert.equal(lateRan, true);
  assert.ok(JSON.stringify(ok.result.content).includes('ran late_readonly'));
  assert.deepEqual(
    [...(await mcpListToolNames(server))].sort(),
    [...DEFAULT_TOOLS, 'late_readonly'].sort(),
  );
});

test('W17c: tool ghi đăng ký SAU lúc mount (tên trong danh sách write + chỉ lộ qua annotation) → không xuất hiện trong list, tools/call bị chặn -32602, handler không chạy', async () => {
  const mcpServer = createMcpServer({});
  const server = await startApi({ mcpServer });
  await mcpInitialize(server);
  let shellRan = false;
  let deployRan = false;
  mcpServer.registerTool({
    name: 'shell_exec',
    description: 'Shell đăng ký sau lúc mount (chỉ dùng cho test).',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: async () => {
      shellRan = true;
      return 'shell late';
    },
  });
  mcpServer.registerTool(lateDeployToolDef(() => {
    deployRan = true;
  }));
  // Gọi TRƯỚC khi list: cả hai đều phải bị chặn ngay — tool tên
  // trong danh sách write (shell_exec) bằng gate tên, tool chỉ lộ
  // qua annotation (deploy_late) bằng tập annotation-write đã đọc
  // lại; và NEITHER được hợp nhất vào allowedNames.
  const blockedShell = await mcpCallTool(server, 'shell_exec', { command: 'echo hi' });
  assert.equal(blockedShell.error.code, -32602);
  assert.match(blockedShell.error.message, /shell_exec/);
  assert.match(blockedShell.error.message, /allowWriteTools/);
  const blockedDeploy = await mcpCallTool(server, 'deploy_late');
  assert.equal(blockedDeploy.error.code, -32602);
  assert.match(blockedDeploy.error.message, /deploy_late/);
  assert.match(blockedDeploy.error.message, /allowWriteTools/);
  assert.equal(shellRan, false);
  assert.equal(deployRan, false);
  // List cũng không lộ tool ghi đăng ký muộn.
  assert.deepEqual([...(await mcpListToolNames(server))].sort(), [...DEFAULT_TOOLS].sort());
  assert.equal(shellRan, false);
  assert.equal(deployRan, false);
});

test("W17c: mcpTools 'all' + allowWriteTools → tool đăng ký SAU lúc mount (kể cả tool ghi) vẫn được expose list + call", async () => {
  const mcpServer = mcpWithWriteTools();
  const server = await startApi({ mcpServer, mcpTools: 'all', allowWriteTools: true });
  await mcpInitialize(server);
  let lateReadRan = false;
  let lateWriteRan = false;
  mcpServer.registerTool(lateReadOnlyToolDef('late_readonly_all', () => {
    lateReadRan = true;
  }));
  mcpServer.registerTool(lateWriteToolDef('late_write_all', () => {
    lateWriteRan = true;
  }));
  assert.deepEqual(
    [...(await mcpListToolNames(server))].sort(),
    [...DEFAULT_TOOLS, 'shell_exec', 'write_file', 'late_readonly_all', 'late_write_all'].sort(),
  );
  const okRead = await mcpCallTool(server, 'late_readonly_all');
  assert.equal(okRead.error, undefined, JSON.stringify(okRead));
  assert.equal(lateReadRan, true);
  const okWrite = await mcpCallTool(server, 'late_write_all');
  assert.equal(okWrite.error, undefined, JSON.stringify(okWrite));
  assert.equal(lateWriteRan, true);
});

test('W17c: tool bị gỡ khỏi defs → biến mất khỏi list và tools/call bị chặn -32602 (mount tự cắt allowedNames)', async () => {
  let doomedRan = false;
  const mount = fakeMcpMount([
    fakeReadOnlyToolDef('fake_echo'),
    fakeReadOnlyToolDef('doomed_tool', () => {
      doomedRan = true;
    }),
  ]);
  const server = await startApi({ mcpServer: mount });
  await mcpInitialize(server);
  assert.deepEqual([...(await mcpListToolNames(server))].sort(), ['doomed_tool', 'fake_echo']);
  const ok = await mcpCallTool(server, 'doomed_tool');
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  assert.equal(doomedRan, true);
  // Gỡ khỏi defs (handler dưới vẫn còn — fake cố tình giữ để chứng
  // minh chính mount chặn, không phải server dưới).
  mount.unregisterFakeTool('doomed_tool');
  doomedRan = false;
  assert.deepEqual(await mcpListToolNames(server), ['fake_echo']);
  const blocked = await mcpCallTool(server, 'doomed_tool');
  assert.equal(blocked.error.code, -32602);
  assert.match(blocked.error.message, /doomed_tool/);
  assert.equal(blocked.result, undefined);
  assert.equal(doomedRan, false);
});

test('W17c: explicit list không tự thêm tool ngoài list — tool read-only đăng ký SAU lúc mount vẫn không list, gọi bị chặn -32602', async () => {
  const mcpServer = createMcpServer({});
  const server = await startApi({ mcpServer, mcpTools: ['echo'] });
  await mcpInitialize(server);
  let lateRan = false;
  mcpServer.registerTool(lateReadOnlyToolDef('late_outside_list', () => {
    lateRan = true;
  }));
  assert.deepEqual(await mcpListToolNames(server), ['echo']);
  const blocked = await mcpCallTool(server, 'late_outside_list');
  assert.equal(blocked.error.code, -32602);
  assert.match(blocked.error.message, /late_outside_list/);
  assert.equal(lateRan, false);
  // Tool trong list vẫn gọi được bình thường.
  const ok = await mcpCallTool(server, 'echo', { message: 'ping' });
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  assert.ok(JSON.stringify(ok.result.content).includes('ping'));
});


// ---------------------------------------------------------------------------
// W19c: strictReadOnly — 'all-read-only' chỉ expose tool gắn
// `readOnlyHint: true` tường minh; tool không annotation không
// được tin là read-only (giới hạn đã biết từ W13e/W14d mà chế độ
// mặc định vẫn để lọt: tool ghi tên lạ không annotation).
// ---------------------------------------------------------------------------

test('W19c: strict ON + all-read-only vẫn expose đúng 5 tool mặc định (cả 5 đều gắn readOnlyHint: true)', async () => {
  const server = await startApi({ mcpServer: createMcpServer({}), strictReadOnly: true });
  await mcpInitialize(server);
  assert.deepEqual([...(await mcpListToolNames(server))].sort(), [...DEFAULT_TOOLS].sort());
});

test('W19c: strict ON + all-read-only — tool readOnlyHint: true được expose + gọi được; tool không annotation KHÔNG vào list, tools/call bị chặn -32602; tool readOnlyHint: false/destructiveHint: true vẫn bị chặn như cũ', async () => {
  const server = await startApi({
    mcpServer: createMcpServer({
      tools: [
        fakeReadOnlyToolDef('annotated_ro'),
        strangeNoAnnotationToolDef(),
        annotationOnlyWriteToolDef(),
      ],
    }),
    mcpTools: 'all-read-only',
    strictReadOnly: true,
  });
  await mcpInitialize(server);
  // List: chỉ 5 mặc định + tool gắn readOnlyHint: true; tool
  // không annotation (frobnicate) và tool ghi theo annotation
  // (deploy_prod) đều không lộ.
  assert.deepEqual(
    [...(await mcpListToolNames(server))].sort(),
    [...DEFAULT_TOOLS, 'annotated_ro'].sort(),
  );
  // Tool gắn readOnlyHint: true gọi được.
  const ok = await mcpCallTool(server, 'annotated_ro');
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  assert.ok(JSON.stringify(ok.result.content).includes('ran annotated_ro'));
  // Tool không annotation: gọi TRƯỚC khi list cũng bị chặn
  // (-32602) — khác hẳn hành vi mặc định ở test W13e cuối file
  // (ở đó frobnicate vẫn chạy được).
  const blockedNoAnnotation = await mcpCallTool(server, 'frobnicate');
  assert.equal(blockedNoAnnotation.error.code, -32602);
  assert.match(blockedNoAnnotation.error.message, /frobnicate/);
  assert.equal(blockedNoAnnotation.result, undefined);
  // Tool ghi chỉ lộ qua annotation: vẫn bị chặn như cũ, lý do
  // "tool ghi" kèm allowWriteTools.
  const blockedWrite = await mcpCallTool(server, 'deploy_prod');
  assert.equal(blockedWrite.error.code, -32602);
  assert.match(blockedWrite.error.message, /deploy_prod/);
  assert.match(blockedWrite.error.message, /allowWriteTools/);
});

test('W19c: strict ON — tool đăng ký SAU lúc mount: có annotation readOnlyHint: true thì được thêm, không annotation thì không', async () => {
  const mcpServer = createMcpServer({});
  const server = await startApi({ mcpServer, mcpTools: 'all-read-only', strictReadOnly: true });
  await mcpInitialize(server);
  let annotatedRan = false;
  let plainRan = false;
  mcpServer.registerTool(lateReadOnlyToolDef('late_strict_ro', () => {
    annotatedRan = true;
  }));
  mcpServer.registerTool({
    name: 'late_strict_plain',
    description: 'Tool đăng ký sau lúc mount, không annotation (chỉ dùng cho test).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      plainRan = true;
      return 'ran late_strict_plain';
    },
  });
  // Tool mới có annotation: refresh defs (W17c) thêm nó vào
  // allowedNames nên gọi TRƯỚC khi list đã chạy được.
  const ok = await mcpCallTool(server, 'late_strict_ro');
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  assert.equal(annotatedRan, true);
  // Tool mới không annotation: refresh KHÔNG thêm nó — gọi bị
  // chặn -32602, handler không chạy.
  const blocked = await mcpCallTool(server, 'late_strict_plain');
  assert.equal(blocked.error.code, -32602);
  assert.match(blocked.error.message, /late_strict_plain/);
  assert.equal(plainRan, false);
  // List sau đó chỉ thấy tool có annotation.
  assert.deepEqual(
    [...(await mcpListToolNames(server))].sort(),
    [...DEFAULT_TOOLS, 'late_strict_ro'].sort(),
  );
  assert.equal(plainRan, false);
});

test('W19c: strict OFF (mặc định, không truyền strictReadOnly) giữ nguyên hành vi cũ — tool không annotation vẫn expose + gọi được', async () => {
  const server = await startApi({
    mcpServer: createMcpServer({
      tools: [fakeReadOnlyToolDef('annotated_ro'), strangeNoAnnotationToolDef()],
    }),
    mcpTools: 'all-read-only',
    // KHÔNG truyền strictReadOnly: mặc định false.
  });
  await mcpInitialize(server);
  assert.deepEqual(
    [...(await mcpListToolNames(server))].sort(),
    [...DEFAULT_TOOLS, 'annotated_ro', 'frobnicate'].sort(),
  );
  const ok = await mcpCallTool(server, 'frobnicate');
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  assert.ok(JSON.stringify(ok.result.content).includes('frobbed'));
});

test('W19c: explicit list + strict ON — tool trong list vẫn gọi được kể cả không annotation (hợp đồng tường minh thắng strict)', async () => {
  const server = await startApi({
    mcpServer: createMcpServer({ tools: [strangeNoAnnotationToolDef()] }),
    mcpTools: ['frobnicate', 'echo'],
    strictReadOnly: true,
  });
  await mcpInitialize(server);
  assert.deepEqual([...(await mcpListToolNames(server))].sort(), ['echo', 'frobnicate']);
  const ok = await mcpCallTool(server, 'frobnicate');
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  assert.ok(JSON.stringify(ok.result.content).includes('frobbed'));
  // Tool read-only nhưng ngoài list vẫn bị chặn như cũ.
  const blocked = await mcpCallTool(server, 'bot_info');
  assert.equal(blocked.error.code, -32602);
  assert.match(blocked.error.message, /bot_info/);
});

test("W19c: mcpTools 'all' + allowWriteTools: true + strict ON — strict không ảnh hưởng 'all' (mọi tool vẫn expose, kể cả tool ghi và tool không annotation)", async () => {
  const server = await startApi({
    mcpServer: mcpWithWriteTools([strangeNoAnnotationToolDef()]),
    mcpTools: 'all',
    allowWriteTools: true,
    strictReadOnly: true,
  });
  await mcpInitialize(server);
  assert.deepEqual(
    [...(await mcpListToolNames(server))].sort(),
    [...DEFAULT_TOOLS, 'shell_exec', 'write_file', 'frobnicate'].sort(),
  );
  const ok = await mcpCallTool(server, 'frobnicate');
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  const ran = await mcpCallTool(server, 'shell_exec', { command: 'echo hi' });
  assert.equal(ran.error, undefined, JSON.stringify(ran));
});

test('W17c: listToolDefinitions() throw → giữ tập cũ, request không crash; hết lỗi thì tool mới lại được expose', async () => {
  let stableRan = false;
  let newRan = false;
  const mount = fakeMcpMount([fakeReadOnlyToolDef('stable_tool', () => {
    stableRan = true;
  })]);
  const server = await startApi({ mcpServer: mount });
  await mcpInitialize(server);
  assert.deepEqual(await mcpListToolNames(server), ['stable_tool']);
  // Lỗi đọc defs bắt đầu: đăng ký thêm tool trong lúc defs throw.
  mount.setThrowOnDefs(true);
  mount.registerFakeTool(fakeReadOnlyToolDef('new_while_broken', () => {
    newRan = true;
  }));
  // Request không crash (200, có result, không có error) nhưng tập
  // cũ được giữ: tool mới chưa lộ, tool cũ vẫn gọi được.
  const listWhileBroken = await mcpRpc(server, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.equal(listWhileBroken.error, undefined, JSON.stringify(listWhileBroken));
  assert.deepEqual(listWhileBroken.result.tools.map((t) => t.name), ['stable_tool']);
  const okStable = await mcpCallTool(server, 'stable_tool');
  assert.equal(okStable.error, undefined, JSON.stringify(okStable));
  assert.equal(stableRan, true);
  const blockedNew = await mcpCallTool(server, 'new_while_broken');
  assert.equal(blockedNew.error.code, -32602);
  assert.equal(newRan, false);
  // Hết lỗi: lần refresh sau đọc được defs mới → tool mới xuất hiện.
  mount.setThrowOnDefs(false);
  assert.deepEqual(
    [...(await mcpListToolNames(server))].sort(),
    ['new_while_broken', 'stable_tool'],
  );
  const okNew = await mcpCallTool(server, 'new_while_broken');
  assert.equal(okNew.error, undefined, JSON.stringify(okNew));
  assert.equal(newRan, true);
});
