/**
 * Bot box — box theo bot, chạy lệnh trong sandbox (M6).
 *
 * Layout trên đĩa (dưới `<root>/boxes/<botId>/`):
 *   box.json            — metadata (không secret)
 *   workspace/          — thư mục làm việc riêng của bot
 *   tmp/                — TMPDIR của box (trong box, không chạm /tmp host)
 *   auth/               — trạng thái đăng nhập đã đồng bộ (0700, xem signin.ts)
 *
 * Chạy lệnh:
 *  - Linux + bwrap: `bwrap --ro-bind /usr /usr --ro-bind /bin /bin
 *    --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /etc /etc
 *    --tmpfs /tmp --bind <workspace> <workspace> --bind <tmp> <tmp>
 *    --chdir <workspace> --unshare-pid --die-with-parent <cmd>...`
 *    (KHÔNG `--unshare-net`: box vẫn cần gọi egress gate trên
 *    loopback; mạng ra ngoài chỉ qua gate — xem gate.ts).
 *  - Linux + unshare: `unshare --user --map-root-user --pid --fork <cmd>...`
 *    (cách ly yếu hơn bwrap: không giam mount; /proc vẫn của host).
 *  - macOS + sandbox-exec: profile Seatbelt cơ bản (xem README).
 *  - Fallback: chạy thường, `isolation.isolated === false` + cảnh báo
 *    rõ trong log và trong `BoxRunResult` — KHÔNG giả vờ đã cách ly.
 *
 * Giới hạn enforce thật (không như session box chỉ ghi metadata):
 *  - timeout: kill process group khi hết giờ.
 *  - maxWriteBytes: poll kích thước workspace mỗi 200ms, kill khi vượt.
 *  - maxOutputChars: cắt stdout/stderr giữ lại.
 *  - maxFiles: kiểm tra sau khi chạy (báo trong result qua
 *    workspaceBytes + log; vượt thì lần chạy bị đánh dấu — xem README).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { buildBoxEnv, commandAvailable, detectIsolation, isolationKindAvailable, validateBoxEnvNames } from './env';
import type {
  AppliedResourceLimits,
  BotBox,
  BotBoxOptions,
  BoxResourceLimits,
  BoxRunResult,
  IsolationInfo,
  IsolationKind,
  ResolvedBoxLimits,
} from './types';

export const BOXES_REL_DIR = 'boxes';

export const DEFAULT_BOX_LIMITS: ResolvedBoxLimits = {
  timeoutMs: 120_000,
  maxWriteBytes: 100 * 1024 * 1024,
  maxOutputChars: 200_000,
  maxFiles: 10_000,
  // Sóng B (máy-tính-bot): undefined = không giới hạn thêm.
  cpuSeconds: undefined,
  maxMemoryBytes: undefined,
  maxProcesses: undefined,
};

/**
 * Bọc argv bằng `prlimit` khi box có giới hạn CPU/RAM/process (sóng B).
 * Chỉ Linux mới enforce được (prlimit là util-linux). Trả về argv đã
 * bọc + thông tin giới hạn đã áp dụng (hay chưa — kèm lý do rõ ràng).
 * prlimit đặt rlimit cho tiến trình nó exec (bwrap/unshare/command) và
 * các tiến trình con thừa hưởng rlimit đó, nên giới hạn áp dụng cho
 * toàn bộ cây tiến trình trong box.
 */
/** Floor cho prlimit --as (không gian địa chỉ ảo — Node cần ≥4GB ảo). */
const MIN_AS_BYTES = 4 * 1024 ** 3;
/**
 * Chờ bao lâu trước khi thử lại backend lỗi setup một lần (sóng B).
 * Lỗi namespace lúc máy tải nặng (vd bwrap "Creating new namespace
 * failed: Resource temporarily unavailable") thường là nhất thời —
 * thử lại sau một nhịp ngắn hay thành công và giữ được cách ly, thay
 * vì rơi ngay xuống chạy thường.
 */
const BACKEND_SETUP_RETRY_DELAY_MS = 300;

/**
 * Sóng B: stderr có phải là LỖI SETUP của backend (tool chưa hề chạy)?
 * Chỉ khớp những dòng đặc trưng do chính backend in ra khi nó không
 * dựng được sandbox — namespace không tạo được, hoặc exec lệnh thất
 * bại (binary lệnh không có trong sandbox). Tool chạy bên trong mà
 * lỗi thì stderr là của tool, không khớp những mẫu này, nên không
 * bao giờ bị chạy lại lần hai (tool có side-effect chỉ chạy một lần).
 */
function backendSetupFailed(stderr: string): boolean {
  return (
    stderr.includes('bwrap: Creating new namespace failed') ||
    stderr.includes('bwrap: execvp ') ||
    /unshare: .*failed/.test(stderr) ||
    stderr.includes('unshare: execvp ')
  );
}

function wrapWithPrlimit(
  argv: string[],
  limits: ResolvedBoxLimits,
  warn: (message: string) => void,
): { argv: string[]; limitsApplied?: AppliedResourceLimits } {
  const cpuSeconds = limits.cpuSeconds;
  const maxMemoryBytes = limits.maxMemoryBytes;
  const maxProcesses = limits.maxProcesses;
  const hasLimits =
    (cpuSeconds !== undefined && cpuSeconds > 0) ||
    (maxMemoryBytes !== undefined && maxMemoryBytes > 0) ||
    (maxProcesses !== undefined && maxProcesses > 0);
  if (!hasLimits) return { argv };
  const applied: AppliedResourceLimits = {
    ...(cpuSeconds !== undefined && cpuSeconds > 0 ? { cpuSeconds } : {}),
    // --as giới hạn KHÔNG GIAN ĐỊA CHỈ ẢO (không phải RAM vật lý —
    // RLIMIT_RSS không được kernel Linux enforce). Node cần ≥4GB ảo
    // nên floor 4GB; giới hạn RAM vật lý thật cần cgroup (follow-up).
    // limitsApplied.maxMemoryBytes ghi giá trị --as thật sự enforce.
    ...(maxMemoryBytes !== undefined && maxMemoryBytes > 0
      ? { maxMemoryBytes: Math.max(Math.floor(maxMemoryBytes), MIN_AS_BYTES) }
      : {}),
    ...(maxProcesses !== undefined && maxProcesses > 0 ? { maxProcesses } : {}),
    enforced: false,
  };
  if (process.platform !== 'linux') {
    applied.reason = 'giới hạn CPU/RAM/process chỉ enforce được trên Linux (prlimit)';
    warn(`box: giới hạn CPU/RAM/process không enforce được trên ${process.platform} (cần prlimit/Linux).`);
    return { argv, limitsApplied: applied };
  }
  if (!commandAvailable('prlimit')) {
    applied.reason = 'thiếu prlimit trên máy này (cài util-linux để bật giới hạn CPU/RAM/process)';
    warn('box: giới hạn CPU/RAM/process KHÔNG được enforce (thiếu prlimit) — lần chạy vẫn tiếp tục không giới hạn.');
    return { argv, limitsApplied: applied };
  }
  const prlimitArgs: string[] = ['prlimit'];
  if (cpuSeconds !== undefined && cpuSeconds > 0) prlimitArgs.push(`--cpu=${Math.ceil(cpuSeconds)}`);
  if (applied.maxMemoryBytes !== undefined) prlimitArgs.push(`--as=${applied.maxMemoryBytes}`);
  if (maxProcesses !== undefined && maxProcesses > 0) prlimitArgs.push(`--nproc=${Math.floor(maxProcesses)}`);
  prlimitArgs.push('--');
  applied.enforced = true;
  return { argv: [...prlimitArgs, ...argv], limitsApplied: applied };
}

const BOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function boxDir(rootDir: string, botId: string): string {
  return path.join(rootDir, BOXES_REL_DIR, botId);
}

function boxMetaPath(dir: string): string {
  return path.join(dir, 'box.json');
}

function readBoxMeta(dir: string): BotBox {
  return JSON.parse(fs.readFileSync(boxMetaPath(dir), 'utf8')) as BotBox;
}

function writeBoxMetaAtomic(box: BotBox): void {
  fs.mkdirSync(box.dir, { recursive: true });
  const tmp = `${boxMetaPath(box.dir)}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(box, null, 2), 'utf8');
  fs.renameSync(tmp, boxMetaPath(box.dir));
}

/** Tổng dung lượng file dưới `root` (đệ quy, không theo symlink). */
export function dirSizeBytes(root: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          // File biến mất giữa chừng — bỏ qua.
        }
      }
    }
  };
  walk(root);
  return total;
}

/** Đếm file dưới `root` (đệ quy, không theo symlink). */
export function dirFileCount(root: string): number {
  let count = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) count += 1;
    }
  };
  walk(root);
  return count;
}

function clearDirContents(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

function killProcessGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Đã thoát rồi — bỏ qua.
    }
  }
}

export interface BoxManagerOptions {
  /** Thư mục gốc chứa mọi box (vd `<workspace>/.open-bot/`). */
  rootDir: string;
  logger?: { warn(message: string): void };
  /**
   * v0.78 (cgroup): hook gọi ngay sau mỗi lần spawn thành công (cả
   * spawn chính lẫn fallback chạy thường) — caller (vd
   * BotComputerRuntime) dùng để đưa process vào cgroup giới hạn RAM.
   * Hook lỗi không được làm hỏng lần chạy (được bọc try/catch).
   */
  onSpawn?: (botId: string, child: ChildProcess) => void;
}

export interface RunInBoxOptions {
  /** Giá trị env thêm (tên phải nằm trong allow-list của box). */
  envValues?: Record<string, string>;
  /** Secret qua Vault (caller lấy từ Vault rồi đưa vào). */
  vaultSecrets?: Record<string, string>;
  /** Ghi đè timeout lần chạy này (ms). */
  timeoutMs?: number;
  /** Ghi đè cap ghi lần chạy này (bytes). */
  maxWriteBytes?: number;
  /** Ghi đè cap output lần chạy này (ký tự). */
  maxOutputChars?: number;
  /** stdin đưa vào tiến trình (mặc định không stdin). */
  stdin?: string;
  /** Ép backend cách ly cho lần chạy này (mặc định theo box). */
  isolation?: 'auto' | IsolationKind;
}

export class BotBoxManager {
  readonly rootDir: string;
  private readonly warn: (message: string) => void;
  private spawnHook?: (botId: string, child: ChildProcess) => void;

  constructor(options: BoxManagerOptions) {
    this.rootDir = options.rootDir;
    this.warn = options.logger ? (m) => options.logger?.warn(m) : () => undefined;
    this.spawnHook = options.onSpawn;
  }

  /**
   * v0.78 (cgroup): đặt/thay hook spawn sau khi tạo manager (vd
   * BotComputerRuntime truyền boxManager từ ngoài vào thì vẫn gắn
   * được hook). `undefined` = gỡ hook.
   */
  setSpawnHook(fn: ((botId: string, child: ChildProcess) => void) | undefined): void {
    this.spawnHook = fn;
  }

  /** Gọi hook spawn (best-effort — hook lỗi chỉ warn, không hỏng lần chạy). */
  private fireSpawnHook(botId: string, child: ChildProcess): void {
    if (!this.spawnHook) return;
    try {
      this.spawnHook(botId, child);
    } catch (err) {
      this.warn(`box ${botId}: spawn hook lỗi (${(err as Error).message}) — lần chạy vẫn tiếp tục.`);
    }
  }

  /**
   * Tạo box cho bot (idempotent theo bot: box đã có và còn active thì
   * trả về box đó). `botId` chỉ cho phép ký tự an toàn cho tên thư mục.
   */
  createBox(botId: string, opts: BotBoxOptions = {}): BotBox {
    if (!BOT_ID_RE.test(botId) || botId.includes('..')) {
      throw new Error(`Invalid botId "${botId}": use letters, digits, ".", "-" and "_" only.`);
    }
    const dir = boxDir(this.rootDir, botId);
    if (fs.existsSync(boxMetaPath(dir))) {
      const existing = readBoxMeta(dir);
      if (existing.status === 'active') return existing;
    }
    const envAllowlist = validateBoxEnvNames(opts.envAllowlist ?? []);
    const limits: ResolvedBoxLimits = {
      ...DEFAULT_BOX_LIMITS,
      ...(opts.limits ?? {}),
    };
    const requested = opts.isolation ?? 'auto';
    const isolation: IsolationKind =
      requested === 'auto' ? detectIsolation().kind : requested;
    const workspaceDir = path.join(dir, 'workspace');
    const authDir = path.join(dir, 'auth');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    // Quyền thư mục auth luôn 0700 (kể cả khi thư mục đã tồn tại).
    fs.chmodSync(authDir, 0o700);
    const now = new Date().toISOString();
    const box: BotBox = {
      id: `box-${botId}-${randomUUID().slice(0, 8)}`,
      botId,
      dir,
      workspaceDir,
      authDir,
      envAllowlist,
      limits,
      resetPerTurn: opts.resetPerTurn ?? false,
      isolation,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    writeBoxMetaAtomic(box);
    if (isolation === 'none') {
      this.warn(
        `box ${box.id}: không có cơ chế cách ly trên máy này — box chỉ có thư mục riêng + env allow-list.`,
      );
    }
    return box;
  }

  /** Đọc metadata box của bot; ném lỗi rõ ràng khi chưa có box. */
  getBox(botId: string): BotBox {
    const dir = boxDir(this.rootDir, botId);
    try {
      const box = readBoxMeta(dir);
      if (box.status !== 'active') throw new Error(`Box for bot "${botId}" is ${box.status}.`);
      return box;
    } catch (err) {
      if ((err as Error).message.startsWith('Box for bot')) throw err;
      throw new Error(`Unknown box for bot "${botId}" (no box.json under ${BOXES_REL_DIR}/).`);
    }
  }

  /** Liệt kê mọi box còn active (mới nhất trước). */
  listBoxes(): BotBox[] {
    const root = path.join(this.rootDir, BOXES_REL_DIR);
    if (!fs.existsSync(root)) return [];
    const out: BotBox[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const box = readBoxMeta(path.join(root, entry.name));
        if (box.status === 'active') out.push(box);
      } catch {
        // Thư mục không có box.json hợp lệ — bỏ qua.
      }
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out;
  }

  /**
   * Reset workspace của box (đầu turn khi `resetPerTurn: true`).
   * Chỉ xoá nội dung `workspace/` — `auth/` (trạng thái đăng nhập đã
   * đồng bộ) và `box.json` được giữ nguyên.
   */
  resetBox(botId: string): BotBox {
    const box = this.getBox(botId);
    clearDirContents(box.workspaceDir);
    box.updatedAt = new Date().toISOString();
    writeBoxMetaAtomic(box);
    return box;
  }

  /**
   * Chuẩn bị đầu turn: nếu box cấu hình `resetPerTurn` thì reset
   * workspace trước khi turn chạy. Trả về box (đã reset nếu cần).
   */
  beginTurn(botId: string): BotBox {
    const box = this.getBox(botId);
    if (box.resetPerTurn) return this.resetBox(botId);
    return box;
  }

  /**
   * Chạy một lệnh trong box. `command` là program (không qua shell trừ
   * khi caller tự truyền `/bin/sh -c ...`). Env chỉ từ allow-list +
   * giá trị caller đưa (xem env.ts). Timeout/cap ghi được enforce
   * thật bằng kill process group.
   */
  async runInBox(
    botId: string,
    command: string,
    args: string[] = [],
    opts: RunInBoxOptions = {},
  ): Promise<BoxRunResult> {
    const box = this.getBox(botId);
    const startedAt = Date.now();
    const timeoutMs = opts.timeoutMs ?? box.limits.timeoutMs;
    const maxWriteBytes = opts.maxWriteBytes ?? box.limits.maxWriteBytes;
    const maxOutputChars = opts.maxOutputChars ?? box.limits.maxOutputChars;
    const env = buildBoxEnv(box, {
      allowlist: box.envAllowlist,
      ...(opts.envValues !== undefined ? { values: opts.envValues } : {}),
      ...(opts.vaultSecrets !== undefined ? { vaultSecrets: opts.vaultSecrets } : {}),
    });
    const requested = opts.isolation ?? box.isolation;
    const { argv, isolation } = this.buildSpawnArgv(command, args, requested, box);
    // Sóng B: bọc prlimit khi box có giới hạn CPU/RAM/process.
    const prlimit = wrapWithPrlimit(argv, box.limits, this.warn);
    const spawnArgv = prlimit.argv;
    const limitsApplied = prlimit.limitsApplied;
    return new Promise<BoxRunResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let writeCapExceeded = false;
      let settled = false;
      const finish = (child: ChildProcess): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(capPoll);
        const workspaceBytes = dirSizeBytes(box.workspaceDir);
        resolve({
          boxId: box.id,
          botId,
          command,
          args: [...args],
          isolation,
          exitCode: child.exitCode,
          signal: child.signalCode,
          stdout: stdout.slice(0, maxOutputChars),
          stderr: stderr.slice(0, maxOutputChars),
          timedOut,
          writeCapExceeded,
          workspaceBytes,
          durationMs: Date.now() - startedAt,
          ...(limitsApplied !== undefined ? { limitsApplied } : {}),
        });
      };
      // -- Sóng B: spawn qua một hàm dùng chung cho lần đầu + thử lại.
      // Backend lỗi setup (vd bwrap không tạo được namespace lúc máy
      // tải nặng) thì thử lại cùng backend MỘT lần, rồi mới fallback
      // chạy thường — giống đường spawn lỗi, luôn ghi rõ vào isolation.
      let child: ChildProcess | undefined;
      let spawnedChild: ChildProcess | undefined;
      let fellBack = false;
      let setupRetries = 0;
      const attachIO = (c: ChildProcess): void => {
        c.stdout?.on('data', (chunk: Buffer) => {
          if (stdout.length < maxOutputChars) stdout += chunk.toString('utf8');
        });
        c.stderr?.on('data', (chunk: Buffer) => {
          if (stderr.length < maxOutputChars) stderr += chunk.toString('utf8');
        });
        if (opts.stdin !== undefined) c.stdin?.end(opts.stdin);
        else c.stdin?.end();
      };
      const fallbackToPlain = (): void => {
        if (fellBack || settled) return;
        fellBack = true;
        if (limitsApplied !== undefined) {
          limitsApplied.enforced = false;
          limitsApplied.reason = 'backend lỗi, fallback chạy thường (prlimit không còn áp dụng)';
        }
        const fallback = spawn(command, args, {
          cwd: box.workspaceDir,
          env,
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        isolation.kind = 'none';
        isolation.isolated = false;
        isolation.detail = 'none — chạy thường (backend lỗi, fallback)';
        isolation.warning = `Backend "${requested}" lỗi, đã fallback chạy thường (không cách ly).`;
        child = fallback;
        spawnedChild = fallback;
        // v0.78 (cgroup): cả process fallback cũng phải vào cgroup.
        this.fireSpawnHook(botId, fallback);
        attachIO(fallback);
        fallback.on('error', () => finish(fallback));
        fallback.on('close', () => finish(fallback));
      };
      const spawnAttempt = (): void => {
        if (settled || fellBack) return;
        let next: ChildProcess;
        try {
          next = spawn(spawnArgv[0] as string, spawnArgv.slice(1), {
            cwd: box.workspaceDir,
            env,
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch (err) {
          // Spawn lỗi đồng bộ (vd binary backend không có) → fallback
          // chạy thường + ghi rõ (không throw — caller vẫn nhận result).
          this.warn(`box ${box.id}: spawn ${requested} lỗi (${(err as Error).message}) — fallback chạy thường.`);
          fallbackToPlain();
          return;
        }
        child = next;
        spawnedChild = next;
        // v0.78 (cgroup): đưa process vào cgroup NGAY sau spawn để cửa
        // sổ race cấp phát trước khi bị giới hạn là nhỏ nhất.
        this.fireSpawnHook(botId, next);
        attachIO(next);
        next.on('error', (err) => {
          // Binary không chạy được (vd bwrap thiếu dù detect báo có):
          // fallback chạy thường một lần, giống đường spawn lỗi.
          if (
            !settled &&
            !fellBack &&
            (isolation.kind === 'bwrap' || isolation.kind === 'unshare' || isolation.kind === 'sandbox-exec')
          ) {
            this.warn(`box ${box.id}: backend ${isolation.kind} lỗi (${err.message}) — fallback chạy thường.`);
            fallbackToPlain();
            return;
          }
          finish(next);
        });
        next.on('close', () => {
          if (settled) return;
          // Chỉ tiến trình đang active mới được kết thúc lần chạy. Khi
          // spawn backend lỗi (vd hết tài nguyên lúc fork) và đã fallback
          // sang tiến trình khác, tiến trình cũ đóng lại không được kết
          // thúc sớm bằng stdout rỗng — race này đã làm một test flaky
          // (fallback chưa kịp chạy đã finish).
          if (child !== spawnedChild) return;
          // Backend chạy được nhưng lỗi setup (chưa exec tool): thử lại
          // cùng backend một lần (lỗi nhất thời lúc tải nặng), rồi mới
          // fallback. Tool lỗi thật thì không khớp mẫu setup → finish
          // bình thường với exit code của tool, không chạy lại.
          if (
            !fellBack &&
            next.exitCode !== 0 &&
            (isolation.kind === 'bwrap' || isolation.kind === 'unshare') &&
            backendSetupFailed(stderr)
          ) {
            if (setupRetries < 1) {
              setupRetries++;
              this.warn(
                `box ${box.id}: backend ${isolation.kind} lỗi setup (exit ${next.exitCode}) — thử lại sau ${BACKEND_SETUP_RETRY_DELAY_MS}ms.`,
              );
              setTimeout(() => {
                if (!settled && !fellBack) spawnAttempt();
              }, BACKEND_SETUP_RETRY_DELAY_MS);
              return;
            }
            this.warn(`box ${box.id}: backend ${isolation.kind} lỗi setup sau 1 lần thử lại — fallback chạy thường.`);
            fallbackToPlain();
            return;
          }
          finish(next);
        });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        if (child) killProcessGroup(child);
      }, timeoutMs);
      const capPoll = setInterval(() => {
        if (dirSizeBytes(box.workspaceDir) > maxWriteBytes) {
          writeCapExceeded = true;
          if (child) killProcessGroup(child);
        }
      }, 200);
      spawnAttempt();
    });
  }

  /**
   * Xoá vĩnh viễn box của bot (thư mục + workspace + auth + tmp).
   * Trả true khi đã xoá, false khi box không tồn tại.
   */
  destroyBox(botId: string): boolean {
    const dir = boxDir(this.rootDir, botId);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  // --- Spawn argv theo backend ---------------------------------------------

  private buildSpawnArgv(
    command: string,
    args: string[],
    requested: IsolationKind | 'auto',
    box: BotBox,
  ): { argv: string[]; isolation: IsolationInfo } {
    const kind: IsolationKind =
      requested === 'auto' ? detectIsolation().kind : requested;
    if (kind === 'bwrap' && process.platform === 'linux') {
      if (!isolationKindAvailable('bwrap')) return this.plainFallback(command, args, 'bwrap không có trên máy này');
      return {
        argv: [
          'bwrap',
          '--ro-bind', '/usr', '/usr',
          '--ro-bind', '/bin', '/bin',
          '--ro-bind', '/lib', '/lib',
          '--ro-bind', '/lib64', '/lib64',
          '--ro-bind', '/etc', '/etc',
          '--dev', '/dev',
          '--tmpfs', '/tmp',
          '--bind', box.workspaceDir, box.workspaceDir,
          '--bind', path.join(box.dir, 'tmp'), path.join(box.dir, 'tmp'),
          '--chdir', box.workspaceDir,
          '--unshare-pid',
          '--die-with-parent',
          '--',
          command,
          ...args,
        ],
        isolation: {
          kind: 'bwrap',
          isolated: true,
          detail: 'bwrap (mount + pid namespace, workspace bind riêng)',
        },
      };
    }
    if (kind === 'unshare' && process.platform === 'linux') {
      if (!isolationKindAvailable('unshare')) return this.plainFallback(command, args, 'unshare không có trên máy này');
      return {
        argv: ['unshare', '--user', '--map-root-user', '--pid', '--fork', command, ...args],
        isolation: {
          kind: 'unshare',
          isolated: true,
          detail: 'unshare (user + pid namespace — không giam mount)',
        },
      };
    }
    if (kind === 'sandbox-exec' && process.platform === 'darwin') {
      if (!isolationKindAvailable('sandbox-exec')) {
        return this.plainFallback(command, args, 'sandbox-exec không có trên máy này');
      }
      // Profile Seatbelt cơ bản: cho phép mặc định, cấm ghi file ngoài
      // workspace + tmp của box. Chưa kiểm chứng trên macOS thật (xem README).
      const profile =
        `(version 1)(allow default)` +
        `(deny file-write* (subpath "/") (with no-log))` +
        `(allow file-write* (subpath "${box.workspaceDir}") (subpath "${path.join(box.dir, 'tmp')}"))`;
      return {
        argv: ['sandbox-exec', '-p', profile, command, ...args],
        isolation: {
          kind: 'sandbox-exec',
          isolated: true,
          detail: 'sandbox-exec (macOS Seatbelt — chưa kiểm chứng trên macOS thật)',
        },
      };
    }
    if (kind !== 'none') {
      return this.plainFallback(command, args, `backend "${kind}" không dùng được trên ${process.platform}`);
    }
    return {
      argv: this.buildPlainArgv(command, args),
      isolation: {
        kind: 'none',
        isolated: false,
        detail: 'none — chạy thường (không cách ly)',
        warning:
          'Lần chạy này KHÔNG cách ly (không có backend sandbox hoặc đã fallback). ' +
          'Chỉ có thư mục riêng + env allow-list + timeout/cap ghi.',
      },
    };
  }

  private plainFallback(command: string, args: string[], why: string): { argv: string[]; isolation: IsolationInfo } {
    this.warn(`box: ${why} — chạy thường (không cách ly).`);
    return {
      argv: this.buildPlainArgv(command, args),
      isolation: {
        kind: 'none',
        isolated: false,
        detail: 'none — chạy thường (không cách ly)',
        warning: `${why} — lần chạy này KHÔNG cách ly.`,
      },
    };
  }

  private buildPlainArgv(command: string, args: string[]): string[] {
    return [command, ...args];
  }
}
