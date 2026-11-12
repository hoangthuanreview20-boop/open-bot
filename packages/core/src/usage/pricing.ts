/**
 * Built-in price table for usage cost estimates (v0.4).
 *
 * Prices are USD per 1M tokens, standard (non-batch, non-cached,
 * short-context) rates taken from the providers' public pricing pages
 * and checked 2026-11-08:
 *
 *   xAI Grok:  grok-4.7 $2.00/$6.00, grok-4.6 $2.00/$6.00,
 *              grok-4.5 $2.00/$6.00, grok-4.3 $1.25/$2.50,
 *              grok-4 $3.00/$15.00, grok-4.1-fast $0.20/$0.50,
 *              grok-build-0.1 $1.00/$2.00
 *   OpenAI:    gpt-5 $1.25/$10.00, gpt-5-mini $0.25/$2.00,
 *              gpt-5-nano $0.05/$0.40, gpt-5.5 $5.00/$30.00,
 *              gpt-5.4 $2.50/$15.00, gpt-4o $2.50/$10.00,
 *              gpt-4o-mini $0.15/$0.60
 *   Anthropic: claude-sonnet-4.5 $3.00/$15.00,
 *              claude-sonnet-4.6 $3.00/$15.00,
 *              claude-haiku-4.5 $1.00/$5.00,
 *              claude-opus-4.1 $15.00/$75.00,
 *              claude-sonnet-5 $2.00/$10.00
 *   Google:    gemini-2.5-pro $1.25/$10.00,
 *              gemini-2.5-flash $0.30/$2.50,
 *              gemini-2.5-flash-lite $0.10/$0.40
 *
 * These are ESTIMATES for the user's own spend banner, not a bill:
 * providers change prices, and long-context / cached-input / batch /
 * priority rates differ. The table is overridable at runtime with
 * `registerPrice` (e.g. from a future model-registry fetch), and any
 * model missing from the table still counts its tokens — its cost is
 * reported as `null` (unknown), never as $0.
 */

export interface ModelPrice {
  /** USD per 1M input tokens. */
  inputPerMillionUsd: number;
  /** USD per 1M output tokens. */
  outputPerMillionUsd: number;
}

const DEFAULT_PRICES: Record<string, ModelPrice> = {
  // --- xAI Grok ---
  'grok-4.7': { inputPerMillionUsd: 2.0, outputPerMillionUsd: 6.0 },
  'grok-4.6': { inputPerMillionUsd: 2.0, outputPerMillionUsd: 6.0 },
  'grok-4.5': { inputPerMillionUsd: 2.0, outputPerMillionUsd: 6.0 },
  'grok-4.3': { inputPerMillionUsd: 1.25, outputPerMillionUsd: 2.5 },
  'grok-4': { inputPerMillionUsd: 3.0, outputPerMillionUsd: 15.0 },
  'grok-4.1-fast': { inputPerMillionUsd: 0.2, outputPerMillionUsd: 0.5 },
  'grok-build-0.1': { inputPerMillionUsd: 1.0, outputPerMillionUsd: 2.0 },
  // --- OpenAI ---
  'gpt-5': { inputPerMillionUsd: 1.25, outputPerMillionUsd: 10.0 },
  'gpt-5-mini': { inputPerMillionUsd: 0.25, outputPerMillionUsd: 2.0 },
  'gpt-5-nano': { inputPerMillionUsd: 0.05, outputPerMillionUsd: 0.4 },
  'gpt-5.5': { inputPerMillionUsd: 5.0, outputPerMillionUsd: 30.0 },
  'gpt-5.4': { inputPerMillionUsd: 2.5, outputPerMillionUsd: 15.0 },
  'gpt-4o': { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10.0 },
  'gpt-4o-mini': { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
  // --- Anthropic ---
  'claude-sonnet-4.5': { inputPerMillionUsd: 3.0, outputPerMillionUsd: 15.0 },
  'claude-sonnet-4.6': { inputPerMillionUsd: 3.0, outputPerMillionUsd: 15.0 },
  'claude-haiku-4.5': { inputPerMillionUsd: 1.0, outputPerMillionUsd: 5.0 },
  'claude-opus-4.1': { inputPerMillionUsd: 15.0, outputPerMillionUsd: 75.0 },
  'claude-sonnet-5': { inputPerMillionUsd: 2.0, outputPerMillionUsd: 10.0 },
  // --- Google Gemini ---
  'gemini-2.5-pro': { inputPerMillionUsd: 1.25, outputPerMillionUsd: 10.0 },
  'gemini-2.5-flash': { inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5 },
  'gemini-2.5-flash-lite': { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.4 },
};

/** Runtime overrides / additions on top of the built-in table. */
const customPrices = new Map<string, ModelPrice>();

/** Override or add a price for a model id (exact match wins over built-ins). */
export function registerPrice(model: string, price: ModelPrice): void {
  if (!model || typeof model !== 'string') throw new Error('registerPrice needs a model id.');
  if (
    !Number.isFinite(price.inputPerMillionUsd) ||
    !Number.isFinite(price.outputPerMillionUsd) ||
    price.inputPerMillionUsd < 0 ||
    price.outputPerMillionUsd < 0
  ) {
    throw new Error('registerPrice needs non-negative finite prices.');
  }
  customPrices.set(model, { ...price });
}

/** Remove a runtime override added by `registerPrice`. */
export function unregisterPrice(model: string): void {
  customPrices.delete(model);
}

/**
 * Price for a model id, or null when unknown.
 * Lookup order: runtime override (exact) -> built-in (exact) ->
 * built-in longest-prefix match, so dated variants such as
 * `grok-4.7-2026-09-21` or `gpt-5-2025-08-07` inherit their base
 * model's price. A prefix match only counts when the next character
 * after the known id is `-` or `.` (so `gpt-5-mini` never matches
 * `gpt-5` by accident — exact match wins there anyway).
 */
export function getModelPrice(model: string): ModelPrice | null {
  const custom = customPrices.get(model);
  if (custom) return { ...custom };
  const exact = DEFAULT_PRICES[model];
  if (exact) return { ...exact };
  let best: string | null = null;
  for (const id of Object.keys(DEFAULT_PRICES)) {
    if (model.startsWith(id) && (model[id.length] === '-' || model[id.length] === '.')) {
      if (best === null || id.length > best.length) best = id;
    }
  }
  return best ? { ...DEFAULT_PRICES[best] } : null;
}

/** Model ids that have a built-in price (excludes runtime overrides). */
export function listPricedModels(): string[] {
  return Object.keys(DEFAULT_PRICES).sort();
}

/**
 * Estimated cost in USD for a call, or null when the model has no
 * known price. Token counts are validated (non-negative integers).
 * Local models (Ollama) have no price row by design — callers that
 * know a call was free should pass cost 0 explicitly instead of
 * relying on this function.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  if (!Number.isInteger(inputTokens) || inputTokens < 0) {
    throw new Error('estimateCost needs a non-negative integer inputTokens.');
  }
  if (!Number.isInteger(outputTokens) || outputTokens < 0) {
    throw new Error('estimateCost needs a non-negative integer outputTokens.');
  }
  const price = getModelPrice(model);
  if (!price) return null;
  return (
    (inputTokens * price.inputPerMillionUsd) / 1_000_000 +
    (outputTokens * price.outputPerMillionUsd) / 1_000_000
  );
}
