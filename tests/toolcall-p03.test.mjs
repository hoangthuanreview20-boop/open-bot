/**
 * Tests for P0-3 (v0.40, REA deep-dive lần 2 §3.3/§3.4):
 *  - session_box_replace_env (ReplaceEnvToolCall)
 *  - cloud_agent_fetch_data (FetchCloudAgentDataToolCall)
 *  - manage_access (ManageAccessToolCall — tool thật + guard chặt, xem accessTools.ts)
 *  - TruncatedToolCall kiểu Grok: blob store + tool_blob_fetch + tương thích ngược
 *  - hook_additional_contexts (PreToolUse hook inject context vào tool call)
 *  - started_at_ms / completed_at_ms cho mọi tool call (ToolResult + trace span)
 *
 * No real API key, no network (URL fetch uses an injected mock fetch;
 * a localhost URL is expected to be refused by the SSRF check).
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 *   xvfb-run -a node --test tests/toolcall-p03.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ACCESS_TOOLS,
  AGENT_DATA_TOOLS,
  INTEGRATION_TOOLS,
  TOOL_BLOB_TOOLS,
  createAccessTools,
  createAgentDataTools,
  createDefaultTools,
  createIntegrationTools,
  fetchToolResultBlob,
  storeToolResultBlob,
  truncateWithBlob,
} from '../packages/tools/dist/index.js';
import { BotMemory } from '../packages/core/dist/index.js';
import { AgentRunner } from '../packages/core/dist/agent/loop.js';
import {
  HookRegistry,
  HookRunner,
  modifyContextDecision,
} from '../packages/core/dist/hooks/index.js';
import { Tracer } from '../packages/core/dist/tracing/index.js';

const tempDirs = [];
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function ctx(workspaceDir, botId = 'bot-1') {
  return { workspaceDir, botId };
}

function toolByName(tools, name) {
  const tool = tools.find((t) => t.definition.name === name);
  assert.ok(tool, `missing tool: ${name}`);
  return tool;
}

function seedBot(memory, botId) {
  memory.saveBot({
    id: botId,
    name: 'Seed Bot',
    providerId: 'ollama',
    model: 'qwen2.5:0.5b',
    systemPrompt: 'You are a test bot.',
  });
  memory.saveMessage(botId, 'user', 'hello');
  memory.saveMessage(botId, 'assistant', 'hi there');
  const taskId = memory.createTask(botId, 'Write docs', 'docs');
  memory.updateTask(taskId, 'done');
  memory.createTask(botId, 'Review PR', '');
}

// ---------------------------------------------------------------------------
// Tool inventory: the 4 new tools exist where they belong
// ---------------------------------------------------------------------------

test('p03 inventory: 4 new tools registered (blob fetch + replace_env + cloud fetch + manage_access)', () => {
  assert.ok(toolByName(createDefaultTools(), 'tool_blob_fetch'));
  assert.ok(toolByName(INTEGRATION_TOOLS, 'session_box_replace_env'));
  assert.ok(toolByName(AGENT_DATA_TOOLS, 'cloud_agent_fetch_data'));
  assert.deepEqual(
    ACCESS_TOOLS.map((t) => t.definition.name),
    ['manage_access'],
  );
  assert.equal(toolByName(ACCESS_TOOLS, 'manage_access').needsApproval, true);
  assert.equal(toolByName(INTEGRATION_TOOLS, 'session_box_replace_env').needsApproval, true);
  assert.equal(toolByName(AGENT_DATA_TOOLS, 'cloud_agent_fetch_data').needsApproval, false);
  assert.equal(toolByName(TOOL_BLOB_TOOLS, 'tool_blob_fetch').needsApproval, false);
});

// ---------------------------------------------------------------------------
// session_box_replace_env
// ---------------------------------------------------------------------------

test('p03 session_box_replace_env: replace + merge + secret-name rejection + unknown session', async () => {
  const ws = makeTempDir('open-bot-p03-box-');
  const tools = createIntegrationTools();
  const created = await toolByName(tools, 'session_box_create').execute(
    { name: 'demo', env_vars: ['FOO', 'BAR'] },
    ctx(ws),
  );
  const sessionId = JSON.parse(created).id;
  assert.ok(sessionId);

  const replaced = await toolByName(tools, 'session_box_replace_env').execute(
    { session_id: sessionId, env_vars: ['BAZ'] },
    ctx(ws),
  );
  assert.deepEqual(JSON.parse(replaced).envAllowlist, ['BAZ']);
  // env.allowlist.json on disk matches (names only, no values).
  const allowlist = JSON.parse(
    fs.readFileSync(path.join(ws, '.open-bot', 'sessions', sessionId, 'env.allowlist.json'), 'utf8'),
  );
  assert.deepEqual(allowlist.allowedEnvVars, ['BAZ']);

  const merged = await toolByName(tools, 'session_box_replace_env').execute(
    { session_id: sessionId, env_vars: ['QUX', 'BAZ'], merge: true },
    ctx(ws),
  );
  assert.deepEqual(JSON.parse(merged).envAllowlist, ['BAZ', 'QUX']);

  const secret = await toolByName(tools, 'session_box_replace_env').execute(
    { session_id: sessionId, env_vars: ['MY_API_KEY'] },
    ctx(ws),
  );
  assert.match(secret, /^Error: .*looks like a secret/);
  // Failed replace leaves the allowlist untouched.
  const listed = await toolByName(tools, 'session_box_list').execute({}, ctx(ws));
  assert.match(listed, /demo/);

  const unknown = await toolByName(tools, 'session_box_replace_env').execute(
    { session_id: 'no-such-session', env_vars: ['FOO'] },
    ctx(ws),
  );
  assert.match(unknown, /^Error: Unknown session/);
});

// ---------------------------------------------------------------------------
// cloud_agent_fetch_data
// ---------------------------------------------------------------------------

test('p03 cloud_agent_fetch_data: local summary without writing a bundle file', async () => {
  const ws = makeTempDir('open-bot-p03-cloud-');
  const memory = new BotMemory(ws);
  try {
    seedBot(memory, 'bot-9');
    const tools = createAgentDataTools({ memory, workspaceDir: ws });
    const out = await toolByName(tools, 'cloud_agent_fetch_data').execute(
      { agent_id: 'bot-9' },
      ctx(ws, 'bot-9'),
    );
    const summary = JSON.parse(out);
    assert.equal(summary.agentId, 'bot-9');
    assert.equal(summary.source, 'local');
    assert.equal(summary.name, 'Seed Bot');
    assert.equal(summary.counts.history, 2);
    assert.equal(summary.counts.tasks, 2);
    assert.equal(summary.lastMessage.role, 'assistant');
    assert.match(summary.lastMessage.excerpt, /hi there/);
    // Local fetch reads only — no bundle file is written.
    assert.ok(!fs.existsSync(path.join(ws, '.open-bot', 'exports')));
  } finally {
    memory.close();
  }
});

test('p03 cloud_agent_fetch_data: url source validates checksum via mock fetch; SSRF refuses localhost', async () => {
  const ws = makeTempDir('open-bot-p03-cloud-url-');
  const memory = new BotMemory(ws);
  try {
    seedBot(memory, 'bot-9');
    const tools = createAgentDataTools({ memory, workspaceDir: ws });
    // Build a real bundle with agent_export, then serve its text via mock fetch.
    const exported = await toolByName(tools, 'agent_export').execute({}, ctx(ws, 'bot-9'));
    const bundleRel = exported.match(/exported to (\S+)\./)[1];
    const bundleText = fs.readFileSync(path.join(ws, bundleRel), 'utf8');
    const mockFetch = async () => ({ ok: true, status: 200, text: async () => bundleText });
    const toolsWithFetch = createAgentDataTools({ memory, workspaceDir: ws, fetchFn: mockFetch });
    const out = await toolByName(toolsWithFetch, 'cloud_agent_fetch_data').execute(
      { source: 'url', bundle_url: 'https://example.com/agent-bot-9.json' },
      ctx(ws, 'bot-9'),
    );
    const summary = JSON.parse(out);
    assert.equal(summary.source, 'url');
    assert.equal(summary.agentId, 'bot-9');
    assert.equal(summary.counts.history, 2);
    assert.match(summary.checksum, /^[0-9a-f]{16}…$/);

    // Tampered bundle (checksum mismatch) is refused by parseAgentBundleJson.
    const tampered = bundleText.replace('Seed Bot', 'Evil Bot');
    const mockTampered = async () => ({ ok: true, status: 200, text: async () => tampered });
    const toolsTampered = createAgentDataTools({ memory, workspaceDir: ws, fetchFn: mockTampered });
    const bad = await toolByName(toolsTampered, 'cloud_agent_fetch_data').execute(
      { source: 'url', bundle_url: 'https://example.com/agent-bot-9.json' },
      ctx(ws, 'bot-9'),
    );
    assert.match(bad, /^Error:/);

    // Localhost URL is refused by the SSRF check before any fetch.
    const ssrf = await toolByName(toolsWithFetch, 'cloud_agent_fetch_data').execute(
      { source: 'url', bundle_url: 'http://127.0.0.1:9/agent.json' },
      ctx(ws, 'bot-9'),
    );
    assert.match(ssrf, /^Error:/);

    // Unknown local bot + bad source are plain errors.
    const unknown = await toolByName(tools, 'cloud_agent_fetch_data').execute(
      { agent_id: 'no-such-bot' },
      ctx(ws, 'bot-9'),
    );
    assert.match(unknown, /^Error: Cannot export/);
    const badSource = await toolByName(tools, 'cloud_agent_fetch_data').execute(
      { source: 'cloud' },
      ctx(ws, 'bot-9'),
    );
    assert.match(badSource, /^Error: Argument "source"/);
  } finally {
    memory.close();
  }
});

// ---------------------------------------------------------------------------
// manage_access
// ---------------------------------------------------------------------------

function readAudit(ws) {
  const file = path.join(ws, '.open-bot', 'access-audit.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('p03 manage_access: no isAdmin -> mutations refused fail-closed + audited; list works', async () => {
  const ws = makeTempDir('open-bot-p03-access-');
  const tools = createAccessTools();
  const listed = await toolByName(tools, 'manage_access').execute({ action: 'list_members' }, ctx(ws));
  assert.match(listed, /no team members yet/);

  const refused = await toolByName(tools, 'manage_access').execute(
    { action: 'add_member', user_id: 'alice', name: 'Alice', role: 'admin' },
    ctx(ws),
  );
  assert.match(refused, /^Error: .*chưa được cấu hình kiểm tra quản trị/);
  // Denial is audited.
  const audit = readAudit(ws);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'add_member');
  assert.equal(audit[0].allowed, false);
  assert.equal(audit[0].actorBotId, 'bot-1');
  // Nothing was written to team.json by the refused call.
  const after = await toolByName(tools, 'manage_access').execute({ action: 'list_members' }, ctx(ws));
  assert.match(after, /no team members yet/);
});

test('p03 manage_access: admin flow — add/set_role/share/service accounts, last-admin guard, audit', async () => {
  const ws = makeTempDir('open-bot-p03-access-admin-');
  const tools = createAccessTools({ isAdmin: () => true });
  const run = (args) => toolByName(tools, 'manage_access').execute(args, ctx(ws));

  assert.match(await run({ action: 'add_member', user_id: 'alice', name: 'Alice', role: 'admin' }), /Added member "alice"/);
  assert.match(await run({ action: 'add_member', user_id: 'bob', name: 'Bob', role: 'member' }), /Added member "bob"/);
  const members = await run({ action: 'list_members' });
  assert.match(members, /alice — Alice \(admin\)/);
  assert.match(members, /bob — Bob \(member\)/);

  assert.match(await run({ action: 'set_role', user_id: 'bob', role: 'viewer' }), /now "viewer"/);
  assert.match(await run({ action: 'share_bot', bot_id: 'bot-9', shared_by: 'alice' }), /now shared/);

  // Last admin cannot be removed or demoted.
  assert.match(await run({ action: 'remove_member', user_id: 'alice' }), /^Error: .*last admin/);
  assert.match(await run({ action: 'set_role', user_id: 'alice', role: 'member' }), /^Error: .*last admin/);
  // A second admin makes removal possible.
  assert.match(await run({ action: 'add_member', user_id: 'carol', name: 'Carol', role: 'admin' }), /Added member/);
  assert.match(await run({ action: 'remove_member', user_id: 'alice' }), /Removed member "alice"/);

  // Service accounts: record only — the token is never in the output.
  const empty = await run({ action: 'list_service_accounts' });
  assert.match(empty, /no service accounts yet/);
  const created = await run({ action: 'create_service_account', name: 'CI nightly', scope: 'run' });
  assert.match(created, /Created service account "sa-[0-9a-f-]+"/);
  assert.match(created, /token is NOT here/);
  assert.doesNotMatch(created, /sk-|xai-|token: [A-Za-z0-9]/);
  const accountId = created.match(/"([^"]+)"/)[1];
  const listed = await run({ action: 'list_service_accounts' });
  assert.match(listed, new RegExp(accountId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(await run({ action: 'revoke_service_account', account_id: accountId }), /Revoked service account/);
  assert.match(
    await run({ action: 'revoke_service_account', account_id: accountId }),
    /^Error: Unknown service account/,
  );

  // Audit log holds one allowed entry per successful mutation (+ none for reads).
  const audit = readAudit(ws);
  assert.ok(audit.length >= 6, `expected >= 6 audit entries, got ${audit.length}`);
  assert.ok(audit.every((e) => e.allowed === true));
  assert.ok(audit.some((e) => e.action === 'add_member' && e.target === 'alice'));
  assert.ok(audit.some((e) => e.action === 'revoke_service_account'));

  // Unknown action / role / scope are plain errors.
  assert.match(await run({ action: 'explode' }), /^Error: Unknown action/);
  assert.match(
    await run({ action: 'add_member', user_id: 'mallory', name: 'Mallory', role: 'superuser' }),
    /^Error: Invalid role/,
  );
});

// ---------------------------------------------------------------------------
// Blob store (TruncatedToolCall)
// ---------------------------------------------------------------------------

test('p03 blob store: store/fetch/pagination, footer carries blob_id + original_size_bytes', () => {
  const ws = makeTempDir('open-bot-p03-blob-');
  const text = Array.from({ length: 25_000 }, (_, i) => String((i % 10))).join('');
  assert.equal(text.length, 25_000);

  // Short text: unchanged, no blob created.
  assert.equal(truncateWithBlob('hello', ws), 'hello');
  assert.ok(!fs.existsSync(path.join(ws, '.open-bot', 'tool-blobs')));

  const preview = truncateWithBlob(text, ws);
  assert.ok(preview.startsWith(text.slice(0, 20_000)));
  assert.match(preview, /truncated to 20000 chars of 25000 chars/);
  assert.match(preview, /original_size_bytes: 25000/);
  const blobId = preview.match(/blob_id: (blob-[A-Za-z0-9_-]+)/)[1];
  const blobFiles = fs.readdirSync(path.join(ws, '.open-bot', 'tool-blobs'));
  assert.equal(blobFiles.length, 1);

  // Pagination: page 2 (offset 20000) returns the tail; offset 0 returns the head.
  const tail = fetchToolResultBlob(ws, blobId, 20_000, 5_000);
  assert.equal(tail.content, text.slice(20_000, 25_000));
  assert.equal(tail.offset, 20_000);
  assert.equal(tail.length, 5_000);
  assert.equal(tail.totalChars, 25_000);
  assert.equal(tail.totalBytes, 25_000);
  assert.equal(tail.hasMore, false);
  const head = fetchToolResultBlob(ws, blobId, 0, 100);
  assert.equal(head.content, text.slice(0, 100));
  assert.equal(head.hasMore, true);
  // Offset past the end clamps to an empty page.
  const past = fetchToolResultBlob(ws, blobId, 99_999, 100);
  assert.equal(past.content, '');
  assert.equal(past.hasMore, false);

  assert.throws(() => fetchToolResultBlob(ws, 'blob-does-not-exist', 0, 100), /Unknown blob_id/);
  assert.throws(() => fetchToolResultBlob(ws, '../escape', 0, 100), /Invalid blob_id/);
  assert.throws(() => fetchToolResultBlob(ws, 'blob-a/b', 0, 100), /Invalid blob_id/);
});

test('p03 blob store: back-compat — no workspaceDir means old hard truncation, no blob', () => {
  const text = 'x'.repeat(25_000);
  const out = truncateWithBlob(text);
  assert.equal(out, `${'x'.repeat(20_000)}\n[... truncated to 20000 chars ...]`);
  assert.doesNotMatch(out, /blob_id/);
});

test('p03 blob store: prune keeps at most 50 blobs per workspace', () => {
  const ws = makeTempDir('open-bot-p03-blob-prune-');
  for (let i = 0; i < 55; i++) {
    const stored = storeToolResultBlob(ws, `blob number ${i}`);
    assert.ok(stored);
  }
  const files = fs.readdirSync(path.join(ws, '.open-bot', 'tool-blobs'));
  assert.ok(files.length <= 50, `expected <= 50 blobs, got ${files.length}`);
});

test('p03 tool_blob_fetch tool + read_file wiring: long file returns preview with blob_id, fetch returns the rest', async () => {
  const ws = makeTempDir('open-bot-p03-blob-tool-');
  const text = `line-${'y'.repeat(24_000)}-end`;
  fs.writeFileSync(path.join(ws, 'big.txt'), text, 'utf8');
  const tools = createDefaultTools();
  const out = await toolByName(tools, 'read_file').execute({ path: 'big.txt' }, ctx(ws));
  assert.match(out, /truncated to 20000 chars/);
  const blobId = out.match(/blob_id: (blob-[A-Za-z0-9_-]+)/)[1];
  assert.ok(blobId);

  const page = await toolByName(tools, 'tool_blob_fetch').execute(
    { blob_id: blobId, offset: 20_000, length: 10_000 },
    ctx(ws),
  );
  assert.match(page, /chars 20000\.\./);
  assert.ok(page.includes(text.slice(20_000)), 'fetched page must contain the file tail');
  assert.match(page, /end of blob/);

  const unknown = await toolByName(tools, 'tool_blob_fetch').execute(
    { blob_id: 'blob-nope', offset: 0 },
    ctx(ws),
  );
  assert.match(unknown, /^Error: Unknown blob_id/);
});

// ---------------------------------------------------------------------------
// hook_additional_contexts
// ---------------------------------------------------------------------------

test('p03 hook_additional_contexts: PreToolUse hooks inject context in order; block keeps earlier contexts', async () => {
  const registry = new HookRegistry({ stateDir: makeTempDir('open-bot-p03-hook-') });
  registry.register({
    name: 'ctx-first',
    events: ['PreToolUse'],
    source: 'builtin',
    enabled: true,
    handler: () => modifyContextDecision('CTX-A: workspace rules apply.'),
  });
  registry.register({
    name: 'ctx-second',
    events: ['PreToolUse'],
    source: 'builtin',
    enabled: true,
    handler: () => ({ action: 'modify', args: { path: 'b.txt' }, context: 'CTX-B: prefer b.txt.' }),
  });
  const runner = new HookRunner(registry);
  const outcome = await runner.runPreToolUse(
    { toolName: 'read_file', toolCallId: 'call-1', args: { path: 'a.txt' } },
    { botId: 'bot-1', workspaceDir: '/tmp' },
  );
  assert.equal(outcome.decision, 'modify');
  assert.deepEqual(outcome.args, { path: 'b.txt' });
  assert.deepEqual(outcome.additionalContexts, [
    'CTX-A: workspace rules apply.',
    'CTX-B: prefer b.txt.',
  ]);

  // A blocking hook after a context hook: contexts collected before the block are kept.
  const registry2 = new HookRegistry({ stateDir: makeTempDir('open-bot-p03-hook-') });
  registry2.register({
    name: 'ctx-then-block',
    events: ['PreToolUse'],
    source: 'builtin',
    enabled: true,
    handler: () => modifyContextDecision('CTX: seen before block.'),
  });
  registry2.register({
    name: 'blocker',
    events: ['PreToolUse'],
    source: 'builtin',
    enabled: true,
    handler: () => ({ action: 'block', reason: 'nope' }),
  });
  const blocked = await new HookRunner(registry2).runPreToolUse(
    { toolName: 'read_file', toolCallId: 'call-2', args: {} },
    {},
  );
  assert.equal(blocked.decision, 'block');
  assert.deepEqual(blocked.additionalContexts, ['CTX: seen before block.']);
});

// ---------------------------------------------------------------------------
// started_at_ms / completed_at_ms + hook contexts through the loop
// ---------------------------------------------------------------------------

test('p03 loop: tool call carries started_at_ms/completed_at_ms + hook contexts (ToolResult + trace span)', async () => {
  const ws = makeTempDir('open-bot-p03-loop-');
  let callSeq = 0;
  const capturedCtx = [];
  const echoTool = {
    definition: {
      name: 'echo_ctx',
      description: 'Test tool capturing its ToolContext.',
      parameters: { type: 'object', properties: {} },
    },
    needsApproval: false,
    async execute(_args, toolCtx) {
      capturedCtx.push(toolCtx.additionalContexts);
      return 'echo-ok';
    },
  };
  const provider = {
    id: 'mock',
    label: 'Mock',
    async chat() {
      callSeq++;
      if (callSeq === 1) {
        return { text: '', toolCalls: [{ id: 'call-1', name: 'echo_ctx', args: {} }] };
      }
      return { text: 'xong', toolCalls: [] };
    },
    async listModels() {
      return ['mock'];
    },
  };
  const registry = new HookRegistry({ stateDir: makeTempDir('open-bot-p03-hook-') });
  registry.register({
    name: 'inject-rule',
    events: ['PreToolUse'],
    source: 'builtin',
    enabled: true,
    handler: () => modifyContextDecision('RULE: no writes in this turn.'),
  });
  const hooks = new HookRunner(registry);
  const events = {
    texts: [],
    toolCalls: [],
    toolResults: [],
    onText(d) {
      events.texts.push(d);
    },
    onToolCall(c) {
      events.toolCalls.push(c);
    },
    onToolResult(r) {
      events.toolResults.push(r);
    },
    onApprovalNeeded: async () => true,
  };
  const tracer = new Tracer({ runId: 'run-p03', botId: 'bot-1' });
  const runner = new AgentRunner(provider, [echoTool], {
    bot: {
      id: 'bot-1',
      name: 'Test',
      providerId: 'mock',
      model: 'mock',
      systemPrompt: 'You are a test bot.',
      workspaceDir: ws,
      autoApprove: true,
    },
    events,
    hooks,
    tracer,
  });
  const result = await runner.run('test');
  assert.equal(result, 'xong');

  // The tool saw the hook-injected context via ToolContext.
  assert.deepEqual(capturedCtx, [['RULE: no writes in this turn.']]);

  // The ToolResult carries real timing + the injected contexts.
  assert.equal(events.toolResults.length, 1);
  const toolResult = events.toolResults[0];
  assert.equal(typeof toolResult.startedAtMs, 'number');
  assert.equal(typeof toolResult.completedAtMs, 'number');
  assert.ok(toolResult.completedAtMs >= toolResult.startedAtMs, 'completed_at_ms >= started_at_ms');
  assert.deepEqual(toolResult.hookAdditionalContexts, ['RULE: no writes in this turn.']);

  // The trace span carries the same marks as attributes + real duration.
  const toolSpan = tracer.spans.find((s) => s.kind === 'tool' && s.name === 'echo_ctx');
  assert.ok(toolSpan, 'tool span recorded');
  assert.equal(toolSpan.attributes['started_at_ms'], toolResult.startedAtMs);
  assert.equal(toolSpan.attributes['completed_at_ms'], toolResult.completedAtMs);
  assert.equal(toolSpan.attributes['hookAdditionalContexts'], 1);
  assert.ok(typeof toolSpan.durationMs === 'number' && toolSpan.durationMs >= 0);
  assert.ok(toolSpan.startedAt <= (toolSpan.endedAt ?? Number.MAX_SAFE_INTEGER));
});
