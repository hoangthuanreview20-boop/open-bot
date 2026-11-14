/**
 * Tests for the v1.01 loop wiring (packages/core/src/agent/loop.ts):
 * UserPromptSubmit / SubagentStart / SubagentStop / PreCompact /
 * PostCompact hooks in a real `AgentRunner` with a scripted mock
 * provider. No real API key, no network.
 *
 * Under test:
 * - UserPromptSubmit block → turn refused, provider never called.
 * - UserPromptSubmit modify → hook context prepended to the prompt.
 * - SubagentStart block → no child spawned, spawn tool reports it.
 * - SubagentStop block → child runs once more with the gate context;
 *   the retry's output is what the parent sees.
 * - SubagentStop block with 0 retries → gate context attached to the
 *   returned summary for the lead agent.
 * - PreCompact block → compaction skipped, history stays long.
 * - PostCompact block → compaction reverted, history stays long.
 * - No hooks → compaction runs and the summary reaches the model.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 *   node --test tests/hooks-loop-v101.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AgentRunner } from '../packages/core/dist/agent/loop.js';
import {
  allowDecision,
  blockDecision,
  blockStopDecision,
  HookRegistry,
  HookRunner,
  modifyContextDecision,
} from '../packages/core/dist/hooks/index.js';

const tempDirs = [];
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

let callSeq = 0;
function scriptedProvider(responses, seenRequests = []) {
  let i = 0;
  return {
    id: 'mock',
    label: 'Mock',
    async chat(req) {
      seenRequests.push(req);
      const r = responses[Math.min(i++, responses.length - 1)];
      return { text: r.text ?? '', toolCalls: r.toolCalls ?? [] };
    },
    async listModels() {
      return ['mock'];
    },
  };
}

function makeEvents() {
  const events = { texts: [], toolCalls: [], toolResults: [] };
  events.onText = (d) => events.texts.push(d);
  events.onToolCall = (c) => events.toolCalls.push(c);
  events.onToolResult = (r) => events.toolResults.push(r);
  events.onApprovalNeeded = async () => true;
  return events;
}

function makeBot(workspaceDir) {
  return {
    id: 'bot-1',
    name: 'Test',
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir,
    autoApprove: true,
  };
}

function makeTool(name, execute, opts = {}) {
  return {
    definition: {
      name,
      description: `Tool ${name} for testing.`,
      parameters: { type: 'object', properties: { task: { type: 'string' } } },
    },
    needsApproval: opts.needsApproval ?? false,
    async execute(args, ctx) {
      return execute(args, ctx);
    },
  };
}

function spawnTool() {
  return makeTool('spawn_subagent', (args, ctx) => ctx.runSubagent(args.task, {}));
}

function readTool() {
  return makeTool('read_file', () => 'file contents here');
}

function hooksRunner(defs, opts) {
  const registry = new HookRegistry({ stateDir: makeTempDir('open-bot-hooks-loop-v101-') });
  for (const def of defs) registry.register(def);
  return new HookRunner(registry, opts);
}

function fnHook(name, events, handler) {
  return { name, events, handler, source: 'builtin', enabled: true };
}

function toolCall(id, name, args) {
  return { id: id ?? `call-${++callSeq}`, name, args };
}

// ---------------------------------------------------------------------------
// UserPromptSubmit
// ---------------------------------------------------------------------------

test('loop v1.01: UserPromptSubmit block refuses the turn, provider never called', async () => {
  const ws = makeTempDir('open-bot-hooks-loop-v101-');
  const seen = [];
  const provider = scriptedProvider([{ text: 'should never appear' }], seen);
  const hooks = hooksRunner([
    fnHook('refuser', ['UserPromptSubmit'], () =>
      blockDecision('prompt bị chặn: chứa lệnh nguy hiểm'),
    ),
  ]);
  const runner = new AgentRunner(provider, [readTool()], {
    bot: makeBot(ws),
    events: makeEvents(),
    hooks,
  });
  const result = await runner.run('rm -rf /');
  assert.equal(result, 'prompt bị chặn: chứa lệnh nguy hiểm');
  assert.equal(seen.length, 0, 'no provider call when the prompt hook blocks');
});

test('loop v1.01: UserPromptSubmit modify prepends hook context to the prompt', async () => {
  const ws = makeTempDir('open-bot-hooks-loop-v101-');
  const seen = [];
  const provider = scriptedProvider([{ text: 'done' }], seen);
  const hooks = hooksRunner([
    fnHook('adder', ['UserPromptSubmit'], () => modifyContextDecision('user prefers Vietnamese')),
  ]);
  const runner = new AgentRunner(provider, [readTool()], {
    bot: makeBot(ws),
    events: makeEvents(),
    hooks,
  });
  const result = await runner.run('hello');
  assert.equal(result, 'done');
  assert.equal(seen.length, 1);
  const userMsg = seen[0].messages.find((m) => m.role === 'user');
  assert.match(userMsg.content, /\[Hook context\]/);
  assert.match(userMsg.content, /user prefers Vietnamese/);
  assert.match(userMsg.content, /hello/);
});

// ---------------------------------------------------------------------------
// SubagentStart / SubagentStop
// ---------------------------------------------------------------------------

test('loop v1.01: SubagentStart block cancels the spawn (no child provider call)', async () => {
  const ws = makeTempDir('open-bot-hooks-loop-v101-');
  const seen = [];
  const provider = scriptedProvider(
    [
      { toolCalls: [toolCall(null, 'spawn_subagent', { task: 'do thing' })] },
      { text: 'parent done' },
    ],
    seen,
  );
  const hooks = hooksRunner([
    fnHook('no-spawn', ['SubagentStart'], (event) => {
      assert.equal(event.task, 'do thing');
      return blockDecision('subagent bị cấm trong turn này');
    }),
  ]);
  const events = makeEvents();
  const runner = new AgentRunner(provider, [spawnTool()], {
    bot: makeBot(ws),
    events,
    hooks,
  });
  const result = await runner.run('spawn one');
  assert.equal(result, 'parent done');
  assert.equal(seen.length, 2, 'only the parent chats — no child provider call');
  assert.equal(events.toolResults.length, 1);
  assert.match(events.toolResults[0].output, /bị hook chặn/);
  assert.match(events.toolResults[0].output, /subagent bị cấm/);
});

test('loop v1.01: SubagentStop block sends the child back once with the gate context', async () => {
  const ws = makeTempDir('open-bot-hooks-loop-v101-');
  const seen = [];
  const provider = scriptedProvider(
    [
      { toolCalls: [toolCall(null, 'spawn_subagent', { task: 'write the fix' })] },
      { text: 'child attempt 1' },
      { text: 'child attempt 2 fixed' },
      { text: 'parent done' },
    ],
    seen,
  );
  let stops = 0;
  const hooks = hooksRunner([
    fnHook('gate', ['SubagentStop'], (event) => {
      stops += 1;
      if (stops === 1) {
        assert.equal(event.status, 'done');
        assert.match(event.output, /child attempt 1/);
        return blockStopDecision('FIX: tests failed — 2 failures in login', 'tests failed');
      }
      return allowDecision();
    }),
  ]);
  const events = makeEvents();
  const runner = new AgentRunner(provider, [spawnTool()], {
    bot: makeBot(ws),
    events,
    hooks,
  });
  const result = await runner.run('spawn one');
  assert.equal(result, 'parent done');
  assert.equal(stops, 2, 'stop hook ran for both attempts');
  assert.equal(seen.length, 4, 'parent + child attempt 1 + child attempt 2 + parent');
  // The retry's task carries the gate context.
  const retryUserMsg = seen[2].messages.find((m) => m.role === 'user');
  assert.match(retryUserMsg.content, /write the fix/);
  assert.match(retryUserMsg.content, /FIX: tests failed/);
  // The parent sees the RETRY's output, not the first attempt's.
  assert.equal(events.toolResults.length, 1);
  assert.match(events.toolResults[0].output, /child attempt 2 fixed/);
  assert.ok(
    !events.toolResults[0].output.includes('child attempt 1\n'),
    'first attempt output must not leak into the parent result',
  );
});

test('loop v1.01: SubagentStop block with 0 retries attaches the gate context to the summary', async () => {
  const ws = makeTempDir('open-bot-hooks-loop-v101-');
  const seen = [];
  const provider = scriptedProvider(
    [
      { toolCalls: [toolCall(null, 'spawn_subagent', { task: 'write the fix' })] },
      { text: 'child done but broken' },
      { text: 'parent done' },
    ],
    seen,
  );
  const hooks = hooksRunner([
    fnHook('gate', ['SubagentStop'], () =>
      blockStopDecision('FIX: typecheck failed', 'typecheck failed'),
    ),
  ]);
  const events = makeEvents();
  const runner = new AgentRunner(provider, [spawnTool()], {
    bot: makeBot(ws),
    events,
    hooks,
    subagentStopMaxRetries: 0,
  });
  const result = await runner.run('spawn one');
  assert.equal(result, 'parent done');
  assert.equal(seen.length, 3, 'no retry when maxRetries is 0');
  assert.match(events.toolResults[0].output, /child done but broken/);
  assert.match(events.toolResults[0].output, /chưa được chấp nhận dừng/);
  assert.match(events.toolResults[0].output, /FIX: typecheck failed/);
});

test('loop v1.01: child inherits parent hooks (PreToolUse applies inside the subagent)', async () => {
  const ws = makeTempDir('open-bot-hooks-loop-v101-');
  const seen = [];
  const provider = scriptedProvider(
    [
      { toolCalls: [toolCall(null, 'spawn_subagent', { task: 'read a file' })] },
      { toolCalls: [toolCall(null, 'read_file', {})] },
      { text: 'child done' },
      { text: 'parent done' },
    ],
    seen,
  );
  const hooks = hooksRunner([
    fnHook('deny-read', ['PreToolUse'], (event) =>
      event.toolName === 'read_file' ? blockDecision('read_file bị chặn') : allowDecision(),
    ),
  ]);
  const events = makeEvents();
  const runner = new AgentRunner(provider, [spawnTool(), readTool()], {
    bot: makeBot(ws),
    events,
    hooks,
  });
  const result = await runner.run('spawn one');
  assert.equal(result, 'parent done');
  // The child's read_file call was blocked by the inherited hook: the
  // block reason surfaces as a tool result inside the shared events.
  assert.ok(
    events.toolResults.some((r) => r.output.includes('read_file bị chặn')),
    `expected a blocked read_file tool result, got: ${JSON.stringify(events.toolResults.map((r) => r.output))}`,
  );
  // And the parent still receives the child's final text.
  assert.ok(
    events.toolResults.some((r) => r.output.includes('child done')),
    'parent must receive the child result',
  );
});

// ---------------------------------------------------------------------------
// PreCompact / PostCompact
// ---------------------------------------------------------------------------

const LONG_TEXT = `Please summarise this long request. ${'lorem ipsum dolor sit amet '.repeat(200)}`;

function compactionRunner(seen, hooks, extraOpts = {}) {
  const ws = makeTempDir('open-bot-hooks-loop-v101-');
  const provider = scriptedProvider(
    [
      { toolCalls: [toolCall(null, 'read_file', {})] },
      { text: 'final answer' },
    ],
    seen,
  );
  return new AgentRunner(provider, [readTool()], {
    bot: makeBot(ws),
    events: makeEvents(),
    ...(hooks ? { hooks } : {}),
    compaction: { contextLimit: 100, keepRecent: 2, language: 'en' },
    // The small-model guard would refuse the long prompt before any
    // step runs (it reads contextLimit as the model window); hooks are
    // what this test measures, so the guard is off here.
    smallModel: { enabled: false },
    ...extraOpts,
  });
}

function hasSummary(messages) {
  return messages.some(
    (m) => typeof m.content === 'string' && m.content.includes('Context summary'),
  );
}

function hasLongText(messages) {
  return messages.some((m) => typeof m.content === 'string' && m.content.includes('lorem ipsum'));
}

test('loop v1.01: no hooks → compaction runs and the summary reaches the model', async () => {
  const seen = [];
  const runner = compactionRunner(seen, null);
  const result = await runner.run(LONG_TEXT);
  assert.equal(result, 'final answer');
  assert.ok(seen.length >= 2, `expected a second provider call after compaction, got ${seen.length}`);
  // The summariser call itself is in the middle; the last call carries compacted history.
  const last = seen[seen.length - 1];
  assert.ok(hasSummary(last.messages), 'compacted history must carry the summary message');
  assert.ok(!hasLongText(last.messages), 'original long text must be gone after compaction');
});

test('loop v1.01: PreCompact block skips compaction (history stays long)', async () => {
  const seen = [];
  const hooks = hooksRunner([
    fnHook('skipper', ['PreCompact'], (event) => {
      assert.ok(event.tokensBefore > 0);
      assert.ok(event.messageCount >= 3);
      return blockDecision('skip this round');
    }),
  ]);
  const runner = compactionRunner(seen, hooks);
  const result = await runner.run(LONG_TEXT);
  assert.equal(result, 'final answer');
  assert.equal(seen.length, 2, 'no summariser call when PreCompact blocks');
  assert.ok(!hasSummary(seen[1].messages), 'no summary when compaction was skipped');
  assert.ok(hasLongText(seen[1].messages), 'original long text still there');
});

test('loop v1.01: PostCompact block reverts to the pre-compaction history', async () => {
  const seen = [];
  const hooks = hooksRunner([
    fnHook('reverter', ['PostCompact'], (event) => {
      assert.ok(event.summarizedCount > 0);
      return blockDecision('summary is wrong, revert');
    }),
  ]);
  const runner = compactionRunner(seen, hooks);
  const result = await runner.run(LONG_TEXT);
  assert.equal(result, 'final answer');
  assert.ok(seen.length >= 2);
  const last = seen[seen.length - 1];
  assert.ok(!hasSummary(last.messages), 'reverted history must not carry the summary');
  assert.ok(hasLongText(last.messages), 'original long text restored after revert');
});

test('loop v1.01: PostCompact modify appends a hook note the model sees', async () => {
  const seen = [];
  const hooks = hooksRunner([
    fnHook('noter', ['PostCompact'], () => modifyContextDecision('remember: the plan is X')),
  ]);
  const runner = compactionRunner(seen, hooks);
  const result = await runner.run(LONG_TEXT);
  assert.equal(result, 'final answer');
  const last = seen[seen.length - 1];
  assert.ok(hasSummary(last.messages), 'compaction still happened');
  assert.ok(
    last.messages.some(
      (m) => typeof m.content === 'string' && m.content.includes('remember: the plan is X'),
    ),
    'hook note must be visible to the model after compaction',
  );
});
