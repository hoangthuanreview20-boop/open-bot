/**
 * @open-bot/tools — sandboxed tools for the open-bot agent.
 *
 * `createDefaultTools()` returns the built-in tools (see `ALL_TOOLS` in
 * ./tools). The agent core
 * (package `@open-bot/core`) imports the `Tool` / `ToolContext` /
 * `ToolDefinition` types and calls `tool.execute(args, ctx)`, handling
 * user approval from each tool's `needsApproval` flag.
 */
export {
  createDefaultTools,
  ALL_TOOLS,
  formatSearchResults,
  parseDuckDuckGoResults,
  searchBing,
  searchWeb,
  unwrapBingRedirect,
} from './tools';
export {
  resolveWithin,
  runShell,
  assertCommandAllowed,
  createDenylistHook,
  DENYLIST_COMMANDS,
  DENYLIST_HOOK_NAME,
  MAX_OUTPUT_CHARS,
  DEFAULT_SHELL_TIMEOUT_MS,
} from './sandbox';
export type { RunShellOptions, RunShellResult } from './sandbox';
export { ToolRegistry } from './registry';
// v0.15: shellQuote dùng chung (gộp 4 bản copy ở tools/codeTools/webMedia/gitTools)
// và kill process group đa nền tảng (daemon.ts sẽ nối qua killProcessGroupOfChild).
export { shellQuote, resolveShellPlatform } from './shellQuote';
export type { ShellPlatform } from './shellQuote';
// --- v0.15: chặn SSRF cho các tool fetch URL (H3 audit) ---
export { assertPublicUrl, fetchPublic, isPrivateIp, MAX_SSRF_REDIRECTS } from './ssrf';
export type { SsrfCheckOptions } from './ssrf';
export {
  killProcessGroup,
  killProcessGroupOfChild,
  isProcessAlive,
  resolveKillPlatform,
} from './killProcessGroup';
export type { KillPlatform, KillProcessGroupOptions } from './killProcessGroup';
export { DaemonClient } from './daemon';
export type {
  ExecCallbacks,
  ExecRequest,
  ExecEvent,
  ExecResult,
  ExecInfo,
  ShellDaemon,
} from './daemon';
export { CODE_TOOLS } from './codeTools';
// --- v0.86 (P2-4): tree-sitter AST symbols for code tools ---
export {
  parseCodeSymbols,
  detectAstLanguage,
  supportedAstLanguagesText,
  SUPPORTED_AST_LANGUAGES,
} from './code/ast';
export type { AstLanguage, AstSymbolKind, CodeSymbol, ParseCodeSymbolsResult } from './code/ast';
export { createPlanTools, PLAN_TOOLS } from './planTools';
export { createSubagentTools, SUBAGENT_TOOLS } from './subagentTools';
export type { SubagentToolOptions } from './subagentTools';
export { createMcpTools, MCP_TOOLS } from './mcpTools';
export { loadPlugin, validateManifest, readManifest } from './plugins/loader';
export type { LoadedPlugin } from './plugins/loader';
export { PluginManager, toolsFromPlugins, registerPluginTools } from './plugins/manager';
export type { PluginLoadFailure } from './plugins/manager';
// v0.89a (worker F1 — Marketplace v2): plugin marketplace (install from
// URL/git/local, secret scan, versions, sandboxed-by-default).
export {
  checkPluginUpdates,
  discardPreparedPlugin,
  downgradePlugin,
  getPluginDowngradeInfo,
  installPluginFromSource,
  installPreparedPlugin,
  listMarketplaceInstalledRecords,
  listMarketplacePlugins,
  loadMarketplacePluginSandboxed,
  preparePluginFromSource,
  scanDirForSecrets,
  searchMarketplacePlugins,
  uninstallMarketplacePlugin,
  updatePluginFromSource,
  validatePluginMarketplaceEntry,
  verifyInstalledPluginSignature,
  PLUGIN_DOWNLOAD_MAX_BYTES,
  PLUGIN_DOWNLOAD_TIMEOUT_MS,
  PLUGIN_MARKETPLACE_INSTALLED_FILE,
  PLUGIN_PREVIOUS_VERSIONS_DIR,
} from './plugins/marketplace';
export type {
  DowngradePluginResult,
  InstallPluginOptions,
  InstallPluginResult,
  InstalledPluginSignatureCheck,
  MarketplaceInstalledRecord,
  PluginDowngradeInfo,
  PluginMarketplaceEntry,
  PluginMarketplaceInfo,
  PluginMarketplaceSource,
  PluginMarketplaceSourceKind,
  PluginUpdateInfo,
  PreparedPlugin,
  PreparePluginOptions,
  SecretFinding,
} from './plugins/marketplace';
// v0.93a (worker A sóng v0.93): bundle signing (Ed25519) + trusted keys.
export {
  addTrustedMarketplaceKey,
  enforcePluginSignature,
  generateMarketplaceSigningKeyPair,
  hashPluginBundleFiles,
  listTrustedMarketplaceKeys,
  loadTrustedMarketplaceKeys,
  marketplaceKeyId,
  removeTrustedMarketplaceKey,
  signPluginBundle,
  verifyPluginBundleSignature,
  PLUGIN_SIGNATURE_FILE,
  PLUGIN_TRUSTED_KEYS_FILE,
} from './plugins/signing';
export type {
  EnforcePluginSignatureOptions,
  PluginBundleSignature,
  PluginSignatureStatus,
  PluginSignatureVerification,
  TrustedMarketplaceKey,
  TrustedMarketplaceKeys,
} from './plugins/signing';
export type {
  PluginInfo,
  PluginManifest,
  PluginModule,
  PluginPermission,
} from './plugins/types';
export { PluginLoadError, PLUGIN_PERMISSIONS } from './plugins/types';
export type { Tool, ToolContext, ToolDefinition } from '@open-bot/core';

export { createShellTools, defaultElevateRunner, SHELL_TOOLS } from './shellTools';
export type { ShellToolsOptions } from './shellTools';
export { createLocalTools, LOCAL_TOOLS } from './localTools';
export type { LocalToolsOptions } from './localTools';
export { createComputerUseTools, COMPUTER_USE_TOOLS } from './computerUse';
export type { ComputerUseOptions } from './computerUse';
// --- v0.86a (P1-3): Playwright browser automation (browser_navigate /
// browser_click / browser_type / browser_screenshot / browser_extract) ---
export {
  createBrowserTools,
  createBrowserSession,
  launchPlaywrightBrowser,
  validateNavigateUrl,
  BROWSER_TOOLS,
} from './browserAutomation';
export type {
  BrowserAutomationOptions,
  BrowserSession,
  BrowserDriver,
  BrowserPageDriver,
  BrowserLauncher,
} from './browserAutomation';
export {
  createWebMediaTools,
  WEB_MEDIA_TOOLS,
  createCanvasTools,
  CANVAS_TOOLS,
  IMAGE_CAPABLE_PROVIDERS,
  DEFAULT_VIDEO_MODEL,
  createVideoGenerateTool,
  createVideoStatusTool,
  createVideoCancelTool,
} from './webMedia';
export type { ProviderMediaConfig, WebMediaToolOptions, XPost } from './webMedia';
// --- v0.87d: Gemini image generation (generateContent shape) ---
export {
  HttpGeminiImageProvider,
  geminiImageConfigForSize,
  parseGeminiImageResponse,
  extFromGeminiMimeType,
  GEMINI_DEFAULT_IMAGE_MODEL,
  GEMINI_IMAGE_MODELS,
} from './geminiImage';
export type {
  GeminiImageConfig,
  GeminiImageResult,
  GeminiImageGenerateInput,
  GeminiImageProvider,
} from './geminiImage';
// --- v0.86b (P1-5): async video jobs (video_generate / video_status / video_cancel) ---
export {
  VideoJobStore,
  HttpVideoProvider,
  driveVideoJob,
  finishVideoJob,
  formatVideoJob,
  isVideoJobTerminal,
  VIDEO_JOB_POLL_INTERVAL_MS,
  VIDEO_JOB_DEFAULT_TIMEOUT_MS,
  VIDEO_JOB_TERMINAL_STATUSES,
} from './videoJobs';
export type {
  VideoJob,
  VideoJobStatus,
  VideoJobCreateInput,
  VideoProvider,
  VideoGenerateRequest,
  VideoStartResult,
  VideoPollResult,
  VideoPollStatus,
  HttpVideoProviderConfig,
  DriveVideoJobOptions,
} from './videoJobs';
export { createAgentTools, AGENT_TOOLS } from './agentTools';
export { createSessionHandoffTools, SESSION_HANDOFF_TOOLS, SESSION_HANDOFF_TOOL_NAMES } from './handoffTools';
export type { SessionHandoffToolOptions } from './handoffTools';
export { createA2aTools, A2A_TOOLS } from './a2aTools';
export type { A2aToolOptions, TrustedA2aAgent, TrustedA2aAgentStore } from './a2aTools';
export type { AgentBotConfig, AgentToolOptions, CreatedAgentInfo } from './agentTools';
export { createGitTools, GIT_TOOLS } from './gitTools';
export type { GitToolOptions } from './gitTools';
export { createCiTools, CI_TOOLS } from './ciTools';
export type { CiToolOptions } from './ciTools';
export { createAgentDataTools, AGENT_DATA_TOOLS } from './agentDataTools';
export type { AgentDataToolOptions } from './agentDataTools';
// --- v0.53 (P1-7): tool-call replay history + computer-local bridge ---
export {
  ToolCallHistoryStore,
  MAX_TOOL_CALL_RECORDS,
  TOOL_CALL_HISTORY_FILE,
} from './toolCallHistory';
export type { ToolCallRecord, ToolCallRecordStatus, ToolCallHistoryLike } from './toolCallHistory';
export { createLocalBridgeTools, LOCAL_BRIDGE_TOOLS, MAX_IMAGE_UPLOADS, MAX_LOCAL_BRIDGE_RESULT_CHARS } from './localBridge';
export type {
  LocalBridgeOptions,
  LocalBridgeHandler,
  LocalBridgeHandlerContext,
  LocalBridgeHandlerResult,
  ImageUploadInfo,
} from './localBridge';
// --- v0.59: phone bridge — real pairing state + routing over a replaceable transport ---
export {
  PhoneBridge,
  NoPhoneTransport,
  SocketPhoneTransport,
  createPhoneBridge,
  createPhoneToolHandlers,
} from './phoneBridge';
export type { PhonePairingStatus, PhoneTransport, SocketPhoneTransportOptions } from './phoneBridge';
export {
  PHONE_TOOL_ALLOWLIST,
  PHONE_TOOL_IDS,
  PHONE_ONLY_TOOL_IDS,
  isPhoneToolAllowed,
  isPhoneOnlyTool,
  phoneToolScope,
  assertPhoneToolAllowed,
} from './daemon/phoneTools';
export type { PhoneToolAllowlistEntry } from './daemon/phoneTools';
// --- v0.41 (P0-3): access management (manage_access) + tool-result blob store ---
export { createAccessTools, ACCESS_TOOLS } from './accessTools';
export type { AccessToolOptions } from './accessTools';
export {
  createToolBlobTools,
  fetchToolResultBlob,
  storeToolResultBlob,
  truncateWithBlob,
  TOOL_BLOB_TOOLS,
  BLOB_PREVIEW_CHARS,
  DEFAULT_BLOB_FETCH_CHARS,
  MAX_BLOB_BYTES,
  MAX_BLOB_FETCH_CHARS,
  MAX_BLOBS_PER_WORKSPACE,
} from './blobStore';
// --- v0.41 follow-up: shared truncation helper (dedup 14 ban truncate() local) ---
export {
  MAX_MCP_RESULT_CHARS,
  MAX_PLUGIN_TOOL_OUTPUT_CHARS,
  MAX_TOOL_RESULT_CHARS,
  truncateText,
  truncateTextWithRemainder,
} from './truncate';
export { createMcpSystemTools, MCP_SYSTEM_TOOLS } from './mcpSystemTools';
export type { McpOAuthConfig, McpSystemToolOptions } from './mcpSystemTools';
export { createIntegrationTools, INTEGRATION_TOOLS } from './integrationTools';
export type { IntegrationToolOptions } from './integrationTools';
export { createSkillMarketplaceTools, SKILL_MARKETPLACE_TOOLS } from './skillMarketplaceTools';
export type { SkillMarketplaceToolOptions } from './skillMarketplaceTools';
// --- v0.14: out-of-process plugin sandbox + plugin bundles ---
export {
  SandboxedPluginHost,
  createSandboxedPluginHost,
} from './plugins/sandbox';
export type { SandboxedToolInfo } from './plugins/sandbox';
export {
  loadBundle,
  validateBundleManifest,
  resolveBundleParts,
} from './plugins/bundle';
export type {
  PluginBundleManifest,
  ResolvedPluginBundleParts,
  ResolvedBundleSkill,
  ResolvedBundleHook,
  ResolvedBundleMcpServer,
  ResolvedBundleSlashCommand,
  BundleSkillRef,
  BundleSkillInline,
  BundleSubagentRef,
  BundleHookRef,
  BundleHookMatcher,
  BundleMcpServerRef,
  BundleSlashCommandRef,
} from './plugins/bundle';
export { loadPluginFromManifest, truncatePluginOutput } from './plugins/loader';
// --- v0.89 (worker F4): data / http / text / office-write tools ---
export {
  createDataTools, DATA_TOOLS, parseCsv, csvToJson, jsonToCsv,
  rowsToObjects, csvEscapeCell, parseCondition, parseConditions,
  filterRows, parseAggregates, aggregateRows, parseJsonPath,
  queryJsonPath, MAX_DATA_INPUT_BYTES, MAX_DATA_ROWS,
} from './dataTools';
export type { CsvRow, CsvTable, FilterCondition, AggregateSpec, AggregateResult, PathSegment } from './dataTools';
export {
  createHttpTools, HTTP_TOOLS, doHttpRequest,
  HTTP_REQUEST_TIMEOUT_MS, MAX_HTTP_BODY_BYTES, MAX_HTTP_REDIRECTS,
} from './httpTools';
export type { HttpToolOptions, HttpRequestMethod } from './httpTools';
export {
  createTextTools, TEXT_TOOLS, extractWithRegex, diffLines,
  extractiveSummarize, markdownToc, slugifyHeading,
  MAX_TEXT_INPUT_CHARS, MAX_TEXT_MATCHES, MAX_DIFF_LINES,
} from './textTools';
export type { RegexMatch } from './textTools';
export {
  createOfficeWriteTools, OFFICE_WRITE_TOOLS, buildDocx, buildXlsx,
  buildZip, crc32, escapeXml, parseInlineRuns,
  MAX_OFFICE_WRITE_INPUT_BYTES, MAX_XLSX_ROWS, MAX_XLSX_CELLS_PER_ROW,
} from './officeWriteTools';
export type { ZipEntry } from './officeWriteTools';
