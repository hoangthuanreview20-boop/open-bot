/**
 * GitHub Copilot CLI provider (M4) — driver Copilot CLI qua ACP
 * (`copilot --acp --stdio`).
 *
 * Lệnh spawn theo docs GitHub công khai (docs.github.com, "Copilot
 * CLI ACP server"): `copilot --acp` chạy CLI thành ACP server; không
 * chỉ transport thì mặc định là stdio, thêm `--stdio` để nói rõ.
 * Toàn bộ vòng đời ACP sống ở `BaseAcpCliProvider` (acpProvider.ts);
 * file này chỉ khai báo lệnh spawn + env.
 *
 * - **Mượn login GitHub của Copilot CLI, không dùng API key.**
 *   Chính CLI không có lệnh status nên detector hỏi `gh auth status`
 *   (GitHub CLI đã đăng nhập là điều kiện để chế độ headless của
 *   Copilot chạy — xem detected/definitions.ts).
 * - **ACP đang public preview** (docs GitHub, từ 28/01/2026) và có
 *   thể đổi: bản Copilot CLI < 1.0 từ chối `--acp` (chỉ có từ 1.0.x
 *   trở đi) — driver khi đó lỗi `initialize` rõ ràng, không đoán
 *   thêm cờ dự phòng.
 * - **CLI sở hữu vòng tool của nó** (xem acpProvider.ts).
 * - **Approval = từ chối fail-closed** (ở AcpClient, broker M5 có
 *   thể cho phép tường minh). Driver KHÔNG truyền
 *   `--allow-all-tools` / `--allow-all` / `--yolo` — các cờ đó sẽ
 *   vòng qua broker và cho CLI chạy mọi tool không cần duyệt.
 * - **System prompt** gộp vào message đầu session mới (ACP không có
 *   slot system prompt).
 * - **Resume = session id** (`session/load`; lỗi thì mở session mới
 *   + gửi lại history).
 * - **Model:** không truyền model — model id (`copilot-cli`) chỉ là
 *   placeholder, Copilot CLI dùng model mặc định của nó.
 * - **Env:** allowlist chung + `COPILOT_PROVIDERS_CONFIG` (đường dẫn
 *   file cấu hình BYOK provider, không phải secret — docs ACP ghi
 *   session BYOK chạy được không cần GitHub login khi có file này
 *   hoặc biến `COPILOT_PROVIDER_*`). Các biến `COPILOT_PROVIDER_*`
 *   CHỨA KEY nên KHÔNG BAO GIỜ được truyền — user nào dùng BYOK thì
 *   trỏ file config bằng `COPILOT_PROVIDERS_CONFIG`.
 *
 * CHƯA KIỂM CHỨNG trên Copilot CLI thật (máy này không có `copilot`):
 * lệnh spawn `--acp --stdio`, handshake ACP, `session/new`/`load`/
 * `prompt`, `session/request_permission` mới chỉ khớp ACP chuẩn +
 * docs GitHub công khai. Cần chạy thật trên máy có Copilot CLI đăng
 * nhập trước khi coi M4 là xong (xem providers/cli/README.md).
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { ProviderConfig } from '../../types';
import { BaseAcpCliProvider } from './acpProvider';
import type { CliEvent, CliPermissionHandler } from './types';
import { COPILOT_CLI_MODEL_ID, COPILOT_CLI_PROVIDER_ID } from './types';

/** Timeout mặc định cho một turn qua Copilot CLI (ms). */
export const COPILOT_CLI_DEFAULT_TIMEOUT_MS = 300_000;

/** argv đưa Copilot CLI vào chế độ ACP stdio (theo docs GitHub). */
export const COPILOT_ACP_ARGS: readonly string[] = ['--acp', '--stdio'];

/**
 * Biến env được phép chui qua env sanitization cho Copilot CLI:
 * `COPILOT_PROVIDERS_CONFIG` (đường dẫn file cấu hình BYOK, không
 * phải secret). `COPILOT_PROVIDER_*` chứa key nên không bao giờ được
 * truyền.
 */
export const COPILOT_CLI_ENV_VARS: readonly string[] = ['COPILOT_PROVIDERS_CONFIG'];

export interface CopilotCliProviderOptions {
  /** Đường dẫn tuyệt đối tới binary `copilot` (do detector tìm thấy). Bắt buộc. */
  binaryPath: string;
  /** Thư mục làm việc cho process CLI (mặc định process.cwd()). */
  cwd?: string;
  /** Timeout một turn (ms); mặc định 5 phút. */
  timeoutMs?: number;
  /** Biến env riêng của CLI được phép truyền thêm (mặc định COPILOT_PROVIDERS_CONFIG). */
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

export class CopilotCliProvider extends BaseAcpCliProvider {
  constructor(config: ProviderConfig, options: CopilotCliProviderOptions) {
    super(
      config,
      {
        providerId: COPILOT_CLI_PROVIDER_ID,
        modelId: COPILOT_CLI_MODEL_ID,
        displayName: 'GitHub Copilot CLI',
      },
      {
        binaryPath: options.binaryPath,
        acpArgs: [...COPILOT_ACP_ARGS],
        extraEnvAllowed: options.extraEnvAllowed ?? [...COPILOT_CLI_ENV_VARS],
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
  get copilotCliSessionId(): string | null {
    return this.acpSessionId;
  }
}
