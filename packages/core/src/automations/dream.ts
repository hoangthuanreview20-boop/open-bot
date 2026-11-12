/**
 * Dream (v0.4) — background work while the user is idle.
 *
 * "Dream" is one background pass, not a conversation: when nobody has
 * chatted for N minutes (default 15, configurable) and dream is enabled,
 * the engine asks the agent — with the CHEAPEST configured model, so a
 * background pass never burns the expensive default — to review recent
 * activity and prepare something useful: a summary of what happened, a
 * suggestion of what needs doing next, and a draft the user can pick up.
 *
 * Hard guarantees:
 * - NEVER interrupts an active chat. `checkAndRun()` returns
 *   `{ ran: false, reason: 'chat-active' }` while `isChatActive()` is
 *   true, and the host must also call `noteActivity()` on every user
 *   message so the idle clock restarts.
 * - NEVER runs twice at once: an in-flight dream blocks the next check.
 * - The result is stored as a task + a notification, never injected
 *   into a live chat. The user reads it when they come back.
 * - Dream reuses the automation engine: the pass itself is just a
 *   `run-agent` action executed through the same `AutomationHandlers`,
 *   so approval/sandbox rules still apply.
 *
 * Idle tracking: the host calls `noteActivity(botId)` whenever the user
 * sends a message (or any agent run finishes for that bot). The timestamp
 * is kept in memory and, when a `BotMemory` is supplied, persisted in
 * `memory_entries` under `dream:last-activity` so the idle clock survives
 * an app restart. Without a BotMemory the clock is in-memory only.
 */

import type { AutomationHandlers } from './types';
import type { BotMemory } from '../agent/memory';

export interface DreamConfig {
  enabled: boolean;
  /** Minutes of no chat before a dream pass may run. Default 15. */
  idleMinutes?: number;
  /** Model id for the background pass. Defaults to handlers.cheapestModel. */
  cheapestModel?: string;
  /** Max chat messages fed to the review prompt. Default 20. */
  historyLimit?: number;
}

export type DreamSkipReason = 'disabled' | 'chat-active' | 'not-idle' | 'already-running';

export interface DreamResult {
  ran: boolean;
  reason?: DreamSkipReason;
  /** The agent's review text (when ran). */
  summary?: string;
  /** Id of the task created from the review (when ran and task creation worked). */
  taskId?: string;
}

export interface DreamEngineOptions {
  config: DreamConfig;
  handlers: AutomationHandlers;
  /** True while the user has a chat running. */
  isChatActive: () => boolean;
  /** BotMemory for persisting the last-activity timestamp (optional). */
  memory?: BotMemory;
  /** Clock override (tests). Defaults to `() => new Date()`. */
  now?: () => Date;
}

const LAST_ACTIVITY_KEY = 'dream:last-activity';
export const DEFAULT_DREAM_IDLE_MINUTES = 15;
export const DEFAULT_DREAM_HISTORY_LIMIT = 20;

/**
 * Build the review prompt from recent chat history.
 * Pure function, exported for tests and for hosts that want to preview
 * the prompt before running it.
 */
export function buildDreamPrompt(
  history: Array<{ role: string; content: string }>,
  idleMinutes: number,
): string {
  const lines = history
    .slice(-DEFAULT_DREAM_HISTORY_LIMIT)
    .map((m) => `- [${m.role}] ${m.content.slice(0, 500)}`)
    .join('\n');
  return (
    `Đây là lượt "dream" — rà soát nền khi người dùng đang rảnh (không chat ${idleMinutes} phút).\n` +
    `Hoạt động gần đây:\n${lines || '(không có hoạt động gần đây)'}\n\n` +
    `Hãy làm 3 việc, ngắn gọn bằng tiếng Việt:\n` +
    `1. Tóm tắt những gì đã xảy ra gần đây (tối đa 5 dòng).\n` +
    `2. Đề xuất 1–3 việc cụ thể nên làm tiếp, xếp theo mức quan trọng.\n` +
    `3. Chuẩn bị sẵn bản nháp cho việc quan trọng nhất (nội dung dùng được ngay, không chỉ gợi ý).\n\n` +
    `Không hỏi thêm câu hỏi — người dùng đang rảnh, họ sẽ đọc kết quả khi quay lại. ` +
    `Không thực hiện hành động ghi file hay chạy lệnh, chỉ chuẩn bị nội dung.`
  );
}

export class DreamEngine {
  private readonly config: DreamConfig;
  private readonly handlers: AutomationHandlers;
  private readonly isChatActive: () => boolean;
  private readonly memory?: BotMemory;
  private readonly now: () => Date;
  private readonly lastActivity = new Map<string, number>();
  private running = false;

  constructor(opts: DreamEngineOptions) {
    this.config = opts.config;
    this.handlers = opts.handlers;
    this.isChatActive = opts.isChatActive;
    this.memory = opts.memory;
    this.now = opts.now ?? (() => new Date());
  }

  idleMinutes(): number {
    return this.config.idleMinutes ?? DEFAULT_DREAM_IDLE_MINUTES;
  }

  /** Record user/agent activity for a bot (resets its idle clock). */
  noteActivity(botId: string, at: Date = this.now()): void {
    this.lastActivity.set(botId, at.getTime());
    try {
      this.memory?.setMemory(botId, LAST_ACTIVITY_KEY, at.toISOString());
    } catch {
      // Persistence is best-effort; the in-memory clock still works.
    }
  }

  /** Last activity timestamp for a bot, or null when never seen. */
  lastActivityAt(botId: string): Date | null {
    const inMemory = this.lastActivity.get(botId);
    if (inMemory !== undefined) return new Date(inMemory);
    try {
      const stored = this.memory?.getMemory(botId, LAST_ACTIVITY_KEY);
      if (stored) return new Date(stored);
    } catch {
      // Fall through to null.
    }
    return null;
  }

  /** Minutes since the bot's last activity (Infinity when never active). */
  idleForMinutes(botId: string, now: Date = this.now()): number {
    const last = this.lastActivityAt(botId);
    if (!last) return Number.POSITIVE_INFINITY;
    return (now.getTime() - last.getTime()) / 60_000;
  }

  /**
   * Run one dream pass for `botId` when allowed.
   * `getHistory` supplies recent chat (the host reads it from BotMemory;
   * the engine does not open memory itself, so it stays usable in the
   * coordinator process too).
   */
  async checkAndRun(
    botId: string,
    getHistory: (botId: string, limit: number) => Array<{ role: string; content: string }>,
  ): Promise<DreamResult> {
    if (!this.config.enabled) return { ran: false, reason: 'disabled' };
    if (this.running) return { ran: false, reason: 'already-running' };
    if (this.isChatActive()) return { ran: false, reason: 'chat-active' };
    if (this.idleForMinutes(botId) < this.idleMinutes()) {
      return { ran: false, reason: 'not-idle' };
    }
    this.running = true;
    try {
      const history = getHistory(botId, this.config.historyLimit ?? DEFAULT_DREAM_HISTORY_LIMIT);
      const prompt = buildDreamPrompt(history, this.idleMinutes());
      const model = this.config.cheapestModel ?? this.handlers.cheapestModel;
      const summary = await this.handlers.runAgent(botId, prompt, { model });
      let taskId: string | undefined;
      try {
        const firstLine = summary.split('\n').find((l) => l.trim().length > 0) ?? 'Dream review';
        taskId = await this.handlers.createTask(botId, `Dream: ${firstLine.slice(0, 120)}`);
      } catch {
        // The review itself is the deliverable; a failed task write
        // must not lose it — it is still returned + notified below.
        taskId = undefined;
      }
      this.handlers.notify(
        `Dream đã rà soát xong cho bot ${botId} — xem task mới để đọc tóm tắt và bản nháp.`,
      );
      // A dream pass counts as activity: the next pass waits a full
      // idle window again instead of firing on the next tick.
      this.noteActivity(botId);
      return { ran: true, summary, taskId };
    } finally {
      this.running = false;
    }
  }
}
