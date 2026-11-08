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

/** Truncate an error body so a huge HTML error page never floods the log. */
export function truncateErrorText(text: string, max = 500): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

interface OpenAIMessage {
  role: string;
  content: string | null;
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

/** POST {baseUrl}/chat/completions in OpenAI format. Throws on HTTP error. */
export async function openAIChatCompletions(
  baseUrl: string,
  apiKey: string | undefined,
  label: string,
  req: ChatCompletionRequest,
): Promise<ProviderResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: req.model,
      messages: toOpenAIMessages(req.messages),
      tools: toOpenAITools(req.tools),
      temperature: req.temperature,
      max_tokens: req.maxTokens,
    }),
  });
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

  async listModels(): Promise<string[]> {
    if (!this.baseUrl) return [...this.knownModels];
    return openAIListModels(this.baseUrl, this.apiKey, [...this.knownModels]);
  }
}
