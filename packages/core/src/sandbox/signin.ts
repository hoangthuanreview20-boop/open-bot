/**
 * Đồng bộ sign-in an toàn giữa box và host (M6).
 *
 * Khi CLI trong box cần đăng nhập (vd `claude login`, `codex login`),
 * trạng thái đăng nhập phải về host để lần chạy sau (và UI) thấy được
 * — nhưng KHÔNG BAO GIỜ copy token/secret thô qua log hay file quyền rộng.
 *
 * Cái ĐƯỢC đồng bộ (file `<authDir>/<provider>.state.json`):
 *   - provider, accountLabel (nhãn hiển thị, vd email đã che), status
 *     ('signed-in' | 'signed-out' | 'unknown'), observedAt, source.
 * Cái KHÔNG được đồng bộ:
 *   - access token, refresh token, API key, cookie, file credential
 *     thô của CLI (vd `~/.codex/auth.json`, `~/.claude.json`).
 *     CLI tự giữ credential trong HOME của nó (HOME trong box trỏ vào
 *     workspace của box — xem env.ts); host chỉ biết TRẠNG THÁI.
 *     Muốn CLI ngoài box dùng lại login thì chạy lại CLI đó trên host
 *     (nó đọc credential store của chính nó), không copy file auth.
 *
 * An toàn ghi file:
 *  - "Settled 2s": chỉ coi trạng thái là xong khi file nguồn không đổi
 *    trong 2s liên tục (`waitSettled`) — tránh đọc file đang ghi dở.
 *  - Ghi nguyên tử: ghi file tạm trong cùng thư mục + rename.
 *  - Quyền: file state 0600, thư mục auth 0700 (box.ts tạo authDir
 *    với 0700; ở đây chmod lại cho chắc khi thư mục đã tồn tại).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { SignInState, SignInStatus } from './types';

export const SIGNIN_SETTLE_MS = 2000;

const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Tên file state của một provider trong authDir. */
export function signInStateFileName(provider: string): string {
  if (!PROVIDER_RE.test(provider)) {
    throw new Error(`Invalid provider "${provider}": use letters, digits, ".", "-" and "_" only.`);
  }
  return `${provider}.state.json`;
}

/**
 * Chờ file "settled": mtime + size không đổi trong `settleMs` liên tục.
 * Trả true khi settled, false khi hết `timeoutMs` mà file vẫn đổi.
 * File không tồn tại → false ngay (không có gì để đồng bộ).
 */
export async function waitSettled(
  filePath: string,
  opts: { settleMs?: number; timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const settleMs = opts.settleMs ?? SIGNIN_SETTLE_MS;
  const timeoutMs = opts.timeoutMs ?? settleMs * 5 + 5000;
  const pollMs = opts.pollMs ?? 100;
  const startedAt = Date.now();
  let lastKey: string | null = null;
  let stableSince = Date.now();
  for (;;) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return false;
    }
    const key = `${stat.mtimeMs}:${stat.size}`;
    const now = Date.now();
    if (key !== lastKey) {
      lastKey = key;
      stableSince = now;
    } else if (now - stableSince >= settleMs) {
      return true;
    }
    if (now - startedAt > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function ensureAuthDir(authDir: string): void {
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(authDir, 0o700);
  } catch {
    // chmod lỗi trên FS không hỗ trợ quyền unix — bỏ qua, file vẫn 0600.
  }
}

function validateSignInState(state: SignInState): SignInState {
  if (!PROVIDER_RE.test(state.provider)) {
    throw new Error(`Invalid provider "${state.provider}".`);
  }
  const status: SignInStatus = state.status;
  if (status !== 'signed-in' && status !== 'signed-out' && status !== 'unknown') {
    throw new Error(`Invalid sign-in status "${String(status)}".`);
  }
  // Không bao giờ cho token/secret lọt vào state (caller vô tình đưa
  // cả object credential): chặn key trông giống secret ở top-level.
  for (const key of Object.keys(state as unknown as Record<string, unknown>)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE|BEARER|COOKIE/i.test(key)) {
      throw new Error(
        `Sign-in state must not contain secret field "${key}" — sync status + label only, never tokens.`,
      );
    }
  }
  if (state.accountLabel !== undefined && state.accountLabel.length > 200) {
    throw new Error('accountLabel too long (max 200 chars).');
  }
  return {
    provider: state.provider,
    ...(state.accountLabel !== undefined ? { accountLabel: state.accountLabel } : {}),
    status,
    observedAt: state.observedAt,
    ...(state.source !== undefined ? { source: state.source } : {}),
  };
}

/**
 * Ghi trạng thái đăng nhập xuống authDir của box — ghi nguyên tử
 * (file tạm + rename), file 0600, thư mục 0700. Trả về đường dẫn file.
 * KHÔNG ghi token/secret (validate chặn key giống secret).
 */
export function writeSignInState(authDir: string, state: SignInState): string {
  const clean = validateSignInState(state);
  ensureAuthDir(authDir);
  const filePath = path.join(authDir, signInStateFileName(clean.provider));
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // FS không hỗ trợ quyền unix — bỏ qua.
  }
  fs.renameSync(tmp, filePath);
  return filePath;
}

/** Đọc trạng thái đăng nhập đã đồng bộ (null khi chưa có). */
export function readSignInState(authDir: string, provider: string): SignInState | null {
  const filePath = path.join(authDir, signInStateFileName(provider));
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as SignInState;
    return validateSignInState(raw);
  } catch {
    return null;
  }
}

/** Liệt kê mọi trạng thái đăng nhập đã đồng bộ trong authDir. */
export function listSignInStates(authDir: string): SignInState[] {
  if (!fs.existsSync(authDir)) return [];
  const out: SignInState[] = [];
  for (const entry of fs.readdirSync(authDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.state.json')) continue;
    try {
      out.push(validateSignInState(JSON.parse(fs.readFileSync(path.join(authDir, entry.name), 'utf8')) as SignInState));
    } catch {
      // File hỏng — bỏ qua, không crash.
    }
  }
  out.sort((a, b) => a.provider.localeCompare(b.provider));
  return out;
}

/**
 * Đồng bộ đầy đủ: chờ file nguồn settled 2s rồi ghi state.
 * `sourceFile` là file mà CLI trong box ghi trạng thái vào (vd file
 * marker do driver tạo — KHÔNG phải file credential thô). Khi không có
 * sourceFile thì ghi state ngay (caller đã quan sát xong).
 * Trả về đường dẫn file state, hoặc null khi sourceFile không settled.
 */
export async function syncSignInState(
  authDir: string,
  state: SignInState,
  opts: { sourceFile?: string; settleMs?: number; timeoutMs?: number } = {},
): Promise<string | null> {
  if (opts.sourceFile !== undefined) {
    const settled = await waitSettled(opts.sourceFile, {
      ...(opts.settleMs !== undefined ? { settleMs: opts.settleMs } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    if (!settled) return null;
  }
  return writeSignInState(authDir, state);
}
