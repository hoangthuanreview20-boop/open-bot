/**
 * Pure marketplace helpers (v0.67a) — no React, no IPC.
 *
 * `filterMarketplaceServers` powers the search box + tag chips in
 * `McpMarketplaceView.tsx`; `marketplaceTags` collects the tag chips
 * from the whole catalogue; `toolParamSummary` trims a tool's JSON
 * Schema down to what the tools panel renders (property names +
 * required names). Kept in a plain module so node:test can import it
 * via type stripping, like the other renderer logic modules.
 */
import type {
  McpMarketplaceServerLike,
  McpMarketplaceToolLike,
} from '../types';

/**
 * Diacritic-insensitive normalization for search matching. Same
 * algorithm as the app's shared `normalizeSearchText` (settings
 * search / command palette): lowercase, strip combining marks,
 * fold d-with-stroke into plain d. Kept local (instead of importing
 * settingsTabs) so this pure module stays importable from node:test
 * via type stripping, like the other renderer logic modules.
 */
export function normalizeMarketplaceText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'd');
}

/** Special tag value meaning "no tag filter" (the "All" chip). */
export const MARKETPLACE_ALL_TAGS = 'all';

/** Every distinct tag in the catalogue, sorted (for the tag chips). */
export function marketplaceTags(servers: McpMarketplaceServerLike[]): string[] {
  const tags = new Set<string>();
  for (const server of servers) {
    for (const tag of server.tags ?? []) tags.add(tag);
  }
  return [...tags].sort((a, b) => a.localeCompare(b));
}

/**
 * Servers matching a search query AND a tag filter.
 *
 * Search is diacritic-insensitive (via `normalizeMarketplaceText`):
 * every whitespace token of the query must appear as a substring of
 * the server's normalized name or description. An empty query
 * matches everything; the 'all' tag (or an empty tag) disables the
 * tag filter.
 */
export function filterMarketplaceServers(
  servers: McpMarketplaceServerLike[],
  query: string,
  tag: string,
): McpMarketplaceServerLike[] {
  const tokens = normalizeMarketplaceText(query ?? '')
    .split(/\s+/)
    .filter((token) => token.length > 0);
  return servers.filter((server) => {
    if (tag && tag !== MARKETPLACE_ALL_TAGS && !(server.tags ?? []).includes(tag)) {
      return false;
    }
    if (tokens.length === 0) return true;
    const haystack = normalizeMarketplaceText(`${server.name} ${server.description}`);
    return tokens.every((token) => haystack.includes(token));
  });
}

export interface ToolParamSummary {
  /** Property names of inputSchema.properties, in schema order. */
  paramNames: string[];
  /** Names listed in inputSchema.required (only those that are also
   *  properties are kept — a stray required entry is schema noise). */
  required: string[];
}

/**
 * Trim a tool's inputSchema to its property + required names.
 * A missing / non-object schema (or one without properties) means
 * the tool takes no parameters.
 */
export function toolParamSummary(tool: McpMarketplaceToolLike): ToolParamSummary {
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { paramNames: [], required: [] };
  }
  const properties = (schema as Record<string, unknown>)['properties'];
  const paramNames =
    properties && typeof properties === 'object' && !Array.isArray(properties)
      ? Object.keys(properties as Record<string, unknown>)
      : [];
  const requiredRaw = (schema as Record<string, unknown>)['required'];
  const required =
    Array.isArray(requiredRaw)
      ? (requiredRaw as unknown[]).filter(
          (name): name is string =>
            typeof name === 'string' && paramNames.includes(name),
        )
      : [];
  return { paramNames, required };
}
