/**
 * NDJSON log theo thread (M5) + sanitize payload.
 *
 * Mỗi thread/bot ghi log bền vững: 1 dòng = 1 event JSON
 * `{at, botId, threadId, kind, payload}`. File nằm trong `logDir`:
 * `<threadId-an-toàn>.ndjson`, xoay khi vượt `maxFileBytes` (đổi tên
 * file cũ thành `<file>.<yyyyMMdd-HHmmss-ms>.ndjson` rồi ghi file mới),
 * cắt file xoay cũ nhất khi tổng dung lượng vượt `maxTotalBytes`.
 *
 * KHÔNG GHI SECRET — `sanitizeHarnessPayload` áp allowlist theo kind
 * + redact theo cùng nguyên tắc tracing (tracer.ts): key trông giống
 * secret (token/password/api-key/…) thì thành `'<redacted>'`, chuỗi
 * `Bearer <token>` thì redact token, chuỗi dài cắt ngắn. Text của
 * assistant vẫn được ghi (đã cắt ngắn) vì log này là nhật ký hội
 * thoại của chính user — nhưng nội dung tool-call args CHỈ ghi tên
 * key, không ghi value (value có thể chứa đường dẫn/file nhạy cảm);
 * riêng payload `result.text` cắt ở 2.000 ký tự.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { redactBearer, REDACTED } from '../util/redact';
import type { HarnessEventKind, ThreadLogEntry, ThreadLogPage } from './types';

/** Chuỗi dài nhất được giữ trong log (ký tự). */
export const HARNESS_LOG_STRING_LIMIT = 2000;
/** Số item tối đa giữ trong một mảng payload. */
const ARRAY_LIMIT = 50;
/** Độ sâu tối đa khi sanitize object lồng nhau. */
const DEPTH_LIMIT = 4;

/** Key trông giống secret — value bị thay bằng '<redacted>'. */
const SECRET_KEY_RE = /token|secret|password|passwd|api[-_]?key|auth|credential|bearer|session|private/i;
/** Key là bộ đếm token (số), KHÔNG phải secret — giữ nguyên. */
const TOKEN_COUNT_KEYS = new Set(['inputTokens', 'outputTokens']);

function sanitizeString(value: string): string {
  let out = redactBearer(value);
  // Dạng key đã biết (sk-…/xai-…/sk-ant-…) dù không biết giá trị chính
  // xác — như tracing sanitizeText (tracer.ts).
  out = out.replace(KNOWN_KEY_SHAPE_RE, REDACTED);
  out = out.replace(KEY_VALUE_SHAPE_RE, (_m, key: string) => `${key}=${REDACTED}`);
  const suffix = '…[cắt ngắn]';
  return out.length > HARNESS_LOG_STRING_LIMIT
    ? `${out.slice(0, HARNESS_LOG_STRING_LIMIT - suffix.length)}${suffix}`
    : out;
}

/** Dạng key provider đã biết (`sk-…`, `xai-…`, `sk-ant-…`). */
const KNOWN_KEY_SHAPE_RE = /\b(?:sk-ant|sk|xai)-[A-Za-z0-9_-]{8,}\b/g;
/** `apiKey: <value>` / `token=<value>` / `password: <value>` trong text tự do. */
const KEY_VALUE_SHAPE_RE =
  /\b(api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|passwd|token)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi;

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= DEPTH_LIMIT) return '[lồng quá sâu]';
  if (Array.isArray(value)) {
    return value.slice(0, ARRAY_LIMIT).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!TOKEN_COUNT_KEYS.has(key) && SECRET_KEY_RE.test(key)) {
        out[key] = REDACTED;
        continue;
      }
      out[key] = sanitizeValue(entry, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * Sanitize payload trước khi đưa lên bus / ghi log. Allowlist theo
 * kind: tool_call chỉ giữ tên tool + tên key của args (không value);
 * các kind khác giữ field đã biết, mọi field lạ đều qua sanitize
 * chung (key secret → redacted, chuỗi → cắt ngắn).
 */
export function sanitizeHarnessPayload(
  kind: HarnessEventKind,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (kind === 'tool_call') {
    const out: Record<string, unknown> = {};
    if (typeof payload['callId'] === 'string') out['callId'] = sanitizeString(payload['callId']);
    if (typeof payload['tool'] === 'string') out['tool'] = sanitizeString(payload['tool']);
    if (Array.isArray(payload['argKeys'])) {
      out['argKeys'] = (payload['argKeys'] as unknown[])
        .filter((k) => typeof k === 'string')
        .slice(0, ARRAY_LIMIT);
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    // Key cấp cao nhất cũng kiểm tra secret như key lồng nhau (gọi
    // sanitizeValue(payload) trực tiếp sẽ làm việc này, nhưng ở đây
    // giữ vòng lặp tường minh để tool_call giữ allowlist riêng).
    if (!TOKEN_COUNT_KEYS.has(key) && SECRET_KEY_RE.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = sanitizeValue(value, 0);
  }
  return out;
}

/** Tên file an toàn cho một threadId (tránh path traversal). */
export function safeThreadFileName(threadId: string): string {
  const safe = threadId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'thread';
  return `${safe}.ndjson`;
}

export interface ThreadLogOptions {
  /** Xoay file khi vượt số byte này (mặc định 5 MB). */
  maxFileBytes?: number;
  /** Cắt file xoay cũ nhất khi tổng vượt số byte này (mặc định 50 MB). */
  maxTotalBytes?: number;
  /** Nơi ghi cảnh báo (xoay/prune lỗi). */
  logger?: { warn(message: string): void };
}

export class ThreadLog {
  readonly dir: string;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private readonly warn: (message: string) => void;
  /** Bộ đếm để tên file xoay không bao giờ trùng (xoay 2 lần trong cùng 1ms). */
  private rotateCounter = 0;

  constructor(dir: string, options: ThreadLogOptions = {}) {
    this.dir = dir;
    this.maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
    this.maxTotalBytes = options.maxTotalBytes ?? 50 * 1024 * 1024;
    this.warn = options.logger
      ? (message: string) => options.logger?.warn(message)
      : () => undefined;
  }

  /** Ghi một entry (đồng bộ, best-effort — lỗi ghi không throw). */
  append(entry: ThreadLogEntry): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, safeThreadFileName(entry.threadId));
      this.rotateIfNeeded(file);
      const line = `${JSON.stringify({
        at: entry.at,
        botId: entry.botId,
        threadId: entry.threadId,
        kind: entry.kind,
        payload: sanitizeHarnessPayload(entry.kind, entry.payload),
        // v0.90e (Đội G): giữ cờ silent để SSE replay lọc được (absent
        // = run thường; entry cũ không có field này vẫn đọc bình thường).
        ...(entry.silent ? { silent: true as const } : {}),
      })}\n`;
      fs.appendFileSync(file, line, 'utf8');
    } catch (err) {
      this.warn(`harness log: không ghi được entry cho thread ${entry.threadId}: ${(err as Error).message}`);
    }
  }

  /** Xoay file khi đã vượt `maxFileBytes` (đổi tên + cắt file cũ nhất). */
  private rotateIfNeeded(file: string): void {
    try {
      const stat = fs.statSync(file);
      if (stat.size < this.maxFileBytes) return;
      // Tên xoay gồm timestamp ms + bộ đếm: xoay 2 lần trong cùng 1ms
      // cũng không ghi đè file xoay trước (mất log).
      const stamp = `${Date.now()}-${process.pid}-${this.rotateCounter++}`;
      const rotated = `${file}.${stamp}.ndjson`;
      fs.renameSync(file, rotated);
      this.pruneOldRotated(file);
    } catch (err) {
      // File chưa có thì stat throw ENOENT — bình thường, bỏ qua.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.warn(`harness log: không xoay được ${file}: ${(err as Error).message}`);
      }
    }
  }

  /** Cắt file xoay cũ nhất cho tới khi tổng dung lượng ≤ cap. */
  private pruneOldRotated(liveFile: string): void {
    try {
      const prefix = `${path.basename(liveFile)}.`;
      const dirEntries = fs
        .readdirSync(this.dir)
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name, full: path.join(this.dir, name) }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      let total = 0;
      const sizes = new Map<string, number>();
      for (const entry of dirEntries) {
        const size = fs.statSync(entry.full).size;
        sizes.set(entry.name, size);
        total += size;
      }
      try {
        total += fs.statSync(liveFile).size;
      } catch {
        // File live chưa tồn tại sau xoay — bỏ qua.
      }
      for (const entry of dirEntries) {
        if (total <= this.maxTotalBytes) break;
        try {
          fs.unlinkSync(entry.full);
          total -= sizes.get(entry.name) ?? 0;
        } catch {
          break;
        }
      }
    } catch {
      // Prune best-effort.
    }
  }

  /**
   * Đọc lại log theo thread (file live + các file đã xoay, theo thứ
   * tự thời gian). Phân trang theo offset/limit, lọc theo kind.
   * Dòng hỏng thì bỏ qua (không crash cả lần đọc).
   */
  read(
    threadId: string,
    options: { limit?: number; offset?: number; kinds?: readonly HarnessEventKind[] } = {},
  ): ThreadLogPage {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    const offset = Math.max(options.offset ?? 0, 0);
    const kinds = options.kinds;
    const entries: ThreadLogEntry[] = [];
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const base = safeThreadFileName(threadId);
      const files = fs
        .readdirSync(this.dir)
        .filter((name) => name === base || (name.startsWith(`${base}.`) && name.endsWith('.ndjson')))
        // File xoay (cũ) trước, file live sau — thứ tự thời gian.
        .sort((a, b) => {
          if (a === base) return 1;
          if (b === base) return -1;
          return a < b ? -1 : 1;
        });
      for (const name of files) {
        const text = fs.readFileSync(path.join(this.dir, name), 'utf8');
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as ThreadLogEntry;
            if (typeof parsed.at !== 'string' || typeof parsed.kind !== 'string') continue;
            if (kinds !== undefined && !kinds.includes(parsed.kind)) continue;
            entries.push(parsed);
          } catch {
            // Dòng hỏng: bỏ qua.
          }
        }
      }
    } catch {
      // Thư mục/file chưa có → trả rỗng.
    }
    const total = entries.length;
    return { threadId, entries: entries.slice(offset, offset + limit), total, offset, limit };
  }

  /** Các threadId đã có log (từ tên file live — file xoay không tính). */
  listThreads(): string[] {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((name) => {
          if (!name.endsWith('.ndjson')) return false;
          // File xoay có dạng `<base>.<ms>-<pid>-<n>.ndjson` — loại.
          const stripped = name.slice(0, -'.ndjson'.length);
          return !/\.\d+-\d+-\d+$/.test(stripped);
        })
        .map((name) => name.slice(0, -'.ndjson'.length));
    } catch {
      return [];
    }
  }
}
