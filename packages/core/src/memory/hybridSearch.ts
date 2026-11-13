/**
 * Hybrid search for Memory v2 (v0.97, Team T4).
 *
 * Combines three signals into one ranked list, each result carrying an
 * explanation of WHERE it came from so the agent (and the user) can
 * judge it instead of trusting a black-box score:
 *  1. Semantic — cosine similarity over Ollama embeddings when an
 *     embedder is configured and available; skipped (not faked) when
 *     Ollama is down, with a short timeout so a search never hangs.
 *  2. BM25 — classic keyword ranking over the same corpus (always
 *     available, local, deterministic). Implemented from scratch here
 *     (no dependency) so the module works with no model at all.
 *  3. Graph traversal — starting from the entities named in the query,
 *     walk 1–2 hops in the temporal knowledge graph and surface
 *     neighbouring facts the keyword/semantic pass may have missed.
 *
 * The corpus is deliberately generic: any item with `{ id, text }`
 * plus optional `{ embedding, trust, source, validFrom, validTo }`.
 * Callers build the corpus from long-term memories, memory blocks and
 * graph entities/relations; this module only ranks.
 *
 * Scoring: each signal is normalised to 0..1 per query, then combined
 * with fixed weights (semantic 0.45 / BM25 0.35 / graph 0.20 — graph
 * is a booster, not a replacement). Low-trust items are demoted
 * (score × trust) and quarantined items are excluded by the caller.
 * Results are stable: ties break by id so repeated queries rank the
 * same way.
 */

import { cosineSimilarity } from './embeddings';
import type { Embedder } from './embeddings';
import type { TemporalKnowledgeGraph } from './graph';
import { normalizeEntityName } from './graph';

/** One searchable item (memory, block, graph node/edge, ...). */
export interface HybridSearchItem {
  id: string;
  /** Text ranked on (key + value, block content, entity name + description, ...). */
  text: string;
  /** Kind label shown in the explanation, e.g. `memory`, `block`, `graph-entity`. */
  kind: string;
  /** Pre-computed L2-normalised embedding (optional; enables semantic signal). */
  embedding?: number[];
  /** Trust 0..1 from provenance (default 1 = fully trusted). */
  trust?: number;
  /** Validity window (graph items); items without one are always valid. */
  validFrom?: string | null;
  validTo?: string | null;
  /** Graph entity id this item refers to (enables graph expansion). */
  entityId?: string;
}

export interface HybridSearchHit {
  item: HybridSearchItem;
  /** Combined score 0..1 (higher = more relevant). */
  score: number;
  /** Per-signal scores, already normalised 0..1. */
  signals: { semantic: number; bm25: number; graph: number };
  /** Human-readable explanation, e.g. "semantic 0.82 · keyword 0.61 · graph 1 hop". */
  explanation: string;
  /** Where the hit came from, for the UI / audit trail. */
  sources: string[];
}

export interface HybridSearchOptions {
  /** Embedder for the semantic signal (Ollama). Absent = keyword + graph only. */
  embedder?: Embedder;
  /** Max results (default 10, cap 50). */
  topK?: number;
  /** Weights for the three signals (must sum to ~1; default 0.45/0.35/0.20). */
  weights?: { semantic: number; bm25: number; graph: number };
  /** Only items valid at this instant (default: now). */
  at?: string;
  /** Minimum trust to include (default 0 — caller may pre-filter). */
  minTrust?: number;
  /** Temporal graph for the traversal signal (optional). */
  graph?: TemporalKnowledgeGraph;
  /** Graph hops for expansion (1 or 2, default 1). */
  graphHops?: number;
  /** Timeout (ms) for the single embedding call (default 5000 — search must stay fast). */
  embedTimeoutMs?: number;
}

export const DEFAULT_HYBRID_WEIGHTS = { semantic: 0.45, bm25: 0.35, graph: 0.2 };
export const HYBRID_EMBED_TIMEOUT_MS = 5000;
/** BM25 parameters (standard defaults: k1=1.2, b=0.75). */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/** Tokenise for BM25: lowercase, strip diacritics, split on non-letters/digits. */
export function tokenize(text: string): string[] {
  return (text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export interface Bm25Result {
  id: string;
  score: number;
}

/**
 * BM25 ranking over a corpus of `{ id, text }`. Pure and deterministic.
 * Returns raw BM25 scores (not normalised); callers normalise against
 * the max score of the query. Empty query or empty corpus => [].
 */
export function bm25Search(
  query: string,
  docs: Array<{ id: string; text: string }>,
): Bm25Result[] {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0 || docs.length === 0) return [];
  const docTokens = docs.map((d) => tokenize(d.text));
  const docLengths = docTokens.map((t) => t.length);
  const avgLen = docLengths.reduce((a, b) => a + b, 0) / Math.max(1, docLengths.length);
  const docFreq = new Map<string, number>();
  for (const tokens of docTokens) {
    for (const term of new Set(tokens)) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
  }
  const results: Bm25Result[] = [];
  for (let i = 0; i < docs.length; i++) {
    const tokens = docTokens[i] as string[];
    const counts = new Map<string, number>();
    for (const term of tokens) counts.set(term, (counts.get(term) ?? 0) + 1);
    let score = 0;
    const len = docLengths[i] as number;
    for (const term of new Set(queryTerms)) {
      const tf = counts.get(term) ?? 0;
      if (tf === 0) continue;
      const df = docFreq.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (len / Math.max(1, avgLen)));
      score += idf * ((tf * (BM25_K1 + 1)) / denom);
    }
    if (score > 0) results.push({ id: (docs[i] as { id: string }).id, score });
  }
  return results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** Normalise a list of raw scores to 0..1 by dividing by the max (max => 1). */
export function normalizeScores(scores: Map<string, number>): Map<string, number> {
  let max = 0;
  for (const v of scores.values()) if (v > max) max = v;
  const out = new Map<string, number>();
  for (const [k, v] of scores) out.set(k, max > 0 ? v / max : 0);
  return out;
}

function isValidAtItem(item: HybridSearchItem, at: string): boolean {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return true;
  if (item.validFrom && Date.parse(item.validFrom) > t) return false;
  if (item.validTo && Date.parse(item.validTo) < t) return false;
  return true;
}

async function embedWithTimeout(
  embedder: Embedder,
  text: string,
  timeoutMs: number,
): Promise<number[] | null> {
  try {
    const result = await Promise.race([
      embedder.embed(text),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return result;
  } catch {
    return null;
  }
}

/**
 * Hybrid search over `items` for `query`.
 *  - Semantic signal only when an embedder is supplied AND the query
 *    embeds within the timeout AND at least one item has an embedding.
 *    Otherwise the semantic weight is redistributed to BM25 (the
 *    result notes `semanticAvailable: false` instead of pretending).
 *  - Graph signal: entities named in the query (by normalised name
 *    match) seed a 1–2 hop walk; reached items get a graph score that
 *    decays with distance (1 hop = 1.0, 2 hops = 0.5).
 *  - Every hit explains itself: per-signal scores + source labels.
 */
export async function hybridSearch(
  query: string,
  items: HybridSearchItem[],
  opts: HybridSearchOptions = {},
): Promise<{ hits: HybridSearchHit[]; semanticAvailable: boolean; query: string }> {
  const trimmed = (query ?? '').trim();
  const topK = Math.max(1, Math.min(50, opts.topK ?? 10));
  const at = opts.at ?? new Date().toISOString();
  const minTrust = opts.minTrust ?? 0;
  const weights = opts.weights ?? DEFAULT_HYBRID_WEIGHTS;
  const eligible = items.filter(
    (item) =>
      item.text.trim() !== '' &&
      (item.trust ?? 1) >= minTrust &&
      isValidAtItem(item, at),
  );
  if (trimmed === '' || eligible.length === 0) {
    return { hits: [], semanticAvailable: false, query: trimmed };
  }

  // --- BM25 signal (always available) ---
  const bm25Raw = new Map<string, number>(
    bm25Search(trimmed, eligible.map((i) => ({ id: i.id, text: i.text }))).map((r) => [r.id, r.score] as [string, number]),
  );

  // --- Semantic signal (best-effort, never blocks on a slow embedder) ---
  let semanticRaw = new Map<string, number>();
  let semanticAvailable = false;
  if (opts.embedder) {
    const queryVector = await embedWithTimeout(opts.embedder, trimmed, opts.embedTimeoutMs ?? HYBRID_EMBED_TIMEOUT_MS);
    if (queryVector) {
      for (const item of eligible) {
        if (!item.embedding || item.embedding.length === 0) continue;
        if (item.embedding.length !== queryVector.length) continue;
        const sim = cosineSimilarity(queryVector, item.embedding);
        if (sim > 0) semanticRaw.set(item.id, sim);
      }
      semanticAvailable = semanticRaw.size > 0;
    }
  }

  // --- Graph signal (seed = entities named in the query) ---
  const graphRaw = new Map<string, number>();
  if (opts.graph) {
    const hops = opts.graphHops === 2 ? 2 : 1;
    const queryNorm = normalizeEntityName(trimmed);
    const seeds = opts.graph
      .listEntities({ at, limit: 10000 })
      .filter((e) => queryNorm.includes(normalizeEntityName(e.name)) && normalizeEntityName(e.name) !== '');
    const byEntityId = new Map<string, HybridSearchItem>();
    for (const item of eligible) if (item.entityId) byEntityId.set(item.entityId, item);
    const visited = new Set<string>();
    let frontier = seeds.map((s) => s.id);
    for (let hop = 1; hop <= hops; hop++) {
      const next: string[] = [];
      for (const entityId of frontier) {
        if (visited.has(entityId)) continue;
        visited.add(entityId);
        const item = byEntityId.get(entityId);
        if (item) graphRaw.set(item.id, hop === 1 ? 1 : 0.5);
        for (const { other } of opts.graph.neighbours(entityId, { at })) {
          if (!visited.has(other.id)) next.push(other.id);
        }
      }
      frontier = next;
    }
  }

  // --- Combine ---
  const semanticNorm = normalizeScores(semanticRaw);
  const bm25Norm = normalizeScores(bm25Raw);
  const graphNorm = normalizeScores(graphRaw);
  const semanticWeight = semanticAvailable ? weights.semantic : 0;
  const bm25Weight = semanticAvailable ? weights.bm25 : weights.bm25 + weights.semantic;
  const graphWeight = weights.graph;
  const totalWeight = semanticWeight + bm25Weight + graphWeight;

  const hits: HybridSearchHit[] = [];
  for (const item of eligible) {
    const s = semanticNorm.get(item.id) ?? 0;
    const b = bm25Norm.get(item.id) ?? 0;
    const g = graphNorm.get(item.id) ?? 0;
    const combined =
      totalWeight > 0 ? (s * semanticWeight + b * bm25Weight + g * graphWeight) / totalWeight : 0;
    if (combined <= 0) continue;
    const trust = item.trust ?? 1;
    const score = Math.round(combined * trust * 1000) / 1000;
    const parts: string[] = [];
    if (semanticAvailable && s > 0) parts.push(`semantic ${s.toFixed(2)}`);
    if (b > 0) parts.push(`keyword ${b.toFixed(2)}`);
    if (g > 0) parts.push(`graph ${g > 0.9 ? '1 hop' : '2 hops'}`);
    if (trust < 1) parts.push(`trust ${trust.toFixed(2)}`);
    hits.push({
      item,
      score,
      signals: { semantic: s, bm25: b, graph: g },
      explanation: parts.length > 0 ? parts.join(' · ') : 'no signal',
      sources: [item.kind],
    });
  }
  hits.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
  return { hits: hits.slice(0, topK), semanticAvailable, query: trimmed };
}
