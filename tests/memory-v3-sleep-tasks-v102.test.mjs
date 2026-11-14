/**
 * Tests for v1.02 (Team T2) — sleep-time maintenance:
 * packages/core/src/memory/graph/sleepTasks.ts (+ store.mergeFacts /
 * store.setFactConfidence).
 *
 * Covers: dedupe of near-identical facts (exact normalized match and
 * token-Jaccard match; different objects are NOT merged), promotion
 * of facts referenced by many episodes (confidence boost, capped at
 * 1.0), pruning of old low-confidence unreferenced facts (recent or
 * referenced facts are never pruned), digest of old processed
 * episodes, and the maintenance report shape.
 *
 * Time travel: fact updatedAt is rewritten via the in-memory backend.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v3-sleep-tasks-v102.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TemporalGraphStore,
  InMemoryGraphBackend,
  runSleepMaintenance,
  countFactReferences,
} from '../packages/core/dist/memory/graph/index.js';

const SCOPE = { userId: 'user-1', botId: 'bot-a', runId: 'run-1' };
const NOW = Date.parse('2026-11-14T08:00:00.000Z');

function provenance(turnId, sourceText) {
  return { episodeId: `ep-${turnId}`, turnId, runId: 'run-1', botId: 'bot-a', userId: 'user-1', at: '2026-11-14T08:00:00.000Z', sourceText };
}

function seedFact(store, subjectName, predicate, objectText, confidence = 0.8) {
  return store.addFact({
    subjectName,
    predicate,
    objectText,
    confidence,
    scope: SCOPE,
    provenance: provenance(`t-${predicate}`, `${subjectName} ${predicate} ${objectText}`),
  });
}

function retime(backend, factId, patch) {
  const file = backend.load();
  Object.assign(file.facts.find((f) => f.id === factId), patch);
  backend.save(file);
  return new TemporalGraphStore(backend);
}

test('store.mergeFacts: duplicates close as superseded pointing at the keeper', () => {
  const backend = new InMemoryGraphBackend();
  const store = new TemporalGraphStore(backend);
  const keep = seedFact(store, 'user', 'likes', 'phở bò', 0.9);
  const dup = seedFact(store, 'user', 'likes', 'pho bo', 0.7);
  const other = seedFact(store, 'user', 'likes', 'bún chả', 0.8);
  const merged = store.mergeFacts(keep.id, [dup.id, other.id, keep.id, 'no-such-id'], 'test');
  // other is a DIFFERENT object — mergeFacts trusts the caller's list,
  // so it merges what it is told to (dedupe selection lives in sleepTasks).
  assert.deepEqual(merged.sort(), [dup.id, other.id].sort());
  assert.equal(store.getFact(dup.id).status, 'superseded');
  assert.equal(store.getFact(dup.id).supersededBy, keep.id);
  assert.equal(store.getFact(keep.id).status, 'active');
  assert.equal(store.getFact(keep.id).objectText, 'phở bò');
});

test('store.setFactConfidence: clamps to 0..1', () => {
  const store = new TemporalGraphStore(new InMemoryGraphBackend());
  const fact = seedFact(store, 'user', 'likes', 'phở bò', 0.8);
  assert.equal(store.setFactConfidence(fact.id, 1.5).confidence, 1);
  assert.equal(store.setFactConfidence(fact.id, -0.5).confidence, 0);
  assert.throws(() => store.setFactConfidence('no-such-id', 0.5));
});

test('runSleepMaintenance: dedupes near-identical facts, keeps the strongest', () => {
  const backend = new InMemoryGraphBackend();
  let store = new TemporalGraphStore(backend);
  const keep = seedFact(store, 'user', 'likes', 'phở bò', 0.9);
  seedFact(store, 'user', 'likes', 'pho bo', 0.7);
  seedFact(store, 'user', 'likes', 'Phở Bò', 0.6);
  const different = seedFact(store, 'user', 'likes', 'bún chả', 0.8);
  // Near miss: Jaccard 0.667 < 0.8 threshold — survives on purpose.
  const nearMiss = seedFact(store, 'user', 'likes', 'phở bò ngon', 0.65);
  const report = runSleepMaintenance(store, SCOPE, { now: () => NOW });
  assert.equal(report.deduped, 2, JSON.stringify(report, null, 2));
  assert.equal(report.dedupeGroups.length, 1);
  assert.equal(report.dedupeGroups[0].keepFactId, keep.id);
  assert.equal(store.getFact(keep.id).status, 'active');
  assert.equal(store.getFact(different.id).status, 'active');
  assert.equal(store.getFact(nearMiss.id).status, 'active');
  assert.equal(store.listFacts({ ...SCOPE, status: 'active' }).length, 3);
});

test('runSleepMaintenance: promotes facts referenced by many episodes', () => {
  const backend = new InMemoryGraphBackend();
  const store = new TemporalGraphStore(backend);
  const fact = seedFact(store, 'user', 'likes', 'phở bò', 0.8);
  // Three episodes reference the fact.
  for (let i = 1; i <= 3; i += 1) {
    const { id } = store.ingestEpisode({
      turnId: `turn-${i}`,
      runId: 'run-1',
      botId: 'bot-a',
      userId: 'user-1',
      role: 'user',
      text: `Tôi thích phở bò (${i}).`,
    });
    store.markEpisodeProcessed(id, [fact.id]);
  }
  assert.equal(countFactReferences(store, fact.id), 3);
  const report = runSleepMaintenance(store, SCOPE, { now: () => NOW, promoteMinReferences: 3, promoteBoost: 0.05 });
  assert.equal(report.promoted, 1);
  assert.deepEqual(report.promotedFactIds, [fact.id]);
  assert.equal(store.getFact(fact.id).confidence, 0.85);
});

test('runSleepMaintenance: prunes only old + low-confidence + unreferenced facts', () => {
  const backend = new InMemoryGraphBackend();
  let store = new TemporalGraphStore(backend);
  const stale = seedFact(store, 'user', 'wants', 'một con mèo', 0.4);
  const recent = seedFact(store, 'user', 'wants', 'một con chó', 0.4);
  const trusted = seedFact(store, 'user', 'wants', 'một chiếc xe', 0.9);
  // stale: 100 days old, never referenced. recent: fresh. trusted: old but high confidence.
  store = retime(backend, stale.id, { updatedAt: '2026-08-06T08:00:00.000Z' });
  store = retime(backend, trusted.id, { updatedAt: '2026-08-06T08:00:00.000Z' });
  const report = runSleepMaintenance(store, SCOPE, { now: () => NOW, pruneMaxConfidence: 0.5, pruneStaleDays: 90 });
  assert.deepEqual(report.prunedFactIds, [stale.id]);
  assert.equal(store.getFact(stale.id).status, 'deleted');
  assert.equal(store.getFact(recent.id).status, 'active');
  assert.equal(store.getFact(trusted.id).status, 'active');
});

test('runSleepMaintenance: digest summarizes old processed episodes', () => {
  const backend = new InMemoryGraphBackend();
  const store = new TemporalGraphStore(backend);
  const fact = seedFact(store, 'user', 'likes', 'phở bò', 0.9);
  const { id } = store.ingestEpisode({
    turnId: 'turn-old',
    runId: 'run-1',
    botId: 'bot-a',
    userId: 'user-1',
    role: 'user',
    text: 'Tôi thích phở bò.',
  });
  store.markEpisodeProcessed(id, [fact.id]);
  // Episode is 40 days old.
  const file = backend.load();
  file.episodes.find((e) => e.id === id).createdAt = '2026-10-05T08:00:00.000Z';
  backend.save(file);
  const store2 = new TemporalGraphStore(backend);
  const report = runSleepMaintenance(store2, SCOPE, { now: () => NOW, digestOlderThanDays: 30 });
  assert.equal(report.digest.episodes, 1);
  assert.equal(report.digest.facts, 1);
  assert.equal(report.digest.lines.length, 1);
  assert.ok(report.digest.lines[0].includes('phở bò'));
  assert.deepEqual(report.errors, []);
});

test('runSleepMaintenance: empty graph reports zeros, no throw', () => {
  const store = new TemporalGraphStore(new InMemoryGraphBackend());
  const report = runSleepMaintenance(store, SCOPE, { now: () => NOW });
  assert.equal(report.deduped, 0);
  assert.equal(report.promoted, 0);
  assert.equal(report.pruned, 0);
  assert.deepEqual(report.errors, []);
});
