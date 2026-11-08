/**
 * BotMemory — per-workspace SQLite storage (node:sqlite, built into Node 24).
 *
 * Database file: <workspaceDir>/.open-bot/memory.db
 * Tables:
 *   bots           — bot configs known to this workspace
 *   messages       — chat history per bot
 *   memory_entries — free-form key/value memory per bot (also backs routines)
 *   tasks          — simple task list per bot
 *
 * Synchronous API on purpose: node:sqlite's DatabaseSync is sync, and the
 * main process calls this from its own thread, so there is no need to fake
 * async here.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BotConfig, ChatMessage, Role } from '../types';

export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'cancelled';

export interface TaskItem {
  id: string;
  botId: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface BotRow {
  id: string;
  name: string;
  providerId: string;
  model: string;
  systemPrompt: string;
  createdAt: string;
}

export class BotMemory {
  private readonly db: DatabaseSync;

  constructor(workspaceDir: string) {
    const dir = join(workspaceDir, '.open-bot');
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, 'memory.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        providerId TEXT NOT NULL,
        model TEXT NOT NULL,
        systemPrompt TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        botId TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        botId TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(botId, key)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        botId TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Insert or replace a bot config. Returns the bot id. */
  saveBot(bot: Pick<BotConfig, 'id' | 'name' | 'providerId' | 'model' | 'systemPrompt'>): string {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO bots (id, name, providerId, model, systemPrompt, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           providerId = excluded.providerId,
           model = excluded.model,
           systemPrompt = excluded.systemPrompt`,
      )
      .run(bot.id, bot.name, bot.providerId, bot.model, bot.systemPrompt, now);
    return bot.id;
  }

  getBot(id: string): BotRow | null {
    const row = this.db
      .prepare('SELECT id, name, providerId, model, systemPrompt, createdAt FROM bots WHERE id = ?')
      .get(id) as BotRow | undefined;
    return row ?? null;
  }

  /** Append one chat message. Returns the message id. */
  saveMessage(botId: string, role: Role, content: string): string {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO messages (id, botId, role, content, createdAt) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, botId, role, content, new Date().toISOString());
    return id;
  }

  /** Most recent `limit` messages, oldest first. Default 50. */
  getHistory(botId: string, limit = 50): ChatMessage[] {
    const rows = this.db
      .prepare(
        `SELECT role, content FROM messages
         WHERE botId = ?
         ORDER BY createdAt DESC, rowid DESC
         LIMIT ?`,
      )
      .all(botId, limit) as Array<{ role: Role; content: string }>;
    return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
  }

  setMemory(botId: string, key: string, value: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO memory_entries (id, botId, key, value, updatedAt)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(botId, key) DO UPDATE SET
           value = excluded.value,
           updatedAt = excluded.updatedAt`,
      )
      .run(randomUUID(), botId, key, value, now);
  }

  /** Returns null when the key was never set. */
  getMemory(botId: string, key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM memory_entries WHERE botId = ? AND key = ?')
      .get(botId, key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  /** Create a task in status 'pending'. Returns the task id. */
  createTask(botId: string, title: string): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO tasks (id, botId, title, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, botId, title, 'pending', now, now);
    return id;
  }

  updateTask(id: string, status: TaskStatus): void {
    this.db
      .prepare('UPDATE tasks SET status = ?, updatedAt = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id);
  }

  /** Newest first. */
  listTasks(botId: string): TaskItem[] {
    return this.db
      .prepare(
        `SELECT id, botId, title, status, createdAt, updatedAt FROM tasks
         WHERE botId = ? ORDER BY createdAt DESC, rowid DESC`,
      )
      .all(botId) as unknown as TaskItem[];
  }
}
