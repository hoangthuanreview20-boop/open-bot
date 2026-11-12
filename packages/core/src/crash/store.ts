/**
 * Local crash-report store (v0.86, P2-7).
 *
 * One JSON file per report under `<userData>/crash-reports/`
 * (`<id>.json`, mode 0600 — reports may still contain a redacted
 * stack, so they are not world-readable). No network, no sending:
 * this store only keeps reports on disk until the user views or
 * deletes them (see `docs/crash-reporting.md`).
 *
 * Caps (rotation): at most `MAX_CRASH_REPORTS` files and at most
 * `MAX_CRASH_REPORTS_BYTES` total — when a new report would exceed
 * either cap, the oldest reports are deleted first. A corrupt file
 * is skipped on list (and never crashes the list call).
 *
 * Writes are atomic (temp file + rename) like the other local
 * stores in this repo (Vault, auto-approve rules).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  isValidCrashReportId,
  toCrashReportSummary,
  type CrashReport,
  type CrashReportSummary,
} from './report';

/** Max crash reports kept on disk (oldest deleted first). */
export const MAX_CRASH_REPORTS = 50;
/** Max total bytes of all stored reports (oldest deleted first). */
export const MAX_CRASH_REPORTS_BYTES = 5 * 1024 * 1024;

export interface CrashReportStoreOptions {
  /** Max reports kept (default `MAX_CRASH_REPORTS`). */
  maxReports?: number;
  /** Max total bytes kept (default `MAX_CRASH_REPORTS_BYTES`). */
  maxTotalBytes?: number;
}

interface StoredEntry {
  id: string;
  createdAt: string;
  bytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parse one stored file; undefined when it is not a valid report. */
function parseStoredReport(text: string): CrashReport | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(data)) return undefined;
  if (!isValidCrashReportId(data['id'])) return undefined;
  if (typeof data['createdAt'] !== 'string' || typeof data['message'] !== 'string') {
    return undefined;
  }
  if (data['source'] !== 'main' && data['source'] !== 'renderer') return undefined;
  if (
    data['kind'] !== 'uncaughtException' &&
    data['kind'] !== 'unhandledRejection' &&
    data['kind'] !== 'renderer-error'
  ) {
    return undefined;
  }
  return data as unknown as CrashReport;
}

export class CrashReportStore {
  /** Directory holding `<id>.json` files (created lazily on first save). */
  readonly directory: string;
  private readonly maxReports: number;
  private readonly maxTotalBytes: number;

  constructor(directory: string, opts: CrashReportStoreOptions = {}) {
    this.directory = directory;
    this.maxReports = opts.maxReports ?? MAX_CRASH_REPORTS;
    this.maxTotalBytes = opts.maxTotalBytes ?? MAX_CRASH_REPORTS_BYTES;
  }

  private filePath(id: string): string {
    return path.join(this.directory, `${id}.json`);
  }

  private ensureDir(): void {
    fs.mkdirSync(this.directory, { recursive: true });
  }

  /** All stored reports, newest first. Corrupt files are skipped, never thrown. */
  list(): CrashReport[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.directory);
    } catch {
      return [];
    }
    const out: CrashReport[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (!isValidCrashReportId(id)) continue;
      let text: string;
      try {
        text = fs.readFileSync(this.filePath(id), 'utf8');
      } catch {
        continue;
      }
      const report = parseStoredReport(text);
      if (report) out.push(report);
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return out;
  }

  /** Summaries for the list UI (no stacks). */
  listSummaries(): CrashReportSummary[] {
    return this.list().map(toCrashReportSummary);
  }

  /** One report by id, or undefined when missing/corrupt. */
  get(id: string): CrashReport | undefined {
    if (!isValidCrashReportId(id)) return undefined;
    let text: string;
    try {
      text = fs.readFileSync(this.filePath(id), 'utf8');
    } catch {
      return undefined;
    }
    return parseStoredReport(text);
  }

  /** How many reports are stored + their total bytes. */
  stats(): { count: number; totalBytes: number } {
    const reports = this.list();
    let totalBytes = 0;
    for (const report of reports) {
      try {
        totalBytes += fs.statSync(this.filePath(report.id)).size;
      } catch {
        // File vanished mid-list — ignore it.
      }
    }
    return { count: reports.length, totalBytes };
  }

  /**
   * Save a report (atomic tmp + rename, mode 0600), then enforce the
   * caps (oldest first). Returns the saved report. Never throws for
   * a valid report object — disk errors are swallowed so a crash
   * handler can never crash the app a second time; the caller checks
   * the boolean instead. Use `saveSync` from crash handlers.
   */
  save(report: CrashReport): boolean {
    try {
      this.saveOrThrow(report);
      return true;
    } catch {
      return false;
    }
  }

  /** Synchronous save (for `uncaughtException` handlers — no awaits allowed there). */
  saveSync(report: CrashReport): boolean {
    return this.save(report);
  }

  private saveOrThrow(report: CrashReport): void {
    if (!isValidCrashReportId(report.id)) {
      throw new Error(`Invalid crash report id "${String(report.id)}".`);
    }
    this.ensureDir();
    const tmp = `${this.filePath(report.id)}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath(report.id));
    try {
      fs.chmodSync(this.filePath(report.id), 0o600);
    } catch {
      // chmod fails on exotic filesystems — the file is already renamed.
    }
    this.enforceCaps();
  }

  /** Delete the oldest reports until count + bytes are within caps. */
  private enforceCaps(): void {
    const entries: StoredEntry[] = [];
    for (const report of this.list()) {
      let bytes = 0;
      try {
        bytes = fs.statSync(this.filePath(report.id)).size;
      } catch {
        continue;
      }
      entries.push({ id: report.id, createdAt: report.createdAt, bytes });
    }
    // Oldest first.
    entries.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    let totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
    while (
      (entries.length > this.maxReports || totalBytes > this.maxTotalBytes) &&
      entries.length > 0
    ) {
      const oldest = entries.shift()!;
      totalBytes -= oldest.bytes;
      try {
        fs.unlinkSync(this.filePath(oldest.id));
      } catch {
        // Already gone — continue enforcing the caps.
      }
    }
  }

  /** Delete one report. Returns true when a file was removed. */
  delete(id: string): boolean {
    if (!isValidCrashReportId(id)) return false;
    try {
      fs.unlinkSync(this.filePath(id));
      return true;
    } catch {
      return false;
    }
  }

  /** Delete every stored report. Returns how many were removed. */
  deleteAll(): number {
    let removed = 0;
    for (const report of this.list()) {
      if (this.delete(report.id)) removed += 1;
    }
    return removed;
  }
}
