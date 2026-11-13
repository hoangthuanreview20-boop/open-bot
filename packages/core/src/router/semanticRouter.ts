/**
 * Semantic router — tầng 2 của router v0.96 (Đội T3).
 *
 * Ý tưởng (học từ semantic-router / route-encoder): mỗi "route" là
 * một ý định (chat đơn giản, viết code, suy luận, nghiên cứu, sáng
 * tạo...), mô tả bằng các câu mẫu. Prompt mới được embed rồi so cosine
 * với từng route — route thắng là route có câu mẫu gần nhất. Không
 * cần huấn luyện, thêm route mới chỉ cần thêm câu mẫu.
 *
 * Thiết kế tự viết lại từ đầu cho open-bot:
 * - Embedding chạy HOÀN TOÀN local qua Ollama `nomic-embed-text`
 *   (dùng chung `Embedder` của memory/embeddings.ts) — không gọi API
 *   ngoài, không cần key. Ollama chết → trả `null` (fail-open, tầng
 *   sau / model mặc định lo tiếp), không throw lên caller.
 * - Câu mẫu của route được embed lười (lazy) và cache trong bộ nhớ:
 *   lần route đầu tiên embed ~40 câu mẫu (~1 lần duy nhất), các lần
 *   sau chỉ embed 1 câu prompt. Cache có thể xoá bằng `clearCache()`
 *   (khi đổi route) và có thể seed sẵn bằng `warmup()`.
 * - Điểm của một route = cosine CAO NHẤT với từng câu mẫu của route
 *   (không phải với vector trung bình — trung bình làm loãng: một
 *   route có 16 câu mẫu đa dạng thì câu mẫu gần nhất mới là tín hiệu
 *   đúng, các câu còn lại chỉ kéo điểm xuống).
 * - Confidence = cosine cao nhất; `margin` = khoảng cách với route
 *   nhì — margin nhỏ nghĩa là hai route giằng co, tầng decision nên
 *   vào cuộc. Ngưỡng tối thiểu cấu hình được: dưới ngưỡng thì route
 *   là `unknown` (không ép chọn sai).
 * - Song ngữ Anh + Việt trong câu mẫu (open-bot đa ngôn ngữ).
 */

import { cosineSimilarity } from '../memory/embeddings';
import type { Embedder } from '../memory/embeddings';

/** Một route: ý định + câu mẫu + gợi ý đích. */
export interface SemanticRoute {
  /** Id ổn định của route (vd 'code'). */
  id: string;
  /** Nhãn hiển thị (tiếng Anh, UI dịch qua i18n khi cần). */
  label: string;
  /** Các câu mẫu mô tả ý định này (Anh + Việt). */
  examples: string[];
  /**
   * Gợi ý đích mặc định của route: 'local' = model local nhỏ đủ sức,
   * 'capable' = cần model mạnh (cloud / CLI đã đăng nhập / local lớn).
   * ModelRouter có thể ghi đè bằng target thật.
   */
  suggests: 'local' | 'capable';
  /** Mô tả ngắn cho UI / log. */
  description: string;
}

/** Các route mặc định của open-bot (đủ cho hầu hết prompt). */
export const DEFAULT_SEMANTIC_ROUTES: SemanticRoute[] = [
  {
    id: 'simple-chat',
    label: 'Simple chat',
    suggests: 'local',
    description: 'Chào hỏi, hỏi đáp ngắn, chuyện trò thông thường.',
    examples: [
      'hello',
      'hi there',
      'good morning',
      'how are you?',
      'what time is it?',
      'thank you very much',
      'xin chào',
      'chào bạn',
      'bạn khỏe không?',
      'mấy giờ rồi?',
      'cảm ơn bạn nhé',
      'thời tiết hôm nay thế nào?',
      'tell me a joke',
      'kể một câu chuyện cười',
      'what is your name?',
      'bạn tên là gì?',
    ],
  },
  {
    id: 'code',
    label: 'Code',
    suggests: 'capable',
    description: 'Viết, sửa, debug, giải thích code.',
    examples: [
      'write a function that sorts an array',
      'fix this bug in my code',
      'why does this code throw an error?',
      'refactor this class to use dependency injection',
      'write unit tests for this module',
      'explain what this function does',
      'viết hàm sắp xếp mảng',
      'sửa lỗi trong đoạn code này',
      'tại sao code này bị lỗi?',
      'viết unit test cho module này',
      'giải thích hàm này làm gì',
      'tối ưu đoạn code này cho nhanh hơn',
    ],
  },
  {
    id: 'reasoning',
    label: 'Reasoning',
    suggests: 'capable',
    description: 'Toán, logic, lập luận nhiều bước, lập kế hoạch.',
    examples: [
      'prove that the square root of 2 is irrational',
      'solve this integral step by step',
      'what is the time complexity of quicksort and why?',
      'plan a project with milestones and risks',
      'if all cats are mammals, what follows logically?',
      'chứng minh căn bậc hai của 2 là số vô tỉ',
      'giải tích phân này từng bước',
      'độ phức tạp của quicksort là gì và vì sao?',
      'lập kế hoạch dự án với các mốc và rủi ro',
      'phân tích ưu nhược điểm của hai phương án',
    ],
  },
  {
    id: 'research',
    label: 'Research',
    suggests: 'capable',
    description: 'Tìm kiếm, so sánh, tổng hợp thông tin dài.',
    examples: [
      'search the web for the latest news about AI',
      'compare these three frameworks in detail',
      'summarize this long article for me',
      'what are the differences between Postgres and MySQL?',
      'find papers about transformer architectures',
      'tìm tin mới nhất về trí tuệ nhân tạo',
      'so sánh chi tiết ba framework này',
      'tóm tắt bài viết dài này giúp tôi',
      'khác biệt giữa Postgres và MySQL là gì?',
      'tìm tài liệu về kiến trúc transformer',
    ],
  },
  {
    id: 'creative',
    label: 'Creative writing',
    suggests: 'capable',
    description: 'Viết văn, thơ, kịch bản, nội dung sáng tạo.',
    examples: [
      'write a short story about a robot learning to paint',
      'write a poem about the sea',
      'draft a marketing email for a new product',
      'help me write a wedding speech',
      'viết truyện ngắn về một chú robot học vẽ',
      'viết một bài thơ về biển',
      'soạn email marketing cho sản phẩm mới',
      'giúp tôi viết bài phát biểu đám cưới',
    ],
  },
  {
    id: 'howto',
    label: 'How-to & explain',
    suggests: 'local',
    description: 'Hướng dẫn thao tác, giải thích khái niệm vừa phải.',
    examples: [
      'how do I install Node.js on Ubuntu?',
      'what is a REST API in simple terms?',
      'how to change my password?',
      'explain photosynthesis briefly',
      'cài Node.js trên Ubuntu như thế nào?',
      'REST API là gì, giải thích đơn giản',
      'đổi mật khẩu như thế nào?',
      'giải thích ngắn gọn quang hợp là gì',
    ],
  },
];

/** Kết quả route ngữ nghĩa của một prompt. */
export interface SemanticRouteResult {
  /** Id route thắng, hoặc 'unknown' khi không route nào đủ tự tin. */
  routeId: string;
  /** Cosine similarity cao nhất (0..1 sau khi kẹp). */
  confidence: number;
  /** Khoảng cách giữa route nhất và nhì (0..~1). */
  margin: number;
  /** Điểm từng route, sắp xếp giảm dần. */
  scores: Array<{ routeId: string; score: number }>;
  /** Gợi ý đích của route thắng ('local' | 'capable'), null khi unknown. */
  suggests: 'local' | 'capable' | null;
  /** true khi kết quả tới từ cache route (không embed lại câu mẫu). */
  fromCache: boolean;
}

export interface SemanticRouterOptions {
  /** Các route dùng để phân loại (mặc định DEFAULT_SEMANTIC_ROUTES). */
  routes?: SemanticRoute[];
  /** Cosine tối thiểu để nhận route (mặc định 0.35). */
  minConfidence?: number;
  /** Số câu mẫu tối đa embed mỗi route (mặc định 16 — đủ mà nhẹ). */
  maxExamplesPerRoute?: number;
  /** Timeout embed một câu prompt (ms, mặc định 5000). */
  embedTimeoutMs?: number;
}

/** Ngưỡng cosine tối thiểu mặc định — dưới mức này là "không biết". */
export const DEFAULT_MIN_CONFIDENCE = 0.35;

export class SemanticRouter {
  private readonly routes: SemanticRoute[];
  private readonly minConfidence: number;
  private readonly maxExamplesPerRoute: number;
  private readonly embedTimeoutMs: number;
  private readonly embedder: Embedder;
  /** Cache: routeId -> vector của từng câu mẫu (chấm max, xem header). */
  private routeVectors = new Map<string, number[][]>();
  private warmingUp: Promise<void> | null = null;

  constructor(embedder: Embedder, opts: SemanticRouterOptions = {}) {
    this.embedder = embedder;
    this.routes = opts.routes ?? DEFAULT_SEMANTIC_ROUTES;
    this.minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    this.maxExamplesPerRoute = opts.maxExamplesPerRoute ?? 16;
    this.embedTimeoutMs = opts.embedTimeoutMs ?? 5000;
  }

  /** Số route đang phục vụ. */
  get routeCount(): number {
    return this.routes.length;
  }

  /** true khi vector route đã được cache (warmup xong). */
  get isWarmedUp(): boolean {
    return this.routeVectors.size === this.routes.length;
  }

  /** Embed trước toàn bộ câu mẫu — gọi lúc khởi động / rảnh, không
   *  chặn turn đầu tiên (route() tự warmup lười khi cần). */
  warmup(): Promise<void> {
    if (!this.warmingUp) {
      this.warmingUp = this.computeRouteVectors().finally(() => {
        this.warmingUp = null;
      });
    }
    return this.warmingUp;
  }

  /** Xoá cache vector route (dùng khi đổi danh sách route). */
  clearCache(): void {
    this.routeVectors.clear();
  }

  private async computeRouteVectors(): Promise<void> {
    for (const route of this.routes) {
      if (this.routeVectors.has(route.id)) continue;
      const examples = route.examples.slice(0, this.maxExamplesPerRoute);
      if (examples.length === 0) continue;
      const batch = this.embedder.embedBatch;
      const vectors = batch
        ? await batch.call(this.embedder, examples)
        : await this.embedSequentially(examples);
      if (vectors.length > 0) this.routeVectors.set(route.id, vectors);
    }
  }

  private async embedSequentially(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const t of texts) out.push(await this.embedder.embed(t));
    return out;
  }

  private async embedWithTimeout(text: string): Promise<number[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('semantic router: embed timeout')),
          this.embedTimeoutMs,
        );
      });
      return await Promise.race([this.embedder.embed(text), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Route một prompt. Không throw: Ollama chết / timeout / prompt
   * rỗng đều trả `null` để caller fail-open về tầng sau.
   */
  async route(text: string): Promise<SemanticRouteResult | null> {
    const input = typeof text === 'string' ? text.trim() : '';
    if (input === '') return null;
    try {
      const fromCache = this.isWarmedUp;
      await this.computeRouteVectors();
      if (this.routeVectors.size === 0) return null;
      const queryVec = await this.embedWithTimeout(input);
      const scores: Array<{ routeId: string; score: number }> = [];
      for (const [routeId, vecs] of this.routeVectors) {
        let best = 0;
        for (const vec of vecs) {
          best = Math.max(best, clamp01(cosineSimilarity(queryVec, vec)));
        }
        scores.push({ routeId, score: best });
      }
      scores.sort((a, b) => b.score - a.score);
      const top = scores[0];
      const second = scores[1];
      if (!top) return null;
      const margin = second ? top.score - second.score : top.score;
      if (top.score < this.minConfidence) {
        return {
          routeId: 'unknown',
          confidence: top.score,
          margin,
          scores,
          suggests: null,
          fromCache,
        };
      }
      const route = this.routes.find((r) => r.id === top.routeId);
      return {
        routeId: top.routeId,
        confidence: top.score,
        margin,
        scores,
        suggests: route?.suggests ?? null,
        fromCache,
      };
    } catch {
      // Embedder lỗi / timeout: fail-open, caller dùng tầng sau.
      return null;
    }
  }
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Vector trung bình (mean pooling) của nhiều vector cùng chiều. */
export function averageVectors(vectors: readonly number[][]): number[] | null {
  if (vectors.length === 0) return null;
  const dim = vectors[0]?.length ?? 0;
  if (dim === 0) return null;
  const out = new Array<number>(dim).fill(0);
  let count = 0;
  for (const v of vectors) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) out[i] = (out[i] ?? 0) + (v[i] ?? 0);
    count++;
  }
  if (count === 0) return null;
  for (let i = 0; i < dim; i++) out[i] = (out[i] ?? 0) / count;
  return out;
}
