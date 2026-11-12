/**
 * Tool-result blob store — `TruncatedToolCall` kiểu Grok (v0.40, P0-3;
 * REA deep-dive lần 2 §3.3).
 *
 * Grok không cắt đứt kết quả tool quá dài: nó giữ `blob_id` +
 * `original_size_bytes` + `preview`, agent gọi lại để lấy phần đầy
 * đủ. Open-bot trước đây cắt cứng ở 20.000 ký tự
 * (`MAX_TOOL_RESULT_CHARS`) và phần còn lại mất hẳn. Module này là
 * bản tương đương local:
 *
 *  - `truncateWithBlob(text, workspaceDir?)`: kết quả dài hơn ngưỡng
 *    được lưu nguyên văn vào blob store, chỉ trả `preview` (20.000 ký
 *    tự đầu) kèm footer có `blob_id` + `original_size_bytes` + hướng
 *    dẫn gọi `tool_blob_fetch`. Ngắn hơn ngưỡng thì trả nguyên văn,
 *    không tạo blob.
 *  - `tool_blob_fetch`: tool đọc lại blob theo phân trang
 *    (`offset`/`length` theo ký tự), để agent lấy phần đầy đủ từng
 *    đoạn mà không nhồi hết vào context một lúc.
 *  - Tương thích ngược: không có workspaceDir, hoặc ghi blob lỗi
 *    (đĩa đầy, quyền…), thì rơi về cắt cứng kiểu cũ — footer cũ
 *    `[... truncated to 20000 chars ...]` giữ nguyên chuỗi con
 *    `truncated to 20000 chars` để test/code cũ vẫn khớp.
 *
 * Lưu trữ: file text thuần dưới
 * `<workspaceDir>/.open-bot/tool-blobs/<blobId>.txt`, một blob một
 * file, tên file validate chặt (không có `/` hay `..` — không có
 * đường path traversal ra ngoài). Giới hạn: một blob tối đa 5 MB
 * (phần vượt bị cắt khi lưu, footer ghi rõ), tối đa 50 blob/workspace
 * (blob cũ nhất theo mtime bị xoá khi vượt). Không có TTL riêng —
 * blob là file tạm của run, host có thể xoá cả thư mục bất cứ lúc nào.
 *
 * Bảo mật: blob có thể chứa nội dung nhạy cảm mà agent vừa đọc (log,
 * file…) nên thư mục nằm trong workspace của bot (không sync, không
 * gửi đi đâu); `tool_blob_fetch` chỉ đọc trong thư mục đó.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Tool } from '@open-bot/core';
import { truncateText } from './truncate';

/** Số ký tự preview — khớp MAX_TOOL_RESULT_CHARS cũ (20.000). */
export const BLOB_PREVIEW_CHARS = 20_000;
/** Một blob tối đa 5 MB (text UTF-8); phần vượt bị cắt khi lưu. */
export const MAX_BLOB_BYTES = 5_000_000;
/** Tối đa 50 blob trong một workspace; cũ nhất bị xoá khi vượt. */
export const MAX_BLOBS_PER_WORKSPACE = 50;
/** Số ký tự tối đa một lần fetch trả về (mặc định 20.000). */
export const DEFAULT_BLOB_FETCH_CHARS = 20_000;
/** Số ký tự tối đa một lần fetch (tránh nhồi context). */
export const MAX_BLOB_FETCH_CHARS = 100_000;

export const TOOL_BLOBS_REL_DIR = path.join('.open-bot', 'tool-blobs');

const BLOB_ID_RE = /^blob-[A-Za-z0-9_-]{1,64}$/;

export interface StoredBlob {
  blobId: string;
  /** Kích thước gốc của toàn bộ text (bytes UTF-8, trước khi cắt 5 MB). */
  originalSizeBytes: number;
  /** Số ký tự thực sự đã lưu (có thể ít hơn text gốc khi vượt 5 MB). */
  storedChars: number;
  /** True khi text gốc vượt 5 MB và phần đuôi đã bị cắt khi lưu. */
  truncatedOnStore: boolean;
}

export interface FetchedBlobPage {
  blobId: string;
  content: string;
  /** Offset ký tự mà page này bắt đầu. */
  offset: number;
  /** Số ký tự trong page này. */
  length: number;
  /** Tổng số ký tự của blob đã lưu. */
  totalChars: number;
  /** Tổng số byte của text gốc (xem StoredBlob.originalSizeBytes). */
  totalBytes: number;
  /** True khi còn ký tự sau page này. */
  hasMore: boolean;
}

function blobsDir(workspaceDir: string): string {
  return path.join(workspaceDir, TOOL_BLOBS_REL_DIR);
}

function blobPath(workspaceDir: string, blobId: string): string {
  if (!BLOB_ID_RE.test(blobId)) {
    throw new Error(`Invalid blob_id "${blobId}" (expected "blob-<id>").`);
  }
  return path.join(blobsDir(workspaceDir), `${blobId}.txt`);
}

function assertBlobId(blobId: string): void {
  if (!BLOB_ID_RE.test(blobId)) {
    throw new Error(`Invalid blob_id "${blobId}" (expected "blob-<id>").`);
  }
}

/**
 * Lưu toàn bộ `text` vào blob store. Trả về metadata, hoặc null khi
 * không lưu được (caller rơi về cắt cứng kiểu cũ). Không bao giờ throw.
 */
export function storeToolResultBlob(
  workspaceDir: string,
  text: string,
): StoredBlob | null {
  try {
    const dir = blobsDir(workspaceDir);
    fs.mkdirSync(dir, { recursive: true });
    const blobId = `blob-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const originalSizeBytes = Buffer.byteLength(text, 'utf8');
    let stored = text;
    let truncatedOnStore = false;
    if (originalSizeBytes > MAX_BLOB_BYTES) {
      // Cắt theo byte cho đúng giới hạn, không cắt giữa ký tự UTF-8.
      const buf = Buffer.from(text, 'utf8').subarray(0, MAX_BLOB_BYTES);
      stored = buf.toString('utf8');
      truncatedOnStore = true;
    }
    fs.writeFileSync(path.join(dir, `${blobId}.txt`), stored, 'utf8');
    pruneBlobs(workspaceDir);
    return {
      blobId,
      originalSizeBytes,
      storedChars: stored.length,
      truncatedOnStore,
    };
  } catch {
    return null;
  }
}

/** Xoá blob cũ nhất (theo mtime) khi vượt MAX_BLOBS_PER_WORKSPACE. */
function pruneBlobs(workspaceDir: string): void {
  try {
    const dir = blobsDir(workspaceDir);
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.startsWith('blob-') && e.name.endsWith('.txt'))
      .map((e) => {
        let mtime = 0;
        try {
          mtime = fs.statSync(path.join(dir, e.name)).mtimeMs;
        } catch {
          mtime = 0;
        }
        return { name: e.name, mtime };
      })
      .sort((a, b) => a.mtime - b.mtime);
    while (entries.length > MAX_BLOBS_PER_WORKSPACE) {
      const oldest = entries.shift();
      if (!oldest) break;
      try {
        fs.unlinkSync(path.join(dir, oldest.name));
      } catch {
        break;
      }
    }
  } catch {
    // Prune là best-effort; không bao giờ làm hỏng lần store vừa rồi.
  }
}

/**
 * Đọc một page của blob (phân trang theo ký tự). `offset`/`length`
 * được clamp về [0, totalChars]; length mặc định 20.000, tối đa
 * 100.000. Ném lỗi khi blob không tồn tại hoặc blob_id sai định dạng.
 */
export function fetchToolResultBlob(
  workspaceDir: string,
  blobId: string,
  offset = 0,
  length: number = DEFAULT_BLOB_FETCH_CHARS,
): FetchedBlobPage {
  assertBlobId(blobId);
  const full = blobPath(workspaceDir, blobId);
  let text: string;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch {
    throw new Error(
      `Unknown blob_id "${blobId}" (no stored tool result with that id in this workspace).`,
    );
  }
  const totalChars = text.length;
  const start = Math.max(0, Math.min(Math.floor(offset) || 0, totalChars));
  const take = Math.max(
    0,
    Math.min(
      Math.floor(length) || DEFAULT_BLOB_FETCH_CHARS,
      MAX_BLOB_FETCH_CHARS,
      totalChars - start,
    ),
  );
  return {
    blobId,
    content: text.slice(start, start + take),
    offset: start,
    length: take,
    totalChars,
    totalBytes: Buffer.byteLength(text, 'utf8'),
    hasMore: start + take < totalChars,
  };
}

/**
 * Cắt `text` về tối đa `maxChars` ký tự, giữ phần đầy đủ trong blob
 * store khi có thể (xem header). Footer mới giữ chuỗi con
 * `truncated to <maxChars> chars` để tương thích với code/test cũ
 * chỉ kiểm tra cắt cứng; thêm `blob_id` + `original_size_bytes` để
 * agent lấy lại phần đầy đủ bằng `tool_blob_fetch`.
 */
export function truncateWithBlob(
  text: string,
  workspaceDir?: string,
  maxChars: number = BLOB_PREVIEW_CHARS,
): string {
  if (text.length <= maxChars) return text;
  const preview = text.slice(0, maxChars);
  const originalSizeBytes = Buffer.byteLength(text, 'utf8');
  if (workspaceDir) {
    const stored = storeToolResultBlob(workspaceDir, text);
    if (stored) {
      const storeNote = stored.truncatedOnStore
        ? ` Only the first ${stored.storedChars} chars were stored (blob cap ${MAX_BLOB_BYTES} bytes).`
        : '';
      return (
        `${preview}\n[... truncated to ${maxChars} chars of ${text.length} chars ` +
        `(original_size_bytes: ${originalSizeBytes}) — full result saved as blob_id: ${stored.blobId}.${storeNote} ` +
        `Use tool_blob_fetch with blob_id "${stored.blobId}", offset ${maxChars} and length up to ${MAX_BLOB_FETCH_CHARS} to read the rest. ...]`
      );
    }
  }
  return truncateText(text, maxChars);
}

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
}

/**
 * Tool `tool_blob_fetch` — đọc lại phần đầy đủ của một kết quả tool
 * đã bị cắt (xem truncateWithBlob). Read-only, không cần approval.
 * Args: blob_id (bắt buộc), offset (mặc định 0), length (mặc định
 * 20.000, tối đa 100.000 — ký tự, không phải byte).
 */
export function createToolBlobTools(): Tool[] {
  const toolBlobFetch: Tool = {
    definition: {
      name: 'tool_blob_fetch',
      description:
        'Read back the full result of a tool call that was truncated: give the blob_id from the "[... truncated ...]" footer, plus offset/length (chars) to page through it. Returns one page plus totalChars/hasMore so you can fetch the next page. Blobs live only in this workspace (.open-bot/tool-blobs/) and are never sent anywhere.',
      parameters: {
        type: 'object',
        properties: {
          blob_id: { type: 'string', description: 'Blob id from a truncation footer, e.g. "blob-0123456789abcdef".' },
          offset: { type: 'number', description: 'Character offset to start reading from (default 0).' },
          length: { type: 'number', description: `Characters to return (default ${DEFAULT_BLOB_FETCH_CHARS}, max ${MAX_BLOB_FETCH_CHARS}).` },
        },
        required: ['blob_id'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const blobId = getStringArg(args, 'blob_id');
        const offset = getNumberArg(args, 'offset') ?? 0;
        const length = getNumberArg(args, 'length') ?? DEFAULT_BLOB_FETCH_CHARS;
        const page = fetchToolResultBlob(ctx.workspaceDir, blobId, offset, length);
        const next =
          page.hasMore === true
            ? `\n[more: call tool_blob_fetch again with offset ${page.offset + page.length} to continue.]`
            : '\n[end of blob.]';
        return (
          `Blob ${page.blobId} — chars ${page.offset}..${page.offset + page.length} of ${page.totalChars} ` +
          `(total ${page.totalBytes} bytes, hasMore: ${page.hasMore}):\n${page.content}${next}`
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };
  return [toolBlobFetch];
}

/** Unbound placeholder (same pattern as other tool groups). */
export const TOOL_BLOB_TOOLS: Tool[] = createToolBlobTools();
