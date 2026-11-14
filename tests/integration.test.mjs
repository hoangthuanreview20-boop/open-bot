/**
 * Integration tests (v0.2): the full tool composition the desktop app
 * wires into every AgentRunner — defaults + code + plan + subagent + MCP
 * through one ToolRegistry — plus a memory-backed plan tool round-trip.
 *
 * These tests import the compiled dist output; run `npm run build` first.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CODE_TOOLS,
  DaemonClient,
  PluginManager,
  ToolRegistry,
  createAccessTools,
  createAgentDataTools,
  createBrowserTools,
  createAgentTools,
  createCanvasTools,
  createCiTools,
  createComputerUseTools,
  createDefaultTools,
  createFileSearchTools,
  createGitWorkflowTools,
  createIntegrationTools,
  createLocalTools,
  createMcpSystemTools,
  createMcpTools,
  createPlanTools,
  createShellTools,
  createSubagentTools,
  createWebMediaTools,
} from '../packages/tools/dist/index.js';
import { BotMemory } from '../packages/core/dist/agent/memory.js';

const tmpDirs = [];
function tmpWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-int-'));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function buildFullRegistry(workspaceDir) {
  const memory = new BotMemory(workspaceDir);
  const registry = ToolRegistry.fromDefaults(createDefaultTools());
  registry.registerMany(CODE_TOOLS);
  registry.registerMany(createPlanTools(memory));
  registry.registerMany(createSubagentTools({}));
  registry.registerMany(createMcpTools(workspaceDir));
  // v0.6 groups (same composition defaultToolFactory wires in).
  registry.registerMany(createShellTools());
  registry.registerMany(createLocalTools());
  registry.registerMany(createComputerUseTools());
  registry.registerMany(createBrowserTools());
  // v0.97 (Team T6): git workflow + deep file search (same
  // composition defaultToolFactory wires in).
  registry.registerMany(createGitWorkflowTools());
  registry.registerMany(createFileSearchTools());
  registry.registerMany(createWebMediaTools());
  registry.registerMany(createCanvasTools());
  registry.registerMany(createAgentTools({ memory }));
  // v0.7 groups (same composition defaultToolFactory wires in).
  // v0.68b: the 8 git tools are NOT registered separately — they are
  // folded into createIntegrationTools (see coordinator.ts), so a
  // separate createGitTools call here would register git_host_connect
  // twice and the registry would throw.
  registry.registerMany(createCiTools({ workspaceDir }));
  registry.registerMany(createAgentDataTools({ memory, workspaceDir }));
  registry.registerMany(createIntegrationTools({ memory, workspaceDir }));
  registry.registerMany(createAccessTools());
  registry.registerMany(createMcpSystemTools({ workspaceDir }));
  return { registry, memory };
}

test('full registry: all v0.2 tool groups compose with unique names', () => {
  const workspaceDir = tmpWorkspace();
  const { registry, memory } = buildFullRegistry(workspaceDir);
  try {
    const names = registry.list().map((t) => t.definition.name);
    // 10 defaults + 8 code + 17 plan + 9 subagent + 5 MCP + 8 shell +
    // 4 local + 7 computer-use + 6 web-media + 3 canvas + 9 agent = 86;
    // v0.7: + 8 git + 4 CI + 2 agent-data + 20 integration + 4 MCP system + 1 supervisor = 122.
    // (v0.37 (P1-4): subagent 8 → 9 vì + list_subagent_roles.)
    // v0.41 (P0-3): + 1 tool_blob_fetch (defaults 10 → 11) + 1 cloud_agent_fetch_data
    // (agent-data 2 → 3) + 1 session_box_replace_env (integration 20 → 21) + 1 manage_access = 126.
    // v0.53: + 1 tool_call_replay (agent-data 3 → 4); v0.54: + 1 grind_pause = 128.
    // v0.85 (P2-3): + 1 conversation_history (agent 9 → 10) = 129.
    // v0.86 (P2-4): + 1 code_symbols (code 7 → 8) = 130.
    // v0.86b (P1-5): + 2 video_status + video_cancel (web-media 4 → 6) = 132.
    // v0.86a (P1-3): + 5 browser_navigate / browser_click / browser_type / browser_screenshot / browser_extract;
    // v0.97 (Team T6): + 3 browser_status / browser_reload / browser_wait_for (browser 5 → 8) = 140.
    // v0.86 (P2-10): + 1 shell_elevate (shell 8 → 9) = 141.
    // v0.90 (F4): + 14 data/http/text/office-write tools
    // (csv_parse/csv_filter/csv_aggregate/json_query/json_to_csv/
    // csv_to_json/http_request/text_extract/text_diff/
    // text_summarize_extract/markdown_toc/docx_write/markdown_to_docx/
    // xlsx_write; defaults 11 → 25) = 155.
    // v0.95 (Team D1): + 10 internet-data tools
    // (internet_search/web_fetch_clean/feed_subscribe/feed_list/
    // feed_read/feed_unsubscribe/watch_url/watch_list/watch_check/
    // watch_remove; defaults 25 → 35) = 165.
    // v0.97 (Team T6): + 5 git workflow (git_log/git_branch/git_branch_create/git_branch_delete/git_show)
    // + 1 search_files_deep = 171 (git_blame already existed in codeTools — extended with a line range, not duplicated).
    // v1.02 (rescue): + 12 context/durable/orchestra/gateway/dream/substrate/ACP tools
    // (context_measure_budget, context_prune_history, durable_list_resumable, durable_resume_state,
    // orchestra_run, orchestra_list_sessions, gateway_status, gateway_send, dream_run,
    // substrate_snapshot, substrate_list_snapshots, acp_detect_agents) = 183.
    // v0.68b: the 8 git tools moved INTO createIntegrationTools
    // (integration 21 → 29: 7 GitHub API tools + set_active_branch)
    // and are no longer registered separately, so the composed total
    // is UNCHANGED at 128 (8 removed as a group, 8 added via
    // integration). The git tools are still all present —
    // 'git_host_connect', 'pr_list', 'pr_create' and the rest come
    // via createIntegrationTools below.
    // (computer_local_tool is NOT in this registry — it lives in localBridge, exposed via the daemon path only.)
    assert.equal(names.length, 183, `expected 183 tools, got ${names.length}: ${names.join(', ')}`);
    assert.equal(new Set(names).size, names.length, 'duplicate tool names registered');
    for (const expected of [
      'read_file', 'web_search', // defaults
      'glob_files', 'grep_search', // code
      'x_search', 'image_generate', // web & media (v0.6)
      'canvas_write', // canvas (v0.6)
      'exec_task', 'shell_session_start', // shell (v0.6)
      'shell_elevate', // shell elevate (v0.86, P2-10)
      'system_info', // local (v0.6)
      'computer_screenshot', // computer-use (v0.6)
      'create_agent', 'grind_start', // agent-to-agent (v0.6)
      'plan_create', 'task_create', 'goal_create', 'todo_create', 'project_create', // plan
      'delegate_task', 'ask_user', 'await_condition', // subagent
      'mcp_list_tools', 'mcp_call_tool', // MCP
      'git_host_connect', 'pr_list', 'pr_create', // git via createIntegrationTools (v0.68b)
      'git_log', 'git_branch', 'git_show', // git workflow (v0.97; git_blame comes from code tools)
      'search_files_deep', // deep file search (v0.97)
      'browser_status', 'browser_reload', 'browser_wait_for', // browser ext (v0.97)
    ]) {
      assert.ok(registry.has(expected), `missing tool: ${expected}`);
    }
  } finally {
    memory.close();
  }
});

test('plan tools bound to memory: task_create + task_list round-trip', async () => {
  const workspaceDir = tmpWorkspace();
  const memory = new BotMemory(workspaceDir);
  try {
    const tools = createPlanTools(memory);
    const byName = new Map(tools.map((t) => [t.definition.name, t]));
    const ctx = { workspaceDir, botId: 'bot-1' };
    const created = await byName.get('task_create').execute({ title: 'Viết báo cáo' }, ctx);
    assert.match(created, /Viết báo cáo|task|created/i);
    const listed = await byName.get('task_list').execute({}, ctx);
    assert.match(listed, /Viết báo cáo/);
    const rows = memory.listTasks('bot-1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Viết báo cáo');
    assert.equal(rows[0].status, 'pending');
  } finally {
    memory.close();
  }
});

test('plugin tools join the registry; undeclared shell use rejects the whole plugin', () => {
  const workspaceDir = tmpWorkspace();
  const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'sample-plugin');

  // The fixture manifest declares only ["fs"] but its entry source uses
  // node:child_process — the loader is fail-closed at plugin level, so
  // the WHOLE plugin is rejected (not just the shell tool).
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-plugins-'));
  tmpDirs.push(badDir);
  fs.cpSync(fixture, path.join(badDir, 'sample-plugin'), { recursive: true });
  const badManager = new PluginManager(badDir);
  badManager.scanDir();
  assert.equal(badManager.loadErrors().length, 1, 'plugin with undeclared shell use must fail to load');
  const badRegistry = ToolRegistry.fromDefaults(createDefaultTools());
  for (const tool of badManager.toolsForRegistry()) {
    badRegistry.register(tool);
  }
  assert.ok(!badRegistry.has('sample_echo'), 'rejected plugin contributes no tools');
  assert.ok(!badRegistry.has('sample_shell'), 'shell tool without permission must be blocked');

  // Positive path: same plugin with "shell" declared in the manifest loads
  // both tools into the registry.
  const goodDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-plugins-'));
  tmpDirs.push(goodDir);
  const goodPluginDir = path.join(goodDir, 'sample-plugin');
  fs.cpSync(fixture, goodPluginDir, { recursive: true });
  const manifestPath = path.join(goodPluginDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.permissions = ['fs', 'shell'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const goodManager = new PluginManager(goodDir);
  goodManager.scanDir();
  assert.deepEqual(goodManager.loadErrors(), [], 'plugin with declared permissions should load cleanly');
  const goodRegistry = ToolRegistry.fromDefaults(createDefaultTools());
  for (const tool of goodManager.toolsForRegistry()) {
    goodRegistry.register(tool);
  }
  assert.ok(goodRegistry.has('sample_echo'), 'plugin tool sample_echo should be registered');
  assert.ok(goodRegistry.has('sample_shell'), 'shell tool with declared permission should be registered');
});

test('registry rejects a duplicate name when composing groups', () => {
  const workspaceDir = tmpWorkspace();
  const { registry, memory } = buildFullRegistry(workspaceDir);
  try {
    assert.throws(
      () => registry.register({ definition: { name: 'read_file', description: 'dup', parameters: { type: 'object', properties: {} } }, needsApproval: false, execute: async () => '' }),
      /already registered/,
    );
  } finally {
    memory.close();
  }
});

test('shell_exec via daemon: echo works, denylist blocks before daemon, env secrets do not leak, fallback without daemon', async () => {
  const workspaceDir = tmpWorkspace();
  // A secret-looking var in the PARENT env: the daemon child inherits it,
  // but the shell child must NOT see it (tool passes safeEnv() as a
  // full replacement env to the daemon).
  process.env.OPEN_BOT_TEST_SECRET = 'should-not-leak';
  const daemon = new DaemonClient();
  try {
    assert.equal((await daemon.ping()).pong, true);
    const tools = createDefaultTools({ getDaemon: () => daemon });
    const shell = tools.find((t) => t.definition.name === 'shell_exec');
    const ctx = { workspaceDir, botId: 'bot-1' };
    const out = await shell.execute({ command: 'echo hello-daemon' }, ctx);
    assert.match(out, /exit code: 0/);
    assert.match(out, /hello-daemon/);
    const leaked = await shell.execute({ command: 'echo "[$OPEN_BOT_TEST_SECRET]"' }, ctx);
    assert.match(leaked, /\[\]/);
    assert.doesNotMatch(leaked, /should-not-leak/);
    // Denylist fires in the tool BEFORE anything reaches the daemon.
    const blocked = await shell.execute({ command: 'rm -rf /' }, ctx);
    assert.match(blocked, /Error: .*blocked/i);
    // No daemon -> in-process runShell fallback, same output shape.
    const fallbackTools = createDefaultTools();
    const fallbackShell = fallbackTools.find((t) => t.definition.name === 'shell_exec');
    const out2 = await fallbackShell.execute({ command: 'echo hello-local' }, ctx);
    assert.match(out2, /exit code: 0/);
    assert.match(out2, /hello-local/);
  } finally {
    delete process.env.OPEN_BOT_TEST_SECRET;
    await daemon.dispose();
  }
});

test('shell_exec via daemon: AbortSignal kills the running command fast', async () => {
  const workspaceDir = tmpWorkspace();
  const daemon = new DaemonClient();
  try {
    await daemon.ping();
    const tools = createDefaultTools({ getDaemon: () => daemon });
    const shell = tools.find((t) => t.definition.name === 'shell_exec');
    const ac = new AbortController();
    const started = Date.now();
    const p = shell.execute(
      { command: 'sleep 30' },
      { workspaceDir, botId: 'bot-1', signal: ac.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    ac.abort();
    const out = await p;
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 10000, `abort should kill fast, took ${elapsed}ms`);
    assert.match(out, /exit code: null/);
  } finally {
    await daemon.dispose();
  }
});
