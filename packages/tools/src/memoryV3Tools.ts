/**
 * Memory v3 tools for @open-bot/tools (v1.02, Team T2).
 *
 * The agent works with the v3 memory system by tool call:
 *  - memory_v3_fused_search      — fused retrieval (hybrid + entity
 *    search, merged across the run/agent/user/app scope hierarchy)
 *    (read)
 *  - memory_v3_one_pass_ingest   — ingest ONE turn with Mem0-style
 *    one-pass extraction + consolidation (needsApproval: true)
 *  - memory_v3_temporal_query    — facts that were true at a time T
 *    (read)
 *  - memory_v3_contradictions    — "what did the user say in window
 *    A that contradicts window B", with timestamped evidence (read)
 *  - memory_v3_entity_timeline   — chronological history of one
 *    entity (read)
 *  - memory_v3_sleep_maintenance — Letta-style idle maintenance:
 *    dedupe, promote, prune, digest (needsApproval: true)
 *  - memory_block_history        — version history of a memory block
 *    (read)
 *  - memory_block_restore        — restore a block to an older
 *    version (as a NEW version; needsApproval: true)
 *  - memory_block_conflicts      — list / resolve block conflicts
 *    (needsApproval: true, same pattern as memory_graph_quarantine)
 *
 * SAFETY: reads never return vector embeddings; writes go through
 * the stores (validation + provenance); conflicts and suspicious
 * content are never auto-applied — one-pass ingest reuses the same
 * quarantine rules as the two-pass pipeline.
 *
 * Factory:
 *   createMemoryV3Tools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V3_TOOLS                       (unbound placeholder)
 */
import type {
  FactExtractor,
  GraphFact,
  MemoryBlockStore,
  OllamaEmbeddings,
  TemporalGraphStore,
  Tool,
} from '@open-bot/core';
import {
  BlockConflictStore,
  RuleBasedFactExtractor,
  findContradictionsBetween,
  entityTimeline,
  formatContradiction,
  fusedRetrieve,
  onePassConsolidate,
  queryFactsAt,
  runSleepMaintenance,
} from '@open-bot/core';

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
}

function getBoolArg(args: Record<string, unknown>, name: string, defaultValue: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
  }
  return value;
}

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

export interface MemoryV3ToolOptions {
  /** Temporal graph store of the workspace (required for tools to run). */
  graphStore?: TemporalGraphStore;
  /** Workspace dir of the bot (block history/conflicts live here). */
  workspaceDir?: string;
  /** Memory block store (required for block history/restore/conflicts). */
  blocksStore?: MemoryBlockStore;
  /** Embedder for the semantic source (absent = Ollama default in hybrid search). */
  embedder?: OllamaEmbeddings;
  /** Fact extractor for one-pass ingest (default: deterministic rules, no model). */
  extractor?: FactExtractor;
  /** Current userId (from profile.json); absent = no user filter. */
  getUserId?: () => string | undefined;
  /** App scope id for the workspace (absent = no app scope). */
  appId?: string;
}

/** Fact returned to the model/UI: no vector embedding. */
function publicFact(store: TemporalGraphStore, fact: GraphFact) {
  const subject = store.getEntity(fact.subjectId);
  const object = fact.objectId ? store.getEntity(fact.objectId) : undefined;
  return {
    id: fact.id,
    subject: subject?.name ?? fact.subjectId,
    predicate: fact.predicate,
    object: object?.name ?? fact.objectText ?? '',
    objectIsEntity: object !== undefined,
    validFrom: fact.validFrom,
    validUntil: fact.validUntil,
    ...(fact.supersedes ? { supersedes: fact.supersedes } : {}),
    ...(fact.supersededBy ? { supersededBy: fact.supersededBy } : {}),
    confidence: fact.confidence,
    status: fact.status,
    scope: fact.scope,
    provenance: fact.provenance,
    createdAt: fact.createdAt,
    updatedAt: fact.updatedAt,
  };
}

export function createMemoryV3Tools(opts: MemoryV3ToolOptions = {}): Tool[] {
  const { graphStore, blocksStore, workspaceDir } = opts;
  const extractor: FactExtractor = opts.extractor ?? new RuleBasedFactExtractor();
  const userIdOf = (): string | undefined => {
    try {
      const id = opts.getUserId?.();
      return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
    } catch {
      return undefined;
    }
  };
  const needStore = (): TemporalGraphStore => {
    if (!graphStore) {
      throw new Error(
        'memory v3 graph store is not available in this session (host must pass graphStore to createMemoryV3Tools).',
      );
    }
    return graphStore;
  };
  const needBlocks = (): MemoryBlockStore => {
    if (!blocksStore) {
      throw new Error(
        'memory block store is not available in this session (host must pass blocksStore to createMemoryV3Tools).',
      );
    }
    return blocksStore;
  };
  const needWorkspaceDir = (): string => {
    if (!workspaceDir) throw new Error('workspaceDir is required for block conflicts (host must pass it).');
    return workspaceDir;
  };
  const scopeOf = (ctx: { botId: string; runId?: string }) => ({
    userId: userIdOf() ?? '',
    botId: ctx.botId,
    runId: ctx.runId ?? '',
    ...(opts.appId ? { appId: opts.appId } : {}),
  });

  const fusedSearch: Tool = {
    definition: toolDef(
      'memory_v3_fused_search',
      'Fused memory retrieval: hybrid search (semantic + BM25 + graph traversal) over the run/agent/user/app scope hierarchy, plus entity search by name/alias, merged by scope-weighted Reciprocal Rank Fusion. A run-level query also recalls agent, user and app memories; another user\'s facts never leak in. Read-only.',
      {
        query: { type: 'string', description: 'Question / keywords to recall from memory.' },
        topK: { type: 'number', description: 'Max results (default 10, max 50).' },
        includeInheritedScopes: { type: 'boolean', description: 'Search the whole scope hierarchy (default true). False = only facts stored at exactly the current scope level.' },
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const query = getStringArg(args, 'query');
        const result = await fusedRetrieve(s, query, scopeOf(ctx), {
          topK: getNumberArg(args, 'topK'),
          includeInheritedScopes: getBoolArg(args, 'includeInheritedScopes', true),
          ...(opts.embedder ? { embedder: opts.embedder } : {}),
          skipSemantic: !opts.embedder,
        });
        return JSON.stringify(
          {
            query: result.query,
            scopesSearched: result.scopesSearched,
            sourcesUsed: result.sourcesUsed,
            notes: result.notes,
            hits: result.hits.map((h) => ({
              fact: publicFact(s, h.fact),
              score: Math.round(h.score * 10000) / 10000,
              sources: h.sources,
              scopeLevels: h.scopeLevels,
              factScopeLevel: h.factScopeLevel,
            })),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const onePassIngest: Tool = {
    definition: toolDef(
      'memory_v3_one_pass_ingest',
      'Ingest ONE conversation turn with Mem0-style one-pass extraction + consolidation: extract candidate facts and decide ADD / UPDATE / DELETE in a single pass (rule-based by default, no model call). Conflicts with high-confidence facts and suspicious content go to quarantine, never auto-applied. Needs user approval first.',
      {
        text: { type: 'string', description: 'Turn text to remember (max 8000 chars).' },
        turnId: { type: 'string', description: 'Turn id (dedupes re-ingest; absent = generated from time).' },
        role: { type: 'string', description: '"user" | "assistant" (default "user").' },
      },
      ['text'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const text = getStringArg(args, 'text');
        const turnId = getOptionalStringArg(args, 'turnId') ?? `turn-${Date.now()}`;
        const role = getOptionalStringArg(args, 'role') ?? 'user';
        const scope = scopeOf(ctx);
        const { id: episodeId, duplicate } = s.ingestEpisode({
          turnId,
          runId: scope.runId,
          botId: scope.botId,
          userId: scope.userId,
          role,
          text,
        });
        if (duplicate) return JSON.stringify({ ingested: false, duplicate: true, episodeId }, null, 2);
        const result = await onePassConsolidate(
          s,
          text,
          scope,
          { turnId, runId: scope.runId, episodeId, at: new Date().toISOString() },
          { extractor },
        );
        const factIds = result.actions
          .map((a) => a.factId)
          .filter((id): id is string => typeof id === 'string');
        s.markEpisodeProcessed(episodeId, factIds);
        return JSON.stringify(
          {
            ingested: true,
            episodeId,
            extractor: result.extractor,
            modelCalls: result.modelCalls,
            examined: result.examined,
            added: result.added,
            updated: result.updated,
            deleted: result.deleted,
            quarantined: result.quarantined,
            skipped: result.skipped,
            actions: result.actions.map((a) => ({
              decision: a.decision,
              subject: a.candidate.subjectName,
              predicate: a.candidate.predicate,
              object: a.candidate.objectText,
              reason: a.reason,
            })),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const temporalQuery: Tool = {
    definition: toolDef(
      'memory_v3_temporal_query',
      'Facts that were true at a given moment (ISO date/time): uses each fact\'s validity window, so superseded facts still show up for the time they were true. Read-only.',
      {
        at: { type: 'string', description: 'ISO date/time to query, e.g. "2026-11-05T00:00:00.000Z".' },
        topK: { type: 'number', description: 'Max results (default 100, max 1000).' },
      },
      ['at'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const at = getStringArg(args, 'at');
        const facts = queryFactsAt(s, at, { scope: scopeOf(ctx), limit: getNumberArg(args, 'topK') });
        return JSON.stringify(
          {
            at,
            count: facts.length,
            facts: facts.map((f) => ({ ...publicFact(s, f.fact), validAt: f.at })),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const contradictions: Tool = {
    definition: toolDef(
      'memory_v3_contradictions',
      'Contradictions between two time windows: facts with the same subject + predicate but different objects, one valid in window A and the other in window B — e.g. what the user said last week that contradicts today. Each pair comes with timestamped evidence (source sentence + time on both sides). Read-only.',
      {
        windowAFrom: { type: 'string', description: 'Window A start (ISO date/time).' },
        windowATo: { type: 'string', description: 'Window A end (ISO date/time).' },
        windowBFrom: { type: 'string', description: 'Window B start (ISO date/time).' },
        windowBTo: { type: 'string', description: 'Window B end (ISO date/time).' },
        topK: { type: 'number', description: 'Max pairs (default 50, max 500).' },
      },
      ['windowAFrom', 'windowATo', 'windowBFrom', 'windowBTo'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const found = findContradictionsBetween(
          s,
          { from: getStringArg(args, 'windowAFrom'), to: getStringArg(args, 'windowATo') },
          { from: getStringArg(args, 'windowBFrom'), to: getStringArg(args, 'windowBTo') },
          { scope: scopeOf(ctx), limit: getNumberArg(args, 'topK') },
        );
        return JSON.stringify(
          {
            count: found.length,
            contradictions: found.map((c) => ({
              subject: c.subjectName,
              predicate: c.predicate,
              summary: formatContradiction(c),
              earlier: {
                object: c.earlier.objectText,
                validFrom: c.earlier.validFrom,
                validUntil: c.earlier.validUntil,
                sourceText: c.earlier.sourceText,
                at: c.earlier.at,
              },
              later: {
                object: c.later.objectText,
                validFrom: c.later.validFrom,
                validUntil: c.later.validUntil,
                sourceText: c.later.sourceText,
                at: c.later.at,
              },
            })),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const entityTimelineTool: Tool = {
    definition: toolDef(
      'memory_v3_entity_timeline',
      'Chronological history of one entity (person / place / thing): every fact version about it, oldest first, with the change kind (active / superseded / deleted). Read-only.',
      {
        entity: { type: 'string', description: 'Entity name, e.g. "user" or "Hà Nội".' },
        topK: { type: 'number', description: 'Max steps (default 100, max 1000).' },
      },
      ['entity'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const entity = getStringArg(args, 'entity');
        const steps = entityTimeline(s, entity, { scope: scopeOf(ctx), limit: getNumberArg(args, 'topK') });
        return JSON.stringify(
          {
            entity,
            count: steps.length,
            steps: steps.map((step) => ({
              at: step.at,
              kind: step.kind,
              text: step.text,
              fact: publicFact(s, step.fact),
            })),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sleepMaintenance: Tool = {
    definition: toolDef(
      'memory_v3_sleep_maintenance',
      'Letta-style idle maintenance on the knowledge graph: merge near-duplicate facts into the strongest one, boost confidence of facts referenced by many episodes, soft-delete old low-confidence facts nobody references, and digest old processed episodes. Deterministic, offline, best-effort. Needs user approval first.',
      {},
      [],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        void args;
        const report = runSleepMaintenance(s, scopeOf(ctx), {});
        return JSON.stringify(
          {
            ranAt: report.ranAt,
            deduped: report.deduped,
            promoted: report.promoted,
            pruned: report.pruned,
            dedupeGroups: report.dedupeGroups,
            promotedFactIds: report.promotedFactIds,
            prunedFactIds: report.prunedFactIds,
            digest: report.digest,
            errors: report.errors,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const blockHistory: Tool = {
    definition: toolDef(
      'memory_block_history',
      'Version history of a memory block: every past version (content, description, char limit, read-only flag, who changed it and when), oldest first. Read-only.',
      {
        block: { type: 'string', description: 'Block id or label, e.g. "human".' },
        limit: { type: 'number', description: 'Max versions (default 50, max 200).' },
      },
      ['block'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const b = needBlocks();
        const history = b.getHistory(getStringArg(args, 'block'), getNumberArg(args, 'limit'));
        return JSON.stringify({ count: history.length, versions: history }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const blockRestore: Tool = {
    definition: toolDef(
      'memory_block_restore',
      'Restore a memory block to an older version\'s content. History is never rewritten: the old content returns as a NEW version. Needs user approval first.',
      {
        block: { type: 'string', description: 'Block id or label, e.g. "human".' },
        version: { type: 'number', description: 'Version number to restore (see memory_block_history).' },
      },
      ['block', 'version'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const b = needBlocks();
        const version = getNumberArg(args, 'version');
        if (version === undefined) throw new Error('Missing required argument: "version"');
        const restored = b.restoreVersion(getStringArg(args, 'block'), version, `agent:${ctx.botId}`);
        return JSON.stringify(
          {
            restored: true,
            id: restored.id,
            label: restored.label,
            version: restored.version,
            content: restored.content,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const blockConflicts: Tool = {
    definition: toolDef(
      'memory_block_conflicts',
      'Memory block conflicts: action=list shows pending contradictions between a block and incoming facts (with both sides\' evidence: old line + block version, new fact + source + confidence); action=resolve records the user\'s decision (keep-current, accept-new, or merged with mergedText). Resolving never edits the block itself — the caller applies the chosen text. Needs user approval first.',
      {
        action: { type: 'string', description: '"list" | "resolve" (default "list").' },
        conflictId: { type: 'string', description: 'Conflict id to resolve (action=resolve).' },
        resolution: { type: 'string', description: '"keep-current" | "accept-new" | "merged" (action=resolve).' },
        resolvedText: { type: 'string', description: 'Merged text the user kept (resolution=merged).' },
        blockId: { type: 'string', description: 'Filter listed conflicts by block id (action=list).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const store = new BlockConflictStore(needWorkspaceDir());
        const action = getOptionalStringArg(args, 'action') ?? 'list';
        if (action === 'list') {
          const items = store.list({
            ...(getOptionalStringArg(args, 'blockId') ? { blockId: getOptionalStringArg(args, 'blockId') as string } : {}),
          });
          return JSON.stringify({ action: 'list', pending: items.filter((i) => i.status === 'pending').length, items }, null, 2);
        }
        if (action === 'resolve') {
          const conflictId = getStringArg(args, 'conflictId');
          const resolution = getStringArg(args, 'resolution');
          if (resolution !== 'keep-current' && resolution !== 'accept-new' && resolution !== 'merged') {
            throw new Error('memory_block_conflicts: resolution must be "keep-current", "accept-new" or "merged".');
          }
          const resolved = store.resolve(conflictId, resolution, `agent:${ctx.botId}`, getOptionalStringArg(args, 'resolvedText'));
          return JSON.stringify({ action: 'resolve', conflict: resolved }, null, 2);
        }
        throw new Error('memory_block_conflicts: action must be "list" or "resolve".');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    fusedSearch,
    onePassIngest,
    temporalQuery,
    contradictions,
    entityTimelineTool,
    sleepMaintenance,
    blockHistory,
    blockRestore,
    blockConflicts,
  ];
}

/** Unbound placeholder (same shape as MEMORY_GRAPH_TOOLS). */
export const MEMORY_V3_TOOLS: Tool[] = createMemoryV3Tools();

/** Names of the memory v3 tools (for the coordinator/registry checks). */
export const MEMORY_V3_TOOL_NAMES = [
  'memory_v3_fused_search',
  'memory_v3_one_pass_ingest',
  'memory_v3_temporal_query',
  'memory_v3_contradictions',
  'memory_v3_entity_timeline',
  'memory_v3_sleep_maintenance',
  'memory_block_history',
  'memory_block_restore',
  'memory_block_conflicts',
] as const;
