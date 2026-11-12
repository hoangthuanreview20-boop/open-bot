/**
 * Aider provider (M4) — driver Aider qua one-shot `--message`.
 *
 * Lệnh spawn theo docs Aider công khai (aider.chat, cheat sheet đã
 * kiểm chứng trên Aider 0.86.2) + lưu ý bảo mật AgenticBench AID-1
 * (26/10/2026):
 *
 *   aider --message "<prompt>" --yes-always --no-auto-commits --no-pretty
 *
 * - **`--message`**: gửi một message rồi thoát — chế độ
 *   non-interactive chính thức của Aider (cùng `--message-file` để
 *   đọc prompt từ file). Không có JSON/stream-JSON: output là text
 *   thô trên stdout nên driver parse text (xem oneShot.ts).
 * - **`--yes-always`**: tự xác nhận mọi prompt trong turn. Đây là cờ
 *   dành cho chạy unattended — và theo AgenticBench, `--yes-always`
 *   CỐ TÌNH từ chối chạy shell command do model đề xuất (chỉ các
 *   prompt sửa file/… mới được auto-yes). Driver KHÔNG truyền thêm
 *   cờ nào mở rộng quyền shell.
 * - **`--no-auto-commits`**: Aider mặc định commit mỗi lần sửa file
 *   (git-native). open-bot TẮT auto-commit để một turn chat không âm
 *   thầm tạo commit trong repo của user — user tự commit khi hài
 *   lòng. Git repo-map/context vẫn bật bình thường.
 * - **`--no-pretty`**: tắt render màu/markdown của terminal để
 *   stdout dễ parse (docs Aider FAQ dùng `--verbose --no-pretty`
 *   cho mục đích tương tự).
 * - **stdin giữ mở suốt turn** (`stdinBehavior: 'keep-open'`): theo
 *   AgenticBench AID-1, khi stdin của Aider chạm EOF (vd `< /dev/null`
 *   hay pipe đã đóng), Aider trả lời YES cho prompt "Run shell
 *   command?" — nguy hiểm hơn cả `--yes-always`. Giữ stdin mở là
 *   lớp phòng thủ thêm (xem oneShot.ts).
 * - **Auth = API key của CHÍNH user cho CHÍNH CLI của họ.**
 *   Aider không có tài khoản đăng nhập — nó chạy bằng key của
 *   provider (detector 'env-present': chỉ kiểm tra TÊN biến tồn tại,
 *   không đọc giá trị). Driver cho đúng 7 tên biến key đã xét chui
 *   qua env sanitization (`AIDER_KEY_ENV_VARS` dưới đây — cùng danh
 *   sách detector dùng ở detected/definitions.ts); mọi biến secret
 *   khác vẫn bị chặn. Không bao giờ log giá trị key. Key của provider
 *   nào không có trong danh sách thì Aider tự báo lỗi rõ khi chạy
 *   (driver không đoán thêm tên biến).
 * - **Usage best-effort:** Aider in dòng tóm tắt `Tokens: … sent,
 *   … received` cuối turn — driver parse dòng đó (hậu tố k/M) khi
 *   có; không có thì usage bỏ trống, không bịa số.
 * - **Model:** không truyền `--model` — Aider dùng model đã cấu
 *   hình của nó (`.aider.conf.yml` / `--model` của user).
 *
 * CHƯA KIỂM CHỨNG trên Aider thật (máy này không có `aider`): cờ
 * spawn + dòng `Tokens:` mới chỉ khớp docs công khai + cheat sheet
 * đã kiểm chứng trên 0.86.2. Cần chạy thật trên máy có Aider + key
 * trước khi coi M4 là xong (xem providers/cli/README.md).
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { ProviderConfig } from '../../types';
import { BaseOneShotCliProvider, stripAnsi } from './oneShot';
import type { OneShotCliProviderOptions } from './oneShot';
import type { CliEvent } from './types';
import { AIDER_MODEL_ID, AIDER_PROVIDER_ID } from './types';

/** Timeout mặc định cho một turn qua Aider (ms). */
export const AIDER_CLI_DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Tên biến API key được phép chui qua env sanitization cho Aider —
 * ĐÚNG danh sách detector dùng (detected/definitions.ts
 * `AIDER_KEY_ENV_LABELS`). Chỉ TÊN biến được phép; giá trị không bao
 * giờ được đọc/log. Đây là key của CHÍNH user cho CHÍNH CLI của họ
 * (Aider không chạy được nếu thiếu key), cùng lý lẽ như
 * `CLAUDE_CODE_OAUTH_TOKEN` ở claude.ts.
 */
export const AIDER_KEY_ENV_VARS: readonly string[] = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
];

/** argv one-shot của Aider (prompt đã render đầy đủ, xem oneShot.ts). */
export function aiderOneShotArgs(prompt: string): string[] {
  return ['--message', prompt, '--yes-always', '--no-auto-commits', '--no-pretty'];
}

/** Parse số token Aider in (vd '1.2k' → 1200, '1,234' → 1234). */
function parseTokenCount(raw: string, suffix: string | undefined): number | null {
  const num = Number.parseFloat(raw.replace(/,/g, ''));
  if (!Number.isFinite(num)) return null;
  const mult = suffix === 'k' || suffix === 'K' ? 1_000 : suffix === 'M' || suffix === 'm' ? 1_000_000 : 1;
  return Math.round(num * mult);
}

/**
 * Tách usage best-effort từ dòng tóm tắt cuối output của Aider
 * (`Tokens: 1.2k sent, 300 received, …`). Không khớp thì trả
 * undefined — không bịa số.
 */
export function parseAiderUsage(
  stdout: string,
): { inputTokens: number; outputTokens: number } | undefined {
  const m =
    /Tokens:\s*([\d.,]+)\s*([kKmM])?\s*sent,\s*([\d.,]+)\s*([kKmM])?\s*received/i.exec(stdout);
  if (!m) return undefined;
  const inputTokens = parseTokenCount(m[1] as string, m[2]);
  const outputTokens = parseTokenCount(m[3] as string, m[4]);
  if (inputTokens === null || outputTokens === null) return undefined;
  return { inputTokens, outputTokens };
}

export interface AiderCliProviderOptions {
  /** Đường dẫn tuyệt đối tới binary `aider` (do detector tìm thấy). Bắt buộc. */
  binaryPath: string;
  /** Thư mục làm việc cho process CLI (mặc định process.cwd()). */
  cwd?: string;
  /** Timeout một turn (ms); mặc định 5 phút. */
  timeoutMs?: number;
  /** Biến env riêng của CLI được phép truyền thêm (mặc định 7 biến key ở trên). */
  extraEnvAllowed?: string[];
  /** Callback nhận event chuẩn của CLI (text/result/error). */
  onCliEvent?: (event: CliEvent) => void;
  /** M5 — sink event của harness (bus + NDJSON log). */
  harnessSink?: (event: CliEvent) => void;
  /** Nơi ghi cảnh báo. */
  logger?: { warn(message: string): void };
  /** Hàm spawn (mặc định spawnCli thật; test inject fake). */
  spawn?: (
    binary: string,
    args: string[],
    options: { cwd?: string; env: NodeJS.ProcessEnv },
  ) => ChildProcessWithoutNullStreams;
}

export class AiderCliProvider extends BaseOneShotCliProvider {
  constructor(config: ProviderConfig, options: AiderCliProviderOptions) {
    const baseOptions: OneShotCliProviderOptions = {
      binaryPath: options.binaryPath,
      buildArgs: aiderOneShotArgs,
      extraEnvAllowed: options.extraEnvAllowed ?? [...AIDER_KEY_ENV_VARS],
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      onCliEvent: options.onCliEvent,
      harnessSink: options.harnessSink,
      logger: options.logger,
      spawn: options.spawn,
      // Giữ stdin mở suốt turn (xem đầu file — AgenticBench AID-1).
      stdinBehavior: 'keep-open',
      parseOutput: (stdout) => {
        const text = stripAnsi(stdout);
        const usage = parseAiderUsage(stdout);
        return usage ? { text, usage } : { text };
      },
    };
    super(
      config,
      {
        providerId: AIDER_PROVIDER_ID,
        modelId: AIDER_MODEL_ID,
        displayName: 'Aider',
      },
      baseOptions,
    );
  }
}
