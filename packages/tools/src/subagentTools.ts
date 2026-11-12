/**
 * Subagent + user-messaging tools for @open-bot/tools (v0.2).
 *
 * How each tool reaches the outside world:
 *  - delegate_task / agent_status: through ToolContext (ctx.runSubagent /
 *    ctx.subagentStatus), wired by AgentRunner — the child runs in the
 *    SAME process with the same provider and tools, tracked in the
 *    runner's in-memory registry. There is no separate process (yet).
 *  - ask_user / send_message_to_user / send_progress_update /
 *    send_final_summary / stop_agent: when the tools run inside an
 *    AgentRunner, the loop answers them itself from AgentEvents / its
 *    registry (see loop.ts handleBuiltInCall). The factory callbacks below
 *    are the standalone wiring for hosts that call tool.execute directly.
 *    Without either wiring, execute() returns a clear error instead of
 *    crashing.
 *  - await_condition: polls inside this tool (file existence via
 *    resolveWithin, task status via opts.getTaskStatus), 500ms interval.
 *
 * Factory:
 *   createSubagentTools(opts?) -> Tool[]   (bound, usable)
 *   SUBAGENT_TOOLS                          (unbound placeholder)
 *
 * Approval: delegate_task and stop_agent change state -> needsApproval
 * true; the rest only read or send a message to the user -> false.
 */
import * as fs from 'node:fs';
import type { Tool, ToolContext } from '@open-bot/core';
import { BUILTIN_ROLES, describeRole } from '@open-bot/core';
import type { SubagentRole, SubagentRoleSummary } from '@open-bot/core';
import { resolveWithin } from './sandbox';

export interface SubagentToolOptions {
  /** Ask the user a question; resolves with their answer. */
  askUser?: (question: string, options?: string[]) => Promise<string>;
  /** Deliver a plain message to the user. */
  onUserMessage?: (message: string) => void;
  /** Deliver a progress update to the user. */
  onProgress?: (message: string) => void;
  /** Deliver the final summary to the user. */
  onFinalSummary?: (summary: string) => void;
  /** Stop a running subagent by id; returns true when it was running. */
  stopSubagent?: (id: string) => boolean;
  /** Snapshot of subagents: [{ id, status }]. */
  subagentStatus?: () => Array<{ id: string; status: string }>;
  /** Current status of a task, or null when unknown (for await_condition). */
  getTaskStatus?: (taskId: string) => string | null;
  /**
   * v0.37 (P1-4): role subagent cho tool `list_subagent_roles` (mặc
   * định = 5 role built-in). Host truyền thêm role custom ở đây để
   * tool liệt kê đúng tập role mà `runSubagent({ role })` chấp nhận.
   */
  roles?: SubagentRole[];
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

function getNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings`);
  }
  return value as string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export function createSubagentTools(opts: SubagentToolOptions = {}): Tool[] {
  // v0.37 (P1-4): tập role mà tool liệt kê — mặc định built-in, host có
  // thể truyền thêm role custom (phải khớp registry mà AgentRunner dùng).
  const roleSummaries: SubagentRoleSummary[] = (opts.roles ?? BUILTIN_ROLES).map(describeRole);

  const listSubagentRoles: Tool = {
    definition: toolDef(
      'list_subagent_roles',
      'Liệt kê các role subagent chuyên biệt có sẵn (researcher/coder/reviewer/planner/tester + role custom): mỗi role có mô tả, tool được phép, giới hạn (chỉ-đọc, có/không cho shell, maxSteps, timeout). Dùng để chọn đúng role khi gọi delegate_task với role.',
      {},
      [],
    ),
    needsApproval: false,
    async execute() {
      return JSON.stringify(roleSummaries, null, 2);
    },
  };

  const delegateTask: Tool = {
    definition: toolDef(
      'delegate_task',
      'Giao một việc cho agent con: chạy một AgentRunner con trong CÙNG process với cùng provider và cùng tool, chờ nó xong (có timeout) rồi trả về tóm tắt kết quả. Đặt role (vd researcher/coder/reviewer/planner/tester, xem list_subagent_roles) để con làm đúng chuyên môn với tool giới hạn riêng; role không tồn tại thì báo lỗi rõ, không chạy con chung chung.',
      {
        task: { type: 'string', description: 'Việc cần giao (mô tả rõ ràng cho agent con).' },
        role: {
          type: 'string',
          description:
            'Role subagent chuyên biệt (xem list_subagent_roles). Không đặt = subagent chung (cùng tool + system prompt của cha).',
        },
        timeoutMs: { type: 'number', description: 'Timeout tối đa, ms. Mặc định 120000 (role có thể đặt riêng).' },
        shadow_workspace: {
          type: 'boolean',
          description:
            'true = chạy agent con trong git worktree riêng (shadow workspace) để không đụng workspace chính; chỉ có tác dụng khi workspace là git repo.',
        },
      },
      ['task'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const task = getStringArg(args, 'task');
        if (!ctx.runSubagent) {
          return errorResult(
            'delegate_task chưa được hỗ trợ trong phiên này (ToolContext.runSubagent chưa được cấu hình).',
          );
        }
        const timeoutMs = getNumberArg(args, 'timeoutMs');
        const shadowWorkspace = args['shadow_workspace'] === true ? true : undefined;
        const role = getOptionalStringArg(args, 'role');
        if (
          timeoutMs === undefined &&
          shadowWorkspace === undefined &&
          role === undefined
        ) {
          return await ctx.runSubagent(task);
        }
        return await ctx.runSubagent(task, { timeoutMs, shadowWorkspace, role });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const agentStatus: Tool = {
    definition: toolDef(
      'agent_status',
      'Kiểm tra trạng thái các agent con đang/chưa chạy trong phiên này (in-memory registry của runner).',
      {},
      [],
    ),
    needsApproval: false,
    async execute(_args, ctx) {
      try {
        const list = ctx.subagentStatus
          ? ctx.subagentStatus()
          : opts.subagentStatus
            ? opts.subagentStatus()
            : [];
        if (list.length === 0) return 'Không có agent con nào.';
        return JSON.stringify(list, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const stopAgent: Tool = {
    definition: toolDef(
      'stop_agent',
      'Dừng một agent con đang chạy theo id (dùng AbortSignal). Agent đã kết thúc thì không dừng được nữa.',
      {
        agentId: { type: 'string', description: 'Id của agent con (xem agent_status).' },
      },
      ['agentId'],
    ),
    needsApproval: true,
    async execute(args, _ctx: ToolContext) {
      try {
        const id = getStringArg(args, 'agentId');
        if (!opts.stopSubagent) {
          return errorResult(
            `Không thể dừng agent "${id}" trong phiên này (chưa có registry để dừng — khi chạy trong AgentRunner, loop sẽ xử lý stop_agent).`,
          );
        }
        const stopped = opts.stopSubagent(id);
        return stopped
          ? `Đã dừng agent con "${id}".`
          : errorResult(`Không thấy agent con đang chạy với id "${id}".`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const askUser: Tool = {
    definition: toolDef(
      'ask_user',
      'Hỏi người dùng một câu hỏi và chờ họ trả lời (kèm danh sách options để chọn nếu có). Trả về câu trả lời của người dùng làm kết quả tool.',
      {
        question: { type: 'string', description: 'Câu hỏi cần hỏi người dùng.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Các lựa chọn gợi ý (không bắt buộc).',
        },
      },
      ['question'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const question = getStringArg(args, 'question');
        const options = getStringArrayArg(args, 'options');
        if (!opts.askUser) {
          return errorResult(
            'chưa hỗ trợ hỏi người dùng trong phiên này (events.onAskUser chưa được cấu hình).',
          );
        }
        return await opts.askUser(question, options);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sendMessageToUser: Tool = {
    definition: toolDef(
      'send_message_to_user',
      'Gửi một message cho người dùng (hiển thị qua events của phiên).',
      {
        message: { type: 'string', description: 'Nội dung message.' },
      },
      ['message'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const message = getStringArg(args, 'message');
        if (!opts.onUserMessage) {
          return errorResult(
            'chưa hỗ trợ gửi message trong phiên này (chưa có kênh gửi tới người dùng).',
          );
        }
        opts.onUserMessage(message);
        return 'Đã gửi message cho người dùng.';
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sendProgressUpdate: Tool = {
    definition: toolDef(
      'send_progress_update',
      'Gửi cập nhật tiến độ cho người dùng trong lúc đang làm việc.',
      {
        message: { type: 'string', description: 'Nội dung cập nhật tiến độ.' },
      },
      ['message'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const message = getStringArg(args, 'message');
        if (!opts.onProgress) {
          return errorResult(
            'chưa hỗ trợ gửi cập nhật tiến độ trong phiên này (events.onProgress chưa được cấu hình).',
          );
        }
        opts.onProgress(message);
        return 'Đã gửi cập nhật tiến độ.';
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const sendFinalSummary: Tool = {
    definition: toolDef(
      'send_final_summary',
      'Gửi tóm tắt cuối cho người dùng khi đã xong việc.',
      {
        summary: { type: 'string', description: 'Tóm tắt kết quả cuối cùng.' },
      },
      ['summary'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const summary = getStringArg(args, 'summary');
        if (!opts.onFinalSummary) {
          return errorResult(
            'chưa hỗ trợ gửi tóm tắt cuối trong phiên này (events.onFinalSummary chưa được cấu hình).',
          );
        }
        opts.onFinalSummary(summary);
        return 'Đã gửi tóm tắt cuối.';
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const awaitCondition: Tool = {
    definition: toolDef(
      'await_condition',
      'Chờ một điều kiện: file tồn tại (kind "file_exists", path trong workspace) hoặc task đạt trạng thái (kind "task_status", taskId + status). Poll mỗi 500ms, tối đa timeoutMs (mặc định 30000). Trả về true/false kèm lý do.',
      {
        kind: { type: 'string', description: '"file_exists" hoặc "task_status".' },
        path: { type: 'string', description: 'Đường dẫn file (cho kind file_exists), trong workspace.' },
        taskId: { type: 'string', description: 'Id task (cho kind task_status).' },
        status: { type: 'string', description: 'Trạng thái task cần chờ (cho kind task_status).' },
        timeoutMs: { type: 'number', description: 'Timeout tối đa, ms. Mặc định 30000.' },
      },
      ['kind'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const kind = getStringArg(args, 'kind');
        const timeoutMs = getNumberArg(args, 'timeoutMs') ?? 30_000;
        const deadline = Date.now() + Math.max(0, timeoutMs);
        const check = (): boolean => {
          if (kind === 'file_exists') {
            const relPath = getStringArg(args, 'path');
            // Mọi path đều qua resolveWithin: không ra ngoài workspace.
            const fullPath = resolveWithin(ctx.workspaceDir, relPath);
            return fs.existsSync(fullPath);
          }
          if (kind === 'task_status') {
            const taskId = getStringArg(args, 'taskId');
            const want = getStringArg(args, 'status');
            if (!opts.getTaskStatus) return false;
            return opts.getTaskStatus(taskId) === want;
          }
          throw new Error(`kind không hỗ trợ: "${kind}" (dùng "file_exists" hoặc "task_status")`);
        };
        for (;;) {
          if (ctx.signal?.aborted) return 'false: đã bị huỷ (abort).';
          let met: boolean;
          try {
            met = check();
          } catch (err) {
            return errorResult((err as Error).message);
          }
          if (met) return `true: điều kiện "${kind}" đã đạt.`;
          if (Date.now() >= deadline) {
            return `false: hết timeout ${timeoutMs}ms mà điều kiện "${kind}" chưa đạt.`;
          }
          await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
        }
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    delegateTask,
    listSubagentRoles,
    agentStatus,
    stopAgent,
    askUser,
    sendMessageToUser,
    sendProgressUpdate,
    sendFinalSummary,
    awaitCondition,
  ];
}

/**
 * Unbound placeholder: same tool shapes, but no event callbacks attached,
 * so the messaging tools return a clear "not supported" error and
 * delegate_task reports the missing runner wiring. Real usage:
 *   const tools = createSubagentTools({ askUser, onProgress, ... });
 * When run inside an AgentRunner, the loop answers ask_user / send_* /
 * stop_agent itself from AgentEvents, so the factory callbacks are optional.
 */
export const SUBAGENT_TOOLS: Tool[] = createSubagentTools();
