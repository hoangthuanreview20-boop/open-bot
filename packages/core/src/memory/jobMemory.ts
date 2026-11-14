/**
 * Job memory — short-lived memory scoped to one job/run (v1.02 rescue
 * port of the v1.00 work).
 *
 * A job (a research sweep, a build, a long task) accumulates facts
 * that matter for the job but should not pollute the user's
 * long-term memory until the job finishes. `JobMemory` holds those
 * facts in memory + an optional JSON file; when the job ends, the
 * host promotes the keepers into `LongTermMemory` (via
 * `promoteToLongTerm`) and discards the rest. Nothing here calls a
 * model — facts are written by the host explicitly.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { LongTermMemory } from './longterm';

export interface JobMemoryEntry {
  id: string;
  jobId: string;
  key: string;
  value: string;
  tags: string[];
  confidence: number;
  /** True when this fact should be promoted to long-term memory. */
  keep: boolean;
  createdAt: string;
}

export interface JobMemoryOptions {
  jobId: string;
  /** Optional JSON file for persistence (undefined = memory only). */
  filePath?: string;
}

/** Short-lived, job-scoped facts with an explicit promote step. */
export class JobMemory {
  readonly jobId: string;
  private readonly filePath?: string;
  private entries: JobMemoryEntry[] = [];

  constructor(options: JobMemoryOptions) {
    this.jobId = options.jobId;
    this.filePath = options.filePath;
    this.load();
  }

  /** Record a fact for this job (same key overwrites). */
  remember(key: string, value: string, options: { tags?: string[]; confidence?: number; keep?: boolean } = {}): JobMemoryEntry {
    if (!key.trim()) throw new Error('Job memory key must not be empty.');
    if (!value.trim()) throw new Error('Job memory value must not be empty.');
    const existing = this.entries.find((e) => e.key === key);
    if (existing) {
      existing.value = value;
      existing.tags = options.tags ?? existing.tags;
      existing.confidence = options.confidence ?? existing.confidence;
      existing.keep = options.keep ?? existing.keep;
      this.persist();
      return { ...existing };
    }
    const entry: JobMemoryEntry = {
      id: randomUUID(),
      jobId: this.jobId,
      key,
      value,
      tags: options.tags ?? [],
      confidence: options.confidence ?? 0.8,
      keep: options.keep ?? false,
      createdAt: new Date().toISOString(),
    };
    this.entries.push(entry);
    this.persist();
    return { ...entry };
  }

  get(key: string): JobMemoryEntry | undefined {
    return this.entries.find((e) => e.key === key);
  }

  /** All entries (newest last). */
  list(): JobMemoryEntry[] {
    return [...this.entries];
  }

  /** Entries marked keep (the promotion candidates). */
  keepers(): JobMemoryEntry[] {
    return this.entries.filter((e) => e.keep);
  }

  forget(key: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.key !== key);
    if (this.entries.length !== before) this.persist();
    return this.entries.length !== before;
  }

  /** Promote kept facts into long-term memory (returns the count promoted). */
  promoteToLongTerm(memory: LongTermMemory, botId = ''): number {
    let promoted = 0;
    for (const entry of this.keepers()) {
      memory.remember({
        key: entry.key,
        value: entry.value,
        tags: [...new Set([...entry.tags, 'job', this.jobId])],
        confidence: entry.confidence,
        botId,
      });
      promoted++;
    }
    return promoted;
  }

  get size(): number {
    return this.entries.length;
  }

  private load(): void {
    if (!this.filePath) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.entries = parsed.filter(
          (entry): entry is JobMemoryEntry =>
            typeof entry === 'object' && entry !== null && (entry as JobMemoryEntry).jobId === this.jobId,
        );
      }
    } catch {
      this.entries = [];
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.entries, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Job memory is best-effort; a failed write must not break the job.
    }
  }
}
