/**
 * Kiểm tra từng dòng stdin của shell session (v0.20–v0.26, W13c/W14c/
 * W18b; tách từ `daemon.ts` ở v0.74b để đường session local của
 * `shellTools.ts` dùng CHUNG một logic với daemon — trước đây chỉ
 * daemon kiểm tra, đường local ghi thẳng stdin không kiểm tra gì).
 *
 * Một nơi duy nhất định nghĩa, dùng chung cho:
 *  - `handleSessionWrite` / `flushPendingPartialLine` của daemon
 *    (session chạy trong tiến trình daemon), và
 *  - `shell_session_write` / đóng session đường local của
 *    `shellTools.ts` (session spawn trực tiếp, không daemon).
 *
 * Thứ tự kiểm tra một dòng đầy đủ (xem `decideSessionLine`):
 *  1. Đang trong thân heredoc: dòng đúng bằng delimiter thì đóng
 *     heredoc và ghi thẳng; các dòng nội dung khác được kiểm tra
 *     denylist SAU KHI expand — vi phạm thì bỏ dòng đó.
 *  2. Gán biến đơn giản mà giá trị track được (không `$`/backtick):
 *     KHÔNG kiểm tra denylist trên giá trị thô — giá trị còn trơ cho
 *     tới khi expand thành dòng lệnh, và chính dòng lệnh đó (bước 3)
 *     mới bị chặn. Lưu vào `shellVars` rồi ghi dòng gốc.
 *     Gán mà giá trị KHÔNG track được (chứa `$`/backtick/`$(...)`):
 *     kiểm tra RAW như cũ (fail-closed — `$(...)` và backtick thực
 *     thi ngay lúc gán).
 *  3. Dòng thường: mở rộng `$NAME`/`${NAME}` đã track (1 lượt) rồi
 *     kiểm tra denylist trên chuỗi đã expand — vi phạm thì bỏ dòng.
 *     Qua thì ghi dòng gốc; nếu dòng mở heredoc thì ghi delimiter
 *     lại để các dòng sau được xử lý theo bước 1.
 *
 * Sau denylist, dòng còn phải qua kiểm tra egress
 * (`checkSessionLineEgress` / `checkSessionLineEgressSync`): dòng
 * chứa đích mạng mà policy chặn (hoặc session bị giam mà chưa có
 * policy) thì bị bỏ, session vẫn sống.
 *
 * `source` chỉ đổi nhãn trong message lỗi (`daemon` giữ nguyên từng
 * chữ như trước để test cũ không vỡ; `local` dùng nhãn
 * "shell session") — không đổi ngữ nghĩa kiểm tra.
 */
import { assertCommandAllowed } from '../sandbox';
import {
  checkEgress,
  checkEgressSync,
  EgressError,
  extractNetworkTargets,
  type EgressPolicy,
} from '@open-bot/core/dist/egress/policy';

/**
 * Trạng thái kiểm tra dòng của một session — daemon (`RunningSession`)
 * và session local (`ShellSession`) đều thỏa interface này về mặt
 * cấu trúc nên truyền thẳng vào được.
 */
export interface SessionLineState {
  /** Biến shell đơn giản đã track (W18b). */
  shellVars: Map<string, string>;
  /** Delimiter heredoc đang mở, null khi không trong thân heredoc. */
  heredocDelimiter: string | null;
  /** Workspace session bị giam vào; undefined = không giam. */
  workspaceDir?: string;
  /** Policy egress đã đóng băng lúc session_start; undefined = chưa có. */
  egressPolicy?: EgressPolicy;
  /** Nhãn nguồn cho message lỗi; mặc định 'daemon'. */
  source?: 'daemon' | 'local';
}

/** Trạng thái mới cho một session (biến + heredoc đều trống). */
export function createSessionLineState(
  workspaceDir?: string,
  egressPolicy?: EgressPolicy,
  source: 'daemon' | 'local' = 'daemon',
): SessionLineState {
  return { shellVars: new Map(), heredocDelimiter: null, workspaceDir, egressPolicy, source };
}

/** Mã lỗi cho một EgressError (map theo kind, giữ tên `egress_*` của Grok). */
export function egressErrorCode(err: EgressError): string {
  switch (err.kind) {
    case 'unconfigured':
      return 'EGRESS_UNCONFIGURED';
    case 'unreachable':
      return 'EGRESS_UNREACHABLE';
    case 'invalid_response':
      return 'EGRESS_INVALID_RESPONSE';
    case 'blocked':
    default:
      return 'EGRESS_BLOCKED';
  }
}

/**
 * Chỉ kiểm tra denylist cho một chuỗi lệnh — `checkDaemonPolicy` dùng
 * cho exec/session_start và `decideSessionLine` dùng cho từng dòng
 * stdin; một helper chung, không copy lại danh sách/mẫu cấm.
 * Trả về null khi qua, hoặc `{ message, code: 'COMMAND_BLOCKED' }`.
 */
export function checkCommandBlocked(
  command: string,
): { message: string; code: string } | null {
  try {
    assertCommandAllowed(command);
    return null;
  } catch (err) {
    return {
      message: err instanceof Error ? err.message : String(err),
      code: 'COMMAND_BLOCKED',
    };
  }
}

/**
 * Giới hạn theo dõi biến shell trong một session (W18b): tối đa 128
 * biến (biến cũ nhất bị đuổi khi đầy) và giá trị dài hơn 4096 ký tự
 * thì không track — chống caller phình bộ nhớ bằng gán dài /
 * nhiều biến. Cả hai đều là giới hạn của session, không phải của shell.
 */
export const MAX_TRACKED_SHELL_VARS = 128;
export const MAX_TRACKED_SHELL_VAR_VALUE_CHARS = 4096;

/**
 * Fragment dòng dở tối đa được giữ lại chờ `\n` (W14c): vượt ngưỡng
 * thì kiểm tra như một dòng rồi ghi thẳng ngay (không kèm `\n`, shell
 * vẫn chờ newline mới thực thi — không đổi ngữ nghĩa).
 */
export const MAX_PENDING_PARTIAL_LINE_CHARS = 64_000;

/**
 * Gán biến đơn giản trên một dòng (W18b): `NAME="giá trị"` /
 * `NAME='giá trị'` / `NAME=giá trị`, có thể có tiền tố `export ` và
 * khoảng trắng quanh. Tên biến `[A-Za-z_][A-Za-z0-9_]*`. Giá trị
 * unquoted không chứa khoảng trắng hay `;&|<>`. KHÔNG khớp: gán nhiều
 * biến / gán kèm lệnh trên cùng dòng (`A=1 cmd`), gán có comment
 * sau giá trị, giá trị chứa quote lồng nhau. Trả về null khi dòng
 * không có dạng gán đơn giản.
 */
const SIMPLE_ASSIGNMENT_RE =
  /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s;&|<>\n]*))\s*$/;

/** Dòng mở heredoc với delimiter literal đơn giản (W18b): `<<EOF`,
 *  `<<-EOF`, `<<'EOF'`, `<<"EOF"`. Không khớp herestring `<<<` (ký
 *  tự thứ ba `<` không phải quote/tên/dấu cách) và delimiter từ biến
 *  (`<<$EOF`) — trường hợp đó không track heredoc. */
const HEREDOC_OPENER_RE = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;

/**
 * Parse gán biến đơn giản (W18b): trả về `{ name, value }` (value là
 * chuỗi literal, đã bỏ quote ngoài) hoặc null khi dòng không có dạng
 * gán đơn giản. Không kết luận ở đây là gán có track được không —
 * caller kiểm tra `$`/backtick trong value.
 */
function parseSimpleAssignment(line: string): { name: string; value: string } | null {
  const m = SIMPLE_ASSIGNMENT_RE.exec(line);
  if (m === null) return null;
  return {
    name: m[1] as string,
    value: ((m[2] ?? m[3] ?? m[4] ?? '') as string),
  };
}

/**
 * Mở rộng tham chiếu `$NAME` / `${NAME}` bằng giá trị đã track (W18b):
 * đúng 1 lượt, không đệ quy (giá trị track được không chứa `$` nên
 * không có gì để expand thêm, và không có vòng lặp vô hạn); biến
 * không track được giữ nguyên `$NAME` / `${NAME}`. `$$` (PID) và `$9`
 * (tham số vị trí) không khớp mẫu tên biến nên giữ nguyên; `\$NAME`
 * (escaped, shell coi là literal) cũng giữ nguyên.
 */
function expandShellVars(line: string, vars: Map<string, string>): string {
  return line.replace(
    /(\\?)\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (whole, escaped: string, braced: string | undefined, plain: string | undefined) => {
      if (escaped !== '') return whole;
      const name = braced ?? plain ?? '';
      const value = vars.get(name);
      return value === undefined ? whole : value;
    },
  );
}

/** Delimiter literal của dòng mở heredoc (W18b), hoặc null khi dòng
 *  không mở heredoc. */
function parseHeredocDelimiter(line: string): string | null {
  const m = HEREDOC_OPENER_RE.exec(line);
  return m === null ? null : (m[2] as string);
}

export interface SessionLineDecision {
  /** true = ghi dòng gốc vào stdin; false = bỏ dòng, session vẫn sống. */
  write: boolean;
  /** Lý do chặn (chỉ có khi write === false). */
  blockedMessage?: string;
}

function sourceLabel(state: SessionLineState): string {
  return state.source === 'local' ? 'shell session' : 'daemon';
}

function sessionBlockedMessage(
  state: SessionLineState,
  denied: { message: string },
): string {
  // Nhãn daemon giữ nguyên từng chữ như trước (test daemon-cap khớp
  // message); đường local chỉ đổi nhãn + bỏ "của daemon".
  const by =
    state.source === 'local' ? 'bởi denylist' : 'bởi denylist của daemon';
  return (
    `${sourceLabel(state)}: dòng stdin bị chặn ${by} ` +
    `(workspace "${state.workspaceDir ?? '?'}"): ${denied.message}`
  );
}

/**
 * Quyết định cho MỘT dòng đầy đủ của `session_write` (W18b) — một nơi
 * duy nhất định nghĩa kiểm tra dòng, dùng chung cho `handleSessionWrite`
 * (dòng đầy đủ + fragment vượt cap), `flushPendingPartialLine`
 * (fragment lúc đóng) và cả ba đều ghi dòng GỐC vào stdin (không bao
 * giờ ghi dòng đã expand — shell tự expand, chỉ kiểm tra).
 */
export function decideSessionLine(
  state: SessionLineState,
  line: string,
): SessionLineDecision {
  if (state.heredocDelimiter !== null) {
    if (line.trim() === state.heredocDelimiter) {
      state.heredocDelimiter = null;
      return { write: true };
    }
    const denied = checkCommandBlocked(expandShellVars(line, state.shellVars));
    if (denied !== null) {
      return { write: false, blockedMessage: sessionBlockedMessage(state, denied) };
    }
    return { write: true };
  }
  const assignment = parseSimpleAssignment(line);
  if (assignment !== null) {
    const trackable =
      !assignment.value.includes('$') && !assignment.value.includes('`');
    if (trackable) {
      if (assignment.value.length <= MAX_TRACKED_SHELL_VAR_VALUE_CHARS) {
        if (
          !state.shellVars.has(assignment.name) &&
          state.shellVars.size >= MAX_TRACKED_SHELL_VARS
        ) {
          const oldest = state.shellVars.keys().next().value;
          if (oldest !== undefined) state.shellVars.delete(oldest);
        }
        state.shellVars.set(assignment.name, assignment.value);
      }
      return { write: true };
    }
    const denied = checkCommandBlocked(line);
    if (denied !== null) {
      return { write: false, blockedMessage: sessionBlockedMessage(state, denied) };
    }
    return { write: true };
  }
  const denied = checkCommandBlocked(expandShellVars(line, state.shellVars));
  if (denied !== null) {
    return { write: false, blockedMessage: sessionBlockedMessage(state, denied) };
  }
  const delimiter = parseHeredocDelimiter(line);
  if (delimiter !== null) state.heredocDelimiter = delimiter;
  return { write: true };
}

function egressUnconfiguredMessage(state: SessionLineState, fragment: boolean): string {
  const what = fragment ? 'dòng dở cuối' : 'dòng stdin';
  return (
    `${sourceLabel(state)}: ${what} bị chặn vì egress chưa cấu hình (egress_unconfigured) ` +
    `(workspace "${state.workspaceDir ?? '?'}"): dòng chứa đích mạng nhưng session chưa có policy egress rõ ràng.`
  );
}

function egressBlockedMessage(
  state: SessionLineState,
  fragment: boolean,
  err: EgressError,
): string {
  const what = fragment ? 'dòng dở cuối' : 'dòng stdin';
  return (
    `${sourceLabel(state)}: ${what} bị chặn bởi egress policy ` +
    `(workspace "${state.workspaceDir ?? '?'}"): ${err.message}`
  );
}

/**
 * Kiểm tra egress cho MỘT dòng stdin đầy đủ của session (P0-2):
 * dòng chứa đích mạng (curl/wget/git clone/URL) thì mỗi đích phải qua
 * policy đã đóng băng của session. Session bị giam mà chưa có policy
 * → chặn fail-closed `EGRESS_UNCONFIGURED`. Dòng không có đích mạng
 * → null (cho qua, không tốn DNS). Trả về null khi qua, hoặc
 * `{ message, code }` khi chặn (dòng bị bỏ, session vẫn sống).
 * `fragment: true` dùng cho đường flush fragment lúc đóng (message
 * nói "dòng dở cuối" thay vì "dòng stdin").
 */
export async function checkSessionLineEgress(
  state: SessionLineState,
  line: string,
  opts?: { fragment?: boolean },
): Promise<{ message: string; code: string } | null> {
  const targets = extractNetworkTargets(line);
  if (targets.length === 0) return null;
  const policy = state.egressPolicy;
  if (policy === undefined) {
    return {
      message: egressUnconfiguredMessage(state, opts?.fragment === true),
      code: 'EGRESS_UNCONFIGURED',
    };
  }
  for (const target of targets) {
    try {
      await checkEgress(target, policy, { context: 'agent' });
    } catch (err) {
      if (err instanceof EgressError) {
        return {
          message: egressBlockedMessage(state, opts?.fragment === true, err),
          code: egressErrorCode(err),
        };
      }
      throw err;
    }
  }
  return null;
}

/**
 * Bản đồng bộ của `checkSessionLineEgress` (không DNS) cho đường
 * flush fragment lúc đóng session (`flushPendingPartialLine`): host
 * ở mode allow-public / githubEgressIps không xác minh được IP thì
 * fail-closed (xem `checkEgressSync`). Dòng bị chặn thì bỏ, không ghi.
 */
export function checkSessionLineEgressSync(
  state: SessionLineState,
  line: string,
  opts?: { fragment?: boolean },
): { message: string } | null {
  const targets = extractNetworkTargets(line);
  if (targets.length === 0) return null;
  const policy = state.egressPolicy;
  if (policy === undefined) {
    return { message: egressUnconfiguredMessage(state, opts?.fragment === true) };
  }
  for (const target of targets) {
    try {
      checkEgressSync(target, policy, { context: 'agent' });
    } catch (err) {
      if (err instanceof EgressError) {
        return { message: egressBlockedMessage(state, opts?.fragment === true, err) };
      }
      throw err;
    }
  }
  return null;
}
