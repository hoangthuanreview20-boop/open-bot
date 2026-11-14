/**
 * Tests for v1.01 (Đội T4) — verbatim MCP memory server.
 *
 * Bao phủ: server chỉ expose đúng 5 tool memory.* (không kèm tool mặc
 * định của McpServer), tools/list + tools/call qua handleJsonRpc
 * (save/search/list/delete/stats end-to-end), read-only mode chặn ghi,
 * output không kèm vector embedding, lỗi input trả tool error (isError),
 * stdio serveStdio qua PassThrough streams (initialize → tools/call →
 * đóng stdin).
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/verbatim-memory-mcp-v101.test.mjs
 *
 * No network.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';

import {
  VerbatimMemoryStore,
  createVerbatimMemoryMcpServer,
  createVerbatimMcpTools,
  openVerbatimBackend,
  VERBATIM_MCP_TOOL_NAMES,
  isVerbatimMcpToolName,
  isVerbatimMcpWriteTool,
} from '../packages/core/dist/memory/verbatim/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-verbatim-mcp-v101-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function makeServer(opts = {}) {
  const dir = makeTempDir();
  const opened = openVerbatimBackend({ dir, backend: 'sqlite' });
  const store = new VerbatimMemoryStore({ backend: opened.backend });
  const server = createVerbatimMemoryMcpServer(store, opts);
  return { dir, store, server };
}

async function rpc(server, method, params, id = 1) {
  return server.handleJsonRpc({ jsonrpc: '2.0', id, method, params });
}

async function init(server) {
  const res = await rpc(server, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  assert.equal(res.error, undefined);
  return res;
}

function parseToolText(res) {
  assert.equal(res.error, undefined);
  const content = res.result.content;
  assert.ok(Array.isArray(content) && content.length > 0);
  return JSON.parse(content[0].text);
}

test('verbatim mcp: tool names + helpers', () => {
  assert.deepEqual([...VERBATIM_MCP_TOOL_NAMES], [
    'memory.save',
    'memory.search',
    'memory.list',
    'memory.delete',
    'memory.stats',
  ]);
  assert.equal(isVerbatimMcpToolName('memory.save'), true);
  assert.equal(isVerbatimMcpToolName('memory.evil'), false);
  assert.equal(isVerbatimMcpWriteTool('memory.save'), true);
  assert.equal(isVerbatimMcpWriteTool('memory.search'), false);
  const tools = createVerbatimMcpTools(null, {});
  assert.equal(tools.length, 5);
});

test('verbatim mcp: tools/list chỉ có 5 tool memory.*', async () => {
  const { store, server } = await makeServer();
  await init(server);
  const res = await rpc(server, 'tools/list', {}, 2);
  assert.equal(res.error, undefined);
  const names = res.result.tools.map((t) => t.name);
  assert.deepEqual([...names].sort(), [...VERBATIM_MCP_TOOL_NAMES].sort());
  await store.close();
});

test('verbatim mcp: save/search/list/delete/stats end-to-end', async () => {
  const { store, server } = await makeServer();
  await init(server);

  const saved = parseToolText(
    await rpc(server, 'tools/call', {
      name: 'memory.save',
      arguments: { text: 'Tôi thích phở bò, không ăn cay', wing: 'default', room: 'food' },
    }, 2),
  );
  assert.equal(saved.created, true);
  assert.equal(saved.text, 'Tôi thích phở bò, không ăn cay');
  assert.equal('embedding' in saved, false);
  const id = saved.id;

  // Save trùng → created false, cùng id.
  const dup = parseToolText(
    await rpc(server, 'tools/call', {
      name: 'memory.save',
      arguments: { text: 'Tôi thích phở bò, không ăn cay', wing: 'default', room: 'food' },
    }, 3),
  );
  assert.equal(dup.created, false);
  assert.equal(dup.id, id);

  const found = parseToolText(
    await rpc(server, 'tools/call', { name: 'memory.search', arguments: { query: 'phở bò' } }, 4),
  );
  assert.equal(found.hits.length, 1);
  assert.equal(found.hits[0].id, id);
  assert.equal(found.usedFallback, true);
  assert.equal('embedding' in found.hits[0], false);

  const listed = parseToolText(
    await rpc(server, 'tools/call', { name: 'memory.list', arguments: { limit: 10 } }, 5),
  );
  assert.equal(listed.total, 1);

  const stats = parseToolText(
    await rpc(server, 'tools/call', { name: 'memory.stats', arguments: {} }, 6),
  );
  assert.equal(stats.total, 1);
  assert.equal(stats.backend, 'sqlite');

  const deleted = parseToolText(
    await rpc(server, 'tools/call', { name: 'memory.delete', arguments: { id } }, 7),
  );
  assert.deepEqual(deleted, { id, deleted: true });
  const deletedAgain = parseToolText(
    await rpc(server, 'tools/call', { name: 'memory.delete', arguments: { id } }, 8),
  );
  assert.deepEqual(deletedAgain, { id, deleted: false });
  await store.close();
});

test('verbatim mcp: lỗi input trả tool error, không crash server', async () => {
  const { store, server } = await makeServer();
  await init(server);
  const missingText = await rpc(server, 'tools/call', { name: 'memory.save', arguments: {} }, 2);
  assert.equal(missingText.error, undefined);
  assert.equal(missingText.result.isError, true);
  assert.match(missingText.result.content[0].text, /[Tt]hiếu tham số|Missing/);
  const unknownTool = await rpc(server, 'tools/call', { name: 'memory.evil', arguments: {} }, 3);
  assert.notEqual(unknownTool.error, undefined);
  await store.close();
});

test('verbatim mcp: read-only mode chặn save/delete, search vẫn chạy', async () => {
  const { store, server } = await makeServer({ allowWrites: false });
  await init(server);
  const saveRes = await rpc(server, 'tools/call', {
    name: 'memory.save',
    arguments: { text: 'không được lưu' },
  }, 2);
  assert.equal(saveRes.result.isError, true);
  assert.match(saveRes.result.content[0].text, /chỉ đọc/);
  const stats = parseToolText(
    await rpc(server, 'tools/call', { name: 'memory.stats', arguments: {} }, 3),
  );
  assert.equal(stats.total, 0);
  await store.close();
});

test('verbatim mcp: serveStdio qua PassThrough streams', async () => {
  const { store, server } = await makeServer();
  const input = new PassThrough();
  const output = new PassThrough();
  let outText = '';
  output.on('data', (chunk) => {
    outText += chunk.toString('utf8');
  });
  const done = server.serveStdio(input, output);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.save', arguments: { text: 'stdio verbatim test' } } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory.stats', arguments: {} } })}\n`);
  input.end();
  await done;
  const lines = outText.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.equal(lines[0].id, 1);
  assert.equal(lines[0].result.serverInfo.name, 'open-bot-verbatim-memory');
  assert.equal(lines[1].id, 2);
  assert.match(lines[1].result.content[0].text, /stdio verbatim test/);
  assert.equal(lines[2].id, 3);
  assert.match(lines[2].result.content[0].text, /"total": 1/);
  await store.close();
});
