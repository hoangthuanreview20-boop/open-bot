/**
 * Similarity cho evolving notes (v1.01, Đội T5).
 *
 * Local, không cần model: TF-IDF cosine trên token đã chuẩn hoá (bỏ dấu
 * tiếng Việt, dùng chung `normalizeGraphText`) + Jaccard trên tag + trùng
 * keyword hiếm (IDF cao). Đủ để auto-link note mới vào mạng note cũ và
 * để benchmark harness đo recall mà không cần Ollama.
 *
 * Có hook nhận vector embedding optional (nếu sau này muốn cộng thêm
 * điểm ngữ nghĩa) — nhưng mặc định similarity hoàn toàn là từ khoá,
 * và mọi ngưỡng đều được ghi rõ trong code.
 */

import { normalizeNoteText } from './types';

/** Stopword tiếng Việt + tiếng Anh (từ thường gặp, mang ít nghĩa phân biệt). */
export const NOTE_STOPWORDS: ReadonlySet<string> = new Set([
  // Tiếng Việt
  'la', 'cua', 'va', 'voi', 'cho', 'den', 'tu', 'tren', 'duoi', 'trong', 'ngoai',
  'mot', 'hai', 'ba', 'cac', 'nhung', 'nay', 'do', 'kia', 'day', 'ay', 'nang',
  'rat', 'rất'.normalize('NFD').replace(/[̀-ͯ]/g, ''),
  'cung', 'da', 'se', 'dang', 'bi', 'duoc', 'co', 'khong', 'toi', 'minh', 'ban',
  'anh', 'chi', 'em', 'no', 'ho', 'chung', 'ta', 'nguoi', 'cai', 'viec', 'khi',
  'neu', 'thi', 'ma', 'ma', 've', 'theo', 'sau', 'truoc', 'giua', 'hon', 'nhat',
  'ca', 'ca', 'het', 'con', 'lai', 'nua', 'chi', 'ma', 'nen', 'de', 'o', 'a',
  'oi', 'nha', 'nhe', 'nhe', 'di', 'nao', 'gi', 'sao', 'the', 'nao', 'dau',
  // Tiếng Anh
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for',
  'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'can', 'could',
  'should', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'this', 'that',
  'these', 'those', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'as',
  'not', 'no', 'yes', 'so', 'than', 'then', 'there', 'here', 'when', 'where',
  'which', 'who', 'whom', 'what', 'how', 'why', 'about', 'into', 'over',
  'under', 'between', 'through', 'after', 'before', 'very', 'just', 'also',
  'more', 'most', 'other', 'some', 'any', 'all', 'each', 'both', 'such',
]);

/** Tách text thành token đã chuẩn hoá, bỏ stopword + token 1 ký tự. */
export function tokenizeNoteText(text: string): string[] {
  return normalizeNoteText(text)
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !NOTE_STOPWORDS.has(t));
}

/** Đếm tần suất token trong một text. */
export function tokenCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokenizeNoteText(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/** IDF cho một corpus: log((N + 1) / (df + 1)) + 1. */
export function computeIdf(docTokenSets: Map<string, number>[]): Map<string, number> {
  const n = Math.max(1, docTokenSets.length);
  const df = new Map<string, number>();
  for (const counts of docTokenSets) {
    for (const token of counts.keys()) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [token, freq] of df) {
    idf.set(token, Math.log((n + 1) / (freq + 1)) + 1);
  }
  return idf;
}

/** Cosine TF-IDF giữa hai document (đã có IDF chung của corpus). */
export function tfidfCosine(
  a: Map<string, number>,
  b: Map<string, number>,
  idf: Map<string, number>,
): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [token, countA] of a) {
    const w = Math.log(1 + countA) * (idf.get(token) ?? 1);
    normA += w * w;
    const countB = b.get(token);
    if (countB !== undefined) {
      const wb = Math.log(1 + countB) * (idf.get(token) ?? 1);
      dot += w * wb;
    }
  }
  for (const [token, countB] of b) {
    const w = Math.log(1 + countB) * (idf.get(token) ?? 1);
    normB += w * w;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Jaccard giữa hai tập token. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Kết quả so sánh hai note. */
export interface NoteSimilarity {
  /** Điểm tổng hợp 0..1. */
  score: number;
  /** Cosine TF-IDF trên nội dung. */
  tfidf: number;
  /** Jaccard trên tag. */
  tagJaccard: number;
  /** Jaccard trên token nội dung. */
  tokenJaccard: number;
  /** Token hiếm chung (IDF cao) — lý do link thuyết phục nhất. */
  sharedRareTokens: string[];
}

/** Trọng số tổng hợp điểm similarity. */
export const SIMILARITY_WEIGHTS = {
  /** TF-IDF cosine nội dung. */
  tfidf: 0.6,
  /** Jaccard tag. */
  tag: 0.25,
  /** Jaccard token nội dung. */
  token: 0.15,
} as const;

/**
 * So sánh hai note. `idf` là IDF của toàn bộ corpus (tính từ mọi note
 * active); nếu không truyền, IDF mặc định = 1 cho mọi token (vẫn cho
 * cosine TF đơn thuần).
 */
export function compareNotes(
  a: { title: string; body: string; tags: string[] },
  b: { title: string; body: string; tags: string[] },
  idf?: Map<string, number>,
): NoteSimilarity {
  const textA = `${a.title} ${a.body}`;
  const textB = `${b.title} ${b.body}`;
  const countsA = tokenCounts(textA);
  const countsB = tokenCounts(textB);
  const tfidf = tfidfCosine(countsA, countsB, idf ?? new Map());
  const setA = new Set(countsA.keys());
  const setB = new Set(countsB.keys());
  const tokenJacc = jaccard(setA, setB);
  const tagA = new Set(a.tags.map((t) => normalizeNoteText(t)).filter(Boolean));
  const tagB = new Set(b.tags.map((t) => normalizeNoteText(t)).filter(Boolean));
  const tagJacc = tagA.size === 0 && tagB.size === 0 ? 0 : jaccard(tagA, tagB);
  const sharedRareTokens: string[] = [];
  for (const token of setA) {
    if (!setB.has(token)) continue;
    const w = idf?.get(token) ?? 1;
    if (w >= 2) sharedRareTokens.push(token);
  }
  sharedRareTokens.sort((x, y) => (idf?.get(y) ?? 1) - (idf?.get(x) ?? 1));
  const score =
    SIMILARITY_WEIGHTS.tfidf * tfidf +
    SIMILARITY_WEIGHTS.tag * tagJacc +
    SIMILARITY_WEIGHTS.token * tokenJacc;
  return {
    score: Math.min(1, Math.max(0, score)),
    tfidf,
    tagJaccard: tagJacc,
    tokenJaccard: tokenJacc,
    sharedRareTokens: sharedRareTokens.slice(0, 8),
  };
}

/** Một keyword của note: token + điểm TF-IDF trong corpus. */
export interface NoteKeyword {
  token: string;
  score: number;
}

/**
 * Trích top keyword của một note trong corpus (TF-IDF). Dùng để hiển
 * thị "note này nói về gì" và để auto-link giải thích lý do.
 */
export function extractKeywords(
  note: { title: string; body: string; tags: string[] },
  idf: Map<string, number>,
  topN = 8,
): NoteKeyword[] {
  const counts = tokenCounts(`${note.title} ${note.body}`);
  // Tiêu đề được nhân đôi trọng số: token trong tiêu đề quan trọng hơn.
  const titleTokens = new Set(tokenizeNoteText(note.title));
  const scored: NoteKeyword[] = [];
  for (const [token, count] of counts) {
    const boost = titleTokens.has(token) ? 2 : 1;
    scored.push({ token, score: Math.log(1 + count) * (idf.get(token) ?? 1) * boost });
  }
  // Tag luôn là keyword mạnh.
  for (const tag of note.tags) {
    const t = normalizeNoteText(tag);
    if (t && !scored.some((s) => s.token === t)) {
      scored.push({ token: t, score: (idf.get(t) ?? 1) * 2 });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}

/**
 * Điểm BM25 đơn giản của một query với một document (dùng cho search
 * trong store khi không có embedder). k1=1.2, b=0.75 như graph/bm25.
 */
export function bm25NoteScore(
  queryTokens: string[],
  docCounts: Map<string, number>,
  docLength: number,
  avgLength: number,
  idf: Map<string, number>,
  k1 = 1.2,
  b = 0.75,
): number {
  if (docLength === 0 || avgLength === 0) return 0;
  let score = 0;
  for (const token of new Set(queryTokens)) {
    const tf = docCounts.get(token) ?? 0;
    if (tf === 0) continue;
    const w = idf.get(token) ?? 1;
    score += w * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * docLength) / avgLength)));
  }
  return score;
}
