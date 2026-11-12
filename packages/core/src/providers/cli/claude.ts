/**
 * Claude Code CLI provider (M1) — driver CLI đầu tiên của open-bot.
 *
 * Cơ chế (theo OpenMausBot `server/drivers/claude.ts` + docs Anthropic):
 * spawn `claude --output-format stream-json --input-format stream-json
 * --verbose`, prompt qua stdin dạng NDJSON, MỘT process sống cho mỗi
 * provider instance (coordinator giữ một provider cho mỗi bot nên đây
 * cũng là một process mỗi thread/bot), đọc NDJSON về event chuẩn.
 *
 * QUYẾT ĐỊNH THIẾT KẾ M1 (đọc kỹ — khác provider API-key):
 * - **CLI sở hữu vòng tool của nó.** Claude Code tự chạy tool của nó
 *   (đọc/ghi file, shell…) theo `--permission-mode default` (hỏi duyệt
 *   khi cần — nhưng M1 chưa có kênh trả lời permission request của CLI,
 *   xem giới hạn dưới). Vì vậy `chat()` trả `toolCalls: []`: open-bot
 *   KHÔNG thực thi lại tool call của CLI qua ToolRegistry (thực thi lại
 *   sẽ chạy trùng tác vụ CLI đã làm). Tool call của CLI chỉ được surface
 *   qua event `tool_call` (callback `onCliEvent`, để log/UI) chứ không
 *   đi vào vòng lặp agent của open-bot.
 * - **Chỉ gửi message mới.** Process giữ context của thread nên mỗi
 *   `chat()` chỉ gửi các user message CHƯA gửi (delta). Nếu history bị
 *   viết lại (compaction) hoặc system prompt đổi thì restart process và
 *   gửi lại toàn bộ — fail-safe, không bao giờ gửi trùng context.
 * - **System prompt** đi qua `--append-system-prompt` lúc spawn (bot
 *   nào system prompt nấy; đổi system prompt thì restart process).
 * - **Abort/timeout/process chết = kill cả process group** rồi reject
 *   rõ ràng; lần `chat()` sau spawn lại từ đầu và gửi lại toàn bộ
 *   history (CLI không còn giữ session cũ).
 * - **Env tối thiểu** (xem env.ts): chỉ allowlist + `CLAUDE_CODE_OAUTH_TOKEN`.
 *
 * GIỚI HẠN CHƯA KIỂM CHỨNG (xem providers/cli/README.md):
 * - Chưa chạy trên máy thật có Claude Code đăng nhập: shape stream-json
 *   thật, hành vi `--permission-mode default` khi tool cần duyệt trong
 *   chế độ headless, và `--append-system-prompt` đều chưa được kiểm
 *   chứng — cần máy thật trước khi coi M1 là xong.
 * - Permission request của CLI trong turn (hỏi duyệt tool) M1 chưa trả
 *   lời được: turn sẽ treo tới timeout rồi bị kill. Đây là follow-up
 *   (permission broker, mốc M5).
 * - Không hỗ trợ `--resume`/fork-session (keep-warm) ở M1.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { throwIfAborted } from '../abort';
import type {
  ChatCompletionRequest,
  ChatMessage,
  Provider,
  ProviderConfig,
  ProviderResponse,
  ToolCall,
} from '../../types';
import { sanitizeEnvForCli } from './env';
import { killProcessGroup, spawnCli } from './process';
import { CLAUDE_STREAM_JSON_ARGS, NdjsonEventParser, toClaudeInputLine } from './claudeStream';
import type { CliEvent } from './types';
import { CLAUDE_CODE_MODEL_ID, CLAUDE_CODE_PROVIDER_ID } from './types';

/** Timeout mặc định cho một turn qua CLI (ms). */
export const CLAUDE_CLI_DEFAULT_TIMEOUT_MS = 300_000;

/** Số ký tự stderr cuối giữ lại để chẩn đoán khi process chết. */
const STDERR_TAIL_LIMIT = 4096;

export interface ClaudeCodeCliProviderOptions {
  /** Đường dẫn tuyệt đối tới binary `claude` (do detector tìm thấy). Bắt buộc. */
  binaryPath: string;
  /** Thư mục làm việc cho process CLI (mặc định process.cwd()). */
  cwd?: string;
  /** Timeout một turn (ms); mặc định 5 phút. */
  timeoutMs?: number;
  /** Biến env auth riêng của CLI được phép truyền thêm (mặc định CLAUDE_CODE_OAUTH_TOKEN). */
  extraEnvAllowed?: string[];
  /** Callback nhận event chuẩn của CLI (text/tool_call/result/error) — để log/UI. */
  onCliEvent?: (event: CliEvent) => void;
  /**
   * M5 — sink event của harness: driver gọi song song với onCliEvent
   * (bus + NDJSON log). Gắn sau khi tạo provider bằng
   * `attachHarnessSink()` cũng được; sink lỗi không làm hỏng turn.
   */
  harnessSink?: (event: CliEvent) => void;
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
  textParts: string[];
  toolCalls: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
  sessionId?: string;
  timer: ReturnType<typeof setTimeout>;
  onAbort: () => void;
  signal?: AbortSignal;
  /**
   * Số result event cần chờ trong turn này = số user message đã gửi.
   * Giả định (CHƯA kiểm chứng trên CLI thật): mỗi user message trên
   * stdin nhận một result event riêng. Turn chỉ resolve khi đã nhận đủ
   * result của message CUỐI cùng — nếu resolve ở result đầu tiên thì
   * turn resend history sẽ trả nhầm đáp án của message cũ (đã bắt được
   * bằng test fake-claude). Nếu CLI thật gộp nhiều message thành một
   * result thì turn restart sẽ treo tới timeout — xem README.
   */
  resultsExpected: number;
  resultsSeen: number;
}

export class ClaudeCodeCliProvider implements Provider {
  readonly id = CLAUDE_CODE_PROVIDER_ID;
  readonly label: string;
  private readonly binaryPath: string;
  private readonly cwd?: string;
  private readonly timeoutMs: number;
  private readonly extraEnvAllowed: string[];
  private readonly onCliEvent?: (event: CliEvent) => void;
  /** M5 — sink event của harness (bus + NDJSON log), xem options. */
  private harnessSink?: (event: CliEvent) => void;
  private readonly warn: (message: string) => void;
  private readonly spawnFn: NonNullable<ClaudeCodeCliProviderOptions['spawn']>;

  private child: ChildProcessWithoutNullStreams | null = null;
  /** Nội dung các user message đã gửi vào process đang sống (để tính delta). */
  private sentUserMessages: string[] = [];
  /** System prompt đã dùng lúc spawn process đang sống. */
  private spawnSystemText: string | null = null;
  private sessionId?: string;
  private stderrTail = '';
  private pendingTurn: PendingTurn | null = null;
  private disposed = false;

  constructor(config: ProviderConfig, options: ClaudeCodeCliProviderOptions) {
    if (!options || typeof options.binaryPath !== 'string' || options.binaryPath.trim() === '') {
      throw new Error(
        'Claude Code (CLI): chưa có đường dẫn binary — bật nguồn Claude Code trong Settings → Engines để detector tìm thấy `claude` trước.',
      );
    }
    this.label = config.label || 'Claude Code (CLI)';
    this.binaryPath = options.binaryPath;
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs ?? CLAUDE_CLI_DEFAULT_TIMEOUT_MS;
    this.extraEnvAllowed = options.extraEnvAllowed ?? ['CLAUDE_CODE_OAUTH_TOKEN'];
    this.onCliEvent = options.onCliEvent;
    this.harnessSink = options.harnessSink;
    this.warn = options.logger
      ? (message: string) => options.logger?.warn(message)
      : (message: string) => console.warn(`[ClaudeCodeCli] ${message}`);
    this.spawnFn =
      options.spawn ??
      ((binary, args, spawnOpts) =>
        spawnCli(binary, args, { cwd: spawnOpts.cwd, env: spawnOpts.env }));
  }

  // ------------------------------------------------------------------
  // Provider interface
  // ------------------------------------------------------------------

  async listModels(): Promise<string[]> {
    // CLI dùng model đã cấu hình sẵn của nó; open-bot không liệt kê
    // được model từ CLI ở M1 — model duy nhất là 'claude-code'.
    return [CLAUDE_CODE_MODEL_ID];
  }

  async chat(req: ChatCompletionRequest): Promise<ProviderResponse> {
    throwIfAborted(req.signal);
    if (this.disposed) {
      throw new Error('Claude Code (CLI): provider đã dispose, không chạy thêm turn được.');
    }
    if (this.pendingTurn) {
      throw new Error(
        'Claude Code (CLI): đã có một turn đang chạy trên process này — chờ turn đó xong rồi gửi tiếp.',
      );
    }
    const userMessages = userMessagesOf(req.messages);
    if (userMessages.length === 0) {
      throw new Error('Claude Code (CLI): không có user message nào để gửi cho CLI.');
    }
    const systemText = systemTextOf(req.messages);
    await this.ensureProcess(systemText, userMessages);
    const newMessages = userMessages.slice(this.sentUserMessages.length);
    if (newMessages.length === 0) {
      // Không có user message mới (vd loop gọi lại chỉ với tool result
      // của open-bot) — CLI không có gì mới để làm; báo rõ thay vì
      // gửi trùng history.
      throw new Error(
        'Claude Code (CLI): không có user message mới so với turn trước — CLI đã thấy toàn bộ history này.',
      );
    }
    if (!this.child) {
      throw new Error('Claude Code (CLI): process chưa sẵn sàng sau khi spawn.');
    }
    const turn = this.startTurn(req.signal, newMessages.length);
    try {
      for (const text of newMessages) {
        await this.writeStdin(toClaudeInputLine(text));
      }
      this.sentUserMessages = [...userMessages];
    } catch (err) {
      this.failTurn(err as Error);
      throw err;
    }
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
      const err = new Error('Claude Code (CLI): đã hủy turn khi đang chạy (provider dispose).');
      err.name = 'AbortError';
      this.failTurn(err);
    }
    const child = this.child;
    this.child = null;
    this.sentUserMessages = [];
    this.spawnSystemText = null;
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
  // Process lifecycle
  // ------------------------------------------------------------------

  /**
   * Đảm bảo có process sống phù hợp với request: spawn mới khi chưa có,
   * restart khi system prompt đổi hoặc history bị viết lại (compaction),
   * tái dùng khi chỉ có thêm user message mới.
   */
  private async ensureProcess(systemText: string, userMessages: string[]): Promise<void> {
    if (this.child) {
      const systemChanged = this.spawnSystemText !== systemText;
      const historyRewritten =
        userMessages.length < this.sentUserMessages.length ||
        !this.sentUserMessages.every((sent, i) => sent === userMessages[i]);
      if (systemChanged || historyRewritten) {
        await this.restartProcess();
      } else {
        return;
      }
    }
    this.spawnProcess(systemText);
  }

  private async restartProcess(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.sentUserMessages = [];
    this.spawnSystemText = null;
    this.sessionId = undefined;
    if (child) {
      try {
        child.stdin.end();
      } catch {
        // stdin đã đóng.
      }
      await killProcessGroup(child, { logger: { warn: this.warn } });
    }
  }

  private spawnProcess(systemText: string): void {
    const args: string[] = [...CLAUDE_STREAM_JSON_ARGS, '--permission-mode', 'default'];
    if (systemText.trim().length > 0) {
      args.push('--append-system-prompt', systemText);
    }
    const env = sanitizeEnvForCli(process.env, this.extraEnvAllowed);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnFn(this.binaryPath, args, { cwd: this.cwd, env });
    } catch (err) {
      throw new Error(
        `Claude Code (CLI): không spawn được "${this.binaryPath}": ${(err as Error).message}`,
      );
    }
    this.child = child;
    this.spawnSystemText = systemText;
    this.stderrTail = '';
    const parser = new NdjsonEventParser((event) => this.handleCliEvent(event));
    child.stdout.on('data', (chunk: Buffer) => {
      parser.feed(chunk.toString('utf8'));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-STDERR_TAIL_LIMIT);
    });
    child.on('error', (err: Error) => {
      this.warn(`process claude lỗi spawn: ${err.message}`);
      if (this.child === child) {
        this.child = null;
        this.sentUserMessages = [];
        this.spawnSystemText = null;
      }
      if (this.pendingTurn) {
        this.failTurn(
          new Error(`Claude Code (CLI): không chạy được "${this.binaryPath}": ${err.message}`),
        );
      }
    });
    child.on('exit', (code: number | null, signal: string | null) => {
      if (this.child === child) {
        this.child = null;
        this.sentUserMessages = [];
        this.spawnSystemText = null;
      }
      if (this.pendingTurn) {
        const tail = this.stderrTail.trim();
        this.failTurn(
          new Error(
            `Claude Code (CLI): process chết giữa chừng (exit ${code ?? '?'}${
              signal ? `, signal ${signal}` : ''
            })${tail ? ` — stderr: ${tail.slice(0, 500)}` : ''}.`,
          ),
        );
      }
    });
  }

  private writeStdin(line: string): Promise<void> {
    const child = this.child;
    if (!child) return Promise.reject(new Error('Claude Code (CLI): process chưa sẵn sàng.'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      try {
        const ok = child.stdin.write(line, (err) => done(err ?? undefined));
        if (ok) return;
        // Buffer đầy: chờ drain (prompt lớn, vd nội dung @files).
        child.stdin.once('drain', () => done());
        child.stdin.once('error', (err: Error) => done(err));
      } catch (err) {
        done(err as Error);
      }
    });
  }

  // ------------------------------------------------------------------
  // Turn handling
  // ------------------------------------------------------------------

  private startTurn(signal: AbortSignal | undefined, resultsExpected: number): { promise: Promise<ProviderResponse> } {
    let resolveTurn!: (res: ProviderResponse) => void;
    let rejectTurn!: (err: Error) => void;
    const promise = new Promise<ProviderResponse>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    // Tránh unhandled rejection khi failTurn chạy trước khi caller await.
    promise.catch(() => undefined);
    const onAbort = (): void => {
      const err = new Error('Claude Code (CLI): đã hủy turn khi đang chạy.');
      err.name = 'AbortError';
      // Abort = kill cả process group (turn chết, CLI có thể đang giữ
      // tool-call dở); lần chat sau spawn lại và gửi lại history.
      void this.killCurrentProcess();
      this.failTurn(err);
    };
    const timer = setTimeout(() => {
      const err = new Error(
        `Claude Code (CLI): hết thời gian chờ ${this.timeoutMs}ms cho một turn — process đã bị dừng.`,
      );
      void this.killCurrentProcess();
      this.failTurn(err);
    }, this.timeoutMs);
    timer.unref?.();
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        const err = new Error('Claude Code (CLI): đã hủy turn khi đang chạy.');
        err.name = 'AbortError';
        // Không qua failTurn (pendingTurn chưa gán) — reject trực tiếp.
        rejectTurn(err);
        return { promise };
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    this.pendingTurn = {
      resolve: resolveTurn,
      reject: rejectTurn,
      textParts: [],
      toolCalls: [],
      timer,
      onAbort,
      signal,
      resultsExpected: Math.max(1, resultsExpected),
      resultsSeen: 0,
    };
    return { promise };
  }

  private async killCurrentProcess(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.sentUserMessages = [];
    this.spawnSystemText = null;
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

  private handleCliEvent(event: CliEvent): void {
    try {
      this.onCliEvent?.(event);
    } catch {
      // Callback của caller lỗi không được làm hỏng turn.
    }
    // M5: event cũng chảy về harness bus + NDJSON log (song song với
    // callback cũ — API hiện có không đổi). Sink lỗi không hỏng turn.
    try {
      this.harnessSink?.(event);
    } catch {
      // Sink lỗi không được làm hỏng turn.
    }
    const turn = this.pendingTurn;
    if (!turn) return;
    switch (event.type) {
      case 'text':
        turn.textParts.push(event.delta);
        break;
      case 'tool_call':
        // M1: CLI tự chạy tool của nó — chỉ ghi nhận để log/UI, KHÔNG
        // trả vào ProviderResponse.toolCalls (xem comment đầu file).
        turn.toolCalls.push(event.call);
        break;
      case 'result': {
        if (event.sessionId) this.sessionId = event.sessionId;
        if (event.usage) turn.usage = event.usage;
        turn.resultsSeen += 1;
        // Text của message này = result.text, fallback là các delta kể
        // từ result trước (reset sau mỗi result để không lẫn text cũ).
        const text = event.text.length > 0 ? event.text : turn.textParts.join('');
        turn.textParts = [];
        // Chưa đủ result (turn gửi nhiều message, vd resend history
        // sau restart): chờ result của message cuối cùng mới resolve.
        if (turn.resultsSeen < turn.resultsExpected) break;
        this.finishTurn({ text, toolCalls: [], usage: turn.usage });
        break;
      }
      case 'error':
        this.failTurn(new Error(`Claude Code (CLI): ${event.message}`));
        break;
      case 'aborted':
        this.failTurn(Object.assign(new Error('Claude Code (CLI): turn bị hủy.'), { name: 'AbortError' }));
        break;
      default:
        break;
    }
  }

  /** Session id của CLI (nếu stream đã báo) — để debug/log. */
  get claudeSessionId(): string | undefined {
    return this.sessionId;
  }

  /** True khi process CLI đang sống (để test + chẩn đoán). */
  get isProcessAlive(): boolean {
    return this.child !== null;
  }

  /** M5 — PID process CLI (undefined khi chưa spawn; harness registry đọc lười). */
  get cliPid(): number | undefined {
    return this.child?.pid;
  }

  /**
   * M5 — gắn sink event của harness sau khi tạo provider (harness gọi
   * ở `attachToProvider`). Có thể gọi nhiều lần (sink mới ghi đè).
   */
  attachHarnessSink(sink: (event: CliEvent) => void): void {
    this.harnessSink = sink;
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
