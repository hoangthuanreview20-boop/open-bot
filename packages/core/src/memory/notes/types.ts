/**
 * Evolving notes — kiểu dữ liệu (v1.01, Đội T5).
 *
 * Ý tưởng học từ Zettelkasten / evergreen notes và A-MEM (chỉ ý tưởng,
 * tự thiết kế lại hoàn toàn cho open-bot, chạy 100% local):
 *
 *  - Mỗi mẩu tri thức là một NOTE độc lập: tiêu đề + nội dung văn bản tự
 *    do + tag + loại. Khác với fact của temporal graph (subject—predicate
 *    →object, có cấu trúc), note giữ văn bản dài, mang ngữ cảnh.
 *  - Note LIÊN KẾT với nhau: link là dữ liệu hạng nhất, có hướng, có
 *    loại quan hệ (`related`, `supports`, `contradicts`, `supersedes`,
 *    `part-of`) và trọng số; link do máy gợi ý được đánh dấu `auto`.
 *  - Note TIẾN HOÁ: khi thông tin mới tới, note cũ được revisit — nội
 *    dung cũ KHÔNG bị xoá mà được đẩy vào `versions` (version tăng dần),
 *    giống bi-temporal của graph nhưng ở mức văn bản. Note bị thay thế
 *    hẳn thì `status = 'superseded'` và trỏ `supersededBy` sang note mới,
 *    để vẫn hỏi được "trước đây thì sao".
 *  - Mọi note mang scope `{userId, botId, runId}` như graph: note của
 *    user/bot khác không bao giờ lọt vào search của scope này.
 *
 * Lưu trữ: file JSON `<workspace>/.open-bot/memory-notes.json`, ghi
 * atomic (temp + rename, mode 0600) như LongTermMemory / blocks / graph.
 */

import { normalizeGraphText } from '../graph/types';

/** Loại note — dùng để lọc và để UI nhóm hiển thị. */
export type NoteKind =
  | 'fact'
  | 'preference'
  | 'event'
  | 'project'
  | 'person'
  | 'place'
  | 'idea'
  | 'other';

/** Trạng thái vòng đời của một note. */
export type NoteStatus =
  | 'active'
  | 'superseded'
  | 'archived'
  | 'deleted';

/** Loại quan hệ giữa hai note. */
export type NoteLinkKind =
  | 'related'
  | 'supports'
  | 'contradicts'
  | 'supersedes'
  | 'part-of';

/** Một phiên bản cũ của note — lịch sử không bao giờ bị xoá. */
export interface NoteVersion {
  /** Số version (1 = bản đầu tiên). */
  version: number;
  title: string;
  body: string;
  tags: string[];
  /** Lý do tạo version này: append / merge / correction / supersede... */
  reason: string;
  /** Ai tạo version: 'user', 'agent:<botId>', 'system:revisit', ... */
  createdBy: string;
  createdAt: string;
}

/** Một link từ note này sang note khác. */
export interface NoteLink {
  /** Id note đích. */
  targetId: string;
  kind: NoteLinkKind;
  /** Độ mạnh của link 0..1 (máy tính từ similarity, tay tạo mặc định 1). */
  weight: number;
  /** true = máy tự gợi ý/gắn (auto-link), false = user/agent tạo tay. */
  auto: boolean;
  /** Ghi chú ngắn về link (vd lý do gợi ý). */
  note?: string;
  createdAt: string;
}

/** Scope sở hữu note — cùng quy ước với temporal graph. */
export interface NoteScope {
  userId: string;
  botId: string;
  runId: string;
}

/** Một evolving note. */
export interface EvolvingNote {
  id: string;
  title: string;
  body: string;
  kind: NoteKind;
  tags: string[];
  status: NoteStatus;
  /** Note này thay thế note nào (khi tạo ra để supersede note cũ). */
  supersedes?: string;
  /** Note này bị note nào thay thế (khi bị supersede). */
  supersededBy?: string;
  /** Độ tin cậy 0..1. */
  confidence: number;
  scope: NoteScope;
  links: NoteLink[];
  /** Lịch sử version (không chứa version hiện tại — nó nằm ở title/body). */
  versions: NoteVersion[];
  /** Số version hiện tại (1 = chưa từng sửa). */
  version: number;
  /** Episode đã sinh ra note (nếu import từ hội thoại). */
  sourceEpisodeId?: string;
  /** Fact graph đã sinh ra note (nếu import từ graph). */
  sourceFactId?: string;
  /** Memory long-term đã sinh ra note (nếu import từ long-term). */
  sourceMemoryId?: string;
  /** Lần revisit gần nhất (ISO, null = chưa từng revisit). */
  lastRevisitedAt: string | null;
  /** Số lần note đã được revisit. */
  revisitCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Toàn bộ file note `.open-bot/memory-notes.json`. */
export interface NotesFile {
  version: 1;
  notes: EvolvingNote[];
  /** Mâu thuẫn đang chờ user duyệt (xem revisit.ts). */
  conflicts: NoteConflict[];
  createdAt: string;
  updatedAt: string;
}

/** Lý do một mâu thuẫn được phát hiện. */
export type NoteConflictReason =
  | 'negation'
  | 'antonym'
  | 'same-subject-different-object'
  | 'manual';

/** Một mâu thuẫn chờ duyệt: thông tin mới xung đột với note cũ. */
export interface NoteConflict {
  id: string;
  /** Note cũ bị xung đột. */
  noteId: string;
  /** Tiêu đề note cũ (snapshot để UI hiển thị dù note đổi sau đó). */
  noteTitle: string;
  /** Thông tin mới gây xung đột (văn bản). */
  newText: string;
  reason: NoteConflictReason;
  /** Chi tiết cho user: mẫu nào khớp / cặp nào đối lập. */
  detail: string;
  /** Độ tin cậy của phát hiện 0..1 (heuristic — không phải NLI). */
  confidence: number;
  scope: NoteScope;
  status: 'pending' | 'resolved' | 'dismissed';
  /** Cách giải quyết khi resolved: 'supersede' | 'merge' | 'keep-both'. */
  resolution?: 'supersede' | 'merge' | 'keep-both';
  /** Note mới được tạo ra khi resolve bằng supersede/merge (nếu có). */
  resolvedNoteId?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  createdAt: string;
}

/** Lỗi của note store. */
export class NoteStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoteStoreError';
  }
}

/** Backend lưu trữ thô — tách để sau này ghép backend khác (SQLite...). */
export interface NotesBackend {
  load(): NotesFile | null;
  save(file: NotesFile): void;
}

/** Độ dài tối đa của tiêu đề / nội dung note (ký tự). */
export const MAX_NOTE_TITLE_CHARS = 200;
export const MAX_NOTE_BODY_CHARS = 20000;
export const MAX_NOTE_TAGS = 20;
export const MAX_NOTE_TAG_CHARS = 64;
/** Số note tối đa trong một file (chặn file phình vô hạn). */
export const MAX_NOTES = 10000;
/** Số version tối đa giữ lại cho một note (version cổ nhất bị gộp). */
export const MAX_NOTE_VERSIONS = 50;

/** Các loại note hợp lệ (để validate input ngoài). */
export const NOTE_KINDS: readonly NoteKind[] = [
  'fact',
  'preference',
  'event',
  'project',
  'person',
  'place',
  'idea',
  'other',
];

/** Các loại link hợp lệ. */
export const NOTE_LINK_KINDS: readonly NoteLinkKind[] = [
  'related',
  'supports',
  'contradicts',
  'supersedes',
  'part-of',
];

/** Chuẩn hoá text để so sánh/tìm kiếm: dùng chung normalizeGraphText. */
export function normalizeNoteText(text: string): string {
  return normalizeGraphText(text);
}

/** Chuẩn hoá một tag: chữ thường, bỏ dấu, chỉ giữ chữ/số/gạch nối. */
export function normalizeNoteTag(tag: string): string {
  return normalizeGraphText(tag).replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, MAX_NOTE_TAG_CHARS);
}

/** Text dùng để search / tính similarity cho một note. */
export function noteSearchText(note: Pick<EvolvingNote, 'title' | 'body' | 'tags'>): string {
  const tags = (note.tags ?? []).filter(Boolean).join(' ');
  return `${note.title} ${note.body}${tags ? ` ${tags}` : ''}`.trim();
}

/** Note có đang hiệu lực (active) tại một thời điểm không. */
export function isNoteActive(note: EvolvingNote): boolean {
  return note.status === 'active';
}

/** Bản public của note — bỏ version history dài khi trả qua tool/IPC. */
export function publicNote(
  note: EvolvingNote,
  opts: { includeVersions?: boolean; includeBody?: boolean } = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: note.id,
    title: note.title,
    kind: note.kind,
    tags: note.tags,
    status: note.status,
    confidence: note.confidence,
    version: note.version,
    links: note.links,
    revisitCount: note.revisitCount,
    lastRevisitedAt: note.lastRevisitedAt,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
  if (opts.includeBody !== false) out.body = note.body;
  if (note.supersedes) out.supersedes = note.supersedes;
  if (note.supersededBy) out.supersededBy = note.supersededBy;
  if (opts.includeVersions) out.versions = note.versions;
  return out;
}

/** Kiểm tra một note có thuộc scope không ('' = legacy, thuộc scope hiện tại). */
export function noteMatchesScope(
  note: EvolvingNote,
  scope: Partial<NoteScope>,
  opts: { includeOtherScopes?: boolean } = {},
): boolean {
  if (opts.includeOtherScopes) return true;
  if (scope.userId !== undefined && scope.userId !== '' && note.scope.userId !== '' && note.scope.userId !== scope.userId) return false;
  if (scope.botId !== undefined && scope.botId !== '' && note.scope.botId !== '' && note.scope.botId !== scope.botId) return false;
  return true;
}
