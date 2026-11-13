/**
 * planning-v098.test.mjs — planning v2 (Team T4, sóng v0.98).
 *
 * - Stuck detector v2: stall (silence), error-repeat (same normalised
 *   error), tool-cycle (A→B→A→B), configurable thresholds, old rules
 *   (repeated call, no-progress) unchanged.
 * - Plan templates: all four instantiate, required variables enforced,
 *   unknown template / missing variable throws.
 * - Auto-replan: a proposal per stuck reason, approve applies it to
 *   the plan, reject leaves the plan alone, double decision throws.
 * - Persistence: save/load round-trip, resume resets running steps
 *   to pending, corrupt files are skipped, unsafe ids refused.
 * - Run binding: plan follows a simulated live run — dispatch at
 *   run start, tool calls feed the detector, stuck emits once per
 *   step+reason with a replan proposal, run end settles the step
 *   (done / failed / released on stop), plan-finished at the end.
 *
 * Run: npm run build --workspace=@open-bot/core, then
 *      node --test tests/planning-v098.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PlanEngine,
  RunPlanBinding,
  PlanFileStore,
  StuckDetector,
  applyReplan,
  checkErrorRepeat,
  checkStall,
  checkToolCycle,
  getPlanTemplate,
  instantiatePlanTemplate,
  listPlanTemplates,
  normalizeToolError,
  proposeReplan,
  rejectReplan,
  trailingCycle,
} from '../packages/core/dist/planning/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-planning-v098-'));
}

function makeEngine() {
  let n = 0;
  return new PlanEngine({ idFactory: () => `id-${++n}` });
}

function makePlan(engine, steps = ['Step one', 'Step two', 'Step three']) {
  return engine.createPlan('Test plan', { ownerBotId: 'bot-1', steps });
}

// ---------------------------------------------------------------------------
// Stuck detector v2
// ---------------------------------------------------------------------------

test('stuck v2: repeated call still fires (v0.96 rule unchanged)', () => {
  const d = new StuckDetector();
  d.recordToolCall('read_file', { path: '/a.txt' });
  d.recordToolCall('read_file', { path: '/a.txt' });
  assert.equal(d.check(), null);
  d.recordToolCall('read_file', { path: '/a.txt' });
  const report = d.check();
  assert.ok(report);
  assert.equal(report.reason, 'repeated-tool-call');
  assert.equal(report.repeatCount, 3);
});

test('stuck v2: stall fires after silence, activity resets the clock', () => {
  let now = 1_000_000;
  const d = new StuckDetector({ stallMs: 60_000, now: () => now });
  d.recordToolCall('search', { q: 'x' });
  now += 59_000;
  assert.equal(d.check(), null, '59s of silence is not a stall at 60s');
  now += 2_000;
  const report = d.check();
  assert.ok(report);
  assert.equal(report.reason, 'stall');
  assert.equal(report.stalledForMs, 61_000);
  // A progress note resets the clock — the run is alive again.
  d.recordActivity();
  assert.equal(d.check(), null);
});

test('stuck v2: stall does not fire before any tool activity', () => {
  let now = 1_000_000;
  const d = new StuckDetector({ stallMs: 1_000, now: () => now });
  now += 10_000;
  assert.equal(d.check(), null, 'no activity yet means no stall to report');
});

test('stuck v2: error-repeat fires on the same normalised error', () => {
  const d = new StuckDetector();
  d.recordToolCall('read_file', { path: '/a.txt' });
  d.recordToolResult('read_file', false, 'timeout after 30s');
  d.recordToolCall('read_file', { path: '/b.txt' });
  d.recordToolResult('read_file', false, 'timeout after 31s');
  assert.equal(d.check(), null);
  d.recordToolCall('read_file', { path: '/c.txt' });
  d.recordToolResult('read_file', false, 'timeout after 32s');
  const report = d.check();
  assert.ok(report);
  assert.equal(report.reason, 'error-repeat');
  assert.equal(report.errorCount, 3);
  assert.match(report.error, /timeout/);
});

test('stuck v2: error normalisation ignores numbers (line numbers, ids)', () => {
  assert.equal(
    normalizeToolError('File not found: /tmp/x-123.txt (attempt 4)'),
    normalizeToolError('File not found: /tmp/x-987.txt (attempt 9)'),
  );
  // ...but a genuinely different path is a different error.
  assert.notEqual(
    normalizeToolError('File not found: /tmp/x-123.txt'),
    normalizeToolError('File not found: /tmp/y-123.txt'),
  );
  // A success clears the error streak.
  const d = new StuckDetector();
  d.recordToolResult('search', false, 'timeout after 30s');
  d.recordToolResult('search', false, 'timeout after 31s');
  d.recordToolResult('search', true);
  d.recordToolResult('search', false, 'timeout after 32s');
  assert.equal(d.check(), null);
});

test('stuck v2: tool-cycle fires on A→B→A→B, not on A→B→A', () => {
  const d = new StuckDetector();
  const call = (tool) => d.recordToolCall(tool, { q: 'same' });
  call('search');
  call('read_file');
  call('search');
  assert.equal(d.check(), null, '1.5 cycles is not stuck yet');
  call('read_file');
  const report = d.check();
  assert.ok(report);
  assert.equal(report.reason, 'tool-cycle');
  assert.equal(report.cycleCount, 2);
  assert.match(report.cycle, /search/);
});

test('stuck v2: pure helpers — checkStall / checkErrorRepeat / checkToolCycle / trailingCycle', () => {
  assert.equal(checkStall(1000, 2000, 60_000), null);
  assert.equal(checkStall(1000, 61_000, 60_000)?.reason, 'stall');
  assert.equal(checkErrorRepeat(['a', 'a'], 3), null);
  assert.equal(checkErrorRepeat(['a', 'a', 'a'], 3)?.reason, 'error-repeat');
  assert.equal(checkErrorRepeat(['a', 'b', 'a', 'a'], 3), null, 'only the trailing run counts');
  const history = ['s', 'r', 's', 'r'].map((tool) => ({
    tool,
    signature: `${tool}()`,
    at: 0,
  }));
  assert.deepEqual(trailingCycle(history), { a: 's()', b: 'r()', cycles: 2 });
  assert.equal(checkToolCycle(history, 2)?.reason, 'tool-cycle');
  assert.equal(checkToolCycle(history.slice(0, 3), 2), null);
});

test('stuck v2: thresholds are configurable', () => {
  const d = new StuckDetector({ repeatThreshold: 5, errorRepeatThreshold: 2 });
  d.recordToolCall('x', {});
  d.recordToolCall('x', {});
  d.recordToolCall('x', {});
  d.recordToolCall('x', {});
  assert.equal(d.check(), null, 'repeat threshold 5 not reached at 4');
  d.recordToolCall('x', {});
  assert.equal(d.check()?.reason, 'repeated-tool-call');
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

test('templates: four templates, each instantiates with its variables', () => {
  const templates = listPlanTemplates();
  assert.deepEqual(
    templates.map((t) => t.id),
    ['research', 'code-fix', 'automation', 'content'],
  );
  const research = instantiatePlanTemplate('research', { topic: 'moss', audience: 'team' });
  assert.equal(research.templateId, 'research');
  assert.equal(research.title, 'Research: moss');
  assert.equal(research.steps.length, 6);
  assert.ok(research.steps.every((s) => !s.includes('{')));
  assert.ok(research.steps.some((s) => s.includes('team')));
  // Optional variables fall back to their defaults.
  const researchDefault = instantiatePlanTemplate('research', { topic: 'moss' });
  assert.ok(researchDefault.steps.some((s) => s.includes('the team')));
  const fix = instantiatePlanTemplate('code-fix', { issue: 'crash on start' });
  assert.equal(fix.title, 'Fix: crash on start');
  assert.equal(fix.steps.length, 6);
  const auto = instantiatePlanTemplate('automation', { task: 'nightly backup' });
  assert.equal(auto.steps.length, 7);
  const content = instantiatePlanTemplate('content', { topic: 'gardening', format: 'post' });
  assert.equal(content.steps.length, 6);
  assert.ok(content.steps.every((s) => !s.includes('{')));
});

test('templates: missing required variable / unknown template throws', () => {
  assert.throws(() => instantiatePlanTemplate('research', {}), /needs a value for "topic"/);
  assert.throws(() => instantiatePlanTemplate('research', { topic: '   ' }), /needs a value for "topic"/);
  assert.throws(() => instantiatePlanTemplate('nope', {}), /Unknown plan template/);
  assert.equal(getPlanTemplate('nope'), null);
  assert.ok(getPlanTemplate('research'));
});

// ---------------------------------------------------------------------------
// Replan
// ---------------------------------------------------------------------------

test('replan: repeated-tool-call proposes skip + gather + retry; approve applies', () => {
  const engine = makeEngine();
  const plan = makePlan(engine);
  const step = engine.dispatch(plan.id, 'bot-1');
  const report = engine.recordStepToolCall(plan.id, step.id, 'read_file', { path: '/a' });
  engine.recordStepToolCall(plan.id, step.id, 'read_file', { path: '/a' });
  const stuck = engine.recordStepToolCall(plan.id, step.id, 'read_file', { path: '/a' });
  assert.ok(stuck && stuck.reason === 'repeated-tool-call');
  void report;
  const proposal = proposeReplan(engine.getPlan(plan.id), stuck);
  assert.ok(proposal);
  assert.equal(proposal.reason, 'repeated-tool-call');
  assert.deepEqual(
    proposal.changes.map((c) => c.type),
    ['skip', 'insert', 'insert'],
  );
  const updated = applyReplan(engine, proposal);
  assert.equal(proposal.decision, 'approved');
  const titles = updated.steps.map((s) => s.title);
  assert.ok(titles.some((t) => t.includes('Gather context')));
  assert.ok(titles.some((t) => t.includes('Retry')));
  assert.equal(updated.steps.find((s) => s.id === step.id)?.status, 'skipped');
});

test('replan: no-progress drops the failing tail and adds a re-scope step', () => {
  const engine = makeEngine();
  const plan = makePlan(engine, ['A', 'B', 'C', 'D']);
  // Fail three steps in a row (dispatch always claims the oldest pending step).
  for (let i = 0; i < 3; i++) {
    engine.dispatch(plan.id, 'bot-1');
    const running = engine.getPlan(plan.id).steps.find((s) => s.status === 'running');
    assert.ok(running);
    engine.failStep(plan.id, running.id, 'boom');
  }
  const stuck = engine.checkPlanStuck(plan.id);
  assert.ok(stuck && stuck.reason === 'no-progress');
  const proposal = proposeReplan(engine.getPlan(plan.id), stuck);
  assert.ok(proposal);
  assert.equal(proposal.changes.filter((c) => c.type === 'remove').length, 3);
  const updated = applyReplan(engine, proposal);
  assert.equal(updated.steps.length, 2, 'A + re-scope step');
  assert.ok(updated.steps.some((s) => s.title.includes('Re-scope')));
});

test('replan: stall keeps the step, inserts a state check; error-repeat inserts a diagnosis', () => {
  const engine = makeEngine();
  const plan = makePlan(engine, ['Only step']);
  const step = engine.dispatch(plan.id, 'bot-1');
  const stall = { reason: 'stall', detail: 'silent', suggestions: [] };
  const stallProposal = proposeReplan(engine.getPlan(plan.id), stall);
  assert.ok(stallProposal);
  assert.deepEqual(stallProposal.changes.map((c) => c.type), ['insert']);
  assert.equal(engine.getPlan(plan.id).steps.find((s) => s.id === step.id)?.status, 'running');

  const err = { reason: 'error-repeat', detail: 'same error', error: 'enoent', suggestions: [] };
  const errProposal = proposeReplan(engine.getPlan(plan.id), err);
  assert.ok(errProposal);
  assert.ok(errProposal.changes[0].title.includes('Find why'));
});

test('replan: reject leaves the plan alone; double decision throws', () => {
  const engine = makeEngine();
  const plan = makePlan(engine);
  const step = engine.dispatch(plan.id, 'bot-1');
  engine.recordStepToolCall(plan.id, step.id, 'x', {});
  engine.recordStepToolCall(plan.id, step.id, 'x', {});
  const stuck = engine.recordStepToolCall(plan.id, step.id, 'x', {});
  const proposal = proposeReplan(engine.getPlan(plan.id), stuck);
  const before = JSON.stringify(engine.getPlan(plan.id));
  rejectReplan(proposal);
  assert.equal(proposal.decision, 'rejected');
  assert.equal(JSON.stringify(engine.getPlan(plan.id)), before);
  assert.throws(() => applyReplan(engine, proposal), /already decided/);
  assert.throws(() => rejectReplan(proposal), /already decided/);
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test('persistence: save/load round-trip + list + delete', () => {
  const dir = tmpDir();
  const store = new PlanFileStore(dir);
  const engine = makeEngine();
  const plan = makePlan(engine, ['One', 'Two']);
  store.save({ plan, runId: 'run-1', botId: 'bot-1', savedAt: 0 });
  const loaded = store.load(plan.id);
  assert.ok(loaded);
  assert.equal(loaded.runId, 'run-1');
  assert.equal(loaded.plan.steps.length, 2);
  assert.equal(store.list().length, 1);
  assert.equal(store.delete(plan.id), true);
  assert.equal(store.load(plan.id), null);
  assert.equal(store.delete(plan.id), false);
});

test('persistence: resume resets running steps, keeps attempts, skips corrupt files', () => {
  const dir = tmpDir();
  const store = new PlanFileStore(dir);
  const engine = makeEngine();
  const plan = makePlan(engine, ['A', 'B']);
  const running = engine.dispatch(plan.id, 'bot-1');
  assert.equal(running.attempts, 1);
  store.save({ plan: engine.getPlan(plan.id), runId: 'run-9', botId: 'bot-1', savedAt: 0 });
  // A second, healthy plan + a corrupt file.
  const plan2 = engine.createPlan('Second', { ownerBotId: 'bot-1', steps: ['X'] });
  store.save({ plan: plan2, runId: null, botId: 'bot-1', savedAt: 0 });
  fs.writeFileSync(path.join(dir, 'run-plans', 'broken.json'), '{not json', 'utf8');

  const result = store.resumePlans();
  assert.equal(result.resumed.length, 1);
  assert.equal(result.resumed[0].plan.id, plan.id);
  assert.equal(result.resumed[0].plan.steps[0].status, 'pending');
  assert.equal(result.resumed[0].plan.steps[0].attempts, 1, 'attempts kept so the UI can show the interruption');
  assert.equal(result.resumed[0].runId, null);
  assert.equal(result.untouched.length, 1);
  assert.deepEqual(result.skipped, ['broken.json']);
  // The resumed plan on disk is now pending too.
  assert.equal(store.load(plan.id).plan.steps[0].status, 'pending');
});

test('persistence: resume skips excluded plans (a run is still alive)', () => {
  const dir = tmpDir();
  const store = new PlanFileStore(dir);
  const engine = makeEngine();
  const plan = makePlan(engine, ['A', 'B']);
  engine.dispatch(plan.id, 'bot-1');
  store.save({ plan: engine.getPlan(plan.id), runId: 'run-live', botId: 'bot-1', savedAt: 0 });
  // Excluding the live plan leaves its running step alone — resetting
  // it here would corrupt the run that owns it.
  const excluded = store.resumePlans(new Set([plan.id]));
  assert.equal(excluded.resumed.length, 0);
  assert.equal(excluded.untouched.length, 1);
  assert.equal(excluded.untouched[0].plan.steps[0].status, 'running');
  assert.equal(store.load(plan.id).plan.steps[0].status, 'running', 'disk copy untouched too');
  // Without the exclusion the same plan resumes as usual.
  const resumed = store.resumePlans();
  assert.equal(resumed.resumed.length, 1);
  assert.equal(resumed.resumed[0].plan.steps[0].status, 'pending');
});

test('persistence: unsafe plan ids are refused', () => {
  const store = new PlanFileStore(tmpDir());
  assert.throws(
    () => store.save({ plan: { id: '../escape', title: 'x', steps: [], createdAt: 0, updatedAt: 0 }, runId: null, botId: null, savedAt: 0 }),
    /Unsafe plan id/,
  );
});

// ---------------------------------------------------------------------------
// Run binding
// ---------------------------------------------------------------------------

function makeBinding(opts = {}) {
  const events = [];
  const binding = new RunPlanBinding({
    engine: makeEngine(),
    ...opts,
    onEvent: (e) => events.push(e),
  });
  return { binding, events };
}

test('binding: run dispatches the next step, run end completes it, next run takes the next step', () => {
  const { binding, events } = makeBinding();
  const plan = binding.createPlan('bot-1', 'Job', { steps: ['First', 'Second'] });
  assert.equal(binding.bindRun('run-1', 'bot-1', plan.id), true);
  assert.deepEqual(
    events.map((e) => e.type),
    ['run-started', 'step-started'],
  );
  assert.equal(events[1].plan.steps[0].status, 'running');
  binding.onToolCall('run-1', 'search', { q: 'hi' });
  const ended = binding.endRun('run-1', {});
  assert.equal(ended.steps[0].status, 'done');
  assert.equal(ended.steps[1].status, 'pending');
  assert.ok(events.some((e) => e.type === 'step-done'));
  assert.ok(events.some((e) => e.type === 'run-finished'));
  // Second run picks up the second step.
  binding.bindRun('run-2', 'bot-1', plan.id);
  binding.endRun('run-2', {});
  const final = binding.getPlan(plan.id);
  assert.equal(final.steps[1].status, 'done');
  assert.ok(events.some((e) => e.type === 'plan-finished'));
});

test('binding resume: a plan bound to a live run keeps its running step', () => {
  const dir = tmpDir();
  const store = new PlanFileStore(dir);
  const { binding } = makeBinding({ store });
  const plan = binding.createPlan('bot-1', 'Live job', { steps: ['First', 'Second'] });
  assert.equal(binding.bindRun('run-live', 'bot-1', plan.id), true);
  assert.equal(binding.getPlan(plan.id).steps[0].status, 'running');
  // Resume while the run is alive must NOT reset the running step —
  // PlanView calls resume on open, and a user opens it mid-run.
  const during = binding.resumeStoredPlans();
  assert.equal(during.resumed.length, 0, 'live plan is not resumed under its run');
  assert.equal(during.untouched.length, 1);
  assert.equal(during.untouched[0].plan.steps[0].status, 'running');
  assert.equal(store.load(plan.id).plan.steps[0].status, 'running', 'disk copy untouched too');
  // Once the run ends the exclusion lifts: the stopped step is
  // released to pending and a later resume finds nothing running.
  binding.endRun('run-live', { stopped: true });
  assert.equal(binding.getPlan(plan.id).steps[0].status, 'pending');
  const after = binding.resumeStoredPlans();
  assert.equal(after.resumed.length, 0);
  assert.equal(after.untouched.length, 1);
  assert.equal(after.untouched[0].plan.steps[0].status, 'pending');
});

test('binding: unknown plan / unknown run are safe no-ops', () => {
  const { binding, events } = makeBinding();
  assert.equal(binding.bindRun('run-x', 'bot-1', 'no-such-plan'), false);
  assert.equal(binding.onToolCall('run-x', 'search', {}), null);
  assert.equal(binding.endRun('run-x', {}), null);
  assert.deepEqual(events, []);
});

test('binding: repeated tool calls emit stuck once + a replan proposal; approve applies it', () => {
  const { binding, events } = makeBinding();
  const plan = binding.createPlan('bot-1', 'Job', { steps: ['Stuck step', 'Later'] });
  binding.bindRun('run-1', 'bot-1', plan.id);
  binding.onToolCall('run-1', 'read_file', { path: '/a' });
  binding.onToolCall('run-1', 'read_file', { path: '/a' });
  binding.onToolCall('run-1', 'read_file', { path: '/a' });
  const stuckEvents = events.filter((e) => e.type === 'stuck');
  assert.equal(stuckEvents.length, 1, 'one stuck event per step+reason');
  assert.equal(stuckEvents[0].stuck.reason, 'repeated-tool-call');
  const proposed = events.filter((e) => e.type === 'replan-proposed');
  assert.equal(proposed.length, 1);
  const proposalId = proposed[0].proposal.id;
  assert.equal(binding.listProposals(plan.id).length, 1);
  // A fourth identical call must NOT emit a second stuck/proposal.
  binding.onToolCall('run-1', 'read_file', { path: '/a' });
  assert.equal(events.filter((e) => e.type === 'stuck').length, 1);
  assert.equal(events.filter((e) => e.type === 'replan-proposed').length, 1);
  // Approve: the plan gains the replan steps and the stuck step is skipped.
  const { proposal, plan: updated } = binding.decideReplan(proposalId, 'approve', 'run-1');
  assert.equal(proposal.decision, 'approved');
  assert.ok(events.some((e) => e.type === 'replan-applied'));
  assert.ok(updated.steps.some((s) => s.title.includes('Gather context')));
  assert.throws(() => binding.decideReplan(proposalId, 'approve'), /already decided/);
  assert.throws(() => binding.decideReplan('nope', 'approve'), /Unknown replan proposal/);
});

test('binding: reject drops the proposal, plan unchanged', () => {
  const { binding, events } = makeBinding();
  const plan = binding.createPlan('bot-1', 'Job', { steps: ['Stuck step'] });
  binding.bindRun('run-1', 'bot-1', plan.id);
  for (let i = 0; i < 3; i++) binding.onToolCall('run-1', 'read_file', { path: '/a' });
  const proposalId = events.find((e) => e.type === 'replan-proposed').proposal.id;
  const before = JSON.stringify(binding.getPlan(plan.id));
  const { proposal } = binding.decideReplan(proposalId, 'reject', 'run-1');
  assert.equal(proposal.decision, 'rejected');
  assert.equal(JSON.stringify(binding.getPlan(plan.id)), before);
  assert.ok(events.some((e) => e.type === 'replan-rejected'));
});

test('binding: run error fails the step; stop releases it back to pending', () => {
  const { binding } = makeBinding();
  const plan = binding.createPlan('bot-1', 'Job', { steps: ['First', 'Second'] });
  binding.bindRun('run-1', 'bot-1', plan.id);
  const ended = binding.endRun('run-1', { error: 'provider exploded' });
  assert.equal(ended.steps[0].status, 'failed');
  assert.match(ended.steps[0].error, /provider exploded/);

  const plan2 = binding.createPlan('bot-1', 'Job 2', { steps: ['Only'] });
  binding.bindRun('run-2', 'bot-1', plan2.id);
  const stopped = binding.endRun('run-2', { stopped: true });
  assert.equal(stopped.steps[0].status, 'pending');
  assert.equal(stopped.steps[0].attempts, 1, 'the attempt is remembered');
});

test('binding: error-repeat via tool results proposes a replan', () => {
  const { binding, events } = makeBinding();
  const plan = binding.createPlan('bot-1', 'Job', { steps: ['Fragile step'] });
  binding.bindRun('run-1', 'bot-1', plan.id);
  binding.onToolCall('run-1', 'read_file', { path: '/a' });
  binding.onToolResult('run-1', false, 'timeout after 30s');
  binding.onToolCall('run-1', 'read_file', { path: '/b' });
  binding.onToolResult('run-1', false, 'timeout after 31s');
  binding.onToolCall('run-1', 'read_file', { path: '/c' });
  binding.onToolResult('run-1', false, 'timeout after 32s');
  const stuck = events.find((e) => e.type === 'stuck');
  assert.ok(stuck);
  assert.equal(stuck.stuck.reason, 'error-repeat');
  assert.equal(events.filter((e) => e.type === 'replan-proposed').length, 1);
});

test('binding: autoReplan off reports stuck but proposes nothing', () => {
  const { binding, events } = makeBinding({ autoReplan: 'off' });
  const plan = binding.createPlan('bot-1', 'Job', { steps: ['Stuck step'] });
  binding.bindRun('run-1', 'bot-1', plan.id);
  for (let i = 0; i < 3; i++) binding.onToolCall('run-1', 'x', {});
  assert.equal(events.filter((e) => e.type === 'stuck').length, 1);
  assert.equal(events.filter((e) => e.type === 'replan-proposed').length, 0);
});

test('binding: events carry a progress snapshot; persistence round-trips through the binding', () => {
  const dir = tmpDir();
  const store = new PlanFileStore(dir);
  const { binding } = makeBinding({ store });
  const plan = binding.createPlan('bot-1', 'Job', { steps: ['A', 'B'] });
  assert.ok(store.load(plan.id), 'create persists immediately');
  binding.bindRun('run-1', 'bot-1', plan.id);
  binding.endRun('run-1', {});
  const saved = store.load(plan.id);
  assert.equal(saved.plan.steps[0].status, 'done');
  // Resume after a restart: a fresh binding loads the stored plan.
  const { binding: fresh } = makeBinding({ store });
  const resumed = fresh.resumeStoredPlans();
  assert.equal(resumed.untouched.length, 1);
  assert.equal(fresh.getPlan(plan.id).steps[0].status, 'done');
});
