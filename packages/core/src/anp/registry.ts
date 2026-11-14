/**
 * ANP local registry (v1.02, Team T3).
 *
 * The registry is the local half of ANP discovery: it remembers every
 * agent this machine has met (own identity + remote agents discovered
 * via `anp/discovery.ts`), keyed by DID. Lookup is by DID (exact) or
 * by capability tag / name substring (search). A registry is
 * deliberately local-first — there is no central ANP directory to
 * phone home to, and no record ever leaves the machine except through
 * the caller's own sharing (e.g. serving the local DID document).
 *
 * `AnpRegistry` is in-memory; `FileAnpRegistry` adds a JSON file
 * (0600, atomic write) so discovered agents survive restarts. Loading
 * tolerates a missing / corrupt file (starts empty, counts bad
 * entries) and never throws at startup.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AnpAgentRecord, AnpDid, AnpDidDocument, AnpDiscoveryQuery } from './types';
import { isAnpDid } from './did';

/** Default file name under the app data dir. */
export const ANP_REGISTRY_FILE_NAME = 'anp-registry.json';

/** Max records the registry holds (oldest updated evicted first). */
export const ANP_REGISTRY_MAX_RECORDS = 500;

function isValidRecord(value: unknown): value is AnpAgentRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r['did'] === 'string' &&
    isAnpDid(r['did']) &&
    typeof r['name'] === 'string' &&
    Array.isArray(r['skills']) &&
    typeof r['didDocument'] === 'object' &&
    r['didDocument'] !== null &&
    typeof r['registeredAt'] === 'string' &&
    typeof r['updatedAt'] === 'string'
  );
}

/**
 * In-memory ANP registry. Records are stored by DID; registering the
 * same DID again updates the record (new URL/skills/document) and
 * keeps the original `registeredAt`.
 */
export class AnpRegistry {
  protected readonly records = new Map<AnpDid, AnpAgentRecord>();

  /** Number of agents registered. */
  get size(): number {
    return this.records.size;
  }

  /**
   * Register (or update) an agent. The DID document's id must match
   * the DID, and the document's key must match the DID — a record
   * whose document belongs to another DID is rejected.
   */
  register(record: Omit<AnpAgentRecord, 'registeredAt' | 'updatedAt'> & { registeredAt?: string; updatedAt?: string }): AnpAgentRecord {
    if (!isAnpDid(record.did)) throw new Error(`Không đăng ký được agent: DID không hợp lệ "${record.did}".`);
    if (record.didDocument.id !== record.did) {
      throw new Error(`Không đăng ký được agent: DID document id "${record.didDocument.id}" khác DID "${record.did}".`);
    }
    const now = new Date().toISOString();
    const existing = this.records.get(record.did);
    const stored: AnpAgentRecord = {
      did: record.did,
      name: record.name,
      ...(record.url !== undefined ? { url: record.url } : {}),
      skills: [...new Set(record.skills.map((s) => s.trim()).filter((s) => s.length > 0))],
      didDocument: record.didDocument,
      registeredAt: existing?.registeredAt ?? record.registeredAt ?? now,
      updatedAt: record.updatedAt ?? now,
    };
    this.records.set(record.did, stored);
    if (this.records.size > ANP_REGISTRY_MAX_RECORDS) {
      // Evict the least recently updated record (not the one just stored).
      let oldest: AnpAgentRecord | undefined;
      for (const candidate of this.records.values()) {
        if (candidate.did === stored.did) continue;
        if (oldest === undefined || candidate.updatedAt < oldest.updatedAt) oldest = candidate;
      }
      if (oldest !== undefined) this.records.delete(oldest.did);
    }
    return { ...stored, skills: [...stored.skills] };
  }

  /** Exact lookup by DID (undefined when unknown). */
  resolve(did: AnpDid): AnpAgentRecord | undefined {
    const found = this.records.get(did);
    if (!found) return undefined;
    return { ...found, skills: [...found.skills] };
  }

  /** True when this DID is registered. */
  has(did: AnpDid): boolean {
    return this.records.has(did);
  }

  /** Remove an agent; true when something was removed. */
  remove(did: AnpDid): boolean {
    return this.records.delete(did);
  }

  /** All records, most recently updated first. */
  list(): AnpAgentRecord[] {
    return [...this.records.values()]
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .map((r) => ({ ...r, skills: [...r.skills] }));
  }

  /** Search by skill tag and/or name substring (case-insensitive). */
  find(query: AnpDiscoveryQuery = {}): AnpAgentRecord[] {
    const limit = Math.max(0, query.limit ?? 50);
    const needle = query.nameContains?.toLowerCase();
    const out: AnpAgentRecord[] = [];
    for (const record of this.list()) {
      if (query.skill !== undefined && !record.skills.includes(query.skill)) continue;
      if (needle !== undefined && needle.length > 0 && !record.name.toLowerCase().includes(needle)) continue;
      out.push(record);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** All records as a JSON array (oldest first, for persistence). */
  exportJson(): AnpAgentRecord[] {
    return [...this.records.values()]
      .sort((a, b) => (a.registeredAt < b.registeredAt ? -1 : 1))
      .map((r) => ({ ...r, skills: [...r.skills] }));
  }

  /** Replace the contents from an exported array (bad entries skipped). */
  importJson(values: unknown): { imported: number; skipped: number } {
    let imported = 0;
    let skipped = 0;
    if (!Array.isArray(values)) return { imported: 0, skipped: 0 };
    for (const value of values) {
      if (!isValidRecord(value)) {
        skipped += 1;
        continue;
      }
      this.records.set(value.did, { ...value, skills: [...value.skills] });
      imported += 1;
    }
    return { imported, skipped };
  }

  /** Remove every record. */
  clear(): void {
    this.records.clear();
  }
}

/**
 * File-backed registry: loads the JSON file at construction and saves
 * atomically (temp file + rename, mode 0600) on every mutation.
 * The DID document contains only public keys, but the file still gets
 * 0600 because agent lists can reveal who the user works with.
 */
export class FileAnpRegistry extends AnpRegistry {
  private readonly filePath: string;
  /** Entries skipped as invalid while loading the file. */
  readonly corruptEntries: number;
  /** Records loaded from the file at startup. */
  readonly loadedRecords: number;

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
    let corrupt = 0;
    let loaded = 0;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      if (fs.existsSync(filePath)) {
        const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8') as string);
        const result = this.importJson(parsed);
        loaded = result.imported;
        corrupt = result.skipped;
      }
    } catch {
      // Missing/corrupt registry file: start empty, do not crash.
      corrupt += 1;
    }
    this.corruptEntries = corrupt;
    this.loadedRecords = loaded;
  }

  /** Path of the backing JSON file. */
  get path(): string {
    return this.filePath;
  }

  private save(): void {
    try {
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.exportJson(), null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Disk failure must not break discovery — the in-memory
      // registry keeps working and the next save retries.
    }
  }

  override register(
    record: Omit<AnpAgentRecord, 'registeredAt' | 'updatedAt'> & { registeredAt?: string; updatedAt?: string },
  ): AnpAgentRecord {
    const stored = super.register(record);
    this.save();
    return stored;
  }

  override remove(did: AnpDid): boolean {
    const removed = super.remove(did);
    if (removed) this.save();
    return removed;
  }

  override clear(): void {
    super.clear();
    this.save();
  }
}

/** Create a registry — file-backed when a path is given, in-memory otherwise. */
export function createAnpRegistry(filePath?: string): AnpRegistry {
  if (filePath) return new FileAnpRegistry(filePath);
  return new AnpRegistry();
}

/** Build a registry record from an identity + its DID document. */
export function recordForIdentity(
  identity: { did: AnpDid; name: string },
  didDocument: AnpDidDocument,
  options: { url?: string; skills?: string[] } = {},
): Omit<AnpAgentRecord, 'registeredAt' | 'updatedAt'> {
  return {
    did: identity.did,
    name: identity.name,
    ...(options.url !== undefined ? { url: options.url } : {}),
    skills: options.skills ?? [],
    didDocument,
  };
}
