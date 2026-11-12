/**
 * Google Gemini provider — POST
 * https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key=<key>
 * Translates Gemini functionCall / functionResponse to and from the shared
 * ToolDefinition / ToolCall contract. No SDK, plain fetch.
 *
 * Gemini functionCall parts carry no call id, so ids are generated locally
 * (`gemini-<uuid>`) when a call is returned.
 */

import { randomUUID } from 'node:crypto';
import type {
  ChatCompletionRequest,
  ChatMessage,
  Provider,
  ProviderConfig,
  ProviderResponse,
  ToolCall,
} from '../types';
import { chatFetchTimeoutMs, clampStopSequences, truncateErrorText } from './openaiCompatible';
import { isAbortError, throwIfAborted, withTimeout } from './abort';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';
/**
 * Số `stopSequences` tối đa Gemini `generationConfig` chấp nhận
 * (v0.26 W19b): tối đa 5 — list dài hơn bị reject. Kẹp ở dưới bằng
 * `clampStopSequences` dùng chung với họ OpenAI-compatible.
 */
export const GEMINI_MAX_STOP_SEQUENCES = 5;
/** Models listed when the API does not return a model list.
 * Cập nhật 2026-11-09 từ live `list-models` (50 models, HTTP 200):
 * `gemini-2.0-flash` đã biến khỏi live list nên bỏ; thêm các model
 * 2.5/3.1/3.5 ổn định + alias `-latest` và các model preview (xem
 * GEMINI_PREVIEW_MODELS). Model chuyên biệt (image/TTS/embedding/
 * computer-use/deep-research/lyria/robotics/antigravity/omni/
 * nano-banana) KHÔNG đưa vào đây — chúng không phải model chat
 * generateContent cho agent loop. Chi tiết: docs/live-test-gemini.md */
export const GEMINI_KNOWN_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-pro-latest',
  'gemini-3-flash-preview',
  'gemini-3.1-pro-preview',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
  'gemini-4-argon',
];

/**
 * Các model trong GEMINI_KNOWN_MODELS còn ở trạng thái preview
 * (tên có `-preview`, hoặc thế hệ mới chưa ổn định như 3.6/3.7/3.8
 * và 4-argon — live list 2026-11-09). Registry gắn nhãn
 * "(preview)" cho các model này trong model picker.
 */
export const GEMINI_PREVIEW_MODELS: readonly string[] = [
  'gemini-3-flash-preview',
  'gemini-3.1-pro-preview',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
  'gemini-4-argon',
];

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args?: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/**
 * Convert our messages to Gemini contents.
 *
 * Assistant messages keep their `functionCall` parts (from
 * ChatMessage.toolCalls) and each tool result is a proper
 * `functionResponse` part in a user content. Gemini functionResponse
 * parts need the function name, which is recovered from the preceding
 * assistant message's toolCalls by call id. Consecutive same-role
 * contents are merged and a leading `model` content is dropped (Gemini
 * requires contents to start with `user`).
 */
function toGeminiContents(messages: ChatMessage[]): {
  systemInstruction?: { parts: GeminiPart[] };
  contents: GeminiContent[];
} {
  const systemParts: string[] = [];
  const out: GeminiContent[] = [];
  const push = (role: 'user' | 'model', part: GeminiPart) => {
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.parts.push(part);
    } else {
      out.push({ role, parts: [part] });
    }
  };
  const callNameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
    } else if (m.role === 'tool') {
      push('user', {
        functionResponse: {
          name: (m.toolCallId ? callNameById.get(m.toolCallId) : undefined) ?? 'unknown',
          response: { result: m.content },
        },
      });
    } else if (m.role === 'assistant') {
      if (m.content !== '') push('model', { text: m.content });
      for (const tc of m.toolCalls ?? []) {
        callNameById.set(tc.id, tc.name);
        push('model', { functionCall: { name: tc.name, args: tc.args } });
      }
      if (m.content === '' && !(m.toolCalls && m.toolCalls.length > 0)) {
        push('model', { text: ' ' });
      }
    } else {
      // v0.63 (vision channel): user text + attached images become
      // `text` + `inlineData` parts of the same user content. An
      // image-only message carries no text part (Gemini accepts
      // content with only inlineData); a text-only message is exactly
      // as before. Non-user messages never carry attachments.
      if (m.content !== '') push('user', { text: m.content });
      for (const att of m.attachments ?? []) {
        push('user', { inlineData: { mimeType: att.mimeType, data: att.data } });
      }
      if (m.content === '' && !(m.attachments && m.attachments.length > 0)) {
        push('user', { text: '' });
      }
    }
  }
  while (out.length > 0 && out[0].role === 'model') out.shift();
  return {
    systemInstruction:
      systemParts.length > 0 ? { parts: [{ text: systemParts.join('\n\n') }] } : undefined,
    contents: out,
  };
}

export class GeminiProvider implements Provider {
  readonly id = 'gemini';
  readonly label: string;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(config: ProviderConfig) {
    this.label = config.label || 'Gemini';
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? GEMINI_BASE_URL).replace(/\/+$/, '');
    this.defaultModel = config.defaultModel || GEMINI_DEFAULT_MODEL;
  }

  /** v0.63 (vision channel): Gemini chat models take inlineData images. */
  supportsVision(_model: string): boolean {
    return true;
  }

  async chat(req: ChatCompletionRequest): Promise<ProviderResponse> {
    // v0.15 (W12b): đã hủy trước khi gọi thì reject ngay, không tốn một
    // lần fetch — cùng thứ tự với openaiCompatible (check abort trước
    // cả kiểm tra apiKey).
    throwIfAborted(req.signal);
    if (!this.apiKey) {
      throw new Error('Gemini: chưa cấu hình API key cho provider này.');
    }
    const { systemInstruction, contents } = toGeminiContents(req.messages);
    const body: Record<string, unknown> = { contents };
    if (systemInstruction) body.system_instruction = systemInstruction;
    if (req.tools && req.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
    }
    const generationConfig: Record<string, unknown> = {};
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
    if (req.maxTokens !== undefined) generationConfig.maxOutputTokens = req.maxTokens;
    // v0.23 (W16b) + v0.26 (W19b): stop native của Gemini
    // (`generationConfig.stopSequences`, tối đa 5 chuỗi — kẹp ở
    // `GEMINI_MAX_STOP_SEQUENCES`, list dài hơn bị reject).
    // Mảng rỗng thì không gửi, như các trường khác ở đây.
    const geminiStops = clampStopSequences(req.stop, GEMINI_MAX_STOP_SEQUENCES, 'Gemini');
    if (geminiStops) generationConfig.stopSequences = geminiStops;
    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }
    const url =
      `${this.baseUrl}/models/${encodeURIComponent(req.model)}:generateContent` +
      `?key=${encodeURIComponent(this.apiKey)}`;
    // v0.15 (W13d): gộp signal của request với timeout nội bộ 5 phút
    // (dùng chung chatFetchTimeoutMs với họ OpenAI-compatible) — fetch
    // treo tới khi mạng/OS ngắt không còn xảy ra; hủy khi signal gốc
    // hủy HOẶC hết timeout. dispose() trong finally như mẫu.
    const timeoutMs = chatFetchTimeoutMs();
    const combined = withTimeout(req.signal, timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: combined.signal,
      });
    } catch (err) {
      // Người gọi hủy giữa chừng (signal gốc đã hủy) → AbortError với
      // message tiếng Việt rõ, phân biệt với hết timeout nội bộ.
      // Đặt name = 'AbortError' để isAbortError() nhận diện được.
      // Hết timeout (signal gốc chưa hủy) mà fetch reject AbortError /
      // TimeoutError → lỗi timeout tiếng Việt, KHÔNG phải AbortError
      // (như mẫu openaiCompatible).
      if (req.signal?.aborted) {
        const abortErr = new Error(`${this.label}: đã hủy yêu cầu khi đang chờ phản hồi.`);
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      if (err instanceof Error && (err.name === 'TimeoutError' || isAbortError(err))) {
        throw new Error(
          `${this.label}: hết thời gian chờ phản hồi sau ${timeoutMs}ms — kiểm tra mạng/provider.`,
        );
      }
      throw err;
    } finally {
      combined.dispose();
    }
    const bodyText = await res.text();
    if (!res.ok) {
      throw new Error(
        `Gemini: HTTP ${res.status} ${res.statusText} — ${truncateErrorText(bodyText)}`,
      );
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      throw new Error(
        `Gemini: phản hồi không phải JSON hợp lệ — ${truncateErrorText(bodyText)}`,
      );
    }
    const candidates = (data.candidates ?? []) as Array<Record<string, unknown>>;
    const parts = ((candidates[0]?.content ?? {}) as { parts?: GeminiPart[] }).parts ?? [];
    const text = parts
      .filter((p): p is { text: string } => 'text' in p && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    const toolCalls: ToolCall[] = parts
      .filter((p): p is { functionCall: { name: string; args?: Record<string, unknown> } } =>
        'functionCall' in p,
      )
      .map((p) => ({
        id: `gemini-${randomUUID()}`,
        name: p.functionCall.name,
        args: p.functionCall.args ?? {},
      }));
    const usage = data.usageMetadata as Record<string, unknown> | undefined;
    return {
      text,
      toolCalls,
      usage:
        usage && typeof usage.promptTokenCount === 'number'
          ? {
              inputTokens: usage.promptTokenCount,
              outputTokens:
                typeof usage.candidatesTokenCount === 'number'
                  ? usage.candidatesTokenCount
                  : 0,
            }
          : undefined,
    };
  }

  async listModels(): Promise<string[]> {
    // Gemini has GET /v1beta/models, but the known list is enough for the
    // model picker in a local-first app: no network call is made here.
    return [...GEMINI_KNOWN_MODELS];
  }
}
