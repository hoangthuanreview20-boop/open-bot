/**
 * AgentCoordinator — runs in a CHILD process and owns every AgentRunner.
 *
 * Why a child process: each bot gets its own BotMemory (SQLite). SQLite
 * locks a database file per connection, so two processes (or two
 * BotMemory instances on the same file) would fight over it. The
 * coordinator is the single owner of all bot memories; the desktop main
 * process only talks to it over NDJSON-RPC on stdio and never opens a
 * BotMemory itself.
 *
 * Design notes:
 * - One AgentRunner is built FRESH for every `run` (the runner is cheap;
 *   provider/tools/bot are shared). The per-run AbortController is what
 *   `stopBot` aborts — the signal reaches tools as ctx.signal and (v0.15)
 *   cancels an in-flight provider.chat() fetch for OpenAI-compatible
 *   providers, so the run settles as stopped instead of finishing.
 *   A stop that arrives BEFORE the run's RPC (the UI shows Stop before
 *   `chat:send` dispatches `run`) is remembered as `pendingStopAt` on
 *   the bot entry (v0.60) and aborts the run that starts right after;
 *   a stop older than PENDING_STOP_WINDOW_MS is stale and ignored.
 *   The same race exists per run id: `stopRun` for a run id the
 *   coordinator has not seen yet (WS clients pass the stream's run id,
 *   so a stop can overtake the run on another channel) is remembered
 *   in `pendingStopByRunId` (v0.74a) and aborts the run carrying that
 *   id when it starts — same window, consumed once.
 * - `onApprovalNeeded` / `onAskUser` round-trip to the parent over RPC:
 *   the child emits the notification (with the tool call id / request id),
 *   then waits for `respondApproval` / `respondAskUser` from the parent.
 *   No answer within 10 minutes resolves to deny / '' (safe defaults,
 *   same as the desktop main's old in-process timeouts). autoApprove bots
 *   approve immediately without emitting.
 * - A failing bot run never kills the coordinator: `handle()` catches
 *   everything and returns an error response.
 * - The tool registry is built exactly like the desktop main does
 *   (defaults + code + plan + subagent + MCP). `@open-bot/tools` is
 *   loaded with a dynamic require, NOT a static import: tools imports
 *   runtime code from @open-bot/core (PlanService), so a static import
 *   here would be a core <-> tools cycle. The factory is injectable so
 *   embedders/tests can supply their own tools without the tools package.
 * - Never log `params`: createBot params carry the provider API key.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import type {
  AgentEvents,
  BotConfig,
  ChatCompletionRequest,
  ChatMessage,
  Provider,
  Tool,
  ToolCall,
  ToolResult,
} from '../types';
import { AgentRunner } from '../agent/loop';
import type { ForkSkillInput } from '../agent/loop';
import { inferContextLimitFromModelName } from '../agent/smallModel';
import { loadLocalProfile } from '../auth/identity';
import { OllamaEmbeddings } from '../memory/embeddings';
import { LongTermMemory } from '../memory/longterm';
import { MemoryBlockStore } from '../memory/blocks';
import { TemporalKnowledgeGraph } from '../memory/graph';
import { SleepTimeAgent, episodesFromHistory, scheduleSleepAfterTurn } from '../memory/sleepAgent';
import { noteConsolidationActivity, runIdleConsolidationIfDue } from '../memory/consolidate';
import { TemporalGraphStore } from '../memory/graph/store';
import { EvolvingNoteStore } from '../memory/notes/store';
import { SleepConsolidationAgent, createGraphSleepAgent } from '../memory/graph/sleepAgent';
import { buildMemoryTurnContext, isEmbedderAvailableCached } from '../memory/turnContext';
import {
  THREAD_HISTORY_MAX_MESSAGES,
  selectThreadHistory,
  threadHistoryTokenBudget,
} from '../agent/threadHistory';
import { BotMemory } from '../agent/memory';
import { AgentPermissions, isSkillAllowedFor, isToolAllowedFor } from '../agent/permissions';
import { estimateToolDefinitionTokens, isReadOnlyTool, toolGroupFor } from '../agent/toolFilter';
import { createGlobRulesHook, RulesStore } from '../agent/rules';
import { AUTO_APPROVE_RULES_FILE_NAME, AutoApproveRuleStore } from '../approval/index';
import type { AutoApproveRule } from '../approval/index';
import { summarizeArgsForCard } from '../approval/index';
/**
 * v1.01 (Đội T3, risk budget): risk rating + confirmation policy +
 * conversation budget meter (xem `risk/`). Coordinator giữ một
 * ConfirmationQueue chung cho mọi run (audit log xuyên run) và một
 * RiskAnalyzer mặc định; mỗi run có BudgetMeter riêng (cap từ bot).
 */
import { ConfirmationQueue } from '../risk/queue';
import { ConversationBudgetMeter } from '../risk/budget';
import { ConversationBudgetHistory } from '../risk/history';
import { RiskAnalyzer } from '../risk/analyzer';
import { RiskRuleStore } from '../risk/store';
import { BUILTIN_RISK_RULES } from '../risk/analyzer';
import { buildRiskReportMarkdown, summarizeRiskReport } from '../risk/report';
import type { BudgetSnapshot } from '../risk/types';
import type { RiskRule } from '../risk/types';
import { validateVisionAttachments } from '../agent/vision';
import {
  GROUP_BOT_STATUS_FILE_NAME,
  GROUP_CHATS_FILE_NAME,
  GroupBotStatusTracker,
  GroupChatStore,
  MAX_GROUP_MESSAGES,
  parseGroupMentions,
} from '../groupchat/index';
import type { GroupMessage } from '../groupchat/index';
import {
  ChannelStore,
  routeChannelMessage,
} from '../channels/index';
import type { ChannelMessage } from '../channels/index';
import type { AgentMode } from '../agent/coordination';
import {
  checkHop,
  createHandoff,
  formatHandoffForPrompt,
  HandoffLog,
  transferToolNameFor,
  wouldRepeatHandoff,
} from '../agent/handoff';
import type { HandoffMessage, HandoffRecord } from '../agent/handoff';
import { pruneCheckpoints, resumeFromCheckpoint } from '../agent/checkpoints';
import { listCheckpointSummaries, replayFromCheckpoint } from '../agent/checkpoints';
import type { CheckpointSummary } from '../agent/checkpoints';
// v1.01 (Đội T1): event-sourced run log.
import {
  RunControlRegistry,
  RunLogRecorder,
  RunLogStore,
  forkRun,
  pauseRun,
  queryAudit,
  replayRunState,
  resumeRun,
  summarizeAudit,
  verifyAllRuns,
} from '../event-log/index';
import type {
  AnyRunEvent,
  AuditEventEntry,
  AuditIntegrityReport,
  AuditQuery,
  AuditSummary,
  ForkRunResult,
  PauseResumeResult,
  ReplayedRunState,
  RunEventQuery,
  RunLogMeta,
  RunLogVerification,
} from '../event-log/index';
import { InterruptController } from '../agent/interrupt';
import type { InterruptDecision, InterruptHandler, InterruptRequest } from '../agent/interrupt';
import { runWorkflow } from '../agent/workflow';
import type { WorkflowDefinition } from '../agent/workflow';
import { planEditTestFixWorkflow, researchBriefWorkflow } from '../agent/workflows/index';
import { createWorkflowRunner } from '../agent/workflow-runner';
import type { ApprovalDecision } from '../types';
import { createProvider, isAbortError, PROVIDERS } from '../providers/index';
import { OllamaProvider } from '../providers/ollama';
import { MeteredProvider, UsageTracker } from '../usage/index';
import { SkillRegistry, skillRunsInSubagent } from '../skills/index';
import { DEFAULT_HOOK_SCRIPT_TIMEOUT_MS, HookRegistry, HookRunner } from '../hooks/index';
import type { HookCommandSettingsEntry, HookDefinition, HookEventKind } from '../hooks/index';
import {
  createTestGateHook,
  HOOK_COMMANDS_FILE,
  HookExecutionLog,
  readTestGateConfig,
  testGateCommands,
} from '../hooks/index';
import { createDefaultRegistry } from '../guardrails/index';
import { Tracer, TraceStore } from '../tracing/index';
import type { TraceStatus } from '../tracing/index';
import { isAgentMode, isPlanReviewDecision, reviewPlan } from '../agent/coordination';
import { updatePlanFileStatus } from '../agent/planning';
import {
  instantiatePlanTemplate,
  listPlanTemplates,
  PlanFileStore,
  RunPlanBinding,
} from '../planning/index';
import type { PlanRunEvent, StoredRunPlan } from '../planning/index';
import {
  acceptedHandoffConfirmation,
  createSessionHandoff,
  formatSessionHandoffForPrompt,
  SESSION_HANDOFFS_FILE_NAME,
  SessionHandoffStore,
} from '../handoff/index';
import type {
  AcceptedHandoffConfirmation,
  SessionHandoffRecord,
} from '../handoff/index';
import { SUGGESTED_CACHEABLE_TOOLS, ToolResultCache } from '../perf/index';
import { ensureMcpServer, loadMcpConfig } from '../mcp/config';
import { connectMcp } from '../mcp/client';
import { createSamplingHandler, type SamplingToolExecutor } from '../mcp/clientHandlers';
import { createSamplingContextStore, type SamplingContextStore } from '../mcp/samplingContext';
import type { McpSamplingHandler } from '../mcp/clientHandlers';
import type { McpClient, McpServerConfig } from '../mcp/types';
import { SlashCommandRegistry, type SlashCommandDef } from '../agent/slash';
import { resolveMentions } from '../agent/mentions';
import { loadAgentsMd } from '../project/agentsMd';
import {
  listDueProjectUpdates,
  markProjectUpdateSent,
  nextProjectDigestAt,
} from '../project/updates';
import { Supervisor, type AgentCapability } from '../agent/supervisor';
import type { SpecializedSubagentSpec } from '../agent/subagent';
import type { McpOAuthClientConfig, McpOAuthStore } from '../mcp/oauth';
import type {
  ElicitResult,
  ElicitationPrompt,
  ElicitationRequest,
} from '../mcp/elicitation';
import {
  createConnectorTokenProvider,
  type ConnectorDefinition,
  type ConnectorTokenProvider,
  type TokenSet,
  type TokenStore,
} from '../connectors/framework';
import { SLACK_CONNECTOR } from '../connectors/slack';
import { GMAIL_CONNECTOR } from '../connectors/email';
import { TEAMS_CONNECTOR } from '../connectors/teams';
import { SharedAppAuthStore, defaultAppRegistry } from '../apps/index';
import type { AppStatusView } from '../apps/index';
// v0.58: Composio execution path — source trên defaultAppRegistry +
// session manager dùng chung (key đọc trực tiếp file Vault của main,
// xem composio/keyStore.ts). Không import tools package ở đây.
import {
  COMPOSIO_LOCAL_USER_ID,
  COMPOSIO_RUNNABLE_META_TOOLS,
  COMPOSIO_TOOLKIT_SLUGS,
  ComposioAppSource,
  ComposioSessionManager,
  applyComposioPersistedState,
  createComposioMetaTools,
  createComposioSeededKeyReader,
  createComposioVaultFileKeyReader,
  resolveComposioUserId,
} from '../composio/index';
import type { ComposioFetchFn, ComposioSeededKeyReader } from '../composio/index';
// v0.95 (Team D2): media keys — registry + config builder, không import
// tools package ở đây (coordinator chỉ resolve key, tool tự gọi HTTP).
import {
  buildMediaProviderConfig,
  isMediaProviderId,
  validateMediaApiKey,
} from '../media/index';
import { LocalHarness } from '../harness';
// v0.97 (Team T3): AG-UI event bus + runtime emitter + state store +
// generative-UI registry (agent-to-user interface).
import {
  AgUiEventBus,
  AgUiGenerativeUiRegistry,
  AgUiRuntimeEmitter,
  AgUiStateStore,
  shouldEmitAgUiForProvider,
} from '../agui/index';
import type { AgUiBusStats, AgUiEvent, AgUiEventFilter } from '../agui/index';
// v0.96 (Đội T3): router chọn model/provider mỗi turn (3 tầng
// structural → semantic → decision, session pinning, fallback ladder).
// v0.98 (Đội T2): + lịch sử bền vững, khám phá đích CLI/API, RPC router.*.
import {
  ModelRouter,
  RouterDecisionStore,
  buildAvailableTargets,
  computeRouterStats,
  discoverApiTargets,
  discoverCliTargets,
  loadRouterConfigFile,
  saveRouterConfigFile,
  validateRouterConfigPatch,
  type RouterConfig,
  type RouterTarget,
  type RoutingDecision,
} from '../router/index';
import { DetectedEngineRegistry, DETECTED_ENGINES_FILE } from '../detected/index';
import type { DetectedEnginesSnapshot } from '../detected/index';
import type {
  ClearRouterLogParams,
  ClearRouterLogResult,
  GetRouterConfigResult,
  GetRouterDecisionsParams,
  GetRouterDecisionsResult,
  GetRouterStatsParams,
  GetRouterStatsResult,
  GetRouterTargetsResult,
  RouterCliStatus,
  SetRouterApiKeyParams,
  SetRouterApiKeyResult,
  SetRouterConfigParams,
  SetRouterConfigResult,
} from './types';
import type {
  HarnessDecidePermissionResult,
  HarnessStatusResult,
  HarnessThreadLogResult,
} from '../harness';
// v0.55: policy egress của team (team.json dưới dataDir) merge lên trên
// policy chung — shell tools tự resolve qua đây (xem
// `resolveBotEgressPolicy` + `ToolFactoryHost.getEgressPolicy`).
import { validateEgressPolicy, type EgressPolicy } from '../egress/policy';
import { isLocalUserTeamAdmin, loadTeamConfig, resolveTeamEgressPolicy } from '../team/team';
import { LOCAL_USER_ID, type TeamConfig } from '../team/types';

/**
 * Minimal daemon surface, defined LOCALLY (structural — the real
 * DaemonClient satisfies it). Core must NOT import types from
 * @open-bot/tools, not even `import type`: tools' dist .d.ts re-exports
 * core types, so the import pulls core's own dist .d.ts in as inputs
 * and tsc refuses to overwrite them (TS5055). The runtime dependency
 * stays a dynamic require (see defaultToolFactory / getDaemonClient).
 */
export interface ShellDaemonLike {
  exec(
    request: {
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    },
    callbacks?: {
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
    },
    execId?: string,
  ): Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean }>;
  kill(execId: string): Promise<{ killed: boolean }>;
}

export interface DaemonClientLike extends ShellDaemonLike {
  readonly isDisposed: boolean;
  readonly pid: number | undefined;
  ping(): Promise<{ pong: boolean }>;
  waitForExit(): Promise<void>;
  dispose(): Promise<void>;
}
import type {
  AcceptHandoffParams,
  AcceptHandoffResult,
  AddAutoApproveRuleParams,
  AddAutoApproveRuleResult,
  AddRiskRuleParams,
  AddRiskRuleResult,
  GetBudgetTotalsParams,
  GetBudgetTotalsResult,
  ListBuiltinRiskRulesResult,
  SetRiskBuiltinRuleEnabledParams,
  SetRiskBuiltinRuleEnabledResult,
  GetConfirmationAuditResult,
  GetRiskReportParams,
  GetRiskReportResult,
  ListBudgetHistoryParams,
  ListBudgetHistoryResult,
  ListPendingConfirmationsResult,
  ListRiskRulesResult,
  RemoveRiskRuleParams,
  RemoveRiskRuleResult,
  SetRiskListEntryParams,
  SetRiskListEntryResult,
  AgentEvent,
  AgentEventKind,
  CacheClearResult,
  CacheStatsResult,
  ComposioState,
  ConnectorClientConfig,
  CoordinatorNotification,
  CreateBotParams,
  CreateBotProviderConfig,
  CreateBotResult,
  AddBotToChannelParams,
  AddBotToChannelResult,
  CreateChannelParams,
  CreateChannelResult,
  CreateGroupChatParams,
  CreateGroupChatResult,
  DeleteChannelParams,
  DeleteChannelResult,
  ListChannelMessagesParams,
  ListChannelMessagesResult,
  ListChannelsResult,
  MoveBotBetweenChannelsParams,
  MoveBotBetweenChannelsResult,
  PostChannelMessageParams,
  PostChannelMessageResult,
  RemoveBotFromChannelParams,
  RemoveBotFromChannelResult,
  UpdateChannelParams,
  UpdateChannelResult,
  CreateHandoffRecordParams,
  CreateHandoffRecordResult,
  CreateTaskParams,
  CreateTaskResult,
  CreateThreadParams,
  CreateThreadResult,
  DaemonStatusResult,
  DeleteGroupChatParams,
  DeleteGroupChatResult,
  DeleteThreadParams,
  DeleteThreadResult,
  DeleteBotDataParams,
  DeleteBotDataResult,
  DestroyBotParams,
  DestroyBotResult,
  GetHandoffParams,
  GetHandoffResult,
  GetHistoryParams,
  GetHistoryResult,
  GetThreadHistoryParams,
  GetThreadHistoryResult,
  GetWorkspaceRulesParams,
  GetWorkspaceRulesResult,
  HarnessDecidePermissionParams,
  HarnessThreadLogParams,
  InterruptRunParams,
  InterruptRunResult,
  ListBotCheckpointsParams,
  ListBotCheckpointsResult,
  ListRunCheckpointsParams,
  ListRunCheckpointsResult,
  ReplayRunParams,
  ReplayRunResult,
  RespondInterruptParams,
  RespondInterruptResult,
  ListAutoApproveRulesResult,
  ListBotsResult,
  ListBotToolsParams,
  ListBotToolsResult,
  ListBotSkillsParams,
  ListBotSkillsResult,
  ListSlashCommandsParams,
  ListSlashCommandsResult,
  BotToolInfo,
  BotSkillInfo,
  SetBotToolEnabledParams,
  SetBotToolEnabledResult,
  SetBotSkillEnabledParams,
  SetBotSkillEnabledResult,
  ListGroupChatsResult,
  DismissGroupBotInterruptedParams,
  DismissGroupBotInterruptedResult,
  GetGroupAttachmentParams,
  GetGroupAttachmentResult,
  ProjectUpdatesDueResult,
  ProjectUpdatesMarkSentParams,
  ProjectUpdatesMarkSentResult,
  GetGroupBotStatusParams,
  GetGroupBotStatusResult,
  ListGroupMessagesParams,
  ListGroupMessagesResult,
  ListHandoffsParams,
  ListHandoffsResult,
  ListTasksParams,
  ListTasksResult,
  ListThreadsParams,
  ListThreadsResult,
  RenameThreadParams,
  RenameThreadResult,
  SearchThreadsParams,
  SearchThreadsResult,
  MockProviderResponse,
  PingResult,
  PostGroupMessageParams,
  PostGroupMessageResult,
  ReloadSkillsResult,
  RemoveAutoApproveRuleParams,
  RemoveAutoApproveRuleResult,
  RemoveBotFromGroupChatParams,
  RemoveBotFromGroupChatResult,
  AddBotToGroupChatParams,
  AddBotToGroupChatResult,
  RespondApprovalParams,
  RespondApprovalResult,
  RespondAskUserParams,
  RespondAskUserResult,
  RespondElicitationParams,
  RespondElicitationResult,
  ReviewPlanParams,
  ReviewPlanResult,
  CreateRunPlanParams,
  CreateRunPlanResult,
  DecideReplanParams,
  DecideReplanResult,
  DeleteRunPlanParams,
  DeleteRunPlanResult,
  GetRunPlanParams,
  GetRunPlanResult,
  ListPlanTemplatesResult,
  ListRunPlansResult,
  ResumeRunPlansResult,
  RunParams,
  RunPlanView,
  RunResult,
  RunToolParams,
  RunToolResult,
  SaveMessageParams,
  SaveMessageResult,
  SetAutoApproveRuleEnabledParams,
  SetAutoApproveRuleEnabledResult,
  SetPluginEnabledParams,
  SetPluginEnabledResult,
  GetComposioKeyStatusResult,
  GetMediaKeyStatusResult,
  GetComposioConnectionStatusParams,
  GetComposioConnectionStatusResult,
  GetComposioStateResult,
  GetComposioUserIdStatusResult,
  SetComposioApiKeyParams,
  SetComposioApiKeyResult,
  SetMediaApiKeyParams,
  SetMediaApiKeyResult,
  SetComposioStateParams,
  SetComposioStateResult,
  SetComposioUserIdParams,
  SetComposioUserIdResult,
  ShutdownResult,
  StopBotResult,
  SuperviseParams,
  SuperviseResult,
  SwitchModelParams,
  SwitchModelResult,
} from './types';

/** How long the child waits for the parent to answer approval / ask-user. */
const RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * v0.60 (P0 Stop race): a pending stop only applies to a run starting
 * within this window after the stop. Covers IPC + pool scheduling
 * under load (milliseconds normally, seconds worst case); a stop
 * older than this with no run started is stale and must never kill
 * an unrelated later run.
 */
const PENDING_STOP_WINDOW_MS = 30_000;

/**
 * v0.74a: cap số stop đang chờ theo runId (`pendingStopByRunId`) —
 * runId là UUID do caller cấp nên không bao giờ bị trùng thật; cap
 * chỉ chống caller lỗi gửi hàng loạt id lạ làm phình map (entry cũ
 * nhất bị đuổi khi đầy, entry hết hạn 30s bị dọn lúc ghi mới).
 */
const MAX_PENDING_STOP_BY_RUN_ID = 1000;

/**
 * v0.9d: connector definitions for the auto-refresh wiring. Only these
 * three connectors have a TokenSet + tokenUrl, so only they get a
 * ConnectorTokenProvider; anything else falls back to the static token.
 */
const CONNECTOR_DEFS: Record<string, ConnectorDefinition> = {
  slack: SLACK_CONNECTOR,
  gmail: GMAIL_CONNECTOR,
  teams: TEAMS_CONNECTOR,
};

/**
 * v0.8: cap on runs executing at the same time across ALL bots in this
 * coordinator (ROADMAP §2f — "nhiều bot chạy song song không ì ạch").
 * Runs past the cap wait in a FIFO queue; a queued run starts as soon
 * as a slot frees (or the bot's earlier run finishes). The cap never
 * slows a run that is already executing — it only delays the START of
 * runs past the cap. Configurable via `CoordinatorOptions.maxConcurrentRuns`.
 */
export const MAX_CONCURRENT_RUNS = 4;

/**
 * v0.12: ước tính context window (token) của model để compaction biết
 * ngưỡng. Đây là heuristic theo tên model — model lạ thì 128k (mức phổ
 * biến nhất); model local nhỏ (Ollama) mặc định 32k. Chỉ dùng để quyết
 * định KHI compact, không ảnh hưởng tính đúng đắn (compaction luôn giữ
 * system + message gần nhất + bản tóm tắt). Người dùng có thể ghi đè
 * sau qua settings.
 *
 * v0.22: tên model ghi rõ context nhỏ (vd `...-4k`, `ctx4096`,
 * `llama-4096`) thắng mọi nhánh theo họ model — không thì guard
 * small-model trong loop không bao giờ thấy limit ≤ 8k qua đường
 * coordinator (limit từ `compaction` luôn thắng heuristic tên trong
 * loop), và toggle `smallModelGuard` cũng không có tác dụng thực tế.
 *
 * v0.26 (W19a): thêm `measuredLimit` — context thật đo được từ Ollama
 * local (`OllamaProvider.getContextLimit`, vd `qwen2.5:0.5b` đo được
 * 4096 thay vì 32k theo họ qwen). Thứ tự ưu tiên giữ nguyên, chỉ chèn
 * số đo vào giữa tên và họ: tường minh (tên ghi rõ context) > tên
 * model > Ollama đo được > mặc định theo họ. `measuredLimit` chỉ có
 * ý nghĩa khi provider là Ollama; `undefined`/không hợp lệ thì bỏ qua
 * như cũ. Hàm vẫn sync — việc đo (async, best-effort, có cache) do
 * `measuredOllamaContextLimit` làm trước ở `executeRun`.
 */
export function contextLimitForModel(
  providerId: string,
  model: string,
  measuredLimit?: number,
): number {
  const explicit = inferContextLimitFromModelName(model);
  if (explicit !== undefined) return explicit;
  if (typeof measuredLimit === 'number' && Number.isFinite(measuredLimit) && measuredLimit > 0) {
    return measuredLimit;
  }
  const m = `${providerId}/${model}`.toLowerCase();
  if (m.includes('grok-4') || m.includes('grok 4')) return 262_144;
  if (m.includes('gpt-4.1') || m.includes('gpt-5')) return 1_048_576;
  if (m.includes('gpt-4o') || m.includes('gpt-4-turbo')) return 128_000;
  if (m.includes('claude')) return 200_000;
  if (m.includes('gemini-2') || m.includes('gemini-3')) return 1_048_576;
  if (m.includes('gemini')) return 1_048_576;
  if (m.includes('qwen')) return 32_768;
  if (m.includes('llama-3') || m.includes('llama3')) return 131_072;
  if (m.includes('mistral') || m.includes('mixtral')) return 32_768;
  if (m.includes('deepseek')) return 65_536;
  if (m.includes('ollama')) return 32_768;
  return 131_072;
}

/** One run waiting for a free slot in the run queue. */
interface QueuedRun {
  params: RunParams;
  resolve: (result: RunResult) => void;
  reject: (err: Error) => void;
}

/**
 * v0.9a: RunParams as received over RPC, optionally carrying a
 * caller-chosen run id. The id is NOT part of the public RunParams
 * type (callers that do not care get one generated in `run()`), but
 * it travels on the queued params object so `stopRun` can address a
 * run that has not started yet.
 */
type RunParamsWithId = RunParams & { runId?: string };

/** One run executing right now, addressable by run id (v0.9a). */
interface ActiveRun {
  botId: string;
  controller: AbortController;
}

/**
 * Tool-result cache of the coordinator process (v0.4) — the only place
 * tools actually run. TTL 5 minutes, max 200 entries. Only read-only
 * tools are ever cached (see defaultToolFactory below).
 */
const toolResultCache = new ToolResultCache({ defaultTtlMs: 5 * 60 * 1000, maxEntries: 200 });

/** Builds the full tool list for one bot, given its memory + workspace. */
export type ToolFactory = (
  memory: BotMemory,
  workspaceDir: string,
  botId: string,
) => Tool[];

/**
 * Host callbacks the coordinator supplies to the v0.6 tool factories.
 * All are optional: a tool that needs a missing callback fails with a
 * clear error instead of crashing bot creation. Defined structurally
 * here (core must not import types from @open-bot/tools).
 */
export interface ToolFactoryHost {
  /** Create a bot in-process (create_agent tool). */
  createBot?: (config: {
    name?: string;
    providerId?: string;
    model?: string;
    systemPrompt?: string;
    workspaceDir?: string;
    autoApprove?: boolean;
    mode?: string;
  }) => Promise<{ id: string; name: string; providerId: string; model: string }> | { id: string; name: string; providerId: string; model: string };
  /** Send a message to another bot (message_agent tool). '' = queued. */
  sendToAgent?: (botId: string, text: string) => Promise<string>;
  /** Change a bot's working mode (set_agent_mode tool). */
  setBotMode?: (botId: string, mode: AgentMode) => Promise<{ id: string; name: string; providerId: string; model: string }> | { id: string; name: string; providerId: string; model: string };
  /** Ids of all bots this coordinator owns (search/transcript default policy). */
  listBotIds?: () => string[];
  /** Provider id of a bot (default provider for image/video generation). */
  getBotProviderId?: (botId: string) => string | null;
  /** Search every bot's history (search_conversations tool). */
  searchAllHistories?: (query: string) => Array<{ botId: string; role: string; content: string; createdAt?: string }>;
  /** Full transcript of one bot (read_agent_transcript tool). */
  getBotTranscript?: (botId: string, limit?: number) => Array<{ botId: string; role: string; content: string; createdAt?: string }>;
  /** Provider media config for image/video generation (webMedia tools). */
  getProviderConfig?: (providerId: string) => {
    id: string;
    apiKey?: string;
    baseUrl?: string;
    imageModel?: string;
    videoModel?: string;
    videoEndpoint?: string;
  } | null;
  /** X bearer token for x_search (null = labelled web-search fallback). */
  getXBearer?: () => string | null;
  /** v0.7: GitHub token for the git tools (null = API tools explain it). */
  getGitHubToken?: () => string | null;
  /** v0.7: access token for one integration connector (null = not linked). */
  getConnectorToken?: (connectorId: string) => string | null;
  /**
   * v0.9d: auto-refreshing token provider for one integration
   * connector (null = no auto-refresh for it; the connector then
   * falls back to the static token from getConnectorToken).
   */
  getConnectorTokenProvider?: (connectorId: string) => ConnectorTokenProvider | null;
  /** v0.7: MCP OAuth token store (process-wide, keyed by server name). */
  getMcpOAuthStore?: () => McpOAuthStore;
  /** v0.7: OAuth client config for one MCP server (null = not configured). */
  getMcpOAuthConfig?: (serverName: string) => McpOAuthClientConfig | null;
  /**
   * v0.13: ask the user a question from an MCP server
   * (`elicitation/create`). The coordinator emits
   * `mcp.elicitation-needed` to main and waits for `respondElicitation`
   * — the child never shows UI itself.
   */
  askMcpElicitation?: ElicitationPrompt;
  /**
   * v0.18 (W10c follow-up): handler cho `sampling/createMessage` của
   * các MCP server pool (mcp_call_tool / mcp_list_tools) — dùng provider
   * của bot gọi tool. Là callback vì tool factory chạy lúc createBot
   * (bot chưa có trong `this.bots`), còn handler chỉ cần lúc tool chạy
   * (lúc đó bot đã tồn tại); trả null thì client không advertise sampling.
   * v0.23: caller (pool) có thể truyền `callServerTool` — đường gọi tool
   * ngược về chính server đang xin sampling; handler chuyển thẳng vào
   * `createSamplingHandler` (xem `withMcpClient`).
   */
  getSamplingHandler?: (opts?: { callServerTool?: SamplingToolExecutor }) => McpSamplingHandler | null;
  /** v0.7: ask main to open an MCP authorization URL in the browser. */
  openMcpAuthUrl?: (url: string) => void;
  /**
   * v0.70: timeout chờ callback OAuth (giây) cho tool auth per-server
   * (`mcp_authenticate_<server>`). Host cấu hình; không đặt thì 300s
   * (mặc định của `runMcpAuthFlow`, kẹp 1–600s — xem
   * `resolveMcpAuthTimeoutSeconds` trong tools). Tool vẫn nhận
   * `timeoutSeconds` riêng cho từng lần gọi để ghi đè.
   */
  mcpAuthTimeoutSeconds?: number;
  /** v0.7: run a tool of the system MCP server (see callSystemToolFor). */
  callSystemTool?: (toolName: string, args: Record<string, unknown>) => Promise<string>;
  /** v0.7: names of system MCP tools mcp_system_exec may run. */
  getAllowedSystemTools?: () => string[];
  /** v0.14: user skills dir (skill_marketplace_install target). */
  getUserSkillsDir?: () => string | null;
  /**
   * v0.31 (P1-2): path of the trusted-A2A-agents file
   * (<userData>/a2a-trusted-agents.json, shared with the desktop UI).
   * Null = no state dir (embedder): A2A tools fall back to an
   * in-memory store and trust does not persist across restarts.
   */
  getTrustedA2aAgentsFile?: () => string | null;
  /**
   * v0.95 (Team D1): path of the internet-data state file
   * (<userData>/internet-data.json, shared with the desktop UI).
   * Null = no state dir (embedder): internet-data tools fall back
   * to an in-memory store and feeds/watches do not persist.
   */
  getInternetDataFile?: () => string | null;
  /**
   * v0.95 (Team D1): Brave Search API key for `internet_search`
   * source `brave` (null = not configured; the tool then explains
   * how to add the key instead of calling Brave).
   */
  getBraveSearchApiKey?: () => string | null;
  /**
   * v0.95 (Team D1): called once per watch that changed during a
   * `watch_check` (the Coordinator forwards it as an
   * `internet.watch-changed` agent event).
   */
  onWatchChanged?: (event: {
    watch: { id: string; url: string };
    changed: boolean;
    summary: string;
    checkedAt: number;
  }) => void;
  /** v0.14: local-bot capabilities for supervisor routing. */
  listBotCapabilities?: (agentIds?: string[]) => Array<{
    id: string;
    kind: 'local-bot' | 'a2a';
    description: string;
    skills: string[];
    agentCardUrl?: string;
    maxParallel?: number;
  }>;
  /**
   * v0.41 (P0-3, `manage_access`): whether the caller is a team admin.
   * The access tool refuses every mutation when this is absent
   * (fail-closed) — the desktop main is the only side that knows who
   * the current admin user is. Receives the calling bot's ToolContext.
   */
  isTeamAdmin?: (ctx: { botId: string; workspaceDir: string }) => boolean | Promise<boolean>;
  /**
   * v0.41 (P0-3): directory holding team.json for `manage_access`.
   * Null/absent = `<workspaceDir>/.open-bot/team` (the access tool's
   * own default). The desktop main passes its userData dir when it
   * wants the tool to manage the same team.json the admin UI edits.
   */
  getTeamBaseDir?: () => string | null;
  /**
   * v0.95d4: userId ổn định của user hiện tại (đọc từ
   * `<userData>/profile.json` qua dataDir). Memory tools dùng để gắn
   * scope user cho memory. Null/absent = chưa có profile — tool chạy
   * không lọc theo user (giữ hành vi cũ).
   */
  getLocalUserId?: () => string | null;
  /**
   * v0.55: policy egress hiệu lực cho shell tools của bot này, resolve
   * lười mỗi lần tool chạy (coordinator đọc live từ team.json dưới
   * dataDir + policy chung — sửa team là có hiệu lực ngay, không cần
   * tạo lại bot). Trả `undefined` = không có policy nào → shell
   * fail-closed (`egress_unconfigured`); `null` = tắt hẳn (chỉ cho
   * test/caller cũ). Xem `AgentCoordinator.resolveBotEgressPolicy`.
   */
  getEgressPolicy?: () => EgressPolicy | null | undefined;
  /**
   * v0.58: meta-tool Composio runnable cho bot này ([] = Composio đang
   * tắt trong tiến trình coordinator → `defaultToolFactory` không
   * đăng ký tool nào). Coordinator tiêm callback này trỏ về session
   * manager dùng chung; host khác (test/embedder) không tiêm thì bot
   * không có tool Composio. Khi bật, cap M7 + filterTools áp dụng ở
   * loop như tool local — callback này chỉ quyết định có mặt hay không.
   */
  getComposioTools?: () => Tool[];
}

/**
 * v0.53 (P1-7): structural shape of the tools package's
 * `ToolCallHistoryStore` — the replay triple (`tool_call_id` /
 * `tool_name` / `args_json`) plus timings. Core must not import
 * tools statically, so the coordinator only relies on this shape.
 */
export interface ToolCallHistoryLike {
  record(record: {
    tool_call_id: string;
    tool_name: string;
    args_json: string;
    started_at_ms?: number;
    completed_at_ms?: number;
    status?: 'ok' | 'error' | 'denied';
    result_preview?: string;
  }): void;
  findById(toolCallId: string): {
    tool_call_id: string;
    tool_name: string;
    args_json: string;
  } | null;
}

/**
 * Default factory: the same five tool groups the desktop main wires into
 * every runner, plus the v0.6 groups (shell sessions, local tools,
 * computer-use, web & media, canvas, agent-to-agent). Loaded lazily so
 * this module has no static dependency on @open-bot/tools (see header note).
 */
export function defaultToolFactory(
  memory: BotMemory,
  workspaceDir: string,
  botId: string,
  getDaemon?: () => ShellDaemonLike | null,
  host?: ToolFactoryHost,
): Tool[] {
  let toolsMod: {
    ToolRegistry: new (opts?: {
      cache?: unknown;
      cacheableTools?: string[];
    }) => {
      registerMany(tools: Tool[]): void;
      list(): Tool[];
    };
    createDefaultTools(opts?: {
      getDaemon?: () => ShellDaemonLike | null;
      /** v0.55: resolver policy egress hiệu lực (team + global). */
      getEgressPolicy?: () => EgressPolicy | null | undefined;
      /** v0.95 (Team D1): internet-data state file resolver. */
      getInternetDataFile?: () => string | null | undefined;
      /** v0.95 (Team D1): opt-in Brave Search API key resolver. */
      getBraveSearchApiKey?: () => string | null;
      /** v0.95 (Team D1): called once per watch that changed. */
      onWatchChanged?: (event: {
        watch: { id: string; url: string };
        changed: boolean;
        summary: string;
        checkedAt: number;
      }) => void;
    }): Tool[];
    CODE_TOOLS: Tool[];
    /** v0.96 (Đội T2): repo map — `repo_map`, `repo_map_query`. */
    REPO_MAP_TOOLS: Tool[];
    /** v0.96 (Đội T2): section repo map chèn vào system prompt của turn. */
    buildRepoMapSection?: (
      rootDir: string,
      options?: {
        enabled?: boolean;
        tokenBudget?: number;
        chatFiles?: string[];
        mentionedIdents?: string[];
        userText?: string;
      },
    ) => Promise<string>;
    createPlanTools(memory: BotMemory): Tool[];
    createSubagentTools(opts: {
      getTaskStatus(taskId: string): string | null;
    }): Tool[];
    /** v1.01 (Team T6): nested subagent tools (list_subagent_tree, fanout_tasks). */
    createNestedSubagentTools(): Tool[];
    createMcpTools(
      workspaceDir: string,
      opts?: {
        oauthStore?: McpOAuthStore;
        getOAuthConfig?: (
          serverName: string,
        ) => McpOAuthClientConfig | null | Promise<McpOAuthClientConfig | null>;
        fetchFn?: typeof fetch;
        /** v0.13: prompt the user for `elicitation/create` (see ToolFactoryHost.askMcpElicitation). */
        elicitationPrompt?: ElicitationPrompt;
        /** v0.69d: mở URL authorize trong trình duyệt (nối tiếp `ToolFactoryHost.openMcpAuthUrl` — trước đây chỉ `createMcpSystemTools` nhận nên tool `mcp_authenticate_<server>` phải fallback trả URL dạng text cho user tự mở). */
        openUrl?: (url: string) => void | Promise<void>;
        /** v0.70: timeout chờ callback OAuth mặc định (giây) cho tool `mcp_authenticate_<server>` (nối tiếp `ToolFactoryHost.mcpAuthTimeoutSeconds`). */
        authTimeoutSeconds?: number;
        /** v0.18: handler cho `sampling/createMessage` (see ToolFactoryHost.getSamplingHandler). v0.23: nhận `callServerTool` của pool để nối vào handler. */
        getSamplingHandler?: (opts?: { callServerTool?: SamplingToolExecutor }) => McpSamplingHandler | null;
      },
    ): Tool[];
    createShellTools(opts?: {
      getDaemon?: () => ShellDaemonLike | null;
      /** v0.55: resolver policy egress hiệu lực (team + global). */
      getEgressPolicy?: () => EgressPolicy | null | undefined;
    }): Tool[];
    createLocalTools(opts?: { getDaemon?: () => ShellDaemonLike | null }): Tool[];
    createComputerUseTools(opts?: Record<string, unknown>): Tool[];
    createBrowserTools(opts?: Record<string, unknown>): Tool[];
    /** v0.97 (Team T6): git workflow tools (git_log / git_branch /
     * git_branch_create / git_branch_delete / git_show). git_blame already
     * lives in CODE_TOOLS (extended with a line range in v0.97).
     * Optional until the tools package ships the factory — guarded at
     * the call site, like createMemoryBlockTools. */
    createGitWorkflowTools?(): Tool[];
    /** v0.97 (Team T6): deep file search (search_files_deep). Optional
     * until the tools package ships the factory — guarded at the call
     * site, like createMemoryBlockTools. */
    createFileSearchTools?(): Tool[];
    createWebMediaTools(opts?: {
      getXBearer?: () => string | null;
      getProviderConfig?: (providerId: string) => {
        id: string;
        apiKey?: string;
        baseUrl?: string;
        imageModel?: string;
        videoModel?: string;
        videoEndpoint?: string;
      } | null;
      defaultProviderId?: string;
    }): Tool[];
    createCanvasTools(): Tool[];
    createAgentTools(opts?: {
      memory?: BotMemory;
      createBot?: ToolFactoryHost['createBot'];
      sendToAgent?: ToolFactoryHost['sendToAgent'];
      setBotMode?: ToolFactoryHost['setBotMode'];
      listBotIds?: ToolFactoryHost['listBotIds'];
      searchAllHistories?: ToolFactoryHost['searchAllHistories'];
      getBotTranscript?: ToolFactoryHost['getBotTranscript'];
      /** v0.14: local-bot capabilities for supervisor_dispatch. */
      listBotCapabilities?: ToolFactoryHost['listBotCapabilities'];
    }): Tool[];
    /** v0.95d4: long-term memory tools (memory_save/search/list/delete).
     * Optional until the tools package ships the factory — guarded at
     * the call site, like createA2aTools. */
    createMemoryTools?(opts?: {
      store?: LongTermMemory;
      embedder?: OllamaEmbeddings;
      getUserId?: () => string | undefined;
    }): Tool[];
    /** v0.97 (Đội T1): MCP 2.0 tools (mcp2_discover_server, mcp2_call_tool_mrtr,
     * mcp2_task_poll/cancel, mcp2_scan_tool_descriptions, mcp2_validate_app).
     * Optional until the tools package ships the factory — guarded at
     * the call site, like createMemoryBlockTools. */
    createMcpV097Tools?(): Tool[];
    createMemoryBlockTools?(opts?: {
      blocksStore?: MemoryBlockStore;
      longTermStore?: LongTermMemory;
      getUserId?: () => string | undefined;
    }): Tool[];
    /** v0.97 (Team T4): memory v2 tools (sleep agent + temporal graph
     * + hybrid search + provenance). Optional until the tools package
     * ships the factory — guarded at the call site, like
     * createMemoryBlockTools. */
    createMemoryV2Tools?(opts?: {
      workspaceDir?: string;
      blocksStore?: MemoryBlockStore;
      longTermStore?: LongTermMemory;
      graph?: TemporalKnowledgeGraph;
      sleepAgent?: SleepTimeAgent;
      embedder?: OllamaEmbeddings;
      getUserId?: () => string | undefined;
      getProviderId?: () => string | undefined;
      getProviderKind?: () => string | undefined;
    }): Tool[];
    /** v0.98 (Đội T1): memory graph tools (memory_graph_ingest/search/
     * list/history/stats/consolidate/quarantine/share/delete).
     * Optional until the tools package ships the factory — guarded at
     * the call site, like createMemoryBlockTools. */
    createMemoryGraphTools?(opts?: {
      graphStore?: TemporalGraphStore;
      workspaceDir?: string;
      sleepAgent?: SleepConsolidationAgent;
      getUserId?: () => string | undefined;
    }): Tool[];
    /** v1.01 (Đội T5): evolving notes tools (notes_create/update/search/
     * list/get/link/suggest_links/graph/revisit/conflicts/benchmark_run/
     * import). Optional until the tools package ships the factory —
     * guarded at the call site, like createMemoryGraphTools. */
    createMemoryNotesTools?(opts?: {
      notesStore?: EvolvingNoteStore;
      longTermStore?: LongTermMemory;
      graphStore?: TemporalGraphStore;
      getUserId?: () => string | undefined;
    }): Tool[];
    /** v1.02 (Đội T2): memory v3 tools (memory_v3_fused_search /
     * one_pass_ingest / temporal_query / contradictions /
     * entity_timeline / sleep_maintenance + memory_block_history /
     * restore / conflicts). Optional until the tools package ships
     * the factory — guarded at the call site, like
     * createMemoryGraphTools. */
    createMemoryV3Tools?(opts?: {
      graphStore?: TemporalGraphStore;
      workspaceDir?: string;
      blocksStore?: MemoryBlockStore;
      embedder?: OllamaEmbeddings;
      getUserId?: () => string | undefined;
      appId?: string;
    }): Tool[];
    /** v0.31 (P1-2): A2A client tools (call trusted external agents).
     * Optional until the tools package ships the factory — guarded at
     * the call site, like createSkillMarketplaceTools. */
    createA2aTools?(opts?: {
      trustedAgentsFile?: string;
      timeoutMs?: number;
    }): Tool[];
    /** v0.14: skill marketplace tools (preview/install). Optional until
     *  the tools package ships the factory — guarded at the call site. */
    createSkillMarketplaceTools?(opts?: {
      getSkillsDir?: () => string | null;
    }): Tool[];
    /** v0.41 (P0-3): access-management tool (manage_access). Optional
     *  until the tools package ships the factory — guarded at the call
     *  site, like createSkillMarketplaceTools. */
    createAccessTools?(opts?: {
      teamBaseDir?: string;
      isAdmin?: (ctx: { botId: string; workspaceDir: string }) => boolean | Promise<boolean>;
    }): Tool[];
    createGitTools(opts?: {
      getGitHubToken?: () => string | null;
      workspaceDir?: string;
    }): Tool[];
    createCiTools(opts?: { workspaceDir?: string }): Tool[];
    /**
     * v0.97 (Team T5): harness v2 read-only tools (health check,
     * routine list, webhook status). Optional until the tools
     * package ships the factory — guarded at the call site.
     */
    createHarnessV2Tools?(opts?: { stateDir?: string }): Tool[];
    /**
     * v0.53 (P1-7): tool-call history store (file-backed, same
     * workspace) for `tool_call_replay`. Optional until the tools
     * package ships the class — guarded at the call site.
     */
    ToolCallHistoryStore?: new (workspaceDir: string) => ToolCallHistoryLike;
    /**
     * v0.53 (P1-7): computer-local bridge (`computer_local_tool`).
     * Optional until the tools package ships the factory — guarded
     * at the call site, like createAccessTools.
     */
    createLocalBridgeTools?(opts?: {
      getDaemon?: () => ShellDaemonLike | null;
      workspaceDir?: string;
    }): Tool[];
    createAgentDataTools(opts?: {
      memory?: BotMemory;
      workspaceDir?: string;
      /** v0.53 (P1-7): history store for `tool_call_replay`. */
      history?: ToolCallHistoryLike;
      /** v0.53 (P1-7): live registry for replay dispatch. */
      getTools?: () => Tool[];
    }): Tool[];
    createIntegrationTools(opts?: {
      getConnectorToken?: (connectorId: string) => string | null;
      getConnectorTokenProvider?: (
        connectorId: string,
      ) => ConnectorTokenProvider | null;
      /** v0.68b: GitHub PAT (host đọc Vault `github` / `token`). */
      getGitHubToken?: () => string | null;
      memory?: BotMemory;
      workspaceDir?: string;
    }): Tool[];
    createMcpSystemTools(opts?: {
      oauthStore?: {
        get(key: string): string | null | Promise<string | null>;
        set(key: string, value: string): void | Promise<void>;
        delete(key: string): boolean | void | Promise<boolean | void>;
      };
      getOAuthConfig?: (
        serverName: string,
      ) => {
        authorizationEndpoint: string;
        tokenEndpoint: string;
        clientId: string;
        clientSecret?: string;
        scope?: string;
      } | null | Promise<{
        authorizationEndpoint: string;
        tokenEndpoint: string;
        clientId: string;
        clientSecret?: string;
        scope?: string;
      } | null>;
      openUrl?: (url: string) => void | Promise<void>;
      callSystemTool?: (toolName: string, args: Record<string, unknown>) => Promise<string>;
      allowedSystemTools?: string[];
      workspaceDir?: string;
    }): Tool[];
  };
  try {
    // Dynamic require on purpose (see header). `require` is the CJS
    // require of this compiled module.
    toolsMod = require('@open-bot/tools') as typeof toolsMod;
  } catch (err) {
    throw new Error(
      `Không tải được @open-bot/tools để dựng registry: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const registry = new toolsMod.ToolRegistry({
      cache: toolResultCache,
      cacheableTools: [...SUGGESTED_CACHEABLE_TOOLS],
    });
    registry.registerMany(
      toolsMod.createDefaultTools({
        getDaemon,
        // v0.55: shell_exec tự resolve policy egress của team hiện tại.
        getEgressPolicy: host?.getEgressPolicy,
        // v0.95 (Team D1): internet-data tools are already in
        // ALL_TOOLS; these opts only BIND the placeholders (state
        // file <userData>/internet-data.json, opt-in Brave key,
        // watch-change callback) — never a second registration
        // (duplicate names throw in ToolRegistry).
        getInternetDataFile: host?.getInternetDataFile,
        getBraveSearchApiKey: host?.getBraveSearchApiKey,
        onWatchChanged: host?.onWatchChanged,
      }),
    );
    registry.registerMany(toolsMod.CODE_TOOLS);
    // v0.96 (Đội T2): repo map — `repo_map`, `repo_map_query` (read-only).
    registry.registerMany(toolsMod.REPO_MAP_TOOLS);
    registry.registerMany(toolsMod.createPlanTools(memory));
    registry.registerMany(
      toolsMod.createSubagentTools({
        getTaskStatus: (taskId: string) => {
          try {
            return memory.listTasks(botId).find((t) => t.id === taskId)?.status ?? null;
          } catch {
            return null;
          }
        },
      }),
    );
    // v1.01 (Team T6): nested subagent + fan-out tools (list_subagent_tree,
    // fanout_tasks) — nối ctx.subagentTree / ctx.runFanOutWithGrading của loop.
    registry.registerMany(toolsMod.createNestedSubagentTools());
    registry.registerMany(
      toolsMod.createMcpTools(workspaceDir, {
        oauthStore: host?.getMcpOAuthStore?.(),
        getOAuthConfig: host?.getMcpOAuthConfig,
        elicitationPrompt: host?.askMcpElicitation,
        getSamplingHandler: host?.getSamplingHandler,
        // v0.69d: nối openUrl cho tool `mcp_authenticate_<server>` (gap v0.42).
        openUrl: host?.openMcpAuthUrl,
        // v0.70: nối timeout chờ callback OAuth mặc định cho tool đó.
        authTimeoutSeconds: host?.mcpAuthTimeoutSeconds,
      }),
    );
    // v0.6: shell sessions + local machine tools (daemon-backed when present).
    // v0.55: exec_task / shell sessions tự resolve policy egress của team.
    registry.registerMany(
      toolsMod.createShellTools({ getDaemon, getEgressPolicy: host?.getEgressPolicy }),
    );
    registry.registerMany(toolsMod.createLocalTools({ getDaemon }));
    // v0.6: computer-use (screenshot / screen record / mouse / keyboard).
    registry.registerMany(toolsMod.createComputerUseTools());
    // v0.86a (P1-3): Playwright browser automation (navigate / click /
    // type / screenshot / extract) — the web counterpart to computer-use.
    // v0.97 (Team T6): + browser_status / browser_reload /
    // browser_wait_for (state + wait verbs, same session).
    registry.registerMany(toolsMod.createBrowserTools());
    // v0.97 (Team T6): git workflow (log / branch / show / blame) +
    // deep file search — sandboxed to the workspace, no network.
    // Guarded like the memory/A2A factories: without the factory the
    // bot just has no such tools instead of failing to build.
    if (typeof toolsMod.createGitWorkflowTools === 'function') {
      registry.registerMany(toolsMod.createGitWorkflowTools());
    }
    if (typeof toolsMod.createFileSearchTools === 'function') {
      registry.registerMany(toolsMod.createFileSearchTools());
    }
    // v0.6: web & media (X search, image/video generation) + canvas docs.
    registry.registerMany(
      toolsMod.createWebMediaTools({
        getXBearer: host?.getXBearer,
        getProviderConfig: host?.getProviderConfig,
        defaultProviderId: host?.getBotProviderId?.(botId) ?? undefined,
      }),
    );
    registry.registerMany(toolsMod.createCanvasTools());
    // v0.6: agent-to-agent (create/message/mode/reflect/search/transcript/grind).
    registry.registerMany(
      toolsMod.createAgentTools({
        memory,
        createBot: host?.createBot,
        sendToAgent: host?.sendToAgent,
        setBotMode: host?.setBotMode,
        listBotIds: host?.listBotIds,
        searchAllHistories: host?.searchAllHistories,
        getBotTranscript: host?.getBotTranscript,
        listBotCapabilities: host?.listBotCapabilities,
      }),
    );
    // v0.95d4 (Đội D4): long-term memory tools (memory_save/search/
    // list/delete) trên cùng store JSON với turn-context recall
    // (`.open-bot/memories.json` trong workspace của bot). Embedder
    // Ollama local dùng chung (một instance cho mọi bot — client
    // không giữ state). Guarded — thiếu factory thì bot chỉ không có
    // memory tools, không fail khi tạo bot.
    if (typeof toolsMod.createMemoryTools === 'function') {
      registry.registerMany(
        toolsMod.createMemoryTools({
          store: new LongTermMemory(workspaceDir),
          embedder: new OllamaEmbeddings(),
          getUserId: () => host?.getLocalUserId?.() ?? undefined,
        }),
      );
    }
    // v0.97 (Đội T1): MCP 2.0 tools (mcp2_discover_server, mcp2_call_tool_mrtr,
    // mcp2_task_poll/cancel, mcp2_scan_tool_descriptions, mcp2_validate_app).
    // Guarded — thiếu factory thì bot chỉ không có tool MCP 2.0, không fail.
    if (typeof toolsMod.createMcpV097Tools === 'function') {
      registry.registerMany(toolsMod.createMcpV097Tools());
    }
    // v0.96 (Đội T1): memory block tools (memory_block_* + memory_
    // consolidate) trên cùng workspace với long-term memory
    // (`.open-bot/memory-blocks.json`). Guarded — thiếu factory thì bot
    // chỉ không có block tools, không fail khi tạo bot.
    if (typeof toolsMod.createMemoryBlockTools === 'function') {
      registry.registerMany(
        toolsMod.createMemoryBlockTools({
          blocksStore: new MemoryBlockStore(workspaceDir),
          longTermStore: new LongTermMemory(workspaceDir),
          getUserId: () => host?.getLocalUserId?.() ?? undefined,
        }),
      );
    }
    // v0.97 (Team T4): memory v2 tools (sleep agent + temporal graph +
    // hybrid search + provenance) on the same workspace. Guarded —
    // without the factory the bot just has no memory-v2 tools.
    // Sleep runs are refused for mock/CLI bots inside the tool itself.
    if (typeof toolsMod.createMemoryV2Tools === 'function') {
      const providerId = host?.getBotProviderId?.(botId) ?? undefined;
      const providerKind = providerId ? PROVIDERS.find((p) => p.id === providerId)?.kind : undefined;
      registry.registerMany(
        toolsMod.createMemoryV2Tools({
          workspaceDir,
          blocksStore: new MemoryBlockStore(workspaceDir),
          longTermStore: new LongTermMemory(workspaceDir),
          graph: new TemporalKnowledgeGraph(workspaceDir),
          sleepAgent: new SleepTimeAgent(workspaceDir, botId),
          embedder: new OllamaEmbeddings(),
          getUserId: () => host?.getLocalUserId?.() ?? undefined,
          getProviderId: () => providerId,
          getProviderKind: () => providerKind,
        }),
      );
    }
    // v0.98 (Đội T1): memory graph tools (memory_graph_*) trên temporal
    // graph store (`.open-bot/memory-graph.json`). Sleep agent của bot
    // này được truyền vào để tool memory_graph_consolidate chạy tay
    // được; ingest/search/list chạy trên cùng store với hook setup-turn
    // bên dưới. Guarded như các factory khác.
    if (typeof toolsMod.createMemoryGraphTools === 'function') {
      const graphSleepAgent = createGraphSleepAgent(
        workspaceDir,
        botId,
        host?.getLocalUserId?.() ?? undefined,
      );
      registry.registerMany(
        toolsMod.createMemoryGraphTools({
          graphStore: TemporalGraphStore.fromWorkspace(workspaceDir),
          workspaceDir,
          sleepAgent: graphSleepAgent,
          getUserId: () => host?.getLocalUserId?.() ?? undefined,
        }),
      );
    }
    // v1.01 (Đội T5): evolving notes tools (notes_*) trên cùng workspace
    // (`.open-bot/memory-notes.json`). Benchmark tool chạy trên store
    // in-memory riêng, không đụng kho note thật. Guarded như factory khác.
    if (typeof toolsMod.createMemoryNotesTools === 'function') {
      registry.registerMany(
        toolsMod.createMemoryNotesTools({
          notesStore: EvolvingNoteStore.fromWorkspace(workspaceDir),
          longTermStore: new LongTermMemory(workspaceDir),
          graphStore: TemporalGraphStore.fromWorkspace(workspaceDir),
          getUserId: () => host?.getLocalUserId?.() ?? undefined,
        }),
      );
    }
    // v1.02 (Đội T2): memory v3 tools (memory_v3_* + memory_block_*)
    // trên cùng store đồ thị và block store với các factory memory
    // khác. Guarded như factory khác.
    if (typeof toolsMod.createMemoryV3Tools === 'function') {
      registry.registerMany(
        toolsMod.createMemoryV3Tools({
          graphStore: TemporalGraphStore.fromWorkspace(workspaceDir),
          workspaceDir,
          blocksStore: new MemoryBlockStore(workspaceDir),
          embedder: new OllamaEmbeddings(),
          getUserId: () => host?.getLocalUserId?.() ?? undefined,
        }),
      );
    }
    // v0.31 (P1-2): A2A client tools (call trusted external agents).
    // Guarded — the factory ships with the tools package; without it
    // the bot just has no A2A tools instead of failing to build. The
    // trusted-agents file is the same one the desktop UI uses
    // (<userData>/a2a-trusted-agents.json); without a state dir the
    // tools fall back to an in-memory store (no persistence).
    if (typeof toolsMod.createA2aTools === 'function') {
      registry.registerMany(
        toolsMod.createA2aTools({
          trustedAgentsFile: host?.getTrustedA2aAgentsFile?.() ?? undefined,
        }),
      );
    }
    // v0.68b: git/PR (8 tool) KHÔNG đăng ký riêng nữa — 7 tool API
    // GitHub + set_active_branch đã nằm trong createIntegrationTools
    // (integrationTools.ts gom createGitTools) để M7 app 'github'
    // sở hữu chúng qua catalog; đăng ký riêng ở đây sẽ trùng tên và
    // ToolRegistry ném lỗi. Token PAT đi qua getGitHubToken như cũ.
    // v0.7: CI/bug triage + agent data export/import.
    registry.registerMany(toolsMod.createCiTools({ workspaceDir }));
    // v0.97 (Team T5): harness v2 read-only tools (health check,
    // routine list, webhook status) — no approval, no secrets.
    if (typeof toolsMod.createHarnessV2Tools === 'function') {
      registry.registerMany(toolsMod.createHarnessV2Tools({}));
    }
    // v0.53 (P1-7): replay needs the history store (same workspace
    // file the loop recorder writes) + the live registry to dispatch
    // into. The store class is guarded — without it the tool still
    // registers, but replay refuses (no history to read from).
    registry.registerMany(
      toolsMod.createAgentDataTools({
        memory,
        workspaceDir,
        ...(typeof toolsMod.ToolCallHistoryStore === 'function'
          ? { history: new toolsMod.ToolCallHistoryStore(workspaceDir) }
          : {}),
        getTools: () => registry.list(),
      }),
    );
    // v0.7: third-party integrations (Slack / Gmail / Teams / iMessage /
    // meeting notes) + session box + long-term memory + transcript archive.
    // v0.68b: + 8 tool git (7 API GitHub của M7 app 'github' +
    // set_active_branch local) — token PAT qua host.getGitHubToken.
    // v0.9d: the auto-refreshing token provider rides alongside the
    // static token callback — connector calls refresh proactively and
    // retry a GET once after 401; without a provider they behave as before.
    registry.registerMany(
      toolsMod.createIntegrationTools({
        getConnectorToken: host?.getConnectorToken,
        getConnectorTokenProvider: host?.getConnectorTokenProvider,
        getGitHubToken: host?.getGitHubToken,
        memory,
        workspaceDir,
      }),
    );
    // v0.7: MCP OAuth (mcp_auth / mcp_auth_status) + system MCP exec.
    // v0.13: + mcp_revoke (RFC 7009).
    registry.registerMany(
      toolsMod.createMcpSystemTools({
        oauthStore: host?.getMcpOAuthStore?.(),
        getOAuthConfig: host?.getMcpOAuthConfig,
        openUrl: host?.openMcpAuthUrl,
        callSystemTool: host?.callSystemTool,
        allowedSystemTools: host?.getAllowedSystemTools?.() ?? [],
        workspaceDir,
      }),
    );
    // v0.14: skill marketplace (preview/install from URL/git). Guarded —
    // the factory ships with the tools package; without it the bot just
    // has no marketplace tools instead of failing to build.
    if (typeof toolsMod.createSkillMarketplaceTools === 'function') {
      registry.registerMany(
        toolsMod.createSkillMarketplaceTools({
          getSkillsDir: host?.getUserSkillsDir,
        }),
      );
    }
    // v0.41 (P0-3): access management (manage_access). Guarded like
    // the marketplace tools above. v0.85 (P1-7): the desktop main now
    // wires the admin check — `runCoordinatorStdio` passes
    // `isTeamAdmin` (role of the local user in team.json, read live)
    // + `getTeamBaseDir` (userData) into the coordinator, and
    // `buildToolHost` forwards them here, so admin mutations work
    // and non-admin mutations are still refused fail-closed.
    if (typeof toolsMod.createAccessTools === 'function') {
      registry.registerMany(
        toolsMod.createAccessTools({
          teamBaseDir: host?.getTeamBaseDir?.() ?? undefined,
          isAdmin: host?.isTeamAdmin,
        }),
      );
    }
    // v0.58 (Composio execution path): meta-tool Composio chỉ xuất
    // hiện khi Composio đang BẬT trong tiến trình coordinator (host
    // tiêm `getComposioTools` trỏ về session manager dùng chung; tắt
    // thì callback trả [] → không đăng ký tool nào, bot chạy như cũ).
    // Khi bật, tool đi qua cap M7 + `filterTools` ở loop như tool
    // local (app 'composio' trong AppRegistry) — factory này không tự
    // cắt/lọc gì thêm. Tool lấy từ host mỗi lần dựng bot nên toggle
    // qua RPC `composio.setState` có hiệu lực với bot tạo sau; bot đã
    // tạo được coordinator rebuild (xem `rebuildComposioTools`).
    const composioTools = host?.getComposioTools?.() ?? [];
    if (composioTools.length > 0) {
      registry.registerMany(composioTools);
    }
    // v0.53 (P1-7): computer-local bridge (`computer_local_tool` —
    // GrokBotUserComputerLocalToolCall shape: tool_id / input_json /
    // approval_id / conversation_id / image_uploads, allowlist-checked
    // by the daemon's phone-tool allowlist). Guarded like the access
    // tools above; without a daemon, run-command/send-input answer
    // "daemon unavailable" fail-closed.
    if (typeof toolsMod.createLocalBridgeTools === 'function') {
      registry.registerMany(
        toolsMod.createLocalBridgeTools({ getDaemon, workspaceDir }),
      );
    }
    // v0.4: AgentRunner calls tool.execute() directly, never
    // registry.execute() — so cache by wrapping execute() of read-only
    // tools here (loop.ts is untouched). Only successful runs are cached;
    // a throwing tool never writes to the cache.
    for (const tool of registry.list()) {
      if (!SUGGESTED_CACHEABLE_TOOLS.includes(tool.definition.name)) continue;
      const originalExecute = tool.execute.bind(tool);
      tool.execute = async (args, ctx) => {
        const cached = toolResultCache.get(tool.definition.name, args);
        if (cached !== undefined) return cached;
        const output = await originalExecute(args, ctx);
        toolResultCache.set(tool.definition.name, args, output);
        return output;
      };
    }
    return registry.list();
  } catch (err) {
    throw new Error(
      `Không dựng được tool registry: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Structural view of @open-bot/tools PluginManager (dynamic require, same
 * pattern as defaultToolFactory — the manager's methods are called
 * through this shape so coordinator.ts never statically imports tools).
 */
interface PluginManagerLike {
  scanDir(pluginsDir?: string, opts?: { excludeIds?: string[] }): void;
  scanDirSandboxed(pluginsDir?: string, opts?: { excludeIds?: string[] }): Promise<void>;
  loadErrors(): Array<{ dir: string; error: Error }>;
  toolsForRegistry(): Tool[];
  listBundleParts(): BundlePartsView[];
  enable(id: string): boolean;
  disable(id: string): boolean;
  disposeSandboxed(id?: string): Promise<void>;
}

/**
 * v0.93a: read the marketplace installed records WITHOUT failing the
 * caller — any problem (no tools module, old tools without the
 * function, corrupt records file) yields `{}`. The caller then falls
 * back to the pre-v0.93a behaviour (generic scan loads everything);
 * that is the same fail-open the corrupt-records test pins down
 * (v0.92a: a corrupt records file must never block bot start), and
 * the plugin still runs sandboxed — only the signature gate is
 * skipped, because without readable records there is nothing to
 * gate on.
 */
function readMarketplaceInstalledRecordsSafe(
  pluginsDir: string,
): Record<string, { sandboxed?: boolean }> {
  try {
    const marketplaceMod = require('@open-bot/tools') as {
      listMarketplaceInstalledRecords?: (
        dir: string,
      ) => Record<string, { sandboxed?: boolean }>;
    };
    if (typeof marketplaceMod.listMarketplaceInstalledRecords !== 'function') return {};
    return marketplaceMod.listMarketplaceInstalledRecords(pluginsDir) ?? {};
  } catch {
    return {};
  }
}

/** Minimal structural view of a resolved plugin bundle (see tools/bundle.ts). */
interface BundlePartsView {
  manifest: { id: string };
  /** Absolute bundle directory (owner of the hook script files). */
  dir: string;
  skill?: {
    kind: 'directory' | 'inline';
    name: string;
    dir?: string;
    description?: string;
    instructions?: string;
    allowedTools?: string[];
  };
  subagent?: SpecializedSubagentSpec;
  /** Bundle hooks (resolved: `script` is an absolute path when present). */
  hooks?: Array<{
    name: string;
    event: HookEventKind;
    script?: string;
    matcher?: { tool?: string; pattern?: string };
  }>;
  mcpServer?: { name: string; config: McpServerConfig };
  slashCommands: Array<{ name: string; description: string; file: string }>;
}

/** One cached PluginManager per plugins dir (v0.14): sandboxed hosts stay
 *  alive across bots so a toggle / second bot does not re-fork children.
 *  In-process plugins are still re-scanned per createBot (cheap, sync);
 *  sandboxed plugins are scanned once per manager — the manager skips
 *  already-running hosts on rescan (see manager.loadSandboxed). */
const pluginManagers = new Map<string, PluginManagerLike>();

function getPluginManager(pluginsDir: string): PluginManagerLike {
  const cached = pluginManagers.get(pluginsDir);
  if (cached) return cached;
  const toolsMod = require('@open-bot/tools') as {
    PluginManager: new (pluginsDir: string) => PluginManagerLike;
  };
  const manager = new toolsMod.PluginManager(pluginsDir);
  pluginManagers.set(pluginsDir, manager);
  return manager;
}

/** Dispose every cached plugin manager's sandbox hosts (coordinator shutdown). */
export async function disposePluginManagers(): Promise<void> {
  const managers = [...pluginManagers.values()];
  pluginManagers.clear();
  await Promise.all(managers.map((m) => m.disposeSandboxed().catch(() => undefined)));
}

/**
 * Load enabled plugin tools from a plugins dir, in-process in the child.
 * Plugin tools are functions — they cannot cross the RPC boundary, so the
 * child loads them itself (dynamic require of @open-bot/tools, same
 * pattern as defaultToolFactory). A bad plugin dir or a bad plugin never
 * breaks bot creation: it is logged to stderr and contributes no tools.
 */
export function loadPluginTools(pluginsDir: string): Tool[] {
  try {
    const manager = getPluginManager(pluginsDir);
    try {
      manager.scanDir();
    } catch (err) {
      process.stderr.write(
        `[coordinator] Không quét được thư mục plugin: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return [];
    }
    for (const failure of manager.loadErrors()) {
      process.stderr.write(
        `[coordinator] Plugin lỗi, bỏ qua: ${failure.dir}: ${failure.error.message}\n`,
      );
    }
    return manager.toolsForRegistry();
  } catch (err) {
    process.stderr.write(
      `[coordinator] Không tải được PluginManager: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return [];
  }
}

/**
 * v0.14: load plugins for a bot — sandboxed by default (each plugin in
 * its own forked child; a hanging/crashing plugin cannot take down this
 * coordinator), in-process when `sandboxed` is false. Returns the tools
 * PLUS the resolved bundle parts (skill dirs / subagents / MCP servers /
 * slash commands) for the caller to wire. Never throws: on any failure
 * it logs to stderr and returns what it could load (possibly nothing).
 *
 * v0.92a: after the generic scan, the marketplace sandbox policy is
 * enforced (see `loadMarketplacePluginsAtStartup`): a plugin installed
 * via the plugin marketplace is recorded `sandboxed: true` and must
 * run out-of-process even when the caller asked for in-process loading
 * (`sandboxed: false`, legacy). With no marketplace plugin installed
 * the extra step is a single missing-file check — bot start is not
 * measurably slower.
 *
 * v0.93a: the generic scan EXCLUDES recorded marketplace plugins
 * (see `readMarketplaceInstalledRecordsSafe`): they are loaded ONLY
 * by `loadMarketplacePluginsAtStartup`, AFTER their bundle signature
 * is verified — verifying after the generic scan would be theatre,
 * the code would already have run in a sandbox worker. When the
 * records file is unreadable the exclusion is empty (fail-open, same
 * as v0.92a: a corrupt records file never blocks bot start) and the
 * generic scan loads everything, sandboxed as before.
 */
export async function loadPlugins(
  pluginsDir: string,
  opts: { sandboxed?: boolean } = {},
): Promise<{ tools: Tool[]; bundleParts: BundlePartsView[] }> {
  const sandboxed = opts.sandboxed !== false;
  try {
    const manager = getPluginManager(pluginsDir);
    // v0.93a: marketplace plugins are NOT loaded by the generic scan —
    // they go through signature verification first (see header).
    const marketplaceRecords = readMarketplaceInstalledRecordsSafe(pluginsDir);
    const excludeIds = Object.entries(marketplaceRecords)
      .filter(([, record]) => record?.sandboxed === true)
      .map(([id]) => id);
    const scanOpts = excludeIds.length > 0 ? { excludeIds } : undefined;
    try {
      if (sandboxed) await manager.scanDirSandboxed(undefined, scanOpts);
      else manager.scanDir(undefined, scanOpts);
    } catch (err) {
      process.stderr.write(
        `[coordinator] Không quét được thư mục plugin: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return { tools: [], bundleParts: [] };
    }
    for (const failure of manager.loadErrors()) {
      process.stderr.write(
        `[coordinator] Plugin lỗi, bỏ qua: ${failure.dir}: ${failure.error.message}\n`,
      );
    }
    // v0.92a: enforce the marketplace sandbox policy (never throws —
    // a bad record file or a broken marketplace plugin is logged and
    // skipped; the generic scan above already loaded whatever it could).
    const marketplace = await loadMarketplacePluginsAtStartup(manager, pluginsDir);
    for (const entry of marketplace.skipped) {
      process.stderr.write(
        `[coordinator] Plugin marketplace "${entry.id}" không tải sandboxed được lúc bot start, bỏ qua: ${entry.error}\n`,
      );
    }
    for (const entry of marketplace.rolledBack) {
      process.stderr.write(
        `[coordinator] Plugin marketplace "${entry.id}" đã rollback ${entry.fromVersion} → ${entry.toVersion} lúc bot start (${entry.reason})\n`,
      );
    }
    return { tools: manager.toolsForRegistry(), bundleParts: manager.listBundleParts() };
  } catch (err) {
    process.stderr.write(
      `[coordinator] Không tải được PluginManager: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return { tools: [], bundleParts: [] };
  }
}

/** One marketplace plugin the startup loader could not load sandboxed. */
export interface MarketplaceStartupSkipped {
  id: string;
  error: string;
}

/** One marketplace plugin the startup loader rolled back to its previous version. */
export interface MarketplaceStartupRolledBack {
  id: string;
  fromVersion: string;
  toVersion: string;
  /** Why the new version was rejected (verify error or load error). */
  reason: string;
}

/**
 * v0.92a: load every marketplace-installed plugin sandboxed at bot
 * start — the missing half of the plugin marketplace v2 (team F):
 * `loadMarketplacePluginSandboxed` (tools) was exported but had no
 * runtime caller, and the `sandboxed: true` record in
 * `marketplace-installed.json` was only a policy declaration. This
 * function reads that record (records only — no rescan, so it never
 * disturbs an already-sandboxed scan) and loads each recorded
 * `sandboxed: true` plugin out-of-process.
 *
 * - v0.93a: `loadPlugins` EXCLUDES recorded marketplace plugins
 *   from the generic scan, so this function is their ONLY load path —
 *   nothing runs before the signature check below. (The v0.92a
 *   "default path is a no-op / legacy path replaces in-process tools"
 *   notes no longer apply: no in-process load of a marketplace
 *   plugin happens anywhere at bot start.)
 * - A plugin recorded but missing on disk, a bundle without a `main`
 *   entry, or a corrupt records file never breaks bot creation: the
 *   failure is reported in `skipped` (or logged) and the bot starts
 *   with the plugins that did load. The caller logs `skipped` to
 *   stderr (see `loadPlugins`).
 *
 * v0.93a: BEFORE loading, each plugin's bundle signature is verified
 * (`verifyInstalledPluginSignature` from tools — see
 * `docs/plugin-marketplace-signing.md`). A plugin that fails
 * verification is NOT loaded (fail-closed). When a previous-version
 * snapshot exists, the loader rolls the plugin back to it
 * (`downgradePlugin`), re-verifies, and loads the old version
 * instead — reported in `rolledBack`, never silently. The same
 * rollback is attempted when the new version FAILS TO LOAD
 * (loadSandboxed throws): a bad upgrade never takes a working plugin
 * away at bot start when a good previous version is on disk. One
 * rollback attempt per plugin, then the plugin is skipped — the bot
 * still starts with the plugins that did load.
 *
 * When the tools package predates v0.93a (no verify/downgrade
 * functions), verification and rollback are skipped and the v0.92a
 * behaviour holds — the function never throws either way.
 */
export async function loadMarketplacePluginsAtStartup(
  manager: PluginManagerLike,
  pluginsDir: string,
): Promise<{
  loadedIds: string[];
  skipped: MarketplaceStartupSkipped[];
  rolledBack: MarketplaceStartupRolledBack[];
}> {
  const loadedIds: string[] = [];
  const skipped: MarketplaceStartupSkipped[] = [];
  const rolledBack: MarketplaceStartupRolledBack[] = [];
  let marketplaceMod: {
    listMarketplaceInstalledRecords?: (
      dir: string,
    ) => Record<string, { sandboxed?: boolean }>;
    loadMarketplacePluginSandboxed?: (
      pluginManager: unknown,
      id: string,
    ) => Promise<unknown>;
    verifyInstalledPluginSignature?: (
      dir: string,
      id: string,
      opts?: { userDataDir?: string },
    ) => { ok: boolean; status?: string; keyId?: string; error?: string };
    downgradePlugin?: (
      id: string,
      dir: string,
      opts?: { userDataDir?: string },
    ) => { id: string; fromVersion: string; toVersion: string };
    getPluginDowngradeInfo?: (
      id: string,
      dir: string,
      opts?: { userDataDir?: string },
    ) => { canDowngrade: boolean; previousVersion: string | null };
  };
  try {
    // Dynamic require on purpose (see header): core must not import
    // @open-bot/tools statically.
    marketplaceMod = require('@open-bot/tools') as typeof marketplaceMod;
  } catch (err) {
    process.stderr.write(
      `[coordinator] Không tải được plugin marketplace lúc bot start: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return { loadedIds, skipped, rolledBack };
  }
  if (
    typeof marketplaceMod.listMarketplaceInstalledRecords !== 'function' ||
    typeof marketplaceMod.loadMarketplacePluginSandboxed !== 'function'
  ) {
    // Tools package predates marketplace v2 — nothing to enforce.
    return { loadedIds, skipped, rolledBack };
  }
  let records: Record<string, { sandboxed?: boolean }>;
  try {
    records = marketplaceMod.listMarketplaceInstalledRecords(pluginsDir);
  } catch (err) {
    process.stderr.write(
      `[coordinator] Bỏ qua plugin marketplace lúc bot start (bản ghi cài đặt hỏng): ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return { loadedIds, skipped, rolledBack };
  }
  const userDataDir = path.dirname(path.resolve(pluginsDir));
  // v0.93a: try once to roll a bad new version back to its snapshot.
  // Returns the rollback (for `rolledBack`) or null when there is
  // nothing to roll back to / the rollback itself failed.
  const tryRollback = (id: string, reason: string): MarketplaceStartupRolledBack | null => {
    if (
      typeof marketplaceMod.downgradePlugin !== 'function' ||
      typeof marketplaceMod.getPluginDowngradeInfo !== 'function'
    ) {
      return null;
    }
    try {
      const info = marketplaceMod.getPluginDowngradeInfo(id, pluginsDir, { userDataDir });
      if (!info.canDowngrade || info.previousVersion === null) return null;
      const result = marketplaceMod.downgradePlugin(id, pluginsDir, { userDataDir });
      return {
        id,
        fromVersion: result.fromVersion,
        toVersion: result.toVersion,
        reason,
      };
    } catch (err) {
      process.stderr.write(
        `[coordinator] Không rollback được plugin marketplace "${id}" về bản trước: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return null;
    }
  };
  for (const [id, record] of Object.entries(records)) {
    if (record?.sandboxed !== true) continue;
    // v0.93a: verify the bundle signature BEFORE any code runs.
    if (typeof marketplaceMod.verifyInstalledPluginSignature === 'function') {
      let check: { ok: boolean; error?: string };
      try {
        check = marketplaceMod.verifyInstalledPluginSignature(pluginsDir, id, { userDataDir });
      } catch (err) {
        check = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      if (!check.ok) {
        const reason = check.error ?? `Plugin "${id}" failed signature verification.`;
        const rolled = tryRollback(id, reason);
        if (rolled !== null) {
          rolledBack.push(rolled);
          const recheck = marketplaceMod.verifyInstalledPluginSignature(pluginsDir, id, {
            userDataDir,
          });
          if (!recheck.ok) {
            skipped.push({
              id,
              error:
                `${reason} (đã rollback về ${rolled.toVersion} nhưng bản đó cũng không qua kiểm tra: ` +
                `${recheck.error ?? 'unknown reason'})`,
            });
            continue;
          }
        } else {
          skipped.push({ id, error: reason });
          continue;
        }
      }
    }
    try {
      await marketplaceMod.loadMarketplacePluginSandboxed(manager, id);
      loadedIds.push(id);
    } catch (err) {
      // v0.93a: a new version that fails to LOAD rolls back to the
      // previous working version (once), then retries the load.
      const reason = err instanceof Error ? err.message : String(err);
      const rolled = tryRollback(id, reason);
      if (rolled !== null) {
        rolledBack.push(rolled);
        try {
          await marketplaceMod.loadMarketplacePluginSandboxed(manager, id);
          loadedIds.push(id);
        } catch (retryErr) {
          skipped.push({
            id,
            error:
              `${reason} (đã rollback về ${rolled.toVersion} nhưng bản đó cũng không tải được: ` +
              `${retryErr instanceof Error ? retryErr.message : String(retryErr)})`,
          });
        }
      } else {
        skipped.push({ id, error: reason });
      }
    }
  }
  return { loadedIds, skipped, rolledBack };
}

/**
 * v0.25 (W18a): test-only recording options for the mock provider.
 * W17d nối `SamplingContextStore` vào cả hai đường handler sampling
 * nhưng không có cách nào quan sát `ChatCompletionRequest` provider
 * nhận được, vì mock cũ bỏ qua input của `chat()`. Hai option này
 * chỉ để test quan sát — không đổi hành vi mặc định (không truyền
 * option thì mock chạy y như cũ), không dùng biến global/module: mỗi
 * provider instance ghi vào chỗ riêng của nó, hai bot chạy song song
 * không lẫn calls của nhau.
 */
export interface MockProviderRecordOptions {
  /**
   * Mảng caller-owned: mỗi lần `chat()` được gọi, request nhận được
   * được append vào đây. Chỉ dùng được khi caller giữ trực tiếp
   * provider instance (unit test in-process) — mảng không qua được
   * ranh giới tiến trình con của CoordinatorClient, trường hợp đó
   * dùng `recordPath`.
   */
  recordCalls?: Array<ChatCompletionRequest>;
  /**
   * v0.94c (test-only): mock tự nhận là provider có vision — loop
   * không từ chối lượt có ảnh nữa, request ghi lại để test kiểm chứng
   * ảnh tới được provider. Mặc định false (như cũ: mock không vision).
   */
  supportsVision?: boolean;
  /**
   * Đường dẫn file JSONL: mỗi lần `chat()` được gọi, một dòng JSON
   * (request nguyên vẹn) được append vào file này. Đây là cách test
   * qua CoordinatorClient quan sát input của provider: tiến trình con
   * coordinator không chia sẻ mảng với tiến trình cha, nhưng cả hai
   * đều đọc được cùng một file. Mỗi bot dùng MỘT file riêng (truyền
   * path khác nhau cho mỗi bot) để calls không lẫn nhau. Ghi lỗi
   * (vd thư mục chưa tồn tại) không bao giờ làm fail `chat()` —
   * recording là best-effort, test-only.
   */
  recordPath?: string;
}

/**
 * Test-only scripted provider (provider id "mock"). Answers from the
 * scripted responses in order; the last one repeats. No network, no key.
 */
export function createMockProvider(
  responses: MockProviderResponse[],
  options?: MockProviderRecordOptions,
): Provider {
  const script = responses.length > 0 ? responses : [{ text: 'mock reply' }];
  let i = 0;
  const recordCalls = options?.recordCalls;
  const recordPath =
    typeof options?.recordPath === 'string' && options.recordPath.trim() !== ''
      ? options.recordPath
      : undefined;
  return {
    id: 'mock',
    label: 'Mock',
    // v0.94c (test-only): mock vision — khi bật, loop cho lượt có ảnh
    // đi qua như provider vision thật (xem MockProviderRecordOptions).
    ...(options?.supportsVision === true ? { supportsVision: () => true } : {}),
    async chat(req: ChatCompletionRequest) {
      // v0.25 (W18a): ghi lại request TRƯỚC khi trả scripted response
      // (kể cả khi response là tool-call — lượt sampling nào cũng phải
      // thấy được). `signal` (AbortSignal) không có field enumerable
      // nên JSON.stringify ra `{}` — không ảnh hưởng file record.
      if (recordCalls) recordCalls.push(req);
      if (recordPath) {
        try {
          fs.appendFileSync(recordPath, `${JSON.stringify(req)}\n`, 'utf8');
        } catch {
          // Recording là test-only best-effort: không fail chat vì ghi log.
        }
      }
      const r = script[Math.min(i++, script.length - 1)];
      if (r.delayMs !== undefined && r.delayMs > 0) await sleep(r.delayMs);
      return {
        text: r.text ?? '',
        toolCalls: r.toolCalls ?? [],
        // v0.4: scripted usage so MeteredProvider/spend-limit tests can run.
        ...(r.usage
          ? { usage: { inputTokens: r.usage.inputTokens ?? 0, outputTokens: r.usage.outputTokens ?? 0 } }
          : {}),
      };
    },
    async listModels() {
      return ['mock'];
    },
  };
}

/**
 * v0.25 (W18a): đọc field test-only `mockRecordPath` từ provider
 * config của `createBot` (đường dẫn file JSONL cho mock ghi lại mọi
 * `ChatCompletionRequest` — xem `MockProviderRecordOptions.recordPath`).
 * Field đã khai báo trong `CreateBotProviderConfig` (types.ts); giá trị
 * vắng hoặc không phải string thì undefined = mock chạy như cũ, không
 * record. Không log giá trị (path có thể nằm trong userData).
 */
export function mockRecordPathFromProviderConfig(
  providerConfig: CreateBotProviderConfig,
): string | undefined {
  const recordPath = providerConfig.mockRecordPath;
  return typeof recordPath === 'string' && recordPath.trim() !== '' ? recordPath : undefined;
}

/**
 * v0.94c (test-only): đọc cờ `mockSupportsVision` từ provider config
 * của `createBot` — mock tự nhận có vision để test lượt có ảnh đi qua
 * loop tới provider. Không dùng production.
 */
export function mockSupportsVisionFromProviderConfig(
  providerConfig: CreateBotProviderConfig,
): boolean {
  return providerConfig.mockSupportsVision === true;
}

/**
 * M4 — dispose một provider, kể cả khi nó bị bọc bởi MeteredProvider.
 *
 * BUG đã có từ trước (phát hiện khi làm switchModel): `createBot` bọc
 * provider trong MeteredProvider khi có `usageStorePath` (desktop luôn
 * truyền), nhưng MeteredProvider KHÔNG forward `dispose()` — nên
 * `entry.provider.dispose?.()` ở destroyBot/shutdown là no-op và
 * process CLI sống (vd Claude Code retained process) bị mồ côi khi bot
 * bị xoá/tắt app. Helper này unwrap `wrapped` (getter của
 * MeteredProvider) trước khi dispose; dùng chung cho destroyBot,
 * shutdown và switchModel. Best-effort, không throw.
 */
function disposeProvider(provider: Provider): void {
  try {
    const inner =
      (provider as unknown as { wrapped?: Provider }).wrapped ?? provider;
    const disposed = inner.dispose?.();
    if (disposed && typeof (disposed as Promise<void>).catch === 'function') {
      (disposed as Promise<void>).catch(() => undefined);
    }
  } catch {
    // Best-effort.
  }
}

interface BotEntry {
  bot: BotConfig;
  provider: Provider;
  /** Provider config as passed by main (holds the API key in memory). */
  providerConfig: CreateBotProviderConfig;
  /**
   * M4: usage store path for the MeteredProvider wrapper (set at
   * createBot; switchModel re-wraps the new provider with the same
   * store so spend limits survive a model switch).
   */
  usageStorePath?: string;
  tools: Tool[];
  /** Core tools (non-plugin) — plugin tools are rebuilt on toggle. */
  coreTools: Tool[];
  /**
   * v0.58: meta-tool Composio runnable của bot (tách riêng khỏi
   * coreTools để RPC `composio.setState` rebuild được mà không cần
   * tạo lại bot — xem `rebuildComposioTools`). Rỗng khi Composio tắt.
   */
  composioTools: Tool[];
  /** Plugin tools currently in `tools` (v0.14: rebuilt by setPluginEnabled). */
  pluginTools: Tool[];
  /** Plugins dir this bot's plugin tools came from (if any). */
  pluginsDir?: string;
  /** Whether the bot's plugins run sandboxed (default true). */
  pluginsSandbox?: boolean;
  /** Subagent specs from plugin bundles (v0.14) — hinted in the system prompt. */
  bundleSubagents: SpecializedSubagentSpec[];
  /** Slash commands from plugin bundles (v0.14) — resolved in executeRun. */
  bundleSlashCommands: SlashCommandDef[];
  memory: BotMemory;
  maxSteps: number;
  /**
   * v0.24 (W17d): store lịch sử sampling dùng chung cho mọi handler
   * sampling của bot này — `includeContext: 'allServers'` thật (đường
   * pool `getSamplingHandler` lẫn đường system `callSystemToolFor` đều
   * tiêm store này vào `createSamplingHandler`). Tạo lúc bot được tạo
   * (`createBot` / `createAgentBot`), xoá lúc `destroyBot`/`shutdown`.
   * Một store cho mỗi bot: hai bot không thấy lịch sử của nhau.
   */
  samplingContextStore: SamplingContextStore;
  /** Set while a run is in flight. */
  controller?: AbortController;
  running: boolean;
  stopRequested: boolean;
  /**
   * v0.60 (P0 Stop race): timestamp (ms) of a `stopBot` that arrived
   * while no run was executing — the stop overtook the run RPC (the
   * UI shows Stop as soon as the renderer sets status=thinking,
   * while `chat:send` still awaits a `saveMessage` round-trip before
   * dispatching `run`). The next run starting soon must abort
   * immediately instead of running to completion. Consumed (cleared)
   * by `executeRun` whether fresh or stale.
   */
  pendingStopAt?: number;
}

/**
 * v0.58: override cho đường Composio của coordinator — CHỈ dùng cho
 * test (mock REST/MCP trên 127.0.0.1) hoặc embedder tự host endpoint
 * tương thích. Production bỏ trống: REST base mặc định v3.1 của
 * Composio + fetch global, key đọc từ file Vault của main.
 */
export interface ComposioCoordinatorOptions {
  /** REST base của Tool Router (mặc định `COMPOSIO_API_BASE_URL`). */
  baseUrl?: string;
  /** Fetch tiêm được (mặc định global fetch qua router). */
  fetchFn?: ComposioFetchFn;
  /**
   * v0.88b: user id cho Tool Router session (mặc định
   * COMPOSIO_LOCAL_USER_ID khi không truyền). Production: main
   * không truyền ở đây — nó seed qua RPC `composio.setUserId` /
   * param `composioUserId` của `createBot` (đọc từ Vault).
   */
  userId?: string;
}

export interface CoordinatorOptions {
  /** Override how tools are built (default: full registry from @open-bot/tools). */
  toolFactory?: ToolFactory;
  /** Where agent events go (default: no-op; the stdio entry sets NDJSON out). */
  emit?: (notification: CoordinatorNotification) => void;
  /**
   * v0.8: max runs executing at the same time (default MAX_CONCURRENT_RUNS
   * = 4). Runs past the cap wait FIFO in the run queue. Values < 1 are
   * clamped to 1.
   */
  maxConcurrentRuns?: number;
  /**
   * v0.74a follow-up: cửa sổ (ms) mà một pending stop còn hiệu lực —
   * áp cho cả `pendingStopAt` (stopBot) lẫn `pendingStopByRunId`
   * (stopRun trước run). Mặc định PENDING_STOP_WINDOW_MS = 30_000.
   * Chỉ để test rút ngắn cửa sổ và chờ THẬT qua nó (không mock thời
   * gian): giá trị không hợp lệ (<= 0, NaN, không phải số) rơi về
   * mặc định. Production không đặt — giữ 30s.
   */
  pendingStopWindowMs?: number;
  /**
   * v0.35 (P1-7): thư mục dữ liệu local (userData) — file rule
   * auto-approve `<dataDir>/auto-approve-rules.json`. Không set (và
   * không có env `OPENBOT_DATA_DIR`) thì rule chỉ sống trong bộ nhớ
   * tiến trình coordinator (mất khi restart) — hành vi này giữ cho
   * test in-process không ghi file lạ vào repo.
   */
  dataDir?: string;
  /**
   * v0.85 (P1-7): whether the calling bot runs as a team admin —
   * wired into the tool host (`buildToolHost`) so `manage_access`
   * mutations are allowed for admins and refused fail-closed for
   * everyone else. Absent = every mutation refused (fail-closed),
   * list actions still work. The desktop main wires this in the
   * stdio child entry (`runCoordinatorStdio`, reading team.json
   * live); in-process embedders may pass their own check.
   */
  isTeamAdmin?: (ctx: { botId: string; workspaceDir: string }) => boolean | Promise<boolean>;
  /**
   * v0.85 (P1-7): directory holding team.json for `manage_access`
   * (wired into the tool host alongside `isTeamAdmin`). Null/absent
   * = the access tool's own default (`<workspaceDir>/.open-bot/team`).
   * The desktop main wires this to its userData dir in
   * `runCoordinatorStdio`, so the tool manages the same team.json
   * the admin UI edits.
   */
  getTeamBaseDir?: () => string | null;
  /**
   * v0.55: policy egress chung (global) cho shell tools — team.json
   * (đọc từ `dataDir`) merge lên trên policy này qua
   * `resolveTeamEgressPolicy` (field team đặt thắng field chung).
   * Không set thì lấy từ env `OPENBOT_EGRESS_POLICY` (JSON, sai thì
   * bỏ qua = chưa cấu hình); cả hai đều không có → shell fail-closed
   * khi lệnh chứa đích mạng. `null` = tắt kiểm tra egress hẳn (chỉ
   * cho test/caller cũ tự kiểm soát). Đổi lúc chạy bằng
   * `setEgressPolicy()` — bot đã tạo thấy ngay nhờ resolver lười.
   */
  egressPolicy?: EgressPolicy | null;
  /**
   * v0.58: override đường Composio (chỉ cho test/embedder — xem
   * `ComposioCoordinatorOptions`). Không set = production mặc định.
   */
  composio?: ComposioCoordinatorOptions;
  /**
   * M5 — harness local (registry + bus + NDJSON log + permission
   * broker). Không set thì coordinator chạy như cũ (không registry,
   * không bus, permission CLI vẫn từ chối fail-closed ở driver).
   * v0.50 (M8): stdio entry (`runCoordinatorStdio`) dựng `LocalHarness`
   * với dataDir (userData, qua env OPENBOT_DATA_DIR) và truyền vào đây
   * — main không truyền được object qua NDJSON-RPC nên harness sống
   * trong tiến trình con, nơi provider CLI thật sự chạy.
   */
  harness?: LocalHarness;
  /**
   * v0.54 (P1-8): handler interrupt do host cung cấp — khi set, run dừng
   * sẽ hỏi handler này trực tiếp thay vì emit event `interrupt-needed`
   * về renderer. Không set thì mặc định emit event (desktop UI trả lời
   * qua RPC `respondInterrupt`).
   */
  interruptHandler?: InterruptHandler;
  /**
   * v0.96 (Đội T3): cấu hình router chọn model mỗi turn (xem
   * packages/core/src/router/). Không set = mặc định (bật, fail-open).
   * Đặt `{ enabled: false }` để tắt hẳn và luôn dùng model của bot.
   */
  router?: Partial<RouterConfig>;
}

/**
 * v0.55: đọc policy egress chung từ env `OPENBOT_EGRESS_POLICY`
 * (JSON — cùng kiểu với `OPENBOT_DAEMON_EGRESS_POLICY` của daemon).
 * Env không đặt / JSON sai / shape sai → `undefined` (chưa cấu hình
 * → shell fail-closed, không tự sinh policy cho phép). Không log nội
 * dung env (policy có thể chứa host nội bộ).
 */
function readEgressPolicyEnv(): EgressPolicy | undefined {
  const raw = process.env['OPENBOT_EGRESS_POLICY'];
  if (raw === undefined || raw.trim() === '') return undefined;
  try {
    return validateEgressPolicy(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

export class AgentCoordinator {
  private readonly bots = new Map<string, BotEntry>();
  /**
   * v0.55: createBot đang chạy dở theo bot id — gọi createBot lần 2
   * (kể cả song song) cho cùng id thì chờ chung một promise thay vì
   * dựng bot trùng (xem `createBot` — re-attach idempotent).
   */
  private readonly botCreations = new Map<string, Promise<CreateBotResult>>();
  /** v0.4: one usage tracker per child process (shared usage.json). */
  private usageTracker: UsageTracker | null = null;
  /** v0.4: skill registry for this child (lazy-init on first createBot). */
  private skillRegistry: SkillRegistry | null = null;
  /** v0.14: skill dirs from the first createBot (for getUserSkillsDir). */
  private skillsDirs?: { userSkillsDir?: string; pluginsDir?: string; stateDir?: string };
  private readonly toolFactory: ToolFactory;
  private readonly emitFn: (notification: CoordinatorNotification) => void;
  private shuttingDown = false;
  /** callId -> resolve(decision). Answered by `respondApproval`. v0.12: có thể kèm args đã sửa. */
  private readonly pendingApprovals = new Map<string, (decision: boolean | ApprovalDecision) => void>();
  /**
   * v1.01 (Đội T3, risk budget): queue ghi sổ yêu cầu duyệt + audit log
   * (chung cho mọi run của coordinator; loop tạo entry khi hỏi duyệt,
   * `respondApproval` resolve entry khi user trả lời).
   */
  private readonly confirmationQueue = new ConfirmationQueue();
  /**
   * v1.01 (Đội T3): store rule risk + lịch sử budget của coordinator
   * (lazy như AutoApproveRuleStore; file dưới dataDir, không có
   * dataDir thì chỉ giữ trong bộ nhớ).
   */
  private riskRuleStoreInstance: RiskRuleStore | undefined;
  private budgetHistoryInstance: ConversationBudgetHistory | undefined;
  /** requestId -> resolve(answer). Answered by `respondAskUser`. */
  private readonly pendingAskUser = new Map<string, (answer: string) => void>();
  /**
   * v0.54 (P1-8): requestId -> resolve(decision). Answered by
   * `respondInterrupt` (renderer trả lời thẻ InterruptCard). Hết 10 phút
   * không trả lời thì mặc định `cancel` (dừng an toàn, checkpoint đã lưu).
   */
  private readonly pendingInterrupts = new Map<string, (decision: InterruptDecision) => void>();
  /** v0.54 (P1-8): runId -> runner đang chạy (để `interruptRun` gọi `interrupt()`). */
  private readonly runnersById = new Map<string, AgentRunner>();
  /** v0.54 (P1-8): handler interrupt do host cung cấp (vd headless CLI tự trả lời). */
  private readonly interruptHandler?: InterruptHandler;
  /**
   * v0.19 (W12e): dấu "plan đã duyệt" dùng một lần, theo bot
   * (botId -> { projectId vừa duyệt, loại dấu }). Ghi khi tool
   * `plan_update` chạy xong với reviewDecision "approve" thành công
   * (xem wrapPlanApprovalTool) hoặc khi RPC reviewPlan duyệt
   * (approve); run ngay sau đó của cùng bot được tự duyệt tool-call
   * (executeRun tiêu thụ dấu khi run bắt đầu) và dấu hết hiệu lực —
   * không rò sang run sau, không sang bot khác.
   * v0.20 (W15a): thêm loại dấu `revision` — ghi khi RPC reviewPlan
   * với request-changes. W16a: `plan_update` với request-changes qua
   * đường tool cũng ghi dấu `revision` (xem wrapPlanApprovalTool),
   * đồng bộ với đường RPC. Dấu revision cũng dùng một lần cho run kế
   * tiếp, nhưng CHỈ tự duyệt riêng tool `plan_create` (lập lại plan),
   * các tool khác vẫn hỏi approval như thường (xem onApprovalNeeded
   * trong executeRun). Một bot chỉ giữ tối đa một dấu tại một thời
   * điểm nên approve và revision không chồng chéo: dấu ghi sau ghi
   * đè dấu ghi trước, và một run chỉ mang tối đa một loại dấu.
   */
  private readonly planApprovedRuns = new Map<
    string,
    { projectId: string; kind: 'approve' | 'revision' }
  >();
  /** elicitationId -> resolve(result). Answered by `respondElicitation` (v0.13). */
  private readonly pendingElicitations = new Map<string, (result: ElicitResult) => void>();
  /**
   * M4: model switch đang chờ (botId -> provider config mới) — ghi khi
   * switchModel được gọi trong lúc bot đang chạy một run; run đang chạy
   * không bị ngắt, executeRun của run KẾ TIẾP tiêu thụ và áp dụng ngay
   * đầu run (đổi provider trước khi dựng runner). Bot bị xoá thì dấu
   * cũng hết (destroyBot xoá cùng entry). Chỉ giữ tối đa một switch
   * chờ mỗi bot — switch gọi sau ghi đè switch gọi trước.
   */
  private readonly pendingModelSwitches = new Map<string, CreateBotProviderConfig>();
  /** v0.12: sổ handoff toàn cục (trace/debug) + chuỗi handoff theo bot (chống lặp A→B→A). */
  private readonly handoffLog = new HandoffLog();
  private readonly handoffChains = new Map<string, HandoffRecord[]>();
  /** Run id của các run handoff đang chạy — run thường bắt đầu mới sẽ xoá chuỗi handoff của bot. */
  private readonly handoffRunIds = new Set<string>();
  /**
   * One exec daemon per coordinator child, shared by all bots. Created
   * lazily on first shell use (via the tool factory's getDaemon) so a
   * coordinator that never runs shell never spawns it. A dead daemon is
   * dropped (waitForExit) and re-created on the next shell call.
   */
  private daemonClient: DaemonClientLike | null = null;
  /** M5 — harness local (registry/bus/log/broker), null khi không cấu hình. */
  private readonly harness?: LocalHarness;
  /**
   * v0.96 (Đội T3): router chọn model mỗi turn — lazy (chỉ dựng khi
   * turn đầu tiên chạy, để coordinator không chạm Ollama khi router
   * tắt). Quyết định router ghi vào harness event log qua sink
   * (kind 'router.decision') + ring buffer trong router (UI đọc qua
   * `getRouterDecisions()` / `getRouterStats()`).
   */
  private routerInstance: ModelRouter | null = null;
  private readonly routerConfig?: Partial<RouterConfig>;
  /**
   * v0.97 (Team T3): AG-UI bus + state store + generative-UI registry,
   * shared by every run in this child (lazy — created on first run
   * that can emit, so a coordinator that never runs an API-provider
   * bot allocates nothing). The bus is the source for the Local API
   * SSE endpoint (`GET /v1/agui/events`) and for the renderer feed;
   * the state store answers `GET /v1/agui/runs/:runId/state`.
   */
  private agUiBusInstance: AgUiEventBus | null = null;
  private agUiStateStoreInstance: AgUiStateStore | null = null;
  private agUiGenUiRegistryInstance: AgUiGenerativeUiRegistry | null = null;
  /**
   * v0.98 (Đội T2): lịch sử quyết định router bền vững theo bot
   * (file `<dataDir>/router-decisions.json`) + key API đã seed cho
   * router (chỉ id → key trong bộ nhớ, không log, không ghi file) +
   * registry phát hiện CLI (đọc `<dataDir>/detected-engines.json`).
   */
  private routerDecisionStore: RouterDecisionStore | null = null;
  private readonly routerApiKeys = new Map<string, string>();
  private detectedEnginesRegistry: DetectedEngineRegistry | null = null;
  private routerPersistedConfigLoaded = false;
  /** v0.6: per-bot tool permissions shared by every runner in this child. */
  private readonly permissions = new AgentPermissions();
  /** v0.11: một RulesStore cho mỗi workspace (cache theo mtime) — dùng cho glob-rules hook. */
  private readonly rulesStores = new Map<string, RulesStore>();
  /**
   * v0.35 (P1-7): store rule auto-approve của coordinator (lazy — tạo
   * ở lần dùng đầu để coordinator không chạm đĩa khi không cần).
   * File `<dataDir>/auto-approve-rules.json`; không có dataDir thì
   * store chỉ giữ trong bộ nhớ (xem `CoordinatorOptions.dataDir`).
   */
  private autoApproveStoreInstance: AutoApproveRuleStore | undefined;
  /** v0.50 (M8): store group chat dùng chung của coordinator (lazy). */
  private groupChatStoreInstance: GroupChatStore | undefined;
  /** v0.96 (Team T4): store channel dùng chung của coordinator (lazy). */
  private channelStoreInstance: ChannelStore | undefined;
  /**
   * v0.79a + v0.82: trạng thái chạy của bot trong group chat (lazy,
   * xem getter — snapshot `running` lưu file `<dataDir>/
   * group-bot-status.json`; sau restart entry cũ thành `interrupted`,
   * không bao giờ khôi phục thành `running`).
   */
  private groupBotStatusTrackerInstance: GroupBotStatusTracker | undefined;
  /** v0.37 (P1-3): store record handoff phiên làm việc (lazy, xem getter). */
  private sessionHandoffStoreInstance: SessionHandoffStore | undefined;
  /**
   * v1.01 (Đội T1): event-sourced run log — store bền vững dưới
   * `<dataDir>/run-logs/` (lazy; không có dataDir thì run log tắt,
   * loop chạy như cũ). Registry gate dùng chung cho pause/resume;
   * map runId → recorder của run đang chạy (để stop/pause từ UI
   * tìm được recorder mà không cần đọc lại file).
   */
  private runLogStoreInstance: RunLogStore | undefined;
  private readonly runLogRegistry = new RunControlRegistry();
  private readonly runLogRecorders = new Map<string, RunLogRecorder>();
  private readonly dataDir?: string;
  /**
   * v0.98 (Team T4 — planning v2): run ↔ plan binding — the plan
   * state follows live runs (dispatch at run start, tool calls feed
   * the stuck detector, run outcome settles the step) and every
   * change is emitted as a `plan.event`. Created in the constructor
   * once `dataDir` is known so plans persist under
   * `<dataDir>/run-plans/`; without a dataDir the binding is
   * in-memory only (in-process tests).
   */
  private readonly runPlanBinding: RunPlanBinding;
  /** v0.98: runIds whose plan events stay silent (silent runs). */
  private readonly silentPlanRuns = new Set<string>();
  /**
   * v0.95d4: một OllamaEmbeddings dùng chung cho turn-context recall
   * của mọi bot (client không giữ state; probe khả dụng được cache
   * 60s trong turnContext). Lazy — không tạo khi chưa có turn nào.
   */
  private memoryEmbedderInstance: OllamaEmbeddings | undefined;
  /** v0.85 (P1-7): admin check for `manage_access` (see CoordinatorOptions). */
  private readonly isTeamAdmin?: (ctx: {
    botId: string;
    workspaceDir: string;
  }) => boolean | Promise<boolean>;
  /** v0.85 (P1-7): team.json base dir for `manage_access` (see CoordinatorOptions). */
  private readonly getTeamBaseDir?: () => string | null;
  /**
   * v0.55: policy egress chung (global) — xem `CoordinatorOptions.egressPolicy`.
   * `undefined` = chưa cấu hình (lấy từ env lúc khởi tạo, sai thì cũng
   * là `undefined`); `null` = tắt kiểm tra egress hẳn.
   */
  private egressPolicy: EgressPolicy | null | undefined;
  /** v0.6: X bearer token for x_search (passed by main, never logged). */
  private xBearer: string | null = null;
  /** v0.95 (Team D1): Brave Search API key for internet_search (passed by main, never logged). */
  private braveSearchApiKey: string | null = null;
  /** v0.7: GitHub token for the git tools (passed by main, never logged). */
  private githubToken: string | null = null;
  /** v0.7: integration access tokens by connector id (passed by main). */
  private connectorTokens: Record<string, string> = {};
  /**
   * v0.9d: full TokenSets for the integration connectors, by connector
   * id — seeded from main's Vault copy at createBot, then refreshed
   * in-memory by the ConnectorTokenProvider. A refresh writes back
   * through connectorTokenStoreFor(), which emits
   * 'connector.oauth-token' so main can persist the new TokenSet to
   * Vault — the child never touches the Vault itself (same pattern as
   * the MCP OAuth store, mcpOAuthStoreFor). Seed-only: a live
   * (refreshed) in-memory TokenSet is never overwritten by the older
   * Vault copy main passes on a later createBot.
   */
  private readonly connectorTokenSets = new Map<string, TokenSet>();
  /**
   * v0.9d: OAuth client credentials per connector (from main, Vault
   * namespace 'oauth-client'). Needed to refresh a TokenSet that
   * carries a refresh token. Never logged.
   */
  private connectorClientConfigs: Record<string, ConnectorClientConfig> = {};
  /**
   * M7: kho token dùng chung cho connected apps (SharedAppAuthStore).
   * Backing store là chính `connectorTokenSets` map này — mọi bot
   * đọc chung qua buildToolHost nên token nối/xóa ở đây có hiệu lực
   * ngay với bot đã tạo, không cần tạo lại bot (sửa giới hạn v0.19).
   * Ghi token (connect/refresh) emit 'connector.oauth-token' để
   * main persist lại Vault, cùng đường với connectorTokenStoreFor.
   */
  private readonly appAuthStore: SharedAppAuthStore;
  /**
   * v0.59: Composio trong tiến trình coordinator con — source trên
   * `defaultAppRegistry` (mặc định TẮT, bật qua RPC
   * `composio.setState`), session manager dùng chung cho mọi bot.
   * Key: ƯU TIÊN key main seed trong bộ nhớ qua RPC
   * `composio.setApiKey` / param `composioApiKey` của `createBot`
   * (làm việc với mọi backend Vault, kể cả safeStorage + NO_STORAGE);
   * fallback là reader đọc trực tiếp file Vault của main (chỉ mở
   * được khi Vault dùng LocalEncryptor — xem
   * `createComposioVaultFileKeyReader`). Con KHÔNG BAO GIỜ ghi file
   * Vault, KHÔNG log key. Key đổi → session manager bị huỷ để lần
   * gọi sau tạo session mới đúng key (xem `seedComposioApiKey`).
   */
  private readonly composioSource: ComposioAppSource;
  private readonly composioManager: ComposioSessionManager;
  private readonly composioKeyReader: ComposioSeededKeyReader;
  /**
   * v0.95 (Team D2): media (image/video) API keys, theo provider id —
   * main seed trong bộ nhớ qua RPC `media.setKey` / param
   * `mediaApiKeys` của `createBot` (đọc Vault namespace 'media' bằng
   * safeStorage trong main). Con KHÔNG BAO GIỜ ghi file Vault, KHÔNG
   * log key. Key mới ghi đè key cũ; null/rỗng = xoá key đã seed.
   */
  private readonly mediaApiKeys = new Map<string, string>();
  /** v0.10: shared hook registry (denylist hook registered once). */
  private hookRegistry?: HookRegistry;
  /** v1.01: shared hook execution log (one per coordinator, file-backed). */
  private hookExecutionLog?: HookExecutionLog;
  /** v0.10: dir for `hooks-enabled.json` (userData, from skillsDirs). */
  private hooksStateDir?: string;
  /** v0.10: traces file passed by main (<userData>/traces.jsonl). */
  private tracesFile?: string;
  private traceStoreInstance?: TraceStore | null;
  /**
   * v0.7: MCP OAuth tokens by server name (serialized McpOAuthToken
   * JSON). Seeded from main's Vault copy at createBot; a live mcp_auth
   * overwrites the in-memory copy and the new value is sent back to
   * main via 'mcp.oauth-token' for Vault persistence.
   */
  private readonly mcpOAuthTokens = new Map<string, string>();
  /** v0.7: OAuth client configs for MCP servers, by server name. */
  private mcpOAuthConfigs: Record<string, McpOAuthClientConfig> = {};
  /** v0.7: system MCP tools mcp_system_exec may run (empty = none). */
  private allowedSystemTools: string[] = [];
  /**
   * v0.8: run queue — at most `maxConcurrentRuns` runs execute at once;
   * the rest wait FIFO in `runQueue`. `activeRuns` counts runs that
   * have started but not finished yet.
   */
  private readonly maxConcurrentRuns: number;
  /**
   * v0.74a follow-up: cửa sổ pending-stop hiệu lực (ms) của instance
   * này — mặc định PENDING_STOP_WINDOW_MS (30s); test có thể rút ngắn
   * qua `CoordinatorOptions.pendingStopWindowMs` để chờ thật qua cửa
   * sổ mà không làm suite chậm 30s.
   */
  private readonly pendingStopWindowMs: number;
  private activeRuns = 0;
  private runQueue: QueuedRun[] = [];
  /**
   * v0.9a: runs executing right now, by run id — what `stopRun`
   * aborts. A queued run is not here yet; it is found by scanning
   * `runQueue` for its stamped `runId` instead.
   */
  private readonly runsById = new Map<string, ActiveRun>();
  /**
   * v0.74a: stop theo runId tới TRƯỚC khi run mang id đó bắt đầu
   * (kể cả trước khi `run()` xếp hàng — vd stop qua WS tới nhanh
   * hơn run qua IPC khác) — ghi lại thời điểm (ms) để `executeRun`
   * dừng run đó ngay khi bắt đầu, cùng cửa sổ 30s với
   * `pendingStopAt`. Không biết botId lúc ghi nên không giam theo
   * bot; entry hết hạn được dọn lúc ghi mới, tiêu thụ một lần.
   */
  private readonly pendingStopByRunId = new Map<string, number>();

  constructor(opts: CoordinatorOptions = {}) {
    this.maxConcurrentRuns = Math.max(
      1,
      Math.floor(opts.maxConcurrentRuns ?? MAX_CONCURRENT_RUNS),
    );
    // v0.74a follow-up: cửa sổ pending-stop — giá trị không hợp lệ
    // rơi về mặc định 30s (không throw: option này chỉ để test rút
    // ngắn cửa sổ; production không đặt).
    const pendingStopWindowMs = opts.pendingStopWindowMs;
    this.pendingStopWindowMs =
      typeof pendingStopWindowMs === 'number' &&
      Number.isFinite(pendingStopWindowMs) &&
      pendingStopWindowMs > 0
        ? Math.floor(pendingStopWindowMs)
        : PENDING_STOP_WINDOW_MS;
    this.dataDir = opts.dataDir ?? process.env['OPENBOT_DATA_DIR'];
    // v0.98 (Team T4 — planning v2): run ↔ plan binding. The store
    // is file-backed when a dataDir exists, in-memory otherwise.
    // Events forward as `plan.event` — except for silent runs, which
    // keep the v0.4 contract (no informational events to the parent).
    this.runPlanBinding = new RunPlanBinding({
      store: this.dataDir ? new PlanFileStore(this.dataDir) : null,
      onEvent: (event: PlanRunEvent) => {
        if (this.silentPlanRuns.has(event.runId)) return;
        this.emitEvent(event.botId, 'plan.event', event);
      },
    });
    // v0.85 (P1-7): admin check + team dir for `manage_access` —
    // buildToolHost forwards them to defaultToolFactory.
    this.isTeamAdmin = opts.isTeamAdmin;
    this.getTeamBaseDir = opts.getTeamBaseDir;
    // v0.59: Composio — source trên defaultAppRegistry (mặc định TẮT,
    // opt-in qua RPC `composio.setState`) + session manager dùng chung
    // cho mọi bot. Key: ƯU TIÊN key main seed trong bộ nhớ
    // (`createComposioSeededKeyReader` bọc reader file Vault —
    // seeded thắng fallback); main seed qua RPC `composio.setApiKey`
    // hoặc param `composioApiKey` của `createBot` (xem
    // `seedComposioApiKey`). Fallback file chỉ mở được khi Vault dùng
    // LocalEncryptor; safeStorage/NO_STORAGE thì fail-closed cho tới
    // khi main seed. Key KHÔNG bao giờ log, không ghi file Vault.
    this.composioKeyReader = createComposioSeededKeyReader(
      createComposioVaultFileKeyReader(this.dataDir),
    );
    this.composioSource = new ComposioAppSource({
      registry: defaultAppRegistry,
      hasApiKey: () => this.composioKeyReader() !== null,
    });
    this.composioManager = new ComposioSessionManager({
      getApiKey: () => this.composioKeyReader(),
      // v0.88b: user id do host truyền (main seed từ Vault qua RPC /
      // createBot); vắng = mặc định 'local-user' (xem resolveComposioUserId).
      userId: opts.composio?.userId ?? COMPOSIO_LOCAL_USER_ID,
      getEnabledToolkits: () => this.composioSource.enabledToolkits(),
      ...(opts.composio?.baseUrl ? { baseUrl: opts.composio.baseUrl } : {}),
      ...(opts.composio?.fetchFn ? { fetchFn: opts.composio.fetchFn } : {}),
    });
    // v0.55: policy chung tường minh thắng env; `null` tường minh cũng
    // thắng (tắt hẳn) nên không dùng `??` ở đây (`??` nuốt cả `null`).
    this.egressPolicy =
      opts.egressPolicy !== undefined ? opts.egressPolicy : readEgressPolicyEnv();
    this.harness = opts.harness;
    this.routerConfig = opts.router;
    this.interruptHandler = opts.interruptHandler;
    this.toolFactory =
      opts.toolFactory ??
      ((memory, workspaceDir, botId) =>
        defaultToolFactory(
          memory,
          workspaceDir,
          botId,
          () => this.getDaemonClient(),
          this.buildToolHost(botId),
        ));
    this.emitFn = opts.emit ?? (() => undefined);
    // M7: kho token dùng chung cho connected apps, trên cùng map mà
    // buildToolHost đọc — token nối/xóa ở đây thấy ngay ở mọi bot.
    this.appAuthStore = new SharedAppAuthStore({
      store: {
        getToken: async (connectorId: string) => {
          const stored = this.connectorTokenSets.get(connectorId);
          return stored ? { ...stored } : null;
        },
        setToken: async (connectorId: string, token: TokenSet) => {
          this.connectorTokenSets.set(connectorId, { ...token });
          // Cùng đường persist với connectorTokenStoreFor: main ghi
          // lại Vault để lần mở sau còn token (kể cả token vừa
          // refresh). BotId rỗng: event này main chỉ dùng payload,
          // không gửi gì về renderer theo botId.
          this.emitEvent('', 'connector.oauth-token', {
            connectorId,
            value: JSON.stringify(token),
          });
        },
        clearToken: async (connectorId: string) => {
          this.connectorTokenSets.delete(connectorId);
        },
      },
      // v0.68b: token PAT thô của app token (M7 app 'github') — kho
      // trong bộ nhớ là `githubToken` đã seed từ main (Vault
      // 'github'/'token'); main ghi/xóa Vault rồi gọi RPC
      // apps.setPlainToken / apps.revokeSharedToken để đồng bộ. Bot
      // đọc qua host.getGitHubToken nên token mới có hiệu lực ngay,
      // không cần tạo lại bot. Chỉ đúng 1 app token hôm nay (github)
      // nên callback kiểm tra đúng namespace/key, app token khác sau
      // này cần nối thêm nguồn của nó ở đây.
      getPlainToken: async (namespace: string, key: string) => {
        if (namespace === 'github' && key === 'token') return this.githubToken;
        return null;
      },
      setPlainToken: async (namespace: string, key: string, value: string) => {
        if (namespace === 'github' && key === 'token') this.githubToken = value;
      },
      clearPlainToken: async (namespace: string, key: string) => {
        if (namespace === 'github' && key === 'token') this.githubToken = null;
      },
    });
  }

  /**
   * v0.55: đặt policy egress chung (global) lúc chạy. Bot đã tạo thấy
   * ngay ở lần shell_exec sau — resolver của tool đọc lười, không cần
   * tạo lại bot. `null` = tắt kiểm tra egress hẳn (chỉ cho test/caller
   * cũ); `undefined` = gỡ policy chung (team không đặt thì shell
   * fail-closed).
   */
  setEgressPolicy(policy: EgressPolicy | null | undefined): void {
    this.egressPolicy = policy;
  }

  /**
   * v0.55: policy egress hiệu lực cho shell tools — team merge lên
   * trên policy chung (xem `resolveBotEgressPolicy`). Dùng bởi
   * `buildToolHost().getEgressPolicy` nên tool nào cũng đọc cùng một
   * nguồn này.
   */
  getEgressPolicy(): EgressPolicy | null | undefined {
    return this.resolveBotEgressPolicy();
  }

  /**
   * v0.55: policy egress hiệu lực cho một bot chạy trong ngữ cảnh team.
   * Team đọc live từ `<dataDir>/team.json` mỗi lần resolve (sửa team
   * trong Settings có hiệu lực ngay, không cần tạo lại bot hay restart
   * coordinator con).
   *  - Không đọc được team (không có dataDir / không có team.json /
   *    file hỏng) → trả policy chung nguyên vẹn (có thể `undefined` /
   *    `null`).
   *  - Team không đặt `egress` + policy chung là `null` (tắt) → `null`
   *    (giữ ý "tắt hẳn" của host).
   *  - Còn lại → `resolveTeamEgressPolicy(team, global)`: field team
   *    đặt thắng policy chung, field không đặt lấy theo policy chung,
   *    cả hai không có → `undefined` → caller fail-closed.
   */
  private resolveBotEgressPolicy(): EgressPolicy | null | undefined {
    const globalPolicy = this.egressPolicy;
    let team: TeamConfig | undefined;
    if (this.dataDir) {
      try {
        team = loadTeamConfig(this.dataDir);
      } catch {
        // team.json hỏng/không đọc được: coi như không có team, rơi
        // về policy chung (không crash bot vì file config lỗi).
        team = undefined;
      }
    }
    if (team === undefined) return globalPolicy;
    if (team.egress === undefined && globalPolicy === null) return null;
    return resolveTeamEgressPolicy(team, globalPolicy ?? undefined);
  }

  /**
   * v0.6: build the host callbacks for one bot's tool factories. The
   * callbacks close over the requesting bot so create_agent inherits its
   * provider (the child only ever holds keys main already passed in).
   */
  private buildToolHost(requesterBotId: string): ToolFactoryHost {
    return {
      createBot: (config) => this.createAgentBot(requesterBotId, config),
      sendToAgent: (botId, text) => this.sendToAgent(botId, text),
      setBotMode: (botId, mode) => this.setBotMode(botId, mode),
      listBotIds: () => [...this.bots.keys()],
      getBotProviderId: (botId) => this.bots.get(botId)?.providerConfig.id ?? null,
      searchAllHistories: (query) => this.searchAllHistories(query),
      getBotTranscript: (botId, limit) => this.getBotTranscript(botId, limit),
      getProviderConfig: (providerId) => this.getProviderConfigFor(providerId),
      getXBearer: () => this.xBearer,
      getGitHubToken: () => this.githubToken,
      getConnectorToken: (connectorId: string) =>
        this.connectorTokenSets.get(connectorId)?.accessToken ??
        this.connectorTokens[connectorId] ??
        null,
      getConnectorTokenProvider: (connectorId: string) =>
        this.connectorTokenProviderFor(requesterBotId, connectorId),
      getMcpOAuthStore: () => this.mcpOAuthStoreFor(requesterBotId),
      getMcpOAuthConfig: (serverName: string) =>
        this.mcpOAuthConfigs[serverName] ?? null,
      askMcpElicitation: (request) => this.askElicitation(requesterBotId, request),
      // v0.18 (W10c follow-up): sampling cho pool MCP — tra provider lúc
      // tool chạy (bot đã tồn tại), không phải lúc createBot. v0.23: nối
      // `callServerTool` pool truyền vào (client pool gọi ngược về server)
      // vào handler để provider gọi tool được thực thi thật. v0.24
      // (W17d): tiêm store lịch sử sampling dùng chung của bot để
      // `includeContext: 'allServers'` thấy lịch sử mọi server của bot
      // (pool + system) — đường pool không biết tên server nên handler
      // ghi vào store dưới khóa mặc định (xem `createSamplingHandler`).
      getSamplingHandler: (opts?: { callServerTool?: SamplingToolExecutor }) => {
        const entry = this.bots.get(requesterBotId);
        if (!entry) return null;
        return createSamplingHandler(entry.provider, {
          model: entry.bot.model || entry.providerConfig.defaultModel,
          contextStore: entry.samplingContextStore,
          ...(opts?.callServerTool ? { callServerTool: opts.callServerTool } : {}),
        });
      },
      openMcpAuthUrl: (url: string) => {
        this.emitEvent(requesterBotId, 'mcp.open-url', { url });
      },
      callSystemTool: (toolName, args) =>
        this.callSystemToolFor(requesterBotId, toolName, args),
      getAllowedSystemTools: () => [...this.allowedSystemTools],
      /** v0.14: user skills dir for the skill marketplace tools. */
      getUserSkillsDir: () => this.skillsDirs?.userSkillsDir ?? null,
      /** v0.31 (P1-2): trusted-A2A-agents file, shared with the desktop UI. */
      getTrustedA2aAgentsFile: () =>
        this.hooksStateDir ? path.join(this.hooksStateDir, 'a2a-trusted-agents.json') : null,
      /** v0.95 (Team D1): internet-data state file, shared with the desktop UI. */
      getInternetDataFile: () =>
        this.hooksStateDir ? path.join(this.hooksStateDir, 'internet-data.json') : null,
      /** v0.95 (Team D1): Brave Search API key (Vault-backed, seeded at createBot). */
      getBraveSearchApiKey: () => this.braveSearchApiKey,
      /** v0.95 (Team D1): forward a watch change as an agent event. */
      onWatchChanged: (event) => {
        this.emitEvent(requesterBotId, 'internet.watch-changed', {
          url: event.watch.url,
          summary: event.summary,
          checkedAt: event.checkedAt,
        });
      },
      /** v0.14: local-bot capabilities for the supervisor_dispatch tool. */
      listBotCapabilities: (agentIds) => this.listBotCapabilities(agentIds),
      /** v0.85 (P1-7): admin check + team dir for `manage_access` (wired by the host — desktop main via runCoordinatorStdio; absent = mutations refused fail-closed). */
      isTeamAdmin: this.isTeamAdmin,
      getTeamBaseDir: this.getTeamBaseDir,
      /** v0.95d4: userId local cho memory tools (đọc live từ profile.json). */
      getLocalUserId: () => {
        if (!this.dataDir) return null;
        try {
          return loadLocalProfile(this.dataDir)?.userId ?? null;
        } catch {
          return null;
        }
      },
      /** v0.55: policy egress hiệu lực (team + global) cho shell tools. */
      getEgressPolicy: () => this.resolveBotEgressPolicy(),
      /**
       * v0.58: meta-tool Composio runnable — [] khi source đang tắt
       * (gate trong `defaultToolFactory`), 3 meta-tool khi bật, cùng
       * session manager cho mọi bot. Tool tạo mới mỗi lần gọi (rẻ —
       * chỉ là object đóng trên manager dùng chung).
       */
      getComposioTools: () => this.getComposioMetaTools(),
    };
  }

  /**
   * v0.7: MCP OAuth token store for the mcp_auth tools. Process-wide
   * (keyed by server name), backed by the in-memory map. Every set is
   * also emitted as 'mcp.oauth-token' so main can persist it to Vault
   * namespace 'mcp-oauth' — the child never touches the Vault itself.
   */
  private mcpOAuthStoreFor(botId: string): McpOAuthStore {
    return {
      get: (key: string) => this.mcpOAuthTokens.get(key) ?? null,
      set: (key: string, value: string) => {
        this.mcpOAuthTokens.set(key, value);
        this.emitEvent(botId, 'mcp.oauth-token', { server: key, value });
      },
      delete: (key: string) => this.mcpOAuthTokens.delete(key),
    };
  }

  /**
   * v0.9d: TokenStore over the in-memory TokenSet map for one
   * connector. `setToken` is only ever called by getValidAccessToken
   * after a refresh, so every set is a refreshed TokenSet — it is
   * emitted as 'connector.oauth-token' for main to persist to Vault
   * (the child never touches the Vault itself). The emitted value is
   * the full TokenSet JSON (access + refresh + expiry); it never
   * contains client credentials — those live only in
   * connectorClientConfigs and are never put in a TokenSet.
   */
  private connectorTokenStoreFor(botId: string): TokenStore {
    return {
      getToken: async (connectorId: string) => {
        const stored = this.connectorTokenSets.get(connectorId);
        return stored ? { ...stored } : null;
      },
      setToken: async (connectorId: string, token: TokenSet) => {
        this.connectorTokenSets.set(connectorId, { ...token });
        this.emitEvent(botId, 'connector.oauth-token', {
          connectorId,
          value: JSON.stringify(token),
        });
      },
      clearToken: async (connectorId: string) => {
        this.connectorTokenSets.delete(connectorId);
      },
    };
  }

  /**
   * v0.9d: auto-refreshing token provider for one connector, or null
   * when auto-refresh cannot work for it:
   *  - unknown connector id, or no token stored at all -> null
   *    (the connector reports "not connected" via the static token
   *    fallback returning null).
   *  - token carries a refreshToken but main supplied no client
   *    config -> null: refresh needs a clientId the child does not
   *    have, so the connector falls back to the static token and a
   *    401 surfaces as TokenExpiredError ("kết nối lại") instead of
   *    a confusing token-endpoint failure.
   *  - static / non-expiring token (Slack xoxb, no refreshToken) or
   *    token + client config -> provider. A static token is never
   *    refreshed (framework: no expiresAt / no refreshToken means
   *    "use as-is"); a token with client config refreshes
   *    proactively (5-minute threshold, dedup) and on 401.
   * A fresh provider is built on every call (cheap closure) so a
   * client config supplied by a later createBot is picked up
   * immediately — providers are never cached with stale credentials.
   */
  private connectorTokenProviderFor(
    botId: string,
    connectorId: string,
  ): ConnectorTokenProvider | null {
    const def = CONNECTOR_DEFS[connectorId];
    if (!def) return null;
    const stored = this.connectorTokenSets.get(connectorId);
    if (!stored) return null;
    const config = this.connectorClientConfigs[connectorId];
    if (stored.refreshToken && !config) return null;
    return createConnectorTokenProvider(
      def,
      this.connectorTokenStoreFor(botId),
      {
        // No client config + no refreshToken: the id is never used
        // (getValidAccessToken returns the stored token without
        // refreshing), so '' is a safe placeholder, not a credential.
        clientId: config?.clientId ?? '',
        ...(config?.clientSecret ? { clientSecret: config.clientSecret } : {}),
      },
    );
  }

  // -------------------------------------------------------------------------
  // M7: connected apps — OAuth một lần, chia sẻ cho mọi bot
  // -------------------------------------------------------------------------

  /**
   * Trạng thái một app (tìm trong listStatuses). Ném lỗi khi app
   * không tồn tại — caller (RPC) chuyển thành lỗi rõ cho UI.
   */
  private async appStatusFor(appId: string): Promise<AppStatusView> {
    const statuses = await this.appAuthStore.listStatuses();
    const found = statuses.find((s) => s.app.id === appId);
    if (!found) throw new Error(`Không rõ app "${appId}".`);
    return found;
  }

  /**
   * Kết nối app cho MỌI bot cùng lúc: lưu TokenSet MỘT lần vào kho
   * dùng chung (map mà buildToolHost đọc trực tiếp) nên bot đã tạo
   * trước cũng dùng được ngay, không cần tạo lại bot. Main đã ghi
   * Vault trước khi gọi RPC này; lần ghi store ở đây emit
   * 'connector.oauth-token' để main persist lại (ghi trùng cùng giá
   * trị, vô hại).
   */
  async setSharedAppToken(params: {
    appId: string;
    token: TokenSet;
    accountLabel?: string;
  }): Promise<AppStatusView> {
    if (!params || typeof params.appId !== 'string' || !params.appId) {
      throw new Error('setSharedAppToken cần params {appId, token}.');
    }
    await this.appAuthStore.connect(params.appId, params.token, params.accountLabel);
    return this.appStatusFor(params.appId);
  }

  /**
   * v0.68b: kết nối app token (PAT dán tay, vd GitHub) cho MỌI bot
   * cùng lúc: lưu token thô vào kho dùng chung (trong bộ nhớ —
   * `githubToken`). Main đã ghi Vault trước khi gọi RPC này; bot đã
   * tạo trước cũng dùng được token mới ngay vì host.getGitHubToken
   * đọc `this.githubToken` lúc gọi tool. Trả trạng thái app sau khi
   * lưu (không chứa token).
   */
  async setPlainAppToken(params: {
    appId: string;
    token: string;
    accountLabel?: string;
  }): Promise<AppStatusView> {
    if (!params || typeof params.appId !== 'string' || !params.appId) {
      throw new Error('setPlainAppToken cần params {appId, token}.');
    }
    if (typeof params.token !== 'string' || !params.token.trim()) {
      throw new Error('setPlainAppToken cần params {appId, token} với token không rỗng.');
    }
    await this.appAuthStore.connectPlainToken(
      params.appId,
      params.token,
      params.accountLabel,
    );
    return this.appStatusFor(params.appId);
  }

  /**
   * Ngắt kết nối app cho MỌI bot cùng lúc: xóa token khỏi kho dùng
   * chung ngay — lần lấy token sau của bất kỳ bot nào cũng trả null
   * nên tool của app báo "chưa kết nối". Main xóa Vault song song.
   */
  async revokeSharedAppToken(params: { appId: string }): Promise<AppStatusView> {
    if (!params || typeof params.appId !== 'string' || !params.appId) {
      throw new Error('revokeSharedAppToken cần params {appId}.');
    }
    await this.appAuthStore.disconnect(params.appId);
    return this.appStatusFor(params.appId);
  }

  /**
   * v0.58: meta-tool Composio runnable cho một bot mới (gate của
   * `defaultToolFactory` gọi qua host). Tắt → [] (tool không xuất hiện
   * trong tool list); bật → 3 meta-tool mới, cùng session manager
   * dùng chung của coordinator. Bot đã tạo thì `setComposioState`
   * rebuild qua `rebuildComposioTools` thay vì đường này.
   */
  private getComposioMetaTools(): Tool[] {
    if (!this.composioSource.isEnabled()) return [];
    return createComposioMetaTools({ manager: this.composioManager });
  }

  /** v0.58: rebuild tool list của một bot đã tạo sau khi Composio đổi trạng thái. */
  private rebuildComposioTools(entry: BotEntry): void {
    entry.composioTools = this.getComposioMetaTools();
    entry.tools = [...entry.coreTools, ...entry.composioTools, ...entry.pluginTools];
  }

  /**
   * v0.58: RPC `composio.setState` — hợp đồng main process gọi
   * (xem client.ts `setComposioState`). Toggle source + từng toolkit
   * trên `defaultAppRegistry` (tái dùng `applyComposioPersistedState`
   * của state.ts), huỷ session Composio cũ (toolkit đổi → session
   * phải tạo lại đúng toolkit ở lần gọi tool sau), rebuild tool list
   * của mọi bot đã tạo. Trả trạng thái đã áp dụng + app id đã đăng ký.
   * Toolkit lạ → lỗi rõ ràng, không áp dụng gì (validate trước khi đổi).
   */
  async setComposioState(params: SetComposioStateParams): Promise<SetComposioStateResult> {
    if (
      !params ||
      typeof params !== 'object' ||
      typeof params.enabled !== 'boolean' ||
      !Array.isArray(params.toolkits)
    ) {
      throw new Error('composio.setState cần params {enabled: boolean, toolkits: string[]}.');
    }
    const toolkits = [...new Set(params.toolkits)];
    for (const toolkit of toolkits) {
      if (
        typeof toolkit !== 'string' ||
        !(COMPOSIO_TOOLKIT_SLUGS as readonly string[]).includes(toolkit)
      ) {
        throw new Error(
          `Không rõ toolkit Composio "${toolkit}" — chỉ có: ${COMPOSIO_TOOLKIT_SLUGS.join(', ')}.`,
        );
      }
    }
    applyComposioPersistedState(this.composioSource, { enabled: params.enabled, toolkits });
    await this.composioManager.invalidate();
    for (const entry of this.bots.values()) this.rebuildComposioTools(entry);
    // v0.59: vừa bật mà không đọc được key nào (safeStorage /
    // NO_STORAGE — file reader trả null, chưa seed) thì xin main seed
    // lại qua event `composio.key-needed` (payload không chứa key).
    // Main nghe event này thì đọc Vault bằng safeStorage rồi seed qua
    // RPC `composio.setApiKey`. Không spam khi tắt source.
    if (params.enabled && this.getComposioKeyStatus().hasKey === false) {
      this.emitEvent('', 'composio.key-needed', { reason: 'composio_key_missing' });
    }
    return this.getComposioState();
  }

  /** v0.58: RPC `composio.getState` — trạng thái Composio hiện tại (không chứa key). */
  getComposioState(): GetComposioStateResult {
    return {
      enabled: this.composioSource.isEnabled(),
      toolkits: this.composioSource.enabledToolkits(),
      registeredAppIds: this.composioSource.registeredAppIds(),
    };
  }

  /**
   * v0.59: trạng thái key Composio hiện tại — chỉ boolean + tên nguồn,
   * KHÔNG chứa key. `seeded` thắng fallback: có key seed thì nguồn là
   * 'seeded' dù file Vault cũng đọc được (đường seed là đường chính).
   */
  getComposioKeyStatus(): GetComposioKeyStatusResult {
    if (this.composioKeyReader.hasSeededKey()) {
      return { hasKey: true, seeded: true, source: 'seeded' };
    }
    let fallback: string | null = null;
    try {
      // Đọc lại fallback trực tiếp: reader() đã trả seeded trước (ở
      // đây seeded rỗng nên reader() == fallback), nhưng gọi tường
      // minh để không phụ thuộc thứ tự ưu tiên bên trong reader.
      fallback = this.composioKeyReader();
    } catch {
      fallback = null;
    }
    if (fallback !== null) return { hasKey: true, seeded: false, source: 'vault-file' };
    return { hasKey: false, seeded: false, source: 'none' };
  }

  /**
   * v0.59: seed (hoặc clear) key Composio trong bộ nhớ — dùng chung
   * cho RPC `composio.setApiKey` và param `composioApiKey` của
   * `createBot`. Key mới ghi ĐÈ key cũ (xoay key không cần
   * destroyBot — khác seed-only của `connectorTokenSets` /
   * `mcpOAuthTokens`). Chỉ huỷ session manager khi key hiệu lực
   * thật sự đổi (seed lại cùng key thì session cũ giữ nguyên).
   * `apiKey` null/undefined/rỗng = xoá key đã seed (về fallback).
   */
  private async seedComposioApiKey(apiKey: string | null | undefined): Promise<boolean> {
    const before = this.composioKeyReader();
    this.composioKeyReader.seed(apiKey);
    const after = this.composioKeyReader();
    if (before !== after) {
      await this.composioManager.invalidate();
    }
    return before !== after;
  }

  /**
   * v0.59: RPC `composio.setApiKey` — main seed key Composio cho
   * coordinator (main đọc Vault bằng safeStorage trong main process).
   * `apiKey` là key mới/xoay (ghi đè), null/rỗng = xoá key đã seed
   * (main gọi khi user xoá key trong Vault). Trả trạng thái key
   * (không chứa key). Key KHÔNG bao giờ log.
   */
  async setComposioApiKey(
    params: SetComposioApiKeyParams,
  ): Promise<SetComposioApiKeyResult> {
    if (!params || typeof params !== 'object') {
      throw new Error('composio.setApiKey cần params {apiKey?: string | null}.');
    }
    if (
      params.apiKey !== undefined &&
      params.apiKey !== null &&
      typeof params.apiKey !== 'string'
    ) {
      throw new Error('composio.setApiKey cần apiKey là string, null hoặc vắng.');
    }
    await this.seedComposioApiKey(params.apiKey ?? null);
    return this.getComposioKeyStatus();
  }

  /**
   * v0.88b: trạng thái user id Composio trong coordinator — chỉ
   * boolean, KHÔNG chứa user id. `userIdConfigured` = đang dùng id
   * do user cấu hình; `usingDefaultUserId` = đang dùng mặc định
   * 'local-user' (chưa cấu hình — session không thấy connection
   * đã connect trong dashboard Composio).
   */
  getComposioUserIdStatus(): GetComposioUserIdStatusResult {
    const usingDefault = this.composioManager.getUserId() === COMPOSIO_LOCAL_USER_ID;
    return { userIdConfigured: !usingDefault, usingDefaultUserId: usingDefault };
  }

  /**
   * v0.88b: RPC `composio.setUserId` — main seed user id Composio
   * cho coordinator (main đọc Vault bằng safeStorage trong main
   * process, đúng mẫu `composio.setApiKey`). `userId` là id mới
   * (ghi đè), null/rỗng = về mặc định 'local-user' (xoá id đã
   * cấu hình). Đổi id thật thì session manager huỷ session cũ
   * ngay (xem `ComposioSessionManager.setUserId`) — có hiệu lực
   * từ lần gọi tool sau, không cần restart app; giữ nguyên id thì
   * session cũ giữ nguyên. Sai định dạng → lỗi rõ, giữ nguyên id
   * cũ. Trả trạng thái user id (không chứa giá trị). Không log id.
   */
  async setComposioUserId(
    params: SetComposioUserIdParams,
  ): Promise<SetComposioUserIdResult> {
    if (!params || typeof params !== 'object') {
      throw new Error('composio.setUserId cần params {userId?: string | null}.');
    }
    if (
      params.userId !== undefined &&
      params.userId !== null &&
      typeof params.userId !== 'string'
    ) {
      throw new Error('composio.setUserId cần userId là string, null hoặc vắng.');
    }
    // resolveComposioUserId ném lỗi khi sai định dạng (giữ id cũ);
    // null/rỗng → về mặc định 'local-user'.
    const next = resolveComposioUserId(params.userId);
    await this.composioManager.setUserId(next);
    return this.getComposioUserIdStatus();
  }

  /**
   * v0.95 (Team D2): trạng thái media key trong coordinator — chỉ
   * danh sách provider id đã có key seed, KHÔNG chứa key.
   */
  getMediaKeyStatus(): GetMediaKeyStatusResult {
    return { configured: [...this.mediaApiKeys.keys()].sort() };
  }

  /**
   * v0.95 (Team D2): RPC `media.setKey` — main seed key của một
   * media provider cho coordinator (main đọc Vault namespace 'media'
   * bằng safeStorage trong main process, đúng mẫu
   * `composio.setApiKey`). Provider lạ → lỗi rõ, giữ nguyên key cũ;
   * `apiKey` null/rỗng = xoá key đã seed của provider đó (về chưa
   * cấu hình — image/video tool sau đó báo thiếu key thay vì dùng
   * key cũ). Trả trạng thái key (không chứa key). Key KHÔNG log.
   */
  async setMediaApiKey(params: SetMediaApiKeyParams): Promise<SetMediaApiKeyResult> {
    if (!params || typeof params !== 'object') {
      throw new Error('media.setKey cần params {providerId: string, apiKey?: string | null}.');
    }
    if (!isMediaProviderId(params.providerId)) {
      throw new Error(`media.setKey: không rõ media provider "${String(params.providerId)}".`);
    }
    if (params.apiKey !== undefined && params.apiKey !== null && typeof params.apiKey !== 'string') {
      throw new Error('media.setKey cần apiKey là string, null hoặc vắng.');
    }
    const next = typeof params.apiKey === 'string' ? params.apiKey.trim() : '';
    if (next) {
      // Validate trước khi ghi đè — key sai định dạng thì key cũ còn
      // nguyên (validateMediaApiKey ném lỗi, không chứa key).
      this.mediaApiKeys.set(params.providerId, validateMediaApiKey(next));
    } else {
      this.mediaApiKeys.delete(params.providerId);
    }
    return this.getMediaKeyStatus();
  }

  /**
   * v0.89c (Team E): RPC `composio.getConnectionStatus` — trạng thái
   * connection từng toolkit trong session hiện tại (qua
   * `ComposioSessionManager.getConnectionStatus`). Chỉ trả toolkit +
   * trạng thái + nhãn tài khoản; KHÔNG chứa user id, link OAuth hay
   * key. Toolkit lạ → lỗi rõ ràng (đúng mẫu `composio.setState`).
   * `toolkits` vắng/rỗng = toolkit đang bật.
   */
  async getComposioConnectionStatus(
    params: GetComposioConnectionStatusParams,
  ): Promise<GetComposioConnectionStatusResult> {
    const toolkits = params?.toolkits;
    if (toolkits !== undefined) {
      if (!Array.isArray(toolkits)) {
        throw new Error('composio.getConnectionStatus cần params {toolkits?: string[]}.');
      }
      for (const toolkit of toolkits) {
        if (typeof toolkit !== 'string' || !(COMPOSIO_TOOLKIT_SLUGS as readonly string[]).includes(toolkit)) {
          throw new Error(`Không rõ toolkit Composio "${String(toolkit)}".`);
        }
      }
    }
    return this.composioManager.getConnectionStatus(toolkits);
  }

  /** Trạng thái đầy đủ mọi app trong catalog (cho UI/API). */
  async listAppStatuses(): Promise<AppStatusView[]> {
    return this.appAuthStore.listStatuses();
  }

  /**
   * v0.51 (M7 cap wiring): đổi cap tool của một app (số tool tối đa
   * app đó được expose mỗi turn, 1..100). Ghi đè mặc định 10 — có hiệu
   * lực từ run sau của mọi bot (loop đọc caps mỗi lần tạo runner, xem
   * `appToolCaps` ở trên). Trả trạng thái app sau khi đổi để UI hiện
   * cap mới ngay (toolCap + cappedOutToolNames).
   */
  async setAppToolCap(params: { appId: string; cap: number }): Promise<AppStatusView> {
    if (!params || typeof params.appId !== 'string' || !params.appId) {
      throw new Error('setAppToolCap cần params {appId, cap}.');
    }
    this.appAuthStore.setToolCap(params.appId, params.cap);
    return this.appStatusFor(params.appId);
  }

  /**
   * v0.7: run a tool of the SYSTEM MCP server — the server named
   * `system` in the bot workspace's `.open-bot/mcp.json`. Connects,
   * calls the tool, and always closes the client. Throws a clear
   * error when no `system` server is configured (the host must add
   * one; there is no implicit default server).
   */
  private async callSystemToolFor(
    botId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const entry = this.bots.get(botId);
    if (!entry) throw new Error(`Không rõ bot "${botId}".`);
    let config;
    try {
      config = loadMcpConfig(entry.bot.workspaceDir);
    } catch (err) {
      throw new Error(`Không đọc được cấu hình MCP: ${(err as Error).message}`);
    }
    const server = config.servers['system'];
    if (!server) {
      throw new Error(
        'Chưa cấu hình MCP server "system" trong .open-bot/mcp.json — ' +
          'thêm một server tên "system" để mcp_system_exec có server để gọi.',
      );
    }
    // v0.23 (W15b follow-up): nối `callServerTool` — handler gọi tool
    // ngược về chính client hệ thống này (`client.callTool`). Handler
    // được tạo TRƯỚC khi client tồn tại nên dùng holder: sampling chỉ
    // tới sau initialize, lúc đó `systemClient` đã được gán (connectMcp
    // xong). Gọi trước lúc đó thì lỗi rõ thay vì treo.
    let systemClient: McpClient | null = null;
    const client = await connectMcp({
      ...server,
      name: 'system',
      // v0.13: system server cũng hỏi được user qua elicitation
      // (modal ở renderer, như mcp_call_tool qua pool).
      clientHandlers: {
        serverName: 'system',
        workspaceDir: entry.bot.workspaceDir,
        elicitationPrompt: (request) => this.askElicitation(botId, request),
        // v0.13+: system server xin LLM qua `sampling/createMessage`
        // thì dùng provider của chính bot này (chat text ngắn, không
        // tool, timeout 60s) — xem createSamplingHandler. Không có
        // provider thì không có handler này (không advertise sampling);
        // ở đây entry.provider luôn có nên sampling luôn bật cho
        // system server. Lỗi sampling thành lỗi MCP rõ ràng, không
        // crash run (dispatcher chuyển throw thành -32603). v0.23:
        // provider gọi tool trong sampling được thực thi qua
        // callServerTool (client này) thay vì lỗi "không có đường
        // gọi tool" như trước. v0.24 (W17d): tiêm store lịch sử
        // sampling dùng chung của bot (serverName 'system') để
        // `includeContext: 'allServers'` thấy lịch sử mọi server của
        // bot, và lượt sampling của system server cũng vào store cho
        // server khác đọc.
        samplingHandler: createSamplingHandler(entry.provider, {
          model: entry.bot.model || entry.providerConfig.defaultModel,
          serverName: 'system',
          contextStore: entry.samplingContextStore,
          callServerTool: async (name, args) => {
            if (!systemClient) {
              throw new Error('MCP sampling: client hệ thống chưa kết nối xong.');
            }
            return systemClient.callTool(name, args);
          },
        }),
      },
    });
    systemClient = client;
    try {
      return await client.callTool(toolName, args);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /**
   * v0.19 (W12e): bọc tool `plan_update` để ghi dấu duyệt plan.
   * Khi một lượt chạy gọi plan_update với reviewDecision "approve" và
   * tool trả về JSON thành công có approvalStatus "approved", dấu
   * loại `approve` (botId -> projectId) được ghi để run tiếp theo của
   * cùng bot được tự duyệt tool-call (executeRun). W16a: gọi với
   * reviewDecision "request-changes" và tool trả về JSON thành công
   * có approvalStatus "changes-requested" thì ghi dấu loại `revision`
   * — run tiếp theo chỉ tự duyệt riêng tool `plan_create`, các tool
   * khác vẫn hỏi approval (đồng bộ với RPC reviewPlan, xem reviewPlan).
   * Chỉ approve / request-changes thành công mới ghi: reject /
   * lỗi (output "Error: ..." — không phải JSON thành công) đều
   * không ghi dấu. Bọc tạo bản copy nông của
   * tool nên definition / needsApproval giữ nguyên; bọc áp cho cả
   * toolFactory mặc định lẫn factory tùy biến (test) vì chạy sau khi
   * factory trả tools, trước khi tools vào entry.coreTools — rebuild
   * tools ở setPluginEnabled vẫn giữ bản đã bọc.
   */
  private wrapPlanApprovalTool(botId: string, tools: Tool[]): Tool[] {
    return tools.map((tool) => {
      if (tool.definition.name !== 'plan_update') return tool;
      const originalExecute = tool.execute.bind(tool);
      return {
        ...tool,
        execute: async (args, ctx) => {
          const output = await originalExecute(args, ctx);
          const decision = args?.reviewDecision;
          if (decision !== 'approve' && decision !== 'request-changes') return output;
          if (typeof output !== 'string') return output;
          try {
            const parsed: unknown = JSON.parse(output);
            // Approve thành công -> approvalStatus "approved", dấu
            // `approve`; request-changes thành công -> approvalStatus
            // "changes-requested", dấu `revision` (W16a, đồng bộ RPC).
            const expectedStatus =
              decision === 'approve' ? 'approved' : 'changes-requested';
            const kind: 'approve' | 'revision' =
              decision === 'approve' ? 'approve' : 'revision';
            if (
              typeof parsed === 'object' &&
              parsed !== null &&
              (parsed as { approvalStatus?: unknown }).approvalStatus === expectedStatus &&
              typeof (parsed as { projectId?: unknown }).projectId === 'string' &&
              (parsed as { projectId: string }).projectId.length > 0
            ) {
              const ownerBotId =
                typeof ctx?.botId === 'string' && ctx.botId ? ctx.botId : botId;
              this.planApprovedRuns.set(ownerBotId, {
                projectId: (parsed as { projectId: string }).projectId,
                kind,
              });
            }
          } catch {
            // Output không phải JSON thành công (vd "Error: ...") — không ghi dấu.
          }
          return output;
        },
      };
    });
  }

  /**
   * v0.6: create a bot from inside the coordinator (create_agent tool).
   * The new bot reuses a provider config this child already holds (the
   * requester's, or any other bot's with the same provider id) — the child
   * never invents keys. An 'agent.created' event tells main to persist
   * the bot config (no key) so it survives restart and shows in the UI.
   */
  private createAgentBot(
    requesterBotId: string,
    config: {
      name?: string;
      providerId?: string;
      model?: string;
      systemPrompt?: string;
      workspaceDir?: string;
      autoApprove?: boolean;
      mode?: string;
    },
  ): { id: string; name: string; providerId: string; model: string } {
    const requester = this.bots.get(requesterBotId);
    const providerId = config.providerId?.trim() || requester?.providerConfig.id;
    if (!providerId) throw new Error('Không rõ provider cho bot mới.');
    let providerConfig: CreateBotProviderConfig | undefined;
    if (requester && requester.providerConfig.id === providerId) {
      providerConfig = requester.providerConfig;
    } else {
      for (const entry of this.bots.values()) {
        if (entry.providerConfig.id === providerId) {
          providerConfig = entry.providerConfig;
          break;
        }
      }
    }
    if (!providerConfig) {
      throw new Error(
        `Chưa có key cho provider "${providerId}" — tạo bot bằng provider của bot hiện tại hoặc của một bot đã có provider đó.`,
      );
    }
    const id = randomUUID();
    const workspaceDir =
      config.workspaceDir?.trim() ||
      (requester
        ? path.join(path.dirname(requester.bot.workspaceDir), id)
        : path.join(process.cwd(), '.open-bot', 'workspaces', id));
    const fullBot: BotConfig = {
      id,
      name: config.name?.trim() || 'Bot mới',
      providerId,
      model: config.model?.trim() || providerConfig.defaultModel || '',
      systemPrompt: config.systemPrompt ?? '',
      workspaceDir,
      autoApprove: config.autoApprove ?? false,
    };
    // Same creation path as RPC createBot (memory + provider + tools).
    const memory = new BotMemory(workspaceDir);
    try {
      memory.saveBot(fullBot);
      const provider: Provider =
        providerConfig.id === 'mock'
          ? createMockProvider([])
          : createProvider(providerConfig);
      const builtAgentTools = this.wrapPlanApprovalTool(
        id,
        this.toolFactory(memory, workspaceDir, id),
      );
      // v0.58: tách meta-tool Composio như createBotInner (để toggle
      // RPC rebuild được; xem `rebuildComposioTools`).
      const agentComposioTools = builtAgentTools.filter((t) =>
        (COMPOSIO_RUNNABLE_META_TOOLS as readonly string[]).includes(t.definition.name),
      );
      const agentCoreTools = builtAgentTools.filter(
        (t) => !(COMPOSIO_RUNNABLE_META_TOOLS as readonly string[]).includes(t.definition.name),
      );
      const tools = [...agentCoreTools, ...agentComposioTools];
      this.bots.set(id, {
        bot: fullBot,
        provider,
        providerConfig,
        tools,
        coreTools: agentCoreTools,
        composioTools: agentComposioTools,
        pluginTools: [],
        bundleSubagents: [],
        bundleSlashCommands: [],
        memory,
        maxSteps: 20,
        running: false,
        stopRequested: false,
        // v0.24 (W17d): store lịch sử sampling dùng chung của bot này.
        samplingContextStore: createSamplingContextStore(),
      });
      // M5: đăng ký bot vào harness registry (instance → process sống).
      this.attachBotToHarness(id, provider, providerConfig.id);
      // v0.11: đăng ký policy của bot vào AgentPermissions để rule engine
      // (v0.11c) có hiệu lực trong run thật. Boolean cũ: true → 'all'
      // (chạy như trước); false/không set → để trống → 'safe-only'
      // (mặc định mới: lệnh an toàn chạy ngay, lệnh nhạy cảm hỏi, tool
      // cần phê duyệt vẫn hỏi). KHÔNG map false → 'none': 'none' hỏi
      // mọi lệnh shell, khác hẳn hành vi cũ của autoApprove=false
      // (mọi bot mặc định đều false — map thẳng sẽ hỏi từng lệnh `ls`).
      // Mode 'none' vẫn dùng được khi policy đặt chuỗi 'none' trực tiếp.
      this.permissions.setBotPolicy(id, {
        autoApprove: fullBot.autoApprove ? 'all' : undefined,
        // v0.59 (UI-3): tool đã tắt trong màn Tools (BotConfig.denyTools,
        // persist trong settings của main) — deny thắng mọi lớp lọc.
        denyTools: fullBot.denyTools ? [...fullBot.denyTools] : undefined,
        // v0.64 (skills per-bot): như denyTools — skill đã tắt trong
        // màn Tools (BotConfig.denySkills) — deny thắng mọi lớp lọc
        // skill (index / body / fork) trong executeRun.
        denySkills: fullBot.denySkills ? [...fullBot.denySkills] : undefined,
      });
      if (config.mode) {
        try {
          memory.setMemory(id, 'agent:mode', config.mode);
        } catch {
          // Mode is advisory; a failed write must not fail creation.
        }
      }
    } catch (err) {
      try {
        memory.close();
      } catch {
        // Already closed — nothing to do.
      }
      throw err;
    }
    this.emitEvent(id, 'agent.created', { bot: fullBot });
    return { id, name: fullBot.name, providerId, model: fullBot.model };
  }

  /** v0.6: send a message to another bot (message_agent tool). '' = queued. */
  private async sendToAgent(botId: string, text: string): Promise<string> {
    const entry = this.bots.get(botId);
    if (!entry) throw new Error(`Không rõ bot "${botId}".`);
    if (entry.running) return '';
    const result = await this.run({ botId, text });
    return result.text;
  }

  /**
   * v0.97 (Team T4): post-turn sleep hook — called once per completed
   * run (see executeRun). Builds the sleep agent for this bot, feeds
   * it the last 20 history rows as episodes, and lets
   * `scheduleSleepAfterTurn` decide (step counter + threshold +
   * mock/CLI gate) whether a background consolidation run starts.
   * Fully best-effort: any failure is swallowed here so memory work
   * can never break a chat turn. No network/Ollama probe happens on
   * this path — the sleep run itself only embeds when an embedder is
   * configured, with a short timeout and a keyword fallback.
   */
  private maybeRunSleepAfterTurn(entry: BotEntry, botId: string): void {
    try {
      const providerId = entry.providerConfig.id;
      const providerKind = PROVIDERS.find((p) => p.id === providerId)?.kind;
      const workspaceDir = entry.bot.workspaceDir;
      const episodes = episodesFromHistory(
        entry.memory.getHistory(botId, 20).map((m) => ({ role: m.role, content: m.content })),
      );
      let userId: string | undefined;
      try {
        userId = this.dataDir ? loadLocalProfile(this.dataDir)?.userId : undefined;
      } catch {
        userId = undefined;
      }
      scheduleSleepAfterTurn({
        agent: new SleepTimeAgent(workspaceDir, botId),
        episodes,
        providerId,
        providerKind,
        longTerm: new LongTermMemory(workspaceDir),
        blocks: new MemoryBlockStore(workspaceDir),
        graph: new TemporalKnowledgeGraph(workspaceDir),
        ...(userId ? { userId } : {}),
      });
    } catch {
      // Ignore: memory must never break a chat turn.
    }
  }

  // -------------------------------------------------------------------------
  // v0.12: handoff chuẩn (transfer_to_X) — dynamic tools, dựng mới mỗi run
  // -------------------------------------------------------------------------

  /**
   * Một tool `transfer_to_<slug>` cho mỗi bot khác (không tính bot gọi).
   * Dựng mới mỗi run từ danh sách bot hiện tại nên bot tạo/xoá sau vẫn
   * hiện đúng. Tool chỉ chuyển việc — không tự chạy việc của bot đích.
   */
  private transferToolsFor(botId: string): Tool[] {
    const from = this.bots.get(botId);
    if (!from) return [];
    const tools: Tool[] = [];
    for (const target of this.bots.values()) {
      if (target.bot.id === botId) continue;
      const toolName = transferToolNameFor(target.bot.name);
      tools.push({
        definition: {
          name: toolName,
          description:
            `Chuyển việc đang làm sang bot "${target.bot.name}" (handoff): toàn bộ hội thoại ` +
            `liên quan + yêu cầu gốc + kết quả trung gian được mang sang, bot đích tiếp tục làm ` +
            `thay vì bắt đầu lại từ đầu. Dùng khi việc này thuộc chuyên môn của bot đích.`,
          parameters: {
            type: 'object',
            properties: {
              task: {
                type: 'string',
                description: 'Việc cần bot đích làm — ghi rõ, đầy đủ ngữ cảnh cần thiết.',
              },
              reason: {
                type: 'string',
                description: 'Lý do chuyển việc (tùy chọn).',
              },
            },
            required: ['task'],
          },
        },
        needsApproval: false,
        execute: async (args) => {
          const task = typeof args['task'] === 'string' ? args['task'].trim() : '';
          if (!task) return 'Error: transfer cần argument "task" (việc cần bot đích làm).';
          const reason = typeof args['reason'] === 'string' ? args['reason'] : undefined;
          return this.executeHandoff(botId, target.bot.id, { task, reason });
        },
      });
    }
    return tools;
  }

  /**
   * Thực hiện một lần handoff: kiểm tra hop (chặn cứng khi vượt tối đa),
   * cảnh báo khi cặp chuyển đã từng xảy ra (dấu hiệu lặp A→B→A), build
   * payload từ lịch sử của bot nguồn + task hiện tại, chạy bot đích với
   * prompt handoff rồi trả lời của bot đích về cho bot nguồn.
   *
   * Bot đích đang chạy thì KHÔNG chờ (tránh deadlock vòng handoff khi
   * các bot chuyển việc cho nhau) — trả thông báo bận để bot nguồn thử
   * lại sau hoặc tự làm tiếp.
   */
  private async executeHandoff(
    fromBotId: string,
    toBotId: string,
    opts: { task: string; reason?: string },
  ): Promise<string> {
    const from = this.getBot(fromBotId);
    const to = this.getBot(toBotId);
    if (to.running) {
      return (
        `Bot "${to.bot.name}" đang chạy việc khác nên chưa nhận handoff được — ` +
        `thử lại sau hoặc tự làm tiếp thay vì chờ.`
      );
    }
    const chain = this.handoffChains.get(fromBotId) ?? [];
    const hop = checkHop(chain.length);
    if (!hop.allowed) return hop.blockReason ?? 'Đã vượt giới hạn handoff.';
    const repeat = wouldRepeatHandoff(chain, from.bot.name, to.bot.name);
    let history: HandoffMessage[] = [];
    try {
      history = from.memory
        .getHistory(fromBotId, 50)
        .map((m) => ({ role: m.role as HandoffMessage['role'], content: m.content }))
        // createHandoff từ chối dòng nội dung rỗng (vd message chỉ có toolCalls).
        .filter((m) => m.content.trim() !== '');
    } catch {
      // Lịch sử đọc lỗi thì handoff vẫn chạy với task hiện tại.
    }
    const transcript: HandoffMessage[] = [
      ...history,
      { role: 'user', content: opts.task },
    ];
    const payload = createHandoff({
      fromBot: from.bot.name,
      toBot: to.bot.name,
      reason: opts.reason,
      transcript,
      history: chain,
    });
    this.handoffLog.recordPayload(payload);
    const newRecord = payload.history[payload.history.length - 1];
    const newChain = newRecord ? [...chain, newRecord] : [...chain];
    this.handoffChains.set(toBotId, newChain);
    this.handoffChains.set(fromBotId, newChain);
    // Đánh dấu run sắp tới là run handoff để executeRun không xoá chuỗi.
    const runId = randomUUID();
    this.handoffRunIds.add(runId);
    try {
      const reply = await this.run({
        botId: toBotId,
        text: formatHandoffForPrompt(payload),
        runId,
      });
      const warn = repeat
        ? `[Cảnh báo: cặp handoff ${from.bot.name} → ${to.bot.name} đã từng xảy ra — có thể đang lặp, nếu kết quả không tiến triển thì dừng chuyển tiếp.]\n`
        : '';
      return (
        `${warn}Đã chuyển cho ${to.bot.name} (hop ${hop.nextHop}/${hop.maxHops}). ` +
        `Trả lời của ${to.bot.name}:\n${reply.text}`
      );
    } finally {
      this.handoffRunIds.delete(runId);
    }
  }

  // -------------------------------------------------------------------------
  // v0.37 (P1-3): tool `create_handoff` — agent tự bàn giao công việc
  // thành record bền (khác transfer_to_X ở trên: chỉ LƯU bản bàn giao,
  // bot đích chạy ở run khác, có thể nhiều giờ sau). Dựng mới mỗi run
  // từ factory trong @open-bot/tools (dynamic require + guarded như
  // createA2aTools trong defaultToolFactory): thiếu factory thì run chỉ
  // không có tool này, không fail bot. Transcript lấy từ BotMemory của
  // bot gọi; record lưu vào SessionHandoffStore của coordinator.
  // -------------------------------------------------------------------------

  private sessionHandoffToolsFor(botId: string): Tool[] {
    const entry = this.bots.get(botId);
    if (!entry) return [];
    let factory:
      | ((opts: {
          botId?: string;
          botName?: string;
          getTranscript?: () => Array<{ role: string; content: string }>;
          saveRecord?: (record: SessionHandoffRecord) => void | Promise<void>;
          secrets?: string[];
        }) => Tool[])
      | undefined;
    try {
      const toolsMod = require('@open-bot/tools') as {
        createSessionHandoffTools?: typeof factory;
      };
      factory = toolsMod.createSessionHandoffTools;
    } catch {
      return [];
    }
    if (typeof factory !== 'function') return [];
    const secrets = [entry.providerConfig.apiKey, this.xBearer, this.githubToken].filter(
      (s): s is string => typeof s === 'string' && s.length > 0,
    );
    try {
      return factory({
        botId: entry.bot.id,
        botName: entry.bot.name,
        getTranscript: () => {
          try {
            return entry.memory
              .getHistory(botId, 50)
              .map((m) => ({ role: m.role as string, content: m.content }))
              .filter((m) => m.content.trim() !== '');
          } catch {
            return [];
          }
        },
        saveRecord: (record: SessionHandoffRecord) => {
          this.getSessionHandoffStore().save(record);
        },
        secrets,
      });
    } catch (err) {
      process.stderr.write(
        `[coordinator] Không dựng được tool create_handoff cho bot "${botId}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return [];
    }
  }

  /**
   * v0.12: tool `run_workflow` — chạy một workflow khai báo có sẵn
   * (research-brief / plan-edit-test-fix) với runner thật nối vào
   * AgentRunner + tool registry của bot này.
   */
  private runWorkflowTool(entry: BotEntry): Tool {
    const workflows: WorkflowDefinition[] = [researchBriefWorkflow, planEditTestFixWorkflow];
    const byId = new Map(workflows.map((w) => [w.id, w]));
    return {
      definition: {
        name: 'run_workflow',
        description:
          'Chạy một workflow khai báo có sẵn (graph các bước agent/tool): ' +
          workflows.map((w) => `${w.id} — ${w.name}`).join('; ') +
          '. Truyền input qua `input` (object, vd {topic: "..."} cho research-brief).',
        parameters: {
          type: 'object',
          properties: {
            workflowId: {
              type: 'string',
              description: `Id workflow: ${workflows.map((w) => w.id).join(', ')}.`,
            },
            input: {
              type: 'object',
              description: 'State ban đầu cho workflow (tùy chọn).',
            },
          },
          required: ['workflowId'],
        },
      },
      needsApproval: false,
      execute: async (args, ctx) => {
        const workflowId = typeof args['workflowId'] === 'string' ? args['workflowId'] : '';
        const def = byId.get(workflowId);
        if (!def) {
          return `Error: không rõ workflow "${workflowId}" — chỉ có: ${workflows.map((w) => w.id).join(', ')}.`;
        }
        const initialState =
          args['input'] && typeof args['input'] === 'object' && !Array.isArray(args['input'])
            ? (args['input'] as Record<string, unknown>)
            : {};
        const runner = createWorkflowRunner({
          provider: entry.provider,
          tools: entry.tools,
          bot: entry.bot,
          events: {
            onText: () => undefined,
            onToolCall: () => undefined,
            onToolResult: () => undefined,
            onApprovalNeeded: async () => false,
          },
          signal: ctx.signal,
        });
        const result = await runWorkflow(def, runner, { initialState, signal: ctx.signal });
        if (result.status === 'done') {
          return typeof result.output === 'string'
            ? result.output
            : JSON.stringify(result.output ?? result.state, null, 2);
        }
        return (
          `Workflow "${workflowId}" kết thúc với trạng thái ${result.status}` +
          (result.error ? `: ${result.error}` : '.') +
          ` (đã chạy ${result.history.length} node).`
        );
      },
    };
  }

  /**
   * v0.12: tool `delegate_specialized` — giao cùng lúc nhiều việc cho các
   * subagent chuyên biệt (mỗi cái instructions/tool/model/timeout riêng),
   * chạy song song rồi gộp kết quả (kèm mục xung đột nếu có).
   */
  private delegateSpecializedTool(): Tool {
    return {
      definition: {
        name: 'delegate_specialized',
        description:
          'Giao song song nhiều việc cho các subagent chuyên biệt (mỗi subagent có instructions, ' +
          'subset tool, model, timeout riêng), rồi gộp kết quả. Dùng khi một việc lớn tách được ' +
          'thành các phần độc lập cần chuyên môn khác nhau.',
        parameters: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              description: 'Danh sách việc giao — mỗi phần tử {name, instructions, task, tools?, model?, timeoutMs?, maxSteps?}.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  instructions: { type: 'string' },
                  task: { type: 'string' },
                  tools: { type: 'array', items: { type: 'string' } },
                  model: { type: 'string' },
                  timeoutMs: { type: 'number' },
                  maxSteps: { type: 'number' },
                  shadowWorkspace: {
                    type: 'boolean',
                    description:
                      'true = chạy subagent trong git worktree riêng (shadow workspace) để không đụng workspace chính; chỉ có tác dụng khi workspace là git repo.',
                  },
                },
                required: ['name', 'instructions', 'task'],
              },
            },
          },
          required: ['tasks'],
        },
      },
      needsApproval: false,
      execute: async (args, ctx) => {
        if (!ctx.runSpecializedSubagents) {
          return 'Error: phiên này không hỗ trợ subagent chuyên biệt.';
        }
        const raw = args['tasks'];
        if (!Array.isArray(raw) || raw.length === 0) {
          return 'Error: delegate_specialized cần argument "tasks" là danh sách không rỗng.';
        }
        const tasks: Array<{ spec: { name: string; instructions: string; tools?: string[]; model?: string; timeoutMs?: number; maxSteps?: number; shadowWorkspace?: boolean }; task: string }> = [];
        for (const item of raw) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return 'Error: mỗi task phải là object {name, instructions, task}.';
          }
          const rec = item as Record<string, unknown>;
          const name = typeof rec['name'] === 'string' ? rec['name'].trim() : '';
          const instructions = typeof rec['instructions'] === 'string' ? rec['instructions'] : '';
          const task = typeof rec['task'] === 'string' ? rec['task'] : '';
          if (!name || !instructions || !task) {
            return 'Error: mỗi task cần đủ name, instructions, task (chuỗi không rỗng).';
          }
          const tools = Array.isArray(rec['tools'])
            ? rec['tools'].filter((t): t is string => typeof t === 'string')
            : undefined;
          tasks.push({
            spec: {
              name,
              instructions,
              tools,
              model: typeof rec['model'] === 'string' ? rec['model'] : undefined,
              timeoutMs: typeof rec['timeoutMs'] === 'number' ? rec['timeoutMs'] : undefined,
              maxSteps: typeof rec['maxSteps'] === 'number' ? rec['maxSteps'] : undefined,
              shadowWorkspace: rec['shadowWorkspace'] === true ? true : undefined,
            },
            task,
          });
        }
        return ctx.runSpecializedSubagents(tasks);
      },
    };
  }

  /** v0.6: persist a bot's working mode in its memory. */
  private setBotMode(
    botId: string,
    mode: AgentMode,
  ): { id: string; name: string; providerId: string; model: string } {
    const entry = this.getBot(botId);
    entry.memory.setMemory(botId, 'agent:mode', mode);
    return { id: entry.bot.id, name: entry.bot.name, providerId: entry.bot.providerId, model: entry.bot.model };
  }

  /** v0.6: keyword search across every bot's history (search_conversations). */
  private searchAllHistories(
    query: string,
  ): Array<{ botId: string; role: string; content: string }> {
    const q = query.toLowerCase();
    const hits: Array<{ botId: string; role: string; content: string }> = [];
    for (const entry of this.bots.values()) {
      let rows: Array<{ role: string; content: string }> = [];
      try {
        rows = entry.memory.getHistory(entry.bot.id, 200);
      } catch {
        continue;
      }
      for (const row of rows) {
        if (row.content.toLowerCase().includes(q)) {
          hits.push({ botId: entry.bot.id, role: row.role, content: row.content });
        }
      }
      if (hits.length >= 50) break;
    }
    return hits.slice(0, 50);
  }

  /** v0.6: full transcript of one bot (read_agent_transcript tool). */
  private getBotTranscript(
    botId: string,
    limit = 50,
  ): Array<{ botId: string; role: string; content: string }> {
    const entry = this.getBot(botId);
    return entry.memory
      .getHistory(botId, limit)
      .map((r) => ({ botId, role: r.role, content: r.content }));
  }

  /** v0.6: provider media config for image/video generation tools. */
  private getProviderConfigFor(providerId: string): {
    id: string;
    apiKey?: string;
    baseUrl?: string;
    imageModel?: string;
    videoModel?: string;
    videoEndpoint?: string;
  } | null {
    for (const entry of this.bots.values()) {
      if (entry.providerConfig.id === providerId) {
        const cfg = entry.providerConfig;
        // v0.95 (Team D2): bot có key chat thì dùng key đó (key chat
        // và key media của cùng provider thường là một); bot không có
        // key thì rơi xuống media key bên dưới thay vì trả null.
        if (cfg.apiKey) {
          return {
            id: cfg.id,
            apiKey: cfg.apiKey,
            baseUrl: cfg.baseUrl,
            imageModel:
              cfg.id === 'openai'
                ? 'gpt-image-1'
                : cfg.id === 'xai'
                  ? 'grok-2-image'
                  : cfg.id === 'gemini'
                    ? 'gemini-nano-banana-2.1'
                    : undefined,
            // v0.87d: Gemini image model (Nano Banana). Live generation
            // NOT verified on this machine (no Gemini key inside this
            // repo) — the built-in HttpGeminiImageProvider speaks the
            // public generateContent shape (POST /v1beta/models/{model}:
            // generateContent, responseModalities ["TEXT","IMAGE"],
            // inlineData part), see packages/tools/src/geminiImage.ts.
            // v0.86b (P1-5): OpenAI video model (Sora). Live generation
            // NOT verified on this machine (no OpenAI key here) — the
            // built-in HttpVideoProvider speaks the public Sora async
            // shape (POST /v1/videos, GET /v1/videos/{id},
            // GET /v1/videos/{id}/content). xAI gets no default: Grok
            // Imagine is app-only, no public video endpoint.
            videoModel: cfg.id === 'openai' ? 'sora-2' : undefined,
          };
        }
        break;
      }
    }
    // v0.95 (Team D2): media-key fallback — key user nhập ở Settings
    // → Media keys (Vault namespace 'media', main seed vào bộ nhớ
    // qua RPC `media.setKey` / param `mediaApiKeys` của `createBot`).
    // Nhờ đó image/video chạy được cho cả provider không có bot chat
    // nào dùng (vd stability, runway, luma, pika) và cho bot chat
    // không có key. Không có key → null, tool báo thiếu key rõ ràng
    // kèm hướng dẫn (xem mediaKeyMissingMessage) thay vì crash.
    return buildMediaProviderConfig(providerId, this.mediaApiKeys.get(providerId));
  }

  /** v0.4: shared UsageTracker for this child (one usage.json file). */
  private getUsageTracker(storePath: string): UsageTracker {
    if (!this.usageTracker || this.usageTracker.path !== storePath) {
      this.usageTracker = new UsageTracker({ storePath });
    }
    return this.usageTracker;
  }

  /** v0.4: lazily load the skill registry from the dirs main passed in. */
  private getSkillRegistry(dirs?: {
    userSkillsDir?: string;
    pluginsDir?: string;
    stateDir?: string;
  }): SkillRegistry | null {
    if (!dirs) return this.skillRegistry;
    if (!this.skillRegistry) {
      this.skillRegistry = new SkillRegistry({
        userSkillsDir: dirs.userSkillsDir,
        pluginsDir: dirs.pluginsDir,
        stateDir: dirs.stateDir,
      });
      try {
        this.skillRegistry.load();
      } catch (err) {
        process.stderr.write(
          `[coordinator] Không tải được skill: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    return this.skillRegistry;
  }

  /**
   * v0.14: wire the non-tool parts of plugin bundles into the bot:
   *  - skill (directory) → SkillRegistry (metadata only, plugin precedence);
   *  - skill (inline) → SkillRegistry từ text (body nạp ngay);
   *  - MCP server → merged into the bot workspace's `.open-bot/mcp.json`
   *    (never overwrites an existing server with the same name);
   *  - slash command → SlashCommandDef (template = nội dung file);
   *  - subagent → spec, hinted into the run's system prompt (executeRun).
   *  - hook WITH a script → registered on the shared HookRegistry via
   *    `registerScriptHook` (v0.18): the script runs out-of-process on
   *    every invocation, cwd = bot workspace, allowed dirs = workspace
   *    + bundle dir. A missing/unreadable script file is warned on
   *    stderr and that hook is skipped (never breaks bot creation).
   *  - hook WITHOUT a script (matcher-only) → still NOT wired, as
   *    before (no matcher executor exists yet); silently skipped.
   * Never throws: one bad part is logged and skipped.
   */
  private wireBundleParts(
    workspaceDir: string,
    parts: BundlePartsView[],
  ): { subagents: SpecializedSubagentSpec[]; slashCommands: SlashCommandDef[] } {
    const subagents: SpecializedSubagentSpec[] = [];
    const slashCommands: SlashCommandDef[] = [];
    const registry = this.skillRegistry;
    for (const part of parts) {
      try {
        if (part.skill && registry) {
          if (part.skill.kind === 'directory' && part.skill.dir) {
            registry.addSkillsFromDir(part.skill.dir, 'plugin', part.manifest.id);
          } else if (part.skill.kind === 'inline') {
            const inline = part.skill;
            const allowed =
              inline.allowedTools && inline.allowedTools.length > 0
                ? `\nallowed-tools: ${inline.allowedTools.join(', ')}\n`
                : '';
            const text =
              `---\nname: ${inline.name}\ndescription: ${inline.description ?? ''}\n${allowed}---\n\n${inline.instructions ?? ''}\n`;
            registry.addSkillFromText(text, 'plugin');
          }
        }
      } catch (err) {
        process.stderr.write(
          `[coordinator] Không nối được skill của bundle "${part.manifest.id}": ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      try {
        if (part.mcpServer) {
          const ensured = ensureMcpServer(workspaceDir, part.mcpServer.name, part.mcpServer.config);
          if (!ensured.added) {
            process.stderr.write(
              `[coordinator] MCP server "${part.mcpServer.name}" của bundle "${part.manifest.id}" ` +
                `đã có trong mcp.json (${ensured.reason === 'already-present' ? 'giữ nguyên' : 'tên đã tồn tại với config khác, không ghi đè'}).\n`,
            );
          }
        }
      } catch (err) {
        process.stderr.write(
          `[coordinator] Không nối được MCP server của bundle "${part.manifest.id}": ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      for (const cmd of part.slashCommands ?? []) {
        try {
          const template = fs.readFileSync(cmd.file, 'utf8');
          slashCommands.push({
            name: cmd.name,
            description: cmd.description,
            source: 'plugin',
            file: cmd.file,
            promptTemplate: template,
          });
        } catch (err) {
          process.stderr.write(
            `[coordinator] Không đọc được slash command "${cmd.name}" của bundle "${part.manifest.id}": ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      if (part.subagent) subagents.push(part.subagent);
      // v0.18: bundle hook scripts — run out-of-process via the script runner.
      for (const hook of part.hooks ?? []) {
        if (!hook.script) continue; // matcher-only: still unwired, as before.
        try {
          const hookRegistry = this.getHookRegistry();
          hookRegistry.registerScriptHook(
            {
              name: hook.name,
              description: `Bundle hook "${hook.name}" (${hook.event}) từ bundle "${part.manifest.id}".`,
              events: [hook.event],
              source: 'plugin',
              workspaceDir,
              allowedDirs: [part.dir],
            },
            hook.script,
          );
        } catch (err) {
          process.stderr.write(
            `[coordinator] Không nối được hook "${hook.name}" của bundle "${part.manifest.id}": ` +
              `${err instanceof Error ? err.message : String(err)} — bỏ qua hook.\n`,
          );
        }
      }
    }
    return { subagents, slashCommands };
  }

  /**
   * v0.14: registry slash của một bot — nguồn duy nhất cho cả resolve
   * (khi chạy lệnh) lẫn liệt kê (popup autocomplete, v0.60 UI-6).
   * Commands từ `<workspace>/.open-bot/commands/*.md` (per-bot) cộng
   * bundle slash commands của bot; trùng tên thì markdown thắng
   * (bundle bị bỏ qua lặng lẽ). Thư mục commands không có / không đọc
   * được thì chỉ còn lệnh bundle, không throw.
   */
  private buildSlashRegistry(entry: BotEntry): SlashCommandRegistry {
    const registry = new SlashCommandRegistry();
    try {
      registry.registerFromMarkdown(path.join(entry.bot.workspaceDir, '.open-bot', 'commands'));
    } catch {
      // No commands dir (or unreadable): bundles may still provide some.
    }
    for (const def of entry.bundleSlashCommands) {
      try {
        registry.register(def);
      } catch {
        // Duplicate name (markdown wins): skip the bundle one silently.
      }
    }
    return registry;
  }

  /**
   * v0.14: resolve a slash command in the run text (`/name args`).
   * Commands come from the bot workspace's `.open-bot/commands/*.md`
   * (per-bot) plus the bot's bundle slash commands. Returns the rendered
   * prompt (or null when the text is not a known slash command — the text
   * then goes to the model unchanged).
   */
  private resolveSlashCommand(
    entry: BotEntry,
    text: string,
  ): { name: string; rendered: string } | null {
    const registry = this.buildSlashRegistry(entry);
    const parsed = registry.parse(text);
    if (!parsed) return null;
    const def = registry.find(parsed.name);
    if (!def) return null;
    return { name: parsed.name, rendered: registry.renderPrompt(def, parsed.args) };
  }

  /**
   * v0.60 (UI-6): RPC `listSlashCommands` — liệt kê lệnh slash của một
   * bot đã tạo (tên + mô tả) cho popup autocomplete. Tái dùng đúng
   * registry của `resolveSlashCommand` (markdown + bundle, markdown
   * thắng khi trùng tên) — không có danh sách riêng, không hardcode.
   * Chỉ trả `{ name, description }` — promptTemplate/file/run không
   * đi qua IPC. Bot chưa tạo / botId rỗng → throw (như listBotTools).
   */
  listSlashCommands(params: ListSlashCommandsParams): ListSlashCommandsResult {
    if (!params || typeof params.botId !== 'string' || params.botId.trim() === '') {
      throw new Error('listSlashCommands cần params {botId}.');
    }
    const entry = this.getBot(params.botId);
    return this.buildSlashRegistry(entry)
      .list()
      .map((def) => ({ name: def.name, description: def.description }));
  }

  /**
   * v0.10: shared hook registry with the sandbox denylist as the default
   * PreToolUse hook. The hook function comes from @open-bot/tools via the
   * same dynamic require as the tool factory (see header note).
   * v0.18: also the registry `wireBundleParts` registers bundle hook
   * scripts into (a bot is created — and its bundles wired — before
   * the first run asks for a HookRunner, so the registry must exist
   * independently of the runner).
   */
  private getHookRegistry(): HookRegistry {
    if (!this.hookRegistry) {
      const registry = new HookRegistry(
        this.hooksStateDir ? { stateDir: this.hooksStateDir } : {},
      );
      try {
        const toolsMod = require('@open-bot/tools') as {
          createDenylistHook?: () => HookDefinition;
        };
        const hook = toolsMod.createDenylistHook?.();
        if (hook) registry.register(hook);
      } catch (err) {
        process.stderr.write(
          `[coordinator] Không tải được denylist hook: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      // v0.11: glob-rules hook — sau mỗi tool ghi file, gợi ý chạy lệnh rule
      // (vd *.ts → typecheck) theo `.open-bot/rules.json` của workspace đó.
      try {
        const globHook = createGlobRulesHook((workspaceDir) => {
          if (!workspaceDir) return [];
          let store = this.rulesStores.get(workspaceDir);
          if (!store) {
            store = new RulesStore(workspaceDir);
            this.rulesStores.set(workspaceDir, store);
          }
          return store.getRules();
        });
        registry.register(globHook);
      } catch (err) {
        process.stderr.write(
          `[coordinator] Không tải được glob-rules hook: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      // v1.01 (T2): shell-command hooks từ Settings —
      // `<stateDir>/hooks-commands.json` (main ghi file này qua IPC
      // `hooks:commands-save`; xem `apps/desktop/src/main/main.ts`).
      // Invalid entries chỉ được báo, không bao giờ chặn bot chạy.
      if (this.hooksStateDir) {
        try {
          const raw = fs.readFileSync(
            path.join(this.hooksStateDir, HOOK_COMMANDS_FILE),
            'utf8',
          );
          const parsed: unknown = JSON.parse(raw);
          const commands = Array.isArray(parsed)
            ? parsed
            : ((parsed as { commands?: unknown } | null)?.commands ?? []);
          const result = registry.applyCommandSettings(
            { commands: commands as HookCommandSettingsEntry[] },
            {
              logger: (m: string) => process.stderr.write(`[coordinator] hook: ${m}\n`),
            },
          );
          for (const bad of result.invalid) {
            process.stderr.write(
              `[coordinator] Hook command "${bad.name}" không hợp lệ, đã bỏ qua: ${bad.issues.join('; ')}\n`,
            );
          }
        } catch (err) {
          // File chưa có (chưa cấu hình hook nào) là bình thường; chỉ
          // báo lỗi khi file CÓ mà đọc/parse hỏng.
          if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            process.stderr.write(
              `[coordinator] Không tải được hook commands: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }
        // v1.01 (T2): test-gate preset — chỉ đăng ký khi có lệnh kiểm tra
        // trong `<stateDir>/hooks-test-gate.json` (Settings → Hooks → Test
        // gate). Không có lệnh = gate cho qua mọi subagent (xem testGate.ts).
        try {
          const gate = readTestGateConfig(this.hooksStateDir);
          const gateCommands = testGateCommands(gate);
          if (gateCommands.length > 0) {
            registry.register(
              createTestGateHook({
                commands: gateCommands,
                timeoutMs: gate?.timeoutMs,
                logger: (m: string) => process.stderr.write(`[coordinator] hook: ${m}\n`),
              }),
            );
          }
        } catch (err) {
          process.stderr.write(
            `[coordinator] Không tải được test-gate hook: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      this.hookRegistry = registry;
    }
    return this.hookRegistry;
  }

  private getHookRunner(): HookRunner {
    // v0.19 (W11a): script hook có timeout riêng 10s — runner phải cho
    // ít nhất chừng đó, không thì runner 5s mặc định sẽ cắt script trước
    // khi timeout của chính script kịp kích hoạt. Hook function cũng được
    // 10s theo (nới từ 5s mặc định).
    return new HookRunner(this.getHookRegistry(), {
      logger: (m: string) => process.stderr.write(`[coordinator] hook: ${m}\n`),
      timeoutMs: DEFAULT_HOOK_SCRIPT_TIMEOUT_MS,
      // v1.01 (T2): execution log — mọi lần hook chạy được ghi vào
      // `<stateDir>/hook-executions.jsonl` để Settings xem lại.
      executionLog: this.getHookExecutionLog(),
    });
  }

  /**
   * v1.01 (T2): shared hook execution log (một instance cho cả
   * coordinator, file-backed khi có state dir). Không có state dir thì
   * vẫn có log trong bộ nhớ để run hiện tại tra cứu được.
   */
  private getHookExecutionLog(): HookExecutionLog {
    if (!this.hookExecutionLog) {
      this.hookExecutionLog = new HookExecutionLog(
        this.hooksStateDir
          ? { filePath: path.join(this.hooksStateDir, 'hook-executions.jsonl') }
          : {},
      );
    }
    return this.hookExecutionLog;
  }

  /** v0.10: lazily opened TraceStore on the file main passed in. */
  private getTraceStore(): TraceStore | null {
    if (!this.tracesFile) return null;
    if (!this.traceStoreInstance) {
      try {
        this.traceStoreInstance = new TraceStore({ filePath: this.tracesFile });
      } catch (err) {
        process.stderr.write(
          `[coordinator] Không mở được trace store: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return null;
      }
    }
    return this.traceStoreInstance;
  }

  /**
   * Lazily create (or return) the exec daemon client. Returns null when
   * the daemon cannot be loaded/started — the shell tool then falls back
   * to in-process runShell, so bot creation never fails because of the
   * daemon.
   */
  private getDaemonClient(): DaemonClientLike | null {
    if (this.daemonClient) {
      if (!this.daemonClient.isDisposed) return this.daemonClient;
      this.daemonClient = null;
    }
    let Client: new (opts?: {
      onDaemonStderr?: (chunk: string) => void;
    }) => DaemonClientLike;
    try {
      const toolsMod = require('@open-bot/tools') as {
        DaemonClient: typeof Client;
      };
      Client = toolsMod.DaemonClient;
    } catch (err) {
      process.stderr.write(
        `[coordinator] Không tải được DaemonClient: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return null;
    }
    try {
      const client = new Client({
        onDaemonStderr: (chunk: string) => process.stderr.write(chunk),
      });
      this.daemonClient = client;
      void client.waitForExit().then(() => {
        if (this.daemonClient === client) this.daemonClient = null;
      });
      return client;
    } catch (err) {
      process.stderr.write(
        `[coordinator] Không khởi động được exec daemon: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return null;
    }
  }

  /** Health of the exec daemon (for diagnostics / tests). */
  async daemonStatus(): Promise<DaemonStatusResult> {
    const client = this.daemonClient;
    if (!client || client.isDisposed) return { running: false };
    try {
      await Promise.race([
        client.ping(),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('daemon ping timeout')), 2000),
        ),
      ]);
      return { running: true, pid: client.pid };
    } catch {
      // Dead daemon: drop it so the next shell call spawns a fresh one.
      if (this.daemonClient === client) this.daemonClient = null;
      return { running: false };
    }
  }

  /**
   * M5 — trạng thái harness (registry instance + permission đang chờ).
   * Không có harness thì trả `enabled: false` (không throw — Local API
   * vẫn trả 200 với trạng thái trống để UI phân biệt "chưa bật" với lỗi).
   */
  harnessStatus(): HarnessStatusResult {
    return (
      this.harness?.harnessStatus() ?? {
        enabled: false,
        instances: [],
        pendingPermissions: [],
        decisionsTotal: 0,
      }
    );
  }

  /** M5 — đọc lại NDJSON log theo thread (phân trang, lọc theo kind). */
  harnessThreadLog(params: HarnessThreadLogParams): HarnessThreadLogResult {
    if (!params || typeof params.threadId !== 'string' || params.threadId.trim() === '') {
      throw new Error('harnessThreadLog cần params {threadId}.');
    }
    const limit =
      typeof params.limit === 'number' && Number.isFinite(params.limit) ? params.limit : 100;
    const offset =
      typeof params.offset === 'number' && Number.isFinite(params.offset) ? params.offset : 0;
    const kinds = Array.isArray(params.kinds)
      ? (params.kinds.filter((k) => typeof k === 'string') as HarnessThreadLogParams['kinds'])
      : undefined;
    return (
      this.harness?.readThreadLog(params.threadId, { limit, offset, kinds }) ?? {
        threadId: params.threadId,
        entries: [],
        total: 0,
        offset,
        limit,
      }
    );
  }

  /**
   * v1.01 (Đội T1): store event-sourced run log (lazy — tạo ở lần
   * dùng đầu). Trả về null khi không có dataDir: run log tắt, loop
   * chạy như cũ (không ghi, không lỗi).
   */
  getRunLogStore(): RunLogStore | null {
    if (!this.dataDir) return null;
    if (!this.runLogStoreInstance) {
      this.runLogStoreInstance = new RunLogStore({
        logDir: path.join(this.dataDir, 'run-logs'),
      });
    }
    return this.runLogStoreInstance;
  }

  /** Registry gate pause dùng chung của coordinator (cho run log). */
  getRunLogRegistry(): RunControlRegistry {
    return this.runLogRegistry;
  }

  /**
   * Tạo recorder cho một run mới (ghi `run.started` ngay) và đăng ký
   * vào map run đang chạy. Trả về null khi run log tắt (không có
   * dataDir) — caller chạy như cũ, không sink/gate.
   */
  createRunLogRecorder(options: {
    runId: string;
    botId: string;
    model?: string;
    providerId?: string;
    maxSteps?: number;
    title?: string;
  }): RunLogRecorder | null {
    const store = this.getRunLogStore();
    if (!store) return null;
    const recorder = new RunLogRecorder({
      runId: options.runId,
      botId: options.botId,
      store,
      registry: this.runLogRegistry,
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
      ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
      ...(options.title !== undefined ? { title: options.title } : {}),
    });
    this.runLogRecorders.set(options.runId, recorder);
    return recorder;
  }

  /** Metadata của mọi run đã ghi (mới nhất trước). Run log tắt → []. */
  listRunLogs(): RunLogMeta[] {
    return this.getRunLogStore()?.listRuns() ?? [];
  }

  /** Metadata của một run (null khi run chưa có log). */
  runLogMeta(runId: string): RunLogMeta | null {
    if (!runId) return null;
    return this.getRunLogStore()?.meta(runId) ?? null;
  }

  /**
   * Đọc event của một run (phân trang + lọc theo loại/seq/thời
   * gian). Run log tắt hoặc run chưa có log → trang rỗng.
   */
  readRunLog(runId: string, query: RunEventQuery = {}): { events: AnyRunEvent[]; total: number; corruptLines: number } {
    const store = this.getRunLogStore();
    if (!store) return { events: [], total: 0, corruptLines: 0 };
    return store.queryRun(runId, query);
  }

  /** Kiểm chứng hash chain + seq của một run (null khi run log tắt). */
  verifyRunLog(runId: string): RunLogVerification | null {
    const store = this.getRunLogStore();
    if (!store) return null;
    return store.verify(runId);
  }

  /** Export toàn bộ event của một run ra JSONL ('' khi run log tắt). */
  exportRunLog(runId: string): string {
    return this.getRunLogStore()?.exportJsonl(runId) ?? '';
  }

  /** Kiểm chứng toàn vẹn mọi run trong store (null khi run log tắt). */
  verifyAllRunLogs(): AuditIntegrityReport | null {
    const store = this.getRunLogStore();
    if (!store) return null;
    return verifyAllRuns(store);
  }

  /** Truy vấn audit xuyên run (theo bot/loại/thời gian). Run log tắt → []. */
  auditRunLogs(query: AuditQuery = {}): AuditEventEntry[] {
    const store = this.getRunLogStore();
    if (!store) return [];
    return queryAudit(store, query);
  }

  /** Tóm tắt audit (đếm theo loại/bot). Run log tắt → tóm tắt rỗng. */
  summarizeRunLogs(query: AuditQuery = {}): AuditSummary {
    const store = this.getRunLogStore();
    if (!store) {
      return { totalEvents: 0, byType: {}, byBot: {}, runsTouched: 0 };
    }
    return summarizeAudit(store, query);
  }

  /** Tái tạo trạng thái một run từ log (null khi run log tắt / run chưa có log). */
  replayRunLog(runId: string): ReplayedRunState | null {
    const store = this.getRunLogStore();
    if (!store) return null;
    return replayRunState(store, runId);
  }

  /**
   * Tạm dừng một run đang chạy (ghi `run.paused` + đóng gate).
   * Trả về null khi run log tắt; throw khi run chưa có log.
   */
  pauseRunLog(runId: string, reason?: string): PauseResumeResult | null {
    const store = this.getRunLogStore();
    if (!store) return null;
    const recorder = this.runLogRecorders.get(runId);
    if (recorder) return recorder.pause(reason);
    if (!store.exists(runId)) throw new Error(`Không pause được: run ${runId} chưa có log.`);
    return pauseRun(store, this.runLogRegistry, runId, {
      step: 0,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  /**
   * Tiếp tục một run đã pause (ghi `run.resumed` + mở gate).
   * Trả về null khi run log tắt; throw khi run chưa có log.
   */
  resumeRunLog(runId: string, reason?: string): PauseResumeResult | null {
    const store = this.getRunLogStore();
    if (!store) return null;
    const recorder = this.runLogRecorders.get(runId);
    if (recorder) return recorder.resume(reason);
    if (!store.exists(runId)) throw new Error(`Không resume được: run ${runId} chưa có log.`);
    return resumeRun(store, this.runLogRegistry, runId, {
      step: 0,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  /**
   * Fork một run tại seq chỉ định (mặc định = seq cuối). Trả về null
   * khi run log tắt; throw khi run cha chưa có log / seq ngoài khoảng.
   */
  forkRunLog(runId: string, fromSeq?: number): ForkRunResult | null {
    const store = this.getRunLogStore();
    if (!store) return null;
    return forkRun(store, runId, { fromSeq });
  }

  /**
   * v0.97 (Team T3): UI trả lời một generative-UI component đang chờ
   * (RPC `answerAgUiComponent`, params-object style như
   * decideHarnessPermission). Trả `{ componentId, found }` — found
   * false khi component không tồn tại hoặc đã trả lời rồi. Câu trả
   * lời cũng được emit GENERATIVE_UI_RESPONSE lên bus (forward về
   * main qua 'agui.event') nên SSE client thấy được.
   */
  decideAgUiComponent(params: {
    componentId: string;
    response: Record<string, unknown>;
    action?: string;
  }): { componentId: string; found: boolean } {
    if (!params || typeof params.componentId !== 'string' || params.componentId.trim() === '') {
      throw new Error('answerAgUiComponent cần params {componentId, response}.');
    }
    if (!params.response || typeof params.response !== 'object' || Array.isArray(params.response)) {
      throw new Error('answerAgUiComponent cần params.response là object.');
    }
    const found = this.answerAgUiComponent(params.componentId, params.response, params.action);
    return { componentId: params.componentId, found };
  }

  /** M5 — UI quyết một permission request đang chờ (thẻ Allow/Deny). */
  decideHarnessPermission(params: HarnessDecidePermissionParams): HarnessDecidePermissionResult {
    if (!params || typeof params.requestId !== 'string' || params.requestId.trim() === '') {
      throw new Error('harnessDecidePermission cần params {requestId, allowed}.');
    }
    return (
      this.harness?.decidePermission(params.requestId, params.allowed === true) ?? {
        requestId: params.requestId,
        found: false,
      }
    );
  }

  /**
   * v0.34 (P1-6): xem AGENTS.md đang có hiệu lực cho một bot — nội dung
   * đã gộp + nguồn từng file + file bị bỏ qua/cắt ngắn. Dùng đúng loader
   * và cache với executeRun nên kết quả là thứ run sẽ nạp (kể cả khi
   * file vừa đổi: loader stat lại mtime nên run mới thấy nội dung mới).
   */
  getWorkspaceRules(params: GetWorkspaceRulesParams): GetWorkspaceRulesResult {
    if (!params || typeof params.botId !== 'string' || params.botId.trim() === '') {
      throw new Error('getWorkspaceRules cần botId (string, không rỗng).');
    }
    const entry = this.getBot(params.botId);
    const cwd =
      typeof params.cwd === 'string' && params.cwd.trim() !== ''
        ? params.cwd
        : entry.bot.workspaceDir;
    const rules = loadAgentsMd(entry.bot.workspaceDir, { cwd });
    return {
      botId: params.botId,
      workspaceDir: entry.bot.workspaceDir,
      cwd: rules ? rules.cwd : cwd,
      rules,
    };
  }

  private emitEvent(botId: string, kind: AgentEventKind, payload: unknown): void {
    const data: AgentEvent = { botId, kind, payload };
    this.emitFn({ event: 'agent.event', data });
  }

  private getBot(botId: string): BotEntry {
    const entry = this.bots.get(botId);
    if (!entry) throw new Error(`Chưa tạo bot "${botId}" — gọi createBot trước.`);
    return entry;
  }

  /**
   * M5 — đăng ký bot vào harness registry + gắn sink event +
   * permission handler vào provider (khi provider hỗ trợ). Best-effort:
   * đăng ký lỗi (vd provider khác tranh cùng botId) chỉ ghi stderr,
   * không làm hỏng createBot — bot vẫn chạy được, chỉ không có trong
   * registry. v0.60: gắn lại cùng provider (re-attach) không còn là
   * lỗi — `attachToProvider` trả snapshot hiện có, không throw, nên
   * đường này không in cảnh báo nữa.
   */
  private attachBotToHarness(botId: string, provider: Provider, engine: string): void {
    if (!this.harness) return;
    try {
      this.harness.attachToProvider(botId, provider, { engine, threadId: botId });
    } catch (err) {
      process.stderr.write(
        `[coordinator] harness: không đăng ký được bot "${botId}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  /** Dispatch one RPC method. Never throws: errors become Error objects for the caller to encode. */
  async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'createBot':
        return this.createBot(params as unknown as CreateBotParams);
      case 'run':
        return this.run(params as unknown as RunParams);
      case 'stopBot':
        return this.stopBot(params as unknown as { botId: string });
      case 'stopRun':
        return this.stopRun(params as unknown as { runId: string });
      case 'listBots':
        return this.listBots();
      case 'listBotTools':
        return this.listBotTools(params as unknown as ListBotToolsParams);
      case 'listSlashCommands':
        return this.listSlashCommands(params as unknown as ListSlashCommandsParams);
      case 'setBotToolEnabled':
        return this.setBotToolEnabled(params as unknown as SetBotToolEnabledParams);
      case 'listBotSkills':
        return this.listBotSkills(params as unknown as ListBotSkillsParams);
      case 'setBotSkillEnabled':
        return this.setBotSkillEnabled(params as unknown as SetBotSkillEnabledParams);
      case 'destroyBot':
        return this.destroyBot(params as unknown as DestroyBotParams);
      case 'deleteBotData':
        return this.deleteBotData(params as unknown as DeleteBotDataParams);
      case 'ping':
        return this.ping();
      case 'shutdown':
        return this.shutdown();
      case 'respondApproval':
        return this.respondApproval(params as unknown as RespondApprovalParams);
      case 'respondAskUser':
        return this.respondAskUser(params as unknown as RespondAskUserParams);
      case 'interruptRun':
        return this.interruptRun(params as unknown as InterruptRunParams);
      case 'respondInterrupt':
        return this.respondInterrupt(params as unknown as RespondInterruptParams);
      case 'listRunCheckpoints':
        return this.listRunCheckpoints(params as unknown as ListRunCheckpointsParams);
      case 'listBotCheckpoints':
        return this.listBotCheckpoints(params as unknown as ListBotCheckpointsParams);
      case 'replayRun':
        return this.replayRun(params as unknown as ReplayRunParams);
      case 'respondElicitation':
        return this.respondElicitation(params as unknown as RespondElicitationParams);
      case 'reviewPlan':
        return this.reviewPlan(params as unknown as ReviewPlanParams);
      case 'plan.create':
        return this.createRunPlan(params as unknown as CreateRunPlanParams);
      case 'plan.list':
        return this.listRunPlans();
      case 'plan.get':
        return this.getRunPlan(params as unknown as GetRunPlanParams);
      case 'plan.delete':
        return this.deleteRunPlan(params as unknown as DeleteRunPlanParams);
      case 'plan.decideReplan':
        return this.decideReplan(params as unknown as DecideReplanParams);
      case 'plan.resume':
        return this.resumeRunPlans();
      case 'plan.templates':
        return this.listPlanTemplates();
      case 'switchModel':
        return this.switchModel(params as unknown as SwitchModelParams);
      case 'listAutoApproveRules':
        return this.listAutoApproveRules();
      case 'addAutoApproveRule':
        return this.addAutoApproveRule(params as unknown as AddAutoApproveRuleParams);
      case 'removeAutoApproveRule':
        return this.removeAutoApproveRule(params as unknown as RemoveAutoApproveRuleParams);
      case 'setAutoApproveRuleEnabled':
        return this.setAutoApproveRuleEnabled(
          params as unknown as SetAutoApproveRuleEnabledParams,
        );
      // v1.01 (Đội T3, risk budget): quản lý rule risk + xem duyệt/budget.
      case 'listRiskRules':
        return this.listRiskRules();
      case 'addRiskRule':
        return this.addRiskRuleRpc(params as unknown as AddRiskRuleParams);
      case 'removeRiskRule':
        return this.removeRiskRuleRpc(params as unknown as RemoveRiskRuleParams);
      case 'setRiskListEntry':
        return this.setRiskListEntry(params as unknown as SetRiskListEntryParams);
      case 'listBuiltinRiskRules':
        return this.listBuiltinRiskRules();
      case 'setRiskBuiltinRuleEnabled':
        return this.setRiskBuiltinRuleEnabled(
          params as unknown as SetRiskBuiltinRuleEnabledParams,
        );
      case 'listPendingConfirmations':
        return { confirmations: this.listPendingConfirmations() };
      case 'getConfirmationAudit':
        return { audit: this.getConfirmationAudit() };
      case 'listBudgetHistory':
        return this.listBudgetHistoryRpc(params as unknown as ListBudgetHistoryParams);
      case 'getBudgetTotals':
        return this.getBudgetTotalsRpc(params as unknown as GetBudgetTotalsParams);
      case 'getRiskReport':
        return this.getRiskReport(params as unknown as GetRiskReportParams);
      case 'createGroupChat':
        return this.createGroupChat(params as unknown as CreateGroupChatParams);
      case 'listGroupChats':
        return this.listGroupChats();
      case 'addBotToGroupChat':
        return this.addBotToGroupChat(params as unknown as AddBotToGroupChatParams);
      case 'removeBotFromGroupChat':
        return this.removeBotFromGroupChat(params as unknown as RemoveBotFromGroupChatParams);
      case 'deleteGroupChat':
        return this.deleteGroupChat(params as unknown as DeleteGroupChatParams);
      case 'postGroupMessage':
        return this.postGroupMessage(params as unknown as PostGroupMessageParams);
      case 'listGroupMessages':
        return this.listGroupMessages(params as unknown as ListGroupMessagesParams);
      case 'getGroupAttachment':
        return this.getGroupAttachment(params as unknown as GetGroupAttachmentParams);
      case 'projectUpdatesDue':
        return this.projectUpdatesDue();
      case 'projectUpdatesMarkSent':
        return this.projectUpdatesMarkSent(params as unknown as ProjectUpdatesMarkSentParams);
      case 'getGroupBotStatus':
        return this.getGroupBotStatus(params as unknown as GetGroupBotStatusParams);
      case 'dismissGroupBotInterrupted':
        return this.dismissGroupBotInterrupted(params as unknown as DismissGroupBotInterruptedParams);
      case 'createChannel':
        return this.createChannel(params as unknown as CreateChannelParams);
      case 'listChannels':
        return this.listChannels();
      case 'updateChannel':
        return this.updateChannel(params as unknown as UpdateChannelParams);
      case 'deleteChannel':
        return this.deleteChannel(params as unknown as DeleteChannelParams);
      case 'addBotToChannel':
        return this.addBotToChannel(params as unknown as AddBotToChannelParams);
      case 'removeBotFromChannel':
        return this.removeBotFromChannel(params as unknown as RemoveBotFromChannelParams);
      case 'moveBotBetweenChannels':
        return this.moveBotBetweenChannels(params as unknown as MoveBotBetweenChannelsParams);
      case 'postChannelMessage':
        return this.postChannelMessage(params as unknown as PostChannelMessageParams);
      case 'listChannelMessages':
        return this.listChannelMessages(params as unknown as ListChannelMessagesParams);
      case 'setPluginEnabled':
        return this.setPluginEnabled(params as unknown as SetPluginEnabledParams);
      case 'supervise':
        return this.supervise(params as unknown as SuperviseParams);
      case 'saveMessage':
        return this.saveMessage(params as unknown as SaveMessageParams);
      case 'getHistory':
        return this.getHistory(params as unknown as GetHistoryParams);
      case 'listTasks':
        return this.listTasks(params as unknown as ListTasksParams);
      case 'listThreads':
        return this.listThreads(params as unknown as ListThreadsParams);
      case 'createThread':
        return this.createThread(params as unknown as CreateThreadParams);
      case 'renameThread':
        return this.renameThread(params as unknown as RenameThreadParams);
      case 'deleteThread':
        return this.deleteThread(params as unknown as DeleteThreadParams);
      case 'getThreadHistory':
        return this.getThreadHistory(params as unknown as GetThreadHistoryParams);
      case 'searchThreads':
        return this.searchThreads(params as unknown as SearchThreadsParams);
      case 'daemonStatus':
        return this.daemonStatus();
      case 'harnessStatus':
        return this.harnessStatus();
      case 'harnessThreadLog':
        return this.harnessThreadLog(params as unknown as HarnessThreadLogParams);
      // v1.01 (Đội T1): event-sourced run log — đọc/audit/pause/resume/fork qua RPC.
      case 'listRunLogs':
        return this.listRunLogs();
      case 'runLogMeta':
        return this.runLogMeta((params as { runId?: unknown }).runId as string);
      case 'readRunLog': {
        const p = params as { runId?: unknown; query?: unknown };
        return this.readRunLog(
          p.runId as string,
          (p.query ?? {}) as import('../event-log/index').RunEventQuery,
        );
      }
      case 'verifyRunLog':
        return this.verifyRunLog((params as { runId?: unknown }).runId as string);
      case 'exportRunLog':
        return this.exportRunLog((params as { runId?: unknown }).runId as string);
      case 'verifyAllRunLogs':
        return this.verifyAllRunLogs();
      case 'auditRunLogs':
        return this.auditRunLogs((params as unknown as import('../event-log/index').AuditQuery) ?? {});
      case 'summarizeRunLogs':
        return this.summarizeRunLogs((params as unknown as import('../event-log/index').AuditQuery) ?? {});
      case 'replayRunLog':
        return this.replayRunLog((params as { runId?: unknown }).runId as string);
      case 'pauseRunLog': {
        const p = params as { runId?: unknown; reason?: unknown };
        return this.pauseRunLog(p.runId as string, p.reason as string | undefined);
      }
      case 'resumeRunLog': {
        const p = params as { runId?: unknown; reason?: unknown };
        return this.resumeRunLog(p.runId as string, p.reason as string | undefined);
      }
      case 'forkRunLog': {
        const p = params as { runId?: unknown; fromSeq?: unknown };
        return this.forkRunLog(
          p.runId as string,
          typeof p.fromSeq === 'number' ? p.fromSeq : undefined,
        );
      }
      case 'harnessDecidePermission':
        return this.decideHarnessPermission(params as unknown as HarnessDecidePermissionParams);
      case 'answerAgUiComponent':
        return this.decideAgUiComponent(
          params as unknown as { componentId: string; response: Record<string, unknown>; action?: string },
        );
      case 'getWorkspaceRules':
        return this.getWorkspaceRules(params as unknown as GetWorkspaceRulesParams);
      case 'listHandoffs':
        return this.listHandoffs(params as unknown as ListHandoffsParams);
      case 'getHandoff':
        return this.getHandoff(params as unknown as GetHandoffParams);
      case 'createHandoffRecord':
        return this.createHandoffRecord(params as unknown as CreateHandoffRecordParams);
      case 'acceptHandoff':
        return this.acceptHandoff(params as unknown as AcceptHandoffParams);
      case 'cache.stats':
        return this.cacheStats();
      case 'cache.clear':
        return this.cacheClear();
      case 'runTool':
        return this.runTool(params as unknown as RunToolParams);
      case 'createTask':
        return this.createTask(params as unknown as CreateTaskParams);
      case 'reloadSkills':
        return this.reloadSkills();
      case 'apps.setSharedToken':
        return this.setSharedAppToken(
          params as unknown as { appId: string; token: TokenSet; accountLabel?: string },
        );
      case 'apps.setPlainToken':
        return this.setPlainAppToken(
          params as unknown as { appId: string; token: string; accountLabel?: string },
        );
      case 'apps.revokeSharedToken':
        return this.revokeSharedAppToken(params as unknown as { appId: string });
      case 'apps.listStatuses':
        return this.listAppStatuses();
      case 'apps.setToolCap':
        return this.setAppToolCap(params as unknown as { appId: string; cap: number });
      case 'composio.setState':
        return this.setComposioState(params as unknown as SetComposioStateParams);
      case 'composio.getState':
        return this.getComposioState();
      case 'composio.setApiKey':
        return this.setComposioApiKey(params as unknown as SetComposioApiKeyParams);
      case 'composio.getKeyStatus':
        return this.getComposioKeyStatus();
      case 'composio.setUserId':
        return this.setComposioUserId(params as unknown as SetComposioUserIdParams);
      case 'composio.getUserIdStatus':
        return this.getComposioUserIdStatus();
      case 'composio.getConnectionStatus':
        return this.getComposioConnectionStatus(params as unknown as GetComposioConnectionStatusParams);
      case 'media.setKey':
        return this.setMediaApiKey(params as unknown as SetMediaApiKeyParams);
      case 'media.getKeyStatus':
        return this.getMediaKeyStatus();
      case 'router.getDecisions':
        return this.getRouterDecisions(params as unknown as GetRouterDecisionsParams);
      case 'router.getStats':
        return this.getRouterStats(params as unknown as GetRouterStatsParams);
      case 'router.getConfig':
        return this.getRouterConfig();
      case 'router.setConfig':
        return this.setRouterConfig(params as unknown as SetRouterConfigParams);
      case 'router.clearLog':
        return this.clearRouterLog(params as unknown as ClearRouterLogParams);
      case 'router.getTargets':
        return this.getRouterTargets();
      case 'router.setApiKey':
        return this.setRouterApiKey(params as unknown as SetRouterApiKeyParams);
      case 'router.getApiKeyStatus':
        return this.getRouterApiKeyStatus();
      default:
        throw new Error(`Không rõ method: ${method}`);
    }
  }

  /**
   * v0.55: tạo bot — idempotent khi gọi lại cùng bot id (re-attach).
   * Main lúc khởi động có thể gọi `createBot` 2 lần cho cùng bot
   * (2 đường `getOrCreateRuntime` chạy song song, đều thấy bot chưa
   * có rồi cùng gọi sang đây) — trước đây lần 2 ném `đã tồn tại`
   * (cảnh báo benign nhưng ồn); nay lần 2 trả về handle của bot đã
   * tạo, không dựng trùng. Hai lần gọi song song thì chờ chung một
   * promise (`botCreations`) nên chỉ một lần dựng thật — không rò
   * BotMemory/provider thừa. Tạo lại với cấu hình KHÁC (provider /
   * model / workspace đổi) thì vẫn ném lỗi như cũ — muốn đổi cấu hình
   * phải `destroyBot` trước (đường đổi key/model của main vẫn vậy).
   */
  async createBot(params: CreateBotParams): Promise<CreateBotResult> {
    if (
      !params ||
      typeof params !== 'object' ||
      !params.bot ||
      typeof params.bot.id !== 'string' ||
      params.bot.id.trim() === ''
    ) {
      throw new Error('createBot cần bot.id (string, không rỗng).');
    }
    const botId = params.bot.id;
    const inFlight = this.botCreations.get(botId);
    if (inFlight) return inFlight;
    const created = this.createBotInner(params);
    this.botCreations.set(botId, created);
    try {
      return await created;
    } finally {
      if (this.botCreations.get(botId) === created) this.botCreations.delete(botId);
    }
  }

  private async createBotInner(params: CreateBotParams): Promise<CreateBotResult> {
    if (!params || typeof params !== 'object') {
      throw new Error('createBot cần params {bot, provider}.');
    }
    const bot = params.bot;
    if (!bot || typeof bot.id !== 'string' || bot.id.trim() === '') {
      throw new Error('createBot cần bot.id (string, không rỗng).');
    }
    if (!params.provider || typeof params.provider.id !== 'string') {
      throw new Error('createBot cần provider.id.');
    }
    const workspaceDir = params.workspaceDir ?? bot.workspaceDir;
    if (!workspaceDir || typeof workspaceDir !== 'string' || workspaceDir.trim() === '') {
      throw new Error('createBot cần workspaceDir (trong bot.workspaceDir hoặc params.workspaceDir).');
    }
    const fullBot: BotConfig = { ...bot, workspaceDir };
    // v0.6: keep the provider config (for image/video tools) and the X
    // bearer (for x_search) in memory; both came from main, never logged.
    if (params.xBearer) this.xBearer = params.xBearer;
    // v0.95 (Team D1): Brave Search API key seed (same pattern as
    // xBearer; re-seeding on a later createBot rotates the key).
    if (params.braveSearchApiKey) this.braveSearchApiKey = params.braveSearchApiKey;
    // v0.59: Composio API key seed từ main (đọc Vault bằng safeStorage)
    // — đặt TRƯỚC re-attach check như token khác: gọi lại createBot
    // (re-attach) với key mới vẫn xoay được key mà không cần
    // destroyBot; seed lại cùng key thì session cũ giữ nguyên (chỉ
    // invalidate khi key hiệu lực đổi, xem `seedComposioApiKey`).
    // Vắng/rỗng = giữ nguyên key đã seed (không clear).
    if (params.composioApiKey && typeof params.composioApiKey === 'string') {
      await this.seedComposioApiKey(params.composioApiKey);
    }
    // v0.88b: Composio user id seed từ main (đọc Vault bằng
    // safeStorage) — đặt cạnh seed key, trước re-attach check như
    // token khác: gọi lại createBot (re-attach) với id mới vẫn đổi
    // được id mà không cần destroyBot; seed lại cùng id thì session
    // cũ giữ nguyên (chỉ invalidate khi id hiệu lực đổi, xem
    // `ComposioSessionManager.setUserId`). Vắng/rỗng = giữ nguyên
    // id đã seed (không về mặc định).
    if (params.composioUserId && typeof params.composioUserId === 'string') {
      await this.setComposioUserId({ userId: params.composioUserId });
    }
    // v0.95 (Team D2): media API keys seed từ main (đọc Vault
    // namespace 'media' bằng safeStorage) — đặt cạnh seed Composio,
    // trước re-attach check như token khác: gọi lại createBot
    // (re-attach) với key mới vẫn xoay được key mà không cần
    // destroyBot. Vắng = giữ nguyên key đã seed. Key lạ (không phải
    // media provider) bị bỏ qua, không ném — createBot không được
    // chết chỉ vì một key lạ trong seed.
    if (params.mediaApiKeys && typeof params.mediaApiKeys === 'object') {
      for (const [providerId, apiKey] of Object.entries(params.mediaApiKeys)) {
        if (!isMediaProviderId(providerId)) continue;
        if (typeof apiKey !== 'string' || !apiKey.trim()) continue;
        try {
          await this.setMediaApiKey({ providerId, apiKey });
        } catch {
          // Key sai định dạng → bỏ qua provider đó, bot vẫn tạo được.
        }
      }
    }
    // v0.7: GitHub + integration tokens, MCP OAuth seed/config, system
    // tool allowlist — same pattern, all from main, never logged.
    if (params.githubToken) this.githubToken = params.githubToken;
    // v0.10: traces file + hooks state dir (both under userData).
    if (params.tracesFile) this.tracesFile = params.tracesFile;
    if (params.skillsDirs?.stateDir) this.hooksStateDir = params.skillsDirs.stateDir;
    // v0.9d: connector TokenSets seed FIRST (they carry refresh +
    // expiry), static tokens only fill gaps as non-expiring sets.
    // Seed-only for both: a live refreshed TokenSet already in
    // memory is newer than main's Vault copy — never overwrite it.
    if (params.connectorTokenSets) {
      for (const [id, token] of Object.entries(params.connectorTokenSets)) {
        if (!token || typeof token.accessToken !== 'string' || !token.accessToken) continue;
        if (!CONNECTOR_DEFS[id]) continue;
        if (!this.connectorTokenSets.has(id)) {
          this.connectorTokenSets.set(id, { ...token });
        }
      }
    }
    if (params.connectorTokens) {
      this.connectorTokens = { ...this.connectorTokens, ...params.connectorTokens };
      for (const [id, token] of Object.entries(params.connectorTokens)) {
        if (!token || !CONNECTOR_DEFS[id]) continue;
        if (!this.connectorTokenSets.has(id)) {
          this.connectorTokenSets.set(id, { accessToken: token });
        }
      }
    }
    if (params.connectorClientConfigs) {
      this.connectorClientConfigs = {
        ...this.connectorClientConfigs,
        ...params.connectorClientConfigs,
      };
      // M7: để kho app dùng chung refresh được token (client config
      // theo từng connector). Id không phải app OAuth2 thì bỏ qua.
      for (const [id, cfg] of Object.entries(params.connectorClientConfigs)) {
        try {
          this.appAuthStore.setClientConfig(id, cfg);
        } catch {
          // Không phải app OAuth2 trong catalog — bỏ qua.
        }
      }
    }
    if (params.mcpOAuthTokens) {
      for (const [server, value] of Object.entries(params.mcpOAuthTokens)) {
        // Seed only: an in-memory token (from a live mcp_auth this
        // process) is newer than the Vault copy main is passing.
        if (!this.mcpOAuthTokens.has(server)) this.mcpOAuthTokens.set(server, value);
      }
    }
    if (params.mcpOAuthConfigs) {
      this.mcpOAuthConfigs = { ...this.mcpOAuthConfigs, ...params.mcpOAuthConfigs };
    }
    if (params.allowedSystemTools) {
      this.allowedSystemTools = [...params.allowedSystemTools];
    }

    // v0.55: re-attach — check trùng ĐẶT SAU phần seed coordinator-level
    // ở trên (token/mcp/allowlist vẫn được seed lại — toàn seed-only /
    // merge nên gọi lại với cùng params là vô hại), và TRƯỚC khi dựng
    // BotMemory/provider/tools (phần nặng, không được chạy 2 lần).
    // Cùng provider + model + workspace → trả handle hiện có; khác
    // thì vẫn ném lỗi như trước (đổi cấu hình phải destroyBot trước).
    // Đổi key mà giữ nguyên provider id thì lần re-attach này vẫn giữ
    // provider cũ — xoay key phải đi qua destroyBot (như trước đây).
    const existing = this.bots.get(fullBot.id);
    if (existing) {
      const sameIdentity =
        existing.providerConfig.id === params.provider.id &&
        existing.bot.model === fullBot.model &&
        existing.bot.workspaceDir === fullBot.workspaceDir;
      if (!sameIdentity) {
        throw new Error(
          `Bot "${fullBot.id}" đã tồn tại với cấu hình khác (provider/model/workspace) — gọi destroyBot trước khi tạo lại.`,
        );
      }
      return {
        botId: fullBot.id,
        toolCount: existing.tools.length,
        toolNames: existing.tools.map((t) => t.definition.name),
      };
    }

    const memory = new BotMemory(workspaceDir);
    try {
      memory.saveBot(fullBot);
      let provider: Provider =
        params.provider.id === 'mock'
          ? createMockProvider(params.provider.mockResponses ?? [], {
              // v0.25 (W18a): test-only — file JSONL ghi lại mọi request
              // mock nhận được (không truyền thì undefined = như cũ).
              recordPath: mockRecordPathFromProviderConfig(params.provider),
              // v0.94c (test-only): mock vision (không truyền thì false).
              supportsVision: mockSupportsVisionFromProviderConfig(params.provider),
            })
          : createProvider(params.provider);
      // v0.4: spend-limit wrapper — check limit before each chat(), record
      // usage after. Mock provider still goes through it (limit testing).
      if (params.usageStorePath) {
        provider = new MeteredProvider(provider, this.getUsageTracker(params.usageStorePath), {
          botId: fullBot.id,
        });
      }
      // v0.4: load skills once per child process (first createBot wins).
      if (params.skillsDirs) this.skillsDirs = params.skillsDirs;
      this.getSkillRegistry(params.skillsDirs);
      // v0.14: scan plugins FIRST — bundle MCP servers are merged into the
      // bot's mcp.json and bundle skill dirs are registered before the
      // tool factory builds the MCP tools / first run injects skills.
      let pluginTools: Tool[] = [];
      let bundleSubagents: SpecializedSubagentSpec[] = [];
      let bundleSlashCommands: SlashCommandDef[] = [];
      let pluginsSandbox = true;
      if (params.pluginsDir && typeof params.pluginsDir === 'string') {
        pluginsSandbox = params.pluginsSandbox !== false;
        const loaded = await loadPlugins(params.pluginsDir, { sandboxed: pluginsSandbox });
        pluginTools = loaded.tools;
        const wired = this.wireBundleParts(workspaceDir, loaded.bundleParts);
        bundleSubagents = wired.subagents;
        bundleSlashCommands = wired.slashCommands;
      }
      const builtTools = this.wrapPlanApprovalTool(
        fullBot.id,
        this.toolFactory(memory, workspaceDir, fullBot.id),
      );
      // v0.58: tách meta-tool Composio ra khỏi coreTools để RPC
      // `composio.setState` rebuild được mà không cần tạo lại bot
      // (xem `rebuildComposioTools`); coreTools không bao giờ chứa chúng.
      const composioTools = builtTools.filter((t) =>
        (COMPOSIO_RUNNABLE_META_TOOLS as readonly string[]).includes(t.definition.name),
      );
      const coreTools = builtTools.filter(
        (t) => !(COMPOSIO_RUNNABLE_META_TOOLS as readonly string[]).includes(t.definition.name),
      );
      const tools = [...coreTools, ...composioTools];
      // Plugin tools are loaded in the child (they cannot cross RPC). A
      // duplicate name is skipped with a stderr note — it must never
      // break bot creation.
      const seen = new Set(tools.map((t) => t.definition.name));
      for (const tool of pluginTools) {
        if (seen.has(tool.definition.name)) {
          process.stderr.write(
            `[coordinator] Bỏ qua tool plugin trùng tên: "${tool.definition.name}".\n`,
          );
          continue;
        }
        seen.add(tool.definition.name);
        tools.push(tool);
      }
      this.bots.set(fullBot.id, {
        bot: fullBot,
        provider,
        providerConfig: params.provider,
        usageStorePath: params.usageStorePath,
        tools,
        coreTools,
        composioTools,
        pluginTools,
        pluginsDir: params.pluginsDir,
        pluginsSandbox,
        bundleSubagents,
        bundleSlashCommands,
        memory,
        maxSteps: params.maxSteps ?? 20,
        running: false,
        stopRequested: false,
        // v0.24 (W17d): store lịch sử sampling dùng chung của bot này.
        samplingContextStore: createSamplingContextStore(),
      });
      // M5: đăng ký bot vào harness registry (instance → process sống).
      this.attachBotToHarness(fullBot.id, provider, params.provider.id);
      // v0.11: như createAgentBot — đăng ký policy để rule engine có hiệu
      // lực trong run thật (true → 'all'; false/không set → 'safe-only').
      this.permissions.setBotPolicy(fullBot.id, {
        autoApprove: fullBot.autoApprove ? 'all' : undefined,
        // v0.59 (UI-3): như createAgentBot — denyTools từ màn Tools.
        denyTools: fullBot.denyTools ? [...fullBot.denyTools] : undefined,
        // v0.64 (skills per-bot): như createAgentBot — denySkills từ
        // màn Tools.
        denySkills: fullBot.denySkills ? [...fullBot.denySkills] : undefined,
      });
      // v0.95 (merge): làm ấm probe khả dụng của embedder (GET /api/tags,
      // cache 60s) ngay khi tạo bot — fire-and-forget, không chặn
      // createBot. Turn đầu tiên có memory sẽ dùng cache ấm thay vì trả
      // probe mạng trên đường setup (độ trễ biến động 5–823ms, xem
      // turnContext). isEmbedderAvailableCached không bao giờ throw;
      // catch chỉ phòng hờ.
      void isEmbedderAvailableCached(this.getMemoryEmbedder()).catch(() => undefined);
      return {
        botId: fullBot.id,
        toolCount: tools.length,
        toolNames: tools.map((t) => t.definition.name),
      };
    } catch (err) {
      // Half-built bot must not leak a live SQLite connection.
      try {
        memory.close();
      } catch {
        // Already closed — nothing to do.
      }
      throw err;
    }
  }

  /**
   * v0.8: run one turn, through the run queue. The RPC signature is
   * unchanged — callers still await one `RunResult` per `run` call.
   * When fewer than `maxConcurrentRuns` runs are executing, the run
   * starts immediately; otherwise it waits FIFO until a slot frees.
   * A bot never runs two turns at once: a queued run for a bot only
   * starts after that bot's earlier run finished (its own slot in the
   * queue is kept — later runs for OTHER bots may start first instead
   * of blocking behind it). Unknown bot / bad params still reject
   * immediately, before queueing.
   */
  async run(params: RunParams): Promise<RunResult> {
    if (!params || typeof params.botId !== 'string' || typeof params.text !== 'string') {
      throw new Error('run cần params {botId, text}.');
    }
    // Validate now so a typo'd botId fails fast instead of waiting in
    // the queue for an error it could have had immediately.
    this.getBot(params.botId);
    // v0.37 (P1-3): fail-fast cho handoffId — validate TRƯỚC khi xếp
    // hàng (như kiểm tra botId ở trên): executeRun đặt entry.running =
    // true ngay khi bắt đầu rồi mới nạp record, nên lỗi nạp ở đó sẽ để
    // running kẹt true và mọi run sau của bot này treo trong hàng đợi mãi
    // (pumpRunQueue chỉ chạy bot có running !== true). Kiểm tra ở đây thì
    // lỗi trả về ngay, bot không bị kẹt. executeRun vẫn kiểm tra lại lúc
    // nạp thật (phòng record bị xoá giữa chừng).
    if (params.handoffId !== undefined) {
      if (typeof params.handoffId !== 'string' || params.handoffId.trim() === '') {
        throw new Error('handoffId phải là id record không rỗng.');
      }
      if (params.resumeRunId) {
        throw new Error(
          'Không dùng handoffId cùng resumeRunId — resume đã có messages của run cũ.',
        );
      }
      this.loadSessionHandoffForBot(params.handoffId.trim(), params.botId);
    }
    // v0.60: fail-fast cho threadId (như handoffId ở trên): thread lạ
    // phải lỗi ngay trước khi xếp hàng, thay vì để run bắt đầu rồi
    // mới chết trong executeRun. Không dùng chung với resumeRunId
    // (resume đã có messages của run cũ) — threadId khi đó chỉ bị bỏ
    // qua, không lỗi, để replay/resume cũ không vỡ vì caller truyền
    // thừa threadId.
    if (params.threadId !== undefined && !params.resumeRunId) {
      if (typeof params.threadId !== 'string' || params.threadId.trim() === '') {
        throw new Error('threadId phải là id thread không rỗng.');
      }
      const thread = this.getBot(params.botId).memory.getThread(params.threadId.trim());
      if (!thread || thread.botId !== params.botId) {
        throw new Error(
          `Không tìm thấy thread "${params.threadId}" của bot "${params.botId}".`,
        );
      }
    }
    // v0.9a: every run gets an id that travels with it — the caller's
    // when supplied (WS clients pass the stream's run id so a later
    // `stopRun` addresses exactly this run), generated here otherwise.
    // It is stamped on the queued params so stopRun can also cancel a
    // run that has not started yet.
    const runId = (params as RunParamsWithId).runId ?? randomUUID();
    (params as RunParamsWithId).runId = runId;
    return new Promise<RunResult>((resolve, reject) => {
      this.runQueue.push({ params, resolve, reject });
      this.pumpRunQueue();
    });
  }

  /**
   * Start queued runs while a slot is free. Called on every enqueue
   * and every time a run settles. Synchronous: starting a run never
   * awaits, so a queued run can never delay a run already executing.
   */
  private pumpRunQueue(): void {
    while (this.activeRuns < this.maxConcurrentRuns) {
      // First queued run whose bot is not already running a turn.
      const idx = this.runQueue.findIndex(
        (q) => this.bots.get(q.params.botId)?.running !== true,
      );
      if (idx === -1) return;
      const [next] = this.runQueue.splice(idx, 1);
      this.activeRuns++;
      this.executeRun(next.params).then(next.resolve, (err) => {
        // v0.37: executeRun có thể throw TRƯỚC khối try/finally chính
        // (validate handoff/resume, dựng runner, đo context...) — khi đó
        // entry.running kẹt true và mọi run sau của bot treo trong hàng
        // đợi mãi (pumpRunQueue chỉ chạy bot có running !== true).
        // Reset ở đây để mọi lỗi sớm đều mở khoá bot; khối finally
        // chính đã reset rồi thì reset lại cũng vô hại (idempotent).
        // Không có run mới nào chen vào được trước handler này
        // (microtask ordering: handler này chạy trước khi caller kịp
        // gọi run() lại sau khi nhận lỗi).
        const rid = (next.params as RunParamsWithId).runId;
        if (typeof rid === 'string') {
          const reg = this.runsById.get(rid);
          if (reg && reg.botId === next.params.botId) this.runsById.delete(rid);
        }
        const failedEntry = this.bots.get(next.params.botId);
        if (failedEntry) {
          failedEntry.running = false;
          failedEntry.controller = undefined;
        }
        next.reject(err);
      }).finally(() => {
        this.activeRuns--;
        this.pumpRunQueue();
      });
    }
  }

  /**
   * Reject (and drop) queued runs — all of them, or only one bot's.
   * Returns how many were cancelled. A cancelled run's `run()` promise
   * rejects, so the caller learns the run never started.
   */
  private cancelQueuedRuns(botId?: string): number {
    if (botId === undefined) {
      const cancelled = this.runQueue;
      this.runQueue = [];
      for (const q of cancelled) {
        q.reject(new Error('Run bị huỷ: coordinator đang tắt.'));
      }
      return cancelled.length;
    }
    const kept: QueuedRun[] = [];
    let cancelled = 0;
    for (const q of this.runQueue) {
      if (q.params.botId === botId) {
        cancelled++;
        q.reject(
          new Error(`Run của bot "${botId}" bị huỷ khi đang xếp hàng. ` +
            '(stopBot/destroyBot huỷ cả run chưa chạy.)'),
        );
      } else {
        kept.push(q);
      }
    }
    this.runQueue = kept;
    return cancelled;
  }

  /**
   * v0.26 (W19a): context thật của model Ollama local, đo qua provider
   * của bot này (`OllamaProvider.getContextLimit` — `POST /api/show`,
   * best-effort, cache theo model trong instance). Chỉ chạy khi bot
   * dùng Ollama (unwrap `MeteredProvider` khi có spend-limit wrapper);
   * provider khác → `undefined` để `contextLimitForModel` dùng heuristic
   * cũ. Không bao giờ throw — đo lỗi thì guard dùng giá trị cũ thay vì
   * chặn run. Được gọi ở `executeRun` (đã async) trước khi tạo runner,
   * nên `contextLimitForModel` vẫn giữ sync; run sau dùng cache của
   * provider nên không hỏi lại Ollama.
   */
  private async measuredOllamaContextLimit(entry: BotEntry): Promise<number | undefined> {
    let provider: Provider = entry.provider;
    if (provider instanceof MeteredProvider) provider = provider.wrapped;
    if (!(provider instanceof OllamaProvider)) return undefined;
    const model = entry.bot.model || entry.providerConfig.defaultModel || '';
    try {
      return await provider.getContextLimit(model);
    } catch {
      // Best-effort: đo lỗi thì fallback heuristic, không chặn run.
      return undefined;
    }
  }

  /**
   * v0.96 (Đội T3): router chọn model mỗi turn — lazy, một instance
   * cho cả coordinator (pin + log + thống kê sống ở đây). Sink đẩy
   * mỗi quyết định vào harness event log (kind 'router.decision')
   * để EventLog/SSE thấy được; sink lỗi không bao giờ làm hỏng turn
   * (ModelRouter đã bọc try/catch, đây chỉ thêm một lớp nữa).
   *
   * v0.98: sink đồng thời ghi quyết định vào store bền vững theo bot
   * (RouterPanel đọc lại được qua các phiên) và cấu hình hiệu lực
   * = ctor `opts.router` < file `router-config.json` đã lưu (cấu
   * hình user chỉnh trong panel thắng mặc định khởi động).
   */
  private getRouter(): ModelRouter {
    if (!this.routerInstance) {
      let persisted: Partial<RouterConfig> | null = null;
      if (!this.routerPersistedConfigLoaded) {
        this.routerPersistedConfigLoaded = true;
        try {
          persisted = loadRouterConfigFile(this.dataDir);
        } catch {
          persisted = null;
        }
      }
      const effectiveConfig = { ...(this.routerConfig ?? {}), ...(persisted ?? {}) };
      this.routerInstance = new ModelRouter(effectiveConfig, {
        onDecision: (decision: RoutingDecision) => {
          try {
            this.getRouterDecisionStore().append(decision, decision.defaultTargetId);
          } catch {
            // Store bền vững lỗi không làm hỏng turn.
          }
          try {
            this.harness?.publishLoopEvent(
              decision.botId,
              decision.botId,
              decision.target.providerId,
              'router.decision',
              {
                target: `${decision.target.providerId}/${decision.target.model}`,
                layer: decision.layer,
                route: decision.routeId,
                reason: decision.reason,
                latencyMs: decision.latencyMs,
                pinned: decision.pinned,
              },
            );
          } catch {
            // Harness log lỗi không làm hỏng turn.
          }
        },
      });
    }
    return this.routerInstance;
  }

  /** Store lịch sử router (lazy; không có dataDir thì chỉ giữ bộ nhớ). */
  private getRouterDecisionStore(): RouterDecisionStore {
    if (!this.routerDecisionStore) {
      this.routerDecisionStore = new RouterDecisionStore(
        this.dataDir ? { dataDir: this.dataDir } : {},
      );
    }
    return this.routerDecisionStore;
  }

  /** Registry phát hiện CLI (lazy; đọc state file opt-in dưới dataDir). */
  private getDetectedEnginesRegistry(): DetectedEngineRegistry | null {
    if (!this.dataDir) return null;
    if (!this.detectedEnginesRegistry) {
      this.detectedEnginesRegistry = new DetectedEngineRegistry({
        stateFilePath: path.join(this.dataDir, DETECTED_ENGINES_FILE),
        logger: { warn: (msg: string) => console.warn(`[router] engines: ${msg}`) },
      });
    }
    return this.detectedEnginesRegistry;
  }

  /** Các quyết định router gần nhất (bền vững theo bot, mới nhất trước). */
  getRouterDecisions(params: GetRouterDecisionsParams = {}): GetRouterDecisionsResult {
    const limit = typeof params.limit === 'number' && Number.isFinite(params.limit)
      ? Math.min(200, Math.max(1, Math.floor(params.limit)))
      : 20;
    const store = this.getRouterDecisionStore();
    const total = store.getEntries(params.botId).length;
    // Store bền vững là nguồn thật: quyết định từ các phiên trước
    // vẫn còn. Khi store trống (vd dataDir không có) thì rơi về log
    // bộ nhớ của router trong phiên này — LỌC THEO BOT (log nhớ là
    // toàn cục: không lọc thì hỏi bot A lại trả quyết định của bot B).
    if (total > 0) {
      return { decisions: store.getDecisions(params.botId, limit), total };
    }
    const recent = this.getRouter()
      .getRecentDecisions(1000)
      .filter((d) => params.botId === undefined || d.botId === params.botId)
      .slice(0, limit);
    return { decisions: recent, total: recent.length };
  }

  /** Thống kê router (local-vs-cloud, tiết kiệm ước tính, fallback). */
  getRouterStats(params: GetRouterStatsParams = {}): GetRouterStatsResult {
    const store = this.getRouterDecisionStore();
    if (store.getEntries(params.botId).length > 0) {
      const stats = store.getStats(params.botId);
      // Store không biết target không khoẻ — lấy từ router đang chạy.
      try {
        stats.unhealthyTargets = this.getRouter().getStats().unhealthyTargets;
      } catch {
        // Router chưa dựng được thì giữ 0.
      }
      return stats;
    }
    // Store trống → tính từ log nhớ, LỌC THEO BOT như getRouterDecisions
    // (getStats() của router là toàn cục, hỏi một bot không được trả
    // số của bot khác).
    if (params.botId !== undefined) {
      const entries = this.getRouter()
        .getRecentDecisions(1000)
        .filter((d) => d.botId === params.botId)
        .map((d) => ({
          target: d.target,
          layer: d.layer,
          latencyMs: d.latencyMs,
          pinned: d.pinned,
          at: d.at,
          botId: d.botId,
          defaultTargetId: d.defaultTargetId,
          savingsUsd: d.savingsUsd ?? 0,
        }));
      return computeRouterStats(entries, {
        unhealthyTargets: this.getRouter().getStats().unhealthyTargets,
      });
    }
    return this.getRouter().getStats();
  }

  // ------------------------------------------------------------------
  // v0.97 (Team T3): AG-UI — bus / state / generative UI.
  // ------------------------------------------------------------------

  /** Shared AG-UI bus for this child (created lazily on first use). */
  getAgUiBus(): AgUiEventBus {
    if (!this.agUiBusInstance) this.agUiBusInstance = new AgUiEventBus();
    return this.agUiBusInstance;
  }

  /** Shared AG-UI run-state store (created lazily on first use). */
  getAgUiStateStore(): AgUiStateStore {
    if (!this.agUiStateStoreInstance) this.agUiStateStoreInstance = new AgUiStateStore();
    return this.agUiStateStoreInstance;
  }

  /** Shared generative-UI registry (created lazily on first use). */
  getAgUiGenUiRegistry(): AgUiGenerativeUiRegistry {
    if (!this.agUiGenUiRegistryInstance) {
      this.agUiGenUiRegistryInstance = new AgUiGenerativeUiRegistry();
    }
    return this.agUiGenUiRegistryInstance;
  }

  /**
   * Build the AG-UI emitter for one run. Returns `null` when the run
   * must not emit (provider `mock` or CLI-kind — see
   * shouldEmitAgUiForProvider; the harness bus already streams CLI
   * runs, and mock runs are tests). The emitter is inactive for
   * silent runs too, but it is still built so the loop has one
   * object to call — its methods are no-ops there.
   */
  createAgUiEmitter(opts: {
    runId: string;
    botId: string;
    providerId: string;
    model?: string;
    silent?: boolean;
  }): AgUiRuntimeEmitter | null {
    if (!shouldEmitAgUiForProvider(opts.providerId)) return null;
    return new AgUiRuntimeEmitter({
      bus: this.getAgUiBus(),
      stateStore: this.getAgUiStateStore(),
      genUiRegistry: this.getAgUiGenUiRegistry(),
      runId: opts.runId,
      botId: opts.botId,
      providerId: opts.providerId,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.silent === true ? { silent: true } : {}),
    });
  }

  /** Subscribe to live AG-UI events (Local API SSE + renderer feed). */
  subscribeAgUiEvents(
    filter: AgUiEventFilter,
    emit: (event: AgUiEvent) => void,
  ): () => void {
    return this.getAgUiBus().subscribe(filter, emit);
  }

  /** Replay buffered AG-UI events of one run (SSE Last-Event-ID). */
  replayAgUiEvents(runId: string, fromSequence = 0): AgUiEvent[] {
    return this.getAgUiBus().replay(runId, fromSequence);
  }

  /** Current shared state of one run (or undefined when unknown). */
  getAgUiRunState(runId: string): ReturnType<AgUiStateStore['get']> {
    return this.getAgUiStateStore().get(runId);
  }

  /** AG-UI bus statistics (published / delivered / buffered). */
  getAgUiStats(): AgUiBusStats {
    return this.getAgUiBus().stats;
  }

  /** Pending generative-UI components of a run (renderer answers them). */
  getAgUiPendingComponents(runId: string): ReturnType<AgUiGenerativeUiRegistry['pendingForRun']> {
    return this.getAgUiGenUiRegistry().pendingForRun(runId);
  }

  /**
   * Answer a pending generative-UI component on behalf of the user.
   * Returns false when the component does not exist or was already
   * answered. The answer is also emitted as GENERATIVE_UI_RESPONSE
   * on the bus so SSE clients see it.
   */
  answerAgUiComponent(
    componentId: string,
    response: Record<string, unknown>,
    action?: string,
  ): boolean {
    const registry = this.getAgUiGenUiRegistry();
    const record = registry.get(componentId);
    if (!record || record.status !== 'requested') return false;
    try {
      registry.answer(componentId, {
        componentId,
        response,
        ...(action !== undefined ? { action } : {}),
      });
    } catch {
      return false;
    }
    this.getAgUiBus().publish({
      protocol: 'agui/1.0',
      type: 'GENERATIVE_UI_RESPONSE',
      runId: record.request.runId,
      ...(record.request.botId !== undefined ? { botId: record.request.botId } : {}),
      timestamp: new Date().toISOString(),
      data: {
        componentId,
        response,
        ...(action !== undefined ? { action } : {}),
      },
    } as AgUiEvent);
    return true;
  }
  /** Cấu hình router hiệu lực (bản sao — caller không sửa được trực tiếp). */
  getRouterConfig(): GetRouterConfigResult {
    const config = this.getRouter().config;
    return {
      ...config,
      layers: { ...config.layers },
      disabledProviders: [...config.disabledProviders],
    };
  }

  /**
   * v0.98: RPC `router.setConfig` — áp patch cấu hình từ RouterPanel
   * xuống router đang chạy + ghi bền vững (`<dataDir>/router-config.json`)
   * để coordinator respawn vẫn giữ. Patch sai → lỗi rõ, giữ nguyên
   * cấu hình cũ. Trả cấu hình hiệu lực sau khi áp.
   */
  setRouterConfig(params: SetRouterConfigParams): SetRouterConfigResult {
    if (!params || typeof params !== 'object' || params.config === undefined) {
      throw new Error('router.setConfig cần params {config}.');
    }
    const knownIds = PROVIDERS.map((p) => p.id);
    const validated = validateRouterConfigPatch(params.config, knownIds);
    if (!validated.ok) {
      throw new Error(`Cấu hình router không hợp lệ: ${validated.errors.join(' ')}`);
    }
    const effective = this.getRouter().updateConfig(validated.config);
    try {
      saveRouterConfigFile(this.dataDir, effective);
    } catch {
      // Ghi file lỗi: cấu hình bộ nhớ vẫn có hiệu lực, lần respawn
      // sau quay về cấu hình cũ — không chặn panel.
    }
    return {
      ...effective,
      layers: { ...effective.layers },
      disabledProviders: [...effective.disabledProviders],
    };
  }

  /** Xoá lịch sử quyết định (một bot hoặc tất cả, cả store lẫn log nhớ). */
  clearRouterLog(params: ClearRouterLogParams = {}): ClearRouterLogResult {
    const fromStore = this.getRouterDecisionStore().clear(params.botId);
    try {
      // Log nhớ cũng phải xoá theo bot: nếu chỉ xoá store thì
      // getRouterDecisions rơi về log nhớ và trả lại quyết định cũ.
      if (params.botId === undefined) {
        this.getRouter().clearLog();
      } else {
        this.getRouter().clearLogForBot(params.botId);
      }
    } catch {
      // Router chưa dựng — không có log nhớ để xoá.
    }
    return { cleared: fromStore };
  }

  /**
   * v0.98: khám phá đích CLI từ registry (binary + đăng nhập +
   * opt-in). Detect có cache 60s trong registry; lần đầu có thể tốn
   * vài giây spawn `--version`/status — caller (getRouterTargets)
   * chạy trong RPC nên không chặn turn nào. Lỗi detect → [] (router
   * chỉ mất đích CLI, không mất default/local).
   */
  private async discoverRouterCliTargets(): Promise<RouterTarget[]> {
    const registry = this.getDetectedEnginesRegistry();
    if (!registry) return [];
    try {
      const snapshot: DetectedEnginesSnapshot = await registry.detect();
      return discoverCliTargets(snapshot);
    } catch {
      return [];
    }
  }

  /**
   * v0.98: RPC `router.getTargets` — mọi đích router có thể offer
   * lúc này: Ollama local + CLI đã phát hiện + API đã có key seed
   * (đã lọc theo cấu hình allow* và disabledProviders). Kèm trạng thái
   * từng engine CLI để UI giải thích vì sao một CLI không được offer.
   */
  async getRouterTargets(): Promise<GetRouterTargetsResult> {
    const router = this.getRouter();
    const config = router.config;
    let local: RouterTarget | null = null;
    try {
      local = config.allowLocal ? await router.discoverLocalTarget() : null;
    } catch {
      local = null;
    }
    let cli: RouterTarget[] = [];
    let cliStatus: RouterCliStatus[] = [];
    try {
      const registry = this.getDetectedEnginesRegistry();
      if (registry) {
        const snapshot: DetectedEnginesSnapshot = await registry.detect();
        const discovered = discoverCliTargets(snapshot);
        cli = config.allowCli
          ? discovered.filter((t) => !config.disabledProviders.includes(t.providerId))
          : [];
        const offeredIds = new Set(cli.map((t) => t.providerId));
        cliStatus = Object.values(snapshot.engines ?? {})
          .map((engine): RouterCliStatus | null => {
            const providerId = PROVIDERS.find(
              (p) => p.kind === 'cli' && p.detectedKind === engine.kind,
            )?.id;
            if (!providerId) return null;
            return {
              providerId,
              kind: engine.kind,
              label: engine.label,
              status: engine.status,
              ...(engine.reason !== undefined ? { reason: engine.reason } : {}),
              enabled: engine.enabled,
              offered: offeredIds.has(providerId),
            };
          })
          .filter((s): s is RouterCliStatus => s !== null)
          .sort((a, b) => a.providerId.localeCompare(b.providerId));
      }
    } catch {
      cli = [];
    }
    const api = config.allowApi
      ? discoverApiTargets([...this.routerApiKeys.keys()]).filter(
          (t) => !config.disabledProviders.includes(t.providerId),
        )
      : [];
    const targets = buildAvailableTargets({
      defaultTarget: {
        id: 'bot-default',
        providerId: '',
        model: '',
        kind: 'api',
      },
      localTarget: local,
      cliTargets: cli,
      apiTargets: api,
    }).filter((t) => t.id !== 'bot-default');
    return { targets, local, cli, api, cliStatus, discoveredAt: Date.now() };
  }

  /**
   * v0.98: RPC `router.setApiKey` — seed key của một provider API
   * cho router (main đọc Vault rồi seed, đúng mẫu `setComposioApiKey`
   * / `setMediaApiKey`). Provider lạ / CLI / Ollama → lỗi rõ, giữ
   * nguyên key cũ; `apiKey` null/rỗng = xoá key đã seed. Trả trạng
   * thái key (không chứa key). Key KHÔNG bao giờ log.
   */
  setRouterApiKey(params: SetRouterApiKeyParams): SetRouterApiKeyResult {
    if (!params || typeof params !== 'object' || typeof params.providerId !== 'string') {
      throw new Error('router.setApiKey cần params {providerId: string, apiKey?: string | null}.');
    }
    const meta = PROVIDERS.find((p) => p.id === params.providerId);
    if (!meta || meta.kind === 'cli' || meta.id === 'ollama' || !meta.defaultModel) {
      throw new Error(`router.setApiKey: provider "${params.providerId}" không phải provider API route được.`);
    }
    if (params.apiKey !== undefined && params.apiKey !== null && typeof params.apiKey !== 'string') {
      throw new Error('router.setApiKey cần apiKey là string, null hoặc vắng.');
    }
    const key = params.apiKey?.trim() ?? '';
    if (!key) this.routerApiKeys.delete(params.providerId);
    else this.routerApiKeys.set(params.providerId, key);
    return this.getRouterApiKeyStatus();
  }

  /** Trạng thái key API router — chỉ danh sách provider id, KHÔNG chứa key. */
  getRouterApiKeyStatus(): SetRouterApiKeyResult {
    return { configured: [...this.routerApiKeys.keys()].sort() };
  }

  /**
   * v0.96 (Đội T3): route một turn rồi dựng provider override khi
   * cần. Trả `{ provider, providerId, model, decision }` — provider
   * mặc định của bot khi router tắt / lỗi / chọn đúng default.
   *
   * Override được 4 dạng đích mà coordinator tự dựng được:
   * - Ollama local (không cần key, model lấy từ target);
   * - cùng provider với bot nhưng khác model (dùng lại
   *   providerConfig của bot, chỉ đổi defaultModel);
   * - v0.98: CLI đã phát hiện (binary + đăng nhập + opt-in từ
   *   registry; driver CLI cần `cliBinary`, lấy từ target);
   * - v0.98: provider API đã có key seed (main seed qua RPC
   *   `router.setApiKey`; key lấy từ map trong bộ nhớ, không log).
   * Mọi trường hợp đều fail-open: bất cứ lỗi nào cũng trả default,
   * không throw.
   *
   * MIỄN TRỪ BẮT BUỘC (giữ nguyên từ v0.96 — xem
   * tests/router-mock-v096.test.mjs): provider `mock` và provider
   * kind `cli` của chính bot KHÔNG BAO GIỜ bị route. Miễn trừ này
   * chỉ áp cho provider CỦA BOT — route SANG đích CLI/API khác từ
   * một bot API/local vẫn được phép (đó là tính năng v0.98).
   */
  private async applyRouting(
    entry: BotEntry,
    params: RunParams,
    historyMessages: ChatMessage[] | undefined,
    contextLimit: number,
  ): Promise<{
    provider: Provider;
    providerId: string;
    model: string;
    decision: RoutingDecision | null;
    overrideProvider: Provider | null;
  }> {
    const fallback = {
      provider: entry.provider,
      providerId: entry.providerConfig.id,
      model: entry.bot.model || entry.providerConfig.defaultModel || '',
      decision: null as RoutingDecision | null,
      overrideProvider: null as Provider | null,
    };
    // v0.96 fix (merge verify): provider `mock` là provider xác định
    // (dùng trong test + chạy thử, không phải model thật) — router
    // KHÔNG BAO GIỜ route bot mock sang Ollama hay model khác. Trước
    // fix này, tầng structural route prompt đơn giản ("xong", "hello")
    // sang Ollama local, làm ~100 test mock-provider nhận câu trả lời
    // thật của qwen thay vì text mock — xem tests/router-mock-v096.
    if (entry.providerConfig.id === 'mock') return fallback;
    // v0.96 fix (merge verify 2): provider CLI (Claude Code, Codex,
    // Grok CLI, ...) là phiên đăng nhập ngoài có trạng thái, chạy
    // trong process riêng — router không được đổi model giữa chừng:
    // vừa phá phiên CLI, vừa phá tính xác định (fake CLI driver trong
    // test model-picker-m4 từng bị route sang Ollama). Router chỉ
    // route giữa các provider API / Ollama local.
    if (PROVIDERS.find((p) => p.id === entry.providerConfig.id)?.kind === 'cli') {
      return fallback;
    }
    try {
      const router = this.getRouter();
      if (!router.config.enabled) return fallback;
      const defaultTarget: RouterTarget = {
        id: 'bot-default',
        providerId: entry.providerConfig.id,
        model: fallback.model,
        kind:
          entry.providerConfig.id === 'ollama'
            ? 'local'
            : (PROVIDERS.find((p) => p.id === entry.providerConfig.id)?.kind === 'cli'
              ? 'cli'
              : 'api'),
        ...(entry.providerConfig.id === 'ollama' ? { costPer1kUsd: 0 } : {}),
        contextLimit,
      };
      const targets: RouterTarget[] = [defaultTarget];
      // Đích local: model chat nhỏ nhất Ollama đang cài (probe /api/tags,
      // cache 60s). Chỉ thêm khi khác default (tránh trùng đích) — việc
      // này do `buildAvailableTargets` khử trùng ở dưới.
      const localTarget = await router.discoverLocalTarget();
      // v0.98: đích CLI đã phát hiện (registry, cache 60s) + đích API
      // đã có key seed. Cả hai đều bỏ qua provider của chính bot
      // (default đã đại diện) và được `buildAvailableTargets` lọc
      // theo cấu hình allow* và disabledProviders + khử trùng.
      const [cliTargets, apiTargets] = await Promise.all([
        this.discoverRouterCliTargets().catch(() => [] as RouterTarget[]),
        Promise.resolve(
          discoverApiTargets([...this.routerApiKeys.keys()], [entry.providerConfig.id]),
        ),
      ]);
      const merged = buildAvailableTargets({
        defaultTarget,
        localTarget,
        cliTargets,
        apiTargets,
        allow: {
          local: router.config.allowLocal,
          cli: router.config.allowCli,
          api: router.config.allowApi,
        },
        disabledProviders: router.config.disabledProviders,
      });
      for (const t of merged) {
        if (t.id !== defaultTarget.id) targets.push(t);
      }
      const contextUsageRatio =
        historyMessages && historyMessages.length > 0
          ? Math.min(
              1,
              historyMessages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0) /
                4 /
                Math.max(1, contextLimit),
            )
          : 0;
      const decision = await router.route({
        text: params.text,
        botId: params.botId,
        ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
        defaultTarget,
        availableTargets: targets,
        contextUsageRatio,
      });
      if (decision.target.id === defaultTarget.id) return { ...fallback, decision };
      // Override: cùng provider, khác model.
      if (decision.target.providerId === entry.providerConfig.id) {
        const override = this.buildProvider(entry.bot.id, {
          ...entry.providerConfig,
          defaultModel: decision.target.model,
        });
        return {
          provider: override,
          providerId: decision.target.providerId,
          model: decision.target.model,
          decision,
          overrideProvider: override,
        };
      }
      // Override: Ollama local.
      if (decision.target.providerId === 'ollama') {
        const override = this.buildProvider(entry.bot.id, {
          id: 'ollama',
          defaultModel: decision.target.model,
          baseUrl: entry.providerConfig.id === 'ollama' ? entry.providerConfig.baseUrl : undefined,
        } as CreateBotProviderConfig);
        return {
          provider: override,
          providerId: 'ollama',
          model: decision.target.model,
          decision,
          overrideProvider: override,
        };
      }
      // v0.98 — Override: CLI đã phát hiện (target mang cliBinary do
      // detector tìm thấy; driver CLI throw khi thiếu binary nên chỉ
      // dựng khi có binary, thiếu thì giữ default fail-open).
      if (decision.target.kind === 'cli') {
        const meta = PROVIDERS.find((p) => p.id === decision.target.providerId);
        if (decision.target.cliBinary && meta) {
          try {
            const override = this.buildProvider(entry.bot.id, {
              id: decision.target.providerId,
              label: meta.label,
              defaultModel: decision.target.model,
              cliBinary: decision.target.cliBinary,
              ...(decision.target.cliArgs !== undefined ? { cliArgs: decision.target.cliArgs } : {}),
            } as CreateBotProviderConfig);
            return {
              provider: override,
              providerId: decision.target.providerId,
              model: decision.target.model,
              decision,
              overrideProvider: override,
            };
          } catch {
            return { ...fallback, decision };
          }
        }
        return { ...fallback, decision };
      }
      // v0.98 — Override: provider API đã có key seed (key lấy từ map
      // trong bộ nhớ — main seed qua RPC `router.setApiKey`; không có
      // key thì target đã không được offer, nhưng check lại ở đây để
      // không bao giờ dựng provider API thiếu key).
      if (decision.target.kind === 'api') {
        const apiKey = this.routerApiKeys.get(decision.target.providerId);
        const meta = PROVIDERS.find((p) => p.id === decision.target.providerId);
        if (apiKey && meta) {
          try {
            const override = this.buildProvider(entry.bot.id, {
              id: decision.target.providerId,
              label: meta.label,
              apiKey,
              defaultModel: decision.target.model,
              ...(meta.defaultBaseUrl ? { baseUrl: meta.defaultBaseUrl } : {}),
            } as CreateBotProviderConfig);
            return {
              provider: override,
              providerId: decision.target.providerId,
              model: decision.target.model,
              decision,
              overrideProvider: override,
            };
          } catch {
            return { ...fallback, decision };
          }
        }
        return { ...fallback, decision };
      }
      // Đích khác không dựng được → giữ default (đã log trong decision).
      return { ...fallback, decision };
    } catch {
      return fallback;
    }
  }

  /** One queued run, actually executing (was `run()` before v0.8). */
  private async executeRun(params: RunParams): Promise<RunResult> {
    const entry = this.getBot(params.botId);
    const botId = params.botId;
    const controller = new AbortController();
    entry.controller = controller;
    entry.running = true;
    entry.stopRequested = false;
    // v0.60 (P0 Stop race): a stop that arrived before this run's RPC
    // (stopBot found nothing running and recorded `pendingStopAt`)
    // is honoured now by aborting this run's fresh controller before
    // any provider call, so the run settles as stopped in milliseconds
    // instead of running to completion. Consumed either way — a stale
    // stop must never kill an unrelated later run. `stopRequested` is
    // set too so even a path that never throws still reports stopped.
    const pendingStop =
      entry.pendingStopAt !== undefined &&
      Date.now() - entry.pendingStopAt <= this.pendingStopWindowMs;
    entry.pendingStopAt = undefined;
    // v0.74a: stop theo runId tới trước khi run này bắt đầu (ghi ở
    // `stopRun`) — cùng ngữ nghĩa với cờ theo bot ở trên: tiêu thụ
    // một lần, hết hạn 30s thì bỏ qua, abort trước mọi provider call.
    // (Tên khác `runId` khai ở dưới để tránh redeclare — runId thật
    // được đăng ký vào `runsById` ở khối sau.)
    const pendingRunId = (params as RunParamsWithId).runId;
    let pendingStopById = false;
    if (typeof pendingRunId === 'string') {
      const recordedAt = this.pendingStopByRunId.get(pendingRunId);
      this.pendingStopByRunId.delete(pendingRunId);
      pendingStopById =
        recordedAt !== undefined && Date.now() - recordedAt <= this.pendingStopWindowMs;
    }
    if (pendingStop || pendingStopById) {
      entry.stopRequested = true;
      controller.abort();
    }
    // M4: model switch đang chờ (switchModel gọi trong lúc run trước
    // còn chạy) được áp dụng NGAY ĐẦU run này — trước khi dựng runner
    // (runner lấy entry.provider lúc tạo) và trước khi đọc plan stamp.
    // Run trước đã chạy xong nên không bị ngắt; run này chạy bằng
    // provider mới với cùng BotMemory (thread giữ nguyên).
    const pendingSwitch = this.pendingModelSwitches.get(botId);
    if (pendingSwitch !== undefined) {
      this.pendingModelSwitches.delete(botId);
      this.swapProvider(entry, pendingSwitch);
    }
    // v0.9a: register the run by id so stopRun can abort exactly this
    // run (a bot never runs two turns at once, but two bots may run in
    // parallel — stopBot by bot id cannot tell them apart from the
    // caller's side when the caller only knows the run id).
    const runId = (params as RunParamsWithId).runId ?? randomUUID();
    this.runsById.set(runId, { botId, controller });

    // v0.19 (W12e): dấu plan-approved dùng một lần — run ngay sau khi
    // duyệt plan của bot này được tự duyệt tool-call, không hiện thẻ
    // approval nữa. Dấu bị tiêu thụ ngay khi run bắt đầu (dù run có gọi
    // tool hay không, dù run lỗi/dừng) nên không rò sang run sau; run
    // của bot khác không dùng được (dấu gắn theo botId). Chỉ override
    // trên bản copy bot đưa cho runner của run này — entry.bot.autoApprove
    // và policy permissions (true -> 'all', mặc định 'safe-only') không
    // đổi, nên run thường sau đó vẫn hỏi approval như cũ.
    // v0.20 (W15a): dấu `revision` (sau request-changes) cũng tiêu thụ
    // ngay tại đây, nhưng KHÔNG set autoApprove — nó chỉ tự duyệt riêng
    // tool `plan_create` qua onApprovalNeeded bên dưới; các tool khác
    // trong run vẫn hỏi approval như thường.
    const planStamp = this.planApprovedRuns.get(botId);
    if (planStamp !== undefined) {
      this.planApprovedRuns.delete(botId);
    }
    const planApprovedRun = planStamp?.kind === 'approve';
    const planRevisionRun = planStamp?.kind === 'revision';

    // v0.92c (stop-flake harden): run đã bị stop TRƯỚC khi bắt đầu
    // (pendingStop theo bot — v0.60 — hoặc theo runId — v0.74a) thì
    // trả kết quả stopped NGAY tại đây, trước mọi công việc chuẩn bị
    // của run (resolve mentions/slash, match skill + nạp body,
    // load AGENTS.md, dựng hook runner / guardrails / tracer,
    // resume/history, đo context Ollama, dựng AgentRunner rồi chạy
    // validation của loop). Trước đây stop chỉ được tôn trọng sâu
    // trong runLoop (throwIfAborted ở step 0), nên toàn bộ setup đó
    // vẫn nằm trong cửa sổ đo của test — trên máy 1,5 CPU khi tải
    // cao (full suite chạy song song) setup lạnh có thể kéo elapsed
    // vượt ngưỡng 2s dù quyết định dừng là tức thì (đo được: cold
    // stop-run 12–117ms, warm 1–7ms, trong khi test đầu file dưới
    // tải song song 8-way đã dài tới 18,2s — xem BEYOND-ROADMAP
    // v0.92c). Đường này không có await nào chen giữa khối tiêu thụ
    // cờ ở trên và đây, nên không run nào khác quan sát được trạng
    // thái dở dang; các side-effect rẻ của đường chạy thường đã xong
    // ở trên (áp model switch, tiêu thụ dấu plan-approved, đăng ký
    // run vào runsById) nên chỉ còn dọn đúng phần đó — như khối
    // finally của đường chạy thường — rồi trả về. Handoff/resume
    // KHÔNG chạy: run chưa bao giờ bắt đầu nên không tiêu thụ handoff
    // (record vẫn dùng được cho run sau) và không báo lỗi resume;
    // chỉ dọn chuỗi handoff của run thường như đường chạy thường làm.
    // Kết quả trả về giữ nguyên hợp đồng cũ (text 'Đã dừng...',
    // stopped:true, runId của run này).
    if (pendingStop || pendingStopById) {
      this.runsById.delete(runId);
      if (!params.resumeRunId) {
        if (this.handoffRunIds.has(runId)) this.handoffRunIds.delete(runId);
        else this.handoffChains.delete(botId);
      }
      entry.running = false;
      entry.controller = undefined;
      return { botId, text: 'Đã dừng run theo yêu cầu.', stopped: true, runId };
    }

    // v0.4 silent run (automation/dream): informational events are NOT
    // forwarded to the parent; approval / ask-user still are (they need
    // the user). A silent run never spams the chat UI.
    const silent = params.silent === true;
    const emitInfo = (kind: AgentEventKind, payload: unknown): void => {
      if (!silent) this.emitEvent(botId, kind, payload);
    };

    // v0.98 (Team T4 — planning v2): bind a run plan when the run
    // carries planId — dispatch its next step now; the step settles
    // in the `finally` block below, which runs on every exit path
    // (success, error, stop). A bad planId never kills the run: the
    // run proceeds unbound. Silent runs keep their plan state but
    // emit no plan events (v0.4 contract, via silentPlanRuns).
    let planRunError: string | undefined;
    if (typeof params.planId === 'string' && params.planId.trim()) {
      if (silent) this.silentPlanRuns.add(runId);
      try {
        this.runPlanBinding.bindRun(runId, botId, params.planId.trim());
      } catch {
        this.silentPlanRuns.delete(runId);
      }
    }

    const events: AgentEvents = {
      onText: (delta: string) => emitInfo('delta', delta),
      // v0.98: every tool call/result of a bound run feeds the plan's
      // stuck detector (signatures only, never raw arguments).
      onToolCall: (call: ToolCall) => {
        emitInfo('toolcall', call);
        this.notePlanToolCall(runId, call);
      },
      onToolResult: (result) => {
        emitInfo('toolresult', result);
        this.notePlanToolResult(runId, result);
      },
      onApprovalNeeded: async (call: ToolCall): Promise<boolean | ApprovalDecision> => {
        if (entry.bot.autoApprove) return true;
        // v0.20 (W15a): run mang dấu revision (sau request-changes) chỉ
        // tự duyệt riêng tool `plan_create` — agent lập lại plan mới
        // không bị chặn bởi thẻ approval của chính lần nộp lại đó.
        // Mọi tool khác (kể cả tool ghi) vẫn đi tiếp xuống emit thẻ
        // như thường; loop cũng chỉ gọi handler này khi tool có
        // needsApproval (plan_create có needsApproval: true) nên
        // nhánh permissions 'ask' không hỏi trùng.
        if (planRevisionRun && call.name === 'plan_create') return true;
        // The runner's ToolCall id IS the call id the UI needs.
        const callId = call.id;
        // v0.50 (M8): thẻ duyệt hiện thêm lý do + args rút gọn đã redact
        // secret (tính ở đây để renderer/CLI không tự xử lý secret).
        const toolDef = entry.tools.find((t) => t.definition.name === call.name);
        const reason = toolDef?.needsApproval
          ? 'Tool này cần phê duyệt trước khi chạy.'
          : 'Bot yêu cầu duyệt trước khi chạy tool này.';
        // v0.50 (M8): đăng ký pending TRƯỚC khi emit — handler emit có
        // thể trả lời ĐỒNG BỘ (vd headless CLI từ chối ngay trong emit);
        // emit trước rồi mới set thì respondApproval lúc đó thấy
        // found:false và run treo tới hết timeout 10 phút.
        const approvalPromise = new Promise<boolean | ApprovalDecision>((resolve) => {
          this.pendingApprovals.set(callId, resolve);
          // Hết 10 phút không trả lời thì mặc định từ chối (an toàn).
          setTimeout(() => {
            if (this.pendingApprovals.has(callId)) {
              this.pendingApprovals.delete(callId);
              resolve(false);
            }
          }, RESPONSE_TIMEOUT_MS).unref();
        });
        this.emitEvent(botId, 'approval-needed', {
          callId,
          call,
          reason,
          argsSummary: summarizeArgsForCard(call.args),
          // v1.01 (Đội T3, risk budget): risk loop đã chấm cho call này
          // (gắn trên call.risk ở executeCallInner) để UI hiện badge.
          ...(call.risk !== undefined ? { risk: call.risk } : {}),
        });
        return approvalPromise;
      },
      // Agent hỏi người dùng (tool ask_user): parent hiện hộp thoại ở
      // renderer và trả lời qua `respondAskUser`. Hết 10 phút thì ''.
      onAskUser: async (question: string, options?: string[]): Promise<string> => {
        const requestId = randomUUID();
        // v0.50 (M8): đăng ký pending TRƯỚC khi emit (cùng race như
        // onApprovalNeeded ở trên — handler emit có thể trả lời đồng bộ).
        const answerPromise = new Promise<string>((resolve) => {
          this.pendingAskUser.set(requestId, resolve);
          setTimeout(() => {
            if (this.pendingAskUser.has(requestId)) {
              this.pendingAskUser.delete(requestId);
              resolve('');
            }
          }, RESPONSE_TIMEOUT_MS).unref();
        });
        this.emitEvent(botId, 'ask-user', { requestId, question, options });
        return answerPromise;
      },
      onProgress: (message: string) => {
        emitInfo('progress', message);
        // v0.98: observable activity resets the plan's stall clock.
        this.notePlanActivity(runId);
      },
      // v1.01 (Đội T3, risk budget): run đổi trạng thái (vd vào
      // waiting-for-confirmation) → renderer hiện "đang chờ duyệt".
      // v1.01 merge: silent run không phát event (hợp đồng v0.4) —
      // onRunStateChange gọi emitEvent trực tiếp nên phải chặn ở đây,
      // không qua emitInfo.
      onRunStateChange: (state) => {
        if (!silent) this.emitEvent(botId, 'run-state', { runId, state });
      },
      // v1.01 (Đội T3): budget conversation vượt ngưỡng → renderer
      // hiện cảnh báo trên BudgetMeter (chỉ cảnh báo, không chặn run).
      // Silent run cũng không phát (cùng hợp đồng v0.4).
      onBudgetAlert: (alert) => {
        if (silent) return;
        this.emitEvent(botId, 'budget-alert', {
          runId,
          kind: alert.kind,
          basis: alert.basis,
          snapshot: alert.snapshot,
        });
      },
      onFinalSummary: (summary: string) => emitInfo('summary', summary),
    };

    // v0.15: @-mentions — `@files` / `@docs` inline trong text người dùng
    // được resolve TRƯỚC slash: slash thay cả text bằng template nên phải
    // resolve mention trước khi slash "nuốt" text. File bị bỏ qua thì báo
    // qua progress để người dùng biết (model đã thấy ghi chú trong text).
    let runText = params.text;
    const mentions = resolveMentions(params.text, entry.bot.workspaceDir);
    if (mentions.included.length > 0 || mentions.skipped.length > 0) {
      runText = mentions.text;
      if (mentions.skipped.length > 0) {
        emitInfo(
          'progress',
          mentions.skipped
            .map((s) => `@${s.kind} ${s.path}: ${s.reason}`)
            .join('\n'),
        );
      }
    }

    // v0.14: slash commands — `/name args` expands to the rendered prompt
    // BEFORE anything else sees the text. Unknown `/foo` passes through
    // unchanged to the model.
    const slash = this.resolveSlashCommand(entry, runText);
    if (slash) {
      runText = slash.rendered;
      emitInfo('progress', `Đã chạy lệnh /${slash.name}.`);
    }

    // v0.37 (P1-3): nhận handoff phiên làm việc — nạp record, chèn khối
    // ngữ cảnh bàn giao vào ĐẦU runText (sau mentions/slash để slash vẫn
    // nhận diện đúng, trước skill matching để skill khớp cả nội dung bàn
    // giao). Không dùng chung với resumeRunId (resume đã có messages của
    // run cũ). Đánh dấu đã nhận kèm runId ngay tại đây để record ghi rõ
    // run nào đã nạp nó; RunResult trả `acceptedHandoff` làm xác nhận.
    let acceptedHandoff: AcceptedHandoffConfirmation | undefined;
    if (params.handoffId !== undefined) {
      if (typeof params.handoffId !== 'string' || params.handoffId.trim() === '') {
        throw new Error('handoffId phải là id record không rỗng.');
      }
      if (params.resumeRunId) {
        throw new Error(
          'Không dùng handoffId cùng resumeRunId — resume đã có messages của run cũ.',
        );
      }
      const record = this.loadSessionHandoffForBot(params.handoffId.trim(), botId);
      const acceptedAt = new Date().toISOString();
      const updated =
        this.getSessionHandoffStore().markAccepted(record.id, {
          botId: entry.bot.id,
          botName: entry.bot.name,
          runId,
          acceptedAt,
        }) ?? record;
      acceptedHandoff = acceptedHandoffConfirmation(updated, acceptedAt);
      runText = `${formatSessionHandoffForPrompt(updated)}\n\n${runText}`;
    }

    // v0.4: inject matching skills into THIS run's system prompt only;
    // the stored bot.systemPrompt never changes.
    // v0.29 (P0-1): progressive disclosure, 2 bước trong run này:
    //  - Tier 1 — chỉ tên + mô tả của mọi skill đang bật (~100
    //    token/skill) vào prompt, để model biết skill nào có thể gọi
    //    tên; KHÔNG chèn body ở đây.
    //  - Tier 2 — applySkillsForTask ở dưới chỉ nạp body của skill
    //    KHỚP nhiệm vụ (matchSkills như cũ, không đổi hành vi match).
    // v0.33 (P0-1 fork-execution): skill `context: fork` KHÔNG chèn
    // body vào prompt cha (excludeFork) và KHÔNG vào tool filter của
    // cha — chúng chạy trong subagent riêng (xem `forkSkills` ở dưới,
    // loop.ts `executeForkSkills`); `allowed-tools` của chúng chỉ giới
    // hạn tool của subagent con, không thu hẹp tool của cha.
    let systemPrompt = entry.bot.systemPrompt;
    // v0.64 (skills per-bot): skill đã tắt cho bot này (BotConfig
    // .denySkills, đã đăng ký vào AgentPermissions lúc tạo bot — xem
    // setBotPolicy ở createBot / createAgentBot) không được match,
    // không vào index tier 1, không nạp body tier 2 và không fork —
    // skill bị tắt không tốn context của turn này. Lọc ở ĐÂY (mỗi
    // turn), không sửa SkillRegistry dùng chung (registry phục vụ mọi
    // bot — sửa nó sẽ tắt skill cho cả bot khác). `matchedSkills` đã
    // lọc là nguồn duy nhất của cả `inlineSkills` (tool filter) lẫn
    // `forkSkills` dưới đây, nên một chỗ lọc là đủ; `applySkillsForTask`
    // nhận thêm `exclude` làm lớp chặn thứ hai.
    const denySkills = new Set(entry.bot.denySkills ?? []);
    const matchedSkills = this.skillRegistry
      ? this.skillRegistry.matchSkills(runText, 3, denySkills).map((m) => m.skill)
      : [];
    const inlineSkills = matchedSkills.filter((s) => !skillRunsInSubagent(s));
    const forkSkills: ForkSkillInput[] = [];
    if (this.skillRegistry) {
      const index = this.skillRegistry.formatSkillIndex(denySkills);
      if (index) systemPrompt += `\n\n${index}`;
      systemPrompt = this.skillRegistry.applySkillsForTask(systemPrompt, runText, 3, {
        excludeFork: true,
        exclude: denySkills,
      });
      for (const skill of matchedSkills) {
        if (!skillRunsInSubagent(skill)) continue;
        const loaded = this.skillRegistry.loadBody(skill.name);
        if (loaded) {
          forkSkills.push({
            name: skill.name,
            description: skill.description,
            body: loaded.body,
            allowedTools: [...skill.allowedTools],
          });
        } else {
          systemPrompt +=
            `\n\n[Skill ${skill.name} (context: fork) không nạp được body nên bỏ qua — ` +
            `chạy tiếp không có skill này.]`;
        }
      }
    }
    // v0.6: working mode (set_agent_mode stores it in memory) — drives
    // both the system-prompt hint and the v0.10 tool filter.
    let mode: AgentMode | undefined;
    try {
      const modeRaw = entry.memory.getMemory(botId, 'agent:mode');
      if (typeof modeRaw === 'string' && isAgentMode(modeRaw)) mode = modeRaw;
      if (mode === 'grind') {
        systemPrompt +=
          '\n\n[Chế độ làm việc: grind — làm việc dài hơi theo kế hoạch, chia nhỏ thành từng lát, ' +
          'dùng grind_status để kiểm tra tiến độ và dừng lại ghi checkpoint khi gặp trở ngại.]';
      } else if (mode === 'review') {
        systemPrompt +=
          '\n\n[Chế độ làm việc: review — kiểm tra, rà soát và nhận xét kỹ lưỡng trước khi sửa đổi gì.]';
      } else if (mode === 'plan') {
        // v0.11 (P0-3) — plan mode thật: plan_create là cách duy nhất để
        // nộp plan. Tool filter v0.10 chỉ để lộ tool chỉ-đọc cho model,
        // nên plan_create / plan_update không nằm trong danh sách
        // definitions gửi đi; v0.30 đóng nốt lỗ fallback: loop chặn
        // fail-closed mọi tool ghi/shell ở đầu executeCallInner (kể cả
        // khi model gọi đúng tên), nên hướng dẫn gọi tool ở đây là đủ
        // để model nộp/duyệt plan.
        systemPrompt +=
          '\n\n[Chế độ làm việc: plan — CHỈ khảo sát bằng tool chỉ-đọc, KHÔNG thực thi bước nào. ' +
          'Khi đã đủ thông tin, nộp plan bằng tool plan_create với title, steps (mỗi bước một chuỗi) và ' +
          'decisions (các lựa chọn cần người dùng quyết, có thể rỗng): plan sẽ được ghi ra file Markdown ' +
          'trong workspace (.open-bot/plans/) và chờ người dùng duyệt ở màn hình Kế hoạch. Sau khi nộp ' +
          'plan thì DỪNG và chờ — không tự thực thi. Khi người dùng nhắn duyệt plan, gọi plan_update với ' +
          'reviewDecision "approve" (duyệt: mode chuyển sang chat, thực thi từ lượt sau), "reject" (từ chối: ' +
          'không thực thi, mode vẫn là plan) hoặc "request-changes" kèm note (yêu cầu sửa: ghi note rồi lập ' +
          'lại plan mới và nộp lại để duyệt).]';
      }
    } catch {
      // Mode is advisory; ignore a failed read.
    }

    // v0.34 (P1-6): workspace rules — AGENTS.md theo thứ bậc thư mục
    // (gốc workspace -> thư mục làm việc hiện tại, file gần hơn ưu tiên
    // hơn) được nối vào system prompt mỗi run. Loader cache theo
    // mtime+size nên file đổi là run mới thấy ngay, không cần hot-reload
    // trong run. File thiếu/không đọc được thì bỏ qua.
    try {
      const rules = loadAgentsMd(entry.bot.workspaceDir, { cwd: params.cwd });
      if (rules) {
        const sourceList = rules.sources.map((s) => s.relative).join(', ');
        systemPrompt +=
          `\n\n[Quy tắc workspace (${sourceList} — tuân theo khi làm việc trong workspace này; ` +
          `file ở thư mục gần thư mục làm việc hơn được ưu tiên khi xung đột):]\n` +
          rules.content;
        if (rules.truncated) {
          systemPrompt +=
            `\n\n[Chú ý: một số file AGENTS.md đã bị rút gọn vì quá dài (${rules.truncatedFiles.join(', ')}) ` +
            `— xem nội dung đầy đủ qua lệnh getWorkspaceRules.]`;
        }
      }
    } catch {
      // Rules are advisory; ignore a failed load.
    }

    // v0.95d4 (Đội D4): cá nhân hoá + trí nhớ dài hạn vào system
    // prompt của turn này — profile user (tên, cách xưng hô, sở thích,
    // thói quen, facts từ `<userData>/profile.json`) + recall top-k
    // memory liên quan tới tin user (ngữ nghĩa qua Ollama local,
    // fallback từ khoá khi Ollama chưa chạy; ngân sách ~1500 token).
    // Best-effort, fail-open về hành vi cũ: lỗi ở đây không bao giờ
    // chặn turn (chỉ mất section memory). Memory thuộc user hiện tại
    // + bot này + memory chung; không đọc memory của user/bot khác.
    try {
      const profile = this.dataDir ? loadLocalProfile(this.dataDir) : null;
      const longTermStore = new LongTermMemory(entry.bot.workspaceDir);
      const blocksStore = new MemoryBlockStore(entry.bot.workspaceDir);
      // v0.96 (Đội T1): consolidation lúc idle — chạy TRƯỚC khi dựng
      // turn context để fact vừa promote lên block human có mặt ngay
      // trong turn này. Mặc định TẮT (enabled=false) nên bình thường
      // đây là no-op; ghi nhận hoạt động để đồng hồ idle đo từ turn này.
      runIdleConsolidationIfDue(longTermStore, blocksStore);
      noteConsolidationActivity(blocksStore);
      // v0.98 (Đội T1): temporal knowledge graph — ghi turn của user
      // thành episode (chống trùng theo runId+turn), rồi đếm turn cho
      // sleep agent; đủ N turn thì agent nền chạy (fire-and-forget,
      // fail-open — lỗi không bao giờ chặn turn). Mặc định sleep agent
      // TẮT (enabled=false trong config) nên bình thường chỉ ingest.
      try {
        const graphStore = TemporalGraphStore.fromWorkspace(entry.bot.workspaceDir);
        const userId = profile?.userId ?? '';
        const runId = params.runId ?? '';
        const turnId = runId !== '' ? `run:${runId}` : `turn-${Date.now()}`;
        graphStore.ingestEpisode({
          turnId,
          runId,
          botId,
          userId,
          role: 'user',
          text: runText,
        });
        const sleepAgent = createGraphSleepAgent(entry.bot.workspaceDir, botId, userId === '' ? undefined : userId);
        sleepAgent.noteTurn();
        void sleepAgent.maybeRun().catch(() => undefined);
      } catch {
        // Graph ingest/sleep là best-effort; lỗi không chặn turn.
      }
      const memCtx = await buildMemoryTurnContext({
        profile,
        store: longTermStore,
        blocksStore,
        botId,
        userId: profile?.userId,
        userText: runText,
        embedder: this.getMemoryEmbedder(),
      });
      if (memCtx.section) systemPrompt += `\n\n${memCtx.section}`;
    } catch {
      // Memory is advisory; ignore a failed recall.
    }

    // v0.96 (Đội T2): repo map vào system prompt của turn — bản đồ file
    // quan trọng nhất của thư mục làm việc (Personalized PageRank trên
    // đồ thị tham chiếu, signature-only, vừa token budget). Mặc định
    // BẬT cho bot có thư mục làm việc (`repoMapEnabled !== false`);
    // tắt riêng cho bot trong Settings → Model (xem BotConfig).
    // Best-effort như memory ở trên: thư mục không đọc được / không có
    // file code thì section rỗng, turn chạy tiếp như cũ. Parse cache
    // theo mtime ở @open-bot/tools nên turn sau không parse lại file
    // chưa đổi; lần đầu trên repo lớn (vài trăm file) tốn vài giây.
    try {
      const workingDir = params.cwd ?? entry.bot.workspaceDir;
      if (entry.bot.repoMapEnabled !== false && workingDir) {
        const toolsMod = require('@open-bot/tools') as {
          buildRepoMapSection?: (
            rootDir: string,
            options?: {
              enabled?: boolean;
              tokenBudget?: number;
              userText?: string;
            },
          ) => Promise<string>;
        };
        const buildSection = toolsMod.buildRepoMapSection;
        if (typeof buildSection === 'function') {
          const section = await buildSection(workingDir, {
            userText: runText,
            tokenBudget: entry.bot.repoMapTokenBudget,
          });
          if (section) systemPrompt += `\n\n${section}`;
        }
      }
    } catch {
      // Repo map is advisory; ignore a failed build.
    }

    // v0.14: bundle subagents (from plugin bundles) — listed so the model
    // can invoke them via delegate_specialized with the exact spec.
    if (entry.bundleSubagents.length > 0) {
      systemPrompt +=
        '\n\n[Subagent chuyên biệt có sẵn (từ plugin bundle — gọi bằng tool delegate_specialized với đúng name/instructions dưới đây):]\n' +
        entry.bundleSubagents
          .map((s) => `- ${s.name}: ${(s.instructions ?? '').trim()}`)
          .join('\n');
    }

    // v0.10: skills matched for THIS run (for the tool filter) + the
    // safety/tracing stack. Secrets are only used for redaction — never logged.
    // v0.33: `matchedSkills`/`inlineSkills`/`forkSkills` đã tách ở trên
    // (fork skill không vào tool filter của cha — xem ghi chú ở đó).
    const hookRunner = this.getHookRunner();
    const secrets = [entry.providerConfig.apiKey, this.xBearer, this.githubToken].filter(
      (s): s is string => typeof s === 'string' && s.length > 0,
    );
    const guardrails = createDefaultRegistry({
      workspaceDir: entry.bot.workspaceDir,
      knownSecrets: secrets,
    });
    const traceStore = this.getTraceStore();
    const tracer = traceStore ? new Tracer({ runId, botId, secrets }) : undefined;

    // v0.12: resume từ checkpoint — tải state của run cũ (messages + step
    // tiếp theo) rồi chạy tiếp; không có checkpoint thì lỗi rõ ngay.
    // v0.12: run thường (không phải handoff) bắt đầu nhiệm vụ mới nên xoá
    // chuỗi handoff cũ của bot; run handoff giữ chuỗi để hop counter chạy tiếp.
    let initialMessages: ChatMessage[] | undefined;
    let startStep: number | undefined;
    if (params.resumeRunId) {
      const state = resumeFromCheckpoint(entry.memory, params.resumeRunId, params.resumeStep ?? 'latest');
      if (!state) {
        throw new Error(
          `Không resume được run "${params.resumeRunId}" — chưa có checkpoint nào cho run này.`,
        );
      }
      initialMessages = state.messages;
      startStep = state.nextStepIndex;
    } else if (this.handoffRunIds.has(runId)) {
      this.handoffRunIds.delete(runId);
    } else {
      this.handoffChains.delete(botId);
    }

    // v0.26 (W19a): context thật của model Ollama local, đo qua provider
    // (`OllamaProvider.getContextLimit` — `POST /api/show`, best-effort,
    // cache theo model). Tính MỘT lần ở đây để vừa làm ngân sách history
    // (v0.60, dưới đây) vừa làm compaction limit của runner (trước đây
    // tính inline trong options của runner); provider khác / đo lỗi →
    // undefined → heuristic cũ trong `contextLimitForModel`.
    const measuredLimit = await this.measuredOllamaContextLimit(entry);
    const contextLimit = contextLimitForModel(
      entry.providerConfig.id,
      entry.bot.model,
      measuredLimit,
    );

    // v0.60: seed history thread làm context — nạp các message gần nhất
    // của thread (đã cắt theo cap) rồi đưa cho runner qua option
    // `historyMessages`; loop chèn giữa system prompt và tin mới:
    // [system, ...history, user]. Chỉ khi run mới có threadId (không
    // resume — resume đã có messages của run cũ). Thread rỗng →
    // history rỗng → runner chạy y như trước (không có history).
    // LƯU Ý dedup: main (`chat:send`) lưu tin user vào BotMemory
    // TRƯỚC khi gọi run, nên tin hiện tại đã nằm cuối history —
    // `selectThreadHistory` bỏ đúng message cuối trùng `params.text`
    // để model không thấy tin hiện tại hai lần. Caller nào chưa lưu
    // tin trước thì dedup là no-op.
    // Fail-closed: thread bị xoá giữa lúc xếp hàng và lúc chạy thì
    // `getThreadHistory` throw lỗi rõ — pumpRunQueue reset cờ running
    // nên bot không kẹt (như handoff, xem ghi chú ở `run()`).
    let historyMessages: ChatMessage[] | undefined;
    if (params.threadId !== undefined && !params.resumeRunId) {
      const rawHistory = entry.memory.getThreadHistory(
        params.threadId.trim(),
        THREAD_HISTORY_MAX_MESSAGES,
      );
      historyMessages = selectThreadHistory(rawHistory, {
        maxMessages: THREAD_HISTORY_MAX_MESSAGES,
        maxTokens: threadHistoryTokenBudget(contextLimit),
        currentText: params.text,
      });
    }

    // Fresh runner per run so stopBot can abort THIS run's signal only.
    // v0.12: dynamic tools — transfer_to_X (handoff), run_workflow,
    // delegate_specialized — dựng mới mỗi run từ danh sách bot hiện tại
    // (không nằm trong entry.tools vì bot có thể được tạo/xoá sau).
    // v0.96 (Đội T3): route turn trước khi dựng runner — chọn model/
    // provider cho turn này (3 tầng, pinning, fallback ladder). Fail-
    // open tuyệt đối: router lỗi/tắt thì `routed` là default của bot,
    // run chạy y như trước. Override provider (nếu có) được dispose
    // trong `finally` dưới đây, không rò process CLI.
    const routed = await this.applyRouting(entry, params, historyMessages, contextLimit);
    const runProvider = routed.provider;
    const runProviderId = routed.providerId;
    const runModel = routed.model;
    const runContextLimit =
      routed.overrideProvider !== null
        ? contextLimitForModel(runProviderId, runModel)
        : contextLimit;

    // v0.54 (P1-8): mỗi run có InterruptController riêng — UI/CLI gọi
    // RPC `interruptRun` để dừng ở biên an toàn tiếp theo; handler mặc
    // định emit event `interrupt-needed` về renderer (trả lời qua
    // `respondInterrupt`), host có thể override bằng options.
    const interruptController = new InterruptController();
    // v1.01 (Đội T1): event-sourced run log — recorder ghi `run.started`
    // ngay khi tạo; sink/gate của nó truyền vào runner để loop ghi
    // prompt/model/tool/approval/checkpoint + chờ pause ở biên step.
    // Không có dataDir → null → run chạy như cũ, không log.
    const runLogTitle =
      typeof runText === 'string' && runText.trim().length > 0
        ? runText.trim().slice(0, 200)
        : undefined;
    const runLogRecorder = this.createRunLogRecorder({
      runId,
      botId,
      model: runModel,
      providerId: runProviderId,
      maxSteps: entry.maxSteps,
      ...(runLogTitle !== undefined ? { title: runLogTitle } : {}),
    });
    const runLogWiring = runLogRecorder?.asLoopSink();
    const runner = new AgentRunner(runProvider, [
      ...entry.tools,
      ...this.transferToolsFor(botId),
      ...this.sessionHandoffToolsFor(botId),
      this.runWorkflowTool(entry),
      this.delegateSpecializedTool(),
    ], {
      // v0.19 (W12e): run plan-approved chạy như bot autoApprove
      // (loop bỏ qua cả hai nhánh hỏi duyệt) nhưng CHỈ trong run này.
      bot: {
        ...entry.bot,
        // v0.96: model/provider của turn này có thể là đích router chọn
        // (khác model mặc định của bot) — loop + trace dùng đúng model
        // đã route, entry.bot không đổi (pin chỉ sống trong router).
        providerId: runProviderId,
        model: runModel,
        systemPrompt,
        ...(planApprovedRun ? { autoApprove: true } : {}),
      },
      events,
      maxSteps: entry.maxSteps,
      signal: controller.signal,
      permissions: this.permissions,
      // v0.35 (P1-7): rule auto-approve — loop hỏi store trước khi hiện
      // thẻ duyệt; rule khớp thì chạy ngay (ghi log + span trace rõ rule
      // nào), không khớp thì hỏi tay như cũ. Store đọc trực tiếp (không
      // snapshot) nên rule thêm/tắt giữa chừng có hiệu lực ngay ở run sau
      // — run đang chạy cũng thấy rule mới ở tool call tiếp theo.
      autoApproveCheck: (input) => this.getAutoApproveStore().findMatch(input),
      // v0.53 (P1-7): record every tool call of this run into the
      // workspace history file, so `tool_call_replay` can replay them.
      toolCallRecorder: this.getToolCallRecorder(entry.bot.workspaceDir),
      // v0.90a (Đội G): mọi turn/tool-call của loop vào harness event
      // log (bus + NDJSON theo thread = botId, engine = provider id).
      // Không có harness thì undefined = loop chạy như cũ, không sink.
      // v0.90e (Đội G): run im lặng (silent) vẫn ghi log nhưng mang cờ
      // silent — forwarder/SSE bỏ qua, giữ hợp đồng "silent run không
      // đẩy event nào về parent" (v0.4).
      harnessSink: this.harness
        ? (kind, payload) =>
            this.harness?.publishLoopEvent(botId, botId, entry.providerConfig.id, kind, payload, {
              silent,
            })
        : undefined,
      // v1.01 (Đội T1): event-sourced run log — sink ghi event của
      // loop + gate pause ở biên step. Không có recorder (không có
      // dataDir) thì undefined = loop chạy như cũ.
      ...(runLogWiring !== undefined
        ? { runLogSink: runLogWiring.sink, runLogGate: runLogWiring.gate }
        : {}),
      // v0.97 (Team T3): AG-UI emitter for this run — null for provider
      // 'mock' / CLI-kind (harness already streams those runs) and
      // inactive-but-present for silent runs (emitter methods no-op).
      // No network/Ollama probe here: construction is pure.
      agUiEmitter:
        this.createAgUiEmitter({
          runId,
          botId,
          providerId: runProviderId,
          model: runModel,
          ...(silent ? { silent: true } : {}),
        }) ?? undefined,
      hooks: hookRunner,
      guardrails,
      tracer,
      // v0.33 (P0-1 fork-execution): fork skills chạy trong subagent
      // riêng ở đầu run (loop.ts); inline skills (không fork) mới vào
      // tool filter của cha.
      forkSkills: forkSkills.length > 0 ? forkSkills : undefined,
      toolFilter: { mode, activeSkills: inlineSkills },
      // v0.51 (M7 cap wiring): cap tool theo app từ kho dùng chung —
      // đọc snapshot mỗi run nên setToolCap giữa chừng có hiệu lực ngay
      // ở run sau (như autoApproveCheck đọc store trực tiếp). Loop áp
      // cap TRƯỚC filterTools rồi báo tool bị cắt qua log + progress.
      appToolCaps: { capsByApp: this.appAuthStore.getToolCaps() },
      // v1.01 (Đội T3, risk budget): policy duyệt theo risk (từ bot,
      // mặc định confirm-risky) + analyzer + queue ghi sổ + meter
      // token/cost riêng cho run này (cap từ bot, reset mỗi run).
      confirmationPolicy: entry.bot.confirmationPolicy,
      // v1.01 (Đội T3): analyzer dựng mới mỗi run từ store — rule user
      // sửa giữa chừng có hiệu lực ngay ở run sau (như autoApproveCheck
      // đọc store trực tiếp, xem getAutoApproveStore).
      riskAnalyzer: new RiskAnalyzer(this.getRiskRuleStore().toAnalyzerOptions()),
      confirmationQueue: this.confirmationQueue,
      budgetMeter: new ConversationBudgetMeter(runId, {
        ...(entry.bot.budgetTokenLimit !== undefined
          ? { tokenLimit: entry.bot.budgetTokenLimit }
          : {}),
        ...(entry.bot.budgetCostLimitUsd !== undefined
          ? { costLimitUsd: entry.bot.budgetCostLimitUsd }
          : {}),
        model: runModel,
      }),
      memory: entry.memory,
      runId,
      initialMessages,
      startStep,
      // v0.60: history thread đã seed ở trên (undefined = không có
      // thread / resume — loop chạy như cũ).
      historyMessages,
      // v0.63 (vision channel): ảnh đính kèm của lượt này — loop
      // validate + gate theo provider/model rồi gắn vào tin user mới
      // (xem AgentRunnerOptions.attachments). Không set = chạy như cũ.
      attachments: params.attachments,
      compaction: {
        // v0.26 (W19a): context limit đo được tính một lần ở đầu
        // executeRun (xem `contextLimit` ở trên) — model Ollama local
        // đo được context thật (vd qwen2.5:0.5b → 4096 thay vì 32k
        // theo họ); provider khác / đo lỗi → undefined → heuristic cũ.
        // v0.96: turn bị route sang model khác thì dùng context của
        // model đã route (`runContextLimit`).
        contextLimit: runContextLimit,
      },
      // v0.20 (W14a): small-model guard toggle from the bot config
      // (desktop Settings); unset = guard on (W12a behaviour).
      smallModel: { enabled: entry.bot.smallModelGuard ?? true },
      structuredOutput: params.structuredOutput,
      interruptController,
      onInterrupt: (request) => this.askUserForInterrupt(request),
    });
    this.runnersById.set(runId, runner);
    let traceStatus: TraceStatus = 'ok';
    // v0.90e (Đội G): run im lặng → đánh dấu để CLI driver event (sink
    // gắn theo provider, không biết run) cũng mang cờ silent; loop
    // event đã mang cờ qua harnessSink ở trên. Clear trong `finally`
    // để event rớt lại sau run không bị gắn nhầm cờ.
    if (silent) this.harness?.setSilentRun(botId, true);
    try {
      const text = await runner.run(runText);
      // v1.01 (Đội T1): run xong → ghi `run.completed` vào run log.
      runLogRecorder?.complete(text);
      // v1.01 (Đội T3, risk budget): ghi snapshot budget cuối của run
      // vào lịch sử (best-effort — lỗi ghi file không phá turn).
      try {
        const snapshot = runner.getBudgetSnapshot();
        if (snapshot) this.getBudgetHistory().record(botId, snapshot);
      } catch {
        // Ghi lịch sử budget không được phá turn.
      }
      const result: RunResult = {
        botId,
        text,
        stopped: entry.stopRequested,
        runId,
        ...(acceptedHandoff ? { acceptedHandoff } : {}),
      };
      // v0.97 (Team T4): sleep-time consolidation hook — bump the step
      // counter and, when the threshold fires, start a BACKGROUND sleep
      // run over the recent transcript. Fire-and-forget and best-effort:
      // it runs AFTER the reply is decided, never blocks the turn, and
      // is a no-op while the sleep agent is disabled (default) or the
      // bot is mock/CLI (see scheduleSleepAfterTurn).
      try {
        this.maybeRunSleepAfterTurn(entry, botId);
      } catch {
        // Ignore: memory must never break a chat turn.
      }
      return result;
    } catch (err) {
      // v0.15: abort (stopRun/stopBot hoặc signal hủy) là kết thúc do người
      // dùng yêu cầu — trả kết quả stopped thay vì ném lỗi hệ thống. Trace
      // vẫn ghi 'ok' vì run không lỗi, chỉ dừng giữa chừng.
      if (isAbortError(err) || controller.signal.aborted) {
        // v1.01 (Đội T1): run bị dừng → ghi `run.aborted` (mở gate
        // đang pause nếu có để loop đang treo được giải phóng).
        runLogRecorder?.abort('Đã dừng run theo yêu cầu.');
        return {
          botId,
          text: 'Đã dừng run theo yêu cầu.',
          stopped: true,
          runId,
          ...(acceptedHandoff ? { acceptedHandoff } : {}),
        };
      }
      traceStatus = 'error';
      // v1.01 (Đội T1): run lỗi → ghi `run.failed` vào run log.
      runLogRecorder?.fail(err instanceof Error ? err.message : String(err));
      // v0.98: the run failed — the bound plan step fails with it
      // (settled in `finally` below).
      planRunError = err instanceof Error ? err.message : String(err);
      // v0.33 (P0-6): ghi lỗi của run thành span `error` để trace cho
      // thấy run chết ở đâu (trước đây chỉ có traceStatus 'error' mà
      // không có span nào ghi lý do). Abort đã return ở trên nên tới
      // đây là lỗi thật. Ghi trace không được làm hỏng run (best-effort).
      try {
        tracer?.completeSpan('error', 'run', { error: err });
      } catch {
        // Ignore: a failed trace write is not a run failure.
      }
      throw err;
    } finally {
      // v0.98 (Team T4 — planning v2): settle the bound plan step
      // from the run's outcome — success → done, error → failed,
      // stop → released back to pending. Runs on every exit path
      // (the early stop return above never bound a plan, so this is
      // a no-op there). Silent-run suppression still applies: the
      // runId leaves silentPlanRuns only after endRun emitted.
      try {
        this.runPlanBinding.endRun(runId, {
          stopped: entry.stopRequested,
          error: planRunError,
        });
      } catch {
        // Plan bookkeeping must never break run teardown.
      }
      this.silentPlanRuns.delete(runId);
      // v0.10: persist the trace — tracing must never break a run.
      if (tracer && traceStore) {
        try {
          tracer.save(traceStore, traceStatus);
        } catch {
          // Ignore: a failed trace write is not a run failure.
        }
      }
      // v0.12: prune checkpoint của run này (giữ 10 mới nhất) để DB không phình.
      try {
        pruneCheckpoints(entry.memory, runId);
      } catch {
        // Ignore: prune không được làm hỏng run.
      }
      this.runsById.delete(runId);
      this.runnersById.delete(runId);
      // v1.01 (Đội T1): dọn recorder khỏi map run đang chạy (log trên
      // đĩa vẫn giữ nguyên — map chỉ là tra cứu lúc chạy).
      this.runLogRecorders.delete(runId);
      entry.running = false;
      entry.controller = undefined;
      // v0.96: dispose provider override của router (nếu có) — provider
      // mặc định của bot KHÔNG dispose ở đây (vẫn thuộc về entry).
      if (routed.overrideProvider) disposeProvider(routed.overrideProvider);
      // v0.90e (Đội G): dọn cờ run im lặng (xem set ở trước `runner.run()`).
      if (silent) this.harness?.setSilentRun(botId, false);
    }
  }

  stopBot(params: { botId: string }): StopBotResult {
    if (!params || typeof params.botId !== 'string') {
      throw new Error('stopBot cần params {botId}.');
    }
    const entry = this.getBot(params.botId);
    // v0.8: stop cancels the bot's QUEUED runs too, not just the one
    // executing — a queued run never starts after a stop.
    const cancelledQueued = this.cancelQueuedRuns(params.botId);
    if (entry.running && entry.controller) {
      entry.stopRequested = true;
      // v1.01 (Đội T1): abort recorder của bot trước — mở gate pause
      // (nếu run đang treo ở biên step) để loop thoát thay vì kẹt mãi.
      for (const recorder of this.runLogRecorders.values()) {
        if (recorder.botId === params.botId) recorder.abort('Đã dừng run theo yêu cầu.');
      }
      entry.controller.abort();
      // v0.15: abort tới được provider.chat() đang bay (loop truyền signal
      // của run xuống provider; OpenAI-compatible hủy fetch giữa chừng,
      // provider khác dừng ở step tiếp theo). Run trả kết quả
      // stopped:true thay vì lỗi hệ thống.
      return { botId: params.botId, stopped: true };
    }
    if (cancelledQueued > 0) {
      return { botId: params.botId, stopped: true };
    }
    // v0.60 (P0 Stop race): nothing running or queued — the stop may
    // have overtaken the run RPC (the UI shows Stop before `chat:send`
    // dispatches `run`), so record it: the run starting right after
    // this aborts immediately in `executeRun` instead of running to
    // completion, and its own result carries stopped:true. The return
    // contract is unchanged (nothing was running to stop).
    entry.pendingStopAt = Date.now();
    return { botId: params.botId, stopped: false, reason: 'bot không có run đang chạy' };
  }

  /**
   * v0.9a: stop ONE run by its id (RPC `stopRun`, WS `{type:"stop"}`).
   * Unlike `stopBot`, this does not touch the bot's other runs — two
   * bots running in parallel are stopped independently, and a run
   * still waiting in the queue is cancelled before it starts (its
   * `run()` promise rejects). A run that already finished, or an
   * unknown id, resolves `{ stopped: false, reason }` instead of
   * throwing — "already gone" is not an error for a stop request.
   * v0.74a: an unknown id is NOT simply forgotten — the stop is
   * recorded in `pendingStopByRunId` (same 30s window as
   * `pendingStopAt`): a run carrying this id that starts within the
   * window aborts immediately and reports stopped:true. This covers
   * the race where the stop (e.g. via WS) overtakes the run RPC
   * (e.g. via IPC) on another channel — `run()` stamps the caller's
   * runId, so the run is addressable before it exists in `runsById`
   * / `runQueue`. The return contract is unchanged (stopped:false —
   * nothing was running to stop), but the reason now says the stop
   * was recorded.
   * Same honesty note as stopBot: abort reaches tools via ctx.signal,
   * but an in-flight provider.chat() is not cancelled by the runner
   * (that is v0.15); the run's result still arrives with
   * `stopped: true`.
   */
  stopRun(params: { runId: string }): { runId: string; stopped: boolean; reason?: string } {
    if (!params || typeof params.runId !== 'string' || params.runId === '') {
      throw new Error('stopRun cần params {runId}.');
    }
    const runId = params.runId;
    const active = this.runsById.get(runId);
    if (active) {
      const entry = this.bots.get(active.botId);
      if (entry) entry.stopRequested = true;
      // v1.01 (Đội T1): abort recorder trước — mở gate pause (nếu run
      // đang treo ở biên step) để loop thoát thay vì kẹt mãi.
      this.runLogRecorders.get(runId)?.abort('Đã dừng run theo yêu cầu.');
      active.controller.abort();
      return { runId, stopped: true };
    }
    const queuedIdx = this.runQueue.findIndex(
      (q) => (q.params as RunParamsWithId).runId === runId,
    );
    if (queuedIdx !== -1) {
      const [queued] = this.runQueue.splice(queuedIdx, 1);
      queued.reject(new Error(`Run "${runId}" bị huỷ khi đang xếp hàng.`));
      return { runId, stopped: true };
    }
    // v0.74a: chưa có run nào mang id này (chưa chạy, chưa xếp hàng)
    // — stop có thể tới trước cả `run()` (kênh khác nhau). Ghi lại
    // để run mang id này bắt đầu trong cửa sổ 30s sẽ dừng ngay
    // (xem `executeRun`); quá hạn thì entry bị dọn lúc ghi mới và
    // không bao giờ giết run khác (id là UUID do caller cấp).
    const now = Date.now();
    for (const [id, at] of this.pendingStopByRunId) {
      if (now - at > this.pendingStopWindowMs) this.pendingStopByRunId.delete(id);
    }
    this.pendingStopByRunId.set(runId, now);
    while (this.pendingStopByRunId.size > MAX_PENDING_STOP_BY_RUN_ID) {
      const oldest = this.pendingStopByRunId.keys().next().value;
      if (oldest === undefined) break;
      this.pendingStopByRunId.delete(oldest);
    }
    return {
      runId,
      stopped: false,
      reason: 'không tìm thấy run đang chạy hoặc đang xếp hàng — stop đã ghi lại, run mang id này sẽ dừng ngay khi bắt đầu (trong 30s)',
    };
  }

  respondApproval(params: RespondApprovalParams): RespondApprovalResult {
    if (!params || typeof params.callId !== 'string') {
      throw new Error('respondApproval cần params {callId, approved}.');
    }
    const resolve = this.pendingApprovals.get(params.callId);
    if (!resolve) return { found: false };
    this.pendingApprovals.delete(params.callId);
    // v0.12 (interrupt_before): người duyệt có thể sửa args — loop sẽ
    // re-check denylist với args mới trước khi chạy.
    const args =
      params.args && typeof params.args === 'object' && !Array.isArray(params.args)
        ? params.args
        : undefined;
    // v1.01 (Đội T3, risk budget): ghi quyết định vào queue audit log
    // (loop cũng resolve ở askApproval — resolve trùng trả undefined,
    // audit chỉ ghi một lần nên không đúp).
    this.confirmationQueue.resolve(
      params.callId,
      params.approved
        ? args !== undefined
          ? { decision: 'edit', args }
          : { decision: 'approve' }
        : { decision: 'deny' },
    );
    resolve(params.approved ? { approved: true, args } : { approved: false });
    return { found: true };
  }

  /**
   * v1.01 (Đội T3, risk budget): yêu cầu duyệt đang chờ (để UI/CLI
   * tra cứu) + audit log quyết định duyệt của coordinator này.
   */
  listPendingConfirmations(): Array<{
    id: string;
    botId: string;
    toolName: string;
    riskLevel: string;
    createdAtMs: number;
  }> {
    return this.confirmationQueue.listPending().map((e) => ({
      id: e.id,
      botId: e.botId,
      toolName: e.toolName,
      riskLevel: e.risk.level,
      createdAtMs: e.createdAtMs,
    }));
  }

  /** v1.01 (Đội T3): audit log quyết định duyệt (mới nhất cuối). */
  getConfirmationAudit(): Array<{
    confirmationId: string;
    callId: string;
    botId: string;
    toolName: string;
    riskLevel: string;
    riskScore: number;
    status: string;
    decidedBy: string;
    atMs: number;
  }> {
    return this.confirmationQueue.auditLog();
  }

  // -------------------------------------------------------------------------
  // v1.01 (Đội T3, risk budget): quản lý rule risk + lịch sử budget.
  // Store bắt đầu rỗng (chỉ có rule built-in); rule custom / allow /
  // deny chỉ có hiệu lực khi người dùng tạo tường minh. KHÔNG có tool
  // agent nào gọi được các method này — agent tự nới rule cho mình là
  // leo thang đặc quyền (như RPC auto-approve, xem getAutoApproveStore).
  // -------------------------------------------------------------------------

  /** Store rule risk dùng chung của coordinator (lazy, file dưới dataDir). */
  getRiskRuleStore(): RiskRuleStore {
    if (!this.riskRuleStoreInstance) {
      this.riskRuleStoreInstance = new RiskRuleStore(this.dataDir);
    }
    return this.riskRuleStoreInstance;
  }

  /** Lịch sử budget dùng chung của coordinator (lazy, file dưới dataDir). */
  getBudgetHistory(): ConversationBudgetHistory {
    if (!this.budgetHistoryInstance) {
      this.budgetHistoryInstance = new ConversationBudgetHistory(this.dataDir);
    }
    return this.budgetHistoryInstance;
  }

  /** Rule risk custom hiện tại (để UI/CLI liệt kê). */
  getRiskRules(): RiskRule[] {
    return this.getRiskRuleStore().listRules();
  }

  /** Thêm / ghi đè một rule risk custom (validate rồi mới lưu). */
  addRiskRule(rule: RiskRule): RiskRule {
    return this.getRiskRuleStore().addRule(rule);
  }

  /** Xoá một rule risk custom theo id. */
  removeRiskRule(id: string): boolean {
    return this.getRiskRuleStore().removeRule(id);
  }

  /** Allowlist / denylist hiện tại (để UI/CLI liệt kê). */
  getRiskLists(): { allowlist: string[]; denylist: string[] } {
    const store = this.getRiskRuleStore();
    return { allowlist: store.listAllowlist(), denylist: store.listDenylist() };
  }

  /** Lịch sử budget của một bot (mới nhất cuối; không botId = tất cả). */
  getBudgetHistoryEntries(botId?: string): Array<{
    conversationId: string;
    botId: string;
    model: string | null;
    totalTokens: number;
    costUsd: number | null;
    status: string;
    endedAtMs: number;
  }> {
    const history = this.getBudgetHistory();
    return (botId ? history.listForBot(botId) : history.listAll()).map((e) => ({
      conversationId: e.conversationId,
      botId: e.botId,
      model: e.model,
      totalTokens: e.totalTokens,
      costUsd: e.costUsd,
      status: e.status,
      endedAtMs: e.endedAtMs,
    }));
  }

  /** Cộng dồn budget theo bot (để UI hiện "bot này đã tốn bao nhiêu"). */
  getBudgetTotals(botId: string): {
    botId: string;
    conversations: number;
    totalTokens: number;
    totalCostUsd: number | null;
    hasUnknownCost: boolean;
    exceededCount: number;
    warningCount: number;
  } {
    return this.getBudgetHistory().totalsForBot(botId);
  }

  // --- RPC risk budget (handle() dispatch ở trên) ---

  /** RPC `listRiskRules`: rule custom + allow/deny + built-in đã tắt. */
  listRiskRules(): ListRiskRulesResult {
    const store = this.getRiskRuleStore();
    return {
      rules: store.listRules(),
      allowlist: store.listAllowlist(),
      denylist: store.listDenylist(),
      disabledBuiltinRuleIds: store.listDisabledBuiltinRuleIds(),
    };
  }

  /** RPC `addRiskRule`: thêm / ghi đè rule custom (validate rồi mới lưu). */
  addRiskRuleRpc(params: AddRiskRuleParams): AddRiskRuleResult {
    if (!params || !params.rule || typeof params.rule !== 'object') {
      throw new Error('addRiskRule cần params {rule}.');
    }
    return { rule: this.getRiskRuleStore().addRule(params.rule) };
  }

  /** RPC `removeRiskRule`: xoá rule custom theo id. */
  removeRiskRuleRpc(params: RemoveRiskRuleParams): RemoveRiskRuleResult {
    if (!params || typeof params.id !== 'string' || params.id.trim() === '') {
      throw new Error('removeRiskRule cần params {id}.');
    }
    return { removed: this.getRiskRuleStore().removeRule(params.id) };
  }

  /** RPC `setRiskListEntry`: thêm/xoá entry allowlist/denylist. */
  setRiskListEntry(params: SetRiskListEntryParams): SetRiskListEntryResult {
    if (!params || (params.list !== 'allow' && params.list !== 'deny')) {
      throw new Error('setRiskListEntry cần params {list: allow|deny, action, entry}.');
    }
    if (params.action !== 'add' && params.action !== 'remove') {
      throw new Error('setRiskListEntry cần params {list, action: add|remove, entry}.');
    }
    if (typeof params.entry !== 'string' || params.entry.trim() === '') {
      throw new Error('setRiskListEntry cần entry (tool hoặc tool:regex).');
    }
    const store = this.getRiskRuleStore();
    const changed =
      params.list === 'allow'
        ? params.action === 'add'
          ? store.addAllowlist(params.entry)
          : store.removeAllowlist(params.entry)
        : params.action === 'add'
          ? store.addDenylist(params.entry)
          : store.removeDenylist(params.entry);
    return { changed, list: params.list, entry: params.entry };
  }

  /**
   * RPC `listBuiltinRiskRules`: bảng rule built-in kèm cờ enabled
   * (rule bị tắt vẫn liệt kê để UI bật lại được).
   */
  listBuiltinRiskRules(): ListBuiltinRiskRulesResult {
    const disabled = new Set(this.getRiskRuleStore().listDisabledBuiltinRuleIds());
    return {
      rules: BUILTIN_RISK_RULES.map((rule) => ({ ...rule, enabled: !disabled.has(rule.id) })),
    };
  }

  /** RPC `setRiskBuiltinRuleEnabled`: tắt/bật một rule built-in theo id. */
  setRiskBuiltinRuleEnabled(
    params: SetRiskBuiltinRuleEnabledParams,
  ): SetRiskBuiltinRuleEnabledResult {
    if (!params || typeof params.id !== 'string' || params.id.trim() === '') {
      throw new Error('setRiskBuiltinRuleEnabled cần params {id, enabled}.');
    }
    if (typeof params.enabled !== 'boolean') {
      throw new Error('setRiskBuiltinRuleEnabled cần "enabled" là boolean.');
    }
    const store = this.getRiskRuleStore();
    const known = BUILTIN_RISK_RULES.some((r) => r.id === params.id);
    if (!known) throw new Error(`Không có rule built-in id "${params.id}".`);
    if (params.enabled) store.enableBuiltinRule(params.id);
    else store.disableBuiltinRule(params.id);
    return { id: params.id, enabled: params.enabled };
  }

  /** RPC `listBudgetHistory`: lịch sử budget (mới nhất cuối). */
  listBudgetHistoryRpc(params: ListBudgetHistoryParams): ListBudgetHistoryResult {
    return { entries: this.getBudgetHistoryEntries(params?.botId) };
  }

  /** RPC `getBudgetTotals`: cộng dồn budget của một bot. */
  getBudgetTotalsRpc(params: GetBudgetTotalsParams): GetBudgetTotalsResult {
    if (!params || typeof params.botId !== 'string' || params.botId.trim() === '') {
      throw new Error('getBudgetTotals cần params {botId}.');
    }
    return this.getBudgetTotals(params.botId);
  }

  /**
   * RPC `getRiskReport`: báo cáo Markdown cho một bot (conversation
   * mới nhất của bot, hoặc conversationId chỉ định): quyết định duyệt
   * + budget cuối. Audit lấy từ queue của coordinator; budget lấy từ
   * lịch sử (entry → snapshot tối thiểu để render).
   */
  getRiskReport(params: GetRiskReportParams): GetRiskReportResult {
    if (!params || typeof params.botId !== 'string' || params.botId.trim() === '') {
      throw new Error('getRiskReport cần params {botId}.');
    }
    const history = this.getBudgetHistory();
    const entry =
      params.conversationId !== undefined
        ? history.get(params.conversationId)
        : [...history.listForBot(params.botId)].pop();
    const audit = this.confirmationQueue.auditLogForBot(params.botId);
    const budget: BudgetSnapshot | null = entry
      ? {
          conversationId: entry.conversationId,
          model: entry.model,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          totalTokens: entry.totalTokens,
          costUsd: entry.costUsd,
          hasUnknownCost: entry.hasUnknownCost,
          tokenLimit: null,
          costLimitUsd: null,
          tokenPercentUsed: null,
          costPercentUsed: null,
          percentUsed: null,
          status: entry.status,
          modelCount: entry.model ? 1 : 0,
          byModel: {},
          lastRecordedAtMs: entry.endedAtMs,
        }
      : null;
    const reportInput = {
      botId: params.botId,
      conversationId: entry?.conversationId ?? params.conversationId ?? '',
      audit,
      budget,
    };
    return {
      botId: params.botId,
      conversationId: entry?.conversationId ?? null,
      markdown: buildRiskReportMarkdown(reportInput),
      summary: summarizeRiskReport(reportInput),
    };
  }

  respondAskUser(params: RespondAskUserParams): RespondAskUserResult {
    if (!params || typeof params.requestId !== 'string') {
      throw new Error('respondAskUser cần params {requestId, answer}.');
    }
    const resolve = this.pendingAskUser.get(params.requestId);
    if (!resolve) return { found: false };
    this.pendingAskUser.delete(params.requestId);
    resolve(typeof params.answer === 'string' ? params.answer : '');
    return { found: true };
  }

  // -------------------------------------------------------------------------
  // v0.54 (P1-8): checkpoint/resume + interrupt HITL cho run dài.
  // -------------------------------------------------------------------------

  /**
   * Hỏi user khi run dừng ở điểm interrupt: host có handler riêng thì
   * dùng nó; không thì emit event `interrupt-needed` về parent (desktop
   * renderer hiện InterruptCard, trả lời qua RPC `respondInterrupt`).
   * Đăng ký pending TRƯỚC khi emit (cùng race như onApprovalNeeded —
   * handler emit có thể trả lời đồng bộ). Hết 10 phút không trả lời thì
   * mặc định `cancel` (dừng an toàn, checkpoint đã lưu).
   */
  private async askUserForInterrupt(request: InterruptRequest): Promise<InterruptDecision> {
    if (this.interruptHandler) return this.interruptHandler(request);
    const requestId = randomUUID();
    const decisionPromise = new Promise<InterruptDecision>((resolve) => {
      this.pendingInterrupts.set(requestId, resolve);
      setTimeout(() => {
        if (this.pendingInterrupts.has(requestId)) {
          this.pendingInterrupts.delete(requestId);
          resolve({ action: 'cancel' });
        }
      }, RESPONSE_TIMEOUT_MS).unref();
    });
    this.emitEvent(request.botId, 'interrupt-needed', { requestId, ...request });
    return decisionPromise;
  }

  /**
   * RPC `interruptRun`: yêu cầu run đang chạy dừng ở biên an toàn tiếp
   * theo để hỏi user. Không abort như `stopRun` — run dừng có checkpoint
   * và tiếp tục được. Run chưa bắt đầu chạy (đang chờ trong queue) thì
   * không nhận (trả accepted:false; dùng stopRun để hủy run đang chờ).
   */
  interruptRun(params: InterruptRunParams): InterruptRunResult {
    if (!params || typeof params.runId !== 'string' || params.runId.trim() === '') {
      throw new Error('interruptRun cần params {runId}.');
    }
    const runner = this.runnersById.get(params.runId);
    if (!runner) {
      return { runId: params.runId, accepted: false, reason: 'Không có run nào đang chạy với runId này.' };
    }
    runner.interrupt(params.reason ?? 'user-requested', params.question);
    return { runId: params.runId, accepted: true };
  }

  /** RPC `respondInterrupt`: trả lời một yêu cầu interrupt đang chờ. */
  respondInterrupt(params: RespondInterruptParams): RespondInterruptResult {
    if (!params || typeof params.requestId !== 'string') {
      throw new Error('respondInterrupt cần params {requestId, decision}.');
    }
    const resolve = this.pendingInterrupts.get(params.requestId);
    if (!resolve) return { found: false };
    this.pendingInterrupts.delete(params.requestId);
    const decision = params.decision;
    const valid =
      decision &&
      (decision.action === 'continue' ||
        decision.action === 'cancel' ||
        decision.action === 'deny-tool' ||
        (decision.action === 'continue-with-message' && typeof decision.message === 'string'));
    resolve(valid ? decision : { action: 'cancel' });
    return { found: true };
  }

  /** RPC `listRunCheckpoints`: tóm tắt checkpoint của một run (cho UI resume/time-travel). */
  listRunCheckpoints(params: ListRunCheckpointsParams): ListRunCheckpointsResult {
    if (!params || typeof params.runId !== 'string' || params.runId.trim() === '') {
      throw new Error('listRunCheckpoints cần params {runId}.');
    }
    // Checkpoint sống trong BotMemory của bot — tìm run này thuộc bot nào
    // bằng cách quét các entry (số bot nhỏ; không có index runId→bot).
    for (const entry of this.bots.values()) {
      const rows = entry.memory.listCheckpointRows(params.runId);
      if (rows.length > 0) {
        return { runId: params.runId, checkpoints: listCheckpointSummaries(entry.memory, params.runId) };
      }
    }
    return { runId: params.runId, checkpoints: [] };
  }

  /** RPC `listBotCheckpoints`: tóm tắt checkpoint của mọi run của một bot. */
  listBotCheckpoints(params: ListBotCheckpointsParams): ListBotCheckpointsResult {
    if (!params || typeof params.botId !== 'string' || params.botId.trim() === '') {
      throw new Error('listBotCheckpoints cần params {botId}.');
    }
    const entry = this.getBot(params.botId);
    const runs: Array<{ runId: string; checkpoints: CheckpointSummary[] }> = [];
    for (const runId of entry.memory.listCheckpointRunIds(params.botId)) {
      runs.push({ runId, checkpoints: listCheckpointSummaries(entry.memory, runId) });
    }
    return { botId: params.botId, runs };
  }

  /**
   * RPC `replayRun`: time-travel replay — chạy lại một run từ checkpoint
   * cũ (step tường minh, mặc định 'latest'). Validate checkpoint tồn
   * tại trước rồi mới chạy (lỗi rõ ngay thay vì chạy run mới rỗng).
   * `text` được bỏ qua như resume thường (messages đã có yêu cầu gốc).
   */
  async replayRun(params: ReplayRunParams): Promise<ReplayRunResult> {
    if (!params || typeof params.botId !== 'string' || params.botId.trim() === '') {
      throw new Error('replayRun cần params {botId, runId}.');
    }
    if (typeof params.runId !== 'string' || params.runId.trim() === '') {
      throw new Error('replayRun cần params {botId, runId}.');
    }
    const entry = this.getBot(params.botId);
    const state = replayFromCheckpoint(entry.memory, params.runId, params.stepIndex ?? 'latest');
    const result = await this.run({
      botId: params.botId,
      text: '',
      resumeRunId: params.runId,
      resumeStep: state.nextStepIndex - 1,
    });
    return { ...result, replayedFromStep: state.nextStepIndex - 1 };
  }

  // -------------------------------------------------------------------------
  // v0.35 (P1-7): quản lý rule auto-approve (RPC — Settings UI qua IPC).
  // Store bắt đầu rỗng (mặc định tắt hết, fail-closed); rule chỉ có hiệu
  // lực khi người dùng tạo tường minh. KHÔNG có tool agent nào gọi được
  // các RPC này — agent tự thêm rule cho mình là leo thang đặc quyền.
  // -------------------------------------------------------------------------

  /** Store rule dùng chung của coordinator (lazy, xem field cùng tên). */
  private getAutoApproveStore(): AutoApproveRuleStore {
    if (!this.autoApproveStoreInstance) {
      const filePath = this.dataDir
        ? path.join(this.dataDir, AUTO_APPROVE_RULES_FILE_NAME)
        : undefined;
      this.autoApproveStoreInstance = new AutoApproveRuleStore(filePath);
    }
    return this.autoApproveStoreInstance;
  }

  /**
   * v0.53 (P1-7): tool-call history recorder for one workspace —
   * the file-backed store the loop writes and `tool_call_replay`
   * reads. Memoized per workspaceDir (the store itself is stateless:
   * it reads the file on every call, so sharing one instance across
   * runs is safe). Lazily requires @open-bot/tools like
   * defaultToolFactory; when the class is absent (or the require
   * fails) returns undefined and the runner simply records nothing.
   */
  private toolCallHistoryByWorkspace = new Map<string, ToolCallHistoryLike>();
  private getToolCallRecorder(workspaceDir: string): ToolCallHistoryLike | undefined {
    const cached = this.toolCallHistoryByWorkspace.get(workspaceDir);
    if (cached) return cached;
    try {
      // Dynamic require on purpose (same as defaultToolFactory).
      const toolsMod = require('@open-bot/tools') as {
        ToolCallHistoryStore?: new (dir: string) => ToolCallHistoryLike;
      };
      if (typeof toolsMod.ToolCallHistoryStore !== 'function') return undefined;
      const store = new toolsMod.ToolCallHistoryStore(workspaceDir);
      this.toolCallHistoryByWorkspace.set(workspaceDir, store);
      return store;
    } catch {
      return undefined;
    }
  }

  /**
   * v0.95d4: embedder Ollama local dùng chung cho turn-context recall
   * (lazy, một instance). Không throw — caller tự xử lý khi Ollama
   * chưa chạy (recall fallback về từ khoá, xem turnContext).
   */
  private getMemoryEmbedder(): OllamaEmbeddings {
    if (!this.memoryEmbedderInstance) {
      this.memoryEmbedderInstance = new OllamaEmbeddings();
    }
    return this.memoryEmbedderInstance;
  }

  listAutoApproveRules(): ListAutoApproveRulesResult {
    return { rules: this.getAutoApproveStore().list() };
  }

  addAutoApproveRule(params: AddAutoApproveRuleParams): AddAutoApproveRuleResult {
    // Store.add validate + throw với lý do rõ (pattern nguy hiểm, thiếu
    // field…) — RPC trả lỗi đó về cho UI, không ghi rule nửa vời.
    return { rule: this.getAutoApproveStore().add(params) };
  }

  removeAutoApproveRule(params: RemoveAutoApproveRuleParams): RemoveAutoApproveRuleResult {
    if (!params || typeof params.id !== 'string' || params.id.trim() === '') {
      throw new Error('removeAutoApproveRule cần params {id}.');
    }
    return { removed: this.getAutoApproveStore().remove(params.id) };
  }

  setAutoApproveRuleEnabled(
    params: SetAutoApproveRuleEnabledParams,
  ): SetAutoApproveRuleEnabledResult {
    if (!params || typeof params.id !== 'string' || params.id.trim() === '') {
      throw new Error('setAutoApproveRuleEnabled cần params {id, enabled}.');
    }
    if (typeof params.enabled !== 'boolean') {
      throw new Error('setAutoApproveRuleEnabled cần "enabled" là boolean.');
    }
    const rule = this.getAutoApproveStore().setEnabled(params.id, params.enabled);
    if (!rule) throw new Error(`Không có rule auto-approve với id "${params.id}".`);
    return { rule };
  }

  // -------------------------------------------------------------------------
  // v0.50 (M8): group chat bot-bot (RPC — GroupView qua IPC `group:*`).
  // Store bền vững trong `<dataDir>/group-chats.json`; không có dataDir
  // thì chỉ giữ trong bộ nhớ tiến trình coordinator (mất khi restart).
  // Delegation tái dùng `run()` đã có (silent run) — không viết
  // delegation mới; một hop duy nhất (câu trả lời không parse mention
  // tiếp) nên bot không gọi nhau vòng lặp.
  // -------------------------------------------------------------------------

  /** Tracker trạng thái bot trong group (lazy, xem field cùng tên). */
  private getGroupBotStatusTracker(): GroupBotStatusTracker {
    if (!this.groupBotStatusTrackerInstance) {
      const filePath = this.dataDir ? path.join(this.dataDir, GROUP_BOT_STATUS_FILE_NAME) : undefined;
      this.groupBotStatusTrackerInstance = new GroupBotStatusTracker({ filePath });
    }
    return this.groupBotStatusTrackerInstance;
  }

  /** Store group chat dùng chung của coordinator (lazy, xem field cùng tên). */
  private getGroupChatStore(): GroupChatStore {
    if (!this.groupChatStoreInstance) {
      const filePath = this.dataDir ? path.join(this.dataDir, GROUP_CHATS_FILE_NAME) : undefined;
      this.groupChatStoreInstance = new GroupChatStore(filePath);
    }
    return this.groupChatStoreInstance;
  }

  /** Store channel dùng chung của coordinator (lazy, xem field cùng tên). */
  private getChannelStore(): ChannelStore {
    if (!this.channelStoreInstance) {
      this.channelStoreInstance = new ChannelStore(this.dataDir);
    }
    return this.channelStoreInstance;
  }

  /**
   * Channels (v0.96 Team T4) — CRUD + roster + post message qua
   * responder rules (xem channels/channels.ts + coordinatorAdapter.ts).
   * `postChannelMessage` chạy từng bot responder bằng `run()` silent
   * (shared instructions gộp vào đầu prompt, working folder làm `cwd`
   * của run); bot lỗi thì adapter đã ghi tin `[lỗi]` vào transcript.
   */
  createChannel(params: CreateChannelParams): CreateChannelResult {
    if (!params || typeof params.name !== 'string' || params.name.trim() === '') {
      throw new Error('createChannel cần params {name} không rỗng.');
    }
    const botIds = Array.isArray(params.botIds) ? params.botIds : [];
    for (const botId of botIds) {
      if (!this.bots.has(botId)) throw new Error(`Không rõ bot "${botId}" — tạo bot trước khi thêm vào channel.`);
    }
    return {
      channel: this.getChannelStore().createChannel({
        name: params.name,
        ...(params.kind !== undefined ? { kind: params.kind } : {}),
        ...(params.sharedInstructions !== undefined ? { sharedInstructions: params.sharedInstructions } : {}),
        ...(params.workingFolder !== undefined ? { workingFolder: params.workingFolder } : {}),
        botIds,
        ...(params.responderRules !== undefined ? { responderRules: params.responderRules } : {}),
      }),
    };
  }

  listChannels(): ListChannelsResult {
    return { channels: this.getChannelStore().listChannels() };
  }

  updateChannel(params: UpdateChannelParams): UpdateChannelResult {
    if (!params || typeof params.channelId !== 'string' || params.channelId.trim() === '') {
      throw new Error('updateChannel cần params {channelId}.');
    }
    const updated = this.getChannelStore().updateChannel(params.channelId, {
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.kind !== undefined ? { kind: params.kind } : {}),
      ...(params.sharedInstructions !== undefined ? { sharedInstructions: params.sharedInstructions } : {}),
      ...(params.workingFolder !== undefined ? { workingFolder: params.workingFolder } : {}),
      ...(params.responderRules !== undefined ? { responderRules: params.responderRules } : {}),
    });
    if (!updated) throw new Error(`Không thấy channel: "${params.channelId}".`);
    return { channel: updated };
  }

  deleteChannel(params: DeleteChannelParams): DeleteChannelResult {
    if (!params || typeof params.channelId !== 'string') {
      throw new Error('deleteChannel cần params {channelId}.');
    }
    return { deleted: this.getChannelStore().deleteChannel(params.channelId) };
  }

  addBotToChannel(params: AddBotToChannelParams): AddBotToChannelResult {
    if (!params || typeof params.channelId !== 'string' || typeof params.botId !== 'string') {
      throw new Error('addBotToChannel cần params {channelId, botId}.');
    }
    if (!this.bots.has(params.botId)) throw new Error(`Không rõ bot "${params.botId}".`);
    const channel = this.getChannelStore().addBotToChannel(params.channelId, params.botId);
    if (!channel) throw new Error(`Không thấy channel: "${params.channelId}".`);
    return { added: channel.botIds.includes(params.botId) };
  }

  removeBotFromChannel(params: RemoveBotFromChannelParams): RemoveBotFromChannelResult {
    if (!params || typeof params.channelId !== 'string' || typeof params.botId !== 'string') {
      throw new Error('removeBotFromChannel cần params {channelId, botId}.');
    }
    const channel = this.getChannelStore().removeBotFromChannel(params.channelId, params.botId);
    if (!channel) throw new Error(`Không thấy channel: "${params.channelId}".`);
    return { removed: !channel.botIds.includes(params.botId) };
  }

  moveBotBetweenChannels(params: MoveBotBetweenChannelsParams): MoveBotBetweenChannelsResult {
    if (!params || typeof params.fromChannelId !== 'string' || typeof params.toChannelId !== 'string' || typeof params.botId !== 'string') {
      throw new Error('moveBotBetweenChannels cần params {fromChannelId, toChannelId, botId}.');
    }
    if (!this.bots.has(params.botId)) throw new Error(`Không rõ bot "${params.botId}".`);
    return {
      moved: this.getChannelStore().moveBotBetweenChannels(params.fromChannelId, params.toChannelId, params.botId),
    };
  }

  async postChannelMessage(params: PostChannelMessageParams): Promise<PostChannelMessageResult> {
    if (!params || typeof params.channelId !== 'string' || params.channelId.trim() === '') {
      throw new Error('postChannelMessage cần params {channelId, text}.');
    }
    const text = typeof params.text === 'string' ? params.text.trim() : '';
    if (!text) throw new Error('postChannelMessage cần params {text} không rỗng.');
    const store = this.getChannelStore();
    const channel = store.getChannel(params.channelId);
    if (!channel) throw new Error(`Không thấy channel: "${params.channelId}".`);
    const bots = channel.botIds
      .map((id) => this.bots.get(id))
      .filter((e): e is NonNullable<typeof e> => e !== undefined)
      .map((e) => ({ id: e.bot.id, name: e.bot.name }));
    const result = await routeChannelMessage(
      store,
      params.channelId,
      { text, bots },
      async ({ botId, prompt, channelSystemPrompt, channel: ch }) => {
        // Shared instructions gộp vào đầu prompt (run() không có field
        // system-prompt riêng); working folder làm cwd của run.
        const fullPrompt = channelSystemPrompt ? `${channelSystemPrompt}\n\n${prompt}` : prompt;
        const out = await this.run({
          botId,
          text: fullPrompt,
          silent: true,
          ...(ch.workingFolder.trim() !== '' ? { cwd: ch.workingFolder.trim() } : {}),
        });
        return out.text;
      },
    );
    // Tin nhắn mới = từ tin user trở đi trong transcript (đã gồm cả tin
    // `[lỗi]` của bot chạy hỏng — adapter ghi vào transcript).
    const all = store.listChannelMessages(params.channelId, 1000);
    const userIdx = result.userMessageId ? all.findIndex((m) => m.id === result.userMessageId) : -1;
    const message: ChannelMessage = userIdx !== -1
      ? all[userIdx]
      : { id: result.userMessageId ?? '', channelId: params.channelId, botId: '', botName: 'Bạn', text, mentions: [], delegated: false, createdAt: new Date().toISOString() };
    const replies = userIdx !== -1 ? all.slice(userIdx + 1) : [];
    return { message, responders: result.responders, replies, errors: result.errors };
  }

  listChannelMessages(params: ListChannelMessagesParams): ListChannelMessagesResult {
    if (!params || typeof params.channelId !== 'string') {
      throw new Error('listChannelMessages cần params {channelId}.');
    }
    return {
      messages: this.getChannelStore().listChannelMessages(params.channelId, params.limit ?? 100),
    };
  }

  createGroupChat(params: CreateGroupChatParams): CreateGroupChatResult {
    if (!params || typeof params.name !== 'string' || params.name.trim() === '') {
      throw new Error('createGroupChat cần params {name} không rỗng.');
    }
    const botIds = Array.isArray(params.botIds) ? params.botIds : [];
    for (const botId of botIds) {
      if (!this.bots.has(botId)) throw new Error(`Không rõ bot "${botId}" — tạo bot trước khi thêm vào nhóm.`);
    }
    return { group: this.getGroupChatStore().createGroup(params.name, botIds) };
  }

  listGroupChats(): ListGroupChatsResult {
    return { groups: this.getGroupChatStore().listGroups() };
  }

  addBotToGroupChat(params: AddBotToGroupChatParams): AddBotToGroupChatResult {
    if (!params || typeof params.groupId !== 'string' || typeof params.botId !== 'string') {
      throw new Error('addBotToGroupChat cần params {groupId, botId}.');
    }
    if (!this.bots.has(params.botId)) throw new Error(`Không rõ bot "${params.botId}".`);
    if (!this.getGroupChatStore().getGroup(params.groupId)) {
      throw new Error(`Không thấy nhóm chat: "${params.groupId}".`);
    }
    return { added: this.getGroupChatStore().addBot(params.groupId, params.botId) };
  }

  removeBotFromGroupChat(params: RemoveBotFromGroupChatParams): RemoveBotFromGroupChatResult {
    if (!params || typeof params.groupId !== 'string' || typeof params.botId !== 'string') {
      throw new Error('removeBotFromGroupChat cần params {groupId, botId}.');
    }
    if (!this.getGroupChatStore().getGroup(params.groupId)) {
      throw new Error(`Không thấy nhóm chat: "${params.groupId}".`);
    }
    return { removed: this.getGroupChatStore().removeBot(params.groupId, params.botId) };
  }

  deleteGroupChat(params: DeleteGroupChatParams): DeleteGroupChatResult {
    if (!params || typeof params.groupId !== 'string') {
      throw new Error('deleteGroupChat cần params {groupId}.');
    }
    // v0.79a: nhóm bị xoá thì trạng thái chạy của nó cũng hết ý nghĩa.
    this.getGroupBotStatusTracker().clearGroup(params.groupId);
    return { deleted: this.getGroupChatStore().deleteGroup(params.groupId) };
  }

  /**
   * Gửi message vào nhóm + delegation cho bot được @mention. Message
   * gốc ghi ngay (bền vững); mỗi bot được mention chạy một silent run
   * với nội dung message (bot bận thì run xếp hàng như run thường —
   * `run()` tự queue), câu trả lời ghi thành message `delegated` của
   * bot đó. Bot được mention nhưng đã rời nhóm / không còn tồn tại thì
   * bỏ qua (ghi chú trong replies rỗng — không fail cả message).
   *
   * v0.94c: message nhận ảnh đính kèm (vision channel — validate cùng
   * giới hạn như chat thường, tối đa 5 ảnh/10 MB mỗi ảnh/20 MB tổng).
   * Ảnh lưu thành file qua store, delegation run nhận đúng bytes ảnh
   * để bot "nhìn" được. Text được rỗng khi có ảnh.
   */
  async postGroupMessage(params: PostGroupMessageParams): Promise<PostGroupMessageResult> {
    if (!params || typeof params.groupId !== 'string' || params.groupId.trim() === '') {
      throw new Error('postGroupMessage cần params {groupId, text}.');
    }
    const text = typeof params.text === 'string' ? params.text.trim() : '';
    const vision = validateVisionAttachments(params.attachments);
    if (!vision.ok) throw new Error(vision.error);
    if (!text && vision.attachments.length === 0) {
      throw new Error('postGroupMessage cần params {text} không rỗng hoặc ảnh đính kèm.');
    }
    const store = this.getGroupChatStore();
    const group = store.getGroup(params.groupId);
    if (!group) throw new Error(`Không thấy nhóm chat: "${params.groupId}".`);
    const sender = params.botId ? this.bots.get(params.botId) : undefined;
    if (params.botId && !sender) throw new Error(`Không rõ bot gửi "${params.botId}".`);
    const botsInGroup = group.botIds
      .map((id) => this.bots.get(id))
      .filter((e): e is NonNullable<typeof e> => e !== undefined)
      .map((e) => ({ id: e.bot.id, name: e.bot.name }));
    const mentions = parseGroupMentions(text, botsInGroup);
    // Lưu ảnh TRƯỚC khi post message — lỗi ghi file thì cả message
    // fail rõ ràng, không để lại message "mồ côi" thiếu ảnh.
    const storedAttachments = vision.attachments.map((att) => store.saveAttachment(att));
    let message: GroupMessage;
    try {
      message = store.postMessage({
        groupId: params.groupId,
        ...(sender ? { botId: sender.bot.id } : {}),
        botName: sender ? sender.bot.name : 'Bạn',
        text,
        mentions,
        ...(storedAttachments.length > 0 ? { attachments: storedAttachments } : {}),
      });
    } catch (err) {
      // postMessage lỗi sau khi đã lưu ảnh (vd nhóm vừa bị xoá) thì
      // xoá file ảnh vừa ghi để không để lại file mồ côi.
      for (const att of storedAttachments) store.deleteAttachmentFile(att.file);
      throw err;
    }
    const replies: GroupMessage[] = [];
    for (const mentionedId of mentions) {
      const target = this.bots.get(mentionedId);
      if (!target) continue;
      // v0.79a: đánh dấu bot đang chạy TRƯỚC run để renderer poll thấy
      // ngay (kể cả lúc run đang xếp hàng chờ bot bận); `finally` gỡ
      // dấu — run lỗi cũng không kẹt trạng thái running mãi.
      this.getGroupBotStatusTracker().markRunning(params.groupId, mentionedId);
      try {
        const result = await this.run({
          botId: mentionedId,
          text,
          silent: true,
          ...(vision.attachments.length > 0 ? { attachments: vision.attachments } : {}),
        });
        replies.push(
          store.postMessage({
            groupId: params.groupId,
            botId: target.bot.id,
            botName: target.bot.name,
            text: result.text,
            delegated: true,
          }),
        );
      } catch (err) {
        replies.push(
          store.postMessage({
            groupId: params.groupId,
            botId: target.bot.id,
            botName: target.bot.name,
            text: `Không chạy được việc được giao: ${err instanceof Error ? err.message : String(err)}`,
            delegated: true,
          }),
        );
      } finally {
        this.getGroupBotStatusTracker().markIdle(params.groupId, mentionedId);
      }
    }
    return { message, replies };
  }

  /**
   * v0.94c: đọc lại bytes của một ảnh đính kèm trong message nhóm
   * (renderer gọi để hiện thumbnail; delegation không dùng đường này
   * vì coordinator đã giữ bytes gốc lúc post). Ảnh mất/hỏng → throw rõ.
   */
  getGroupAttachment(params: GetGroupAttachmentParams): GetGroupAttachmentResult {
    if (
      !params ||
      typeof params.groupId !== 'string' ||
      typeof params.messageId !== 'string' ||
      typeof params.attachmentId !== 'string'
    ) {
      throw new Error('getGroupAttachment cần params {groupId, messageId, attachmentId}.');
    }
    const store = this.getGroupChatStore();
    if (!store.getGroup(params.groupId)) {
      throw new Error(`Không thấy nhóm chat: "${params.groupId}".`);
    }
    const message = store
      .listMessages(params.groupId, MAX_GROUP_MESSAGES)
      .find((m) => m.id === params.messageId);
    if (!message) throw new Error(`Không thấy message: "${params.messageId}".`);
    const ref = (message.attachments ?? []).find((a) => a.id === params.attachmentId);
    if (!ref) throw new Error(`Không thấy ảnh đính kèm: "${params.attachmentId}".`);
    const attachment = store.readAttachment(ref);
    if (!attachment) throw new Error('Ảnh đính kèm không còn (file đã mất hoặc hỏng).');
    return { attachment };
  }

  /**
   * v0.94c: digest của mọi project đang tới hạn trên mọi bot (desktop
   * main gọi mỗi 15 phút, gửi thông báo + lưu digest vào chat rồi gọi
   * `projectUpdatesMarkSent`). Quét memory của từng bot đã đăng ký;
   * bot chưa tạo thì không có gì để quét. Không throw khi một bot lỗi
   * — bỏ qua bot đó để các bot khác vẫn được gửi.
   */
  projectUpdatesDue(): ProjectUpdatesDueResult {
    const updates: ProjectUpdatesDueResult['updates'] = [];
    const now = new Date();
    for (const [botId, entry] of this.bots) {
      try {
        updates.push(...listDueProjectUpdates(entry.memory, botId, now));
      } catch (err) {
        console.error(
          `[coordinator] projectUpdatesDue: bỏ qua bot "${botId}" vì lỗi: ${(err as Error).message}`,
        );
      }
    }
    return { updates };
  }

  /**
   * v0.94c: ghi dấu đã gửi digest cho một project (main gọi sau khi
   * gửi thông báo + lưu digest vào chat). Bot lạ / project lạ → throw
   * rõ (main log và bỏ qua digest đó, không ghi dấu sai).
   */
  projectUpdatesMarkSent(params: ProjectUpdatesMarkSentParams): ProjectUpdatesMarkSentResult {
    if (!params || typeof params.botId !== 'string' || typeof params.projectId !== 'string') {
      throw new Error('projectUpdatesMarkSent cần params {botId, projectId}.');
    }
    const entry = this.getBot(params.botId);
    const project = entry.memory.getProject(params.projectId);
    if (!project) throw new Error(`Không thấy project: "${params.projectId}".`);
    const marked = markProjectUpdateSent(entry.memory, params.projectId);
    // Đọc lại sau khi ghi dấu để nextDueAt tính từ digest vừa gửi.
    const updated = entry.memory.getProject(params.projectId);
    return { marked, nextDueAt: updated ? nextProjectDigestAt(updated) : null };
  }

  /**
   * v0.79a: các bot đang chạy trong một nhóm (renderer poll). Nhóm
   * không có thì throw như `listGroupMessages` — caller không poll
   * nhóm đã xoá. v0.82: trả thêm `interrupted` — các bot đang chạy
   * dở thì app dừng (khôi phục từ snapshot, không phải đang chạy).
   */
  getGroupBotStatus(params: GetGroupBotStatusParams): GetGroupBotStatusResult {
    if (!params || typeof params.groupId !== 'string') {
      throw new Error('getGroupBotStatus cần params {groupId}.');
    }
    if (!this.getGroupChatStore().getGroup(params.groupId)) {
      throw new Error(`Không thấy nhóm chat: "${params.groupId}".`);
    }
    const tracker = this.getGroupBotStatusTracker();
    return {
      groupId: params.groupId,
      running: tracker.getStatus(params.groupId),
      interrupted: tracker.getInterrupted(params.groupId),
    };
  }

  /**
   * v0.82: user bấm Bỏ qua trên dòng "chạy dở thì app dừng" — xoá ghi
   * nhận gián đoạn của một bot trong nhóm. Nhóm không có thì throw
   * như `getGroupBotStatus`.
   */
  dismissGroupBotInterrupted(
    params: DismissGroupBotInterruptedParams,
  ): DismissGroupBotInterruptedResult {
    if (!params || typeof params.groupId !== 'string' || typeof params.botId !== 'string') {
      throw new Error('dismissGroupBotInterrupted cần params {groupId, botId}.');
    }
    if (!this.getGroupChatStore().getGroup(params.groupId)) {
      throw new Error(`Không thấy nhóm chat: "${params.groupId}".`);
    }
    this.getGroupBotStatusTracker().clearInterrupted(params.groupId, params.botId);
    return { groupId: params.groupId, botId: params.botId, dismissed: true };
  }

  listGroupMessages(params: ListGroupMessagesParams): ListGroupMessagesResult {
    if (!params || typeof params.groupId !== 'string') {
      throw new Error('listGroupMessages cần params {groupId}.');
    }
    if (!this.getGroupChatStore().getGroup(params.groupId)) {
      throw new Error(`Không thấy nhóm chat: "${params.groupId}".`);
    }
    return {
      messages: this.getGroupChatStore().listMessages(params.groupId, params.limit ?? 100),
    };
  }

  // -------------------------------------------------------------------------
  // v0.37 (P1-3): handoff phiên làm việc — record bền chuyển giao giữa
  // các bot/phiên (khác handoff trực tiếp transfer_to_X ở trên, chạy ngay
  // trong run). Store dùng chung của coordinator (lazy, xem field cùng
  // tên): file `<dataDir>/handoffs.json` khi có dataDir, không thì chỉ
  // sống trong bộ nhớ tiến trình (mất khi restart) — cùng mẫu store
  // auto-approve. Record không chứa secret (builder đã khử trước khi lưu).
  // -------------------------------------------------------------------------

  /** Store record handoff dùng chung của coordinator (lazy). */
  private getSessionHandoffStore(): SessionHandoffStore {
    if (!this.sessionHandoffStoreInstance) {
      const filePath = this.dataDir
        ? path.join(this.dataDir, SESSION_HANDOFFS_FILE_NAME)
        : undefined;
      this.sessionHandoffStoreInstance = new SessionHandoffStore(filePath);
    }
    return this.sessionHandoffStoreInstance;
  }

  listHandoffs(params: ListHandoffsParams = {}): ListHandoffsResult {
    return { handoffs: this.getSessionHandoffStore().listSummaries(params ?? {}) };
  }

  getHandoff(params: GetHandoffParams): GetHandoffResult {
    if (!params || typeof params.id !== 'string' || params.id.trim() === '') {
      throw new Error('getHandoff cần params {id}.');
    }
    const record = this.getSessionHandoffStore().get(params.id.trim());
    if (!record) throw new Error(`Không có handoff với id "${params.id}".`);
    return { record };
  }

  /**
   * Tạo record handoff từ phía coordinator (người dùng / automation bấm
   * tạo thay vì agent tự gọi tool `create_handoff`): nội dung lấy từ
   * params + 50 dòng gần nhất trong lịch sử bot (trừ khi
   * `includeTranscript: false`). `toBotId` phải là bot đã tạo (sai thì
   * lỗi rõ); `previousHandoffId` phải là record đã lưu (sai thì lỗi rõ).
   */
  createHandoffRecord(params: CreateHandoffRecordParams): CreateHandoffRecordResult {
    if (!params || typeof params.botId !== 'string' || params.botId.trim() === '') {
      throw new Error('createHandoffRecord cần params {botId}.');
    }
    const entry = this.getBot(params.botId);
    let toBotName: string | undefined;
    const toBotId =
      typeof params.toBotId === 'string' && params.toBotId.trim() !== ''
        ? params.toBotId.trim()
        : undefined;
    if (toBotId) {
      const target = this.getBot(toBotId);
      if (target.bot.id === params.botId) {
        throw new Error('Không handoff cho chính mình.');
      }
      toBotName = target.bot.name;
    }
    const previousHandoffId =
      typeof params.previousHandoffId === 'string' && params.previousHandoffId.trim() !== ''
        ? params.previousHandoffId.trim()
        : undefined;
    if (previousHandoffId && !this.getSessionHandoffStore().get(previousHandoffId)) {
      throw new Error(`Không có handoff trước với id "${previousHandoffId}".`);
    }
    let transcriptExcerpt: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }> = [];
    if (params.includeTranscript !== false) {
      try {
        transcriptExcerpt = entry.memory
          .getHistory(params.botId, 50)
          .map((m) => ({ role: m.role as 'system' | 'user' | 'assistant' | 'tool', content: m.content }))
          .filter((m) => m.content.trim() !== '');
      } catch {
        // Lịch sử đọc lỗi thì record vẫn tạo được (không kèm excerpt).
        transcriptExcerpt = [];
      }
    }
    const secrets = [entry.providerConfig.apiKey, this.xBearer, this.githubToken].filter(
      (s): s is string => typeof s === 'string' && s.length > 0,
    );
    const record = createSessionHandoff(
      {
        fromBotId: entry.bot.id,
        fromBotName: entry.bot.name,
        ...(toBotId ? { toBotId, toBotName } : {}),
        title: params.title,
        workStatus: params.workStatus,
        taskSummary: params.taskSummary,
        currentState: params.currentState,
        completed: params.completed,
        remaining: params.remaining,
        nextStep: params.nextStep,
        filesChanged: params.filesChanged,
        filesRelevant: params.filesRelevant,
        decisions: params.decisions,
        blockers: params.blockers,
        context: params.context,
        transcriptExcerpt,
        ...(previousHandoffId ? { previousHandoffId } : {}),
      },
      { secrets },
    );
    return { record: this.getSessionHandoffStore().save(record) };
  }

  /**
   * Nạp record cho một bot (kiểm tra + đánh dấu đã nhận) mà KHÔNG chạy
   * run — caller dùng `promptBlock` trả về để chèn vào run của mình.
   * Muốn coordinator tự nạp + chạy thì dùng `RunParams.handoffId`.
   */
  acceptHandoff(params: AcceptHandoffParams): AcceptHandoffResult {
    if (!params || typeof params.id !== 'string' || params.id.trim() === '') {
      throw new Error('acceptHandoff cần params {id, botId}.');
    }
    if (typeof params.botId !== 'string' || params.botId.trim() === '') {
      throw new Error('acceptHandoff cần params {id, botId}.');
    }
    const record = this.loadSessionHandoffForBot(params.id.trim(), params.botId);
    const entry = this.getBot(params.botId);
    const acceptedAt = new Date().toISOString();
    const updated =
      this.getSessionHandoffStore().markAccepted(record.id, {
        botId: entry.bot.id,
        botName: entry.bot.name,
        acceptedAt,
      }) ?? record;
    return {
      record: updated,
      promptBlock: formatSessionHandoffForPrompt(updated),
      confirmation: acceptedHandoffConfirmation(updated, acceptedAt),
    };
  }

  /**
   * Tải record + kiểm tra đúng bot nhận (record có `toBotId` thì chỉ bot
   * đó mới nhận được). Dùng chung cho RPC `acceptHandoff` và tham số run
   * `handoffId` — một chỗ kiểm tra duy nhất, fail-closed.
   */
  private loadSessionHandoffForBot(recordId: string, botId: string): SessionHandoffRecord {
    const entry = this.getBot(botId);
    const record = this.getSessionHandoffStore().get(recordId);
    if (!record) throw new Error(`Không có handoff với id "${recordId}".`);
    if (record.toBotId && record.toBotId !== botId) {
      throw new Error(
        `Handoff "${recordId}" dành cho bot "${record.toBotName ?? record.toBotId}", ` +
          `không phải bot "${entry.bot.name}".`,
      );
    }
    return record;
  }

  /**
   * v0.13: MCP server hỏi user qua `elicitation/create` — emit event
   * lên main (renderer hiện ElicitationModal) rồi chờ `respondElicitation`.
   * Hết 10 phút thì 'cancel' (an toàn: server tự xử lý khi không có câu
   * trả lời). `request.fields` đi thẳng sang renderer — shape khớp
   * `ElicitationFieldView` nên main không cần map lại.
   */
  private askElicitation(botId: string, request: ElicitationRequest): Promise<ElicitResult> {
    const elicitationId = randomUUID();
    this.emitEvent(botId, 'mcp.elicitation-needed', {
      elicitationId,
      serverName: request.serverName,
      message: request.message,
      mode: request.mode,
      url: request.url,
      fields: request.fields,
    });
    return new Promise<ElicitResult>((resolve) => {
      this.pendingElicitations.set(elicitationId, resolve);
      setTimeout(() => {
        if (this.pendingElicitations.has(elicitationId)) {
          this.pendingElicitations.delete(elicitationId);
          resolve({ action: 'cancel' });
        }
      }, RESPONSE_TIMEOUT_MS).unref();
    });
  }

  respondElicitation(params: RespondElicitationParams): RespondElicitationResult {
    if (!params || typeof params.elicitationId !== 'string') {
      throw new Error('respondElicitation cần params {elicitationId, action}.');
    }
    const resolve = this.pendingElicitations.get(params.elicitationId);
    if (!resolve) return { found: false };
    this.pendingElicitations.delete(params.elicitationId);
    const action = params.action;
    if (action !== 'accept' && action !== 'decline' && action !== 'cancel') {
      throw new Error(
        `respondElicitation: action phải là 'accept' | 'decline' | 'cancel', got ${JSON.stringify(action)}.`,
      );
    }
    const content =
      params.content && typeof params.content === 'object' && !Array.isArray(params.content)
        ? params.content
        : undefined;
    resolve({ action, ...(content ? { content } : {}) });
    return { found: true };
  }

  saveMessage(params: SaveMessageParams): SaveMessageResult {
    if (!params || typeof params.botId !== 'string' || typeof params.content !== 'string') {
      throw new Error('saveMessage cần params {botId, role, content}.');
    }
    const entry = this.getBot(params.botId);
    const role = params.role ?? 'user';
    const threadId =
      typeof params.threadId === 'string' && params.threadId ? params.threadId : undefined;
    // v0.65: attachments ride along to BotMemory, which validates them
    // against the vision caps and stores them as files + rows
    // (fail-closed — invalid attachments throw, nothing is saved).
    const id = entry.memory.saveMessage(
      params.botId,
      role,
      params.content,
      threadId,
      params.attachments,
    );
    return { id };
  }

  getHistory(params: GetHistoryParams): GetHistoryResult {
    if (!params || typeof params.botId !== 'string') {
      throw new Error('getHistory cần params {botId, limit?}.');
    }
    const entry = this.getBot(params.botId);
    const threadId =
      typeof params.threadId === 'string' && params.threadId ? params.threadId : undefined;
    // v0.65: includeAttachments re-reads stored images for display
    // only (default false — run-context readers stay text-only).
    const messages = entry.memory.getHistory(params.botId, params.limit ?? 50, threadId, {
      includeAttachments: params.includeAttachments === true,
    });
    return {
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
      })),
    };
  }

  /**
   * v0.59 (UI-5): threads — one bot has many conversations, each with
   * its own title + messages. `listThreads` always returns at least the
   * bot's default thread: BotMemory migrates legacy (pre-thread)
   * history into it on first call, so old history is never lost.
   */
  listThreads(params: ListThreadsParams): ListThreadsResult {
    if (!params || typeof params.botId !== 'string') {
      throw new Error('listThreads cần params {botId, locale?}.');
    }
    const entry = this.getBot(params.botId);
    return { threads: entry.memory.listThreads(params.botId, params.locale) };
  }

  createThread(params: CreateThreadParams): CreateThreadResult {
    if (!params || typeof params.botId !== 'string') {
      throw new Error('createThread cần params {botId, title?, locale?}.');
    }
    const entry = this.getBot(params.botId);
    const title = typeof params.title === 'string' ? params.title : undefined;
    return { thread: entry.memory.createThread(params.botId, title, params.locale) };
  }

  renameThread(params: RenameThreadParams): RenameThreadResult {
    if (!params || typeof params.threadId !== 'string' || typeof params.title !== 'string') {
      throw new Error('renameThread cần params {threadId, title}.');
    }
    // The thread's bot is unknown from the id alone — find its owner by
    // scanning the bots' memories (a thread id belongs to exactly one bot).
    const thread = this.findThread(params.threadId);
    if (!thread) throw new Error(`Không tìm thấy thread "${params.threadId}".`);
    return { thread: thread.memory.renameThread(params.threadId, params.title) };
  }

  deleteThread(params: DeleteThreadParams): DeleteThreadResult {
    if (!params || typeof params.threadId !== 'string') {
      throw new Error('deleteThread cần params {threadId}.');
    }
    const found = this.findThread(params.threadId);
    if (!found) return { deleted: false };
    return { deleted: found.memory.deleteThread(params.threadId) };
  }

  getThreadHistory(params: GetThreadHistoryParams): GetThreadHistoryResult {
    if (!params || typeof params.threadId !== 'string') {
      throw new Error('getThreadHistory cần params {threadId, limit?}.');
    }
    const found = this.findThread(params.threadId);
    if (!found) throw new Error(`Không tìm thấy thread "${params.threadId}".`);
    // v0.65: includeAttachments re-reads stored images for display
    // only (default false — see getHistory).
    const messages = found.memory.getThreadHistory(params.threadId, params.limit ?? 50, {
      includeAttachments: params.includeAttachments === true,
    });
    return {
      thread: found.memory.getThread(params.threadId) ?? found.thread,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.attachments && m.attachments.length > 0 ? { attachments: m.attachments } : {}),
      })),
    };
  }

  searchThreads(params: SearchThreadsParams): SearchThreadsResult {
    if (!params || typeof params.query !== 'string') {
      throw new Error('searchThreads cần params {query, botId?}.');
    }
    if (typeof params.botId === 'string' && params.botId) {
      const entry = this.getBot(params.botId);
      // listThreads first: it migrates legacy history into the default
      // thread, so a search also finds pre-thread messages.
      entry.memory.listThreads(params.botId);
      return { hits: entry.memory.searchThreads(params.botId, params.query) };
    }
    const hits: SearchThreadsResult['hits'] = [];
    for (const entry of this.bots.values()) {
      try {
        entry.memory.listThreads(entry.bot.id);
        hits.push(...entry.memory.searchThreads(entry.bot.id, params.query));
      } catch {
        continue;
      }
      if (hits.length >= 50) break;
    }
    return { hits: hits.slice(0, 50) };
  }

  /**
   * v0.59 (UI-5): find which bot owns a thread id. Threads live in the
   * per-bot BotMemory (one SQLite file per workspace), so the owner is
   * found by scanning the bots' memories. Returns null when no bot
   * owns the thread.
   */
  private findThread(
    threadId: string,
  ): { memory: import('../agent/memory').BotMemory; thread: import('../agent/memory').ThreadItem } | null {
    for (const entry of this.bots.values()) {
      const thread = entry.memory.getThread(threadId);
      if (thread) return { memory: entry.memory, thread };
    }
    return null;
  }

  listTasks(params: ListTasksParams): ListTasksResult {
    if (!params || typeof params.botId !== 'string') {
      throw new Error('listTasks cần params {botId}.');
    }
    const entry = this.getBot(params.botId);
    const tasks = entry.memory.listTasks(params.botId);
    return {
      tasks: tasks.map((t) => ({
        id: t.id,
        botId: t.botId,
        title: t.title,
        status: t.status,
        tags: t.tags,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
    };
  }

  /**
   * v0.20 (W13a): duyệt plan TRỰC TIẾP từ màn hình Kế hoạch — thay cho
   * đường cũ "gửi chat -> agent gọi plan_update trong run" vốn hiện thêm
   * một thẻ approval cho chính tool-call plan_update đó. RPC này làm
   * đúng những gì plan_update làm khi duyệt (xem planTools.ts), nhưng
   * không chạy qua run nên không có tool-call nào để hỏi duyệt:
   *  - reviewPlan(): cập nhật trạng thái trong bộ nhớ (pending ->
   *    approved/rejected/changes-requested, approve thì mode sang chat)
   *    — throw lỗi rõ khi plan không tồn tại hoặc đã có quyết định rồi.
   *  - updatePlanFileStatus(): ghi quyết định vào file plan
   *    (best-effort như plan_update — không có file thì duyệt vẫn xong).
   *  - Chỉ approve thành công mới ghi dấu planApprovedRuns loại
   *    `approve` (tái dùng cơ chế W12e, không có cơ chế dấu thứ hai):
   *    run kế tiếp của cùng bot được tự duyệt tool-call; reject
   *    không ghi dấu.
   *  - v0.20 (W15a): request-changes ghi dấu cùng map, loại
   *    `revision`: run kế tiếp chỉ tự duyệt riêng tool `plan_create`
   *    (lập lại plan), các tool khác vẫn hỏi approval như thường.
   * `plan_update` vẫn giữ nguyên làm tool cho agent (agent tự review
   * plan trong run thì thẻ approval hiện như thường — xem
   * wrapPlanApprovalTool).
   */
  reviewPlan(params: ReviewPlanParams): ReviewPlanResult {
    if (!params || typeof params.botId !== 'string' || typeof params.projectId !== 'string') {
      throw new Error('reviewPlan cần params {botId, projectId, decision}.');
    }
    if (!isPlanReviewDecision(params.decision)) {
      throw new Error(
        `reviewPlan cần decision là approve, reject hoặc request-changes (nhận: ${String(params.decision)}).`,
      );
    }
    const entry = this.getBot(params.botId);
    const note = typeof params.note === 'string' ? params.note : '';
    const { state, mode } = reviewPlan(
      entry.memory,
      params.botId,
      params.projectId,
      params.decision,
      note,
    );
    // Ghi quyết định vào file plan — best-effort như plan_update.
    let fileStatusUpdated = false;
    try {
      const workspaceDir = (entry.bot.workspaceDir ?? '').trim();
      // Sau reviewPlan, status không còn 'pending' — thu hẹp kiểu để
      // gọi updatePlanFileStatus (giống plan_update trong planTools.ts).
      if (workspaceDir && state.status !== 'pending') {
        fileStatusUpdated = updatePlanFileStatus(workspaceDir, params.projectId, state.status);
      }
    } catch {
      fileStatusUpdated = false;
    }
    // Chỉ approve mới ghi dấu loại `approve` (W12e): run kế tiếp tự
    // duyệt mọi tool-call. Request-changes ghi dấu loại `revision`
    // (W15a): run kế tiếp chỉ tự duyệt riêng `plan_create`. Reject
    // không ghi dấu.
    if (params.decision === 'approve') {
      this.planApprovedRuns.set(params.botId, {
        projectId: params.projectId,
        kind: 'approve',
      });
    } else if (params.decision === 'request-changes') {
      this.planApprovedRuns.set(params.botId, {
        projectId: params.projectId,
        kind: 'revision',
      });
    }
    return {
      projectId: state.projectId,
      botId: state.botId,
      status: state.status,
      mode,
      note: state.note,
      filePath: state.filePath,
      fileStatusUpdated,
    };
  }

  // -------------------------------------------------------------------------
  // v0.98 (Team T4 — planning v2): run-bound plans (RPC `plan.*`).
  // A plan created here lives in the coordinator (backed by
  // RunPlanBinding + PlanFileStore), NOT in the renderer's
  // localStorage: `run` with `planId` binds it to a live run, and
  // every change is emitted as a `plan.event` with a full snapshot.
  // -------------------------------------------------------------------------

  private runPlanView(planId: string): RunPlanView | null {
    const plan = this.runPlanBinding.getPlan(planId);
    if (!plan) return null;
    return {
      plan,
      runId: null,
      botId: plan.ownerBotId ?? null,
      templateId: null,
      proposals: this.runPlanBinding.listProposals(planId),
    };
  }

  createRunPlan(params: CreateRunPlanParams): CreateRunPlanResult {
    if (!params || typeof params.botId !== 'string' || !params.botId.trim()) {
      throw new Error('plan.create cần params {botId, title? | templateId?}.');
    }
    this.getBot(params.botId);
    if (typeof params.templateId === 'string' && params.templateId.trim()) {
      const instantiated = instantiatePlanTemplate(
        params.templateId.trim(),
        params.templateVars ?? {},
      );
      const plan = this.runPlanBinding.createPlan(params.botId, instantiated.title, {
        steps: instantiated.steps,
        templateId: instantiated.templateId,
      });
      return { plan, templateId: instantiated.templateId };
    }
    if (typeof params.title !== 'string' || !params.title.trim()) {
      throw new Error('plan.create cần title (hoặc templateId).');
    }
    const steps = Array.isArray(params.steps)
      ? params.steps.filter((s): s is string => typeof s === 'string')
      : [];
    const plan = this.runPlanBinding.createPlan(params.botId, params.title, {
      detail: params.detail,
      steps,
    });
    return { plan, templateId: null };
  }

  listRunPlans(): ListRunPlansResult {
    return {
      plans: this.runPlanBinding.listPlans().map((plan) => ({
        plan,
        runId: null,
        botId: plan.ownerBotId ?? null,
        templateId: null,
        proposals: this.runPlanBinding.listProposals(plan.id),
      })),
    };
  }

  getRunPlan(params: GetRunPlanParams): GetRunPlanResult {
    if (!params || typeof params.planId !== 'string' || !params.planId.trim()) {
      throw new Error('plan.get cần params {planId}.');
    }
    return { plan: this.runPlanView(params.planId) };
  }

  deleteRunPlan(params: DeleteRunPlanParams): DeleteRunPlanResult {
    if (!params || typeof params.planId !== 'string' || !params.planId.trim()) {
      throw new Error('plan.delete cần params {planId}.');
    }
    return { deleted: this.runPlanBinding.deletePlan(params.planId) };
  }

  decideReplan(params: DecideReplanParams): DecideReplanResult {
    if (!params || typeof params.proposalId !== 'string' || !params.proposalId.trim()) {
      throw new Error('plan.decideReplan cần params {proposalId, decision}.');
    }
    if (params.decision !== 'approve' && params.decision !== 'reject') {
      throw new Error('plan.decideReplan cần decision là approve hoặc reject.');
    }
    return this.runPlanBinding.decideReplan(params.proposalId, params.decision, params.runId);
  }

  /** Reload persisted plans after a restart (running steps → pending). */
  resumeRunPlans(): ResumeRunPlansResult {
    const { resumed, untouched, skipped } = this.runPlanBinding.resumeStoredPlans();
    const toView = (stored: StoredRunPlan): RunPlanView => ({
      plan: stored.plan,
      runId: stored.runId,
      botId: stored.botId,
      templateId: stored.templateId ?? null,
      proposals: this.runPlanBinding.listProposals(stored.plan.id),
    });
    return { resumed: resumed.map(toView), untouched: untouched.map(toView), skipped };
  }

  listPlanTemplates(): ListPlanTemplatesResult {
    return { templates: listPlanTemplates() };
  }

  /**
   * v0.98 — observers for a bound run's tool stream. Each is
   * best-effort by design: plan bookkeeping must never throw into
   * the run loop. Only tool signatures / normalised errors reach
   * the detector — raw arguments and outputs stay out.
   */
  private notePlanToolCall(runId: string, call: ToolCall): void {
    try {
      this.runPlanBinding.onToolCall(runId, call.name, call.args ?? {});
    } catch {
      // Observer-only.
    }
  }

  private notePlanToolResult(runId: string, result: ToolResult): void {
    try {
      this.runPlanBinding.onToolResult(runId, result.ok, result.ok ? '' : result.output);
    } catch {
      // Observer-only.
    }
  }

  private notePlanActivity(runId: string): void {
    try {
      this.runPlanBinding.noteActivity(runId);
    } catch {
      // Observer-only.
    }
  }

  /** v0.4: run one tool by name (automation `run-tool`). */
  async runTool(params: RunToolParams): Promise<RunToolResult> {
    if (!params || typeof params.botId !== 'string' || typeof params.tool !== 'string') {
      throw new Error('runTool cần params {botId, tool, args?}.');
    }
    const entry = this.getBot(params.botId);
    const tool = entry.tools.find((t) => t.definition.name === params.tool);
    if (!tool) throw new Error(`Không tìm thấy tool "${params.tool}" cho bot này.`);
    const output = await tool.execute(params.args ?? {}, {
      workspaceDir: entry.bot.workspaceDir,
      botId: entry.bot.id,
    });
    return { output };
  }

  /** v0.4: create a plan task (automation `create-task` / dream). */
  createTask(params: CreateTaskParams): CreateTaskResult {
    if (!params || typeof params.botId !== 'string' || typeof params.title !== 'string') {
      throw new Error('createTask cần params {botId, title}.');
    }
    const entry = this.getBot(params.botId);
    const id = entry.memory.createTask(params.botId, params.title);
    return { id };
  }

  /** v0.4: reload the coordinator-side skill registry. */
  reloadSkills(): ReloadSkillsResult {
    if (!this.skillRegistry) return { skills: [], errors: [] };
    const skills = this.skillRegistry.load();
    return { skills: skills.map((s) => s.name), errors: this.skillRegistry.errors() };
  }

  /** v0.4: tool-result cache stats for the Settings performance section. */
  cacheStats(): CacheStatsResult {
    return toolResultCache.stats();
  }

  /** v0.4: clear the tool-result cache. */
  cacheClear(): CacheClearResult {
    toolResultCache.clear();
    return { cleared: true };
  }

  listBots(): ListBotsResult {
    return { botIds: [...this.bots.keys()] };
  }

  /**
   * v0.59 (UI-3): RPC `listBotTools` — liệt kê toàn bộ tool của một
   * bot đã tạo, kèm nhóm / chỉ-đọc / nguồn / ước lượng token / trạng
   * thái bật-tắt theo filter của bot. Tái dùng đúng dữ liệu registry
   * (`entry.tools`) + ngữ nghĩa `filterTools` qua `isToolAllowedFor`
   * (policy denyTools) + cap theo app (M7, `cappedOutToolNames` từ
   * `listAppStatuses`) — không có cơ chế lọc riêng.
   */
  async listBotTools(params: ListBotToolsParams): Promise<ListBotToolsResult> {
    if (!params || typeof params.botId !== 'string' || params.botId.trim() === '') {
      throw new Error('listBotTools cần params {botId}.');
    }
    const entry = this.getBot(params.botId);
    const policy = this.permissions.getBotPolicy(params.botId);
    const composioNames = new Set(entry.composioTools.map((t) => t.definition.name));
    const pluginNames = new Set(entry.pluginTools.map((t) => t.definition.name));
    // Cap theo app (M7): tool nào bị cắt khỏi turn dù vẫn bật.
    // Best-effort — listAppStatuses lỗi thì coi như không tool nào bị cap.
    const capped = new Set<string>();
    try {
      for (const status of await this.listAppStatuses()) {
        for (const name of status.cappedOutToolNames ?? []) capped.add(name);
      }
    } catch {
      // Không chặn màn Tools chỉ vì không đọc được trạng thái app.
    }
    const tools: BotToolInfo[] = entry.tools.map((tool) => {
      const def = tool.definition;
      const props: Record<string, string> = {};
      const rawProps = (def.parameters as { properties?: Record<string, unknown> } | undefined)
        ?.properties;
      if (rawProps && typeof rawProps === 'object') {
        for (const [key, value] of Object.entries(rawProps)) {
          const type = (value as { type?: unknown } | null)?.type;
          props[key] = typeof type === 'string' ? type : 'any';
        }
      }
      const required = (def.parameters as { required?: unknown } | undefined)?.required;
      return {
        name: def.name,
        description: def.description ?? '',
        group: toolGroupFor(def.name),
        source: composioNames.has(def.name)
          ? 'composio'
          : pluginNames.has(def.name)
            ? 'plugin'
            : 'core',
        readOnly: isReadOnlyTool(def.name),
        enabled: isToolAllowedFor(policy, def.name),
        cappedByApp: capped.has(def.name),
        tokenEstimate: estimateToolDefinitionTokens(def),
        needsApproval: tool.needsApproval === true,
        parameters: {
          properties: props,
          required: Array.isArray(required)
            ? required.filter((r): r is string => typeof r === 'string')
            : [],
        },
      };
    });
    const enabledTools = tools.filter((t) => t.enabled);
    return {
      botId: params.botId,
      tools,
      totalTools: tools.length,
      enabledTools: enabledTools.length,
      enabledTokens: enabledTools.reduce((sum, t) => sum + t.tokenEstimate, 0),
      totalTokens: tools.reduce((sum, t) => sum + t.tokenEstimate, 0),
    };
  }

  /**
   * v0.59 (UI-3): RPC `setBotToolEnabled` — bật/tắt một tool của bot
   * bằng đúng cơ chế filter đã có: ghi vào `denyTools` của policy
   * (deny thắng — xem agent/permissions.ts), đồng bộ lại
   * `entry.bot.denyTools` để bot re-attach giữ trạng thái. Persist
   * bền (settings.json) là việc của main (IPC `tools:toggle` lưu
   * `BotConfig.denyTools` rồi mới gọi RPC này khi bot đang chạy).
   * Tool không tồn tại / bot chưa tạo → lỗi rõ ràng, không đổi gì.
   */
  setBotToolEnabled(params: SetBotToolEnabledParams): SetBotToolEnabledResult {
    if (!params || typeof params.botId !== 'string' || params.botId.trim() === '') {
      throw new Error('setBotToolEnabled cần params {botId, toolName, enabled}.');
    }
    if (typeof params.toolName !== 'string' || params.toolName.trim() === '') {
      throw new Error('setBotToolEnabled cần params {botId, toolName, enabled}.');
    }
    if (typeof params.enabled !== 'boolean') {
      throw new Error('setBotToolEnabled cần params {botId, toolName, enabled}.');
    }
    const entry = this.getBot(params.botId);
    const toolName = params.toolName.trim();
    if (!entry.tools.some((t) => t.definition.name === toolName)) {
      throw new Error(`Bot "${params.botId}" không có tool "${toolName}".`);
    }
    const policy = this.permissions.getBotPolicy(params.botId);
    const deny = new Set(policy.denyTools ?? []);
    if (params.enabled) deny.delete(toolName);
    else deny.add(toolName);
    const denyTools = [...deny];
    this.permissions.setBotPolicy(params.botId, { ...policy, denyTools });
    entry.bot.denyTools = denyTools;
    return { botId: params.botId, toolName, enabled: params.enabled, denyTools };
  }

  /**
   * v0.64 (skills per-bot): RPC `listBotSkills` — liệt kê toàn bộ
   * skill trong registry dùng chung, kèm trạng thái bật/tắt RIÊNG của
   * bot (policy denySkills — xem agent/permissions.ts). Registry
   * chưa dựng (bot tạo không có skillsDirs) thì trả danh sách rỗng,
   * không throw — như `reloadSkills`. `enabled` = qua filter của bot;
   * `globallyEnabled` = skill đang bật toàn cục (Settings → Skills).
   */
  listBotSkills(params: ListBotSkillsParams): ListBotSkillsResult {
    if (!params || typeof params.botId !== 'string' || params.botId.trim() === '') {
      throw new Error('listBotSkills cần params {botId}.');
    }
    const entry = this.getBot(params.botId);
    const policy = this.permissions.getBotPolicy(params.botId);
    const registry = this.skillRegistry;
    const skills: BotSkillInfo[] = (registry?.list() ?? []).map((skill) => ({
      name: skill.name,
      description: skill.description,
      context: skillRunsInSubagent(skill) ? 'fork' : 'inline',
      allowedTools: [...skill.allowedTools],
      enabled: isSkillAllowedFor(policy, skill.name),
      globallyEnabled: skill.enabled,
    }));
    return {
      botId: entry.bot.id,
      skills,
      totalSkills: skills.length,
      enabledSkills: skills.filter((s) => s.enabled).length,
    };
  }

  /**
   * v0.64 (skills per-bot): RPC `setBotSkillEnabled` — bật/tắt một
   * skill của bot bằng đúng cơ chế filter đã có: ghi vào `denySkills`
   * của policy (deny thắng — xem agent/permissions.ts), đồng bộ lại
   * `entry.bot.denySkills` để bot re-attach giữ trạng thái. Persist
   * bền (settings.json) là việc của main (IPC `bot-skills:toggle`
   * lưu `BotConfig.denySkills` rồi mới gọi RPC này khi bot đang
   * chạy). Skill không tồn tại / bot chưa tạo → lỗi rõ ràng, không
   * đổi gì. Không sửa registry dùng chung nên bot khác không bị ảnh
   * hưởng — khác hẳn `skills:toggle` toàn cục ở main.
   */
  setBotSkillEnabled(params: SetBotSkillEnabledParams): SetBotSkillEnabledResult {
    if (!params || typeof params.botId !== 'string' || params.botId.trim() === '') {
      throw new Error('setBotSkillEnabled cần params {botId, skillName, enabled}.');
    }
    if (typeof params.skillName !== 'string' || params.skillName.trim() === '') {
      throw new Error('setBotSkillEnabled cần params {botId, skillName, enabled}.');
    }
    if (typeof params.enabled !== 'boolean') {
      throw new Error('setBotSkillEnabled cần params {botId, skillName, enabled}.');
    }
    const entry = this.getBot(params.botId);
    const skillName = params.skillName.trim();
    if (!this.skillRegistry?.get(skillName)) {
      throw new Error(`Bot "${params.botId}" không có skill "${skillName}".`);
    }
    const policy = this.permissions.getBotPolicy(params.botId);
    const deny = new Set(policy.denySkills ?? []);
    if (params.enabled) deny.delete(skillName);
    else deny.add(skillName);
    const denySkills = [...deny];
    this.permissions.setBotPolicy(params.botId, { ...policy, denySkills });
    entry.bot.denySkills = denySkills;
    return { botId: params.botId, skillName, enabled: params.enabled, denySkills };
  }

  destroyBot(params: DestroyBotParams): DestroyBotResult {
    if (!params || typeof params.botId !== 'string') {
      throw new Error('destroyBot cần params {botId, deleteData?}.');
    }
    const entry = this.getBot(params.botId);
    // v0.8: a destroyed bot's queued runs never start (their run()
    // promises reject instead of failing later on a missing bot).
    this.cancelQueuedRuns(params.botId);
    try {
      entry.controller?.abort();
    } catch {
      // Aborting is best-effort.
    }
    // Fix v0.59 leftover (b): real delete only — wipe the bot's
    // BotMemory rows BEFORE closing the handle. Default (no flag) keeps
    // the data: destroyBot also runs on bot edit / provider change /
    // MCP install via main `invalidateRuntime`, where wiping would
    // destroy history. Best-effort: teardown must not fail because the
    // wipe failed (main's `bots:delete` also calls `deleteBotData`).
    let deletedRows: Record<string, number> | undefined;
    if (params.deleteData === true) {
      try {
        deletedRows = entry.memory.deleteBotData(params.botId);
      } catch {
        // Best-effort — the wipe is retried by `deleteBotData` RPC.
      }
    }
    try {
      entry.memory.close();
    } catch {
      // Already closed — nothing to do.
    }
    // M1: provider CLI giữ process sống (vd Claude Code) — dispose để
    // kill process đó, không để CLI con mồ côi sau khi bot bị xoá.
    // M4: dispose qua helper (unwrap MeteredProvider — xem
    // disposeProvider): gọi thẳng entry.provider.dispose?.() là no-op
    // khi provider bị bọc, process CLI sẽ rò.
    // Best-effort, không throw (destroyBot là sync).
    disposeProvider(entry.provider);
    // M5: gỡ bot khỏi harness registry + từ chối permission đang chờ của nó.
    try {
      this.harness?.unregisterBot(params.botId);
    } catch {
      // Best-effort.
    }
    this.bots.delete(params.botId);
    // M4: bot bị xoá thì switch model đang chờ của nó cũng hết.
    this.pendingModelSwitches.delete(params.botId);
    // v0.19 (W12e): bot bị xoá thì dấu plan-approved của nó cũng hết.
    this.planApprovedRuns.delete(params.botId);
    // v0.24 (W17d): bot bị xoá thì lịch sử sampling dùng chung cũng hết.
    entry.samplingContextStore.clear();
    return { botId: params.botId, destroyed: true, ...(deletedRows ? { deletedRows } : {}) };
  }

  /**
   * Fix v0.59 leftover (b): wipe one bot's BotMemory rows by workspace
   * dir, WITHOUT needing a live runtime entry. Opens the bot's DB
   * fresh, deletes every row of `botId`, closes it again. A bot with
   * no memory.db file reports zero rows and creates nothing — this
   * method never creates a DB for a bot that has none.
   *
   * Main's `bots:delete` calls this after `invalidateRuntime` closed
   * the live entry's handle, so no two handles write at once. It is
   * the authoritative wipe for the delete path: it also covers bots
   * deleted without running since the app started (no live entry, so
   * `destroyBot` alone could not reach their rows).
   */
  deleteBotData(params: DeleteBotDataParams): DeleteBotDataResult {
    if (
      !params ||
      typeof params.botId !== 'string' ||
      typeof params.workspaceDir !== 'string' ||
      params.workspaceDir.trim() === ''
    ) {
      throw new Error('deleteBotData cần params {botId, workspaceDir}.');
    }
    const zero: Record<string, number> = {
      messages: 0,
      threads: 0,
      memory_entries: 0,
      tasks: 0,
      goals: 0,
      todos: 0,
      projects: 0,
      run_checkpoints: 0,
      bots: 0,
    };
    const dbFile = path.join(params.workspaceDir, '.open-bot', 'memory.db');
    if (!fs.existsSync(dbFile)) {
      return { botId: params.botId, deletedRows: zero };
    }
    const memory = new BotMemory(params.workspaceDir);
    try {
      return { botId: params.botId, deletedRows: memory.deleteBotData(params.botId) };
    } finally {
      try {
        memory.close();
      } catch {
        // Best-effort.
      }
    }
  }

  /**
   * M4 — đổi model/provider của bot giữa chừng, không mất thread.
   *
   * - Không có run đang chạy: đổi provider ngay (swapProvider) — BotMemory
   *   (transcript, task, plan, checkpoint), tool list, dấu
   *   plan-approved và handoff chain giữ nguyên; chỉ provider bị thay.
   * - Có run đang chạy: KHÔNG ngắt run — ghi provider mới vào
   *   pendingModelSwitches, run đang chạy vẫn chạy hết bằng model cũ,
   *   executeRun của run KẾ TIẾP áp dụng ngay đầu run (trước khi dựng
   *   runner). Tool call / plan / handoff đang chạy không bị đụng tới.
   *
   * Validate fail-closed trước khi ghi/ap dụng: provider id phải biết
   * (PROVIDERS hoặc 'mock' test-only), model không rỗng, provider CLI
   * phải có cliBinary (main đã kiểm tra engine bật + đăng nhập qua
   * providerConfigFor; đây là lớp chặn thứ hai trong coordinator).
   * Provider mới được dựng TRƯỚC khi dispose provider cũ — dựng lỗi
   * thì bot giữ nguyên provider cũ, không mất bot.
   */
  switchModel(params: SwitchModelParams): SwitchModelResult {
    if (!params || typeof params.botId !== 'string' || params.botId.trim() === '') {
      throw new Error('switchModel cần params {botId, provider}.');
    }
    const entry = this.getBot(params.botId);
    // v0.96: user đổi model tay → gỡ pin router của bot để turn sau
    // route lại từ đầu thay vì giữ model cũ đã pin.
    this.routerInstance?.clearPinsForBot(params.botId);
    const providerConfig = params.provider;
    if (!providerConfig || typeof providerConfig.id !== 'string' || !providerConfig.id) {
      throw new Error('switchModel cần provider.id không rỗng.');
    }
    const model = (providerConfig.defaultModel ?? '').trim();
    if (!model) {
      throw new Error('switchModel cần provider.defaultModel không rỗng (model mới).');
    }
    const known =
      providerConfig.id === 'mock' ||
      PROVIDERS.some((p) => p.id === providerConfig.id);
    if (!known) {
      throw new Error(`switchModel: không rõ provider id: ${providerConfig.id}`);
    }
    const meta = PROVIDERS.find((p) => p.id === providerConfig.id);
    if (meta?.kind === 'cli' && !providerConfig.cliBinary) {
      throw new Error(
        `switchModel: provider CLI "${providerConfig.id}" cần cliBinary — bật nguồn trong Settings → Engines trước.`,
      );
    }
    if (params.usageStorePath) entry.usageStorePath = params.usageStorePath;
    if (entry.running) {
      this.pendingModelSwitches.set(params.botId, providerConfig);
      return {
        botId: params.botId,
        providerId: providerConfig.id,
        model,
        applied: false,
        pending: true,
        running: true,
      };
    }
    this.swapProvider(entry, providerConfig);
    return {
      botId: params.botId,
      providerId: providerConfig.id,
      model,
      applied: true,
      pending: false,
      running: false,
    };
  }

  /**
   * M4 — thay provider của một bot entry bằng provider mới (đồng bộ).
   * Dựng provider mới trước (kèm MeteredProvider khi có usageStorePath
   * như createBot), rồi mới dispose provider cũ qua helper (unwrap
   * MeteredProvider để process CLI cũ chết thật), cuối cùng cập nhật
   * entry.bot + entry.providerConfig và lưu bot mới vào BotMemory để
   * lần createBot sau (restart) cũng thấy model mới. Tool list,
   * memory, dấu plan, handoff chain không đụng tới.
   */
  private swapProvider(entry: BotEntry, providerConfig: CreateBotProviderConfig): void {
    const newProvider = this.buildProvider(entry.bot.id, providerConfig, entry.usageStorePath);
    disposeProvider(entry.provider);
    entry.provider = newProvider;
    // M5: switchModel đổi provider → đăng ký lại instance trong harness
    // (entry cũ đã dispose xong nên reregister không kill lại).
    if (this.harness) {
      try {
        this.harness.reregisterProvider(entry.bot.id, newProvider, {
          engine: providerConfig.id,
          threadId: entry.bot.id,
        });
      } catch (err) {
        process.stderr.write(
          `[coordinator] harness: không đăng ký lại được bot "${entry.bot.id}" sau switchModel: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    entry.providerConfig = providerConfig;
    entry.bot = {
      ...entry.bot,
      providerId: providerConfig.id,
      model: (providerConfig.defaultModel ?? '').trim() || entry.bot.model,
    };
    try {
      entry.memory.saveBot(entry.bot);
    } catch {
      // Lưu bot lỗi không làm hỏng switch — settings ở main đã lưu.
    }
  }

  /** M4 — dựng Provider từ config, cùng nhánh mock + MeteredProvider như createBot. */
  private buildProvider(
    botId: string,
    providerConfig: CreateBotProviderConfig,
    usageStorePath?: string,
  ): Provider {
    let provider: Provider =
      providerConfig.id === 'mock'
        ? createMockProvider(providerConfig.mockResponses ?? [], {
            recordPath: mockRecordPathFromProviderConfig(providerConfig),
            supportsVision: mockSupportsVisionFromProviderConfig(providerConfig),
          })
        : createProvider(providerConfig);
    if (usageStorePath) {
      provider = new MeteredProvider(provider, this.getUsageTracker(usageStorePath), {
        botId,
      });
    }
    return provider;
  }

  /**
   * v0.14 (item 9): enable/disable a plugin for a RUNNING bot. The flip
   * is persisted to `<pluginsDir>/enabled.json` (via the cached manager)
   * and the bot's tool list is rebuilt from core tools + the manager's
   * current enabled plugin tools. A run already in flight keeps the
   * tools it started with; the next run uses the new list. Throws when
   * the bot or the plugin is unknown.
   */
  async setPluginEnabled(params: SetPluginEnabledParams): Promise<SetPluginEnabledResult> {
    if (!params || typeof params.botId !== 'string' || typeof params.pluginId !== 'string') {
      throw new Error('setPluginEnabled cần params {botId, pluginId, enabled}.');
    }
    const entry = this.getBot(params.botId);
    if (!entry.pluginsDir) {
      return { ok: true, enabled: params.enabled === true, appliedToRunning: false };
    }
    const manager = getPluginManager(entry.pluginsDir);
    const changed = params.enabled === true
      ? manager.enable(params.pluginId)
      : manager.disable(params.pluginId);
    if (!changed) {
      throw new Error(`Không tìm thấy plugin "${params.pluginId}" trong "${entry.pluginsDir}".`);
    }
    this.rebuildPluginTools(entry);
    return { ok: true, enabled: params.enabled === true, appliedToRunning: true };
  }

  /** Rebuild one bot's tool list from core tools + enabled plugin tools. */
  private rebuildPluginTools(entry: BotEntry): void {
    if (!entry.pluginsDir) return;
    const manager = getPluginManager(entry.pluginsDir);
    const pluginTools = manager.toolsForRegistry();
    const seen = new Set(entry.coreTools.map((t) => t.definition.name));
    const kept: Tool[] = [];
    for (const tool of pluginTools) {
      if (seen.has(tool.definition.name)) {
        process.stderr.write(
          `[coordinator] Bỏ qua tool plugin trùng tên: "${tool.definition.name}".\n`,
        );
        continue;
      }
      seen.add(tool.definition.name);
      kept.push(tool);
    }
    entry.pluginTools = kept;
    entry.tools = [...entry.coreTools, ...entry.composioTools, ...kept];
  }

  /**
   * v0.14 (item 7): capabilities of local bots for supervisor routing —
   * description = bot name + system prompt (first 300 chars); skills =
   * skill names whose descriptions match nothing yet (per-bot skills are
   * not tracked separately — the registry is process-wide). ScoreAgent
   * matches task keywords against the description.
   */
  listBotCapabilities(agentIds?: string[]): AgentCapability[] {
    const out: AgentCapability[] = [];
    for (const [id, entry] of this.bots) {
      if (agentIds && !agentIds.includes(id)) continue;
      const system = (entry.bot.systemPrompt ?? '').trim().replace(/\s+/g, ' ');
      out.push({
        id,
        kind: 'local-bot',
        description: `${entry.bot.name}: ${system.slice(0, 300)}`,
        skills: [],
      });
    }
    return out;
  }

  /**
   * v0.14 (item 7): route a task to the best bot(s) by capability and run
   * it there via a silent run. Sequential mode tries the best agent and
   * falls back to the next on error (max 3 attempts); parallel mode runs
   * the top-N at once. Throws when the task is empty or no agent matches.
   */
  async supervise(params: SuperviseParams): Promise<SuperviseResult> {
    if (!params || typeof params.task !== 'string' || params.task.trim() === '') {
      throw new Error('supervise cần params {task} (chuỗi không rỗng).');
    }
    const mode = params.mode === 'parallel' ? 'parallel' : 'sequential';
    const supervisor = new Supervisor();
    const results = await supervisor.dispatch(params.task, {
      agents: this.listBotCapabilities(params.agentIds),
      mode,
      topN: params.topN,
      handoff: async (agentId, task) => {
        const result = await this.run({ botId: agentId, text: task, silent: true });
        return result.text;
      },
    });
    return {
      task: params.task,
      mode,
      results: results.map((r) => ({
        agentId: r.agentId,
        result: typeof r.result === 'string' ? r.result : undefined,
        error: r.error,
        score: r.score,
      })),
    };
  }

  ping(): PingResult {
    return { pong: true };
  }

  shutdown(): ShutdownResult {
    if (this.shuttingDown) return { ok: true };
    this.shuttingDown = true;
    // v0.8: queued runs never start after shutdown (their run()
    // promises reject instead of hanging until the process exits).
    this.cancelQueuedRuns();
    // Unblock any run waiting on approval / ask-user with safe defaults.
    for (const resolve of this.pendingApprovals.values()) resolve(false);
    this.pendingApprovals.clear();
    for (const resolve of this.pendingAskUser.values()) resolve('');
    this.pendingAskUser.clear();
    for (const resolve of this.pendingElicitations.values()) resolve({ action: 'cancel' });
    this.pendingElicitations.clear();
    // v0.19 (W12e): shutdown xoá mọi dấu plan-approved chưa dùng.
    this.planApprovedRuns.clear();
    // v0.58: đóng Composio session + MCP client (best-effort, async —
    // tiến trình con thoát khi stdin đóng dù dispose còn chạy dở).
    void this.composioManager.close().catch(() => undefined);
    // Stop the exec daemon (best-effort, async — the child exits on its
    // own when stdin closes even if this dispose is still in flight).
    if (this.daemonClient) {
      const daemon = this.daemonClient;
      this.daemonClient = null;
      void daemon.dispose().catch(() => undefined);
    }
    // M5: kill toàn bộ process CLI còn sống theo harness registry
    // (best-effort, async) + từ chối permission đang chờ — chống rò
    // process khi shutdown. Registry trống sau đó.
    if (this.harness) {
      void this.harness.shutdownAll().catch(() => undefined);
    }
    // v0.14: kill sandboxed plugin children (best-effort, async).
    void disposePluginManagers().catch(() => undefined);
    // v0.28: close the MCP client pool (best-effort, async) so pooled
    // stdio children do not linger after shutdown; idle eviction alone
    // would leave them up to 5 minutes.
    try {
      const toolsMod = require('@open-bot/tools') as {
        closeMcpClientPool?: () => Promise<void>;
      };
      void toolsMod.closeMcpClientPool?.().catch(() => undefined);
    } catch {
      // Best-effort: tools package unavailable in this embedder.
    }
    for (const entry of this.bots.values()) {
      try {
        entry.controller?.abort();
      } catch {
        // Best-effort.
      }
      // M1: provider CLI giữ process sống — dispose để kill process đó
      // khi shutdown (best-effort, async). M4: qua helper (unwrap
      // MeteredProvider) như destroyBot.
      disposeProvider(entry.provider);
      // v0.24 (W17d): shutdown xoá lịch sử sampling dùng chung của bot.
      entry.samplingContextStore.clear();
      try {
        entry.memory.close();
      } catch {
        // Best-effort: a broken DB close must not block shutdown.
      }
    }
    this.bots.clear();
    return { ok: true };
  }
}

/**
 * stdio entry point: read NDJSON requests from stdin, write NDJSON
 * responses/notifications to stdout. Nothing else may write to stdout —
 * diagnostics go to stderr, and request params are never logged.
 */
export async function runCoordinatorStdio(): Promise<void> {
  const emit: (notification: CoordinatorNotification) => void = (notification) => {
    process.stdout.write(`${JSON.stringify(notification)}\n`);
  };
  // v0.50 (M8 — follow-up M5 còn nợ): coordinator con DỰNG LocalHarness
  // với dataDir (userData, qua env OPENBOT_DATA_DIR mà desktop main đã
  // truyền khi spawn). Main không thể truyền object qua NDJSON-RPC, nên
  // harness sống trong tiến trình con — nơi provider CLI thật sự chạy
  // (đăng ký instance + gắn sink/broker ở attachBotToHarness).
  // permissionUiHandler: broker hỏi → emit event
  // 'harness.permission-needed' về main (renderer mở thẻ duyệt) rồi CHỜ
  // quyết định qua RPC `harnessDecidePermission`; promise này không tự
  // resolve — harness bọc nó và onDecision của broker resolve khi có
  // quyết định/timeout (xem harness.ts), nên không treo/rò rỉ.
  // Không có UI (headless/CLI) thì broker từ chối fail-closed như cũ.
  const harness = new LocalHarness({
    ...(process.env['OPENBOT_DATA_DIR']
      ? { dataDir: process.env['OPENBOT_DATA_DIR'] }
      : {}),
    permissionUiHandler: (request) => {
      emit({
        event: 'agent.event',
        data: {
          botId: request.botId,
          kind: 'harness.permission-needed',
          payload: {
            requestId: request.requestId,
            botId: request.botId,
            engine: request.engine,
            method: request.method,
            ...(request.detail !== undefined ? { detail: request.detail } : {}),
            allowable: request.allowable,
          },
        },
      });
      return new Promise<boolean>(() => {
        // Không tự resolve — onDecision của broker (harness.ts) resolve
        // khi user quyết qua RPC, hoặc khi hết timeout 120s.
      });
    },
  });
  // v0.90a (Đội G): live stream — mọi event harness (đã sanitize ở
  // bus + NDJSON) forward về main qua notification 'agent.event' kind
  // 'harness.event'; main forward tiếp về renderer ('harness:event')
  // và SSE Local API. Bus publish không throw nên emit ở đây cũng
  // không làm hỏng coordinator. Volume: CLI driver text delta cũng đi
  // qua đây (đã ghi NDJSON từ trước) — main chỉ forward về renderer
  // khi có subscriber, SSE lọc theo thread/bot/kind.
  // v0.90e (Đội G): event của run im lặng KHÔNG forward — giữ hợp
  // đồng v0.4 "silent run không đẩy event nào về parent" (log NDJSON
  // vẫn giữ để audit; cờ silent do loop sink / cliEventSink gắn).
  harness.bus.subscribe({}, (event) => {
    if (event.silent === true) return;
    emit({
      event: 'agent.event',
      data: { botId: event.botId, kind: 'harness.event', payload: event },
    });
  });
  const coordinator = new AgentCoordinator({
    emit,
    harness,
    // v0.85 (P1-7): wire the `manage_access` admin check. Main cannot
    // pass a function over NDJSON-RPC, so it passes the local user's
    // id via env `OPENBOT_LOCAL_USER_ID` (see main.ts `getCoordinator`)
    // and the userData dir via `OPENBOT_DATA_DIR` (already passed);
    // this child entry turns them into the host callbacks the tool
    // factory needs. The role is read LIVE from team.json on every
    // mutation (see `isLocalUserTeamAdmin` in team.ts), so a role
    // change takes effect without restarting the coordinator.
    // `getTeamBaseDir` points at userData, so the tool manages the
    // SAME team.json the desktop admin UI edits.
    ...(process.env['OPENBOT_DATA_DIR']
      ? { dataDir: process.env['OPENBOT_DATA_DIR'] }
      : {}),
    getTeamBaseDir: () => process.env['OPENBOT_DATA_DIR'] ?? null,
    isTeamAdmin: () => {
      const baseDir = process.env['OPENBOT_DATA_DIR'];
      if (!baseDir) return false;
      return isLocalUserTeamAdmin(
        baseDir,
        process.env['OPENBOT_LOCAL_USER_ID']?.trim() || LOCAL_USER_ID,
      );
    },
    // v0.74a follow-up: cho phép test rút ngắn cửa sổ pending-stop
    // qua env (mặc định 30s khi không đặt / không parse được).
    ...(process.env['OPENBOT_PENDING_STOP_WINDOW_MS']
      ? { pendingStopWindowMs: Number(process.env['OPENBOT_PENDING_STOP_WINDOW_MS']) }
      : {}),
  });
  // v0.97 (Team T3): live stream AG-UI — mọi event emitter của loop
  // (đã validate ở bus) forward về main qua notification 'agent.event'
  // kind 'agui.event'; main forward tiếp về renderer ('agui:event')
  // và SSE Local API. Emitter của run im lặng / mock / CLI không
  // publish gì nên không có gì để forward ở đây — CLI run vẫn thấy
  // qua kênh 'harness.event' + bridge ở main.
  coordinator.getAgUiBus().subscribe({}, (event) => {
    emit({
      event: 'agent.event',
      data: { botId: event.botId ?? '', kind: 'agui.event', payload: event },
    });
  });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let req: { id?: unknown; method?: unknown; params?: unknown };
    try {
      req = JSON.parse(trimmed) as typeof req;
    } catch {
      process.stderr.write('[coordinator] Bỏ qua dòng stdin không phải JSON.\n');
      continue;
    }
    if (typeof req.id !== 'string' || typeof req.method !== 'string') {
      process.stderr.write('[coordinator] Bỏ qua request thiếu id/method.\n');
      continue;
    }
    const { id, method } = req;
    const params =
      req.params !== undefined && typeof req.params === 'object' && req.params !== null
        ? (req.params as Record<string, unknown>)
        : {};
    // Fire-and-forget on purpose: the loop must keep reading stdin while
    // a long `run` is in flight, otherwise `stopBot` (or any other
    // request) could only be handled after that run finishes. Responses
    // may arrive out of order; the client matches them by id.
    coordinator
      .handle(method, params)
      .then((result) => {
        process.stdout.write(`${JSON.stringify({ id, result })}\n`);
        if (method === 'shutdown') {
          // Let the response flush, then exit.
          setImmediate(() => process.exit(0));
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stdout.write(
          `${JSON.stringify({ id, error: { message, code: 'COORDINATOR_ERROR' } })}\n`,
        );
      });
  }
}

// Run the stdio loop only when executed directly as the child process
// (node packages/core/dist/coordinator/coordinator.js), not when imported.
if (require.main === module) {
  runCoordinatorStdio().catch((err: unknown) => {
    process.stderr.write(
      `[coordinator] Lỗi nghiêm trọng: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
