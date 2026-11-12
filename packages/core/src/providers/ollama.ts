/**
 * Ollama provider — local models over the OpenAI-compatible endpoint
 * http://localhost:11434/v1/chat/completions. No API key needed.
 * No SDK, plain fetch.
 */

import type { ChatCompletionRequest, ProviderConfig, ProviderResponse } from '../types';
import { OpenAICompatibleProvider, openAIListModels, truncateErrorText } from './openaiCompatible';
import { ollamaModelSupportsVision } from '../agent/vision';
import { withTimeout } from './abort';
import {
  DEFAULT_EMBED_MODEL,
  OllamaEmbeddings,
} from '../memory/embeddings';
import type { EmbedFetchFn } from '../memory/embeddings';

export const OLLAMA_BASE_URL = 'http://localhost:11434/v1';
export const OLLAMA_DEFAULT_MODEL = 'llama3.1';
/** Models listed when Ollama has no list API reachable / is not running. */
export const OLLAMA_KNOWN_MODELS = ['llama3.1', 'qwen2.5', 'mistral', 'gemma3', 'qwen3', 'llama3.3'];

/**
 * B-platform M3: thông tin một model local đã pull, lấy từ Ollama
 * GET /api/tags. Chỉ `name` là bắt buộc — các field khác Ollama có
 * thể không trả thì để `undefined`, không đoán giá trị.
 */
export interface OllamaLocalModelInfo {
  /** Tên đầy đủ, vd 'qwen2.5:0.5b'. */
  name: string;
  /** Dung lượng trên đĩa (byte). */
  size?: number;
  /** Thời gian sửa lần cuối (ISO 8601, vd '2026-11-09T...Z'). */
  modifiedAt?: string;
  /** Kích thước tham số, vd '0.5B', '7B'. */
  parameterSize?: string;
  /** Mức quantize, vd 'Q4_K_M'. */
  quantizationLevel?: string;
  /** Họ model, vd 'qwen2', 'llama'. */
  family?: string;
}
/**
 * Context window (tokens) Ollama dùng khi một model không set `num_ctx`
 * (xem `ollamaEffectiveContextLimit`): server log lúc khởi động in
 * `default_num_ctx=4096`, khớp doc Ollama ("num_ctx, Default: 4096").
 */
export const OLLAMA_DEFAULT_NUM_CTX = 4096;
/** Timeout cho một lần hỏi context của model — best-effort, xem `getContextLimit`. */
export const OLLAMA_CONTEXT_LIMIT_TIMEOUT_MS = 5_000;
/** Lỗi đo context được cache ngắn để một run không hỏi lại Ollama liên tục khi nó đang down. */
export const OLLAMA_CONTEXT_LIMIT_NEGATIVE_CACHE_MS = 60_000;

/**
 * Context window HIỆU DỤNG (token) của một model Ollama, suy ra từ
 * `POST /api/show` — pure, không I/O (test trực tiếp được).
 *
 * Nghiên cứu bằng Ollama thật (v0.26, W19a; server 0.40.15 local,
 * model `qwen2.5:0.5b`, đo ngày 2026-11-09) — số đo đầy đủ trong
 * `tests/ollama-context-v025.test.mjs` (test live):
 *  - `model_info` chứa context HUẤN LUYỆN tối đa, key
 *    `<arch>.context_length` — `qwen2.context_length: 32768` với
 *    qwen2.5:0.5b. Đây là TRẦN, không phải context thực tế khi chạy.
 *  - `parameters` (chuỗi Modelfile) của `qwen2.5:0.5b` KHÔNG TỒN TẠI
 *    (key vắng) — Modelfile mặc định không set `num_ctx`.
 *  - Không có `num_ctx` → server dùng default của nó: 4096 (log khởi
 *    động in `default_num_ctx=4096`; doc Ollama: "num_ctx, Default:
 *    4096"). Đây là con số provider của mình thực sự nhận được khi gọi
 *    `/v1/chat/completions` mà không truyền `num_ctx` — nên guard
 *    small-model PHẢI dùng 4096, không phải 32768 của trần huấn luyện.
 *  - Đối chứng độc lập: `GET /api/ps` khi model đang load (sau một
 *    lần generate, keep_alive 5 phút) trả `context_length: 4096` —
 *    khớp đúng quy tắc dưới đây, nên chỉ cần `/api/show`, không cần
 *    gọi thêm `/api/ps` mỗi lần đo.
 *  - Đo thực tế: `qwen2.5:0.5b` → hiệu dụng 4096.
 *
 * Quy tắc (theo thứ tự): `num_ctx` trong Modelfile (kẹp bởi trần huấn
 * luyện nếu biết) > default Ollama 4096 (kẹp bởi trần huấn luyện nếu
 * biết). Không đoán từ tên model ở đây — đó là việc của
 * `inferContextLimitFromModelName` / `contextLimitForModel`.
 */
export function ollamaEffectiveContextLimit(show: {
  model_info?: Record<string, unknown>;
  parameters?: unknown;
}): number | undefined {
  const data = show ?? {};
  let trained: number | undefined;
  const info = data.model_info;
  if (info && typeof info === 'object') {
    for (const [key, value] of Object.entries(info)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0 && key.endsWith('.context_length')) {
        trained = value;
        break;
      }
    }
  }
  let numCtx: number | undefined;
  if (typeof data.parameters === 'string') {
    const m = data.parameters.match(/^num_ctx\s+(\d+)\s*$/m);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) numCtx = n;
    }
  }
  if (numCtx !== undefined) {
    return trained !== undefined ? Math.min(numCtx, trained) : numCtx;
  }
  // Không set num_ctx: server dùng default 4096 (kẹp bởi trần huấn luyện
  // khi biết — model chỉ huấn luyện 2048 thì chạy 4096 cũng bị kẹp xuống).
  return trained !== undefined ? Math.min(OLLAMA_DEFAULT_NUM_CTX, trained) : OLLAMA_DEFAULT_NUM_CTX;
}

/**
 * Read a response body as text, streaming chunk-by-chunk when the
 * body exposes a reader (the normal case for a real fetch), falling
 * back to res.text() for stubbed responses in tests.
 */
async function readResponseText(res: Response): Promise<string> {
  const body = res.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let out = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
  }
  return res.text();
}

export class OllamaProvider extends OpenAICompatibleProvider {
  /**
   * Model embedding mặc định cho `embed()`/`embedBatch()` (P1-9).
   * Chat model (`defaultModel`) và embed model là hai thứ khác nhau:
   * model chat không embed được, nên embed model có chân riêng, mặc
   * định `nomic-embed-text`, đổi được qua constructor hoặc từng lần gọi.
   */
  readonly embedModel: string;
  /**
   * v0.26 (W19a): cache context đã đo được, theo tên model, trong
   * instance này. Giá trị đo thành công giữ suốt đời instance (đổi
   * Modelfile thì tạo provider mới); lần đo lỗi giữ
   * `OLLAMA_CONTEXT_LIMIT_NEGATIVE_CACHE_MS` để run sau thử lại khi
   * Ollama đã chạy lại, thay vì hỏi lại mỗi run lúc Ollama đang down.
   */
  private readonly contextLimitCache = new Map<
    string,
    { value: number | undefined; at: number }
  >();

  constructor(config: ProviderConfig & { embedModel?: string }) {
    super(
      {
        ...config,
        id: 'ollama',
        label: config.label || 'Ollama',
        baseUrl: config.baseUrl ?? OLLAMA_BASE_URL,
        defaultModel: config.defaultModel || OLLAMA_DEFAULT_MODEL,
      },
      OLLAMA_KNOWN_MODELS,
    );
    this.embedModel = (config.embedModel ?? '').trim() || DEFAULT_EMBED_MODEL;
  }

  /** Ollama's native base URL (baseUrl without the trailing /v1). */
  private nativeBase(): string {
    return this.baseUrl.replace(/\/v1$/, '');
  }

  /**
   * v0.63 (vision channel): Ollama only sees images with a vision
   * model (`llava`, `qwen2.5-vl`, `gemma3`, … — see
   * `ollamaModelSupportsVision`). The text-only default
   * `qwen2.5:0.5b` has no vision encoder: sending it `image_url`
   * parts would 400 / be silently ignored, so the loop refuses the
   * turn first and this override is defence-in-depth for direct
   * provider callers.
   */
  override supportsVision(model: string): boolean {
    return ollamaModelSupportsVision(model);
  }

  override async chat(req: ChatCompletionRequest): Promise<ProviderResponse> {
    const hasImages = req.messages.some(
      (m) => m.attachments !== undefined && m.attachments.length > 0,
    );
    if (hasImages && !this.supportsVision(req.model)) {
      throw new Error(
        `Ollama: model "${req.model}" không xem được ảnh (model chỉ-xử-lý-text). ` +
          `Hãy pull một model vision rồi đổi model, vd: ollama pull qwen2.5-vl ` +
          `(hoặc llava / llama3.2-vision / gemma3 / moondream), rồi gửi lại ảnh.`,
      );
    }
    return super.chat(req);
  }

  /**
   * Bộ embedder dùng cho `embed()`/`embedBatch()`/`isEmbeddingAvailable()`
   * (P1-9): cùng một `OllamaEmbeddings` của core (POST `/api/embeddings`,
   * cache không có — mỗi lần gọi là một lần HTTP), chỉ khác là base URL
   * lấy từ provider này (native base, không `/v1`) và model mặc định là
   * `embedModel` của provider. Tạo mới mỗi lần gọi: rẻ (không giữ state),
   * và tránh giữ `fetchFn` test rò sang lần gọi production.
   */
  private embedder(opts: { model?: string; fetchFn?: EmbedFetchFn } = {}): OllamaEmbeddings {
    return new OllamaEmbeddings({
      baseUrl: this.nativeBase(),
      model: (opts.model ?? '').trim() || this.embedModel,
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    });
  }

  /**
   * Embed một đoạn text bằng model embedding local (P1-9).
   * Lỗi là `EmbeddingError` tiếng Việt rõ ràng: Ollama chưa chạy,
   * model chưa pull (`ollama pull <model>`), timeout — không crash,
   * caller quyết định fallback (long-term recall fallback về từ khoá).
   */
  async embed(
    text: string,
    opts: { model?: string; fetchFn?: EmbedFetchFn } = {},
  ): Promise<number[]> {
    return this.embedder(opts).embed(text);
  }

  /** Embed nhiều text (gọi tuần tự, giống `OllamaEmbeddings.embedBatch`). */
  async embedBatch(
    texts: string[],
    opts: { model?: string; fetchFn?: EmbedFetchFn } = {},
  ): Promise<number[][]> {
    return this.embedder(opts).embedBatch(texts);
  }

  /**
   * Ollama có reachable không (GET `/api/tags`, timeout ~3s).
   * Không bao giờ throw — `false` khi Ollama chưa chạy. Lưu ý: chỉ
   * kiểm tra server, không kiểm tra model embedding đã pull hay chưa
   * (muốn biết model: `listLocalModels()` rồi tìm tên model).
   */
  async isEmbeddingAvailable(opts: { fetchFn?: EmbedFetchFn } = {}): Promise<boolean> {
    return this.embedder(opts).isAvailable();
  }

  /**
   * v0.26 (W19a): context window HIỆU DỤNG của một model local, đo từ
   * Ollama qua `POST /api/show` (xem `ollamaEffectiveContextLimit`).
   * Best-effort, không bao giờ throw: Ollama không chạy, timeout
   * (~5s), model không tồn tại, hay body lạ → `undefined` để caller
   * fallback về heuristic cũ (`contextLimitForModel`), không chặn run.
   * Kết quả được cache theo model trong instance (xem
   * `contextLimitCache`); lần đo lỗi chỉ cache ngắn để run sau thử lại.
   */
  async getContextLimit(model: string): Promise<number | undefined> {
    const name = (model ?? '').trim();
    if (!name) return undefined;
    const cached = this.contextLimitCache.get(name);
    if (cached !== undefined) {
      if (cached.value !== undefined) return cached.value;
      if (Date.now() - cached.at < OLLAMA_CONTEXT_LIMIT_NEGATIVE_CACHE_MS) return undefined;
    }
    let value: number | undefined;
    try {
      value = await this.fetchContextLimit(name);
    } catch {
      // Best-effort: mọi lỗi đều thành undefined, không throw.
      value = undefined;
    }
    this.contextLimitCache.set(name, { value, at: Date.now() });
    return value;
  }

  /** Một lần hỏi `POST /api/show` (timeout ~5s); lỗi → undefined. */
  private async fetchContextLimit(model: string): Promise<number | undefined> {
    const { signal, dispose } = withTimeout(undefined, OLLAMA_CONTEXT_LIMIT_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.nativeBase()}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model }),
        signal,
      });
      if (!res.ok) return undefined;
      const data = (await res.json()) as {
        model_info?: Record<string, unknown>;
        parameters?: unknown;
      };
      return ollamaEffectiveContextLimit(data);
    } finally {
      dispose();
    }
  }

  /**
   * Models actually installed locally, from Ollama's native
   * GET /api/tags. Returns [] when Ollama is not running or the call
   * fails — unlike listModels(), this never falls back to the known
   * list, so the UI can tell "no local models" apart from "Ollama
   * is down / unknown".
   */
  async listLocalModels(): Promise<string[]> {
    return (await this.listLocalModelInfo()).map((m) => m.name);
  }

  /**
   * B-platform M3: thông tin đầy đủ của model local đã pull, từ cùng
   * GET /api/tags — kích thước, thời gian sửa, kích thước tham số,
   * mức quantize, họ model — để picker hiển thị model local có đủ
   * thông tin thay vì chỉ tên. Field nào Ollama không trả thì
   * `undefined` (không đoán). Ollama không chạy / lỗi → [].
   */
  async listLocalModelInfo(): Promise<OllamaLocalModelInfo[]> {
    try {
      const res = await fetch(`${this.nativeBase()}/api/tags`);
      if (!res.ok) return [];
      const data = (await res.json()) as {
        models?: Array<{
          name?: string;
          size?: number;
          modified_at?: string;
          details?: {
            parameter_size?: string;
            quantization_level?: string;
            family?: string;
          };
        }>;
      };
      return (data.models ?? [])
        .map((m) => {
          const name = typeof m.name === 'string' && m.name.length > 0 ? m.name : undefined;
          if (!name) return undefined;
          const details = m.details ?? {};
          const info: OllamaLocalModelInfo = { name };
          if (typeof m.size === 'number' && Number.isFinite(m.size)) info.size = m.size;
          if (typeof m.modified_at === 'string' && m.modified_at.length > 0) {
            info.modifiedAt = m.modified_at;
          }
          if (typeof details.parameter_size === 'string' && details.parameter_size.length > 0) {
            info.parameterSize = details.parameter_size;
          }
          if (typeof details.quantization_level === 'string' && details.quantization_level.length > 0) {
            info.quantizationLevel = details.quantization_level;
          }
          if (typeof details.family === 'string' && details.family.length > 0) {
            info.family = details.family;
          }
          return info;
        })
        .filter((m): m is OllamaLocalModelInfo => m !== undefined);
    } catch {
      // Ollama is not running — no local models to report.
      return [];
    }
  }

  /**
   * Pull (download) a model into Ollama: POST /api/pull with
   * stream:true. Progress lines (NDJSON: {"status":"pulling ..."})
   * are read and discarded; the call resolves once Ollama reports
   * {"status":"success"}. Throws when Ollama is unreachable, the
   * HTTP status is not OK, or any NDJSON line reports an error
   * ({"status":"error",...} or an "error" field).
   */
  async pullModel(model: string): Promise<void> {
    if (!model || typeof model !== 'string' || !model.trim()) {
      throw new Error('pullModel cần tên model không rỗng.');
    }
    const name = model.trim();
    let res: Response;
    try {
      res = await fetch(`${this.nativeBase()}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, stream: true }),
      });
    } catch (err) {
      throw new Error(`Ollama pull ${name}: không kết nối được Ollama — ${(err as Error).message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Ollama pull ${name}: HTTP ${res.status} ${res.statusText} — ${truncateErrorText(body)}`,
      );
    }
    const text = await readResponseText(res);
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue; // A non-JSON progress line is ignored, not fatal.
      }
      const errorField = data['error'];
      if (typeof errorField === 'string' && errorField) {
        throw new Error(`Ollama pull ${name} thất bại: ${errorField}`);
      }
      if (data['status'] === 'error') {
        throw new Error(
          `Ollama pull ${name} thất bại: ${
            typeof errorField === 'string' && errorField ? errorField : 'status error'
          }`,
        );
      }
    }
  }

  override async listModels(): Promise<string[]> {
    // Try the OpenAI-compatible /v1/models first, then Ollama's native
    // /api/tags (via listLocalModels). Fall back to known models
    // when Ollama is not running.
    const fromCompat = await openAIListModels(this.baseUrl, undefined, [
      ...this.knownModels,
    ]);
    if (fromCompat.join() !== this.knownModels.join()) return fromCompat;
    const local = await this.listLocalModels();
    if (local.length > 0) return local;
    return [...this.knownModels];
  }
}
