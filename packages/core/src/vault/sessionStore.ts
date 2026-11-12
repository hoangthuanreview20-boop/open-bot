/**
 * Session-only secret store (v0.53, P1-6 — REA deep-dive lần 2 §7.1:
 * Grok's `user-secrets` keeps `sessionSecrets: Map` — secrets that
 * live only for the session and are never written to disk).
 *
 * Original code, same idea: a plain in-memory Map with an optional
 * per-entry TTL (`maxAgeMs` + `savedAtMs`). Nothing here ever touches
 * the filesystem — `set`/`get`/`delete`/`list`/`clear` are all
 * memory-only. Expired entries behave as if they were never set
 * (`get` returns null) and are dropped lazily on access.
 *
 * Values are held as strings in memory only while the process runs;
 * the caller (Vault) is responsible for never logging them.
 */
export interface SessionSecretEntry {
  value: string;
  /** Epoch ms when the entry was stored. */
  savedAtMs: number;
  /** Optional lifetime in ms; expired entries are refused on read. */
  maxAgeMs?: number;
}

/** True when the entry is past its `maxAgeMs` (no limit = never). */
export function isSessionEntryExpired(entry: SessionSecretEntry, nowMs: number = Date.now()): boolean {
  if (entry.maxAgeMs === undefined) return false;
  if (!(entry.maxAgeMs > 0)) return false;
  return nowMs - entry.savedAtMs >= entry.maxAgeMs;
}

export class SessionSecretStore {
  private readonly entries = new Map<string, SessionSecretEntry>();

  /** Store a value in memory only. Overwrites any previous entry. */
  set(key: string, value: string, opts?: { maxAgeMs?: number }): void {
    if (typeof key !== 'string' || key === '') {
      throw new Error('SessionSecretStore needs a non-empty string key.');
    }
    if (typeof value !== 'string') {
      throw new Error('SessionSecretStore value must be a string.');
    }
    this.entries.set(key, { value, savedAtMs: Date.now(), maxAgeMs: opts?.maxAgeMs });
  }

  /** Returns null when absent or expired (expired entries are dropped). */
  get(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (isSessionEntryExpired(entry)) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  /** True when a live (non-expired) entry exists. */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /** Returns true when an entry was removed. */
  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  /** Keys of live entries (expired ones are dropped first). */
  list(): string[] {
    const out: string[] = [];
    for (const [key, entry] of this.entries) {
      if (isSessionEntryExpired(entry)) {
        this.entries.delete(key);
      } else {
        out.push(key);
      }
    }
    return out.sort();
  }

  /** Drop every session secret (e.g. on logout / account switch). */
  clear(): void {
    this.entries.clear();
  }

  /** Number of live entries. */
  get size(): number {
    return this.list().length;
  }
}
