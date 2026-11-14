/**
 * Verbatim local memory — types (v1.01, Đội T4).
 *
 * Tầng memory NGUYÊN VĂN: lưu đúng câu chữ đã nói, không tóm tắt, không
 * trích xuất, không diễn giải lại. Ý tưởng tổ chức phân cấp (wing →
 * room → drawer) và backend cắm được học ở mức khái niệm từ các mô tả
 * công khai của MemPalace; toàn bộ code dưới đây là code gốc của
 * open-bot, không copy từ repo nào.
 *
 * Khác với `LongTermMemory` (key/value đã rút gọn) và memory blocks
 * (đoạn text quản lý tay): verbatim record là bằng chứng gốc — text
 * trong record là thứ user/agent đã nói, kèm nguồn + thời điểm để
 * truy vết. Tầng cấu trúc (graph, blocks, profile) có thể trỏ tới
 * record này, nhưng không thay thế nó.
 */
import { createHash } from 'node:crypto';

/** Nguồn gốc của một verbatim record. */
export type VerbatimSource =
  | 'user'
  | 'agent'
  | 'tool'
  | 'import'
  | 'autosave'
  | 'manual';

/** Một chunk memory nguyên văn. */
export interface VerbatimRecord {
  /** UUID (v4). */
  id: string;
  /** Text NGUYÊN VĂN — không tóm tắt, không diễn giải. */
  text: string;
  /** Ai / cái gì đã nói ra text này. */
  source: VerbatimSource;
  /** Wing: người / dự án (mặc định 'default'). Dùng để lọc recall. */
  wing: string;
  /** Room: chủ đề trong wing (mặc định 'general'). */
  room: string;
  /** Drawer: nhóm con tuỳ ý trong room (optional). */
  drawer?: string;
  /** Tag tự do (vd ['preference', 'project:open-bot']). */
  tags: string[];
  /** Bot sở hữu record ('' = chung, không gắn bot nào). */
  botId: string;
  /** User sở hữu record (vắng/'' = legacy, thuộc user hiện tại). */
  userId?: string;
  /** Thời điểm text được nói/ghi (ISO 8601). */
  createdAt: string;
  /** Session đã sinh ra record (khi có). */
  sessionId?: string;
  /** Chỉ số turn trong session (khi có). */
  turnIndex?: number;
  /** Vector embedding đã chuẩn hoá L2 (optional — record chưa embed). */
  embedding?: number[];
  /** Model embedding đã dùng cho vector trên (để phát hiện lỗi thời). */
  embeddingModel?: string;
  /** SHA-256 của text đã chuẩn hoá — dùng để dedup. */
  hash: string;
}

/** Input khi lưu một record mới (id/hash/createdAt do store sinh). */
export interface SaveVerbatimInput {
  text: string;
  source?: VerbatimSource;
  wing?: string;
  room?: string;
  drawer?: string;
  tags?: string[];
  botId?: string;
  userId?: string;
  sessionId?: string;
  turnIndex?: number;
  /** Thời điểm ghi đè (mặc định: bây giờ). */
  createdAt?: string;
}

/** Bộ lọc metadata cho list/search. */
export interface VerbatimFilter {
  wing?: string;
  room?: string;
  drawer?: string;
  /** Lọc theo tag (record phải có ÍT NHẤT MỘT tag trong danh sách). */
  tags?: string[];
  source?: VerbatimSource;
  botId?: string;
  userId?: string;
  sessionId?: string;
  /** Chỉ record tạo từ thời điểm này trở đi (ISO). */
  from?: string;
  /** Chỉ record tạo tới thời điểm này (ISO). */
  to?: string;
}

/** Tuỳ chọn phân trang cho list. */
export interface VerbatimListOptions {
  filter?: VerbatimFilter;
  /** Số record tối đa (mặc định 50, tối đa 1000). */
  limit?: number;
  /** Bỏ qua N record đầu (phân trang). */
  offset?: number;
  /** Mới nhất trước (mặc định) hay cũ nhất trước. */
  order?: 'newest' | 'oldest';
}

/** Một hit của recall, kèm điểm và lý do xếp hạng. */
export interface VerbatimRecallHit {
  record: VerbatimRecord;
  /** Điểm fusion cuối cùng (0..1, cao hơn = liên quan hơn). */
  score: number;
  /** Điểm BM25 thô (chưa chuẩn hoá) — để debug/giải thích. */
  keywordScore: number;
  /** Cosine similarity query–record (vắng khi không có vector). */
  semanticScore?: number;
}

/** Lý do recall phải fallback về từ khoá. */
export type VerbatimFallbackReason =
  | 'no-embedder'
  | 'no-vectors'
  | 'embed-failed'
  | 'no-match-above-threshold';

/** Kết quả recall. */
export interface VerbatimRecallResult {
  hits: VerbatimRecallHit[];
  /** true khi kết quả đến từ fallback từ khoá (không phải ngữ nghĩa). */
  usedFallback: boolean;
  /** Lý do fallback (vắng khi không fallback). */
  fallbackReason?: VerbatimFallbackReason;
  /** Tổng số record ứng viên sau lọc metadata (trước khi xếp hạng). */
  candidates: number;
}

/** Tuỳ chọn recall. */
export interface VerbatimRecallOptions {
  /** Số hit tối đa (mặc định 10, tối đa 50). */
  limit?: number;
  filter?: VerbatimFilter;
  /** Bộ embedder (vd OllamaEmbeddings); vắng = BM25 thuần. */
  embedder?: VerbatimEmbedder;
  /** Ngưỡng cosine tối thiểu (mặc định 0.3). */
  minSimilarity?: number;
  /** Trọng số ngữ nghĩa trong fusion (mặc định 0.6). */
  semanticWeight?: number;
  /** Bật/tắt boost recency (mặc định bật, nhẹ). */
  recencyBoost?: boolean;
  /** Embed query bằng model nào (để ghi chú, không bắt buộc). */
  embeddingModel?: string;
}

/** Giao diện tối thiểu của một bộ embedder (khớp `Embedder` ở ../embeddings). */
export interface VerbatimEmbedder {
  embed(text: string): Promise<number[]>;
  embedBatch?(texts: string[]): Promise<number[][]>;
  isAvailable?(): Promise<boolean>;
}

/** Thống kê của store — dùng cho UI + MCP `memory.stats`. */
export interface VerbatimStats {
  /** Tổng số record. */
  total: number;
  /** Số record đã có embedding. */
  embedded: number;
  /** Số wing khác nhau. */
  wings: number;
  /** Số room khác nhau. */
  rooms: number;
  /** Số record theo từng source. */
  bySource: Record<string, number>;
  /** Số record theo từng wing (top 20). */
  byWing: Record<string, number>;
  /** Backend đang dùng ('sqlite' | 'jsonl' | tên backend cắm thêm). */
  backend: string;
  /** Model embedding của các vector đã lưu (vắng = chưa embed). */
  embeddingModel?: string;
  /** Số chiều vector (khi có vector). */
  embeddingDims?: number;
  /** Record mới nhất (ISO, vắng khi store rỗng). */
  newestAt?: string;
  /** Record cũ nhất (ISO, vắng khi store rỗng). */
  oldestAt?: string;
}

/**
 * Interface backend lưu trữ — HẸP và ỔN ĐỊNH để sau này cắm thêm
 * Chroma / Qdrant / pgvector mà không đổi API của store.
 *
 * Quy ước:
 * - Backend chỉ làm CRUD + list + đếm. Nó KHÔNG chấm điểm recall
 *   (BM25/cosine do recall engine làm trên record đã load), nên
 *   backend mới chỉ cần đọc/ghi đúng record.
 * - `insert` upsert theo `id` (ghi đè record cùng id).
 * - `list` trả theo thứ tự `order` (mặc định mới nhất trước).
 * - Mọi phương thức đồng bộ hay bất đồng bộ đều được (interface dùng
 *   Promise để backend remote sau này vẫn khớp).
 */
export interface VerbatimBackend {
  /** Tên backend (vd 'sqlite', 'jsonl', 'chroma'). */
  readonly kind: string;
  insert(record: VerbatimRecord): Promise<void>;
  get(id: string): Promise<VerbatimRecord | undefined>;
  list(filter: VerbatimFilter, opts: { limit: number; offset: number; order: 'newest' | 'oldest' }): Promise<VerbatimRecord[]>;
  delete(id: string): Promise<boolean>;
  count(filter: VerbatimFilter): Promise<number>;
  /** Toàn bộ id (để backfill embedding, migration). */
  allIds(): Promise<string[]>;
  /** Số record đã có embedding (để stats nhanh, không cần load hết). */
  countEmbedded(): Promise<number>;
  close(): Promise<void>;
}

/** Kết quả lưu: record đã lưu + có phải record mới không. */
export interface VerbatimSaveResult {
  record: VerbatimRecord;
  /** false khi text đã tồn tại (dedup theo hash) — trả record cũ. */
  created: boolean;
  /** true khi record đã tồn tại nhưng được cập nhật metadata. */
  updated?: boolean;
}

/** Chuẩn hoá text để hash/dedup và so khớp: chữ thường, gộp khoảng trắng. */
export function normalizeVerbatimText(text: string): string {
  return (text ?? '').trim().replace(/\s+/g, ' ');
}

/** SHA-256 hex của text đã chuẩn hoá (kèm wing/room để cùng text ở chỗ khác nhau không dedup lẫn nhau). */
export function verbatimHash(text: string, wing = '', room = ''): string {
  return createHash('sha256')
    .update(`${wing}\u0000${room}\u0000${normalizeVerbatimText(text)}`, 'utf8')
    .digest('hex');
}

/** Chuẩn hoá wing/room/drawer: rỗng → mặc định, bỏ khoảng trắng thừa, tối đa 80 ký tự. */
export function normalizeVerbatimSlot(value: string | undefined, fallback: string): string {
  const v = (value ?? '').trim().replace(/\s+/g, ' ');
  return v === '' ? fallback : v.slice(0, 80);
}

/** Chuẩn hoá tag: chữ thường, bỏ dấu câu thừa, tối đa 40 ký tự. */
export function normalizeVerbatimTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9à-ỹđ_-]/gi, '').slice(0, 40);
}

/** Record có khớp filter metadata không (dùng chung cho backend JSONL + test). */
export function verbatimMatchesFilter(record: VerbatimRecord, filter: VerbatimFilter = {}): boolean {
  if (filter.wing !== undefined && record.wing !== filter.wing) return false;
  if (filter.room !== undefined && record.room !== filter.room) return false;
  if (filter.drawer !== undefined && record.drawer !== filter.drawer) return false;
  if (filter.source !== undefined && record.source !== filter.source) return false;
  if (filter.botId !== undefined && record.botId !== filter.botId) return false;
  if (filter.userId !== undefined && (record.userId ?? '') !== filter.userId) return false;
  if (filter.sessionId !== undefined && record.sessionId !== filter.sessionId) return false;
  if (filter.tags !== undefined && filter.tags.length > 0) {
    const wanted = new Set(filter.tags.map((t) => t.toLowerCase()));
    if (!record.tags.some((t) => wanted.has(t.toLowerCase()))) return false;
  }
  if (filter.from !== undefined && record.createdAt < filter.from) return false;
  if (filter.to !== undefined && record.createdAt > filter.to) return false;
  return true;
}

/** Bản public của record: KHÔNG kèm vector embedding (đưa ra UI/MCP/model). */
export function publicVerbatimRecord(record: VerbatimRecord): Omit<VerbatimRecord, 'embedding'> {
  const { embedding: _embedding, ...rest } = record;
  void _embedding;
  return rest;
}
