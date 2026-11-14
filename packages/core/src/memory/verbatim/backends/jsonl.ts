/**
 * JSONL backend cho verbatim memory (v1.01, Đội T4).
 *
 * Fallback khi SQLite không dùng được (vd runtime không có
 * `node:sqlite`, thư mục chỉ đọc, hoặc user chọn backend file thuần).
 * Một record một dòng JSON trong `<dir>/verbatim.jsonl` — append-only:
 * ghi mới chỉ append, không đọc/ghi lại cả file. Xoá/cập nhật đánh dấu
 * rồi compact (ghi lại file qua temp + rename, mode 0600) — cùng kỹ
 * thuật atomic-write như `LongTermMemory`.
 *
 * Index trong bộ nhớ (Map id → record + Map hash → id) nên list/get/
 * dedup đều O(1) hoặc O(n) scan nhẹ; đủ cho store local vài chục
 * nghìn record. File lớn hơn nên dùng SQLite.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  VerbatimBackend,
  VerbatimFilter,
  VerbatimRecord,
} from '../types';
import { verbatimMatchesFilter } from '../types';

/** Tên file JSONL mặc định trong thư mục dữ liệu. */
export const VERBATIM_JSONL_FILE = 'verbatim.jsonl';

export interface JsonlVerbatimBackendOptions {
  /** Thư mục chứa `verbatim.jsonl` (được tạo nếu chưa có). */
  dir: string;
  /** Tên file (mặc định `verbatim.jsonl`). */
  fileName?: string;
}

export class JsonlVerbatimBackend implements VerbatimBackend {
  readonly kind = 'jsonl';
  private readonly filePath: string;
  private readonly records = new Map<string, VerbatimRecord>();
  private readonly byHash = new Map<string, string>();
  private loaded = false;
  private closed = false;

  constructor(opts: JsonlVerbatimBackendOptions) {
    const dir = path.resolve(opts.dir);
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, opts.fileName ?? VERBATIM_JSONL_FILE);
  }

  /** Đường dẫn file JSONL (để log/debug). */
  get path(): string {
    return this.filePath;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('JsonlVerbatimBackend đã đóng.');
  }

  /** Nạp file vào bộ nhớ (lazy, chỉ một lần; dòng hỏng bị bỏ qua có log). */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!fs.existsSync(this.filePath)) return;
    const content = fs.readFileSync(this.filePath, 'utf8');
    let skipped = 0;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isVerbatimRecordShape(parsed)) {
          this.records.set(parsed.id, parsed);
          this.byHash.set(parsed.hash, parsed.id);
        } else {
          skipped += 1;
        }
      } catch {
        skipped += 1;
      }
    }
    if (skipped > 0) {
      console.error(`[verbatim-jsonl] Bỏ qua ${skipped} dòng hỏng trong ${this.filePath}.`);
    }
  }

  async insert(record: VerbatimRecord): Promise<void> {
    this.assertOpen();
    this.ensureLoaded();
    const existed = this.records.get(record.id);
    this.records.set(record.id, record);
    this.byHash.set(record.hash, record.id);
    if (existed !== undefined && existed.hash !== record.hash) {
      this.byHash.delete(existed.hash);
    }
    // Upsert: ghi đè cần rewrite; insert mới chỉ append. Phân biệt
    // bằng việc record đã tồn tại trước khi set.
    if (existed !== undefined) {
      await this.compact();
    } else {
      fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
      try {
        fs.chmodSync(this.filePath, 0o600);
      } catch {
        // Trên Windows chmod 0600 không có ý nghĩa — bỏ qua.
      }
    }
  }

  async get(id: string): Promise<VerbatimRecord | undefined> {
    this.assertOpen();
    this.ensureLoaded();
    return this.records.get(id);
  }

  /** Tìm record theo hash (phục vụ dedup nhanh). */
  async getByHash(hash: string): Promise<VerbatimRecord | undefined> {
    this.assertOpen();
    this.ensureLoaded();
    const id = this.byHash.get(hash);
    return id === undefined ? undefined : this.records.get(id);
  }

  async list(
    filter: VerbatimFilter,
    opts: { limit: number; offset: number; order: 'newest' | 'oldest' },
  ): Promise<VerbatimRecord[]> {
    this.assertOpen();
    this.ensureLoaded();
    const matched = [...this.records.values()].filter((r) => verbatimMatchesFilter(r, filter));
    matched.sort((a, b) => {
      const cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
      const idCmp = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      return opts.order === 'oldest' ? cmp || idCmp : -cmp || -idCmp;
    });
    return matched.slice(opts.offset, opts.offset + opts.limit);
  }

  async delete(id: string): Promise<boolean> {
    this.assertOpen();
    this.ensureLoaded();
    const existed = this.records.get(id);
    if (existed === undefined) return false;
    this.records.delete(id);
    if (this.byHash.get(existed.hash) === id) this.byHash.delete(existed.hash);
    await this.compact();
    return true;
  }

  async count(filter: VerbatimFilter): Promise<number> {
    this.assertOpen();
    this.ensureLoaded();
    let n = 0;
    for (const record of this.records.values()) {
      if (verbatimMatchesFilter(record, filter)) n += 1;
    }
    return n;
  }

  async allIds(): Promise<string[]> {
    this.assertOpen();
    this.ensureLoaded();
    return [...this.records.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .map((r) => r.id);
  }

  async countEmbedded(): Promise<number> {
    this.assertOpen();
    this.ensureLoaded();
    let n = 0;
    for (const record of this.records.values()) {
      if (record.embedding !== undefined && record.embedding.length > 0) n += 1;
    }
    return n;
  }

  /** Ghi lại toàn bộ file qua temp + rename (atomic trên cùng filesystem). */
  async compact(): Promise<void> {
    this.assertOpen();
    this.ensureLoaded();
    const tmpPath = `${this.filePath}.tmp-${process.pid}`;
    const lines = [...this.records.values()].map((r) => JSON.stringify(r)).join('\n');
    fs.writeFileSync(tmpPath, lines === '' ? '' : `${lines}\n`, 'utf8');
    try {
      fs.chmodSync(tmpPath, 0o600);
    } catch {
      // Windows: bỏ qua.
    }
    fs.renameSync(tmpPath, this.filePath);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** Kiểm tra shape tối thiểu của một record đọc từ JSONL (chống file hỏng). */
function isVerbatimRecordShape(value: unknown): value is VerbatimRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    typeof v['text'] === 'string' &&
    typeof v['source'] === 'string' &&
    typeof v['wing'] === 'string' &&
    typeof v['room'] === 'string' &&
    Array.isArray(v['tags']) &&
    typeof v['botId'] === 'string' &&
    typeof v['createdAt'] === 'string' &&
    typeof v['hash'] === 'string'
  );
}
