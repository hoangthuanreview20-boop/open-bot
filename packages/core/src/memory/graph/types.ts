/**
 * Temporal Knowledge Graph — kiểu dữ liệu (v0.98, Đội T1).
 *
 * Ý tưởng học từ Zep/Graphiti (đồ thị tri thức theo thời gian) và
 * Mem0 v3 (pipeline extraction → consolidation) nhưng tự thiết kế lại
 * hoàn toàn cho open-bot, chạy 100% local, lưu file JSON trong
 * workspace của bot.
 *
 * Mô hình dữ liệu — 3 tầng:
 *  1. Episode: một turn hội thoại (user hoặc assistant) đã ghi lại.
 *     Episode là NGUỒN DUY NHẤT của mọi fact: không có fact nào tồn
 *     tại mà không trỏ về episode đã sinh ra nó (provenance).
 *  2. Entity: một thực thể được nhắc tới (người, nơi, món ăn, sở
 *     thích, công cụ, ...). Entity chỉ là "cái tên" + alias, không
 *     mang fact.
 *  3. Relation (fact): một khẳng định `subject —predicate→ object`
 *     với cửa sổ hiệu lực BI-TEMPORAL:
 *       - validFrom / validUntil: fact ĐÚNG trong khoảng nào của thế
 *         giới thật (vd "sống ở Hà Nội" từ 2020 tới 2026-11).
 *       - createdAt / updatedAt: fact được GHI vào đồ thị lúc nào.
 *     Khi fact bị thay thế (vd chuyển nhà), bản cũ KHÔNG bị xoá:
 *     nó được đóng cửa sổ (validUntil = lúc thay thế), chuyển trạng
 *     thái `superseded`, và trỏ `supersededBy` sang fact mới. Lịch sử
 *     vì vậy vẫn truy vấn được ("trước đây sống ở đâu?").
 *
 * Scope: mọi episode/fact đều mang userId + botId (agentId) +
 * runId. Fact của user/bot khác không bao giờ lọt vào search của
 * scope này trừ khi được share tường minh (xem share.ts).
 *
 * Phòng chống memory poisoning (OWASP ASI06): fact mâu thuẫn với
 * fact cũ có confidence cao, hoặc khớp mẫu nghi ngờ (lệnh "quên
 * hết", "bỏ qua hướng dẫn trước", ...), KHÔNG được áp dụng tự động
 * mà vào quarantine để user duyệt (xem consolidateGraph.ts).
 *
 * Tách lớp cho memory2 (v0.97, chưa lên main): store này chỉ phụ
 * thuộc vào interface `GraphBackend` (load/save thô) và các kiểu dữ
 * liệu thuần dưới đây. Khi memory2 lên main, nó có thể implement
 * `GraphBackend` (vd backend SQLite) hoặc dùng `GraphMemoryPort`
 * để đồng bộ fact hai chiều mà không cần sửa engine này.
 */

/** Scope of a fact/episode: who — which bot — which run — which app. */
export interface MemoryScope {
  /** Owning user ('' = legacy, belongs to the current user). */
  userId: string;
  /** Bot (agent) that recorded it ('' = shared, not bound to a bot). */
  botId: string;
  /** Run that produced the episode ('' = unknown run). */
  runId: string;
  /**
   * App scope (v1.02, memory v3): the application / workspace the
   * memory belongs to ('' = no app scope, visible everywhere).
   * Scope hierarchy for retrieval is run ⊂ agent ⊂ user ⊂ app:
   * a query at run level also sees agent, user and app memories.
   */
  appId?: string;
}

/** Nguồn gốc của một fact — bắt buộc, không có fact "mồ côi". */
export interface FactProvenance {
  /** Episode đã sinh ra fact. */
  episodeId: string;
  /** Turn hội thoại trong episode (để UI nhảy tới đúng câu). */
  turnId: string;
  /** Phiên chạy lúc ghi fact. */
  runId: string;
  /** Bot đã ghi fact. */
  botId: string;
  /** User sở hữu fact. */
  userId: string;
  /** Thời điểm ghi (ISO). */
  at: string;
  /** Câu gốc đã rút ra fact (cắt ngắn, tối đa 500 ký tự). */
  sourceText: string;
}

/** Loại thực thể — dùng để lọc và để UI nhóm hiển thị. */
export type EntityKind =
  | 'person'
  | 'place'
  | 'thing'
  | 'preference'
  | 'activity'
  | 'organization'
  | 'other';

/** Một thực thể trong đồ thị. */
export interface GraphEntity {
  id: string;
  /** Tên chuẩn hoá (hiển thị, duy nhất sau khi chuẩn hoá). */
  name: string;
  kind: EntityKind;
  /** Tên gọi khác (vd "HCM" cho "TP. Hồ Chí Minh"). */
  aliases: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  /** Số fact đang trỏ tới entity này (đếm lại khi lưu). */
  factCount: number;
}

/** Trạng thái vòng đời của một fact. */
export type FactStatus =
  | 'active'
  | 'superseded'
  | 'deleted'
  | 'quarantined';

/** Một fact: subject —predicate→ object, có cửa sổ hiệu lực. */
export interface GraphFact {
  id: string;
  /** Id entity chủ ngữ (luôn là entity, không phải text tự do). */
  subjectId: string;
  /** Vị ngữ đã chuẩn hoá (vd `likes`, `lives_in`, `works_at`). */
  predicate: string;
  /** Id entity tân ngữ — có khi tân ngữ là entity. */
  objectId?: string;
  /** Tân ngữ dạng text — dùng khi tân ngữ không phải entity. */
  objectText?: string;
  /** Fact đúng từ lúc nào (ISO, mặc định = createdAt). */
  validFrom: string;
  /** Fact hết đúng lúc nào (null = vẫn đúng tới nay). */
  validUntil: string | null;
  /** Fact này thay thế fact nào (khi UPDATE). */
  supersedes?: string;
  /** Fact này bị fact nào thay thế (khi bị UPDATE). */
  supersededBy?: string;
  /** Độ tin cậy 0..1. */
  confidence: number;
  status: FactStatus;
  /** Scope: user/bot/run nào sở hữu fact. */
  scope: MemoryScope;
  /** Nguồn gốc bắt buộc. */
  provenance: FactProvenance;
  /** Vector embedding L2-chuẩn hoá của text fact (optional). */
  embedding?: number[];
  createdAt: string;
  updatedAt: string;
}

/** Một episode: một turn hội thoại đã ghi lại. */
export interface GraphEpisode {
  id: string;
  /** Turn hội thoại (để nối với transcript/bot memory). */
  turnId: string;
  runId: string;
  botId: string;
  userId: string;
  /** 'user' | 'assistant' | 'system'. */
  role: string;
  /** Nội dung turn (cắt ngắn tối đa 8000 ký tự khi ingest). */
  text: string;
  /** Fact đã rút ra từ episode này. */
  factIds: string[];
  /** true = episode đã qua consolidation (không xét lại). */
  processed: boolean;
  createdAt: string;
}

/** Lý do một fact ứng viên bị đưa vào quarantine. */
export type QuarantineReason =
  | 'conflict'
  | 'contradiction'
  | 'low-confidence'
  | 'suspicious-pattern'
  | 'manual';

/** Một mục quarantine: fact ứng viên chờ user duyệt. */
export interface QuarantineItem {
  id: string;
  /** Fact ứng viên bị giữ lại (chưa vào đồ thị chính). */
  candidate: {
    subjectName: string;
    predicate: string;
    objectText: string;
    confidence: number;
  };
  reason: QuarantineReason;
  /** Chi tiết cho user: fact cũ mâu thuẫn / mẫu nghi ngờ khớp. */
  detail: string;
  /** Id fact cũ mâu thuẫn (nếu có). */
  conflictingFactId?: string;
  scope: MemoryScope;
  provenance: FactProvenance;
  status: 'pending' | 'approved' | 'rejected';
  reviewedBy?: string;
  reviewedAt?: string;
  createdAt: string;
}

/** Cấu hình share của đồ thị này cho một bot khác. */
export interface GraphShare {
  targetBotId: string;
  /** true = bot kia chỉ được đọc, không được ghi/quarantine-review. */
  readOnly: boolean;
  sharedAt: string;
  sharedBy: string;
}

/** Toàn bộ file đồ thị `.open-bot/memory-graph.json`. */
export interface GraphFile {
  version: 1;
  entities: GraphEntity[];
  facts: GraphFact[];
  episodes: GraphEpisode[];
  quarantine: QuarantineItem[];
  /** botId -> cấu hình share. */
  shares: Record<string, GraphShare>;
  /** Model embedding đã dùng cho vector trong file. */
  embeddingModel?: string;
  embeddingDims?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Backend lưu trữ thô mà TemporalGraphStore phụ thuộc — đây là lớp
 * tách để sau này ghép memory2: memory2 chỉ cần implement 2 hàm này
 * (vd backend SQLite, backend mã hoá, backend đồng bộ) là store chạy
 * được mà không đổi một dòng engine.
 */
export interface GraphBackend {
  load(): GraphFile | null;
  save(file: GraphFile): void;
}

/**
 * Port đồng bộ fact hai chiều cho memory2 tương lai: bất kỳ kho
 * memory nào implement port này đều có thể nhận fact đã consolidate
 * từ graph (push) và đẩy fact của nó vào graph (pull) mà không cần
 * biết store lưu ở đâu.
 */
export interface GraphMemoryPort {
  /** Đẩy fact đã consolidate sang kho đích (trả số fact đã nhận). */
  pushFacts(facts: GraphFact[]): Promise<number>;
  /** Kéo fact từ kho đích về (để graph consolidate tiếp). */
  pullFacts(scope: MemoryScope, limit?: number): Promise<GraphFact[]>;
}

/** Kết quả rút fact từ một turn (đầu ra của extractor). */
export interface CandidateFact {
  /** Tên chủ ngữ (chưa resolve thành entity id). */
  subjectName: string;
  kind: EntityKind;
  predicate: string;
  /** Tân ngữ dạng text (chưa resolve thành entity id). */
  objectText: string;
  /** Gợi ý tân ngữ là entity (để resolve nếu có). */
  objectIsEntity: boolean;
  confidence: number;
  /** Câu gốc đã rút ra fact. */
  sourceText: string;
}

/** Quyết định consolidation cho một fact ứng viên. */
export type ConsolidationDecision = 'ADD' | 'UPDATE' | 'DELETE' | 'QUARANTINE' | 'SKIP';

/** Một quyết định đã áp dụng trong một lần consolidate. */
export interface ConsolidationAction {
  decision: ConsolidationDecision;
  candidate: CandidateFact;
  /** Fact đã tạo / đã thay thế / đã xoá (nếu có). */
  factId?: string;
  /** Fact cũ bị supersede (khi UPDATE) hoặc bị xoá (khi DELETE). */
  affectedFactId?: string;
  /** Quarantine item đã tạo (khi QUARANTINE). */
  quarantineId?: string;
  reason: string;
}

/** Chuẩn hoá tên entity / text fact để so sánh: chữ thường, bỏ dấu
 *  tiếng Việt, bỏ dấu câu, gộp khoảng trắng. */
export function normalizeGraphText(text: string): string {
  return (text ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Text hiển thị của một fact: `subject —predicate→ object`. */
export function factDisplayText(fact: GraphFact, subjectName: string): string {
  const object = fact.objectText ?? '';
  return `${subjectName} —${fact.predicate}→ ${object}`;
}

/** Text dùng để embed / BM25 cho một fact. */
export function factSearchText(fact: GraphFact, subjectName: string, objectName?: string): string {
  const object = objectName ?? fact.objectText ?? '';
  return `${subjectName} ${fact.predicate.replace(/_/g, ' ')} ${object}`.trim();
}

/** Fact có đang hiệu lực tại một thời điểm không (mặc định: bây giờ). */
export function isFactValidAt(fact: GraphFact, at: Date = new Date()): boolean {
  if (fact.status !== 'active') return false;
  const atMs = at.getTime();
  if (Number.isNaN(atMs)) return false;
  if (Date.parse(fact.validFrom) > atMs) return false;
  if (fact.validUntil !== null && Date.parse(fact.validUntil) <= atMs) return false;
  return true;
}
