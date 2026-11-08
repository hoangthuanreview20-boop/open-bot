/**
 * Shared contract for open-bot core.
 *
 * This file is THE contract: packages/tools, apps/desktop and any future
 * package import these types from @open-bot/core. Do not change a type
 * here without updating every consumer.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: Role;
  content: string;
  name?: string;
  toolCallId?: string;
  /**
   * Tool calls made by this assistant message. Stored so the next round
   * can send the assistant message back with its `tool_calls` attached —
   * OpenAI/Anthropic/Gemini all reject a bare tool result that is not
   * preceded by the assistant message carrying the matching call.
   */
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  ok: boolean;
  output: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolContext {
  workspaceDir: string;
  botId: string;
  signal?: AbortSignal;
}

export interface Tool {
  definition: ToolDefinition;
  needsApproval: boolean;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

export interface ProviderResponse {
  text: string;
  toolCalls: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ProviderConfig {
  id: string;
  label: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel: string;
}

export interface Provider {
  id: string;
  label: string;
  chat(req: ChatCompletionRequest): Promise<ProviderResponse>;
  listModels(): Promise<string[]>;
}

export interface BotConfig {
  id: string;
  name: string;
  providerId: string;
  model: string;
  systemPrompt: string;
  workspaceDir: string;
  autoApprove: boolean;
}

export interface AgentEvents {
  onText(delta: string): void;
  onToolCall(call: ToolCall): void;
  onToolResult(r: ToolResult): void;
  onApprovalNeeded(call: ToolCall): Promise<boolean>;
}
