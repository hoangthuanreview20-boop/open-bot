/**
 * Shared gateway sessions — one user, one session, any channel
 * (v1.02 rescue port of the v1.00 work).
 *
 * A user is identified by a stable gateway user id (derived by the
 * host from the channel sender id, e.g. `telegram:<senderId>` — the
 * host decides the mapping; this module only stores it). The same
 * user chatting on Telegram and then on Slack shares one session:
 * history follows the user, not the channel.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { GatewayChannelId, GatewayMessage } from './types';

/** One shared session (one user across channels). */
export interface GatewaySession {
  id: string;
  /** Stable gateway user id (host-derived, e.g. `telegram:12345`). */
  userId: string;
  /** Channels this user has chatted on (in first-seen order). */
  channels: GatewayChannelId[];
  /** Bot id answering this session. */
  botId?: string;
  createdAt: string;
  updatedAt: string;
  /** Inbound history (capped by the gateway config). */
  messages: GatewayMessage[];
}

/** File-backed shared-session store (atomic writes, corrupt file -> empty). */
export class GatewaySessionStore {
  private readonly filePath: string;
  private readonly maxHistory: number;
  private sessions = new Map<string, GatewaySession>();
  private readonly byUser = new Map<string, string>();

  constructor(filePath: string, maxHistory = 100) {
    this.filePath = filePath;
    this.maxHistory = Math.max(1, maxHistory);
    this.load();
  }

  /** Find or create the session for a user id. */
  getOrCreate(userId: string, botId?: string): GatewaySession {
    const existingId = this.byUser.get(userId);
    if (existingId) {
      const existing = this.sessions.get(existingId);
      if (existing) return existing;
    }
    const now = new Date().toISOString();
    const session: GatewaySession = {
      id: randomUUID(),
      userId,
      channels: [],
      ...(botId ? { botId } : {}),
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.sessions.set(session.id, session);
    this.byUser.set(userId, session.id);
    this.persist();
    return session;
  }

  get(sessionId: string): GatewaySession | undefined {
    return this.sessions.get(sessionId);
  }

  getByUser(userId: string): GatewaySession | undefined {
    const id = this.byUser.get(userId);
    return id ? this.sessions.get(id) : undefined;
  }

  /** Append an inbound message to the user's session (channels + history updated). */
  recordMessage(userId: string, message: GatewayMessage, botId?: string): GatewaySession {
    const session = this.getOrCreate(userId, botId);
    if (!session.channels.includes(message.channel)) session.channels.push(message.channel);
    session.messages.push(message);
    if (session.messages.length > this.maxHistory) {
      session.messages.splice(0, session.messages.length - this.maxHistory);
    }
    session.updatedAt = new Date().toISOString();
    this.persist();
    return session;
  }

  list(): GatewaySession[] {
    return [...this.sessions.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  delete(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    this.byUser.delete(session.userId);
    this.persist();
    return true;
  }

  get size(): number {
    return this.sessions.size;
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const entry of parsed) {
        if (typeof entry !== 'object' || entry === null) continue;
        const session = entry as GatewaySession;
        if (typeof session.id !== 'string' || typeof session.userId !== 'string') continue;
        if (!Array.isArray(session.messages)) session.messages = [];
        if (!Array.isArray(session.channels)) session.channels = [];
        this.sessions.set(session.id, session);
        this.byUser.set(session.userId, session.id);
      }
    } catch {
      this.sessions = new Map();
      this.byUser.clear();
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify([...this.sessions.values()], null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Sessions are best-effort; a failed write must not break the gateway.
    }
  }
}

/** Build a stable gateway user id from a channel + sender id. */
export function gatewayUserId(channel: GatewayChannelId, senderId: string): string {
  return `${channel}:${senderId}`;
}
