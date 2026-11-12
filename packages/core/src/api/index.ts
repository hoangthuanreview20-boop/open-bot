/**
 * @open-bot/core/api — local API server + webhooks (v0.5).
 * Public surface for the api module. The package root index does NOT
 * re-export this yet — the coordinator adds the exports (see
 * docs/v05-worker2-integration.md §2) so core stays importable from
 * both `@open-bot/core` and the deep path `@open-bot/core/api`.
 */
export {
  createApiServer,
  MAX_JSON_BODY_BYTES,
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  MCP_MOUNT_WRITE_TOOL_NAMES,
  isMcpMountWriteTool,
  resolveMcpMountTools,
  // v0.90d: rate limiting + giới hạn kết nối + timeout.
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  RATE_LIMIT_WINDOW_MS,
  MAX_API_CONNECTIONS,
  MAX_CONNECTIONS_PER_IP,
  API_HEADERS_TIMEOUT_MS,
  API_REQUEST_TIMEOUT_MS,
  API_CONNECTIONS_CHECKING_INTERVAL_MS,
} from './server';
export {
  API_RESTART_MAX_ATTEMPTS,
  API_RESTART_BASE_DELAY_MS,
  API_RESTART_MAX_DELAY_MS,
  apiRestartDelayMs,
  retryWithBackoff,
} from './restart';
export type { RetryWithBackoffOptions, RetryWithBackoffResult } from './restart';
export type { LocalApiServer, McpMountToolsResolution } from './server';
export {
  WebhookDispatcher,
  WEBHOOK_TIMEOUT_MS,
  WEBHOOK_EVENT_KINDS,
  WEBHOOK_SIGNATURE_MAX_AGE_SECONDS,
  signWebhookPayload,
  verifyWebhookSignature,
} from './webhooks';
export type {
  ApiBotSummary,
  ApiHandlers,
  ApiRunRecord,
  ApiStreamEvent,
  ApiStreamEventKind,
  CreateApiServerOptions,
  HarnessEventsFilter,
  HarnessStreamEvent,
  McpMountToolsOption,
  MountedA2aServer,
  MountedMcpServer,
  WebhookDispatchResult,
  WebhookDispatcherOptions,
  WebhookEvent,
  WebhookEventKind,
  WebhookRegistration,
} from './types';
