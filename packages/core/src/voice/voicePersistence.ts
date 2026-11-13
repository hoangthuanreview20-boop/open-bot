/**
 * Voice session persistence (v0.96, Đội T5 — voice live).
 *
 * A realtime call ends when the socket dies, but the conversation
 * does not have to: the transcript and the session counters are
 * saved to disk as JSON, and the next session can resume from them.
 * Resume restores the TRANSCRIPT (what was said, by whom, when) —
 * never the socket: a resumed session still dials a fresh
 * connection, and the restored transcript is shown as history, not
 * replayed to the model as live audio.
 *
 * Storage shape (one file per session):
 *   <dir>/<sessionId>.json   e.g. ~/.open-bot/voice-sessions/v096-....json
 *
 *   { version: 1, sessionId, provider, turnMode, botId?,
 *     startedAt, updatedAt, endedAt?, state, bargeInCount,
 *     turnCount, transcript: [{ id, at, speaker, text, isFinal }] }
 *
 * Rules (explicit, so a bad disk never breaks a live call):
 *   - Writes are atomic: write `<file>.tmp` then rename over the
 *     real file, so a crash mid-write cannot leave a half file.
 *   - Loads are corruption-tolerant: unparseable JSON (or a wrong
 *     shape) returns null and the bad file is renamed aside to
 *     `<file>.corrupt-<timestamp>` for inspection, never deleted.
 *   - The store never throws on save/load/list: failures return
 *     false / null / [] and the session keeps running in memory.
 *   - Transcript entries are capped (`maxTranscriptEntries`,
 *     default 500): the oldest entries are dropped first, so a
 *     very long call cannot grow the file without bound.
 *   - `prune()` drops sessions older than `maxAgeMs` (default 30
 *     days) and keeps at most `maxSessions` (default 50), newest
 *     first — the voice-sessions dir stays small on its own.
 *   - Session ids are sanitised to `[A-Za-z0-9._-]` so a crafted
 *     id can never escape the directory (no `../` traversal).
 *   - No audio is stored here — only text. Mic/model audio frames
 *     are never written to disk by this store.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/** One transcript line in a persisted voice session. */
export interface VoiceTranscriptEntry {
  /** Stable id (`<sessionId>-<seq>`). */
  id: string;
  /** When the line was finalised (wall clock ms). */
  at: number;
  /** Who said it. */
  speaker: 'user' | 'model';
  /** Line text. */
  text: string;
  /** True when the line is final (interim lines are not stored). */
  isFinal: boolean;
}

/** Realtime provider id, as stored (same ids as voice/types.ts). */
export type PersistedVoiceProvider = 'openai' | 'gemini' | 'openai-compatible';

/** One persisted voice session (the whole file). */
export interface VoiceSessionRecord {
  version: 1;
  sessionId: string;
  provider: PersistedVoiceProvider;
  turnMode: string;
  /** Bot this session belonged to, when known. */
  botId?: string;
  startedAt: number;
  updatedAt: number;
  /** When the session ended (absent while live). */
  endedAt?: number;
  /** Last session state when saved. */
  state: string;
  bargeInCount: number;
  turnCount: number;
  transcript: VoiceTranscriptEntry[];
}

/** Default directory: ~/.open-bot/voice-sessions. */
export function defaultVoiceSessionsDir(): string {
  return path.join(os.homedir(), '.open-bot', 'voice-sessions');
}

/** Default max transcript lines kept per session. */
export const VOICE_PERSIST_DEFAULT_MAX_TRANSCRIPT = 500;
/** Default max age of a stored session (30 days). */
export const VOICE_PERSIST_DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Default max sessions kept on disk. */
export const VOICE_PERSIST_DEFAULT_MAX_SESSIONS = 50;

/** Create a fresh record for a new session. */
export function createVoiceSessionRecord(input: {
  sessionId: string;
  provider: PersistedVoiceProvider;
  turnMode: string;
  botId?: string;
  startedAt?: number;
}): VoiceSessionRecord {
  const now = input.startedAt ?? Date.now();
  return {
    version: 1,
    sessionId: input.sessionId,
    provider: input.provider,
    turnMode: input.turnMode,
    ...(input.botId ? { botId: input.botId } : {}),
    startedAt: now,
    updatedAt: now,
    state: 'connecting',
    bargeInCount: 0,
    turnCount: 0,
    transcript: [],
  };
}

/** New session id: `v096-<time>-<random>`. */
export function newVoiceSessionId(): string {
  return `v096-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Sanitise a session id for use as a file name ('' when unusable). */
export function sanitizeVoiceSessionId(sessionId: string): string {
  const clean = String(sessionId ?? '').replace(/[^A-Za-z0-9._-]/g, '');
  if (!clean || clean === '.' || clean === '..') return '';
  return clean.slice(0, 128);
}

/** True when the value looks like a VoiceSessionRecord. */
export function isVoiceSessionRecord(value: unknown): value is VoiceSessionRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    r.version === 1 &&
    typeof r.sessionId === 'string' &&
    typeof r.provider === 'string' &&
    typeof r.startedAt === 'number' &&
    Array.isArray(r.transcript)
  );
}

/** Options for the voice session store. */
export interface VoiceSessionStoreOptions {
  /** Directory holding the session files. Default ~/.open-bot/voice-sessions. */
  dir?: string;
  /** Max transcript lines kept per session. Default 500. */
  maxTranscriptEntries?: number;
}

/**
 * JSON store for voice sessions. All methods are synchronous and
 * never throw (disk failures degrade to false / null / []).
 */
export class VoiceSessionStore {
  private readonly dir: string;
  private readonly maxTranscriptEntries: number;

  constructor(options: VoiceSessionStoreOptions = {}) {
    this.dir = options.dir ?? defaultVoiceSessionsDir();
    this.maxTranscriptEntries = Math.max(
      1,
      options.maxTranscriptEntries ?? VOICE_PERSIST_DEFAULT_MAX_TRANSCRIPT,
    );
  }

  /** Directory this store writes to. */
  get directory(): string {
    return this.dir;
  }

  /** File path for a session id ('' when the id is unusable). */
  filePath(sessionId: string): string {
    const clean = sanitizeVoiceSessionId(sessionId);
    if (!clean) return '';
    return path.join(this.dir, `${clean}.json`);
  }

  /**
   * Save (create or replace) a whole record. Returns false when the
   * record is invalid or the write failed. Transcript is capped to
   * `maxTranscriptEntries` (oldest dropped first) before writing.
   */
  save(record: VoiceSessionRecord): boolean {
    if (!isVoiceSessionRecord(record)) return false;
    const file = this.filePath(record.sessionId);
    if (!file) return false;
    const toSave: VoiceSessionRecord = {
      ...record,
      updatedAt: Date.now(),
      transcript:
        record.transcript.length > this.maxTranscriptEntries
          ? record.transcript.slice(-this.maxTranscriptEntries)
          : record.transcript,
    };
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(toSave, null, 2), 'utf8');
      renameSync(tmp, file);
      return true;
    } catch {
      try {
        rmSync(`${file}.tmp-${process.pid}`, { force: true });
      } catch {
        // Best-effort cleanup.
      }
      return false;
    }
  }

  /** Load one session by id; null when missing / corrupt / invalid. */
  load(sessionId: string): VoiceSessionRecord | null {
    const file = this.filePath(sessionId);
    if (!file || !existsSync(file)) return null;
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      this.quarantine(file);
      return null;
    }
    if (!isVoiceSessionRecord(parsed)) {
      this.quarantine(file);
      return null;
    }
    return parsed;
  }

  /**
   * Append one final transcript line to a session (loads, appends,
   * saves). Returns false when the session does not exist or the
   * save failed. Interim lines (`isFinal: false`) are ignored —
   * only final lines are persisted.
   */
  appendTranscript(sessionId: string, entry: VoiceTranscriptEntry): boolean {
    if (!entry || entry.isFinal !== true) return false;
    const record = this.load(sessionId);
    if (!record) return false;
    record.transcript.push(entry);
    return this.save(record);
  }

  /**
   * Resume a session: load its record for a fresh connection.
   * Returns the record with `state` reset to `'idle'` and
   * `endedAt` cleared (the socket is NOT restored — the caller
   * dials a new connection and shows the transcript as history).
   * Null when nothing was stored.
   */
  resume(sessionId: string): VoiceSessionRecord | null {
    const record = this.load(sessionId);
    if (!record) return null;
    return { ...record, state: 'idle', endedAt: undefined };
  }

  /** Delete one session file. True when a file was removed. */
  delete(sessionId: string): boolean {
    const file = this.filePath(sessionId);
    if (!file || !existsSync(file)) return false;
    try {
      rmSync(file, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Ids of all stored sessions, newest first (by updatedAt). */
  list(): string[] {
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const withTime: Array<{ id: string; at: number }> = [];
    for (const f of files) {
      const id = f.slice(0, -'.json'.length);
      let at = 0;
      try {
        at = statSync(path.join(this.dir, f)).mtimeMs;
      } catch {
        at = 0;
      }
      withTime.push({ id, at });
    }
    withTime.sort((a, b) => b.at - a.at);
    return withTime.map((w) => w.id);
  }

  /**
   * Prune old / excess sessions. Drops sessions older than
   * `maxAgeMs` (default 30 days) and, beyond that, keeps only the
   * newest `maxSessions` (default 50). Returns the ids removed.
   */
  prune(
    maxAgeMs: number = VOICE_PERSIST_DEFAULT_MAX_AGE_MS,
    maxSessions: number = VOICE_PERSIST_DEFAULT_MAX_SESSIONS,
  ): string[] {
    const removed: string[] = [];
    const now = Date.now();
    const ids = this.list();
    const keep: string[] = [];
    for (const id of ids) {
      const record = this.load(id);
      const age = record ? now - record.updatedAt : Number.POSITIVE_INFINITY;
      if (age > maxAgeMs) {
        if (this.delete(id)) removed.push(id);
      } else {
        keep.push(id);
      }
    }
    for (const id of keep.slice(maxSessions)) {
      if (this.delete(id)) removed.push(id);
    }
    return removed;
  }

  /** Move a corrupt file aside (`<file>.corrupt-<ts>`) for inspection. */
  private quarantine(file: string): void {
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      // Best-effort: the bad file stays, load still returns null.
    }
  }
}

/** Build one transcript entry (id = `<sessionId>-<seq>`). */
export function buildVoiceTranscriptEntry(
  sessionId: string,
  seq: number,
  speaker: 'user' | 'model',
  text: string,
  at: number = Date.now(),
): VoiceTranscriptEntry {
  return { id: `${sessionId}-${seq}`, at, speaker, text, isFinal: true };
}
