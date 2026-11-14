/**
 * One-pass extraction + consolidation (v1.02, memory v3).
 *
 * Mem0 v3 runs extraction and the ADD / UPDATE / DELETE decision in
 * ONE model call instead of two separate passes (extract, then
 * consolidate). open-bot gets the same shape in two flavours:
 *
 *  1. `onePassConsolidate` (rule-based, default): one deterministic
 *     pass over the turn text — extract candidates once, then apply
 *     the same decision rules as `consolidateCandidates` in the same
 *     call. No model, no second queue, no lost turns.
 *  2. `OllamaOnePassExtractor` (LLM, local): ONE Ollama chat call
 *     receives the turn AND the existing facts for the scope and
 *     returns decisions directly (`ADD | UPDATE | DELETE | NONE`).
 *     `applyOnePassDecisions` then applies them to the store. Any
 *     LLM failure (timeout, bad JSON, Ollama down) falls back to the
 *     rule-based one-pass extractor — never throws.
 *
 * Safety is unchanged: suspicious patterns and conflicts with
 * high-confidence facts still go to quarantine, never auto-applied
 * (see consolidateGraph.ts for the rules this module mirrors).
 */

import type {
  CandidateFact,
  ConsolidationAction,
  ConsolidationDecision,
  GraphFact,
  MemoryScope,
} from './types';
import { normalizeGraphText } from './types';
import type { TemporalGraphStore } from './store';
import {
  RuleBasedFactExtractor,
  extractJsonArray,
  isAllowedPredicate,
} from './extract';
import type { FactExtractor } from './extract';
import {
  consolidateCandidates,
  findSuspiciousPattern,
  isNegationText,
  suspiciousCandidateForText,
} from './consolidateGraph';
import type { ConsolidateGraphOptions } from './consolidateGraph';

/** One existing fact, as shown to the one-pass decider / LLM. */
export interface ExistingFactSummary {
  id: string;
  subjectName: string;
  predicate: string;
  objectText: string;
  confidence: number;
  updatedAt: string;
}

/** A decision produced in the single pass (not yet applied). */
export interface OnePassDecision {
  decision: ConsolidationDecision;
  candidate: CandidateFact;
  /** Existing fact this decision acts on (UPDATE / DELETE / QUARANTINE). */
  existingFactId?: string;
  reason: string;
}

/** Result of one full one-pass run over a turn. */
export interface OnePassResult {
  ranAt: string;
  /** Extractor that produced the decisions. */
  extractor: string;
  /** Model calls made (0 for the rule-based path). */
  modelCalls: number;
  examined: number;
  added: number;
  updated: number;
  deleted: number;
  quarantined: number;
  skipped: number;
  actions: ConsolidationAction[];
  details: string[];
}

/**
 * Pure decision for one candidate against the existing facts of the
 * same (subject, predicate) — mirrors the rules in
 * consolidateCandidates.ts (same thresholds, same quarantine lines)
 * but without touching the store, so the LLM path and the rule-based
 * path decide identically.
 */
export function decideCandidateAgainstExisting(
  candidate: CandidateFact,
  existing: ExistingFactSummary[],
  opts: ConsolidateGraphOptions = {},
  nowIso: string = new Date().toISOString(),
): OnePassDecision {
  const staleDays = opts.staleDays ?? 90;
  const minConfidenceToUpdate = opts.minConfidenceToUpdate ?? 0.5;
  const minConfidenceToDelete = opts.minConfidenceToDelete ?? 0.9;
  const predicate = normalizeGraphText(candidate.predicate).replace(/\s+/g, '_');
  const objectNorm = normalizeGraphText(candidate.objectText);
  if (predicate === '' || objectNorm === '') {
    return { decision: 'SKIP', candidate, reason: 'Empty candidate (missing predicate/object).' };
  }

  const suspicious = findSuspiciousPattern(candidate.sourceText) ?? findSuspiciousPattern(candidate.objectText);
  if (suspicious !== null) {
    return { decision: 'QUARANTINE', candidate, reason: `Suspicious pattern: ${suspicious}.` };
  }

  const samePredicate = existing.filter((f) => f.predicate === predicate);
  const sameObject = samePredicate.find((f) => normalizeGraphText(f.objectText) === objectNorm);

  if (isNegationText(candidate.sourceText) || isNegationText(candidate.objectText)) {
    const target = pickNewestSummary(samePredicate);
    if (!target) {
      return { decision: 'SKIP', candidate, reason: 'Negation but no existing fact to delete.' };
    }
    if (target.confidence >= minConfidenceToDelete && candidate.confidence < target.confidence) {
      return {
        decision: 'QUARANTINE',
        candidate,
        existingFactId: target.id,
        reason: 'Deleting a high-confidence fact needs user review.',
      };
    }
    return {
      decision: 'DELETE',
      candidate,
      existingFactId: target.id,
      reason: `Negates existing fact: ${target.objectText}.`,
    };
  }

  if (sameObject) {
    return { decision: 'SKIP', candidate, existingFactId: sameObject.id, reason: 'Fact already present (same object).' };
  }

  if (samePredicate.length === 0) {
    return { decision: 'ADD', candidate, reason: 'New fact.' };
  }

  const oldFact = pickNewestSummary(samePredicate);
  const oldAgeDays = (Date.parse(nowIso) - Date.parse(oldFact.updatedAt)) / 86_400_000;
  const canUpdate =
    candidate.confidence >= oldFact.confidence ||
    candidate.confidence >= minConfidenceToUpdate ||
    oldAgeDays >= staleDays;
  if (!canUpdate) {
    return {
      decision: 'QUARANTINE',
      candidate,
      existingFactId: oldFact.id,
      reason: `Conflicts with existing fact (${oldFact.objectText}); candidate not confident enough to replace it.`,
    };
  }
  return {
    decision: 'UPDATE',
    candidate,
    existingFactId: oldFact.id,
    reason: `Replaces existing fact: ${oldFact.objectText}.`,
  };
}

function pickNewestSummary(facts: ExistingFactSummary[]): ExistingFactSummary {
  return [...facts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

/** Summaries of the store's active facts for a scope (newest first). */
export function summarizeActiveFacts(
  store: TemporalGraphStore,
  scope: MemoryScope,
  limit = 50,
): ExistingFactSummary[] {
  return store
    .listFacts({ ...scope, status: 'active', limit })
    .map((f: GraphFact) => ({
      id: f.id,
      subjectName: store.getEntity(f.subjectId)?.name ?? 'user',
      predicate: f.predicate,
      objectText: f.objectText ?? '',
      confidence: f.confidence,
      updatedAt: f.updatedAt,
    }));
}

/** One-pass extractor interface: text in, decisions out, one pass. */
export interface OnePassExtractor {
  readonly name: string;
  /** Decide ADD/UPDATE/DELETE/NONE for one turn, in a single pass. */
  decide(
    text: string,
    scope: MemoryScope,
    sourceText: string,
    existing: ExistingFactSummary[],
  ): Promise<OnePassDecision[]>;
}

/**
 * Rule-based one-pass extractor: extract candidates once with the
 * deterministic rule extractor, decide each immediately against the
 * existing facts. Zero model calls, fully reproducible.
 */
export class RuleBasedOnePassExtractor implements OnePassExtractor {
  readonly name = 'rule-based-onepass-v1';
  private readonly extractor: FactExtractor;

  constructor(extractor: FactExtractor = new RuleBasedFactExtractor()) {
    this.extractor = extractor;
  }

  async decide(
    text: string,
    scope: MemoryScope,
    sourceText: string,
    existing: ExistingFactSummary[],
    opts: ConsolidateGraphOptions = {},
  ): Promise<OnePassDecision[]> {
    const candidates = await this.extractor.extract(text, scope, sourceText);
    if (candidates.length === 0) {
      const suspicious = suspiciousCandidateForText(text, sourceText);
      if (suspicious === null) return [];
      return [decideCandidateAgainstExisting(suspicious, existing, opts)];
    }
    return candidates.map((c) => decideCandidateAgainstExisting(c, existing, opts));
  }
}

export interface OllamaOnePassExtractorOptions {
  baseUrl?: string;
  /** Local chat model (default qwen2.5:0.5b — small, usually present). */
  model?: string;
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  /** Fallback when the LLM fails (default: rule-based one-pass). */
  fallback?: OnePassExtractor;
}

const ONE_PASS_SYSTEM_PROMPT =
  'You update a personal memory graph in ONE pass. ' +
  'Given one conversation turn and the existing facts, return ONLY a JSON array of decisions. ' +
  'Each item: {"subject":"user","predicate":"<one of likes,dislikes,lives_in,works_at,works_as,name_is,speaks,prefers,owns,wants,allergic_to,favorite_food,favorite_drink,favorite_movie,favorite_music,hobby,goal,birthday,location,states>","object":"<short fact, max 20 words>","decision":"ADD|UPDATE|DELETE|NONE","existingFactId":"<id from the existing facts list, or empty>","confidence":0.0-1.0,"reason":"<short>"}. ' +
  'Rules: ADD when no existing fact has the same subject+predicate; UPDATE when one does but with a different object (set existingFactId); DELETE when the turn says the fact no longer holds; NONE when the turn states nothing new or repeats an existing fact. ' +
  'Extract only facts the user states about themselves. If none, return [].';

/**
 * LLM one-pass extractor: a SINGLE Ollama chat call gets the turn +
 * existing facts and returns decisions. Any failure falls back to
 * the rule-based one-pass extractor — this class never throws.
 */
export class OllamaOnePassExtractor implements OnePassExtractor {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly timeoutMs: number;
  private readonly fallback: OnePassExtractor;

  constructor(opts: OllamaOnePassExtractorOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.model = opts.model ?? 'qwen2.5:0.5b';
    this.fetchFn = opts.fetchFn ?? ((url: string, init?: RequestInit) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.fallback = opts.fallback ?? new RuleBasedOnePassExtractor();
    this.name = `ollama-onepass:${this.model}`;
  }

  async decide(
    text: string,
    scope: MemoryScope,
    sourceText: string,
    existing: ExistingFactSummary[],
  ): Promise<OnePassDecision[]> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const existingLines = existing
          .slice(0, 20)
          .map((f) => `- [${f.id}] ${f.subjectName} ${f.predicate} ${f.objectText} (confidence ${f.confidence.toFixed(2)})`)
          .join('\n');
        const res = await this.fetchFn(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            stream: false,
            messages: [
              { role: 'system', content: ONE_PASS_SYSTEM_PROMPT },
              {
                role: 'user',
                content: `Existing facts:\n${existingLines || '(none)'}\n\nTurn:\n${text.slice(0, 4000)}`,
              },
            ],
          }),
          signal: controller.signal,
        });
        if (!res.ok) return this.fallback.decide(text, scope, sourceText, existing);
        const body = (await res.json()) as { message?: { content?: string } };
        const decisions = this.parseDecisions(body?.message?.content ?? '', sourceText);
        if (decisions.length === 0 && text.trim() !== '') {
          // LLM returned nothing parseable — fall back instead of
          // silently dropping the turn.
          return this.fallback.decide(text, scope, sourceText, existing);
        }
        return decisions;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return this.fallback.decide(text, scope, sourceText, existing);
    }
  }

  /** Parse + validate LLM decisions — drop anything malformed. */
  parseDecisions(content: string, sourceText: string): OnePassDecision[] {
    const out: OnePassDecision[] = [];
    const jsonText = extractJsonArray(content);
    if (jsonText === null) return out;
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText) as unknown;
    } catch {
      return out;
    }
    if (!Array.isArray(parsed)) return out;
    const allowed = new Set(['ADD', 'UPDATE', 'DELETE', 'NONE']);
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const rec = item as Record<string, unknown>;
      const subject = typeof rec.subject === 'string' ? rec.subject.trim() : '';
      const predicate = typeof rec.predicate === 'string' ? rec.predicate.trim() : '';
      const object = typeof rec.object === 'string' ? rec.object.trim() : '';
      const decision = typeof rec.decision === 'string' ? rec.decision.trim().toUpperCase() : '';
      if (subject === '' || object === '' || !isAllowedPredicate(predicate) || !allowed.has(decision)) continue;
      if (decision === 'NONE') continue;
      if ((decision === 'UPDATE' || decision === 'DELETE') && typeof rec.existingFactId !== 'string') continue;
      const confidence =
        typeof rec.confidence === 'number' && Number.isFinite(rec.confidence)
          ? Math.min(1, Math.max(0, rec.confidence))
          : 0.7;
      out.push({
        decision: decision as ConsolidationDecision,
        candidate: {
          subjectName: subject,
          kind: 'person',
          predicate: normalizeGraphText(predicate).replace(/\s+/g, '_'),
          objectText: object,
          objectIsEntity: predicate === 'lives_in' || predicate === 'works_at',
          confidence,
          sourceText: sourceText.slice(0, 500),
        },
        ...(typeof rec.existingFactId === 'string' && rec.existingFactId !== ''
          ? { existingFactId: rec.existingFactId }
          : {}),
        reason: typeof rec.reason === 'string' ? rec.reason.slice(0, 200) : 'LLM one-pass decision.',
      });
    }
    return out;
  }
}

/**
 * Apply one-pass decisions to the store. Suspicious candidates are
 * re-checked here (defence in depth — a decision produced by any
 * extractor still goes to quarantine when it matches a suspicious
 * pattern). Returns actions in the same shape as consolidateCandidates.
 */
export function applyOnePassDecisions(
  store: TemporalGraphStore,
  decisions: OnePassDecision[],
  scope: MemoryScope,
  provenanceBase: { turnId: string; runId: string; episodeId: string; at: string },
): { actions: ConsolidationAction[]; added: number; updated: number; deleted: number; quarantined: number; skipped: number; details: string[] } {
  const actions: ConsolidationAction[] = [];
  const details: string[] = [];
  let added = 0;
  let updated = 0;
  let deleted = 0;
  let quarantined = 0;
  let skipped = 0;

  for (const decision of decisions) {
    const { candidate } = decision;
    const predicate = normalizeGraphText(candidate.predicate).replace(/\s+/g, '_');
    const provenance = {
      episodeId: provenanceBase.episodeId,
      turnId: provenanceBase.turnId,
      runId: provenanceBase.runId,
      botId: scope.botId,
      userId: scope.userId,
      at: provenanceBase.at,
      sourceText: candidate.sourceText,
    };
    const suspicious = findSuspiciousPattern(candidate.sourceText) ?? findSuspiciousPattern(candidate.objectText);
    if (suspicious !== null) {
      const item = store.addToQuarantine({
        candidate: {
          subjectName: candidate.subjectName,
          predicate,
          objectText: candidate.objectText,
          confidence: candidate.confidence,
        },
        reason: 'suspicious-pattern',
        detail: `Suspicious pattern: ${suspicious}. Needs user review.`,
        scope,
        provenance,
      });
      quarantined += 1;
      actions.push({ decision: 'QUARANTINE', candidate, quarantineId: item.id, reason: `Suspicious pattern: ${suspicious}.` });
      details.push(`Quarantine (suspicious): ${candidate.subjectName} ${predicate} ${candidate.objectText}`);
      continue;
    }

    if (decision.decision === 'SKIP') {
      skipped += 1;
      actions.push({ decision: 'SKIP', candidate, ...(decision.existingFactId ? { factId: decision.existingFactId } : {}), reason: decision.reason });
      continue;
    }
    if (decision.decision === 'QUARANTINE') {
      const item = store.addToQuarantine({
        candidate: {
          subjectName: candidate.subjectName,
          predicate,
          objectText: candidate.objectText,
          confidence: candidate.confidence,
        },
        reason: 'conflict',
        detail: decision.reason.slice(0, 1000),
        ...(decision.existingFactId ? { conflictingFactId: decision.existingFactId } : {}),
        scope,
        provenance,
      });
      quarantined += 1;
      actions.push({ decision: 'QUARANTINE', candidate, quarantineId: item.id, ...(decision.existingFactId ? { affectedFactId: decision.existingFactId } : {}), reason: decision.reason });
      details.push(`Quarantine: ${candidate.subjectName} ${predicate} ${candidate.objectText}`);
      continue;
    }
    if (decision.decision === 'DELETE') {
      const target = decision.existingFactId
        ? store.getFact(decision.existingFactId)
        : store.findActiveFacts(candidate.subjectName, predicate, scope).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (!target || target.status !== 'active') {
        skipped += 1;
        actions.push({ decision: 'SKIP', candidate, reason: 'DELETE but no active fact to delete.' });
        continue;
      }
      store.deleteFact(target.id, `onepass:${scope.botId}`);
      deleted += 1;
      actions.push({ decision: 'DELETE', candidate, affectedFactId: target.id, reason: decision.reason });
      details.push(`Deleted: ${candidate.subjectName} ${predicate} ${target.objectText}`);
      continue;
    }
    if (decision.decision === 'UPDATE') {
      const target = decision.existingFactId
        ? store.getFact(decision.existingFactId)
        : store.findActiveFacts(candidate.subjectName, predicate, scope).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (!target || target.status !== 'active') {
        // No fact to update — fall through to ADD.
        const fact = store.addFact({
          subjectName: candidate.subjectName,
          kind: candidate.kind,
          predicate,
          objectText: candidate.objectText,
          objectIsEntity: candidate.objectIsEntity,
          confidence: candidate.confidence,
          scope,
          provenance,
        });
        added += 1;
        actions.push({ decision: 'ADD', candidate, factId: fact.id, reason: `${decision.reason} (no existing fact — added instead).` });
        details.push(`Added: ${candidate.subjectName} ${predicate} ${candidate.objectText}`);
        continue;
      }
      const created = store.supersedeFact(target.id, {
        subjectName: candidate.subjectName,
        kind: candidate.kind,
        predicate,
        objectText: candidate.objectText,
        objectIsEntity: candidate.objectIsEntity,
        confidence: candidate.confidence,
        scope,
        provenance,
      });
      updated += 1;
      actions.push({ decision: 'UPDATE', candidate, factId: created.id, affectedFactId: target.id, reason: decision.reason });
      details.push(`Updated: ${candidate.subjectName} ${predicate} ${target.objectText} -> ${candidate.objectText}`);
      continue;
    }
    // ADD
    const fact = store.addFact({
      subjectName: candidate.subjectName,
      kind: candidate.kind,
      predicate,
      objectText: candidate.objectText,
      objectIsEntity: candidate.objectIsEntity,
      confidence: candidate.confidence,
      scope,
      provenance,
    });
    added += 1;
    actions.push({ decision: 'ADD', candidate, factId: fact.id, reason: decision.reason });
    details.push(`Added: ${candidate.subjectName} ${predicate} ${candidate.objectText}`);
  }

  return { actions, added, updated, deleted, quarantined, skipped, details };
}

/**
 * Full one-pass run over a turn: extract once (rule-based by
 * default, or the injected extractor), then consolidate in the same
 * call. Returns the same counts shape as `consolidateCandidates`
 * plus extraction metadata, so callers can swap the two-pass
 * pipeline for this one without changing their reporting.
 */
export async function onePassConsolidate(
  store: TemporalGraphStore,
  text: string,
  scope: MemoryScope,
  provenanceBase: { turnId: string; runId: string; episodeId: string; at: string },
  opts: { extractor?: FactExtractor; consolidateOpts?: ConsolidateGraphOptions } = {},
): Promise<OnePassResult> {
  const ranAt = new Date().toISOString();
  const extractor = opts.extractor ?? new RuleBasedFactExtractor();
  const candidates = await extractor.extract(text, scope, text);
  const effective = candidates.length === 0
    ? (() => {
        const suspicious = suspiciousCandidateForText(text, text);
        return suspicious ? [suspicious] : [];
      })()
    : candidates;
  const result = consolidateCandidates(store, effective, scope, provenanceBase, opts.consolidateOpts ?? {});
  return {
    ranAt,
    extractor: extractor.name,
    modelCalls: 0,
    examined: result.examined,
    added: result.added,
    updated: result.updated,
    deleted: result.deleted,
    quarantined: result.quarantined,
    skipped: result.skipped,
    actions: result.actions,
    details: result.details,
  };
}
