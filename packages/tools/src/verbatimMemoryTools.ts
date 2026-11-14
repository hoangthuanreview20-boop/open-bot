/**
 * Verbatim memory tools cho @open-bot/tools (v1.01, Đội T4).
 *
 * Bảy tool trên `VerbatimMemoryStore` (verbatim nguyên văn, local-first):
 *  - verbatim_memory_save   — lưu một record nguyên văn (needsApproval: true)
 *  - verbatim_memory_search — recall hybrid (BM25 + embedding Ollama local)
 *  - verbatim_memory_list   — liệt kê / lọc metadata + phân trang
 *  - verbatim_memory_delete — xoá một record theo id (needsApproval: true)
 *  - verbatim_memory_stats  — thống kê store
 *  - verbatim_memory_consolidate — báo cáo trùng lặp (chỉ đọc, không tự xoá)
 *  - verbatim_memory_backfill — embed các record chưa có vector
 *
 * Khác với `memory_*` (LongTermMemory key/value đã rút gọn): tool này
 * lưu NGUYÊN VĂN câu chữ. Agent dùng nó khi user nói rõ muốn lưu
 * nguyên câu ("hãy nhớ nguyên văn là…", "lưu câu này lại"), hoặc khi
 * cần tra lại đúng lời user đã nói trước đây (recall verbatim chính
 * xác hơn fact đã rút gọn).
 *
 * QUY TẮC ĐỒNG Ý (privacy, giống memoryTools): `verbatim_memory_save`
 * CHỈ được gọi khi user nói rõ muốn lưu, hoặc khi user đã duyệt một
 * đề xuất lưu cụ thể. Agent KHÔNG được tự suy ra fact/sở thích từ hội
 * thoại rồi ghi lén — description của tool nói rõ điều này, và mọi
 * lần ghi đều đi qua thẻ duyệt (needsApproval). Xoá cũng cần duyệt.
 * Đọc (search/list/stats) không cần duyệt.
 *
 * Scope: record thuộc về (userId, botId). `ctx.botId` là bot đang gọi;
 * `getUserId` (host cung cấp) là user hiện tại. Tool không bao giờ trả
 * vector embedding ra ngoài — output chỉ có nội dung đọc được.
 *
 * Factory:
 *   createVerbatimMemoryTools(opts) -> Tool[]   (bound, usable)
 *   VERBATIM_MEMORY_TOOLS                      (unbound placeholder)
 */
import type {
  Embedder,
  Tool,
  VerbatimMemoryStore,
  VerbatimSource,
} from '@open-bot/core';
import { consolidateVerbatim, isEmbedderAvailableCached } from '@open-bot/core';

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

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings`);
  }
  return value as string[];
}

function getBooleanArg(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
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

/** Tên 5 tool verbatim (để host allowlist / test). */
export const VERBATIM_MEMORY_TOOL_NAMES = [
  'verbatim_memory_save',
  'verbatim_memory_search',
  'verbatim_memory_list',
  'verbatim_memory_delete',
  'verbatim_memory_stats',
  'verbatim_memory_consolidate',
  'verbatim_memory_backfill',
] as const;

export type VerbatimMemoryToolName = (typeof VERBATIM_MEMORY_TOOL_NAMES)[number];

export interface VerbatimMemoryToolOptions {
  /** Verbatim store của workspace (bắt buộc để tool chạy). */
  store?: VerbatimMemoryStore;
  /** Embedder Ollama local (vắng = search/save chạy không-embedding). */
  embedder?: Embedder;
  /** userId hiện tại (từ profile.json); vắng = không lọc theo user. */
  getUserId?: () => string | undefined;
  /** Wing mặc định khi save không chỉ wing (mặc định 'default'). */
  defaultWing?: string;
  /** Room mặc định khi save không chỉ room (mặc định 'general'). */
  defaultRoom?: string;
}

export function createVerbatimMemoryTools(opts: VerbatimMemoryToolOptions = {}): Tool[] {
  const { store, embedder } = opts;
  const userIdOf = (): string | undefined => {
    try {
      const id = opts.getUserId?.();
      return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
    } catch {
      return undefined;
    }
  };
  const needStore = (): VerbatimMemoryStore => {
    if (!store) {
      throw new Error(
        'verbatim memory chưa được hỗ trợ trong phiên này (host phải truyền VerbatimMemoryStore vào createVerbatimMemoryTools).',
      );
    }
    return store;
  };
  /**
   * Embedder dùng được cho lần gọi này: probe nhanh (cache 60s, timeout
   * 1.5s) thay vì để `embed` treo tới 30s khi Ollama chưa chạy.
   */
  const usableEmbedder = async (): Promise<Embedder | undefined> => {
    if (!embedder) return undefined;
    try {
      return (await isEmbedderAvailableCached(embedder)) ? embedder : undefined;
    } catch {
      return undefined;
    }
  };

  const verbatimSave: Tool = {
    definition: toolDef(
      'verbatim_memory_save',
      'Save ONE verbatim memory — the EXACT words given, stored word-for-word without summarizing or paraphrasing (e.g. text "Tôi thích phở bò, không ăn cay", wing "default", room "food"). CONSENT RULE — call this ONLY when the user explicitly asked to remember something ("hãy nhớ ...", "ghi nhớ ...", "lưu lại ...", "lưu nguyên văn ...") or explicitly approved a concrete save you proposed. NEVER silently record facts, preferences or habits you merely inferred from the conversation — if the user did not ask to save it, do not save it. Saving always asks the user to approve first (approval card). Same text in the same wing+room is deduplicated (returns the existing record). Use wing for a person/project and room for a topic so later recall can filter.',
      {
        text: { type: 'string', description: 'Text NGUYÊN VĂN cần lưu (đúng câu chữ, không tóm tắt).' },
        wing: { type: 'string', description: 'Wing: người/dự án (mặc định "default").' },
        room: { type: 'string', description: 'Room: chủ đề (mặc định "general").' },
        drawer: { type: 'string', description: 'Drawer: nhóm con tuỳ ý trong room.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tag tuỳ chọn (vd ["sở thích", "ăn uống"]).' },
        source: { type: 'string', description: 'Nguồn: user|agent|manual (mặc định "manual").' },
        shared: { type: 'boolean', description: 'true = memory chung cho mọi bot (mặc định); false = chỉ bot này nhớ.' },
      },
      ['text'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const text = getStringArg(args, 'text');
        const shared = getBooleanArg(args, 'shared', true);
        const result = await s.save({
          text,
          wing: getOptionalStringArg(args, 'wing') ?? opts.defaultWing,
          room: getOptionalStringArg(args, 'room') ?? opts.defaultRoom,
          drawer: getOptionalStringArg(args, 'drawer'),
          tags: getStringArrayArg(args, 'tags'),
          source: (getOptionalStringArg(args, 'source') as VerbatimSource | undefined) ?? 'manual',
          botId: shared ? '' : ctx.botId,
          ...(userIdOf() !== undefined ? { userId: userIdOf() } : {}),
        });
        return JSON.stringify(
          {
            saved: true,
            created: result.created,
            id: result.record.id,
            wing: result.record.wing,
            room: result.record.room,
            createdAt: result.record.createdAt,
            ...(result.created ? {} : { note: 'Text đã tồn tại trong cùng wing+room — trả record đã có.' }),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const verbatimSearch: Tool = {
    definition: toolDef(
      'verbatim_memory_search',
      'Search verbatim memories — the EXACT words the user/agent said before (hybrid recall: BM25 keyword + local Ollama semantic embeddings when available, keyword fallback otherwise — the result says which one was used). Use it when the current question may relate to something said before, or when you need the user\'s exact wording rather than a summarized fact. Returns matching records with a score, most relevant first. Read-only, never writes.',
      {
        query: { type: 'string', description: 'Câu hỏi / từ khoá cần tìm.' },
        limit: { type: 'number', description: 'Số hit tối đa (mặc định 10, tối đa 50).' },
        wing: { type: 'string', description: 'Chỉ tìm trong wing này.' },
        room: { type: 'string', description: 'Chỉ tìm trong room này.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Chỉ tìm record có ít nhất một tag này.' },
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const s = needStore();
        const query = getStringArg(args, 'query');
        const limit = getNumberArg(args, 'limit');
        const wing = getOptionalStringArg(args, 'wing');
        const room = getOptionalStringArg(args, 'room');
        const tags = getStringArrayArg(args, 'tags');
        const live = await usableEmbedder();
        const result = await s.search(query, {
          ...(limit !== undefined ? { limit } : {}),
          filter: {
            ...(wing !== undefined ? { wing } : {}),
            ...(room !== undefined ? { room } : {}),
            ...(tags.length > 0 ? { tags } : {}),
            ...(userIdOf() !== undefined ? { userId: userIdOf() } : {}),
          },
          ...(live !== undefined ? { embedder: live } : {}),
        });
        return JSON.stringify(
          {
            hits: result.hits.map((h) => ({
              id: h.record.id,
              text: h.record.text,
              wing: h.record.wing,
              room: h.record.room,
              tags: h.record.tags,
              source: h.record.source,
              createdAt: h.record.createdAt,
              score: h.score,
              keywordScore: h.keywordScore,
              ...(h.semanticScore !== undefined ? { semanticScore: h.semanticScore } : {}),
            })),
            usedFallback: result.usedFallback,
            ...(result.fallbackReason !== undefined ? { fallbackReason: result.fallbackReason } : {}),
            candidates: result.candidates,
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const verbatimList: Tool = {
    definition: toolDef(
      'verbatim_memory_list',
      'List verbatim memories (newest first), optionally filtered by wing/room/tags/source. Use it to browse what is stored, or to find a record id before deleting. Read-only, never writes.',
      {
        limit: { type: 'number', description: 'Số record tối đa (mặc định 50, tối đa 1000).' },
        offset: { type: 'number', description: 'Bỏ qua N record đầu (phân trang).' },
        wing: { type: 'string', description: 'Chỉ liệt kê wing này.' },
        room: { type: 'string', description: 'Chỉ liệt kê room này.' },
        source: { type: 'string', description: 'Chỉ liệt kê source này (user|agent|tool|import|autosave|manual).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Chỉ liệt kê record có ít nhất một tag này.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const s = needStore();
        const limit = getNumberArg(args, 'limit');
        const offset = getNumberArg(args, 'offset');
        const wing = getOptionalStringArg(args, 'wing');
        const room = getOptionalStringArg(args, 'room');
        const source = getOptionalStringArg(args, 'source');
        const tags = getStringArrayArg(args, 'tags');
        const result = await s.list({
          ...(limit !== undefined ? { limit } : {}),
          ...(offset !== undefined ? { offset } : {}),
          filter: {
            ...(wing !== undefined ? { wing } : {}),
            ...(room !== undefined ? { room } : {}),
            ...(source !== undefined ? { source: source as VerbatimSource } : {}),
            ...(tags.length > 0 ? { tags } : {}),
            ...(userIdOf() !== undefined ? { userId: userIdOf() } : {}),
          },
        });
        return JSON.stringify(result, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const verbatimDelete: Tool = {
    definition: toolDef(
      'verbatim_memory_delete',
      'Delete ONE verbatim memory by id (find the id with verbatim_memory_list or verbatim_memory_search first). Irreversible — deleting always asks the user to approve first (approval card). Only delete when the user explicitly asked to forget/remove that memory.',
      {
        id: { type: 'string', description: 'Id của record cần xoá.' },
      },
      ['id'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const s = needStore();
        const id = getStringArg(args, 'id');
        const deleted = await s.delete(id);
        return JSON.stringify({ deleted, id }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const verbatimStats: Tool = {
    definition: toolDef(
      'verbatim_memory_stats',
      'Statistics of the verbatim memory store: total records, how many have embeddings, number of wings/rooms, distribution by source/wing, and which backend is running (sqlite or jsonl). Read-only, never writes.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const s = needStore();
        return JSON.stringify(await s.stats(), null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const verbatimConsolidate: Tool = {
    definition: toolDef(
      'verbatim_memory_consolidate',
      'Find duplicate / near-duplicate verbatim memories (same words with different punctuation/case, or near-identical sentences) and report them grouped, oldest record kept. READ-ONLY analysis — it never deletes anything by itself. Use it when the store grows messy, then propose the cleanup to the user (deletion itself needs a separate approved step). Returns groups with the record to keep and the duplicates that could be removed.',
      {
        wing: { type: 'string', description: 'Chỉ xét wing này (mặc định: mọi wing).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const s = needStore();
        const wing = getOptionalStringArg(args, 'wing');
        const report = await consolidateVerbatim(s, {
          ...(wing !== undefined ? { wing } : {}),
        });
        return JSON.stringify(
          {
            examined: report.examined,
            removable: report.removable,
            groups: report.groups.map((g) => ({
              key: g.key,
              keep: { id: g.keep.id, text: g.keep.text, createdAt: g.keep.createdAt },
              duplicates: g.duplicates.map((d) => ({ id: d.id, text: d.text, createdAt: d.createdAt })),
            })),
            nearDuplicates: report.nearDuplicates.slice(0, 20).map((p) => ({
              a: { id: p.a.id, text: p.a.text },
              b: { id: p.b.id, text: p.b.text },
              similarity: p.similarity,
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

  const verbatimBackfill: Tool = {
    definition: toolDef(
      'verbatim_memory_backfill',
      'Embed all verbatim records that do not have a vector yet, using the local Ollama embedding model (nomic-embed-text). Run it after Ollama starts, or after importing many records, so semantic search works on the whole store. Local-only, no API key. Returns how many were embedded / skipped / failed.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      try {
        const s = needStore();
        const live = await usableEmbedder();
        if (!live) {
          return errorResult('Ollama chưa chạy — không embed được (cần model nomic-embed-text).');
        }
        return JSON.stringify(await s.backfillEmbeddings(live), null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [verbatimSave, verbatimSearch, verbatimList, verbatimDelete, verbatimStats, verbatimConsolidate, verbatimBackfill];
}

/** Placeholder chưa bound (host phải gọi createVerbatimMemoryTools với store thật). */
export const VERBATIM_MEMORY_TOOLS: Tool[] = createVerbatimMemoryTools();

/** Kiểm tra một tên tool có phải tool verbatim không. */
export function isVerbatimMemoryToolName(name: string): name is VerbatimMemoryToolName {
  return (VERBATIM_MEMORY_TOOL_NAMES as readonly string[]).includes(name);
}
