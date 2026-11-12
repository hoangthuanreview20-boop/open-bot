/**
 * killProcessGroup — kill an toàn cả cây tiến trình, đa nền tảng (v0.15).
 *
 * Vấn đề: daemon spawn shell rồi shell lại spawn tiến trình cháu (vd:
 * `sh -c 'sleep 30'` -> sleep). Cháu thừa hưởng pipe stdio của shell nên
 * chỉ kill shell thôi thì exec vẫn treo tới khi cháu thoát. Vì vậy daemon
 * spawn detached (mỗi exec một process group riêng, chỉ trên non-Windows)
 * và kill cả group — logic này trước đây nằm inline trong
 * `packages/tools/src/daemon/daemon.ts` (`killChild`, chỉ POSIX) và
 * `packages/tools/src/sandbox.ts` (`killGroup` trong `runShell`).
 * Module này tách logic đó ra một chỗ để dùng chung, và bổ sung nhánh
 * Windows mà hai chỗ kia chưa có.
 *
 *  - POSIX: `process.kill(-pid, signal)` — gửi signal tới cả group.
 *    Nếu pid không phải group leader (vd: tiến trình spawn không detached)
 *    thì `kill(-pid)` ném ESRCH, fallback sang `process.kill(pid, signal)`
 *    để ít nhất tiến trình chính cũng chết. Chỉ trả `false` khi cả hai
 *    đều thất bại (tiến trình đã chết từ trước — trường hợp bình thường,
 *    không phải lỗi).
 *  - Windows: `taskkill /PID <pid> /T /F` — `/T` kill cả cây con,
 *    `/F` ép buộc. `taskkill` không có sẵn (môi trường lạ) thì fallback
 *    sang `process.kill(pid)` của Node. Lưu ý: trên Windows daemon spawn
 *    KHÔNG detached (`detached: false`), nhưng `taskkill /T` vẫn diệt
 *    được cả cây nên không cần đổi cách spawn.
 *
 * Mọi hàm ở đây KHÔNG BAO GIỜ ném lỗi: tiến trình đã chết, pid không hợp
 * lệ hay lệnh kill thất bại đều chỉ trả về `false`. Daemon gọi kill trong
 * timeout handler / shutdown nên không được phép throw.
 *
 * ĐIỂM NỐI VÀO DAEMON (điều phối viên tự làm — file daemon.ts KHÔNG sửa
 * trong task này):
 *   import { killProcessGroupOfChild } from '../killProcessGroup';
 *   function killChild(child: ChildProcess): void {
 *     killProcessGroupOfChild(child); // thay toàn bộ thân hàm cũ
 *   }
 *   // Hoặc giữ tên killChild và gọi killProcessGroup(child.pid, { signal: 'SIGKILL' })
 *   // rồi fallback child.kill('SIGKILL') khi nó trả false — đúng những gì
 *   // killProcessGroupOfChild đã làm sẵn.
 *   Các chỗ gọi killChild trong daemon.ts (timeout exec — dòng ~424,
 *   request kill — dòng ~497, shutdown — dòng ~669, session close — dòng
 *   ~762/~775) không cần đổi gì thêm, vì chúng đã gọi qua killChild.
 *   Tương tự, `killGroup` trong sandbox.ts (runShell) có thể gọi
 *   killProcessGroup(child.pid) thay cho khối inline hiện tại.
 */
import { spawnSync, type ChildProcess } from 'node:child_process';

/** Nền tảng mà thao tác kill nhắm tới (mặc định lấy `process.platform`). */
export type KillPlatform = 'win32' | 'posix';

export interface KillProcessGroupOptions {
  /** Signal gửi tới group (POSIX). Mặc định `'SIGKILL'`. Trên Windows signal
   *  bị bỏ qua — `taskkill /F` luôn ép buộc, fallback `process.kill` cũng vậy. */
  signal?: NodeJS.Signals;
  /** Nền tảng muốn kill cho. Nhận cả `NodeJS.Platform`; mọi giá trị khác
   *  `'win32'` đều được coi là POSIX. Mặc định `process.platform`. */
  platform?: KillPlatform | NodeJS.Platform;
  /** Timeout (ms) chờ `taskkill` trên Windows. Mặc định 10_000. */
  taskkillTimeoutMs?: number;
}

/** Chuẩn hoá platform về `'win32' | 'posix'` (mặc định `process.platform`). */
export function resolveKillPlatform(
  platform?: KillPlatform | NodeJS.Platform,
): KillPlatform {
  const p = platform ?? process.platform;
  return p === 'win32' ? 'win32' : 'posix';
}

/** Mã lỗi của một `NodeJS.ErrnoException`, hoặc `undefined` nếu không có. */
function errorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * `true` khi tiến trình `pid` còn tồn tại (kể cả khi không có quyền kill
 * nó — lúc đó `process.kill(pid, 0)` ném EPERM thay vì ESRCH).
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === 'EPERM';
  }
}

/** Kill một pid đơn (không phải group) bằng `process.kill`, không ném lỗi. */
function killSingle(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Nhánh Windows: `taskkill /PID <pid> /T /F`, fallback `process.kill`. */
function killProcessGroupWindows(
  pid: number,
  signal: NodeJS.Signals,
  taskkillTimeoutMs: number,
): boolean {
  try {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: taskkillTimeoutMs,
      stdio: 'ignore',
    });
    if (result.error !== undefined) {
      // taskkill không chạy được (vd: không có trong PATH) — fallback.
      return killSingle(pid, signal);
    }
    // taskkill trả 0 khi kill được ít nhất một tiến trình, 128 khi pid
    // không tồn tại (đã chết — không phải lỗi, trả false để caller biết).
    return result.status === 0;
  } catch {
    return killSingle(pid, signal);
  }
}

/**
 * Kill cả process group của `pid` (kèm mọi tiến trình con/cháu trong cây).
 * Trả `true` khi đã gửi kill thành công, `false` khi pid không hợp lệ hoặc
 * tiến trình/group đã chết từ trước. Không bao giờ ném lỗi.
 */
export function killProcessGroup(
  pid: number,
  options: KillProcessGroupOptions = {},
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const signal = options.signal ?? 'SIGKILL';
  if (resolveKillPlatform(options.platform) === 'win32') {
    return killProcessGroupWindows(
      pid,
      signal,
      options.taskkillTimeoutMs ?? 10_000,
    );
  }
  // POSIX: kill cả group trước; pid không phải group leader thì kill đơn.
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    // ESRCH: không có group -pid (pid không phải leader, hoặc đã chết).
    // EPERM: có group nhưng không được kill — kill đơn cũng sẽ EPERM,
    // vẫn thử cho đủ (trường hợp pid đơn khác quyền với group).
    void err;
    return killSingle(pid, signal);
  }
}

/**
 * Tiện ích cho daemon: nhận thẳng `ChildProcess` như `killChild` cũ.
 * Kill cả group của `child.pid`; nếu group kill thất bại (vd: child không
 * phải group leader) thì fallback `child.kill(signal)` — đúng thứ tự mà
 * `killChild` trong daemon.ts vẫn làm. Trả `false` khi child đã chết hoặc
 * không còn pid. Không bao giờ ném lỗi.
 */
export function killProcessGroupOfChild(
  child: ChildProcess,
  options: KillProcessGroupOptions = {},
): boolean {
  const signal = options.signal ?? 'SIGKILL';
  if (child.pid !== undefined) {
    if (killProcessGroup(child.pid, options)) return true;
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}
