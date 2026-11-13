/**
 * Composio (v0.57) — public surface of packages/core/src/composio/.
 *
 * Tích hợp tối thiểu đã duyệt (Huy 2026-11-09 20:09): adapter opt-in
 * sau AppRegistry, transport MCP Tool Router tái dùng connectMcp,
 * 40 toolkit (Gmail, GitHub, Slack, Notion + 10 toolkit v0.72a
 * + 8 toolkit v0.82: Zoom, Salesforce, Zendesk, Airtable, Monday,
 * ClickUp, Dropbox, Outlook + 18 toolkit v0.96: Stripe, Shopify,
 * Box, Confluence, GitLab, Calendly, Mailchimp, Twilio, Google Docs,
 * YouTube, LinkedIn, Reddit, WhatsApp, PagerDuty, Typeform, SendGrid,
 * Bitbucket, Freshdesk), key user trong Vault.
 * Xem docs/composio-integration.md.
 */
export {
  COMPOSIO_GITHUB_POLL_TRIGGER_SLUG,
  COMPOSIO_POLL_BACKOFF_MAX_MS,
  COMPOSIO_POLL_BACKOFF_MULTIPLIER,
  COMPOSIO_POLL_MAX_INTERVAL_MS,
  COMPOSIO_POLL_MIN_INTERVAL_MS,
  COMPOSIO_SLACK_POLL_TRIGGER_SLUG,
  ComposioPollScheduler,
  clampComposioPollIntervalMs,
  composioPollBackoffDelayMs,
  createGithubComposioPollEntry,
  createGmailComposioPollEntry,
  createSlackComposioPollEntry,
} from './pollScheduler';
export type {
  ComposioPollEnqueuedInfo,
  ComposioPollEntryConfig,
  ComposioPollSchedulerOptions,
  ComposioPollStatus,
} from './pollScheduler';
export {
  COMPOSIO_POLL_STATE_FILE,
  COMPOSIO_POLL_STATE_MAX_SEEN_IDS,
  COMPOSIO_POLL_STATE_VERSION,
  JsonFileComposioPollStateStore,
  MemoryComposioPollStateStore,
  defaultComposioPollState,
  pruneComposioPollSeenIds,
  resolveComposioPollState,
  resolveComposioPollStateDoc,
} from './pollState';
export type {
  ComposioPollSeenId,
  ComposioPollState,
  ComposioPollStateDoc,
  ComposioPollStateStore,
} from './pollState';
export {
  COMPOSIO_API_BASE_URL,
  COMPOSIO_GET_TOOL_SCHEMAS,
  COMPOSIO_MANAGE_CONNECTIONS_TOOL,
  COMPOSIO_MCP_HOST_SUFFIX,
  COMPOSIO_META_TOOLS,
  COMPOSIO_MULTI_EXECUTE_TOOL,
  COMPOSIO_SEARCH_TOOL,
  ComposioError,
} from './types';
export type {
  ComposioCallToolFn,
  ComposioConnectionStatus,
  ComposioErrorCode,
  ComposioExecuteItem,
  ComposioSession,
  ComposioSessionToolRef,
  ComposioToolkitConnection,
  CreateComposioSessionOptions,
} from './types';
export {
  COMPOSIO_VAULT_KEY,
  COMPOSIO_VAULT_NAMESPACE,
  COMPOSIO_VAULT_USER_ID_KEY,
  asComposioKeyVault,
  clearComposioApiKey,
  clearComposioUserId,
  createComposioSeededKeyReader,
  createComposioVaultFileKeyReader,
  getComposioApiKey,
  getComposioUserId,
  hasComposioApiKey,
  hasComposioUserId,
  normalizeComposioUserId,
  redactComposioKey,
  setComposioApiKey,
  setComposioUserId,
  validateComposioUserId,
} from './keyStore';
export type { ComposioKeyVault, ComposioSeededKeyReader } from './keyStore';
export {
  COMPOSIO_ROUTER_APP,
  COMPOSIO_ROUTER_APP_ID,
  COMPOSIO_TOOLKITS,
  COMPOSIO_TOOLKIT_SLUGS,
  COMPOSIO_WRITE_VERBS,
  composioAppId,
  composioToolNeedsApproval,
  createComposioAppDefinitions,
  createComposioToolkitAppDefinitions,
  toolkitForComposioAppId,
} from './toolkits';
export type { ComposioToolkitDef } from './toolkits';
export { ComposioToolRouter, isTrustedComposioMcpUrl } from './router';
export type { ComposioFetchFn, ComposioToolRouterOptions } from './router';
export { ComposioAppSource } from './source';
export type { ComposioAppSourceOptions } from './source';
export {
  applyComposioPersistedState,
  buildComposioStateView,
  composioStateToPersist,
  defaultComposioPersistedState,
  resolveComposioPersistedState,
} from './state';
export type {
  ComposioAppStateView,
  ComposioPersistedState,
  ComposioStateView,
} from './state';
export {
  COMPOSIO_LOCAL_USER_ID,
  COMPOSIO_RUNNABLE_META_TOOLS,
  ComposioSessionManager,
  createComposioMetaTools,
  resolveComposioUserId,
} from './executors';
export type {
  ComposioMcpClientLike,
  ComposioSessionManagerOptions,
  CreateComposioMetaToolsDeps,
} from './executors';
export {
  COMPOSIO_TRIGGER_COUNTS,
  COMPOSIO_TRIGGER_DEFS,
  COMPOSIO_TRIGGER_SLUGS,
  COMPOSIO_TRIGGER_TOTAL_COUNT,
  COMPOSIO_WEBHOOK_ID_HEADER,
  COMPOSIO_WEBHOOK_SIGNATURE_HEADER,
  COMPOSIO_WEBHOOK_SIGNATURE_PREFIX,
  COMPOSIO_WEBHOOK_TIMESTAMP_HEADER,
  COMPOSIO_WEBHOOK_TOLERANCE_SECONDS,
  COMPOSIO_TRIGGER_SLUG_RE,
  computeComposioWebhookSignature,
  composioTriggerToInput,
  findComposioTriggerDef,
  isKnownComposioTriggerSlug,
  isValidComposioTriggerSlug,
  parseComposioTriggerPayload,
  verifyComposioTriggerToken,
  verifyComposioWebhookSignature,
} from './triggers';
export type { ComposioTriggerDef, ComposioTriggerEvent } from './triggers';
export {
  COMPOSIO_TRIGGER_LONG_POLL_MAX_TIMEOUT_MS,
  COMPOSIO_TRIGGER_QUEUE_DEFAULT_MAX_SIZE,
  COMPOSIO_TRIGGER_QUEUE_DEFAULT_TTL_MS,
  ComposioTriggerQueue,
  getSharedComposioTriggerQueue,
} from './triggerQueue';
export type {
  ComposioTriggerQueueFilter,
  ComposioTriggerQueueOptions,
  ComposioTriggerQueueStats,
  QueuedComposioTriggerEvent,
} from './triggerQueue';
export {
  COMPOSIO_GMAIL_POLL_INTERVAL_MS,
  COMPOSIO_GMAIL_POLL_QUERY,
  COMPOSIO_POLL_DEFAULT_MAX_NEW_ITEMS,
  COMPOSIO_POLL_DEDUPE_WINDOW_MS,
  ComposioPoller,
  composioPollItemId,
  createGmailPollerConfig,
  parseComposioPollItems,
} from './polling';
export {
  COMPOSIO_GMAIL_POLL_TRIGGER_SLUG,
  COMPOSIO_POLL_TRIGGER_EVENT_TYPE,
  createComposioPollToQueueBridge,
  enqueueComposioPollResult,
  hashComposioPollItem,
} from './pollBridge';
export type {
  ComposioPollToQueueBridge,
  ComposioPollToQueueBridgeOptions,
} from './pollBridge';
export type {
  ComposioPollFetchFn,
  ComposioPollItem,
  ComposioPollResult,
  ComposioPollerConfig,
} from './polling';
export {
  COMPOSIO_TRIGGER_KEYS_NAMESPACE,
  COMPOSIO_TRIGGER_TOKEN_KEY_SUFFIX,
  composioTriggerTokenKeyId,
  createComposioTriggerToken,
  deleteComposioTriggerSecrets,
  deleteComposioTriggerSigningSecret,
  deleteComposioTriggerToken,
  getComposioTriggerSigningSecret,
  getComposioTriggerToken,
  getComposioTriggerTokenByKeyId,
  hasComposioTriggerSigningSecret,
  hasComposioTriggerToken,
  rotateComposioTriggerToken,
  setComposioTriggerSigningSecret,
} from './triggerKeys';
export type { ComposioTriggerKey, ComposioTriggerKeyVault } from './triggerKeys';
