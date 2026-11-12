/**
 * @-mentions (`@files` / `@docs`) — v0.15, mục cuối BEYOND-ROADMAP (tách từ v0.11).
 *
 * Tính năng tương tự slash commands (`packages/core/src/agent/slash.ts`)
 * nhưng inline trong câu chat: người dùng gõ `@files src/index.ts` hoặc
 * `@docs README.md` thì nội dung file được đưa vào context của run.
 *
 * Module này KHÔNG import loop/coordinator — điều phối viên sẽ gọi
 * `resolveMentions()` trên text của người dùng rồi đưa text đã resolve
 * vào vòng lặp agent (xem hướng dẫn nối ở cuối file).
 *
 * An toàn:
 * - Chỉ đọc file BÊN TRONG workspace (`resolveWithin` + kiểm tra
 *   realpath để chặn symlink trỏ ra ngoài). Không resolve URL, không
 *   đọc file ngoài workspace, không chạy code.
 * - `@docs` cũng resolve trong workspace như `@files`, chỉ khác nhãn
 *   (`docs`) — đọc README/docs trong workspace.
 * - Giới hạn mỗi file 100KB và tổng tối đa 500KB; file quá lớn chỉ lấy
 *   đầu + ghi chú đã cắt. File nhị phân (chứa byte 0) bị bỏ qua.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveWithin } from '../ipc/validate';

/** Loại mention: `@files` (file thường) hoặc `@docs` (tài liệu trong workspace). */
export type MentionKind = 'files' | 'docs';

/** Một mention đã parse được trong text. */
export interface ParsedMention {
  /** Loại mention: 'files' hoặc 'docs'. */
  kind: MentionKind;
  /** Chuỗi mention gốc, vd "@files src/index.ts src/util.ts". */
  raw: string;
  /** Các đường dẫn người dùng gõ (dạng tương đối, giữ nguyên như đã gõ). */
  paths: string[];
}

/** Một file đã đưa được vào context. */
export interface IncludedMentionFile {
  kind: MentionKind;
  /** Đường dẫn như người dùng đã gõ. */
  path: string;
  /** Số ký tự nội dung đã đưa vào text (sau khi cắt nếu có). */
  chars: number;
  /** True khi file bị cắt bớt do vượt giới hạn kích thước. */
  truncated: boolean;
}

/** Một file mention nhưng không đưa được vào context. */
export interface SkippedMentionFile {
  kind: MentionKind;
  /** Đường dẫn như người dùng đã gõ. */
  path: string;
  /** Lý do bỏ qua, tiếng Việt, vd "không tồn tại trong workspace". */
  reason: string;
}

/** Tuỳ chọn cho `resolveMentions`. */
export interface ResolveMentionsOptions {
  /** Số byte tối đa lấy từ một file (mặc định 100KB). */
  maxFileBytes?: number;
  /** Tổng số byte tối đa cho mọi file trong một lần resolve (mặc định 500KB). */
  maxTotalBytes?: number;
}

/** Kết quả của `resolveMentions`. */
export interface ResolveMentionsResult {
  /** Text gốc đã thay mỗi mention bằng (các) khối nội dung file. */
  text: string;
  /** Các file đã đưa vào context (UI có thể hiển thị dạng chip). */
  included: IncludedMentionFile[];
  /** Các file bị bỏ qua kèm lý do (UI có thể hiển thị cảnh báo). */
  skipped: SkippedMentionFile[];
}

/** Số byte tối đa lấy từ một file @-mention (100KB). */
export const MENTION_MAX_FILE_BYTES = 100 * 1024;

/** Tổng số byte tối đa cho mọi file @-mention trong một lần resolve (500KB). */
export const MENTION_MAX_TOTAL_BYTES = 500 * 1024;

/** Tên mention hợp lệ: chỉ đúng `@files` / `@docs` viết thường. */
const MENTION_RE = /@(files|docs)(?![A-Za-z0-9_-])/g;

/** Ngôn ngữ gợi ý cho fence ``` theo đuôi file (để renderer tô màu). */
const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',
  '.mjs': 'mjs',
  '.cjs': 'cjs',
  '.json': 'json',
  '.md': 'md',
  '.markdown': 'md',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.css': 'css',
  '.html': 'html',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.sh': 'bash',
  '.sql': 'sql',
  '.txt': 'text',
};

/**
 * Một mention kèm vị trí trong text (dùng nội bộ cho việc thay thế;
 * `parseMentions` chỉ trả về dạng public không có vị trí).
 */
interface ScannedMention extends ParsedMention {
  /** Vị trí bắt đầu của `@` trong text. */
  start: number;
  /** Vị trí kết thúc (ngay sau path cuối cùng). */
  end: number;
}

/**
 * Tách một token đường dẫn khỏi phần còn lại của dòng.
 * - Token trong ngoặc kép `"my file.ts"` được giữ nguyên cả khoảng trắng.
 * - Token thường kết thúc ở khoảng trắng; dấu `,` / `;` / `:` cuối token
 *   và dấu `.` thừa cuối tên file có đuôi (vd "a.ts.") được lược bỏ.
 * Trả về null khi không còn token nào. `length` là độ dài đã tiêu thụ
 * tính từ ĐẦU `rest` (gồm cả khoảng trắng dẫn trước token).
 */
function takePathToken(rest: string): { token: string; length: number } | null {
  let i = 0;
  while (i < rest.length && (rest[i] === ' ' || rest[i] === '\t')) i++;
  if (i >= rest.length) return null;
  if (rest[i] === '"') {
    const close = rest.indexOf('"', i + 1);
    if (close === -1) {
      // Không có ngoặc đóng: lấy hết phần còn lại làm token.
      return { token: rest.slice(i + 1).trim(), length: rest.length };
    }
    return { token: rest.slice(i + 1, close), length: close + 1 };
  }
  let j = i;
  while (j < rest.length && rest[j] !== ' ' && rest[j] !== '\t') j++;
  let token = rest.slice(i, j);
  token = token.replace(/[,;:]+$/, '');
  // "a.ts." → "a.ts" (dấu chấm cuối câu, không phải một phần của tên file).
  if (token.endsWith('.') && token.indexOf('.') !== token.length - 1) {
    token = token.slice(0, -1);
  }
  if (token === '') return null;
  return { token, length: j };
}

/** Token có "dáng" của một đường dẫn: chứa `/` hoặc `.` (vd "src/a.ts", "README.md"). */
function looksLikePath(token: string): boolean {
  return token.includes('/') || token.includes('.');
}

/**
 * Quét text tìm mọi `@files <path...>` / `@docs <path...>` kèm vị trí.
 * - Chỉ khớp đúng `@files` / `@docs` viết thường; `@file`, `@doc`,
 *   `@Files`, `@files2` hay email dạng `a@files x` đều không khớp.
 * - Danh sách path nằm trên cùng một dòng với mention, kết thúc ở cuối
 *   dòng hoặc ở mention tiếp theo (`@files a.ts @docs b.md`).
 * - Token đầu tiên sau mention luôn được nhận làm path (để file không
 *   đuôi như `LICENSE`, `Makefile` vẫn dùng được); các token sau chỉ
 *   được nhận khi có dáng đường dẫn — chữ thường trong câu (vd "giúp
 *   mình" sau `@files README.md`) sẽ dừng danh sách, không bị nuốt
 *   thành path.
 * - `@files` không có path nào (cuối dòng, hoặc ngay sau là chữ thường
 *   không phải path) thì không tính là mention.
 */
function scanMentions(text: string): ScannedMention[] {
  const found: ScannedMention[] = [];
  if (typeof text !== 'string' || text === '') return found;
  MENTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION_RE.exec(text)) !== null) {
    const at = match.index;
    // Ký tự ngay trước `@` phải là đầu text, khoảng trắng hoặc dấu mở
    // ngoặc — tránh khớp `mail@files x` hay `x@docs y`.
    if (at > 0) {
      const before = text[at - 1]!;
      if (/[A-Za-z0-9._-]/.test(before)) continue;
    }
    const kind = match[1] as MentionKind;
    // Chỉ lấy phần còn lại của DÒNG hiện tại (mention không tràn dòng).
    const lineEnd = text.indexOf('\n', MENTION_RE.lastIndex);
    const lineRest = text.slice(
      MENTION_RE.lastIndex,
      lineEnd === -1 ? text.length : lineEnd,
    );
    const paths: string[] = [];
    let offset = 0;
    let end = MENTION_RE.lastIndex;
    for (;;) {
      const taken = takePathToken(lineRest.slice(offset));
      if (taken === null) break;
      const { token, length } = taken;
      // Mention tiếp theo trên cùng dòng thì dừng (để vòng quét ngoài xử lý).
      if (token.startsWith('@')) break;
      // Token đầu tiên luôn nhận; token sau chỉ nhận khi có dáng đường dẫn.
      if (paths.length > 0 && !looksLikePath(token)) break;
      paths.push(token);
      end = MENTION_RE.lastIndex + offset + length;
      offset += length;
    }
    if (paths.length === 0) continue;
    found.push({
      kind,
      raw: text.slice(at, end),
      paths,
      start: at,
      end,
    });
  }
  return found;
}

/**
 * Phân tích text, tìm các `@files <path...>` / `@docs <path...>` và trả
 * danh sách `{ kind, raw, paths }` theo thứ tự xuất hiện. Text không có
 * mention hợp lệ → `[]`. Hàm thuần túy, không đọc file.
 */
export function parseMentions(text: string): ParsedMention[] {
  return scanMentions(text).map(({ kind, raw, paths }) => ({ kind, raw, paths }));
}

/**
 * Đọc tối đa `byteLimit` byte đầu của file (không đọc cả file lớn vào
 * bộ nhớ). Trả về nội dung text, số byte đã đọc, tổng kích thước file
 * và cờ đã cắt.
 */
function readFileHead(
  absPath: string,
  byteLimit: number,
): { content: string; bytesRead: number; totalBytes: number; truncated: boolean } {
  const stat = fs.statSync(absPath);
  const totalBytes = stat.size;
  const toRead = Math.min(totalBytes, byteLimit);
  const fd = fs.openSync(absPath, 'r');
  try {
    const buf = Buffer.alloc(toRead);
    let read = 0;
    while (read < toRead) {
      const n = fs.readSync(fd, buf, read, toRead - read, read);
      if (n === 0) break;
      read += n;
    }
    return {
      content: buf.subarray(0, read).toString('utf8'),
      bytesRead: read,
      totalBytes,
      truncated: totalBytes > byteLimit,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Resolve một đường dẫn mention thành đường dẫn tuyệt đối trong workspace.
 * Ném Error với message tiếng Việt khi đường dẫn thoát khỏi workspace
 * (kể cả qua symlink) hoặc workspace không hợp lệ.
 */
function resolveMentionPath(workspaceDir: string, typedPath: string): string {
  const wsAbs = path.resolve(workspaceDir);
  // Đường dẫn tuyệt đối: kiểm tra trực tiếp; tương đối: nối vào workspace.
  const candidate = path.isAbsolute(typedPath)
    ? path.resolve(typedPath)
    : path.resolve(wsAbs, typedPath);
  // Chặn `..` / đường dẫn tuyệt đối ngoài workspace (kiểu resolveWithin).
  const inside = resolveWithin([wsAbs], candidate, typedPath);
  // Chặn symlink trỏ ra ngoài: so sánh đường dẫn thật (realpath).
  const wsReal = fs.realpathSync(wsAbs);
  let real: string;
  try {
    real = fs.realpathSync(inside);
  } catch {
    // File chưa tồn tại: realpath thất bại — để bước kiểm tra tồn tại
    // phía dưới báo "không tồn tại" thay vì lỗi symlink.
    return inside;
  }
  if (real !== wsReal && !real.startsWith(wsReal + path.sep)) {
    throw new Error(
      `Đường dẫn "${typedPath}" nằm ngoài workspace (đường dẫn qua symlink trỏ ra ngoài).`,
    );
  }
  return inside;
}

/**
 * Resolve mọi `@files` / `@docs` trong text: đọc file trong workspace và
 * thay mỗi mention bằng (các) khối nội dung file dạng:
 *
 *   [@files src/index.ts]
 *   ```ts
 *   <nội dung file>
 *   ```
 *
 * Dòng `[@files ...]` giữ lại tên file + dòng mention gốc. File quá lớn
 * chỉ lấy đầu + ghi chú đã cắt ngay sau khối code.
 *
 * Mention mà mọi path đều bị bỏ qua thì được thay bằng ghi chú ngắn
 * `[@files <path> — đã bỏ qua: <lý do>]` để model không tưởng tượng
 * ra nội dung file. `included` / `skipped` để UI hiển thị chip + cảnh
 * báo nếu cần.
 *
 * Không ném lỗi: mọi vấn đề của từng file đều ghi vào `skipped` và text
 * vẫn trả về đầy đủ. Không resolve URL, không đọc file ngoài workspace,
 * không chạy code.
 */
export function resolveMentions(
  text: string,
  workspaceDir: string,
  opts: ResolveMentionsOptions = {},
): ResolveMentionsResult {
  const maxFileBytes = opts.maxFileBytes ?? MENTION_MAX_FILE_BYTES;
  const maxTotalBytes = opts.maxTotalBytes ?? MENTION_MAX_TOTAL_BYTES;
  const mentions = scanMentions(text);
  if (mentions.length === 0) {
    return { text, included: [], skipped: [] };
  }

  const included: IncludedMentionFile[] = [];
  const skipped: SkippedMentionFile[] = [];

  // Không có workspace → mọi file đều bỏ qua, giữ nguyên text.
  if (typeof workspaceDir !== 'string' || workspaceDir.trim() === '') {
    for (const mention of mentions) {
      for (const p of mention.paths) {
        skipped.push({
          kind: mention.kind,
          path: p,
          reason: 'không có thư mục workspace nên không đọc được file',
        });
      }
    }
    return { text, included, skipped };
  }

  const wsAbs = path.resolve(workspaceDir);
  let wsOk = false;
  try {
    wsOk = fs.statSync(wsAbs).isDirectory();
  } catch {
    wsOk = false;
  }
  if (!wsOk) {
    for (const mention of mentions) {
      for (const p of mention.paths) {
        skipped.push({
          kind: mention.kind,
          path: p,
          reason: `thư mục workspace "${workspaceDir}" không tồn tại`,
        });
      }
    }
    return { text, included, skipped };
  }

  let totalBytesUsed = 0;
  let out = '';
  let cursor = 0;

  for (const mention of mentions) {
    out += text.slice(cursor, mention.start);
    const blocks: string[] = [];
    const mentionSkipped: SkippedMentionFile[] = [];

    for (const typedPath of mention.paths) {
      // Hết ngân sách tổng → các file còn lại đều bỏ qua.
      if (totalBytesUsed >= maxTotalBytes) {
        const entry: SkippedMentionFile = {
          kind: mention.kind,
          path: typedPath,
          reason: `vượt tổng giới hạn ${maxTotalBytes} byte cho tất cả file @-mention trong một lần chat`,
        };
        skipped.push(entry);
        mentionSkipped.push(entry);
        continue;
      }

      let absPath: string;
      try {
        absPath = resolveMentionPath(workspaceDir, typedPath);
      } catch (err) {
        const entry: SkippedMentionFile = {
          kind: mention.kind,
          path: typedPath,
          reason: (err as Error).message,
        };
        skipped.push(entry);
        mentionSkipped.push(entry);
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(absPath);
      } catch {
        const entry: SkippedMentionFile = {
          kind: mention.kind,
          path: typedPath,
          reason: 'không tồn tại trong workspace',
        };
        skipped.push(entry);
        mentionSkipped.push(entry);
        continue;
      }
      if (!stat.isFile()) {
        const entry: SkippedMentionFile = {
          kind: mention.kind,
          path: typedPath,
          reason: 'không phải file (là thư mục hoặc dạng khác)',
        };
        skipped.push(entry);
        mentionSkipped.push(entry);
        continue;
      }

      // Ngân sách còn lại cho file này: giới hạn mỗi file, đồng thời
      // không vượt tổng ngân sách của cả lần resolve.
      const remainingTotal = maxTotalBytes - totalBytesUsed;
      const byteLimit = Math.min(maxFileBytes, remainingTotal);
      let head: ReturnType<typeof readFileHead>;
      try {
        head = readFileHead(absPath, byteLimit);
      } catch (err) {
        const entry: SkippedMentionFile = {
          kind: mention.kind,
          path: typedPath,
          reason: `không đọc được file: ${(err as Error).message}`,
        };
        skipped.push(entry);
        mentionSkipped.push(entry);
        continue;
      }

      // File nhị phân (chứa byte 0 ở đầu file) thì bỏ qua, không đưa
      // nội dung rác vào context.
      const probe = Buffer.from(head.content.slice(0, 8192), 'utf8');
      if (probe.includes(0)) {
        const entry: SkippedMentionFile = {
          kind: mention.kind,
          path: typedPath,
          reason: 'file nhị phân, không đọc dạng text',
        };
        skipped.push(entry);
        mentionSkipped.push(entry);
        continue;
      }

      const truncated = head.truncated || head.totalBytes > byteLimit;
      totalBytesUsed += head.bytesRead;
      included.push({
        kind: mention.kind,
        path: typedPath,
        chars: head.content.length,
        truncated,
      });
      const lang = LANG_BY_EXT[path.extname(typedPath).toLowerCase()] ?? '';
      let block = `[@${mention.kind} ${typedPath}]\n\`\`\`${lang}\n${head.content}\n\`\`\``;
      if (truncated) {
        block +=
          `\n(Đã cắt bớt: chỉ lấy ${head.bytesRead} byte đầu — ` +
          `file gốc ${head.totalBytes} byte.)`;
      }
      blocks.push(block);
    }

    if (blocks.length > 0) {
      out += blocks.join('\n\n');
    } else {
      // Mọi path đều bị bỏ qua: để lại ghi chú thay cho mention gốc.
      out +=
        `[@${mention.kind} ${mention.paths.join(' ')} — đã bỏ qua: ` +
        `${mentionSkipped.map((s) => `${s.path} (${s.reason})`).join('; ')}]`;
    }
    cursor = mention.end;
  }
  out += text.slice(cursor);
  return { text: out, included, skipped };
}

/**
 * Hướng dẫn nối cho điều phối viên (coordinator.ts, `executeRun`):
 *
 * ```ts
 * import { resolveMentions } from '../agent/mentions';
 *
 * // TRƯỚC slash: mention nằm trong text người dùng, slash thay cả text
 * // bằng template nên phải resolve mention trước khi slash "nuốt" text.
 * const mentions = resolveMentions(params.text, entry.bot.workspaceDir);
 * let runText = mentions.text;
 * if (mentions.skipped.length > 0) {
 *   emitInfo('progress', mentions.skipped.map((s) => `@${s.kind} ${s.path}: ${s.reason}`).join('\n'));
 * }
 * // Sau đó mới resolveSlashCommand(entry, runText) như hiện tại.
 * ```
 *
 * `mentions.included` (`{ kind, path, chars, truncated }`) để UI hiển
 * thị chip file đã đưa vào context; `mentions.skipped`
 * (`{ kind, path, reason }`) để UI hiển thị cảnh báo.
 */
