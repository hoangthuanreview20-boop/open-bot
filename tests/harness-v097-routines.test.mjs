/**
 * Tests for harness v2 — routines v2 (v0.97, Team T5).
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/harness-v097-routines.test.mjs
 *
 * No provider, no network, no real clock: the manager runs against
 * an in-memory store and a fake executor, with an injected clock the
 * tests advance by hand. Queue + retry + missed-run behaviour is
 * what is under test, not any real agent run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  JsonFileRoutineStore,
  MemoryRoutineStore,
  RoutineManager,
  nextRoutineRunAt,
  routineBackoffMs,
  routineDue,
  validateRoutine,
} from '../packages/core/dist/index.js';

function baseRoutine(overrides = {}) {
  return {
    id: 'routine-1',
    botId: '',
    name: 'Morning digest',
    trigger: { kind: 'interval', minutes: 60 },
    action: { kind: 'notify', message: 'hello' },
    enabled: true,
    createdAt: '2026-11-13T00:00:00.000Z',
    updatedAt: '2026-11-13T00:00:00.000Z',
    ...overrides,
  };
}

function makeManager(executor, opts = {}) {
  let nowMs = new Date('2026-11-13T12:00:00.000Z').getTime();
  const store = new MemoryRoutineStore();
  const manager = new RoutineManager(store, executor, {
    now: () => new Date(nowMs),
    ...opts,
  });
  return {
    manager,
    store,
    now: () => new Date(nowMs),
    advance: (ms) => {
      nowMs += ms;
    },
  };
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// --- pure helpers ---------------------------------------------------------

test('v0.97 routines: validateRoutine catches bad interval / cron / action / attempts', () => {
  assert.deepEqual(validateRoutine(baseRoutine()), []);
  assert.ok(validateRoutine(baseRoutine({ name: '  ' })).length > 0);
  assert.ok(validateRoutine(baseRoutine({ trigger: { kind: 'interval', minutes: 0 } })).length > 0);
  assert.ok(validateRoutine(baseRoutine({ trigger: { kind: 'cron', expression: 'not a cron' } })).length > 0);
  assert.deepEqual(validateRoutine(baseRoutine({ trigger: { kind: 'cron', expression: '0 9 * * *' } })), []);
  assert.ok(validateRoutine(baseRoutine({ trigger: { kind: 'webhook', keyId: '' } })).length > 0);
  assert.ok(validateRoutine(baseRoutine({ action: { kind: 'run-agent', botId: '', prompt: '' } })).length > 0);
  assert.ok(validateRoutine(baseRoutine({ action: { kind: 'run-tool', tool: '' } })).length > 0);
  assert.ok(validateRoutine(baseRoutine({ maxAttempts: 0 })).length > 0);
  assert.ok(validateRoutine(baseRoutine({ maxAttempts: 11 })).length > 0);
  assert.ok(validateRoutine(baseRoutine({ retryBackoffMs: -1 })).length > 0);
  assert.ok(validateRoutine(baseRoutine({ maxQueuedRuns: 0 })).length > 0);
});

test('v0.97 routines: nextRoutineRunAt + routineDue for interval and cron', () => {
  const from = new Date('2026-11-13T12:00:00.000Z');
  const neverRun = baseRoutine();
  assert.equal(nextRoutineRunAt(neverRun, from).getTime(), from.getTime());
  assert.equal(routineDue(neverRun, from), true);
  const lastHour = baseRoutine({ lastRunAt: '2026-11-13T11:00:00.000Z' });
  assert.equal(nextRoutineRunAt(lastHour, from).getTime(), new Date('2026-11-13T12:00:00.000Z').getTime());
  assert.equal(routineDue(lastHour, from), true);
  const justRan = baseRoutine({ lastRunAt: '2026-11-13T11:59:00.000Z' });
  assert.equal(routineDue(justRan, from), false);
  const cron = baseRoutine({ trigger: { kind: 'cron', expression: '0 9 * * *' }, lastRunAt: '2026-11-13T08:00:00.000Z' });
  const next = nextRoutineRunAt(cron, from);
  assert.equal(next.getUTCHours(), 9);
  assert.equal(next.getUTCDate(), 14);
  assert.equal(nextRoutineRunAt(baseRoutine({ trigger: { kind: 'manual' } }), from), null);
  assert.equal(routineDue(baseRoutine({ trigger: { kind: 'manual' } }), from), false);
  assert.equal(routineDue(baseRoutine({ enabled: false }), from), false);
});

test('v0.97 routines: routineBackoffMs doubles and caps at 5 minutes', () => {
  assert.equal(routineBackoffMs(5000, 1), 5000);
  assert.equal(routineBackoffMs(5000, 2), 10000);
  assert.equal(routineBackoffMs(5000, 3), 20000);
  assert.equal(routineBackoffMs(5000, 10), 300000);
  assert.equal(routineBackoffMs(60000, 10), 300000);
});

// --- manager --------------------------------------------------------------

test('v0.97 routines: create validates, runNow executes through the executor, run is recorded ok', async () => {
  const seen = [];
  const { manager, store } = makeManager(async (routine, input) => {
    seen.push({ routine, input });
    return 'done: hello';
  });
  const routine = manager.create(baseRoutine());
  assert.equal(routine.nextRunAt, '2026-11-13T12:00:00.000Z');
  assert.throws(() => manager.create(baseRoutine({ id: 'bad', trigger: { kind: 'cron', expression: 'xx' } })), /Invalid routine/);
  const run = manager.runNow('routine-1', { from: 'test' });
  assert.equal(run.status, 'queued');
  assert.equal(run.source, 'manual');
  const finished = await waitFor(
    () => store.listRuns('routine-1').find((r) => r.status === 'ok'),
    'run to finish ok',
  );
  assert.equal(finished.output, 'done: hello');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].input, { from: 'test' });
  assert.equal(manager.queueStatus('routine-1').queued, 0);
  assert.equal(manager.queueStatus('routine-1').running, false);
});

test('v0.97 routines: a failing executor retries with backoff, then succeeds on the third attempt', async () => {
  let calls = 0;
  const { manager, store, advance } = makeManager(async () => {
    calls += 1;
    if (calls < 3) throw new Error(`boom ${calls}`);
    return 'third time ok';
  });
  manager.create(baseRoutine({ trigger: { kind: 'manual' }, maxAttempts: 3, retryBackoffMs: 5000 }));
  manager.runNow('routine-1');
  const retrying = await waitFor(
    () => store.listRuns('routine-1').find((r) => r.status === 'retrying'),
    'first failure to become retrying',
  );
  assert.equal(retrying.attempt, 1);
  assert.equal(retrying.error, 'boom 1');
  assert.ok(retrying.nextRetryAt);
  // Backoff has not elapsed yet: a tick does nothing new.
  await manager.tick();
  assert.equal(store.listRuns('routine-1').length, 1);
  // Advance past the 5 s backoff: tick re-enqueues attempt 2.
  advance(6000);
  await manager.tick();
  const retrying2 = await waitFor(
    () => store.listRuns('routine-1').find((r) => r.status === 'retrying' && r.attempt === 2),
    'second failure to become retrying',
  );
  assert.equal(retrying2.error, 'boom 2');
  assert.equal(retrying2.retriedFromRunId, retrying.id);
  // Advance past the 10 s backoff (5000 * 2): attempt 3 succeeds.
  advance(11000);
  await manager.tick();
  const ok = await waitFor(
    () => store.listRuns('routine-1').find((r) => r.status === 'ok'),
    'third attempt to succeed',
  );
  assert.equal(ok.attempt, 3);
  assert.equal(ok.output, 'third time ok');
  assert.equal(calls, 3);
  // The last failed run now counts as resolved (a later ok run points at it).
  assert.equal(manager.lastFailedRun('routine-1'), undefined);
});

test('v0.97 routines: attempts are exhausted after maxAttempts — run stays error, no more retries', async () => {
  let calls = 0;
  const { manager, store, advance } = makeManager(async () => {
    calls += 1;
    throw new Error('always fails');
  });
  // Manual trigger: ticks must never fire a scheduled run here, so
  // every executor call in this test is a retry under test.
  manager.create(baseRoutine({ trigger: { kind: 'manual' }, maxAttempts: 2, retryBackoffMs: 1000 }));
  manager.runNow('routine-1');
  await waitFor(() => store.listRuns('routine-1').find((r) => r.status === 'retrying'), 'retrying');
  advance(2000);
  await manager.tick();
  const failed = await waitFor(
    () => store.listRuns('routine-1').find((r) => r.status === 'error'),
    'final error',
  );
  assert.equal(failed.attempt, 2);
  assert.equal(calls, 2);
  // Another tick + time does not spawn a third attempt.
  advance(60000);
  await manager.tick();
  assert.equal(store.listRuns('routine-1').filter((r) => r.status === 'error').length, 1);
  assert.equal(manager.lastFailedRun('routine-1')?.id, failed.id);
});

test('v0.97 routines: queue is bounded — extra triggers drop and are counted, runs stay sequential', async () => {
  const started = [];
  const { manager, store } = makeManager(async (routine) => {
    started.push(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 30));
    return 'ok';
  });
  manager.create(baseRoutine({ maxQueuedRuns: 2 }));
  // Enqueue 3 while the worker is busy: the third is dropped.
  const r1 = manager.enqueue('routine-1', 'manual');
  const r2 = manager.enqueue('routine-1', 'manual');
  const r3 = manager.enqueue('routine-1', 'manual');
  assert.ok(r1 && r2 && r3);
  const dropped = manager.enqueue('routine-1', 'manual');
  assert.equal(dropped, null);
  assert.deepEqual(manager.droppedTriggerCounts(), { 'routine-1': 1 });
  await waitFor(() => store.listRuns('routine-1').filter((r) => r.status === 'ok').length === 3, '3 runs ok');
  assert.equal(manager.queueStatus('routine-1').queued, 0);
});

test('v0.97 routines: tick fires due schedules and records a missed run as skipped (no catch-up)', async () => {
  const { manager, store, advance } = makeManager(async () => 'ok');
  manager.create(baseRoutine({ trigger: { kind: 'interval', minutes: 60 } }));
  const produced = await manager.tick();
  assert.equal(produced.length, 1);
  assert.equal(produced[0].source, 'schedule');
  await waitFor(() => store.listRuns('routine-1').find((r) => r.status === 'ok'), 'scheduled run ok');

  // Simulate the app being off for 3 hours: write a stale nextRunAt
  // straight into the store (update() would clamp it to now, which is
  // the live behaviour for an edited routine — here we model a tick
  // that never ran while the app was off).
  advance(3 * 60 * 60 * 1000);
  const routine = manager.get('routine-1');
  store.save({ ...routine, nextRunAt: new Date('2026-11-13T13:00:00.000Z').toISOString() });
  const skipped = await manager.tick();
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].status, 'skipped');
  assert.match(skipped[0].output ?? '', /no catch-up run/);
  // Exactly one skipped record — no burst.
  assert.equal(store.listRuns('routine-1').filter((r) => r.status === 'skipped').length, 1);
});

test('v0.97 routines: webhook + event delivery enqueue; disabled / unknown routines get nothing', async () => {
  const { manager, store } = makeManager(async () => 'ok');
  manager.create(baseRoutine({ id: 'wh', trigger: { kind: 'webhook', keyId: 'wh' } }));
  manager.create(baseRoutine({ id: 'ev', trigger: { kind: 'event', event: 'agent-done' } }));
  manager.create(baseRoutine({ id: 'off', trigger: { kind: 'event', event: 'agent-done' }, enabled: false }));
  const run = manager.deliverWebhook('wh', { text: 'hi' });
  assert.ok(run);
  assert.equal(run.source, 'webhook');
  assert.equal(manager.deliverWebhook('routine-missing', {}), null);
  assert.equal(manager.deliverWebhook('ev', {}), null); // not a webhook routine
  const eventRuns = manager.notifyEvent('agent-done', { text: 'done' });
  assert.equal(eventRuns.length, 1); // 'off' is disabled, so only 'ev'
  assert.equal(eventRuns[0].routineId, 'ev');
  await waitFor(() => store.listRuns().filter((r) => r.status === 'ok').length === 2, 'webhook + event runs ok');
});

test('v0.97 routines: retryRun re-runs a failed run with the same input; setEnabled validates', async () => {
  const inputs = [];
  const { manager, store } = makeManager(async (_routine, input) => {
    inputs.push(input);
    if (inputs.length === 1) throw new Error('first fails');
    return 'second ok';
  });
  manager.create(baseRoutine({ maxAttempts: 1 }));
  manager.runNow('routine-1', { payload: 42 });
  const failed = await waitFor(
    () => store.listRuns('routine-1').find((r) => r.status === 'error'),
    'run fails',
  );
  assert.throws(() => manager.retryRun('no-such-run'), /No routine run/);
  const retried = manager.retryRun(failed.id);
  assert.equal(retried.retriedFromRunId, failed.id);
  await waitFor(() => store.listRuns('routine-1').find((r) => r.status === 'ok'), 'retry ok');
  assert.deepEqual(inputs[1], { payload: 42 });
  // Enabling a routine whose definition went bad is refused.
  const bad = baseRoutine({ id: 'bad-cron', trigger: { kind: 'cron', expression: 'xx' }, enabled: false });
  store.save(bad);
  assert.throws(() => manager.setEnabled('bad-cron', true), /Cannot enable routine/);
});

test('v0.97 routines: reconcileInterruptedRuns marks orphaned runs error and clears queues', async () => {
  const { manager, store } = makeManager(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return 'ok';
  });
  manager.create(baseRoutine());
  manager.runNow('routine-1');
  // Reconcile while the run is still in flight: it is marked error.
  const fixed = manager.reconcileInterruptedRuns();
  assert.equal(fixed.length, 1);
  assert.equal(fixed[0].status, 'error');
  assert.match(fixed[0].error ?? '', /Interrupted/);
  // Idempotent: a second call finds nothing.
  assert.deepEqual(manager.reconcileInterruptedRuns(), []);
  assert.equal(store.listRuns('routine-1').filter((r) => r.status === 'running').length, 0);
});

test('v0.97 routines: JsonFileRoutineStore round-trips routines + runs and survives a corrupt file', async () => {
  const dir = tmpDir('open-bot-h2-routines-');
  const store = new JsonFileRoutineStore(dir);
  const routine = baseRoutine();
  store.save(routine);
  assert.deepEqual(store.list(), [routine]);
  store.appendRun({
    id: 'run-1', routineId: 'routine-1', source: 'manual', status: 'ok',
    attempt: 1, maxAttempts: 3, queuedAt: '2026-11-13T12:00:00.000Z',
  });
  assert.equal(store.listRuns('routine-1').length, 1);
  assert.equal(store.remove('routine-1'), true);
  assert.equal(store.remove('routine-1'), false);
  // Corrupt file loads as empty and is kept for inspection.
  fs.writeFileSync(path.join(dir, 'routines-v2.json'), '{broken', 'utf8');
  assert.deepEqual(store.list(), []);
  assert.ok(fs.existsSync(path.join(dir, 'routines-v2.json.corrupt')));
});

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
