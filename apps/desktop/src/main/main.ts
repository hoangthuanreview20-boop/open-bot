/**
 * Open Bot — Electron MAIN process.
 *
 * Chạy ở Node, là nơi DUY NHẤT giữ API key và AgentRunner.
 * Renderer chỉ giao tiếp qua IPC + contextBridge (xem preload.ts) và
 * KHÔNG BAO GIỜ nhận được API key hay AgentRunner.
 *
 * API key chỉ lưu trong Vault mã hoá (v0.4, vault.json local) và chỉ
 * được gửi tới provider người dùng chọn. settings.json KHÔNG BAO GIỜ
 * chứa API key nữa (migration tự chạy 1 lần lúc khởi động).
 */
import { app, BrowserWindow, dialog, ipcMain, Notification, safeStorage, shell } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  AutomationScheduler,
  BotConfig,
  BotComputerRuntime,
  CoordinatorClient,
  DreamEngine,
  JsonFileAutomationStore,
  SkillRegistry,
  UsageTracker,
  Vault,
  VoiceCallSession,
  // v0.95 (Đội D3): realtime voice session (duplex + barge-in +
  // turn-taking) + provider adapters.
  RealtimeSession,
  buildOpenAiRealtimeUrl,
  isRealtimeProvider,
  isTurnTakingMode,
  // v0.96 (Đội T5 — voice live): session persistence (transcript
  // on disk, resume without the socket).
  VoiceSessionStore,
  // v0.96 (Đội T5 — voice live): mock fallback when the user has
  // no key — the app keeps working at $0 instead of erroring.
  MockRealtimeTransport,
  WorkerPool,
  A2aClient,
  OnePasswordBroker,
  addMember,
  applyComposioPersistedState,
  applyPluginTemplate,
  auditCredentialNamespaces,
  appendAuditEvent,
  buildAuthUrl,
  buildComposioStateView,
  buildPeekChangesResult,
  buildProviderRail,
  canEditBot,
  checkForUpdate,
  cleanDisabledProviders,
  filterRailForBot,
  cloneAgent,
  ComposioAppSource,
  COMPUTER_AUTO_SHED_AUDIT_ACTION,
  composioStateToPersist,
  createA2aServer,
  createApiServer,
  createAutomationWebhookKey,
  createFileTaskStore,
  createGlobRulesHook,
  createMcpServer,
  createOAuthCallbackServer,
  createPluginTemplate,
  createProvider,
  createRolePolicyChecker,
  createSafeStorageEncryptor,
  clearComposioApiKey,
  clearComposioUserId,
  createServiceAccount,
  customAcpKind,
  defaultAppRegistry,
  detectComputerBackends,
  DetectedEngineRegistry,
  DETECTED_ENGINES_FILE,
  COMPOSIO_ROUTER_APP_ID,
  COMPOSIO_TOOLKIT_SLUGS,
  effectiveBaseUrl,
  exchangeCodeForTokens,
  exportPluginTemplate,
  fetchAgentCard,
  getLocalProfile,
  getComposioApiKey,
  getComposioUserId,
  // v0.95 (Team D2): media keys — Vault namespace 'media'.
  clearMediaApiKey,
  getAllMediaApiKeys,
  getMediaApiKey,
  getMediaKeyStatus,
  isMediaProviderId,
  setMediaApiKey,
  COMPOSIO_TRIGGER_DEFS,
  getSharedComposioTriggerQueue,
  computeComposioWebhookSignature,
  createComposioTriggerToken,
  deleteComposioTriggerSecrets,
  deleteComposioTriggerSigningSecret,
  deleteComposioTriggerToken,
  getComposioTriggerSigningSecret,
  getComposioTriggerTokenByKeyId,
  getSlackSigningSecret,
  hasComposioTriggerSigningSecret,
  hasComposioTriggerToken,
  hasSlackSigningSecret,
  computeSlackSignature,
  deleteSlackSigningSecret,
  isSlackMessageTriggerSlug,
  rotateComposioTriggerToken,
  setComposioTriggerSigningSecret,
  setSlackSigningSecret,
  getMember,
  getOAuthProvider,
  getOrCreateMachineId,
  getPluginTemplate,
  hasComposioApiKey,
  hasComposioUserId,
  getProviderIdentity,
  getTeamId,
  isBotApprovalLevel,
  HookRegistry,
  installPublished,
  importPluginTemplate,
  isA2aTerminalState,
  isHostBusy,
  isEngineUsable,
  isEngineUsableAllowingUnknown,
  isOAuthSupported,
  isProviderAllowed,
  isVoiceSurface,
  DICTATION_MAX_BYTES,
  VOICE_CALL_SEARCH_HIT_LIMIT,
  listBuiltInTemplates,
  listMcpAvailable,
  listMcpInstalled,
  listPluginTemplates,
  listPublished,
  listServiceAccounts,
  listSharedBots,
  LOCAL_USER_ID,
  listApps,
  getMarketplaceRegistryFingerprint,
  MarketplaceProbeCache,
  // v0.89a (worker F1 — Marketplace v2): versions, remote catalog, approvals.
  checkMcpUpdates,
  fetchRemoteMarketplaceCatalog,
  installMcpServerVersion,
  listMarketplaceApprovals,
  loadVersionedRegistry,
  recordMarketplaceApproval,
  requireMarketplaceApproval,
  searchMarketplaceServers,
  updateMcpServer,
  validateVersionedMarketplaceServer,
  probeMachine,
  probeMarketplaceServerTools,
  deriveAppAuthStatus,
  DEFAULT_APP_TOOL_CAP,
  getApp,
  loadPolicy,
  loadTeamConfig,
  migrateCredentials,
  ModelRegistry,
  MODELS_FILE,
  newOAuthState,
  OAUTH_PROVIDERS,
  OllamaProvider,
  OLLAMA_BASE_URL,
  PLUGIN_TEMPLATES_DIR,
  optionalString,
  parseTeamBundle,
  partsToText,
  planComputers,
  PROVIDERS,
  TEAM_BUNDLE_MAX_BYTES,
  publishAgent,
  redactBearer,
  redactSecrets,
  removeMember,
  requireBase64,
  requireBoolean,
  requireHttpUrl,
  requireWsUrl,
  requireId,
  requireInt,
  requireString,
  requireStringArray,
  requireText,
  revokeServiceAccount,
  resolveComposioPersistedState,
  resolveTeamEgressPolicy,
  retryWithBackoff,
  API_RESTART_MAX_ATTEMPTS,
  SKILL_FILE_NAME,
  saveTeamConfig,
  savePluginTemplate,
  saveValidatedGithubPat,
  GithubPatRevalidator,
  GITHUB_PAT_UNCHECKABLE_NETWORK_DETAIL,
  BOT_DESCRIPTION_MAX_LENGTH,
  buildTeamBundle,
  describeSkippedSkill,
  sanitizeDenySkills,
  setComposioApiKey,
  setComposioUserId,
  setLocalDisplayName,
  setProviderIdentity,
  deletePluginTemplate,
  deleteProviderIdentity,
  deleteAutomationWebhookKey,
  getAutomationWebhookKey,
  hasAutomationWebhookKey,
  isNonEmptyTeam,
  rotateAutomationWebhookKey,
  checkTeamImportConflicts,
  CanvasStore,
  computeWebhookSignature,
  // v0.86 (P2-7): crash reporting opt-in (local only).
  CrashCollector,
  CrashReportStore,
  defaultRedactOpts,
  // v0.87c: OS notifications (Electron Notification, main only).
  formatNotificationText,
  NotificationService,
  notificationSettingsKey,
  resolveNotificationSettings,
  validateNotificationRequest,
  setRole,
  setWorkspaceDir,
  shareBot,
  summarizeTeamBundle,
  transcribeAudio,
  transcribeDictation,
  uninstallMcpServer,
  uninstallPublished,
  unshareBot,
  usableCustomEngineBinary,
  usableEngineBinary,
  validateVisionAttachments,
  validateWorkspaceDir,
  parseHarnessThreadLogParams,
  WebhookKeyStore,
  WebhookDispatcher,
  // v0.86 (P1-4): TTS harness (local-first, no paid service, no key).
  TtsHarness,
  // Đội D (fleet): tầng fleet đa người dùng — registry + service +
  // audit/decision/usage theo workspace (core vẫn single-user).
  FleetManager,
  currentOsUser,
  // v0.94c: nhịp kiểm tra digest project tới hạn (15 phút).
  PROJECT_UPDATES_CHECK_MS,
} from '@open-bot/core';
// v0.95d4 (Đội D4): user profile + long-term memory (local-first) cho IPC.
import { loadLocalProfile, LongTermMemory, OllamaEmbeddings, updateLocalProfile } from '@open-bot/core';
// v0.96 (Đội T1): memory blocks + consolidation + MemFS-lite cho IPC `memory-blocks:*`.
import {
  MemoryBlockStore,
  consolidate,
  exportBlocksToMemFs,
  importBlocksFromMemFs,
  importFactsFromMemFs,
  MEMFS_BLOCKS_DIR_NAME,
} from '@open-bot/core';
import type {
  A2aAgentCard,
  AppAuthStatus,
  AppStatusView,
  A2aServerWithInternals,
  AgentEvent,
  ApiHandlers,
  ApiRunRecord,
  AppliedPluginTemplate,
  AutoApproveRuleInput,
  Automation,
  AutomationEvent,
  BotComputerRequest,
  McpOAuthClientConfig,
  AutomationHandlers,
  AutomationPolicyChecker,
  ComposioPersistedState,
  ComposioStateView,
  ComposioToolkitConnection,
  ComputerBackend,
  CreateFleetWorkspaceInput,
  FleetRole,
  CreatePluginTemplateInput,
  DreamConfig,
  DetectedEnginesSnapshot,
  Encryptor,
  HarnessEventsFilter,
  HarnessEventKind,
  HarnessStreamEvent,
  LocalApiServer,
  LocalProfile,
  LongTermMemoryEntry,
  MachinePolicy,
  MachineProfile,
  MarketplaceApprovalKind,
  ModelRegistrySnapshot,
  NotificationKind,
  NotificationOutcome,
  NotificationSettings,
  PluginTemplate,
  Provider,
  ProviderConfig,
  ProviderIdentity,
  ProviderRail,
  VersionedMarketplaceServer,
  ServiceAccountScope,
  SpendLimits,
  TeamRole,
  TeamBundle,
  TokenSet,
  ToolCall,
  OnePasswordBrokerStatus,
  UpdateCheckResult,
  VisionAttachment,
} from '@open-bot/core';
import type { RealtimeConfig } from '@open-bot/core';
import type { VoiceCallToolHandlers, VoiceSessionEvent } from '@open-bot/core';
import type {
  RealtimeProvider,
  RealtimeSessionEvent,
  TurnTakingMode,
} from '@open-bot/core';
import {
  addTrustedMarketplaceKey,
  checkPluginUpdates,
  checkWatches,
  createDenylistHook,
  discardPreparedPlugin,
  downgradePlugin,
  fetchFeed,
  getPluginDowngradeInfo,
  installPreparedPlugin,
  InternetDataStore,
  INTERNET_DATA_FILE,
  listMarketplacePlugins,
  listTrustedMarketplaceKeys,
  PluginManager,
  preparePluginFromSource,
  removeTrustedMarketplaceKey,
  searchMarketplacePlugins,
  ToolCallHistoryStore,
  uninstallMarketplacePlugin,
  validatePluginMarketplaceEntry,
} from '@open-bot/tools';
import type { PluginMarketplaceEntry, PreparedPlugin } from '@open-bot/tools';
// v0.10: run tracing — deep import, not the core barrel: the barrel
// (packages/core/src/index.ts) is being edited in parallel by the
// hooks worker, so the tracing barrel exports land with the
// coordinator instead. Tests already use this deep path for the same
// reason (see packages/core/src/skills/index.ts header).
import { TraceStore, TRACES_FILE } from '@open-bot/core/dist/tracing/index.js';
import type { Trace, TraceSummary } from '@open-bot/core/dist/tracing/index.js';
// v0.54 (P1-9): update theo track — service thuần (không import electron),
// track persist vào `<userData>/update-track.json` (xem getUpdateService).
import { UpdateService } from './updateService';
import type { UpdateCheckTrigger, UpdateStatus } from './updateService';
// UI-12 (v0.60): stored-plan reader lives in ./plans (no Electron import,
// so the parser is unit-testable); main only resolves workspaces here.
import { listStoredPlansForBots, type StoredPlan } from './plans';
// v0.80: portable team bundle — apply decisions are pure (no Electron),
// main only does the dialogs / file I/O / persistence around them.
import { planTeamImport } from './teamPortable';
// v0.86 (P2-6): deep-link `open-bot://` — setupDeepLink/handleDeepLinkUrl
// trong ./deeplink (mock-testable, không import electron trực tiếp);
// parser thuần nằm ở @open-bot/core.
import { setupDeepLink, handleDeepLinkUrl } from './deeplink';
import type { DeepLinkRoute } from '@open-bot/core';

// v0.7: V8 code-cache — renderer khởi động lần sau nhanh hơn nhờ cache
// bytecode. Cờ Chromium `--v8-cache-options=code` phải đặt trước khi
// app ready (không có API Electron riêng cho việc này).
// Đo bằng tay dưới xvfb: OPEN_BOT_NO_CODE_CACHE=1 tắt cờ để so sánh
// trước/sau (xem báo cáo v0.7 — hiệu quả phụ thuộc máy, không hứa số).
if (process.env.OPEN_BOT_NO_CODE_CACHE !== '1') {
  app.commandLine.appendSwitch('v8-cache-options', 'code');
}

// ---------------------------------------------------------------------------
// Kiểu dữ liệu
// ---------------------------------------------------------------------------

export interface ProviderSettings {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  /** WebSocket URL realtime (dạng OpenAI Realtime API). Để trống = không hỗ trợ voice. */
  realtimeUrl?: string;
}

/** Supported UI locales (v0.72c, Team C: + zh, ja, es, fr). */
export const APP_LOCALES = ['vi', 'en', 'zh', 'ja', 'es', 'fr'] as const;
export type AppLocale = (typeof APP_LOCALES)[number];

/** True when the code is a supported UI locale. */
export function isAppLocale(code: unknown): code is AppLocale {
  return typeof code === 'string' && (APP_LOCALES as readonly string[]).includes(code);
}

export interface AppSettings {
  providers: Record<string, ProviderSettings>;
  bots: BotConfig[];
  /** UI locale code. Defaults to 'vi'. */
  locale: AppLocale;
  /** v0.4: cấu hình dream (mặc định tắt). */
  dream?: DreamConfig;
  /** v0.5: cấu hình Local API (chỉ enabled + port; token ở Vault). */
  api?: ApiSettings;
  /** v0.5: lựa chọn NO_STORAGE của người dùng; áp lại lúc khởi động. */
  vaultNoStorage?: boolean;
  /**
   * v0.57: trạng thái tích hợp Composio (chỉ bật/tắt + toolkit — KHÔNG
   * BAO GIỜ chứa key; key nằm trong Vault, xem keyStore.ts).
   */
  composio?: ComposioPersistedState;
  /**
   * v0.59: bật/tắt 1Password broker (mặc định bật). Tắt thì main không
   * spawn worker `op`, status trả về "đã tắt" và import-field từ chối.
   */
  onePasswordEnabled?: boolean;
  /**
   * v0.86 (P2-7): bật/tắt crash reporting (mặc định TẮT — opt-in).
   * Chỉ khi user bật rõ trong Settings → Security thì main process
   * mới ghi crash report local (đã redact PII, không gửi đi đâu).
   */
  crashReportingEnabled?: boolean;
  /**
   * v0.87c: OS notifications theo từng loại sự kiện (mặc định cả 3
   * đều BẬT — xem resolveNotificationSettings). Chỉ bật/tắt, không
   * chứa nội dung thông báo hay dữ liệu nhạy cảm.
   */
  notifications?: NotificationSettings;
}

/** v0.5: cấu hình Local API. Mặc định tắt, port 3456. */
export interface ApiSettings {
  enabled: boolean;
  port: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: number;
  /**
   * v0.65 (vision persistence): images attached to this user message
   * (core `VisionAttachment` — base64 for display). The optimistic
   * bubble carries them from the send; a history reload re-reads them
   * from storage via `historyFromMemory`. A stored image whose file is
   * gone/corrupt arrives with `data: ''` + `unavailable: true` (the
   * renderer shows a note instead of a thumbnail).
   */
  attachments?: VisionAttachment[];
}

export interface TaskItem {
  id: string;
  botId: string;
  title: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  detail?: string;
}

interface BotRuntime {
  bot: BotConfig;
  /**
   * Lịch sử chat giữ ở main (dự phòng khi BotMemory chưa có bản ghi).
   * BotMemory thật nằm trong tiến trình coordinator (xem getCoordinator);
   * main KHÔNG BAO GIỜ mở BotMemory để tránh tranh chấp SQLite.
   */
  history: ChatMessage[];
  tasks: TaskItem[];
}

// ---------------------------------------------------------------------------
// Settings (chỉ main process đọc/ghi file này)
// ---------------------------------------------------------------------------

const SETTINGS_FILE = 'settings.json';
let settingsPath = '';
let settings: AppSettings = { providers: {}, bots: [], locale: 'vi' };
let mainWindow: BrowserWindow | null = null;
/** v0.7: cửa sổ "đang khởi động" tối giản của giai đoạn 1 (đóng khi giai đoạn 2 xong). */
let splashWindow: BrowserWindow | null = null;
/**
 * v0.86 (P2-6): deep-link `open-bot://` — route đang chờ renderer kéo về.
 * URL có thể tới trước khi cửa sổ chính mở (khởi động qua protocol,
 * `open-url` trên macOS) hoặc trước khi renderer mount xong; lúc đó
 * route nằm đây và renderer lấy qua IPC `deep-link:pending` lúc mount.
 * `deepLinkRendererReady` bật khi renderer đã kéo 1 lần (= đã mount
 * và subscribe `deep-link:open`); URL tới sau đó đẩy thẳng qua IPC.
 */
let pendingDeepLinkRoute: DeepLinkRoute | null = null;
let deepLinkRendererReady = false;

/** Route bot chỉ hợp lệ khi bot đó còn tồn tại trong settings. */
function validateDeepLinkRoute(route: DeepLinkRoute): DeepLinkRoute | null {
  if (route.kind === 'bot' && !settings.bots.some((b) => b.id === route.botId)) {
    console.warn(`[deep-link] Bỏ qua route bot không tồn tại: ${route.botId}`);
    return null;
  }
  return route;
}

/** Đẩy route tới renderer nếu đã sẵn, không thì giữ lại chờ kéo về. */
function deliverDeepLink(route: DeepLinkRoute): void {
  const valid = validateDeepLinkRoute(route);
  if (!valid) return;
  if (mainWindow && !mainWindow.isDestroyed() && deepLinkRendererReady) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.send('deep-link:open', valid);
    return;
  }
  pendingDeepLinkRoute = valid;
}

/** Điểm vào duy nhất cho mọi URL deep-link thô (open-url / second-instance / argv). */
function handleDeepLinkRaw(rawUrl: string): void {
  handleDeepLinkUrl(rawUrl, (route) => deliverDeepLink(route));
}
/** v0.7: policy máy (`<userData>/policy.json`, null = không có file). */
let activePolicy: MachinePolicy | null = null;
/** v0.7: tài khoản chính local (profile.json, tạo 1 lần, id ổn định). */
let localProfile: LocalProfile | null = null;
/** v0.7: chống đăng nhập OAuth chồng nhau (1 lượt tại 1 thời điểm). */
let oauthLoginInFlight = false;

/** Thư mục được phép chứa workspaceDir do renderer gửi lên (IPC validate). */
function workspaceRoots(): string[] {
  const userData = app.getPath('userData');
  return [
    userData,
    path.join(os.homedir(), 'open-bot-workspaces'),
    path.join(os.homedir(), 'workspace'),
  ];
}

/** Provider id có trong PROVIDERS (chặn id lạ từ renderer/policy). */
function isKnownProvider(id: string): boolean {
  return (PROVIDERS as Array<{ id: string }>).some((p) => p.id === id);
}

/**
 * v0.7: áp policy vào settings đã load — baseUrl mặc định của
 * provider được ghim về backend của policy khi người dùng chưa tự
 * gõ baseUrl riêng (baseUrl đã gõ tay luôn thắng policy). Trả về
 * true khi có thay đổi (caller lưu lại settings).
 */
function applyPolicyToSettings(): boolean {
  if (!activePolicy?.backendBaseUrl) return false;
  let changed = false;
  for (const p of PROVIDERS as Array<{ id: string; defaultBaseUrl?: string }>) {
    const saved = settings.providers[p.id];
    if (!saved) continue;
    const current = saved.baseUrl?.trim() ?? '';
    if (current !== '' && current !== (p.defaultBaseUrl ?? '')) continue; // user đã gõ tay
    const pinned = effectiveBaseUrl(activePolicy, p.id, p.defaultBaseUrl ?? '', '');
    if (pinned && pinned !== current) {
      saved.baseUrl = pinned;
      changed = true;
    }
  }
  return changed;
}

function defaultProviderSettings(): Record<string, ProviderSettings> {
  const out: Record<string, ProviderSettings> = {};
  for (const p of PROVIDERS as Array<{
    id: string;
    defaultModel: string;
    defaultBaseUrl?: string;
  }>) {
    out[p.id] = { apiKey: '', baseUrl: p.defaultBaseUrl ?? '', defaultModel: p.defaultModel };
  }
  return out;
}

function loadSettings(): AppSettings {
  settingsPath = path.join(app.getPath('userData'), SETTINGS_FILE);
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      providers: { ...defaultProviderSettings(), ...(parsed.providers ?? {}) },
      bots: parsed.bots ?? [],
      locale: isAppLocale(parsed.locale) ? parsed.locale : 'vi',
      dream: parsed.dream,
      api: {
        enabled: parsed.api?.enabled === true,
        port:
          typeof parsed.api?.port === 'number' && parsed.api.port >= 1024 && parsed.api.port <= 65535
            ? parsed.api.port
            : 3456,
      },
      vaultNoStorage: parsed.vaultNoStorage === true,
      // v0.57: trạng thái Composio đã lưu — validate qua helper (key
      // không nằm đây, chỉ bật/tắt + toolkit).
      composio: resolveComposioPersistedState(parsed.composio),
      // v0.59: 1Password broker mặc định bật; chỉ tắt khi user tắt rõ.
      onePasswordEnabled: parsed.onePasswordEnabled !== false,
      // v0.86 (P2-7): crash reporting mặc định TẮT (opt-in).
      crashReportingEnabled: parsed.crashReportingEnabled === true,
      // v0.87c: OS notifications — cả 3 loại mặc định BẬT; giá trị
      // lạ / thiếu từng loại thì về mặc định (không tắt lặng lẽ).
      notifications: resolveNotificationSettings(parsed.notifications),
    };
  } catch {
    return {
      providers: defaultProviderSettings(),
      bots: [],
      locale: 'vi',
      api: { enabled: false, port: 3456 },
      vaultNoStorage: false,
      composio: resolveComposioPersistedState(undefined),
      onePasswordEnabled: true,
      crashReportingEnabled: false,
      notifications: resolveNotificationSettings(undefined),
    };
  }
}

function saveSettings(): void {
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    // Chỉ log message, KHÔNG log nội dung settings (chứa API key).
    console.error('[open-bot] Không lưu được settings:', (err as Error).message);
  }
}

/** Bản settings gửi về renderer: API key KHÔNG bao giờ rời main process. */
function settingsForRenderer(): {
  providers: Record<string, { apiKeySet: boolean; baseUrl: string; defaultModel: string }>;
  bots: BotConfig[];
  locale: AppLocale;
  /** v0.86 (P2-7): crash reporting có đang bật không (mặc định tắt). */
  crashReportingEnabled: boolean;
  /** v0.87c: OS notifications theo từng loại (mặc định cả 3 đều bật). */
  notifications: NotificationSettings;
  /** v0.7: policy đang áp (renderer chỉ hiển thị, không sửa được). */
  policy?: { backendBaseUrl?: string; allowedProviders?: string[]; disableTelemetry?: boolean };
} {
  const providers: Record<string, { apiKeySet: boolean; baseUrl: string; defaultModel: string }> = {};
  for (const [id, p] of Object.entries(settings.providers)) {
    // v0.7: policy allowedProviders — provider bị cấm không hiện ở UI.
    if (!isProviderAllowed(activePolicy, id)) continue;
    // v0.4: API key sống trong Vault, settings.json không còn giữ key.
    providers[id] = { apiKeySet: vault.hasSecret('provider', id), baseUrl: p.baseUrl, defaultModel: p.defaultModel };
  }
  const out = {
    providers,
    bots: settings.bots,
    locale: settings.locale,
    // v0.86 (P2-7): crash reporting mặc định tắt (opt-in).
    crashReportingEnabled: settings.crashReportingEnabled === true,
    // v0.87c: OS notifications — resolve để cài đặt cũ (chưa có field)
    // vẫn nhận đủ 3 loại mặc định BẬT.
    notifications: resolveNotificationSettings(settings.notifications),
  } as {
    providers: typeof providers;
    bots: BotConfig[];
    locale: AppLocale;
    crashReportingEnabled: boolean;
    notifications: NotificationSettings;
    policy?: { backendBaseUrl?: string; allowedProviders?: string[]; disableTelemetry?: boolean };
  };
  if (activePolicy) {
    out.policy = {
      backendBaseUrl: activePolicy.backendBaseUrl,
      allowedProviders: activePolicy.allowedProviders,
      disableTelemetry: activePolicy.disableTelemetry,
    };
  }
  return out;
}

// v0.61 (UI-10 fix): `ensureDefaultBot` was deleted here. It used to
// seed a "Trợ lý" bot when no bot existed, which made the first-run
// onboarding (shown only when there is no bot yet) unreachable in the
// real app. First run now shows the onboarding screen; the user creates
// the sample bot (or their own) in one click. Existing installs already
// have bots, so nothing changes for them.

// ---------------------------------------------------------------------------
// v0.4: Vault + UsageTracker (secret mã hoá, giới hạn chi tiêu)
// ---------------------------------------------------------------------------

const VAULT_FILE = 'vault.json';
const USAGE_FILE = 'usage.json';
let vault: Vault;
/** Encryptor của Vault chính — WebhookKeyStore dùng chung backend này (v0.59). */
let vaultEncryptor: Encryptor | undefined;
let usageTracker: UsageTracker;

function initVaultAndUsage(userDataDir: string): void {
  // safeStorage là backend chính; khi OS không có keychain/DPAPI thì
  // createSafeStorageEncryptor throw -> fallback LocalEncryptor
  // (key file vault.json.key, mode 0600) + log cảnh báo MỘT dòng.
  try {
    vaultEncryptor = createSafeStorageEncryptor(safeStorage);
    vault = new Vault({
      storePath: path.join(userDataDir, VAULT_FILE),
      encryptor: vaultEncryptor,
    });
  } catch (err) {
    vaultEncryptor = undefined;
    console.error(
      '[open-bot] safeStorage không khả dụng, dùng LocalEncryptor fallback:',
      (err as Error).message,
    );
    vault = new Vault({ storePath: path.join(userDataDir, VAULT_FILE) });
  }
  usageTracker = new UsageTracker({ storePath: path.join(userDataDir, USAGE_FILE) });
}

// ---------------------------------------------------------------------------
// v0.86 (P2-7): Crash reporting opt-in — local only, NO sending.
// Store + collector sống ở main process. Collector chỉ ghi report khi
// `settings.crashReportingEnabled === true` (mặc định TẮT, user bật rõ
// trong Settings → Security). Report đã redact PII (home dir, user,
// key/token) trước khi ghi — xem packages/core/src/crash/.
// Lưu ý: gắn handler `uncaughtException` nghĩa là main process không
// còn exit mặc định khi crash chưa bắt — thay vào đó report được ghi
// rồi app chạy tiếp (hợp đồng opt-in, xem docs/crash-reporting.md).
// ---------------------------------------------------------------------------

const CRASH_REPORTS_DIR = 'crash-reports';
let crashReportStore: CrashReportStore | null = null;
let crashCollector: CrashCollector | null = null;

// Đội D (fleet): tầng fleet đa người dùng — 1 FleetManager cho cả app
// (khởi tạo lười khi IPC fleet gọi lần đầu; dispose ở before-quit).
let fleetManager: FleetManager | null = null;

function getCrashReportStore(): CrashReportStore {
  if (!crashReportStore) {
    crashReportStore = new CrashReportStore(path.join(app.getPath('userData'), CRASH_REPORTS_DIR));
  }
  return crashReportStore;
}

function getCrashCollector(): CrashCollector {
  if (!crashCollector) {
    crashCollector = new CrashCollector({
      store: getCrashReportStore(),
      isEnabled: () => settings.crashReportingEnabled === true,
      source: 'main',
      appVersion: app.getVersion(),
      redactOpts: defaultRedactOpts(),
    });
  }
  return crashCollector;
}

function initCrashReporting(): void {
  getCrashCollector().install();
}

// ---------------------------------------------------------------------------
// v0.87c: OS notifications — Electron Notification, main process only.
// Renderer KHÔNG BAO GIỜ gọi Notification trực tiếp: nó (và coordinator)
// chỉ gửi request qua IPC `notifications:send`, main validate qua core
// rồi bắn popup. Logic chống spam (toggle từng loại, dedupe 10s,
// tối đa 5/loại/60s) sống trong core NotificationService — xem
// packages/core/src/notifications/service.ts.
//
// Giới hạn trung thực: VM headless không có notification daemon nên
// popup thật chưa từng được thấy hiện trên màn hình (xem
// docs/notifications.md). Trên máy đó `Notification.isSupported()`
// trả false và service trả `{ shown: false, reason: 'unsupported' }`
// thay vì giả vờ đã hiện. Nút "Gửi thử" trong Settings chỉ kiểm
// chứng được logic tới đó.
// ---------------------------------------------------------------------------

let notificationService: NotificationService | null = null;

function getNotificationService(): NotificationService {
  if (!notificationService) {
    notificationService = new NotificationService({
      show: (n) => {
        const note = new Notification({ title: n.title, body: n.body });
        // Click mở đúng bot/run qua deep-link nội bộ (đường đi giống
        // deep-link OS: focus cửa sổ + deliverDeepLink).
        note.on('click', () => n.onClick());
        note.show();
      },
      isSupported: () => Notification.isSupported(),
      isEnabled: (kind) =>
        resolveNotificationSettings(settings.notifications)[notificationSettingsKey(kind)],
      onActivate: (route) => deliverDeepLink(route),
    });
  }
  return notificationService;
}

/**
 * Bắn một thông báo tự động (run xong / cần duyệt / lỗi) cho bot.
 * Text theo locale đã lưu của user; lỗi đã redact trước khi tới đây
 * (chat:send redact qua redactErrorText). Không bao giờ throw: thông
 * báo là best-effort, lỗi trong đường này không được làm hỏng run.
 * Trả outcome để caller log được lý do khi không hiện.
 */
function notifyBotEvent(
  kind: NotificationKind,
  botId: string,
  vars: { tool?: string; error?: string; url?: string; dedupeKey?: string },
): NotificationOutcome {
  try {
    const bot = settings.bots.find((b) => b.id === botId);
    const text = formatNotificationText(settings.locale, kind, {
      botName: bot?.name ?? botId,
      ...(vars.tool !== undefined ? { tool: vars.tool } : {}),
      ...(vars.error !== undefined ? { error: vars.error } : {}),
      ...(vars.url !== undefined ? { url: vars.url } : {}),
    });
    const outcome = getNotificationService().notify({
      kind,
      title: text.title,
      body: text.body,
      botId,
      ...(vars.dedupeKey !== undefined ? { dedupeKey: vars.dedupeKey } : {}),
    });
    if (!outcome.shown) {
      console.log(`[notifications] Không hiện ${kind} cho bot ${botId}: ${outcome.reason ?? 'unknown'}`);
    }
    return outcome;
  } catch (err) {
    console.error('[notifications] Lỗi khi bắn thông báo:', (err as Error).message);
    return { shown: false, reason: 'unsupported', detail: (err as Error).message };
  }
}

/**
 * v0.59 (P1-6 follow-up): webhook keys nằm trong file RIÊNG
 * `automation-webhook-keys.json` (WebhookKeyStore), không còn trong
 * `vault.json`. Lazy singleton — dùng chung encryptor với Vault chính
 * (safeStorage khi có, không thì WebhookKeyStore tự build
 * LocalEncryptor từ key file riêng). Key cũ trong Vault chính
 * (namespace `automation-webhook-keys/`) được migrate lười ở lần đọc
 * đầu tiên — các hàm key trong `automations/webhookKeys.ts` nhận cặp
 * `{ store, legacyStore: vault }` để làm việc đó.
 */
let webhookKeyStore: WebhookKeyStore | null = null;
function getWebhookKeyStore(): WebhookKeyStore {
  if (!webhookKeyStore) {
    webhookKeyStore = new WebhookKeyStore({
      dir: app.getPath('userData'),
      ...(vaultEncryptor ? { encryptor: vaultEncryptor } : {}),
    });
  }
  return webhookKeyStore;
}

/** Cặp store cho mọi thao tác key webhook: ghi vào store riêng, đọc fallback kho cũ để migrate. */
function webhookKeyStores(): { store: WebhookKeyStore; legacyStore: Vault } {
  return { store: getWebhookKeyStore(), legacyStore: vault };
}

/**
 * v0.53 (P1-6): 1Password broker — main process owns the ONLY broker
 * instance (lazy singleton). The broker spawns its own worker process
 * that invokes the `op` CLI; no 1Password credential ever enters the
 * renderer or the Vault directly — `onepassword:import-field` below
 * fetches ONE field value in main and stores it straight into the
 * Vault. When `op` is not installed the broker reports
 * `available: false` (status IPC) instead of throwing.
 */
let onePasswordBroker: OnePasswordBroker | null = null;
function getOnePasswordBroker(): OnePasswordBroker {
  if (!onePasswordBroker) onePasswordBroker = new OnePasswordBroker();
  return onePasswordBroker;
}

/**
 * Migration v0.4 (chạy 1 lần): key còn nằm trong settings.json được dời
 * sang Vault rồi xoá khỏi settings. Sau migration, settings.json KHÔNG
 * BAO GIỜ chứa API key nữa. Idempotent: chạy lại không làm gì vì apiKey
 * đã rỗng.
 */
function migrateApiKeysToVault(): void {
  let moved = false;
  for (const [id, p] of Object.entries(settings.providers)) {
    const key = p.apiKey?.trim();
    if (!key) continue;
    if (!vault.hasSecret('provider', id)) {
      vault.setSecret('provider', id, key);
    }
    p.apiKey = '';
    moved = true;
  }
  if (moved) {
    saveSettings();
    console.log('[open-bot] Đã dời API key từ settings.json sang Vault.');
  }
}

// ---------------------------------------------------------------------------
// v0.5: Model registry + machine id + secret redaction
// ---------------------------------------------------------------------------

/** Registry là nguồn duy nhất cho tên model — client không hard-code nữa. */
let modelRegistry: ModelRegistry | null = null;
/** v0.5: định danh máy ổn định (uuid), khởi tạo ở app.whenReady. Không log giá trị. */
let machineId = '';

function initModelRegistry(userDataDir: string): void {
  modelRegistry = new ModelRegistry({
    filePath: path.join(userDataDir, MODELS_FILE),
    logger: { warn: (msg: string) => console.warn(`[models] ${msg}`) },
  });
  modelRegistry.load();
}

// ---------------------------------------------------------------------------
// M1: Detected CLI engines — registry phát hiện CLI trên máy user.
// Khởi tạo lười (lần đầu gọi IPC engines:* hoặc tạo bot CLI); detect
// thật chỉ chạy khi cần (detect() có cache 60s), không chặn khởi động.
// ---------------------------------------------------------------------------

let detectedEngines: DetectedEngineRegistry | null = null;

function getDetectedEngines(): DetectedEngineRegistry {
  if (!detectedEngines) {
    detectedEngines = new DetectedEngineRegistry({
      stateFilePath: path.join(app.getPath('userData'), DETECTED_ENGINES_FILE),
      logger: { warn: (msg: string) => console.warn(`[engines] ${msg}`) },
    });
  }
  return detectedEngines;
}

/** Model mặc định của provider theo registry ('' khi chưa chọn preset). */
function defaultModelFor(providerId: string): string {
  try {
    return modelRegistry?.getDefault(providerId) ?? '';
  } catch {
    return '';
  }
}

/**
 * Tất cả API key provider đang lưu — dùng để redact lỗi trả về renderer.
 * Chỉ gọi khi cần redact (mỗi lần gọi đọc Vault); không cache key ở ngoài.
 */
function knownProviderKeys(): string[] {
  const keys: string[] = [];
  for (const id of vault.listSecrets('provider')) {
    const value = vault.getSecret('provider', id);
    if (value) keys.push(value);
  }
  return keys;
}

/** Redact lỗi trước khi trả về renderer / log: Bearer… + key provider đã biết. */
function redactErrorText(text: string): string {
  return redactBearer(redactSecrets(text, knownProviderKeys()));
}

// ---------------------------------------------------------------------------
// v0.5: Local API (loopback) + webhooks
// ---------------------------------------------------------------------------

const API_FILE = 'webhooks.json';
const DEFAULT_API_PORT = 3456;
const API_TOKEN_NAMESPACE = 'api';
const API_TOKEN_KEY = 'token';

let apiServer: LocalApiServer | null = null;
/**
 * v0.28: giữ tham chiếu A2A server để IPC `a2a:persist-status` đọc
 * trạng thái lưu task (null khi Local API chưa chạy / đã dừng).
 */
let a2aServerRef: { getPersistStatus(): import('@open-bot/core').A2aPersistStatus } | null = null;
let webhookDispatcher: WebhookDispatcher | null = null;
/** Trạng thái API hiện tại (đọc bởi 'api:get'). */
let apiConfig: ApiSettings = { enabled: false, port: DEFAULT_API_PORT };
/**
 * v0.90d: lỗi khởi động Local API gần nhất (null = đang chạy tốt
 * hoặc chưa từng thử). Đọc bởi IPC `api:get` (`lastError`) để
 * Settings hiện lỗi thay vì im lặng; `stopApiServer()` (tắt có
 * chủ đích) xoá nó.
 */
let apiStartError: string | null = null;
/**
 * v0.90d: thế hệ vòng thử lại khởi động API — `stopApiServer()`
 * tăng lên để huỷ mọi vòng retry đang chờ (đổi cấu hình, tắt API,
 * app thoát). Vòng retry chỉ tiếp tục khi thế hệ lúc nó bắt đầu
 * vẫn còn hiệu lực và `apiConfig.enabled` vẫn true.
 */
let apiRestartGeneration = 0;
/** v0.90d: true khi đang có một vòng retry khởi động API chạy — tránh 2 vòng chồng nhau. */
let apiRestartLoopRunning = false;
/** v0.90d: true từ lúc một Local API instance đã bind thành công — để `onUnexpectedClose` không báo nhầm khi listen thất bại (vd EADDRINUSE cũng bắn 'close'). */
let apiServerStarted = false;

function getWebhookDispatcher(): WebhookDispatcher {
  if (!webhookDispatcher) {
    webhookDispatcher = new WebhookDispatcher({
      storePath: path.join(app.getPath('userData'), API_FILE),
      // v0.8: ký HMAC cho webhook (secret trong Vault, không log).
      // Chưa có secret thì dispatcher gửi không ký + cảnh báo 1 lần.
      hmacSecret: vault.getSecret('webhook', 'hmac-secret') ?? undefined,
    });
  }
  return webhookDispatcher;
}

/**
 * Lấy token API từ Vault, sinh mới khi chưa có. Token là 32 byte
 * ngẫu nhiên (hex, 64 ký tự). KHÔNG log giá trị token ở bất kỳ đâu.
 */
function getOrCreateApiToken(): string {
  const existing = vault.getSecret(API_TOKEN_NAMESPACE, API_TOKEN_KEY);
  if (existing) return existing;
  const token = randomBytes(32).toString('hex');
  vault.setSecret(API_TOKEN_NAMESPACE, API_TOKEN_KEY, token);
  return token;
}

/**
 * v0.9a: WS stream runs by run id -> bot id. Populated by runBotStream
 * (the API server passes its run id in opts) so ApiHandlers.stopRun
 * can map a WS `{type:"stop"}` to the bot whose run must stop.
 * Entries are removed when the stream's run settles.
 */
const wsStreamRuns = new Map<string, string>();

/** The event object ApiHandlers.runBotStream's `emit` accepts. */
type ApiStreamEmitEvent = Parameters<NonNullable<ApiHandlers['runBotStream']>>[2] extends (
  event: infer E,
) => void
  ? E
  : never;

function buildApiHandlers(): ApiHandlers {
  return {
    listBots: () =>
      settings.bots.map((b) => ({
        id: b.id,
        name: b.name,
        providerId: b.providerId,
        model: b.model,
      })),
    runBot: async (botId, text, opts) => {
      const bot = settings.bots.find((b) => b.id === botId);
      if (!bot) throw new Error('Không tìm thấy bot.');
      await getOrCreateRuntime(bot);
      activeChatRuns.add(bot.id);
      dreamEngine?.noteActivity(bot.id);
      try {
        // v0.89a (vision over the Local API): `opts.attachments` from
        // POST /v1/bots/:id/run ride along to the coordinator run —
        // same shape as `chat:send` (main validates again inside the
        // loop, fail-closed). No attachments = exactly as before.
        const result = await workerPool.submit(
          () =>
            getCoordinator().run(bot.id, text, undefined, {
              ...(opts?.attachments && opts.attachments.length > 0
                ? { attachments: opts.attachments }
                : {}),
            }),
          { label: `api:${bot.id}` },
        ).promise;
        return { text: result.text ?? '' };
      } finally {
        activeChatRuns.delete(bot.id);
        dreamEngine?.noteActivity(bot.id);
      }
    },
    // v0.9a: streaming thật cho WebSocket endpoint (delta/toolcall/
    // toolresult/summary/approval-needed/ask-user/progress đẩy về
    // client theo lượt chạy). Run qua WS giờ trả lời được
    // approval/ask-user: main forward mọi event của run (chỉ trừ
    // event vòng đời bot như agent.created/mcp.* — không thuộc về một
    // run), và WS control message đi xuống coordinator qua
    // stopRun/respondApproval/respondAskUser dưới đây. Khi client dừng
    // run (hoặc đóng socket), server abort opts.signal — main dịch
    // thành coordinator.stopBot.
    runBotStream: async (botId, text, emit, opts) => {
      const bot = settings.bots.find((b) => b.id === botId);
      if (!bot) throw new Error('Không tìm thấy bot.');
      await getOrCreateRuntime(bot);
      activeChatRuns.add(bot.id);
      dreamEngine?.noteActivity(bot.id);
      const runId = opts?.runId;
      if (runId) wsStreamRuns.set(runId, botId);
      const signal = opts?.signal;
      const onAbort = (): void => {
        // Best-effort: coordinator vẫn còn run thì dừng nó; run đã
        // xong thì stopBot trả stopped: false, không hại gì.
        void getCoordinator().stopBot(botId).catch(() => undefined);
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        const result = await workerPool.submit(
          () =>
            getCoordinator().run(bot.id, text, (event) => {
              // Event vòng đời bot (agent.created, mcp.oauth-token,
              // connector.oauth-token, mcp.open-url) đi kênh
              // routeCoordinatorEvent như cũ, không chen vào stream
              // của một run.
              if (
                event.kind === 'agent.created' ||
                event.kind === 'mcp.oauth-token' ||
                event.kind === 'connector.oauth-token' ||
                event.kind === 'mcp.open-url'
              ) {
                return;
              }
              // v0.13: elicitation đi vào WS stream với kind
              // 'elicitation-needed' (ApiStreamEventKind), không phải
              // kind gốc 'mcp.elicitation-needed' của coordinator.
              if (event.kind === 'mcp.elicitation-needed') {
                emit({
                  kind: 'elicitation-needed',
                  data: event.payload,
                } as ApiStreamEmitEvent);
                return;
              }
              // AgentEventKind rộng hơn ApiStreamEventKind ở đúng 3 kind
              // vòng đời đã lọc ở trên; mọi kind còn lại đều là event
              // của run nên cast này giữ đúng hợp đồng stream.
              emit({
                kind: event.kind,
                data: event.payload,
              } as ApiStreamEmitEvent);
            }),
          { label: `api-stream:${bot.id}` },
        ).promise;
        return { text: result.text ?? '' };
      } finally {
        if (runId) wsStreamRuns.delete(runId);
        if (signal) signal.removeEventListener('abort', onAbort);
        activeChatRuns.delete(bot.id);
        dreamEngine?.noteActivity(bot.id);
      }
    },
    // v0.9a: WS control — dừng run theo id và trả lời approval/ask-user.
    // stopRun dịch run id (của server) thành bot id rồi gọi
    // coordinator.stopBot: một bot không chạy 2 turn cùng lúc nên dừng
    // theo bot là dừng đúng run đó. Stop theo run thật nằm trong
    // coordinator (RPC stopRun) và được dùng khi client RPC nối sau.
    stopRun: async (runId) => {
      const botId = wsStreamRuns.get(runId);
      if (!botId) return { runId, stopped: false, reason: 'không tìm thấy run WS đang chạy' };
      const result = await getCoordinator().stopBot(botId);
      return { runId, stopped: result.stopped, reason: result.reason };
    },
    respondApproval: async (callId: string, approved: boolean, args?: Record<string, unknown>) => {
      if (!coordinator) return { found: false };
      return coordinator.respondApproval(callId, approved, args);
    },
    respondAskUser: async (requestId, answer) => {
      if (!coordinator) return { found: false };
      return coordinator.respondAskUser(requestId, answer);
    },
    respondElicitation: async (elicitationId, action, content) => {
      if (!coordinator) return { found: false };
      return coordinator.respondElicitation(elicitationId, action, content);
    },
    // v0.90a (Đội G): harness lên Local API — các route M5 (status /
    // thread-log / permissions) trước đây chưa mount nên trả 404; nay
    // mount bằng coordinator RPC `harnessStatus` / `harnessThreadLog` /
    // `harnessDecidePermission` như server.ts ghi chú từ M5. SSE live
    // event: `subscribeHarnessEvents` chỉ đăng ký vào Set
    // `harnessSseSubscribers` (replay Last-Event-ID do server.ts tự
    // làm qua `harnessThreadLog`); live event tới từ
    // `routeCoordinatorEvent` case 'harness.event'.
    harnessStatus: async () => getCoordinator().harnessStatus(),
    harnessThreadLog: async (threadId, opts) =>
      getCoordinator().harnessThreadLog({
        threadId,
        limit: opts.limit,
        offset: opts.offset,
        ...(opts.kinds !== undefined ? { kinds: opts.kinds as HarnessEventKind[] } : {}),
      }),
    respondHarnessPermission: async (requestId, allowed) =>
      getCoordinator().harnessDecidePermission({ requestId, allowed }),
    subscribeHarnessEvents: (filter, emit) => {
      const entry: HarnessSseSubscriber = { filter, emit };
      harnessSseSubscribers.add(entry);
      return () => {
        harnessSseSubscribers.delete(entry);
      };
    },
    // v0.59: webhook automation qua HTTP (`POST
    // /v1/automations/:id/webhook`). Raw body + chữ ký đi thẳng xuống
    // scheduler — HMAC được verify TRƯỚC khi chạy action nào (chữ ký
    // sai/thiếu thì scheduler ném lỗi, không ghi run). Scheduler chưa
    // khởi động thì route trả 404 ở tầng server (handler coi như
    // chưa mount) — ở đây ném lỗi rõ để không im lặng.
    deliverAutomationWebhook: async (automationId, rawBody, signature) => {
      if (!automationScheduler) throw new Error('Scheduler chưa khởi động.');
      return automationScheduler.handleWebhook(automationId, rawBody, signature);
    },
    // v0.83b: Composio trigger qua HTTP (`POST
    // /v1/automations/:id/composio-trigger`). Raw body + header chữ ký
    // Composio (hoặc ?token=) đi thẳng xuống scheduler — chữ ký được
    // verify TRƯỚC khi chạy action nào (sai/thiếu thì scheduler ném
    // lỗi, không ghi run). Route này KHÔNG cần Bearer token của Local
    // API (xem server.ts) vì Composio không gửi được token đó.
    deliverComposioTrigger: async (automationId, rawBody, auth) => {
      if (!automationScheduler) throw new Error('Scheduler chưa khởi động.');
      return automationScheduler.handleComposioTrigger(automationId, rawBody, auth);
    },
    // v0.87a (P2-2): Slack inbound trực tiếp qua HTTP (`POST
    // /v1/automations/:id/slack-inbound`). Raw body + 2 header chữ ký
    // Slack (`x-slack-signature`, `x-slack-request-timestamp`) đi
    // thẳng xuống scheduler — chữ ký được verify TRƯỚC khi parse hay
    // chạy action nào (sai/thiếu thì scheduler ném lỗi, không ghi
    // run). Route này KHÔNG cần Bearer token của Local API (xem
    // server.ts) vì Slack không gửi được token đó.
    deliverSlackInbound: async (automationId, rawBody, auth, contentType) => {
      if (!automationScheduler) throw new Error('Scheduler chưa khởi động.');
      return automationScheduler.handleSlackInbound(automationId, rawBody, auth, contentType);
    },
    getHistory: async (botId, limit) => {
      const bot = settings.bots.find((b) => b.id === botId);
      if (!bot) throw new Error('Không tìm thấy bot.');
      const runtime = await getOrCreateRuntime(bot);
      return historyFromMemory(runtime, limit);
    },
    listTasks: async (botId) => {
      const bot = settings.bots.find((b) => b.id === botId);
      if (!bot) throw new Error('Không tìm thấy bot.');
      const runtime = await getOrCreateRuntime(bot);
      try {
        const { tasks } = await getCoordinator().listTasks(bot.id);
        return tasks.map((task) => ({
          id: task.id,
          botId: task.botId,
          title: task.title,
          status:
            task.status === 'in_progress'
              ? 'running'
              : task.status === 'cancelled'
                ? 'failed'
                : task.status,
        }));
      } catch {
        return runtime.tasks;
      }
    },
  };
}

/** Fire-and-forget: lỗi webhook không bao giờ làm hỏng run. */
async function dispatchRunWebhook(run: ApiRunRecord): Promise<void> {
  try {
    await getWebhookDispatcher().dispatch({
      kind: run.status === 'done' ? 'run.done' : 'run.error',
      at: new Date().toISOString(),
      data:
        run.status === 'done'
          ? { botId: run.botId, runId: run.runId, text: run.text ?? '' }
          : { botId: run.botId, runId: run.runId, error: run.error ?? 'Run failed.' },
    });
  } catch {
    // dispatch() vốn đã best-effort; đây chỉ là lưới an toàn cuối.
  }
}

/**
 * Khởi động Local API khi bật trong Settings; dừng khi tắt hoặc khi
 * đổi port (stop rồi start lại với port mới). Lỗi port bận được trả
 * về cho renderer dưới dạng message (không crash app).
 */
async function applyApiConfig(next: ApiSettings): Promise<ApiSettings> {
  apiConfig = {
    enabled: next.enabled === true,
    port:
      typeof next.port === 'number' && next.port >= 1024 && next.port <= 65535
        ? next.port
        : DEFAULT_API_PORT,
  };
  settings.api = { ...apiConfig };
  saveSettings();
  await stopApiServer();
  if (apiConfig.enabled) {
    await startApiServer();
  }
  return { ...apiConfig };
}

async function startApiServer(): Promise<void> {
  const token = getOrCreateApiToken(); // KHÔNG log token
  // v0.7: token gắn với teamId lúc tạo — server yêu cầu header
  // X-Open-Bot-Team khớp teamId này; service-account token cũng được
  // chấp nhận (cùng team). Token nào cũng lấy từ Vault, không log.
  let teamId: string | undefined;
  // v0.85a (P0-1): service-account tokens carry their scope from
  // team.json into the Local API auth context — a `run` token can
  // run bots but cannot approve permissions or reach the MCP/A2A
  // mounts (enforced in createApiServer). The scope used to be
  // dropped at this exact spot (extraTokens was string[]).
  let extraTokens: Array<{ token: string; scope: ServiceAccountScope }> = [];
  try {
    const team = loadTeamConfig(app.getPath('userData'));
    teamId = getTeamId(team);
    extraTokens = listServiceAccounts(team)
      .map((a) => {
        const t = vault.getSecret('service-account', a.id);
        return typeof t === 'string' && t.length > 0 ? { token: t, scope: a.scope } : null;
      })
      .filter((t): t is { token: string; scope: ServiceAccountScope } => t !== null);
  } catch {
    teamId = undefined;
    extraTokens = [];
  }
  // v0.13: expose open-bot itself — MCP server (read-only default
  // tools, confined to the first bot's workspace) + A2A server
  // (incoming tasks run on the first bot). Mounted on the Local API
  // (POST /mcp, POST /a2a, GET /.well-known/agent-card.json);
  // loopback-only, same Bearer auth as the rest of the API except
  // the Agent Card. Agent tools are NOT exposed through the MCP
  // server (allowlist-gated, future work) — only the 5 read-only
  // default tools.
  const mcpServer = createMcpServer({
    workspaceDir: settings.bots[0]?.workspaceDir,
  });
  const a2aServer = createA2aServer({
    // v0.25 (W18c): task A2A bền vững qua restart — file JSON dưới
    // userData (ghi atomic, mode 0600); file hỏng thì load [] chứ
    // không crash server. Không có store thì task mất khi restart.
    taskStore: createFileTaskStore(path.join(app.getPath('userData'), 'a2a-tasks.json')),
    // v0.28: lưu task lỗi sau hết retry (3 lần, backoff 50ms → 100ms)
    // thì đẩy trạng thái lên renderer để UI cảnh báo — người dùng
    // thấy được lỗi, task chỉ còn trong bộ nhớ (mất khi restart).
    // Lưu lại thành công sau chuỗi lỗi cũng đẩy lên để UI gỡ banner.
    onPersistStatusChange: (status) => {
      sendToRenderer('a2a:persist-status', status);
    },
    // L2 (audit v0.15): A2A bắt buộc token — truyền cùng token Local
    // API. Khi mount vào Local API, auth do Local API thực thi;
    // token ở đây để createA2aServer không tạo server không auth.
    token,
    runner: async (input) => {
      const bot = settings.bots[0];
      if (!bot) {
        return { error: 'Chưa có bot nào — tạo một bot trước rồi thử lại.' };
      }
      if (input.signal.aborted) return { error: 'Task đã bị huỷ.' };
      const onAbort = (): void => {
        void getCoordinator().stopBot(bot.id).catch(() => undefined);
      };
      input.signal.addEventListener('abort', onAbort, { once: true });
      try {
        const result = await getCoordinator().run(bot.id, input.text, (event) => {
          if (event.kind === 'delta' && typeof event.payload === 'string') {
            input.onProgress(event.payload);
          }
        });
        return { text: result.text ?? '' };
      } catch (err) {
        return { error: (err as Error).message };
      } finally {
        input.signal.removeEventListener('abort', onAbort);
      }
    },
  });
  apiServer = createApiServer({
    port: apiConfig.port,
    token,
    extraTokens,
    teamId,
    handlers: buildApiHandlers(),
    mcpServer,
    a2aServer,
    onRunSettled: (run) => {
      // Run nền của API xong -> webhook run.done / run.error.
      void dispatchRunWebhook(run);
    },
    // v0.90d: server chết/dừng mà không qua stopApiServer (vd
    // socket lỗi) thì dựng lại có backoff — KHÔNG im lặng. Cờ
    // apiServerStarted chặn báo nhầm khi listen thất bại (vd
    // EADDRINUSE cũng bắn 'close' của server chưa từng chạy).
    onUnexpectedClose: () => {
      if (!apiServerStarted) return;
      apiServerStarted = false;
      apiServer = null;
      a2aServerRef = null;
      apiStartError = 'Local API đã dừng đột ngột.';
      console.error('[open-bot] Local API đã dừng đột ngột — sẽ thử khởi động lại.');
      void startApiServerWithRetry('unexpected-close');
    },
  });
  try {
    await apiServer.start();
  } catch (err) {
    // v0.90d: ghi lỗi gần nhất để Settings hiện qua api:get
    // (lastError) thay vì chỉ log rồi im; caller vẫn nhận lỗi
    // (applyApiConfig / regenerate-token báo cho người dùng).
    apiStartError = err instanceof Error ? err.message : 'Không khởi động được Local API.';
    throw err;
  }
  apiServerStarted = true;
  apiStartError = null;
  // v0.28: giữ tham chiếu để IPC `a2a:persist-status` đọc trạng thái lưu task.
  a2aServerRef = a2aServer;
  // Agent Card cần URL thật (có port) — điền sau khi server đã bind.
  // Card URL trỏ vào endpoint A2A đã mount (POST /a2a).
  (a2aServer as unknown as A2aServerWithInternals)._internals.setCardUrl(
    `http://127.0.0.1:${apiServer.port}/a2a`,
  );
  console.log(`[open-bot] Local API đang chạy ở http://127.0.0.1:${apiServer.port}/v1`);
}

/**
 * v0.90d: bỏ tham chiếu tới Local API instance hiện tại (kể cả
 * instance khởi động thất bại — `start()` lỗi thì `apiServer` vẫn
 * trỏ tới object chưa từng bind). Không tăng thế hệ retry — vòng
 * retry đang chạy tự gọi hàm này giữa các lần thử.
 */
async function dropStaleApiServer(): Promise<void> {
  if (!apiServer) return;
  const stale = apiServer;
  apiServer = null;
  a2aServerRef = null;
  apiServerStarted = false;
  await stale.stop().catch(() => undefined);
}

/**
 * v0.90d: khởi động Local API, thất bại thì thử lại tối đa
 * `API_RESTART_MAX_ATTEMPTS` lần với backoff 1s → 2s → 4s → 8s →
 * 16s (xem `retryWithBackoff`). Hết lần thì chỉ log + giữ
 * `apiStartError` để Settings hiện lỗi (không thử vô hạn, không
 * im lặng). Vòng retry dừng ngay khi API bị tắt/đổi cấu hình
 * (`apiRestartGeneration` đổi) hoặc có vòng retry khác đang chạy.
 * Chỉ dùng cho khởi động nền (startup, unexpected-close) — đường
 * người dùng bấm (applyApiConfig, regenerate-token) vẫn gọi thẳng
 * `startApiServer()` để lỗi trả về ngay cho caller.
 */
async function startApiServerWithRetry(origin: string): Promise<void> {
  if (apiRestartLoopRunning) return;
  if (!apiConfig.enabled) return;
  apiRestartLoopRunning = true;
  const generation = apiRestartGeneration;
  try {
    const result = await retryWithBackoff(
      async () => {
        await dropStaleApiServer();
        await startApiServer();
      },
      {
        maxAttempts: API_RESTART_MAX_ATTEMPTS,
        shouldRetry: () => apiConfig.enabled && generation === apiRestartGeneration,
        onAttemptFailed: (err, attempt) => {
          console.error(
            `[open-bot] Local API khởi động thất bại (lần ${attempt}/${API_RESTART_MAX_ATTEMPTS}, ${origin}):`,
            err instanceof Error ? err.message : err,
          );
        },
      },
    );
    if (result.ok) {
      if (result.attempts > 1 || origin !== 'startup') {
        console.log(
          `[open-bot] Local API đã khởi động lại sau ${result.attempts} lần thử (${origin}).`,
        );
      }
    } else {
      console.error(
        `[open-bot] Local API không khởi động được sau ${API_RESTART_MAX_ATTEMPTS} lần thử (${origin}) — kiểm tra port trong Settings → Advanced.`,
      );
    }
  } finally {
    apiRestartLoopRunning = false;
  }
}

async function stopApiServer(): Promise<void> {
  // v0.90d: dừng có chủ đích thì huỷ mọi vòng retry đang chờ — kể
  // cả khi chưa có server (vòng retry có thể đang ngủ giữa 2 lần
  // thử, lúc đó apiServer đã bị dropStaleApiServer() bỏ).
  apiRestartGeneration += 1;
  apiStartError = null;
  if (!apiServer) return;
  const srv = apiServer;
  apiServer = null;
  a2aServerRef = null;
  apiServerStarted = false;
  await srv.stop();
}

// ---------------------------------------------------------------------------
// v0.4: Skills + Automations + Dream
// ---------------------------------------------------------------------------

let skillRegistry: SkillRegistry | null = null;
let automationScheduler: AutomationScheduler | null = null;
let dreamEngine: DreamEngine | null = null;
/** Bot đang có chat chạy (chat:send) hoặc automation/dream đang chạy agent. */
const activeChatRuns = new Set<string>();
/** Dream config lưu trong settings.json. */
let dreamConfig: DreamConfig = { enabled: false, idleMinutes: 15 };
/** Timer riêng cho dream (kiểm tra mỗi 60s); dừng ở before-quit. */
let dreamTimer: ReturnType<typeof setInterval> | null = null;
/**
 * v0.94c: timer riêng cho project updates (kiểm tra mỗi 15 phút,
 * PROJECT_UPDATES_CHECK_MS); dừng ở before-quit.
 */
let projectUpdatesTimer: ReturnType<typeof setInterval> | null = null;

function getSkillRegistry(): SkillRegistry {
  if (!skillRegistry) {
    skillRegistry = new SkillRegistry({
      userSkillsDir: path.join(app.getPath('userData'), 'skills'),
      pluginsDir: path.join(app.getPath('userData'), 'plugins'),
      stateDir: app.getPath('userData'),
    });
    skillRegistry.load();
  }
  return skillRegistry;
}

function loadDreamConfig(): DreamConfig {
  const raw = (settings as AppSettings).dream;
  return {
    enabled: raw?.enabled === true,
    idleMinutes:
      typeof raw?.idleMinutes === 'number' && raw.idleMinutes >= 5 && raw.idleMinutes <= 240
        ? raw.idleMinutes
        : 15,
    cheapestModel: raw?.cheapestModel,
  };
}

function saveDreamConfig(next: DreamConfig): DreamConfig {
  dreamConfig = {
    enabled: next.enabled === true,
    idleMinutes:
      typeof next.idleMinutes === 'number' && next.idleMinutes >= 5 && next.idleMinutes <= 240
        ? next.idleMinutes
        : 15,
    cheapestModel: next.cheapestModel,
  };
  settings.dream = dreamConfig;
  saveSettings();
  // Áp dụng ngay cho engine đang chạy (không cần restart app).
  if (dreamEngine) {
    dreamEngine = new DreamEngine({
      config: { ...dreamConfig, cheapestModel: cheapestModelForDream() },
      handlers: buildAutomationHandlers(),
      isChatActive: () => activeChatRuns.size > 0,
    });
  }
  return dreamConfig;
}

/** Model rẻ nhất đã cấu hình — dream/automation dùng model này thay vì model mặc định. */
function cheapestModelForDream(): string | undefined {
  // Ưu tiên Ollama local (miễn phí, chạy trên máy); nếu chưa cấu hình thì
  // dùng defaultModel của provider xai; cuối cùng là model của bot đầu tiên.
  const ollama = settings.providers['ollama'];
  if (ollama?.defaultModel?.trim()) return ollama.defaultModel.trim();
  const xai = settings.providers['xai'];
  if (xai?.defaultModel?.trim()) return xai.defaultModel.trim();
  return settings.bots[0]?.model || undefined;
}

function buildAutomationHandlers(): AutomationHandlers {
  return {
    // Chạy 1 lượt agent qua coordinator (nơi AgentRunner sống). Đánh dấu
    // active để scheduler/dream không chạy chồng lên nhau, và để dream
    // không chen vào giữa lượt automation đang chạy. `silent: true` để
    // event không spam chat UI (v0.4, coordinator hỗ trợ).
    runAgent: async (botId, prompt, opts) => {
      const bot = settings.bots.find((b) => b.id === botId) ?? settings.bots[0];
      if (!bot) throw new Error('Không có bot nào để chạy automation.');
      activeChatRuns.add(bot.id);
      try {
        void opts; // model override cho lượt nền: chưa dùng ở v0.4.
        const result = await getCoordinator().run(bot.id, prompt, undefined, { silent: true });
        return result.text ?? '';
      } finally {
        activeChatRuns.delete(bot.id);
      }
    },
    // Chạy 1 tool qua coordinator RPC `runTool` (v0.4).
    runTool: async (name, args) => {
      const bot = settings.bots[0];
      if (!bot) throw new Error('Không có bot nào để chạy tool.');
      const out = await getCoordinator().runTool(bot.id, name, args);
      return out.output;
    },
    // Tạo task qua coordinator RPC `createTask` (v0.4) — BotMemory sống
    // trong coordinator, main không bao giờ mở memory.db trực tiếp.
    createTask: async (botId, title) => {
      const created = await getCoordinator().createTask(botId, title);
      return created.id;
    },
    notify: (message) => {
      // Gửi về renderer để hiện banner/thông báo, không chèn vào chat.
      sendToRenderer('automation:notify', { message, at: Date.now() });
      void getWebhookDispatcher().dispatch({
        kind: 'automation.notify',
        at: new Date().toISOString(),
        data: { message },
      }).catch(() => undefined);
    },
    cheapestModel: cheapestModelForDream(),
  };
}

function initAutomations(): void {
  const handlers = buildAutomationHandlers();
  automationScheduler = new AutomationScheduler(
    new JsonFileAutomationStore(path.join(app.getPath('userData'), '.open-bot')),
    handlers,
    {
      tickMs: 60_000,
      isChatActive: () => activeChatRuns.size > 0,
      // v0.59: webhook HMAC keys live in the DEDICATED WebhookKeyStore
      // (file riêng `automation-webhook-keys.json`); cặp
      // `{ store, legacyStore: vault }` để key cũ trong Vault chính
      // được migrate lười ở lần đọc đầu tiên. The closure reads the
      // stores at call time so init order is safe. A lookup failure
      // refuses the delivery (fail-closed).
      webhookKeyProvider: (keyId) => {
        try {
          return getAutomationWebhookKey(webhookKeyStores(), keyId);
        } catch {
          return null;
        }
      },
      // v0.83b: Composio trigger secrets live in the main Vault
      // (namespace `composio-trigger-keys/`): the signing secret
      // (COMPOSIO_WEBHOOK_SECRET, pasted by the user) and the
      // optional URL-token secret. The closures read the Vault at
      // call time so init order is safe. A lookup failure refuses
      // the delivery (fail-closed).
      composioWebhookSecretProvider: (keyId) => {
        try {
          return getComposioTriggerSigningSecret(vault, keyId);
        } catch {
          return null;
        }
      },
      composioTriggerTokenProvider: (keyId) => {
        try {
          return getComposioTriggerTokenByKeyId(vault, keyId);
        } catch {
          return null;
        }
      },
      // v0.87a (P2-2): Slack inbound signing secrets live in the main
      // Vault (namespace `slack-inbound-keys/`): the Slack app's
      // signing secret, pasted by the user per automation. The
      // closure reads the Vault at call time so init order is safe.
      // A lookup failure refuses the delivery (fail-closed).
      slackSigningSecretProvider: (keyId) => {
        try {
          return getSlackSigningSecret(vault, keyId);
        } catch {
          return null;
        }
      },
      // v0.96 (Team T4): verified Composio deliveries are also
      // enqueued into the shared trigger queue (long-poll consumers
      // read via waitForEvents); the immediate run below is unchanged.
      composioTriggerQueue: getSharedComposioTriggerQueue(),
      // v0.59 (P0-5 §6): nối viewer thật vào scheduler — role team
      // của user local + userId ghi làm `createdBy` lúc tạo. Viewer
      // chỉ OPEN, member chỉ sửa automation mình tạo, admin làm tất;
      // không xác định được viewer thì checker chặn hết (fail-closed).
      policyChecker: localAutomationPolicyChecker(),
      currentUserId: LOCAL_USER_ID,
      // v0.66a: đẩy thay đổi run về renderer để AutomationsView tự
      // refresh lịch sử chạy (không cần vào lại view). sendToRenderer
      // đã guard mainWindow bị destroy.
      onRunChanged: (run) => {
        sendToRenderer('automation:runs-changed', {
          runId: run.id,
          automationId: run.automationId,
          status: run.status,
        });
      },
    },
  );
  dreamEngine = new DreamEngine({
    config: { ...dreamConfig, cheapestModel: cheapestModelForDream() },
    handlers,
    isChatActive: () => activeChatRuns.size > 0,
  });
  // v0.66a: reconcile TRƯỚC khi start() — run nào còn `running` là
  // mồ côi do app dừng giữa chừng (crash/force-quit), đánh dấu error
  // để lịch sử không kẹt ở "đang chạy" mãi. Gọi trước start để
  // không có run mới nào chen vào giữa.
  const reconciled = automationScheduler.reconcileInterruptedRuns();
  if (reconciled.length > 0) {
    console.log(
      `[open-bot] Automations: đã reconcile ${reconciled.length} run "running" mồ côi thành error (app dừng giữa chừng).`,
    );
  }
  automationScheduler.start();
  // Dream không có timer riêng trong scheduler: kiểm tra mỗi 60s bằng
  // timer riêng (tương đương móc vào tick, nhưng không monkey-patch).
  dreamTimer = setInterval(() => {
    void runDreamForIdleBots().catch(() => undefined);
  }, 60_000);
  dreamTimer.unref?.();
  // v0.94c: project updates — kiểm tra digest tới hạn mỗi 15 phút,
  // lần đầu sau 60s (để bot vừa bật updates nhận digest ngay thay vì
  // chờ hết chu kỳ kiểm tra).
  projectUpdatesTimer = setInterval(() => {
    void runProjectUpdatesTick().catch(() => undefined);
  }, PROJECT_UPDATES_CHECK_MS);
  projectUpdatesTimer.unref?.();
  setTimeout(() => {
    void runProjectUpdatesTick().catch(() => undefined);
  }, 60_000).unref?.();
}

// --- v0.57: Composio (tích hợp opt-in, IPC + khởi động) ---
// Source đăng ký app Composio vào defaultAppRegistry của MAIN process
// (để `apps:list` thấy); tiến trình coordinator có registry riêng và
// được đồng bộ qua RPC `composio.setState` (v0.58 — xem
// syncComposioToCoordinator). Key: Vault là nguồn thật duy nhất
// (main đọc được bằng safeStorage trong main process); main SEED bản
// sao key cho coordinator qua RPC `composio.setApiKey` (v0.59 — xem
// seedComposioKeyToCoordinator, đúng mẫu token đã có: xBearer /
// githubToken / mcpOAuthTokens qua `createBot`). Coordinator giữ key
// trong bộ nhớ, không bao giờ chạm file Vault; key mới/xoá trong main
// thì main gọi lại RPC seed. Fallback đọc file Vault chỉ còn khi main
// chưa seed (LocalEncryptor) — safeStorage/NO_STORAGE thì coordinator
// fail-closed cho tới khi được seed.
let composioSource: ComposioAppSource | null = null;

function getComposioSource(): ComposioAppSource {
  if (!composioSource) {
    composioSource = new ComposioAppSource({
      registry: defaultAppRegistry,
      hasApiKey: () => {
        try {
          return hasComposioApiKey(vault);
        } catch {
          return false;
        }
      },
    });
  }
  return composioSource;
}

/**
 * Khôi phục trạng thái Composio đã lưu lúc khởi động (sau khi Vault sẵn
 * sàng): áp lên source để app Composio xuất hiện trong `apps:list`.
 * Coordinator được đồng bộ khi nó spawn (xem getCoordinator) hoặc lần
 * toggle sau — không spawn coordinator sớm ở đây.
 */
function initComposio(): void {
  const source = getComposioSource();
  applyComposioPersistedState(source, resolveComposioPersistedState(settings.composio));
  settings.composio = composioStateToPersist(source);
}

/**
 * v0.59: seed Composio API key cho coordinator — main đọc Vault bằng
 * safeStorage (main process đọc được, tiến trình con thì không) rồi
 * truyền bản sao trong bộ nhớ qua RPC `composio.setApiKey` (cùng kênh
 * stdio với các secret khác đã đi: xBearer / githubToken /
 * mcpOAuthTokens qua `createBot`). Không có key trong Vault thì seed
 * null để coordinator xoá bản seed cũ (về fallback / fail-closed).
 * Best-effort: coordinator chết/lỗi thì lần toggle sau / lần spawn
 * sau / lần createBot sau seed lại. Key KHÔNG bao giờ log.
 */
async function seedComposioKeyToCoordinator(): Promise<void> {
  let apiKey: string | null = null;
  try {
    apiKey = getComposioApiKey(vault);
  } catch {
    apiKey = null;
  }
  const client = getCoordinator() as unknown as {
    setComposioApiKey?: (apiKey: string | null) => Promise<unknown>;
  };
  if (typeof client.setComposioApiKey !== 'function') return;
  await client.setComposioApiKey(apiKey);
}

/**
 * v0.95 (Team D2): seed media API key cho coordinator — main đọc Vault
 * namespace 'media' bằng safeStorage (main process đọc được, tiến
 * trình con thì không) rồi truyền bản sao trong bộ nhớ qua RPC
 * `media.setKey` (cùng kênh stdio với key qua RPC `composio.setApiKey`).
 * Không có key trong Vault thì seed null để coordinator xoá bản seed
 * cũ (về chưa cấu hình, fail-closed). Best-effort: coordinator chết/
 * lỗi thì lần set/clear sau / lần spawn sau / lần createBot sau seed
 * lại. Key KHÔNG bao giờ log.
 */
async function seedMediaKeyToCoordinator(providerId: string): Promise<void> {
  let apiKey: string | null = null;
  try {
    apiKey = getMediaApiKey(vault, providerId);
  } catch {
    apiKey = null;
  }
  const client = getCoordinator() as unknown as {
    setMediaApiKey?: (providerId: string, apiKey: string | null) => Promise<unknown>;
  };
  if (typeof client.setMediaApiKey !== 'function') return;
  await client.setMediaApiKey(providerId, apiKey);
}

/**
 * v0.88b: seed Composio user id cho coordinator — main đọc Vault
 * bằng safeStorage (main process đọc được, tiến trình con thì
 * không) rồi truyền bản sao trong bộ nhớ qua RPC `composio.setUserId`
 * (cùng kênh stdio với key qua RPC `composio.setApiKey`). Không có
 * user id trong Vault thì seed null để coordinator về mặc định
 * 'local-user' (xoá id đã seed cũ). Best-effort như seed key: coordinator
 * chết/lỗi thì lần toggle sau / lần spawn sau / lần createBot sau
 * seed lại. User id KHÔNG bao giờ log.
 */
async function seedComposioUserIdToCoordinator(): Promise<void> {
  let userId: string | null = null;
  try {
    userId = getComposioUserId(vault);
  } catch {
    userId = null;
  }
  const client = getCoordinator() as unknown as {
    setComposioUserId?: (userId: string | null) => Promise<unknown>;
  };
  if (typeof client.setComposioUserId !== 'function') return;
  await client.setComposioUserId(userId);
}

/**
 * Đẩy trạng thái Composio sang tiến trình coordinator (để registry +
 * factory gate bên đó khớp main). RPC `composio.setState` do v0.58
 * thêm (CoordinatorClient.setComposioState); khi chưa có method này
 * thì bỏ qua — main vẫn hiển thị đúng, tool chỉ chưa chạy được cho
 * tới khi v0.58 xong. Best-effort: coordinator chết/lỗi thì lần toggle
 * sau / lần spawn sau đẩy lại.
 * v0.59: seed key TRƯỚC khi đẩy state — coordinator bật source mà
 * chưa có key sẽ emit event `composio.key-needed` xin seed lại, seed
 * trước tránh một vòng xin-thừa đó (event vẫn còn làm backstop khi
 * coordinator restart mất key seed trong bộ nhớ).
 */
async function syncComposioToCoordinator(): Promise<void> {
  await seedComposioKeyToCoordinator().catch(() => undefined);
  // v0.88b: seed user id cùng lúc với key (trước khi đẩy state) —
  // coordinator bật source mà chưa có id đúng thì session tạo ra
  // vẫn là 'local-user', không thấy connection trong dashboard.
  await seedComposioUserIdToCoordinator().catch(() => undefined);
  const state = composioStateToPersist(getComposioSource());
  const client = getCoordinator() as unknown as {
    setComposioState?: (state: { enabled: boolean; toolkits: string[] }) => Promise<unknown>;
  };
  if (typeof client.setComposioState !== 'function') return;
  await client.setComposioState(state);
}

/** Mỗi lượt kiểm tra: thử dream cho từng bot (dream tự kiểm tra idle/chat-active). */
/**
 * v0.94c: project updates delivery — một tick của kênh gửi thật cho
 * `project_set_updates` (tương đương Grok Start/StopProjectUpdates).
 * Lấy digest tới hạn qua coordinator RPC `projectUpdatesDue`, rồi với
 * mỗi digest: bắn thông báo hệ thống + lưu digest làm tin nhắn
 * assistant vào chat của bot (BotMemory, nguồn thật) + đẩy vào
 * history của runtime đang chạy (để cửa sổ chat thấy ngay) + ghi dấu
 * đã gửi (`projectUpdatesMarkSent`). Một digest lỗi không chặn các
 * digest khác, và tick lỗi không bao giờ làm chết timer.
 */
async function runProjectUpdatesTick(): Promise<void> {
  let due: { updates: Array<{ botId: string; projectId: string; title: string; digest: string; summary: string; nextDueAt: string }> };
  try {
    due = await getCoordinator().projectUpdatesDue();
  } catch (err) {
    console.error('[project-updates] Không lấy được danh sách due:', (err as Error).message);
    return;
  }
  for (const update of due.updates) {
    try {
      getNotificationService().notify({
        kind: 'project-update',
        title: `Cập nhật project: ${update.title}`,
        body: update.summary,
        botId: update.botId,
        dedupeKey: `project-update:${update.projectId}:${update.nextDueAt}`,
      });
      await getCoordinator().saveMessage(update.botId, 'assistant', update.digest);
      const runtime = runtimes.get(update.botId);
      if (runtime) {
        runtime.history.push({
          id: randomUUID(),
          role: 'assistant',
          text: update.digest,
          createdAt: Date.now(),
        });
      }
      await getCoordinator().projectUpdatesMarkSent({
        botId: update.botId,
        projectId: update.projectId,
      });
    } catch (err) {
      console.error(
        `[project-updates] Không gửi được digest cho project "${update.projectId}":`,
        (err as Error).message,
      );
    }
  }
}

async function runDreamForIdleBots(): Promise<void> {
  if (!dreamEngine) return;
  for (const bot of settings.bots) {
    try {
      // Đọc history trước (async), rồi đưa vào checkAndRun dạng sync.
      let history: Array<{ role: string; content: string }> = [];
      try {
        const { messages } = await getCoordinator().getHistory(bot.id, 20);
        history = messages.map((m) => ({ role: m.role, content: m.content }));
      } catch {
        history = [];
      }
      const snapshot = history;
      await dreamEngine.checkAndRun(bot.id, () => snapshot);
    } catch {
      // Dream lỗi không được làm chết timer scheduler.
    }
  }
}

// --- File watcher: trigger `file-changed` cho automations (best-effort) ---
const fileWatchers = new Map<string, fs.FSWatcher>();
const fileChangeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function initFileWatcher(): void {
  for (const bot of settings.bots) {
    watchWorkspaceFor(bot);
  }
}

function watchWorkspaceFor(bot: BotConfig): void {
  const dir = workspaceDirFor(bot);
  if (fileWatchers.has(bot.id)) return;
  try {
    const watcher = fs.watch(dir, { recursive: true }, (_eventType, filename) => {
      if (!filename || typeof filename !== 'string') return;
      const key = `${bot.id}:${filename}`;
      clearTimeout(fileChangeTimers.get(key));
      fileChangeTimers.set(
        key,
        setTimeout(() => {
          const event: AutomationEvent = {
            kind: 'file-changed',
            botId: bot.id,
            path: filename,
            at: new Date().toISOString(),
          };
          void automationScheduler?.notifyEvent(event).catch(() => undefined);
        }, 2000),
      );
    });
    watcher.on('error', () => undefined);
    fileWatchers.set(bot.id, watcher);
  } catch {
    // Workspace chưa tồn tại / không watch được: automation file-changed
    // của bot này chỉ không chạy, app vẫn chạy bình thường.
  }
}

// ---------------------------------------------------------------------------
// v0.4: Voice + hiệu năng (WorkerPool ở main)
// ---------------------------------------------------------------------------

/** Pool chạy chat:send / job nền. Size mặc định = min(CPU, 8); đặt 4 cho desktop. */
const workerPool = new WorkerPool({ size: 4, maxConcurrentToolExecs: 4 });

/**
 * v0.56: một VoiceCallSession cho mỗi bot đang gọi voice (key =
 * botId). Session sở hữu cả RealtimeClient (đường audio) lẫn
 * VoiceCallHarness (thực thi voice-call toolset + surface register)
 * và registry surface của bot đó — main chỉ giữ map này, mọi logic
 * nối harness↔client nằm trong packages/core/src/voice/session.ts
 * (có test với mock client, không cần kết nối live).
 */
const voiceSessions = new Map<string, VoiceCallSession>();

/**
 * v0.59: đọc lịch sử tool-call của một bot để `peek_changes` dùng.
 * File `<workspace>/.open-bot/tool-calls.jsonl` do agent loop ghi
 * (P1-7); store đọc lại file mỗi lần gọi nên luôn thấy lượt chạy
 * mới nhất. File chưa có / hỏng thì trả [] — voice call không bao
 * giờ crash vì lịch sử đọc lỗi.
 */
function readBotFileChangeRecords(
  botId: string,
): Array<{ tool_name: string; args_json: string; started_at_ms?: number; completed_at_ms?: number; status?: 'ok' | 'error' | 'denied' }> {
  const bot = settings.bots.find((b) => b.id === botId);
  if (!bot) return [];
  try {
    return new ToolCallHistoryStore(workspaceDirFor(bot)).listRecent(100);
  } catch {
    return [];
  }
}

/**
 * Voice-call tool handlers cho một bot, bind vào trạng thái main
 * đang có (settings / runtimes / activeChatRuns / history dự phòng).
 * Chỉ 10 tool voice này được chạy trong cuộc gọi — registry tool
 * chung của agent không bao giờ lọt vào đây. Handler nào không có
 * dữ liệu thật thì trả về ghi chú rõ ràng thay vì bịa.
 *
 * v0.59: `peek_changes` trả dữ liệu thật — đọc lịch sử tool-call
 * của bot (`<workspace>/.open-bot/tool-calls.jsonl`, do agent loop
 * ghi qua `toolCallRecorder`, P1-7) rồi lọc ra các tool ghi file
 * (`write_file` / `apply_diff` / `delete_file`) qua
 * `buildPeekChangesResult` trong core. Không tạo kho song song:
 * không watcher riêng, không log mới.
 */
function buildVoiceCallHandlers(botId: string): VoiceCallToolHandlers {
  const botName = (id: string): string =>
    settings.bots.find((b) => b.id === id)?.name ?? id;
  const history = (): Array<{ role: string; text: string; at: number }> =>
    (runtimes.get(botId)?.history ?? []).map((m) => ({
      role: m.role,
      text: m.text.slice(0, 500),
      at: m.createdAt,
    }));
  return {
    peek_agents: () =>
      settings.bots.map((b) => ({
        id: b.id,
        name: b.name,
        providerId: b.providerId,
        running: activeChatRuns.has(b.id),
      })),
    peek_runs: () =>
      [...activeChatRuns].map((id) => ({ botId: id, name: botName(id), status: 'running' })),
    peek_changes: (args) => {
      const bot = settings.bots.find((b) => b.id === botId);
      const file = typeof args?.file === 'string' ? args.file : undefined;
      return buildPeekChangesResult({
        botId,
        workspaceDir: bot ? workspaceDirFor(bot) : null,
        records: bot ? readBotFileChangeRecords(bot.id) : [],
        ...(file !== undefined ? { file } : {}),
      });
    },
    recall_texts: (args) => {
      const query = typeof args.query === 'string' ? args.query.toLowerCase() : '';
      const all = history();
      const filtered = query ? all.filter((m) => m.text.toLowerCase().includes(query)) : all;
      return filtered.slice(-10);
    },
    search_conversations: (args) => {
      const query = String(args.query ?? '').toLowerCase();
      return history()
        .filter((m) => m.text.toLowerCase().includes(query))
        .slice(-VOICE_CALL_SEARCH_HIT_LIMIT);
    },
    stay_silent: () => 'silent',
    switch_agent: (args) => {
      const target = String(args.target ?? '');
      const found = settings.bots.find((b) => b.id === target || b.name === target);
      if (!found) throw new Error(`Không tìm thấy bot "${target}".`);
      return { target: found.id, name: found.name, note: 'Renderer chuyển cuộc gọi sang bot này.' };
    },
    transfer: (args) => {
      const target = String(args.target ?? '');
      const found = settings.bots.find((b) => b.id === target || b.name === target);
      if (!found) throw new Error(`Không tìm thấy bot "${target}" để chuyển cuộc gọi.`);
      return { target: found.id, name: found.name, note: 'Renderer chuyển cuộc gọi sang bot này.' };
    },
    nudge: (args) => {
      const runtime = runtimes.get(botId);
      const task = String(args.task ?? '');
      const to = typeof args.to === 'string' && args.to ? args.to : botName(botId);
      if (!runtime) return `Bot "${botName(botId)}" chưa có runtime — task chưa được nhận: ${task}`;
      runtime.tasks.push({
        id: randomUUID(),
        botId,
        title: task,
        status: 'pending',
        detail: `Nudge từ voice call, tới ${to}.`,
      });
      return `Đã giao task cho ${to}: ${task}`;
    },
    end_call: () => 'Cuộc gọi thoại đã kết thúc theo yêu cầu của model.',
  };
}

/** Lấy session voice của bot, tạo mới khi chưa có (kèm handlers). */
function getOrCreateVoiceSession(botId: string): VoiceCallSession {
  let session = voiceSessions.get(botId);
  if (!session) {
    session = new VoiceCallSession({
      botId,
      handlers: buildVoiceCallHandlers(botId),
      onEvent: (event) => forwardVoiceSessionEvent(event),
    });
    voiceSessions.set(botId, session);
  }
  return session;
}

/**
 * Đẩy event của một voice session về renderer qua các channel
 * voice:* đã có (thêm `surface` + `surfaceIds` vào payload — các
 * field mới này tương thích ngược, renderer cũ bỏ qua). Mỗi event
 * mang botId của đúng bot phát ra nó; renderer lọc theo botId như
 * trước. Channel 'voice:surface' riêng báo danh sách surface đang
 * đăng ký của bot.
 */
function forwardVoiceSessionEvent(event: VoiceSessionEvent): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  const send = win.webContents.send.bind(win.webContents);
  switch (event.kind) {
    case 'transcript':
      send('voice:transcript', {
        botId: event.botId,
        text: event.text,
        isFinal: event.isFinal,
        surface: event.surface,
        surfaceIds: event.surfaceIds,
      });
      break;
    case 'audio':
      send('voice:audio', {
        botId: event.botId,
        audioBase64: event.audioBase64,
        surface: event.surface,
        surfaceIds: event.surfaceIds,
      });
      break;
    case 'toolcall':
      send('voice:toolcall', {
        botId: event.botId,
        call: event.call,
        outcome: event.outcome,
        surface: event.surface,
        surfaceIds: event.surfaceIds,
      });
      break;
    case 'error':
      send('voice:error', {
        botId: event.botId,
        message: event.message,
        surface: event.surface,
        surfaceIds: event.surfaceIds,
      });
      break;
    case 'surface':
      send('voice:surface', {
        botId: event.botId,
        surfaces: event.surfaces,
        surface: event.surface,
        surfaceIds: event.surfaceIds,
      });
      break;
    case 'state':
      // Renderer suy trạng thái từ kết quả voice:connect/disconnect
      // + voice:error; không cần channel riêng.
      break;
  }
}

/**
 * Lấy URL realtime + key STT từ settings của provider mà bot đang dùng.
 * Trả về null khi provider đó không cấu hình realtime: UI phải ẩn hoặc
 * disable nút voice (không tự đoán URL).
 */
function realtimeConfigFor(bot: BotConfig): { url: string; apiKey?: string; baseUrl: string } | null {
  const providerSettings = settings.providers[bot.providerId];
  if (!providerSettings) return null;
  const url = providerSettings.realtimeUrl;
  if (!url) return null;
  return {
    url,
    apiKey: vault.getSecret('provider', bot.providerId) ?? undefined,
    baseUrl: providerSettings.baseUrl,
  };
}

// ---------------------------------------------------------------------------
// v0.95 (Đội D3): RealtimeSession — voice realtime 2 chiều (duplex +
// barge-in + turn-taking), tách khỏi VoiceCallSession cũ (đường
// voice:connect vẫn giữ nguyên để không vỡ call view hiện tại).
// Một RealtimeSession cho mỗi bot (key = botId); provider lấy từ
// bot.providerId (gemini -> Gemini Live, openai / openai-compatible
// -> OpenAI Realtime wire), key lấy từ Vault (không log, không đưa
// ra renderer). URL: Gemini do adapter tự build từ key (?key=);
// OpenAI lấy realtimeUrl trong settings, mặc định
// wss://api.openai.com/v1/realtime?model=<bot.model>.
// ---------------------------------------------------------------------------

/** RealtimeSession đang chạy cho mỗi bot (key = botId). */
const realtimeSessions = new Map<string, RealtimeSession>();
/** Whether each realtime session runs on the mock fallback (v0.96). */
const realtimeSessionMock = new Map<string, boolean>();

/**
 * Đẩy event của một realtime session về renderer. Transcript /
 * audio / error / toolcall tái dùng các channel voice:* đã có (nên
 * CallView hiện tại vẫn hiện transcript); state / interrupted /
 * turn đi channel riêng 'voice:realtime-state' cho panel realtime.
 */
function forwardRealtimeSessionEvent(botId: string, event: RealtimeSessionEvent): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  const send = win.webContents.send.bind(win.webContents);
  switch (event.kind) {
    case 'transcript':
      send('voice:transcript', { botId, text: event.text, isFinal: event.isFinal });
      break;
    case 'audio':
      send('voice:audio', { botId, audioBase64: event.audioBase64 });
      break;
    case 'toolcall':
      send('voice:toolcall', { botId, call: event.call, outcome: undefined });
      break;
    case 'error':
      send('voice:error', { botId, message: event.message });
      break;
    case 'state':
    case 'interrupted':
    case 'turn':
      send('voice:realtime-state', { botId, ...event });
      break;
  }
}

/** Provider realtime cho một bot (mặc định theo bot.providerId). */
function realtimeProviderFor(bot: BotConfig, requested?: unknown): RealtimeProvider {
  if (isRealtimeProvider(requested)) return requested;
  if (bot.providerId === 'gemini') return 'gemini';
  if (bot.providerId === 'openai-compatible') return 'openai-compatible';
  return 'openai';
}

function getOrCreateRealtimeSession(
  bot: BotConfig,
  provider: RealtimeProvider,
  turnMode: TurnTakingMode,
  useMock = false,
): RealtimeSession {
  let session = realtimeSessions.get(bot.id);
  // A session built for live cannot turn mock (or vice versa) —
  // drop it and rebuild with the right transport factory.
  if (session && realtimeSessionMock.get(bot.id) !== useMock) {
    try {
      session.disconnect();
    } catch {
      // Already gone.
    }
    realtimeSessions.delete(bot.id);
    realtimeSessionMock.delete(bot.id);
    session = undefined;
  }
  if (session) {
    session.setTurnMode(turnMode);
    return session;
  }
  // v0.96 (Đội T5 — voice live): the key is resolved from the Vault
  // at connect time (closure — the transport never stores it), and
  // the transcript + counters persist under userData/voice-sessions
  // so a later session can resume the conversation history.
  // No key and no URL → the mock transport (scripted replies, no
  // network) so the app keeps working at $0.
  session = new RealtimeSession({
    provider,
    turnMode,
    ...(useMock
      ? { transportFactory: (cb) => new MockRealtimeTransport(cb, {}, provider) }
      : {}),
    keyResolver: () => vault.getSecret('provider', bot.providerId),
    sessionStore: new VoiceSessionStore({
      dir: path.join(app.getPath('userData'), 'voice-sessions'),
    }),
    botId: bot.id,
    onEvent: (event) => forwardRealtimeSessionEvent(bot.id, event),
  });
  realtimeSessions.set(bot.id, session);
  realtimeSessionMock.set(bot.id, useMock);
  return session;
}

// ---------------------------------------------------------------------------
// Bot runtime: AgentRunner + BotMemory sống trong tiến trình coordinator con
// (v0.3 wave 2). Main chỉ giữ lịch sử dự phòng + gọi qua NDJSON-RPC.
// ---------------------------------------------------------------------------

const runtimes = new Map<string, BotRuntime>();

/**
 * v0.60: `getOrCreateRuntime` đang chạy dở theo bot id — lúc khởi động
 * 2 IPC (vd lịch sử + chạy thử) có thể gọi song song cho cùng bot, cả
 * hai đều thấy `runtimes` chưa có rồi cùng gọi `createBot` sang
 * coordinator con. Coordinator đã dedup từ v0.55 (không dựng trùng),
 * nhưng chặn ngay tại main thì không gửi RPC thừa nào, và lần 2 chờ
 * chung một promise thay vì tự tạo runtime riêng.
 */
const runtimeCreations = new Map<string, Promise<BotRuntime>>();

/** Coordinator child: owns every AgentRunner + BotMemory (SQLite). */
let coordinator: CoordinatorClient | null = null;

/**
 * v0.54 (P1-9): UpdateService — track persist vào
 * `<userData>/update-track.json` (`{track}`); file lỗi/mất thì về track
 * mặc định `stable` (UpdateService tự xử lý). Service chỉ tạo khi app
 * ready (cần `app.getPath('userData')`).
 */
let updateService: UpdateService | null = null;

function getUpdateService(): UpdateService {
  if (!updateService) {
    const filePath = path.join(app.getPath('userData'), 'update-track.json');
    updateService = new UpdateService({
      currentVersion: app.getVersion(),
      storage: {
        loadTrack: () => {
          try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const parsed = JSON.parse(raw) as unknown;
            return typeof parsed === 'object' && parsed !== null && typeof (parsed as { track?: unknown }).track === 'string'
              ? (parsed as { track: string }).track
              : null;
          } catch {
            return null;
          }
        },
        saveTrack: (track: string) => {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, JSON.stringify({ track }, null, 2), 'utf-8');
        },
      },
    });
  }
  return updateService;
}

function getCoordinator(): CoordinatorClient {
  if (!coordinator) {
    // process.execPath ở main là binary Electron; ELECTRON_RUN_AS_NODE làm
    // nó chạy như Node thuần để entry coordinator chạy vòng stdio (đã kiểm
    // chứng ping/pong). Không có flag này, Electron sẽ load entry như một
    // Electron app và mọi request đều treo.
    const client = new CoordinatorClient({
      // v0.35 (P1-7): userData cho coordinator con — file rule
      // auto-approve `<userData>/auto-approve-rules.json` (xem
      // CoordinatorOptions.dataDir / env OPENBOT_DATA_DIR).
      // v0.85 (P1-7): `OPENBOT_LOCAL_USER_ID` cho coordinator con —
      // main không truyền được function qua NDJSON-RPC, nên nó gửi id
      // của user local; tiến trình con dùng id này + team.json dưới
      // OPENBOT_DATA_DIR để dựng callback `isTeamAdmin` cho tool
      // `manage_access` (xem `runCoordinatorStdio`).
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', OPENBOT_DATA_DIR: app.getPath('userData'), OPENBOT_LOCAL_USER_ID: LOCAL_USER_ID },
      onEvent: (event) => routeCoordinatorEvent(event),
    });
    coordinator = client;
    // v0.57: coordinator mới spawn chưa biết trạng thái Composio — đẩy
    // lại trạng thái đã lưu (best-effort; RPC do v0.58 thêm).
    void syncComposioToCoordinator().catch(() => undefined);
    // Tiến trình con chết thì bỏ handle: lần gọi sau spawn lại và tạo lại
    // bot khi cần (runtimes bị xoá; lịch sử thật nằm trong file memory.db
    // nên bot mới mở lại vẫn thấy).
    void client.waitForExit().then(() => {
      if (coordinator === client) {
        console.error('[open-bot] Coordinator đã thoát — sẽ khởi động lại khi cần.');
        coordinator = null;
        runtimes.clear();
      }
    });
  }
  return coordinator;
}

/** Connector ids có auto-refresh OAuth (Slack / Gmail / Teams). */
const CONNECTOR_IDS = ['slack', 'gmail', 'teams'] as const;

/** Key client credential của connector trong Vault 'oauth-client': `<id>` / `<id>-secret`. */
function isConnectorClientKey(key: string): boolean {
  for (const id of CONNECTOR_IDS) {
    if (key === id || key === `${id}-secret`) return true;
  }
  return false;
}

/** v0.90a (Đội G): một subscriber SSE `GET /v1/harness/events` — filter
 * của client + emit đã đăng ký; routeCoordinatorEvent đẩy event harness
 * vào đây (đã lọc theo filter), unsubscribe gỡ khỏi Set. */
interface HarnessSseSubscriber {
  filter: HarnessEventsFilter;
  emit: (event: HarnessStreamEvent) => void;
}
const harnessSseSubscribers = new Set<HarnessSseSubscriber>();

/** Chuyển event từ coordinator (agent.event) thành IPC về renderer. */
function routeCoordinatorEvent(event: AgentEvent): void {
  const botId = event.botId;
  switch (event.kind) {
    case 'delta':
      sendToRenderer('chat:delta', { botId, delta: event.payload });
      break;
    case 'toolcall':
      sendToRenderer('chat:toolcall', { botId, call: event.payload });
      break;
    case 'toolresult':
      sendToRenderer('chat:toolresult', { botId, result: event.payload });
      break;
    case 'approval-needed': {
      const payload = event.payload as {
        callId: string;
        call: ToolCall;
        reason?: string;
        argsSummary?: string;
      };
      sendToRenderer('chat:approval-needed', {
        botId,
        callId: payload.callId,
        call: payload.call,
        ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
        ...(payload.argsSummary !== undefined ? { argsSummary: payload.argsSummary } : {}),
      });
      // v0.87c: OS notification — bot cần duyệt (dedupe theo callId:
      // cùng 1 lần duyệt chỉ báo 1 lần trong cửa sổ 10s).
      notifyBotEvent('approval', botId, {
        tool: payload.call?.name,
        dedupeKey: `approval:${payload.callId}`,
      });
      void getWebhookDispatcher().dispatch({
        kind: 'approval.needed',
        at: new Date().toISOString(),
        data: { botId, callId: payload.callId, call: payload.call },
      }).catch(() => undefined);
      break;
    }
    case 'harness.permission-needed': {
      // v0.50 (M8 — follow-up M5): permission từ CLI engine qua broker
      // trong coordinator con → renderer mở PermissionCard; câu trả lời
      // về qua IPC `chat:harness-permission-response` rồi xuống RPC
      // `harnessDecidePermission` (broker timeout 120s → từ chối).
      const payload = event.payload as {
        requestId: string;
        botId: string;
        engine: string;
        method: string;
        detail?: string;
        allowable: boolean;
      };
      sendToRenderer('chat:harness-permission-needed', {
        requestId: payload.requestId,
        botId: payload.botId,
        engine: payload.engine,
        method: payload.method,
        ...(payload.detail !== undefined ? { detail: payload.detail } : {}),
        allowable: payload.allowable,
      });
      break;
    }
    case 'ask-user': {
      const payload = event.payload as {
        requestId: string;
        question: string;
        options?: string[];
      };
      sendToRenderer('chat:ask-user', {
        botId,
        requestId: payload.requestId,
        question: payload.question,
        options: payload.options,
      });
      break;
    }
    case 'interrupt-needed': {
      // v0.54 (P1-8): run dừng ở điểm interrupt để hỏi user — renderer
      // hiện InterruptCard; câu trả lời về qua IPC
      // `chat:interrupt-response` rồi xuống RPC `respondInterrupt`.
      const payload = event.payload as {
        requestId: string;
        runId: string;
        stepIndex: number;
        reason: string;
        question?: string;
        toolCall?: unknown;
      };
      sendToRenderer('chat:interrupt-needed', {
        botId,
        requestId: payload.requestId,
        runId: payload.runId,
        stepIndex: payload.stepIndex,
        reason: payload.reason,
        ...(payload.question !== undefined ? { question: payload.question } : {}),
        ...(payload.toolCall !== undefined ? { toolCall: payload.toolCall } : {}),
      });
      break;
    }
    case 'mcp.elicitation-needed': {
      // v0.13: MCP server hỏi user (elicitation/create) — renderer hiện
      // ElicitationModal; câu trả lời về qua IPC `chat:elicitation-response`
      // rồi xuống coordinator bằng RPC `respondElicitation`.
      const payload = event.payload as {
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
      };
      sendToRenderer('chat:elicitation-needed', {
        botId,
        elicitationId: payload.elicitationId,
        serverName: payload.serverName,
        message: payload.message,
        mode: payload.mode,
        url: payload.url,
        fields: payload.fields,
      });
      break;
    }
    case 'progress':
      sendToRenderer('chat:progress', { botId, message: event.payload });
      break;
    case 'summary':
      sendToRenderer('chat:summary', { botId, summary: event.payload });
      break;
    case 'agent.created': {
      // v0.6: bot do agent tạo trong coordinator (tool create_agent) —
      // lưu vào settings.json (không có key) để lần mở sau vẫn còn và
      // hiện trong danh sách bot; báo renderer tải lại danh sách.
      const payload = event.payload as { bot?: BotConfig };
      const bot = payload?.bot;
      if (bot && typeof bot.id === 'string' && !settings.bots.some((b) => b.id === bot.id)) {
        settings.bots.push(bot);
        saveSettings();
        sendToRenderer('bots:changed', { botId: bot.id });
      }
      break;
    }
    case 'mcp.oauth-token': {
      // v0.7: mcp_auth vừa lưu token mới trong con — persist vào Vault
      // namespace 'mcp-oauth' (key = tên server) để lần mở sau còn.
      const payload = event.payload as { server?: unknown; value?: unknown };
      if (typeof payload?.server === 'string' && typeof payload?.value === 'string') {
        vault.setSecret('mcp-oauth', payload.server, payload.value);
      }
      break;
    }
    case 'connector.oauth-token': {
      // v0.9d: coordinator vừa refresh TokenSet của một connector
      // trong con — persist full TokenSet vào Vault namespace
      // 'connector' (key = connector id) để lần mở sau / createBot
      // sau seed token mới. Validate shape trước khi ghi (chỉ nhận
      // đúng 3 connector, value phải parse thành TokenSet có
      // accessToken); không bao giờ log value.
      const payload = event.payload as { connectorId?: unknown; value?: unknown };
      if (
        typeof payload?.connectorId === 'string' &&
        (CONNECTOR_IDS as readonly string[]).includes(payload.connectorId) &&
        typeof payload?.value === 'string'
      ) {
        try {
          const parsed = JSON.parse(payload.value) as { accessToken?: unknown };
          if (typeof parsed.accessToken === 'string' && parsed.accessToken) {
            vault.setSecret('connector', payload.connectorId, payload.value);
          }
        } catch {
          // TokenSet JSON lỗi từ con — bỏ qua, giữ bản Vault cũ.
        }
      }
      break;
    }
    case 'harness.event': {
      // v0.90a (Đội G): event harness đã sanitize từ coordinator con —
      // forward về renderer kênh 'harness:event' (live-tail EventLogView)
      // + quạt ra các subscriber SSE Local API (đã lọc theo filter).
      // Payload là envelope HarnessEvent đầy đủ; event lạ (thiếu at /
      // kind) thì bỏ qua để không vỡ stream SSE.
      const payload = event.payload as Partial<HarnessStreamEvent>;
      if (typeof payload?.at !== 'string' || typeof payload?.kind !== 'string') break;
      const streamEvent = payload as HarnessStreamEvent;
      sendToRenderer('harness:event', streamEvent);
      for (const sub of [...harnessSseSubscribers]) {
        if (sub.filter.threadId !== undefined && sub.filter.threadId !== streamEvent.threadId) {
          continue;
        }
        if (sub.filter.botId !== undefined && sub.filter.botId !== streamEvent.botId) continue;
        if (sub.filter.kinds !== undefined && !sub.filter.kinds.includes(streamEvent.kind)) {
          continue;
        }
        try {
          sub.emit(streamEvent);
        } catch {
          // Một subscriber lỗi không chặn các subscriber khác.
        }
      }
      break;
    }
    case 'composio.key-needed': {
      // v0.59: coordinator vừa bật Composio mà không đọc được key nào
      // (safeStorage/NO_STORAGE — file reader trả null, chưa seed) nên
      // xin main seed lại. Main đọc Vault bằng safeStorage rồi seed
      // qua RPC `composio.setApiKey` (best-effort, không log key).
      void seedComposioKeyToCoordinator().catch(() => undefined);
      break;
    }
    case 'internet.watch-changed': {
      // v0.95 (Team D1): một watched page đổi nội dung (tool
      // `watch_check` trong coordinator con). Forward về renderer để
      // InternetDataView hiện banner + bắn OS notification kind
      // `watch-change` (dedupe theo URL: cùng 1 trang chỉ báo 1 lần
      // trong cửa sổ 10s; toggle trong Settings → Notifications).
      const payload = event.payload as { url?: unknown; summary?: unknown; checkedAt?: unknown };
      const url = typeof payload?.url === 'string' ? payload.url : '';
      const summary = typeof payload?.summary === 'string' ? payload.summary : '';
      sendToRenderer('internet:watch-changed', {
        botId,
        url,
        summary,
        ...(typeof payload?.checkedAt === 'number' ? { checkedAt: payload.checkedAt } : {}),
      });
      notifyBotEvent('watch-change', botId, {
        url,
        dedupeKey: `watch-change:${url}`,
      });
      break;
    }
    case 'mcp.open-url': {
      // v0.7: mcp_auth nhờ mở URL xin phép trong trình duyệt hệ thống.
      // Chỉ mở http(s) — event từ tiến trình con không được mở scheme lạ.
      const payload = event.payload as { url?: unknown };
      const url = typeof payload?.url === 'string' ? payload.url : '';
      if (url.startsWith('https://') || url.startsWith('http://')) {
        void shell.openExternal(url);
      } else {
        console.error(
          '[open-bot] Từ chối mở URL không phải http(s) từ coordinator:',
          url.slice(0, 80),
        );
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Whether the local owner may edit a bot under the team rules.
 * No team members configured -> unrestricted. Owner not a team member ->
 * unrestricted (the machine owner is not bound by team roles). Otherwise
 * the team rules apply (admin: all shared bots; member: own shared bots).
 */
function teamAllowsEdit(botId: string): boolean {
  try {
    const team = loadTeamConfig(app.getPath('userData'));
    if (team.members.length === 0) return true;
    if (!getMember(team, LOCAL_USER_ID)) return true;
    return canEditBot(team, LOCAL_USER_ID, botId);
  } catch {
    return true;
  }
}

/**
 * v0.59 (P0-5 follow-up §6): policy checker cho automation theo
 * viewer local — role team của user hiện tại (LOCAL_USER_ID, the
 * machine owner). Team config được đọc MỖI lần check nên đổi role
 * (team:set-role) có hiệu lực ngay, không cần restart.
 * - Không có team member nào (install single-user) hoặc owner không
 *   phải member → không giới hạn (trả true mọi action).
 * - Member là role team thì áp đúng ma trận policy.ts: viewer chỉ
 *   OPEN, member chỉ sửa automation mình tạo (legacy `createdBy: ''`
 *   thì được), admin làm tất.
 * - Fail-closed: không đọc được team config, hoặc role không xác
 *   định được, thì CHẶN mọi action (viewer không xác định được =
 *   không cho làm gì). Checker không bao giờ throw (scheduler cũng
 *   coi throw là deny, nhưng chặn tường minh rõ ràng hơn).
 */
function localAutomationPolicyChecker(): AutomationPolicyChecker {
  return (action, ctx) => {
    try {
      const team = loadTeamConfig(app.getPath('userData'));
      if (team.members.length === 0) return true;
      const member = getMember(team, LOCAL_USER_ID);
      if (!member) return true;
      return createRolePolicyChecker(member.role, LOCAL_USER_ID)(action, ctx);
    } catch {
      return false;
    }
  };
}

/**
 * Build the core ProviderConfig for a bot/provider from stored settings.
 * Async vì provider CLI (M1) cần detect trước khi biết binary: nguồn
 * chưa bật hoặc CLI chưa đăng nhập thì throw rõ ràng (fail-closed).
 */
async function providerConfigFor(providerId: string, modelOverride?: string): Promise<ProviderConfig> {
  // v0.7: policy — provider bị cấm không được dùng (kể cả khi bot cũ còn trỏ tới).
  if (!isProviderAllowed(activePolicy, providerId)) {
    throw new Error(`Provider "${providerId}" không được phép theo policy của máy.`);
  }
  const saved = settings.providers[providerId];
  const meta = PROVIDERS.find((m) => m.id === providerId);
  // M3: provider Custom ACP CLI — model của bot chính là slug của CLI
  // tuỳ chỉnh (vd model `my-agent`); resolve slug → binary + argv
  // ACP từ registry, kiểm tra nguồn vừa bật vừa available/'unknown'
  // (fail-closed, không đoán binary/args trên PATH).
  if (providerId === 'custom-acp') {
    const slug = (modelOverride || saved?.defaultModel || '').trim();
    if (!slug || slug === 'custom-acp') {
      throw new Error(
        'Custom ACP CLI: chưa chọn CLI tuỳ chỉnh nào — chọn một CLI trong danh sách model của provider này (thêm CLI ở Settings → Engines → "Set CLI…").',
      );
    }
    const registry = getDetectedEngines();
    const cfg = registry.getCustomCli(slug);
    if (!cfg) {
      throw new Error(`Custom ACP CLI: không tìm thấy CLI tuỳ chỉnh "${slug}" — kiểm tra lại ở Settings → Engines.`);
    }
    const kind = customAcpKind(slug);
    const snapshot = await registry.detect();
    if (!isEngineUsableAllowingUnknown(snapshot, kind)) {
      const engine = snapshot.engines[kind];
      const reason =
        engine?.status === 'available' || engine?.status === 'unknown'
          ? 'chưa được bật'
          : engine?.reason === 'not-installed'
            ? 'không chạy được binary đã khai báo'
            : engine?.reason === 'not-signed-in'
              ? 'CLI chưa đăng nhập (theo lệnh kiểm tra đã khai)'
              : 'chưa dùng được';
      throw new Error(`Custom ACP CLI "${cfg.label}": ${reason} — bật nguồn trong Settings → Engines trước.`);
    }
    return {
      id: providerId,
      label: cfg.label,
      defaultModel: slug,
      cliBinary: usableCustomEngineBinary(snapshot, kind) ?? cfg.binaryPath,
      cliArgs: [...cfg.acpArgs],
    };
  }
  // M1: provider CLI — chỉ dùng khi nguồn detector tương ứng vừa bật
  // vừa available; binary lấy từ snapshot (không tự đoán trên PATH).
  // M4: ngoại lệ Windsurf — detector không kiểm tra được đăng nhập
  // (status 'unknown', như Custom ACP CLI) nên chấp nhận cả 'unknown'
  // khi user đã bật nguồn; lỗi auth (nếu có) sẽ hiện rõ khi chạy bot.
  if (meta?.kind === 'cli' && meta.detectedKind) {
    const snapshot = await getDetectedEngines().detect();
    const allowUnknown = meta.detectedKind === 'windsurf';
    const usable = allowUnknown
      ? isEngineUsableAllowingUnknown(snapshot, meta.detectedKind)
      : isEngineUsable(snapshot, meta.detectedKind);
    if (!usable) {
      const engine = snapshot.engines[meta.detectedKind];
      const reason =
        engine?.status === 'available' || engine?.status === 'unknown'
          ? 'chưa được bật'
          : engine?.reason === 'not-installed'
            ? 'chưa cài CLI trên máy'
            : engine?.reason === 'not-signed-in'
              ? 'CLI chưa đăng nhập'
              : engine?.reason === 'version-too-old'
                ? `CLI quá cũ (cần tối thiểu ${engine.minVersion})`
                : 'chưa dùng được';
      throw new Error(`${meta.label}: ${reason} — bật nguồn trong Settings → Engines trước.`);
    }
    return {
      id: providerId,
      label: meta.label,
      defaultModel: modelOverride || saved?.defaultModel || meta.defaultModel || '',
      cliBinary:
        (allowUnknown
          ? snapshot.engines[meta.detectedKind]?.binaryPath
          : usableEngineBinary(snapshot, meta.detectedKind)) ?? undefined,
    };
  }
  return {
    id: providerId,
    label: meta?.label ?? providerId,
    // v0.4: API key sống trong Vault, KHÔNG còn trong settings.json.
    apiKey: vault.getSecret('provider', providerId) ?? undefined,
    // v0.7: baseUrl = user đã gõ > policy backend > mặc định của provider.
    baseUrl:
      effectiveBaseUrl(activePolicy, providerId, meta?.defaultBaseUrl ?? '', saved?.baseUrl) ||
      undefined,
    defaultModel: modelOverride || saved?.defaultModel || meta?.defaultModel || '',
  };
}

function workspaceDirFor(bot: BotConfig): string {
  const dir =
    bot.workspaceDir && bot.workspaceDir.trim().length > 0
      ? bot.workspaceDir
      : path.join(app.getPath('userData'), 'workspaces', bot.id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

const MCP_OAUTH_FILE = 'mcp-oauth.json';

/**
 * v0.7: đọc cấu hình OAuth cho MCP server từ `<userData>/mcp-oauth.json`:
 *   { "servers": { "<name>": { "authorizationEndpoint", "tokenEndpoint",
 *     "clientId", "scope"? } }, "allowedSystemTools": ["tool-a", ...] }
 * Client secret (khi provider cần) lấy từ Vault namespace
 * 'mcp-oauth-client', key = tên server. File sai định dạng -> bỏ qua
 * (log lỗi, không crash); server thiếu field -> bỏ qua server đó.
 */
function readMcpOAuthFile(): {
  configs: Record<string, McpOAuthClientConfig>;
  allowedSystemTools: string[];
} {
  const empty = { configs: {}, allowedSystemTools: [] as string[] };
  const file = path.join(app.getPath('userData'), MCP_OAUTH_FILE);
  let parsed: unknown;
  try {
    if (!fs.existsSync(file)) return empty;
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error('[open-bot] Không đọc được mcp-oauth.json:', (err as Error).message);
    return empty;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return empty;
  const obj = parsed as {
    servers?: Record<string, Record<string, unknown>>;
    allowedSystemTools?: unknown;
  };
  const configs: Record<string, McpOAuthClientConfig> = {};
  if (obj.servers && typeof obj.servers === 'object') {
    for (const [name, raw] of Object.entries(obj.servers)) {
      if (!raw || typeof raw !== 'object') continue;
      const { authorizationEndpoint, tokenEndpoint, clientId, scope } = raw;
      if (
        typeof authorizationEndpoint !== 'string' ||
        typeof tokenEndpoint !== 'string' ||
        typeof clientId !== 'string'
      ) {
        console.error(
          `[open-bot] Bỏ qua MCP OAuth server "${name}" trong mcp-oauth.json (thiếu endpoint/clientId).`,
        );
        continue;
      }
      const cfg: McpOAuthClientConfig = { authorizationEndpoint, tokenEndpoint, clientId };
      if (typeof scope === 'string' && scope) cfg.scope = scope;
      const secret = vault.getSecret('mcp-oauth-client', name);
      if (secret) cfg.clientSecret = secret;
      configs[name] = cfg;
    }
  }
  const allowedSystemTools = Array.isArray(obj.allowedSystemTools)
    ? obj.allowedSystemTools.filter((t): t is string => typeof t === 'string')
    : [];
  return { configs, allowedSystemTools };
}

/**
 * v0.9d: full TokenSets cho tool tích hợp (Slack / Gmail / Teams),
 * đọc từ Vault namespace 'connector' (lưu dưới dạng TokenSet JSON).
 * Token trần (kiểu cũ, chuỗi không phải JSON) vẫn dùng được — giữ
 * thành TokenSet không có hạn (không refresh). Entry lỗi định dạng
 * (JSON parse được nhưng không có accessToken chuỗi) bị bỏ qua. Toàn
 * bộ set — gồm refresh token + hạn — đi sang coordinator con qua
 * createBot; con refresh trong bộ nhớ và gửi set mới về qua event
 * 'connector.oauth-token' để persist lại Vault. Không bao giờ log.
 */
function connectorTokenSets(): Record<string, TokenSet> {
  const out: Record<string, TokenSet> = {};
  for (const id of CONNECTOR_IDS) {
    const stored = vault.getSecret('connector', id);
    if (!stored) continue;
    try {
      const parsed = JSON.parse(stored) as { accessToken?: unknown };
      if (typeof parsed.accessToken === 'string' && parsed.accessToken) {
        out[id] = parsed as TokenSet;
        continue;
      }
    } catch {
      // Không phải JSON — dùng nguyên chuỗi như token trần.
    }
    out[id] = { accessToken: stored };
  }
  return out;
}

/**
 * v0.9d: OAuth client credentials cho từng connector, đọc từ Vault
 * namespace 'oauth-client' — cùng scheme key như Google login
 * (main.ts auth flow): key `<id>` = client id, `<id>-secret` =
 * client secret. Chưa có flow kết nối OAuth riêng cho 3 connector
 * này (không có Settings UI / code-exchange), nhưng credential đã
 * lưu được qua IPC `vault:set` có sẵn — khi có client id, connector
 * mới tự refresh được; không có thì chạy bằng token tĩnh, không
 * auto-refresh. Không bao giờ log.
 */
function connectorClientConfigs(): Record<string, { clientId: string; clientSecret?: string }> {
  const out: Record<string, { clientId: string; clientSecret?: string }> = {};
  for (const id of CONNECTOR_IDS) {
    const clientId = vault.getSecret('oauth-client', id);
    if (!clientId) continue;
    const secret = vault.getSecret('oauth-client', `${id}-secret`);
    out[id] = secret ? { clientId, clientSecret: secret } : { clientId };
  }
  return out;
}

/**
 * v0.70: xác thực lại PAT GitHub lúc tính trạng thái app — một
 * instance cho cả main process, cache kết quả hợp lệ 1 giờ (xem
 * GithubPatRevalidator trong core). Token chỉ dùng để gọi
 * api.github.com, không log, không trả về renderer.
 * v0.71: test E2E được rút ngắn TTL cache đó qua env
 * `OPENBOT_GITHUB_PAT_REVALIDATE_CACHE_MS` (vd 200ms) — nếu không,
 * test phải chờ đủ 1 giờ mới thấy lần kiểm tra sau 401 gọi lại
 * mạng thay vì trả cache hợp lệ. Production không set env này (hoặc
 * set giá trị không phải số dương) thì vẫn cache 1 giờ như cũ.
 */
const githubPatRevalidateCacheMs = Number(process.env.OPENBOT_GITHUB_PAT_REVALIDATE_CACHE_MS);
const githubPatRevalidator = new GithubPatRevalidator(
  Number.isFinite(githubPatRevalidateCacheMs) && githubPatRevalidateCacheMs > 0
    ? { cacheMs: githubPatRevalidateCacheMs }
    : {},
);

/**
 * M7: trạng thái đầy đủ mọi connected app cho UI (Settings →
 * Connected apps). Đọc catalog từ core + token từ Vault namespace
 * 'connector' + nhãn tài khoản từ identity row. Không chứa token:
 * chỉ trạng thái (chưa kết nối / đã kết nối / hết hạn / lỗi /
 * local) + nhãn tài khoản. Token trần kiểu cũ (không phải JSON)
 * vẫn tính là đã kết nối (không có hạn để kiểm tra); JSON parse
 * được nhưng thiếu accessToken chuỗi thì tính là lỗi.
 * v0.68b: app token (PAT dán tay, vd GitHub) đọc Vault theo vị trí
 * đã khai trong AppDefinition (namespace/key) — chưa có secret thì
 * 'not_connected', có secret không rỗng thì 'connected', Vault lỗi
 * đọc thì 'error'. Chỉ kiểm tra sự tồn tại, KHÔNG gọi API ngoài và
 * không bao giờ log hay lộ giá trị token.
 * v0.70: riêng app 'github', PAT có thể bị thu hồi SAU khi lưu nên
 * trạng thái được xác thực LẠI với api.github.com (cache kết quả hợp
 * lệ 1 giờ): 401 → 'expired' + authStatusDetail hướng dẫn dán lại
 * token; lỗi mạng/timeout/rate-limit → giữ 'connected' + ghi rõ lý
 * do trong authStatusDetail (không đánh dấu token hỏng oan). App
 * token khác (hiện chưa có) giữ hành vi cũ: chỉ kiểm tra sự tồn tại.
 */
async function buildAppStatusViews(): Promise<AppStatusView[]> {
  return Promise.all(listApps().map(async (app) => {
    let authStatus: AppAuthStatus = 'not_connected';
    let accountLabel: string | undefined;
    let authStatusDetail: string | undefined;
    if (app.authType === 'none') {
      authStatus = 'local';
    } else if (app.authType === 'token' && app.vaultNamespace && app.vaultKey) {
      try {
        const raw = vault.getSecret(app.vaultNamespace, app.vaultKey);
        if (!raw || !raw.trim()) {
          authStatus = 'not_connected';
        } else if (app.id === 'github') {
          const check = await githubPatRevalidator.check(raw).catch(() => null);
          if (check === null) {
            // Revalidator không bao giờ ném (phòng thủ): chưa kiểm tra
            // được thì giữ trạng thái cũ, không kết luận token hỏng.
            authStatus = 'connected';
            authStatusDetail = GITHUB_PAT_UNCHECKABLE_NETWORK_DETAIL;
          } else if (check.outcome === 'valid') {
            authStatus = 'connected';
            if (check.login) accountLabel = check.login;
          } else if (check.outcome === 'invalid') {
            authStatus = 'expired';
            authStatusDetail = check.detail;
          } else {
            authStatus = 'connected';
            authStatusDetail = check.detail;
          }
        } else {
          authStatus = 'connected';
        }
      } catch {
        authStatus = 'error';
      }
    } else if (app.connectorId) {
      const raw = vault.getSecret('connector', app.connectorId);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as TokenSet;
          authStatus =
            typeof parsed.accessToken === 'string' && parsed.accessToken
              ? deriveAppAuthStatus(parsed)
              : 'error';
        } catch {
          authStatus = raw.length > 0 ? 'connected' : 'error';
        }
        try {
          const identity = getProviderIdentity(vault, app.connectorId);
          accountLabel = identity?.displayName ?? identity?.email ?? undefined;
        } catch {
          accountLabel = undefined;
        }
      }
    }
    const toolCap = DEFAULT_APP_TOOL_CAP;
    const exposedToolCount = Math.min(app.tools.length, toolCap);
    return {
      app,
      authStatus,
      ...(accountLabel ? { accountLabel } : {}),
      ...(authStatusDetail ? { authStatusDetail } : {}),
      toolCap,
      exposedToolCount,
      cappedOutToolNames: app.tools.slice(exposedToolCount).map((t) => t.name),
    };
  }));
}

async function getOrCreateRuntime(bot: BotConfig): Promise<BotRuntime> {
  const existing = runtimes.get(bot.id);
  if (existing) return existing;
  // v0.60: hai lần gọi song song cho cùng bot thì chờ chung một promise
  // (chỉ một lần gọi `createBot` sang coordinator) — xem `runtimeCreations`.
  const inFlight = runtimeCreations.get(bot.id);
  if (inFlight) return inFlight;
  const created = getOrCreateRuntimeInner(bot);
  runtimeCreations.set(bot.id, created);
  try {
    return await created;
  } finally {
    if (runtimeCreations.get(bot.id) === created) runtimeCreations.delete(bot.id);
  }
}

async function getOrCreateRuntimeInner(bot: BotConfig): Promise<BotRuntime> {
  const workspaceDir = workspaceDirFor(bot);
  // v0.90b (đội G): nguồn của model đang chạy đã bị tắt riêng cho bot
  // này thì KHÔNG chạy lén bằng nguồn đó — chặn fail-closed với lỗi rõ
  // ràng để user đổi model (picker đã báo + gợi ý thay thế từ trước).
  if ((bot.disabledProviders ?? []).includes(bot.providerId)) {
    throw new Error(
      `Provider "${bot.providerId}" đã bị tắt riêng cho bot "${bot.name}" — bật lại nguồn trong phần Nguồn của bot (mở Sửa bot) hoặc đổi model khác rồi gửi lại.`,
    );
  }
  // Runner + BotMemory + registry (48 tool + plugin) được dựng trong tiến
  // trình coordinator con; main chỉ giữ lịch sử dự phòng. API key chỉ đi
  // trong params của createBot qua stdio cùng máy (không log).
  const mcpOAuth = readMcpOAuthFile();
  const mcpOAuthTokens: Record<string, string> = {};
  for (const key of vault.listSecrets('mcp-oauth')) {
    const value = vault.getSecret('mcp-oauth', key);
    if (value) mcpOAuthTokens[key] = value;
  }
  await getCoordinator().createBot({
    bot,
    provider: await providerConfigFor(bot.providerId, bot.model),
    workspaceDir,
    pluginsDir: path.join(app.getPath('userData'), 'plugins'),
    // v0.4: spend-limit tracking + skill injection trong coordinator con.
    usageStorePath: path.join(app.getPath('userData'), USAGE_FILE),
    // v0.10: run tracing — coordinator con ghi 1 trace JSONL mỗi run vào
    // file này; main chỉ đọc lại cho TraceView (xem getTraceStore).
    tracesFile: path.join(app.getPath('userData'), TRACES_FILE),
    skillsDirs: {
      userSkillsDir: path.join(app.getPath('userData'), 'skills'),
      pluginsDir: path.join(app.getPath('userData'), 'plugins'),
      stateDir: app.getPath('userData'),
    },
    // v0.6: X bearer cho tool x_search (đọc từ Vault, không log).
    xBearer: vault.getSecret('x', 'bearer') ?? undefined,
    // v0.95 (Team D1): Brave Search API key cho tool internet_search
    // nguồn `brave` (Vault namespace 'search', key 'brave-api-key').
    // Opt-in: vắng = nguồn brave từ chối với hướng dẫn, nguồn miễn
    // phí vẫn chạy. Không log.
    braveSearchApiKey: vault.getSecret('search', 'brave-api-key') ?? undefined,
    // v0.59: Composio API key seed cho coordinator (đọc từ Vault bằng
    // safeStorage trong main — tiến trình con không đọc được khi Vault
    // dùng safeStorage/NO_STORAGE). Con giữ trong bộ nhớ, xoay key
    // thì lần createBot sau seed lại (không cần destroyBot). Vắng =
    // coordinator dùng fallback đọc file Vault (LocalEncryptor) hoặc
    // fail-closed. Không log.
    composioApiKey: getComposioApiKey(vault) ?? undefined,
    // v0.88b: Composio user id seed cho coordinator (đọc từ Vault
    // bằng safeStorage trong main — tiến trình con không đọc được
    // khi Vault dùng safeStorage/NO_STORAGE). Con giữ trong bộ nhớ,
    // đổi id thì lần createBot sau seed lại (không cần destroyBot).
    // Vắng = coordinator giữ nguyên id đã seed (mặc định
    // 'local-user'). Không log.
    composioUserId: getComposioUserId(vault) ?? undefined,
    // v0.95 (Team D2): media API keys seed cho coordinator (đọc từ
    // Vault namespace 'media' bằng safeStorage trong main — tiến
    // trình con không đọc được khi Vault dùng safeStorage/NO_STORAGE).
    // Con giữ trong bộ nhớ, xoay key thì lần createBot sau seed lại
    // (không cần destroyBot). Vắng = coordinator giữ nguyên key đã
    // seed. Không log.
    mediaApiKeys: getAllMediaApiKeys(vault),
    // v0.7: token cho tool git / tích hợp / MCP OAuth (đọc từ Vault, không log).
    githubToken: vault.getSecret('github', 'token') ?? undefined,
    // v0.9d: full TokenSet + client credentials cho Slack/Gmail/Teams —
    // con tự refresh trong bộ nhớ, gửi set mới về qua event
    // 'connector.oauth-token' để main persist lại Vault.
    connectorTokenSets: connectorTokenSets(),
    connectorClientConfigs: connectorClientConfigs(),
    mcpOAuthTokens,
    mcpOAuthConfigs: mcpOAuth.configs,
    allowedSystemTools: mcpOAuth.allowedSystemTools,
  });

  const runtime: BotRuntime = { bot, history: [], tasks: [] };
  runtimes.set(bot.id, runtime);
  return runtime;
}

async function invalidateRuntime(botId: string): Promise<void> {
  runtimes.delete(botId);
  if (coordinator) {
    // Best-effort: coordinator chết thì destroyBot cũng không còn ý nghĩa.
    await coordinator.destroyBot(botId).catch(() => undefined);
  }
}

/**
 * v0.65 (vision persistence): the v0.63/v0.64 `visionHistoryLine`
 * helper (which appended a "📷 Ảnh đính kèm …" line to the saved text
 * because base64 was never persisted) is GONE — images are now stored
 * as files + `message_attachments` rows via `saveMessage` (see
 * `BotMemory.saveMessage`), so the saved text stays plain and a reload
 * re-reads the real images. Old rows keep their metadata lines and
 * render exactly as before.
 */

/**
 * Persist one chat message into the coordinator-owned BotMemory
 * (saveMessage RPC); history stays in BotMemory, and `runtime.history`
 * is only a fallback for messages written before this.
 * v0.59 (UI-5): `threadId` pins the message to a thread; without it
 * the row keeps threadId NULL (legacy path).
 * v0.65 (vision persistence): `attachments` ride along so the images
 * are stored as files + `message_attachments` rows (see
 * `BotMemory.saveMessage`) — the saved TEXT stays plain (no metadata
 * line appended any more; v0.63/v0.64 rows keep their old lines and
 * still render as before).
 */
async function syncMessageToMemory(
  runtime: BotRuntime,
  msg: ChatMessage,
  threadId?: string,
  attachments?: VisionAttachment[],
): Promise<void> {
  try {
    await getCoordinator().saveMessage(
      runtime.bot.id,
      msg.role,
      msg.text,
      threadId,
      attachments,
    );
  } catch (err) {
    console.error('[open-bot] Không lưu được tin nhắn:', (err as Error).message);
  }
}

async function historyFromMemory(
  runtime: BotRuntime,
  limit: number,
  threadId?: string,
): Promise<ChatMessage[]> {
  try {
    // v0.65: reload WITH the stored images, so reloaded user bubbles
    // show their thumbnails again (not just the file name).
    const { messages } = await getCoordinator().getHistory(
      runtime.bot.id,
      limit,
      threadId,
      true,
    );
    if (messages.length > 0) {
      // Core history is {role, content}; map it to the main-process shape.
      // Tool-role rows are part of the agent transcript, not chat display.
      return messages
        .filter((r) => r.role === 'user' || r.role === 'assistant' || r.role === 'system')
        .map((r) => ({
          id: randomUUID(),
          role: r.role as 'user' | 'assistant' | 'system',
          text: r.content,
          createdAt: Date.now(),
          ...(r.attachments && r.attachments.length > 0
            ? { attachments: r.attachments }
            : {}),
        }));
    }
  } catch {
    // Fall through to the in-memory history below.
  }
  // v0.59 (UI-5): the in-memory fallback is bot-wide (no threadId on
  // its rows) — only use it on the legacy no-thread path, so loading a
  // thread never shows another thread's messages.
  if (threadId !== undefined) return [];
  return runtime.history.slice(-limit);
}


/**
 * Pick the first present string field from a userinfo response.
 * `spec` is the provider's field name (or list of fallbacks); when
 * omitted, the OpenID default `fallback` is used.
 */
function pickUserinfoField(
  info: Record<string, unknown>,
  spec: string | string[] | undefined,
  fallback: string,
): string | undefined {
  const candidates = spec === undefined ? [fallback] : Array.isArray(spec) ? spec : [spec];
  for (const key of candidates) {
    const value = info[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/**
 * v0.7: đăng nhập OAuth một provider (Google, Slack, Microsoft —
 * xem OAUTH_PROVIDERS; xAI chỉ dùng API key).
 *
 * 1. Lấy OAuth client id/secret: từ tham số renderer gửi lên, nếu
 *    không có thì từ Vault namespace 'oauth-client' (người dùng đã
 *    lưu trước đó). Không có client id -> lỗi rõ kèm hướng dẫn tạo
 *    client của đúng provider đó (xem `clientSetupHint` trong
 *    OAUTH_PROVIDERS) — app KHÔNG nhúng client id/secret chung
 *    (secret nhúng trong app desktop là public, không an toàn).
 * 2. Mở trình duyệt hệ thống tới URL authorize, callback về
 *    http://127.0.0.1:<port>/oauth/callback (server tạm, tự tắt sau
 *    khi nhận code). Port ngẫu nhiên, trừ Slack: Slack đối chiếu
 *    redirect_uri chính xác nên dùng port cố định của provider
 *    (`callbackPort`, phải đăng ký trước trong Slack app).
 * 3. Đổi code lấy token; CHỈ refresh token được lưu vào Vault
 *    namespace 'oauth-refresh' — access token ngắn hạn không lưu bền.
 * 4. Best-effort: lấy display name/email từ userinfo để lưu identity
 *    (Vault namespace 'identity:<provider>'); lỗi userinfo không
 *    làm hỏng login. Mỗi provider có field mapping riêng
 *    (`userinfoFields`): Google dùng sub/name/email, Slack dùng
 *    auth.test (user_id/user), Microsoft dùng Graph /me
 *    (id/displayName/mail).
 * 5. W11b — nối token vào connector: khi login này là cho một
 *    connector (`connectorId` được truyền vào, hoặc provider có
 *    `connectorId` mặc định: slack -> 'slack', microsoft -> 'teams',
 *    google + connector 'gmail'), full TokenSet (access + refresh +
 *    hạn) được ghi thêm vào Vault namespace 'connector', key =
 *    connector id — đúng chỗ `connectorTokenSets()` đọc để seed cho
 *    coordinator con, nơi `getConnectorTokenProvider` tự refresh
 *    (v0.9d) cho tool slack_send / teams_send / gmail_send. Client
 *    id/secret cũng được lưu thêm dưới key connector để coordinator
 *    refresh được (xem `connectorClientConfigs()`). Không có
 *    connectorId (đăng nhập Google thường) thì không ghi gì vào
 *    namespace 'connector' — login Google hiện tại không đổi.
 * Token/code KHÔNG bao giờ được log (lỗi chỉ nêu lý do chung).
 */
async function startOAuthLogin(
  providerId: string,
  clientId?: string,
  clientSecret?: string,
  connectorId?: string,
): Promise<{ ok: boolean; providerId: string; displayName?: string; error?: string }> {
  if (!isOAuthSupported(providerId)) {
    return {
      ok: false,
      providerId,
      error: `Provider "${providerId}" chưa hỗ trợ đăng nhập OAuth (hiện chỉ có: ${Object.values(OAUTH_PROVIDERS).map((p) => p.id).join(', ')}).`,
    };
  }
  const provider = getOAuthProvider(providerId);
  // Connector this login feeds: explicit from the caller (e.g. the
  // Connectors section logs in to Google for connector 'gmail'), or
  // the provider's own default (slack -> 'slack', microsoft ->
  // 'teams'). A plain identity login passes none.
  const resolvedConnectorId = connectorId ?? provider.connectorId ?? null;
  if (resolvedConnectorId !== null && !(CONNECTOR_IDS as readonly string[]).includes(resolvedConnectorId)) {
    return {
      ok: false,
      providerId,
      error: `Connector "${resolvedConnectorId}" không hợp lệ (chỉ có: ${CONNECTOR_IDS.join(', ')}).`,
    };
  }
  // Connector login through this provider uses the connector's own
  // scopes (e.g. Gmail API scopes instead of the narrow Google
  // identity scopes); otherwise the provider's default scopes.
  const scopesOverride =
    resolvedConnectorId !== null ? provider.connectorScopes?.[resolvedConnectorId] : undefined;
  if (oauthLoginInFlight) {
    return { ok: false, providerId, error: 'Đang có một lượt đăng nhập OAuth khác chạy.' };
  }
  const resolvedClientId =
    (typeof clientId === 'string' && clientId.trim()) ||
    vault.getSecret('oauth-client', providerId) ||
    (resolvedConnectorId !== null ? vault.getSecret('oauth-client', resolvedConnectorId) : null) ||
    null;
  const resolvedClientSecret =
    (typeof clientSecret === 'string' && clientSecret.trim()) ||
    vault.getSecret('oauth-client', `${providerId}-secret`) ||
    (resolvedConnectorId !== null ? vault.getSecret('oauth-client', `${resolvedConnectorId}-secret`) : undefined) ||
    undefined;
  if (!resolvedClientId) {
    return {
      ok: false,
      providerId,
      error:
        'Chưa có OAuth client id cho provider này. ' +
        (provider.clientSetupHint ??
          'Tạo một OAuth client rồi nhập client id (và client secret) ở mục Đăng nhập.'),
    };
  }
  // Lưu client id/secret người dùng vừa nhập để lần sau không nhập lại —
  // dưới key provider và (khi khác) key connector, để coordinator
  // refresh token connector được (connectorClientConfigs đọc theo key
  // connector).
  if (typeof clientId === 'string' && clientId.trim()) {
    vault.setSecret('oauth-client', providerId, clientId.trim());
    if (resolvedConnectorId !== null && resolvedConnectorId !== providerId) {
      vault.setSecret('oauth-client', resolvedConnectorId, clientId.trim());
    }
  }
  if (typeof clientSecret === 'string' && clientSecret.trim()) {
    vault.setSecret('oauth-client', `${providerId}-secret`, clientSecret.trim());
    if (resolvedConnectorId !== null && resolvedConnectorId !== providerId) {
      vault.setSecret('oauth-client', `${resolvedConnectorId}-secret`, clientSecret.trim());
    }
  }
  oauthLoginInFlight = true;
  try {
    const state = newOAuthState();
    const callbackServer = createOAuthCallbackServer({
      state,
      ...(provider.callbackPort !== undefined ? { port: provider.callbackPort } : {}),
    });
    const redirectUri = await callbackServer.whenReady();
    const authUrl = buildAuthUrl(provider, {
      clientId: resolvedClientId,
      redirectUri,
      state,
      ...(scopesOverride ? { scopesOverride } : {}),
    });
    await shell.openExternal(authUrl);
    const code = await callbackServer.waitForCode();
    const tokens = await exchangeCodeForTokens({
      tokenUrl: provider.tokenUrl,
      code,
      redirectUri,
      clientId: resolvedClientId,
      clientSecret: resolvedClientSecret,
    });
    if (tokens.refreshToken) {
      vault.setSecret('oauth-refresh', providerId, tokens.refreshToken);
    }
    // Connector wiring (W11b): persist the full TokenSet where the
    // connector tools read it — Vault 'connector'/<connectorId>.
    // Coordinator seeds its in-memory sets from there at createBot
    // and auto-refreshes via getConnectorTokenProvider; a refreshed
    // set comes back through the 'connector.oauth-token' event.
    // Slack tokens without rotation carry no refresh token / expiry:
    // stored without expiresAt, the framework uses them as-is.
    if (resolvedConnectorId !== null && tokens.accessToken) {
      const tokenSet: TokenSet = {
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        ...(tokens.expiresIn !== undefined
          ? { expiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString() }
          : {}),
        ...(tokens.tokenType ? { tokenType: tokens.tokenType } : {}),
        scope: (scopesOverride ?? provider.scopes).join(' '),
      };
      vault.setSecret('connector', resolvedConnectorId, JSON.stringify(tokenSet));
    }
    // Best-effort: lấy tên/email hiển thị cho identity.
    let displayName: string | undefined;
    let email: string | undefined;
    let subject = providerId;
    if (provider.userinfoUrl && tokens.accessToken) {
      try {
        const res = await fetch(provider.userinfoUrl, {
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        });
        if (res.ok) {
          const info = (await res.json()) as Record<string, unknown>;
          subject = pickUserinfoField(info, provider.userinfoFields?.id, 'sub') ?? subject;
          displayName = pickUserinfoField(info, provider.userinfoFields?.name, 'name');
          email = pickUserinfoField(info, provider.userinfoFields?.email, 'email');
        }
      } catch {
        // Userinfo lỗi: login vẫn thành công, identity dùng id mặc định.
      }
    }
    const identity = setProviderIdentity(vault, providerId, {
      id: subject,
      displayName,
      email,
    });
    // The connector's own identity row (used by
    // 'auth:identities-list' to report connector status): for
    // microsoft -> 'teams' and google -> 'gmail' this differs from
    // the provider id, so store it under the connector id as well.
    if (resolvedConnectorId !== null && resolvedConnectorId !== providerId) {
      setProviderIdentity(vault, resolvedConnectorId, {
        id: subject,
        displayName,
        email,
      });
    }
    return { ok: true, providerId, displayName: identity.displayName };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Đăng nhập OAuth thất bại.';
    return { ok: false, providerId, error: redactBearer(message) };
  } finally {
    oauthLoginInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// v0.10: Run tracing store (JSONL, read-only from main)
// ---------------------------------------------------------------------------

/** Lazily opened TraceStore on `<userData>/traces.jsonl` (see TRACES_FILE). */
let traceStore: TraceStore | null = null;

function getTraceStore(): TraceStore {
  if (!traceStore) {
    traceStore = new TraceStore({ filePath: path.join(app.getPath('userData'), TRACES_FILE) });
  }
  return traceStore;
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle('bots:list', () => settings.bots);

  ipcMain.handle('bots:create', (_event: unknown, config: Partial<BotConfig>) => {
    // v0.7: validate đầu vào — tên/model/workspace đều có giới hạn,
    // workspaceDir phải nằm trong thư mục cho phép (resolveWithin).
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('Tham số bots:create phải là object.');
    }
    const providerId = config.providerId ?? 'xai';
    if (!isKnownProvider(providerId)) throw new Error(`Không rõ provider id: ${providerId}.`);
    if (!isProviderAllowed(activePolicy, providerId)) {
      throw new Error(`Provider "${providerId}" không được phép theo policy của máy.`);
    }
    // v0.90b (đội G): nguồn tắt theo bot — chỉ giữ id provider đã
    // biết; rỗng = không tắt gì (không lưu field).
    const disabledProviders = cleanDisabledProviders(
      config.disabledProviders,
      PROVIDERS.map((p) => p.id),
    );
    const bot: BotConfig = {
      id: randomUUID(),
      name: optionalString(config.name, 'name') || 'Bot mới',
      providerId,
      // v0.5: model mặc định lấy từ registry; settings chỉ là fallback
      // khi registry trả '' (openai-compatible chưa chọn preset).
      model:
        optionalString(config.model, 'model') ??
        (defaultModelFor(config.providerId ?? 'xai') ||
          settings.providers[config.providerId ?? 'xai']?.defaultModel) ??
        '',
      systemPrompt: optionalString(config.systemPrompt, 'systemPrompt', 50_000) ?? '',
      workspaceDir: validateWorkspaceDir(config.workspaceDir, workspaceRoots()),
      autoApprove: config.autoApprove ?? false,
      // v0.50 (M8): mức approval riêng của bot — giá trị lạ thì về mặc định.
      approvalLevel: isBotApprovalLevel(config.approvalLevel) ? config.approvalLevel : 'ask-for-writes',
      // v0.20 (W14a): small-model guard defaults to on for new bots.
      smallModelGuard: config.smallModelGuard ?? true,
      // v0.96 (Đội T2): repo map defaults to on for new bots.
      repoMapEnabled: config.repoMapEnabled ?? true,
      ...(typeof config.repoMapTokenBudget === 'number' && Number.isFinite(config.repoMapTokenBudget) && config.repoMapTokenBudget > 0
        ? { repoMapTokenBudget: Math.floor(config.repoMapTokenBudget) }
        : {}),
      // v0.62 (UI-13): display colour — any short string is stored;
      // the renderer only ever sends a palette hex and falls back to
      // the default colour for unknown values.
      color: optionalString(config.color, 'color', 32) ?? undefined,
      // v0.77 (UI parity §3.3): short description — shown under the
      // bot name in the sidebar; capped, empty = not shown.
      description:
        optionalString(config.description, 'description', BOT_DESCRIPTION_MAX_LENGTH) ?? undefined,
      ...(disabledProviders.length > 0 ? { disabledProviders } : {}),
    };
    settings.bots.push(bot);
    saveSettings();
    watchWorkspaceFor(bot);
    // v0.61 (UI-10 fix): broadcast so the renderer reloads the bot list.
    // Before this, only an agent creating a bot (coordinator
    // `agent.created`, line ~1710) sent `bots:changed` — a bot created
    // through this IPC stayed invisible in the UI until the next reload
    // (the UI-6/UI-8 and UI-1/UI-2 smokes create bots via IPC; with no
    // silent default bot any more, the app sat on onboarding forever).
    // App.saveBot already updates local state, so for the normal path
    // this just re-loads the same list — harmless.
    sendToRenderer('bots:changed', { botId: bot.id });
    return bot;
  });

  ipcMain.handle('bots:update', (_event: unknown, config: BotConfig) => {
    if (config === null || typeof config !== 'object') throw new Error('Tham số bots:update phải là object.');
    const id = requireId(config.id, 'id');
    if (config.name !== undefined) requireString(config.name, 'name');
    if (config.providerId !== undefined && !isKnownProvider(config.providerId)) {
      throw new Error(`Không rõ provider id: ${config.providerId}.`);
    }
    if (config.workspaceDir !== undefined && config.workspaceDir !== '') {
      validateWorkspaceDir(config.workspaceDir, workspaceRoots());
    }
    // v0.77 (UI parity §3.3): description — trim + cap như lúc tạo
    // (bots:create); chuỗi rỗng / không phải chuỗi = xoá mô tả.
    if (config.description !== undefined) {
      config.description =
        typeof config.description === 'string'
          ? config.description.trim().slice(0, BOT_DESCRIPTION_MAX_LENGTH) || undefined
          : undefined;
    }
    const idx = settings.bots.findIndex((b) => b.id === id);
    if (idx === -1) throw new Error('Không tìm thấy bot.');
    if (!teamAllowsEdit(id)) {
      throw new Error('Bạn không có quyền sửa bot này theo phân quyền team.');
    }
    // v0.64 (skills per-bot): `denySkills` gửi kèm phải là mảng chuỗi
    // và chỉ giữ tên skill có trong registry — tên lạ / phần tử không
    // phải chuỗi thì bỏ qua + ghi log cảnh báo, KHÔNG throw cả lệnh
    // (xem `sanitizeDenySkills` trong core). Tên đã lưu sẵn của bot
    // vẫn được giữ (skill của bundle chỉ coordinator biết — registry
    // của main không thấy — nên đừng xoá chúng khi sửa bot).
    if (config.denySkills !== undefined) {
      const knownNames = [
        ...getSkillRegistry().list().map((s) => s.name),
        ...(settings.bots[idx].denySkills ?? []),
      ];
      const { kept, dropped } = sanitizeDenySkills(config.denySkills, knownNames);
      if (dropped.length > 0) {
        console.warn(
          `[bots:update] Bỏ ${dropped.length} tên skill lạ khỏi denySkills của bot "${id}": ${dropped.join(', ')}`,
        );
      }
      config.denySkills = kept;
    }
    // v0.90b (đội G): `disabledProviders` gửi kèm chỉ giữ id provider
    // đã biết — id lạ / phần tử không phải chuỗi thì bỏ qua + ghi log
    // cảnh báo, KHÔNG throw cả lệnh (như sanitizeDenySkills ở trên).
    // Gửi [] = bật lại hết (xoá danh sách đã lưu).
    if (config.disabledProviders !== undefined) {
      const knownIds = PROVIDERS.map((p) => p.id);
      const kept = cleanDisabledProviders(config.disabledProviders, knownIds);
      if (Array.isArray(config.disabledProviders) && kept.length < config.disabledProviders.length) {
        const dropped = config.disabledProviders.filter(
          (v): v is string => typeof v !== 'string' || !knownIds.includes(v),
        );
        console.warn(
          `[bots:update] Bỏ ${dropped.length} provider lạ khỏi disabledProviders của bot "${id}": ${dropped.join(', ')}`,
        );
      }
      config.disabledProviders = kept;
    }
    settings.bots[idx] = { ...settings.bots[idx], ...config, id };
    saveSettings();
    void invalidateRuntime(id);
    return settings.bots[idx];
  });

  // M4: đổi model của bot giữa chừng, không mất thread (IPC
  // `bots:switch-model`). Thứ tự: providerConfigFor kiểm tra engine
  // bật + đăng nhập (fail-closed, lý do rõ) → coordinator.switchModel
  // đổi provider tại chỗ (hoặc ghi chờ nếu đang chạy) → chỉ khi đó
  // mới lưu settings. Bot chưa từng chạy (chưa có runtime) thì chỉ
  // lưu settings, lần chạy sau dùng model mới. Lịch sử chat, task,
  // plan, checkpoint nằm trong BotMemory nên không mất.
  ipcMain.handle(
    'bots:switch-model',
    async (
      _event: unknown,
      payload: { botId: string; providerId: string; model: string },
    ): Promise<{
      bot: BotConfig;
      providerId: string;
      model: string;
      applied: boolean;
      pending: boolean;
      running: boolean;
    }> => {
      const botId = requireId(payload?.botId, 'botId');
      const providerId = requireId(payload?.providerId, 'providerId');
      const model = requireString(payload?.model, 'model');
      if (!isKnownProvider(providerId)) throw new Error(`Không rõ provider id: ${providerId}.`);
      if (!isProviderAllowed(activePolicy, providerId)) {
        throw new Error(`Provider "${providerId}" không được phép theo policy của máy.`);
      }
      const idx = settings.bots.findIndex((b) => b.id === botId);
      if (idx === -1) throw new Error('Không tìm thấy bot.');
      if (!teamAllowsEdit(botId)) {
        throw new Error('Bạn không có quyền sửa bot này theo phân quyền team.');
      }
      // v0.90b (đội G): không cho đổi SANG provider đã tắt riêng cho
      // bot này — user phải bật lại nguồn trong phần Nguồn của bot
      // trước (picker không tự đổi model lén, và switch cũng không).
      if ((settings.bots[idx].disabledProviders ?? []).includes(providerId)) {
        throw new Error(
          `Provider "${providerId}" đã bị tắt riêng cho bot này — bật lại trong phần Nguồn của bot (mở Sửa bot) rồi đổi model.`,
        );
      }
      const providerConfig = await providerConfigFor(providerId, model);
      let switched = { applied: true, pending: false, running: false };
      if (runtimes.has(botId)) {
        switched = await getCoordinator().switchModel({
          botId,
          provider: providerConfig,
          usageStorePath: path.join(app.getPath('userData'), USAGE_FILE),
        });
      }
      const updated: BotConfig = { ...settings.bots[idx], providerId, model };
      settings.bots[idx] = updated;
      saveSettings();
      const runtime = runtimes.get(botId);
      if (runtime) runtime.bot = updated;
      return {
        bot: updated,
        providerId,
        model,
        applied: switched.applied,
        pending: switched.pending,
        running: switched.running,
      };
    },
  );

  ipcMain.handle('bots:delete', async (_event: unknown, botId: string) => {
    const id = requireId(botId, 'botId');
    if (!teamAllowsEdit(id)) {
      throw new Error('Bạn không có quyền xoá bot này theo phân quyền team.');
    }
    const bot = settings.bots.find((b) => b.id === id);
    settings.bots = settings.bots.filter((b) => b.id !== id);
    await invalidateRuntime(id);
    fileWatchers.get(id)?.close();
    fileWatchers.delete(id);
    // v0.56: xoá bot thì dọn luôn voice session (ngắt gọi + quên surfaces).
    voiceSessions.get(id)?.dispose();
    voiceSessions.delete(id);
    // Fix v0.59 leftover (b): xoá bot thì xoá luôn thread + message +
    // mọi dòng BotMemory của bot đó (tasks, goals, checkpoints, …) —
    // trước đây chỉ gỡ khỏi settings nên history vẫn nằm trong
    // memory.db và bot tạo lại cùng workspace sẽ thấy lại. Chạy SAU
    // invalidateRuntime (đã đóng handle của coordinator) và best-effort:
    // coordinator chết thì lần deleteBotData sau vẫn xoá được vì nó mở
    // DB mới theo workspaceDir, không cần entry đang chạy.
    if (bot) {
      try {
        await getCoordinator().deleteBotData({ botId: id, workspaceDir: workspaceDirFor(bot) });
      } catch {
        // Best-effort — settings đã gỡ, bot không còn trong UI.
      }
    }
    saveSettings();
    // v0.61: same broadcast as `bots:create` — the bot list changed, so
    // any view holding it (renderer, second window) reloads instead of
    // showing a deleted bot until restart.
    sendToRenderer('bots:changed', { botId: id });
    return true;
  });

  // v0.59 (UI-3): duyệt tool theo bot — màn Tools riêng.
  // `tools:list` liệt kê tool của bot qua coordinator RPC
  // `listBotTools` (registry + filter/cap đã có, xem
  // packages/core/src/coordinator/coordinator.ts). Bot chưa từng chạy
  // thì `getOrCreateRuntime` tạo runtime trước — giống `chat:history`.
  // `tools:toggle` bật/tắt một tool bằng đúng cơ chế filter đã có:
  // ghi `denyTools` vào BotConfig (persist settings.json) + gọi RPC
  // `setBotToolEnabled` khi bot đang chạy. Bot chưa chạy thì chỉ lưu
  // settings — lần tạo runtime sau `createBot` đăng ký denyTools vào
  // policy (xem coordinator `createBot` / `createAgentBot`).
  // Không tạo cơ chế bật/tắt song song; không invalidate runtime (đổi
  // policy có hiệu lực ngay cho turn sau, không cần tạo lại bot).
  ipcMain.handle('tools:list', async (_event: unknown, payload: { botId: string }) => {
    const botId = requireId(payload?.botId, 'botId');
    const bot = settings.bots.find((b) => b.id === botId);
    if (!bot) throw new Error('Không tìm thấy bot.');
    await getOrCreateRuntime(bot);
    return getCoordinator().listBotTools(botId);
  });

  // v0.95 (Team D1): Internet data — RSS/Atom feeds + watched pages.
  // State sống trong `<userData>/internet-data.json`, cùng file mà
  // tool `feed_*` / `watch_*` trong coordinator dùng (xem
  // packages/tools/src/internetData.ts). Main tự fetch trực tiếp ở
  // đây (SSRF guard + timeout + 1 MB cap trong fetchFeed /
  // checkWatches) nên nút "Kiểm tra ngay" của UI không cần bot đang
  // chạy; tool trong agent vẫn là đường chính khi bot chạy.
  function getInternetDataStore(): InternetDataStore {
    return new InternetDataStore(path.join(app.getPath('userData'), INTERNET_DATA_FILE));
  }

  function requireHttpUrl(raw: unknown, field: string): string {
    const value = requireString(raw, field);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`URL không hợp lệ: "${value}"`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Chỉ cho phép URL http:// và https://.');
    }
    return url.toString();
  }

  ipcMain.handle('internet-data:get', () => {
    return getInternetDataStore().snapshot();
  });

  ipcMain.handle(
    'internet-data:subscribe',
    async (_event: unknown, payload: { url?: unknown; title?: unknown }) => {
      const url = requireHttpUrl(payload?.url, 'url');
      const title =
        typeof payload?.title === 'string' && payload.title.trim() !== ''
          ? payload.title.trim()
          : undefined;
      const parsed = await fetchFeed(url);
      const store = getInternetDataStore();
      const { feed, added } = store.addFeed(url, title ?? parsed.title ?? url, Date.now());
      store.markFeedChecked(feed.id, Date.now(), parsed.items.length);
      return { state: store.snapshot(), added, itemCount: parsed.items.length };
    },
  );

  ipcMain.handle(
    'internet-data:unsubscribe',
    (_event: unknown, payload: { feed?: unknown }) => {
      const key = requireString(payload?.feed, 'feed');
      const store = getInternetDataStore();
      if (!store.removeFeed(key)) throw new Error(`Không có feed nào khớp "${key}".`);
      return store.snapshot();
    },
  );

  ipcMain.handle(
    'internet-data:feed-read',
    async (_event: unknown, payload: { feed?: unknown; limit?: unknown }) => {
      const key = requireString(payload?.feed, 'feed');
      const store = getInternetDataStore();
      const feed = store.findFeed(key);
      if (!feed) throw new Error(`Không có feed nào khớp "${key}".`);
      const parsed = await fetchFeed(feed.url);
      store.markFeedChecked(feed.id, Date.now(), parsed.items.length);
      const limit =
        typeof payload?.limit === 'number' && Number.isFinite(payload.limit)
          ? Math.max(1, Math.min(50, Math.floor(payload.limit)))
          : 10;
      return { feed, title: parsed.title || feed.title, items: parsed.items.slice(0, limit) };
    },
  );

  ipcMain.handle(
    'internet-data:watch-add',
    (_event: unknown, payload: { url?: unknown; intervalMinutes?: unknown }) => {
      const url = requireHttpUrl(payload?.url, 'url');
      const interval =
        typeof payload?.intervalMinutes === 'number' && Number.isFinite(payload.intervalMinutes)
          ? Math.max(5, Math.min(1440, Math.floor(payload.intervalMinutes)))
          : 60;
      const store = getInternetDataStore();
      const { watch, added } = store.addWatch(url, interval, Date.now());
      return { state: store.snapshot(), added, watch };
    },
  );

  ipcMain.handle(
    'internet-data:watch-remove',
    (_event: unknown, payload: { watch?: unknown }) => {
      const key = requireString(payload?.watch, 'watch');
      const store = getInternetDataStore();
      if (!store.removeWatch(key)) throw new Error(`Không có trang nào khớp "${key}".`);
      return store.snapshot();
    },
  );

  ipcMain.handle(
    'internet-data:check',
    async (_event: unknown, payload: { watch?: unknown }) => {
      const store = getInternetDataStore();
      const key =
        typeof payload?.watch === 'string' && payload.watch.trim() !== ''
          ? payload.watch.trim()
          : undefined;
      let onlyId: string | undefined;
      if (key) {
        const found = store.findWatch(key);
        if (!found) throw new Error(`Không có trang nào khớp "${key}".`);
        onlyId = found.id;
      }
      const events = await checkWatches(store, {
        onWatchChanged: (event) => {
          // UI-triggered check: không có bot chạy nên botId rỗng —
          // notification lấy tên fallback 'open-bot'.
          sendToRenderer('internet:watch-changed', {
            botId: '',
            url: event.watch.url,
            summary: event.summary,
            checkedAt: event.checkedAt,
          });
          notifyBotEvent('watch-change', '', {
            url: event.watch.url,
            dedupeKey: `watch-change:${event.watch.url}`,
          });
        },
      }, onlyId);
      return { state: store.snapshot(), events };
    },
  );

  // v0.60 (UI-6): slash commands của bot cho popup autocomplete.
  // `slash:list` liệt kê lệnh từ đúng registry mà coordinator dùng để
  // resolve lệnh khi chạy (`<workspace>/.open-bot/commands/*.md` +
  // bundle commands — xem coordinator `listSlashCommands`). Bot chưa
  // từng chạy thì `getOrCreateRuntime` tạo runtime trước — giống
  // `tools:list`. Trả mảng rỗng khi bot không có lệnh nào; bot lạ thì
  // lỗi (renderer bắt lỗi và hiện hint "chưa có lệnh slash").
  ipcMain.handle('slash:list', async (_event: unknown, payload: { botId: string }) => {
    const botId = requireId(payload?.botId, 'botId');
    const bot = settings.bots.find((b) => b.id === botId);
    if (!bot) throw new Error('Không tìm thấy bot.');
    await getOrCreateRuntime(bot);
    return getCoordinator().listSlashCommands(botId);
  });

  ipcMain.handle(
    'tools:toggle',
    async (
      _event: unknown,
      payload: { botId: string; toolName: string; enabled: boolean },
    ) => {
      const botId = requireId(payload?.botId, 'botId');
      const toolName = requireString(payload?.toolName, 'toolName');
      const enabled = requireBoolean(payload?.enabled, 'enabled');
      const idx = settings.bots.findIndex((b) => b.id === botId);
      if (idx === -1) throw new Error('Không tìm thấy bot.');
      if (!teamAllowsEdit(botId)) {
        throw new Error('Bạn không có quyền sửa bot này theo phân quyền team.');
      }
      // Bot đang chạy: validate tool tồn tại + áp policy live TRƯỚC,
      // chỉ persist khi RPC thành công (tool lạ thì không lưu gì).
      if (runtimes.has(botId)) {
        const result = await getCoordinator().setBotToolEnabled(botId, toolName, enabled);
        settings.bots[idx] = { ...settings.bots[idx], denyTools: result.denyTools };
        saveSettings();
        return result;
      }
      const current = [...(settings.bots[idx].denyTools ?? [])];
      const denyTools = enabled
        ? current.filter((t) => t !== toolName)
        : current.includes(toolName)
          ? current
          : [...current, toolName];
      settings.bots[idx] = { ...settings.bots[idx], denyTools };
      saveSettings();
      return { botId, toolName, enabled, denyTools };
    },
  );

  // v0.64 (skills per-bot): duyệt skill theo bot — màn Tools riêng.
  // `bot-skills:list` liệt kê skill của bot qua coordinator RPC
  // `listBotSkills` (registry dùng chung + filter denySkills của bot,
  // xem packages/core/src/coordinator/coordinator.ts). Bot chưa từng
  // chạy thì `getOrCreateRuntime` tạo runtime trước — giống
  // `tools:list`. `bot-skills:toggle` bật/tắt một skill bằng đúng cơ
  // chế filter đã có: ghi `denySkills` vào BotConfig (persist
  // settings.json) + gọi RPC `setBotSkillEnabled` khi bot đang chạy.
  // Bot chưa chạy thì chỉ lưu settings — lần tạo runtime sau
  // `createBot` đăng ký denySkills vào policy. Không tạo cơ chế
  // bật/tắt song song; không invalidate runtime (đổi policy có hiệu
  // lực ngay cho turn sau, không cần tạo lại bot). Khác
  // `skills:toggle` toàn cục (Settings → Skills): toggle này chỉ ảnh
  // hưởng đúng bot này, registry dùng chung không đổi.
  ipcMain.handle('bot-skills:list', async (_event: unknown, payload: { botId: string }) => {
    const botId = requireId(payload?.botId, 'botId');
    const bot = settings.bots.find((b) => b.id === botId);
    if (!bot) throw new Error('Không tìm thấy bot.');
    await getOrCreateRuntime(bot);
    return getCoordinator().listBotSkills(botId);
  });

  ipcMain.handle(
    'bot-skills:toggle',
    async (
      _event: unknown,
      payload: { botId: string; skillName: string; enabled: boolean },
    ) => {
      const botId = requireId(payload?.botId, 'botId');
      const skillName = requireString(payload?.skillName, 'skillName');
      const enabled = requireBoolean(payload?.enabled, 'enabled');
      const idx = settings.bots.findIndex((b) => b.id === botId);
      if (idx === -1) throw new Error('Không tìm thấy bot.');
      if (!teamAllowsEdit(botId)) {
        throw new Error('Bạn không có quyền sửa bot này theo phân quyền team.');
      }
      // Bot đang chạy: validate skill tồn tại + áp policy live TRƯỚC,
      // chỉ persist khi RPC thành công (skill lạ thì không lưu gì).
      if (runtimes.has(botId)) {
        const result = await getCoordinator().setBotSkillEnabled(botId, skillName, enabled);
        settings.bots[idx] = { ...settings.bots[idx], denySkills: result.denySkills };
        saveSettings();
        return result;
      }
      const current = [...(settings.bots[idx].denySkills ?? [])];
      const denySkills = enabled
        ? current.filter((s) => s !== skillName)
        : current.includes(skillName)
          ? current
          : [...current, skillName];
      settings.bots[idx] = { ...settings.bots[idx], denySkills };
      saveSettings();
      return { botId, skillName, enabled, denySkills };
    },
  );

  // --- v0.3: agent templates + local marketplace (clone / publish / install) ---
  // Clone tạo bot mới với id + workspace riêng nên runtime của bot gốc
  // không bị ảnh hưởng; publish không sửa bot nên cũng không cần invalidate.

  ipcMain.handle('agents:clone', (_event: unknown, payload: { botId: string; name?: string }) => {
    const botId = requireId(payload?.botId, 'botId');
    const bot = settings.bots.find((b) => b.id === botId);
    if (!bot) throw new Error('Không tìm thấy bot.');
    const cloned = cloneAgent(bot, optionalString(payload?.name, 'name') || `${bot.name} (bản sao)`);
    settings.bots.push(cloned);
    saveSettings();
    watchWorkspaceFor(cloned);
    return cloned;
  });

  ipcMain.handle(
    'agents:publish',
    (_event: unknown, payload: { botId: string; description?: string; author?: string }) => {
      const botId = requireId(payload?.botId, 'botId');
      const bot = settings.bots.find((b) => b.id === botId);
      if (!bot) throw new Error('Không tìm thấy bot.');
      return publishAgent(app.getPath('userData'), bot, {
        description: optionalString(payload?.description, 'description', 2000) ?? '',
        author: optionalString(payload?.author, 'author') ?? 'local',
      });
    },
  );

  ipcMain.handle('templates:list', () => listBuiltInTemplates());

  ipcMain.handle('marketplace:list', () => listPublished(app.getPath('userData')));

  ipcMain.handle('marketplace:install', (_event: unknown, payload: { id: string }) => {
    const id = requireId(payload?.id, 'id');
    const bot = installPublished(app.getPath('userData'), id);
    settings.bots.push(bot);
    saveSettings();
    watchWorkspaceFor(bot);
    return bot;
  });

  ipcMain.handle('marketplace:uninstall', (_event: unknown, payload: { id: string }) => {
    return uninstallPublished(app.getPath('userData'), requireId(payload?.id, 'id'));
  });

  // --- v0.3: MCP marketplace (local catalogue -> workspace mcp.json) ---
  // Install/uninstall đổi tool của bot nên runtime cũ phải bỏ để lần
  // chạy sau nạp lại tool MCP mới.
  ipcMain.handle('mcp-marketplace:list', () => listMcpAvailable(app.getPath('userData')));

  // v0.67a: session cache for marketplace tool probes, keyed by server
  // id + registry fingerprint (v0.68a: `MarketplaceProbeCache` in core).
  // Only 'ok' and 'needs-key' results are cached (both are stable
  // while the catalogue is unchanged); 'error' results are NOT cached
  // so the user can retry after fixing the server. When the user edits
  // the catalogue (marketplace/mcp-servers.json) between probes, the
  // fingerprint changes and the stale entry is a miss — it is never
  // served again. When the registry cannot be read (fingerprint
  // null), the cache is bypassed entirely and the probe surfaces the
  // real error. Probing is on demand only — one server per user click,
  // never the whole catalogue at once.
  const mcpMarketplaceToolsCache = new MarketplaceProbeCache();

  ipcMain.handle('mcp-marketplace:tools', async (_event: unknown, payload: { id: string }) => {
    const id = requireId(payload?.id, 'id');
    const fingerprint = getMarketplaceRegistryFingerprint(app.getPath('userData'));
    if (fingerprint !== null) {
      const cached = mcpMarketplaceToolsCache.get(id, fingerprint);
      if (cached) return cached;
    }
    const result = await probeMarketplaceServerTools(id, app.getPath('userData'));
    if (fingerprint !== null) mcpMarketplaceToolsCache.set(id, fingerprint, result);
    return result;
  });

  ipcMain.handle('mcp-marketplace:installed', (_event: unknown, payload: { botId: string }) => {
    const botId = requireId(payload?.botId, 'botId');
    const bot = settings.bots.find((b) => b.id === botId);
    if (!bot) throw new Error('Không tìm thấy bot.');
    return listMcpInstalled(workspaceDirFor(bot));
  });

  ipcMain.handle(
    'mcp-marketplace:install',
    (
      _event: unknown,
      payload: { id: string; botId: string; args?: unknown; entry?: unknown; version?: unknown },
    ) => {
      const id = requireId(payload?.id, 'id');
      const botId = requireId(payload?.botId, 'botId');
      const bot = settings.bots.find((b) => b.id === botId);
      if (!bot) throw new Error('Không tìm thấy bot.');
      // v0.84e: install-time args override from the marketplace form
      // (one arg per line in the UI). Env/headers are still never
      // written here — credentials stay the user's job in mcp.json
      // (see buildServerConfig in packages/core/src/mcp/marketplace.ts).
      const args = requireStringArray(payload?.args, 'args');
      // v0.89a (Marketplace v2): every marketplace install needs a
      // recorded approval first (the UI records it via
      // `mcp-marketplace:approve` after the user confirms). A remote
      // entry from the renderer is re-validated here — never trusted
      // as-is — and installed via the versioned path.
      const version =
        payload?.version === undefined ? undefined : requireString(payload.version, 'version');
      requireMarketplaceApproval(app.getPath('userData'), 'mcp-install', id, version);
      if (payload?.entry !== undefined && payload.entry !== null) {
        const entry: VersionedMarketplaceServer = validateVersionedMarketplaceServer(payload.entry);
        if (entry.id !== id) throw new Error('Entry trong payload không khớp với "id".');
        const result = installMcpServerVersion(id, workspaceDirFor(bot), version, {
          baseDir: app.getPath('userData'),
          catalog: [entry],
          appVersion: app.getVersion(),
          ...(args === undefined ? {} : { overrides: { args } }),
        });
        void invalidateRuntime(bot.id);
        return result;
      }
      // Local-registry install, versioned (records the installed
      // version in mcp.json + the sidecar; plain v0.3 install would
      // not record any version).
      const result = installMcpServerVersion(id, workspaceDirFor(bot), version, {
        baseDir: app.getPath('userData'),
        appVersion: app.getVersion(),
        ...(args === undefined ? {} : { overrides: { args } }),
      });
      void invalidateRuntime(bot.id);
      return result;
    },
  );

  ipcMain.handle(
    'mcp-marketplace:uninstall',
    (_event: unknown, payload: { id: string; botId: string }) => {
      const id = requireId(payload?.id, 'id');
      const botId = requireId(payload?.botId, 'botId');
      const bot = settings.bots.find((b) => b.id === botId);
      if (!bot) throw new Error('Không tìm thấy bot.');
      const removed = uninstallMcpServer(id, workspaceDirFor(bot));
      void invalidateRuntime(bot.id);
      return removed;
    },
  );

  // --- v0.89a (worker F1 — Marketplace v2): search / versions / remote
  // catalog / approvals (MCP) + plugin marketplace. Install/update đều
  // cần approval đã ghi (xem `mcp-marketplace:approve`): handler nào
  // thiếu approval sẽ throw trước khi ghi bất cứ thứ gì.
  ipcMain.handle(
    'mcp-marketplace:search',
    (_event: unknown, payload: { query?: unknown; tag?: unknown }) => {
      const query = optionalString(payload?.query, 'query') ?? '';
      const tag = optionalString(payload?.tag, 'tag') ?? 'all';
      return searchMarketplaceServers(
        loadVersionedRegistry(app.getPath('userData')),
        query,
        tag,
      );
    },
  );

  ipcMain.handle(
    'mcp-marketplace:check-updates',
    (_event: unknown, payload: { botId: string }) => {
      const botId = requireId(payload?.botId, 'botId');
      const bot = settings.bots.find((b) => b.id === botId);
      if (!bot) throw new Error('Không tìm thấy bot.');
      return checkMcpUpdates(workspaceDirFor(bot), {
        baseDir: app.getPath('userData'),
        appVersion: app.getVersion(),
      });
    },
  );

  ipcMain.handle(
    'mcp-marketplace:update',
    (_event: unknown, payload: { id: string; botId: string; version?: unknown }) => {
      const id = requireId(payload?.id, 'id');
      const botId = requireId(payload?.botId, 'botId');
      const bot = settings.bots.find((b) => b.id === botId);
      if (!bot) throw new Error('Không tìm thấy bot.');
      const version =
        payload?.version === undefined ? undefined : requireString(payload.version, 'version');
      requireMarketplaceApproval(app.getPath('userData'), 'mcp-update', id, version);
      const result = updateMcpServer(id, workspaceDirFor(bot), {
        baseDir: app.getPath('userData'),
        appVersion: app.getVersion(),
      });
      void invalidateRuntime(bot.id);
      return result;
    },
  );

  ipcMain.handle(
    'mcp-marketplace:remote-catalog',
    async (_event: unknown, payload: { url: string }) => {
      const url = requireString(payload?.url, 'url');
      // Allowlist + https-only + timeout + schema validation đều chạy
      // trong core (marketplaceRemote.ts); main chỉ chuyển URL qua.
      return fetchRemoteMarketplaceCatalog(url, { baseDir: app.getPath('userData') });
    },
  );

  ipcMain.handle(
    'mcp-marketplace:approve',
    (
      _event: unknown,
      payload: { kind: unknown; targetId: unknown; version?: unknown; source?: unknown; note?: unknown },
    ) => {
      // kind/targetId được validate trong core (recordMarketplaceApproval
      // throw khi sai); version/source/note là chuỗi tùy chọn.
      return recordMarketplaceApproval(app.getPath('userData'), {
        kind: payload?.kind as MarketplaceApprovalKind,
        targetId: payload?.targetId as string,
        ...(payload?.version === undefined
          ? {}
          : { version: requireString(payload.version, 'version') }),
        ...(payload?.source === undefined
          ? {}
          : { source: requireString(payload.source, 'source') }),
        ...(payload?.note === undefined
          ? {}
          : { note: optionalString(payload.note, 'note') ?? undefined }),
      });
    },
  );

  ipcMain.handle('mcp-marketplace:approvals', () =>
    listMarketplaceApprovals(app.getPath('userData')),
  );

  // --- v0.89a (worker F1): plugin marketplace. Install/update chạy qua
  // staging: `prepare` chỉ tải/chuẩn bị (chưa cài), UI hiện manifest rồi
  // người dùng phê duyệt (`mcp-marketplace:approve` với kind
  // plugin-install/plugin-update), sau đó `install`/`update` mới cài
  // từ staging (secret scan + loader validation chạy trong tools).
  const pluginInstallStaging = new Map<string, PreparedPlugin>();

  function requirePluginMarketplaceSource(payload: unknown): {
    kind: 'local' | 'url' | 'git';
    url?: string;
    path?: string;
  } {
    if (payload === null || typeof payload !== 'object') {
      throw new Error('Tham số "source" phải là object.');
    }
    const raw = payload as Record<string, unknown>;
    const kind = raw['kind'];
    if (kind !== 'local' && kind !== 'url' && kind !== 'git') {
      throw new Error('source.kind phải là "local", "url" hoặc "git".');
    }
    if (kind === 'local') return { kind, path: requireString(raw['path'], 'path') };
    return { kind, url: requireString(raw['url'], 'url') };
  }

  function pluginsDirForMarketplace(): string {
    return path.join(app.getPath('userData'), 'plugins');
  }

  ipcMain.handle('plugin-marketplace:list', () => {
    return listMarketplacePlugins(pluginsDirForMarketplace()).map((p) => ({
      id: p.manifest.id,
      name: p.manifest.name,
      description: p.manifest.description,
      version: p.version,
      author: p.manifest.author ?? null,
      enabled: p.enabled,
      tools: p.loadedTools,
      source: p.source ?? null,
      sandboxed: p.sandboxed,
      installedAt: p.installedAt ?? null,
      // v0.93a: signature status (from the install record) + the
      // version a downgrade would restore to (null when none).
      signatureStatus: p.signatureStatus ?? null,
      signatureKeyId: p.signatureKeyId ?? null,
      previousVersion: p.previousVersion ?? null,
    }));
  });

  ipcMain.handle(
    'plugin-marketplace:search',
    (_event: unknown, payload: { query?: unknown }) => {
      const query = optionalString(payload?.query, 'query') ?? '';
      return searchMarketplacePlugins(
        listMarketplacePlugins(pluginsDirForMarketplace()),
        query,
      ).map((p) => ({
        id: p.manifest.id,
        name: p.manifest.name,
        description: p.manifest.description,
        version: p.version,
        author: p.manifest.author ?? null,
        enabled: p.enabled,
        tools: p.loadedTools,
        source: p.source ?? null,
        sandboxed: p.sandboxed,
        installedAt: p.installedAt ?? null,
        signatureStatus: p.signatureStatus ?? null,
        signatureKeyId: p.signatureKeyId ?? null,
        previousVersion: p.previousVersion ?? null,
      }));
    },
  );

  ipcMain.handle(
    'plugin-marketplace:prepare',
    async (_event: unknown, payload: { source: unknown; allowUnsigned?: unknown }) => {
      const source = requirePluginMarketplaceSource(payload?.source);
      // v0.93a: prepare enforces the bundle signature against the
      // trusted-keys store (userData) — an unsigned remote bundle is
      // refused here unless the UI explicitly passes allowUnsigned
      // (only after the user confirms "install unsigned plugin").
      const prepared = await preparePluginFromSource(source, {
        userDataDir: app.getPath('userData'),
        allowUnsigned: payload?.allowUnsigned === true,
      });
      const stagingId = randomUUID();
      pluginInstallStaging.set(stagingId, prepared);
      return {
        stagingId,
        id: prepared.manifest.id,
        name: prepared.manifest.name,
        version: prepared.manifest.version,
        description: prepared.manifest.description,
        author: prepared.manifest.author ?? null,
        permissions: prepared.manifest.permissions,
        signature: prepared.signature,
      };
    },
  );

  ipcMain.handle(
    'plugin-marketplace:install',
    (_event: unknown, payload: { stagingId: string; allowUnsigned?: unknown }) => {
      const stagingId = requireString(payload?.stagingId, 'stagingId');
      const prepared = pluginInstallStaging.get(stagingId);
      if (!prepared) {
        throw new Error(
          'Không tìm thấy plugin đã chuẩn bị (staging đã hết hạn hoặc đã được cài) — hãy chuẩn bị lại từ đầu.',
        );
      }
      try {
        const result = installPreparedPlugin(prepared, pluginsDirForMarketplace(), {
          userDataDir: app.getPath('userData'),
          allowUnsigned: payload?.allowUnsigned === true,
        });
        return {
          id: result.info.manifest.id,
          name: result.info.manifest.name,
          version: result.version,
          sandboxed: result.sandboxed,
          signature: result.signature,
        };
      } finally {
        pluginInstallStaging.delete(stagingId);
        discardPreparedPlugin(prepared);
      }
    },
  );

  ipcMain.handle(
    'plugin-marketplace:update',
    (_event: unknown, payload: { stagingId: string; allowUnsigned?: unknown }) => {
      const stagingId = requireString(payload?.stagingId, 'stagingId');
      const prepared = pluginInstallStaging.get(stagingId);
      if (!prepared) {
        throw new Error(
          'Không tìm thấy plugin đã chuẩn bị (staging đã hết hạn hoặc đã được cập nhật) — hãy chuẩn bị lại từ đầu.',
        );
      }
      try {
        const result = installPreparedPlugin(prepared, pluginsDirForMarketplace(), {
          userDataDir: app.getPath('userData'),
          allowUnsigned: payload?.allowUnsigned === true,
          overwrite: true,
          approvalKind: 'plugin-update',
        });
        return {
          id: result.info.manifest.id,
          name: result.info.manifest.name,
          version: result.version,
          sandboxed: result.sandboxed,
          signature: result.signature,
          previousVersion: result.previousVersion ?? null,
        };
      } finally {
        pluginInstallStaging.delete(stagingId);
        discardPreparedPlugin(prepared);
      }
    },
  );

  ipcMain.handle(
    'plugin-marketplace:uninstall',
    (_event: unknown, payload: { id: string }) => {
      const id = requireId(payload?.id, 'id');
      return uninstallMarketplacePlugin(id, pluginsDirForMarketplace());
    },
  );

  ipcMain.handle(
    'plugin-marketplace:check-updates',
    (_event: unknown, payload: { entries: unknown }) => {
      if (!Array.isArray(payload?.entries)) {
        throw new Error('Tham số "entries" phải là một mảng.');
      }
      const entries: PluginMarketplaceEntry[] = payload.entries.map((raw, i) =>
        validatePluginMarketplaceEntry(raw, i),
      );
      return checkPluginUpdates(entries, pluginsDirForMarketplace(), app.getVersion());
    },
  );

  // --- v0.93a: downgrade + trusted signing keys (xem
  // docs/plugin-marketplace-signing.md). Downgrade khôi phục bản
  // trước đã snapshot lúc cập nhật; đổi key tin cậy làm plugin ký
  // bằng key đó fail-closed ở lần load sau (trừ khi đã rollback).
  ipcMain.handle(
    'plugin-marketplace:downgrade-info',
    (_event: unknown, payload: { id: string }) => {
      const id = requireId(payload?.id, 'id');
      return getPluginDowngradeInfo(id, pluginsDirForMarketplace(), {
        userDataDir: app.getPath('userData'),
      });
    },
  );

  ipcMain.handle(
    'plugin-marketplace:downgrade',
    (_event: unknown, payload: { id: string }) => {
      const id = requireId(payload?.id, 'id');
      return downgradePlugin(id, pluginsDirForMarketplace(), {
        userDataDir: app.getPath('userData'),
      });
    },
  );

  ipcMain.handle('plugin-marketplace:trusted-keys', () => {
    return listTrustedMarketplaceKeys(app.getPath('userData'));
  });

  ipcMain.handle(
    'plugin-marketplace:add-trusted-key',
    (_event: unknown, payload: { publicKey: string; label?: unknown }) => {
      const publicKey = requireString(payload?.publicKey, 'publicKey');
      const label =
        typeof payload?.label === 'string' && payload.label.trim() !== ''
          ? payload.label.trim()
          : undefined;
      const keyId = addTrustedMarketplaceKey(app.getPath('userData'), publicKey, label);
      return { keyId };
    },
  );

  ipcMain.handle(
    'plugin-marketplace:remove-trusted-key',
    (_event: unknown, payload: { keyId: string }) => {
      const keyId = requireString(payload?.keyId, 'keyId');
      return removeTrustedMarketplaceKey(app.getPath('userData'), keyId);
    },
  );

  // --- v0.3: team (local config file team.json, chưa có server trung tâm) ---
  ipcMain.handle('team:get', () => loadTeamConfig(app.getPath('userData')));

  // v0.95d4 (Đội D4): user profile + long-term memory — tất cả local,
  // không cloud. Profile ở `<userData>/profile.json`; memories ở
  // `<workspace>/.open-bot/memories.json` của từng bot. Vector
  // embedding KHÔNG BAO GIỜ trả về renderer (chỉ đếm số entry đã embed).
  const stripMemoryEmbedding = (entry: LongTermMemoryEntry): Omit<LongTermMemoryEntry, 'embedding'> => {
    const { embedding: _embedding, ...rest } = entry;
    void _embedding;
    return rest;
  };
  const memoryStoreForBot = (botId: string): LongTermMemory => {
    const id = requireId(botId, 'botId');
    const bot = settings.bots.find((b) => b.id === id);
    if (!bot) throw new Error('Không tìm thấy bot.');
    return new LongTermMemory(workspaceDirFor(bot));
  };
  // v0.96 (Đội T1): memory block store của bot — cùng workspace với
  // long-term memory (`.open-bot/memory-blocks.json`). Block không có
  // embedding nên trả nguyên vẹn cho renderer (kèm danh sách bot đang
  // attach để UI vẽ trạng thái share).
  const blocksStoreForBot = (botId: string): MemoryBlockStore => {
    const id = requireId(botId, 'botId');
    const bot = settings.bots.find((b) => b.id === id);
    if (!bot) throw new Error('Không tìm thấy bot.');
    return new MemoryBlockStore(workspaceDirFor(bot));
  };
  const publicBlockView = (
    store: MemoryBlockStore,
    block: { id: string; label: string; description: string; content: string; charLimit: number; readOnly: boolean; createdByBotId: string; version: number; createdAt: string; updatedAt: string },
  ) => ({ ...block, attachedBots: store.attachedBotIds(block.id) });
  const memFsDirForUser = (): string => path.join(app.getPath('userData'), MEMFS_BLOCKS_DIR_NAME);
  const currentUserId = (): string | undefined => {
    try {
      return loadLocalProfile(app.getPath('userData'))?.userId;
    } catch {
      return undefined;
    }
  };

  ipcMain.handle('profile:get', () => loadLocalProfile(app.getPath('userData')));
  ipcMain.handle(
    'profile:update',
    (
      _event: unknown,
      patch: {
        displayName?: string;
        addressForm?: string;
        interests?: string[];
        habits?: string[];
        facts?: string[];
      },
    ) => updateLocalProfile(app.getPath('userData'), patch ?? {}),
  );
  ipcMain.handle(
    'memory:list',
    (_event: unknown, payload: { botId: string; query?: string; tag?: string; limit?: number }) => {
      const store = memoryStoreForBot(payload?.botId);
      const userId = currentUserId();
      const entries = store.recall({
        ...(payload?.query ? { query: payload.query } : {}),
        ...(payload?.tag ? { tag: payload.tag } : {}),
        botId: payload?.botId,
        includeShared: true,
        ...(userId !== undefined ? { userId } : {}),
        limit: payload?.limit ?? 200,
      });
      return entries.map(stripMemoryEmbedding);
    },
  );
  ipcMain.handle(
    'memory:update',
    (
      _event: unknown,
      payload: { botId: string; id: string; value?: string; tags?: string[]; confidence?: number },
    ) => {
      const store = memoryStoreForBot(payload?.botId);
      const updated = store.updateEntry(requireId(payload?.id, 'id'), {
        ...(payload?.value !== undefined ? { value: payload.value } : {}),
        ...(payload?.tags !== undefined ? { tags: requireStringArray(payload.tags, 'tags') } : {}),
        ...(payload?.confidence !== undefined ? { confidence: payload.confidence } : {}),
      });
      if (!updated) throw new Error('Không tìm thấy memory.');
      return stripMemoryEmbedding(updated);
    },
  );
  ipcMain.handle('memory:delete', (_event: unknown, payload: { botId: string; id: string }) => {
    const store = memoryStoreForBot(payload?.botId);
    return { deleted: store.forgetById(requireId(payload?.id, 'id')) };
  });
  ipcMain.handle('memory:export', (_event: unknown, payload: { botId: string }) => {
    const store = memoryStoreForBot(payload?.botId);
    const userId = currentUserId();
    return store.exportMemories({
      botId: payload?.botId,
      includeShared: true,
      ...(userId !== undefined ? { userId } : {}),
    });
  });
  ipcMain.handle('memory:status', async (_event: unknown, payload: { botId: string }) => {
    const store = memoryStoreForBot(payload?.botId);
    const entries = store.recall({ limit: 200 });
    const ollamaAvailable = await new OllamaEmbeddings().isAvailable();
    return {
      total: entries.length,
      embedded: entries.filter((e) => Array.isArray(e.embedding) && e.embedding.length > 0).length,
      ollamaAvailable,
      embeddingModel: 'nomic-embed-text',
    };
  });

  // v0.96 (Đội T1): memory blocks IPC — CRUD + attach/detach/share +
  // read-only + MemFS export/import + consolidate. Mọi thao tác ghi đều
  // qua MemoryBlockStore (validate + audit actor `user`), không có
  // secret nào đi qua IPC này.
  ipcMain.handle(
    'memory-blocks:list',
    (_event: unknown, payload: { botId: string; includeDetached?: boolean }) => {
      const store = blocksStoreForBot(payload?.botId);
      const userId = currentUserId();
      const blocks = payload?.includeDetached
        ? store.list({ ...(userId !== undefined ? { userId } : {}) })
        : store.list({ botId: payload?.botId, ...(userId !== undefined ? { userId } : {}) });
      return blocks.map((b) => publicBlockView(store, b));
    },
  );
  ipcMain.handle(
    'memory-blocks:create',
    (
      _event: unknown,
      payload: { botId: string; label: string; description?: string; content?: string; charLimit?: number; readOnly?: boolean },
    ) => {
      const store = blocksStoreForBot(payload?.botId);
      const userId = currentUserId();
      const block = store.create(
        {
          label: requireString(payload?.label, 'label'),
          ...(payload?.description !== undefined ? { description: payload.description } : {}),
          ...(payload?.content !== undefined ? { content: payload.content } : {}),
          ...(payload?.charLimit !== undefined ? { charLimit: payload.charLimit } : {}),
          ...(payload?.readOnly !== undefined ? { readOnly: payload.readOnly === true } : {}),
          createdByBotId: payload?.botId,
          ...(userId !== undefined ? { userId } : {}),
        },
        'user',
      );
      store.attach(payload?.botId, block.id, 'user');
      return publicBlockView(store, block);
    },
  );
  ipcMain.handle(
    'memory-blocks:update',
    (
      _event: unknown,
      payload: { botId: string; id: string; description?: string; content?: string; charLimit?: number },
    ) => {
      const store = blocksStoreForBot(payload?.botId);
      const updated = store.update(requireId(payload?.id, 'id'), {
        ...(payload?.description !== undefined ? { description: payload.description } : {}),
        ...(payload?.content !== undefined ? { content: payload.content } : {}),
        ...(payload?.charLimit !== undefined ? { charLimit: payload.charLimit } : {}),
      }, 'user');
      return publicBlockView(store, updated);
    },
  );
  ipcMain.handle(
    'memory-blocks:append',
    (_event: unknown, payload: { botId: string; id: string; text: string }) => {
      const store = blocksStoreForBot(payload?.botId);
      const updated = store.append(
        requireId(payload?.id, 'id'),
        requireString(payload?.text, 'text'),
        'user',
      );
      return publicBlockView(store, updated);
    },
  );
  ipcMain.handle('memory-blocks:delete', (_event: unknown, payload: { botId: string; id: string }) => {
    const store = blocksStoreForBot(payload?.botId);
    return { deleted: store.delete(requireId(payload?.id, 'id'), 'user') };
  });
  ipcMain.handle(
    'memory-blocks:attach',
    (_event: unknown, payload: { botId: string; blockId: string; targetBotId?: string }) => {
      const store = blocksStoreForBot(payload?.botId);
      const target = payload?.targetBotId ? requireId(payload.targetBotId, 'targetBotId') : payload?.botId;
      const block = store.attach(target, requireId(payload?.blockId, 'blockId'), 'user');
      return publicBlockView(store, block);
    },
  );
  ipcMain.handle(
    'memory-blocks:detach',
    (_event: unknown, payload: { botId: string; blockId: string; targetBotId?: string }) => {
      const store = blocksStoreForBot(payload?.botId);
      const target = payload?.targetBotId ? requireId(payload.targetBotId, 'targetBotId') : payload?.botId;
      const block = store.detach(target, requireId(payload?.blockId, 'blockId'), 'user');
      return publicBlockView(store, block);
    },
  );
  ipcMain.handle(
    'memory-blocks:share',
    (
      _event: unknown,
      payload: { botId: string; blockId: string; targetBotId?: string; all?: boolean; botIds?: string[] },
    ) => {
      const store = blocksStoreForBot(payload?.botId);
      const blockId = requireId(payload?.blockId, 'blockId');
      if (payload?.all === true) {
        const botIds = requireStringArray(payload?.botIds ?? [], 'botIds') ?? [];
        const newly = store.share(blockId, botIds, 'user');
        return { shared: true, all: true, newlyAttachedBots: newly };
      }
      const target = requireId(payload?.targetBotId ?? payload?.botId, 'targetBotId');
      const block = store.attach(target, blockId, 'user');
      return { shared: true, botId: target, block: publicBlockView(store, block) };
    },
  );
  ipcMain.handle(
    'memory-blocks:read-only',
    (_event: unknown, payload: { botId: string; id: string; readOnly: boolean }) => {
      const store = blocksStoreForBot(payload?.botId);
      const block = store.setReadOnly(requireId(payload?.id, 'id'), payload?.readOnly === true, 'user');
      return publicBlockView(store, block);
    },
  );
  ipcMain.handle('memory-blocks:export', (_event: unknown, payload: { botId: string }) => {
    const store = blocksStoreForBot(payload?.botId);
    const longTerm = memoryStoreForBot(payload?.botId);
    const dir = memFsDirForUser();
    const result = exportBlocksToMemFs(store, dir, { longTerm });
    return { dir: result.dir, files: result.blockFiles, factCount: result.factCount, exportedAt: result.exportedAt };
  });
  ipcMain.handle('memory-blocks:import', (_event: unknown, payload: { botId: string }) => {
    const store = blocksStoreForBot(payload?.botId);
    const longTerm = memoryStoreForBot(payload?.botId);
    const dir = memFsDirForUser();
    const blocksResult = importBlocksFromMemFs(store, dir, { actor: 'user' });
    const factsResult = importFactsFromMemFs(longTerm, dir);
    return { dir, blocks: blocksResult, facts: factsResult };
  });
  ipcMain.handle(
    'memory-blocks:consolidate',
    (
      _event: unknown,
      payload: { botId: string; action: string; enabled?: boolean; idleMinutes?: number },
    ) => {
      const store = blocksStoreForBot(payload?.botId);
      const action = payload?.action;
      if (action === 'status') {
        return { action: 'status', ...store.getConsolidationConfig() };
      }
      if (action === 'configure') {
        if (payload?.enabled !== undefined && typeof payload.enabled !== 'boolean') {
          throw new Error('enabled phải là boolean.');
        }
        return {
          action: 'configure',
          ...store.setConsolidationConfig(
            {
              ...(payload?.enabled !== undefined ? { enabled: payload.enabled } : {}),
              ...(payload?.idleMinutes !== undefined ? { idleMinutes: payload.idleMinutes } : {}),
            },
            'user',
          ),
        };
      }
      if (action === 'run') {
        const longTerm = memoryStoreForBot(payload?.botId);
        return { action: 'run', ...consolidate(longTerm, store, { actor: 'user' }) };
      }
      throw new Error('action phải là "run", "status" hoặc "configure".');
    },
  );

  ipcMain.handle(
    'team:add-member',
    (_event: unknown, payload: { userId: string; name: string; role: TeamRole }) => {
      const userId = requireId(payload?.userId, 'userId');
      const name = requireString(payload?.name, 'name');
      const role = payload?.role;
      if (role !== 'admin' && role !== 'member' && role !== 'viewer') {
        throw new Error('Role phải là admin, member hoặc viewer.');
      }
      const team = loadTeamConfig(app.getPath('userData'));
      const next = addMember(team, { userId, name, role });
      saveTeamConfig(app.getPath('userData'), next);
      return next;
    },
  );

  ipcMain.handle('team:remove-member', (_event: unknown, payload: { userId: string }) => {
    const userId = requireId(payload?.userId, 'userId');
    const team = loadTeamConfig(app.getPath('userData'));
    const next = removeMember(team, userId);
    saveTeamConfig(app.getPath('userData'), next);
    return next;
  });

  ipcMain.handle(
    'team:set-role',
    (_event: unknown, payload: { userId: string; role: TeamRole }) => {
      const userId = requireId(payload?.userId, 'userId');
      const role = payload?.role;
      if (role !== 'admin' && role !== 'member' && role !== 'viewer') {
        throw new Error('Role phải là admin, member hoặc viewer.');
      }
      const team = loadTeamConfig(app.getPath('userData'));
      const next = setRole(team, userId, role);
      saveTeamConfig(app.getPath('userData'), next);
      return next;
    },
  );

  ipcMain.handle(
    'team:share-bot',
    (_event: unknown, payload: { botId: string; sharedBy?: string }) => {
      const botId = requireId(payload?.botId, 'botId');
      const sharedBy = optionalString(payload?.sharedBy, 'sharedBy') ?? LOCAL_USER_ID;
      const bot = settings.bots.find((b) => b.id === botId);
      if (!bot) throw new Error('Không tìm thấy bot.');
      const team = loadTeamConfig(app.getPath('userData'));
      const next = shareBot(team, botId, sharedBy);
      saveTeamConfig(app.getPath('userData'), next);
      return next;
    },
  );

  ipcMain.handle('team:unshare-bot', (_event: unknown, payload: { botId: string }) => {
    const botId = requireId(payload?.botId, 'botId');
    const team = loadTeamConfig(app.getPath('userData'));
    const next = unshareBot(team, botId);
    saveTeamConfig(app.getPath('userData'), next);
    return next;
  });

  ipcMain.handle('team:shared-bots', () => {
    const team = loadTeamConfig(app.getPath('userData'));
    return listSharedBots(team);
  });

  // --- v0.80: portable team bundle (export/import một team thành 1 file) ---
  // Export: team config + shared bots + automations của chúng + skill
  // custom của user (SKILL.md). Service account / API key / token /
  // khóa webhook KHÔNG bao giờ vào file (xem team/portable.ts).
  // Import: parse + validate (kind/version/checksum/secret) TRƯỚC khi
  // ghi gì; xung đột chỉ ghi đè khi user xác nhận (overwrite: true).
  function listUserSkillNames(): string[] {
    const skillsDir = path.join(app.getPath('userData'), 'skills');
    try {
      return fs
        .readdirSync(skillsDir)
        .filter(
          (n) =>
            /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(n) &&
            fs.existsSync(path.join(skillsDir, n, SKILL_FILE_NAME)),
        );
    } catch {
      return [];
    }
  }

  ipcMain.handle('team:export', async () => {
    const userData = app.getPath('userData');
    const team = loadTeamConfig(userData);
    const sharedIds = new Set(listSharedBots(team));
    const bots = settings.bots.filter((b) => sharedIds.has(b.id));
    const automations = (automationScheduler?.list() ?? []).filter(
      (a) => sharedIds.has(a.botId) || a.botId === '',
    );
    const skillsDir = path.join(userData, 'skills');
    const skills: Array<{ name: string; content: string }> = [];
    // v0.82 (follow-up 3a): a skipped skill is reported WITH its
    // reason + size — oversize (>200k chars, the app itself cannot
    // load such a skill, so chunking would export an unloadable file)
    // or empty — instead of just a bare name.
    const skippedSkills: Array<{ name: string; reason: 'oversize' | 'empty'; chars: number }> = [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(skillsDir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) continue;
      let content: string;
      try {
        content = fs.readFileSync(path.join(skillsDir, name, SKILL_FILE_NAME), 'utf8');
      } catch {
        continue;
      }
      const skipped = describeSkippedSkill(name, content);
      if (skipped) {
        skippedSkills.push(skipped);
        continue;
      }
      skills.push({ name, content });
    }
    const bundle = buildTeamBundle({ team, bots, automations, skills });
    const shortId = (bundle.teamId || 'team').slice(0, 8);
    const picked = await dialog.showSaveDialog({
      defaultPath: path.join(app.getPath('downloads'), `open-bot-team-${shortId}.json`),
      filters: [{ name: 'Open Bot team bundle', extensions: ['json'] }],
    });
    if (picked.canceled || !picked.filePath) return { cancelled: true as const };
    fs.writeFileSync(picked.filePath, JSON.stringify(bundle, null, 2), 'utf8');
    return {
      cancelled: false as const,
      path: picked.filePath,
      summary: summarizeTeamBundle(bundle),
      skippedSkills,
    };
  });

  ipcMain.handle('team:import', async () => {
    const picked = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Open Bot team bundle', extensions: ['json'] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { cancelled: true as const };
    const filePath = picked.filePaths[0];
    let text: string;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > TEAM_BUNDLE_MAX_BYTES) {
        throw new Error(`File vượt ${TEAM_BUNDLE_MAX_BYTES / 1024 / 1024} MiB.`);
      }
      text = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      throw new Error(`Không đọc được file: ${err instanceof Error ? err.message : String(err)}`);
    }
    // parseTeamBundle throws với message rõ (kind/version/checksum/secret).
    const bundle = parseTeamBundle(text);
    const team = loadTeamConfig(app.getPath('userData'));
    const conflicts = checkTeamImportConflicts(bundle, {
      teamId: team.teamId ?? '',
      teamNonEmpty: isNonEmptyTeam(team),
      botIds: new Set(settings.bots.map((b) => b.id)),
      automationIds: new Set((automationScheduler?.list() ?? []).map((a) => a.id)),
      skillNames: new Set(listUserSkillNames()),
    });
    return {
      cancelled: false as const,
      path: filePath,
      summary: summarizeTeamBundle(bundle),
      conflicts,
      bundle,
    };
  });

  ipcMain.handle(
    'team:import-apply',
    async (_event: unknown, payload: { bundle: TeamBundle; overwrite: boolean }) => {
      if (!payload || typeof payload !== 'object' || !payload.bundle) {
        throw new Error('Tham số team:import-apply phải là { bundle, overwrite }.');
      }
      // Validate lại bundle (renderer có thể gửi bundle đã sửa tay).
      const bundle = parseTeamBundle(payload.bundle);
      const userData = app.getPath('userData');
      const currentTeam = loadTeamConfig(userData);
      const currentAutomations = automationScheduler?.list() ?? [];
      // Bot lạ provider / workspace ngoài roots của máy này: bỏ khỏi
      // bundle trước khi plan (plan thuần không biết provider/roots).
      // Workspace không dùng được → về '' (mặc định
      // <userData>/workspaces/<botId>, xem workspaceDirFor).
      const preSkipped: Array<{ kind: 'bot'; id: string; reason: string }> = [];
      const usableBots: typeof bundle.data.bots = [];
      for (const bot of bundle.data.bots) {
        if (!isKnownProvider(bot.providerId)) {
          preSkipped.push({
            kind: 'bot',
            id: bot.id,
            reason: `Bot "${bot.name}" dùng provider "${bot.providerId}" không có trên máy này.`,
          });
          continue;
        }
        let workspaceDir = bot.workspaceDir;
        try {
          validateWorkspaceDir(workspaceDir, workspaceRoots());
        } catch {
          workspaceDir = '';
          preSkipped.push({
            kind: 'bot',
            id: bot.id,
            reason: `Workspace của bot "${bot.name}" không dùng được trên máy này — đã đổi về thư mục mặc định.`,
          });
        }
        usableBots.push({ ...bot, workspaceDir });
      }
      const usableBundle: TeamBundle = { ...bundle, data: { ...bundle.data, bots: usableBots } };
      const plan = planTeamImport({
        currentTeam,
        currentBots: settings.bots,
        currentAutomations,
        currentSkillNames: listUserSkillNames(),
        bundle: usableBundle,
        overwrite: payload.overwrite === true,
      });
      const failures: string[] = [];
      // 1. team — lỗi ở đây thì dừng (không có team thì các bước sau vô nghĩa).
      saveTeamConfig(userData, plan.team);
      // 2. bots trong settings (coordinator tạo lazy khi dùng, như bots:create).
      const botById = new Map(settings.bots.map((b) => [b.id, b]));
      for (const bot of plan.botsToReplace) botById.set(bot.id, bot);
      for (const bot of plan.botsToAdd) botById.set(bot.id, bot);
      settings.bots = [...botById.values()];
      saveSettings();
      sendToRenderer('bots:changed', {});
      // 3. automations qua scheduler (validate + nextRunAt tự tính).
      const autoCount = plan.automationsToAdd.length + plan.automationsToReplace.length;
      if (automationScheduler) {
        for (const auto of plan.automationsToAdd) {
          try {
            automationScheduler.create({ ...auto, id: auto.id });
          } catch (err) {
            failures.push(`Automation "${auto.name}": ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        for (const auto of plan.automationsToReplace) {
          try {
            automationScheduler.update(auto);
          } catch (err) {
            failures.push(`Automation "${auto.name}": ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } else if (autoCount > 0) {
        failures.push('Scheduler automation chưa khởi động — automation chưa được nhập.');
      }
      // 4. skills: ghi SKILL.md vào thư mục skill của user.
      const skillsDir = path.join(userData, 'skills');
      for (const skill of plan.skillsToWrite) {
        try {
          const dir = path.join(skillsDir, skill.name);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, SKILL_FILE_NAME), skill.content, 'utf8');
        } catch (err) {
          failures.push(`Skill "${skill.name}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return {
        report: plan.report,
        skipped: [...preSkipped, ...plan.skipped],
        webhookDisabledIds: plan.webhookDisabledIds,
        failures,
      };
    },
  );

  // v0.50 (M8): group chat bot-bot — chuyển tiếp vào coordinator con
  // (nơi GroupChatStore sống). Validate id/text ở main trước khi gửi.
  ipcMain.handle('group:create', (_event: unknown, payload: { name: string; botIds?: string[] }) => {
    const name = requireText(payload?.name, 'name').trim();
    if (!name) throw new Error('Tạo nhóm chat cần tên không rỗng.');
    return getCoordinator().createGroupChat({ name, botIds: payload?.botIds });
  });
  ipcMain.handle('group:list', async () => (await getCoordinator().listGroupChats()).groups);
  ipcMain.handle('group:add-bot', (_event: unknown, payload: { groupId: string; botId: string }) => {
    const groupId = requireId(payload?.groupId, 'groupId');
    const botId = requireId(payload?.botId, 'botId');
    if (!settings.bots.some((b) => b.id === botId)) throw new Error('Không tìm thấy bot.');
    return getCoordinator().addBotToGroupChat({ groupId, botId });
  });
  ipcMain.handle(
    'group:remove-bot',
    (_event: unknown, payload: { groupId: string; botId: string }) => {
      const groupId = requireId(payload?.groupId, 'groupId');
      const botId = requireId(payload?.botId, 'botId');
      return getCoordinator().removeBotFromGroupChat({ groupId, botId });
    },
  );
  ipcMain.handle('group:delete', (_event: unknown, payload: { groupId: string }) => {
    const groupId = requireId(payload?.groupId, 'groupId');
    return getCoordinator().deleteGroupChat({ groupId });
  });
  ipcMain.handle(
    'group:post-message',
    (
      _event: unknown,
      payload: { groupId: string; text: string; botId?: string; attachments?: unknown },
    ) => {
      const groupId = requireId(payload?.groupId, 'groupId');
      // v0.94c (group attachments): text được rỗng khi có ảnh — cùng
      // luật như chat:send (validate ảnh ở đây, core validate lại
      // fail-closed trong coordinator).
      const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
      if (text) requireText(text, 'text');
      const vision = validateVisionAttachments(payload?.attachments);
      if (!vision.ok) throw new Error(vision.error);
      const attachments = vision.attachments;
      if (!text && attachments.length === 0) {
        throw new Error('Message nhóm chat cần nội dung không rỗng hoặc ảnh đính kèm.');
      }
      return getCoordinator().postGroupMessage({
        groupId,
        text,
        botId: payload?.botId,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
    },
  );
  ipcMain.handle(
    'group:get-attachment',
    (
      _event: unknown,
      payload: { groupId: string; messageId: string; attachmentId: string },
    ) => {
      const groupId = requireId(payload?.groupId, 'groupId');
      const messageId = requireId(payload?.messageId, 'messageId');
      const attachmentId = requireId(payload?.attachmentId, 'attachmentId');
      return getCoordinator().getGroupAttachment({ groupId, messageId, attachmentId });
    },
  );
  ipcMain.handle(
    'group:list-messages',
    async (_event: unknown, payload: { groupId: string; limit?: number }) => {
      const groupId = requireId(payload?.groupId, 'groupId');
      return (await getCoordinator().listGroupMessages({ groupId, limit: payload?.limit })).messages;
    },
  );
  // v0.79a: trạng thái chạy của bot trong nhóm (GroupView poll).
  ipcMain.handle('group:status', (_event: unknown, payload: { groupId: string }) => {
    const groupId = requireId(payload?.groupId, 'groupId');
    return getCoordinator().getGroupBotStatus({ groupId });
  });
  // v0.82: bỏ qua ghi nhận "chạy dở thì app dừng" của một bot trong nhóm.
  ipcMain.handle(
    'group:dismiss-interrupted',
    (_event: unknown, payload: { groupId: string; botId: string }) => {
      const groupId = requireId(payload?.groupId, 'groupId');
      const botId = requireId(payload?.botId, 'botId');
      return getCoordinator().dismissGroupBotInterrupted({ groupId, botId });
    },
  );

  // v0.96 (Team T4): channels — chuyển tiếp vào coordinator con (nơi
  // ChannelStore sống). Validate id/text ở main trước khi gửi; giới
  // hạn độ dài (tên 80, instructions 20.000, folder 500 ký tự) được
  // core validate lại fail-closed trong coordinator.
  ipcMain.handle(
    'channel:create',
    (
      _event: unknown,
      payload: { name: string; kind?: string; sharedInstructions?: string; workingFolder?: string; botIds?: string[]; responderRules?: Record<string, unknown> },
    ) => {
      const name = requireText(payload?.name, 'name').trim();
      if (!name) throw new Error('Tạo channel cần tên không rỗng.');
      const kind = payload?.kind === 'personal' || payload?.kind === 'project' ? payload.kind : 'work';
      return getCoordinator().createChannel({
        name,
        kind,
        ...(typeof payload?.sharedInstructions === 'string' ? { sharedInstructions: payload.sharedInstructions } : {}),
        ...(typeof payload?.workingFolder === 'string' ? { workingFolder: payload.workingFolder } : {}),
        botIds: payload?.botIds,
        ...(payload?.responderRules ? { responderRules: payload.responderRules as never } : {}),
      });
    },
  );
  ipcMain.handle('channel:list', async () => (await getCoordinator().listChannels()).channels);
  ipcMain.handle(
    'channel:update',
    (
      _event: unknown,
      payload: { channelId: string; name?: string; kind?: string; sharedInstructions?: string; workingFolder?: string; responderRules?: Record<string, unknown> },
    ) => {
      const channelId = requireId(payload?.channelId, 'channelId');
      const kind = payload?.kind === 'personal' || payload?.kind === 'project' || payload?.kind === 'work' ? payload.kind : undefined;
      return getCoordinator().updateChannel({
        channelId,
        ...(payload?.name !== undefined ? { name: requireText(payload.name, 'name').trim() } : {}),
        ...(kind !== undefined ? { kind } : {}),
        ...(typeof payload?.sharedInstructions === 'string' ? { sharedInstructions: payload.sharedInstructions } : {}),
        ...(typeof payload?.workingFolder === 'string' ? { workingFolder: payload.workingFolder } : {}),
        ...(payload?.responderRules ? { responderRules: payload.responderRules as never } : {}),
      });
    },
  );
  ipcMain.handle('channel:delete', (_event: unknown, payload: { channelId: string }) => {
    const channelId = requireId(payload?.channelId, 'channelId');
    return getCoordinator().deleteChannel({ channelId });
  });
  ipcMain.handle('channel:add-bot', (_event: unknown, payload: { channelId: string; botId: string }) => {
    const channelId = requireId(payload?.channelId, 'channelId');
    const botId = requireId(payload?.botId, 'botId');
    if (!settings.bots.some((b) => b.id === botId)) throw new Error('Không tìm thấy bot.');
    return getCoordinator().addBotToChannel({ channelId, botId });
  });
  ipcMain.handle(
    'channel:remove-bot',
    (_event: unknown, payload: { channelId: string; botId: string }) => {
      const channelId = requireId(payload?.channelId, 'channelId');
      const botId = requireId(payload?.botId, 'botId');
      return getCoordinator().removeBotFromChannel({ channelId, botId });
    },
  );
  ipcMain.handle(
    'channel:move-bot',
    (_event: unknown, payload: { fromChannelId: string; toChannelId: string; botId: string }) => {
      const fromChannelId = requireId(payload?.fromChannelId, 'fromChannelId');
      const toChannelId = requireId(payload?.toChannelId, 'toChannelId');
      const botId = requireId(payload?.botId, 'botId');
      if (!settings.bots.some((b) => b.id === botId)) throw new Error('Không tìm thấy bot.');
      return getCoordinator().moveBotBetweenChannels({ fromChannelId, toChannelId, botId });
    },
  );
  ipcMain.handle(
    'channel:post-message',
    (_event: unknown, payload: { channelId: string; text: string }) => {
      const channelId = requireId(payload?.channelId, 'channelId');
      const text = requireText(payload?.text, 'text').trim();
      if (!text) throw new Error('Message channel cần nội dung không rỗng.');
      return getCoordinator().postChannelMessage({ channelId, text });
    },
  );
  ipcMain.handle(
    'channel:list-messages',
    async (_event: unknown, payload: { channelId: string; limit?: number }) => {
      const channelId = requireId(payload?.channelId, 'channelId');
      return (await getCoordinator().listChannelMessages({ channelId, limit: payload?.limit })).messages;
    },
  );

  ipcMain.handle(
    'chat:send',
    async (
      _event: unknown,
      payload: { botId: string; text: string; threadId?: string; attachments?: unknown },
    ) => {
      const botId = requireId(payload?.botId, 'botId');
      const bot = settings.bots.find((b) => b.id === botId);
      if (!bot) throw new Error('Không tìm thấy bot.');
      // v0.63 (vision channel): text may be empty when images are
      // attached (image-only message — Gemini/Anthropic accept it, and
      // the loop's vision gate answers for text-only models). A
      // non-empty text still goes through requireText (length cap).
      const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
      if (text) requireText(text, 'text');
      // Validate the images here (early, friendly error) — core
      // re-validates fail-closed inside the loop as well.
      const vision = validateVisionAttachments(payload?.attachments);
      if (!vision.ok) throw new Error(vision.error);
      const attachments = vision.attachments;
      if (!text && attachments.length === 0) throw new Error('Tin nhắn trống.');
      // v0.59 (UI-5): thread đang chọn — tin nhắn user + assistant của
      // lượt này đều lưu vào thread đó; không có thì lưu kiểu cũ.
      const threadId =
        typeof payload?.threadId === 'string' && payload.threadId
          ? requireId(payload.threadId, 'threadId')
          : undefined;
      const runtime = await getOrCreateRuntime(bot);

      // v0.65 (vision persistence): the saved user message keeps the
      // plain text AND the images — `syncMessageToMemory` passes the
      // attachments to `saveMessage`, which stores them as files +
      // `message_attachments` rows (see `BotMemory.saveMessage`), so
      // a reload shows the thumbnails again instead of only a file
      // name. The run itself receives only `text` + `attachments`.
      const userMsg: ChatMessage = {
        id: randomUUID(),
        role: 'user',
        text,
        createdAt: Date.now(),
        ...(attachments.length > 0 ? { attachments } : {}),
      };
      runtime.history.push(userMsg);
      await syncMessageToMemory(runtime, userMsg, threadId, attachments);

    // v0.4: đánh dấu chat đang chạy (scheduler/dream không chen vào).
    activeChatRuns.add(bot.id);
    dreamEngine?.noteActivity(bot.id);
    let replyText = '';
    let stopped = false;
    let runError: string | null = null;
    try {
      // Runner chạy trong tiến trình coordinator con; event (delta,
      // toolcall, approval, ...) về qua routeCoordinatorEvent.
      // v0.4: chat đi qua WorkerPool (tối đa N lượt chạy song song).
      // v0.60 (W4 follow-up): seed the run with the selected thread's
      // history — core loads the thread's recent messages as context
      // (RunParams.threadId). No thread (undefined) runs exactly as
      // before: the client omits an undefined threadId from the RPC.
      const result = await workerPool.submit(
        () =>
          getCoordinator().run(bot.id, text, undefined, {
            threadId,
            ...(attachments.length > 0 ? { attachments } : {}),
          }),
        { label: `chat:${bot.id}` },
      ).promise;
      replyText = result.text ?? '';
      // v0.59 (UI-2): an aborted run resolves normally with stopped:true
      // (v0.15) — pass it through so the renderer can show the stopped
      // state instead of treating the reply as a normal answer.
      stopped = result.stopped === true;
      const assistantMsg: ChatMessage = {
        id: randomUUID(),
        role: 'assistant',
        text: replyText,
        createdAt: Date.now(),
      };
      // Nếu runner đã stream qua onText thì renderer đã có nội dung;
      // vẫn lưu bản đầy đủ vào lịch sử ở main.
      if (replyText) {
        runtime.history.push(assistantMsg);
        await syncMessageToMemory(runtime, assistantMsg, threadId);
      }
      return { ok: true, text: replyText, stopped };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Lỗi không xác định.';
      // v0.5: redact secret (key provider / Bearer) trước khi trả về renderer.
      runError = redactErrorText(message);
      return { ok: false, error: runError };
    } finally {
      activeChatRuns.delete(bot.id);
      dreamEngine?.noteActivity(bot.id);
      // v0.4: báo scheduler để automation `agent-done` được kích hoạt.
      const event: AutomationEvent = {
        kind: 'agent-done',
        botId: bot.id,
        text: replyText,
        at: new Date().toISOString(),
      };
      void automationScheduler?.notifyEvent(event).catch(() => undefined);
      // v0.5: webhook run.done / run.error cho chat qua UI.
      void getWebhookDispatcher().dispatch({
        kind: runError ? 'run.error' : 'run.done',
        at: new Date().toISOString(),
        data: runError
          ? { botId: bot.id, error: runError }
          : { botId: bot.id, text: replyText },
      }).catch(() => undefined);
      // v0.87c: OS notification — run xong / lỗi. Run bị user Stop
      // thì không báo "xong việc": stopped không phải hoàn thành.
      // Chỉ chat qua UI (chat:send); run nền qua Local API / dream /
      // automation không bắn để tránh spam ngoài luồng chat.
      if (!stopped) {
        notifyBotEvent(runError ? 'run-error' : 'run-complete', bot.id, {
          ...(runError ? { error: runError } : {}),
        });
      }
    }
  });

  // v0.59 (UI-2): stop the bot's current chat run. A bot runs at most
  // one chat turn at a time, so stopping by bot id stops the current
  // run — the same reasoning as ApiHandlers.stopRun (WS), which maps a
  // run id to its bot and calls stopBot. The desktop chat has no WS run
  // id, so the renderer stops by bot. stopBot is fail-soft: a run that
  // already finished reports stopped:false instead of throwing.
  // v0.63 (pending-stop): Stop can arrive while this bot's runtime is
  // still being created — chat:send triggers createBot lazily, and the
  // Stop button shows as soon as the renderer sets status thinking,
  // before that creation finishes. The coordinator has no entry yet,
  // so stopBot would throw "unknown bot" and the stop would be lost:
  // the run starting right after would run to completion instead of
  // stopping (the UI-2 smoke then times out at settle with the button
  // stuck on "Đang dừng…"). Wait for the in-flight creation (shared
  // promise via getOrCreateRuntime; no-op when the runtime already
  // exists) and stop normally afterwards — the pending-stop window in
  // executeRun aborts the run as soon as it starts. A failed creation
  // leaves nothing running to stop, so stopBot below still reports
  // honestly in that case.
  ipcMain.handle('chat:stop', async (_event: unknown, payload: { botId: string }) => {
    const botId = requireId(payload?.botId, 'botId');
    const bot = settings.bots.find((b) => b.id === botId);
    if (!bot) throw new Error('Không tìm thấy bot.');
    if (runtimeCreations.has(botId)) {
      try {
        await getOrCreateRuntime(bot);
      } catch {
        // Creation failed — fall through to stopBot below.
      }
    }
    return getCoordinator().stopBot(botId);
  });

  ipcMain.handle(
    'chat:history',
    async (_event: unknown, payload: { botId: string; limit?: number; threadId?: string }) => {
      const botId = requireId(payload?.botId, 'botId');
      const bot = settings.bots.find((b) => b.id === botId);
      if (!bot) return [];
      const limit = payload?.limit === undefined ? 50 : requireInt(payload.limit, 'limit', 1, 200);
      // v0.59 (UI-5): thread đang chọn — chỉ nạp tin nhắn của thread đó.
      const threadId =
        typeof payload?.threadId === 'string' && payload.threadId
          ? requireId(payload.threadId, 'threadId')
          : undefined;
      const runtime = await getOrCreateRuntime(bot);
      return historyFromMemory(runtime, limit, threadId);
    },
  );

  // v0.59 (UI-5): threads — một bot có nhiều hội thoại (xem
  // BotMemory + coordinator RPC `listThreads` / `createThread` / ...).
  // `threads:list` luôn trả ít nhất thread mặc định của bot (được tạo
  // + migrate history cũ ở lần gọi đầu). Fix v0.59 leftover (a): truyền
  // `settings.locale` để thread mặc định đặt tên theo locale của UI
  // ('en' → 'New conversation') thay vì luôn tiếng Việt.
  ipcMain.handle('threads:list', async (_event: unknown, payload: { botId: string }) => {
    const botId = requireId(payload?.botId, 'botId');
    const bot = settings.bots.find((b) => b.id === botId);
    if (!bot) throw new Error('Không tìm thấy bot.');
    await getOrCreateRuntime(bot);
    return (await getCoordinator().listThreads(bot.id, settings.locale)).threads;
  });

  ipcMain.handle(
    'threads:create',
    async (_event: unknown, payload: { botId: string; title?: string }) => {
      const botId = requireId(payload?.botId, 'botId');
      const bot = settings.bots.find((b) => b.id === botId);
      if (!bot) throw new Error('Không tìm thấy bot.');
      await getOrCreateRuntime(bot);
      const title = optionalString(payload?.title, 'title', 200);
      return (await getCoordinator().createThread(bot.id, title ?? undefined, settings.locale)).thread;
    },
  );

  ipcMain.handle(
    'threads:rename',
    async (_event: unknown, payload: { threadId: string; title: string }) => {
      const threadId = requireId(payload?.threadId, 'threadId');
      const title = requireText(payload?.title, 'title').trim();
      if (!title) throw new Error('Tiêu đề thread không được rỗng.');
      return (await getCoordinator().renameThread(threadId, title)).thread;
    },
  );

  ipcMain.handle('threads:delete', async (_event: unknown, payload: { threadId: string }) => {
    const threadId = requireId(payload?.threadId, 'threadId');
    return getCoordinator().deleteThread(threadId);
  });

  ipcMain.handle(
    'threads:search',
    async (_event: unknown, payload: { botId?: string; query: string }) => {
      const query = requireText(payload?.query, 'query').trim();
      if (!query) return [];
      const botId =
        typeof payload?.botId === 'string' && payload.botId
          ? requireId(payload.botId, 'botId')
          : undefined;
      if (botId !== undefined) {
        const bot = settings.bots.find((b) => b.id === botId);
        if (!bot) throw new Error('Không tìm thấy bot.');
        await getOrCreateRuntime(bot);
      }
      return (await getCoordinator().searchThreads(query, botId)).hits;
    },
  );

  ipcMain.handle('settings:get', () => settingsForRenderer());

  // v0.87c: OS notifications — renderer / coordinator chỉ gửi request
  // qua IPC này; main validate qua core rồi bắn popup (renderer không
  // bao giờ gọi Electron Notification trực tiếp). Trả outcome để UI
  // báo được khi không hiện (tắt / trùng / quá giới hạn / máy không
  // hỗ trợ). Không throw với request xấu — trả { shown: false }.
  ipcMain.handle('notifications:send', (_event: unknown, payload: unknown) => {
    const validated = validateNotificationRequest(payload);
    if (!validated.ok) return { shown: false, reason: 'invalid', detail: validated.error };
    return getNotificationService().notify(validated.request);
  });

  // v0.87c: nút "Gửi thử" trong Settings — bắn 1 thông báo mẫu loại
  // run-complete cho chính app (không cần bot nào). Trên máy headless
  // không daemon thì trả { shown: false, reason: 'unsupported' } —
  // chỉ kiểm chứng được logic, không phải popup thật.
  ipcMain.handle('notifications:test', (_event: unknown, payload: { kind?: string } | undefined) => {
    const kind: NotificationKind =
      payload?.kind === 'approval' || payload?.kind === 'run-error' ? payload.kind : 'run-complete';
    const text = formatNotificationText(settings.locale, kind, { botName: 'open-bot' });
    return getNotificationService().notify({ kind, title: text.title, body: text.body });
  });
  // v0.86 (P2-6): deep-link — renderer kéo route đang chờ lúc mount.
  // Đánh dấu renderer đã sẵn (URL tới sau đó main đẩy thẳng qua
  // `deep-link:open`); route trả về 1 lần duy nhất rồi xóa.
  ipcMain.handle('deep-link:pending', () => {
    deepLinkRendererReady = true;
    const route = pendingDeepLinkRoute;
    pendingDeepLinkRoute = null;
    if (!route) return null;
    return validateDeepLinkRoute(route);
  });

  ipcMain.handle(
    'settings:set',
    (
      _event: unknown,
      patch: {
        providers?: Record<string, { apiKey?: string; baseUrl?: string; defaultModel?: string; realtimeUrl?: string }>;
        locale?: string;
        /** v0.86 (P2-7): bật/tắt crash reporting (opt-in, mặc định tắt). */
        crashReportingEnabled?: boolean;
        /** v0.87c: OS notifications theo từng loại (mặc định cả 3 bật). */
        notifications?: Partial<NotificationSettings>;
      },
    ) => {
      // v0.7: validate patch — provider lạ / baseUrl sai / key quá dài đều bị từ chối.
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error('Tham số settings:set phải là object.');
      }
      if (isAppLocale(patch.locale)) {
        settings.locale = patch.locale;
      } else if (patch.locale !== undefined) {
        throw new Error('Locale phải là một trong: vi, en, zh, ja, es, fr.');
      }
      // v0.86 (P2-7): toggle crash reporting — chỉ nhận boolean; giá
      // trị lạ thì từ chối thay vì ép kiểu lặng lẽ. Collector đọc cờ
      // này mỗi lần crash nên đổi có hiệu lực ngay, không cần restart.
      if (patch.crashReportingEnabled !== undefined) {
        if (typeof patch.crashReportingEnabled !== 'boolean') {
          throw new Error('"crashReportingEnabled" phải là boolean.');
        }
        settings.crashReportingEnabled = patch.crashReportingEnabled;
      }
      // v0.87c: toggle OS notifications theo từng loại — chỉ nhận
      // boolean từng field; giá trị lạ thì từ chối thay vì ép kiểu
      // lặng lẽ. Patch từng phần được: field nào không gửi thì giữ
      // nguyên giá trị cũ.
      if (patch.notifications !== undefined) {
        if (patch.notifications === null || typeof patch.notifications !== 'object' || Array.isArray(patch.notifications)) {
          throw new Error('"notifications" phải là object.');
        }
        const next = resolveNotificationSettings(settings.notifications);
        for (const key of ['runComplete', 'approval', 'runError', 'projectUpdate'] as const) {
          const value = (patch.notifications as Partial<Record<typeof key, unknown>>)[key];
          if (value === undefined) continue;
          if (typeof value !== 'boolean') {
            throw new Error(`"notifications.${key}" phải là boolean.`);
          }
          next[key] = value;
        }
        settings.notifications = next;
      }
      for (const [id, p] of Object.entries(patch.providers ?? {})) {
        if (!isKnownProvider(id)) throw new Error(`Không rõ provider id: ${id}.`);
        if (!isProviderAllowed(activePolicy, id)) {
          throw new Error(`Provider "${id}" không được phép theo policy của máy.`);
        }
        if (p === null || typeof p !== 'object') throw new Error(`Cấu hình provider "${id}" phải là object.`);
        if (p.baseUrl !== undefined && p.baseUrl !== '') requireHttpUrl(p.baseUrl, 'baseUrl');
        if (p.realtimeUrl !== undefined && p.realtimeUrl !== '') {
          // v0.95 (Đội D3): realtimeUrl là WebSocket (wss://), không
          // phải http(s) — validate bằng requireWsUrl.
          requireWsUrl(p.realtimeUrl, 'realtimeUrl');
        }
        if (p.defaultModel !== undefined) optionalString(p.defaultModel, 'defaultModel');
        if (p.apiKey !== undefined && p.apiKey !== '') requireString(p.apiKey, 'apiKey', 4096);
        const prev = settings.providers[id] ?? { apiKey: '', baseUrl: '', defaultModel: '' };
        settings.providers[id] = {
          // v0.4: API key KHÔNG lưu vào settings.json nữa — vào Vault.
          // apiKey rỗng = giữ key cũ trong Vault (renderer không gửi key thật về).
          apiKey: '',
          baseUrl: p.baseUrl ?? prev.baseUrl,
          defaultModel: p.defaultModel ?? prev.defaultModel,
          realtimeUrl: p.realtimeUrl ?? prev.realtimeUrl,
        };
        if (p.apiKey && p.apiKey.length > 0) {
          vault.setSecret('provider', id, p.apiKey);
        }
        // Provider đổi cấu hình -> runtime cũ dùng key/model cũ phải bỏ.
        for (const bot of settings.bots.filter((b) => b.providerId === id)) {
          void invalidateRuntime(bot.id);
        }
      }
      saveSettings();
      return settingsForRenderer();
    },
  );

  ipcMain.handle('settings:test', async (_event: unknown, payload: { providerId: string }) => {
    const providerId = requireId(payload?.providerId, 'providerId');
    if (!isKnownProvider(providerId)) throw new Error(`Không rõ provider id: ${providerId}.`);
    if (!isProviderAllowed(activePolicy, providerId)) {
      return { ok: false, error: `Provider "${providerId}" không được phép theo policy của máy.` };
    }
    // v0.4: key sống trong Vault, không còn trong settings.
    // M1–M2: provider CLI (claude-code, codex, grok-cli) không dùng API
    // key — mượn login của CLI trên máy nên miễn kiểm tra Vault.
    const cliKind = (PROVIDERS as Array<{ id: string; kind?: string }>).find(
      (p) => p.id === providerId,
    )?.kind;
    if (
      !vault.hasSecret('provider', providerId) &&
      providerId !== 'ollama' &&
      cliKind !== 'cli'
    ) {
      return { ok: false, error: 'Chưa nhập API key cho provider này.' };
    }
    try {
      // listModels() is part of the core Provider interface — no cast needed.
      const provider = createProvider(await providerConfigFor(providerId));
      const models = await provider.listModels();
      return { ok: true, models };
    } catch (err) {
      // v0.5: redact secret trước khi trả lỗi về renderer (key có thể
      // nằm trong URL lỗi của provider, vd: Gemini ?key=…).
      return { ok: false, error: redactErrorText(err instanceof Error ? err.message : 'Kết nối thất bại.') };
    }
  });

  // v0.28: trạng thái lưu task A2A — renderer hỏi lúc mở app để hiện
  // banner cảnh báo nếu lần lưu gần nhất thất bại sau hết retry
  // (Local API chưa chạy thì trả trạng thái "ok" mặc định).
  ipcMain.handle('a2a:persist-status', () =>
    a2aServerRef?.getPersistStatus() ?? {
      ok: true,
      lastError: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastAttempts: 0,
      consecutiveFailures: 0,
      totalFailures: 0,
    },
  );

  // v0.31 (P1-2): agent A2A ngoài mà user đã tin tưởng — file JSON trong
  // userData, chỉ user mới thêm/xoá được (tool a2a_* không tự trust).
  // Token KHÔNG lưu ở đây: a2a:trusted-add chỉ dùng token cho lần đọc
  // card đó, a2a:trusted-send gọi không auth (agent ngoài có auth thì
  // user tự gọi tool với token riêng, không qua UI).
  interface TrustedA2aAgentRecord {
    baseUrl: string;
    name: string;
    description?: string;
    url: string;
    skills?: Array<{ id: string; name: string; description: string }>;
    streaming?: boolean;
    trustedAt: string;
  }
  const trustedAgentsFilePath = (): string =>
    path.join(app.getPath('userData'), 'a2a-trusted-agents.json');
  const normalizeA2aBaseUrl = (raw: string): string => {
    const url = new URL(requireHttpUrl(raw, 'url'));
    return url.toString().replace(/\/+$/, '');
  };
  const readTrustedA2aAgents = (): TrustedA2aAgentRecord[] => {
    let raw: string;
    try {
      raw = fs.readFileSync(trustedAgentsFilePath(), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`Không đọc được file agent A2A đã tin tưởng: ${(err as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as { agents?: unknown };
    } catch {
      // File hỏng: trả rỗng + ghi log thay vì crash app (user thêm lại).
      console.warn('[open-bot] File a2a-trusted-agents.json hỏng, coi như chưa có agent nào.');
      return [];
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { agents?: unknown }).agents)) {
      return [];
    }
    return ((parsed as { agents: unknown[] }).agents as TrustedA2aAgentRecord[]).filter(
      (a) => a && typeof a === 'object' && typeof a.baseUrl === 'string' && typeof a.name === 'string',
    );
  };
  const writeTrustedA2aAgents = (agents: TrustedA2aAgentRecord[]): void => {
    const file = trustedAgentsFilePath();
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ agents }, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  };
  const trustedAgentFromCard = (card: A2aAgentCard, baseUrl: string): TrustedA2aAgentRecord => ({
    baseUrl,
    name: card.name,
    description: card.description,
    url: card.url,
    skills: (card.skills ?? []).map((s) => ({ id: s.id, name: s.name, description: s.description })),
    streaming: card.capabilities?.streaming,
    trustedAt: new Date().toISOString(),
  });

  ipcMain.handle('a2a:trusted-list', () => readTrustedA2aAgents());

  ipcMain.handle('a2a:trusted-add', async (_event: unknown, payload: unknown) => {
    const p = (payload ?? {}) as { url?: unknown; token?: unknown };
    const baseUrl = normalizeA2aBaseUrl(requireHttpUrl(p.url, 'url'));
    const token = typeof p.token === 'string' && p.token.length > 0 ? p.token : undefined;
    // Đọc card trước khi tin tưởng: URL không phải A2A server thì lỗi
    // rõ ràng ở đây, không lưu rác vào danh sách.
    const card = await fetchAgentCard(baseUrl, { token });
    const agents = readTrustedA2aAgents().filter((a) => a.baseUrl !== baseUrl);
    const record = trustedAgentFromCard(card, baseUrl);
    agents.push(record);
    writeTrustedA2aAgents(agents);
    return record;
  });

  ipcMain.handle('a2a:trusted-remove', (_event: unknown, payload: unknown) => {
    const p = (payload ?? {}) as { baseUrl?: unknown };
    const baseUrl = normalizeA2aBaseUrl(requireHttpUrl(p.baseUrl, 'baseUrl'));
    const kept = readTrustedA2aAgents().filter((a) => a.baseUrl !== baseUrl);
    writeTrustedA2aAgents(kept);
    return kept;
  });

  ipcMain.handle('a2a:trusted-send', async (_event: unknown, payload: unknown) => {
    const p = (payload ?? {}) as { baseUrl?: unknown; message?: unknown; timeoutMs?: unknown };
    const baseUrl = normalizeA2aBaseUrl(requireHttpUrl(p.baseUrl, 'baseUrl'));
    const message = requireText(p.message, 'message');
    if (message.length > 20_000) {
      throw new Error('Tin nhắn quá dài (tối đa 20000 ký tự).');
    }
    const timeoutMs =
      typeof p.timeoutMs === 'number' && Number.isFinite(p.timeoutMs)
        ? Math.min(Math.max(Math.floor(p.timeoutMs), 1_000), 300_000)
        : 30_000;
    const trusted = readTrustedA2aAgents().find((a) => a.baseUrl === baseUrl);
    if (!trusted) {
      throw new Error('Agent này chưa được tin tưởng — thêm nó ở màn hình "A2A Agents" trước.');
    }
    const client = new A2aClient({ baseUrl, timeoutMs });
    let task = await client.sendMessage(message, { timeoutMs });
    if (!isA2aTerminalState(task.status.state)) {
      task = await client.pollTask(task.id, { timeoutMs: 120_000 });
    }
    const artifactParts = (task.artifacts ?? []).flatMap((a) => a.parts);
    const text = partsToText(artifactParts) || partsToText(task.status.message?.parts ?? []);
    return {
      taskId: task.id,
      state: task.status.state,
      text,
      artifacts: (task.artifacts ?? []).map((a) => ({ artifactId: a.artifactId, name: a.name ?? null, text: partsToText(a.parts) })),
    };
  });

  ipcMain.handle('tasks:list', async (_event: unknown, payload: { botId: string }) => {
    const botId = requireId(payload?.botId, 'botId');
    const bot = settings.bots.find((b) => b.id === botId);
    if (!bot) return [];
    const runtime = await getOrCreateRuntime(bot);
    try {
      // Core statuses: pending | in_progress | done | cancelled.
      // UI statuses:   pending | running    | done | failed.
      const { tasks } = await getCoordinator().listTasks(bot.id);
      return tasks.map((task) => ({
        id: task.id,
        botId: task.botId,
        title: task.title,
        status:
          task.status === 'in_progress'
            ? ('running' as const)
            : task.status === 'cancelled'
              ? ('failed' as const)
              : task.status,
      }));
    } catch {
      return runtime.tasks;
    }
  });

  // v0.11 (W10b): plans submitted in an earlier session — read back from
  // the bot workspace's `.open-bot/plans/` files (see ./plans). `botId`
  // narrows to one bot; omitted = all bots (the renderer passes the
  // selected bot when it knows it). A bad file never throws — the reader
  // skips it. A bot whose workspace cannot be resolved contributes
  // nothing instead of failing the list.
  ipcMain.handle(
    'plans:list',
    (_event: unknown, payload?: { botId?: string }): StoredPlan[] => {
      const bots =
        typeof payload?.botId === 'string' && payload.botId.length > 0
          ? settings.bots.filter((b) => b.id === payload.botId)
          : settings.bots;
      const withDirs: Array<{ id: string; workspaceDir: string }> = [];
      for (const bot of bots) {
        try {
          withDirs.push({ id: bot.id, workspaceDir: workspaceDirFor(bot) });
        } catch {
          // No resolvable workspace — this bot has no stored plans.
        }
      }
      return listStoredPlansForBots(withDirs);
    },
  );

  // v0.20 (W13a): duyệt plan trực tiếp từ màn hình Kế hoạch — renderer
  // gọi IPC này thay vì gửi chat để agent gọi plan_update trong run
  // (đường cũ hiện thêm một thẻ approval cho chính tool-call đó).
  // Main đảm bảo bot đã có runtime trong coordinator (BotMemory sống ở
  // đó) rồi chuyển tiếp sang coordinator RPC `reviewPlan`: ghi quyết
  // định vào memory + file plan, và chỉ approve mới ghi dấu để run kế
  // tiếp tự duyệt tool-call. Lỗi (bot/plan không có, plan đã quyết rồi,
  // decision sai) throw thẳng để renderer báo lại cho người dùng.
  ipcMain.handle(
    'plans:review',
    async (
      _event: unknown,
      payload?: {
        botId?: string;
        projectId?: string;
        decision?: string;
        note?: string;
      },
    ) => {
      const botId = requireId(payload?.botId, 'botId');
      const projectId = requireId(payload?.projectId, 'projectId');
      const decision = payload?.decision;
      if (decision !== 'approve' && decision !== 'reject' && decision !== 'request-changes') {
        throw new Error('plans:review cần decision là approve, reject hoặc request-changes.');
      }
      const bot = settings.bots.find((b) => b.id === botId);
      if (!bot) throw new Error('Không tìm thấy bot.');
      await getOrCreateRuntime(bot);
      return getCoordinator().reviewPlan(
        botId,
        projectId,
        decision,
        typeof payload?.note === 'string' ? payload.note : undefined,
      );
    },
  );

  // --- v0.35 (P1-7): quản lý rule auto-approve (Settings UI) ---
  // Main chỉ chuyển tiếp sang coordinator RPC (store rule sống ở tiến
  // trình con, file `<userData>/auto-approve-rules.json`). Rule do
  // người dùng tạo tường minh; lỗi validate (pattern nguy hiểm, thiếu
  // field…) throw thẳng để renderer báo lại. Không cần bot runtime:
  // rule là cấu hình toàn cục/bot, không gắn với runtime đang chạy.
  ipcMain.handle('auto-approve:list', async () => {
    const { rules } = await getCoordinator().listAutoApproveRules();
    return rules;
  });

  ipcMain.handle(
    'auto-approve:add',
    async (_event: unknown, payload?: Record<string, unknown>) => {
      if (!payload || typeof payload !== 'object') {
        throw new Error('auto-approve:add cần rule (object).');
      }
      const { rule } = await getCoordinator().addAutoApproveRule(
        payload as unknown as AutoApproveRuleInput,
      );
      return rule;
    },
  );

  ipcMain.handle('auto-approve:remove', async (_event: unknown, payload?: { id?: string }) => {
    const id = requireId(payload?.id, 'id');
    const { removed } = await getCoordinator().removeAutoApproveRule(id);
    return removed;
  });

  ipcMain.handle(
    'auto-approve:set-enabled',
    async (_event: unknown, payload?: { id?: string; enabled?: boolean }) => {
      const id = requireId(payload?.id, 'id');
      if (typeof payload?.enabled !== 'boolean') {
        throw new Error('auto-approve:set-enabled cần "enabled" là boolean.');
      }
      const { rule } = await getCoordinator().setAutoApproveRuleEnabled(id, payload.enabled);
      return rule;
    },
  );

  // --- v0.10: run tracing (JSONL spans, read-only from main) ---
  // The coordinator child writes traces to the same file (its wiring
  // lands separately); main only READS it for the TraceView UI, so a
  // missing/empty file is just "no traces yet", never an error.
  ipcMain.handle(
    'traces:list',
    (_event: unknown, payload?: { botId?: string; runId?: string; limit?: number }): TraceSummary[] => {
      const botId = payload?.botId === undefined ? undefined : requireId(payload.botId, 'botId');
      const runId = payload?.runId === undefined ? undefined : requireId(payload.runId, 'runId');
      const limit =
        payload?.limit === undefined ? undefined : requireInt(payload.limit, 'limit', 1, 500);
      return getTraceStore().listTraces({ botId, runId, limit });
    },
  );
  ipcMain.handle(
    'traces:get',
    (_event: unknown, payload: { traceId?: string; runId?: string }): Trace | null => {
      if (typeof payload?.traceId === 'string' && payload.traceId) {
        return getTraceStore().getTrace(requireId(payload.traceId, 'traceId'));
      }
      if (typeof payload?.runId === 'string' && payload.runId) {
        return getTraceStore().getTraceByRunId(requireId(payload.runId, 'runId'));
      }
      throw new Error('Tham số traces:get cần traceId hoặc runId.');
    },
  );

  // --- v0.4: Vault (secret KHÔNG BAO GIỜ rời main process) ---
  ipcMain.handle('vault:list', () => {
    // Trả về tên key theo namespace — KHÔNG trả value.
    const out: Record<string, string[]> = {};
    for (const ns of vault.listNamespaces()) out[ns] = vault.listSecrets(ns);
    return out;
  });

  ipcMain.handle('vault:set', (_event: unknown, payload: { namespace: string; key: string; value: string }) => {
    // v0.7: namespace/key theo đúng 3 loại credential — session /
    // oauth-refresh / provider (cộng api, service-account, mcp,
    // plugin, identity). Giá trị rỗng hoặc quá dài bị từ chối.
    const namespace = requireId(payload?.namespace, 'namespace');
    const key = requireId(payload?.key, 'key');
    const value = requireString(payload?.value, 'value', 8192);
    vault.setSecret(namespace, key, value);
    // Key provider đổi -> runtime cũ dùng key cũ phải bỏ.
    if (namespace === 'provider') {
      for (const bot of settings.bots.filter((b) => b.providerId === key)) {
        void invalidateRuntime(bot.id);
      }
    }
    // v0.9d: token/credential connector đổi -> runtime cũ đang giữ
    // TokenSet snapshot cũ phải bỏ để lần chạy sau seed lại từ Vault
    // (mọi bot dùng chung connector token nên bỏ hết).
    if (
      namespace === 'connector' ||
      (namespace === 'oauth-client' && isConnectorClientKey(key))
    ) {
      for (const bot of settings.bots) {
        void invalidateRuntime(bot.id);
      }
    }
    return true;
  });

  ipcMain.handle('vault:delete', (_event: unknown, payload: { namespace: string; key: string }) => {
    const namespace = requireId(payload?.namespace, 'namespace');
    const key = requireId(payload?.key, 'key');
    const removed = vault.deleteSecret(namespace, key);
    if (removed && namespace === 'provider') {
      for (const bot of settings.bots.filter((b) => b.providerId === key)) {
        void invalidateRuntime(bot.id);
      }
    }
    // v0.9d: như vault:set — token/credential connector bị xóa thì
    // runtime cũ cũng phải bỏ để lần chạy sau không dùng token cũ.
    if (
      removed &&
      (namespace === 'connector' ||
        (namespace === 'oauth-client' && isConnectorClientKey(key)))
    ) {
      for (const bot of settings.bots) {
        void invalidateRuntime(bot.id);
      }
    }
    return removed;
  });

  // --- v0.53 (P1-6): 1Password broker (out-of-process) ---
  // Trạng thái KHÔNG chứa secret (chỉ nhãn tài khoản). Import-field
  // lấy đúng MỘT field của một item rồi ghi thẳng vào Vault trong
  // main — giá trị KHÔNG BAO GIỜ trả về renderer (chỉ trả {stored}).
  // `saveToVault: false` (mặc định true) giữ key session-only.
  // v0.59: thêm cờ `enabled` (settings.onePasswordEnabled, mặc định
  // bật) + IPC `onepassword:set-enabled`. Khi tắt, main không spawn
  // worker `op` nữa và import-field từ chối (fail-closed).
  ipcMain.handle(
    'onepassword:status',
    async (): Promise<OnePasswordBrokerStatus & { enabled: boolean }> => {
      if (settings.onePasswordEnabled === false) {
        return {
          state: 'signed-out',
          available: false,
          signedIn: false,
          accounts: [],
          reason: '1Password broker đã tắt trong Cài đặt.',
          enabled: false,
        };
      }
      const status = await getOnePasswordBroker().getStatus();
      return { ...status, enabled: true };
    },
  );

  ipcMain.handle(
    'onepassword:set-enabled',
    (_event: unknown, payload: { enabled: boolean }): { enabled: boolean } => {
      const enabled = requireBoolean(payload?.enabled, 'enabled');
      settings.onePasswordEnabled = enabled;
      saveSettings();
      if (!enabled && onePasswordBroker) {
        onePasswordBroker.dispose();
        onePasswordBroker = null;
      }
      return { enabled };
    },
  );

  ipcMain.handle(
    'onepassword:import-field',
    async (
      _event: unknown,
      payload: { itemId: string; field: string; namespace: string; key: string; saveToVault?: boolean },
    ): Promise<{ stored: boolean }> => {
      if (settings.onePasswordEnabled === false) {
        throw new Error('1Password broker đã tắt trong Cài đặt.');
      }
      const itemId = requireId(payload?.itemId, 'itemId');
      const field = requireString(payload?.field, 'field', 200);
      const namespace = requireId(payload?.namespace, 'namespace');
      const key = requireId(payload?.key, 'key');
      const saveToVault = payload?.saveToVault !== false;
      const value = await getOnePasswordBroker().getField(itemId, field);
      vault.setSecret(namespace, key, value, { saveToVault });
      if (namespace === 'provider') {
        for (const bot of settings.bots.filter((b) => b.providerId === key)) {
          void invalidateRuntime(bot.id);
        }
      }
      return { stored: true };
    },
  );

  // --- v0.4: Usage + spend limit ---
  ipcMain.handle('usage:get', (_event: unknown, payload?: { botId?: string }) => {
    const botId = payload?.botId === undefined ? undefined : requireId(payload.botId, 'botId');
    usageTracker.reload();
    return usageTracker.getSpendStatus(botId);
  });

  ipcMain.handle('usage:get-limits', () => {
    usageTracker.reload();
    return usageTracker.getLimits();
  });

  ipcMain.handle('usage:set-limits', (_event: unknown, limits: SpendLimits) => {
    // v0.7: limit phải là số hữu hạn >= 0 (UsageTracker cũng throw khi <= 0).
    if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
      throw new Error('Tham số usage:set-limits phải là object.');
    }
    for (const [k, v] of Object.entries(limits as Record<string, unknown>)) {
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
        throw new Error(`Giới hạn "${k}" phải là số >= 0.`);
      }
    }
    usageTracker.reload();
    usageTracker.setLimits(limits); // throw khi limit <= 0 / không phải số
    return usageTracker.getLimits();
  });

  ipcMain.handle('usage:reset', (_event: unknown, payload: { scope: 'day' | 'month' | 'all' }) => {
    const scope = payload?.scope;
    if (scope !== 'day' && scope !== 'month' && scope !== 'all') {
      throw new Error('Scope phải là day, month hoặc all.');
    }
    usageTracker.reload();
    const removed = usageTracker.reset(scope);
    return { removed, status: usageTracker.getSpendStatus() };
  });

  // --- v0.4: skills ---
  ipcMain.handle('skills:list', () => {
    const registry = getSkillRegistry();
    return registry.list().map((s) => ({
      name: s.name,
      description: s.description,
      version: s.version,
      whenToUse: s.whenToUse,
      tools: s.tools,
      source: s.source,
      pluginId: s.pluginId ?? null,
      enabled: s.enabled,
    }));
  });

  ipcMain.handle('skills:toggle', (_event: unknown, payload: { name: string; enabled: boolean }) => {
    const name = requireString(payload?.name, 'name');
    const enabled = requireBoolean(payload?.enabled, 'enabled');
    const registry = getSkillRegistry();
    const ok = enabled ? registry.enable(name) : registry.disable(name);
    if (!ok) throw new Error(`Không tìm thấy skill "${name}".`);
    return registry.get(name)?.enabled ?? false;
  });

  ipcMain.handle('skills:reload', () => {
    const registry = getSkillRegistry();
    const skills = registry.load();
    // Báo coordinator reload registry của nó (nơi skill được chèn vào system prompt).
    void getCoordinator()
      .reloadSkills()
      .catch(() => undefined);
    return { skills: skills.map((s) => s.name), errors: registry.errors() };
  });

  // --- v0.66b: SkillsView — đọc toàn bộ SKILL.md + cài skill mới từ text dán ---
  // `skills:read` trả toàn bộ text SKILL.md của 1 skill đã load (cap 200k
  // ký tự trong core — skill quá lớn bị từ chối rõ ràng thay vì treo).
  // `skills:install` chỉ cài từ nội dung user tự dán: KHÔNG có tải skill
  // từ URL/mạng (tránh supply-chain — skill lạ từ mạng chạy như hướng
  // dẫn của agent). Core validate bằng chính loader rồi ghi atomic
  // (file tạm + rename) vào `<userData>/skills/<name>/SKILL.md`.
  ipcMain.handle('skills:read', (_event: unknown, payload: { name: string }) => {
    const name = requireString(payload?.name, 'name');
    const content = getSkillRegistry().readSkillText(name);
    return { name, content };
  });

  ipcMain.handle('skills:install', (_event: unknown, payload: { name: string; content: string }) => {
    const name = requireString(payload?.name, 'name');
    // requireText: không trim (giữ nguyên nội dung file), cap 200.000 ký tự.
    const content = requireText(payload?.content, 'content');
    const skill = getSkillRegistry().installSkill(name, content);
    // Báo coordinator reload registry của nó để skill mới dùng được ngay.
    void getCoordinator()
      .reloadSkills()
      .catch(() => undefined);
    return {
      name: skill.name,
      description: skill.description,
      version: skill.version,
      whenToUse: skill.whenToUse,
      tools: skill.tools,
      source: skill.source,
      pluginId: skill.pluginId ?? null,
      enabled: skill.enabled,
    };
  });

  // --- v0.86c: CanvasView — đọc/xoá/mở canvas của 1 bot ---
  // Tầng dữ liệu đã có từ v0.6 (CanvasStore trong @open-bot/core, cùng
  // thư mục `<workspaceDir>/.open-bot/canvas/<botId>/` mà tool
  // canvas_write/canvas_list dùng); renderer trước giờ chưa có View
  // nào để xem nên các kênh này mới được nối ở đây. Chỉ đọc/xoá/mở
  // file — ghi canvas vẫn đi qua tool canvas_write của agent (cần
  // approval). `canvas:open` mở file JSON bằng app mặc định của hệ
  // điều hành (shell.openPath), không chạy nội dung canvas.
  ipcMain.handle('canvas:list', (_event: unknown, payload: { botId: string }) => {
    const botId = requireId(payload?.botId, 'botId');
    const bot = settings.bots.find((b) => b.id === botId);
    if (!bot) throw new Error('Không tìm thấy bot.');
    return new CanvasStore(workspaceDirFor(bot), bot.id).list();
  });

  ipcMain.handle('canvas:get', async (_event: unknown, payload: { botId: string; id: string }) => {
    const botId = requireId(payload?.botId, 'botId');
    const id = requireId(payload?.id, 'id');
    const bot = settings.bots.find((b) => b.id === botId);
    if (!bot) throw new Error('Không tìm thấy bot.');
    const doc = await new CanvasStore(workspaceDirFor(bot), bot.id).read(id);
    if (!doc) throw new Error(`Không tìm thấy canvas "${id}".`);
    return doc;
  });

  ipcMain.handle('canvas:delete', async (_event: unknown, payload: { botId: string; id: string }) => {
    const botId = requireId(payload?.botId, 'botId');
    const id = requireId(payload?.id, 'id');
    const bot = settings.bots.find((b) => b.id === botId);
    if (!bot) throw new Error('Không tìm thấy bot.');
    const deleted = await new CanvasStore(workspaceDirFor(bot), bot.id).delete(id);
    if (!deleted) throw new Error(`Không tìm thấy canvas "${id}".`);
    return { deleted: true };
  });

  ipcMain.handle('canvas:open', async (_event: unknown, payload: { botId: string; id: string }) => {
    const botId = requireId(payload?.botId, 'botId');
    const id = requireId(payload?.id, 'id');
    const bot = settings.bots.find((b) => b.id === botId);
    if (!bot) throw new Error('Không tìm thấy bot.');
    const store = new CanvasStore(workspaceDirFor(bot), bot.id);
    const doc = await store.read(id);
    if (!doc) throw new Error(`Không tìm thấy canvas "${id}".`);
    // Mở file JSON trong trình soạn thảo mặc định của hệ điều hành.
    const error = await shell.openPath(path.join(store.directory, `${id}.json`));
    if (error) throw new Error(`Không mở được file canvas: ${error}`);
    return { opened: true };
  });

  // --- v0.86 (P2-7): crash reporting opt-in — xem/xoá report local ---
  // Chỉ đọc/xoá file report trong `<userData>/crash-reports/` (đã
  // redact PII lúc ghi). KHÔNG có kênh gửi đi đâu: sóng này chỉ thu
  // thập + lưu local + xem/xoá; gửi (user bấm gửi rõ ràng) là sóng
  // sau, xem docs/crash-reporting.md. `crash-report:renderer` nhận
  // lỗi từ renderer (main.tsx) và chỉ ghi khi user đã bật opt-in.
  ipcMain.handle('crash-reports:list', () => getCrashReportStore().listSummaries());

  ipcMain.handle('crash-reports:get', (_event: unknown, payload: { id: string }) => {
    const id = requireId(payload?.id, 'id');
    const report = getCrashReportStore().get(id);
    if (!report) throw new Error(`Không tìm thấy crash report "${id}".`);
    return report;
  });

  ipcMain.handle('crash-reports:delete', (_event: unknown, payload: { id: string }) => {
    const id = requireId(payload?.id, 'id');
    const deleted = getCrashReportStore().delete(id);
    if (!deleted) throw new Error(`Không tìm thấy crash report "${id}".`);
    return { deleted: true };
  });

  ipcMain.handle('crash-reports:delete-all', () => {
    return { deleted: getCrashReportStore().deleteAll() };
  });

  ipcMain.handle(
    'crash-report:renderer',
    (_event: unknown, payload: { message?: unknown; stack?: unknown }) => {
      const message = typeof payload?.message === 'string' ? payload.message.slice(0, 65536) : '';
      const stack = typeof payload?.stack === 'string' ? payload.stack.slice(0, 65536) : undefined;
      if (message.trim() === '') return { saved: false };
      const report = getCrashCollector().captureRendererError({ message, ...(stack ? { stack } : {}) });
      return { saved: report !== null, ...(report ? { id: report.id } : {}) };
    },
  );

  // --- v0.29 (P0-2): hooks — liệt kê + bật/tắt trong Settings ---
  // Registry này sống ở main và CHỈ quản lý trạng thái bật/tắt của các
  // hook có sẵn (denylist + glob-rules). Nó dùng chung file
  // `<userData>/hooks-enabled.json` với registry trong tiến trình
  // coordinator (cùng `stateDir`, xem skillsDirs.stateDir khi tạo bot):
  // bật/tắt ở đây ghi vào đúng file đó, và coordinator đọc lại trạng
  // thái này khi nó dựng registry của nó. Vì registry của coordinator
  // chỉ dựng một lần mỗi lần tiến trình con khởi động, thay đổi ở đây
  // áp dụng cho các run sau khi khởi động lại app (giống plugin: bot
  // tạo mới mới nhận trạng thái mới). Hook của bundle/plugin đăng ký
  // trong coordinator không hiện ở đây — chỉ 2 hook có sẵn.
  // Lưu ý an toàn: tắt hook denylist chỉ bỏ lớp chặn sớm PreToolUse;
  // `runShell()` vẫn chặn lệnh denylist ở tầng tool (defence-in-depth).
  let hookRegistry: HookRegistry | null = null;
  function getHookRegistry(): HookRegistry {
    if (!hookRegistry) {
      hookRegistry = new HookRegistry({ stateDir: app.getPath('userData') });
      hookRegistry.register(createDenylistHook());
      // Main không bao giờ chạy hook — loader rule chỉ là stub để hook
      // liệt kê được đúng tên/mô tả/sự kiện như trong coordinator.
      hookRegistry.register(createGlobRulesHook(() => []));
    }
    return hookRegistry;
  }

  ipcMain.handle('hooks:list', () => {
    const registry = getHookRegistry();
    return registry.list().map((h) => ({
      name: h.name,
      description: h.description ?? '',
      events: registry.effectiveEvents(h.name),
      source: h.source,
      enabled: h.enabled,
    }));
  });

  ipcMain.handle('hooks:toggle', (_event: unknown, payload: { name: string; enabled: boolean }) => {
    const name = requireString(payload?.name, 'name');
    const enabled = requireBoolean(payload?.enabled, 'enabled');
    const registry = getHookRegistry();
    const ok = enabled ? registry.enable(name) : registry.disable(name);
    if (!ok) throw new Error(`Không tìm thấy hook "${name}".`);
    return registry.get(name)?.enabled ?? false;
  });

  // --- v0.8: plugins — liệt kê + bật/tắt trong Settings ---
  // PluginManager sống ở main (đọc manifest + enabled.json). Bật/tắt chỉ
  // lật enabled.json; coordinator con quét lại pluginsDir mỗi lần tạo bot
  // nên bot tạo MỚI mới nhận trạng thái mới — bot đang chạy giữ nguyên
  // tool cho tới khi tạo lại.
  let pluginManager: PluginManager | null = null;
  function getPluginManager(): PluginManager {
    if (!pluginManager) {
      pluginManager = new PluginManager(path.join(app.getPath('userData'), 'plugins'));
    }
    return pluginManager;
  }

  ipcMain.handle('plugins:list', () => {
    const manager = getPluginManager();
    const plugins = manager.scanDir().map((p) => ({
      id: p.manifest.id,
      name: p.manifest.name,
      description: p.manifest.description,
      version: p.manifest.version,
      author: p.manifest.author ?? null,
      enabled: p.enabled,
      tools: p.loadedTools,
    }));
    const errors = manager.loadErrors().map((f) => ({ dir: f.dir, error: f.error.message }));
    return { plugins, errors };
  });

  ipcMain.handle('plugins:toggle', (_event: unknown, payload: { id: string; enabled: boolean }) => {
    const id = requireId(payload?.id, 'id');
    const enabled = requireBoolean(payload?.enabled, 'enabled');
    const manager = getPluginManager();
    manager.scanDir();
    const ok = enabled ? manager.enable(id) : manager.disable(id);
    if (!ok) throw new Error(`Không tìm thấy plugin "${id}".`);
    return { id, enabled: manager.isEnabled(id) };
  });

  // --- v0.14: plugin templates — tạo / liệt kê / cài / chia sẻ mẫu plugin ---
  // Template API sống trong @open-bot/core (packages/core/src/plugins/
  // templates.ts); main chỉ là cầu nối IPC, mọi validation (kể cả chặn
  // secret trong config) chạy trong core. Renderer không bao giờ require
  // core trực tiếp.
  function getPluginTemplatesDir(): string {
    return path.join(app.getPath('userData'), PLUGIN_TEMPLATES_DIR);
  }

  function getPluginsDir(): string {
    return path.join(app.getPath('userData'), 'plugins');
  }

  ipcMain.handle('plugin-templates:list', () => {
    return listPluginTemplates(getPluginTemplatesDir());
  });

  ipcMain.handle(
    'plugin-templates:create',
    (_event: unknown, payload: CreatePluginTemplateInput) => {
      if (payload === null || typeof payload !== 'object') {
        throw new Error('Tham số plugin-templates:create phải là object.');
      }
      const id = requireId(payload.id, 'id');
      const name = requireString(payload.name, 'name');
      const description = requireString(payload.description, 'description');
      const manifest = payload.manifest;
      if (manifest === null || typeof manifest !== 'object') {
        throw new Error('Tham số plugin-templates:create cần có "manifest" là object.');
      }
      const version = requireString(manifest.version, 'version');
      const main = requireString(manifest.main, 'main');
      const permissions = manifest.permissions;
      if (
        !Array.isArray(permissions) ||
        permissions.some((p) => typeof p !== 'string')
      ) {
        throw new Error('Tham số "permissions" phải là mảng chuỗi.');
      }
      const tools = manifest.tools;
      if (tools !== undefined && (!Array.isArray(tools) || tools.some((t) => typeof t !== 'string'))) {
        throw new Error('Tham số "tools" phải là mảng chuỗi khi có mặt.');
      }
      const config = payload.config;
      if (config !== undefined && (config === null || typeof config !== 'object' || Array.isArray(config))) {
        throw new Error('Tham số "config" phải là object khi có mặt.');
      }
      const template: PluginTemplate = createPluginTemplate({
        id,
        name,
        description,
        manifest: {
          id,
          name,
          version,
          description,
          author: optionalString(manifest.author, 'author'),
          permissions: [...permissions] as PluginTemplate['manifest']['permissions'],
          main,
          tools: tools ? [...tools] : undefined,
        },
        config: config ? { ...(config as Record<string, unknown>) } : undefined,
      });
      return savePluginTemplate(getPluginTemplatesDir(), template);
    },
  );

  ipcMain.handle(
    'plugin-templates:apply',
    (_event: unknown, payload: { id: string; overwrite?: boolean }) => {
      const id = requireId(payload?.id, 'id');
      const overwrite = payload?.overwrite === undefined ? false : requireBoolean(payload.overwrite, 'overwrite');
      const applied: AppliedPluginTemplate = applyPluginTemplate(
        getPluginTemplatesDir(),
        id,
        getPluginsDir(),
        { overwrite },
      );
      return applied;
    },
  );

  ipcMain.handle('plugin-templates:export', (_event: unknown, payload: { id: string }) => {
    const id = requireId(payload?.id, 'id');
    const template = getPluginTemplate(getPluginTemplatesDir(), id);
    if (!template) throw new Error(`Không tìm thấy plugin template "${id}".`);
    return { id, json: exportPluginTemplate(template) };
  });

  ipcMain.handle('plugin-templates:import', (_event: unknown, payload: { json: string }) => {
    const json = requireString(payload?.json, 'json');
    const template = importPluginTemplate(json);
    return savePluginTemplate(getPluginTemplatesDir(), template);
  });

  ipcMain.handle('plugin-templates:delete', (_event: unknown, payload: { id: string }) => {
    const id = requireId(payload?.id, 'id');
    return deletePluginTemplate(getPluginTemplatesDir(), id);
  });

  // --- v0.14: plugin:set-enabled — bật/tắt plugin và áp dụng cho bot đang chạy ---
  // Luôn ghi enabled.json trước (bot tạo mới dùng trạng thái này). Khi botId
  // trỏ tới một bot đang chạy trong tiến trình coordinator (có trong
  // `runtimes`), gọi CoordinatorClient.setPluginEnabled để bot đó áp dụng
  // ngay; coordinator chưa triển khai RPC này (điều phối viên viết sau)
  // hoặc bot không tồn tại thì chỉ báo lỗi rõ ràng, không crash, và vẫn
  // giữ trạng thái đã ghi vào enabled.json.
  ipcMain.handle(
    'plugin:set-enabled',
    async (_event: unknown, payload: { botId?: string | null; pluginId: string; enabled: boolean }) => {
      const pluginId = requireId(payload?.pluginId, 'pluginId');
      const enabled = requireBoolean(payload?.enabled, 'enabled');
      const botId =
        payload?.botId === undefined || payload?.botId === null
          ? null
          : requireId(payload.botId, 'botId');
      const manager = getPluginManager();
      manager.scanDir();
      const ok = enabled ? manager.enable(pluginId) : manager.disable(pluginId);
      if (!ok) throw new Error(`Không tìm thấy plugin "${pluginId}".`);
      const result: {
        id: string;
        enabled: boolean;
        appliedToRunning: boolean;
        runningError?: string;
      } = { id: pluginId, enabled: manager.isEnabled(pluginId), appliedToRunning: false };
      if (botId === null) return result;
      if (!runtimes.has(botId)) {
        result.runningError = 'Bot chưa chạy nên trạng thái mới chỉ áp dụng cho lần tạo bot sau.';
        return result;
      }
      try {
        const res = await getCoordinator().setPluginEnabled(botId, pluginId, enabled);
        result.appliedToRunning = res.appliedToRunning === true && res.ok !== false;
        result.enabled = res.enabled;
        if (!result.appliedToRunning) {
          result.runningError = 'Coordinator chưa áp dụng được thay đổi cho bot đang chạy.';
        }
      } catch (e) {
        result.runningError =
          e instanceof Error ? e.message : 'Không liên lạc được với coordinator.';
      }
      return result;
    },
  );

  // --- v0.4: automations ---
  ipcMain.handle('automations:list', () => automationScheduler?.list() ?? []);

  // --- v0.74d: nạp dữ liệu mẫu (SAMPLE_AUTOMATIONS) vào store thật.
  // Sample đã có sẵn thì bỏ qua, không nhân đôi (xem
  // `seedSampleAutomations` trong scheduler).
  ipcMain.handle('automations:seed-samples', () => {
    if (!automationScheduler) throw new Error('Scheduler chưa khởi động.');
    return automationScheduler.seedSampleAutomations();
  });

  ipcMain.handle('automations:get', (_event: unknown, payload: { id: string }) => {
    const found = automationScheduler?.get(requireId(payload?.id, 'id'));
    if (!found) throw new Error('Không tìm thấy automation.');
    return found;
  });

  ipcMain.handle(
    'automations:create',
    (_event: unknown, payload: Omit<Automation, 'id' | 'createdAt' | 'updatedAt'>) => {
      if (!automationScheduler) throw new Error('Scheduler chưa khởi động.');
      if (payload === null || typeof payload !== 'object') throw new Error('Tham số automations:create phải là object.');
      if (payload.name !== undefined) requireString(payload.name, 'name');
      if (payload.botId) {
        const botId = requireId(payload.botId, 'botId');
        const bot = settings.bots.find((b) => b.id === botId);
        if (!bot) throw new Error('Không tìm thấy bot.');
      }
      return automationScheduler.create(payload);
    },
  );

  ipcMain.handle('automations:update', (_event: unknown, payload: Automation) => {
    if (!automationScheduler) throw new Error('Scheduler chưa khởi động.');
    if (payload === null || typeof payload !== 'object') throw new Error('Tham số automations:update phải là object.');
    requireId(payload.id, 'id');
    return automationScheduler.update(payload);
  });

  ipcMain.handle('automations:delete', (_event: unknown, payload: { id: string }) => {
    if (!automationScheduler) throw new Error('Scheduler chưa khởi động.');
    const id = requireId(payload?.id, 'id');
    const removed = automationScheduler.remove(id);
    // Best-effort: a deleted automation must not leave a live webhook key behind.
    if (removed) {
      try {
        deleteAutomationWebhookKey(webhookKeyStores(), id);
      } catch {
        // Key cleanup is best-effort; the automation itself is gone.
      }
      // v0.83b: same for Composio trigger secrets (signing secret + URL token).
      try {
        deleteComposioTriggerSecrets(vault, id);
      } catch {
        // Key cleanup is best-effort; the automation itself is gone.
      }
      // v0.87a (P2-2): same for the Slack inbound signing secret.
      try {
        deleteSlackSigningSecret(vault, id);
      } catch {
        // Key cleanup is best-effort; the automation itself is gone.
      }
    }
    return removed;
  });

  ipcMain.handle('automations:set-enabled', (_event: unknown, payload: { id: string; enabled: boolean }) => {
    if (!automationScheduler) throw new Error('Scheduler chưa khởi động.');
    return automationScheduler.setEnabled(
      requireId(payload?.id, 'id'),
      requireBoolean(payload?.enabled, 'enabled'),
    );
  });

  ipcMain.handle('automations:run-now', async (_event: unknown, payload: { id: string }) => {
    if (!automationScheduler) throw new Error('Scheduler chưa khởi động.');
    return automationScheduler.runNow(requireId(payload?.id, 'id'));
  });

  ipcMain.handle('automations:runs', (_event: unknown, payload: { automationId?: string }) => {
    const automationId =
      payload?.automationId === undefined ? undefined : requireId(payload.automationId, 'automationId');
    return automationScheduler?.listRuns(automationId) ?? [];
  });

  // --- v0.52 P0-5: webhook trigger (keys in Vault, HMAC verify) ---
  // The secret is returned ONLY by create/rotate, exactly once. The
  // renderer must show it once and never store it; `exists` is the
  // only status check the UI gets (never a value).
  ipcMain.handle('automations:webhook-key:create', (_event: unknown, payload: { id: string }) => {
    if (!automationScheduler) throw new Error('Scheduler chưa khởi động.');
    const id = requireId(payload?.id, 'id');
    const automation = automationScheduler.get(id);
    if (!automation) throw new Error('Không tìm thấy automation.');
    if (automation.trigger.kind !== 'webhook') {
      throw new Error('Automation này không dùng trigger webhook.');
    }
    return createAutomationWebhookKey(webhookKeyStores(), id);
  });

  ipcMain.handle('automations:webhook-key:rotate', (_event: unknown, payload: { id: string }) => {
    if (!automationScheduler) throw new Error('Scheduler chưa khởi động.');
    const id = requireId(payload?.id, 'id');
    const automation = automationScheduler.get(id);
    if (!automation) throw new Error('Không tìm thấy automation.');
    if (automation.trigger.kind !== 'webhook') {
      throw new Error('Automation này không dùng trigger webhook.');
    }
    return rotateAutomationWebhookKey(webhookKeyStores(), id);
  });

  ipcMain.handle('automations:webhook-key:delete', (_event: unknown, payload: { id: string }) => {
    const id = requireId(payload?.id, 'id');
    return deleteAutomationWebhookKey(webhookKeyStores(), id);
  });

  ipcMain.handle('automations:webhook-key:exists', (_event: unknown, payload: { id: string }) => {
    const id = requireId(payload?.id, 'id');
    return hasAutomationWebhookKey(webhookKeyStores(), id);
  });

  // --- v0.83b: Composio trigger (delivery qua Local API) ---
  // Danh sách trigger đã đối chiếu live (50 mục) cho picker ở UI —
  // chỉ dữ liệu tĩnh, không chứa secret.
  ipcMain.handle('composio:trigger-defs', () => [...COMPOSIO_TRIGGER_DEFS]);
  // Signing secret: user DÁN secret webhook của project Composio
  // (COMPOSIO_WEBHOOK_SECRET) — open-bot không tự lấy được secret
  // này từ Composio. Lưu vào Vault, không bao giờ trả lại qua IPC.
  ipcMain.handle(
    'automations:composio-trigger-secret:set',
    (_event: unknown, payload: { id: string; secret: string }) => {
      if (!automationScheduler) throw new Error('Scheduler chưa khởi động.');
      const id = requireId(payload?.id, 'id');
      const automation = automationScheduler.get(id);
      if (!automation) throw new Error('Không tìm thấy automation.');
      if (automation.trigger.kind !== 'composio') {
        throw new Error('Automation này không dùng trigger Composio.');
      }
      if (typeof payload?.secret !== 'string') throw new Error('Secret phải là string.');
      setComposioTriggerSigningSecret(vault, id, payload.secret);
      return { ok: true as const };
    },
  );
  ipcMain.handle('automations:composio-trigger-secret:exists', (_event: unknown, payload: { id: string }) => {
    const id = requireId(payload?.id, 'id');
    return hasComposioTriggerSigningSecret(vault, id);
  });
  ipcMain.handle('automations:composio-trigger-secret:delete', (_event: unknown, payload: { id: string }) => {
    const id = requireId(payload?.id, 'id');
    return deleteComposioTriggerSigningSecret(vault, id);
  });
  // --- v0.87a (P2-2): Slack inbound (delivery trực tiếp từ Slack) ---
  // Signing secret: user DÁN Signing Secret của Slack app (Slack app
  // settings → Basic Information) — open-bot không tự lấy được secret
  // này từ Slack. Lưu vào Vault, không bao giờ trả lại qua IPC. Một
  // Slack app chỉ có một secret nên cùng một giá trị được dán cho mọi
  // automation nghe app đó.
  ipcMain.handle(
    'automations:slack-signing-secret:set',
    (_event: unknown, payload: { id: string; secret: string }) => {
      if (!automationScheduler) throw new Error('Scheduler chưa khởi động.');
      const id = requireId(payload?.id, 'id');
      const automation = automationScheduler.get(id);
      if (!automation) throw new Error('Không tìm thấy automation.');
      if (automation.trigger.kind !== 'composio' || !isSlackMessageTriggerSlug(automation.trigger.triggerSlug)) {
        throw new Error('Automation này không nghe tin nhắn Slack.');
      }
      if (typeof payload?.secret !== 'string') throw new Error('Secret phải là string.');
      setSlackSigningSecret(vault, id, payload.secret);
      return { ok: true as const };
    },
  );
  ipcMain.handle('automations:slack-signing-secret:exists', (_event: unknown, payload: { id: string }) => {
    const id = requireId(payload?.id, 'id');
    return hasSlackSigningSecret(vault, id);
  });
  ipcMain.handle('automations:slack-signing-secret:delete', (_event: unknown, payload: { id: string }) => {
    const id = requireId(payload?.id, 'id');
    return deleteSlackSigningSecret(vault, id);
  });
  // URL token (?token=): tạo/xoay trả secret ĐÚNG MỘT LẦN (renderer
  // phải hiện ngay, không lưu lại); `exists` là check duy nhất.
  ipcMain.handle('automations:composio-trigger-token:create', (_event: unknown, payload: { id: string }) => {
    if (!automationScheduler) throw new Error('Scheduler chưa khởi động.');
    const id = requireId(payload?.id, 'id');
    const automation = automationScheduler.get(id);
    if (!automation) throw new Error('Không tìm thấy automation.');
    if (automation.trigger.kind !== 'composio') {
      throw new Error('Automation này không dùng trigger Composio.');
    }
    return createComposioTriggerToken(vault, id);
  });
  ipcMain.handle('automations:composio-trigger-token:rotate', (_event: unknown, payload: { id: string }) => {
    if (!automationScheduler) throw new Error('Scheduler chưa khởi động.');
    const id = requireId(payload?.id, 'id');
    const automation = automationScheduler.get(id);
    if (!automation) throw new Error('Không tìm thấy automation.');
    if (automation.trigger.kind !== 'composio') {
      throw new Error('Automation này không dùng trigger Composio.');
    }
    return rotateComposioTriggerToken(vault, id);
  });
  ipcMain.handle('automations:composio-trigger-token:exists', (_event: unknown, payload: { id: string }) => {
    const id = requireId(payload?.id, 'id');
    return hasComposioTriggerToken(vault, id);
  });
  ipcMain.handle('automations:composio-trigger-token:delete', (_event: unknown, payload: { id: string }) => {
    const id = requireId(payload?.id, 'id');
    return deleteComposioTriggerToken(vault, id);
  });
  // Sign-and-deliver a MOCK Composio event with the stored secret
  // (the secret never leaves the main process). Lets the user verify
  // the whole trigger path end-to-end from the UI without Composio
  // sending anything real — same idea as `automations:webhook:test`.
  ipcMain.handle(
    'automations:composio-trigger:test',
    async (_event: unknown, payload: { id: string; data?: unknown }) => {
      if (!automationScheduler) throw new Error('Scheduler chưa khởi động.');
      const id = requireId(payload?.id, 'id');
      const automation = automationScheduler.get(id);
      if (!automation) throw new Error('Không tìm thấy automation.');
      if (automation.trigger.kind !== 'composio') {
        throw new Error('Automation này không dùng trigger Composio.');
      }
      const secret = getComposioTriggerSigningSecret(vault, id);
      if (secret === null) throw new Error('Automation này chưa có Composio webhook secret — hãy dán secret trước.');
      const webhookId = `wh_test_${Date.now()}`;
      const timestamp = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({
        id: `msg_test_${Date.now()}`,
        type: 'composio.trigger.message',
        metadata: {
          trigger_slug: automation.trigger.triggerSlug,
          trigger_id: 'ti_test',
          connected_account_id: 'ca_test',
          user_id: 'test-user',
        },
        data: payload?.data ?? { test: true, at: new Date().toISOString() },
        timestamp: new Date().toISOString(),
      });
      const signature = computeComposioWebhookSignature(secret, webhookId, timestamp, body);
      return automationScheduler.handleComposioTrigger(id, body, {
        webhookId,
        webhookTimestamp: timestamp,
        webhookSignature: signature,
      });
    },
  );
  // Sign-and-deliver a MOCK Slack Events API message with the stored
  // signing secret (the secret never leaves the main process). Lets
  // the user verify the whole direct-Slack path end-to-end from the
  // UI without Slack sending anything real — same idea as
  // `automations:composio-trigger:test`. The mock event is a plain
  // channel message; `payload.text` overrides the message text and
  // `payload.channelType` overrides the channel kind ('channel' /
  // 'im' / 'group') so the slug-match check can be exercised too.
  ipcMain.handle(
    'automations:slack-inbound:test',
    async (_event: unknown, payload: { id: string; text?: string; channelType?: string }) => {
      if (!automationScheduler) throw new Error('Scheduler chưa khởi động.');
      const id = requireId(payload?.id, 'id');
      const automation = automationScheduler.get(id);
      if (!automation) throw new Error('Không tìm thấy automation.');
      if (automation.trigger.kind !== 'composio' || !isSlackMessageTriggerSlug(automation.trigger.triggerSlug)) {
        throw new Error('Automation này không nghe tin nhắn Slack.');
      }
      const secret = getSlackSigningSecret(vault, id);
      if (secret === null) throw new Error('Automation này chưa có Slack signing secret — hãy dán secret trước.');
      const channelType =
        payload?.channelType === 'im' || payload?.channelType === 'group' ? payload.channelType : 'channel';
      const timestamp = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({
        token: 'test-verification-token',
        team_id: 'T_TEST',
        api_app_id: 'A_TEST',
        type: 'event_callback',
        event: {
          type: 'message',
          channel: channelType === 'im' ? 'D_TEST' : 'C_TEST',
          user: 'U_TEST',
          text: typeof payload?.text === 'string' && payload.text !== '' ? payload.text : 'Hello from the Slack test button.',
          ts: `${Math.floor(Date.now() / 1000)}.000001`,
          team: 'T_TEST',
          channel_type: channelType,
          event_ts: `${Math.floor(Date.now() / 1000)}.000001`,
        },
      });
      const signature = computeSlackSignature(secret, timestamp, body);
      return automationScheduler.handleSlackInbound(id, body, {
        signature,
        timestamp,
      });
    },
  );

  // Deliver a webhook: the host passes the EXACT raw body it received
  // plus the `x-open-bot-signature` header value. The scheduler
  // verifies HMAC before running anything; a bad signature throws and
  // no run is recorded. The same path is served over HTTP by the
  // Local API (`POST /v1/automations/:id/webhook`, v0.59) — the UI
  // test button below exercises it through IPC instead.
  ipcMain.handle(
    'automations:webhook',
    async (_event: unknown, payload: { id: string; body: string; signature?: string | null }) => {
      if (!automationScheduler) throw new Error('Scheduler chưa khởi động.');
      if (payload === null || typeof payload !== 'object') throw new Error('Tham số automations:webhook phải là object.');
      const id = requireId(payload.id, 'id');
      if (typeof payload.body !== 'string') throw new Error('Webhook body phải là string (raw body).');
      return automationScheduler.handleWebhook(id, payload.body, payload.signature ?? null);
    },
  );

  // Sign-and-deliver a test webhook with the stored key (the secret
  // never leaves the main process). Lets the user verify the HMAC
  // path end-to-end from the UI without handling the secret.
  ipcMain.handle(
    'automations:webhook:test',
    async (_event: unknown, payload: { id: string; payload?: unknown }) => {
      if (!automationScheduler) throw new Error('Scheduler chưa khởi động.');
      const id = requireId(payload?.id, 'id');
      const secret = getAutomationWebhookKey(webhookKeyStores(), id);
      if (secret === null) throw new Error('Automation này chưa có webhook key — hãy tạo key trước.');
      const body = JSON.stringify(payload?.payload ?? { test: true, at: new Date().toISOString() });
      const signature = computeWebhookSignature(secret, body);
      return automationScheduler.handleWebhook(id, body, signature);
    },
  );

  // --- v0.52 P0-5: retry a failed run with the same input ---
  ipcMain.handle(
    'automations:retry-run',
    async (_event: unknown, payload: { runId?: string; automationId?: string }) => {
      if (!automationScheduler) throw new Error('Scheduler chưa khởi động.');
      if (payload === null || typeof payload !== 'object') throw new Error('Tham số automations:retry-run phải là object.');
      if (typeof payload.runId === 'string' && payload.runId) {
        return automationScheduler.retryRun(requireId(payload.runId, 'runId'));
      }
      if (typeof payload.automationId === 'string' && payload.automationId) {
        return automationScheduler.retryLastFailedRun(requireId(payload.automationId, 'automationId'));
      }
      throw new Error('Cần runId hoặc automationId để retry.');
    },
  );

  // --- v0.4: dream ---
  ipcMain.handle('dream:get', () => ({ ...dreamConfig }));

  ipcMain.handle('dream:set', (_event: unknown, payload: DreamConfig) => {
    if (payload === null || typeof payload !== 'object') throw new Error('Tham số dream:set phải là object.');
    requireBoolean(payload.enabled, 'enabled');
    if (payload.idleMinutes !== undefined) requireInt(payload.idleMinutes, 'idleMinutes', 5, 240);
    return saveDreamConfig(payload);
  });

  // --- v0.4: voice ---
  // v0.81: TTS (local-first) — one harness for the whole app; the
  // system engine is probed lazily on first use, and speak() never
  // throws (no engine -> { spoken: false, reason }).
  const ttsHarness = new TtsHarness();
  ipcMain.handle('tts:status', async () => ttsHarness.status());
  ipcMain.handle('tts:voices', async (_event: unknown, payload: { lang?: string }) => {
    const lang = typeof payload?.lang === 'string' ? payload.lang : undefined;
    return ttsHarness.listVoices(lang);
  });
  // v0.83: TTS stop — kill the utterance that is still speaking
  // (SIGKILL on the engine process; the in-flight `tts:speak`
  // promise then resolves `{ spoken: false, reason: 'stopped' }`).
  // Never throws; `{ stopped: false }` when nothing is speaking.
  ipcMain.handle('tts:stop', async () => ttsHarness.stop());
  ipcMain.handle(
    'tts:speak',
    async (
      _event: unknown,
      payload: { text: string; lang?: string; voice?: string; rate?: number },
    ) => {
      const text = typeof payload?.text === 'string' ? payload.text : '';
      const lang = typeof payload?.lang === 'string' ? payload.lang : undefined;
      const voice = typeof payload?.voice === 'string' ? payload.voice : undefined;
      const rate =
        typeof payload?.rate === 'number' && Number.isFinite(payload.rate)
          ? payload.rate
          : undefined;
      return ttsHarness.speak(text, { ...(lang ? { lang } : {}), ...(voice ? { voice } : {}), ...(rate !== undefined ? { rate } : {}) });
    },
  );

  ipcMain.handle('voice:available', (_event: unknown, payload: { botId: string }) => {
    const botId = requireId(payload?.botId, 'botId');
    const bot = settings.bots.find((b) => b.id === botId);
    if (!bot) return { available: false };
    return { available: realtimeConfigFor(bot) !== null };
  });

  ipcMain.handle('voice:connect', async (_event: unknown, payload: { botId: string }) => {
    const botId = requireId(payload?.botId, 'botId');
    const bot = settings.bots.find((b) => b.id === botId);
    if (!bot) return { ok: false, error: 'Không tìm thấy bot.' };
    const cfg = realtimeConfigFor(bot);
    if (!cfg) return { ok: false, error: 'Provider này chưa cấu hình voice realtime.' };
    // v0.56: session sở hữu cả RealtimeClient lẫn VoiceCallHarness —
    // connect gửi kèm instructions đã gắn surface guidance + đúng 10
    // tool voice (session tự lo; main chỉ đưa base instructions).
    const session = getOrCreateVoiceSession(bot.id);
    if (session.isConnected()) return { ok: true };
    try {
      const config: RealtimeConfig = {
        url: cfg.url,
        apiKey: cfg.apiKey,
        model: bot.model,
        instructions: bot.systemPrompt,
      };
      await session.connect(config);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Không kết nối được voice.' };
    }
  });

  /** Renderer gửi từng frame PCM16 (16 kHz mono) thu qua AudioWorklet.
   *  Session kiểm tra frame (Uint8Array, độ dài byte chẵn) rồi mới
   *  đưa xuống RealtimeClient — frame hỏng thì bỏ, không crash main. */
  ipcMain.on('voice:audio', (_event: unknown, payload: { botId: string; audioBase64: string }) => {
    // v0.7: handler `.on` không được throw (sẽ thành uncaught
    // exception) — tham số sai thì bỏ frame, không crash main.
    try {
      const botId = requireId(payload?.botId, 'botId');
      const audioBase64 = requireBase64(payload?.audioBase64, 'audioBase64');
      const session = voiceSessions.get(botId);
      if (!session?.isConnected()) return;
      session.sendAudio(new Uint8Array(Buffer.from(audioBase64, 'base64')));
    } catch {
      // Gửi khi rớt mạng / tham số sai: bỏ frame, không crash main.
    }
  });

  /** Kết thúc câu nói: commit buffer + xin model trả lời. */
  ipcMain.handle('voice:commit', (_event: unknown, payload: { botId: string }) => {
    const botId = requireId(payload?.botId, 'botId');
    const session = voiceSessions.get(botId);
    if (!session?.isConnected()) return { ok: false, error: 'Chưa kết nối voice.' };
    try {
      session.commitAudio();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Không kết nối được voice.' };
    }
  });

  ipcMain.handle('voice:disconnect', (_event: unknown, payload: { botId: string }) => {
    const botId = requireId(payload?.botId, 'botId');
    // Ngắt cuộc gọi nhưng GIỮ surface đã đăng ký: user gọi lại từ
    // cùng một view thì không cần đăng ký lại (dispose chỉ khi xoá bot).
    voiceSessions.get(botId)?.disconnect();
    return { ok: true };
  });

  // --- v0.95 (Đội D3): voice realtime 2 chiều (RealtimeSession) ---
  //
  // Khác đường voice:connect cũ (VoiceCallSession + RealtimeClient
  // OpenAI-only): đường này chọn adapter theo provider của bot
  // (gemini -> Gemini Live, openai/openai-compatible -> OpenAI wire),
  // có barge-in + turn-taking (server_vad / local_vad / push_to_talk).
  // Mic frames đi kênh riêng 'voice:realtime-audio' để không lẫn với
  // voice:audio của call cũ; transcript/audio vẫn về các channel
  // voice:* đã có nên CallView hiện tại dùng lại được.
  ipcMain.handle(
    'voice:realtime-connect',
    async (
      _event: unknown,
      payload: { botId: string; provider?: string; turnMode?: string },
    ) => {
      const botId = requireId(payload?.botId, 'botId');
      const bot = settings.bots.find((b) => b.id === botId);
      if (!bot) return { ok: false, error: 'Không tìm thấy bot.' };
      const provider = realtimeProviderFor(bot, payload?.provider);
      const turnMode: TurnTakingMode = isTurnTakingMode(payload?.turnMode)
        ? payload.turnMode
        : 'server_vad';
      const apiKey = vault.getSecret('provider', bot.providerId) ?? undefined;
      // v0.96 (Đội T5 — voice live): no key and no custom URL →
      // mock fallback (scripted replies, no network) instead of an
      // error — the app keeps working at $0. The panel shows the
      // mock status, so the user always knows it is not live.
      const useMock = !apiKey && !settings.providers[bot.providerId]?.realtimeUrl;
      // Một bot chỉ giữ một đường voice live: realtime mới thay thế
      // call cũ đang mở (nếu có).
      voiceSessions.get(bot.id)?.disconnect();
      const session = getOrCreateRealtimeSession(bot, provider, turnMode, useMock);
      if (session.isConnected()) {
        return {
          ok: true,
          provider,
          turnMode,
          state: session.getState(),
          mock: useMock,
          health: session.getHealth(),
          latency: session.getLatencyStats(),
          sessionId: session.getSessionId(),
        };
      }
      try {
        const config: RealtimeConfig = {
          url:
            provider === 'gemini'
              ? undefined
              : (settings.providers[bot.providerId]?.realtimeUrl ??
                buildOpenAiRealtimeUrl(bot.model)),
          apiKey,
          model: bot.model,
          instructions: bot.systemPrompt,
        };
        await session.connect(config);
        // v0.96 (Đội T5): health + latency ride back with the
        // connect result so the panel can show per-adapter status
        // without another round-trip.
        return {
          ok: true,
          provider,
          turnMode,
          state: session.getState(),
          mock: useMock,
          health: session.getHealth(),
          latency: session.getLatencyStats(),
          sessionId: session.getSessionId(),
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Không kết nối được voice realtime.' };
      }
    },
  );

  // v0.96 (Đội T5 — voice live): per-adapter health for the panel
  // (key configured? connected? connect / first-audio latency?).
  // No network, no key material — only the health snapshot.
  ipcMain.handle('voice:realtime-health', (_event: unknown, payload: { botId: string }) => {
    const botId = requireId(payload?.botId, 'botId');
    const session = realtimeSessions.get(botId);
    if (!session) return { ok: false, error: 'Chưa có realtime session cho bot này.' };
    return {
      ok: true,
      health: session.getHealth(),
      latency: session.getLatencyStats(),
      sessionId: session.getSessionId(),
      transcript: session.getTranscriptLines(),
    };
  });

  ipcMain.handle('voice:realtime-disconnect', (_event: unknown, payload: { botId: string }) => {
    const botId = requireId(payload?.botId, 'botId');
    realtimeSessions.get(botId)?.disconnect();
    return { ok: true };
  });

  ipcMain.handle(
    'voice:realtime-mode',
    (_event: unknown, payload: { botId: string; turnMode: string }) => {
      const botId = requireId(payload?.botId, 'botId');
      if (!isTurnTakingMode(payload?.turnMode)) {
        return { ok: false, error: `Chế độ turn-taking không hợp lệ: ${String(payload?.turnMode ?? '')}.` };
      }
      const session = realtimeSessions.get(botId);
      if (!session) return { ok: false, error: 'Chưa có realtime session cho bot này.' };
      session.setTurnMode(payload.turnMode);
      return { ok: true, turnMode: session.getTurnMode() };
    },
  );

  ipcMain.handle(
    'voice:realtime-talk',
    (_event: unknown, payload: { botId: string; held: boolean }) => {
      const botId = requireId(payload?.botId, 'botId');
      const session = realtimeSessions.get(botId);
      if (!session?.isConnected()) return { ok: false, error: 'Chưa kết nối voice realtime.' };
      const held = payload?.held === true;
      const applied = held ? session.startTalk() : session.endTalk();
      return { ok: true, applied, talkHeld: held && applied };
    },
  );

  ipcMain.handle('voice:realtime-interrupt', (_event: unknown, payload: { botId: string }) => {
    const botId = requireId(payload?.botId, 'botId');
    const session = realtimeSessions.get(botId);
    if (!session?.isConnected()) return { ok: false, error: 'Chưa kết nối voice realtime.' };
    return { ok: true, interrupted: session.interrupt() };
  });

  /** Mic frames cho realtime session (kênh riêng, không lẫn voice:audio). */
  ipcMain.on('voice:realtime-audio', (_event: unknown, payload: { botId: string; audioBase64: string }) => {
    try {
      const botId = requireId(payload?.botId, 'botId');
      const audioBase64 = requireBase64(payload?.audioBase64, 'audioBase64');
      const session = realtimeSessions.get(botId);
      if (!session?.isConnected()) return;
      session.pushAudioFrame(new Uint8Array(Buffer.from(audioBase64, 'base64')));
    } catch {
      // Gửi khi rớt mạng / tham số sai: bỏ frame, không crash main.
    }
  });

  // --- v0.56: voice:surface — surface register qua IPC ---
  //
  // Surface = màn hình user đang nhìn trong lúc gọi voice (chat view /
  // call view...). Renderer đăng ký khi view mở, huỷ khi view đóng;
  // surface mới nhất trở thành surface on record của harness (quyết
  // định guidance trong session instructions + cap độ dài câu trả lời
  // thoại). Event voice:* nào cũng mang surface + surfaceIds để
  // surface chỉ nhận đúng event của bot mình.
  ipcMain.handle(
    'voice:surface-register',
    (_event: unknown, payload: { botId: string; surface: string; view?: string }) => {
      const botId = requireId(payload?.botId, 'botId');
      const bot = settings.bots.find((b) => b.id === botId);
      if (!bot) return { ok: false, error: 'Không tìm thấy bot.' };
      if (!isVoiceSurface(payload?.surface)) {
        return { ok: false, error: `Surface voice không hợp lệ: ${String(payload?.surface ?? '')}.` };
      }
      const view = payload?.view ?? 'chat';
      if (view !== 'chat' && view !== 'call') {
        return { ok: false, error: `View surface không hợp lệ: ${String(view)}.` };
      }
      const session = getOrCreateVoiceSession(bot.id);
      const registration = session.registerSurface(payload.surface, view);
      return { ok: true, ...registration, maxReplyChars: session.getMaxReplyChars() };
    },
  );

  ipcMain.handle('voice:surface-unregister', (_event: unknown, payload: { surfaceId: string }) => {
    const surfaceId = requireId(payload?.surfaceId, 'surfaceId');
    for (const session of voiceSessions.values()) {
      if (session.unregisterSurface(surfaceId)) return { ok: true };
    }
    return { ok: false, error: 'Không tìm thấy surface đã đăng ký.' };
  });

  ipcMain.handle('voice:surface-list', (_event: unknown, payload?: { botId?: string }) => {
    if (payload?.botId !== undefined) {
      const botId = requireId(payload.botId, 'botId');
      return { ok: true, surfaces: voiceSessions.get(botId)?.listSurfaces() ?? [] };
    }
    const surfaces = [...voiceSessions.values()].flatMap((s) => s.listSurfaces());
    return { ok: true, surfaces };
  });

  /** STT dictation một lần qua PCM16 (deep-dive §5.6): renderer gửi
   *  audio PCM16 base64, main bọc WAV rồi gọi endpoint STT của
   *  provider (transcribeDictation). Đường realtime trong cuộc gọi
   *  vẫn là voice:audio → session.sendAudio → RealtimeClient. */
  ipcMain.handle(
    'voice:dictation',
    async (_event: unknown, payload: { botId: string; audioBase64: string }) => {
      const botId = requireId(payload?.botId, 'botId');
      const audioBase64 = requireBase64(payload?.audioBase64, 'audioBase64');
      const bot = settings.bots.find((b) => b.id === botId);
      if (!bot) return { ok: false, error: 'Không tìm thấy bot.' };
      const providerSettings = settings.providers[bot.providerId];
      if (!providerSettings?.baseUrl) {
        return { ok: false, error: 'Provider này chưa cấu hình endpoint STT.' };
      }
      const bytes = Buffer.from(audioBase64, 'base64');
      if (bytes.length === 0) return { ok: false, error: 'File ghi âm rỗng.' };
      if (bytes.length % 2 !== 0) {
        return { ok: false, error: 'Audio PCM16 phải có độ dài byte chẵn (16-bit samples).' };
      }
      if (bytes.length > DICTATION_MAX_BYTES) {
        return { ok: false, error: 'File ghi âm quá lớn (tối đa 25 MB).' };
      }
      try {
        const text = await transcribeDictation(new Uint8Array(bytes), {
          baseUrl: providerSettings.baseUrl,
          // v0.4: key lấy từ Vault, không từ settings.
          apiKey: vault.getSecret('provider', bot.providerId) ?? undefined,
          model: providerSettings.defaultModel || undefined,
        });
        return { ok: true, text };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Không chuyển được giọng nói thành text.' };
      }
    },
  );

  /** Voice memo: renderer thu bằng MediaRecorder (webm/opus), gửi bytes lên đây. */
  ipcMain.handle(
    'voice:memo-transcribe',
    async (_event: unknown, payload: { botId: string; audioBase64: string }) => {
      const botId = requireId(payload?.botId, 'botId');
      const audioBase64 = requireBase64(payload?.audioBase64, 'audioBase64');
      const bot = settings.bots.find((b) => b.id === botId);
      if (!bot) return { ok: false, error: 'Không tìm thấy bot.' };
      const providerSettings = settings.providers[bot.providerId];
      if (!providerSettings?.baseUrl) {
        return { ok: false, error: 'Provider này chưa cấu hình endpoint STT.' };
      }
      const bytes = Buffer.from(audioBase64, 'base64');
      if (bytes.length === 0) return { ok: false, error: 'File ghi âm rỗng.' };
      if (bytes.length > 25 * 1024 * 1024) {
        return { ok: false, error: 'File ghi âm quá lớn (tối đa 25 MB).' };
      }
      try {
        const text = await transcribeAudio(new Uint8Array(bytes), {
          baseUrl: providerSettings.baseUrl,
          // v0.4: key lấy từ Vault, không từ settings.
          apiKey: vault.getSecret('provider', bot.providerId) ?? undefined,
          model: providerSettings.defaultModel || undefined,
        });
        return { ok: true, text };
      } catch (err) {
        // Không log apiKey; message của transcribeAudio đã không chứa key.
        return { ok: false, error: err instanceof Error ? err.message : 'Không chuyển được giọng nói thành text.' };
      }
    },
  );

  // --- v0.4: hiệu năng ---
  ipcMain.handle('perf:stats', async () => {
    const poolStats = workerPool.stats();
    let cacheStats: unknown = null;
    try {
      cacheStats = await getCoordinator().cacheStats();
    } catch {
      cacheStats = null; // coordinator chưa chạy / chưa hỗ trợ → UI hiện "—"
    }
    return { ok: true, pool: poolStats, cache: cacheStats };
  });

  ipcMain.handle('cache:clear', async () => {
    try {
      await getCoordinator().clearCache();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Không xoá được cache.' };
    }
  });

  // --- v0.5: Model registry + Ollama local ---
  // Renderer gọi 'models:set-feature' cả cho default/fallback (feature
  // 'default'/'fallback') lẫn model theo feature thật, nên handler này
  // rẽ nhánh theo feature; hai channel riêng dưới đây là alias rõ nghĩa.

  function ollamaProvider(): OllamaProvider {
    return new OllamaProvider({
      id: 'ollama',
      label: 'Ollama',
      baseUrl: settings.providers['ollama']?.baseUrl || OLLAMA_BASE_URL,
      defaultModel: settings.providers['ollama']?.defaultModel || 'llama3.1',
    });
  }

  /** Model pull đang chạy nền (chống pull trùng cùng model). */
  const ollamaPullsInFlight = new Set<string>();

  ipcMain.handle('models:list', (): ModelRegistrySnapshot => {
    if (!modelRegistry) throw new Error('Model registry chưa khởi động.');
    return modelRegistry.snapshot();
  });

  // M4: provider rail cho ModelPicker — main tính từ snapshot detector
  // + catalogue + Vault (hasApiKey chỉ là boolean, rail không chứa
  // secret). detect() dùng cache 60s nên gọi lại sau Re-detect là đủ.
  // v0.90b (đội G): nhận thêm payload tuỳ chọn `{ disabledProviders,
  // currentProviderId }` để lọc rail theo bot (BotForm/App truyền danh
  // sách nguồn tắt của bot + provider hiện tại; không truyền = rail
  // toàn cục như trước — tương thích ngược với caller cũ).
  ipcMain.handle(
    'models:rail',
    async (
      _event: unknown,
      payload?: { disabledProviders?: unknown; currentProviderId?: unknown },
    ): Promise<ProviderRail> => {
      if (!modelRegistry) throw new Error('Model registry chưa khởi động.');
      const snapshot = modelRegistry.snapshot();
      const modelsByProvider: Record<string, string[]> = {};
      for (const [id, entry] of Object.entries(snapshot.providers)) {
        modelsByProvider[id] = entry.models.map((m) => m.id);
      }
      const engines = await getDetectedEngines().detect();
      const rail = buildProviderRail({
        providers: PROVIDERS,
        engines,
        modelsByProvider,
        hasApiKey: (id) => vault.hasSecret('provider', id),
        isConfigured: (id) =>
          (settings.providers[id]?.baseUrl ?? '').trim() !== '' || vault.hasSecret('provider', id),
      });
      if (payload === undefined || payload === null) return rail;
      if (typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Tham số models:rail phải là object.');
      }
      const disabled = cleanDisabledProviders(
        payload.disabledProviders,
        PROVIDERS.map((p) => p.id),
      );
      if (disabled.length === 0) return rail;
      const current =
        typeof payload.currentProviderId === 'string' && isKnownProvider(payload.currentProviderId)
          ? payload.currentProviderId
          : undefined;
      return filterRailForBot(rail, disabled, current).rail;
    },
  );

  ipcMain.handle(
    'models:set-feature',
    (_event: unknown, payload: { feature: string; providerId: string; model: string }) => {
      if (!modelRegistry) throw new Error('Model registry chưa khởi động.');
      const feature = requireString(payload?.feature, 'feature');
      const providerId = requireId(payload?.providerId, 'providerId');
      const model = requireString(payload?.model, 'model');
      if (feature === 'default') {
        modelRegistry.setDefault(providerId, model);
      } else if (feature === 'fallback') {
        modelRegistry.setFallback(providerId, model);
      } else {
        modelRegistry.setFeatureModel(feature, providerId, model);
      }
      modelRegistry.save();
      return modelRegistry.snapshot();
    },
  );

  ipcMain.handle(
    'models:set-default',
    (_event: unknown, payload: { providerId: string; model: string }) => {
      if (!modelRegistry) throw new Error('Model registry chưa khởi động.');
      modelRegistry.setDefault(requireId(payload?.providerId, 'providerId'), requireString(payload?.model, 'model'));
      modelRegistry.save();
      return modelRegistry.snapshot();
    },
  );

  ipcMain.handle(
    'models:set-fallback',
    (_event: unknown, payload: { providerId: string; model: string }) => {
      if (!modelRegistry) throw new Error('Model registry chưa khởi động.');
      modelRegistry.setFallback(requireId(payload?.providerId, 'providerId'), requireString(payload?.model, 'model'));
      modelRegistry.save();
      return modelRegistry.snapshot();
    },
  );

  ipcMain.handle(
    'models:set-flag',
    (_event: unknown, payload: { name: string; enabled: boolean }) => {
      if (!modelRegistry) throw new Error('Model registry chưa khởi động.');
      modelRegistry.setFeatureFlag(requireString(payload?.name, 'name'), requireBoolean(payload?.enabled, 'enabled'));
      modelRegistry.save();
      return modelRegistry.snapshot();
    },
  );

  // --- M1: Detected CLI engines (Settings → Engines) ---
  // Snapshot an toàn để gửi về renderer (chỉ nhãn/trạng thái, không
  // secret). detect() có cache 60s; redetect quét lại ngay.
  ipcMain.handle('engines:list', async (): Promise<DetectedEnginesSnapshot> => {
    return getDetectedEngines().detect();
  });

  // M3: sau mỗi lần quét lại / đổi trạng thái / thêm-sửa-xoá CLI tuỳ
  // chỉnh, main đẩy snapshot mới về renderer qua 'engines:changed'
  // để BotForm (model picker) cập nhật theo mà không cần mở lại form.
  ipcMain.handle('engines:redetect', async (): Promise<DetectedEnginesSnapshot> => {
    const snapshot = await getDetectedEngines().detect({ force: true });
    sendToRenderer('engines:changed', snapshot);
    return snapshot;
  });

  // M4: quét lại chỉ một engine (nút Re-detect từng engine trong
  // Settings → Engines) — nhanh hơn quét tất cả, snapshot mới cũng
  // được đẩy về renderer qua 'engines:changed'.
  ipcMain.handle(
    'engines:redetect-one',
    async (_event: unknown, payload: { kind: string }): Promise<DetectedEnginesSnapshot> => {
      const kind = requireString(payload?.kind, 'kind');
      const snapshot = await getDetectedEngines().redetectOne(kind);
      sendToRenderer('engines:changed', snapshot);
      return snapshot;
    },
  );

  ipcMain.handle(
    'engines:set-enabled',
    async (
      _event: unknown,
      payload: { kind: string; enabled: boolean },
    ): Promise<DetectedEnginesSnapshot> => {
      const kind = requireString(payload?.kind, 'kind');
      const enabled = requireBoolean(payload?.enabled, 'enabled');
      const registry = getDetectedEngines();
      registry.setEnabled(kind, enabled);
      const snapshot = await registry.detect({ force: true });
      sendToRenderer('engines:changed', snapshot);
      return snapshot;
    },
  );

  // M3: CLI ACP tuỳ chỉnh ("Set CLI…" trong Settings → Engines).
  // Payload chỉ chứa đường dẫn + argv (không secret — validate ở
  // core từ chối cờ key/token). Mỗi lần đổi xong đều quét lại ngay
  // (force) để snapshot trả về đã có engine mới + đẩy event cho picker.
  ipcMain.handle('engines:custom-list', () => {
    return getDetectedEngines().listCustomClis();
  });
  ipcMain.handle(
    'engines:custom-add',
    async (
      _event: unknown,
      payload: { id: string; label: string; binaryPath: string; acpArgs: string[]; statusArgs?: string[] },
    ): Promise<DetectedEnginesSnapshot> => {
      const registry = getDetectedEngines();
      const cfg = registry.addCustomCli({
        id: requireString(payload?.id, 'id'),
        label: requireString(payload?.label, 'label'),
        binaryPath: requireString(payload?.binaryPath, 'binaryPath'),
        acpArgs: payload?.acpArgs,
        statusArgs: payload?.statusArgs,
      });
      registry.setEnabled(customAcpKind(cfg.id), true);
      const snapshot = await registry.detect({ force: true });
      sendToRenderer('engines:changed', snapshot);
      return snapshot;
    },
  );

  ipcMain.handle(
    'engines:custom-update',
    async (
      _event: unknown,
      payload: { id: string; label?: string; binaryPath?: string; acpArgs?: string[]; statusArgs?: string[] },
    ): Promise<DetectedEnginesSnapshot> => {
      const registry = getDetectedEngines();
      const id = requireString(payload?.id, 'id');
      const patch: Record<string, unknown> = {};
      if (payload?.label !== undefined) patch['label'] = requireString(payload.label, 'label');
      if (payload?.binaryPath !== undefined) patch['binaryPath'] = requireString(payload.binaryPath, 'binaryPath');
      if (payload?.acpArgs !== undefined) patch['acpArgs'] = payload.acpArgs;
      if (payload?.statusArgs !== undefined) patch['statusArgs'] = payload.statusArgs;
      registry.updateCustomCli(id, patch);
      const snapshot = await registry.detect({ force: true });
      sendToRenderer('engines:changed', snapshot);
      return snapshot;
    },
  );

  ipcMain.handle(
    'engines:custom-remove',
    async (_event: unknown, payload: { id: string }): Promise<DetectedEnginesSnapshot> => {
      const registry = getDetectedEngines();
      registry.removeCustomCli(requireString(payload?.id, 'id'));
      const snapshot = await registry.detect({ force: true });
      sendToRenderer('engines:changed', snapshot);
      return snapshot;
    },
  );

  ipcMain.handle('models:ollama-list', async (): Promise<string[]> => {
    const names = await ollamaProvider().listLocalModels();
    // B-platform M3: model local đã pull gộp vào catalogue (nhãn "(local)")
    // để picker/rail hiện chúng ngay; best-effort, registry chưa khởi
    // tạo thì bỏ qua (không chặn việc trả danh sách cho renderer).
    modelRegistry?.setDiscoveredModels('ollama', names);
    return names;
  });

  ipcMain.handle(
    'models:ollama-pull',
    (_event: unknown, payload: unknown): { ok: boolean; error?: string } => {
      // Renderer gửi chuỗi trần; chấp nhận cả dạng { model } cho chắc.
      const model =
        typeof payload === 'string'
          ? payload.trim()
          : typeof payload === 'object' && payload !== null && typeof (payload as { model?: unknown }).model === 'string'
            ? (payload as { model: string }).model.trim()
            : '';
      if (!model) return { ok: false, error: 'Tên model không được để trống.' };
      if (ollamaPullsInFlight.has(model)) return { ok: true }; // đang pull rồi
      ollamaPullsInFlight.add(model);
      ollamaProvider()
        .pullModel(model)
        .then(() => {
          console.log(`[models] Ollama pull xong: ${model}`);
        })
        .catch((err: unknown) => {
          console.error(`[models] Ollama pull lỗi (${model}):`, (err as Error).message);
        })
        .finally(() => {
          ollamaPullsInFlight.delete(model);
        });
      return { ok: true };
    },
  );

  // --- v0.5: Local API + webhooks ---
  ipcMain.handle('api:get', () => ({
    enabled: apiConfig.enabled,
    port: apiConfig.port,
    tokenSet: vault.hasSecret(API_TOKEN_NAMESPACE, API_TOKEN_KEY),
    // v0.90d: Settings hiện lỗi khởi động (vd port bận sau 5 lần
    // thử lại) thay vì im lặng; `running` để UI phân biệt "đang
    // tắt" với "đang bật nhưng chưa chạy được".
    running: apiServer?.isRunning ?? false,
    lastError: apiStartError,
  }));

  ipcMain.handle('api:set', async (_event: unknown, patch: { enabled?: boolean; port?: number }) => {
    if (patch === null || typeof patch !== 'object') throw new Error('Tham số api:set phải là object.');
    if (patch.enabled !== undefined) requireBoolean(patch.enabled, 'enabled');
    if (patch.port !== undefined) requireInt(patch.port, 'port', 1024, 65535);
    const next = await applyApiConfig({
      enabled: patch.enabled ?? apiConfig.enabled,
      port: patch.port ?? apiConfig.port,
    });
    return {
      enabled: next.enabled,
      port: next.port,
      tokenSet: vault.hasSecret(API_TOKEN_NAMESPACE, API_TOKEN_KEY),
      running: apiServer?.isRunning ?? false,
      lastError: apiStartError,
    };
  });

  // Token chỉ trả về khi người dùng bấm "Hiện token" — renderer không
  // tự gọi channel này lúc load trang. KHÔNG log token.
  ipcMain.handle('api:get-token', () => ({ token: getOrCreateApiToken() }));

  ipcMain.handle('api:regenerate-token', async () => {
    const token = randomBytes(32).toString('hex');
    vault.setSecret(API_TOKEN_NAMESPACE, API_TOKEN_KEY, token);
    // Server đang chạy giữ token cũ trong closure -> khởi động lại để
    // token mới có hiệu lực ngay; token cũ mất hiệu lực tức thì.
    if (apiServer) {
      await stopApiServer();
      await startApiServer();
    }
    return { token };
  });

  ipcMain.handle('api:webhooks-list', () => getWebhookDispatcher().list());

  ipcMain.handle(
    'api:webhooks-add',
    (_event: unknown, payload: { url: string; events: string[] }) => {
      const url = requireHttpUrl(payload?.url, 'url');
      if (!Array.isArray(payload?.events) || payload.events.length === 0) {
        throw new Error('Webhook cần ít nhất 1 sự kiện.');
      }
      const allowed = ['run.done', 'run.error', 'approval.needed', 'automation.notify'];
      for (const e of payload.events) {
        if (typeof e !== 'string' || !allowed.includes(e)) {
          throw new Error(`Sự kiện webhook không hợp lệ: ${String(e)}.`);
        }
      }
      // WebhookDispatcher.add throw khi URL/events không hợp lệ;
      // renderer bắt lỗi và hiện settings.apiWebhookAddError.
      return getWebhookDispatcher().add(url, payload.events);
    },
  );

  ipcMain.handle('api:webhooks-remove', (_event: unknown, payload: unknown) => {
    const id =
      typeof payload === 'string'
        ? payload
        : typeof payload === 'object' && payload !== null && typeof (payload as { id?: unknown }).id === 'string'
          ? (payload as { id: string }).id
          : '';
    return getWebhookDispatcher().remove(id);
  });

  // --- v0.5: team workspace + service accounts + Vault NO_STORAGE ---
  /** Chuẩn hoá tham số IPC chấp nhận cả dạng trần lẫn dạng object. */
  function asStringParam(payload: unknown): string {
    if (typeof payload === 'string') return payload;
    if (payload && typeof payload === 'object' && typeof (payload as { dir?: unknown }).dir === 'string') {
      return (payload as { dir: string }).dir;
    }
    if (payload && typeof payload === 'object' && typeof (payload as { id?: unknown }).id === 'string') {
      return (payload as { id: string }).id;
    }
    throw new Error('Tham số không hợp lệ.');
  }

  function asBooleanParam(payload: unknown): boolean {
    if (typeof payload === 'boolean') return payload;
    if (payload && typeof payload === 'object' && typeof (payload as { enabled?: unknown }).enabled === 'boolean') {
      return (payload as { enabled: boolean }).enabled;
    }
    throw new Error('Tham số không hợp lệ.');
  }

  /** ServiceAccount (core, createdAt = epoch ms) -> dạng renderer đã khai báo. */
  function serviceAccountView(account: {
    id: string;
    name: string;
    scope: string;
    createdAt: number;
  }): { id: string; name: string; scope: string; createdAt: string } {
    return {
      id: account.id,
      name: account.name,
      scope: account.scope,
      createdAt: new Date(account.createdAt).toISOString(),
    };
  }

  ipcMain.handle('team:get-workspace', () => {
    const team = loadTeamConfig(app.getPath('userData'));
    return { dir: team.workspaceDir ?? '', teamId: getTeamId(team) };
  });

  ipcMain.handle('team:set-workspace-dir', (_event: unknown, payload: unknown) => {
    const dir = asStringParam(payload);
    // v0.7: thư mục team dùng chung có thể nằm ngoài userData (thư mục
    // chia sẻ của team), nhưng vẫn phải là đường dẫn tuyệt đối, không
    // rỗng — chặn đường dẫn tương đối kiểu `../../etc`.
    if (!path.isAbsolute(dir)) {
      throw new Error('Thư mục workspace của team phải là đường dẫn tuyệt đối.');
    }
    const team = loadTeamConfig(app.getPath('userData'));
    const next = setWorkspaceDir(team, dir);
    saveTeamConfig(app.getPath('userData'), next);
    return { dir: next.workspaceDir ?? '', teamId: getTeamId(next) };
  });

  ipcMain.handle('team:service-accounts-list', () => {
    const team = loadTeamConfig(app.getPath('userData'));
    return listServiceAccounts(team).map(serviceAccountView);
  });

  ipcMain.handle(
    'team:service-account-create',
    (_event: unknown, payload: { name: string; scope: ServiceAccountScope }) => {
      const name = requireString(payload?.name, 'name');
      const scope = payload?.scope;
      if (scope !== 'run' && scope !== 'admin') {
        throw new Error('Scope của service account phải là run hoặc admin.');
      }
      const team = loadTeamConfig(app.getPath('userData'));
      // createServiceAccount trả về { team, account } (helper pure):
      // team mới nằm trong kết quả, KHÔNG phải chỉ account.
      const { team: next, account } = createServiceAccount(team, {
        name,
        scope,
      });
      // Token sinh Ở MAIN, chưa từng tồn tại ở core/renderer.
      const token = randomBytes(32).toString('base64url');
      // Lưu Vault trước khi lưu team.json: nếu lưu Vault lỗi thì chưa
      // có record nào trỏ tới token mồ côi.
      vault.setSecret('service-account', account.id, token);
      saveTeamConfig(app.getPath('userData'), next);
      // Token trả về DUY NHẤT 1 LẦN, trong đúng response này. Không log,
      // không lưu settings, không trả lại ở bất kỳ channel nào khác.
      return { ...serviceAccountView(account), token };
    },
  );

  ipcMain.handle('team:service-account-delete', (_event: unknown, payload: unknown) => {
    const id = asStringParam(payload);
    const team = loadTeamConfig(app.getPath('userData'));
    // revokeServiceAccount trả về { team, removed }.
    const { team: next, removed } = revokeServiceAccount(team, id);
    // Xoá Vault LUÔN, kể cả khi record không còn (tránh token mồ côi).
    vault.deleteSecret('service-account', id);
    if (removed) saveTeamConfig(app.getPath('userData'), next);
    return removed;
  });

  // --- Sóng B (đội platform): máy tính riêng cho từng bot --------------
  // Runtime lazy, rootDir `<userData>/computers`. Probe cache 30s để
  // không gọi powershell/df liên tục (đắt trên Windows).
  let computerRuntime: BotComputerRuntime | null = null;
  let computerProbeCache: { profile: MachineProfile; backends: ComputerBackend[]; at: number } | null = null;

  function getComputerRuntime(): BotComputerRuntime {
    if (!computerRuntime) {
      computerRuntime = new BotComputerRuntime({
        rootDir: path.join(app.getPath('userData'), 'computers'),
        // v0.90c (đội G gói C): auto-shed tự tạm dừng máy thì ghi 1
        // dòng vào audit log chung của app (team/audit.ts, cùng file
        // TeamStore dùng) — ghi lỗi thì chỉ warn, không hỏng tick.
        onAutoShed: ({ botId, reason }) => {
          try {
            appendAuditEvent(app.getPath('userData'), {
              actor: 'system',
              action: COMPUTER_AUTO_SHED_AUDIT_ACTION,
              target: `computer:${botId}`,
              detail: { reason },
            });
          } catch (err) {
            console.warn(`computers: không ghi được audit auto-shed cho ${botId}: ${(err as Error).message}`);
          }
        },
      });
      if (computerProbeCache) computerRuntime.setProfile(computerProbeCache.profile);
    }
    return computerRuntime;
  }

  async function getComputerProbe(): Promise<{ profile: MachineProfile; backends: ComputerBackend[] }> {
    const now = Date.now();
    if (computerProbeCache && now - computerProbeCache.at < 30_000) return computerProbeCache;
    const profile = await probeMachine();
    const backends = detectComputerBackends(profile);
    computerProbeCache = { profile, backends, at: now };
    if (computerRuntime) computerRuntime.setProfile(profile);
    return computerProbeCache;
  }

  function requireBotIds(payload: unknown): string[] {
    const botIds = (payload as { botIds?: unknown } | null)?.botIds;
    if (!Array.isArray(botIds) || botIds.length === 0) {
      throw new Error('botIds phải là mảng không rỗng.');
    }
    const out: string[] = [];
    for (const id of botIds) {
      if (typeof id !== 'string' || id.trim() === '') throw new Error('botIds chỉ chứa chuỗi botId không rỗng.');
      out.push(id);
    }
    return out;
  }

  function computerStatusView(botId: string) {
    const view = getComputerRuntime().statusView(botId);
    if (!view) throw new Error(`Không có máy-tính-bot cho bot "${botId}".`);
    return view;
  }

  ipcMain.handle('computers:probe', async () => {
    const { profile, backends } = await getComputerProbe();
    const busy = isHostBusy(profile);
    return { profile, backends, busy: busy.busy, ...(busy.reason ? { busyReason: busy.reason } : {}) };
  });

  ipcMain.handle('computers:plan', async (_event: unknown, payload: unknown) => {
    const botIds = requireBotIds(payload);
    const { profile, backends } = await getComputerProbe();
    const requests: BotComputerRequest[] = botIds.map((botId) => ({ botId }));
    return planComputers(profile, requests, backends);
  });

  ipcMain.handle('computers:create', async (_event: unknown, payload: unknown) => {
    const botIds = requireBotIds(payload);
    const { profile, backends } = await getComputerProbe();
    const requests: BotComputerRequest[] = botIds.map((botId) => ({ botId }));
    const plan = planComputers(profile, requests, backends);
    const runtime = getComputerRuntime();
    // Egress riêng từng máy: team override (nếu có) — không có thì
    // undefined (fail-closed ở gate: không gate thì box chạy như cũ).
    const team = loadTeamConfig(app.getPath('userData'));
    const egressPolicy = resolveTeamEgressPolicy(team);
    const allocatedBotIds = new Set<string>();
    for (const allocation of plan.allocations) {
      runtime.createComputer(allocation, egressPolicy ? { egressPolicy } : {});
      allocatedBotIds.add(allocation.botId);
    }
    // v0.90c: bot bị planner từ chối vì hết chỗ thì vào hàng đợi chờ
    // (thử lại ở tick computers:list khi capacity rảnh) thay vì mất.
    for (const rejected of plan.rejected) {
      if (allocatedBotIds.has(rejected.botId)) continue;
      try {
        runtime.enqueueComputer({ botId: rejected.botId }, rejected.reasonDetail ?? rejected.reason);
      } catch (err) {
        console.warn(`computers: không xếp hàng đợi được bot ${rejected.botId}: ${(err as Error).message}`);
      }
    }
    return runtime.listComputers().map((c) => computerStatusView(c.botId));
  });

  ipcMain.handle('computers:list', async () => {
    const runtime = getComputerRuntime();
    // v0.90c: tick scheduler trên probe cache 30s (không probe mới):
    // promote entry đủ chỗ + auto-shed (chỉ khi user đã bật opt-in).
    try {
      const { profile, backends } = await getComputerProbe();
      runtime.tickScheduler(profile, backends);
    } catch (err) {
      console.warn(`computers: tick scheduler lỗi: ${(err as Error).message}`);
    }
    const views = runtime.listComputers().map((c) => computerStatusView(c.botId));
    // v0.90c: kiểm tra sức khoẻ guest (ping) nền cho VM đang chạy —
    // fire-and-forget, throttle 15s/bot trong runtime; UI poll 5s sẽ
    // thấy kết quả ở lần list sau. Lỗi ở đây không làm hỏng list.
    for (const view of views) {
      if (view.computer.level === 'vm' && view.computer.state === 'running') {
        void runtime.refreshGuestHealth(view.computer.botId).catch(() => undefined);
      }
    }
    return views;
  });

  ipcMain.handle('computers:start', async (_event: unknown, payload: unknown) => {
    const botId = asStringParam(payload);
    await getComputerRuntime().startComputer(botId);
    return computerStatusView(botId);
  });

  ipcMain.handle('computers:pause', (_event: unknown, payload: unknown) => {
    const botId = asStringParam(payload);
    getComputerRuntime().pauseComputer(botId);
    return computerStatusView(botId);
  });

  ipcMain.handle('computers:resume', (_event: unknown, payload: unknown) => {
    const botId = asStringParam(payload);
    getComputerRuntime().resumeComputer(botId);
    return computerStatusView(botId);
  });

  ipcMain.handle('computers:stop', async (_event: unknown, payload: unknown) => {
    const botId = asStringParam(payload);
    await getComputerRuntime().stopComputer(botId);
    return computerStatusView(botId);
  });

  ipcMain.handle('computers:set-vm-image', (_event: unknown, payload: unknown) => {
    const rec = payload as { botId?: unknown; imagePath?: unknown } | null;
    const botId = typeof rec?.botId === 'string' && rec.botId.trim() !== '' ? rec.botId : '';
    const imagePath = typeof rec?.imagePath === 'string' && rec.imagePath.trim() !== '' ? rec.imagePath : '';
    if (!botId) throw new Error('botId không được rỗng.');
    if (!imagePath) throw new Error('imagePath không được rỗng.');
    if (!path.isAbsolute(imagePath)) {
      throw new Error('Đường dẫn disk image phải là đường dẫn tuyệt đối.');
    }
    getComputerRuntime().setVmImage(botId, imagePath);
    return computerStatusView(botId);
  });

  ipcMain.handle('computers:set-vm-network', (_event: unknown, payload: unknown) => {
    const rec = payload as { botId?: unknown; network?: unknown } | null;
    const botId = typeof rec?.botId === 'string' && rec.botId.trim() !== '' ? rec.botId : '';
    const network = rec?.network === 'nat' ? 'nat' : rec?.network === 'none' ? 'none' : '';
    if (!botId) throw new Error('botId không được rỗng.');
    if (!network) throw new Error("Chế độ mạng VM phải là 'none' hoặc 'nat'.");
    getComputerRuntime().setVmNetwork(botId, network);
    return computerStatusView(botId);
  });

  ipcMain.handle('computers:shed', async () => {
    // Giảm tải dùng probe TƯƠI (không dùng cache 30s) để quyết định
    // theo tải máy hiện tại.
    const profile = await probeMachine();
    const paused = await getComputerRuntime().shedIfBusy(profile);
    return { paused };
  });

  // v0.90c (đội G gói C): hàng đợi scheduler + auto-shed opt-in +
  // sức khoẻ guest agent.
  ipcMain.handle('computers:queue', () => {
    return getComputerRuntime().getSchedulerState();
  });

  ipcMain.handle('computers:set-priority', (_event: unknown, payload: unknown) => {
    const rec = payload as { botId?: unknown; priority?: unknown } | null;
    const botId = typeof rec?.botId === 'string' && rec.botId.trim() !== '' ? rec.botId : '';
    if (!botId) throw new Error('botId không được rỗng.');
    if (typeof rec?.priority !== 'number' || !Number.isFinite(rec.priority)) {
      throw new Error('priority phải là số 0..100.');
    }
    if (rec.priority < 0 || rec.priority > 100) {
      throw new Error('priority phải trong khoảng 0..100.');
    }
    return getComputerRuntime().setComputerPriority(botId, Math.floor(rec.priority));
  });

  ipcMain.handle('computers:set-auto-shed', (_event: unknown, payload: unknown) => {
    const rec = payload as { enabled?: unknown } | null;
    if (typeof rec?.enabled !== 'boolean') {
      throw new Error('enabled phải là boolean.');
    }
    return getComputerRuntime().setAutoShed(rec.enabled);
  });

  ipcMain.handle('computers:guest-health', async (_event: unknown, payload: unknown) => {
    const botId = asStringParam(payload);
    // Kiểm tra thật ngay (bypass throttle — user bấm nút Kiểm tra).
    return getComputerRuntime().checkGuestHealth(botId);
  });

  // Đội D (fleet): tầng fleet đa người dùng — mỗi workspace 1 OS user
  // + 1 service + 1 port loopback + thư mục riêng; core vẫn single-user.
  // Service chỉ bind 127.0.0.1 (loopback-trust), token health chỉ giữ
  // trong bộ nhớ của FleetManager. Actor = OS user đang chạy app.
  // (fleetManager khai báo ở module scope để before-quit dispose được.)
  function getFleetManager(): FleetManager {
    if (!fleetManager) {
      fleetManager = new FleetManager({ rootDir: path.join(app.getPath('userData'), 'fleet') });
    }
    return fleetManager;
  }

  function fleetActor(): string {
    try {
      return currentOsUser();
    } catch {
      return 'system';
    }
  }

  function asFleetCreateInput(payload: unknown): CreateFleetWorkspaceInput {
    const rec = (payload ?? {}) as Record<string, unknown>;
    if (typeof rec.name !== 'string' || rec.name.trim() === '') {
      throw new Error('Tên workspace không được rỗng.');
    }
    if (typeof rec.osUser !== 'string' || rec.osUser.trim() === '') {
      throw new Error('OS user không được rỗng.');
    }
    const input: CreateFleetWorkspaceInput = { name: rec.name.trim(), osUser: rec.osUser.trim() };
    if (typeof rec.serviceName === 'string' && rec.serviceName.trim() !== '') input.serviceName = rec.serviceName.trim();
    if (typeof rec.port === 'number') input.port = rec.port;
    if (typeof rec.cpuCores === 'number') input.cpuCores = rec.cpuCores;
    if (typeof rec.ramBytes === 'number') input.ramBytes = rec.ramBytes;
    if (typeof rec.diskBytes === 'number') input.diskBytes = rec.diskBytes;
    if (typeof rec.createdBy === 'string' && rec.createdBy.trim() !== '') input.createdBy = rec.createdBy.trim();
    return input;
  }

  function asFleetRole(payload: unknown): FleetRole {
    const rec = (payload ?? {}) as Record<string, unknown>;
    const role = rec.role;
    if (role !== 'admin' && role !== 'member' && role !== 'chat-only') {
      throw new Error("role phải là 'admin', 'member' hoặc 'chat-only'.");
    }
    return role;
  }

  ipcMain.handle('fleet:list', () => getFleetManager().listFleet());
  ipcMain.handle('fleet:status', (_event: unknown, payload: unknown) => getFleetManager().getStatus(asStringParam(payload)));

  ipcMain.handle('fleet:create', async (_event: unknown, payload: unknown) =>
    getFleetManager().createWorkspace(asFleetCreateInput(payload), fleetActor()),
  );

  ipcMain.handle('fleet:remove', (_event: unknown, payload: unknown) => {
    const rec = (payload ?? {}) as Record<string, unknown>;
    getFleetManager().removeWorkspace(asStringParam(payload), fleetActor(), {
      deleteData: rec.deleteData === true,
    });
    return { removed: true };
  });

  ipcMain.handle('fleet:rename', (_event: unknown, payload: unknown) => {
    const rec = (payload ?? {}) as Record<string, unknown>;
    if (typeof rec.name !== 'string' || rec.name.trim() === '') throw new Error('Tên workspace không được rỗng.');
    return getFleetManager().renameWorkspace(asStringParam(payload), rec.name, fleetActor());
  });

  ipcMain.handle('fleet:suspend', async (_event: unknown, payload: unknown) =>
    getFleetManager().suspendWorkspace(asStringParam(payload), fleetActor()),
  );

  ipcMain.handle('fleet:activate', (_event: unknown, payload: unknown) =>
    getFleetManager().activateWorkspace(asStringParam(payload), fleetActor()),
  );

  ipcMain.handle('fleet:start', async (_event: unknown, payload: unknown) =>
    getFleetManager().startService(asStringParam(payload), fleetActor()),
  );

  ipcMain.handle('fleet:stop', async (_event: unknown, payload: unknown) =>
    getFleetManager().stopService(asStringParam(payload), fleetActor()),
  );

  ipcMain.handle('fleet:restart', async (_event: unknown, payload: unknown) =>
    getFleetManager().restartService(asStringParam(payload), fleetActor()),
  );

  ipcMain.handle('fleet:health', async (_event: unknown, payload: unknown) =>
    getFleetManager().healthCheck(asStringParam(payload)),
  );

  ipcMain.handle('fleet:capacity', async (_event: unknown, payload: unknown) => {
    const rec = (payload ?? {}) as Record<string, unknown>;
    const cpuCores = typeof rec.cpuCores === 'number' ? rec.cpuCores : 1;
    const ramBytes = typeof rec.ramBytes === 'number' ? rec.ramBytes : 512 * 1024 ** 2;
    const diskBytes = typeof rec.diskBytes === 'number' ? rec.diskBytes : 10 * 1024 ** 3;
    return getFleetManager().checkCapacity({ cpuCores, ramBytes, diskBytes });
  });

  ipcMain.handle('fleet:audit', (_event: unknown, payload: unknown) => {
    const rec = (payload ?? {}) as Record<string, unknown>;
    return getFleetManager().listAudit({
      ...(typeof rec.actor === 'string' ? { actor: rec.actor } : {}),
      ...(typeof rec.action === 'string' ? { action: rec.action } : {}),
      ...(typeof rec.target === 'string' ? { target: rec.target } : {}),
      ...(typeof rec.since === 'number' ? { since: rec.since } : {}),
      ...(typeof rec.until === 'number' ? { until: rec.until } : {}),
    });
  });

  ipcMain.handle('fleet:audit-verify', () => getFleetManager().verifyAudit());

  ipcMain.handle('fleet:decisions', (_event: unknown, payload: unknown) => {
    const rec = (payload ?? {}) as Record<string, unknown>;
    return getFleetManager().listDecisions({
      ...(typeof rec.actor === 'string' ? { actor: rec.actor } : {}),
      ...(typeof rec.action === 'string' ? { action: rec.action } : {}),
      ...(typeof rec.target === 'string' ? { target: rec.target } : {}),
      ...(rec.decision === 'allow' || rec.decision === 'deny' ? { decision: rec.decision } : {}),
      ...(typeof rec.since === 'number' ? { since: rec.since } : {}),
      ...(typeof rec.until === 'number' ? { until: rec.until } : {}),
    });
  });

  ipcMain.handle('fleet:decisions-verify', () => getFleetManager().verifyDecisions());

  ipcMain.handle('fleet:usage', (_event: unknown, payload: unknown) => {
    const rec = (payload ?? {}) as Record<string, unknown>;
    return getFleetManager().getUsage(asStringParam(payload), {
      ...(typeof rec.since === 'number' ? { since: rec.since } : {}),
    });
  });

  ipcMain.handle('fleet:record-usage', (_event: unknown, payload: unknown) =>
    getFleetManager().recordUsage(asStringParam(payload)),
  );

  ipcMain.handle('fleet:add-member', (_event: unknown, payload: unknown) => {
    const rec = (payload ?? {}) as Record<string, unknown>;
    if (typeof rec.userId !== 'string' || rec.userId.trim() === '') throw new Error('userId không được rỗng.');
    return getFleetManager().addMember(asStringParam(payload), { userId: rec.userId, role: asFleetRole(payload) }, fleetActor());
  });

  ipcMain.handle('fleet:remove-member', (_event: unknown, payload: unknown) => {
    const rec = (payload ?? {}) as Record<string, unknown>;
    if (typeof rec.userId !== 'string' || rec.userId.trim() === '') throw new Error('userId không được rỗng.');
    return getFleetManager().removeMember(asStringParam(payload), rec.userId, fleetActor());
  });

  ipcMain.handle('fleet:set-member-role', (_event: unknown, payload: unknown) => {
    const rec = (payload ?? {}) as Record<string, unknown>;
    if (typeof rec.userId !== 'string' || rec.userId.trim() === '') throw new Error('userId không được rỗng.');
    return getFleetManager().setMemberRole(asStringParam(payload), rec.userId, asFleetRole(payload), fleetActor());
  });

  // v0.15 (L5 audit): kèm số secret tạm để UI hỏi xác nhận trước
  // khi tắt NO_STORAGE (khi còn secret tạm thì tắt sẽ flush chúng).
  ipcMain.handle('vault:get-nostorage', () => ({
    enabled: vault.isNoStorage(),
    pendingSecrets: vault.countNoStoragePendingSecrets(),
  }));

  ipcMain.handle('vault:set-nostorage', (_event: unknown, payload: unknown) => {
    const enabled = asBooleanParam(payload);
    // v0.15 (L5 audit): renderer có thể gửi kèm opts trong cùng
    // payload `{ enabled, discardTemporarySecrets }` (asBooleanParam
    // đã chấp nhận dạng object này). `pendingSecrets` tính TRƯỚC khi
    // áp dụng = số secret tạm bị ảnh hưởng bởi lần tắt này.
    const discard =
      payload !== null &&
      typeof payload === 'object' &&
      (payload as { discardTemporarySecrets?: unknown }).discardTemporarySecrets === true;
    const pendingSecrets = vault.countNoStoragePendingSecrets();
    vault.setNoStorage(enabled, { discardTemporarySecrets: discard });
    // Lưu lựa chọn để lần mở sau áp lại (Vault không tự nhớ chế độ này).
    settings.vaultNoStorage = enabled;
    saveSettings();
    return { enabled: vault.isNoStorage(), pendingSecrets };
  });

  // --- v0.7: đăng nhập đa tầng + OAuth + tự cập nhật ---
  ipcMain.handle('auth:profile-get', (): LocalProfile => {
    if (!localProfile) localProfile = getLocalProfile(app.getPath('userData'));
    return { ...localProfile };
  });

  ipcMain.handle('auth:profile-set', (_event: unknown, payload: { displayName?: string }) => {
    const displayName = optionalString(payload?.displayName, 'displayName') ?? '';
    localProfile = setLocalDisplayName(app.getPath('userData'), displayName);
    return { ...localProfile };
  });

  ipcMain.handle('auth:identities-list', (): Array<{ providerId: string; identity: ProviderIdentity | null }> => {
    const out: Array<{ providerId: string; identity: ProviderIdentity | null }> = (
      PROVIDERS as Array<{ id: string }>
    ).map((p) => {
      let identity: ProviderIdentity | null = null;
      try {
        identity = getProviderIdentity(vault, p.id);
      } catch {
        identity = null; // identity hỏng: coi như chưa đăng nhập, không crash
      }
      return { providerId: p.id, identity };
    });
    // W11b: connector rows (slack / gmail / teams) for the Settings →
    // Connectors section, which reuses this IPC as its status source
    // (no new channel needed). A connector counts as connected only
    // when a TokenSet with an access token sits in Vault 'connector'
    // (written by startOAuthLogin); the identity supplies the display
    // name. No token -> identity null, even if a stale identity row
    // is left behind.
    for (const id of CONNECTOR_IDS) {
      let identity: ProviderIdentity | null = null;
      try {
        const raw = vault.getSecret('connector', id);
        let hasToken = false;
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as { accessToken?: unknown };
            hasToken = typeof parsed.accessToken === 'string' && parsed.accessToken.length > 0;
          } catch {
            hasToken = raw.length > 0; // token trần kiểu cũ
          }
        }
        if (hasToken) identity = getProviderIdentity(vault, id);
      } catch {
        identity = null;
      }
      out.push({ providerId: id, identity });
    }
    return out;
  });

  ipcMain.handle('auth:identity-delete', (_event: unknown, payload: { providerId: string }) => {
    const providerId = requireId(payload?.providerId, 'providerId');
    // W11b: signing out a connector also drops its TokenSet so the
    // connector really disconnects (tools go back to "not
    // connected"). The refresh token in 'oauth-refresh' goes with it
    // for slack/microsoft; for gmail the Google refresh token is
    // shared with the plain Google login, so it stays.
    if ((CONNECTOR_IDS as readonly string[]).includes(providerId)) {
      vault.deleteSecret('connector', providerId);
      if (providerId === 'slack') vault.deleteSecret('oauth-refresh', 'slack');
      if (providerId === 'teams') vault.deleteSecret('oauth-refresh', 'microsoft');
    }
    return deleteProviderIdentity(vault, providerId);
  });

  ipcMain.handle('auth:oauth-supported', () =>
    Object.values(OAUTH_PROVIDERS).map((p) => ({ id: p.id, label: p.label })),
  );

  ipcMain.handle(
    'auth:oauth-start',
    async (
      _event: unknown,
      payload: { providerId: string; clientId?: string; clientSecret?: string; connectorId?: string },
    ) => {
      const providerId = requireId(payload?.providerId, 'providerId');
      const clientId = optionalString(payload?.clientId, 'clientId', 512);
      const clientSecret = optionalString(payload?.clientSecret, 'clientSecret', 512);
      // W11b: which connector this login feeds ('gmail' when logging
      // in to Google for Gmail; slack/microsoft resolve to their own
      // connector when omitted, so the field is optional).
      const connectorId = optionalString(payload?.connectorId, 'connectorId', 64);
      if (
        connectorId !== undefined &&
        !(CONNECTOR_IDS as readonly string[]).includes(connectorId)
      ) {
        throw new Error(`Connector "${connectorId}" không hợp lệ.`);
      }
      const result = await startOAuthLogin(providerId, clientId, clientSecret, connectorId);
      // M7: login connector thành công thì đẩy TokenSet vào kho dùng
      // chung của coordinator đang chạy ngay — bot đã tạo trước lúc
      // kết nối cũng dùng được token mới, không cần tạo lại bot
      // (sửa giới hạn v0.19). Best-effort: Vault đã có token nên lần
      // mở sau / createBot sau vẫn seed được dù coordinator chưa chạy.
      if (
        result.ok &&
        connectorId !== undefined &&
        (CONNECTOR_IDS as readonly string[]).includes(connectorId) &&
        coordinator
      ) {
        try {
          const raw = vault.getSecret('connector', connectorId);
          if (raw) {
            const tokenSet = JSON.parse(raw) as TokenSet;
            if (typeof tokenSet.accessToken === 'string' && tokenSet.accessToken) {
              await coordinator
                .setSharedAppToken(connectorId, tokenSet, result.displayName)
                .catch(() => undefined);
            }
          }
        } catch {
          // Đẩy token thất bại: Vault vẫn có token, bot mới seed được.
        }
      }
      return result;
    },
  );

  // M7: Connected apps — catalog + trạng thái auth cho Settings.
  // v0.70: 'apps:list' là async vì trạng thái app github được xác thực
  // lại với api.github.com (cache 1 giờ, timeout 10s).
  ipcMain.handle('apps:list', async (): Promise<AppStatusView[]> => buildAppStatusViews());

  ipcMain.handle('apps:disconnect', async (_event: unknown, payload: { appId: string }) => {
    const appId = requireId(payload?.appId, 'appId');
    const app = getApp(appId);
    if (!app) throw new Error(`Không rõ app "${appId}".`);
    // v0.57: app Composio không có token local để xoá — ngắt kết nối
    // nghĩa là tắt toolkit đó (router 'composio' thì tắt cả source).
    // Token OAuth thật nằm phía Composio, thu hồi qua Connect Link.
    if (app.source === 'composio') {
      const source = getComposioSource();
      if (app.id === COMPOSIO_ROUTER_APP_ID) {
        source.setEnabled(false);
      } else if (app.toolkit) {
        source.setToolkitEnabled(app.toolkit, false);
      }
      settings.composio = composioStateToPersist(source);
      saveSettings();
      await syncComposioToCoordinator().catch(() => undefined);
      return buildAppStatusViews();
    }
    // v0.68b: app token (PAT dán tay, vd GitHub) — xóa token thô
    // khỏi Vault theo vị trí đã khai trong AppDefinition, rồi thu
    // hồi ngay trong coordinator đang chạy (mọi bot mất quyền ngay,
    // không chờ tạo lại bot hay restart app). Không có identity row
    // provider để dọn (token PAT không qua OAuth login).
    if (app.authType === 'token' && app.vaultNamespace && app.vaultKey) {
      vault.deleteSecret(app.vaultNamespace, app.vaultKey);
      // v0.70: token đã xóa thì cache xác thực lại của nó cũng hết
      // hiệu lực (token dán lại sau phải được kiểm tra từ đầu).
      githubPatRevalidator.clear();
      if (coordinator) {
        await coordinator.revokeSharedAppToken(appId).catch(() => undefined);
      }
      return buildAppStatusViews();
    }
    if (app.authType !== 'oauth2' || !app.connectorId) {
      throw new Error(`App "${app.label}" chạy local, không cần ngắt kết nối.`);
    }
    const connectorId = app.connectorId;
    // Xóa token khỏi Vault (cùng dọn dẹp như auth:identity-delete:
    // refresh token riêng của slack/microsoft đi cùng; refresh token
    // Google của gmail dùng chung với login Google nên giữ lại).
    vault.deleteSecret('connector', connectorId);
    if (connectorId === 'slack') vault.deleteSecret('oauth-refresh', 'slack');
    if (connectorId === 'teams') vault.deleteSecret('oauth-refresh', 'microsoft');
    deleteProviderIdentity(vault, connectorId);
    // M7: thu hồi ngay trong coordinator đang chạy — mọi bot mất
    // quyền ngay lập tức, không chờ tạo lại bot hay restart app.
    if (coordinator) {
      await coordinator.revokeSharedAppToken(connectorId).catch(() => undefined);
    }
    return buildAppStatusViews();
  });

  // v0.68b: M7 app token (PAT dán tay, vd GitHub) — renderer dán token
  // vào form, main lưu nguyên chuỗi vào Vault theo vị trí đã khai
  // trong AppDefinition rồi seed ngay cho coordinator qua RPC
  // `apps.setPlainToken` (bot đã tạo dùng được token mới ngay, không
  // cần tạo lại bot). Token KHÔNG BAO GIỜ trả về renderer, không log;
  // tối đa 500 ký tự (PAT GitHub dài nhất ~100 ký tự, chừa dư).
  // v0.69a: app github được xác thực TRƯỚC với api.github.com
  // (GET /user, timeout 10s) qua `saveValidatedGithubPat` — PAT sai /
  // hết hạn / bị GitHub từ chối thì ném lỗi tiếng Việt rõ ngay lúc kết
  // nối và KHÔNG lưu Vault, KHÔNG seed coordinator; validate ok thì
  // mới lưu + seed (kèm login làm nhãn tài khoản cho UI). App token
  // khác (hiện chưa có app nào) giữ hành vi cũ vì chưa có endpoint
  // xác thực riêng — không gọi api.github.com cho app không phải GitHub.
  ipcMain.handle(
    'apps:set-token',
    async (_event: unknown, payload: { appId?: unknown; token?: unknown }) => {
      const appId = requireId(payload?.appId, 'appId');
      const app = getApp(appId);
      if (!app) throw new Error(`Không rõ app "${appId}".`);
      if (app.authType !== 'token' || !app.vaultNamespace || !app.vaultKey) {
        throw new Error(`App "${app.label}" không dùng token PAT.`);
      }
      const token = requireString(payload?.token, 'token', 500);
      const namespace = app.vaultNamespace;
      const key = app.vaultKey;
      const coord = coordinator;
      if (appId === 'github') {
        const { login } = await saveValidatedGithubPat({
          token,
          save: (t) => vault.setSecret(namespace, key, t),
          ...(coord
            ? {
                onSaved: async (t, login) => {
                  await coord.setPlainAppToken(appId, t, login);
                },
              }
            : {}),
        });
        // v0.70: token vừa xác thực ok lúc lưu — seed cache để trạng
        // thái trả về ngay sau đó không gọi lại GitHub.
        githubPatRevalidator.seedValid(login);
      } else {
        vault.setSecret(namespace, key, token);
        if (coord) {
          await coord.setPlainAppToken(appId, token).catch(() => undefined);
        }
      }
      return buildAppStatusViews();
    },
  );

  // v0.57: Composio — 5 kênh IPC (xem docs/composio-integration.md §6).
  // Key vào Vault qua `composio:set-key`, KHÔNG BAO GIỜ trả về
  // renderer; v0.59: nhập/xoá key xong main seed lại cho coordinator
  // qua RPC `composio.setApiKey` (để con dùng được ngay cả khi Vault
  // dùng safeStorage/NO_STORAGE mà file reader không mở được).
  ipcMain.handle('composio:get-state', (): ComposioStateView => {
    return buildComposioStateView(
      getComposioSource(),
      hasComposioApiKey(vault),
      hasComposioUserId(vault),
    );
  });

  ipcMain.handle(
    'composio:set-enabled',
    async (_event: unknown, payload: { enabled?: unknown }): Promise<ComposioStateView> => {
      const enabled = requireBoolean(payload?.enabled, 'enabled');
      const source = getComposioSource();
      source.setEnabled(enabled);
      settings.composio = composioStateToPersist(source);
      saveSettings();
      await syncComposioToCoordinator().catch(() => undefined);
      return buildComposioStateView(source, hasComposioApiKey(vault), hasComposioUserId(vault));
    },
  );

  ipcMain.handle(
    'composio:set-app-enabled',
    async (
      _event: unknown,
      payload: { toolkit?: unknown; enabled?: unknown },
    ): Promise<ComposioStateView> => {
      const toolkit = requireString(payload?.toolkit, 'toolkit');
      if (!(COMPOSIO_TOOLKIT_SLUGS as readonly string[]).includes(toolkit)) {
        throw new Error(`Không rõ toolkit Composio "${toolkit}".`);
      }
      const enabled = requireBoolean(payload?.enabled, 'enabled');
      const source = getComposioSource();
      source.setToolkitEnabled(toolkit, enabled);
      settings.composio = composioStateToPersist(source);
      saveSettings();
      await syncComposioToCoordinator().catch(() => undefined);
      return buildComposioStateView(source, hasComposioApiKey(vault), hasComposioUserId(vault));
    },
  );

  ipcMain.handle(
    'composio:set-key',
    async (_event: unknown, payload: { apiKey?: unknown }): Promise<ComposioStateView> => {
      // Key Composio thường < 200 ký tự; cho tối đa 500 để không chặn
      // key dài bất thường. Key chỉ vào Vault, không log, không trả về.
      const apiKey = requireString(payload?.apiKey, 'apiKey', 500);
      setComposioApiKey(vault, apiKey);
      // v0.59: seed key mới cho coordinator ngay (xoay key không cần
      // tạo lại bot — con ghi đè key đã seed, huỷ session cũ).
      await seedComposioKeyToCoordinator().catch(() => undefined);
      return buildComposioStateView(getComposioSource(), true, hasComposioUserId(vault));
    },
  );

  ipcMain.handle('composio:clear-key', async (): Promise<ComposioStateView> => {
    clearComposioApiKey(vault);
    // v0.59: xoá cả bản seed trong coordinator (seed null → con về
    // fallback / fail-closed, không giữ key cũ trong bộ nhớ).
    await seedComposioKeyToCoordinator().catch(() => undefined);
    return buildComposioStateView(getComposioSource(), false, hasComposioUserId(vault));
  });

  // v0.88b: Composio user id — 2 kênh IPC, theo đúng mẫu key
  // (`composio:set-key` / `composio:clear-key`). User id vào Vault
  // (namespace 'provider', key 'composio-user-id'), KHÔNG BAO GIỜ
  // trả về renderer; nhập/xoá xong main seed lại cho coordinator
  // qua RPC `composio.setUserId` (đổi id → session cũ bị huỷ ngay,
  // không cần restart app). Validate ở `setComposioUserId` (rỗng/
  // khoảng trắng/ký tự lạ → lỗi rõ, không ghi).
  ipcMain.handle(
    'composio:set-user-id',
    async (_event: unknown, payload: { userId?: unknown }): Promise<ComposioStateView> => {
      // User id Composio thường < 100 ký tự; cho tối đa 500 để không
      // chặn id dài bất thường (validate thật ở setComposioUserId:
      // tối đa 200 ký tự, không khoảng trắng). Giá trị chỉ vào Vault,
      // không log, không trả về.
      const userId = requireString(payload?.userId, 'userId', 500);
      setComposioUserId(vault, userId);
      await seedComposioUserIdToCoordinator().catch(() => undefined);
      return buildComposioStateView(getComposioSource(), hasComposioApiKey(vault), true);
    },
  );

  ipcMain.handle('composio:clear-user-id', async (): Promise<ComposioStateView> => {
    clearComposioUserId(vault);
    // Xoá cả bản seed trong coordinator (seed null → con về mặc định
    // 'local-user', không giữ id cũ trong bộ nhớ / session cũ).
    await seedComposioUserIdToCoordinator().catch(() => undefined);
    return buildComposioStateView(getComposioSource(), hasComposioApiKey(vault), false);
  });

  // v0.95 (Team D2): Media keys — 3 kênh IPC, theo đúng mẫu key
  // (`composio:set-key` / `composio:clear-key`). Key vào Vault
  // (namespace 'media', key = provider id), KHÔNG BAO GIỜ trả về
  // renderer — `media:get-status` chỉ trả {configured, suffix}
  // (suffix = 4 ký tự cuối, đủ để phân biệt key). Nhập/xoá xong main
  // seed lại cho coordinator qua RPC `media.setKey` (đổi key → lần
  // gọi image/video sau dùng key mới ngay, không cần restart app).
  // Provider lạ / key rỗng → lỗi rõ, không ghi.
  ipcMain.handle(
    'media:get-status',
    (): Record<string, { configured: boolean; suffix: string | null }> => {
      return getMediaKeyStatus(vault);
    },
  );

  ipcMain.handle(
    'media:set-key',
    async (
      _event: unknown,
      payload: { providerId?: unknown; apiKey?: unknown },
    ): Promise<Record<string, { configured: boolean; suffix: string | null }>> => {
      const providerId = requireString(payload?.providerId, 'providerId', 100);
      if (!isMediaProviderId(providerId)) {
        throw new Error(`Không rõ media provider "${providerId}".`);
      }
      // Key media thường < 200 ký tự; cho tối đa 500 để không chặn
      // key dài bất thường. Key chỉ vào Vault, không log, không trả về.
      const apiKey = requireString(payload?.apiKey, 'apiKey', 500);
      setMediaApiKey(vault, providerId, apiKey);
      await seedMediaKeyToCoordinator(providerId).catch(() => undefined);
      return getMediaKeyStatus(vault);
    },
  );

  ipcMain.handle(
    'media:clear-key',
    async (
      _event: unknown,
      payload: { providerId?: unknown },
    ): Promise<Record<string, { configured: boolean; suffix: string | null }>> => {
      const providerId = requireString(payload?.providerId, 'providerId', 100);
      if (!isMediaProviderId(providerId)) {
        throw new Error(`Không rõ media provider "${providerId}".`);
      }
      clearMediaApiKey(vault, providerId);
      // Xoá cả bản seed trong coordinator (seed null → con về chưa
      // cấu hình, không giữ key cũ trong bộ nhớ).
      await seedMediaKeyToCoordinator(providerId).catch(() => undefined);
      return getMediaKeyStatus(vault);
    },
  );

  // v0.89c (Team E): trạng thái connection từng toolkit — main gọi
  // RPC `composio.getConnectionStatus` của coordinator (đi qua
  // session hiện tại). Chỉ trả toolkit + trạng thái + nhãn tài khoản;
  // lỗi (chưa có key/session) ném về renderer dạng message để UI
  // hiển thị, không chứa user id/key.
  ipcMain.handle(
    'composio:get-connection-status',
    async (
      _event: unknown,
      payload: { toolkits?: unknown },
    ): Promise<ComposioToolkitConnection[]> => {
      const toolkits = payload?.toolkits;
      if (toolkits !== undefined && !Array.isArray(toolkits)) {
        throw new Error('composio:get-connection-status cần toolkits là mảng string.');
      }
      const client = getCoordinator() as unknown as {
        getComposioConnectionStatus?: (
          toolkits?: string[],
        ) => Promise<ComposioToolkitConnection[]>;
      };
      if (typeof client.getComposioConnectionStatus !== 'function') {
        throw new Error('Coordinator chưa hỗ trợ kiểm tra trạng thái kết nối Composio.');
      }
      return client.getComposioConnectionStatus(
        Array.isArray(toolkits) ? (toolkits as string[]) : undefined,
      );
    },
  );

  ipcMain.handle('update:check', async (): Promise<UpdateCheckResult> => {
    // Phiên bản hiện tại lấy từ package.json qua app.getVersion().
    return checkForUpdate({ currentVersion: app.getVersion() });
  });

  // --- v0.54 (P1-9): update theo track (track + check định kỳ + banner) ---
  // `update:check` ở trên giữ nguyên (tương thích cũ, kênh stable).
  // Các kênh `updates:*` dùng UpdateService: track persist, check lúc
  // startup + định kỳ, feed stub cho track chưa có feed thật (xem
  // updateService.ts — KHÔNG bịa release server).
  ipcMain.handle('updates:get-status', (): UpdateStatus => getUpdateService().getStatus());
  ipcMain.handle('updates:set-track', (_event: unknown, payload: { track?: unknown }): UpdateStatus => {
    return getUpdateService().setUpdateTrack(payload?.track);
  });
  ipcMain.handle(
    'updates:check',
    async (_event: unknown, payload: { trigger?: unknown }): Promise<UpdateStatus> => {
      const trigger: UpdateCheckTrigger =
        payload?.trigger === 'periodic' || payload?.trigger === 'manual' ? payload.trigger : 'manual';
      return getUpdateService().checkForUpdates(trigger);
    },
  );
  ipcMain.handle('updates:quit-and-install', (): { installed: boolean; reason: string } => {
    return getUpdateService().quitAndInstallUpdate();
  });

  // --- v0.54 (P1-8): checkpoint/resume + interrupt HITL cho run dài ---
  // Resume/time-travel qua coordinator con (checkpoint sống trong
  // BotMemory SQLite của bot — sống qua restart app).
  ipcMain.handle('runs:list-checkpoints', async (_event: unknown, payload: { botId: string }) => {
    const botId = requireId(payload?.botId, 'botId');
    return getCoordinator().listBotCheckpoints(botId);
  });
  ipcMain.handle(
    'runs:interrupt',
    async (_event: unknown, payload: { runId: string; question?: string }) => {
      const runId = requireId(payload?.runId, 'runId');
      const question = optionalString(payload?.question, 'question', 2000);
      return getCoordinator().interruptRun(runId, question ?? undefined);
    },
  );
  ipcMain.handle(
    'runs:replay',
    async (_event: unknown, payload: { botId: string; runId: string; stepIndex?: number | 'latest' }) => {
      const botId = requireId(payload?.botId, 'botId');
      const runId = requireId(payload?.runId, 'runId');
      const stepIndex =
        payload?.stepIndex === 'latest' || payload?.stepIndex === undefined
          ? 'latest'
          : requireInt(payload.stepIndex, 'stepIndex', 0, 1_000_000);
      return getCoordinator().replayRun(botId, runId, stepIndex);
    },
  );

  ipcMain.handle('update:open-download', async (_event: unknown, payload: { url?: string }) => {
    const url = requireHttpUrl(payload?.url, 'url');
    // Chỉ mở link release chính thức của repo open-bot — chặn URL lạ
    // từ renderer (kể cả khi renderer bị chèn nội dung xấu).
    const prefix = 'https://github.com/hoangthuanreview20-boop/open-bot/releases/';
    if (!url.startsWith(prefix)) {
      throw new Error('Chỉ mở được link release chính thức của open-bot.');
    }
    await shell.openExternal(url);
    return true;
  });

  // Renderer trả lời phê duyệt tool call (ipcRenderer.send, không phải
  // invoke): chuyển tiếp vào tiến trình coordinator con, nơi run đang chờ.
  // v0.7: handler `.on` không được throw — tham số sai thì bỏ qua.
  ipcMain.on('chat:approval-response', (_event: unknown, payload: { callId: string; approved: boolean; args?: Record<string, unknown> }) => {
    try {
      const callId = requireId(payload?.callId, 'callId');
      const approved = requireBoolean(payload?.approved, 'approved');
      // v0.12 (interrupt_before): args đã sửa phải là plain object, sai thì bỏ qua args.
      const args =
        payload?.args && typeof payload.args === 'object' && !Array.isArray(payload.args)
          ? payload.args
          : undefined;
      if (coordinator) {
        void coordinator.respondApproval(callId, approved, args).catch(() => undefined);
      }
    } catch {
      // Tham số sai: bỏ qua, không crash main.
    }
  });

  // v0.50 (M8): renderer trả lời permission của CLI engine (thẻ
  // PermissionCard) — chuyển tiếp vào coordinator con, nơi broker
  // đang chờ (RPC `harnessDecidePermission`).
  ipcMain.on(
    'chat:harness-permission-response',
    (_event: unknown, payload: { requestId: string; allowed: boolean }) => {
      try {
        const requestId = requireId(payload?.requestId, 'requestId');
        const allowed = requireBoolean(payload?.allowed, 'allowed');
        if (coordinator) {
          void coordinator.harnessDecidePermission({ requestId, allowed }).catch(() => undefined);
        }
      } catch {
        // Tham số sai: bỏ qua, không crash main.
      }
    },
  );

  // v0.90a (Đội G): harness event log lên renderer (EventLogView) —
  // status registry + đọc NDJSON log theo thread (phân trang, lọc
  // kind). Params validate bằng ipc/validate.ts
  // (`parseHarnessThreadLogParams`); sai thì lỗi rõ về renderer.
  ipcMain.handle('harness:status', async () => getCoordinator().harnessStatus());
  ipcMain.handle('harness:thread-log', async (_event: unknown, payload: unknown) => {
    const params = parseHarnessThreadLogParams(payload);
    // kinds đã validate nằm trong HARNESS_EVENT_KINDS ở
    // parseHarnessThreadLogParams — cast này giữ đúng hợp đồng
    // HarnessThreadLogParams (coordinator cũng filter lại bằng typeof).
    return getCoordinator().harnessThreadLog({
      threadId: params.threadId,
      limit: params.limit,
      offset: params.offset,
      ...(params.kinds !== undefined ? { kinds: params.kinds as HarnessEventKind[] } : {}),
    });
  });

  // Renderer trả lời câu hỏi của agent (tool ask_user): tương tự.
  ipcMain.on('chat:ask-user-response', (_event: unknown, payload: { requestId: string; answer: string }) => {
    try {
      const requestId = requireId(payload?.requestId, 'requestId');
      const answer = optionalString(payload?.answer, 'answer', 200_000) ?? '';
      if (coordinator) {
        void coordinator.respondAskUser(requestId, answer).catch(() => undefined);
      }
    } catch {
      // Tham số sai: bỏ qua, không crash main.
    }
  });

  // v0.54 (P1-8): renderer trả lời thẻ InterruptCard (run đang dừng ở
  // điểm interrupt): chuyển tiếp vào coordinator con qua RPC
  // `respondInterrupt`. Decision sai/không rõ thì coi như cancel (an
  // toàn) — coordinator tự chuẩn hoá.
  ipcMain.on(
    'chat:interrupt-response',
    (
      _event: unknown,
      payload: { requestId: string; decision: { action: string; message?: string } },
    ) => {
      try {
        const requestId = requireId(payload?.requestId, 'requestId');
        const action = payload?.decision?.action;
        if (action !== 'continue' && action !== 'continue-with-message' && action !== 'deny-tool' && action !== 'cancel') {
          return;
        }
        const message =
          action === 'continue-with-message'
            ? (optionalString(payload?.decision?.message, 'message', 200_000) ?? '')
            : undefined;
        if (coordinator) {
          const decision =
            action === 'continue-with-message'
              ? { action: 'continue-with-message' as const, message: message ?? '' }
              : action === 'continue'
                ? { action: 'continue' as const }
                : action === 'deny-tool'
                  ? { action: 'deny-tool' as const }
                  : { action: 'cancel' as const };
          void coordinator.respondInterrupt(requestId, decision).catch(() => undefined);
        }
      } catch {
        // Tham số sai: bỏ qua, không crash main.
      }
    },
  );

  // v0.54 (P1-10): renderer báo telemetry `client_persistence` khi
  // persisted store lỗi (đọc/ghi/xoá/migrate). Chỉ log ở main (không
  // gửi đi đâu) — fail soft, không crash main.
  ipcMain.on(
    'telemetry:client-persistence',
    (
      _event: unknown,
      payload: { storeKey?: string; operation?: string; error?: string; at?: string },
    ) => {
      try {
        const storeKey = optionalString(payload?.storeKey, 'storeKey', 500) ?? 'unknown';
        const operation = optionalString(payload?.operation, 'operation', 50) ?? 'unknown';
        const error = optionalString(payload?.error, 'error', 2000) ?? '';
        console.warn(`[open-bot] client_persistence ${storeKey} ${operation}: ${error}`);
      } catch {
        // Bỏ qua, không crash main.
      }
    },
  );

  // v0.13: renderer trả lời elicitation của MCP server (ElicitationModal):
  // tương tự ask-user, nhưng action phải là accept/decline/cancel và
  // content (khi có) phải là plain object — sai thì bỏ qua, không crash main.
  ipcMain.on(
    'chat:elicitation-response',
    (
      _event: unknown,
      payload: {
        elicitationId: string;
        result: { action: string; content?: Record<string, unknown> };
      },
    ) => {
      try {
        const elicitationId = requireId(payload?.elicitationId, 'elicitationId');
        const action = payload?.result?.action;
        if (action !== 'accept' && action !== 'decline' && action !== 'cancel') return;
        const content =
          payload?.result?.content &&
          typeof payload.result.content === 'object' &&
          !Array.isArray(payload.result.content)
            ? payload.result.content
            : undefined;
        if (coordinator) {
          void coordinator.respondElicitation(elicitationId, action, content).catch(() => undefined);
        }
      } catch {
        // Tham số sai: bỏ qua, không crash main.
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Cửa sổ + vòng đời app
// ---------------------------------------------------------------------------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // L1 (audit v0.15): sandbox:true như cửa sổ splash — renderer
      // không còn Node API trực tiếp, chỉ giao tiếp qua preload
      // (contextBridge) + IPC. Đã smoke test dưới xvfb (xem báo cáo
      // W9a): renderer load, IPC hoạt động.
      sandbox: true,
    },
  });

  // v0.7: đo thời gian renderer load xong (để so sánh hiệu quả V8
  // code-cache trước/sau; chỉ là 1 dòng log, không ảnh hưởng app).
  const windowCreatedAt = Date.now();
  mainWindow.webContents.on('did-finish-load', () => {
    console.log(`[startup] Renderer load xong trong ${Date.now() - windowCreatedAt}ms (từ lúc tạo cửa sổ).`);
  });

  if (process.env.OPEN_BOT_DEV === '1') {
    void mainWindow.loadURL('http://localhost:5173');
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Cửa sổ mới (mở lại qua `activate`) mount renderer mới: route tới
    // sau đó phải chờ renderer kéo về, không đẩy thẳng vào khoảng không.
    deepLinkRendererReady = false;
  });
}

/** v0.7 — GIAI ĐOẠN 1: cửa sổ "đang khởi động" tối giản (không Node, không IPC). */
function createSplashWindow(): void {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 180,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const html =
    '<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;display:flex;' +
    'flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0">' +
    '<h1 style="margin:0 0 8px">open-bot</h1><p style="margin:0;color:#666">Đang khởi động…</p></body>';
  void splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

function closeSplashWindow(): void {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
  }
  splashWindow = null;
}

/**
 * v0.7 — KHỞI ĐỘNG 2 GIAI ĐOẠN (ROADMAP §2a):
 * - Giai đoạn 1 (core nhẹ): Vault + settings + machineId + policy +
 *   profile + migration credential. Xong -> mở cửa sổ "đang khởi
 *   động" để người dùng thấy app đã sống, rồi mới làm giai đoạn 2.
 * - Giai đoạn 2 (phần nặng): model registry, coordinator (spawn
 *   lazy ở lần chat đầu — ở đây chỉ chuẩn bị), automations/dream,
 *   Local API, file watcher, IPC, rồi mới mở cửa sổ chính.
 * Mỗi giai đoạn log thời gian (ms); không log secret.
 */
async function bootstrap(): Promise<void> {
  const t0 = Date.now();
  // --- Giai đoạn 1: core nhẹ ---
  initVaultAndUsage(app.getPath('userData'));
  settings = loadSettings();
  // v0.86 (P2-7): crash reporting opt-in — gắn handler sau khi settings
  // đã load để cờ `crashReportingEnabled` (mặc định tắt) có hiệu lực.
  initCrashReporting();
  // v0.5: định danh máy ổn định, dùng để gắn token với (machineId, teamId).
  // Lưu file `machine-id` (mode 0600) trong userData. Không log giá trị.
  machineId = getOrCreateMachineId(app.getPath('userData'));
  // v0.5: áp lại lựa chọn NO_STORAGE đã lưu (Vault mặc định bật durable).
  if (settings.vaultNoStorage === true) vault.setNoStorage(true);
  // v0.7: policy máy — file không có thì mọi thứ như cũ; file lỗi
  // thì bỏ qua policy (chỉ log lý do, không crash app).
  const policyResult = loadPolicy(app.getPath('userData'));
  activePolicy = policyResult.policy;
  for (const err of policyResult.errors) {
    console.error('[open-bot] policy.json bị bỏ qua:', err);
  }
  if (activePolicy?.disableTelemetry === true) {
    console.log('[open-bot] Policy: telemetry đã tắt (app hiện không gửi telemetry).');
  }
  if (applyPolicyToSettings()) saveSettings();
  // v0.7: tài khoản chính local — tạo 1 lần, id ổn định.
  localProfile = getLocalProfile(app.getPath('userData'));
  migrateApiKeysToVault();
  // v0.7: dời credential nằm sai namespace về đúng chỗ (oauth ->
  // oauth-refresh, ...); audit còn sót thì log để admin xử lý.
  const migration = migrateCredentials(vault);
  if (migration.moved.length > 0) {
    console.log(`[open-bot] Đã dời ${migration.moved.length} credential về đúng namespace.`);
  }
  const auditLeftovers = auditCredentialNamespaces(vault);
  if (auditLeftovers.length > 0) {
    console.warn('[open-bot] Credential còn nằm sai namespace:', auditLeftovers.join('; '));
  }
  const phase1Ms = Date.now() - t0;
  console.log(`[startup] Giai đoạn 1 (core nhẹ) xong trong ${phase1Ms}ms.`);
  createSplashWindow();

  // --- Giai đoạn 2: phần nặng ---
  const t1 = Date.now();
  initModelRegistry(app.getPath('userData'));
  // v0.61 (UI-10 fix): NO silent default bot any more. `ensureDefaultBot`
  // used to seed a "Trợ lý" bot here, which made the first-run onboarding
  // (shown only when there is no bot yet) unreachable — the UI-10 smoke
  // proved it never appeared on a fresh profile. First run now shows
  // the onboarding screen instead; the user creates the sample bot (or
  // their own) in one click. Existing installs already have bots, so
  // nothing changes for them. All `settings.bots[0]` uses below are
  // null-guarded for the zero-bot state.
  dreamConfig = loadDreamConfig();
  initAutomations();
  // v0.57: khôi phục trạng thái Composio đã lưu (Vault đã sẵn từ giai
  // đoạn 1) — app Composio xuất hiện trong `apps:list` nếu đã bật.
  initComposio();
  apiConfig = settings.api ?? { enabled: false, port: DEFAULT_API_PORT };
  if (apiConfig.enabled) {
    // Bật từ lần chạy trước: khởi động lại server; port bận thì
    // thử lại tối đa 5 lần với backoff (v0.90d), hết lần thì lỗi
    // hiện trong Settings (api:get.lastError) — app vẫn mở bình
    // thường để người dùng đổi port.
    void startApiServerWithRetry('startup');
  }
  initFileWatcher();
  registerIpc();
  createWindow();
  // v0.54 (P1-9): kiểm tra update lúc startup + bắt đầu lịch kiểm tra
  // định kỳ (lỗi thì retry ở lần sau, không chặn khởi động).
  void getUpdateService()
    .start()
    .catch((err: unknown) => {
      console.error('[open-bot] Không kiểm tra được bản cập nhật lúc khởi động:', (err as Error).message);
    });
  closeSplashWindow();
  const phase2Ms = Date.now() - t1;
  console.log(`[startup] Giai đoạn 2 (app nặng) xong trong ${phase2Ms}ms (tổng ${Date.now() - t0}ms).`);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

// v0.86 (P2-6): deep-link `open-bot://` — đăng ký scheme + single-instance
// lock + listener `open-url`/`second-instance` TRƯỚC `whenReady` (URL có
// thể tới ngay khi app khởi động qua protocol). lockAcquired=false nghĩa
// là đã có instance khác đang chạy: instance này thoát, không bootstrap.
const deepLinkSetup = setupDeepLink({ app, onUrl: handleDeepLinkRaw });
if (deepLinkSetup.initialUrl) handleDeepLinkRaw(deepLinkSetup.initialUrl);

void app.whenReady().then(() => {
  if (!deepLinkSetup.lockAcquired) return;
  void bootstrap().catch((err: unknown) => {
    console.error('[open-bot] Khởi động thất bại:', (err as Error).message);
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  saveSettings();
  closeSplashWindow();
  // v0.54 (P1-9): dừng lịch kiểm tra update định kỳ.
  updateService?.stop();
  automationScheduler?.stop();
  void stopApiServer().catch(() => undefined);
  if (dreamTimer) {
    clearInterval(dreamTimer);
    dreamTimer = null;
  }
  if (projectUpdatesTimer) {
    clearInterval(projectUpdatesTimer);
    projectUpdatesTimer = null;
  }
  for (const watcher of fileWatchers.values()) {
    try {
      watcher.close();
    } catch {
      // Best-effort.
    }
  }
  fileWatchers.clear();
  if (coordinator) {
    // Fire-and-forget: child cũng tự thoát khi stdin đóng (parent chết).
    void coordinator.dispose().catch(() => undefined);
    coordinator = null;
  }
  if (fleetManager) {
    // Đội D (fleet): dừng toàn bộ service fleet khi tắt app.
    void fleetManager.dispose().catch(() => undefined);
    fleetManager = null;
  }
});
