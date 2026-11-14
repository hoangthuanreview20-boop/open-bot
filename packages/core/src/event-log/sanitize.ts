/**
 * Sanitize payload trước khi ghi run log (v1.01, Đội T1).
 *
 * Run log là nhật ký bền vững trên đĩa — nó KHÔNG BAO GIỜ được chứa
 * secret. Quy tắc (cùng nguyên tắc với harness NDJSON, tự viết lại
 * để event-log không phụ thuộc vào harness):
 * - Key trông giống secret (token/password/api-key/auth/…) → value
 *   thành `'<redacted>'` (kể cả key lồng nhau).
 * - Chuỗi `Bearer <token>` → token bị redact; dạng key provider đã
 *   biết (`sk-…`, `xai-…`, `sk-ant-…`) → redact; `apiKey: <v>` /
 *   `token=<v>` trong text tự do → redact value.
 * - Tool args: CHỈ giữ tên key, không bao giờ giữ value (value có
 *   thể chứa đường dẫn, nội dung file, secret).
 * - Chuỗi dài cắt ngắn (mặc định 2.000 ký tự cho text, 500 cho
 *   output preview); mảng cắt tối đa 50 item; object lồng tối đa 4
 *   tầng — log không phình vì một output khổng lồ.
 * - Key đếm token (`inputTokens`/`outputTokens`) là số, không phải
 *   secret — giữ nguyên.
 */

import { redactBearer, REDACTED } from '../util/redact';

/** Chuỗi dài nhất được giữ trong log (ký tự). */
export const RUN_LOG_STRING_LIMIT = 2000;
/** Output preview của tool result dài nhất được giữ (ký tự). */
export const RUN_LOG_OUTPUT_LIMIT = 500;
/** Số item tối đa giữ trong một mảng payload. */
export const RUN_LOG_ARRAY_LIMIT = 50;
/** Độ sâu tối đa khi sanitize object lồng nhau. */
export const RUN_LOG_DEPTH_LIMIT = 4;

/** Key trông giống secret — value bị thay bằng '<redacted>'. */
const SECRET_KEY_RE =
  /token|secret|password|passwd|api[-_]?key|auth|credential|bearer|session|private/i;
/** Key là bộ đếm token (số), KHÔNG phải secret — giữ nguyên. */
const TOKEN_COUNT_KEYS = new Set(['inputTokens', 'outputTokens', 'tokensUsed', 'totalTokens']);

/** Dạng key provider đã biết (`sk-…`, `xai-…`, `sk-ant-…`). */
const KNOWN_KEY_SHAPE_RE = /\b(?:sk-ant|sk|xai)-[A-Za-z0-9_-]{8,}\b/g;
/** `apiKey: <value>` / `token=<value>` / `password: <value>` trong text tự do. */
const KEY_VALUE_SHAPE_RE =
  /\b(api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|passwd|token)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi;

/**
 * Sanitize một chuỗi: redact Bearer/key, redact `key: value` trong
 * text tự do, rồi cắt ngắn.
 */
export function sanitizeRunLogString(value: string, limit = RUN_LOG_STRING_LIMIT): string {
  let out = redactBearer(value);
  out = out.replace(KNOWN_KEY_SHAPE_RE, REDACTED);
  out = out.replace(KEY_VALUE_SHAPE_RE, (_m, key: string) => `${key}=${REDACTED}`);
  if (out.length > limit) {
    const suffix = '…[cắt ngắn]';
    return `${out.slice(0, limit - suffix.length)}${suffix}`;
  }
  return out;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeRunLogString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= RUN_LOG_DEPTH_LIMIT) return '[lồng quá sâu]';
  if (Array.isArray(value)) {
    return value.slice(0, RUN_LOG_ARRAY_LIMIT).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
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
 * Sanitize một payload bất kỳ trước khi ghi log. Object được sanitize
 * đệ quy; chuỗi bị cắt ngắn; key secret bị redact.
 */
export function sanitizeRunLogPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    if (!TOKEN_COUNT_KEYS.has(key) && SECRET_KEY_RE.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = sanitizeValue(value, 0);
  }
  return out;
}

/**
 * Chỉ giữ tên key của tool args (sắp xếp cho ổn định) — value không
 * bao giờ vào log.
 */
export function toolArgKeys(args: Record<string, unknown> | undefined | null): string[] {
  if (!args || typeof args !== 'object') return [];
  return Object.keys(args).sort();
}

/**
 * Đoán xem một tool có ghi file không, từ tên tool. Dùng để quyết
 * định có ghi event `file.change` khi tool result trả về hay không.
 * Tập này lấy từ tên tool của repo (file tools), không hardcode theo
 * một provider nào.
 */
const FILE_WRITE_TOOLS = new Set([
  'write_file',
  'create_file',
  'edit_file',
  'delete_file',
  'apply_patch',
  'write',
  'edit',
]);

/** true khi tool này (theo tên) ghi/sửa/xoá file. */
export function isFileWriteTool(toolName: string): boolean {
  return FILE_WRITE_TOOLS.has(toolName);
}

/** Map tên tool ghi file sang kind của `file.change`. */
export function fileChangeKindForTool(toolName: string): 'write' | 'edit' | 'delete' | 'create' {
  if (toolName === 'delete_file') return 'delete';
  if (toolName === 'create_file') return 'create';
  if (toolName === 'edit_file' || toolName === 'edit' || toolName === 'apply_patch') return 'edit';
  return 'write';
}

/**
 * Đoán xem một tool call có phải lệnh build/compile không, từ tên
 * tool + tên key args. Dùng để quyết định có parse `compile.error`
 * từ tool result lỗi hay không.
 */
export function isBuildToolCall(toolName: string, argKeys: string[]): boolean {
  if (toolName === 'run_command' || toolName === 'exec' || toolName === 'shell') {
    return argKeys.some((k) => /command|cmd|script/i.test(k));
  }
  return /build|compile|tsc|typecheck|lint/i.test(toolName);
}

/**
 * Trích dòng lỗi đầu tiên từ output của một lệnh build lỗi.
 * Ưu tiên dòng chứa `error` (TS/eslint/rollup đều in dạng đó); nếu
 * không có thì lấy dòng đầu tiên không rỗng.
 */
export function extractFirstError(output: string): { firstError: string; errorCount?: number } {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { firstError: '' };
  const errorLines = lines.filter((l) => /error/i.test(l));
  const firstError = errorLines[0] ?? lines[0] ?? '';
  const count = errorLines.length > 0 ? errorLines.length : undefined;
  return { firstError, ...(count !== undefined ? { errorCount: count } : {}) };
}
