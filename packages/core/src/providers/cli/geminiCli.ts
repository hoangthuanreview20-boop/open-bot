/**
 * Gemini CLI provider (M3) — driver Gemini CLI qua ACP (`gemini --acp`).
 *
 * Lệnh spawn theo docs Gemini CLI công khai (geminicli.com/docs/cli/
 * acp-mode): `gemini --acp` chạy Gemini CLI ở chế độ ACP (JSON-RPC
 * NDJSON trên stdio). Toàn bộ vòng đời ACP sống ở `BaseAcpCliProvider`
 * (acpProvider.ts); file này chỉ khai báo lệnh spawn + env + fallback
 * cờ cho bản cũ.
 *
 * - **Mượn login Google của Gemini CLI, không dùng API key.** Đăng
 *   nhập kiểm tra bằng file nhãn `~/.gemini/google_accounts.json`
 *   (CHỈ email, không token — detector M1); `oauth_creds.json`
 *   (chứa token) chỉ kiểm tra TỒN TẠI, không bao giờ đọc nội dung.
 *   Nhãn tài khoản trong snapshot là email Google đó.
 * - **Cờ ACP có 2 đời:** bản hiện tại dùng `--acp`; bản cũ hơn dùng
 *   `--experimental-acp` (từng là cờ thử nghiệm). Driver thử `--acp`
 *   trước, `initialize` lỗi thì thử `--experimental-acp` rồi mới báo
 *   lỗi (xem `acpArgsAlternatives` ở acpProvider.ts). Không đoán thêm
 *   cờ nào khác.
 * - **CLI sở hữu vòng tool của nó** (xem acpProvider.ts).
 * - **Approval = từ chối fail-closed** (ở AcpClient, M5 sẽ thay bằng
 *   permission broker).
 * - **System prompt** gộp vào message đầu session mới (ACP không có
 *   slot system prompt).
 * - **Resume = session id** (`session/load`; lỗi thì mở session mới +
 *   gửi lại history).
 * - **Model:** không truyền model — model id (`gemini-cli`) chỉ là
 *   placeholder, Gemini CLI dùng model mặc định của nó.
 * - **Env:** allowlist chung + `GEMINI_CLI_HOME` (đường dẫn thư mục
 *   config, không phải secret — user có thể dời `~/.gemini` bằng
 *   biến này). `GEMINI_API_KEY` KHÔNG bao giờ được truyền.
 *
 * CHƯA KIỂM CHỨNG trên Gemini CLI thật (máy này không có `gemini`):
 * lệnh spawn `--acp`, handshake ACP, `session/new`/`load`/`prompt`,
 * `session/update`, `session/request_permission`, và cả fallback
 * `--experimental-acp` mới chỉ khớp ACP chuẩn + docs/code công khai
 * (Gemini CLI là implementation tham chiếu đầu tiên của ACP, cùng Zed
 * xây dựng). Cần chạy thật trên máy có Gemini CLI đăng nhập trước khi
 * coi M3 là xong (xem providers/cli/README.md).
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { ProviderConfig } from '../../types';
import { BaseAcpCliProvider } from './acpProvider';
import type { CliEvent, CliPermissionHandler } from './types';
import { GEMINI_CLI_MODEL_ID, GEMINI_CLI_PROVIDER_ID } from './types';

/** Timeout mặc định cho một turn qua Gemini CLI (ms). */
export const GEMINI_CLI_DEFAULT_TIMEOUT_MS = 300_000;

/** argv đưa Gemini CLI vào chế độ ACP stdio (bản hiện tại). */
export const GEMINI_ACP_ARGS: readonly string[] = ['--acp'];

/** argv ACP cho bản Gemini CLI cũ (cờ thử nghiệm trước đây). */
export const GEMINI_ACP_LEGACY_ARGS: readonly string[] = ['--experimental-acp'];

export interface GeminiCliProviderOptions {
  /** Đường dẫn tuyệt đối tới binary `gemini` (do detector tìm thấy). Bắt buộc. */
  binaryPath: string;
  /** Thư mục làm việc cho process CLI (mặc định process.cwd()). */
  cwd?: string;
  /** Timeout một turn (ms); mặc định 5 phút. */
  timeoutMs?: number;
  /** Biến env riêng của CLI được phép truyền thêm (mặc định GEMINI_CLI_HOME). */
  extraEnvAllowed?: string[];
  /** Callback nhận event chuẩn của CLI (text/tool_call/result/error/approval_denied). */
  onCliEvent?: (event: CliEvent) => void;
  /** M5 — sink event của harness (bus + NDJSON log). */
  harnessSink?: (event: CliEvent) => void;
  /** M5 — handler permission tập trung (broker). */
  permissionHandler?: CliPermissionHandler;
  /** Nơi ghi cảnh báo. */
  logger?: { warn(message: string): void };
  /** Hàm spawn (mặc định spawnCli thật; test inject fake). */
  spawn?: (
    binary: string,
    args: string[],
    options: { cwd?: string; env: NodeJS.ProcessEnv },
  ) => ChildProcessWithoutNullStreams;
}

export class GeminiCliProvider extends BaseAcpCliProvider {
  constructor(config: ProviderConfig, options: GeminiCliProviderOptions) {
    super(
      config,
      {
        providerId: GEMINI_CLI_PROVIDER_ID,
        modelId: GEMINI_CLI_MODEL_ID,
        displayName: 'Gemini CLI',
      },
      {
        binaryPath: options.binaryPath,
        acpArgs: [...GEMINI_ACP_ARGS],
        acpArgsAlternatives: [[...GEMINI_ACP_LEGACY_ARGS]],
        extraEnvAllowed: options.extraEnvAllowed ?? ['GEMINI_CLI_HOME'],
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        onCliEvent: options.onCliEvent,
        harnessSink: options.harnessSink,
        permissionHandler: options.permissionHandler,
        logger: options.logger,
        spawn: options.spawn,
      },
    );
  }

  /** Session id đang dùng (resumeCursor) — để debug/log. */
  get geminiCliSessionId(): string | null {
    return this.acpSessionId;
  }
}
