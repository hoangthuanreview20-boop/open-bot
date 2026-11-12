/**
 * Enforce RAM vật lý thật bằng cgroup v2 (`memory.max`) — follow-up
 * của giới hạn Team B ghi trong docs/team-b-platform.md: prlimit
 * `--as` (xem sandbox/box.ts `wrapWithPrlimit`) chỉ giới hạn không
 * gian địa chỉ ẢO (floor 4GB vì Node cần >= 4GB ảo), KHÔNG giới hạn
 * được RAM vật lý thật. cgroup v2 `memory.max` giới hạn đúng RAM vật
 * lý: process trong cgroup cấp phát quá giới hạn thì kernel OOM-kill
 * (hoặc trả lỗi cấp phát), không chạm sang RAM của host/user.
 *
 * Yêu cầu để enforce thật: kernel cgroup v2 + controller `memory`
 * được delegate cho namespace/process đang chạy + quyền ghi
 * `/sys/fs/cgroup`. Trên máy dev này (VM thay mới, userns không
 * delegate controller nào — `cgroup.controllers` rỗng) probe trả
 * `available: false` và runtime giữ prlimit làm best-effort, báo rõ
 * trong `ComputerStatusView.memoryEnforcement` — không bao giờ bịa
 * là đã enforce RAM vật lý.
 *
 * Mọi logic trong file này kiểm chứng được bằng cgroup root GIẢ
 * (thư mục tạm đóng vai `/sys/fs/cgroup`, với file `cgroup.controllers`
 * + các file `memory.*`/`cgroup.procs` là file thường) — xem
 * tests/computers-cgroup-v078.test.mjs. Chỉ `probeCgroupMemory()`
 * không tham số mới chạm `/sys/fs/cgroup` thật (mkdir probe + rmdir,
 * best-effort, không throw).
 *
 * Lưu ý triển khai:
 * - Cgroup membership được process con KẾ THỪA khi fork — nên chỉ
 *   cần đưa PID của tiến trình box (bwrap / lệnh thường) vào
 *   `cgroup.procs`, toàn bộ cây process con của nó cùng bị giới hạn.
 * - Đưa PID vào cgroup SAU khi spawn (hook `onSpawn` của
 *   BotBoxManager) nên có một cửa sổ race nhỏ: process có thể cấp
 *   phát trước khi bị đưa vào cgroup. Đây là giới hạn đã biết của mọi
 *   cách attach sau spawn (không dùng `cgexec`); cgroup vẫn chặn
 *   được việc cấp phát kéo dài — đủ cho mục tiêu "không để bot nuốt
 *   RAM của host".
 * - `memory.swap.max` được thử đặt `0` (không cho swap trốn giới
 *   hạn) nhưng best-effort — file có thể không tồn tại trên kernel
 *   không bật swap accounting; lỗi thì bỏ qua lặng lẽ.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Thư mục cgroup mặc định trên Linux. */
export const CGROUP_ROOT_DEFAULT = '/sys/fs/cgroup';

/** Tiền tố tên cgroup của open-bot (để dọn dẹp/nhận diện). */
export const CGROUP_NAME_PREFIX = 'open-bot-';

/** Giới hạn RAM nhỏ nhất chấp nhận được (1MB — dưới nữa kernel từ chối). */
export const CGROUP_MIN_MEMORY_BYTES = 1024 * 1024;

const CGROUP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Dọn một cgroup probe/limiter: trên cgroupfs thật, rmdir là đủ
 * (cgroup rỗng); trên cgroup root GIẢ (thư mục thường trong test),
 * rmdir lỗi ENOTEMPTY vì còn file control thật bên trong nên phải
 * xoá đệ quy. Cả hai đường đều best-effort, không throw.
 */
function removeCgroupDir(dir: string): void {
  try {
    fs.rmdirSync(dir);
    return;
  } catch {
    // rmdir lỗi (cgroup giả còn file / cgroup thật còn process).
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Dọn best-effort.
  }
}

export interface CgroupMemoryProbe {
  /** True khi có thể tạo cgroup + ghi memory.max trên máy này. */
  available: boolean;
  /** Lý do khi không khả dụng (để UI/log hiện rõ, không bịa). */
  reason?: string;
}

/**
 * Dò xem máy này có enforce RAM bằng cgroup v2 được không. Không throw:
 * mọi lỗi đều thành `available: false` + lý do. Probe tự dọn cgroup
 * thử của nó (tên gồm pid để không đụng cgroup của máy khác).
 */
export function probeCgroupMemory(opts: { cgroupRoot?: string } = {}): CgroupMemoryProbe {
  const root = opts.cgroupRoot ?? CGROUP_ROOT_DEFAULT;
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return { available: false, reason: `Không có thư mục cgroup: ${root}` };
    }
    let controllers = '';
    try {
      controllers = fs.readFileSync(path.join(root, 'cgroup.controllers'), 'utf8');
    } catch {
      return { available: false, reason: `Không đọc được ${path.join(root, 'cgroup.controllers')}` };
    }
    if (!controllers.split(/\s+/).includes('memory')) {
      return {
        available: false,
        reason: 'Controller memory không được delegate cho process này (cgroup.controllers không có "memory") — máy này không enforce RAM vật lý bằng cgroup được.',
      };
    }
    // Thử tạo cgroup thật + ghi memory.max rồi dọn — chứng minh quyền ghi.
    const probeName = `${CGROUP_NAME_PREFIX}probe-${process.pid}`;
    const probeDir = path.join(root, probeName);
    try {
      fs.mkdirSync(probeDir);
    } catch (err) {
      return { available: false, reason: `Không tạo được cgroup trong ${root}: ${(err as Error).message}` };
    }
    try {
      fs.writeFileSync(path.join(probeDir, 'memory.max'), String(CGROUP_MIN_MEMORY_BYTES), 'utf8');
    } catch (err) {
      removeCgroupDir(probeDir);
      return { available: false, reason: `Không ghi được memory.max trong cgroup: ${(err as Error).message}` };
    }
    removeCgroupDir(probeDir);
    return { available: true };
  } catch (err) {
    return { available: false, reason: `Dò cgroup lỗi: ${(err as Error).message}` };
  }
}

export interface CgroupMemoryLimiterOptions {
  /** Thư mục cgroup gốc (mặc định /sys/fs/cgroup; test truyền thư mục tạm). */
  cgroupRoot?: string;
  /** Tên cgroup (vd `open-bot-<botId>`) — chỉ ký tự an toàn cho tên thư mục. */
  name: string;
  logger?: { warn(message: string): void };
}

/**
 * Một cgroup v2 giới hạn RAM cho một máy-tính-bot: `create(limitBytes)`
 * tạo thư mục + ghi `memory.max`; `addPid(pid)` đưa process vào;
 * `readUsage()` đọc `memory.current`/`memory.peak`; `destroy()` xoá
 * thư mục (chỉ xoá được khi không còn process trong cgroup).
 */
export class CgroupMemoryLimiter {
  readonly cgroupRoot: string;
  readonly name: string;
  private readonly warn: (message: string) => void;
  private createdFlag = false;

  constructor(options: CgroupMemoryLimiterOptions) {
    if (!CGROUP_NAME_RE.test(options.name) || options.name.includes('..')) {
      throw new Error(`Invalid cgroup name "${options.name}": use letters, digits, ".", "-" and "_" only.`);
    }
    this.cgroupRoot = options.cgroupRoot ?? CGROUP_ROOT_DEFAULT;
    this.name = options.name;
    this.warn = options.logger ? (m) => options.logger?.warn(m) : () => undefined;
  }

  /** Đường dẫn thư mục cgroup. */
  get path(): string {
    return path.join(this.cgroupRoot, this.name);
  }

  /** True khi cgroup đã được tạo (bởi limiter này). */
  get created(): boolean {
    return this.createdFlag;
  }

  /**
   * Tạo cgroup + đặt giới hạn RAM (bytes). Idempotent: gọi lại chỉ cập
   * nhật `memory.max`. Throw khi giới hạn không hợp lệ / không ghi được.
   */
  create(limitBytes: number): void {
    if (!Number.isInteger(limitBytes) || limitBytes < CGROUP_MIN_MEMORY_BYTES) {
      throw new Error(
        `Invalid memory limit ${limitBytes}: phải là số nguyên >= ${CGROUP_MIN_MEMORY_BYTES} bytes (1MB).`,
      );
    }
    if (!fs.existsSync(this.path)) {
      fs.mkdirSync(this.path, { recursive: false });
    }
    this.createdFlag = true;
    this.writeLimit(limitBytes);
    // Không cho swap trốn giới hạn — best-effort (file có thể không có).
    try {
      fs.writeFileSync(path.join(this.path, 'memory.swap.max'), '0', 'utf8');
    } catch {
      // Kernel không bật swap accounting — bỏ qua.
    }
  }

  /** Đổi giới hạn RAM của cgroup đã tạo (cgroup phải tồn tại). */
  setLimit(limitBytes: number): void {
    if (!Number.isInteger(limitBytes) || limitBytes < CGROUP_MIN_MEMORY_BYTES) {
      throw new Error(
        `Invalid memory limit ${limitBytes}: phải là số nguyên >= ${CGROUP_MIN_MEMORY_BYTES} bytes (1MB).`,
      );
    }
    this.writeLimit(limitBytes);
  }

  /**
   * Đưa một process vào cgroup (ghi pid vào `cgroup.procs`). Process
   * con của nó kế thừa cgroup nên toàn bộ cây đều bị giới hạn.
   * Throw khi ghi lỗi (vd pid đã chết / không có quyền).
   */
  addPid(pid: number): void {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`Invalid pid ${pid}: phải là số nguyên dương.`);
    }
    if (!this.createdFlag && !fs.existsSync(this.path)) {
      throw new Error(`Cgroup chưa được tạo: ${this.path} — gọi create() trước khi addPid().`);
    }
    try {
      fs.writeFileSync(path.join(this.path, 'cgroup.procs'), String(pid), 'utf8');
    } catch (err) {
      throw new Error(`Không đưa được pid ${pid} vào cgroup ${this.name}: ${(err as Error).message}`);
    }
  }

  /**
   * Đọc RAM đang dùng + đỉnh đã dùng (bytes). Trả null khi không đọc
   * được (vd cgroup chưa tạo / file không có) — không throw.
   */
  readUsage(): { currentBytes: number; peakBytes: number } | null {
    try {
      const current = Number.parseInt(fs.readFileSync(path.join(this.path, 'memory.current'), 'utf8').trim(), 10);
      const peak = Number.parseInt(fs.readFileSync(path.join(this.path, 'memory.peak'), 'utf8').trim(), 10);
      if (!Number.isFinite(current) || !Number.isFinite(peak)) return null;
      return { currentBytes: current, peakBytes: peak };
    } catch {
      return null;
    }
  }

  /**
   * Xoá cgroup (best-effort: còn process trong cgroup thì không xoá
   * được — chỉ warn, không throw; cgroup rỗng còn sót không hại gì).
   */
  destroy(): void {
    this.createdFlag = false;
    removeCgroupDir(this.path);
    if (fs.existsSync(this.path)) {
      this.warn(`Không xoá được cgroup ${this.name} (có thể còn process trong cgroup).`);
    }
  }

  private writeLimit(limitBytes: number): void {
    try {
      fs.writeFileSync(path.join(this.path, 'memory.max'), String(limitBytes), 'utf8');
    } catch (err) {
      throw new Error(`Không ghi được memory.max cho cgroup ${this.name}: ${(err as Error).message}`);
    }
  }
}
