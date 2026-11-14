/**
 * Tests for v1.02 (Team T2) — multi-scope memory + fused retrieval:
 * packages/core/src/memory/graph/{scopes,fusedRetrieval}.ts.
 *
 * Covers: scope levels (run/agent/user/app), inheritance chain,
 * parentScope, scopeIncludes visibility, narrowScopeTo, entity search
 * by name/alias, fused retrieval across the scope chain (run sees
 * agent/user/app facts, weighted so narrow wins), entity as a fourth
 * retrieval source, skipSemantic fail-open.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-v3-scopes-fused-v102.test.mjs
 *
 * No network. No model (semantic source skipped in tests).
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  TemporalGraphStore,
  InMemoryGraphBackend,
  scopeLevel,
  scopeLevelWeight,
  parentScope,
  expandScopeChain,
  scopeIncludes,
  scopeSameLevel,
  scopeLabel,
  narrowScopeTo,
  searchEntitiesByName,
  fusedRetrieve,
} from '../packages/core/dist/memory/graph/index.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-memv3-scopes-v102-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function provenance(botId = 'bot-a', runId = 'run-1') {
  return {
    episodeId: 'ep-1',
    turnId: 'turn-1',
    runId,
    botId,
    userId: 'user-1',
    at: '2026-11-14T08:00:00.000Z',
    sourceText: 'seed',
  };
}

function seedFact(store, subjectName, predicate, objectText, scope, confidence = 0.8) {
  return store.addFact({
    subjectName,
    predicate,
    objectText,
    // lives_in / works_at objects are entities (places / orgs).
    ...(predicate === 'lives_in' || predicate === 'works_at' ? { objectIsEntity: true } : {}),
    confidence,
    scope,
    provenance: provenance(scope.botId || 'bot-a', scope.runId || 'run-1'),
  });
}

// --- Scopes ------------------------------------------------------------

test('scopeLevel: run > agent > user > app by bound fields', () => {
  assert.equal(scopeLevel({ userId: 'u', botId: 'b', runId: 'r' }), 'run');
  assert.equal(scopeLevel({ userId: 'u', botId: 'b', runId: '' }), 'agent');
  assert.equal(scopeLevel({ userId: 'u', botId: '', runId: '' }), 'user');
  assert.equal(scopeLevel({ userId: '', botId: '', runId: '' }), 'app');
  assert.equal(scopeLevel({ userId: '', botId: '', runId: '', appId: 'app-1' }), 'app');
});

test('scopeLevelWeight: narrow scope weighs more', () => {
  assert.ok(scopeLevelWeight('run') > scopeLevelWeight('agent'));
  assert.ok(scopeLevelWeight('agent') > scopeLevelWeight('user'));
  assert.ok(scopeLevelWeight('user') > scopeLevelWeight('app'));
});

test('parentScope + expandScopeChain: run -> agent -> user -> app', () => {
  const run = { userId: 'u', botId: 'b', runId: 'r', appId: 'app-1' };
  assert.deepEqual(parentScope(run), { userId: 'u', botId: 'b', runId: '', appId: 'app-1' });
  assert.deepEqual(parentScope({ userId: 'u', botId: 'b', runId: '' }), { userId: 'u', botId: '', runId: '' });
  assert.deepEqual(parentScope({ userId: 'u', botId: '', runId: '' }), { userId: '', botId: '', runId: '' });
  assert.equal(parentScope({ userId: '', botId: '', runId: '' }), null);
  const chain = expandScopeChain(run);
  assert.equal(chain.length, 4);
  assert.equal(scopeLevel(chain[0]), 'run');
  assert.equal(scopeLevel(chain[1]), 'agent');
  assert.equal(scopeLevel(chain[2]), 'user');
  assert.equal(scopeLevel(chain[3]), 'app');
  assert.equal(chain[3].appId, 'app-1');
  // An agent query starts at agent level (3 levels).
  assert.equal(expandScopeChain({ userId: 'u', botId: 'b', runId: '' }).length, 3);
});

test('scopeIncludes: query sees its cone — own run + wider levels, never other runs/users', () => {
  const run = { userId: 'u', botId: 'b', runId: 'r' };
  assert.equal(scopeIncludes(run, { userId: 'u', botId: 'b', runId: 'r' }), true);
  assert.equal(scopeIncludes(run, { userId: 'u', botId: 'b', runId: '' }), true);
  assert.equal(scopeIncludes(run, { userId: 'u', botId: '', runId: '' }), true);
  assert.equal(scopeIncludes(run, { userId: '', botId: '', runId: '' }), true);
  assert.equal(scopeIncludes(run, { userId: 'u', botId: 'b', runId: 'other-run' }), false);
  assert.equal(scopeIncludes(run, { userId: 'u', botId: 'other', runId: '' }), false);
  assert.equal(scopeIncludes(run, { userId: 'other', botId: '', runId: '' }), false);
  // An agent query sees every run of that bot (recall across runs).
  const agent = { userId: 'u', botId: 'b', runId: '' };
  assert.equal(scopeIncludes(agent, { userId: 'u', botId: 'b', runId: 'r' }), true);
  assert.equal(scopeIncludes(agent, { userId: 'u', botId: 'other', runId: 'r' }), false);
});

test('scopeSameLevel: same level + compatible bindings only', () => {
  const run = { userId: 'u', botId: 'b', runId: 'r' };
  assert.equal(scopeSameLevel(run, { userId: 'u', botId: 'b', runId: 'r' }), true);
  assert.equal(scopeSameLevel(run, { userId: 'u', botId: 'b', runId: '' }), false);
  assert.equal(scopeSameLevel(run, { userId: 'u', botId: 'b', runId: 'other' }), false);
  const agent = { userId: 'u', botId: 'b', runId: '' };
  assert.equal(scopeSameLevel(agent, { userId: 'u', botId: 'b', runId: 'r' }), false);
  assert.equal(scopeSameLevel(agent, { userId: 'u', botId: 'b', runId: '' }), true);
  // Legacy '' userId counts as the current user.
  assert.equal(scopeSameLevel(agent, { userId: '', botId: 'b', runId: '' }), true);
});

test('scopeLabel + narrowScopeTo', () => {
  assert.equal(scopeLabel({ userId: 'u', botId: 'b', runId: 'r' }), 'run:r');
  assert.equal(scopeLabel({ userId: 'u', botId: 'b', runId: '' }), 'agent:b');
  assert.equal(scopeLabel({ userId: 'u', botId: '', runId: '' }), 'user:u');
  assert.equal(scopeLabel({ userId: '', botId: '', runId: '', appId: 'app-1' }), 'app:app-1');
  const full = { userId: 'u', botId: 'b', runId: 'r', appId: 'app-1' };
  assert.deepEqual(narrowScopeTo(full, 'user'), { userId: 'u', botId: '', runId: '' });
  assert.deepEqual(narrowScopeTo(full, 'app'), { userId: '', botId: '', runId: '', appId: 'app-1' });
  assert.deepEqual(narrowScopeTo(full, 'run'), full);
});

// --- Entity search -----------------------------------------------------

test('searchEntitiesByName: exact > contains > alias, no match -> []', () => {
  const store = new TemporalGraphStore(new InMemoryGraphBackend());
  seedFact(store, 'user', 'lives_in', 'TP. Hồ Chí Minh', { userId: 'u', botId: 'b', runId: 'r' }, 0.9);
  const hcm = store.findEntityByName('TP. Hồ Chí Minh');
  store.addAlias(hcm.id, 'Sài Gòn');
  seedFact(store, 'user', 'likes', 'phở bò', { userId: 'u', botId: 'b', runId: 'r' }, 0.9);

  const exact = searchEntitiesByName(store, 'TP. Hồ Chí Minh');
  assert.equal(exact.length, 1);
  assert.equal(exact[0].score, 1.0);
  const alias = searchEntitiesByName(store, 'Sài Gòn');
  assert.equal(alias.length, 1);
  assert.equal(alias[0].entity.id, hcm.id);
  assert.equal(alias[0].score, 0.7);
  assert.deepEqual(searchEntitiesByName(store, 'không có'), []);
  assert.deepEqual(searchEntitiesByName(store, ''), []);
});

// --- Fused retrieval ---------------------------------------------------

test('fusedRetrieve: run query sees agent/user/app facts via inheritance', async () => {
  const store = new TemporalGraphStore(new InMemoryGraphBackend());
  const runScope = { userId: 'u', botId: 'b', runId: 'r' };
  seedFact(store, 'user', 'likes', 'phở bò', runScope);
  seedFact(store, 'user', 'likes', 'bún chả', { userId: 'u', botId: 'b', runId: '' });
  seedFact(store, 'user', 'likes', 'cơm tấm', { userId: 'u', botId: '', runId: '' });
  seedFact(store, 'user', 'likes', 'bánh mì', { userId: '', botId: '', runId: '', appId: 'app-1' });
  // A fact from another user must never leak in.
  seedFact(store, 'user', 'likes', 'mì quảng', { userId: 'other', botId: '', runId: '' });

  const result = await fusedRetrieve(store, 'likes', runScope, {
    skipSemantic: true,
    topK: 10,
  });
  const objects = result.hits.map((h) => h.fact.objectText);
  assert.ok(objects.includes('phở bò'), 'run fact');
  assert.ok(objects.includes('bún chả'), 'agent fact');
  assert.ok(objects.includes('cơm tấm'), 'user fact');
  assert.ok(objects.includes('bánh mì'), 'app fact');
  assert.ok(!objects.includes('mì quảng'), 'other user must not leak');
  assert.deepEqual(result.scopesSearched, ['run', 'agent', 'user', 'app']);
  assert.ok(result.sourcesUsed.includes('keyword'));
  // Narrow scope wins on ties: the run-level fact ranks first when
  // all four match the same keyword set equally.
  assert.equal(result.hits[0].fact.objectText, 'phở bò');
  assert.equal(result.hits[0].factScopeLevel, 'run');
});

test('fusedRetrieve: includeInheritedScopes=false limits to the query scope', async () => {
  const store = new TemporalGraphStore(new InMemoryGraphBackend());
  const runScope = { userId: 'u', botId: 'b', runId: 'r' };
  seedFact(store, 'user', 'likes', 'phở bò', runScope);
  seedFact(store, 'user', 'likes', 'bún chả', { userId: 'u', botId: 'b', runId: '' });
  const result = await fusedRetrieve(store, 'likes', runScope, {
    skipSemantic: true,
    includeInheritedScopes: false,
    topK: 10,
  });
  const objects = result.hits.map((h) => h.fact.objectText);
  assert.ok(objects.includes('phở bò'));
  assert.ok(!objects.includes('bún chả'));
  assert.deepEqual(result.scopesSearched, ['run']);
});

test('fusedRetrieve: entity source finds a fact by alias the keyword source misses', async () => {
  const store = new TemporalGraphStore(new InMemoryGraphBackend());
  const scope = { userId: 'u', botId: 'b', runId: 'r' };
  seedFact(store, 'user', 'lives_in', 'TP. Hồ Chí Minh', scope, 0.9);
  const hcm = store.findEntityByName('TP. Hồ Chí Minh');
  store.addAlias(hcm.id, 'Sài Gòn');

  // "Sài Gòn" never appears in the fact text, so BM25 cannot match
  // it — the entity (alias) source is what recalls the fact.
  const result = await fusedRetrieve(store, 'Sài Gòn', scope, { skipSemantic: true, topK: 5 });
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].fact.objectText, 'TP. Hồ Chí Minh');
  assert.ok(result.hits[0].sources.includes('entity'), `sources: ${result.hits[0].sources.join(',')}`);
  assert.ok(result.sourcesUsed.includes('entity'));
});

test('fusedRetrieve: empty query + empty store are fail-open', async () => {
  const store = new TemporalGraphStore(new InMemoryGraphBackend());
  const scope = { userId: 'u', botId: 'b', runId: 'r' };
  const empty = await fusedRetrieve(store, '   ', scope, { skipSemantic: true });
  assert.deepEqual(empty.hits, []);
  const noFacts = await fusedRetrieve(store, 'phở', scope, { skipSemantic: true });
  assert.deepEqual(noFacts.hits, []);
  assert.ok(noFacts.notes.length > 0);
});
