/**
 * Windsurf provider (M4, EXPERIMENTAL) — driver Windsurf qua Devin
 * CLI ở chế độ ACP (`devin acp`).
 *
 * BỐI CẢNH ĐỔI TÊN (ghi rõ — đây là điểm dễ nhầm nhất của driver
 * này): Cognition đổi tên Windsurf thành **Devin Desktop** tháng
 * 6/2026, Cascade thành Devin Local, và CLI agent đi kèm nay là
 * **Devin CLI** — binary `devin` (cài bằng
 * `curl -fsSL https://cli.devin.ai/install.sh | bash`). Lệnh spawn
 * theo docs Devin chính thức (docs.devin.ai, "Commands & Flags" +
 * "`devin acp`"):
 *
 *   devin acp
 *
 * `devin acp` chạy Devin thành ACP server trên stdio (JSON-RPC
 * NDJSON, không chạy tương tác) để editor/IDE ACP-aware gọi như
 * subprocess. Toàn bộ vòng đời ACP sống ở `BaseAcpCliProvider`
 * (acpProvider.ts); file này chỉ khai báo lệnh spawn + kiểm tra
 * binary.
 *
 * - **Binary bắt buộc là `devin`.** Detector của kind 'windsurf'
 *   dò theo thứ tự `devin` → `windsurf` → `devin-desktop` (xem
 *   detected/definitions.ts). Hai binary sau là LAUNCHER CỦA
 *   EDITOR (VS Code fork) — không có chế độ agent headless nào đã
 *   kiểm chứng (`windsurf <prompt>` chỉ là ghi nhận lẻ, không có
 *   trong docs chính thức; `windsurf acp` sẽ bị editor hiểu là "mở
 *   file tên acp"). Constructor TỪ CHỐI binary không phải `devin`
 *   kèm hướng dẫn cài Devin CLI, thay vì giả vờ chạy được.
 * - **Mượn login Devin của CLI, không dùng API key.** ACP server
 *   đọc credential từ `WINDSURF_API_KEY` nếu có, không thì từ
 *   credential `devin auth login` đã lưu. Driver KHÔNG truyền
 *   `WINDSURF_API_KEY` (secret) — Devin tự đọc credential đã lưu
 *   của nó qua HOME.
 * - **CLI sở hữu vòng tool của nó** (xem acpProvider.ts).
 * - **Approval = từ chối fail-closed** (ở AcpClient, broker M5 có
 *   thể cho phép tường minh). Driver KHÔNG truyền cờ bypass nào
 *   (Devin có các permission mode normal/accept-edits/bypass/
 *   autonomous — mặc định normal, tức hỏi duyệt).
 * - **System prompt** gộp vào message đầu session mới (ACP không có
 *   slot system prompt).
 * - **Resume = session id** (`session/load`; lỗi thì mở session mới
 *   + gửi lại history).
 * - **Model:** không truyền model — model id (`windsurf`) chỉ là
 *   placeholder, Devin dùng model mặc định của nó (có thể đổi bằng
 *   `--model` của `devin acp` trong follow-up model picker).
 * - **Env:** chỉ allowlist chung, không thêm biến riêng.
 *
 * CHƯA KIỂM CHỨNG trên Devin CLI thật (máy này không có `devin`):
 * lệnh spawn `devin acp`, handshake ACP, `session/new`/`load`/
 * `prompt`, `session/request_permission` mới chỉ khớp ACP chuẩn +
 * docs Devin công khai. Cần chạy thật trên máy có Devin CLI đăng
 * nhập trước khi bỏ nhãn experimental (xem providers/cli/README.md).
 */

import * as path from 'node:path';

import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { ProviderConfig } from '../../types';
import { BaseAcpCliProvider } from './acpProvider';
import type { CliEvent, CliPermissionHandler } from './types';
import { WINDSURF_MODEL_ID, WINDSURF_PROVIDER_ID } from './types';

/** Timeout mặc định cho một turn qua Windsurf / Devin CLI (ms). */
export const WINDSURF_CLI_DEFAULT_TIMEOUT_MS = 300_000;

/** argv đưa Devin CLI vào chế độ ACP stdio (theo docs Devin). */
export const WINDSURF_ACP_ARGS: readonly string[] = ['acp'];

/**
 * Basename binary Devin CLI được chấp nhận (`devin`, `devin.exe`
 * trên Windows). Launcher của editor (`windsurf`,
 * `devin-desktop`) KHÔNG được chấp nhận — xem đầu file.
 */
export function isDevinCliBinary(binaryPath: string): boolean {
  const base = path.basename(binaryPath).toLowerCase();
  return base === 'devin' || base === 'devin.exe';
}

export interface WindsurfCliProviderOptions {
  /**
   * Đường dẫn tuyệt đối tới binary `devin` (do detector tìm thấy).
   * Bắt buộc — binary khác (`windsurf` / `devin-desktop`, launcher
   * của editor) sẽ bị constructor từ chối kèm hướng dẫn.
   */
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

export class WindsurfCliProvider extends BaseAcpCliProvider {
  constructor(config: ProviderConfig, options: WindsurfCliProviderOptions) {
    if (!isDevinCliBinary(options?.binaryPath ?? '')) {
      throw new Error(
        `Windsurf: binary "${options?.binaryPath ?? ''}" không phải Devin CLI — ` +
          `Windsurf đã đổi tên thành Devin Desktop, CLI agent của nó nay là \`devin\` ` +
          `(cài bằng: curl -fsSL https://cli.devin.ai/install.sh | bash). ` +
          `Launcher của editor (\`windsurf\` / \`devin-desktop\`) không có chế độ agent ` +
          `headless nên open-bot không dùng nó làm driver.`,
      );
    }
    super(
      config,
      {
        providerId: WINDSURF_PROVIDER_ID,
        modelId: WINDSURF_MODEL_ID,
        displayName: 'Windsurf',
        // Chưa chạy lần nào trên Devin CLI thật (xem đầu file).
        experimental: true,
      },
      {
        binaryPath: options.binaryPath,
        acpArgs: [...WINDSURF_ACP_ARGS],
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
  get windsurfSessionId(): string | null {
    return this.acpSessionId;
  }
}
