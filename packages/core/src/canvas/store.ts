/**
 * CanvasStore — versioned interactive documents ("canvas") for open-bot.
 *
 * A canvas is a JSON document with blocks (the app renders it as an
 * interactive page / whiteboard; the store only owns persistence):
 *
 *   { id, title, blocks, version, updatedAt, botId }
 *
 * Storage: one JSON file per canvas, under
 * `<workspaceDir>/.open-bot/canvas/<botId>/<id>.json` — durable per bot,
 * inside the bot's own workspace, same internal-state directory the rest
 * of the app uses (`.open-bot/`). Writes are atomic (temp file + rename)
 * and guarded by a simple lock file so two concurrent writers cannot
 * silently overwrite each other; `write()` also supports optimistic
 * concurrency via `expectedVersion`.
 *
 * No secrets live here — canvas content is user data, not credentials.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

/** One block of a canvas document. The app decides what `type` values mean. */
export interface CanvasBlock {
  type: string;
  [key: string]: unknown;
}

export interface CanvasDocument {
  id: string;
  title: string;
  blocks: CanvasBlock[];
  /** Increments on every successful write; starts at 1. */
  version: number;
  /** ISO-8601 timestamp of the last write. */
  updatedAt: string;
  botId: string;
}

export interface CanvasSummary {
  id: string;
  title: string;
  version: number;
  updatedAt: string;
  blockCount: number;
}

export interface CanvasWriteOptions {
  title?: string;
  /**
   * Optimistic concurrency: when given, the write fails when the stored
   * version differs, so a stale reader cannot clobber a newer edit.
   */
  expectedVersion?: number;
}

const CANVAS_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_TITLE_CHARS = 200;
const MAX_BLOCKS = 1000;
/** How long a lock file may live before it is treated as stale (crashed writer). */
const LOCK_STALE_MS = 10_000;
/** How long to keep retrying to take a lock before giving up. */
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeBotId(botId: string): string {
  const safe = botId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return safe === '' ? 'default-bot' : safe;
}

export function validateCanvasId(id: string): void {
  if (typeof id !== 'string' || !CANVAS_ID_RE.test(id)) {
    throw new Error(
      `Invalid canvas id "${id}": use only letters, digits, "-", "_" and ".", starting with a letter or digit.`,
    );
  }
}

export function validateCanvasBlocks(blocks: unknown): CanvasBlock[] {
  if (!Array.isArray(blocks)) {
    throw new Error('Canvas "blocks" must be an array of block objects.');
  }
  if (blocks.length > MAX_BLOCKS) {
    throw new Error(`Canvas has ${blocks.length} blocks, over the ${MAX_BLOCKS} block limit.`);
  }
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) {
      throw new Error('Every canvas block must be an object with a string "type".');
    }
    if (typeof (block as Record<string, unknown>)['type'] !== 'string') {
      throw new Error('Every canvas block must have a string "type".');
    }
  }
  return blocks as CanvasBlock[];
}

function validateCanvasTitle(title: string): string {
  if (typeof title !== 'string' || title.trim() === '') {
    throw new Error('Canvas "title" must be a non-empty string.');
  }
  if (title.length > MAX_TITLE_CHARS) {
    throw new Error(`Canvas title is ${title.length} chars, over the ${MAX_TITLE_CHARS} char limit.`);
  }
  return title;
}

export class CanvasStore {
  private readonly dir: string;
  private readonly botId: string;
  /**
   * Last timestamp handed out by this instance (ms). Timestamps must be
   * strictly increasing so list() ("newest first") is deterministic even
   * when two canvases are created within the same millisecond — a plain
   * `new Date().toISOString()` can tie, and a tied sort is arbitrary.
   */
  private lastTimestampMs = 0;

  /**
   * @param workspaceDir Bot workspace root; canvases live under
   *   `<workspaceDir>/.open-bot/canvas/<botId>/`.
   * @param botId Owner bot; used to scope the directory per bot.
   */
  constructor(workspaceDir: string, botId: string) {
    if (!workspaceDir) throw new Error('CanvasStore needs a workspaceDir.');
    if (!botId) throw new Error('CanvasStore needs a botId.');
    this.botId = botId;
    this.dir = path.join(workspaceDir, '.open-bot', 'canvas', sanitizeBotId(botId));
  }

  /** Monotonic ISO timestamp: never equal to (or before) the previous one. */
  private nextTimestamp(): string {
    const now = Date.now();
    this.lastTimestampMs = Math.max(now, this.lastTimestampMs + 1);
    return new Date(this.lastTimestampMs).toISOString();
  }

  /** Directory holding this bot's canvas files (created on first write). */
  get directory(): string {
    return this.dir;
  }

  /** Create a new canvas with a generated id. Version starts at 1. */
  async create(title: string, blocks: unknown): Promise<CanvasDocument> {
    const doc: CanvasDocument = {
      id: randomUUID(),
      title: validateCanvasTitle(title),
      blocks: validateCanvasBlocks(blocks),
      version: 1,
      updatedAt: this.nextTimestamp(),
      botId: this.botId,
    };
    await this.withLock(doc.id, async () => {
      this.saveDoc(doc);
    });
    return doc;
  }

  /** Read a canvas by id, or null when it does not exist. */
  async read(id: string): Promise<CanvasDocument | null> {
    validateCanvasId(id);
    const file = this.fileFor(id);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    return this.parseDoc(raw, file);
  }

  /**
   * Create or overwrite a canvas. A new canvas starts at version 1;
   * an existing one increments its version. Pass `expectedVersion` to
   * fail instead of overwriting a newer edit made in the meantime.
   */
  async write(
    id: string,
    blocks: unknown,
    options: CanvasWriteOptions = {},
  ): Promise<CanvasDocument> {
    validateCanvasId(id);
    const cleanBlocks = validateCanvasBlocks(blocks);
    if (options.title !== undefined) validateCanvasTitle(options.title);
    return this.withLock(id, async () => {
      const current = await this.read(id);
      if (current && options.expectedVersion !== undefined && current.version !== options.expectedVersion) {
        throw new Error(
          `Version conflict: canvas "${id}" is at version ${current.version}, ` +
            `but the write expected version ${options.expectedVersion}. ` +
            `Re-read the canvas and retry with the latest version.`,
        );
      }
      const doc: CanvasDocument = {
        id,
        title: options.title ?? current?.title ?? 'Untitled canvas',
        blocks: cleanBlocks,
        version: (current?.version ?? 0) + 1,
        updatedAt: this.nextTimestamp(),
        botId: this.botId,
      };
      this.saveDoc(doc);
      return doc;
    });
  }

  /** List this bot's canvases (newest first). */
  async list(): Promise<CanvasSummary[]> {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: CanvasSummary[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const doc = this.parseDoc(
          fs.readFileSync(path.join(this.dir, name), 'utf8'),
          path.join(this.dir, name),
        );
        out.push({
          id: doc.id,
          title: doc.title,
          version: doc.version,
          updatedAt: doc.updatedAt,
          blockCount: doc.blocks.length,
        });
      } catch {
        // A corrupt file must not hide the healthy canvases; it is
        // still visible to the user via list_files on the directory.
        continue;
      }
    }
    out.sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
      return a.id < b.id ? -1 : 1; // tie-break so the order is deterministic
    });
    return out;
  }

  /** Delete a canvas. Returns true when a file was actually removed. */
  async delete(id: string): Promise<boolean> {
    validateCanvasId(id);
    return this.withLock(id, async () => {
      try {
        fs.unlinkSync(this.fileFor(id));
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw err;
      }
    });
  }

  // --- Internals ------------------------------------------------------------

  private fileFor(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private lockFor(id: string): string {
    return path.join(this.dir, `${id}.lock`);
  }

  private parseDoc(raw: string, file: string): CanvasDocument {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Canvas file is not valid JSON: ${file}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Canvas file has an unsupported shape: ${file}`);
    }
    const doc = parsed as Record<string, unknown>;
    if (typeof doc['id'] !== 'string' || typeof doc['title'] !== 'string') {
      throw new Error(`Canvas file is missing id/title: ${file}`);
    }
    return {
      id: doc['id'] as string,
      title: doc['title'] as string,
      blocks: validateCanvasBlocks(doc['blocks'] ?? []),
      version: typeof doc['version'] === 'number' ? doc['version'] : 1,
      updatedAt: typeof doc['updatedAt'] === 'string' ? doc['updatedAt'] : new Date().toISOString(),
      botId: typeof doc['botId'] === 'string' ? doc['botId'] : this.botId,
    };
  }

  private saveDoc(doc: CanvasDocument): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.fileFor(doc.id);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  /**
   * Take the per-canvas lock file (exclusive create), run `fn`, release.
   * A lock older than LOCK_STALE_MS is treated as left by a crashed
   * writer and removed. Gives up after LOCK_TIMEOUT_MS.
   */
  private async withLock<T>(id: string, fn: () => Promise<T> | T): Promise<T> {
    fs.mkdirSync(this.dir, { recursive: true });
    const lockPath = this.lockFor(id);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {
          // Lock vanished between the failed create and the stat — retry.
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `Timed out waiting for the lock on canvas "${id}" (another writer holds it).`,
          );
        }
        await sleep(LOCK_RETRY_MS);
      }
    }
    try {
      return await fn();
    } finally {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Lock already gone (e.g. removed as stale) — nothing to do.
      }
    }
  }
}
