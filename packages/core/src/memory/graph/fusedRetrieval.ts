/**
 * Fused retrieval (v1.02, memory v3).
 *
 * Two fusions on top of the v0.98 hybrid search (semantic + BM25 +
 * graph traversal, merged with RRF):
 *
 *  1. Multi-scope fusion: the query scope's visibility cone
 *     (run -> agent -> user -> app, see scopes.ts) is searched in
 *     one hybrid pass and the hits are merged with Reciprocal Rank
 *     Fusion, weighted by the fact's own scope level so a run-level
 *     memory beats an app-level one on ties. One call sees the
 *     whole hierarchy, and another user's facts never leak in.
 *  2. Entity search as an explicit fourth source: entities whose
 *     name or alias matches the query contribute their facts
 *     directly (ranked by how well the entity name matches), so a
 *     query that names a person/place finds facts ABOUT that entity
 *     even when the fact text shares no keyword with the query.
 *
 * Every hit reports which scopes and sources produced it, so the UI
 * can explain why a memory was recalled.
 */

import type { Embedder } from '../embeddings';
import type { GraphEntity, GraphFact, MemoryScope } from './types';
import { normalizeGraphText } from './types';
import type { TemporalGraphStore } from './store';
import { hybridSearch } from './hybridSearch';
import type { HybridSearchHit, HybridSearchOptions } from './hybridSearch';
import { RRF_K } from './hybridSearch';
import { expandScopeChain, scopeIncludes, scopeLevel, scopeLevelWeight, scopeSameLevel } from './scopes';
import type { ScopeLevel } from './scopes';

export type FusedSource = 'semantic' | 'keyword' | 'graph' | 'entity';

export interface FusedHit {
  fact: GraphFact;
  subjectName: string;
  objectName?: string;
  /** Fused RRF score (scope-weighted). */
  score: number;
  /** Retrieval sources that produced this fact. */
  sources: FusedSource[];
  /** Scope levels the fact came from (a fact has one scope, but the same fact can match several levels only via inheritance — listed for transparency). */
  scopeLevels: ScopeLevel[];
  /** Scope level of the fact's own scope. */
  factScopeLevel: ScopeLevel;
  sourceScores: HybridSearchHit['sourceScores'] & { entity?: number };
}

export interface FusedRetrievalOptions {
  /** Max results (default 10, capped at 50). */
  topK?: number;
  /** Embedder for the semantic source (default: Ollama local). */
  embedder?: Embedder;
  /** Skip the semantic source (e.g. Ollama known down). */
  skipSemantic?: boolean;
  /** Only facts valid right now (default true). */
  onlyValidNow?: boolean;
  /** Backfill embeddings for facts that lack them (default false). */
  backfillEmbeddings?: boolean;
  /** Search the whole inheritance chain (default true). False = query scope only. */
  includeInheritedScopes?: boolean;
}

export interface FusedRetrievalResult {
  query: string;
  hits: FusedHit[];
  /** Scope levels actually searched. */
  scopesSearched: ScopeLevel[];
  /** Sources that ran (semantic absent when Ollama is down). */
  sourcesUsed: FusedSource[];
  notes: string[];
}

/**
 * Entity search: entities whose normalized name or alias contains
 * (or is contained in) the normalized query, best match first.
 * Ranked by match quality, then by how many facts point at them.
 */
export function searchEntitiesByName(
  store: TemporalGraphStore,
  query: string,
  limit = 5,
): Array<{ entity: GraphEntity; score: number }> {
  const queryNorm = normalizeGraphText(query);
  if (queryNorm === '') return [];
  const scored: Array<{ entity: GraphEntity; score: number }> = [];
  for (const entity of store.listEntities()) {
    const nameNorm = normalizeGraphText(entity.name);
    if (nameNorm === '') continue;
    let score = 0;
    if (nameNorm === queryNorm) score = 1.0;
    else if (queryNorm.includes(nameNorm)) score = 0.9;
    else if (nameNorm.includes(queryNorm)) score = 0.8;
    else {
      const aliasHit = entity.aliases.some((a) => {
        const aNorm = normalizeGraphText(a);
        return aNorm !== '' && (queryNorm.includes(aNorm) || aNorm.includes(queryNorm));
      });
      if (aliasHit) score = 0.7;
    }
    if (score > 0) scored.push({ entity, score });
  }
  scored.sort((a, b) => b.score - a.score || b.entity.factCount - a.entity.factCount);
  return scored.slice(0, Math.max(1, Math.min(20, limit)));
}

/**
 * Fused retrieval: one hybrid search (semantic + BM25 + graph
 * traversal) whose scope filter already implements the visibility
 * cone (run sees its run + agent + user + app; another user's facts
 * never leak in), plus entity search as a fourth source. Hits are
 * merged with Reciprocal Rank Fusion, weighted by the fact's OWN
 * scope level, so a run-level memory beats an app-level one on ties.
 * `includeInheritedScopes: false` restricts the result to facts
 * stored at exactly the query scope's level.
 * Never throws because Ollama is down — the semantic source is
 * simply absent (same fail-open contract as hybridSearch).
 */
export async function fusedRetrieve(
  store: TemporalGraphStore,
  query: string,
  scope: MemoryScope,
  opts: FusedRetrievalOptions = {},
): Promise<FusedRetrievalResult> {
  const topK = Math.max(1, Math.min(50, opts.topK ?? 10));
  const trimmed = (query ?? '').trim();
  const notes: string[] = [];
  if (trimmed === '') {
    return { query: trimmed, hits: [], scopesSearched: [], sourcesUsed: [], notes: ['Empty query.'] };
  }

  const inherit = opts.includeInheritedScopes !== false;
  const chain = inherit ? expandScopeChain(scope) : [scope];
  const scopesSearched = chain.map((s) => scopeLevel(s));
  const sourcesUsed = new Set<FusedSource>();
  const rrf = new Map<
    string,
    { score: number; sources: Set<FusedSource>; levels: Set<ScopeLevel>; sourceScores: FusedHit['sourceScores'] }
  >();

  // A fact passes the visibility gate when the query scope can see
  // it (inheritance on) or when it lives at exactly the query
  // scope's level (inheritance off).
  const visible = (fact: GraphFact): boolean =>
    inherit ? scopeIncludes(scope, fact.scope) : scopeSameLevel(scope, fact.scope);

  const addRank = (
    id: string,
    rank: number,
    source: FusedSource,
    score: number,
    level: ScopeLevel,
  ): void => {
    const entry = rrf.get(id) ?? { score: 0, sources: new Set(), levels: new Set(), sourceScores: {} };
    entry.score += (1 / (RRF_K + rank + 1)) * scopeLevelWeight(level);
    entry.sources.add(source);
    entry.levels.add(level);
    if (source === 'semantic') entry.sourceScores.semantic = score;
    if (source === 'keyword') entry.sourceScores.keyword = score;
    if (source === 'graph') entry.sourceScores.graph = score;
    if (source === 'entity') entry.sourceScores.entity = score;
    rrf.set(id, entry);
  };

  // One hybrid search (semantic + BM25 + graph traversal). Its scope
  // filter is the visibility cone; each hit is weighted by the
  // fact's own scope level, not by the search scope.
  const hybridOpts: HybridSearchOptions = {
    topK: topK * 3,
    scope,
    ...(opts.embedder ? { embedder: opts.embedder } : {}),
    ...(opts.skipSemantic === true ? { skipSemantic: true } : {}),
    ...(opts.onlyValidNow !== undefined ? { onlyValidNow: opts.onlyValidNow } : {}),
    ...(opts.backfillEmbeddings === true ? { backfillEmbeddings: true } : {}),
  };
  const result = await hybridSearch(store, trimmed, hybridOpts);
  for (const source of result.sourcesUsed) sourcesUsed.add(source);
  for (const note of result.notes) {
    if (!notes.includes(note)) notes.push(note);
  }
  result.hits.forEach((hit, rank) => {
    if (!visible(hit.fact)) return;
    for (const source of hit.sources) {
      addRank(hit.fact.id, rank, source, hit.sourceScores[source] ?? 0, scopeLevel(hit.fact.scope));
    }
  });

  // Entity search source: facts attached to entities named in the query.
  const matchedEntities = searchEntitiesByName(store, trimmed, 5);
  if (matchedEntities.length > 0) {
    const entityRanked: Array<{ fact: GraphFact; score: number }> = [];
    const seen = new Set<string>();
    for (const { entity, score } of matchedEntities) {
      // Entity facts are collected across ALL scopes, then gated by
      // the same visibility rule — a fact about "Ha Noi" stored at
      // app level must still be found when the query names Ha Noi
      // from a run scope, but another user's facts never leak in.
      for (const fact of store.neighbours(entity.id, { includeOtherScopes: true }, 50)) {
        if (fact.status !== 'active') continue;
        if (!visible(fact)) continue;
        if (seen.has(fact.id)) continue;
        seen.add(fact.id);
        entityRanked.push({ fact, score });
      }
    }
    entityRanked.sort((a, b) => b.score - a.score);
    entityRanked.slice(0, topK * 3).forEach(({ fact, score }, rank) => {
      sourcesUsed.add('entity');
      addRank(fact.id, rank, 'entity', score, scopeLevel(fact.scope));
    });
  }

  const hits: FusedHit[] = [...rrf.entries()]
    .map(([id, entry]) => {
      const fact = store.getFact(id);
      if (!fact) return null;
      const subjectName = store.getEntity(fact.subjectId)?.name ?? 'user';
      const objectName = fact.objectId ? store.getEntity(fact.objectId)?.name : undefined;
      return {
        fact,
        subjectName,
        ...(objectName ? { objectName } : {}),
        score: entry.score,
        sources: [...entry.sources] as FusedSource[],
        scopeLevels: [...entry.levels] as ScopeLevel[],
        factScopeLevel: scopeLevel(fact.scope),
        sourceScores: entry.sourceScores,
      } satisfies FusedHit;
    })
    .filter((h): h is FusedHit => h !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return { query: trimmed, hits, scopesSearched, sourcesUsed: [...sourcesUsed], notes };
}
