/**
 * Probe helpers cho detector registry (M1).
 *
 * - `findOnPath`: tìm binary thực thi trên PATH (cộng thêm thư mục
 *   do caller chỉ định, vd thư mục tạm của test) — không spawn gì cả.
 * - `runProbe`: chạy một lệnh ngắn (version / auth status) với timeout,
 *   thu stdout/stderr đã cắt ngắn. Không bao giờ throw vì lỗi của lệnh:
 *   lỗi spawn/timeout/exit-code đều trả về trong ProbeResult để
 *   registry quyết định trạng thái.
 * - `parseVersion` / `compareVersions`: trích semver dạng x.y[.z] từ
 *   output `--version` (mỗi CLI in một kiểu khác nhau) và so sánh số học.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';

import type { ProbeResult } from './types';

/** Giới hạn output probe giữ lại (tránh log/output khổng lồ). */
export const PROBE_OUTPUT_LIMIT = 4096;

/** Timeout mặc định cho probe `--version` (ms). */
export const VERSION_PROBE_TIMEOUT_MS = 10_000;

/** Timeout mặc định cho lệnh kiểm tra đăng nhập (ms) — status có thể chậm. */
export const AUTH_PROBE_TIMEOUT_MS = 15_000;

/** Cắt text về tối đa `limit` ký tự (thêm '…' khi đã cắt). */
export function truncateText(text: string, limit: number = PROBE_OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

/**
 * Tìm binary thực thi: thử từng tên trong `names`, từng thư mục trong
 * `dirs` (thư mục caller chỉ định trước, rồi PATH). Trên Windows còn
 * thử thêm hậu tố .exe/.cmd/.bat. Trả đường dẫn tuyệt đối đầu tiên
 * tìm thấy, hoặc null.
 */
export function findOnPath(
  names: string[],
  dirs: string[],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const searchDirs: string[] = [...dirs];
  const pathValue = env.PATH ?? env.Path ?? '';
  if (pathValue) {
    searchDirs.push(...pathValue.split(path.delimiter).filter((d) => d.length > 0));
  }
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of searchDirs) {
    for (const name of names) {
      for (const suffix of suffixes) {
        const candidate = path.join(dir, `${name}${suffix}`);
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          const stat = fs.statSync(candidate);
          if (stat.isFile()) return candidate;
        } catch {
          // Không tồn tại / không chạy được — thử ứng viên tiếp theo.
        }
      }
    }
  }
  return null;
}

/**
 * Chạy `binary` với `args`, chờ tối đa `timeoutMs`. Không throw khi
 * lệnh lỗi: exit code != 0, timeout, hay spawn lỗi đều trả về trong
 * ProbeResult. Chỉ throw khi `timeoutMs` không hợp lệ.
 */
export function runProbe(
  binary: string,
  args: string[],
  options: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? VERSION_PROBE_TIMEOUT_MS;
  if (!(timeoutMs > 0)) throw new Error('runProbe cần timeoutMs > 0.');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = execFile(
        binary,
        args,
        {
          timeout: timeoutMs,
          cwd: options.cwd,
          env: options.env ?? process.env,
          // execFile buffer mặc định 1MB; cắt về giới hạn của mình sau.
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const timedOut =
            !!error &&
            ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ||
              (error as Error).message.includes('ETIMEDOUT'));
          // Exit code: 0 khi error null (chạy xong); error.code là số
          // khi process thoát lỗi; null khi bị kill (timeout) hoặc
          // spawn thất bại (ENOENT).
          const code = !error
            ? 0
            : typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : null;
          finish({
            code,
            stdout: truncateText(stdout),
            stderr: truncateText(stderr),
            timedOut,
            spawnError: error && code === null && !timedOut ? (error as Error).message : undefined,
          });
        },
      );
    } catch (err) {
      finish({
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnError: (err as Error).message,
      });
      return;
    }
    // execFile với `timeout` tự kill process; không cần timer riêng.
    void child;
  });
}

const VERSION_RE = /(\d+)\.(\d+)(?:\.(\d+))?/;

/**
 * Trích version dạng 'x.y.z' từ output `--version` (vd 'claude/2.1.318',
 * 'codex-cli 0.164.0-alpha.9', 'grok 1.0.41' đều lấy được phần số đầu
 * tiên). Trả null khi không thấy số version nào.
 */
export function parseVersion(output: string): string | null {
  const match = VERSION_RE.exec(output);
  if (!match) return null;
  return `${match[1]}.${match[2]}.${match[3] ?? '0'}`;
}

/** So sánh 2 version 'x.y.z' theo số học: -1 | 0 | 1. Version thiếu phần coi như 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

/** True khi `version` đạt mức tối thiểu (`minVersion` rỗng = luôn đạt). */
export function meetsMinVersion(version: string | null, minVersion: string): boolean {
  if (!minVersion) return true;
  if (!version) return false;
  return compareVersions(version, minVersion) >= 0;
}
