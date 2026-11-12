/**
 * Tests for v0.69d — two small follow-ups from the BEYOND-ROADMAP
 * "Giới hạn còn lại" notes:
 *
 *  (1) openUrl wiring for `createMcpTools` (gap left by v0.42): the
 *      coordinator passed `host.openMcpAuthUrl` to `createMcpSystemTools`
 *      (`mcp_auth`) but never to `createMcpTools`, so the per-server
 *      `mcp_authenticate_<server>` tool fell back to printing the auth
 *      URL as text instead of opening the browser. The coordinator now
 *      passes it through `defaultToolFactory`.
 *
 *  (2) SEP-1303 follow-up (note in v0.29): a JSON-RPC `-32602`
 *      (invalid params) from an MCP server for `tools/call` is now
 *      returned as a tool-error result (`isError: true`) instead of
 *      throwing `McpError` and breaking the whole run — the model can
 *      see the reason and retry with fixed arguments. Other codes
 *      (e.g. `-32601`) still throw.
 *
 * No live network, no real keys: fake MCP servers on stdio / localhost
 * HTTP, fake OAuth config, and an `openUrl` stub that throws a marker
 * (so the OAuth flow stops right after opening the URL — no browser,
 * no callback wait).
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/mcp-auth-openurl-sep1303-v069d.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectMcp } from '../packages/core/dist/mcp/client.js';
import { BotMemory, defaultToolFactory } from '../packages/core/dist/index.js';
import { createMcpTools } from '../packages/tools/dist/mcpTools.js';
import { runMcpAuthFlow } from '../packages/tools/dist/mcpSystemTools.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_STDIO_SERVER = path.join(here, 'fixtures', 'fake-mcp-server.mjs');

const OAUTH_CONFIG = {
  authorizationEndpoint: 'https://auth.example.test/authorize',
  tokenEndpoint: 'https://auth.example.test/token',
  clientId: 'test-client-69d',
  scope: 'read',
};

const tmpDirs = [];
const httpServers = [];
const clients = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Workspace with one HTTP MCP server `crm` in `.open-bot/mcp.json`. */
function makeMcpWorkspace() {
  const ws = makeTempDir('open-bot-mcp-openurl-v069d-');
  fs.mkdirSync(path.join(ws, '.open-bot'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, '.open-bot', 'mcp.json'),
    JSON.stringify({
      servers: { crm: { url: 'http://127.0.0.1:9/mcp' } },
    }),
  );
  return ws;
}

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `expected a tool named "${name}"`);
  return tool;
}

after(async () => {
  for (const client of clients) {
    await client.close().catch(() => undefined);
  }
  for (const { server } of httpServers) {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  for (const dir of tmpDirs) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

// --- (1) openUrl wiring -----------------------------------------------------

test('v0.69d openUrl: createMcpTools — mcp_authenticate_crm opens the browser URL', async () => {
  const ws = makeMcpWorkspace();
  const opened = [];
  const openUrl = async (url) => {
    opened.push(url);
    // Stop the flow right after opening: no browser, no callback wait.
    throw new Error(`OPEN_URL_CALLED:${url}`);
  };
  const tools = createMcpTools(ws, {
    oauthStore: {},
    getOAuthConfig: async () => OAUTH_CONFIG,
    openUrl,
  });
  const authTool = toolByName(tools, 'mcp_authenticate_crm');
  const result = await authTool.execute({}, { workspaceDir: ws });
  assert.equal(opened.length, 1, 'openUrl must be called exactly once');
  assert.match(opened[0], /^https:\/\/auth\.example\.test\/authorize\?/, 'auth URL must use the configured endpoint');
  assert.match(opened[0], /client_id=test-client-69d/, 'auth URL must carry the client id');
  assert.match(String(result), /OPEN_URL_CALLED:/, 'the tool result must surface the openUrl call (flow stopped there)');
  assert.doesNotMatch(String(result), /open this URL yourself/, 'with openUrl wired, the tool must not fall back to printing the URL');
});

test('v0.69d openUrl: without openUrl the flow waits for the browser callback (fallback branch)', async () => {
  // NOTE: the per-server auth tool itself takes no timeout argument, so
  // executing it without openUrl would wait the 300s default for a
  // callback that never comes. Test the same branch directly through
  // runMcpAuthFlow with a short timeout instead: no opener -> the flow
  // proceeds to waitForCode and times out quickly (listener closes in
  // `finally`, no handle leak). With an opener that throws a marker,
  // the flow rejects with the marker instead of waiting.
  await assert.rejects(
    () => runMcpAuthFlow('crm', {
      oauthStore: {},
      getOAuthConfig: async () => OAUTH_CONFIG,
    }, 200),
    /MCP OAuth callback timed out after 200ms/,
    'without openUrl the flow must wait for the callback, not fail fast',
  );
  const opened = [];
  await assert.rejects(
    () => runMcpAuthFlow('crm', {
      oauthStore: {},
      getOAuthConfig: async () => OAUTH_CONFIG,
      openUrl: async (url) => {
        opened.push(url);
        throw new Error(`OPEN_URL_CALLED:${url}`);
      },
    }, 200),
    /OPEN_URL_CALLED:/,
    'with openUrl the flow must call the opener before waiting',
  );
  assert.equal(opened.length, 1);
  assert.match(opened[0], /auth\.example\.test\/authorize/);
});

test('v0.69d openUrl: defaultToolFactory passes host.openMcpAuthUrl to createMcpTools', async () => {
  const ws = makeMcpWorkspace();
  const mem = new BotMemory(ws);
  try {
    const opened = [];
    const openUrl = async (url) => {
      opened.push(url);
      throw new Error(`OPEN_URL_CALLED:${url}`);
    };
    const tools = defaultToolFactory(mem, ws, 'bot-1', undefined, {
      getMcpOAuthStore: () => ({}),
      getMcpOAuthConfig: async () => OAUTH_CONFIG,
      openMcpAuthUrl: openUrl,
    });
    const authTool = toolByName(tools, 'mcp_authenticate_crm');
    const result = await authTool.execute({}, { workspaceDir: ws });
    assert.equal(opened.length, 1, 'factory-built auth tool must call the host openUrl');
    assert.match(opened[0], /auth\.example\.test\/authorize/, 'opened URL must be the OAuth authorize URL');
    assert.match(String(result), /OPEN_URL_CALLED:/);
  } finally {
    mem.close?.();
  }
});

test('v0.69d openUrl: defaultToolFactory without openMcpAuthUrl still registers the auth tool', async () => {
  const ws = makeMcpWorkspace();
  const mem = new BotMemory(ws);
  try {
    const tools = defaultToolFactory(mem, ws, 'bot-1', undefined, {
      getMcpOAuthStore: () => ({}),
      getMcpOAuthConfig: async () => OAUTH_CONFIG,
    });
    // Registration is unaffected by the missing opener; only the
    // open-in-browser behaviour differs (covered at the flow level above).
    const authTool = toolByName(tools, 'mcp_authenticate_crm');
    assert.equal(authTool.needsApproval, true, 'the auth tool must still need approval');
  } finally {
    mem.close?.();
  }
});

// --- (2) SEP-1303: -32602 is a tool error, not a protocol error -----------

test('v0.69d SEP-1303 (stdio): -32602 for tools/call returns isError instead of throwing', async () => {
  const client = await connectMcp({
    name: 'fake',
    command: process.execPath,
    args: [FAKE_STDIO_SERVER],
  });
  clients.push(client);
  // Unknown tool -> the fake server answers -32602 "Unknown tool: ...".
  const text = await client.callTool('no_such_tool', {});
  assert.match(text, /^MCP tool error:/, 'callTool must return tool-error text, not throw');
  assert.match(text, /Unknown tool: no_such_tool/, 'the server message must be visible to the model');
  assert.match(text, /-32602/, 'the code must be visible so the model knows it is an argument problem');

  const structured = await client.callToolStructured('no_such_tool', {});
  assert.equal(structured.isError, true, 'structured result must be isError');
  assert.match(structured.text, /Unknown tool: no_such_tool/);
  assert.equal(structured.structuredContentValid, false);

  // No regression: a working tool still returns its result.
  assert.equal(await client.callTool('echo', { message: 'hi' }), 'Echo: hi');

  // Control: other JSON-RPC errors still throw (unknown method -> -32601).
  await assert.rejects(
    () => client.requestJsonRpc('bogus/method'),
    (err) => err.code === -32601,
    'a -32601 for a non-tools/call method must still throw McpError',
  );
});

/** Minimal streamable-HTTP MCP server: tools/call always answers -32602. */
function startFakeHttp32602() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      // Notification (no id): accept silently.
      if (msg.id === undefined || msg.id === null) {
        res.writeHead(202);
        res.end();
        return;
      }
      const send = (payload) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'test-69d',
        });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...payload }));
      };
      if (msg.method === 'initialize') {
        return send({
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'fake-http-69d', version: '0.1.0' },
          },
        });
      }
      if (msg.method === 'tools/list') {
        return send({
          result: {
            tools: [
              {
                name: 'echo',
                description: 'Echo back the input message',
                inputSchema: {
                  type: 'object',
                  properties: { message: { type: 'string' } },
                },
              },
            ],
          },
        });
      }
      if (msg.method === 'tools/call') {
        return send({
          error: {
            code: -32602,
            message: 'Invalid params: field "message" is required',
          },
        });
      }
      return send({ error: { code: -32601, message: `Method not found: ${msg.method}` } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const entry = { server, url: `http://127.0.0.1:${server.address().port}/mcp` };
      httpServers.push(entry);
      resolve(entry);
    });
  });
}

test('v0.69d SEP-1303 (HTTP): -32602 for tools/call returns isError instead of throwing', async () => {
  const { url } = await startFakeHttp32602();
  const client = await connectMcp({ name: 'fake-http', url });
  clients.push(client);

  const tools = await client.listTools();
  assert.equal(tools.length, 1, 'tools/list must still work');
  assert.equal(tools[0].name, 'echo');

  const text = await client.callTool('echo', {});
  assert.match(text, /^MCP tool error:/, 'callTool must return tool-error text, not throw');
  assert.match(text, /Invalid params: field "message" is required/);
  assert.match(text, /-32602/);

  const structured = await client.callToolStructured('echo', {});
  assert.equal(structured.isError, true);
  assert.match(structured.text, /Invalid params/);

  // Control: -32601 for a non-tools/call method still throws.
  await assert.rejects(
    () => client.requestJsonRpc('bogus/method'),
    (err) => err.code === -32601,
  );
});
