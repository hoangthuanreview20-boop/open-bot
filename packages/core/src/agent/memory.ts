/**
 * BotMemory — per-workspace SQLite storage (node:sqlite, built into Node 24).
 *
 * Database file: <workspaceDir>/.open-bot/memory.db
 * Tables:
 *   bots           — bot configs known to this workspace
 *   messages       — chat history per bot
 *   memory_entries — free-form key/value memory per bot (also backs routines)
 *   tasks          — simple task list per bot (column `tags` added by
 *                    migration in v0.2; old DBs gain it via ALTER TABLE)
 *   goals          — goals per bot (v0.2)
 *   todos          — todo list per bot (v0.2)
 *   projects       — projects per bot (v0.2; `updatesEnabled` flags whether
 *                    the bot should send periodic updates — flag only, no
 *                    delivery channel exists yet)
 *   run_checkpoints — per-step checkpoints of agent runs (v0.12): one row
 *                    per finished step, so a run can resume after a crash
 *                    or stop without re-running finished steps. Logic lives
 *                    in `agent/checkpoints.ts`; this file only creates the
 *                    table and offers raw row access.
 *   threads        — conversation threads per bot (v0.59 UI-5): one bot
 *                    has many threads, each thread owns its messages
 *                    (`messages.threadId`). Old rows keep threadId NULL
 *                    until `ensureDefaultThread` migrates them into the
 *                    bot's first thread (see below).
 *   message_attachments — image attachments per message (v0.65 vision
 *                    persistence): one row per image (name/mime/size/
 *                    file name) + the bytes as a file under
 *                    `.open-bot/attachments/<messageId>/<idx>.<ext>`.
 *                    The DB never holds image bytes.
 *
 * Synchronous API on purpose: node:sqlite's DatabaseSync is sync, and the
 * main process calls this from its own thread, so there is no need to fake
 * async here.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BotConfig, ChatMessage, Role, VisionAttachment } from '../types';
import {
  VISION_ALLOWED_MIME_TYPES,
  VISION_MAX_IMAGE_BYTES,
  validateVisionAttachments,
} from './vision';
import type { VisionValidationResult } from './vision';

export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'cancelled';

export interface TaskItem {
  id: string;
  botId: string;
  title: string;
  status: TaskStatus;
  /** Free-form comma-separated tags ('' when none). v0.2 migration. */
  tags: string;
  createdAt: string;
  updatedAt: string;
}

export type GoalStatus = 'active' | 'paused' | 'done' | 'cancelled';

export interface GoalItem {
  id: string;
  botId: string;
  title: string;
  detail: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TodoItem {
  id: string;
  botId: string;
  title: string;
  done: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ProjectStatus = 'active' | 'paused' | 'done' | 'cancelled';

export interface ProjectItem {
  id: string;
  botId: string;
  title: string;
  detail: string;
  status: ProjectStatus;
  /** Periodic-update flag (v0.94c: real delivery exists — see project/updates.ts). */
  updatesEnabled: boolean;
  /**
   * v0.94c: ISO timestamp of the last project-update digest actually
   * sent (null = never sent). Drives the 6-hour due check in
   * `listDueProjectUpdates` — without it the flag alone could never
   * tell whether a digest is due.
   */
  lastUpdateAt: string | null;
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

/**
 * Raw row of `run_checkpoints` (v0.12). JSON payloads are stored as text
 * and parsed by `agent/checkpoints.ts` — this file does not interpret them.
 */
export interface CheckpointRow {
  id: string;
  runId: string;
  botId: string;
  stepIndex: number;
  messagesJson: string;
  toolCallsJson: string;
  tokensUsed: number;
  createdAt: string;
}

/**
 * v0.59 (UI-5): one conversation thread of a bot. A bot has many
 * threads; each thread owns its messages. `titleCustom` = 1 when the
 * user renamed the thread by hand — auto-titling from the first user
 * message only runs while it is 0. `messageCount` is filled by
 * list/get (0 when the row was built by createThread).
 */
export interface ThreadItem {
  id: string;
  botId: string;
  title: string;
  titleCustom: boolean;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

/** v0.59 (UI-5): one thread hit from a title/content search. */
export interface ThreadSearchHit {
  thread: ThreadItem;
  /** First matching message (oldest first), or the title when only it matched. */
  snippet: string;
  /** Number of messages in the thread matching the query. */
  matchCount: number;
}

/** v0.59 (UI-5): title of a thread that has no user message yet. */
export const DEFAULT_THREAD_TITLE = 'Cuộc trò chuyện mới';

/**
 * v0.65 (vision persistence): image attachments are stored as FILES,
 * not base64 in SQLite — see `BotMemory` for the decision (option B).
 * One file per image: `<workspaceDir>/.open-bot/attachments/
 * <messageId>/<idx>.<ext>`, with a `message_attachments` row per image
 * (name/mime/size/file name) pointing at it. The DB never holds image
 * bytes, so it stays small and exports/backups stay text-only.
 */
export const ATTACHMENTS_DIR_NAME = 'attachments';

/** File extension for a stored image (mime allowlist = vision.ts). */
const ATTACHMENT_EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Fix v0.59 leftover (a): the default thread title follows the UI
 * locale instead of always being Vietnamese. Extended v0.74d to all
 * 6 UI locales (vi, en, zh, ja, es, fr — see `LOCALES` in
 * apps/desktop/src/renderer/i18n/index.ts): each value is the
 * locale's `thread.new` string from its renderer locale file, so the
 * title a new thread gets in the DB is the same string the UI shows
 * for "New conversation". Unknown codes, missing locale and '' fall
 * back to the Vietnamese default, matching the repo's i18n default
 * locale ('vi' — see `DEFAULT_LOCALE` in the renderer i18n index
 * and `settings.locale` in apps/desktop/src/main/main.ts, which is
 * the value plumbed through coordinator RPC `listThreads` /
 * `createThread` as `locale`). A new locale adds one entry here AND
 * one `thread.new` value in its locale file.
 */
const DEFAULT_THREAD_TITLE_BY_LOCALE: Record<string, string> = {
  en: 'New conversation',
  zh: '新对话',
  ja: '新しい会話',
  es: 'Conversación nueva',
  fr: 'Nouvelle conversation',
};

export function defaultThreadTitle(locale?: string | null): string {
  const code = (locale ?? '').trim().toLowerCase();
  return DEFAULT_THREAD_TITLE_BY_LOCALE[code] ?? DEFAULT_THREAD_TITLE;
}

/** v0.59 (UI-5): auto-title / search snippet truncation lengths. */
export const THREAD_AUTO_TITLE_MAX = 60;
export const THREAD_SNIPPET_MAX = 120;

/** v0.59 (UI-5): how many messages a thread search scans per bot. */
export const THREAD_SEARCH_SCAN_LIMIT = 2000;

export class BotMemory {
  private readonly db: DatabaseSync;
  /** v0.65: `<workspaceDir>/.open-bot/attachments` (see above). */
  private readonly attachmentsDir: string;

  constructor(workspaceDir: string) {
    const dir = join(workspaceDir, '.open-bot');
    mkdirSync(dir, { recursive: true });
    this.attachmentsDir = join(dir, ATTACHMENTS_DIR_NAME);
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
        createdAt TEXT NOT NULL,
        threadId TEXT
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
        tags TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        botId TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        botId TEXT NOT NULL,
        title TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        botId TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        updatesEnabled INTEGER NOT NULL DEFAULT 0,
        lastUpdateAt TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_checkpoints (
        id TEXT PRIMARY KEY,
        runId TEXT NOT NULL,
        botId TEXT NOT NULL,
        stepIndex INTEGER NOT NULL,
        messagesJson TEXT NOT NULL,
        toolCallsJson TEXT NOT NULL DEFAULT '[]',
        tokensUsed INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        UNIQUE(runId, stepIndex)
      );
      CREATE INDEX IF NOT EXISTS idx_run_checkpoints_run
        ON run_checkpoints(runId, stepIndex);
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        botId TEXT NOT NULL,
        title TEXT NOT NULL,
        titleCustom INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_threads_bot
        ON threads(botId, createdAt DESC);
      CREATE TABLE IF NOT EXISTS message_attachments (
        id TEXT PRIMARY KEY,
        messageId TEXT NOT NULL,
        botId TEXT NOT NULL,
        idx INTEGER NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        mimeType TEXT NOT NULL,
        sizeBytes INTEGER NOT NULL,
        fileName TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        UNIQUE(messageId, idx)
      );
      CREATE INDEX IF NOT EXISTS idx_msg_attachments_msg
        ON message_attachments(messageId, idx);
      CREATE INDEX IF NOT EXISTS idx_msg_attachments_bot
        ON message_attachments(botId);
    `);
    // --- v0.2 migrations for DBs created by v0.1 -------------------------
    // tasks.tags did not exist in v0.1: add it without touching old rows
    // (they keep their data and get tags = '').
    const taskColumns = this.db
      .prepare('PRAGMA table_info(tasks)')
      .all() as Array<{ name: string }>;
    if (!taskColumns.some((c) => c.name === 'tags')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN tags TEXT NOT NULL DEFAULT ''`);
    }
    // Defensive: same guard for projects.updatesEnabled, in case a DB was
    // created by an intermediate build with a projects table lacking it.
    const projectColumns = this.db
      .prepare('PRAGMA table_info(projects)')
      .all() as Array<{ name: string }>;
    if (!projectColumns.some((c) => c.name === 'updatesEnabled')) {
      this.db.exec(`ALTER TABLE projects ADD COLUMN updatesEnabled INTEGER NOT NULL DEFAULT 0`);
    }
    // v0.94c: same guard for projects.lastUpdateAt (digest-sent marker).
    if (!projectColumns.some((c) => c.name === 'lastUpdateAt')) {
      this.db.exec(`ALTER TABLE projects ADD COLUMN lastUpdateAt TEXT`);
    }
    // --- v0.59 (UI-5) migrations for DBs created before threads ---------
    // messages.threadId: old rows keep NULL until ensureDefaultThread
    // migrates them into the bot's first thread (history is never lost).
    // NOTE (v0.59 composio-seed wave): the CREATE TABLE messages above
    // now declares threadId, so fresh DBs already have the column; the
    // index is created here (after the column is guaranteed to exist)
    // instead of in the CREATE batch above — creating it there threw
    // "no such column: threadId" for fresh DBs (and for old DBs, whose
    // messages table gains the column only via the ALTER below).
    const messageColumns = this.db
      .prepare('PRAGMA table_info(messages)')
      .all() as Array<{ name: string }>;
    if (!messageColumns.some((c) => c.name === 'threadId')) {
      this.db.exec(`ALTER TABLE messages ADD COLUMN threadId TEXT`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(threadId)`);
    // threads.titleCustom: DBs created by an intermediate v0.59 build
    // with a threads table lacking it gain the column (default 0).
    const threadColumns = this.db
      .prepare('PRAGMA table_info(threads)')
      .all() as Array<{ name: string }>;
    if (threadColumns.length > 0 && !threadColumns.some((c) => c.name === 'titleCustom')) {
      this.db.exec(`ALTER TABLE threads ADD COLUMN titleCustom INTEGER NOT NULL DEFAULT 0`);
    }
    // v0.65: drop attachment files whose message row is gone (crash
    // orphans, or a DB restored from an older backup). Best-effort and
    // never throws — storage must not break startup.
    try {
      this.pruneOrphanAttachmentFiles();
    } catch {
      // Ignore: orphan files are harmless until the next start.
    }
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

  /**
   * Append one chat message. `threadId` (v0.59 UI-5) pins the message to
   * a thread — unknown threadId (or a thread of another bot) throws, so
   * a message can never land in the wrong thread silently. Without a
   * threadId the row keeps threadId NULL (legacy path: callers that do
   * not know about threads yet, e.g. automations; `ensureDefaultThread`
   * adopts those rows on the next thread listing).
   *
   * v0.65 (vision persistence, option B — files + DB reference, see
   * the class doc): `attachments` (user messages only) are validated
   * against the vision caps (`validateVisionAttachments` — max 5
   * images, 10 MB each, 20 MB total, PNG/JPEG/GIF/WebP; invalid input
   * throws, fail-closed) and stored as files under
   * `.open-bot/attachments/<messageId>/<idx>.<ext>` with one
   * `message_attachments` row per image. The message TEXT is stored
   * as-is — no metadata line is appended any more (v0.63/v0.64 saved
   * "📷 Ảnh đính kèm: name (mime, size)" lines because base64 was
   * never persisted; those old rows keep their lines and still render
   * as before). Files are written first, then message + attachment
   * rows land in one transaction; any failure removes the files just
   * written, so a half-saved message never leaves orphan bytes.
   */
  saveMessage(
    botId: string,
    role: Role,
    content: string,
    threadId?: string,
    attachments?: VisionAttachment[],
  ): string {
    if (threadId !== undefined) {
      const thread = this.getThreadRow(threadId);
      if (!thread || thread.botId !== botId) {
        throw new Error(`Không tìm thấy thread "${threadId}" của bot "${botId}".`);
      }
    }
    const validated: VisionValidationResult =
      attachments === undefined
        ? { ok: true, attachments: [] }
        : validateVisionAttachments(attachments);
    if (!validated.ok) throw new Error(validated.error);
    const images = validated.attachments;
    const id = randomUUID();
    const now = new Date().toISOString();
    const messageDir = join(this.attachmentsDir, id);
    try {
      if (images.length > 0) {
        mkdirSync(messageDir, { recursive: true });
        images.forEach((att, i) => {
          const ext = ATTACHMENT_EXT_BY_MIME[att.mimeType] ?? 'bin';
          writeFileSync(
            join(messageDir, `${i}.${ext}`),
            Buffer.from(att.data, 'base64'),
          );
        });
      }
      this.db.exec('BEGIN IMMEDIATE TRANSACTION');
      try {
        this.db
          .prepare(
            'INSERT INTO messages (id, botId, role, content, createdAt, threadId) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(id, botId, role, content, now, threadId ?? null);
        images.forEach((att, i) => {
          const ext = ATTACHMENT_EXT_BY_MIME[att.mimeType] ?? 'bin';
          this.db
            .prepare(
              `INSERT INTO message_attachments
                 (id, messageId, botId, idx, name, mimeType, sizeBytes, fileName, createdAt)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              randomUUID(),
              id,
              botId,
              i,
              att.name ?? '',
              att.mimeType,
              Buffer.from(att.data, 'base64').length,
              `${i}.${ext}`,
              now,
            );
        });
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    } catch (err) {
      // Never leave orphan files behind a failed save.
      try {
        rmSync(messageDir, { recursive: true, force: true });
      } catch {
        // Best-effort: the constructor sweep removes leftovers.
      }
      throw err;
    }
    // v0.59 (UI-5): auto-title from the first user message — only while
    // the user has not renamed the thread by hand (titleCustom = 0).
    // An image-only message has no text: title it from the first image
    // name instead of an empty string.
    if (threadId !== undefined && role === 'user') {
      const titleSource =
        content.trim() !== ''
          ? content
          : images.length > 0
            ? `📷 ${images[0]?.name ?? 'ảnh'}`
            : content;
      this.maybeAutoTitle(threadId, titleSource);
    }
    return id;
  }

  /**
   * Most recent `limit` messages, oldest first. Default 50.
   * `threadId` (v0.59 UI-5) scopes to one thread; without it the bot's
   * whole history is returned (legacy callers: search, handoff,
   * transcript — unchanged behaviour).
   *
   * v0.65: `options.includeAttachments` re-reads stored images from
   * their files as base64 for DISPLAY (renderer reload). Default is
   * false — run-context seeding, export and every other reader keep
   * getting text-only messages, so old images are never re-sent to a
   * provider and history stays cheap. A stored file that is missing,
   * tampered with (size differs from its row) or over the per-image
   * cap comes back as `{ data: '', unavailable: true }` — metadata
   * intact, never a throw.
   */
  getHistory(
    botId: string,
    limit = 50,
    threadId?: string,
    options?: { includeAttachments?: boolean },
  ): ChatMessage[] {
    const rows =
      threadId === undefined
        ? (this.db
            .prepare(
              `SELECT id, role, content FROM messages
               WHERE botId = ?
               ORDER BY createdAt DESC, rowid DESC
               LIMIT ?`,
            )
            .all(botId, limit) as Array<{ id: string; role: Role; content: string }>)
        : (this.db
            .prepare(
              `SELECT id, role, content FROM messages
               WHERE botId = ? AND threadId = ?
               ORDER BY createdAt DESC, rowid DESC
               LIMIT ?`,
            )
            .all(botId, threadId, limit) as Array<{ id: string; role: Role; content: string }>);
    const byMessage = options?.includeAttachments
      ? this.loadAttachmentsForMessages(rows.map((r) => r.id))
      : new Map<string, VisionAttachment[]>();
    return rows.reverse().map((r) => {
      const msg: ChatMessage = { role: r.role, content: r.content };
      if (options?.includeAttachments) {
        const atts = byMessage.get(r.id);
        if (atts && atts.length > 0) msg.attachments = atts;
      }
      return msg;
    });
  }

  // -------------------------------------------------------------------------
  // Message attachments (v0.65 — files + DB reference, option B)
  // -------------------------------------------------------------------------

  /** One stored attachment row (raw DB shape). */
  private loadAttachmentsForMessages(messageIds: string[]): Map<string, VisionAttachment[]> {
    const out = new Map<string, VisionAttachment[]>();
    if (messageIds.length === 0) return out;
    const placeholders = messageIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT messageId, idx, name, mimeType, sizeBytes, fileName
         FROM message_attachments
         WHERE messageId IN (${placeholders})
         ORDER BY messageId ASC, idx ASC`,
      )
      .all(...messageIds) as Array<{
      messageId: string;
      idx: number;
      name: string;
      mimeType: string;
      sizeBytes: number;
      fileName: string;
    }>;
    for (const row of rows) {
      const list = out.get(row.messageId) ?? [];
      out.set(row.messageId, list);
      list.push(this.readAttachmentFile(row));
    }
    return out;
  }

  /**
   * Read one stored image back as base64. Fail-closed: a missing file,
   * a file whose bytes no longer match its row (tampered / partially
   * written), an unknown mime or an over-cap file returns the metadata
   * with `data: ''` + `unavailable: true` — the renderer shows the
   * name + a note, never a broken image or an exception.
   */
  private readAttachmentFile(row: {
    messageId: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    fileName: string;
  }): VisionAttachment {
    const meta = { mimeType: row.mimeType, ...(row.name ? { name: row.name } : {}) };
    const unavailable: VisionAttachment = { ...meta, data: '', unavailable: true };
    if (!VISION_ALLOWED_MIME_TYPES.includes(row.mimeType)) return unavailable;
    // Defence-in-depth: a tampered fileName must never escape the
    // message's own directory (both values are ours, but the check is
    // one line and the path is built from DB content).
    if (basename(row.fileName) !== row.fileName || row.fileName.includes('/')) {
      return unavailable;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(this.attachmentsDir, row.messageId, row.fileName));
    } catch {
      return unavailable;
    }
    if (bytes.length === 0 || bytes.length !== row.sizeBytes || bytes.length > VISION_MAX_IMAGE_BYTES) {
      return unavailable;
    }
    return { ...meta, data: bytes.toString('base64') };
  }

  /**
   * Delete attachment rows + files for the given message ids. File
   * removal is best-effort: a leftover directory is picked up by the
   * constructor orphan sweep on the next start.
   */
  private deleteMessageAttachments(messageIds: string[]): void {
    if (messageIds.length === 0) return;
    const placeholders = messageIds.map(() => '?').join(', ');
    this.db
      .prepare(`DELETE FROM message_attachments WHERE messageId IN (${placeholders})`)
      .run(...messageIds);
    for (const id of messageIds) {
      try {
        rmSync(join(this.attachmentsDir, id), { recursive: true, force: true });
      } catch {
        // Ignore — see the constructor sweep.
      }
    }
  }

  /**
   * Remove attachment directories whose message has no attachment row
   * any more (crash orphans, or a DB restored from an older backup).
   * Called once at construction; never throws.
   */
  private pruneOrphanAttachmentFiles(): void {
    let names: string[];
    try {
      names = readdirSync(this.attachmentsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return; // No attachments dir yet — nothing to prune.
    }
    if (names.length === 0) return;
    const placeholders = names.map(() => '?').join(', ');
    const live = new Set(
      (
        this.db
          .prepare(
            `SELECT DISTINCT messageId AS id FROM message_attachments
             WHERE messageId IN (${placeholders})`,
          )
          .all(...names) as Array<{ id: string }>
      ).map((r) => r.id),
    );
    for (const name of names) {
      if (live.has(name)) continue;
      try {
        rmSync(join(this.attachmentsDir, name), { recursive: true, force: true });
      } catch {
        // Ignore — retried on the next start.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Threads (v0.59 UI-5)
  // -------------------------------------------------------------------------

  /** One-line title from a message: single line, trimmed, max 60 chars. */
  private static autoTitleFrom(content: string): string {
    const oneLine = content.replace(/\s+/g, ' ').trim();
    if (oneLine.length <= THREAD_AUTO_TITLE_MAX) return oneLine;
    return `${oneLine.slice(0, THREAD_AUTO_TITLE_MAX - 1).trimEnd()}…`;
  }

  /** Raw thread row (no messageCount) or null. */
  private getThreadRow(id: string): {
    id: string;
    botId: string;
    title: string;
    titleCustom: number;
    createdAt: string;
    updatedAt: string;
  } | null {
    const row = this.db
      .prepare(
        'SELECT id, botId, title, titleCustom, createdAt, updatedAt FROM threads WHERE id = ?',
      )
      .get(id) as
      | { id: string; botId: string; title: string; titleCustom: number; createdAt: string; updatedAt: string }
      | undefined;
    return row ?? null;
  }

  private threadRowToItem(
    row: { id: string; botId: string; title: string; titleCustom: number; createdAt: string; updatedAt: string },
    messageCount: number,
  ): ThreadItem {
    return {
      id: row.id,
      botId: row.botId,
      title: row.title,
      titleCustom: row.titleCustom === 1,
      messageCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private countThreadMessages(threadId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE threadId = ?')
      .get(threadId) as { n: number };
    return row.n;
  }

  /**
   * Create a thread. Empty/blank title falls back to the default title
   * in the given locale (see `defaultThreadTitle`; no locale = 'vi').
   * An explicit title counts as hand-picked (titleCustom = 1), so the
   * first user message never overwrites it; only a default-titled
   * thread is auto-titled. Returns the thread.
   */
  createThread(botId: string, title?: string, locale?: string): ThreadItem {
    const id = randomUUID();
    const now = new Date().toISOString();
    const hasTitle = title?.trim() ? true : false;
    const cleanTitle = hasTitle ? (title as string).trim() : defaultThreadTitle(locale);
    this.db
      .prepare(
        'INSERT INTO threads (id, botId, title, titleCustom, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, botId, cleanTitle, hasTitle ? 1 : 0, now, now);
    const row = this.getThreadRow(id);
    if (!row) throw new Error(`Không tạo được thread cho bot "${botId}".`);
    return this.threadRowToItem(row, 0);
  }

  /** One thread with its message count, or null when it does not exist. */
  getThread(id: string): ThreadItem | null {
    const row = this.getThreadRow(id);
    if (!row) return null;
    return this.threadRowToItem(row, this.countThreadMessages(id));
  }

  /** All threads of a bot, newest first, WITHOUT the ensure-default step. */
  private listThreadsRaw(botId: string): ThreadItem[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.botId, t.title, t.titleCustom, t.createdAt, t.updatedAt,
                COUNT(m.id) AS messageCount
         FROM threads t LEFT JOIN messages m ON m.threadId = t.id
         WHERE t.botId = ?
         GROUP BY t.id
         ORDER BY t.createdAt DESC, t.rowid DESC`,
      )
      .all(botId) as unknown as Array<{
      id: string;
      botId: string;
      title: string;
      titleCustom: number;
      createdAt: string;
      updatedAt: string;
      messageCount: number;
    }>;
    return rows.map((r) => this.threadRowToItem(r, r.messageCount));
  }

  /**
   * All threads of a bot, newest first. Always returns at least one
   * thread: when the bot has none yet, the default thread is created
   * (and any legacy messages with threadId NULL are adopted into it,
   * so old history is never lost — see `ensureDefaultThread`).
   * `locale` names the default thread when one has to be created.
   */
  listThreads(botId: string, locale?: string): ThreadItem[] {
    this.ensureDefaultThread(botId, locale);
    return this.listThreadsRaw(botId);
  }

  /**
   * The bot's first (oldest) thread, creating it when the bot has none.
   * Legacy messages (threadId NULL, written before threads existed)
   * are adopted into it and it is auto-titled from the first user
   * message — the old single-thread history survives the migration
   * untouched, only grouped under a thread now.
   * `locale` names the default thread when one has to be created.
   */
  ensureDefaultThread(botId: string, locale?: string): ThreadItem {
    const existing = this.listThreadsRaw(botId);
    if (existing.length > 0) return existing[existing.length - 1];
    const thread = this.createThread(botId, undefined, locale);
    const adopted = this.db
      .prepare('UPDATE messages SET threadId = ? WHERE botId = ? AND threadId IS NULL')
      .run(thread.id, botId).changes as number;
    if (adopted > 0) {
      const firstUser = this.db
        .prepare(
          `SELECT content FROM messages
           WHERE threadId = ? AND role = 'user'
           ORDER BY createdAt ASC, rowid ASC LIMIT 1`,
        )
        .get(thread.id) as { content: string } | undefined;
      if (firstUser) {
        this.db
          .prepare('UPDATE threads SET title = ?, updatedAt = ? WHERE id = ?')
          .run(BotMemory.autoTitleFrom(firstUser.content), new Date().toISOString(), thread.id);
      }
    }
    const row = this.getThreadRow(thread.id);
    if (!row) throw new Error(`Không tạo được thread mặc định cho bot "${botId}".`);
    return this.threadRowToItem(row, adopted);
  }

  /**
   * Rename a thread by hand. Empty/blank title throws; unknown thread
   * throws. Sets titleCustom so later user messages never overwrite
   * the hand-picked title. Returns the updated thread.
   */
  renameThread(id: string, title: string): ThreadItem {
    const clean = title.trim();
    if (!clean) throw new Error('Tiêu đề thread không được rỗng.');
    const row = this.getThreadRow(id);
    if (!row) throw new Error(`Không tìm thấy thread "${id}".`);
    this.db
      .prepare('UPDATE threads SET title = ?, titleCustom = 1, updatedAt = ? WHERE id = ?')
      .run(clean, new Date().toISOString(), id);
    const updated = this.getThreadRow(id);
    if (!updated) throw new Error(`Không tìm thấy thread "${id}".`);
    return this.threadRowToItem(updated, this.countThreadMessages(id));
  }

  /**
   * Delete a thread AND all its messages. Returns false when the thread
   * did not exist. Other threads (and their messages) are untouched.
   * v0.65: the thread's images go too — attachment rows + files — so
   * deleting a thread never leaves orphan bytes behind.
   */
  deleteThread(id: string): boolean {
    const row = this.getThreadRow(id);
    if (!row) return false;
    const messageIds = (
      this.db.prepare('SELECT id FROM messages WHERE threadId = ?').all(id) as Array<{
        id: string;
      }>
    ).map((r) => r.id);
    this.deleteMessageAttachments(messageIds);
    this.db.prepare('DELETE FROM messages WHERE threadId = ?').run(id);
    this.db.prepare('DELETE FROM threads WHERE id = ?').run(id);
    return true;
  }

  /**
   * Fix v0.59 leftover (b): delete EVERY row that belongs to one bot —
   * the bot row itself, its threads + messages, and its memory entries,
   * tasks, goals, todos, projects and run checkpoints — in one
   * transaction. Returns the per-table deleted counts (0 when the bot
   * had no rows). Every DELETE is scoped by botId, so bots that share
   * one workspace DB are untouched; the DB file itself (and the
   * workspace files around it) stays — only this bot's rows go.
   *
   * Called ONLY from `destroyBot({ deleteData: true })` — the real
   * bot-delete path. Plain `destroyBot` (bot edit, provider change,
   * MCP install/uninstall — all via main `invalidateRuntime`) must
   * NOT call this, or editing a bot would wipe its history.
   */
  deleteBotData(botId: string): Record<string, number> {
    // v0.65: the bot's images go with it — collect the message ids
    // first (the rows are gone after the transaction), then remove
    // their attachment files best-effort once the rows are deleted.
    const messageIds = (
      this.db.prepare('SELECT id FROM messages WHERE botId = ?').all(botId) as Array<{
        id: string;
      }>
    ).map((r) => r.id);
    const tables = [
      'messages',
      'message_attachments',
      'threads',
      'memory_entries',
      'tasks',
      'goals',
      'todos',
      'projects',
      'run_checkpoints',
      'bots',
    ] as const;
    const counts: Record<string, number> = {};
    this.db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      for (const table of tables) {
        // Every table keys rows by botId — except `bots` itself, whose
        // primary key is `id`.
        const column = table === 'bots' ? 'id' : 'botId';
        const result = this.db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(botId);
        counts[table] = result.changes as number;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    for (const id of messageIds) {
      try {
        rmSync(join(this.attachmentsDir, id), { recursive: true, force: true });
      } catch {
        // Ignore — the constructor sweep removes leftovers.
      }
    }
    return counts;
  }

  /**
   * Most recent `limit` messages of one thread, oldest first.
   * Unknown thread throws (fail-closed, like getHistory for a bad bot).
   * v0.65: `options.includeAttachments` is passed through to
   * `getHistory` (display reloads only — run-context seeding leaves
   * it off).
   */
  getThreadHistory(
    threadId: string,
    limit = 50,
    options?: { includeAttachments?: boolean },
  ): ChatMessage[] {
    const row = this.getThreadRow(threadId);
    if (!row) throw new Error(`Không tìm thấy thread "${threadId}".`);
    return this.getHistory(row.botId, limit, threadId, options);
  }

  /**
   * Set the thread title from a user message, but only while the user
   * has not renamed it by hand (titleCustom = 0) and only while the
   * thread has no user message yet — i.e. the FIRST user message names
   * the thread; later messages never rename it.
   */
  private maybeAutoTitle(threadId: string, content: string): void {
    const row = this.getThreadRow(threadId);
    if (!row || row.titleCustom === 1) return;
    const priorUser = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages WHERE threadId = ? AND role = 'user'`,
      )
      .get(threadId) as { n: number };
    // The just-saved message is already counted, so n === 1 means this
    // IS the first user message of the thread.
    if (priorUser.n !== 1) return;
    this.db
      .prepare('UPDATE threads SET title = ?, updatedAt = ? WHERE id = ?')
      .run(BotMemory.autoTitleFrom(content), new Date().toISOString(), threadId);
  }

  /**
   * Search one bot's threads by title or message content
   * (case-insensitive, Vietnamese-aware — filtering runs in JS over
   * the bot's messages, capped at THREAD_SEARCH_SCAN_LIMIT, because
   * SQLite LIKE is ASCII-only for case folding). Newest thread first;
   * at most 50 hits. Empty query returns [].
   */
  searchThreads(botId: string, query: string): ThreadSearchHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const threads = this.listThreadsRaw(botId);
    if (threads.length === 0) return [];
    const byId = new Map(threads.map((t) => [t.id, t]));
    const rows = this.db
      .prepare(
        `SELECT threadId, role, content FROM messages
         WHERE botId = ? AND threadId IS NOT NULL
         ORDER BY createdAt DESC, rowid DESC
         LIMIT ?`,
      )
      .all(botId, THREAD_SEARCH_SCAN_LIMIT) as Array<{
      threadId: string;
      role: string;
      content: string;
    }>;
    // Oldest matching message first (for the snippet), so collect in
    // reverse scan order.
    const matches = new Map<string, { count: number; snippet: string }>();
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (!row.threadId || !byId.has(row.threadId)) continue;
      if (!row.content.toLowerCase().includes(q)) continue;
      const prev = matches.get(row.threadId);
      const snippet =
        row.content.replace(/\s+/g, ' ').trim().slice(0, THREAD_SNIPPET_MAX);
      if (!prev) matches.set(row.threadId, { count: 1, snippet });
      else prev.count += 1;
    }
    const hits: ThreadSearchHit[] = [];
    for (const thread of threads) {
      const titleMatch = thread.title.toLowerCase().includes(q);
      const msg = matches.get(thread.id);
      if (!titleMatch && !msg) continue;
      hits.push({
        thread,
        snippet: msg ? msg.snippet : thread.title,
        matchCount: msg ? msg.count : 0,
      });
    }
    return hits.slice(0, 50);
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
  createTask(botId: string, title: string, tags = ''): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO tasks (id, botId, title, status, tags, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, botId, title, 'pending', tags, now, now);
    return id;
  }

  getTask(id: string): TaskItem | null {
    const row = this.db
      .prepare(
        'SELECT id, botId, title, status, tags, createdAt, updatedAt FROM tasks WHERE id = ?',
      )
      .get(id) as unknown as TaskItem | undefined;
    return row ?? null;
  }

  updateTask(id: string, status: TaskStatus): void {
    this.updateTaskFields(id, { status });
  }

  /** Partial update: only the fields present in `patch` are changed. */
  updateTaskFields(
    id: string,
    patch: { title?: string; status?: TaskStatus; tags?: string },
  ): void {
    const sets: string[] = [];
    const values: Array<string | number> = [];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      values.push(patch.title);
    }
    if (patch.status !== undefined) {
      sets.push('status = ?');
      values.push(patch.status);
    }
    if (patch.tags !== undefined) {
      sets.push('tags = ?');
      values.push(patch.tags);
    }
    if (sets.length === 0) return;
    sets.push('updatedAt = ?');
    values.push(new Date().toISOString());
    values.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  /** Replace a task's tags (free-form comma-separated text). */
  setTaskTags(id: string, tags: string): void {
    this.updateTaskFields(id, { tags });
  }

  deleteTask(id: string): void {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  /** Newest first. Optional filters: status and/or a tag substring. */
  listTasks(botId: string, filter: { status?: TaskStatus; tag?: string } = {}): TaskItem[] {
    const where: string[] = ['botId = ?'];
    const values: Array<string | number> = [botId];
    if (filter.status !== undefined) {
      where.push('status = ?');
      values.push(filter.status);
    }
    if (filter.tag !== undefined) {
      where.push('tags LIKE ?');
      values.push(`%${filter.tag}%`);
    }
    return this.db
      .prepare(
        `SELECT id, botId, title, status, tags, createdAt, updatedAt FROM tasks
         WHERE ${where.join(' AND ')} ORDER BY createdAt DESC, rowid DESC`,
      )
      .all(...values) as unknown as TaskItem[];
  }

  // -------------------------------------------------------------------------
  // Goals
  // -------------------------------------------------------------------------

  /** Create a goal in status 'active'. Returns the goal id. */
  createGoal(botId: string, title: string, detail = ''): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO goals (id, botId, title, detail, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, botId, title, detail, 'active', now, now);
    return id;
  }

  getGoal(id: string): GoalItem | null {
    const row = this.db
      .prepare(
        'SELECT id, botId, title, detail, status, createdAt, updatedAt FROM goals WHERE id = ?',
      )
      .get(id) as unknown as GoalItem | undefined;
    return row ?? null;
  }

  /** Partial update: only the fields present in `patch` are changed. */
  updateGoal(
    id: string,
    patch: { title?: string; detail?: string; status?: GoalStatus },
  ): void {
    const sets: string[] = [];
    const values: Array<string | number> = [];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      values.push(patch.title);
    }
    if (patch.detail !== undefined) {
      sets.push('detail = ?');
      values.push(patch.detail);
    }
    if (patch.status !== undefined) {
      sets.push('status = ?');
      values.push(patch.status);
    }
    if (sets.length === 0) return;
    sets.push('updatedAt = ?');
    values.push(new Date().toISOString());
    values.push(id);
    this.db.prepare(`UPDATE goals SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteGoal(id: string): void {
    this.db.prepare('DELETE FROM goals WHERE id = ?').run(id);
  }

  /** Newest first. Optional status filter. */
  listGoals(botId: string, status?: GoalStatus): GoalItem[] {
    if (status === undefined) {
      return this.db
        .prepare(
          `SELECT id, botId, title, detail, status, createdAt, updatedAt FROM goals
           WHERE botId = ? ORDER BY createdAt DESC, rowid DESC`,
        )
        .all(botId) as unknown as GoalItem[];
    }
    return this.db
      .prepare(
        `SELECT id, botId, title, detail, status, createdAt, updatedAt FROM goals
         WHERE botId = ? AND status = ? ORDER BY createdAt DESC, rowid DESC`,
      )
      .all(botId, status) as unknown as GoalItem[];
  }

  // -------------------------------------------------------------------------
  // Todos
  // -------------------------------------------------------------------------

  /** Create a todo (done = false). Returns the todo id. */
  createTodo(botId: string, title: string): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO todos (id, botId, title, done, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, botId, title, 0, now, now);
    return id;
  }

  getTodo(id: string): TodoItem | null {
    const row = this.db
      .prepare('SELECT id, botId, title, done, createdAt, updatedAt FROM todos WHERE id = ?')
      .get(id) as unknown as { id: string; botId: string; title: string; done: number; createdAt: string; updatedAt: string } | undefined;
    if (!row) return null;
    return { ...row, done: row.done === 1 };
  }

  /** Partial update: only the fields present in `patch` are changed. */
  updateTodo(id: string, patch: { title?: string; done?: boolean }): void {
    const sets: string[] = [];
    const values: Array<string | number> = [];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      values.push(patch.title);
    }
    if (patch.done !== undefined) {
      sets.push('done = ?');
      values.push(patch.done ? 1 : 0);
    }
    if (sets.length === 0) return;
    sets.push('updatedAt = ?');
    values.push(new Date().toISOString());
    values.push(id);
    this.db.prepare(`UPDATE todos SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteTodo(id: string): void {
    this.db.prepare('DELETE FROM todos WHERE id = ?').run(id);
  }

  /** Newest first. Optional done filter. */
  listTodos(botId: string, done?: boolean): TodoItem[] {
    const rows =
      done === undefined
        ? (this.db
            .prepare(
              `SELECT id, botId, title, done, createdAt, updatedAt FROM todos
               WHERE botId = ? ORDER BY createdAt DESC, rowid DESC`,
            )
            .all(botId) as unknown as Array<Omit<TodoItem, 'done'> & { done: number }>)
        : (this.db
            .prepare(
              `SELECT id, botId, title, done, createdAt, updatedAt FROM todos
               WHERE botId = ? AND done = ? ORDER BY createdAt DESC, rowid DESC`,
            )
            .all(botId, done ? 1 : 0) as unknown as Array<Omit<TodoItem, 'done'> & { done: number }>);
    return rows.map((r) => ({ ...r, done: r.done === 1 }));
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  /** Create a project in status 'active'. Returns the project id. */
  createProject(botId: string, title: string, detail = ''): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO projects (id, botId, title, detail, status, updatesEnabled, lastUpdateAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, botId, title, detail, 'active', 0, null, now, now);
    return id;
  }

  getProject(id: string): ProjectItem | null {
    const row = this.db
      .prepare(
        'SELECT id, botId, title, detail, status, updatesEnabled, lastUpdateAt, createdAt, updatedAt FROM projects WHERE id = ?',
      )
      .get(id) as unknown as {
        id: string;
        botId: string;
        title: string;
        detail: string;
        status: ProjectStatus;
        updatesEnabled: number;
        lastUpdateAt: string | null;
        createdAt: string;
        updatedAt: string;
      } | undefined;
    if (!row) return null;
    return { ...row, updatesEnabled: row.updatesEnabled === 1, lastUpdateAt: row.lastUpdateAt ?? null };
  }

  /** Partial update: only the fields present in `patch` are changed. */
  updateProject(
    id: string,
    patch: {
      title?: string;
      detail?: string;
      status?: ProjectStatus;
      updatesEnabled?: boolean;
      lastUpdateAt?: string | null;
    },
  ): void {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      values.push(patch.title);
    }
    if (patch.detail !== undefined) {
      sets.push('detail = ?');
      values.push(patch.detail);
    }
    if (patch.status !== undefined) {
      sets.push('status = ?');
      values.push(patch.status);
    }
    if (patch.updatesEnabled !== undefined) {
      sets.push('updatesEnabled = ?');
      values.push(patch.updatesEnabled ? 1 : 0);
    }
    if (patch.lastUpdateAt !== undefined) {
      sets.push('lastUpdateAt = ?');
      values.push(patch.lastUpdateAt);
    }
    if (sets.length === 0) return;
    sets.push('updatedAt = ?');
    values.push(new Date().toISOString());
    values.push(id);
    this.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  /**
   * Toggle the periodic-updates flag for a project. v0.94c: the flag
   * now has a real delivery channel — the desktop main ticks
   * `listDueProjectUpdates` every 15 minutes and sends a digest for
   * every enabled project that is due (see `project/updates.ts`).
   */
  setProjectUpdates(id: string, enabled: boolean): void {
    this.updateProject(id, { updatesEnabled: enabled });
  }

  /**
   * v0.94c: record that a project-update digest was sent at `at`
   * (ISO timestamp). The due check compares this against the 6-hour
   * interval — without it, "enabled" could never tell due from sent.
   */
  setProjectLastUpdateAt(id: string, at: Date): void {
    this.updateProject(id, { lastUpdateAt: at.toISOString() });
  }

  deleteProject(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  /** Newest first. Optional status filter. */
  listProjects(botId: string, status?: ProjectStatus): ProjectItem[] {
    const rows =
      status === undefined
        ? (this.db
            .prepare(
              `SELECT id, botId, title, detail, status, updatesEnabled, lastUpdateAt, createdAt, updatedAt FROM projects
               WHERE botId = ? ORDER BY createdAt DESC, rowid DESC`,
            )
            .all(botId) as unknown as Array<
            Omit<ProjectItem, 'updatesEnabled' | 'lastUpdateAt'> & {
              updatesEnabled: number;
              lastUpdateAt: string | null;
            }
          >)
        : (this.db
            .prepare(
              `SELECT id, botId, title, detail, status, updatesEnabled, lastUpdateAt, createdAt, updatedAt FROM projects
               WHERE botId = ? AND status = ? ORDER BY createdAt DESC, rowid DESC`,
            )
            .all(botId, status) as unknown as Array<
            Omit<ProjectItem, 'updatesEnabled' | 'lastUpdateAt'> & {
              updatesEnabled: number;
              lastUpdateAt: string | null;
            }
          >);
    return rows.map((r) => ({
      ...r,
      updatesEnabled: r.updatesEnabled === 1,
      lastUpdateAt: r.lastUpdateAt ?? null,
    }));
  }

  // -------------------------------------------------------------------------
  // Run checkpoints (v0.12) — raw row access only
  // -------------------------------------------------------------------------
  // Parsing/validation and the resume logic live in `agent/checkpoints.ts`.
  // These methods just read/write rows of `run_checkpoints`.

  /**
   * Insert a checkpoint row, or overwrite the row for the same
   * (runId, stepIndex) when it already exists. Returns the stored row
   * (with a generated id / createdAt when it is a new row).
   */
  insertCheckpointRow(row: Omit<CheckpointRow, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): CheckpointRow {
    const id = row.id || randomUUID();
    const createdAt = row.createdAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO run_checkpoints (id, runId, botId, stepIndex, messagesJson, toolCallsJson, tokensUsed, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(runId, stepIndex) DO UPDATE SET
           botId = excluded.botId,
           messagesJson = excluded.messagesJson,
           toolCallsJson = excluded.toolCallsJson,
           tokensUsed = excluded.tokensUsed,
           createdAt = excluded.createdAt`,
      )
      .run(id, row.runId, row.botId, row.stepIndex, row.messagesJson, row.toolCallsJson, row.tokensUsed, createdAt);
    // Upsert keeps the original row id on conflict — read it back.
    const stored = this.getCheckpointRow(row.runId, row.stepIndex);
    if (!stored) throw new Error(`Không lưu được checkpoint cho run ${row.runId} step ${row.stepIndex}.`);
    return stored;
  }

  /** All checkpoint rows of a run, by stepIndex ascending. */
  listCheckpointRows(runId: string): CheckpointRow[] {
    return this.db
      .prepare(
        `SELECT id, runId, botId, stepIndex, messagesJson, toolCallsJson, tokensUsed, createdAt
         FROM run_checkpoints WHERE runId = ? ORDER BY stepIndex ASC`,
      )
      .all(runId) as unknown as CheckpointRow[];
  }

  /**
   * v0.54 (P1-8): toàn bộ checkpoint rows của một bot (mọi run), theo
   * runId rồi stepIndex — cho UI resume/time-travel liệt kê các run có
   * checkpoint mà không cần biết runId trước.
   */
  listBotCheckpointRows(botId: string): CheckpointRow[] {
    return this.db
      .prepare(
        `SELECT id, runId, botId, stepIndex, messagesJson, toolCallsJson, tokensUsed, createdAt
         FROM run_checkpoints WHERE botId = ? ORDER BY runId ASC, stepIndex ASC`,
      )
      .all(botId) as unknown as CheckpointRow[];
  }

  /** v0.54 (P1-8): id các run của bot còn checkpoint (để UI liệt kê). */
  listCheckpointRunIds(botId: string): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT runId FROM run_checkpoints WHERE botId = ? ORDER BY runId ASC`)
      .all(botId) as unknown as Array<{ runId: string }>;
    return rows.map((r) => r.runId);
  }

  /** One checkpoint row, or null when that step was never checkpointed. */
  getCheckpointRow(runId: string, stepIndex: number): CheckpointRow | null {
    const row = this.db
      .prepare(
        `SELECT id, runId, botId, stepIndex, messagesJson, toolCallsJson, tokensUsed, createdAt
         FROM run_checkpoints WHERE runId = ? AND stepIndex = ?`,
      )
      .get(runId, stepIndex) as unknown as CheckpointRow | undefined;
    return row ?? null;
  }

  /**
   * Delete a run's checkpoints except the `keepLastN` newest (by
   * stepIndex). Returns the number of deleted rows.
   */
  pruneCheckpointRows(runId: string, keepLastN: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM run_checkpoints
         WHERE runId = ? AND id NOT IN (
           SELECT id FROM run_checkpoints
           WHERE runId = ? ORDER BY stepIndex DESC LIMIT ?
         )`,
      )
      .run(runId, runId, keepLastN);
    return result.changes as number;
  }
}
