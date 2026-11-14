/**
 * Hybrid recall cho verbatim memory (v1.01, Đội T4).
 *
 * Ba tín hiệu, theo thứ tự:
 *  1. Lọc metadata trước (wing/room/tags/botId/userId…) — thu hẹp tập
 *     ứng viên, giống vai trò của phân cấp wing/room trong ý tưởng
 *     "cung điện".
 *  2. BM25 trên text nguyên văn (tái dùng `Bm25` của memory graph —
 *     đã chuẩn hoá bỏ dấu tiếng Việt) → điểm từ khoá.
 *  3. Cosine similarity giữa query embedding và record embedding
 *     (Ollama local) khi cả hai đều có → điểm ngữ nghĩa.
 *
 * Fusion: khi có điểm ngữ nghĩa, `score = w_sem * cosine_norm +
 * (1 - w_sem) * bm25_norm` (mặc định w_sem = 0.6); không có vector
 * thì BM25 thuần và `usedFallback = true` + lý do rõ ràng (cùng quy
 * ước với `LongTermMemory.recallSemantic`). Thêm boost recency nhẹ:
 * record trong 7 ngày gần nhất được cộng tối đa +0.05, giảm dần theo
 * tuổi — memory mới vẫn hơi "nổi" hơn memory cũ khi điểm ngang nhau.
 *
 * Engine là hàm thuần trên mảng record: backend chỉ cần `list()` ra
 * ứng viên, engine chấm điểm trong bộ nhớ. Store local vài chục nghìn
 * record vẫn chạy tốt; nếu sau này backend vector (Chroma/Qdrant)
 * làm recall ở phía server thì engine này vẫn dùng cho fallback.
 */
import { Bm25 } from '../graph/bm25';
import { cosineSimilarity, normalizeVector } from '../embeddings';
import type {
  VerbatimEmbedder,
  VerbatimRecallHit,
  VerbatimRecallOptions,
  VerbatimRecallResult,
  VerbatimRecord,
} from './types';

/** Ngưỡng cosine mặc định (khớp `DEFAULT_SEMANTIC_MIN_SIMILARITY` của longterm). */
export const VERBATIM_DEFAULT_MIN_SIMILARITY = 0.3;
/** Trọng số ngữ nghĩa mặc định trong fusion. */
export const VERBATIM_DEFAULT_SEMANTIC_WEIGHT = 0.6;
/** Boost recency tối đa (cộng vào score cuối, 0..1). */
export const VERBATIM_RECENCY_BOOST_MAX = 0.05;
/** Số ngày mà boost recency giảm về 0. */
export const VERBATIM_RECENCY_WINDOW_DAYS = 7;

/** Chuẩn hoá một mảng điểm về 0..1 theo min-max (mảng rỗng → []). */
export function normalizeScores(scores: number[]): number[] {
  if (scores.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const s of scores) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  if (max === min) return scores.map(() => 1);
  return scores.map((s) => (s - min) / (max - min));
}

/** Boost recency: 1.0 khi vừa tạo, 0.0 khi cũ hơn cửa sổ. */
export function recencyBoost(createdAt: string, nowMs = Date.now()): number {
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(createdMs)) return 0;
  const ageMs = nowMs - createdMs;
  if (ageMs <= 0) return VERBATIM_RECENCY_BOOST_MAX;
  const windowMs = VERBATIM_RECENCY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  if (ageMs >= windowMs) return 0;
  return VERBATIM_RECENCY_BOOST_MAX * (1 - ageMs / windowMs);
}

/**
 * Chấm điểm hybrid cho một tập record ứng viên (đã lọc metadata).
 * Hàm thuần — không chạm disk, không gọi mạng; embedder chỉ dùng để
 * embed query (một lần), vector record lấy từ record đã có.
 */
export async function hybridRecall(
  query: string,
  candidates: VerbatimRecord[],
  opts: VerbatimRecallOptions = {},
): Promise<VerbatimRecallResult> {
  const trimmedQuery = (query ?? '').trim();
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  if (trimmedQuery === '' || candidates.length === 0) {
    return { hits: [], usedFallback: true, fallbackReason: 'no-match-above-threshold', candidates: candidates.length };
  }

  // 1. BM25 trên text nguyên văn.
  const bm25 = new Bm25(candidates.map((r) => ({ id: r.id, text: r.text })));
  const bm25Scores = bm25.search(trimmedQuery, candidates.length);
  const bm25ById = new Map<string, number>();
  for (const s of bm25Scores) bm25ById.set(s.id, s.score);

  // 2. Embedding query (nếu có embedder) — lỗi thì fallback, không throw.
  let queryVector: number[] | undefined;
  let embedFailed = false;
  const embedder: VerbatimEmbedder | undefined = opts.embedder;
  if (embedder !== undefined) {
    try {
      const available = embedder.isAvailable === undefined ? true : await embedder.isAvailable();
      if (available) {
        queryVector = normalizeVector(await embedder.embed(trimmedQuery));
      } else {
        embedFailed = true;
      }
    } catch {
      embedFailed = true;
    }
  }

  // 3. Cosine cho record nào có vector (đúng model + đúng dims).
  const minSimilarity = opts.minSimilarity ?? VERBATIM_DEFAULT_MIN_SIMILARITY;
  const semanticById = new Map<string, number>();
  let vectorsPresent = 0;
  if (queryVector !== undefined) {
    for (const record of candidates) {
      if (record.embedding === undefined || record.embedding.length === 0) continue;
      if (record.embedding.length !== queryVector.length) continue;
      vectorsPresent += 1;
      const sim = cosineSimilarity(queryVector, record.embedding);
      if (sim >= minSimilarity) semanticById.set(record.id, sim);
    }
  }

  // 4. Fusion.
  const bm25Norm = normalizeScores(candidates.map((r) => bm25ById.get(r.id) ?? 0));
  const semanticWeight = opts.semanticWeight ?? VERBATIM_DEFAULT_SEMANTIC_WEIGHT;
  const useRecency = opts.recencyBoost ?? true;
  const nowMs = Date.now();
  const hits: VerbatimRecallHit[] = [];
  const hasSemantic = semanticById.size > 0;

  candidates.forEach((record, index) => {
    const keywordScore = bm25ById.get(record.id) ?? 0;
    const semanticScore = semanticById.get(record.id);
    // Record không khớp từ khoá nào VÀ không có điểm ngữ nghĩa → loại.
    if (keywordScore <= 0 && semanticScore === undefined) return;
    let score: number;
    if (semanticScore !== undefined) {
      const semanticNorm = (semanticScore + 1) / 2; // cosine -1..1 → 0..1
      score = semanticWeight * semanticNorm + (1 - semanticWeight) * (bm25Norm[index] ?? 0);
    } else {
      score = bm25Norm[index] ?? 0;
    }
    if (useRecency) score += recencyBoost(record.createdAt, nowMs);
    hits.push({ record, score, keywordScore, semanticScore });
  });

  hits.sort((a, b) => b.score - a.score || (a.record.createdAt < b.record.createdAt ? 1 : -1));
  const top = hits.slice(0, limit);

  // 5. Kết luận fallback: chỉ coi là "ngữ nghĩa" khi ít nhất một hit
  //    có điểm ngữ nghĩa; còn lại là BM25 thuần.
  const usedSemantic = top.some((h) => h.semanticScore !== undefined);
  let fallbackReason: VerbatimRecallResult['fallbackReason'];
  if (!usedSemantic) {
    if (embedder === undefined) fallbackReason = 'no-embedder';
    else if (embedFailed) fallbackReason = 'embed-failed';
    else if (vectorsPresent === 0) fallbackReason = 'no-vectors';
    else fallbackReason = 'no-match-above-threshold';
  }
  return {
    hits: top,
    usedFallback: !usedSemantic,
    fallbackReason,
    candidates: candidates.length,
  };
}

/**
 * Recall chỉ từ khoá (không cần embedder) — dùng cho UI search nhanh
 * và cho test. Trả hit xếp theo BM25 (+ recency nhẹ).
 */
export function keywordRecall(
  query: string,
  candidates: VerbatimRecord[],
  limit = 10,
): VerbatimRecallHit[] {
  const trimmedQuery = (query ?? '').trim();
  if (trimmedQuery === '' || candidates.length === 0) return [];
  const bm25 = new Bm25(candidates.map((r) => ({ id: r.id, text: r.text })));
  const scores = bm25.search(trimmedQuery, candidates.length);
  const byId = new Map(candidates.map((r) => [r.id, r]));
  const norm = normalizeScores(scores.map((s) => s.score));
  const nowMs = Date.now();
  const hits: VerbatimRecallHit[] = [];
  scores.forEach((s, i) => {
    const record = byId.get(s.id);
    if (record === undefined) return;
    hits.push({
      record,
      score: (norm[i] ?? 0) + recencyBoost(record.createdAt, nowMs),
      keywordScore: s.score,
      semanticScore: undefined,
    });
  });
  return hits.sort((a, b) => b.score - a.score).slice(0, Math.min(Math.max(limit, 1), 50));
}
