/**
 * Anthropic provider — POST https://api.anthropic.com/v1/messages.
 * Headers: x-api-key + anthropic-version 2023-06-01.
 * Translates Anthropic tool_use / tool_result blocks to and from the
 * shared ToolDefinition / ToolCall contract. No SDK, plain fetch.
 */

import type {
  ChatCompletionRequest,
  ChatMessage,
  Provider,
  ProviderConfig,
  ProviderResponse,
  ToolCall,
} from '../types';
import { chatFetchTimeoutMs, truncateErrorText } from './openaiCompatible';
import { isAbortError, throwIfAborted, withTimeout } from './abort';

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_API_VERSION = '2023-06-01';
export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-5';
/** Models listed when the API does not return a model list. */
export const ANTHROPIC_KNOWN_MODELS = [
  'claude-sonnet-4-5',
  'claude-opus-4-5',
  'claude-haiku-4-5',
];

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
    };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

/**
 * Convert our messages to Anthropic format.
 *
 * Assistant messages keep their `tool_use` blocks (from ChatMessage.toolCalls)
 * and each tool result is a proper `tool_result` block in a user message, so
 * Anthropic can pair results with calls. Consecutive same-role messages are
 * merged, and a leading assistant message is dropped (Anthropic requires the
 * first message to be `user`).
 */
function toAnthropicMessages(messages: ChatMessage[]): {
  system?: string;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];
  const push = (role: 'user' | 'assistant', block: ContentBlock) => {
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content.push(block);
    } else {
      out.push({ role, content: [block] });
    }
  };
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
    } else if (m.role === 'tool') {
      push('user', {
        type: 'tool_result',
        tool_use_id: m.toolCallId ?? '',
        content: m.content,
      });
    } else if (m.role === 'assistant') {
      // Anthropic rejects empty text blocks.
      if (m.content !== '') push('assistant', { type: 'text', text: m.content });
      for (const tc of m.toolCalls ?? []) {
        push('assistant', { type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
      }
      if (m.content === '' && !(m.toolCalls && m.toolCalls.length > 0)) {
        push('assistant', { type: 'text', text: ' ' });
      }
    } else {
      // v0.63 (vision channel): user text + attached images become
      // `text` + `image` (base64 source) blocks of the same user
      // message. Anthropic rejects empty text blocks, so a text part
      // is only pushed for non-empty content; an image-only message
      // carries image blocks alone. Non-user messages never carry
      // attachments.
      if (m.content !== '') push('user', { type: 'text', text: m.content });
      for (const att of m.attachments ?? []) {
        push('user', {
          type: 'image',
          source: { type: 'base64', media_type: att.mimeType, data: att.data },
        });
      }
      if (m.content === '' && !(m.attachments && m.attachments.length > 0)) {
        push('user', { type: 'text', text: ' ' });
      }
    }
  }
  // Drop leading assistant messages: Anthropic wants user first.
  while (out.length > 0 && out[0].role === 'assistant') out.shift();
  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: out,
  };
}

export class AnthropicProvider implements Provider {
  readonly id = 'anthropic';
  readonly label: string;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(config: ProviderConfig) {
    this.label = config.label || 'Anthropic';
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/+$/, '');
    this.defaultModel = config.defaultModel || ANTHROPIC_DEFAULT_MODEL;
  }

  /** v0.63 (vision channel): Claude models take base64 image blocks. */
  supportsVision(_model: string): boolean {
    return true;
  }

  async chat(req: ChatCompletionRequest): Promise<ProviderResponse> {
    // v0.15 (W12b): đã hủy trước khi gọi thì reject ngay, không tốn một
    // lần fetch — cùng thứ tự với openaiCompatible (check abort trước
    // cả kiểm tra apiKey).
    throwIfAborted(req.signal);
    if (!this.apiKey) {
      throw new Error('Anthropic: chưa cấu hình API key cho provider này.');
    }
    const { system, messages } = toAnthropicMessages(req.messages);
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      messages,
    };
    if (system !== undefined) body.system = system;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    // v0.23 (W16b) + v0.26 (W19b): stop native của Anthropic
    // (`stop_sequences`). Mảng rỗng thì không gửi, như các trường
    // optional khác ở trên.
    // KHÔNG kẹp số lượng ở đây — có chủ đích: doc chính thức của
    // Anthropic (Messages API reference,
    // docs.claude.com/en/api/messages, kiểm tra 2026-11-09) chỉ nói
    // `stop_sequences` là list chuỗi, KHÔNG nêu giới hạn số lượng tối
    // đa (khác OpenAI tối đa 4 và Gemini tối đa 5) — kẹp bừa một con
    // số (vd 4, theo vài nguồn thứ cấp viết về endpoint tương thích
    // chứ không phải API chính thức) sẽ bỏ mất chuỗi Anthropic vốn
    // nhận được. Trong đường sampling MCP, handler đã kẹp trần chung
    // 5 (`SAMPLING_PROVIDER_STOP_SEQUENCES_MAX` ở clientHandlers.ts)
    // nên Anthropic qua đường đó vẫn chỉ nhận tối đa 5; caller gọi
    // thẳng provider này với list dài hơn thì được gửi đủ, đúng theo
    // doc chính thức. (Lưu ý: giới hạn 8191 đôi khi thấy trên mạng là
    // của Claude qua AWS Bedrock, không phải API trực tiếp của
    // Anthropic — không áp ở đây.)
    if (req.stop && req.stop.length > 0) body.stop_sequences = req.stop;
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }
    // v0.15 (W13d): gộp signal của request với timeout nội bộ 5 phút
    // (dùng chung chatFetchTimeoutMs với họ OpenAI-compatible) — fetch
    // treo tới khi mạng/OS ngắt không còn xảy ra; hủy khi signal gốc
    // hủy HOẶC hết timeout. dispose() trong finally như mẫu.
    const timeoutMs = chatFetchTimeoutMs();
    const combined = withTimeout(req.signal, timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_API_VERSION,
        },
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
        `Anthropic: HTTP ${res.status} ${res.statusText} — ${truncateErrorText(bodyText)}`,
      );
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      throw new Error(
        `Anthropic: phản hồi không phải JSON hợp lệ — ${truncateErrorText(bodyText)}`,
      );
    }
    const blocks = (data.content ?? []) as ContentBlock[];
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
    const toolCalls: ToolCall[] = blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => {
        const tu = b as Extract<ContentBlock, { type: 'tool_use' }>;
        return {
          id: tu.id,
          name: tu.name,
          args:
            tu.input && typeof tu.input === 'object'
              ? (tu.input as Record<string, unknown>)
              : {},
        };
      });
    const usage = data.usage as Record<string, unknown> | undefined;
    return {
      text,
      toolCalls,
      usage:
        usage && typeof usage.input_tokens === 'number'
          ? {
              inputTokens: usage.input_tokens,
              outputTokens:
                typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
            }
          : undefined,
    };
  }

  async listModels(): Promise<string[]> {
    // Anthropic has a GET /v1/models endpoint, but it needs the same key
    // and is rarely needed for a local-first app: return the known list.
    // (No network call is made here on purpose.)
    return [...ANTHROPIC_KNOWN_MODELS];
  }
}
