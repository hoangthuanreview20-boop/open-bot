/**
 * Test v1.02 (Team T3): MCP notifications — hub pub/sub, log levels,
 * client list_changed handlers, server logging/setLevel + cancelled.
 *
 * Only local code (no network, no real MCP server).
 *
 * Build core first:
 *   npm run build --workspace=@open-bot/core
 * then: node --test tests/mcp-notifications-v102.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpDispatcher } from '../packages/core/dist/mcp/dispatcher.js';
import {
  McpNotificationHub,
  registerMcpListChangedHandlers,
  mcpListChangedMethod,
  parseMcpLogLevel,
  shouldLogMcp,
  MCP_NOTIFICATION_CANCELLED,
  MCP_DEFAULT_LOG_LEVEL,
} from '../packages/core/dist/mcp/notifications.js';
import { createMcpServer } from '../packages/core/dist/mcp/server.js';

test('hub: list_changed reaches listeners; unsubscribe stops delivery', () => {
  const hub = new McpNotificationHub();
  const seen = [];
  const unsub = hub.onListChanged((kind) => seen.push(kind));
  hub.emitListChanged('tools');
  hub.emitListChanged('resources');
  assert.deepEqual(seen, ['tools', 'resources']);
  assert.equal(hub.listenerCount('list'), 1);
  unsub();
  hub.emitListChanged('prompts');
  assert.deepEqual(seen, ['tools', 'resources']);
  assert.equal(hub.listenerCount('list'), 0);
});

test('hub: a throwing listener does not break other listeners', () => {
  const errors = [];
  const hub = new McpNotificationHub({ onListenerError: (err) => errors.push(err) });
  const seen = [];
  hub.onListChanged(() => {
    throw new Error('listener boom');
  });
  hub.onListChanged((kind) => seen.push(kind));
  hub.emitListChanged('tools');
  assert.deepEqual(seen, ['tools']);
  assert.equal(errors.length, 1);
});

test('hub: cancellations are tracked and can be forgotten', () => {
  const hub = new McpNotificationHub();
  const seen = [];
  hub.onCancelled((c) => seen.push(c));
  hub.emitCancelled({ requestId: 7, reason: 'user aborted' });
  assert.equal(hub.isCancelled(7), true);
  assert.equal(hub.isCancelled(8), false);
  assert.deepEqual(hub.cancelledRequestIds(), [7]);
  assert.deepEqual(seen, [{ requestId: 7, reason: 'user aborted' }]);
  hub.forgetCancelled(7);
  assert.equal(hub.isCancelled(7), false);
});

test('log levels: parse + ordering (spec default is info)', () => {
  assert.equal(MCP_DEFAULT_LOG_LEVEL, 'info');
  assert.equal(parseMcpLogLevel('warning'), 'warning');
  assert.equal(parseMcpLogLevel('emergency'), 'emergency');
  assert.equal(parseMcpLogLevel('verbose'), null);
  assert.equal(parseMcpLogLevel(3), null);
  assert.equal(shouldLogMcp('error', 'warning'), true);
  assert.equal(shouldLogMcp('debug', 'info'), false);
  assert.equal(shouldLogMcp('info', 'info'), true);
  assert.equal(shouldLogMcp('emergency', 'debug'), true);
  assert.equal(mcpListChangedMethod('tools'), 'notifications/tools/list_changed');
  assert.equal(mcpListChangedMethod('prompts'), 'notifications/prompts/list_changed');
});

test('client side: list_changed notifications reach the callback via dispatcher', async () => {
  const dispatcher = new McpDispatcher();
  const seen = [];
  const unsub = registerMcpListChangedHandlers(dispatcher, (kind) => seen.push(kind));
  await dispatcher.dispatch({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  await dispatcher.dispatch({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' });
  await dispatcher.dispatch({ jsonrpc: '2.0', method: 'notifications/prompts/list_changed' });
  assert.deepEqual(seen, ['tools', 'resources', 'prompts']);
  unsub();
  await dispatcher.dispatch({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  assert.deepEqual(seen, ['tools', 'resources', 'prompts']);
});

test('server: register* announces list changes; logging/setLevel works; cancelled is tracked', async () => {
  const hub = new McpNotificationHub();
  const changes = [];
  hub.onListChanged((kind) => changes.push(kind));
  // Construction registers the default tools/resources/prompts.
  const server = createMcpServer({ name: 'notify-test', notificationHub: hub });
  assert.ok(changes.includes('tools'));
  assert.ok(changes.includes('resources'));
  assert.ok(changes.includes('prompts'));
  changes.length = 0;
  server.registerTool({
    name: 'late_tool',
    description: 'registered after construction',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => 'ok',
  });
  assert.deepEqual(changes, ['tools']);

  // logging/setLevel: valid level sticks, invalid is -32602.
  assert.equal(server.getLogLevel(), 'info');
  const setOk = await server.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'logging/setLevel', params: { level: 'warning' } });
  assert.equal(setOk.error, undefined);
  assert.equal(server.getLogLevel(), 'warning');
  const setBad = await server.handleJsonRpc({ jsonrpc: '2.0', id: 2, method: 'logging/setLevel', params: { level: 'verbose' } });
  assert.equal(setBad.error.code, -32602);
  assert.equal(server.getLogLevel(), 'warning');

  // Log messages are gated by the level.
  const messages = [];
  hub.onLogMessage((m) => messages.push(m));
  server.notifyLogMessage('info', 'test', 'too quiet');
  server.notifyLogMessage('error', 'test', 'loud enough');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].level, 'error');

  // notifications/cancelled (no id = notification, null response).
  assert.equal(server.isRequestCancelled(99), false);
  const cancelled = await server.handleJsonRpc({
    jsonrpc: '2.0',
    method: MCP_NOTIFICATION_CANCELLED,
    params: { requestId: 99, reason: 'user aborted' },
  });
  assert.equal(cancelled, null);
  assert.equal(server.isRequestCancelled(99), true);
});
