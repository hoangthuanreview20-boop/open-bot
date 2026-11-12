/**
 * Env allow-list + phát hiện cơ chế cách ly (M6).
 *
 * Nguyên tắc env (như session box + M1/M2):
 *  - KHÔNG BAO GIỜ copy toàn bộ `process.env` của host vào box.
 *  - Chỉ các biến trong allow-list mới được đưa vào, và giá trị phải do
 *    caller đưa rõ ràng (caller lấy từ Vault — xem `vaultSecrets`).
 *  - Tên biến trông giống secret (KEY/TOKEN/SECRET/PASSWORD/...) bị
 *    từ chối khỏi allow-list, TRỪ khi giá trị được đưa qua
 *    `vaultSecrets` (đường Vault có kiểm soát, không qua env host).
 *  - Biến auth riêng của CLI (vd `CLAUDE_CODE_*`, `CODEX_*`) cũng chỉ
 *    đi qua đường này — M1/M2 đã làm vậy với `sanitizeEnvForCli`.
 *
 * Biến mặc định an toàn (không secret, cần cho shell chạy đúng):
 * PATH, HOME (trỏ vào box), TMPDIR (trỏ vào box), LANG, LC_ALL, TERM,
 * USER, SHELL, NO_COLOR, FORCE_COLOR, OPENBOT_BOX_ID, OPENBOT_BOT_ID.
 */

import { execFileSync } from 'node:child_process';
import type { IsolationInfo, IsolationKind } from './types';

const SECRET_NAME_RE = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|BEARER|SESSION|COOKIE/i;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Biến không secret, luôn được phép (giá trị do box tự đặt). */
export const DEFAULT_BOX_ENV_VARS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  'USER',
  'SHELL',
  'NO_COLOR',
  'FORCE_COLOR',
  'OPENBOT_BOX_ID',
  'OPENBOT_BOT_ID',
] as const;

/** Giá trị mặc định cho các biến box tự đặt (PATH giữ của host đã lọc). */
export function defaultBoxEnvValues(box: {
  id: string;
  botId: string;
  workspaceDir: string;
  dir: string;
}): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: box.workspaceDir,
    TMPDIR: `${box.dir}/tmp`,
    LANG: process.env['LANG'] ?? 'en_US.UTF-8',
    LC_ALL: process.env['LC_ALL'] ?? 'en_US.UTF-8',
    TERM: process.env['TERM'] ?? 'xterm-256color',
    USER: process.env['USER'] ?? 'open-bot',
    SHELL: '/bin/sh',
    OPENBOT_BOX_ID: box.id,
    OPENBOT_BOT_ID: box.botId,
  };
}

/**
 * Validate tên biến allow-list: đúng dạng identifier, không trông giống
 * secret. Trả allow-list đã dedupe + sort. Ném Error rõ ràng khi sai.
 */
export function validateBoxEnvNames(varNames: string[]): string[] {
  const out: string[] = [];
  for (const name of varNames) {
    if (!ENV_NAME_RE.test(name)) {
      throw new Error(`Invalid env var name "${name}".`);
    }
    if (SECRET_NAME_RE.test(name)) {
      throw new Error(
        `Env var name "${name}" looks like a secret and is not allowed in a box allowlist. ` +
          `Pass its value through Vault (vaultSecrets) instead of the host environment.`,
      );
    }
    if (!out.includes(name)) out.push(name);
  }
  return out.sort();
}

export interface BuildBoxEnvOptions {
  /** Tên biến cho phép thêm (ngoài biến mặc định). */
  allowlist?: string[];
  /**
   * Giá trị env do caller đưa rõ ràng (vd lấy từ Vault). Key phải là
   * tên biến hợp lệ; giá trị secret CHỈ đi đường này, không qua env host.
   */
  values?: Record<string, string>;
  /**
   * Giá trị lấy từ Vault (đặt tên riêng cho rõ nguồn): hợp nhất vào
   * `values` — secret qua Vault được phép mang tên giống secret.
   */
  vaultSecrets?: Record<string, string>;
}

/**
 * Dựng env cho tiến trình trong box: chỉ biến mặc định + allow-list +
 * giá trị caller đưa rõ ràng. Biến lạ trong `process.env` KHÔNG BAO
 * GIỜ lọt vào. Giá trị từ `values`/`vaultSecrets` thắng giá trị mặc định.
 */
export function buildBoxEnv(
  box: { id: string; botId: string; workspaceDir: string; dir: string },
  opts: BuildBoxEnvOptions = {},
): Record<string, string> {
  const extra = validateBoxEnvNames(opts.allowlist ?? []);
  const env: Record<string, string> = {};
  // Biến mặc định (giá trị box tự đặt — không lấy secret từ host).
  for (const [key, value] of Object.entries(defaultBoxEnvValues(box))) {
    env[key] = value;
  }
  // Biến allow-list thêm: chỉ lấy từ `values` do caller đưa rõ ràng;
  // không có giá trị thì KHÔNG đưa vào (không đọc process.env).
  for (const name of extra) {
    const fromValues = opts.values?.[name];
    const fromVault = opts.vaultSecrets?.[name];
    if (fromVault !== undefined) env[name] = fromVault;
    else if (fromValues !== undefined) env[name] = fromValues;
  }
  // Vault secrets: cho phép cả tên giống secret (đường Vault có kiểm soát).
  for (const [name, value] of Object.entries(opts.vaultSecrets ?? {})) {
    if (!ENV_NAME_RE.test(name)) {
      throw new Error(`Invalid env var name "${name}" in vaultSecrets.`);
    }
    env[name] = value;
  }
  // Values thường: tên giống secret bị từ chối (phải đi đường Vault).
  for (const name of Object.keys(opts.values ?? {})) {
    if (SECRET_NAME_RE.test(name)) {
      throw new Error(
        `Env var "${name}" looks like a secret — pass it via vaultSecrets (Vault), not values.`,
      );
    }
  }
  return env;
}

// --- Phát hiện cơ chế cách ly -----------------------------------------------

/**
 * True khi binary có mặt trên PATH (chạy `<cmd> --version`, timeout 5s).
 * Dùng để dò backend (bwrap/unshare/prlimit...) — không chạy gì khác.
 */
export function commandAvailable(cmd: string): boolean {
  return commandExists(cmd);
}

function commandExists(cmd: string): boolean {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Phát hiện cơ chế cách ly tốt nhất có thể trên máy này (không spawn
 * box thật — chỉ kiểm tra binary có mặt). Thứ tự Linux: bwrap >
 * unshare > none; macOS: sandbox-exec > none; Windows: none.
 * Kết quả là "có thể dùng", mức cách ly THẬT của từng lần chạy vẫn do
 * `runInBox` báo lại trong `BoxRunResult.isolation` (spawn thất bại
 * thì fallback + ghi rõ — không giả vờ đã cách ly).
 */
export function detectIsolation(): IsolationInfo {
  const platform = process.platform;
  if (platform === 'linux') {
    if (commandExists('bwrap')) {
      return {
        kind: 'bwrap',
        isolated: true,
        detail: 'bwrap (bubblewrap: mount + pid namespace, workspace bind riêng)',
      };
    }
    if (commandExists('unshare')) {
      return {
        kind: 'unshare',
        isolated: true,
        detail: 'unshare (user + pid namespace — cách ly yếu hơn bwrap, không giam mount)',
      };
    }
    return {
      kind: 'none',
      isolated: false,
      detail: 'none — chạy thường (không có bwrap/unshare)',
      warning:
        'Box chạy KHÔNG cách ly trên Linux này (thiếu bubblewrap và unshare). ' +
        'Cài bubblewrap (`apt-get install bubblewrap`) để bật cách ly thật.',
    };
  }
  if (platform === 'darwin') {
    if (commandExists('sandbox-exec')) {
      return {
        kind: 'sandbox-exec',
        isolated: true,
        detail: 'sandbox-exec (macOS Seatbelt profile — giới hạn theo profile, xem README)',
      };
    }
    return {
      kind: 'none',
      isolated: false,
      detail: 'none — chạy thường (không có sandbox-exec)',
      warning: 'Box chạy KHÔNG cách ly trên macOS này (thiếu sandbox-exec).',
    };
  }
  return {
    kind: 'none',
    isolated: false,
    detail: 'none — chạy thường (Windows chưa có cơ chế cách ly tương đương)',
    warning:
      'Box chạy KHÔNG cách ly trên Windows (chưa có backend cách ly). ' +
      'Chỉ có thư mục riêng + env allow-list + timeout/cap ghi.',
  };
}

/** True khi kind này dùng được trên platform hiện tại. */
export function isolationKindAvailable(kind: IsolationKind): boolean {
  if (kind === 'none') return true;
  if (process.platform === 'linux') return kind === 'bwrap' || kind === 'unshare';
  if (process.platform === 'darwin') return kind === 'sandbox-exec';
  return false;
}
