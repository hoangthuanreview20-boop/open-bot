/**
 * Tests for v0.33 — tracing P0-6 (token usage in traces) + fork-execution
 * for skills with `context: fork` (P0-1):
 *   packages/core/src/tracing/tracer.ts — `setAttributes` + run token totals
 *   packages/core/src/tracing/store.ts  — totals survive the JSONL round-trip
 *   packages/core/src/agent/loop.ts     — fork skills run in a real subagent
 *     (summary only back to the parent), timeout/error never crash the
 *     parent, fork depth limit, plan-mode inheritance, child spans join
 *     the parent trace
 *   packages/core/src/skills/registry.ts — `excludeFork` (fork bodies are
 *     never inlined into the parent prompt)
 *   packages/core/src/coordinator/coordinator.ts — coordinator split:
 *     fork skills out of the parent tool filter, bodies loaded as
 *     `forkSkills`, error span on a failed run
 *
 * Loop/registry/tracer tests drive the real classes with a scripted mock
 * provider. The coordinator test drives the REAL coordinator child process
 * (CoordinatorClient + mockRecordPath) like tests/skills-coordinator.test.mjs.
 * No real API key, no network.
 *
 * Run after building core + tools:
 *   npm run build --workspace=@open-bot/core && npm run build --workspace=@open-bot/tools
 *   node --test tests/tracing-fork-v033.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AgentRunner } from '../packages/core/dist/agent/loop.js';
import {
  Tracer,
  TraceStore,
  TRACES_FILE,
} from '../packages/core/dist/tracing/index.js';
import {
  SkillRegistry,
  applySkills,
  skillRunsInSubagent,
} from '../packages/core/dist/skills/index.js';
import { CoordinatorClient } from '../packages/core/dist/coordinator/client.js';

// ---------------------------------------------------------------------------
// Shared helpers (loop-level)
// ---------------------------------------------------------------------------

const tmpDirs = [];
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeEvents() {
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
  return events;
}

function makeBot(workspaceDir, id = 'bot-fork') {
  return {
    id,
    name: 'Test',
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir,
    autoApprove: true,
  };
}

function makeTool(name) {
  return {
    definition: {
      name,
      description: `Tool ${name} for testing.`,
      parameters: { type: 'object', properties: {} },
    },
    needsApproval: false,
    async execute() {
      return `ok:${name}`;
    },
  };
}

/**
 * Scripted provider. Each entry is consumed in order (last repeats):
 *   { text, toolCalls?, usage? } — normal answer
 *   { hang: true }               — never resolves (timeout test)
 *   { throw: 'msg' }             — chat() throws (error test)
 */
function scriptedProvider(responses, seenRequests = []) {
  let i = 0;
  return {
    id: 'mock',
    label: 'Mock',
    async chat(req) {
      seenRequests.push(req);
      const r = responses[Math.min(i++, responses.length - 1)];
      if (r.hang) await new Promise(() => undefined);
      if (r.throw) throw new Error(r.throw);
      return {
        text: r.text ?? '',
        toolCalls: r.toolCalls ?? [],
        ...(r.usage ? { usage: { ...r.usage } } : {}),
      };
    },
    async listModels() {
      return ['mock'];
    },
  };
}

function systemOf(req) {
  const sys = req.messages.find((m) => m.role === 'system');
  assert.ok(sys, 'request must have a system message');
  return sys.content;
}

function toolNamesOf(req) {
  return (req.tools ?? []).map((t) => t.name);
}

/**
 * True when the tool is reachable in a request: either sent directly,
 * or sent as a member of a group dispatcher (groupTools folds tools
 * sharing a group — e.g. read_file + write_file — into one dispatcher
 * named `file`, whose description lists the members after
 * `Thành viên:`). The parent's tools must keep read_file *reachable*;
 * whether it arrives raw or grouped is a presentation detail.
 */
function toolReachable(req, name) {
  for (const t of req.tools ?? []) {
    if (t.name === name) return true;
    const members = /Thành viên: ([^.]+)\./.exec(t.description ?? '');
    if (members && members[1].split(',').map((s) => s.trim()).includes(name)) return true;
  }
  return false;
}

const TOOLS = ['read_file', 'web_search', 'write_file'].map(makeTool);

const FORK_SKILL = {
  name: 'research-brief',
  description: 'Research a topic and write a short sourced brief.',
  body: 'FORK SKILL BODY: research the topic step by step, cite sources.',
  allowedTools: ['web_search'],
};

// ---------------------------------------------------------------------------
// Loop: fork-execution
// ---------------------------------------------------------------------------

test('fork: skill runs in a real subagent; parent sees only the summary', async () => {
  const ws = tmpDir('open-bot-fork-');
  const seen = [];
  const provider = scriptedProvider(
    [
      { text: 'FORK SUMMARY: cats are nice', usage: { inputTokens: 10, outputTokens: 5 } },
      { text: 'final answer', usage: { inputTokens: 20, outputTokens: 7 } },
    ],
    seen,
  );
  const tracer = new Tracer({ runId: 'run-fork-1', botId: 'bot-fork' });
  const runner = new AgentRunner(provider, TOOLS, {
    bot: makeBot(ws),
    events: makeEvents(),
    tracer,
    forkSkills: [FORK_SKILL],
  });
  const result = await runner.run('research cats');
  assert.equal(result, 'final answer');
  assert.equal(seen.length, 2, 'exactly 2 provider calls: fork child, then parent');

  // The fork child got the skill body as its instructions + only its tools.
  const childReq = seen[0];
  assert.match(systemOf(childReq), /FORK SKILL BODY/, 'child system prompt must carry the skill body');
  assert.deepEqual(toolNamesOf(childReq), ['web_search'], 'child tools = skill allowed-tools');

  // The parent got the summary, never the raw skill body.
  const parentReq = seen[1];
  assert.match(systemOf(parentReq), /FORK SUMMARY: cats are nice/);
  assert.match(systemOf(parentReq), /Skill research-brief \(chạy trong subagent riêng\)/);
  assert.doesNotMatch(systemOf(parentReq), /FORK SKILL BODY/);

  // Trace: one handoff span for the fork (carrying the child's token
  // usage) + the parent's own LLM call. The child's raw spans stay in
  // its own tracer — only its summary + totals reach the parent trace.
  const trace = tracer.toTrace();
  const forkSpan = trace.spans.find((s) => s.kind === 'handoff');
  assert.ok(forkSpan, 'trace must have a handoff span for the fork');
  assert.equal(forkSpan.name, 'skill:research-brief (fork)');
  assert.equal(forkSpan.attributes?.forkStatus, 'done');
  assert.equal(forkSpan.attributes?.inputTokens, 10, 'child usage rides on the fork span');
  assert.equal(forkSpan.attributes?.outputTokens, 5);
  assert.match(forkSpan.outputSummary ?? '', /FORK SUMMARY/);
  const llmSpans = trace.spans.filter((s) => s.kind === 'llm');
  assert.equal(llmSpans.length, 1, 'only the parent LLM call is traced as an llm span');
  assert.equal(trace.totalInputTokens, 30);
  assert.equal(trace.totalOutputTokens, 12);
});

test('fork: child keeps its own allowed-tools even when the parent has an inline skill', async () => {
  const ws = tmpDir('open-bot-fork-');
  const seen = [];
  const provider = scriptedProvider(
    [{ text: 'child summary' }, { text: 'done' }],
    seen,
  );
  const runner = new AgentRunner(provider, TOOLS, {
    bot: makeBot(ws),
    events: makeEvents(),
    // Parent runs with an inline skill that only allows read_file.
    toolFilter: {
      activeSkills: [{ name: 'code-review', tools: ['read_file'], allowedTools: ['read_file'] }],
    },
    forkSkills: [FORK_SKILL],
  });
  assert.equal(await runner.run('research cats'), 'done');
  assert.equal(seen.length, 2);
  // Child: fork skill tools only — the parent inline skill must NOT strip them.
  assert.deepEqual(toolNamesOf(seen[0]), ['web_search']);
  // Parent: inline skill tools only — the fork skill must NOT widen/narrow them.
  assert.ok(toolNamesOf(seen[1]).includes('read_file'));
  assert.ok(!toolNamesOf(seen[1]).includes('web_search'));
});

test('fork: plan mode stays read-only inside the fork child', async () => {
  const ws = tmpDir('open-bot-fork-');
  const seen = [];
  const provider = scriptedProvider(
    [{ text: 'child summary' }, { text: 'done' }],
    seen,
  );
  const runner = new AgentRunner(provider, TOOLS, {
    bot: makeBot(ws),
    events: makeEvents(),
    toolFilter: { mode: 'plan' },
    forkSkills: [{ ...FORK_SKILL, allowedTools: ['write_file', 'web_search'] }],
  });
  assert.equal(await runner.run('research cats'), 'done');
  assert.equal(seen.length, 2);
  // write_file is a write tool: plan mode must hide it from the child even
  // though the fork skill explicitly allows it. web_search stays.
  assert.deepEqual(toolNamesOf(seen[0]), ['web_search']);
  assert.match(systemOf(seen[1]), /child summary/);
});

test('fork: timeout does not crash the parent run', async () => {
  const ws = tmpDir('open-bot-fork-');
  const seen = [];
  const provider = scriptedProvider([{ hang: true }, { text: 'final answer' }], seen);
  const tracer = new Tracer({ runId: 'run-fork-timeout', botId: 'bot-fork' });
  const runner = new AgentRunner(provider, TOOLS, {
    bot: makeBot(ws),
    events: makeEvents(),
    tracer,
    forkSkills: [FORK_SKILL],
    forkTimeoutMs: 50,
    forkMaxSteps: 5,
  });
  const result = await runner.run('research cats');
  assert.equal(result, 'final answer');
  assert.equal(seen.length, 2, 'parent still runs after the fork times out');
  assert.match(systemOf(seen[1]), /hết giờ/, 'parent prompt notes the fork timeout');
  const forkSpan = tracer.toTrace().spans.find((s) => s.kind === 'handoff');
  assert.equal(forkSpan?.attributes?.forkStatus, 'timeout');
  // A timed-out fork must not mark the whole trace as errored.
  assert.equal(tracer.toTrace().status, 'ok');
});

test('fork: error inside the fork does not crash the parent run', async () => {
  const ws = tmpDir('open-bot-fork-');
  const seen = [];
  const provider = scriptedProvider([{ throw: 'boom' }, { text: 'final answer' }], seen);
  const tracer = new Tracer({ runId: 'run-fork-error', botId: 'bot-fork' });
  const runner = new AgentRunner(provider, TOOLS, {
    bot: makeBot(ws),
    events: makeEvents(),
    tracer,
    forkSkills: [FORK_SKILL],
  });
  const result = await runner.run('research cats');
  assert.equal(result, 'final answer');
  assert.equal(seen.length, 2);
  assert.match(systemOf(seen[1]), /lỗi, bỏ qua skill này/);
  assert.match(systemOf(seen[1]), /boom/);
  const forkSpan = tracer.toTrace().spans.find((s) => s.kind === 'handoff');
  assert.equal(forkSpan?.attributes?.forkStatus, 'error');
  assert.equal(tracer.toTrace().status, 'ok');
});

test('fork: forkDepth > 0 never forks again (recursion guard)', async () => {
  const ws = tmpDir('open-bot-fork-');
  const seen = [];
  const provider = scriptedProvider([{ text: 'final' }], seen);
  const runner = new AgentRunner(provider, TOOLS, {
    bot: makeBot(ws),
    events: makeEvents(),
    forkSkills: [FORK_SKILL],
    forkDepth: 1,
  });
  assert.equal(await runner.run('research cats'), 'final');
  assert.equal(seen.length, 1, 'no subagent spawned at depth 1');
  assert.doesNotMatch(systemOf(seen[0]), /Kết quả skill/);
});

test('fork: inline skill (no forkSkills) still runs inline, unchanged', async () => {
  const ws = tmpDir('open-bot-fork-');
  const seen = [];
  const provider = scriptedProvider([{ text: 'final' }], seen);
  const runner = new AgentRunner(provider, TOOLS, {
    bot: makeBot(ws),
    events: makeEvents(),
  });
  assert.equal(await runner.run('hello'), 'final');
  assert.equal(seen.length, 1);
});

// ---------------------------------------------------------------------------
// Tracer: setAttributes + token totals + store round-trip
// ---------------------------------------------------------------------------

test('tracing: setAttributes records usage known only at finish time; totals sum', () => {
  const tracer = new Tracer({ runId: 'run-tokens', botId: 'bot-1' });
  const a = tracer.startSpan('llm', 'model-x', { attributes: { model: 'model-x', step: 1 } });
  a.setAttributes({ inputTokens: 100, outputTokens: 20 });
  a.finish('done');
  // Attributes given at startSpan count too.
  tracer
    .startSpan('llm', 'model-x', { attributes: { inputTokens: 50, outputTokens: 10 } })
    .finish('done');
  // A tool span without token attributes adds nothing.
  tracer.startSpan('tool', 'read_file').finish('ok');
  const trace = tracer.toTrace();
  assert.equal(trace.totalInputTokens, 150);
  assert.equal(trace.totalOutputTokens, 30);
});

test('tracing: setAttributes after finish is a no-op (totals cannot inflate)', () => {
  const tracer = new Tracer({ runId: 'run-tokens-2', botId: 'bot-1' });
  const handle = tracer.startSpan('llm', 'model-x');
  handle.finish('done');
  handle.setAttributes({ inputTokens: 9999 });
  handle.finish('again');
  assert.equal(tracer.toTrace().totalInputTokens, 0);
});

test('tracing: totals survive the JSONL store round-trip; old traces read as 0', () => {
  const dir = tmpDir('open-bot-fork-trace-');
  const store = new TraceStore({ filePath: path.join(dir, TRACES_FILE) });
  const tracer = new Tracer({ runId: 'run-store', botId: 'bot-1' });
  tracer.startSpan('llm', 'm', { attributes: { inputTokens: 7, outputTokens: 3 } }).finish('ok');
  tracer.save(store);
  const back = store.getTraceByRunId('run-store');
  assert.equal(back.totalInputTokens, 7);
  assert.equal(back.totalOutputTokens, 3);
  const [summary] = store.listTraces();
  assert.equal(summary.totalInputTokens, 7);
  assert.equal(summary.totalOutputTokens, 3);
  // A trace line written before v0.33 (no totals) still loads, as 0.
  fs.appendFileSync(
    path.join(dir, TRACES_FILE),
    '{"traceId":"old","runId":"run-old","botId":"bot-1","startedAt":1,"endedAt":2,"durationMs":1,"status":"ok","spans":[]}\n',
  );
  assert.equal(store.getTraceByRunId('run-old').totalInputTokens, 0);
  assert.equal(store.getTraceByRunId('run-old').totalOutputTokens, 0);
});

// ---------------------------------------------------------------------------
// Registry: excludeFork
// ---------------------------------------------------------------------------

const FORK_SKILL_TEXT = `---
name: zebra-fork
description: Do a zebrafork job in a subagent.
version: 1.0.0
when-to-use: when the user asks to zebrafork something
allowed-tools: [web_search]
context: fork
---
# Zebra fork
FORK BODY MARKER: do the zebrafork work here.
`;

const INLINE_SKILL_TEXT = `---
name: zebra-inline
description: Do a zebrafork job inline.
version: 1.0.0
when-to-use: when the user asks to zebrafork something
allowed-tools: [read_file]
---
# Zebra inline
INLINE BODY MARKER: do the zebrafork work here.
`;

test('registry: excludeFork keeps fork bodies out of the parent prompt', () => {
  const registry = new SkillRegistry();
  registry.load();
  const fork = registry.addSkillFromText(FORK_SKILL_TEXT);
  const inline = registry.addSkillFromText(INLINE_SKILL_TEXT);
  assert.ok(fork && inline);
  assert.equal(skillRunsInSubagent(fork), true);
  assert.equal(skillRunsInSubagent(inline), false);
  assert.equal(registry.loadBody('zebra-fork')?.body.includes('FORK BODY MARKER'), true);

  const excluded = registry.applySkillsForTask('base', 'please zebrafork the quokka', 3, {
    excludeFork: true,
  });
  assert.match(excluded, /INLINE BODY MARKER/, 'inline skill body must be injected');
  assert.doesNotMatch(excluded, /FORK BODY MARKER/, 'fork skill body must NOT be inlined');

  const included = registry.applySkillsForTask('base', 'please zebrafork the quokka', 3);
  assert.match(included, /INLINE BODY MARKER/);
  assert.match(included, /FORK BODY MARKER/, 'without excludeFork the old behaviour stays');
});

test('registry: applySkills excludeFork skips fork skills directly', () => {
  const fake = (overrides) => ({
    name: 's',
    description: 'd',
    version: '1.0.0',
    whenToUse: '',
    tools: [],
    allowedTools: [],
    disableModelInvocation: false,
    userInvocable: true,
    body: 'BODY',
    bodyLoaded: true,
    resources: { scripts: [], references: [], assets: [] },
    source: 'user',
    enabled: true,
    ...overrides,
  });
  const inline = fake({ name: 'inline', body: 'INLINE BODY' });
  const fork = fake({ name: 'fork', body: 'FORK BODY', context: 'fork' });
  assert.match(applySkills('base', [inline, fork], { excludeFork: true }), /INLINE BODY/);
  assert.doesNotMatch(applySkills('base', [inline, fork], { excludeFork: true }), /FORK BODY/);
});

// ---------------------------------------------------------------------------
// Coordinator: fork split end-to-end (real child process + mock provider)
// ---------------------------------------------------------------------------

let client;
test.before(async () => {
  client = new CoordinatorClient();
  const pong = await client.ping();
  assert.equal(pong.pong, true, 'coordinator phải trả pong');
});

test.after(async () => {
  await client.dispose();
});

test('coordinator: fork skill runs in a subagent; parent tools are not narrowed by it', async () => {
  const ws = tmpDir('open-bot-fork-coord-');
  const skillsDir = path.join(ws, 'skills', 'zebra-fork');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), FORK_SKILL_TEXT);
  const recordPath = path.join(ws, 'mock-record.jsonl');
  const tracesFile = path.join(ws, 'traces.jsonl');
  const botId = 'bot-fork-coord';
  await client.createBot({
    bot: {
      id: botId,
      name: 'Fork Coord Bot',
      providerId: 'mock',
      model: 'mock',
      systemPrompt: 'You are a test bot.',
      workspaceDir: ws,
      autoApprove: true,
    },
    provider: {
      id: 'mock',
      label: 'Mock',
      mockResponses: [
        { text: 'FORK SUMMARY FROM COORDINATOR', usage: { inputTokens: 11, outputTokens: 6 } },
        { text: 'ok', usage: { inputTokens: 22, outputTokens: 8 } },
      ],
      mockRecordPath: recordPath,
    },
    skillsDirs: {
      userSkillsDir: path.join(ws, 'skills'),
      pluginsDir: path.join(ws, 'plugins'),
      stateDir: ws,
    },
    tracesFile,
  });
  try {
    const res = await client.run(botId, 'please zebrafork the quokka');
    assert.equal(res.text, 'ok');

    const records = fs
      .readFileSync(recordPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.equal(records.length, 2, 'fork child + parent = 2 provider calls');
    const [childReq, parentReq] = records;

    // Fork child: skill body as instructions, only its allowed tools.
    assert.match(systemOf(childReq), /FORK BODY MARKER/);
    assert.ok(toolNamesOf(childReq).includes('web_search'), 'child must get web_search');
    assert.ok(
      !toolNamesOf(childReq).includes('read_file'),
      `child must NOT get read_file, got: ${toolNamesOf(childReq).join(', ')}`,
    );

    // Parent: fork summary only (never the body), tools NOT narrowed to
    // the fork skill's allowlist (read_file from the inline match stays —
    // reachable either raw or via the `file` group dispatcher, see
    // toolReachable: with several inline skills matching, groupTools may
    // fold read_file + write_file into one `file` dispatcher).
    assert.match(systemOf(parentReq), /FORK SUMMARY FROM COORDINATOR/);
    assert.doesNotMatch(systemOf(parentReq), /FORK BODY MARKER/);
    assert.ok(
      toolReachable(parentReq, 'read_file'),
      `parent tools must keep read_file reachable, got: ${toolNamesOf(parentReq).join(', ')}`,
    );

    // Trace file: handoff span for the fork + token totals (child + parent).
    const lines = fs.readFileSync(tracesFile, 'utf-8').split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 1);
    const trace = JSON.parse(lines[0]);
    assert.equal(trace.runId, res.runId);
    const forkSpan = trace.spans.find((s) => s.kind === 'handoff');
    assert.ok(forkSpan, 'trace must have a fork handoff span');
    assert.equal(forkSpan.name, 'skill:zebra-fork (fork)');
    assert.equal(forkSpan.attributes?.forkStatus, 'done');
    assert.equal(trace.totalInputTokens, 33, 'child 11 + parent 22');
    assert.equal(trace.totalOutputTokens, 14, 'child 6 + parent 8');
  } finally {
    await client.destroyBot(botId);
  }
});
