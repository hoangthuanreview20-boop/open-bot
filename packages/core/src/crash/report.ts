/**
 * Crash report shape (v0.86, P2-7 — opt-in crash reporting).
 *
 * A report is deliberately SMALL and PII-free: what crashed, where
 * (source + kind), a redacted message + stack, platform, and the app
 * version. It never contains: user name, home directory paths, chat
 * content, file contents, environment variables, or any key/token
 * (see `./redact.ts` — everything passes through `redactCrashText`
 * before it is stored).
 *
 * `sent` is always `false` in this wave: reports are only stored
 * locally, and there is NO send endpoint yet — sending (user presses
 * "send" explicitly) is a later wave, see `docs/crash-reporting.md`.
 */

import { randomUUID } from 'node:crypto';
import { redactCrashText, type RedactCrashOptions } from './redact';

/** Format version of the stored JSON files (for future migrations). */
export const CRASH_REPORT_VERSION = 1;

/** Where the crash happened. */
export type CrashSource = 'main' | 'renderer';
/** What kind of failure was caught. */
export type CrashKind = 'uncaughtException' | 'unhandledRejection' | 'renderer-error';

/** Max chars kept from the error message (the rest is cut, not stored). */
export const MAX_CRASH_MESSAGE_CHARS = 2000;
/** Max chars kept from the stack trace. */
export const MAX_CRASH_STACK_CHARS = 8000;

/** A stored crash report (one JSON file per report). */
export interface CrashReport {
  /** Stable id, also the file name (`<id>.json`). */
  id: string;
  /** Format version (`CRASH_REPORT_VERSION`). */
  version: number;
  /** ISO-8601 timestamp of the crash. */
  createdAt: string;
  /** Where the crash happened. */
  source: CrashSource;
  /** What kind of failure was caught. */
  kind: CrashKind;
  /** Redacted error message (capped). */
  message: string;
  /** Redacted stack trace, when available (capped). */
  stack?: string;
  /** `process.platform` (linux / darwin / win32). */
  platform: string;
  /** App version, when the host knows it. */
  appVersion?: string;
  /** Node.js version (`process.version`), main-process reports only. */
  nodeVersion?: string;
  /**
   * Whether this report was ever sent anywhere. Always `false` in
   * v0.86: there is no send endpoint yet (see docs/crash-reporting.md).
   */
  sent: boolean;
}

/** Input to `buildCrashReport` (untrusted — redacted + capped inside). */
export interface CrashReportInput {
  source: CrashSource;
  kind: CrashKind;
  /** Raw error message (may contain PII — redacted inside). */
  message: string;
  /** Raw stack trace, when available (may contain PII — redacted inside). */
  stack?: string;
  /** App version, when the host knows it. */
  appVersion?: string;
  /** Node.js version, main-process reports only. */
  nodeVersion?: string;
  /** ISO timestamp override (tests); default: now. */
  createdAt?: string;
  /** Id override (tests); default: generated. */
  id?: string;
}

const CRASH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A report id is safe to use as a file name (no path traversal). */
export function isValidCrashReportId(id: unknown): id is string {
  return typeof id === 'string' && CRASH_ID_RE.test(id) && id.length <= 128 && !id.includes('..');
}

function cap(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[truncated at ${maxChars} chars]`;
}

/**
 * Build a report from raw crash data. Redacts PII/secrets and caps
 * message + stack, so the result is safe to store on disk and to
 * show in the UI. Never throws for string-ish input; non-string
 * messages become `String(message)`.
 *
 * `redactOpts` lets the caller pass the real home dir / user name
 * (the collector passes `os.homedir()`); tests pass a fake home.
 */
export function buildCrashReport(
  input: CrashReportInput,
  redactOpts: RedactCrashOptions = {},
): CrashReport {
  const rawMessage =
    typeof input.message === 'string' ? input.message : String(input.message ?? 'Unknown error');
  const message = cap(redactCrashText(rawMessage.trim() === '' ? 'Unknown error' : rawMessage, redactOpts), MAX_CRASH_MESSAGE_CHARS);
  const rawStack = typeof input.stack === 'string' ? input.stack : undefined;
  const stack =
    rawStack && rawStack.trim() !== ''
      ? cap(redactCrashText(rawStack, redactOpts), MAX_CRASH_STACK_CHARS)
      : undefined;
  return {
    id: input.id && isValidCrashReportId(input.id) ? input.id : `crash-${Date.now()}-${randomUUID().slice(0, 8)}`,
    version: CRASH_REPORT_VERSION,
    createdAt: input.createdAt ?? new Date().toISOString(),
    source: input.source,
    kind: input.kind,
    message,
    ...(stack !== undefined ? { stack } : {}),
    platform: process.platform,
    ...(typeof input.appVersion === 'string' && input.appVersion !== ''
      ? { appVersion: input.appVersion }
      : {}),
    ...(typeof input.nodeVersion === 'string' && input.nodeVersion !== ''
      ? { nodeVersion: input.nodeVersion }
      : {}),
    sent: false,
  };
}

/** A short one-line summary for lists (no stack, no PII beyond the redacted message). */
export interface CrashReportSummary {
  id: string;
  createdAt: string;
  source: CrashSource;
  kind: CrashKind;
  message: string;
}

export function toCrashReportSummary(report: CrashReport): CrashReportSummary {
  return {
    id: report.id,
    createdAt: report.createdAt,
    source: report.source,
    kind: report.kind,
    message:
      report.message.length > 200 ? `${report.message.slice(0, 200)}…` : report.message,
  };
}
