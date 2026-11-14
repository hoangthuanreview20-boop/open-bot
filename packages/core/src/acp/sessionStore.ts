/**
 * ACP session store — memory + file persistence (v1.02 rescue port of
 * the v0.99 work).
 *
 * Sessions survive an agent restart: the store keeps the session
 * record (cwd, MCP servers, config options, recorded agent messages)
 * in memory and, when a file path is given, in a JSON file written
 * atomically (temp + rename) with mode 0600. A corrupt file loads as
 * an empty store (fail-closed, never a half session).
 *
 * `close` only removes the session from memory (the store keeps it so
 * `session/load` can restore it later); `delete` removes it from the
 * store as well.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { AcpConfigOption, AcpMcpServerConfig, AcpRecordedMessage, AcpSessionInfo } from './types';

/** Default config options every new session starts with. */
export function defaultAcpConfigOptions(): AcpConfigOption[] {
  return [
    {
      id: 'mode',
      name: 'Mode',
      description: 'default: full agent; plan: plan only, no edits.',
      value: 'default',
      options: [
        { id: 'default', name: 'Default' },
        { id: 'plan', name: 'Plan' },
      ],
    },
    {
      id: 'verbose',
      name: 'Verbose',
      description: 'Include thought chunks in session updates.',
      value: false,
    },
  ];
}

export interface AcpStoredSession extends AcpSessionInfo {
  messages: AcpRecordedMessage[];
}

export interface AcpSessionStoreOptions {
  /** Optional JSON file for persistence (undefined = memory only). */
  filePath?: string;
}

const MAX_RECORDED_MESSAGES = 500;

/** In-memory ACP session store with optional JSON file persistence. */
export class AcpSessionStore {
  private readonly sessions = new Map<string, AcpStoredSession>();
  private readonly filePath?: string;

  constructor(options: AcpSessionStoreOptions = {}) {
    this.filePath = options.filePath;
    if (this.filePath) this.loadFromFile();
  }

  /** Create a session record (id generated when omitted). */
  create(input: {
    sessionId?: string;
    cwd: string;
    mcpServers?: Record<string, AcpMcpServerConfig>;
    configOptions?: AcpConfigOption[];
  }): AcpStoredSession {
    const now = new Date().toISOString();
    const session: AcpStoredSession = {
      sessionId: input.sessionId ?? randomUUID(),
      cwd: input.cwd,
      createdAt: now,
      updatedAt: now,
      mcpServers: input.mcpServers ?? {},
      configOptions: input.configOptions ?? defaultAcpConfigOptions(),
      messageCount: 0,
      messages: [],
    };
    this.sessions.set(session.sessionId, session);
    this.persist();
    return session;
  }

  get(sessionId: string): AcpStoredSession | undefined {
    return this.sessions.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** All sessions, newest first. */
  list(): AcpStoredSession[] {
    return [...this.sessions.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  /** Append a recorded agent message (capped, oldest dropped first). */
  recordMessage(sessionId: string, message: AcpRecordedMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.messages.push(message);
    if (session.messages.length > MAX_RECORDED_MESSAGES) {
      session.messages.splice(0, session.messages.length - MAX_RECORDED_MESSAGES);
    }
    session.messageCount = session.messages.length;
    session.updatedAt = new Date().toISOString();
    this.persist();
  }

  /** Replace the config option values of a session. Returns the new list. */
  setConfigOption(sessionId: string, optionId: string, value: unknown): AcpConfigOption[] | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const option = session.configOptions.find((o) => o.id === optionId);
    if (!option) return undefined;
    if (option.options && !option.options.some((o) => o.id === String(value))) return undefined;
    option.value = value;
    session.updatedAt = new Date().toISOString();
    this.persist();
    return session.configOptions;
  }

  /** Read one config option value (undefined when missing). */
  getConfigValue(sessionId: string, optionId: string): unknown {
    return this.sessions.get(sessionId)?.configOptions.find((o) => o.id === optionId)?.value;
  }

  /** Remove a session from memory only (kept in the file store). */
  close(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /** Remove a session from memory and from the file store. */
  delete(sessionId: string): boolean {
    const removed = this.sessions.delete(sessionId);
    this.persist();
    return removed;
  }

  /** Number of sessions held in memory. */
  get size(): number {
    return this.sessions.size;
  }

  private persist(): void {
    if (!this.filePath) return;
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions: [...this.sessions.values()] }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
      try {
        fs.chmodSync(this.filePath, 0o600);
      } catch {
        // chmod may fail on non-POSIX filesystems; the file is still written.
      }
    } catch {
      // Persistence is best-effort: a failed write must not break the session.
    }
  }

  private loadFromFile(): void {
    if (!this.filePath) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return;
      const sessions = (parsed as { sessions?: unknown }).sessions;
      if (!Array.isArray(sessions)) return;
      for (const entry of sessions) {
        if (typeof entry !== 'object' || entry === null) continue;
        const session = entry as AcpStoredSession;
        if (typeof session.sessionId !== 'string' || typeof session.cwd !== 'string') continue;
        if (!Array.isArray(session.messages)) session.messages = [];
        if (!Array.isArray(session.configOptions)) session.configOptions = defaultAcpConfigOptions();
        session.messageCount = session.messages.length;
        this.sessions.set(session.sessionId, session);
      }
    } catch {
      // Missing or corrupt file: start empty (fail-closed).
    }
  }
}
