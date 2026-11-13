/**
 * Repo map (v0.96, Đội T2): bản đồ kho code cho agent — file nào quan
 * trọng nhất với lượt chat hiện tại, và chỉ đưa đúng những signature
 * cần thiết vào prompt thay vì cả file.
 *
 * Nguyên lý (học ý tưởng kiểu Aider repo map, tự thiết kế + viết lại
 * hoàn toàn từ đầu — KHÔNG đọc, KHÔNG copy code/text/tài sản của Aider
 * hay bất kỳ repo nào khác):
 *   1. trích symbol (definitions) + references bằng tree-sitter đã có
 *      sẵn ở `./code/ast` (TS/TSX/JS/JSX/Python);
 *   2. dựng đồ thị: node = file, cạnh A → B khi A tham chiếu tới
 *      symbol do B định nghĩa (hoặc import trực tiếp B), trọng số =
 *      sqrt(số reference) nhân các hệ số bên dưới;
 *   3. xếp hạng bằng Personalized PageRank tự viết (power iteration,
 *      damping 0.85, 50 vòng) với personalization dồn vào file đang
 *      chat;
 *   4. cắt theo token budget bằng binary search trên số file top-rank;
 *   5. render kiểu TreeContext: mỗi file chỉ hiện signature + dòng
 *      định nghĩa, thân hàm elided thành `...`.
 *
 * Hệ số nhân trọng số cạnh (áp dụng nhân dồn khi cùng đúng nhiều điều
 * kiện, theo đúng đặc tả sóng v0.96):
 *   - file đích đang nằm trong chat (chatFiles): 50x;
 *   - ident được nhắc tới trong hội thoại (mentionedIdents): 10x;
 *   - ident dài, snake_case/camelCase dài từ 8 ký tự: 10x (tên dài
 *     thường là tên riêng của dự án, ít trùng tên chung);
 *   - tên bắt đầu `_` (private/internal): 0.1x.
 *
 * Personalization: mỗi file trong chat nhận khối lượng 100/len(chatFiles)
 * (tổng 100, chuẩn hoá về tổng 1 khi chạy PageRank); không có file nào
 * trong chat thì personalization đều trên mọi file VÀ budget nhân 8x
 * (map chung chung cần rộng hơn để model tự tìm).
 *
 * Ước lượng token: chars/4 (cùng heuristic với phần còn lại của repo).
 *
 * Cache: parse kết quả cache theo (đường dẫn, mtimeMs, size) — file
 * không đổi thì turn sau không parse lại; file đổi thì parse lại.
 *
 * Giới hạn trung thực (ghi cả trong mô tả tool):
 *   - chỉ TS/TSX/JS/JSX/Python (grammar tree-sitter đã cài); ngôn ngữ
 *     khác không được quét — file đó đơn giản không có trong map;
 *   - references đếm bằng token identifier trên toàn bộ source (kể cả
 *     trong string/comment) nên có thể đếm thừa; import tương đối được
 *     resolve chính xác, import tuyệt đối/bare (`'react'`, `'lodash'`)
 *     bị bỏ qua vì trỏ ra ngoài repo;
 *   - tối đa 2000 file / file tối đa 1 MB — vượt thì phần thừa bị
 *     lược và báo rõ số lượng trong kết quả;
 *   - signature chỉ lấy dòng định nghĩa đầu tiên (hàm khai báo nhiều
 *     dòng chỉ hiện dòng đầu + `...`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolContext } from '@open-bot/core';
import { detectAstLanguage, parseCodeSymbols } from './code/ast';
import type { AstLanguage, CodeSymbol } from './code/ast';
import { resolveWithin } from './sandbox';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

// ---------------------------------------------------------------------------
// Hằng số (đặc tả sóng v0.96)
// ---------------------------------------------------------------------------

/** Token budget mặc định cho một repo map chèn vào prompt. */
export const DEFAULT_REPO_MAP_TOKEN_BUDGET = 1024;
/** Không có file nào trong chat thì budget nhân hệ số này (map chung). */
export const NO_CHAT_FILES_BUDGET_MULTIPLIER = 8;
/** Damping factor của PageRank. */
export const REPO_MAP_DAMPING = 0.85;
/** Số vòng power iteration. */
export const REPO_MAP_ITERATIONS = 50;
/** Tổng khối lượng personalization (100) chia đều cho file trong chat. */
export const CHAT_PERSONALIZATION_MASS = 100;
/** Hệ số nhân khi file đích đang nằm trong chat. */
export const CHAT_FILE_MULTIPLIER = 50;
/** Hệ số nhân khi ident được nhắc trong hội thoại. */
export const MENTIONED_IDENT_MULTIPLIER = 10;
/** Độ dài tối thiểu để một ident được coi là "dài" (tên riêng dự án). */
export const LONG_IDENT_MIN_LENGTH = 8;
/** Hệ số nhân khi ident dài (>= 8 ký tự). */
export const LONG_IDENT_MULTIPLIER = 10;
/** Hệ số nhân khi tên bắt đầu `_` (private/internal). */
export const PRIVATE_IDENT_MULTIPLIER = 0.1;
/** Số file tối đa quét trong một lần build map. */
export const MAX_REPO_MAP_FILES = 2000;
/** File lớn hơn ngưỡng này bị bỏ qua (không parse). */
export const MAX_REPO_MAP_FILE_BYTES = 1_000_000;
/** Số ký tự tối đa của một dòng signature trong render. */
export const MAX_SIGNATURE_CHARS = 160;
/** Đóng góp cố định của một câu import trực tiếp (tương đương ~4 reference). */
export const IMPORT_REFERENCE_WEIGHT = 4;

/** Thư mục không bao giờ quét (phụ thuộc, build output, dữ liệu máy). */
export const REPO_MAP_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.open-bot',
  '.turbo',
]);

/** Đuôi file được quét — đúng tập grammar tree-sitter đã cài. */
export const REPO_MAP_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
]);

// ---------------------------------------------------------------------------
// Kiểu dữ liệu
// ---------------------------------------------------------------------------

/** Một symbol đã trích, kèm dòng signature để render. */
export interface RepoMapSymbol extends CodeSymbol {
  /** Dòng định nghĩa đã trim (vd `export function foo(a: string) {`). */
  signature: string;
}

/** Một file đã parse xong trong map. */
export interface RepoMapFile {
  /** Đường dẫn tương đối so với root (dùng `/` làm separator). */
  rel: string;
  /** Đường dẫn tuyệt đối. */
  abs: string;
  language: AstLanguage;
  symbols: RepoMapSymbol[];
  /** Tên symbol do file này định nghĩa (để tra cứu ngược khi đếm ref). */
  definedNames: Set<string>;
  /** Số lần mỗi identifier xuất hiện trong file (kể cả định nghĩa). */
  identCounts: Map<string, number>;
  /** Import specifier thô tìm được trong file. */
  importSpecifiers: string[];
  /** true khi file lỗi cú pháp nhưng vẫn parse được phần nào. */
  hasError: boolean;
  /** true khi parse bằng regex fallback (tree-sitter lỗi). */
  fallback: boolean;
}

/** Một cạnh có hướng trong đồ thị file. */
export interface RepoMapEdge {
  /** Index file nguồn trong `RepoMapResult.files`. */
  from: number;
  /** Index file đích trong `RepoMapResult.files`. */
  to: number;
  /** Tổng số reference thô (chưa sqrt, chưa nhân hệ số). */
  rawReferences: number;
  /** Trọng số cuối: sqrt(raw * hệ số ident) * hệ số file chat. */
  weight: number;
}

export interface BuildRepoMapOptions {
  /** Token budget cho render; mặc định 1024 (x8 khi không có chatFiles). */
  tokenBudget?: number;
  /** File đang nằm trong chat (đường dẫn tương đối so với root). */
  chatFiles?: string[];
  /** Ident được nhắc trong hội thoại (đã trích, hoặc để map tự trích từ userText). */
  mentionedIdents?: string[];
  /** Tin nhắn user hiện tại — dùng để trích mentionedIdents khi không truyền sẵn. */
  userText?: string;
  /** Số file tối đa quét; mặc định 2000. */
  maxFiles?: number;
  /** Bỏ qua cache parse (chủ yếu cho test). */
  bypassCache?: boolean;
}

export interface RepoMapResult {
  rootDir: string;
  files: RepoMapFile[];
  edges: RepoMapEdge[];
  /** Điểm PageRank theo index file (tổng = 1). */
  scores: number[];
  /** Index file xếp theo điểm giảm dần (hoà thì đường dẫn tăng dần). */
  ranked: number[];
  /** Render TreeContext của top-k file vừa budget. */
  rendered: string;
  /** Số file trong render. */
  renderedFiles: number;
  /** Token ước lượng (chars/4) của `rendered`. */
  tokenEstimate: number;
  /** Budget đã áp (sau nhân 8x nếu không có chatFiles). */
  budget: number;
  /** Số file đã quét (kể cả file bị lược vì quá lớn). */
  filesScanned: number;
  /** Số file bị lược vì vượt giới hạn (quá lớn / vượt maxFiles). */
  filesSkipped: number;
  /** Số file lấy từ cache parse (không parse lại). */
  cacheHits: number;
  /** Thời gian build (ms, wall-clock). */
  buildMs: number;
  /** true khi render đã cắt bớt file vì budget. */
  truncatedByBudget: boolean;
}

export interface RepoMapSectionOptions extends BuildRepoMapOptions {
  /** false = tắt hẳn (coordinator tôn trọng cờ này của bot). */
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Ước lượng token
// ---------------------------------------------------------------------------

/** Ước lượng token theo heuristic chars/4 (cùng chuẩn với repo). */
export function estimateRepoMapTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Quét file
// ---------------------------------------------------------------------------

function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}

function isSupportedRepoFile(filePath: string): boolean {
  return REPO_MAP_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Liệt kê file nguồn dưới root (đệ quy, bỏ thư mục skip, bỏ file quá
 * lớn). Trả danh sách đã sắp xếp theo đường dẫn tương đối để kết quả
 * ổn định giữa các lần chạy. `skippedOversize` đếm file bị lược vì
 * vượt `MAX_REPO_MAP_FILE_BYTES`; `skippedOverCap` đếm file bị lược
 * vì vượt `maxFiles`.
 */
export function discoverRepoFiles(
  rootDir: string,
  maxFiles: number = MAX_REPO_MAP_FILES,
): { relPaths: string[]; scanned: number; skippedOversize: number; skippedOverCap: number } {
  const relPaths: string[] = [];
  let scanned = 0;
  let skippedOversize = 0;
  const walk = (dir: string, relBase: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // thư mục không đọc được: bỏ qua, không chặn map.
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (REPO_MAP_SKIP_DIRS.has(entry.name)) continue;
        if (entry.isSymbolicLink()) continue;
        walk(path.join(dir, entry.name), rel);
      } else if (entry.isFile() && isSupportedRepoFile(entry.name)) {
        scanned += 1;
        let size = 0;
        try {
          size = fs.statSync(path.join(dir, entry.name)).size;
        } catch {
          continue;
        }
        if (size > MAX_REPO_MAP_FILE_BYTES) {
          skippedOversize += 1;
          continue;
        }
        relPaths.push(rel);
      }
    }
  };
  walk(rootDir, '');
  relPaths.sort();
  let skippedOverCap = 0;
  if (relPaths.length > maxFiles) {
    skippedOverCap = relPaths.length - maxFiles;
    relPaths.length = maxFiles;
  }
  return { relPaths, scanned, skippedOversize, skippedOverCap };
}

// ---------------------------------------------------------------------------
// Regex fallback: chỉ dùng khi tree-sitter lỗi (grammar thiếu/hỏng).
// Trích definitions bằng regex — kém chính xác hơn AST (không có scope
// lồng, không có vị trí cột) nhưng vẫn cho map hoạt động thay vì rỗng.
// ---------------------------------------------------------------------------

/** Từ khoá / tên không bao giờ là ident nhắc tới (JS/TS/Python). */
const IDENT_STOPWORDS = new Set([
  // JS/TS
  'const', 'let', 'var', 'function', 'class', 'extends', 'return', 'if', 'else',
  'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'new', 'delete',
  'typeof', 'instanceof', 'in', 'of', 'try', 'catch', 'finally', 'throw',
  'import', 'export', 'from', 'default', 'async', 'await', 'yield', 'this',
  'super', 'static', 'get', 'set', 'void', 'null', 'undefined', 'true', 'false',
  'interface', 'type', 'enum', 'namespace', 'implements', 'readonly', 'private',
  'protected', 'public', 'abstract', 'declare', 'as', 'is', 'keyof', 'infer',
  // Python
  'def', 'lambda', 'pass', 'raise', 'with', 'as', 'global', 'nonlocal', 'assert',
  'and', 'or', 'not', 'is', 'none', 'print', 'self', 'cls', 'elif', 'except',
  // chung
  'string', 'number', 'boolean', 'object', 'array', 'int', 'str', 'bool', 'list',
  'dict', 'console', 'require', 'module', 'exports', 'process', 'buffer',
]);

export function isIdentStopword(name: string): boolean {
  return IDENT_STOPWORDS.has(name);
}

/**
 * Đếm identifier trong source bằng regex token. Không tách string /
 * comment (ghi rõ trong giới hạn): số đếm có thể thừa nhẹ, nhưng thứ
 * hạng PageRank dùng sqrt nên nhiễu này bị nén.
 */
export function countIdents(source: string): Map<string, number> {
  const counts = new Map<string, number>();
  const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const name = m[0];
    if (isIdentStopword(name)) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

interface FallbackSymbol {
  kind: CodeSymbol['kind'];
  name: string;
  qualifiedName: string;
  line: number;
  signature: string;
}

/**
 * Trích symbol bằng regex khi tree-sitter không dùng được. Python:
 * `def`/`class` ở đầu dòng (kèm scope class theo indent). JS/TS:
 * `function`/`class`/`interface`/`type`/`enum` + `const x = () =>`
 * / `const x = function`. Trả `line` 1-based và signature = dòng đó.
 */
export function extractSymbolsRegexFallback(
  source: string,
  language: AstLanguage,
): FallbackSymbol[] {
  const lines = source.split('\n');
  const out: FallbackSymbol[] = [];
  if (language === 'python') {
    // Stack scope class theo indent: [indent, name].
    const classStack: Array<{ indent: number; name: string }> = [];
    lines.forEach((rawLine, idx) => {
      const line = idx + 1;
      const indent = rawLine.length - rawLine.trimStart().length;
      const trimmed = rawLine.trim();
      if (trimmed === '' || trimmed.startsWith('#')) return;
      while (classStack.length > 0 && indent <= classStack[classStack.length - 1]!.indent) {
        classStack.pop();
      }
      const classMatch = /^class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed);
      if (classMatch) {
        const name = classMatch[1]!;
        out.push({
          kind: 'class',
          name,
          qualifiedName: [...classStack.map((c) => c.name), name].join('.'),
          line,
          signature: trimmed,
        });
        classStack.push({ indent, name });
        return;
      }
      const defMatch = /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed);
      if (defMatch) {
        const name = defMatch[1]!;
        const enclosing = classStack.length > 0 ? classStack[classStack.length - 1]!.name : undefined;
        out.push({
          kind: enclosing ? 'method' : 'function',
          name,
          qualifiedName: [...classStack.map((c) => c.name), name].join('.'),
          line,
          signature: trimmed,
        });
      }
    });
    return out;
  }
  // JS/TS/TSX.
  lines.forEach((rawLine, idx) => {
    const line = idx + 1;
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    const patterns: Array<{ re: RegExp; kind: CodeSymbol['kind'] }> = [
      { re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)/, kind: 'function' },
      { re: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/, kind: 'class' },
      { re: /^(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/, kind: 'interface' },
      { re: /^(?:export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/, kind: 'type' },
      { re: /^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)/, kind: 'enum' },
      { re: /^(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\(/, kind: 'function' },
      { re: /^(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?function\b/, kind: 'function' },
      { re: /^(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*class\b/, kind: 'class' },
    ];
    for (const { re, kind } of patterns) {
      const m = re.exec(trimmed);
      if (m) {
        out.push({ kind, name: m[1]!, qualifiedName: m[1]!, line, signature: trimmed });
        return;
      }
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Import extraction + resolve tương đối
// ---------------------------------------------------------------------------

const IMPORT_RESOLUTION_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx',
  '/index.py',
];

/** Trích import specifier thô (`'./foo'`, `'react'`, `'os'`...). */
export function extractImportSpecifiers(source: string, language: AstLanguage): string[] {
  const specs: string[] = [];
  const push = (spec: string): void => {
    if (spec) specs.push(spec);
  };
  if (language === 'python') {
    const fromRe = /^\s*from\s+(\.+[A-Za-z0-9_.]*|[A-Za-z_][A-Za-z0-9_.]*)\s+import\s+/gm;
    const importRe = /^\s*import\s+([A-Za-z_][A-Za-z0-9_.,\s]*)/gm;
    let m: RegExpExecArray | null;
    while ((m = fromRe.exec(source)) !== null) push(m[1]!);
    while ((m = importRe.exec(source)) !== null) {
      for (const part of m[1]!.split(',')) {
        const name = part.trim().split(/\s+/)[0];
        if (name) push(name!);
      }
    }
    return specs;
  }
  const patterns = [
    /import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /export\s+(?:[^'"]*?\s+from\s+)['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) push(m[1]!);
  }
  return specs;
}

/**
 * Resolve một specifier tương đối (`./foo`, `../bar`, `.` / `..` của
 * Python) thành đường dẫn tuyệt đối của file đích — CHỈ khi đích nằm
 * trong tập file đã quét (`knownFiles`). Specifier bare (`'react'`,
 * `'os'`, `'lodash'`) trỏ ra ngoài repo → null.
 */
export function resolveRelativeImport(
  specifier: string,
  fromAbsPath: string,
  knownFiles: Set<string>,
): string | null {
  if (!specifier.startsWith('.')) return null;
  const fromDir = path.dirname(fromAbsPath);
  // Python: `.foo` / `..foo` — số dấu chấm = số cấp đi lên.
  if (/^\.+$/.test(specifier) || /^\.+\w/.test(specifier)) {
    const dots = /^(\.+)/.exec(specifier)?.[1]?.length ?? 1;
    const rest = specifier.slice(dots).replace(/^\./, '').split('.').filter(Boolean);
    let dir = fromDir;
    for (let i = 1; i < dots; i += 1) dir = path.dirname(dir);
    const base = path.join(dir, ...rest);
    for (const suffix of IMPORT_RESOLUTION_SUFFIXES) {
      const candidate = suffix === '' ? base : `${base}${suffix}`;
      if (knownFiles.has(candidate)) return candidate;
    }
    return null;
  }
  const base = path.resolve(fromDir, specifier);
  for (const suffix of IMPORT_RESOLUTION_SUFFIXES) {
    const candidate = suffix === '' ? base : `${base}${suffix}`;
    if (knownFiles.has(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parse cache theo mtime: file không đổi thì không parse lại
// ---------------------------------------------------------------------------

interface CachedParse {
  mtimeMs: number;
  size: number;
  file: RepoMapFile;
}

const parseCache = new Map<string, CachedParse>();
let cacheHits = 0;
let cacheMisses = 0;

/** Thống kê cache (dùng cho test + chẩn đoán hiệu năng). */
export function repoMapCacheStats(): { entries: number; hits: number; misses: number } {
  return { entries: parseCache.size, hits: cacheHits, misses: cacheMisses };
}

/** Xoá toàn bộ cache parse (dùng cho test). */
export function clearRepoMapCache(): void {
  parseCache.clear();
  cacheHits = 0;
  cacheMisses = 0;
}

/**
 * Parse một file thành RepoMapFile. Tree-sitter trước; lỗi engine /
 * grammar thì regex fallback (ghi cờ `fallback: true`); file lỗi cú
 * pháp vẫn trả symbol parse được (`hasError: true`).
 */
export async function parseRepoFile(absPath: string, rel: string): Promise<RepoMapFile> {
  const stat = fs.statSync(absPath);
  const cached = parseCache.get(absPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    cacheHits += 1;
    return cached.file;
  }
  cacheMisses += 1;
  const language = detectAstLanguage(absPath);
  // discoverRepoFiles chỉ trả đuôi hỗ trợ, nên language luôn khác null;
  // phòng thủ: đuôi lạ thì coi như javascript để regex fallback lo.
  const lang: AstLanguage = language ?? 'javascript';
  const source = fs.readFileSync(absPath, 'utf8');
  const lines = source.split('\n');
  const signatureFor = (lineNo: number): string => {
    const raw = lines[lineNo - 1] ?? '';
    const trimmed = raw.trim();
    return trimmed.length > MAX_SIGNATURE_CHARS
      ? `${trimmed.slice(0, MAX_SIGNATURE_CHARS)}…`
      : trimmed;
  };
  let symbols: RepoMapSymbol[] = [];
  let hasError = false;
  let fallback = false;
  try {
    const parsed = await parseCodeSymbols(source, lang);
    hasError = parsed.hasError;
    symbols = parsed.symbols.map((s) => ({
      ...s,
      column: 1,
      signature: signatureFor(s.line),
    }));
  } catch {
    fallback = true;
    symbols = extractSymbolsRegexFallback(source, lang).map((s) => ({
      kind: s.kind,
      name: s.name,
      qualifiedName: s.qualifiedName,
      line: s.line,
      column: 1,
      endLine: s.line,
      signature: signatureFor(s.line),
    }));
  }
  const definedNames = new Set(symbols.map((s) => s.name));
  // qualifiedName cũng được tra cứu (vd `Foo.bar` nhắc tới `Foo`).
  for (const s of symbols) {
    for (const part of s.qualifiedName.split('.')) definedNames.add(part);
  }
  const file: RepoMapFile = {
    rel,
    abs: absPath,
    language: lang,
    symbols,
    definedNames,
    identCounts: countIdents(source),
    importSpecifiers: extractImportSpecifiers(source, lang),
    hasError,
    fallback,
  };
  parseCache.set(absPath, { mtimeMs: stat.mtimeMs, size: stat.size, file });
  return file;
}

// ---------------------------------------------------------------------------
// Hệ số nhân ident
// ---------------------------------------------------------------------------

/**
 * Hệ số nhân cho một ident: nhắc trong hội thoại 10x, dài (>= 8 ký tự)
 * 10x, bắt đầu `_` 0.1x — nhân dồn khi cùng đúng nhiều điều kiện.
 */
export function identMultiplier(name: string, mentioned: Set<string>): number {
  let mult = 1;
  if (mentioned.has(name)) mult *= MENTIONED_IDENT_MULTIPLIER;
  if (name.length >= LONG_IDENT_MIN_LENGTH) mult *= LONG_IDENT_MULTIPLIER;
  if (name.startsWith('_')) mult *= PRIVATE_IDENT_MULTIPLIER;
  return mult;
}

/**
 * Trích ident được nhắc trong một đoạn text (tin user / hội thoại).
 * Chỉ giữ ident >= 3 ký tự, bỏ stopword; khi cho `known` thì chỉ giữ
 * ident có trong tập đó (tránh boost tên không tồn tại trong repo).
 */
export function extractMentionedIdents(text: string, known?: Set<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[0];
    if (name.length < 3) continue;
    if (isIdentStopword(name)) continue;
    if (known && !known.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Đồ thị + Personalized PageRank
// ---------------------------------------------------------------------------

/**
 * Dựng cạnh file → file từ references + import trực tiếp.
 * - Mỗi ident `x` xuất hiện `c` lần trong A mà B (B ≠ A) định nghĩa `x`:
 *   đóng góp `c * identMultiplier(x)`.
 * - Mỗi import tương đối A → B resolve được: đóng góp
 *   `IMPORT_REFERENCE_WEIGHT`.
 * - Trọng số cạnh = sqrt(tổng đóng góp) * (50 nếu B đang trong chat).
 */
export function buildRepoGraph(
  files: RepoMapFile[],
  chatFiles: Set<string>,
  mentioned: Set<string>,
): RepoMapEdge[] {
  const byAbs = new Map(files.map((f, i) => [f.abs, i]));
  const knownAbs = new Set(files.map((f) => f.abs));
  // Chỉ mục symbol → file định nghĩa nó.
  const definers = new Map<string, number[]>();
  files.forEach((f, i) => {
    for (const name of f.definedNames) {
      const list = definers.get(name);
      if (list) list.push(i);
      else definers.set(name, [i]);
    }
  });
  // raw[from][to] = tổng đóng góp chưa sqrt.
  const raw = new Map<number, Map<number, number>>();
  const addRaw = (from: number, to: number, amount: number): void => {
    if (from === to || amount <= 0) return;
    let row = raw.get(from);
    if (!row) {
      row = new Map();
      raw.set(from, row);
    }
    row.set(to, (row.get(to) ?? 0) + amount);
  };
  files.forEach((file, from) => {
    for (const [name, count] of file.identCounts) {
      const targets = definers.get(name);
      if (!targets) continue;
      const mult = identMultiplier(name, mentioned);
      for (const to of targets) addRaw(from, to, count * mult);
    }
    for (const spec of file.importSpecifiers) {
      const target = resolveRelativeImport(spec, file.abs, knownAbs);
      if (target === null) continue;
      const to = byAbs.get(target);
      if (to !== undefined) addRaw(from, to, IMPORT_REFERENCE_WEIGHT);
    }
  });
  const edges: RepoMapEdge[] = [];
  for (const [from, row] of raw) {
    for (const [to, total] of row) {
      const chatMult = chatFiles.has(files[to]!.rel) ? CHAT_FILE_MULTIPLIER : 1;
      edges.push({ from, to, rawReferences: total, weight: Math.sqrt(total) * chatMult });
    }
  }
  edges.sort((a, b) => a.from - b.from || a.to - b.to);
  return edges;
}

/**
 * Personalized PageRank tự viết (power iteration).
 * - `personalization[i]`: file trong chat chia đều khối lượng 100
 *   (chuẩn hoá về tổng 1); không có file chat thì đều 1/N.
 * - Node dangling (không có cạnh ra) phân phối theo personalization
 *   (chuẩn), không rò điểm.
 * - Khởi tạo r = personalization; lặp 50 vòng, damping 0.85.
 */
export function personalizedPageRank(
  fileCount: number,
  edges: RepoMapEdge[],
  chatIndices: number[],
  damping: number = REPO_MAP_DAMPING,
  iterations: number = REPO_MAP_ITERATIONS,
): number[] {
  if (fileCount === 0) return [];
  const personalization = new Array<number>(fileCount).fill(0);
  if (chatIndices.length > 0) {
    for (const i of chatIndices) personalization[i] = CHAT_PERSONALIZATION_MASS / chatIndices.length;
  } else {
    for (let i = 0; i < fileCount; i += 1) personalization[i] = 1 / fileCount;
  }
  const pSum = personalization.reduce((a, b) => a + b, 0);
  for (let i = 0; i < fileCount; i += 1) personalization[i]! /= pSum;
  const outWeight = new Array<number>(fileCount).fill(0);
  for (const e of edges) outWeight[e.from] = (outWeight[e.from] ?? 0) + e.weight;
  let rank = [...personalization];
  for (let iter = 0; iter < iterations; iter += 1) {
    const next = new Array<number>(fileCount).fill(0);
    let danglingMass = 0;
    for (let i = 0; i < fileCount; i += 1) {
      if ((outWeight[i] ?? 0) <= 0) danglingMass += rank[i] ?? 0;
    }
    for (let i = 0; i < fileCount; i += 1) {
      next[i] = (1 - damping) * (personalization[i] ?? 0) + damping * danglingMass * (personalization[i] ?? 0);
    }
    for (const e of edges) {
      const out = outWeight[e.from] ?? 0;
      if (out <= 0) continue;
      next[e.to] = (next[e.to] ?? 0) + damping * ((rank[e.from] ?? 0) * e.weight) / out;
    }
    rank = next;
  }
  // Chuẩn hoá lần cuối để tổng đúng 1 (trừ sai số float).
  const sum = rank.reduce((a, b) => a + b, 0);
  if (sum > 0) rank = rank.map((v) => v / sum);
  return rank;
}

/** Xếp file theo điểm giảm dần; hoà thì đường dẫn tương đối tăng dần. */
export function rankRepoFiles(files: RepoMapFile[], scores: number[]): number[] {
  return files
    .map((_, i) => i)
    .sort((a, b) => {
      const diff = (scores[b] ?? 0) - (scores[a] ?? 0);
      if (diff !== 0) return diff;
      return files[a]!.rel < files[b]!.rel ? -1 : files[a]!.rel > files[b]!.rel ? 1 : 0;
    });
}

// ---------------------------------------------------------------------------
// Render kiểu TreeContext (signature + elision)
// ---------------------------------------------------------------------------

/** Một dòng signature trong render: signature + `...` (thân đã elided). */
export function renderSymbolLine(symbol: RepoMapSymbol): string {
  const sig = symbol.signature.trim();
  const needsEllipsis = !sig.endsWith('...') && !sig.endsWith('{ ... }');
  return `  ${symbol.kind} ${symbol.qualifiedName} — ${sig}${needsEllipsis ? ' ...' : ''} (line ${symbol.line})`;
}

/** Render một file: header có rank/score + tối đa `maxSymbols` symbol. */
export function renderRepoFile(file: RepoMapFile, rankPos: number, score: number): string {
  const header = `### ${file.rel} (rank ${rankPos + 1}, score ${score.toFixed(4)})`;
  if (file.symbols.length === 0) return `${header}\n  (no symbols)`;
  const lines = file.symbols.map((s) => renderSymbolLine(s));
  return `${header}\n${lines.join('\n')}`;
}

/** Render top-k file theo thứ hạng. */
export function renderRankedFiles(
  files: RepoMapFile[],
  ranked: number[],
  scores: number[],
  count: number,
): string {
  const parts: string[] = [];
  for (let i = 0; i < count && i < ranked.length; i += 1) {
    const idx = ranked[i]!;
    parts.push(renderRepoFile(files[idx]!, i, scores[idx] ?? 0));
  }
  return parts.join('\n');
}

/**
 * Binary search số file top-rank lớn nhất mà render vừa budget.
 * Render đơn điệu theo k (mỗi file thêm ít nhất 1 dòng) nên binary
 * search đúng; k = 0 khi ngay cả file top-1 cũng vượt budget.
 */
export function fitRepoMapToBudget(
  files: RepoMapFile[],
  ranked: number[],
  scores: number[],
  budget: number,
): { count: number; rendered: string; tokenEstimate: number } {
  const fits = (k: number): string | null => {
    if (k === 0) return '';
    const rendered = renderRankedFiles(files, ranked, scores, k);
    return estimateRepoMapTokens(rendered) <= budget ? rendered : null;
  };
  let lo = 0;
  let hi = ranked.length;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid) !== null) lo = mid + 1;
    else hi = mid - 1;
  }
  // Bất biến sau vòng lặp: hi = k lớn nhất vừa budget (fits đơn điệu
  // theo k vì render(k) là tiền tố của render(k+1)).
  const count = Math.max(0, hi);
  const rendered = count === 0 ? '' : renderRankedFiles(files, ranked, scores, count);
  return { count, rendered, tokenEstimate: estimateRepoMapTokens(rendered) };
}

// ---------------------------------------------------------------------------
// Build + query
// ---------------------------------------------------------------------------

function normalizeRel(p: string): string {
  return toPosix(p.trim()).replace(/^\.\//, '');
}

/**
 * Build repo map cho một thư mục: quét → parse (cache mtime) → đồ thị
 * → PageRank cá nhân hoá → render vừa budget. Không throw vì thư mục
 * trống (trả map rỗng); chỉ throw khi root không đọc được.
 */
export async function buildRepoMap(
  rootDir: string,
  options: BuildRepoMapOptions = {},
): Promise<RepoMapResult> {
  const started = Date.now();
  const rootAbs = path.resolve(rootDir);
  const stat = fs.statSync(rootAbs);
  if (!stat.isDirectory()) throw new Error(`Repo map root is not a directory: "${rootDir}"`);
  const maxFiles = options.maxFiles ?? MAX_REPO_MAP_FILES;
  const discovered = discoverRepoFiles(rootAbs, maxFiles);
  const hitsBefore = cacheHits;
  const files: RepoMapFile[] = [];
  for (const rel of discovered.relPaths) {
    files.push(await parseRepoFile(path.join(rootAbs, rel), rel));
  }
  const knownNames = new Set<string>();
  for (const f of files) for (const n of f.definedNames) knownNames.add(n);
  const chatSet = new Set((options.chatFiles ?? []).map(normalizeRel));
  // Chỉ giữ chatFiles thật sự có trong map (đường dẫn gõ sai thì bỏ).
  const chatInMap = files
    .map((f, i) => (chatSet.has(f.rel) ? i : -1))
    .filter((i) => i >= 0);
  const mentioned = new Set(
    options.mentionedIdents ??
      (options.userText ? extractMentionedIdents(options.userText, knownNames) : []),
  );
  const edges = buildRepoGraph(files, new Set(files.filter((f) => chatSet.has(f.rel)).map((f) => f.rel)), mentioned);
  const scores = personalizedPageRank(files.length, edges, chatInMap);
  const ranked = rankRepoFiles(files, scores);
  const baseBudget = options.tokenBudget ?? DEFAULT_REPO_MAP_TOKEN_BUDGET;
  const budget = chatInMap.length === 0 ? baseBudget * NO_CHAT_FILES_BUDGET_MULTIPLIER : baseBudget;
  const fitted = fitRepoMapToBudget(files, ranked, scores, budget);
  return {
    rootDir: rootAbs,
    files,
    edges,
    scores,
    ranked,
    rendered: fitted.rendered,
    renderedFiles: fitted.count,
    tokenEstimate: fitted.tokenEstimate,
    budget,
    filesScanned: discovered.scanned,
    filesSkipped: discovered.skippedOversize + discovered.skippedOverCap,
    cacheHits: cacheHits - hitsBefore,
    buildMs: Date.now() - started,
    truncatedByBudget: fitted.count < ranked.length,
  };
}

/**
 * Map cá nhân hoá theo lượt chat: file đang chat + ident nhắc tới
 * trong tin user. Trả cùng RepoMapResult (đã render vừa budget).
 */
export async function queryRepoMap(
  rootDir: string,
  query: {
    chatFiles?: string[];
    mentionedIdents?: string[];
    userText?: string;
    tokenBudget?: number;
    maxFiles?: number;
  } = {},
): Promise<RepoMapResult> {
  return buildRepoMap(rootDir, query);
}

/**
 * Render một RepoMapResult đã build thành section chèn vào prompt
 * (dùng chung cho coordinator và tool repo_map_query — không build lại).
 */
export function formatRepoMapSection(map: RepoMapResult): string {
  if (map.files.length === 0 || map.renderedFiles === 0) return '';
  const header =
    `[Repo map — bản đồ code của thư mục làm việc (${map.renderedFiles}/${map.files.length} file ` +
    `quan trọng nhất, ~${map.tokenEstimate} token trong budget ${map.budget}; ` +
    `chỉ hiện signature, thân hàm đã lược thành "..." — mở file gốc khi cần xem thân):]`;
  return `${header}\n${map.rendered}`;
}

/**
 * Section repo map để chèn vào system prompt của turn (coordinator
 * gọi). Best-effort: tắt / thư mục không đọc được / không có file thì
 * trả '' (turn chạy tiếp như cũ, không chặn). `userText` dùng để trích
 * ident nhắc tới khi không truyền `mentionedIdents` sẵn.
 */
export async function buildRepoMapSection(
  rootDir: string,
  options: RepoMapSectionOptions = {},
): Promise<string> {
  if (options.enabled === false) return '';
  try {
    const map = await buildRepoMap(rootDir, options);
    return formatRepoMapSection(map);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Tools: repo_map + repo_map_query (read-only, không cần approval)
// ---------------------------------------------------------------------------

function repoMapError(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument "${name}".`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`Argument "${name}" must be a string.`);
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number.`);
  }
  return value;
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return value as string[];
}

function formatMapSummary(map: RepoMapResult): string {
  const top = map.ranked.slice(0, 10).map((idx, i) => {
    const f = map.files[idx]!;
    return `${i + 1}. ${f.rel} (score ${(map.scores[idx] ?? 0).toFixed(4)}, ${f.symbols.length} symbol(s))`;
  });
  return (
    `Repo map for "${map.rootDir}": ${map.files.length} file(s) scanned, ` +
    `${map.edges.length} reference edge(s), ${map.filesSkipped} skipped, ` +
    `rendered ${map.renderedFiles} file(s) in ~${map.tokenEstimate} tokens ` +
    `(budget ${map.budget})${map.truncatedByBudget ? ' — truncated by budget' : ''}, ` +
    `built in ${map.buildMs} ms (${map.cacheHits} file(s) from parse cache).\n` +
    `Top files by PageRank:\n${top.join('\n')}`
  );
}

const repoMapTool: Tool = {
  definition: {
    name: 'repo_map',
    description:
      'Build a ranked map of a code folder (repo map): which files matter most, by Personalized ' +
      'PageRank over the file-reference graph (tree-sitter symbols + imports). Returns the top ' +
      'files with scores plus a TreeContext-style render (signatures only, bodies elided as "...") ' +
      'fitted to a token budget (default 1024 tokens; x8 when no chat files are given). ' +
      'Supported languages: TypeScript/TSX, JavaScript/JSX, Python. Read-only, needs no approval. ' +
      'Honest limits: references are counted from identifier tokens (strings/comments may inflate ' +
      'counts slightly); bare imports (e.g. "react") point outside the repo and are ignored; ' +
      'at most 2000 files, files over 1 MB are skipped and reported.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Folder to map, relative to the workspace root (default ".").',
        },
        tokenBudget: {
          type: 'number',
          description: 'Token budget for the rendered map (default 1024; multiplied by 8 when no chat files are given).',
        },
        chatFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files currently in the chat (paths relative to the mapped folder) — they get 50x edge weight and all of the PageRank personalization mass.',
        },
        mentionedIdents: {
          type: 'array',
          items: { type: 'string' },
          description: 'Identifiers mentioned in the conversation — references to them get 10x weight.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  needsApproval: false,
  async execute(args, ctx: ToolContext) {
    try {
      const relRoot = args['path'] === undefined ? '.' : getStringArg(args, 'path', false);
      const root = resolveWithin(ctx.workspaceDir, relRoot || '.');
      const tokenBudget = getNumberArg(args, 'tokenBudget');
      if (tokenBudget !== undefined && tokenBudget <= 0) {
        return repoMapError('tokenBudget must be a positive number.');
      }
      const map = await buildRepoMap(root, {
        tokenBudget,
        chatFiles: getStringArrayArg(args, 'chatFiles'),
        mentionedIdents: getStringArrayArg(args, 'mentionedIdents'),
      });
      const body = map.rendered ? `\n\n${map.rendered}` : '\n\n(no files rendered — empty folder or budget too small for even one file)';
      return truncate(`${formatMapSummary(map)}${body}`);
    } catch (err) {
      return repoMapError((err as Error).message);
    }
  },
};

const repoMapQueryTool: Tool = {
  definition: {
    name: 'repo_map_query',
    description:
      'Build a repo map personalized to the current turn: pass the files in the chat and/or the ' +
      'user message (or the identifiers mentioned in it) and get back the files most relevant to ' +
      'this turn, rendered as signatures-only context fitted to a token budget. Same engine and ' +
      'limits as repo_map (tree-sitter TS/TSX/JS/JSX/Python, max 2000 files, files over 1 MB ' +
      'skipped). Read-only, needs no approval.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Folder to map, relative to the workspace root (default ".").',
        },
        chatFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files in the current chat (paths relative to the mapped folder).',
        },
        userText: {
          type: 'string',
          description: 'Current user message — identifiers mentioned in it are extracted and boosted 10x.',
        },
        mentionedIdents: {
          type: 'array',
          items: { type: 'string' },
          description: 'Identifiers mentioned in the conversation (overrides extraction from userText).',
        },
        tokenBudget: {
          type: 'number',
          description: 'Token budget for the rendered map (default 1024; multiplied by 8 when no chat files are given).',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  needsApproval: false,
  async execute(args, ctx: ToolContext) {
    try {
      const relRoot = args['path'] === undefined ? '.' : getStringArg(args, 'path', false);
      const root = resolveWithin(ctx.workspaceDir, relRoot || '.');
      const tokenBudget = getNumberArg(args, 'tokenBudget');
      if (tokenBudget !== undefined && tokenBudget <= 0) {
        return repoMapError('tokenBudget must be a positive number.');
      }
      const userText = args['userText'] === undefined ? undefined : getStringArg(args, 'userText', false);
      const map = await queryRepoMap(root, {
        chatFiles: getStringArrayArg(args, 'chatFiles'),
        mentionedIdents: getStringArrayArg(args, 'mentionedIdents'),
        userText: userText || undefined,
        tokenBudget,
      });
      if (map.renderedFiles === 0) {
        return `${formatMapSummary(map)}\n\n(no files rendered — empty folder or budget too small for even one file)`;
      }
      return truncate(`${formatMapSummary(map)}\n\n${formatRepoMapSection(map)}`);
    } catch (err) {
      return repoMapError((err as Error).message);
    }
  },
};

/** Cả hai tool repo map (v0.96) — đăng ký kèm CODE_TOOLS. */
export const REPO_MAP_TOOLS: Tool[] = [repoMapTool, repoMapQueryTool];
