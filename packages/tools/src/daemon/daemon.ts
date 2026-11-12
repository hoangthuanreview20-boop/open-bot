/**
 * local-exec-daemon: a child process that runs long shell commands.
 *
 * Protocol: NDJSON-RPC over stdio (see ./types.ts). One JSON object per
 * line on stdin; responses and notifications (exec.stdout / exec.stderr)
 * as JSON lines on stdout. The daemon's own diagnostics go to stderr —
 * never to stdout, which is reserved for the protocol.
 *
 * Methods:
 *   init     — đặt workspaceDir để daemon tự giam lệnh (v0.15, M1)
 *   exec     — spawn a command, stream its output, resolve with ExecResult
 *   kill     — kill a running execId ({ killed: boolean }, idempotent)
 *   list     — running execs ([ExecInfo])
 *   ping     — liveness check ({ pong: true })
 *   shutdown — reply { ok: true }, kill any running execs, flush the
 *     pending partial line of each running session before killing it
 *     (W19d, v0.26 — giống `session_close`: fragment lành được ghi kèm
 *     `\n`, đóng stdin rồi chờ tối đa SESSION_CLOSE_KILL_DELAY_MS cho
 *     shell tự thoát), exit 0
 *   session_start / session_write / session_close / session_list —
 *     interactive shells (v0.6): output streams as session.stdout /
 *     session.stderr notifications, exit as session.exit.
 *     (v0.20: session_write kiểm tra denylist từng dòng stdin — xem
 *     Defence-in-depth bên dưới; dòng vi phạm → COMMAND_BLOCKED.
 *     W14c: đệm dòng dở cuối qua các lần ghi để lệnh cấm tách nhỏ
 *     không lọt; session_close flush fragment lành còn lại.)
 *
 * Limits (v0.6, đổi ở v0.14):
 *   - at most `maxExecs` execs at once (mặc định 4, cấu hình qua option
 *     `maxExecs` của startDaemon() hoặc env OPENBOT_DAEMON_MAX_EXECS);
 *     exec vượt cap KHÔNG bị reject nữa mà XẾP HÀNG FIFO — khi có slot
 *     trống daemon tự chạy exec tiếp theo, và exec đang chờ được báo rõ
 *     trong output (chunk "[daemon] exec ... đang chờ ..." + event
 *     `exec.queued`). Trước v0.14 exec vượt cap bị reject với code
 *     CONCURRENCY_LIMIT; hành vi đó đã đổi thành queue ở v0.14.
 *   - each exec/session stream is capped at MAX_EXEC_OUTPUT_CHARS chars;
 *     past the cap one truncation marker is sent and the rest is dropped.
 *   - output streaming tới callback `onOutputChunk` (option của
 *     startDaemon) có buffer riêng tối đa 1MB / exec; vượt thì truncate
 *     + ghi chú, rồi dừng gọi callback cho exec đó.
 *
 * The daemon never exits on its own while execs are running or idle: it
 * only exits when stdin closes, on `shutdown`, or on SIGTERM/SIGINT.
 * Every failure (unknown command, missing cwd, bad params) is answered
 * with an error response — the daemon itself never crashes on a bad
 * request.
 *
 * Defence-in-depth (v0.15, sửa M1 + M2 của audit bảo mật; v0.16 mở
 * rộng M1 thành giam theo từng request — đa bot):
 *  - Khi daemon được cấu hình `workspaceDir` (qua option `workspaceDir`
 *    của startDaemon(), qua method `init` của giao thức NDJSON-RPC, hoặc
 *    qua env `OPENBOT_DAEMON_WORKSPACE_DIR` khi chạy độc lập), daemon TỰ
 *    kiểm tra trước khi spawn, không trông chờ caller làm hộ:
 *    `assertCommandAllowed` trên toàn bộ chuỗi lệnh (tên chương trình +
 *    args đã nối — vì caller thường spawn `/bin/sh -c "<lệnh>"`, chỉ
 *    kiểm tra tên chương trình thì denylist không bao giờ khớp) và
 *    `resolveWithin` để cwd không thoát khỏi workspace. Lệnh/cwd vi
 *    phạm được trả về qua respondError (mã `COMMAND_BLOCKED` /
 *    `CWD_OUTSIDE_WORKSPACE`), daemon vẫn sống và phục vụ request sau.
 *    Khi KHÔNG có workspaceDir thì giữ hành vi cũ (chỉ validate kiểu)
 *    để không phá caller cũ.
 *  - v0.16 (M1 đa bot): mỗi request `exec` / `session_start` có thể mang
 *    theo `workspaceDir` của riêng nó (bot gọi request đó). Thứ tự ưu
 *    tiên: request workspaceDir > daemon workspaceDir > không giam.
 *    `workspaceDir` trong request không được tin mù: daemon chuẩn hoá
 *    thành đường dẫn tuyệt đối (path.resolve) và cwd của request vẫn
 *    phải nằm trong workspaceDir đó (resolveWithin) — một request không
 *    thể tự khai workspaceDir rộng hơn để thoát giam của chính nó, vì
 *    cwd vẫn bị giam vào đúng workspaceDir nó khai; còn daemon
 *    workspaceDir (nếu có) chỉ bị thay thế khi request khai workspaceDir
 *    khác — đó là thiết kế cho daemon dùng chung nhiều bot, và lớp tool
 *    (shell_exec / exec_task / shell_session_start) luôn truyền
 *    workspaceDir của bot gọi, không lấy từ input của agent.
 *  - Allowlist thư mục gốc (sau v0.18): một caller độc hại gọi thẳng
 *    daemon vẫn có thể tự khai workspaceDir rộng (`/`) để thoát giam
 *    theo thiết kế v0.16 — chống được chỉ khi daemon có allowlist thư
 *    mục gốc: mọi `workspaceDir` (của request lẫn của daemon) phải nằm
 *    trong (hoặc bằng) một root trong `allowedWorkspaceRoots` (option
 *    của startDaemon() > env `OPENBOT_DAEMON_ALLOWED_ROOTS`, phân tách
 *    bằng `path.delimiter` — `:` trên POSIX, `;` trên Windows — hoặc
 *    method `init`, chỉ đặt được khi chưa cấu hình, như `workspaceDir`).
 *    Kiểm tra bằng `resolveWithin` nên symlink trỏ ra ngoài root cũng
 *    bị chặn (realpath). workspaceDir ngoài allowlist → respondError mã
 *    `WORKSPACE_NOT_ALLOWED`, daemon vẫn sống. Khi KHÔNG cấu hình
 *    allowlist thì giữ hành vi cũ (không chặn thêm) để không phá
 *    caller cũ — và khi không có workspaceDir nào (request lẫn daemon)
 *    thì không có gì để kiểm tra, exec chạy như cũ.
 *  - v0.20 (W13c, session_write): session đã mở là đường chui qua
 *    denylist — `session_write` trước đây ghi thẳng stdin không kiểm
 *    tra gì, nên lệnh cấm có thể chui qua stdin của session đang chạy.
 *    Nay mỗi lần `session_write` nhận input, daemon tách input thành
 *    dòng (theo `\n`, bỏ dòng trống) và kiểm tra từng dòng bằng cùng
 *    `assertCommandAllowed` mà `checkDaemonPolicy` dùng cho
 *    exec/session_start (qua helper chung `checkCommandBlocked` — một
 *    nơi định nghĩa, không copy logic). Dòng vi phạm → trả lỗi
 *    `COMMAND_BLOCKED`, KHÔNG ghi dòng đó vào stdin; các dòng lành
 *    trong cùng lần ghi vẫn được ghi, session vẫn sống để các lần ghi
 *    sau chạy tiếp. Chỉ áp dụng khi session được giam (có
 *    workspaceDir hiệu lực lúc `session_start` — request > daemon,
 *    đóng băng trên entry của session); session không có workspaceDir
 *    thì giữ hành vi cũ (không kiểm tra), giống exec/session_start.
 *    Giới hạn đã biết: dòng stdin là dữ liệu vẫn bị chặn nếu khớp mẫu
 *    denylist (vd dòng text chứa `sudo` trong heredoc — cùng tiêu chí
 *    như exec, không có ngoại lệ cho dữ liệu).
 *  - v0.20 (W14c, session_write): đóng lỗ tách nhỏ lệnh cấm qua nhiều
 *    lần ghi (gap W13c để lại) — mỗi session giữ lại CHỈ phần dòng dở
 *    cuối cùng (fragment chưa có `\n`) trong `pendingPartialLine`;
 *    mỗi lần ghi nối fragment cũ + input mới, chỉ kiểm tra các dòng ĐẦY
 *    ĐỦ (đã có `\n`) bằng `checkCommandBlocked`, fragment cuối chưa
 *    hoàn chỉnh được giữ lại. An toàn mà không kẹt chương trình tương
 *    tác: shell chỉ thực thi dòng khi nhận `\n`, nên giữ fragment
 *    chưa có newline không đổi ngữ nghĩa; vim/less không chờ newline
 *    để vẽ (fragment bị giữ chỉ là text đang gõ, không phải output).
 *    Fragment vượt `MAX_PENDING_PARTIAL_LINE_CHARS` (64k) thì không
 *    giữ nữa — kiểm tra như một dòng rồi ghi thẳng vào stdin ngay
 *    (không kèm `\n`, shell vẫn chờ newline mới thực thi).
 *    Khi `session_close`: flush fragment còn lại — kiểm tra rồi mới
 *    ghi (kèm `\n` để shell chạy nốt dòng cuối) hoặc bỏ + ghi log
 *    stderr nếu vi phạm; best-effort, không fail thao tác đóng nếu
 *    stdin đã đóng. Shell tự thoát thì không flush được nữa (stdin
 *    đã đóng cùng tiến trình) — fragment khi đó bị bỏ.
 *    (W19d, v0.26: `shutdownDaemon` cũng flush fragment lành của từng
 *    session đang chạy trước khi kill — đóng stdin (EOF) rồi chờ tối
 *    đa SESSION_CLOSE_KILL_DELAY_MS cho shell tự thoát; shell tự
 *    thoát trước đó thì không flush được, như cũ.)
 *  - (W18b): đóng lỗ ghép lệnh cấm bằng biến shell / heredoc nhiều
 *    dòng — mỗi session track các gán biến đơn giản (`NAME="giá trị"`,
 *    giá trị không chứa `$`/backtick) và mở rộng `$NAME`/`${NAME}`
 *    (1 lượt, không đệ quy) trước khi kiểm tra denylist từng dòng;
 *    nội dung heredoc cũng qua kiểm tra (sau expand) thay vì ghi
 *    thẳng. Gán biến đơn giản KHÔNG bị chặn vì giá trị chứa từ cấm
 *    (giá trị còn trơ cho tới khi expand thành dòng lệnh — dòng lệnh
 *    đó mới bị chặn); gán có giá trị chứa `$`/backtick thì KHÔNG
 *    track và kiểm tra raw như cũ (fail-closed, vì `$(...)`/backtick
 *    thực thi ngay lúc gán). Giới hạn: không parse shell đầy đủ —
 *    chỉ gán một biến trên một dòng, chỉ delimiter heredoc literal
 *    đơn giản, biến export từ chương trình con / `export` từ file
 *    khác không track được, `echo $VAR` mà VAR chứa từ cấm cũng bị
 *    chặn (denylist khớp cả chuỗi đã expand, như `echo sudo ...`
 *    vốn đã bị chặn).
 *  - P0-2 (egress, theo §10 REA deep-dive lần 2): khi daemon bị giam
 *    (có workspaceDir hiệu lực — request > daemon), lệnh exec /
 *    session_start / từng dòng stdin của session_write chứa đích mạng
 *    (curl/wget/git clone/ssh/URL) phải qua egress policy
 *    (`packages/core/src/egress/`): policy hiệu lực request > daemon
 *    (option `egressPolicy` > env `OPENBOT_DAEMON_EGRESS_POLICY` JSON >
 *    method `init`, chỉ đặt khi chưa cấu hình như workspaceDir).
 *    Không có policy nào → chặn fail-closed mã `EGRESS_UNCONFIGURED`
 *    với lỗi rõ ràng, không spawn/ghi (không treo/timeout khó hiểu).
 *    Có policy → mỗi đích phải qua allowlist/DNS check; lỗi map theo
 *    kind (`EGRESS_BLOCKED` / `EGRESS_UNREACHABLE` /
 *    `EGRESS_INVALID_RESPONSE`). Lệnh không có đích mạng không bị ảnh
 *    hưởng. Session không giam (không workspaceDir) giữ hành vi cũ
 *    (không kiểm tra egress) để không phá caller cũ. Fragment dòng dở
 *    lúc đóng session chỉ qua được bản sync `checkEgressSync` (không
 *    DNS): host mode allow-public không xác minh được thì fail-closed
 *    (giới hạn đã ghi trong docs/egress-policy.md).
 *  - Khi caller không truyền `env`, tiến trình con chỉ nhận `safeEnv()`
 *    (allowlist, không secret) thay vì kế thừa toàn bộ `process.env`
 *    của daemon. Khi caller CÓ truyền `env` thì giữ nguyên env đó
 *    (caller chịu trách nhiệm — `shell_exec` đã truyền safeEnv()).
 *  - Wiring cho app thật: DaemonClient spawn daemon.js kế thừa env của
 *    tiến trình cha, nên host đặt `OPENBOT_DAEMON_WORKSPACE_DIR` trước
 *    khi tạo DaemonClient (hoặc gọi method `init` ngay sau khi nối);
 *    việc nối vào coordinator/main thuộc worker khác, không làm ở đây.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { killProcessGroupOfChild } from '../killProcessGroup';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as readline from 'node:readline';
// v0.15 (M1 + M2): daemon tự áp denylist/cwd confinement và dùng
// safeEnv() làm env mặc định — import từ sandbox dùng chung, không
// định nghĩa lại ở đây (sandbox không import daemon nên không có cycle).
import { resolveWithin, safeEnv } from '../sandbox';
// P0-2: egress policy chung của core — daemon kiểm tra đích mạng trong
// lệnh exec / dòng stdin của session TRƯỚC khi spawn/ghi (fail-closed
// khi session box bị giam mà chưa có policy).
import {
  checkEgress,
  EgressError,
  extractNetworkTargets,
  validateEgressPolicy,
  type EgressPolicy,
} from '@open-bot/core/dist/egress/policy';
// v0.74b: kiểm tra từng dòng stdin (denylist + var expansion + heredoc
// + egress) đã tách sang module dùng chung `sessionLine.ts` — đường
// session local của shellTools dùng đúng một logic này với daemon.
import {
  checkCommandBlocked,
  checkSessionLineEgress,
  checkSessionLineEgressSync,
  decideSessionLine,
  egressErrorCode,
  MAX_PENDING_PARTIAL_LINE_CHARS,
} from './sessionLine';
export { MAX_PENDING_PARTIAL_LINE_CHARS } from './sessionLine';
import type { DaemonRequest, DaemonResponse, ExecInfo, SessionInfo } from './types';
import {
  DEFAULT_DAEMON_MAX_EXECS,
  EXEC_OUTPUT_TRUNCATED_MARKER,
  MAX_EXEC_OUTPUT_CHARS,
} from './types';
export { DEFAULT_DAEMON_MAX_EXECS } from './types';

/** Option của startDaemon() (v0.14). Toàn bộ đều optional để tương thích
 *  ngược: startDaemon() không đối số vẫn chạy như trước, chỉ khác cap
 *  mặc định (4) và exec vượt cap xếp hàng thay vì bị reject. */
export interface DaemonOptions {
  /** Số exec chạy song song tối đa. Ưu tiên cao nhất; khi không có thì
   *  đọc env OPENBOT_DAEMON_MAX_EXECS; khi cả hai đều không có thì 4. */
  maxExecs?: number;
  /** Thư mục workspace daemon tự giam lệnh vào (v0.15, M1). Khi có,
   *  daemon tự gọi `assertCommandAllowed` (trên chuỗi lệnh đã nối) +
   *  `resolveWithin` với thư mục này trong `handleExec` /
   *  `handleSessionStart` TRƯỚC khi spawn; lệnh/cwd vi phạm bị từ
   *  chối qua respondError. Khi không có (daemon chạy độc lập, caller
   *  cũ) thì giữ hành vi cũ: chỉ validate kiểu, không kiểm tra thêm.
   *  Ưu tiên: option này > env OPENBOT_DAEMON_WORKSPACE_DIR. */
  workspaceDir?: string;
  /** Thư mục gốc cho phép chứa workspaceDir (allowlist, sau v0.18).
   *  Khi có, mọi `workspaceDir` (của request lẫn của daemon) phải nằm
   *  trong (hoặc bằng) một root trong danh sách này — kiểm tra bằng
   *  `resolveWithin` nên symlink trỏ ra ngoài root cũng bị chặn
   *  (realpath); ngoài allowlist thì exec/session bị từ chối mã
   *  `WORKSPACE_NOT_ALLOWED`, daemon vẫn sống. Khi không có thì giữ
   *  hành vi cũ (không chặn thêm). Ưu tiên: option này > env
   *  `OPENBOT_DAEMON_ALLOWED_ROOTS` (phân tách bằng `path.delimiter`).
   *  Có thể đặt sau khi chạy bằng method `init` (chỉ khi chưa cấu
   *  hình, như `workspaceDir`). */
  allowedWorkspaceRoots?: string[];
  /** Callback nhận từng chunk output đã stream của mỗi exec
   *  (stdout + stderr, đã qua cap 200k ký tự / stream). Nhận
   *  (execId, chunk); tổng buffer tối đa 1MB / exec, vượt thì truncate
   *  + ghi chú rồi dừng gọi callback cho exec đó. */
  onOutputChunk?: (execId: string, chunk: string) => void;
  /**
   * P0-2: egress policy chung của daemon (xem
   * `packages/core/src/egress/`). Khi có, mọi exec/session bị giam
   * (có workspaceDir hiệu lực) chứa đích mạng đều phải qua policy này
   * — trừ khi request mang policy riêng (request > daemon). Khi
   * daemon bị giam mà KHÔNG có policy (cả option lẫn env lẫn `init`)
   * thì lệnh có đích mạng bị chặn fail-closed mã `EGRESS_UNCONFIGURED`.
   * Ưu tiên: option này > env `OPENBOT_DAEMON_EGRESS_POLICY` (JSON).
   */
  egressPolicy?: EgressPolicy;
}

/** Số exec song song tối đa mặc định (v0.14; trước đó là 8 + reject).
 *  Định nghĩa ở types.ts; re-export ở đầu file để import từ daemon.js
 *  vẫn hoạt động. */
/** Tổng output tối đa (ký tự) đẩy qua onOutputChunk cho một exec. */
export const MAX_DAEMON_OUTPUT_CALLBACK_CHARS = 1_048_576;

/**
 * Fragment dòng dở (`pendingPartialLine`) tối đa (ký tự) giữ lại cho
 * một session (v0.21, điều phối viên): caller gửi text không newline
 * mãi sẽ làm bộ nhớ daemon phình — vượt ngưỡng này thì fragment được
 * kiểm tra như một dòng và ghi thẳng vào stdin ngay (không `\n` kèm
 * theo nên shell vẫn chờ newline mới thực thi — không đổi ngữ nghĩa),
 * thay vì giữ lại. 64k gấp ~64 lần một dòng shell thông thường.
 * Hằng này sống trong `sessionLine.ts` (v0.74b) và re-export ở đầu
 * file để code ngoài import từ daemon vẫn chạy.
 */

/**
 * Thời gian tối đa chờ shell tự thoát sau khi daemon đóng stdin của nó
 * (EOF) — dùng chung cho `handleSessionClose` (flush dòng dở lúc đóng
 * session) và `shutdownDaemon` (W19d, v0.26 — flush dòng dở lúc tắt
 * daemon): shell thường thoát trong vài ms sau EOF; quá hạn này thì
 * kill để thao tác đóng/tắt không treo (vd chương trình tương tác bỏ
 * qua EOF). 500ms đủ lâu để dòng cuối chạy xong và output kịp chảy qua
 * stdout của daemon về client, đủ ngắn để shutdown không treo.
 */
export const SESSION_CLOSE_KILL_DELAY_MS = 500;

export const DAEMON_OUTPUT_CALLBACK_TRUNCATED_MARKER =
  '\n[... output đã vượt giới hạn 1MB, phần còn lại bị cắt ...]';

/**
 * Tính cap exec song song hiệu lực: option maxExecs > env
 * OPENBOT_DAEMON_MAX_EXECS > mặc định 4. Giá trị không hợp lệ (<= 0,
 * NaN, ...) bị bỏ qua và rơi xuống mức tiếp theo.
 */
export function resolveDaemonMaxExecs(options: DaemonOptions = {}): number {
  if (
    options.maxExecs !== undefined &&
    Number.isFinite(options.maxExecs) &&
    options.maxExecs > 0
  ) {
    return Math.floor(options.maxExecs);
  }
  const envRaw = process.env.OPENBOT_DAEMON_MAX_EXECS;
  if (envRaw !== undefined && envRaw !== '') {
    const parsed = Number.parseInt(envRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    process.stderr.write(
      `[daemon] OPENBOT_DAEMON_MAX_EXECS không hợp lệ ("${envRaw}"), ` +
        `dùng mặc định ${DEFAULT_DAEMON_MAX_EXECS}.\n`,
    );
  }
  return DEFAULT_DAEMON_MAX_EXECS;
}

interface RunningExec {
  execId: string;
  command: string;
  args: string[];
  startedAt: number;
  child: ChildProcess;
  timer: NodeJS.Timeout | undefined;
  timedOut: boolean;
  settled: boolean;
  stdoutChars: number;
  stderrChars: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** Tổng ký tự đã đẩy qua onOutputChunk (cap riêng 1MB / exec). */
  callbackChars: number;
  callbackTruncated: boolean;
}

interface RunningSession {
  sessionId: string;
  command: string;
  args: string[];
  startedAt: number;
  child: ChildProcess;
  exited: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutChars: number;
  stderrChars: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /**
   * WorkspaceDir hiệu lực lúc `session_start` (request > daemon),
   * đóng băng cho cả đời session (v0.20, W13c): `session_write` dùng
   * nó để quyết định có kiểm tra denylist từng dòng stdin không.
   * `undefined` = session không được giam → giữ hành vi cũ (không
   * kiểm tra), giống exec/session_start khi không có workspaceDir.
   */
  workspaceDir: string | undefined;
  /**
   * Egress policy hiệu lực lúc `session_start` (request > daemon,
   * P0-2), đóng băng cho cả đời session: `session_write` dùng nó để
   * kiểm tra từng dòng stdin có đích mạng. `undefined` + session bị
   * giam (có workspaceDir) → dòng có đích mạng bị chặn fail-closed
   * mã `EGRESS_UNCONFIGURED`. Session không giam → không kiểm tra.
   */
  egressPolicy: EgressPolicy | undefined;
  /**
   * Phần dòng dở cuối cùng chưa có `\n` (v0.20, W14c): `session_write`
   * nối fragment này + input mới rồi mới tách dòng để kiểm tra — lệnh
   * cấm tách nhỏ qua nhiều lần ghi (`su` + `do rm -rf /\n`) không lọt
   * nữa. Chỉ giữ đúng fragment cuối, không đệm toàn bộ input: shell
   * chỉ thực thi dòng khi nhận `\n` nên giữ fragment không đổi ngữ
   * nghĩa, chương trình tương tác (vim/less) không bị kẹt. `''` =
   * không có dòng dở. Chỉ dùng khi session được giam (có
   * workspaceDir); session không giam không đệm gì, ghi thẳng như cũ.
   */
  pendingPartialLine: string;
  /**
   * Biến shell đơn giản đã track trong session này (W18b): key là tên
   * biến, value là giá trị literal từ gán `NAME="..."` / `NAME='...'`
   * / `NAME=...` (một biến trên một dòng, giá trị không chứa `$` hay
   * backtick — gán phức tạp hơn không được track). Dùng để mở rộng
   * `$NAME` / `${NAME}` trước khi kiểm tra denylist từng dòng stdin,
   * để `CMD="rm -rf /"` + `$CMD` không lọt. Tối đa
   * `MAX_TRACKED_SHELL_VARS` biến, biến cũ nhất bị đuổi khi đầy;
   * giá trị dài hơn `MAX_TRACKED_SHELL_VAR_VALUE_CHARS` không track.
   * Chỉ dùng khi session được giam (có workspaceDir), như
   * `pendingPartialLine`.
   */
  shellVars: Map<string, string>;
  /**
   * Delimiter heredoc đang mở trong session này (W18b): `null` = không
   * ở trong thân heredoc. Khi một dòng đầy đủ mở heredoc
   * (`<<EOF`, `<<-EOF`, `<<'EOF'`) thì delimiter được ghi lại, các
   * dòng đầy đủ tiếp theo là nội dung heredoc và cũng qua kiểm tra
   * denylist (sau expand) thay vì ghi thẳng; dòng đúng bằng delimiter
   * (sau trim — `<<-` cho phép thụt đầu dòng) thì đóng heredoc và
   * được ghi thẳng. Chỉ delimiter literal đơn giản; không parse shell
   * đầy đủ (vd nhiều heredoc trên một dòng, delimiter từ biến).
   */
  heredocDelimiter: string | null;
}

const running = new Map<string, RunningExec>();
const sessions = new Map<string, RunningSession>();
let shuttingDown = false;
/** `shutdownDaemon` đã bắt đầu (kể cả đang chờ shell thoát sau flush)
 *  — gọi lại (vd SIGTERM tới trong lúc chờ) thì bỏ qua, lần shutdown
 *  đầu tiên đã quyết định mọi thứ (W19d). */
let shutdownStarted = false;

/** Hàng đợi FIFO cho exec vượt cap (v0.14): mỗi entry giữ nguyên request
 *  id + params để chạy lại khi có slot trống, theo đúng thứ tự đến. */
interface QueuedExec {
  requestId: string;
  params: Record<string, unknown>;
  execId: string;
  enqueuedAt: number;
}
const execQueue: QueuedExec[] = [];

/**
 * v0.59 (UI-2): kills that arrived before their exec was registered.
 * `handleExec` is async — it awaits the egress policy check before the
 * exec lands in `running`/`execQueue`. A kill arriving in that window
 * used to be answered `{killed:false}` ("never existed") and then LOST:
 * the exec started afterwards and ran to completion, so Stop did not
 * stop a run blocked in a shell tool (measured: a `sleep 10` ran the
 * full 10s after Stop). Recording the kill here lets handleExec answer
 * the request as killed without ever spawning. Entries are consumed by
 * the matching exec (or dropped when its validation fails); stale
 * entries are pruned by age on every kill, and execIds are UUIDs, so a
 * stale entry can never match a later exec. The kill response itself
 * still reports whether a live process was signalled (false for an
 * exec that was not running yet) — the armed kill is what matters.
 */
const killedBeforeStart = new Map<string, number>();
const PRE_KILL_TTL_MS = 10 * 60_000;

/** True when a kill for this exec arrived before it was registered. */
function takePreKill(execId: string): boolean {
  return killedBeforeStart.delete(execId);
}

function prunePreKills(now: number): void {
  for (const [id, at] of killedBeforeStart) {
    if (now - at > PRE_KILL_TTL_MS) killedBeforeStart.delete(id);
  }
}

/** Option + cap hiệu lực của lần startDaemon() gần nhất. */
let daemonOptions: DaemonOptions = {};
let maxExecs = DEFAULT_DAEMON_MAX_EXECS;

/**
 * Thư mục workspace daemon đang tự giam lệnh vào (v0.15, M1).
 * `undefined` = chưa cấu hình → giữ hành vi cũ (chỉ validate kiểu).
 * Được đặt bởi startDaemon() (option > env OPENBOT_DAEMON_WORKSPACE_DIR)
 * hoặc bởi method `init` của giao thức RPC (chỉ khi chưa cấu hình).
 */
let daemonWorkspaceDir: string | undefined;

/**
 * Tính workspaceDir hiệu lực: option `workspaceDir` > env
 * `OPENBOT_DAEMON_WORKSPACE_DIR` > undefined (giữ hành vi cũ).
 * Trả về đường dẫn tuyệt đối (chưa kiểm tra tồn tại — `resolveWithin`
 * ở mỗi lần spawn sẽ báo lỗi rõ nếu thư mục không tồn tại).
 */
export function resolveDaemonWorkspaceDir(options: DaemonOptions = {}): string | undefined {
  if (typeof options.workspaceDir === 'string' && options.workspaceDir !== '') {
    return path.resolve(options.workspaceDir);
  }
  const envRaw = process.env.OPENBOT_DAEMON_WORKSPACE_DIR;
  if (typeof envRaw === 'string' && envRaw !== '') {
    return path.resolve(envRaw);
  }
  return undefined;
}

/**
 * Tính allowlist thư mục gốc hiệu lực (sau v0.18): option
 * `allowedWorkspaceRoots` > env `OPENBOT_DAEMON_ALLOWED_ROOTS` >
 * undefined (không cấu hình → giữ hành vi cũ, không chặn thêm).
 * Env phân tách bằng `path.delimiter` (`:` trên POSIX, `;` trên
 * Windows). Trả về mảng đường dẫn tuyệt đối đã lọc chuỗi rỗng, hoặc
 * undefined khi không có root nào.
 */
export function resolveDaemonAllowedWorkspaceRoots(
  options: DaemonOptions = {},
): string[] | undefined {
  const fromList = (list: unknown): string[] | undefined => {
    if (!Array.isArray(list)) return undefined;
    const resolved = list
      .filter((entry): entry is string => typeof entry === 'string' && entry !== '')
      .map((entry) => path.resolve(entry));
    return resolved.length > 0 ? resolved : undefined;
  };
  const fromOption = fromList(options.allowedWorkspaceRoots);
  if (fromOption !== undefined) return fromOption;
  const envRaw = process.env.OPENBOT_DAEMON_ALLOWED_ROOTS;
  if (typeof envRaw === 'string' && envRaw !== '') {
    return fromList(envRaw.split(path.delimiter));
  }
  return undefined;
}

/** Thư mục gốc cho phép chứa workspaceDir (allowlist, sau v0.18).
 *  `undefined` = chưa cấu hình → giữ hành vi cũ (không chặn thêm).
 *  Được đặt bởi startDaemon() (option > env
 *  OPENBOT_DAEMON_ALLOWED_ROOTS) hoặc bởi method `init` của giao thức
 *  RPC (chỉ khi chưa cấu hình). */
let daemonAllowedRoots: string[] | undefined;

/**
 * Egress policy chung của daemon (P0-2). `undefined` = chưa cấu hình
 * → exec/session bị giam có đích mạng bị chặn fail-closed mã
 * `EGRESS_UNCONFIGURED`. Được đặt bởi startDaemon() (option > env
 * OPENBOT_DAEMON_EGRESS_POLICY, JSON) hoặc bởi method `init` của giao
 * thức RPC (chỉ khi chưa cấu hình, như `workspaceDir`).
 */
let daemonEgressPolicy: EgressPolicy | undefined;

/**
 * Tính egress policy hiệu lực (P0-2): option `egressPolicy` > env
 * `OPENBOT_DAEMON_EGRESS_POLICY` (chuỗi JSON) > undefined (chưa cấu
 * hình → fail-closed khi bị giam). Env JSON parse lỗi / shape sai thì
 * cảnh báo ra stderr và coi như chưa cấu hình (fail-closed, không
 * đoán policy) — host phải sửa env rồi restart daemon.
 */
export function resolveDaemonEgressPolicy(options: DaemonOptions = {}): EgressPolicy | undefined {
  if (options.egressPolicy !== undefined) {
    try {
      return validateEgressPolicy(options.egressPolicy);
    } catch (err) {
      process.stderr.write(
        `[daemon] egressPolicy trong option không hợp lệ (${err instanceof Error ? err.message : String(err)}), ` +
          `coi như chưa cấu hình (fail-closed).\n`,
      );
      return undefined;
    }
  }
  const envRaw = process.env.OPENBOT_DAEMON_EGRESS_POLICY;
  if (typeof envRaw === 'string' && envRaw !== '') {
    try {
      return validateEgressPolicy(JSON.parse(envRaw) as unknown);
    } catch (err) {
      process.stderr.write(
        `[daemon] OPENBOT_DAEMON_EGRESS_POLICY không hợp lệ (${err instanceof Error ? err.message : String(err)}), ` +
          `coi như chưa cấu hình (fail-closed).\n`,
      );
      return undefined;
    }
  }
  return undefined;
}

/**
 * Chuẩn hoá `egressPolicy` mang theo một request (P0-2): không truyền
 * = không có (undefined — dùng policy chung của daemon); object =
 * validate rồi dùng làm policy riêng của request đó; kiểu khác thì
 * trả về null để handler báo BAD_REQUEST. Policy request không được
 * tin mù: `validateEgressPolicy` ném lỗi khi shape sai, handler trả
 * mã `EGRESS_INVALID_POLICY` thay vì áp policy nửa vời.
 */
function resolveRequestEgressPolicy(
  params: Record<string, unknown>,
): EgressPolicy | undefined | null {
  const raw = params.egressPolicy;
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  try {
    return validateEgressPolicy(raw);
  } catch {
    return null;
  }
}

/* (v0.74b: `egressErrorCode` đã chuyển sang `sessionLine.ts` — dùng chung cho daemon + session local.) */

/**
 * `dir` có nằm trong (hoặc bằng) một root trong allowlist không.
 * Dùng `resolveWithin` nên symlink trỏ ra ngoài root bị chặn qua
 * realpath (kể cả khi `dir` chưa tồn tại — resolveWithin xử lý phần
 * đuôi chưa tồn tại bằng realpath của ancestor dài nhất còn tồn tại).
 * Root không tồn tại thì không chứa gì (fail-closed).
 */
function isWithinAllowedRoots(dir: string, roots: string[]): boolean {
  return roots.some((root) => {
    try {
      resolveWithin(root, dir);
      return true;
    } catch {
      return false;
    }
  });
}

/* (v0.74b: kiểm tra dòng stdin — `checkCommandBlocked`,
 * `MAX_TRACKED_SHELL_VARS`, `MAX_TRACKED_SHELL_VAR_VALUE_CHARS`,
 * parse/expand/heredoc, `decideSessionLine` — đã chuyển sang
 * `sessionLine.ts`, dùng chung cho daemon + session local.) */

/* (v0.74b: `SessionLineDecision`, `sessionBlockedMessage`,
 * `decideSessionLine` — xem `sessionLine.ts`; `RunningSession` thỏa
 * `SessionLineState` nên gọi thẳng `decideSessionLine(entry, line)`.) */

/**
 * Kiểm tra policy của daemon trước khi spawn (v0.15, M1; v0.16 mở rộng
 * theo từng request; P0-2 thêm egress): denylist lệnh + cwd
 * confinement + egress. Chỉ chạy khi có workspaceDir hiệu lực; khi
 * không có thì trả về null (cho qua, giữ hành vi cũ).
 *
 * Thứ tự ưu tiên workspaceDir hiệu lực: `requestWorkspaceDir` (mang
 * theo từng request exec/session_start, v0.16) > `daemonWorkspaceDir`
 * (cấu hình chung của daemon) > không giam.
 *
 * `command` ở daemon là tên chương trình (vd `/bin/sh`), còn lệnh thật
 * nằm trong `args` (vd `['-c', 'rm -rf /']`) — nên phải kiểm tra chuỗi
 * đã nối `[command, ...args].join(' ')`, chỉ kiểm tra tên chương trình
 * thì denylist không bao giờ khớp.
 *
 * P0-2 (egress): khi đã giam (có workspaceDir hiệu lực) và chuỗi lệnh
 * chứa đích mạng (curl/wget/git clone/ssh/URL) thì mỗi đích phải qua
 * `checkEgress` với policy hiệu lực (request > daemon). Không có
 * policy nào → chặn fail-closed mã `EGRESS_UNCONFIGURED` với lỗi rõ
 * ràng thay vì để lệnh chạy rồi treo/timeout khó hiểu. Lệnh không có
 * đích mạng không tốn DNS, không bị ảnh hưởng. Lỗi egress trả về mã
 * `EGRESS_*` theo kind (unconfigured/unreachable/invalid_response/
 * blocked) để caller phân loại.
 *
 * Trả về null khi qua, hoặc `{ message, code }` để handler trả về qua
 * respondError — KHÔNG throw, daemon không được chết vì một request xấu.
 */
async function checkDaemonPolicy(
  command: string,
  args: string[],
  resolvedCwd: string,
  requestWorkspaceDir?: string,
  requestEgressPolicy?: EgressPolicy,
): Promise<{ message: string; code: string } | null> {
  const effectiveWorkspaceDir = requestWorkspaceDir ?? daemonWorkspaceDir;
  // Allowlist thư mục gốc (sau v0.18): khi đã cấu hình, workspaceDir
  // hiệu lực (request > daemon) phải nằm trong một root — chặn cả
  // caller độc hại tự khai workspaceDir rộng (`/`) lẫn daemon
  // workspaceDir cấu hình sai. Kiểm tra TRƯỚC denylist/cwd để mã lỗi
  // nói đúng nguyên nhân. Không có workspaceDir hiệu lực thì không có
  // gì để kiểm tra (giữ hành vi cũ).
  if (effectiveWorkspaceDir !== undefined && daemonAllowedRoots !== undefined) {
    if (!isWithinAllowedRoots(effectiveWorkspaceDir, daemonAllowedRoots)) {
      return {
        message:
          `daemon: workspace "${effectiveWorkspaceDir}" nằm ngoài các thư mục gốc cho phép ` +
          `(${daemonAllowedRoots.join(', ')})`,
        code: 'WORKSPACE_NOT_ALLOWED',
      };
    }
  }
  if (effectiveWorkspaceDir === undefined) return null;
  const denied = checkCommandBlocked([command, ...args].join(' '));
  if (denied !== null) {
    return {
      message:
        `daemon: lệnh bị chặn bởi denylist của daemon ` +
        `(workspace "${effectiveWorkspaceDir}"): ${denied.message}`,
      code: denied.code,
    };
  }
  try {
    resolveWithin(effectiveWorkspaceDir, resolvedCwd);
  } catch (err) {
    return {
      message:
        `daemon: cwd "${resolvedCwd}" nằm ngoài workspace ` +
        `"${effectiveWorkspaceDir}": ${err instanceof Error ? err.message : String(err)}`,
      code: 'CWD_OUTSIDE_WORKSPACE',
    };
  }
  // P0-2: egress — chỉ khi lệnh chứa đích mạng.
  const joined = [command, ...args].join(' ');
  const targets = extractNetworkTargets(joined);
  if (targets.length === 0) return null;
  const policy = requestEgressPolicy ?? daemonEgressPolicy;
  if (policy === undefined) {
    return {
      message:
        'daemon: egress chưa cấu hình (egress_unconfigured): lệnh chứa đích mạng nhưng daemon chưa có policy egress rõ ràng ' +
        `nên chặn, không chạy lệnh. Cấu hình egressPolicy cho daemon (option/env/init) hoặc gửi kèm request rồi thử lại.`,
      code: 'EGRESS_UNCONFIGURED',
    };
  }
  for (const target of targets) {
    try {
      await checkEgress(target, policy, { context: 'agent' });
    } catch (err) {
      if (err instanceof EgressError) {
        return { message: `daemon: ${err.message}`, code: egressErrorCode(err) };
      }
      throw err;
    }
  }
  return null;
}

/**
 * Chuẩn hoá `workspaceDir` mang theo một request (v0.16): chuỗi rỗng /
 * không truyền = không có (undefined); chuỗi khác rỗng = đường dẫn
 * tuyệt đối (path.resolve — KHÔNG tin mù giá trị caller gửi, và
 * resolveWithin ở checkDaemonPolicy vẫn giam cwd vào đúng thư mục này).
 * Giá trị không phải chuỗi thì trả về null để handler báo BAD_REQUEST.
 */
function resolveRequestWorkspaceDir(
  params: Record<string, unknown>,
): string | undefined | null {
  const raw = params.workspaceDir;
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return null;
  if (raw === '') return undefined;
  return path.resolve(raw);
}

/**
 * cwd mặc định của một request: cwd request truyền vào, nếu không thì
 * workspaceDir của request đó (v0.16), nếu không thì workspaceDir cấu
 * hình chung của daemon (v0.15), nếu không thì cwd của tiến trình daemon.
 */
function resolveRequestCwd(params: Record<string, unknown>): string {
  const cwd = params.cwd;
  if (typeof cwd === 'string') return path.resolve(cwd);
  const requestWs = resolveRequestWorkspaceDir(params);
  if (typeof requestWs === 'string') return requestWs;
  return daemonWorkspaceDir ?? process.cwd();
}

/** Env mặc định cho tiến trình con (v0.15, M2): caller truyền `env` thì
 *  dùng đúng env đó; caller không truyền thì dùng `safeEnv()` (allowlist,
 *  không secret) thay vì kế thừa toàn bộ `process.env` của daemon. */
function childEnv(env: Record<string, string> | undefined): NodeJS.ProcessEnv {
  return env !== undefined ? { ...env } : safeEnv();
}

function send(msg: DaemonResponse | { event: string; data: unknown }): void {
  try {
    process.stdout.write(JSON.stringify(msg) + '\n');
  } catch (err) {
    // stdout closed (parent gone) — nothing left to do.
    process.stderr.write(`[daemon] failed to write response: ${String(err)}\n`);
  }
}

function respond(id: string, result: unknown): void {
  send({ id, result });
}

function respondError(id: string, message: string, code?: string): void {
  send({ id, error: code ? { message, code } : { message } });
}

function notify(event: string, data: unknown): void {
  send({ event, data });
}

function killChild(child: ChildProcess): void {
  // v0.15: kill cả process group (đa nền tảng) qua helper dùng chung —
  // shell's grandchildren (e.g. `sh -c 'sleep 30'` -> sleep) inherit the
  // shell's stdio pipes, and Node's 'close' only fires once those pipes
  // are closed. Trên Windows helper dùng taskkill /T; trên POSIX dùng
  // kill(-pid). Trả false (đã chết từ trước / không phải group leader)
  // thì fallback kill trực tiếp.
  if (!killProcessGroupOfChild(child)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already dead — the 'close' handler settles the exec.
    }
  }
}

function finishExec(entry: RunningExec): void {
  if (entry.settled) return;
  entry.settled = true;
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  running.delete(entry.execId);
  // Một slot vừa trống: chạy exec tiếp theo trong hàng đợi (FIFO).
  drainQueue();
}

/**
 * Stream one output chunk with the per-stream cap (v0.6). Sends at most
 * MAX_EXEC_OUTPUT_CHARS chars per stream; the first chunk that would
 * overflow is cut at the cap, followed by exactly one truncation marker,
 * and every later chunk on that stream is dropped.
 *
 * v0.14: chunk đã gửi (sau cap 200k) còn được đẩy qua
 * `daemonOptions.onOutputChunk(execId, chunk)` cho exec (không áp cho
 * session). Callback có buffer riêng tối đa 1MB / exec; chunk vượt thì
 * truncate + ghi chú, rồi dừng gọi callback cho exec đó.
 */
function streamCapped(
  entry: {
    stdoutChars: number;
    stderrChars: number;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    callbackChars?: number;
    callbackTruncated?: boolean;
  },
  which: 'stdout' | 'stderr',
  event: string,
  idKey: string,
  idValue: string,
  chunk: string,
): void {
  const charsKey = which === 'stdout' ? 'stdoutChars' : 'stderrChars';
  const flagKey = which === 'stdout' ? 'stdoutTruncated' : 'stderrTruncated';
  if (entry[flagKey]) return; // already truncated: drop silently
  const used = entry[charsKey];
  let sentChunk: string;
  if (used >= MAX_EXEC_OUTPUT_CHARS) {
    entry[flagKey] = true;
    sentChunk = EXEC_OUTPUT_TRUNCATED_MARKER;
  } else {
    const remaining = MAX_EXEC_OUTPUT_CHARS - used;
    if (chunk.length <= remaining) {
      entry[charsKey] = used + chunk.length;
      sentChunk = chunk;
    } else {
      entry[charsKey] = MAX_EXEC_OUTPUT_CHARS;
      entry[flagKey] = true;
      sentChunk = chunk.slice(0, remaining) + EXEC_OUTPUT_TRUNCATED_MARKER;
    }
  }
  notify(event, { [idKey]: idValue, chunk: sentChunk });
  deliverOutputChunk(entry, event, idValue, sentChunk);
}

/** Đẩy một chunk đã stream qua onOutputChunk (chỉ exec, cap 1MB / exec). */
function deliverOutputChunk(
  entry: { callbackChars?: number; callbackTruncated?: boolean },
  event: string,
  execId: string,
  sentChunk: string,
): void {
  const cb = daemonOptions.onOutputChunk;
  if (cb === undefined) return;
  if (!event.startsWith('exec.')) return; // session.* không qua callback này
  if (entry.callbackChars === undefined) return;
  if (entry.callbackTruncated === true) return;
  const used = entry.callbackChars;
  const remaining = MAX_DAEMON_OUTPUT_CALLBACK_CHARS - used;
  try {
    if (remaining <= 0) {
      entry.callbackTruncated = true;
      cb(execId, DAEMON_OUTPUT_CALLBACK_TRUNCATED_MARKER);
    } else if (sentChunk.length <= remaining) {
      entry.callbackChars = used + sentChunk.length;
      cb(execId, sentChunk);
    } else {
      entry.callbackChars = MAX_DAEMON_OUTPUT_CALLBACK_CHARS;
      entry.callbackTruncated = true;
      cb(execId, sentChunk.slice(0, remaining) + DAEMON_OUTPUT_CALLBACK_TRUNCATED_MARKER);
    }
  } catch {
    // Callback của host lỗi thì không được làm hỏng stream của daemon.
  }
}

async function handleExec(id: string, params: Record<string, unknown>): Promise<void> {
  const command = params.command;
  const args = params.args;
  const cwd = params.cwd;
  const env = params.env;
  const timeoutMs = params.timeoutMs;
  const requestedId = params.execId;

  if (typeof command !== 'string' || command.trim() === '') {
    respondError(id, 'exec: "command" must be a non-empty string', 'BAD_REQUEST');
    return;
  }
  if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))) {
    respondError(id, 'exec: "args" must be an array of strings', 'BAD_REQUEST');
    return;
  }
  if (cwd !== undefined && typeof cwd !== 'string') {
    respondError(id, 'exec: "cwd" must be a string', 'BAD_REQUEST');
    return;
  }
  if (
    env !== undefined &&
    (typeof env !== 'object' || env === null || Array.isArray(env) ||
      Object.values(env).some((v) => typeof v !== 'string'))
  ) {
    respondError(id, 'exec: "env" must be an object of string values', 'BAD_REQUEST');
    return;
  }
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
  ) {
    respondError(id, 'exec: "timeoutMs" must be a positive number', 'BAD_REQUEST');
    return;
  }
  // v0.16 (M1 đa bot): workspaceDir mang theo request — chuẩn hoá thành
  // tuyệt đối, không tin mù; sai kiểu thì BAD_REQUEST.
  const requestWorkspaceDir = resolveRequestWorkspaceDir(params);
  if (requestWorkspaceDir === null) {
    respondError(id, 'exec: "workspaceDir" must be a string', 'BAD_REQUEST');
    return;
  }
  // P0-2: egressPolicy mang theo request (request > daemon) — sai
  // shape thì EGRESS_INVALID_POLICY, không áp nửa vời.
  const requestEgressPolicy = resolveRequestEgressPolicy(params);
  if (requestEgressPolicy === null) {
    respondError(id, 'exec: "egressPolicy" must be a valid egress policy object', 'EGRESS_INVALID_POLICY');
    return;
  }

  const execId =
    typeof requestedId === 'string' && requestedId !== '' ? requestedId : randomUUID();
  if (running.has(execId) || execQueue.some((q) => q.execId === execId)) {
    respondError(id, `exec: execId "${execId}" is already running or queued`, 'BAD_REQUEST');
    return;
  }

  // v0.15 (M1) + v0.16 (M1 đa bot): cwd mặc định là workspaceDir của
  // request (nếu có), nếu không thì workspaceDir cấu hình chung của
  // daemon, nếu không thì cwd của tiến trình daemon; lệnh + cwd phải
  // qua denylist + confinement theo workspaceDir hiệu lực (request >
  // daemon > không giam) TRƯỚC khi xếp hàng/spawn — kể cả khi caller
  // gọi thẳng daemon.exec mà bỏ qua tool shell_exec.
  const resolvedCwd = resolveRequestCwd(params);
  const policyError = await checkDaemonPolicy(
    command,
    (args as string[] | undefined) ?? [],
    resolvedCwd,
    requestWorkspaceDir,
    requestEgressPolicy,
  );
  if (policyError !== null) {
    // The exec is rejected, so an armed pre-kill for it must not linger.
    killedBeforeStart.delete(execId);
    respondError(id, policyError.message, policyError.code);
    return;
  }
  try {
    const stat = fs.statSync(resolvedCwd);
    if (!stat.isDirectory()) {
      killedBeforeStart.delete(execId);
      respondError(id, `exec: cwd is not a directory: "${resolvedCwd}"`, 'BAD_CWD');
      return;
    }
  } catch {
    killedBeforeStart.delete(execId);
    respondError(id, `exec: cwd does not exist: "${resolvedCwd}"`, 'BAD_CWD');
    return;
  }

  // v0.59 (UI-2): a kill that arrived while this exec was still being
  // validated (see killedBeforeStart) — answer as killed, never spawn.
  if (takePreKill(execId)) {
    respond(id, { execId, exitCode: null, signal: 'SIGKILL', timedOut: false });
    return;
  }

  // v0.14: vượt cap thì XẾP HÀNG FIFO (không reject). Exec đang chờ được
  // báo rõ trong output (chunk exec.stdout + event exec.queued) và tự
  // chạy khi có slot trống; request chỉ được trả lời khi exec thực sự
  // kết thúc (hoặc bị kill khi đang chờ).
  if (running.size >= maxExecs) {
    execQueue.push({ requestId: id, params, execId, enqueuedAt: Date.now() });
    const position = execQueue.length;
    notify('exec.queued', { execId, position, maxExecs, command });
    notify('exec.stdout', {
      execId,
      chunk:
        `[daemon] exec "${command}" đang chờ: đã có ${running.size}/${maxExecs} exec đang chạy, ` +
        `vị trí trong hàng đợi: ${position}. Sẽ tự chạy khi có chỗ trống.\n`,
    });
    return;
  }
  startExec(id, params, execId, Date.now());
}

/**
 * Spawn một exec đã validate xong (gọi trực tiếp từ handleExec hoặc từ
 * hàng đợi qua drainQueue). Trả lời request khi exec kết thúc.
 */
function startExec(
  requestId: string,
  params: Record<string, unknown>,
  execId: string,
  enqueuedAt: number,
): void {
  const command = params.command as string;
  const args = params.args as string[] | undefined;
  const env = params.env as Record<string, string> | undefined;
  const timeoutMs = params.timeoutMs as number | undefined;
  // Cùng mặc định cwd như handleExec (workspaceDir của request >
  // workspaceDir cấu hình chung của daemon > cwd daemon). Policy đã
  // kiểm tra ở handleExec trước khi xếp hàng nên không cần kiểm tra
  // lại ở đây — startExec chỉ spawn.
  const resolvedCwd = resolveRequestCwd(params);

  const entry: RunningExec = {
    execId,
    command,
    args: (args ?? []) as string[],
    startedAt: Date.now(),
    child: undefined as unknown as ChildProcess,
    timer: undefined,
    timedOut: false,
    settled: false,
    stdoutChars: 0,
    stderrChars: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    callbackChars: 0,
    callbackTruncated: false,
  };

  let child: ChildProcess;
  try {
    child = spawn(command, entry.args, {
      cwd: resolvedCwd,
      // v0.15 (M2): env caller truyền vào thì dùng đúng env đó (thay
      // thế hoàn toàn, không merge); env bị bỏ qua thì dùng safeEnv()
      // (allowlist, không secret) thay vì kế thừa toàn bộ process.env
      // của daemon — mặc định fail-closed, caller quên truyền env cũng
      // không làm rò secret của daemon ra tiến trình con.
      env: childEnv(env),
      windowsHide: true,
      // Own process group (non-Windows) so killChild can SIGKILL the
      // whole group incl. grandchildren that inherited stdio pipes.
      detached: process.platform !== 'win32',
    });
  } catch (err) {
    respondError(
      requestId,
      `exec: failed to spawn "${command}": ${err instanceof Error ? err.message : String(err)}`,
      'SPAWN_FAILED',
    );
    drainQueue();
    return;
  }
  entry.child = child;
  running.set(execId, entry);
  notify('exec.started', { execId, waitedMs: Date.now() - enqueuedAt });

  if (timeoutMs !== undefined) {
    entry.timer = setTimeout(() => {
      entry.timedOut = true;
      killChild(child);
    }, timeoutMs);
    entry.timer.unref?.();
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    streamCapped(entry, 'stdout', 'exec.stdout', 'execId', execId, chunk.toString('utf8'));
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    streamCapped(entry, 'stderr', 'exec.stderr', 'execId', execId, chunk.toString('utf8'));
  });
  child.on('error', (err: Error) => {
    // e.g. ENOENT: command not found. Answer the request; the 'close'
    // event may still follow, but finishExec() guards double-settling.
    if (entry.settled) return;
    finishExec(entry);
    const code = (err as NodeJS.ErrnoException).code;
    respondError(
      requestId,
      `exec: cannot run "${command}": ${err.message}`,
      code === 'ENOENT' ? 'COMMAND_NOT_FOUND' : 'SPAWN_FAILED',
    );
  });
  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    if (entry.settled) return;
    finishExec(entry);
    respond(requestId, {
      execId,
      exitCode: code,
      signal: signal ?? null,
      timedOut: entry.timedOut,
    });
  });
}

/** Chạy các exec đang xếp hàng (FIFO) khi còn slot trống. */
function drainQueue(): void {
  while (running.size < maxExecs && execQueue.length > 0) {
    const next = execQueue.shift()!;
    startExec(next.requestId, next.params, next.execId, next.enqueuedAt);
  }
}

function handleKill(id: string, params: Record<string, unknown>): void {
  const execId = params.execId;
  if (typeof execId !== 'string' || execId === '') {
    respondError(id, 'kill: "execId" must be a non-empty string', 'BAD_REQUEST');
    return;
  }
  const entry = running.get(execId);
  if (entry === undefined) {
    // Đang xếp hàng? Kill = hủy khỏi hàng đợi, request gốc được trả lời
    // như một exec bị SIGKILL trước khi chạy.
    const queuedIndex = execQueue.findIndex((q) => q.execId === execId);
    if (queuedIndex !== -1) {
      const [queued] = execQueue.splice(queuedIndex, 1);
      notify('exec.stdout', {
        execId,
        chunk: `[daemon] exec "${(queued!.params.command as string) ?? execId}" đã bị hủy khi đang chờ trong hàng đợi.\n`,
      });
      respond(queued!.requestId, {
        execId,
        exitCode: null,
        signal: 'SIGKILL',
        timedOut: false,
      });
      respond(id, { killed: true });
      return;
    }
    // Not running or queued (yet): it may still be inside handleExec's
    // async validation (egress check). Arm the kill so the exec is
    // answered as killed instead of starting (see killedBeforeStart).
    // Already finished / never existed also lands here and answers
    // killed:false as before — the armed entry is harmless (UUID ids
    // never repeat) and pruned by age.
    prunePreKills(Date.now());
    killedBeforeStart.set(execId, Date.now());
    respond(id, { killed: false });
    return;
  }
  killChild(entry.child);
  respond(id, { killed: true });
}

function handleList(id: string): void {
  const list: ExecInfo[] = [...running.values()].map((e) => ({
    execId: e.execId,
    command: e.command,
    args: [...e.args],
    startedAt: e.startedAt,
    pid: e.child.pid,
  }));
  respond(id, list);
}

// --- Interactive shell sessions (v0.6) -------------------------------------

async function handleSessionStart(id: string, params: Record<string, unknown>): Promise<void> {
  const isWindows = process.platform === 'win32';
  const command =
    typeof params.command === 'string' && params.command !== ''
      ? params.command
      : isWindows
        ? 'powershell'
        : '/bin/sh';
  const args = params.args;
  const cwd = params.cwd;
  const env = params.env;
  if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))) {
    respondError(id, 'session_start: "args" must be an array of strings', 'BAD_REQUEST');
    return;
  }
  if (cwd !== undefined && typeof cwd !== 'string') {
    respondError(id, 'session_start: "cwd" must be a string', 'BAD_REQUEST');
    return;
  }
  if (
    env !== undefined &&
    (typeof env !== 'object' || env === null || Array.isArray(env) ||
      Object.values(env).some((v) => typeof v !== 'string'))
  ) {
    respondError(id, 'session_start: "env" must be an object of string values', 'BAD_REQUEST');
    return;
  }
  // v0.16 (M1 đa bot): workspaceDir mang theo request — chuẩn hoá thành
  // tuyệt đối, không tin mù; sai kiểu thì BAD_REQUEST.
  const requestWorkspaceDir = resolveRequestWorkspaceDir(params);
  if (requestWorkspaceDir === null) {
    respondError(id, 'session_start: "workspaceDir" must be a string', 'BAD_REQUEST');
    return;
  }
  // P0-2: egressPolicy mang theo request (request > daemon) — sai
  // shape thì EGRESS_INVALID_POLICY, không áp nửa vời.
  const requestEgressPolicy = resolveRequestEgressPolicy(params);
  if (requestEgressPolicy === null) {
    respondError(id, 'session_start: "egressPolicy" must be a valid egress policy object', 'EGRESS_INVALID_POLICY');
    return;
  }
  // v0.15 (M1) + v0.16 (M1 đa bot): giống handleExec — cwd mặc định là
  // workspaceDir của request (nếu có), nếu không thì workspaceDir cấu
  // hình chung của daemon; kiểm tra denylist + confinement theo
  // workspaceDir hiệu lực (request > daemon > không giam) TRƯỚC khi spawn.
  const resolvedCwd = resolveRequestCwd(params);
  const policyError = await checkDaemonPolicy(
    command,
    (args as string[] | undefined) ?? [],
    resolvedCwd,
    requestWorkspaceDir,
    requestEgressPolicy,
  );
  if (policyError !== null) {
    respondError(id, policyError.message, policyError.code);
    return;
  }
  try {
    const stat = fs.statSync(resolvedCwd);
    if (!stat.isDirectory()) {
      respondError(id, `session_start: cwd is not a directory: "${resolvedCwd}"`, 'BAD_CWD');
      return;
    }
  } catch {
    respondError(id, `session_start: cwd does not exist: "${resolvedCwd}"`, 'BAD_CWD');
    return;
  }

  const sessionId = randomUUID();
  const entry: RunningSession = {
    sessionId,
    command,
    args: (args ?? []) as string[],
    startedAt: Date.now(),
    child: undefined as unknown as ChildProcess,
    exited: false,
    exitCode: null,
    signal: null,
    stdoutChars: 0,
    stderrChars: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    // v0.20 (W13c): đóng băng workspaceDir hiệu lực lúc start
    // (request > daemon) để `session_write` biết session này có được
    // giam denylist không — không đọc lại daemonWorkspaceDir lúc ghi
    // (daemon có thể được `init` sau khi session đã mở).
    workspaceDir: requestWorkspaceDir ?? daemonWorkspaceDir,
    // P0-2: đóng băng egress policy hiệu lực lúc start (request >
    // daemon) cho cả đời session, cùng lý do như workspaceDir.
    egressPolicy: requestEgressPolicy ?? daemonEgressPolicy,
    // v0.20 (W14c): ban đầu chưa có dòng dở nào (xem field
    // `pendingPartialLine` trên `RunningSession`).
    pendingPartialLine: '',
    // (W18b): chưa track biến nào, chưa ở trong heredoc nào.
    shellVars: new Map<string, string>(),
    heredocDelimiter: null,
  };
  let child: ChildProcess;
  try {
    child = spawn(command, entry.args, {
      cwd: resolvedCwd,
      // v0.15 (M2): giống exec — không truyền env thì dùng safeEnv(),
      // không kế thừa toàn bộ process.env của daemon.
      env: childEnv(env as Record<string, string> | undefined),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: !isWindows,
    });
  } catch (err) {
    respondError(
      id,
      `session_start: failed to spawn "${command}": ${err instanceof Error ? err.message : String(err)}`,
      'SPAWN_FAILED',
    );
    return;
  }
  entry.child = child;
  sessions.set(sessionId, entry);
  // The start response is sent below; the error handler must not send a
  // second response for the same request id once it has gone out.
  let startResponded = false;

  child.stdout?.on('data', (chunk: Buffer) => {
    streamCapped(entry, 'stdout', 'session.stdout', 'sessionId', sessionId, chunk.toString('utf8'));
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    streamCapped(entry, 'stderr', 'session.stderr', 'sessionId', sessionId, chunk.toString('utf8'));
  });
  child.on('error', (err: Error) => {
    // e.g. ENOENT: shell not found. Answer the start request with an
    // error and drop the session; the 'close' event may still follow.
    if (!entry.exited && !startResponded) {
      entry.exited = true;
      sessions.delete(sessionId);
      respondError(
        id,
        `session_start: cannot run "${command}": ${err.message}`,
        (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'COMMAND_NOT_FOUND' : 'SPAWN_FAILED',
      );
    }
  });
  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    if (entry.exited) return;
    entry.exited = true;
    entry.exitCode = code;
    entry.signal = signal;
    // Shell đã thoát thì stdin cũng đã đóng cùng tiến trình — fragment
    // dòng dở (nếu còn) không flush được nữa, bỏ (xem
    // `flushPendingPartialLine`: chỉ `session_close` chủ động mới
    // flush được, vì lúc đó stdin vẫn mở).
    entry.pendingPartialLine = '';
    // Keep the entry until session_close so listSessions() can report
    // the exit; the parent (tools layer) closes it explicitly.
    notify('session.exit', { sessionId, exitCode: code, signal: signal ?? null });
  });
  // Respond immediately: the session lives on; output arrives as events.
  startResponded = true;
  respond(id, { sessionId, pid: child.pid ?? undefined });
}

/* (v0.74b: `checkSessionLineEgress` / `checkSessionLineEgressSync` —
 * xem `sessionLine.ts`. Lưu ý: đường flush gọi bản sync với
 * `{ fragment: true }` để message nói "dòng dở cuối" như trước.) */

async function handleSessionWrite(id: string, params: Record<string, unknown>): Promise<void> {
  const sessionId = params.sessionId;
  const input = params.input;
  if (typeof sessionId !== 'string' || sessionId === '') {
    respondError(id, 'session_write: "sessionId" must be a non-empty string', 'BAD_REQUEST');
    return;
  }
  if (typeof input !== 'string') {
    respondError(id, 'session_write: "input" must be a string', 'BAD_REQUEST');
    return;
  }
  const entry = sessions.get(sessionId);
  if (entry === undefined) {
    respondError(id, `session_write: unknown session "${sessionId}"`, 'SESSION_NOT_FOUND');
    return;
  }
  if (entry.exited || entry.child.stdin === null) {
    respondError(id, `session_write: session "${sessionId}" has exited`, 'SESSION_CLOSED');
    return;
  }
  // v0.20 (W13c + W14c): kiểm tra denylist từng dòng stdin — session
  // đã mở là đường chui qua denylist của exec/session_start. Chỉ áp
  // dụng khi session được giam (có workspaceDir hiệu lực lúc start);
  // không có thì giữ hành vi cũ (không kiểm tra), giống
  // exec/session_start.
  //
  // W14c — đệm dòng dở qua các lần ghi: mỗi lần ghi chỉ kiểm tra các
  // dòng ĐẦY ĐỦ (đã có `\n`). Phần cuối chưa có `\n` (fragment) được
  // giữ lại trong `entry.pendingPartialLine` và nối vào đầu lần ghi
  // sau rồi mới tách dòng — nên `su` (lần 1) + `do rm -rf /\n`
  // (lần 2) gộp thành `sudo rm -rf /` và bị chặn, thay vì lọt như
  // trước (mỗi lần ghi chỉ kiểm tra các dòng của lần ghi đó). Giữ
  // fragment không đổi ngữ nghĩa: shell chỉ thực thi dòng khi nhận
  // `\n`; chương trình tương tác (vim/less) không chờ newline để vẽ,
  // fragment bị giữ chỉ là text đang gõ, không phải output của chúng.
  // Dòng vi phạm → trả lỗi COMMAND_BLOCKED, KHÔNG ghi dòng đó vào
  // stdin; các dòng lành trong cùng lần ghi vẫn được ghi, session vẫn
  // sống để các lần ghi sau chạy tiếp.
  //
  // (W18b) — ghép lệnh cấm bằng biến shell / heredoc: mỗi dòng đầy đủ
  // đi qua `decideSessionLine` (một nơi duy nhất): gán biến đơn giản
  // được track vào `entry.shellVars`, dòng thường được expand
  // `$NAME`/`${NAME}` trước khi kiểm tra denylist, nội dung heredoc
  // cũng qua kiểm tra (sau expand) thay vì ghi thẳng. Dòng bị chặn
  // vẫn chỉ bị bỏ (không ghi), session sống tiếp; dòng gán lành chứa
  // từ cấm (vd `MSG="hello sudo world"`) được ghi vì giá trị còn trơ.
  if (entry.workspaceDir !== undefined) {
    const combined = entry.pendingPartialLine + input;
    const parts = combined.split('\n');
    // Phần tử cuối là fragment chưa hoàn chỉnh ('' khi input kết thúc
    // bằng `\n`); mọi phần tử trước nó là dòng đầy đủ, đã có `\n`.
    const fragment = parts.pop() ?? '';
    const safeLines: string[] = [];
    let blockedMessage: string | undefined;
    let blockedCode = 'COMMAND_BLOCKED';
    for (const line of parts) {
      if (line.trim() === '') {
        safeLines.push(line);
        continue;
      }
      const decision = decideSessionLine(entry, line);
      if (!decision.write) {
        // Chỉ ghi nhận dòng vi phạm đầu tiên vào lỗi; các dòng vi
        // phạm sau (nếu có) cũng bị bỏ, không ghi vào stdin.
        if (blockedMessage === undefined) {
          blockedMessage = decision.blockedMessage;
          blockedCode = 'COMMAND_BLOCKED';
        }
        continue;
      }
      // P0-2: dòng qua denylist rồi mới kiểm tra egress — dòng chứa
      // đích mạng mà policy chặn (hoặc chưa có policy) thì bị bỏ,
      // session vẫn sống để các lần ghi sau chạy tiếp.
      const egressError = await checkSessionLineEgress(entry, line);
      if (egressError !== null) {
        if (blockedMessage === undefined) {
          blockedMessage = egressError.message;
          blockedCode = egressError.code;
        }
        continue;
      }
      safeLines.push(line);
    }
    // Fragment chưa hoàn chỉnh được giữ lại cho lần ghi sau — kể cả
    // khi lần ghi này có dòng bị chặn (fragment chưa phải là dòng
    // hoàn chỉnh nên chưa thể kết luận vi phạm hay không). Ngoại lệ:
    // fragment vượt `MAX_PENDING_PARTIAL_LINE_CHARS` thì không giữ nữa
    // (chống caller giữ bộ nhớ daemon bằng text không newline mãi) —
    // kiểm tra như một dòng (qua `decideSessionLine`: expand + gán +
    // heredoc như dòng đầy đủ) rồi ghi thẳng vào stdin ngay (không kèm
    // `\n` nên shell vẫn chờ newline mới thực thi, không đổi ngữ nghĩa).
    let flushFragmentNow = '';
    if (fragment.length > MAX_PENDING_PARTIAL_LINE_CHARS) {
      const decision = decideSessionLine(entry, fragment);
      if (!decision.write) {
        if (blockedMessage === undefined) {
          blockedMessage = decision.blockedMessage;
          blockedCode = 'COMMAND_BLOCKED';
        }
      } else {
        // P0-2: fragment vượt cap cũng qua egress như dòng đầy đủ.
        const egressError = await checkSessionLineEgress(entry, fragment);
        if (egressError !== null) {
          if (blockedMessage === undefined) {
            blockedMessage = egressError.message;
            blockedCode = egressError.code;
          }
        } else {
          flushFragmentNow = fragment;
        }
      }
      entry.pendingPartialLine = '';
    } else {
      entry.pendingPartialLine = fragment;
    }
    // Ghi các dòng lành đầy đủ (mỗi dòng kèm `\n` của nó); fragment
    // không được ghi — shell chưa nhận `\n` thì chưa chạy dòng đó.
    const safeInput = safeLines.length > 0 ? safeLines.join('\n') + '\n' : '';
    if (safeInput !== '' || flushFragmentNow !== '') {
      try {
        if (safeInput !== '') entry.child.stdin.write(safeInput, 'utf8');
        if (flushFragmentNow !== '') entry.child.stdin.write(flushFragmentNow, 'utf8');
      } catch (err) {
        respondError(
          id,
          `session_write: failed to write to session "${sessionId}": ${err instanceof Error ? err.message : String(err)}`,
          'WRITE_FAILED',
        );
        return;
      }
    }
    if (blockedMessage !== undefined) {
      respondError(id, blockedMessage, blockedCode);
      return;
    }
    respond(id, { ok: true });
    return;
  }
  try {
    const ok = entry.child.stdin.write(input, 'utf8');
    void ok; // backpressure is not surfaced; small writes are the norm
    respond(id, { ok: true });
  } catch (err) {
    respondError(
      id,
      `session_write: failed to write to session "${sessionId}": ${err instanceof Error ? err.message : String(err)}`,
      'WRITE_FAILED',
    );
  }
}

/**
 * Flush phần dòng dở (`pendingPartialLine`) còn lại của một session
 * khi đóng (v0.20, W14c). Fragment được kiểm tra bằng cùng
 * `checkCommandBlocked` như `session_write`: vi phạm thì bỏ và ghi log
 * ra stderr của daemon (không ghi vào stdin); lành thì ghi nốt kèm
 * `\n` để shell chạy nốt dòng cuối (không có `\n` shell sẽ không bao
 * giờ thực thi fragment trước khi chết). (W18b: kiểm tra qua
 * `decideSessionLine` nên fragment là `$VAR` cũng được expand, là
 * gán biến đơn giản cũng được track, là nội dung heredoc cũng qua
 * kiểm tra — cùng một logic như dòng đầy đủ.) Fragment trống / chỉ có
 * khoảng trắng thì không có gì để flush. Trả về true khi đã ghi một
 * dòng lành vào stdin. Best-effort: stdin đã đóng / shell đã thoát
 * thì trả false, không throw — thao tác đóng không được fail vì flush.
 * Sau khi gọi, `pendingPartialLine` luôn là '' (không flush hai lần).
 */
function flushPendingPartialLine(entry: RunningSession): boolean {
  const fragment = entry.pendingPartialLine;
  entry.pendingPartialLine = '';
  if (entry.workspaceDir === undefined) return false;
  if (fragment.trim() === '') return false;
  if (entry.exited || entry.child.stdin === null) return false;
  const decision = decideSessionLine(entry, fragment);
  if (!decision.write) {
    process.stderr.write(
      `[daemon] session "${entry.sessionId}": dòng dở cuối bị chặn bởi denylist, bỏ không flush: ${decision.blockedMessage ?? 'COMMAND_BLOCKED'}\n`,
    );
    return false;
  }
  // P0-2: fragment lành denylist vẫn phải qua egress (bản sync, không
  // DNS — xem `checkEgressSync`): dòng chứa đích mạng mà policy chặn
  // (hoặc session bị giam mà chưa có policy) thì bỏ, không flush.
  // Giới hạn: host ở mode allow-public không xác minh được DNS ở đường
  // này nên fail-closed — fragment đó sẽ không được flush.
  if (entry.workspaceDir !== undefined) {
    const egressError = checkSessionLineEgressSync(entry, fragment, { fragment: true });
    if (egressError !== null) {
      process.stderr.write(
        `[daemon] session "${entry.sessionId}": dòng dở cuối bị chặn bởi egress, bỏ không flush: ${egressError.message}\n`,
      );
      return false;
    }
  }
  try {
    entry.child.stdin.write(fragment + '\n', 'utf8');
    return true;
  } catch (err) {
    process.stderr.write(
      `[daemon] session "${entry.sessionId}": không flush được dòng dở cuối: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  }
}

function handleSessionClose(id: string, params: Record<string, unknown>): void {
  const sessionId = params.sessionId;
  if (typeof sessionId !== 'string' || sessionId === '') {
    respondError(id, 'session_close: "sessionId" must be a non-empty string', 'BAD_REQUEST');
    return;
  }
  const entry = sessions.get(sessionId);
  if (entry === undefined) {
    respond(id, { closed: false }); // idempotent: already closed / never existed
    return;
  }
  sessions.delete(sessionId);
  // v0.20 (W14c): flush fragment dòng dở còn lại trước khi đóng —
  // kiểm tra denylist rồi mới ghi (kèm `\n` để shell chạy nốt dòng
  // cuối), vi phạm thì bỏ + ghi log stderr. Best-effort: stdin đã
  // đóng / shell đã thoát thì không flush được, vẫn trả { closed: true }.
  const flushed = flushPendingPartialLine(entry);
  if (!entry.exited) {
    if (flushed) {
      // Đã ghi dòng cuối + `\n`: đóng stdin (EOF) để shell chạy nốt
      // dòng đó rồi tự thoát thay vì bị SIGKILL ngay (kill ngay sẽ
      // làm shell chết trước khi kịp đọc dòng vừa flush). Hẹn kill sau
      // 500ms nếu shell không thoát (vd chương trình tương tác bỏ qua EOF).
      try {
        entry.child.stdin?.end();
      } catch {
        // stdin đã đóng — kill như thường.
        killChild(entry.child);
      }
      const timer = setTimeout(() => {
        if (!entry.exited) killChild(entry.child);
      }, SESSION_CLOSE_KILL_DELAY_MS);
      timer.unref?.();
    } else {
      killChild(entry.child);
    }
  }
  respond(id, { closed: true });
}

function handleSessionList(id: string): void {
  const list: SessionInfo[] = [...sessions.values()].map((s) => ({
    sessionId: s.sessionId,
    command: s.command,
    args: [...s.args],
    startedAt: s.startedAt,
    pid: s.child.pid,
    exited: s.exited,
  }));
  respond(id, list);
}

/**
 * Method `init` (v0.15, M1): đặt workspaceDir cho daemon qua giao thức
 * NDJSON-RPC, cho host nào spawn daemon trước rồi mới biết workspace
 * (DaemonClient spawn daemon.js kế thừa env, nên host có thể đặt env
 * OPENBOT_DAEMON_WORKSPACE_DIR thay vì gọi init — hai đường này tương
 * đương, init chỉ là đường thứ hai cho client nói chuyện qua RPC).
 *
 * Chỉ được đặt khi daemon chưa cấu hình workspaceDir (qua option/env);
 * đã cấu hình rồi thì từ chối đổi (kể cả đổi sang thư mục khác hay gỡ
 * bỏ) để một caller sau không nới lỏng confinement của caller trước —
 * trừ khi giá trị mới giống hệt giá trị cũ (gọi init lặp lại thì ok).
 * Lỗi trả qua respondError, daemon không chết.
 *
 * Allowlist (sau v0.18): `init` cũng nhận `allowedWorkspaceRoots`
 * (mảng chuỗi) với cùng luật — chỉ đặt được khi chưa cấu hình; gọi lại
 * cùng tập root thì ok, đổi sang tập khác thì từ chối mã
 * `WORKSPACE_ROOTS_ALREADY_SET`. workspaceDir hiệu lực (mới hoặc đã
 * có) phải nằm trong allowlist hiệu lực (mới hoặc đã có), nếu không thì
 * từ chối toàn bộ lần init này mã `WORKSPACE_NOT_ALLOWED` và không áp
 * dụng thay đổi nào.
 */
function handleInit(id: string, params: Record<string, unknown>): void {
  const workspaceDir = params.workspaceDir;
  if (workspaceDir !== undefined && typeof workspaceDir !== 'string') {
    respondError(id, 'init: "workspaceDir" must be a string', 'BAD_REQUEST');
    return;
  }
  const resolved =
    typeof workspaceDir === 'string' && workspaceDir !== ''
      ? path.resolve(workspaceDir)
      : undefined;
  const rawRoots = params.allowedWorkspaceRoots;
  if (
    rawRoots !== undefined &&
    (!Array.isArray(rawRoots) || rawRoots.some((r) => typeof r !== 'string'))
  ) {
    respondError(id, 'init: "allowedWorkspaceRoots" must be an array of strings', 'BAD_REQUEST');
    return;
  }
  const resolvedRoots =
    rawRoots !== undefined
      ? (rawRoots as string[])
          .filter((r) => r !== '')
          .map((r) => path.resolve(r))
      : undefined;
  // Mảng rỗng = không đổi (như workspaceDir rỗng), không phải allowlist
  // không có root nào.
  const newRoots =
    resolvedRoots !== undefined && resolvedRoots.length > 0 ? resolvedRoots : undefined;
  if (
    daemonWorkspaceDir !== undefined &&
    resolved !== undefined &&
    resolved !== daemonWorkspaceDir
  ) {
    respondError(
      id,
      `init: workspaceDir đã cấu hình là "${daemonWorkspaceDir}", không được đổi sang "${resolved}"`,
      'WORKSPACE_ALREADY_SET',
    );
    return;
  }
  if (
    daemonAllowedRoots !== undefined &&
    newRoots !== undefined &&
    [...daemonAllowedRoots].sort().join('\0') !== [...newRoots].sort().join('\0')
  ) {
    respondError(
      id,
      `init: allowedWorkspaceRoots đã cấu hình là "${daemonAllowedRoots.join(', ')}", không được đổi`,
      'WORKSPACE_ROOTS_ALREADY_SET',
    );
    return;
  }
  // P0-2: egressPolicy qua init — chỉ đặt được khi daemon chưa cấu
  // hình policy (option/env); gọi lại cùng policy thì ok, đổi sang
  // policy khác thì từ chối mã EGRESS_POLICY_ALREADY_SET để một caller
  // sau không nới lỏng egress của caller trước. Shape sai thì từ chối
  // mã EGRESS_INVALID_POLICY, không áp dụng thay đổi nào.
  const rawEgress = params.egressPolicy;
  let newEgressPolicy: EgressPolicy | undefined;
  if (rawEgress !== undefined) {
    if (typeof rawEgress !== 'object' || rawEgress === null || Array.isArray(rawEgress)) {
      respondError(id, 'init: "egressPolicy" must be an egress policy object', 'EGRESS_INVALID_POLICY');
      return;
    }
    try {
      newEgressPolicy = validateEgressPolicy(rawEgress);
    } catch (err) {
      respondError(
        id,
        `init: "egressPolicy" không hợp lệ: ${err instanceof Error ? err.message : String(err)}`,
        'EGRESS_INVALID_POLICY',
      );
      return;
    }
    if (
      daemonEgressPolicy !== undefined &&
      JSON.stringify(daemonEgressPolicy) !== JSON.stringify(newEgressPolicy)
    ) {
      respondError(
        id,
        'init: egressPolicy đã cấu hình, không được đổi sang policy khác',
        'EGRESS_POLICY_ALREADY_SET',
      );
      return;
    }
  }
  // Kiểm tra chéo trước khi áp dụng: workspaceDir hiệu lực phải nằm
  // trong allowlist hiệu lực (cả hai đều có thể là giá trị mới của lần
  // init này hoặc giá trị đã cấu hình từ trước).
  const effectiveWorkspaceDir = resolved ?? daemonWorkspaceDir;
  const effectiveRoots = newRoots ?? daemonAllowedRoots;
  if (
    effectiveWorkspaceDir !== undefined &&
    effectiveRoots !== undefined &&
    !isWithinAllowedRoots(effectiveWorkspaceDir, effectiveRoots)
  ) {
    respondError(
      id,
      `init: workspaceDir "${effectiveWorkspaceDir}" nằm ngoài các thư mục gốc cho phép (${effectiveRoots.join(', ')})`,
      'WORKSPACE_NOT_ALLOWED',
    );
    return;
  }
  if (resolved !== undefined) daemonWorkspaceDir = resolved;
  if (newRoots !== undefined) daemonAllowedRoots = newRoots;
  if (newEgressPolicy !== undefined) daemonEgressPolicy = newEgressPolicy;
  respond(id, {
    ok: true,
    workspaceDir: daemonWorkspaceDir ?? null,
    allowedWorkspaceRoots: daemonAllowedRoots ?? null,
    egressConfigured: daemonEgressPolicy !== undefined,
  });
}

function handleRequest(raw: string): void {
  let req: DaemonRequest;
  try {
    req = JSON.parse(raw) as DaemonRequest;
  } catch {
    process.stderr.write(`[daemon] ignoring invalid JSON line: ${raw.slice(0, 200)}\n`);
    return;
  }
  if (typeof req !== 'object' || req === null) {
    process.stderr.write('[daemon] ignoring non-object request\n');
    return;
  }
  if (typeof req.id !== 'string' || req.id === '') {
    process.stderr.write('[daemon] ignoring request without a string id\n');
    return;
  }
  const params =
    req.params !== undefined && typeof req.params === 'object' && req.params !== null
      ? (req.params as Record<string, unknown>)
      : {};
  try {
    switch (req.method) {
      case 'init':
        handleInit(req.id, params);
        break;
      case 'exec':
        // Handler async (egress check cần DNS): lỗi bất ngờ được bắt
        // ở đây và chỉ ghi log — handler tự trả lời mọi lỗi đã biết
        // qua respondError, không trả lời lần hai để tránh double-response.
        void handleExec(req.id, params).catch((err: unknown) => {
          process.stderr.write(`[daemon] handler error for exec: ${String(err)}\n`);
        });
        break;
      case 'kill':
        handleKill(req.id, params);
        break;
      case 'list':
        handleList(req.id);
        break;
      case 'session_start':
        void handleSessionStart(req.id, params).catch((err: unknown) => {
          process.stderr.write(`[daemon] handler error for session_start: ${String(err)}\n`);
        });
        break;
      case 'session_write':
        void handleSessionWrite(req.id, params).catch((err: unknown) => {
          process.stderr.write(`[daemon] handler error for session_write: ${String(err)}\n`);
        });
        break;
      case 'session_close':
        handleSessionClose(req.id, params);
        break;
      case 'session_list':
        handleSessionList(req.id);
        break;
      case 'ping':
        respond(req.id, { pong: true });
        break;
      case 'shutdown': {
        shuttingDown = true;
        // process.exit() would truncate a still-buffered stdout write,
        // so only exit once the response has actually been flushed.
        try {
          process.stdout.write(
            JSON.stringify({ id: req.id, result: { ok: true } }) + '\n',
            () => setImmediate(() => shutdownDaemon()),
          );
        } catch {
          setImmediate(() => shutdownDaemon());
        }
        break;
      }
      default:
        respondError(req.id, `unknown method: "${String(req.method)}"`, 'UNKNOWN_METHOD');
    }
  } catch (err) {
    // A handler bug must never kill the daemon: answer with an error.
    process.stderr.write(`[daemon] handler error for ${req.method}: ${String(err)}\n`);
    respondError(
      req.id,
      `daemon error handling "${String(req.method)}": ${err instanceof Error ? err.message : String(err)}`,
      'INTERNAL_ERROR',
    );
  }
}

/**
 * Tắt daemon: kill exec đang chạy, trả lỗi cho exec đang xếp hàng, rồi
 * thoát 0. Session được xử lý như `handleSessionClose` (W19d, v0.26):
 * flush fragment dòng dở lành trước khi kill — ghi kèm `\n` để shell
 * chạy nốt dòng cuối, fragment vi phạm bị bỏ + log stderr (xem
 * `flushPendingPartialLine`); sau flush đóng stdin (EOF) để shell chạy
 * nốt rồi tự thoát thay vì bị SIGKILL ngay, chờ tối đa
 * SESSION_CLOSE_KILL_DELAY_MS rồi mới kill session nào chưa thoát.
 * Shell đã thoát thì không flush/không kill được nữa (giới hạn như cũ).
 * Best-effort: flush không throw, mọi lỗi bắt + log stderr, shutdown
 * không treo vì một session (hết hạn là kill + thoát).
 */
function shutdownDaemon(): void {
  // Gọi lần 2 (vd SIGTERM tới trong lúc đang chờ shell thoát sau flush)
  // thì bỏ qua — lần shutdown đầu tiên đã quyết định mọi thứ.
  if (shutdownStarted) return;
  shutdownStarted = true;
  for (const entry of [...running.values()]) {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    killChild(entry.child);
  }
  running.clear();
  // Exec đang xếp hàng không còn được chạy nữa: trả lời lỗi rõ ràng để
  // client không treo chờ mãi.
  for (const queued of execQueue.splice(0)) {
    respondError(
      queued.requestId,
      'exec: daemon đang tắt nên exec trong hàng đợi bị hủy',
      'SHUTDOWN',
    );
  }
  const flushedSessions: RunningSession[] = [];
  for (const session of [...sessions.values()]) {
    if (session.exited) continue;
    let flushed = false;
    try {
      flushed = flushPendingPartialLine(session);
    } catch (err) {
      process.stderr.write(
        `[daemon] session "${session.sessionId}": lỗi khi flush dòng dở lúc shutdown: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      flushed = false;
    }
    if (flushed) {
      try {
        session.child.stdin?.end();
      } catch {
        // stdin đã đóng — coi như không flush được, kill như thường.
        flushed = false;
      }
    }
    if (flushed) {
      flushedSessions.push(session);
    } else {
      killChild(session.child);
    }
  }
  sessions.clear();
  if (flushedSessions.length === 0) {
    process.exit(0);
    return;
  }
  // Chờ các shell đã flush tự thoát sau EOF, tối đa
  // SESSION_CLOSE_KILL_DELAY_MS — đủ lâu để dòng cuối chạy xong và
  // output kịp chảy qua stdout của daemon về client, đủ ngắn để
  // shutdown không treo. Hết hạn thì kill session nào chưa thoát rồi
  // thoát. Timer unref như ở handleSessionClose: nếu mọi tiến trình
  // con đã thoát thì daemon tự thoát mà không cần đợi hết hạn.
  const timer = setTimeout(() => {
    for (const session of flushedSessions) {
      if (!session.exited) killChild(session.child);
    }
    process.exit(0);
  }, SESSION_CLOSE_KILL_DELAY_MS);
  timer.unref?.();
}

/** Start serving NDJSON-RPC on stdio. Called automatically when this
 *  file is run as the daemon entry point.
 *
 *  `options` (v0.14, toàn bộ optional): `maxExecs` — số exec song song
 *  tối đa (mặc định 4, hoặc env OPENBOT_DAEMON_MAX_EXECS); `onOutputChunk`
 *  — callback nhận từng chunk output đã stream của mỗi exec (cap 1MB).
 *
 *  v0.15 (M1): `options.workspaceDir` — thư mục workspace daemon tự
 *  giam lệnh vào (denylist + cwd confinement trước mỗi lần spawn);
 *  khi không truyền thì đọc env `OPENBOT_DAEMON_WORKSPACE_DIR`; khi cả
 *  hai đều không có thì giữ hành vi cũ (không kiểm tra thêm). Có thể
 *  đặt/giam sau khi chạy bằng method `init` của giao thức RPC.
 *
 *  Allowlist (sau v0.18): `options.allowedWorkspaceRoots` — thư mục gốc
 *  cho phép chứa mọi workspaceDir (option > env
 *  `OPENBOT_DAEMON_ALLOWED_ROOTS`); khi không truyền thì đọc env; khi
 *  cả hai đều không có thì giữ hành vi cũ. Cũng đặt được sau khi chạy
 *  bằng method `init` (chỉ khi chưa cấu hình). */
export function startDaemon(options: DaemonOptions = {}): void {
  daemonOptions = options;
  maxExecs = resolveDaemonMaxExecs(options);
  daemonWorkspaceDir = resolveDaemonWorkspaceDir(options);
  daemonAllowedRoots = resolveDaemonAllowedWorkspaceRoots(options);
  daemonEgressPolicy = resolveDaemonEgressPolicy(options);
  if (
    daemonWorkspaceDir !== undefined &&
    daemonAllowedRoots !== undefined &&
    !isWithinAllowedRoots(daemonWorkspaceDir, daemonAllowedRoots)
  ) {
    process.stderr.write(
      `[daemon] cảnh báo: workspaceDir "${daemonWorkspaceDir}" nằm ngoài ` +
        `allowedWorkspaceRoots (${daemonAllowedRoots.join(', ')}) — mọi exec/session ` +
        `có workspaceDir sẽ bị từ chối mã WORKSPACE_NOT_ALLOWED.\n`,
    );
  }
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line: string) => {
    if (line.trim() === '') return;
    if (!shuttingDown) handleRequest(line);
  });
  // Parent closed stdin (or died): no one can talk to us any more.
  lines.on('close', () => {
    shutdownDaemon();
  });
  process.on('SIGTERM', () => shutdownDaemon());
  process.on('SIGINT', () => shutdownDaemon());
}

// Entry point: `node dist/daemon/daemon.js`
if (require.main === module) {
  startDaemon();
}
