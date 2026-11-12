/**
 * Amazon Q CLI provider (M4) — driver Amazon Q (`q`) qua one-shot
 * `chat --no-interactive`.
 *
 * Lệnh spawn theo source mở của Amazon Q Developer CLI
 * (`aws/amazon-q-developer-cli`, `crates/chat-cli/src/cli/chat/mod.rs`
 * — `ChatArgs`) + ghi nhận của AWS:
 *
 *   q chat --no-interactive --input "<prompt>"
 *
 * - **`--no-interactive`**: in đáp án đầu tiên rồi thoát, không mở
 *   chat TUI. Không có input thì CLI đọc stdin — driver LUÔN truyền
 *   `--input` nên không rơi vào nhánh đó.
 * - **`--input`**: prompt ban đầu ở chế độ non-interactive (theo
 *   `ChatArgs` trong source). Một số bản/build cũ còn nhận `--prompt`
 *   cho cùng mục đích; driver chỉ dùng `--input` (theo source hiện
 *   tại) — CLI cũ không nhận thì lỗi hiện rõ, không đoán thêm.
 * - **Fail-closed về quyền:** driver KHÔNG truyền
 *   `--trust-all-tools` (cờ auto-approve mọi tool). Ở chế độ
 *   non-interactive, tool nào cần duyệt thì CLI LỖI thay vì hỏi
 *   (ghi nhận trong phân tích CVE-2025-8217: `--no-interactive`
 *   "fails when a tool needs permission unless `--trust-all-tools`
 *   is also set") — đúng hành vi fail-closed open-bot muốn: chỉ
 *   đọc/trả lời text được phép, còn sửa file/chạy shell phải có
 *   người duyệt (hiện chưa có đường duyệt cho Q — follow-up).
 * - **Auth = Builder ID / IAM Identity Center của CHÍNH user**
 *   (`q whoami` — detector dùng lệnh này). CLI tự đọc credential
 *   từ `~/.aws` + cache SSO qua HOME; driver chỉ cho thêm
 *   `AWS_PROFILE` (tên profile, không phải secret) chui qua env
 *   sanitization. KHÔNG truyền `AWS_ACCESS_KEY_ID` /
 *   `AWS_SECRET_ACCESS_KEY` (secret — user nào dùng key tĩnh thì
 *   cấu hình trong `~/.aws/credentials`, CLI tự đọc).
 * - **Model:** không truyền model — Q dùng model mặc định của nó.
 * - **Kế tiếp:** AWS đã đổi tên Q CLI thành **Kiro CLI**
 *   (`kiro-cli chat --no-interactive`); repo `q` chỉ còn bảo trì
 *   vá bảo mật từ 11/2025. Driver này vẫn nhắm `q` (đúng binary
 *   detector tìm) — Kiro CLI có detector + driver riêng ở v0.76
 *   (`detected/definitions.ts` kind `kiro`, `providers/cli/kiroCli.ts`).
 *
 * CHƯA KIỂM CHỨNG trên `q` thật (máy này không có `q`): cờ spawn
 * mới chỉ khớp source mở + ghi nhận AWS. Cần chạy thật trên máy có
 * Q CLI đăng nhập trước khi coi M4 là xong (xem
 * providers/cli/README.md).
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { ProviderConfig } from '../../types';
import { BaseOneShotCliProvider } from './oneShot';
import type { OneShotCliProviderOptions } from './oneShot';
import type { CliEvent } from './types';
import { AMAZON_Q_MODEL_ID, AMAZON_Q_PROVIDER_ID } from './types';

/** Timeout mặc định cho một turn qua Amazon Q CLI (ms). */
export const AMAZON_Q_CLI_DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Biến env được phép chui qua env sanitization cho Amazon Q CLI:
 * `AWS_PROFILE` (tên profile, không phải secret). Key AWS tĩnh
 * KHÔNG được truyền — CLI tự đọc `~/.aws/credentials`.
 */
export const AMAZON_Q_ENV_VARS: readonly string[] = ['AWS_PROFILE'];

/** argv one-shot của Amazon Q CLI (prompt đã render đầy đủ, xem oneShot.ts). */
export function amazonQOneShotArgs(prompt: string): string[] {
  return ['chat', '--no-interactive', '--input', prompt];
}

export interface AmazonQCliProviderOptions {
  /** Đường dẫn tuyệt đối tới binary `q` (do detector tìm thấy). Bắt buộc. */
  binaryPath: string;
  /** Thư mục làm việc cho process CLI (mặc định process.cwd()). */
  cwd?: string;
  /** Timeout một turn (ms); mặc định 5 phút. */
  timeoutMs?: number;
  /** Biến env riêng của CLI được phép truyền thêm (mặc định AWS_PROFILE). */
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

export class AmazonQCliProvider extends BaseOneShotCliProvider {
  constructor(config: ProviderConfig, options: AmazonQCliProviderOptions) {
    const baseOptions: OneShotCliProviderOptions = {
      binaryPath: options.binaryPath,
      buildArgs: amazonQOneShotArgs,
      extraEnvAllowed: options.extraEnvAllowed ?? [...AMAZON_Q_ENV_VARS],
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
        providerId: AMAZON_Q_PROVIDER_ID,
        modelId: AMAZON_Q_MODEL_ID,
        displayName: 'Amazon Q CLI',
      },
      baseOptions,
    );
  }
}
