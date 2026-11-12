/**
 * Generic OpenAI-compatible chat provider (used directly for custom
 * endpoints, and as the shared transport for OpenAI, xAI and Ollama).
 *
 * No SDK is used: plain `fetch` against `/chat/completions`.
 * No streaming (SSE) yet — `chat()` makes one request and returns the full
 * reply. The agent loop still streams to the UI by calling `onText` once
 * with the complete text (see src/agent/loop.ts).
 */

import type {
  ChatCompletionRequest,
  ChatMessage,
  Provider,
  ProviderConfig,
  ProviderResponse,
  ToolCall,
  ToolDefinition,
} from '../types';
import { isAbortError, throwIfAborted, withTimeout } from './abort';

/** Truncate an error body so a huge HTML error page never floods the log. */
export function truncateErrorText(text: string, max = 500): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface OpenAIMessage {
  role: string;
  content: string | null | OpenAIContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

/**
 * Convert our ChatMessage list to OpenAI chat messages.
 *
 * Assistant messages keep their `tool_calls` and each tool result is sent
 * back as a proper `role: 'tool'` message with `tool_call_id`, so the API
 * can pair results with calls (a bare tool message without a preceding
 * assistant `tool_calls` is rejected with HTTP 400). The agent loop
 * (src/agent/loop.ts) always appends the assistant message with its
 * toolCalls before the tool results, so pairing holds across rounds.
 */
export function toOpenAIMessages(messages: ChatMessage[]): OpenAIMessage[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: m.content,
        tool_call_id: m.toolCallId ?? '',
      };
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: m.content === '' ? null : m.content,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      };
    }
    // v0.63 (vision channel): a user message with images becomes a
    // content-parts array — text part first, then one `image_url`
    // part per attachment (`data:<mime>;base64,<data>`). Text-only
    // messages keep the plain-string shape exactly as before, and
    // non-user messages never carry attachments.
    if (m.role === 'user' && m.attachments && m.attachments.length > 0) {
      const parts: OpenAIContentPart[] = [];
      if (m.content !== '') parts.push({ type: 'text', text: m.content });
      for (const att of m.attachments) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${att.mimeType};base64,${att.data}` },
        });
      }
      return { role: m.role, content: parts };
    }
    return { role: m.role, content: m.content };
  });
}

export function toOpenAITools(tools?: ToolDefinition[]): unknown | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { _value: parsed };
  } catch {
    // Keep the raw text instead of silently dropping unparseable arguments.
    return { _raw: raw };
  }
}

function parseOpenAIResponse(data: Record<string, unknown>): ProviderResponse {
  const choices = data.choices as Array<Record<string, unknown>> | undefined;
  const message = (choices?.[0]?.message ?? {}) as Record<string, unknown>;
  const rawContent = message.content as
    | string
    | Array<{ type?: string; text?: string }>
    | null
    | undefined;
  let text = '';
  if (typeof rawContent === 'string') {
    text = rawContent;
  } else if (Array.isArray(rawContent)) {
    text = rawContent
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('');
  }
  const rawToolCalls = (message.tool_calls ?? []) as Array<Record<string, unknown>>;
  const toolCalls: ToolCall[] = rawToolCalls.map((tc, i) => {
    const fn = (tc.function ?? {}) as Record<string, unknown>;
    return {
      id: typeof tc.id === 'string' ? tc.id : `call_${i}`,
      name: typeof fn.name === 'string' ? fn.name : 'unknown',
      args: parseToolArgs(typeof fn.arguments === 'string' ? fn.arguments : ''),
    };
  });
  const usage = data.usage as Record<string, unknown> | undefined;
  return {
    text,
    toolCalls,
    usage:
      usage && typeof usage.prompt_tokens === 'number'
        ? {
            inputTokens: usage.prompt_tokens,
            outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
          }
        : undefined,
  };
}

/**
 * Fetch timeout for chat completions (v0.5): a provider call must never
 * hang forever — a hung network used to block the agent run until the
 * coordinator RPC timed out (~10 min). Default 5 min; override with
 * OPEN_BOT_FETCH_TIMEOUT_MS (milliseconds) for tests.
 */
export const DEFAULT_CHAT_FETCH_TIMEOUT_MS = 300_000;

/**
 * Timeout fetch dùng chung cho mọi provider chat (v0.15 W13d): đọc
 * OPEN_BOT_FETCH_TIMEOUT_MS, fallback DEFAULT_CHAT_FETCH_TIMEOUT_MS
 * (5 phút). Export để Anthropic/Gemini tái dùng đúng một giá trị/env
 * với họ OpenAI-compatible, thay vì định nghĩa hằng riêng.
 */
export function chatFetchTimeoutMs(): number {
  const raw = Number(process.env.OPEN_BOT_FETCH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CHAT_FETCH_TIMEOUT_MS;
}

/**
 * Số `stop` sequence tối đa OpenAI Chat Completions API chấp nhận
 * (v0.26 W19b): tối đa 4 — list dài hơn bị reject HTTP 400. Provider
 * này là transport chung cho cả OpenAI/xAI/Ollama nên cả 3 cùng chịu
 * trần 4 (chưa kiểm chứng riêng giới hạn của xAI/Ollama — 4 là mức
 * an toàn thấp nhất trong họ OpenAI-compatible).
 */
export const OPENAI_MAX_STOP_SEQUENCES = 4;

/**
 * Kẹp list stop về tối đa `max` chuỗi đầu tiên (giữ nguyên thứ tự).
 * List dài hơn thì log một dòng warn ghi rõ số chuỗi bị bỏ (không in
 * nội dung chuỗi) — không im lặng cắt mất chuỗi caller cần.
 */
export function clampStopSequences(
  stop: string[] | undefined,
  max: number,
  label: string,
): string[] | undefined {
  if (!stop || stop.length === 0) return undefined;
  if (stop.length <= max) return stop;
  console.warn(
    `[${label}] stop: nhận ${stop.length} stop sequences, chỉ gửi ${max} chuỗi đầu cho provider ` +
      `(${stop.length - max} chuỗi còn lại bị bỏ — provider giới hạn tối đa ${max}).`,
  );
  return stop.slice(0, max);
}

/** POST {baseUrl}/chat/completions in OpenAI format. Throws on HTTP error. */
export async function openAIChatCompletions(
  baseUrl: string,
  apiKey: string | undefined,
  label: string,
  req: ChatCompletionRequest,
): Promise<ProviderResponse> {
  // v0.15: đã hủy trước khi gọi thì reject ngay, không tốn một lần fetch.
  throwIfAborted(req.signal);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const timeoutMs = chatFetchTimeoutMs();
  // v0.26 (W19b): kẹp `stop` về tối đa 4 trước khi gửi (tính một lần
  // để chỉ log warn một lần khi list bị cắt).
  const stop = clampStopSequences(req.stop, OPENAI_MAX_STOP_SEQUENCES, label);
  // v0.15: gộp signal của người gọi với timeout nội bộ — fetch hủy khi
  // một trong hai xảy ra. Không có req.signal thì vẫn chỉ còn timeout
  // như trước (backward compatible).
  const combined = withTimeout(req.signal, timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: req.model,
        messages: toOpenAIMessages(req.messages),
        tools: toOpenAITools(req.tools),
        temperature: req.temperature,
        max_tokens: req.maxTokens,
        // v0.23 (W16b) + v0.26 (W19b): stop native của OpenAI API
        // (`stop` nhận chuỗi hoặc mảng chuỗi, tối đa 4 — đã kẹp ở
        // `stop` bên trên, list dài hơn bị reject 400). Mảng rỗng thì
        // không gửi — tránh endpoint lạ reject `stop: []`.
        // OpenAI/xAI/Ollama kế thừa class này nên cả 3 đều có stop mà
        // không cần sửa riêng.
        ...(stop ? { stop } : {}),
      }),
      signal: combined.signal,
    });
  } catch (err) {
    // v0.15: người gọi hủy giữa chừng (AbortError + signal gốc đã hủy) —
    // báo rõ là bị hủy, khác với hết timeout nội bộ. Đặt name =
    // 'AbortError' để isAbortError() nhận diện được (nhất quán với
    // throwIfAborted và các provider Anthropic/Gemini từ W12b).
    if (req.signal?.aborted) {
      const abortErr = new Error(`${label}: đã hủy yêu cầu khi đang chờ phản hồi.`);
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    // Undici rejects a timed-out fetch with a TimeoutError (AbortError
    // family) — surface it as a clear provider error instead of a hang.
    if (err instanceof Error && (err.name === 'TimeoutError' || isAbortError(err))) {
      throw new Error(`${label}: hết thời gian chờ phản hồi sau ${timeoutMs}ms — kiểm tra mạng/provider.`);
    }
    throw err;
  } finally {
    combined.dispose();
  }
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(
      `${label}: HTTP ${res.status} ${res.statusText} — ${truncateErrorText(bodyText)}`,
    );
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    throw new Error(`${label}: phản hồi không phải JSON hợp lệ — ${truncateErrorText(bodyText)}`);
  }
  return parseOpenAIResponse(data);
}

/** GET {baseUrl}/models; on any failure return the known-model fallback. */
export async function openAIListModels(
  baseUrl: string,
  apiKey: string | undefined,
  fallback: string[],
): Promise<string[]> {
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { headers });
    if (!res.ok) return fallback;
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return ids.length > 0 ? ids : fallback;
  } catch {
    // Offline / unreachable / endpoint without a list API: known models.
    return fallback;
  }
}

export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  readonly label: string;
  protected readonly apiKey?: string;
  protected readonly baseUrl: string;
  protected readonly defaultModel: string;
  /** Models returned by listModels() when the endpoint has no list API. */
  protected readonly knownModels: string[];

  constructor(config: ProviderConfig, knownModels?: string[]) {
    this.id = config.id;
    this.label = config.label;
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? '').replace(/\/+$/, '');
    this.defaultModel = config.defaultModel;
    this.knownModels = knownModels ?? [config.defaultModel];
  }

  async chat(req: ChatCompletionRequest): Promise<ProviderResponse> {
    if (!this.baseUrl) {
      throw new Error(`${this.label}: chưa cấu hình baseUrl cho provider này.`);
    }
    return openAIChatCompletions(this.baseUrl, this.apiKey, this.label, req);
  }

  /**
   * v0.63 (vision channel): OpenAI-compatible chat endpoints take
   * `image_url` parts. Subclasses with a narrower reality override
   * this (Ollama: vision models only — see ollama.ts).
   */
  supportsVision(_model: string): boolean {
    return true;
  }

  async listModels(): Promise<string[]> {
    if (!this.baseUrl) return [...this.knownModels];
    return openAIListModels(this.baseUrl, this.apiKey, [...this.knownModels]);
  }
}
