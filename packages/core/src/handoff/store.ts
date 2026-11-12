/**
 * SessionHandoffStore — lưu bền record handoff phiên làm việc (v0.37, P1-3).
 *
 * STORAGE CHOICE — một file JSON `<dataDir>/handoffs.json` (path do caller
 * cung cấp; desktop main truyền userData), theo đúng mẫu
 * `AutoApproveRuleStore` (v0.35): record được ghi một lần, đọc cả file,
 * cập nhật hiếm (chỉ `markAccepted`) — JSON đủ dùng, không cần SQLite.
 * Không có filePath thì store chỉ sống trong bộ nhớ tiến trình (mất khi
 * restart) — hành vi này giữ cho test in-process không ghi file lạ.
 *
 * - Ghi atomic (temp file + rename) + mode 0600, giống TraceStore.
 * - Cap `MAX_SESSION_HANDOFFS` (50): lưu thêm thì record cũ nhất bị bỏ.
 * - Đọc chịu lỗi: file hỏng / dòng JSON sai shape → bỏ qua entry đó
 *   (record cũ thiếu trường vẫn đọc được qua `parseSessionHandoffRecord`),
 *   file hỏng hẳn → bắt đầu rỗng + cảnh báo stderr, không crash host.
 * - Không log nội dung record (có thể chứa đường dẫn/thông tin nhạy cảm).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MAX_SESSION_HANDOFFS,
  SESSION_HANDOFF_FORMAT_VERSION,
  SESSION_HANDOFFS_FILE_NAME,
  type SessionHandoffRecord,
  type SessionHandoffSummary,
  type SessionHandoffWorkStatus,
} from './types';
import { parseSessionHandoffRecord, sessionHandoffSummary } from './record';

export interface ListSessionHandoffsFilter {
  fromBotId?: string;
  toBotId?: string;
  workStatus?: SessionHandoffWorkStatus;
  /** Số record tối đa trả về (mới nhất trước). Mặc định tất cả. */
  limit?: number;
}

export interface MarkAcceptedInput {
  botId: string;
  botName: string;
  /** Id run đã nạp record (khi nhận qua tham số run `handoffId`). */
  runId?: string;
  /** Thời điểm nhận cố định (mặc định `new Date()`). */
  acceptedAt?: string;
}

interface StoredFile {
  version: number;
  records: SessionHandoffRecord[];
}

export class SessionHandoffStore {
  private readonly filePath?: string;
  private records: SessionHandoffRecord[] = [];
  private loaded = false;

  constructor(filePath?: string) {
    this.filePath = filePath && filePath.trim() !== '' ? filePath : undefined;
  }

  /** Nạp file vào bộ nhớ (lười — gọi ở lần đọc/ghi đầu tiên). */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.filePath) return;
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      // Chưa có file — store bắt đầu rỗng (bình thường).
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { records?: unknown })?.records)
          ? (parsed as { records: unknown[] }).records
          : null;
      if (!list) {
        process.stderr.write(
          `[handoff] File handoff sai shape, bắt đầu rỗng: ${this.filePath}\n`,
        );
        return;
      }
      const kept: SessionHandoffRecord[] = [];
      for (const item of list) {
        const record = parseSessionHandoffRecord(item);
        if (record) kept.push(record);
      }
      if (kept.length < list.length) {
        process.stderr.write(
          `[handoff] Bỏ qua ${list.length - kept.length} record hỏng trong ${this.filePath}\n`,
        );
      }
      this.records = kept;
    } catch {
      process.stderr.write(
        `[handoff] Không đọc được file handoff (JSON hỏng), bắt đầu rỗng: ${this.filePath}\n`,
      );
      this.records = [];
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    const payload: StoredFile = { version: SESSION_HANDOFF_FORMAT_VERSION, records: this.records };
    const tmp = `${this.filePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      try {
        fs.chmodSync(tmp, 0o600);
      } catch {
        // Mode 0600 là best-effort (vd filesystem không hỗ trợ).
      }
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Bỏ qua lỗi dọn file tạm.
      }
      process.stderr.write(
        `[handoff] Không ghi được file handoff ${this.filePath}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  /** Lưu record (ghi đè khi trùng id); vượt cap thì bỏ record cũ nhất. */
  save(record: SessionHandoffRecord): SessionHandoffRecord {
    this.ensureLoaded();
    const copy = parseSessionHandoffRecord(record);
    if (!copy) throw new Error('Handoff: record không hợp lệ, không lưu được.');
    const idx = this.records.findIndex((r) => r.id === copy.id);
    if (idx >= 0) this.records[idx] = copy;
    else this.records.push(copy);
    while (this.records.length > MAX_SESSION_HANDOFFS) this.records.shift();
    this.persist();
    return { ...copy };
  }

  /** Đọc một record theo id (null khi không có). */
  get(id: string): SessionHandoffRecord | null {
    this.ensureLoaded();
    const found = this.records.find((r) => r.id === id);
    return found ? { ...found } : null;
  }

  /** Liệt kê record (mới nhất trước), kèm lọc theo bot/trạng thái. */
  list(filter: ListSessionHandoffsFilter = {}): SessionHandoffRecord[] {
    this.ensureLoaded();
    let out = [...this.records].reverse();
    if (typeof filter.fromBotId === 'string' && filter.fromBotId !== '') {
      out = out.filter((r) => r.fromBotId === filter.fromBotId);
    }
    if (typeof filter.toBotId === 'string' && filter.toBotId !== '') {
      out = out.filter((r) => r.toBotId === filter.toBotId);
    }
    if (typeof filter.workStatus === 'string') {
      out = out.filter((r) => r.workStatus === filter.workStatus);
    }
    if (typeof filter.limit === 'number' && Number.isFinite(filter.limit)) {
      out = out.slice(0, Math.max(0, Math.floor(filter.limit)));
    }
    return out.map((r) => ({ ...r }));
  }

  /** Dạng xem gọn cho RPC `listHandoffs` (không có transcript). */
  listSummaries(filter: ListSessionHandoffsFilter = {}): SessionHandoffSummary[] {
    return this.list(filter).map((r) => sessionHandoffSummary(r));
  }

  /**
   * Đánh dấu record đã được bot nhận (ghi đè lần nhận mới nhất — nhận
   * lại được phép, vd chạy lại từ cùng record). Trả về record sau khi
   * cập nhật, hoặc null khi không có record với id đó.
   */
  markAccepted(id: string, input: MarkAcceptedInput): SessionHandoffRecord | null {
    this.ensureLoaded();
    const found = this.records.find((r) => r.id === id);
    if (!found) return null;
    found.acceptedByBotId = input.botId;
    found.acceptedByBotName = input.botName;
    found.acceptedAt = input.acceptedAt ?? new Date().toISOString();
    if (typeof input.runId === 'string' && input.runId !== '') {
      found.acceptedRunId = input.runId;
    }
    this.persist();
    return { ...found };
  }

  /** Xoá một record (true khi có record bị xoá). */
  remove(id: string): boolean {
    this.ensureLoaded();
    const idx = this.records.findIndex((r) => r.id === id);
    if (idx < 0) return false;
    this.records.splice(idx, 1);
    this.persist();
    return true;
  }
}
