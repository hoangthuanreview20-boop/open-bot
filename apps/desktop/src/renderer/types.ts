/**
 * Renderer-side view types for the open-bot desktop UI.
 *
 * These mirror the IPC payloads produced by src/main (main.ts / preload.ts)
 * — bots, chat history, tasks, settings and tool calls.
 *
 * They are deliberately self-contained (no import from @open-bot/core) so the
 * renderer typecheck does not depend on workspace package resolution.
 */

// v0.65: the renderer-local vision attachment shape (composer.ts is
// import-free, so this creates no cycle).
import type { VisionAttachment } from './components/composer';

/** Bot as the renderer sees it (same shape as core BotConfig). */
export interface BotConfigLike {
  id: string;
  name: string;
  providerId: string;
  model: string;
  systemPrompt: string;
  workspaceDir: string;
  autoApprove: boolean;
  /** v0.20 (W14a): small-model guard toggle; unset = guard on. */
  smallModelGuard?: boolean;
  /**
   * v0.59 (UI-3): tool bị tắt riêng cho bot này (mirror của
   * `BotConfig.denyTools` trong core) — màn Tools ghi qua IPC
   * `tools:toggle`, persist trong settings của main.
   */
  denyTools?: string[];
  /**
   * v0.64 (skills per-bot): skill bị tắt riêng cho bot này (mirror
   * của `BotConfig.denySkills` trong core) — màn Tools ghi qua IPC
   * `bot-skills:toggle`, persist trong settings của main.
   */
  denySkills?: string[];
  /**
   * v0.90b (đội G): provider bị tắt riêng cho bot này (mirror của
   * `BotConfig.disabledProviders` trong core) — picker của bot chỉ
   * hiện nguồn đang bật; nguồn của model đang chạy bị tắt thì picker
   * báo rõ + gợi ý model thay thế, không tự đổi model.
   */
  disabledProviders?: string[];
  /**
   * v0.50 (M8): mức approval riêng của bot — `ask-always` |
   * `ask-for-writes` (mặc định) | `auto-approve-safe`. Không đặt →
   * `ask-for-writes`.
   */
  approvalLevel?: 'ask-always' | 'ask-for-writes' | 'auto-approve-safe';
  /**
   * v0.62 (UI-13): display colour of the bot (mirror of
   * `BotConfig.color` in core) — avatar circle in the sidebar / chat
   * header. Unset / unknown = default colour (see botColors.ts).
   */
  color?: string;
  /**
   * v0.77 (UI parity §3.3): short description of the bot (mirror of
   * `BotConfig.description` in core, max 500 chars) — shown under the
   * bot name in the sidebar. Unset / empty = not shown.
   */
  description?: string;
  /**
   * v0.96 (Team T2): repo map toggle for the bot (mirror of
   * `BotConfig.repoMapEnabled` in core) — unset / true = repo map on.
   */
  repoMapEnabled?: boolean;
  /**
   * v0.96 (Team T2): repo map token budget for the bot (mirror of
   * `BotConfig.repoMapTokenBudget` in core) — unset / <= 0 = default 1024.
   */
  repoMapTokenBudget?: number;
}

/** One chat message as shown in the UI / returned by chat:history. */
export interface ChatMessageView {
  id: string;
  role: string;
  text: string;
  createdAt: number;
  /**
   * v0.65 (vision persistence): images attached to this user message
   * (renderer mirror of core `VisionAttachment` — see composer.ts).
   * The optimistic bubble carries them from the send; a history
   * reload re-reads them from storage (files under
   * `.open-bot/attachments/`). A stored image whose file is gone or
   * corrupt arrives with `data: ''` + `unavailable: true` — the
   * renderer shows a note instead of a thumbnail.
   */
  attachments?: VisionAttachment[];
  /**
   * v0.60 (UI-8): token/usage of the turn that produced this assistant
   * message — attached in-memory by App (diff of `usage:get`
   * before/after the run, see components/turnUsage.ts). Never persisted:
   * a history reload has no per-turn usage, so old messages simply show
   * no footer.
   */
  usage?: TurnUsageView;
}

/**
 * v0.60 (UI-8): token/usage of one chat turn (mirror of the
 * `SpendWindowData` diff — input/output tokens as the provider reported
 * them, estimated USD cost, provider calls in the turn).
 */export interface TurnUsageView {
  inputTokens: number;
  outputTokens: number;
  /** Estimated USD cost of the turn; null when any call was unpriced. */
  costUsd: number | null;
  /** Provider calls in the turn (more than one when tools loop). */
  calls: number;
}

/**
 * v0.59 (UI-5): one conversation thread of a bot (mirror of core
 * ThreadItem — IPC `threads:*`). A bot has many threads; each thread
 * owns its messages. `titleCustom` = true when the user renamed the
 * thread by hand (auto-titling from the first user message only runs
 * while it is false).
 */
export interface ThreadView {
  id: string;
  botId: string;
  title: string;
  titleCustom: boolean;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

/** v0.59 (UI-5): one thread hit from a title/content search. */
export interface ThreadSearchHitView {
  thread: ThreadView;
  snippet: string;
  matchCount: number;
}

/**
 * One tool call as the renderer sees it. The main process sends the core
 * ToolCall ({ id, name, args }); the UI also tolerates the alternate
 * `tool` / `arguments` spellings when rendering.
 */
export interface ToolCallView {
  id?: string;
  name?: string;
  tool?: string;
  args?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * v0.59 (UI-3): một tool của bot trong màn Tools — mirror của
 * `BotToolInfo` trong core (coordinator/types.ts), do IPC
 * `tools:list` trả về. Renderer tự chứa, không import core.
 */
export interface BotToolInfoView {
  name: string;
  description: string;
  group: string;
  source: 'core' | 'composio' | 'plugin';
  readOnly: boolean;
  enabled: boolean;
  cappedByApp: boolean;
  tokenEstimate: number;
  needsApproval: boolean;
  parameters: {
    properties: Record<string, string>;
    required: string[];
  };
}

/** Kết quả IPC `tools:list` cho một bot. */
export interface ListBotToolsResultView {
  botId: string;
  tools: BotToolInfoView[];
  totalTools: number;
  enabledTools: number;
  enabledTokens: number;
  totalTokens: number;
}

/** Kết quả IPC `tools:toggle` cho một tool. */
export interface SetBotToolEnabledResultView {
  botId: string;
  toolName: string;
  enabled: boolean;
  denyTools: string[];
}

/**
 * v0.95 (Team D1): Internet data — mirror của `InternetFeed` /
 * `InternetWatch` / `InternetDataState` trong
 * packages/tools/src/internetData.ts, do IPC `internet-data:*` trả
 * về. Self-contained như các View type khác (không import tools).
 */
export interface InternetFeedView {
  id: string;
  url: string;
  title: string;
  addedAt: number;
  lastCheckedAt?: number;
  lastItemCount?: number;
}

export interface InternetWatchView {
  id: string;
  url: string;
  intervalMinutes: number;
  lastHash?: string;
  lastCheckedAt?: number;
  lastChangedAt?: number;
  lastSummary?: string;
  lastError?: string;
}

export interface InternetDataStateView {
  version: 1;
  feeds: InternetFeedView[];
  watches: InternetWatchView[];
}

export interface InternetFeedItemView {
  title: string;
  link: string;
  published: string;
  summary: string;
  id: string;
}

export interface InternetWatchChangeView {
  watch: InternetWatchView;
  changed: boolean;
  summary: string;
  addedLines: string[];
  removedLines: string[];
  checkedAt: number;
}

export interface InternetWatchChangedPayloadView {
  botId: string;
  url: string;
  summary: string;
  checkedAt?: number;
}

/**
 * v0.64 (skills per-bot): một skill của bot trong màn Tools — mirror
 * của `BotSkillInfo` trong core (coordinator/types.ts), do IPC
 * `bot-skills:list` trả về. `enabled` = skill chưa bị tắt riêng cho
 * bot này; `globallyEnabled` = skill đang bật toàn cục (Settings →
 * Skills) — tắt toàn cục thì toggle theo bot bị khoá.
 */
export interface BotSkillInfoView {
  name: string;
  description: string;
  context: 'fork' | 'inline';
  allowedTools: string[];
  enabled: boolean;
  globallyEnabled: boolean;
}

/** Kết quả IPC `bot-skills:list` cho một bot. */
export interface ListBotSkillsResultView {
  botId: string;
  skills: BotSkillInfoView[];
  totalSkills: number;
  enabledSkills: number;
}

/** Kết quả IPC `bot-skills:toggle` cho một skill. */
export interface SetBotSkillEnabledResultView {
  botId: string;
  skillName: string;
  enabled: boolean;
  denySkills: string[];
}

/** Approval request sent by main when a tool call needs the user. */
export interface ApprovalRequest {
  botId: string;
  callId: string;
  call: ToolCallView;
  /** v0.50 (M8): lý do cần duyệt (coordinator tính, vd tool cần phê duyệt). */
  reason?: string;
  /** v0.50 (M8): args rút gọn, secret đã redact (coordinator tính). */
  argsSummary?: string;
}

/** Permission request from a CLI engine via the harness broker (M8). */
export interface HarnessPermissionRequestView {
  requestId: string;
  botId: string;
  engine: string;
  method: string;
  detail?: string;
  /** False = method không có đường cho phép an toàn → chỉ có nút từ chối. */
  allowable: boolean;
}

/**
 * v0.90a (Đội G): kind event harness (đồng bộ HarnessEventKind của
 * core — giữ danh sách ở đây để renderer không import core).
 */
export type HarnessEventKindView =
  | 'text'
  | 'tool_call'
  | 'result'
  | 'error'
  | 'abort'
  | 'approval_request'
  | 'approval_denied'
  | 'permission_request'
  | 'permission_denied'
  | 'approval_decision'
  | 'lifecycle';

/** v0.90a (Đội G): một event harness đã sanitize (bus + NDJSON + SSE + IPC live). */
export interface HarnessEventView {
  instanceId?: string;
  botId: string;
  threadId: string;
  engine?: string;
  kind: HarnessEventKindView;
  /** Payload ĐÃ sanitize — tool_call chỉ có tên tool + tên key args. */
  payload: Record<string, unknown>;
  at: string;
}

/** v0.90a (Đội G): một dòng log NDJSON theo thread (đã sanitize). */
export interface HarnessThreadLogEntryView {
  at: string;
  botId: string;
  threadId: string;
  kind: HarnessEventKindView;
  payload: Record<string, unknown>;
  /** Engine — chỉ có ở event live (log NDJSON không lưu engine). */
  engine?: string;
}

/** v0.90a (Đội G): kết quả đọc log theo thread (phân trang, IPC `harness:thread-log`). */
export interface HarnessThreadLogView {
  threadId: string;
  entries: HarnessThreadLogEntryView[];
  total: number;
  offset: number;
  limit: number;
}

/** v0.90a (Đội G): trạng thái harness (IPC `harness:status`). */
export interface HarnessStatusView {
  enabled: boolean;
  instances: Array<{
    instanceId: string;
    botId: string;
    engine: string;
    providerId: string;
    threadId?: string;
    pid?: number;
    status: string;
    startedAt: string;
    lastEventAt: string;
    exitCode?: number | null;
  }>;
  pendingPermissions: HarnessPermissionRequestView[];
  decisionsTotal: number;
  logDir?: string;
  snapshotFile?: string;
}

/**
 * v0.97 (Team T3): AG-UI event types (mirror of core AgUiEventType —
 * renderer keeps its own copy so it never imports core).
 */
export type AgUiEventTypeView =
  | 'RUN_STARTED'
  | 'RUN_FINISHED'
  | 'RUN_ERROR'
  | 'TEXT_MESSAGE_START'
  | 'TEXT_MESSAGE_CONTENT'
  | 'TEXT_MESSAGE_END'
  | 'TOOL_CALL_START'
  | 'TOOL_CALL_ARGS'
  | 'TOOL_CALL_END'
  | 'TOOL_CALL_RESULT'
  | 'STATE_SNAPSHOT'
  | 'STATE_DELTA'
  | 'CUSTOM'
  | 'GENERATIVE_UI'
  | 'GENERATIVE_UI_RESPONSE'
  | 'ACTIVITY';

/** v0.97 (Team T3): one AG-UI event as the renderer sees it (validated upstream). */
export interface AgUiEventView {
  protocol: string;
  type: AgUiEventTypeView;
  runId: string;
  botId?: string;
  threadId?: string;
  messageId?: string;
  toolCallId?: string;
  sequence?: number;
  timestamp: string;
  data: Record<string, unknown>;
}

/** v0.97 (Team T3): generative-UI component kinds the renderer can render. */
export type AgUiComponentKindView =
  | 'confirm'
  | 'options'
  | 'form'
  | 'table'
  | 'progress'
  | 'message';

/** v0.97 (Team T3): shared run state as read through IPC `agui:run-state`. */
export interface AgUiRunStateView {
  runId: string;
  botId?: string;
  state: Record<string, unknown>;
  version: number;
  updatedAt: string;
  appliedEvents: number;
}

/** v0.86c: một canvas trong danh sách (trả bởi `canvas:list`). */
export interface CanvasSummaryView {
  id: string;
  title: string;
  version: number;
  updatedAt: string;
  blockCount: number;
}

/** v0.86c: một block trong tài liệu canvas — `type` tự do, app quyết định nghĩa. */
export interface CanvasBlockView {
  type: string;
  [key: string]: unknown;
}

/** v0.86c: toàn bộ tài liệu canvas (trả bởi `canvas:get`). */
export interface CanvasDocumentView {
  id: string;
  title: string;
  blocks: CanvasBlockView[];
  version: number;
  updatedAt: string;
  botId: string;
}

/** v0.86 (P2-7): một crash report trong danh sách (trả bởi `crash-reports:list`). */
export interface CrashReportSummaryView {
  id: string;
  createdAt: string;
  source: 'main' | 'renderer';
  kind: 'uncaughtException' | 'unhandledRejection' | 'renderer-error';
  message: string;
}

/** v0.86 (P2-7): toàn bộ crash report (trả bởi `crash-reports:get`). */
export interface CrashReportView {
  id: string;
  version: number;
  createdAt: string;
  source: 'main' | 'renderer';
  kind: 'uncaughtException' | 'unhandledRejection' | 'renderer-error';
  message: string;
  stack?: string;
  platform: string;
  appVersion?: string;
  nodeVersion?: string;
  sent: boolean;
}

/** One group chat (bot-bot) as listed by the coordinator (M8). */
export interface GroupChatView {
  id: string;
  name: string;
  botIds: string[];
  createdAt: string;
}

/** One message in a group chat (M8). */
export interface GroupMessageView {
  id: string;
  groupId: string;
  botId: string;
  botName: string;
  text: string;
  mentions: string[];
  delegated: boolean;
  /**
   * v0.94c: ảnh đính kèm — tham chiếu file, KHÔNG có bytes (renderer
   * lấy bytes qua `group:get-attachment` để hiện thumbnail).
   */
  attachments?: GroupMessageAttachmentView[];
  createdAt: string;
}

/** One image attached to a group message (v0.94c) — file reference only. */
export interface GroupMessageAttachmentView {
  id: string;
  mimeType: string;
  name?: string;
  sizeBytes: number;
  file: string;
}

/** One channel (v0.96 Team T4) — mirror of core `Channel`. */
export interface ChannelView {
  id: string;
  name: string;
  kind: 'work' | 'personal' | 'project';
  sharedInstructions: string;
  workingFolder: string;
  botIds: string[];
  responderRules: {
    mode: 'mentioned' | 'all' | 'round-robin' | 'first' | 'none';
    onlyBotIds?: string[];
    requireMentionFor?: string[];
  };
  createdAt: string;
  updatedAt: string;
}

/** One message in a channel transcript (v0.96 Team T4). */
export interface ChannelMessageView {
  id: string;
  channelId: string;
  botId: string;
  botName: string;
  text: string;
  mentions: string[];
  delegated: boolean;
  createdAt: string;
}

/** v0.79a: một bot đang chạy trong group chat (trả bởi `group:status`). */
export interface GroupBotStatusView {
  botId: string;
  status: 'running';
  since: string;
}

/** v0.82: một bot đang chạy dở thì app dừng (trả bởi `group:status`). */
export interface GroupBotInterruptedView {
  botId: string;
  since: string;
}

/** Question sent by main when the agent runs the ask_user tool. */
export interface AskUserRequest {
  botId: string;
  requestId: string;
  question: string;
  options?: string[];
}

/**
 * v0.54 (P1-8): yêu cầu interrupt — run dừng ở biên an toàn để hỏi user
 * (mirror của `InterruptRequest` trong core + `requestId` để trả lời).
 */
export interface InterruptRequestView {
  botId: string;
  requestId: string;
  runId: string;
  stepIndex: number;
  reason: string;
  question?: string;
  toolCall?: { id?: string; name?: string; args?: Record<string, unknown> };
}

/** v0.54 (P1-8): quyết định của user khi run dừng ở điểm interrupt. */
export type InterruptDecisionView =
  | { action: 'continue' }
  | { action: 'continue-with-message'; message: string }
  | { action: 'deny-tool' }
  | { action: 'cancel' };

/** v0.54 (P1-8): tóm tắt nhẹ một checkpoint (không chứa full history). */
export interface CheckpointSummaryView {
  id: string;
  runId: string;
  botId: string;
  stepIndex: number;
  messageCount: number;
  toolCallCount: number;
  tokensUsed: number;
  createdAt: string;
}

/**
 * v0.54 (P1-9): trạng thái update đầy đủ từ UpdateService (mirror của
 * `UpdateStatus` trong main/updateService.ts).
 */
export interface UpdateStatusView {
  track: 'lab' | 'nightly' | 'dogfood' | 'stable';
  currentVersion: string;
  available: boolean;
  latestVersion: string | null;
  latestTag: string | null;
  htmlUrl: string | null;
  checkFailed: boolean;
  error?: string;
  errorCode?: string;
  feedStatus: 'github-stable' | 'github-releases-list' | 'stub-no-feed';
  updateRequired: boolean;
  minClientVersion: string | null;
  updateRequiredByPolicy: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
}

/** A progress update or final summary sent by the agent. */
export interface Notice {
  id: string;
  kind: 'progress' | 'summary';
  text: string;
}

/**
 * v0.86 (P2-6): deep-link route main đẩy qua IPC `deep-link:open` /
 * `deep-link:pending` — mirror của DeepLinkRoute trong @open-bot/core
 * (xem packages/core/src/deeplink.ts). Renderer tự chứa, không import core.
 */
export type DeepLinkRouteView =
  | { kind: 'chat' }
  | { kind: 'bot'; botId: string }
  | { kind: 'settings' }
  | { kind: 'canvas' };

/** One task/routine row as listed by tasks:list. */
export interface TaskView {
  id: string;
  botId?: string;
  title: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  detail?: string;
}

/**
 * v0.28: trạng thái lưu task A2A (mirror của `A2aPersistStatus` trong
 * core) — dùng cho banner cảnh báo khi lưu thất bại sau hết retry.
 */
export interface A2aPersistStatusView {
  ok: boolean;
  lastError: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastAttempts: number;
  consecutiveFailures: number;
  totalFailures: number;
}

/**
 * v0.31 (P1-2): agent A2A ngoài mà user đã tin tưởng — mirror của
 * `TrustedA2aAgent` trong preload.ts / main.ts.
 */
export interface TrustedA2aAgentView {
  baseUrl: string;
  name: string;
  description?: string;
  url: string;
  skills?: Array<{ id: string; name: string; description: string }>;
  streaming?: boolean;
  trustedAt: string;
  /** v0.97: fingerprint key đã ký card lúc trust. */
  cardKeyId?: string;
}

/** v0.97 (Đội T2 — A2A 1.0): policy mạng A2A (mirror của preload/main). */
export interface A2aNetworkPolicyView {
  allowExternal: boolean;
  warningAcknowledged: boolean;
}

/** v0.97 (Đội T2 — A2A 1.0): kết quả verify Agent Card (mirror của preload/main). */
export interface A2aCardVerificationView {
  baseUrl: string;
  name: string;
  url: string;
  version: {
    ok: boolean;
    cardVersion: string | null;
    negotiated: string | null;
    warnings: string[];
    reason?: string;
  };
  signature: {
    present: boolean;
    valid: boolean;
    keyId: string | null;
    trustedBefore: boolean;
    firstSeen: boolean;
    reason: string | null;
  };
  trusted: boolean;
}

/** v0.31 (P1-2): kết quả gửi task thử tới agent ngoài (`a2a:trusted-send`). */
export interface A2aSendResultView {
  taskId: string;
  state: string;
  text: string;
  artifacts: Array<{ artifactId: string; name: string | null; text: string }>;
}

/** Settings as sent to the renderer (API keys never leave main). */
export interface SettingsView {
  providers: Record<string, { apiKeySet: boolean; baseUrl: string; defaultModel: string }>;
  bots: BotConfigLike[];
  /** UI locale code, e.g. 'vi' | 'en'. Defaults to 'vi' when unset. */
  locale: string;
  /** v0.86 (P2-7): crash reporting có đang bật không (mặc định tắt). */
  crashReportingEnabled: boolean;
  /** v0.87c: OS notifications theo từng loại (mặc định cả 3 đều bật). */
  notifications: { runComplete: boolean; approval: boolean; runError: boolean };
}

/** A built-in agent template (v0.3), as returned by templates:list. */
export interface AgentTemplateLike {
  id: string;
  name: string;
  description: string;
  category: string;
  systemPrompt: string;
  providerId?: string;
  model?: string;
  suggestedTools: string[];
  workspaceSetup?: string;
}

/** One locally published agent (v0.3), as returned by marketplace:list. */
export interface PublishedAgentLike {
  id: string;
  name: string;
  description: string;
  templateId?: string;
  config: BotConfigLike;
  author: string;
  createdAt: string;
  installs: number;
}

/** One tool of an MCP marketplace server, as returned by a probe (v0.67a). */
export interface McpMarketplaceToolLike {
  name: string;
  description?: string;
  /** Raw JSON Schema for the tool's arguments (properties + required). */
  inputSchema?: Record<string, unknown>;
}

/** One list warning a marketplace probe collected (v0.73) — the
 *  `-32602` tools/list rejection the client reports through
 *  `McpServerConfig.onWarning`; plain data from the main process. */
export interface McpMarketplaceWarningLike {
  method: 'tools/list' | 'resources/list';
  code: number;
  message: string;
  detail: string;
}

/** Result of probing one marketplace server for its tools (v0.67a). */
export interface McpMarketplaceProbeResultLike {
  serverId: string;
  status: 'ok' | 'needs-key' | 'error';
  tools: McpMarketplaceToolLike[];
  truncated: boolean;
  error?: string;
  /** v0.73: present when the probe's tools/list was rejected (-32602)
   *  — explains an 'ok' probe with no tools. */
  warnings?: McpMarketplaceWarningLike[];
}

/** One MCP server from the local catalogue (v0.3), as returned by mcp-marketplace:list. */
export interface McpMarketplaceServerLike {
  id: string;
  name: string;
  description: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  /** Human-readable description of the credential needed — never a real value. */
  needsKey?: string;
  tags: string[];
  /** v0.89a (Marketplace v2): catalogued version (semver), when the registry records one. */
  version?: string;
  /** v0.89a: human-readable notes about this version. */
  changelog?: string;
  /** v0.89a: oldest app version this server version works with. */
  minAppVersion?: string;
  /** v0.89a: where the entry came from (local registry vs remote catalog). */
  source?: 'local' | 'remote';
  /** v0.89a: catalog URL the entry came from (remote entries only). */
  catalogUrl?: string;
}

/** v0.98 (T6): one open MCP App, as returned by mcp-apps:list (mirror of AppSnapshot in core — no HTML here, see McpAppFullViewLike). */
export interface McpAppViewLike {
  id: string;
  serverName: string;
  toolName?: string;
  title: string;
  sourceUri?: string;
  origin: 'tool-result' | 'manual' | 'sample';
  openedAt: number;
  htmlBytes: number;
}

/** v0.98 (T6): one open MCP App with its HTML, as returned by mcp-apps:get (only fetched when rendering). */
export interface McpAppFullViewLike extends McpAppViewLike {
  html: string;
}

/** v0.98 (T6): MCP task status (mirror of TaskStatus in core mcp/tasks). */
export type McpTaskStatusView = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

/** v0.98 (T6): one tracked MCP task, as returned by mcp-tasks:list (mirror of TaskSnapshot in core — result/error are JSON-safe). */
export interface McpTaskViewLike {
  key: string;
  taskId: string;
  serverName: string;
  method: string;
  label: string;
  status: McpTaskStatusView;
  specVersion: '2025-11-25' | '2026-07-28';
  createdAt: number;
  updatedAt: number;
  timeoutMs?: number;
  timedOut: boolean;
  pollIntervalMs: number;
  result?: unknown;
  error?: string;
  /** Workspace the task belongs to (needed to cancel it). */
  workspaceDir: string;
}

/** v0.89a (Marketplace v2): one row of `mcp-marketplace:check-updates`. */
export interface McpUpdateInfoLike {
  id: string;
  name: string;
  installedVersion: string;
  latestVersion: string | null;
  changelog?: string;
  minAppVersion?: string;
  updateAvailable: boolean;
  compatible: boolean;
}

/** v0.89a (Marketplace v2): one installed plugin as returned by `plugin-marketplace:list`. */
export interface PluginMarketplaceViewLike {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string | null;
  enabled: boolean;
  tools: string[];
  source: { kind: string; url?: string; path?: string } | null;
  sandboxed: boolean;
  installedAt: string | null;
  /** v0.93a: signature status from the install record (see docs/plugin-marketplace-signing.md). */
  signatureStatus?: 'signed' | 'unsigned-allowed' | 'unsigned-local' | null;
  /** v0.93a: key id that signed the installed bundle (when signed). */
  signatureKeyId?: string | null;
  /** v0.93a: version a downgrade would restore to (null when none). */
  previousVersion?: string | null;
}

/** v0.94a: what version a plugin can be downgraded to (docs/plugin-marketplace-signing.md §5). */
export interface PluginDowngradeInfoLike {
  id: string;
  currentVersion: string;
  previousVersion: string | null;
  canDowngrade: boolean;
  /** Clear reason when canDowngrade is false. */
  reason?: string;
}

/** v0.94a: result of a successful plugin downgrade. */
export interface PluginDowngradeResultLike {
  id: string;
  fromVersion: string;
  toVersion: string;
}

/**
 * v0.94a: one trusted publisher key, as listed by
 * `plugin-marketplace:trusted-keys`. Public key material is never
 * sent to the renderer — only the derived keyId, the label and the
 * date it was added.
 */
export interface TrustedMarketplaceKeyLike {
  keyId: string;
  label?: string;
  addedAt: string;
}

/** v0.89a (Marketplace v2): one row of `plugin-marketplace:check-updates`. */
export interface PluginUpdateInfoLike {
  id: string;
  name: string;
  installedVersion: string;
  latestVersion: string | null;
  changelog?: string;
  minAppVersion?: string;
  updateAvailable: boolean;
  compatible: boolean;
}

/** v0.89a (Marketplace v2): a plugin staged by `plugin-marketplace:prepare`. */
export interface PreparedPluginLike {
  stagingId: string;
  id: string;
  name: string;
  version: string;
  description: string;
  author: string | null;
  permissions: string[];
}

/** One installed MCP server config (v0.3), as stored in a workspace mcp.json. */
export interface McpServerConfigLike {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** Team role (v0.3, local config only). */
export type TeamRoleLike = 'admin' | 'member' | 'viewer';

/** One usage window (day / month / total) with its spend limit (v0.4). */
export interface SpendWindowData {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  calls: number;
  unpricedCalls: number;
  limitUsd?: number;
  percentUsed: number | null;
}

/** Spend status across the day / month / total windows (v0.4). */
export interface SpendStatusData {
  today: SpendWindowData;
  month: SpendWindowData;
  total: SpendWindowData;
}

/** One automation as the renderer sees it (v0.4). */
export interface AutomationLike {
  id: string;
  botId: string;
  name: string;
  trigger: {
    kind: string;
    minutes?: number;
    expression?: string;
    window?: { minutes?: number };
    event?: string;
    pathPattern?: string;
    keyId?: string;
    triggerSlug?: string;
    tokenKeyId?: string;
  };
  condition?: { textContains?: string; pathPattern?: string };
  action: {
    kind: string;
    botId?: string;
    prompt?: string;
    tool?: string;
    args?: Record<string, unknown>;
    title?: string;
    message?: string;
  };
  enabled: boolean;
  triggerDescription?: string;
  triggerPresentation?: { label: string; detail?: string; icon?: string };
  validateOnEnable?: boolean;
  createdBy?: string;
  access?: { roles?: string[] };
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One recorded automation run (v0.4). */
export interface AutomationRunLike {
  id: string;
  automationId: string;
  startedAt: string;
  finishedAt?: string;
  /** `running` = in-flight record, written at start and updated in place on finish. */
  status: 'ok' | 'error' | 'skipped' | 'running';
  /** Trigger kind that fired this run (see core AutomationRun). */
  trigger?: string;
  output?: string;
  error?: string;
  triggerInput?: string;
  retriedFromRunId?: string;
}

/** Worker-pool + tool-cache snapshot for the Performance section (v0.4). */
export interface PerfStatsView {
  pool: {
    workers: number;
    busyWorkers: number;
    idleWorkers: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
    effectiveConcurrency: number;
  };
  cache: {
    entries: number;
    hits: number;
    misses: number;
    evictions: number;
    maxEntries: number;
  } | null;
}

/** Team config (v0.3), as returned by team:get. */
export interface TeamConfigLike {
  id: string;
  name: string;
  members: Array<{ userId: string; name: string; role: TeamRoleLike }>;
  sharedBots: Array<{ botId: string; sharedBy: string }>;
}

/**
 * v0.80: portable team bundle as it crosses IPC (mirror of core
 * `TeamBundle` — the renderer only displays the summary/conflicts and
 * hands the bundle back to `team:import-apply` untouched).
 */
export interface TeamBundleView {
  kind: string;
  version: number;
  exportedAt: string;
  teamId: string;
  checksum: string;
  data: {
    team: TeamConfigLike;
    bots: BotConfigLike[];
    automations: Array<{ id: string; name: string }>;
    skills: Array<{ name: string; content: string }>;
  };
}

export interface TeamImportSummaryView {
  teamName: string;
  teamId: string;
  bots: number;
  automations: number;
  skills: number;
  exportedAt: string;
}

export interface TeamImportConflictView {
  kind: 'team' | 'bot' | 'automation' | 'skill';
  id: string;
  detail: string;
}

export interface TeamImportApplyResultView {
  report: {
    teamChanged: boolean;
    botsAdded: number;
    botsReplaced: number;
    botsSkipped: number;
    automationsAdded: number;
    automationsReplaced: number;
    automationsSkipped: number;
    skillsWritten: number;
    skillsSkipped: number;
    webhookDisabled: number;
  };
  skipped: Array<{ kind: 'team' | 'bot' | 'automation' | 'skill'; id: string; reason: string }>;
  webhookDisabledIds: string[];
  failures: string[];
}

/** One model entry in the model registry (v0.5). */
export interface ModelRegistryModel {
  id: string;
  label: string;
}

/** One provider entry in the model registry (v0.5). */
export interface ModelRegistryProvider {
  models: ModelRegistryModel[];
  defaultModel: string;
  fallbackModel: string;
  /** Feature name -> model id (or "providerId:modelId") for that feature. */
  features: Record<string, string>;
}

/** Model registry as returned by models:list (v0.5). */
export interface ModelRegistryView {
  providers: Record<string, ModelRegistryProvider>;
  featureFlags: Record<string, boolean>;
}

/**
 * M1: một detected engine như IPC engines:list trả về (mirror của
 * DetectedEngineSnapshot trong core — chỉ nhãn/trạng thái, không secret).
 */
export interface DetectedEngineView {
  kind: string;
  label: string;
  binary: string;
  binaryPath: string | null;
  version: string | null;
  minVersion: string;
  status: 'available' | 'unavailable' | 'unknown';
  reason?: string;
  reasonDetail?: string;
  account?: { label?: string; method: string };
  authMethod: string;
  detectedAt: string;
  enabled: boolean;
}

/** M1: toàn bộ snapshot detector như IPC engines:list trả về. */
export interface DetectedEnginesView {
  engines: Record<string, DetectedEngineView>;
  detectedAt: string;
}

// ---------------------------------------------------------------------------
// v0.98 (Đội T2): router views — mirror của RoutingDecision / RouterStats /
// RouterTarget / RouterConfig / RouterCliStatus trong core (preload dùng
// thẳng type core; renderer giữ mirror độc lập như các view khác).
// ---------------------------------------------------------------------------

export interface RouterTargetView {
  id: string;
  providerId: string;
  model: string;
  kind: 'local' | 'cli' | 'api';
  costPer1kUsd?: number;
  contextLimit?: number;
  cliBinary?: string;
  cliArgs?: string[];
}

export interface RouterDecisionView {
  target: RouterTargetView;
  layer: string;
  routeId: string | null;
  reason: string;
  latencyMs: number;
  pinned: boolean;
  at: number;
  botId: string;
  threadId?: string;
  defaultTargetId?: string;
  savingsUsd?: number;
  fallbackLadder?: RouterTargetView[];
}

export interface RouterStatsView {
  totalDecisions: number;
  localTurns: number;
  cloudTurns: number;
  cliTurns: number;
  apiTurns: number;
  pinnedTurns: number;
  decisionsByLayer: Record<string, number>;
  decisionsByKind: Record<'local' | 'cli' | 'api', number>;
  decisionsByProvider: Record<string, number>;
  fallbackTurns: number;
  fallbackRate: number;
  avgLatencyMs: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  estimatedSavingsUsd: number;
  unhealthyTargets: number;
}

export interface RouterConfigView {
  enabled: boolean;
  layers: { structural: boolean; semantic: boolean; decision: boolean };
  simpleMax: number;
  complexMin: number;
  minSemanticConfidence: number;
  minSemanticMargin: number;
  minDecisionConfidence: number;
  decisionTimeoutMs: number;
  pinTtlTurns: number;
  pinBreakContextRatio: number;
  maxLogEntries: number;
  ollamaBaseUrl: string;
  decisionModel: string;
  allowLocal: boolean;
  allowCli: boolean;
  allowApi: boolean;
  disabledProviders: string[];
}

export interface RouterCliStatusView {
  providerId: string;
  kind: string;
  label: string;
  status: string;
  reason?: string;
  enabled: boolean;
  offered: boolean;
}

export interface RouterTargetsView {
  targets: RouterTargetView[];
  local: RouterTargetView | null;
  cli: RouterTargetView[];
  api: RouterTargetView[];
  cliStatus: RouterCliStatusView[];
  discoveredAt: number;
}

export interface RouterChangedPayloadView {
  botId: string;
  target: string;
  layer: string;
  route: string | null;
  reason: string;
  latencyMs: number;
  pinned: boolean;
  at: number;
}

/**
 * M7: một connected app + trạng thái auth (IPC 'apps:list' /
 * 'apps:disconnect'). Mirror của core AppStatusView — không chứa
 * token, chỉ trạng thái + nhãn tài khoản.
 */
export interface ConnectedAppView {
  app: {
    id: string;
    label: string;
    description: string;
    icon: string;
    authType: 'oauth2' | 'none' | 'composio' | 'token';
    connectorId?: string;
    /** v0.68b: Vault location of the PAT for token apps (e.g. GitHub 'github'/'token'). */
    vaultNamespace?: string;
    /** v0.68b: Vault key of the PAT for token apps. */
    vaultKey?: string;
    /** v0.57: nguồn app — 'composio' thì UI ghi nhãn "via Composio". */
    source?: 'local' | 'composio';
    /** v0.57: toolkit slug Composio (chỉ khi source='composio'). */
    toolkit?: string;
    tools: Array<{ name: string; description: string; needsApproval: boolean }>;
  };
  authStatus: 'not_connected' | 'connected' | 'expired' | 'error' | 'local';
  accountLabel?: string;
  /** v0.70: chi tiết trạng thái (vd token GitHub không còn hiệu lực + hướng dẫn dán lại, hoặc lý do chưa kiểm tra được do mạng) — không chứa token. */
  authStatusDetail?: string;
  toolCap: number;
  exposedToolCount: number;
  cappedOutToolNames: string[];
}

/**
 * v0.57: trạng thái tích hợp Composio (IPC 'composio:get-state' và các
 * kênh set-enabled / set-app-enabled / set-key / clear-key). Mirror
 * của core ComposioStateView — không chứa key/token, chỉ trạng thái
 * bật/tắt + đã cấu hình key chưa.
 */
export interface ComposioStateView {
  enabled: boolean;
  keyConfigured: boolean;
  /** v0.88b: đã cấu hình Composio user id chưa (chỉ boolean — không lộ giá trị). */
  userIdConfigured: boolean;
  apps: Array<{
    toolkit: string;
    label: string;
    icon: string;
    enabled: boolean;
  }>;
}

/**
 * v0.95 (Team D2): trạng thái media key (IPC 'media:get-status' và
 * các kênh set-key / clear-key). Mirror của core
 * `getMediaKeyStatus` — theo provider id, chỉ {configured, suffix}
 * (suffix = 4 ký tự cuối của key, đủ để phân biệt key); KHÔNG BAO
 * GIỜ chứa key đầy đủ.
 */
export type MediaKeyStatusView = Record<string, { configured: boolean; suffix: string | null }>;

/**
 * v0.89c (Team E): trạng thái connection của một toolkit Composio
 * (IPC 'composio:get-connection-status'). Mirror của core
 * ComposioToolkitConnection — chỉ toolkit + trạng thái + nhãn tài
 * khoản; không chứa user id, link OAuth hay key/token.
 */
export interface ComposioToolkitConnectionView {
  toolkit: string;
  status: 'active' | 'initiated' | 'none';
  accountLabel?: string;
}

/**
 * v0.98 (Team T3): trạng thái một poller Composio nền (IPC
 * 'composio:get-poll-status' / 'composio:set-poll-config' /
 * 'composio:poll-now'). Mirror của core ComposioPollStatus — chỉ
 * metadata vận hành (thời điểm, lỗi, bộ đếm); KHÔNG chứa key/token
 * hay nội dung mail/item.
 */
export interface ComposioPollStatusView {
  name: string;
  toolkit: string;
  toolSlug: string;
  triggerSlug: string;
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  lastPolledAtMs: number;
  lastSuccessAtMs: number;
  lastError: string | null;
  consecutiveFailures: number;
  nextPollAtMs: number;
  totalPolls: number;
  totalNewItems: number;
  seenCount: number;
  queuePending: number;
}

/**
 * v0.53 (P1-6): trạng thái 1Password broker (IPC 'onepassword:status').
 * Mirror của core OnePasswordBrokerStatus — không chứa secret, chỉ
 * trạng thái + nhãn tài khoản.
 * v0.59: thêm `enabled` — cờ bật/tắt broker trong Cài đặt.
 */
export interface OnePasswordBrokerStatusView {
  state: 'unavailable' | 'signed-out' | 'signed-in';
  available: boolean;
  signedIn: boolean;
  enabled: boolean;
  cliVersion?: string;
  accounts: string[];
  reason?: string;
}

/**
 * M4: kết quả đổi model giữa chừng (IPC 'bots:switch-model').
 * `pending` = đang có run chạy, model mới áp dụng từ lượt sau.
 */
export interface SwitchModelView {
  bot: BotConfigLike;
  providerId: string;
  model: string;
  applied: boolean;
  pending: boolean;
  running: boolean;
}

/** M4: một provider trên rail (mirror của RailEntry trong core). */
export interface ProviderRailEntryView {
  providerId: string;
  label: string;
  group: 'subscription' | 'api' | 'custom';
  status: 'usable' | 'unknown' | 'disabled' | 'unavailable';
  selectable: boolean;
  reason?: string;
  reasonDetail?: string;
  accountLabel?: string;
  accountMethod?: string;
  detectedKind?: string;
  binary?: string;
  version?: string | null;
  minVersion?: string;
  enabled?: boolean;
  sourceKind: 'account' | 'api-key' | 'local' | 'custom';
  models: string[];
  defaultModel: string;
}

/** M4: toàn bộ provider rail (IPC 'models:rail'). */
export interface ProviderRailView {
  groups: Record<'subscription' | 'api' | 'custom', ProviderRailEntryView[]>;
  entries: ProviderRailEntryView[];
}

/** Local API status (v0.5). */
export interface ApiStatusView {
  enabled: boolean;
  port: number;
  tokenSet: boolean;
  /**
   * v0.90d: true khi server đang lắng nghe. Optional để tương thích
   * với main cũ chưa trả field này (undefined = không rõ).
   */
  running?: boolean;
  /**
   * v0.90d: lỗi khởi động Local API gần nhất (null = đang chạy tốt
   * hoặc chưa từng thử). Settings hiện nó khi API đang bật nhưng
   * server chưa chạy được (vd port bận sau 5 lần thử lại).
   */
  lastError?: string | null;
}

/** One webhook subscription (v0.5). */
export interface WebhookView {
  id: string;
  url: string;
  events: string[];
}

/** One installed plugin as returned by plugins:list (v0.8). */
export interface PluginView {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string | null;
  enabled: boolean;
  /** Names of the tools this plugin contributes (after manifest filtering). */
  tools: string[];
}

/** One built-in hook as returned by hooks:list (v0.29, P0-2). */
export interface HookView {
  name: string;
  description: string;
  /** Lifecycle events this hook runs for (subset of its registered events). */
  events: string[];
  source: string;
  enabled: boolean;
}

/**
 * One service account (v0.5). `token` is only present in the create
 * response and is shown to the user exactly once, never stored.
 */
export interface ServiceAccountView {
  id: string;
  name: string;
  scope: string;
  createdAt: string;
  token?: string;
}

/**
 * Máy tính riêng cho từng bot (sóng B, đội platform) — mirror của core
 * (packages/core/src/compute/types.ts). IPC chỉ trả JSON thuần, không
 * chứa secret.
 */
export interface MachineProfileView {
  os: string;
  osVersion: string;
  arch: string;
  hostname: string;
  cpu: {
    model: string;
    logicalCores: number;
    physicalCores: number | null;
    speedMhz: number | null;
    loadAvg1m: number | null;
    loadPerCore: number | null;
  };
  memory: { totalBytes: number; freeBytes: number; freeRatio: number };
  disks: Array<{ mount: string; totalBytes: number; freeBytes: number; freeRatio: number }>;
  virtualization: { supported: boolean; detail: string };
  gpus: Array<{ model: string }>;
  warnings: string[];
}

export interface ComputerBackendView {
  kind: string;
  level: string;
  available: boolean;
  detail: string;
}

export interface ComputersProbeView {
  profile: MachineProfileView;
  backends: ComputerBackendView[];
  busy: boolean;
  busyReason?: string;
}

export interface ComputerAllocationView {
  botId: string;
  level: string;
  downgradedFrom?: string;
  cpuCores: number;
  ramBytes: number;
  diskBytes: number;
  backend: string;
  backendDetail: string;
  priority: number;
}

export interface ComputerPlanView {
  allocations: ComputerAllocationView[];
  rejected: Array<{ botId: string; reason: string; reasonDetail?: string }>;
  hostHeadroom: { cpuCores: number; ramBytes: number; diskBytes: number };
  busy: boolean;
  busyReason?: string;
  warnings: string[];
}

export interface BotComputerView {
  id: string;
  botId: string;
  level: string;
  backend: string;
  backendDetail: string;
  cpuCores: number;
  ramBytes: number;
  diskBytes: number;
  priority: number;
  state: string;
  workspaceDir: string;
  imagePath?: string;
  /** Mạng của VM (v0.78, M2): 'none' (mặc định, không NIC) hoặc 'nat'. */
  vmNetwork?: 'none' | 'nat';
  diskUsedBytes?: number | null;
  lastError?: string;
  /** v0.90c (đội G gói C): lý do lần tạm dừng gần nhất (vd auto-shed). */
  lastPauseReason?: string;
}

export interface GuestAgentHealthView {
  status: 'ok' | 'missing' | 'unhealthy' | 'unknown';
  version?: string;
  uptimeSeconds?: number;
  hint?: string;
}

export interface ComputerQueueEntryView {
  botId: string;
  request: { botId: string; level?: string; cpuCores?: number; ramBytes?: number; diskBytes?: number; priority?: number };
  priority: number;
  enqueuedAt: string;
  reason?: string;
}

/** v0.90c (đội G gói C): state scheduler — hàng đợi + cờ auto-shed. */
export interface ComputerQueueView {
  queue: ComputerQueueEntryView[];
  autoShed: boolean;
}

export interface ComputerStatusView {
  computer: BotComputerView;
  effectiveLevel: string;
  levelWarning?: string;
  /** v0.78 (M2): cảnh báo khi VM dùng NAT (egress không enforce được). */
  vmNetworkWarning?: string;
  /** v0.78 (M3): true khi guest agent trong VM đang kết nối. */
  guestAgentConnected?: boolean;
  /** v0.90c (đội G gói C): sức khoẻ guest (ping/info định kỳ, chỉ mức VM). */
  guestAgentHealth?: GuestAgentHealthView;
  /** v0.78 (M1): RAM vật lý enforce bằng cgroup hay chỉ prlimit. */
  memoryEnforcement?: 'cgroup-v2' | 'prlimit-only';
  memoryEnforcementReason?: string;
  memoryUsageBytes?: number | null;
}

// Đội D (fleet): mirror của core FleetWorkspace / FleetStatusView /
// FleetUsageSummary / FleetCapacityCheck / FleetDecision (xem
// packages/core/src/fleet/types.ts). Renderer chỉ dùng để hiển thị.
export type FleetRoleView = 'admin' | 'member' | 'chat-only';

export interface FleetMemberView {
  userId: string;
  role: FleetRoleView;
  addedBy: string;
  addedAt: string;
}

export interface FleetWorkspaceView {
  id: string;
  name: string;
  osUser: string;
  serviceName: string;
  port: number;
  rootDir: string;
  cpuCores: number;
  ramBytes: number;
  diskBytes: number;
  members: FleetMemberView[];
  status: 'active' | 'suspended';
  serviceState: 'stopped' | 'starting' | 'running' | 'error';
  pid?: number;
  isolationLevel: 'directory' | 'os-user';
  isolationReason?: string;
  lastError?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface FleetStatusView {
  workspace: FleetWorkspaceView;
  service: {
    state: 'stopped' | 'starting' | 'running' | 'error';
    pid?: number;
    uptimeMs: number | null;
    lastHealthAt: number | null;
    lastError?: string;
  };
  usage: FleetUsageSummaryView | null;
}

export interface FleetUsageSummaryView {
  workspaceId: string;
  samples: number;
  windowStart: number;
  windowEnd: number;
  cpuSecondsMax: number | null;
  rssBytesLatest: number | null;
  diskBytesLatest: number | null;
}

export interface FleetCapacityCheckView {
  ok: boolean;
  reason?: 'not-enough-cpu' | 'not-enough-ram' | 'not-enough-disk' | 'too-many-workspaces';
  reasonDetail?: string;
  headroom: { cpuCores: number; ramBytes: number; diskBytes: number };
  allocated: { cpuCores: number; ramBytes: number; diskBytes: number };
  requested: { cpuCores: number; ramBytes: number; diskBytes: number };
  busy: boolean;
  busyReason?: string;
}

export interface FleetDecisionView {
  id: string;
  seq: number;
  at: number;
  actor: string;
  action: string;
  target: string;
  decision: 'allow' | 'deny';
  reason?: string;
  detail?: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

/**
 * One span inside a run trace (v0.10), as the renderer sees it (same
 * shape as core TraceSpan). `inputSummary` / `outputSummary` are
 * sanitised excerpts — never raw payloads, never secrets.
 */
export interface TraceSpanView {
  id: string;
  traceId: string;
  runId: string;
  botId: string;
  kind: 'llm' | 'tool' | 'handoff' | 'guardrail' | 'approval' | 'error';
  name: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  status: 'ok' | 'error' | 'pending' | 'blocked';
  inputSummary?: string;
  outputSummary?: string;
  error?: string;
  parentSpanId?: string;
  attributes?: Record<string, string | number | boolean>;
}

/** One run trace as listed by traces:list (v0.10) — no spans, just the summary. */
export interface TraceSummaryView {
  traceId: string;
  runId: string;
  botId: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  status: 'ok' | 'error' | 'running';
  spanCount: number;
  kinds: TraceSpanView['kind'][];
  /** v0.33 (P0-6): token totals; optional — traces written before v0.33 lack them. */
  totalInputTokens?: number;
  /** v0.33 (P0-6): token totals; optional — traces written before v0.33 lack them. */
  totalOutputTokens?: number;
}

/** One run trace with its spans, as returned by traces:get (v0.10). */
export interface TraceDetailView {
  traceId: string;
  runId: string;
  botId: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  status: 'ok' | 'error' | 'running';
  spans: TraceSpanView[];
  /** v0.33 (P0-6): token totals; optional — traces written before v0.33 lack them. */
  totalInputTokens?: number;
  /** v0.33 (P0-6): token totals; optional — traces written before v0.33 lack them. */
  totalOutputTokens?: number;
}

/**
 * v0.95d4 (Đội D4): user profile + long-term memory (local-first).
 * Mirror của `LocalProfile` (core, đã mở rộng) và
 * `LongTermMemoryEntry` KHÔNG kèm vector embedding (main đã strip).
 */
export interface UserProfileView {
  userId: string;
  displayName: string;
  createdAt: number;
  addressForm?: string;
  interests?: string[];
  habits?: string[];
  facts?: string[];
  updatedAt?: number;
}

export interface UserProfilePatch {
  displayName?: string;
  addressForm?: string;
  interests?: string[];
  habits?: string[];
  facts?: string[];
}

export interface MemoryEntryView {
  id: string;
  key: string;
  value: string;
  tags: string[];
  confidence: number;
  botId: string;
  userId?: string;
  createdAt: string;
  updatedAt: string;
}

/** v0.96 (Đội T1): memory block như renderer thấy (kèm bot đang attach). */
export interface MemoryBlockView {
  id: string;
  label: string;
  description: string;
  content: string;
  charLimit: number;
  readOnly: boolean;
  createdByBotId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** BotId đang attach block này (share = nhiều bot cùng thấy 1 block). */
  attachedBots: string[];
}

/** v0.96: kết quả export MemFS (1 file Markdown / block). */
export interface MemoryBlocksExportView {
  dir: string;
  files: string[];
  factCount: number;
  exportedAt: string;
}

/** v0.96: kết quả import MemFS (merge, không ghi đè bừa). */
export interface MemoryBlocksImportView {
  dir: string;
  blocks: { imported: number; updated: number; skipped: number; conflicts: Array<{ label: string; reason: string }> };
  facts: { imported: number; updated: number; skipped: number };
}

/** v0.96: kết quả chạy consolidation (dedupe/conflict/promote/archive). */
export interface MemoryConsolidateView {
  action: string;
  enabled?: boolean;
  idleMinutes?: number;
  lastActivityAt?: string;
  lastRunAt?: string;
  ranAt?: string;
  examined?: number;
  deduped?: number;
  conflictsResolved?: number;
  promoted?: number;
  promotedSkipped?: number;
  archived?: number;
  archivedFile?: string;
  details?: string[];
}

/** v0.97 (Team T4): memory v2 — graph entity/relation views for the UI. */
export interface MemoryV2EntityView {
  id: string;
  name: string;
  type: string;
  description: string;
  aliases: string[];
  validFrom: string | null;
  validTo: string | null;
  recordedAt: string;
  updatedAt: string;
  trust: number;
  quarantined: boolean;
}

export interface MemoryV2RelationView {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  label: string;
  detail: string;
  validFrom: string | null;
  validTo: string | null;
  recordedAt: string;
  trust: number;
  quarantined: boolean;
}

export interface MemoryV2GraphView {
  stats: { entities: number; relations: number; quarantinedEntities: number; quarantinedRelations: number; types: Record<string, number>; labels: Record<string, number> };
  entities: MemoryV2EntityView[];
  relations: MemoryV2RelationView[];
}

export interface MemoryV2SearchHitView {
  id: string;
  kind: string;
  text: string;
  score: number;
  explanation: string;
}

export interface MemoryV2SearchView {
  query: string;
  semanticAvailable: boolean;
  hits: MemoryV2SearchHitView[];
}

export interface MemoryV2SleepReportView {
  ranAt: string;
  trigger: string;
  episodesExamined: number;
  factsExtracted: number;
  factsStored: number;
  factsFlagged: number;
  factsSkippedQuota: number;
  contradictionsFound: number;
  graphEntitiesAdded: number;
  graphRelationsAdded: number;
  quotaBlocked: boolean;
  details: string[];
}

export interface MemoryV2SleepView {
  action: string;
  config?: { enabled: boolean; stepsThreshold: number; runOnCompact: boolean; promoteToBlocks: boolean; buildGraph: boolean; minConfidence: number };
  stepsSinceLastRun?: number;
  running?: boolean;
  lastReport?: MemoryV2SleepReportView | null;
  report?: MemoryV2SleepReportView;
}

export interface MemoryV2ProvenanceView {
  quota: { maxItems: number; maxChars: number; maxCharsPerItem: number; maxGraphEntities: number; maxGraphRelations: number };
  usage: { items: number; chars: number; graphEntities: number; graphRelations: number };
  quotaOk: boolean;
  graph: { entities: number; relations: number; quarantinedEntities: number; quarantinedRelations: number };
}
/** v0.98 (Đội T1): temporal knowledge graph như renderer thấy — mirror
 *  của preload GraphFactView (KHÔNG kèm vector embedding). */
export interface GraphFactView {
  id: string;
  subjectId: string;
  predicate: string;
  objectId?: string;
  objectText?: string;
  validFrom: string;
  validUntil: string | null;
  supersedes?: string;
  supersededBy?: string;
  confidence: number;
  status: 'active' | 'superseded' | 'deleted' | 'quarantined';
  scope: { userId: string; botId: string; runId: string };
  provenance: { episodeId: string; turnId: string; runId: string; botId: string; userId: string; at: string; sourceText: string };
  createdAt: string;
  updatedAt: string;
  subjectName: string;
  objectName?: string;
  displayText: string;
}

export interface GraphEntityView {
  id: string;
  name: string;
  kind: string;
  aliases: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  factCount: number;
}

export interface GraphSearchHitView extends GraphFactView {
  score: number;
  sources: Array<'semantic' | 'keyword' | 'graph'>;
}

export interface GraphSearchView {
  query: string;
  sourcesUsed: Array<'semantic' | 'keyword' | 'graph'>;
  notes: string[];
  hits: GraphSearchHitView[];
}

export interface GraphStatsView {
  entities: number;
  facts: number;
  activeFacts: number;
  episodes: number;
  unprocessedEpisodes: number;
  pendingQuarantine: number;
}

export interface GraphQuarantineView {
  id: string;
  candidate: { subjectName: string; predicate: string; objectText: string; confidence: number };
  reason: string;
  detail: string;
  conflictingFactId?: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewedBy?: string;
  reviewedAt?: string;
  createdAt: string;
}

export interface GraphShareView {
  targetBotId: string;
  readOnly: boolean;
  sharedAt: string;
  sharedBy: string;
}

export interface GraphSleepConfigView {
  enabled: boolean;
  afterTurns: number;
  maxSteps: number;
  batchSize: number;
  cooldownMs: number;
  promoteMinConfidence: number;
  turnsSinceLastRun: number;
  lastRunAtMs: number;
}

export interface GraphSleepRunView {
  at: string;
  trigger: string;
  botId: string;
  episodesExamined: number;
  added: number;
  updated: number;
  deleted: number;
  quarantined: number;
  skipped: number;
  promoted: number;
  stepsUsed: number;
  hasMore: boolean;
  extractor: string;
  error?: string;
  details: string[];
}
