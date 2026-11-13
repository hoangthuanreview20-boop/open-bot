/**
 * Harness v2 — per-bot-computer health probe (v0.97, Team T5).
 *
 * Probes, per bot computer, the things an operator actually needs to
 * know before trusting a run: CPU load, RAM and disk pressure, whether
 * the bot process is still alive, and how long ago its last heartbeat
 * arrived. A probe is always background / async — it never runs on a
 * chat turn's setup path (v0.95 lesson: a probe in the turn path
 * added 5–823 ms of latency) and never throws: an unmeasurable value
 * is simply absent and the status falls back to `unknown` with a
 * reason, never a made-up number.
 *
 * Status rules (thresholds configurable, defaults in
 * `DEFAULT_HEALTH_THRESHOLDS`):
 * - `unhealthy`: a process known to be dead, a heartbeat far too old,
 *   or any resource past its unhealthy threshold.
 * - `degraded`: any resource past its degraded threshold, a stale
 *   heartbeat, or a slow probe.
 * - `healthy`: everything measurable is inside thresholds and the
 *   process (when known) is alive.
 * - `unknown`: nothing measurable at all (no cpu/mem/disk/pid data).
 *
 * `BotComputerHealthProber` runs probes on a timer (default 30 s)
 * for a set of registered computers, keeps a short history per bot
 * (newest 50), and calls `onHealth` only when the status changes or
 * a probe turns unhealthy — the UI therefore does not re-render every
 * 30 s for a healthy fleet. All timers are `unref`ed so probing never
 * keeps the app alive on its own.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import { execFile } from 'node:child_process';

import type { BotComputerHealth, BotComputerHealthStatus, BotComputerHealthThresholds } from './types';

/** Default thresholds (see the header for what each one means). */
export const DEFAULT_HEALTH_THRESHOLDS: Required<BotComputerHealthThresholds> = {
  cpuDegradedAt: 0.85,
  cpuUnhealthyAt: 0.97,
  memoryDegradedAt: 0.9,
  memoryUnhealthyAt: 0.97,
  diskDegradedAt: 0.9,
  diskUnhealthyAt: 0.97,
  heartbeatDegradedAfterMs: 60_000,
  heartbeatUnhealthyAfterMs: 300_000,
  slowProbeDegradedAfterMs: 5_000,
};

/** How often the background prober runs by default (30 s). */
export const DEFAULT_HEALTH_PROBE_INTERVAL_MS = 30_000;
/** History kept per bot (newest N). */
export const MAX_HEALTH_HISTORY = 50;
/** Timeout for the read-only `df` disk probe. */
const DISK_PROBE_TIMEOUT_MS = 5_000;

/** Injectable dependencies so tests can feed fake machine data. */
export interface HealthProbeDeps {
  /** 1-minute load average samples (default: os.loadavg()). */
  loadavg?: number[];
  /** Number of logical CPUs (default: os.cpus().length). */
  cpuCount?: number;
  /** Total RAM bytes (default: os.totalmem()). */
  totalmem?: number;
  /** Free RAM bytes (default: os.freemem()). */
  freemem?: number;
  /** Disk used ratio 0..1, or null when unmeasurable (default: `df` probe). */
  diskUsedRatio?: number | null;
  /** Run a read-only command; null result means "could not run". */
  run?: (command: string, args: string[]) => Promise<{ code: number | null; stdout: string } | null>;
  /** Read a file as text; null when unreadable. */
  readFile?: (path: string) => string | null;
  /** Is this pid alive? (default: process.kill(pid, 0)). */
  pidAlive?: (pid: number) => boolean;
  /** Clock override (tests). */
  now?: () => Date;
}

/** What to probe: one bot computer. */
export interface BotComputerTarget {
  botId: string;
  computerId?: string;
  /** Bot process pid, when the harness knows it (from the registry). */
  pid?: number;
  /** Last heartbeat ISO timestamp from the bot process, when known. */
  lastHeartbeatAt?: string;
  /** Working directory whose volume the disk probe measures (default: process.cwd()). */
  diskPath?: string;
}

function defaultRun(command: string, args: string[]): Promise<{ code: number | null; stdout: string } | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        { timeout: DISK_PROBE_TIMEOUT_MS, maxBuffer: 256 * 1024, windowsHide: true },
        (error, stdout) => {
          resolve({ code: error ? 1 : 0, stdout: String(stdout ?? '') });
        },
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * Parse `df -k <path>` output (POSIX) into a used ratio, or null when
 * the output is not understood. Only the second line is read.
 */
export function parseDfUsedRatio(stdout: string): number | null {
  const lines = stdout.trim().split('\n');
  if (lines.length < 2) return null;
  const parts = (lines[1] ?? '').trim().split(/\s+/);
  // `df -k` columns: filesystem 1k-blocks used available use% mounted.
  const pct = parts[4] ?? parts[parts.length - 2];
  if (typeof pct !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)%$/.exec(pct);
  if (!match) return null;
  const value = Number(match[1]) / 100;
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/** Classify one probe result into a status + reasons. */
export function classifyBotComputerHealth(
  sample: {
    cpuLoad?: number;
    memoryUsedRatio?: number;
    diskUsedRatio?: number;
    processAlive?: boolean;
    heartbeatAgeMs?: number;
    probeDurationMs: number;
  },
  thresholds: BotComputerHealthThresholds = {},
): { status: BotComputerHealthStatus; reasons: string[] } {
  const t = { ...DEFAULT_HEALTH_THRESHOLDS, ...thresholds };
  const reasons: string[] = [];
  let status: BotComputerHealthStatus = 'healthy';

  const degrade = (reason: string): void => {
    reasons.push(reason);
    if (status === 'healthy') status = 'degraded';
  };
  const fail = (reason: string): void => {
    reasons.push(reason);
    status = 'unhealthy';
  };

  if (sample.processAlive === false) {
    fail('Bot process is no longer alive.');
  }
  if (sample.heartbeatAgeMs !== undefined) {
    if (sample.heartbeatAgeMs > t.heartbeatUnhealthyAfterMs) {
      fail(`Last heartbeat was ${Math.round(sample.heartbeatAgeMs / 1000)}s ago.`);
    } else if (sample.heartbeatAgeMs > t.heartbeatDegradedAfterMs) {
      degrade(`Last heartbeat was ${Math.round(sample.heartbeatAgeMs / 1000)}s ago.`);
    }
  }
  if (sample.cpuLoad !== undefined) {
    if (sample.cpuLoad > t.cpuUnhealthyAt) fail(`CPU load is ${Math.round(sample.cpuLoad * 100)}%.`);
    else if (sample.cpuLoad > t.cpuDegradedAt) degrade(`CPU load is ${Math.round(sample.cpuLoad * 100)}%.`);
  }
  if (sample.memoryUsedRatio !== undefined) {
    if (sample.memoryUsedRatio > t.memoryUnhealthyAt) {
      fail(`Memory use is ${Math.round(sample.memoryUsedRatio * 100)}%.`);
    } else if (sample.memoryUsedRatio > t.memoryDegradedAt) {
      degrade(`Memory use is ${Math.round(sample.memoryUsedRatio * 100)}%.`);
    }
  }
  if (sample.diskUsedRatio !== undefined) {
    if (sample.diskUsedRatio > t.diskUnhealthyAt) {
      fail(`Disk use is ${Math.round(sample.diskUsedRatio * 100)}%.`);
    } else if (sample.diskUsedRatio > t.diskDegradedAt) {
      degrade(`Disk use is ${Math.round(sample.diskUsedRatio * 100)}%.`);
    }
  }
  if (sample.probeDurationMs > t.slowProbeDegradedAfterMs) {
    degrade(`Probe took ${sample.probeDurationMs}ms.`);
  }
  const measured =
    sample.cpuLoad !== undefined ||
    sample.memoryUsedRatio !== undefined ||
    sample.diskUsedRatio !== undefined ||
    sample.processAlive !== undefined ||
    sample.heartbeatAgeMs !== undefined;
  if (!measured) {
    return { status: 'unknown', reasons: ['Nothing measurable for this computer yet.'] };
  }
  return { status, reasons };
}

/**
 * Probe one bot computer. Never throws — every measurement is
 * best-effort and a failure just leaves the field absent.
 */
export async function probeBotComputerHealth(
  target: BotComputerTarget,
  deps: HealthProbeDeps = {},
  thresholds: BotComputerHealthThresholds = {},
): Promise<BotComputerHealth> {
  const startedAt = Date.now();
  const now = deps.now?.() ?? new Date();
  let cpuLoad: number | undefined;
  let memoryUsedRatio: number | undefined;
  let diskUsedRatio: number | undefined;
  let processAlive: boolean | undefined;
  let heartbeatAgeMs: number | undefined;

  try {
    const load = deps.loadavg ?? os.loadavg();
    const cores = deps.cpuCount ?? os.cpus().length;
    if (Array.isArray(load) && load.length > 0 && cores > 0) {
      const value = (load[0] ?? 0) / cores;
      if (Number.isFinite(value) && value >= 0) cpuLoad = value;
    }
  } catch {
    // CPU unmeasurable — leave absent.
  }
  try {
    const total = deps.totalmem ?? os.totalmem();
    const free = deps.freemem ?? os.freemem();
    if (total > 0 && free >= 0 && free <= total) {
      memoryUsedRatio = 1 - free / total;
    }
  } catch {
    // Memory unmeasurable — leave absent.
  }
  try {
    if (deps.diskUsedRatio !== undefined) {
      diskUsedRatio = deps.diskUsedRatio ?? undefined;
    } else if (process.platform !== 'win32') {
      const run = deps.run ?? defaultRun;
      const result = await run('df', ['-k', target.diskPath ?? process.cwd()]);
      if (result && result.code === 0) {
        diskUsedRatio = parseDfUsedRatio(result.stdout) ?? undefined;
      }
    } else {
      // Windows: read the drive's free space via fs.statfs when available.
      const statfs = (fs as unknown as { statfsSync?: (p: string) => { bsize: number; blocks: number; bfree: number } }).statfsSync;
      if (typeof statfs === 'function') {
        try {
          const s = statfs(target.diskPath ?? process.cwd());
          if (s.blocks > 0) diskUsedRatio = 1 - s.bfree / s.blocks;
        } catch {
          // Disk unmeasurable — leave absent.
        }
      }
    }
  } catch {
    // Disk unmeasurable — leave absent.
  }
  if (typeof target.pid === 'number') {
    try {
      processAlive = deps.pidAlive
        ? deps.pidAlive(target.pid)
        : (() => {
            try {
              process.kill(target.pid as number, 0);
              return true;
            } catch {
              return false;
            }
          })();
    } catch {
      processAlive = undefined;
    }
  }
  if (target.lastHeartbeatAt !== undefined) {
    const age = now.getTime() - new Date(target.lastHeartbeatAt).getTime();
    if (Number.isFinite(age) && age >= 0) heartbeatAgeMs = age;
  }
  const probeDurationMs = Date.now() - startedAt;
  const { status, reasons } = classifyBotComputerHealth(
    { cpuLoad, memoryUsedRatio, diskUsedRatio, processAlive, heartbeatAgeMs, probeDurationMs },
    thresholds,
  );
  return {
    botId: target.botId,
    computerId: target.computerId ?? '',
    status,
    ...(cpuLoad !== undefined ? { cpuLoad } : {}),
    ...(memoryUsedRatio !== undefined ? { memoryUsedRatio } : {}),
    ...(diskUsedRatio !== undefined ? { diskUsedRatio } : {}),
    ...(processAlive !== undefined ? { processAlive } : {}),
    ...(target.lastHeartbeatAt !== undefined ? { lastHeartbeatAt: target.lastHeartbeatAt } : {}),
    ...(heartbeatAgeMs !== undefined ? { heartbeatAgeMs } : {}),
    reasons,
    probedAt: now.toISOString(),
    probeDurationMs,
  };
}

export interface BotComputerHealthProberOptions {
  /** Probe interval in ms. Default 30_000. */
  intervalMs?: number;
  /** Thresholds (defaults apply for anything not set). */
  thresholds?: BotComputerHealthThresholds;
  /** Injectable measurement dependencies (tests). */
  deps?: HealthProbeDeps;
  /**
   * Called when a bot's status changes, or on every unhealthy probe
   * (so the UI can surface it immediately). Not called for repeated
   * healthy probes.
   */
  onHealth?: (health: BotComputerHealth) => void;
  /** Clock override (tests). */
  now?: () => Date;
}

/**
 * Background prober for a set of bot computers. Probes run on a
 * timer, sequentially, and a single slow/failed probe never blocks
 * the others or any chat turn.
 */
export class BotComputerHealthProber {
  private readonly targets = new Map<string, BotComputerTarget>();
  private readonly history = new Map<string, BotComputerHealth[]>();
  private readonly lastStatus = new Map<string, BotComputerHealthStatus>();
  private readonly opts: BotComputerHealthProberOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private probing = false;

  constructor(opts: BotComputerHealthProberOptions = {}) {
    this.opts = opts;
  }

  /** Register (or replace) a bot computer to probe. */
  register(target: BotComputerTarget): void {
    this.targets.set(target.botId, { ...target });
  }

  /** Stop probing a bot (its history is kept). */
  unregister(botId: string): void {
    this.targets.delete(botId);
  }

  /** Registered bot ids. */
  botIds(): string[] {
    return [...this.targets.keys()];
  }

  /** Latest probe result for a bot, if any. */
  latest(botId: string): BotComputerHealth | undefined {
    const entries = this.history.get(botId);
    return entries !== undefined && entries.length > 0 ? entries[entries.length - 1] : undefined;
  }

  /** Probe history for a bot (newest last, max 50). */
  historyFor(botId: string): BotComputerHealth[] {
    return [...(this.history.get(botId) ?? [])];
  }

  /** Latest results for every registered bot. */
  latestAll(): BotComputerHealth[] {
    return this.botIds()
      .map((id) => this.latest(id))
      .filter((h): h is BotComputerHealth => h !== undefined);
  }

  /** How many bots are currently unhealthy (from the latest probes). */
  unhealthyCount(): number {
    return this.latestAll().filter((h) => h.status === 'unhealthy').length;
  }

  /** Probe one bot right now (also used by the timer). Never throws. */
  async probeOne(botId: string): Promise<BotComputerHealth | undefined> {
    const target = this.targets.get(botId);
    if (!target) return undefined;
    let health: BotComputerHealth;
    try {
      health = await probeBotComputerHealth(target, this.opts.deps ?? {}, this.opts.thresholds ?? {});
    } catch {
      health = {
        botId,
        computerId: target.computerId ?? '',
        status: 'unknown',
        reasons: ['Probe failed unexpectedly.'],
        probedAt: (this.opts.now?.() ?? new Date()).toISOString(),
        probeDurationMs: 0,
      };
    }
    const entries = this.history.get(botId) ?? [];
    entries.push(health);
    if (entries.length > MAX_HEALTH_HISTORY) {
      entries.splice(0, entries.length - MAX_HEALTH_HISTORY);
    }
    this.history.set(botId, entries);
    const previous = this.lastStatus.get(botId);
    this.lastStatus.set(botId, health.status);
    if (this.opts.onHealth && (previous !== health.status || health.status === 'unhealthy')) {
      try {
        this.opts.onHealth(health);
      } catch {
        // Callback must never break probing.
      }
    }
    return health;
  }

  /** Probe every registered bot, sequentially. Never throws. */
  async probeAll(): Promise<BotComputerHealth[]> {
    if (this.probing) return [];
    this.probing = true;
    try {
      const out: BotComputerHealth[] = [];
      for (const botId of this.botIds()) {
        const health = await this.probeOne(botId);
        if (health) out.push(health);
      }
      return out;
    } finally {
      this.probing = false;
    }
  }

  /** Start the background timer. Safe to call twice. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.probeAll().catch(() => undefined);
    }, this.opts.intervalMs ?? DEFAULT_HEALTH_PROBE_INTERVAL_MS);
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as { unref(): void }).unref();
    }
  }

  /** Stop the background timer. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}
