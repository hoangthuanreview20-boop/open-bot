/**
 * EvolvingNoteStore — kho note tiến hoá (v1.01, Đội T5).
 *
 * Lưu trữ: file JSON `<workspace>/.open-bot/memory-notes.json`, ghi atomic
 * (temp + rename, mode 0600) như LongTermMemory / blocks / graph.
 *
 * Bất biến:
 *  - Sửa nội dung (title/body/tags) → version cũ được push vào
 *    `versions`, `version` tăng 1, `updatedAt` đổi. Lịch sử không xoá.
 *  - Xoá là xoá mềm (`status='deleted'`, giữ lại để audit + restore).
 *  - Supersede: note cũ `status='superseded'`, `supersededBy` = id mới;
 *    note mới `supersedes` = id cũ.
 *  - Mọi đọc đều lọc theo scope (userId/botId); note scope khác không
 *    lọt ra trừ khi `includeOtherScopes: true`.
 *
 * Search: BM25 trên token đã chuẩn hoá (bỏ dấu TV) + cộng điểm tag khớp
 * chính xác; không cần embedder. Có thể truyền embedder vào sau này qua
 * `searchWithEmbedding` ở sync.ts — store này giữ search local thuần.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  EvolvingNote,
  NoteConflict,
  NoteKind,
  NoteLink,
  NoteLinkKind,
  NotesBackend,
  NotesFile,
  NoteScope,
  NoteStatus,
  NoteVersion,
} from './types';
import {
  MAX_NOTES,
  MAX_NOTE_BODY_CHARS,
  MAX_NOTE_TAGS,
  MAX_NOTE_TITLE_CHARS,
  MAX_NOTE_VERSIONS,
  NOTE_KINDS,
  NoteStoreError,
  normalizeNoteTag,
  normalizeNoteText,
  noteMatchesScope,
  noteSearchText,
} from './types';
import { bm25NoteScore, computeIdf, tokenCounts, tokenizeNoteText } from './similarity';

export const MEMORY_NOTES_REL_PATH = path.join('.open-bot', 'memory-notes.json');

function nowIso(): string {
  return new Date().toISOString();
}

export function emptyNotesFile(): NotesFile {
  const now = nowIso();
  return { version: 1, notes: [], conflicts: [], createdAt: now, updatedAt: now };
}

/** Backend file JSON mặc định — ghi atomic qua temp + rename. */
export class FileNotesBackend implements NotesBackend {
  constructor(private readonly filePath: string) {}

  load(): NotesFile | null {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as NotesFile;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.notes)) return null;
      if (!Array.isArray(parsed.conflicts)) parsed.conflicts = [];
      return parsed;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      throw new NoteStoreError(`Không đọc được file note (${this.filePath}): ${(err as Error).message}`);
    }
  }

  save(file: NotesFile): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Windows không có chmod unix — bỏ qua.
    }
  }
}

/** Backend in-memory — dùng cho test và cho benchmark harness. */
export class InMemoryNotesBackend implements NotesBackend {
  private file: NotesFile | null = null;

  load(): NotesFile | null {
    return this.file ? JSON.parse(JSON.stringify(this.file)) as NotesFile : null;
  }

  save(file: NotesFile): void {
    this.file = JSON.parse(JSON.stringify(file)) as NotesFile;
  }
}

/** Input tạo note mới. */
export interface CreateNoteInput {
  title: string;
  body: string;
  kind?: NoteKind;
  tags?: string[];
  confidence?: number;
  scope: NoteScope;
  sourceEpisodeId?: string;
  sourceFactId?: string;
  sourceMemoryId?: string;
  /** Link tay tạo ngay khi tạo note. */
  links?: Array<{ targetId: string; kind: NoteLinkKind; weight?: number; note?: string }>;
  /** Ai tạo: 'user' | 'agent:<botId>' | ... */
  createdBy?: string;
}

/** Patch sửa note (mọi sửa đều sinh version mới). */
export interface UpdateNotePatch {
  title?: string;
  body?: string;
  kind?: NoteKind;
  tags?: string[];
  confidence?: number;
  /** Lý do sửa — ghi vào version history. */
  reason?: string;
  /** Ai sửa. */
  updatedBy?: string;
}

/** Tuỳ chọn liệt kê note. */
export interface ListNotesOptions {
  scope?: Partial<NoteScope>;
  status?: NoteStatus | 'all';
  kind?: NoteKind;
  tag?: string;
  limit?: number;
  /** true = cả note của scope khác (chỉ dùng cho admin/share). */
  includeOtherScopes?: boolean;
  /** Sắp xếp: mới nhất / cũ nhất / nhiều link nhất / revisit nhiều nhất. */
  sortBy?: 'updated' | 'created' | 'links' | 'revisits';
}

/** Một hit search. */
export interface NoteSearchHit {
  note: EvolvingNote;
  score: number;
  /** Token query khớp (để UI highlight/giải thích). */
  matchedTokens: string[];
}

/** Thống kê kho note. */
export interface NotesStats {
  total: number;
  active: number;
  superseded: number;
  archived: number;
  deleted: number;
  totalLinks: number;
  autoLinks: number;
  orphans: number;
  /** Note có nhiều link nhất (hub). */
  topHub: { id: string; title: string; degree: number } | null;
  pendingConflicts: number;
  byKind: Record<string, number>;
}

function cleanTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const t = normalizeNoteTag(String(tag));
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.slice(0, MAX_NOTE_TAGS);
}

function clampConfidence(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

export class EvolvingNoteStore {
  private file: NotesFile;

  constructor(private readonly backend: NotesBackend) {
    this.file = backend.load() ?? emptyNotesFile();
  }

  /** Mở store từ workspace dir (`<workspace>/.open-bot/memory-notes.json`). */
  static fromWorkspace(workspaceDir: string): EvolvingNoteStore {
    return new EvolvingNoteStore(new FileNotesBackend(path.join(workspaceDir, MEMORY_NOTES_REL_PATH)));
  }

  /** Mở store in-memory (test / benchmark). */
  static inMemory(): EvolvingNoteStore {
    return new EvolvingNoteStore(new InMemoryNotesBackend());
  }

  private persist(): void {
    this.file.updatedAt = nowIso();
    this.backend.save(this.file);
  }

  // ------------------------------------------------------------------ CRUD

  createNote(input: CreateNoteInput): EvolvingNote {
    const title = (input.title ?? '').trim().slice(0, MAX_NOTE_TITLE_CHARS);
    if (!title) throw new NoteStoreError('Tiêu đề note không được rỗng.');
    const body = (input.body ?? '').trim().slice(0, MAX_NOTE_BODY_CHARS);
    if (!body) throw new NoteStoreError('Nội dung note không được rỗng.');
    if (input.kind !== undefined && !NOTE_KINDS.includes(input.kind)) {
      throw new NoteStoreError(`kind không hợp lệ: ${input.kind}.`);
    }
    if (this.file.notes.length >= MAX_NOTES) {
      throw new NoteStoreError(`Đã đạt giới hạn ${MAX_NOTES} note — archive hoặc xoá note cũ trước.`);
    }
    const now = nowIso();
    const note: EvolvingNote = {
      id: randomUUID(),
      title,
      body,
      kind: input.kind ?? 'fact',
      tags: cleanTags(input.tags),
      status: 'active',
      confidence: clampConfidence(input.confidence, 0.8),
      scope: { ...input.scope },
      links: [],
      versions: [],
      version: 1,
      ...(input.sourceEpisodeId ? { sourceEpisodeId: input.sourceEpisodeId } : {}),
      ...(input.sourceFactId ? { sourceFactId: input.sourceFactId } : {}),
      ...(input.sourceMemoryId ? { sourceMemoryId: input.sourceMemoryId } : {}),
      lastRevisitedAt: null,
      revisitCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    for (const link of input.links ?? []) {
      const target = this.file.notes.find((n) => n.id === link.targetId);
      if (!target) throw new NoteStoreError(`Không tìm thấy note đích: ${link.targetId}.`);
      note.links.push({
        targetId: link.targetId,
        kind: link.kind,
        weight: clampConfidence(link.weight, 1),
        auto: false,
        ...(link.note ? { note: link.note } : {}),
        createdAt: now,
      });
    }
    this.file.notes.push(note);
    this.persist();
    return structuredClone(note);
  }

  getNote(id: string): EvolvingNote | undefined {
    const note = this.file.notes.find((n) => n.id === id);
    return note ? structuredClone(note) : undefined;
  }

  /** Liệt kê note theo scope/trạng thái/loại/tag. */
  listNotes(opts: ListNotesOptions = {}): EvolvingNote[] {
    const scope = opts.scope ?? {};
    let notes = this.file.notes.filter((n) => noteMatchesScope(n, scope, opts));
    if (opts.status !== undefined && opts.status !== 'all') {
      notes = notes.filter((n) => n.status === opts.status);
    } else if (opts.status === undefined) {
      notes = notes.filter((n) => n.status === 'active');
    }
    if (opts.kind) notes = notes.filter((n) => n.kind === opts.kind);
    if (opts.tag) {
      const tag = normalizeNoteTag(opts.tag);
      notes = notes.filter((n) => n.tags.includes(tag));
    }
    const sortBy = opts.sortBy ?? 'updated';
    notes = [...notes].sort((a, b) => {
      if (sortBy === 'created') return b.createdAt.localeCompare(a.createdAt);
      if (sortBy === 'links') return b.links.length - a.links.length;
      if (sortBy === 'revisits') return b.revisitCount - a.revisitCount;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    const limit = opts.limit ?? 200;
    return structuredClone(notes.slice(0, Math.max(1, limit)));
  }

  /**
   * Sửa note: version hiện tại được push vào `versions` rồi mới ghi đè.
   * Trả về note sau khi sửa. Sửa note đã xoá / đã supersede bị chặn
   * (muốn sửa thì restore / tạo note mới supersede nó).
   */
  updateNote(id: string, patch: UpdateNotePatch): EvolvingNote {
    const note = this.file.notes.find((n) => n.id === id);
    if (!note) throw new NoteStoreError(`Không tìm thấy note: ${id}.`);
    if (note.status === 'deleted') throw new NoteStoreError('Note đã xoá — restore trước khi sửa.');
    if (note.status === 'superseded') {
      throw new NoteStoreError('Note đã bị supersede — tạo note mới thay thế thay vì sửa note cũ.');
    }
    const nextTitle = patch.title !== undefined ? patch.title.trim().slice(0, MAX_NOTE_TITLE_CHARS) : note.title;
    const nextBody = patch.body !== undefined ? patch.body.trim().slice(0, MAX_NOTE_BODY_CHARS) : note.body;
    if (!nextTitle) throw new NoteStoreError('Tiêu đề note không được rỗng.');
    if (!nextBody) throw new NoteStoreError('Nội dung note không được rỗng.');
    if (patch.kind !== undefined && !NOTE_KINDS.includes(patch.kind)) {
      throw new NoteStoreError(`kind không hợp lệ: ${patch.kind}.`);
    }
    const changed =
      nextTitle !== note.title ||
      nextBody !== note.body ||
      patch.kind !== undefined ||
      patch.tags !== undefined ||
      patch.confidence !== undefined;
    if (!changed) return structuredClone(note);
    note.versions.push({
      version: note.version,
      title: note.title,
      body: note.body,
      tags: [...note.tags],
      reason: patch.reason ?? 'update',
      createdBy: patch.updatedBy ?? 'user',
      createdAt: note.updatedAt,
    });
    if (note.versions.length > MAX_NOTE_VERSIONS) {
      // Gộp các version cổ nhất thành một version "archived history".
      const dropped = note.versions.splice(0, note.versions.length - MAX_NOTE_VERSIONS);
      note.versions.unshift({
        version: dropped[0].version,
        title: dropped[dropped.length - 1].title,
        body: `(Lịch sử đã gộp: ${dropped.length} version cũ, từ v${dropped[0].version} tới v${dropped[dropped.length - 1].version}.)\n${dropped[dropped.length - 1].body}`,
        tags: dropped[dropped.length - 1].tags,
        reason: 'history-compacted',
        createdBy: 'system',
        createdAt: dropped[0].createdAt,
      });
    }
    note.title = nextTitle;
    note.body = nextBody;
    if (patch.kind !== undefined) note.kind = patch.kind;
    if (patch.tags !== undefined) note.tags = cleanTags(patch.tags);
    if (patch.confidence !== undefined) note.confidence = clampConfidence(patch.confidence, note.confidence);
    note.version += 1;
    note.updatedAt = nowIso();
    note.lastRevisitedAt = note.updatedAt;
    note.revisitCount += 1;
    this.persist();
    return structuredClone(note);
  }

  /** Lịch sử version của một note (cũ → mới, chưa gồm version hiện tại). */
  noteHistory(id: string): NoteVersion[] {
    const note = this.file.notes.find((n) => n.id === id);
    if (!note) throw new NoteStoreError(`Không tìm thấy note: ${id}.`);
    return structuredClone(note.versions);
  }

  /** Xoá mềm — giữ lại để audit + restore + hỏi lịch sử. */
  deleteNote(id: string): EvolvingNote {
    const note = this.file.notes.find((n) => n.id === id);
    if (!note) throw new NoteStoreError(`Không tìm thấy note: ${id}.`);
    if (note.status === 'deleted') return structuredClone(note);
    note.status = 'deleted';
    note.updatedAt = nowIso();
    this.persist();
    return structuredClone(note);
  }

  restoreNote(id: string): EvolvingNote {
    const note = this.file.notes.find((n) => n.id === id);
    if (!note) throw new NoteStoreError(`Không tìm thấy note: ${id}.`);
    if (note.status !== 'deleted') return structuredClone(note);
    note.status = 'active';
    note.updatedAt = nowIso();
    this.persist();
    return structuredClone(note);
  }

  archiveNote(id: string): EvolvingNote {
    const note = this.file.notes.find((n) => n.id === id);
    if (!note) throw new NoteStoreError(`Không tìm thấy note: ${id}.`);
    if (note.status !== 'active') throw new NoteStoreError(`Chỉ archive được note active (hiện: ${note.status}).`);
    note.status = 'archived';
    note.updatedAt = nowIso();
    this.persist();
    return structuredClone(note);
  }

  /**
   * Supersede: tạo note mới thay thế note cũ. Note cũ đóng lại
   * (`superseded`, `supersededBy`), note mới trỏ `supersedes`.
   */
  supersedeNote(oldId: string, input: CreateNoteInput): EvolvingNote {
    const old = this.file.notes.find((n) => n.id === oldId);
    if (!old) throw new NoteStoreError(`Không tìm thấy note: ${oldId}.`);
    if (old.status !== 'active') {
      throw new NoteStoreError(`Chỉ supersede được note active (hiện: ${old.status}).`);
    }
    const created = this.createNote({
      ...input,
      scope: input.scope ?? old.scope,
      tags: input.tags ?? old.tags,
      kind: input.kind ?? old.kind,
    });
    const fresh = this.file.notes.find((n) => n.id === created.id);
    if (fresh) {
      fresh.supersedes = oldId;
      this.persist();
    }
    old.status = 'superseded';
    old.supersededBy = created.id;
    old.updatedAt = nowIso();
    this.persist();
    return structuredClone(fresh ?? created);
  }

  /**
   * Nối supersession giữa hai note ĐÃ TỒN TẠI (không tạo note mới):
   * note cũ đóng lại (`superseded`, `supersededBy`), note mới trỏ
   * `supersedes`. Dùng khi benchmark (bản mới đã ingest trước) hoặc khi
   * import dữ liệu có sẵn cả hai bản.
   */
  supersedeLinkOnly(oldId: string, newId: string): void {
    const oldNote = this.file.notes.find((n) => n.id === oldId);
    const newNote = this.file.notes.find((n) => n.id === newId);
    if (!oldNote) throw new NoteStoreError(`Không tìm thấy note: ${oldId}.`);
    if (!newNote) throw new NoteStoreError(`Không tìm thấy note: ${newId}.`);
    if (oldNote.status !== 'active') {
      throw new NoteStoreError(`Chỉ supersede được note active (hiện: ${oldNote.status}).`);
    }
    oldNote.status = 'superseded';
    oldNote.supersededBy = newId;
    oldNote.updatedAt = nowIso();
    newNote.supersedes = oldId;
    newNote.updatedAt = nowIso();
    this.persist();
  }

  // ------------------------------------------------------------------ Links

  addLink(noteId: string, targetId: string, kind: NoteLinkKind, opts: { weight?: number; auto?: boolean; note?: string } = {}): EvolvingNote {
    const note = this.file.notes.find((n) => n.id === noteId);
    if (!note) throw new NoteStoreError(`Không tìm thấy note: ${noteId}.`);
    const target = this.file.notes.find((n) => n.id === targetId);
    if (!target) throw new NoteStoreError(`Không tìm thấy note đích: ${targetId}.`);
    if (noteId === targetId) throw new NoteStoreError('Không tự link tới chính mình.');
    const existing = note.links.find((l) => l.targetId === targetId && l.kind === kind);
    if (existing) {
      existing.weight = clampConfidence(opts.weight, existing.weight);
      if (opts.note !== undefined) existing.note = opts.note;
      this.persist();
      return structuredClone(note);
    }
    note.links.push({
      targetId,
      kind,
      weight: clampConfidence(opts.weight, 1),
      auto: opts.auto ?? false,
      ...(opts.note ? { note: opts.note } : {}),
      createdAt: nowIso(),
    });
    note.updatedAt = nowIso();
    this.persist();
    return structuredClone(note);
  }

  removeLink(noteId: string, targetId: string, kind?: NoteLinkKind): boolean {
    const note = this.file.notes.find((n) => n.id === noteId);
    if (!note) throw new NoteStoreError(`Không tìm thấy note: ${noteId}.`);
    const before = note.links.length;
    note.links = note.links.filter((l) => !(l.targetId === targetId && (kind === undefined || l.kind === kind)));
    if (note.links.length === before) return false;
    note.updatedAt = nowIso();
    this.persist();
    return true;
  }

  /** Backlink: mọi note đang link tới note này (kèm loại link). */
  backlinks(noteId: string): Array<{ fromId: string; fromTitle: string; kind: NoteLinkKind; weight: number; auto: boolean }> {
    const out: Array<{ fromId: string; fromTitle: string; kind: NoteLinkKind; weight: number; auto: boolean }> = [];
    for (const note of this.file.notes) {
      if (note.status === 'deleted') continue;
      for (const link of note.links) {
        if (link.targetId === noteId) {
          out.push({ fromId: note.id, fromTitle: note.title, kind: link.kind, weight: link.weight, auto: link.auto });
        }
      }
    }
    return out;
  }

  /** Bậc (degree) của một note: link ra + backlink. */
  degree(noteId: string): number {
    const note = this.file.notes.find((n) => n.id === noteId);
    if (!note) return 0;
    return note.links.length + this.backlinks(noteId).length;
  }

  /** Note active không có link ra lẫn backlink. */
  orphanNotes(scope?: Partial<NoteScope>): EvolvingNote[] {
    return this.listNotes({ scope, status: 'active', limit: MAX_NOTES }).filter((n) => this.degree(n.id) === 0);
  }

  // ------------------------------------------------------------------ Search

  /**
   * Search BM25: token query đã chuẩn hoá (bỏ dấu TV) so với title+body,
   * cộng điểm khi tag khớp chính xác. Trả top-k theo điểm.
   */
  search(
    query: string,
    opts: { scope?: Partial<NoteScope>; topK?: number; status?: NoteStatus | 'all'; kind?: NoteKind } = {},
  ): NoteSearchHit[] {
    const q = (query ?? '').trim();
    const candidates = this.listNotes({
      scope: opts.scope,
      status: opts.status ?? 'active',
      kind: opts.kind,
      limit: MAX_NOTES,
    });
    if (candidates.length === 0) return [];
    if (!q) {
      return candidates.slice(0, opts.topK ?? 10).map((note) => ({ note, score: 0, matchedTokens: [] }));
    }
    const queryTokens = tokenizeNoteText(q);
    const docs = candidates.map((note) => tokenCounts(noteSearchText(note)));
    const idf = computeIdf(docs);
    const lengths = docs.map((d) => [...d.values()].reduce((a, b) => a + b, 0));
    const avgLength = lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length);
    const hits: NoteSearchHit[] = [];
    candidates.forEach((note, i) => {
      let score = bm25NoteScore(queryTokens, docs[i], lengths[i], avgLength, idf);
      // Tag khớp chính xác với token query được cộng điểm (tag là tín hiệu mạnh).
      const tagSet = new Set(note.tags.map((t) => normalizeNoteText(t)));
      let tagBonus = 0;
      const matchedTokens: string[] = [];
      for (const token of new Set(queryTokens)) {
        if (docs[i].has(token)) matchedTokens.push(token);
        if (tagSet.has(token)) tagBonus += 1;
      }
      score += tagBonus * 1.5;
      if (score > 0) hits.push({ note, score, matchedTokens });
    });
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, opts.topK ?? 10);
  }

  // ------------------------------------------------------------------ Conflicts

  listConflicts(scope?: Partial<NoteScope>, status: 'pending' | 'resolved' | 'dismissed' | 'all' = 'pending'): NoteConflict[] {
    return structuredClone(
      this.file.conflicts.filter((c) => {
        if (status !== 'all' && c.status !== status) return false;
        if (!scope) return true;
        return noteMatchesScope({ scope: c.scope } as EvolvingNote, scope);
      }),
    );
  }

  /** Thêm conflict vào hàng chờ (dùng bởi revisit engine). */
  addConflict(conflict: Omit<NoteConflict, 'id' | 'status' | 'createdAt'>): NoteConflict {
    const item: NoteConflict = {
      ...conflict,
      id: randomUUID(),
      status: 'pending',
      createdAt: nowIso(),
    };
    this.file.conflicts.push(item);
    this.persist();
    return structuredClone(item);
  }

  resolveConflict(
    id: string,
    resolution: 'supersede' | 'merge' | 'keep-both',
    opts: { resolvedNoteId?: string; reviewedBy?: string } = {},
  ): NoteConflict {
    const item = this.file.conflicts.find((c) => c.id === id);
    if (!item) throw new NoteStoreError(`Không tìm thấy conflict: ${id}.`);
    if (item.status !== 'pending') throw new NoteStoreError(`Conflict đã ${item.status}, không resolve lại được.`);
    item.status = 'resolved';
    item.resolution = resolution;
    if (opts.resolvedNoteId) item.resolvedNoteId = opts.resolvedNoteId;
    item.reviewedBy = opts.reviewedBy ?? 'user';
    item.reviewedAt = nowIso();
    this.persist();
    return structuredClone(item);
  }

  dismissConflict(id: string, reviewedBy = 'user'): NoteConflict {
    const item = this.file.conflicts.find((c) => c.id === id);
    if (!item) throw new NoteStoreError(`Không tìm thấy conflict: ${id}.`);
    if (item.status !== 'pending') throw new NoteStoreError(`Conflict đã ${item.status}.`);
    item.status = 'dismissed';
    item.reviewedBy = reviewedBy;
    item.reviewedAt = nowIso();
    this.persist();
    return structuredClone(item);
  }

  // ------------------------------------------------------------------ Stats / prompt

  stats(scope?: Partial<NoteScope>): NotesStats {
    const notes = this.listNotes({ scope, status: 'all', limit: MAX_NOTES });
    const byKind: Record<string, number> = {};
    let totalLinks = 0;
    let autoLinks = 0;
    let topHub: { id: string; title: string; degree: number } | null = null;
    for (const note of notes) {
      byKind[note.kind] = (byKind[note.kind] ?? 0) + 1;
      totalLinks += note.links.length;
      autoLinks += note.links.filter((l) => l.auto).length;
      const degree = this.degree(note.id);
      if (!topHub || degree > topHub.degree) topHub = { id: note.id, title: note.title, degree };
    }
    const active = notes.filter((n) => n.status === 'active');
    const orphans = active.filter((n) => this.degree(n.id) === 0).length;
    return {
      total: notes.length,
      active: active.length,
      superseded: notes.filter((n) => n.status === 'superseded').length,
      archived: notes.filter((n) => n.status === 'archived').length,
      deleted: notes.filter((n) => n.status === 'deleted').length,
      totalLinks,
      autoLinks,
      orphans,
      topHub,
      pendingConflicts: this.file.conflicts.filter((c) => c.status === 'pending').length,
      byKind,
    };
  }

  /**
   * Render note thành section cho system prompt (kiểu turnContext):
   * top note active theo query, kèm link quan trọng nhất của mỗi note.
   * Trả '' khi không có note nào.
   */
  buildPromptSection(query: string, opts: { scope?: Partial<NoteScope>; topK?: number; maxChars?: number } = {}): string {
    const hits = this.search(query, { scope: opts.scope, topK: opts.topK ?? 5 });
    if (hits.length === 0) return '';
    const maxChars = opts.maxChars ?? 4000;
    const lines: string[] = ['[Evolving notes — tri thức user đã ghi nhớ, có link lẫn nhau]'];
    let chars = lines[0].length;
    for (const { note } of hits) {
      const linked = note.links
        .slice(0, 3)
        .map((l) => {
          const target = this.file.notes.find((n) => n.id === l.targetId);
          return target ? `${l.kind}:${target.title}` : null;
        })
        .filter((x): x is string => x !== null);
      const line = `- ${note.title} (${note.kind}): ${note.body.slice(0, 500)}${linked.length > 0 ? ` [→ ${linked.join(', ')}]` : ''}`;
      if (chars + line.length > maxChars) break;
      lines.push(line);
      chars += line.length;
    }
    return lines.join('\n');
  }
}
