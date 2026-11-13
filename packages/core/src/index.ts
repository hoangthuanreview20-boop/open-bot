/**
 * @open-bot/core — public surface.
 * Shared types, LLM providers, agent loop, SQLite memory and routines.
 */

export type * from './types';

export {
  createProvider,
  PROVIDERS,
  AnthropicProvider,
  ClaudeCodeCliProvider,
  CLAUDE_CODE_MODEL_ID,
  CLAUDE_CODE_PROVIDER_ID,
  CodexCliProvider,
  CODEX_MODEL_ID,
  CODEX_PROVIDER_ID,
  GrokCliProvider,
  GROK_CLI_MODEL_ID,
  GROK_CLI_PROVIDER_ID,
  GeminiProvider,
  OllamaProvider,
  OLLAMA_BASE_URL,
  OLLAMA_DEFAULT_MODEL,
  OpenAIProvider,
  OpenAICompatibleProvider,
  XAIProvider,
} from './providers/index';
export type { ProviderMeta } from './providers/index';

// M1: detected CLI engines (detector registry + snapshot) + CLI drivers.
export {
  DetectedEngineRegistry,
  DETECT_CACHE_TTL_MS,
  DETECTED_ENGINES_FILE,
  KNOWN_ENGINE_KINDS,
  BUILTIN_DETECTORS,
} from './detected/index';
export type {
  AuthCheck,
  CustomAcpCliConfig,
  DetectedEngineKind,
  DetectedEngineSnapshot,
  DetectedEnginesSnapshot,
  DetectedEnginesStateFile,
  DetectorDefinition,
  EngineAccount,
  EngineStatus,
  EngineUnavailableReason,
  ProbeResult,
} from './detected/index';
export type { DetectedEngineRegistryOptions } from './detected/index';
export { sanitizeEnvForCli, killProcessGroup } from './providers/cli/index';
export {
  AcpClient,
  AiderCliProvider,
  AIDER_MODEL_ID,
  AIDER_PROVIDER_ID,
  AmazonQCliProvider,
  AMAZON_Q_MODEL_ID,
  AMAZON_Q_PROVIDER_ID,
  BaseAcpCliProvider,
  BaseOneShotCliProvider,
  ONE_SHOT_CLI_DEFAULT_TIMEOUT_MS,
  CodexAppServerClient,
  ContinueCliProvider,
  CONTINUE_CLI_MODEL_ID,
  CONTINUE_CLI_PROVIDER_ID,
  CopilotCliProvider,
  COPILOT_CLI_MODEL_ID,
  COPILOT_CLI_PROVIDER_ID,
  CursorCliProvider,
  CustomAcpCliProvider,
  GeminiCliProvider,
  JsonRpcResponseError,
  JsonRpcStdioClient,
  KiroCliProvider,
  KIRO_CLI_MODEL_ID,
  KIRO_CLI_PROVIDER_ID,
  OpenCodeCliProvider,
  WindsurfCliProvider,
  WINDSURF_MODEL_ID,
  WINDSURF_PROVIDER_ID,
  denyCodexApproval,
  isCodexApprovalRequest,
  isDevinCliBinary,
} from './providers/cli/index';
// M3: custom ACP CLI (Settings → Engines → "Set CLI…").
export {
  CUSTOM_ACP_KIND_PREFIX,
  customAcpDetectorDefinition,
  customAcpIdFromKind,
  customAcpKind,
  isCustomAcpKind,
  validateCustomAcpCliConfig,
} from './detected/index';
export { isEngineUsable, isEngineUsableAllowingUnknown, usableCustomEngineBinary, usableEngineBinary } from './detected/index';
export type {
  CliEvent,
  AiderCliProviderOptions,
  AmazonQCliProviderOptions,
  ClaudeCodeCliProviderOptions,
  CliPermissionHandler,
  CodexCliProviderOptions,
  ContinueCliProviderOptions,
  CopilotCliProviderOptions,
  CursorCliProviderOptions,
  CustomAcpCliProviderOptions,
  GeminiCliProviderOptions,
  GrokCliProviderOptions,
  KiroCliProviderOptions,
  OneShotCliProviderIdentity,
  OneShotCliProviderOptions,
  OpenCodeCliProviderOptions,
  WindsurfCliProviderOptions,
} from './providers/cli/index';

// M5: harness local chuẩn hoá (registry + event bus + NDJSON log + snapshot + permission broker).
export {
  HarnessEventBus,
  HarnessRegistry,
  LocalHarness,
  PermissionBroker,
  PERMISSION_DEFAULT_TIMEOUT_MS,
  ThreadLog,
  HARNESS_SNAPSHOT_FILE_NAME,
  HARNESS_LOG_STRING_LIMIT,
  harnessKindOfCliEvent,
  harnessPayloadOfCliEvent,
  readHarnessSnapshot,
  safeThreadFileName,
  sanitizeHarnessPayload,
  writeHarnessSnapshotAtomic,
} from './harness/index';
export type {
  HarnessDecidePermissionResult,
  HarnessEvent,
  HarnessEventFilter,
  HarnessEventHandler,
  HarnessEventKind,
  HarnessInstanceSnapshot,
  HarnessInstanceStatus,
  HarnessPermissionRequest,
  HarnessSnapshotFile,
  HarnessStatusResult,
  HarnessThreadLogResult,
  LocalHarnessOptions,
  PermissionBrokerOptions,
  PermissionDecisionRecord,
  PermissionDecisionSource,
  PermissionRequestInput,
  ThreadLogEntry,
  ThreadLogPage,
} from './harness/index';

// M6: bot box / sandbox theo turn + egress gate (local).
export {
  BotBoxManager,
  BOXES_REL_DIR,
  DEFAULT_BOX_ENV_VARS,
  DEFAULT_BOX_LIMITS,
  EgressGate,
  SIGNIN_SETTLE_MS,
  attachBoxToSession,
  boxDaemonExecRequest,
  buildBoxEnv,
  commandAvailable,
  defaultBoxEnvValues,
  detectIsolation,
  dirFileCount,
  dirSizeBytes,
  isolationKindAvailable,
  listSignInStates,
  publishBoxLifecycle,
  readSignInState,
  signInStateFileName,
  syncSignInState,
  validateBoxEnvNames,
  waitSettled,
  writeSignInState,
} from './sandbox/index';
export type {
  AppliedResourceLimits,
  BotBox,
  BotBoxOptions,
  BoxDaemonExecRequest,
  BoxLifecycleAction,
  BoxManagerOptions,
  BoxResourceLimits,
  BoxRunResult,
  BuildBoxEnvOptions,
  EgressGateInfo,
  EgressGateOptions,
  GateDecisionLog,
  IsolationInfo,
  IsolationKind,
  ResolvedBoxLimits,
  RunInBoxOptions,
  SignInState,
  SignInStatus,
} from './sandbox/index';

// Sóng B (đội platform): máy tính riêng cho từng bot — probe + planner + runtime.
export {
  BotComputerRuntime,
  CGROUP_MIN_MEMORY_BYTES,
  CGROUP_NAME_PREFIX,
  CGROUP_ROOT_DEFAULT,
  COMPUTER_AUTO_SHED_AUDIT_ACTION,
  COMPUTERS_FILE,
  CgroupMemoryLimiter,
  DEFAULT_COMPUTER_MAX_PROCESSES,
  DEFAULT_COMPUTER_PRIORITY,
  DEFAULT_PLANNER_POLICY,
  GB,
  GUEST_AGENT_DEFAULT_TIMEOUT_MS,
  GUEST_AGENT_INSTALL_HINT,
  GUEST_AGENT_MAX_OUTPUT_BYTES,
  GUEST_AGENT_MAX_RECONNECT_ATTEMPTS,
  GUEST_AGENT_PING_TIMEOUT_MS,
  GUEST_AGENT_PORT_NAME,
  GUEST_AGENT_RECONNECT_DELAY_MS,
  GUEST_AGENT_VERSION,
  GUEST_HEALTH_CHECK_MIN_INTERVAL_MS,
  GuestAgentClient,
  LEVEL_DEFAULTS,
  MAX_QUEUE_ENTRIES,
  buildQemuBootArgs,
  clampPriority,
  detectComputerBackends,
  emptySchedulerState,
  enqueueRequest,
  fakeMachineProfile,
  isHostBusy,
  levelFeasible,
  parseSchedulerState,
  planComputers,
  probeCgroupMemory,
  probeMachine,
  removeFromQueue,
  resolvePlannerPolicy,
  selectAutoShedCandidates,
  setQueuePriority,
  sortQueueEntries,
  suggestShedOrder,
  tryPromoteQueue,
} from './compute/index';
export type {
  BotComputer,
  BotComputerRequest,
  BotComputerRuntimeOptions,
  CgroupMemoryLimiterOptions,
  CgroupMemoryProbe,
  ComputerAllocation,
  ComputerBackend,
  ComputerBackendKind,
  ComputerLevel,
  ComputerPlan,
  ComputerQueueEntry,
  ComputerSchedulerState,
  ComputerState,
  ComputerStatusView,
  CpuInfo,
  DiskInfo,
  GpuInfo,
  GuestAgentExecOptions,
  GuestAgentExecResult,
  GuestAgentHealth,
  GuestAgentHealthStatus,
  GuestAgentInfo,
  GuestAgentPingResult,
  MachineProfile,
  MemoryInfo,
  NetworkInfo,
  PlannerPolicy,
  ProbeCommandResult,
  ProbeDeps,
  ProbeOs,
  SchedulerTickResult,
  VirtualizationInfo,
} from './compute/index';

export { AgentRunner } from './agent/loop';export type { AgentRunnerOptions, ForkSkillInput, ToolCallRecorder } from './agent/loop';

// v0.63 (vision channel): image attachments run → loop → provider.
export {
  OLLAMA_VISION_MODEL_SUGGESTIONS,
  VISION_ALLOWED_MIME_TYPES,
  VISION_MAX_IMAGE_BYTES,
  VISION_MAX_IMAGES,
  VISION_MAX_TOTAL_BYTES,
  formatVisionBytes,
  ollamaModelSupportsVision,
  providerSupportsVision,
  validateVisionAttachments,
  visionImageBytes,
  visionUnsupportedMessage,
} from './agent/vision';
export type { VisionValidationResult } from './agent/vision';

export {
  SMALL_CONTEXT_THRESHOLD_TOKENS,
  assertFitsSmallModel,
  effectiveContextLimit,
  estimateFirstRequestTokens,
  estimateTextTokens,
  inferContextLimitFromModelName,
  isSmallContextModel,
  SmallModelContextError,
} from './agent/smallModel';
// Ước lượng token dùng chung (tokens.ts): compaction + smallModel đều dùng.
export { estimateTokens } from './agent/tokens';
// NOTE: smallModel cũng có `estimateMessagesTokens` riêng, nhưng barrel đã
// export tên đó từ './agent/compaction' nên không export lại ở đây (tránh
// trùng identifier); hai hàm cùng dùng `estimateTokens` dùng chung.
export type { AssertFitsSmallModelInput } from './agent/smallModel';

export { AgentCoordinator, CoordinatorClient, contextLimitForModel, createMockProvider, defaultToolFactory } from './coordinator/index';
export type {
  AddAutoApproveRuleParams,
  AddAutoApproveRuleResult,
  AgentEvent,
  AgentEventKind,
  AgentEventNotification,
  BotHandle,
  CacheClearResult,
  CacheStatsResult,
  CoordinatorClientOptions,
  CoordinatorMethod,
  CoordinatorNotification,
  CoordinatorOptions,
  CoordinatorRequest,
  CoordinatorResponse,
  CreateBotParams,
  CreateBotProviderConfig,
  CreateBotResult,
  CreateGroupChatParams,
  CreateGroupChatResult,
  CreateTaskParams,
  CreateTaskResult,
  DeleteGroupChatParams,
  DeleteGroupChatResult,
  DestroyBotParams,
  DestroyBotResult,
  ListAutoApproveRulesResult,
  ListBotsResult,
  ListBotToolsResult,
  ListBotSkillsParams,
  ListBotSkillsResult,
  ListSlashCommandsParams,
  ListSlashCommandsResult,
  SlashCommandListItem,
  SetBotToolEnabledResult,
  SetBotSkillEnabledParams,
  SetBotSkillEnabledResult,
  BotToolInfo,
  BotSkillInfo,
  ListGroupChatsResult,
  ListGroupMessagesParams,
  ListGroupMessagesResult,
  GetGroupAttachmentParams,
  GetGroupAttachmentResult,
  ProjectUpdatesDueResult,
  ProjectUpdatesMarkSentParams,
  ProjectUpdatesMarkSentResult,
  MockProviderResponse,
  PingResult,
  PostGroupMessageParams,
  PostGroupMessageResult,
  ReloadSkillsResult,
  RemoveAutoApproveRuleParams,
  RemoveAutoApproveRuleResult,
  AddBotToGroupChatParams,
  AddBotToGroupChatResult,
  RemoveBotFromGroupChatParams,
  RemoveBotFromGroupChatResult,
  RunParams,
  RunResult,
  RunToolParams,
  RunToolResult,
  SetAutoApproveRuleEnabledParams,
  SetAutoApproveRuleEnabledResult,
  ShutdownResult,
  StopBotParams,
  StopBotResult,
  ToolFactory,
  ToolFactoryHost,
} from './coordinator/index';

export { BotMemory } from './agent/memory';
export type {
  BotRow,
  GoalItem,
  GoalStatus,
  ProjectItem,
  ProjectStatus,
  TaskItem,
  TaskStatus,
  ThreadItem,
  ThreadSearchHit,
  TodoItem,
} from './agent/memory';

export {
  PlanService,
  assertSafePlanId,
  diffPlanVersions,
  diffStringLists,
  listPlanHistoryFiles,
  planFileRelativePath,
  prunePlanHistory,
  readPlanFile,
  renderPlanMarkdown,
  snapshotPlanFile,
  updatePlanFileStatus,
  writePlanFile,
  PLAN_FILE_DIR,
  PLAN_FILE_STATUS_TEXT,
  PLAN_HISTORY_DIR,
  PLAN_HISTORY_MAX_VERSIONS,
} from './agent/planning';
export type { CreatedPlan, GrindRun, PlanFileInput, PlanFileReviewStatus, PlanStepInput, PlanVersionDiff, StringListDiff } from './agent/planning';

// v0.96 (Team T6): plan engine — step lifecycle, multi-agent dispatch,
// stuck detector. Separate from agent/planning (PlanService over
// BotMemory): this one is in-memory and synchronous, for the
// coordinator and the UI plan flow.
export { PlanEngine, planProgress } from './planning/engine';
export type { Plan, PlanEngineOptions, PlanProgress, PlanStep, PlanStepStatus } from './planning/engine';
export {
  StuckDetector,
  checkNoProgress,
  checkRepeatedCalls,
  toolCallSignature,
  trailingRepeatRun,
} from './planning/stuck';
export type { StuckDetectorOptions, StuckReason, StuckReport, ToolCallRecord } from './planning/stuck';

export {
  cloneAgent,
  getPublished,
  installPublished,
  listPublished,
  publishAgent,
  sanitizeConfig,
  uninstallPublished,
  BOT_DESCRIPTION_MAX_LENGTH,
  MARKETPLACE_AGENTS_FILE,
  MARKETPLACE_DIR,
} from './agent/marketplace';
export type { MarketplacePublishMeta, PublishedAgent } from './agent/marketplace';

export {
  createBotConfigFromTemplate,
  getTemplate,
  getTriageTemplate,
  buildTriageSystemPrompt,
  listBuiltInTemplates,
  TRIAGE_DEFAULT_SPECIALISTS,
  TRIAGE_TEMPLATE_ID,
} from './agent/templates';
export type { AgentTemplate, AgentTemplateCategory, BotConfigOverrides, CreateBotConfigOptions, TriageSpecialist } from './agent/templates';

export {
  applyPluginTemplate,
  createPluginTemplate,
  deletePluginTemplate,
  exportPluginTemplate,
  getPluginTemplate,
  importPluginTemplate,
  listPluginTemplates,
  savePluginTemplate,
  validatePluginTemplate,
  PLUGIN_TEMPLATES_DIR,
  PLUGIN_TEMPLATE_PERMISSIONS,
} from './plugins/templates';
export type {
  AppliedPluginTemplate,
  CreatePluginTemplateInput,
  PluginTemplate,
  PluginTemplateManifest,
  PluginTemplatePermission,
} from './plugins/templates';

export {
  isRoutineDue,
  loadRoutines,
  routinesDue,
  saveRoutine,
  SAMPLE_ROUTINES,
  sampleRoutines,
} from './agent/routines';
export type { Routine } from './agent/routines';

export {
  connectMcp,
  createMcpClient,
  McpError,
  StdioMcpClient,
  StreamableHttpMcpClient,
  MCP_CLIENT_NAME,
  MCP_CLIENT_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_REQUEST_TIMEOUT_MS,
  toolResultToText,
  resourceResultToText,
} from './mcp/client';
export { loadMcpConfig, MCP_CONFIG_REL_PATH } from './mcp/config';
// --- v0.13: MCP dispatcher / elicitation / tasks / prompts / transport / registry / server ---
export {
  McpDispatcher,
  createMcpDispatcher,
  isJsonRpcRequest,
  isJsonRpcNotification,
} from './mcp/dispatcher';
export type { McpDispatchContext, McpJsonRpcResponse, McpServerRequestHandler } from './mcp/dispatcher';
export {
  buildMcpClientCapabilities,
  registerDefaultMcpClientHandlers,
} from './mcp/clientHandlers';
export type { McpClientHandlerOptions, McpSamplingHandler, RegisteredMcpClientHandlers } from './mcp/clientHandlers';
export {
  clientAsRpcTransport,
  clientAsTaskTransport,
  MCP_ADAPTER_NOTIFICATION_METHODS,
} from './mcp/clientAdapters';
export {
  createElicitationHandler,
  DEFAULT_ELICITATION_URL_COMPLETION_TIMEOUT_MS,
  ElicitationUrlTracker,
  handleElicitationRequest,
  isSensitiveElicitationField,
  parseElicitationCompleteNotification,
  parseElicitationRequest,
  parseElicitationSchema,
  ElicitationError,
} from './mcp/elicitation';
export type {
  ElicitAction,
  ElicitResult,
  ElicitationFieldType,
  ElicitationFormField,
  ElicitationMode,
  ElicitationPrompt,
  ElicitationRequest,
} from './mcp/elicitation';
export {
  createTask,
  isTaskTerminal,
  listTasks as listMcpTasks,
  parseTaskHandle,
  parseTaskStatus,
  runTaskToCompletion,
  TaskHandle,
  TaskError,
  MCP_TASK_METHODS,
  TASK_TERMINAL_STATUSES,
} from './mcp/tasks';
export type { McpTaskTransport, TaskHandleData } from './mcp/tasks';
export {
  complete,
  completePromptArgument,
  completeResourceArgument,
  getPrompt,
  listPrompts,
  listResourceTemplates,
  parsePrompt,
  parseResourceTemplate,
  parseResourceUpdatedNotification,
  onResourcesUpdated,
  promptContentToText,
  ResourceWatcher,
  subscribeResource,
  unsubscribeResource,
  validatePromptArguments,
  PromptsError,
} from './mcp/prompts';
export type {
  CompletionRef,
  CompletionResult,
  McpPrompt,
  McpPromptArgument,
  McpPromptMessage,
  McpResourceTemplate,
  McpRpcTransport,
  RenderedPrompt,
  ResourceUpdatedListener,
  ResourceUpdatedNotification,
} from './mcp/prompts';
export {
  McpTransportError,
  parseSseText,
  StreamableHttpTransport,
  MCP_STREAMABLE_HTTP_VERSION,
  DEFAULT_TRANSPORT_TIMEOUT_MS,
} from './mcp/transport';
export type {
  JsonRpcMessage,
  ServerMessageHandler,
  SseEvent,
  StreamableHttpTransportOptions,
  TransportFetchFn,
} from './mcp/transport';
export {
  clearRegistryCache,
  fetchRemoteRegistry,
  findRegistryServer,
  getRegistryCachePath,
  loadRegistryFile,
  parseRegistryFile,
  parseServerJson,
  registryEntryToMcpConfig,
  sha256Hex,
  validateRegistryEntry,
  verifyChecksum,
  DEFAULT_REGISTRY_CACHE_TTL_MS,
} from './mcp/registry';
export type {
  RegistryFetchFn,
  RegistryFile,
  RegistryPackage,
  RegistryPackageTransport,
  RegistryRemote,
  RegistryRepository,
  RegistryServerEntry,
  RemoteRegistryOptions,
  RemoteRegistryResult,
} from './mcp/registry';
export {
  createDefaultMcpServerTools,
  createMcpServer,
  resolveWorkspacePath,
  startMcpHttpServer,
  McpServer,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_SERVER_PROTOCOL_VERSION,
  MCP_SERVER_MAX_BODY_BYTES,
  MCP_SERVER_MAX_FILE_CHARS,
} from './mcp/server';
export type {
  McpHttpServer,
  McpServerOptions,
  McpServerPromptDef,
  McpServerResourceDef,
  McpServerToolDef,
  McpServerToolHandler,
  McpServerToolResult,
} from './mcp/server';
// --- v0.13: A2A (Agent2Agent protocol) — server + client ---
export {
  createA2aServer,
  startA2aHttpServer,
  createFileTaskStore,
  A2A_TASKS_FILE_NAME,
  A2A_MAX_TASKS,
  A2A_MAX_BODY_BYTES,
} from './a2a/server';
export type { A2aHttpServer, A2aPersistStatus, A2aServer, A2aServerOptions, A2aServerWithInternals, A2aStreamEvent, A2aTaskStore } from './a2a/server';
export { A2aClient, fetchAgentCard, A2A_CLIENT_TIMEOUT_MS } from './a2a/client';
export type { A2aClientOptions, A2aPollOptions, A2aSendOptions, A2aStreamOptions } from './a2a/client';
export {
  A2aError,
  extractSendText,
  isA2aTerminalState,
  makeTextMessage,
  partsToText,
  A2A_TERMINAL_STATES,
} from './a2a/types';
export type {
  A2aAgentCard,
  A2aAgentRunner,
  A2aAgentSkill,
  A2aArtifact,
  A2aMessage,
  A2aPart,
  A2aRunResult,
  A2aRunnerInput,
  A2aTask,
  A2aTaskState,
  A2aTaskStatus,
} from './a2a/types';
export type {
  McpClient,
  McpConfig,
  McpContentBlock,
  McpListWarning,
  McpRequestOptions,
  McpResource,
  McpServerConfig,
  McpServerInfo,
  McpToolDef,
} from './mcp/types';
// --- v0.7: MCP OAuth (canonical OAuth2 implementation; see connectors/framework) ---
export {
  buildAuthorizationUrl as buildMcpAuthorizationUrl,
  checkMcpAuthStatus,
  clearOAuthToken,
  createOAuthState,
  createPkcePair,
  discoverFromWwwAuthenticate,
  discoverOAuthForResource,
  exchangeCodeForToken,
  fetchAuthorizationServerMetadata,
  fetchClientIdMetadataDocument,
  fetchProtectedResourceMetadata,
  findBearerChallenge,
  getMcpAuthStatus,
  getValidAccessToken as getValidMcpAccessToken,
  isTokenExpired,
  loadOAuthToken,
  mergeScopes,
  parseResourceMetadataUrl,
  parseStepUpScope,
  parseStoredOAuthToken,
  parseWwwAuthenticate,
  refreshAccessToken as refreshMcpAccessToken,
  refreshWithStepUpScope,
  registerDynamicClient,
  resolveOAuthClient,
  revokeOAuthToken,
  revokeStoredOAuthToken,
  saveOAuthToken,
  serializeOAuthToken,
  startCallbackListener,
  tokenNeedsStepUp,
  DEFAULT_OAUTH_CALLBACK_TIMEOUT_MS,
  DEFAULT_STEP_UP_MAX_ATTEMPTS,
  MCP_OAUTH_VAULT_NAMESPACE,
  OAUTH_DISCOVERY_TIMEOUT_MS,
  OAUTH_EXPIRY_SKEW_MS,
} from './mcp/oauth';
export type {
  AuthorizationServerDiscoverySource,
  AuthorizationServerMetadata,
  AuthorizationUrlOptions as McpAuthorizationUrlOptions,
  CallbackListener,
  ClientIdMetadataDocument,
  DynamicClientRegistration,
  ExchangeCodeOptions,
  McpAuthStatus,
  McpAuthStatusValue,
  McpOAuthClientConfig,
  McpOAuthDiscovery,
  McpOAuthStore,
  McpOAuthToken,
  PkcePair,
  ProtectedResourceMetadata,
  RefreshTokenOptions as McpRefreshTokenOptions,
  ResolvedOAuthClient,
  RevocationTokenTypeHint,
  RevokeStoredTokenOptions,
  RevokeTokenOptions,
  StepUpScopeOptions,
  ValidTokenOptions as McpValidTokenOptions,
  WwwAuthenticateChallenge,
} from './mcp/oauth';
// --- v0.7: git hosting (GitHub API client) ---
export { GitHubClient, createGitHubClient } from './git/host';
export type { GitHostOptions, GitRepo } from './git/host';
// --- v0.7: agent data export/import (local equivalent of cloud agent data) ---
export {
  exportAgentData,
  importAgentData,
  parseAgentBundleJson,
  validateAgentBundle,
  AGENT_BUNDLE_VERSION,
} from './agent/export';
export type { AgentBundle, AgentBundleMemoryEntry } from './agent/export';
// --- v0.7: session box (isolated workspace + snapshots) ---
export {
  createSession,
  destroySession,
  getSession,
  listSessions,
  listSnapshots,
  replaceSessionEnv,
  restoreSession,
  snapshotSession,
  SESSIONS_REL_DIR,
} from './session/box';
export type { SessionBox, SessionSnapshot, SessionStatus } from './session/box';
// --- v0.7: connectors framework (OAuth delegates to mcp/oauth) ---
export {
  buildAuthorizationUrl as buildConnectorAuthorizationUrl,
  callWithAutoRefresh,
  createConnectorTokenProvider,
  defaultConnectorRegistry,
  exchangeAuthorizationCode,
  getConnector,
  getValidAccessToken as getValidConnectorAccessToken,
  isTokenExpiredError,
  isTokenRevokedError,
  listConnectors,
  refreshAccessToken as refreshConnectorAccessToken,
  registerConnector,
  ConnectorRegistry,
  REFRESH_BEFORE_MS,
  TokenExpiredError,
  TokenRevokedError,
  vaultTokenStore,
} from './connectors/framework';
export type {
  AuthorizationUrlParams,
  ConnectorAuthType,
  ConnectorDefinition,
  ConnectorTokenProvider,
  FetchFn as ConnectorFetchFn,
  TokenSet,
  TokenStore as ConnectorTokenStore,
} from './connectors/framework';
export { SLACK_CONNECTOR } from './connectors/slack';
export type { SlackApiOptions } from './connectors/slack';
export { GMAIL_CONNECTOR } from './connectors/email';
export type { GmailApiOptions } from './connectors/email';
export { TEAMS_CONNECTOR } from './connectors/teams';
export type { TeamsApiOptions } from './connectors/teams';
export { GOOGLE_CONNECTOR } from './connectors/google';
export type { GoogleApiOptions } from './connectors/google';
export { JIRA_CONNECTOR } from './connectors/jira';
export { LINEAR_CONNECTOR } from './connectors/linear';
export { HUBSPOT_CONNECTOR } from './connectors/hubspot';
export { ASANA_CONNECTOR } from './connectors/asana';
export { DISCORD_CONNECTOR } from './connectors/discord';
export { NOTION_CONNECTOR } from './connectors/notion';
export type { NotionApiOptions } from './connectors/notion';
export { DROPBOX_CONNECTOR } from './connectors/dropbox';
export type { DropboxApiOptions } from './connectors/dropbox';
export { OUTLOOK_CONNECTOR } from './connectors/outlook';
export type { OutlookApiOptions } from './connectors/outlook';
export { TRELLO_CONNECTOR } from './connectors/trello';
export type { TrelloApiOptions } from './connectors/trello';
export { ZOOM_CONNECTOR } from './connectors/zoom';
export type { ZoomApiOptions } from './connectors/zoom';
// --- M7: connected apps thống nhất (catalog + OAuth chia sẻ + cap tool) ---
export {
  AppRegistry,
  BUILTIN_APPS,
  createDefaultAppRegistry,
  defaultAppRegistry,
  getApp,
  getAppToolNames,
  listApps,
  appIdForTool,
  SharedAppAuthStore,
  deriveAppAuthStatus,
  validateGithubPat,
  saveValidatedGithubPat,
  githubPatValidationErrorMessage,
  githubPatApiBase,
  GithubPatRevalidator,
  GITHUB_PAT_VALIDATE_URL,
  DEFAULT_GITHUB_PAT_TIMEOUT_MS,
  DEFAULT_GITHUB_PAT_REVALIDATE_CACHE_MS,
  GITHUB_PAT_REVOKED_DETAIL,
  GITHUB_PAT_UNCHECKABLE_NETWORK_DETAIL,
  GITHUB_PAT_UNCHECKABLE_RATE_LIMIT_DETAIL,
  GITHUB_PAT_UNCHECKABLE_FORBIDDEN_DETAIL,
  DEFAULT_APP_TOOL_CAP,
  applyAppToolCaps,
  capAppTools,
} from './apps/index';
export type {
  AppAuthStatus,
  AppAuthType,
  AppCapReport,
  AppClientConfig,
  AppDefinition,
  AppSource,
  AppStatusView,
  AppToolRef,
  CappedTools,
  GithubPatFetchFn,
  GithubPatValidation,
  GithubPatRevalidateOutcome,
  GithubPatRevalidateResult,
  GithubPatRevalidatorOptions,
  SaveValidatedGithubPatOptions,
  SharedAppAuthStoreOptions,
  ValidateGithubPatOptions,
} from './apps/index';
// --- v0.57: Composio (adapter opt-in sau AppRegistry, 4 toolkit đầu) ---
export {
  COMPOSIO_API_BASE_URL,
  COMPOSIO_MANAGE_CONNECTIONS_TOOL,
  COMPOSIO_META_TOOLS,
  COMPOSIO_MULTI_EXECUTE_TOOL,
  COMPOSIO_ROUTER_APP,
  COMPOSIO_LOCAL_USER_ID,
  COMPOSIO_ROUTER_APP_ID,
  COMPOSIO_RUNNABLE_META_TOOLS,
  COMPOSIO_SEARCH_TOOL,
  COMPOSIO_TOOLKITS,
  COMPOSIO_TOOLKIT_SLUGS,
  COMPOSIO_VAULT_KEY,
  COMPOSIO_VAULT_USER_ID_KEY,
  COMPOSIO_TRIGGER_COUNTS,
  COMPOSIO_TRIGGER_DEFS,
  COMPOSIO_TRIGGER_SLUGS,
  COMPOSIO_TRIGGER_TOTAL_COUNT,
  COMPOSIO_VAULT_NAMESPACE,
  ComposioAppSource,
  ComposioError,
  ComposioPoller,
  ComposioSessionManager,
  ComposioToolRouter,
  ComposioTriggerQueue,
  createComposioPollToQueueBridge,
  enqueueComposioPollResult,
  getSharedComposioTriggerQueue,
  hashComposioPollItem,
  applyComposioPersistedState,
  asComposioKeyVault,
  buildComposioStateView,
  clearComposioApiKey,
  clearComposioUserId,
  composioAppId,
  composioPollItemId,
  composioStateToPersist,
  composioTriggerTokenKeyId,
  computeComposioWebhookSignature,
  createComposioAppDefinitions,
  createComposioMetaTools,
  createComposioSeededKeyReader,
  createComposioToolkitAppDefinitions,
  createComposioTriggerToken,
  createComposioVaultFileKeyReader,
  createGmailPollerConfig,
  defaultComposioPersistedState,
  deleteComposioTriggerSecrets,
  deleteComposioTriggerSigningSecret,
  deleteComposioTriggerToken,
  getComposioApiKey,
  getComposioTriggerSigningSecret,
  getComposioTriggerToken,
  getComposioTriggerTokenByKeyId,
  getComposioUserId,
  hasComposioApiKey,
  hasComposioTriggerSigningSecret,
  hasComposioTriggerToken,
  hasComposioUserId,
  isTrustedComposioMcpUrl,
  normalizeComposioUserId,
  redactComposioKey,
  resolveComposioPersistedState,
  resolveComposioUserId,
  rotateComposioTriggerToken,
  setComposioApiKey,
  setComposioTriggerSigningSecret,
  setComposioUserId,
  toolkitForComposioAppId,
  validateComposioUserId,
} from './composio/index';
export type {
  ComposioAppSourceOptions,
  ComposioAppStateView,
  ComposioCallToolFn,
  ComposioConnectionStatus,
  ComposioErrorCode,
  ComposioExecuteItem,
  ComposioKeyVault,
  ComposioMcpClientLike,
  ComposioPersistedState,
  ComposioPollFetchFn,
  ComposioPollItem,
  ComposioPollResult,
  ComposioPollerConfig,
  ComposioSeededKeyReader,
  ComposioSession,
  ComposioSessionManagerOptions,
  ComposioSessionToolRef,
  ComposioStateView,
  ComposioToolkitConnection,
  ComposioToolkitDef,
  ComposioToolRouterOptions,
  ComposioTriggerDef,
  ComposioTriggerEvent,
  ComposioTriggerKey,
  ComposioTriggerQueueFilter,
  ComposioTriggerQueueOptions,
  ComposioTriggerQueueStats,
  CreateComposioMetaToolsDeps,
  CreateComposioSessionOptions,
  QueuedComposioTriggerEvent,
} from './composio/index';
export {
  MEDIA_API_KEY_MAX_LENGTH,
  MEDIA_PROVIDER_IDS,
  MEDIA_PROVIDERS,
  MEDIA_VAULT_NAMESPACE,
  asMediaKeyVault,
  buildMediaProviderConfig,
  clearMediaApiKey,
  getAllMediaApiKeys,
  getMediaApiKey,
  getMediaKeyStatus,
  getMediaProvider,
  hasMediaApiKey,
  isMediaProviderId,
  maskMediaKeySuffix,
  mediaKeyMissingMessage,
  mediaProviderNoClientMessage,
  redactMediaKey,
  setMediaApiKey,
  validateMediaApiKey,
} from './media/index';
export type {
  MediaClientStatus,
  MediaKeyStatusEntry,
  MediaKeyVault,
  MediaKind,
  MediaProviderDef,
} from './media/index';
export { draftImessage, IMESSAGE_DRAFTS_REL_DIR } from './connectors/imessage';
export type { DraftImessageOptions, ImessageDraft } from './connectors/imessage';
export {
  SLACK_INBOUND_KEYS_NAMESPACE,
  SLACK_MESSAGE_TRIGGER_SLUGS,
  SLACK_SIGNATURE_HEADER,
  SLACK_SIGNATURE_TOLERANCE_SECONDS,
  SLACK_SIGNATURE_VERSION,
  SLACK_TIMESTAMP_HEADER,
  computeSlackSignature,
  deleteSlackSigningSecret,
  getSlackSigningSecret,
  hasSlackSigningSecret,
  isSlackMessageTriggerSlug,
  normalizeSlackEvent,
  normalizeSlackInteraction,
  normalizeSlackMessageFromComposioData,
  parseSlackEventsPayload,
  parseSlackInboundPayload,
  parseSlackInteractivePayload,
  setSlackSigningSecret,
  slackEventMatchesSlug,
  slackInteractionToTriggerInput,
  slackMessageToTriggerInput,
  slackReplyArgs,
  verifySlackSignature,
} from './slack/index';
export type {
  SlackInboundAction,
  SlackInboundInteraction,
  SlackInboundKeyVault,
  SlackInboundMessage,
  SlackInboundPayload,
} from './slack/index';
export {
  detectTranscriptFormat,
  importTranscript,
  loadStoredTranscript,
  parseTranscript,
  summarizeTranscript,
  MEETINGS_REL_DIR,
} from './connectors/meeting';
export type {
  ParsedTranscript,
  StoredTranscript,
  TranscriptSegment,
  TranscriptSummary,
} from './connectors/meeting';
// --- v0.7: long-term memory ---
export {
  archiveTranscript,
  loadTranscriptArchive,
  LongTermMemory,
  teamContextSummary,
  memoryEmbeddingText,
  matchesUserScope,
  matchesBotScope,
  DEFAULT_SEMANTIC_MIN_SIMILARITY,
  MEMORIES_REL_PATH,
} from './memory/longterm';
export type {
  ArchivedMessage,
  BackfillResult,
  LongTermMemoryEntry,
  RememberWithEmbeddingResult,
  SemanticFallbackReason,
  SemanticRecallHit,
  SemanticRecallOptions,
  SemanticRecallResult,
  TeamContextSummaryOptions,
  TeamContextSummaryResult,
} from './memory/longterm';
// --- v0.95d4: user profile + turn memory context (local-first) ---
export {
  buildProfileContext,
  getOrCreateUserProfile,
  hasProfileContext,
  loadUserProfile,
  saveUserProfile,
  PROFILE_CONTEXT_MAX_CHARS,
} from './memory/profile';
export type { UserProfile } from './memory/profile';
export {
  buildMemoryTurnContext,
  buildMemoryBlocksSection,
  isEmbedderAvailableCached,
  MEMORY_TURN_MAX_CHARS,
  MEMORY_TURN_MAX_MEMORIES,
  MEMORY_BLOCKS_MAX_CHARS,
  EMBEDDER_AVAILABILITY_TTL_MS,
  EMBEDDER_PROBE_TIMEOUT_MS,
} from './memory/turnContext';
export type { MemoryTurnContextOptions, MemoryTurnContextResult } from './memory/turnContext';
// --- v0.96 (Đội T1): memory blocks + consolidation + MemFS-lite ---
export {
  MemoryBlockStore,
  normalizeBlockLabel,
  isValidBlockLabel,
  blockPromptPriority,
  compareBlocksForPrompt,
  DEFAULT_BLOCK_CHAR_LIMIT,
  MIN_BLOCK_CHAR_LIMIT,
  MAX_BLOCK_CHAR_LIMIT,
  BLOCK_SYSTEM_LABELS,
  MEMORY_BLOCKS_REL_PATH,
  MEMORY_BLOCKS_AUDIT_REL_PATH,
} from './memory/blocks';
export type {
  MemoryBlock,
  MemoryBlockAuditEntry,
  MemoryBlocksFile,
  CreateBlockInput,
  UpdateBlockPatch,
} from './memory/blocks';
export {
  consolidate,
  ConsolidationScheduler,
  normalizeFactText,
  groupDuplicateEntries,
  findConflicts,
  isPromotable,
  noteConsolidationActivity,
  shouldConsolidateNow,
  runIdleConsolidationIfDue,
  DEFAULT_PROMOTE_MIN_CONFIDENCE,
  DEFAULT_PROMOTE_TAGS,
  HUMAN_BLOCK_CHAR_LIMIT,
  MEMORY_ARCHIVE_REL_DIR,
} from './memory/consolidate';
export type {
  ConsolidationOptions,
  ConsolidationReport,
  ConflictResolution,
  IdleConsolidationState,
} from './memory/consolidate';
export {
  exportBlocksToMemFs,
  importBlocksFromMemFs,
  importFactsFromMemFs,
  parseMemFsFrontmatter,
  parseFactsFile,
  blockFileName,
  MEMFS_FACTS_FILENAME,
  MEMFS_BLOCKS_DIR_NAME,
} from './memory/memfs';
export type {
  MemFsExportResult,
  MemFsImportResult,
  MemFsImportConflict,
  MemFsFactsImportResult,
} from './memory/memfs';
// --- v0.14: real-embedding semantic search (Ollama) ---
export {
  EmbeddingIndex,
  OllamaEmbeddings,
  semanticSearch,
  EmbeddingError,
  DEFAULT_EMBED_MODEL,
  DEFAULT_OLLAMA_BASE_URL,
  EMBEDDINGS_FILE_NAME,
  MAX_EMBEDDING_ITEMS,
} from './memory/embeddings';
export type {
  Embedder,
  EmbeddingIndexFile,
  EmbeddingIndexOptions,
  EmbeddingItem,
  EmbeddingSearchOptions,
  EmbeddingSearchResult,
  SemanticSearchOptions,
} from './memory/embeddings';
export {
  getAvailable as getMcpAvailable,
  install as installMcpServer,
  installFromRegistryEntry as installMcpServerFromRegistryEntry,
  installRegistryServer as installMcpServerFromRemoteRegistry,
  listAvailable as listMcpAvailable,
  listInstalled as listMcpInstalled,
  loadMarketplaceRegistry,
  getMarketplaceRegistryFingerprint,
  MarketplaceProbeCache,
  probeMarketplaceServerTools,
  uninstall as uninstallMcpServer,
  DEFAULT_MARKETPLACE_SERVERS,
  MARKETPLACE_PROBE_MAX_TOOLS,
  MARKETPLACE_PROBE_TIMEOUT_MS,
  MARKETPLACE_REGISTRY_REL_PATH,
} from './mcp/marketplace';
// v0.89a (worker F1 — Marketplace v2): versions, remote catalog, approvals.
export {
  checkForUpdates as checkMcpUpdates,
  compareVersions,
  getInstalledVersion as getMcpInstalledVersion,
  getVersionedAvailable,
  installVersion as installMcpServerVersion,
  isNewerVersion,
  isValidVersion,
  loadVersionedRegistry,
  parseVersion,
  recordInstalledVersion as recordMcpInstalledVersion,
  removeInstalledVersion as removeMcpInstalledVersion,
  satisfiesMinAppVersion,
  searchMarketplaceServers,
  updateInstalled as updateMcpServer,
  MCP_JSON_VERSION_FIELD,
  MARKETPLACE_INSTALLED_VERSIONS_REL_PATH,
} from './mcp/marketplaceVersions';
export type {
  InstalledVersionRecord,
  InstallVersionOptions,
  McpUpdateInfo,
  ParsedVersion,
  UpdateInstalledResult,
  VersionedMarketplaceServer,
} from './mcp/marketplaceVersions';
export {
  fetchRemoteMarketplaceCatalog,
  isAllowedCatalogHost,
  loadRemoteCatalogHosts,
  mergeCatalogs,
  parseRemoteCatalog,
  validateVersionedMarketplaceServer,
  REMOTE_CATALOG_MAX_BYTES,
  REMOTE_CATALOG_HOSTS_REL_PATH,
  REMOTE_CATALOG_TIMEOUT_MS,
} from './mcp/marketplaceRemote';
export type { FetchRemoteCatalogOptions } from './mcp/marketplaceRemote';
export {
  hasMarketplaceApproval,
  listMarketplaceApprovals,
  recordMarketplaceApproval,
  requireMarketplaceApproval,
  MARKETPLACE_APPROVALS_REL_PATH,
} from './mcp/marketplaceApproval';
export type {
  MarketplaceApprovalDecision,
  MarketplaceApprovalKind,
  RecordMarketplaceApprovalInput,
} from './mcp/marketplaceApproval';
export type {
  MarketplaceProbeResult,
  MarketplaceProbeStatus,
  MarketplaceServer,
  MarketplaceToolSummary,
  MarketplaceTransport,
  ProbeMarketplaceServerToolsOptions,
} from './mcp/marketplace';
export {
  addMember,
  canEditBot,
  canUseBot,
  createServiceAccount,
  defaultTeamConfig,
  ensureTeamId,
  getMember,
  getTeamConfigPath,
  getTeamId,
  isLocalUserTeamAdmin,
  listServiceAccounts,
  listSharedBots,
  loadTeamConfig,
  removeMember,
  revokeServiceAccount,
  saveTeamConfig,
  serviceAccountVaultKey,
  setRole,
  setWorkspaceDir,
  shareBot,
  unshareBot,
  validateTeamConfig,
  SERVICE_ACCOUNT_VAULT_NAMESPACE,
} from './team/team';
export type {
  CreateServiceAccountInput,
  CreateServiceAccountResult,
  RevokeServiceAccountResult,
} from './team/team';
export type { ServiceAccount, ServiceAccountScope, SharedBot, TeamConfig, TeamMember, TeamRole } from './team/types';
export { LOCAL_USER_ID, SERVICE_ACCOUNT_SCOPES } from './team/types';

// --- v0.80: portable team bundle (export/import một team thành 1 file) ---
export {
  buildTeamBundle,
  checkTeamImportConflicts,
  computeTeamBundleChecksum,
  describeSkippedSkill,
  isNonEmptyTeam,
  parseTeamBundle,
  summarizeTeamBundle,
  TEAM_BUNDLE_KIND,
  TEAM_BUNDLE_MAX_BYTES,
  TEAM_BUNDLE_MAX_SKILL_CHARS,
  TEAM_BUNDLE_VERSION,
} from './team/portable';
export type { TeamBundle, TeamBundleData, TeamBundleSkill, TeamBundleSkippedSkill, TeamBundleSkippedSkillReason, TeamImportConflict, TeamImportConflictKind, TeamImportExisting } from './team/portable';

// --- B-platform M4: team audit log, named workspaces, TeamStore ---
export {
  AUDIT_FILE,
  AUDIT_GENESIS_PREV_HASH,
  appendAuditEvent,
  computeAuditHash,
  getAuditLogPath,
  listAuditEvents,
  readAuditEvents,
  validateAuditEvent,
  verifyAuditLog,
} from './team/audit';
export type {
  AuditEvent,
  AuditListFilter,
  AuditVerifyResult,
  NewAuditEventInput,
} from './team/audit';
export {
  WORKSPACES_FILE,
  createWorkspace,
  findWorkspace,
  getWorkspacesPath,
  loadWorkspaces,
  normalizeWorkspaceDir,
  removeWorkspace,
  renameWorkspace,
  saveWorkspaces,
  validateWorkspace,
  validateWorkspaces,
} from './team/workspaces';
export type { CreateWorkspaceInput, TeamWorkspace } from './team/workspaces';
export { TeamStore } from './team/store';
export type { TeamMutationResult } from './team/store';

// --- Đội D: tầng fleet đa người dùng (mỗi workspace 1 OS user +
// 1 service + 1 port loopback + thư mục riêng; core vẫn single-user) ---
export {
  FLEET_AUDIT_FILE,
  FLEET_DECISIONS_FILE,
  FLEET_AUTO_PORT_MAX,
  FLEET_AUTO_PORT_MIN,
  FLEET_MIN_CPU_CORES,
  FLEET_MIN_DISK_BYTES,
  FLEET_MIN_RAM_BYTES,
  FLEET_REGISTRY_FILE,
  FLEET_ROLES,
  FLEET_SERVICE_HEALTH_TIMEOUT_MS,
  FLEET_SERVICE_MAX_RESTARTS,
  FLEET_SERVICE_READY_TIMEOUT_MS,
  FLEET_SERVICE_RESTART_BACKOFF_MS,
  FLEET_SERVICE_STOP_TIMEOUT_MS,
  USAGE_DISK_MAX_FILES,
  USAGE_FILE,
  USAGE_MAX_SAMPLES_PER_WORKSPACE,
  appendFleetAuditEvent,
  appendFleetDecision,
  assertWorkspaceRootInsideFleet,
  checkFleetCapacity,
  createFleetWorkspace,
  currentOsUser,
  findFleetWorkspace,
  FleetManager,
  FleetServiceManager,
  fleetVaultKey,
  fleetVaultNamespace,
  getFleetAuditPath,
  getFleetDecisionsPath,
  getFleetRegistryPath,
  getOsUserUid,
  getUsagePath,
  isRunningPrivileged,
  listFleetAuditEvents,
  listFleetDecisions,
  loadFleetWorkspaces,
  measureDiskUsage,
  measureProcessUsage,
  measureWorkspaceUsage,
  pickFreePort,
  probeOsUser,
  pruneUsageLedger,
  readFleetAuditEvents,
  readFleetDecisions,
  readUsageSamples,
  readUsageSamplesFor,
  readWorkspaceFile,
  recordUsageSample,
  removeFleetWorkspace,
  renameFleetWorkspace,
  resolveIsolationLevel,
  resolveFleetWorkspacePath,
  saveFleetWorkspaces,
  setFleetWorkspaceStatus,
  summarizeUsage,
  updateFleetWorkspace,
  validateFleetWorkspace,
  validateFleetWorkspaces,
  validateUsageSample,
  verifyFleetAuditLog,
  verifyFleetDecisionLog,
  writeWorkspaceFile,
} from './fleet/index';
export type {
  CreateFleetWorkspaceInput,
  FleetCapacityCheck,
  FleetCapacityPolicy,
  FleetDecision,
  FleetIsolationLevel,
  FleetManagerOptions,
  FleetMember,
  FleetRole,
  FleetServiceManagerOptions,
  FleetServiceState,
  FleetServiceStatus,
  FleetStatusView,
  FleetUsageSample,
  FleetUsageSummary,
  FleetWorkspace,
  FleetWorkspaceStatus,
  NewFleetDecisionInput,
} from './fleet/index';

// --- v0.10: Hooks lifecycle (Pre/PostToolUse, SessionStart/End, Stop) ---
export type {
  HookContext,
  HookDecision,
  HookDecisionAction,
  HookDefinition,
  HookError,
  HookEvent,
  HookEventKind,
  HookFn,
  HookSettings,
  HookSettingsEntry,
  HookSource,
  PostToolUseEvent,
  PreToolUseEvent,
  SessionEndEvent,
  SessionStartEvent,
  StopEvent,
} from './hooks/index';
export {
  allowDecision,
  ALL_HOOK_EVENTS,
  blockDecision,
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_NAME_RE,
  HookRegistrationError,
  HookRegistry,
  HookRunner,
  HOOKS_ENABLED_FILE,
  modifyArgsDecision,
  modifyContextDecision,
  modifyOutputDecision,
} from './hooks/index';
export type {
  ApplyHookSettingsResult,
  HookErrorMode,
  HookRegistryOptions,
  HookRunResult,
  HookRunnerOptions,
  PostToolUseOutcome,
  PreToolUseOutcome,
  RegisterScriptHookDef,
  SessionHookOutcome,
} from './hooks/index';

// --- v0.18: hook scripts (external script file run out-of-process) ---
export {
  DEFAULT_HOOK_SCRIPT_TIMEOUT_MS,
  MAX_HOOK_SCRIPT_STDERR_CHARS,
  MAX_HOOK_SCRIPT_STDOUT_CHARS,
  resolveHookScriptPath,
  runHookScript,
  safeEnvForHookScript,
} from './hooks/index';
export type { HookScriptOptions } from './hooks/index';

// --- v0.4: Vault (encrypted secret store) ---
export {
  Vault,
  LocalEncryptor,
  createSafeStorageEncryptor,
  loadOrCreateMachineKey,
  // v0.53 (P1-6): durable writes, session-only store, refusal taxonomy,
  // webhook key store, 1Password broker (out-of-process).
  writeDurableFileSync,
  readDurableFileSync,
  DEFAULT_DURABLE_COPIES,
  SessionSecretStore,
  isSessionEntryExpired,
  VaultRefusalError,
  VaultWireError,
  VAULT_WIRE_TIMEOUT_MS,
  DEFAULT_VAULT_MAX_ENTRIES,
  WebhookKeyStore,
  createWebhookKeyStore,
  WEBHOOK_KEYS_FILE,
  OnePasswordBroker,
} from './vault/index';
export type {
  Encryptor,
  SafeStorageLike,
  VaultOptions,
  VaultEntryMeta,
  SetSecretOptions,
  DurableWriteOptions,
  SessionSecretEntry,
  VaultRefusal,
  VaultRefusalKind,
  WebhookKeyStoreOptions,
  WebhookKeyOptions,
  OnePasswordBrokerOptions,
  OnePasswordBrokerState,
  OnePasswordBrokerStatus,
  OnePasswordItemSummary,
} from './vault/index';

// --- v0.4: Usage tracking + spend limits ---
export { UsageTracker, MeteredProvider, SpendLimitError } from './usage/index';
export type {
  LimitScope,
  LimitViolation,
  MeteredProviderOptions,
  SpendLimits,
  SpendStatus,
  SpendWindow,
  UsageRecord,
  UsageSummary,
  UsageTrackerOptions,
} from './usage/index';
export {
  estimateCost,
  getModelPrice,
  listPricedModels,
  registerPrice,
  unregisterPrice,
} from './usage/index';
export type { ModelPrice } from './usage/index';

// --- v0.4: Skills (markdown skill files) ---
export type {
  Skill,
  SkillContext,
  SkillFrontmatter,
  SkillIndexEntry,
  SkillResourceDir,
  SkillResources,
  SkillSource,
} from './skills/index';
export { SkillLoadError, SKILL_RESOURCE_DIRS } from './skills/index';
export {
  extractSkillBody,
  listSkillResources,
  loadSkillDir,
  loadSkillFile,
  loadSkillFileMetadata,
  loadSkillsFromDir,
  looksLikeSecret,
  parseFrontmatter,
  parseSkillMarkdown,
  parseSkillMetadata,
  parseYaml,
  pluginSkillDirs,
  readSkillResource,
  resolveSkillResourcePath,
  MAX_SKILL_BODY_CHARS,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_FILE_NAME,
  SKILL_NAME_RE,
  SKILL_VERSION_RE,
} from './skills/index';
export type { LoadSkillsOptions, LoadSkillsResult, YamlValue } from './skills/index';
export {
  applySkills,
  BUILTIN_SKILLS,
  BUILTIN_SKILL_CODE_REVIEW,
  BUILTIN_SKILL_RESEARCH_BRIEF,
  BUILTIN_SKILL_WRITING_VI,
  ensureSkillBody,
  scoreSkill,
  SkillRegistry,
  skillRunsInSubagent,
  SKILLS_ENABLED_FILE,
  truncateSkillBody,
} from './skills/index';
export type { SkillMatch, SkillRegistryOptions } from './skills/index';
// --- v0.14: skill marketplace (install from URL/git) ---
export {
  installSkillFromUrl,
  previewSkillFromUrl,
  scanSkillDirForSecrets,
  scanSkillDirForInjection,
  scanTextForSecrets,
  scanTextForInjection,
  MarketplaceError,
  MAX_SKILL_DOWNLOAD_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILL_UNCOMPRESSED_BYTES,
} from './skills/index';
export type {
  InjectionFinding,
  InstallSkillOptions,
  InstallSkillResult,
  MarketplaceFetchFn,
  PreviewSkillOptions,
  SecretFinding,
  SkillPreview,
  SkillPreviewFile,
} from './skills/index';

// --- v0.4: Automations + Dream ---
export type {
  Automation,
  AutomationAccessPolicy,
  AutomationAction,
  AutomationCondition,
  AutomationCronWindow,
  AutomationEvent,
  AutomationEventKind,
  AutomationHandlers,
  AutomationRun,
  AutomationRunStatus,
  AutomationTrigger,
  AutomationTriggerPresentation,
} from './automations/index';
export {
  automationDue,
  buildTriggerPresentation,
  cronMatches,
  describeTrigger,
  evaluateCondition,
  executeAutomation,
  getTriggerDescription,
  getTriggerPresentation,
  globMatch,
  isValidCronExpression,
  MAX_AUTOMATION_OUTPUT_CHARS,
  MAX_TRIGGER_INPUT_CHARS,
  nextCronOccurrence,
  nextRunAtFor,
  parseCronExpression,
  validateAutomation,
  validateForEnable,
  SAMPLE_AUTOMATIONS,
  sampleAutomations,
  // --- v0.52 P0-5: webhook trigger ---
  AUTOMATION_WEBHOOK_KEYS_NAMESPACE,
  computeWebhookSignature,
  createAutomationWebhookKey,
  deleteAutomationWebhookKey,
  getAutomationWebhookKey,
  handleWebhookDelivery,
  hasAutomationWebhookKey,
  migrateAutomationWebhookKey,
  applyTriggerInputToAction,
  parseWebhookPayload,
  rotateAutomationWebhookKey,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_PREFIX,
  // --- v0.52 P0-5: automation policy ---
  AUTOMATION_POLICY_ACTIONS,
  automationAccessAllows,
  automationPolicyDeniedMessage,
  canAutomationAction,
  createRolePolicyChecker,
  viewerAutomationCapabilities,
} from './automations/index';
export type {
  CronFields,
  ExecuteAutomationOptions,
  ValidateForEnableOptions,
  WebhookDeliveryOptions,
  AutomationWebhookKey,
  AutomationWebhookKeyStore,
  AutomationWebhookKeyStores,
  AutomationWebhookKeyStoreInput,
  DedicatedWebhookKeyStore,
  AutomationPolicyAction,
  AutomationPolicyChecker,
  AutomationPolicyCheckOptions,
  AutomationPolicyContext,
} from './automations/index';
export {
  AutomationScheduler,
  JsonFileAutomationStore,
  AUTOMATIONS_FILE,
  DEFAULT_EVENT_COOLDOWN_MS,
  MAX_RUN_HISTORY,
  missedGraceMs,
} from './automations/index';
export type {
  AutomationSchedulerOptions,
  AutomationStore,
  SkippedRunInfo,
} from './automations/index';
export {
  buildDreamPrompt,
  DreamEngine,
  DEFAULT_DREAM_HISTORY_LIMIT,
  DEFAULT_DREAM_IDLE_MINUTES,
} from './automations/index';
export type { DreamConfig, DreamEngineOptions, DreamResult, DreamSkipReason } from './automations/index';

// --- v0.4: Voice (realtime calls + voice memos) ---
// --- v0.39 P0-1: redial policy + voice-call toolset + surface register + dictation ---
export {
  RealtimeClient,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_RECONNECT_DELAY_MS,
  DEFAULT_DIAL_TIMEOUT_MS,
  DEFAULT_MAX_REDIAL_DELAY_MS,
  DEFAULT_MAX_SILENT_PATH_REDIALS,
  DictationSession,
  transcribeDictation,
  pcm16ToWav,
  DICTATION_SAMPLE_RATE_HZ,
  DICTATION_MAX_BYTES,
  VoiceCallHarness,
  VoiceCallSession,
  truncateToolOutput,
  // v0.95 (Đội D3): realtime session + provider adapters + audio
  // duplex + local STT probe.
  RealtimeSession,
  OpenAiRealtimeTransport,
  GeminiLiveTransport,
  createRealtimeTransport,
  buildOpenAiRealtimeUrl,
  buildGeminiLiveUrl,
  LocalVad,
  Pcm16Chunker,
  MockAudioSource,
  MockAudioSink,
  WhisperCliSttEngine,
  MockLocalSttEngine,
  detectLocalStt,
  // v0.96 (Đội T5 — voice live): STT pipeline + WER, TTS queue,
  // session persistence, transport health + key gate.
  LocalSttPipeline,
  wordErrorRate,
  normalizeTranscriptForWer,
  TtsQueue,
  splitIntoSentences,
  VoiceSessionStore,
  createVoiceSessionRecord,
  newVoiceSessionId,
  sanitizeVoiceSessionId,
  isVoiceSessionRecord,
  buildVoiceTranscriptEntry,
  defaultVoiceSessionsDir,
  LatencyStats,
  Backoff,
  MissingRealtimeKeyError,
  isMissingRealtimeKeyError,
  realtimeKeyMissingMessage,
  deriveTransportHealth,
  resolveRealtimeApiKey,
  hasRealtimeKeyFor,
  MockRealtimeTransport,
  isMockRealtimeTransport,
  MOCK_REALTIME_DEFAULT_REPLY,
  REALTIME_PROVIDERS,
  TURN_TAKING_MODES,
  REALTIME_MIC_SAMPLE_RATE_HZ,
  OPENAI_REALTIME_INPUT_SAMPLE_RATE_HZ,
  GEMINI_LIVE_INPUT_SAMPLE_RATE_HZ,
  REALTIME_OUTPUT_SAMPLE_RATE_HZ,
  isRealtimeProvider,
  isTurnTakingMode,
  GEMINI_LIVE_DEFAULT_MODEL,
  OPENAI_REALTIME_DEFAULT_MODEL,
  createVoiceCallToolSet,
  getVoiceCallToolDefinition,
  isVoiceCallToolName,
  validateVoiceCallArgs,
  VOICE_CALL_TOOL_NAMES,
  VOICE_REDIAL_MAX_ATTEMPTS,
  VOICE_REDIAL_DIAL_TIMEOUT_MS,
  VOICE_REDIAL_INITIAL_DELAY_MS,
  VOICE_REDIAL_MAX_DELAY_MS,
  VOICE_REDIAL_MAX_SILENT_PATH_REDIALS,
  VOICE_CALL_POLICY_CLOSE_CODE,
  VOICE_CALL_SUPERSEDED_CLOSE_CODE,
  VOICE_SURFACES,
  VOICE_SURFACE_GUIDANCE,
  VOICE_SURFACE_MAX_REPLY_CHARS,
  VOICE_CALL_TOOL_DEFINITIONS,
  VOICE_CALL_REQUEST_CHAR_LIMIT,
  VOICE_CALL_SEARCH_HIT_LIMIT,
  VOICE_CALL_CHIME_NOTES,
  isVoiceSurface,
  extractFileChanges,
  buildPeekChangesResult,
  PEEK_CHANGES_LIMIT,
} from './voice/index';
export type { FileChangeEntry, FileChangeKind, FileChangeSourceRecord, PeekChangesResult } from './voice/index';
export type { VoiceCallHarnessOptions } from './voice/index';
export {
  MockTtsEngine,
  SystemTtsEngine,
  TtsHarness,
  stripMarkdownForSpeech,
  TTS_MAX_CHARS,
  TTS_SPEAK_TIMEOUT_MS,
} from './voice/index';
export type { TtsEngine, TtsEngineStatus, TtsSpeakOptions, TtsSpeakResult, TtsStopResult } from './voice/index';
export type {
  SttSegmentResult,
  SttPipelineCallbacks,
  SttPipelineOptions,
  WordErrorRate,
  QueuedSentence,
  TtsQueueStopResult,
  TtsQueueCallbacks,
  TtsQueueOptions,
  VoiceTranscriptEntry,
  PersistedVoiceProvider,
  VoiceSessionRecord,
  VoiceSessionStoreOptions,
  LatencySample,
  LatencySummary,
  BackoffOptions,
  TransportHealthStatus,
  TransportHealth,
} from './voice/index';
export type {
  VoiceCallSessionOptions,
  VoiceRealtimeClient,
  VoiceRealtimeClientFactory,
  VoiceSessionEvent,
  VoiceSurfaceRegistration,
  VoiceSurfaceView,
} from './voice/index';
export type { VoiceCallToolHandlers, VoiceCallToolSet, VoiceCallValidationResult } from './voice/index';
export {
  transcribeAudio,
  DEFAULT_TRANSCRIPTION_MODEL,
  DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
} from './voice/index';
export type {
  AudioEvent,
  DictationOptions,
  RealtimeCallbacks,
  RealtimeConfig,
  RealtimeProvider,
  RealtimeSessionEvent,
  RealtimeSessionEventSink,
  RealtimeSessionState,
  RealtimeState,
  RealtimeToolCall,
  TranscriptionOptions,
  TranscriptEvent,
  TurnTakingMode,
  VoiceCallHarnessOutcome,
  VoiceCallHarnessOutcomeKind,
  VoiceCallToolDefinition,
  VoiceCallToolName,
  VoiceSurface,
  WebSocketFactory,
  WebSocketLike,
} from './voice/index';
export type {
  RealtimeSessionOptions,
  RealtimeTransportFactory,
} from './voice/index';
export type {
  RealtimeTransport,
  RealtimeTransportCallbacks,
  RealtimeTransportConfig,
} from './voice/index';
export type { AudioSource, AudioSink } from './voice/index';
export type {
  LocalSttEngine,
  LocalSttStatus,
  LocalSttTranscribeOptions,
} from './voice/index';

// --- v0.4: Performance (job queue, worker pool, tool-result cache) ---
export { JobQueue } from './perf/index';
export type {
  EnqueueOptions,
  JobFn,
  JobHandle,
  JobQueueOptions,
  JobQueueStats,
} from './perf/index';
export { WorkerPool, defaultPoolSize, DEFAULT_MAX_JOB_TIME_MS } from './perf/index';
export type { WorkerPoolOptions, WorkerPoolStats } from './perf/index';
export {
  ToolResultCache,
  cacheKeyFor,
  stableStringify,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_CACHE_MAX_ENTRIES,
  SUGGESTED_CACHEABLE_TOOLS,
} from './perf/index';
export type { ToolResultCacheOptions, ToolResultCacheStats } from './perf/index';

// --- v0.5: Model registry + provider presets ---
export { ModelRegistry } from './models/index';
export type { ModelRegistryOptions } from './models/index';
export {
  COMPATIBLE_PRESETS,
  DEFAULT_FEATURE_FLAGS,
  MODELS_FILE,
  RAIL_GROUP_ORDER,
  buildProviderRail,
  cleanDisabledProviders,
  filterRailForBot,
  listCompatiblePresets,
  resolvePreset,
  sourceLabelText,
} from './models/index';
export type {
  BuildProviderRailInput,
  CompatiblePreset,
  FeatureModel,
  FeatureModelMap,
  ModelInfo,
  ModelRegistrySnapshot,
  ProviderModels,
  ProviderRail,
  RailEntry,
  RailGroup,
  RailProviderMeta,
  RailReason,
  RailSourceKind,
  RailStatus,
  UserModelOverrides,
  UserProviderOverrides,
} from './models/index';

// --- v0.5: Local API + webhooks ---
export {
  createApiServer,
  MAX_JSON_BODY_BYTES,
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  // v0.90d: rate limiting + giới hạn kết nối + timeout + restart backoff.
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  RATE_LIMIT_WINDOW_MS,
  MAX_API_CONNECTIONS,
  MAX_CONNECTIONS_PER_IP,
  API_HEADERS_TIMEOUT_MS,
  API_REQUEST_TIMEOUT_MS,
  API_CONNECTIONS_CHECKING_INTERVAL_MS,
  API_RESTART_MAX_ATTEMPTS,
  API_RESTART_BASE_DELAY_MS,
  API_RESTART_MAX_DELAY_MS,
  apiRestartDelayMs,
  retryWithBackoff,
} from './api/index';
export type { LocalApiServer, RetryWithBackoffOptions, RetryWithBackoffResult } from './api/index';
export { WebhookDispatcher, WEBHOOK_TIMEOUT_MS, WEBHOOK_EVENT_KINDS } from './api/index';
export type {
  ApiBotSummary,
  ApiHandlers,
  ApiRunRecord,
  CreateApiServerOptions,
  HarnessEventsFilter,
  HarnessStreamEvent,
  MountedA2aServer,
  MountedMcpServer,
  WebhookDispatchResult,
  WebhookDispatcherOptions,
  WebhookEvent,
  WebhookEventKind,
  WebhookRegistration,
} from './api/index';

// --- v0.5: util (machine id + secret redaction) ---
export { getOrCreateMachineId, MACHINE_ID_FILE } from './util/index';
export { redactBearer, redactSecrets, REDACTED } from './util/index';

// --- v0.7: auth (multi-layer login, credentials, OAuth, policy), IPC validation, self-update ---
export {
  getLocalProfile,
  getOrCreateLocalProfile,
  loadLocalProfile,
  saveLocalProfile,
  setLocalDisplayName,
  updateLocalProfile,
  validateLocalProfile,
  PROFILE_LIST_MAX_ITEMS,
  PROFILE_LIST_MAX_ITEM_CHARS,
  getProviderIdentity,
  setProviderIdentity,
  deleteProviderIdentity,
  listProviderIdentities,
  validateProviderIdentity,
  PROFILE_FILE,
  IDENTITY_NAMESPACE,
  CREDENTIAL_NAMESPACES,
  namespaceFor,
  migrateCredentials,
  auditCredentialNamespaces,
  OAUTH_PROVIDERS,
  isOAuthSupported,
  getOAuthProvider,
  buildAuthUrl,
  newOAuthState,
  createOAuthCallbackServer,
  exchangeCodeForTokens,
  loadPolicy,
  parsePolicy,
  isProviderAllowed,
  effectiveBaseUrl,
  POLICY_FILE,
} from './auth/index';
export type {
  LocalProfile,
  LocalProfilePatch,
  ProviderIdentity,
  CredentialKind,
  CredentialMigrationMove,
  CredentialMigrationReport,
  OAuthProviderConfig,
  OAuthCallbackServer,
  CreateOAuthCallbackServerOptions,
  TokenExchangeResult,
  FetchLike,
  MachinePolicy,
  LoadPolicyResult,
} from './auth/index';
export {
  isRecord as isIpcRecord,
  requireBase64,
  requireBoolean,
  requireHttpUrl,
  requireWsUrl,
  requireId,
  requireInt,
  requireString,
  requireStringArray,
  requireText,
  optionalString,
  resolveWithin,
  validateWorkspaceDir,
  HARNESS_EVENT_KINDS,
  parseHarnessThreadLogParams,
  MAX_BASE64_CHARS,
  MAX_ID_CHARS,
  MAX_NAME_CHARS,
  MAX_TEXT_CHARS,
  MAX_URL_CHARS,
} from './ipc/index';
export {
  checkForUpdate,
  checkForTrackUpdate,
  compareSemver,
  parseSemver,
  pickReleaseForTrack,
  releaseMatchesTrack,
  UPDATE_REPO,
  UPDATE_RELEASES_API,
  UPDATE_RELEASES_LIST_API,
} from './update/index';
export type { GitHubReleaseSummary, UpdateCheckResult, UpdateFetchLike } from './update/index';
// --- v0.54 (P1-9): update track + chính sách update_required / min_client_version ---
export {
  DEFAULT_UPDATE_TRACK,
  UPDATE_DISABLED_BY_ENV_CODE,
  UPDATE_DISABLED_ENV_VAR,
  UPDATE_TRACKS,
  evaluateUpdatePolicy,
  isUpdateDisabledByEnv,
  isUpdateTrack,
  parseUpdateTrack,
} from './update/index';
export type { UpdatePolicyInput, UpdatePolicyResult, UpdateTrack } from './update/index';

// --- v0.6: agent coordination (reflect / grind / modes), permissions, canvas ---
export {
  advanceGrind,
  getGrindStatus,
  getPlanApproval,
  grindMemoryKey,
  isAgentMode,
  listPendingPlans,
  loadGrindStateForBot,
  pauseGrind,
  reflectOnProgress,
  resumeGrind,
  reviewPlan,
  saveReflection,
  startGrind,
  stopGrind,
  submitPlanForReview,
  GrindSession,
  AGENT_MODES,
} from './agent/coordination';
export type {
  AgentMode,
  BotConfigWithMode,
  GrindAdvanceResult,
  GrindState,
  GrindStatus,
  GrindStatusReport,
  PlanApprovalState,
  ReflectionSummary,
} from './agent/coordination';
export {
  AgentPermissions,
  checkToolCall,
  checkToolCallFor,
  filterSkillsFor,
  filterSkillsForBot,
  filterToolsFor,
  filterToolsForBot,
  isApprovalPolicy,
  isAutoApproveMode,
  isSkillAllowedFor,
  isToolAllowedFor,
  approvalPolicyFor,
  resolveAutoApproveMode,
  sanitizeDenySkills,
  APPROVAL_POLICIES,
  AUTO_APPROVE_MODES,
} from './agent/permissions';
export type { ApprovalPolicy, AutoApproveMode, BotToolPolicy, ToolCallCheck, ToolCallCheckOptions } from './agent/permissions';
// --- v0.11: rule engine (phân loại lệnh shell + glob rules) ---
export {
  BLOCKED_COMMAND_PATTERNS,
  classifyCommand,
  createGlobRulesHook,
  DEFAULT_GLOB_RULES,
  DEFAULT_SAFE_COMMANDS,
  DEFAULT_SENSITIVE_COMMANDS,
  evaluateFileRules,
  FILE_WRITE_TOOLS,
  GLOB_RULES_HOOK_NAME,
  globToRegExp,
  isBlockedCommand,
  isSafeCommand,
  isSensitiveCommand,
  loadRulesFile,
  matchBlockedCommandPattern,
  matchGlob,
  parseRulesFile,
  RulesStore,
  RULES_DIR_NAME,
  RULES_FILE_NAME,
} from './agent/rules';
export type {
  ClassifyCommandOptions,
  CommandClass,
  GlobRule,
  GlobRuleAction,
  LoadedRules,
  ParsedRules,
  RuleAction,
} from './agent/rules';
// --- v0.35 (P1-7): auto-approve rules (allowlist tự duyệt tool call) ---
export {
  AUTO_APPROVE_RULES_FILE_NAME,
  AUTO_APPROVE_RULES_FILE_VERSION,
  AutoApproveRuleStore,
  findMatchingAutoApproveRule,
  matchAutoApproveRule,
  matchesArgsPattern,
  MAX_AUTO_APPROVE_NOTE_CHARS,
  validateAutoApproveRuleInput,
} from './approval/index';
export type {
  AutoApproveMatchInput,
  AutoApproveRule,
  AutoApproveRuleInput,
  AutoApproveRuleKind,
  AutoApproveRuleScope,
} from './approval/index';
// --- v0.50 (M8): mức approval theo bot + quy tắc self-read ---
export {
  BOT_APPROVAL_LEVELS,
  DEFAULT_BOT_APPROVAL_LEVEL,
  CARD_ARGS_SUMMARY_MAX_CHARS,
  REDACTED_ARG,
  decideApprovalLevel,
  isBotApprovalLevel,
  isPathInsideWorkspace,
  isSelfReadCall,
  isSelfReadShellCommand,
  parseBotApprovalLevel,
  shouldAskForCall,
  summarizeArgsForCard,
} from './approval/index';
export type { ApprovalLevelDecisionInput, BotApprovalLevel } from './approval/index';
// --- v0.50 (M8): group chat bot-bot ---
export {
  GROUP_ATTACHMENTS_DIRNAME,
  GROUP_ATTACHMENT_EXT_BY_MIME,
  GROUP_BOT_STATUS_FILE_NAME,
  GROUP_BOT_STATUS_FILE_VERSION,
  GROUP_CHATS_FILE_NAME,
  GROUP_CHATS_FILE_VERSION,
  GroupBotStatusTracker,
  GroupChatStore,
  MAX_GROUP_MESSAGES,
  normalizeBotName,
  parseGroupMentions,
} from './groupchat/index';
export type { GroupBotInterruptedEntry, GroupBotStatus, GroupBotStatusEntry, GroupChat, GroupMessage, GroupMessageAttachment, MentionableBot } from './groupchat/index';
// --- v0.96 (Team T4): channels — không gian làm việc chung của nhiều bot ---
export {
  CHANNELS_FILE_NAME,
  CHANNELS_FILE_VERSION,
  CHANNEL_MAX_INSTRUCTIONS_LENGTH,
  CHANNEL_MAX_MESSAGES,
  CHANNEL_MAX_NAME_LENGTH,
  CHANNEL_MAX_WORKING_FOLDER_LENGTH,
  CHANNEL_ROUTE_CONTEXT_MESSAGES,
  DEFAULT_CHANNEL_RESPONDER_RULES,
  ChannelStore,
  buildChannelSystemPrompt,
  createChannelObject,
  parseChannelMentions,
  resolveChannelResponders,
  routeChannelMessage,
} from './channels/index';
export type { Channel, ChannelBotRunner, ChannelKind, ChannelMessage, ChannelResponderMode, ChannelResponderRules, ChannelRouteResult, CreateChannelInput, UpdateChannelInput } from './channels/index';
// --- v0.11: workspace rules (AGENTS.md) ---
export {
  clearRulesCache,
  findRulesFile,
  loadWorkspaceRules,
  MAX_WORKSPACE_RULES_CHARS,
  WORKSPACE_RULES_CANDIDATES,
} from './rules/index';
export type { WorkspaceRules } from './rules/index';
// --- v0.34: AGENTS.md theo thứ bậc thư mục (P1-6) ---
export {
  AGENTS_MD_CONFIG_DIR,
  AGENTS_MD_FILENAME,
  clearAgentsMdCache,
  findAgentsMdChain,
  loadAgentsMd,
  MAX_AGENTS_MD_CHARS_PER_FILE,
  MAX_AGENTS_MD_TOTAL_CHARS,
} from './project/agentsMd';
export type { AgentsMdResult, AgentsMdSkipped, AgentsMdSource } from './project/agentsMd';
// --- v0.94c: project updates delivery (digest định kỳ, xem project/updates.ts) ---
export {
  PROJECT_DIGEST_MAX_ITEMS,
  PROJECT_UPDATES_CHECK_MS,
  PROJECT_UPDATES_INTERVAL_MS,
  buildProjectDigest,
  listDueProjectUpdates,
  markProjectUpdateSent,
  nextProjectDigestAt,
} from './project/updates';
export type { ProjectDigest, ProjectDigestCounts } from './project/updates';
// --- v0.12: handoff chuẩn (transfer_to_X) ---
export {
  checkHop,
  createHandoff,
  extractOriginalRequest,
  formatHandoffForPrompt,
  handoffChain,
  HandoffLog,
  isTransferTool,
  parseTransferToolName,
  slugifyBotName,
  summarizeTranscript as summarizeHandoffTranscript,
  transferToolNameFor,
  truncateTranscript,
  wouldRepeatHandoff,
  MAX_HANDOFF_HOPS,
  MAX_HANDOFF_RESULT_CHARS,
  MAX_HANDOFF_TRANSCRIPT_CHARS,
} from './agent/handoff';
export type {
  CreateHandoffInput,
  HandoffIntermediateResult,
  HandoffMessage,
  HandoffPayload,
  HandoffRecord,
  HandoffRole,
  HopCheck,
} from './agent/handoff';
// --- v0.37: handoff phiên làm việc (P1-3) — record bền chuyển giao giữa các bot/phiên ---
export {
  acceptedHandoffConfirmation,
  createSessionHandoff,
  formatSessionHandoffForPrompt,
  HANDOFF_WORK_STATUSES,
  MAX_HANDOFF_BLOCKERS,
  MAX_HANDOFF_CONTEXT_CHARS,
  MAX_HANDOFF_DECISIONS,
  MAX_HANDOFF_FILES,
  MAX_HANDOFF_FILE_CHARS,
  MAX_HANDOFF_LIST_ITEMS,
  MAX_HANDOFF_LIST_ITEM_CHARS,
  MAX_HANDOFF_NEXT_STEP_CHARS,
  MAX_HANDOFF_STATE_CHARS,
  MAX_HANDOFF_SUMMARY_CHARS,
  MAX_HANDOFF_TITLE_CHARS,
  MAX_SESSION_HANDOFF_TRANSCRIPT_CHARS,
  MAX_SESSION_HANDOFFS,
  parseSessionHandoffRecord,
  redactHandoffText,
  SessionHandoffStore,
  sessionHandoffSummary,
  SESSION_HANDOFF_FORMAT_VERSION,
  SESSION_HANDOFFS_FILE_NAME,
} from './handoff/index';
export type {
  AcceptedHandoffConfirmation,
  CreateSessionHandoffInput,
  CreateSessionHandoffOptions,
  ListSessionHandoffsFilter,
  MarkAcceptedInput,
  SessionHandoffBlocker,
  SessionHandoffDecision,
  SessionHandoffMessage,
  SessionHandoffRecord,
  SessionHandoffSummary,
  SessionHandoffWorkStatus,
} from './handoff/index';
// --- v0.12: subagent chuyên biệt hoá ---
export {
  buildSubagentSystemPrompt,
  detectConflicts,
  filterToolsForSubagent,
  mergeParallelResults,
  runSpecializedSubagent,
  runSpecializedSubagentsParallel,
  validateSpecializedSpec,
  DEFAULT_CONFLICT_MARKER_PAIRS,
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  MAX_PARALLEL_SUBAGENT_OUTPUT_CHARS,
} from './agent/subagent';
export type {
  DetectedConflict,
  MergedParallelResult,
  SpecializedSubagentResult,
  SpecializedSubagentRunner,
  SpecializedSubagentSpec,
  SpecializedSubagentStatus,
  SpecializedSubagentTask,
} from './agent/subagent';
// --- v0.37 (P1-4): subagent theo vai trò (role) ---
export {
  BUILTIN_ROLES,
  DEFAULT_ROLE_REGISTRY,
  EmptyRoleToolsError,
  SHELL_TOOL_NAMES,
  SubagentRoleRegistry,
  UnknownSubagentRoleError,
  createRoleRegistry,
  describeRole,
  loadRolesFromDir,
  loadRolesFromFile,
  parseRolesJson,
  validateRole,
} from './subagents/roles';
export type {
  LoadedRoles,
  ResolvedRoleOptions,
  RoleCallOverrides,
  SubagentRole,
  SubagentRoleSource,
  SubagentRoleSummary,
} from './subagents/roles';
// --- v0.14: slash commands ---
export { SlashCommandRegistry } from './agent/slash';
export type { BundlePartsForSlash, SlashCommandDef } from './agent/slash';
// --- v0.15: @-mentions (@files / @docs) ---
export {
  parseMentions,
  resolveMentions,
  MENTION_MAX_FILE_BYTES,
  MENTION_MAX_TOTAL_BYTES,
} from './agent/mentions';
export type {
  IncludedMentionFile,
  MentionKind,
  ParsedMention,
  ResolveMentionsOptions,
  ResolveMentionsResult,
  SkippedMentionFile,
} from './agent/mentions';
// --- v0.14: supervisor / swarm routing ---
export { Supervisor, SupervisorRouter, scoreAgent } from './agent/supervisor';
export type {
  AgentCapability,
  AgentKind,
  AgentScore,
  DispatchOptions,
  DispatchResult,
  HandoffCallback,
  RouteOptions,
} from './agent/supervisor';
// --- v0.14: shadow workspace / git worktree ---
export { WorktreeManager, createShadow } from './agent/worktree';
export type {
  CreateWorktreeOptions,
  ShadowWorkspace,
  WorktreeInfo,
} from './agent/worktree';
// --- v0.12: checkpoint/resume ---
export {
  buildResumeState,
  getCheckpoint,
  listCheckpoints,
  listCheckpointSummaries,
  pruneCheckpoints,
  replayFromCheckpoint,
  resumeFromCheckpoint,
  saveCheckpoint,
  saveStepCheckpoint,
  DEFAULT_CHECKPOINTS_KEPT,
} from './agent/checkpoints';
export type {
  CheckpointSummary,
  CheckpointToolCallRecord,
  ResumeState,
  RunCheckpoint,
  SaveCheckpointInput,
} from './agent/checkpoints';
// --- v0.54 (P1-8): interrupt HITL cho run dài ---
export {
  InterruptController,
  matchesInterruptPoint,
  normalizeInterruptPoints,
  INTERRUPT_CANCELLED_TEXT,
  interruptNoHandlerText,
} from './agent/interrupt';
export type {
  InterruptDecision,
  InterruptHandler,
  InterruptPoint,
  InterruptReason,
  InterruptRequest,
} from './agent/interrupt';
// --- v0.12: workflow graph khai báo ---
export {
  defineWorkflow,
  evaluateCondition as evaluateWorkflowCondition,
  getStateField,
  renderArgs,
  renderTemplate,
  runWorkflow,
  validateWorkflow,
} from './agent/workflow';
export type {
  RunWorkflowOptions,
  WorkflowCondition,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowNodeOutput,
  WorkflowNodeRunner,
  WorkflowRunResult,
  WorkflowRunStatus,
  WorkflowRunnerInput,
  WorkflowStepRecord,
  WorkflowStepStatus,
  WorkflowValidation,
} from './agent/workflow';
export { planEditTestFixWorkflow, researchBriefWorkflow } from './agent/workflows/index';
export { createWorkflowRunner } from './agent/workflow-runner';
export type { WorkflowRunnerOptions } from './agent/workflow-runner';
// --- v0.12: compaction ---
export {
  buildCompactionPrompt,
  buildSummaryMessageContent,
  checkAndCompact,
  compactMessages,
  compactWithProvider,
  estimateMessageTokens,
  estimateMessagesTokens,
  formatTranscriptLine,
  needsCompaction,
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_COMPACTION_THRESHOLD,
  DEFAULT_KEEP_RECENT_MESSAGES,
  DEFAULT_MAX_MESSAGE_CHARS_IN_PROMPT,
  DEFAULT_MAX_SUMMARY_CHARS,
} from './agent/compaction';
export type {
  CompactionLanguage,
  CompactionOptions,
  CompactionResult,
  ProviderCompactionOptions,
  Summarizer,
} from './agent/compaction';
// --- v0.12: structured output ---
export {
  buildStructuredPromptHint,
  buildStructuredRetryHint,
  extractJsonText,
  formatStructuredError,
  parseStructuredOutput,
  parseStructuredWithRetry,
  validateAgainstSchema,
} from './agent/structured';
export type {
  JsonSchema,
  JsonSchemaType,
  SchemaValidationError,
  StructuredOutputOptions,
  StructuredParseResult,
  StructuredProducer,
  StructuredRetryResult,
} from './agent/structured';
// --- v0.10a: context-aware tool filtering + grouping (P0-4) ---
export {
  filterTools,
  filterToolDefinitions,
  filterToolList,
  groupTools,
  groupToolDefinitions,
  getToolGroups,
  makeToolNameFilter,
  toolGroupFor,
  isReadOnlyTool,
  estimateToolDefinitionTokens,
  estimateToolsTokens,
  ESSENTIAL_TOOLS,
  READ_ONLY_TOOLS,
} from './agent/toolFilter';
export type {
  ActiveSkillInput,
  GroupToolsOptions,
  ToolFilterOptions,
  ToolGroup,
  ToolListItem,
  ToolListFilterOptions,
} from './agent/toolFilter';
export { CanvasStore } from './canvas/store';
// --- v0.86 (P2-7): opt-in crash reporting (local only, no sending) ---
export {
  buildCrashReport,
  CrashCollector,
  CrashReportStore,
  createRendererErrorHandler,
  defaultRedactOpts,
  isValidCrashReportId,
  redactCrashText,
  toCrashReportSummary,
  CRASH_REPORT_VERSION,
  MAX_CRASH_MESSAGE_CHARS,
  MAX_CRASH_REPORTS,
  MAX_CRASH_REPORTS_BYTES,
  MAX_CRASH_STACK_CHARS,
  REDACTED_HOME,
  REDACTED_USER,
} from './crash/index';
export type {
  CrashCollectorOptions,
  CrashKind,
  CrashReport,
  CrashReportInput,
  CrashReportStoreOptions,
  CrashReportSummary,
  CrashSource,
  RedactCrashOptions,
  RendererErrorHandler,
  RendererErrorInput,
} from './crash/index';
// --- v0.87c: OS notifications (Electron Notification, main only) ---
export {
  formatNotificationText,
  isNotificationKind,
  NotificationService,
  notificationSettingsKey,
  resolveNotificationSettings,
  validateNotificationRequest,
  DEFAULT_NOTIFICATION_SETTINGS,
  MAX_NOTIFICATION_BODY_CHARS,
  MAX_NOTIFICATION_TITLE_CHARS,
  NOTIFICATION_DEDUPE_WINDOW_MS,
  NOTIFICATION_KINDS,
  NOTIFICATION_RATE_LIMIT_MAX,
  NOTIFICATION_RATE_LIMIT_WINDOW_MS,
} from './notifications/index';
export type {
  NotificationKind,
  NotificationLocale,
  NotificationOutcome,
  NotificationOutcomeReason,
  NotificationRequest,
  NotificationServiceOptions,
  NotificationSettings,
  NotificationText,
  NotificationTextVars,
  ShownNotification,
} from './notifications/index';
// --- v0.86 (P2-10): elevate — chạy lệnh với quyền cao hơn, approval bắt buộc ---
export {
  buildElevatedArgv,
  formatElevatedResult,
  isElevateSupported,
  isPasswordRequiredError,
  validateElevateRequest,
  DEFAULT_ELEVATE_TIMEOUT_MS,
  ELEVATED_TOOL_NAME,
  ELEVATE_DENIED,
  ELEVATE_PASSWORD_REQUIRED,
  ELEVATE_UNSUPPORTED,
  MAX_ELEVATE_TIMEOUT_MS,
  MIN_ELEVATE_REASON_CHARS,
} from './elevate/index';
export type { ElevatedRunResult } from './elevate/index';
// --- v0.10d: run tracing (Tracer + TraceStore, JSONL) ---
export {
  Tracer,
  TraceStore,
  createTraceId,
  sanitizeText,
  sanitizeValue,
  summarize,
  MAX_SUMMARY_CHARS,
  MAX_SANITIZE_DEPTH,
  SECRET_KEY_RE,
  TRACES_FILE,
  DEFAULT_MAX_TRACES,
  MAX_SPANS_PER_TRACE,
} from './tracing/index';
export type {
  ListTracesFilter,
  SpanHandle,
  SpanKind,
  SpanStatus,
  StartSpanOptions,
  Trace,
  TraceSink,
  TraceSpan,
  TraceStatus,
  TraceStoreOptions,
  TraceSummary,
  TracerOptions,
} from './tracing/index';
export type { CanvasBlock, CanvasDocument, CanvasSummary, CanvasWriteOptions } from './canvas/store';

// --- v0.10: Guardrails (input / output / tool, rule-based, blocking + parallel) ---
// Wiring into the agent loop is done by the coordinator in a later step;
// this only exports the API (see docs/BEYOND-ROADMAP.md items 5–6).
export {
  applyRedactions,
  BUILTIN_GUARDRAILS,
  createDefaultRegistry,
  createPiiGuardrail,
  createPromptInjectionGuardrail,
  createSecretGuardrail,
  createToolInjectionGuardrail,
  createToolPathGuardrail,
  createToolSecretGuardrail,
  createScopeGuardrail,
  GuardrailRegistry,
  GuardrailTripwireError,
  INJECTION_PATTERNS,
  luhnValid,
  PII_PATTERNS,
  redactOutputText,
  SECRET_PATTERNS,
} from './guardrails/index';
export type {
  GuardrailContext,
  GuardrailDefinition,
  GuardrailLayer,
  GuardrailMode,
  GuardrailModeConfig,
  GuardrailRegistryOptions,
  GuardrailResult,
  GuardrailSeverity,
  GuardrailSpan,
  GuardrailViolation,
  NamedPattern,
  ScopeGuardrailOptions,
} from './guardrails/index';

// Egress control (P0-2, REA deep-dive lần 2 §10/§13): policy + allowlist
// + fail-closed + telemetry ẩn danh cho session box / agent chạy mạng.
export {
  checkEgress,
  checkEgressSync,
  checkGithubCheckout,
  classifyEgressFetchError,
  createAllowPublicEgressPolicy,
  createDefaultEgressPolicy,
  EgressError,
  EGRESS_ERROR_CODE_BY_KIND,
  EgressTelemetry,
  defaultEgressTelemetry,
  extractNetworkTargets,
  hostAllowlisted,
  ipInRange,
  ipInRanges,
  isLoopbackTarget,
  isPrivateIp,
  matchAllowHost,
  mergeEgressPolicies,
  parseEgressTarget,
  validateEgressPolicy,
  GITHUB_HOSTS,
} from './egress/index';
export type {
  CheckEgressOptions,
  EgressContext,
  EgressDecision,
  EgressErrorCode,
  EgressErrorKind,
  EgressMode,
  EgressPolicy,
  EgressTarget,
  EgressTelemetryKind,
  EgressTelemetrySnapshot,
} from './egress/index';
export type { TeamEgressConfig } from './team/types';
export { resolveTeamEgressPolicy, setTeamEgress } from './team/team';

// --- v0.86 (P2-6): deep-link `open-bot://` — parser thuần, không Electron ---
export {
  DEEP_LINK_SCHEME,
  parseDeepLink,
  extractDeepLinkFromArgv,
  deepLinkToString,
} from './deeplink';
export type { DeepLinkRoute, DeepLinkParseResult } from './deeplink';

// --- v0.54 (P1-10): renderer persisted store có version (logic thuần túy) ---
export {
  PersistedStore,
  PersistedStoreRegistry,
  DraftStore,
  createDraftId,
  createMemoryStorage,
} from './client/index';
export type {
  ClientPersistenceReport,
  ClientPersistenceReporter,
  DraftEntry,
  PersistedStoreDef,
  PersistedStoreScope,
  StorageLike,
} from './client/index';
