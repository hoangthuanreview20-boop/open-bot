/**
 * Tests for the v0.4 automations + dream system
 * (packages/core/src/automations/).
 *
 * Run after building the core package:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/automations.test.mjs
 *
 * The scheduler is tested with an injected clock (`now`) and fake
 * handlers, so no real timer, provider or tool ever runs here.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AutomationScheduler,
  DreamEngine,
  JsonFileAutomationStore,
  automationDue,
  buildDreamPrompt,
  evaluateCondition,
  executeAutomation,
  globMatch,
  isValidCronExpression,
  nextCronOccurrence,
  nextRunAtFor,
  parseCronExpression,
  validateAutomation,
} from '../packages/core/dist/automations/index.js';
import {
  deleteRoutine,
  loadRoutines,
  routineToAutomation,
  routinesToAutomations,
  saveRoutine,
} from '../packages/core/dist/agent/routines.js';
import { BotMemory } from '../packages/core/dist/agent/memory.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-auto-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

/** Mutable clock: tests advance time by reassigning `clock.now`. */
function makeClock(iso) {
  const clock = { now: new Date(iso) };
  return clock;
}
const nowFn = (clock) => () => new Date(clock.now.getTime());

function baseAutomation(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: 'auto-1',
    botId: 'bot-1',
    name: 'Test automation',
    trigger: { kind: 'interval', minutes: 30 },
    action: { kind: 'notify', message: 'ping' },
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Fake handlers recording every call (no provider/tool involved). */
function makeHandlers() {
  const calls = [];
  return {
    calls,
    handlers: {
      runAgent: async (botId, prompt, opts) => {
        calls.push({ kind: 'run-agent', botId, prompt, opts });
        return `agent answered: ${prompt.slice(0, 20)}`;
      },
      runTool: async (name, args) => {
        calls.push({ kind: 'run-tool', name, args });
        return `tool ${name} ok`;
      },
      createTask: async (botId, title) => {
        calls.push({ kind: 'create-task', botId, title });
        return 'task-123';
      },
      notify: (message) => {
        calls.push({ kind: 'notify', message });
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Cron: parse / match / next occurrence
// ---------------------------------------------------------------------------

test('cron parses fields, */n steps, lists and ranges; rejects bad expressions', () => {
  assert.equal(isValidCronExpression('0 9 * * *'), true);
  assert.equal(isValidCronExpression('*/15 * * * *'), true);
  assert.equal(isValidCronExpression('0 9-17 * * 1-5'), true);
  assert.equal(isValidCronExpression('0 9 * * 1,3,5'), true);
  assert.equal(isValidCronExpression('0 9 * *'), false, 'only 4 fields');
  assert.equal(isValidCronExpression('61 9 * * *'), false, 'minute out of range');
  assert.equal(isValidCronExpression('0 25 * * *'), false, 'hour out of range');
  assert.equal(isValidCronExpression('0 9 * * 8'), false, 'weekday out of range');
  assert.equal(isValidCronExpression('x 9 * * *'), false, 'non-numeric field');

  const fields = parseCronExpression('30 9 * * 1-5');
  assert.ok(fields.minute.has(30) && !fields.minute.has(31));
  assert.ok(fields.dayOfWeek.has(1) && fields.dayOfWeek.has(5) && !fields.dayOfWeek.has(6));
});

test('nextCronOccurrence finds the next 09:00 weekday run', () => {
  // 2026-11-08 is a Sunday; next weekday 09:00 is Monday 2026-11-09.
  const from = new Date(2026, 10, 8, 10, 0, 0); // local time, Sunday 10:00
  const next = nextCronOccurrence('0 9 * * 1-5', from);
  assert.equal(next.getDay(), 1, 'must be a Monday');
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 0);
  assert.equal(next.getDate(), 9);

  // Same-day: 08:00 -> 09:00 today.
  const sameDay = nextCronOccurrence('0 9 * * *', new Date(2026, 10, 9, 8, 0, 0));
  assert.equal(sameDay.getDate(), 9);
  assert.equal(sameDay.getHours(), 9);
});

test('cron day-of-month OR day-of-week rule: either restricted day matches', () => {
  const fields = parseCronExpression('0 0 15 * 1'); // 15th OR Monday
  assert.equal(fields.domRestricted, true);
  assert.equal(fields.dowRestricted, true);
  // Monday 2026-11-09 (not the 15th) matches via weekday.
  assert.equal(
    (fields.minute.has(0) && fields.hour.has(0) && fields.month.has(11)) &&
      (fields.dayOfMonth.has(9) || fields.dayOfWeek.has(1)),
    true,
  );
  const monday = new Date(2026, 10, 9, 0, 0, 0);
  // Direct check through the exported matcher via next occurrence: from
  // Sunday 2026-11-08 00:00, next should be Monday 09th (weekday), not the 15th.
  const next = nextCronOccurrence('0 0 15 * 1', new Date(2026, 10, 8, 0, 0, 0));
  assert.equal(next.getDate(), 9);
  assert.equal(monday.getDay(), 1);
});

// ---------------------------------------------------------------------------
// Engine: due / condition / execute / validate
// ---------------------------------------------------------------------------

test('automationDue: never-run interval is due; disabled or manual never due', () => {
  const now = new Date();
  assert.equal(automationDue(baseAutomation(), now), true);
  assert.equal(automationDue(baseAutomation({ enabled: false }), now), false);
  assert.equal(automationDue(baseAutomation({ trigger: { kind: 'manual' } }), now), false);
  assert.equal(automationDue(baseAutomation({ trigger: { kind: 'event', event: 'agent-done' } }), now), false);

  const recent = baseAutomation({ lastRunAt: now.toISOString() });
  assert.equal(automationDue(recent, now), false, 'just ran 30-min interval, not due yet');
  const later = new Date(now.getTime() + 31 * 60_000);
  assert.equal(automationDue(recent, later), true, 'due after the interval elapsed');
});

test('nextRunAtFor: interval from last run, cron from now', () => {
  const from = new Date(2026, 10, 8, 10, 0, 0);
  const interval = baseAutomation({ lastRunAt: new Date(2026, 10, 8, 9, 30, 0).toISOString() });
  assert.equal(nextRunAtFor(interval, from)?.getTime(), new Date(2026, 10, 8, 10, 0, 0).getTime());
  assert.equal(nextRunAtFor(baseAutomation({ trigger: { kind: 'manual' } }), from), null);
  assert.equal(nextRunAtFor(baseAutomation({ trigger: { kind: 'event', event: 'agent-done' } }), from), null);
});

test('evaluateCondition: agent-done text filter and file-changed glob', () => {
  const onDone = baseAutomation({
    trigger: { kind: 'event', event: 'agent-done' },
    condition: { textContains: 'xong' },
  });
  assert.equal(
    evaluateCondition(onDone, { kind: 'agent-done', text: 'Đã XONG việc rồi', at: new Date().toISOString() }),
    true,
  );
  assert.equal(
    evaluateCondition(onDone, { kind: 'agent-done', text: 'đang làm dở', at: new Date().toISOString() }),
    false,
  );

  const onFile = baseAutomation({
    trigger: { kind: 'event', event: 'file-changed', pathPattern: 'notes/*.md' },
  });
  assert.equal(
    evaluateCondition(onFile, { kind: 'file-changed', path: 'notes/todo.md', at: new Date().toISOString() }),
    true,
  );
  assert.equal(
    evaluateCondition(onFile, { kind: 'file-changed', path: 'notes/deep/todo.md', at: new Date().toISOString() }),
    false,
    'single * must not cross a directory boundary',
  );
  assert.equal(
    evaluateCondition(onFile, { kind: 'file-changed', path: 'src/app.ts', at: new Date().toISOString() }),
    false,
  );

  assert.equal(globMatch('**/*.md', 'a/b/c.md'), true);
  assert.equal(globMatch('*.md', 'a.md'), true);
});

test('validateAutomation catches bad interval, bad cron, empty action', () => {
  assert.ok(validateAutomation(baseAutomation({ trigger: { kind: 'interval', minutes: 0 } })).length > 0);
  assert.ok(validateAutomation(baseAutomation({ trigger: { kind: 'cron', expression: 'bad' } })).length > 0);
  assert.ok(validateAutomation(baseAutomation({ action: { kind: 'run-agent', botId: 'b', prompt: '  ' } })).length > 0);
  assert.deepEqual(validateAutomation(baseAutomation()), []);
});

test('executeAutomation runs each action kind through handlers and records errors', async () => {
  const { calls, handlers } = makeHandlers();
  const run = await executeAutomation(
    baseAutomation({ action: { kind: 'run-agent', botId: 'bot-1', prompt: 'hello agent' } }),
    handlers,
  );
  assert.equal(run.status, 'ok');
  assert.match(run.output, /agent answered/);
  assert.equal(calls[0].kind, 'run-agent');

  const taskRun = await executeAutomation(
    baseAutomation({ action: { kind: 'create-task', botId: 'bot-1', title: 'Do it' } }),
    handlers,
  );
  assert.equal(taskRun.status, 'ok');
  assert.match(taskRun.output, /task-123/);

  const failing = {
    ...handlers,
    runTool: async () => {
      throw new Error('boom');
    },
  };
  const errRun = await executeAutomation(
    baseAutomation({ action: { kind: 'run-tool', tool: 'read_file', args: { path: 'x' } } }),
    failing,
  );
  assert.equal(errRun.status, 'error');
  assert.equal(errRun.error, 'boom');
});

// ---------------------------------------------------------------------------
// Scheduler: tick fires due runs, skips missed runs, run-now, events
// ---------------------------------------------------------------------------

test('scheduler tick fires a due interval automation and reschedules it', async () => {
  const clock = makeClock('2026-11-08T10:00:00');
  const store = new JsonFileAutomationStore(makeTempDir());
  const { calls, handlers } = makeHandlers();
  const scheduler = new AutomationScheduler(store, handlers, { now: nowFn(clock), tickMs: 60_000 });

  const created = scheduler.create({
    botId: 'bot-1',
    name: 'Ping',
    trigger: { kind: 'interval', minutes: 30 },
    action: { kind: 'notify', message: 'ping' },
    enabled: true,
  });
  // Freshly created: first run is now (lastRunAt null -> due).
  const runs = await scheduler.tick();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'ok');
  assert.deepEqual(calls.map((c) => c.kind), ['notify']);

  // Second tick immediately: not due any more.
  assert.deepEqual(await scheduler.tick(), []);

  // 31 minutes later: due again.
  clock.now = new Date('2026-11-08T10:31:00');
  const runs2 = await scheduler.tick();
  assert.equal(runs2.length, 1);
  assert.equal(runs2[0].status, 'ok');
  assert.equal(calls.length, 2);

  // nextRunAt moved forward from the last run.
  const stored = scheduler.get(created.id);
  assert.ok(stored.nextRunAt && new Date(stored.nextRunAt).getTime() > clock.now.getTime());
});

test('scheduler skips a run missed by more than the grace window (no catch-up burst)', async () => {
  const clock = makeClock('2026-11-08T10:00:00');
  const store = new JsonFileAutomationStore(makeTempDir());
  const { calls, handlers } = makeHandlers();
  const scheduler = new AutomationScheduler(store, handlers, { now: nowFn(clock) });

  const created = scheduler.create({
    botId: 'bot-1',
    name: 'Every 30 min',
    trigger: { kind: 'interval', minutes: 30 },
    action: { kind: 'notify', message: 'ping' },
    enabled: true,
  });
  await scheduler.tick(); // first run at 10:00
  assert.equal(calls.length, 1);

  // App "off" until 12:00 — 2h later, grace is max(2×30min, 5min) = 60min.
  clock.now = new Date('2026-11-08T12:00:00');
  const runs = await scheduler.tick();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'skipped', 'missed run must be skipped, not fired');
  assert.equal(calls.length, 1, 'no catch-up execution happened');
  assert.match(runs[0].output, /Skipped/);

  // And the automation was rescheduled from now, not from the missed time.
  const stored = scheduler.get(created.id);
  assert.ok(new Date(stored.nextRunAt).getTime() > clock.now.getTime());
  assert.deepEqual(await scheduler.tick(), [], 'rescheduled run is not immediately due');
});

test('scheduler does not fire while a chat is active; runNow works and rejects disabled', async () => {
  const clock = makeClock('2026-11-08T10:00:00');
  const store = new JsonFileAutomationStore(makeTempDir());
  const { calls, handlers } = makeHandlers();
  let chatActive = true;
  const scheduler = new AutomationScheduler(store, handlers, {
    now: nowFn(clock),
    isChatActive: () => chatActive,
  });
  const created = scheduler.create({
    botId: 'bot-1',
    name: 'Ping',
    trigger: { kind: 'interval', minutes: 30 },
    action: { kind: 'notify', message: 'ping' },
    enabled: true,
  });
  assert.deepEqual(await scheduler.tick(), [], 'no firing during an active chat');
  assert.equal(calls.length, 0);

  chatActive = false;
  assert.equal((await scheduler.tick()).length, 1);

  const manual = scheduler.create({
    botId: 'bot-1',
    name: 'Manual only',
    trigger: { kind: 'manual' },
    action: { kind: 'notify', message: 'manual ping' },
    enabled: true,
  });
  const run = await scheduler.runNow(manual.id);
  assert.equal(run.status, 'ok');
  assert.equal(calls.length, 2); // 1 từ tick (Ping) + 1 từ runNow (manual)

  scheduler.setEnabled(manual.id, false);
  await assert.rejects(() => scheduler.runNow(manual.id), /disabled/);
  await assert.rejects(() => scheduler.runNow('no-such-id'), /No automation/);
  assert.equal(scheduler.remove(created.id), true);
  assert.equal(scheduler.remove(created.id), false);
});

test('scheduler notifyEvent fires matching automations, respects cooldown', async () => {
  const clock = makeClock('2026-11-08T10:00:00');
  const store = new JsonFileAutomationStore(makeTempDir());
  const { calls, handlers } = makeHandlers();
  const scheduler = new AutomationScheduler(store, handlers, { now: nowFn(clock), eventCooldownMs: 60_000 });
  scheduler.create({
    botId: 'bot-1',
    name: 'On file change',
    trigger: { kind: 'event', event: 'file-changed', pathPattern: 'notes/*.md' },
    action: { kind: 'notify', message: 'a note changed' },
    enabled: true,
  });
  const runs = await scheduler.notifyEvent({ kind: 'file-changed', path: 'notes/a.md', at: clock.now.toISOString() });
  assert.equal(runs.length, 1);
  assert.equal(calls.length, 1);

  // Same event 10s later: inside the 60s cooldown, ignored.
  clock.now = new Date('2026-11-08T10:00:10');
  assert.deepEqual(
    await scheduler.notifyEvent({ kind: 'file-changed', path: 'notes/b.md', at: clock.now.toISOString() }),
    [],
  );
  // A non-matching path never fires, even after the cooldown.
  clock.now = new Date('2026-11-08T10:02:00');
  assert.deepEqual(
    await scheduler.notifyEvent({ kind: 'file-changed', path: 'src/app.ts', at: clock.now.toISOString() }),
    [],
  );
});

test('scheduler start/stop manages the timer; store persists automations across instances', async () => {
  const dir = makeTempDir();
  const store = new JsonFileAutomationStore(dir);
  const { handlers } = makeHandlers();
  const s1 = new AutomationScheduler(store, handlers, { tickMs: 1000 });
  assert.equal(s1.isRunning(), false);
  s1.start();
  assert.equal(s1.isRunning(), true);
  s1.start(); // second start is a no-op
  s1.stop();
  assert.equal(s1.isRunning(), false);

  const created = s1.create({
    botId: 'bot-1',
    name: 'Persisted',
    trigger: { kind: 'manual' },
    action: { kind: 'notify', message: 'hi' },
    enabled: true,
  });
  const s2 = new AutomationScheduler(new JsonFileAutomationStore(dir), handlers);
  assert.equal(s2.get(created.id)?.name, 'Persisted');
  assert.equal(fs.existsSync(path.join(dir, 'automations.json')), true);
});

// ---------------------------------------------------------------------------
// Dream: never runs while chatting, runs when idle
// ---------------------------------------------------------------------------

test('dream does not run when a chat is active', async () => {
  const clock = makeClock('2026-11-08T10:00:00');
  const { handlers } = makeHandlers();
  const engine = new DreamEngine({
    config: { enabled: true, idleMinutes: 15 },
    handlers,
    isChatActive: () => true,
    now: nowFn(clock),
  });
  engine.noteActivity('bot-1', new Date('2026-11-08T09:00:00')); // idle 60 min
  const result = await engine.checkAndRun('bot-1', () => [
    { role: 'user', content: 'hello' },
  ]);
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'chat-active');
});

test('dream does not run before the idle window, runs after it and creates a task', async () => {
  const clock = makeClock('2026-11-08T10:00:00');
  const { calls, handlers } = makeHandlers();
  const engine = new DreamEngine({
    config: { enabled: true, idleMinutes: 15 },
    handlers,
    isChatActive: () => false,
    now: nowFn(clock),
  });
  engine.noteActivity('bot-1', new Date('2026-11-08T09:50:00')); // idle 10 min
  const tooSoon = await engine.checkAndRun('bot-1', () => [{ role: 'user', content: 'hi' }]);
  assert.equal(tooSoon.ran, false);
  assert.equal(tooSoon.reason, 'not-idle');

  clock.now = new Date('2026-11-08T10:06:00'); // idle 16 min
  const result = await engine.checkAndRun('bot-1', () => [
    { role: 'user', content: 'review my notes' },
    { role: 'assistant', content: 'done, see summary' },
  ]);
  assert.equal(result.ran, true);
  assert.ok(result.summary && result.summary.includes('agent answered'));
  assert.equal(result.taskId, 'task-123');
  assert.equal(calls.filter((c) => c.kind === 'run-agent').length, 1);
  assert.equal(calls.filter((c) => c.kind === 'create-task').length, 1);
  assert.equal(calls.filter((c) => c.kind === 'notify').length, 1);

  // Right after a dream pass the idle clock restarted: no immediate re-run.
  const again = await engine.checkAndRun('bot-1', () => []);
  assert.equal(again.ran, false);
  assert.equal(again.reason, 'not-idle');
});

test('dream disabled never runs; prompt builder includes history', () => {
  const { handlers } = makeHandlers();
  const engine = new DreamEngine({
    config: { enabled: false },
    handlers,
    isChatActive: () => false,
  });
  return engine.checkAndRun('bot-1', () => []).then((r) => {
    assert.equal(r.ran, false);
    assert.equal(r.reason, 'disabled');
  });
});

test('buildDreamPrompt summarises history and states the idle window', () => {
  const prompt = buildDreamPrompt(
    [
      { role: 'user', content: 'làm báo cáo tuần' },
      { role: 'assistant', content: 'đã xong phần 1' },
    ],
    15,
  );
  assert.match(prompt, /15 phút/);
  assert.match(prompt, /làm báo cáo tuần/);
  assert.match(prompt, /đã xong phần 1/);
});

// ---------------------------------------------------------------------------
// Routines on top of the automation engine (API compatibility)
// ---------------------------------------------------------------------------

test('routines convert to interval automations; old routines API still works', () => {
  const ws = makeTempDir();
  const memory = new BotMemory(ws);
  try {
    saveRoutine(memory, {
      id: 'r1',
      botId: 'bot-1',
      name: 'Morning check',
      prompt: 'Check the inbox',
      cronMinutes: 30,
      enabled: true,
      lastRunAt: null,
    });
    assert.equal(loadRoutines(memory, 'bot-1').length, 1);

    const autos = routinesToAutomations(memory, 'bot-1');
    assert.equal(autos.length, 1);
    assert.equal(autos[0].id, 'r1');
    assert.deepEqual(autos[0].trigger, { kind: 'interval', minutes: 30 });
    assert.deepEqual(autos[0].action, { kind: 'run-agent', botId: 'bot-1', prompt: 'Check the inbox' });
    assert.deepEqual(validateAutomation(autos[0]), []);

    const single = routineToAutomation(loadRoutines(memory, 'bot-1')[0]);
    assert.equal(single.name, 'Morning check');

    assert.equal(deleteRoutine(memory, 'bot-1', 'r1'), true);
    assert.deepEqual(loadRoutines(memory, 'bot-1'), []);
    assert.equal(deleteRoutine(memory, 'bot-1', 'r1'), false);
  } finally {
    memory.close();
  }
});
