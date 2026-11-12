/**
 * Rule engine nhỏ cho auto-approve theo lệnh + rules theo file/glob
 * (v0.11c, P1-7 — kiểu Cursor: `.cursor/rules/*.mdc`, YOLO + whitelist).
 *
 * Module này là SINGLE SOURCE OF TRUTH cho việc phân loại lệnh shell:
 *  - `packages/core/src/agent/permissions.ts` dùng nó để quyết định
 *    một tool call shell có chạy ngay / hỏi trước / bị cấm.
 *  - `packages/tools/src/sandbox.ts` dùng cùng các pattern này cho
 *    denylist (chặn cứng lúc chạy) — không còn 2 nơi định nghĩa lệnh
 *    nguy hiểm khác nhau.
 *
 * Ba phần, đều PURE trừ `RulesStore` (đọc file):
 *  1. Phân loại lệnh: `classifyCommand` → 'safe' | 'normal' |
 *     'sensitive' | 'blocked'.
 *  2. Rules theo glob: `evaluateFileRules` chạy sau mỗi tool call ghi
 *     file, trả về hành động `run` (chạy lệnh) hoặc `warn` (cảnh báo).
 *  3. File cấu hình `<workspace>/.open-bot/rules.json`, load + cache
 *     theo mtime như skill loader (`packages/core/src/skills/loader.ts`).
 *
 * An toàn theo thiết kế: file rules sai định dạng KHÔNG crash — parser
 * trả về `{ rules, errors }`, rule lỗi bị bỏ qua, các rule còn lại vẫn
 * chạy; file thiếu hoặc hỏng thì dùng rule mặc định (`**` + `/*.ts` →
 * typecheck) và ghi lỗi vào `errors` để host hiển thị.
 *
 * Chưa nối vào loop/coordinator (ngoài phạm vi v0.11c): `checkToolCall`
 * đã nhận `args` nên wiring sau chỉ cần truyền `call.args` vào; hook
 * `createGlobRulesHook` gắn vào `HookRunner` như `createDenylistHook`.
 * Hook chỉ GHI CHÚ vào output của tool (bảo model chạy lệnh rule),
 * không tự thực thi lệnh — việc chạy lệnh rule là của bước wiring sau.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HookDefinition } from '../hooks/types';
import { modifyOutputDecision } from '../hooks/types';

// ---------------------------------------------------------------------------
// 1. Phân loại lệnh shell
// ---------------------------------------------------------------------------

/** Kết quả phân loại một lệnh shell (lệnh ghép được tách theo && / || / ; / |). */
export type CommandClass = 'safe' | 'normal' | 'sensitive' | 'blocked';

/**
 * Lệnh KHÔNG BAO GIỜ được chạy — chặn cứng ở sandbox (và `checkToolCall`
 * cũng từ chối). Đây là denylist cũ của `packages/tools/src/sandbox.ts`,
 * chuyển về đây để chỉ còn một nơi định nghĩa. Mỗi pattern match trên
 * toàn bộ chuỗi lệnh.
 */
export const BLOCKED_COMMAND_PATTERNS: RegExp[] = [
  // rm -rf / , rm -rf ~ , rm -rf $HOME (any flag order / long flags).
  // Nhóm cuối gồm cả quote/paren/backtick (v0.25, điều phối viên):
  // `rm -rf "/"`, `sh -c "rm -rf /"`, `$(rm -rf /)`, `rm -rf ~/` cũng
  // phải chặn — trước đây chỉ chặn khi sau target là khoảng trắng/kết
  // thúc/`;`/`&`/`|` và không có quote trước target. Slash sau target
  // chỉ tính khi kèm boundary (`/?` + boundary) nên `rm -rf ~/x` hay
  // `rm -rf "/tmp/foo"` vẫn qua như cũ (đường dẫn con, không phải root).
  //
  // v0.28: flag còn có thể bị quote che (`rm "-rf" /`, `rm '-rf' /`,
  // `rm "--recursive" /`, quote lồng `rm "'-rf'" /`, flag dính quote
  // `rm -'rf' /`, `rm "-r"f /`) và long flag trần (`rm --recursive /`)
  // cũng từng lọt vì nhóm flag cũ chỉ nhận `-[a-zA-Z]*`. Hai lớp sửa:
  //  1. Nhóm flag nhận cả long flag `--recursive`/`--force`/… và
  //     `--` kết thúc options (`rm -rf -- /`).
  //  2. `matchBlockedCommandPattern` còn thử trên chuỗi đã bỏ quote
  //     (`normalizeCommandForDenylist`) nên flag có quote kiểu nào
  //     cũng hiện nguyên hình; chuỗi gốc vẫn thử trước để không mất
  //     hành vi chặn cũ.
  //
  // v0.70: đích nguy hiểm còn lọt khi KHÔNG PHẢI operand đầu tiên
  // (`rm -r f /`, `rm -r /tmp /`, `rm f /`, `rm -rf a b /` chỉ bị tính
  // sensitive dù `/` là operand và lệnh sẽ xoá root) vì regex cũ chỉ
  // cho flag/`--` đứng trước đích. Nhóm lặp giữa `rm` và đích giờ nhận
  // thêm operand thường (`[^\s;&|]+\s+`, kể cả `--` lẻ và flag xen
  // giữa operand như `rm /tmp -rf /`) nên đích nguy hiểm ở BẤT KỲ vị
  // trí operand nào cũng bị chặn. Regex vẫn backtrack: đích nguy hiểm
  // đứng trước operand lành (`rm -rf / /tmp/foo`) khớp ở lần thử đầu,
  // còn đường dẫn con (`rm -rf /tmp/foo`, `rm -rf a b ~/x`) không khớp
  // vì sau `/`/`~` không phải boundary. Đánh đổi fail-closed: tên file
  // `'rf /'` (một operand chứa khoảng trắng + slash, thực chất là
  // đường dẫn tới file tên ` ` trong thư mục `rf`) sau khi bỏ quote
  // không phân biệt được với `rm rf /` nên cũng bị chặn — xem test 3c.
  /\brm\s+(?:(?:-[a-zA-Z]+|--[a-zA-Z][a-zA-Z-]*|--)\s+|[^\s;&|]+\s+)*["']?(?:\/|~|\$HOME|%USERPROFILE%|[A-Za-z]:[\\/])(?:\/?(?:\s|$|[;&|'")`]))/,
  /\brm\s+[^;&|]*\s--no-preserve-root\b/,
  // (v0.28, rà soát đa nền tảng) Lệnh phá hoại tương đương trên Windows
  // — trước đây denylist chỉ biết dạng POSIX nên các lệnh dưới đây đều
  // qua được trên máy Windows, dù hậu quả tương đương `rm -rf /`
  // (`rm` là alias của Remove-Item trong PowerShell, nên `rm -rf C:\`
  // đã được chặn bằng đích ổ đĩa thêm ở pattern trên):
  //   Remove-Item -Recurse -Force C:\   (hoặc đích đứng trước cờ)
  //   rd /s /q C:\  |  del /s /q C:\  |  format C:
  // Đích bị chặn: gốc ổ đĩa (`C:\`, `C:/`), `C:\Windows`,
  // `$env:USERPROFILE`, `$env:SystemDrive`, `%USERPROFILE%`.
  // Thư mục CON trong các đích đó vẫn qua như cũ (VD:
  // `Remove-Item -Recurse C:\Users\test\build`, `rd /s /q D:\temp\x`)
  // — giống quy tắc `rm -rf /tmp/foo` vẫn qua ở trên. Lookahead
  // `(?=...)` sau đích để không "ăn" ký tự boundary: đích đứng trước
  // cờ (`Remove-Item C:\ -Recurse`) vẫn phải khớp.
  /\bRemove-Item\b[^;&|]*\s-Recurse\b[^;&|]*["']?(?:[A-Za-z]:[\\/](?=\s|$|[;&|'"`*])|[A-Za-z]:\\Windows(?=\s|$|[;&|'"`*])|\$env:USERPROFILE(?=\s|$|[;&|'"`*])|\$env:SystemDrive\\?(?=\s|$|[;&|'"`*])|%USERPROFILE%(?=\s|$|[;&|'"`*]))/,
  /\bRemove-Item\b[^;&|]*["']?(?:[A-Za-z]:[\\/](?=\s|$|[;&|'"`*])|[A-Za-z]:\\Windows(?=\s|$|[;&|'"`*])|\$env:USERPROFILE(?=\s|$|[;&|'"`*])|\$env:SystemDrive\\?(?=\s|$|[;&|'"`*])|%USERPROFILE%(?=\s|$|[;&|'"`*]))[^;&|]*\s-Recurse\b/,
  /\b(?:rd|rmdir)\b[^;&|]*\/s\b[^;&|]*[A-Za-z]:[\\/](?:\s|$|[;&|'"`*])/,
  /\b(?:rd|rmdir)\b[^;&|]*[A-Za-z]:[\\/](?:\s|$|[;&|'"`*])[^;&|]*\/s\b/,
  /\b(?:del|erase)\b[^;&|]*\/s\b[^;&|]*[A-Za-z]:[\\/](?:\s|$|[;&|'"`*])/,
  /\b(?:del|erase)\b[^;&|]*[A-Za-z]:[\\/](?:\s|$|[;&|'"`*])[^;&|]*\/s\b/,
  /\bformat\s+[A-Za-z]:(?:\s|$|[;&|/"'])/,
  // Filesystem destruction / raw disk access
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b[^;&|]*\bif=/,
  // Power / system state
  /\b(shutdown|reboot|halt|poweroff)\b/,
  // Permission carpet-bombing outside the workspace
  /\bchmod\s+(?:-R\s+)?777\s+\//,
  /\bchown\s+(?:-R\s+)?\S+\s+\//,
  // Piping a download (or anything) straight into a shell
  /\|\s*(sh|bash|zsh|fish|powershell|pwsh|cmd)\b/,
  // Privilege escalation / credential changes
  /\bsudo\b/,
  /\bsu\s+(-\s*)?\S/,
  /\bpasswd\b/,
  /\buseradd\b|\buserdel\b|\busermod\b/,
  // Fork bomb
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
];

/**
 * Chuẩn hoá lệnh để denylist soi xuyên qua quote (v0.28): bỏ ký tự
 * quote đơn/kép khỏi chuỗi lệnh — `rm "-rf" /` → `rm -rf /`,
 * `rm "'-rf'" /` (quote lồng) → `rm -rf /`, `rm -'rf' /` →
 * `rm -rf /`, `rm $'-rf' /` (ANSI-C quoting của bash, flag thật) →
 * `rm -rf /`. Các quote đã escape (`\"` trong `sh -c "rm \"-rf\" /"`)
 * cũng được gỡ escape trước khi bỏ, để lớp vỏ `sh -c` không che được
 * flag bên trong. Hướng fail-closed: một tên file chứa quote theo
 * kiểu `'-rf'` (cực hiếm) có thể bị chặn nhầm — chấp nhận được với
 * denylist, vì chiều ngược lại là lọt lệnh xoá root.
 *
 * Không đụng tới backslash thường (`rm \-rf /` giữ nguyên `\-rf`,
 * đúng là tên file chứ không phải flag trong shell) và không nối từ:
 * chỉ bỏ ký tự quote, khoảng trắng giữa các token giữ nguyên, nên
 * `rm "rf"` → `rm rf` (không phải flag) và `rm " -rf"` (tên file)
 * vẫn không khớp denylist.
 */
export function normalizeCommandForDenylist(command: string): string {
  return command
    .replace(/\\(["'])/g, '$1')
    .replace(/\$(["'])/g, '$1')
    .replace(/["']/g, '');
}

/** Pattern denylist đầu tiên khớp `command`, hoặc undefined khi không khớp. */
export function matchBlockedCommandPattern(command: string): RegExp | undefined {
  for (const pattern of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(command)) return pattern;
  }
  // Thử lại trên chuỗi đã bỏ quote: flag nguy hiểm bị quote che
  // (`rm "-rf" /`, `rm "--recursive" /`, quote lồng, …) hiện nguyên
  // hình ở đây. Chỉ thử khi chuỗi đổi khác để khỏi chạy 2 lần vô ích.
  const normalized = normalizeCommandForDenylist(command);
  if (normalized !== command) {
    for (const pattern of BLOCKED_COMMAND_PATTERNS) {
      if (pattern.test(normalized)) return pattern;
    }
  }
  return undefined;
}

/**
 * Whitelist lệnh an toàn (mặc định): lệnh chỉ đọc / kiểm tra, chạy ngay
 * không hỏi ở mode `safe-only`. Match theo tiền tố, đúng ranh giới token
 * (`npm test` khớp `npm test --watch`, không khớp `npm testing`).
 * Lệnh ghép (`&&`/`||`/`;`/`|`) chỉ được tính là safe khi MỌI đoạn đều safe.
 */
export const DEFAULT_SAFE_COMMANDS: readonly string[] = [
  'npm test',
  'npm run test',
  'npm run typecheck',
  'tsc',
  'npx tsc',
  'git status',
  'git diff',
  'git log',
  'git branch',
  'git show',
  'git rev-parse',
  'ls',
  'pwd',
  'echo',
  'cat',
  'node --version',
  'node -v',
  'npm --version',
  'npm -v',
  'cd',
];

/**
 * Lệnh nhạy cảm (mặc định): luôn hỏi trước khi chạy ở mode `safe-only`
 * (và `none`). Ghi đè / bổ sung qua `BotToolPolicy.sensitiveCommands`
 * hoặc `commands.sensitive` trong rules.json. Lưu ý: `rm -rf /`,
 * `curl | sh`, `sudo`… đã nằm ở mức `blocked` (chặn cứng), không ở đây.
 */
export const DEFAULT_SENSITIVE_COMMANDS: readonly string[] = [
  'rm',
  'git push',
  'git reset',
  'git clean',
  'npm publish',
  'yarn publish',
  'pnpm publish',
  'chmod',
  'chown',
];

export interface ClassifyCommandOptions {
  /** Ghi ra ngoài thư mục này (vd `> /etc/x`) được tính là nhạy cảm. */
  workspaceDir?: string;
  /** Tiền tố safe bổ sung (cộng thêm vào mặc định). */
  extraSafeCommands?: string[];
  /** Tiền tố sensitive bổ sung (cộng thêm vào mặc định). */
  extraSensitiveCommands?: string[];
}

function matchesPrefix(segment: string, prefix: string): boolean {
  return segment === prefix || segment.startsWith(prefix + ' ');
}

/** Đích ghi có nằm ngoài workspace không (đường dẫn tuyệt đối / ~ / $HOME). */
function isOutsideWorkspaceTarget(target: string, workspaceDir?: string): boolean {
  if (target.startsWith('~') || target.startsWith('$HOME') || target.startsWith('%USERPROFILE%')) {
    return true;
  }
  if (!path.isAbsolute(target)) return false; // tương đối = trong cwd (đã bị sandbox confine)
  if (workspaceDir === undefined) return true; // không xác minh được → fail-closed (hỏi)
  const ws = path.resolve(workspaceDir);
  const resolved = path.resolve(target);
  return resolved !== ws && !resolved.startsWith(ws + path.sep);
}

/**
 * Một đoạn lệnh có ghi file ra ngoài workspace không: redirect `>` / `>>`
 * (kể cả `2>`) và `tee <đường-dẫn-tuyệt-đối>`. `2>&1` và `> /dev/null`
 * không tính.
 */
function hasOutsideWorkspaceWrite(segment: string, workspaceDir?: string): boolean {
  const redirectRe = /\d?>>?\s*([^\s;&|]+)/g;
  let m: RegExpExecArray | null;
  while ((m = redirectRe.exec(segment)) !== null) {
    const target = m[1]!;
    if (target === '/dev/null' || target === '/dev/stdout' || target === '/dev/stderr') continue;
    if (isOutsideWorkspaceTarget(target, workspaceDir)) return true;
  }
  const teeRe = /\btee\s+(?:-[a-zA-Z]+\s+)*(\/[^\s;&|]+)/g;
  while ((m = teeRe.exec(segment)) !== null) {
    if (isOutsideWorkspaceTarget(m[1]!, workspaceDir)) return true;
  }
  return false;
}

/**
 * Phân loại một lệnh shell. Thứ tự ưu tiên: blocked > sensitive > safe >
 * normal. Lệnh ghép: chỉ cần MỘT đoạn sensitive là sensitive; chỉ safe
 * khi MỌI đoạn đều safe. Lệnh rỗng / không phải chuỗi → 'normal'.
 * Pure — không I/O, không throw với input hợp lệ.
 */
export function classifyCommand(command: string, opts: ClassifyCommandOptions = {}): CommandClass {
  if (typeof command !== 'string' || command.trim() === '') return 'normal';
  if (matchBlockedCommandPattern(command) !== undefined) return 'blocked';
  const safe = [...DEFAULT_SAFE_COMMANDS, ...(opts.extraSafeCommands ?? [])];
  const sensitive = [...DEFAULT_SENSITIVE_COMMANDS, ...(opts.extraSensitiveCommands ?? [])];
  const normalized = command.trim().replace(/\s+/g, ' ');
  const segments = normalized
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  let allSafe = segments.length > 0;
  for (let seg of segments) {
    // Bỏ tiền tố gán biến môi trường: `NODE_ENV=test npm test` → `npm test`.
    seg = seg.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)+/, '').trim();
    if (seg === '') continue;
    if (
      sensitive.some((p) => matchesPrefix(seg, p)) ||
      hasOutsideWorkspaceWrite(seg, opts.workspaceDir)
    ) {
      return 'sensitive';
    }
    if (!safe.some((p) => matchesPrefix(seg, p))) allSafe = false;
  }
  return allSafe ? 'safe' : 'normal';
}

export function isSafeCommand(command: string, opts: ClassifyCommandOptions = {}): boolean {
  return classifyCommand(command, opts) === 'safe';
}

export function isSensitiveCommand(command: string, opts: ClassifyCommandOptions = {}): boolean {
  return classifyCommand(command, opts) === 'sensitive';
}

export function isBlockedCommand(command: string): boolean {
  return classifyCommand(command) === 'blocked';
}

// ---------------------------------------------------------------------------
// 2. Rules theo file/glob
// ---------------------------------------------------------------------------

function escapeRegExpChar(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Glob → RegExp. Hỗ trợ `*` (không qua `/`), `**` (qua `/`),
 * `**` + `/` (0 hoặc nhiều thư mục), `?` (một ký tự, không qua `/`).
 * `*.ts` chỉ khớp file ở root, `**` + `/*.ts` khớp mọi cấp — đúng ngữ
 * nghĩa glob chuẩn. Không throw với glob hợp lệ.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '^';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i += 1;
    } else {
      re += escapeRegExpChar(ch);
      i += 1;
    }
  }
  return new RegExp(re + '$');
}

/** Glob có khớp `filePath` không (chuẩn hoá `\` → `/`). Không bao giờ throw. */
export function matchGlob(glob: string, filePath: string): boolean {
  if (typeof glob !== 'string' || glob === '' || typeof filePath !== 'string' || filePath === '') {
    return false;
  }
  try {
    return globToRegExp(glob).test(filePath.replace(/\\/g, '/'));
  } catch {
    return false;
  }
}

export type GlobRuleAction = 'run' | 'warn';

/** Một rule theo glob: sau khi tool ghi file khớp `glob`, làm `action`. */
export interface GlobRule {
  /** Glob pattern, vd `**` + `/*.ts`. */
  glob: string;
  /** 'run': chạy `command`. 'warn': chỉ cảnh báo bằng `message`. */
  action: GlobRuleAction;
  /** Bắt buộc khi action === 'run'. */
  command?: string;
  /** Dùng khi action === 'warn' (thiếu thì tự sinh). */
  message?: string;
  /** Ghi chú cho người đọc file rules. */
  description?: string;
}

/** Hành động mà engine trả về sau một tool call ghi file. */
export interface RuleAction {
  rule: GlobRule;
  /** File vừa ghi (đường dẫn như trong args của tool). */
  file: string;
  kind: GlobRuleAction;
  /** Chỉ có khi kind === 'run'. */
  command?: string;
  /** Câu đầy đủ để ghi vào output / hiển thị cho user. */
  message: string;
}

/** Tool ghi file (arg `path`) mà glob rules áp dụng. Mở rộng khi có tool ghi mới. */
export const FILE_WRITE_TOOLS: readonly string[] = ['write_file', 'delete_file', 'apply_diff'];

/**
 * Đánh giá glob rules sau một tool call. Chỉ tool trong FILE_WRITE_TOOLS
 * với arg `path` (hoặc `filePath`) là chuỗi mới được xét; mọi trường hợp
 * khác trả về []. Pure — không I/O, không throw với input hợp lệ.
 */
export function evaluateFileRules(
  toolName: string,
  args: Record<string, unknown>,
  rules: readonly GlobRule[],
  _opts: { workspaceDir?: string } = {},
): RuleAction[] {
  if (!FILE_WRITE_TOOLS.includes(toolName)) return [];
  const rawPath = args['path'] ?? args['filePath'];
  if (typeof rawPath !== 'string' || rawPath.trim() === '') return [];
  const file = rawPath.replace(/\\/g, '/');
  const actions: RuleAction[] = [];
  for (const rule of rules) {
    if (!rule || typeof rule.glob !== 'string' || !matchGlob(rule.glob, file)) continue;
    if (rule.action === 'run') {
      if (typeof rule.command !== 'string' || rule.command.trim() === '') continue;
      actions.push({
        rule,
        file,
        kind: 'run',
        command: rule.command,
        message: `File "${file}" khớp rule "${rule.glob}" — chạy: ${rule.command}`,
      });
    } else if (rule.action === 'warn') {
      actions.push({
        rule,
        file,
        kind: 'warn',
        message: rule.message ?? `File "${file}" khớp rule "${rule.glob}".`,
      });
    }
    // action lạ (rule viết tay, không qua parseRulesFile) → bỏ qua, không crash.
  }
  return actions;
}

// ---------------------------------------------------------------------------
// 3. File cấu hình .open-bot/rules.json — load + cache theo mtime
// ---------------------------------------------------------------------------

export const RULES_DIR_NAME = '.open-bot';
export const RULES_FILE_NAME = 'rules.json';

/** Rule mặc định khi chưa có file cấu hình (hoặc file hỏng). */
export const DEFAULT_GLOB_RULES: readonly GlobRule[] = [
  {
    glob: '**/*.ts',
    action: 'run',
    command: 'npm run typecheck',
    description: 'Mọi file TypeScript sau khi sửa phải chạy typecheck.',
  },
];

export interface ParsedRules {
  /** Glob rules đã parse (mặc định khi file thiếu `rules` hoặc hỏng). */
  rules: GlobRule[];
  /** Tiền tố safe bổ sung từ `commands.safe` (cộng thêm vào mặc định). */
  safeCommands: string[];
  /** Tiền tố sensitive bổ sung từ `commands.sensitive`. */
  sensitiveCommands: string[];
  /** Một entry cho mỗi vấn đề gặp lúc parse; rỗng khi file sạch. */
  errors: string[];
}

function defaultParsed(): ParsedRules {
  return {
    rules: [...DEFAULT_GLOB_RULES],
    safeCommands: [],
    sensitiveCommands: [],
    errors: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseStringList(value: unknown, field: string, errors: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`rules.json: "${field}" phải là một mảng chuỗi.`);
    return [];
  }
  const out: string[] = [];
  value.forEach((entry, idx) => {
    if (typeof entry === 'string' && entry.trim() !== '') out.push(entry);
    else errors.push(`rules.json: "${field}[${idx}]" không phải chuỗi non-empty — bỏ qua.`);
  });
  return out;
}

/**
 * Parse nội dung rules.json. KHÔNG throw với nội dung sai định dạng:
 * JSON hỏng / top-level không phải object → rule mặc định + 1 lỗi;
 * rule lẻ sai → bỏ rule đó, ghi lỗi, các rule còn lại vẫn dùng được.
 * `rules` có mặt (kể cả `[]`) thì thay thế mặc định; vắng thì giữ mặc định.
 */
export function parseRulesFile(text: string): ParsedRules {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    const result = defaultParsed();
    result.errors.push(
      `rules.json không phải JSON hợp lệ: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }
  if (!isRecord(data)) {
    const result = defaultParsed();
    result.errors.push('rules.json phải là một JSON object ở top-level.');
    return result;
  }
  const result = defaultParsed();
  if (data['commands'] !== undefined) {
    if (!isRecord(data['commands'])) {
      result.errors.push('rules.json: "commands" phải là một object.');
    } else {
      result.safeCommands = parseStringList(data['commands']['safe'], 'commands.safe', result.errors);
      result.sensitiveCommands = parseStringList(
        data['commands']['sensitive'],
        'commands.sensitive',
        result.errors,
      );
    }
  }
  if (data['rules'] === undefined) return result;
  if (!Array.isArray(data['rules'])) {
    result.errors.push('rules.json: "rules" phải là một mảng.');
    return result;
  }
  const parsed: GlobRule[] = [];
  data['rules'].forEach((entry, idx) => {
    const where = `rules.json: rule #${idx}`;
    if (!isRecord(entry)) {
      result.errors.push(`${where} không phải object — bỏ qua.`);
      return;
    }
    const glob = entry['glob'];
    if (typeof glob !== 'string' || glob.trim() === '') {
      result.errors.push(`${where} thiếu "glob" là chuỗi non-empty — bỏ qua.`);
      return;
    }
    const action = entry['action'];
    if (action !== 'run' && action !== 'warn') {
      result.errors.push(`${where} có "action" không hợp lệ (chỉ "run" | "warn") — bỏ qua.`);
      return;
    }
    if (action === 'run') {
      const command = entry['command'];
      if (typeof command !== 'string' || command.trim() === '') {
        result.errors.push(`${where} action "run" thiếu "command" — bỏ qua.`);
        return;
      }
      parsed.push({
        glob,
        action,
        command,
        ...(typeof entry['description'] === 'string' ? { description: entry['description'] } : {}),
      });
      return;
    }
    parsed.push({
      glob,
      action,
      ...(typeof entry['message'] === 'string' ? { message: entry['message'] } : {}),
      ...(typeof entry['description'] === 'string' ? { description: entry['description'] } : {}),
    });
  });
  result.rules = parsed;
  return result;
}

export interface LoadedRules extends ParsedRules {
  /** false khi file không tồn tại (khi đó rules = mặc định, errors = []). */
  fileExists: boolean;
}

/** Đọc + parse một file rules. File thiếu → mặc định, không lỗi, không throw. */
export function loadRulesFile(filePath: string): LoadedRules {
  const fileExists = fs.existsSync(filePath);
  if (!fileExists) {
    return { ...defaultParsed(), fileExists: false };
  }
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    const result = defaultParsed();
    result.errors.push(
      `Không đọc được rules file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ...result, fileExists: true };
  }
  return { ...parseRulesFile(text), fileExists: true };
}

/**
 * Rules cho một workspace: load `<workspace>/.open-bot/rules.json` và
 * cache theo mtime (như skill loader load + cache theo thư mục). File
 * đổi trên đĩa → lần `get*` sau tự load lại; file thiếu/hỏng → mặc định.
 */
export class RulesStore {
  private readonly filePath: string;
  private cached: { mtimeMs: number; parsed: ParsedRules } | undefined;

  constructor(workspaceDir: string) {
    this.filePath = path.join(workspaceDir, RULES_DIR_NAME, RULES_FILE_NAME);
  }

  /** Đường dẫn file rules của workspace này. */
  get path(): string {
    return this.filePath;
  }

  private loadFresh(): ParsedRules {
    try {
      const stat = fs.statSync(this.filePath);
      if (this.cached !== undefined && this.cached.mtimeMs === stat.mtimeMs) {
        return this.cached.parsed;
      }
      const loaded = loadRulesFile(this.filePath);
      const parsed: ParsedRules = {
        rules: loaded.rules,
        safeCommands: loaded.safeCommands,
        sensitiveCommands: loaded.sensitiveCommands,
        errors: loaded.errors,
      };
      this.cached = { mtimeMs: stat.mtimeMs, parsed };
      return parsed;
    } catch {
      // File chưa có (hoặc stat lỗi) → mặc định, cache dưới mtime -1
      // cho tới khi file xuất hiện.
      if (this.cached === undefined || this.cached.mtimeMs !== -1) {
        this.cached = { mtimeMs: -1, parsed: defaultParsed() };
      }
      return this.cached.parsed;
    }
  }

  getRules(): GlobRule[] {
    return this.loadFresh().rules;
  }

  getSafeCommands(): string[] {
    return this.loadFresh().safeCommands;
  }

  getSensitiveCommands(): string[] {
    return this.loadFresh().sensitiveCommands;
  }

  getErrors(): string[] {
    return this.loadFresh().errors;
  }

  /** Bỏ cache, load lại từ đĩa ở lần `get*` sau. */
  reload(): void {
    this.cached = undefined;
    this.loadFresh();
  }
}

// ---------------------------------------------------------------------------
// 4. Hook PostToolUse: rule là cấu hình, hook là thực thi (P0-2)
// ---------------------------------------------------------------------------

export const GLOB_RULES_HOOK_NAME = 'glob-rules';

/**
 * Hook mặc định chạy glob rules sau mỗi tool call. Chỉ ghi chú vào
 * output của tool để model thấy và chạy lệnh rule (`run`) hoặc đọc cảnh
 * báo (`warn`); hook không tự thực thi lệnh shell. Đăng ký vào
 * `HookRegistry` như `createDenylistHook`:
 *   registry.register(createGlobRulesHook((ws) => rulesStoreFor(ws).getRules()));
 * `getRules` được gọi mỗi lần hook chạy nên file rules đổi trên đĩa là
 * hook nhận rule mới (qua cache mtime của RulesStore).
 *
 * v0.11 (nối tích hợp): `getRules` nhận `workspaceDir` của run hiện tại
 * (lấy từ `HookContext` mà loop truyền vào) để mỗi workspace dùng đúng
 * file `.open-bot/rules.json` của nó. Một hook duy nhất phục vụ mọi
 * workspace — coordinator giữ một `RulesStore` riêng cho mỗi workspace.
 * Closure không tham số vẫn dùng được (`() => rules` gán được cho
 * `(workspaceDir?) => ...`).
 */
export function createGlobRulesHook(
  getRules: (workspaceDir?: string) => readonly GlobRule[],
  opts: { workspaceDir?: string } = {},
): HookDefinition {
  return {
    name: GLOB_RULES_HOOK_NAME,
    description:
      'PostToolUse: sau mỗi tool ghi file, áp rule theo glob (vd *.ts → chạy typecheck).',
    events: ['PostToolUse'],
    source: 'builtin',
    enabled: true,
    handler: (event, ctx) => {
      if (event.event !== 'PostToolUse') return { action: 'allow' };
      if (!event.result.ok) return { action: 'allow' };
      // ctx có thể undefined khi hook được gọi trực tiếp trong test.
      const workspaceDir = ctx?.workspaceDir ?? opts.workspaceDir;
      const actions = evaluateFileRules(event.toolName, event.args, getRules(workspaceDir), {
        workspaceDir,
      });
      if (actions.length === 0) return { action: 'allow' };
      const lines = actions.map((a) =>
        a.kind === 'run'
          ? `[rule] File "${a.file}" khớp "${a.rule.glob}" — chạy: \`${a.command}\``
          : `[rule] ${a.message}`,
      );
      return modifyOutputDecision(
        `${event.result.output}\n${lines.join('\n')}`,
        `Glob rule kích hoạt sau khi ghi file: ${actions.length} rule.`,
      );
    },
  };
}
