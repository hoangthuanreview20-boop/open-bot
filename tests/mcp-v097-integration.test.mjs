/**
 * Test v0.97 T1: MCP 2.0 integration — server discover, stateless
 * requests, Tasks methods, deprecation notices, and the mcp2_* agent
 * tools (node:test). Local only, no live network: the built-in
 * server is driven through handleJsonRpc, and the tools run against
 * a fake MCP server spawned from the test fixtures.
 *
 * Build core + tools first:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/mcp-v097-integration.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createMcpServer,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_NOT_INITIALIZED,
} from '../packages/core/dist/mcp/server.js';
import { createMcpV097Tools, MCP_V097_TOOLS } from '../packages/tools/dist/mcpV097Tools.js';
import { connectMcp } from '../packages/core/dist/mcp/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER = path.join(__dirname, 'fixtures', 'fake-mcp-server.mjs');

async function rpc(server, method, params, id = 1) {
  const res = await server.handleJsonRpc({ jsonrpc: '2.0', id, method, params });
  return res;
}

test('integration: server/discover works without any handshake', async () => {
  const server = createMcpServer({ name: 'open-bot', version: '0.2.0' });
  const res = await rpc(server, 'server/discover', { _meta: { protocolVersion: '2026-07-28' } });
  assert.equal(res.error, undefined);
  assert.equal(res.result.protocolVersion, '2026-07-28');
  assert.equal(res.result.serverInfo.name, 'open-bot');
  assert.ok('tools' in res.result.capabilities);
  assert.ok(res.result.extensions.includes('io.modelcontextprotocol/tasks'));
  assert.ok(res.result.extensions.includes('io.modelcontextprotocol/apps'));
  // The server is still NOT initialized — discover does not handshake.
  assert.equal(server.isInitialized, false);
});

test('integration: stateless request with _meta works without initialize', async () => {
  const server = createMcpServer();
  const res = await rpc(server, 'tools/list', {
    _meta: { protocolVersion: '2026-07-28', clientCapabilities: { tasks: true } },
  });
  assert.equal(res.error, undefined);
  assert.ok(Array.isArray(res.result.tools));
  assert.ok(res.result.tools.length > 0);
});

test('integration: stateless request with an unknown version is rejected', async () => {
  const server = createMcpServer();
  const res = await rpc(server, 'tools/list', {
    _meta: { protocolVersion: '2031-01-01' },
  });
  assert.equal(res.error.code, JSON_RPC_INVALID_PARAMS);
});

test('integration: legacy gate still applies without _meta and without initialize', async () => {
  const server = createMcpServer();
  const res = await rpc(server, 'tools/list', {});
  assert.equal(res.error.code, JSON_RPC_NOT_INITIALIZED);
  // After initialize, the legacy path still works.
  const init = await rpc(server, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 't', version: '1' },
  });
  assert.equal(init.error, undefined);
  assert.equal(init.result.protocolVersion, '2025-11-25');
  const after = await rpc(server, 'tools/list', {}, 2);
  assert.equal(after.error, undefined);
});

test('integration: initialize with deprecated capabilities records a notice', async () => {
  const server = createMcpServer();
  await rpc(server, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: { sampling: {}, roots: {}, logging: {} },
    clientInfo: { name: 'old-client', version: '1' },
  });
  const notices = server.getDeprecationNotices();
  const methods = notices.map((n) => n.method);
  assert.ok(methods.includes('sampling/createMessage'));
  assert.ok(methods.includes('roots/list'));
  assert.ok(methods.includes('notifications/message'));
  // A modern client advertises nothing deprecated.
  const modern = createMcpServer();
  await rpc(modern, 'initialize', {
    protocolVersion: '2026-07-28',
    capabilities: { tools: {} },
    clientInfo: { name: 'new-client', version: '2' },
  });
  assert.deepEqual(modern.getDeprecationNotices(), []);
});

test('integration: server tasks — submit, poll, result, cancel, update', async () => {
  const server = createMcpServer();
  await rpc(server, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 't', version: '1' },
  });
  // A slow job submitted directly to the server store.
  const handle = server.submitLongTask('tools/call', { name: 'slow' }, async (ctx) => {
    ctx.reportProgress(0.5, 'halfway');
    await new Promise((resolve) => setTimeout(resolve, 15));
    return { value: 'finished' };
  });
  assert.equal(handle.status, 'working');
  const polled = await rpc(server, 'tasks/get', { taskId: handle.taskId }, 10);
  assert.equal(polled.error, undefined);
  assert.equal(polled.result.taskId, handle.taskId);
  assert.equal(polled.result.status, 'working');
  assert.equal(polled.result.progress, 0.5);
  // tasks/result before completion is an error, not a hang.
  const early = await rpc(server, 'tasks/result', { taskId: handle.taskId }, 11);
  assert.equal(early.error.code, JSON_RPC_INVALID_PARAMS);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const done = await rpc(server, 'tasks/get', { taskId: handle.taskId }, 12);
  assert.equal(done.result.status, 'completed');
  assert.deepEqual(done.result.result, { value: 'finished' });
  const fetched = await rpc(server, 'tasks/result', { taskId: handle.taskId }, 13);
  assert.deepEqual(fetched.result, { result: { value: 'finished' } });
  // tasks/list sees it.
  const listed = await rpc(server, 'tasks/list', {}, 14);
  assert.ok(listed.result.tasks.some((t) => t.taskId === handle.taskId));
  // Unknown task id is a clean -32602, not a crash.
  const unknown = await rpc(server, 'tasks/get', { taskId: 'nope' }, 15);
  assert.equal(unknown.error.code, JSON_RPC_INVALID_PARAMS);
  // Cancel a working task.
  const slow = server.submitLongTask('tools/call', {}, async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return 'late';
  });
  const cancelled = await rpc(server, 'tasks/cancel', { taskId: slow.taskId }, 16);
  assert.equal(cancelled.result.status, 'cancelled');
  // tasks/update on a working task (not input_required) is rejected.
  const badUpdate = await rpc(server, 'tasks/update', { taskId: slow.taskId, input: {} }, 17);
  assert.equal(badUpdate.error.code, JSON_RPC_INVALID_PARAMS);
});

test('integration: server tasks — input_required round trip via tasks/update', async () => {
  const server = createMcpServer();
  await rpc(server, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 't', version: '1' },
  });
  const handle = server.submitLongTask('tools/call', {}, async (ctx) => {
    const input = await ctx.requestInput('Pick a file.');
    return `picked ${input.file}`;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const parked = await rpc(server, 'tasks/get', { taskId: handle.taskId }, 20);
  assert.equal(parked.result.status, 'input_required');
  const updated = await rpc(server, 'tasks/update', { taskId: handle.taskId, input: { file: 'a.txt' } }, 21);
  assert.equal(updated.result.status, 'working');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const done = await rpc(server, 'tasks/get', { taskId: handle.taskId }, 22);
  assert.equal(done.result.status, 'completed');
  assert.equal(done.result.result, 'picked a.txt');
});

test('integration: server methods for unknown tasks methods return method-not-found when disabled', async () => {
  const server = createMcpServer({ tasksEnabled: false });
  await rpc(server, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 't', version: '1' },
  });
  const res = await rpc(server, 'tasks/get', { taskId: 'x' }, 30);
  assert.equal(res.error.code, JSON_RPC_METHOD_NOT_FOUND);
  assert.throws(() => server.submitLongTask('tools/call', {}, async () => 'x'), /Tasks extension/);
});

test('integration: mcp2_* tools — six tools, correct names and approval flags', () => {
  const tools = createMcpV097Tools();
  assert.equal(tools.length, 6);
  assert.equal(MCP_V097_TOOLS.length, 6);
  assert.deepEqual(
    tools.map((t) => t.definition.name).sort(),
    [
      'mcp2_call_tool_mrtr',
      'mcp2_discover_server',
      'mcp2_scan_tool_descriptions',
      'mcp2_task_cancel',
      'mcp2_task_poll',
      'mcp2_validate_app',
    ],
  );
  const byName = new Map(tools.map((t) => [t.definition.name, t]));
  assert.equal(byName.get('mcp2_call_tool_mrtr')?.needsApproval, true);
  assert.equal(byName.get('mcp2_discover_server')?.needsApproval, false);
  assert.equal(byName.get('mcp2_validate_app')?.needsApproval, false);
  for (const tool of tools) {
    assert.ok(tool.definition.description.length > 20, tool.definition.name);
    assert.equal(tool.definition.parameters.type, 'object');
  }
});

test('integration: mcp2_validate_app tool validates and refuses unsafe HTML', async () => {
  const tools = createMcpV097Tools();
  const validate = tools.find((t) => t.definition.name === 'mcp2_validate_app');
  const ctx = { workspaceDir: '/tmp', botId: 'bot-1' };
  const ok = await validate.execute(
    { uri: 'ui://demo/hello', html: '<h1>Hi</h1><script>console.log("ok")</script>' },
    ctx,
  );
  assert.match(ok, /safe to render/);
  assert.match(ok, /sandbox: allow-scripts/);
  assert.match(ok, /default-src 'none'/);
  await assert.rejects(
    validate.execute(
      { uri: 'ui://evil/x', html: '<script src="https://evil.example/x.js"></script>' },
      ctx,
    ),
    /remote script/,
  );
  await assert.rejects(validate.execute({ uri: 'https://x/app', html: '<p>x</p>' }, ctx), /ui:\/\//);
});

test('integration: stateless client discovers the fake server over stdio', async () => {
  if (!fs.existsSync(FAKE_SERVER)) {
    // Fixture missing (older checkout) — skip instead of failing.
    return;
  }
  const client = await connectMcp({
    name: 'fake',
    command: process.execPath,
    args: [FAKE_SERVER],
    stateless: true,
  });
  try {
    const discovered = await client.discover?.();
    // The fake server is pre-2.0: discover returns null, and the
    // client still works because requests carry _meta.
    assert.equal(discovered, null);
    const tools = await client.listTools();
    assert.ok(Array.isArray(tools));
  } finally {
    await client.close().catch(() => undefined);
  }
});

test('integration: mcp2_discover_server + mcp2_scan_tool_descriptions against the fake server', async () => {
  if (!fs.existsSync(FAKE_SERVER)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-mcp-v097-test-'));
  fs.mkdirSync(path.join(dir, '.open-bot'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.open-bot', 'mcp.json'),
    JSON.stringify({ servers: { fake: { command: process.execPath, args: [FAKE_SERVER] } } }),
    'utf8',
  );
  const tools = createMcpV097Tools();
  const ctx = { workspaceDir: dir, botId: 'bot-1' };
  const discover = tools.find((t) => t.definition.name === 'mcp2_discover_server');
  const discovered = await discover.execute({ server: 'fake' }, ctx);
  assert.match(discovered, /does not support server\/discover/);
  const scan = tools.find((t) => t.definition.name === 'mcp2_scan_tool_descriptions');
  const report = await scan.execute({ server: 'fake' }, ctx);
  assert.match(report, /Description-poisoning scan/);
  assert.match(report, /scanned: \d+ tools/);
  fs.rmSync(dir, { recursive: true, force: true });
});
