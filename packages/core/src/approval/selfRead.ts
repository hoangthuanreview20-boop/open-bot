/**
 * Quy tắc "bot đọc file của chính nó không bao giờ hỏi" (M8).
 *
 * Học từ OpenMausBot (docs/research-openmausbot.md §9): bot đọc file
 * của chính nó — SOUL.md, skill, memory, thư mục hội thoại của nó —
 * không bao giờ hiện thẻ approval, kể cả lệnh đọc đơn giản
 * (`cat/head/tail/grep/rg/sed -n/ls/wc/nl/stat`) và các tool Read/Grep/
 * Glob/LS, khi mọi đường dẫn nằm trong thư mục của bot.
 *
 * Implement trong open-bot thành rule tường minh, fail-closed:
 *  - CHỈ áp cho thao tác ĐỌC (tool chỉ-đọc có đường dẫn, hoặc lệnh
 *    shell đọc đơn giản). Tool ghi (`write_file`, `shell_exec` chạy
 *    lệnh ghi, …) không bao giờ được miễn — kể cả trong workspace.
 *  - Mọi đường dẫn phải nằm TRONG workspace của bot (resolve tuyệt
 *    đối + chặn `..`/symlink thoát ra ngoài bằng tiền tố thư mục).
 *    Một đường dẫn ngoài workspace → không miễn, hỏi như thường.
 *  - Lệnh shell chỉ miễn khi ĐƠN (không `&&`/`||`/`;`/`|`/redirect/
 *    substitution), có ít nhất một toán hạng đường dẫn tường minh
 *    (lệnh đọc trần như `ls`/`cat` không file đọc cwd/stdin không rõ
 *    → không miễn, hỏi như thường — fail-closed), và mọi toán hạng
 *    đường dẫn đều trong workspace.
 *  - Không có đường dẫn nào trong args (vd `list_files` không tham
 *    số = liệt kê gốc workspace) → miễn (đọc gốc workspace của nó).
 *
 * Module PURE (không I/O, không đọc đĩa để kiểm tra symlink thật —
 * chỉ kiểm tra chuỗi đường dẫn đã resolve; lớp guardrail/hook vẫn
 * chặn thoát workspace ở tầng thực thi như cũ).
 */

import * as path from 'node:path';
import { isReadOnlyTool } from '../agent/toolFilter';

/** Tool đọc file có tham số đường dẫn (tên tham số chứa đường dẫn). */
const READ_TOOL_PATH_ARGS: Record<string, readonly string[]> = {
  read_file: ['path'],
  list_files: ['path', 'dir'],
  glob_files: ['dir', 'pattern'],
  grep_search: ['path', 'dir'],
  semantic_search: [],
  code_diagnostics: ['path'],
};

/** Lệnh shell đọc đơn giản được miễn (khi mọi đường dẫn trong workspace). */
const SELF_READ_SHELL_COMMANDS: ReadonlySet<string> = new Set([
  'cat',
  'head',
  'tail',
  'grep',
  'rg',
  'ls',
  'wc',
  'nl',
  'stat',
  'file',
  'less',
  'more',
  'sed',
]);

/** Toán tử shell → lệnh không còn "đơn", không được miễn. */
const SHELL_OPERATOR_RE = /(?:&&|\|\||[;&|`]|[$][(]|>|<|\n|\r)/;

/** Key chứa secret — giá trị của chúng không bao giờ hiện trên thẻ duyệt. */
const SECRET_KEY_RE = /api[_-]?key|token|secret|password|passwd|auth|bearer|private[_-]?key/i;
/** Hình dạng secret thường gặp trong chuỗi tự do (Bearer, sk-…, xai-…). */
const SECRET_VALUE_RE = /(Bearer\s+)[^\s"']+|(sk-[A-Za-z0-9_-]{4,})|(xai-[A-Za-z0-9_-]{4,})/g;

export const REDACTED_ARG = '<redacted>';

/**
 * Đường dẫn `target` (tuyệt đối hoặc tương đối theo workspace) có nằm
 * trong `workspaceDir` không. Trả false khi workspace rỗng/không rõ
 * (fail-closed: không miễn khi không xác định được ranh giới).
 */
export function isPathInsideWorkspace(target: string, workspaceDir: string): boolean {
  if (!target || !workspaceDir) return false;
  const root = path.resolve(workspaceDir);
  const resolved = path.resolve(root, target);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Tách tool call qua dispatcher gom nhóm (v0.10): tool tên nhóm (vd
 * `file`) với args `{ operation: "<tool gốc>", args: {...} }` → trả về
 * tool gốc + args thật. Không phải dispatcher → trả nguyên.
 */
function unwrapGroupedCall(
  toolName: string,
  args: Record<string, unknown>,
): { toolName: string; args: Record<string, unknown> } {
  const operation = args['operation'];
  const inner = args['args'];
  if (
    typeof operation === 'string' &&
    inner !== null &&
    typeof inner === 'object' &&
    !Array.isArray(inner)
  ) {
    return { toolName: operation, args: inner as Record<string, unknown> };
  }
  return { toolName, args };
}

/**
 * Các đường dẫn trong args của một tool đọc (theo bảng trên). Tool
 * không có trong bảng → không rõ đường dẫn → trả null (không miễn).
 */
function readToolPaths(toolName: string, args: Record<string, unknown>): string[] | null {
  const keys = READ_TOOL_PATH_ARGS[toolName];
  if (keys === undefined) return null;
  const out: string[] = [];
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') out.push(value);
  }
  return out;
}

/**
 * Lệnh shell có phải "lệnh đọc đơn giản của chính bot" không: một lệnh
 * đọc trong danh sách, không toán tử ghép/redirect/substitution, và
 * mọi toán hạng đường dẫn đều trong workspace.
 *
 * `sed` chỉ miễn với `-n` (in, không sửa); `sed -i` (sửa tại chỗ) là
 * ghi → không miễn. `grep`/`rg`: toán hạng đầu không phải flag là
 * pattern tìm kiếm (không phải đường dẫn) nên bỏ qua; các toán hạng
 * sau đó là đường dẫn.
 */
export function isSelfReadShellCommand(command: string, workspaceDir: string): boolean {
  if (typeof command !== 'string' || command.trim() === '') return false;
  if (SHELL_OPERATOR_RE.test(command)) return false;
  const tokens = command.trim().split(/\s+/);
  const cmd = (tokens[0] ?? '').split('/').pop() ?? '';
  if (!SELF_READ_SHELL_COMMANDS.has(cmd)) return false;
  const rest = tokens.slice(1);
  // sed: bắt buộc có -n, cấm -i (ghi tại chỗ).
  if (cmd === 'sed') {
    if (!rest.includes('-n')) return false;
    if (rest.some((t) => t === '-i' || t.startsWith('-i'))) return false;
  }
  // Bỏ qua flag (-x / --long) và, với grep/rg, pattern đầu tiên;
  // với sed -n, script đầu tiên (sau -n). Đếm toán hạng đường dẫn:
  // lệnh đọc KHÔNG có toán hạng đường dẫn tường minh (vd `ls` trần,
  // `cat` không file — đọc stdin/cwd không rõ) thì KHÔNG miễn
  // (fail-closed: hỏi như thường).
  let skipNext = false;
  let skippedPattern = false;
  let pathOperands = 0;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] ?? '';
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token.startsWith('-') && token !== '-') {
      // -n của sed: token sau là script, không phải đường dẫn —
      // đánh dấu đã qua script để toán hạng sau được tính là đường dẫn.
      if (cmd === 'sed' && token === '-n') {
        skipNext = true;
        skippedPattern = true;
      }
      continue;
    }
    if ((cmd === 'grep' || cmd === 'rg') && !skippedPattern) {
      skippedPattern = true;
      continue;
    }
    if (cmd === 'sed' && !skippedPattern) {
      skippedPattern = true; // script sed (vd '1,10p')
      continue;
    }
    if (!isPathInsideWorkspace(token, workspaceDir)) return false;
    pathOperands += 1;
  }
  return pathOperands > 0;
}

/**
 * Tool call này có phải "bot đọc file của chính nó" không — tức là
 * được MIỄN thẻ approval (loop bỏ qua cả hai nhánh hỏi duyệt).
 * Tool ghi, tool đọc ngoài workspace, lệnh shell không đơn giản đều
 * trả false (hỏi như thường theo mức approval của bot).
 */
export function isSelfReadCall(
  toolName: string,
  args: Record<string, unknown>,
  workspaceDir: string | undefined,
): boolean {
  if (!workspaceDir) return false;
  const unwrapped = unwrapGroupedCall(toolName, args);
  // Lệnh shell: chỉ miễn khi là lệnh đọc đơn giản trong workspace.
  if (unwrapped.toolName === 'shell_exec') {
    const command = unwrapped.args['command'];
    return typeof command === 'string' && isSelfReadShellCommand(command, workspaceDir);
  }
  if (!isReadOnlyTool(unwrapped.toolName)) return false;
  const paths = readToolPaths(unwrapped.toolName, unwrapped.args);
  if (paths === null) return false;
  return paths.every((p) => isPathInsideWorkspace(p, workspaceDir));
}

// ---------------------------------------------------------------------------
// Tóm tắt args cho thẻ duyệt (redact secret như tracing đã làm)
// ---------------------------------------------------------------------------

function redactValue(key: string, value: unknown): unknown {
  if (typeof value === 'string') {
    if (SECRET_KEY_RE.test(key)) return REDACTED_ARG;
    const redacted = value.replace(SECRET_VALUE_RE, (_m, bearer?: string) =>
      bearer ? `${bearer}${REDACTED_ARG}` : REDACTED_ARG,
    );
    return redacted;
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(key, v));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(k, v);
    }
    return out;
  }
  return value;
}

/** Độ dài tối đa của bản tóm tắt args trên thẻ (tránh thẻ phình). */
export const CARD_ARGS_SUMMARY_MAX_CHARS = 500;

/**
 * Tóm tắt args của một tool call để hiện trên thẻ duyệt: JSON rút gọn
 * (tối đa 500 ký tự), giá trị secret bị che thành `<redacted>` theo
 * tên key (apiKey/token/secret/password/…) và theo hình dạng giá trị
 * (Bearer …, sk-…, xai-…). Không bao giờ trả về secret thật.
 */
export function summarizeArgsForCard(args: Record<string, unknown>): string {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    redacted[key] = redactValue(key, value);
  }
  let text: string;
  try {
    text = JSON.stringify(redacted);
  } catch {
    text = '{}';
  }
  if (text.length > CARD_ARGS_SUMMARY_MAX_CHARS) {
    return text.slice(0, CARD_ARGS_SUMMARY_MAX_CHARS) + '…';
  }
  return text;
}
