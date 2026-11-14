/**
 * Gateway audit log — append-only JSONL (v1.02 rescue port of the
 * v1.00 work).
 *
 * One record per inbound/outbound event. No message text is logged
 * by default (only ids + channel + outcome), so tokens and private
 * chats never land in the log.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { GatewayChannelId } from './types';

/** One audit record (no message text, only metadata). */
export interface GatewayAuditRecord {
  at: string;
  direction: 'inbound' | 'outbound';
  channel: GatewayChannelId;
  userId?: string;
  chatId?: string;
  messageId?: string;
  /** 'ok' | 'rate_limited' | 'disabled' | 'error'. */
  outcome: string;
  detail?: string;
}

/** Append-only JSONL audit log. */
export class GatewayAuditLog {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  append(record: GatewayAuditRecord): void {
    try {
      fs.appendFileSync(this.filePath, `${JSON.stringify({ ...record, at: record.at ?? new Date().toISOString() })}\n`, 'utf8');
    } catch {
      // Audit is best-effort; a failed write must not break the gateway.
    }
  }

  /** Read records back (newest first, bad lines skipped). */
  read(limit = 100): GatewayAuditRecord[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return [];
    }
    const out: GatewayAuditRecord[] = [];
    for (const line of raw.split('\n').reverse()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed === 'object' && parsed !== null) out.push(parsed as GatewayAuditRecord);
      } catch {
        // Bad line: skip.
      }
      if (out.length >= limit) break;
    }
    return out;
  }
}
