/**
 * Gateway manager — receive, route, reply (v1.02 rescue port of the
 * v1.00 work).
 *
 * `GatewayManager` is the host-facing facade: it takes a raw webhook
 * payload, normalizes it through the channel adapter, checks the
 * channel is enabled + the sender is under the rate limit, records
 * the message in the user's shared session, hands the text to the
 * host's `onMessage` handler (which produces a reply — usually an
 * agent run), and sends the reply back through the transport. Every
 * step is audited. A disabled channel, a rate-limited sender, or a
 * missing handler all fail closed with a clear outcome, never with
 * a silent drop.
 */

import * as path from 'node:path';

import {
  GATEWAY_CHANNELS,
  type GatewayChannelId,
  type GatewayMessage,
  type GatewayOutbound,
} from './types';
import { GatewayConfigStore } from './config';
import { GatewaySessionStore, gatewayUserId, type GatewaySession } from './sessions';
import { GatewayRateLimiter } from './rateLimit';
import { GatewayAuditLog } from './audit';
import { createGatewayAdapters, MockGatewayTransport, type GatewayAdapter, type GatewayTransport } from './adapters';

export interface GatewayManagerOptions {
  /** Directory holding gateway-config.json / gateway-sessions.json / gateway-audit.jsonl. */
  dataDir: string;
  /** Transport for outbound sends (mock when omitted). */
  transport?: GatewayTransport;
  /** Per-channel adapters (built-ins when omitted). */
  adapters?: Partial<Record<GatewayChannelId, GatewayAdapter>>;
  /** Produce a reply for an inbound message (usually an agent run). */
  onMessage?: (message: GatewayMessage, session: GatewaySession) => Promise<string | undefined>;
  /** Rate limiter (default 30/min per sender). */
  rateLimiter?: GatewayRateLimiter;
}

export type GatewayReceiveOutcome =
  | { handled: true; sessionId: string; replySent: boolean }
  | { handled: false; reason: 'not_a_message' | 'channel_disabled' | 'rate_limited' | 'no_handler' | 'error'; detail?: string };

/** Receives webhook payloads, routes to the shared session, replies. */
export class GatewayManager {
  private readonly configStore: GatewayConfigStore;
  private readonly sessionStore: GatewaySessionStore;
  private readonly audit: GatewayAuditLog;
  private readonly transport: GatewayTransport;
  private readonly adapters: Record<GatewayChannelId, GatewayAdapter>;
  private readonly onMessage?: GatewayManagerOptions['onMessage'];
  private readonly rateLimiter: GatewayRateLimiter;

  constructor(options: GatewayManagerOptions) {
    this.configStore = new GatewayConfigStore(path.join(options.dataDir, 'gateway-config.json'));
    this.sessionStore = new GatewaySessionStore(path.join(options.dataDir, 'gateway-sessions.json'));
    this.audit = new GatewayAuditLog(path.join(options.dataDir, 'gateway-audit.jsonl'));
    this.transport = options.transport ?? new MockGatewayTransport();
    const builtins = createGatewayAdapters();
    this.adapters = { ...builtins, ...(options.adapters ?? {}) };
    this.onMessage = options.onMessage;
    this.rateLimiter = options.rateLimiter ?? new GatewayRateLimiter();
  }

  get config() {
    return this.configStore;
  }

  get sessions() {
    return this.sessionStore;
  }

  /** Status of every channel (disabled / ready / mock / error). */
  channelStatus(): Record<GatewayChannelId, 'disabled' | 'ready' | 'mock' | 'error'> {
    const config = this.configStore.get();
    const status = {} as Record<GatewayChannelId, 'disabled' | 'ready' | 'mock' | 'error'>;
    for (const channel of GATEWAY_CHANNELS) {
      const entry = config.channels[channel];
      if (!entry.enabled) status[channel] = 'disabled';
      else if (entry.mock) status[channel] = 'mock';
      else status[channel] = 'ready';
    }
    return status;
  }

  /**
   * Handle one raw webhook payload for a channel. Returns whether
   * the message was handled and why not when it was not.
   */
  async receive(channel: GatewayChannelId, payload: unknown): Promise<GatewayReceiveOutcome> {
    const adapter = this.adapters[channel];
    const message = adapter.normalize(payload);
    if (!message) return { handled: false, reason: 'not_a_message' };
    const config = this.configStore.get();
    const channelConfig = config.channels[channel];
    if (!channelConfig.enabled) {
      this.audit.append({ at: new Date().toISOString(), direction: 'inbound', channel, chatId: message.chatId, messageId: message.id, outcome: 'disabled' });
      return { handled: false, reason: 'channel_disabled' };
    }
    const senderKey = `${channel}:${message.senderId}`;
    if (!this.rateLimiter.tryConsume(senderKey)) {
      this.audit.append({ at: new Date().toISOString(), direction: 'inbound', channel, chatId: message.chatId, messageId: message.id, outcome: 'rate_limited' });
      return { handled: false, reason: 'rate_limited' };
    }
    const userId = gatewayUserId(channel, message.senderId);
    const session = this.sessionStore.recordMessage(userId, message, config.defaultBotId);
    this.audit.append({ at: new Date().toISOString(), direction: 'inbound', channel, userId, chatId: message.chatId, messageId: message.id, outcome: 'ok' });
    if (!this.onMessage) {
      return { handled: false, reason: 'no_handler', detail: 'no onMessage handler configured' };
    }
    try {
      const reply = await this.onMessage(message, session);
      if (!reply) return { handled: true, sessionId: session.id, replySent: false };
      const outbound: GatewayOutbound = { channel, chatId: message.chatId, text: reply, replyToMessageId: message.id };
      await this.transport.send(outbound);
      this.audit.append({ at: new Date().toISOString(), direction: 'outbound', channel, userId, chatId: message.chatId, messageId: message.id, outcome: 'ok' });
      return { handled: true, sessionId: session.id, replySent: true };
    } catch (error) {
      this.audit.append({
        at: new Date().toISOString(),
        direction: 'outbound',
        channel,
        userId,
        chatId: message.chatId,
        messageId: message.id,
        outcome: 'error',
        detail: error instanceof Error ? error.message : String(error),
      });
      return { handled: false, reason: 'error', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Send a message out on a channel (host-initiated). */
  async send(outbound: GatewayOutbound): Promise<string> {
    const id = await this.transport.send(outbound);
    this.audit.append({ at: new Date().toISOString(), direction: 'outbound', channel: outbound.channel, chatId: outbound.chatId, outcome: 'ok' });
    return id;
  }
}
