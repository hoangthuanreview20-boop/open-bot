/**
 * Open Bot — Electron MAIN process.
 *
 * Chạy ở Node, là nơi DUY NHẤT giữ API key và AgentRunner.
 * Renderer chỉ giao tiếp qua IPC + contextBridge (xem preload.ts) và
 * KHÔNG BAO GIỜ nhận được API key hay AgentRunner.
 *
 * API key chỉ lưu ở file settings.json local (app.getPath('userData')),
 * không log ra console, không gửi đi đâu ngoài provider người dùng chọn.
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AgentRunner,
  BotConfig,
  BotMemory,
  createProvider,
  PROVIDERS,
} from '@open-bot/core';
import type { Provider, ProviderConfig, ToolCall, ToolResult } from '@open-bot/core';
import { createDefaultTools } from '@open-bot/tools';

// ---------------------------------------------------------------------------
// Kiểu dữ liệu
// ---------------------------------------------------------------------------

export interface ProviderSettings {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
}

export interface AppSettings {
  providers: Record<string, ProviderSettings>;
  bots: BotConfig[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: number;
}

export interface TaskItem {
  id: string;
  botId: string;
  title: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  detail?: string;
}

interface BotRuntime {
  bot: BotConfig;
  memory: BotMemory;
  runner: AgentRunner;
  /** Lịch sử chat giữ ở main (dự phòng khi BotMemory chưa có bản ghi). */
  history: ChatMessage[];
  tasks: TaskItem[];
}

// ---------------------------------------------------------------------------
// Settings (chỉ main process đọc/ghi file này)
// ---------------------------------------------------------------------------

const SETTINGS_FILE = 'settings.json';
let settingsPath = '';
let settings: AppSettings = { providers: {}, bots: [] };
let mainWindow: BrowserWindow | null = null;

function defaultProviderSettings(): Record<string, ProviderSettings> {
  const out: Record<string, ProviderSettings> = {};
  for (const p of PROVIDERS as Array<{
    id: string;
    defaultModel: string;
    defaultBaseUrl?: string;
  }>) {
    out[p.id] = { apiKey: '', baseUrl: p.defaultBaseUrl ?? '', defaultModel: p.defaultModel };
  }
  return out;
}

function loadSettings(): AppSettings {
  settingsPath = path.join(app.getPath('userData'), SETTINGS_FILE);
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      providers: { ...defaultProviderSettings(), ...(parsed.providers ?? {}) },
      bots: parsed.bots ?? [],
    };
  } catch {
    return { providers: defaultProviderSettings(), bots: [] };
  }
}

function saveSettings(): void {
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    // Chỉ log message, KHÔNG log nội dung settings (chứa API key).
    console.error('[open-bot] Không lưu được settings:', (err as Error).message);
  }
}

/** Bản settings gửi về renderer: API key KHÔNG bao giờ rời main process. */
function settingsForRenderer(): {
  providers: Record<string, { apiKeySet: boolean; baseUrl: string; defaultModel: string }>;
  bots: BotConfig[];
} {
  const providers: Record<string, { apiKeySet: boolean; baseUrl: string; defaultModel: string }> = {};
  for (const [id, p] of Object.entries(settings.providers)) {
    providers[id] = { apiKeySet: Boolean(p.apiKey), baseUrl: p.baseUrl, defaultModel: p.defaultModel };
  }
  return { providers, bots: settings.bots };
}

function ensureDefaultBot(): void {
  if (settings.bots.length > 0) return;
  const bot: BotConfig = {
    id: randomUUID(),
    name: 'Trợ lý',
    providerId: 'xai',
    model: 'grok-4.7',
    systemPrompt:
      'Bạn là Trợ lý — một agent AI chạy hoàn toàn trên máy của người dùng. Trả lời bằng tiếng Việt, ngắn gọn, rõ ràng, và chỉ dùng các công cụ được cấp khi thật sự cần.',
    workspaceDir: '',
    autoApprove: false,
  };
  settings.bots.push(bot);
  saveSettings();
}

// ---------------------------------------------------------------------------
// Bot runtime: một AgentRunner + một BotMemory cho mỗi bot
// ---------------------------------------------------------------------------

const runtimes = new Map<string, BotRuntime>();
const pendingApprovals = new Map<string, (approved: boolean) => void>();

/** Build the core ProviderConfig for a bot/provider from stored settings. */
function providerConfigFor(providerId: string, modelOverride?: string): ProviderConfig {
  const saved = settings.providers[providerId];
  const meta = PROVIDERS.find((m) => m.id === providerId);
  return {
    id: providerId,
    label: meta?.label ?? providerId,
    apiKey: saved?.apiKey || undefined,
    baseUrl: saved?.baseUrl || undefined,
    defaultModel: modelOverride || saved?.defaultModel || meta?.defaultModel || '',
  };
}

function workspaceDirFor(bot: BotConfig): string {
  const dir =
    bot.workspaceDir && bot.workspaceDir.trim().length > 0
      ? bot.workspaceDir
      : path.join(app.getPath('userData'), 'workspaces', bot.id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function getOrCreateRuntime(bot: BotConfig): BotRuntime {
  const existing = runtimes.get(bot.id);
  if (existing) return existing;

  const workspaceDir = workspaceDirFor(bot);
  const provider: Provider = createProvider(providerConfigFor(bot.providerId, bot.model));

  const memory = new BotMemory(workspaceDir);
  memory.saveBot(bot);
  const tools = createDefaultTools();
  const botId = bot.id;

  const runner = new AgentRunner(provider, tools, {
    bot,
    maxSteps: 20,
    events: {
      onText: (delta: string) => {
        sendToRenderer('chat:delta', { botId, delta });
      },
      onToolCall: (call: ToolCall) => {
        sendToRenderer('chat:toolcall', { botId, call });
      },
      // Core AgentEvents.onToolResult takes a single ToolResult argument.
      onToolResult: (result: ToolResult) => {
        sendToRenderer('chat:toolresult', { botId, result });
      },
      onApprovalNeeded: async (call: ToolCall): Promise<boolean> => {
        if (bot.autoApprove) return true;
        const callId = randomUUID();
        sendToRenderer('chat:approval-needed', { botId, callId, call });
        return new Promise<boolean>((resolve) => {
          pendingApprovals.set(callId, resolve);
          // Hết 10 phút không trả lời thì mặc định từ chối (an toàn).
          setTimeout(() => {
            if (pendingApprovals.has(callId)) {
              pendingApprovals.delete(callId);
              resolve(false);
            }
          }, 10 * 60 * 1000).unref();
        });
      },
    },
  });

  const runtime: BotRuntime = { bot, memory, runner, history: [], tasks: [] };
  runtimes.set(bot.id, runtime);
  return runtime;
}

function invalidateRuntime(botId: string): void {
  const runtime = runtimes.get(botId);
  if (runtime) {
    try {
      runtime.memory.close();
    } catch {
      // Already closed — nothing to do.
    }
  }
  runtimes.delete(botId);
}

/**
 * Persist one chat message with the real BotMemory API
 * (saveMessage(botId, role, content)); history stays in BotMemory, and
 * `runtime.history` is only a fallback for messages written before this.
 */
function syncMessageToMemory(runtime: BotRuntime, msg: ChatMessage): void {
  try {
    runtime.memory.saveMessage(runtime.bot.id, msg.role, msg.text);
  } catch (err) {
    console.error('[open-bot] Không lưu được tin nhắn:', (err as Error).message);
  }
}

function historyFromMemory(runtime: BotRuntime, limit: number): ChatMessage[] {
  try {
    const rows = runtime.memory.getHistory(runtime.bot.id, limit);
    if (rows.length > 0) {
      // Core history is {role, content}; map it to the main-process shape.
      // Tool-role rows are part of the agent transcript, not chat display.
      return rows
        .filter((r) => r.role === 'user' || r.role === 'assistant' || r.role === 'system')
        .map((r) => ({
          id: randomUUID(),
          role: r.role as 'user' | 'assistant' | 'system',
          text: r.content,
          createdAt: Date.now(),
        }));
    }
  } catch {
    // Fall through to the in-memory history below.
  }
  return runtime.history.slice(-limit);
}


// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle('bots:list', () => settings.bots);

  ipcMain.handle('bots:create', (_event: unknown, config: Partial<BotConfig>) => {
    const bot: BotConfig = {
      id: randomUUID(),
      name: config.name?.trim() || 'Bot mới',
      providerId: config.providerId ?? 'xai',
      model: config.model ?? settings.providers[config.providerId ?? 'xai']?.defaultModel ?? '',
      systemPrompt: config.systemPrompt ?? '',
      workspaceDir: config.workspaceDir ?? '',
      autoApprove: config.autoApprove ?? false,
    };
    settings.bots.push(bot);
    saveSettings();
    return bot;
  });

  ipcMain.handle('bots:update', (_event: unknown, config: BotConfig) => {
    const idx = settings.bots.findIndex((b) => b.id === config.id);
    if (idx === -1) throw new Error('Không tìm thấy bot.');
    settings.bots[idx] = { ...settings.bots[idx], ...config, id: config.id };
    saveSettings();
    invalidateRuntime(config.id);
    return settings.bots[idx];
  });

  ipcMain.handle('bots:delete', (_event: unknown, botId: string) => {
    settings.bots = settings.bots.filter((b) => b.id !== botId);
    invalidateRuntime(botId);
    saveSettings();
    return true;
  });

  ipcMain.handle('chat:send', async (_event: unknown, payload: { botId: string; text: string }) => {
    const bot = settings.bots.find((b) => b.id === payload.botId);
    if (!bot) throw new Error('Không tìm thấy bot.');
    const text = payload.text?.trim();
    if (!text) throw new Error('Tin nhắn trống.');
    const runtime = getOrCreateRuntime(bot);

    const userMsg: ChatMessage = { id: randomUUID(), role: 'user', text, createdAt: Date.now() };
    runtime.history.push(userMsg);
    syncMessageToMemory(runtime, userMsg);

    try {
      const result = (await runtime.runner.run(text)) as unknown;
      const replyText =
        typeof result === 'string'
          ? result
          : (result as { text?: string } | null)?.text ?? '';
      const assistantMsg: ChatMessage = {
        id: randomUUID(),
        role: 'assistant',
        text: replyText,
        createdAt: Date.now(),
      };
      // Nếu runner đã stream qua onText thì renderer đã có nội dung;
      // vẫn lưu bản đầy đủ vào lịch sử ở main.
      if (replyText) {
        runtime.history.push(assistantMsg);
        syncMessageToMemory(runtime, assistantMsg);
      }
      return { ok: true, text: replyText };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Lỗi không xác định.';
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('chat:history', (_event: unknown, payload: { botId: string; limit?: number }) => {
    const bot = settings.bots.find((b) => b.id === payload.botId);
    if (!bot) return [];
    const runtime = getOrCreateRuntime(bot);
    return historyFromMemory(runtime, payload.limit ?? 50);
  });

  ipcMain.handle('settings:get', () => settingsForRenderer());

  ipcMain.handle(
    'settings:set',
    (
      _event: unknown,
      patch: {
        providers?: Record<string, { apiKey?: string; baseUrl?: string; defaultModel?: string }>;
      },
    ) => {
      for (const [id, p] of Object.entries(patch.providers ?? {})) {
        const prev = settings.providers[id] ?? { apiKey: '', baseUrl: '', defaultModel: '' };
        settings.providers[id] = {
          // apiKey rỗng = giữ key cũ (renderer không bao giờ gửi key thật về).
          apiKey: p.apiKey && p.apiKey.length > 0 ? p.apiKey : prev.apiKey,
          baseUrl: p.baseUrl ?? prev.baseUrl,
          defaultModel: p.defaultModel ?? prev.defaultModel,
        };
        // Provider đổi cấu hình -> runtime cũ dùng key/model cũ phải bỏ.
        for (const bot of settings.bots.filter((b) => b.providerId === id)) {
          invalidateRuntime(bot.id);
        }
      }
      saveSettings();
      return settingsForRenderer();
    },
  );

  ipcMain.handle('settings:test', async (_event: unknown, payload: { providerId: string }) => {
    const saved = settings.providers[payload.providerId];
    if (!saved?.apiKey && payload.providerId !== 'ollama') {
      return { ok: false, error: 'Chưa nhập API key cho provider này.' };
    }
    try {
      // listModels() is part of the core Provider interface — no cast needed.
      const provider = createProvider(providerConfigFor(payload.providerId));
      const models = await provider.listModels();
      return { ok: true, models };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Kết nối thất bại.' };
    }
  });

  ipcMain.handle('tasks:list', (_event: unknown, payload: { botId: string }) => {
    const bot = settings.bots.find((b) => b.id === payload.botId);
    if (!bot) return [];
    const runtime = getOrCreateRuntime(bot);
    try {
      // Core statuses: pending | in_progress | done | cancelled.
      // UI statuses:   pending | running    | done | failed.
      return runtime.memory.listTasks(bot.id).map((task) => ({
        id: task.id,
        botId: task.botId,
        title: task.title,
        status:
          task.status === 'in_progress'
            ? ('running' as const)
            : task.status === 'cancelled'
              ? ('failed' as const)
              : task.status,
      }));
    } catch {
      return runtime.tasks;
    }
  });

  // Renderer trả lời phê duyệt tool call (ipcRenderer.send, không phải invoke).
  ipcMain.on('chat:approval-response', (_event: unknown, payload: { callId: string; approved: boolean }) => {
    const resolve = pendingApprovals.get(payload.callId);
    if (resolve) {
      pendingApprovals.delete(payload.callId);
      resolve(Boolean(payload.approved));
    }
  });
}

// ---------------------------------------------------------------------------
// Cửa sổ + vòng đời app
// ---------------------------------------------------------------------------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.env.OPEN_BOT_DEV === '1') {
    void mainWindow.loadURL('http://localhost:5173');
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

void app.whenReady().then(() => {
  settings = loadSettings();
  ensureDefaultBot();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  saveSettings();
});
