/**
 * Blackboard — shared key-value + event log for one orchestration
 * session (v1.02 rescue port of the v0.99 work).
 *
 * Workers share facts through the blackboard instead of passing
 * messages directly: a worker writes a key, the supervisor and other
 * workers read it. Every write bumps a version (optimistic locking):
 * a writer that read version N can only write when the current
 * version is still N — otherwise it must re-read and retry, so two
 * workers never silently overwrite each other.
 */

export interface BlackboardEntry {
  key: string;
  value: unknown;
  /** Monotonic version of this key (starts at 1). */
  version: number;
  updatedAt: string;
  updatedBy?: string;
}

export interface BlackboardEvent {
  seq: number;
  at: string;
  kind: 'set' | 'delete';
  key: string;
  by?: string;
}

/** Version conflict: the key changed since the caller read it. */
export class BlackboardConflictError extends Error {
  readonly key: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;
  constructor(key: string, expectedVersion: number, actualVersion: number) {
    super(`blackboard conflict on ${key}: expected version ${expectedVersion}, got ${actualVersion}`);
    this.name = 'BlackboardConflictError';
    this.key = key;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/** In-memory blackboard for one session. */
export class Blackboard {
  readonly sessionId: string;
  private readonly entries = new Map<string, BlackboardEntry>();
  private readonly events: BlackboardEvent[] = [];
  private seq = 0;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** Read an entry (undefined when missing). */
  get(key: string): BlackboardEntry | undefined {
    return this.entries.get(key);
  }

  /** All entries (sorted by key). */
  list(): BlackboardEntry[] {
    return [...this.entries.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  /**
   * Write a key. When `expectedVersion` is given, the write fails
   * with `BlackboardConflictError` when the key moved on.
   */
  set(key: string, value: unknown, by?: string, expectedVersion?: number): BlackboardEntry {
    const current = this.entries.get(key);
    if (expectedVersion !== undefined && (current?.version ?? 0) !== expectedVersion) {
      throw new BlackboardConflictError(key, expectedVersion, current?.version ?? 0);
    }
    const entry: BlackboardEntry = {
      key,
      value,
      version: (current?.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      ...(by ? { updatedBy: by } : {}),
    };
    this.entries.set(key, entry);
    this.events.push({ seq: ++this.seq, at: entry.updatedAt, kind: 'set', key, ...(by ? { by } : {}) });
    return entry;
  }

  /** Delete a key (false when it did not exist). */
  delete(key: string, by?: string): boolean {
    const removed = this.entries.delete(key);
    if (removed) {
      this.events.push({ seq: ++this.seq, at: new Date().toISOString(), kind: 'delete', key, ...(by ? { by } : {}) });
    }
    return removed;
  }

  /** Event log (append-only, in order). */
  history(): BlackboardEvent[] {
    return [...this.events];
  }

  get size(): number {
    return this.entries.size;
  }
}
