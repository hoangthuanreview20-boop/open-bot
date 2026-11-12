/**
 * Tạo / đọc / render record handoff phiên làm việc (v0.37, P1-3).
 *
 * Module PURE (trừ `randomUUID` + `Date`): không I/O, không provider —
 * dùng được trong coordinator, trong tool `create_handoff` và trong test
 * mà không cần bot thật.
 *
 * Luồng tạo record: validate đầu vào → khử secret mọi chuỗi text →
 * cắt ngắn từng trường về giới hạn (giữ đầu + đánh dấu) → gán id +
 * version + createdAt. Transcript excerpt cắt ngắn kiểu "giữ dòng đầu +
 * dòng cuối" (tái dùng `truncateTranscript` của handoff v0.12).
 */

import { randomUUID } from 'node:crypto';
import { redactBearer, redactSecrets, REDACTED } from '../util/redact';
import { truncateTranscript } from '../agent/handoff';
import type { HandoffMessage } from '../agent/handoff';
import {
  SESSION_HANDOFF_FORMAT_VERSION,
  type AcceptedHandoffConfirmation,
  type SessionHandoffBlocker,
  type SessionHandoffDecision,
  type SessionHandoffMessage,
  type SessionHandoffRecord,
  type SessionHandoffSummary,
  type SessionHandoffWorkStatus,
} from './types';

// ---------------------------------------------------------------------------
// Giới hạn kích thước (không nhét toàn bộ transcript vào record)
// ---------------------------------------------------------------------------

export const MAX_HANDOFF_TITLE_CHARS = 200;
export const MAX_HANDOFF_SUMMARY_CHARS = 2_000;
export const MAX_HANDOFF_STATE_CHARS = 2_000;
export const MAX_HANDOFF_CONTEXT_CHARS = 8_000;
export const MAX_HANDOFF_NEXT_STEP_CHARS = 500;
export const MAX_HANDOFF_LIST_ITEMS = 20;
export const MAX_HANDOFF_LIST_ITEM_CHARS = 500;
export const MAX_HANDOFF_FILES = 30;
export const MAX_HANDOFF_FILE_CHARS = 200;
export const MAX_HANDOFF_DECISIONS = 10;
export const MAX_HANDOFF_BLOCKERS = 10;
export const MAX_SESSION_HANDOFF_TRANSCRIPT_CHARS = 10_000;

export const HANDOFF_WORK_STATUSES: readonly SessionHandoffWorkStatus[] = [
  'in-progress',
  'blocked',
  'waiting-input',
  'done',
] as const;

// ---------------------------------------------------------------------------
// Khử secret — cùng họ với tracing (`tracing/tracer.ts`), nhưng KHÔNG cắt
// ngắn theo MAX_SUMMARY_CHARS (500) của tracer: trường `context` của record
// được phép tới 8.000 ký tự nên khử ở đây rồi mới cắt theo giới hạn riêng.
// ---------------------------------------------------------------------------

/** Dạng key provider (`sk-…`, `xai-…`, `sk-ant-…`) dù không biết giá trị. */
const KNOWN_KEY_SHAPE_RE = /\b(?:sk-ant|sk|xai)-[A-Za-z0-9_-]{8,}\b/g;
/** Dạng `apiKey: <giá trị>` / `token=<giá trị>` trong text tự do. */
const KEY_VALUE_SHAPE_RE =
  /\b(api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|passwd|token)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi;

/**
 * Khử secret trong một chuỗi: secret đã biết (khớp chính xác) + Bearer +
 * dạng key provider + dạng `key: value`. Trả về text đã khử và cờ có
 * khử gì không (để record ghi `redacted: true`).
 */
export function redactHandoffText(
  text: string,
  secrets: string[] = [],
): { text: string; redacted: boolean } {
  if (typeof text !== 'string') return { text: '', redacted: false };
  let out = redactBearer(redactSecrets(text, secrets));
  out = out.replace(KNOWN_KEY_SHAPE_RE, REDACTED);
  out = out.replace(KEY_VALUE_SHAPE_RE, (_m, key: string) => `${key}=${REDACTED}`);
  return { text: out, redacted: out !== text };
}

// ---------------------------------------------------------------------------
// Cắt ngắn
// ---------------------------------------------------------------------------

function truncateField(
  value: string,
  maxChars: number,
): { value: string; truncated: boolean } {
  if (value.length <= maxChars) return { value, truncated: false };
  return {
    value: `${value.slice(0, maxChars)}\n[... đã cắt ngắn còn ${maxChars} ký tự ...]`,
    truncated: true,
  };
}

function cleanStringList(
  items: unknown,
  maxItems: number,
  maxChars: number,
): { items: string[]; truncated: boolean } {
  if (!Array.isArray(items)) return { items: [], truncated: false };
  const out: string[] = [];
  let truncated = items.length > maxItems;
  for (const raw of items.slice(0, maxItems)) {
    if (typeof raw !== 'string') continue;
    const item = raw.trim();
    if (!item) continue;
    const cut = truncateField(item, maxChars);
    if (cut.truncated) truncated = true;
    out.push(cut.value);
  }
  return { items: out, truncated };
}

// ---------------------------------------------------------------------------
// Input tạo record
// ---------------------------------------------------------------------------

export interface CreateSessionHandoffInput {
  /** Bot nguồn (id + tên hiển thị). */
  fromBotId: string;
  fromBotName: string;
  /** Bot đích — trống = bot nào cũng nhận được. */
  toBotId?: string;
  toBotName?: string;
  /** Id run đã tạo ra record (nếu tạo từ trong run). */
  runId?: string;
  /** Tiêu đề ngắn (bắt buộc — không có thì suy ra từ taskSummary). */
  title?: string;
  /** Trạng thái công việc lúc bàn giao; mặc định 'in-progress'. */
  workStatus?: SessionHandoffWorkStatus;
  taskSummary?: string;
  currentState?: string;
  completed?: string[];
  remaining?: string[];
  nextStep?: string;
  filesChanged?: string[];
  filesRelevant?: string[];
  decisions?: Array<string | SessionHandoffDecision>;
  blockers?: Array<string | SessionHandoffBlocker>;
  context?: string;
  /** Đoạn transcript muốn mang theo (mặc định rỗng — caller tự lấy từ lịch sử bot). */
  transcriptExcerpt?: SessionHandoffMessage[];
  /** Id record trước trong cùng chuỗi (nối tiếp handoff cũ). */
  previousHandoffId?: string;
  /** Id các record trước trong chuỗi (cũ nhất trước). */
  chain?: string[];
}

export interface CreateSessionHandoffOptions {
  /** Secret đã biết (vd API key của bot) — khử khớp chính xác thêm. */
  secrets?: string[];
  /** Id cố định (mặc định sinh uuid) — test dùng để kiểm tra ổn định. */
  id?: string;
  /** Thời điểm tạo cố định (mặc định `new Date()`). */
  createdAt?: string;
}

function isWorkStatus(value: unknown): value is SessionHandoffWorkStatus {
  return (
    typeof value === 'string' &&
    (HANDOFF_WORK_STATUSES as readonly string[]).includes(value)
  );
}

function asDecision(raw: string | SessionHandoffDecision): SessionHandoffDecision | null {
  if (typeof raw === 'string') {
    const decision = raw.trim();
    return decision ? { decision } : null;
  }
  if (raw && typeof raw === 'object' && typeof raw.decision === 'string') {
    const decision = raw.decision.trim();
    if (!decision) return null;
    const reason =
      typeof raw.reason === 'string' && raw.reason.trim() !== ''
        ? raw.reason.trim()
        : undefined;
    return reason ? { decision, reason } : { decision };
  }
  return null;
}

function asBlocker(raw: string | SessionHandoffBlocker): SessionHandoffBlocker | null {
  if (typeof raw === 'string') {
    const description = raw.trim();
    return description ? { description } : null;
  }
  if (raw && typeof raw === 'object' && typeof raw.description === 'string') {
    const description = raw.description.trim();
    if (!description) return null;
    const attempted =
      typeof raw.attempted === 'string' && raw.attempted.trim() !== ''
        ? raw.attempted.trim()
        : undefined;
    return attempted ? { description, attempted } : { description };
  }
  return null;
}

/**
 * Tạo một record handoff mới (đã khử secret + cắt ngắn + gán id/version).
 * Ném lỗi rõ khi: fromBotId/fromBotName rỗng, toBot trùng fromBot
 * (cả id lẫn tên đều trùng), hoặc không có gì để bàn giao (title +
 * taskSummary + currentState + remaining đều rỗng).
 */
export function createSessionHandoff(
  input: CreateSessionHandoffInput,
  opts: CreateSessionHandoffOptions = {},
): SessionHandoffRecord {
  const fromBotId = (input.fromBotId ?? '').trim();
  const fromBotName = (input.fromBotName ?? '').trim();
  if (!fromBotId) throw new Error('Handoff cần fromBotId (id bot nguồn) không rỗng.');
  if (!fromBotName) throw new Error('Handoff cần fromBotName (tên bot nguồn) không rỗng.');
  const toBotId = typeof input.toBotId === 'string' ? input.toBotId.trim() : '';
  const toBotName = typeof input.toBotName === 'string' ? input.toBotName.trim() : '';
  if (toBotId && toBotId === fromBotId) {
    throw new Error(`Không handoff cho chính mình: fromBotId và toBotId đều là "${fromBotId}".`);
  }
  if (toBotName && toBotName === fromBotName && !toBotId) {
    throw new Error(
      `Không handoff cho chính mình: fromBotName và toBotName đều là "${fromBotName}".`,
    );
  }

  const secrets = opts.secrets ?? [];
  let anyRedacted = false;
  const redact = (text: string): string => {
    const r = redactHandoffText(text, secrets);
    if (r.redacted) anyRedacted = true;
    return r.text;
  };

  const truncatedFields: string[] = [];
  const cut = (
    field: string,
    raw: string,
    maxChars: number,
  ): string => {
    const cleaned = redact(raw.trim());
    const r = truncateField(cleaned, maxChars);
    if (r.truncated) truncatedFields.push(field);
    return r.value;
  };

  const titleRaw = (input.title ?? '').trim();
  const taskSummary = cut('taskSummary', input.taskSummary ?? '', MAX_HANDOFF_SUMMARY_CHARS);
  const currentState = cut('currentState', input.currentState ?? '', MAX_HANDOFF_STATE_CHARS);
  const titleCut = truncateField(
    redact(titleRaw || taskSummary.slice(0, MAX_HANDOFF_TITLE_CHARS) || 'Bàn giao công việc'),
    MAX_HANDOFF_TITLE_CHARS,
  );
  if (titleCut.truncated) truncatedFields.push('title');
  const title = titleCut.value;

  const completed = cleanStringList(input.completed, MAX_HANDOFF_LIST_ITEMS, MAX_HANDOFF_LIST_ITEM_CHARS);
  if (completed.truncated) truncatedFields.push('completed');
  const remaining = cleanStringList(input.remaining, MAX_HANDOFF_LIST_ITEMS, MAX_HANDOFF_LIST_ITEM_CHARS);
  if (remaining.truncated) truncatedFields.push('remaining');
  const filesChanged = cleanStringList(input.filesChanged, MAX_HANDOFF_FILES, MAX_HANDOFF_FILE_CHARS);
  if (filesChanged.truncated) truncatedFields.push('filesChanged');
  const filesRelevant = cleanStringList(input.filesRelevant, MAX_HANDOFF_FILES, MAX_HANDOFF_FILE_CHARS);
  if (filesRelevant.truncated) truncatedFields.push('filesRelevant');

  // completed/remaining/files qua cleanStringList chưa khử secret — khử
  // lại từng mục (redactHandoffText là idempotent nên gọi 2 lần vẫn an toàn).
  const redactList = (items: string[]): string[] =>
    items.map((item) => {
      const r = redactHandoffText(item, secrets);
      if (r.redacted) anyRedacted = true;
      return r.text;
    });

  const nextStep = cut('nextStep', input.nextStep ?? '', MAX_HANDOFF_NEXT_STEP_CHARS);
  const context = cut('context', input.context ?? '', MAX_HANDOFF_CONTEXT_CHARS);

  const decisionsRaw = Array.isArray(input.decisions) ? input.decisions : [];
  const decisions: SessionHandoffDecision[] = [];
  let decisionsTruncated = decisionsRaw.length > MAX_HANDOFF_DECISIONS;
  for (const raw of decisionsRaw.slice(0, MAX_HANDOFF_DECISIONS)) {
    const d = asDecision(raw);
    if (!d) continue;
    const decisionCut = truncateField(redact(d.decision), MAX_HANDOFF_LIST_ITEM_CHARS);
    if (decisionCut.truncated) decisionsTruncated = true;
    const reason =
      d.reason !== undefined
        ? truncateField(redact(d.reason), MAX_HANDOFF_LIST_ITEM_CHARS)
        : undefined;
    if (reason?.truncated) decisionsTruncated = true;
    decisions.push(
      reason ? { decision: decisionCut.value, reason: reason.value } : { decision: decisionCut.value },
    );
  }
  if (decisionsTruncated) truncatedFields.push('decisions');

  const blockersRaw = Array.isArray(input.blockers) ? input.blockers : [];
  const blockers: SessionHandoffBlocker[] = [];
  let blockersTruncated = blockersRaw.length > MAX_HANDOFF_BLOCKERS;
  for (const raw of blockersRaw.slice(0, MAX_HANDOFF_BLOCKERS)) {
    const b = asBlocker(raw);
    if (!b) continue;
    const descCut = truncateField(redact(b.description), MAX_HANDOFF_LIST_ITEM_CHARS);
    if (descCut.truncated) blockersTruncated = true;
    const attempted =
      b.attempted !== undefined
        ? truncateField(redact(b.attempted), MAX_HANDOFF_LIST_ITEM_CHARS)
        : undefined;
    if (attempted?.truncated) blockersTruncated = true;
    blockers.push(
      attempted
        ? { description: descCut.value, attempted: attempted.value }
        : { description: descCut.value },
    );
  }
  if (blockersTruncated) truncatedFields.push('blockers');

  // Transcript excerpt: khử secret từng dòng rồi cắt ngắn kiểu giữ
  // dòng đầu + dòng cuối (truncateTranscript của handoff v0.12).
  const excerptRaw: HandoffMessage[] = (input.transcriptExcerpt ?? [])
    .filter((m) => m && typeof m.content === 'string' && m.content.trim() !== '')
    .map((m) => ({ role: m.role, content: redact(m.content) }));
  const excerpt = truncateTranscript(excerptRaw, MAX_SESSION_HANDOFF_TRANSCRIPT_CHARS);
  const excerptTotal = excerpt.reduce((sum, m) => sum + m.content.length, 0);
  const excerptRawTotal = excerptRaw.reduce((sum, m) => sum + m.content.length, 0);
  if (excerpt.length < excerptRaw.length || excerptTotal < excerptRawTotal) {
    truncatedFields.push('transcriptExcerpt');
  }
  const transcriptExcerpt: SessionHandoffMessage[] = excerpt.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  if (
    title === 'Bàn giao công việc' &&
    taskSummary === '' &&
    currentState === '' &&
    remaining.items.length === 0 &&
    context === ''
  ) {
    throw new Error(
      'Handoff cần ít nhất một nội dung để bàn giao — điền taskSummary, currentState, remaining hoặc context.',
    );
  }

  const chain = Array.isArray(input.chain)
    ? input.chain.filter((c): c is string => typeof c === 'string' && c.trim() !== '')
    : [];
  const previousHandoffId =
    typeof input.previousHandoffId === 'string' && input.previousHandoffId.trim() !== ''
      ? input.previousHandoffId.trim()
      : undefined;
  if (previousHandoffId && !chain.includes(previousHandoffId)) {
    chain.push(previousHandoffId);
  }

  const record: SessionHandoffRecord = {
    version: SESSION_HANDOFF_FORMAT_VERSION,
    id: opts.id ?? randomUUID(),
    title,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    fromBotId,
    fromBotName,
    workStatus: isWorkStatus(input.workStatus) ? input.workStatus : 'in-progress',
    taskSummary,
    currentState,
    completed: redactList(completed.items),
    remaining: redactList(remaining.items),
    nextStep,
    filesChanged: redactList(filesChanged.items),
    filesRelevant: redactList(filesRelevant.items),
    decisions,
    blockers,
    context,
    transcriptExcerpt,
    chain,
    truncated: truncatedFields.length > 0,
    truncatedFields,
    redacted: anyRedacted,
  };
  if (toBotId) record.toBotId = toBotId;
  if (toBotName) record.toBotName = toBotName;
  if (typeof input.runId === 'string' && input.runId.trim() !== '') {
    record.runId = input.runId.trim();
  }
  if (previousHandoffId) record.previousHandoffId = previousHandoffId;
  return record;
}

// ---------------------------------------------------------------------------
// Đọc lại (tương thích ngược) + dạng xem gọn
// ---------------------------------------------------------------------------

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function asDecisions(value: unknown): SessionHandoffDecision[] {
  if (!Array.isArray(value)) return [];
  const out: SessionHandoffDecision[] = [];
  for (const raw of value) {
    const d = asDecision(raw as string | SessionHandoffDecision);
    if (d) out.push(d);
  }
  return out;
}

function asBlockers(value: unknown): SessionHandoffBlocker[] {
  if (!Array.isArray(value)) return [];
  const out: SessionHandoffBlocker[] = [];
  for (const raw of value) {
    const b = asBlocker(raw as string | SessionHandoffBlocker);
    if (b) out.push(b);
  }
  return out;
}

function asTranscript(value: unknown): SessionHandoffMessage[] {
  if (!Array.isArray(value)) return [];
  const roles = new Set(['system', 'user', 'assistant', 'tool']);
  const out: SessionHandoffMessage[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as { role?: unknown; content?: unknown };
    if (typeof m.content !== 'string' || m.content === '') continue;
    out.push({
      role: typeof m.role === 'string' && roles.has(m.role)
        ? (m.role as SessionHandoffMessage['role'])
        : 'user',
      content: m.content,
    });
  }
  return out;
}

/**
 * Đọc một record từ JSON đã lưu (kể cả record cũ thiếu trường):
 * - không phải object / thiếu `fromBotId` → null (không cứu được);
 * - thiếu `version` → 1; thiếu `id`/`createdAt` → sinh mới; thiếu mảng →
 *   []; `workStatus` lạ → 'in-progress'; thiếu `title` → suy ra từ
 *   `taskSummary` hoặc '(không tiêu đề)'.
 * Không ném lỗi với dữ liệu lạ — record hỏng chỉ bị bỏ qua, không làm
 * hỏng cả file (store dựa vào đó).
 */
export function parseSessionHandoffRecord(value: unknown): SessionHandoffRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const fromBotId = typeof v['fromBotId'] === 'string' ? v['fromBotId'].trim() : '';
  if (!fromBotId) return null;
  const fromBotName =
    typeof v['fromBotName'] === 'string' && v['fromBotName'].trim() !== ''
      ? v['fromBotName'].trim()
      : fromBotId;
  const taskSummary = typeof v['taskSummary'] === 'string' ? v['taskSummary'] : '';
  const titleRaw = typeof v['title'] === 'string' ? v['title'].trim() : '';
  const title = titleRaw || taskSummary.slice(0, MAX_HANDOFF_TITLE_CHARS) || '(không tiêu đề)';
  const chain = asStringArray(v['chain']);
  const previousHandoffId =
    typeof v['previousHandoffId'] === 'string' && v['previousHandoffId'].trim() !== ''
      ? v['previousHandoffId'].trim()
      : undefined;
  if (previousHandoffId && !chain.includes(previousHandoffId)) chain.push(previousHandoffId);

  const record: SessionHandoffRecord = {
    version:
      typeof v['version'] === 'number' && Number.isFinite(v['version'])
        ? Math.floor(v['version'])
        : SESSION_HANDOFF_FORMAT_VERSION,
    id:
      typeof v['id'] === 'string' && v['id'].trim() !== '' ? v['id'].trim() : randomUUID(),
    title,
    createdAt:
      typeof v['createdAt'] === 'string' && v['createdAt'].trim() !== ''
        ? v['createdAt'].trim()
        : new Date().toISOString(),
    fromBotId,
    fromBotName,
    workStatus: isWorkStatus(v['workStatus']) ? v['workStatus'] : 'in-progress',
    taskSummary,
    currentState: typeof v['currentState'] === 'string' ? v['currentState'] : '',
    completed: asStringArray(v['completed']),
    remaining: asStringArray(v['remaining']),
    nextStep: typeof v['nextStep'] === 'string' ? v['nextStep'] : '',
    filesChanged: asStringArray(v['filesChanged']),
    filesRelevant: asStringArray(v['filesRelevant']),
    decisions: asDecisions(v['decisions']),
    blockers: asBlockers(v['blockers']),
    context: typeof v['context'] === 'string' ? v['context'] : '',
    transcriptExcerpt: asTranscript(v['transcriptExcerpt']),
    chain,
    truncated: v['truncated'] === true,
    truncatedFields: asStringArray(v['truncatedFields']),
    redacted: v['redacted'] === true,
  };
  if (typeof v['toBotId'] === 'string' && v['toBotId'].trim() !== '') {
    record.toBotId = v['toBotId'].trim();
  }
  if (typeof v['toBotName'] === 'string' && v['toBotName'].trim() !== '') {
    record.toBotName = v['toBotName'].trim();
  }
  if (typeof v['runId'] === 'string' && v['runId'].trim() !== '') {
    record.runId = v['runId'].trim();
  }
  if (previousHandoffId) record.previousHandoffId = previousHandoffId;
  if (typeof v['acceptedByBotId'] === 'string' && v['acceptedByBotId'].trim() !== '') {
    record.acceptedByBotId = v['acceptedByBotId'].trim();
  }
  if (typeof v['acceptedByBotName'] === 'string' && v['acceptedByBotName'].trim() !== '') {
    record.acceptedByBotName = v['acceptedByBotName'].trim();
  }
  if (typeof v['acceptedAt'] === 'string' && v['acceptedAt'].trim() !== '') {
    record.acceptedAt = v['acceptedAt'].trim();
  }
  if (typeof v['acceptedRunId'] === 'string' && v['acceptedRunId'].trim() !== '') {
    record.acceptedRunId = v['acceptedRunId'].trim();
  }
  return record;
}

/** Dạng xem gọn của record (list UI / RPC `listHandoffs`). */
export function sessionHandoffSummary(record: SessionHandoffRecord): SessionHandoffSummary {
  const summary: SessionHandoffSummary = {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    fromBotId: record.fromBotId,
    fromBotName: record.fromBotName,
    workStatus: record.workStatus,
    completedCount: record.completed.length,
    remainingCount: record.remaining.length,
    nextStep: record.nextStep,
    filesChangedCount: record.filesChanged.length,
    filesRelevantCount: record.filesRelevant.length,
    blockersCount: record.blockers.length,
    truncated: record.truncated,
    redacted: record.redacted,
  };
  if (record.toBotId) summary.toBotId = record.toBotId;
  if (record.toBotName) summary.toBotName = record.toBotName;
  if (record.acceptedByBotId) summary.acceptedByBotId = record.acceptedByBotId;
  if (record.acceptedByBotName) summary.acceptedByBotName = record.acceptedByBotName;
  if (record.acceptedAt) summary.acceptedAt = record.acceptedAt;
  return summary;
}

/** Xác nhận nạp record (trả về trong RunResult / RPC `acceptHandoff`). */
export function acceptedHandoffConfirmation(
  record: SessionHandoffRecord,
  acceptedAt: string,
): AcceptedHandoffConfirmation {
  return {
    id: record.id,
    title: record.title,
    fromBotId: record.fromBotId,
    fromBotName: record.fromBotName,
    workStatus: record.workStatus,
    completedCount: record.completed.length,
    remainingCount: record.remaining.length,
    filesChangedCount: record.filesChanged.length,
    truncated: record.truncated,
    redacted: record.redacted,
    acceptedAt,
  };
}

// ---------------------------------------------------------------------------
// Render thành ngữ cảnh cho bot nhận
// ---------------------------------------------------------------------------

/**
 * Render record thành một khối text để chèn vào đầu run của bot nhận
 * (trước tin nhắn của user), để bot nhận tiếp tục công việc mà không hỏi
 * lại những gì đã có. Ghi rõ các trường đã bị cắt ngắn / khử secret để
 * bot nhận biết mà tự kiểm chứng lại khi cần.
 */
export function formatSessionHandoffForPrompt(record: SessionHandoffRecord): string {
  const lines: string[] = [
    `[handoff nhận] Bot "${record.fromBotName}" bàn giao công việc này cho bạn` +
      (record.toBotName ? ` (bot "${record.toBotName}")` : '') +
      ` — record ${record.id} (tạo ${record.createdAt}).`,
    `Tiêu đề: ${record.title}`,
    `Trạng thái công việc lúc bàn giao: ${record.workStatus}.`,
    ``,
    `Công việc: ${record.taskSummary || '(không ghi)'}`,
    `Trạng thái hiện tại: ${record.currentState || '(không ghi)'}`,
    `Bước tiếp theo: ${record.nextStep || '(xem danh sách việc còn lại)'}`,
  ];
  if (record.completed.length > 0) {
    lines.push('', 'Đã xong:');
    for (const item of record.completed) lines.push(`- ${item}`);
  }
  if (record.remaining.length > 0) {
    lines.push('', 'Còn lại (theo thứ tự):');
    for (const item of record.remaining) lines.push(`- ${item}`);
  }
  if (record.filesChanged.length > 0) {
    lines.push('', `File đã đổi: ${record.filesChanged.join(', ')}`);
  }
  if (record.filesRelevant.length > 0) {
    lines.push('', `File liên quan (đọc để tiếp tục): ${record.filesRelevant.join(', ')}`);
  }
  if (record.decisions.length > 0) {
    lines.push('', 'Quyết định đã chốt:');
    for (const d of record.decisions) {
      lines.push(`- ${d.decision}${d.reason ? ` (vì: ${d.reason})` : ''}`);
    }
  }
  if (record.blockers.length > 0) {
    lines.push('', 'Lỗi/blocker đang gặp:');
    for (const b of record.blockers) {
      lines.push(`- ${b.description}${b.attempted ? ` (đã thử: ${b.attempted})` : ''}`);
    }
  }
  if (record.context) {
    lines.push('', 'Ngữ cảnh cần thiết:', record.context);
  }
  if (record.transcriptExcerpt.length > 0) {
    lines.push('', 'Đoạn hội thoại rút gọn:');
    for (const m of record.transcriptExcerpt) {
      lines.push(`- [${m.role}] ${m.content.replace(/\s+/g, ' ').trim()}`);
    }
  }
  if (record.chain.length > 0) {
    lines.push('', `Chuỗi handoff trước: ${record.chain.join(' → ')} → ${record.id}`);
  }
  if (record.truncated) {
    lines.push(
      '',
      `[Lưu ý: một số nội dung đã bị cắt ngắn khi lưu (${record.truncatedFields.join(', ')}) — ` +
        `kiểm chứng lại trong file/code khi cần, đừng đoán phần đã cắt.]`,
    );
  }
  if (record.redacted) {
    lines.push(
      '',
      `[Lưu ý: record này đã khử secret (hiển thị '<redacted>') — đừng hỏi lại secret, ` +
        `lấy từ Vault khi cần.]`,
    );
  }
  lines.push(
    '',
    `Tiếp tục công việc từ bước tiếp theo ở trên, đừng hỏi lại user những gì đã có trong bản bàn giao này.`,
  );
  return lines.join('\n');
}
