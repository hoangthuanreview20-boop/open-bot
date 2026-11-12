/**
 * Grok CLI provider (M2, mỏng hoá ở M3) — driver Grok CLI qua ACP
 * (`grok --permission-mode default agent stdio`, xem acp.ts).
 *
 * Từ M3, toàn bộ vòng đời ACP (spawn → initialize → session/new/load
 * → session/prompt → kill process group) sống ở `BaseAcpCliProvider`
 * (acpProvider.ts); file này chỉ còn khai báo riêng của Grok:
 * lệnh spawn, env riêng, định danh provider/model. Hành vi giữ nguyên
 * như M2 (test M2 phải xanh không đổi):
 *
 * - **Mượn login grok.com, không dùng API key.** Đăng nhập kiểm tra
 *   bằng sự TỒN TẠI của `~/.grok/auth.json` (detector M1 — chỉ kiểm
 *   tra tồn tại, không đọc nội dung). Env của turn được dọn sạch:
 *   `XAI_API_KEY` KHÔNG bao giờ vào env của process con (rò rỉ key
 *   sẽ âm thầm chuyển subscription grok.com sang pay-as-you-go);
 *   env chỉ allowlist + `GROK_HOME` (đường dẫn, không phải secret).
 * - **CLI sở hữu vòng tool của nó** (xem acpProvider.ts).
 * - **Approval = từ chối fail-closed** (ở AcpClient).
 * - **System prompt** gộp vào message đầu session mới (ACP không có
 *   slot system prompt).
 * - **Resume = session id** (`session/load`; lỗi thì mở session mới +
 *   gửi lại history). `resumeCursor` của provider này chính là
 *   session id (getter `grokSessionId`).
 * - **Model:** KHÔNG truyền `-m` — model id của provider
 *   (`grok-cli`) chỉ là placeholder, CLI dùng model mặc định của nó.
 *   `--permission-mode` là cờ global, đặt TRƯỚC `agent`.
 *
 * GIỚI HẠN CHƯA KIỂM CHỨNG (xem providers/cli/README.md): máy này
 * KHÔNG có `grok` nên CHƯA chạy lần nào trên Grok CLI thật.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { ProviderConfig } from '../../types';
import { ACP_CLI_DEFAULT_TIMEOUT_MS, BaseAcpCliProvider } from './acpProvider';
import type { CliEvent, CliPermissionHandler } from './types';
import { GROK_CLI_MODEL_ID, GROK_CLI_PROVIDER_ID } from './types';

/** Timeout mặc định cho một turn qua CLI (ms) — giữ tên M2 để test cũ dùng được. */
export const GROK_CLI_DEFAULT_TIMEOUT_MS = ACP_CLI_DEFAULT_TIMEOUT_MS;

/** argv để đưa Grok CLI vào chế độ ACP stdio (permission-mode là cờ global, trước `agent`). */
export const GROK_ACP_ARGS: readonly string[] = [
  '--permission-mode',
  'default',
  'agent',
  'stdio',
];

export interface GrokCliProviderOptions {
  /** Đường dẫn tuyệt đối tới binary `grok` (do detector tìm thấy). Bắt buộc. */
  binaryPath: string;
  /** Thư mục làm việc cho process CLI (mặc định process.cwd()). */
  cwd?: string;
  /** Timeout một turn (ms); mặc định 5 phút. */
  timeoutMs?: number;
  /** Biến env riêng của CLI được phép truyền thêm (mặc định GROK_HOME). */
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

export class GrokCliProvider extends BaseAcpCliProvider {
  constructor(config: ProviderConfig, options: GrokCliProviderOptions) {
    super(
      config,
      {
        providerId: GROK_CLI_PROVIDER_ID,
        modelId: GROK_CLI_MODEL_ID,
        displayName: 'Grok CLI',
      },
      {
        binaryPath: options.binaryPath,
        acpArgs: [...GROK_ACP_ARGS],
        extraEnvAllowed: options.extraEnvAllowed ?? ['GROK_HOME'],
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

  /** Session id đang dùng (resumeCursor) — để debug/log (alias tên riêng của Grok, giữ từ M2). */
  get grokSessionId(): string | null {
    return this.acpSessionId;
  }
}
