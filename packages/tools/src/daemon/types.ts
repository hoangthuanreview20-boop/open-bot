/**
 * Types for the local-exec-daemon (v0.3 wave 2).
 *
 * The daemon is a child process that runs long shell commands for the
 * desktop app. The parent (DaemonClient) talks to it over stdio using
 * NDJSON-RPC — one JSON object per line:
 *   Request:      {"id": string, "method": string, "params": object}
 *   Response:     {"id": string, "result": any}
 *               | {"id": string, "error": {"message": string, "code"?: string}}
 *   Notification: {"event": string, "data": any}   (no "id")
 */
import type { EgressPolicy } from '@open-bot/core/dist/egress/policy';

/** One command to run. `command` is a program name/path (no shell), so
 *  there is no shell-injection surface: `echo hello` is
 *  `{ command: 'echo', args: ['hello'] }`. */
export interface ExecRequest {
  /** Program to execute, e.g. "node", "sleep", "git". */
  command: string;
  /** Arguments passed to the program. */
  args?: string[];
  /** Working directory. Must exist and be a directory. Defaults to the
   *  daemon process's cwd. */
  cwd?: string;
  /**
   * Environment for the child. When provided it REPLACES the daemon's
   * environment entirely (the child sees exactly these vars); when
   * omitted the child gets `safeEnv()` (allowlist, no secrets — v0.15,
   * M2) instead of inheriting the daemon's whole environment. The
   * shell tool passes the sandbox allowlist (see safeEnv) so a shell
   * child never inherits secrets from the parent process's env.
   */
  env?: Record<string, string>;
  /** Kill the process after this many ms; the result reports timedOut. */
  timeoutMs?: number;
  /**
   * Per-request workspace (v0.16, M1 đa bot): thư mục workspace của bot
   * gọi exec này. Khi có, daemon kiểm tra denylist + cwd confinement
   * theo đúng workspaceDir này (thay cho workspaceDir cấu hình chung
   * của daemon, nếu có) — daemon là một process dùng chung cho nhiều
   * bot, mỗi bot một workspace khác nhau nên không đặt được một
   * workspaceDir duy nhất ở daemon. Khi không có thì giữ hành vi cũ
   * (daemon workspaceDir nếu có, không thì không giam). Giá trị này
   * không được tin mù: daemon chuẩn hoá thành đường dẫn tuyệt đối và
   * cwd của request vẫn phải nằm trong nó (resolveWithin).
   */
  workspaceDir?: string;
  /**
   * P0-2: egress policy riêng cho exec này (JSON-serializable, xem
   * `packages/core/src/egress/`). Ưu tiên cao nhất: request policy >
   * daemon policy (option/env/`init`) > không có policy. Khi exec
   * chạy trong chế độ giam (có workspaceDir hiệu lực) và lệnh chứa
   * đích mạng: không có policy nào → chặn fail-closed mã
   * `EGRESS_UNCONFIGURED`; có policy → mỗi đích phải qua policy.
   * Exec không giam (không có workspaceDir nào) giữ hành vi cũ
   * (không kiểm tra egress) để không phá caller cũ.
   */
  egressPolicy?: EgressPolicy;
}

/** Streaming output callbacks for one exec. */
export interface ExecCallbacks {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/**
 * Minimal surface a shell tool needs from a daemon client. The real
 * DaemonClient satisfies this; tools only depend on the interface so
 * the coordinator can inject its own client (or none — then the tool
 * falls back to in-process runShell).
 */
export interface ShellDaemon {
  exec(request: ExecRequest, callbacks?: ExecCallbacks, execId?: string): Promise<ExecResult>;
  kill(execId: string): Promise<{ killed: boolean }>;
  /** Execs currently running in the daemon (v0.6). */
  list(): Promise<ExecInfo[]>;
  /** Open an interactive shell session (v0.6). Resolves once the shell
   *  is spawned; output streams as `session.stdout` / `session.stderr`
   *  events (see onEvent) and `session.exit` when the shell ends. */
  startSession(request: SessionStartRequest): Promise<SessionStartResult>;
  /** Write text to a session's stdin (v0.6). */
  writeSession(sessionId: string, input: string): Promise<{ ok: boolean }>;
  /** Kill a session's shell and drop it (v0.6). Idempotent. */
  closeSession(sessionId: string): Promise<{ closed: boolean }>;
  /** Interactive sessions currently open in the daemon (v0.6). */
  listSessions(): Promise<SessionInfo[]>;
  /** Subscribe to daemon notifications (exec.stdout / session.stdout /
   *  session.exit / ...). Returns an unsubscribe function. */
  onEvent(handler: (event: string, data: unknown) => void): () => void;
}

/** Request to open an interactive shell session in the daemon. */
export interface SessionStartRequest {
  /** Shell program, e.g. "/bin/sh". Defaults to the platform shell. */
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Per-request workspace (v0.16, M1 đa bot): giống `workspaceDir` của
   * ExecRequest — khi có, daemon giam session này (denylist + cwd
   * confinement) theo đúng workspaceDir của bot gọi, thay cho
   * workspaceDir cấu hình chung của daemon. Không có thì giữ hành vi cũ.
   */
  workspaceDir?: string;
  /**
   * P0-2: egress policy riêng cho session này (giống `egressPolicy`
   * của ExecRequest). Được đóng băng lúc `session_start` (request >
   * daemon) cho cả đời session; `session_write` kiểm tra từng dòng
   * stdin có đích mạng theo policy này.
   */
  egressPolicy?: EgressPolicy;
}

/** Result of `session_start`: the id used by write/close + event routing. */
export interface SessionStartResult {
  sessionId: string;
  pid?: number;
}

/** A chunk of streamed output from a session. */
export interface SessionEvent {
  sessionId: string;
  chunk: string;
}

/** Session exit notification payload. */
export interface SessionExitEvent {
  sessionId: string;
  exitCode: number | null;
  signal: string | null;
}

/** A chunk of streamed output from a running exec. */
export interface ExecEvent {
  execId: string;
  chunk: string;
}

export interface ExecResult {
  /** Process exit code, or null when killed by a signal. */
  exitCode: number | null;
  /** Signal that ended the process, e.g. "SIGKILL", or null. */
  signal: string | null;
  /** True when the process was killed because timeoutMs elapsed. */
  timedOut: boolean;
}

/** Số exec song song tối đa mặc định (v0.14; trước đó là 8 + reject).
 *  Exec vượt cap xếp hàng FIFO thay vì bị reject — xem daemon.ts
 *  (resolveDaemonMaxExecs: option maxExecs > env > mặc định 4). */
export const DEFAULT_DAEMON_MAX_EXECS = 4;

/** @deprecated Dùng DEFAULT_DAEMON_MAX_EXECS. Giữ lại để tương thích. */
export const MAX_CONCURRENT_EXECS = DEFAULT_DAEMON_MAX_EXECS;

/** Max streamed output chars kept per stream, per exec/session (v0.6).
 *  Past the cap the daemon sends one truncation marker and drops the
 *  rest, so a runaway `yes` / huge log can never grow memory unbounded. */
export const MAX_EXEC_OUTPUT_CHARS = 200_000;

export const EXEC_OUTPUT_TRUNCATED_MARKER =
  '\n[... daemon output truncated at 200000 chars ...]';

/** One entry of `list`: a command still running in the daemon. */
export interface ExecInfo {
  execId: string;
  command: string;
  args: string[];
  /** Epoch ms when the process was spawned. */
  startedAt: number;
  /** OS pid of the direct child, when known. Used by kill_process to
   *  prove a pid belongs to a daemon-started exec before killing it. */
  pid?: number;
}

/** One entry of `session_list`: an interactive shell still open. */
export interface SessionInfo {
  sessionId: string;
  command: string;
  args: string[];
  startedAt: number;
  /** OS pid of the shell, when known. */
  pid?: number;
  /** True once the shell process has exited (session kept until closed). */
  exited: boolean;
}

// --- NDJSON-RPC wire types -------------------------------------------------

export type DaemonMethod =
  | 'init'
  | 'exec'
  | 'kill'
  | 'list'
  | 'ping'
  | 'shutdown'
  | 'session_start'
  | 'session_write'
  | 'session_close'
  | 'session_list';

/** Params cho method `init` (v0.15, M1): đặt workspaceDir để daemon tự
 *  giam lệnh (denylist + cwd confinement) cho mọi exec/session sau đó.
 *  Chỉ có tác dụng khi daemon chưa cấu hình workspaceDir (qua option
 *  của startDaemon() hoặc env OPENBOT_DAEMON_WORKSPACE_DIR). */
export interface DaemonInitParams {
  /** Thư mục workspace. Bỏ qua/rỗng = không đổi. */
  workspaceDir?: string;
  /** Thư mục gốc cho phép chứa workspaceDir (allowlist, sau v0.18).
   *  Chỉ đặt được khi daemon chưa cấu hình allowlist (qua option của
   *  startDaemon() hoặc env OPENBOT_DAEMON_ALLOWED_ROOTS); gọi lại cùng
   *  tập root thì ok, đổi sang tập khác thì bị từ chối. Bỏ qua/mảng
   *  rỗng = không đổi. */
  allowedWorkspaceRoots?: string[];
  /**
   * P0-2: egress policy chung của daemon (JSON-serializable). Chỉ đặt
   * được khi daemon chưa cấu hình policy (qua option của startDaemon()
   * hoặc env OPENBOT_DAEMON_EGRESS_POLICY); gọi lại cùng policy thì
   * ok, đổi sang policy khác thì bị từ chối mã
   * `EGRESS_POLICY_ALREADY_SET`. Bỏ qua = không đổi.
   */
  egressPolicy?: EgressPolicy;
}

/** Kết quả của `init`: ok + workspaceDir hiệu lực (null khi chưa có) +
 *  allowlist hiệu lực (null khi chưa cấu hình). */
export interface DaemonInitResult {
  ok: boolean;
  workspaceDir: string | null;
  allowedWorkspaceRoots: string[] | null;
  /** P0-2: true khi daemon đã có egress policy (option/env/init/request). */
  egressConfigured: boolean;
}

export interface DaemonRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface DaemonResponse {
  id: string;
  result?: unknown;
  error?: { message: string; code?: string };
}

export interface DaemonNotification {
  event: string;
  data: unknown;
}

/** Params for `exec`: the ExecRequest plus the client-chosen id used to
 *  correlate stdout/stderr notifications and `kill` calls. When omitted
 *  the daemon generates one and returns it in the result. */
export interface ExecParams extends ExecRequest {
  execId?: string;
}

export interface ExecResultWithId extends ExecResult {
  execId: string;
}
