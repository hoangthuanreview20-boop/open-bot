/**
 * TemporalGraphStore — kho đồ thị tri thức theo thời gian (v0.98).
 *
 * Lưu trữ: file JSON `<workspace>/.open-bot/memory-graph.json`,
 * ghi atomic (temp + rename, mode 0600) như MemoryBlockStore và
 * LongTermMemory — đủ bền cho local-first, không cần SQLite.
 *
 * Mọi ghi đều giữ bất biến bi-temporal:
 *  - Fact mới: validFrom = lúc ghi (hoặc lúc fact nói tới), validUntil
 *    = null, status `active`.
 *  - Fact bị thay thế: KHÔNG xoá — đóng validUntil = lúc thay thế,
 *    status `superseded`, supersededBy = id fact mới; fact mới ghi
 *    supersedes = id fact cũ.
 *  - Fact bị xoá: status `deleted`, validUntil = lúc xoá (vẫn truy
 *    vấn được lịch sử).
 *
 * Scope: mọi thao tác đọc đều có thể lọc theo userId/botId/runId;
 * fact của scope khác không bao giờ lọt ra ngoài trừ khi gọi tường
 * minh với `includeOtherScopes: true` (chỉ dùng cho share/admin).
 *
 * Quarantine: fact nghi ngờ nằm riêng trong `quarantine`, chưa bao
 * giờ xuất hiện trong search/neighbourhood cho tới khi user duyệt
 * (approve → thành fact active; reject → đánh dấu rejected, giữ lại
 * để audit).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  FactProvenance,
  GraphBackend,
  GraphEntity,
  GraphFact,
  GraphFile,
  GraphShare,
  MemoryScope,
  QuarantineItem,
  QuarantineReason,
} from './types';
import { normalizeGraphText } from './types';

export const MEMORY_GRAPH_REL_PATH = path.join('.open-bot', 'memory-graph.json');
export const MEMORY_GRAPH_RUNS_REL_PATH = path.join('.open-bot', 'memory-graph-runs.jsonl');
/** Độ dài tối đa của text episode khi ingest (ký tự). */
export const MAX_EPISODE_TEXT_CHARS = 8000;
/** Độ dài tối đa của sourceText trong provenance (ký tự). */
export const MAX_SOURCE_TEXT_CHARS = 500;
/** Số episode tối đa trong một file đồ thị (chặn file phình vô hạn). */
export const MAX_EPISODES = 5000;
/** Số fact tối đa trong một file đồ thị. */
export const MAX_FACTS = 20000;

export class GraphStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphStoreError';
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptyFile(): GraphFile {
  const now = nowIso();
  return {
    version: 1,
    entities: [],
    facts: [],
    episodes: [],
    quarantine: [],
    shares: {},
    createdAt: now,
    updatedAt: now,
  };
}

/** Backend file JSON mặc định — ghi atomic qua temp + rename. */
export class FileGraphBackend implements GraphBackend {
  constructor(private readonly filePath: string) {}

  load(): GraphFile | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new GraphStoreError(`Không đọc được file đồ thị: ${(err as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new GraphStoreError('File đồ thị bị hỏng (không phải JSON hợp lệ).');
    }
    if (typeof parsed !== 'object' || parsed === null || (parsed as { version?: unknown }).version !== 1) {
      throw new GraphStoreError('File đồ thị không đúng định dạng (version phải là 1).');
    }
    const file = parsed as GraphFile;
    return {
      ...emptyFile(),
      ...file,
      entities: Array.isArray(file.entities) ? file.entities : [],
      facts: Array.isArray(file.facts) ? file.facts : [],
      episodes: Array.isArray(file.episodes) ? file.episodes : [],
      quarantine: Array.isArray(file.quarantine) ? file.quarantine : [],
      shares: typeof file.shares === 'object' && file.shares !== null ? file.shares : {},
    };
  }

  save(file: GraphFile): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Trên Windows chmod có thể không áp dụng được — file đã ghi xong.
    }
  }
}

/** Backend bộ nhớ — dùng cho test và cho memory2 ghép sau này. */
export class InMemoryGraphBackend implements GraphBackend {
  private file: GraphFile | null = null;

  load(): GraphFile | null {
    return this.file === null ? null : JSON.parse(JSON.stringify(this.file)) as GraphFile;
  }

  save(file: GraphFile): void {
    this.file = JSON.parse(JSON.stringify(file)) as GraphFile;
  }
}

export interface AddFactInput {
  subjectName: string;
  kind?: GraphEntity['kind'];
  predicate: string;
  objectText: string;
  /** Tân ngữ là entity (để nối objectId) hay text tự do. */
  objectIsEntity?: boolean;
  objectKind?: GraphEntity['kind'];
  confidence?: number;
  scope: MemoryScope;
  provenance: FactProvenance;
  validFrom?: string;
  embedding?: number[];
}

export interface ScopeFilter {
  userId?: string;
  botId?: string;
  runId?: string;
  /** v1.02 (memory v3): filter by app scope. */
  appId?: string;
  /** true = bỏ qua lọc scope (chỉ dùng cho share/admin). */
  includeOtherScopes?: boolean;
}

export function matchesScope(scope: MemoryScope, filter: ScopeFilter): boolean {
  if (filter.includeOtherScopes === true) return true;
  if (filter.userId !== undefined && filter.userId !== '' && scope.userId !== '' && scope.userId !== filter.userId) {
    return false;
  }
  if (filter.botId !== undefined && filter.botId !== '' && scope.botId !== '' && scope.botId !== filter.botId) {
    return false;
  }
  if (filter.runId !== undefined && filter.runId !== '' && scope.runId !== '' && scope.runId !== filter.runId) {
    return false;
  }
  // v1.02 (memory v3): app scope follows the same "empty matches
  // everything" rule as the other scope fields.
  if (filter.appId !== undefined && filter.appId !== '' && (scope.appId ?? '') !== '' && scope.appId !== filter.appId) {
    return false;
  }
  return true;
}

/**
 * Kho đồ thị. Mọi phương thức đọc đều đồng bộ (file JSON local đã
 * load sẵn trong bộ nhớ); `save()` ghi xuống đĩa sau mỗi lần đổi.
 * Instance giữ một bản snapshot trong bộ nhớ — tạo một instance cho
 * mỗi workspace, không dùng chung giữa các bot khác workspace.
 */
export class TemporalGraphStore {
  private file: GraphFile;
  private readonly backend: GraphBackend;
  /** true = store chỉ đọc (graph được share read-only). */
  readonly readOnly: boolean;

  constructor(backend: GraphBackend, opts: { readOnly?: boolean } = {}) {
    this.backend = backend;
    this.readOnly = opts.readOnly === true;
    this.file = backend.load() ?? emptyFile();
  }

  /** Tạo store từ thư mục workspace của một bot. */
  static fromWorkspace(workspaceDir: string, opts: { readOnly?: boolean } = {}): TemporalGraphStore {
    return new TemporalGraphStore(
      new FileGraphBackend(path.join(workspaceDir, MEMORY_GRAPH_REL_PATH)),
      opts,
    );
  }

  private assertWritable(): void {
    if (this.readOnly) {
      throw new GraphStoreError('Đồ thị này được share ở chế độ chỉ đọc — không ghi được.');
    }
  }

  private persist(): void {
    this.file.updatedAt = nowIso();
    this.recountFacts();
    this.backend.save(this.file);
  }

  private recountFacts(): void {
    const counts = new Map<string, number>();
    for (const fact of this.file.facts) {
      if (fact.status !== 'active') continue;
      counts.set(fact.subjectId, (counts.get(fact.subjectId) ?? 0) + 1);
      if (fact.objectId) counts.set(fact.objectId, (counts.get(fact.objectId) ?? 0) + 1);
    }
    for (const entity of this.file.entities) {
      entity.factCount = counts.get(entity.id) ?? 0;
    }
  }

  /** Số liệu tổng quan (đếm theo scope nếu truyền filter). */
  stats(filter: ScopeFilter = {}): {
    entities: number;
    facts: number;
    activeFacts: number;
    episodes: number;
    unprocessedEpisodes: number;
    pendingQuarantine: number;
  } {
    const facts = this.file.facts.filter((f) => matchesScope(f.scope, filter));
    return {
      entities: this.file.entities.length,
      facts: facts.length,
      activeFacts: facts.filter((f) => f.status === 'active').length,
      episodes: this.file.episodes.filter((e) => matchesScope(e, filter)).length,
      unprocessedEpisodes: this.file.episodes.filter((e) => !e.processed && matchesScope(e, filter)).length,
      pendingQuarantine: this.file.quarantine.filter(
        (q) => q.status === 'pending' && matchesScope(q.scope, filter),
      ).length,
    };
  }

  // ---- Entities -------------------------------------------------------

  /** Tìm entity theo tên đã chuẩn hoá (kèm alias). */
  findEntityByName(name: string): GraphEntity | undefined {
    const norm = normalizeGraphText(name);
    if (norm === '') return undefined;
    return this.file.entities.find(
      (e) => normalizeGraphText(e.name) === norm || e.aliases.some((a) => normalizeGraphText(a) === norm),
    );
  }

  getEntity(id: string): GraphEntity | undefined {
    return this.file.entities.find((e) => e.id === id);
  }

  listEntities(filter: ScopeFilter = {}): GraphEntity[] {
    void filter;
    return [...this.file.entities];
  }

  /** Lấy hoặc tạo entity (idempotent theo tên chuẩn hoá). */
  ensureEntity(name: string, kind: GraphEntity['kind'] = 'other'): GraphEntity {
    const trimmed = (name ?? '').trim();
    if (trimmed === '') throw new GraphStoreError('Tên entity không được rỗng.');
    const existing = this.findEntityByName(trimmed);
    if (existing) {
      existing.lastSeenAt = nowIso();
      return existing;
    }
    this.assertWritable();
    const now = nowIso();
    const entity: GraphEntity = {
      id: randomUUID(),
      name: trimmed.slice(0, 200),
      kind,
      aliases: [],
      firstSeenAt: now,
      lastSeenAt: now,
      factCount: 0,
    };
    this.file.entities.push(entity);
    return entity;
  }

  addAlias(entityId: string, alias: string): GraphEntity {
    this.assertWritable();
    const entity = this.getEntity(entityId);
    if (!entity) throw new GraphStoreError('Không tìm thấy entity.');
    const clean = (alias ?? '').trim().slice(0, 200);
    if (clean === '' || normalizeGraphText(clean) === normalizeGraphText(entity.name)) return entity;
    if (!entity.aliases.some((a) => normalizeGraphText(a) === normalizeGraphText(clean))) {
      entity.aliases.push(clean);
      entity.lastSeenAt = nowIso();
      this.persist();
    }
    return entity;
  }

  // ---- Episodes -------------------------------------------------------

  /** Ghi một episode (turn hội thoại) vào đồ thị. */
  ingestEpisode(input: {
    turnId: string;
    runId: string;
    botId: string;
    userId: string;
    role: string;
    text: string;
  }): { id: string; duplicate: boolean } {
    this.assertWritable();
    const text = (input.text ?? '').slice(0, MAX_EPISODE_TEXT_CHARS);
    if (text.trim() === '') throw new GraphStoreError('Nội dung episode không được rỗng.');
    const turnId = (input.turnId ?? '').trim();
    if (turnId !== '') {
      const dup = this.file.episodes.find((e) => e.turnId === turnId && e.botId === input.botId);
      if (dup) return { id: dup.id, duplicate: true };
    }
    if (this.file.episodes.length >= MAX_EPISODES) {
      // Xoá episode cũ nhất ĐÃ xử lý để giữ trần (fact vẫn còn).
      const idx = this.file.episodes.findIndex((e) => e.processed);
      if (idx >= 0) this.file.episodes.splice(idx, 1);
      else throw new GraphStoreError('Kho episode đã đầy (5000) và chưa có episode nào xử lý xong để dọn.');
    }
    const episode = {
      id: randomUUID(),
      turnId,
      runId: input.runId ?? '',
      botId: input.botId ?? '',
      userId: input.userId ?? '',
      role: input.role ?? 'user',
      text,
      factIds: [] as string[],
      processed: false,
      createdAt: nowIso(),
    };
    this.file.episodes.push(episode);
    this.persist();
    return { id: episode.id, duplicate: false };
  }

  getEpisode(id: string) {
    return this.file.episodes.find((e) => e.id === id);
  }

  listUnprocessedEpisodes(filter: ScopeFilter = {}, limit = 50): typeof this.file.episodes {
    return this.file.episodes
      .filter((e) => !e.processed && matchesScope(e, filter))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, Math.max(1, Math.min(500, limit)));
  }

  markEpisodeProcessed(episodeId: string, factIds: string[]): void {
    this.assertWritable();
    const episode = this.getEpisode(episodeId);
    if (!episode) throw new GraphStoreError('Không tìm thấy episode.');
    episode.processed = true;
    episode.factIds = [...new Set([...episode.factIds, ...factIds])];
    this.persist();
  }

  // ---- Facts ----------------------------------------------------------

  getFact(id: string): GraphFact | undefined {
    return this.file.facts.find((f) => f.id === id);
  }

  /** Fact active có cùng (subject, predicate) — dùng để UPDATE/DELETE. */
  findActiveFacts(subjectName: string, predicate: string, filter: ScopeFilter = {}): GraphFact[] {
    const entity = this.findEntityByName(subjectName);
    if (!entity) return [];
    const pred = normalizeGraphText(predicate).replace(/\s+/g, '_');
    return this.file.facts.filter(
      (f) => f.status === 'active' && f.subjectId === entity.id && f.predicate === pred && matchesScope(f.scope, filter),
    );
  }

  listFacts(filter: ScopeFilter & { status?: GraphFact['status']; predicate?: string; limit?: number } = {}): GraphFact[] {
    const pred = filter.predicate ? normalizeGraphText(filter.predicate).replace(/\s+/g, '_') : undefined;
    return this.file.facts
      .filter((f) => matchesScope(f.scope, filter))
      .filter((f) => (filter.status ? f.status === filter.status : true))
      .filter((f) => (pred ? f.predicate === pred : true))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, filter.limit ?? 500);
  }

  /** Thêm một fact active mới (luôn qua consolidate — xem consolidateGraph.ts). */
  addFact(input: AddFactInput): GraphFact {
    this.assertWritable();
    const predicate = normalizeGraphText(input.predicate).replace(/\s+/g, '_');
    if (predicate === '') throw new GraphStoreError('Predicate không được rỗng.');
    const objectText = (input.objectText ?? '').trim();
    if (objectText === '') throw new GraphStoreError('Object của fact không được rỗng.');
    if (this.file.facts.length >= MAX_FACTS) {
      throw new GraphStoreError('Kho fact đã đầy (20000) — hãy xoá fact cũ hoặc archive.');
    }
    const subject = this.ensureEntity(input.subjectName, input.kind ?? 'other');
    let objectId: string | undefined;
    if (input.objectIsEntity === true) {
      objectId = this.ensureEntity(objectText, input.objectKind ?? 'other').id;
    }
    const provenance: FactProvenance = {
      ...input.provenance,
      sourceText: (input.provenance.sourceText ?? '').slice(0, MAX_SOURCE_TEXT_CHARS),
    };
    const now = nowIso();
    const fact: GraphFact = {
      id: randomUUID(),
      subjectId: subject.id,
      predicate,
      ...(objectId ? { objectId } : {}),
      objectText: objectText.slice(0, 1000),
      validFrom: input.validFrom ?? now,
      validUntil: null,
      confidence: clampConfidence(input.confidence ?? 0.8),
      status: 'active',
      scope: { ...input.scope },
      provenance,
      ...(input.embedding ? { embedding: input.embedding } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.file.facts.push(fact);
    this.persist();
    return fact;
  }

  /**
   * Thay thế fact cũ bằng fact mới: đóng cửa sổ hiệu lực của bản cũ,
   * nối supersession hai chiều. Trả về fact mới đã tạo.
   */
  supersedeFact(oldFactId: string, input: AddFactInput): GraphFact {
    this.assertWritable();
    const oldFact = this.getFact(oldFactId);
    if (!oldFact) throw new GraphStoreError('Không tìm thấy fact cần thay thế.');
    if (oldFact.status !== 'active') throw new GraphStoreError('Chỉ thay thế được fact đang active.');
    const now = nowIso();
    const created = this.addFact({ ...input, validFrom: now });
    oldFact.status = 'superseded';
    oldFact.validUntil = now;
    oldFact.supersededBy = created.id;
    oldFact.updatedAt = now;
    created.supersedes = oldFact.id;
    created.updatedAt = now;
    this.persist();
    return created;
  }

  /** Xoá mềm một fact: đóng cửa sổ, status `deleted` (vẫn xem lại được). */
  deleteFact(factId: string, actor: string): GraphFact {
    this.assertWritable();
    const fact = this.getFact(factId);
    if (!fact) throw new GraphStoreError('Không tìm thấy fact.');
    void actor;
    const now = nowIso();
    fact.status = 'deleted';
    fact.validUntil = now;
    fact.updatedAt = now;
    this.persist();
    return fact;
  }

  /** Ghi vector embedding cho một fact (dùng cho backfill sau search). */
  setFactEmbedding(factId: string, embedding: number[]): void {
    this.assertWritable();
    const fact = this.getFact(factId);
    if (!fact) throw new GraphStoreError('Không tìm thấy fact.');
    fact.embedding = [...embedding];
    fact.updatedAt = nowIso();
    this.persist();
  }

  /**
   * Set a fact's confidence (v1.02, memory v3 sleep maintenance:
   * promotion boosts confidence of repeatedly-referenced facts).
   * Value is clamped to 0..1. Returns the updated fact.
   */
  setFactConfidence(factId: string, confidence: number): GraphFact {
    this.assertWritable();
    const fact = this.getFact(factId);
    if (!fact) throw new GraphStoreError('Không tìm thấy fact.');
    fact.confidence = clampConfidence(confidence);
    fact.updatedAt = nowIso();
    this.persist();
    return fact;
  }

  /**
   * Merge duplicate facts into one keeper (v1.02, memory v3 sleep
   * maintenance): each duplicate is closed as `superseded` pointing
   * at the keeper via `supersededBy` (history stays queryable), the
   * keeper itself is untouched. Returns the ids actually merged.
   */
  mergeFacts(keepId: string, duplicateIds: string[], actor: string): string[] {
    this.assertWritable();
    void actor;
    const keep = this.getFact(keepId);
    if (!keep) throw new GraphStoreError('Không tìm thấy fact cần giữ.');
    if (keep.status !== 'active') throw new GraphStoreError('Chỉ gộp vào fact đang active.');
    const now = nowIso();
    const merged: string[] = [];
    for (const dupId of [...new Set(duplicateIds)]) {
      if (dupId === keepId) continue;
      const dup = this.getFact(dupId);
      if (!dup || dup.status !== 'active') continue;
      dup.status = 'superseded';
      dup.validUntil = now;
      dup.supersededBy = keepId;
      dup.updatedAt = now;
      merged.push(dupId);
    }
    if (merged.length > 0) this.persist();
    return merged;
  }

  /**
   * Lịch sử của một fact: đi ngược chuỗi `supersedes` tới bản gốc,
   * rồi đi xuôi theo `supersededBy` tới bản mới nhất — thứ tự xác
   * định theo chuỗi thay thế, không phụ thuộc timestamp (nhiều fact
   * có thể cùng millisecond).
   */
  factHistory(factId: string): GraphFact[] {
    const start = this.getFact(factId);
    if (!start) return [];
    // Thu thập mọi fact trong chuỗi thay thế.
    const related = new Map<string, GraphFact>();
    const seen = new Set<string>();
    let current: GraphFact | undefined = start;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      related.set(current.id, current);
      current = current.supersedes ? this.getFact(current.supersedes) : undefined;
    }
    let next = this.file.facts.find((f) => f.supersedes === factId);
    while (next && !seen.has(next.id)) {
      seen.add(next.id);
      related.set(next.id, next);
      next = this.file.facts.find((f) => f.supersedes === next?.id);
    }
    // Bản gốc = fact trong chuỗi không thay thế fact nào khác.
    let root = [...related.values()].find((f) => !f.supersedes || !related.has(f.supersedes));
    if (!root) root = start;
    // Đi xuôi từ gốc.
    const ordered: GraphFact[] = [];
    const walked = new Set<string>();
    let node: GraphFact | undefined = root;
    while (node && !walked.has(node.id)) {
      walked.add(node.id);
      ordered.push(node);
      node = node.supersededBy ? related.get(node.supersededBy) : undefined;
    }
    // Phòng hờ: fact nào còn sót (chuỗi rẽ nhánh) thì thêm cuối theo createdAt.
    for (const fact of [...related.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (!walked.has(fact.id)) ordered.push(fact);
    }
    return ordered;
  }

  /** Hàng xóm 1 hop của một entity (fact active nối tới nó). */
  neighbours(entityId: string, filter: ScopeFilter = {}, limit = 50): GraphFact[] {
    return this.file.facts
      .filter((f) => f.status === 'active' && matchesScope(f.scope, filter))
      .filter((f) => f.subjectId === entityId || f.objectId === entityId)
      .slice(0, Math.max(1, Math.min(200, limit)));
  }

  // ---- Quarantine -----------------------------------------------------

  listQuarantine(filter: ScopeFilter & { status?: QuarantineItem['status'] } = {}): QuarantineItem[] {
    return this.file.quarantine
      .filter((q) => matchesScope(q.scope, filter))
      .filter((q) => (filter.status ? q.status === filter.status : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  addToQuarantine(input: {
    candidate: QuarantineItem['candidate'];
    reason: QuarantineReason;
    detail: string;
    conflictingFactId?: string;
    scope: MemoryScope;
    provenance: FactProvenance;
  }): QuarantineItem {
    this.assertWritable();
    const item: QuarantineItem = {
      id: randomUUID(),
      candidate: { ...input.candidate },
      reason: input.reason,
      detail: input.detail.slice(0, 1000),
      ...(input.conflictingFactId ? { conflictingFactId: input.conflictingFactId } : {}),
      scope: { ...input.scope },
      provenance: {
        ...input.provenance,
        sourceText: (input.provenance.sourceText ?? '').slice(0, MAX_SOURCE_TEXT_CHARS),
      },
      status: 'pending',
      createdAt: nowIso(),
    };
    this.file.quarantine.push(item);
    this.persist();
    return item;
  }

  /**
   * User duyệt quarantine: approve → fact ứng viên thành fact active
   * (mâu thuẫn cũ nếu có sẽ bị supersede); reject → chỉ đánh dấu,
   * giữ lại để audit, không bao giờ vào đồ thị.
   */
  reviewQuarantine(
    id: string,
    decision: 'approved' | 'rejected',
    reviewedBy: string,
  ): { item: QuarantineItem; fact?: GraphFact } {
    this.assertWritable();
    const item = this.file.quarantine.find((q) => q.id === id);
    if (!item) throw new GraphStoreError('Không tìm thấy mục quarantine.');
    if (item.status !== 'pending') throw new GraphStoreError('Mục này đã được duyệt trước đó.');
    item.status = decision;
    item.reviewedBy = reviewedBy;
    item.reviewedAt = nowIso();
    let fact: GraphFact | undefined;
    if (decision === 'approved') {
      if (item.conflictingFactId) {
        const oldFact = this.getFact(item.conflictingFactId);
        if (oldFact && oldFact.status === 'active') {
          fact = this.supersedeFact(item.conflictingFactId, {
            subjectName: item.candidate.subjectName,
            predicate: item.candidate.predicate,
            objectText: item.candidate.objectText,
            confidence: item.candidate.confidence,
            scope: item.scope,
            provenance: item.provenance,
          });
        }
      }
      if (!fact) {
        fact = this.addFact({
          subjectName: item.candidate.subjectName,
          predicate: item.candidate.predicate,
          objectText: item.candidate.objectText,
          confidence: item.candidate.confidence,
          scope: item.scope,
          provenance: item.provenance,
        });
      }
    }
    this.persist();
    return { item, ...(fact ? { fact } : {}) };
  }

  // ---- Share ----------------------------------------------------------

  listShares(): GraphShare[] {
    return Object.values(this.file.shares).sort((a, b) => a.sharedAt.localeCompare(b.sharedAt));
  }

  share(targetBotId: string, readOnly: boolean, sharedBy: string): GraphShare {
    this.assertWritable();
    const target = (targetBotId ?? '').trim();
    if (target === '') throw new GraphStoreError('targetBotId không được rỗng.');
    const share: GraphShare = { targetBotId: target, readOnly, sharedAt: nowIso(), sharedBy };
    this.file.shares[target] = share;
    this.persist();
    return share;
  }

  unshare(targetBotId: string): boolean {
    this.assertWritable();
    if (!(targetBotId in this.file.shares)) return false;
    delete this.file.shares[targetBotId];
    this.persist();
    return true;
  }

  getShare(targetBotId: string): GraphShare | undefined {
    return this.file.shares[targetBotId];
  }

  /** Export toàn bộ file (để backup / đồng bộ qua port memory2). */
  exportFile(): GraphFile {
    return JSON.parse(JSON.stringify(this.file)) as GraphFile;
  }
}

export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.8;
  return Math.min(1, Math.max(0, value));
}
