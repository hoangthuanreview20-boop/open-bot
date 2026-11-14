/**
 * Auto-link engine cho evolving notes (v1.01, Đội T5).
 *
 * Ý tưởng học từ A-MEM / Zettelkasten: note mới không đứng một mình —
 * nó được gắn vào mạng note hiện có bằng similarity, và mạng được
 * "evolve" khi có note mới. Engine này chỉ GỢI Ý và (tuỳ cấu hình) tự
 * gắn link yếu; link quan trọng vẫn do user/agent quyết định.
 *
 * Điểm similarity = TF-IDF cosine + Jaccard tag/token (xem similarity.ts).
 * Ngưỡng mặc định:
 *  - >= autoThreshold (0.45): tự gắn link `auto` loại `related`.
 *  - >= suggestThreshold (0.35): chỉ gợi ý, không tự gắn.
 *  - < 0.35: không nhắc tới.
 *
 * Link `supports`/`contradicts` KHÔNG tự gắn — máy không đủ tin để
 * khẳng định quan hệ ngữ nghĩa sâu; chỉ `related` / `part-of` (khi
 * title của note này chứa trong title note kia) được tự gắn.
 */

import type { EvolvingNote, NoteLinkKind } from './types';
import { noteSearchText } from './types';
import type { EvolvingNoteStore } from './store';
import { compareNotes, computeIdf, extractKeywords, tokenCounts } from './similarity';
import type { NoteSimilarity } from './similarity';

/** Một gợi ý link cho một note. */
export interface LinkSuggestion {
  /** Note đích được gợi ý. */
  targetId: string;
  targetTitle: string;
  kind: NoteLinkKind;
  /** Điểm similarity 0..1. */
  score: number;
  /** true = vượt ngưỡng tự gắn, engine sẽ gắn nếu `applySuggestions`. */
  auto: boolean;
  /** Lý do gợi ý (token hiếm chung / tag chung) — để UI giải thích. */
  reason: string;
  similarity: NoteSimilarity;
}

/** Cấu hình auto-link. */
export interface AutoLinkOptions {
  /** Ngưỡng tự gắn link (mặc định 0.55). */
  autoThreshold?: number;
  /** Ngưỡng gợi ý (mặc định 0.35). */
  suggestThreshold?: number;
  /** Số gợi ý tối đa cho một note (mặc định 5). */
  maxSuggestions?: number;
  /** Số link auto tối đa gắn cho một note mới (mặc định 3). */
  maxAutoLinks?: number;
  /** Scope để quét note cũ (mặc định: cùng scope với note mới). */
  scope?: { userId?: string; botId?: string };
}

/** Ngưỡng mặc định — ghi rõ để benchmark/UI tham chiếu cùng một số. */
export const DEFAULT_AUTO_LINK_THRESHOLD = 0.45;
export const DEFAULT_SUGGEST_LINK_THRESHOLD = 0.35;

export class AutoLinkEngine {
  constructor(private readonly store: EvolvingNoteStore) {}

  /**
   * Gợi ý link cho một note (mới hoặc cũ) với mọi note active khác
   * cùng scope. Không tự sửa store — chỉ trả gợi ý.
   */
  suggestLinksFor(note: EvolvingNote, opts: AutoLinkOptions = {}): LinkSuggestion[] {
    const autoThreshold = opts.autoThreshold ?? DEFAULT_AUTO_LINK_THRESHOLD;
    const suggestThreshold = opts.suggestThreshold ?? DEFAULT_SUGGEST_LINK_THRESHOLD;
    const maxSuggestions = opts.maxSuggestions ?? 5;
    const scope = opts.scope ?? { userId: note.scope.userId, botId: note.scope.botId };
    const candidates = this.store
      .listNotes({ scope, status: 'active', limit: 10000 })
      .filter((n) => n.id !== note.id);
    if (candidates.length === 0) return [];

    const allDocs = [note, ...candidates].map((n) => tokenCounts(noteSearchText(n)));
    const idf = computeIdf(allDocs);
    const existingTargets = new Set(note.links.map((l) => l.targetId));
    const suggestions: LinkSuggestion[] = [];

    for (const candidate of candidates) {
      if (existingTargets.has(candidate.id)) continue;
      const similarity = compareNotes(note, candidate, idf);
      if (similarity.score < suggestThreshold) continue;
      const kind = this.inferLinkKind(note, candidate, similarity);
      const auto = similarity.score >= autoThreshold && (kind === 'related' || kind === 'part-of');
      const reason = this.explainReason(note, candidate, similarity, idf);
      suggestions.push({
        targetId: candidate.id,
        targetTitle: candidate.title,
        kind,
        score: similarity.score,
        auto,
        reason,
        similarity,
      });
    }
    suggestions.sort((a, b) => b.score - a.score);
    return suggestions.slice(0, maxSuggestions);
  }

  /**
   * Gợi ý + áp dụng: gắn link auto vượt ngưỡng vào note, trả về danh
   * sách đã gắn + danh sách chỉ gợi ý. Ghi chú lý do vào link.
   */
  applyAutoLinks(noteId: string, opts: AutoLinkOptions = {}): { applied: LinkSuggestion[]; suggested: LinkSuggestion[] } {
    const note = this.store.getNote(noteId);
    if (!note) throw new Error(`Không tìm thấy note: ${noteId}.`);
    const suggestions = this.suggestLinksFor(note, opts);
    const maxAutoLinks = opts.maxAutoLinks ?? 3;
    const applied: LinkSuggestion[] = [];
    const suggested: LinkSuggestion[] = [];
    for (const suggestion of suggestions) {
      if (suggestion.auto && applied.length < maxAutoLinks) {
        this.store.addLink(noteId, suggestion.targetId, suggestion.kind, {
          weight: suggestion.score,
          auto: true,
          note: suggestion.reason,
        });
        applied.push(suggestion);
      } else {
        suggested.push(suggestion);
      }
    }
    return { applied, suggested };
  }

  /**
   * Quét toàn bộ kho: với mỗi note active chưa có link, gợi ý link.
   * Dùng cho "evolve" định kỳ (sleep agent / nút "Gợi ý link" trong UI).
   * Trả map noteId → gợi ý (chỉ note nào có gợi ý).
   */
  suggestLinksForAll(opts: AutoLinkOptions & { scope?: { userId?: string; botId?: string } } = {}): Map<string, LinkSuggestion[]> {
    const notes = this.store.listNotes({ scope: opts.scope, status: 'active', limit: 10000 });
    const out = new Map<string, LinkSuggestion[]>();
    for (const note of notes) {
      const suggestions = this.suggestLinksFor(note, opts);
      if (suggestions.length > 0) out.set(note.id, suggestions);
    }
    return out;
  }

  /** Keyword nổi bật của một note trong corpus hiện tại (để UI hiển thị). */
  keywordsFor(noteId: string, topN = 8): Array<{ token: string; score: number }> {
    const note = this.store.getNote(noteId);
    if (!note) return [];
    const notes = this.store.listNotes({ status: 'active', limit: 10000 });
    const idf = computeIdf(notes.map((n) => tokenCounts(noteSearchText(n))));
    return extractKeywords(note, idf, topN);
  }

  // ------------------------------------------------------------- nội bộ

  /** Suy ra loại link từ quan hệ tiêu đề/nội dung (chỉ related/part-of tự động). */
  private inferLinkKind(
    note: EvolvingNote,
    candidate: EvolvingNote,
    similarity: NoteSimilarity,
  ): NoteLinkKind {
    const titleA = note.title.toLowerCase();
    const titleB = candidate.title.toLowerCase();
    // Tiêu đề này là một phần của tiêu đề kia → part-of (vd "Phở bò" trong "Quán phở bò ngon ở Hà Nội").
    if (titleA.length >= 4 && titleB.includes(titleA)) return 'part-of';
    if (titleB.length >= 4 && titleA.includes(titleB)) return 'part-of';
    // Tag chung mạnh + token hiếm chung → related (mặc định).
    void similarity;
    return 'related';
  }

  /** Giải thích gợi ý bằng ngôn ngữ người đọc được. */
  private explainReason(
    note: EvolvingNote,
    candidate: EvolvingNote,
    similarity: NoteSimilarity,
    idf: Map<string, number>,
  ): string {
    const parts: string[] = [];
    const sharedTags = note.tags.filter((t) => candidate.tags.includes(t));
    if (sharedTags.length > 0) parts.push(`tag chung: ${sharedTags.join(', ')}`);
    if (similarity.sharedRareTokens.length > 0) {
      parts.push(`từ khoá chung: ${similarity.sharedRareTokens.slice(0, 4).join(', ')}`);
    }
    if (parts.length === 0) {
      const keywords = extractKeywords(candidate, idf, 3).map((k) => k.token);
      if (keywords.length > 0) parts.push(`chủ đề gần: ${keywords.join(', ')}`);
    }
    parts.push(`độ tương đồng ${similarity.score.toFixed(2)}`);
    return parts.join('; ');
  }
}
