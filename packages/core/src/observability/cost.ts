/**
 * Cost estimation — adapter over the built-in price table (v1.02
 * rescue port of the v0.99 work).
 *
 * This module does NOT keep a second price table: it wraps
 * `usage/pricing.ts` (`estimateCost` / `getModelPrice`). Unknown
 * models report `null` (never invent a price); local models
 * (Ollama / `local:*`) cost $0 by definition.
 */

import { estimateCost, getModelPrice } from '../usage/pricing';

export interface CostDetail {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** USD, or null when the model has no known price. */
  costUsd: number | null;
  /** True for local models (always $0). */
  local: boolean;
  /** True when the model has a known price. */
  known: boolean;
}

/** True for models that run locally and cost nothing (Ollama / `local:*`). */
export function isLocalModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.startsWith('local:') || lower.includes('ollama') || lower.startsWith('llama') && lower.includes('local');
}

/** True when the model has a known price in the built-in table. */
export function isKnownModel(model: string): boolean {
  return getModelPrice(model) !== null;
}

/** Detailed cost estimate for one model call (null cost when the model is unknown). */
export function estimateCostDetailed(model: string, inputTokens: number, outputTokens: number): CostDetail {
  if (isLocalModel(model)) {
    return { model, inputTokens, outputTokens, costUsd: 0, local: true, known: false };
  }
  const price = getModelPrice(model);
  if (!price) {
    return { model, inputTokens, outputTokens, costUsd: null, local: false, known: false };
  }
  return {
    model,
    inputTokens,
    outputTokens,
    costUsd: estimateCost(model, inputTokens, outputTokens),
    local: false,
    known: true,
  };
}

/** Sum known costs (unknown models contribute 0 and are reported separately). */
export function sumCosts(details: CostDetail[]): { totalUsd: number; unknownModels: string[] } {
  let total = 0;
  const unknown = new Set<string>();
  for (const detail of details) {
    if (detail.costUsd === null) unknown.add(detail.model);
    else total += detail.costUsd;
  }
  return { totalUsd: total, unknownModels: [...unknown] };
}

/** Format a USD amount with 4 decimals (costs are tiny per call). */
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}
