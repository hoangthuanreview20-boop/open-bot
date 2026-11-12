/**
 * Workspace rules (v0.11, P1-6) — load + cache `AGENTS.md`.
 *
 * Thin compatibility wrapper over the hierarchical loader in
 * `../project/agentsMd` (v0.34): `loadWorkspaceRules(dir)` loads the
 * chain for a single directory (cwd = workspaceDir), i.e. the old
 * single-root behaviour — `.open-bot/AGENTS.md` first, then `AGENTS.md`
 * at the workspace root. Callers that need the full hierarchy (root ->
 * cwd) should use `loadAgentsMd` directly.
 *
 * - Pure file reads, no writes. A missing/unreadable file is silently
 *   ignored (returns null) — a workspace without rules is normal.
 * - mtime+size cache: repeated loads in one process re-read the file
 *   only when it changed. `clearRulesCache()` forces a fresh read
 *   (used by tests and by hosts that just saved the file).
 * - Content is capped at MAX_WORKSPACE_RULES_CHARS so a huge rules file
 *   cannot blow up the context window; truncation is flagged.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  loadAgentsMd,
  clearAgentsMdCache,
  MAX_AGENTS_MD_CHARS_PER_FILE,
  type AgentsMdResult,
} from '../project/agentsMd';

/** Candidate rule files, in priority order (workspace-relative). */
export const WORKSPACE_RULES_CANDIDATES = ['.open-bot/AGENTS.md', 'AGENTS.md'] as const;

/** Max rules characters injected into a system prompt. */
export const MAX_WORKSPACE_RULES_CHARS = MAX_AGENTS_MD_CHARS_PER_FILE;

export interface WorkspaceRules {
  /** Rules text (possibly truncated — see `truncated`). */
  content: string;
  /** Which candidate matched, workspace-relative. */
  source: (typeof WORKSPACE_RULES_CANDIDATES)[number];
  /** Absolute file path that was read. */
  path: string;
  /** True when the file was longer than MAX_WORKSPACE_RULES_CHARS. */
  truncated: boolean;
}

interface CacheEntry {
  result: AgentsMdResult;
  rules: WorkspaceRules;
}

/** Keyed by resolved workspace dir; keeps object identity across loads. */
const cache = new Map<string, CacheEntry>();

/** Drop every cached entry (tests / after the user saved the file). */
export function clearRulesCache(): void {
  cache.clear();
  clearAgentsMdCache();
}

/**
 * Find the rules file for a workspace without reading it.
 * Returns null for an empty/unreadable workspace dir or no candidate.
 */
export function findRulesFile(
  workspaceDir: string,
): { path: string; source: (typeof WORKSPACE_RULES_CANDIDATES)[number] } | null {
  const dir = (workspaceDir ?? '').trim();
  if (!dir) return null;
  for (const source of WORKSPACE_RULES_CANDIDATES) {
    const abs = path.resolve(dir, source);
    try {
      if (fs.statSync(abs).isFile()) return { path: abs, source };
    } catch {
      // Missing / unreadable candidate — try the next one.
    }
  }
  return null;
}

/**
 * Load the workspace rules (cached by mtime+size). Returns null when
 * there is no readable rules file. Never throws for a missing file;
 * only a genuinely empty workspaceDir or no candidate returns null.
 */
export function loadWorkspaceRules(
  workspaceDir: string,
  opts: { forceRefresh?: boolean } = {},
): WorkspaceRules | null {
  const dir = (workspaceDir ?? '').trim();
  if (!dir) return null;
  const resolved = path.resolve(dir);
  if (!opts.forceRefresh) {
    const cached = cache.get(resolved);
    if (cached) {
      // Re-validate through the hierarchical loader (mtime+size cache):
      // same result object means nothing changed on disk.
      const fresh = loadAgentsMd(resolved, { cwd: resolved });
      if (fresh === cached.result) return cached.rules;
    }
  }
  const loaded = loadAgentsMd(resolved, { cwd: resolved, forceRefresh: opts.forceRefresh });
  if (!loaded || loaded.sources.length === 0) return null;
  // Single-directory chain: at most one source; its per-file content is
  // the legacy shape (no hierarchy section header, same truncation cap).
  const first = loaded.sources[0];
  const source = first.relative as (typeof WORKSPACE_RULES_CANDIDATES)[number];
  const rules: WorkspaceRules = {
    content: first.content,
    source,
    path: first.path,
    truncated: first.truncated,
  };
  cache.set(resolved, { result: loaded, rules });
  return rules;
}
