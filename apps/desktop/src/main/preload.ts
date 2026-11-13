/**
 * Open Bot — preload script.
 *
 * Chỉ expose đúng API `window.openBot` qua contextBridge.
 * KHÔNG expose ipcRenderer trực tiếp, KHÔNG expose API key hay Node API.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { AppliedPluginTemplate, A2aPersistStatus, AppStatusView, AuditEvent, AuditVerifyResult, AutoApproveRule, AutoApproveRuleInput, BotConfig, CanvasDocument, CanvasSummary, ComposioStateView, ComposioToolkitConnection, ComputerBackend, ComputerPlan, ComputerSchedulerState, ComputerStatusView, CreateFleetWorkspaceInput, CreatePluginTemplateInput, CrashReport, CrashReportSummary, DeepLinkRoute, FleetCapacityCheck, FleetDecision, FleetRole, FleetStatusView, FleetUsageSummary, FleetWorkspace, GroupBotInterruptedEntry, GroupBotStatusEntry, GroupChat, GroupMessage, GuestAgentHealth, HarnessEvent, HarnessStatusResult, HarnessThreadLogResult, ListBotSkillsResult, ListBotToolsResult, LocalProfile, LongTermMemoryEntry, MachineProfile, OnePasswordBrokerStatus, PluginTemplate, SetBotSkillEnabledResult, SetBotToolEnabledResult, TeamBundle, ThreadItem, ThreadSearchHit, VisionAttachment } from '@open-bot/core';
// Trace shapes from core (not ../renderer/types: tsconfig.main.json
// pins rootDir to src/main, so preload cannot import renderer files).
// The renderer-side mirrors live in ../renderer/types.ts.
import type { Trace, TraceSummary } from '@open-bot/core/dist/tracing/index.js';

// v0.11: one plan read back from disk (`plans:list` in main.ts).
export interface StoredPlan {
  id: string;
  projectId: string;
  botId: string;
  title: string;
  detail?: string;
  filePath: string;
  path: string;
  steps: string[];
  decisions: string[];
  status: 'pending' | 'approved' | 'rejected' | 'changes-requested';
  createdAt: string;
  updatedAt: string;
  /** v0.79b: previous version (newest history snapshot) for the plan diff. */
  previous?: {
    steps: string[];
    decisions: string[];
    updatedAt: string;
  };
  /** v0.79b: diff against `previous` (computed in main with core). */
  diff?: {
    steps: { added: string[]; removed: string[]; unchanged: string[] };
    decisions: { added: string[]; removed: string[]; unchanged: string[] };
  };
}

// v0.31 (P1-2): agent A2A ngoài mà user đã tin tưởng (mirror của
// TrustedA2aAgentRecord trong main.ts + renderer/types.ts).
export interface TrustedA2aAgent {
  baseUrl: string;
  name: string;
  description?: string;
  url: string;
  skills?: Array<{ id: string; name: string; description: string }>;
  streaming?: boolean;
  trustedAt: string;
}

// v0.31 (P1-2): kết quả gửi task thử tới agent ngoài qua `a2a:trusted-send`.
export interface A2aSendResult {
  taskId: string;
  state: string;
  text: string;
  artifacts: Array<{ artifactId: string; name: string | null; text: string }>;
}

// v0.95 (Team D1): Internet data shapes (mirror của
// InternetFeed / InternetWatch / InternetDataState trong
// packages/tools/src/internetData.ts + renderer/types.ts).
export interface InternetFeed {
  id: string;
  url: string;
  title: string;
  addedAt: number;
  lastCheckedAt?: number;
  lastItemCount?: number;
}

export interface InternetWatch {
  id: string;
  url: string;
  intervalMinutes: number;
  lastHash?: string;
  lastCheckedAt?: number;
  lastChangedAt?: number;
  lastSummary?: string;
  lastError?: string;
}

export interface InternetDataState {
  version: 1;
  feeds: InternetFeed[];
  watches: InternetWatch[];
}

export interface InternetFeedItem {
  title: string;
  link: string;
  published: string;
  summary: string;
  id: string;
}

export interface InternetWatchChange {
  watch: InternetWatch;
  changed: boolean;
  summary: string;
  addedLines: string[];
  removedLines: string[];
  checkedAt: number;
}

// v0.20 (W13a): kết quả duyệt plan trực tiếp qua IPC `plans:review`
// (coordinator RPC `reviewPlan` — xem packages/core/src/coordinator/types.ts).
export interface PlanReviewResult {
  projectId: string;
  botId: string;
  status: 'pending' | 'approved' | 'rejected' | 'changes-requested';
  mode: string;
  note: string;
  filePath: string;
  fileStatusUpdated: boolean;
}

// v0.54 (P1-9): trạng thái update đầy đủ từ UpdateService (mirror của
// UpdateStatus trong ./updateService.ts — preload không import type
// trực tiếp để renderer types giữ độc lập).
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

// v0.54 (P1-8): yêu cầu interrupt từ coordinator (event `interrupt-needed`).
export interface InterruptRequestView {
  botId: string;
  requestId: string;
  runId: string;
  stepIndex: number;
  reason: string;
  question?: string;
  toolCall?: { id?: string; name?: string; args?: Record<string, unknown> };
}

// v0.54 (P1-8): quyết định của user khi run dừng ở điểm interrupt.
export type InterruptDecisionView =
  | { action: 'continue' }
  | { action: 'continue-with-message'; message: string }
  | { action: 'deny-tool' }
  | { action: 'cancel' };

// v0.95d4 (Đội D4): user profile + long-term memory (local-first).
// Profile = LocalProfile của core (đã mở rộng: addressForm, interests,
// habits, facts). MemoryEntryView = LongTermMemoryEntry KHÔNG kèm
// vector embedding (main đã strip trước khi trả về renderer).
export type UserProfileView = LocalProfile;
export interface UserProfilePatch {
  displayName?: string;
  addressForm?: string;
  interests?: string[];
  habits?: string[];
  facts?: string[];
}
export type MemoryEntryView = Omit<LongTermMemoryEntry, 'embedding'>;

// v0.54 (P1-8): tóm tắt nhẹ một checkpoint (không chứa full history).
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

export interface OpenBotApi {
  listBots: () => Promise<BotConfig[]>;
  createBot: (config: Partial<BotConfig>) => Promise<BotConfig>;
  updateBot: (config: BotConfig) => Promise<BotConfig>;
  deleteBot: (botId: string) => Promise<boolean>;
  // M4: đổi model giữa chừng (không mất thread) — xem IPC
  // 'bots:switch-model' trong main.ts.
  'bots:switch-model'(payload: { botId: string; providerId: string; model: string }): Promise<{
    bot: BotConfig;
    providerId: string;
    model: string;
    applied: boolean;
    pending: boolean;
    running: boolean;
  }>;
  switchModel: (payload: { botId: string; providerId: string; model: string }) => Promise<{
    bot: BotConfig;
    providerId: string;
    model: string;
    applied: boolean;
    pending: boolean;
    running: boolean;
  }>;
  // v0.63 (vision channel): images ride along as VisionAttachment
  // { mimeType, data (base64, no `data:` prefix), name? } — mirror of
  // core VisionAttachment (see ../renderer/components/composer.ts).
  // `text` may be empty when attachments are present (image-only).
  sendChat: (botId: string, text: string, threadId?: string, attachments?: Array<{ mimeType: string; data: string; name?: string }>) => Promise<{ ok: boolean; text?: string; error?: string; stopped?: boolean }>;
  // v0.59 (UI-2): stop the bot's current chat run (IPC `chat:stop` ->
  // coordinator.stopBot; a bot runs one turn at a time, so stopping by
  // bot stops the current run — same reasoning as ApiHandlers.stopRun).
  stopChat: (botId: string) => Promise<{ botId: string; stopped: boolean; reason?: string }>;
  onChatDelta: (cb: (payload: { botId: string; delta: string }) => void) => () => void;
  onToolCall: (cb: (payload: { botId: string; call: unknown }) => void) => () => void;
  // Core AgentEvents.onToolResult sends a single ToolResult { callId, ok, output }.
  onToolResult: (cb: (payload: { botId: string; result: { callId: string; ok: boolean; output: string } }) => void) => () => void;
  onApprovalNeeded: (
    cb: (payload: { botId: string; callId: string; call: unknown; reason?: string; argsSummary?: string }) => void,
  ) => () => void;
  respondApproval: (callId: string, approved: boolean, args?: Record<string, unknown>) => void;
  /**
   * v0.50 (M8): permission từ CLI engine qua harness broker — main
   * forward event `harness.permission-needed` của coordinator; renderer
   * hiện PermissionCard và trả lời qua `respondHarnessPermission`
   * (xuống RPC `harnessDecidePermission`).
   */
  onHarnessPermissionNeeded: (
    cb: (payload: {
      requestId: string;
      botId: string;
      engine: string;
      method: string;
      detail?: string;
      allowable: boolean;
    }) => void,
  ) => () => void;
  respondHarnessPermission: (requestId: string, allowed: boolean) => void;
  /**
   * v0.90a (Đội G): harness event log — status registry + đọc NDJSON
   * log theo thread (EventLogView) + live event đã sanitize từ
   * coordinator con (kênh 'harness:event', main forward từ
   * 'harness.event' của coordinator).
   */
  'harness:status'(): Promise<HarnessStatusResult>;
  'harness:thread-log'(query: {
    threadId: string;
    limit?: number;
    offset?: number;
    kinds?: string[];
  }): Promise<HarnessThreadLogResult>;
  getHarnessStatus: () => Promise<HarnessStatusResult>;
  getHarnessThreadLog: (query: {
    threadId: string;
    limit?: number;
    offset?: number;
    kinds?: string[];
  }) => Promise<HarnessThreadLogResult>;
  onHarnessEvent: (cb: (event: HarnessEvent) => void) => () => void;
  /** Fired when a bot is created outside the UI (e.g. create_agent tool). */
  onBotsChanged: (cb: (payload: { botId: string }) => void) => () => void;
  onAskUser: (
    cb: (payload: { botId: string; requestId: string; question: string; options?: string[] }) => void,
  ) => () => void;
  respondAskUser: (requestId: string, answer: string) => void;
  /**
   * v0.13: MCP elicitation — an MCP server asks the user a question
   * (form / URL). Payload mirrors ElicitationRequestView in the
   * renderer; the modal answers through `respondElicitation`.
   */
  onElicitation: (
    cb: (payload: {
      botId: string;
      elicitationId: string;
      serverName: string;
      message: string;
      mode: 'form' | 'url';
      url?: string;
      fields?: Array<{
        name: string;
        type: 'string' | 'number' | 'integer' | 'boolean' | 'string-array';
        title?: string;
        description?: string;
        required: boolean;
        enum?: string[];
        default?: string | number | boolean | string[];
      }>;
    }) => void,
  ) => () => void;
  respondElicitation: (
    elicitationId: string,
    result: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> },
  ) => void;
  onProgress: (cb: (payload: { botId: string; message: string }) => void) => () => void;
  onFinalSummary: (cb: (payload: { botId: string; summary: string }) => void) => () => void;
  getHistory: (botId: string, limit?: number, threadId?: string) => Promise<Array<{ id: string; role: string; text: string; createdAt: number; attachments?: Array<{ mimeType: string; data: string; name?: string; unavailable?: boolean }> }>>;
  /**
   * v0.59 (UI-5): threads — một bot có nhiều hội thoại (IPC
   * `threads:*` trong main.ts; coordinator RPC `listThreads` / ...).
   * `listThreads` luôn trả ít nhất thread mặc định của bot.
   */
  'threads:list'(botId: string): Promise<ThreadItem[]>;
  listThreads: (botId: string) => Promise<ThreadItem[]>;
  'threads:create'(botId: string, title?: string): Promise<ThreadItem>;
  createThread: (botId: string, title?: string) => Promise<ThreadItem>;
  'threads:rename'(threadId: string, title: string): Promise<ThreadItem>;
  renameThread: (threadId: string, title: string) => Promise<ThreadItem>;
  'threads:delete'(threadId: string): Promise<{ deleted: boolean }>;
  deleteThread: (threadId: string) => Promise<{ deleted: boolean }>;
  'threads:search'(payload: { botId?: string; query: string }): Promise<ThreadSearchHit[]>;
  searchThreads: (payload: { botId?: string; query: string }) => Promise<ThreadSearchHit[]>;
  getSettings: () => Promise<unknown>;
  setSettings: (patch: unknown) => Promise<unknown>;
  /**
   * v0.87c: OS notifications — renderer sends a request (main validates
   * + shows the popup); `testNotification` fires the Settings "Send
   * test" sample. Renderer never calls Electron Notification directly.
   * Outcome: { shown, reason?, suppressed?, detail? }.
   */
  sendNotification: (input: {
    kind: string;
    title: string;
    body: string;
    botId?: string;
    dedupeKey?: string;
  }) => Promise<{ shown: boolean; reason?: string; suppressed?: number; detail?: string }>;
  testNotification: (kind?: string) => Promise<{ shown: boolean; reason?: string; suppressed?: number; detail?: string }>;
  // v0.86 (P2-7): crash reporting opt-in — chỉ đọc/xoá report local
  // (đã redact PII). Không có kênh gửi: report không rời khỏi máy.
  listCrashReports: () => Promise<CrashReportSummary[]>;
  getCrashReport: (id: string) => Promise<CrashReport>;
  deleteCrashReport: (id: string) => Promise<{ deleted: boolean }>;
  deleteAllCrashReports: () => Promise<{ deleted: number }>;
  reportRendererError: (input: { message: string; stack?: string }) => Promise<{ saved: boolean; id?: string }>;
  testConnection: (providerId: string) => Promise<{ ok: boolean; error?: string; models?: unknown }>;
  listTasks: (botId: string) => Promise<unknown[]>;
  /**
   * v0.28: trạng thái lưu task A2A — đọc một lần lúc mở app + subscribe
   * để banner cảnh báo cập nhật khi lưu lỗi / hồi phục.
   */
  getA2aPersistStatus: () => Promise<A2aPersistStatus>;
  onA2aPersistStatus: (cb: (payload: A2aPersistStatus) => void) => () => void;
  // v0.86 (P2-6): deep-link `open-bot://` — main đẩy route qua IPC
  // `deep-link:open` (khi renderer đã sẵn) hoặc renderer kéo route
  // đang chờ qua `deep-link:pending` lúc mount (1 lần duy nhất).
  onDeepLink: (cb: (route: DeepLinkRoute) => void) => () => void;
  getPendingDeepLink: () => Promise<DeepLinkRoute | null>;
  /**
   * v0.31 (P1-2): A2A client — agent ngoài mà user đã tin tưởng.
   * `addTrustedA2aAgent` đọc Agent Card rồi mới lưu (URL không phải
   * A2A server thì lỗi, không lưu). Token (nếu có) chỉ dùng cho lần
   * đọc card đó, không lưu. `sendToTrustedA2aAgent` gửi một task thử
   * và đợi tới trạng thái cuối (tối đa 120s).
   */
  listTrustedA2aAgents: () => Promise<TrustedA2aAgent[]>;
  addTrustedA2aAgent: (url: string, token?: string) => Promise<TrustedA2aAgent>;
  removeTrustedA2aAgent: (baseUrl: string) => Promise<TrustedA2aAgent[]>;
  sendToTrustedA2aAgent: (
    baseUrl: string,
    message: string,
    timeoutMs?: number,
  ) => Promise<A2aSendResult>;
  // v0.11: plans stored on disk from earlier sessions (`plans:list` in
  // main.ts reads `<workspace>/.open-bot/plans/*.md`). botId narrows to
  // one bot; omitted = all bots.
  'plans:list'(payload?: { botId?: string }): Promise<StoredPlan[]>;
  listPlans(botId?: string): Promise<StoredPlan[]>;
  // v0.20 (W13a): duyệt plan trực tiếp, không qua tool-call plan_update
  // trong run (không hiện thẻ approval cho hành động duyệt). `note` chỉ
  // dùng cho request-changes.
  'plans:review'(payload: {
    botId: string;
    projectId: string;
    decision: 'approve' | 'reject' | 'request-changes';
    note?: string;
  }): Promise<PlanReviewResult>;
  reviewPlan(payload: {
    botId: string;
    projectId: string;
    decision: 'approve' | 'reject' | 'request-changes';
    note?: string;
  }): Promise<PlanReviewResult>;
  // v0.35 (P1-7): rule auto-approve — user tự cấu hình tool call nào
  // được tự duyệt (coordinator RPC — xem packages/core/src/approval/rules.ts).
  'auto-approve:list'(): Promise<AutoApproveRule[]>;
  listAutoApproveRules(): Promise<AutoApproveRule[]>;
  'auto-approve:add'(rule: AutoApproveRuleInput): Promise<AutoApproveRule>;
  addAutoApproveRule(rule: AutoApproveRuleInput): Promise<AutoApproveRule>;
  'auto-approve:remove'(id: string): Promise<boolean>;
  removeAutoApproveRule(id: string): Promise<boolean>;
  'auto-approve:set-enabled'(id: string, enabled: boolean): Promise<AutoApproveRule>;
  setAutoApproveRuleEnabled(id: string, enabled: boolean): Promise<AutoApproveRule>;
  // v0.3: agent templates + local marketplace.
  listTemplates: () => Promise<unknown[]>;
  cloneAgent: (botId: string, name?: string) => Promise<BotConfig>;
  publishAgent: (botId: string, meta?: { description?: string; author?: string }) => Promise<unknown>;
  listMarketplace: () => Promise<unknown[]>;
  installMarketplace: (id: string) => Promise<BotConfig>;
  uninstallMarketplace: (id: string) => Promise<boolean>;
  // v0.3: MCP marketplace (local catalogue -> workspace mcp.json).
  listMcpMarketplace: () => Promise<unknown[]>;
  listMcpInstalled: (botId: string) => Promise<unknown[]>;
  // v0.67a: probe one catalogue server for its tools (on demand only).
  listMcpServerTools: (id: string) => Promise<unknown>;
  installMcpServer: (
    id: string,
    botId: string,
    args?: string[],
    entry?: unknown,
    version?: string,
  ) => Promise<unknown>;
  uninstallMcpServer: (id: string, botId: string) => Promise<unknown>;
  // v0.89a (Marketplace v2): search / versions / remote catalog / approvals.
  searchMcpMarketplace: (query?: string, tag?: string) => Promise<unknown[]>;
  checkMcpUpdates: (botId: string) => Promise<unknown>;
  updateMcpServer: (id: string, botId: string, version?: string) => Promise<unknown>;
  fetchRemoteMcpCatalog: (url: string) => Promise<unknown[]>;
  approveMarketplace: (
    kind: string,
    targetId: string,
    version?: string,
    source?: string,
  ) => Promise<unknown>;
  listMarketplaceApprovals: () => Promise<unknown[]>;
  // v0.89a (Marketplace v2): plugin marketplace (staging + install/update).
  listPluginMarketplace: () => Promise<unknown[]>;
  searchPluginMarketplace: (query?: string) => Promise<unknown[]>;
  preparePluginInstall: (
    source: { kind: string; url?: string; path?: string },
    opts?: { allowUnsigned?: boolean },
  ) => Promise<unknown>;
  installPluginMarketplace: (stagingId: string, opts?: { allowUnsigned?: boolean }) => Promise<unknown>;
  updatePluginMarketplace: (stagingId: string, opts?: { allowUnsigned?: boolean }) => Promise<unknown>;
  uninstallPluginMarketplace: (id: string) => Promise<unknown>;
  checkPluginUpdates: (entries: unknown[]) => Promise<unknown>;
  // v0.93a: downgrade to the snapshotted previous version + trusted signing keys.
  getPluginDowngradeInfo: (id: string) => Promise<unknown>;
  downgradePluginMarketplace: (id: string) => Promise<unknown>;
  listTrustedMarketplaceKeys: () => Promise<unknown[]>;
  addTrustedMarketplaceKey: (publicKey: string, label?: string) => Promise<unknown>;
  removeTrustedMarketplaceKey: (keyId: string) => Promise<unknown>;
  // v0.3: team (local config file, no central server).
  getTeam: () => Promise<unknown>;
  addTeamMember: (member: { userId: string; name: string; role: string }) => Promise<unknown>;
  removeTeamMember: (userId: string) => Promise<unknown>;
  setTeamRole: (userId: string, role: string) => Promise<unknown>;
  shareBot: (botId: string, sharedBy?: string) => Promise<unknown>;
  unshareBot: (botId: string) => Promise<unknown>;
  listSharedBots: () => Promise<string[]>;
  // v0.80: portable team bundle — export to / import from one JSON file.
  exportTeam: () => Promise<unknown>;
  importTeam: () => Promise<unknown>;
  importTeamApply: (payload: { bundle: TeamBundle; overwrite: boolean }) => Promise<unknown>;
  // v0.50 (M8): group chat bot-bot (IPC `group:*` → coordinator RPC).
  // main unwraps the RPC envelopes so the renderer gets plain arrays.
  createGroupChat: (payload: { name: string; botIds?: string[] }) => Promise<{ group: GroupChat }>;
  listGroupChats: () => Promise<GroupChat[]>;
  addBotToGroupChat: (payload: { groupId: string; botId: string }) => Promise<{ added: boolean }>;
  removeBotFromGroupChat: (payload: { groupId: string; botId: string }) => Promise<{ removed: boolean }>;
  deleteGroupChat: (payload: { groupId: string }) => Promise<{ deleted: boolean }>;
  postGroupMessage: (payload: {
    groupId: string;
    text: string;
    botId?: string;
    // v0.94c: ảnh đính kèm (vision channel — main validate, core
    // validate lại fail-closed). Text được rỗng khi có ảnh.
    attachments?: VisionAttachment[];
  }) => Promise<{ message: GroupMessage; replies: GroupMessage[] }>;
  listGroupMessages: (payload: { groupId: string; limit?: number }) => Promise<GroupMessage[]>;
  // v0.94c: đọc lại bytes một ảnh đính kèm trong message nhóm.
  getGroupAttachment: (payload: {
    groupId: string;
    messageId: string;
    attachmentId: string;
  }) => Promise<{ attachment: VisionAttachment }>;
  // v0.79a: các bot đang chạy trong nhóm (renderer poll trong lúc delegation chạy).
  // v0.82: thêm `interrupted` — bot chạy dở thì app dừng.
  getGroupBotStatus: (payload: { groupId: string }) => Promise<{ groupId: string; running: GroupBotStatusEntry[]; interrupted: GroupBotInterruptedEntry[] }>;
  dismissGroupBotInterrupted: (payload: { groupId: string; botId: string }) => Promise<{ groupId: string; botId: string; dismissed: boolean }>;
  // v0.4: Vault (chỉ tên key, không bao giờ trả secret) + Usage.
  listVaultSecrets: () => Promise<Record<string, string[]>>;
  setVaultSecret: (namespace: string, key: string, value: string) => Promise<boolean>;
  deleteVaultSecret: (namespace: string, key: string) => Promise<boolean>;
  getUsage: (botId?: string) => Promise<unknown>;
  getSpendLimits: () => Promise<unknown>;
  setSpendLimits: (limits: unknown) => Promise<unknown>;
  resetUsage: (scope: 'day' | 'month' | 'all') => Promise<{ removed: number; status: unknown }>;
  // v0.4: skills.
  listSkills: () => Promise<Array<{
    name: string; description: string; version: string; whenToUse: string;
    tools: string[]; source: string; pluginId: string | null; enabled: boolean;
  }>>;
  toggleSkill: (name: string, enabled: boolean) => Promise<boolean>;
  reloadSkills: () => Promise<{ skills: string[]; errors: Array<{ file: string; error: string }> }>;
  // v0.66b: SkillsView — đọc toàn bộ SKILL.md + cài skill mới từ text dán.
  readSkill: (name: string) => Promise<{ name: string; content: string }>;
  installSkill: (name: string, content: string) => Promise<{
    name: string; description: string; version: string; whenToUse: string;
    tools: string[]; source: string; pluginId: string | null; enabled: boolean;
  }>;
  // v0.86c: CanvasView — canvas của 1 bot (IPC `canvas:list` /
  // `canvas:get` / `canvas:delete` / `canvas:open` trong main.ts;
  // type từ core, mirror ở ../renderer/types.ts).
  listCanvases: (botId: string) => Promise<CanvasSummary[]>;
  getCanvas: (botId: string, id: string) => Promise<CanvasDocument>;
  deleteCanvas: (botId: string, id: string) => Promise<{ deleted: boolean }>;
  openCanvasInEditor: (botId: string, id: string) => Promise<{ opened: boolean }>;
  // v0.59 (UI-3): duyệt tool theo bot — màn Tools riêng (IPC
  // `tools:list` / `tools:toggle` trong main.ts; type từ core).
  listBotTools: (botId: string) => Promise<ListBotToolsResult>;
  setBotToolEnabled: (
    botId: string,
    toolName: string,
    enabled: boolean,
  ) => Promise<SetBotToolEnabledResult>;
  // v0.95 (Team D1): Internet data — feeds + watched pages (IPC
  // `internet-data:*` trong main.ts; shapes mirror
  // packages/tools/src/internetData.ts).
  getInternetData: () => Promise<InternetDataState>;
  subscribeInternetFeed: (url: string, title?: string) => Promise<{
    state: InternetDataState;
    added: boolean;
    itemCount: number;
  }>;
  unsubscribeInternetFeed: (feed: string) => Promise<InternetDataState>;
  readInternetFeed: (feed: string, limit?: number) => Promise<{
    feed: InternetFeed;
    title: string;
    items: InternetFeedItem[];
  }>;
  addInternetWatch: (url: string, intervalMinutes?: number) => Promise<{
    state: InternetDataState;
    added: boolean;
    watch: InternetWatch;
  }>;
  removeInternetWatch: (watch: string) => Promise<InternetDataState>;
  checkInternetWatches: (watch?: string) => Promise<{
    state: InternetDataState;
    events: InternetWatchChange[];
  }>;
  onInternetWatchChanged: (
    cb: (payload: { botId: string; url: string; summary: string; checkedAt?: number }) => void,
  ) => () => void;
  // v0.64 (skills per-bot): duyệt skill theo bot — màn Tools riêng
  // (IPC `bot-skills:list` / `bot-skills:toggle` trong main.ts; type
  // từ core). Khác `listSkills` / `toggleSkill` toàn cục ở trên: đây
  // là trạng thái riêng của từng bot (denySkills).
  listBotSkills: (botId: string) => Promise<ListBotSkillsResult>;
  setBotSkillEnabled: (
    botId: string,
    skillName: string,
    enabled: boolean,
  ) => Promise<SetBotSkillEnabledResult>;
  // v0.60 (UI-6): slash commands của bot — popup autocomplete (IPC
  // `slash:list` trong main.ts; tên + mô tả từ registry của coordinator).
  listSlashCommands: (botId: string) => Promise<Array<{ name: string; description: string }>>;  // v0.29 (P0-2): hooks — bật/tắt hook có sẵn trong Settings.
  'hooks:list'(): Promise<Array<{
    name: string; description: string; events: string[]; source: string; enabled: boolean;
  }>>;
  'hooks:toggle'(payload: { name: string; enabled: boolean }): Promise<boolean>;
  listHooks: () => Promise<Array<{
    name: string; description: string; events: string[]; source: string; enabled: boolean;
  }>>;
  toggleHook: (name: string, enabled: boolean) => Promise<boolean>;
  'plugins:list'(): Promise<{
    plugins: Array<{
      id: string; name: string; description: string; version: string;
      author: string | null; enabled: boolean; tools: string[];
    }>;
    errors: Array<{ dir: string; error: string }>;
  }>;
  'plugins:toggle'(payload: { id: string; enabled: boolean }): Promise<{ id: string; enabled: boolean }>;
  listPlugins: () => Promise<{
    plugins: Array<{
      id: string; name: string; description: string; version: string;
      author: string | null; enabled: boolean; tools: string[];
    }>;
    errors: Array<{ dir: string; error: string }>;
  }>;
  togglePlugin: (id: string, enabled: boolean) => Promise<{ id: string; enabled: boolean }>;
  // v0.14: plugin templates (shareable recipes for creating a plugin) +
  // applying a plugin toggle to the currently running bot.
  'plugin-templates:list'(): Promise<PluginTemplate[]>;
  'plugin-templates:create'(input: CreatePluginTemplateInput): Promise<PluginTemplate>;
  'plugin-templates:apply'(payload: { id: string; overwrite?: boolean }): Promise<AppliedPluginTemplate>;
  'plugin-templates:export'(payload: { id: string }): Promise<{ id: string; json: string }>;
  'plugin-templates:import'(payload: { json: string }): Promise<PluginTemplate>;
  'plugin-templates:delete'(payload: { id: string }): Promise<boolean>;
  'plugin:set-enabled'(payload: { botId?: string | null; pluginId: string; enabled: boolean }): Promise<{
    id: string; enabled: boolean; appliedToRunning: boolean; runningError?: string;
  }>;
  // v0.14: camelCase aliases (same channels).
  listPluginTemplates: () => Promise<PluginTemplate[]>;
  createPluginTemplate: (input: CreatePluginTemplateInput) => Promise<PluginTemplate>;
  applyPluginTemplate: (payload: { id: string; overwrite?: boolean }) => Promise<AppliedPluginTemplate>;
  exportPluginTemplate: (payload: { id: string }) => Promise<{ id: string; json: string }>;
  importPluginTemplate: (payload: { json: string }) => Promise<PluginTemplate>;
  deletePluginTemplate: (payload: { id: string }) => Promise<boolean>;
  setPluginEnabled: (payload: { botId?: string | null; pluginId: string; enabled: boolean }) => Promise<{
    id: string; enabled: boolean; appliedToRunning: boolean; runningError?: string;
  }>;
  // v0.4: automations.
  listAutomations: () => Promise<unknown[]>;
  getAutomation: (id: string) => Promise<unknown>;
  createAutomation: (automation: unknown) => Promise<unknown>;
  updateAutomation: (automation: unknown) => Promise<unknown>;
  deleteAutomation: (id: string) => Promise<boolean>;
  setAutomationEnabled: (id: string, enabled: boolean) => Promise<unknown>;
  runAutomationNow: (id: string) => Promise<unknown>;
  listAutomationRuns: (automationId?: string) => Promise<unknown[]>;
  // v0.74d: nạp dữ liệu mẫu (SAMPLE_AUTOMATIONS) vào store thật qua
  // IPC `automations:seed-samples`; sample đã có sẵn được bỏ qua.
  seedSampleAutomations: () => Promise<{ created: unknown[]; skipped: string[] }>;
  // v0.52 P0-5: webhook trigger keys + delivery + retry-run.
  // create/rotate return { keyId, secret } with the secret shown once only.
  createAutomationWebhookKey: (id: string) => Promise<{ keyId: string; secret: string }>;
  rotateAutomationWebhookKey: (id: string) => Promise<{ keyId: string; secret: string }>;
  deleteAutomationWebhookKey: (id: string) => Promise<boolean>;
  hasAutomationWebhookKey: (id: string) => Promise<boolean>;
  invokeAutomationWebhook: (id: string, body: string, signature?: string | null) => Promise<unknown>;
  testAutomationWebhook: (id: string, payload?: unknown) => Promise<unknown>;
  retryAutomationRun: (runId: string) => Promise<unknown>;
  retryLastFailedAutomationRun: (automationId: string) => Promise<unknown>;
  // v0.83b: Composio trigger — defs for the picker + signing secret
  // (pasted by the user, never returned) + URL token (create/rotate
  // return { keyId, secret } shown once only) + mock test delivery.
  listComposioTriggerDefs: () => Promise<Array<{ toolkit: string; slug: string; name: string; delivery: string }>>;
  setComposioTriggerSecret: (id: string, secret: string) => Promise<{ ok: boolean }>;
  hasComposioTriggerSecret: (id: string) => Promise<boolean>;
  deleteComposioTriggerSecret: (id: string) => Promise<boolean>;
  createComposioTriggerToken: (id: string) => Promise<{ keyId: string; secret: string }>;
  rotateComposioTriggerToken: (id: string) => Promise<{ keyId: string; secret: string }>;
  hasComposioTriggerToken: (id: string) => Promise<boolean>;
  deleteComposioTriggerToken: (id: string) => Promise<boolean>;
  testComposioTrigger: (id: string, data?: unknown) => Promise<unknown>;
  // v0.87a (P2-2): Slack inbound — signing secret (pasted by the
  // user, never returned) + mock test delivery of a Slack message.
  setSlackSigningSecret: (id: string, secret: string) => Promise<{ ok: boolean }>;
  hasSlackSigningSecret: (id: string) => Promise<boolean>;
  deleteSlackSigningSecret: (id: string) => Promise<boolean>;
  testSlackInbound: (id: string, opts?: { text?: string; channelType?: string }) => Promise<unknown>;
  // v0.4: dream.
  getDream: () => Promise<{ enabled: boolean; idleMinutes?: number; cheapestModel?: string }>;
  setDream: (config: { enabled: boolean; idleMinutes?: number }) => Promise<unknown>;
  // v0.4: notification từ automation/dream (main -> renderer, 1 chiều).
  onAutomationNotify: (cb: (payload: { message: string; at: number }) => void) => () => void;
  // v0.66a: run automation thay đổi (bắt đầu/xong) — AutomationsView
  // subscribe để tự refresh lịch sử chạy mà không cần vào lại view.
  onAutomationRunsChanged: (
    cb: (payload: { runId: string; automationId: string; status: string }) => void,
  ) => () => void;
  // v0.4: voice.
  voiceAvailable: (botId: string) => Promise<{ available: boolean }>;
  voiceConnect: (botId: string) => Promise<{ ok: boolean; error?: string }>;
  voiceSendAudio: (botId: string, audioBase64: string) => void;
  voiceCommit: (botId: string) => Promise<{ ok: boolean; error?: string }>;
  voiceDisconnect: (botId: string) => Promise<{ ok: boolean }>;
  transcribeMemo: (botId: string, audioBase64: string) => Promise<{ ok: boolean; text?: string; error?: string }>;
  // v0.81: TTS (local-first) — read an answer aloud via the system
  // speech engine when one is installed; no paid service, no key.
  getTtsStatus: () => Promise<{ available: boolean; engineId: string | null; engines: Array<{ id: string; name: string; kind: string; available: boolean }> }>;
  listTtsVoices: (lang?: string) => Promise<Array<{ id: string; name: string; lang: string }>>;
  speakText: (text: string, lang?: string, opts?: { voice?: string; rate?: number }) => Promise<{ spoken: boolean; engineId: string | null; reason?: string }>;
  // v0.83: TTS stop — kill the utterance still speaking, if any.
  stopTts: () => Promise<{ stopped: boolean; engineId: string | null }>;
  // v0.56: voice:surface — surface register (màn hình user đang nhìn
  // trong lúc gọi voice) + STT dictation PCM16 một lần.
  voiceSurfaceRegister: (
    botId: string,
    surface: string,
    view?: string,
  ) => Promise<{ ok: boolean; surfaceId?: string; surface?: string; maxReplyChars?: number; error?: string }>;
  voiceSurfaceUnregister: (surfaceId: string) => Promise<{ ok: boolean; error?: string }>;
  voiceSurfaceList: (botId?: string) => Promise<{ ok: boolean; surfaces?: unknown[]; error?: string }>;
  voiceDictation: (botId: string, audioBase64: string) => Promise<{ ok: boolean; text?: string; error?: string }>;
  onVoiceTranscript: (cb: (payload: { botId: string; text: string; isFinal: boolean; surface?: string; surfaceIds?: string[] }) => void) => () => void;
  onVoiceAudio: (cb: (payload: { botId: string; audioBase64: string; surface?: string; surfaceIds?: string[] }) => void) => () => void;
  onVoiceError: (cb: (payload: { botId: string; message: string; surface?: string; surfaceIds?: string[] }) => void) => () => void;
  onVoiceToolCall: (cb: (payload: { botId: string; call: unknown; outcome?: unknown; surface?: string; surfaceIds?: string[] }) => void) => () => void;
  onVoiceSurface: (cb: (payload: { botId: string; surfaces: unknown[]; surface: string; surfaceIds: string[] }) => void) => () => void;
  // v0.95 (Đội D3): voice realtime 2 chiều (RealtimeSession).
  voiceRealtimeConnect: (
    botId: string,
    provider?: string,
    turnMode?: string,
  ) => Promise<{ ok: boolean; provider?: string; turnMode?: string; state?: string; error?: string }>;
  voiceRealtimeDisconnect: (botId: string) => Promise<{ ok: boolean }>;
  voiceRealtimeMode: (botId: string, turnMode: string) => Promise<{ ok: boolean; turnMode?: string; error?: string }>;
  voiceRealtimeTalk: (botId: string, held: boolean) => Promise<{ ok: boolean; applied?: boolean; talkHeld?: boolean; error?: string }>;
  voiceRealtimeInterrupt: (botId: string) => Promise<{ ok: boolean; interrupted?: boolean; error?: string }>;
  voiceRealtimeSendAudio: (botId: string, audioBase64: string) => void;
  onVoiceRealtimeState: (
    cb: (payload: { botId: string; kind: string; state?: string; source?: string; speaker?: string; at?: number }) => void,
  ) => () => void;
  // v0.4: hiệu năng.
  getPerfStats: () => Promise<{ ok: boolean; pool?: unknown; cache?: unknown }>;
  clearCache: () => Promise<{ ok: boolean; error?: string }>;
  // v0.10: run tracing (JSONL spans per run; main only reads the file).
  'traces:list'(filter?: { botId?: string; runId?: string; limit?: number }): Promise<TraceSummary[]>;
  'traces:get'(query: { traceId?: string; runId?: string }): Promise<Trace | null>;
  listTraces: (filter?: { botId?: string; runId?: string; limit?: number }) => Promise<TraceSummary[]>;
  getTrace: (query: { traceId?: string; runId?: string }) => Promise<Trace | null>;
  // v0.5: model registry, local API, team workspace, service accounts,
  // Vault NO_STORAGE. Method names are the IPC channel names (quoted
  // because of the colon); camelCase aliases exist so the renderer's
  // callOpenBot(channel, camel) fallback also resolves.
  'models:list'(): Promise<unknown>;
  'models:set-feature'(payload: { feature: string; providerId: string; model: string }): Promise<unknown>;
  'models:set-default'(payload: { providerId: string; model: string }): Promise<unknown>;
  'models:set-fallback'(payload: { providerId: string; model: string }): Promise<unknown>;
  'models:set-flag'(payload: { name: string; enabled: boolean }): Promise<unknown>;
  'models:ollama-list'(): Promise<string[]>;
  'models:ollama-pull'(model: string): Promise<{ ok: boolean; error?: string }>;
  'api:get'(): Promise<unknown>;
  'api:set'(patch: { enabled?: boolean; port?: number }): Promise<unknown>;
  'api:get-token'(): Promise<{ token: string | null }>;
  'api:regenerate-token'(): Promise<{ token: string }>;
  'api:webhooks-list'(): Promise<unknown[]>;
  'api:webhooks-add'(payload: { url: string; events: string[] }): Promise<unknown>;
  'api:webhooks-remove'(id: string): Promise<boolean>;
  'team:get-workspace'(): Promise<{ dir: string; teamId: string }>;
  'team:set-workspace-dir'(dir: string): Promise<{ dir: string; teamId: string }>;
  'team:service-accounts-list'(): Promise<unknown[]>;
  'team:service-account-create'(payload: { name: string; scope: string }): Promise<unknown>;
  'team:service-account-delete'(id: string): Promise<boolean>;
  // Sóng B (đội platform): máy tính riêng cho từng bot (IPC `computers:*`).
  'computers:probe'(): Promise<{ profile: MachineProfile; backends: ComputerBackend[]; busy: boolean; busyReason?: string }>;
  'computers:plan'(payload: { botIds: string[] }): Promise<ComputerPlan>;
  'computers:create'(payload: { botIds: string[] }): Promise<ComputerStatusView[]>;
  'computers:list'(): Promise<ComputerStatusView[]>;
  'computers:start'(botId: string): Promise<ComputerStatusView>;
  'computers:pause'(botId: string): Promise<ComputerStatusView>;
  'computers:resume'(botId: string): Promise<ComputerStatusView>;
  'computers:stop'(botId: string): Promise<ComputerStatusView>;
  'computers:set-vm-image'(payload: { botId: string; imagePath: string }): Promise<ComputerStatusView>;
  'computers:set-vm-network'(payload: { botId: string; network: 'none' | 'nat' }): Promise<ComputerStatusView>;
  'computers:shed'(): Promise<{ paused: string[] }>;
  // v0.90c (đội G gói C): hàng đợi scheduler + auto-shed + sức khoẻ guest.
  'computers:queue'(): Promise<ComputerSchedulerState>;
  'computers:set-priority'(payload: { botId: string; priority: number }): Promise<ComputerSchedulerState>;
  'computers:set-auto-shed'(payload: { enabled: boolean }): Promise<ComputerSchedulerState>;
  'computers:guest-health'(botId: string): Promise<GuestAgentHealth>;
  // Sóng B: camelCase aliases (same channels).
  probeComputers: () => Promise<{ profile: MachineProfile; backends: ComputerBackend[]; busy: boolean; busyReason?: string }>;
  planComputers: (payload: { botIds: string[] }) => Promise<ComputerPlan>;
  createComputers: (payload: { botIds: string[] }) => Promise<ComputerStatusView[]>;
  listComputers: () => Promise<ComputerStatusView[]>;
  startComputer: (botId: string) => Promise<ComputerStatusView>;
  pauseComputer: (botId: string) => Promise<ComputerStatusView>;
  resumeComputer: (botId: string) => Promise<ComputerStatusView>;
  stopComputer: (botId: string) => Promise<ComputerStatusView>;
  setComputerVmImage: (payload: { botId: string; imagePath: string }) => Promise<ComputerStatusView>;
  setComputerVmNetwork: (payload: { botId: string; network: 'none' | 'nat' }) => Promise<ComputerStatusView>;
  shedComputers: () => Promise<{ paused: string[] }>;
  // v0.90c (đội G gói C): camelCase aliases (same channels).
  getComputerQueue: () => Promise<ComputerSchedulerState>;
  setComputerPriority: (payload: { botId: string; priority: number }) => Promise<ComputerSchedulerState>;
  setComputerAutoShed: (payload: { enabled: boolean }) => Promise<ComputerSchedulerState>;
  checkComputerGuestHealth: (botId: string) => Promise<GuestAgentHealth>;
  // Đội D (fleet): tầng fleet đa người dùng (IPC `fleet:*`).
  'fleet:list'(): Promise<FleetStatusView[]>;
  'fleet:status'(id: string): Promise<FleetStatusView>;
  'fleet:create'(payload: CreateFleetWorkspaceInput): Promise<FleetWorkspace>;
  'fleet:remove'(payload: { id: string; deleteData?: boolean }): Promise<{ removed: boolean }>;
  'fleet:rename'(payload: { id: string; name: string }): Promise<FleetWorkspace>;
  'fleet:suspend'(id: string): Promise<FleetWorkspace>;
  'fleet:activate'(id: string): Promise<FleetWorkspace>;
  'fleet:start'(id: string): Promise<FleetStatusView>;
  'fleet:stop'(id: string): Promise<FleetStatusView>;
  'fleet:restart'(id: string): Promise<FleetStatusView>;
  'fleet:health'(id: string): Promise<{ uptimeMs: number; pid: number }>;
  'fleet:capacity'(payload: { cpuCores?: number; ramBytes?: number; diskBytes?: number }): Promise<FleetCapacityCheck>;
  'fleet:audit'(payload?: { actor?: string; action?: string; target?: string; since?: number; until?: number }): Promise<AuditEvent[]>;
  'fleet:audit-verify'(): Promise<AuditVerifyResult>;
  'fleet:decisions'(payload?: { actor?: string; action?: string; target?: string; decision?: 'allow' | 'deny'; since?: number; until?: number }): Promise<FleetDecision[]>;
  'fleet:decisions-verify'(): Promise<AuditVerifyResult>;
  'fleet:usage'(id: string): Promise<FleetUsageSummary | null>;
  'fleet:record-usage'(id: string): Promise<FleetUsageSummary | null>;
  'fleet:add-member'(payload: { id: string; userId: string; role: FleetRole }): Promise<FleetWorkspace>;
  'fleet:remove-member'(payload: { id: string; userId: string }): Promise<FleetWorkspace>;
  'fleet:set-member-role'(payload: { id: string; userId: string; role: FleetRole }): Promise<FleetWorkspace>;
  // Đội D: camelCase aliases (same channels).
  listFleet: () => Promise<FleetStatusView[]>;
  getFleetStatus: (id: string) => Promise<FleetStatusView>;
  createFleetWorkspace: (payload: CreateFleetWorkspaceInput) => Promise<FleetWorkspace>;
  removeFleetWorkspace: (payload: { id: string; deleteData?: boolean }) => Promise<{ removed: boolean }>;
  renameFleetWorkspace: (payload: { id: string; name: string }) => Promise<FleetWorkspace>;
  suspendFleetWorkspace: (id: string) => Promise<FleetWorkspace>;
  activateFleetWorkspace: (id: string) => Promise<FleetWorkspace>;
  startFleetService: (id: string) => Promise<FleetStatusView>;
  stopFleetService: (id: string) => Promise<FleetStatusView>;
  restartFleetService: (id: string) => Promise<FleetStatusView>;
  healthFleetService: (id: string) => Promise<{ uptimeMs: number; pid: number }>;
  checkFleetCapacity: (payload: { cpuCores?: number; ramBytes?: number; diskBytes?: number }) => Promise<FleetCapacityCheck>;
  listFleetAudit: (payload?: { actor?: string; action?: string; target?: string; since?: number; until?: number }) => Promise<AuditEvent[]>;
  verifyFleetAudit: () => Promise<AuditVerifyResult>;
  listFleetDecisions: (payload?: { actor?: string; action?: string; target?: string; decision?: 'allow' | 'deny'; since?: number; until?: number }) => Promise<FleetDecision[]>;
  verifyFleetDecisions: () => Promise<AuditVerifyResult>;
  getFleetUsage: (id: string) => Promise<FleetUsageSummary | null>;
  recordFleetUsage: (id: string) => Promise<FleetUsageSummary | null>;
  addFleetMember: (payload: { id: string; userId: string; role: FleetRole }) => Promise<FleetWorkspace>;
  removeFleetMember: (payload: { id: string; userId: string }) => Promise<FleetWorkspace>;
  setFleetMemberRole: (payload: { id: string; userId: string; role: FleetRole }) => Promise<FleetWorkspace>;
  'vault:get-nostorage'(): Promise<{ enabled: boolean; pendingSecrets: number }>;
  // v0.15 (L5 audit): opts.discardTemporarySecrets = true để xoá
  // secret tạm thay vì flush khi tắt NO_STORAGE. Trả về số secret
  // tạm đã bị ảnh hưởng bởi lần tắt này.
  'vault:set-nostorage'(
    enabled: boolean,
    opts?: { discardTemporarySecrets?: boolean },
  ): Promise<{ enabled: boolean; pendingSecrets: number }>;
  // v0.5: camelCase aliases (same channels).
  listModels: () => Promise<unknown>;
  // M4: provider rail cho ModelPicker (IPC 'models:rail').
  // v0.90b: payload tuỳ chọn lọc rail theo bot (nguồn tắt riêng cho
  // bot + provider hiện tại) — không truyền = rail toàn cục như trước.
  'models:rail'(payload?: {
    disabledProviders?: string[];
    currentProviderId?: string;
  }): Promise<unknown>;
  listModelRail: (payload?: {
    disabledProviders?: string[];
    currentProviderId?: string;
  }) => Promise<unknown>;
  setModelFeature: (payload: { feature: string; providerId: string; model: string }) => Promise<unknown>;
  setDefaultModel: (payload: { providerId: string; model: string }) => Promise<unknown>;
  setFallbackModel: (payload: { providerId: string; model: string }) => Promise<unknown>;
  setFeatureFlag: (payload: { name: string; enabled: boolean }) => Promise<unknown>;
  listOllamaModels: () => Promise<string[]>;
  pullOllamaModel: (model: string) => Promise<{ ok: boolean; error?: string }>;
  // M1: detected CLI engines (Settings → Engines). Method names are the
  // IPC channel names; camelCase aliases exist for the renderer's
  // callOpenBot(channel, camel) fallback.
  'engines:list'(): Promise<unknown>;
  'engines:redetect'(): Promise<unknown>;
  // M4: quét lại chỉ một engine (nút Re-detect từng engine).
  'engines:redetect-one'(payload: { kind: string }): Promise<unknown>;
  'engines:set-enabled'(payload: { kind: string; enabled: boolean }): Promise<unknown>;
  // M3: custom ACP CLI ("Set CLI…" in Settings → Engines).
  'engines:custom-list'(): Promise<unknown>;
  'engines:custom-add'(payload: {
    id: string;
    label: string;
    binaryPath: string;
    acpArgs: string[];
    statusArgs?: string[];
  }): Promise<unknown>;
  'engines:custom-update'(payload: {
    id: string;
    label?: string;
    binaryPath?: string;
    acpArgs?: string[];
    statusArgs?: string[];
  }): Promise<unknown>;
  'engines:custom-remove'(payload: { id: string }): Promise<unknown>;
  listEngines: () => Promise<unknown>;
  redetectEngines: () => Promise<unknown>;
  redetectEngine: (payload: { kind: string }) => Promise<unknown>;
  setEngineEnabled: (payload: { kind: string; enabled: boolean }) => Promise<unknown>;
  listCustomClis: () => Promise<unknown>;
  addCustomCli: (payload: {
    id: string;
    label: string;
    binaryPath: string;
    acpArgs: string[];
    statusArgs?: string[];
  }) => Promise<unknown>;
  updateCustomCli: (payload: {
    id: string;
    label?: string;
    binaryPath?: string;
    acpArgs?: string[];
    statusArgs?: string[];
  }) => Promise<unknown>;
  removeCustomCli: (payload: { id: string }) => Promise<unknown>;
  onEnginesChanged: (cb: (snapshot: unknown) => void) => () => void;
  getApiStatus: () => Promise<unknown>;
  setApiStatus: (patch: { enabled?: boolean; port?: number }) => Promise<unknown>;
  getApiToken: () => Promise<{ token: string | null }>;
  regenerateApiToken: () => Promise<{ token: string }>;
  listWebhooks: () => Promise<unknown[]>;
  addWebhook: (payload: { url: string; events: string[] }) => Promise<unknown>;
  removeWebhook: (id: string) => Promise<boolean>;
  getTeamWorkspace: () => Promise<{ dir: string; teamId: string }>;
  setTeamWorkspaceDir: (dir: string) => Promise<{ dir: string; teamId: string }>;
  listServiceAccounts: () => Promise<unknown[]>;
  createServiceAccount: (payload: { name: string; scope: string }) => Promise<unknown>;
  deleteServiceAccount: (id: string) => Promise<boolean>;
  getVaultNoStorage: () => Promise<{ enabled: boolean; pendingSecrets: number }>;
  setVaultNoStorage: (
    enabled: boolean,
    opts?: { discardTemporarySecrets?: boolean },
  ) => Promise<{ enabled: boolean; pendingSecrets: number }>;
  // v0.7: đăng nhập đa tầng (tài khoản local + định danh provider),
  // OAuth qua trình duyệt, tự cập nhật (chỉ check + thông báo).
  'auth:profile-get'(): Promise<{ userId: string; displayName: string; createdAt: number }>;
  'auth:profile-set'(payload: { displayName?: string }): Promise<{ userId: string; displayName: string; createdAt: number }>;
  'auth:identities-list'(): Promise<Array<{ providerId: string; identity: { id: string; displayName?: string; email?: string; updatedAt: number } | null }>>;
  'auth:identity-delete'(payload: { providerId: string }): Promise<boolean>;
  'auth:oauth-supported'(): Promise<Array<{ id: string; label: string }>>;
  'auth:oauth-start'(payload: { providerId: string; clientId?: string; clientSecret?: string; connectorId?: string }): Promise<{ ok: boolean; providerId: string; displayName?: string; error?: string }>;
  // M7: connected apps — catalog + trạng thái auth + ngắt kết nối.
  'apps:list'(): Promise<AppStatusView[]>;
  'apps:disconnect'(payload: { appId: string }): Promise<AppStatusView[]>;
  // v0.68b: M7 app token (PAT dán tay, vd GitHub) — lưu token thô vào Vault, không trả về renderer.
  'apps:set-token'(payload: { appId: string; token: string }): Promise<AppStatusView[]>;
  // v0.53 (P1-6): 1Password broker (out-of-process) — status không chứa
  // secret; import-field ghi thẳng 1 field vào Vault ở main, chỉ trả {stored}.
  // v0.59: status kèm cờ `enabled`; `set-enabled` bật/tắt broker.
  'onepassword:status'(): Promise<OnePasswordBrokerStatus & { enabled: boolean }>;
  'onepassword:set-enabled'(payload: { enabled: boolean }): Promise<{ enabled: boolean }>;
  'onepassword:import-field'(payload: { itemId: string; field: string; namespace: string; key: string; saveToVault?: boolean }): Promise<{ stored: boolean }>;
  'update:check'(): Promise<{ available: boolean; currentVersion: string; latestVersion: string | null; latestTag: string | null; htmlUrl: string | null; checkFailed: boolean; error?: string }>;
  'update:open-download'(payload: { url: string }): Promise<boolean>;
  /**
   * v0.54 (P1-9): update theo track (UpdateService trong main) — trạng
   * thái đầy đủ gồm track, feedStatus (`github-releases-list` cho track
   * ngoài stable từ v0.59; `stub-no-feed` chỉ khi feed chưa được cấu
   * hình), cờ update_required/min_client_version. `quitAndInstall`
   * luôn trả installed:false cho tới khi có cơ chế cài thật.
   */
  getUpdateStatus: () => Promise<UpdateStatusView>;
  setUpdateTrack: (track: string) => Promise<UpdateStatusView>;
  checkForUpdates: (trigger?: 'startup' | 'periodic' | 'manual') => Promise<UpdateStatusView>;
  quitAndInstallUpdate: () => Promise<{ installed: boolean; reason: string }>;
  /**
   * v0.54 (P1-8): checkpoint/resume + interrupt HITL cho run dài.
   * `onInterruptNeeded` nhận event `interrupt-needed` từ coordinator
   * (run dừng ở biên an toàn); renderer hiện InterruptCard và trả lời
   * qua `respondInterrupt`. `listBotCheckpoints` liệt kê checkpoint để
   * UI resume/time-travel; `replayRun` chạy lại từ checkpoint cũ.
   */
  onInterruptNeeded: (cb: (payload: InterruptRequestView) => void) => () => void;
  respondInterrupt: (requestId: string, decision: InterruptDecisionView) => void;
  listBotCheckpoints: (botId: string) => Promise<{ botId: string; runs: Array<{ runId: string; checkpoints: CheckpointSummaryView[] }> }>;
  interruptRun: (runId: string, question?: string) => Promise<{ runId: string; accepted: boolean; reason?: string }>;
  replayRun: (botId: string, runId: string, stepIndex?: number | 'latest') => Promise<{ botId: string; text: string; stopped: boolean; runId?: string; replayedFromStep: number }>;
  /** v0.54 (P1-10): renderer báo telemetry `client_persistence` về main (chỉ log). */
  reportClientPersistence: (report: { storeKey: string; operation: string; error: string; at: string }) => void;
  // v0.7: camelCase aliases (same channels).
  getLocalProfile: () => Promise<{ userId: string; displayName: string; createdAt: number }>;
  setLocalProfile: (displayName: string) => Promise<{ userId: string; displayName: string; createdAt: number }>;
  // v0.95d4 (Đội D4): user profile đầy đủ (tên, cách xưng hô, sở thích,
  // thói quen, facts) + long-term memory — tất cả local, IPC
  // `profile:get` / `profile:update` / `memory:*` trong main.ts.
  getUserProfile: () => Promise<UserProfileView | null>;
  updateUserProfile: (patch: UserProfilePatch) => Promise<UserProfileView>;
  listMemories: (payload: { botId: string; query?: string; tag?: string; limit?: number }) => Promise<MemoryEntryView[]>;
  updateMemory: (payload: { botId: string; id: string; value?: string; tags?: string[]; confidence?: number }) => Promise<MemoryEntryView>;
  deleteMemory: (payload: { botId: string; id: string }) => Promise<{ deleted: boolean }>;
  exportMemories: (payload: { botId: string }) => Promise<string>;
  getMemoryStatus: (payload: { botId: string }) => Promise<{ total: number; embedded: number; ollamaAvailable: boolean; embeddingModel: string }>;
  listProviderIdentities: () => Promise<Array<{ providerId: string; identity: { id: string; displayName?: string; email?: string; updatedAt: number } | null }>>;
  deleteProviderIdentity: (providerId: string) => Promise<boolean>;
  listOAuthProviders: () => Promise<Array<{ id: string; label: string }>>;
  startOAuthLogin: (providerId: string, clientId?: string, clientSecret?: string, connectorId?: string) => Promise<{ ok: boolean; providerId: string; displayName?: string; error?: string }>;
  // M7: connected apps (camelCase aliases, same channels as above).
  listConnectedApps: () => Promise<AppStatusView[]>;
  disconnectConnectedApp: (appId: string) => Promise<AppStatusView[]>;
  // v0.68b: M7 app token (PAT dán tay) — camelCase alias of 'apps:set-token'.
  setConnectedAppToken: (appId: string, token: string) => Promise<AppStatusView[]>;
  // v0.57: Composio — opt-in, key chỉ nằm trong Vault (không trả về renderer).
  getComposioState: () => Promise<ComposioStateView>;
  setComposioEnabled: (enabled: boolean) => Promise<ComposioStateView>;
  setComposioAppEnabled: (toolkit: string, enabled: boolean) => Promise<ComposioStateView>;
  setComposioKey: (apiKey: string) => Promise<ComposioStateView>;
  clearComposioKey: () => Promise<ComposioStateView>;
  // v0.88b: Composio user id — opt-in, chỉ vào Vault (không trả về renderer).
  setComposioUserId: (userId: string) => Promise<ComposioStateView>;
  clearComposioUserId: () => Promise<ComposioStateView>;
  // v0.95 (Team D2): Media keys — opt-in (key chỉ vào Vault, không trả về
  // renderer; get-status chỉ trả {configured, suffix}).
  getMediaKeyStatus: () => Promise<Record<string, { configured: boolean; suffix: string | null }>>;
  setMediaKey: (providerId: string, apiKey: string) => Promise<Record<string, { configured: boolean; suffix: string | null }>>;
  clearMediaKey: (providerId: string) => Promise<Record<string, { configured: boolean; suffix: string | null }>>;
  // v0.89c (Team E): trạng thái connection từng toolkit (chỉ toolkit +
  // trạng thái + nhãn tài khoản; không chứa user id, link OAuth hay key).
  getComposioConnectionStatus: (toolkits?: string[]) => Promise<ComposioToolkitConnection[]>;
  // v0.53 (P1-6): 1Password broker (camelCase aliases, same channels as above).
  // v0.59: `setOnePasswordEnabled` bật/tắt broker.
  onePasswordStatus: () => Promise<OnePasswordBrokerStatus & { enabled: boolean }>;
  setOnePasswordEnabled: (enabled: boolean) => Promise<{ enabled: boolean }>;
  onePasswordImportField: (payload: { itemId: string; field: string; namespace: string; key: string; saveToVault?: boolean }) => Promise<{ stored: boolean }>;
  checkForUpdate: () => Promise<{ available: boolean; currentVersion: string; latestVersion: string | null; latestTag: string | null; htmlUrl: string | null; checkFailed: boolean; error?: string }>;
  openUpdateDownload: (url: string) => Promise<boolean>;
}

/**
 * L1 (audit bảo mật v0.15): allowlist các channel main -> renderer mà
 * preload được phép subscribe. Liệt kê đúng các channel main thực sự
 * gửi (sendToRenderer + webContents.send trong main.ts) và renderer
 * thực sự subscribe — 15 channel dưới đây. Channel lạ (VD: renderer
 * bị XSS chèn subscribe tới channel khác, hoặc main gửi nhầm) thì bỏ
 * qua + cảnh báo stderr, KHÔNG throw để không crash renderer.
 */
const ALLOWED_SUBSCRIBE_CHANNELS: ReadonlySet<string> = new Set([
  'chat:delta',
  'chat:toolcall',
  'chat:toolresult',
  'chat:approval-needed',
  // v0.50 (M8): permission từ CLI engine qua harness broker.
  'chat:harness-permission-needed',
  // v0.90a (Đội G): live event harness đã sanitize (EventLogView).
  'harness:event',
  'chat:ask-user',
  // v0.54 (P1-8): run dừng ở điểm interrupt để hỏi user (HITL).
  'chat:interrupt-needed',
  'chat:elicitation-needed',
  'chat:progress',
  'chat:summary',
  'bots:changed',
  'automation:notify',
  // v0.66a: scheduler báo run thay đổi để AutomationsView tự refresh.
  'automation:runs-changed',
  'voice:transcript',
  'voice:audio',
  'voice:error',
  'voice:toolcall',
  // v0.95 (Đội D3): realtime session state / interruption / turn
  // events (main forward từ RealtimeSession).
  'voice:realtime-state',
  // v0.56: surface register của voice call (main đẩy danh sách
  // surface đang đăng ký của bot).
  'voice:surface',
  // v0.28: A2A task persistence status (main pushes on save failure / recovery).
  'a2a:persist-status',
  // v0.95 (Team D1): a watched page changed (main pushes on
  // `internet.watch-changed` from the coordinator or a UI check).
  'internet:watch-changed',
  // v0.86 (P2-6): deep-link `open-bot://` — main đẩy route cho renderer.
  'deep-link:open',
  // M3: main pushes a fresh engines snapshot after redetect, toggle,
  // or a custom CLI change so the BotForm picker refreshes live.
  'engines:changed',
]);

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  if (!ALLOWED_SUBSCRIBE_CHANNELS.has(channel)) {
    // Cảnh báo stderr (preload chạy trong renderer process; console
    // ở đây đi ra terminal của Electron) rồi trả về no-op unsubscribe.
    console.warn(`[open-bot preload] Bỏ qua subscribe tới channel IPC lạ: ${channel}`);
    return () => undefined;
  }
  const listener = (_event: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener as never);
  return () => {
    ipcRenderer.removeListener(channel, listener as never);
  };
}

const openBot: OpenBotApi = {
  listBots: () => ipcRenderer.invoke('bots:list'),
  createBot: (config) => ipcRenderer.invoke('bots:create', config),
  updateBot: (config) => ipcRenderer.invoke('bots:update', config),
  deleteBot: (botId) => ipcRenderer.invoke('bots:delete', botId),
  // M4: đổi model giữa chừng (không mất thread).
  'bots:switch-model': (payload) => ipcRenderer.invoke('bots:switch-model', payload),
  switchModel: (payload) => ipcRenderer.invoke('bots:switch-model', payload),
  sendChat: (botId, text, threadId, attachments) => ipcRenderer.invoke('chat:send', { botId, text, threadId, attachments }),
  // v0.59 (UI-2): stop the bot's current chat run.
  stopChat: (botId) => ipcRenderer.invoke('chat:stop', { botId }),
  onChatDelta: (cb) => subscribe('chat:delta', cb),
  onToolCall: (cb) => subscribe('chat:toolcall', cb),
  onToolResult: (cb) => subscribe('chat:toolresult', cb),
  onApprovalNeeded: (cb) => subscribe('chat:approval-needed', cb),
  respondApproval: (callId, approved, args?) =>
    ipcRenderer.send('chat:approval-response', { callId, approved, args }),
  onHarnessPermissionNeeded: (cb) => subscribe('chat:harness-permission-needed', cb),
  respondHarnessPermission: (requestId, allowed) =>
    ipcRenderer.send('chat:harness-permission-response', { requestId, allowed }),
  // v0.90a (Đội G): harness event log — status + NDJSON log + live event.
  'harness:status': () => ipcRenderer.invoke('harness:status'),
  getHarnessStatus: () => ipcRenderer.invoke('harness:status'),
  'harness:thread-log': (query) => ipcRenderer.invoke('harness:thread-log', query),
  getHarnessThreadLog: (query) => ipcRenderer.invoke('harness:thread-log', query),
  onHarnessEvent: (cb) => subscribe('harness:event', cb),
  onBotsChanged: (cb) => subscribe('bots:changed', cb),
  onAskUser: (cb) => subscribe('chat:ask-user', cb),
  respondAskUser: (requestId, answer) =>
    ipcRenderer.send('chat:ask-user-response', { requestId, answer }),
  // v0.13: MCP elicitation (main forwards `mcp.elicitation-needed`).
  onElicitation: (cb) => subscribe('chat:elicitation-needed', cb),
  respondElicitation: (elicitationId, result) =>
    ipcRenderer.send('chat:elicitation-response', { elicitationId, result }),
  onProgress: (cb) => subscribe('chat:progress', cb),
  onFinalSummary: (cb) => subscribe('chat:summary', cb),
  getHistory: (botId, limit, threadId) => ipcRenderer.invoke('chat:history', { botId, limit, threadId }),
  // v0.59 (UI-5): threads — một bot có nhiều hội thoại.
  'threads:list': (botId) => ipcRenderer.invoke('threads:list', { botId }),
  listThreads: (botId) => ipcRenderer.invoke('threads:list', { botId }),
  'threads:create': (botId, title) => ipcRenderer.invoke('threads:create', { botId, title }),
  createThread: (botId, title) => ipcRenderer.invoke('threads:create', { botId, title }),
  'threads:rename': (threadId, title) => ipcRenderer.invoke('threads:rename', { threadId, title }),
  renameThread: (threadId, title) => ipcRenderer.invoke('threads:rename', { threadId, title }),
  'threads:delete': (threadId) => ipcRenderer.invoke('threads:delete', { threadId }),
  deleteThread: (threadId) => ipcRenderer.invoke('threads:delete', { threadId }),
  'threads:search': (payload) => ipcRenderer.invoke('threads:search', payload),
  searchThreads: (payload) => ipcRenderer.invoke('threads:search', payload),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  testConnection: (providerId) => ipcRenderer.invoke('settings:test', { providerId }),
  listTasks: (botId) => ipcRenderer.invoke('tasks:list', { botId }),
  // v0.28: trạng thái lưu task A2A (cảnh báo UI khi lưu lỗi).
  getA2aPersistStatus: () => ipcRenderer.invoke('a2a:persist-status'),
  onA2aPersistStatus: (cb) => subscribe('a2a:persist-status', cb),
  // v0.86 (P2-6): deep-link `open-bot://` (route từ @open-bot/core).
  onDeepLink: (cb) => subscribe('deep-link:open', cb),
  getPendingDeepLink: () => ipcRenderer.invoke('deep-link:pending'),
  // v0.31 (P1-2): A2A client — agent ngoài đã tin tưởng.
  listTrustedA2aAgents: () => ipcRenderer.invoke('a2a:trusted-list'),
  addTrustedA2aAgent: (url, token) => ipcRenderer.invoke('a2a:trusted-add', { url, token }),
  removeTrustedA2aAgent: (baseUrl) => ipcRenderer.invoke('a2a:trusted-remove', { baseUrl }),
  sendToTrustedA2aAgent: (baseUrl, message, timeoutMs) =>
    ipcRenderer.invoke('a2a:trusted-send', { baseUrl, message, timeoutMs }),
  // v0.11: plans stored on disk from earlier sessions.
  'plans:list': (payload) => ipcRenderer.invoke('plans:list', payload),
  listPlans: (botId) => ipcRenderer.invoke('plans:list', botId ? { botId } : undefined),
  // v0.20 (W13a): duyệt plan trực tiếp (IPC `plans:review`).
  'plans:review': (payload) => ipcRenderer.invoke('plans:review', payload),
  reviewPlan: (payload) => ipcRenderer.invoke('plans:review', payload),
  // v0.35 (P1-7): rule auto-approve (IPC `auto-approve:*`).
  'auto-approve:list': () => ipcRenderer.invoke('auto-approve:list'),
  listAutoApproveRules: () => ipcRenderer.invoke('auto-approve:list'),
  'auto-approve:add': (rule) => ipcRenderer.invoke('auto-approve:add', rule),
  addAutoApproveRule: (rule) => ipcRenderer.invoke('auto-approve:add', rule),
  'auto-approve:remove': (id) => ipcRenderer.invoke('auto-approve:remove', { id }),
  removeAutoApproveRule: (id) => ipcRenderer.invoke('auto-approve:remove', { id }),
  'auto-approve:set-enabled': (id, enabled) =>
    ipcRenderer.invoke('auto-approve:set-enabled', { id, enabled }),
  setAutoApproveRuleEnabled: (id, enabled) =>
    ipcRenderer.invoke('auto-approve:set-enabled', { id, enabled }),
  listTemplates: () => ipcRenderer.invoke('templates:list'),
  cloneAgent: (botId, name) => ipcRenderer.invoke('agents:clone', { botId, name }),
  publishAgent: (botId, meta) => ipcRenderer.invoke('agents:publish', { botId, ...meta }),
  listMarketplace: () => ipcRenderer.invoke('marketplace:list'),
  installMarketplace: (id) => ipcRenderer.invoke('marketplace:install', { id }),
  uninstallMarketplace: (id) => ipcRenderer.invoke('marketplace:uninstall', { id }),
  listMcpMarketplace: () => ipcRenderer.invoke('mcp-marketplace:list'),
  listMcpInstalled: (botId) => ipcRenderer.invoke('mcp-marketplace:installed', { botId }),
  listMcpServerTools: (id) => ipcRenderer.invoke('mcp-marketplace:tools', { id }),
  installMcpServer: (id, botId, args, entry, version) =>
    ipcRenderer.invoke('mcp-marketplace:install', { id, botId, args, entry, version }),
  uninstallMcpServer: (id, botId) => ipcRenderer.invoke('mcp-marketplace:uninstall', { id, botId }),
  // v0.89a (Marketplace v2): search / versions / remote catalog / approvals.
  searchMcpMarketplace: (query, tag) =>
    ipcRenderer.invoke('mcp-marketplace:search', { query, tag }),
  checkMcpUpdates: (botId) => ipcRenderer.invoke('mcp-marketplace:check-updates', { botId }),
  updateMcpServer: (id, botId, version) =>
    ipcRenderer.invoke('mcp-marketplace:update', { id, botId, version }),
  fetchRemoteMcpCatalog: (url) => ipcRenderer.invoke('mcp-marketplace:remote-catalog', { url }),
  approveMarketplace: (kind, targetId, version, source) =>
    ipcRenderer.invoke('mcp-marketplace:approve', { kind, targetId, version, source }),
  listMarketplaceApprovals: () => ipcRenderer.invoke('mcp-marketplace:approvals'),
  // v0.89a (Marketplace v2): plugin marketplace.
  listPluginMarketplace: () => ipcRenderer.invoke('plugin-marketplace:list'),
  searchPluginMarketplace: (query) => ipcRenderer.invoke('plugin-marketplace:search', { query }),
  preparePluginInstall: (source, opts) =>
    ipcRenderer.invoke('plugin-marketplace:prepare', { source, allowUnsigned: opts?.allowUnsigned === true }),
  installPluginMarketplace: (stagingId, opts) =>
    ipcRenderer.invoke('plugin-marketplace:install', { stagingId, allowUnsigned: opts?.allowUnsigned === true }),
  updatePluginMarketplace: (stagingId, opts) =>
    ipcRenderer.invoke('plugin-marketplace:update', { stagingId, allowUnsigned: opts?.allowUnsigned === true }),
  uninstallPluginMarketplace: (id) => ipcRenderer.invoke('plugin-marketplace:uninstall', { id }),
  checkPluginUpdates: (entries) => ipcRenderer.invoke('plugin-marketplace:check-updates', { entries }),
  // v0.93a: downgrade + trusted signing keys.
  getPluginDowngradeInfo: (id) => ipcRenderer.invoke('plugin-marketplace:downgrade-info', { id }),
  downgradePluginMarketplace: (id) => ipcRenderer.invoke('plugin-marketplace:downgrade', { id }),
  listTrustedMarketplaceKeys: () => ipcRenderer.invoke('plugin-marketplace:trusted-keys'),
  addTrustedMarketplaceKey: (publicKey, label) =>
    ipcRenderer.invoke('plugin-marketplace:add-trusted-key', { publicKey, label }),
  removeTrustedMarketplaceKey: (keyId) =>
    ipcRenderer.invoke('plugin-marketplace:remove-trusted-key', { keyId }),
  getTeam: () => ipcRenderer.invoke('team:get'),
  addTeamMember: (member) => ipcRenderer.invoke('team:add-member', member),
  removeTeamMember: (userId) => ipcRenderer.invoke('team:remove-member', { userId }),
  setTeamRole: (userId, role) => ipcRenderer.invoke('team:set-role', { userId, role }),
  shareBot: (botId, sharedBy) => ipcRenderer.invoke('team:share-bot', { botId, sharedBy }),
  unshareBot: (botId) => ipcRenderer.invoke('team:unshare-bot', { botId }),
  listSharedBots: () => ipcRenderer.invoke('team:shared-bots'),
  // v0.80: portable team bundle — export to / import from one JSON file.
  exportTeam: () => ipcRenderer.invoke('team:export'),
  importTeam: () => ipcRenderer.invoke('team:import'),
  importTeamApply: (payload) => ipcRenderer.invoke('team:import-apply', payload),
  // Sóng B (đội platform): máy tính riêng cho từng bot (IPC `computers:*`).
  'computers:probe': () => ipcRenderer.invoke('computers:probe'),
  'computers:plan': (payload) => ipcRenderer.invoke('computers:plan', payload),
  'computers:create': (payload) => ipcRenderer.invoke('computers:create', payload),
  'computers:list': () => ipcRenderer.invoke('computers:list'),
  'computers:start': (botId) => ipcRenderer.invoke('computers:start', botId),
  'computers:pause': (botId) => ipcRenderer.invoke('computers:pause', botId),
  'computers:resume': (botId) => ipcRenderer.invoke('computers:resume', botId),
  'computers:stop': (botId) => ipcRenderer.invoke('computers:stop', botId),
  'computers:set-vm-image': (payload) => ipcRenderer.invoke('computers:set-vm-image', payload),
  'computers:set-vm-network': (payload) => ipcRenderer.invoke('computers:set-vm-network', payload),
  'computers:shed': () => ipcRenderer.invoke('computers:shed'),
  'computers:queue': () => ipcRenderer.invoke('computers:queue'),
  'computers:set-priority': (payload) => ipcRenderer.invoke('computers:set-priority', payload),
  'computers:set-auto-shed': (payload) => ipcRenderer.invoke('computers:set-auto-shed', payload),
  'computers:guest-health': (botId) => ipcRenderer.invoke('computers:guest-health', botId),
  probeComputers: () => ipcRenderer.invoke('computers:probe'),
  planComputers: (payload) => ipcRenderer.invoke('computers:plan', payload),
  createComputers: (payload) => ipcRenderer.invoke('computers:create', payload),
  listComputers: () => ipcRenderer.invoke('computers:list'),
  startComputer: (botId) => ipcRenderer.invoke('computers:start', botId),
  pauseComputer: (botId) => ipcRenderer.invoke('computers:pause', botId),
  resumeComputer: (botId) => ipcRenderer.invoke('computers:resume', botId),
  stopComputer: (botId) => ipcRenderer.invoke('computers:stop', botId),
  setComputerVmImage: (payload) => ipcRenderer.invoke('computers:set-vm-image', payload),
  setComputerVmNetwork: (payload) => ipcRenderer.invoke('computers:set-vm-network', payload),
  shedComputers: () => ipcRenderer.invoke('computers:shed'),
  getComputerQueue: () => ipcRenderer.invoke('computers:queue'),
  setComputerPriority: (payload) => ipcRenderer.invoke('computers:set-priority', payload),
  setComputerAutoShed: (payload) => ipcRenderer.invoke('computers:set-auto-shed', payload),
  checkComputerGuestHealth: (botId) => ipcRenderer.invoke('computers:guest-health', botId),
  // Đội D (fleet): tầng fleet đa người dùng (IPC `fleet:*`).
  'fleet:list': () => ipcRenderer.invoke('fleet:list'),
  'fleet:status': (id) => ipcRenderer.invoke('fleet:status', id),
  'fleet:create': (payload) => ipcRenderer.invoke('fleet:create', payload),
  'fleet:remove': (payload) => ipcRenderer.invoke('fleet:remove', payload),
  'fleet:rename': (payload) => ipcRenderer.invoke('fleet:rename', payload),
  'fleet:suspend': (id) => ipcRenderer.invoke('fleet:suspend', id),
  'fleet:activate': (id) => ipcRenderer.invoke('fleet:activate', id),
  'fleet:start': (id) => ipcRenderer.invoke('fleet:start', id),
  'fleet:stop': (id) => ipcRenderer.invoke('fleet:stop', id),
  'fleet:restart': (id) => ipcRenderer.invoke('fleet:restart', id),
  'fleet:health': (id) => ipcRenderer.invoke('fleet:health', id),
  'fleet:capacity': (payload) => ipcRenderer.invoke('fleet:capacity', payload),
  'fleet:audit': (payload) => ipcRenderer.invoke('fleet:audit', payload),
  'fleet:audit-verify': () => ipcRenderer.invoke('fleet:audit-verify'),
  'fleet:decisions': (payload) => ipcRenderer.invoke('fleet:decisions', payload),
  'fleet:decisions-verify': () => ipcRenderer.invoke('fleet:decisions-verify'),
  'fleet:usage': (id) => ipcRenderer.invoke('fleet:usage', id),
  'fleet:record-usage': (id) => ipcRenderer.invoke('fleet:record-usage', id),
  'fleet:add-member': (payload) => ipcRenderer.invoke('fleet:add-member', payload),
  'fleet:remove-member': (payload) => ipcRenderer.invoke('fleet:remove-member', payload),
  'fleet:set-member-role': (payload) => ipcRenderer.invoke('fleet:set-member-role', payload),
  listFleet: () => ipcRenderer.invoke('fleet:list'),
  getFleetStatus: (id) => ipcRenderer.invoke('fleet:status', id),
  createFleetWorkspace: (payload) => ipcRenderer.invoke('fleet:create', payload),
  removeFleetWorkspace: (payload) => ipcRenderer.invoke('fleet:remove', payload),
  renameFleetWorkspace: (payload) => ipcRenderer.invoke('fleet:rename', payload),
  suspendFleetWorkspace: (id) => ipcRenderer.invoke('fleet:suspend', id),
  activateFleetWorkspace: (id) => ipcRenderer.invoke('fleet:activate', id),
  startFleetService: (id) => ipcRenderer.invoke('fleet:start', id),
  stopFleetService: (id) => ipcRenderer.invoke('fleet:stop', id),
  restartFleetService: (id) => ipcRenderer.invoke('fleet:restart', id),
  healthFleetService: (id) => ipcRenderer.invoke('fleet:health', id),
  checkFleetCapacity: (payload) => ipcRenderer.invoke('fleet:capacity', payload),
  listFleetAudit: (payload) => ipcRenderer.invoke('fleet:audit', payload),
  verifyFleetAudit: () => ipcRenderer.invoke('fleet:audit-verify'),
  listFleetDecisions: (payload) => ipcRenderer.invoke('fleet:decisions', payload),
  verifyFleetDecisions: () => ipcRenderer.invoke('fleet:decisions-verify'),
  getFleetUsage: (id) => ipcRenderer.invoke('fleet:usage', id),
  recordFleetUsage: (id) => ipcRenderer.invoke('fleet:record-usage', id),
  addFleetMember: (payload) => ipcRenderer.invoke('fleet:add-member', payload),
  removeFleetMember: (payload) => ipcRenderer.invoke('fleet:remove-member', payload),
  setFleetMemberRole: (payload) => ipcRenderer.invoke('fleet:set-member-role', payload),
  // v0.50 (M8): group chat bot-bot (IPC `group:*`).
  createGroupChat: (payload) => ipcRenderer.invoke('group:create', payload),
  listGroupChats: () => ipcRenderer.invoke('group:list'),
  addBotToGroupChat: (payload) => ipcRenderer.invoke('group:add-bot', payload),
  removeBotFromGroupChat: (payload) => ipcRenderer.invoke('group:remove-bot', payload),
  deleteGroupChat: (payload) => ipcRenderer.invoke('group:delete', payload),
  postGroupMessage: (payload) => ipcRenderer.invoke('group:post-message', payload),
  listGroupMessages: (payload) => ipcRenderer.invoke('group:list-messages', payload),
  // v0.94c: đọc lại bytes một ảnh đính kèm trong message nhóm.
  getGroupAttachment: (payload) => ipcRenderer.invoke('group:get-attachment', payload),
  // v0.79a: trạng thái chạy của bot trong nhóm.
  getGroupBotStatus: (payload) => ipcRenderer.invoke('group:status', payload),
  // v0.82: bỏ qua ghi nhận "chạy dở thì app dừng".
  dismissGroupBotInterrupted: (payload) => ipcRenderer.invoke('group:dismiss-interrupted', payload),
  // v0.4: Vault + Usage.
  listVaultSecrets: () => ipcRenderer.invoke('vault:list'),
  setVaultSecret: (namespace, key, value) => ipcRenderer.invoke('vault:set', { namespace, key, value }),
  deleteVaultSecret: (namespace, key) => ipcRenderer.invoke('vault:delete', { namespace, key }),
  getUsage: (botId) => ipcRenderer.invoke('usage:get', { botId }),
  getSpendLimits: () => ipcRenderer.invoke('usage:get-limits'),
  setSpendLimits: (limits) => ipcRenderer.invoke('usage:set-limits', limits),
  resetUsage: (scope) => ipcRenderer.invoke('usage:reset', { scope }),
  // v0.4: skills.
  listSkills: () => ipcRenderer.invoke('skills:list'),
  toggleSkill: (name, enabled) => ipcRenderer.invoke('skills:toggle', { name, enabled }),
  // v0.66b: SkillsView — đọc toàn bộ SKILL.md + cài skill mới từ text dán.
  readSkill: (name) => ipcRenderer.invoke('skills:read', { name }),
  installSkill: (name, content) => ipcRenderer.invoke('skills:install', { name, content }),
  // v0.86c: CanvasView — danh sách / đọc / xoá / mở canvas của 1 bot.
  listCanvases: (botId) => ipcRenderer.invoke('canvas:list', { botId }),
  getCanvas: (botId, id) => ipcRenderer.invoke('canvas:get', { botId, id }),
  deleteCanvas: (botId, id) => ipcRenderer.invoke('canvas:delete', { botId, id }),
  openCanvasInEditor: (botId, id) => ipcRenderer.invoke('canvas:open', { botId, id }),
  /**
   * v0.87c: OS notifications — renderer sends a request (main validates
   * + shows the popup); `testNotification` fires the Settings "Send
   * test" sample. Renderer never calls Electron Notification directly.
   */
  sendNotification: (input) => ipcRenderer.invoke('notifications:send', input),
  testNotification: (kind) => ipcRenderer.invoke('notifications:test', { kind }),
  // v0.86 (P2-7): crash reporting opt-in — chỉ đọc/xoá report local.
  listCrashReports: () => ipcRenderer.invoke('crash-reports:list'),
  getCrashReport: (id) => ipcRenderer.invoke('crash-reports:get', { id }),
  deleteCrashReport: (id) => ipcRenderer.invoke('crash-reports:delete', { id }),
  deleteAllCrashReports: () => ipcRenderer.invoke('crash-reports:delete-all'),
  reportRendererError: (input) => ipcRenderer.invoke('crash-report:renderer', input),
  // v0.59 (UI-3): duyệt tool theo bot — màn Tools riêng.
  listBotTools: (botId) => ipcRenderer.invoke('tools:list', { botId }),
  setBotToolEnabled: (botId, toolName, enabled) =>
    ipcRenderer.invoke('tools:toggle', { botId, toolName, enabled }),
  // v0.95 (Team D1): Internet data — feeds + watched pages.
  getInternetData: () => ipcRenderer.invoke('internet-data:get'),
  subscribeInternetFeed: (url, title) =>
    ipcRenderer.invoke('internet-data:subscribe', { url, title }),
  unsubscribeInternetFeed: (feed) =>
    ipcRenderer.invoke('internet-data:unsubscribe', { feed }),
  readInternetFeed: (feed, limit) =>
    ipcRenderer.invoke('internet-data:feed-read', { feed, limit }),
  addInternetWatch: (url, intervalMinutes) =>
    ipcRenderer.invoke('internet-data:watch-add', { url, intervalMinutes }),
  removeInternetWatch: (watch) =>
    ipcRenderer.invoke('internet-data:watch-remove', { watch }),
  checkInternetWatches: (watch) =>
    ipcRenderer.invoke('internet-data:check', { watch }),
  onInternetWatchChanged: (cb) => subscribe('internet:watch-changed', cb),
  // v0.64 (skills per-bot): duyệt skill theo bot — màn Tools riêng.
  listBotSkills: (botId) => ipcRenderer.invoke('bot-skills:list', { botId }),
  setBotSkillEnabled: (botId, skillName, enabled) =>
    ipcRenderer.invoke('bot-skills:toggle', { botId, skillName, enabled }),
  // v0.60 (UI-6): slash commands của bot — popup autocomplete.
  listSlashCommands: (botId) => ipcRenderer.invoke('slash:list', { botId }),
  reloadSkills: () => ipcRenderer.invoke('skills:reload'),
  // v0.29 (P0-2): hooks.
  'hooks:list': () => ipcRenderer.invoke('hooks:list'),
  'hooks:toggle': (payload) => ipcRenderer.invoke('hooks:toggle', payload),
  listHooks: () => ipcRenderer.invoke('hooks:list'),
  toggleHook: (name, enabled) => ipcRenderer.invoke('hooks:toggle', { name, enabled }),
  // v0.8: plugins.
  'plugins:list': () => ipcRenderer.invoke('plugins:list'),
  'plugins:toggle': (payload) => ipcRenderer.invoke('plugins:toggle', payload),
  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  togglePlugin: (id, enabled) => ipcRenderer.invoke('plugins:toggle', { id, enabled }),
  // v0.14: plugin templates + running-bot plugin toggle.
  'plugin-templates:list': () => ipcRenderer.invoke('plugin-templates:list'),
  'plugin-templates:create': (input) => ipcRenderer.invoke('plugin-templates:create', input),
  'plugin-templates:apply': (payload) => ipcRenderer.invoke('plugin-templates:apply', payload),
  'plugin-templates:export': (payload) => ipcRenderer.invoke('plugin-templates:export', payload),
  'plugin-templates:import': (payload) => ipcRenderer.invoke('plugin-templates:import', payload),
  'plugin-templates:delete': (payload) => ipcRenderer.invoke('plugin-templates:delete', payload),
  'plugin:set-enabled': (payload) => ipcRenderer.invoke('plugin:set-enabled', payload),
  listPluginTemplates: () => ipcRenderer.invoke('plugin-templates:list'),
  createPluginTemplate: (input) => ipcRenderer.invoke('plugin-templates:create', input),
  applyPluginTemplate: (payload) => ipcRenderer.invoke('plugin-templates:apply', payload),
  exportPluginTemplate: (payload) => ipcRenderer.invoke('plugin-templates:export', payload),
  importPluginTemplate: (payload) => ipcRenderer.invoke('plugin-templates:import', payload),
  deletePluginTemplate: (payload) => ipcRenderer.invoke('plugin-templates:delete', payload),
  setPluginEnabled: (payload) => ipcRenderer.invoke('plugin:set-enabled', payload),
  // v0.4: automations.
  listAutomations: () => ipcRenderer.invoke('automations:list'),
  getAutomation: (id) => ipcRenderer.invoke('automations:get', { id }),
  createAutomation: (automation) => ipcRenderer.invoke('automations:create', automation),
  updateAutomation: (automation) => ipcRenderer.invoke('automations:update', automation),
  deleteAutomation: (id) => ipcRenderer.invoke('automations:delete', { id }),
  setAutomationEnabled: (id, enabled) => ipcRenderer.invoke('automations:set-enabled', { id, enabled }),
  runAutomationNow: (id) => ipcRenderer.invoke('automations:run-now', { id }),
  listAutomationRuns: (automationId) => ipcRenderer.invoke('automations:runs', { automationId }),
  // v0.74d: nạp dữ liệu mẫu vào store thật (IPC `automations:seed-samples`).
  seedSampleAutomations: () => ipcRenderer.invoke('automations:seed-samples'),
  // v0.52 P0-5: webhook trigger keys + delivery + retry-run.
  // create/rotate return the secret EXACTLY ONCE — the renderer shows
  // it once and never stores it.
  createAutomationWebhookKey: (id) => ipcRenderer.invoke('automations:webhook-key:create', { id }),
  rotateAutomationWebhookKey: (id) => ipcRenderer.invoke('automations:webhook-key:rotate', { id }),
  deleteAutomationWebhookKey: (id) => ipcRenderer.invoke('automations:webhook-key:delete', { id }),
  hasAutomationWebhookKey: (id) => ipcRenderer.invoke('automations:webhook-key:exists', { id }),
  invokeAutomationWebhook: (id, body, signature) =>
    ipcRenderer.invoke('automations:webhook', { id, body, signature }),
  testAutomationWebhook: (id, payload) =>
    ipcRenderer.invoke('automations:webhook:test', { id, payload }),
  retryAutomationRun: (runId) => ipcRenderer.invoke('automations:retry-run', { runId }),
  retryLastFailedAutomationRun: (automationId) =>
    ipcRenderer.invoke('automations:retry-run', { automationId }),
  // v0.83b: Composio trigger — defs + signing secret + URL token + test.
  listComposioTriggerDefs: () => ipcRenderer.invoke('composio:trigger-defs'),
  setComposioTriggerSecret: (id, secret) =>
    ipcRenderer.invoke('automations:composio-trigger-secret:set', { id, secret }),
  hasComposioTriggerSecret: (id) =>
    ipcRenderer.invoke('automations:composio-trigger-secret:exists', { id }),
  deleteComposioTriggerSecret: (id) =>
    ipcRenderer.invoke('automations:composio-trigger-secret:delete', { id }),
  createComposioTriggerToken: (id) =>
    ipcRenderer.invoke('automations:composio-trigger-token:create', { id }),
  rotateComposioTriggerToken: (id) =>
    ipcRenderer.invoke('automations:composio-trigger-token:rotate', { id }),
  hasComposioTriggerToken: (id) =>
    ipcRenderer.invoke('automations:composio-trigger-token:exists', { id }),
  deleteComposioTriggerToken: (id) =>
    ipcRenderer.invoke('automations:composio-trigger-token:delete', { id }),
  testComposioTrigger: (id, data) =>
    ipcRenderer.invoke('automations:composio-trigger:test', { id, data }),
  // v0.87a (P2-2): Slack inbound — signing secret + mock test delivery.
  setSlackSigningSecret: (id, secret) =>
    ipcRenderer.invoke('automations:slack-signing-secret:set', { id, secret }),
  hasSlackSigningSecret: (id) =>
    ipcRenderer.invoke('automations:slack-signing-secret:exists', { id }),
  deleteSlackSigningSecret: (id) =>
    ipcRenderer.invoke('automations:slack-signing-secret:delete', { id }),
  testSlackInbound: (id, opts) =>
    ipcRenderer.invoke('automations:slack-inbound:test', { id, ...opts }),
  // v0.4: dream.
  getDream: () => ipcRenderer.invoke('dream:get'),
  setDream: (config) => ipcRenderer.invoke('dream:set', config),
  onAutomationNotify: (cb) => subscribe('automation:notify', cb),
  onAutomationRunsChanged: (cb) => subscribe('automation:runs-changed', cb),
  // v0.4: voice.
  voiceAvailable: (botId) => ipcRenderer.invoke('voice:available', { botId }),
  voiceConnect: (botId) => ipcRenderer.invoke('voice:connect', { botId }),
  voiceSendAudio: (botId, audioBase64) => ipcRenderer.send('voice:audio', { botId, audioBase64 }),
  voiceCommit: (botId) => ipcRenderer.invoke('voice:commit', { botId }),
  // v0.81: TTS (local-first). v0.82: voice/rate options + voice list.
  // v0.83: stop the utterance still speaking.
  getTtsStatus: () => ipcRenderer.invoke('tts:status'),
  listTtsVoices: (lang) => ipcRenderer.invoke('tts:voices', { lang }),
  speakText: (text, lang, opts) =>
    ipcRenderer.invoke('tts:speak', { text, lang, voice: opts?.voice, rate: opts?.rate }),
  stopTts: () => ipcRenderer.invoke('tts:stop'),
  voiceDisconnect: (botId) => ipcRenderer.invoke('voice:disconnect', { botId }),
  transcribeMemo: (botId, audioBase64) => ipcRenderer.invoke('voice:memo-transcribe', { botId, audioBase64 }),
  // v0.56: voice:surface + dictation PCM16.
  voiceSurfaceRegister: (botId, surface, view) =>
    ipcRenderer.invoke('voice:surface-register', { botId, surface, view }),
  voiceSurfaceUnregister: (surfaceId) =>
    ipcRenderer.invoke('voice:surface-unregister', { surfaceId }),
  voiceSurfaceList: (botId) => ipcRenderer.invoke('voice:surface-list', { botId }),
  voiceDictation: (botId, audioBase64) => ipcRenderer.invoke('voice:dictation', { botId, audioBase64 }),
  onVoiceTranscript: (cb) => subscribe('voice:transcript', cb),
  onVoiceAudio: (cb) => subscribe('voice:audio', cb),
  onVoiceError: (cb) => subscribe('voice:error', cb),
  onVoiceToolCall: (cb) => subscribe('voice:toolcall', cb),
  onVoiceSurface: (cb) => subscribe('voice:surface', cb),
  // v0.95 (Đội D3): voice realtime 2 chiều (RealtimeSession) —
  // connect/disconnect/mode/talk/interrupt + mic frames riêng +
  // state/interrupted/turn events.
  voiceRealtimeConnect: (botId, provider, turnMode) =>
    ipcRenderer.invoke('voice:realtime-connect', { botId, provider, turnMode }),
  voiceRealtimeDisconnect: (botId) => ipcRenderer.invoke('voice:realtime-disconnect', { botId }),
  voiceRealtimeMode: (botId, turnMode) =>
    ipcRenderer.invoke('voice:realtime-mode', { botId, turnMode }),
  voiceRealtimeTalk: (botId, held) => ipcRenderer.invoke('voice:realtime-talk', { botId, held }),
  voiceRealtimeInterrupt: (botId) => ipcRenderer.invoke('voice:realtime-interrupt', { botId }),
  voiceRealtimeSendAudio: (botId, audioBase64) =>
    ipcRenderer.send('voice:realtime-audio', { botId, audioBase64 }),
  onVoiceRealtimeState: (cb) => subscribe('voice:realtime-state', cb),
  // v0.4: hiệu năng.
  getPerfStats: () => ipcRenderer.invoke('perf:stats'),
  clearCache: () => ipcRenderer.invoke('cache:clear'),
  // v0.10: run tracing (JSONL spans per run; main only reads the file).
  'traces:list': (filter) => ipcRenderer.invoke('traces:list', filter),
  'traces:get': (query) => ipcRenderer.invoke('traces:get', query),
  listTraces: (filter) => ipcRenderer.invoke('traces:list', filter),
  getTrace: (query) => ipcRenderer.invoke('traces:get', query),
  // v0.5: model registry + Ollama local (method names are the IPC channel names).
  'models:list': () => ipcRenderer.invoke('models:list'),
  'models:set-feature': (payload) => ipcRenderer.invoke('models:set-feature', payload),
  'models:set-default': (payload) => ipcRenderer.invoke('models:set-default', payload),
  'models:set-fallback': (payload) => ipcRenderer.invoke('models:set-fallback', payload),
  'models:set-flag': (payload) => ipcRenderer.invoke('models:set-flag', payload),
  'models:ollama-list': () => ipcRenderer.invoke('models:ollama-list'),
  'models:ollama-pull': (model) => ipcRenderer.invoke('models:ollama-pull', model),
  // v0.5: local API + webhooks.
  'api:get': () => ipcRenderer.invoke('api:get'),
  'api:set': (patch) => ipcRenderer.invoke('api:set', patch),
  'api:get-token': () => ipcRenderer.invoke('api:get-token'),
  'api:regenerate-token': () => ipcRenderer.invoke('api:regenerate-token'),
  'api:webhooks-list': () => ipcRenderer.invoke('api:webhooks-list'),
  'api:webhooks-add': (payload) => ipcRenderer.invoke('api:webhooks-add', payload),
  'api:webhooks-remove': (id) => ipcRenderer.invoke('api:webhooks-remove', id),
  // v0.5: team workspace + service accounts + Vault NO_STORAGE.
  'team:get-workspace': () => ipcRenderer.invoke('team:get-workspace'),
  'team:set-workspace-dir': (dir) => ipcRenderer.invoke('team:set-workspace-dir', dir),
  'team:service-accounts-list': () => ipcRenderer.invoke('team:service-accounts-list'),
  'team:service-account-create': (payload) =>
    ipcRenderer.invoke('team:service-account-create', payload),
  'team:service-account-delete': (id) => ipcRenderer.invoke('team:service-account-delete', id),
  'vault:get-nostorage': () => ipcRenderer.invoke('vault:get-nostorage'),
  // v0.15 (L5 audit): gửi opts trong cùng một object payload
  // `{ enabled, discardTemporarySecrets }` — main đọc `enabled` qua
  // asBooleanParam (đã chấp nhận dạng object) và `discard...` riêng.
  'vault:set-nostorage': (enabled, opts) =>
    ipcRenderer.invoke('vault:set-nostorage', {
      enabled,
      discardTemporarySecrets: opts?.discardTemporarySecrets === true,
    }),
  // v0.5: camelCase aliases (same channels as above).
  listModels: () => ipcRenderer.invoke('models:list'),
  // M4: provider rail cho ModelPicker.
  'models:rail': (payload) => ipcRenderer.invoke('models:rail', payload),
  listModelRail: (payload) => ipcRenderer.invoke('models:rail', payload),
  setModelFeature: (payload) => ipcRenderer.invoke('models:set-feature', payload),
  setDefaultModel: (payload) => ipcRenderer.invoke('models:set-default', payload),
  setFallbackModel: (payload) => ipcRenderer.invoke('models:set-fallback', payload),
  setFeatureFlag: (payload) => ipcRenderer.invoke('models:set-flag', payload),
  listOllamaModels: () => ipcRenderer.invoke('models:ollama-list'),
  pullOllamaModel: (model) => ipcRenderer.invoke('models:ollama-pull', model),
  // M1: detected CLI engines (Settings → Engines).
  'engines:list': () => ipcRenderer.invoke('engines:list'),
  'engines:redetect': () => ipcRenderer.invoke('engines:redetect'),
  // M4: quét lại chỉ một engine.
  'engines:redetect-one': (payload) => ipcRenderer.invoke('engines:redetect-one', payload),
  'engines:set-enabled': (payload) => ipcRenderer.invoke('engines:set-enabled', payload),
  // M3: custom ACP CLI ("Set CLI…" in Settings → Engines).
  'engines:custom-list': () => ipcRenderer.invoke('engines:custom-list'),
  'engines:custom-add': (payload) => ipcRenderer.invoke('engines:custom-add', payload),
  'engines:custom-update': (payload) => ipcRenderer.invoke('engines:custom-update', payload),
  'engines:custom-remove': (payload) => ipcRenderer.invoke('engines:custom-remove', payload),
  listEngines: () => ipcRenderer.invoke('engines:list'),
  redetectEngines: () => ipcRenderer.invoke('engines:redetect'),
  redetectEngine: (payload) => ipcRenderer.invoke('engines:redetect-one', payload),
  setEngineEnabled: (payload) => ipcRenderer.invoke('engines:set-enabled', payload),
  listCustomClis: () => ipcRenderer.invoke('engines:custom-list'),
  addCustomCli: (payload) => ipcRenderer.invoke('engines:custom-add', payload),
  updateCustomCli: (payload) => ipcRenderer.invoke('engines:custom-update', payload),
  removeCustomCli: (payload) => ipcRenderer.invoke('engines:custom-remove', payload),
  onEnginesChanged: (cb) => subscribe('engines:changed', cb),
  getApiStatus: () => ipcRenderer.invoke('api:get'),
  setApiStatus: (patch) => ipcRenderer.invoke('api:set', patch),
  getApiToken: () => ipcRenderer.invoke('api:get-token'),
  regenerateApiToken: () => ipcRenderer.invoke('api:regenerate-token'),
  listWebhooks: () => ipcRenderer.invoke('api:webhooks-list'),
  addWebhook: (payload) => ipcRenderer.invoke('api:webhooks-add', payload),
  removeWebhook: (id) => ipcRenderer.invoke('api:webhooks-remove', id),
  getTeamWorkspace: () => ipcRenderer.invoke('team:get-workspace'),
  setTeamWorkspaceDir: (dir) => ipcRenderer.invoke('team:set-workspace-dir', dir),
  listServiceAccounts: () => ipcRenderer.invoke('team:service-accounts-list'),
  createServiceAccount: (payload) => ipcRenderer.invoke('team:service-account-create', payload),
  deleteServiceAccount: (id) => ipcRenderer.invoke('team:service-account-delete', id),
  getVaultNoStorage: () => ipcRenderer.invoke('vault:get-nostorage'),
  setVaultNoStorage: (enabled, opts) =>
    ipcRenderer.invoke('vault:set-nostorage', {
      enabled,
      discardTemporarySecrets: opts?.discardTemporarySecrets === true,
    }),
  // v0.7: đăng nhập đa tầng + OAuth + tự cập nhật.
  'auth:profile-get': () => ipcRenderer.invoke('auth:profile-get'),
  'auth:profile-set': (payload) => ipcRenderer.invoke('auth:profile-set', payload),
  'auth:identities-list': () => ipcRenderer.invoke('auth:identities-list'),
  'auth:identity-delete': (payload) => ipcRenderer.invoke('auth:identity-delete', payload),
  'auth:oauth-supported': () => ipcRenderer.invoke('auth:oauth-supported'),
  'auth:oauth-start': (payload) => ipcRenderer.invoke('auth:oauth-start', payload),
  // M7: connected apps.
  'apps:list': () => ipcRenderer.invoke('apps:list'),
  'apps:disconnect': (payload) => ipcRenderer.invoke('apps:disconnect', payload),
  // v0.68b: M7 app token (PAT dán tay, vd GitHub).
  'apps:set-token': (payload) => ipcRenderer.invoke('apps:set-token', payload),
  // v0.53 (P1-6): 1Password broker (out-of-process).
  'onepassword:status': () => ipcRenderer.invoke('onepassword:status'),
  'onepassword:set-enabled': (payload: { enabled: boolean }) => ipcRenderer.invoke('onepassword:set-enabled', payload),
  'onepassword:import-field': (payload) => ipcRenderer.invoke('onepassword:import-field', payload),
  'update:check': () => ipcRenderer.invoke('update:check'),
  'update:open-download': (payload) => ipcRenderer.invoke('update:open-download', payload),
  // v0.54 (P1-9): update theo track (UpdateService).
  getUpdateStatus: () => ipcRenderer.invoke('updates:get-status'),
  setUpdateTrack: (track) => ipcRenderer.invoke('updates:set-track', { track }),
  checkForUpdates: (trigger) => ipcRenderer.invoke('updates:check', { trigger: trigger ?? 'manual' }),
  quitAndInstallUpdate: () => ipcRenderer.invoke('updates:quit-and-install'),
  // v0.54 (P1-8): checkpoint/resume + interrupt HITL.
  onInterruptNeeded: (cb) => subscribe('chat:interrupt-needed', cb),
  respondInterrupt: (requestId, decision) =>
    ipcRenderer.send('chat:interrupt-response', { requestId, decision }),
  listBotCheckpoints: (botId) => ipcRenderer.invoke('runs:list-checkpoints', { botId }),
  interruptRun: (runId, question) => ipcRenderer.invoke('runs:interrupt', { runId, question }),
  replayRun: (botId, runId, stepIndex) =>
    ipcRenderer.invoke('runs:replay', { botId, runId, stepIndex }),
  // v0.54 (P1-10): telemetry client_persistence về main (chỉ log).
  reportClientPersistence: (report) => ipcRenderer.send('telemetry:client-persistence', report),
  // v0.7: camelCase aliases (same channels as above).
  getLocalProfile: () => ipcRenderer.invoke('auth:profile-get'),
  setLocalProfile: (displayName) => ipcRenderer.invoke('auth:profile-set', { displayName }),
  // v0.95d4 (Đội D4): user profile đầy đủ + long-term memory.
  getUserProfile: () => ipcRenderer.invoke('profile:get'),
  updateUserProfile: (patch) => ipcRenderer.invoke('profile:update', patch),
  listMemories: (payload) => ipcRenderer.invoke('memory:list', payload),
  updateMemory: (payload) => ipcRenderer.invoke('memory:update', payload),
  deleteMemory: (payload) => ipcRenderer.invoke('memory:delete', payload),
  exportMemories: (payload) => ipcRenderer.invoke('memory:export', payload),
  getMemoryStatus: (payload) => ipcRenderer.invoke('memory:status', payload),
  listProviderIdentities: () => ipcRenderer.invoke('auth:identities-list'),
  deleteProviderIdentity: (providerId) => ipcRenderer.invoke('auth:identity-delete', { providerId }),
  listOAuthProviders: () => ipcRenderer.invoke('auth:oauth-supported'),
  startOAuthLogin: (providerId, clientId, clientSecret, connectorId) =>
    ipcRenderer.invoke('auth:oauth-start', { providerId, clientId, clientSecret, connectorId }),
  // M7: connected apps (camelCase aliases, same channels as above).
  listConnectedApps: () => ipcRenderer.invoke('apps:list'),
  disconnectConnectedApp: (appId) => ipcRenderer.invoke('apps:disconnect', { appId }),
  // v0.68b: M7 app token (PAT dán tay, vd GitHub).
  setConnectedAppToken: (appId, token) => ipcRenderer.invoke('apps:set-token', { appId, token }),
  // v0.57: Composio — opt-in (key chỉ vào Vault qua set-key, không trả về).
  getComposioState: () => ipcRenderer.invoke('composio:get-state'),
  setComposioEnabled: (enabled) => ipcRenderer.invoke('composio:set-enabled', { enabled }),
  setComposioAppEnabled: (toolkit, enabled) =>
    ipcRenderer.invoke('composio:set-app-enabled', { toolkit, enabled }),
  setComposioKey: (apiKey) => ipcRenderer.invoke('composio:set-key', { apiKey }),
  clearComposioKey: () => ipcRenderer.invoke('composio:clear-key'),
  // v0.88b: Composio user id — opt-in (chỉ vào Vault qua set-user-id, không trả về).
  setComposioUserId: (userId) => ipcRenderer.invoke('composio:set-user-id', { userId }),
  clearComposioUserId: () => ipcRenderer.invoke('composio:clear-user-id'),
  // v0.95 (Team D2): Media keys — opt-in (key chỉ vào Vault qua set-key, không trả về;
  // get-status chỉ trả {configured, suffix}, không bao giờ trả key).
  getMediaKeyStatus: () => ipcRenderer.invoke('media:get-status'),
  setMediaKey: (providerId, apiKey) => ipcRenderer.invoke('media:set-key', { providerId, apiKey }),
  clearMediaKey: (providerId) => ipcRenderer.invoke('media:clear-key', { providerId }),
  // v0.89c (Team E): trạng thái connection từng toolkit.
  getComposioConnectionStatus: (toolkits) =>
    ipcRenderer.invoke('composio:get-connection-status', { toolkits }),
  // v0.53 (P1-6): 1Password broker (camelCase aliases, same channels as above).
  onePasswordStatus: () => ipcRenderer.invoke('onepassword:status'),
  setOnePasswordEnabled: (enabled: boolean) => ipcRenderer.invoke('onepassword:set-enabled', { enabled }),
  onePasswordImportField: (payload) => ipcRenderer.invoke('onepassword:import-field', payload),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  openUpdateDownload: (url) => ipcRenderer.invoke('update:open-download', { url }),
};

contextBridge.exposeInMainWorld('openBot', openBot);
