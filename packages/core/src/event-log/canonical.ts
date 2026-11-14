/**
 * Hash chain cho run log (v1.01, Đội T1).
 *
 * Mỗi event mang `prevHash` (hash của event trước trong cùng run) và
 * `hash` của chính nó. Hash được tính trên bản chuẩn hoá của event:
 * JSON với key sắp xếp theo thứ tự chữ cái, đệ quy xuống object lồng
 * nhau — cùng một nội dung luôn cho cùng một chuỗi byte, bất kể thứ
 * tự key lúc tạo object. Nhờ đó:
 * - Sửa một byte trong payload (kể cả chỉ đổi thứ tự key) → hash của
 *   event đó đổi → hash của mọi event sau cũng đổi (vì `prevHash`
 *   đổi) → verify phát hiện ngay seq đầu tiên bị sửa.
 * - Xoá/chèn một event → seq hoặc `prevHash` đứt → verify phát hiện.
 *
 * Hash chain chống sửa lén, không chống xoá toàn bộ file log và
 * không phải chữ ký số (không có khoá riêng) — ghi rõ trong survey.
 */

import { createHash } from 'node:crypto';

/** Hash của "không có event trước" — event đầu tiên của run. */
export const GENESIS_PREV_HASH = '';

/**
 * JSON stringify với key sắp xếp theo thứ tự chữ cái (đệ quy).
 * Mảng giữ nguyên thứ tự; `undefined` trong object bị bỏ như
 * `JSON.stringify`; giá trị không phải object/array/string/number/
 * boolean/null được ép về `String(value)` để không throw.
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const parts = entries.map(
      ([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`,
    );
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(String(value));
}

/** SHA-256 hex của một chuỗi UTF-8. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Nội dung dùng để tính hash của một event: mọi field trừ `hash`
 * (vì hash của chính nó không thể nằm trong đầu vào của chính nó).
 * `prevHash` NẰM trong đầu vào — đó chính là mắt xích của chuỗi.
 */
export function eventHashInput(input: {
  seq: number;
  runId: string;
  at: string;
  type: string;
  payload: unknown;
  prevHash: string;
}): string {
  return stableStringify({
    at: input.at,
    payload: input.payload,
    prevHash: input.prevHash,
    runId: input.runId,
    seq: input.seq,
    type: input.type,
  });
}

/** Tính hash của một event từ các field của nó. */
export function hashRunEvent(input: {
  seq: number;
  runId: string;
  at: string;
  type: string;
  payload: unknown;
  prevHash: string;
}): string {
  return sha256Hex(eventHashInput(input));
}

/**
 * Tính lại hash của một event đã lưu và so với `hash` nó mang theo.
 * Trả về true khi khớp.
 */
export function verifyEventHash(event: {
  seq: number;
  runId: string;
  at: string;
  type: string;
  payload: unknown;
  prevHash: string;
  hash: string;
}): boolean {
  return hashRunEvent(event) === event.hash;
}

/**
 * Digest của một trạng thái replay (xem `replay.ts`): hash của bản
 * tóm tắt trạng thái đã chuẩn hoá. Hai lần replay cùng một log phải
 * cho cùng digest; log khác nhau (dù chỉ một ký tự) cho digest khác.
 */
export function digestReplayState(state: unknown): string {
  return sha256Hex(stableStringify(state));
}
