/**
 * Memory tools cho @open-bot/tools (v0.95, Đội D4).
 *
 * Bốn tool trên `LongTermMemory` (JSON local `.open-bot/memories.json`,
 * xem packages/core/src/memory/longterm.ts):
 *  - memory_save   — ghi một memory (needsApproval: true)
 *  - memory_search — recall ngữ nghĩa (Ollama local) / từ khoá fallback
 *  - memory_list   — liệt kê / lọc memory
 *  - memory_delete — xoá một memory (needsApproval: true)
 *
 * QUY TẮC ĐỒNG Ý (privacy): `memory_save` CHỈ được gọi khi user nói
 * rõ muốn lưu ("hãy nhớ ...", "ghi nhớ ...", "lưu lại ...") hoặc khi
 * user đã duyệt một đề xuất lưu cụ thể. Agent KHÔNG được tự suy ra
 * fact/sở thích từ hội thoại rồi ghi lén — description của tool nói
 * rõ điều này để model tuân theo, và mọi lần ghi đều đi qua thẻ duyệt
 * của user (needsApproval) nên không có đường ghi âm thầm. Xoá cũng
 * cần duyệt. Đọc (search/list) không cần duyệt.
 *
 * Scope: memory thuộc về (userId, botId). `ctx.botId` là bot đang gọi;
 * `getUserId` (host cung cấp, từ `<userData>/profile.json`) là user
 * hiện tại. Tool không bao giờ trả vector embedding ra ngoài — output
 * chỉ có nội dung đọc được (xem `publicEntry`).
 *
 * Factory:
 *   createMemoryTools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_TOOLS                        (unbound placeholder)
 */
import type { Embedder, LongTermMemory, LongTermMemoryEntry, Tool } from '@open-bot/core';
import { isEmbedderAvailableCached } from '@open-bot/core';

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

/** Entry trả cho model/UI: KHÔNG kèm vector embedding. */
export function publicMemoryEntry(entry: LongTermMemoryEntry): Omit<LongTermMemoryEntry, 'embedding'> {
  const { embedding: _embedding, ...rest } = entry;
  void _embedding;
  return rest;
}

export interface MemoryToolOptions {
  /** Long-term memory store của workspace (bắt buộc để tool chạy). */
  store?: LongTermMemory;
  /** Embedder Ollama local (vắng = search/save chạy không-embedding). */
  embedder?: Embedder;
  /** userId hiện tại (từ profile.json); vắng = không lọc theo user. */
  getUserId?: () => string | undefined;
}

export function createMemoryTools(opts: MemoryToolOptions = {}): Tool[] {
  const { store, embedder } = opts;
  const userIdOf = (): string | undefined => {
    try {
      const id = opts.getUserId?.();
      return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
    } catch {
      return undefined;
    }
  };
  const needStore = (): LongTermMemory => {
    if (!store) {
      throw new Error(
        'memory chưa được hỗ trợ trong phiên này (host phải truyền LongTermMemory vào createMemoryTools).',
      );
    }
    return store;
  };
  /**
   * Embedder dùng được cho lần gọi này: probe nhanh (cache 60s, timeout
   * 1.5s) thay vì để `embed` treo tới 30s khi Ollama chưa chạy — khi
   * Ollama chết, save/search chạy ở chế độ không-embedding (recall
   * từ khoá, memory vẫn lưu).
   */
  const usableEmbedder = async (): Promise<Embedder | undefined> => {
    if (!embedder) return undefined;
    try {
      return (await isEmbedderAvailableCached(embedder)) ? embedder : undefined;
    } catch {
      return undefined;
    }
  };

  const memorySave: Tool = {
    definition: toolDef(
      'memory_save',
      'Save ONE long-term memory about the user (key + value, e.g. key "sở thích ăn uống", value "thích phở bò, không ăn cay"). CONSENT RULE — call this ONLY when the user explicitly asked to remember something ("hãy nhớ ...", "ghi nhớ ...", "lưu lại ...") or explicitly approved a concrete save you proposed. NEVER silently record facts, preferences or habits you merely inferred from the conversation — if the user did not ask to save it, do not save it. Saving always asks the user to approve first (approval card). Same key for the same bot overwrites the old value. Tags help later recall.',
      {
        key: { type: 'string', description: 'Tên ngắn của điều cần nhớ (vd "sở thích ăn uống").' },
        value: { type: 'string', description: 'Nội dung cần nhớ.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tag tuỳ chọn (vd ["ăn uống", "sở thích"]).' },
        confidence: { type: 'number', description: 'Độ tin cậy 0..1 (mặc định 0.8).' },
        shared: { type: 'boolean', description: 'true = memory chung cho mọi bot (mặc định); false = chỉ bot này nhớ.' },
      },
      ['key', 'value'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const key = getStringArg(args, 'key');
        const value = getStringArg(args, 'value');
        const tags = getStringArrayArg(args, 'tags');
        const confidence = getNumberArg(args, 'confidence');
        const sharedRaw = args['shared'];
        const shared = sharedRaw === undefined ? true : sharedRaw === true;
        const input = {
          key,
          value,
          tags,
          ...(confidence !== undefined ? { confidence } : {}),
          botId: shared ? '' : ctx.botId,
          ...(userIdOf() !== undefined ? { userId: userIdOf() } : {}),
        };
        if (embedder) {
          const live = await usableEmbedder();
          if (live) {
            const result = await s.rememberWithEmbedding(input, live);
            return JSON.stringify(
              {
                saved: true,
                id: result.entry.id,
                key: result.entry.key,
                botId: result.entry.botId,
                embedded: result.embedded,
                ...(result.embedded ? {} : { embeddingNote: result.error ?? 'Không embed được — memory đã lưu nhưng chưa có vector.' }),
              },
              null,
              2,
            );
          }
        }
        const entry = s.remember(input);
        return JSON.stringify(
          { saved: true, id: entry.id, key: entry.key, botId: entry.botId, embedded: false },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const memorySearch: Tool = {
    definition: toolDef(
      'memory_search',
      'Search long-term memories about the user (semantic search via local Ollama embeddings when available, keyword fallback otherwise — the result says which one was used). Use it when the current question may relate to something saved before (preferences, facts, habits). Returns matching memories with a score, most relevant first. Read-only, never writes.',
      {
        query: { type: 'string', description: 'Câu hỏi / từ khoá cần tìm trong memory.' },
        limit: { type: 'number', description: 'Số kết quả tối đa (mặc định 5, tối đa 20).' },
        tag: { type: 'string', description: 'Chỉ tìm memory có tag này.' },
        includeShared: { type: 'boolean', description: 'true = kèm memory chung (mặc định true).' },
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const query = getStringArg(args, 'query');
        const limitRaw = getNumberArg(args, 'limit');
        const limit = limitRaw === undefined ? 5 : Math.max(1, Math.min(20, Math.floor(limitRaw)));
        const tag = getOptionalStringArg(args, 'tag');
        const includeSharedRaw = args['includeShared'];
        const includeShared = includeSharedRaw === undefined ? true : includeSharedRaw === true;
        const live = await usableEmbedder();
        const result = await s.recallSemantic(query, {
          ...(live ? { embedder: live } : {}),
          botId: ctx.botId,
          includeShared,
          ...(userIdOf() !== undefined ? { userId: userIdOf() } : {}),
          ...(tag !== undefined ? { tag } : {}),
          limit,
        });
        return JSON.stringify(
          {
            query,
            usedFallback: result.usedFallback,
            ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
            hits: result.hits.map((h) => ({ ...publicMemoryEntry(h.entry), score: h.score })),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const memoryList: Tool = {
    definition: toolDef(
      'memory_list',
      'List long-term memories about the user, newest first (optionally filtered by keyword and/or tag). Use it to review what is remembered before answering "what do you remember about me?". Read-only, never writes.',
      {
        query: { type: 'string', description: 'Từ khoá lọc (không bắt buộc).' },
        tag: { type: 'string', description: 'Chỉ liệt kê memory có tag này.' },
        limit: { type: 'number', description: 'Số kết quả tối đa (mặc định 20, tối đa 200).' },
        includeShared: { type: 'boolean', description: 'true = kèm memory chung (mặc định true).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const query = getOptionalStringArg(args, 'query');
        const tag = getOptionalStringArg(args, 'tag');
        const limitRaw = getNumberArg(args, 'limit');
        const limit = limitRaw === undefined ? 20 : Math.max(1, Math.min(200, Math.floor(limitRaw)));
        const includeSharedRaw = args['includeShared'];
        const includeShared = includeSharedRaw === undefined ? true : includeSharedRaw === true;
        const entries = s.recall({
          ...(query !== undefined ? { query } : {}),
          ...(tag !== undefined ? { tag } : {}),
          botId: ctx.botId,
          includeShared,
          ...(userIdOf() !== undefined ? { userId: userIdOf() } : {}),
          limit,
        });
        return JSON.stringify(
          { count: entries.length, entries: entries.map(publicMemoryEntry) },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const memoryDelete: Tool = {
    definition: toolDef(
      'memory_delete',
      'Delete ONE long-term memory by id (preferred — see memory_list/memory_search for ids) or by key for the calling bot. Always asks the user to approve first (approval card). Use it when the user says "forget ..." or asks to remove something remembered.',
      {
        id: { type: 'string', description: 'Id của memory cần xoá (ưu tiên dùng id).' },
        key: { type: 'string', description: 'Key của memory cần xoá (khi không có id).' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const id = getOptionalStringArg(args, 'id');
        const key = getOptionalStringArg(args, 'key');
        if (!id && !key) {
          throw new Error('memory_delete cần "id" hoặc "key".');
        }
        let deleted = false;
        if (id) {
          deleted = s.forgetById(id);
        } else {
          deleted = s.forget(key as string, ctx.botId, userIdOf());
        }
        return JSON.stringify({ deleted, ...(id ? { id } : { key }) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [memorySave, memorySearch, memoryList, memoryDelete];
}

/** Unbound placeholder (same shape as AGENT_TOOLS in agentTools.ts). */
export const MEMORY_TOOLS: Tool[] = createMemoryTools();
