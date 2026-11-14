/**
 * Vault audit log — who touched which secret, when (v1.02 rescue
 * port of the v1.00 work).
 *
 * Every vault access the host routes through `VaultAudit` is logged
 * (JSONL, one record per line): set / get / delete / export / import,
 * with the namespace + key, the actor, and the outcome. Secret
 * VALUES are never logged — only the key name. The log is the answer
 * to "did anything read my key?".
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type VaultAuditAction = 'set' | 'get' | 'delete' | 'export' | 'import' | 'list';

/** One vault access record (no secret values, only key names). */
export interface VaultAuditRecord {
  at: string;
  action: VaultAuditAction;
  namespace: string;
  key?: string;
  actor?: string;
  outcome: 'ok' | 'denied' | 'error';
  detail?: string;
}

/** Append-only JSONL audit log for vault access. */
export class VaultAuditLog {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  append(record: VaultAuditRecord): void {
    try {
      fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // Audit is best-effort; a failed write must not break the vault.
    }
  }

  /** Read records back (newest first, bad lines skipped). */
  read(limit = 100): VaultAuditRecord[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return [];
    }
    const out: VaultAuditRecord[] = [];
    for (const line of raw.split('\n').reverse()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed === 'object' && parsed !== null) out.push(parsed as VaultAuditRecord);
      } catch {
        // Bad line: skip.
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Only the accesses to one namespace (newest first). */
  forNamespace(namespace: string, limit = 100): VaultAuditRecord[] {
    return this.read(limit * 2).filter((r) => r.namespace === namespace).slice(0, limit);
  }
}
