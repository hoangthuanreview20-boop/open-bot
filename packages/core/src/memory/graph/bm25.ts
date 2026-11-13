/**
 * BM25 — tìm kiếm từ khoá cho hybrid search (v0.98, Đội T1).
 *
 * BM25 chuẩn (k1 = 1.2, b = 0.75) trên token đã chuẩn hoá (chữ
 * thường, bỏ dấu tiếng Việt — để "pho bo" khớp "phở bò"). Tokenizer
 * tách theo ký tự không phải chữ/số (Unicode-aware) nên xử lý được
 * cả tiếng Việt lẫn tiếng Anh mà không cần từ điển.
 *
 * Index xây trong bộ nhớ cho mỗi lần search (đồ thị local nhỏ, vài
 * nghìn fact là cùng) — không lưu index xuống đĩa, tránh lệch dữ
 * liệu khi fact đổi.
 */

import { normalizeGraphText } from './types';

/** Tách text thành token đã chuẩn hoá (bỏ token rỗng / quá ngắn). */
export function tokenize(text: string): string[] {
  return normalizeGraphText(text)
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export interface Bm25Document {
  id: string;
  text: string;
}

export interface Bm25Result {
  id: string;
  score: number;
}

/**
 * BM25 scorer: khởi tạo một lần với toàn bộ document, rồi `score`
 * cho từng query. IDF dùng công thức chuẩn có cộng 1 để tránh âm
 * khi term xuất hiện ở hơn nửa số document.
 */
export class Bm25 {
  private readonly docs: Bm25Document[];
  private readonly docTokens: Map<string, Map<string, number>>;
  private readonly docLengths: Map<string, number>;
  private readonly docFreq: Map<string, number>;
  private readonly avgLength: number;
  private readonly k1: number;
  private readonly b: number;

  constructor(docs: Bm25Document[], opts: { k1?: number; b?: number } = {}) {
    this.k1 = opts.k1 ?? 1.2;
    this.b = opts.b ?? 0.75;
    this.docs = docs;
    this.docTokens = new Map();
    this.docLengths = new Map();
    this.docFreq = new Map();
    let totalLength = 0;
    for (const doc of docs) {
      const tokens = tokenize(doc.text);
      const counts = new Map<string, number>();
      for (const token of tokens) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
      this.docTokens.set(doc.id, counts);
      this.docLengths.set(doc.id, tokens.length);
      totalLength += tokens.length;
      for (const token of new Set(tokens)) {
        this.docFreq.set(token, (this.docFreq.get(token) ?? 0) + 1);
      }
    }
    this.avgLength = docs.length === 0 ? 1 : totalLength / docs.length;
  }

  /** Xếp hạng document cho một query — trả tối đa `topK`, score > 0. */
  search(query: string, topK = 10): Bm25Result[] {
    const queryTokens = [...new Set(tokenize(query))];
    if (queryTokens.length === 0 || this.docs.length === 0) return [];
    const n = this.docs.length;
    const results: Bm25Result[] = [];
    for (const doc of this.docs) {
      const counts = this.docTokens.get(doc.id);
      const docLen = this.docLengths.get(doc.id) ?? 0;
      if (!counts || docLen === 0) continue;
      let score = 0;
      for (const token of queryTokens) {
        const tf = counts.get(token) ?? 0;
        if (tf === 0) continue;
        const df = this.docFreq.get(token) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const norm = (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + (this.b * docLen) / this.avgLength));
        score += idf * norm;
      }
      if (score > 0) results.push({ id: doc.id, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, Math.max(1, topK));
  }
}
