/**
 * Backend factory cho verbatim memory (v1.01, Đội T4).
 *
 * Mặc định: SQLite (`node:sqlite`, Node ≥ 24) — nhanh, truy vấn theo
 * metadata, bền. Khi SQLite mở không được (runtime thiếu `node:sqlite`,
 * thư mục chỉ đọc, file DB hỏng không sửa được) → tự fallback JSONL
 * và ghi rõ lý do vào `openVerbatimBackend` result để UI/stats hiển
 * thị đúng backend đang chạy.
 *
 * Để cắm backend mới (Chroma / Qdrant / pgvector…): implement
 * `VerbatimBackend` rồi thêm một nhánh vào `openVerbatimBackend` (hoặc
 * truyền thẳng instance vào `VerbatimMemoryStore`) — store không đổi.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VerbatimBackend } from '../types';
import { JsonlVerbatimBackend } from './jsonl';
import { SqliteVerbatimBackend } from './sqlite';

export type VerbatimBackendKind = 'sqlite' | 'jsonl';

export interface OpenVerbatimBackendOptions {
  /** Thư mục dữ liệu (vd `<workspace>/.open-bot/verbatim`). */
  dir: string;
  /** Backend muốn dùng (mặc định 'sqlite'; 'jsonl' ép dùng JSONL). */
  backend?: VerbatimBackendKind;
  /** Mở read-only (chỉ SQLite hỗ trợ thật; JSONL bỏ qua cờ này). */
  readOnly?: boolean;
}

export interface OpenVerbatimBackendResult {
  backend: VerbatimBackend;
  /** Backend thực tế đang chạy (có thể khác `backend` yêu cầu khi fallback). */
  kind: VerbatimBackendKind;
  /** Lý do fallback (vắng khi dùng đúng backend yêu cầu). */
  fallbackReason?: string;
}

/**
 * Mở backend verbatim. Thử SQLite trước (trừ khi ép 'jsonl'); lỗi thì
 * fallback JSONL — KHÔNG throw khi chỉ là lỗi mở DB, để app vẫn chạy
 * được với memory (ghi log rõ ràng để user biết).
 */
export function openVerbatimBackend(opts: OpenVerbatimBackendOptions): OpenVerbatimBackendResult {
  const dir = path.resolve(opts.dir);
  fs.mkdirSync(dir, { recursive: true });
  const wanted: VerbatimBackendKind = opts.backend ?? 'sqlite';
  if (wanted === 'jsonl') {
    return { backend: new JsonlVerbatimBackend({ dir }), kind: 'jsonl' };
  }
  try {
    const backend = new SqliteVerbatimBackend({ dir, readOnly: opts.readOnly });
    return { backend, kind: 'sqlite' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[verbatim] SQLite mở không được (${reason}) — fallback JSONL.`);
    return {
      backend: new JsonlVerbatimBackend({ dir }),
      kind: 'jsonl',
      fallbackReason: reason,
    };
  }
}

export { JsonlVerbatimBackend } from './jsonl';
export { SqliteVerbatimBackend, VERBATIM_SQLITE_FILE } from './sqlite';
export { VERBATIM_JSONL_FILE } from './jsonl';
