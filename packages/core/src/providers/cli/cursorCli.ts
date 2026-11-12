/**
 * Cursor CLI provider (M3) — driver Cursor CLI qua ACP (`cursor-agent acp`).
 *
 * Lệnh spawn theo docs Cursor công khai (cursor.com/docs/cli/acp):
 * `agent acp` / `cursor-agent acp` chạy Cursor CLI thành ACP server
 * trên stdio (JSON-RPC 2.0, newline-delimited). Toàn bộ vòng đời ACP
 * sống ở `BaseAcpCliProvider` (acpProvider.ts); file này chỉ khai báo
 * lệnh spawn + bước `authenticate` riêng của Cursor.
 *
 * - **Mượn login Cursor, không dùng API key.** Đăng nhập kiểm tra
 *   bằng `cursor-agent status --format json` (detector M1). Cursor
 *   quảng cáo methodId ACP `cursor_login` cho bước `authenticate`
 *   sau `initialize` (theo docs Cursor: flow ACP điển hình gồm
 *   `authenticate` với `methodId: "cursor_login"`); driver gọi bước
 *   này, lỗi thì chỉ cảnh báo rồi tiếp tục — `session/new` sẽ lỗi rõ
 *   nếu thật sự chưa đăng nhập (fail-closed ở đó, không đoán).
 * - **Lưu ý từ tài liệu tích hợp độc lập:** trong một số triển khai,
 *   `cursor-agent login` KHÔNG xác thực được các turn headless — có
 *   thể cần API key thật (`CURSOR_API_KEY`). Driver KHÔNG tự truyền
 *   key (env đã dọn sạch secret); nếu turn headless thất bại vì auth
 *   thì lỗi của CLI sẽ nói rõ, user tự quyết định (M5 trở đi mới xem
 *   xét cơ chế key do user khai báo tường minh).
 * - **CLI sở hữu vòng tool của nó** (xem acpProvider.ts).
 * - **Approval = từ chối fail-closed** (ở AcpClient, M5 sẽ thay bằng
 *   permission broker).
 * - **System prompt** gộp vào message đầu session mới (ACP không có
 *   slot system prompt).
 * - **Resume = session id** (`session/load`; lỗi thì mở session mới +
 *   gửi lại history).
 * - **Model:** không truyền model — model id (`cursor-cli`) chỉ là
 *   placeholder, Cursor CLI dùng model mặc định của nó (docs Cursor
 *   ghi `cursor-agent acp --model <model>` có thể pin model, nhưng M3
 *   chưa dùng — để M4 lo model picker sâu hơn).
 * - **Env:** chỉ allowlist chung, không thêm biến riêng (login Cursor
 *   nằm ở keychain hệ điều hành, không phải env).
 *
 * CHƯA KIỂM CHỨNG trên Cursor CLI thật (máy này không có
 * `cursor-agent`): lệnh spawn `acp`, handshake ACP, bước
 * `authenticate` (`cursor_login`), `session/new`/`load`/`prompt`,
 * `session/update`, `session/request_permission` mới chỉ khớp ACP
 * chuẩn + docs Cursor công khai. Cần chạy thật trên máy có Cursor CLI
 * đăng nhập trước khi coi M3 là xong — đặc biệt kiểm tra headless có
 * chạy được bằng login không hay bắt buộc API key (xem
 * providers/cli/README.md).
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { ProviderConfig } from '../../types';
import { BaseAcpCliProvider } from './acpProvider';
import type { CliEvent, CliPermissionHandler } from './types';
import { CURSOR_CLI_MODEL_ID, CURSOR_CLI_PROVIDER_ID } from './types';

/** Timeout mặc định cho một turn qua Cursor CLI (ms). */
export const CURSOR_CLI_DEFAULT_TIMEOUT_MS = 300_000;

/** argv đưa Cursor CLI vào chế độ ACP stdio (theo docs Cursor). */
export const CURSOR_ACP_ARGS: readonly string[] = ['acp'];

/** MethodId ACP `authenticate` mà Cursor CLI quảng cáo (`cursor_login`). */
export const CURSOR_ACP_AUTH_METHOD_ID = 'cursor_login';

export interface CursorCliProviderOptions {
  /** Đường dẫn tuyệt đối tới binary `cursor-agent` (do detector tìm thấy). Bắt buộc. */
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

export class CursorCliProvider extends BaseAcpCliProvider {
  constructor(config: ProviderConfig, options: CursorCliProviderOptions) {
    super(
      config,
      {
        providerId: CURSOR_CLI_PROVIDER_ID,
        modelId: CURSOR_CLI_MODEL_ID,
        displayName: 'Cursor CLI',
      },
      {
        binaryPath: options.binaryPath,
        acpArgs: [...CURSOR_ACP_ARGS],
        extraEnvAllowed: options.extraEnvAllowed ?? [],
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        onCliEvent: options.onCliEvent,
        harnessSink: options.harnessSink,
        permissionHandler: options.permissionHandler,
        logger: options.logger,
        spawn: options.spawn,
        authenticateMethodId: CURSOR_ACP_AUTH_METHOD_ID,
      },
    );
  }

  /** Session id đang dùng (resumeCursor) — để debug/log. */
  get cursorCliSessionId(): string | null {
    return this.acpSessionId;
  }
}
