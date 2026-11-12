/**
 * Kiro CLI provider (v0.76) — driver Kiro CLI (`kiro-cli`) qua one-shot
 * `chat --no-interactive`.
 *
 * Lệnh spawn theo docs chính thức của Kiro (kiro.dev/docs/reference/
 * cli-commands/ + kiro.dev/docs/cli/headless/, tra cứu 2026-11-11):
 *
 *   kiro-cli chat --no-interactive "<prompt>"
 *
 * - **`chat [INPUT]`**: prompt là đối số vị trí (KHÔNG có cờ
 *   `--input` như Amazon Q — Q dùng `--input`, Kiro dùng positional
 *   `INPUT`; docs headless cũng chấp nhận prompt qua stdin khi không
 *   có positional, nhưng driver này truyền positional để khỏi phụ
 *   thuộc hành vi stdin của tầng one-shot).
 * - **`--no-interactive`**: in đáp án đầu tiên ra stdout rồi thoát,
 *   không mở TUI. Không có prompt thì CLI lỗi (yêu cầu "a non-empty
 *   instruction") — driver LUÔN truyền prompt đã render đầy đủ nên
 *   không rơi vào nhánh đó.
 * - **Fail-closed về quyền:** driver KHÔNG truyền `--trust-all-tools`
 *   hay `--trust-tools`. Ở chế độ non-interactive, tool nào cần duyệt
 *   thì CLI LỖI thay vì hỏi (cùng hành vi đã ghi cho Q) — đúng hành
 *   vi fail-closed open-bot muốn: chỉ đọc/trả lời text được phép,
 *   còn sửa file/chạy shell phải có người duyệt (hiện chưa có đường
 *   duyệt cho Kiro — follow-up, như Q).
 * - **Không ghim harness V2/V3:** headless local không nêu harness
 *   thì chạy V2 theo mặc định của CLI (docs headless); `--v3`/`--v2`
 *   chỉ thêm khi có lý do rõ ràng — tránh phụ thuộc mặc định đổi
 *   theo bản (3.0.0 đã đổi mặc định interactive sang V3).
 * - **Auth = đăng nhập tương tác của CHÍNH user** (`kiro-cli login`:
 *   Builder ID / IAM Identity Center / Google / GitHub — detector
 *   dùng `kiro-cli whoami --format json`). CLI tự đọc credential từ
 *   `KIRO_HOME` (mặc định `~/.kiro`); driver chỉ cho thêm `KIRO_HOME`
 *   (đường dẫn, không phải secret) chui qua env sanitization.
 *   `KIRO_API_KEY` KHÔNG được truyền (secret — key headless chỉ
 *   dùng cho Pro/Pro+/Power; user nào chỉ có API key mà chưa từng
 *   `kiro-cli login` thì detector báo chưa đăng nhập, đúng
 *   fail-closed: open-bot không bao giờ cầm key của user).
 * - **Model:** không truyền `--model` — Kiro dùng model mặc định
 *   của nó (đổi bằng `kiro-cli settings chat.defaultModel`).
 * - **Binary dò:** chỉ `kiro-cli`. Bí danh `kiro` KHÔNG dò — với
 *   command router, `kiro` có thể mở Kiro IDE thay vì CLI (docs:
 *   "`kiro-cli` — Always launches CLI").
 * - **ACP là follow-up:** `kiro-cli acp` (subcommand ẩn, JSON-RPC
 *   qua stdio) tồn tại, nhưng one-shot đã đủ cho turn text; ACP chỉ
 *   thêm khi cần session sống / tool event chi tiết.
 *
 * CHƯA KIỂM CHỨNG trên `kiro-cli` thật (máy này không có `kiro-cli`):
 * cờ spawn mới chỉ khớp docs chính thức. Cần chạy thật trên máy có
 * Kiro CLI đăng nhập trước khi coi v0.76 là xong (xem
 * providers/cli/README.md).
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { ProviderConfig } from '../../types';
import { BaseOneShotCliProvider } from './oneShot';
import type { OneShotCliProviderOptions } from './oneShot';
import type { CliEvent } from './types';
import { KIRO_CLI_MODEL_ID, KIRO_CLI_PROVIDER_ID } from './types';

/** Timeout mặc định cho một turn qua Kiro CLI (ms). */
export const KIRO_CLI_DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Biến env được phép chui qua env sanitization cho Kiro CLI:
 * `KIRO_HOME` (đường dẫn thư mục cấu hình/đăng nhập, không phải
 * secret). `KIRO_API_KEY` KHÔNG được truyền — xem header.
 */
export const KIRO_CLI_ENV_VARS: readonly string[] = ['KIRO_HOME'];

/**
 * argv one-shot của Kiro CLI (prompt đã render đầy đủ, xem oneShot.ts).
 * Prompt là đối số vị trí của `chat` — theo docs chính thức; prompt
 * luôn bắt đầu bằng system prompt hoặc nhãn `User:` do
 * `renderOneShotPrompt` thêm nên không bị nhầm thành cờ.
 */
export function kiroCliOneShotArgs(prompt: string): string[] {
  return ['chat', '--no-interactive', prompt];
}

export interface KiroCliProviderOptions {
  /** Đường dẫn tuyệt đối tới binary `kiro-cli` (do detector tìm thấy). Bắt buộc. */
  binaryPath: string;
  /** Thư mục làm việc cho process CLI (mặc định process.cwd()). */
  cwd?: string;
  /** Timeout một turn (ms); mặc định 5 phút. */
  timeoutMs?: number;
  /** Biến env riêng của CLI được phép truyền thêm (mặc định KIRO_HOME). */
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

export class KiroCliProvider extends BaseOneShotCliProvider {
  constructor(config: ProviderConfig, options: KiroCliProviderOptions) {
    const baseOptions: OneShotCliProviderOptions = {
      binaryPath: options.binaryPath,
      buildArgs: kiroCliOneShotArgs,
      extraEnvAllowed: options.extraEnvAllowed ?? [...KIRO_CLI_ENV_VARS],
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      onCliEvent: options.onCliEvent,
      harnessSink: options.harnessSink,
      logger: options.logger,
      spawn: options.spawn,
    };
    super(
      config,
      {
        providerId: KIRO_CLI_PROVIDER_ID,
        modelId: KIRO_CLI_MODEL_ID,
        displayName: 'Kiro CLI',
      },
      baseOptions,
    );
  }
}
