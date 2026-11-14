/**
 * Multi-scope memory (v1.02, memory v3).
 *
 * Mem0-style multi-scope memory: a fact lives in exactly one scope,
 * but retrieval walks UP the hierarchy — a query at run level also
 * sees agent-level, user-level and app-level memories, with the most
 * specific scope winning on ties.
 *
 * Scope hierarchy (narrow -> wide):
 *   run   — one conversation run (userId + botId + runId)
 *   agent — one bot across runs (userId + botId)
 *   user  — one user across bots (userId)
 *   app   — the whole application (appId, shared across users)
 *
 * An empty field means "not bound to that level" (legacy behaviour):
 * a fact with botId '' is visible to every bot of the same user.
 * Scope matching reuses the store's `matchesScope` rule: an empty
 * filter field never excludes, an empty fact field never excludes.
 */

import type { MemoryScope } from './types';

/** Scope levels, narrowest first. */
export type ScopeLevel = 'run' | 'agent' | 'user' | 'app';

export const SCOPE_LEVELS: ScopeLevel[] = ['run', 'agent', 'user', 'app'];

/**
 * Which level a scope describes: the narrowest level that is still
 * bound. A scope with a runId is a run scope; without runId but with
 * a botId it is an agent scope; without botId but with a userId it is
 * a user scope; otherwise it is an app scope (appId may be set).
 */
export function scopeLevel(scope: MemoryScope): ScopeLevel {
  if ((scope.runId ?? '') !== '') return 'run';
  if ((scope.botId ?? '') !== '') return 'agent';
  if ((scope.userId ?? '') !== '') return 'user';
  return 'app';
}

/** Weight of a scope level when fusing retrieval results (narrow wins). */
export function scopeLevelWeight(level: ScopeLevel): number {
  switch (level) {
    case 'run':
      return 1.0;
    case 'agent':
      return 0.8;
    case 'user':
      return 0.6;
    case 'app':
      return 0.4;
  }
}

/**
 * Parent scope: one level wider. Returns null at the top (app has
 * no parent). Each step drops exactly one binding:
 * run -> agent (drop runId), agent -> user (drop botId),
 * user -> app (drop userId, keep appId).
 */
export function parentScope(scope: MemoryScope): MemoryScope | null {
  const level = scopeLevel(scope);
  if (level === 'run') return { ...scope, runId: '' };
  if (level === 'agent') return { ...scope, runId: '', botId: '' };
  if (level === 'user') return { userId: '', botId: '', runId: '', ...(scope.appId ? { appId: scope.appId } : {}) };
  return null;
}

/**
 * Full inheritance chain for a query scope, narrowest first:
 * [run, agent, user, app]. A query with no runId starts at its own
 * level (e.g. an agent query yields [agent, user, app]).
 */
export function expandScopeChain(scope: MemoryScope): MemoryScope[] {
  const chain: MemoryScope[] = [{ ...scope }];
  let current: MemoryScope | null = scope;
  while (true) {
    const parent = parentScope(current);
    if (parent === null) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}

/**
 * Is a fact stored in `factScope` visible from a query in
 * `queryScope`? Mirrors the store's `matchesScope` rule (two-sided
 * wildcard: an empty field on either side never excludes):
 *  - a run query sees its own run + agent + user + app facts, but
 *    never another run's facts or another user's facts;
 *  - an agent query sees every run of that bot (recall across runs
 *    is the point of the agent level);
 *  - a user query sees every bot of that user;
 *  - an app query sees everything.
 * Visibility sets nest along the chain: run ⊂ agent ⊂ user ⊂ app.
 */
export function scopeIncludes(queryScope: MemoryScope, factScope: MemoryScope): boolean {
  const visible = (factValue: string | undefined, queryValue: string | undefined): boolean => {
    const f = factValue ?? '';
    const q = queryValue ?? '';
    return f === '' || q === '' || f === q;
  };
  return (
    visible(factScope.userId, queryScope.userId) &&
    visible(factScope.botId, queryScope.botId) &&
    visible(factScope.runId, queryScope.runId) &&
    visible(factScope.appId, queryScope.appId)
  );
}

/**
 * Same-level check: is the fact stored at exactly the query scope's
 * level, with compatible bindings? Used when a caller wants NO
 * inheritance (`includeInheritedScopes: false`). An empty field on
 * either side is a wildcard (legacy facts carry '' for "current
 * user"), but the LEVELS must match — an agent-level fact is never
 * "the same level" as a run query, even when the bindings overlap.
 */
export function scopeSameLevel(queryScope: MemoryScope, factScope: MemoryScope): boolean {
  if (scopeLevel(queryScope) !== scopeLevel(factScope)) return false;
  const bind = (factValue: string | undefined, queryValue: string | undefined): boolean => {
    const f = factValue ?? '';
    const q = queryValue ?? '';
    return f === '' || q === '' || f === q;
  };
  return (
    bind(factScope.userId, queryScope.userId) &&
    bind(factScope.botId, queryScope.botId) &&
    bind(factScope.runId, queryScope.runId) &&
    bind(factScope.appId, queryScope.appId)
  );
}

/** Human-readable label for a scope (used by UI/debug output). */
export function scopeLabel(scope: MemoryScope): string {
  const level = scopeLevel(scope);
  if (level === 'run') return `run:${scope.runId || '?'}`;
  if (level === 'agent') return `agent:${scope.botId || '?'}`;
  if (level === 'user') return `user:${scope.userId || '?'}`;
  return `app:${scope.appId || 'shared'}`;
}

/**
 * Narrow a scope to exactly one level (drop all wider bindings
 * below that level). Used when a caller wants to store a fact at a
 * specific level regardless of the current run context.
 */
export function narrowScopeTo(scope: MemoryScope, level: ScopeLevel): MemoryScope {
  const base: MemoryScope = { userId: '', botId: '', runId: '' };
  if (level === 'app') {
    if (scope.appId) base.appId = scope.appId;
    return base;
  }
  base.userId = scope.userId;
  if (level === 'user') return base;
  base.botId = scope.botId;
  if (level === 'agent') return base;
  base.runId = scope.runId;
  if (scope.appId) base.appId = scope.appId;
  return base;
}
