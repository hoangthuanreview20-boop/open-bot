/**
 * Open Bot — preload script.
 *
 * Chỉ expose đúng API `window.openBot` qua contextBridge.
 * KHÔNG expose ipcRenderer trực tiếp, KHÔNG expose API key hay Node API.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { BotConfig } from '@open-bot/core';

export interface OpenBotApi {
  listBots: () => Promise<BotConfig[]>;
  createBot: (config: Partial<BotConfig>) => Promise<BotConfig>;
  updateBot: (config: BotConfig) => Promise<BotConfig>;
  deleteBot: (botId: string) => Promise<boolean>;
  sendChat: (botId: string, text: string) => Promise<{ ok: boolean; text?: string; error?: string }>;
  onChatDelta: (cb: (payload: { botId: string; delta: string }) => void) => () => void;
  onToolCall: (cb: (payload: { botId: string; call: unknown }) => void) => () => void;
  // Core AgentEvents.onToolResult sends a single ToolResult { callId, ok, output }.
  onToolResult: (cb: (payload: { botId: string; result: { callId: string; ok: boolean; output: string } }) => void) => () => void;
  onApprovalNeeded: (
    cb: (payload: { botId: string; callId: string; call: unknown }) => void,
  ) => () => void;
  respondApproval: (callId: string, approved: boolean) => void;
  getHistory: (botId: string, limit?: number) => Promise<Array<{ id: string; role: string; text: string; createdAt: number }>>;
  getSettings: () => Promise<unknown>;
  setSettings: (patch: unknown) => Promise<unknown>;
  testConnection: (providerId: string) => Promise<{ ok: boolean; error?: string; models?: unknown }>;
  listTasks: (botId: string) => Promise<unknown[]>;
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener as never);
  return () => {
    ipcRenderer.removeListener(channel, listener as never);
  };
}

const openBot: OpenBotApi = {
  listBots: () => ipcRenderer.invoke('bots:list'),
  createBot: (config) => ipcRenderer.invoke('bots:create', config),
  updateBot: (config) => ipcRenderer.invoke('bots:update', config),
  deleteBot: (botId) => ipcRenderer.invoke('bots:delete', botId),
  sendChat: (botId, text) => ipcRenderer.invoke('chat:send', { botId, text }),
  onChatDelta: (cb) => subscribe('chat:delta', cb),
  onToolCall: (cb) => subscribe('chat:toolcall', cb),
  onToolResult: (cb) => subscribe('chat:toolresult', cb),
  onApprovalNeeded: (cb) => subscribe('chat:approval-needed', cb),
  respondApproval: (callId, approved) =>
    ipcRenderer.send('chat:approval-response', { callId, approved }),
  getHistory: (botId, limit) => ipcRenderer.invoke('chat:history', { botId, limit }),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  testConnection: (providerId) => ipcRenderer.invoke('settings:test', { providerId }),
  listTasks: (botId) => ipcRenderer.invoke('tasks:list', { botId }),
};

contextBridge.exposeInMainWorld('openBot', openBot);
