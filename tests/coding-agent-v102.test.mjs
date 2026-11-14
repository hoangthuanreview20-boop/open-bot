/**
 * coding-agent-v102.test.mjs — OpenHands-style coding agent (v1.02, Team T4).
 * Event store, workspace confinement, sandboxed exec, actions, planner,
 * budgets, reasoners, the agent loop and trace stats. No network, no
 * real model: scripted / rule / fake-provider reasoners only.
 * Run: node --test tests/coding-agent-v102.test.mjs (after building core)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodingEventStore } from '../packages/core/dist/coding/store.js';
import { Workspace, WorkspaceEscapeError } from '../packages/core/dist/coding/workspace.js';
import { runSandboxed, validateArgv } from '../packages/core/dist/coding/sandboxExec.js';
import { ActionExecutor, describeAction, validateAction } from '../packages/core/dist/coding/actions.js';
import {
  createPlan,
  extractSubTasks,
  codingPlanProgress,
  markStep,
  nextPendingStep,
} from '../packages/core/dist/coding/planner.js';
import { BudgetTracker, estimateTokensFromChars } from '../packages/core/dist/coding/budget.js';
import {
  ProviderReasoner,
  RuleReasoner,
  ScriptedReasoner,
  parseProviderReasoning,
} from '../packages/core/dist/coding/reasoner.js';
import { CodingAgent } from '../packages/core/dist/coding/agent.js';
import { aggregateStats, renderTraceMarkdown } from '../packages/core/dist/coding/trace.js';
import { estimateCost } from '../packages/core/dist/usage/pricing.js';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-v102-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const CHECK_ARGV = ['node', '-e', 'process.exit(require("fs").readFileSync("src/msg.mjs","utf8").includes(\'"hello"\') ? 0 : 1)'];

// --- Event store ----------------------------------------------------------

test('event store: append, verify, JSONL round-trip, replay', (t) => {
  const store = new CodingEventStore('run-1');
  store.append('run.started', { task: 'do it', workspaceRoot: '/tmp/w', model: 'scripted', maxSteps: 10 });
  store.append('plan.created', { stepIds: ['s1'], steps: ['Explore'] });
  store.append('file.changed', { path: 'a.ts', kind: 'created', linesAdded: 3, linesRemoved: 0 });
  store.append('check.result', { name: 'syntax', passed: true, argv: ['node', '--check'], durationMs: 5 });
  store.append('run.finished', {
    status: 'succeeded', summary: 'done', stepsUsed: 2, filesChanged: 1,
    inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 10,
  });
  assert.equal(store.size, 5);
  assert.deepEqual(store.verify(), { ok: true });
  assert.equal(store.byType('file.changed').length, 1);
  assert.equal(store.byStep(0).length, 5);

  const clone = CodingEventStore.fromJSONL('run-1', store.toJSONL());
  assert.deepEqual(clone.verify(), { ok: true });
  const state = clone.replay();
  assert.equal(state.status, 'succeeded');
  assert.equal(state.task, 'do it');
  assert.equal(state.filesChanged['a.ts'].kind, 'created');
  assert.deepEqual(state.checks, [{ name: 'syntax', passed: true }]);
  assert.equal(state.plan[0].description, 'Explore');
});

test('event store: tampered payload fails verification', () => {
  const store = new CodingEventStore('run-tamper');
  store.append('run.started', { task: 'x', workspaceRoot: '/tmp/w', model: 'scripted', maxSteps: 5 });
  const jsonl = store.toJSONL();
  const tampered = jsonl.replace('"x"', '"y"');
  assert.notEqual(tampered, jsonl);
  const clone = CodingEventStore.fromJSONL('run-tamper', tampered);
  assert.equal(clone.verify().ok, false);
});

test('event store: persistDir writes a JSONL file', (t) => {
  const dir = tmpDir(t);
  const store = new CodingEventStore('run-persist', { persistDir: dir });
  store.append('run.started', { task: 'x', workspaceRoot: '/tmp/w', model: 'scripted', maxSteps: 5 });
  const file = path.join(dir, 'run-persist.jsonl');
  assert.equal(fs.existsSync(file), true);
  const loaded = CodingEventStore.fromFile(file);
  assert.equal(loaded.size, 1);
  assert.equal(loaded.verify().ok, true);
});

// --- Workspace ------------------------------------------------------------

test('workspace: create/edit/delete/list, escape rejected', (t) => {
  const dir = tmpDir(t);
  const ws = new Workspace(dir);
  const created = ws.create('src/a.ts', 'line1\nline2\n');
  assert.equal(created.kind, 'created');
  assert.equal(created.linesAdded, 3); // trailing newline counts as a line split
  assert.equal(ws.read('src/a.ts'), 'line1\nline2\n');
  assert.deepEqual(ws.listFiles(), ['src/a.ts']);
  assert.throws(() => ws.create('src/a.ts', 'x'), /already exists/);
  assert.throws(() => ws.edit('src/a.ts', 'line', 'x'), /occurs 2 times/);
  const edited = ws.edit('src/a.ts', 'line1', 'LINE1');
  assert.equal(edited.kind, 'edited');
  assert.equal(ws.read('src/a.ts'), 'LINE1\nline2\n');
  assert.throws(() => ws.edit('src/a.ts', 'missing', 'x'), /not found/);
  const deleted = ws.delete('src/a.ts');
  assert.equal(deleted.kind, 'deleted');
  assert.equal(ws.exists('src/a.ts'), false);

  assert.throws(() => ws.resolve('../escape.txt'), WorkspaceEscapeError);
  assert.throws(() => ws.resolve('/etc/passwd'), WorkspaceEscapeError);
  assert.throws(() => ws.create('../../evil.txt', 'x'), WorkspaceEscapeError);
});

// --- Sandbox exec ---------------------------------------------------------

test('sandbox exec: runs argv, blocks dangerous binaries and outside paths', async (t) => {
  const dir = tmpDir(t);
  const ok = await runSandboxed(['node', '-e', 'console.log("hi")'], { workspaceRoot: dir });
  assert.equal(ok.blocked, false);
  assert.equal(ok.exitCode, 0);
  assert.match(ok.stdout, /hi/);

  const fail = await runSandboxed(['node', '-e', 'process.exit(3)'], { workspaceRoot: dir });
  assert.equal(fail.exitCode, 3);

  const blocked = await runSandboxed(['sudo', 'ls'], { workspaceRoot: dir });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.blockReason ?? '', /blocked binary/);

  assert.match(validateArgv(['node', '-e', '1', '/etc/passwd'], dir) ?? '', /outside workspace/);
  assert.equal(validateArgv(['node', '-e', '1'], dir), null);
  assert.equal(validateArgv([], dir), 'empty command');
});

test('sandbox exec: timeout kills the command', async (t) => {
  const dir = tmpDir(t);
  const result = await runSandboxed(['node', '-e', 'setTimeout(() => {}, 10000)'], {
    workspaceRoot: dir,
    timeoutMs: 300,
  });
  assert.equal(result.timedOut, true);
  assert.ok(result.durationMs < 5000);
});

// --- Actions --------------------------------------------------------------

test('actions: executor create/write/edit/delete/run_command + validation', async (t) => {
  const dir = tmpDir(t);
  const ws = new Workspace(dir);
  const ex = new ActionExecutor(ws);
  const c1 = await ex.execute({ kind: 'create_file', path: 'a.txt', content: 'hello\n' });
  assert.equal(c1.ok, true);
  assert.equal(c1.fileChange?.kind, 'created');
  const dup = await ex.execute({ kind: 'create_file', path: 'a.txt', content: 'x' });
  assert.equal(dup.ok, false);
  assert.match(dup.summary, /already exists/);
  const w = await ex.execute({ kind: 'write_file', path: 'a.txt', content: 'hello world\n' });
  assert.equal(w.ok, true);
  assert.equal(w.fileChange?.kind, 'edited');
  const e = await ex.execute({ kind: 'edit_file', path: 'a.txt', oldText: 'world', newText: 'there' });
  assert.equal(e.ok, true);
  assert.equal(ws.read('a.txt'), 'hello there\n');
  const cmd = await ex.execute({ kind: 'run_command', argv: ['node', '-e', 'console.log(1+1)'] });
  assert.equal(cmd.ok, true);
  assert.equal(cmd.commandResult?.exitCode, 0);
  const blocked = await ex.execute({ kind: 'run_command', argv: ['sudo', 'id'] });
  assert.equal(blocked.ok, false);
  const esc = await ex.execute({ kind: 'create_file', path: '../evil.txt', content: 'x' });
  assert.equal(esc.ok, false);
  assert.match(esc.summary, /escapes workspace/);
  const d = await ex.execute({ kind: 'delete_file', path: 'a.txt' });
  assert.equal(d.ok, true);
  assert.equal(validateAction({ kind: 'finish', summary: '', success: true }, ws), 'finish needs a summary');
  assert.equal(describeAction({ kind: 'run_command', argv: ['npm', 'test'] }), 'run: npm test');
});

// --- Planner / budget -----------------------------------------------------

test('planner: generic plan + bulleted sub-tasks, progress math', () => {
  const plan = createPlan('Do the thing');
  assert.equal(plan.steps.length, 4);
  assert.deepEqual(plan.steps.map((s) => s.kind), ['explore', 'implement', 'verify', 'finish']);
  const plan2 = createPlan('Ship it\n- Add login\n- Add logout\n');
  assert.deepEqual(extractSubTasks('Ship it\n- Add login\n- Add logout\n'), ['Add login', 'Add logout']);
  assert.equal(plan2.steps.filter((s) => s.kind === 'implement').length, 2);
  assert.equal(codingPlanProgress(plan), 0);
  markStep(plan, plan.steps[0].id, 'done');
  assert.equal(codingPlanProgress(plan), 0.25);
  assert.equal(nextPendingStep(plan)?.kind, 'implement');
});

test('budget: steps/tokens/cost/time limits + unknown-price cost is null', () => {
  const tracker = new BudgetTracker('gpt-5', { maxSteps: 2, maxCostUsd: 0.000001 });
  assert.equal(tracker.checkExceeded(), null);
  tracker.recordStep();
  tracker.recordStep();
  assert.equal(tracker.checkExceeded()?.budget, 'steps');
  assert.equal(tracker.canFix, true);
  tracker.recordFixAttempt();
  tracker.recordFixAttempt();
  tracker.recordFixAttempt();
  assert.equal(tracker.canFix, false);

  const priced = new BudgetTracker('gpt-5', { maxCostUsd: 1, maxTokens: 10_000_000 });
  priced.recordTokens(1_000_000, 0);
  assert.equal(priced.usage().costUsd, estimateCost('gpt-5', 1_000_000, 0));
  assert.equal(priced.checkExceeded()?.budget, 'cost');

  const unknown = new BudgetTracker('some-unknown-model-xyz');
  unknown.recordTokens(100, 100);
  assert.equal(unknown.usage().costUsd, null);
  assert.equal(estimateTokensFromChars('abcd'), 1);
  assert.equal(estimateTokensFromChars('abcdefgh'), 2);
});

// --- Reasoners ------------------------------------------------------------

test('reasoner: parseProviderReasoning accepts fenced JSON, rejects bad shapes', () => {
  const parsed = parseProviderReasoning('```json\n{"thought": "t", "action": {"kind": "finish", "summary": "ok", "success": true}}\n```');
  assert.equal(parsed.thought, 't');
  assert.equal(parsed.action.kind, 'finish');
  assert.throws(() => parseProviderReasoning('not json'), /Unexpected token|not valid JSON|JSON/);
  assert.throws(
    () => parseProviderReasoning('{"thought": "t", "action": {"kind": "teleport"}}'),
    /unknown action kind/,
  );
});

test('reasoner: ProviderReasoner calls any provider and counts usage', async (t) => {
  const dir = tmpDir(t);
  const ws = new Workspace(dir);
  const fakeProvider = {
    id: 'fake',
    label: 'Fake',
    chat: async () => ({
      text: '{"thought": "make it", "action": {"kind": "create_file", "path": "x.ts", "content": "export {};"}}',
      toolCalls: [],
      usage: { inputTokens: 40, outputTokens: 12 },
    }),
    listModels: async () => ['fake-1'],
  };
  const reasoner = new ProviderReasoner(fakeProvider, 'fake-1');
  const plan = createPlan('make x.ts');
  const out = await reasoner.reason({
    task: 'make x.ts',
    plan,
    step: 1,
    files: ws.listFiles(),
    history: [],
    fixAttempts: 0,
    canFix: true,
  });
  assert.equal(out.action.kind, 'create_file');
  assert.equal(out.inputTokens, 40);
  assert.equal(out.outputTokens, 12);
});

test('reasoner: RuleReasoner creates files, verifies, finishes', async (t) => {
  const dir = tmpDir(t);
  const ws = new Workspace(dir);
  const reasoner = new RuleReasoner({
    files: [{ path: 'a.txt', content: 'hi\n' }],
    verifyArgv: ['node', '-e', 'process.exit(0)'],
  });
  const plan = createPlan('make a.txt');
  const step1 = await reasoner.reason({
    task: 'make a.txt', plan, step: 1, files: [], history: [], fixAttempts: 0, canFix: true,
  });
  assert.equal(step1.action.kind, 'create_file');
  const step2 = await reasoner.reason({
    task: 'make a.txt', plan, step: 2, files: ['a.txt'], history: [], fixAttempts: 0, canFix: true,
  });
  assert.equal(step2.action.kind, 'run_command');
  const step3 = await reasoner.reason({
    task: 'make a.txt', plan, step: 3, files: ['a.txt'], history: [], fixAttempts: 0, canFix: true,
  });
  // verify already tried once — rule reasoner finishes next.
  assert.equal(step3.action.kind, 'finish');
});

// --- Agent loop -----------------------------------------------------------

test('agent loop: scripted happy path, events replay to success', async (t) => {
  const dir = tmpDir(t);
  const wsDir = path.join(dir, 'ws');
  const agent = new CodingAgent({
    workspaceRoot: wsDir,
    reasoner: new ScriptedReasoner([
      { thought: 'create', action: { kind: 'create_file', path: 'src/greet.ts', content: 'export function greet(): string {\n  return "hello";\n}\n' } },
      { thought: 'verify', action: { kind: 'run_command', argv: ['node', '-e', 'process.exit(0)'] } },
      { thought: 'done', action: { kind: 'finish', summary: 'Created src/greet.ts.', success: true } },
    ]),
    checks: [{ name: 'smoke', argv: ['node', '-e', 'process.exit(0)'] }],
    persistDir: path.join(dir, 'logs'),
  });
  const result = await agent.run('Create src/greet.ts');
  assert.equal(result.status, 'succeeded');
  assert.equal(result.summary, 'Created src/greet.ts.');
  assert.equal(fs.existsSync(path.join(wsDir, 'src/greet.ts')), true);
  assert.equal(result.filesChanged.length, 1);
  const types = result.events.map((e) => e.type);
  for (const needed of ['run.started', 'plan.created', 'reasoning', 'action.proposed', 'action.executed', 'observation', 'file.changed', 'command.result', 'check.result', 'run.finished']) {
    assert.ok(types.includes(needed), `missing event ${needed}`);
  }
  assert.equal(result.store.verify().ok, true);
  const replayed = result.store.replay();
  assert.equal(replayed.status, 'succeeded');
  assert.equal(replayed.filesChanged['src/greet.ts'].kind, 'created');
  assert.deepEqual(replayed.checks, [{ name: 'smoke', passed: true }]);
  assert.equal(result.plan.steps.every((s) => s.status === 'done'), true);
  assert.match(renderTraceMarkdown(result.trace), /Coding run/);
  const logFile = path.join(dir, 'logs', `${result.runId}.jsonl`);
  assert.equal(fs.existsSync(logFile), true);
});

test('agent loop: failed check triggers fix attempt, then passes', async (t) => {
  const dir = tmpDir(t);
  const wsDir = path.join(dir, 'ws');
  fs.mkdirSync(path.join(wsDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'src/msg.mjs'), 'export const msg = "helo";\n');
  const agent = new CodingAgent({
    workspaceRoot: wsDir,
    reasoner: new ScriptedReasoner([
      { thought: 'check first', action: { kind: 'run_command', argv: CHECK_ARGV } },
      { thought: 'fix typo', action: { kind: 'edit_file', path: 'src/msg.mjs', oldText: '"helo"', newText: '"hello"' } },
      { thought: 're-check', action: { kind: 'run_command', argv: CHECK_ARGV } },
      { thought: 'done', action: { kind: 'finish', summary: 'Fixed.', success: true } },
    ]),
    checks: [{ name: 'content', argv: CHECK_ARGV }],
  });
  const result = await agent.run('Fix the typo');
  assert.equal(result.status, 'succeeded');
  assert.equal(fs.readFileSync(path.join(wsDir, 'src/msg.mjs'), 'utf8'), 'export const msg = "hello";\n');
  const fixEvents = result.events.filter((e) => e.type === 'fix.attempted');
  assert.equal(fixEvents.length, 1);
  const checkResults = result.events.filter((e) => e.type === 'check.result');
  assert.equal(checkResults.length, 2);
  assert.equal(checkResults[0].payload.passed, false);
  assert.equal(checkResults[1].payload.passed, true);
});

test('agent loop: check fails with no fix attempts left -> failed run', async (t) => {
  const dir = tmpDir(t);
  const agent = new CodingAgent({
    workspaceRoot: path.join(dir, 'ws'),
    reasoner: new ScriptedReasoner([
      { thought: 'run failing check', action: { kind: 'run_command', argv: ['node', '-e', 'process.exit(1)'] } },
      { thought: 'done', action: { kind: 'finish', summary: 'n/a', success: true } },
    ]),
    budget: { maxFixAttempts: 0 },
    checks: [{ name: 'always-fails', argv: ['node', '-e', 'process.exit(1)'] }],
  });
  const result = await agent.run('Do the impossible');
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /no fix attempts remain/);
});

test('agent loop: step budget exceeded when the script never finishes', async (t) => {
  const dir = tmpDir(t);
  const agent = new CodingAgent({
    workspaceRoot: path.join(dir, 'ws'),
    reasoner: new ScriptedReasoner([
      { thought: 'again', action: { kind: 'run_command', argv: ['node', '-e', 'process.exit(0)'] } },
      { thought: 'again', action: { kind: 'run_command', argv: ['node', '-e', 'process.exit(0)'] } },
      { thought: 'again', action: { kind: 'run_command', argv: ['node', '-e', 'process.exit(0)'] } },
      { thought: 'again', action: { kind: 'run_command', argv: ['node', '-e', 'process.exit(0)'] } },
      { thought: 'again', action: { kind: 'run_command', argv: ['node', '-e', 'process.exit(0)'] } },
    ]),
    budget: { maxSteps: 2 },
  });
  const result = await agent.run('Loop forever');
  assert.equal(result.status, 'budget-exceeded');
  assert.ok(result.events.some((e) => e.type === 'budget.exceeded'));
  assert.equal(result.stepsUsed, 2);
});

test('agent loop: RuleReasoner end-to-end (no model)', async (t) => {
  const dir = tmpDir(t);
  const agent = new CodingAgent({
    workspaceRoot: path.join(dir, 'ws'),
    reasoner: new RuleReasoner({
      files: [{ path: 'hello.txt', content: 'hello\n' }],
      verifyArgv: ['node', '-e', 'process.exit(0)'],
    }),
    checks: [{ name: 'smoke', argv: ['node', '-e', 'process.exit(0)'] }],
  });
  const result = await agent.run('Create hello.txt');
  assert.equal(result.status, 'succeeded');
  assert.equal(fs.existsSync(path.join(dir, 'ws', 'hello.txt')), true);
});

// --- Trace stats ----------------------------------------------------------

test('trace: aggregateStats over mixed runs', () => {
  const stats = aggregateStats([
    { runId: 'a', task: 't1', model: 'scripted', status: 'succeeded', summary: 'ok', stepsUsed: 3, filesChanged: 1, inputTokens: 10, outputTokens: 5, costUsd: 0, durationMs: 100 },
    { runId: 'b', task: 't2', model: 'scripted', status: 'failed', summary: 'bad', stepsUsed: 5, filesChanged: 0, inputTokens: 20, outputTokens: 10, costUsd: 0, durationMs: 200, failureReason: 'check failed' },
  ]);
  assert.equal(stats.runs, 2);
  assert.equal(stats.succeeded, 1);
  assert.equal(stats.successRate, 0.5);
  assert.equal(stats.avgSteps, 4);
  assert.equal(stats.avgDurationMs, 150);
  assert.equal(stats.totalInputTokens, 30);
  assert.deepEqual(stats.failureReasons, { 'check failed': 1 });
  const empty = aggregateStats([]);
  assert.equal(empty.runs, 0);
  assert.equal(empty.successRate, 0);
  assert.equal(empty.totalCostUsd, 0);
});
