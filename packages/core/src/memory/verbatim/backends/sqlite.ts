/**
 * SQLite backend cho verbatim memory (v1.01, Đội T4).
 *
 * Dùng `node:sqlite` (built-in Node 24, không thêm dependency) — cùng
 * pattern với `BotMemory` (packages/core/src/agent/memory.ts). File
 * riêng `<dir>/verbatim.db`, KHÔNG chung bảng với `memory.db` để
 * verbatim store sống độc lập (xoá/migrate không ảnh hưởng BotMemory).
 *
 * Schema (version 1):
 *   verbatim_records(
 *     id TEXT PRIMARY KEY,
 *     text TEXT NOT NULL,
 *     source TEXT NOT NULL,
 *     wing TEXT NOT NULL,
 *     room TEXT NOT NULL,
 *     drawer TEXT,
 *     tags TEXT NOT NULL,          -- JSON array
 *     bot_id TEXT NOT NULL,
 *     user_id TEXT,
 *     created_at TEXT NOT NULL,    -- ISO 8601
 *     session_id TEXT,
 *     turn_index INTEGER,
 *     embedding TEXT,              -- JSON array số (đã chuẩn hoá L2)
 *     embedding_model TEXT,
 *     hash TEXT NOT NULL
 *   )
 *   + index theo (wing, room), hash (dedup), created_at (list mới nhất).
 *
 * WAL mode + synchronous NORMAL: bền vừa đủ cho local-first, không
 * khoá file khi app crash. Mọi ghi đều qua prepared statement.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type {
  VerbatimBackend,
  VerbatimFilter,
  VerbatimRecord,
} from '../types';

/** Tên file SQLite mặc định trong thư mục dữ liệu. */
export const VERBATIM_SQLITE_FILE = 'verbatim.db';
/** Version schema hiện tại. */
export const VERBATIM_SQLITE_SCHEMA_VERSION = 1;

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS verbatim_records (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  wing TEXT NOT NULL,
  room TEXT NOT NULL,
  drawer TEXT,
  tags TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  user_id TEXT,
  created_at TEXT NOT NULL,
  session_id TEXT,
  turn_index INTEGER,
  embedding TEXT,
  embedding_model TEXT,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verbatim_wing_room ON verbatim_records (wing, room);
CREATE INDEX IF NOT EXISTS idx_verbatim_hash ON verbatim_records (hash);
CREATE INDEX IF NOT EXISTS idx_verbatim_created ON verbatim_records (created_at);
CREATE INDEX IF NOT EXISTS idx_verbatim_bot ON verbatim_records (bot_id);
CREATE INDEX IF NOT EXISTS idx_verbatim_session ON verbatim_records (session_id);
`;

interface Row {
  id: string;
  text: string;
  source: string;
  wing: string;
  room: string;
  drawer: string | null;
  tags: string;
  bot_id: string;
  user_id: string | null;
  created_at: string;
  session_id: string | null;
  turn_index: number | null;
  embedding: string | null;
  embedding_model: string | null;
  hash: string;
}

function rowToRecord(row: Row): VerbatimRecord {
  let tags: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.tags);
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    tags = [];
  }
  let embedding: number[] | undefined;
  if (row.embedding !== null && row.embedding !== '') {
    try {
      const parsed: unknown = JSON.parse(row.embedding);
      if (Array.isArray(parsed) && parsed.every((n) => typeof n === 'number')) {
        embedding = parsed as number[];
      }
    } catch {
      embedding = undefined;
    }
  }
  const record: VerbatimRecord = {
    id: row.id,
    text: row.text,
    source: row.source as VerbatimRecord['source'],
    wing: row.wing,
    room: row.room,
    tags,
    botId: row.bot_id,
    createdAt: row.created_at,
    hash: row.hash,
  };
  if (row.drawer !== null) record.drawer = row.drawer;
  if (row.user_id !== null) record.userId = row.user_id;
  if (row.session_id !== null) record.sessionId = row.session_id;
  if (row.turn_index !== null) record.turnIndex = row.turn_index;
  if (embedding !== undefined) record.embedding = embedding;
  if (row.embedding_model !== null) record.embeddingModel = row.embedding_model;
  return record;
}

export interface SqliteVerbatimBackendOptions {
  /** Thư mục chứa `verbatim.db` (được tạo nếu chưa có). */
  dir: string;
  /** Tên file (mặc định `verbatim.db`). */
  fileName?: string;
  /** Mở read-only (cho tool kiểm tra, không ghi). */
  readOnly?: boolean;
}

/**
 * SQLite backend — đồng bộ bên trong (DatabaseSync), expose API
 * Promise để khớp interface chung với backend remote sau này.
 */
export class SqliteVerbatimBackend implements VerbatimBackend {
  readonly kind = 'sqlite';
  private readonly db: DatabaseSync;
  private readonly filePath: string;
  private closed = false;

  constructor(opts: SqliteVerbatimBackendOptions) {
    const dir = path.resolve(opts.dir);
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, opts.fileName ?? VERBATIM_SQLITE_FILE);
    this.db = new DatabaseSync(this.filePath, { readOnly: opts.readOnly ?? false });
    if (!opts.readOnly) {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
      this.db.exec(CREATE_TABLE_SQL);
    }
  }

  /** Đường dẫn file DB (để log/debug). */
  get path(): string {
    return this.filePath;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SqliteVerbatimBackend đã đóng.');
  }

  async insert(record: VerbatimRecord): Promise<void> {
    this.assertOpen();
    this.db.prepare(
      `INSERT INTO verbatim_records
         (id, text, source, wing, room, drawer, tags, bot_id, user_id,
          created_at, session_id, turn_index, embedding, embedding_model, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         text = excluded.text, source = excluded.source, wing = excluded.wing,
         room = excluded.room, drawer = excluded.drawer, tags = excluded.tags,
         bot_id = excluded.bot_id, user_id = excluded.user_id,
         created_at = excluded.created_at, session_id = excluded.session_id,
         turn_index = excluded.turn_index, embedding = excluded.embedding,
         embedding_model = excluded.embedding_model, hash = excluded.hash`,
    ).run(
      record.id,
      record.text,
      record.source,
      record.wing,
      record.room,
      record.drawer ?? null,
      JSON.stringify(record.tags),
      record.botId,
      record.userId ?? null,
      record.createdAt,
      record.sessionId ?? null,
      record.turnIndex ?? null,
      record.embedding !== undefined ? JSON.stringify(record.embedding) : null,
      record.embeddingModel ?? null,
      record.hash,
    );
  }

  async get(id: string): Promise<VerbatimRecord | undefined> {
    this.assertOpen();
    const row = this.db.prepare('SELECT * FROM verbatim_records WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? undefined : rowToRecord(row);
  }

  /** Tìm record theo hash (phục vụ dedup nhanh, không cần load hết). */
  async getByHash(hash: string): Promise<VerbatimRecord | undefined> {
    this.assertOpen();
    const row = this.db.prepare(
      'SELECT * FROM verbatim_records WHERE hash = ? ORDER BY created_at ASC LIMIT 1',
    ).get(hash) as Row | undefined;
    return row === undefined ? undefined : rowToRecord(row);
  }

  async list(
    filter: VerbatimFilter,
    opts: { limit: number; offset: number; order: 'newest' | 'oldest' },
  ): Promise<VerbatimRecord[]> {
    this.assertOpen();
    const { where, params } = buildWhere(filter);
    const direction = opts.order === 'oldest' ? 'ASC' : 'DESC';
    const rows = this.db.prepare(
      `SELECT * FROM verbatim_records ${where} ORDER BY created_at ${direction}, id ${direction} LIMIT ? OFFSET ?`,
    ).all(...params, opts.limit, opts.offset) as unknown as Row[];
    return rows.map(rowToRecord);
  }

  async delete(id: string): Promise<boolean> {
    this.assertOpen();
    const info = this.db.prepare('DELETE FROM verbatim_records WHERE id = ?').run(id);
    return info.changes > 0;
  }

  async count(filter: VerbatimFilter): Promise<number> {
    this.assertOpen();
    const { where, params } = buildWhere(filter);
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM verbatim_records ${where}`).get(...params) as { n: number };
    return row.n;
  }

  async allIds(): Promise<string[]> {
    this.assertOpen();
    const rows = this.db.prepare('SELECT id FROM verbatim_records ORDER BY created_at ASC').all() as { id: string }[];
    return rows.map((r) => r.id);
  }

  async countEmbedded(): Promise<number> {
    this.assertOpen();
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM verbatim_records WHERE embedding IS NOT NULL AND embedding != ?',
    ).get('') as { n: number };
    return row.n;
  }

  /** Xoá toàn bộ record (dùng cho test / reset có xác nhận ở tầng trên). */
  async clear(): Promise<void> {
    this.assertOpen();
    this.db.exec('DELETE FROM verbatim_records;');
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}

/** Dựng mệnh đề WHERE từ filter (tham số hoá, không nối chuỗi user input). */
function buildWhere(filter: VerbatimFilter): { where: string; params: SQLInputValue[] } {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  const eq = (column: string, value: string | undefined): void => {
    if (value !== undefined) {
      clauses.push(`${column} = ?`);
      params.push(value);
    }
  };
  eq('wing', filter.wing);
  eq('room', filter.room);
  eq('drawer', filter.drawer);
  eq('source', filter.source);
  eq('bot_id', filter.botId);
  eq('user_id', filter.userId);
  eq('session_id', filter.sessionId);
  if (filter.tags !== undefined && filter.tags.length > 0) {
    // Tags lưu dạng JSON array — khớp bằng LIKE trên từng tag đã quote.
    // Đơn giản và đủ cho local store (tag là chuỗi đã chuẩn hoá, không
    // chứa dấu '"' hay '\').
    const tagClauses = filter.tags.map(() => 'tags LIKE ?');
    clauses.push(`(${tagClauses.join(' OR ')})`);
    for (const tag of filter.tags) params.push(`%"${tag.replace(/["\\]/g, '')}"%`);
  }
  if (filter.from !== undefined) {
    clauses.push('created_at >= ?');
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    clauses.push('created_at <= ?');
    params.push(filter.to);
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}
