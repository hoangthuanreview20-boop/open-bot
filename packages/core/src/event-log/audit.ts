/**
 * Audit trail cho run log (v1.01, Đội T1).
 *
 * Audit là truy vấn XUYÊN run: tìm event theo bot / loại / khoảng
 * thời gian trên toàn bộ store, và kiểm chứng toàn vẹn mọi run.
 * Dùng cho: xem lại "bot này đã làm gì hôm nay", "có bao nhiêu lỗi
 * biên dịch trong tuần", "log có run nào bị sửa không".
 *
 * Audit chỉ đọc — không bao giờ ghi hay sửa log.
 */

import { foldEvents } from './replay';
import type { RunLogStore } from './store';
import type { AnyRunEvent, ReplayedRunState, RunEventType, RunLogMeta, RunLogVerification } from './types';

/** Điều kiện lọc audit xuyên run. */
export interface AuditQuery {
  /** Chỉ các run của bot này (không set = mọi bot). */
  botId?: string;
  /** Chỉ các loại event này (không set = mọi loại). */
  types?: RunEventType[];
  /** Chỉ event từ thời điểm này (ISO, bao gồm). */
  fromAt?: string;
  /** Chỉ event tới thời điểm này (ISO, bao gồm). */
  toAt?: string;
  /** Chỉ các run có trạng thái này. */
  status?: RunLogMeta['status'];
  /** Giới hạn số event trả về (mặc định 500 — audit không đọc vô hạn). */
  limit?: number;
}

/** Một event audit kèm runId/botId của run chứa nó. */
export interface AuditEventEntry {
  runId: string;
  botId: string;
  event: AnyRunEvent;
}

/** Báo cáo toàn vẹn của toàn bộ store. */
export interface AuditIntegrityReport {
  /** Tổng số run đã kiểm. */
  runsChecked: number;
  /** Số run chuỗi hash + seq đều đúng. */
  runsOk: number;
  /** Số run lỗi. */
  runsBad: number;
  /** Chi tiết từng run lỗi. */
  badRuns: RunLogVerification[];
  /** Tổng số event đã kiểm. */
  totalEvents: number;
  /** Tổng số dòng hỏng đã gặp khi đọc (JSON hỏng / event thiếu field). */
  corruptLines: number;
}

/** Tóm tắt audit: đếm theo loại event + theo bot. */
export interface AuditSummary {
  /** Tổng số event khớp query. */
  totalEvents: number;
  /** Số event theo từng loại. */
  byType: Partial<Record<RunEventType, number>>;
  /** Số event theo từng bot. */
  byBot: Record<string, number>;
  /** Số run chạm tới. */
  runsTouched: number;
  /** Khoảng thời gian của các event khớp (ISO). */
  earliestAt?: string;
  latestAt?: string;
}

/**
 * Truy vấn audit xuyên run: duyệt metadata các run (mới nhất
 * trước), đọc event từng run, lọc theo query. Kết quả theo thứ tự
 * thời gian tăng dần (để UI timeline hiển thị đúng).
 */
export function queryAudit(store: RunLogStore, query: AuditQuery = {}): AuditEventEntry[] {
  const limit = query.limit ?? 500;
  const wantedTypes = query.types !== undefined && query.types.length > 0 ? new Set(query.types) : undefined;
  const out: AuditEventEntry[] = [];
  const metas = store.listRuns();
  for (const meta of metas) {
    if (query.botId !== undefined && meta.botId !== query.botId) continue;
    if (query.status !== undefined && meta.status !== query.status) continue;
    // Cắt sớm theo thời gian: run bắt đầu sau toAt thì không chứa
    // event nào trong khoảng (run mới nhất trước nên vẫn phải duyệt
    // tiếp các run cũ hơn).
    if (query.toAt !== undefined && meta.startedAt > query.toAt) continue;
    if (query.fromAt !== undefined && meta.endedAt !== undefined && meta.endedAt < query.fromAt) continue;
    const { events } = store.readRun(meta.runId);
    for (const event of events) {
      if (wantedTypes !== undefined && !wantedTypes.has(event.type)) continue;
      if (query.fromAt !== undefined && event.at < query.fromAt) continue;
      if (query.toAt !== undefined && event.at > query.toAt) continue;
      out.push({ runId: meta.runId, botId: meta.botId, event });
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  out.sort((a, b) => (a.event.at < b.event.at ? -1 : a.event.at > b.event.at ? 1 : a.event.seq - b.event.seq));
  return out;
}

/** Tóm tắt đếm cho một audit query (không trả event chi tiết). */
export function summarizeAudit(store: RunLogStore, query: AuditQuery = {}): AuditSummary {
  const entries = queryAudit(store, { ...query, limit: query.limit ?? 100_000 });
  const byType: Partial<Record<RunEventType, number>> = {};
  const byBot: Record<string, number> = {};
  const runs = new Set<string>();
  let earliestAt: string | undefined;
  let latestAt: string | undefined;
  for (const { runId, botId, event } of entries) {
    byType[event.type] = (byType[event.type] ?? 0) + 1;
    byBot[botId] = (byBot[botId] ?? 0) + 1;
    runs.add(runId);
    if (earliestAt === undefined || event.at < earliestAt) earliestAt = event.at;
    if (latestAt === undefined || event.at > latestAt) latestAt = event.at;
  }
  return {
    totalEvents: entries.length,
    byType,
    byBot,
    runsTouched: runs.size,
    ...(earliestAt !== undefined ? { earliestAt } : {}),
    ...(latestAt !== undefined ? { latestAt } : {}),
  };
}

/**
 * Kiểm chứng toàn vẹn mọi run trong store: hash chain + seq của
 * từng run, kèm số dòng hỏng gặp khi đọc. Chạy được cả khi một vài
 * run hỏng — báo cáo liệt kê từng run lỗi, không throw.
 */
export function verifyAllRuns(store: RunLogStore): AuditIntegrityReport {
  const metas = store.listRuns();
  const badRuns: RunLogVerification[] = [];
  let runsOk = 0;
  let totalEvents = 0;
  let corruptLines = 0;
  for (const meta of metas) {
    const verification = store.verify(meta.runId);
    totalEvents += verification.eventCount;
    const { corruptLines: corrupt, invalidLines } = store.readRun(meta.runId);
    corruptLines += corrupt + invalidLines;
    if (verification.ok) runsOk += 1;
    else badRuns.push(verification);
  }
  return {
    runsChecked: metas.length,
    runsOk,
    runsBad: badRuns.length,
    badRuns,
    totalEvents,
    corruptLines,
  };
}

/**
 * Tái tạo trạng thái của một run từ log của nó (fold). Trả về null
 * khi run không tồn tại / chưa có event nào.
 */
export function replayRunState(store: RunLogStore, runId: string): ReplayedRunState | null {
  const { events } = store.readRun(runId);
  if (events.length === 0) return null;
  return foldEvents(runId, events);
}
