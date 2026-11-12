/**
 * OpenCode provider (M3) — driver OpenCode qua ACP (`opencode acp`).
 *
 * Lệnh spawn theo docs OpenCode công khai (opencode.ai/docs/cli/acp):
 * `opencode acp` chạy OpenCode thành ACP agent trên stdio (JSON-RPC
 * NDJSON, protocol version 1). Toàn bộ vòng đời ACP sống ở
 * `BaseAcpCliProvider` (acpProvider.ts); file này chỉ khai báo lệnh
 * spawn + định danh.
 *
 * - **Mượn login của OpenCode, không dùng API key.** Đăng nhập kiểm
 *   tra bằng `opencode auth list` (detector M1 — liệt kê provider đã
 *   lưu, không in secret). OpenCode là multi-provider (75+ provider):
 *   mượn OpenCode nghĩa là mượn từng provider bên trong nó, nhãn tài
 *   khoản trong snapshot là tên các provider đó (vd "Anthropic
 *   (oauth)"). Lưu ý OpenCode 2 giữ credential trong store riêng,
 *   không đọc `auth.json` nữa — vì vậy detector KHÔNG dựa vào file
 *   auth mà dựa vào chính lệnh `auth list` của CLI.
 * - **CLI sở hữu vòng tool của nó** (xem acpProvider.ts).
 * - **Approval = từ chối fail-closed** (ở AcpClient, M5 sẽ thay bằng
 *   permission broker).
 * - **System prompt** gộp vào message đầu session mới (ACP không có
 *   slot system prompt).
 * - **Resume = session id** (`session/load`; lỗi thì mở session mới +
 *   gửi lại history).
 * - **Model:** không truyền model — model id (`opencode`) chỉ là
 *   placeholder, OpenCode dùng model mặc định đã cấu hình của nó.
 *   (OpenCode ACP có hỗ trợ `session/set_model` nhưng M3 chưa dùng —
 *   để M4 lo model picker sâu hơn.)
 * - **Env:** chỉ allowlist chung, không thêm biến riêng (OpenCode
 *   đọc config/credential từ HOME của user).
 *
 * CHƯA KIỂM CHỨNG trên OpenCode thật (máy này không có `opencode`):
 * lệnh spawn, handshake ACP, `session/new`/`load`/`prompt`,
 * `session/update`, `session/request_permission` mới chỉ khớp ACP
 * chuẩn + docs OpenCode công khai. Cần chạy thật trên máy có OpenCode
 * đăng nhập trước khi coi M3 là xong (xem providers/cli/README.md).
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { ProviderConfig } from '../../types';
import { BaseAcpCliProvider } from './acpProvider';
import type { CliEvent, CliPermissionHandler } from './types';
import { OPENCODE_MODEL_ID, OPENCODE_PROVIDER_ID } from './types';

/** Timeout mặc định cho một turn qua OpenCode (ms). */
export const OPENCODE_CLI_DEFAULT_TIMEOUT_MS = 300_000;

/** argv đưa OpenCode vào chế độ ACP stdio (theo docs OpenCode). */
export const OPENCODE_ACP_ARGS: readonly string[] = ['acp'];

export interface OpenCodeCliProviderOptions {
  /** Đường dẫn tuyệt đối tới binary `opencode` (do detector tìm thấy). Bắt buộc. */
  binaryPath: string;
  /** Thư mục làm việc cho process CLI (mặc định process.cwd()). */
  cwd?: string;
  /** Timeout một turn (ms); mặc định 5 phút. */
  timeoutMs?: number;
  /** Biến env riêng của CLI được phép truyền thêm (mặc định không thêm). */
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

export class OpenCodeCliProvider extends BaseAcpCliProvider {
  constructor(config: ProviderConfig, options: OpenCodeCliProviderOptions) {
    super(
      config,
      {
        providerId: OPENCODE_PROVIDER_ID,
        modelId: OPENCODE_MODEL_ID,
        displayName: 'OpenCode',
      },
      {
        binaryPath: options.binaryPath,
        acpArgs: [...OPENCODE_ACP_ARGS],
        extraEnvAllowed: options.extraEnvAllowed ?? [],
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
  get opencodeSessionId(): string | null {
    return this.acpSessionId;
  }
}
