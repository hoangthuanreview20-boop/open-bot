/**
 * Revisit engine cho evolving notes (v1.01, Đội T5).
 *
 * Khi thông tin mới tới cho một chủ đề đã có note, engine phân loại:
 *
 *  - `append`      — thông tin mới, không trùng, không mâu thuẫn → ghi
 *                     thêm vào note (version mới).
 *  - `merge`       — trùng lặp cao với note cũ (similarity ≥ 0.8) → gộp
 *                     nội dung mới vào note cũ, giữ cả hai version.
 *  - `contradiction` — mâu thuẫn với note cũ → KHÔNG tự sửa. Tạo
 *                     `NoteConflict` vào hàng chờ user duyệt (giống
 *                     quarantine của graph). Note cũ giữ nguyên.
 *  - `supersede`   — thông tin mới thay thế hẳn (user xác nhận) → tạo
 *                     note mới, note cũ `superseded`.
 *
 * Phát hiện mâu thuẫn là HEURISTIC từ khoá (ghi rõ, không giả vờ là
 * NLI model):
 *  1. Mẫu phủ định VI+EN: "không còn", "không thích", "không ở",
 *     "no longer", "not anymore", "đã đổi", "chuyển sang", "thay vì"...
 *  2. Cặp antonym nhỏ: thích/ghét, ở/rời, làm/nghỉ, có/không có...
 *  3. Cùng chủ thể + vị ngữ nhưng tân ngữ khác (vd note cũ "sống ở Hà
 *     Nội", mới "sống ở Sài Gòn") — heuristic yếu nhất, confidence thấp.
 *
 * Vì heuristic có false positive/negative nên mọi contradiction đều
 * vào hàng chờ duyệt, không bao giờ tự áp dụng.
 */

import type { EvolvingNote, NoteConflictReason } from './types';
import { normalizeNoteText } from './types';
import type { EvolvingNoteStore } from './store';
import { compareNotes, computeIdf, tokenCounts, tokenizeNoteText } from './similarity';
import { noteSearchText } from './types';

/** Kết quả phân loại một thông tin mới so với note cũ. */
export type RevisitDecision = 'append' | 'merge' | 'contradiction' | 'no-op' | 'supersede';

/** Chi tiết phân loại. */
export interface RevisitAnalysis {
  decision: RevisitDecision;
  /** Điểm similarity note cũ — thông tin mới (0..1). */
  similarity: number;
  /** Mâu thuẫn phát hiện được (nếu có). */
  conflict?: {
    reason: NoteConflictReason;
    detail: string;
    confidence: number;
  };
  /** Giải thích ngắn cho user/UI. */
  explanation: string;
}

/** Kết quả áp dụng revisit. */
export interface RevisitResult {
  decision: RevisitDecision;
  /** Note sau khi áp dụng (append/merge/supersede) — vắng khi contradiction/no-op. */
  note?: EvolvingNote;
  /** Conflict đã tạo (khi contradiction). */
  conflictId?: string;
  explanation: string;
}

/** Ngưỡng merge: similarity ≥ 0.8 coi là trùng lặp, gộp thay vì append. */
export const REVISIT_MERGE_THRESHOLD = 0.8;
/** Ngưỡng no-op: similarity rất thấp + không mâu thuẫn → thông tin không liên quan. */
export const REVISIT_NOOP_THRESHOLD = 0.12;

/** Mẫu phủ định — thông tin mới phủ định thông tin cũ. */
const NEGATION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /không còn/i, label: 'không còn' },
  { pattern: /không thích/i, label: 'không thích' },
  { pattern: /không ở/i, label: 'không ở' },
  { pattern: /không làm/i, label: 'không làm' },
  { pattern: /không phải/i, label: 'không phải' },
  { pattern: /đã đổi/i, label: 'đã đổi' },
  { pattern: /chuyển sang/i, label: 'chuyển sang' },
  { pattern: /chuyển nhà/i, label: 'chuyển nhà' },
  { pattern: /nghỉ việc/i, label: 'nghỉ việc' },
  { pattern: /bỏ /i, label: 'bỏ' },
  { pattern: /thay vì/i, label: 'thay vì' },
  { pattern: /no longer/i, label: 'no longer' },
  { pattern: /not anymore/i, label: 'not anymore' },
  { pattern: /don'?t like/i, label: "don't like" },
  { pattern: /doesn'?t like/i, label: "doesn't like" },
  { pattern: /moved to/i, label: 'moved to' },
  { pattern: /quit/i, label: 'quit' },
  { pattern: /instead of/i, label: 'instead of' },
];

/** Cặp antonym (dạng chuẩn hoá, bỏ dấu). */
const ANTONYM_PAIRS: Array<[string, string]> = [
  ['thich', 'ghet'],
  ['like', 'hate'],
  ['love', 'hate'],
  ['o', 'roi'],
  ['lam', 'nghi'],
  ['co', 'khong co'],
  ['bat dau', 'ket thuc'],
  ['start', 'stop'],
  ['open', 'close'],
  ['mo', 'dong'],
  ['thang', 'thua'],
  ['win', 'lose'],
];

/** Động từ vị ngữ thường gặp (dạng chuẩn hoá) để tách chủ thể–tân ngữ. */
const PREDICATE_MARKERS = [
  'thich', 'ghet', 'song o', 'o', 'lam', 'hoc', 'choi', 'an', 'uong', 'di', 'den',
  'like', 'likes', 'love', 'loves', 'hate', 'live', 'lives', 'work', 'works', 'study',
];

export class RevisitEngine {
  constructor(private readonly store: EvolvingNoteStore) {}

  /**
   * Phân loại thông tin mới so với một note cũ. Chỉ phân tích, không
   * sửa store — để UI/tool quyết định áp dụng.
   */
  analyze(note: EvolvingNote, newText: string): RevisitAnalysis {
    const text = (newText ?? '').trim();
    if (!text) {
      return { decision: 'no-op', similarity: 0, explanation: 'Thông tin mới rỗng.' };
    }
    const oldText = noteSearchText(note);
    const normalizedOld = normalizeNoteText(oldText);
    const normalizedNew = normalizeNoteText(text);
    if (normalizedOld === normalizedNew) {
      return { decision: 'no-op', similarity: 1, explanation: 'Thông tin mới giống hệt note cũ.' };
    }

    // 1. Mâu thuẫn phủ định — kiểm tra trước, vì nó quan trọng nhất.
    const negation = this.detectNegation(note, text);
    if (negation) {
      return {
        decision: 'contradiction',
        similarity: this.similarityOf(note, text),
        conflict: negation,
        explanation: `Thông tin mới có dấu hiệu mâu thuẫn với note cũ: ${negation.detail}. Đưa vào hàng chờ duyệt, note cũ giữ nguyên.`,
      };
    }
    // 2. Antonym.
    const antonym = this.detectAntonym(normalizedOld, normalizedNew);
    if (antonym) {
      return {
        decision: 'contradiction',
        similarity: this.similarityOf(note, text),
        conflict: antonym,
        explanation: `Phát hiện cặp đối lập: ${antonym.detail}. Đưa vào hàng chờ duyệt.`,
      };
    }
    // 3. Cùng chủ thể–vị ngữ, tân ngữ khác (heuristic yếu, confidence thấp).
    const subjectConflict = this.detectSameSubjectDifferentObject(normalizedOld, normalizedNew);
    if (subjectConflict) {
      return {
        decision: 'contradiction',
        similarity: this.similarityOf(note, text),
        conflict: subjectConflict,
        explanation: `Cùng chủ đề nhưng tân ngữ khác: ${subjectConflict.detail}. Đưa vào hàng chờ duyệt (heuristic yếu — cần user xác nhận).`,
      };
    }

    // 4. Trùng lặp cao → merge; không liên quan → no-op; còn lại → append.
    // Cosine TF-IDF phạt text ngắn (tập con của note cũ) nên cộng thêm
    // "coverage": tỉ lệ token của thông tin mới đã có trong note cũ.
    // Thông tin mới là tập con của note cũ (coverage cao) thì gộp.
    const similarity = this.similarityOf(note, text);
    const coverage = this.tokenCoverage(note, text);
    if (similarity >= REVISIT_MERGE_THRESHOLD || coverage >= 0.8) {
      return {
        decision: 'merge',
        similarity,
        explanation: `Thông tin mới trùng lặp cao với note cũ (similarity ${similarity.toFixed(2)}, coverage ${coverage.toFixed(2)}) — gộp vào note cũ, giữ version.`,
      };
    }
    if (similarity < REVISIT_NOOP_THRESHOLD) {
      return {
        decision: 'no-op',
        similarity,
        explanation: `Thông tin mới ít liên quan tới note này (similarity ${similarity.toFixed(2)}) — nên tạo note mới thay vì revisit note này.`,
      };
    }
    return {
      decision: 'append',
      similarity,
      explanation: `Thông tin mới bổ sung cho note cũ (similarity ${similarity.toFixed(2)}) — ghi thêm vào note, giữ version cũ.`,
    };
  }

  /**
   * Áp dụng revisit: append/merge ghi vào note (version mới);
   * contradiction tạo conflict chờ duyệt; no-op không làm gì.
   * `supersede` phải đi qua `supersedeWithNewNote` (user xác nhận).
   */
  applyRevisit(
    noteId: string,
    newText: string,
    opts: { by?: string; forceDecision?: RevisitDecision } = {},
  ): RevisitResult {
    const note = this.store.getNote(noteId);
    if (!note) throw new Error(`Không tìm thấy note: ${noteId}.`);
    if (note.status !== 'active') {
      throw new Error(`Chỉ revisit được note active (hiện: ${note.status}).`);
    }
    const analysis = this.analyze(note, newText);
    const decision = opts.forceDecision ?? analysis.decision;
    const by = opts.by ?? 'user';

    if (decision === 'no-op') {
      return { decision, explanation: analysis.explanation };
    }
    if (decision === 'contradiction' && analysis.conflict) {
      const conflict = this.store.addConflict({
        noteId: note.id,
        noteTitle: note.title,
        newText: newText.trim().slice(0, 2000),
        reason: analysis.conflict.reason,
        detail: analysis.conflict.detail,
        confidence: analysis.conflict.confidence,
        scope: { ...note.scope },
      });
      return { decision, conflictId: conflict.id, explanation: analysis.explanation };
    }
    if (decision === 'append' || decision === 'merge') {
      const mergedBody =
        decision === 'merge'
          ? this.mergeBodies(note.body, newText.trim())
          : `${note.body.trim()}\n\n${newText.trim()}`;
      const updated = this.store.updateNote(noteId, {
        body: mergedBody,
        reason: decision === 'merge' ? 'revisit-merge' : 'revisit-append',
        updatedBy: by,
      });
      return { decision, note: updated, explanation: analysis.explanation };
    }
    if (decision === 'supersede') {
      return this.supersedeWithNewNote(noteId, newText, opts);
    }
    return { decision, explanation: analysis.explanation };
  }

  /**
   * Supersede có xác nhận: tạo note mới từ thông tin mới, note cũ đóng
   * lại. Dùng khi user đã duyệt conflict theo hướng "thông tin mới đúng".
   */
  supersedeWithNewNote(
    noteId: string,
    newText: string,
    opts: { by?: string; title?: string } = {},
  ): RevisitResult {
    const old = this.store.getNote(noteId);
    if (!old) throw new Error(`Không tìm thấy note: ${noteId}.`);
    const created = this.store.supersedeNote(noteId, {
      title: opts.title ?? old.title,
      body: newText.trim(),
      kind: old.kind,
      tags: old.tags,
      scope: { ...old.scope },
      confidence: old.confidence,
      createdBy: opts.by ?? 'user',
    });
    // Note mới kế thừa link của note cũ (mạng không đứt khi supersede).
    for (const link of old.links) {
      if (link.kind === 'supersedes') continue;
      try {
        this.store.addLink(created.id, link.targetId, link.kind, { weight: link.weight, auto: link.auto });
      } catch {
        // Link đích đã bị xoá — bỏ qua.
      }
    }
    this.store.addLink(created.id, old.id, 'supersedes', { weight: 1, auto: false, note: 'Thay thế note cũ.' });
    const fresh = this.store.getNote(created.id);
    return {
      decision: 'supersede',
      note: fresh,
      explanation: `Đã tạo note mới thay thế note cũ "${old.title}". Note cũ giữ lại ở trạng thái superseded.`,
    };
  }

  /**
   * Resolve một conflict đã duyệt: 'supersede' → tạo note mới thay thế;
   * 'merge' → gộp thông tin mới vào note cũ; 'keep-both' → tạo note mới
   * độc lập, note cũ giữ nguyên.
   */
  resolveConflict(
    conflictId: string,
    resolution: 'supersede' | 'merge' | 'keep-both',
    opts: { by?: string } = {},
  ): RevisitResult {
    const conflicts = this.store.listConflicts(undefined, 'pending');
    const conflict = conflicts.find((c) => c.id === conflictId);
    if (!conflict) throw new Error(`Không tìm thấy conflict đang chờ: ${conflictId}.`);
    const note = this.store.getNote(conflict.noteId);
    if (!note) throw new Error(`Note gốc của conflict đã không còn: ${conflict.noteId}.`);
    const by = opts.by ?? 'user';

    if (resolution === 'supersede') {
      const result = this.supersedeWithNewNote(note.id, conflict.newText, { by });
      this.store.resolveConflict(conflictId, 'supersede', { resolvedNoteId: result.note?.id, reviewedBy: by });
      return { ...result, explanation: `Conflict đã duyệt theo hướng supersede: ${result.explanation}` };
    }
    if (resolution === 'merge') {
      const updated = this.store.updateNote(note.id, {
        body: this.mergeBodies(note.body, conflict.newText),
        reason: 'conflict-merge',
        updatedBy: by,
      });
      this.store.resolveConflict(conflictId, 'merge', { resolvedNoteId: updated.id, reviewedBy: by });
      return { decision: 'merge', note: updated, explanation: 'Conflict đã duyệt: gộp thông tin mới vào note cũ.' };
    }
    // keep-both: tạo note mới độc lập, link contradicts tới note cũ.
    const created = this.store.createNote({
      title: `${note.title} (thông tin mới)`,
      body: conflict.newText,
      kind: note.kind,
      tags: note.tags,
      scope: { ...note.scope },
      createdBy: by,
    });
    this.store.addLink(created.id, note.id, 'contradicts', { weight: 0.8, auto: false, note: 'Hai thông tin mâu thuẫn, giữ cả hai để user tự quyết.' });
    this.store.resolveConflict(conflictId, 'keep-both', { resolvedNoteId: created.id, reviewedBy: by });
    const fresh = this.store.getNote(created.id);
    return {
      decision: 'append',
      note: fresh,
      explanation: 'Conflict đã duyệt theo hướng giữ cả hai: tạo note mới, link contradicts tới note cũ.',
    };
  }

  /**
   * Hàng đợi revisit: note active nào "đáng" được xem lại nhất.
   * Điểm staleness = tuổi (ngày) × (1 + degree/10) / (1 + revisitCount)
   * — note cũ, nhiều link, ít được revisit thì lên đầu.
   */
  revisitQueue(
    scope?: { userId?: string; botId?: string },
    limit = 10,
  ): Array<{ note: EvolvingNote; staleness: number; ageDays: number; degree: number }> {
    const now = Date.now();
    const notes = this.store.listNotes({ scope, status: 'active', limit: 10000 });
    const scored = notes.map((note) => {
      const ageDays = Math.max(0, (now - Date.parse(note.updatedAt)) / 86400000);
      const degree = this.store.degree(note.id);
      const staleness = ageDays * (1 + degree / 10) / (1 + note.revisitCount);
      return { note, staleness, ageDays, degree };
    });
    scored.sort((a, b) => b.staleness - a.staleness);
    return scored.slice(0, limit);
  }

  // ------------------------------------------------------------- phát hiện

  private similarityOf(note: EvolvingNote, newText: string): number {
    const idf = computeIdf([
      tokenCounts(noteSearchText(note)),
      tokenCounts(newText),
    ]);
    return compareNotes(
      note,
      { title: '', body: newText, tags: [] },
      idf,
    ).score;
  }

  /**
   * Coverage: tỉ lệ token (đã bỏ stopword) của thông tin mới đã xuất
   * hiện trong note cũ. 1.0 = thông tin mới hoàn toàn là tập con của
   * note cũ → merge, không append để tránh nhân đôi câu.
   */
  private tokenCoverage(note: EvolvingNote, newText: string): number {
    const oldTokens = new Set(tokenizeNoteText(noteSearchText(note)));
    const newTokens = tokenizeNoteText(newText);
    if (newTokens.length === 0) return 0;
    const uniqueNew = new Set(newTokens);
    let covered = 0;
    for (const token of uniqueNew) if (oldTokens.has(token)) covered++;
    return covered / uniqueNew.size;
  }

  /** Phủ định: thông tin mới chứa mẫu phủ định + trùng chủ đề với note cũ. */
  private detectNegation(
    note: EvolvingNote,
    newText: string,
  ): { reason: NoteConflictReason; detail: string; confidence: number } | null {
    const matched = NEGATION_PATTERNS.find((p) => p.pattern.test(newText));
    if (!matched) return null;
    const similarity = this.similarityOf(note, newText);
    if (similarity < REVISIT_NOOP_THRESHOLD) return null; // phủ định chuyện khác, không liên quan note này
    return {
      reason: 'negation',
      detail: `Thông tin mới chứa mẫu phủ định "${matched.label}" và trùng chủ đề với note cũ (similarity ${similarity.toFixed(2)}).`,
      confidence: 0.75,
    };
  }

  /** Antonym: note cũ chứa A, thông tin mới chứa antonym của A. */
  private detectAntonym(
    normalizedOld: string,
    normalizedNew: string,
  ): { reason: NoteConflictReason; detail: string; confidence: number } | null {
    for (const [a, b] of ANTONYM_PAIRS) {
      const oldHasA = normalizedOld.includes(a);
      const newHasB = normalizedNew.includes(b);
      const oldHasB = normalizedOld.includes(b);
      const newHasA = normalizedNew.includes(a);
      if ((oldHasA && newHasB) || (oldHasB && newHasA)) {
        const pair = oldHasA && newHasB ? `${a} ↔ ${b}` : `${b} ↔ ${a}`;
        return {
          reason: 'antonym',
          detail: `Cặp đối lập ${pair} xuất hiện ở hai phía.`,
          confidence: 0.7,
        };
      }
    }
    return null;
  }

  /**
   * Cùng chủ thể–vị ngữ, tân ngữ khác. Heuristic yếu: tách câu thành
   * "vị ngữ + tân ngữ" theo marker, so sánh tân ngữ. Chỉ kích hoạt khi
   * cả hai phía đều có cùng marker và tân ngữ khác nhau rõ rệt.
   */
  private detectSameSubjectDifferentObject(
    normalizedOld: string,
    normalizedNew: string,
  ): { reason: NoteConflictReason; detail: string; confidence: number } | null {
    for (const marker of PREDICATE_MARKERS) {
      const oldIdx = normalizedOld.indexOf(marker);
      const newIdx = normalizedNew.indexOf(marker);
      if (oldIdx < 0 || newIdx < 0) continue;
      const oldObj = normalizedOld.slice(oldIdx + marker.length).trim().split(' ').slice(0, 4).join(' ');
      const newObj = normalizedNew.slice(newIdx + marker.length).trim().split(' ').slice(0, 4).join(' ');
      if (!oldObj || !newObj || oldObj === newObj) continue;
      // Tân ngữ khác nhau hoàn toàn (không token chung) mới nghi ngờ.
      const oldTokens = new Set(oldObj.split(' '));
      const newTokens = new Set(newObj.split(' '));
      let shared = 0;
      for (const t of oldTokens) if (newTokens.has(t)) shared++;
      if (shared === 0) {
        return {
          reason: 'same-subject-different-object',
          detail: `Cùng "${marker}" nhưng tân ngữ khác: "${oldObj}" → "${newObj}".`,
          confidence: 0.45,
        };
      }
    }
    return null;
  }

  /** Gộp hai body: câu mới chưa có trong body cũ thì thêm, tránh trùng lặp câu. */
  private mergeBodies(oldBody: string, newText: string): string {
    const oldSentences = new Set(
      oldBody.split(/(?<=[.!?])\s+/).map((s) => normalizeNoteText(s)).filter(Boolean),
    );
    const fresh = newText
      .split(/(?<=[.!?])\s+/)
      .filter((s) => s.trim() && !oldSentences.has(normalizeNoteText(s)));
    if (fresh.length === 0) return oldBody;
    return `${oldBody.trim()}\n\n${fresh.join(' ')}`;
  }
}
