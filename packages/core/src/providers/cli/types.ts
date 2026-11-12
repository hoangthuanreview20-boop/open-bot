/**
 * CLI provider — canonical event stream (M1).
 *
 * Mỗi CLI nói một thứ tiếng khác nhau (Claude: stream-JSON, Codex:
 * JSON-RPC, Grok: ACP…), nhưng driver nào cũng dịch về MỘT luồng event
 * chuẩn này (theo mẫu OpenMausBot: mọi driver đổ về một canonical
 * runtime event stream). UI/agent loop chỉ cần hiểu event chuẩn, không
 * cần biết CLI nào đang chạy.
 *
 * M1 chỉ có driver Claude Code; các driver sau (Codex, Grok ACP…) tái
 * dùng cùng kiểu event này.
 */

import type { ToolCall } from '../../types';

/**
 * Một event trong luồng chuẩn của CLI driver.
 *
 * - `text`: một đoạn text của assistant (có thể là một phần của câu trả lời).
 * - `tool_call`: CLI tự gọi một tool CỦA NÓ (M1: CLI sở hữu vòng tool
 *   của nó — open-bot chỉ quan sát event này, KHÔNG thực thi lại call
 *   đó qua ToolRegistry; xem claude.ts).
 * - `result`: turn kết thúc — text đầy đủ + usage (nếu CLI báo) + id session.
 * - `error`: lỗi trong turn (process chết, output hỏng…).
 * - `aborted`: turn bị hủy (user bấm dừng / timeout / dispose).
 */
export type CliEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | {
      type: 'result';
      text: string;
      usage?: { inputTokens: number; outputTokens: number };
      sessionId?: string;
    }
  | { type: 'error'; message: string }
  | { type: 'aborted' }
  | {
      /** M2: server xin duyệt (tool/sửa file/…) và driver đã TỪ CHỐI fail-closed. */
      type: 'approval_denied';
      /** Method xin duyệt của server (vd Codex `execCommandApproval`, ACP `session/request_permission`). */
      method: string;
      /** Mô tả ngắn (tên tool/lệnh, nếu server cho biết). */
      detail?: string;
    }
  | {
      /**
       * M5: server vừa gửi một permission/approval request, CHƯA quyết
       * (broker đang hỏi user / sẽ từ chối fail-closed). Driver emit
       * event này TRƯỚC khi trả lời server để bus/log/UI thấy request.
       */
      type: 'approval_request';
      /** Method xin duyệt của server. */
      method: string;
      /** Mô tả ngắn (tên tool/lệnh, nếu server cho biết). */
      detail?: string;
    };

/**
 * M5 — handler permission tập trung (permission broker, xem
 * harness/broker.ts). Driver gọi khi server xin duyệt; resolve `true`
 * chỉ khi user cho phép tường minh. `allowable=false` khi method
 * không có đường cho phép an toàn (vd Codex: shape allow chưa xác
 * minh) — broker khi đó luôn từ chối.
 */
export type CliPermissionHandler = (request: {
  method: string;
  detail?: string;
  allowable: boolean;
}) => Promise<boolean>;

/** Tên provider / model của driver Claude Code (CLI đã đăng nhập). */
export const CLAUDE_CODE_PROVIDER_ID = 'claude-code';
export const CLAUDE_CODE_MODEL_ID = 'claude-code';

/** Tên provider / model của driver Codex (M2, qua `codex app-server`). */
export const CODEX_PROVIDER_ID = 'codex';
export const CODEX_MODEL_ID = 'codex';

/** Tên provider / model của driver Grok CLI (M2, qua ACP `grok … agent stdio`). */
export const GROK_CLI_PROVIDER_ID = 'grok-cli';
export const GROK_CLI_MODEL_ID = 'grok-cli';

/** Tên provider / model của driver OpenCode (M3, qua ACP `opencode acp`). */
export const OPENCODE_PROVIDER_ID = 'opencode';
export const OPENCODE_MODEL_ID = 'opencode';

/** Tên provider / model của driver Gemini CLI (M3, qua ACP `gemini --acp`). */
export const GEMINI_CLI_PROVIDER_ID = 'gemini-cli';
export const GEMINI_CLI_MODEL_ID = 'gemini-cli';

/** Tên provider / model của driver Cursor CLI (M3, qua ACP `cursor-agent acp`). */
export const CURSOR_CLI_PROVIDER_ID = 'cursor-cli';
export const CURSOR_CLI_MODEL_ID = 'cursor-cli';

/**
 * Tên provider của driver Custom ACP CLI (M3). Provider id duy nhất
 * là `custom-acp`; bot nào dùng CLI tuỳ chỉnh nào được phân biệt bằng
 * MODEL — chính là slug của CLI đó (vd model `my-agent`). Model mặc
 * định `custom-acp` chỉ là placeholder khi chưa chọn CLI nào.
 */
export const CUSTOM_ACP_PROVIDER_ID = 'custom-acp';
export const CUSTOM_ACP_MODEL_ID = 'custom-acp';

/** Tên provider / model của driver Aider (M4, one-shot `--message`). */
export const AIDER_PROVIDER_ID = 'aider';
export const AIDER_MODEL_ID = 'aider';

/** Tên provider / model của driver Continue CLI (M4, one-shot `-p`). */
export const CONTINUE_CLI_PROVIDER_ID = 'continue-cli';
export const CONTINUE_CLI_MODEL_ID = 'continue-cli';

/** Tên provider / model của driver Amazon Q CLI (M4, one-shot `chat --no-interactive`). */
export const AMAZON_Q_PROVIDER_ID = 'amazon-q';
export const AMAZON_Q_MODEL_ID = 'amazon-q';

/** Tên provider / model của driver GitHub Copilot CLI (M4, qua ACP `copilot --acp --stdio`). */
export const COPILOT_CLI_PROVIDER_ID = 'copilot-cli';
export const COPILOT_CLI_MODEL_ID = 'copilot-cli';

/** Tên provider / model của driver Windsurf / Devin CLI (M4, qua ACP `devin acp`). */
export const WINDSURF_PROVIDER_ID = 'windsurf';
export const WINDSURF_MODEL_ID = 'windsurf';

/** Tên provider / model của driver Kiro CLI (v0.76, one-shot `chat --no-interactive`). */
export const KIRO_CLI_PROVIDER_ID = 'kiro-cli';
export const KIRO_CLI_MODEL_ID = 'kiro-cli';
