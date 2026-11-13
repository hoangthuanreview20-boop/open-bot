/**
 * Hybrid search — semantic + BM25 + graph traversal, gộp hạng bằng
 * Reciprocal Rank Fusion (v0.98, Đội T1).
 *
 * Ba nguồn xếp hạng độc lập:
 *  1. Semantic: cosine similarity giữa embedding của query và vector
 *     fact đã lưu (Ollama `nomic-embed-text`, qua `OllamaEmbeddings`
 *     của embeddings.ts). Ollama chết → nguồn này vắng, search vẫn
 *     chạy bằng 2 nguồn còn lại (fail-open, ghi rõ trong kết quả).
 *  2. BM25 keyword: khớp từ khoá sau khi bỏ dấu tiếng Việt — bắt
 *     được tên riêng / từ hiếm mà embedding hay bỏ qua.
 *  3. Graph traversal: entity khớp tên với query (vd query nhắc "Hà
 *     Nội") → lấy fact 1–2 hop quanh entity đó, điểm giảm dần theo
 *     hop (1.0 → 0.5). Bắt được fact LIÊN QUAN nhưng không chứa từ
 *     query (vd hỏi "thời tiết quê tôi" → fact `lives_in Hà Nội`).
 *
 * Gộp hạng: Reciprocal Rank Fusion, k = 60 (chuẩn RRF): mỗi fact
 * được cộng 1/(k + rank) từ mỗi nguồn nó xuất hiện. Fact xuất hiện ở
 * nhiều nguồn được đẩy lên — đúng ý đồ "hybrid".
 *
 * Kết quả trả kèm `sources` để UI giải thích được vì sao fact này
 * được chọn (semantic / keyword / graph) và điểm từng nguồn.
 */

import type { Embedder } from '../embeddings';
import { OllamaEmbeddings, cosineSimilarity } from '../embeddings';
import type { GraphFact, MemoryScope } from './types';
import { factSearchText, isFactValidAt, normalizeGraphText } from './types';
import type { TemporalGraphStore } from './store';
import { Bm25 } from './bm25';

/** Hằng số RRF (chuẩn trong các hệ hybrid search). */
export const RRF_K = 60;
/** Số hop tối đa khi traversal quanh entity khớp query. */
export const MAX_GRAPH_HOPS = 2;

export interface HybridSearchHit {
  fact: GraphFact;
  /** Tên entity chủ ngữ (để UI hiển thị). */
  subjectName: string;
  /** Tên entity tân ngữ (nếu có). */
  objectName?: string;
  /** Điểm RRF gộp. */
  score: number;
  /** Nguồn nào đã đưa fact này vào kết quả. */
  sources: Array<'semantic' | 'keyword' | 'graph'>;
  /** Điểm từng nguồn (để UI/debug giải thích). */
  sourceScores: { semantic?: number; keyword?: number; graph?: number };
}

export interface HybridSearchOptions {
  /** Scope lọc (user/bot/run). */
  scope?: MemoryScope;
  /** Số kết quả tối đa (mặc định 10, tối đa 50). */
  topK?: number;
  /** Embedder semantic (mặc định Ollama local; test inject mock). */
  embedder?: Embedder;
  /** Bỏ qua nguồn semantic (vd khi Ollama chết mà caller biết trước). */
  skipSemantic?: boolean;
  /** Chỉ lấy fact còn hiệu lực tại thời điểm này (mặc định true). */
  onlyValidNow?: boolean;
  /** Số hop traversal (mặc định 2, tối đa 2). */
  hops?: number;
  /** Embed fact chưa có vector rồi lưu lại (mặc định false — search thuần đọc). */
  backfillEmbeddings?: boolean;
}

export interface HybridSearchResult {
  query: string;
  hits: HybridSearchHit[];
  /** Nguồn nào đã chạy thật (semantic vắng khi Ollama chết). */
  sourcesUsed: Array<'semantic' | 'keyword' | 'graph'>;
  /** Ghi chú khi một nguồn bị bỏ qua (vd Ollama chết). */
  notes: string[];
}

/**
 * Search hybrid trên đồ thị. Không bao giờ throw vì Ollama chết —
 * nguồn semantic vắng thì trả kết quả từ 2 nguồn còn lại + note.
 */
export async function hybridSearch(
  store: TemporalGraphStore,
  query: string,
  opts: HybridSearchOptions = {},
): Promise<HybridSearchResult> {
  const topK = Math.max(1, Math.min(50, opts.topK ?? 10));
  const onlyValidNow = opts.onlyValidNow !== false;
  const hops = Math.max(1, Math.min(MAX_GRAPH_HOPS, opts.hops ?? MAX_GRAPH_HOPS));
  const notes: string[] = [];
  const sourcesUsed: Array<'semantic' | 'keyword' | 'graph'> = [];
  const trimmed = (query ?? '').trim();
  if (trimmed === '') return { query: trimmed, hits: [], sourcesUsed, notes: ['Query rỗng.'] };

  const scope = opts.scope ?? { userId: '', botId: '', runId: '' };
  const facts = store
    .listFacts({ ...scope, status: 'active', limit: 5000 })
    .filter((f) => (onlyValidNow ? isFactValidAt(f) : true));
  if (facts.length === 0) return { query: trimmed, hits: [], sourcesUsed, notes: ['Đồ thị chưa có fact nào.'] };

  const subjectNameOf = (fact: GraphFact): string => store.getEntity(fact.subjectId)?.name ?? 'user';
  const objectNameOf = (fact: GraphFact): string | undefined =>
    fact.objectId ? store.getEntity(fact.objectId)?.name : undefined;

  // --- Nguồn 1: BM25 keyword -------------------------------------------
  const bm25 = new Bm25(
    facts.map((f) => ({ id: f.id, text: factSearchText(f, subjectNameOf(f), objectNameOf(f)) })),
  );
  const keywordRanked = bm25.search(trimmed, topK * 3);
  const keywordScores = new Map(keywordRanked.map((r, i) => [r.id, { rank: i, score: r.score }]));
  if (keywordRanked.length > 0) sourcesUsed.push('keyword');

  // --- Nguồn 2: graph traversal ----------------------------------------
  const graphScores = new Map<string, { rank: number; score: number }>();
  const queryNorm = normalizeGraphText(trimmed);
  const matchedEntities = store
    .listEntities()
    .filter((e) => {
      const nameNorm = normalizeGraphText(e.name);
      return (
        nameNorm !== '' &&
        (queryNorm.includes(nameNorm) ||
          nameNorm.includes(queryNorm) ||
          e.aliases.some((a) => queryNorm.includes(normalizeGraphText(a))))
      );
    })
    .slice(0, 5);
  if (matchedEntities.length > 0) {
    const scored = new Map<string, number>();
    const seen = new Set<string>();
    let frontier = matchedEntities.map((e) => e.id);
    for (let hop = 1; hop <= hops; hop += 1) {
      const hopScore = hop === 1 ? 1.0 : 0.5;
      const nextFrontier: string[] = [];
      for (const entityId of frontier) {
        for (const fact of store.neighbours(entityId, scope, 50)) {
          if (fact.status !== 'active') continue;
          if (onlyValidNow && !isFactValidAt(fact)) continue;
          if (!seen.has(fact.id)) {
            seen.add(fact.id);
            scored.set(fact.id, hopScore);
          }
          const otherId = fact.subjectId === entityId ? fact.objectId : fact.subjectId;
          if (otherId && hop < hops) nextFrontier.push(otherId);
        }
      }
      frontier = [...new Set(nextFrontier)];
    }
    const ranked = [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK * 3);
    ranked.forEach(([id, score], i) => graphScores.set(id, { rank: i, score }));
    if (ranked.length > 0) sourcesUsed.push('graph');
  }

  // --- Nguồn 3: semantic (Ollama, fail-open) ---------------------------
  const semanticScores = new Map<string, { rank: number; score: number }>();
  if (opts.skipSemantic !== true) {
    try {
      const embedder: Embedder = opts.embedder ?? new OllamaEmbeddings();
      const available = embedder.isAvailable ? await embedder.isAvailable() : true;
      if (!available) {
        notes.push('Ollama chưa chạy — bỏ qua tìm kiếm ngữ nghĩa, chỉ dùng từ khoá + đồ thị.');
      } else {
        const queryVector = await embedder.embed(trimmed);
        const scored: Array<{ id: string; score: number }> = [];
        for (const fact of facts) {
          let vector = fact.embedding;
          if (!vector) {
            if (opts.backfillEmbeddings === true) {
              try {
                vector = await embedder.embed(factSearchText(fact, subjectNameOf(fact), objectNameOf(fact)));
                store.setFactEmbedding(fact.id, vector);
              } catch {
                continue;
              }
            } else {
              continue;
            }
          }
          const sim = cosineSimilarity(queryVector, vector);
          if (sim > 0) scored.push({ id: fact.id, score: sim });
        }
        scored.sort((a, b) => b.score - a.score);
        scored.slice(0, topK * 3).forEach((s, i) => semanticScores.set(s.id, { rank: i, score: s.score }));
        if (scored.length > 0) sourcesUsed.push('semantic');
      }
    } catch (err) {
      notes.push(`Tìm kiếm ngữ nghĩa lỗi (${(err as Error).message}) — chỉ dùng từ khoá + đồ thị.`);
    }
  }

  // --- Gộp hạng: Reciprocal Rank Fusion ---------------------------------
  const rrf = new Map<string, { score: number; sources: Set<'semantic' | 'keyword' | 'graph'>; sourceScores: HybridSearchHit['sourceScores'] }>();
  const addRank = (
    id: string,
    rank: number,
    source: 'semantic' | 'keyword' | 'graph',
    score: number,
  ): void => {
    const entry = rrf.get(id) ?? { score: 0, sources: new Set(), sourceScores: {} };
    entry.score += 1 / (RRF_K + rank + 1);
    entry.sources.add(source);
    if (source === 'semantic') entry.sourceScores.semantic = score;
    if (source === 'keyword') entry.sourceScores.keyword = score;
    if (source === 'graph') entry.sourceScores.graph = score;
    rrf.set(id, entry);
  };
  for (const [id, v] of semanticScores) addRank(id, v.rank, 'semantic', v.score);
  for (const [id, v] of keywordScores) addRank(id, v.rank, 'keyword', v.score);
  for (const [id, v] of graphScores) addRank(id, v.rank, 'graph', v.score);

  const factById = new Map(facts.map((f) => [f.id, f]));
  const hits: HybridSearchHit[] = [...rrf.entries()]
    .map(([id, entry]) => {
      const fact = factById.get(id);
      if (!fact) return null;
      return {
        fact,
        subjectName: subjectNameOf(fact),
        ...(objectNameOf(fact) ? { objectName: objectNameOf(fact) } : {}),
        score: entry.score,
        sources: [...entry.sources] as Array<'semantic' | 'keyword' | 'graph'>,
        sourceScores: entry.sourceScores,
      } satisfies HybridSearchHit;
    })
    .filter((h): h is HybridSearchHit => h !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return { query: trimmed, hits, sourcesUsed, notes };
}

/**
 * Backfill embedding cho fact chưa có vector (chạy nền, giới hạn số
 * fact mỗi lần để không chặn UI). Trả số fact đã embed được.
 */
export async function backfillFactEmbeddings(
  store: TemporalGraphStore,
  embedder: Embedder,
  limit = 50,
): Promise<{ embedded: number; failed: number }> {
  const facts = store.listFacts({ status: 'active', limit: 5000 }).filter((f) => !f.embedding);
  let embedded = 0;
  let failed = 0;
  for (const fact of facts.slice(0, Math.max(1, limit))) {
    try {
      const subject = store.getEntity(fact.subjectId)?.name ?? 'user';
      const object = fact.objectId ? store.getEntity(fact.objectId)?.name : undefined;
      const vector = await embedder.embed(factSearchText(fact, subject, object));
      store.setFactEmbedding(fact.id, vector);
      embedded += 1;
    } catch {
      failed += 1;
    }
  }
  return { embedded, failed };
}
