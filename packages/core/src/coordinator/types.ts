/**
 * node-agent-coordinator — shared types for the out-of-process coordinator.
 *
 * Wire protocol (NDJSON-RPC over stdio, one JSON object per line):
 *   Request:      {"id": string, "method": string, "params": object}
 *   Response:     {"id": string, "result": any}
 *                 | {"id": string, "error": {"message": string, "code"?: string}}
 *   Notification: {"event": string, "data": any}   (no id)
 *
 * Agent events are forwarded as notifications:
 *   {"event": "agent.event", "data": {"botId": string, "kind": AgentEventKind, "payload": any}}
 *
 * Security note: a provider API key travels inside `createBot` params over
 * stdio. That is only safe because the coordinator child runs on the same
 * machine, spawned by the parent, with no network listener. The coordinator
 * never logs params (or any value that could hold a key).
 */

import type { BotConfig, ProviderConfig, ToolCall, ToolResult, VisionAttachment } from '../types';
import type { AgentMode, PlanApprovalStatus, PlanReviewDecision } from '../agent/coordination';
import type { CheckpointSummary } from '../agent/checkpoints';
import type { InterruptDecision, InterruptReason } from '../agent/interrupt';
import type { McpOAuthClientConfig } from '../mcp/oauth';
import type { TokenSet } from '../connectors/framework';
import type { StructuredOutputOptions } from '../agent/structured';
import type { AgentsMdResult } from '../project/agentsMd';
import type { ProjectDigest } from '../project/updates';
import type { AutoApproveRule, AutoApproveRuleInput } from '../approval/index';
import type { RiskRule } from '../risk/types';
import type { GroupBotInterruptedEntry, GroupBotStatusEntry, GroupChat, GroupMessage } from '../groupchat/index';
import type {
  Channel,
  ChannelKind,
  ChannelMessage,
  ChannelResponderRules,
} from '../channels/index';
import type { ComposioToolkitConnection } from '../composio/types';
import type { ThreadItem, ThreadSearchHit } from '../agent/memory';

export type { ThreadItem, ThreadSearchHit };
import type { HarnessEventKind } from '../harness/types';
import type {
  AcceptedHandoffConfirmation,
  SessionHandoffBlocker,
  SessionHandoffDecision,
  SessionHandoffRecord,
  SessionHandoffSummary,
  SessionHandoffWorkStatus,
} from '../handoff/index';
import type { RouterConfig, RouterStats, RouterTarget, RoutingDecision } from '../router/index';
import type { Plan, PlanRunEvent, ReplanProposal } from '../planning/index';

export type { McpOAuthClientConfig };
export type { TokenSet };
export type { AppStatusView } from '../apps/index';

/** OAuth client credentials for one integration connector (v0.9d). */
export interface ConnectorClientConfig {
  /** OAuth client id (public, from the provider's app console). */
  clientId: string;
  /** OAuth client secret, when the provider requires one. Never logged. */
  clientSecret?: string;
}

/** Event kinds the coordinator forwards from AgentRunner. Mirrors AgentEvents. */
export type AgentEventKind =
  | 'delta'
  | 'toolcall'
  | 'toolresult'
  | 'approval-needed'
  | 'ask-user'
  /**
   * v0.54 (P1-8): run dừng ở điểm interrupt để hỏi user (HITL). Payload:
   * InterruptRequest + `requestId` — renderer hiện InterruptCard và trả
   * lời qua RPC `respondInterrupt`. Không trả lời trong 10 phút thì run
   * tiếp tục như user chọn "cancel" (dừng an toàn, checkpoint đã lưu).
   */
  | 'interrupt-needed'
  | 'progress'
  | 'summary'
  /**
   * v1.01 (Đội T3, risk budget): run đổi trạng thái (vd
   * `waiting-for-confirmation`). Payload: { runId: string; state:
   * RunState } — renderer hiện "đang chờ duyệt".
   */
  | 'run-state'
  /**
   * v1.01 (Đội T3): budget conversation vượt ngưỡng cảnh báo / vượt
   * cap. Payload: { runId: string; kind: 'warning' | 'exceeded';
   * basis: 'tokens' | 'cost' | 'both'; snapshot: BudgetSnapshot }.
   * Chỉ cảnh báo — run không bị chặn.
   */
  | 'budget-alert'
  /** A bot created from inside the coordinator (create_agent tool). Main persists it. */
  | 'agent.created'
  /**
   * v0.7: an MCP OAuth token was stored (mcp_auth tool). Main persists it
   * to Vault namespace 'mcp-oauth'. Payload: { server: string; value: string }.
   */
  | 'mcp.oauth-token'
  /**
   * v0.7: the mcp_auth tool asks main to open an authorization URL in the
   * user's browser (the child has no browser). Payload: { url: string }.
   */
  | 'mcp.open-url'
  /**
   * v0.9d: a connector TokenSet was refreshed in the child
   * (Slack / Gmail / Teams auto-refresh). Main persists it to Vault
   * namespace 'connector'. Payload: { connectorId: string; value: string }
   * where value is the full TokenSet JSON (access + refresh + expiry).
   * Never logged — same pattern as 'mcp.oauth-token'.
   */
  | 'connector.oauth-token'
  /**
   * v0.13: an MCP server asks the user a question (`elicitation/create`).
   * Main shows ElicitationModal in the renderer and answers through the
   * `respondElicitation` RPC. Payload: { elicitationId: string;
   * serverName: string; message: string; mode: 'form' | 'url';
   * url?: string; fields?: ElicitationFormField[] }.
   */
  | 'mcp.elicitation-needed'
  /**
   * v0.50 (M8): a CLI engine (Codex/ACP) asks for permission through
   * the harness broker. Main shows the permission card in the renderer
   * and answers through the `harnessDecidePermission` RPC (broker
   * timeout 120s → deny). Payload: { requestId: string; botId: string;
   * engine: string; method: string; detail?: string; allowable: boolean }.
   */
  | 'harness.permission-needed'
  /**
   * v0.90a (Đội G): một event harness đã sanitize (loop turn/tool-call
   * hoặc CLI driver) — coordinator con forward từ bus lên main, main
   * forward tiếp về renderer (kênh `harness:event`, live-tail
   * EventLogView) và SSE Local API. Payload: envelope HarnessEvent
   * đầy đủ (instanceId, botId, threadId, engine, kind, payload, at).
   */
  | 'harness.event'
  /**
   * v0.97 (Team T3): một event AG-UI đã validate (run lifecycle /
   * text streaming / tool call / state / generative UI) — coordinator
   * con forward từ AgUiEventBus lên main, main forward tiếp về
   * renderer (kênh `agui:event`, live activity feed) và SSE Local
   * API (`GET /v1/agui/events`). Payload: envelope AgUiEvent đầy đủ.
   * Run im lặng không bao giờ tới đây (emitter inactive).
   */
  | 'agui.event'
  /**
   * v0.59: coordinator xin main seed lại Composio API key (vd source
   * vừa bật mà coordinator không đọc được key nào — safeStorage /
   * NO_STORAGE, file reader trả null). Main nghe event này thì gọi
   * `seedComposioKeyToCoordinator()` (đọc Vault bằng safeStorage rồi
   * seed qua RPC `composio.setApiKey`). Payload không chứa key:
   * `{ reason: 'composio_key_missing' }`.
   */
  | 'composio.key-needed'
  /**
   * v0.98 (Team T4 — planning v2): a run-bound plan changed — step
   * started/done/failed, stuck detected, replan proposed/applied.
   * Payload: `PlanRunEvent` (full plan snapshot, so the UI renders
   * live state from events alone, no polling). Main forwards it to
   * the renderer on channel `plan:event`.
   */
  | 'plan.event'
  /**
   * v0.95 (Team D1): một watched page đổi nội dung (tool
   * `watch_check` / UI "Kiểm tra ngay"). Payload:
   * `{ url: string; summary: string; checkedAt: number }`.
   * Main forward về renderer (`internet:watch-changed`) và bắn OS
   * notification kind `watch-change`.
   */
  | 'internet.watch-changed';

/** One forwarded agent event, always scoped to a bot. */
export interface AgentEvent {
  botId: string;
  kind: AgentEventKind;
  /** delta: string | toolcall: ToolCall | toolresult: ToolResult | ... */
  payload: unknown;
}

/** Notification envelope for agent events. */
export interface AgentEventNotification {
  event: 'agent.event';
  data: AgentEvent;
}

export type CoordinatorMethod =
  | 'createBot'
  | 'run'
  | 'stopBot'
  | 'listBots'
  | 'destroyBot'
  | 'deleteBotData'
  | 'ping'
  | 'shutdown'
  | 'respondApproval'
  | 'respondAskUser'
  | 'respondElicitation'
  | 'reviewPlan'
  | 'plan.create'
  | 'plan.list'
  | 'plan.get'
  | 'plan.delete'
  | 'plan.decideReplan'
  | 'plan.resume'
  | 'plan.templates'
  | 'switchModel'
  | 'setPluginEnabled'
  | 'supervise'
  | 'saveMessage'
  | 'getHistory'
  | 'listTasks'
  | 'listThreads'
  | 'createThread'
  | 'renameThread'
  | 'deleteThread'
  | 'getThreadHistory'
  | 'searchThreads'
  | 'daemonStatus'
  | 'getWorkspaceRules'
  // v0.4: tool-result cache + background-run tool/task + skill reload.
  | 'cache.stats'
  | 'cache.clear'
  | 'runTool'
  | 'createTask'
  | 'reloadSkills'
  // v0.35 (P1-7): quản lý rule auto-approve (xem approval/rules.ts).
  | 'listAutoApproveRules'
  | 'addAutoApproveRule'
  | 'removeAutoApproveRule'
  | 'setAutoApproveRuleEnabled'
  // v0.50 (M8): group chat bot-bot (xem groupchat/groupchat.ts).
  | 'createGroupChat'
  | 'listGroupChats'
  | 'addBotToGroupChat'
  | 'removeBotFromGroupChat'
  | 'deleteGroupChat'
  | 'postGroupMessage'
  | 'listGroupMessages'
  | 'getGroupAttachment'
  | 'getGroupBotStatus'
  | 'dismissGroupBotInterrupted'
  // v0.96 (Team T4): channels — không gian làm việc chung của nhiều bot
  // (xem channels/channels.ts + coordinatorAdapter.ts).
  | 'createChannel'
  | 'listChannels'
  | 'updateChannel'
  | 'deleteChannel'
  | 'addBotToChannel'
  | 'removeBotFromChannel'
  | 'moveBotBetweenChannels'
  | 'postChannelMessage'
  | 'listChannelMessages'
  // v0.94c: project updates delivery (xem project/updates.ts).
  | 'projectUpdatesDue'
  | 'projectUpdatesMarkSent'
  // v0.37 (P1-3): handoff phiên làm việc — liệt kê/đọc/tạo/nhận record.
  | 'listHandoffs'
  | 'getHandoff'
  | 'createHandoffRecord'
  | 'acceptHandoff'
  // M5 (v0.47): harness local — trạng thái registry, log thread, quyết permission.
  | 'harnessStatus'
  | 'harnessThreadLog'
  | 'harnessDecidePermission'
  // v0.54 (P1-8): checkpoint/resume + interrupt HITL + time-travel replay.
  | 'interruptRun'
  | 'respondInterrupt'
  | 'listRunCheckpoints'
  | 'listBotCheckpoints'
  | 'replayRun'
  // v0.58: Composio execution path — bật/tắt source + toolkit trong
  // tiến trình coordinator (main gọi đúng 2 method này, xem client.ts).
  | 'composio.setState'
  | 'composio.getState'
  // v0.59: seed key Composio cho coordinator (main đọc Vault bằng
  // safeStorage rồi seed bản sao trong bộ nhớ — xem
  // `composio.setApiKey` / `composio.getKeyStatus` trong client.ts).
  | 'composio.setApiKey'
  | 'composio.getKeyStatus'
  // v0.88b: user id Composio cho session (main đọc Vault rồi seed
  // bản sao trong bộ nhớ — xem `composio.setUserId` /
  // `composio.getUserIdStatus` trong client.ts). Không chứa user id.
  | 'composio.setUserId'
  | 'composio.getUserIdStatus'
  // v0.59 (UI-3): duyệt tool theo bot — liệt kê + bật/tắt từng tool
  // (xem coordinator.ts `listBotTools` / `setBotToolEnabled`).
  | 'listBotTools'
  | 'setBotToolEnabled'
  // v0.64 (skills per-bot): duyệt skill theo bot — liệt kê + bật/tắt
  // từng skill (xem coordinator.ts `listBotSkills` /
  // `setBotSkillEnabled`). Cùng cơ chế deny như tool (deny thắng).
  | 'listBotSkills'
  | 'setBotSkillEnabled'
  // v0.60 (UI-6): liệt kê lệnh slash của bot cho popup autocomplete
  // (xem coordinator.ts `listSlashCommands`).
  | 'listSlashCommands';

export interface CoordinatorRequest {
  id: string;
  method: CoordinatorMethod | string;
  params: Record<string, unknown>;
}

export type CoordinatorResponse =
  | { id: string; result: unknown }
  | { id: string; error: { message: string; code?: string } };

export interface CoordinatorNotification {
  event: string;
  data: unknown;
}

/** One scripted reply for the test-only `mock` provider. */
export interface MockProviderResponse {
  text?: string;
  toolCalls?: ToolCall[];
  /** Artificial delay before answering, ms. Used to test stopBot. */
  delayMs?: number;
  /** Fake token usage (v0.4: lets tests exercise MeteredProvider). */
  usage?: { inputTokens?: number; outputTokens?: number };
}

/**
 * Provider config for createBot. `mock` is a test-only provider id: the
 * coordinator answers from `mockResponses` (in order, last one repeats)
 * instead of calling any network. Never used by the desktop app.
 */
export interface CreateBotProviderConfig extends ProviderConfig {
  mockResponses?: MockProviderResponse[];
  /**
   * v0.25 (W18a): test-only — đường dẫn file JSONL cho mock provider
   * ghi lại mọi `ChatCompletionRequest` (một dòng JSON mỗi lần `chat()`).
   * Dùng để test qua `CoordinatorClient` (tiến trình con) quan sát được
   * input provider nhận; không truyền thì mock chạy như cũ, không ghi.
   * Không dùng production (desktop app không dùng provider `mock`).
   */
  mockRecordPath?: string;
  /**
   * v0.94c (test-only): mock provider tự nhận có vision — loop cho
   * lượt có ảnh đi qua như provider vision thật (để test kiểm chứng
   * ảnh tới được provider qua `mockRecordPath`). Không dùng production
   * (desktop app không dùng provider `mock`).
   */
  mockSupportsVision?: boolean;
}

export interface CreateBotParams {
  /** Full bot config. `workspaceDir` may be omitted when `workspaceDir` is given. */
  bot: BotConfig;
  provider: CreateBotProviderConfig;
  /** Workspace dir for this bot's BotMemory. Defaults to bot.workspaceDir. */
  workspaceDir?: string;
  /** Max provider round-trips per turn. Default 20 (same as desktop main). */
  maxSteps?: number;
  /**
   * Dir with plugin folders (`<userData>/plugins`). When set, the child
   * loads enabled plugin tools itself (via a dynamic require of
   * @open-bot/tools, same pattern as the tool factory) and adds them to
   * the bot's registry. Tools are functions, so they cannot cross the
   * RPC boundary — the child must load them, not the parent.
   */
  pluginsDir?: string;
  /**
   * v0.14: load plugins out-of-process (sandboxed, default true) or
   * in-process (false — legacy; a hanging/crashing plugin can take down
   * the coordinator child). Sandboxed plugins run in a forked child per
   * plugin (see PluginManager.loadSandboxed).
   */
  pluginsSandbox?: boolean;
  /**
   * Path of the usage store file (`<userData>/usage.json`). When set, the
   * bot's provider is wrapped in a MeteredProvider that enforces spend
   * limits and records token usage (v0.4).
   */
  usageStorePath?: string;
  /**
   * Skill directories for the coordinator-side SkillRegistry
   * (userSkillsDir, pluginsDir, stateDir). When set on the first
   * createBot, the child loads skills and injects matching ones into
   * each run's system prompt (v0.4).
   */
  skillsDirs?: { userSkillsDir?: string; pluginsDir?: string; stateDir?: string };
  /**
   * v0.10: path of the traces file (`<userData>/traces.jsonl`). When
   * set, the child persists one JSONL trace per run there for TraceView.
   */
  tracesFile?: string;
  /**
   * X (Twitter) bearer token for the x_search tool, when the user has
   * one (v0.6). Read by main from Vault and passed here; without it
   * x_search falls back to labelled web search. Never logged.
   */
  xBearer?: string;
  /**
   * v0.7: GitHub personal access token for the git tools (read by main
   * from Vault namespace 'github', key 'token'). Without it the git API
   * tools explain the missing token instead of calling. Never logged.
   */
  githubToken?: string;
  /**
   * v0.7: access tokens for the integration tools (Slack / Gmail /
   * Teams), keyed by connector id. Read by main from Vault namespace
   * 'connector' (stored as a TokenSet JSON — main passes the bare
   * access token). Never logged. Kept for backward compatibility;
   * prefer `connectorTokenSets` below (full TokenSet = auto-refresh).
   */
  connectorTokens?: Record<string, string>;
  /**
   * v0.9d: full TokenSets for the integration tools, keyed by
   * connector id. Read by main from Vault namespace 'connector'
   * (stored as TokenSet JSON: accessToken + refreshToken + expiresAt).
   * The child refreshes them in-memory (ConnectorTokenProvider) and
   * sends refreshed sets back via the 'connector.oauth-token' event
   * for main to persist to Vault. Seed-only: a live refreshed
   * TokenSet already in the child's memory is never overwritten by
   * the older Vault copy main passes on a later createBot (same rule
   * as mcpOAuthTokens). Never logged.
   */
  connectorTokenSets?: Record<string, TokenSet>;
  /**
   * v0.9d: OAuth client credentials per connector, keyed by connector
   * id. Read by main from Vault namespace 'oauth-client' (same
   * scheme as the Google login: key `<id>` = client id,
   * `<id>-secret` = client secret). Without a client id for a
   * connector, that connector runs on its static token with no
   * auto-refresh. Never logged.
   */
  connectorClientConfigs?: Record<string, ConnectorClientConfig>;
  /**
   * v0.7: stored MCP OAuth tokens (serialized McpOAuthToken JSON),
   * keyed by server name. Read by main from Vault namespace
   * 'mcp-oauth' and used to seed the coordinator's in-memory store;
   * keys already present in memory (newer, from a live mcp_auth)
   * are NOT overwritten. New tokens are sent back via the
   * 'mcp.oauth-token' event for main to persist. Never logged.
   */
  mcpOAuthTokens?: Record<string, string>;
  /**
   * v0.7: OAuth client configs for MCP servers, keyed by server name.
   * Read by main from `<userData>/mcp-oauth.json` (client secret, when
   * needed, from Vault namespace 'mcp-oauth-client'). Never logged.
   */
  mcpOAuthConfigs?: Record<string, McpOAuthClientConfig>;
  /**
   * v0.59: Composio API key seed cho coordinator (main đọc từ Vault
   * bằng safeStorage trong main process rồi truyền bản sao trong bộ
   * nhớ — đúng mẫu `xBearer` / `githubToken` / `mcpOAuthTokens`).
   * Ghi đè key đã seed trước đó (xoay key không cần destroyBot);
   * vắng = giữ nguyên key đã seed (fallback file Vault vẫn dùng
   * được khi không seed). Không bao giờ log.
   */
  composioApiKey?: string;
  /**
   * v0.88b: Composio user id seed cho coordinator (main đọc từ Vault
   * bằng safeStorage trong main process rồi truyền bản sao trong bộ
   * nhớ — đúng mẫu `composioApiKey`). Ghi đè user id đã seed trước
   * đó (đổi id → session cũ bị huỷ, lần gọi sau tạo session mới đúng
   * id); vắng = giữ nguyên user id đã seed (mặc định 'local-user'
   * khi chưa cấu hình gì). Không bao giờ log.
   */
  composioUserId?: string;
  /**
   * v0.95 (Team D1): Brave Search API key seed cho tool
   * `internet_search` nguồn `brave` (main đọc từ Vault namespace
   * 'search', key 'brave-api-key' rồi truyền bản sao trong bộ nhớ —
   * đúng mẫu `composioApiKey`). Opt-in: vắng = nguồn brave từ chối
   * với hướng dẫn thêm key, các nguồn miễn phí vẫn chạy. Không log.
   */
  braveSearchApiKey?: string;
  /**
   * v0.95 (Team D2): media (image/video) API keys seed cho coordinator
   * (main đọc từ Vault namespace 'media' bằng safeStorage rồi truyền
   * bản sao trong bộ nhớ — đúng mẫu `composioApiKey`). Key theo
   * provider id (`{openai: 'sk-...', gemini: '...'}`); key mới ghi đè
   * key đã seed; vắng = giữ nguyên key đã seed.
   */
  mediaApiKeys?: Record<string, string>;
  /**
   * v0.7: names of system MCP tools mcp_system_exec may run. Default:
   * none allowed (the tool refuses everything until the host allows
   * names). Read by main from `<userData>/mcp-oauth.json`
   * (`allowedSystemTools`).
   */
  allowedSystemTools?: string[];
}

export interface BotHandle {
  botId: string;
}

export interface CreateBotResult extends BotHandle {
  /** Number of tools registered for this bot (full registry). */
  toolCount: number;
  /** Tool names, in registration order. */
  toolNames: string[];
}

export interface RunParams {
  botId: string;
  text: string;
  /**
   * Background run (automation/dream, v0.4): informational events
   * (delta, toolcall, toolresult, progress, summary) are NOT forwarded
   * to the parent; approval/ask-user still are (they need the user).
   */
  silent?: boolean;
  /**
   * v0.9a: caller-supplied run id. When omitted the coordinator generates
   * one; the id is echoed in RunResult so a client can stop exactly this
   * run (RPC `stopRun`, WS `{type:"stop"}`).
   */
  runId?: string;
  /**
   * v0.12: resume run từ checkpoint — id của run cũ đã lưu checkpoint.
   * Khi set, coordinator tải checkpoint mới nhất (hoặc `resumeStep`) và
   * chạy tiếp từ đó thay vì bắt đầu lượt mới; `text` được bỏ qua vì
   * messages trong checkpoint đã chứa yêu cầu gốc.
   */
  resumeRunId?: string;
  /** Step bắt đầu khi resume — số step hoặc 'latest'. Mặc định 'latest'. */
  resumeStep?: number | 'latest';
  /**
   * v0.34 (P1-6): thư mục làm việc hiện tại của run — chuỗi AGENTS.md
   * được load từ gốc workspace xuống tới đây (mặc định là workspaceDir
   * của bot). Nằm ngoài workspaceDir thì chỉ dùng workspaceDir.
   */
  cwd?: string;
  /**
   * v0.12: kết quả cuối của run phải theo JSON Schema (validate + thử
   * lại tối đa `maxRetries` lần). Xem `agent/structured.ts`.
   */
  structuredOutput?: StructuredOutputOptions;
  /**
   * v0.37 (P1-3): nhận handoff phiên làm việc — id record trong
   * SessionHandoffStore. Khi set, coordinator nạp record, chèn khối ngữ
   * cảnh bàn giao vào đầu run rồi mới chạy; `text` là yêu cầu tiếp theo
   * của user (không được rỗng). Không dùng chung với `resumeRunId`
   * (resume đã có messages của run cũ). Record có `toBotId` thì chỉ bot
   * đó mới nhận được. Xác nhận nạp trả về trong
   * `RunResult.acceptedHandoff`.
   */
  handoffId?: string;
  /**
   * v0.63 (vision channel): images attached to this turn's user
   * message (base64, see `VisionAttachment` in types.ts). The loop
   * validates them (max 5, 10 MB each, 20 MB total, PNG/JPEG/GIF/
   * WebP) and refuses the turn with a friendly message when the
   * bot's provider/model cannot do vision — the bytes never reach
   * the provider. Travels over the local NDJSON-RPC as JSON; never
   * logged. Renderer/main wiring that fills this field is still open
   * (see the v0.63 wave report) — until then callers pass it
   * directly (tests do).
   */
  attachments?: VisionAttachment[];
  /**
   * v0.98 (Team T4 — planning v2): id of a run-bound plan
   * (see `plan.create`) to attach to this run. When set, the run
   * dispatches the plan's next step at start, feeds every tool call
   * into the plan's stuck detector, and settles the step from the
   * run's outcome — plan state follows the live run, and the UI
   * learns about it through `plan.event` notifications.
   */
  planId?: string;
  /**
   * v0.60: thread cần nạp history làm context cho run này — id thread
   * trong BotMemory của bot (xem `createThread`/`listThreads`). Khi
   * set, `executeRun` đọc các message gần nhất của thread (đã cắt
   * theo cap số message + token, xem `agent/threadHistory.ts`) và
   * chèn giữa system prompt và tin mới: model "nhớ" các lượt cũ của
   * đúng thread này. Thread rỗng thì run chạy y như không có thread.
   * Thread lạ (không tồn tại / không thuộc bot này) thì run lỗi rõ
   * ngay trước khi xếp hàng (fail-closed, như `handoffId`). Không
   * dùng chung với `resumeRunId` — resume đã có messages của run cũ
   * nên `threadId` bị bỏ qua khi cả hai cùng set. Bỏ trống = chạy
   * như cũ, không nạp history (main/desktop truyền thread đang chọn;
   * xem ghi chú ở `executeRun` về việc tin user đã lưu trước run).
   */
  threadId?: string;
}

export interface RunResult {
  botId: string;
  /** Final assistant text of the turn. */
  text: string;
  /** True when stopBot was called while this run was in flight. */
  stopped: boolean;
  /** v0.9a: id of this run (echoed from RunParams or generated). */
  runId?: string;
  /**
   * v0.37 (P1-3): xác nhận run này đã nạp handoff nào (chỉ có khi run
   * với `RunParams.handoffId`) — id, tiêu đề, bot nguồn, số việc đã
   * xong/còn lại, có bị cắt ngắn/khử secret không.
   */
  acceptedHandoff?: AcceptedHandoffConfirmation;
}

export interface StopRunResult {
  runId: string;
  stopped: boolean;
  /** Why the run was not stopped (e.g. no run with this id in flight). */
  reason?: string;
}

export interface StopBotParams {
  botId: string;
}

export interface StopBotResult {
  botId: string;
  stopped: boolean;
  /** Why the run was not stopped (e.g. no run in flight). */
  reason?: string;
}

export interface ListBotsResult {
  botIds: string[];
}

/**
 * v0.59 (UI-3): một tool của bot như màn Tools hiển thị — dữ liệu đã
 * có sẵn trong registry (`entry.tools`) + filter/cap đã có, chỉ đóng
 * gói lại cho renderer. `parameters` chỉ giữ tên/thuộc tính gọn (UI
 * hiện tên + kiểu từng tham số), không dump toàn bộ JSON schema.
 * `enabled` = tool qua được filter của bot (policy denyTools — xem
 * agent/permissions.ts); `cappedByApp` = tool bị cap theo app (M7,
 * apps/toolCap.ts) cắt khỏi lượt gửi cho model dù vẫn bật.
 */
export interface BotToolInfo {
  name: string;
  description: string;
  /** Nhóm theo `toolGroupFor` (agent/toolFilter.ts): file/shell/web/plan/agent/mcp/... */
  group: string;
  /** Nguồn đăng ký: tool lõi, meta-tool Composio, hay tool plugin. */
  source: 'core' | 'composio' | 'plugin';
  /** True khi tool nằm trong READ_ONLY_TOOLS (chỉ-đọc, xem toolFilter.ts). */
  readOnly: boolean;
  /** Tool qua filter của bot (chưa bị tắt trong màn Tools). */
  enabled: boolean;
  /** True khi cap theo app (M7) cắt tool khỏi turn dù tool vẫn bật. */
  cappedByApp: boolean;
  /** Ước lượng token của definition (`estimateToolDefinitionTokens`). */
  tokenEstimate: number;
  /** Tool gốc có cần phê duyệt khi chạy (không tính policy ask/deny). */
  needsApproval: boolean;
  /** Schema gọn: tên tham số → kiểu (+ required). */
  parameters: {
    properties: Record<string, string>;
    required: string[];
  };
}

export interface ListBotToolsParams {
  botId: string;
}

export interface ListBotToolsResult {
  botId: string;
  tools: BotToolInfo[];
  totalTools: number;
  enabledTools: number;
  /** Tổng token ước lượng của tool đang bật (số gửi cho model mỗi turn, trước khi gom nhóm). */
  enabledTokens: number;
  /** Tổng token ước lượng của toàn bộ tool (bật + tắt). */
  totalTokens: number;
}

/**
 * v0.60 (UI-6): RPC `listSlashCommands` — liệt kê lệnh slash của một
 * bot cho popup autocomplete. Chỉ tên + mô tả (không trả
 * promptTemplate/file/run qua IPC — renderer chỉ cần hai trường này).
 */
export interface ListSlashCommandsParams {
  botId: string;
}

/** Một lệnh slash trong danh sách trả về (tên + mô tả từ registry). */
export interface SlashCommandListItem {
  name: string;
  description: string;
}

export type ListSlashCommandsResult = SlashCommandListItem[];

export interface SetBotToolEnabledParams {
  botId: string;
  toolName: string;
  enabled: boolean;
}

export interface SetBotToolEnabledResult {
  botId: string;
  toolName: string;
  enabled: boolean;
  /** Toàn bộ denyTools hiện tại của bot sau khi đổi (để main persist). */
  denyTools: string[];
}

/**
 * v0.64 (skills per-bot): một skill của bot như màn Tools hiển thị —
 * dữ liệu đã có sẵn trong SkillRegistry dùng chung (metadata tier 1)
 * + trạng thái bật/tắt riêng của bot (policy denySkills — xem
 * agent/permissions.ts). `enabled` = skill qua được filter của bot
 * (chưa bị tắt trong màn Tools); `globallyEnabled` = skill đang bật
 * toàn cục trong registry (tắt toàn cục thì skill không match cho bất
 * kỳ bot nào — toggle theo bot khi đó không có tác dụng nên UI khoá
 * nó). `context` = 'fork' khi skill chạy trong subagent riêng (v0.33).
 */
export interface BotSkillInfo {
  name: string;
  description: string;
  /** 'fork' = chạy trong subagent riêng; 'inline' = chạy trong run. */
  context: 'fork' | 'inline';
  /** Tool skill được phép dùng (allowed-tools trong frontmatter). */
  allowedTools: string[];
  /** Skill qua filter của bot (chưa bị tắt trong màn Tools). */
  enabled: boolean;
  /** Skill đang bật toàn cục trong registry (không bị tắt ở Settings). */
  globallyEnabled: boolean;
}

export interface ListBotSkillsParams {
  botId: string;
}

export interface ListBotSkillsResult {
  botId: string;
  skills: BotSkillInfo[];
  totalSkills: number;
  enabledSkills: number;
}

export interface SetBotSkillEnabledParams {
  botId: string;
  skillName: string;
  enabled: boolean;
}

export interface SetBotSkillEnabledResult {
  botId: string;
  skillName: string;
  enabled: boolean;
  /** Toàn bộ denySkills hiện tại của bot sau khi đổi (để main persist). */
  denySkills: string[];
}

export interface DestroyBotParams {
  botId: string;
  /**
   * Fix v0.59 leftover (b): true = this is a REAL bot delete — wipe
   * the bot's BotMemory rows too (threads, messages, tasks, goals,
   * checkpoints, …). False / omitted = tear down the runtime only and
   * KEEP the data (bot edit, provider change, MCP install — all of
   * which destroy + recreate the runtime). Default false on purpose:
   * the wrong default would wipe history on every bot edit.
   */
  deleteData?: boolean;
}

export interface DestroyBotResult {
  botId: string;
  destroyed: boolean;
  /** Per-table rows wiped when `deleteData` was true (absent otherwise). */
  deletedRows?: Record<string, number>;
}

/**
 * Fix v0.59 leftover (b): wipe one bot's BotMemory rows by workspace
 * dir — works even when the bot has NO live runtime entry (e.g. it
 * ran before an app restart and is deleted without running again, so
 * `destroyBot` would throw "chưa tạo bot"). Main's `bots:delete` calls
 * this after `invalidateRuntime` closed the live entry's handle.
 * `workspaceDir` comes from main (already validated there); the
 * coordinator never creates a DB here — a bot with no memory.db file
 * simply reports zero rows.
 */
export interface DeleteBotDataParams {
  botId: string;
  workspaceDir: string;
}

export interface DeleteBotDataResult {
  botId: string;
  deletedRows: Record<string, number>;
}

/**
 * M4 — đổi model của bot giữa chừng (RPC `switchModel`, main chuyển
 * tiếp qua IPC `bots:switch-model`). Không mất thread: provider cũ chỉ
 * bị dispose, BotMemory (transcript SQLite, task, plan, checkpoint),
 * tool list, dấu plan-approved và handoff chain của bot đều giữ nguyên.
 * Provider mới là instance mới — session sống của CLI cũ (vd thread
 * Codex / session ACP) không chuyển sang được, provider mới bắt đầu
 * với lượt chat hiện tại như mọi lượt khác của loop (loop mỗi run chỉ
 * gửi system prompt + tin nhắn hiện tại; xem docs M4 trong
 * providers/cli/README.md). `provider` là ProviderConfig đầy đủ do
 * main dựng qua `providerConfigFor` (đã kiểm tra engine bật + đăng
 * nhập, key trong Vault — không bao giờ log).
 */
export interface SwitchModelParams {
  botId: string;
  provider: CreateBotProviderConfig;
  /** Đường dẫn usage store để bọc MeteredProvider như lúc createBot. */
  usageStorePath?: string;
}

export interface SwitchModelResult {
  botId: string;
  providerId: string;
  model: string;
  /** True khi model mới đã áp dụng ngay (không có run đang chạy). */
  applied: boolean;
  /**
   * True khi có run đang chạy: model mới được ghi lại và áp dụng ở
   * ĐẦU run kế tiếp — run đang chạy vẫn chạy hết bằng model cũ, không
   * bị ngắt, không mất tool call / plan / handoff đang chạy.
   */
  pending: boolean;
  /** True khi lúc gọi đang có run chạy (pending === running). */
  running: boolean;
}

export interface PingResult {
  pong: boolean;
}

export interface ShutdownResult {
  ok: boolean;
}

/** Answer a pending approval request (emitted as `approval-needed`). */
export interface RespondApprovalParams {
  /** Tool call id from the `approval-needed` notification payload. */
  callId: string;
  approved: boolean;
  /**
   * v0.12 (interrupt_before): tham số đã sửa bởi người duyệt — tool sẽ
   * chạy với args này thay cho args gốc (loop re-check denylist trước
   * khi chạy). Trống = giữ nguyên args gốc.
   */
  args?: Record<string, unknown>;
}

export interface RespondApprovalResult {
  /** True when a pending request with this callId existed and was answered. */
  found: boolean;
}

/** Answer a pending ask-user question (emitted as `ask-user`). */
export interface RespondAskUserParams {
  /** Request id from the `ask-user` notification payload. */
  requestId: string;
  answer: string;
}

export interface RespondAskUserResult {
  /** True when a pending question with this requestId existed and was answered. */
  found: boolean;
}

/**
 * v0.54 (P1-8): yêu cầu dừng một run đang chạy ở biên an toàn tiếp theo
 * (RPC `interruptRun`) — HITL cho run dài, mở rộng plan-approval 1 bước.
 * Run dừng lại, checkpoint step cuối đã hoàn thành được lưu, rồi handler
 * interrupt hỏi user (event `interrupt-needed`) và run tiếp tục đúng điểm
 * đó theo quyết định trả về qua `respondInterrupt`.
 */
export interface InterruptRunParams {
  /** Id run đang chạy (echo trong RunResult của `run`). */
  runId: string;
  reason?: InterruptReason;
  /** Câu hỏi hiển thị cho user ở điểm dừng (nếu có). */
  question?: string;
}

export interface InterruptRunResult {
  runId: string;
  /** True khi run đang chạy và đã nhận yêu cầu dừng (dừng ở biên tiếp theo). */
  accepted: boolean;
  /** Vì sao không nhận (vd không có run nào đang chạy với runId này). */
  reason?: string;
}

/** Answer a pending interrupt request (emitted as `interrupt-needed`). */
export interface RespondInterruptParams {
  /** Request id from the `interrupt-needed` notification payload. */
  requestId: string;
  /** Quyết định của user (xem `agent/interrupt.ts`). */
  decision: InterruptDecision;
}

export interface RespondInterruptResult {
  /** True when a pending request with this requestId existed and was answered. */
  found: boolean;
}

/** List checkpoint summaries of one run (RPC `listRunCheckpoints`). */
export interface ListRunCheckpointsParams {
  runId: string;
}

export interface ListRunCheckpointsResult {
  runId: string;
  checkpoints: CheckpointSummary[];
}

/** List checkpoint summaries of all runs of a bot (RPC `listBotCheckpoints`). */
export interface ListBotCheckpointsParams {
  botId: string;
}

export interface ListBotCheckpointsResult {
  botId: string;
  /** Run id → summaries (mỗi run theo stepIndex tăng dần). */
  runs: Array<{ runId: string; checkpoints: CheckpointSummary[] }>;
}

/**
 * v0.54 (P1-8): chạy lại một run từ checkpoint cũ — time-travel replay
 * để debug (RPC `replayRun`). Khác resume thường ở chỗ step được chọn
 * tường minh (mặc định 'latest') và caller nói rõ ý định quay lại quá
 * khứ; tool đã xong nằm trong messages nên không chạy lại.
 */
export interface ReplayRunParams {
  botId: string;
  /** Id run cũ đã lưu checkpoint. */
  runId: string;
  /** Step quay lại — số step hoặc 'latest'. Mặc định 'latest'. */
  stepIndex?: number | 'latest';
}

export interface ReplayRunResult extends RunResult {
  /** Step đã quay lại (checkpoint được dùng). */
  replayedFromStep: number;
}

/**
 * v0.13: answer a pending MCP elicitation request (from an
 * `mcp.elicitation-needed` event). `content` is only used when
 * `action` is 'accept' in form-mode (the validated form object).
 */
export interface RespondElicitationParams {
  /** Elicitation id from the `mcp.elicitation-needed` event payload. */
  elicitationId: string;
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}

export interface RespondElicitationResult {
  /** True when a pending elicitation with this id existed and was answered. */
  found: boolean;
}

/**
 * v0.20 (W13a): duyệt plan trực tiếp từ màn hình Kế hoạch, KHÔNG qua
 * tool-call `plan_update` trong run — nên không còn thẻ approval nào
 * hiện cho chính hành động duyệt. Quyết định của người dùng đi thẳng
 * vào coordinator qua RPC này (main chuyển tiếp qua IPC `plans:review`).
 * Chỉ approve mới ghi dấu plan-approved (run kế tiếp tự duyệt tool-call,
 * tái dùng cơ chế W12e); reject / request-changes không ghi dấu.
 */
export interface ReviewPlanParams {
  botId: string;
  projectId: string;
  decision: PlanReviewDecision;
  /** Ghi chú kèm quyết định (chủ yếu cho `request-changes`). */
  note?: string;
}

export interface ReviewPlanResult {
  projectId: string;
  botId: string;
  /** Trạng thái duyệt sau khi áp dụng ('approved' | 'rejected' | 'changes-requested'). */
  status: PlanApprovalStatus;
  /** Working mode sau quyết định ('chat' sau approve, không đổi nếu khác). */
  mode: AgentMode;
  /** Note đã lưu cùng quyết định ('' khi không có). */
  note: string;
  /** Đường dẫn plan file tương đối trong workspace ('' khi plan không có file). */
  filePath: string;
  /** True khi đã ghi quyết định vào file plan (false = không có file để ghi). */
  fileStatusUpdated: boolean;
}

// ---------------------------------------------------------------------------
// v0.98 (Team T4 — planning v2): run-bound plans. A plan created here
// is owned by the coordinator (not by localStorage in the renderer):
// `run` with `planId` binds it to a live run, and every change is
// emitted as a `plan.event` notification carrying a PlanRunEvent.
// ---------------------------------------------------------------------------

/** A run-bound plan as the RPCs return it (engine shape + run link). */
export interface RunPlanView {
  plan: Plan;
  runId: string | null;
  botId: string | null;
  templateId?: string | null;
  /** Pending replan proposals for this plan. */
  proposals: ReplanProposal[];
}

export interface CreateRunPlanParams {
  botId: string;
  title?: string;
  detail?: string;
  steps?: string[];
  /** Create the plan from a template instead (title/steps ignored). */
  templateId?: string;
  /** Template variables (required ones must all be present). */
  templateVars?: Record<string, string>;
}

export interface CreateRunPlanResult {
  plan: Plan;
  templateId: string | null;
}

export interface ListRunPlansResult {
  plans: RunPlanView[];
}

export interface GetRunPlanParams {
  planId: string;
}

export interface GetRunPlanResult {
  plan: RunPlanView | null;
}

export interface DeleteRunPlanParams {
  planId: string;
}

export interface DeleteRunPlanResult {
  deleted: boolean;
}

export interface DecideReplanParams {
  proposalId: string;
  decision: 'approve' | 'reject';
  /** Run the proposal was raised in (for event routing; optional). */
  runId?: string;
}

export interface DecideReplanResult {
  proposal: ReplanProposal;
  plan: Plan | null;
}

export interface ResumeRunPlansResult {
  /** Plans whose running step was reset to pending. */
  resumed: RunPlanView[];
  /** Plans loaded unchanged. */
  untouched: RunPlanView[];
  /** File names skipped (corrupt / unreadable). */
  skipped: string[];
}

export interface PlanTemplateView {
  id: string;
  title: string;
  stepCount: number;
  variables: Array<{ name: string; required: boolean; hint: string }>;
}

export interface ListPlanTemplatesResult {
  templates: PlanTemplateView[];
}

/** Re-export for callers that handle `plan.event` payloads. */
export type { PlanRunEvent };

/** v0.14: enable/disable a plugin for a RUNNING bot (item 9). The flip
 *  is persisted to `<pluginsDir>/enabled.json` and the bot's tool list
 *  is rebuilt immediately — no need to recreate the bot. */
export interface SetPluginEnabledParams {
  botId: string;
  pluginId: string;
  enabled: boolean;
}

export interface SetPluginEnabledResult {
  ok: boolean;
  enabled: boolean;
  /** True when the bot had a plugins dir and its tools were rebuilt. */
  appliedToRunning: boolean;
}

/**
 * v0.58: trạng thái Composio trong tiến trình coordinator — hợp đồng
 * RPC mà main process gọi (`composio.setState` / `composio.getState`,
 * xem client.ts). `toolkits` là slug toolkit đang bật (subset của 4
 * slug gmail/github/slack/notion, theo thứ tự chuẩn); `registeredAppIds`
 * là app id Composio đang đăng ký trong `defaultAppRegistry` (router
 * `composio` + từng `composio-<toolkit>` đang bật). Không chứa key.
 */
export interface ComposioState {
  enabled: boolean;
  toolkits: string[];
  registeredAppIds: string[];
}

/** Params cho `composio.setState` — toolkit lạ → lỗi rõ ràng. */
export interface SetComposioStateParams {
  enabled: boolean;
  toolkits: string[];
}

/** Kết quả `composio.setState` = trạng thái đã áp dụng. */
export type SetComposioStateResult = ComposioState;

/** Kết quả `composio.getState` = trạng thái hiện tại. */
export type GetComposioStateResult = ComposioState;

/**
 * v0.59: nguồn key Composio mà coordinator đang dùng — chỉ tên nguồn,
 * KHÔNG chứa key. `seeded` = key main seed qua RPC (làm việc với mọi
 * backend Vault, kể cả safeStorage + NO_STORAGE); `vault-file` =
 * fallback đọc trực tiếp file Vault của main (chỉ mở được khi Vault
 * dùng LocalEncryptor); `none` = chưa có key ở đâu (fail-closed).
 */
export type ComposioKeySource = 'seeded' | 'vault-file' | 'none';

/** Params cho `composio.setApiKey` — key mới/xoay, hoặc null để xoá key đã seed. */
export interface SetComposioApiKeyParams {
  apiKey?: string | null;
}

/** Kết quả `composio.setApiKey` / `composio.getKeyStatus` — trạng thái key, không chứa key. */
export interface SetComposioApiKeyResult {
  /** True khi coordinator đọc được key (seed hoặc fallback file). */
  hasKey: boolean;
  /** True khi key đang dùng là key đã seed (thắng fallback). */
  seeded: boolean;
  /** Nguồn key đang dùng. */
  source: ComposioKeySource;
}

/** Kết quả `composio.getKeyStatus` = trạng thái key hiện tại. */
export type GetComposioKeyStatusResult = SetComposioApiKeyResult;

/**
 * v0.95 (Team D2): params cho `media.setKey` — seed (hoặc clear) key
 * của một media provider trong coordinator. `apiKey` null/rỗng = xoá
 * key đã seed của provider đó (về chưa cấu hình, fail-closed).
 */
export interface SetMediaApiKeyParams {
  providerId: string;
  apiKey?: string | null;
}

/**
 * v0.95 (Team D2): kết quả `media.setKey` / `media.getKeyStatus` —
 * trạng thái key theo provider, KHÔNG chứa key. `configured` liệt kê
 * provider nào đang có key seed trong bộ nhớ coordinator.
 */
export interface SetMediaApiKeyResult {
  configured: string[];
}

/** Kết quả `media.getKeyStatus` = trạng thái key hiện tại. */
export type GetMediaKeyStatusResult = SetMediaApiKeyResult;

// ---------------------------------------------------------------------------
// v0.98 (Đội T2): RPC router.* — nối IPC router:decisions / router:stats /
// router:set-config từ core sang renderer (xem docs/router-v098.md).
// Mọi kết quả đều không chứa API key hay secret.
// ---------------------------------------------------------------------------

/** Params cho `router.getDecisions` — lọc theo bot, giới hạn số lượng. */
export interface GetRouterDecisionsParams {
  botId?: string;
  limit?: number;
}

/** Kết quả `router.getDecisions` — quyết định mới nhất trước. */
export interface GetRouterDecisionsResult {
  decisions: RoutingDecision[];
  /** Tổng số quyết định đã lưu (toàn bộ hoặc của bot đó). */
  total: number;
}

/** Params cho `router.getStats` — vắng botId = thống kê toàn bộ. */
export interface GetRouterStatsParams {
  botId?: string;
}

/** Kết quả `router.getStats` = RouterStats của core. */
export type GetRouterStatsResult = RouterStats;

/** Params cho `router.setConfig` — patch cấu hình (validate trước khi áp). */
export interface SetRouterConfigParams {
  config: Partial<RouterConfig>;
}

/** Kết quả `router.setConfig` / `router.getConfig` = cấu hình hiệu lực. */
export type SetRouterConfigResult = RouterConfig;
export type GetRouterConfigResult = RouterConfig;

/** Params cho `router.clearLog` — vắng botId = xoá toàn bộ lịch sử. */
export interface ClearRouterLogParams {
  botId?: string;
}

/** Kết quả `router.clearLog` — số quyết định đã xoá. */
export interface ClearRouterLogResult {
  cleared: number;
}

/**
 * Trạng thái một engine CLI trong `router.getTargets` — để UI giải
 * thích vì sao một CLI có/không được offer (chỉ nhãn + trạng thái,
 * không secret, không token).
 */
export interface RouterCliStatus {
  providerId: string;
  kind: string;
  label: string;
  /** 'available' | 'unavailable' | 'unknown' (xem detected/types.ts). */
  status: string;
  reason?: string;
  enabled: boolean;
  /** True khi engine này đang được offer làm đích route. */
  offered: boolean;
}

/** Kết quả `router.getTargets` — mọi đích router có thể offer lúc này. */
export interface GetRouterTargetsResult {
  /** Mọi đích (default không có ở đây — đây là đích khám phá được). */
  targets: RouterTarget[];
  /** Đích Ollama local (null khi Ollama chết / không có model chat). */
  local: RouterTarget | null;
  /** Đích CLI đã khám phá (đã lọc theo cấu hình + opt-in). */
  cli: RouterTarget[];
  /** Đích API đã khám phá (đã lọc theo cấu hình + key đã seed). */
  api: RouterTarget[];
  /** Trạng thái từng engine CLI đã biết (offered hay không + vì sao). */
  cliStatus: RouterCliStatus[];
  /** Thời điểm khám phá (ms epoch). */
  discoveredAt: number;
}

/**
 * Params cho `router.setApiKey` — seed (hoặc clear) key của một
 * provider API cho router (main đọc Vault bằng safeStorage rồi seed
 * qua RPC, đúng mẫu `composio.setApiKey` / `media.setKey`).
 * `apiKey` null/rỗng = xoá key đã seed của provider đó.
 */
export interface SetRouterApiKeyParams {
  providerId: string;
  apiKey?: string | null;
}

/**
 * Kết quả `router.setApiKey` / `router.getApiKeyStatus` — chỉ danh
 * sách provider id đã có key seed, KHÔNG chứa key.
 */
export interface SetRouterApiKeyResult {
  configured: string[];
}

/** Kết quả `router.getApiKeyStatus` = trạng thái key hiện tại. */
export type GetRouterApiKeyStatusResult = SetRouterApiKeyResult;

/**
 * v0.88b: trạng thái user id Composio mà coordinator đang dùng —
 * CHỈ boolean, KHÔNG chứa user id. `userIdConfigured` = user đã
 * nhập user id thật (session dùng id đó, thấy connection trong
 * dashboard); `usingDefaultUserId` = đang dùng 'local-user' (chưa
 * cấu hình — session không thấy connection đã connect sẵn).
 */
export interface ComposioUserIdStatus {
  /** True khi coordinator đang dùng user id do user cấu hình (không phải mặc định). */
  userIdConfigured: boolean;
  /** True khi đang dùng mặc định 'local-user'. */
  usingDefaultUserId: boolean;
}

/** Params cho `composio.setUserId` — user id mới, hoặc null để về mặc định 'local-user'. */
export interface SetComposioUserIdParams {
  userId?: string | null;
}

/** Kết quả `composio.setUserId` / `composio.getUserIdStatus` — trạng thái user id, không chứa giá trị. */
export type SetComposioUserIdResult = ComposioUserIdStatus;

/** Kết quả `composio.getUserIdStatus` = trạng thái user id hiện tại. */
export type GetComposioUserIdStatusResult = ComposioUserIdStatus;

/**
 * v0.89c (Team E): params/kết quả RPC `composio.getConnectionStatus`
 * — trạng thái connection từng toolkit trong session hiện tại (chỉ
 * toolkit + trạng thái + nhãn tài khoản; KHÔNG chứa user id, link
 * OAuth hay key). `toolkits` vắng/rỗng = toolkit đang bật.
 */
export interface GetComposioConnectionStatusParams {
  toolkits?: string[];
}
export type GetComposioConnectionStatusResult = ComposioToolkitConnection[];

/**
 * v0.35 (P1-7): quản lý rule auto-approve qua RPC (main chuyển tiếp qua
 * IPC `auto-approve:*` cho Settings UI). Rule lưu local trong
 * `<dataDir>/auto-approve-rules.json` (coordinator sở hữu store).
 * KHÔNG có tool agent nào quản lý rule: agent tự thêm rule cho chính
 * mình là leo thang đặc quyền (tự duyệt lệnh nguy hiểm), nên quản lý
 * rule chỉ đi qua RPC/IPC của người dùng.
 */
export interface ListAutoApproveRulesResult {
  rules: AutoApproveRule[];
}

export type AddAutoApproveRuleParams = AutoApproveRuleInput;

export interface AddAutoApproveRuleResult {
  rule: AutoApproveRule;
}

export interface RemoveAutoApproveRuleParams {
  id: string;
}

export interface RemoveAutoApproveRuleResult {
  removed: boolean;
}

export interface SetAutoApproveRuleEnabledParams {
  id: string;
  enabled: boolean;
}

export interface SetAutoApproveRuleEnabledResult {
  rule: AutoApproveRule;
}

/**
 * v1.01 (Đội T3, risk budget): quản lý risk qua RPC (main chuyển tiếp
 * qua IPC `risk-*` cho Settings UI / CLI driver). Rule lưu local trong
 * `<dataDir>/risk-rules.json`, lịch sử budget trong
 * `<dataDir>/budget-history.json` (coordinator sở hữu store).
 * KHÔNG có tool agent nào quản lý rule/budget: agent tự nới rule cho
 * chính mình là leo thang đặc quyền — chỉ RPC/IPC của người dùng.
 */
export interface ListRiskRulesResult {
  rules: RiskRule[];
  allowlist: string[];
  denylist: string[];
  disabledBuiltinRuleIds: string[];
}

export interface AddRiskRuleParams {
  rule: RiskRule;
}

export interface AddRiskRuleResult {
  rule: RiskRule;
}

export interface RemoveRiskRuleParams {
  id: string;
}

export interface RemoveRiskRuleResult {
  removed: boolean;
}

export interface SetRiskListEntryParams {
  list: 'allow' | 'deny';
  action: 'add' | 'remove';
  entry: string;
}

export interface SetRiskListEntryResult {
  changed: boolean;
  list: 'allow' | 'deny';
  entry: string;
}

export interface ListBuiltinRiskRulesResult {
  rules: Array<RiskRule & { enabled: boolean }>;
}

export interface SetRiskBuiltinRuleEnabledParams {
  id: string;
  enabled: boolean;
}

export interface SetRiskBuiltinRuleEnabledResult {
  id: string;
  enabled: boolean;
}

export interface ListPendingConfirmationsResult {
  confirmations: Array<{
    id: string;
    botId: string;
    toolName: string;
    riskLevel: string;
    createdAtMs: number;
  }>;
}

export interface GetConfirmationAuditResult {
  audit: Array<{
    confirmationId: string;
    callId: string;
    botId: string;
    toolName: string;
    riskLevel: string;
    riskScore: number;
    status: string;
    decidedBy: string;
    atMs: number;
  }>;
}

export interface ListBudgetHistoryParams {
  botId?: string;
}

export interface ListBudgetHistoryResult {
  entries: Array<{
    conversationId: string;
    botId: string;
    model: string | null;
    totalTokens: number;
    costUsd: number | null;
    status: string;
    endedAtMs: number;
  }>;
}

export interface GetBudgetTotalsParams {
  botId: string;
}

export interface GetBudgetTotalsResult {
  botId: string;
  conversations: number;
  totalTokens: number;
  totalCostUsd: number | null;
  hasUnknownCost: boolean;
  exceededCount: number;
  warningCount: number;
}

export interface GetRiskReportParams {
  botId: string;
  conversationId?: string;
}

export interface GetRiskReportResult {
  botId: string;
  conversationId: string | null;
  markdown: string;
  summary: {
    totalCalls: number;
    approved: number;
    denied: number;
    edited: number;
    expired: number;
    highRisk: number;
    mediumRisk: number;
    lowRisk: number;
    totalTokens: number;
    costUsd: number | null;
  };
}

/**
 * v0.50 (M8): group chat bot-bot qua RPC (main chuyển tiếp qua IPC
 * `group:*` cho GroupView). Lịch sử lưu local trong
 * `<dataDir>/group-chats.json` (coordinator sở hữu store).
 * `postGroupMessage` chạy delegation: bot được @mention thì chạy một
 * run silent với nội dung message (dùng `run()` đã có), câu trả lời
 * của nó được thêm vào nhóm như message của bot đó (một hop duy nhất
 * — câu trả lời không parse mention tiếp). v0.94c: message nhận ảnh
 * đính kèm (cùng giới hạn vision channel như chat thường) — ảnh lưu
 * thành file, delegation run nhận đúng bytes ảnh.
 */
export interface CreateGroupChatParams {
  name: string;
  botIds?: string[];
}

export interface CreateGroupChatResult {
  group: GroupChat;
}

export interface ListGroupChatsResult {
  groups: GroupChat[];
}

export interface AddBotToGroupChatParams {
  groupId: string;
  botId: string;
}

export interface AddBotToGroupChatResult {
  added: boolean;
}

export interface RemoveBotFromGroupChatParams {
  groupId: string;
  botId: string;
}

export interface RemoveBotFromGroupChatResult {
  removed: boolean;
}

export interface DeleteGroupChatParams {
  groupId: string;
}

export interface DeleteGroupChatResult {
  deleted: boolean;
}

export interface PostGroupMessageParams {
  groupId: string;
  /** Nội dung message (người dùng gửi vào nhóm). Được rỗng khi có ảnh đính kèm. */
  text: string;
  /** Id bot gửi — vắng = người dùng. */
  botId?: string;
  /**
   * v0.94c: ảnh đính kèm (base64, xem `VisionAttachment` — cùng giới
   * hạn vision channel: tối đa 5 ảnh, 10 MB mỗi ảnh, 20 MB tổng).
   * Coordinator validate rồi lưu thành file; delegation run nhận đúng
   * bytes này để bot "nhìn" được ảnh.
   */
  attachments?: VisionAttachment[];
}

export interface PostGroupMessageResult {
  /** Message vừa gửi (của người dùng / bot gửi). */
  message: GroupMessage;
  /** Câu trả lời delegation của các bot được @mention (theo thứ tự mention). */
  replies: GroupMessage[];
}

/** v0.94c: đọc lại bytes của một ảnh đính kèm trong message nhóm (để renderer hiện thumbnail). */
export interface GetGroupAttachmentParams {
  groupId: string;
  messageId: string;
  attachmentId: string;
}

export interface GetGroupAttachmentResult {
  attachment: VisionAttachment;
}

/**
 * v0.94c: digest của các project tới hạn gửi cập nhật định kỳ (desktop
 * main gọi mỗi 15 phút để gửi thông báo + lưu vào chat của bot).
 */
export interface ProjectUpdatesDueResult {
  updates: ProjectDigest[];
}

/** v0.94c: ghi dấu đã gửi digest cho một project. */
export interface ProjectUpdatesMarkSentParams {
  botId: string;
  projectId: string;
}

export interface ProjectUpdatesMarkSentResult {
  /** Luôn true khi gọi thành công (bot/project lạ thì throw). */
  marked: boolean;
  /** Thời điểm digest kế tiếp tới hạn, null khi project tắt updates. */
  nextDueAt: string | null;
}

export interface ListGroupMessagesParams {
  groupId: string;
  limit?: number;
}

export interface ListGroupMessagesResult {
  messages: GroupMessage[];
}

/**
 * v0.96 (Team T4): channels qua RPC (main chuyển tiếp qua IPC
 * `channel:*` cho ChannelsView). Lịch sử lưu local trong
 * `<dataDir>/channels.json` (coordinator sở hữu store).
 * `postChannelMessage` chạy responder rules: bot được chọn chạy một
 * run silent với nội dung message + shared instructions của channel
 * (gộp vào đầu prompt) + working folder làm `cwd` của run; câu trả
 * lời của nó được thêm vào channel như message `delegated` của bot đó
 * (một hop duy nhất — câu trả lời không parse mention tiếp).
 */
export interface CreateChannelParams {
  name: string;
  kind?: ChannelKind;
  sharedInstructions?: string;
  workingFolder?: string;
  botIds?: string[];
  responderRules?: Partial<ChannelResponderRules>;
}

export interface CreateChannelResult {
  channel: Channel;
}

export interface ListChannelsResult {
  channels: Channel[];
}

export interface UpdateChannelParams {
  channelId: string;
  name?: string;
  kind?: ChannelKind;
  sharedInstructions?: string;
  workingFolder?: string;
  responderRules?: Partial<ChannelResponderRules>;
}

export interface UpdateChannelResult {
  channel: Channel;
}

export interface DeleteChannelParams {
  channelId: string;
}

export interface DeleteChannelResult {
  deleted: boolean;
}

export interface AddBotToChannelParams {
  channelId: string;
  botId: string;
}

export interface AddBotToChannelResult {
  added: boolean;
}

export interface RemoveBotFromChannelParams {
  channelId: string;
  botId: string;
}

export interface RemoveBotFromChannelResult {
  removed: boolean;
}

export interface MoveBotBetweenChannelsParams {
  fromChannelId: string;
  toChannelId: string;
  botId: string;
}

export interface MoveBotBetweenChannelsResult {
  moved: boolean;
}

export interface PostChannelMessageParams {
  channelId: string;
  /** Nội dung message (người dùng gửi vào channel). */
  text: string;
}

export interface PostChannelMessageResult {
  /** Message vừa gửi (của người dùng). */
  message: ChannelMessage;
  /** Bot đã được chạy theo responder rules (theo thứ tự chạy). */
  responders: string[];
  /** Câu trả lời của các bot (message `delegated`, theo thứ tự chạy). */
  replies: ChannelMessage[];
  /** Bot chạy lỗi (botId → message lỗi). */
  errors: Record<string, string>;
}

export interface ListChannelMessagesParams {
  channelId: string;
  limit?: number;
}

export interface ListChannelMessagesResult {
  messages: ChannelMessage[];
}

/**
 * v0.79a (UI parity §7): trạng thái chạy của bot trong group chat —
 * renderer poll để hiện "đang trả lời…" từng bot trong lúc delegation
 * run đang chạy. Chỉ bot `running` mới có entry (idle = vắng mặt).
 */
export interface GetGroupBotStatusParams {
  groupId: string;
}

export interface GetGroupBotStatusResult {
  groupId: string;
  /** Các bot đang chạy trong nhóm (sắp theo lúc bắt đầu chạy). */
  running: GroupBotStatusEntry[];
  /** Các bot đang chạy dở thì app dừng (khôi phục từ snapshot, v0.82). */
  interrupted: GroupBotInterruptedEntry[];
}

/** v0.82: bỏ qua ghi nhận "chạy dở thì app dừng" của một bot trong nhóm. */
export interface DismissGroupBotInterruptedParams {
  groupId: string;
  botId: string;
}

export interface DismissGroupBotInterruptedResult {
  groupId: string;
  botId: string;
  dismissed: boolean;
}

/** v0.14: route a task to the best bot(s) by capability (supervisor). */
export interface SuperviseParams {
  task: string;
  /** Only consider these bots (default: all bots). */
  agentIds?: string[];
  /** 'sequential' (default: try best, fall back on error) or 'parallel' (top-N at once). */
  mode?: 'sequential' | 'parallel';
  /** How many top agents to try in parallel mode (default 2). */
  topN?: number;
}

export interface SuperviseResult {
  task: string;
  mode: 'sequential' | 'parallel';
  results: Array<{
    agentId: string;
    result?: string;
    error?: string;
    score: number;
  }>;
}

/** Persist one chat message in the bot's BotMemory (owned by the child). */
export interface SaveMessageParams {
  botId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** v0.59 (UI-5): thread the message belongs to (unknown thread throws). */
  threadId?: string;
  /**
   * v0.65 (vision persistence): images attached to this (user) message
   * — validated against the vision caps and stored as files +
   * `message_attachments` rows (see `BotMemory.saveMessage`). Base64
   * travels over the local stdio RPC only, never logged.
   */
  attachments?: VisionAttachment[];
}

export interface SaveMessageResult {
  id: string;
}

/** Read chat history from the bot's BotMemory (oldest first). */
export interface GetHistoryParams {
  botId: string;
  limit?: number;
  /** v0.59 (UI-5): scope to one thread; without it the bot's whole history. */
  threadId?: string;
  /**
   * v0.65 (vision persistence): true = re-read stored images from
   * their files as base64 for DISPLAY (renderer reload). Default
   * false — run-context seeding and every other reader keep getting
   * text-only messages.
   */
  includeAttachments?: boolean;
}

export interface GetHistoryResult {
  messages: Array<{ role: string; content: string; attachments?: VisionAttachment[] }>;
}

/** v0.59 (UI-5): threads — one bot has many conversations. */
export interface ListThreadsParams {
  botId: string;
  /** UI locale naming the default thread when one has to be created. */
  locale?: string;
}

export interface ListThreadsResult {
  threads: ThreadItem[];
}

export interface CreateThreadParams {
  botId: string;
  title?: string;
  /** UI locale for the default title when `title` is omitted. */
  locale?: string;
}

export interface CreateThreadResult {
  thread: ThreadItem;
}

export interface RenameThreadParams {
  threadId: string;
  title: string;
}

export interface RenameThreadResult {
  thread: ThreadItem;
}

export interface DeleteThreadParams {
  threadId: string;
}

export interface DeleteThreadResult {
  deleted: boolean;
}

export interface GetThreadHistoryParams {
  threadId: string;
  limit?: number;
  /** v0.65: see `GetHistoryParams.includeAttachments` (display only). */
  includeAttachments?: boolean;
}

export interface GetThreadHistoryResult {
  thread: ThreadItem;
  messages: Array<{ role: string; content: string; attachments?: VisionAttachment[] }>;
}

export interface SearchThreadsParams {
  /** Omit to search every bot's threads. */
  botId?: string;
  query: string;
}

export interface SearchThreadsResult {
  hits: ThreadSearchHit[];
}

/** Health of the local-exec-daemon owned by this coordinator. */
export interface DaemonStatusResult {
  /** True when a daemon client exists and answers ping. */
  running: boolean;
  /** OS pid of the daemon child, when running. */
  pid?: number;
}

/**
 * M5 — đọc lại NDJSON log theo thread (RPC `harnessThreadLog`).
 * `kinds` lọc theo kind event; limit kẹp 1–1000 ở ThreadLog.read.
 */
export interface HarnessThreadLogParams {
  threadId: string;
  limit?: number;
  offset?: number;
  kinds?: HarnessEventKind[];
}

/** M5 — UI quyết một permission request đang chờ (RPC `harnessDecidePermission`). */
export interface HarnessDecidePermissionParams {
  requestId: string;
  allowed: boolean;
}

/** M5 — kết quả harness (re-export từ harness để RPC/client dùng chung type). */
export type {
  HarnessDecidePermissionResult,
  HarnessStatusResult,
  HarnessThreadLogResult,
} from '../harness';

/**
 * Xem AGENTS.md đang có hiệu lực cho một bot (debug, v0.34 P1-6):
 * nội dung đã gộp + nguồn từng file + file bị bỏ qua/cắt ngắn.
 * Dùng cùng loader + cache với executeRun nên thấy đúng thứ run sẽ nạp.
 */
export interface GetWorkspaceRulesParams {
  botId: string;
  /** Thư mục làm việc hiện tại (mặc định workspaceDir của bot). */
  cwd?: string;
}

/**
 * v0.37 (P1-3): handoff phiên làm việc — liệt kê / đọc / tạo / nhận
 * record (RPC cho UI sau này; xem `packages/core/src/handoff/`).
 * Record lưu local `<dataDir>/handoffs.json`, không chứa secret.
 */
export interface ListHandoffsParams {
  fromBotId?: string;
  toBotId?: string;
  workStatus?: SessionHandoffWorkStatus;
  /** Số record tối đa trả về (mới nhất trước). Mặc định tất cả. */
  limit?: number;
}

export interface ListHandoffsResult {
  handoffs: SessionHandoffSummary[];
}

export interface GetHandoffParams {
  id: string;
}

export interface GetHandoffResult {
  record: SessionHandoffRecord;
}

/**
 * Tạo record handoff từ phía coordinator (người dùng / automation bấm
 * tạo thay vì agent tự gọi tool `create_handoff`): nội dung lấy từ
 * params; `includeTranscript` (mặc định true) thì kèm 50 dòng gần nhất
 * trong lịch sử bot làm transcript excerpt. `toBotId` phải là bot đã
 * tạo trong coordinator (sai thì lỗi rõ).
 */
export interface CreateHandoffRecordParams {
  botId: string;
  toBotId?: string;
  title?: string;
  workStatus?: SessionHandoffWorkStatus;
  taskSummary?: string;
  currentState?: string;
  completed?: string[];
  remaining?: string[];
  nextStep?: string;
  filesChanged?: string[];
  filesRelevant?: string[];
  decisions?: Array<string | SessionHandoffDecision>;
  blockers?: Array<string | SessionHandoffBlocker>;
  context?: string;
  /** Nối tiếp handoff cũ (id record trước trong cùng chuỗi). */
  previousHandoffId?: string;
  /** Kèm transcript excerpt từ lịch sử bot (mặc định true). */
  includeTranscript?: boolean;
}

export interface CreateHandoffRecordResult {
  record: SessionHandoffRecord;
}

/**
 * Nhận handoff (không chạy run): kiểm tra record có đúng bot nhận không,
 * đánh dấu đã nhận, trả về record + khối ngữ cảnh (`promptBlock`) để
 * caller chèn vào run — hoặc chạy run với `RunParams.handoffId` để
 * coordinator tự làm việc đó. `confirmation` là xác nhận nội dung đã nạp.
 */
export interface AcceptHandoffParams {
  id: string;
  botId: string;
}

export interface AcceptHandoffResult {
  record: SessionHandoffRecord;
  promptBlock: string;
  confirmation: AcceptedHandoffConfirmation;
}

export interface GetWorkspaceRulesResult {
  botId: string;
  /** WorkspaceDir của bot (đã resolve, tuyệt đối). */
  workspaceDir: string;
  /** Thư mục làm việc hiện tại đã dùng (đã resolve, tuyệt đối). */
  cwd: string;
  /** Quy tắc đã load, hoặc null khi workspace không có AGENTS.md nào. */
  rules: AgentsMdResult | null;
}

/** List plan tasks for a bot (for the desktop `tasks:list` handler). */
export interface ListTasksParams {
  botId: string;
}

/** Run one tool by name inside the coordinator (automation `run-tool`, v0.4). */
export interface RunToolParams {
  botId: string;
  tool: string;
  args?: Record<string, unknown>;
}

export interface RunToolResult {
  output: string;
}

/** Create a plan task for a bot (automation `create-task` / dream, v0.4). */
export interface CreateTaskParams {
  botId: string;
  title: string;
}

export interface CreateTaskResult {
  id: string;
}

/** Reload the coordinator-side skill registry (after `skills:reload`, v0.4). */
export interface ReloadSkillsResult {
  skills: string[];
  errors: Array<{ file: string; error: string }>;
}

/** Tool-result cache stats (v0.4). */
export interface CacheStatsResult {
  entries: number;
  hits: number;
  misses: number;
  evictions: number;
  maxEntries: number;
}

export interface CacheClearResult {
  cleared: boolean;
}

export interface ListTasksResult {
  tasks: Array<{
    id: string;
    botId: string;
    title: string;
    status: string;
    tags: string;
    createdAt: string;
    updatedAt: string;
  }>;
}
