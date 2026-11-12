/**
 * Team audit log (B-platform M4, LOCAL).
 *
 * Mỗi thay đổi của team (thêm/xoá member, đổi role, share/unshare bot,
 * đổi egress, workspace, service account) được ghi một dòng JSON vào
 * `<baseDir>/audit.jsonl`, nối chuỗi hash SHA-256: mỗi event giữ hash
 * của event trước (`prevHash`), nên một dòng bị sửa/xoá chèn sau đó
 * sẽ làm `verifyAuditLog` thất bại.
 *
 * Giới hạn thật (đừng hiểu lầm):
 *  - Đây là log LOCAL cho một máy tin cậy, KHÔNG phải chống giả mạo
 *    trước người dùng có quyền sửa file: ai sửa được audit.jsonl thì
 *    cũng tính lại được chuỗi hash. Chuỗi hash chỉ phát hiện hỏng
 *    file vô tình, ghi lỗi, hoặc sửa lén không tính lại hash.
 *  - Ghi là append đơn (`fs.appendFileSync`), giả định một writer
 *    duy nhất (main process). Hai process cùng ghi có thể xen dòng.
 *  - Audit ghi SAU khi lưu state (xem TeamStore): nếu ghi audit lỗi,
 *    state đã đổi nhưng event thiếu — method sẽ throw để caller biết.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export const AUDIT_FILE = 'audit.jsonl';
/** prevHash của event đầu tiên trong log. */
export const AUDIT_GENESIS_PREV_HASH = 'GENESIS';

export interface AuditEvent {
  /** Id ổn định, `audit-<uuid>`. */
  id: string;
  /** Số thứ tự, bắt đầu 1, tăng dần 1. */
  seq: number;
  /** Epoch milliseconds khi event được ghi. */
  at: number;
  /** Ai làm: userId, service-account id, hoặc 'system'. */
  actor: string;
  /** Hành động, vd 'member.add', 'bot.share', 'workspace.create'. */
  action: string;
  /** Đối tượng, vd 'member:alice', 'bot:bot-1', 'team'. */
  target: string;
  /** Chi tiết thêm (không chứa secret), vd { role: 'admin' }. */
  detail?: Record<string, unknown>;
  /** Hash của event trước đó, hoặc 'GENESIS' cho event đầu tiên. */
  prevHash: string;
  /** SHA-256 hex của nội dung event (không tính chính `hash`). */
  hash: string;
}

export interface NewAuditEventInput {
  actor: string;
  action: string;
  target: string;
  detail?: Record<string, unknown>;
}

export interface AuditVerifyResult {
  ok: boolean;
  /** Số event đã kiểm tra. */
  checked: number;
  /** Số dòng (1-based) đầu tiên hỏng, khi ok = false. */
  badLine?: number;
  /** Lý do hỏng, khi ok = false. */
  reason?: string;
}

export interface AuditListFilter {
  actor?: string;
  action?: string;
  target?: string;
  /** Chỉ event có at >= since (epoch ms). */
  since?: number;
  /** Chỉ event có at <= until (epoch ms). */
  until?: number;
}

/** JSON chuẩn hoá (key sắp xếp đệ quy) để hash ổn định. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
}

/**
 * SHA-256 hex của nội dung một event (không tính `hash` và `id` —
 * `id` là uuid ngẫu nhiên, không dùng để kiểm tra toàn vẹn).
 * Pure, test trực tiếp được.
 */
export function computeAuditHash(event: {
  seq: number;
  at: number;
  actor: string;
  action: string;
  target: string;
  detail?: Record<string, unknown>;
  prevHash: string;
}): string {
  const payload = canonicalJson({
    seq: event.seq,
    at: event.at,
    actor: event.actor,
    action: event.action,
    target: event.target,
    detail: event.detail ?? {},
    prevHash: event.prevHash,
  });
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function getAuditLogPath(baseDir: string): string {
  if (typeof baseDir !== 'string' || baseDir.trim().length === 0) {
    throw new Error('getAuditLogPath cần baseDir không rỗng.');
  }
  return path.join(baseDir, AUDIT_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate một dòng audit đã parse; sai shape → throw (không echo nội dung). */
export function validateAuditEvent(raw: unknown): AuditEvent {
  if (!isRecord(raw)) throw new Error('audit event phải là object.');
  const { id, seq, at, actor, action, target, detail, prevHash, hash } = raw;
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('audit event cần id không rỗng.');
  }
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
    throw new Error('audit event cần seq là số nguyên >= 1.');
  }
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) {
    throw new Error('audit event cần at là epoch ms > 0.');
  }
  for (const [field, value] of [
    ['actor', actor],
    ['action', action],
    ['target', target],
    ['prevHash', prevHash],
    ['hash', hash],
  ] as const) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`audit event cần ${field} không rỗng.`);
    }
  }
  if (detail !== undefined && !isRecord(detail)) {
    throw new Error('audit event: detail phải là object khi có.');
  }
  return {
    id: id as string,
    seq: seq as number,
    at: at as number,
    actor: actor as string,
    action: action as string,
    target: target as string,
    ...(detail !== undefined ? { detail: detail as Record<string, unknown> } : {}),
    prevHash: prevHash as string,
    hash: hash as string,
  };
}

/**
 * Đọc toàn bộ audit log (theo thứ tự ghi). File chưa có → [].
 * Dòng hỏng → throw kèm số dòng (không echo nội dung dòng).
 */
export function readAuditEvents(baseDir: string): AuditEvent[] {
  const filePath = getAuditLogPath(baseDir);
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  const events: AuditEvent[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`audit log hỏng ở dòng ${i + 1}: không phải JSON hợp lệ.`);
    }
    try {
      events.push(validateAuditEvent(parsed));
    } catch (err) {
      throw new Error(`audit log hỏng ở dòng ${i + 1}: ${(err as Error).message}`);
    }
  }
  return events;
}

/**
 * Ghi một event mới vào cuối log, nối chuỗi hash với event trước đó.
 * Trả về event đã ghi (kèm id/seq/hash). Không bao giờ ghi secret
 * vào detail — caller chịu trách nhiệm chỉ đưa dữ liệu không nhạy cảm.
 */
export function appendAuditEvent(baseDir: string, input: NewAuditEventInput): AuditEvent {
  if (typeof input.actor !== 'string' || input.actor.trim().length === 0) {
    throw new Error('appendAuditEvent cần actor không rỗng.');
  }
  if (typeof input.action !== 'string' || input.action.trim().length === 0) {
    throw new Error('appendAuditEvent cần action không rỗng.');
  }
  if (typeof input.target !== 'string' || input.target.trim().length === 0) {
    throw new Error('appendAuditEvent cần target không rỗng.');
  }
  const filePath = getAuditLogPath(baseDir);
  const existing = readAuditEvents(baseDir);
  const last = existing.length > 0 ? existing[existing.length - 1] : undefined;
  const event: AuditEvent = {
    id: `audit-${randomUUID()}`,
    seq: (last?.seq ?? 0) + 1,
    at: Date.now(),
    actor: input.actor,
    action: input.action,
    target: input.target,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    prevHash: last?.hash ?? AUDIT_GENESIS_PREV_HASH,
    hash: '',
  };
  event.hash = computeAuditHash(event);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf8');
  return event;
}

/**
 * Kiểm tra toàn bộ chuỗi hash + số thứ tự. Trả về event hỏng đầu
 * tiên (nếu có). Log rỗng → { ok: true, checked: 0 }.
 */
export function verifyAuditLog(baseDir: string): AuditVerifyResult {
  const events = readAuditEvents(baseDir);
  let expectedPrev = AUDIT_GENESIS_PREV_HASH;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.seq !== i + 1) {
      return {
        ok: false,
        checked: i,
        badLine: i + 1,
        reason: `seq sai: event thứ ${i + 1} có seq ${event.seq}, cần ${i + 1}.`,
      };
    }
    if (event.prevHash !== expectedPrev) {
      return {
        ok: false,
        checked: i,
        badLine: i + 1,
        reason: `prevHash sai ở event seq ${event.seq}: chuỗi hash bị đứt (dòng bị xoá/chèn?).`,
      };
    }
    if (computeAuditHash(event) !== event.hash) {
      return {
        ok: false,
        checked: i,
        badLine: i + 1,
        reason: `hash sai ở event seq ${event.seq}: nội dung đã bị sửa sau khi ghi.`,
      };
    }
    expectedPrev = event.hash;
  }
  return { ok: true, checked: events.length };
}

/**
 * Liệt kê event theo bộ lọc (theo thứ tự ghi, cũ → mới).
 * Không lọc gì → toàn bộ log.
 */
export function listAuditEvents(baseDir: string, filter: AuditListFilter = {}): AuditEvent[] {
  return readAuditEvents(baseDir).filter((event) => {
    if (filter.actor !== undefined && event.actor !== filter.actor) return false;
    if (filter.action !== undefined && event.action !== filter.action) return false;
    if (filter.target !== undefined && event.target !== filter.target) return false;
    if (filter.since !== undefined && event.at < filter.since) return false;
    if (filter.until !== undefined && event.at > filter.until) return false;
    return true;
  });
}
