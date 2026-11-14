/**
 * RunLogStore — append-only JSONL store cho run log (v1.01, Đội T1).
 *
 * Bố cục đĩa (trong `logDir`, mặc định `<userDataDir>/run-logs/`):
 * - Một file cho một run: `<runId-an-toàn>.jsonl` (1 dòng = 1 event JSON).
 * - File xoay: khi file vượt `maxFileBytes`, đổi tên thành
 *   `<runId>.<yyyyMMdd-HHmmss-ms>.jsonl` rồi ghi file mới tiếp tục seq
 *   (seq KHÔNG reset — chuỗi hash vẫn liên tục qua các file xoay).
 * - File xoay cũ nhất bị cắt khi tổng dung lượng của run vượt
 *   `maxTotalBytes` (giữ lại ít nhất file hiện tại).
 *
 * Tính chất:
 * - Append-only: chỉ `append` thêm dòng mới ở cuối, không bao giờ sửa
 *   dòng cũ. Mỗi lần append ghi xong đều `fsync` để event không mất
 *   khi process chết (đắt hơn một chút nhưng log là audit trail).
 * - Hash chain: `append` tự điền `seq` (tiếp nối), `prevHash` (hash
 *   event cuối), `hash` (SHA-256). `verify` tính lại toàn bộ chuỗi.
 * - Đọc: `readRun` đọc toàn bộ event của run (gộp cả file xoay theo
 *   thứ tự thời gian tạo), `queryRun` lọc theo type/seq/thời gian +
 *   phân trang, `listRuns` quét metadata mọi run.
 * - Không throw vì log hỏng một phần: `readRun` bỏ qua dòng JSON hỏng
 *   và báo qua `corruptLines`; `verify` báo seq đầu tiên đứt chuỗi.
 *   Một file log hỏng không được làm hỏng cả store.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { GENESIS_PREV_HASH, hashRunEvent, verifyEventHash } from './canonical';
import { sanitizeRunLogPayload } from './sanitize';
import type {
  AnyRunEvent,
  NewRunEvent,
  RunEventQuery,
  RunEventType,
  RunLogMeta,
  RunLogVerification,
  RunStatus,
} from './types';

export interface RunLogStoreOptions {
  /** Thư mục chứa các file `.jsonl` của run. Bắt buộc. */
  logDir: string;
  /** Xoay file khi vượt số byte này (mặc định 8 MiB). */
  maxFileBytes?: number;
  /** Cắt file xoay cũ khi tổng dung lượng của run vượt số byte này (mặc định 64 MiB). */
  maxTotalBytes?: number;
  /** Ghi đè `at` khi append — chủ yếu cho test determinism. */
  now?: () => string;
}

/** Kết quả đọc một run (kèm dòng hỏng nếu có). */
export interface ReadRunResult {
  runId: string;
  events: AnyRunEvent[];
  /** Số dòng JSON hỏng đã bỏ qua (0 khi log sạch). */
  corruptLines: number;
  /** Số dòng không phải event hợp lệ (thiếu field bắt buộc). */
  invalidLines: number;
}

/** Tên file an toàn cho một runId (tránh path traversal). */
export function safeRunFileName(runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'run';
  return `${safe}.jsonl`;
}

/** Prefix file xoay của một run: `<safe>.` + timestamp. */
function rotatedPrefix(runId: string): string {
  return `${safeRunFileName(runId).replace(/\.jsonl$/, '')}.`;
}

function isRunEventObject(value: unknown): value is AnyRunEvent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['seq'] === 'number' &&
    typeof v['runId'] === 'string' &&
    typeof v['at'] === 'string' &&
    typeof v['type'] === 'string' &&
    typeof v['payload'] === 'object' &&
    v['payload'] !== null &&
    typeof v['prevHash'] === 'string' &&
    typeof v['hash'] === 'string'
  );
}

/** Stamp xoay file: `yyyyMMdd-HHmmss-ms` (sắp xếp theo tên = theo thời gian). */
function rotationStamp(now: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${p(now.getMilliseconds(), 3)}`
  );
}

export class RunLogStore {
  private readonly logDir: string;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly now: () => string;
  /** Cache trạng thái cuối mỗi run (seq + hash cuối) để append không phải đọc lại file. */
  private readonly tails = new Map<string, { seq: number; hash: string }>();
  /** Bộ đếm xoay file (đảm bảo tên file xoay duy nhất dù cùng mili-giây). */
  private rotationCounter = 0;

  constructor(options: RunLogStoreOptions) {
    this.logDir = options.logDir;
    this.maxFileBytes = options.maxFileBytes ?? 8 * 1024 * 1024;
    this.maxTotalBytes = options.maxTotalBytes ?? 64 * 1024 * 1024;
    this.now = options.now ?? (() => new Date().toISOString());
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  /** Đường dẫn file hiện tại của run. */
  runFilePath(runId: string): string {
    return path.join(this.logDir, safeRunFileName(runId));
  }

  /** Mọi file thuộc về run (file hiện tại + file xoay), theo thứ tự tạo. */
  runFiles(runId: string): string[] {
    const prefix = rotatedPrefix(runId);
    const current = safeRunFileName(runId);
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.logDir);
    } catch {
      return [];
    }
    const rotated = names
      .filter((n) => n !== current && n.startsWith(prefix) && n.endsWith('.jsonl'))
      .sort();
    const files = rotated.map((n) => path.join(this.logDir, n));
    if (names.includes(current)) files.push(path.join(this.logDir, current));
    return files;
  }

  /**
   * Append một event vào run. Tự điền `seq`, `prevHash`, `hash` và
   * sanitize payload trước khi ghi. Ghi xong thì fsync. Trả về event
   * đã ghi (đầy đủ seq/hash).
   *
   * Append KHÔNG BAO GIỜ throw vì payload xấu (sanitize đã xử lý);
   * chỉ throw khi đĩa lỗi — caller (recorder/loop) phải tự nuốt lỗi
   * này để run không hỏng vì log (xem `recorder.ts`).
   */
  append<T extends RunEventType>(runId: string, event: NewRunEvent<T>): AnyRunEvent {
    const tail = this.tailOf(runId);
    const at = event.at ?? this.now();
    const seq = tail.seq + 1;
    const prevHash = tail.seq === 0 ? GENESIS_PREV_HASH : tail.hash;
    const payload = sanitizeRunLogPayload(
      event.payload as unknown as Record<string, unknown>,
    ) as unknown as AnyRunEvent['payload'];
    const hash = hashRunEvent({
      seq,
      runId,
      at,
      type: event.type,
      payload,
      prevHash,
    });
    const full: AnyRunEvent = {
      seq,
      runId,
      at,
      type: event.type,
      payload,
      prevHash,
      hash,
    } as AnyRunEvent;
    this.rotateIfNeeded(runId);
    const line = `${JSON.stringify(full)}\n`;
    const file = this.runFilePath(runId);
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.tails.set(runId, { seq, hash });
    return full;
  }

  /**
   * Append nhiều event một lúc (dùng khi fork sao chép prefix).
   * Mỗi event được ghi với seq/hash MỚI của run đích — fork không
   * sao chép nguyên hash cũ (vì runId khác nhau, hash phải tính
   * lại), nhưng giữ nguyên `at` + `type` + `payload` gốc.
   */
  appendMany(runId: string, events: ReadonlyArray<{ type: RunEventType; payload: unknown; at: string }>): AnyRunEvent[] {
    const out: AnyRunEvent[] = [];
    for (const e of events) {
      out.push(
        this.append(runId, {
          type: e.type,
          payload: e.payload as AnyRunEvent['payload'],
          at: e.at,
        } as NewRunEvent),
      );
    }
    return out;
  }

  /** Đọc toàn bộ event của run (gộp file xoay, theo seq tăng dần). */
  readRun(runId: string): ReadRunResult {
    const events: AnyRunEvent[] = [];
    let corruptLines = 0;
    let invalidLines = 0;
    for (const file of this.runFiles(runId)) {
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          corruptLines += 1;
          continue;
        }
        if (!isRunEventObject(parsed)) {
          invalidLines += 1;
          continue;
        }
        events.push(parsed);
      }
    }
    // File xoay + file hiện tại đã theo thứ tự tạo, nhưng sort lại
    // theo seq để chắc chắn (seq là thứ tự chuẩn của log).
    events.sort((a, b) => a.seq - b.seq);
    return { runId, events, corruptLines, invalidLines };
  }

  /** Đọc + lọc event của run theo query (kèm tổng số sau lọc, trước phân trang). */
  queryRun(runId: string, query: RunEventQuery = {}): { events: AnyRunEvent[]; total: number; corruptLines: number } {
    const { events, corruptLines } = this.readRun(runId);
    let filtered = events;
    if (query.types !== undefined && query.types.length > 0) {
      const wanted = new Set(query.types);
      filtered = filtered.filter((e) => wanted.has(e.type));
    }
    if (query.fromSeq !== undefined) filtered = filtered.filter((e) => e.seq >= query.fromSeq!);
    if (query.toSeq !== undefined) filtered = filtered.filter((e) => e.seq <= query.toSeq!);
    if (query.fromAt !== undefined) filtered = filtered.filter((e) => e.at >= query.fromAt!);
    if (query.toAt !== undefined) filtered = filtered.filter((e) => e.at <= query.toAt!);
    const total = filtered.length;
    const offset = query.offset ?? 0;
    const limit = query.limit;
    if (offset > 0) filtered = filtered.slice(offset);
    if (limit !== undefined) filtered = filtered.slice(0, limit);
    return { events: filtered, total, corruptLines };
  }

  /**
   * Kiểm chứng hash chain + seq liên tục của một run.
   * - seq phải là 1, 2, 3, … không lỗ hổng.
   * - `prevHash` của event N phải bằng `hash` của event N-1 ('' ở event đầu).
   * - `hash` tính lại phải khớp `hash` đã lưu.
   */
  verify(runId: string): RunLogVerification {
    const { events } = this.readRun(runId);
    let expectedPrev = GENESIS_PREV_HASH;
    for (let i = 0; i < events.length; i += 1) {
      const e = events[i]!;
      if (e.seq !== i + 1) {
        return {
          runId,
          ok: false,
          eventCount: events.length,
          firstBadSeq: e.seq,
          reason: `seq đứt: mong đợi ${i + 1}, gặp ${e.seq}`,
        };
      }
      if (e.prevHash !== expectedPrev) {
        return {
          runId,
          ok: false,
          eventCount: events.length,
          firstBadSeq: e.seq,
          reason: `prevHash đứt tại seq ${e.seq}`,
        };
      }
      if (!verifyEventHash(e)) {
        return {
          runId,
          ok: false,
          eventCount: events.length,
          firstBadSeq: e.seq,
          reason: `hash không khớp tại seq ${e.seq} (payload đã bị sửa)`,
        };
      }
      expectedPrev = e.hash;
    }
    return { runId, ok: true, eventCount: events.length };
  }

  /** true khi run có ít nhất một event. */
  exists(runId: string): boolean {
    return this.runFiles(runId).length > 0;
  }

  /** Metadata tóm tắt của một run (đọc từ log của nó). */
  meta(runId: string): RunLogMeta | null {
    const { events } = this.readRun(runId);
    if (events.length === 0) return null;
    const started = events.find((e) => e.type === 'run.started');
    const ended = [...events]
      .reverse()
      .find((e) => e.type === 'run.completed' || e.type === 'run.failed' || e.type === 'run.aborted');
    let status: RunStatus = 'running';
    if (ended) {
      status = ended.type === 'run.completed' ? 'completed' : ended.type === 'run.failed' ? 'failed' : 'aborted';
    } else {
      // Run chưa kết thúc: paused khi event pause/resume gần nhất là pause.
      const lastPauseResume = [...events]
        .reverse()
        .find((e) => e.type === 'run.paused' || e.type === 'run.resumed');
      if (lastPauseResume?.type === 'run.paused') status = 'paused';
    }
    const startedPayload = (started?.payload ?? {}) as { botId?: string; title?: string; parentRunId?: string };
    const toolCalls = events.filter((e) => e.type === 'tool.call').length;
    const fileChanges = events.filter((e) => e.type === 'file.change').length;
    const errors =
      events.filter((e) => e.type === 'compile.error' || e.type === 'run.failed').length +
      events.filter((e) => e.type === 'tool.result' && (e.payload as { status?: string }).status === 'error').length;
    const meta: RunLogMeta = {
      runId,
      botId: startedPayload.botId ?? '',
      status,
      startedAt: events[0]!.at,
      eventCount: events.length,
      lastSeq: events[events.length - 1]!.seq,
      toolCalls,
      fileChanges,
      errors,
    };
    if (startedPayload.title !== undefined) meta.title = startedPayload.title;
    if (startedPayload.parentRunId !== undefined) meta.parentRunId = startedPayload.parentRunId;
    if (ended !== undefined) meta.endedAt = ended.at;
    return meta;
  }

  /** Metadata của mọi run trong store, mới nhất trước. */
  listRuns(): RunLogMeta[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.logDir);
    } catch {
      return [];
    }
    const runIds = new Set<string>();
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      // File hiện tại: `<runId>.jsonl`; file xoay: `<runId>.<stamp>.jsonl`.
      // Tách runId bằng cách bỏ đuôi `.jsonl` rồi bỏ phần stamp xoay
      // (stamp có dạng `yyyymmdd-hhmmss-ms` ở cuối, sau dấu `.`).
      const base = name.slice(0, -'.jsonl'.length);
      const stampMatch = /\.\d{8}-\d{6}-\d{3}(-\d+)?$/.exec(base);
      const runId = stampMatch ? base.slice(0, stampMatch.index) : base;
      if (runId.length > 0) runIds.add(runId);
    }
    const metas: RunLogMeta[] = [];
    for (const runId of runIds) {
      const m = this.meta(runId);
      if (m !== null) metas.push(m);
    }
    metas.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
    return metas;
  }

  /**
   * Export toàn bộ event của run ra JSONL (một event một dòng, đúng
   * như file log). Trả về chuỗi — caller tự ghi file/download.
   */
  exportJsonl(runId: string): string {
    const { events } = this.readRun(runId);
    return events.map((e) => JSON.stringify(e)).join('\n') + (events.length > 0 ? '\n' : '');
  }

  /** Xoá toàn bộ log của một run (cả file xoay). Dùng cho test/dọn dẹp. */
  deleteRun(runId: string): void {
    for (const file of this.runFiles(runId)) {
      try {
        fs.unlinkSync(file);
      } catch {
        // File biến mất giữa chừng — bỏ qua.
      }
    }
    this.tails.delete(runId);
  }

  /** Seq + hash cuối của run (đọc file khi chưa cache). */
  private tailOf(runId: string): { seq: number; hash: string } {
    const cached = this.tails.get(runId);
    if (cached !== undefined) return cached;
    const { events } = this.readRun(runId);
    const tail =
      events.length === 0 ? { seq: 0, hash: GENESIS_PREV_HASH } : { seq: events[events.length - 1]!.seq, hash: events[events.length - 1]!.hash };
    this.tails.set(runId, tail);
    return tail;
  }

  /** Xoay file khi file hiện tại đã quá lớn; cắt file xoay cũ nhất khi tổng quá lớn. */
  private rotateIfNeeded(runId: string): void {
    const file = this.runFilePath(runId);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // Chưa có file — không cần xoay.
    }
    if (size < this.maxFileBytes) return;
    const stamp = `${rotationStamp(new Date())}-${this.rotationCounter++}`;
    const rotated = path.join(this.logDir, `${rotatedPrefix(runId)}${stamp}.jsonl`);
    try {
      fs.renameSync(file, rotated);
    } catch {
      return;
    }
    // Cắt file xoay cũ nhất khi tổng dung lượng của run vượt giới hạn.
    const files = this.runFiles(runId);
    let total = 0;
    const sizes: Array<{ file: string; size: number }> = [];
    for (const f of files) {
      try {
        const s = fs.statSync(f).size;
        sizes.push({ file: f, size: s });
        total += s;
      } catch {
        // Bỏ qua file đã biến mất.
      }
    }
    // File hiện tại (mới xoay xong, chưa có) không nằm trong danh
    // sách — chỉ cắt file xoay cũ, giữ lại ít nhất file xoay mới nhất.
    const rotatedOnly = sizes.filter((s) => s.file !== file).sort((a, b) => (a.file < b.file ? -1 : 1));
    let idx = 0;
    while (total > this.maxTotalBytes && idx < rotatedOnly.length - 1) {
      try {
        fs.unlinkSync(rotatedOnly[idx]!.file);
        total -= rotatedOnly[idx]!.size;
      } catch {
        // Bỏ qua.
      }
      idx += 1;
    }
  }
}
