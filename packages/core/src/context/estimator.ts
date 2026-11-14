/**
 * Token estimation + model context limits (v1.02 rescue port of the
 * v0.99 work).
 *
 * Estimation is a heuristic (chars / 4, close to the English average
 * for BPE tokenizers) because the exact tokenizer is provider-side;
 * callers that need exact counts use the provider's own usage fields.
 * Context limits are inferred from the model name with a small
 * built-in table — unknown models fall back to a conservative
 * default, never to an unbounded guess.
 */

/** Characters per token in the heuristic estimator. */
export const ESTIMATED_CHARS_PER_TOKEN = 4;

/** Fallback context limit for an unknown model (tokens). */
export const DEFAULT_CONTEXT_LIMIT_TOKENS = 128_000;

/** Models at or below this limit count as "small context". */
export const SMALL_CONTEXT_THRESHOLD_TOKENS = 32_000;

/** Rough per-message overhead (role markers, separators). */
export const MESSAGE_OVERHEAD_TOKENS = 8;

/** Known context limits by model-name pattern (checked in order). */
export const KNOWN_MODEL_CONTEXT_LIMITS: ReadonlyArray<{ pattern: RegExp; limit: number }> = [
  { pattern: /gemini-2\.5|gemini-3|gemini-4/i, limit: 1_000_000 },
  { pattern: /gemini-1\.5-pro/i, limit: 2_000_000 },
  { pattern: /gemini-1\.5-flash/i, limit: 1_000_000 },
  { pattern: /claude-opus-4|claude-sonnet-4/i, limit: 200_000 },
  { pattern: /claude-3-5-sonnet|claude-3-opus/i, limit: 200_000 },
  { pattern: /gpt-5|gpt-4o|gpt-4-turbo/i, limit: 128_000 },
  { pattern: /gpt-4\b/i, limit: 8192 },
  { pattern: /gpt-3\.5-turbo/i, limit: 16_385 },
  { pattern: /grok-4/i, limit: 256_000 },
  { pattern: /grok-3/i, limit: 131_072 },
  { pattern: /llama-3/i, limit: 128_000 },
  { pattern: /qwen/i, limit: 131_072 },
  { pattern: /deepseek/i, limit: 64_000 },
  { pattern: /mistral-large/i, limit: 128_000 },
];

/** Heuristic token estimate for plain text (chars / 4, min 1 for non-empty). */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN));
}

/** Token estimate for one chat message (content + role overhead). */
export function estimateMessageTokens(message: { role: string; content?: string; toolCalls?: unknown[] }): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS + estimateTokens(message.role);
  if (typeof message.content === 'string') tokens += estimateTokens(message.content);
  if (Array.isArray(message.toolCalls)) {
    tokens += estimateTokens(JSON.stringify(message.toolCalls));
  }
  return tokens;
}

/** Token estimate for a list of messages. */
export function estimateMessagesTokens(messages: Array<{ role: string; content?: string; toolCalls?: unknown[] }>): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

/** Context limit (tokens) for a model name, or the default when unknown. */
export function inferContextLimitFromModelName(model: string): number {
  for (const entry of KNOWN_MODEL_CONTEXT_LIMITS) {
    if (entry.pattern.test(model)) return entry.limit;
  }
  return DEFAULT_CONTEXT_LIMIT_TOKENS;
}

/** Effective context limit: explicit override wins, else inferred. */
export function effectiveContextLimit(model: string, override?: number): number {
  if (typeof override === 'number' && override > 0) return Math.floor(override);
  return inferContextLimitFromModelName(model);
}

/** True when the model's context window is at or below the small threshold. */
export function isSmallContextModel(model: string, override?: number): boolean {
  return effectiveContextLimit(model, override) <= SMALL_CONTEXT_THRESHOLD_TOKENS;
}

/** Error thrown when a prompt cannot fit even an empty reply. */
export class SmallModelContextError extends Error {
  readonly limit: number;
  readonly needed: number;
  constructor(limit: number, needed: number) {
    super(`prompt needs ~${needed} tokens but the model context is ${limit}`);
    this.name = 'SmallModelContextError';
    this.limit = limit;
    this.needed = needed;
  }
}
