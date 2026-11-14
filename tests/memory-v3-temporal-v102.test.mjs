/**
 * Tests for v1.02 (Team T2) — temporal knowledge-graph queries:
 * packages/core/src/memory/graph/temporalQuery.ts.
 *
 * Covers: queryFactsAt (bi-temporal windows, incl. superseded facts
 * that were true in the past), findChangesInWindow (created /
 * superseded / deleted), findContradictionsBetween — the "what did
 * the user say last week that contradicts today" query, with
 * timestamped evidence — entityTimeline, formatContradiction, and
 * invalid-input handling.
 *
 * Time travel in tests: facts are seeded through the store, then
 * their createdAt/validFrom/validUntil are rewritten via the
 * in-memory backend and the store is re-opened on the same backend.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v3-temporal-v102.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TemporalGraphStore,
  InMemoryGraphBackend,
  queryFactsAt,
  findChangesInWindow,
  findContradictionsBetween,
  entityTimeline,
  formatContradiction,
} from '../packages/core/dist/memory/graph/index.js';

const SCOPE = { userId: 'user-1', botId: 'bot-a', runId: 'run-1' };

function provenance(turnId, at, sourceText) {
  return { episodeId: `ep-${turnId}`, turnId, runId: 'run-1', botId: 'bot-a', userId: 'user-1', at, sourceText };
}

function seedFact(store, subjectName, predicate, objectText, at, sourceText, confidence = 0.9) {
  return store.addFact({
    subjectName,
    predicate,
    objectText,
    confidence,
    scope: SCOPE,
    provenance: provenance(`t-${predicate}-${objectText}`, at, sourceText),
    validFrom: at,
  });
}

/**
 * Rewrite a fact's timestamps through the backend (the store sets
 * createdAt/validFrom/validUntil to "now" on write; tests need the
 * past). Returns a fresh store view over the same backend.
 */
function retime(backend, factId, patch) {
  const file = backend.load();
  const fact = file.facts.find((f) => f.id === factId);
  Object.assign(fact, patch);
  backend.save(file);
  return new TemporalGraphStore(backend);
}

function buildScenario() {
  const backend = new InMemoryGraphBackend();
  let store = new TemporalGraphStore(backend);
  // Last week: user lives in Ha Noi, likes pho bo.
  const livesHanoi = seedFact(store, 'user', 'lives_in', 'Hà Nội', '2026-11-03T10:00:00.000Z', 'Tôi sống ở Hà Nội.');
  const likesPho = seedFact(store, 'user', 'likes', 'phở bò', '2026-11-04T10:00:00.000Z', 'Tôi thích phở bò.');
  // This week: user moved to Ho Chi Minh City (supersedes Ha Noi).
  const livesHcm = store.supersedeFact(livesHanoi.id, {
    subjectName: 'user',
    predicate: 'lives_in',
    objectText: 'TP. Hồ Chí Minh',
    confidence: 0.95,
    scope: SCOPE,
    provenance: provenance('t-move', '2026-11-12T10:00:00.000Z', 'Tôi đã chuyển vào TP. Hồ Chí Minh.'),
  });
  // Rewrite timestamps to the intended past dates.
  store = retime(backend, livesHanoi.id, { createdAt: '2026-11-03T10:00:00.000Z', validUntil: '2026-11-12T10:00:00.000Z', updatedAt: '2026-11-12T10:00:00.000Z' });
  store = retime(backend, livesHcm.id, { createdAt: '2026-11-12T10:00:00.000Z', validFrom: '2026-11-12T10:00:00.000Z', updatedAt: '2026-11-12T10:00:00.000Z' });
  store = retime(backend, likesPho.id, { createdAt: '2026-11-04T10:00:00.000Z', validFrom: '2026-11-04T10:00:00.000Z' });
  return { backend, store, livesHanoi, livesHcm, likesPho };
}

test('queryFactsAt: Ha Noi was true last week, HCMC is true today', () => {
  const { store } = buildScenario();
  const lastWeek = queryFactsAt(store, '2026-11-05T00:00:00.000Z', { scope: SCOPE });
  const lastWeekObjects = lastWeek.map((f) => f.fact.objectText);
  assert.ok(lastWeekObjects.includes('Hà Nội'), 'Ha Noi was true on Nov 5');
  assert.ok(lastWeekObjects.includes('phở bò'), 'pho bo was true on Nov 5');
  assert.ok(!lastWeekObjects.includes('TP. Hồ Chí Minh'), 'HCMC not true yet on Nov 5');

  const today = queryFactsAt(store, '2026-11-14T00:00:00.000Z', { scope: SCOPE });
  const todayObjects = today.map((f) => f.fact.objectText);
  assert.ok(todayObjects.includes('TP. Hồ Chí Minh'), 'HCMC true on Nov 14');
  assert.ok(!todayObjects.includes('Hà Nội'), 'Ha Noi no longer true on Nov 14');
  assert.ok(todayObjects.includes('phở bò'), 'pho bo still true');
});

test('queryFactsAt: invalid date returns []', () => {
  const { store } = buildScenario();
  assert.deepEqual(queryFactsAt(store, 'not-a-date', { scope: SCOPE }), []);
});

test('findChangesInWindow: move week shows superseded + created, earlier week shows created only', () => {
  const { store } = buildScenario();
  const moveWeek = findChangesInWindow(store, '2026-11-11T00:00:00.000Z', '2026-11-13T00:00:00.000Z', { scope: SCOPE });
  const kinds = moveWeek.map((c) => `${c.kind}:${c.fact.objectText}`);
  assert.ok(kinds.includes('superseded:Hà Nội'), `got ${kinds.join(', ')}`);
  assert.ok(kinds.includes('created:TP. Hồ Chí Minh'), `got ${kinds.join(', ')}`);
  const superseded = moveWeek.find((c) => c.kind === 'superseded');
  assert.equal(superseded.replacedById, moveWeek.find((c) => c.kind === 'created').fact.id);

  const firstWeek = findChangesInWindow(store, '2026-11-03T00:00:00.000Z', '2026-11-05T00:00:00.000Z', { scope: SCOPE });
  assert.deepEqual(firstWeek.map((c) => c.kind), ['created', 'created']);
  assert.deepEqual(findChangesInWindow(store, '2026-11-13T00:00:00.000Z', '2026-11-11T00:00:00.000Z', { scope: SCOPE }), []);
});

test('findContradictionsBetween: last week vs today finds the move, with timestamped evidence', () => {
  const { store } = buildScenario();
  const contradictions = findContradictionsBetween(
    store,
    { from: '2026-11-03T00:00:00.000Z', to: '2026-11-09T00:00:00.000Z' },
    { from: '2026-11-12T00:00:00.000Z', to: '2026-11-16T00:00:00.000Z' },
    { scope: SCOPE },
  );
  assert.equal(contradictions.length, 1, JSON.stringify(contradictions, null, 2));
  const [c] = contradictions;
  assert.equal(c.subjectName, 'user');
  assert.equal(c.predicate, 'lives_in');
  assert.equal(c.earlier.objectText, 'Hà Nội');
  assert.equal(c.later.objectText, 'TP. Hồ Chí Minh');
  // Evidence: source sentence + timestamps on both sides.
  assert.equal(c.earlier.sourceText, 'Tôi sống ở Hà Nội.');
  assert.equal(c.later.sourceText, 'Tôi đã chuyển vào TP. Hồ Chí Minh.');
  assert.equal(c.earlier.at, '2026-11-03T10:00:00.000Z');
  assert.equal(c.later.at, '2026-11-12T10:00:00.000Z');
  assert.equal(c.earlier.validUntil, '2026-11-12T10:00:00.000Z');
  assert.equal(c.later.validUntil, null);
  const text = formatContradiction(c);
  assert.ok(text.includes('Hà Nội'));
  assert.ok(text.includes('TP. Hồ Chí Minh'));
  assert.ok(text.includes('2026-11-03'));
  assert.ok(text.includes('2026-11-12'));
});

test('findContradictionsBetween: same object in both windows is not a contradiction', () => {
  const { store } = buildScenario();
  // likes/pho bo is true in both windows with the same object.
  const contradictions = findContradictionsBetween(
    store,
    { from: '2026-11-03T00:00:00.000Z', to: '2026-11-09T00:00:00.000Z' },
    { from: '2026-11-03T00:00:00.000Z', to: '2026-11-09T00:00:00.000Z' },
    { scope: SCOPE },
  );
  assert.deepEqual(contradictions, []);
});

test('findContradictionsBetween: invalid windows return []', () => {
  const { store } = buildScenario();
  assert.deepEqual(
    findContradictionsBetween(store, { from: 'bad', to: '2026-11-09T00:00:00.000Z' }, { from: '2026-11-12T00:00:00.000Z', to: '2026-11-16T00:00:00.000Z' }, { scope: SCOPE }),
    [],
  );
});

test('entityTimeline: user timeline is chronological with change kinds', () => {
  const { store } = buildScenario();
  const timeline = entityTimeline(store, 'user', { scope: SCOPE });
  assert.equal(timeline.length, 3);
  assert.equal(timeline[0].fact.objectText, 'Hà Nội');
  assert.equal(timeline[0].kind, 'superseded');
  assert.equal(timeline[1].fact.objectText, 'phở bò');
  assert.equal(timeline[1].kind, 'active');
  assert.equal(timeline[2].fact.objectText, 'TP. Hồ Chí Minh');
  assert.equal(timeline[2].kind, 'active');
  assert.ok(timeline[0].text.includes('lives_in'));
  assert.deepEqual(entityTimeline(store, 'no-such-entity', { scope: SCOPE }), []);
});
