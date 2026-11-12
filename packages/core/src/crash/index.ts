/**
 * Crash reporting module re-exports (v0.86, P2-7 — opt-in).
 *
 * The store lives in @open-bot/core because the desktop app (main +
 * renderer) and the tests both need it; it is exported from the
 * package index since v0.86.
 */
export { CrashCollector, createRendererErrorHandler, defaultRedactOpts } from './collector';
export type { CrashCollectorOptions, RendererErrorHandler, RendererErrorInput } from './collector';
export { redactCrashText, REDACTED_HOME, REDACTED_USER } from './redact';
export type { RedactCrashOptions } from './redact';
export {
  buildCrashReport,
  isValidCrashReportId,
  toCrashReportSummary,
  CRASH_REPORT_VERSION,
  MAX_CRASH_MESSAGE_CHARS,
  MAX_CRASH_STACK_CHARS,
} from './report';
export type { CrashKind, CrashReport, CrashReportInput, CrashReportSummary, CrashSource } from './report';
export { CrashReportStore, MAX_CRASH_REPORTS, MAX_CRASH_REPORTS_BYTES } from './store';
export type { CrashReportStoreOptions } from './store';
