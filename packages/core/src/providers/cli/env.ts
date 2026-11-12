/**
 * Env sanitization cho process con là CLI của user (M1).
 *
 * Bài học trực tiếp từ OpenMausBot (`server/drivers/acp/grok.ts`):
 * rò rỉ `XAI_API_KEY` vào env của turn Grok CLI sẽ âm thầm chuyển
 * subscription grok.com sang pay-as-you-go. Quy tắc chung cho mọi CLI:
 * **chỉ truyền env tối thiểu cần thiết** — allowlist tên biến, mọi thứ
 * khác (kể cả key của provider khác) đều bị chặn.
 *
 * Allowlist gồm:
 * - Biến hệ thống tối thiểu để CLI chạy được: PATH, HOME, USER,
 *   locale (LANG/LC_*), TERM, thư mục tạm, SHELL, TZ.
 * - Trên Windows thêm: SystemRoot, windir, USERPROFILE, APPDATA,
 *   LOCALAPPDATA (nhiều CLI cần để tìm home/config).
 * - Biến auth RIÊNG của chính CLI đó, do driver khai báo (vd Claude
 *   Code: `CLAUDE_CODE_OAUTH_TOKEN` — token OAuth mà user tự đặt cho
 *   chính CLI của họ; process con LÀ CLI của user nên đây không phải
 *   rò rỉ sang bên thứ ba, và không truyền thì user dùng env-token sẽ
 *   mất đăng nhập. Mặc định CLI đọc keychain/file nên biến này thường
 *   không cần).
 *
 * Mọi biến trông giống secret (KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL/
 * PRIVATE/AUTH/BEARER/SESSION/COOKIE…) mà KHÔNG nằm trong allowlist
 * đều bị chặn — kể cả khi user vô tình export chúng trong shell.
 */

const SECRET_NAME_RE = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|BEARER|SESSION|COOKIE/i;

/** Biến hệ thống tối thiểu, dùng chung mọi CLI (POSIX). */
const BASE_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SHELL',
  'TZ',
  'HOSTNAME',
];

/** Biến hệ thống tối thiểu thêm trên Windows. */
const WINDOWS_ALLOWLIST = [
  'SystemRoot',
  'windir',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'COMSPEC',
  'PATHEXT',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
];

/**
 * Dựng env cho process con từ env của process cha: chỉ giữ các biến
 * trong allowlist (+ `extraAllowed` của driver), bỏ mọi biến secret còn
 * lại. Không bao giờ throw; env thiếu PATH/HOME thì CLI vẫn spawn (nó
 * tự báo lỗi rõ ràng hơn là crash ở đây).
 */
export function sanitizeEnvForCli(
  baseEnv: NodeJS.ProcessEnv,
  extraAllowed: string[] = [],
): NodeJS.ProcessEnv {
  const allowed = new Set<string>([
    ...BASE_ALLOWLIST,
    ...(process.platform === 'win32' ? WINDOWS_ALLOWLIST : []),
    ...extraAllowed,
  ]);
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (!allowed.has(name)) continue;
    // Biến trong allowlist nhưng tên vẫn trông giống secret (vd một
    // driver khai thêm biến lạ) thì vẫn chặn — allowlist phải là tên
    // cụ thể đã xét, không phải wildcard.
    if (SECRET_NAME_RE.test(name) && !extraAllowed.includes(name)) continue;
    out[name] = value;
  }
  return out;
}

/** True khi tên biến trông giống secret (dùng để test + log cảnh báo). */
export function looksLikeSecret(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}
