/**
 * Agent discovery — find A2A agents by URL (v1.02 rescue port of the
 * v1.00 work).
 *
 * Discovery is deliberately narrow: given a base URL, fetch the
 * Agent Card from the well-known path (`/.well-known/agent-card.json`,
 * falling back to the base URL itself) and validate it. Multi-source
 * discovery (`discoverAgents`) tries a list of base URLs and reports
 * which ones answered with a valid card and which ones failed, so
 * the UI can show both. Discovery never trusts — trust is a separate
 * user decision (see `a2aTools.ts`).
 */

import type { A2aAgentCard } from './types';
import { fetchAgentCard } from './client';
import { validateAgentCard } from './card';

/** Well-known Agent Card path (A2A 1.0). */
export const A2A_WELL_KNOWN_CARD_PATH = '/.well-known/agent-card.json';

/** Build the well-known card URL for a base URL. */
export function wellKnownCardUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}${A2A_WELL_KNOWN_CARD_PATH}`;
}

export interface DiscoveredAgent {
  baseUrl: string;
  card?: A2aAgentCard;
  /** True when a valid card was fetched. */
  ok: boolean;
  error?: string;
}

/** Discover one agent: fetch + validate its card. */
export async function discoverAgent(baseUrl: string, timeoutMs = 10_000): Promise<DiscoveredAgent> {
  const normalized = baseUrl.replace(/\/+$/, '');
  try {
    const card = await fetchAgentCard(normalized, { timeoutMs });
    const problems = validateAgentCard(card);
    if (problems.length > 0) {
      return { baseUrl: normalized, ok: false, error: `invalid Agent Card: ${problems.join('; ')}` };
    }
    return { baseUrl: normalized, card, ok: true };
  } catch (error) {
    return {
      baseUrl: normalized,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Discover many agents (each failure is reported, never thrown). */
export async function discoverAgents(baseUrls: string[], timeoutMs = 10_000): Promise<DiscoveredAgent[]> {
  return Promise.all(baseUrls.map((url) => discoverAgent(url, timeoutMs)));
}
