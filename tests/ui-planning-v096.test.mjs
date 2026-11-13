/**
 * UI + planning tests (v0.96, Team T6).
 *
 * - Command palette v2: hand-written fuzzy search (scoring,
 *   diacritics, ranking) + recent commands (record/read/prune/cap).
 * - Dashboard: aggregates from a harness EventLog fixture (runs,
 *   tool calls, errors, tokens, router decisions, top tools).
 * - Bot management: pin/unread/duplicate/hide/delete-order, copy
 *   conversation id, corrupt stored meta.
 * - Planning: step lifecycle + multi-agent dispatch + stuck
 *   detector (repeated tool call 3x, no-progress streak), in BOTH
 *   the core engine (packages/core/dist) and the UI plan store
 *   (renderer, localStorage-backed).
 *
 * Run: node --test tests/ui-planning-v096.test.mjs
 * (build core first: npm run build --workspace=@open-bot/core)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fuzzyFilter,
  fuzzyMatchRanges,
  fuzzyScore,
  normalizeFuzzyText,
} from '../apps/desktop/src/renderer/components/fuzzySearch.ts';
import {
  PALETTE_RECENT_KEY,
  PALETTE_RECENT_MAX,
  prunePaletteRecent,
  readPaletteRecent,
  recordPaletteRecent,
} from '../apps/desktop/src/renderer/components/paletteRecent.ts';
import {
  conversationIdForCopy,
  countUnread,
  duplicateBot,
  hiddenBots,
  parseBotMeta,
  setBotHidden,
  setBotUnread,
  sortBots,
  togglePin,
} from '../apps/desktop/src/renderer/components/botManager.ts';
import { aggregateDashboard } from '../apps/desktop/src/renderer/components/dashboardStats.ts';
import {
  addUiPlan,
  addUiStep,
  assignUiStep,
  checkUiPlanStuck,
  completeUiStep,
  createUiPlan,
  deleteUiPlan,
  dispatchUiStep,
  emptyPlanStore,
  failUiStep,
  parsePlanStore,
  planProgressOf,
  planRepeatedCallReport,
  planToolSignature,
  recordUiToolCall,
  retryUiStep,
  skipUiStep,
  startUiStep,
} from '../apps/desktop/src/renderer/components/planStore.ts';
import { PlanEngine } from '../packages/core/dist/planning/engine.js';
import {
  StuckDetector,
  checkNoProgress,
  checkRepeatedCalls,
  toolCallSignature,
  trailingRepeatRun,
} from '../packages/core/dist/planning/stuck.js';

/** In-memory Storage stand-in (localStorage shape). */
function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
    _data: data,
  };
}

// ---------------------------------------------------------------------------
// Fuzzy search
// ---------------------------------------------------------------------------

test('fuzzy: exact and prefix matches score higher than scattered ones', () => {
  const exact = fuzzyScore('bot', 'bot');
  const prefix = fuzzyScore('bot', 'bot alpha');
  const scattered = fuzzyScore('bot', 'b-o-t list');
  assert.ok(exact !== null && prefix !== null && scattered !== null);
  assert.ok(exact > prefix, 'whole-text match beats a longer text');
  assert.ok(prefix > scattered, 'consecutive match beats a scattered one');
});

test('fuzzy: diacritic-insensitive (Vietnamese) and case-insensitive', () => {
  assert.equal(normalizeFuzzyText('Trợ lý ảo'), 'tro ly ao');
  assert.ok(fuzzyScore('tro ly', 'Trợ lý ảo') !== null);
  assert.ok(fuzzyScore('TAO BOT', 'Tạo bot mới') !== null);
  assert.ok(fuzzyScore('mcp', 'MCP Marketplace') !== null);
});

test('fuzzy: non-subsequence returns null; empty query matches everything', () => {
  assert.equal(fuzzyScore('xyz', 'bot alpha'), null);
  assert.equal(fuzzyScore('bot alpha extra', 'bot'), null);
  assert.equal(fuzzyScore('', 'anything'), 1);
  assert.deepEqual(fuzzyMatchRanges('bt', 'bot'), [[0, 1], [2, 3]]);
});

test('fuzzy: filter ranks best-first and keeps input order on ties', () => {
  const items = [
    { label: 'Tạo bot mới' },
    { label: 'Mở danh sách tool' },
    { label: 'Bot Alpha' },
  ];
  const ranked = fuzzyFilter(items, 'bot', (i) => i.label).map((r) => r.item.label);
  assert.equal(ranked[0], 'Bot Alpha', 'word-start match first');
  assert.ok(ranked.includes('Tạo bot mới'));
  const ties = fuzzyFilter([{ v: 'a1' }, { v: 'a2' }], 'a', (i) => i.v).map((r) => r.item.v);
  assert.deepEqual(ties, ['a1', 'a2'], 'stable order on equal scores');
});

// ---------------------------------------------------------------------------
// Palette recents
// ---------------------------------------------------------------------------

test('palette recents: record prepends, dedupes, caps at 8; corrupt storage reads empty', () => {
  const storage = memoryStorage();
  assert.deepEqual(readPaletteRecent(storage), []);
  recordPaletteRecent(storage, 'bot:a');
  recordPaletteRecent(storage, 'view:settings');
  recordPaletteRecent(storage, 'bot:a');
  assert.deepEqual(readPaletteRecent(storage), ['bot:a', 'view:settings']);
  for (let i = 0; i < 10; i++) recordPaletteRecent(storage, `view:v${i}`);
  const recent = readPaletteRecent(storage);
  assert.equal(recent.length, PALETTE_RECENT_MAX);
  assert.equal(recent[0], 'view:v9');
  assert.deepEqual(readPaletteRecent(memoryStorage({ [PALETTE_RECENT_KEY]: 'not-json{' })), []);
  assert.deepEqual(readPaletteRecent(null), []);
  assert.deepEqual(
    prunePaletteRecent(new Set(['bot:a']), ['bot:a', 'bot:gone']),
    ['bot:a'],
  );
});

// ---------------------------------------------------------------------------
// Bot management
// ---------------------------------------------------------------------------

const BOTS = [
  { id: 'b1', name: 'Alpha', providerId: 'gemini', model: 'gemini-2.5-flash' },
  { id: 'b2', name: 'Beta', providerId: 'openai', model: 'gpt-5' },
  { id: 'b3', name: 'Gamma', providerId: 'ollama', model: 'qwen2.5:0.5b' },
];

test('bot mgmt: pinned bots sort first (oldest pin first); hidden bots leave the list', () => {
  let meta = {};
  meta = togglePin(meta, 'b3', 100);
  meta = togglePin(meta, 'b1', 200);
  assert.deepEqual(sortBots(BOTS, meta).map((b) => b.id), ['b3', 'b1', 'b2']);
  meta = togglePin(meta, 'b3');
  assert.deepEqual(sortBots(BOTS, meta).map((b) => b.id), ['b1', 'b2', 'b3']);
  meta = setBotHidden(meta, 'b2', true);
  assert.deepEqual(sortBots(BOTS, meta).map((b) => b.id), ['b1', 'b3']);
  assert.deepEqual(hiddenBots(BOTS, meta).map((b) => b.id), ['b2']);
  meta = setBotHidden(meta, 'b2', false);
  assert.equal(sortBots(BOTS, meta).length, 3);
});

test('bot mgmt: unread counts only visible bots; opening clears it', () => {
  let meta = {};
  meta = setBotUnread(meta, 'b1', true);
  meta = setBotUnread(meta, 'b2', true);
  meta = setBotHidden(meta, 'b2', true);
  assert.equal(countUnread(BOTS, meta), 1, 'hidden bot does not count');
  meta = setBotUnread(meta, 'b1', false);
  assert.equal(countUnread(BOTS, meta), 0);
});

test('bot mgmt: duplicate copies the config with a fresh id and " (copy)" name', () => {
  const copy = duplicateBot(BOTS[0], 'b1-copy');
  assert.equal(copy.id, 'b1-copy');
  assert.equal(copy.name, 'Alpha (copy)');
  assert.equal(copy.providerId, 'gemini');
  assert.equal(copy.model, 'gemini-2.5-flash');
  assert.equal(BOTS[0].name, 'Alpha', 'original untouched');
  assert.throws(() => duplicateBot(BOTS[0], '  '), /new id/);
});

test('bot mgmt: copy conversation id prefers the thread id; corrupt meta parses empty', () => {
  assert.equal(conversationIdForCopy('bot-1', 'thread-9'), 'thread-9');
  assert.equal(conversationIdForCopy('bot-1', null), 'bot-1');
  assert.equal(conversationIdForCopy('bot-1', '  '), 'bot-1');
  assert.deepEqual(parseBotMeta('{"b1": {"pinned": true, "pinnedAt": 5}}'), {
    b1: { pinned: true, pinnedAt: 5 },
  });
  assert.deepEqual(parseBotMeta('not json'), {});
  assert.deepEqual(parseBotMeta(null), {});
  assert.deepEqual(parseBotMeta('{"b1": "junk"}'), {}, 'non-object entry is dropped');
});

// ---------------------------------------------------------------------------
// Dashboard aggregates (EventLog fixture)
// ---------------------------------------------------------------------------

const NOW = new Date('2026-11-13T15:00:00+07:00');
const TODAY = '2026-11-13T10:00:00+07:00';
const YESTERDAY = '2026-11-12T10:00:00+07:00';

function logEntry(at, botId, kind, payload = {}) {
  return { at, botId, kind, payload };
}

test('dashboard: aggregates count only today; tokens come from usage, never from text', () => {
  const entries = [
    logEntry(TODAY, 'b1', 'lifecycle', { phase: 'run-start' }),
    logEntry(TODAY, 'b1', 'tool_call', { tool: 'read_file' }),
    logEntry(TODAY, 'b1', 'tool_call', { tool: 'read_file' }),
    logEntry(TODAY, 'b1', 'tool_call', { tool: 'web_search' }),
    logEntry(TODAY, 'b2', 'lifecycle', { phase: 'run-start' }),
    logEntry(TODAY, 'b2', 'tool_call', { tool: 'read_file' }),
    logEntry(TODAY, 'b2', 'error', {}),
    logEntry(TODAY, 'b1', 'approval_request', {}),
    logEntry(TODAY, 'b1', 'lifecycle', { decision: 'route', router: true }),
    logEntry(YESTERDAY, 'b1', 'lifecycle', { phase: 'run-start' }),
    logEntry(YESTERDAY, 'b1', 'tool_call', { tool: 'read_file' }),
    logEntry(YESTERDAY, 'b1', 'lifecycle', { decision: 'route' }),
  ];
  const stats = aggregateDashboard({
    entries,
    botIds: ['b1', 'b2'],
    usageByBot: {
      b1: { today: { inputTokens: 1000, outputTokens: 200, costUsd: 0.01 } },
      b2: { today: { inputTokens: 500, outputTokens: 100, costUsd: null } },
    },
    memoryBlocksByBot: { b1: 12, b2: 3 },
    composioApps: [{ enabled: true }, { enabled: true }, { enabled: false }],
    automationsTotal: 4,
    now: NOW,
  });
  assert.equal(stats.botsTotal, 2);
  assert.equal(stats.runsToday, 2, 'only today run-start entries');
  assert.equal(stats.toolCallsToday, 4);
  assert.equal(stats.errorsToday, 1);
  assert.equal(stats.approvalsToday, 1);
  assert.equal(stats.tokensToday, 1800);
  assert.equal(stats.costUsdToday, null, 'one unpriced bot nulls the total');
  assert.equal(stats.memoryBlocks, 15);
  assert.equal(stats.routerDecisions, 2, 'today + yesterday');
  assert.equal(stats.routerDecisionsToday, 1);
  assert.equal(stats.composioConnected, 2);
  assert.equal(stats.automationsTotal, 4);
  assert.deepEqual(stats.topToolsToday[0], { tool: 'read_file', calls: 3 });
  assert.deepEqual(stats.runsTodayByBot, [
    { botId: 'b1', runs: 1, toolCalls: 3, errors: 0 },
    { botId: 'b2', runs: 1, toolCalls: 1, errors: 1 },
  ]);
});

test('dashboard: empty log gives zeros, not NaN; runs fall back to text boundaries', () => {
  const stats = aggregateDashboard({ entries: [], botIds: ['b1'], now: NOW });
  assert.equal(stats.runsToday, 0);
  assert.equal(stats.tokensToday, 0);
  assert.equal(stats.costUsdToday, 0);
  const fallback = aggregateDashboard({
    entries: [
      logEntry(TODAY, 'b1', 'text', {}),
      logEntry(TODAY, 'b1', 'text', {}),
      logEntry(TODAY, 'b1', 'result', {}),
      logEntry(TODAY, 'b1', 'text', {}),
    ],
    botIds: ['b1'],
    now: NOW,
  });
  assert.equal(fallback.runsToday, 2, 'text after a terminal entry starts a new run');
});

// ---------------------------------------------------------------------------
// Planning — UI store
// ---------------------------------------------------------------------------

function uiPlanWithSteps() {
  let store = emptyPlanStore();
  const plan = createUiPlan('Launch', { steps: ['Research', 'Build', 'Ship'] });
  store = addUiPlan(store, plan);
  return { store, plan };
}

test('plan store: lifecycle pending -> running -> done; failed retries; skip ends it', () => {
  let { store, plan } = uiPlanWithSteps();
  const [s1, s2, s3] = plan.steps;
  store = startUiStep(store, plan.id, s1.id);
  assert.equal(store.plans[0].steps[0].status, 'running');
  assert.equal(store.plans[0].steps[0].attempts, 1);
  store = completeUiStep(store, plan.id, s1.id);
  assert.equal(store.plans[0].steps[0].status, 'done');
  store = startUiStep(store, plan.id, s2.id);
  store = failUiStep(store, plan.id, s2.id, 'boom');
  assert.equal(store.plans[0].steps[1].status, 'failed');
  assert.equal(store.plans[0].steps[1].error, 'boom');
  store = retryUiStep(store, plan.id, s2.id);
  assert.equal(store.plans[0].steps[1].status, 'pending');
  store = skipUiStep(store, plan.id, s2.id);
  assert.equal(store.plans[0].steps[1].status, 'skipped');
  assert.throws(() => startUiStep(store, plan.id, s2.id), /skipped/);
  assert.throws(() => completeUiStep(store, plan.id, s3.id), /not running/);
  const progress = planProgressOf(store.plans[0]);
  assert.deepEqual(
    [progress.done, progress.skipped, progress.pending, progress.percent],
    [1, 1, 1, 33],
  );
});

test('plan store: dispatch claims own assigned step first, one running step per bot', () => {
  let { store, plan } = uiPlanWithSteps();
  const [s1, s2, s3] = plan.steps;
  store = assignUiStep(store, plan.id, s2.id, 'bot-b');
  let out = dispatchUiStep(store, plan.id, 'bot-b');
  assert.equal(out.step.id, s2.id, 'own assigned step wins over the oldest unassigned');
  store = out.store;
  out = dispatchUiStep(store, plan.id, 'bot-b');
  assert.equal(out.step, null, 'bot already runs a step');
  out = dispatchUiStep(store, plan.id, 'bot-a');
  assert.equal(out.step.id, s1.id, 'other bot takes the oldest unassigned step');
  store = out.store;
  assert.throws(() => assignUiStep(store, plan.id, s1.id, 'bot-b'), /running/);
  out = dispatchUiStep(store, plan.id, 'bot-c');
  assert.equal(out.step.id, s3.id);
});

test('plan store: stuck detector fires on 3 identical tool calls, then clears on a new step', () => {
  let { store, plan } = uiPlanWithSteps();
  const [s1] = plan.steps;
  store = startUiStep(store, plan.id, s1.id);
  const args = { path: '/tmp/x.txt' };
  let stuck = null;
  for (let i = 0; i < 2; i++) {
    ({ store, stuck } = recordUiToolCall(store, s1.id, 'read_file', args));
    assert.equal(stuck, null, `call ${i + 1} is not stuck yet`);
  }
  ({ store, stuck } = recordUiToolCall(store, s1.id, 'read_file', args));
  assert.ok(stuck, '3rd identical call fires');
  assert.equal(stuck.reason, 'repeated-tool-call');
  assert.equal(stuck.repeatCount, 3);
  assert.ok(stuck.signature.includes('read_file'));
  assert.ok(stuck.suggestions.includes('try-different-tool'));
  // A different call breaks the run.
  ({ store, stuck } = recordUiToolCall(store, s1.id, 'web_search', { q: 'x' }));
  assert.equal(stuck, null);
  // Argument order does not matter: the signature sorts keys, so the
  // same call with reordered args still counts as a repeat.
  assert.equal(
    planToolSignature('read_file', { path: '/a', limit: 10 }),
    planToolSignature('read_file', { limit: 10, path: '/a' }),
  );
});

test('plan store: no-progress fires after 3 failed/skipped steps without a done', () => {
  let { store, plan } = uiPlanWithSteps();
  const [s1, s2, s3] = plan.steps;
  for (const step of [s1, s2]) {
    store = startUiStep(store, plan.id, step.id);
    store = failUiStep(store, plan.id, step.id, 'x');
  }
  assert.equal(checkUiPlanStuck(store, plan.id), null, '2 failures is not stuck yet');
  store = skipUiStep(store, plan.id, s3.id);
  const stuck = checkUiPlanStuck(store, plan.id);
  assert.ok(stuck);
  assert.equal(stuck.reason, 'no-progress');
  assert.equal(stuck.failedSteps, 3);
});

test('plan store: corrupt storage parses empty; delete drops the plan and its history', () => {
  assert.deepEqual(parsePlanStore('garbage{'), emptyPlanStore());
  assert.deepEqual(parsePlanStore(null), emptyPlanStore());
  let { store, plan } = uiPlanWithSteps();
  store = deleteUiPlan(store, plan.id);
  assert.deepEqual(store.plans, []);
  assert.throws(() => addUiStep(store, plan.id, 'x'), /Unknown plan/);
});

test('plan store: tool-call history survives a stringify/parse round-trip (stuck banner after reload)', () => {
  let { store, plan } = uiPlanWithSteps();
  const [s1] = plan.steps;
  store = startUiStep(store, plan.id, s1.id);
  for (let i = 0; i < 3; i++) {
    ({ store } = recordUiToolCall(store, s1.id, 'read_file', { path: '/tmp/x.txt' }));
  }
  const restored = parsePlanStore(JSON.stringify({ plans: store.plans, toolHistory: store.toolHistory }));
  assert.equal(checkUiPlanStuck(restored, plan.id, s1.id)?.reason, 'repeated-tool-call');
  // Corrupt history entries are dropped, not fatal.
  const dirty = parsePlanStore(
    JSON.stringify({ plans: store.plans, toolHistory: { [s1.id]: ['ok()', 42, null] } }),
  );
  assert.deepEqual(dirty.toolHistory[s1.id], ['ok()']);
});

// ---------------------------------------------------------------------------
// Planning — core engine
// ---------------------------------------------------------------------------

let coreSeq = 0;
function coreEngine() {
  return new PlanEngine({ idFactory: () => `test-${++coreSeq}` });
}

test('core engine: full lifecycle + dispatch + release + JSON round-trip', () => {
  const engine = coreEngine();
  const plan = engine.createPlan('Core plan', { ownerBotId: 'bot-a', steps: ['One', 'Two', 'Three'] });
  const [s1, s2, s3] = plan.steps;
  engine.assignStep(plan.id, s2.id, 'bot-b');
  const claimed = engine.dispatch(plan.id, 'bot-b');
  assert.equal(claimed.id, s2.id);
  assert.equal(engine.dispatch(plan.id, 'bot-b'), null);
  assert.equal(engine.dispatch(plan.id, 'bot-a').id, s1.id);
  engine.completeStep(plan.id, s2.id);
  const released = engine.release(plan.id, 'bot-a');
  assert.equal(released.id, s1.id);
  assert.equal(released.status, 'pending');
  assert.equal(released.assigneeBotId, null);
  engine.startStep(plan.id, s1.id);
  engine.failStep(plan.id, s1.id, 'nope');
  engine.retryStep(plan.id, s1.id);
  engine.skipStep(plan.id, s1.id);
  const progress = engine.progress(plan.id);
  assert.deepEqual([progress.done, progress.skipped, progress.pending], [1, 1, 1]);
  const json = engine.toJSON(plan.id);
  const engine2 = coreEngine();
  const restored = engine2.fromJSON(json);
  assert.equal(restored.title, 'Core plan');
  assert.equal(restored.steps.length, 3);
  assert.throws(() => engine2.completeStep(plan.id, s3.id), /not running/);
  assert.throws(() => engine.createPlan('  '), /empty/);
  engine2.startStep(plan.id, s3.id);
  assert.throws(() => engine2.removeStep(plan.id, s3.id), /running/);
});

test('core stuck: signature ignores arg order; trailing run only counts the tail', () => {
  assert.equal(
    toolCallSignature('read_file', { path: '/a', limit: 10 }),
    toolCallSignature('read_file', { limit: 10, path: '/a' }),
  );
  assert.notEqual(
    toolCallSignature('read_file', { path: '/a' }),
    toolCallSignature('read_file', { path: '/b' }),
  );
  const history = [
    { tool: 'a', signature: 'a()', at: 1 },
    { tool: 'a', signature: 'a()', at: 2 },
    { tool: 'b', signature: 'b()', at: 3 },
    { tool: 'b', signature: 'b()', at: 4 },
    { tool: 'b', signature: 'b()', at: 5 },
  ];
  assert.deepEqual(trailingRepeatRun(history), { signature: 'b()', count: 3 });
  assert.equal(checkRepeatedCalls(history, 3)?.repeatCount, 3);
  assert.equal(checkRepeatedCalls(history.slice(0, 4), 3), null);
  assert.equal(checkNoProgress(2, 3), null);
  assert.equal(checkNoProgress(3, 3)?.reason, 'no-progress');
});

test('core stuck: detector fires mid-step on the 3rd repeat and resets per step', () => {
  const engine = coreEngine();
  const plan = engine.createPlan('Stuck plan', { steps: ['Loop'] });
  const [step] = plan.steps;
  engine.startStep(plan.id, step.id);
  assert.equal(engine.recordStepToolCall(plan.id, step.id, 'search', { q: 'same' }), null);
  assert.equal(engine.recordStepToolCall(plan.id, step.id, 'search', { q: 'same' }), null);
  const report = engine.recordStepToolCall(plan.id, step.id, 'search', { q: 'same' });
  assert.ok(report);
  assert.equal(report.reason, 'repeated-tool-call');
  assert.equal(report.repeatCount, 3);
  engine.failStep(plan.id, step.id, 'stuck');
  engine.retryStep(plan.id, step.id);
  engine.startStep(plan.id, step.id);
  assert.equal(engine.checkStuck(plan.id, step.id), null, 'new attempt starts clean');
});

test('core stuck: plan-level no-progress counts the trailing failed streak only', () => {
  const detector = new StuckDetector({ noProgressThreshold: 2 });
  assert.equal(detector.check(), null);
  detector.recordStepOutcome('failed');
  assert.equal(detector.check(), null, '1 failure is below the threshold of 2');
  detector.recordStepOutcome('failed');
  assert.equal(detector.check()?.reason, 'no-progress');
  detector.recordStepOutcome('done');
  assert.equal(detector.check(), null, 'a done step breaks the streak');
  detector.recordStepOutcome('skipped');
  assert.equal(detector.check(), null);
  detector.recordStepOutcome('failed');
  assert.equal(detector.check()?.failedSteps, 2);
});
