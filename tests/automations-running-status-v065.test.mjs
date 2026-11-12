/**
 * Regression tests: a `running` run record for EVERY launch source
 * (v0.65).
 *
 * Before this fix, `AutomationScheduler` only appended a run record
 * AFTER the action finished (`fire()` / `handleWebhook()` called
 * `appendRun` on the completed run), and `executeAutomation` created
 * its run with status `ok` up front. The only place a `running` state
 * was ever visible was the AutomationsView's ephemeral React state,
 * set when the user clicked Run in that view — scheduler ticks,
 * webhook deliveries and event triggers never showed `running`.
 *
 * Now every source writes a `running` record (no `finishedAt`) the
 * moment execution starts and updates that same record in place to
 * `ok` / `error` when it finishes: exactly one record per run, and
 * the final status is still correct when the action fails midway.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/automations-running-status-v065.test.mjs
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AutomationScheduler,
  JsonFileAutomationStore,
  computeWebhookSignature,
} from '../packages/core/dist/automations/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-auto-running-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

/** Let the async scheduler chain reach the (blocked) handler. */
async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/** A gate the test opens to let a blocked handler proceed. */
function makeGate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

function baseAutomation(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: 'auto-1',
    botId: 'bot-1',
    name: 'Test automation',
    trigger: { kind: 'interval', minutes: 30 },
    action: { kind: 'run-tool', tool: 'slow_tool', args: {} },
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeScheduler(dir, handlers, opts = {}) {
  const store = new JsonFileAutomationStore(dir);
  const scheduler = new AutomationScheduler(store, handlers, {
    now: () => new Date('2026-11-10T10:00:00.000Z'),
    ...opts,
  });
  return { scheduler, store };
}

/** Handlers whose run-tool blocks on `gate` (then optionally throws). */
function blockingHandlers(gate, { failAfterGate = false } = {}) {
  return {
    runAgent: async () => 'agent ok',
    runTool: async () => {
      await gate.promise;
      if (failAfterGate) throw new Error('tool boom');
      return 'tool ok';
    },
    createTask: async () => 'task-123',
    notify: () => undefined,
  };
}

// ---------------------------------------------------------------------------
// Scheduler tick (interval trigger)
// ---------------------------------------------------------------------------

test('tick: run record is "running" while the action executes, then "ok" — one record, same id', async () => {
  const dir = makeTempDir();
  const gate = makeGate();
  const { scheduler, store } = makeScheduler(dir, blockingHandlers(gate));
  scheduler.create(baseAutomation());

  const tickPromise = scheduler.tick();
  await flush();

  const midRuns = store.listRuns('auto-1');
  assert.equal(midRuns.length, 1, 'exactly one record while running (no duplicate)');
  assert.equal(midRuns[0].status, 'running');
  assert.equal(midRuns[0].finishedAt, undefined, 'in-flight record has no finishedAt');
  assert.equal(midRuns[0].trigger, 'interval');

  gate.release();
  const runs = await tickPromise;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'ok');

  const finalRuns = store.listRuns('auto-1');
  assert.equal(finalRuns.length, 1, 'still exactly one record after finishing (updated in place)');
  assert.equal(finalRuns[0].id, midRuns[0].id, 'same record id, not a second append');
  assert.equal(finalRuns[0].status, 'ok');
  assert.ok(finalRuns[0].finishedAt, 'finished record has finishedAt');
});

test('tick: a run that fails midway still shows "running" first, then ends "error" — one record', async () => {
  const dir = makeTempDir();
  const gate = makeGate();
  const { scheduler, store } = makeScheduler(dir, blockingHandlers(gate, { failAfterGate: true }));
  scheduler.create(baseAutomation());

  const tickPromise = scheduler.tick();
  await flush();

  const midRuns = store.listRuns('auto-1');
  assert.equal(midRuns.length, 1);
  assert.equal(midRuns[0].status, 'running');

  gate.release();
  const runs = await tickPromise;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'error');

  const finalRuns = store.listRuns('auto-1');
  assert.equal(finalRuns.length, 1, 'failed run is the same single record, not a second one');
  assert.equal(finalRuns[0].id, midRuns[0].id);
  assert.equal(finalRuns[0].status, 'error');
  assert.match(finalRuns[0].error ?? '', /tool boom/);
  assert.ok(finalRuns[0].finishedAt);
});

// ---------------------------------------------------------------------------
// Webhook delivery
// ---------------------------------------------------------------------------

test('webhook: run record is "running" while the action executes, then "ok" — one record, same id', async () => {
  const dir = makeTempDir();
  const gate = makeGate();
  const secret = 'test-webhook-secret';
  const { scheduler, store } = makeScheduler(dir, blockingHandlers(gate), {
    webhookKeyProvider: () => secret,
  });
  scheduler.create(
    baseAutomation({
      id: 'auto-web',
      trigger: { kind: 'webhook', keyId: 'auto-web' },
    }),
  );
  const body = '{"event":"deploy","ok":true}';
  const signature = computeWebhookSignature(secret, body);

  const deliveryPromise = scheduler.handleWebhook('auto-web', body, signature);
  await flush();

  const midRuns = store.listRuns('auto-web');
  assert.equal(midRuns.length, 1, 'exactly one record while running');
  assert.equal(midRuns[0].status, 'running');
  assert.equal(midRuns[0].finishedAt, undefined);
  assert.equal(midRuns[0].trigger, 'webhook');

  gate.release();
  const run = await deliveryPromise;
  assert.equal(run.status, 'ok');

  const finalRuns = store.listRuns('auto-web');
  assert.equal(finalRuns.length, 1, 'still exactly one record after finishing');
  assert.equal(finalRuns[0].id, midRuns[0].id);
  assert.equal(finalRuns[0].status, 'ok');
  assert.ok(finalRuns[0].finishedAt);
});

test('webhook: a rejected delivery (bad signature) records no run at all', async () => {
  const dir = makeTempDir();
  const gate = makeGate();
  const secret = 'test-webhook-secret';
  const { scheduler, store } = makeScheduler(dir, blockingHandlers(gate), {
    webhookKeyProvider: () => secret,
  });
  scheduler.create(
    baseAutomation({
      id: 'auto-web',
      trigger: { kind: 'webhook', keyId: 'auto-web' },
    }),
  );
  const body = '{"event":"deploy","ok":true}';

  await assert.rejects(
    () => scheduler.handleWebhook('auto-web', body, computeWebhookSignature('wrong-secret', body)),
    /Invalid webhook signature/,
  );
  assert.equal(store.listRuns('auto-web').length, 0, 'auth failure must not leave a running record');
});

// ---------------------------------------------------------------------------
// Event trigger
// ---------------------------------------------------------------------------

test('notifyEvent: run record is "running" while the action executes, then "ok" — one record', async () => {
  const dir = makeTempDir();
  const gate = makeGate();
  const { scheduler, store } = makeScheduler(dir, blockingHandlers(gate));
  scheduler.create(
    baseAutomation({
      id: 'auto-event',
      trigger: { kind: 'event', event: 'agent-done' },
    }),
  );

  const eventPromise = scheduler.notifyEvent({
    kind: 'agent-done',
    botId: 'bot-1',
    text: 'job finished',
    at: new Date().toISOString(),
  });
  await flush();

  const midRuns = store.listRuns('auto-event');
  assert.equal(midRuns.length, 1, 'exactly one record while running');
  assert.equal(midRuns[0].status, 'running');
  assert.equal(midRuns[0].finishedAt, undefined);
  assert.equal(midRuns[0].trigger, 'event');

  gate.release();
  const runs = await eventPromise;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'ok');

  const finalRuns = store.listRuns('auto-event');
  assert.equal(finalRuns.length, 1, 'still exactly one record after finishing');
  assert.equal(finalRuns[0].id, midRuns[0].id);
  assert.equal(finalRuns[0].status, 'ok');
  assert.ok(finalRuns[0].finishedAt);
});

// ---------------------------------------------------------------------------
// Store: updateRun never duplicates, never drops an unknown run
// ---------------------------------------------------------------------------

test('store.updateRun: replaces the record with the same id in place; appends when unknown', () => {
  const dir = makeTempDir();
  const store = new JsonFileAutomationStore(dir);
  const running = {
    id: 'run-1',
    automationId: 'auto-1',
    startedAt: '2026-11-10T10:00:00.000Z',
    status: 'running',
    trigger: 'manual',
  };
  const other = {
    id: 'run-2',
    automationId: 'auto-1',
    startedAt: '2026-11-10T09:00:00.000Z',
    finishedAt: '2026-11-10T09:00:01.000Z',
    status: 'ok',
    trigger: 'manual',
  };
  store.appendRun(other);
  store.appendRun(running);
  // Finish run-1: same id, updated in place.
  store.updateRun({ ...running, status: 'ok', finishedAt: '2026-11-10T10:00:02.000Z', output: 'done' });
  const runs = store.listRuns('auto-1');
  assert.equal(runs.length, 2, 'no duplicate record created');
  assert.equal(runs[1].id, 'run-1');
  assert.equal(runs[1].status, 'ok');
  assert.equal(runs[1].output, 'done');
  // A completion whose `running` record was never stored is kept, not dropped.
  store.updateRun({
    id: 'run-3',
    automationId: 'auto-1',
    startedAt: '2026-11-10T11:00:00.000Z',
    finishedAt: '2026-11-10T11:00:01.000Z',
    status: 'error',
    error: 'boom',
    trigger: 'manual',
  });
  const after = store.listRuns('auto-1');
  assert.equal(after.length, 3);
  assert.equal(after[2].id, 'run-3');
  assert.equal(after[2].status, 'error');
});
