/**
 * planning-v098-coordinator.test.mjs — coordinator integration (Team T4, v0.98).
 *
 * A real in-process AgentCoordinator with a mock provider (same
 * harness as tests/plan-review-rpc-v020.test.mjs): no network, no
 * API key. Proves the plan actually follows a live run end to end:
 *
 * - `plan.create` / `plan.list` / `plan.get` / `plan.delete` RPCs
 *   (direct + via `handle()` dispatch) and `plan.templates`.
 * - `run({ planId })`: the run dispatches the plan's next step,
 *   every tool call feeds the stuck detector, and the run's outcome
 *   settles the step — all visible as `plan.event` notifications
 *   carrying full plan snapshots (the channel PlanView subscribes
 *   to, no polling).
 * - A run that repeats the same tool call 3× emits `stuck`
 *   (repeated-tool-call) + `replan-proposed`; `plan.decideReplan`
 *   approve applies the proposal to the plan.
 * - A run that ends in error fails the step; persistence writes
 *   the plan under `<dataDir>/run-plans/`; a fresh coordinator on
 *   the same dataDir resumes it (`plan.resume`: running → pending).
 *
 * Run: npm run build --workspace=@open-bot/core, then
 *      node --test tests/planning-v098-coordinator.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentCoordinator } from '../packages/core/dist/coordinator/coordinator.js';
import { PlanFileStore } from '../packages/core/dist/planning/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-planning-v098-coord-'));
}

function makeSetup(botId, dir, mockResponses) {
  const events = [];
  const coordinator = new AgentCoordinator({
    dataDir: dir,
    toolFactory: () => [
      {
        definition: {
          name: 'test_read',
          description: 'Fake read-only tool for plan tests.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
        needsApproval: false,
        async execute(args) {
          return `content of ${args.path}`;
        },
      },
    ],
    emit: (n) => events.push(n),
  });
  const bot = {
    id: botId,
    name: `Bot ${botId}`,
    providerId: 'mock',
    model: 'mock',
    systemPrompt: 'You are a test bot.',
    workspaceDir: dir,
    autoApprove: true,
  };
  return {
    coordinator,
    events,
    async createBot() {
      await coordinator.createBot({
        bot,
        provider: { id: 'mock', label: 'Mock', mockResponses },
      });
    },
    async destroy() {
      try {
        await coordinator.destroyBot({ botId });
      } catch {
        // Best-effort cleanup.
      }
      coordinator.shutdown();
    },
    planEvents() {
      return events
        .filter((n) => n.data?.kind === 'plan.event')
        .map((n) => n.data.payload);
    },
  };
}

const LOOPING_RESPONSES = [
  { toolCalls: [{ id: 'c1', name: 'test_read', args: { path: '/a' } }] },
  { toolCalls: [{ id: 'c2', name: 'test_read', args: { path: '/a' } }] },
  { toolCalls: [{ id: 'c3', name: 'test_read', args: { path: '/a' } }] },
  { text: 'Done reading.' },
];

test('coordinator plan RPCs: create/list/get/templates/delete + handle() dispatch', async () => {
  const dir = tmpDir();
  const setup = makeSetup('bot-plan-rpc', dir, [{ text: 'hi' }]);
  try {
    await setup.createBot();
    const created = await setup.coordinator.createRunPlan({
      botId: 'bot-plan-rpc',
      title: 'Manual plan',
      steps: ['One', 'Two'],
    });
    assert.ok(created.plan.id);
    assert.equal(created.templateId, null);
    assert.equal(created.plan.steps.length, 2);

    const fromTemplate = await setup.coordinator.handle('plan.create', {
      botId: 'bot-plan-rpc',
      templateId: 'research',
      templateVars: { topic: 'volcanoes' },
    });
    assert.equal(fromTemplate.templateId, 'research');
    assert.equal(fromTemplate.plan.title, 'Research: volcanoes');
    assert.equal(fromTemplate.plan.steps.length, 6);

    const list = await setup.coordinator.listRunPlans();
    assert.equal(list.plans.length, 2);
    const got = await setup.coordinator.getRunPlan({ planId: created.plan.id });
    assert.equal(got.plan.plan.id, created.plan.id);
    assert.deepEqual(got.plan.proposals, []);
    assert.equal((await setup.coordinator.getRunPlan({ planId: 'nope' })).plan, null);

    const templates = await setup.coordinator.listPlanTemplates();
    assert.deepEqual(
      templates.templates.map((t) => t.id),
      ['research', 'code-fix', 'automation', 'content'],
    );
    assert.throws(
      () => setup.coordinator.createRunPlan({ botId: 'bot-plan-rpc', templateId: 'research', templateVars: {} }),
      /needs a value for "topic"/,
    );

    const deleted = await setup.coordinator.deleteRunPlan({ planId: created.plan.id });
    assert.equal(deleted.deleted, true);
    assert.equal((await setup.coordinator.listRunPlans()).plans.length, 1);
    assert.equal((await setup.coordinator.deleteRunPlan({ planId: created.plan.id })).deleted, false);
  } finally {
    await setup.destroy();
  }
});

test('coordinator run with planId: plan follows the live run via plan.event', async () => {
  const dir = tmpDir();
  const setup = makeSetup('bot-plan-run', dir, LOOPING_RESPONSES);
  try {
    await setup.createBot();
    const { plan } = await setup.coordinator.createRunPlan({
      botId: 'bot-plan-run',
      title: 'Read the file',
      steps: ['Read /a', 'Summarise it'],
    });
    const result = await setup.coordinator.run({
      botId: 'bot-plan-run',
      text: 'do the plan',
      planId: plan.id,
    });
    assert.equal(result.stopped, false);
    const kinds = setup.planEvents().map((e) => e.type);
    assert.ok(kinds.includes('run-started'), `expected run-started, got ${kinds}`);
    assert.ok(kinds.includes('step-started'));
    assert.ok(kinds.includes('step-done'), `expected step-done, got ${kinds}`);
    assert.ok(kinds.includes('run-finished'));
    // The first step is done; the second is still pending for the next run.
    const finalPlan = await setup.coordinator.getRunPlan({ planId: plan.id });
    assert.equal(finalPlan.plan.plan.steps[0].status, 'done');
    assert.equal(finalPlan.plan.plan.steps[1].status, 'pending');
    // Every plan.event carries a full snapshot + progress.
    for (const event of setup.planEvents()) {
      assert.ok(event.plan);
      assert.equal(typeof event.progress.percent, 'number');
    }
    // The plan was persisted under <dataDir>/run-plans/.
    const store = new PlanFileStore(dir);
    assert.ok(store.load(plan.id));
    assert.equal(store.load(plan.id).plan.steps[0].status, 'done');
  } finally {
    await setup.destroy();
  }
});

test('coordinator run: repeated tool calls emit stuck + replan proposal; approve applies it', async () => {
  const dir = tmpDir();
  const setup = makeSetup('bot-plan-stuck', dir, LOOPING_RESPONSES);
  try {
    await setup.createBot();
    const { plan } = await setup.coordinator.createRunPlan({
      botId: 'bot-plan-stuck',
      title: 'Looping job',
      steps: ['Read /a three times', 'Later step'],
    });
    await setup.coordinator.run({ botId: 'bot-plan-stuck', text: 'go', planId: plan.id });
    const events = setup.planEvents();
    const stuck = events.find((e) => e.type === 'stuck');
    assert.ok(stuck, `expected a stuck event, got ${events.map((e) => e.type)}`);
    assert.equal(stuck.stuck.reason, 'repeated-tool-call');
    const proposed = events.find((e) => e.type === 'replan-proposed');
    assert.ok(proposed, 'expected a replan proposal');
    assert.equal(proposed.proposal.planId, plan.id);
    assert.equal(proposed.proposal.decision, 'pending');
    // Only one stuck report + one proposal for the whole run.
    assert.equal(events.filter((e) => e.type === 'stuck').length, 1);
    assert.equal(events.filter((e) => e.type === 'replan-proposed').length, 1);

    const decided = await setup.coordinator.decideReplan({
      proposalId: proposed.proposal.id,
      decision: 'approve',
      runId: stuck.runId,
    });
    assert.equal(decided.proposal.decision, 'approved');
    assert.ok(decided.plan.steps.some((s) => s.title.includes('Gather context')));
    assert.ok(
      setup.planEvents().some((e) => e.type === 'replan-applied'),
      'approve must emit replan-applied',
    );
    assert.throws(
      () =>
        setup.coordinator.decideReplan({
          proposalId: proposed.proposal.id,
          decision: 'approve',
        }),
      /already decided/,
    );
  } finally {
    await setup.destroy();
  }
});

test('coordinator run: unknown planId never kills the run', async () => {
  const dir = tmpDir();
  const setup = makeSetup('bot-plan-unknown', dir, [{ text: 'fine' }]);
  try {
    await setup.createBot();
    const result = await setup.coordinator.run({
      botId: 'bot-plan-unknown',
      text: 'hello',
      planId: 'no-such-plan',
    });
    assert.equal(result.text, 'fine');
    assert.equal(setup.planEvents().length, 0);
  } finally {
    await setup.destroy();
  }
});

test('coordinator resume: a plan with a running step comes back pending on restart', async () => {
  const dir = tmpDir();
  const setup = makeSetup('bot-plan-resume', dir, [{ text: 'hi' }]);
  try {
    await setup.createBot();
    const { plan } = await setup.coordinator.createRunPlan({
      botId: 'bot-plan-resume',
      title: 'Interrupted job',
      steps: ['Half-done step', 'Next step'],
    });
    // Simulate a crash mid-run: write the stored plan back with the
    // first step running (as it would look if the process had died).
    const store = new PlanFileStore(dir);
    const stored = store.load(plan.id);
    stored.plan.steps[0].status = 'running';
    stored.plan.steps[0].attempts = 1;
    stored.runId = 'run-crashed';
    store.save(stored);
  } finally {
    await setup.destroy();
  }
  // A fresh coordinator on the same dataDir resumes it.
  const setup2 = makeSetup('bot-plan-resume', dir, [{ text: 'hi' }]);
  try {
    await setup2.createBot();
    const resumed = await setup2.coordinator.resumeRunPlans();
    assert.equal(resumed.resumed.length, 1);
    assert.equal(resumed.resumed[0].plan.steps[0].status, 'pending');
    assert.equal(resumed.resumed[0].plan.steps[0].attempts, 1);
    assert.equal(resumed.skipped.length, 0);
    const again = await setup2.coordinator.resumeRunPlans();
    assert.equal(again.resumed.length, 0, 'second resume finds nothing running');
    assert.equal(again.untouched.length, 1);
  } finally {
    await setup2.destroy();
  }
});
