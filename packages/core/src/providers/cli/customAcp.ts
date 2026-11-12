/**
 * Custom ACP CLI provider (M3) — driver cho bất kỳ CLI nào nói ACP mà
 * user tự trỏ tới trong Settings → Engines ("Set CLI…").
 *
 * User khai báo: tên hiển thị + đường dẫn tuyệt đối tới binary + lệnh
 * spawn ACP (argv, vd `acp` hay `--acp`) + (tuỳ chọn) lệnh kiểm tra
 * đăng nhập. Cấu hình sống trong `detected-engines.json` (xem
 * detected/custom.ts) và được registry detect như một engine có kind
 * `custom-acp:<slug>`; `providerConfigFor` (main process) resolve
 * slug → binary + args rồi truyền qua `ProviderConfig.cliBinary` /
 * `cliArgs` (xem providers/index.ts).
 *
 * - **Model = slug của CLI tuỳ chỉnh.** Provider id duy nhất là
 *   `custom-acp`; bot nào dùng CLI tuỳ chỉnh nào được phân biệt bằng
 *   model (chính là slug, vd model `my-agent`). `listModels()` trả
 *   `[slug]`; BotForm cho chọn CLI tuỳ chỉnh từ danh sách engine đã
 *   detect thay vì gõ tay.
 * - **CLI sở hữu vòng tool của nó** (xem acpProvider.ts).
 * - **Approval = từ chối fail-closed** (ở AcpClient, M5 sẽ thay bằng
 *   permission broker).
 * - **System prompt** gộp vào message đầu session mới (ACP không có
 *   slot system prompt).
 * - **Resume = session id** (`session/load`; lỗi thì mở session mới +
 *   gửi lại history).
 * - **Env:** chỉ allowlist chung, không thêm biến riêng — CLI tuỳ
 *   chỉnh đọc config/credential của chính nó từ HOME của user.
 * - **Không có `authenticate` mặc định:** CLI tuỳ chỉnh nào cần bước
 *   ACP `authenticate` riêng thì M3 chưa hỗ trợ (chỉ 4 driver
 *   built-in mới khai báo được `authenticateMethodId`); nếu CLI đó
 *   bắt buộc authenticate thì `session/new` sẽ lỗi rõ, user thấy lý
 *   do thay vì driver đoán methodId.
 *
 * CHƯA KIỂM CHỨNG trên CLI thật nào ngoài fake ACP dùng cho test
 * (tests/detected-cli-m3.test.mjs): mọi CLI ACP thật đều khác nhau ở
 * chi tiết (cờ spawn, shape `usage_update`, có cần `authenticate`
 * không) — driver này chỉ đúng với CLI nào nói ACP chuẩn.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { ProviderConfig } from '../../types';
import { BaseAcpCliProvider } from './acpProvider';
import type { CliEvent, CliPermissionHandler } from './types';
import { CUSTOM_ACP_MODEL_ID, CUSTOM_ACP_PROVIDER_ID } from './types';

/** Timeout mặc định cho một turn qua CLI ACP tuỳ chỉnh (ms). */
export const CUSTOM_ACP_CLI_DEFAULT_TIMEOUT_MS = 300_000;

export interface CustomAcpCliProviderOptions {
  /** Đường dẫn tuyệt đối tới binary CLI tuỳ chỉnh (do detector tìm thấy). Bắt buộc. */
  binaryPath: string;
  /** argv đưa CLI vào chế độ ACP stdio (do user khai báo). Bắt buộc, ít nhất một phần tử. */
  acpArgs: string[];
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

export class CustomAcpCliProvider extends BaseAcpCliProvider {
  /** Slug của CLI tuỳ chỉnh (chính là model của bot này). */
  readonly customCliId: string;

  constructor(config: ProviderConfig, options: CustomAcpCliProviderOptions) {
    super(
      config,
      {
        providerId: CUSTOM_ACP_PROVIDER_ID,
        modelId:
          typeof config.defaultModel === 'string' && config.defaultModel.trim().length > 0
            ? config.defaultModel.trim()
            : CUSTOM_ACP_MODEL_ID,
        displayName: config.label || 'Custom ACP CLI',
      },
      {
        binaryPath: options.binaryPath,
        acpArgs: [...options.acpArgs],
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
    this.customCliId =
      typeof config.defaultModel === 'string' && config.defaultModel.trim().length > 0
        ? config.defaultModel.trim()
        : CUSTOM_ACP_MODEL_ID;
  }

  /** Session id đang dùng (resumeCursor) — để debug/log. */
  get customAcpSessionId(): string | null {
    return this.acpSessionId;
  }
}
