/**
 * Crash collector (v0.86, P2-7).
 *
 * Wires the process / renderer error hooks to the local store — but
 * ONLY when the user opted in (`isEnabled()`). Default is OFF: with
 * crash reporting disabled, nothing is recorded, nothing is stored,
 * and no handler is even installed.
 *
 * Behaviour notes (deliberate, see `docs/crash-reporting.md`):
 *  - The collector NEVER throws: a failure to save a report is
 *    swallowed (a crash handler must never crash the app twice).
 *  - The collector NEVER sends anything anywhere: it only writes a
 *    local JSON file. There is no send endpoint in this wave.
 *  - Installing the `uncaughtException` handler means Node's default
 *    "exit the process" behaviour no longer applies — the report is
 *    recorded and the main process keeps running. That is the
 *    opt-in contract: the user turns the collector on knowing the
 *    app will record the crash instead of dying from it. The
 *    renderer hook (`createRendererErrorHandler`) never changes
 *    process behaviour — it only reports.
 *  - The collector records at most one report per error object: the
 *    same uncaught exception is not recorded twice if both a process
 *    handler and a manual `capture` call see it (dedup by message +
 *    stack, 1s window — best-effort, in-memory only).
 */

import * as os from 'node:os';
import { buildCrashReport, type CrashKind, type CrashReport, type CrashSource } from './report';
import type { CrashReportStore } from './store';
import type { RedactCrashOptions } from './redact';

export interface CrashCollectorOptions {
  /** Where reports are stored. */
  store: CrashReportStore;
  /** Opt-in gate, read on EVERY crash (toggling Settings applies immediately). */
  isEnabled: () => boolean;
  /** 'main' for the Electron main process, 'renderer' for the renderer. */
  source?: CrashSource;
  /** App version recorded in reports, when the host knows it. */
  appVersion?: string;
  /** Redaction options override (tests pass a fake home dir). */
  redactOpts?: RedactCrashOptions;
  /** Called after a report is saved (UI badge / tests). Failures ignored. */
  onReport?: (report: CrashReport) => void;
}

/** Input for a renderer-side error (from `window.onerror` / `unhandledrejection`). */
export interface RendererErrorInput {
  message: string;
  stack?: string;
}

export class CrashCollector {
  private readonly store: CrashReportStore;
  private readonly isEnabled: () => boolean;
  private readonly source: CrashSource;
  private readonly appVersion?: string;
  private readonly redactOpts: RedactCrashOptions;
  private readonly onReport?: (report: CrashReport) => void;
  private installed = false;
  private lastSignature = '';
  private lastAt = 0;
  private readonly onUncaughtException: (err: Error) => void;
  private readonly onUnhandledRejection: (reason: unknown) => void;

  constructor(opts: CrashCollectorOptions) {
    this.store = opts.store;
    this.isEnabled = opts.isEnabled;
    this.source = opts.source ?? 'main';
    this.appVersion = opts.appVersion;
    this.redactOpts = opts.redactOpts ?? {};
    this.onReport = opts.onReport;
    this.onUncaughtException = (err: Error) => {
      this.capture('uncaughtException', err);
    };
    this.onUnhandledRejection = (reason: unknown) => {
      this.capture('unhandledRejection', reason);
    };
  }

  /** Is the process hook installed right now? */
  get isInstalled(): boolean {
    return this.installed;
  }

  /**
   * Install `uncaughtException` + `unhandledRejection` handlers on
   * the current process. Idempotent. Only call in the main process —
   * the renderer uses `createRendererErrorHandler` instead.
   */
  install(): void {
    if (this.installed) return;
    process.on('uncaughtException', this.onUncaughtException);
    process.on('unhandledRejection', this.onUnhandledRejection);
    this.installed = true;
  }

  /** Remove the process handlers installed by `install()`. Idempotent. */
  uninstall(): void {
    if (!this.installed) return;
    process.off('uncaughtException', this.onUncaughtException);
    process.off('unhandledRejection', this.onUnhandledRejection);
    this.installed = false;
  }

  /**
   * Record one crash. Returns the saved report, or null when
   * reporting is disabled, the input is empty, or the save failed.
   * Never throws. Dedups identical errors within 1s (same message +
   * stack) so one crash is not stored twice.
   */
  capture(kind: CrashKind, error: unknown): CrashReport | null {
    try {
      if (!this.isEnabled()) return null;
      const message = messageOf(error);
      const stack = stackOf(error);
      if (message.trim() === '' && (stack ?? '').trim() === '') return null;
      const signature = `${kind}\n${message}\n${stack ?? ''}`;
      const now = Date.now();
      if (signature === this.lastSignature && now - this.lastAt < 1000) return null;
      this.lastSignature = signature;
      this.lastAt = now;
      const report = buildCrashReport(
        {
          source: this.source,
          kind,
          message,
          ...(stack !== undefined ? { stack } : {}),
          ...(this.appVersion ? { appVersion: this.appVersion } : {}),
          ...(this.source === 'main' ? { nodeVersion: process.version } : {}),
        },
        this.redactOpts,
      );
      if (!this.store.saveSync(report)) return null;
      try {
        this.onReport?.(report);
      } catch {
        // A listener must never break the collector.
      }
      return report;
    } catch {
      return null;
    }
  }

  /**
   * Record a renderer-side error (called from the main process via
   * the `crash-report:renderer` IPC channel, or directly in tests).
   * Same opt-in gate + redaction as `capture`.
   */
  captureRendererError(input: RendererErrorInput): CrashReport | null {
    if (!input || typeof input.message !== 'string') return null;
    return this.capture('renderer-error', {
      message: input.message,
      stack: input.stack,
    });
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (
    error !== null &&
    typeof error === 'object' &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

function stackOf(error: unknown): string | undefined {
  if (error instanceof Error && typeof error.stack === 'string' && error.stack !== '') {
    return error.stack;
  }
  if (
    error !== null &&
    typeof error === 'object' &&
    typeof (error as { stack?: unknown }).stack === 'string'
  ) {
    return (error as { stack: string }).stack;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Renderer side: error → report callback (no process hooks here)
// ---------------------------------------------------------------------------

export interface RendererErrorHandler {
  /** `window.onerror` handler: `(message, _source, _lineno, _colno, error)`. */
  onError: (
    message: string | Event,
    _source?: string,
    _lineno?: number,
    _colno?: number,
    error?: Error,
  ) => boolean;
  /** `window.onunhandledrejection` handler. */
  onUnhandledRejection: (event: { reason?: unknown }) => void;
}

/**
 * Build the renderer-side error handlers. They only FORWARD the
 * error (message + stack) to `report` — the main process still
 * applies the opt-in gate + redaction + local save, so a renderer
 * error is never stored when reporting is off. Returning `false`
 * from `onError` lets the browser's default error handling proceed
 * (the hook never swallows the error).
 *
 * The renderer wires it in `main.tsx`:
 *   const h = createRendererErrorHandler((input) => void window.openBot.reportRendererError(input));
 *   window.addEventListener('error', (e) => h.onError(e.message, e.filename, e.lineno, e.colno, e.error));
 *   window.addEventListener('unhandledrejection', h.onUnhandledRejection);
 */
export function createRendererErrorHandler(
  report: (input: RendererErrorInput) => void,
): RendererErrorHandler {
  return {
    onError: (message, _source, _lineno, _colno, error) => {
      try {
        const text = typeof message === 'string' ? message : messageOf(message);
        report({
          message: text,
          stack: error ? stackOf(error) : undefined,
        });
      } catch {
        // Never let the error reporter throw inside an error handler.
      }
      return false;
    },
    onUnhandledRejection: (event) => {
      try {
        report({ message: messageOf(event?.reason), stack: stackOf(event?.reason) });
      } catch {
        // Same: never throw from an error handler.
      }
    },
  };
}

/** Default redaction options for the real app (real home dir / user name). */
export function defaultRedactOpts(): RedactCrashOptions {
  return {
    homeDir: safeHomedir(),
    username: safeUsername(),
  };
}

function safeHomedir(): string {
  try {
    return os.homedir();
  } catch {
    return '';
  }
}

function safeUsername(): string {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}
