/**
 * Turn-taking measurement (v0.98, Đội T5 — voice live).
 *
 * v0.96 measured the TTS queue's stop latency (the voice dies in
 * <200 ms) but the *whole* barge-in — user starts speaking while
 * the model speaks → the model is cancelled, playback is flushed
 * and the session is listening again — was only counted, never
 * timed. This module times it, end to end, on the real session
 * code path (mock transport, real session / sink / TTS queue):
 *
 *   speech detected ──▶ cancel sent ──▶ playback flushed ──▶ listening
 *        t0               t1                t2                 t3
 *   total = t3 - t0, split into vad→cancel / cancel→flush /
 *   flush→listening so a slow barge-in can be blamed on the right
 *   leg. Budget: the whole round-trip must land in
 *   `BARGE_IN_TOTAL_BUDGET_MS` (500 ms); the TTS queue's own
 *   <200 ms stop budget (`TTS_BARGE_IN_BUDGET_MS`) is measured
 *   separately by the queue and reported alongside.
 *
 * `TurnTakingMeter` is the recorder the `RealtimeSession` owns:
 * the session calls `begin()` when speech is detected (server
 * VAD / local VAD / manual interrupt button) and the later marks
 * as the cancel + flush + state change happen; `finish()` returns
 * one `BargeInMeasurement` (or null when no barge-in was in
 * flight). `stats()` aggregates every measurement this session
 * (count / mean / p50 / p95 / min / max / budget breaches) for
 * the panel.
 *
 * `runMockBargeInProbe()` is the measurement harness: it drives a
 * session (injected — normally a real `RealtimeSession` on a mock
 * transport) through a full speak → interrupt cycle and returns
 * the measured round-trip, so the number in the docs is a number
 * from this machine, not a guess. The session is passed in as a
 * structural interface (`BargeInProbeSession`) so this module
 * never imports the session — the session imports the meter, not
 * the other way round.
 */
import type { TtsQueue } from './ttsQueue';
import { TTS_BARGE_IN_BUDGET_MS } from './ttsQueue';

/** Total barge-in budget: detect → listening again (ms). */
export const BARGE_IN_TOTAL_BUDGET_MS = 500;
/** Barge-in source (where the interruption was detected). */
export type BargeInSource = 'server_vad' | 'local_vad' | 'manual';

/** One measured barge-in round-trip. */
export interface BargeInMeasurement {
  /** Where the interruption was detected. */
  source: BargeInSource;
  /** Wall-clock timestamps (performance.now()-based ms). */
  detectedAt: number;
  cancelSentAt: number;
  flushedAt: number;
  listeningAt: number;
  /** Total round-trip: detected → listening again (ms). */
  totalMs: number;
  /** Leg 1: detection → cancel sent to the transport (ms). */
  vadToCancelMs: number;
  /** Leg 2: cancel → playback flushed + TTS stop started (ms). */
  cancelToFlushMs: number;
  /** Leg 3: flush → session back in `listening` (ms). */
  flushToListeningMs: number;
  /** True when totalMs landed inside the budget. */
  withinBudget: boolean;
  /** Last TTS-queue stop latency (ms), when a queue was attached. */
  ttsStopLatencyMs: number | null;
}

/** Aggregated barge-in stats for the panel / diagnostics. */
export interface TurnTakingStats {
  /** Barge-ins measured so far. */
  count: number;
  /** Mean total round-trip (ms), 0 when none. */
  meanMs: number;
  /** Median total round-trip (ms), 0 when none. */
  p50Ms: number;
  /** p95 total round-trip (ms), 0 when none. */
  p95Ms: number;
  /** Fastest total round-trip (ms), 0 when none. */
  minMs: number;
  /** Slowest total round-trip (ms), 0 when none. */
  maxMs: number;
  /** Last total round-trip (ms), null when none. */
  lastMs: number | null;
  /** Measurements that blew the budget. */
  breaches: number;
  /** Budget the stats are judged against (ms). */
  budgetMs: number;
}

/** Empty stats (no barge-in measured yet). */
export function emptyTurnTakingStats(budgetMs: number = BARGE_IN_TOTAL_BUDGET_MS): TurnTakingStats {
  return {
    count: 0,
    meanMs: 0,
    p50Ms: 0,
    p95Ms: 0,
    minMs: 0,
    maxMs: 0,
    lastMs: null,
    breaches: 0,
    budgetMs,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] as number;
}

/**
 * Aggregate measurements into stats. Pure — the meter and the
 * tests share it. `budgetMs` defaults to the barge-in budget.
 */
export function summarizeBargeInMeasurements(
  measurements: BargeInMeasurement[],
  budgetMs: number = BARGE_IN_TOTAL_BUDGET_MS,
): TurnTakingStats {
  if (measurements.length === 0) return emptyTurnTakingStats(budgetMs);
  const totals = measurements.map((m) => m.totalMs).sort((a, b) => a - b);
  const sum = totals.reduce((n, v) => n + v, 0);
  return {
    count: measurements.length,
    meanMs: Math.round((sum / totals.length) * 10) / 10,
    p50Ms: percentile(totals, 50),
    p95Ms: percentile(totals, 95),
    minMs: totals[0] as number,
    maxMs: totals[totals.length - 1] as number,
    lastMs: measurements[measurements.length - 1]?.totalMs ?? null,
    breaches: measurements.filter((m) => !m.withinBudget).length,
    budgetMs,
  };
}

/** Clock type (injectable in tests for determinism). */
export type TurnTakingClock = () => number;

/** Default clock: performance.now() when available, else Date.now(). */
export function defaultTurnTakingClock(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  if (perf && typeof perf.now === 'function') return perf.now();
  return Date.now();
}

/**
 * Records one barge-in at a time (a second `begin()` while one
 * is in flight restarts it — the newer detection wins) and keeps
 * every finished measurement for `stats()`.
 */
export class TurnTakingMeter {
  private readonly clock: TurnTakingClock;
  private readonly budgetMs: number;
  private readonly measurements: BargeInMeasurement[] = [];
  private inFlight: {
    source: BargeInSource;
    detectedAt: number;
    cancelSentAt: number | null;
    flushedAt: number | null;
  } | null = null;

  constructor(options: { clock?: TurnTakingClock; budgetMs?: number } = {}) {
    this.clock = options.clock ?? defaultTurnTakingClock;
    this.budgetMs = Math.max(1, options.budgetMs ?? BARGE_IN_TOTAL_BUDGET_MS);
  }

  /** Budget this meter judges against (ms). */
  get budget(): number {
    return this.budgetMs;
  }

  /** True when a barge-in is being timed right now. */
  get measuring(): boolean {
    return this.inFlight !== null;
  }

  /** Start timing a barge-in (call when speech is detected). */
  begin(source: BargeInSource): void {
    this.inFlight = { source, detectedAt: this.clock(), cancelSentAt: null, flushedAt: null };
  }

  /** Mark the cancel as sent to the transport. */
  markCancelSent(): void {
    if (this.inFlight && this.inFlight.cancelSentAt === null) {
      this.inFlight.cancelSentAt = this.clock();
    }
  }

  /** Mark playback as flushed (sink cleared + TTS stop started). */
  markFlushed(): void {
    if (this.inFlight && this.inFlight.flushedAt === null) {
      this.inFlight.flushedAt = this.clock();
    }
  }

  /**
   * Finish timing: the session is listening again. Returns the
   * measurement (and records it) or null when no barge-in was in
   * flight. `ttsStopLatencyMs` is the queue's own stop latency
   * when a TTS queue was attached to the session.
   */
  finish(ttsStopLatencyMs: number | null = null): BargeInMeasurement | null {
    const flight = this.inFlight;
    this.inFlight = null;
    if (!flight) return null;
    const listeningAt = this.clock();
    const cancelSentAt = flight.cancelSentAt ?? listeningAt;
    const flushedAt = flight.flushedAt ?? cancelSentAt;
    const totalMs = Math.max(0, listeningAt - flight.detectedAt);
    const measurement: BargeInMeasurement = {
      source: flight.source,
      detectedAt: flight.detectedAt,
      cancelSentAt,
      flushedAt,
      listeningAt,
      totalMs: Math.round(totalMs * 10) / 10,
      vadToCancelMs: Math.round(Math.max(0, cancelSentAt - flight.detectedAt) * 10) / 10,
      cancelToFlushMs: Math.round(Math.max(0, flushedAt - cancelSentAt) * 10) / 10,
      flushToListeningMs: Math.round(Math.max(0, listeningAt - flushedAt) * 10) / 10,
      withinBudget: totalMs <= this.budgetMs,
      ttsStopLatencyMs,
    };
    this.measurements.push(measurement);
    return measurement;
  }

  /** Drop an in-flight measurement without recording it. */
  cancel(): void {
    this.inFlight = null;
  }

  /** All finished measurements (copies, oldest first). */
  all(): BargeInMeasurement[] {
    return this.measurements.map((m) => ({ ...m }));
  }

  /** Last finished measurement, or null when none. */
  last(): BargeInMeasurement | null {
    const m = this.measurements[this.measurements.length - 1];
    return m ? { ...m } : null;
  }

  /** Aggregated stats over all finished measurements. */
  stats(): TurnTakingStats {
    return summarizeBargeInMeasurements(this.measurements, this.budgetMs);
  }

  /** Clear history (new session). */
  reset(): void {
    this.measurements.length = 0;
    this.inFlight = null;
  }
}

// ---------------------------------------------------------------------------
// Mock barge-in probe (live measurement on the local pipeline)
// ---------------------------------------------------------------------------

/** Structural session surface the probe drives (a real
 *  `RealtimeSession` satisfies it — this module never imports
 *  the session, so there is no import cycle). */
export interface BargeInProbeSession {
  connect(config: { apiKey?: string; model?: string; socketFactory?: unknown }): Promise<void>;
  disconnect(): void;
  getState(): string;
  isConnected(): boolean;
  interrupt(): boolean;
  getBargeInCount(): number;
  getBargeInStats(): TurnTakingStats;
  getLastBargeIn(): BargeInMeasurement | null;
}

/** What the probe needs from the caller: a connected session
 *  whose model is already "speaking" (see `runMockBargeInProbe`
 *  — it arranges that itself when given a session factory). */
export interface BargeInProbeOptions {
  /** Build a fresh session (transport + sink + TTS queue inside). */
  createSession: () => BargeInProbeSession;
  /** Drive the transport's model-audio event (make it speak). */
  makeModelSpeak: (session: BargeInProbeSession) => void | Promise<void>;
  /** Config passed to `session.connect()` (apiKey / model /
   *  socketFactory for a fake transport — the probe never dials
   *  a real endpoint: tests pass a fake socket factory here). */
  connectConfig?: { apiKey?: string; model?: string; socketFactory?: unknown };
  /** Optional TTS queue whose stop latency is reported alongside. */
  ttsQueue?: TtsQueue;
  /** Budget the probe judges against (ms). Default 500. */
  budgetMs?: number;
}

/** One probe run: the measured barge-in + what it proves. */
export interface BargeInProbeResult {
  /** The measurement (null when the interrupt did not fire). */
  measurement: BargeInMeasurement | null;
  /** Stats after this run (count ≥ 1 when measured). */
  stats: TurnTakingStats;
  /** True when the session returned to `listening`. */
  backToListening: boolean;
  /** Barge-in counter after the run. */
  bargeInCount: number;
  /** TTS queue stop latency (ms), when a queue was attached. */
  ttsStopLatencyMs: number | null;
}

/**
 * Drive one full speak → interrupt cycle on a fresh session and
 * measure it. Steps: connect → make the model speak (audio event)
 * → `interrupt()` (the UI button path) → wait until the session
 * is `listening` again → read the meter. The interrupt is the
 * manual path; the VAD paths (`server_vad` / `local_vad`) are
 * the same `bargeIn()` inside the session, timed the same way —
 * see the session tests for those.
 *
 * The session is disconnected at the end (even on failure) so a
 * probe never leaks a live session.
 */
export async function runMockBargeInProbe(
  options: BargeInProbeOptions,
): Promise<BargeInProbeResult> {
  const budgetMs = options.budgetMs ?? BARGE_IN_TOTAL_BUDGET_MS;
  const session = options.createSession();
  try {
    await session.connect({
      apiKey: options.connectConfig?.apiKey ?? 'probe-key',
      model: options.connectConfig?.model ?? 'mock',
      socketFactory: options.connectConfig?.socketFactory,
    });
    if (!session.isConnected()) {
      throw new Error('runMockBargeInProbe: session did not connect.');
    }
    await options.makeModelSpeak(session);
    if (session.getState() !== 'speaking') {
      throw new Error(
        `runMockBargeInProbe: model did not start speaking (state=${session.getState()}).`,
      );
    }
    const interrupted = session.interrupt();
    if (!interrupted) {
      return {
        measurement: null,
        stats: session.getBargeInStats(),
        backToListening: session.getState() === 'listening',
        bargeInCount: session.getBargeInCount(),
        ttsStopLatencyMs: options.ttsQueue?.lastStopLatency ?? null,
      };
    }
    // The session returns to `listening` synchronously inside
    // interrupt(), but poll briefly so a future async leg cannot
    // make the probe read a stale state.
    const deadline = Date.now() + 2000;
    while (session.getState() !== 'listening' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const measurement = session.getLastBargeIn();
    return {
      measurement,
      stats: session.getBargeInStats(),
      backToListening: session.getState() === 'listening',
      bargeInCount: session.getBargeInCount(),
      ttsStopLatencyMs: options.ttsQueue?.lastStopLatency ?? null,
    };
  } finally {
    try {
      session.disconnect();
    } catch {
      // The probe cleans up best-effort.
    }
  }
}

/** TTS stop budget, re-exported next to the barge-in budget so
 *  callers import both from one place. */
export { TTS_BARGE_IN_BUDGET_MS };
