/**
 * Multi-channel gateway — public surface of `packages/core/src/gateway/`.
 *
 * One user, one shared session, any channel (Telegram / Slack /
 * Discord / WhatsApp). Adapters normalize payloads; the host injects
 * the transport (real HTTP) and the reply handler (usually an agent
 * run). Tokens live only in the Vault, never in these modules.
 */
export {
  GATEWAY_AUDIT_FILE_NAME,
  GATEWAY_CHANNELS,
  GATEWAY_CONFIG_FILE_NAME,
  GATEWAY_FILE_VERSION,
  GATEWAY_SESSIONS_FILE_NAME,
  GATEWAY_VAULT_NAMESPACE,
  defaultGatewayConfig,
  parseGatewayCommand,
} from './types';
export type {
  GatewayChannelConfig,
  GatewayChannelId,
  GatewayChannelStatus,
  GatewayConfig,
  GatewayMessage,
  GatewayOutbound,
} from './types';
export { GatewayConfigStore, normalizeGatewayConfig } from './config';
export { GatewaySessionStore, gatewayUserId } from './sessions';
export type { GatewaySession } from './sessions';
export { GatewayRateLimiter } from './rateLimit';
export type { RateLimitOptions } from './rateLimit';
export { GatewayAuditLog } from './audit';
export type { GatewayAuditRecord } from './audit';
export {
  DiscordAdapter,
  MockGatewayTransport,
  SlackAdapter,
  TelegramAdapter,
  WhatsappAdapter,
  createGatewayAdapters,
} from './adapters';
export type { GatewayAdapter, GatewayTransport } from './adapters';
export { GatewayManager } from './manager';
export type { GatewayManagerOptions, GatewayReceiveOutcome } from './manager';
