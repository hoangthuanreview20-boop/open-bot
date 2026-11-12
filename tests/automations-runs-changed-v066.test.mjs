/**
 * Tests for v0.66a: `onRunChanged` callback + `reconcileInterruptedRuns`.
 *
 * - `onRunChanged` fires after EVERY run write (started `running` and
 *   finished `ok` / `error` / `skipped`) for every source: tick,
 *   run-now, retry, event, webhook, skipped. A throwing callback must
 *   never break the run itself.
 * - `reconcileInterruptedRuns` marks orphan `running` records (the app
 *   stopped mid-run) as `error` with `finishedAt` + a clear note:
 *   idempotent, never touches finished runs, and never touches a run
 *   created after the call.
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/automations-runs-changed-v066.test.mjs
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-auto-runs-changed-test-'));
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

/** Collect every onRunChanged call (as `{ id, status }` snapshots). */
function makeScheduler(dir, handlers, opts = {}) {
  const events = [];
  const store = new JsonFileAutomationStore(dir);
  const scheduler = new AutomationScheduler(store, handlers, {
    now: () => new Date('2026-11-10T10:00:00.000Z'),
    onRunChanged: (run) => events.push({ id: run.id, status: run.status }),
    ...opts,
  });
  return { scheduler, store, events };
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

/** Assert the callback saw exactly one run: `running` then `finalStatus`, same id. */
function assertStartThenFinish(events, finalStatus) {
  assert.equal(events.length, 2, `expected 2 onRunChanged calls, got ${JSON.stringify(events)}`);
  assert.equal(events[0].status, 'running', 'first call is the started record');
  assert.equal(events[1].status, finalStatus, 'second call is the finished record');
  assert.equal(events[1].id, events[0].id, 'same run id for start and finish');
}

// ---------------------------------------------------------------------------
// onRunChanged: tick / run-now / retry / event / webhook
// ---------------------------------------------------------------------------

test('tick: onRunChanged fires running then ok for the same run id', async () => {
  const dir = makeTempDir();
  const gate = makeGate();
  const { scheduler, events } = makeScheduler(dir, blockingHandlers(gate));
  scheduler.create(baseAutomation());

  const tickPromise = scheduler.tick();
  await flush();
  assert.deepEqual(
    events.map((e) => e.status),
    ['running'],
    'callback fires as soon as the run starts',
  );
  gate.release();
  const runs = await tickPromise;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'ok');
  assertStartThenFinish(events, 'ok');
});

test('runNow: onRunChanged fires running then error when the action fails', async () => {
  const dir = makeTempDir();
  const gate = makeGate();
  const { scheduler, events } = makeScheduler(dir, blockingHandlers(gate, { failAfterGate: true }));
  scheduler.create(baseAutomation());

  const runPromise = scheduler.runNow('auto-1');
  await flush();
  assert.deepEqual(
    events.map((e) => e.status),
    ['running'],
  );
  gate.release();
  const run = await runPromise;
  assert.equal(run.status, 'error');
  assertStartThenFinish(events, 'error');
});

test('retryRun: onRunChanged fires running then ok for the retried run', async () => {
  const dir = makeTempDir();
  const gate = makeGate();
  let calls = 0;
  const handlers = {
    runAgent: async () => 'agent ok',
    runTool: async () => {
      await gate.promise;
      calls += 1;
      if (calls === 1) throw new Error('first attempt boom');
      return 'tool ok';
    },
    createTask: async () => 'task-123',
    notify: () => undefined,
  };
  const { scheduler, store, events } = makeScheduler(dir, handlers);
  scheduler.create(baseAutomation());

  const firstPromise = scheduler.runNow('auto-1');
  await flush();
  gate.release();
  const first = await firstPromise;
  assert.equal(first.status, 'error');
  assertStartThenFinish(events, 'error');

  // Second gate for the retry attempt.
  const gate2 = makeGate();
  handlers.runTool = async () => {
    await gate2.promise;
    return 'tool ok';
  };
  events.length = 0;
  const retryPromise = scheduler.retryRun(first.id);
  await flush();
  assert.deepEqual(
    events.map((e) => e.status),
    ['running'],
    'retry also reports its start',
  );
  gate2.release();
  const retried = await retryPromise;
  assert.equal(retried.status, 'ok');
  assert.equal(retried.retriedFromRunId, first.id);
  assertStartThenFinish(events, 'ok');
  assert.equal(store.listRuns('auto-1').length, 2, 'original + retried record');
});

test('notifyEvent: onRunChanged fires running then ok', async () => {
  const dir = makeTempDir();
  const gate = makeGate();
  const { scheduler, events } = makeScheduler(dir, blockingHandlers(gate));
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
  assert.deepEqual(
    events.map((e) => e.status),
    ['running'],
  );
  gate.release();
  const runs = await eventPromise;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'ok');
  assertStartThenFinish(events, 'ok');
});

test('webhook: onRunChanged fires running then ok', async () => {
  const dir = makeTempDir();
  const gate = makeGate();
  const secret = 'test-webhook-secret';
  const { scheduler, events } = makeScheduler(dir, blockingHandlers(gate), {
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
  assert.deepEqual(
    events.map((e) => e.status),
    ['running'],
  );
  gate.release();
  const run = await deliveryPromise;
  assert.equal(run.status, 'ok');
  assertStartThenFinish(events, 'ok');
});

// ---------------------------------------------------------------------------
// onRunChanged: skipped + throwing callback
// ---------------------------------------------------------------------------

test('tick: a missed run reports exactly one skipped onRunChanged call', async () => {
  const dir = makeTempDir();
  const { scheduler, store, events } = makeScheduler(dir, blockingHandlers(makeGate()));
  const created = scheduler.create(baseAutomation());
  // Push nextRunAt 2h into the past: grace for a 30-min interval is
  // max(2×30, 5) = 60 min, so this run is too late and gets skipped.
  store.save({ ...created, nextRunAt: '2026-11-10T08:00:00.000Z' });

  const runs = await scheduler.tick();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'skipped');
  assert.equal(events.length, 1, 'skipped fires exactly one callback');
  assert.equal(events[0].status, 'skipped');
  assert.equal(events[0].id, runs[0].id);
});

test('onRunChanged throwing never breaks the run', async () => {
  const dir = makeTempDir();
  const gate = makeGate();
  const { scheduler, store } = makeScheduler(dir, blockingHandlers(gate), {
    onRunChanged: () => {
      throw new Error('listener boom');
    },
  });
  scheduler.create(baseAutomation());

  const runPromise = scheduler.runNow('auto-1');
  await flush();
  gate.release();
  const run = await runPromise;
  assert.equal(run.status, 'ok', 'run still completes despite the throwing callback');
  const stored = store.listRuns('auto-1');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, 'ok');
});

// ---------------------------------------------------------------------------
// reconcileInterruptedRuns
// ---------------------------------------------------------------------------

function seedRuns(store) {
  const orphan = {
    id: 'run-orphan',
    automationId: 'auto-1',
    startedAt: '2026-11-10T09:00:00.000Z',
    status: 'running',
    trigger: 'manual',
  };
  const orphan2 = {
    id: 'run-orphan-2',
    automationId: 'auto-1',
    startedAt: '2026-11-10T09:05:00.000Z',
    status: 'running',
    trigger: 'interval',
  };
  const finishedOk = {
    id: 'run-ok',
    automationId: 'auto-1',
    startedAt: '2026-11-10T08:00:00.000Z',
    finishedAt: '2026-11-10T08:00:01.000Z',
    status: 'ok',
    trigger: 'manual',
    output: 'done',
  };
  const finishedError = {
    id: 'run-err',
    automationId: 'auto-1',
    startedAt: '2026-11-10T07:00:00.000Z',
    finishedAt: '2026-11-10T07:00:01.000Z',
    status: 'error',
    error: 'earlier boom',
    trigger: 'manual',
  };
  const skipped = {
    id: 'run-skip',
    automationId: 'auto-1',
    startedAt: '2026-11-10T06:00:00.000Z',
    finishedAt: '2026-11-10T06:00:00.000Z',
    status: 'skipped',
    trigger: 'interval',
    output: 'Skipped: too late.',
  };
  for (const r of [orphan, orphan2, finishedOk, finishedError, skipped]) store.appendRun(r);
  return { orphan, orphan2, finishedOk, finishedError, skipped };
}

test('reconcileInterruptedRuns: orphans become error with finishedAt + note; finished runs untouched', () => {
  const dir = makeTempDir();
  const { scheduler, store } = makeScheduler(dir, blockingHandlers(makeGate()));
  const seeded = seedRuns(store);

  const reconciled = scheduler.reconcileInterruptedRuns(new Date('2026-11-10T12:00:00.000Z'));
  assert.equal(reconciled.length, 2, 'exactly the two orphan running runs');
  assert.deepEqual(
    reconciled.map((r) => r.id).sort(),
    ['run-orphan', 'run-orphan-2'],
  );
  for (const r of reconciled) {
    assert.equal(r.status, 'error');
    assert.equal(r.finishedAt, '2026-11-10T12:00:00.000Z', 'finishedAt is the reconcile time');
    assert.match(r.error ?? '', /Interrupted/);
    assert.equal(r.startedAt, seeded[r.id === 'run-orphan' ? 'orphan' : 'orphan2'].startedAt);
  }

  const after = store.listRuns('auto-1');
  assert.equal(after.length, 5, 'no record added or dropped');
  const byId = Object.fromEntries(after.map((r) => [r.id, r]));
  assert.equal(byId['run-ok'].status, 'ok');
  assert.equal(byId['run-ok'].output, 'done');
  assert.equal(byId['run-err'].status, 'error');
  assert.equal(byId['run-err'].error, 'earlier boom', 'old error text kept');
  assert.equal(byId['run-skip'].status, 'skipped');
  assert.equal(byId['run-skip'].output, 'Skipped: too late.');
});

test('reconcileInterruptedRuns: idempotent, and a run started after reconcile is untouched', async () => {
  const dir = makeTempDir();
  const gate = makeGate();
  const { scheduler, store } = makeScheduler(dir, blockingHandlers(gate));
  scheduler.create(baseAutomation());
  seedRuns(store);

  const first = scheduler.reconcileInterruptedRuns(new Date('2026-11-10T12:00:00.000Z'));
  assert.equal(first.length, 2);
  const second = scheduler.reconcileInterruptedRuns(new Date('2026-11-10T12:30:00.000Z'));
  assert.deepEqual(second, [], 'second call finds nothing left to fix');

  // A run created AFTER the reconcile must stay `running` until it
  // really finishes — the earlier pass must not have touched it.
  const runPromise = scheduler.runNow('auto-1');
  await flush();
  const midRuns = store.listRuns('auto-1');
  const fresh = midRuns.find((r) => r.status === 'running' && r.id !== 'run-orphan' && r.id !== 'run-orphan-2');
  assert.ok(fresh, 'the new run is still running after the earlier reconcile');
  assert.equal(fresh.finishedAt, undefined);
  gate.release();
  const run = await runPromise;
  assert.equal(run.status, 'ok');
});
