#!/usr/bin/env node
/**
 * Fake MCP server for v0.98 Apps/Tasks wiring tests (stdio transport).
 * Extends tests/fixtures/fake-mcp-server.mjs with:
 *  - tools/list: echo, show-app, slow-echo
 *  - tools/call show-app -> content with a text/html resource block
 *    (uri ui://fake/card) + a text block (shape A of parseAppResult)
 *  - tools/call slow-echo with `_meta.task` -> task handle
 *    { taskId: 'task-slow-1', status: 'working', pollInterval: 50 }
 *  - tasks/get task-slow-1 -> completed (2025-11-25: result comes from
 *    tasks/result, not tasks/get)
 *  - tasks/result task-slow-1 -> { content: [{ type: 'text',
 *    text: 'Slow echo done' }] }
 *  - tasks/cancel -> { taskId, status: 'cancelled' }
 *  - tasks/list -> { tasks: [] }
 * Unknown method -> JSON-RPC -32601; unknown tool -> -32602.
 * Notifications (no id) get no reply.
 */
import * as readline from 'node:readline';

const APP_HTML =
  '<div style="font-family: sans-serif; padding: 12px;"><h2>Fake card</h2>' +
  '<p>Hello from the fake MCP App.</p></div>';

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function result(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore malformed lines
  }
  if (msg.id === undefined || msg.id === null) return; // notification: no reply
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      result(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp-apps-server', version: '0.1.0' },
      });
      break;
    case 'ping':
      result(id, {});
      break;
    case 'tools/list':
      result(id, {
        tools: [
          { name: 'echo', description: 'Echo back the input message', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
          { name: 'show-app', description: 'Return an interactive app', inputSchema: { type: 'object', properties: {}, required: [] } },
          { name: 'slow-echo', description: 'Slow echo, supports tasks', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
        ],
      });
      break;
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === 'echo') {
        result(id, { content: [{ type: 'text', text: `Echo: ${args.message ?? ''}` }], isError: false });
        break;
      }
      if (name === 'show-app') {
        result(id, {
          content: [
            { type: 'resource', resource: { uri: 'ui://fake/card', mimeType: 'text/html', text: APP_HTML } },
            { type: 'text', text: 'Here is your card.' },
          ],
          isError: false,
        });
        break;
      }
      if (name === 'slow-echo') {
        if (params?._meta?.task !== undefined) {
          result(id, { taskId: 'task-slow-1', status: 'working', pollInterval: 50 });
          break;
        }
        result(id, { content: [{ type: 'text', text: `Slow echo: ${args.message ?? ''}` }], isError: false });
        break;
      }
      error(id, -32602, `Unknown tool: ${name}`);
      break;
    }
    case 'tasks/get': {
      if (params?.taskId !== 'task-slow-1') {
        error(id, -32602, `Unknown task: ${params?.taskId}`);
        break;
      }
      result(id, { taskId: 'task-slow-1', status: 'completed', pollInterval: 50 });
      break;
    }
    case 'tasks/result': {
      if (params?.taskId !== 'task-slow-1') {
        error(id, -32602, `Unknown task: ${params?.taskId}`);
        break;
      }
      result(id, { content: [{ type: 'text', text: 'Slow echo done' }] });
      break;
    }
    case 'tasks/cancel': {
      result(id, { taskId: params?.taskId ?? '', status: 'cancelled' });
      break;
    }
    case 'tasks/list':
      result(id, { tasks: [] });
      break;
    default:
      error(id, -32601, `Method not found: ${method}`);
  }
});
