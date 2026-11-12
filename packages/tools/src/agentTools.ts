/**
 * Agent-to-agent / grind / reflect tools for @open-bot/tools (v0.6).
 *
 * How each tool reaches the outside world (all through factory
 * callbacks — this file owns no bot registry, no provider and no
 * coordinator process):
 *  - create_agent: opts.createBot(config) — the host creates the bot
 *    (coordinator.createBot / in-memory registry) and returns its id.
 *  - message_agent: opts.sendToAgent(botId, text) first; else
 *    opts.coordinator.run(botId, text) (node-agent-coordinator client);
 *    else opts.runAgentInProcess(botId, text) — the in-process fallback
 *    the tests use with a mock provider (AgentRunner + mock provider).
 *    A reply string is returned as-is; an empty reply means "queued".
 *  - set_agent_mode: opts.setBotMode(botId, mode) first; else the mode
 *    is persisted in BotMemory (key `agent:mode` for that bot); else a
 *    factory-local in-memory map. The mode type lives in
 *    @open-bot/core (BotConfigWithMode) —
 *    packages/core/src/types.ts was NOT extended.
 *  - reflect: reflectOnProgress(memory, botId) from
 *    @open-bot/core, saved with saveReflection
 *    as a memory note. The agent loop never calls it by itself.
 *  - search_conversations: opts.searchAllHistories(query) first; else
 *    opts.listBotIds() + memory.getHistory per bot.
 *  - read_agent_transcript: opts.getBotTranscript(targetBotId) or
 *    memory.getHistory, gated by opts.canReadBot or the DEFAULT policy
 *    below (same local user may read; another team may not).
 *  - conversation_history: memory.getHistory for the CALLING bot only
 *    (ctx.botId) — the current conversation's own stored messages,
 *    paginated; read-only, never writes.
 *  - grind_start / grind_status / grind_stop / grind_pause: startGrind /
 *    getGrindStatus / stopGrind / pauseGrind + advanceGrind from coordination.ts,
 *    checkpointed durably in BotMemory. grind_start executes the
 *    first slice only when executeFirstSlice is true AND a step runner
 *    is available (opts.executeStep, else ctx.runSubagent); otherwise
 *    it only plans and returns the first slice to execute.
 *
 * Factory:
 *   createAgentTools(opts?) -> Tool[]   (bound, usable)
 *   AGENT_TOOLS                          (unbound placeholder)
 *
 * Approval: create_agent, message_agent, set_agent_mode and the grind
 * start/stop change state or spend another bot's tokens -> true; the
 * read-only tools (reflect, search, transcript, conversation_history,
 * grind_status) -> false.
 */
import type { BotConfig, BotMemory, Tool, ToolContext } from '@open-bot/core';
import {
  AGENT_MODES,
  advanceGrind,
  getGrindStatus,
  isAgentMode,
  pauseGrind,
  reflectOnProgress,
  saveReflection,
  startGrind,
  stopGrind,
  Supervisor,
} from '@open-bot/core';
import type { AgentCapability, AgentMode, GrindState, ReflectionSummary } from '@open-bot/core';
import { truncateText as truncate } from './truncate';

/** BotConfig plus the optional working mode (defined in coordination.ts). */
export type AgentBotConfig = Partial<BotConfig> & { mode?: AgentMode };

export interface CreatedAgentInfo {
  id: string;
  name: string;
  providerId: string;
  model: string;
  mode?: AgentMode;
  systemPrompt?: string;
}

export type CreateBotFn = (config: AgentBotConfig) => Promise<CreatedAgentInfo> | CreatedAgentInfo;

/** Minimal coordinator-client surface used by message_agent. */
export interface CoordinatorRunLike {
  run(botId: string, text: string): Promise<{ text: string; stopped?: boolean } | string>;
}

export interface HistoryHit {
  botId: string;
  role: string;
  content: string;
  createdAt?: string;
}

export interface AgentToolOptions {
  /** BotMemory for reflect / mode persistence / search / transcript / grind. */
  memory?: BotMemory;
  /** Create a bot; must return at least { id, name, providerId, model }. */
  createBot?: CreateBotFn;
  /** Send a message to another bot; resolves with its reply ('' = queued). */
  sendToAgent?: (botId: string, text: string) => Promise<string>;
  /** node-agent-coordinator client (used when sendToAgent is absent). */
  coordinator?: CoordinatorRunLike;
  /** In-process fallback for message_agent (tests: AgentRunner + mock provider). */
  runAgentInProcess?: (botId: string, text: string) => Promise<string>;
  /** Persist/apply a bot's working mode; default: BotMemory / in-memory map. */
  setBotMode?: (botId: string, mode: AgentMode) => Promise<AgentBotConfig> | AgentBotConfig;
  /** Search every bot's history; default: listBotIds() + memory.getHistory. */
  searchAllHistories?: (query: string) => Promise<HistoryHit[]> | HistoryHit[];
  /** Bot ids owned by this user (default search + default read policy). */
  listBotIds?: () => Promise<string[]> | string[];
  /** Full transcript of one bot; default: memory.getHistory. */
  getBotTranscript?: (botId: string, limit?: number) => Promise<HistoryHit[]> | HistoryHit[];
  /**
   * Permission check for read_agent_transcript. When absent, the
   * DEFAULT POLICY applies (see defaultCanReadBot): the requester may
   * read its own transcript and transcripts of bots owned by the same
   * local user (both ids in listBotIds); any other bot is treated as
   * another team and refused.
   */
  canReadBot?: (requesterBotId: string, targetBotId: string) => Promise<boolean> | boolean;
  /** Override for reflect (tests / DI); default is the real reflectOnProgress. */
  reflectFn?: (memory: BotMemory, botId: string) => ReflectionSummary;
  /** Run one grind step (used by grind_start executeFirstSlice). */
  executeStep?: (stepTitle: string) => Promise<string> | string;
  /**
   * v0.14: capabilities of local bots for supervisor_dispatch (host
   * provides descriptions + skills; without it the tool explains that
   * supervisor routing is not wired in this session).
   */
  listBotCapabilities?: (agentIds?: string[]) => Promise<AgentCapability[]> | AgentCapability[];
}

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

function getBoolArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Argument "${name}" must be a boolean, got ${typeof value}`);
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

function asAgentMode(value: string): AgentMode {
  if (!isAgentMode(value)) {
    throw new Error(
      `Invalid mode "${value}" (expected one of: ${AGENT_MODES.join(', ')})`,
    );
  }
  return value;
}

/**
 * DEFAULT POLICY for read_agent_transcript (used only when the host
 * does not supply canReadBot):
 *  - same bot (requester === target): allowed;
 *  - both bots owned by the same local user (both ids in knownBotIds):
 *    allowed — "cùng user";
 *  - otherwise: DENIED — treated as another team ("khác team").
 * This is a local default only: it trusts the host's listBotIds, there
 * is no central server / real authentication (same limits as team
 * sharing v0.3/v0.5). Hosts with real team data should pass canReadBot.
 */
export function defaultCanReadBot(
  requesterBotId: string,
  targetBotId: string,
  knownBotIds: string[] = [],
): boolean {
  if (requesterBotId === targetBotId) return true;
  if (knownBotIds.includes(requesterBotId) && knownBotIds.includes(targetBotId)) return true;
  return false;
}

export function createAgentTools(opts: AgentToolOptions = {}): Tool[] {
  /** Fallback mode store when neither setBotMode nor memory is available. */
  const modeByBot = new Map<string, AgentMode>();

  const createAgent: Tool = {
    definition: toolDef(
      'create_agent',
      'Tạo một bot/agent mới qua host (callback createBot): đặt tên, provider, model, system prompt và chế độ làm việc ban đầu. Trả về id + tên của bot mới.',
      {
        name: { type: 'string', description: 'Tên bot (không rỗng, tối đa 200 ký tự).' },
        providerId: { type: 'string', description: 'Id provider, ví dụ "grok", "openai", "ollama".' },
        model: { type: 'string', description: 'Tên model, ví dụ "grok-4.7".' },
        systemPrompt: { type: 'string', description: 'Hướng dẫn hệ thống cho bot (không bắt buộc).' },
        mode: { type: 'string', description: 'Chế độ làm việc ban đầu: chat, plan, grind, review (mặc định chat).' },
        workspaceDir: { type: 'string', description: 'Thư mục workspace của bot (không bắt buộc).' },
      },
      ['name', 'providerId', 'model'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        if (!opts.createBot) {
          return errorResult(
            'create_agent chưa được hỗ trợ trong phiên này (chưa có callback createBot — host phải truyền createBot vào createAgentTools).',
          );
        }
        const name = getStringArg(args, 'name').trim();
        if (!name) throw new Error('Tên bot không được rỗng.');
        if (name.length > 200) throw new Error('Tên bot tối đa 200 ký tự.');
        const providerId = getStringArg(args, 'providerId').trim();
        if (!providerId) throw new Error('providerId không được rỗng.');
        const model = getStringArg(args, 'model').trim();
        if (!model) throw new Error('model không được rỗng.');
        const modeRaw = getOptionalStringArg(args, 'mode');
        const mode = modeRaw === undefined ? undefined : asAgentMode(modeRaw);
        const created = await opts.createBot({
          name,
          providerId,
          model,
          systemPrompt: getOptionalStringArg(args, 'systemPrompt') ?? '',
          workspaceDir: getOptionalStringArg(args, 'workspaceDir') ?? '',
          ...(mode !== undefined ? { mode } : {}),
        });
        if (!created || typeof created.id !== 'string' || !created.id) {
          return errorResult('createBot trả về kết quả không hợp lệ (thiếu id).');
        }
        return JSON.stringify(
          { id: created.id, name: created.name, providerId: created.providerId, model: created.model, ...(created.mode !== undefined ? { mode: created.mode } : {}) },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const messageAgent: Tool = {
    definition: toolDef(
      'message_agent',
      'Gửi một message cho một agent khác theo botId và chờ phản hồi của nó. Tốn token của bot nhận (cần phê duyệt). Trả về phản hồi, hoặc xác nhận đã xếp hàng khi bot nhận trả về rỗng.',
      {
        botId: { type: 'string', description: 'Id của bot nhận message.' },
        text: { type: 'string', description: 'Nội dung message gửi cho bot đó.' },
      },
      ['botId', 'text'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const botId = getStringArg(args, 'botId').trim();
        const text = getStringArg(args, 'text');
        if (!botId) throw new Error('botId không được rỗng.');
        if (!text.trim()) throw new Error('text không được rỗng.');
        let reply: string | undefined;
        if (opts.sendToAgent) {
          reply = await opts.sendToAgent(botId, text);
        } else if (opts.coordinator) {
          const res = await opts.coordinator.run(botId, text);
          reply = typeof res === 'string' ? res : res.text;
        } else if (opts.runAgentInProcess) {
          reply = await opts.runAgentInProcess(botId, text);
        } else {
          return errorResult(
            'message_agent chưa được hỗ trợ trong phiên này (chưa có kênh gửi tới agent khác — host phải truyền sendToAgent, coordinator hoặc runAgentInProcess vào createAgentTools).',
          );
        }
        if (reply !== undefined && reply.trim() !== '') {
          return JSON.stringify({ botId, reply, queued: false }, null, 2);
        }
        return JSON.stringify(
          { botId, reply: '', queued: true, note: 'Message đã xếp hàng cho bot nhận; chưa có phản hồi ngay.' },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const setAgentMode: Tool = {
    definition: toolDef(
      'set_agent_mode',
      'Đổi chế độ làm việc của một agent: chat (trò chuyện), plan (lập kế hoạch), grind (làm dài hơi theo lát cắt), review (rà soát). Mode được lưu bền qua callback setBotMode hoặc BotMemory.',
      {
        botId: { type: 'string', description: 'Id của bot cần đổi mode.' },
        mode: { type: 'string', description: 'Mode mới: chat, plan, grind, review.' },
      },
      ['botId', 'mode'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const botId = getStringArg(args, 'botId').trim();
        const mode = asAgentMode(getStringArg(args, 'mode'));
        if (!botId) throw new Error('botId không được rỗng.');
        let previous: AgentMode | undefined;
        if (opts.memory) {
          const prev = opts.memory.getMemory(botId, 'agent:mode');
          if (prev && isAgentMode(prev)) previous = prev;
        } else if (modeByBot.has(botId)) {
          previous = modeByBot.get(botId);
        }
        if (opts.setBotMode) {
          await opts.setBotMode(botId, mode);
        } else if (opts.memory) {
          opts.memory.setMemory(botId, 'agent:mode', mode);
        } else {
          modeByBot.set(botId, mode);
        }
        return JSON.stringify({ botId, mode, ...(previous !== undefined ? { previous } : {}) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const reflect: Tool = {
    definition: toolDef(
      'reflect',
      'Tự phản tư: tóm tắt có cấu trúc từ lịch sử + task của chính bot này — đã xong gì, đang kẹt gì, bước tiếp theo là gì. Kết quả được lưu vào memory dưới dạng ghi chú (reflection:latest). Agent loop không tự gọi tool này.',
      {},
      [],
    ),
    needsApproval: false,
    async execute(_args, ctx) {
      try {
        if (!opts.memory) {
          return errorResult(
            'reflect chưa được hỗ trợ trong phiên này (chưa có BotMemory — host phải truyền memory vào createAgentTools).',
          );
        }
        const fn = opts.reflectFn ?? reflectOnProgress;
        const summary = fn(opts.memory, ctx.botId);
        const keys = saveReflection(opts.memory, summary);
        return JSON.stringify({ ...summary, savedKeys: keys }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const searchConversations: Tool = {
    definition: toolDef(
      'search_conversations',
      'Tìm trong lịch sử hội thoại của mọi bot mà user sở hữu (khớp chuỗi con, không phân biệt hoa thường). Trả về các đoạn trích kèm botId + role.',
      {
        query: { type: 'string', description: 'Từ khoá cần tìm.' },
        limit: { type: 'number', description: 'Số kết quả tối đa (mặc định 20, tối đa 50).' },
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const query = getStringArg(args, 'query').trim();
        if (!query) throw new Error('query không được rỗng.');
        const limitRaw = getNumberArg(args, 'limit');
        const limit = limitRaw === undefined ? 20 : Math.max(1, Math.min(50, Math.floor(limitRaw)));
        let hits: HistoryHit[];
        if (opts.searchAllHistories) {
          hits = await opts.searchAllHistories(query);
        } else if (opts.memory && opts.listBotIds) {
          const botIds = await opts.listBotIds();
          const needle = query.toLowerCase();
          hits = [];
          for (const botId of botIds) {
            for (const msg of opts.memory.getHistory(botId, 200)) {
              if (!msg.content.toLowerCase().includes(needle)) continue;
              const idx = msg.content.toLowerCase().indexOf(needle);
              const start = Math.max(0, idx - 80);
              const excerpt = msg.content.slice(start, idx + query.length + 80);
              hits.push({ botId, role: msg.role, content: excerpt });
              if (hits.length >= limit) break;
            }
            if (hits.length >= limit) break;
          }
        } else {
          return errorResult(
            'search_conversations chưa được hỗ trợ trong phiên này (cần callback searchAllHistories, hoặc memory + listBotIds).',
          );
        }
        return JSON.stringify(hits.slice(0, limit), null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const readAgentTranscript: Tool = {
    definition: toolDef(
      'read_agent_transcript',
      'Đọc transcript đầy đủ của một bot khác. Có kiểm tra quyền: chỉ được đọc khi cùng user (bot đó thuộc user này) hoặc bot được chia sẻ cho bot này — mặc định từ chối khi khác team (xem defaultCanReadBot).',
      {
        botId: { type: 'string', description: 'Id của bot cần đọc transcript.' },
        limit: { type: 'number', description: 'Số message tối đa (mặc định 50).' },
      },
      ['botId'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const targetBotId = getStringArg(args, 'botId').trim();
        if (!targetBotId) throw new Error('botId không được rỗng.');
        const limitRaw = getNumberArg(args, 'limit');
        const limit = limitRaw === undefined ? 50 : Math.max(1, Math.floor(limitRaw));
        let allowed: boolean;
        if (opts.canReadBot) {
          allowed = await opts.canReadBot(ctx.botId, targetBotId);
        } else {
          const known = opts.listBotIds ? await opts.listBotIds() : [];
          allowed = defaultCanReadBot(ctx.botId, targetBotId, known);
        }
        if (!allowed) {
          return errorResult(
            `Không có quyền đọc transcript của bot "${targetBotId}" (khác team / bot không thuộc user này).`,
          );
        }
        let messages: HistoryHit[];
        if (opts.getBotTranscript) {
          messages = await opts.getBotTranscript(targetBotId, limit);
        } else if (opts.memory) {
          messages = opts.memory
            .getHistory(targetBotId, limit)
            .map((m) => ({ botId: targetBotId, role: m.role, content: m.content }));
        } else {
          return errorResult(
            'read_agent_transcript chưa được hỗ trợ trong phiên này (cần BotMemory hoặc callback getBotTranscript).',
          );
        }
        return JSON.stringify({ botId: targetBotId, messages: messages.slice(0, limit) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const conversationHistory: Tool = {
    definition: toolDef(
      'conversation_history',
      'Read this conversation\'s own stored history (READ-ONLY, never writes): the original user/assistant messages of the CURRENT conversation, oldest first, paginated. Unlike the run context — which only keeps a summary after compaction — BotMemory keeps the original messages, so this tool re-reads turns that were already compacted away; use it when you need the exact wording of an earlier turn instead of the summary. Limits (same caps as the other read tools): at most 200 messages per call (default 50) and the whole result truncated at 20,000 chars like read_file. `offset` skips that many of the most recent messages (page 2 = offset 50 with limit 50).',
      {
        limit: { type: 'number', description: 'Số message tối đa (mặc định 50, tối đa 200).' },
        offset: { type: 'number', description: 'Bỏ qua N message mới nhất để phân trang (mặc định 0).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        if (!opts.memory) {
          return errorResult(
            'conversation_history chưa được hỗ trợ trong phiên này (chưa có BotMemory — host phải truyền memory vào createAgentTools).',
          );
        }
        const limitRaw = getNumberArg(args, 'limit');
        const limit = limitRaw === undefined ? 50 : Math.max(1, Math.min(200, Math.floor(limitRaw)));
        const offsetRaw = getNumberArg(args, 'offset');
        const offset = offsetRaw === undefined ? 0 : Math.max(0, Math.floor(offsetRaw));
        // Lấy thừa 1 message để biết còn trang sau không (hasMore) mà
        // không cần đếm tổng. getHistory trả N message mới nhất, oldest
        // first — nên trang = đoạn CUỐI của mảng đã trừ offset: bắt đầu
        // ở fetched.length - (limit + offset), kết thúc ở
        // fetched.length - offset.
        const fetched = opts.memory.getHistory(ctx.botId, limit + offset + 1);
        const hasMore = fetched.length > limit + offset;
        const start = Math.max(0, fetched.length - (limit + offset));
        const end = Math.max(start, fetched.length - offset);
        const page = fetched.slice(start, end);
        return truncate(
          JSON.stringify(
            {
              botId: ctx.botId,
              messages: page.map((m) => ({ role: m.role, content: m.content })),
              returned: page.length,
              offset,
              hasMore,
            },
            null,
            2,
          ),
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const grindStart: Tool = {
    definition: toolDef(
      'grind_start',
      'Bắt đầu một mục tiêu dài hơi (grind): lập plan (project + task từng bước), rồi thực thi theo lát cắt (mỗi lát sliceSize bước), checkpoint bền vào memory sau mỗi lát, có thể resume bằng grind_status. Mặc định chỉ lập plan; đặt executeFirstSlice=true để chạy luôn lát đầu (cần ctx.runSubagent hoặc callback executeStep).',
      {
        goal: { type: 'string', description: 'Mục tiêu dài hơi (tên project).' },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Các bước thực hiện, mỗi bước thành một task.',
        },
        sliceSize: { type: 'number', description: 'Số bước mỗi lát cắt (mặc định 3).' },
        detail: { type: 'string', description: 'Mô tả chi tiết mục tiêu (không bắt buộc).' },
        executeFirstSlice: { type: 'boolean', description: 'true = chạy luôn lát đầu tiên sau khi lập plan.' },
      },
      ['goal', 'steps'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        if (!opts.memory) {
          return errorResult(
            'grind_start chưa được hỗ trợ trong phiên này (chưa có BotMemory — host phải truyền memory vào createAgentTools).',
          );
        }
        const goal = getStringArg(args, 'goal');
        const steps = getStringArrayArg(args, 'steps');
        const sliceSize = getNumberArg(args, 'sliceSize');
        const { state, projectId, firstSlice } = startGrind(opts.memory, ctx.botId, goal, steps, {
          sliceSize,
          detail: getOptionalStringArg(args, 'detail') ?? '',
        });
        let advance: { state: GrindState; results: string[] } | null = null;
        if (getBoolArg(args, 'executeFirstSlice') === true) {
          const runStep = opts.executeStep
            ? async (step: { title: string }): Promise<string> => String(await opts.executeStep!(step.title))
            : ctx.runSubagent
              ? async (step: { title: string }): Promise<string> => ctx.runSubagent!(step.title)
              : undefined;
          if (runStep) {
            const res = await advanceGrind(opts.memory, ctx.botId, projectId, runStep);
            advance = { state: res.state, results: res.results };
          }
        }
        return JSON.stringify(
          {
            projectId,
            goal: state.goal,
            status: advance ? advance.state.status : state.status,
            sliceSize: state.sliceSize,
            totalSlices: state.totalSlices,
            firstSlice: firstSlice.map((s) => s.title),
            checkpoint: advance ? advance.state.checkpoint : state.checkpoint,
            ...(advance ? { firstSliceResults: advance.results } : { note: 'Chưa thực thi lát nào — dùng grind_status để xem, advance tiếp theo chạy lát đầu.' }),
          },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const grindStatus: Tool = {
    definition: toolDef(
      'grind_status',
      'Xem trạng thái một grind: checkpoint cuối, số bước đã xong / còn chờ, và các bước của lát tiếp theo.',
      {
        projectId: { type: 'string', description: 'Id project của grind (trả về từ grind_start).' },
      },
      ['projectId'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        if (!opts.memory) {
          return errorResult(
            'grind_status chưa được hỗ trợ trong phiên này (chưa có BotMemory).',
          );
        }
        const projectId = getStringArg(args, 'projectId');
        const report = getGrindStatus(opts.memory, ctx.botId, projectId);
        return JSON.stringify(report, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const grindStop: Tool = {
    definition: toolDef(
      'grind_stop',
      'Dừng một grind đang chạy. Checkpoint và các task đã xong được giữ lại trong memory để xem lại.',
      {
        projectId: { type: 'string', description: 'Id project của grind (trả về từ grind_start).' },
        reason: { type: 'string', description: 'Lý do dừng (không bắt buộc).' },
      },
      ['projectId'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        if (!opts.memory) {
          return errorResult(
            'grind_stop chưa được hỗ trợ trong phiên này (chưa có BotMemory).',
          );
        }
        const projectId = getStringArg(args, 'projectId');
        const state = stopGrind(opts.memory, ctx.botId, projectId, getOptionalStringArg(args, 'reason') ?? '');
        return JSON.stringify(state, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const grindPause: Tool = {
    definition: toolDef(
      'grind_pause',
      'Tạm dừng một grind đang chạy để hỏi user (interrupt HITL, v0.54): checkpoint và các task đã xong được giữ nguyên, grind chuyển sang paused; dùng grind_status / resumeGrind để tiếp tục từ lát tiếp theo mà không cần lập plan mới. Khác grind_stop ở chỗ stop là dừng hẳn, pause là dừng tạm để tiếp tục.',
      {
        projectId: { type: 'string', description: 'Id project của grind (trả về từ grind_start).' },
        question: { type: 'string', description: 'Câu hỏi chờ user trả lời trước khi tiếp tục (không bắt buộc).' },
      },
      ['projectId'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        if (!opts.memory) {
          return errorResult(
            'grind_pause chưa được hỗ trợ trong phiên này (chưa có BotMemory).',
          );
        }
        const projectId = getStringArg(args, 'projectId');
        const state = pauseGrind(opts.memory, ctx.botId, projectId, getOptionalStringArg(args, 'question') ?? '');
        return JSON.stringify(state, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const supervisorDispatch: Tool = {
    definition: toolDef(
      'supervisor_dispatch',
      'Giao một việc cho bot phù hợp nhất theo năng lực (supervisor/swarm): chấm điểm từng bot theo mô tả + skill của nó, chạy việc ở bot điểm cao nhất (sequential: lỗi thì thử bot tiếp theo; parallel: chạy top-N cùng lúc). Tốn token của bot nhận (cần phê duyệt).',
      {
        task: { type: 'string', description: 'Việc cần giao (mô tả rõ ràng).' },
        mode: {
          type: 'string',
          description: '"sequential" (mặc định: thử bot tốt nhất, lỗi thì thử bot tiếp theo) hoặc "parallel" (chạy top-N cùng lúc).',
        },
        top_n: { type: 'number', description: 'Số bot chạy cùng lúc ở mode parallel (mặc định 2).' },
        agent_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Chỉ xét các bot này (mặc định: tất cả bot).',
        },
      },
      ['task'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const task = getStringArg(args, 'task');
        if (!task.trim()) throw new Error('task không được rỗng.');
        if (!opts.listBotCapabilities) {
          return errorResult(
            'supervisor_dispatch chưa được hỗ trợ trong phiên này (host chưa truyền listBotCapabilities vào createAgentTools).',
          );
        }
        const agentIds = getStringArrayArg(args, 'agent_ids');
        const agents = await opts.listBotCapabilities(agentIds.length > 0 ? agentIds : undefined);
        if (agents.length === 0) {
          return errorResult('Không có bot nào để giao việc (danh sách agent rỗng).');
        }
        const mode = getOptionalStringArg(args, 'mode');
        if (mode !== undefined && mode !== 'sequential' && mode !== 'parallel') {
          throw new Error('mode phải là "sequential" hoặc "parallel".');
        }
        const topN = getNumberArg(args, 'top_n');
        const supervisor = new Supervisor();
        const results = await supervisor.dispatch(task, {
          agents,
          mode: mode === 'parallel' ? 'parallel' : 'sequential',
          topN,
          handoff: async (agentId, text) => {
            if (opts.sendToAgent) return opts.sendToAgent(agentId, text);
            if (opts.coordinator) {
              const res = await opts.coordinator.run(agentId, text);
              return typeof res === 'string' ? res : res.text;
            }
            if (opts.runAgentInProcess) return opts.runAgentInProcess(agentId, text);
            throw new Error(
              'Không có kênh gửi tới agent khác (host phải truyền sendToAgent, coordinator hoặc runAgentInProcess).',
            );
          },
        });
        const lines = results.map((r) => {
          if (r.error) return `- ${r.agentId} (score ${r.score.toFixed(2)}): LỖI: ${r.error}`;
          return `- ${r.agentId} (score ${r.score.toFixed(2)}):\n${typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? '')}`;
        });
        return `Supervisor (${mode === 'parallel' ? 'parallel' : 'sequential'}) — việc "${task}":\n${lines.join('\n')}`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    createAgent,
    messageAgent,
    supervisorDispatch,
    setAgentMode,
    reflect,
    searchConversations,
    readAgentTranscript,
    conversationHistory,
    grindStart,
    grindStatus,
    grindStop,
    grindPause,
  ];
}

/**
 * Unbound placeholder: same tool shapes, but no callbacks / memory
 * attached, so every execute() returns a clear "not supported" error.
 * Real usage:
 *   const tools = createAgentTools({ memory, createBot, sendToAgent, ... });
 */
export const AGENT_TOOLS: Tool[] = createAgentTools();

export type { ToolContext };
