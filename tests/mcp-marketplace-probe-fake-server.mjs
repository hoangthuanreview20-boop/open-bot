/**
 * Minimal fake MCP server (stdio, NDJSON JSON-RPC) for the v0.67a
 * marketplace probe tests + the Electron smoke test.
 *
 * Usage: node mcp-marketplace-probe-fake-server.mjs [mode]
 *
 * Modes:
 *   ok            (default) answer initialize + tools/list properly.
 *   exit-early    exit(1) immediately — spawn succeeds, server dies.
 *   bad-handshake answer initialize with a JSON-RPC error.
 *   hang          read stdin, never answer anything (probe timeout).
 *   list-32602    answer initialize, reject tools/list with -32602
 *                 (invalid params) — v0.73 probe-warning test: the
 *                 client must turn this into [] + an onWarning.
 *
 * The "ok" server exposes two tools:
 *   fake_echo    (inputSchema: { text: string, required }) and
 *   fake_no_args (inputSchema with empty properties).
 *
 * No network, no real MCP package, no secrets — local stdio only.
 */
import * as readline from 'node:readline';

const mode = process.argv[2] ?? 'ok';

if (mode === 'exit-early') process.exit(1);

const TOOLS = [
  {
    name: 'fake_echo',
    description: 'Echoes the input text back.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'fake_no_args',
    description: 'Does nothing and takes no arguments.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // Ignore garbage lines; never crash on bad input.
  }
  // Notifications (no id) need no reply.
  if (msg.id === undefined || msg.id === null) return;
  if (mode === 'hang') return; // Never answer.
  if (msg.method === 'initialize') {
    if (mode === 'bad-handshake') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
      },
    });
    return;
  }
  if (msg.method === 'tools/list') {
    if (mode === 'list-32602') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32602, message: 'Invalid params: tools/list requires a cursor' },
      });
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    return;
  }
  if (msg.method === 'ping') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
});
