/**
 * Tầng one-shot text chung (M4, sóng B) — `BaseOneShotCliProvider`.
 *
 * Một số CLI không có chế độ session sống (stream-JSON/ACP/app-server
 * như Claude/Codex/Grok) mà chỉ chạy được theo kiểu "một lệnh, một
 * prompt, in đáp án rồi thoát": Aider (`--message`), Continue
 * (`-p`), Amazon Q (`chat --no-interactive --input`), Kiro CLI
 * (`chat --no-interactive <prompt>` — prompt vị trí, v0.76).
 * Driver cho các CLI này dùng chung một code path duy nhất ở đây; driver riêng chỉ
 * còn khai báo argv + env + cách làm sạch output.
 *
 * Hành vi chung:
 * - **Stateless (mỗi turn một process mới).** CLI one-shot không giữ
 *   session giữa các lần gọi (Aider có `.aider.chat.history.md`
 *   nhưng hành vi restore của nó không được dựa vào — chưa kiểm
 *   chứng), nên mỗi `chat()` gửi TOÀN BỘ hội thoại (system + tất cả
 *   user/assistant message, xem `renderOneShotPrompt`) trong MỘT
 *   prompt. Đắt token hơn session sống, nhưng đúng trong mọi trường
 *   hợp và không bao giờ gửi trùng/lệch context.
 * - **CLI sở hữu vòng tool của nó** (như mọi driver CLI khác):
 *   `chat()` trả `toolCalls: []` — open-bot không thực thi lại call
 *   của CLI; text trả về là đáp án cuối của CLI.
 * - **Fail-closed về quyền:** driver KHÔNG truyền cờ auto-approve
 *   nào (`--trust-all-tools`, `--allow-all-tools`, `--allow`, …).
 *   Tool nào cần duyệt thì hoặc bị CLI từ chối (Aider
 *   `--yes-always` từ chối shell command; Q `--no-interactive`
 *   lỗi thay vì hỏi), hoặc treo tới timeout rồi bị kill — không bao
 *   giờ tự chạy lệnh/file mà không có người duyệt.
 * - **Env tối thiểu** (`env.ts`): allowlist + biến riêng của driver;
 *   mọi biến secret khác đều bị chặn khỏi env của turn. Ngoại lệ DUY
 *   NHẤT: Aider/Continue chạy bằng API key của CHÍNH user cho CHÍNH
 *   CLI của họ (không có key thì CLI không chạy được) nên driver
 *   khai rõ tên biến key được phép chui qua — xem aider.ts /
 *   continueCli.ts; không bao giờ log giá trị.
 * - **Abort/timeout/process chết/dispose = kill cả process group**
 *   (POSIX: kill `-pid`; Windows: `taskkill /PID /T /F`), như mọi
 *   driver CLI khác. Exit != 0 → lỗi kèm stderr (cắt ngắn).
 * - **Output là text thô** (stdout, đã strip ANSI): driver riêng có
 *   thể ghi đè `parseOutput` để tách usage best-effort (vd dòng
 *   `Tokens: … sent, … received` của Aider) — usage thiếu thì bỏ
 *   trống, không bịa số.
 *
 * GIỚI HẠN CHƯA KIỂM CHỨNG: tầng chung + 3 driver one-shot mới chỉ
 * kiểm chứng bằng fake CLI (tests/detected-cli-b-drivers.test.mjs)
 * — máy này không có aider/cn/q thật. Cờ spawn + shape output của
 * từng CLI lấy từ docs/code công khai (xem file từng driver). Cần
 * chạy thật trên máy có CLI đăng nhập trước khi coi M4 là xong (xem
 * providers/cli/README.md mục M4).
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
import type { CliEvent } from './types';

/** Timeout mặc định cho một turn one-shot (ms). */
export const ONE_SHOT_CLI_DEFAULT_TIMEOUT_MS = 300_000;

/** Số ký tự stderr cuối giữ lại để chẩn đoán khi process lỗi. */
const STDERR_TAIL_LIMIT = 4096;

/** Giới hạn stdout một turn (byte) — chống CLI chạy loạn làm tràn bộ nhớ. */
const STDOUT_LIMIT_BYTES = 16 * 1024 * 1024;

export interface OneShotCliProviderIdentity {
  /** Provider id (vd 'aider'). */
  providerId: string;
  /** Model id duy nhất của provider (placeholder — CLI dùng model của nó). */
  modelId: string;
  /** Tên hiển thị trong log/lỗi (vd 'Aider'). */
  displayName: string;
}

export interface OneShotCliProviderOptions {
  /** Đường dẫn tuyệt đối tới binary CLI (do detector tìm thấy). Bắt buộc. */
  binaryPath: string;
  /**
   * argv cho MỘT turn (KHÔNG chứa binary). Nhận prompt đầy đủ đã
   * render (system + toàn bộ history, xem `renderOneShotPrompt`).
   * Bắt buộc — driver riêng khai báo cờ non-interactive của CLI đó.
   */
  buildArgs: (prompt: string) => string[];
  /** Thư mục làm việc cho process CLI (mặc định process.cwd()). */
  cwd?: string;
  /** Timeout một turn (ms); mặc định 5 phút. */
  timeoutMs?: number;
  /** Biến env riêng của CLI được phép truyền thêm (chỉ tên biến đã xét — KHÔNG bao giờ là secret của provider khác). */
  extraEnvAllowed?: string[];
  /** Callback nhận event chuẩn của CLI (text/result/error). */
  onCliEvent?: (event: CliEvent) => void;
  /** M5 — sink event của harness (bus + NDJSON log). */
  harnessSink?: (event: CliEvent) => void;
  /** Nơi ghi cảnh báo. */
  logger?: { warn(message: string): void };
  /** Hàm spawn (mặc định spawnCli thật; test inject fake). */
  spawn?: (
    binary: string,
    args: string[],
    options: { cwd?: string; env: NodeJS.ProcessEnv },
  ) => ChildProcessWithoutNullStreams;
  /**
   * Cách xử lý stdin của process con:
   * - `'close'` (mặc định): đóng stdin ngay sau spawn — CLI không
   *   cần nhập gì thêm.
   * - `'keep-open'`: giữ stdin mở suốt turn — chỉ dùng khi CLI hiểu
   *   EOF trên stdin là "yes" cho prompt xác nhận (Aider, xem
   *   AgenticBench AID-1 2026-10-26: `< /dev/null` khiến Aider trả
   *   lời yes cho prompt chạy shell command; `--yes-always` thì từ
   *   chối shell command, nhưng giữ stdin mở vẫn là lớp phòng thủ
   *   thêm).
   */
  stdinBehavior?: 'close' | 'keep-open';
  /**
   * Biến đổi stdout thô thành text + usage (mặc định: strip ANSI +
   * trim; usage bỏ trống). Driver riêng ghi đè để tách usage
   * best-effort từ output của CLI đó.
   */
  parseOutput?: (
    stdout: string,
    stderr: string,
  ) => { text: string; usage?: { inputTokens: number; outputTokens: number } };
  /**
   * True khi driver còn thử nghiệm (giao diện headless của CLI chưa
   * được docs chính thức xác nhận đầy đủ) — chỉ là dấu hiệu để
   * UI/log đọc, không đổi hành vi.
   */
  experimental?: boolean;
}

/**
 * Render toàn bộ hội thoại thành MỘT prompt text cho CLI one-shot:
 * system prompt trước, rồi các message theo thứ tự với nhãn vai trò.
 * CLI one-shot không giữ session nên turn nào cũng gửi lại toàn bộ —
 * đắt hơn session sống nhưng luôn đúng context.
 */
export function renderOneShotPrompt(messages: ChatMessage[]): string {
  const parts: string[] = [];
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  if (system.trim().length > 0) parts.push(system);
  for (const m of messages) {
    if (m.role === 'system') continue;
    const label = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role;
    parts.push(`${label}: ${m.content}`);
  }
  return parts.join('\n\n');
}

/** Bỏ mã ANSI/escape của terminal khỏi output (màu, spinner, …). */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Làm sạch output text mặc định: strip ANSI + trim. */
export function defaultParseOneShotOutput(stdout: string): { text: string } {
  return { text: stripAnsi(stdout) };
}

interface PendingTurn {
  resolve: (res: ProviderResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort: () => void;
  signal?: AbortSignal;
}

export class BaseOneShotCliProvider implements Provider {
  readonly id: string;
  readonly label: string;
  /** Model id duy nhất của provider (placeholder). */
  protected readonly modelId: string;
  /** Tên hiển thị trong log/lỗi. */
  protected readonly displayName: string;
  /** True khi driver còn thử nghiệm (xem OneShotCliProviderOptions). */
  readonly experimental: boolean;
  private readonly binaryPath: string;
  private readonly buildArgs: (prompt: string) => string[];
  private readonly cwd?: string;
  private readonly timeoutMs: number;
  private readonly extraEnvAllowed: string[];
  private readonly onCliEvent?: (event: CliEvent) => void;
  /** M5 — sink event của harness (bus + NDJSON log), xem options. */
  private harnessSink?: (event: CliEvent) => void;
  private readonly warn: (message: string) => void;
  private readonly spawnFn: NonNullable<OneShotCliProviderOptions['spawn']>;
  private readonly stdinBehavior: 'close' | 'keep-open';
  private readonly parseOutput: NonNullable<OneShotCliProviderOptions['parseOutput']>;

  private child: ChildProcessWithoutNullStreams | null = null;
  private pendingTurn: PendingTurn | null = null;
  private disposed = false;

  constructor(
    config: ProviderConfig,
    identity: OneShotCliProviderIdentity,
    options: OneShotCliProviderOptions,
  ) {
    if (!options || typeof options.binaryPath !== 'string' || options.binaryPath.trim() === '') {
      throw new Error(
        `${identity.displayName}: chưa có đường dẫn binary — bật nguồn ${identity.displayName} trong Settings → Engines để detector tìm thấy binary trước.`,
      );
    }
    if (typeof options.buildArgs !== 'function') {
      throw new Error(
        `${identity.displayName}: chưa cấu hình argv one-shot (buildArgs) — driver cần ít nhất một cờ non-interactive để chạy CLI.`,
      );
    }
    this.id = identity.providerId;
    this.label = config.label || identity.displayName;
    this.modelId = identity.modelId;
    this.displayName = identity.displayName;
    this.experimental = options.experimental ?? false;
    this.binaryPath = options.binaryPath;
    this.buildArgs = options.buildArgs;
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs ?? ONE_SHOT_CLI_DEFAULT_TIMEOUT_MS;
    this.extraEnvAllowed = options.extraEnvAllowed ?? [];
    this.onCliEvent = options.onCliEvent;
    this.harnessSink = options.harnessSink;
    this.warn = options.logger
      ? (message: string) => options.logger?.warn(message)
      : (message: string) => console.warn(`[${identity.displayName}] ${message}`);
    this.spawnFn =
      options.spawn ??
      ((binary, args, spawnOpts) =>
        spawnCli(binary, args, { cwd: spawnOpts.cwd, env: spawnOpts.env }));
    this.stdinBehavior = options.stdinBehavior ?? 'close';
    this.parseOutput = options.parseOutput ?? defaultParseOneShotOutput;
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
        `${this.displayName}: đã có một turn đang chạy — chờ turn đó xong rồi gửi tiếp.`,
      );
    }
    const userMessages = req.messages.filter((m) => m.role === 'user');
    if (userMessages.length === 0) {
      throw new Error(`${this.displayName}: không có user message nào để gửi cho CLI.`);
    }
    const prompt = renderOneShotPrompt(req.messages);
    const args = this.buildArgs(prompt);
    const env = sanitizeEnvForCli(process.env, this.extraEnvAllowed);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnFn(this.binaryPath, args, { cwd: this.cwd, env });
    } catch (err) {
      throw new Error(
        `${this.displayName}: không spawn được "${this.binaryPath}": ${(err as Error).message}`,
      );
    }
    this.child = child;
    if (this.stdinBehavior === 'close') {
      try {
        child.stdin.end();
      } catch {
        // stdin đã đóng.
      }
    }
    let stdout = '';
    let stdoutBytes = 0;
    let stdoutOverflow = false;
    let stderrTail = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > STDOUT_LIMIT_BYTES) {
        // CLI in quá nhiều: dừng thu thập, báo lỗi ở cuối turn (kill
        // process để không chạy tiếp vô ích).
        if (!stdoutOverflow) {
          stdoutOverflow = true;
          void this.killCurrentProcess();
        }
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-STDERR_TAIL_LIMIT);
    });

    const turn = this.startTurn(req.signal);
    if (!this.pendingTurn) {
      // Signal hủy ngay giữa spawn và bắt đầu turn: turn.promise đã
      // reject — kill process vừa spawn để không chạy mồ côi.
      void this.killCurrentProcess();
      return turn.promise;
    }
    const finish = (err: Error | null, code: number | null, signal: string | null): void => {
      if (this.child === child) this.child = null;
      if (!this.pendingTurn) return;
      if (err) {
        this.failTurn(err);
        return;
      }
      if (stdoutOverflow) {
        this.failTurn(
          new Error(
            `${this.displayName}: CLI in ra quá ${STDOUT_LIMIT_BYTES / 1024 / 1024}MB stdout — process đã bị dừng (nghi CLI chạy loạn / in lặp).`,
          ),
        );
        return;
      }
      if (code !== 0) {
        const tail = stderrTail.trim();
        this.failTurn(
          new Error(
            `${this.displayName}: CLI thoát với mã ${code ?? '?'}${signal ? ` (signal ${signal})` : ''}${tail ? ` — stderr: ${tail.slice(0, 500)}` : ''}.`,
          ),
        );
        return;
      }
      let parsed: { text: string; usage?: { inputTokens: number; outputTokens: number } };
      try {
        parsed = this.parseOutput(stdout, stderrTail);
      } catch (parseErr) {
        this.failTurn(
          new Error(`${this.displayName}: không đọc được output của CLI: ${(parseErr as Error).message}`),
        );
        return;
      }
      if (parsed.text.trim().length === 0) {
        const tail = stderrTail.trim();
        this.failTurn(
          new Error(
            `${this.displayName}: CLI thoát 0 nhưng không in ra text nào${tail ? ` — stderr: ${tail.slice(0, 500)}` : ''}.`,
          ),
        );
        return;
      }
      this.emitEvent({ type: 'text', delta: parsed.text });
      this.emitEvent({
        type: 'result',
        text: parsed.text,
        ...(parsed.usage ? { usage: parsed.usage } : {}),
      });
      this.finishTurn({ text: parsed.text, toolCalls: [], usage: parsed.usage });
    };
    child.on('error', (err: Error) => {
      this.warn(`process ${this.displayName} lỗi spawn: ${err.message}`);
      if (this.child === child) this.child = null;
      finish(new Error(`${this.displayName}: không chạy được "${this.binaryPath}": ${err.message}`), null, null);
    });
    child.on('exit', (code: number | null, signal: string | null) => {
      finish(null, code, signal);
    });
    return turn.promise;
  }

  /**
   * Dừng provider (gọi khi bot bị xoá / app shutdown). Không có
   * process sống giữa các turn nên chủ yếu đánh dấu disposed + kill
   * turn đang chạy (nếu có). Best-effort: không throw.
   */
  async dispose(): Promise<void> {
    if (this.disposed && !this.child) return;
    this.disposed = true;
    if (this.pendingTurn) {
      const err = new Error(`${this.displayName}: đã hủy turn khi đang chạy (provider dispose).`);
      err.name = 'AbortError';
      this.failTurn(err);
    }
    await this.killCurrentProcess();
  }

  /** Alias của dispose(). */
  async close(): Promise<void> {
    await this.dispose();
  }

  // ------------------------------------------------------------------
  // Turn handling (timeout / abort — như driver Claude M1)
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
    if (!child) return;
    this.child = null;
    try {
      child.stdin.end();
    } catch {
      // stdin đã đóng.
    }
    await killProcessGroup(child, { logger: { warn: this.warn } });
  }

  /** Kết thúc turn đang chờ với lỗi (dọn timer + listener, reject đúng 1 lần). */
  private failTurn(err: Error): void {
    const turn = this.pendingTurn;
    if (!turn) return;
    this.pendingTurn = null;
    clearTimeout(turn.timer);
    turn.signal?.removeEventListener('abort', turn.onAbort);
    this.emitEvent({ type: 'error', message: err.message });
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

  /** Event chảy cả về callback cũ lẫn harness sink (lỗi sink không hỏng turn). */
  private emitEvent(event: CliEvent): void {
    try {
      this.onCliEvent?.(event);
    } catch {
      // Callback của caller lỗi không được làm hỏng turn.
    }
    try {
      this.harnessSink?.(event);
    } catch {
      // Sink lỗi không được làm hỏng turn.
    }
  }

  /** True khi process CLI của turn hiện tại đang sống (để test + chẩn đoán). */
  get isProcessAlive(): boolean {
    return this.child !== null;
  }

  /** M5 — PID process CLI (undefined khi không có turn đang chạy; harness registry đọc lười). */
  get cliPid(): number | undefined {
    return this.child?.pid;
  }

  /** M5 — gắn sink event của harness sau khi tạo provider. */
  attachHarnessSink(sink: (event: CliEvent) => void): void {
    this.harnessSink = sink;
  }
}
