/**
 * Plugin sandbox out-of-process (v0.14, item 1).
 *
 * Plugin trước đây chạy IN-PROCESS trong tiến trình coordinator (xem
 * HONEST LIMIT trong types.ts): một plugin treo, crash hay rò rỉ bộ nhớ
 * đều kéo theo cả agent. `SandboxedPluginHost` khắc phục bằng cách fork
 * một process con chạy `sandboxWorker.ts` — plugin chỉ chạy trong process
 * con đó, coordinator chỉ nói chuyện qua IPC JSON.
 *
 * Hành vi khi có sự cố (đều báo lỗi rõ ràng bằng tiếng Việt, host không
 * bao giờ crash theo plugin):
 *   - Một lần gọi tool quá `callTimeoutMs` (mặc định 30s): child bị
 *     SIGKILL, lần gọi đó reject với lỗi timeout, host tự restart child.
 *     Timeout chỉ tính từ lúc worker đã ready và request đã gửi đi —
 *     thời gian chờ worker khởi động / restart xong KHÔNG tính vào
 *     budget (v0.72c: trước đây timer chạy từ lúc tạo request nên dưới
 *     tải nặng, worker khởi động chậm > timeout thì call bị reject oan
 *     với lỗi "đã SIGKILL" dù child chưa hề bị kill, và call ngay sau
 *     restart cũng timeout theo dù host restart đúng).
 *   - Child chết đột ngột (crash): host restart tối đa `maxRestarts`
 *     lần (mặc định 3), backoff 200ms / 1s / 3s. Hết lượt thì plugin bị
 *     đánh dấu `dead`: mọi lần gọi sau đều reject với lỗi rõ ràng, host
 *     vẫn sống và các plugin khác không bị ảnh hưởng.
 *   - stderr của child được capture (tối đa 100KB) và đẩy qua callback
 *     `onChildStderr` để host log / hiển thị.
 *
 * Giới hạn bộ nhớ: child được fork với
 * `--max-old-space-size=<maxOldSpaceMb>` (mặc định 512MB).
 *
 * Host này chỉ tải MỘT plugin dir; PluginManager nối nó vào registry
 * qua `loadSandboxed()` / `scanDirSandboxed()` (xem manager.ts) —
 * `listToolDefinitions()` trả full definition để dựng Tool mà không cần
 * load plugin in-process.
 */
import { fork, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolDefinition } from '@open-bot/core';
import type { PluginManifest } from './types';
import { readManifest } from './loader';
import { safeEnv } from '../sandbox';
import { killProcessGroupOfChild } from '../killProcessGroup';
import type { SandboxedToolInfo } from './sandboxWorker';

export type { SandboxedToolInfo } from './sandboxWorker';

export const DEFAULT_SANDBOX_MAX_OLD_SPACE_MB = 512;
export const DEFAULT_SANDBOX_CALL_TIMEOUT_MS = 30_000;
export const DEFAULT_SANDBOX_MAX_RESTARTS = 3;
/**
 * v0.72c: trần chờ worker sẵn sàng (khởi động lần đầu / restart sau
 * crash). Một worker sống nhưng không bao giờ gửi ready (vd: plugin treo
 * lúc tải) thì `waitReady()` chờ mãi — trần này chặn call treo vĩnh viễn
 * mà vẫn đủ rộng cho cả chu trình restart (backoff 200ms/1s/3s + spawn
 * dưới tải nặng). Vượt trần thì call reject với lỗi riêng, không phải
 * lỗi timeout giả mạo SIGKILL.
 */
export const SANDBOX_READY_WAIT_TIMEOUT_MS = 30_000;
/** Giới hạn stderr capture của child (ký tự). */
export const MAX_SANDBOX_STDERR_CHARS = 100 * 1024;

/** Backoff giữa các lần restart: lần 1 sau 200ms, lần 2 sau 1s, lần 3 sau 3s. */
const RESTART_BACKOFF_MS = [200, 1_000, 3_000];

/**
 * Parse `definitions` từ worker (kẻ tấn công không gửi được gì tới đây —
 * worker là code của mình — nhưng dữ liệu IPC vẫn được kiểm tra shape
 * trước khi dùng làm ToolDefinition cho registry).
 */
function parseToolDefinitions(raw: unknown): SandboxedToolInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: SandboxedToolInfo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const def = (item as { definition?: unknown }).definition as
      | ToolDefinition
      | undefined;
    const needsApproval = (item as { needsApproval?: unknown }).needsApproval;
    if (!def || typeof def !== 'object' || typeof def.name !== 'string' || !def.name) {
      continue;
    }
    out.push({ definition: def, needsApproval: needsApproval === true });
  }
  return out;
}

export type SandboxedPluginStatus = 'running' | 'restarting' | 'dead';

export interface SandboxedPluginHostOptions {
  /** Thư mục plugin (chứa manifest.json + entry file). */
  pluginDir: string;
  /** Manifest (nếu đã có sẵn); nếu không, host tự đọc manifest.json. */
  manifest?: PluginManifest;
  /** Giới hạn heap của process con, MB. Mặc định 512. */
  maxOldSpaceMb?: number;
  /** Timeout cho mỗi lần gọi tool, ms. Mặc định 30_000. */
  callTimeoutMs?: number;
  /** Số lần restart tối đa sau khi child chết. Mặc định 3. */
  maxRestarts?: number;
  /** Nhận từng chunk stderr của process con (để log / hiển thị). */
  onChildStderr?: (chunk: string) => void;
}

export interface SandboxedPluginHostStatus {
  status: SandboxedPluginStatus;
  /** Số lần đã restart (tối đa maxRestarts). */
  restarts: number;
  /** PID của process con, undefined khi đã dead/dispose. */
  pid: number | undefined;
  pluginId: string;
  maxOldSpaceMb: number;
  /** Giới hạn heap V8 thực tế của child (MB), theo worker báo về. */
  heapSizeLimitMb: number | undefined;
  /** Số ký tự stderr đã capture (tối đa 100KB). */
  stderrChars: number;
  /** Tên các tool plugin expose (rỗng khi chưa tải xong). */
  tools: string[];
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

type HostMessage = {
  id?: unknown;
  ok?: unknown;
  result?: unknown;
  error?: { message?: unknown };
};

export class SandboxedPluginHost {
  readonly pluginDir: string;
  readonly pluginId: string;
  readonly maxOldSpaceMb: number;
  readonly callTimeoutMs: number;
  readonly maxRestarts: number;
  private readonly onChildStderr?: (chunk: string) => void;

  private child: ChildProcess | null = null;
  private status: SandboxedPluginStatus = 'running';
  private ready = false;
  private restarts = 0;
  private disposed = false;
  private restartTimer: NodeJS.Timeout | undefined;
  private nextId = 0;
  private readonly pending = new Map<string, PendingCall>();
  private readonly stateWaiters: Array<() => void> = [];
  private stderrBuffer = '';
  private heapSizeLimitMb: number | undefined;
  private toolNames: string[] = [];
  /** Full tool definitions từ worker (v0.14 integration) — để manager
   *  dựng lại Tool cho registry mà không load plugin in-process. */
  private toolDefinitions: SandboxedToolInfo[] = [];

  constructor(options: SandboxedPluginHostOptions) {
    const dir = path.resolve(options.pluginDir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`Không tìm thấy thư mục plugin: "${options.pluginDir}".`);
    }
    this.pluginDir = dir;
    this.maxOldSpaceMb = options.maxOldSpaceMb ?? DEFAULT_SANDBOX_MAX_OLD_SPACE_MB;
    if (!Number.isFinite(this.maxOldSpaceMb) || this.maxOldSpaceMb <= 0) {
      throw new Error(
        `maxOldSpaceMb phải là số dương (MB), nhận được: ${String(options.maxOldSpaceMb)}.`,
      );
    }
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_SANDBOX_CALL_TIMEOUT_MS;
    if (!Number.isFinite(this.callTimeoutMs) || this.callTimeoutMs <= 0) {
      throw new Error(
        `callTimeoutMs phải là số dương (ms), nhận được: ${String(options.callTimeoutMs)}.`,
      );
    }
    this.maxRestarts = options.maxRestarts ?? DEFAULT_SANDBOX_MAX_RESTARTS;
    if (!Number.isInteger(this.maxRestarts) || this.maxRestarts < 0) {
      throw new Error(
        `maxRestarts phải là số nguyên >= 0, nhận được: ${String(options.maxRestarts)}.`,
      );
    }
    this.onChildStderr = options.onChildStderr;

    if (options.manifest !== undefined) {
      this.pluginId = options.manifest.id;
    } else {
      try {
        this.pluginId = readManifest(dir).id;
      } catch {
        this.pluginId = path.basename(dir);
      }
    }
    this.spawn();
  }

  /** True khi dispose() đã được gọi. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Trạng thái hiện tại của host + process con. */
  getStatus(): SandboxedPluginHostStatus {
    return {
      status: this.disposed ? 'dead' : this.status,
      restarts: this.restarts,
      pid: this.child?.pid,
      pluginId: this.pluginId,
      maxOldSpaceMb: this.maxOldSpaceMb,
      heapSizeLimitMb: this.heapSizeLimitMb,
      stderrChars: this.stderrBuffer.length,
      tools: [...this.toolNames],
    };
  }

  /** Toàn bộ stderr đã capture từ process con (tối đa 100KB). */
  getStderrLog(): string {
    return this.stderrBuffer;
  }

  /**
   * Full tool definitions của plugin (kèm needsApproval), lấy từ worker.
   * Chờ worker ready rồi trả bản cache từ `__ready__` / `listTools` —
   * manager dùng nó để dựng Tool cho registry mà không cần load plugin
   * in-process. Trả [] khi plugin không có tool nào.
   */
  async listToolDefinitions(): Promise<SandboxedToolInfo[]> {
    await this.waitReady();
    if (this.toolDefinitions.length > 0) return [...this.toolDefinitions];
    const out = (await this.request('listTools', {})) as {
      tools?: unknown;
      definitions?: unknown;
    };
    const defs = parseToolDefinitions(out?.definitions);
    if (defs.length > 0) this.toolDefinitions = defs;
    return [...this.toolDefinitions];
  }

  /** Gọi một tool của plugin trong process con. Trả về chuỗi kết quả. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const out = await this.request('callTool', { tool: name, args });
    return typeof out === 'string' ? out : String(out ?? '');
  }

  /** Kiểm tra worker còn sống và trả lời IPC không. */
  async ping(): Promise<{ pong: boolean }> {
    const out = (await this.request('ping', {})) as { pong?: boolean };
    return { pong: out?.pong === true };
  }

  /**
   * Dừng host: kill process con (SIGKILL), chờ nó thoát thật (tối đa
   * 2s), hủy restart đang chờ, reject mọi lần gọi đang chờ. An toàn khi
   * gọi nhiều lần.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.failAllPending(
      new Error(`Plugin sandbox "${this.pluginId}" đã bị dispose — không gọi tool được nữa.`),
    );
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (child !== null) {
      // Chờ child thoát thật để dispose() trả về là child đã chết.
      const exited =
        child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 2000);
              timer.unref?.();
              child.once('exit', () => {
                clearTimeout(timer);
                resolve();
              });
            });
      this.killChild(child);
      await exited;
      try {
        child.removeAllListeners();
      } catch {
        // Listener đã dọn — bỏ qua.
      }
    }
    this.notifyStateChange();
  }

  // ------------------------------------------------------------ internals

  private deadError(): Error {
    return new Error(
      `Plugin "${this.pluginId}" đã chết sau ${this.maxRestarts} lần khởi động lại ` +
        `và sẽ không chạy nữa. Gỡ plugin hoặc khởi động lại ứng dụng để thử lại.`,
    );
  }

  private notifyStateChange(): void {
    const waiters = [...this.stateWaiters];
    this.stateWaiters.length = 0;
    for (const resolve of waiters) resolve();
  }

  private waitStateChange(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.stateWaiters.push(resolve);
    });
  }

  /** Chờ worker sẵn sàng (đã tải plugin). Trong lúc restart thì chờ
   *  lượt restart; khi plugin dead/dispose thì throw lỗi rõ ràng. */
  private async waitReady(): Promise<void> {
    for (;;) {
      if (this.disposed) {
        throw new Error(
          `Plugin sandbox "${this.pluginId}" đã bị dispose — không gọi tool được nữa.`,
        );
      }
      if (this.status === 'dead') throw this.deadError();
      if (this.ready && this.child !== null) return;
      await this.waitStateChange();
    }
  }

  /**
   * v0.72c: `waitReady()` có trần — worker sống nhưng không bao giờ gửi
   * ready (plugin treo lúc tải) thì call reject sau
   * `SANDBOX_READY_WAIT_TIMEOUT_MS` thay vì treo vĩnh viễn. Chu trình
   * restart có trần riêng (hết lượt restart thì status thành 'dead' và
   * `waitReady()` tự throw), nên trần này chỉ chặn trường hợp bệnh lý.
   */
  private async waitReadyBounded(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.waitReady(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `Plugin "${this.pluginId}" chưa sẵn sàng sau ` +
                  `${SANDBOX_READY_WAIT_TIMEOUT_MS}ms — worker không trả lời ` +
                  `(đang khởi động/restart quá lâu hoặc plugin treo lúc tải).`,
              ),
            );
          }, SANDBOX_READY_WAIT_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private spawn(): void {
    if (this.disposed) return;
    this.ready = false;
    this.status = 'running';
    const workerPath = path.join(__dirname, 'sandboxWorker.js');
    let child: ChildProcess;
    try {
      // v0.15 (H1 audit): worker KHÔNG kế thừa toàn bộ process.env của app
      // (trong đó có thể có API key / token) — chỉ nhận env đã lọc qua
      // safeEnv() (allowlist, chặn mọi tên trông như secret). Đây là rào
      // chắn, không phải biên an ninh: plugin vẫn chạy cùng UID và đọc
      // được file trên đĩa — chỉ cài plugin từ nguồn đáng tin.
      child = fork(workerPath, [this.pluginDir], {
        silent: true,
        env: safeEnv(),
        execArgv: [`--max-old-space-size=${this.maxOldSpaceMb}`],
        // Own process group on POSIX (như daemon) để killChild diệt
        // được cả cây tiến trình của worker — trước đây worker fork
        // không detached nên kill(-pid) lỗi ESRCH, chỉ worker trực
        // tiếp chết còn tiến trình cháu của plugin sống sót (finding
        // M3, audit v0.15). Trên Windows không cần detached:
        // killProcessGroupOfChild dùng taskkill /T /F diệt cả cây.
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      // Fork thất bại (hiếm): xử lý như child chết để đi vào restart.
      this.onChildGone(
        null,
        `Không fork được plugin worker cho "${this.pluginId}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    this.child = child;

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => this.onChildStderrData(chunk));
    child.on('message', (msg: unknown) => this.onChildMessage(msg));
    child.on('error', () => {
      // Lỗi spawn (vd: worker file thiếu): đi vào đường restart như crash.
      if (this.child === child) this.onChildGone(child, 'Plugin worker lỗi khởi động.');
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.child === child) {
        this.onChildGone(
          child,
          `Plugin "${this.pluginId}" dừng đột ngột (code=${String(code)}, ` +
            `signal=${String(signal)}).`,
        );
      }
    });

    // Worker tải plugin từ argv; gửi thêm init để chắc chắn (worker trả
    // lời ok nếu đã tải rồi, hoặc tải ở đây nếu chạy không có argv).
    try {
      child.send({ id: '__init__', method: 'init', pluginDir: this.pluginDir });
    } catch {
      // Kênh IPC chưa mở / đã đóng — 'exit'/'error' sẽ xử lý tiếp.
    }
    this.notifyStateChange();
  }

  private onChildStderrData(chunk: string): void {
    if (this.stderrBuffer.length < MAX_SANDBOX_STDERR_CHARS) {
      const room = MAX_SANDBOX_STDERR_CHARS - this.stderrBuffer.length;
      this.stderrBuffer += chunk.slice(0, room);
    }
    try {
      this.onChildStderr?.(chunk);
    } catch {
      // Callback log của host lỗi thì không được kéo theo sandbox.
    }
  }

  private onChildMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    const m = msg as HostMessage;
    if (m.id === '__ready__') {
      if (m.ok === true) {
        const result = (m.result ?? {}) as {
          tools?: unknown;
          definitions?: unknown;
          heapSizeLimitMb?: unknown;
        };
        if (Array.isArray(result.tools)) {
          this.toolNames = result.tools.filter((t): t is string => typeof t === 'string');
        }
        this.toolDefinitions = parseToolDefinitions(result.definitions);
        if (typeof result.heapSizeLimitMb === 'number') {
          this.heapSizeLimitMb = result.heapSizeLimitMb;
        }
        this.ready = true;
        this.notifyStateChange();
      } else {
        // Plugin tải thất bại: worker sẽ tự thoát (code 1) và onChildGone
        // lo phần restart/dead. Đánh dấu chưa ready để call mới phải chờ.
        const message =
          typeof m.error?.message === 'string'
            ? m.error.message
            : `Không tải được plugin "${this.pluginId}".`;
        this.ready = false;
        this.failAllPending(new Error(message));
        this.notifyStateChange();
      }
      return;
    }
    if (typeof m.id !== 'string' || m.id === '') return;
    const pending = this.pending.get(m.id);
    if (pending === undefined) return; // init reply / message cũ — bỏ qua.
    this.pending.delete(m.id);
    if (m.ok === true) {
      pending.resolve(m.result);
    } else {
      const message =
        typeof m.error?.message === 'string'
          ? m.error.message
          : `Plugin "${this.pluginId}" trả lỗi không rõ nội dung.`;
      pending.reject(new Error(message));
    }
  }

  /** Child đã mất (crash / bị kill / fork lỗi). Reject các call đang chờ
   *  rồi restart (backoff) hoặc đánh dấu dead khi hết lượt. */
  private onChildGone(child: ChildProcess | null, reason: string): void {
    if (this.disposed) return;
    if (child !== null && this.child === child) this.child = null;
    this.ready = false;
    if (this.restarts < this.maxRestarts) {
      const delay = RESTART_BACKOFF_MS[Math.min(this.restarts, RESTART_BACKOFF_MS.length - 1)]!;
      this.restarts += 1;
      this.status = 'restarting';
      this.failAllPending(
        new Error(`${reason} Đang khởi động lại plugin (lần ${this.restarts}/${this.maxRestarts}).`),
      );
      this.notifyStateChange();
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        this.spawn();
      }, delay);
      this.restartTimer.unref?.();
    } else {
      this.status = 'dead';
      this.failAllPending(new Error(`${reason} ${this.deadError().message}`));
      this.notifyStateChange();
    }
  }

  /** Kill worker KÈM cả cây tiến trình con/cháu của nó (finding M3):
   *  `killProcessGroupOfChild` kill cả process group trên POSIX
   *  (worker đã fork detached nên là group leader) và dùng
   *  `taskkill /T /F` trên Windows; fallback `child.kill` khi group
   *  kill thất bại (vd: worker đã chết). Không bao giờ ném lỗi. */
  private killChild(child: ChildProcess): void {
    try {
      if (killProcessGroupOfChild(child)) return;
      child.kill('SIGKILL');
    } catch {
      // Child đã chết rồi — bỏ qua.
    }
  }

  private failAllPending(err: Error): void {
    for (const [, pending] of [...this.pending]) {
      pending.reject(err);
    }
    this.pending.clear();
  }

  /**
   * Một round-trip IPC: chờ worker ready, gửi request, chờ response.
   * Hết `callTimeoutMs` thì SIGKILL child (để host restart) và reject
   * với lỗi timeout tiếng Việt.
   *
   * v0.72c: timer timeout chỉ bắt đầu chạy SAU khi worker đã ready và
   * request đã gửi đi — thời gian chờ worker khởi động / restart xong
   * không tính vào budget của call (chờ ready có trần riêng qua
   * `waitReadyBounded`). Trước đây timer chạy từ lúc tạo request nên
   * worker khởi động chậm hơn timeout thì call bị reject oan với lỗi
   * "đã SIGKILL" dù child chưa hề bị kill, và call ngay sau restart
   * cũng timeout theo dù host restart đúng.
   */
  private request(
    method: 'callTool' | 'ping' | 'listTools',
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    const id = `req-${++this.nextId}`;
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const startResponseTimer = (): void => {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          this.pending.delete(id);
          // Lúc này request đang bay tới một worker đã ready nên child
          // chắc chắn tồn tại: kill thật rồi mới báo lỗi SIGKILL.
          if (this.ready && this.child !== null) {
            this.killChild(this.child);
            // Đánh dấu chưa ready NGAY (đừng chờ event 'exit'): nếu không,
            // một call tới ngay sau đó sẽ đăng ký vào child đang chết và
            // nhận lỗi crash thay vì chờ restart xong rồi chạy.
            this.ready = false;
            this.notifyStateChange();
          }
          reject(
            new Error(
              `Plugin "${this.pluginId}" gọi ${method === 'callTool' ? `tool "${String(payload['tool'] ?? '')}"` : 'ping'} ` +
                `quá thời gian ${this.callTimeoutMs}ms — tiến trình plugin đã bị dừng (SIGKILL) ` +
                `và sẽ tự khởi động lại.`,
            ),
          );
        }, this.callTimeoutMs);
        timer.unref?.();
      };

      const settleOk = (value: unknown): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(value);
      };
      const settleErr = (err: Error): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        reject(err);
      };

      void this.waitReadyBounded()
        .then(() => {
          if (settled) return;
          if (this.disposed) {
            settleErr(
              new Error(
                `Plugin sandbox "${this.pluginId}" đã bị dispose — không gọi tool được nữa.`,
              ),
            );
            return;
          }
          const child = this.child;
          if (child === null || this.status === 'dead') {
            settleErr(this.deadError());
            return;
          }
          this.pending.set(id, { resolve: settleOk, reject: settleErr });
          try {
            child.send({ id, method, ...payload });
          } catch (err) {
            this.pending.delete(id);
            settleErr(
              new Error(
                `Không gửi được yêu cầu tới plugin "${this.pluginId}": ${
                  err instanceof Error ? err.message : String(err)
                }`,
              ),
            );
            return;
          }
          // Request đã bay tới worker ready: bắt đầu tính timeout từ đây.
          startResponseTimer();
        })
        .catch(settleErr);
    });
  }
}

/**
 * Tạo một `SandboxedPluginHost` cho một thư mục plugin. Host fork process
 * con ngay khi tạo; dùng `getStatus()` để xem worker đã ready chưa và
 * `dispose()` để dọn dẹp khi không dùng nữa.
 */
export function createSandboxedPluginHost(
  options: SandboxedPluginHostOptions,
): SandboxedPluginHost {
  return new SandboxedPluginHost(options);
}
