/**
 * Tool `create_handoff` cho @open-bot/tools (v0.37, P1-3 — handoff phiên
 * làm việc, kiểu Claude Code / Cursor).
 *
 * Agent đang chạy tự tóm tắt công việc + trạng thái hiện tại rồi lưu thành
 * record bền: bot khác (hoặc chính bot này ở phiên sau) nạp record qua
 * tham số run `handoffId` / RPC `acceptHandoff` và tiếp tục từ đúng chỗ
 * đó, không cần toàn bộ transcript.
 *
 * Khác tool `transfer_to_X` (handoff trực tiếp v0.12 — chuyển việc NGAY
 * trong run, bot đích chạy luôn rồi trả lời về): tool này chỉ LƯU bản bàn
 * giao; việc tiếp tục xảy ra ở một run khác, có thể nhiều giờ sau.
 *
 * Factory (theo mẫu `createAgentTools` — file này không sở hữu registry
 * bot, store hay provider; mọi thứ qua callback):
 *   createSessionHandoffTools(opts?) -> Tool[]   (bound, usable)
 *   SESSION_HANDOFF_TOOLS                        (unbound placeholder)
 *
 * Callbacks:
 *  - getTranscript?: () => [{role, content}] — lịch sử bot gọi tool
 *    (coordinator lấy từ BotMemory, tối đa 50 dòng gần nhất); không có
 *    thì record lưu không kèm transcript excerpt.
 *  - saveRecord: (record) => void — host lưu record (coordinator lưu
 *    vào SessionHandoffStore `<dataDir>/handoffs.json`); thiếu callback
 *    thì tool trả lỗi rõ thay vì crash.
 *  - secrets?: string[] — secret đã biết để khử khớp chính xác thêm
 *    (ngoài dạng `sk-…`/`Bearer …` mà record builder tự khử).
 *
 * Approval: `needsApproval: false` — tạo record chỉ ghi một file local
 * (nội dung đã khử secret trước khi lưu), không gọi mạng, không chạy
 * code, không tốn token bot khác; tương tự tool `reflect` (chỉ đọc/ghi
 * note local).
 */

import type { Tool } from '@open-bot/core';
import {
  createSessionHandoff,
  type SessionHandoffMessage,
  type SessionHandoffRecord,
} from '@open-bot/core';

export const SESSION_HANDOFF_TOOL_NAMES: readonly string[] = ['create_handoff'];

export interface SessionHandoffToolOptions {
  /** Id bot đang gọi tool (bot nguồn của record). */
  botId?: string;
  /** Tên hiển thị của bot nguồn. */
  botName?: string;
  /** Lịch sử gần nhất của bot gọi (để kèm transcript excerpt). */
  getTranscript?: () => Array<{ role: string; content: string }>;
  /** Host lưu record (bắt buộc để tool chạy thật). */
  saveRecord?: (record: SessionHandoffRecord) => void | Promise<void>;
  /** Secret đã biết (vd API key của bot) — khử khớp chính xác thêm. */
  secrets?: string[];
}

const HANDOFF_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

function asTranscript(raw: Array<{ role: string; content: string }>): SessionHandoffMessage[] {
  const out: SessionHandoffMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m.content !== 'string' || m.content.trim() === '') continue;
    out.push({
      role: HANDOFF_ROLES.has(m.role)
        ? (m.role as SessionHandoffMessage['role'])
        : 'user',
      content: m.content,
    });
  }
  return out;
}

export function createSessionHandoffTools(opts: SessionHandoffToolOptions = {}): Tool[] {
  const fromBotId = (opts.botId ?? '').trim();
  const fromBotName = (opts.botName ?? '').trim();
  const saveRecord = opts.saveRecord;
  const getTranscript = opts.getTranscript;
  const secrets = Array.isArray(opts.secrets) ? opts.secrets : [];

  const createHandoffTool: Tool = {
    definition: {
      name: 'create_handoff',
      description:
        'Bàn giao công việc đang làm cho bot khác (hoặc cho phiên sau của chính mình): ' +
        'tóm tắt công việc, trạng thái hiện tại, việc đã xong / còn lại + bước tiếp theo, ' +
        'file đã đổi/liên quan, quyết định đã chốt và lỗi đang gặp — lưu thành record bền, ' +
        'bot nhận nạp record và tiếp tục mà không cần hỏi lại từ đầu. ' +
        'Dùng khi dừng việc giữa chừng, khi việc này thuộc chuyên môn bot khác, hoặc khi ' +
        'context sắp đầy. Chỉ LƯU bản bàn giao — bot đích KHÔNG chạy ngay; muốn chuyển ngay ' +
        'trong run này thì dùng transfer_to_<bot> thay vì tool này.',
      parameters: {
        type: 'object',
        properties: {
          toBot: {
            type: 'string',
            description:
              'Tên hoặc id bot nhận (tùy chọn — trống = bot nào cũng nhận được).',
          },
          title: {
            type: 'string',
            description: 'Tiêu đề ngắn của công việc đang bàn giao (vd "Thêm tool create_handoff").',
          },
          workStatus: {
            type: 'string',
            description: 'Trạng thái công việc lúc bàn giao.',
            enum: ['in-progress', 'blocked', 'waiting-input', 'done'],
          },
          taskSummary: {
            type: 'string',
            description: 'Công việc đang làm là gì.',
          },
          currentState: {
            type: 'string',
            description: 'Trạng thái hiện tại: đang ở đâu, vừa làm gì xong.',
          },
          completed: {
            type: 'array',
            items: { type: 'string' },
            description: 'Việc đã xong (mỗi mục một chuỗi ngắn).',
          },
          remaining: {
            type: 'array',
            items: { type: 'string' },
            description: 'Việc còn lại theo thứ tự làm (mục đầu nên là bước làm ngay tiếp theo).',
          },
          nextStep: {
            type: 'string',
            description: 'Bước làm ngay tiếp theo.',
          },
          filesChanged: {
            type: 'array',
            items: { type: 'string' },
            description: 'File đã đổi trong lúc làm.',
          },
          filesRelevant: {
            type: 'array',
            items: { type: 'string' },
            description: 'File liên quan cần đọc để tiếp tục.',
          },
          decisions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Quyết định quan trọng đã chốt (mỗi mục một chuỗi, có thể kèm lý do sau dấu ":").',
          },
          blockers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Lỗi/blocker đang gặp (mỗi mục một chuỗi).',
          },
          context: {
            type: 'string',
            description: 'Ngữ cảnh cần thiết khác — KHÔNG nhét secret/API key, KHÔNG paste toàn bộ transcript.',
          },
        },
        required: [],
      },
    },
    needsApproval: false,
    execute: async (args) => {
      if (!fromBotId || !fromBotName) {
        return 'Error: create_handoff chưa được cấu hình bot nguồn (thiếu botId/botName) — host cần truyền botId + botName cho factory.';
      }
      if (typeof saveRecord !== 'function') {
        return 'Error: create_handoff chưa được nối với nơi lưu record (thiếu saveRecord) — host cần truyền saveRecord cho factory.';
      }
      const toBot = asString(args['toBot']);
      let transcriptExcerpt: SessionHandoffMessage[] = [];
      try {
        transcriptExcerpt = getTranscript ? asTranscript(getTranscript()) : [];
      } catch {
        // Lịch sử đọc lỗi thì record vẫn lưu được (không kèm excerpt).
        transcriptExcerpt = [];
      }
      let record: SessionHandoffRecord;
      try {
        record = createSessionHandoff(
          {
            fromBotId,
            fromBotName,
            ...(toBot ? { toBotName: toBot } : {}),
            title: asString(args['title']),
            workStatus:
              args['workStatus'] === 'in-progress' ||
              args['workStatus'] === 'blocked' ||
              args['workStatus'] === 'waiting-input' ||
              args['workStatus'] === 'done'
                ? args['workStatus']
                : undefined,
            taskSummary: asString(args['taskSummary']),
            currentState: asString(args['currentState']),
            completed: asStringList(args['completed']),
            remaining: asStringList(args['remaining']),
            nextStep: asString(args['nextStep']),
            filesChanged: asStringList(args['filesChanged']),
            filesRelevant: asStringList(args['filesRelevant']),
            decisions: asStringList(args['decisions']),
            blockers: asStringList(args['blockers']),
            context: asString(args['context']),
            transcriptExcerpt,
          },
          { secrets },
        );
      } catch (err) {
        return `Error: không tạo được handoff — ${err instanceof Error ? err.message : String(err)}`;
      }
      try {
        await saveRecord(record);
      } catch (err) {
        return `Error: không lưu được handoff — ${err instanceof Error ? err.message : String(err)}`;
      }
      const lines = [
        `Đã lưu handoff "${record.title}" (id: ${record.id}).`,
        `Từ bot "${record.fromBotName}"` +
          (record.toBotName ? ` cho bot "${record.toBotName}"` : ' (chưa chọn bot đích — bot nào cũng nhận được)') +
          `. Trạng thái: ${record.workStatus}.`,
        `Đã xong ${record.completed.length} việc, còn lại ${record.remaining.length} việc. Bước tiếp theo: ${record.nextStep || '(xem danh sách còn lại)'}.`,
      ];
      if (record.truncated) {
        lines.push(
          `Lưu ý: một số nội dung đã bị cắt ngắn khi lưu (${record.truncatedFields.join(', ')}).`,
        );
      }
      if (record.redacted) {
        lines.push(`Lưu ý: record đã khử secret (hiển thị '<redacted>').`);
      }
      lines.push(
        `Bot nhận nạp record này bằng cách chạy run với handoffId "${record.id}" (hoặc RPC acceptHandoff) rồi tiếp tục từ bước tiếp theo — không cần hỏi lại những gì đã bàn giao.`,
      );
      return lines.join('\n');
    },
  };

  return [createHandoffTool];
}

/** Unbound placeholder (theo mẫu A2A_TOOLS): factory không có callback thì tool trả lỗi rõ. */
export const SESSION_HANDOFF_TOOLS: Tool[] = createSessionHandoffTools();
