/**
 * Sync — cầu nối note với memory hiện có (v1.01, Đội T5).
 *
 * Note system BỔ SUNG, không thay thế:
 *  - Import một lần từ LongTermMemory (`importFromLongTerm`) và từ
 *    temporal graph (`importFromGraphFacts`) — mỗi entry/fact thành một
 *    note, ghi rõ `sourceMemoryId` / `sourceFactId` để không import
 *    trùng lần sau.
 *  - `buildNotesPromptSection` — render note vào system prompt (giống
 *    turnContext nhưng cho note, có link).
 *  - `searchWithEmbedding` — search lai: BM25 của store + cosine
 *    embedding (khi có embedder Ollama) gộp bằng Reciprocal Rank Fusion,
 *    giống hybrid search của graph. Không có embedder → fallback BM25.
 */

import type { LongTermMemory } from '../longterm';
import type { GraphFact } from '../graph/types';
import type { TemporalGraphStore } from '../graph/store';
import type { EvolvingNote, NoteKind } from './types';
import type { EvolvingNoteStore } from './store';
import type { Embedder } from '../embeddings';
import { cosineSimilarity, normalizeVector } from '../embeddings';
import { memoryEmbeddingText } from '../longterm';
import { normalizeNoteText, noteSearchText } from './types';

/** Kết quả import một lần. */
export interface NotesImportResult {
  imported: number;
  skippedDuplicate: number;
  skippedEmpty: number;
  noteIds: string[];
}

/** Ánh xạ kind của graph fact → kind note (ước lượng theo predicate). */
export function factPredicateToNoteKind(predicate: string): NoteKind {
  const p = (predicate ?? '').toLowerCase();
  if (p.includes('like') || p.includes('prefer') || p.includes('love') || p.includes('hate')) return 'preference';
  if (p.includes('live') || p.includes('located') || p.includes('based')) return 'place';
  if (p.includes('work') || p.includes('job') || p.includes('study')) return 'project';
  return 'fact';
}

/**
 * Import long-term memories thành note. Entry đã import rồi (cùng
 * sourceMemoryId) thì bỏ qua — chạy lại không tạo trùng.
 */
export function importFromLongTerm(
  store: EvolvingNoteStore,
  longTerm: LongTermMemory,
  opts: { botId?: string; userId?: string; limit?: number },
): NotesImportResult {
  const existing = new Set(
    store
      .listNotes({ scope: { userId: opts.userId ?? '', botId: opts.botId ?? '' }, status: 'all', limit: 10000 })
      .map((n) => n.sourceMemoryId)
      .filter((id): id is string => typeof id === 'string'),
  );
  const entries = longTerm.recall({
    limit: opts.limit ?? 1000,
    ...(opts.botId ? { botId: opts.botId } : {}),
    includeShared: true,
    ...(opts.userId ? { userId: opts.userId } : {}),
  });
  const result: NotesImportResult = { imported: 0, skippedDuplicate: 0, skippedEmpty: 0, noteIds: [] };
  for (const entry of entries) {
    if (existing.has(entry.id)) {
      result.skippedDuplicate++;
      continue;
    }
    const body = entry.value.trim();
    if (!body) {
      result.skippedEmpty++;
      continue;
    }
    const note = store.createNote({
      title: entry.key.trim().slice(0, 200) || entry.value.slice(0, 80),
      body,
      kind: entry.tags.includes('preference') ? 'preference' : 'fact',
      tags: entry.tags,
      confidence: entry.confidence,
      scope: { userId: entry.userId ?? opts.userId ?? '', botId: entry.botId, runId: '' },
      sourceMemoryId: entry.id,
      createdBy: 'system:import-longterm',
    });
    existing.add(entry.id);
    result.imported++;
    result.noteIds.push(note.id);
  }
  return result;
}

/**
 * Import fact active của temporal graph thành note. Fact đã superseded
 * / deleted / quarantined không import (chỉ tri thức đang đúng).
 */
export function importFromGraphFacts(
  store: EvolvingNoteStore,
  graph: TemporalGraphStore,
  opts: { botId?: string; userId?: string; limit?: number },
): NotesImportResult {
  const existing = new Set(
    store
      .listNotes({ scope: { userId: opts.userId ?? '', botId: opts.botId ?? '' }, status: 'all', limit: 10000 })
      .map((n) => n.sourceFactId)
      .filter((id): id is string => typeof id === 'string'),
  );
  const facts: GraphFact[] = graph.listFacts({
    userId: opts.userId ?? '',
    botId: opts.botId ?? '',
    runId: '',
    status: 'active',
    limit: opts.limit ?? 1000,
  });
  const result: NotesImportResult = { imported: 0, skippedDuplicate: 0, skippedEmpty: 0, noteIds: [] };
  for (const fact of facts) {
    if (existing.has(fact.id)) {
      result.skippedDuplicate++;
      continue;
    }
    const subject = graph.getEntity(fact.subjectId);
    const subjectName = subject?.name ?? 'user';
    const object = fact.objectId ? graph.getEntity(fact.objectId)?.name : fact.objectText;
    const body = `${subjectName} ${fact.predicate.replace(/_/g, ' ')} ${object ?? ''}`.trim();
    if (!body) {
      result.skippedEmpty++;
      continue;
    }
    const note = store.createNote({
      title: body.slice(0, 200),
      body: fact.provenance.sourceText ? `${body}\n\n(Nguồn: ${fact.provenance.sourceText.slice(0, 300)})` : body,
      kind: factPredicateToNoteKind(fact.predicate),
      tags: [fact.predicate.replace(/_/g, '-')],
      confidence: fact.confidence,
      scope: { ...fact.scope },
      sourceFactId: fact.id,
      sourceEpisodeId: fact.provenance.episodeId,
      createdBy: 'system:import-graph',
    });
    existing.add(fact.id);
    result.imported++;
    result.noteIds.push(note.id);
  }
  return result;
}

/** Một hit search lai (BM25 + embedding). */
export interface HybridNoteHit {
  note: EvolvingNote;
  score: number;
  sources: Array<'bm25' | 'embedding'>;
}

/**
 * Search lai cho note: BM25 (store.search) + cosine embedding (nếu có
 * embedder + note đã có vector — vector lưu tạm trong bộ nhớ, không
 * ghi xuống file note). Gộp bằng Reciprocal Rank Fusion (k=60) như
 * hybrid search của graph. Không có embedder → trả đúng kết quả BM25.
 */
export async function searchNotesHybrid(
  store: EvolvingNoteStore,
  query: string,
  opts: {
    scope?: { userId?: string; botId?: string };
    topK?: number;
    embedder?: Embedder;
    /** Map noteId → vector đã chuẩn hoá (do caller cache, vd từ lần embed trước). */
    vectors?: Map<string, number[]>;
  } = {},
): Promise<HybridNoteHit[]> {
  const topK = opts.topK ?? 10;
  const bm25Hits = store.search(query, { scope: opts.scope, topK: Math.max(topK, 20) });
  if (!opts.embedder || !opts.vectors || opts.vectors.size === 0) {
    return bm25Hits.slice(0, topK).map((h) => ({ note: h.note, score: h.score, sources: ['bm25'] }));
  }
  let queryVector: number[] | null = null;
  try {
    const embedded = await opts.embedder.embed(query.slice(0, 8000));
    if (embedded.length > 0) queryVector = normalizeVector(embedded);
  } catch {
    queryVector = null;
  }
  if (!queryVector) {
    return bm25Hits.slice(0, topK).map((h) => ({ note: h.note, score: h.score, sources: ['bm25'] }));
  }
  const embeddingScores: Array<{ note: EvolvingNote; score: number }> = [];
  for (const [noteId, vector] of opts.vectors) {
    const note = store.getNote(noteId);
    if (!note || note.status !== 'active') continue;
    if (!noteMatchesQueryScope(note, opts.scope)) continue;
    embeddingScores.push({ note, score: cosineSimilarity(queryVector, vector) });
  }
  embeddingScores.sort((a, b) => b.score - a.score);
  // Reciprocal Rank Fusion k=60.
  const fused = new Map<string, HybridNoteHit>();
  const addRank = (note: EvolvingNote, rank: number, source: 'bm25' | 'embedding') => {
    const prev = fused.get(note.id);
    const rrf = 1 / (60 + rank + 1);
    if (prev) {
      prev.score += rrf;
      if (!prev.sources.includes(source)) prev.sources.push(source);
    } else {
      fused.set(note.id, { note, score: rrf, sources: [source] });
    }
  };
  bm25Hits.forEach((h, i) => addRank(h.note, i, 'bm25'));
  embeddingScores.slice(0, Math.max(topK, 20)).forEach((h, i) => addRank(h.note, i, 'embedding'));
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, topK);
}

function noteMatchesQueryScope(
  note: EvolvingNote,
  scope?: { userId?: string; botId?: string },
): boolean {
  if (!scope) return true;
  if (scope.userId && note.scope.userId !== '' && note.scope.userId !== scope.userId) return false;
  if (scope.botId && note.scope.botId !== '' && note.scope.botId !== scope.botId) return false;
  return true;
}

/**
 * Embed toàn bộ note active của một scope (để caller cache vector cho
 * `searchNotesHybrid`). Text embed = `title + body + tags` — cùng dạng
 * với `memoryEmbeddingText` của long-term.
 */
export async function embedNotes(
  store: EvolvingNoteStore,
  embedder: Embedder,
  opts: { scope?: { userId?: string; botId?: string }; limit?: number } = {},
): Promise<Map<string, number[]>> {
  const notes = store.listNotes({ scope: opts.scope, status: 'active', limit: opts.limit ?? 500 });
  const out = new Map<string, number[]>();
  if (notes.length === 0) return out;
  const texts = notes.map((n) => memoryEmbeddingText({ key: n.title, value: n.body, tags: n.tags }));
  try {
    const vectors = embedder.embedBatch
      ? await embedder.embedBatch(texts)
      : await Promise.all(texts.map((t) => embedder.embed(t)));
    notes.forEach((note, i) => {
      const vector = vectors[i];
      if (vector) out.set(note.id, normalizeVector(vector));
    });
  } catch {
    // Embed lỗi → trả map rỗng, caller fallback BM25.
  }
  return out;
}

/** Render note thành section cho system prompt (có link, có version). */
export function buildNotesPromptSection(
  store: EvolvingNoteStore,
  query: string,
  opts: { scope?: { userId?: string; botId?: string }; topK?: number; maxChars?: number } = {},
): string {
  return store.buildPromptSection(query, {
    scope: opts.scope,
    topK: opts.topK ?? 5,
    maxChars: opts.maxChars ?? 4000,
  });
}

/** Text chuẩn hoá dùng chung khi cần so sánh note với query ngoài store. */
export function normalizeForNoteSearch(text: string): string {
  return normalizeNoteText(text);
}

export { noteSearchText };
