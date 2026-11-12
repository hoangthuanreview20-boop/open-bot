/**
 * Fleet audit + decision log (đội D).
 *
 * Hai log JSONL nối chuỗi hash SHA-256 trong thư mục gốc của fleet:
 * - `fleet.jsonl`: audit mọi thay đổi của fleet (tạo/xoá workspace,
 *   start/stop service, thành viên, vai trò...).
 * - `decisions.jsonl`: quyết định cho phép/cấm (ai cho phép cái gì,
 *   khi nào, vì sao) — kể cả quyết định TỪ CHỐI (vd tạo workspace
 *   nhưng máy không đủ sức chứa).
 *
 * Tái dùng hàm băm + validate của team/audit (computeAuditHash,
 * validateAuditEvent) — chỉ khác tên file. Giới hạn thật như team
 * audit: log LOCAL cho máy tin cậy, chuỗi hash phát hiện hỏng/sửa
 * lén không tính lại hash, KHÔNG chống được người có quyền sửa file
 * tính lại chuỗi; giả định một writer duy nhất (main process).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AUDIT_GENESIS_PREV_HASH,
  computeAuditHash,
  validateAuditEvent,
  type AuditEvent,
  type AuditVerifyResult,
  type NewAuditEventInput,
} from '../team/audit';
import type { FleetDecision, NewFleetDecisionInput } from './types';

export const FLEET_AUDIT_FILE = 'fleet.jsonl';
export const FLEET_DECISIONS_FILE = 'decisions.jsonl';

// ---------------------------------------------------------------------------
// Hàm chung cho log JSONL nối chuỗi hash (dùng cho cả 2 file)
// ---------------------------------------------------------------------------

function logPath(rootDir: string, file: string): string {
  if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
    throw new Error('fleet log cần rootDir không rỗng.');
  }
  return path.join(rootDir, file);
}

function readChainedEvents(rootDir: string, file: string): AuditEvent[] {
  const filePath = logPath(rootDir, file);
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
      throw new Error(`${file} hỏng ở dòng ${i + 1}: không phải JSON hợp lệ.`);
    }
    try {
      events.push(validateAuditEvent(parsed));
    } catch (err) {
      throw new Error(`${file} hỏng ở dòng ${i + 1}: ${(err as Error).message}`);
    }
  }
  return events;
}

function appendChainedEvent(rootDir: string, file: string, input: NewAuditEventInput): AuditEvent {
  if (typeof input.actor !== 'string' || input.actor.trim().length === 0) {
    throw new Error('fleet log cần actor không rỗng.');
  }
  if (typeof input.action !== 'string' || input.action.trim().length === 0) {
    throw new Error('fleet log cần action không rỗng.');
  }
  if (typeof input.target !== 'string' || input.target.trim().length === 0) {
    throw new Error('fleet log cần target không rỗng.');
  }
  const filePath = logPath(rootDir, file);
  const existing = readChainedEvents(rootDir, file);
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

function verifyChainedLog(rootDir: string, file: string): AuditVerifyResult {
  const events = readChainedEvents(rootDir, file);
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

// ---------------------------------------------------------------------------
// Fleet audit log (fleet.jsonl)
// ---------------------------------------------------------------------------

export function getFleetAuditPath(rootDir: string): string {
  return logPath(rootDir, FLEET_AUDIT_FILE);
}

export function readFleetAuditEvents(rootDir: string): AuditEvent[] {
  return readChainedEvents(rootDir, FLEET_AUDIT_FILE);
}

/** Ghi một event audit fleet. Không bao giờ ghi secret vào detail. */
export function appendFleetAuditEvent(rootDir: string, input: NewAuditEventInput): AuditEvent {
  return appendChainedEvent(rootDir, FLEET_AUDIT_FILE, input);
}

export function verifyFleetAuditLog(rootDir: string): AuditVerifyResult {
  return verifyChainedLog(rootDir, FLEET_AUDIT_FILE);
}

export function listFleetAuditEvents(
  rootDir: string,
  filter: { actor?: string; action?: string; target?: string; since?: number; until?: number } = {},
): AuditEvent[] {
  return readFleetAuditEvents(rootDir).filter((event) => {
    if (filter.actor !== undefined && event.actor !== filter.actor) return false;
    if (filter.action !== undefined && event.action !== filter.action) return false;
    if (filter.target !== undefined && event.target !== filter.target) return false;
    if (filter.since !== undefined && event.at < filter.since) return false;
    if (filter.until !== undefined && event.at > filter.until) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Decision log (decisions.jsonl) — cùng chuỗi hash, thêm decision/reason
// ---------------------------------------------------------------------------

export function getFleetDecisionsPath(rootDir: string): string {
  return logPath(rootDir, FLEET_DECISIONS_FILE);
}

function validateFleetDecision(raw: unknown): FleetDecision {
  const event = validateAuditEvent(raw);
  // decision/reason nằm trong detail để chuỗi hash bao phủ (sửa decision
  // mà không tính lại hash sẽ làm verify thất bại).
  const detail = event.detail ?? {};
  if (detail.decision !== 'allow' && detail.decision !== 'deny') {
    throw new Error("fleet decision phải là 'allow' hoặc 'deny' (trong detail).");
  }
  if (detail.reason !== undefined && typeof detail.reason !== 'string') {
    throw new Error('fleet decision reason (khi có) phải là chuỗi.');
  }
  return {
    ...event,
    decision: detail.decision as 'allow' | 'deny',
    ...(typeof detail.reason === 'string' ? { reason: detail.reason } : {}),
  };
}

export function readFleetDecisions(rootDir: string): FleetDecision[] {
  const filePath = logPath(rootDir, FLEET_DECISIONS_FILE);
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  const decisions: FleetDecision[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`${FLEET_DECISIONS_FILE} hỏng ở dòng ${i + 1}: không phải JSON hợp lệ.`);
    }
    try {
      decisions.push(validateFleetDecision(parsed));
    } catch (err) {
      throw new Error(`${FLEET_DECISIONS_FILE} hỏng ở dòng ${i + 1}: ${(err as Error).message}`);
    }
  }
  return decisions;
}

/** Ghi một quyết định (allow/deny) vào decision log. */
export function appendFleetDecision(rootDir: string, input: NewFleetDecisionInput): FleetDecision {
  if (typeof input.actor !== 'string' || input.actor.trim().length === 0) {
    throw new Error('fleet decision cần actor không rỗng.');
  }
  if (typeof input.action !== 'string' || input.action.trim().length === 0) {
    throw new Error('fleet decision cần action không rỗng.');
  }
  if (typeof input.target !== 'string' || input.target.trim().length === 0) {
    throw new Error('fleet decision cần target không rỗng.');
  }
  if (input.decision !== 'allow' && input.decision !== 'deny') {
    throw new Error("fleet decision phải là 'allow' hoặc 'deny'.");
  }
  const event = appendChainedEvent(rootDir, FLEET_DECISIONS_FILE, {
    actor: input.actor,
    action: input.action,
    target: input.target,
    detail: {
      ...(input.detail ?? {}),
      decision: input.decision,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    },
  });
  return {
    ...event,
    decision: input.decision,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  };
}

export function verifyFleetDecisionLog(rootDir: string): AuditVerifyResult {
  return verifyChainedLog(rootDir, FLEET_DECISIONS_FILE);
}

export function listFleetDecisions(
  rootDir: string,
  filter: { actor?: string; action?: string; target?: string; decision?: 'allow' | 'deny'; since?: number; until?: number } = {},
): FleetDecision[] {
  return readFleetDecisions(rootDir).filter((d) => {
    if (filter.actor !== undefined && d.actor !== filter.actor) return false;
    if (filter.action !== undefined && d.action !== filter.action) return false;
    if (filter.target !== undefined && d.target !== filter.target) return false;
    if (filter.decision !== undefined && d.decision !== filter.decision) return false;
    if (filter.since !== undefined && d.at < filter.since) return false;
    if (filter.until !== undefined && d.at > filter.until) return false;
    return true;
  });
}
