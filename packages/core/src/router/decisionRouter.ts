/**
 * Decision router — tầng 3 của router v0.96 (Đội T3).
 *
 * Ý tưởng (học từ các "small-model router" / LLM-as-a-judge thu nhỏ):
 * khi hai tầng rẻ (cấu trúc + ngữ nghĩa) không quyết được, hỏi một
 * model nhỏ chạy local (qwen2.5:0.5b qua Ollama) đúng MỘT câu hỏi
 * JSON: prompt này có cần model mạnh không? Model nhỏ rẻ (0.5B, chạy
 * local, không tốn key cloud) nhưng hiểu ngữ cảnh tốt hơn đếm từ khoá.
 *
 * Thiết kế tự viết lại từ đầu cho open-bot:
 * - Gọi Ollama `/api/chat` với `format: 'json'` + `stream: false`,
 *   temperature 0 (xác định), `num_predict` nhỏ (120 token là đủ cho
 *   một JSON ngắn) — một lần gọi duy nhất mỗi turn, không chat dài.
 * - Timeout ngắn (mặc định 4000ms) qua AbortController: quá hạn thì
 *   fail-open về rule (trả `null`), KHÔNG bao giờ treo turn.
 * - Parse JSON nghiêm ngặt: phải có đủ trường đúng kiểu, `route`
 *   phải nằm trong danh sách cho phép, `confidence` 0..1 — JSON lệch
 *   (thừa text, thiếu trường, confidence vô lý) đều bị loại, không
 *   đoán mò. Có một lần "cứu" JSON bị bọc trong markdown fence.
 * - Không throw: mọi lỗi (Ollama chết, timeout, JSON hỏng, HTTP lỗi)
 *   đều trả `null` kèm `reason` để log, caller fail-open.
 */

import { DEFAULT_OLLAMA_BASE_URL } from '../memory/embeddings';

/** Model nhỏ mặc định cho tầng decision (đã có sẵn trên máy dev). */
export const DEFAULT_DECISION_MODEL = 'qwen2.5:0.5b';
/** Timeout mặc định cho một lần gọi decision (ms). */
export const DEFAULT_DECISION_TIMEOUT_MS = 4000;
/** Số token tối đa model decision được sinh (JSON ngắn). */
export const DEFAULT_DECISION_MAX_TOKENS = 120;

/** Các route mà model decision được phép chọn. */
export const DECISION_ROUTES = [
  'simple-chat',
  'code',
  'reasoning',
  'research',
  'creative',
  'howto',
] as const;
export type DecisionRoute = (typeof DECISION_ROUTES)[number];

/** Kết quả model decision trả về (đã validate). */
export interface DecisionResult {
  /** Route model chọn (một trong DECISION_ROUTES). */
  route: DecisionRoute;
  /** true = prompt này cần model mạnh, false = model local đủ sức. */
  needsPowerfulModel: boolean;
  /** Độ tự tin model tự báo (0..1). */
  confidence: number;
  /** Lý do ngắn (≤ 1 câu) model đưa ra — để log/UI giải thích. */
  reason: string;
  /** Thời gian gọi model (ms). */
  latencyMs: number;
}

export interface DecisionRouterOptions {
  /** Base URL Ollama (mặc định http://127.0.0.1:11434). */
  baseUrl?: string;
  /** Model decision (mặc định qwen2.5:0.5b). */
  model?: string;
  /** Timeout một lần gọi (ms, mặc định 4000). */
  timeoutMs?: number;
  /** Số token tối đa (mặc định 120). */
  maxTokens?: number;
  /** Fetch inject được (test dùng fake server 127.0.0.1). */
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
}

export const DECISION_SYSTEM_PROMPT = [
  'You are a tiny routing classifier. Decide whether the user request below needs a POWERFUL model or a SMALL local model is enough.',
  'Reply with ONLY a JSON object, no other text, with exactly these fields:',
  '{"route": one of "simple-chat" | "code" | "reasoning" | "research" | "creative" | "howto",',
  ' "needs_powerful_model": true when the request needs deep reasoning, long code, math proofs, research or creative writing; false for greetings, short Q&A and simple how-to,',
  ' "confidence": number 0..1,',
  ' "reason": one short sentence in English}.',
].join('\n');

/**
 * Validate + chuẩn hoá JSON thô từ model thành DecisionResult.
 * Trả null khi JSON không hợp lệ (thiếu trường, sai kiểu, route lạ,
 * confidence ngoài 0..1). Export riêng để test không cần Ollama.
 */
export function parseDecisionJson(
  raw: string,
  latencyMs: number,
): DecisionResult | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  // Cứu JSON bị bọc trong markdown fence ```json ... ```.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) text = fenced[1].trim();
  // Cứu JSON bị kẹp giữa text khác: lấy từ { đầu tới } cuối.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  text = text.slice(first, last + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const route = obj['route'];
  if (typeof route !== 'string' || !(DECISION_ROUTES as readonly string[]).includes(route)) {
    return null;
  }
  const needs = obj['needs_powerful_model'];
  if (typeof needs !== 'boolean') return null;
  const confidence = obj['confidence'];
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null;
  const reason = obj['reason'];
  if (typeof reason !== 'string' || reason.trim() === '') return null;
  return {
    route: route as DecisionRoute,
    needsPowerfulModel: needs,
    confidence: Math.min(1, Math.max(0, confidence)),
    reason: reason.trim().slice(0, 200),
    latencyMs,
  };
}

export class DecisionRouter {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly fetchFn: (url: string, init?: RequestInit) => Promise<Response>;

  constructor(opts: DecisionRouterOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
    this.model = opts.model ?? DEFAULT_DECISION_MODEL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
    this.maxTokens = opts.maxTokens ?? DEFAULT_DECISION_MAX_TOKENS;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /** Model đang dùng cho tầng decision. */
  get decisionModel(): string {
    return this.model;
  }

  /**
   * Hỏi model nhỏ: prompt này có cần model mạnh không? Không throw —
   * lỗi/timeout/JSON hỏng đều trả null (fail-open về rule).
   */
  async decide(text: string): Promise<DecisionResult | null> {
    const input = typeof text === 'string' ? text.trim() : '';
    if (input === '') return null;
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // Race tường minh thay vì chỉ trông vào AbortSignal: fetch thật
    // tôn trọng signal, nhưng một fetchFn không hợp tác (hoặc server
    // treo sau khi nhận request) sẽ không bao giờ settle — timeout
    // phải tự reject để decide() fail-open đúng hẹn.
    const timeout = new Promise<never>((_resolve, reject) => {
      const t = setTimeout(() => reject(new Error('decision router: timeout')), this.timeoutMs);
      // Không để timer này giữ process sống khi fetch xong trước.
      if (typeof (t as unknown as { unref?: unknown }).unref === 'function') {
        (t as unknown as { unref: () => void }).unref();
      }
    });
    try {
      const res = await Promise.race([
        this.fetchFn(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            stream: false,
            format: 'json',
            options: { temperature: 0, num_predict: this.maxTokens },
            messages: [
              { role: 'system', content: DECISION_SYSTEM_PROMPT },
              { role: 'user', content: input.slice(0, 4000) },
            ],
          }),
          signal: controller.signal,
        }),
        timeout,
      ]);
      if (!res.ok) return null;
      const body = (await res.json()) as { message?: { content?: string } };
      const content = body?.message?.content;
      if (typeof content !== 'string' || content.trim() === '') return null;
      return parseDecisionJson(content, Date.now() - started);
    } catch {
      // Timeout (abort), Ollama chết, mạng lỗi: fail-open.
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
