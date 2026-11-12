/**
 * Tests for P1-7 (v0.53, REA deep-dive lần 2 §3.3 + §2.5):
 *   - tool-call replay (`tool_call_replay` by tool_call_id / tool_name /
 *     args_json) + history recording by the agent loop
 *   - computer-local bridge (`computer_local_tool`: tool_id / input_json /
 *     approval_id / conversation_id / image_uploads) + daemon phone-tool
 *     allowlist
 *
 * No real API key, no network, no phone. run-command goes through the
 * real local-exec-daemon (echo only). All secrets are fake.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 *   xvfb-run -a node --test tests/toolcall-replay-localbridge-p17.test.mjs
 */
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AGENT_DATA_TOOLS,
  LOCAL_BRIDGE_TOOLS,
  ToolCallHistoryStore,
  DaemonClient,
  PHONE_TOOL_IDS,
  assertPhoneToolAllowed,
  createAgentDataTools,
  createLocalBridgeTools,
} from '../packages/tools/dist/index.js';
import { AgentRunner } from '../packages/core/dist/agent/loop.js';

const tempDirs = [];
function makeTempDir(prefix = 'open-bot-p17-') {
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
  assert.ok(tool, `tool "${name}" must exist`);
  return tool;
}

function makeStubTool(name, opts = {}) {
  return {
    definition: {
      name,
      description: opts.description ?? `Stub tool ${name} for testing.`,
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
    },
    needsApproval: opts.needsApproval ?? false,
    async execute(args) {
      if (opts.throwMessage) throw new Error(opts.throwMessage);
      return opts.output ?? `stub:${name}:${JSON.stringify(args)}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Tool-call history store
// ---------------------------------------------------------------------------

test('P1-7 history: record / findById / listRecent / count round-trip', () => {
  const ws = makeTempDir();
  const store = new ToolCallHistoryStore(ws);
  assert.equal(store.count(), 0);
  assert.equal(store.findById('nope'), null);
  store.record({
    tool_call_id: 'call-1',
    tool_name: 'echo_tool',
    args_json: JSON.stringify({ text: 'hi' }),
    started_at_ms: 1000,
    completed_at_ms: 1010,
    status: 'ok',
    result_preview: 'hi',
  });
  store.record({
    tool_call_id: 'call-2',
    tool_name: 'echo_tool',
    args_json: JSON.stringify({ text: 'yo' }),
    status: 'error',
  });
  assert.equal(store.count(), 2);
  const found = store.findById('call-1');
  assert.equal(found.tool_name, 'echo_tool');
  assert.equal(JSON.parse(found.args_json).text, 'hi');
  assert.equal(found.started_at_ms, 1000);
  assert.equal(found.completed_at_ms, 1010);
  assert.equal(found.status, 'ok');
  const recent = store.listRecent(1);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].tool_call_id, 'call-2', 'newest first');
  assert.ok(fs.existsSync(path.join(ws, '.open-bot', 'tool-calls.jsonl')));
});

test('P1-7 history: file is capped at 1000 records (oldest dropped)', () => {
  const ws = makeTempDir();
  const store = new ToolCallHistoryStore(ws);
  for (let i = 0; i < 1005; i += 1) {
    store.record({
      tool_call_id: `call-${i}`,
      tool_name: 'echo_tool',
      args_json: '{}',
    });
  }
  assert.equal(store.count(), 1000);
  assert.equal(store.findById('call-0'), null, 'oldest must be dropped');
  assert.ok(store.findById('call-1004') !== null, 'newest must survive');
});

// ---------------------------------------------------------------------------
// tool_call_replay
// ---------------------------------------------------------------------------

function replaySetup() {
  const ws = makeTempDir();
  const history = new ToolCallHistoryStore(ws);
  const echoTool = makeStubTool('echo_tool');
  const failTool = makeStubTool('fail_tool', { throwMessage: 'boom' });
  const tools = [echoTool, failTool];
  const replayTools = createAgentDataTools({
    workspaceDir: ws,
    history,
    getTools: () => [...tools, ...AGENT_DATA_TOOLS],
  });
  return { ws, history, echoTool, failTool, replay: toolByName(replayTools, 'tool_call_replay') };
}

test('P1-7 replay: replays a recorded call with its recorded args', async () => {
  const { ws, history, replay } = replaySetup();
  history.record({
    tool_call_id: 'call-abc',
    tool_name: 'echo_tool',
    args_json: JSON.stringify({ text: 'hello' }),
    started_at_ms: 1,
    completed_at_ms: 2,
    status: 'ok',
  });
  const out = await replay.execute({ tool_call_id: 'call-abc' }, ctx(ws));
  assert.match(out, /Replayed "echo_tool"/);
  assert.match(out, /original tool_call_id call-abc/);
  assert.match(out, /stub:echo_tool:\{"text":"hello"\}/);
  // The replay itself is recorded as a new entry.
  assert.equal(history.count(), 2);
  assert.equal(history.listRecent(1)[0].tool_name, 'tool_call_replay');
});

test('P1-7 replay: tool_name must match; args_json overrides recorded args', async () => {
  const { ws, history, replay } = replaySetup();
  history.record({
    tool_call_id: 'call-xyz',
    tool_name: 'echo_tool',
    args_json: JSON.stringify({ text: 'original' }),
  });
  const mismatch = await replay.execute(
    { tool_call_id: 'call-xyz', tool_name: 'fail_tool' },
    ctx(ws),
  );
  assert.match(mismatch, /Error: tool_name mismatch/);
  const overridden = await replay.execute(
    { tool_call_id: 'call-xyz', args_json: JSON.stringify({ text: 'overridden' }) },
    ctx(ws),
  );
  assert.match(overridden, /"text":"overridden"/);
  assert.doesNotMatch(overridden, /"text":"original"/);
});

test('P1-7 replay: unknown id, bad args_json, self-replay and missing target are refused', async () => {
  const { ws, history, replay } = replaySetup();
  assert.match(
    await replay.execute({ tool_call_id: 'no-such-call' }, ctx(ws)),
    /Error: No recorded tool call/,
  );
  history.record({
    tool_call_id: 'call-bad-args',
    tool_name: 'echo_tool',
    args_json: JSON.stringify({ text: 'ok' }),
  });
  assert.match(
    await replay.execute({ tool_call_id: 'call-bad-args', args_json: 'not json' }, ctx(ws)),
    /Error: Argument "args_json" must be valid JSON/,
  );
  assert.match(
    await replay.execute({ tool_call_id: 'call-bad-args', args_json: '["array"]' }, ctx(ws)),
    /Error: Argument "args_json" must be a JSON object/,
  );
  // Self-replay: a recorded tool_call_replay entry cannot be replayed.
  history.record({
    tool_call_id: 'call-self',
    tool_name: 'tool_call_replay',
    args_json: JSON.stringify({ tool_call_id: 'call-abc' }),
  });
  assert.match(
    await replay.execute({ tool_call_id: 'call-self' }, ctx(ws)),
    /Error: Refusing to replay tool_call_replay itself/,
  );
  // Target not in the registry: history knows it, getTools does not.
  const noTools = createAgentDataTools({
    workspaceDir: ws,
    history,
    getTools: () => [],
  });
  const replayNoTools = toolByName(noTools, 'tool_call_replay');
  assert.match(
    await replayNoTools.execute({ tool_call_id: 'call-bad-args' }, ctx(ws)),
    /Error: Tool "echo_tool" is not in this bot's registry/,
  );
});

test('P1-7 replay: a failing target still records status error and reports it', async () => {
  const { ws, history, replay } = replaySetup();
  history.record({
    tool_call_id: 'call-fail',
    tool_name: 'fail_tool',
    args_json: '{}',
  });
  const out = await replay.execute({ tool_call_id: 'call-fail' }, ctx(ws));
  assert.match(out, /error/);
  assert.match(out, /boom/);
  assert.equal(history.listRecent(1)[0].status, 'error');
});

test('P1-7 replay: needsApproval is true (replay can re-run writes)', () => {
  const { replay } = replaySetup();
  assert.equal(replay.needsApproval, true);
});

// ---------------------------------------------------------------------------
// Loop records every call into the history (AgentRunner + mock provider)
// ---------------------------------------------------------------------------

function scriptedProvider(responses) {
  let i = 0;
  return {
    id: 'mock',
    label: 'Mock',
    async chat() {
      return responses[Math.min(i++, responses.length - 1)];
    },
    async listModels() {
      return ['mock'];
    },
  };
}

function makeEvents() {
  return {
    onText: () => undefined,
    onToolCall: () => undefined,
    onToolResult: () => undefined,
    onApprovalNeeded: async () => true,
  };
}

test('P1-7 loop: AgentRunner records each tool call (replay triple + timings)', async () => {
  const ws = makeTempDir();
  const history = new ToolCallHistoryStore(ws);
  const echoTool = makeStubTool('echo_tool');
  const provider = scriptedProvider([
    { text: '', toolCalls: [{ id: 'call-rec-1', name: 'echo_tool', args: { text: 'hello' } }] },
    { text: 'done', toolCalls: [] },
  ]);
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
    events: makeEvents(),
    toolCallRecorder: history,
  });
  const result = await runner.run('say hello');
  assert.equal(result, 'done');
  const record = history.findById('call-rec-1');
  assert.ok(record, 'the loop must have recorded the call');
  assert.equal(record.tool_name, 'echo_tool');
  assert.deepEqual(JSON.parse(record.args_json), { text: 'hello' });
  assert.equal(record.status, 'ok');
  assert.ok(typeof record.started_at_ms === 'number');
  assert.ok(typeof record.completed_at_ms === 'number');
  assert.ok((record.completed_at_ms ?? 0) >= (record.started_at_ms ?? 0));
  assert.match(record.result_preview ?? '', /hello/);
});

// ---------------------------------------------------------------------------
// Daemon phone-tool allowlist
// ---------------------------------------------------------------------------

test('P1-7 allowlist: the 11 Grok §2.5 tools are allowed, anything else is refused', () => {
  assert.deepEqual([...PHONE_TOOL_IDS], [
    'run-command',
    'send-input',
    'read-file',
    'list-directory',
    'write-file',
    'read-ai-tool-setup',
    'read-messages',
    'send-imessage',
    'run-phone-tool',
    'use-app',
    'send-mail',
  ]);
  for (const id of PHONE_TOOL_IDS) assertPhoneToolAllowed(id);
  assert.throws(() => assertPhoneToolAllowed('rm-rf'), /not on the daemon phone-tool allowlist/);
  assert.throws(() => assertPhoneToolAllowed(''), /needs a tool_id/);
});

// ---------------------------------------------------------------------------
// computer_local_tool bridge
// ---------------------------------------------------------------------------

function bridgeSetup(opts = {}) {
  const ws = makeTempDir();
  const tools = createLocalBridgeTools({ workspaceDir: ws, ...opts });
  return { ws, bridge: toolByName(tools, 'computer_local_tool') };
}

async function runBridge(bridge, ws, args) {
  const out = await bridge.execute(args, ctx(ws));
  return out;
}

test('P1-7 bridge: unknown tool_id is refused before any dispatch', async () => {
  const { ws, bridge } = bridgeSetup();
  const out = await runBridge(bridge, ws, {
    tool_id: 'format-disk',
    input_json: '{}',
  });
  assert.match(out, /Error: Unknown local tool "format-disk"/);
  assert.match(out, /not on the daemon phone-tool allowlist/);
});

test('P1-7 bridge: read-file / list-directory / write-file round-trip inside the workspace', async () => {
  const { ws, bridge } = bridgeSetup();
  const written = await runBridge(bridge, ws, {
    tool_id: 'write-file',
    input_json: JSON.stringify({ path: 'sub/note.txt', content: 'hello bridge' }),
    conversation_id: 'conv-1',
  });
  const writtenJson = JSON.parse(written);
  assert.equal(writtenJson.ok, true);
  assert.equal(writtenJson.tool_id, 'write-file');
  assert.equal(writtenJson.conversation_id, 'conv-1');
  const read = await runBridge(bridge, ws, {
    tool_id: 'read-file',
    input_json: JSON.stringify({ path: 'sub/note.txt' }),
  });
  assert.match(read, /hello bridge/);
  const listed = await runBridge(bridge, ws, {
    tool_id: 'list-directory',
    input_json: JSON.stringify({ path: 'sub' }),
  });
  assert.match(listed, /note\.txt/);
  // Path escape is refused.
  const escaped = await runBridge(bridge, ws, {
    tool_id: 'read-file',
    input_json: JSON.stringify({ path: '../outside.txt' }),
  });
  assert.match(escaped, /Error:/);
});

test('P1-7 bridge: run-command goes through the real daemon (echo)', async () => {
  const ws = makeTempDir();
  const client = new DaemonClient();
  try {
    const tools = createLocalBridgeTools({
      workspaceDir: ws,
      getDaemon: () => client,
    });
    const bridge = toolByName(tools, 'computer_local_tool');
    const out = await bridge.execute(
      {
        tool_id: 'run-command',
        input_json: JSON.stringify({ command: 'echo', args: ['hello-daemon'] }),
      },
      ctx(ws),
    );
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.tool_id, 'run-command');
    const result = JSON.parse(parsed.result);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'hello-daemon\n');
  } finally {
    await client.dispose();
  }
});

test('P1-7 bridge: run-command / send-input without a daemon fail closed', async () => {
  const { ws, bridge } = bridgeSetup();
  const out = await runBridge(bridge, ws, {
    tool_id: 'run-command',
    input_json: JSON.stringify({ command: 'echo', args: ['hi'] }),
  });
  assert.match(out, /daemon-unavailable/);
  const out2 = await runBridge(bridge, ws, {
    tool_id: 'send-input',
    input_json: JSON.stringify({ sessionId: 's1', input: 'hi' }),
  });
  assert.match(out2, /daemon-unavailable/);
});

test('P1-7 bridge: phone tools answer unavailable (no phone paired), unless a handler is wired', async () => {
  const { ws, bridge } = bridgeSetup();
  const imessage = await runBridge(bridge, ws, {
    tool_id: 'send-imessage',
    input_json: JSON.stringify({ to: '+84123456789', body: 'hi' }),
  });
  const imessageJson = JSON.parse(imessage);
  assert.equal(imessageJson.ok, false);
  assert.equal(imessageJson.reason, 'phone-not-connected');
  assert.match(imessageJson.result, /No phone is paired/);

  const withHandler = createLocalBridgeTools({
    workspaceDir: ws,
    handlers: {
      'send-mail': async (input) => ({ ok: true, result: `sent to ${input['to']}` }),
    },
  });
  const mailBridge = toolByName(withHandler, 'computer_local_tool');
  const mail = await runBridge(mailBridge, ws, {
    tool_id: 'send-mail',
    input_json: JSON.stringify({ to: 'a@b.c', subject: 'hi', body: 'hello' }),
  });
  assert.match(mail, /sent to a@b\.c/);
});

test('P1-7 bridge: image_uploads are validated (exists, size) and bad ones refused', async () => {
  const { ws, bridge } = bridgeSetup();
  fs.writeFileSync(path.join(ws, 'pic.png'), Buffer.alloc(123, 7));
  const out = await runBridge(bridge, ws, {
    tool_id: 'read-ai-tool-setup',
    input_json: '{}',
    image_uploads: ['pic.png'],
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.image_uploads[0].path, 'pic.png');
  assert.equal(parsed.image_uploads[0].exists, true);
  assert.equal(parsed.image_uploads[0].sizeBytes, 123);
  const missing = await runBridge(bridge, ws, {
    tool_id: 'read-ai-tool-setup',
    input_json: '{}',
    image_uploads: ['nope.png'],
  });
  assert.match(missing, /Error: image_upload "nope\.png" does not exist/);
  const escaped = await runBridge(bridge, ws, {
    tool_id: 'read-ai-tool-setup',
    input_json: '{}',
    image_uploads: ['../outside.png'],
  });
  assert.match(escaped, /Error:/);
});

test('P1-7 bridge: approval_id is verified when a verifier is provided', async () => {
  const { ws } = bridgeSetup();
  const denying = createLocalBridgeTools({
    workspaceDir: ws,
    verifyApproval: () => false,
  });
  const denyingBridge = toolByName(denying, 'computer_local_tool');
  const denied = await runBridge(denyingBridge, ws, {
    tool_id: 'read-file',
    input_json: JSON.stringify({ path: 'x.txt' }),
    approval_id: 'appr-1',
  });
  assert.match(denied, /Error: approval_id "appr-1" did not verify/);
  fs.writeFileSync(path.join(ws, 'x.txt'), 'x-content');
  const allowing = createLocalBridgeTools({
    workspaceDir: ws,
    verifyApproval: (id) => id === 'appr-1',
  });
  const allowingBridge = toolByName(allowing, 'computer_local_tool');
  const allowed = await runBridge(allowingBridge, ws, {
    tool_id: 'read-file',
    input_json: JSON.stringify({ path: 'x.txt' }),
    approval_id: 'appr-1',
  });
  const allowedJson = JSON.parse(allowed);
  assert.equal(allowedJson.ok, true);
  assert.equal(allowedJson.approval_verified, true);
  assert.match(allowedJson.result, /x-content/);
});

test('P1-7 bridge: read-ai-tool-setup lists the allowlist; input_json must be an object', async () => {
  const { ws, bridge } = bridgeSetup();
  const out = await runBridge(bridge, ws, { tool_id: 'read-ai-tool-setup', input_json: '{}' });
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  const setup = JSON.parse(parsed.result);
  assert.deepEqual(setup.allowedTools, [...PHONE_TOOL_IDS]);
  assert.equal(setup.phoneConnected, false);
  const bad = await runBridge(bridge, ws, { tool_id: 'read-file', input_json: 'not json' });
  assert.match(bad, /Error: Argument "input_json" must be valid JSON/);
  const arr = await runBridge(bridge, ws, { tool_id: 'read-file', input_json: '[]' });
  assert.match(arr, /Error: Argument "input_json" must be a JSON object/);
});

test('P1-7 bridge: placeholders exist and needsApproval is true', () => {
  assert.equal(LOCAL_BRIDGE_TOOLS.length, 1);
  assert.equal(LOCAL_BRIDGE_TOOLS[0].definition.name, 'computer_local_tool');
  assert.equal(LOCAL_BRIDGE_TOOLS[0].needsApproval, true);
  assert.equal(AGENT_DATA_TOOLS.some((t) => t.definition.name === 'tool_call_replay'), true);
});
