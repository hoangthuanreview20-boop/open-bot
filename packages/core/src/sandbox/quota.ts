/**
 * Sandbox quota — per-bot usage accounting (v1.02 rescue port of the
 * v0.99 work).
 *
 * `SandboxQuotaTracker` counts what a bot's box has consumed (bytes
 * written, files created, runs, wall-clock ms) and tells the host
 * when a limit is hit, before the next run starts. Quotas are
 * checked, not enforced, here — the enforcer asks `check()` and
 * refuses to start a run that would exceed the quota. Usage resets
 * per window (default: per day, local time).
 */

export interface SandboxQuota {
  /** Max bytes written per window (0 = unlimited). */
  maxWriteBytes?: number;
  /** Max files created per window (0 = unlimited). */
  maxFiles?: number;
  /** Max runs per window (0 = unlimited). */
  maxRuns?: number;
  /** Max wall-clock ms per window (0 = unlimited). */
  maxWallMs?: number;
}

export interface SandboxUsage {
  bytesWritten: number;
  filesCreated: number;
  runs: number;
  wallMs: number;
  windowStart: string;
}

/** Default quota (generous; the profile limits still apply per run). */
export const DEFAULT_SANDBOX_QUOTA: Required<SandboxQuota> = {
  maxWriteBytes: 1024 * 1024 * 1024,
  maxFiles: 10_000,
  maxRuns: 1000,
  maxWallMs: 60 * 60 * 1000,
};

/** Per-bot quota tracker (in-memory, one window at a time). */
export class SandboxQuotaTracker {
  private readonly quota: Required<SandboxQuota>;
  private usage: SandboxUsage;

  constructor(quota: SandboxQuota = {}) {
    this.quota = { ...DEFAULT_SANDBOX_QUOTA, ...quota };
    this.usage = this.freshUsage();
  }

  /** Current usage in this window. */
  get current(): SandboxUsage {
    return { ...this.usage };
  }

  /** Check whether a run may start (returns the first violation, if any). */
  check(): { allowed: boolean; reason?: string } {
    if (this.quota.maxRuns > 0 && this.usage.runs >= this.quota.maxRuns) {
      return { allowed: false, reason: `run quota exceeded (${this.usage.runs}/${this.quota.maxRuns} runs)` };
    }
    return { allowed: true };
  }

  /** Check whether a write of `bytes` fits the quota. */
  checkWrite(bytes: number, files = 1): { allowed: boolean; reason?: string } {
    if (this.quota.maxWriteBytes > 0 && this.usage.bytesWritten + bytes > this.quota.maxWriteBytes) {
      return { allowed: false, reason: `write quota exceeded (${this.usage.bytesWritten + bytes}/${this.quota.maxWriteBytes} bytes)` };
    }
    if (this.quota.maxFiles > 0 && this.usage.filesCreated + files > this.quota.maxFiles) {
      return { allowed: false, reason: `file quota exceeded (${this.usage.filesCreated + files}/${this.quota.maxFiles} files)` };
    }
    return { allowed: true };
  }

  /** Record a finished run (bytes written, files created, wall ms). */
  recordRun(bytesWritten: number, filesCreated: number, wallMs: number): void {
    this.usage.runs++;
    this.usage.bytesWritten += bytesWritten;
    this.usage.filesCreated += filesCreated;
    this.usage.wallMs += wallMs;
  }

  /** Reset the window (called by the host, e.g. daily). */
  reset(): void {
    this.usage = this.freshUsage();
  }

  private freshUsage(): SandboxUsage {
    return { bytesWritten: 0, filesCreated: 0, runs: 0, wallMs: 0, windowStart: new Date().toISOString() };
  }
}
