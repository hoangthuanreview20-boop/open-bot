/**
 * Tests for v0.98 Team T3 — Composio poll scheduler nền:
 *  - pollState: store file bền vững (round-trip, mở lại, file hỏng),
 *    resolve fail-closed, memory store, cắt seenIds.
 *  - backoff: cấp số nhân + trần, clamp interval.
 *  - pollScheduler: poll tay → enqueue queue + persist state; dedupe
 *    sống qua restart (restoreSeen); lỗi → backoff tăng, thành công
 *    → reset; bật/tắt + đổi interval persist; timer nền tôn trọng
 *    nextPollAtMs đã persist (backoff không reset khi restart).
 *  - AutomationScheduler.drainComposioTriggerQueue /
 *    dispatchComposioQueueEvent: event poll trong queue chạy
 *    automation khớp triggerSlug, cooldown, chat-active giữ event
 *    trong queue, không queue → [].
 *  - Vòng đầy đủ: poller → bridge → queue → drain → automation chạy
 *    mà không cần poll tay.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/composio-poll-scheduler-v098.test.mjs
 *
 * No live network, no real Composio key: fetchItems toàn mock.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  COMPOSIO_GITHUB_POLL_TRIGGER_SLUG,
  COMPOSIO_GMAIL_POLL_INTERVAL_MS,
  COMPOSIO_GMAIL_POLL_TRIGGER_SLUG,
  COMPOSIO_POLL_BACKOFF_MAX_MS,
  COMPOSIO_POLL_STATE_FILE,
  COMPOSIO_SLACK_POLL_TRIGGER_SLUG,
  ComposioPollScheduler,
  ComposioTriggerQueue,
  JsonFileComposioPollStateStore,
  MemoryComposioPollStateStore,
  clampComposioPollIntervalMs,
  composioPollBackoffDelayMs,
  createGithubComposioPollEntry,
  createGmailComposioPollEntry,
  createSlackComposioPollEntry,
  defaultComposioPollState,
  parseComposioPollItems,
  pruneComposioPollSeenIds,
  resolveComposioPollState,
  resolveComposioPollStateDoc,
} from '../packages/core/dist/composio/index.js';
import {
  AutomationScheduler,
} from '../packages/core/dist/automations/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-poll-v098-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

/** Mutable clock (ms epoch) cho scheduler + poller. */
const clock = { nowMs: 0, now: () => clock.nowMs };

function gmailEntry(fetchItems, opts = {}) {
  return createGmailComposioPollEntry(fetchItems, opts);
}

function makeScheduler(entries, queue, store, extra = {}) {
  return new ComposioPollScheduler(entries, {
    queue,
    stateStore: store,
    now: () => clock.nowMs,
    ...extra,
  });
}

/** In-memory AutomationStore cho test drain (không chạm đĩa). */
class MemoryAutomationStore {
  constructor() {
    this.automations = new Map();
    this.runs = [];
  }

  list() {
    return [...this.automations.values()];
  }

  save(automation) {
    this.automations.set(automation.id, { ...automation });
  }

  remove(id) {
    return this.automations.delete(id);
  }

  listRuns(automationId) {
    return automationId === undefined
      ? [...this.runs]
      : this.runs.filter((r) => r.automationId === automationId);
  }

  appendRun(run) {
    this.runs.push({ ...run });
    if (this.runs.length > 100) this.runs = this.runs.slice(-100);
  }

  updateRun(run) {
    const i = this.runs.findIndex((r) => r.id === run.id);
    if (i >= 0) this.runs[i] = { ...run };
    else this.appendRun(run);
  }
}

function makeHandlers() {
  const calls = [];
  return {
    calls,
    handlers: {
      runAgent: async (botId, prompt) => {
        calls.push({ kind: 'run-agent', botId, prompt });
        return 'agent ok';
      },
      runTool: async (name, args) => {
        calls.push({ kind: 'run-tool', name, args });
        return 'tool ok';
      },
      createTask: async (botId, title) => {
        calls.push({ kind: 'create-task', botId, title });
        return 'task-1';
      },
      notify: (message) => {
        calls.push({ kind: 'notify', message });
      },
    },
  };
}

function composioAutomation(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: 'auto-gmail',
    botId: 'bot-1',
    name: 'Mail moi',
    trigger: { kind: 'composio', triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE', keyId: 'auto-gmail' },
    action: { kind: 'notify', message: 'co mail moi' },
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// pollState: resolve + store
// ---------------------------------------------------------------------------

test('resolveComposioPollState: rac thi ve mac dinh, enabled chi true khi dung true', () => {
  const s = resolveComposioPollState(
    { enabled: 'yes', intervalMs: 'x', consecutiveFailures: -3, seenIds: [{ id: 'a', at: 1 }, { id: '', at: 2 }, 'rac', { id: 'b', at: 'x' }] },
    'gmail-new-mail',
    900000,
  );
  assert.equal(s.enabled, false);
  assert.equal(s.intervalMs, 900000);
  assert.equal(s.consecutiveFailures, 0);
  assert.deepEqual(s.seenIds, [{ id: 'a', at: 1 }]);
  assert.equal(s.lastError, null);
  assert.deepEqual(resolveComposioPollStateDoc(null), { version: 1, pollers: {} });
  assert.deepEqual(resolveComposioPollStateDoc({ pollers: { x: { enabled: true } } }).pollers.x.name, 'x');
});

test('pruneComposioPollSeenIds: vuot cap thi giu id moi nhat', () => {
  const ids = Array.from({ length: 5 }, (_, i) => ({ id: `id-${i}`, at: 1000 + i }));
  assert.deepEqual(pruneComposioPollSeenIds(ids, 3).map((e) => e.id), ['id-2', 'id-3', 'id-4']);
  assert.equal(pruneComposioPollSeenIds(ids, 10).length, 5);
});

test('JsonFileComposioPollStateStore: round-trip, mo lai van con, file hong -> trong + giu .corrupt', () => {
  const dir = makeTempDir();
  const store = new JsonFileComposioPollStateStore(dir);
  assert.equal(store.get('gmail-new-mail'), null);
  const state = {
    ...defaultComposioPollState('gmail-new-mail', 900000),
    totalPolls: 3,
    totalNewItems: 2,
    seenIds: [{ id: 'm1', at: 1000 }, { id: 'm2', at: 2000 }],
  };
  store.save(state);
  assert.equal(store.get('gmail-new-mail').totalPolls, 3);
  // Mo lai bang store moi (gia lap restart app): state van con.
  const reopened = new JsonFileComposioPollStateStore(dir);
  assert.deepEqual(reopened.get('gmail-new-mail').seenIds, [{ id: 'm1', at: 1000 }, { id: 'm2', at: 2000 }]);
  assert.equal(reopened.remove('gmail-new-mail'), true);
  assert.equal(reopened.remove('gmail-new-mail'), false);
  assert.equal(reopened.get('gmail-new-mail'), null);
  // File hong: doc trong + giu ban hong de kiem tra.
  fs.writeFileSync(path.join(dir, COMPOSIO_POLL_STATE_FILE), '{hong', 'utf8');
  const broken = new JsonFileComposioPollStateStore(dir);
  assert.equal(broken.get('gmail-new-mail'), null);
  assert.equal(fs.existsSync(path.join(dir, `${COMPOSIO_POLL_STATE_FILE}.corrupt`)), true);
});

test('MemoryComposioPollStateStore: save/get/remove, khong cham dia', () => {
  const store = new MemoryComposioPollStateStore();
  store.save({ ...defaultComposioPollState('a', 60000), totalPolls: 1 });
  assert.equal(store.get('a').totalPolls, 1);
  assert.equal(Object.keys(store.getAll().pollers).length, 1);
  assert.equal(store.remove('a'), true);
  assert.equal(store.get('a'), null);
});

// ---------------------------------------------------------------------------
// backoff + clamp
// ---------------------------------------------------------------------------

test('composioPollBackoffDelayMs: loi 1 -> nen, moi loi them x2, tran 2 gio', () => {
  assert.equal(composioPollBackoffDelayMs(0, 900000), 0);
  assert.equal(composioPollBackoffDelayMs(1, 900000), 900000);
  assert.equal(composioPollBackoffDelayMs(2, 900000), 1800000);
  assert.equal(composioPollBackoffDelayMs(3, 900000), 3600000);
  assert.equal(composioPollBackoffDelayMs(10, 900000), COMPOSIO_POLL_BACKOFF_MAX_MS);
  assert.equal(composioPollBackoffDelayMs(2, 900000, 1000000), 1000000);
});

test('clampComposioPollIntervalMs: <1 phut -> 1 phut, >24 gio -> 24 gio, rac -> 15 phut', () => {
  assert.equal(clampComposioPollIntervalMs(1000), 60000);
  assert.equal(clampComposioPollIntervalMs(48 * 3600000), 24 * 3600000);
  assert.equal(clampComposioPollIntervalMs('x'), COMPOSIO_GMAIL_POLL_INTERVAL_MS);
  assert.equal(clampComposioPollIntervalMs(300000), 300000);
});

test('createGmailComposioPollEntry: preset Gmail dung tool + trigger slug that', () => {
  const entry = gmailEntry(async () => []);
  assert.equal(entry.name, 'gmail-new-mail');
  assert.equal(entry.toolSlug, 'GMAIL_FETCH_EMAILS');
  assert.equal(entry.triggerSlug, COMPOSIO_GMAIL_POLL_TRIGGER_SLUG);
  assert.equal(entry.toolkit, 'gmail');
  assert.equal(entry.intervalMs, COMPOSIO_GMAIL_POLL_INTERVAL_MS);
  // Shape that (live v0.98): message Gmail co `messageId`, khong co `id`.
  assert.equal(entry.idField, 'messageId');
});

test('parseComposioPollItems: boc dung ca 2 shape wire that (manager + MCP truc tiep)', () => {
  const mail = { messageId: 'm1', subject: 'x', sender: 'a@b.c' };
  // Shape 1: ComposioSessionManager.executeTools — results trong `data`.
  const managerShape = JSON.stringify({
    successful: true,
    data: {
      results: [{ response: { successful: true, data: { messages: [mail], nextPageToken: null, resultSizeEstimate: 1 } }, tool_slug: 'GMAIL_FETCH_EMAILS', index: 0 }],
      total_count: 1,
      success_count: 1,
      error_count: 0,
    },
    error: null,
    log_id: 'log-1',
  });
  assert.deepEqual(parseComposioPollItems(managerShape), [mail]);
  // Shape 2: MCP truc tiep (live.mjs) — results o top-level.
  const mcpShape = JSON.stringify({
    results: [{ response: { successful: true, data: { messages: [mail] } }, tool_slug: 'GMAIL_FETCH_EMAILS', index: 0 }],
  });
  assert.deepEqual(parseComposioPollItems(mcpShape), [mail]);
  // Tool tra mang truc tiep.
  assert.deepEqual(parseComposioPollItems(JSON.stringify({ results: [{ response: { data: [mail] } }] })), [mail]);
  // Bay data_preview (live v0.98): ket qua qua lon -> server tra preview
  // cat ngan thay vi data day du — parser chap nhan lam fallback.
  const previewShape = JSON.stringify({
    successful: true,
    data: {
      results: [{ response: { successful: true, data_preview: { messages: [mail] } }, tool_slug: 'GMAIL_FETCH_EMAILS', index: 0 }],
      total_count: 1,
    },
    error: null,
  });
  assert.deepEqual(parseComposioPollItems(previewShape), [mail]);
  // Khong khop shape / JSON hong / khong phai object -> [] (khong nem).
  assert.deepEqual(parseComposioPollItems('{hong'), []);
  assert.deepEqual(parseComposioPollItems(JSON.stringify({ successful: true, data: {} })), []);
  assert.deepEqual(parseComposioPollItems(JSON.stringify({ results: [] })), []);
  assert.deepEqual(parseComposioPollItems(''), []);
});

test('poll Gmail that: dedupe theo messageId (khong phai id)', async () => {
  clock.nowMs = 2000000;
  const queue = new ComposioTriggerQueue();
  const store = new MemoryComposioPollStateStore();
  const sched = makeScheduler(
    [gmailEntry(async () => [{ messageId: 'm1' }, { messageId: 'm2' }])],
    queue,
    store,
  );
  const first = await sched.pollNow('gmail-new-mail');
  assert.equal(first.newItems.length, 2);
  const second = await sched.pollNow('gmail-new-mail');
  assert.equal(second.newItems.length, 0);
});

// ---------------------------------------------------------------------------
// pollScheduler: poll tay, enqueue, persist
// ---------------------------------------------------------------------------

test('pollNow thanh cong: item moi vao queue, state persist, goi callback drain', async () => {
  clock.nowMs = 1000000;
  const queue = new ComposioTriggerQueue();
  const store = new MemoryComposioPollStateStore();
  const drained = [];
  const sched = makeScheduler(
    [gmailEntry(async () => [{ id: 'm1', subject: 'hello' }, { id: 'm2', subject: 'hi' }])],
    queue,
    store,
    { onEventsEnqueued: async (info) => { drained.push(info); } },
  );
  const result = await sched.pollNow('gmail-new-mail');
  assert.equal(result.newItems.length, 2);
  assert.equal(result.error, undefined);
  assert.equal(queue.size, 2);
  assert.equal(queue.peek()[0].event.eventId, `poll:${COMPOSIO_GMAIL_POLL_TRIGGER_SLUG}:m1`);
  assert.equal(queue.peek()[0].event.type, 'composio.trigger.poll');
  assert.deepEqual(drained, [{ pollerName: 'gmail-new-mail', enqueued: 2 }]);
  const state = store.get('gmail-new-mail');
  assert.equal(state.totalPolls, 1);
  assert.equal(state.totalNewItems, 2);
  assert.equal(state.lastSuccessAtMs, 1000000);
  assert.equal(state.nextPollAtMs, 1000000 + COMPOSIO_GMAIL_POLL_INTERVAL_MS);
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.lastError, null);
  assert.deepEqual(state.seenIds.map((e) => e.id).sort(), ['m1', 'm2']);
  const status = sched.getStatus()[0];
  assert.equal(status.seenCount, 2);
  assert.equal(status.queuePending, 2);
  assert.equal(status.totalNewItems, 2);
});

test('pollNow lan 2 cung item: dedupe trong bo nho, 0 item moi, khong enqueue them', async () => {
  clock.nowMs = 1000000;
  const queue = new ComposioTriggerQueue();
  const store = new MemoryComposioPollStateStore();
  const sched = makeScheduler(
    [gmailEntry(async () => [{ id: 'm1' }, { id: 'm2' }])],
    queue,
    store,
  );
  await sched.pollNow('gmail-new-mail');
  const second = await sched.pollNow('gmail-new-mail');
  assert.equal(second.newItems.length, 0);
  assert.equal(queue.size, 2);
  assert.equal(store.get('gmail-new-mail').totalNewItems, 2);
});

test('dedupe song qua restart: scheduler moi cung store khong tao event trung', async () => {
  clock.nowMs = 1000000;
  const queue = new ComposioTriggerQueue();
  const store = new MemoryComposioPollStateStore();
  const sched1 = makeScheduler(
    [gmailEntry(async () => [{ id: 'm1' }, { id: 'm2' }])],
    queue,
    store,
  );
  await sched1.pollNow('gmail-new-mail');
  // Gia lap restart: scheduler moi, cung store (file that), queue moi.
  const queue2 = new ComposioTriggerQueue();
  const sched2 = makeScheduler(
    [gmailEntry(async () => [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }])],
    queue2,
    store,
  );
  const result = await sched2.pollNow('gmail-new-mail');
  assert.deepEqual(result.newItems.map((i) => i.id), ['m3']);
  assert.equal(queue2.size, 1);
});

test('poll loi: backoff tang dan, thanh cong thi reset; dedupe khong mat khi loi', async () => {
  clock.nowMs = 1000000;
  const queue = new ComposioTriggerQueue();
  const store = new MemoryComposioPollStateStore();
  let fail = true;
  const sched = makeScheduler(
    [gmailEntry(async () => {
      if (fail) throw new Error('mang dut');
      return [{ id: 'm1' }];
    })],
    queue,
    store,
  );
  const r1 = await sched.pollNow('gmail-new-mail');
  assert.ok(r1.error.includes('mang dut'));
  let state = store.get('gmail-new-mail');
  assert.equal(state.consecutiveFailures, 1);
  assert.equal(state.lastError, 'mang dut');
  assert.equal(state.nextPollAtMs, 1000000 + COMPOSIO_GMAIL_POLL_INTERVAL_MS);
  assert.equal(state.totalPolls, 1);
  clock.nowMs = 2000000;
  const r2 = await sched.pollNow('gmail-new-mail');
  assert.ok(r2.error);
  state = store.get('gmail-new-mail');
  assert.equal(state.consecutiveFailures, 2);
  assert.equal(state.nextPollAtMs, 2000000 + 2 * COMPOSIO_GMAIL_POLL_INTERVAL_MS);
  // Thanh cong: reset loi + nextPoll ve interval thuong.
  fail = false;
  clock.nowMs = 3000000;
  const r3 = await sched.pollNow('gmail-new-mail');
  assert.equal(r3.newItems.length, 1);
  state = store.get('gmail-new-mail');
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.lastError, null);
  assert.equal(state.nextPollAtMs, 3000000 + COMPOSIO_GMAIL_POLL_INTERVAL_MS);
  assert.equal(queue.size, 1);
});

test('setPollerInterval clamp + persist; setPollerEnabled tat thi timer dung, poll tay van chay', async () => {
  clock.nowMs = 1000000;
  const queue = new ComposioTriggerQueue();
  const store = new MemoryComposioPollStateStore();
  const sched = makeScheduler(
    [gmailEntry(async () => [{ id: 'm1' }])],
    queue,
    store,
  );
  const afterInterval = sched.setPollerInterval('gmail-new-mail', 1000);
  assert.equal(afterInterval.intervalMs, 60000);
  assert.equal(store.get('gmail-new-mail').intervalMs, 60000);
  const afterDisable = sched.setPollerEnabled('gmail-new-mail', false);
  assert.equal(afterDisable.enabled, false);
  assert.equal(store.get('gmail-new-mail').enabled, false);
  // Poll tay la hanh dong chu dong cua user — van chay khi poller tat.
  const result = await sched.pollNow('gmail-new-mail');
  assert.equal(result.newItems.length, 1);
  assert.throws(() => sched.setPollerInterval('khong-co', 60000), /Không có poller/);
  await assert.rejects(sched.pollNow('khong-co'), /Không có poller/);
});

test('start() ton trong nextPollAtMs da persist (backoff khong reset khi restart)', async () => {
  clock.nowMs = 1000000;
  const queue = new ComposioTriggerQueue();
  const store = new MemoryComposioPollStateStore();
  // Seed state: 2 loi lien tiep, poll ke tiep sau 30 phut nua.
  store.save({
    ...defaultComposioPollState('gmail-new-mail', COMPOSIO_GMAIL_POLL_INTERVAL_MS),
    consecutiveFailures: 2,
    lastError: 'mang dut',
    nextPollAtMs: 1000000 + 1800000,
    totalPolls: 2,
  });
  let polls = 0;
  const sched = makeScheduler(
    [gmailEntry(async () => { polls++; return []; })],
    queue,
    store,
  );
  sched.start();
  try {
    assert.equal(sched.getStatus()[0].running, true);
    assert.equal(sched.getStatus()[0].nextPollAtMs, 1000000 + 1800000);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(polls, 0, 'chua toi nextPollAtMs thi khong poll');
  } finally {
    sched.stop();
  }
  assert.equal(sched.getStatus()[0].running, false);
});

test('start() poll ngay khi nextPollAtMs da qua, roi lap lai theo timer', async () => {
  clock.nowMs = Date.now();
  const queue = new ComposioTriggerQueue();
  const store = new MemoryComposioPollStateStore();
  let polls = 0;
  const sched = makeScheduler(
    [gmailEntry(async () => { polls++; return [{ id: `m${polls}` }]; })],
    queue,
    store,
  );
  sched.start();
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(polls >= 1, 'poll ngay khi start');
    assert.equal(queue.size, polls);
  } finally {
    sched.stop();
  }
});

// ---------------------------------------------------------------------------
// AutomationScheduler: drain queue
// ---------------------------------------------------------------------------

test('drainComposioTriggerQueue: event poll chay automation khop slug, queue rong sau drain', async () => {
  const queue = new ComposioTriggerQueue();
  const store = new MemoryAutomationStore();
  const { calls, handlers } = makeHandlers();
  const scheduler = new AutomationScheduler(store, handlers, {
    composioTriggerQueue: queue,
    eventCooldownMs: 0,
  });
  scheduler.create(composioAutomation());
  queue.enqueue({
    eventId: `poll:${COMPOSIO_GMAIL_POLL_TRIGGER_SLUG}:m1`,
    type: 'composio.trigger.poll',
    triggerSlug: COMPOSIO_GMAIL_POLL_TRIGGER_SLUG,
    data: { item: { id: 'm1', subject: 'hello' } },
  });
  const runs = await scheduler.drainComposioTriggerQueue();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'ok');
  assert.equal(queue.size, 0);
  assert.equal(calls.filter((c) => c.kind === 'notify').length, 1);
  const run = store.listRuns()[0];
  assert.ok(String(run.triggerInput).includes('m1'), 'input chay chua id mail');
  assert.ok(String(run.triggerInput).includes(COMPOSIO_GMAIL_POLL_TRIGGER_SLUG));
});

test('drainComposioTriggerQueue: khong automation nao nghe thi event roi queue, khong chay, khong loi', async () => {
  const queue = new ComposioTriggerQueue();
  const store = new MemoryAutomationStore();
  const { calls, handlers } = makeHandlers();
  const scheduler = new AutomationScheduler(store, handlers, {
    composioTriggerQueue: queue,
    eventCooldownMs: 0,
  });
  scheduler.create(composioAutomation({ trigger: { kind: 'composio', triggerSlug: 'GITHUB_ISSUE_CREATED', keyId: 'auto-gmail' } }));
  queue.enqueue({
    eventId: 'poll:GMAIL_NEW_GMAIL_MESSAGE:m1',
    type: 'composio.trigger.poll',
    triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
    data: { item: { id: 'm1' } },
  });
  const runs = await scheduler.drainComposioTriggerQueue();
  assert.deepEqual(runs, []);
  assert.equal(queue.size, 0);
  assert.equal(calls.length, 0);
});

test('drainComposioTriggerQueue: khong co queue cau hinh -> []; chat active -> giu event trong queue', async () => {
  const store = new MemoryAutomationStore();
  const { handlers } = makeHandlers();
  const noQueue = new AutomationScheduler(store, handlers, { eventCooldownMs: 0 });
  assert.deepEqual(await noQueue.drainComposioTriggerQueue(), []);

  const queue = new ComposioTriggerQueue();
  const store2 = new MemoryAutomationStore();
  const busy = new AutomationScheduler(store2, handlers, {
    composioTriggerQueue: queue,
    eventCooldownMs: 0,
    isChatActive: () => true,
  });
  busy.create(composioAutomation());
  queue.enqueue({
    eventId: 'poll:GMAIL_NEW_GMAIL_MESSAGE:m1',
    type: 'composio.trigger.poll',
    triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
    data: { item: { id: 'm1' } },
  });
  assert.deepEqual(await busy.drainComposioTriggerQueue(), []);
  assert.equal(queue.size, 1, 'event o lai queue de drain sau');
});

test('dispatchComposioQueueEvent: cooldown chan event thu 2 cung automation', async () => {
  const queue = new ComposioTriggerQueue();
  const store = new MemoryAutomationStore();
  const { calls, handlers } = makeHandlers();
  const scheduler = new AutomationScheduler(store, handlers, {
    composioTriggerQueue: queue,
    eventCooldownMs: 60000,
  });
  scheduler.create(composioAutomation());
  const event = {
    eventId: 'poll:GMAIL_NEW_GMAIL_MESSAGE:m1',
    type: 'composio.trigger.poll',
    triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
    data: { item: { id: 'm1' } },
  };
  const runs1 = await scheduler.dispatchComposioQueueEvent(event);
  assert.equal(runs1.length, 1);
  const runs2 = await scheduler.dispatchComposioQueueEvent({
    ...event,
    eventId: 'poll:GMAIL_NEW_GMAIL_MESSAGE:m2',
  });
  assert.equal(runs2.length, 0, 'cooldown 60s chan lan chay thu 2');
  assert.equal(calls.filter((c) => c.kind === 'notify').length, 1);
});

test('vong day du: poller -> queue -> drain -> automation tu chay, khong can poll tay', async () => {
  clock.nowMs = 5000000;
  const queue = new ComposioTriggerQueue();
  const pollStore = new MemoryComposioPollStateStore();
  const autoStore = new MemoryAutomationStore();
  const { calls, handlers } = makeHandlers();
  const autoScheduler = new AutomationScheduler(autoStore, handlers, {
    composioTriggerQueue: queue,
    eventCooldownMs: 0,
  });
  autoScheduler.create(composioAutomation());
  const pollScheduler = makeScheduler(
    [gmailEntry(async () => [{ id: 'm99', subject: 'don hang moi' }])],
    queue,
    pollStore,
    {
      onEventsEnqueued: async () => {
        await autoScheduler.drainComposioTriggerQueue();
      },
    },
  );
  const result = await pollScheduler.pollNow('gmail-new-mail');
  assert.equal(result.newItems.length, 1);
  assert.equal(queue.size, 0, 'drain da lay event khoi queue');
  assert.equal(autoStore.listRuns().length, 1);
  assert.equal(autoStore.listRuns()[0].status, 'ok');
  assert.ok(String(autoStore.listRuns()[0].triggerInput).includes('m99'));
  assert.equal(calls.filter((c) => c.kind === 'notify').length, 1);
});

test('parseComposioPollItems: boc Slack search (messages.matches long)', () => {
  // Shape that, live v0.98: { messages: { matches: [...], paging, total }, ok, query }.
  const match = { ts: '1794583066.476869', type: 'message', text: 'hi' };
  const out = JSON.stringify({
    successful: true,
    data: {
      results: [{
        response: {
          successful: true,
          data: { messages: { matches: [match], paging: { count: 10 }, total: 1 }, ok: true, query: 'bot' },
        },
        tool_slug: 'SLACK_SEARCH_MESSAGES',
        index: 0,
      }],
      total_count: 1,
    },
    error: null,
  });
  assert.deepEqual(parseComposioPollItems(out), [match]);
  // Gmail: messages LA mang — van boc dung, khong nham sang nhanh nested.
  const mail = { messageId: 'm1' };
  const gmailOut = JSON.stringify({
    successful: true,
    data: { results: [{ response: { successful: true, data: { messages: [mail] } }, tool_slug: 'GITHUB_SEARCH_ISSUES', index: 0 }], total_count: 1 },
    error: null,
  });
  assert.deepEqual(parseComposioPollItems(gmailOut), [mail]);
});

test('createGithubComposioPollEntry: preset dung slug/schema that (live v0.98)', () => {
  const fetch = async () => [];
  const entry = createGithubComposioPollEntry(fetch, { repo: 'openbot1/open-bot' });
  assert.equal(entry.name, 'github-new-issues');
  assert.equal(entry.toolkit, 'github');
  assert.equal(entry.toolSlug, 'GITHUB_SEARCH_ISSUES');
  assert.deepEqual(entry.toolArgs, { q: 'repo:openbot1/open-bot', per_page: 10, sort: 'created', order: 'desc' });
  assert.equal(entry.idField, 'id');
  assert.equal(entry.triggerSlug, COMPOSIO_GITHUB_POLL_TRIGGER_SLUG);
  assert.equal(entry.triggerSlug, 'GITHUB_ISSUE_CREATED_TRIGGER');
  assert.equal(entry.intervalMs, 15 * 60 * 1000);
  // Repo sai dinh dang -> throw, khong tao poller chay lac.
  assert.throws(() => createGithubComposioPollEntry(fetch, { repo: 'openbot1' }), /owner\/repo/);
  assert.throws(() => createGithubComposioPollEntry(fetch, { repo: '' }), /owner\/repo/);
  assert.throws(() => createGithubComposioPollEntry(fetch, { repo: 'a/b/c' }), /owner\/repo/);
});

test('createSlackComposioPollEntry: preset dung slug/schema that (live v0.98)', () => {
  const fetch = async () => [];
  const entry = createSlackComposioPollEntry(fetch, { query: 'in:#social' });
  assert.equal(entry.name, 'slack-new-messages');
  assert.equal(entry.toolkit, 'slack');
  assert.equal(entry.toolSlug, 'SLACK_SEARCH_MESSAGES');
  assert.deepEqual(entry.toolArgs, { query: 'in:#social', count: 10 });
  assert.equal(entry.idField, 'ts');
  assert.equal(entry.triggerSlug, COMPOSIO_SLACK_POLL_TRIGGER_SLUG);
  assert.equal(entry.triggerSlug, 'SLACK_CHANNEL_MESSAGE_RECEIVED');
  assert.equal(entry.intervalMs, 15 * 60 * 1000);
  // Query rong -> throw: Slack search khong co API "liet ke tin moi nhat".
  assert.throws(() => createSlackComposioPollEntry(fetch, { query: '' }), /query/);
  assert.throws(() => createSlackComposioPollEntry(fetch, { query: '   ' }), /query/);
});

test('pollNow GitHub: dedupe dung id SO (id kieu number -> string)', async () => {
  const queue = new ComposioTriggerQueue();
  const store = new MemoryComposioPollStateStore();
  const issues = [
    { id: 4, number: 4, title: 't1' },
    { id: 5, number: 5, title: 't2' },
  ];
  const scheduler = makeScheduler(
    [createGithubComposioPollEntry(async () => issues, { repo: 'openbot1/open-bot' })],
    queue,
    store,
  );
  const first = await scheduler.pollNow('github-new-issues');
  assert.equal(first.newItems.length, 2, '2 issue moi lan dau');
  const second = await scheduler.pollNow('github-new-issues');
  assert.equal(second.newItems.length, 0, 'cung id so -> dedupe, khong enqueue lai');
  assert.equal(queue.size, 2);
  const events = queue.drain();
  // drain() tra wrapper { event, receivedAtMs } — event la ComposioTriggerEvent.
  assert.equal(events[0].event.triggerSlug, 'GITHUB_ISSUE_CREATED_TRIGGER');
  assert.equal(events[0].event.eventId, 'poll:GITHUB_ISSUE_CREATED_TRIGGER:4');
  assert.equal(events[0].event.data.item.id, 4);
  // Dedupe ton tai qua restart: seenIds da persist id dang string.
  const restarted = makeScheduler(
    [createGithubComposioPollEntry(async () => issues, { repo: 'openbot1/open-bot' })],
    queue,
    store,
  );
  const third = await restarted.pollNow('github-new-issues');
  assert.equal(third.newItems.length, 0);
});

test('pollNow Slack: dedupe dung ts + queue event dung trigger slug', async () => {
  const queue = new ComposioTriggerQueue();
  const store = new MemoryComposioPollStateStore();
  const matches = [{ ts: '1794583066.476869', type: 'message', text: 'hello' }];
  const scheduler = makeScheduler(
    [createSlackComposioPollEntry(async () => matches, { query: 'in:#social' })],
    queue,
    store,
  );
  const first = await scheduler.pollNow('slack-new-messages');
  assert.equal(first.newItems.length, 1);
  const second = await scheduler.pollNow('slack-new-messages');
  assert.equal(second.newItems.length, 0, 'cung ts -> dedupe');
  const events = queue.drain();
  assert.equal(events.length, 1);
  assert.equal(events[0].event.triggerSlug, 'SLACK_CHANNEL_MESSAGE_RECEIVED');
  assert.equal(events[0].event.eventId, 'poll:SLACK_CHANNEL_MESSAGE_RECEIVED:1794583066.476869');
  assert.equal(events[0].event.data.item.ts, '1794583066.476869');
});
