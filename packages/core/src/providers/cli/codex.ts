/**
 * Codex CLI provider (M2) — driver Codex qua `codex app-server`
 * (JSON-RPC NDJSON trên stdio, xem codexAppServer.ts).
 *
 * Cơ chế (theo mẫu OpenMausBot `server/drivers/codex.ts` + schema
 * protocol sinh ra từ chính CLI thật — xem codexAppServer.ts):
 * spawn `codex app-server` (một process sống cho mỗi provider instance
 * = mỗi bot) → `initialize` → `thread/start` (hoặc `thread/resume`
 * khi process cũ chết mà thread id còn) → `turn/start` mỗi turn.
 *
 * QUYẾT ĐỊNH THIẾT KẾ M2 (đọc kỹ — khác provider API-key):
 * - **CLI sở hữu vòng tool của nó.** Codex tự chạy tool của nó theo
 *   approval policy `on-request`; `chat()` trả `toolCalls: []` —
 *   open-bot không thực thi lại call của CLI. Tool call của CLI chỉ
 *   surface qua event `tool_call` (callback `onCliEvent`).
 * - **Approval = từ chối fail-closed.** Server xin duyệt thì
 *   codexAppServer.ts trả đúng shape deny theo schema thật của CLI
 *   (không approve, không bypass). Chưa có permission broker (M5).
 * - **Chỉ gửi message mới** (delta): thread giữ context nên mỗi
 *   `chat()` chỉ gửi các user message CHƯA gửi. System prompt đổi
 *   hoặc history bị viết lại (compaction) → mở thread MỚI trên cùng
 *   process app-server (không cần restart process — app-server chứa
 *   được nhiều thread) và gửi lại toàn bộ.
 * - **Resume = thread id.** Process chết (abort/timeout/dispose) thì
 *   thread id được giữ lại; lần `chat()` sau spawn process mới và thử
 *   `thread/resume` — resume lỗi (đã kiểm chứng live: process cũ
 *   thoát thì server báo -32600 "no rollout found") thì mở thread mới
 *   và gửi lại toàn bộ history. `resumeCursor` của provider này chính
 *   là thread id (getter `codexThreadId`).
 * - **Model:** KHÔNG truyền model vào thread/start — model id của
 *   provider (`codex`) chỉ là placeholder, Codex dùng model mặc định
 *   của nó (probe live: `gpt-6.1-sol`). Env chỉ allowlist +
 *   `CODEX_HOME` (đường dẫn, không phải secret); không truyền key nào.
 * - **Abort/timeout/process chết = kill cả process group** rồi reject
 *   rõ ràng (như driver Claude M1).
 *
 * GIỚI HẠN CHƯA KIỂM CHỨNG (xem providers/cli/README.md):
 * - Chưa chạy turn thật trên máy có Codex đăng nhập: `turn/start` +
 *   streaming delta + `turn/completed` + approval khi tool cần duyệt
 *   đều mới chỉ khớp schema sinh từ CLI thật, chưa thấy server thật gửi.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { throwIfAborted } from '../abort';
import type {
  ChatCompletionRequest,
  ChatMessage,
  Provider,
  ProviderConfig,
  ProviderResponse,
} from '../../types';
import { sanitizeEnvForCli } from './env';
import { killProcessGroup, spawnCli } from './process';
import { CodexAppServerClient } from './codexAppServer';
import type { CliEvent, CliPermissionHandler } from './types';
import { CODEX_MODEL_ID, CODEX_PROVIDER_ID } from './types';

/** Timeout mặc định cho một turn qua CLI (ms). */
export const CODEX_CLI_DEFAULT_TIMEOUT_MS = 300_000;

/** Số ký tự stderr cuối giữ lại để chẩn đoán khi process chết. */
const STDERR_TAIL_LIMIT = 4096;

export interface CodexCliProviderOptions {
  /** Đường dẫn tuyệt đối tới binary `codex` (do detector tìm thấy). Bắt buộc. */
  binaryPath: string;
  /** Thư mục làm việc cho process CLI (mặc định process.cwd()). */
  cwd?: string;
  /** Timeout một turn (ms); mặc định 5 phút. */
  timeoutMs?: number;
  /** Biến env auth riêng của CLI được phép truyền thêm (mặc định CODEX_HOME). */
  extraEnvAllowed?: string[];
  /** Callback nhận event chuẩn của CLI (text/tool_call/result/error/approval_denied). */
  onCliEvent?: (event: CliEvent) => void;
  /**
   * M5 — sink event của harness (bus + NDJSON log), gắn sau khi tạo
   * provider bằng `attachHarnessSink()` cũng được.
   */
  harnessSink?: (event: CliEvent) => void;
  /**
   * M5 — handler permission tập trung (broker). Không set thì driver
   * tự từ chối fail-closed như M2. Gắn sau khi tạo provider bằng
   * `attachPermissionHandler()` cũng được.
   */
  permissionHandler?: CliPermissionHandler;
  /** Nơi ghi cảnh báo. */
  logger?: { warn(message: string): void };
  /** Hàm spawn (mặc định spawnCli thật; test inject fake). */
  spawn?: (
    binary: string,
    args: string[],
    options: { cwd?: string; env: NodeJS.ProcessEnv },
  ) => ChildProcessWithoutNullStreams;
}

interface PendingTurn {
  resolve: (res: ProviderResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort: () => void;
  signal?: AbortSignal;
}

export class CodexCliProvider implements Provider {
  readonly id = CODEX_PROVIDER_ID;
  readonly label: string;
  private readonly binaryPath: string;
  private readonly cwd?: string;
  private readonly timeoutMs: number;
  private readonly extraEnvAllowed: string[];
  private readonly onCliEvent?: (event: CliEvent) => void;
  /** M5 — sink event của harness (bus + NDJSON log), xem options. */
  private harnessSink?: (event: CliEvent) => void;
  /** M5 — handler permission tập trung (broker), xem options. */
  private permissionHandler?: CliPermissionHandler;
  private readonly warn: (message: string) => void;
  private readonly spawnFn: NonNullable<CodexCliProviderOptions['spawn']>;

  private child: ChildProcessWithoutNullStreams | null = null;
  private client: CodexAppServerClient | null = null;
  /** Thread id đang dùng (resumeCursor) — giữ lại cả khi process chết. */
  private threadId: string | null = null;
  /** Nội dung các user message đã gửi vào thread đang sống (để tính delta). */
  private sentUserMessages: string[] = [];
  /** System prompt đã dùng lúc mở thread đang sống. */
  private threadSystemText: string | null = null;
  private stderrTail = '';
  private pendingTurn: PendingTurn | null = null;
  private disposed = false;

  constructor(config: ProviderConfig, options: CodexCliProviderOptions) {
    if (!options || typeof options.binaryPath !== 'string' || options.binaryPath.trim() === '') {
      throw new Error(
        'Codex (CLI): chưa có đường dẫn binary — bật nguồn Codex trong Settings → Engines để detector tìm thấy `codex` trước.',
      );
    }
    this.label = config.label || 'Codex (CLI)';
    this.binaryPath = options.binaryPath;
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs ?? CODEX_CLI_DEFAULT_TIMEOUT_MS;
    this.extraEnvAllowed = options.extraEnvAllowed ?? ['CODEX_HOME'];
    this.onCliEvent = options.onCliEvent;
    this.harnessSink = options.harnessSink;
    this.permissionHandler = options.permissionHandler;
    this.warn = options.logger
      ? (message: string) => options.logger?.warn(message)
      : (message: string) => console.warn(`[CodexCli] ${message}`);
    this.spawnFn =
      options.spawn ??
      ((binary, args, spawnOpts) =>
        spawnCli(binary, args, { cwd: spawnOpts.cwd, env: spawnOpts.env }));
  }

  // ------------------------------------------------------------------
  // Provider interface
  // ------------------------------------------------------------------

  async listModels(): Promise<string[]> {
    // CLI dùng model đã cấu hình sẵn của nó; model duy nhất là 'codex'.
    return [CODEX_MODEL_ID];
  }

  async chat(req: ChatCompletionRequest): Promise<ProviderResponse> {
    throwIfAborted(req.signal);
    if (this.disposed) {
      throw new Error('Codex (CLI): provider đã dispose, không chạy thêm turn được.');
    }
    if (this.pendingTurn) {
      throw new Error(
        'Codex (CLI): đã có một turn đang chạy trên process này — chờ turn đó xong rồi gửi tiếp.',
      );
    }
    const userMessages = userMessagesOf(req.messages);
    if (userMessages.length === 0) {
      throw new Error('Codex (CLI): không có user message nào để gửi cho CLI.');
    }
    const systemText = systemTextOf(req.messages);
    await this.ensureThread(systemText, userMessages);
    const newMessages = userMessages.slice(this.sentUserMessages.length);
    if (newMessages.length === 0) {
      throw new Error(
        'Codex (CLI): không có user message mới so với turn trước — CLI đã thấy toàn bộ history này.',
      );
    }
    if (!this.client || !this.threadId) {
      throw new Error('Codex (CLI): thread chưa sẵn sàng sau khi mở.');
    }
    // Tạo provider-turn trước (kiểm tra signal đã hủy) rồi mới gửi
    // turn/start — tránh gửi turn rồi mới biết signal đã hủy.
    const turn = this.startTurn(req.signal);
    if (!this.pendingTurn) {
      // Signal hủy ngay giữa chừng: turn.promise đã reject.
      return turn.promise;
    }
    const turnPromise = this.client.startTurn(this.threadId, newMessages);
    this.sentUserMessages = [...userMessages];
    turnPromise.then(
      (result) => {
        this.finishTurn({
          text: result.text,
          toolCalls: [],
          usage: result.usage,
        });
      },
      (err: Error) => {
        this.failTurn(err);
      },
    );
    return turn.promise;
  }

  /**
   * Dừng process CLI đang sống (gọi khi bot bị xoá / app shutdown).
   * Best-effort: không throw. Gọi nhiều lần cũng an toàn.
   */
  async dispose(): Promise<void> {
    if (this.disposed && !this.child) return;
    this.disposed = true;
    if (this.pendingTurn) {
      const err = new Error('Codex (CLI): đã hủy turn khi đang chạy (provider dispose).');
      err.name = 'AbortError';
      this.failTurn(err);
    }
    const child = this.child;
    this.child = null;
    this.client = null;
    this.sentUserMessages = [];
    this.threadSystemText = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // stdin đã đóng.
    }
    await killProcessGroup(child, { logger: { warn: this.warn } });
  }

  /** Alias của dispose(). */
  async close(): Promise<void> {
    await this.dispose();
  }

  // ------------------------------------------------------------------
  // Thread lifecycle
  // ------------------------------------------------------------------

  /**
   * Đảm bảo có thread phù hợp với request trên process đang sống:
   * spawn + initialize khi chưa có process; resume thread cũ khi
   * process mới spawn (fallback mở thread mới khi resume lỗi);
   * mở thread mới khi system prompt đổi hoặc history bị viết lại.
   */
  private async ensureThread(systemText: string, userMessages: string[]): Promise<void> {
    if (this.client && this.threadId) {
      const systemChanged = this.threadSystemText !== systemText;
      const historyRewritten =
        userMessages.length < this.sentUserMessages.length ||
        !this.sentUserMessages.every((sent, i) => sent === userMessages[i]);
      if (systemChanged || historyRewritten) {
        // Mở thread mới trên cùng process (app-server chứa nhiều thread).
        this.threadId = await this.client.startThread({
          cwd: this.cwd,
          baseInstructions: systemText,
        });
        this.threadSystemText = systemText;
        this.sentUserMessages = [];
      }
      return;
    }
    // Chưa có process (hoặc process chết): spawn + initialize.
    await this.spawnProcess();
    if (!this.client) {
      throw new Error('Codex (CLI): process chưa sẵn sàng sau khi spawn.');
    }
    if (this.threadId) {
      // Thử resume thread cũ — lỗi thì mở thread mới + gửi lại history.
      const historyRewritten =
        userMessages.length < this.sentUserMessages.length ||
        !this.sentUserMessages.every((sent, i) => sent === userMessages[i]);
      if (!historyRewritten && this.threadSystemText === systemText) {
        try {
          this.threadId = await this.client.resumeThread(this.threadId, { cwd: this.cwd });
          return;
        } catch (err) {
          this.warn(
            `resume thread Codex lỗi (${(err as Error).message}) — mở thread mới và gửi lại history.`,
          );
        }
      }
      this.threadId = await this.client.startThread({
        cwd: this.cwd,
        baseInstructions: systemText,
      });
      this.threadSystemText = systemText;
      this.sentUserMessages = [];
      return;
    }
    this.threadId = await this.client.startThread({
      cwd: this.cwd,
      baseInstructions: systemText,
    });
    this.threadSystemText = systemText;
    this.sentUserMessages = [];
  }

  private async spawnProcess(): Promise<void> {
    const env = sanitizeEnvForCli(process.env, this.extraEnvAllowed);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnFn(this.binaryPath, ['app-server'], { cwd: this.cwd, env });
    } catch (err) {
      throw new Error(
        `Codex (CLI): không spawn được "${this.binaryPath}": ${(err as Error).message}`,
      );
    }
    this.child = child;
    this.stderrTail = '';
    const client = new CodexAppServerClient(child, {
      // M5: event chảy cả về callback cũ lẫn harness sink (bus + log);
      // permission request chảy về broker (không có broker thì client
      // tự từ chối fail-closed như M2).
      onCliEvent: (event) => {
        try {
          this.onCliEvent?.(event);
        } catch {
          // Callback cũ lỗi không hỏng turn.
        }
        try {
          this.harnessSink?.(event);
        } catch {
          // Sink lỗi không hỏng turn.
        }
      },
      permissionHandler: this.permissionHandler
        ? (request) => this.permissionHandler?.(request) ?? Promise.resolve(false)
        : undefined,
      logger: { warn: this.warn },
    });
    this.client = client;
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-STDERR_TAIL_LIMIT);
    });
    child.on('error', (err: Error) => {
      this.warn(`process codex lỗi spawn: ${err.message}`);
      if (this.child === child) {
        this.child = null;
        this.client = null;
      }
      if (this.pendingTurn) {
        this.failTurn(
          new Error(`Codex (CLI): không chạy được "${this.binaryPath}": ${err.message}`),
        );
      }
    });
    child.on('exit', (code: number | null, signal: string | null) => {
      if (this.child === child) {
        this.child = null;
        this.client = null;
      }
      if (this.pendingTurn) {
        const tail = this.stderrTail.trim();
        client.failAllPending(
          new Error(
            `Codex (CLI): process chết giữa chừng (exit ${code ?? '?'}${
              signal ? `, signal ${signal}` : ''
            })${tail ? ` — stderr: ${tail.slice(0, 500)}` : ''}.`,
          ),
        );
        // failAllPending đã fail turn qua client; đảm bảo provider cũng dọn.
        if (this.pendingTurn) {
          this.failTurn(
            new Error(
              `Codex (CLI): process chết giữa chừng (exit ${code ?? '?'}${
                signal ? `, signal ${signal}` : ''
              }).`,
            ),
          );
        }
      }
    });
    try {
      await client.initialize();
    } catch (err) {
      // Initialize lỗi (vd CLI quá cũ không có app-server): kill process
      // vừa spawn rồi báo rõ — không để process mồ côi.
      this.child = null;
      this.client = null;
      try {
        child.stdin.end();
      } catch {
        // stdin đã đóng.
      }
      await killProcessGroup(child, { logger: { warn: this.warn } });
      throw new Error(`Codex (CLI): \`initialize\` lỗi: ${(err as Error).message}`);
    }
  }

  // ------------------------------------------------------------------
  // Turn handling (timeout / abort / dispose — như driver Claude M1)
  // ------------------------------------------------------------------

  private startTurn(signal: AbortSignal | undefined): { promise: Promise<ProviderResponse> } {
    let resolveTurn!: (res: ProviderResponse) => void;
    let rejectTurn!: (err: Error) => void;
    const promise = new Promise<ProviderResponse>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    // Tránh unhandled rejection khi failTurn chạy trước khi caller await.
    promise.catch(() => undefined);
    const onAbort = (): void => {
      const err = new Error('Codex (CLI): đã hủy turn khi đang chạy.');
      err.name = 'AbortError';
      void this.killCurrentProcess();
      this.failTurn(err);
    };
    const timer = setTimeout(() => {
      const err = new Error(
        `Codex (CLI): hết thời gian chờ ${this.timeoutMs}ms cho một turn — process đã bị dừng.`,
      );
      void this.killCurrentProcess();
      this.failTurn(err);
    }, this.timeoutMs);
    timer.unref?.();
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        const err = new Error('Codex (CLI): đã hủy turn khi đang chạy.');
        err.name = 'AbortError';
        rejectTurn(err);
        return { promise };
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    this.pendingTurn = {
      resolve: resolveTurn,
      reject: rejectTurn,
      timer,
      onAbort,
      signal,
    };
    return { promise };
  }

  private async killCurrentProcess(): Promise<void> {
    const child = this.child;
    if (child) {
      this.child = null;
      this.client = null;
      try {
        child.stdin.end();
      } catch {
        // stdin đã đóng.
      }
      await killProcessGroup(child, { logger: { warn: this.warn } });
    }
    // Thread id được GIỮ LẠI để lần chat sau resume được; chỉ reset
    // sentUserMessages khi process chết giữa turn? Không — resume giữ
    // context nên sentUserMessages vẫn đúng. Khi resume lỗi, ensureThread
    // tự reset. Riêng trường hợp abort/timeout: turn có thể đã gửi
    // message nhưng chưa xong — lần sau gửi lại message đó sẽ trùng?
    // Codex giữ message đã gửi trong thread nên delta vẫn đúng: message
    // đã gửi rồi thì không gửi lại. Giữ nguyên sentUserMessages.
  }

  /** Kết thúc turn đang chờ với lỗi (dọn timer + listener, reject đúng 1 lần). */
  private failTurn(err: Error): void {
    const turn = this.pendingTurn;
    if (!turn) return;
    this.pendingTurn = null;
    clearTimeout(turn.timer);
    turn.signal?.removeEventListener('abort', turn.onAbort);
    turn.reject(err);
  }

  /** Kết thúc turn đang chờ với kết quả (dọn timer + listener, resolve đúng 1 lần). */
  private finishTurn(res: ProviderResponse): void {
    const turn = this.pendingTurn;
    if (!turn) return;
    this.pendingTurn = null;
    clearTimeout(turn.timer);
    turn.signal?.removeEventListener('abort', turn.onAbort);
    turn.resolve(res);
  }

  /** Thread id đang dùng (resumeCursor) — để debug/log. */
  get codexThreadId(): string | null {
    return this.threadId;
  }

  /** Tổng số approval đã bị từ chối fail-closed kể từ khi provider sống. */
  get approvalsDeniedTotal(): number {
    return this.client?.approvalsDeniedTotal ?? 0;
  }

  /** True khi process CLI đang sống (để test + chẩn đoán). */
  get isProcessAlive(): boolean {
    return this.child !== null;
  }

  /** M5 — PID process CLI (undefined khi chưa spawn; harness registry đọc lười). */
  get cliPid(): number | undefined {
    return this.child?.pid;
  }

  /** M5 — gắn sink event của harness sau khi tạo provider. */
  attachHarnessSink(sink: (event: CliEvent) => void): void {
    this.harnessSink = sink;
  }

  /**
   * M5 — gắn handler permission tập trung (broker) sau khi tạo
   * provider. Client đang sống thì nhận ngay; client sau (spawn lại)
   * nhận lúc tạo vì spawnProcess đọc field này.
   */
  attachPermissionHandler(handler: CliPermissionHandler): void {
    this.permissionHandler = handler;
    this.client?.setPermissionHandler(handler);
  }
}

/** Nội dung các user message trong request, theo thứ tự. */
function userMessagesOf(messages: ChatMessage[]): string[] {
  return messages.filter((m) => m.role === 'user').map((m) => m.content);
}

/** System prompt của request (nối các system message). */
function systemTextOf(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
}
