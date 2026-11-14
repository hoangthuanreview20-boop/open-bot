/**
 * Compaction history store (v1.02 rescue port of the v0.99 work).
 *
 * A small JSON file store of past compactions (when, how many tokens
 * were freed, what summary was kept) so the user can see what the
 * agent threw away and why. Writes are atomic (temp + rename, mode
 * 0600); a corrupt file loads as empty (fail-closed).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** One compaction event (what was compacted, when, how much was freed). */
export interface CompactionRecord {
  id: string;
  at: string;
  botId?: string;
  runId?: string;
  tokensBefore: number;
  tokensAfter: number;
  turnsDropped: number;
  summaryChars: number;
  reason: 'budget' | 'manual' | 'long-run';
}

/** JSON file store of compaction history. */
export class CompactionHistory {
  private readonly filePath: string;
  private records: CompactionRecord[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  add(record: CompactionRecord): void {
    this.records.push(record);
    if (this.records.length > 500) this.records.splice(0, this.records.length - 500);
    this.persist();
  }

  list(limit = 50): CompactionRecord[] {
    return this.records.slice(-limit).reverse();
  }

  get size(): number {
    return this.records.length;
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.records = parsed.filter(
          (entry): entry is CompactionRecord =>
            typeof entry === 'object' && entry !== null && typeof (entry as CompactionRecord).id === 'string',
        );
      }
    } catch {
      this.records = [];
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.records, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch {
      // History is best-effort; a failed write must not break the run.
    }
  }
}
