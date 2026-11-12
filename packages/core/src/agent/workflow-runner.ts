/**
 * @open-bot/core — runner thật cho workflow graph (v0.12, nối tích hợp).
 *
 * Nối `WorkflowNodeRunner` (xem `agent/workflow.ts`) vào `AgentRunner` +
 * tool registry:
 *  - node `agent` → chạy một AgentRunner con với prompt đã render (system
 *    prompt = system prompt của bot + ghi chú node workflow).
 *  - node `tool` → tra tool trong registry của bot rồi chạy `execute`.
 *  - node `branch`/`parallel`/`end` không tới được runner thật (executor
 *    xử lý nội bộ); nếu tới thì trả lỗi rõ.
 *
 * Runner này KHÔNG tự ý đổi graph — chỉ trả output (và có thể gợi ý
 * `next` khi node agent quyết định rẽ nhánh bằng text).
 */

import { AgentRunner } from './loop';
import type { BotConfig, Provider, Tool } from '../types';
import type { AgentEvents } from '../types';
import type { WorkflowNodeRunner } from './workflow';

export interface WorkflowRunnerOptions {
  provider: Provider;
  /** Toàn bộ tool của bot (dùng cho node `tool`). */
  tools: Tool[];
  bot: BotConfig;
  events: AgentEvents;
  /** Số bước tối đa cho mỗi node agent. Mặc định 25. */
  maxSteps?: number;
  signal?: AbortSignal;
}

/**
 * Tạo runner thật cho `runWorkflow`. Mỗi node agent chạy trong một
 * AgentRunner con riêng (cùng provider, toàn bộ tool của bot) để nó có
 * thể tự dùng tool khi làm việc; output là text cuối của node đó.
 */
export function createWorkflowRunner(opts: WorkflowRunnerOptions): WorkflowNodeRunner {
  const toolsByName = new Map(opts.tools.map((t) => [t.definition.name, t]));
  return async (input) => {
    const node = input.node;
    if (node.kind === 'agent') {
      const prompt = typeof node.prompt === 'string' ? node.prompt : '';
      const child = new AgentRunner(opts.provider, opts.tools, {
        bot: {
          ...opts.bot,
          systemPrompt:
            `${opts.bot.systemPrompt}\n\n[Workflow node "${node.id}" — chỉ làm đúng nhiệm vụ dưới đây, trả kết quả ngắn gọn.]`,
        },
        events: opts.events,
        maxSteps: opts.maxSteps ?? 25,
        signal: input.signal ?? opts.signal,
      });
      const text = await child.run(prompt);
      return { output: text };
    }
    if (node.kind === 'tool') {
      const toolName = node.toolName ?? '';
      const tool = toolsByName.get(toolName);
      if (!tool) {
        throw new Error(`Workflow node "${node.id}": không rõ tool "${toolName}".`);
      }
      const output = await tool.execute(node.args ?? {}, {
        workspaceDir: opts.bot.workspaceDir,
        botId: opts.bot.id,
        signal: input.signal ?? opts.signal,
      });
      return { output };
    }
    throw new Error(
      `Workflow node "${node.id}": kind "${node.kind}" do executor xử lý nội bộ, runner thật không chạy trực tiếp.`,
    );
  };
}
