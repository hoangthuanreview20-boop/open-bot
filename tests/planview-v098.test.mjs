/**
 * PlanView live run binding tests (v0.98, Team T4).
 *
 * Covers the renderer-side store functions PlanView uses to follow a
 * real coordinator run without polling:
 * - `uiPlanFromSnapshot`: coordinator snapshot -> UI shape (remote).
 * - `applyPlanEvent`: every `plan.event` type folds into the store
 *   (run-started / step-done / stuck / replan-proposed / applied /
 *   run-finished) — live flags, stuck report and pending proposal.
 * - `mergeRunPlans`: initial load + restart resume (list + resume
 *   views) — upsert by id, resumed flag, pending proposal only,
 *   local-only plans untouched.
 * - persistence round-trip: the v0.98 live fields survive
 *   stringify/parse, corrupt values fall back safely.
 *
 * Run: node --test tests/planview-v098.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPlanEvent,
  emptyPlanStore,
  mergeRunPlans,
  parsePlanStore,
  stringifyPlanStore,
  uiPlanFromSnapshot,
} from '../apps/desktop/src/renderer/components/planStore.ts';

function makeStep(id, title, status = 'pending') {
  return { id, title, status, assigneeBotId: null, attempts: 0 };
}

function makePlan(overrides = {}) {
  return {
    id: 'plan-1',
    title: 'Fix the bug',
    detail: 'Reproduce then fix',
    ownerBotId: 'bot-a',
    steps: [makeStep('s1', 'Reproduce'), makeStep('s2', 'Fix')],
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function makeEvent(type, plan, extra = {}) {
  return {
    type,
    runId: 'run-1',
    botId: 'bot-a',
    planId: plan.id,
    plan,
    progress: {
      total: 2,
      done: 0,
      failed: 0,
      skipped: 0,
      running: 0,
      pending: 2,
      percent: 0,
      finished: false,
    },
    ...extra,
  };
}

const stuckReport = {
  reason: 'stall',
  detail: 'No tool activity for 90s.',
  stalledForMs: 90000,
  suggestions: ['ask-user', 'skip-step'],
};

const proposal = {
  id: 'prop-1',
  planId: 'plan-1',
  stuckStepId: 's1',
  reason: 'stall',
  summary: 'Skip the stalled step and continue.',
  changes: [{ type: 'skip', stepId: 's1', reason: 'Step stalled.' }],
  decision: 'pending',
  createdAt: 3000,
  decidedAt: null,
};

test('uiPlanFromSnapshot: copies the plan and marks it remote', () => {
  const plan = uiPlanFromSnapshot(makePlan({ templateId: 'code-fix' }));
  assert.equal(plan.id, 'plan-1');
  assert.equal(plan.title, 'Fix the bug');
  assert.equal(plan.remote, true);
  assert.equal(plan.templateId, 'code-fix');
  assert.equal(plan.live, false);
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].status, 'pending');
});

test('applyPlanEvent: run-started adds an unknown plan as live', () => {
  const next = applyPlanEvent(emptyPlanStore(), makeEvent('run-started', makePlan()));
  assert.equal(next.plans.length, 1);
  assert.equal(next.plans[0].live, true);
  assert.equal(next.plans[0].runId, 'run-1');
  assert.equal(next.plans[0].remote, true);
});

test('applyPlanEvent: step-done refreshes steps and stays live', () => {
  const started = applyPlanEvent(emptyPlanStore(), makeEvent('run-started', makePlan()));
  const donePlan = makePlan({
    steps: [makeStep('s1', 'Reproduce', 'done'), makeStep('s2', 'Fix', 'running')],
  });
  const next = applyPlanEvent(started, makeEvent('step-done', donePlan, { stepId: 's1' }));
  assert.equal(next.plans[0].live, true);
  assert.equal(next.plans[0].steps[0].status, 'done');
  assert.equal(next.plans[0].steps[1].status, 'running');
});

test('applyPlanEvent: stuck keeps the live report for the banner', () => {
  const started = applyPlanEvent(emptyPlanStore(), makeEvent('run-started', makePlan()));
  const next = applyPlanEvent(started, makeEvent('stuck', makePlan(), { stuck: stuckReport }));
  assert.equal(next.plans[0].live, true);
  assert.equal(next.plans[0].stuck?.reason, 'stall');
  assert.equal(next.plans[0].stuck?.stalledForMs, 90000);
  assert.deepEqual(next.plans[0].stuck?.suggestions, ['ask-user', 'skip-step']);
});

test('applyPlanEvent: replan-proposed keeps the pending proposal', () => {
  const started = applyPlanEvent(emptyPlanStore(), makeEvent('run-started', makePlan()));
  const next = applyPlanEvent(
    started,
    makeEvent('replan-proposed', makePlan(), { stuck: stuckReport, proposal }),
  );
  assert.equal(next.plans[0].replanProposal?.id, 'prop-1');
  assert.equal(next.plans[0].replanProposal?.decision, 'pending');
  assert.equal(next.plans[0].replanProposal?.changes[0].type, 'skip');
  assert.equal(next.plans[0].stuck?.reason, 'stall');
});

test('applyPlanEvent: replan-applied clears proposal and stuck', () => {
  let store = applyPlanEvent(emptyPlanStore(), makeEvent('run-started', makePlan()));
  store = applyPlanEvent(store, makeEvent('replan-proposed', makePlan(), { proposal }));
  assert.equal(store.plans[0].replanProposal?.id, 'prop-1');
  const next = applyPlanEvent(store, makeEvent('replan-applied', makePlan()));
  assert.equal(next.plans[0].replanProposal, null);
  assert.equal(next.plans[0].stuck, null);
});

test('applyPlanEvent: run-finished / run-stopped / plan-finished clear live state', () => {
  for (const type of ['run-finished', 'run-stopped', 'plan-finished']) {
    let store = applyPlanEvent(emptyPlanStore(), makeEvent('run-started', makePlan()));
    store = applyPlanEvent(store, makeEvent('stuck', makePlan(), { stuck: stuckReport }));
    const next = applyPlanEvent(store, makeEvent(type, makePlan()));
    assert.equal(next.plans[0].live, false, type);
    assert.equal(next.plans[0].runId, null, type);
    assert.equal(next.plans[0].stuck, null, type);
    assert.equal(next.plans[0].replanProposal, null, type);
  }
});

test('applyPlanEvent: keeps the existing templateId when the snapshot has none', () => {
  const withTemplate = makePlan({ templateId: 'code-fix' });
  let store = applyPlanEvent(emptyPlanStore(), makeEvent('run-started', withTemplate));
  assert.equal(store.plans[0].templateId, 'code-fix');
  const bare = makePlan({ templateId: undefined });
  delete bare.templateId;
  store = applyPlanEvent(store, makeEvent('step-started', bare, { stepId: 's1' }));
  assert.equal(store.plans[0].templateId, 'code-fix');
});

test('mergeRunPlans: upserts remote plans, leaves local-only plans alone', () => {
  const local = makePlan({ id: 'local-1', title: 'Local plan', remote: false });
  const store = { plans: [local], toolHistory: {} };
  const remote = makePlan({ id: 'plan-1', title: 'Remote plan' });
  const next = mergeRunPlans(store, [
    { plan: remote, runId: null, botId: 'bot-a', templateId: 'code-fix', proposals: [] },
  ]);
  assert.equal(next.plans.length, 2);
  assert.equal(next.plans.find((p) => p.id === 'local-1')?.title, 'Local plan');
  const merged = next.plans.find((p) => p.id === 'plan-1');
  assert.equal(merged?.remote, true);
  assert.equal(merged?.templateId, 'code-fix');
  assert.equal(merged?.live, false);
  assert.equal(merged?.runId, null);
});

test('mergeRunPlans: resumed ids are flagged, pending proposals kept', () => {
  const remote = makePlan();
  const decided = { ...proposal, id: 'prop-2', decision: 'approved' };
  const next = mergeRunPlans(
    emptyPlanStore(),
    [{ plan: remote, runId: null, botId: 'bot-a', proposals: [proposal, decided] }],
    new Set(['plan-1']),
  );
  assert.equal(next.plans[0].resumed, true);
  assert.equal(next.plans[0].replanProposal?.id, 'prop-1');
});

test('mergeRunPlans: a decided proposal is not kept as pending', () => {
  const remote = makePlan();
  const decided = { ...proposal, decision: 'rejected' };
  const next = mergeRunPlans(emptyPlanStore(), [
    { plan: remote, runId: null, botId: 'bot-a', proposals: [decided] },
  ]);
  assert.equal(next.plans[0].replanProposal, null);
});

test('persistence: v0.98 live fields survive stringify/parse', () => {
  const plan = makePlan({
    runId: 'run-9',
    live: true,
    stuck: stuckReport,
    replanProposal: proposal,
    resumed: true,
    templateId: 'research',
    remote: true,
  });
  const store = { plans: [plan], toolHistory: {} };
  const parsed = parsePlanStore(stringifyPlanStore(store));
  assert.equal(parsed.plans.length, 1);
  const back = parsed.plans[0];
  assert.equal(back.runId, 'run-9');
  assert.equal(back.live, true);
  assert.equal(back.stuck?.reason, 'stall');
  assert.equal(back.replanProposal?.id, 'prop-1');
  assert.equal(back.replanProposal?.changes[0].type, 'skip');
  assert.equal(back.resumed, true);
  assert.equal(back.templateId, 'research');
  assert.equal(back.remote, true);
});

test('persistence: corrupt live fields fall back safely', () => {
  const raw = JSON.stringify({
    plans: [
      {
        id: 'bad-1',
        title: 'Bad',
        steps: [{ id: 's1', title: 'One', status: 'exploding', attempts: 'many' }],
        createdAt: 1,
        updatedAt: 2,
        live: 'yes',
        stuck: { reason: 'unknown-reason', detail: 'x', suggestions: 'nope' },
        replanProposal: { id: 'p', planId: 'bad-1', reason: 'unknown-reason' },
        resumed: 'yes',
        remote: 'yes',
      },
    ],
    toolHistory: {},
  });
  const parsed = parsePlanStore(raw);
  assert.equal(parsed.plans.length, 1);
  const back = parsed.plans[0];
  assert.equal(back.live, false);
  assert.equal(back.stuck, null);
  assert.equal(back.replanProposal, null);
  assert.equal(back.resumed, false);
  assert.equal(back.remote, false);
  assert.equal(back.steps[0].status, 'pending');
  assert.equal(back.steps[0].attempts, 0);
});
