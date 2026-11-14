/**
 * Sleep-time maintenance (v1.02, memory v3).
 *
 * Letta-style "sleep-time compute": while the system is idle, a
 * background pass does the housekeeping that a single turn never
 * should — beyond the v0.98 sleep agent, which only consolidates
 * unprocessed episodes:
 *
 *  1. Dedupe: active facts with the same (subject, predicate) and a
 *     near-identical object (normalized text equal, or token Jaccard
 *     above threshold) are merged into the strongest one — the rest
 *     are closed as `superseded` pointing at the keeper, so history
 *     stays queryable (store.mergeFacts).
 *  2. Promote: facts referenced by many episodes (their id appears
 *     in episode.factIds) are important — their confidence is boosted
 *     towards 1.0. Importance is evidence, not a guess.
 *  3. Prune: low-confidence facts that are old AND never referenced
 *     by any episode are soft-deleted. Nothing referenced or recent
 *     is ever pruned.
 *  4. Digest: old processed episodes are summarized into a short
 *     deterministic digest (counts + fact lines) so the run log shows
 *     what the memory actually contains, without an LLM.
 *
 * Everything is deterministic and offline. The whole pass is
 * best-effort: one bad fact never aborts the run, and the report
 * lists every action taken.
 */

import type { GraphFact, MemoryScope } from './types';
import { normalizeGraphText } from './types';
import type { TemporalGraphStore } from './store';

export interface SleepMaintenanceOptions {
  /** Token-Jaccard threshold for "same object" (default 0.8). */
  dedupeSimilarity?: number;
  /** Min episode references for a confidence boost (default 3). */
  promoteMinReferences?: number;
  /** Confidence added per promotion (default 0.05, capped at 1.0). */
  promoteBoost?: number;
  /** Confidence below which a fact is a prune candidate (default 0.5). */
  pruneMaxConfidence?: number;
  /** Age in days for a prune candidate (default 90). */
  pruneStaleDays?: number;
  /** Episodes older than this (days) go into the digest (default 30). */
  digestOlderThanDays?: number;
  /** Max digest lines (default 20). */
  digestMaxLines?: number;
  /** Clock override (tests). */
  now?: () => number;
}

export interface SleepMaintenanceReport {
  ranAt: string;
  /** Duplicate facts merged into a keeper. */
  deduped: number;
  /** Facts whose confidence was boosted. */
  promoted: number;
  /** Stale low-confidence facts soft-deleted. */
  pruned: number;
  /** Groups merged (each group = 1 keeper + N duplicates). */
  dedupeGroups: Array<{ keepFactId: string; mergedFactIds: string[]; subjectName: string; predicate: string }>;
  promotedFactIds: string[];
  prunedFactIds: string[];
  /** Deterministic digest of old episodes. */
  digest: { episodes: number; facts: number; lines: string[] };
  errors: string[];
}

function tokenSet(text: string): Set<string> {
  return new Set(normalizeGraphText(text).split(' ').filter((t) => t !== ''));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/** How many episodes reference a fact (via episode.factIds). */
export function countFactReferences(store: TemporalGraphStore, factId: string, _scope?: MemoryScope): number {
  // References are counted globally on purpose: a fact promoted at
  // user level may be referenced by episodes of several bots of the
  // same user, and that is still evidence it matters.
  void _scope;
  return countReferencesFromEpisodes(store, factId);
}

function countReferencesFromEpisodes(store: TemporalGraphStore, factId: string): number {
  // The store does not expose a raw episode list, so references are
  // counted through unprocessed + processed episodes via stats? No —
  // count directly from the exported file snapshot instead.
  const file = store.exportFile();
  let count = 0;
  for (const episode of file.episodes) {
    if (episode.factIds.includes(factId)) count += 1;
  }
  return count;
}

/**
 * Run one full maintenance pass. `scope` limits which facts are
 * considered (facts of other scopes are never deduped/promoted/
 * pruned by this run).
 */
export function runSleepMaintenance(
  store: TemporalGraphStore,
  scope: MemoryScope,
  opts: SleepMaintenanceOptions = {},
): SleepMaintenanceReport {
  const nowMs = opts.now ? opts.now() : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const dedupeSimilarity = opts.dedupeSimilarity ?? 0.8;
  const promoteMinReferences = opts.promoteMinReferences ?? 3;
  const promoteBoost = opts.promoteBoost ?? 0.05;
  const pruneMaxConfidence = opts.pruneMaxConfidence ?? 0.5;
  const pruneStaleDays = opts.pruneStaleDays ?? 90;
  const digestOlderThanDays = opts.digestOlderThanDays ?? 30;
  const digestMaxLines = opts.digestMaxLines ?? 20;

  const report: SleepMaintenanceReport = {
    ranAt: nowIso,
    deduped: 0,
    promoted: 0,
    pruned: 0,
    dedupeGroups: [],
    promotedFactIds: [],
    prunedFactIds: [],
    digest: { episodes: 0, facts: 0, lines: [] },
    errors: [],
  };

  const facts = store.listFacts({ ...scope, status: 'active', limit: 5000 });
  const referenceCount = new Map<string, number>();
  for (const fact of facts) {
    referenceCount.set(fact.id, countReferencesFromEpisodes(store, fact.id));
  }

  // --- 1. Dedupe -------------------------------------------------------
  // Group by (subject, predicate); inside a group, cluster facts
  // whose objects are near-identical. Keeper = highest confidence,
  // then newest. Only exact-normalized or high-Jaccard pairs merge.
  const groups = new Map<string, GraphFact[]>();
  for (const fact of facts) {
    const key = `${fact.subjectId}|${fact.predicate}`;
    const list = groups.get(key) ?? [];
    list.push(fact);
    groups.set(key, list);
  }
  const mergedIds = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(
      (a, b) => b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt),
    );
    const keeper = sorted[0];
    const duplicates: GraphFact[] = [];
    for (const candidate of sorted.slice(1)) {
      if (mergedIds.has(candidate.id)) continue;
      const keeperNorm = normalizeGraphText(keeper.objectText ?? '');
      const candNorm = normalizeGraphText(candidate.objectText ?? '');
      const similar =
        keeperNorm === candNorm ||
        jaccard(tokenSet(keeper.objectText ?? ''), tokenSet(candidate.objectText ?? '')) >= dedupeSimilarity;
      if (similar) duplicates.push(candidate);
    }
    if (duplicates.length === 0) continue;
    try {
      const merged = store.mergeFacts(
        keeper.id,
        duplicates.map((d) => d.id),
        `sleep-maintenance:${scope.botId}`,
      );
      for (const id of merged) mergedIds.add(id);
      if (merged.length > 0) {
        report.deduped += merged.length;
        report.dedupeGroups.push({
          keepFactId: keeper.id,
          mergedFactIds: merged,
          subjectName: store.getEntity(keeper.subjectId)?.name ?? 'user',
          predicate: keeper.predicate,
        });
      }
    } catch (err) {
      report.errors.push(`Dedupe failed for ${keeper.predicate}: ${(err as Error).message}`);
    }
  }

  // --- 2. Promote ------------------------------------------------------
  // Facts referenced by many episodes are important: boost confidence.
  for (const fact of facts) {
    if (mergedIds.has(fact.id)) continue;
    const refs = referenceCount.get(fact.id) ?? 0;
    if (refs < promoteMinReferences) continue;
    if (fact.confidence >= 1) continue;
    try {
      // Round to 3 decimals: 0.8 + 0.05 must stay exactly 0.85.
      const boosted = Math.min(1, Math.round((fact.confidence + promoteBoost) * 1000) / 1000);
      store.setFactConfidence(fact.id, boosted);
      report.promoted += 1;
      report.promotedFactIds.push(fact.id);
    } catch (err) {
      report.errors.push(`Promote failed for fact ${fact.id}: ${(err as Error).message}`);
    }
  }

  // --- 3. Prune --------------------------------------------------------
  // Low confidence + old + never referenced = safe to soft-delete.
  const staleCutoffMs = nowMs - pruneStaleDays * 86_400_000;
  for (const fact of facts) {
    if (mergedIds.has(fact.id)) continue;
    if (report.promotedFactIds.includes(fact.id)) continue;
    if (fact.confidence >= pruneMaxConfidence) continue;
    if (Date.parse(fact.updatedAt) > staleCutoffMs) continue;
    if ((referenceCount.get(fact.id) ?? 0) > 0) continue;
    try {
      store.deleteFact(fact.id, `sleep-maintenance:${scope.botId}`);
      report.pruned += 1;
      report.prunedFactIds.push(fact.id);
    } catch (err) {
      report.errors.push(`Prune failed for fact ${fact.id}: ${(err as Error).message}`);
    }
  }

  // --- 4. Digest -------------------------------------------------------
  // Old processed episodes: what do they hold, in short lines.
  try {
    const file = store.exportFile();
    const cutoffMs = nowMs - digestOlderThanDays * 86_400_000;
    const oldEpisodes = file.episodes.filter(
      (e) => e.processed && Date.parse(e.createdAt) <= cutoffMs,
    );
    const lines: string[] = [];
    let factTotal = 0;
    for (const episode of oldEpisodes.slice(0, digestMaxLines)) {
      const episodeFacts = episode.factIds
        .map((id) => store.getFact(id))
        .filter((f): f is GraphFact => f !== undefined);
      factTotal += episodeFacts.length;
      for (const fact of episodeFacts) {
        const subject = store.getEntity(fact.subjectId)?.name ?? 'user';
        lines.push(`${episode.createdAt.slice(0, 10)} ${subject} ${fact.predicate} ${fact.objectText ?? ''}`);
      }
    }
    report.digest = {
      episodes: oldEpisodes.length,
      facts: factTotal,
      lines: lines.slice(0, digestMaxLines),
    };
  } catch (err) {
    report.errors.push(`Digest failed: ${(err as Error).message}`);
  }

  return report;
}
