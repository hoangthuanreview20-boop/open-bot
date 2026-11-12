/**
 * Tầng ACP chung (M3) — `BaseAcpCliProvider`.
 *
 * M2 viết toàn bộ vòng đời ACP trong `grok.ts` (spawn → initialize →
 * session/new/load → session/prompt → kill process group). M3 tách
 * phần dùng chung đó ra đây để mọi CLI nói ACP dùng chung một code
 * path duy nhất; driver riêng (grok.ts, opencode.ts, geminiCli.ts,
 * cursorCli.ts, customAcp.ts) chỉ còn khai báo:
 *
 *   - lệnh spawn đưa CLI vào chế độ ACP stdio (`acpArgs`, vd
 *     `['acp']`, `['--acp']`, `['--permission-mode', 'default',
 *     'agent', 'stdio']`),
 *   - biến env riêng được phép thêm (`extraEnvAllowed`, chỉ tên biến
 *     đường dẫn — KHÔNG bao giờ là secret),
 *   - (tuỳ chọn) `authenticateMethodId` — methodId ACP `authenticate`
 *     gọi sau `initialize` (vd Cursor `cursor_login`),
 *   - (tuỳ chọn) `acpArgsAlternatives` — bộ lệnh spawn dự phòng thử
 *     theo thứ tự khi `initialize` của bộ trước lỗi (vd Gemini CLI
 *     `--acp` rồi `--experimental-acp` cho bản cũ).
 *
 * Hành vi chung (giữ nguyên từ grok.ts M2, không đổi ngữ nghĩa):
 * - **CLI sở hữu vòng tool của nó**: `chat()` trả `toolCalls: []` —
 *   open-bot không thực thi lại call của CLI; tool call chỉ surface
 *   qua callback `onCliEvent`.
 * - **Chỉ gửi message mới** (delta): session giữ context nên mỗi
 *   `chat()` chỉ gửi các user message CHƯA gửi. System prompt đổi
 *   hoặc history bị viết lại (compaction) → mở session MỚI trên cùng
 *   process và gửi lại toàn bộ.
 * - **System prompt:** ACP `session/new` KHÔNG có chỗ cho system
 *   prompt (theo ACP chuẩn) nên system prompt được GỘP vào user
 *   message đầu tiên của session mới (`"<system>\n\n<message>"`).
 * - **Resume = session id.** Process chết thì session id được giữ
 *   lại; lần `chat()` sau spawn process mới và thử `session/load` —
 *   lỗi thì mở session mới và gửi lại toàn bộ history.
 * - **Approval = từ chối fail-closed** (ở AcpClient): server gửi
 *   `session/request_permission` thì chọn `reject_once` (không có thì
 *   `reject_always`, không nữa thì `cancelled`) — KHÔNG bao giờ allow
 *   trừ khi permission broker (M5) đã hỏi user và user cho phép tường
 *   minh qua thẻ duyệt (`permissionHandler` trong AcpClientOptions).
 *   Không có broker thì vẫn từ chối như cũ.
 * - **Env tối thiểu** (`env.ts`): allowlist + biến riêng của driver;
 *   mọi biến secret khác đều bị chặn khỏi env của turn.
 * - **Abort/timeout/process chết/dispose = kill cả process group**
 *   (POSIX: kill `-pid`; Windows: `taskkill /PID /T /F`).
 *
 * GIỚI HẠN CHƯA KIỂM CHỨNG: tầng chung mới chỉ kiểm chứng bằng fake
 * CLI ACP (tests/detected-cli-m3.test.mjs) + driver Grok M2 (cũng
 * bằng fake — máy này không có CLI ACP thật nào). Mỗi driver ghi rõ
 * trong file của nó phần nào chưa kiểm chứng trên CLI thật (xem
 * providers/cli/README.md mục M3).
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
import { AcpClient } from './acp';
import type { CliEvent, CliPermissionHandler } from './types';

/** Timeout mặc định cho một turn qua CLI ACP (ms). */
export const ACP_CLI_DEFAULT_TIMEOUT_MS = 300_000;

/** Số ký tự stderr cuối giữ lại để chẩn đoán khi process chết. */
const STDERR_TAIL_LIMIT = 4096;

export interface AcpCliProviderOptions {
  /** Đường dẫn tuyệt đối tới binary CLI (do detector tìm thấy). Bắt buộc. */
  binaryPath: string;
  /**
   * argv đưa CLI vào chế độ ACP stdio (vd `['acp']`,
   * `['--permission-mode', 'default', 'agent', 'stdio']`). Bắt buộc,
   * ít nhất một phần tử.
   */
  acpArgs: string[];
  /**
   * Bộ lệnh spawn dự phòng, thử theo thứ tự khi `initialize` của bộ
   * trước lỗi (vd Gemini CLI: `['--acp']` rồi `['--experimental-acp']`
   * cho bản cũ). Mỗi lần thử đều kill sạch process trước đó.
   */
  acpArgsAlternatives?: string[][];
  /** Biến env riêng của CLI được phép truyền thêm (chỉ tên biến đường dẫn, không secret). */
  extraEnvAllowed?: string[];
  /** Thư mục làm việc cho process CLI (mặc định process.cwd()). */
  cwd?: string;
  /** Timeout một turn (ms); mặc định 5 phút. */
  timeoutMs?: number;
  /** Callback nhận event chuẩn của CLI (text/tool_call/result/error/approval_denied). */
  onCliEvent?: (event: CliEvent) => void;
  /**
   * M5 — sink event của harness (bus + NDJSON log), gắn sau khi tạo
   * provider bằng `attachHarnessSink()` cũng được.
   */
  harnessSink?: (event: CliEvent) => void;
  /**
   * M5 — handler permission tập trung (broker). Không set thì driver
   * tự từ chối fail-closed như M2/M3. Gắn sau khi tạo provider bằng
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
  /**
   * MethodId ACP `authenticate` gọi sau `initialize` (vd Cursor
   * `cursor_login`). Lỗi ở bước này chỉ cảnh báo rồi tiếp tục — một
   * số bản CLI không yêu cầu, và `session/new` sẽ lỗi rõ nếu thật sự
   * chưa đăng nhập (fail-closed ở đó, không đoán).
   */
  authenticateMethodId?: string;
}

/** Định danh provider/model mà driver con khai báo cho base class. */
export interface AcpCliProviderIdentity {
  /** Provider id (vd 'grok-cli', 'opencode'). */
  providerId: string;
  /** Model id duy nhất của provider (placeholder — CLI dùng model của nó). */
  modelId: string;
  /** Tên hiển thị trong log/lỗi (vd 'Grok CLI'). */
  displayName: string;
  /**
   * True khi driver còn thử nghiệm (giao diện ACP của CLI chưa được
   * docs chính thức xác nhận đầy đủ) — chỉ là dấu hiệu để UI/log
   * đọc, không đổi hành vi. Mặc định false.
   */
  experimental?: boolean;
}

interface PendingTurn {
  resolve: (res: ProviderResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort: () => void;
  signal?: AbortSignal;
}

export class BaseAcpCliProvider implements Provider {
  readonly id: string;
  readonly label: string;
  /** Model id duy nhất của provider (placeholder). */
  protected readonly modelId: string;
  /** Tên hiển thị trong log/lỗi. */
  protected readonly displayName: string;
  /** True khi driver còn thử nghiệm (xem AcpCliProviderIdentity). */
  readonly experimental: boolean;
  private readonly binaryPath: string;
  private readonly acpArgsList: string[][];
  private readonly cwd?: string;
  private readonly timeoutMs: number;
  private readonly extraEnvAllowed: string[];
  private readonly onCliEvent?: (event: CliEvent) => void;
  /** M5 — sink event của harness (bus + NDJSON log), xem options. */
  private harnessSink?: (event: CliEvent) => void;
  /** M5 — handler permission tập trung (broker), xem options. */
  private permissionHandler?: CliPermissionHandler;
  private readonly warn: (message: string) => void;
  private readonly spawnFn: NonNullable<AcpCliProviderOptions['spawn']>;
  private readonly authenticateMethodId?: string;

  private child: ChildProcessWithoutNullStreams | null = null;
  private client: AcpClient | null = null;
  /** Session id đang dùng (resumeCursor) — giữ lại cả khi process chết. */
  private sessionId: string | null = null;
  /** Nội dung các user message đã gửi vào session đang sống (để tính delta). */
  private sentUserMessages: string[] = [];
  /** System prompt đã dùng lúc mở session đang sống. */
  private sessionSystemText: string | null = null;
  /**
   * True khi session hiện tại chưa nhận prompt nào — system prompt sẽ
   * được gộp vào prompt đầu tiên của session (ACP không có slot riêng
   * cho system prompt).
   */
  private needsSystemPrepend = false;
  private stderrTail = '';
  private pendingTurn: PendingTurn | null = null;
  private disposed = false;

  constructor(
    config: ProviderConfig,
    identity: AcpCliProviderIdentity,
    options: AcpCliProviderOptions,
  ) {
    if (!options || typeof options.binaryPath !== 'string' || options.binaryPath.trim() === '') {
      throw new Error(
        `${identity.displayName}: chưa có đường dẫn binary — bật nguồn ${identity.displayName} trong Settings → Engines để detector tìm thấy binary trước.`,
      );
    }
    if (!Array.isArray(options.acpArgs) || options.acpArgs.length === 0) {
      throw new Error(
        `${identity.displayName}: chưa cấu hình lệnh ACP (acpArgs rỗng) — driver cần ít nhất một argv để đưa CLI vào chế độ ACP stdio.`,
      );
    }
    this.id = identity.providerId;
    this.label = config.label || identity.displayName;
    this.modelId = identity.modelId;
    this.displayName = identity.displayName;
    this.experimental = identity.experimental ?? false;
    this.binaryPath = options.binaryPath;
    this.acpArgsList = [
      [...options.acpArgs],
      ...(options.acpArgsAlternatives ?? []).map((args) => [...args]),
    ];
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs ?? ACP_CLI_DEFAULT_TIMEOUT_MS;
    this.extraEnvAllowed = options.extraEnvAllowed ?? [];
    this.onCliEvent = options.onCliEvent;
    this.harnessSink = options.harnessSink;
    this.permissionHandler = options.permissionHandler;
    this.warn = options.logger
      ? (message: string) => options.logger?.warn(message)
      : (message: string) => console.warn(`[${identity.displayName}] ${message}`);
    this.spawnFn =
      options.spawn ??
      ((binary, args, spawnOpts) =>
        spawnCli(binary, args, { cwd: spawnOpts.cwd, env: spawnOpts.env }));
    this.authenticateMethodId = options.authenticateMethodId;
  }

  // ------------------------------------------------------------------
  // Provider interface
  // ------------------------------------------------------------------

  async listModels(): Promise<string[]> {
    // CLI dùng model đã cấu hình sẵn của nó; model duy nhất là placeholder.
    return [this.modelId];
  }

  async chat(req: ChatCompletionRequest): Promise<ProviderResponse> {
    throwIfAborted(req.signal);
    if (this.disposed) {
      throw new Error(`${this.displayName}: provider đã dispose, không chạy thêm turn được.`);
    }
    if (this.pendingTurn) {
      throw new Error(
        `${this.displayName}: đã có một turn đang chạy trên process này — chờ turn đó xong rồi gửi tiếp.`,
      );
    }
    const userMessages = userMessagesOf(req.messages);
    if (userMessages.length === 0) {
      throw new Error(`${this.displayName}: không có user message nào để gửi cho CLI.`);
    }
    const systemText = systemTextOf(req.messages);
    await this.ensureSession(systemText, userMessages);
    const newMessages = userMessages.slice(this.sentUserMessages.length);
    if (newMessages.length === 0) {
      throw new Error(
        `${this.displayName}: không có user message mới so với turn trước — CLI đã thấy toàn bộ history này.`,
      );
    }
    if (!this.client || !this.sessionId) {
      throw new Error(`${this.displayName}: session chưa sẵn sàng sau khi mở.`);
    }
    // System prompt gộp vào message đầu của session mới (xem đầu file).
    const textsToSend = [...newMessages];
    if (this.needsSystemPrepend && systemText.trim().length > 0) {
      textsToSend[0] = `${systemText}\n\n${textsToSend[0]}`;
    }
    this.needsSystemPrepend = false;
    // Tạo provider-turn trước (kiểm tra signal đã hủy) rồi mới gửi prompt.
    const turn = this.startTurn(req.signal);
    if (!this.pendingTurn) {
      // Signal hủy ngay giữa chừng: turn.promise đã reject.
      return turn.promise;
    }
    const sessionId = this.sessionId;
    const promptPromise = this.client.prompt(sessionId, textsToSend);
    this.sentUserMessages = [...userMessages];
    promptPromise.then(
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
      const err = new Error(`${this.displayName}: đã hủy turn khi đang chạy (provider dispose).`);
      err.name = 'AbortError';
      this.failTurn(err);
    }
    const child = this.child;
    this.child = null;
    this.client = null;
    this.sentUserMessages = [];
    this.sessionSystemText = null;
    this.needsSystemPrepend = false;
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
  // Session lifecycle
  // ------------------------------------------------------------------

  /**
   * Đảm bảo có session phù hợp với request trên process đang sống:
   * spawn + initialize khi chưa có process; load session cũ khi
   * process mới spawn (fallback mở session mới khi load lỗi);
   * mở session mới khi system prompt đổi hoặc history bị viết lại.
   */
  private async ensureSession(systemText: string, userMessages: string[]): Promise<void> {
    if (this.client && this.sessionId) {
      const systemChanged = this.sessionSystemText !== systemText;
      const historyRewritten =
        userMessages.length < this.sentUserMessages.length ||
        !this.sentUserMessages.every((sent, i) => sent === userMessages[i]);
      if (systemChanged || historyRewritten) {
        // Mở session mới trên cùng process.
        this.sessionId = await this.client.newSession({ cwd: this.cwd });
        this.sessionSystemText = systemText;
        this.sentUserMessages = [];
        this.needsSystemPrepend = true;
      }
      return;
    }
    // Chưa có process (hoặc process chết): spawn + initialize.
    await this.spawnProcess();
    if (!this.client) {
      throw new Error(`${this.displayName}: process chưa sẵn sàng sau khi spawn.`);
    }
    if (this.sessionId) {
      // Thử load session cũ — lỗi thì mở session mới + gửi lại history.
      const historyRewritten =
        userMessages.length < this.sentUserMessages.length ||
        !this.sentUserMessages.every((sent, i) => sent === userMessages[i]);
      if (!historyRewritten && this.sessionSystemText === systemText) {
        try {
          await this.client.loadSession(this.sessionId, { cwd: this.cwd });
          return;
        } catch (err) {
          this.warn(
            `load session ${this.displayName} lỗi (${(err as Error).message}) — mở session mới và gửi lại history.`,
          );
        }
      }
      this.sessionId = await this.client.newSession({ cwd: this.cwd });
      this.sessionSystemText = systemText;
      this.sentUserMessages = [];
      this.needsSystemPrepend = true;
      return;
    }
    this.sessionId = await this.client.newSession({ cwd: this.cwd });
    this.sessionSystemText = systemText;
    this.sentUserMessages = [];
    this.needsSystemPrepend = true;
  }

  /**
   * Spawn process ACP: thử từng bộ `acpArgs` theo thứ tự cho tới khi
   * `initialize` thành công (bộ sau chỉ thử khi bộ trước lỗi
   * initialize — vd Gemini `--acp` rồi `--experimental-acp`). Mỗi lần
   * thử lỗi đều kill sạch process vừa spawn, không để process mồ côi.
   */
  private async spawnProcess(): Promise<void> {
    const env = sanitizeEnvForCli(process.env, this.extraEnvAllowed);
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.acpArgsList.length; attempt += 1) {
      const acpArgs = this.acpArgsList[attempt] as string[];
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnFn(this.binaryPath, [...acpArgs], { cwd: this.cwd, env });
      } catch (err) {
        lastError = new Error(
          `${this.displayName}: không spawn được "${this.binaryPath}": ${(err as Error).message}`,
        );
        continue;
      }
      this.child = child;
      this.stderrTail = '';
      const client = new AcpClient(child, {
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
        this.warn(`process ${this.displayName} lỗi spawn: ${err.message}`);
        if (this.child === child) {
          this.child = null;
          this.client = null;
        }
        if (this.pendingTurn) {
          this.failTurn(
            new Error(`${this.displayName}: không chạy được "${this.binaryPath}": ${err.message}`),
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
              `${this.displayName}: process chết giữa chừng (exit ${code ?? '?'}${
                signal ? `, signal ${signal}` : ''
              })${tail ? ` — stderr: ${tail.slice(0, 500)}` : ''}.`,
            ),
          );
          if (this.pendingTurn) {
            this.failTurn(
              new Error(
                `${this.displayName}: process chết giữa chừng (exit ${code ?? '?'}${
                  signal ? `, signal ${signal}` : ''
                }).`,
              ),
            );
          }
        }
      });
      try {
        await client.initialize();
        if (this.authenticateMethodId) {
          try {
            await client.authenticate(this.authenticateMethodId);
          } catch (err) {
            // Không bắt buộc: một số bản CLI không yêu cầu bước này;
            // session/new sẽ lỗi rõ nếu thật sự chưa đăng nhập.
            this.warn(
              `ACP authenticate (${this.authenticateMethodId}) lỗi: ${(err as Error).message} — tiếp tục thử session/new.`,
            );
          }
        }
        return; // initialize (+ authenticate tuỳ chọn) thành công.
      } catch (err) {
        // Initialize lỗi (vd CLI quá cũ không nói ACP, hoặc cờ ACP
        // sai): kill process vừa spawn rồi thử bộ args tiếp theo (nếu
        // còn); hết bộ thì báo lỗi cuối cùng.
        lastError = new Error(
          `${this.displayName}: \`initialize\` lỗi (args: ${acpArgs.join(' ')}): ${(err as Error).message}`,
        );
        this.child = null;
        this.client = null;
        try {
          child.stdin.end();
        } catch {
          // stdin đã đóng.
        }
        await killProcessGroup(child, { logger: { warn: this.warn } });
      }
    }
    throw lastError ?? new Error(`${this.displayName}: không spawn được process ACP.`);
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
      const err = new Error(`${this.displayName}: đã hủy turn khi đang chạy.`);
      err.name = 'AbortError';
      void this.killCurrentProcess();
      this.failTurn(err);
    };
    const timer = setTimeout(() => {
      const err = new Error(
        `${this.displayName}: hết thời gian chờ ${this.timeoutMs}ms cho một turn — process đã bị dừng.`,
      );
      void this.killCurrentProcess();
      this.failTurn(err);
    }, this.timeoutMs);
    timer.unref?.();
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        const err = new Error(`${this.displayName}: đã hủy turn khi đang chạy.`);
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
    // Session id được GIỮ LẠI để lần chat sau load được; sentUserMessages
    // vẫn đúng khi load thành công (session giữ context). Khi load lỗi,
    // ensureSession tự reset và gửi lại toàn bộ.
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

  /** Session id đang dùng (resumeCursor) — để debug/log. */
  get acpSessionId(): string | null {
    return this.sessionId;
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
