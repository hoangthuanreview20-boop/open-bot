/**
 * Memory block tools cho @open-bot/tools (v0.96, Đội T1).
 *
 * Agent tự sửa memory bằng tool call trong turn (self-editing):
 *  - memory_block_create   — tạo block mới (needsApproval: true)
 *  - memory_block_list     — liệt kê block (đọc, không cần duyệt)
 *  - memory_block_get      — xem một block (đọc, không cần duyệt)
 *  - memory_block_append   — nối thêm nội dung (needsApproval: true)
 *  - memory_block_replace  — ghi đè nội dung (needsApproval: true)
 *  - memory_block_delete   — xoá block (needsApproval: true)
 *  - memory_block_attach   — attach block vào bot (needsApproval: true)
 *  - memory_block_detach   — detach block khỏi bot (needsApproval: true)
 *  - memory_block_share    — share block cho bot khác / mọi bot (needsApproval: true)
 *  - memory_consolidate    — chạy/xem/cấu hình consolidation (needsApproval: true)
 *
 * QUY TẮC BẢO VỆ (áp dụng ở store, tool chỉ chuyển tiếp lỗi rõ):
 * block read-only không sửa/xoá được nội dung — agent phải xin user
 * tắt read-only trước. Mọi lần ghi đều đi qua thẻ duyệt của user
 * (needsApproval) và ghi audit với actor `agent:<botId>` vào
 * `.open-bot/memory-blocks-audit.jsonl`, nên không có đường sửa lén.
 *
 * Scope: block sống trong store của workspace bot đang chạy; attach
 * theo botId. Tool không bao giờ trả nội dung nhạy cảm nào khác ngoài
 * chính các block (không có vector embedding ở đây).
 *
 * Factory:
 *   createMemoryBlockTools(opts) -> Tool[]   (bound, usable)
 *   MEMORY_BLOCK_TOOLS                       (unbound placeholder)
 */
import type { LongTermMemory, MemoryBlockStore, Tool } from '@open-bot/core';
import { consolidate } from '@open-bot/core';

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

export interface MemoryBlockToolOptions {
  /** Memory block store của workspace (bắt buộc để tool chạy). */
  blocksStore?: MemoryBlockStore;
  /** Long-term memory store (bắt buộc cho memory_consolidate run). */
  longTermStore?: LongTermMemory;
  /** userId hiện tại (từ profile.json); vắng = không lọc theo user. */
  getUserId?: () => string | undefined;
}

export function createMemoryBlockTools(opts: MemoryBlockToolOptions = {}): Tool[] {
  const { blocksStore, longTermStore } = opts;
  const userIdOf = (): string | undefined => {
    try {
      const id = opts.getUserId?.();
      return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
    } catch {
      return undefined;
    }
  };
  const needStore = (): MemoryBlockStore => {
    if (!blocksStore) {
      throw new Error(
        'memory blocks chưa được hỗ trợ trong phiên này (host phải truyền MemoryBlockStore vào createMemoryBlockTools).',
      );
    }
    return blocksStore;
  };
  const needLongTerm = (): LongTermMemory => {
    if (!longTermStore) {
      throw new Error(
        'consolidation cần long-term memory store (host phải truyền longTermStore vào createMemoryBlockTools).',
      );
    }
    return longTermStore;
  };
  const actorOf = (ctx: { botId: string }): string => `agent:${ctx.botId}`;

  /** Block trả cho model/UI: kèm trạng thái attach + bot đang share. */
  const publicBlock = (block: {
    id: string;
    label: string;
    description: string;
    content: string;
    charLimit: number;
    readOnly: boolean;
    createdByBotId: string;
    version: number;
    createdAt: string;
    updatedAt: string;
  }, callingBotId: string) => {
    const store = blocksStore as MemoryBlockStore | undefined;
    const attachedBots = store ? store.attachedBotIds(block.id) : [];
    return {
      ...block,
      attachedToCallingBot: attachedBots.includes(callingBotId),
      attachedBots,
    };
  };

  const memoryBlockCreate: Tool = {
    definition: toolDef(
      'memory_block_create',
      'Create ONE memory block — a named, size-limited chunk of memory the bot carries into every turn (rendered as <memory> in the system prompt). Labels are slugs, e.g. "human" (facts about the user), "persona" (how the bot should behave), "project-x" (project notes). A block only affects bots it is ATTACHED to — by default it is attached to the calling bot. Creating always asks the user to approve first (approval card). Content must fit the block char limit (default 2000).',
      {
        label: { type: 'string', description: 'Label duy nhất của block (slug: chữ thường, số, "-", "_" — vd "human", "persona", "so-thich").' },
        description: { type: 'string', description: 'Mô tả ngắn: block này nhớ cái gì.' },
        content: { type: 'string', description: 'Nội dung ban đầu của block (không vượt charLimit).' },
        charLimit: { type: 'number', description: 'Giới hạn ký tự của block (mặc định 2000, tối thiểu 100, tối đa 20000).' },
        readOnly: { type: 'boolean', description: 'true = block chỉ đọc, không sửa/xoá được nội dung (mặc định false).' },
        attach: { type: 'boolean', description: 'true = attach block mới vào bot đang gọi (mặc định true).' },
      },
      ['label'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const label = getStringArg(args, 'label');
        const description = getOptionalStringArg(args, 'description');
        const content = getOptionalStringArg(args, 'content');
        const charLimit = getNumberArg(args, 'charLimit');
        const readOnly = getBoolArg(args, 'readOnly', false);
        const attach = getBoolArg(args, 'attach', true);
        const block = s.create(
          {
            label,
            ...(description !== undefined ? { description } : {}),
            ...(content !== undefined ? { content } : {}),
            ...(charLimit !== undefined ? { charLimit } : {}),
            readOnly,
            createdByBotId: ctx.botId,
            ...(userIdOf() !== undefined ? { userId: userIdOf() } : {}),
          },
          actorOf(ctx),
        );
        if (attach) s.attach(ctx.botId, block.id, actorOf(ctx));
        return JSON.stringify({ created: true, block: publicBlock(block, ctx.botId) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const memoryBlockList: Tool = {
    definition: toolDef(
      'memory_block_list',
      'List memory blocks. By default only blocks attached to the calling bot (the ones actually in its system prompt); pass includeDetached=true to see every block in this workspace. Read-only, never writes.',
      {
        includeDetached: { type: 'boolean', description: 'true = liệt kê mọi block (kể cả chưa attach vào bot này). Mặc định false.' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const includeDetached = getBoolArg(args, 'includeDetached', false);
        const blocks = includeDetached
          ? s.list({ ...(userIdOf() !== undefined ? { userId: userIdOf() } : {}) })
          : s.list({ botId: ctx.botId, ...(userIdOf() !== undefined ? { userId: userIdOf() } : {}) });
        return JSON.stringify(
          { count: blocks.length, blocks: blocks.map((b) => publicBlock(b, ctx.botId)) },
          null,
          2,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const memoryBlockGet: Tool = {
    definition: toolDef(
      'memory_block_get',
      'Show ONE memory block by id or label, with its content and which bots it is attached to. Read-only, never writes.',
      {
        idOrLabel: { type: 'string', description: 'Id hoặc label của block (vd "human").' },
      },
      ['idOrLabel'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const idOrLabel = getStringArg(args, 'idOrLabel');
        const block = s.get(idOrLabel);
        if (!block) return errorResult(`Không tìm thấy memory block "${idOrLabel}".`);
        return JSON.stringify({ block: publicBlock(block, ctx.botId) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const memoryBlockAppend: Tool = {
    definition: toolDef(
      'memory_block_append',
      'Append text to the end of a memory block (as a new line). Use it to add a fact or note the bot should keep. Blocked when the block is read-only or the text would exceed the block char limit — the error says which. Always asks the user to approve first (approval card).',
      {
        idOrLabel: { type: 'string', description: 'Id hoặc label của block.' },
        text: { type: 'string', description: 'Text cần nối thêm.' },
      },
      ['idOrLabel', 'text'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const idOrLabel = getStringArg(args, 'idOrLabel');
        const text = getStringArg(args, 'text');
        const block = s.append(idOrLabel, text, actorOf(ctx));
        return JSON.stringify({ appended: true, block: publicBlock(block, ctx.botId) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const memoryBlockReplace: Tool = {
    definition: toolDef(
      'memory_block_replace',
      'Replace the ENTIRE content of a memory block. Use it to correct or rewrite what a block says — the old content is replaced, not kept. Blocked when the block is read-only or the new content exceeds the char limit. Always asks the user to approve first (approval card).',
      {
        idOrLabel: { type: 'string', description: 'Id hoặc label của block.' },
        content: { type: 'string', description: 'Nội dung mới toàn bộ của block.' },
      },
      ['idOrLabel', 'content'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const idOrLabel = getStringArg(args, 'idOrLabel');
        const content = getStringArg(args, 'content');
        const block = s.replace(idOrLabel, content, actorOf(ctx));
        return JSON.stringify({ replaced: true, block: publicBlock(block, ctx.botId) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const memoryBlockDelete: Tool = {
    definition: toolDef(
      'memory_block_delete',
      'Delete ONE memory block by id or label (removes it from every bot it was attached to). Blocked when the block is read-only. Always asks the user to approve first (approval card). Use it when the user says "forget ..." about a whole block or the block is no longer needed.',
      {
        idOrLabel: { type: 'string', description: 'Id hoặc label của block cần xoá.' },
      },
      ['idOrLabel'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const idOrLabel = getStringArg(args, 'idOrLabel');
        const deleted = s.delete(idOrLabel, actorOf(ctx));
        return JSON.stringify({ deleted, idOrLabel }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const memoryBlockAttach: Tool = {
    definition: toolDef(
      'memory_block_attach',
      'Attach a memory block to a bot so it appears in that bot\'s system prompt (<memory> section). Defaults to the calling bot. Always asks the user to approve first (approval card).',
      {
        idOrLabel: { type: 'string', description: 'Id hoặc label của block.' },
        botId: { type: 'string', description: 'Bot cần attach (mặc định: bot đang gọi).' },
      },
      ['idOrLabel'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const idOrLabel = getStringArg(args, 'idOrLabel');
        const botId = getOptionalStringArg(args, 'botId') ?? ctx.botId;
        const block = s.attach(botId, idOrLabel, actorOf(ctx));
        return JSON.stringify({ attached: true, botId, block: publicBlock(block, ctx.botId) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const memoryBlockDetach: Tool = {
    definition: toolDef(
      'memory_block_detach',
      'Detach a memory block from a bot so it no longer appears in that bot\'s system prompt (the block itself is kept and stays attached to other bots). Defaults to the calling bot. Always asks the user to approve first (approval card).',
      {
        idOrLabel: { type: 'string', description: 'Id hoặc label của block.' },
        botId: { type: 'string', description: 'Bot cần detach (mặc định: bot đang gọi).' },
      },
      ['idOrLabel'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const idOrLabel = getStringArg(args, 'idOrLabel');
        const botId = getOptionalStringArg(args, 'botId') ?? ctx.botId;
        const block = s.detach(botId, idOrLabel, actorOf(ctx));
        return JSON.stringify({ detached: true, botId, block: publicBlock(block, ctx.botId) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const memoryBlockShare: Tool = {
    definition: toolDef(
      'memory_block_share',
      'Share a memory block with another bot (attach it there — edits in one place are seen everywhere the block is attached) or with ALL bots at once (pass all=true). Always asks the user to approve first (approval card).',
      {
        idOrLabel: { type: 'string', description: 'Id hoặc label của block cần share.' },
        botId: { type: 'string', description: 'Bot nhận share (bỏ qua khi all=true).' },
        all: { type: 'boolean', description: 'true = share cho mọi bot trong danh sách botId (mặc định false).' },
        botIds: { type: 'array', items: { type: 'string' }, description: 'Danh sách botId nhận share khi all=true (bỏ qua khi all=false).' },
      },
      ['idOrLabel'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const idOrLabel = getStringArg(args, 'idOrLabel');
        const all = getBoolArg(args, 'all', false);
        if (all) {
          const botIdsRaw = args['botIds'];
          const botIds =
            Array.isArray(botIdsRaw) && botIdsRaw.every((v) => typeof v === 'string')
              ? (botIdsRaw as string[])
              : [ctx.botId];
          const newly = s.share(idOrLabel, botIds, actorOf(ctx));
          return JSON.stringify({ shared: true, all: true, newlyAttachedBots: newly }, null, 2);
        }
        const botId = getOptionalStringArg(args, 'botId');
        if (!botId) throw new Error('memory_block_share cần "botId" hoặc all=true.');
        const block = s.attach(botId, idOrLabel, actorOf(ctx));
        return JSON.stringify({ shared: true, botId, block: publicBlock(block, ctx.botId) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const memoryConsolidate: Tool = {
    definition: toolDef(
      'memory_consolidate',
      'Memory consolidation (sleep-time compute): merge duplicate long-term memories (keep the newest), resolve conflicts where the same key has different values (newest wins, the loser is archived with its source), and promote important facts (confidence >= 0.9 or tagged important) to the "human" memory block. Action "run" does one consolidation now; "status" shows the idle auto-run config (default OFF) and last run; "configure" turns idle auto-run on/off and sets the idle minutes. Always asks the user to approve first (approval card).',
      {
        action: { type: 'string', description: '"run" = chạy consolidation ngay; "status" = xem cấu hình + lần chạy gần nhất; "configure" = đổi cấu hình idle.' },
        enabled: { type: 'boolean', description: 'Bật/tắt consolidation tự động lúc idle (chỉ dùng với action "configure").' },
        idleMinutes: { type: 'number', description: 'Số phút bot idle thì tự chạy consolidation (chỉ dùng với action "configure", tối thiểu 1).' },
      },
      ['action'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const action = getStringArg(args, 'action');
        if (action === 'status') {
          const config = s.getConsolidationConfig();
          return JSON.stringify({ action: 'status', ...config }, null, 2);
        }
        if (action === 'configure') {
          const enabled = args['enabled'];
          const idleMinutes = getNumberArg(args, 'idleMinutes');
          if (enabled !== undefined && typeof enabled !== 'boolean') {
            throw new Error('Argument "enabled" must be a boolean.');
          }
          const config = s.setConsolidationConfig(
            {
              ...(enabled !== undefined ? { enabled: enabled as boolean } : {}),
              ...(idleMinutes !== undefined ? { idleMinutes } : {}),
            },
            actorOf(ctx),
          );
          return JSON.stringify({ action: 'configure', ...config }, null, 2);
        }
        if (action === 'run') {
          const report = consolidate(needLongTerm(), s, { actor: actorOf(ctx) });
          return JSON.stringify({ action: 'run', ...report }, null, 2);
        }
        throw new Error('memory_consolidate: action phải là "run", "status" hoặc "configure".');
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    memoryBlockCreate,
    memoryBlockList,
    memoryBlockGet,
    memoryBlockAppend,
    memoryBlockReplace,
    memoryBlockDelete,
    memoryBlockAttach,
    memoryBlockDetach,
    memoryBlockShare,
    memoryConsolidate,
  ];
}

/** Unbound placeholder (same shape as MEMORY_TOOLS in memoryTools.ts). */
export const MEMORY_BLOCK_TOOLS: Tool[] = createMemoryBlockTools();
