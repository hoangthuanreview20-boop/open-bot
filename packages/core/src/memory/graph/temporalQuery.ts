/**
 * Temporal knowledge-graph queries (v1.02, memory v3).
 *
 * The graph stores bi-temporal facts (see graph/types.ts): every fact
 * carries a validity window (`validFrom` / `validUntil`) and a
 * write-time window (`createdAt` / `updatedAt`), and superseded facts
 * are kept, never deleted. This module is the read side of that
 * history — it answers questions the plain "what is true now" search
 * cannot:
 *
 *  - `queryFactsAt` — what was true at time T?
 *  - `findChangesInWindow` — what changed between two dates?
 *  - `findContradictionsBetween` — "what did the user say last week
 *    that contradicts today?" — pairs of facts with the same
 *    (subject, predicate) but different objects, one valid in window
 *    A and the other valid in window B, each with timestamped
 *    evidence (source sentence + episode + time).
 *  - `entityTimeline` — the full chronological history of one entity.
 *
 * All queries are pure reads over the store (no writes, no model).
 */

import type { GraphFact, MemoryScope } from './types';
import { factDisplayText, isFactValidAt, normalizeGraphText } from './types';
import type { TemporalGraphStore } from './store';

/** A fact as it was true at a queried moment. */
export interface FactAtTime {
  fact: GraphFact;
  subjectName: string;
  objectName?: string;
  /** The queried moment, ISO. */
  at: string;
}

export interface TemporalQueryOptions {
  /** Scope filter (user/bot/run/app). */
  scope?: MemoryScope;
  /** Max results (default 100, capped at 1000). */
  limit?: number;
}

/** One change inside a time window. */
export type FactChangeKind = 'created' | 'superseded' | 'deleted';

export interface FactChange {
  kind: FactChangeKind;
  fact: GraphFact;
  subjectName: string;
  /** When the change happened (ISO). */
  at: string;
  /** The fact that replaced this one (superseded only). */
  replacedById?: string;
}

/** One contradiction between two time windows, with evidence. */
export interface TemporalContradiction {
  subjectName: string;
  predicate: string;
  /** The older side of the contradiction. */
  earlier: {
    fact: GraphFact;
    objectText: string;
    /** When the older fact was valid (its window). */
    validFrom: string;
    validUntil: string | null;
    /** Original sentence the fact came from. */
    sourceText: string;
    episodeId: string;
    at: string;
  };
  /** The newer side of the contradiction. */
  later: {
    fact: GraphFact;
    objectText: string;
    validFrom: string;
    validUntil: string | null;
    sourceText: string;
    episodeId: string;
    at: string;
  };
}

/** One step in an entity's timeline. */
export interface TimelineStep {
  at: string;
  kind: FactChangeKind | 'active';
  fact: GraphFact;
  text: string;
}

function parseMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

function subjectNameOf(store: TemporalGraphStore, fact: GraphFact): string {
  return store.getEntity(fact.subjectId)?.name ?? 'user';
}

function objectNameOf(store: TemporalGraphStore, fact: GraphFact): string | undefined {
  return fact.objectId ? store.getEntity(fact.objectId)?.name : undefined;
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(limit)));
}

/**
 * Facts that were true at a given moment: their validity window
 * covers `at`. Status is ignored on purpose — a superseded fact was
 * still true before it was replaced, and a deleted fact was true
 * before it was deleted.
 */
export function queryFactsAt(
  store: TemporalGraphStore,
  at: string | Date,
  opts: TemporalQueryOptions = {},
): FactAtTime[] {
  const atDate = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(atDate.getTime())) return [];
  const atIso = atDate.toISOString();
  const scope = opts.scope ?? { userId: '', botId: '', runId: '' };
  const limit = clampLimit(opts.limit, 100, 1000);
  const facts = store
    .listFacts({ ...scope, limit: 5000 })
    .filter((f) => {
      if (parseMs(f.validFrom) > atDate.getTime()) return false;
      if (f.validUntil !== null && parseMs(f.validUntil) <= atDate.getTime()) return false;
      return true;
    })
    .sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  return facts.slice(0, limit).map((fact) => ({
    fact,
    subjectName: subjectNameOf(store, fact),
    ...(objectNameOf(store, fact) ? { objectName: objectNameOf(store, fact) } : {}),
    at: atIso,
  }));
}

/**
 * Facts that changed inside [from, to): created (validFrom inside),
 * superseded (validUntil inside + status superseded) or deleted
 * (validUntil inside + status deleted). Sorted by change time.
 */
export function findChangesInWindow(
  store: TemporalGraphStore,
  from: string | Date,
  to: string | Date,
  opts: TemporalQueryOptions = {},
): FactChange[] {
  const fromMs = from instanceof Date ? from.getTime() : Date.parse(from as string);
  const toMs = to instanceof Date ? to.getTime() : Date.parse(to as string);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs >= toMs) return [];
  const scope = opts.scope ?? { userId: '', botId: '', runId: '' };
  const limit = clampLimit(opts.limit, 100, 1000);
  const out: FactChange[] = [];
  for (const fact of store.listFacts({ ...scope, limit: 5000 })) {
    const createdMs = parseMs(fact.createdAt);
    if (createdMs >= fromMs && createdMs < toMs) {
      out.push({
        kind: 'created',
        fact,
        subjectName: subjectNameOf(store, fact),
        at: fact.createdAt,
        ...(fact.supersededBy ? { replacedById: fact.supersededBy } : {}),
      });
      continue;
    }
    if (fact.validUntil !== null) {
      const untilMs = parseMs(fact.validUntil);
      if (untilMs >= fromMs && untilMs < toMs) {
        if (fact.status === 'superseded') {
          out.push({
            kind: 'superseded',
            fact,
            subjectName: subjectNameOf(store, fact),
            at: fact.validUntil,
            ...(fact.supersededBy ? { replacedById: fact.supersededBy } : {}),
          });
        } else if (fact.status === 'deleted') {
          out.push({ kind: 'deleted', fact, subjectName: subjectNameOf(store, fact), at: fact.validUntil });
        }
      }
    }
  }
  out.sort((a, b) => a.at.localeCompare(b.at));
  return out.slice(0, limit);
}

/**
 * Contradictions between two windows: for each (subject, predicate)
 * that has one fact valid somewhere in window A and a DIFFERENT
 * object valid somewhere in window B, return the pair with full
 * timestamped evidence. Window A should be the earlier window, but
 * the function does not assume it — it orders each pair by validity
 * start so `earlier` is always the older fact.
 *
 * A fact is "valid in a window" when its validity window overlaps
 * the window (not only when it was created there — a fact created
 * long ago can still be the "earlier" side).
 */
export function findContradictionsBetween(
  store: TemporalGraphStore,
  windowA: { from: string | Date; to: string | Date },
  windowB: { from: string | Date; to: string | Date },
  opts: TemporalQueryOptions = {},
): TemporalContradiction[] {
  const aFrom = windowA.from instanceof Date ? windowA.from.getTime() : Date.parse(windowA.from as string);
  const aTo = windowA.to instanceof Date ? windowA.to.getTime() : Date.parse(windowA.to as string);
  const bFrom = windowB.from instanceof Date ? windowB.from.getTime() : Date.parse(windowB.from as string);
  const bTo = windowB.to instanceof Date ? windowB.to.getTime() : Date.parse(windowB.to as string);
  if ([aFrom, aTo, bFrom, bTo].some((v) => Number.isNaN(v))) return [];
  if (aFrom >= aTo || bFrom >= bTo) return [];

  const scope = opts.scope ?? { userId: '', botId: '', runId: '' };
  const limit = clampLimit(opts.limit, 50, 500);
  const facts = store.listFacts({ ...scope, limit: 5000 });

  const overlaps = (fact: GraphFact, fromMs: number, toMs: number): boolean => {
    const start = parseMs(fact.validFrom);
    const end = fact.validUntil === null ? Number.POSITIVE_INFINITY : parseMs(fact.validUntil);
    return start < toMs && end > fromMs;
  };

  const inA = facts.filter((f) => overlaps(f, aFrom, aTo));
  const inB = facts.filter((f) => overlaps(f, bFrom, bTo));
  const byKey = new Map<string, GraphFact[]>();
  for (const fact of inB) {
    const key = `${fact.subjectId}|${fact.predicate}`;
    const list = byKey.get(key) ?? [];
    list.push(fact);
    byKey.set(key, list);
  }

  const out: TemporalContradiction[] = [];
  const seenPairs = new Set<string>();
  for (const factA of inA) {
    const key = `${factA.subjectId}|${factA.predicate}`;
    for (const factB of byKey.get(key) ?? []) {
      if (factA.id === factB.id) continue;
      if (normalizeGraphText(factA.objectText ?? '') === normalizeGraphText(factB.objectText ?? '')) continue;
      const pairKey = [factA.id, factB.id].sort().join('|');
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      const [earlier, later] =
        parseMs(factA.validFrom) <= parseMs(factB.validFrom) ? [factA, factB] : [factB, factA];
      const side = (fact: GraphFact) => ({
        fact,
        objectText: fact.objectText ?? '',
        validFrom: fact.validFrom,
        validUntil: fact.validUntil,
        sourceText: fact.provenance.sourceText,
        episodeId: fact.provenance.episodeId,
        at: fact.provenance.at,
      });
      out.push({
        subjectName: subjectNameOf(store, earlier),
        predicate: earlier.predicate,
        earlier: side(earlier),
        later: side(later),
      });
    }
  }
  out.sort((a, b) => a.later.at.localeCompare(b.later.at));
  return out.slice(0, limit);
}

/**
 * Full chronological history of one entity: every fact version for
 * it (via supersession chains), oldest first, each with its change
 * kind and display text. Useful for "what did we use to know about
 * X, and when did it change".
 */
export function entityTimeline(
  store: TemporalGraphStore,
  entityName: string,
  opts: TemporalQueryOptions = {},
): TimelineStep[] {
  const entity = store.findEntityByName(entityName);
  if (!entity) return [];
  const scope = opts.scope ?? { userId: '', botId: '', runId: '' };
  const limit = clampLimit(opts.limit, 100, 1000);
  const facts = store
    .listFacts({ ...scope, limit: 5000 })
    .filter((f) => f.subjectId === entity.id || f.objectId === entity.id);
  const steps: TimelineStep[] = facts.map((fact) => {
    const kind: TimelineStep['kind'] =
      fact.status === 'superseded' ? 'superseded' : fact.status === 'deleted' ? 'deleted' : 'active';
    return {
      at: fact.createdAt,
      kind,
      fact,
      text: factDisplayText(fact, subjectNameOf(store, fact)),
    };
  });
  steps.sort((a, b) => a.at.localeCompare(b.at));
  return steps.slice(0, limit);
}

/** One-line human-readable summary of a contradiction (with dates). */
export function formatContradiction(c: TemporalContradiction): string {
  const fmt = (iso: string): string => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
  };
  return (
    `${c.subjectName} ${c.predicate}: "${c.earlier.objectText}" (${fmt(c.earlier.validFrom)} – ${c.earlier.validUntil ? fmt(c.earlier.validUntil) : 'now'}) ` +
    `vs "${c.later.objectText}" (from ${fmt(c.later.validFrom)}). ` +
    `Evidence: "${c.earlier.sourceText}" [${fmt(c.earlier.at)}] vs "${c.later.sourceText}" [${fmt(c.later.at)}].`
  );
}

/** Whether a fact is currently valid (thin wrapper for callers that only import this module). */
export function isFactCurrentlyValid(fact: GraphFact, at: Date = new Date()): boolean {
  return isFactValidAt(fact, at);
}
