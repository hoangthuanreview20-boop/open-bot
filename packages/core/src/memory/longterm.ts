/**
 * Bộ nhớ dài hạn (v0.7) — memories, tóm tắt ngữ cảnh theo team,
 * transcript lưu trữ.
 *
 * ROADMAP §2c: "Bộ nhớ dài hạn: memories, tóm tắt ngữ cảnh theo team,
 * transcript lưu trữ".
 *
 * LỰA CHỌN LƯU TRỮ (ghi rõ): memories KHÔNG nằm trong SQLite của
 * BotMemory — `BotMemory.db` là `private`, không expose, và task cấm
 * sửa `memory.ts` nên không thể thêm bảng `longterm_memories` vào DB
 * đó một cách sạch sẽ. Thay vào đó memories lưu thành file JSON
 * `<workspace>/.open-bot/memories.json` (ghi atomic qua temp + rename,
 * mode 0600) — đủ bền cho local-first, đọc/ghi đồng bộ như BotMemory.
 * Nếu sau này BotMemory expose DB hoặc thêm bảng, có thể migrate file
 * này sang SQLite mà không đổi API của class.
 *
 * Mỗi memory: key, value, tags, độ tin cậy (confidence 0..1), botId
 * (bot nào ghi nhớ — rỗng = nhớ chung), createdAt/updatedAt.
 * `recall` tìm theo từ khoá (key + value + tags) và/hoặc tag, xếp hạng
 * theo số từ khoá khớp × confidence.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BotMemory } from '../agent/memory';
import { cosineSimilarity, normalizeVector } from './embeddings';
import type { Embedder } from './embeddings';

export const MEMORIES_REL_PATH = path.join('.open-bot', 'memories.json');
export const TEAM_CONTEXT_REL_DIR = path.join('.open-bot', 'team-context');
export const TRANSCRIPTS_REL_DIR = path.join('.open-bot', 'transcripts');
/**
 * Ngưỡng cosine similarity mặc định cho recall ngữ nghĩa (P1-9).
 * `nomic-embed-text` cho text liên quan thường ≥ 0.5, không liên quan
 * thường < 0.3 — 0.3 giữ lại kết quả hơi liên quan mà vẫn lọc nhiễu.
 */
export const DEFAULT_SEMANTIC_MIN_SIMILARITY = 0.3;
/** Text tối đa (ký tự) đưa vào embedding cho một memory (key + value + tags). */
export const MEMORY_EMBED_MAX_CHARS = 8000;

export interface LongTermMemoryEntry {
  id: string;
  key: string;
  value: string;
  tags: string[];
  /** Độ tin cậy 0..1 (mặc định 0.8). */
  confidence: number;
  /** Bot ghi nhớ ('' = nhớ chung, không gắn bot nào). */
  botId: string;
  /**
   * v0.95d4: user sở hữu memory này (userId ổn định trong
   * `<userData>/profile.json`). Vắng/'' = legacy — memory ghi trước
   * khi có scope user, được coi là thuộc user hiện tại (máy local
   * một user; xem `matchesUserScope`). Memory của user khác (userId
   * khác, không rỗng) không bao giờ lọt vào recall của user này.
   */
  userId?: string;
  /**
   * Vector embedding ĐÃ chuẩn hoá L2 của memory (P1-9, optional để
   * tương thích ngược: file cũ chưa có vector thì field vắng, recall
   * ngữ nghĩa coi như chưa embed và fallback về tìm kiếm từ khoá).
   * Vector lỗi thời (đổi value, đổi model embedding) bị xoá để
   * backfill embed lại, không dùng vector sai để xếp hạng.
   */
  embedding?: number[];
  createdAt: string;
  updatedAt: string;
}

interface MemoriesFile {
  version: 1;
  entries: LongTermMemoryEntry[];
  /**
   * Model embedding đã dùng cho các vector trong file (P1-9). Vắng =
   * chưa embed entry nào. Khi model đổi, vector cũ bị coi là lỗi thời
   * (recall ngữ nghĩa fallback về từ khoá, backfill embed lại).
   */
  embeddingModel?: string;
  /** Số chiều vector (để phát hiện vector lệch dims). */
  embeddingDims?: number;
}

/**
 * Text đưa vào embedding cho một memory: key + value (+ tags).
 * Dùng chung cho `rememberWithEmbedding` và `backfillEmbeddings` để
 * query và memory được embed cùng một dạng text.
 */
export function memoryEmbeddingText(entry: { key: string; value: string; tags?: string[] }): string {
  const tags = (entry.tags ?? []).filter(Boolean);
  const text = `${entry.key}: ${entry.value}${tags.length > 0 ? ` [${tags.join(', ')}]` : ''}`;
  return text.slice(0, MEMORY_EMBED_MAX_CHARS);
}

export interface SemanticRecallHit {
  entry: LongTermMemoryEntry;
  /** Cosine similarity query–memory (1 = giống hệt); fallback từ khoá thì là điểm từ khoá × confidence. */
  score: number;
}

export type SemanticFallbackReason =
  | 'no-embedder'
  | 'no-vectors'
  | 'embed-failed'
  | 'no-match-above-threshold';

export interface SemanticRecallResult {
  hits: SemanticRecallHit[];
  /** `true` khi kết quả đến từ fallback tìm kiếm từ khoá (không phải ngữ nghĩa). */
  usedFallback: boolean;
  /** Lý do fallback (vắng khi không fallback). */
  fallbackReason?: SemanticFallbackReason;
}

export interface SemanticRecallOptions {
  /** Bộ embedder (vd `OllamaEmbeddings`); thiếu thì fallback về từ khoá. */
  embedder?: Embedder;
  /** Ngưỡng cosine tối thiểu (mặc định `DEFAULT_SEMANTIC_MIN_SIMILARITY` = 0.3). */
  minSimilarity?: number;
  /** Chỉ recall trong phạm vi bot này (mặc định: mọi bot + nhớ chung). */
  botId?: string;
  /**
   * v0.95d4: khi `botId` được đặt, kèm cả memory chung (botId '') —
   * turn của một bot vẫn thấy memory chung của user. Mặc định false
   * (giữ hành vi cũ: chỉ đúng bot đó).
   */
  includeShared?: boolean;
  /**
   * v0.95d4: chỉ recall memory của user này. Memory legacy chưa gắn
   * user (userId vắng/'') vẫn được tính là của user hiện tại; memory
   * gắn userId khác thì loại. Vắng = mọi user (dùng cho UI quản trị /
   * export toàn bộ).
   */
  userId?: string;
  /** Chỉ recall memory có tag này. */
  tag?: string;
  /** Số kết quả tối đa (mặc định 10, tối đa 200 — khớp `recall`). */
  limit?: number;
  /**
   * Khi `true`: embed trước các entry chưa có vector rồi mới tìm
   * (ghi vector xuống file để lần sau khỏi embed lại). Embed lỗi ở
   * entry nào thì bỏ entry đó, không fail cả lần recall.
   */
  backfill?: boolean;
}

export interface RememberWithEmbeddingResult {
  entry: LongTermMemoryEntry;
  /** `true` khi vector đã lưu cùng entry. */
  embedded: boolean;
  /** Lý do không embed được (chỉ khi `embedded` là `false`). */
  error?: string;
}

export interface BackfillResult {
  /** Số entry vừa được embed và lưu vector. */
  embedded: number;
  /** Số entry đã có vector hợp lệ từ trước (không cần embed lại). */
  skipped: number;
  /** Số entry embed lỗi (bỏ qua, không có vector). */
  failed: number;
  /** Tổng số entry trong phạm vi backfill. */
  total: number;
}

function clampConfidence(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0.8;
  return Math.min(1, Math.max(0, value));
}

/**
 * v0.95d4 — scope user: entry thuộc user này khi userId trùng, hoặc
 * khi entry chưa gắn user (legacy, coi là của user hiện tại). Filter
 * vắng = không lọc theo user.
 */
export function matchesUserScope(entry: LongTermMemoryEntry, userId?: string): boolean {
  if (userId === undefined) return true;
  const owner = entry.userId ?? '';
  return owner === '' || owner === userId;
}

/** v0.95d4 — scope bot: đúng bot, hoặc (khi includeShared) memory chung. */
export function matchesBotScope(
  entry: LongTermMemoryEntry,
  botId?: string,
  includeShared = false,
): boolean {
  if (botId === undefined) return true;
  return entry.botId === botId || (includeShared && entry.botId === '');
}

/** Lọc một danh sách entry theo scope user/bot (dùng chung recall/list). */
function applyScope(
  entries: LongTermMemoryEntry[],
  scope: { botId?: string; includeShared?: boolean; userId?: string },
): LongTermMemoryEntry[] {
  return entries.filter(
    (e) => matchesUserScope(e, scope.userId) && matchesBotScope(e, scope.botId, scope.includeShared ?? false),
  );
}

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return matches ? [...new Set(matches.filter((t) => t.length >= 2))] : [];
}

export class LongTermMemory {
  private readonly filePath: string;
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.filePath = path.join(workspaceDir, MEMORIES_REL_PATH);
  }

  /** Thư mục workspace mà store này thuộc về. */
  get dir(): string {
    return this.workspaceDir;
  }

  /**
   * Đọc toàn bộ file memories (kèm metadata embedding). File chưa có →
   * file rỗng. File cũ (chưa có `embeddingModel`/`embeddingDims`, entry
   * chưa có `embedding`) vẫn đọc được — các field mới đều optional.
   */
  private readFile(): MemoriesFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, entries: [] };
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Long-term memories file is not valid JSON: ${MEMORIES_REL_PATH}`);
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as MemoriesFile).version !== 1 ||
      !Array.isArray((parsed as MemoriesFile).entries)
    ) {
      throw new Error(`Long-term memories file has an unsupported shape: ${MEMORIES_REL_PATH}`);
    }
    const file = parsed as MemoriesFile;
    // Chỉ giữ metadata embedding khi hợp lệ (model là chuỗi, dims là số > 0).
    const out: MemoriesFile = { version: 1, entries: file.entries };
    if (typeof file.embeddingModel === 'string' && file.embeddingModel.trim() !== '') {
      out.embeddingModel = file.embeddingModel;
    }
    if (typeof file.embeddingDims === 'number' && Number.isFinite(file.embeddingDims) && file.embeddingDims > 0) {
      out.embeddingDims = Math.floor(file.embeddingDims);
    }
    return out;
  }

  private load(): LongTermMemoryEntry[] {
    return this.readFile().entries;
  }

  private writeFile(file: MemoriesFile): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  private save(entries: LongTermMemoryEntry[]): void {
    // Giữ nguyên metadata embedding của file hiện tại (nếu có) để một
    // lần `remember`/`forget` không xoá mất thông tin model/dims.
    let meta: { embeddingModel?: string; embeddingDims?: number } = {};
    try {
      const current = this.readFile();
      if (current.embeddingModel !== undefined) meta.embeddingModel = current.embeddingModel;
      if (current.embeddingDims !== undefined) meta.embeddingDims = current.embeddingDims;
    } catch {
      // File hỏng thì `save` vẫn ghi đè bằng entries mới (không giữ meta).
    }
    this.writeFile({ version: 1, entries, ...meta });
  }

  /** Model của bộ embedder (nếu nó công khai `.model`, như `OllamaEmbeddings`). */
  private static embedderModel(embedder: Embedder): string | undefined {
    const model = (embedder as { model?: unknown }).model;
    return typeof model === 'string' && model.trim() !== '' ? model : undefined;
  }

  /** Vector trong entry có dùng được với model/dims hiện tại của file không. */
  private static hasUsableVector(
    entry: LongTermMemoryEntry,
    file: MemoriesFile,
  ): entry is LongTermMemoryEntry & { embedding: number[] } {
    const v = entry.embedding;
    if (!Array.isArray(v) || v.length === 0) return false;
    if (!v.every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
    if (file.embeddingDims !== undefined && v.length !== file.embeddingDims) return false;
    return true;
  }

  /**
   * Ghi nhớ một fact/preference. Cùng (userId, botId, key) thì ghi đè
   * value (giữ id + createdAt cũ). Trả về entry đã lưu.
   */
  remember(input: {
    key: string;
    value: string;
    tags?: string[];
    confidence?: number;
    botId?: string;
    /** v0.95d4: user sở hữu memory (vắng = legacy, chưa gắn user). */
    userId?: string;
  }): LongTermMemoryEntry {
    if (!input.key || !input.key.trim()) throw new Error('Memory key must not be empty.');
    if (!input.value || !input.value.trim()) throw new Error('Memory value must not be empty.');
    const botId = input.botId ?? '';
    const userId = (input.userId ?? '').trim();
    const tags = [...new Set((input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))];
    const entries = this.load();
    const now = new Date().toISOString();
    const existing = entries.find(
      (e) => (e.userId ?? '') === userId && e.botId === botId && e.key === input.key,
    );
    if (existing) {
      existing.value = input.value;
      existing.tags = tags;
      existing.confidence = clampConfidence(input.confidence ?? existing.confidence);
      existing.updatedAt = now;
      if (userId !== '') existing.userId = userId;
      // Value đổi thì vector cũ lỗi thời (embed của text cũ) — xoá để
      // backfill/`rememberWithEmbedding` embed lại, không dùng vector sai.
      delete existing.embedding;
      this.save(entries);
      return { ...existing };
    }
    const entry: LongTermMemoryEntry = {
      id: randomUUID(),
      key: input.key,
      value: input.value,
      tags,
      confidence: clampConfidence(input.confidence),
      botId,
      ...(userId !== '' ? { userId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    entries.push(entry);
    this.save(entries);
    return { ...entry };
  }

  /**
   * Tìm memories theo từ khoá (trong key/value/tags) và/hoặc tag.
   * Không có query/tag thì trả toàn bộ (mới nhất trước). Xếp hạng theo
   * số từ khoá khớp × confidence. `botId` + `includeShared` (v0.95d4)
   * lấy cả memory chung; `userId` lọc theo user sở hữu (legacy chưa
   * gắn user vẫn tính là của user hiện tại).
   */
  recall(
    filter: {
      query?: string;
      tag?: string;
      botId?: string;
      includeShared?: boolean;
      userId?: string;
      limit?: number;
    } = {},
  ): LongTermMemoryEntry[] {
    let entries = applyScope(this.load(), filter);
    if (filter.tag !== undefined) {
      const tag = filter.tag.trim().toLowerCase();
      entries = entries.filter((e) => e.tags.includes(tag));
    }
    const query = (filter.query ?? '').trim();
    if (query) {
      entries = LongTermMemory.keywordHits(entries, query).map((s) => s.entry);
    } else {
      entries = [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    const limit = filter.limit !== undefined ? Math.min(Math.max(Math.floor(filter.limit), 1), 200) : 50;
    return entries.slice(0, limit).map((e) => ({ ...e }));
  }

  /**
   * Chấm điểm từ khoá cho một danh sách entry (dùng chung cho `recall`
   * và cho fallback của `recallSemantic`): số từ khoá khớp × confidence.
   */
  private static keywordHits(
    entries: LongTermMemoryEntry[],
    query: string,
  ): Array<{ entry: LongTermMemoryEntry; hits: number; score: number }> {
    const terms = tokenize(query);
    return entries
      .map((e) => {
        const haystack = `${e.key} ${e.value} ${e.tags.join(' ')}`.toLowerCase();
        const hits = terms.filter((t) => haystack.includes(t)).length;
        return { entry: e, hits, score: hits * e.confidence };
      })
      .filter((s) => s.hits > 0)
      .sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt));
  }

  /**
   * Ghi nhớ kèm vector embedding (P1-9): `remember()` rồi embed
   * `key: value [tags]` và lưu vector vào entry. Embed lỗi (Ollama
   * chưa chạy / model chưa pull) thì memory vẫn được lưu, chỉ không có
   * vector — trả `embedded: false` + lý do để caller báo rõ, không throw.
   */
  async rememberWithEmbedding(
    input: {
      key: string;
      value: string;
      tags?: string[];
      confidence?: number;
      botId?: string;
      userId?: string;
    },
    embedder: Embedder,
  ): Promise<RememberWithEmbeddingResult> {
    const entry = this.remember(input);
    try {
      const vector = normalizeVector(await embedder.embed(memoryEmbeddingText(entry)));
      const file = this.readFile();
      const target = file.entries.find((e) => e.id === entry.id);
      if (!target) return { entry, embedded: false, error: 'Memory vừa ghi không còn trong file.' };
      target.embedding = vector;
      const model = LongTermMemory.embedderModel(embedder);
      if (model !== undefined) file.embeddingModel = model;
      file.embeddingDims = vector.length;
      this.writeFile(file);
      return { entry: { ...target }, embedded: true };
    } catch (err) {
      return { entry, embedded: false, error: (err as Error).message };
    }
  }

  /**
   * Embed lại mọi entry chưa có vector hợp lệ (P1-9, migration cho dữ
   * liệu cũ): entry đã có vector đúng model/dims thì bỏ qua; entry
   * embed lỗi thì bỏ qua (đếm vào `failed`), không fail cả đợt.
   * Vector được chuẩn hoá L2 trước khi lưu nên cosine = tích vô hướng.
   */
  async backfillEmbeddings(
    embedder: Embedder,
    opts: { botId?: string; includeShared?: boolean; userId?: string } = {},
  ): Promise<BackfillResult> {
    const file = this.readFile();
    const model = LongTermMemory.embedderModel(embedder);
    // Vector cũ của model khác bị coi là lỗi thời: embed lại toàn bộ.
    const modelChanged =
      model !== undefined && file.embeddingModel !== undefined && file.embeddingModel !== model;
    let entries = applyScope(file.entries, opts);
    const total = entries.length;
    let skipped = 0;
    let failed = 0;
    let embedded = 0;
    const missing: LongTermMemoryEntry[] = [];
    for (const entry of entries) {
      if (!modelChanged && LongTermMemory.hasUsableVector(entry, file)) skipped += 1;
      else missing.push(entry);
    }
    if (missing.length > 0) {
      const vectors = await this.embedEntriesBestEffort(embedder, missing);
      for (let i = 0; i < missing.length; i++) {
        const vector = vectors[i];
        if (vector === undefined) {
          failed += 1;
          continue;
        }
        missing[i]!.embedding = vector;
        embedded += 1;
      }
      if (embedded > 0) {
        if (model !== undefined) file.embeddingModel = model;
        file.embeddingDims = vectors.find((v) => v !== undefined)?.length ?? file.embeddingDims;
        this.writeFile(file);
      }
    }
    return { embedded, skipped, failed, total };
  }

  /**
   * Embed nhiều entry, best-effort: thử `embedBatch` trước (nhanh),
   * lỗi thì thử từng entry một; entry nào vẫn lỗi thì `undefined`.
   */
  private async embedEntriesBestEffort(
    embedder: Embedder,
    entries: LongTermMemoryEntry[],
  ): Promise<Array<number[] | undefined>> {
    const texts = entries.map((e) => memoryEmbeddingText(e));
    if (typeof embedder.embedBatch === 'function') {
      try {
        const batch = await embedder.embedBatch(texts);
        return batch.map((v) => {
          try {
            return normalizeVector(v);
          } catch {
            return undefined;
          }
        });
      } catch {
        // Rớt xuống embed từng entry.
      }
    }
    const out: Array<number[] | undefined> = [];
    for (const text of texts) {
      try {
        out.push(normalizeVector(await embedder.embed(text)));
      } catch {
        out.push(undefined);
      }
    }
    return out;
  }

  /**
   * Recall theo ngữ nghĩa (P1-9): embed query, xếp hạng các memory đã
   * có vector theo cosine similarity, chỉ giữ ≥ `minSimilarity`
   * (mặc định 0.3). Fallback về tìm kiếm từ khoá (có ghi rõ lý do) khi:
   * không có embedder, không có memory nào có vector hợp lệ, embed
   * query lỗi, hoặc không có memory nào vượt ngưỡng. Fallback KHÔNG
   * lặng lẽ — `usedFallback` + `fallbackReason` luôn đi kèm kết quả.
   *
   * Với `backfill: true`, các memory chưa có vector được embed trước
   * (best-effort, lưu xuống file) rồi mới tìm — để một lần recall
   * semantic hoạt động được ngay cả với dữ liệu cũ chưa có vector.
   */
  async recallSemantic(
    query: string,
    opts: SemanticRecallOptions = {},
  ): Promise<SemanticRecallResult> {
    const limit =
      opts.limit !== undefined ? Math.min(Math.max(Math.floor(opts.limit), 1), 200) : 10;
    const minSimilarity = opts.minSimilarity ?? DEFAULT_SEMANTIC_MIN_SIMILARITY;
    let entries = applyScope(this.load(), opts);
    if (opts.tag !== undefined) {
      const tag = opts.tag.trim().toLowerCase();
      entries = entries.filter((e) => e.tags.includes(tag));
    }
    // Không có entry nào trong phạm vi thì không có gì để fallback —
    // trả rỗng, không tính là fallback (để caller gộp nhiều phạm vi
    // không bị báo fallback chỉ vì một phạm vi trống).
    if (entries.length === 0) return { hits: [], usedFallback: false };
    const keywordFallback = (reason: SemanticFallbackReason): SemanticRecallResult => {
      const hits = LongTermMemory.keywordHits(entries, query)
        .slice(0, limit)
        .map((s) => ({ entry: { ...s.entry }, score: s.score }));
      return { hits, usedFallback: true, fallbackReason: reason };
    };
    const trimmedQuery = (query ?? '').trim();
    if (!trimmedQuery) {
      // Không có query thì ngữ nghĩa vô nghĩa — trả mới nhất trước như `recall`.
      return {
        hits: [...entries]
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, limit)
          .map((e) => ({ entry: { ...e }, score: 0 })),
        usedFallback: true,
      };
    }
    const embedder = opts.embedder;
    if (!embedder) return keywordFallback('no-embedder');
    const model = LongTermMemory.embedderModel(embedder);
    if (opts.backfill) {
      const scope: { botId?: string; includeShared?: boolean; userId?: string } = {};
      if (opts.botId !== undefined) {
        scope.botId = opts.botId;
        scope.includeShared = opts.includeShared;
      }
      if (opts.userId !== undefined) scope.userId = opts.userId;
      await this.backfillEmbeddings(embedder, scope);
    }
    // Đọc lại file sau backfill (vector mới đã lưu) rồi mới xét vector
    // nào còn dùng được — model đổi thì vector cũ lỗi thời, backfill
    // đã embed lại bằng model mới nên file mới là chuẩn để so.
    const fresh = this.readFile();
    const modelChanged =
      model !== undefined && fresh.embeddingModel !== undefined && fresh.embeddingModel !== model;
    const usable = entries.filter((e) => {
      const current = fresh.entries.find((x) => x.id === e.id) ?? e;
      return !modelChanged && LongTermMemory.hasUsableVector(current, fresh);
    });
    if (usable.length === 0) return keywordFallback('no-vectors');
    let queryVector: number[];
    try {
      queryVector = normalizeVector(await embedder.embed(trimmedQuery));
    } catch {
      return keywordFallback('embed-failed');
    }
    const dims = fresh.embeddingDims ?? usable[0]!.embedding!.length;
    if (queryVector.length !== dims) return keywordFallback('embed-failed');
    const scored: SemanticRecallHit[] = [];
    for (const entry of usable) {
      const current = fresh.entries.find((x) => x.id === entry.id) ?? entry;
      const vector = current.embedding!;
      const score = cosineSimilarity(queryVector, vector);
      if (score >= minSimilarity) scored.push({ entry: { ...current }, score });
    }
    scored.sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt));
    if (scored.length === 0) return keywordFallback('no-match-above-threshold');
    return { hits: scored.slice(0, limit), usedFallback: false };
  }

  /** Liệt kê toàn bộ memories (mới nhất trước). */
  list(botId?: string, userId?: string): LongTermMemoryEntry[] {
    return this.recall({ botId, ...(userId !== undefined ? { userId } : {}), limit: 200 });
  }

  /**
   * v0.95d4: sửa một memory theo id (UI quản lý memory). Chỉ value /
   * tags / confidence được sửa (key/botId/userId giữ nguyên — đổi key
   * là tạo memory mới qua `remember`). Value đổi thì vector cũ bị xoá
   * (embed lại khi cần, như `remember`). Trả entry đã sửa, null khi
   * không tìm thấy id.
   */
  updateEntry(
    id: string,
    patch: { value?: string; tags?: string[]; confidence?: number },
  ): LongTermMemoryEntry | null {
    if (typeof patch !== 'object' || patch === null) {
      throw new Error('Memory patch must be an object.');
    }
    if (patch.value !== undefined && (!patch.value.trim())) {
      throw new Error('Memory value must not be empty.');
    }
    if (patch.tags !== undefined && !Array.isArray(patch.tags)) {
      throw new Error('Memory tags must be an array of strings.');
    }
    const entries = this.load();
    const target = entries.find((e) => e.id === id);
    if (!target) return null;
    let valueChanged = false;
    if (patch.value !== undefined && patch.value !== target.value) {
      target.value = patch.value;
      valueChanged = true;
    }
    if (patch.tags !== undefined) {
      target.tags = [...new Set(patch.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
    }
    if (patch.confidence !== undefined) {
      target.confidence = clampConfidence(patch.confidence);
    }
    target.updatedAt = new Date().toISOString();
    if (valueChanged) delete target.embedding;
    this.save(entries);
    return { ...target };
  }

  /**
   * v0.95d4: xoá một memory theo id (UI quản lý memory). Trả true khi
   * đã xoá, false khi không có id đó.
   */
  forgetById(id: string): boolean {
    const entries = this.load();
    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    entries.splice(idx, 1);
    this.save(entries);
    return true;
  }

  /**
   * v0.95d4: xuất memories thành JSON (UI nút Export; KHÔNG kèm vector
   * embedding — file export chỉ có nội dung đọc được). Lọc theo scope
   * user/bot như `recall` (vắng = toàn bộ).
   */
  exportMemories(scope: { botId?: string; includeShared?: boolean; userId?: string } = {}): string {
    const entries = applyScope(this.load(), scope).map((e) => {
      const { embedding: _embedding, ...rest } = e;
      void _embedding;
      return rest;
    });
    return JSON.stringify(
      {
        version: 1,
        exportedAt: new Date().toISOString(),
        count: entries.length,
        entries,
      },
      null,
      2,
    );
  }

  /**
   * Quên một memory theo key (trong phạm vi botId; '' = nhớ chung).
   * Trả true khi đã xoá, false khi không có. v0.95d4: thêm `userId`
   * (vắng = khớp mọi user — giữ hành vi cũ cho caller chưa truyền).
   */
  forget(key: string, botId = '', userId?: string): boolean {
    const entries = this.load();
    const idx = entries.findIndex(
      (e) =>
        e.botId === botId &&
        e.key === key &&
        (userId === undefined || (e.userId ?? '') === userId || (e.userId ?? '') === ''),
    );
    if (idx === -1) return false;
    entries.splice(idx, 1);
    this.save(entries);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Team context summary
// ---------------------------------------------------------------------------

export interface TeamContextSummaryOptions {
  workspaceDir: string;
  /** Id các bot trong team cần tóm tắt. */
  botIds: string[];
  /** Tên team (dùng đặt tên file). Mặc định 'team'. */
  teamId?: string;
  /** BotMemory để lấy task/hội thoại gần đây (không bắt buộc). */
  memory?: BotMemory;
  /** Số memory tối đa đưa vào tóm tắt (mặc định 20). */
  maxMemories?: number;
}

export interface TeamContextSummaryResult {
  /** Đường dẫn file tóm tắt đã lưu. */
  path: string;
  content: string;
  memoryCount: number;
  botCount: number;
}

/**
 * Tóm tắt ngữ cảnh theo team: memories (toàn team + từng bot) + task
 * gần đây + dòng hội thoại gần nhất của các bot trong team. Lưu thành
 * file markdown `.open-bot/team-context/<teamId>-<yyyy-mm-dd>.md`.
 * Tóm tắt ở đây là trích chọn (không gọi model).
 */
export function teamContextSummary(opts: TeamContextSummaryOptions): TeamContextSummaryResult {
  const teamId = opts.teamId ?? 'team';
  const store = new LongTermMemory(opts.workspaceDir);
  const maxMemories = opts.maxMemories ?? 20;
  const memories = store
    .list()
    .filter((e) => e.botId === '' || opts.botIds.includes(e.botId))
    .slice(0, maxMemories);

  const lines: string[] = [];
  lines.push(`# Team context — ${teamId}`);
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Bots: ${opts.botIds.length > 0 ? opts.botIds.join(', ') : '(none)'}`);
  lines.push('');
  lines.push('## Memories');
  if (memories.length === 0) {
    lines.push('(no long-term memories yet)');
  } else {
    for (const m of memories) {
      const scope = m.botId ? `bot ${m.botId}` : 'shared';
      const tags = m.tags.length > 0 ? ` [${m.tags.join(', ')}]` : '';
      lines.push(`- **${m.key}** (${scope}, confidence ${m.confidence.toFixed(2)}): ${m.value}${tags}`);
    }
  }
  lines.push('');
  lines.push('## Recent tasks & activity per bot');
  for (const botId of opts.botIds) {
    lines.push(`### ${botId}`);
    if (!opts.memory) {
      lines.push('(no BotMemory provided — tasks/history skipped)');
      continue;
    }
    const tasks = opts.memory.listTasks(botId).slice(0, 10);
    if (tasks.length === 0) {
      lines.push('- (no tasks)');
    } else {
      for (const t of tasks) {
        lines.push(`- [${t.status}] ${t.title}${t.tags ? ` (${t.tags})` : ''}`);
      }
    }
    const history = opts.memory.getHistory(botId, 5);
    if (history.length > 0) {
      lines.push('- Recent messages:');
      for (const msg of history) {
        const first = msg.content.split('\n')[0]?.slice(0, 160) ?? '';
        lines.push(`  - ${msg.role}: ${first}`);
      }
    }
  }
  const content = lines.join('\n') + '\n';
  const dir = path.join(opts.workspaceDir, TEAM_CONTEXT_REL_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const filePath = path.join(dir, `${teamId}-${date}.md`);
  fs.writeFileSync(filePath, content, 'utf8');
  return { path: filePath, content, memoryCount: memories.length, botCount: opts.botIds.length };
}

// ---------------------------------------------------------------------------
// Transcript archive (JSONL)
// ---------------------------------------------------------------------------

export interface ArchivedMessage {
  index: number;
  botId: string;
  role: string;
  content: string;
  archivedAt: string;
}

export interface ArchiveTranscriptOptions {
  workspaceDir: string;
  botId: string;
  /** BotMemory chứa history (bắt buộc — archive đọc từ memory). */
  memory: BotMemory;
  /** Số message tối đa (mặc định 1000). */
  limit?: number;
}

/**
 * Xuất toàn bộ history của một bot thành file JSONL
 * `.open-bot/transcripts/<botId>-<timestamp>.jsonl` (mỗi dòng một
 * message kèm timestamp). Trả về đường dẫn file + số message.
 */
export function archiveTranscript(opts: ArchiveTranscriptOptions): { path: string; count: number } {
  const limit = opts.limit !== undefined ? Math.min(Math.max(Math.floor(opts.limit), 1), 10000) : 1000;
  const history = opts.memory.getHistory(opts.botId, limit);
  const dir = path.join(opts.workspaceDir, TRANSCRIPTS_REL_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(dir, `${opts.botId}-${stamp}.jsonl`);
  const archivedAt = new Date().toISOString();
  const lines = history.map((msg, i) =>
    JSON.stringify({
      index: i,
      botId: opts.botId,
      role: msg.role,
      content: msg.content,
      archivedAt,
    } satisfies ArchivedMessage),
  );
  fs.writeFileSync(filePath, lines.length > 0 ? lines.join('\n') + '\n' : '', 'utf8');
  return { path: filePath, count: history.length };
}

/** Nạp lại file JSONL đã archive (bỏ dòng hỏng, không crash). */
export function loadTranscriptArchive(filePath: string): ArchivedMessage[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new Error(`Transcript archive not found: "${filePath}"`);
  }
  const out: ArchivedMessage[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ArchivedMessage;
      if (typeof parsed.content === 'string' && typeof parsed.role === 'string') out.push(parsed);
    } catch {
      // Dòng hỏng — bỏ qua.
    }
  }
  return out;
}

/** Tìm kiếm theo từ khoá trong file JSONL đã archive (không phân biệt hoa/thường). */
export function searchTranscriptArchive(filePath: string, query: string): ArchivedMessage[] {
  const entries = loadTranscriptArchive(filePath);
  const needle = query.toLowerCase();
  if (!needle) return entries;
  return entries.filter((e) => e.content.toLowerCase().includes(needle));
}
