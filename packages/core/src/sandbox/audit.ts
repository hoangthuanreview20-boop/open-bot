/**
 * Sandbox audit log — append-only record of enforcement decisions
 * (v1.02 rescue port of the v0.99 work).
 *
 * Every allow/deny decision the enforcer makes is logged (JSONL,
 * one record per line) so the user can see what the sandbox blocked
 * and why. No file contents or secrets are logged — only the action,
 * the target (host / path / command), and the outcome.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** One enforcement decision. */
export interface SandboxAuditEntry {
  at: string;
  botId?: string;
  action: 'exec' | 'write' | 'read' | 'network' | 'run';
  target: string;
  allowed: boolean;
  reason?: string;
  profile?: string;
}

/** Append-only JSONL audit log. */
export class SandboxAuditLogger {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  append(entry: SandboxAuditEntry): void {
    try {
      fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // Audit is best-effort; a failed write must not break the run.
    }
  }

  /** Read entries back (newest first, bad lines skipped). */
  read(limit = 100): SandboxAuditEntry[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return [];
    }
    const out: SandboxAuditEntry[] = [];
    for (const line of raw.split('\n').reverse()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed === 'object' && parsed !== null) out.push(parsed as SandboxAuditEntry);
      } catch {
        // Bad line: skip.
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Only the denied entries (newest first). */
  denied(limit = 100): SandboxAuditEntry[] {
    return this.read(limit * 2).filter((e) => !e.allowed).slice(0, limit);
  }
}
