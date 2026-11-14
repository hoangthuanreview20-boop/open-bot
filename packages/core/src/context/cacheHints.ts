/**
 * Prompt-cache hints (v1.02 rescue port of the v0.99 work).
 *
 * `PromptCacheTracker` records which prefix of a prompt is stable
 * across turns (system prompt + early history) so the host can hint
 * the provider to cache it; `cacheSupportForProvider` reports which
 * providers support prompt caching at all. Both are heuristics — the
 * provider decides what it actually caches.
 */

/** Providers known to support prompt caching (prefix caching). */
export const PROMPT_CACHE_PROVIDERS = new Set(['anthropic', 'openai', 'openai-compatible', 'gemini', 'xai']);

/** True when the provider id is known to support prompt caching. */
export function cacheSupportForProvider(providerId: string): boolean {
  return PROMPT_CACHE_PROVIDERS.has(providerId.toLowerCase());
}

/** One cache observation: how much of a prompt was a stable prefix. */
export interface CacheObservation {
  at: string;
  model: string;
  /** Tokens in the stable prefix (system + early history). */
  prefixTokens: number;
  /** Total prompt tokens. */
  totalTokens: number;
  /** Whether the provider reported a cache hit. */
  hit?: boolean;
}

/** Tracks the stable prompt prefix across turns. */
export class PromptCacheTracker {
  private observations: CacheObservation[] = [];

  /** Record one turn's prompt shape. */
  record(observation: Omit<CacheObservation, 'at'> & { at?: string }): void {
    this.observations.push({ ...observation, at: observation.at ?? new Date().toISOString() });
    if (this.observations.length > 200) this.observations.splice(0, this.observations.length - 200);
  }

  /** Fraction of recorded turns that reported a cache hit (null when unknown). */
  hitRate(): number | null {
    const known = this.observations.filter((o) => o.hit !== undefined);
    if (known.length === 0) return null;
    return known.filter((o) => o.hit).length / known.length;
  }

  /** Median stable-prefix size (tokens) across recorded turns. */
  medianPrefixTokens(): number {
    if (this.observations.length === 0) return 0;
    const sorted = this.observations.map((o) => o.prefixTokens).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  /** The longest stable prefix seen (a good cache-breakpoint hint). */
  maxPrefixTokens(): number {
    return this.observations.reduce((max, o) => Math.max(max, o.prefixTokens), 0);
  }

  get count(): number {
    return this.observations.length;
  }
}
