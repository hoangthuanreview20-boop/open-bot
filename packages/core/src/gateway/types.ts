/**
 * Multi-channel gateway — shared types (v1.02 rescue port of the
 * v1.00 work).
 *
 * Ideas learned from multi-channel agent gateways (many chat
 * channels, one shared session) — architecture ideas only, all code
 * written fresh for open-bot, no copying:
 * - A "messaging channel" is an outside chat channel (Telegram /
 *   Slack / Discord / WhatsApp) the bot can receive from and send
 *   to — different from `channels/` (shared workspaces of many
 *   bots) and from `groupchat/` (bot-to-bot threads).
 * - Shared session: one user (identified by user, NOT by channel)
 *   has a single session — start on Telegram, continue on Slack,
 *   the bot still remembers history + context.
 * - User tokens (bot token / webhook secret) live only in the Vault
 *   (namespace 'gateway'), never hardcoded, never logged, never
 *   returned to the renderer, never sent anywhere except the
 *   channel's own API.
 * - Every adapter runs in mock/dry-run mode (MockGatewayTransport)
 *   so tests need no real token; without a token the adapter is
 *   clearly 'disabled', never calling a real API.
 * - Local-first, free: no cloud VM, no accounts/payments, no X
 *   data, no Grok Imagine.
 *
 * This module is PURE + file store (durable JSON, atomic writes,
 * corrupt file -> empty, fail-closed — same style as ChannelStore).
 * It does NOT call the real Telegram/Slack/Discord/WhatsApp APIs:
 * adapters only normalize payloads + format outbound messages
 * through a `GatewayTransport` the host injects (see `adapters.ts`);
 * the real (HTTP) transport is the host's job, the mock transport
 * is for tests + dry-run.
 */

/** A chat channel the gateway supports. */
export type GatewayChannelId = 'telegram' | 'slack' | 'discord' | 'whatsapp';

/** Every supported gateway channel, in Settings display order. */
export const GATEWAY_CHANNELS: readonly GatewayChannelId[] = [
  'telegram',
  'slack',
  'discord',
  'whatsapp',
];

/** Vault namespace holding gateway channel tokens. */
export const GATEWAY_VAULT_NAMESPACE = 'gateway';

/** Config file name (under the userData directory). */
export const GATEWAY_CONFIG_FILE_NAME = 'gateway-config.json';
/** Shared-session file name (under the userData directory). */
export const GATEWAY_SESSIONS_FILE_NAME = 'gateway-sessions.json';
/** Audit log file name (one JSON record per line). */
export const GATEWAY_AUDIT_FILE_NAME = 'gateway-audit.jsonl';
/** Gateway file format version. */
export const GATEWAY_FILE_VERSION = 1;

/** Connection state of a channel: not configured / ready / mock / error. */
export type GatewayChannelStatus = 'disabled' | 'ready' | 'mock' | 'error';

/** A normalized inbound message — every adapter produces this shape. */
export interface GatewayMessage {
  /** Message id (uuid assigned by the gateway when the adapter gives none). */
  id: string;
  /** Channel the message arrived on. */
  channel: GatewayChannelId;
  /** Sender id on that channel (chat id / user id / phone number). */
  senderId: string;
  /** Sender display name (when the channel provides one). */
  senderName: string;
  /** Room/chat/thread id on the channel (DM = senderId when the channel has none). */
  chatId: string;
  /** Text content (trimmed; empty when the message is only media/a command). */
  text: string;
  /** Command parsed from the text ('/help' -> 'help'), undefined when not a command. */
  command?: string;
  /** Arguments after the command ('/new topic' -> 'topic'). */
  commandArgs?: string;
  /** ISO timestamp of receipt (assigned by the adapter when the payload has none). */
  receivedAt: string;
}

/** An outbound message the gateway sends through a channel. */
export interface GatewayOutbound {
  channel: GatewayChannelId;
  chatId: string;
  text: string;
  /** Reply to this inbound message id (when the channel supports it). */
  replyToMessageId?: string;
}

/** Per-channel configuration (tokens live in the Vault, never here). */
export interface GatewayChannelConfig {
  channel: GatewayChannelId;
  enabled: boolean;
  /** Run against the mock transport (no real API calls). */
  mock?: boolean;
  /** Bot username / display name on the channel (optional). */
  botName?: string;
  /** Webhook path segment for this channel (optional). */
  webhookPath?: string;
}

/** Whole-gateway configuration. */
export interface GatewayConfig {
  version: number;
  channels: Record<GatewayChannelId, GatewayChannelConfig>;
  /** Default bot id that answers gateway messages. */
  defaultBotId?: string;
  /** Max inbound messages kept per shared session. */
  maxHistoryPerSession?: number;
}

/** Default gateway configuration (all channels disabled). */
export function defaultGatewayConfig(): GatewayConfig {
  const channels = {} as Record<GatewayChannelId, GatewayChannelConfig>;
  for (const channel of GATEWAY_CHANNELS) {
    channels[channel] = { channel, enabled: false };
  }
  return { version: GATEWAY_FILE_VERSION, channels, maxHistoryPerSession: 100 };
}

/** Parse a command from message text ('/help arg' -> { command: 'help', args: 'arg' }). */
export function parseGatewayCommand(text: string): { command?: string; commandArgs?: string } {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return {};
  const withoutSlash = trimmed.slice(1);
  const space = withoutSlash.search(/\s/);
  if (space === -1) return { command: withoutSlash };
  return {
    command: withoutSlash.slice(0, space),
    commandArgs: withoutSlash.slice(space + 1).trim(),
  };
}
