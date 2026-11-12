/**
 * Semantic search bằng embedding thật (v0.14, item 6) — Ollama local.
 *
 * Thay thế cho tìm kiếm TF-IDF keyword của tool `semantic_search`
 * (packages/tools/src/codeTools.ts: query string + `max_results`
 * mặc định 10, tối đa 20, trả về danh sách xếp hạng kèm score).
 * Helper `semanticSearch` ở đây giữ đúng giao diện đó — `query: string`,
 * `topK` mặc định 10, tối đa 20, trả `[{ id, text, score }]` xếp theo
 * cosine similarity giảm dần — để coordinator có thể thay thế dần
 * TF-IDF bằng embedding thật mà không đổi dạng kết quả.
 *
 * Khác biệt quan trọng: hàm này KHÔNG lặng lẽ fallback về TF-IDF.
 * Khi Ollama không khả dụng, nó throw lỗi tiếng Việt rõ ràng (kèm gợi
 * ý `ollama pull nomic-embed-text` khi model chưa có). Việc fallback
 * là quyết định của coordinator, không phải của module này.
 *
 * Mọi embedding đều chạy local qua Ollama (mặc định
 * http://127.0.0.1:11434, model `nomic-embed-text`); không gọi mạng
 * ngoài, không cần API key. Vector được chuẩn hoá L2 trước khi lưu
 * nên cosine similarity = tích vô hướng.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Ollama local mặc định (khác provider chat: không có hậu tố `/v1`). */
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
/** Model embedding mặc định của Ollama. */
export const DEFAULT_EMBED_MODEL = 'nomic-embed-text';
/** Timeout cho một lần embed (ms). */
export const EMBED_TIMEOUT_MS = 30_000;
/** Timeout cho kiểm tra Ollama có chạy không (ms). */
export const AVAILABILITY_TIMEOUT_MS = 3_000;
/** Tối đa 10.000 item trong một EmbeddingIndex. */
export const MAX_EMBEDDING_ITEMS = 10_000;
/** Tên file lưu index trong thư mục index. */
export const EMBEDDINGS_FILE_NAME = 'embeddings.json';

/** Lỗi embedding — mọi message đều tiếng Việt. */
export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

/** Kiểu hàm fetch có thể inject (mặc định là `fetch` toàn cục). */
export type EmbedFetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Giao diện tối thiểu của một bộ embedder (OllamaEmbeddings khớp nó). */
export interface Embedder {
  embed(text: string): Promise<number[]>;
  embedBatch?(texts: string[]): Promise<number[][]>;
  isAvailable?(): Promise<boolean>;
}

export interface OllamaEmbeddingsOptions {
  /** Base URL Ollama, mặc định http://127.0.0.1:11434. */
  baseUrl?: string;
  /** Model embedding, mặc định `nomic-embed-text`. */
  model?: string;
  /** Fetch inject được (test dùng fake server 127.0.0.1). */
  fetchFn?: EmbedFetchFn;
  /** Timeout cho một lần embed (ms), mặc định 30.000. */
  timeoutMs?: number;
}

/**
 * Client embedding chạy trên Ollama local: POST `/api/embeddings`.
 * Không throw ở `isAvailable()` — trả `false` khi Ollama chưa chạy.
 */
export class OllamaEmbeddings implements Embedder {
  readonly baseUrl: string;
  readonly model: string;
  private readonly fetchFn: EmbedFetchFn;
  private readonly timeoutMs: number;

  constructor(opts: OllamaEmbeddingsOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
    this.model = opts.model ?? DEFAULT_EMBED_MODEL;
    this.fetchFn = opts.fetchFn ?? ((url: string, init?: RequestInit) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? EMBED_TIMEOUT_MS;
  }

  private ollamaDownError(): EmbeddingError {
    return new EmbeddingError(
      `Không kết nối được tới Ollama tại ${this.baseUrl}. ` +
        `Hãy kiểm tra Ollama đã chạy chưa (mặc định chạy ở http://127.0.0.1:11434, lệnh \`ollama serve\`), ` +
        `rồi thử lại.`,
    );
  }

  private modelMissingError(detail: string): EmbeddingError {
    return new EmbeddingError(
      `Ollama chưa có model embedding ${JSON.stringify(this.model)} (${detail}). ` +
        `Hãy chạy \`ollama pull ${this.model}\` để tải model về rồi thử lại.`,
    );
  }

  /**
   * Kiểm tra Ollama có chạy không: GET `/api/tags`, timeout 3 giây.
   * Không bao giờ throw — trả `false` khi không kết nối được.
   */
  async isAvailable(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AVAILABILITY_TIMEOUT_MS);
    try {
      const res = await this.fetchFn(`${this.baseUrl}/api/tags`, { signal: controller.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Embed một đoạn text → vector số thực. */
  async embed(text: string): Promise<number[]> {
    if (typeof text !== 'string' || text.trim() === '') {
      throw new EmbeddingError('Không embed được text rỗng — cần ít nhất một ký tự có nghĩa.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: text }),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new EmbeddingError(
          `Embed text quá ${this.timeoutMs / 1000} giây tại ${this.baseUrl} — Ollama có thể đang quá tải, hãy thử lại.`,
        );
      }
      throw this.ollamaDownError();
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body.error === 'string' && body.error.trim() !== '') detail = body.error.trim();
      } catch {
        try {
          const textBody = (await res.text()).trim();
          if (textBody !== '') detail = textBody.slice(0, 300);
        } catch {
          // Giữ nguyên detail mặc định.
        }
      }
      if (/model .*not found/i.test(detail) || res.status === 404) {
        throw this.modelMissingError(detail);
      }
      throw new EmbeddingError(
        `Ollama trả lỗi khi embed (model ${JSON.stringify(this.model)}): ${detail}.`,
      );
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new EmbeddingError('Ollama trả về JSON không hợp lệ cho /api/embeddings.');
    }
    const embedding = (data as { embedding?: unknown }).embedding;
    if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw new EmbeddingError(
        `Ollama trả về embedding không hợp lệ cho model ${JSON.stringify(this.model)} (cần mảng số không rỗng).`,
      );
    }
    return embedding as number[];
  }

  /** Embed nhiều text (gọi tuần tự để không dồn Ollama local). */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const text of texts) {
      out.push(await this.embed(text));
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------

/** Chuẩn hoá L2 một vector (vector 0 → lỗi, vì không có hướng để so sánh). */
export function normalizeVector(vector: number[]): number[] {
  if (vector.length === 0) {
    throw new EmbeddingError('Không chuẩn hoá được vector rỗng.');
  }
  let sum = 0;
  for (const n of vector) {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new EmbeddingError('Vector chứa giá trị không phải số hữu hạn — không chuẩn hoá được.');
    }
    sum += n * n;
  }
  const norm = Math.sqrt(sum);
  if (norm === 0) {
    throw new EmbeddingError('Không chuẩn hoá được vector 0 (mọi thành phần bằng 0).');
  }
  return vector.map((n) => n / norm);
}

/** Cosine similarity giữa hai vector (cùng độ dài). Vector đã chuẩn hoá thì bằng tích vô hướng. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new EmbeddingError(`Không so sánh được hai vector khác độ dài (${a.length} và ${b.length}).`);
  }
  if (a.length === 0) {
    throw new EmbeddingError('Không so sánh được vector rỗng.');
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

// ---------------------------------------------------------------------------
// EmbeddingIndex — lưu vector trong file JSON local
// ---------------------------------------------------------------------------

export interface EmbeddingItem {
  id: string;
  text: string;
  /** Vector ĐÃ chuẩn hoá L2. */
  vector: number[];
  /** ISO timestamp lần cập nhật cuối. */
  updatedAt: string;
}

export interface EmbeddingIndexFile {
  model: string;
  dims: number;
  items: EmbeddingItem[];
}

export interface EmbeddingIndexOptions {
  /** Thư mục chứa `embeddings.json`. */
  dir: string;
  /** Model ghi vào file index (mặc định `nomic-embed-text`). */
  model?: string;
  /** Bộ embedder dùng khi `add()` không kèm vector. */
  embeddings?: Embedder;
}

export interface EmbeddingSearchOptions {
  /** Số kết quả tối đa (mặc định 10, tối đa 20 — khớp tool TF-IDF). */
  topK?: number;
  /** Hàm embed query (test inject vector fake); mặc định dùng `embeddings` của index. */
  embedFn?: (text: string) => Promise<number[]>;
}

export interface EmbeddingSearchResult {
  id: string;
  text: string;
  /** Cosine similarity (1 = giống hệt, 0 = không liên quan, -1 = ngược nghĩa). */
  score: number;
}

/**
 * Index embedding lưu trong `<dir>/embeddings.json`:
 * `{ model, dims, items: [{ id, text, vector, updatedAt }] }`.
 * Vector được chuẩn hoá trước khi lưu nên cosine = tích vô hướng.
 */
export class EmbeddingIndex {
  readonly dir: string;
  readonly model: string;
  readonly filePath: string;
  private readonly embeddings?: Embedder;
  private items = new Map<string, EmbeddingItem>();
  private dims = 0;

  constructor(opts: EmbeddingIndexOptions) {
    if (!opts.dir || typeof opts.dir !== 'string') {
      throw new EmbeddingError('EmbeddingIndex cần `dir` là thư mục chứa file embeddings.json.');
    }
    this.dir = opts.dir;
    this.model = opts.model ?? DEFAULT_EMBED_MODEL;
    this.filePath = path.join(opts.dir, EMBEDDINGS_FILE_NAME);
    this.embeddings = opts.embeddings;
  }

  /** Số item hiện có. */
  get size(): number {
    return this.items.size;
  }

  /** Số chiều vector (0 khi index rỗng). */
  get dimensions(): number {
    return this.dims;
  }

  /**
   * Thêm/cập nhật một item. Khi không kèm `vector` thì tự embed `text`
   * bằng bộ embedder của index (cần có `embeddings`, nếu không sẽ lỗi rõ).
   */
  async add(id: string, text: string, vector?: number[]): Promise<void> {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new EmbeddingError('EmbeddingIndex.add cần `id` là chuỗi không rỗng.');
    }
    if (typeof text !== 'string' || text.trim() === '') {
      throw new EmbeddingError(`Không thêm được item ${JSON.stringify(id)}: text rỗng.`);
    }
    if (!this.items.has(id) && this.items.size >= MAX_EMBEDDING_ITEMS) {
      throw new EmbeddingError(
        `Index embedding đã đầy (${MAX_EMBEDDING_ITEMS} item) — không thêm được ${JSON.stringify(id)}. Hãy xoá bớt item cũ hoặc tạo index mới.`,
      );
    }
    let raw = vector;
    if (raw === undefined) {
      if (!this.embeddings) {
        throw new EmbeddingError(
          `Không embed được text cho item ${JSON.stringify(id)}: index này không có bộ embedder. ` +
            `Truyền vector sẵn vào add(id, text, vector), hoặc tạo EmbeddingIndex với tuỳ chọn \`embeddings\` (OllamaEmbeddings).`,
        );
      }
      raw = await this.embeddings.embed(text);
    }
    const normalized = normalizeVector(raw);
    if (this.dims === 0) {
      this.dims = normalized.length;
    } else if (normalized.length !== this.dims) {
      throw new EmbeddingError(
        `Vector của item ${JSON.stringify(id)} có ${normalized.length} chiều, khác ${this.dims} chiều của index (model ${JSON.stringify(this.model)}).`,
      );
    }
    this.items.set(id, { id, text, vector: normalized, updatedAt: new Date().toISOString() });
  }

  /** Xoá một item — trả `true` khi item tồn tại. */
  remove(id: string): boolean {
    const removed = this.items.delete(id);
    if (this.items.size === 0) this.dims = 0;
    return removed;
  }

  /** Lấy một item theo id (undefined khi không có). */
  get(id: string): EmbeddingItem | undefined {
    return this.items.get(id);
  }

  /** Liệt kê id của mọi item trong index (để prune entry lỗi thời). */
  ids(): string[] {
    return [...this.items.keys()];
  }

  /** Tìm các item giống query nhất theo cosine similarity. */
  async search(query: string, opts: EmbeddingSearchOptions = {}): Promise<EmbeddingSearchResult[]> {
    if (typeof query !== 'string' || query.trim() === '') {
      throw new EmbeddingError('Không tìm được với query rỗng.');
    }
    if (this.items.size === 0) return [];
    const embedFn = opts.embedFn ?? this.embeddings?.embed.bind(this.embeddings);
    if (!embedFn) {
      throw new EmbeddingError(
        'Không embed được query: index này không có bộ embedder. Truyền `embedFn` vào search(), hoặc tạo EmbeddingIndex với tuỳ chọn `embeddings` (OllamaEmbeddings).',
      );
    }
    const topK = Math.min(Math.max(1, Math.floor(opts.topK ?? 10)), 20);
    const queryVector = normalizeVector(await embedFn(query));
    if (queryVector.length !== this.dims) {
      throw new EmbeddingError(
        `Vector của query có ${queryVector.length} chiều, khác ${this.dims} chiều của index (model ${JSON.stringify(this.model)}).`,
      );
    }
    const scored: EmbeddingSearchResult[] = [];
    for (const item of this.items.values()) {
      let score = 0;
      for (let i = 0; i < this.dims; i++) score += queryVector[i]! * item.vector[i]!;
      scored.push({ id: item.id, text: item.text, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** Ghi index ra `<dir>/embeddings.json`. */
  save(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file: EmbeddingIndexFile = {
      model: this.model,
      dims: this.dims,
      items: [...this.items.values()],
    };
    fs.writeFileSync(this.filePath, JSON.stringify(file, null, 2), 'utf8');
  }

  /**
   * Đọc index từ `<dir>/embeddings.json`. File chưa có → index rỗng
   * (không lỗi). File hỏng hoặc sai model/dims → lỗi rõ ràng.
   */
  load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      // Chưa có file — index rỗng.
      this.items.clear();
      this.dims = 0;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new EmbeddingError(`File index embedding ${JSON.stringify(this.filePath)} chứa JSON không hợp lệ.`);
    }
    const file = parsed as Partial<EmbeddingIndexFile>;
    if (!file || typeof file !== 'object' || !Array.isArray(file.items)) {
      throw new EmbeddingError(`File index embedding ${JSON.stringify(this.filePath)} sai định dạng (cần { model, dims, items: [...] }).`);
    }
    if (typeof file.model === 'string' && file.model !== this.model) {
      throw new EmbeddingError(
        `File index embedding dùng model ${JSON.stringify(file.model)}, khác model ${JSON.stringify(this.model)} của index này — hãy dùng đúng model hoặc tạo index mới.`,
      );
    }
    if (file.items.length > MAX_EMBEDDING_ITEMS) {
      throw new EmbeddingError(
        `File index embedding chứa ${file.items.length} item, vượt giới hạn ${MAX_EMBEDDING_ITEMS} item.`,
      );
    }
    this.items.clear();
    this.dims = 0;
    for (const item of file.items) {
      if (!item || typeof item.id !== 'string' || typeof item.text !== 'string' || !Array.isArray(item.vector)) {
        throw new EmbeddingError(`File index embedding chứa item sai định dạng (cần { id, text, vector, updatedAt }).`);
      }
      if (this.dims === 0) this.dims = item.vector.length;
      else if (item.vector.length !== this.dims) {
        throw new EmbeddingError(`File index embedding chứa item ${JSON.stringify(item.id)} lệch số chiều (${item.vector.length} khác ${this.dims}).`);
      }
      this.items.set(item.id, {
        id: item.id,
        text: item.text,
        vector: item.vector,
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// semanticSearch — helper dùng chung, khớp giao diện TF-IDF
// ---------------------------------------------------------------------------

export type SemanticSearchDoc = { id: string; text: string } | string;

export interface SemanticSearchOptions {
  /** Bộ embedder (OllamaEmbeddings). Khi thiếu `embedFn`, bắt buộc phải có. */
  embeddings?: Embedder;
  /** Hàm embed dùng thay cho `embeddings` (test inject vector fake). */
  embedFn?: (text: string) => Promise<number[]>;
  /** Số kết quả tối đa (mặc định 10, tối đa 20 — khớp tool TF-IDF). */
  topK?: number;
}

/**
 * Tìm kiếm ngữ nghĩa bằng embedding thật trên một danh sách tài liệu.
 * Khớp giao diện tool TF-IDF `semantic_search` (query string, topK
 * mặc định 10 tối đa 20, trả `[{ id, text, score }]` xếp giảm dần) để
 * coordinator thay thế dần. `docs` có thể là chuỗi (id tự sinh
 * `doc-<vị trí>`) hoặc `{ id, text }`.
 *
 * Khi Ollama không khả dụng: throw lỗi tiếng Việt rõ ràng. KHÔNG lặng
 * lẽ fallback về TF-IDF — việc fallback là quyết định của coordinator.
 */
export async function semanticSearch(
  query: string,
  docs: SemanticSearchDoc[],
  opts: SemanticSearchOptions,
): Promise<EmbeddingSearchResult[]> {
  if (typeof query !== 'string' || query.trim() === '') {
    throw new EmbeddingError('Không tìm được với query rỗng.');
  }
  if (!Array.isArray(docs) || docs.length === 0) return [];
  const embedFn = opts.embedFn ?? opts.embeddings?.embed.bind(opts.embeddings);
  if (!embedFn) {
    throw new EmbeddingError(
      'semanticSearch cần `embeddings` (OllamaEmbeddings) hoặc `embedFn` — chưa có bộ embedder nào được truyền vào.',
    );
  }
  // Kiểm tra Ollama trước khi embed cả danh sách: lỗi sớm, lỗi rõ.
  if (!opts.embedFn && opts.embeddings?.isAvailable) {
    const available = await opts.embeddings.isAvailable();
    if (!available) {
      throw new EmbeddingError(
        'Không tìm kiếm ngữ nghĩa được: Ollama chưa chạy hoặc chưa reachable. ' +
          'Hãy chạy Ollama ở http://127.0.0.1:11434 (`ollama serve`) rồi thử lại.',
      );
    }
  }
  const topK = Math.min(Math.max(1, Math.floor(opts.topK ?? 10)), 20);
  const normalized: Array<{ id: string; text: string }> = docs.map((doc, i) =>
    typeof doc === 'string' ? { id: `doc-${i}`, text: doc } : { id: doc.id, text: doc.text },
  );
  for (const doc of normalized) {
    if (typeof doc.text !== 'string' || doc.text.trim() === '') {
      throw new EmbeddingError(`Tài liệu ${JSON.stringify(doc.id)} có text rỗng — không embed được.`);
    }
  }
  const queryVector = normalizeVector(await embedFn(query));
  let docVectors: number[][];
  if (opts.embedFn) {
    // embedFn chỉ embed từng text một.
    docVectors = [];
    for (const doc of normalized) docVectors.push(normalizeVector(await opts.embedFn(doc.text)));
  } else if (opts.embeddings?.embedBatch) {
    const batch = opts.embeddings.embedBatch.bind(opts.embeddings);
    docVectors = (await batch(normalized.map((d) => d.text))).map((v) => normalizeVector(v));
  } else {
    docVectors = [];
    for (const doc of normalized) docVectors.push(normalizeVector(await embedFn(doc.text)));
  }
  const scored: EmbeddingSearchResult[] = normalized.map((doc, i) => ({
    id: doc.id,
    text: doc.text,
    score: cosineSimilarity(queryVector, docVectors[i]!),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
