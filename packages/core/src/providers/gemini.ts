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
import { truncateErrorText } from './openaiCompatible';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';
/** Models listed when the API does not return a model list. */
export const GEMINI_KNOWN_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'];

type GeminiPart =
  | { text: string }
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
      push('user', { text: m.content });
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

  async chat(req: ChatCompletionRequest): Promise<ProviderResponse> {
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
    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }
    const url =
      `${this.baseUrl}/models/${encodeURIComponent(req.model)}:generateContent` +
      `?key=${encodeURIComponent(this.apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
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
