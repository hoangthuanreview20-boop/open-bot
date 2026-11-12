/**
 * Skill marketplace (v0.14, item 4) — cài skill từ URL.
 *
 * Một skill chỉ là dữ liệu (Markdown + tài nguyên), KHÔNG BAO GIỜ là code
 * để chạy: module này chỉ tải về, giải nén/đọc, quét secret và ghi file.
 * Nó không chạy bất kỳ script hay lệnh nào trong skill được cài — kể cả
 * file dưới `scripts/` (việc chạy script là quyết định của người dùng,
 * qua đường khác, không phải của marketplace).
 *
 * Hai dạng nguồn được hỗ trợ:
 *  (a) URL trỏ tới file `.zip` — tải về rồi giải nén bằng bộ đọc ZIP tối
 *      thiểu tự viết (chỉ `stored` + `deflate`, dùng `node:zlib`, không
 *      thêm dependency), KHÔNG chạy gì trong đó.
 *  (b) URL trỏ tới repo git — clone nông (`git clone --depth 1`) bằng
 *      CLI `git`, không chạy script nào trong repo.
 *
 * An toàn:
 *  - Chỉ chấp nhận URL http(s) (riêng git còn chấp nhận `git@host:...`
 *    cho clone qua SSH — mọi scheme khác như `file:`, `ftp:` đều bị chặn).
 *  - Chặn zip slip: entry có `..` hoặc đường dẫn tuyệt đối → lỗi.
 *  - Giới hạn: tối đa 10 MB tải về, tối đa 500 file, tối đa 50 MB sau
 *    khi giải nén; timeout fetch 30 giây.
 *  - Quét secret trước khi cài: dùng `looksLikeSecret` của loader hiện có
 *    (packages/core/src/skills/loader.ts) làm chốt chặn, cộng thêm bộ
 *    quét chi tiết trong file này để báo rõ file nào, dòng nào, loại
 *    secret nào — KHÔNG BAO GIỜ in giá trị secret ra log/output.
 *  - Validate manifest bằng loader hiện có (`parseSkillMarkdown` /
 *    `loadSkillDir`): skill cài xong phải load lại được.
 *  - Tên skill lấy từ manifest, chuẩn hoá về `[a-z0-9-]`; nếu đã tồn
 *    tại trong `skillsDir` thì báo rõ, chỉ ghi đè khi `overwrite: true`.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { loadSkillDir, looksLikeSecret, parseSkillMarkdown } from './loader';
import type { Skill } from './types';
import { INJECTION_PATTERNS } from '../guardrails/builtin';

/** Tối đa 10 MB tải về cho một skill. */
export const MAX_SKILL_DOWNLOAD_BYTES = 10 * 1024 * 1024;
/** Tối đa 500 file trong một skill. */
export const MAX_SKILL_FILES = 500;
/** Tối đa 50 MB sau khi giải nén (chống zip bomb). */
export const MAX_SKILL_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
/** Timeout cho một lần fetch (ms). */
export const FETCH_TIMEOUT_MS = 30_000;
/** File lớn hơn ngưỡng này thì bỏ qua khi quét secret (không đọc hết). */
export const MAX_SCANNED_FILE_BYTES = 1024 * 1024;

/** Lỗi của marketplace — mọi message đều tiếng Việt, không chứa secret. */
export class MarketplaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketplaceError';
  }
}

/** Một secret bị phát hiện: chỉ vị trí + loại, KHÔNG có giá trị. */
export interface SecretFinding {
  /** Đường dẫn tương đối trong skill, ví dụ `references/notes.md`. */
  file: string;
  /** Số dòng (1-based). */
  line: number;
  /** Loại secret, ví dụ `Khóa API OpenAI (sk-...)`. */
  type: string;
}

/** Một file trong skill (dùng cho preview). */
export interface SkillPreviewFile {
  /** Đường dẫn tương đối, dùng `/` làm phân tách. */
  path: string;
  /** Kích thước file (byte). */
  size: number;
}

/** Kết quả xem trước một skill — chưa cài gì cả. */
export interface SkillPreview {
  /** Tên skill (đã chuẩn hoá về `[a-z0-9-]`). */
  skillName: string;
  /** Manifest đã validate bằng loader. */
  manifest: Skill;
  /** Danh sách file trong skill (đường dẫn + kích thước). */
  files: SkillPreviewFile[];
  /** Nội dung README.md nếu có (cắt ở 20.000 ký tự). */
  readme?: string;
  /** URL nguồn. */
  sourceUrl: string;
  /**
   * v0.15 (H2 audit): cảnh báo prompt injection tìm thấy trong nội dung
   * skill (mẫu "ignore previous instructions", "you are now…", …).
   * Preview chỉ cảnh báo; install TỪ CHỐI khi có phát hiện.
   */
  injectionWarnings?: string[];
}

/** Kết quả cài đặt thành công. */
export interface InstallSkillResult {
  /** Đường dẫn tuyệt đối tới thư mục skill đã cài. */
  installedPath: string;
  /** Manifest đã validate bằng loader. */
  manifest: Skill;
  /** Các file đã quét secret (đường dẫn tương đối trong skill). */
  scannedFiles: string[];
  /** Cảnh báo không chặn cài đặt (ví dụ: tên đã chuẩn hoá, symlink bị bỏ qua). */
  warnings: string[];
}

/** Kiểu hàm fetch có thể inject (mặc định là `fetch` toàn cục). */
export type MarketplaceFetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface PreviewSkillOptions {
  fetchFn?: MarketplaceFetchFn;
  /** Khi có, chỉ cho phép các host này (so khớp chính xác, không phân biệt hoa/thường). */
  allowHosts?: string[];
}

export interface InstallSkillOptions extends PreviewSkillOptions {
  /** Thư mục chứa các skill đã cài (`<skillsDir>/<tên-skill>/`). */
  skillsDir: string;
  /** Ghi đè skill cùng tên đã tồn tại. Mặc định false (báo lỗi thay vì ghi đè lặng lẽ). */
  overwrite?: boolean;
}

// ---------------------------------------------------------------------------
// Quét secret (chi tiết — báo file + dòng + loại; tái sử dụng looksLikeSecret
// của loader làm chốt chặn ở bước validate manifest)
// ---------------------------------------------------------------------------

/**
 * Các mẫu secret kèm tên loại (tiếng Việt, không chứa giá trị mẫu).
 * Bổ sung cho `looksLikeSecret` của loader (loader chỉ trả boolean):
 * bộ này cho biết LOẠI secret và DÒNG nào, để báo lỗi rõ ràng.
 * Lưu ý: regex KHÔNG dùng cờ `g` để `test()` không bị kẹt `lastIndex`.
 */
export const SECRET_PATTERNS: ReadonlyArray<{ type: string; pattern: RegExp }> = [
  { type: 'Khóa API OpenAI (sk-...)', pattern: /\bsk-[A-Za-z0-9]{16,}\b/ },
  { type: 'Khóa API xAI (xai-...)', pattern: /\bxai-[A-Za-z0-9]{16,}\b/ },
  { type: 'Khóa truy cập AWS (AKIA...)', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { type: 'Token GitHub (ghp_... / gho_... / github_pat_...)', pattern: /\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{20,}\b/ },
  { type: 'Token Slack (xox...)', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { type: 'Khóa riêng (private key)', pattern: /-----BEGIN (?:[A-Z ]*)PRIVATE KEY-----/ },
  { type: 'Token Bearer', pattern: /\bBearer\s+[A-Za-z0-9_\-.]{16,}\b/ },
  { type: 'Khóa API / token gán giá trị', pattern: /\b(?:api[_-]?key|apikey|access[_-]?token|secret[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,}['"]?/i },
  { type: 'Mật khẩu gán giá trị', pattern: /\b(?:password|passwd|pwd)\s*[:=]\s*['"]?\S{8,}['"]?/i },
];

/** Quét một đoạn text, trả về các phát hiện (file + dòng + loại, không giá trị). */
export function scanTextForSecrets(content: string, file: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const { type, pattern } of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        findings.push({ file, line: i + 1, type });
        break; // Một dòng chỉ báo một loại (loại đầu tiên khớp).
      }
    }
  }
  return findings;
}

/** Một file text có phải là file nên quét không (bỏ qua file nhị phân / quá lớn). */
function isScannableFile(absPath: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size > MAX_SCANNED_FILE_BYTES) return false;
  let buf: Buffer;
  try {
    buf = fs.readFileSync(absPath);
  } catch {
    return false;
  }
  // Chứa byte NUL → coi là nhị phân, không quét.
  return !buf.includes(0);
}

/**
 * Quét secret trong mọi file text dưới `dir` (đệ quy, bỏ qua `.git`).
 * Trả về `{ findings, scannedFiles }`. Đồng thời chạy `looksLikeSecret`
 * của loader trên SKILL.md để chốt chặn khớp với loader.
 */
export function scanSkillDirForSecrets(dir: string): {
  findings: SecretFinding[];
  scannedFiles: string[];
} {
  const findings: SecretFinding[] = [];
  const scannedFiles: string[] = [];
  const walk = (current: string, relBase: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;
      const abs = path.join(current, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile() && isScannableFile(abs)) {
        scannedFiles.push(rel);
        const content = fs.readFileSync(abs, 'utf8');
        findings.push(...scanTextForSecrets(content, rel));
      }
    }
  };
  walk(dir, '');
  return { findings, scannedFiles };
}

/** Một vị trí nghi chứa prompt injection trong nội dung skill. */
export interface InjectionFinding {
  /** File tương đối trong skill. */
  file: string;
  /** Mã mẫu đã khớp (vd `injection.ignore-instructions`). */
  code: string;
  /** Nhãn mẫu (vd "ignore previous instructions"). */
  label: string;
}

/**
 * v0.15 (H2 audit): quét nội dung skill bằng cùng mẫu prompt-injection
 * mà guardrail dùng cho user input (`INJECTION_PATTERNS` trong
 * guardrails/builtin). Skill độc hại có thể chứa chỉ dẫn ẩn ("bỏ qua mọi
 * hướng dẫn trước…") — vì skill được nối thẳng vào system prompt nên phải
 * chặn ngay lúc cài từ nguồn không tin cậy. Chỉ trả nhãn mẫu, không lộ
 * nội dung đã khớp.
 */
export function scanTextForInjection(content: string, file: string): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const pattern of INJECTION_PATTERNS) {
    // Compile mới mỗi lần (tránh shared /g lastIndex state) — giống
    // cách compile() trong guardrails/builtin.
    if (new RegExp(pattern.source, 'gi').test(content)) {
      findings.push({ file, code: pattern.code, label: pattern.label });
    }
  }
  return findings;
}

/** Quét toàn bộ file text trong thư mục skill để tìm prompt injection. */
export function scanSkillDirForInjection(dir: string): {
  findings: InjectionFinding[];
  scannedFiles: string[];
} {
  const findings: InjectionFinding[] = [];
  const scannedFiles: string[] = [];
  const walk = (current: string, relBase: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;
      const abs = path.join(current, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile() && isScannableFile(abs)) {
        scannedFiles.push(rel);
        const content = fs.readFileSync(abs, 'utf8');
        findings.push(...scanTextForInjection(content, rel));
      }
    }
  };
  walk(dir, '');
  return { findings, scannedFiles };
}

/** Gom các phát hiện injection thành message lỗi tiếng Việt (chỉ nhãn mẫu). */
function injectionFindingsMessage(findings: InjectionFinding[]): string {
  const lines = findings
    .slice(0, 20)
    .map((f) => `  - ${f.file}: ${f.label} (${f.code})`);
  const extra = findings.length > 20 ? `\n  ... và ${findings.length - 20} vị trí khác.` : '';
  return (
    `Phát hiện ${findings.length} mẫu prompt injection trong nội dung skill — đã DỪNG cài đặt, ` +
    `skill không được ghi vào máy. Skill chứa chỉ dẫn ẩn có thể lái agent (vd "bỏ qua hướng dẫn trước", "you are now…"). ` +
    `Chỉ cài skill từ nguồn đáng tin, hoặc gỡ các dòng sau rồi thử lại:\n${lines.join('\n')}${extra}`
  );
}

/** Gom các phát hiện thành message lỗi tiếng Việt (không lộ giá trị secret). */
function secretFindingsMessage(findings: SecretFinding[]): string {
  const lines = findings
    .slice(0, 20)
    .map((f) => `  - ${f.file}, dòng ${f.line}: ${f.type}`);
  const extra = findings.length > 20 ? `\n  ... và ${findings.length - 20} vị trí khác.` : '';
  return (
    `Phát hiện ${findings.length} vị trí nghi chứa secret — đã DỪNG cài đặt, ` +
    `skill không được ghi vào máy. Hãy xoá secret khỏi các file sau rồi thử lại:\n${lines.join('\n')}${extra}`
  );
}

// ---------------------------------------------------------------------------
// Tiện ích URL / tên skill
// ---------------------------------------------------------------------------

function assertHttpUrl(rawUrl: string, allowHosts?: string[]): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new MarketplaceError(`URL không hợp lệ: ${JSON.stringify(rawUrl)}.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new MarketplaceError(
      `Chỉ chấp nhận URL http(s), nhận được scheme ${JSON.stringify(url.protocol)} từ ${JSON.stringify(rawUrl)}.`,
    );
  }
  if (allowHosts && allowHosts.length > 0) {
    const host = url.hostname.toLowerCase();
    const ok = allowHosts.some((h) => h.toLowerCase() === host);
    if (!ok) {
      throw new MarketplaceError(
        `Host ${JSON.stringify(url.hostname)} không nằm trong danh sách host cho phép (${allowHosts.join(', ')}).`,
      );
    }
  }
  return url;
}

/** URL này có phải repo git không (clone bằng `git clone --depth 1`). */
export function isGitUrl(rawUrl: string): boolean {
  if (/^git@[^:]+:/.test(rawUrl)) return true;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (/\.git\/?$/.test(url.pathname)) return true;
    // Dạng rút gọn https://github.com/<owner>/<repo> (không có .git).
    if (/^(github\.com|gitlab\.com|codeberg\.org)$/.test(url.hostname)) {
      const parts = url.pathname.split('/').filter((p) => p.length > 0);
      if (parts.length === 2) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** URL này có trỏ tới file .zip không. */
export function isZipUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return /\.zip$/i.test(url.pathname);
  } catch {
    return /\.zip$/i.test(rawUrl);
  }
}

/** Chuẩn hoá tên skill về `[a-z0-9-]` (chữ thường, ký tự lạ → `-`). */
export function sanitizeSkillName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (cleaned === '') {
    throw new MarketplaceError(
      `Tên skill ${JSON.stringify(name)} không chuẩn hoá được thành tên hợp lệ (chỉ dùng chữ thường, số và "-").`,
    );
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Bộ đọc ZIP tối thiểu (stored + deflate, không dependency ngoài)
// ---------------------------------------------------------------------------

export interface ZipEntry {
  path: string;
  size: number;
  data: Buffer;
}

function readUInt32LE(buf: Buffer, off: number): number {
  return buf.readUInt32LE(off);
}
function readUInt16LE(buf: Buffer, off: number): number {
  return buf.readUInt16LE(off);
}

/**
 * Đọc file ZIP từ Buffer. Chỉ hỗ trợ entry `stored` (0) và `deflate` (8),
 * không hỗ trợ entry mã hoá. Chặn zip slip ngay tại đây: entry có `..`
 * hoặc đường dẫn tuyệt đối → lỗi; quá 500 file hoặc quá 50 MB sau giải
 * nén → lỗi.
 */
export function parseZip(buffer: Buffer): ZipEntry[] {
  if (buffer.length < 22) {
    throw new MarketplaceError('File tải về không phải là file ZIP hợp lệ (quá nhỏ, không tìm thấy End of Central Directory).');
  }
  if (buffer.subarray(buffer.length - 22, buffer.length - 18).toString('latin1') === 'PK\x05\x06') {
    return parseZipFromEocd(buffer, buffer.length - 22);
  }
  // EOCD có thể không nằm ở đúng 22 byte cuối khi có comment — quét ngược.
  {
    let eocd = -1;
    const min = Math.max(0, buffer.length - 22 - 65535);
    for (let i = buffer.length - 22; i >= min; i--) {
      if (buffer.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) {
      throw new MarketplaceError('File tải về không phải là file ZIP hợp lệ (không tìm thấy End of Central Directory).');
    }
    return parseZipFromEocd(buffer, eocd);
  }
}

function parseZipFromEocd(buffer: Buffer, eocd: number): ZipEntry[] {
  const totalEntries = readUInt16LE(buffer, eocd + 10);
  const cdOffset = readUInt32LE(buffer, eocd + 16);
  if (totalEntries > MAX_SKILL_FILES) {
    throw new MarketplaceError(
      `File ZIP chứa ${totalEntries} file, vượt giới hạn ${MAX_SKILL_FILES} file cho một skill.`,
    );
  }
  const entries: ZipEntry[] = [];
  let totalUncompressed = 0;
  let offset = cdOffset;
  for (let n = 0; n < totalEntries; n++) {
    if (offset + 46 > buffer.length || readUInt32LE(buffer, offset) !== 0x02014b50) {
      throw new MarketplaceError('File ZIP bị hỏng: Central Directory không hợp lệ.');
    }
    const flags = readUInt16LE(buffer, offset + 8);
    const method = readUInt16LE(buffer, offset + 10);
    const compressedSize = readUInt32LE(buffer, offset + 20);
    const uncompressedSize = readUInt32LE(buffer, offset + 24);
    const nameLen = readUInt16LE(buffer, offset + 28);
    const extraLen = readUInt16LE(buffer, offset + 30);
    const commentLen = readUInt16LE(buffer, offset + 32);
    const externalAttrs = readUInt32LE(buffer, offset + 38);
    const localHeaderOffset = readUInt32LE(buffer, offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;

    if ((flags & 0x1) !== 0) {
      throw new MarketplaceError(`File ZIP chứa entry mã hoá (${JSON.stringify(name)}) — không hỗ trợ, đã dừng.`);
    }
    // Bỏ qua entry thư mục và symlink (mode unix 0o120000 ở 16 bit cao).
    const isDir = name.endsWith('/');
    const isSymlink = ((externalAttrs >> 16) & 0o170000) === 0o120000;
    if (isDir || isSymlink) continue;

    const clean = name.replace(/\\/g, '/');
    const segments = clean.split('/');
    if (clean.startsWith('/') || segments.some((s) => s === '..')) {
      throw new MarketplaceError(
        `Phát hiện zip slip: entry ${JSON.stringify(name)} thoát khỏi thư mục đích — đã dừng giải nén.`,
      );
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_SKILL_UNCOMPRESSED_BYTES) {
      throw new MarketplaceError(
        `File ZIP giải nén ra quá ${MAX_SKILL_UNCOMPRESSED_BYTES / (1024 * 1024)} MB — đã dừng (nghi zip bomb).`,
      );
    }
    // Local file header: tìm vị trí bắt đầu dữ liệu.
    if (localHeaderOffset + 30 > buffer.length || readUInt32LE(buffer, localHeaderOffset) !== 0x04034b50) {
      throw new MarketplaceError(`File ZIP bị hỏng: Local File Header của ${JSON.stringify(name)} không hợp lệ.`);
    }
    const localNameLen = readUInt16LE(buffer, localHeaderOffset + 26);
    const localExtraLen = readUInt16LE(buffer, localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) {
      throw new MarketplaceError(`File ZIP bị hỏng: dữ liệu của ${JSON.stringify(name)} vượt quá cuối file.`);
    }
    const raw = buffer.subarray(dataStart, dataEnd);
    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      try {
        data = inflateRawSync(raw);
      } catch {
        throw new MarketplaceError(`Không giải nén được entry ${JSON.stringify(name)} (deflate hỏng).`);
      }
    } else {
      throw new MarketplaceError(
        `Entry ${JSON.stringify(name)} dùng phương thức nén không hỗ trợ (${method}) — chỉ hỗ trợ stored và deflate.`,
      );
    }
    if (data.length !== uncompressedSize) {
      throw new MarketplaceError(`Entry ${JSON.stringify(name)} có kích thước sau giải nén không khớp khai báo.`);
    }
    entries.push({ path: clean, size: data.length, data });
  }
  if (entries.length > MAX_SKILL_FILES) {
    throw new MarketplaceError(`File ZIP chứa quá ${MAX_SKILL_FILES} file cho một skill.`);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Tải / clone + staging (thư mục tạm, luôn dọn dẹp)
// ---------------------------------------------------------------------------

async function fetchWithTimeout(
  url: string,
  fetchFn: MarketplaceFetchFn,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: controller.signal });
    return res;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new MarketplaceError(`Tải từ ${JSON.stringify(url)} quá ${timeoutMs / 1000} giây — đã dừng.`);
    }
    throw new MarketplaceError(
      `Không tải được từ ${JSON.stringify(url)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function downloadZipBuffer(url: string, fetchFn: MarketplaceFetchFn): Promise<Buffer> {
  const res = await fetchWithTimeout(url, fetchFn, FETCH_TIMEOUT_MS);
  if (!res.ok) {
    throw new MarketplaceError(`Tải skill thất bại: server trả HTTP ${res.status} cho ${JSON.stringify(url)}.`);
  }
  const declared = res.headers?.get?.('content-length');
  if (declared !== null && declared !== undefined) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > MAX_SKILL_DOWNLOAD_BYTES) {
      throw new MarketplaceError(
        `File tải về lớn hơn giới hạn ${MAX_SKILL_DOWNLOAD_BYTES / (1024 * 1024)} MB (${(n / (1024 * 1024)).toFixed(1)} MB) — đã dừng.`,
      );
    }
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw new MarketplaceError(
      `Không đọc được nội dung tải về từ ${JSON.stringify(url)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (buf.length > MAX_SKILL_DOWNLOAD_BYTES) {
    throw new MarketplaceError(
      `File tải về lớn hơn giới hạn ${MAX_SKILL_DOWNLOAD_BYTES / (1024 * 1024)} MB (${(buf.length / (1024 * 1024)).toFixed(1)} MB) — đã dừng.`,
    );
  }
  if (buf.length === 0) {
    throw new MarketplaceError(`File tải về từ ${JSON.stringify(url)} rỗng.`);
  }
  return buf;
}

function cloneGitRepo(url: string, destDir: string): void {
  try {
    execFileSync('git', ['clone', '--depth', '1', url, destDir], {
      timeout: 60_000,
      stdio: 'pipe',
    });
  } catch (err) {
    const detail = err instanceof Error ? (err as { stderr?: unknown }).stderr ?? err.message : String(err);
    const text = typeof detail === 'string' ? detail : Buffer.isBuffer(detail) ? detail.toString('utf8') : '';
    throw new MarketplaceError(
      `Không clone được repo git từ ${JSON.stringify(url)}.` +
        (text.trim() ? ` Git báo: ${text.trim().slice(0, 300)}` : ' Hãy kiểm tra URL và quyền truy cập repo.'),
    );
  }
}

/** Liệt kê mọi file dưới `dir` (đệ quy, bỏ qua `.git`, đường dẫn tương đối dùng `/`). */
function listFilesRecursive(dir: string): Array<{ rel: string; abs: string; size: number }> {
  const out: Array<{ rel: string; abs: string; size: number }> = [];
  const walk = (current: string, relBase: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;
      const abs = path.join(current, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) {
        try {
          out.push({ rel, abs, size: fs.statSync(abs).size });
        } catch {
          // File biến mất giữa chừng — bỏ qua.
        }
      }
    }
  };
  walk(dir, '');
  return out;
}

/**
 * Tìm thư mục gốc của skill: nơi chứa SKILL.md — ở ngay gốc, hoặc trong
 * đúng một thư mục con cấp 1 (dạng archive GitHub: `<repo>/SKILL.md`).
 */
function findSkillRoot(stagedDir: string): string {
  const rootSkill = path.join(stagedDir, 'SKILL.md');
  if (fs.existsSync(rootSkill) && fs.statSync(rootSkill).isFile()) return stagedDir;
  let subdirs: string[] = [];
  try {
    subdirs = fs
      .readdirSync(stagedDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== '.git')
      .map((e) => e.name)
      .sort();
  } catch {
    subdirs = [];
  }
  const candidates = subdirs.filter((d) => {
    try {
      return fs.statSync(path.join(stagedDir, d, 'SKILL.md')).isFile();
    } catch {
      return false;
    }
  });
  if (candidates.length === 1) return path.join(stagedDir, candidates[0]!);
  if (candidates.length > 1) {
    throw new MarketplaceError(
      `Tìm thấy nhiều SKILL.md trong các thư mục con (${candidates.join(', ')}) — không rõ skill nào cần cài.`,
    );
  }
  throw new MarketplaceError(
    'Không tìm thấy SKILL.md trong gói tải về — gói này không phải là một skill hợp lệ (skill chuẩn cần file SKILL.md ở thư mục gốc).',
  );
}

/** Sao chép thư mục skill (đệ quy), bỏ qua symlink, báo warning cho mỗi symlink bị bỏ. */
function copySkillDir(src: string, dest: string, warnings: string[]): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      warnings.push(`Đã bỏ qua symlink ${JSON.stringify(entry.name)} (marketplace không cài symlink).`);
      continue;
    }
    if (entry.isDirectory()) {
      copySkillDir(srcPath, destPath, warnings);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

interface StagedSkill {
  /** Thư mục tạm chứa toàn bộ gói (dọn dẹp bởi caller). */
  tmpDir: string;
  /** Thư mục gốc của skill trong gói. */
  skillRoot: string;
  /** Manifest đã validate. */
  manifest: Skill;
  /** Mọi file trong skill (tương đối + kích thước). */
  files: SkillPreviewFile[];
  /** Nội dung README.md nếu có. */
  readme?: string;
  /** Các file đã quét secret. */
  scannedFiles: string[];
  /** Phát hiện prompt injection trong nội dung skill (v0.15, H2 audit). */
  injectionFindings: InjectionFinding[];
  /** Cảnh báo không chặn (tên chuẩn hoá, ...). */
  warnings: string[];
}

/**
 * Tải skill từ URL vào thư mục tạm, quét secret, validate manifest bằng
 * loader. KHÔNG cài gì cả — caller quyết định cài hay chỉ xem trước,
 * và phải dọn `tmpDir` trong `finally`.
 */
async function stageSkillFromUrl(
  rawUrl: string,
  opts: PreviewSkillOptions,
): Promise<StagedSkill> {
  const fetchFn: MarketplaceFetchFn =
    opts.fetchFn ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-skill-'));
  try {
    let skillRoot: string;
    if (isZipUrl(rawUrl)) {
      assertHttpUrl(rawUrl, opts.allowHosts);
      const buf = await downloadZipBuffer(rawUrl, fetchFn);
      const entries = parseZip(buf);
      if (entries.length === 0) {
        throw new MarketplaceError('File ZIP rỗng — không có file nào để cài.');
      }
      const extractDir = path.join(tmpDir, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });
      for (const entry of entries) {
        const dest = path.resolve(extractDir, entry.path);
        if (!dest.startsWith(path.resolve(extractDir) + path.sep)) {
          throw new MarketplaceError(
            `Phát hiện zip slip: entry ${JSON.stringify(entry.path)} thoát khỏi thư mục đích — đã dừng giải nén.`,
          );
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, entry.data);
      }
      skillRoot = findSkillRoot(extractDir);
    } else if (isGitUrl(rawUrl)) {
      // Clone qua SSH (git@...) không qua HTTP; clone http(s) vẫn kiểm tra host.
      if (!/^git@[^:]+:/.test(rawUrl)) assertHttpUrl(rawUrl, opts.allowHosts);
      const cloneDir = path.join(tmpDir, 'repo');
      cloneGitRepo(rawUrl, cloneDir);
      skillRoot = findSkillRoot(cloneDir);
    } else {
      throw new MarketplaceError(
        `URL ${JSON.stringify(rawUrl)} không trỏ tới file .zip hay repo git. ` +
          `Marketplace chỉ hỗ trợ: (a) URL file .zip, (b) URL repo git (kết thúc bằng .git hoặc dạng https://github.com/<owner>/<repo>).`,
      );
    }

    // Quét secret TRƯỚC KHI validate/cài — phát hiện là dừng ngay.
    const { findings, scannedFiles } = scanSkillDirForSecrets(skillRoot);
    if (findings.length > 0) {
      throw new MarketplaceError(secretFindingsMessage(findings));
    }

    // v0.15 (H2 audit): quét prompt injection trong nội dung skill — kết
    // quả giữ trong staged: preview chỉ cảnh báo, install từ chối.
    const injection = scanSkillDirForInjection(skillRoot);

    // Validate manifest bằng loader hiện có (kiểm tra frontmatter, tên,
    // mô tả, body rỗng, và chốt chặn secret của loader trên SKILL.md).
    const skillFile = path.join(skillRoot, 'SKILL.md');
    let skillText: string;
    try {
      skillText = fs.readFileSync(skillFile, 'utf8');
    } catch {
      throw new MarketplaceError('Không đọc được SKILL.md trong gói tải về.');
    }
    if (looksLikeSecret(skillText)) {
      // Lẽ ra đã bị bắt ở bước quét; đây là chốt chặn thứ hai khớp loader.
      throw new MarketplaceError(
        'SKILL.md chứa nội dung giống secret (theo bộ kiểm tra của loader) — đã DỪNG cài đặt. Hãy xoá secret khỏi SKILL.md rồi thử lại.',
      );
    }
    // Chuẩn hoá tên TRƯỚC KHI validate: loader từ chối tên có chữ hoa /
    // ký tự ngoài [a-z0-9_-], nên tên phải về dạng [a-z0-9-] trước rồi
    // mới đưa qua loader (và bản cài phải load lại được với tên đó).
    const warnings: string[] = [];
    const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(skillText);
    const rawNameMatch = fmMatch ? /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(fmMatch[1]!) : null;
    if (rawNameMatch) {
      const rawName = rawNameMatch[1]!.trim();
      const sanitized = sanitizeSkillName(rawName);
      if (sanitized !== rawName) {
        warnings.push(
          `Tên skill ${JSON.stringify(rawName)} đã được chuẩn hoá thành ${JSON.stringify(sanitized)} để khớp quy tắc tên skill.`,
        );
        // Viết lại tên trong frontmatter của bản staged để bản cài load
        // lại được (loader yêu cầu tên skill khớp tên thư mục).
        skillText = skillText.replace(
          /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/,
          (whole, fm: string) => {
            const newFm = fm.replace(/^name:\s*.*$/m, `name: ${sanitized}`);
            return whole.replace(fm, newFm);
          },
        );
        // Ghi lại bản đã chuẩn hoá tên để bản cài trên đĩa khớp tên thư mục.
        fs.writeFileSync(skillFile, skillText, 'utf8');
      }
    }
    let manifest: Skill;
    try {
      manifest = parseSkillMarkdown(skillText, 'user', skillFile, undefined, skillRoot);
    } catch (err) {
      throw new MarketplaceError(
        `Skill tải về không hợp lệ: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const files = listFilesRecursive(skillRoot).map(({ rel, size }) => ({ path: rel, size }));
    if (files.length > MAX_SKILL_FILES) {
      throw new MarketplaceError(`Skill chứa ${files.length} file, vượt giới hạn ${MAX_SKILL_FILES} file.`);
    }
    let readme: string | undefined;
    const readmeEntry = files.find((f) => f.path.toLowerCase() === 'readme.md');
    if (readmeEntry) {
      try {
        readme = fs.readFileSync(path.join(skillRoot, readmeEntry.path), 'utf8').slice(0, 20_000);
      } catch {
        readme = undefined;
      }
    }
    return { tmpDir, skillRoot, manifest, files, readme, scannedFiles, injectionFindings: injection.findings, warnings };
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// API công khai
// ---------------------------------------------------------------------------

/**
 * Chỉ tải + quét + trả preview, KHÔNG cài. Dùng cho UI duyệt trước khi
 * người dùng quyết định cài.
 */
export async function previewSkillFromUrl(
  url: string,
  opts: PreviewSkillOptions = {},
): Promise<SkillPreview> {
  const staged = await stageSkillFromUrl(url, opts);
  try {
    return {
      skillName: sanitizeSkillName(staged.manifest.name),
      manifest: staged.manifest,
      files: staged.files,
      readme: staged.readme,
      sourceUrl: url,
      // v0.15 (H2 audit): preview chỉ cảnh báo, không chặn xem trước.
      injectionWarnings:
        staged.injectionFindings.length > 0
          ? staged.injectionFindings.map((f) => `${f.file}: ${f.label} (${f.code})`)
          : undefined,
    };
  } finally {
    fs.rmSync(staged.tmpDir, { recursive: true, force: true });
  }
}

/**
 * Tải skill từ URL và cài vào `skillsDir/<tên-skill>`.
 * Thứ tự: tải → quét secret (phát hiện là dừng) → validate manifest bằng
 * loader → kiểm tra trùng tên → sao chép → load lại bằng loader để xác nhận.
 * Không chạy bất kỳ script/lệnh nào trong skill.
 */
export async function installSkillFromUrl(
  url: string,
  opts: InstallSkillOptions,
): Promise<InstallSkillResult> {
  if (!opts.skillsDir || typeof opts.skillsDir !== 'string') {
    throw new MarketplaceError('Thiếu `skillsDir`: cần thư mục đích để cài skill.');
  }
  const staged = await stageSkillFromUrl(url, opts);
  try {
    // v0.15 (H2 audit): skill chứa mẫu prompt injection thì TỪ CHỐI cài —
    // skill độc hại nối vào system prompt sẽ lái agent.
    if (staged.injectionFindings.length > 0) {
      throw new MarketplaceError(injectionFindingsMessage(staged.injectionFindings));
    }
    const skillName = sanitizeSkillName(staged.manifest.name);
    const installedPath = path.join(path.resolve(opts.skillsDir), skillName);
    if (fs.existsSync(installedPath)) {
      if (!opts.overwrite) {
        throw new MarketplaceError(
          `Skill ${JSON.stringify(skillName)} đã tồn tại tại ${JSON.stringify(installedPath)}. ` +
            `Dùng tuỳ chọn overwrite: true để ghi đè, hoặc gỡ skill cũ trước.`,
        );
      }
      fs.rmSync(installedPath, { recursive: true, force: true });
    }
    const warnings = [...staged.warnings];
    fs.mkdirSync(path.resolve(opts.skillsDir), { recursive: true });
    copySkillDir(staged.skillRoot, installedPath, warnings);
    // Xác nhận bản cài load lại được bằng loader hiện có.
    try {
      loadSkillDir(installedPath, 'user');
    } catch (err) {
      fs.rmSync(installedPath, { recursive: true, force: true });
      throw new MarketplaceError(
        `Skill đã sao chép nhưng không load lại được bằng loader — đã gỡ bản cài lỗi: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { installedPath, manifest: staged.manifest, scannedFiles: staged.scannedFiles, warnings };
  } finally {
    fs.rmSync(staged.tmpDir, { recursive: true, force: true });
  }
}
