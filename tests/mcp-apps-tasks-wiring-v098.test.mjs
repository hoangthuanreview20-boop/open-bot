/**
 * MCP Apps/Tasks wiring tests (v0.98, sóng T6 — node:test, real stdio
 * fake MCP server, no live network).
 *
 * Covers the producer side in packages/tools/src/mcpTools.ts:
 *  - mcp_call_tool show-app: server returns a text/html resource block
 *    -> the app listener fires with the parsed app, and the tool result
 *    notes the opened app
 *  - mcp_call_tool echo (plain text): no app listener fire, no note
 *  - mcp_call_tool slow-echo asTask=true: returns a task handle text
 *    immediately; the per-workspace McpTaskManager tracks it to
 *    completed (via tasks/get + tasks/result on the fake server);
 *    listMcpTaskSnapshots / cancelMcpTask accessors work
 *  - asTask on a server without task support is a clear error, not a hang
 *
 * Imports the BUILT tools + core — build first:
 *   npm run build --workspace=@open-bot/core
 *   npm run build --workspace=@open-bot/tools
 * then: node --test tests/mcp-apps-tasks-wiring-v098.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  addMcpAppListener,
  addMcpTaskListener,
  cancelMcpTask,
  closeMcpClientPool,
  createMcpTools,
  listMcpTaskSnapshots,
} from '../packages/tools/dist/mcpTools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPS_SERVER = path.join(__dirname, 'fixtures', 'fake-mcp-server-apps-v098.mjs');
const PLAIN_SERVER = path.join(__dirname, 'fixtures', 'fake-mcp-server.mjs');

function makeWorkspace(serverFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-mcp-apps-test-'));
  fs.mkdirSync(path.join(dir, '.open-bot'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.open-bot', 'mcp.json'),
    JSON.stringify({ servers: { fake: { command: 'node', args: [serverFile] } } }),
    'utf8',
  );
  return dir;
}

const ctx = (dir) => ({ workspaceDir: dir, botId: 'test-bot' });
const toolByName = (tools, name) => tools.find((t) => t.definition.name === name);

test.after(async () => {
  await closeMcpClientPool();
});

test('wiring: mcp_call_tool show-app opens the app via listener + notes it in the result', async () => {
  const dir = makeWorkspace(APPS_SERVER);
  const apps = [];
  const off = addMcpAppListener((app) => apps.push(app));
  try {
    const tools = createMcpTools(dir);
    const callTool = toolByName(tools, 'mcp_call_tool');
    assert.ok(callTool, 'mcp_call_tool must exist');
    const result = await callTool.execute(
      { server: 'fake', tool: 'show-app', arguments: {} },
      ctx(dir),
    );
    assert.match(result, /Here is your card\./);
    assert.match(result, /Interactive app opened: /);
    assert.equal(apps.length, 1, 'exactly one app must be emitted');
    assert.equal(apps[0].serverName, 'fake');
    assert.equal(apps[0].toolName, 'show-app');
    assert.equal(apps[0].sourceUri, 'ui://fake/card');
    assert.match(apps[0].html, /Fake card/);
    assert.equal(apps[0].origin, 'tool-result');
  } finally {
    off();
  }
});

test('wiring: plain text tool result emits no app', async () => {
  const dir = makeWorkspace(APPS_SERVER);
  const apps = [];
  const off = addMcpAppListener((app) => apps.push(app));
  try {
    const tools = createMcpTools(dir);
    const callTool = toolByName(tools, 'mcp_call_tool');
    const result = await callTool.execute(
      { server: 'fake', tool: 'echo', arguments: { message: 'hi' } },
      ctx(dir),
    );
    assert.match(result, /Echo: hi/);
    assert.doesNotMatch(result, /Interactive app opened/);
    assert.equal(apps.length, 0);
  } finally {
    off();
  }
});

test('wiring: mcp_call_tool asTask tracks to completed in the workspace task manager', async () => {
  const dir = makeWorkspace(APPS_SERVER);
  const seenSnapshots = [];
  const off = addMcpTaskListener((tasks) => seenSnapshots.push(tasks));
  try {
    assert.deepEqual(listMcpTaskSnapshots(dir), [], 'no tasks before the call');
    const tools = createMcpTools(dir);
    const callTool = toolByName(tools, 'mcp_call_tool');
    // asTask is a new parameter on mcp_call_tool.
    assert.ok(
      callTool.definition.parameters.properties.asTask,
      'mcp_call_tool must declare asTask',
    );
    const result = await callTool.execute(
      { server: 'fake', tool: 'slow-echo', arguments: { message: 'hello' }, asTask: true, timeoutSeconds: 30 },
      ctx(dir),
    );
    assert.match(result, /MCP task started on "fake": task-slow-1/);
    assert.match(result, /MCP Tasks view/);
    // Poll the manager until the background loop completes the task.
    let snap;
    const deadline = Date.now() + 10000;
    for (;;) {
      const list = listMcpTaskSnapshots(dir);
      snap = list.find((s) => s.taskId === 'task-slow-1');
      if (snap && snap.status === 'completed') break;
      if (Date.now() > deadline) throw new Error(`task did not complete: ${JSON.stringify(snap)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(snap.serverName, 'fake');
    assert.equal(snap.label, 'slow-echo');
    assert.deepEqual(snap.result, { content: [{ type: 'text', text: 'Slow echo done' }] });
    assert.ok(seenSnapshots.length > 0, 'task listener must have fired on status changes');
    // Cancelling a terminal task returns its snapshot without error.
    const cancelled = await cancelMcpTask(dir, snap.key);
    assert.equal(cancelled.status, 'completed');
  } finally {
    off();
  }
});

test('wiring: asTask against a server without task support is a clear error', async () => {
  const dir = makeWorkspace(PLAIN_SERVER);
  const tools = createMcpTools(dir);
  const callTool = toolByName(tools, 'mcp_call_tool');
  const result = await callTool.execute(
    { server: 'fake', tool: 'echo', arguments: { message: 'hi' }, asTask: true },
    ctx(dir),
  );
  assert.match(result, /Error:/);
  assert.match(result, /task/i);
});
