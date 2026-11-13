/**
 * Shared contract for open-bot core.
 *
 * This file is THE contract: packages/tools, apps/desktop and any future
 * package import these types from @open-bot/core. Do not change a type
 * here without updating every consumer.
 */

import type { Tracer } from './tracing/index';
import type { BotApprovalLevel } from './approval/levels';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/**
 * v0.63 (vision channel): one image attached to a user message, as
 * base64 (WITHOUT the `data:` prefix — providers add their own
 * envelope: Gemini `inlineData`, OpenAI `image_url`, Anthropic
 * `image` source). Carried on `ChatMessage.attachments` (user
 * messages only) from `RunParams` → `AgentRunner` → provider.
 * Limits + validation live in `agent/vision.ts` (max 5 images,
 * 10 MB each, 20 MB total, PNG/JPEG/GIF/WebP only); the renderer
 * mirrors the 5-item cap (composer.ts `ATTACHMENT_MAX_ITEMS`).
 * The bytes travel in-process / over the local coordinator RPC only —
 * never logged (base64 would flood logs and could leak image content).
 */
export interface VisionAttachment {
  /** Image MIME type, e.g. `image/png` (see VISION_ALLOWED_MIME_TYPES). */
  mimeType: string;
  /** Raw image bytes, base64-encoded, no `data:` prefix. */
  data: string;
  /** Original file name (for error messages / display); optional. */
  name?: string;
  /**
   * v0.65 (vision persistence): true when the stored image is gone or
   * unreadable — the file was deleted/corrupted after the message was
   * saved, or its bytes fail the load-time checks (unknown mime,
   * over the per-image cap). `data` is '' in that case; the renderer
   * shows the name + an "unavailable" note instead of a thumbnail
   * (fail-closed, never a broken image or a crash). Never set on a
   * live-turn attachment (those always carry bytes); only
   * `BotMemory.getHistory({ includeAttachments: true })` produces it.
   */
  unavailable?: boolean;
}

export interface ChatMessage {
  role: Role;
  content: string;
  name?: string;
  toolCallId?: string;
  /**
   * v0.63 (vision channel): images attached to this (user) message.
   * Only the FIRST user message of a turn carries them (the loop
   * attaches them to the new user message); providers that support
   * vision render them as image parts, others never see them — the
   * loop refuses the turn with a friendly message first (see
   * `agent/vision.ts` `providerSupportsVision`). History messages
   * carry attachments ONLY when loaded with
   * `BotMemory.getHistory({ includeAttachments: true })` (v0.65:
   * files under `.open-bot/attachments/`, re-read as base64 for
   * display); run-context seeding and checkpoints never carry them —
   * `selectThreadHistory` strips them, so old images are never
   * re-sent to a provider on a later turn.
   */
  attachments?: VisionAttachment[];
  /**
   * Tool calls made by this assistant message. Stored so the next round
   * can send the assistant message back with its `tool_calls` attached —
   * OpenAI/Anthropic/Gemini all reject a bare tool result that is not
   * preceded by the assistant message carrying the matching call.
   */
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  ok: boolean;
  output: string;
  /**
   * v0.41 (P0-3, REA deep-dive lần 2 §3.3 — `started_at_ms` /
   * `completed_at_ms` của Grok `ToolCall`): epoch ms khi AgentRunner
   * bắt đầu / kết thúc tool call này (bao gồm cả hook + approval +
   * guardrail, không chỉ tool.execute). Ghi bởi `executeCall` trong
   * loop.ts; tool không tự điền. Trace span của tool call mang cùng
   * 2 mốc này dưới dạng attributes `started_at_ms` /
   * `completed_at_ms`.
   */
  startedAtMs?: number;
  /** Xem `startedAtMs`. */
  completedAtMs?: number;
  /**
   * v0.41 (P0-3 — `hook_additional_contexts`): context thêm mà hook
   * PreToolUse inject vào tool call này (theo thứ tự hook chạy).
   * Chỉ có khi ít nhất một hook inject; tool nhận cùng danh sách qua
   * `ToolContext.additionalContexts`.
   */
  hookAdditionalContexts?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * v0.12: tuỳ chọn chạy subagent chuyên biệt (xem `agent/subagent.ts`).
 * `instructions`/`tools`/`model`/`maxSteps` trống = chạy như subagent
 * thường (cùng system prompt, toàn bộ tool, cùng model).
 */
export interface SubagentOptions {
  timeoutMs?: number;
  /** Instructions riêng — đưa vào system prompt của subagent con. */
  instructions?: string;
  /** Subset tool theo tên; trống = toàn bộ tool của runner cha. */
  tools?: string[];
  /** Model riêng; trống = model của bot cha. */
  model?: string;
  /** Số bước tối đa của subagent con; trống = maxSteps của runner cha. */
  maxSteps?: number;
  /**
   * v0.37 (P1-4): role subagent chuyên biệt (xem `subagents/roles.ts`),
   * vd `researcher` / `coder` / `reviewer` / `planner` / `tester`.
   * Khi có role, con dùng system prompt + tool allowlist + giới hạn của
   * role đó; tool con = giao của (tool cha cho phép) ∩ (tool role cho
   * phép) ∩ (tools gọi trực tiếp, nếu có) — role chỉ thu hẹp, không mở
   * rộng quyền cha. Role không tồn tại → runSubagent trả lỗi rõ ràng,
   * không fallback lặng lẽ về subagent chung. `instructions`/`tools`/
   * `model`/`maxSteps`/`timeoutMs` gọi trực tiếp (nếu có) thắng giá trị
   * tương ứng của role.
   */
  role?: string;
  /**
   * v0.14: true = chạy subagent trong git worktree riêng (shadow
   * workspace) để không đụng workspace chính. Chỉ có tác dụng khi
   * workspace là git repo; không phải git repo thì chạy ở workspace
   * chính và ghi chú vào kết quả.
   */
  shadowWorkspace?: boolean;
  /**
   * v0.33 (P0-1 fork-execution): tracer của run cha — chỉ loop dùng
   * (khi spawn fork skill): loop đưa cho con một tracer con
   * (`Tracer.childTracer`, cùng run) để token usage của con được tính
   * vào trace của run; span thô của con không vào trace cha. Tool gọi
   * `runSubagent` không truyền field này nên subagent thường không ghi
   * trace.
   */
  tracer?: Tracer;
}

export interface ToolContext {
  workspaceDir: string;
  botId: string;
  signal?: AbortSignal;
  /**
   * Run a subagent (child AgentRunner) in the same process with the same
   * provider and tools. Wired by AgentRunner (v0.2); absent when a tool
   * runs outside a runner. Returns the child's summary text.
   * v0.12: `opts` nhận thêm instructions/tools/model/maxSteps để chạy
   * subagent chuyên biệt (xem `agent/subagent.ts`).
   */
  runSubagent?: (task: string, opts?: SubagentOptions) => Promise<string>;
  /**
   * v0.12: chạy nhiều subagent chuyên biệt song song rồi gộp kết quả
   * (xem `agent/subagent.ts`). Mỗi spec gồm tên + instructions + subset
   * tool + model/timeout riêng. Trả về text đã gộp (kèm mục xung đột nếu
   * có). Wired by AgentRunner; absent khi tool chạy ngoài runner.
   */
  runSpecializedSubagents?: (
    tasks: Array<{ spec: SubagentOptions & { name: string }; task: string }>,
  ) => Promise<string>;
  /** Snapshot of the subagents this runner has spawned. Wired by AgentRunner (v0.2). */
  subagentStatus?: () => Array<{ id: string; status: string }>;
  /**
   * v0.41 (P0-3 — `hook_additional_contexts` của Grok `ToolCall` #54):
   * context thêm mà hook PreToolUse inject vào tool call này, theo
   * thứ tự hook chạy. Loop điền từ `PreToolUseOutcome.
   * additionalContexts`; tool nào cần thì đọc (ví dụ: quy tắc
   * workspace, cảnh báo bảo mật) — không có thì undefined. Hook
   * không bao giờ inject secret vào đây (hook chỉ nhận HookContext
   * hẹp, không có secret).
   */
  additionalContexts?: string[];
}

export interface Tool {
  definition: ToolDefinition;
  needsApproval: boolean;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /**
   * v0.23 (W16b): stop sequences — provider dừng sinh text ở lần xuất
   * hiện đầu tiên của bất kỳ chuỗi nào trong danh sách (chuỗi dừng
   * không nằm trong text trả về). Nối native xuống provider hỗ trợ:
   * OpenAI-compatible `stop` (cả OpenAI/xAI/Ollama kế thừa),
   * Anthropic `stop_sequences`, Gemini `generationConfig.stopSequences`.
   * Provider tự viết (không qua 3 provider trên) mà bỏ qua trường này
   * vẫn được cắt client-side ở sampling handler (`clientHandlers.ts`)
   * làm backstop — nhưng khi đó không tiết kiệm token vì provider đã
   * sinh hết text rồi mới cắt.
   */
  stop?: string[];
  /**
   * v0.15: tín hiệu hủy cho một lần gọi provider. Provider phải kiểm tra
   * trước khi gọi fetch và truyền xuống fetch để hủy giữa chừng.
   * Không có signal = hành vi cũ (chạy tới khi xong hoặc hết timeout
   * nội bộ của provider).
   */
  signal?: AbortSignal;
}

export interface ProviderResponse {
  text: string;
  toolCalls: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ProviderConfig {
  id: string;
  label: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel: string;
  /**
   * M1 (detected CLI provider): đường dẫn tuyệt đối tới binary CLI
   * (do detector tìm thấy, vd `/usr/local/bin/claude`). Chỉ dùng cho
   * provider CLI (`claude-code`); provider API-key bỏ qua. Trống =
   * createProvider throw (fail-closed — không tự đoán binary trên PATH).
   */
  cliBinary?: string;
  /** M1: thư mục làm việc cho process CLI (mặc định process.cwd()). */
  cliCwd?: string;
  /**
   * M3 (custom ACP CLI): argv đưa CLI tuỳ chỉnh vào chế độ ACP stdio
   * (do user khai báo trong Settings → Engines, vd `['acp']` hay
   * `['--acp']`). Chỉ dùng cho provider `custom-acp`; provider khác
   * bỏ qua. Trống = createProvider throw (fail-closed).
   */
  cliArgs?: string[];
}

export interface Provider {
  id: string;
  label: string;
  chat(req: ChatCompletionRequest): Promise<ProviderResponse>;
  listModels(): Promise<string[]>;
  /**
   * v0.63 (vision channel): true when this provider can take image
   * attachments for `model` (see `agent/vision.ts`
   * `providerSupportsVision`). Absent = unknown → the helper falls
   * back to the provider-id table (CLI providers: false — their
   * transports send text prompts only). Providers that return true
   * MUST render `ChatMessage.attachments` as image parts in `chat()`
   * (Gemini inlineData, OpenAI image_url, Anthropic image source);
   * Ollama answers from the model name (vision models only).
   */
  supportsVision?(model: string): boolean;
  /**
   * M1: dọn tài nguyên của provider (vd kill process CLI đang sống).
   * Optional — provider API-key không cần. Coordinator gọi best-effort
   * khi bot bị xoá / app shutdown; không có thì bỏ qua.
   */
  dispose?: () => void | Promise<void>;
}

export interface BotConfig {
  id: string;
  name: string;
  providerId: string;
  model: string;
  systemPrompt: string;
  workspaceDir: string;
  autoApprove: boolean;
  /**
   * v0.50 (M8): mức approval riêng của bot — `ask-always` (hỏi mọi
   * tool call, kể cả chỉ-đọc), `ask-for-writes` (mặc định: chỉ hỏi
   * tool ghi/thực thi), `auto-approve-safe` (tự duyệt tool chỉ-đọc,
   * chỉ hỏi tool ghi). Không đặt / giá trị lạ → `ask-for-writes`.
   * Mức chỉ quyết định có HIỆN THẺ hay không, không vượt denylist
   * (xem `approval/levels.ts`).
   */
  approvalLevel?: BotApprovalLevel;
  /**
   * v0.20 (W14a): small-model guard toggle (desktop Settings). When
   * `false` the coordinator passes `smallModel: { enabled: false }` to
   * the runner, so a small-context model gets the full tool list
   * instead of forced plan-mode filtering. Unset = `true` (guard on,
   * the W12a behaviour).
   */
  smallModelGuard?: boolean;
  /**
   * v0.59 (UI-3): tool bị tắt riêng cho bot này — lưu bền trong
   * settings của main (`bots[].denyTools`) và đăng ký vào
   * AgentPermissions (deny thắng, xem agent/permissions.ts) khi bot
   * được tạo; `filterTools` mỗi turn loại chúng khỏi definitions gửi
   * cho model. Không đặt / rỗng = cho phép hết (trừ denylist khác).
   * Từ v0.65, clone/publish/install giữ nguyên danh sách này
   * (`sanitizeConfig` copy mảng mới, xem agent/marketplace.ts).
   */
  denyTools?: string[];
  /**
   * v0.64 (skills per-bot): skill bị tắt riêng cho bot này — lưu bền
   * trong settings của main (`bots[].denySkills`) và đăng ký vào
   * AgentPermissions (deny thắng, xem agent/permissions.ts) khi bot
   * được tạo; coordinator mỗi turn loại chúng khỏi skill index (tier
   * 1), body (tier 2) và fork (v0.33) nên skill bị tắt không load,
   * không fork, không tốn context. Không đặt / rỗng = cho phép hết
   * (trừ skill đã tắt toàn cục trong registry). Từ v0.65,
   * `sanitizeConfig` (agent/marketplace.ts) giữ field này (copy mảng
   * mới) khi clone/publish/install — bot clone giữ nguyên skill bị tắt
   * của bot gốc, như `denyTools`.
   */
  denySkills?: string[];
  /**
   * v0.90b (đội G, model picker hoàn thiện): provider bị tắt riêng cho
   * bot này — lưu bền trong settings của main (`bots[].disabledProviders`).
   * Picker của bot chỉ hiện nguồn đang bật; nguồn của model đang chạy mà
   * bị tắt thì picker báo rõ + gợi ý model thay thế, KHÔNG tự đổi model
   * (xem `filterRailForBot` trong models/rail.ts). Run/switch-model tới
   * provider trong danh sách này bị chặn fail-closed với lỗi rõ ràng.
   * Không đặt / rỗng = cho phép hết (mọi nguồn bật toàn cục đều dùng được).
   * `sanitizeConfig` giữ field này khi clone/publish/install, như
   * denyTools/denySkills.
   */
  disabledProviders?: string[];
  /**
   * v0.61 (UI-13): display colour of the bot (one of the 8 palette
   * hexes in the renderer `botColors.ts`) — shown as the avatar circle
   * in the sidebar / chat header. Display-only: the coordinator never
   * reads it, and an unknown value falls back to the default colour in
   * the renderer. Not set = default colour.
   */
  color?: string;
  /**
   * v0.77 (UI parity §3.3): mô tả ngắn của bot — hiển thị dưới tên bot
   * ở sidebar để nhận diện bot ngoài tên/provider/model. Display-only:
   * coordinator không đọc. Tối đa 500 ký tự (main + `sanitizeConfig`
   * cắt ngắn; xem `agent/marketplace.ts`). Không đặt / rỗng = không hiện.
   */
  description?: string;
  /**
   * v0.96 (Đội T2): repo map tự chèn vào system prompt mỗi turn
   * (Personalized PageRank trên đồ thị tham chiếu file, signature-only,
   * vừa token budget). `false` = tắt hẳn cho bot này (Settings → Model);
   * không đặt / `true` = bật cho bot có thư mục làm việc.
   */
  repoMapEnabled?: boolean;
  /**
   * v0.96 (Đội T2): token budget của repo map cho bot này (mặc định
   * 1024; nhân 8 khi lượt chat không nhắc file nào). Số <= 0 hoặc
   * không đặt = dùng mặc định.
   */
  repoMapTokenBudget?: number;
}

/**
 * v0.12 (interrupt_before): quyết định phê duyệt có thể kèm tham số đã sửa.
 * `true`/`false` (dạng cũ) vẫn dùng được — `true` = duyệt nguyên args gốc.
 */
export interface ApprovalDecision {
  approved: boolean;
  /** Tham số đã sửa bởi người duyệt; trống = giữ nguyên args gốc. */
  args?: Record<string, unknown>;
}

export interface AgentEvents {
  onText(delta: string): void;
  onToolCall(call: ToolCall): void;
  onToolResult(r: ToolResult): void;
  /**
   * Ask for approval before a tool runs. The approver may return plain
   * `true`/`false`, or an `ApprovalDecision` with edited `args` (v0.12
   * interrupt_before: dừng, sửa tham số, rồi chạy tiếp với args mới).
   */
  onApprovalNeeded(call: ToolCall): Promise<boolean | ApprovalDecision>;
  /**
   * Ask the user a question and wait for their answer (v0.2, ask_user tool).
   * Optional: when absent, the loop returns a clear "not supported in this
   * session" error instead of crashing.
   */
  onAskUser?: (question: string, options?: string[]) => Promise<string>;
  /** Progress update for the user (v0.2, send_progress_update tool). */
  onProgress?: (message: string) => void;
  /** Final summary when a job is done (v0.2, send_final_summary tool). */
  onFinalSummary?: (summary: string) => void;
}
