/**
 * VerbatimMemoryStore (v1.01, Đội T4).
 *
 * Store chính của tầng verbatim: bọc một `VerbatimBackend` (SQLite
 * mặc định, JSONL fallback, hoặc backend cắm thêm) + recall engine +
 * embedding backfill. API hẹp, đồng nhất cho mọi backend:
 *
 *   save(input)      — lưu record mới (dedup theo hash wing+room+text)
 *   get(id)          — lấy một record
 *   search(query)    — hybrid recall (BM25 + embedding khi có)
 *   list(opts)       — liệt kê / lọc metadata + phân trang
 *   delete(id)       — xoá (hai bước ở UI; store chỉ xoá theo id)
 *   stats()          — thống kê cho UI / MCP
 *   backfillEmbeddings(embedder) — embed các record chưa có vector
 *
 * Quy ước quan trọng:
 * - Text lưu NGUYÊN VĂN: store không bao giờ sửa text (chỉ trim đầu/
 *   cuối khi save). Muốn sửa = xoá + lưu mới.
 * - Dedup: cùng text + cùng wing + cùng room → chỉ một record (trả
 *   record cũ, `created: false`). Khác wing/room thì là record khác.
 * - Embedding: lưu kèm model + dims; khi model đổi, vector cũ bị coi
 *   là lỗi thời (recall bỏ qua, backfill embed lại) — cùng quy ước
 *   với `LongTermMemory`.
 * - Output ra ngoài (UI/MCP/model) KHÔNG bao giờ kèm vector — xem
 *   `publicVerbatimRecord`.
 * - Giới hạn: `maxRecords` (mặc định 50.000) — save vượt giới hạn
 *   throw lỗi rõ ràng, không lặng lẽ xoá record cũ.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeVector } from '../embeddings';
import { hybridRecall, VERBATIM_DEFAULT_MIN_SIMILARITY } from './recall';
import type {
  SaveVerbatimInput,
  VerbatimBackend,
  VerbatimEmbedder,
  VerbatimFilter,
  VerbatimListOptions,
  VerbatimRecallOptions,
  VerbatimRecallResult,
  VerbatimRecord,
  VerbatimSaveResult,
  VerbatimStats,
} from './types';
import {
  normalizeVerbatimSlot,
  normalizeVerbatimTag,
  normalizeVerbatimText,
  publicVerbatimRecord,
  verbatimHash,
} from './types';

export const VERBATIM_DEFAULT_DIR_NAME = 'verbatim';
export const VERBATIM_DEFAULT_MAX_RECORDS = 50_000;
/** Text tối đa mỗi record (ký tự) — dài hơn thì host phải chẻ bằng chunker trước. */
export const VERBATIM_MAX_TEXT_CHARS = 8000;

export interface VerbatimMemoryStoreOptions {
  /** Backend đã mở (bắt buộc — dùng `openVerbatimBackend` để tạo). */
  backend: VerbatimBackend;
  /** Embedder mặc định cho search/backfill (vắng = BM25 thuần). */
  embedder?: VerbatimEmbedder;
  /** Tên model embedding (để ghi vào record khi backfill). */
  embeddingModel?: string;
  /** Giới hạn số record (mặc định 50.000). */
  maxRecords?: number;
  /** Embed ngay khi save (mặc định false — save nhanh, backfill sau). */
  embedOnSave?: boolean;
}

export interface BackfillResult {
  /** Số record đã embed trong lần chạy này. */
  embedded: number;
  /** Số record bỏ qua (đã có vector đúng model). */
  skipped: number;
  /** Số record lỗi embed (ghi log, không throw). */
  failed: number;
  /** Model embedding đã dùng. */
  model: string;
}

export class VerbatimMemoryStore {
  readonly backend: VerbatimBackend;
  private embedder?: VerbatimEmbedder;
  private readonly embeddingModel?: string;
  private readonly maxRecords: number;
  private readonly embedOnSave: boolean;

  constructor(opts: VerbatimMemoryStoreOptions) {
    this.backend = opts.backend;
    this.embedder = opts.embedder;
    this.embeddingModel = opts.embeddingModel;
    this.maxRecords = opts.maxRecords ?? VERBATIM_DEFAULT_MAX_RECORDS;
    this.embedOnSave = opts.embedOnSave ?? false;
  }

  /** Đổi embedder lúc chạy (vd user bật/tắt Ollama trong Settings). */
  setEmbedder(embedder: VerbatimEmbedder | undefined): void {
    this.embedder = embedder;
  }

  /** Backend đang chạy là gì (để stats/UI hiển thị). */
  get backendKind(): string {
    return this.backend.kind;
  }

  /**
   * Lưu một record verbatim. Dedup theo hash (wing+room+text chuẩn hoá):
   * đã tồn tại → trả record cũ với `created: false`.
   */
  async save(input: SaveVerbatimInput): Promise<VerbatimSaveResult> {
    const text = normalizeVerbatimText(input.text);
    if (text === '') throw new Error('Không thể lưu memory rỗng.');
    if (text.length > VERBATIM_MAX_TEXT_CHARS) {
      throw new Error(
        `Text quá dài (${text.length} ký tự, tối đa ${VERBATIM_MAX_TEXT_CHARS}) — hãy chẻ bằng chunker trước khi lưu.`,
      );
    }
    const wing = normalizeVerbatimSlot(input.wing, 'default');
    const room = normalizeVerbatimSlot(input.room, 'general');
    const drawer = input.drawer !== undefined ? normalizeVerbatimSlot(input.drawer, '') : undefined;
    const tags = [...new Set((input.tags ?? []).map(normalizeVerbatimTag).filter((t) => t !== ''))];
    const hash = verbatimHash(text, wing, room);

    // Dedup: backend SQLite có getByHash; JSONL cũng có; backend khác
    // thì fallback quét list theo hash (list + filter tay).
    const existing = await this.findByHash(hash);
    if (existing !== undefined) {
      return { record: existing, created: false };
    }

    const total = await this.backend.count({});
    if (total >= this.maxRecords) {
      throw new Error(
        `Verbatim store đã đầy (${total}/${this.maxRecords} record) — hãy xoá bớt hoặc tăng maxRecords.`,
      );
    }

    const record: VerbatimRecord = {
      id: randomUUID(),
      text,
      source: input.source ?? 'manual',
      wing,
      room,
      tags,
      botId: input.botId ?? '',
      createdAt: input.createdAt ?? new Date().toISOString(),
      hash,
    };
    if (drawer !== undefined && drawer !== '') record.drawer = drawer;
    if (input.userId !== undefined && input.userId !== '') record.userId = input.userId;
    if (input.sessionId !== undefined) record.sessionId = input.sessionId;
    if (input.turnIndex !== undefined) record.turnIndex = input.turnIndex;

    if (this.embedOnSave && this.embedder !== undefined) {
      const embedded = await this.tryEmbed(record);
      if (embedded !== undefined) {
        record.embedding = embedded.vector;
        record.embeddingModel = embedded.model;
      }
    }

    await this.backend.insert(record);
    return { record, created: true };
  }

  /** Lưu nhiều record (bỏ qua record trùng — vẫn đếm trong kết quả). */
  async saveMany(inputs: SaveVerbatimInput[]): Promise<{ created: number; duplicates: number }> {
    let created = 0;
    let duplicates = 0;
    for (const input of inputs) {
      const result = await this.save(input);
      if (result.created) created += 1;
      else duplicates += 1;
    }
    return { created, duplicates };
  }

  async get(id: string): Promise<VerbatimRecord | undefined> {
    return this.backend.get(id);
  }

  /** Bản public của record (không kèm vector) — dùng cho UI/MCP. */
  async getPublic(id: string): Promise<Omit<VerbatimRecord, 'embedding'> | undefined> {
    const record = await this.backend.get(id);
    return record === undefined ? undefined : publicVerbatimRecord(record);
  }

  /**
   * Recall hybrid: lọc metadata → BM25 → embedding (khi có) → fusion.
   * Trả hit kèm điểm; `usedFallback` cho biết có dùng ngữ nghĩa không.
   */
  async search(query: string, opts: VerbatimRecallOptions = {}): Promise<VerbatimRecallResult> {
    const trimmed = (query ?? '').trim();
    if (trimmed === '') return { hits: [], usedFallback: true, fallbackReason: 'no-match-above-threshold', candidates: 0 };
    // Lấy ứng viên: backend list theo filter (giới hạn 5000 để recall
    // trong bộ nhớ không quá nặng — store local lớn hơn nên dùng
    // backend vector; ghi rõ trong candidates khi bị cắt).
    const filter: VerbatimFilter = { ...(opts.filter ?? {}) };
    const candidates = await this.backend.list(filter, { limit: 5000, offset: 0, order: 'newest' });
    return hybridRecall(trimmed, candidates, {
      ...opts,
      embedder: opts.embedder ?? this.embedder,
      embeddingModel: opts.embeddingModel ?? this.embeddingModel,
    });
  }

  /** Liệt kê record (bản public, không kèm vector). */
  async list(opts: VerbatimListOptions = {}): Promise<{ records: Omit<VerbatimRecord, 'embedding'>[]; total: number }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
    const offset = Math.max(opts.offset ?? 0, 0);
    const filter = opts.filter ?? {};
    const [records, total] = await Promise.all([
      this.backend.list(filter, { limit, offset, order: opts.order ?? 'newest' }),
      this.backend.count(filter),
    ]);
    return { records: records.map(publicVerbatimRecord), total };
  }

  async delete(id: string): Promise<boolean> {
    return this.backend.delete(id);
  }

  /**
   * Dọn dẹp: xoá record cũ hơn `olderThanDays` ngày (trừ record có tag
   * trong `keepTags`). Trả số đã xoá. Dùng để kìm dung lượng khi
   * verbatim lưu nhiều text thô — host nên hỏi user trước khi gọi.
   */
  async prune(opts: { olderThanDays: number; keepTags?: string[] }): Promise<number> {
    const cutoff = new Date(Date.now() - opts.olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const keep = new Set((opts.keepTags ?? []).map((t) => t.toLowerCase()));
    const all = await this.backend.list({ to: cutoff }, { limit: 100_000, offset: 0, order: 'oldest' });
    let deleted = 0;
    for (const record of all) {
      if (record.tags.some((t) => keep.has(t.toLowerCase()))) continue;
      if (await this.backend.delete(record.id)) deleted += 1;
    }
    return deleted;
  }

  /** Xoá toàn bộ record khớp filter — trả số đã xoá (dùng cho dọn dẹp có xác nhận). */
  async deleteByFilter(filter: VerbatimFilter): Promise<number> {
    const all = await this.backend.list(filter, { limit: 100_000, offset: 0, order: 'oldest' });
    let deleted = 0;
    for (const record of all) {
      if (await this.backend.delete(record.id)) deleted += 1;
    }
    return deleted;
  }

  async stats(): Promise<VerbatimStats> {
    const total = await this.backend.count({});
    const embedded = await this.backend.countEmbedded();
    const all = total === 0 ? [] : await this.backend.list({}, { limit: 100_000, offset: 0, order: 'oldest' });
    const bySource: Record<string, number> = {};
    const byWing: Record<string, number> = {};
    const wings = new Set<string>();
    const rooms = new Set<string>();
    let embeddingModel: string | undefined;
    let embeddingDims: number | undefined;
    for (const record of all) {
      bySource[record.source] = (bySource[record.source] ?? 0) + 1;
      byWing[record.wing] = (byWing[record.wing] ?? 0) + 1;
      wings.add(record.wing);
      rooms.add(`${record.wing}/${record.room}`);
      if (record.embedding !== undefined && record.embedding.length > 0) {
        embeddingModel = record.embeddingModel ?? embeddingModel;
        embeddingDims = record.embedding.length;
      }
    }
    // Top 20 wing theo số record.
    const topWings = Object.entries(byWing)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);
    const stats: VerbatimStats = {
      total,
      embedded,
      wings: wings.size,
      rooms: rooms.size,
      bySource,
      byWing: Object.fromEntries(topWings),
      backend: this.backend.kind,
      newestAt: all.length > 0 ? all[all.length - 1]?.createdAt : undefined,
      oldestAt: all.length > 0 ? all[0]?.createdAt : undefined,
    };
    if (embeddingModel !== undefined) stats.embeddingModel = embeddingModel;
    if (embeddingDims !== undefined) stats.embeddingDims = embeddingDims;
    return stats;
  }

  /**
   * Embed các record chưa có vector (hoặc vector lỗi thời do đổi
   * model). Chạy theo batch để không spam Ollama; lỗi từng record
   * chỉ ghi log, không dừng cả đợt.
   */
  async backfillEmbeddings(embedder?: VerbatimEmbedder): Promise<BackfillResult> {
    const active = embedder ?? this.embedder;
    if (active === undefined) throw new Error('Cần embedder để backfill (truyền OllamaEmbeddings vào).');
    const available = active.isAvailable === undefined ? true : await active.isAvailable();
    if (!available) throw new Error('Embedder không khả dụng (Ollama chưa chạy?).');
    const model = this.embeddingModel ?? 'nomic-embed-text';
    const ids = await this.backend.allIds();
    let embedded = 0;
    let skipped = 0;
    let failed = 0;
    for (const id of ids) {
      const record = await this.backend.get(id);
      if (record === undefined) continue;
      if (record.embedding !== undefined && record.embedding.length > 0 && record.embeddingModel === model) {
        skipped += 1;
        continue;
      }
      const result = await this.tryEmbed(record, active, model);
      if (result === undefined) {
        failed += 1;
        continue;
      }
      record.embedding = result.vector;
      record.embeddingModel = result.model;
      await this.backend.insert(record);
      embedded += 1;
    }
    return { embedded, skipped, failed, model };
  }

  /** Export toàn bộ record ra file JSON (bản public, không kèm vector mặc định). */
  async exportToFile(filePath: string, opts: { includeEmbeddings?: boolean } = {}): Promise<number> {
    const all = await this.backend.list({}, { limit: 100_000, offset: 0, order: 'oldest' });
    const payload = {
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      backend: this.backend.kind,
      records: opts.includeEmbeddings === true ? all : all.map(publicVerbatimRecord),
    };
    const dir = path.dirname(path.resolve(filePath));
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
    return payload.records.length;
  }

  /** Import record từ file export (dedup theo hash, giữ nguyên id/text). */
  async importFromFile(filePath: string): Promise<{ created: number; duplicates: number; skipped: number }> {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { records?: unknown }).records)) {
      throw new Error('File import không đúng dạng (thiếu mảng `records`).');
    }
    let created = 0;
    let duplicates = 0;
    let skipped = 0;
    for (const item of (parsed as { records: unknown[] }).records) {
      if (typeof item !== 'object' || item === null) {
        skipped += 1;
        continue;
      }
      const r = item as Partial<VerbatimRecord>;
      if (typeof r.text !== 'string' || r.text.trim() === '' || typeof r.hash !== 'string') {
        skipped += 1;
        continue;
      }
      const existing = await this.findByHash(r.hash);
      if (existing !== undefined) {
        duplicates += 1;
        continue;
      }
      const record: VerbatimRecord = {
        id: typeof r.id === 'string' && r.id !== '' ? r.id : randomUUID(),
        text: normalizeVerbatimText(r.text),
        source: (r.source as VerbatimRecord['source']) ?? 'import',
        wing: typeof r.wing === 'string' ? r.wing : 'default',
        room: typeof r.room === 'string' ? r.room : 'general',
        tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : [],
        botId: typeof r.botId === 'string' ? r.botId : '',
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString(),
        hash: r.hash,
      };
      if (typeof r.drawer === 'string') record.drawer = r.drawer;
      if (typeof r.userId === 'string') record.userId = r.userId;
      if (typeof r.sessionId === 'string') record.sessionId = r.sessionId;
      if (typeof r.turnIndex === 'number') record.turnIndex = r.turnIndex;
      await this.backend.insert(record);
      created += 1;
    }
    return { created, duplicates, skipped };
  }

  async close(): Promise<void> {
    await this.backend.close();
  }

  /** Tìm record theo hash — dùng getByHash của backend khi có, fallback quét list. */
  private async findByHash(hash: string): Promise<VerbatimRecord | undefined> {
    const backend = this.backend as VerbatimBackend & { getByHash?: (hash: string) => Promise<VerbatimRecord | undefined> };
    if (typeof backend.getByHash === 'function') return backend.getByHash(hash);
    const all = await this.backend.list({}, { limit: 100_000, offset: 0, order: 'oldest' });
    return all.find((r) => r.hash === hash);
  }

  /** Embed một record — trả undefined khi lỗi (không throw). */
  private async tryEmbed(
    record: VerbatimRecord,
    embedder?: VerbatimEmbedder,
    model?: string,
  ): Promise<{ vector: number[]; model: string } | undefined> {
    const active = embedder ?? this.embedder;
    if (active === undefined) return undefined;
    try {
      const vector = normalizeVector(await active.embed(record.text));
      return { vector, model: model ?? this.embeddingModel ?? 'nomic-embed-text' };
    } catch (err) {
      console.error(`[verbatim] Embed lỗi cho record ${record.id}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }
}

/** Ngưỡng cosine mặc định cho recall (re-export để host dùng chung). */
export { VERBATIM_DEFAULT_MIN_SIMILARITY };
