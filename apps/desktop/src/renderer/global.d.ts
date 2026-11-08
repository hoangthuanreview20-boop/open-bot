/**
 * Renderer-side declaration for `window.openBot`.
 *
 * The real implementation lives in src/main/preload.ts (exposed through
 * contextBridge). This declaration mirrors that API in renderer-side types
 * (see ./types.ts) so the UI typechecks without importing main-process code.
 */
import type {
  ApprovalRequest,
  BotConfigLike,
  ChatMessageView,
  SettingsView,
  TaskView,
  ToolCallView,
} from './types';

export interface OpenBotApi {
  listBots(): Promise<BotConfigLike[]>;
  createBot(config: Partial<BotConfigLike>): Promise<BotConfigLike>;
  updateBot(config: BotConfigLike): Promise<BotConfigLike>;
  deleteBot(botId: string): Promise<boolean>;
  sendChat(botId: string, text: string): Promise<{ ok: boolean; text?: string; error?: string }>;
  onChatDelta(cb: (payload: { botId: string; delta: string }) => void): () => void;
  onToolCall(cb: (payload: { botId: string; call: ToolCallView }) => void): () => void;
  onToolResult(
    cb: (payload: { botId: string; result: { callId: string; ok: boolean; output: string } }) => void,
  ): () => void;
  onApprovalNeeded(cb: (payload: ApprovalRequest) => void): () => void;
  respondApproval(callId: string, approved: boolean): void;
  getHistory(botId: string, limit?: number): Promise<ChatMessageView[]>;
  getSettings(): Promise<SettingsView>;
  setSettings(patch: {
    providers?: Record<string, { apiKey?: string; baseUrl?: string; defaultModel?: string }>;
  }): Promise<SettingsView>;
  testConnection(providerId: string): Promise<{ ok: boolean; error?: string; models?: unknown }>;
  listTasks(botId: string): Promise<TaskView[]>;
}

declare global {
  interface Window {
    openBot: OpenBotApi;
  }
}

export {};
