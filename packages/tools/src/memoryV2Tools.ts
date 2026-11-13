/**
 * Memory v2 tools for @open-bot/tools (v0.97, Team T4).
 *
 * Agent self-manages its memory (Letta-style) through the tool
 * registry, on top of the v0.96 memory blocks (not replacing them):
 *  - memory_sleep_run       — run the sleep-time consolidation agent now (background, async)
 *  - memory_sleep_status    — sleep agent config + last run report (read-only)
 *  - memory_sleep_configure — enable/disable + tune the sleep agent
 *  - memory_graph_entity    — add/get/list/delete/quarantine graph entities
 *  - memory_graph_relation  — add/end/delete/list graph relations
 *  - memory_graph_query     — neighbours / snapshot-at-time / entity lookup
 *  - memory_hybrid_search   — semantic + BM25 + graph hybrid search with explanations
 *  - memory_provenance      — quota usage, flagged memories, contradictions (read-only)
 *
 * Safety rules (same as the core modules):
 *  - All writes need user approval (`needsApproval: true`).
 *  - Sleep runs are refused for provider `mock` and CLI-kind bots
 *    (their session state belongs to the CLI tool, not open-bot).
 *  - Hybrid search never blocks on Ollama: the embedder is only used
 *    when configured, with a short timeout, and BM25 always works.
 *  - Embeddings are NEVER returned to the model or the UI.
 *  - Quarantined / low-trust items are labelled, never hidden silently.
 *
 * Factory:
 *   createMemoryV2Tools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_V2_TOOLS                       (unbound placeholder)
 */
import type {
  Tool,
  Embedder,
} from '@open-bot/core';
import {
  LongTermMemory,
  MemoryBlockStore,
  TemporalKnowledgeGraph,
  SleepTimeAgent,
  shouldRunForBot,
  hybridSearch,
  detectSuspiciousContent,
  detectContradictions,
  checkQuota,
  DEFAULT_MEMORY_QUOTA,
  trustScore,
} from '@open-bot/core';
import type { HybridSearchItem } from '@open-bot/core';
import type { SleepEpisode } from '@open-bot/core';

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

export interface MemoryV2ToolOptions {
  /** Workspace dir (used to build stores the host did not pass). */
  workspaceDir?: string;
  /** Long-term memory store (required for hybrid search + provenance). */
  longTermStore?: LongTermMemory;
  /** Memory block store (required for hybrid search over blocks). */
  blocksStore?: MemoryBlockStore;
  /** Temporal knowledge graph (required for graph tools/search). */
  graph?: TemporalKnowledgeGraph;
  /** Sleep-time agent (required for sleep tools). */
  sleepAgent?: SleepTimeAgent;
  /** Embedder for the semantic signal (optional; keyword fallback otherwise). */
  embedder?: Embedder;
  /** Current user id (from profile.json); absent = no user filter. */
  getUserId?: () => string | undefined;
  /** Provider id of the calling bot (sleep gate: 'mock' refused). */
  getProviderId?: () => string | undefined;
  /** Provider kind of the calling bot (sleep gate: 'cli' refused). */
  getProviderKind?: () => string | undefined;
}

export const MEMORY_V2_TOOL_NAMES = [
  'memory_sleep_run',
  'memory_sleep_status',
  'memory_sleep_configure',
  'memory_graph_entity',
  'memory_graph_relation',
  'memory_graph_query',
  'memory_hybrid_search',
  'memory_provenance',
] as const;

export function createMemoryV2Tools(opts: MemoryV2ToolOptions = {}): Tool[] {
  const workspaceDir = opts.workspaceDir ?? '';
  const userIdOf = (): string | undefined => {
    try {
      const id = opts.getUserId?.();
      return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
    } catch {
      return undefined;
    }
  };
  const needLongTerm = (): LongTermMemory => {
    if (opts.longTermStore) return opts.longTermStore;
    if (workspaceDir !== '') return new LongTermMemory(workspaceDir);
    throw new Error('long-term memory is not available in this session (host must pass longTermStore or workspaceDir).');
  };
  const needBlocks = (): MemoryBlockStore => {
    if (opts.blocksStore) return opts.blocksStore;
    if (workspaceDir !== '') return new MemoryBlockStore(workspaceDir);
    throw new Error('memory blocks are not available in this session (host must pass blocksStore or workspaceDir).');
  };
  const needGraph = (): TemporalKnowledgeGraph => {
    if (opts.graph) return opts.graph;
    if (workspaceDir !== '') return new TemporalKnowledgeGraph(workspaceDir);
    throw new Error('memory graph is not available in this session (host must pass graph or workspaceDir).');
  };
  const needSleep = (): SleepTimeAgent => {
    if (opts.sleepAgent) return opts.sleepAgent;
    if (workspaceDir !== '') return new SleepTimeAgent(workspaceDir, '');
    throw new Error('sleep agent is not available in this session (host must pass sleepAgent or workspaceDir).');
  };

  const parseEpisodes = (args: Record<string, unknown>): SleepEpisode[] => {
    const raw = args.episodes;
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new Error('Argument "episodes" must be an array.');
    const out: SleepEpisode[] = [];
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.text !== 'string' || rec.text.trim() === '') continue;
      out.push({
        id: typeof rec.id === 'string' ? rec.id : `episode-${out.length}`,
        role: rec.role === 'bot' ? 'bot' : 'user',
        text: rec.text,
        at: typeof rec.at === 'string' ? rec.at : new Date().toISOString(),
      });
    }
    return out;
  };

  const sleepRun: Tool = {
    definition: toolDef(
      'memory_sleep_run',
      'Run the sleep-time consolidation agent now: it reviews the given conversation episodes in the BACKGROUND, extracts important facts, updates long-term memory and the v0.96 memory blocks (dedupe + conflict resolve + promote), and grows the temporal knowledge graph. Pass recent turns as "episodes". Refused for mock/CLI bots. Needs user approval.',
      {
        episodes: {
          type: 'array',
          description: 'Recent conversation turns to review: [{id, role: "user"|"bot", text, at}]. Only user turns are mined for facts.',
          items: { type: 'object' },
        },
        trigger: { type: 'string', description: '"manual" (default), "steps" or "compact".' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const providerId = opts.getProviderId?.();
        const providerKind = opts.getProviderKind?.();
        if (!shouldRunForBot(providerId, providerKind)) {
          return errorResult(`Sleep consolidation is refused for provider '${providerId ?? ''}' (mock/CLI bots do not get memory writes).`);
        }
        const agent = opts.sleepAgent ?? (workspaceDir !== '' ? new SleepTimeAgent(workspaceDir, ctx.botId) : needSleep());
        const episodes = parseEpisodes(args);
        const trigger = getOptionalStringArg(args, 'trigger');
        const report = await agent.run({
          episodes,
          trigger: trigger === 'steps' || trigger === 'compact' ? trigger : 'manual',
          providerId,
          providerKind,
          longTerm: opts.longTermStore,
          blocks: opts.blocksStore,
          graph: opts.graph,
          userId: userIdOf(),
        });
        return JSON.stringify({ ok: true, report }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sleepStatus: Tool = {
    definition: toolDef(
      'memory_sleep_status',
      'Show the sleep-time consolidation agent status: config (enabled, steps threshold, run-on-compact), steps since the last run, and the full last run report (facts stored/flagged, contradictions, graph growth, quota blocks). Read-only.',
      {},
      [],
    ),
    needsApproval: false,
    async execute(_args, ctx) {
      try {
        const agent = opts.sleepAgent ?? (workspaceDir !== '' ? new SleepTimeAgent(workspaceDir, ctx.botId) : needSleep());
        return JSON.stringify(
          {
            config: agent.getConfig(),
            stepsSinceLastRun: agent.getStepsSinceLastRun(),
            running: agent.isRunning(),
            lastReport: agent.getLastReport() ?? null,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sleepConfigure: Tool = {
    definition: toolDef(
      'memory_sleep_configure',
      'Configure the sleep-time consolidation agent: enable/disable it, set the steps threshold (run after N turns), run-on-compact, promote-to-blocks, build-graph. Disabled by default; enabling it never runs anything inside a live turn (runs happen in the background). Needs user approval.',
      {
        enabled: { type: 'boolean', description: 'Master switch for automatic sleep runs (default false).' },
        stepsThreshold: { type: 'number', description: 'Run after this many completed turns (1-1000, default 20).' },
        runOnCompact: { type: 'boolean', description: 'Also run when the context is compacted (default true).' },
        promoteToBlocks: { type: 'boolean', description: 'Promote important facts to the human memory block (default true).' },
        buildGraph: { type: 'boolean', description: 'Grow the temporal knowledge graph from episodes (default true).' },
        minConfidence: { type: 'number', description: 'Minimum confidence for a fact to be stored (0-1, default 0.5).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const agent = opts.sleepAgent ?? (workspaceDir !== '' ? new SleepTimeAgent(workspaceDir, ctx.botId) : needSleep());
        const patch: Record<string, unknown> = {};
        const enabled = args.enabled;
        if (enabled !== undefined) patch.enabled = getBoolArg(args, 'enabled', false);
        const steps = getNumberArg(args, 'stepsThreshold');
        if (steps !== undefined) patch.stepsThreshold = steps;
        if (args.runOnCompact !== undefined) patch.runOnCompact = getBoolArg(args, 'runOnCompact', true);
        if (args.promoteToBlocks !== undefined) patch.promoteToBlocks = getBoolArg(args, 'promoteToBlocks', true);
        if (args.buildGraph !== undefined) patch.buildGraph = getBoolArg(args, 'buildGraph', true);
        const minConf = getNumberArg(args, 'minConfidence');
        if (minConf !== undefined) patch.minConfidence = minConf;
        const config = agent.setConfig(patch as Parameters<SleepTimeAgent['setConfig']>[0]);
        return JSON.stringify({ ok: true, config }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const graphEntity: Tool = {
    definition: toolDef(
      'memory_graph_entity',
      'Manage temporal knowledge graph entities (people, places, things, events, concepts, projects). Actions: add (merges with an existing entity of the same name+type), get, list, delete, quarantine (excluded from queries while quarantined). Entities carry a bi-temporal validity window (validFrom/validTo) plus provenance. Writes need approval.',
      {
        action: { type: 'string', description: '"add" | "get" | "list" | "delete" | "quarantine" | "unquarantine".' },
        id: { type: 'string', description: 'Entity id (for get/delete/quarantine).' },
        name: { type: 'string', description: 'Entity name (for add; also used to look up by name for get).' },
        type: { type: 'string', description: 'Entity type: person | place | thing | event | concept | project (default concept).' },
        description: { type: 'string', description: 'Short description of the entity.' },
        aliases: { type: 'array', description: 'Alternative names for the entity.', items: { type: 'string' } },
        validFrom: { type: 'string', description: 'ISO date when the entity became true/relevant (optional).' },
        validTo: { type: 'string', description: 'ISO date when the entity stopped being true/relevant (optional).' },
        at: { type: 'string', description: 'ISO date for list: only entities valid at that time (default now).' },
        limit: { type: 'number', description: 'Max entities to list (default 50).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const graph = needGraph();
        const action = getStringArg(args, 'action');
        if (action === 'add') {
          const name = getStringArg(args, 'name');
          const aliasesRaw = args.aliases;
          const aliases = Array.isArray(aliasesRaw) ? aliasesRaw.filter((a): a is string => typeof a === 'string') : [];
          const result = graph.addEntity({
            name,
            type: (getOptionalStringArg(args, 'type') as 'person' | 'place' | 'thing' | 'event' | 'concept' | 'project' | undefined) ?? 'concept',
            description: getOptionalStringArg(args, 'description'),
            aliases,
            validFrom: getOptionalStringArg(args, 'validFrom'),
            validTo: getOptionalStringArg(args, 'validTo'),
            botId: ctx.botId,
            source: 'bot',
            origin: `tool:memory_graph_entity:${ctx.botId}`,
          });
          return JSON.stringify({ ok: true, ...result }, null, 2);
        }
        if (action === 'get') {
          const id = getOptionalStringArg(args, 'id');
          const name = getOptionalStringArg(args, 'name');
          const entity = id ? graph.getEntity(id) : name ? graph.findEntityByName(name) : undefined;
          if (!entity) return errorResult('Entity not found.');
          return JSON.stringify({ ok: true, entity }, null, 2);
        }
        if (action === 'list') {
          const entities = graph.listEntities({
            at: getOptionalStringArg(args, 'at'),
            type: getOptionalStringArg(args, 'type') as 'person' | 'place' | 'thing' | 'event' | 'concept' | 'project' | undefined,
            limit: getNumberArg(args, 'limit') ?? 50,
          });
          return JSON.stringify({ ok: true, count: entities.length, entities }, null, 2);
        }
        if (action === 'delete') {
          const deleted = graph.deleteEntity(getStringArg(args, 'id'));
          return JSON.stringify({ ok: true, deleted }, null, 2);
        }
        if (action === 'quarantine' || action === 'unquarantine') {
          const entity = graph.setEntityQuarantined(getStringArg(args, 'id'), action === 'quarantine');
          return JSON.stringify({ ok: true, entity }, null, 2);
        }
        return errorResult(`Unknown action "${action}" (expected add/get/list/delete/quarantine/unquarantine).`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const graphRelation: Tool = {
    definition: toolDef(
      'memory_graph_relation',
      'Manage temporal knowledge graph relations between entities. Actions: add (resolves endpoints by id or name, auto-creates missing entities; same from/label/to twice widens the validity window instead of duplicating), end (set validTo — supersede, history kept), delete, list. Writes need approval.',
      {
        action: { type: 'string', description: '"add" | "end" | "delete" | "list".' },
        id: { type: 'string', description: 'Relation id (for end/delete).' },
        from: { type: 'string', description: 'Source entity id or name (for add/list).' },
        to: { type: 'string', description: 'Target entity id or name (for add).' },
        label: { type: 'string', description: 'Relation label, e.g. "likes", "works-on", "located-in" (for add/list).' },
        detail: { type: 'string', description: 'Optional detail, e.g. "every Sunday morning".' },
        validFrom: { type: 'string', description: 'ISO date when the relation became true (optional).' },
        validTo: { type: 'string', description: 'ISO date when the relation stopped being true (for add/end).' },
        at: { type: 'string', description: 'ISO date for list: only relations valid at that time (default now).' },
        limit: { type: 'number', description: 'Max relations to list (default 50).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const graph = needGraph();
        const action = getStringArg(args, 'action');
        if (action === 'add') {
          const from = getStringArg(args, 'from');
          const to = getStringArg(args, 'to');
          const label = getStringArg(args, 'label');
          const looksLikeId = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(s);
          const result = graph.addRelation({
            ...(looksLikeId(from) ? { fromEntityId: from } : { fromName: from }),
            ...(looksLikeId(to) ? { toEntityId: to } : { toName: to }),
            label,
            detail: getOptionalStringArg(args, 'detail'),
            validFrom: getOptionalStringArg(args, 'validFrom'),
            validTo: getOptionalStringArg(args, 'validTo'),
            botId: ctx.botId,
            source: 'bot',
            origin: `tool:memory_graph_relation:${ctx.botId}`,
          });
          return JSON.stringify({ ok: true, ...result }, null, 2);
        }
        if (action === 'end') {
          const relation = graph.endRelation(getStringArg(args, 'id'), getStringArg(args, 'validTo'));
          return JSON.stringify({ ok: true, relation }, null, 2);
        }
        if (action === 'delete') {
          const deleted = graph.deleteRelation(getStringArg(args, 'id'));
          return JSON.stringify({ ok: true, deleted }, null, 2);
        }
        if (action === 'list') {
          const from = getOptionalStringArg(args, 'from');
          const entity = from ? graph.findEntityByName(from) ?? graph.getEntity(from) : undefined;
          const relations = graph.listRelations({
            ...(entity ? { entityId: entity.id } : {}),
            label: getOptionalStringArg(args, 'label'),
            at: getOptionalStringArg(args, 'at'),
            limit: getNumberArg(args, 'limit') ?? 50,
          });
          return JSON.stringify({ ok: true, count: relations.length, relations }, null, 2);
        }
        return errorResult(`Unknown action "${action}" (expected add/end/delete/list).`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const graphQuery: Tool = {
    definition: toolDef(
      'memory_graph_query',
      'Query the temporal knowledge graph. Modes: "neighbours" (relations + entities around one entity), "snapshot" (whole graph as valid at a given time — time travel), "entity" (find one entity by name). Read-only; quarantined items are never returned.',
      {
        mode: { type: 'string', description: '"neighbours" | "snapshot" | "entity".' },
        name: { type: 'string', description: 'Entity name (for neighbours/entity).' },
        id: { type: 'string', description: 'Entity id (alternative to name for neighbours).' },
        at: { type: 'string', description: 'ISO date: graph as valid at this time (default now).' },
      },
      ['mode'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const graph = needGraph();
        const mode = getStringArg(args, 'mode');
        const at = getOptionalStringArg(args, 'at');
        if (mode === 'entity') {
          const name = getStringArg(args, 'name');
          const entity = graph.findEntityByName(name);
          if (!entity) return errorResult(`No entity named "${name}".`);
          return JSON.stringify({ ok: true, entity }, null, 2);
        }
        if (mode === 'neighbours') {
          const id = getOptionalStringArg(args, 'id');
          const name = getOptionalStringArg(args, 'name');
          let entity = id ? graph.getEntity(id) : undefined;
          if (!entity && name) entity = graph.findEntityByName(name);
          if (!entity) return errorResult('Entity not found (pass id or name).');
          const neighbours = graph.neighbours(entity.id, { ...(at ? { at } : {}) });
          return JSON.stringify(
            {
              ok: true,
              entity,
              neighbours: neighbours.map((n) => ({
                relation: n.relation,
                other: n.other,
                direction: n.direction,
              })),
            },
            null,
            2,
          );
        }
        if (mode === 'snapshot') {
          const snapshot = graph.snapshotAt(at ?? new Date().toISOString());
          return JSON.stringify(
            {
              ok: true,
              at: at ?? new Date().toISOString(),
              entityCount: snapshot.entities.length,
              relationCount: snapshot.relations.length,
              entities: snapshot.entities,
              relations: snapshot.relations,
            },
            null,
            2,
          );
        }
        return errorResult(`Unknown mode "${mode}" (expected neighbours/snapshot/entity).`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const hybridSearchTool: Tool = {
    definition: toolDef(
      'memory_hybrid_search',
      'Hybrid memory search: BM25 keyword + semantic embedding (local Ollama when available, keyword fallback otherwise) + temporal graph traversal, ranked with a per-result explanation of which signal matched. Searches long-term memories, memory blocks and graph entities/relations together. Read-only; embeddings are never returned.',
      {
        query: { type: 'string', description: 'Search query (natural language or keywords).' },
        topK: { type: 'number', description: 'Max results (default 10, max 50).' },
        includeGraph: { type: 'boolean', description: 'Include graph entities/relations in the corpus (default true).' },
        minTrust: { type: 'number', description: 'Minimum trust score 0-1 (default 0).' },
        at: { type: 'string', description: 'ISO date: only memories valid at that time (graph items; default now).' },
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const query = getStringArg(args, 'query');
        const topK = getNumberArg(args, 'topK') ?? 10;
        const includeGraph = getBoolArg(args, 'includeGraph', true);
        const minTrust = getNumberArg(args, 'minTrust') ?? 0;
        const at = getOptionalStringArg(args, 'at');
        const longTerm = needLongTerm();
        const blocks = needBlocks();
        const graph = needGraph();
        const userId = userIdOf();

        const items: HybridSearchItem[] = [];
        for (const entry of longTerm.recall({ limit: 500, botId: ctx.botId, includeShared: true, ...(userId ? { userId } : {}) })) {
          items.push({
            id: `memory:${entry.id}`,
            text: `${entry.key}: ${entry.value}${entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : ''}`,
            kind: 'memory',
            ...(entry.embedding ? { embedding: entry.embedding } : {}),
            trust: entry.confidence,
          });
        }
        for (const block of blocks.list({ botId: ctx.botId, ...(userId ? { userId } : {}) })) {
          if (block.content.trim() === '') continue;
          items.push({
            id: `block:${block.id}`,
            text: `${block.label}: ${block.content}`,
            kind: 'block',
            trust: 0.9,
          });
        }
        if (includeGraph) {
          for (const entity of graph.listEntities({ limit: 1000 })) {
            items.push({
              id: `entity:${entity.id}`,
              text: `${entity.name} (${entity.type}): ${entity.description}`,
              kind: 'graph-entity',
              trust: entity.provenance.trust,
              validFrom: entity.validFrom,
              validTo: entity.validTo,
              entityId: entity.id,
            });
          }
          for (const relation of graph.listRelations({ limit: 1000 })) {
            const from = graph.getEntity(relation.fromEntityId);
            const to = graph.getEntity(relation.toEntityId);
            if (!from || !to) continue;
            items.push({
              id: `relation:${relation.id}`,
              text: `${from.name} ${relation.label} ${to.name} ${relation.detail}`,
              kind: 'graph-relation',
              trust: relation.provenance.trust,
              validFrom: relation.validFrom,
              validTo: relation.validTo,
              entityId: relation.fromEntityId,
            });
          }
        }
        const result = await hybridSearch(query, items, {
          topK,
          minTrust,
          ...(at ? { at } : {}),
          ...(opts.embedder ? { embedder: opts.embedder } : {}),
          graph,
        });
        return JSON.stringify(
          {
            ok: true,
            query: result.query,
            semanticAvailable: result.semanticAvailable,
            count: result.hits.length,
            hits: result.hits.map((h) => ({
              id: h.item.id,
              kind: h.item.kind,
              text: h.item.text.slice(0, 500),
              score: h.score,
              signals: h.signals,
              explanation: h.explanation,
              sources: h.sources,
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

  const provenanceTool: Tool = {
    definition: toolDef(
      'memory_provenance',
      'Memory trust report (OWASP ASI06): per-bot quota usage, suspicious memories (prompt-injection patterns found in stored text), and contradictions (same key, different values) across long-term memories. Read-only; flagged items are listed with their flag codes so the user can review them instead of the agent trusting them blindly.',
      {
        action: { type: 'string', description: '"status" (quota + counts) | "flags" (suspicious memories) | "contradictions" (conflicting facts). Default "status".' },
        limit: { type: 'number', description: 'Max flagged/contradiction items to list (default 20).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const action = getOptionalStringArg(args, 'action') ?? 'status';
        const limit = getNumberArg(args, 'limit') ?? 20;
        const longTerm = needLongTerm();
        const graph = needGraph();
        const userId = userIdOf();
        const entries = longTerm.recall({ limit: 2000, botId: ctx.botId, includeShared: true, ...(userId ? { userId } : {}) });
        const usage = {
          items: entries.length,
          chars: entries.reduce((n, e) => n + e.key.length + e.value.length, 0),
          graphEntities: graph.usage().graphEntities,
          graphRelations: graph.usage().graphRelations,
        };
        const quotaCheck = checkQuota(usage, { items: 0, chars: 0 }, DEFAULT_MEMORY_QUOTA);
        if (action === 'status') {
          const stats = graph.stats();
          return JSON.stringify(
            {
              ok: true,
              quota: DEFAULT_MEMORY_QUOTA,
              usage,
              quotaOk: quotaCheck.allowed,
              graph: stats,
              trust: {
                avg: entries.length > 0 ? Math.round((entries.reduce((n, e) => n + e.confidence, 0) / entries.length) * 100) / 100 : 0,
                lowTrust: entries.filter((e) => e.confidence < 0.5).length,
              },
            },
            null,
            2,
          );
        }
        if (action === 'flags') {
          const flagged = entries
            .map((e) => ({ entry: e, flags: detectSuspiciousContent(`${e.key}: ${e.value}`) }))
            .filter((f) => f.flags.length > 0)
            .slice(0, limit)
            .map((f) => ({
              id: f.entry.id,
              key: f.entry.key,
              value: f.entry.value,
              confidence: f.entry.confidence,
              trust: trustScore({
                source: 'user',
                flags: f.flags,
                quarantined: false,
                recordedAt: f.entry.updatedAt,
              }),
              flags: f.flags,
            }));
          return JSON.stringify({ ok: true, count: flagged.length, flagged }, null, 2);
        }
        if (action === 'contradictions') {
          const contradictions = detectContradictions(
            entries.map((e) => ({ id: e.id, key: e.key, value: e.value, recordedAt: e.updatedAt })),
          ).slice(0, limit);
          return JSON.stringify({ ok: true, count: contradictions.length, contradictions }, null, 2);
        }
        return errorResult(`Unknown action "${action}" (expected status/flags/contradictions).`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [sleepRun, sleepStatus, sleepConfigure, graphEntity, graphRelation, graphQuery, hybridSearchTool, provenanceTool];
}

export const MEMORY_V2_TOOLS: Tool[] = createMemoryV2Tools();
