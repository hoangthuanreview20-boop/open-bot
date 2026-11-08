/**
 * Renderer-side view types for the open-bot desktop UI.
 *
 * These mirror the IPC payloads produced by src/main (main.ts / preload.ts)
 * — bots, chat history, tasks, settings and tool calls.
 *
 * They are deliberately self-contained (no import from @open-bot/core) so the
 * renderer typecheck does not depend on workspace package resolution.
 */

/** Bot as the renderer sees it (same shape as core BotConfig). */
export interface BotConfigLike {
  id: string;
  name: string;
  providerId: string;
  model: string;
  systemPrompt: string;
  workspaceDir: string;
  autoApprove: boolean;
}

/** One chat message as shown in the UI / returned by chat:history. */
export interface ChatMessageView {
  id: string;
  role: string;
  text: string;
  createdAt: number;
}

/**
 * One tool call as the renderer sees it. The main process sends the core
 * ToolCall ({ id, name, args }); the UI also tolerates the alternate
 * `tool` / `arguments` spellings when rendering.
 */
export interface ToolCallView {
  id?: string;
  name?: string;
  tool?: string;
  args?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Approval request sent by main when a tool call needs the user. */
export interface ApprovalRequest {
  botId: string;
  callId: string;
  call: ToolCallView;
}

/** One task/routine row as listed by tasks:list. */
export interface TaskView {
  id: string;
  botId?: string;
  title: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  detail?: string;
}

/** Settings as sent to the renderer (API keys never leave main). */
export interface SettingsView {
  providers: Record<string, { apiKeySet: boolean; baseUrl: string; defaultModel: string }>;
  bots: BotConfigLike[];
}
