/**
 * DaemonClient: parent-side driver for the local-exec-daemon.
 *
 * Spawns `dist/daemon/daemon.js` with the current node binary and talks
 * NDJSON-RPC over its stdio. Requests are matched to responses by `id`;
 * stdout/stderr chunks arrive as notifications and are routed to the
 * per-exec callbacks registered by exec(), plus any global event
 * listeners added with onEvent().
 *
 * The daemon is crash-isolated: if it dies, pending requests reject with
 * a clear error instead of hanging, and exec() promises never resolve
 * with a fake result.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  DaemonInitParams,
  DaemonInitResult,
  DaemonNotification,
  DaemonResponse,
  ExecCallbacks,
  ExecEvent,
  ExecInfo,
  ExecRequest,
  ExecResult,
  SessionInfo,
  SessionStartRequest,
  SessionStartResult,
} from './types';

export type { ExecCallbacks } from './types';

export interface DaemonClientOptions {
  /** Absolute path of the daemon entry. Defaults to daemon.js next to
   *  this file (dist/daemon/daemon.js after build). */
  daemonPath?: string;
  /** How long ping/kill/list/shutdown wait before failing. exec() waits
   *  until the child exits (or its own timeoutMs fires in the daemon). */
  requestTimeoutMs?: number;
  /** Optional sink for the daemon's own stderr diagnostics. */
  onDaemonStderr?: (chunk: string) => void;
}

export type DaemonEventHandler = (event: string, data: unknown) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DISPOSE_TIMEOUT_MS = 5_000;

export class DaemonClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventHandlers = new Set<DaemonEventHandler>();
  private readonly execHandlers = new Map<
    string,
    { onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void }
  >();
  private readonly requestTimeoutMs: number;
  private buffer = '';
  private disposed = false;
  private exitPromise: Promise<void>;

  constructor(options: DaemonClientOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const daemonPath = options.daemonPath ?? path.join(__dirname, 'daemon.js');
    this.proc = spawn(process.execPath, [daemonPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.exitPromise = new Promise<void>((resolveExit) => {
      this.proc.on('exit', () => resolveExit());
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk: string) => {
      options.onDaemonStderr?.(chunk);
    });
    this.proc.on('error', (err: Error) => this.failAllPending(
      new Error(`exec daemon failed to start: ${err.message}`),
    ));
    this.proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (!this.disposed) {
        this.failAllPending(
          new Error(
            `exec daemon exited unexpectedly (code=${String(code)}, ` +
              `signal=${String(signal)}); running execs were killed with it`,
          ),
        );
      }
    });
  }

  // --- public API ----------------------------------------------------------

  /** True once dispose() has been called. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** OS pid of the daemon child, if it has spawned. */
  get pid(): number | undefined {
    return this.proc.pid;
  }

  /** Resolves when the daemon child process exits (any reason). */
  waitForExit(): Promise<void> {
    return this.exitPromise;
  }

  /** Liveness check. Resolves { pong: true } while the daemon answers. */
  async ping(): Promise<{ pong: boolean }> {
    return (await this.request('ping', {}, this.requestTimeoutMs)) as { pong: boolean };
  }

  /**
   * Configure the daemon once (v0.19, W11c allowlist): set the daemon-wide
   * workspaceDir and/or the allowed workspace roots. Only applies while
   * the daemon has not configured that value yet — re-calling with the
   * same roots is fine, changing them is rejected by the daemon
   * (WORKSPACE_ROOTS_ALREADY_SET / WORKSPACE_NOT_ALLOWED). Hosts that
   * start the daemon with options/env roots configured do not need this.
   */
  async init(params: DaemonInitParams = {}): Promise<DaemonInitResult> {
    return (await this.request('init', { ...params }, this.requestTimeoutMs)) as DaemonInitResult;
  }

  /** Execs currently running in the daemon. */
  async list(): Promise<ExecInfo[]> {
    return (await this.request('list', {}, this.requestTimeoutMs)) as ExecInfo[];
  }

  // --- interactive shell sessions (v0.6) -----------------------------------

  /**
   * Open an interactive shell in the daemon. Resolves once the shell is
   * spawned; output streams as `session.stdout` / `session.stderr`
   * notifications (subscribe with onEvent) and `session.exit` when the
   * shell ends. The caller owns closing the session.
   *
   * v0.16 (M1 đa bot): `request.workspaceDir` (nếu có) được gửi kèm
   * nguyên vẹn trong request NDJSON để daemon giam session này theo
   * đúng workspace của bot gọi (request workspaceDir > daemon
   * workspaceDir > không giam).
   */
  async startSession(request: SessionStartRequest = {}): Promise<SessionStartResult> {
    return (await this.request(
      'session_start',
      { ...request },
      this.requestTimeoutMs,
    )) as SessionStartResult;
  }

  /** Write text to a session's stdin. Rejects when the session is unknown or has exited. */
  async writeSession(sessionId: string, input: string): Promise<{ ok: boolean }> {
    return (await this.request(
      'session_write',
      { sessionId, input },
      this.requestTimeoutMs,
    )) as { ok: boolean };
  }

  /** Kill a session's shell and drop it. Idempotent ({ closed: false } when unknown). */
  async closeSession(sessionId: string): Promise<{ closed: boolean }> {
    return (await this.request(
      'session_close',
      { sessionId },
      this.requestTimeoutMs,
    )) as { closed: boolean };
  }

  /** Interactive sessions currently open in the daemon. */
  async listSessions(): Promise<SessionInfo[]> {
    return (await this.request(
      'session_list',
      {},
      this.requestTimeoutMs,
    )) as SessionInfo[];
  }

  /**
   * Run a command in the daemon. Resolves with the exit code / signal /
   * timedOut flag when the process ends; stdout/stderr stream to the
   * callbacks as they arrive. Rejects when the command cannot start
   * (unknown program, bad cwd, ...) — the daemon stays alive.
   * `execId` may be supplied by the caller (the shell tool does this so
   * an AbortSignal can kill the exec); otherwise one is generated.
   *
   * v0.16 (M1 đa bot): toàn bộ `request` — kể cả `workspaceDir` (nếu
   * có) — được gửi kèm nguyên vẹn trong request NDJSON để daemon giam
   * exec này theo đúng workspace của bot gọi (request workspaceDir >
   * daemon workspaceDir > không giam). Không cần tham số riêng: client
   * chỉ chuyển tiếp.
   */
  async exec(
    request: ExecRequest,
    callbacks: ExecCallbacks = {},
    execId: string = randomUUID(),
  ): Promise<ExecResult> {
    this.execHandlers.set(execId, callbacks);
    try {
      const result = (await this.request(
        'exec',
        { ...request, execId },
        undefined, // no client-side timeout: the daemon's timeoutMs rules
      )) as ExecResult & { execId?: string };
      return {
        exitCode: result.exitCode ?? null,
        signal: result.signal ?? null,
        timedOut: result.timedOut ?? false,
      };
    } finally {
      this.execHandlers.delete(execId);
    }
  }

  /**
   * Kill a running exec. Returns { killed: true } when a live process
   * was signalled; { killed: false } when it had already finished or
   * never existed (safe to call repeatedly).
   */
  async kill(execId: string): Promise<{ killed: boolean }> {
    return (await this.request('kill', { execId }, this.requestTimeoutMs)) as {
      killed: boolean;
    };
  }

  /** Subscribe to every daemon notification (exec.stdout / exec.stderr /
   *  ...). Returns an unsubscribe function. */
  onEvent(handler: DaemonEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  /**
   * Shut the daemon down: send `shutdown`, wait up to 5s for it to exit,
   * then SIGKILL it. Safe to call repeatedly.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    // Send shutdown BEFORE marking disposed: request() refuses to send
    // once disposed, and the daemon would then never be told to exit.
    try {
      await this.request('shutdown', {}, DISPOSE_TIMEOUT_MS);
    } catch {
      // Daemon already gone or not answering — fall through to kill.
    }
    this.disposed = true;
    const exited = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise<boolean>((resolveExit) =>
        setTimeout(() => resolveExit(false), DISPOSE_TIMEOUT_MS),
      ),
    ]);
    if (!exited) {
      try {
        this.proc.kill('SIGKILL');
      } catch {
        // Already dead.
      }
      await this.exitPromise;
    }
    this.failAllPending(new Error('exec daemon is disposed'));
  }

  // --- internals -----------------------------------------------------------

  private request(method: string, params: object, timeoutMs: number | undefined): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error(`cannot send "${method}": exec daemon is disposed`));
    }
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(
            new Error(`exec daemon request "${method}" timed out after ${timeoutMs}ms`),
          );
        }, timeoutMs);
        timer.unref?.();
      }
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      } catch (err) {
        this.pending.delete(id);
        if (timer !== undefined) clearTimeout(timer);
        reject(
          new Error(
            `failed to send "${method}" to exec daemon: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (line.trim() === '') continue;
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let msg: DaemonResponse | DaemonNotification;
    try {
      msg = JSON.parse(line) as DaemonResponse | DaemonNotification;
    } catch {
      // A corrupt line must not break the client; the pending request
      // will fail on its own timeout (or the daemon's exit).
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    if ('event' in msg && typeof msg.event === 'string') {
      this.dispatchEvent(msg.event, (msg as DaemonNotification).data);
      return;
    }
    if (!('id' in msg) || typeof (msg as DaemonResponse).id !== 'string') return;
    const pending = this.pending.get((msg as DaemonResponse).id);
    if (pending === undefined) return;
    this.pending.delete((msg as DaemonResponse).id);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    const res = msg as DaemonResponse;
    if (res.error !== undefined) {
      const err = new Error(res.error.message);
      (err as Error & { code?: string }).code = res.error.code;
      pending.reject(err);
    } else {
      pending.resolve(res.result);
    }
  }

  private dispatchEvent(event: string, data: unknown): void {
    if ((event === 'exec.stdout' || event === 'exec.stderr') && typeof data === 'object' && data !== null) {
      const { execId, chunk } = data as ExecEvent;
      const handlers = this.execHandlers.get(execId);
      if (handlers !== undefined && typeof chunk === 'string') {
        if (event === 'exec.stdout') handlers.onStdout?.(chunk);
        else handlers.onStderr?.(chunk);
      }
    }
    for (const handler of [...this.eventHandlers]) {
      try {
        handler(event, data);
      } catch {
        // A listener bug must not break the client loop.
      }
    }
  }

  private failAllPending(err: Error): void {
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id);
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(err);
    }
  }
}
