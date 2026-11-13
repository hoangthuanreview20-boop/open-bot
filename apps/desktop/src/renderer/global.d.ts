/**
 * Renderer-side declaration for `window.openBot`.
 *
 * The real implementation lives in src/main/preload.ts (exposed through
 * contextBridge). This declaration mirrors that API in renderer-side types
 * (see ./types.ts) so the UI typechecks without importing main-process code.
 */
import type {
  A2aPersistStatusView,
  A2aSendResultView,
  AgentTemplateLike,
  ApiStatusView,
  ApprovalRequest,
  AskUserRequest,
  BotConfigLike,
  CanvasBlockView,
  CanvasDocumentView,
  CrashReportSummaryView,
  CrashReportView,
  DeepLinkRouteView,
  CanvasSummaryView,
  ChatMessageView,
  CheckpointSummaryView,
  ComposioStateView,
  ChannelMessageView,
  ChannelView,
  ComposioToolkitConnectionView,
  ComputerPlanView,
  ComputerStatusView,
  ComputersProbeView,
  ConnectedAppView,
  DetectedEnginesView,
  GroupBotInterruptedView,
  GroupBotStatusView,
  GroupChatView,
  GroupMessageView,
  HarnessEventView,
  HarnessPermissionRequestView,
  HarnessStatusView,
  HarnessThreadLogView,
  InternetDataStateView,
  InternetFeedItemView,
  InternetFeedView,
  InternetWatchChangeView,
  InternetWatchChangedPayloadView,
  InternetWatchView,
  InterruptDecisionView,
  InterruptRequestView,
  ListBotToolsResultView,
  ListBotSkillsResultView,
  McpAppFullViewLike,
  McpAppViewLike,
  McpMarketplaceProbeResultLike,
  McpMarketplaceServerLike,
  McpServerConfigLike,
  McpTaskViewLike,
  McpUpdateInfoLike,
  MediaKeyStatusView,
  MemoryBlockView,
  MemoryBlocksExportView,
  MemoryBlocksImportView,
  MemoryConsolidateView,
  MemoryEntryView,
  MemoryV2GraphView,
  MemoryV2ProvenanceView,
  MemoryV2SearchView,
  MemoryV2SleepView,
  // v0.98 (Đội T1): temporal knowledge graph views.
  GraphFactView,
  GraphEntityView,
  GraphSearchView,
  GraphStatsView,
  GraphQuarantineView,
  GraphShareView,
  GraphSleepConfigView,
  GraphSleepRunView,
  PluginMarketplaceViewLike,
  PluginDowngradeInfoLike,
  PluginDowngradeResultLike,
  PluginUpdateInfoLike,
  PreparedPluginLike,
  TrustedMarketplaceKeyLike,
  ModelRegistryView,
  OnePasswordBrokerStatusView,
  PluginView,
  ProviderRailView,
  PublishedAgentLike,
  RouterChangedPayloadView,
  RouterCliStatusView,
  RouterConfigView,
  RouterDecisionView,
  RouterStatsView,
  RouterTargetView,
  RouterTargetsView,
  ServiceAccountView,
  SetBotToolEnabledResultView,
  SetBotSkillEnabledResultView,
  SettingsView,
  SwitchModelView,
  TaskView,
  TeamConfigLike,
  TeamBundleView,
  TeamImportApplyResultView,
  TeamImportConflictView,
  TeamImportSummaryView,
  TeamRoleLike,
  ThreadSearchHitView,
  ThreadView,
  ToolCallView,
  TraceDetailView,
  TraceSummaryView,
  TrustedA2aAgentView,
  UpdateStatusView,
  UserProfilePatch,
  UserProfileView,
  WebhookView,
} from './types';
// v0.94c: renderer mirror of core VisionAttachment (composer.ts is
// import-free, so this creates no cycle — same pattern as ./types).
import type { VisionAttachment } from './components/composer';

export interface OpenBotApi {
  listBots(): Promise<BotConfigLike[]>;
  createBot(config: Partial<BotConfigLike>): Promise<BotConfigLike>;
  updateBot(config: BotConfigLike): Promise<BotConfigLike>;
  deleteBot(botId: string): Promise<boolean>;
  // M4: đổi model giữa chừng (không mất thread).
  switchModel(payload: { botId: string; providerId: string; model: string }): Promise<SwitchModelView>;
  // v0.63 (vision channel): images ride along as VisionAttachment
  // { mimeType, data (base64, no `data:` prefix), name? } — mirror of
  // core VisionAttachment (see renderer/components/composer.ts).
  // `text` may be empty when attachments are present (image-only).
  sendChat(botId: string, text: string, threadId?: string, attachments?: Array<{ mimeType: string; data: string; name?: string }>, planId?: string): Promise<{ ok: boolean; text?: string; error?: string; stopped?: boolean }>;
  // v0.60 (UI-6): slash commands of a bot, from the registry
  // (`<workspace>/.open-bot/commands/*.md` + bundle commands).
  // Preload exposes it via IPC `slash:list` (see preload.ts);
  // ChatView still guards with `typeof` so an old preload degrades
  // to the "no commands yet" hint instead of crashing.
  listSlashCommands(botId: string): Promise<Array<{ name: string; description: string }>>;
  // v0.59 (UI-2): stop the bot's current chat run (IPC `chat:stop`).
  stopChat(botId: string): Promise<{ botId: string; stopped: boolean; reason?: string }>;
  // v0.59 (UI-5): threads — một bot có nhiều hội thoại (mirror of preload).
  listThreads(botId: string): Promise<ThreadView[]>;
  createThread(botId: string, title?: string): Promise<ThreadView>;
  renameThread(threadId: string, title: string): Promise<ThreadView>;
  deleteThread(threadId: string): Promise<{ deleted: boolean }>;
  searchThreads(payload: { botId?: string; query: string }): Promise<ThreadSearchHitView[]>;
  onChatDelta(cb: (payload: { botId: string; delta: string }) => void): () => void;
  onToolCall(cb: (payload: { botId: string; call: ToolCallView }) => void): () => void;
  onToolResult(
    cb: (payload: { botId: string; result: { callId: string; ok: boolean; output: string } }) => void,
  ): () => void;
  onApprovalNeeded(cb: (payload: ApprovalRequest) => void): () => void;
  respondApproval(callId: string, approved: boolean, args?: Record<string, unknown>): void;
  // v0.50 (M8): permission từ CLI engine qua harness broker (mirror of preload).
  onHarnessPermissionNeeded(cb: (payload: HarnessPermissionRequestView) => void): () => void;
  respondHarnessPermission(requestId: string, allowed: boolean): void;
  // v0.50 (M8): group chat bot-bot (mirror of preload).
  createGroupChat(payload: { name: string; botIds?: string[] }): Promise<{ group: GroupChatView }>;
  listGroupChats(): Promise<GroupChatView[]>;
  addBotToGroupChat(payload: { groupId: string; botId: string }): Promise<{ added: boolean }>;
  removeBotFromGroupChat(payload: { groupId: string; botId: string }): Promise<{ removed: boolean }>;
  deleteGroupChat(payload: { groupId: string }): Promise<{ deleted: boolean }>;
  postGroupMessage(payload: {
    groupId: string;
    text: string;
    botId?: string;
    attachments?: VisionAttachment[];
  }): Promise<{ message: GroupMessageView; replies: GroupMessageView[] }>;
  listGroupMessages(payload: { groupId: string; limit?: number }): Promise<GroupMessageView[]>;
  // v0.94c: đọc lại bytes một ảnh đính kèm trong message nhóm.
  getGroupAttachment(payload: {
    groupId: string;
    messageId: string;
    attachmentId: string;
  }): Promise<{ attachment: VisionAttachment }>;
  // v0.79a: các bot đang chạy trong nhóm (GroupView poll).
  // v0.82: thêm `interrupted` — bot chạy dở thì app dừng.
  getGroupBotStatus(payload: { groupId: string }): Promise<{ groupId: string; running: GroupBotStatusView[]; interrupted: GroupBotInterruptedView[] }>;
  dismissGroupBotInterrupted(payload: { groupId: string; botId: string }): Promise<{ groupId: string; botId: string; dismissed: boolean }>;
  // v0.96 (Team T4): channels (mirror of preload).
  createChannel(payload: { name: string; kind?: 'work' | 'personal' | 'project'; sharedInstructions?: string; workingFolder?: string; botIds?: string[]; responderRules?: Partial<ChannelView['responderRules']> }): Promise<{ channel: ChannelView }>;
  listChannels(): Promise<ChannelView[]>;
  updateChannel(payload: { channelId: string; name?: string; kind?: 'work' | 'personal' | 'project'; sharedInstructions?: string; workingFolder?: string; responderRules?: Partial<ChannelView['responderRules']> }): Promise<{ channel: ChannelView }>;
  deleteChannel(payload: { channelId: string }): Promise<{ deleted: boolean }>;
  addBotToChannel(payload: { channelId: string; botId: string }): Promise<{ added: boolean }>;
  removeBotFromChannel(payload: { channelId: string; botId: string }): Promise<{ removed: boolean }>;
  moveBotBetweenChannels(payload: { fromChannelId: string; toChannelId: string; botId: string }): Promise<{ moved: boolean }>;
  postChannelMessage(payload: { channelId: string; text: string }): Promise<{ message: ChannelMessageView; responders: string[]; replies: ChannelMessageView[]; errors: Record<string, string> }>;
  listChannelMessages(payload: { channelId: string; limit?: number }): Promise<ChannelMessageView[]>;
  onBotsChanged(cb: (payload: { botId: string }) => void): () => void;
  // v0.86 (P2-6): deep-link `open-bot://` (mirror của preload.ts).
  onDeepLink(cb: (route: DeepLinkRouteView) => void): () => void;
  getPendingDeepLink(): Promise<DeepLinkRouteView | null>;
  onAskUser(cb: (payload: AskUserRequest) => void): () => void;
  respondAskUser(requestId: string, answer: string): void;
  // v0.54 (P1-8): interrupt HITL cho run dài (mirror of preload).
  onInterruptNeeded(cb: (payload: InterruptRequestView) => void): () => void;
  respondInterrupt(requestId: string, decision: InterruptDecisionView): void;
  listBotCheckpoints(botId: string): Promise<{ botId: string; runs: Array<{ runId: string; checkpoints: CheckpointSummaryView[] }> }>;
  interruptRun(runId: string, question?: string): Promise<{ runId: string; accepted: boolean; reason?: string }>;
  replayRun(botId: string, runId: string, stepIndex?: number | 'latest'): Promise<{ botId: string; text: string; stopped: boolean; runId?: string; replayedFromStep: number }>;
  // v0.54 (P1-10): telemetry client_persistence về main (chỉ log).
  reportClientPersistence(report: { storeKey: string; operation: string; error: string; at: string }): void;
  onProgress(cb: (payload: { botId: string; message: string }) => void): () => void;
  onFinalSummary(cb: (payload: { botId: string; summary: string }) => void): () => void;
  getHistory(botId: string, limit?: number, threadId?: string): Promise<ChatMessageView[]>;
  getSettings(): Promise<SettingsView>;
  setSettings(patch: {
    providers?: Record<string, { apiKey?: string; baseUrl?: string; defaultModel?: string }>;
    locale?: string;
    /** v0.86 (P2-7): bật/tắt crash reporting (opt-in, mặc định tắt). */
    crashReportingEnabled?: boolean;
    /** v0.87c: OS notifications theo từng loại (mặc định cả 3 bật). */
    notifications?: { runComplete?: boolean; approval?: boolean; runError?: boolean };
  }): Promise<SettingsView>;
  testConnection(providerId: string): Promise<{ ok: boolean; error?: string; models?: unknown }>;
  listTasks(botId: string): Promise<TaskView[]>;
  // v0.28: trạng thái lưu task A2A (cảnh báo UI khi lưu lỗi).
  getA2aPersistStatus(): Promise<A2aPersistStatusView>;
  onA2aPersistStatus(cb: (payload: A2aPersistStatusView) => void): () => void;
  // v0.31 (P1-2): A2A client — agent ngoài đã tin tưởng.
  listTrustedA2aAgents(): Promise<TrustedA2aAgentView[]>;
  addTrustedA2aAgent(url: string, token?: string): Promise<TrustedA2aAgentView>;
  removeTrustedA2aAgent(baseUrl: string): Promise<TrustedA2aAgentView[]>;
  sendToTrustedA2aAgent(baseUrl: string, message: string, timeoutMs?: number): Promise<A2aSendResultView>;
  // v0.97 (Đội T2 — A2A 1.0): policy mạng A2A + verify Agent Card.
  getA2aNetworkPolicy(): Promise<A2aNetworkPolicyView>;
  setA2aNetworkPolicy(policy: A2aNetworkPolicyView): Promise<{ policy: A2aNetworkPolicyView; localApiStillLoopback: boolean }>;
  verifyA2aCard(url: string, token?: string): Promise<A2aCardVerificationView>;
  // v0.11: plans stored on disk from earlier sessions (mirror of preload).
  'plans:list'(payload?: { botId?: string }): Promise<StoredPlanView[]>;
  listPlans(botId?: string): Promise<StoredPlanView[]>;
  // v0.20 (W13a): duyệt plan trực tiếp, không qua tool-call plan_update
  // trong run (mirror of preload; `note` chỉ dùng cho request-changes).
  'plans:review'(payload: {
    botId: string;
    projectId: string;
    decision: 'approve' | 'reject' | 'request-changes';
    note?: string;
  }): Promise<PlanReviewResultView>;
  reviewPlan(payload: {
    botId: string;
    projectId: string;
    decision: 'approve' | 'reject' | 'request-changes';
    note?: string;
  }): Promise<PlanReviewResultView>;
  // v0.98 (Team T4 — planning v2): run-bound plans (mirror of preload).
  createRunPlan(payload: {
    botId: string;
    title?: string;
    detail?: string;
    steps?: string[];
    templateId?: string;
    templateVars?: Record<string, string>;
  }): Promise<{ plan: RunPlanView; templateId: string | null }>;
  listRunPlans(): Promise<{ plans: RunPlanListView[] }>;
  getRunPlan(planId: string): Promise<{ plan: RunPlanListView | null }>;
  deleteRunPlan(planId: string): Promise<{ deleted: boolean }>;
  decideReplan(payload: {
    proposalId: string;
    decision: 'approve' | 'reject';
    runId?: string;
  }): Promise<{ proposal: ReplanProposalView; plan: RunPlanView | null }>;
  resumeRunPlans(): Promise<{
    resumed: RunPlanListView[];
    untouched: RunPlanListView[];
    skipped: string[];
  }>;
  listPlanTemplates(): Promise<{ templates: PlanTemplateView[] }>;
  onPlanEvent(cb: (event: PlanRunEventView) => void): () => void;
  // v0.35 (P1-7): auto-approve rules (mirror of preload).
  'auto-approve:list'(): Promise<AutoApproveRuleView[]>;
  listAutoApproveRules(): Promise<AutoApproveRuleView[]>;
  'auto-approve:add'(rule: AutoApproveRuleInputView): Promise<AutoApproveRuleView>;
  addAutoApproveRule(rule: AutoApproveRuleInputView): Promise<AutoApproveRuleView>;
  'auto-approve:remove'(id: string): Promise<boolean>;
  removeAutoApproveRule(id: string): Promise<boolean>;
  'auto-approve:set-enabled'(id: string, enabled: boolean): Promise<AutoApproveRuleView>;
  setAutoApproveRuleEnabled(id: string, enabled: boolean): Promise<AutoApproveRuleView>;
  listTemplates(): Promise<AgentTemplateLike[]>;
  cloneAgent(botId: string, name?: string): Promise<BotConfigLike>;
  publishAgent(
    botId: string,
    meta?: { description?: string; author?: string },
  ): Promise<PublishedAgentLike>;
  listMarketplace(): Promise<PublishedAgentLike[]>;
  installMarketplace(id: string): Promise<BotConfigLike>;
  uninstallMarketplace(id: string): Promise<boolean>;
  listMcpMarketplace(): Promise<McpMarketplaceServerLike[]>;
  listMcpInstalled(botId: string): Promise<McpServerConfigLike[]>;
  // v0.98 (T6): MCP Apps — interactive HTML from servers, sandboxed iframe.
  listMcpApps(): Promise<McpAppViewLike[]>;
  getMcpApp(id: string): Promise<McpAppFullViewLike | null>;
  openMcpApp(input: {
    serverName: string;
    toolName?: string;
    title: string;
    html: string;
    sourceUri?: string;
    origin: 'tool-result' | 'manual' | 'sample';
  }): Promise<McpAppViewLike>;
  closeMcpApp(id: string): Promise<boolean>;
  onMcpAppsChanged(cb: (apps: McpAppViewLike[]) => void): () => void;
  // v0.98 (T6): MCP Tasks — long-running tasks across all bot workspaces.
  listMcpTasks(): Promise<McpTaskViewLike[]>;
  cancelMcpTask(workspaceDir: string, key: string): Promise<McpTaskViewLike>;
  onMcpTasksChanged(cb: (tasks: McpTaskViewLike[]) => void): () => void;
  listMcpServerTools(id: string): Promise<McpMarketplaceProbeResultLike>;
  installMcpServer(
    id: string,
    botId: string,
    args?: string[],
    entry?: McpMarketplaceServerLike,
    version?: string,
  ): Promise<{
    server: McpMarketplaceServerLike;
    config: McpServerConfigLike;
    nextSteps: string[];
    version?: string;
  }>;
  uninstallMcpServer(id: string, botId: string): Promise<McpServerConfigLike>;
  // v0.89a (Marketplace v2): search / versions / remote catalog / approvals.
  searchMcpMarketplace(query?: string, tag?: string): Promise<McpMarketplaceServerLike[]>;
  checkMcpUpdates(botId: string): Promise<McpUpdateInfoLike[]>;
  updateMcpServer(id: string, botId: string, version?: string): Promise<{
    server: McpMarketplaceServerLike;
    config: McpServerConfigLike;
    nextSteps: string[];
    fromVersion: string | null;
    toVersion: string;
  }>;
  fetchRemoteMcpCatalog(url: string): Promise<McpMarketplaceServerLike[]>;
  approveMarketplace(
    kind: string,
    targetId: string,
    version?: string,
    source?: string,
  ): Promise<unknown>;
  listMarketplaceApprovals(): Promise<unknown[]>;
  // v0.89a (Marketplace v2): plugin marketplace.
  listPluginMarketplace(): Promise<PluginMarketplaceViewLike[]>;
  searchPluginMarketplace(query?: string): Promise<PluginMarketplaceViewLike[]>;
  preparePluginInstall(source: {
    kind: string;
    url?: string;
    path?: string;
  }): Promise<PreparedPluginLike>;
  installPluginMarketplace(stagingId: string): Promise<unknown>;
  updatePluginMarketplace(stagingId: string): Promise<unknown>;
  uninstallPluginMarketplace(id: string): Promise<boolean>;
  checkPluginUpdates(entries: unknown[]): Promise<PluginUpdateInfoLike[]>;
  // v0.94a: downgrade to the snapshotted previous version + trusted signing keys.
  getPluginDowngradeInfo(id: string): Promise<PluginDowngradeInfoLike>;
  downgradePluginMarketplace(id: string): Promise<PluginDowngradeResultLike>;
  listTrustedMarketplaceKeys(): Promise<TrustedMarketplaceKeyLike[]>;
  addTrustedMarketplaceKey(publicKey: string, label?: string): Promise<{ keyId: string }>;
  removeTrustedMarketplaceKey(keyId: string): Promise<boolean>;
  getTeam(): Promise<TeamConfigLike>;
  addTeamMember(member: { userId: string; name: string; role: TeamRoleLike }): Promise<TeamConfigLike>;
  removeTeamMember(userId: string): Promise<TeamConfigLike>;
  setTeamRole(userId: string, role: TeamRoleLike): Promise<TeamConfigLike>;
  shareBot(botId: string, sharedBy?: string): Promise<TeamConfigLike>;
  unshareBot(botId: string): Promise<TeamConfigLike>;
  listSharedBots(): Promise<string[]>;
  // v0.80: portable team bundle — export to / import from one JSON file.
  exportTeam(): Promise<
    | { cancelled: true }
    | { cancelled: false; path: string; summary: TeamImportSummaryView; skippedSkills: Array<{ name: string; reason: 'oversize' | 'empty'; chars: number }> }
  >;
  importTeam(): Promise<
    | { cancelled: true }
    | {
        cancelled: false;
        path: string;
        summary: TeamImportSummaryView;
        conflicts: TeamImportConflictView[];
        bundle: TeamBundleView;
      }
  >;
  importTeamApply(payload: { bundle: TeamBundleView; overwrite: boolean }): Promise<TeamImportApplyResultView>;
  // v0.4: Vault (key names only, never secret values) + usage.
  listVaultSecrets(): Promise<Record<string, string[]>>;
  setVaultSecret(namespace: string, key: string, value: string): Promise<boolean>;
  deleteVaultSecret(namespace: string, key: string): Promise<boolean>;
  getUsage(botId?: string): Promise<unknown>;
  getSpendLimits(): Promise<unknown>;
  setSpendLimits(limits: unknown): Promise<unknown>;
  resetUsage(scope: 'day' | 'month' | 'all'): Promise<{ removed: number; status: unknown }>;
  // v0.4: skills.
  listSkills(): Promise<
    Array<{
      name: string;
      description: string;
      version: string;
      whenToUse: string;
      tools: string[];
      source: string;
      pluginId: string | null;
      enabled: boolean;
    }>
  >;
  toggleSkill(name: string, enabled: boolean): Promise<boolean>;
  reloadSkills(): Promise<{ skills: string[]; errors: Array<{ file: string; error: string }> }>;
  // v0.66b: SkillsView — đọc toàn bộ SKILL.md + cài skill mới từ text dán.
  readSkill(name: string): Promise<{ name: string; content: string }>;
  installSkill(
    name: string,
    content: string,
  ): Promise<{
    name: string;
    description: string;
    version: string;
    whenToUse: string;
    tools: string[];
    source: string;
    pluginId: string | null;
    enabled: boolean;
  }>;
  // v0.86c: CanvasView — canvas của 1 bot (CanvasStore, @open-bot/core).
  listCanvases(botId: string): Promise<CanvasSummaryView[]>;
  getCanvas(botId: string, id: string): Promise<CanvasDocumentView>;
  deleteCanvas(botId: string, id: string): Promise<{ deleted: boolean }>;
  openCanvasInEditor(botId: string, id: string): Promise<{ opened: boolean }>;
  // v0.87c: OS notifications — request qua main (renderer không gọi
  // Electron Notification trực tiếp) + nút "Gửi thử" trong Settings.
  sendNotification(input: {
    kind: string;
    title: string;
    body: string;
    botId?: string;
    dedupeKey?: string;
  }): Promise<{ shown: boolean; reason?: string; suppressed?: number; detail?: string }>;
  testNotification(kind?: string): Promise<{ shown: boolean; reason?: string; suppressed?: number; detail?: string }>;
  // v0.86 (P2-7): crash reporting opt-in — chỉ đọc/xoá report local.
  listCrashReports(): Promise<CrashReportSummaryView[]>;
  getCrashReport(id: string): Promise<CrashReportView>;
  deleteCrashReport(id: string): Promise<{ deleted: boolean }>;
  deleteAllCrashReports(): Promise<{ deleted: number }>;
  reportRendererError(input: { message: string; stack?: string }): Promise<{ saved: boolean; id?: string }>;
  // v0.59 (UI-3): duyệt tool theo bot — màn Tools riêng.
  listBotTools(botId: string): Promise<ListBotToolsResultView>;
  setBotToolEnabled(
    botId: string,
    toolName: string,
    enabled: boolean,
  ): Promise<SetBotToolEnabledResultView>;
  // v0.95 (Team D1): Internet data — feeds + watched pages (IPC
  // `internet-data:*` trong main.ts).
  getInternetData(): Promise<InternetDataStateView>;
  subscribeInternetFeed(url: string, title?: string): Promise<{
    state: InternetDataStateView;
    added: boolean;
    itemCount: number;
  }>;
  unsubscribeInternetFeed(feed: string): Promise<InternetDataStateView>;
  readInternetFeed(feed: string, limit?: number): Promise<{
    feed: InternetFeedView;
    title: string;
    items: InternetFeedItemView[];
  }>;
  addInternetWatch(url: string, intervalMinutes?: number): Promise<{
    state: InternetDataStateView;
    added: boolean;
    watch: InternetWatchView;
  }>;
  removeInternetWatch(watch: string): Promise<InternetDataStateView>;
  checkInternetWatches(watch?: string): Promise<{
    state: InternetDataStateView;
    events: InternetWatchChangeView[];
  }>;
  onInternetWatchChanged(cb: (payload: InternetWatchChangedPayloadView) => void): () => void;
  // v0.64 (skills per-bot): duyệt skill theo bot — màn Tools riêng.
  listBotSkills(botId: string): Promise<ListBotSkillsResultView>;
  setBotSkillEnabled(
    botId: string,
    skillName: string,
    enabled: boolean,
  ): Promise<SetBotSkillEnabledResultView>;
  // v0.8: plugins.
  'plugins:list'(): Promise<{
    plugins: PluginView[];
    errors: Array<{ dir: string; error: string }>;
  }>;
  'plugins:toggle'(payload: { id: string; enabled: boolean }): Promise<{ id: string; enabled: boolean }>;
  listPlugins(): Promise<{
    plugins: PluginView[];
    errors: Array<{ dir: string; error: string }>;
  }>;
  togglePlugin(id: string, enabled: boolean): Promise<{ id: string; enabled: boolean }>;
  // v0.14: plugin templates + running-bot plugin toggle (mirror of preload).
  'plugin-templates:list'(): Promise<PluginTemplateView[]>;
  'plugin-templates:create'(input: CreatePluginTemplateInputView): Promise<PluginTemplateView>;
  'plugin-templates:apply'(payload: { id: string; overwrite?: boolean }): Promise<AppliedPluginTemplateView>;
  'plugin-templates:export'(payload: { id: string }): Promise<{ id: string; json: string }>;
  'plugin-templates:import'(payload: { json: string }): Promise<PluginTemplateView>;
  'plugin-templates:delete'(payload: { id: string }): Promise<boolean>;
  'plugin:set-enabled'(payload: { botId?: string | null; pluginId: string; enabled: boolean }): Promise<{
    id: string; enabled: boolean; appliedToRunning: boolean; runningError?: string;
  }>;
  listPluginTemplates(): Promise<PluginTemplateView[]>;
  createPluginTemplate(input: CreatePluginTemplateInputView): Promise<PluginTemplateView>;
  applyPluginTemplate(payload: { id: string; overwrite?: boolean }): Promise<AppliedPluginTemplateView>;
  exportPluginTemplate(payload: { id: string }): Promise<{ id: string; json: string }>;
  importPluginTemplate(payload: { json: string }): Promise<PluginTemplateView>;
  deletePluginTemplate(payload: { id: string }): Promise<boolean>;
  setPluginEnabled(payload: { botId?: string | null; pluginId: string; enabled: boolean }): Promise<{
    id: string; enabled: boolean; appliedToRunning: boolean; runningError?: string;
  }>;
  // v0.4: automations.
  listAutomations(): Promise<unknown[]>;
  getAutomation(id: string): Promise<unknown>;
  createAutomation(automation: unknown): Promise<unknown>;
  updateAutomation(automation: unknown): Promise<unknown>;
  deleteAutomation(id: string): Promise<boolean>;
  setAutomationEnabled(id: string, enabled: boolean): Promise<unknown>;
  runAutomationNow(id: string): Promise<unknown>;
  listAutomationRuns(automationId?: string): Promise<unknown[]>;
  // v0.74d: nạp dữ liệu mẫu vào store thật; sample đã có sẵn được bỏ qua.
  seedSampleAutomations(): Promise<{ created: unknown[]; skipped: string[] }>;
  // v0.52 P0-5: webhook trigger keys + delivery + retry-run.
  // create/rotate return { keyId, secret } with the secret shown once only.
  createAutomationWebhookKey(id: string): Promise<{ keyId: string; secret: string }>;
  // v0.97 (Team T5): harness v2 — routines, signed-webhook stats, health, NDJSON events.
  listHarnessRoutines(): Promise<unknown[]>;
  getHarnessRoutine(id: string): Promise<unknown>;
  createHarnessRoutine(routine: unknown): Promise<unknown>;
  updateHarnessRoutine(routine: unknown): Promise<unknown>;
  deleteHarnessRoutine(id: string): Promise<boolean>;
  setHarnessRoutineEnabled(id: string, enabled: boolean): Promise<unknown>;
  runHarnessRoutineNow(id: string): Promise<unknown>;
  retryHarnessRoutineRun(runId: string): Promise<unknown>;
  listHarnessRoutineRuns(routineId?: string): Promise<unknown[]>;
  getHarnessRoutineQueue(routineId: string): Promise<unknown>;
  getHarnessWebhookStats(): Promise<unknown>;
  probeHarnessHealth(): Promise<unknown[]>;
  tailHarnessEvents(threadId?: string, limit?: number): Promise<unknown>;
  onHarnessRunsChanged(
    cb: (event: { runId: string; routineId: string; status: string }) => void,
  ): () => void;
  onHarnessHealthChanged(cb: (health: unknown) => void): () => void;
  rotateAutomationWebhookKey(id: string): Promise<{ keyId: string; secret: string }>;
  deleteAutomationWebhookKey(id: string): Promise<boolean>;
  hasAutomationWebhookKey(id: string): Promise<boolean>;
  invokeAutomationWebhook(id: string, body: string, signature?: string | null): Promise<unknown>;
  testAutomationWebhook(id: string, payload?: unknown): Promise<unknown>;
  retryAutomationRun(runId: string): Promise<unknown>;
  retryLastFailedAutomationRun(automationId: string): Promise<unknown>;
  // v0.83b: Composio trigger — defs + signing secret + URL token + test.
  listComposioTriggerDefs(): Promise<Array<{ toolkit: string; slug: string; name: string; delivery: string }>>;
  setComposioTriggerSecret(id: string, secret: string): Promise<{ ok: boolean }>;
  hasComposioTriggerSecret(id: string): Promise<boolean>;
  deleteComposioTriggerSecret(id: string): Promise<boolean>;
  createComposioTriggerToken(id: string): Promise<{ keyId: string; secret: string }>;
  rotateComposioTriggerToken(id: string): Promise<{ keyId: string; secret: string }>;
  hasComposioTriggerToken(id: string): Promise<boolean>;
  deleteComposioTriggerToken(id: string): Promise<boolean>;
  testComposioTrigger(id: string, data?: unknown): Promise<unknown>;
  // v0.87a (P2-2): Slack inbound — signing secret (pasted by the
  // user, never returned) + mock test delivery of a Slack message.
  setSlackSigningSecret(id: string, secret: string): Promise<{ ok: boolean }>;
  hasSlackSigningSecret(id: string): Promise<boolean>;
  deleteSlackSigningSecret(id: string): Promise<boolean>;
  testSlackInbound(id: string, opts?: { text?: string; channelType?: string }): Promise<unknown>;
  // v0.4: dream.
  getDream(): Promise<{ enabled: boolean; idleMinutes?: number; cheapestModel?: string }>;
  setDream(config: { enabled: boolean; idleMinutes?: number }): Promise<unknown>;
  // v0.4: notification from automations/dream (main -> renderer, one way).
  onAutomationNotify(cb: (payload: { message: string; at: number }) => void): () => void;
  // v0.66a: an automation run changed (started/finished) — AutomationsView
  // subscribes to auto-refresh run history without re-entering the view.
  onAutomationRunsChanged(
    cb: (payload: { runId: string; automationId: string; status: string }) => void,
  ): () => void;
  // v0.4: voice.
  voiceAvailable(botId: string): Promise<{ available: boolean }>;
  voiceConnect(botId: string): Promise<{ ok: boolean; error?: string }>;
  voiceSendAudio(botId: string, audioBase64: string): void;
  voiceCommit(botId: string): Promise<{ ok: boolean; error?: string }>;
  voiceDisconnect(botId: string): Promise<{ ok: boolean }>;
  // v0.81: TTS (local-first) — read an answer aloud via the system
  // speech engine when one is installed; no paid service, no key.
  // v0.82: voice/rate selection + voice list.
  getTtsStatus(): Promise<{
    available: boolean;
    engineId: string | null;
    engines: Array<{ id: string; name: string; kind: string; available: boolean }>;
  }>;
  listTtsVoices(lang?: string): Promise<Array<{ id: string; name: string; lang: string }>>;
  speakText(
    text: string,
    lang?: string,
    opts?: { voice?: string; rate?: number },
  ): Promise<{ spoken: boolean; engineId: string | null; reason?: string }>;
  // v0.83: stop the utterance still speaking, if any.
  stopTts(): Promise<{ stopped: boolean; engineId: string | null }>;
  transcribeMemo(botId: string, audioBase64: string): Promise<{ ok: boolean; text?: string; error?: string }>;
  // v0.56: voice:surface + dictation PCM16.
  voiceSurfaceRegister(
    botId: string,
    surface: string,
    view?: string,
  ): Promise<{ ok: boolean; surfaceId?: string; surface?: string; maxReplyChars?: number; error?: string }>;
  voiceSurfaceUnregister(surfaceId: string): Promise<{ ok: boolean; error?: string }>;
  voiceSurfaceList(botId?: string): Promise<{ ok: boolean; surfaces?: unknown[]; error?: string }>;
  voiceDictation(botId: string, audioBase64: string): Promise<{ ok: boolean; text?: string; error?: string }>;
  onVoiceTranscript(cb: (payload: { botId: string; text: string; isFinal: boolean; surface?: string; surfaceIds?: string[] }) => void): () => void;
  onVoiceAudio(cb: (payload: { botId: string; audioBase64: string; surface?: string; surfaceIds?: string[] }) => void): () => void;
  onVoiceError(cb: (payload: { botId: string; message: string; surface?: string; surfaceIds?: string[] }) => void): () => void;
  onVoiceToolCall(cb: (payload: { botId: string; call: unknown; outcome?: unknown; surface?: string; surfaceIds?: string[] }) => void): () => void;
  onVoiceSurface(cb: (payload: { botId: string; surfaces: unknown[]; surface: string; surfaceIds: string[] }) => void): () => void;
  // v0.95 (Đội D3): voice realtime 2 chiều (RealtimeSession).
  voiceRealtimeConnect(
    botId: string,
    provider?: string,
    turnMode?: string,
  ): Promise<{ ok: boolean; provider?: string; turnMode?: string; state?: string; error?: string }>;
  voiceRealtimeDisconnect(botId: string): Promise<{ ok: boolean }>;
  voiceRealtimeMode(botId: string, turnMode: string): Promise<{ ok: boolean; turnMode?: string; error?: string }>;
  voiceRealtimeTalk(botId: string, held: boolean): Promise<{ ok: boolean; applied?: boolean; talkHeld?: boolean; error?: string }>;
  voiceRealtimeInterrupt(botId: string): Promise<{ ok: boolean; interrupted?: boolean; error?: string }>;
  voiceRealtimeSendAudio(botId: string, audioBase64: string): void;
  // v0.96 (Đội T5 — voice live): per-adapter health for the panel.
  // v0.98 adds mock flag + measured barge-in stats.
  voiceRealtimeHealth(botId: string): Promise<{
    ok: boolean;
    health?: unknown;
    latency?: unknown;
    mock?: boolean;
    bargeInStats?: unknown;
    lastBargeIn?: unknown;
    sessionId?: string;
    transcript?: unknown;
    error?: string;
  }>;
  // v0.98 (Đội T5 — voice live): key-gate decisions + local STT
  // probe + diagnostics, and the on-demand live Gemini Live check.
  voiceRealtimeKeyStatus(): Promise<{
    ok: boolean;
    decisions?: unknown;
    liveProviders?: unknown;
    localStt?: unknown;
    diagnostics?: unknown;
    error?: string;
  }>;
  voiceGeminiLiveReadiness(): Promise<{
    ok: boolean;
    readiness?: unknown;
    error?: string;
  }>;
  onVoiceRealtimeState(
    cb: (payload: { botId: string; kind: string; state?: string; source?: string; speaker?: string; at?: number }) => void,
  ): () => void;
  // v0.4: performance.
  getPerfStats(): Promise<{ ok: boolean; pool?: unknown; cache?: unknown }>;
  clearCache(): Promise<{ ok: boolean; error?: string }>;
  // v0.10: run tracing (JSONL spans per run; main only reads the file).
  'traces:list'(filter?: { botId?: string; runId?: string; limit?: number }): Promise<TraceSummaryView[]>;
  'traces:get'(query: { traceId?: string; runId?: string }): Promise<TraceDetailView | null>;
  listTraces(filter?: { botId?: string; runId?: string; limit?: number }): Promise<TraceSummaryView[]>;
  getTrace(query: { traceId?: string; runId?: string }): Promise<TraceDetailView | null>;
  // v0.90a (Đội G): harness event log — status + NDJSON log + live event.
  'harness:status'(): Promise<HarnessStatusView>;
  'harness:thread-log'(query: {
    threadId: string;
    limit?: number;
    offset?: number;
    kinds?: string[];
  }): Promise<HarnessThreadLogView>;
  getHarnessStatus(): Promise<HarnessStatusView>;
  getHarnessThreadLog(query: {
    threadId: string;
    limit?: number;
    offset?: number;
    kinds?: string[];
  }): Promise<HarnessThreadLogView>;
  onHarnessEvent(cb: (event: HarnessEventView) => void): () => void;
  // v0.5: model registry, local API, team workspace, service accounts, Vault NO_STORAGE.
  // Method names are the IPC channel names (quoted because of the colon).
  'models:list'(): Promise<ModelRegistryView>;
  'models:set-feature'(payload: { feature: string; providerId: string; model: string }): Promise<unknown>;
  'models:set-default'(payload: { providerId: string; model: string }): Promise<unknown>;
  'models:set-fallback'(payload: { providerId: string; model: string }): Promise<unknown>;
  'models:set-flag'(payload: { name: string; enabled: boolean }): Promise<unknown>;
  'models:ollama-list'(): Promise<string[]>;
  'models:ollama-pull'(model: string): Promise<{ ok: boolean; error?: string }>;
  'api:get'(): Promise<ApiStatusView>;
  'api:set'(patch: { enabled?: boolean; port?: number }): Promise<ApiStatusView>;
  'api:get-token'(): Promise<{ token: string | null }>;
  'api:regenerate-token'(): Promise<{ token: string }>;
  'api:webhooks-list'(): Promise<WebhookView[]>;
  'api:webhooks-add'(payload: { url: string; events: string[] }): Promise<WebhookView>;
  'api:webhooks-remove'(id: string): Promise<boolean>;
  'team:get-workspace'(): Promise<{ dir: string; teamId: string }>;
  'team:set-workspace-dir'(dir: string): Promise<{ dir: string; teamId: string }>;
  'team:service-accounts-list'(): Promise<ServiceAccountView[]>;
  'team:service-account-create'(payload: { name: string; scope: string }): Promise<ServiceAccountView>;
  'team:service-account-delete'(id: string): Promise<boolean>;
  // Sóng B (đội platform): máy tính riêng cho từng bot (IPC `computers:*`).
  'computers:probe'(): Promise<ComputersProbeView>;
  'computers:plan'(payload: { botIds: string[] }): Promise<ComputerPlanView>;
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
  'computers:queue'(): Promise<ComputerQueueView>;
  'computers:set-priority'(payload: { botId: string; priority: number }): Promise<ComputerQueueView>;
  'computers:set-auto-shed'(payload: { enabled: boolean }): Promise<ComputerQueueView>;
  'computers:guest-health'(botId: string): Promise<GuestAgentHealthView>;
  probeComputers(): Promise<ComputersProbeView>;
  planComputers(payload: { botIds: string[] }): Promise<ComputerPlanView>;
  createComputers(payload: { botIds: string[] }): Promise<ComputerStatusView[]>;
  listComputers(): Promise<ComputerStatusView[]>;
  startComputer(botId: string): Promise<ComputerStatusView>;
  pauseComputer(botId: string): Promise<ComputerStatusView>;
  resumeComputer(botId: string): Promise<ComputerStatusView>;
  stopComputer(botId: string): Promise<ComputerStatusView>;
  setComputerVmImage(payload: { botId: string; imagePath: string }): Promise<ComputerStatusView>;
  setComputerVmNetwork(payload: { botId: string; network: 'none' | 'nat' }): Promise<ComputerStatusView>;
  shedComputers(): Promise<{ paused: string[] }>;
  getComputerQueue(): Promise<ComputerQueueView>;
  setComputerPriority(payload: { botId: string; priority: number }): Promise<ComputerQueueView>;
  setComputerAutoShed(payload: { enabled: boolean }): Promise<ComputerQueueView>;
  checkComputerGuestHealth(botId: string): Promise<GuestAgentHealthView>;
  'vault:get-nostorage'(): Promise<{ enabled: boolean; pendingSecrets: number }>;
  'vault:set-nostorage'(
    enabled: boolean,
    opts?: { discardTemporarySecrets?: boolean },
  ): Promise<{ enabled: boolean; pendingSecrets: number }>;
  // v0.5: camelCase aliases (same channels; the renderer tries the
  // channel name first, then the camelCase spelling).
  listModels(): Promise<ModelRegistryView>;
  // M4: provider rail cho ModelPicker (IPC 'models:rail').
  // v0.90b: optional per-bot filter — sources disabled for this bot
  // plus its current provider; omitted = the global rail as before.
  listModelRail(payload?: {
    disabledProviders?: string[];
    currentProviderId?: string;
  }): Promise<ProviderRailView>;
  setModelFeature(payload: { feature: string; providerId: string; model: string }): Promise<unknown>;
  setDefaultModel(payload: { providerId: string; model: string }): Promise<unknown>;
  setFallbackModel(payload: { providerId: string; model: string }): Promise<unknown>;
  setFeatureFlag(payload: { name: string; enabled: boolean }): Promise<unknown>;
  listOllamaModels(): Promise<string[]>;
  pullOllamaModel(model: string): Promise<{ ok: boolean; error?: string }>;
  // M1: detected CLI engines (Settings → Engines).
  listEngines(): Promise<DetectedEnginesView>;
  redetectEngines(): Promise<DetectedEnginesView>;
  // M4: quét lại chỉ một engine.
  redetectEngine(payload: { kind: string }): Promise<DetectedEnginesView>;
  setEngineEnabled(payload: { kind: string; enabled: boolean }): Promise<DetectedEnginesView>;
  // M3: custom ACP CLI ("Set CLI…" in Settings → Engines) + live
  // snapshot push after redetect / toggle / custom CLI change.
  listCustomClis(): Promise<Array<{
    id: string;
    label: string;
    binaryPath: string;
    acpArgs: string[];
    statusArgs?: string[];
  }>>;
  addCustomCli(payload: {
    id: string;
    label: string;
    binaryPath: string;
    acpArgs: string[];
    statusArgs?: string[];
  }): Promise<DetectedEnginesView>;
  updateCustomCli(payload: {
    id: string;
    label?: string;
    binaryPath?: string;
    acpArgs?: string[];
    statusArgs?: string[];
  }): Promise<DetectedEnginesView>;
  removeCustomCli(payload: { id: string }): Promise<DetectedEnginesView>;
  onEnginesChanged(cb: (snapshot: DetectedEnginesView) => void): () => void;
  // v0.98 (Đội T2): router — lịch sử quyết định, thống kê, cấu hình,
  // đích khám phá được (IPC `router:*`).
  getRouterDecisions(payload?: { botId?: string; limit?: number }): Promise<{
    decisions: RouterDecisionView[];
    total: number;
  }>;
  getRouterStats(payload?: { botId?: string }): Promise<RouterStatsView>;
  getRouterConfig(): Promise<RouterConfigView>;
  setRouterConfig(config: Partial<RouterConfigView>): Promise<RouterConfigView>;
  clearRouterLog(payload?: { botId?: string }): Promise<{ cleared: number }>;
  getRouterTargets(): Promise<RouterTargetsView>;
  onRouterChanged(cb: (payload: RouterChangedPayloadView) => void): () => void;
  getApiStatus(): Promise<ApiStatusView>;
  setApiStatus(patch: { enabled?: boolean; port?: number }): Promise<ApiStatusView>;
  getApiToken(): Promise<{ token: string | null }>;
  regenerateApiToken(): Promise<{ token: string }>;
  listWebhooks(): Promise<WebhookView[]>;
  addWebhook(payload: { url: string; events: string[] }): Promise<WebhookView>;
  removeWebhook(id: string): Promise<boolean>;
  getTeamWorkspace(): Promise<{ dir: string; teamId: string }>;
  setTeamWorkspaceDir(dir: string): Promise<{ dir: string; teamId: string }>;
  listServiceAccounts(): Promise<ServiceAccountView[]>;
  createServiceAccount(payload: { name: string; scope: string }): Promise<ServiceAccountView>;
  deleteServiceAccount(id: string): Promise<boolean>;
  getVaultNoStorage(): Promise<{ enabled: boolean; pendingSecrets: number }>;
  setVaultNoStorage(
    enabled: boolean,
    opts?: { discardTemporarySecrets?: boolean },
  ): Promise<{ enabled: boolean; pendingSecrets: number }>;
  // v0.7: đăng nhập đa tầng + OAuth + tự cập nhật.
  'auth:profile-get'(): Promise<{ userId: string; displayName: string; createdAt: number }>;
  'auth:profile-set'(payload: { displayName?: string }): Promise<{ userId: string; displayName: string; createdAt: number }>;
  'auth:identities-list'(): Promise<Array<{ providerId: string; identity: { id: string; displayName?: string; email?: string; updatedAt: number } | null }>>;
  'auth:identity-delete'(payload: { providerId: string }): Promise<boolean>;
  'auth:oauth-supported'(): Promise<Array<{ id: string; label: string }>>;
  'auth:oauth-start'(payload: { providerId: string; clientId?: string; clientSecret?: string; connectorId?: string }): Promise<{ ok: boolean; providerId: string; displayName?: string; error?: string }>;
  // M7: connected apps — catalog + trạng thái auth + ngắt kết nối.
  'apps:list'(): Promise<ConnectedAppView[]>;
  'apps:disconnect'(payload: { appId: string }): Promise<ConnectedAppView[]>;
  // v0.68b: M7 app token (PAT dán tay, vd GitHub) — lưu token thô vào Vault, không trả về renderer.
  'apps:set-token'(payload: { appId: string; token: string }): Promise<ConnectedAppView[]>;
  // v0.53 (P1-6): 1Password broker — status không chứa secret;
  // import-field ghi thẳng 1 field vào Vault ở main, chỉ trả {stored}.
  // v0.59: status kèm cờ `enabled`; `set-enabled` bật/tắt broker.
  'onepassword:status'(): Promise<OnePasswordBrokerStatusView>;
  'onepassword:set-enabled'(payload: { enabled: boolean }): Promise<{ enabled: boolean }>;
  'onepassword:import-field'(payload: { itemId: string; field: string; namespace: string; key: string; saveToVault?: boolean }): Promise<{ stored: boolean }>;
  'update:check'(): Promise<{ available: boolean; currentVersion: string; latestVersion: string | null; latestTag: string | null; htmlUrl: string | null; checkFailed: boolean; error?: string }>;
  'update:open-download'(payload: { url: string }): Promise<boolean>;
  // v0.7: camelCase aliases (same channels).
  getLocalProfile(): Promise<{ userId: string; displayName: string; createdAt: number }>;
  setLocalProfile(displayName: string): Promise<{ userId: string; displayName: string; createdAt: number }>;
  // v0.95d4 (Đội D4): user profile đầy đủ + long-term memory (local-first).
  getUserProfile(): Promise<UserProfileView | null>;
  updateUserProfile(patch: UserProfilePatch): Promise<UserProfileView>;
  listMemories(payload: { botId: string; query?: string; tag?: string; limit?: number }): Promise<MemoryEntryView[]>;
  updateMemory(payload: { botId: string; id: string; value?: string; tags?: string[]; confidence?: number }): Promise<MemoryEntryView>;
  deleteMemory(payload: { botId: string; id: string }): Promise<{ deleted: boolean }>;
  exportMemories(payload: { botId: string }): Promise<string>;
  getMemoryStatus(payload: { botId: string }): Promise<{ total: number; embedded: number; ollamaAvailable: boolean; embeddingModel: string }>;
  // v0.96 (Đội T1): memory blocks — CRUD + attach/detach/share +
  // read-only + MemFS export/import + consolidate.
  listMemoryBlocks(payload: { botId: string; includeDetached?: boolean }): Promise<MemoryBlockView[]>;
  createMemoryBlock(payload: { botId: string; label: string; description?: string; content?: string; charLimit?: number; readOnly?: boolean }): Promise<MemoryBlockView>;
  updateMemoryBlock(payload: { botId: string; id: string; description?: string; content?: string; charLimit?: number }): Promise<MemoryBlockView>;
  appendMemoryBlock(payload: { botId: string; id: string; text: string }): Promise<MemoryBlockView>;
  deleteMemoryBlock(payload: { botId: string; id: string }): Promise<{ deleted: boolean }>;
  attachMemoryBlock(payload: { botId: string; blockId: string; targetBotId?: string }): Promise<MemoryBlockView>;
  detachMemoryBlock(payload: { botId: string; blockId: string; targetBotId?: string }): Promise<MemoryBlockView>;
  shareMemoryBlock(payload: { botId: string; blockId: string; targetBotId?: string; all?: boolean; botIds?: string[] }): Promise<{ shared: boolean; all?: boolean; newlyAttachedBots?: string[]; botId?: string; block?: MemoryBlockView }>;
  setMemoryBlockReadOnly(payload: { botId: string; id: string; readOnly: boolean }): Promise<MemoryBlockView>;
  exportMemoryBlocks(payload: { botId: string }): Promise<MemoryBlocksExportView>;
  importMemoryBlocks(payload: { botId: string }): Promise<MemoryBlocksImportView>;
  consolidateMemory(payload: { botId: string; action: string; enabled?: boolean; idleMinutes?: number }): Promise<MemoryConsolidateView>;
  // v0.97 (Team T4): memory v2 — graph + hybrid search + sleep agent + provenance.
  getMemoryV2Graph(payload: { botId: string; at?: string }): Promise<MemoryV2GraphView>;
  searchMemoryV2(payload: { botId: string; query: string; topK?: number }): Promise<MemoryV2SearchView>;
  getMemoryV2Sleep(payload: { botId: string; action: string; enabled?: boolean; stepsThreshold?: number }): Promise<MemoryV2SleepView>;
  getMemoryV2Provenance(payload: { botId: string }): Promise<MemoryV2ProvenanceView>;
  // v0.98 (Đội T1): temporal knowledge graph.
  searchMemoryGraph(payload: { botId: string; query: string; topK?: number }): Promise<GraphSearchView>;
  ingestMemoryGraph(payload: { botId: string; text: string; turnId?: string; role?: string }): Promise<{ ingested: boolean; duplicate?: boolean; episodeId?: string; added?: number; updated?: number; deleted?: number; quarantined?: number; skipped?: number }>;
  listMemoryGraphFacts(payload: { botId: string; status?: string; predicate?: string; limit?: number }): Promise<GraphFactView[]>;
  listMemoryGraphEntities(payload: { botId: string; limit?: number }): Promise<GraphEntityView[]>;
  getMemoryGraphHistory(payload: { botId: string; factId: string }): Promise<GraphFactView[]>;
  getMemoryGraphStats(payload: { botId: string }): Promise<GraphStatsView>;
  deleteMemoryGraphFact(payload: { botId: string; factId: string }): Promise<{ deleted: boolean; fact: GraphFactView }>;
  reviewMemoryGraphQuarantine(payload: { botId: string; action: string; id?: string }): Promise<{ item?: GraphQuarantineView; fact?: GraphFactView } | GraphQuarantineView[]>;
  shareMemoryGraph(payload: { botId: string; action: string; targetBotId?: string; readOnly?: boolean }): Promise<GraphShareView | GraphShareView[] | { removed: boolean }>;
  searchSharedMemoryGraph(payload: { botId: string; sourceBotId: string; query: string; topK?: number }): Promise<GraphSearchView & { sourceBotId: string; readOnly: boolean }>;
  getMemoryGraphSleep(payload: { botId: string; action: string; enabled?: boolean; afterTurns?: number; maxSteps?: number; batchSize?: number }): Promise<{ action: string; config: GraphSleepConfigView; runs: GraphSleepRunView[] } | GraphSleepRunView>;
  listProviderIdentities(): Promise<Array<{ providerId: string; identity: { id: string; displayName?: string; email?: string; updatedAt: number } | null }>>;
  deleteProviderIdentity(providerId: string): Promise<boolean>;
  listOAuthProviders(): Promise<Array<{ id: string; label: string }>>;
  startOAuthLogin(providerId: string, clientId?: string, clientSecret?: string, connectorId?: string): Promise<{ ok: boolean; providerId: string; displayName?: string; error?: string }>;
  // M7: connected apps (camelCase aliases, same channels as above).
  listConnectedApps(): Promise<ConnectedAppView[]>;
  disconnectConnectedApp(appId: string): Promise<ConnectedAppView[]>;
  // v0.68b: M7 app token (PAT dán tay, vd GitHub).
  setConnectedAppToken(appId: string, token: string): Promise<ConnectedAppView[]>;
  // v0.57: Composio — opt-in (key chỉ nằm trong Vault, không trả về renderer).
  getComposioState(): Promise<ComposioStateView>;
  setComposioEnabled(enabled: boolean): Promise<ComposioStateView>;
  setComposioAppEnabled(toolkit: string, enabled: boolean): Promise<ComposioStateView>;
  setComposioKey(apiKey: string): Promise<ComposioStateView>;
  clearComposioKey(): Promise<ComposioStateView>;
  // v0.88b: Composio user id — opt-in (chỉ vào Vault, không trả về renderer).
  setComposioUserId(userId: string): Promise<ComposioStateView>;
  clearComposioUserId(): Promise<ComposioStateView>;
  // v0.95 (Team D2): Media keys — opt-in (key chỉ vào Vault, không trả về renderer;
  // get-status chỉ trả {configured, suffix}, suffix = 4 ký tự cuối của key).
  getMediaKeyStatus(): Promise<MediaKeyStatusView>;
  setMediaKey(providerId: string, apiKey: string): Promise<MediaKeyStatusView>;
  clearMediaKey(providerId: string): Promise<MediaKeyStatusView>;
  // v0.89c (Team E): trạng thái connection từng toolkit.
  getComposioConnectionStatus(toolkits?: string[]): Promise<ComposioToolkitConnectionView[]>;
  // v0.53 (P1-6): 1Password broker (camelCase aliases, same channels as above).
  onePasswordStatus(): Promise<OnePasswordBrokerStatusView>;
  setOnePasswordEnabled(enabled: boolean): Promise<{ enabled: boolean }>;
  onePasswordImportField(payload: { itemId: string; field: string; namespace: string; key: string; saveToVault?: boolean }): Promise<{ stored: boolean }>;
  checkForUpdate(): Promise<{ available: boolean; currentVersion: string; latestVersion: string | null; latestTag: string | null; htmlUrl: string | null; checkFailed: boolean; error?: string }>;
  openUpdateDownload(url: string): Promise<boolean>;
  // v0.54 (P1-9): update theo track (UpdateService trong main).
  getUpdateStatus(): Promise<UpdateStatusView>;
  setUpdateTrack(track: string): Promise<UpdateStatusView>;
  checkForUpdates(trigger?: 'startup' | 'periodic' | 'manual'): Promise<UpdateStatusView>;
  quitAndInstallUpdate(): Promise<{ installed: boolean; reason: string }>;
}

declare global {
  interface Window {
    openBot: OpenBotApi;
  }
}

/** v0.14: plugin template shapes (mirror of core PluginTemplate). */
interface PluginTemplateView {
  id: string;
  name: string;
  description: string;
  manifest: {
    id: string;
    name: string;
    version: string;
    description: string;
    author?: string;
    permissions: string[];
    main: string;
    tools?: string[];
  };
  config: Record<string, unknown>;
  createdAt: string;
}

interface CreatePluginTemplateInputView {
  id: string;
  name: string;
  description: string;
  manifest: {
    id: string;
    name: string;
    version: string;
    description: string;
    author?: string;
    permissions: Array<'fs' | 'shell' | 'network' | 'mcp'>;
    main: string;
    tools?: string[];
  };
  config?: Record<string, unknown>;
}

interface AppliedPluginTemplateView {
  dir: string;
  manifest: PluginTemplateView['manifest'];
  hasEntry: boolean;
  configPath: string;
}

/** v0.11: one plan read back from disk (mirror of StoredPlan in preload). */
interface StoredPlanView {
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

/** v0.20 (W13a): result of a direct plan review (mirror of PlanReviewResult in preload). */
interface PlanReviewResultView {
  projectId: string;
  botId: string;
  status: 'pending' | 'approved' | 'rejected' | 'changes-requested';
  mode: string;
  note: string;
  filePath: string;
  fileStatusUpdated: boolean;
}

/** v0.98 (Team T4 — planning v2): run-bound plan (mirror of preload RunPlan*). */
interface RunPlanStepView {
  id: string;
  title: string;
  detail?: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  assigneeBotId?: string | null;
  attempts: number;
  error?: string;
  startedAt?: number | null;
  finishedAt?: number | null;
}

interface RunPlanView {
  id: string;
  title: string;
  detail?: string;
  ownerBotId?: string | null;
  steps: RunPlanStepView[];
  createdAt: number;
  updatedAt: number;
}

interface ReplanProposalView {
  id: string;
  planId: string;
  stuckStepId: string | null;
  reason: 'repeated-tool-call' | 'no-progress' | 'stall' | 'error-repeat' | 'tool-cycle';
  summary: string;
  changes: Array<{
    type: 'insert' | 'replace' | 'skip' | 'remove';
    stepId: string | null;
    title?: string;
    detail?: string;
    reason: string;
  }>;
  decision: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  decidedAt?: number | null;
}

interface RunPlanListView {
  plan: RunPlanView;
  runId: string | null;
  botId: string | null;
  templateId?: string | null;
  proposals: ReplanProposalView[];
}

interface PlanRunEventView {
  type:
    | 'run-started'
    | 'step-started'
    | 'step-done'
    | 'step-failed'
    | 'run-finished'
    | 'run-stopped'
    | 'stuck'
    | 'replan-proposed'
    | 'replan-applied'
    | 'replan-rejected'
    | 'plan-finished';
  runId: string;
  botId: string;
  planId: string;
  plan: RunPlanView;
  progress: {
    total: number;
    done: number;
    failed: number;
    skipped: number;
    running: number;
    pending: number;
    percent: number;
    finished: boolean;
  };
  stepId?: string;
  stuck?: {
    reason: ReplanProposalView['reason'];
    detail: string;
    signature?: string;
    repeatCount?: number;
    failedSteps?: number;
    stalledForMs?: number;
    error?: string;
    errorCount?: number;
    cycle?: string;
    cycleCount?: number;
    suggestions: string[];
  };
  proposal?: ReplanProposalView;
}

interface PlanTemplateView {
  id: string;
  title: string;
  stepCount: number;
  variables: Array<{ name: string; required: boolean; hint: string }>;
}

/** v0.35 (P1-7): one auto-approve rule (mirror of AutoApproveRule in core). */
interface AutoApproveRuleView {
  id: string;
  kind: 'shell' | 'tool';
  enabled: boolean;
  scope: 'global' | 'bot';
  botId?: string;
  pattern?: string;
  tool?: string;
  argsPattern?: Record<string, string | number | boolean>;
  note?: string;
  createdAt: number;
}

/** v0.35 (P1-7): input for adding an auto-approve rule (mirror of AutoApproveRuleInput). */
interface AutoApproveRuleInputView {
  kind: 'shell' | 'tool';
  enabled?: boolean;
  scope: 'global' | 'bot';
  botId?: string;
  pattern?: string;
  tool?: string;
  argsPattern?: Record<string, string | number | boolean>;
  note?: string;
}

export {};
