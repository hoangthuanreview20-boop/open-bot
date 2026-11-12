/**
 * Spawn/kill process CLI có kiểm soát (M1).
 *
 * Theo mẫu OpenMausBot `server/procs.ts`: spawn tập trung một chỗ,
 * kill cả CÂY process (không để CLI con mồ côi chạy tiếp sau khi turn
 * dừng), chờ thoát có timeout.
 *
 * - POSIX: spawn với `detached: true` để CLI thành leader của process
 *   group riêng; kill gửi signal tới cả group (`process.kill(-pid)`).
 * - Windows: không có process group POSIX — kill bằng
 *   `taskkill /PID <pid> /T /F` (cây process), như helper kill đã có
 *   trong audit v0.15 (M4).
 * - `killProcessGroup` không bao giờ throw: best-effort, process đã
 *   chết thì coi như xong.
 */

import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type { ChildProcessWithoutNullStreams };

export interface SpawnCliOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  /** Ghi log spawn/kill (mặc định im lặng). */
  logger?: { warn(message: string): void };
}

/**
 * Spawn một CLI: stdio đều là pipe (stdin để gửi prompt NDJSON,
 * stdout để đọc stream-JSON, stderr để chẩn đoán). Process group riêng
 * trên POSIX để kill được cả cây.
 */
export function spawnCli(
  binary: string,
  args: string[],
  options: SpawnCliOptions,
): ChildProcessWithoutNullStreams {
  const child = spawn(binary, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // POSIX: process group riêng (kill -pid). Windows: detached tạo
    // console riêng; taskkill /T vẫn diệt được cây.
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  return child;
}

/**
 * Kill cả cây process của `child`: SIGTERM trước, hết `timeoutMs` thì
 * SIGKILL (POSIX) hoặc taskkill /F (Windows). Luôn resolve (không
 * throw) — caller dùng cho abort/timeout/dispose nên không được crash
 * vì process đã chết trước.
 */
export function killProcessGroup(
  child: ChildProcessWithoutNullStreams,
  options: { timeoutMs?: number; logger?: { warn(message: string): void } } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const warn = options.logger
    ? (message: string) => options.logger?.warn(message)
    : undefined;
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(forceTimer);
      resolve();
    };
    const onExit = (): void => finish();
    child.once('exit', onExit);
    const forceTimer = setTimeout(() => {
      // Hết thời gian chờ thoát êm: ép kill.
      killNow(true);
      // Cho thêm 2s để SIGKILL/taskkill có hiệu lực rồi resolve dù sao.
      setTimeout(finish, 2000).unref?.();
    }, timeoutMs);
    forceTimer.unref?.();

    const killNow = (force: boolean): void => {
      const signal = force ? 'SIGKILL' : 'SIGTERM';
      try {
        if (process.platform === 'win32') {
          if (child.pid !== undefined) {
            execFile(
              'taskkill',
              ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])],
              { windowsHide: true },
              () => undefined,
            );
          }
          return;
        }
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch {
            // Không phải group leader (hoặc đã chết): kill process đơn.
          }
        }
        try {
          child.kill(signal);
        } catch {
          // Đã chết.
        }
      } catch (err) {
        warn?.(`kill process group lỗi: ${(err as Error).message}`);
      }
    };
    killNow(false);
  });
}

/**
 * Chờ process thoát trong `timeoutMs`; trả true khi thoát kịp, false
 * khi hết timeout (caller tự kill tiếp).
 */
export function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}
