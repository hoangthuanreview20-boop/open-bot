/**
 * Gateway adapters — normalize inbound payloads, format outbound
 * messages (v1.02 rescue port of the v1.00 work).
 *
 * Each channel has one adapter that turns its webhook payload into
 * a `GatewayMessage` and turns a `GatewayOutbound` into the
 * channel's send shape. Adapters never call the channel API
 * directly: they send through a `GatewayTransport` the host injects
 * (real HTTP transport in production, `MockGatewayTransport` in
 * tests / dry-run). No token is ever handled here — the transport
 * owns authentication.
 */

import { randomUUID } from 'node:crypto';

import {
  parseGatewayCommand,
  type GatewayChannelId,
  type GatewayMessage,
  type GatewayOutbound,
} from './types';

/** How an adapter sends a message (host-injected; mock in tests). */
export interface GatewayTransport {
  /** Send one outbound message. Returns the channel-side message id. */
  send(outbound: GatewayOutbound): Promise<string>;
}

/** In-memory transport that records sends (tests + dry-run). */
export class MockGatewayTransport implements GatewayTransport {
  readonly sent: GatewayOutbound[] = [];

  async send(outbound: GatewayOutbound): Promise<string> {
    this.sent.push(outbound);
    return `mock-${randomUUID()}`;
  }
}

/** One channel adapter: payload in, normalized message out. */
export interface GatewayAdapter {
  readonly channel: GatewayChannelId;
  /** Normalize a raw webhook payload (or undefined when not a message). */
  normalize(payload: unknown): GatewayMessage | undefined;
  /** Format an outbound message for the channel's send API. */
  format(outbound: GatewayOutbound): Record<string, unknown>;
}

function baseMessage(channel: GatewayChannelId, senderId: string, chatId: string, text: string, senderName = ''): GatewayMessage {
  const command = parseGatewayCommand(text);
  return {
    id: randomUUID(),
    channel,
    senderId,
    senderName,
    chatId,
    text: text.trim(),
    ...(command.command ? { command: command.command } : {}),
    ...(command.commandArgs ? { commandArgs: command.commandArgs } : {}),
    receivedAt: new Date().toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Telegram webhook payload -> GatewayMessage. */
export class TelegramAdapter implements GatewayAdapter {
  readonly channel: GatewayChannelId = 'telegram';

  normalize(payload: unknown): GatewayMessage | undefined {
    if (!isRecord(payload)) return undefined;
    const message = payload.message;
    if (!isRecord(message)) return undefined;
    const text = typeof message.text === 'string' ? message.text : '';
    const from = isRecord(message.from) ? message.from : {};
    const chat = isRecord(message.chat) ? message.chat : {};
    const senderId = String(from.id ?? chat.id ?? '');
    if (!senderId || !text) return undefined;
    const senderName = [from.first_name, from.last_name].filter(Boolean).join(' ');
    return baseMessage('telegram', senderId, String(chat.id ?? senderId), text, senderName || String(from.username ?? ''));
  }

  format(outbound: GatewayOutbound): Record<string, unknown> {
    return {
      chat_id: outbound.chatId,
      text: outbound.text,
      ...(outbound.replyToMessageId ? { reply_to_message_id: outbound.replyToMessageId } : {}),
    };
  }
}

/** Slack Events API payload -> GatewayMessage. */
export class SlackAdapter implements GatewayAdapter {
  readonly channel: GatewayChannelId = 'slack';

  normalize(payload: unknown): GatewayMessage | undefined {
    if (!isRecord(payload)) return undefined;
    const event = payload.event;
    if (!isRecord(event) || event.type !== 'message') return undefined;
    if (typeof event.text !== 'string' || !event.text) return undefined;
    if (typeof event.bot_id === 'string') return undefined; // Ignore other bots.
    const senderId = String(event.user ?? '');
    if (!senderId) return undefined;
    return baseMessage('slack', senderId, String(event.channel ?? senderId), event.text);
  }

  format(outbound: GatewayOutbound): Record<string, unknown> {
    return { channel: outbound.chatId, text: outbound.text };
  }
}

/** Discord gateway payload -> GatewayMessage. */
export class DiscordAdapter implements GatewayAdapter {
  readonly channel: GatewayChannelId = 'discord';

  normalize(payload: unknown): GatewayMessage | undefined {
    if (!isRecord(payload)) return undefined;
    const data = isRecord(payload.d) ? payload.d : payload;
    if (typeof data.content !== 'string' || !data.content) return undefined;
    const author = isRecord(data.author) ? data.author : {};
    if (author.bot === true) return undefined; // Ignore other bots.
    const senderId = String(author.id ?? '');
    if (!senderId) return undefined;
    return baseMessage(
      'discord',
      senderId,
      String(data.channel_id ?? senderId),
      data.content,
      String(author.username ?? ''),
    );
  }

  format(outbound: GatewayOutbound): Record<string, unknown> {
    return { content: outbound.text };
  }
}

/** WhatsApp Cloud API payload -> GatewayMessage. */
export class WhatsappAdapter implements GatewayAdapter {
  readonly channel: GatewayChannelId = 'whatsapp';

  normalize(payload: unknown): GatewayMessage | undefined {
    if (!isRecord(payload)) return undefined;
    const entry = Array.isArray(payload.entry) ? payload.entry[0] : undefined;
    const change = isRecord(entry) && Array.isArray(entry.changes) ? entry.changes[0] : undefined;
    const value = isRecord(change) ? change.value : undefined;
    const message = isRecord(value) && Array.isArray(value.messages) ? value.messages[0] : undefined;
    if (!isRecord(message)) return undefined;
    const text = isRecord(message.text) && typeof message.text.body === 'string' ? message.text.body : '';
    if (!text) return undefined;
    const senderId = String(message.from ?? '');
    if (!senderId) return undefined;
    return baseMessage('whatsapp', senderId, senderId, text);
  }

  format(outbound: GatewayOutbound): Record<string, unknown> {
    return {
      messaging_product: 'whatsapp',
      to: outbound.chatId,
      type: 'text',
      text: { body: outbound.text },
    };
  }
}

/** All built-in adapters, keyed by channel. */
export function createGatewayAdapters(): Record<GatewayChannelId, GatewayAdapter> {
  return {
    telegram: new TelegramAdapter(),
    slack: new SlackAdapter(),
    discord: new DiscordAdapter(),
    whatsapp: new WhatsappAdapter(),
  };
}
