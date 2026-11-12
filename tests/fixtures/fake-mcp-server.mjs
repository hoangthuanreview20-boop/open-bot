#!/usr/bin/env node
/**
 * Minimal fake MCP server (stdio transport) for tests.
 * Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout.
 * - initialize -> serverInfo { name: "fake-mcp-server", version: "0.1.0" }
 * - ping -> {}
 * - tools/list -> one tool: echo { message: string }
 * - tools/call echo -> content text "Echo: <message>"
 * - resources/list -> one resource: fake://greeting
 * - resources/read fake://greeting -> text "Hello from fake MCP resource"
 * Unknown method -> JSON-RPC -32601; unknown tool -> -32602.
 * Notifications (no id, e.g. notifications/initialized) get no reply.
 */
import * as readline from 'node:readline';

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
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'fake-mcp-server', version: '0.1.0' },
      });
      break;
    case 'ping':
      result(id, {});
      break;
    case 'tools/list':
      result(id, {
        tools: [
          {
            name: 'echo',
            description: 'Echo back the input message',
            inputSchema: {
              type: 'object',
              properties: { message: { type: 'string' } },
              required: ['message'],
            },
          },
        ],
      });
      break;
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name !== 'echo') {
        error(id, -32602, `Unknown tool: ${name}`);
        break;
      }
      result(id, {
        content: [{ type: 'text', text: `Echo: ${args.message ?? ''}` }],
        isError: false,
      });
      break;
    }
    case 'resources/list':
      result(id, {
        resources: [
          {
            uri: 'fake://greeting',
            name: 'greeting',
            description: 'A fake greeting',
            mimeType: 'text/plain',
          },
        ],
      });
      break;
    case 'resources/read': {
      if (params?.uri !== 'fake://greeting') {
        error(id, -32602, `Unknown resource: ${params?.uri}`);
        break;
      }
      result(id, {
        contents: [{ uri: 'fake://greeting', mimeType: 'text/plain', text: 'Hello from fake MCP resource' }],
      });
      break;
    }
    default:
      error(id, -32601, `Method not found: ${method}`);
  }
});
