/**
 * Continue CLI provider (M4, EXPERIMENTAL) — driver Continue (`cn`)
 * qua one-shot `-p`.
 *
 * Lệnh spawn:
 *
 *   cn -p "<prompt>"
 *
 * - **`-p` (headless/print mode):** chạy một prompt rồi thoát, đáp
 *   án in ra stdout (không có streaming/JSON riêng — driver parse
 *   text thô, xem oneShot.ts). Cờ này KHÔNG có trong docs chính thức
 *   còn lại của Continue (sau khi Cursor mua lại tháng 6/2026, repo
 *   chỉ còn đọc, bản CLI cuối 1.5.47) mà được xác nhận qua wrapper
 *   bên thứ ba dùng `cn` làm provider (`randalmurphal/llmkit`:
 *   "Executes cn in headless mode with -p flag"; wrapper đó cũng ghi
 *   cờ quyền tool là `--allow` / `--ask` / `--exclude`). Vì vậy
 *   driver này đánh dấu EXPERIMENTAL cho tới khi chạy thật trên `cn`
 *   1.5.47 để xác nhận cờ `-p`.
 * - **Fail-closed về quyền:** driver KHÔNG truyền `--allow` cho tool
 *   nào — tool cần duyệt sẽ hỏi (không có TTY thì treo tới timeout
 *   rồi bị kill) thay vì tự chạy. Muốn cho phép tool thì user tự
 *   cấu hình trong `~/.continue/config.yaml`.
 * - **Auth = key trong config của CHÍNH user.** Lần chạy đầu `cn`
 *   hỏi Anthropic API key rồi ghi `~/.continue/config.yaml`
 *   (detector 'file-exists': chỉ kiểm tra file tồn tại, không đọc
 *   nội dung). Không có terminal thì `cn` đọc `ANTHROPIC_API_KEY`
 *   nên driver cho đúng biến đó chui qua env sanitization (key của
 *   CHÍNH user cho CHÍNH CLI của họ — cùng lý lẽ như Aider).
 *   `CONTINUE_USE_BEDROCK=1` (không phải secret, chỉ là cờ) cũng
 *   được phép chui qua; key AWS cho Bedrock thì KHÔNG (giới hạn đã
 *   biết — dùng Bedrock thì cấu hình key trong config.yaml).
 * - **Model:** không truyền `--model` (cờ này nhận Continue Hub
 *   slug mà hub đã đóng) — `cn` dùng model trong config.yaml.
 *
 * CHƯA KIỂM CHỨNG trên `cn` thật (máy này không có `cn`): cờ `-p`
 * mới chỉ được wrapper bên thứ ba xác nhận, chưa thấy docs chính
 * thức. Cần chạy thật `cn -p` trên máy có Continue CLI + key trước
 * khi bỏ nhãn experimental (xem providers/cli/README.md).
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { ProviderConfig } from '../../types';
import { BaseOneShotCliProvider } from './oneShot';
import type { OneShotCliProviderOptions } from './oneShot';
import type { CliEvent } from './types';
import { CONTINUE_CLI_MODEL_ID, CONTINUE_CLI_PROVIDER_ID } from './types';

/** Timeout mặc định cho một turn qua Continue CLI (ms). */
export const CONTINUE_CLI_DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Biến env được phép chui qua env sanitization cho Continue: key của
 * CHÍNH user cho CHÍNH CLI của họ (`ANTHROPIC_API_KEY` — `cn` không
 * có terminal thì đọc biến này) + cờ Bedrock (`CONTINUE_USE_BEDROCK`,
 * không phải secret). Không bao giờ log giá trị key.
 */
export const CONTINUE_CLI_ENV_VARS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'CONTINUE_USE_BEDROCK',
];

/** argv one-shot của Continue CLI (prompt đã render đầy đủ, xem oneShot.ts). */
export function continueCliOneShotArgs(prompt: string): string[] {
  return ['-p', prompt];
}

export interface ContinueCliProviderOptions {
  /** Đường dẫn tuyệt đối tới binary `cn` (do detector tìm thấy). Bắt buộc. */
  binaryPath: string;
  /** Thư mục làm việc cho process CLI (mặc định process.cwd()). */
  cwd?: string;
  /** Timeout một turn (ms); mặc định 5 phút. */
  timeoutMs?: number;
  /** Biến env riêng của CLI được phép truyền thêm (mặc định 2 biến ở trên). */
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

export class ContinueCliProvider extends BaseOneShotCliProvider {
  constructor(config: ProviderConfig, options: ContinueCliProviderOptions) {
    const baseOptions: OneShotCliProviderOptions = {
      binaryPath: options.binaryPath,
      buildArgs: continueCliOneShotArgs,
      extraEnvAllowed: options.extraEnvAllowed ?? [...CONTINUE_CLI_ENV_VARS],
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      onCliEvent: options.onCliEvent,
      harnessSink: options.harnessSink,
      logger: options.logger,
      spawn: options.spawn,
      // Cờ -p của cn chưa được docs chính thức xác nhận (xem đầu file).
      experimental: true,
    };
    super(
      config,
      {
        providerId: CONTINUE_CLI_PROVIDER_ID,
        modelId: CONTINUE_CLI_MODEL_ID,
        displayName: 'Continue CLI',
      },
      baseOptions,
    );
  }
}
