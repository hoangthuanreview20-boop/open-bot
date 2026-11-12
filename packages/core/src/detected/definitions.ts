/**
 * Khai báo detector có sẵn cho 6 CLI (M1).
 *
 * Mỗi mục ghi: binary nào, version tối thiểu nào, và kiểm tra đăng nhập
 * bằng cách nào. Cơ chế kiểm tra lấy từ docs/research-detected-cli-
 * providers.md (§2) và docs/research-openmausbot.md (§4.6):
 *
 * - Claude Code: `claude auth status --json` (lệnh của chính CLI).
 * - Codex: `codex login status` (hỏi Codex tự báo; KHÔNG đọc auth.json
 *   vì token có thể nằm ở keyring).
 * - Grok CLI: file `~/.grok/auth.json` (hoặc $GROK_HOME) CÓ TỒN TẠI
 *   không — Grok không có lệnh status; chỉ kiểm tra tồn tại, không đọc.
 * - OpenCode: `opencode auth list` (liệt kê provider đã lưu, không in secret).
 * - Gemini CLI: nhãn từ `~/.gemini/google_accounts.json` (chỉ email,
 *   không token); `oauth_creds.json` (chứa token) chỉ kiểm tra tồn tại.
 * - Cursor CLI: `cursor-agent status --format json`.
 *
 * LƯU Ý CHƯA KIỂM CHỨNG (ghi rõ — xem thêm detected/README.md): các
 * lệnh/output trên đều từ docs/code công khai, CHƯA chạy trên máy thật
 * có CLI đăng nhập. Parser nào cũng phòng thủ: field lạ/thiếu thì trả
 * "đã đăng nhập, không rõ nhãn" thay vì crash; JSON hỏng thì coi như
 * chưa đăng nhập kèm lý do.
 *
 * Sóng B (đội platform): +5 CLI (tổng 11). Cơ chế kiểm tra lấy từ docs
 * công khai của từng CLI, tra cứu ngày 2026-11-10 (xem detected/README.md):
 *
 * - Aider: KHÔNG có tài khoản đăng nhập — chỉ chạy bằng API key của
 *   provider (env var OPENAI_API_KEY / ANTHROPIC_API_KEY / ... hoặc
 *   file `.env` / `.aider.conf.yml`). Detector chỉ kiểm tra TÊN biến
 *   môi trường có tồn tại không (kiểu 'env-present') — KHÔNG BAO GIỜ
 *   đọc giá trị key. Nhãn chỉ nêu họ key (vd 'OpenAI API key').
 * - Continue (`cn`): lần chạy đầu hỏi đăng nhập Continue (`cn login`)
 *   hoặc nhập Anthropic API key, rồi ghi `~/.continue/config.yaml`.
 *   Detector chỉ kiểm tra file config CÓ TỒN TẠI không (không đọc nội
 *   dung — file có thể chứa key). LƯU Ý: Continue bị Cursor mua lại
 *   tháng 6/2026, repo chỉ còn đọc, bản CLI cuối 1.5.47 không còn lệnh
 *   login — lần chạy đầu hỏi API key rồi ghi config.yaml.
 * - GitHub Copilot CLI (`copilot`): chính CLI KHÔNG có lệnh status
 *   (`copilot login status` bị từ chối; không có `status`/`whoami`).
 *   Chế độ headless của nó yêu cầu GitHub CLI đã đăng nhập, nên
 *   detector hỏi `gh auth status` (binary 'gh', kiểu 'command' + binary
 *   override) và lấy username từ dòng 'Logged in to github.com as X'.
 *   Không có `gh` thì coi như chưa kiểm chứng được đăng nhập.
 * - Amazon Q CLI (`q`): `q whoami` hiện trạng thái đăng nhập + user
 *   (Builder ID / IAM Identity Center). LƯU Ý: repo open-source chỉ còn
 *   bảo trì từ 11/2025, bản kế tiếp là Kiro CLI (đóng nguồn) — detector
 *   vẫn dò được `q` đã cài.
 * - Kiro CLI (`kiro-cli`, v0.76): `kiro-cli whoami --format json`
 *   (docs kiro.dev, tra cứu 2026-11-11). Chỉ dò binary `kiro-cli` —
 *   bí danh `kiro` có thể mở Kiro IDE qua command router nên không dò.
 *   Auth headless bằng `KIRO_API_KEY` (Pro+) KHÔNG được coi là bằng
 *   chứng riêng: detector chỉ tin `whoami` (fail-closed).
 * - Windsurf: `windsurf` là launcher của editor; CLI thừa hưởng trạng
 *   thái đăng nhập trong editor, KHÔNG có lệnh status riêng. Detector
 *   dùng kiểu 'none' → trạng thái 'unknown' (không bịa là đã đăng
 *   nhập), như CLI ACP tuỳ chỉnh. LƯU Ý: Windsurf đổi tên thành Devin
 *   Desktop năm 2026 (lệnh mới `devin-desktop`, lệnh cũ vẫn chạy);
 *   CLI agent thật nay là Devin CLI — binary `devin` (`devin acp`
 *   nói ACP) nên detector dò `devin` trước (M4, xem windsurf.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  AuthCheck,
  DetectorDefinition,
  EngineAccount,
  ProbeResult,
} from './types';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** Tìm email đầu tiên trong một chuỗi (nhãn tài khoản dạng email). */
function findEmail(text: string): string | undefined {
  return EMAIL_RE.exec(text)?.[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Tìm chuỗi tại một trong các đường dẫn key (vd 'account.email') trong
 * object JSON đã parse. Trả undefined khi không thấy.
 */
function findStringField(obj: unknown, keyPaths: string[]): string | undefined {
  if (!isRecord(obj)) return undefined;
  for (const keyPath of keyPaths) {
    const parts = keyPath.split('.');
    let cur: unknown = obj;
    for (const part of parts) {
      if (!isRecord(cur)) {
        cur = undefined;
        break;
      }
      cur = cur[part];
    }
    if (typeof cur === 'string' && cur.trim().length > 0) return cur.trim();
  }
  return undefined;
}

/**
 * Tìm email ở bất kỳ đâu trong JSON (sâu tối đa 3 tầng, chỉ qua key
 * chứa 'email'/'account'/'user'). Phòng thủ cho trường hợp shape thật
 * khác shape docs ghi.
 */
function findEmailDeep(obj: unknown, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  if (typeof obj === 'string') return findEmail(obj);
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findEmailDeep(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(obj)) return undefined;
  for (const [key, value] of Object.entries(obj)) {
    if (!/email|account|user/i.test(key)) continue;
    const found = findEmailDeep(value, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** Parse JSON output của lệnh status; trả null khi không phải JSON. */
function parseJsonOutput(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Parser chung cho lệnh status trả JSON: exit != 0 = chưa đăng nhập;
 * JSON có field báo đã đăng nhập sai (vd loggedIn: false) = chưa đăng
 * nhập; còn lại = đã đăng nhập, nhãn = email (ưu tiên) rồi tên/org.
 */
function parseJsonStatus(
  result: ProbeResult,
  opts: { method: EngineAccount['method']; labelKeys?: string[]; orgKeys?: string[] },
): EngineAccount | null {
  if (result.code !== 0) return null;
  const parsed = parseJsonOutput(result.stdout);
  if (parsed) {
    // Một số CLI trả cờ loggedIn/signedIn tường minh.
    for (const key of ['loggedIn', 'signedIn', 'authenticated', 'isLoggedIn']) {
      if (parsed[key] === false) return null;
    }
    const email =
      findStringField(parsed, opts.labelKeys ?? ['email', 'account.email', 'user.email', 'oauthAccount.email']) ??
      findEmailDeep(parsed);
    const org = findStringField(parsed, opts.orgKeys ?? ['organization', 'org', 'account.organization']);
    const label = email ?? org;
    return { label, method: opts.method };
  }
  // Không phải JSON nhưng exit 0: có thể là CLI cũ in text — coi là đã
  // đăng nhập nếu stdout nhắc tới đăng nhập, nhãn lấy email trong text.
  const email = findEmail(result.stdout);
  if (/log(ged)? ?in|signed ?in|authenticated/i.test(result.stdout) || email) {
    return { label: email, method: opts.method };
  }
  // Exit 0 mà không đọc được gì: vẫn coi là đã đăng nhập (lệnh status
  // của CLI là nguồn đúng nhất), chỉ không có nhãn.
  return { method: opts.method };
}

/** Parser cho lệnh status trả text: exit != 0 = chưa đăng nhập. */
function parseTextStatus(
  result: ProbeResult,
  opts: { method: EngineAccount['method'] },
): EngineAccount | null {
  if (result.code !== 0) return null;
  const lower = result.stdout.toLowerCase();
  // Từ chối tường minh trong text ("not logged in", "not signed in").
  if (/not (logged|signed) in|no .*login|logged out|signed out/.test(lower)) return null;
  return { label: findEmail(result.stdout), method: opts.method };
}

const CLAUDE_AUTH: AuthCheck = {
  type: 'command',
  args: ['auth', 'status', '--json'],
  parse: (result) => parseJsonStatus(result, { method: 'subscription' }),
};

const CODEX_AUTH: AuthCheck = {
  type: 'command',
  args: ['login', 'status'],
  parse: (result) => parseTextStatus(result, { method: 'subscription' }),
};

const OPENCODE_AUTH: AuthCheck = {
  type: 'command',
  args: ['auth', 'list'],
  parse: (result) => {
    if (result.code !== 0) return null;
    // Mỗi dòng dạng "Anthropic (oauth)" / "GitHub Copilot (oauth)" /
    // "OpenAI (api)" — gom tên provider làm nhãn (không secret).
    const providers: string[] = [];
    for (const line of result.stdout.split('\n')) {
      const m = /^\s*([A-Za-z0-9 ._-]+)\s+\((oauth|api)\)\s*$/i.exec(line.trim());
      if (m) providers.push(m[1].trim());
    }
    if (providers.length === 0) {
      // Exit 0 nhưng không liệt kê được provider nào: vẫn coi là đã
      // đăng nhập (lệnh list là nguồn đúng nhất), chỉ không có nhãn.
      return { method: 'oauth' };
    }
    return { label: providers.slice(0, 3).join(', '), method: 'oauth' };
  },
};

const CURSOR_AUTH: AuthCheck = {
  type: 'command',
  args: ['status', '--format', 'json'],
  parse: (result) => parseJsonStatus(result, { method: 'subscription' }),
};

/** Grok: không có lệnh status — file auth.json tồn tại = đã đăng nhập. */
const GROK_AUTH: AuthCheck = {
  type: 'file-exists',
  paths: (homeDir, env) => {
    const grokHome = env.GROK_HOME?.trim();
    if (grokHome) return [path.join(grokHome, 'auth.json')];
    return [path.join(homeDir, '.grok', 'auth.json')];
  },
  accountLabel: undefined,
};

/**
 * Gemini: nhãn từ `google_accounts.json` (CHỈ email, không token);
 * `oauth_creds.json` (chứa token) chỉ kiểm tra TỒN TẠI, không đọc nội
 * dung. Đọc file nhãn hỏng thì coi như chưa rõ nhãn, không crash.
 */
const GEMINI_AUTH: AuthCheck = {
  type: 'file-label',
  readLabel: (homeDir, env) => {
    const geminiHome = env.GEMINI_CLI_HOME?.trim();
    const dir = geminiHome ? path.resolve(geminiHome) : path.join(homeDir, '.gemini');
    const labelPath = path.join(dir, 'google_accounts.json');
    try {
      const raw = fs.readFileSync(labelPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const email =
        findStringField(parsed, ['activeAccount', 'active_account', 'email']) ??
        findEmailDeep(parsed);
      if (email) return { label: email, method: 'oauth' };
    } catch {
      // Không có file nhãn hoặc hỏng — thử bằng chứng đăng nhập còn lại.
    }
    // Chỉ kiểm tra TỒN TẠI của file token — không đọc nội dung.
    try {
      if (fs.existsSync(path.join(dir, 'oauth_creds.json'))) {
        return { method: 'oauth' };
      }
    } catch {
      // existsSync hiếm khi throw; bỏ qua.
    }
    return null;
  },
};

// --- Sóng B (đội platform): 5 CLI mới ------------------------------------

/**
 * Aider: không có tài khoản đăng nhập — chỉ chạy bằng API key của
 * provider (env var). Nhãn chỉ nêu HỌ key, không bao giờ là giá trị.
 */
const AIDER_KEY_ENV_LABELS: Record<string, string> = {
  OPENAI_API_KEY: 'OpenAI API key',
  ANTHROPIC_API_KEY: 'Anthropic API key',
  GEMINI_API_KEY: 'Gemini API key',
  DEEPSEEK_API_KEY: 'DeepSeek API key',
  OPENROUTER_API_KEY: 'OpenRouter API key',
  XAI_API_KEY: 'xAI API key',
  GROQ_API_KEY: 'Groq API key',
};

const AIDER_AUTH: AuthCheck = {
  type: 'env-present',
  envNames: Object.keys(AIDER_KEY_ENV_LABELS),
  labelForEnv: (name) => AIDER_KEY_ENV_LABELS[name] ?? name,
};

/**
 * Continue (`cn`): lần chạy đầu ghi `~/.continue/config.yaml` (sau khi
 * đăng nhập Continue hoặc nhập Anthropic API key). Chỉ kiểm tra TỒN
 * TẠI của file — không đọc nội dung (file có thể chứa key).
 */
const CONTINUE_AUTH: AuthCheck = {
  type: 'file-exists',
  paths: (homeDir) => [path.join(homeDir, '.continue', 'config.yaml')],
  method: 'api-key',
};

/**
 * GitHub Copilot CLI: chính CLI không có lệnh status — hỏi `gh auth
 * status` (GitHub CLI) vì chế độ headless của Copilot yêu cầu `gh`
 * đã đăng nhập. Username lấy từ dòng 'Logged in to github.com as X'.
 */
const COPILOT_AUTH: AuthCheck = {
  type: 'command',
  binary: 'gh',
  args: ['auth', 'status'],
  parse: (result) => {
    if (result.code !== 0) return null;
    const m = /Logged in to github\.com as ([^\s()]+)/i.exec(result.stdout);
    if (m) return { label: m[1], method: 'oauth' };
    if (/not logged in|not authenticated/i.test(result.stdout)) return null;
    // Exit 0 nhưng không đọc được user: đã đăng nhập, không rõ nhãn.
    return { method: 'oauth' };
  },
};

/** Amazon Q CLI: `q whoami` hiện trạng thái đăng nhập + user. */
const AMAZONQ_AUTH: AuthCheck = {
  type: 'command',
  args: ['whoami'],
  parse: (result) => parseTextStatus(result, { method: 'oauth' }),
};

/**
 * Kiro CLI: `kiro-cli whoami --format json` hiện trạng thái đăng nhập +
 * user (Builder ID / IAM Identity Center / social — docs kiro.dev
 * "CLI commands", tra cứu 2026-11-11). Shape JSON chưa được docs ghi
 * rõ nên parser phòng thủ như parseJsonStatus (cờ loggedIn, email ở
 * nhiều key, fallback text) + từ chối tường minh khi text báo chưa
 * đăng nhập (trường hợp JSON lỗi có field error mà exit vẫn 0).
 * Chưa đăng nhập thì `whoami` lỗi (docs: "Not logged in error").
 */
const KIRO_AUTH: AuthCheck = {
  type: 'command',
  args: ['whoami', '--format', 'json'],
  parse: (result) => {
    if (result.code !== 0) return null;
    if (/not (logged|signed) in|not authenticated|logged out|signed out/i.test(result.stdout)) {
      return null;
    }
    return parseJsonStatus(result, {
      method: 'oauth',
      labelKeys: ['email', 'account.email', 'user.email', 'profile.email', 'username', 'user.name'],
      orgKeys: ['organization', 'org', 'account.organization', 'profile'],
    });
  },
};

/**
 * Windsurf: CLI thừa hưởng trạng thái đăng nhập trong editor, không có
 * lệnh status riêng — dùng kiểu 'none' → trạng thái 'unknown' (không
 * bịa là đã đăng nhập), như CLI ACP tuỳ chỉnh.
 *
 * M4 (driver): Windsurf đổi tên thành Devin Desktop tháng 6/2026,
 * CLI agent đi kèm nay là Devin CLI — binary `devin` (`devin acp`
 * nói ACP, xem providers/cli/windsurf.ts). Detector dò `devin`
 * TRƯỚC `windsurf`/`devin-desktop` (launcher của editor, không có
 * chế độ agent headless — driver từ chối binary này) để binaryPath
 * trả về là binary driver dùng được khi user đã cài Devin CLI.
 */
const WINDSURF_AUTH: AuthCheck = { type: 'none' };

/**
 * Bảng detector có sẵn. Thêm CLI mới = thêm một mục vào đây (hoặc gọi
 * `registry.registerDetector()`), không sửa registry.
 *
 * minVersion: chỉ đặt khi có mốc đã kiểm chứng qua docs/code —
 * Claude 2.1.318 là bản đầu tiên có `auth status --json` kèm
 * `loginExpiresAt` (docs Anthropic, xem research doc §2.2); Grok 1.0.0
 * là bản OpenMausBot đã kiểm chứng driver ACP. Các CLI còn lại chưa có
 * mốc tối thiểu được ghi nhận nên để '' (chấp nhận mọi version, version
 * thật vẫn ghi vào snapshot).
 */
export const BUILTIN_DETECTORS: DetectorDefinition[] = [
  {
    kind: 'claude',
    label: 'Claude Code',
    binaries: ['claude'],
    minVersion: '2.1.318',
    versionArgs: ['--version'],
    auth: CLAUDE_AUTH,
  },
  {
    kind: 'codex',
    label: 'Codex',
    binaries: ['codex'],
    minVersion: '',
    versionArgs: ['--version'],
    auth: CODEX_AUTH,
  },
  {
    kind: 'grok',
    label: 'Grok CLI',
    binaries: ['grok'],
    minVersion: '1.0.0',
    versionArgs: ['--version'],
    auth: GROK_AUTH,
  },
  {
    kind: 'opencode',
    label: 'OpenCode',
    binaries: ['opencode'],
    minVersion: '',
    versionArgs: ['--version'],
    auth: OPENCODE_AUTH,
  },
  {
    kind: 'gemini',
    label: 'Gemini CLI',
    binaries: ['gemini'],
    minVersion: '',
    versionArgs: ['--version'],
    auth: GEMINI_AUTH,
  },
  {
    kind: 'cursor',
    label: 'Cursor CLI',
    binaries: ['cursor-agent', 'agent'],
    minVersion: '',
    versionArgs: ['--version'],
    auth: CURSOR_AUTH,
  },
  // Sóng B (đội platform): 5 CLI mới — driver đã có ở M4 (sóng B):
  // Aider / Continue / Amazon Q qua tầng one-shot (oneShot.ts),
  // Copilot CLI + Windsurf (Devin CLI) qua tầng ACP (xem
  // providers/cli/README.md mục "Sóng B").
  {
    kind: 'aider',
    label: 'Aider',
    binaries: ['aider'],
    minVersion: '',
    versionArgs: ['--version'],
    auth: AIDER_AUTH,
  },
  {
    kind: 'continue',
    label: 'Continue',
    binaries: ['cn'],
    minVersion: '',
    versionArgs: ['--version'],
    auth: CONTINUE_AUTH,
  },
  {
    kind: 'copilot',
    label: 'GitHub Copilot CLI',
    binaries: ['copilot'],
    minVersion: '',
    versionArgs: ['--version'],
    auth: COPILOT_AUTH,
  },
  {
    kind: 'amazonq',
    label: 'Amazon Q CLI',
    binaries: ['q'],
    minVersion: '',
    versionArgs: ['--version'],
    auth: AMAZONQ_AUTH,
  },
  {
    kind: 'windsurf',
    label: 'Windsurf',
    // M4: `devin` trước — Devin CLI là CLI agent thật của Windsurf/
    // Devin Desktop (`devin acp`); `windsurf`/`devin-desktop` chỉ là
    // launcher của editor (driver từ chối binary này, xem windsurf.ts).
    binaries: ['devin', 'windsurf', 'devin-desktop'],
    minVersion: '',
    versionArgs: ['--version'],
    auth: WINDSURF_AUTH,
  },
  // v0.76: Kiro CLI — kế tiếp của Amazon Q CLI (`q` → `kiro-cli`).
  // Detector dò `kiro-cli` (xem KIRO_AUTH); driver one-shot ở
  // providers/cli/kiroCli.ts.
  {
    kind: 'kiro',
    label: 'Kiro CLI',
    binaries: ['kiro-cli'],
    minVersion: '',
    versionArgs: ['--version'],
    auth: KIRO_AUTH,
  },
];
