/**
 * Memory graph tools cho @open-bot/tools (v0.98, Đội T1).
 *
 * Agent tự làm việc với temporal knowledge graph bằng tool call:
 *  - memory_graph_ingest      — ghi một turn vào graph (extract + consolidate) (needsApproval: true)
 *  - memory_graph_search      — hybrid search (semantic + BM25 + graph) (đọc)
 *  - memory_graph_list        — liệt kê fact / entity (đọc)
 *  - memory_graph_history     — lịch sử supersession của một fact (đọc)
 *  - memory_graph_stats       — số liệu đồ thị + quarantine đang chờ (đọc)
 *  - memory_graph_consolidate — chạy sleep agent tay / xem run log (needsApproval: true khi chạy)
 *  - memory_graph_quarantine  — liệt kê / duyệt quarantine (duyệt needsApproval: true)
 *  - memory_graph_share       — share đồ thị cho bot khác (needsApproval: true)
 *  - memory_graph_delete      — xoá mềm một fact (needsApproval: true)
 *
 * QUY TẮC BẢO VỆ: mọi ghi đều qua store (validate + provenance đầy
 * đủ turn/run/bot/user); fact mâu thuẫn/nghi ngờ không bao giờ được
 * agent tự áp — consolidation đẩy vào quarantine, chỉ user duyệt
 * trong UI mới thành fact. Tool không bao giờ trả vector embedding
 * ra ngoài (chỉ trả điểm số đã làm tròn).
 *
 * Factory:
 *   createMemoryGraphTools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_GRAPH_TOOLS                       (unbound placeholder)
 */
import type {
  FactExtractor,
  OllamaEmbeddings,
  SleepConsolidationAgent,
  TemporalGraphStore,
  Tool,
} from '@open-bot/core';
import {
  RuleBasedFactExtractor,
  consolidateCandidates,
  hybridGraphSearch,
  suspiciousCandidateForText,
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

export interface MemoryGraphToolOptions {
  /** Temporal graph store của workspace (bắt buộc để tool chạy). */
  graphStore?: TemporalGraphStore;
  /** Thư mục workspace của bot (để sleep agent ghi run log). */
  workspaceDir?: string;
  /** Sleep agent đã cấu hình (vắng = consolidate chạy đồng bộ tại chỗ). */
  sleepAgent?: SleepConsolidationAgent;
  /** Embedder semantic cho search (vắng = Ollama mặc định trong hybridSearch). */
  embedder?: OllamaEmbeddings;
  /** Extractor fact (mặc định luật xác định — không gọi model). */
  extractor?: FactExtractor;
  /** userId hiện tại (từ profile.json); vắng = không lọc theo user. */
  getUserId?: () => string | undefined;
  /** Resolver workspace bot khác (để share/read shared graph). */
  resolveWorkspace?: (botId: string) => string;
}

/** Fact trả cho model/UI: KHÔNG kèm vector embedding. */
function publicFact(store: TemporalGraphStore, fact: {
  id: string;
  subjectId: string;
  predicate: string;
  objectId?: string;
  objectText?: string;
  validFrom: string;
  validUntil: string | null;
  supersedes?: string;
  supersededBy?: string;
  confidence: number;
  status: string;
  scope: { userId: string; botId: string; runId: string };
  provenance: { episodeId: string; turnId: string; runId: string; botId: string; userId: string; at: string; sourceText: string };
  createdAt: string;
  updatedAt: string;
}) {
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

export function createMemoryGraphTools(opts: MemoryGraphToolOptions = {}): Tool[] {
  const { graphStore, sleepAgent } = opts;
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
        'memory graph chưa được hỗ trợ trong phiên này (host phải truyền graphStore vào createMemoryGraphTools).',
      );
    }
    return graphStore;
  };
  const scopeOf = (ctx: { botId: string; runId?: string }) => ({
    userId: userIdOf() ?? '',
    botId: ctx.botId,
    runId: ctx.runId ?? '',
  });

  const memoryGraphIngest: Tool = {
    definition: toolDef(
      'memory_graph_ingest',
      'Ingest ONE conversation turn into the temporal knowledge graph: extract candidate facts from the text (rule-based, local, no model call) and consolidate them against existing facts (ADD new, UPDATE by superseding the old fact, DELETE on negation, QUARANTINE on conflict or suspicious content). Returns what happened per fact. Needs user approval first.',
      {
        text: { type: 'string', description: 'Nội dung turn hội thoại cần ghi nhớ (tối đa 8000 ký tự).' },
        turnId: { type: 'string', description: 'Id turn (để chống ingest trùng; vắng = tự sinh theo thời gian).' },
        role: { type: 'string', description: '"user" | "assistant" (mặc định "user").' },
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
        const candidates = await extractor.extract(text, scope, text);
        // Text nghi ngờ mà extractor không rút được fact nào vẫn phải
        // vào quarantine (xem suspiciousCandidateForText) — nếu không
        // câu lệnh độc hại trôi qua im lặng, không để lại audit.
        const suspicious =
          candidates.length === 0 ? suspiciousCandidateForText(text, text) : null;
        const result = consolidateCandidates(s, suspicious ? [...candidates, suspicious] : candidates, scope, {
          turnId,
          runId: scope.runId,
          episodeId,
          at: new Date().toISOString(),
        });
        const factIds = result.actions
          .map((a) => a.factId)
          .filter((id): id is string => typeof id === 'string');
        s.markEpisodeProcessed(episodeId, factIds);
        return JSON.stringify({
          ingested: true,
          episodeId,
          extractor: extractor.name,
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
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const memoryGraphSearch: Tool = {
    definition: toolDef(
      'memory_graph_search',
      'Hybrid search over the knowledge graph: semantic similarity (local Ollama embeddings when available) + BM25 keywords + graph traversal around entities named in the query, merged by Reciprocal Rank Fusion. Returns ranked facts with per-source scores. Read-only.',
      {
        query: { type: 'string', description: 'Câu hỏi / từ khoá cần tìm trong bộ nhớ.' },
        topK: { type: 'number', description: 'Số kết quả tối đa (mặc định 10, tối đa 50).' },
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const query = getStringArg(args, 'query');
        const topK = getNumberArg(args, 'topK');
        const result = await hybridGraphSearch(s, query, {
          scope: scopeOf(ctx),
          ...(topK !== undefined ? { topK } : {}),
          ...(opts.embedder ? { embedder: opts.embedder } : {}),
        });
        return JSON.stringify({
          query: result.query,
          sourcesUsed: result.sourcesUsed,
          notes: result.notes,
          hits: result.hits.map((h) => ({
            ...publicFact(s, h.fact),
            score: Number(h.score.toFixed(4)),
            sources: h.sources,
          })),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const memoryGraphList: Tool = {
    definition: toolDef(
      'memory_graph_list',
      'List facts (or entities) in the knowledge graph. By default only ACTIVE facts in the calling bot scope. Pass status=superseded|deleted to see history, predicate to filter by relation. Read-only.',
      {
        kind: { type: 'string', description: '"facts" (mặc định) hoặc "entities".' },
        status: { type: 'string', description: '"active" | "superseded" | "deleted" | "quarantined" (mặc định "active").' },
        predicate: { type: 'string', description: 'Lọc theo predicate (vd "likes", "lives_in").' },
        limit: { type: 'number', description: 'Số mục tối đa (mặc định 50, tối đa 500).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const kind = getOptionalStringArg(args, 'kind') ?? 'facts';
        const limit = getNumberArg(args, 'limit') ?? 50;
        const scope = scopeOf(ctx);
        if (kind === 'entities') {
          return JSON.stringify({ entities: s.listEntities().slice(0, Math.max(1, Math.min(500, limit))) }, null, 2);
        }
        const status = getOptionalStringArg(args, 'status') ?? 'active';
        const predicate = getOptionalStringArg(args, 'predicate');
        const facts = s.listFacts({
          ...scope,
          status: status as 'active' | 'superseded' | 'deleted' | 'quarantined',
          ...(predicate ? { predicate } : {}),
          limit: Math.max(1, Math.min(500, limit)),
        });
        return JSON.stringify({ facts: facts.map((f) => publicFact(s, f)) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const memoryGraphHistory: Tool = {
    definition: toolDef(
      'memory_graph_history',
      'Show the full supersession history of one fact: the fact itself plus every version it replaced and every version that replaced it, oldest first. Read-only.',
      {
        factId: { type: 'string', description: 'Id của fact cần xem lịch sử.' },
      },
      ['factId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const s = needStore();
        const factId = getStringArg(args, 'factId');
        const history = s.factHistory(factId);
        if (history.length === 0) throw new Error('Không tìm thấy fact.');
        return JSON.stringify({ factId, history: history.map((f) => publicFact(s, f)) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const memoryGraphStats: Tool = {
    definition: toolDef(
      'memory_graph_stats',
      'Graph statistics: entity/fact/episode counts, unprocessed episodes, pending quarantine items. Read-only.',
      {},
      [],
    ),
    needsApproval: false,
    async execute(_args, ctx) {
      try {
        const s = needStore();
        return JSON.stringify({ stats: s.stats(scopeOf(ctx)) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const memoryGraphConsolidate: Tool = {
    definition: toolDef(
      'memory_graph_consolidate',
      'Run the sleep-time consolidation agent now (action=run: process unprocessed episodes in bounded batches), or view recent run logs (action=log). Running needs user approval first.',
      {
        action: { type: 'string', description: '"run" hoặc "log" (mặc định "log").' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const action = getOptionalStringArg(args, 'action') ?? 'log';
        if (action === 'log') {
          if (!sleepAgent) {
            return JSON.stringify({ action: 'log', runs: [], note: 'Sleep agent chưa được cấu hình trong phiên này.' }, null, 2);
          }
          // Config của agent instance đang chạy mới là "live": UI đổi
          // Settings thì coordinator áp lại qua agent.setConfig(),
          // còn file trên đĩa có thể cũ hơn (vd agent được dựng với
          // config truyền tay trong test/host).
          return JSON.stringify({ action: 'log', config: sleepAgent.getConfig(), turnsSinceLastRun: sleepAgent.getTurnsSinceLastRun() }, null, 2);
        }
        if (action === 'run') {
          if (!sleepAgent) throw new Error('Sleep agent chưa được cấu hình trong phiên này.');
          const log = await sleepAgent.runManual();
          return JSON.stringify({ action: 'run', ...log }, null, 2);
        }
        throw new Error('memory_graph_consolidate: action phải là "run" hoặc "log".');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const memoryGraphQuarantine: Tool = {
    definition: toolDef(
      'memory_graph_quarantine',
      'Quarantine review: action=list shows pending suspicious/conflicting facts waiting for user review; action=approve turns a quarantined candidate into a real fact; action=reject discards it (kept for audit). Approving/rejecting needs user approval first.',
      {
        action: { type: 'string', description: '"list" | "approve" | "reject" (mặc định "list").' },
        id: { type: 'string', description: 'Id mục quarantine (bắt buộc cho approve/reject).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const action = getOptionalStringArg(args, 'action') ?? 'list';
        if (action === 'list') {
          const items = s.listQuarantine({ ...scopeOf(ctx), status: 'pending' });
          return JSON.stringify({ action: 'list', pending: items.length, items }, null, 2);
        }
        if (action === 'approve' || action === 'reject') {
          const id = getStringArg(args, 'id');
          const { item, fact } = s.reviewQuarantine(id, action === 'approve' ? 'approved' : 'rejected', `agent:${ctx.botId}`);
          return JSON.stringify({
            action,
            item,
            ...(fact ? { fact: publicFact(s, fact) } : {}),
          }, null, 2);
        }
        throw new Error('memory_graph_quarantine: action phải là "list", "approve" hoặc "reject".');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const memoryGraphShare: Tool = {
    definition: toolDef(
      'memory_graph_share',
      'Share this bot graph with another bot (action=share, readOnly=true by default so the other bot can only read), revoke a share (action=unshare), or list current shares (action=list). Sharing needs user approval first.',
      {
        action: { type: 'string', description: '"share" | "unshare" | "list" (mặc định "list").' },
        targetBotId: { type: 'string', description: 'Bot nhận share (bắt buộc cho share/unshare).' },
        readOnly: { type: 'boolean', description: 'true = bot kia chỉ được đọc (mặc định true).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const action = getOptionalStringArg(args, 'action') ?? 'list';
        if (action === 'list') {
          return JSON.stringify({ action: 'list', shares: s.listShares() }, null, 2);
        }
        const targetBotId = getStringArg(args, 'targetBotId');
        if (action === 'share') {
          const readOnly = getBoolArg(args, 'readOnly', true);
          const share = s.share(targetBotId, readOnly, `agent:${ctx.botId}`);
          return JSON.stringify({ action: 'share', share }, null, 2);
        }
        if (action === 'unshare') {
          return JSON.stringify({ action: 'unshare', removed: s.unshare(targetBotId) }, null, 2);
        }
        throw new Error('memory_graph_share: action phải là "share", "unshare" hoặc "list".');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const memoryGraphDelete: Tool = {
    definition: toolDef(
      'memory_graph_delete',
      'Soft-delete one fact: closes its validity window (validUntil=now) and marks it deleted — history stays queryable via memory_graph_history. Needs user approval first.',
      {
        factId: { type: 'string', description: 'Id của fact cần xoá mềm.' },
      },
      ['factId'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const factId = getStringArg(args, 'factId');
        const fact = s.deleteFact(factId, `agent:${ctx.botId}`);
        return JSON.stringify({ deleted: true, fact: publicFact(s, fact) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    memoryGraphIngest,
    memoryGraphSearch,
    memoryGraphList,
    memoryGraphHistory,
    memoryGraphStats,
    memoryGraphConsolidate,
    memoryGraphQuarantine,
    memoryGraphShare,
    memoryGraphDelete,
  ];
}

/** Unbound placeholder (same shape as MEMORY_BLOCK_TOOLS). */
export const MEMORY_GRAPH_TOOLS: Tool[] = createMemoryGraphTools();

/** Tên các tool memory graph (để coordinator/registry kiểm tra). */
export const MEMORY_GRAPH_TOOL_NAMES = [
  'memory_graph_ingest',
  'memory_graph_search',
  'memory_graph_list',
  'memory_graph_history',
  'memory_graph_stats',
  'memory_graph_consolidate',
  'memory_graph_quarantine',
  'memory_graph_share',
  'memory_graph_delete',
] as const;
