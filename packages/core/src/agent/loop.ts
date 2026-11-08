/**
 * Agent loop: drives one user turn — send messages + tools to the provider,
 * execute any tool calls (asking approval first when required), feed the
 * results back, and repeat until the model answers with plain text or
 * `maxSteps` is reached.
 *
 * Text is delivered through `events.onText`. Providers in 0.1.0 are
 * non-streaming, so onText is called once per round with the full text of
 * that round; if a provider later streams, it can call onText per chunk.
 */

import type {
  AgentEvents,
  BotConfig,
  ChatMessage,
  Provider,
  Tool,
  ToolCall,
  ToolResult,
} from '../types';

export interface AgentRunnerOptions {
  bot: BotConfig;
  events: AgentEvents;
  /** Max provider round-trips per user turn. Default 25. */
  maxSteps?: number;
}

export class AgentRunner {
  private readonly provider: Provider;
  private readonly tools: Map<string, Tool>;
  private readonly bot: BotConfig;
  private readonly events: AgentEvents;
  private readonly maxSteps: number;

  constructor(provider: Provider, tools: Tool[], opts: AgentRunnerOptions) {
    this.provider = provider;
    this.tools = new Map(tools.map((t) => [t.definition.name, t]));
    this.bot = opts.bot;
    this.events = opts.events;
    this.maxSteps = opts.maxSteps ?? 25;
  }

  async run(userText: string): Promise<string> {
    const messages: ChatMessage[] = [
      { role: 'system', content: this.bot.systemPrompt },
      { role: 'user', content: userText },
    ];
    let lastText = '';

    for (let step = 0; step < this.maxSteps; step++) {
      const res = await this.provider.chat({
        model: this.bot.model,
        messages,
        tools: [...this.tools.values()].map((t) => t.definition),
      });

      if (res.text) {
        this.events.onText(res.text);
        lastText = res.text;
      }

      // No tool calls: the turn is done.
      if (res.toolCalls.length === 0) {
        if (res.text) {
          messages.push({ role: 'assistant', content: res.text });
        }
        return res.text;
      }

      // Keep the assistant message WITH its toolCalls so the next round
      // can pair each tool result with the call that produced it.
      messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });

      for (const call of res.toolCalls) {
        this.events.onToolCall(call);
        const result = await this.executeCall(call);
        // Approval denied stops the whole turn immediately.
        if (result === null) return 'đã hủy';
        this.events.onToolResult(result);
        messages.push({
          role: 'tool',
          content: result.output,
          toolCallId: result.callId,
        });
      }
    }

    return lastText || 'Đã đạt giới hạn số bước mà chưa có câu trả lời cuối.';
  }

  /**
   * Execute one tool call. Returns null when the user denied approval —
   * the caller treats that as "stop the turn".
   */
  private async executeCall(call: ToolCall): Promise<ToolResult | null> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return { callId: call.id, ok: false, output: `Không rõ công cụ: ${call.name}` };
    }
    if (tool.needsApproval && !this.bot.autoApprove) {
      const approved = await this.events.onApprovalNeeded(call);
      if (!approved) return null;
    }
    try {
      const output = await tool.execute(call.args, {
        workspaceDir: this.bot.workspaceDir,
        botId: this.bot.id,
      });
      return { callId: call.id, ok: true, output };
    } catch (err) {
      return {
        callId: call.id,
        ok: false,
        output: `Lỗi khi chạy ${call.name}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
