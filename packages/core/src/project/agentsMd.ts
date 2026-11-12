/**
 * AGENTS.md theo thứ bậc thư mục (v0.34, P1-6).
 *
 * Pattern học từ Claude Code (`CLAUDE.md`/`AGENTS.md`): mỗi thư mục trong
 * workspace có thể mang file quy tắc riêng, và agent đọc tất cả các file
 * trên đường từ gốc workspace xuống thư mục làm việc hiện tại. File ở
 * thư mục cha áp dụng cho thư mục con; file ở thư mục gần thư mục làm
 * việc hơn được ưu tiên khi xung đột (đứng sau trong nội dung gộp, và
 * được ghi rõ nguồn để model biết thứ tự ưu tiên).
 *
 * Quy tắc chuỗi thư mục:
 * - Chuỗi = workspaceDir -> ... -> cwd (cwd mặc định là workspaceDir).
 *   Chuỗi DỪNG ở gốc workspace: không đọc AGENTS.md của thư mục cha
 *   ngoài workspace (tránh rò quy tắc của project khác vào run này).
 * - cwd nằm ngoài workspaceDir thì chỉ dùng workspaceDir (fail-closed,
 *   ghi rõ trong kết quả qua `cwd` trả về).
 * - Mỗi thư mục trong chuỗi đóng góp tối đa MỘT file: `.open-bot/AGENTS.md`
 *   ưu tiên hơn `AGENTS.md` trong cùng thư mục (giữ hành vi v0.11).
 * - File rỗng/chỉ có khoảng trắng bị bỏ qua. File không phải file thường
 *   (thư mục, ...) bị bỏ qua.
 * - Symlink: file có realpath nằm ngoài workspaceDir (đã realpath) bị
 *   bỏ qua và ghi vào `skipped` — AGENTS.md là dữ liệu đưa vào prompt
 *   nên không được phép đọc lén file ngoài workspace qua symlink.
 *
 * Giới hạn kích thước (chống phình context):
 * - Mỗi file tối đa MAX_AGENTS_MD_CHARS_PER_FILE ký tự (cắt ngắn + cờ
 *   `truncated` từng file + ghi vào `truncatedFiles`).
 * - Nội dung gộp tối đa MAX_AGENTS_MD_TOTAL_CHARS ký tự: vượt thì bỏ
 *   toàn bộ section CŨ nhất trước (file gần thư mục làm việc được giữ
 *   lại), ghi vào `skipped` với lý do rõ ràng.
 *
 * Cache: keyed theo (workspaceDir, cwd); mỗi lần load stat lại toàn bộ
 * file trong chuỗi (mtimeMs + size) và so chữ ký — file thêm/bớt/đổi
 * đều làm cache mất hiệu lực, nên run mới luôn thấy file mới nhất mà
 * không cần hot-reload trong run. `clearAgentsMdCache()` ép đọc lại.
 * Không có file nào -> trả null (workspace không có quy tắc là bình
 * thường, không phải lỗi). Hàm không throw với file thiếu/không đọc
 * được; chỉ throw khi workspaceDir rỗng (lỗi lập trình của caller).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Tên file quy tắc trong mỗi thư mục. */
export const AGENTS_MD_FILENAME = 'AGENTS.md';

/** Thư mục cấu hình trong mỗi thư mục — AGENTS.md ở đây ưu tiên hơn ở cùng thư mục. */
export const AGENTS_MD_CONFIG_DIR = '.open-bot';

/** Ký tự tối đa lấy từ MỖI file AGENTS.md. */
export const MAX_AGENTS_MD_CHARS_PER_FILE = 8000;

/** Ký tự tối đa của nội dung gộp (mọi file + tiêu đề nguồn). */
export const MAX_AGENTS_MD_TOTAL_CHARS = 16000;

/** Một file AGENTS.md đã nạp (nội dung có thể đã cắt ngắn). */
export interface AgentsMdSource {
  /** Đường dẫn tuyệt đối tới file đã đọc. */
  path: string;
  /** Đường dẫn tương đối so với workspaceDir (vd `AGENTS.md`, `sub/AGENTS.md`). */
  relative: string;
  /** Nội dung file (đã cắt ngắn nếu `truncated`). */
  content: string;
  /** True khi file dài hơn MAX_AGENTS_MD_CHARS_PER_FILE. */
  truncated: boolean;
}

/** Một file/candidate bị bỏ qua kèm lý do (để debug). */
export interface AgentsMdSkipped {
  /** Đường dẫn tuyệt đối tới file bị bỏ qua. */
  path: string;
  /** Lý do bỏ qua (tiếng Việt, không chứa nội dung file). */
  reason: string;
}

/** Kết quả load AGENTS.md theo thứ bậc — nội dung gộp + nguồn từng file. */
export interface AgentsMdResult {
  /** Nội dung gộp: các section theo thứ tự tổ tiên -> gần nhất, mỗi section có tiêu đề nguồn. */
  content: string;
  /** Các file đã nạp, theo thứ tự tổ tiên -> gần thư mục làm việc nhất. */
  sources: AgentsMdSource[];
  /** True khi có ít nhất một file bị cắt ngắn hoặc section bị bỏ để vừa tổng giới hạn. */
  truncated: boolean;
  /** Đường dẫn tương đối (so với workspaceDir) của các file bị cắt ngắn. */
  truncatedFiles: string[];
  /** File bị bỏ qua kèm lý do (symlink ra ngoài workspace, rỗng, vượt tổng giới hạn...). */
  skipped: AgentsMdSkipped[];
  /** WorkspaceDir đã resolve (tuyệt đối). */
  workspaceDir: string;
  /** Thư mục làm việc hiện tại đã resolve (tuyệt đối). */
  cwd: string;
}

interface CacheEntry {
  /** Chữ ký của chuỗi: danh sách {path, mtimeMs, size} của file tìm thấy + danh sách thư mục. */
  signature: string;
  result: AgentsMdResult | null;
}

const cache = new Map<string, CacheEntry>();

/** Xoá toàn bộ cache (test / sau khi host vừa lưu file). */
export function clearAgentsMdCache(): void {
  cache.clear();
}

/**
 * Chuỗi thư mục từ workspaceDir xuống cwd (bao gồm cả hai đầu), theo
 * thứ tự tổ tiên -> gần nhất. cwd mặc định là workspaceDir; cwd nằm
 * ngoài workspaceDir thì chuỗi chỉ còn [workspaceDir].
 */
export function findAgentsMdChain(workspaceDir: string, cwd?: string): string[] {
  const root = path.resolve((workspaceDir ?? '').trim());
  if (!root) return [];
  const leafRaw = (cwd ?? '').trim();
  const leaf = leafRaw ? path.resolve(leafRaw) : root;
  const rel = path.relative(root, leaf);
  // cwd ngoài workspace: relative bắt đầu bằng '..' (hoặc là tuyệt đối khác ổ trên Windows).
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return [root];
  }
  const chain: string[] = [root];
  if (rel === '') return chain;
  const parts = rel.split(path.sep);
  let cur = root;
  for (const part of parts) {
    cur = path.join(cur, part);
    chain.push(cur);
  }
  return chain;
}

/** Candidate trong một thư mục, theo thứ tự ưu tiên: `.open-bot/AGENTS.md` rồi `AGENTS.md`. */
function candidatesInDir(dir: string): string[] {
  return [
    path.join(dir, AGENTS_MD_CONFIG_DIR, AGENTS_MD_FILENAME),
    path.join(dir, AGENTS_MD_FILENAME),
  ];
}

/** File có phải file thường không (thư mục trùng tên thì bỏ qua). */
function statIfFile(abs: string): fs.Stats | null {
  try {
    const st = fs.statSync(abs);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

/**
 * Load AGENTS.md theo thứ bậc thư mục (cached theo mtime+size).
 * Trả null khi không có file nào nạp được. Không throw với file
 * thiếu/không đọc được; chỉ throw khi workspaceDir rỗng.
 */
export function loadAgentsMd(
  workspaceDir: string,
  opts: { cwd?: string; forceRefresh?: boolean } = {},
): AgentsMdResult | null {
  const trimmed = (workspaceDir ?? '').trim();
  if (!trimmed) throw new Error('loadAgentsMd cần workspaceDir (string, không rỗng).');
  const root = path.resolve(trimmed);
  const chain = findAgentsMdChain(root, opts.cwd);
  const leaf = chain[chain.length - 1];
  const cacheKey = `${root}\0${leaf}`;

  // Realpath của gốc workspace — mốc để kiểm tra symlink không thoát ra ngoài.
  let realRoot: string | null = null;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    realRoot = null;
  }

  // Stat toàn bộ candidate để dựng chữ ký cache (rẻ, không đọc nội dung).
  interface FoundFile {
    abs: string;
    stat: fs.Stats;
  }
  const found: FoundFile[] = [];
  for (const dir of chain) {
    for (const abs of candidatesInDir(dir)) {
      const st = statIfFile(abs);
      if (st) {
        found.push({ abs, stat: st });
        break; // Mỗi thư mục tối đa một file (candidate đầu tiên trúng).
      }
    }
  }
  const signature = JSON.stringify({
    chain,
    files: found.map((f) => ({ p: f.abs, m: f.stat.mtimeMs, s: f.stat.size })),
  });
  if (!opts.forceRefresh) {
    const cached = cache.get(cacheKey);
    if (cached && cached.signature === signature) return cached.result;
  }

  const sources: AgentsMdSource[] = [];
  const skipped: AgentsMdSkipped[] = [];
  const truncatedFiles: string[] = [];
  for (const { abs } of found) {
    // Chặn symlink đọc file ngoài workspace.
    if (realRoot) {
      let realFile: string | null = null;
      try {
        realFile = fs.realpathSync(abs);
      } catch {
        realFile = null;
      }
      const relReal = realFile ? path.relative(realRoot, realFile) : null;
      if (
        !realFile ||
        relReal === null ||
        relReal === '..' ||
        relReal.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relReal)
      ) {
        skipped.push({ path: abs, reason: 'nằm ngoài workspace (symlink) nên bỏ qua' });
        continue;
      }
    }
    let raw: string;
    try {
      raw = fs.readFileSync(abs, 'utf8');
    } catch {
      skipped.push({ path: abs, reason: 'không đọc được file' });
      continue;
    }
    if (raw.trim() === '') {
      skipped.push({ path: abs, reason: 'file rỗng nên bỏ qua' });
      continue;
    }
    const relative = path.relative(root, abs);
    const truncated = raw.length > MAX_AGENTS_MD_CHARS_PER_FILE;
    if (truncated) truncatedFiles.push(relative);
    const content = truncated
      ? raw.slice(0, MAX_AGENTS_MD_CHARS_PER_FILE) +
        `\n\n[... AGENTS.md đã rút gọn: chỉ lấy ${MAX_AGENTS_MD_CHARS_PER_FILE} ký tự đầu ...]`
      : raw;
    sources.push({ path: abs, relative, content, truncated });
  }

  if (sources.length === 0) {
    // Không có file nạp được -> coi như không có quy tắc (null), nhưng
    // vẫn cache chữ ký để lần sau file xuất hiện thì đọc lại.
    cache.set(cacheKey, { signature, result: null });
    return null;
  }

  // Gộp các section theo thứ tự tổ tiên -> gần nhất; mỗi section có tiêu
  // đề nguồn để model biết file nào gần thư mục làm việc hơn (ưu tiên hơn).
  interface Section {
    source: AgentsMdSource;
    text: string;
  }
  const sections: Section[] = sources.map((s) => ({
    source: s,
    text: `\n\n---\n[AGENTS.md: ${s.relative}]\n${s.content}`,
  }));
  let total = sections.reduce((n, s) => n + s.text.length, 0);
  let truncatedByTotal = false;
  // Vượt tổng giới hạn: bỏ section CŨ nhất trước, giữ file gần nhất.
  while (total > MAX_AGENTS_MD_TOTAL_CHARS && sections.length > 1) {
    const dropped = sections.shift();
    if (!dropped) break;
    total -= dropped.text.length;
    truncatedByTotal = true;
    skipped.push({
      path: dropped.source.path,
      reason: `bỏ qua để vừa tổng giới hạn ${MAX_AGENTS_MD_TOTAL_CHARS} ký tự`,
    });
  }
  const keptSources = sections.map((s) => s.source);
  const content =
    '[Quy tắc workspace — file ở thư mục gần thư mục làm việc hơn được ưu tiên khi xung đột.]\n' +
    sections.map((s) => s.text).join('');
  const result: AgentsMdResult = {
    content,
    sources: keptSources,
    truncated: truncatedFiles.length > 0 || truncatedByTotal,
    truncatedFiles,
    skipped,
    workspaceDir: root,
    cwd: leaf,
  };
  cache.set(cacheKey, { signature, result });
  return result;
}
