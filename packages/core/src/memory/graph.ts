/**
 * Temporal knowledge graph (v0.97, Team T4 — Memory v2).
 *
 * Idea learned from Zep/Graphiti (temporal knowledge graph) and Mem0 v3
 * (graph memory): facts live in a graph of entities + relations, and
 * every node/edge carries a bi-temporal validity window:
 *  - `validFrom` / `validTo` — when the fact was TRUE in the world
 *    (valid time; `validTo` null = still true as far as we know);
 *  - `recordedAt` — when open-bot LEARNED it (transaction time).
 * Asking "what did we know on 2026-06-01?" and "what is true now?"
 * are therefore different, answerable queries instead of guesses.
 *
 * The graph is built INCREMENTALLY from conversation episodes: each
 * episode (one user/bot turn pair) contributes entities and relations
 * extracted by the sleep agent; nothing here calls a model — extraction
 * is deterministic pattern matching in sleepAgent.ts, this module only
 * stores, merges and queries.
 *
 * Storage: one JSON file per workspace
 * `<workspace>/.open-bot/memory-graph.json` (atomic temp + rename,
 * mode 0600, same pattern as MemoryBlockStore). Entities are deduped
 * by normalised name + type; adding the same relation twice extends
 * its validity window instead of duplicating the edge.
 *
 * Every entity/relation carries a `MemoryProvenance`-compatible
 * `provenance` field (source, botId, recordedAt, trust, flags) so the
 * provenance/quota layer (provenance.ts) applies to the graph too.
 * Quarantined items are stored but never returned by queries.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MemoryProvenance } from './provenance';
import { createProvenance, checkQuota, DEFAULT_MEMORY_QUOTA } from './provenance';
import type { MemoryQuota, MemoryQuotaUsage } from './provenance';

export const MEMORY_GRAPH_REL_PATH = path.join('.open-bot', 'memory-graph.json');
/** Max length of an entity name / relation label (keeps the file sane). */
export const MAX_GRAPH_NAME_LENGTH = 200;
/** Max relations returned by one neighbours query (before pagination). */
export const MAX_GRAPH_NEIGHBOURS = 100;

export type GraphEntityType = 'person' | 'place' | 'thing' | 'event' | 'concept' | 'project';

export interface GraphEntity {
  id: string;
  /** Display name, e.g. "Huy", "Pho 24", "open-bot". */
  name: string;
  type: GraphEntityType;
  /** Short free-form description (may be empty). */
  description: string;
  /** Alternative names / spellings that refer to the same entity. */
  aliases: string[];
  /** When the entity itself was true/relevant (null = open-ended). */
  validFrom: string | null;
  validTo: string | null;
  /** When open-bot learned about this entity. */
  recordedAt: string;
  updatedAt: string;
  provenance: MemoryProvenance;
}

export interface GraphRelation {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  /** Relation label, e.g. "likes", "works-on", "located-in", "prefers". */
  label: string;
  /** Optional free-form detail, e.g. "every Sunday morning". */
  detail: string;
  /** Validity window of the relation (null bound = open-ended). */
  validFrom: string | null;
  validTo: string | null;
  recordedAt: string;
  updatedAt: string;
  provenance: MemoryProvenance;
}

export interface MemoryGraphFile {
  version: 1;
  entities: GraphEntity[];
  relations: GraphRelation[];
}

export interface AddEntityInput {
  name: string;
  type?: GraphEntityType;
  description?: string;
  aliases?: string[];
  validFrom?: string | null;
  validTo?: string | null;
  source?: MemoryProvenance['source'];
  botId?: string;
  origin?: string;
}

export interface AddRelationInput {
  fromEntityId?: string;
  fromName?: string;
  toEntityId?: string;
  toName?: string;
  label: string;
  detail?: string;
  validFrom?: string | null;
  validTo?: string | null;
  source?: MemoryProvenance['source'];
  botId?: string;
  origin?: string;
}

export interface GraphQueryOptions {
  /** Only items valid at this instant (ISO). Default: now. */
  at?: string;
  /** True = ignore the validity window (list everything, e.g. for export). */
  allTime?: boolean;
  /** Only items recorded at or after this instant (transaction time). */
  recordedAfter?: string;
  /** Only items recorded at or before this instant. */
  recordedBefore?: string;
  /** Filter by entity type (entities only). */
  type?: GraphEntityType;
  /** Minimum trust score (0..1). Default: 0 (include everything). */
  minTrust?: number;
  /** Include quarantined items (default false — never in prompt recall). */
  includeQuarantined?: boolean;
  limit?: number;
}

export interface GraphStats {
  entities: number;
  relations: number;
  quarantinedEntities: number;
  quarantinedRelations: number;
  types: Record<string, number>;
  labels: Record<string, number>;
}

/** Normalise an entity name for dedup: lowercase, strip diacritics, collapse space. */
export function normalizeEntityName(name: string): string {
  return (name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalise a relation label: lowercase slug with dashes. */
export function normalizeRelationLabel(label: string): string {
  return (label ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function isValidIso(value: string | null | undefined): value is string {
  if (value === null || value === undefined) return false;
  return Number.isFinite(Date.parse(value));
}

/** True when the validity window covers `at` (open bounds count as covering). */
export function isValidAt(
  item: { validFrom: string | null; validTo: string | null },
  at: string,
): boolean {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return false;
  if (item.validFrom !== null && Date.parse(item.validFrom) > t) return false;
  if (item.validTo !== null && Date.parse(item.validTo) < t) return false;
  return true;
}

/** True when two validity windows overlap (open bounds overlap everything on that side). */
export function windowsOverlap(
  a: { validFrom: string | null; validTo: string | null },
  b: { validFrom: string | null; validTo: string | null },
): boolean {
  const aFrom = a.validFrom === null ? -Infinity : Date.parse(a.validFrom);
  const aTo = a.validTo === null ? Infinity : Date.parse(a.validTo);
  const bFrom = b.validFrom === null ? -Infinity : Date.parse(b.validFrom);
  const bTo = b.validTo === null ? Infinity : Date.parse(b.validTo);
  return aFrom <= bTo && bFrom <= aTo;
}

function emptyGraph(): MemoryGraphFile {
  return { version: 1, entities: [], relations: [] };
}

/**
 * Temporal knowledge graph store (JSON file, atomic writes).
 * All mutating methods persist immediately; all query methods are
 * pure reads over the in-memory snapshot loaded at construction
 * (reload with `reload()` after another process wrote the file).
 */
export class TemporalKnowledgeGraph {
  private readonly filePath: string;
  private data: MemoryGraphFile;

  constructor(workspaceDir: string) {
    this.filePath = path.join(workspaceDir, MEMORY_GRAPH_REL_PATH);
    this.data = this.load();
  }

  get path(): string {
    return this.filePath;
  }

  private load(): MemoryGraphFile {
    try {
      if (!fs.existsSync(this.filePath)) return emptyGraph();
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as MemoryGraphFile;
      if (!parsed || !Array.isArray(parsed.entities) || !Array.isArray(parsed.relations)) {
        return emptyGraph();
      }
      return parsed;
    } catch {
      return emptyGraph();
    }
  }

  reload(): void {
    this.data = this.load();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  /** Current quota usage (for `checkQuota` before a batch insert). */
  usage(): MemoryQuotaUsage {
    return {
      items: this.data.entities.length + this.data.relations.length,
      chars: this.data.entities.reduce((n, e) => n + e.name.length + e.description.length, 0),
      graphEntities: this.data.entities.length,
      graphRelations: this.data.relations.length,
    };
  }

  private checkGraphQuota(incomingEntities: number, incomingRelations: number, quota: MemoryQuota): void {
    const result = checkQuota(
      this.usage(),
      { graphEntities: incomingEntities, graphRelations: incomingRelations },
      quota,
    );
    if (!result.allowed) throw new Error(`Memory graph quota exceeded: ${result.detail}`);
  }

  listEntities(opts: GraphQueryOptions = {}): GraphEntity[] {
    const at = opts.at ?? new Date().toISOString();
    return this.data.entities
      .filter((e) => (opts.includeQuarantined === true ? true : !e.provenance.quarantined))
      .filter((e) => (opts.type ? e.type === opts.type : true))
      .filter((e) => (opts.minTrust !== undefined ? e.provenance.trust >= opts.minTrust : true))
      .filter((e) => (opts.allTime === true ? true : isValidAt(e, at)))
      .filter((e) => (opts.recordedAfter ? e.recordedAt >= opts.recordedAfter : true))
      .filter((e) => (opts.recordedBefore ? e.recordedAt <= opts.recordedBefore : true))
      .slice(0, opts.limit ?? 200);
  }

  getEntity(id: string): GraphEntity | undefined {
    return this.data.entities.find((e) => e.id === id);
  }

  /** Find an entity by name or alias (normalised, case/diacritic-insensitive). */
  findEntityByName(name: string): GraphEntity | undefined {
    const needle = normalizeEntityName(name);
    if (needle === '') return undefined;
    return this.data.entities.find(
      (e) =>
        normalizeEntityName(e.name) === needle ||
        e.aliases.some((a) => normalizeEntityName(a) === needle),
    );
  }

  listRelations(opts: GraphQueryOptions & { entityId?: string; label?: string } = {}): GraphRelation[] {
    const at = opts.at ?? new Date().toISOString();
    return this.data.relations
      .filter((r) => (opts.includeQuarantined === true ? true : !r.provenance.quarantined))
      .filter((r) => (opts.entityId ? r.fromEntityId === opts.entityId || r.toEntityId === opts.entityId : true))
      .filter((r) => (opts.label ? normalizeRelationLabel(r.label) === normalizeRelationLabel(opts.label) : true))
      .filter((r) => (opts.minTrust !== undefined ? r.provenance.trust >= opts.minTrust : true))
      .filter((r) => (opts.allTime === true ? true : isValidAt(r, at)))
      .filter((r) => (opts.recordedAfter ? r.recordedAt >= opts.recordedAfter : true))
      .filter((r) => (opts.recordedBefore ? r.recordedAt <= opts.recordedBefore : true))
      .slice(0, opts.limit ?? 200);
  }

  getRelation(id: string): GraphRelation | undefined {
    return this.data.relations.find((r) => r.id === id);
  }

  /**
   * Add an entity, or merge into the existing one with the same
   * normalised name + type: aliases and description are unioned, the
   * validity window widens to cover both, and `updatedAt` moves.
   * Returns `{ entity, created }`.
   */
  addEntity(input: AddEntityInput, quota: MemoryQuota = DEFAULT_MEMORY_QUOTA): { entity: GraphEntity; created: boolean } {
    const name = (input.name ?? '').trim();
    if (name === '') throw new Error('Entity name must not be empty.');
    if (name.length > MAX_GRAPH_NAME_LENGTH) {
      throw new Error(`Entity name must be at most ${MAX_GRAPH_NAME_LENGTH} characters.`);
    }
    const type = input.type ?? 'concept';
    const now = new Date().toISOString();
    const existing = this.data.entities.find(
      (e) => e.type === type && normalizeEntityName(e.name) === normalizeEntityName(name),
    );
    if (existing) {
      const aliases = new Set([...existing.aliases, ...(input.aliases ?? [])].map((a) => a.trim()).filter(Boolean));
      existing.aliases = [...aliases];
      if (input.description && input.description.trim() !== '' && !existing.description.includes(input.description.trim())) {
        existing.description = existing.description
          ? `${existing.description} ${input.description.trim()}`
          : input.description.trim();
      }
      if (input.validFrom && (existing.validFrom === null || input.validFrom < existing.validFrom)) {
        existing.validFrom = input.validFrom;
      }
      if (input.validTo && (existing.validTo === null || input.validTo > existing.validTo)) {
        existing.validTo = input.validTo;
      }
      existing.updatedAt = now;
      this.save();
      return { entity: existing, created: false };
    }
    this.checkGraphQuota(1, 0, quota);
    const provenance = createProvenance({
      source: input.source ?? 'bot',
      botId: input.botId ?? '',
      origin: input.origin,
      text: `${name} ${input.description ?? ''}`,
      recordedAt: now,
    });
    const entity: GraphEntity = {
      id: randomUUID(),
      name,
      type,
      description: (input.description ?? '').trim(),
      aliases: [...new Set((input.aliases ?? []).map((a) => a.trim()).filter(Boolean))],
      validFrom: isValidIso(input.validFrom) ? (input.validFrom as string) : null,
      validTo: isValidIso(input.validTo) ? (input.validTo as string) : null,
      recordedAt: now,
      updatedAt: now,
      provenance,
    };
    this.data.entities.push(entity);
    this.save();
    return { entity, created: true };
  }

  /**
   * Add a relation between two entities (resolved by id or by name —
   * missing entities are auto-created as `concept`). Adding the same
   * (from, label, to) twice widens the validity window instead of
   * duplicating the edge. Returns `{ relation, created }`.
   */
  addRelation(input: AddRelationInput, quota: MemoryQuota = DEFAULT_MEMORY_QUOTA): { relation: GraphRelation; created: boolean } {
    const label = normalizeRelationLabel(input.label);
    if (label === '') throw new Error('Relation label must not be empty.');
    const from = this.resolveEntity(input.fromEntityId, input.fromName, input.botId, input.source);
    const to = this.resolveEntity(input.toEntityId, input.toName, input.botId, input.source);
    if (from.id === to.id) throw new Error('A relation cannot link an entity to itself.');
    const now = new Date().toISOString();
    const existing = this.data.relations.find(
      (r) => r.fromEntityId === from.id && r.toEntityId === to.id && normalizeRelationLabel(r.label) === label,
    );
    if (existing) {
      if (input.detail && input.detail.trim() !== '' && !existing.detail.includes(input.detail.trim())) {
        existing.detail = existing.detail ? `${existing.detail}; ${input.detail.trim()}` : input.detail.trim();
      }
      if (input.validFrom && (existing.validFrom === null || input.validFrom < existing.validFrom)) {
        existing.validFrom = input.validFrom;
      }
      if (input.validTo && (existing.validTo === null || input.validTo > existing.validTo)) {
        existing.validTo = input.validTo;
      }
      existing.updatedAt = now;
      this.save();
      return { relation: existing, created: false };
    }
    this.checkGraphQuota(0, 1, quota);
    const provenance = createProvenance({
      source: input.source ?? 'bot',
      botId: input.botId ?? '',
      origin: input.origin,
      text: `${from.name} ${label} ${to.name} ${input.detail ?? ''}`,
      recordedAt: now,
    });
    const relation: GraphRelation = {
      id: randomUUID(),
      fromEntityId: from.id,
      toEntityId: to.id,
      label,
      detail: (input.detail ?? '').trim(),
      validFrom: isValidIso(input.validFrom) ? (input.validFrom as string) : null,
      validTo: isValidIso(input.validTo) ? (input.validTo as string) : null,
      recordedAt: now,
      updatedAt: now,
      provenance,
    };
    this.data.relations.push(relation);
    this.save();
    return { relation, created: true };
  }

  private resolveEntity(
    id: string | undefined,
    name: string | undefined,
    botId?: string,
    source?: MemoryProvenance['source'],
  ): GraphEntity {
    if (id) {
      const found = this.getEntity(id);
      if (found) return found;
      throw new Error(`Entity not found: ${id}`);
    }
    const trimmed = (name ?? '').trim();
    if (trimmed === '') throw new Error('Relation endpoint needs an entity id or a name.');
    const found = this.findEntityByName(trimmed);
    if (found) return found;
    return this.addEntity({ name: trimmed, botId, source }).entity;
  }

  /** End a relation's validity at `validTo` (supersede, do not delete history). */
  endRelation(id: string, validTo: string): GraphRelation {
    const relation = this.getRelation(id);
    if (!relation) throw new Error(`Relation not found: ${id}`);
    if (!isValidIso(validTo)) throw new Error('validTo must be an ISO date string.');
    relation.validTo = validTo;
    relation.updatedAt = new Date().toISOString();
    this.save();
    return relation;
  }

  /** End an entity's validity at `validTo` (supersede, do not delete history). */
  endEntity(id: string, validTo: string): GraphEntity {
    const entity = this.getEntity(id);
    if (!entity) throw new Error(`Entity not found: ${id}`);
    if (!isValidIso(validTo)) throw new Error('validTo must be an ISO date string.');
    entity.validTo = validTo;
    entity.updatedAt = new Date().toISOString();
    this.save();
    return entity;
  }

  deleteEntity(id: string): boolean {
    const before = this.data.entities.length;
    this.data.entities = this.data.entities.filter((e) => e.id !== id);
    const removedRelations = this.data.relations.filter((r) => r.fromEntityId === id || r.toEntityId === id).length;
    this.data.relations = this.data.relations.filter((r) => r.fromEntityId !== id && r.toEntityId !== id);
    if (this.data.entities.length === before && removedRelations === 0) return false;
    this.save();
    return true;
  }

  deleteRelation(id: string): boolean {
    const before = this.data.relations.length;
    this.data.relations = this.data.relations.filter((r) => r.id !== id);
    if (this.data.relations.length === before) return false;
    this.save();
    return true;
  }

  /** Quarantine / unquarantine an entity (excluded from queries while quarantined). */
  setEntityQuarantined(id: string, quarantined: boolean): GraphEntity {
    const entity = this.getEntity(id);
    if (!entity) throw new Error(`Entity not found: ${id}`);
    entity.provenance.quarantined = quarantined;
    entity.updatedAt = new Date().toISOString();
    this.save();
    return entity;
  }

  setRelationQuarantined(id: string, quarantined: boolean): GraphRelation {
    const relation = this.getRelation(id);
    if (!relation) throw new Error(`Relation not found: ${id}`);
    relation.provenance.quarantined = quarantined;
    relation.updatedAt = new Date().toISOString();
    this.save();
    return relation;
  }

  /**
   * Neighbours of an entity at time `at`: every relation touching it
   * (valid at that time) plus the entity on the other end, with the
   * relation label and direction. Depth 1 only — depth-2 traversal
   * lives in hybridSearch (graph expansion step).
   */
  neighbours(
    entityId: string,
    opts: GraphQueryOptions = {},
  ): Array<{ relation: GraphRelation; other: GraphEntity; direction: 'out' | 'in' }> {
    const at = opts.at ?? new Date().toISOString();
    const out: Array<{ relation: GraphRelation; other: GraphEntity; direction: 'out' | 'in' }> = [];
    for (const relation of this.listRelations({ ...opts, entityId, limit: MAX_GRAPH_NEIGHBOURS })) {
      void at;
      const isOut = relation.fromEntityId === entityId;
      const other = this.getEntity(isOut ? relation.toEntityId : relation.fromEntityId);
      if (!other) continue;
      if (opts.includeQuarantined !== true && other.provenance.quarantined) continue;
      out.push({ relation, other, direction: isOut ? 'out' : 'in' });
    }
    return out;
  }

  /** Snapshot of the graph as it was valid at `at` (entities + relations). */
  snapshotAt(at: string): { entities: GraphEntity[]; relations: GraphRelation[] } {
    return {
      entities: this.listEntities({ at, limit: 10000 }),
      relations: this.listRelations({ at, limit: 10000 }),
    };
  }

  stats(): GraphStats {
    const types: Record<string, number> = {};
    const labels: Record<string, number> = {};
    for (const e of this.data.entities) types[e.type] = (types[e.type] ?? 0) + 1;
    for (const r of this.data.relations) labels[r.label] = (labels[r.label] ?? 0) + 1;
    return {
      entities: this.data.entities.length,
      relations: this.data.relations.length,
      quarantinedEntities: this.data.entities.filter((e) => e.provenance.quarantined).length,
      quarantinedRelations: this.data.relations.filter((r) => r.provenance.quarantined).length,
      types,
      labels,
    };
  }
}

/** One parsed entity line from a Markdown graph export. */
export interface ParsedGraphEntity {
  name: string;
  type: GraphEntityType;
  description: string;
  validFrom: string | null;
  validTo: string | null;
}

/** One parsed relation line from a Markdown graph export. */
export interface ParsedGraphRelation {
  fromName: string;
  toName: string;
  label: string;
  detail: string;
  validFrom: string | null;
  validTo: string | null;
}

export interface ParsedGraphMarkdown {
  entities: ParsedGraphEntity[];
  relations: ParsedGraphRelation[];
  /** Lines that could not be parsed (reported, not thrown). */
  skipped: string[];
}

function formatValidity(validFrom: string | null, validTo: string | null): string {
  if (validFrom === null && validTo === null) return '';
  const from = validFrom ? validFrom.slice(0, 10) : '…';
  const to = validTo ? validTo.slice(0, 10) : '…';
  return ` [${from} → ${to}]`;
}

/**
 * Export the graph as human-readable Markdown (MemFS-style, for
 * backup / review / hand-editing). Format (stable, parseable by
 * `parseGraphMarkdown`):
 *   - `- **Name** (type): description [YYYY-MM-DD → YYYY-MM-DD]`
 *   - `- From --label--> To (detail) [YYYY-MM-DD → YYYY-MM-DD]`
 * Quarantined items are exported too, marked `[quarantined]`, so a
 * review can see what was hidden from queries.
 */
export function exportGraphToMarkdown(graph: TemporalKnowledgeGraph): string {
  const lines: string[] = ['# Knowledge graph', '', '## Entities', ''];
  for (const entity of graph.listEntities({ includeQuarantined: true, allTime: true, limit: 10000 })) {
    const validity = formatValidity(entity.validFrom, entity.validTo);
    const flag = entity.provenance.quarantined ? ' [quarantined]' : '';
    const description = entity.description !== '' ? `: ${entity.description}` : '';
    lines.push(`- **${entity.name}** (${entity.type})${description}${validity}${flag}`);
  }
  lines.push('', '## Relations', '');
  for (const relation of graph.listRelations({ includeQuarantined: true, allTime: true, limit: 10000 })) {
    const from = graph.getEntity(relation.fromEntityId)?.name ?? relation.fromEntityId;
    const to = graph.getEntity(relation.toEntityId)?.name ?? relation.toEntityId;
    const validity = formatValidity(relation.validFrom, relation.validTo);
    const flag = relation.provenance.quarantined ? ' [quarantined]' : '';
    const detail = relation.detail !== '' ? ` (${relation.detail})` : '';
    lines.push(`- ${from} --${relation.label}--> ${to}${detail}${validity}${flag}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Parse Markdown produced by `exportGraphToMarkdown` back into plain
 * entities/relations (caller decides whether to insert them — this
 * function never writes). Unknown lines are collected in `skipped`
 * instead of throwing, so a hand-edited file imports partially
 * rather than failing entirely.
 */
export function parseGraphMarkdown(text: string): ParsedGraphMarkdown {
  const entities: ParsedGraphEntity[] = [];
  const relations: ParsedGraphRelation[] = [];
  const skipped: string[] = [];
  let section: 'entities' | 'relations' | null = null;
  const entityRe = /^-\s+\*\*(.+?)\*\*\s+\((person|place|thing|event|concept|project)\)(?::\s*(.*?))?\s*(?:\[(\d{4}-\d{2}-\d{2}|…)\s*→\s*(\d{4}-\d{2}-\d{2}|…)\])?\s*(?:\[quarantined\])?\s*$/;
  const relationRe = /^-\s+(.+?)\s+--([a-z0-9-]+)-->\s+(.+?)(?:\s+\((.*?)\))?\s*(?:\[(\d{4}-\d{2}-\d{2}|…)\s*→\s*(\d{4}-\d{2}-\d{2}|…)\])?\s*(?:\[quarantined\])?\s*$/;
  for (const rawLine of (text ?? '').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      if (line === '## Entities') section = 'entities';
      if (line === '## Relations') section = 'relations';
      continue;
    }
    if (!line.startsWith('- ')) {
      skipped.push(rawLine);
      continue;
    }
    if (section === 'entities') {
      const m = line.match(entityRe);
      if (!m) {
        skipped.push(rawLine);
        continue;
      }
      entities.push({
        name: (m[1] as string).trim(),
        type: (m[2] as GraphEntityType),
        description: ((m[3] as string | undefined) ?? '').trim(),
        validFrom: m[4] && m[4] !== '…' ? `${m[4]}T00:00:00.000Z` : null,
        validTo: m[5] && m[5] !== '…' ? `${m[5]}T00:00:00.000Z` : null,
      });
      continue;
    }
    if (section === 'relations') {
      const m = line.match(relationRe);
      if (!m) {
        skipped.push(rawLine);
        continue;
      }
      relations.push({
        fromName: (m[1] as string).trim(),
        toName: (m[3] as string).trim(),
        label: (m[2] as string).trim(),
        detail: ((m[4] as string | undefined) ?? '').trim(),
        validFrom: m[5] && m[5] !== '…' ? `${m[5]}T00:00:00.000Z` : null,
        validTo: m[6] && m[6] !== '…' ? `${m[6]}T00:00:00.000Z` : null,
      });
      continue;
    }
    skipped.push(rawLine);
  }
  return { entities, relations, skipped };
}

/**
 * One-line summary of an entity for prompt use: name + type +
 * description + its relations ("Huy (person): likes pho; lives in
 * Hanoi"). Returns null when the entity does not exist. Only
 * currently-valid relations are listed (default: now).
 */
export function describeEntity(
  graph: TemporalKnowledgeGraph,
  entityId: string,
  at = new Date().toISOString(),
): string | null {
  const entity = graph.getEntity(entityId);
  if (!entity) return null;
  const parts: string[] = [];
  for (const { relation, other, direction } of graph.neighbours(entityId, { at })) {
    if (direction === 'out') parts.push(`${relation.label} ${other.name}`);
    else parts.push(`${other.name} ${relation.label} (reverse)`);
  }
  const head = `${entity.name} (${entity.type})${entity.description !== '' ? `: ${entity.description}` : ''}`;
  return parts.length > 0 ? `${head} — ${parts.join('; ')}` : head;
}
