/**
 * Test v1.02 (Team T3): MCP audit integration — real McpServer +
 * real StreamableHttpMcpClient over loopback, both sides audited.
 *
 * Only loopback (no external network).
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-audit-integration-v102.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { McpAuditLog, MCP_AUDIT_REDACTED } from '../packages/core/dist/mcp/auditLog.js';
import { createMcpServer, startMcpHttpServer } from '../packages/core/dist/mcp/server.js';
import { connectMcp } from '../packages/core/dist/mcp/client.js';

const httpServers = [];
after(async () => {
  for (const s of httpServers.splice(0)) await s.close().catch(() => undefined);
});

function echoTool() {
  return {
    name: 'echo_tool',
    description: 'Echoes text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    handler: async (args) => `echo:${args.text ?? ''}`,
  };
}

function boomTool() {
  return {
    name: 'boom_tool',
    description: 'Always throws (tool error).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      throw new Error('boom failed');
    },
  };
}

test('server audit: every request is recorded, secrets redacted', async () => {
  const serverLog = new McpAuditLog();
  const server = createMcpServer({
    name: 'audit-srv',
    auditLogger: serverLog,
    caller: 'bot-1',
    tools: [echoTool(), boomTool()],
  });
  const init = await server.handleJsonRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  });
  assert.equal(init.error, undefined);
  const list = await server.handleJsonRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.equal(list.error, undefined);
  const call = await server.handleJsonRpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'echo_tool', arguments: { text: 'hi', apiKey: 'sk-should-not-appear' } },
  });
  assert.equal(call.error, undefined);
  assert.match(JSON.stringify(call.result), /echo:hi/);
  // Unknown tool -> protocol error (-32602); throwing tool -> tool-error.
  const unknown = await server.handleJsonRpc({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'no_such_tool', arguments: {} },
  });
  assert.equal(unknown.error.code, -32602);
  const boom = await server.handleJsonRpc({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'boom_tool', arguments: {} },
  });
  assert.equal(boom.result.isError, true);

  const entries = serverLog.query({ limit: 20 });
  assert.equal(entries.length, 5);
  assert.ok(entries.every((e) => e.direction === 'server'));
  assert.ok(entries.every((e) => e.server === 'audit-srv'));
  assert.ok(entries.every((e) => e.caller === 'bot-1'));
  const callEntry = serverLog.query({ tool: 'echo_tool' })[0];
  assert.equal(callEntry.method, 'tools/call');
  assert.equal(callEntry.outcome, 'ok');
  assert.equal(callEntry.args.apiKey, MCP_AUDIT_REDACTED);
  assert.equal(callEntry.args.text, 'hi');
  assert.ok(callEntry.durationMs >= 0);
  const unknownEntry = serverLog.query({ tool: 'no_such_tool' })[0];
  assert.equal(unknownEntry.outcome, 'error');
  assert.equal(unknownEntry.errorCode, -32602);
  const boomEntry = serverLog.query({ tool: 'boom_tool' })[0];
  assert.equal(boomEntry.outcome, 'tool-error');
  assert.match(boomEntry.resultSummary ?? '', /boom failed/);
  assert.equal(serverLog.verifyChain().ok, true);
  // No secret value anywhere in the exported log.
  assert.ok(!serverLog.exportJsonLines().includes('sk-should-not-appear'));
});

test('client audit: real HTTP client records calls; list_changed reaches the callback', async () => {
  const serverLog = new McpAuditLog();
  const clientLog = new McpAuditLog();
  const server = createMcpServer({
    name: 'audit-srv',
    auditLogger: serverLog,
    tools: [echoTool()],
  });
  const httpServer = await startMcpHttpServer(server, { port: 0 });
  httpServers.push(httpServer);
  const listChanges = [];
  const client = await connectMcp({
    name: 'audit-srv',
    url: `http://127.0.0.1:${httpServer.port}/mcp`,
    auditLogger: clientLog,
    caller: 'bot-9',
    onListsChanged: (kind) => listChanges.push(kind),
  });
  try {
    const tools = await client.listTools();
    assert.ok(tools.some((t) => t.name === 'echo_tool'));
    const text = await client.callTool('echo_tool', { text: 'hey', password: 'hunter2' });
    assert.match(text, /echo:hey/);
    // Server-side notification delivered through the dispatcher.
    await client.getDispatcher().dispatch({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    assert.deepEqual(listChanges, ['tools']);

    const clientEntries = clientLog.query({ limit: 20 });
    assert.ok(clientEntries.length >= 2);
    assert.ok(clientEntries.every((e) => e.direction === 'client'));
    const callEntry = clientLog.query({ tool: 'echo_tool' })[0];
    assert.equal(callEntry.method, 'tools/call');
    assert.equal(callEntry.outcome, 'ok');
    assert.equal(callEntry.caller, 'bot-9');
    assert.equal(callEntry.args.password, MCP_AUDIT_REDACTED);
    assert.equal(callEntry.args.text, 'hey');
    // Server saw the same calls (initialize + list + call).
    const serverCalls = serverLog.query({ method: 'tools/call' });
    assert.equal(serverCalls.length, 1);
    assert.equal(serverCalls[0].tool, 'echo_tool');
    assert.equal(serverCalls[0].outcome, 'ok');
    assert.equal(serverLog.verifyChain().ok, true);
    assert.equal(clientLog.verifyChain().ok, true);
    // Client summary: at least the list + call succeeded.
    const summary = clientLog.summarize();
    assert.ok(summary.total >= 2);
    assert.equal(summary.byOutcome.error, 0);
  } finally {
    await client.close();
  }
});

test('client audit: failed call is recorded as error with the code', async () => {
  const clientLog = new McpAuditLog();
  const server = createMcpServer({ name: 'audit-srv', tools: [echoTool()] });
  const httpServer = await startMcpHttpServer(server, { port: 0 });
  httpServers.push(httpServer);
  const client = await connectMcp({
    name: 'audit-srv',
    url: `http://127.0.0.1:${httpServer.port}/mcp`,
    auditLogger: clientLog,
  });
  try {
    // Unknown tool: the server answers -32602, the client's request()
    // rejects (audited as error), then callToolStructured converts
    // it into tool-error text for the model — the call does NOT throw.
    const text = await client.callTool('no_such_tool', {});
    assert.match(text, /MCP tool error/);
    const entry = clientLog.query({ tool: 'no_such_tool' })[0];
    assert.ok(entry);
    assert.equal(entry.outcome, 'error');
    assert.equal(entry.errorCode, -32602);
  } finally {
    await client.close();
  }
});
