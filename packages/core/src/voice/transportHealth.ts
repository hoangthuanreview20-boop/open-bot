/**
 * Realtime transport health (v0.96, Đội T5 — voice live).
 *
 * The v0.95 adapters connected and parsed the wire, but the app had
 * no honest answer to "is this adapter healthy right now, and how
 * slow is it?". This module is the answer, kept provider-agnostic
 * so both transports share one shape:
 *
 *   - `LatencyStats` — rolling samples of one measured duration
 *     (connect time, time-to-first-audio, STT round-trip). Reports
 *     count / min / max / mean / p50 / p95; bounded (default 100
 *     samples) so a long session does not grow memory forever.
 *   - `TransportHealth` — one adapter's health snapshot: whether a
 *     key is configured, whether the socket is up, the last
 *     connect/first-audio latencies, and a coarse status
 *     (`unknown` | `healthy` | `degraded` | `down`). The status
 *     rules are explicit and documented below — a missing key is
 *     `down` with a clear reason, never a silent mock.
 *   - `Backoff` — exponential backoff with jitter for reconnects,
 *     pure and testable without timers. The transports keep their
 *     own redial policies (OpenAI: RealtimeClient, Gemini: the
 *     session); this helper is the shared math for any new
 *     reconnect path and for the health-check retry in main.
 *   - `MissingRealtimeKeyError` — thrown when a live adapter is
 *     asked to connect with no key in the Vault. The message names
 *     the provider and where to paste the key; it never contains a
 *     key, a URL with a key, or a stack the UI would show raw.
 *
 * No network here: health is computed from state the transport
 * already has. A live probe (actually opening a socket) is the
 * transport's `healthCheck()` and is only attempted when a key is
 * configured — without a key the probe reports `key-missing`
 * instead of dialling.
 */

/** One measured duration, in milliseconds. */
export interface LatencySample {
  /** What was measured: connect / first-audio / stt / tts-stop. */
  kind: string;
  /** Duration in ms (monotonic clock, Date.now()-based). */
  ms: number;
  /** When the sample was taken (wall clock). */
  at: number;
}

/** Summary of the samples recorded for one kind. */
export interface LatencySummary {
  kind: string;
  count: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  lastMs: number;
  lastAt: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

/**
 * Rolling latency recorder. Keeps at most `maxSamples` per kind
 * (oldest dropped first); summaries are computed on demand.
 */
export class LatencyStats {
  private readonly maxSamples: number;
  private readonly samples = new Map<string, LatencySample[]>();

  constructor(maxSamples = 100) {
    this.maxSamples = Math.max(1, Math.floor(maxSamples));
  }

  /** Record one measurement. Negative / NaN values are ignored. */
  record(kind: string, ms: number): void {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return;
    if (typeof kind !== 'string' || !kind) return;
    const list = this.samples.get(kind) ?? [];
    list.push({ kind, ms, at: Date.now() });
    while (list.length > this.maxSamples) list.shift();
    this.samples.set(kind, list);
  }

  /** Summary for one kind, or null when nothing was recorded. */
  summary(kind: string): LatencySummary | null {
    const list = this.samples.get(kind);
    if (!list || list.length === 0) return null;
    const values = list.map((s) => s.ms).sort((a, b) => a - b);
    const sum = values.reduce((n, v) => n + v, 0);
    const last = list[list.length - 1] as LatencySample;
    return {
      kind,
      count: list.length,
      minMs: values[0] as number,
      maxMs: values[values.length - 1] as number,
      meanMs: Math.round((sum / values.length) * 10) / 10,
      p50Ms: percentile(values, 50),
      p95Ms: percentile(values, 95),
      lastMs: last.ms,
      lastAt: last.at,
    };
  }

  /** Summaries for every kind with at least one sample. */
  allSummaries(): LatencySummary[] {
    const out: LatencySummary[] = [];
    for (const kind of this.samples.keys()) {
      const s = this.summary(kind);
      if (s) out.push(s);
    }
    return out;
  }

  /** Samples recorded for one kind (copies, oldest first). */
  samplesFor(kind: string): LatencySample[] {
    return (this.samples.get(kind) ?? []).map((s) => ({ ...s }));
  }

  /** Total samples across all kinds. */
  get totalSamples(): number {
    let n = 0;
    for (const list of this.samples.values()) n += list.length;
    return n;
  }

  clear(): void {
    this.samples.clear();
  }
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

/** Options for exponential backoff with jitter. */
export interface BackoffOptions {
  /** Delay (ms) for attempt 1. Default 1000. */
  baseMs?: number;
  /** Cap (ms). Default 10000. */
  maxMs?: number;
  /** Jitter fraction 0..1 added/subtracted at random. Default 0.2. */
  jitter?: number;
  /**
   * Random source (injectable in tests for determinism).
   * Default Math.random.
   */
  random?: () => number;
}

/**
 * Exponential backoff with jitter: attempt 1 → baseMs, doubling
 * each attempt up to maxMs, then a ±jitter random spread so many
 * clients do not redial in lockstep. Pure — no timers.
 */
export class Backoff {
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly jitter: number;
  private readonly random: () => number;
  private attempts = 0;

  constructor(options: BackoffOptions = {}) {
    this.baseMs = Math.max(1, options.baseMs ?? 1000);
    this.maxMs = Math.max(this.baseMs, options.maxMs ?? 10_000);
    const j = options.jitter ?? 0.2;
    this.jitter = Math.min(1, Math.max(0, j));
    this.random = options.random ?? Math.random;
  }

  /** Attempts consumed so far (0 before the first `nextDelay`). */
  get attemptCount(): number {
    return this.attempts;
  }

  /**
   * Delay for the next attempt (1-based internally) and consume it.
   * `nextDelay()` → baseMs, then 2×baseMs, … capped at maxMs.
   */
  nextDelay(): number {
    this.attempts += 1;
    const raw = Math.min(this.maxMs, this.baseMs * 2 ** (this.attempts - 1));
    if (this.jitter === 0) return raw;
    const spread = raw * this.jitter * (this.random() * 2 - 1);
    return Math.max(1, Math.round(raw + spread));
  }

  /** Pure form (no state): delay for attempt N (1-based). */
  static delayFor(attempt: number, baseMs: number, maxMs: number): number {
    return Math.min(maxMs, baseMs * 2 ** (Math.max(1, attempt) - 1));
  }

  reset(): void {
    this.attempts = 0;
  }
}

// ---------------------------------------------------------------------------
// Missing-key error
// ---------------------------------------------------------------------------

/**
 * Where the user pastes the key for each realtime provider. These
 * are UI locations, not secrets.
 */
export const REALTIME_KEY_SETTINGS_HINT: Record<string, string> = {
  openai: 'Settings → API keys → OpenAI',
  gemini: 'Settings → API keys → Gemini',
  'openai-compatible': 'Settings → API keys → OpenAI-compatible endpoint',
};

/**
 * Human-readable "no key yet" message for a realtime provider.
 * The adapter throws this instead of dialling without credentials;
 * the UI shows it verbatim and offers the mock fallback.
 */
export function realtimeKeyMissingMessage(provider: string): string {
  const hint = REALTIME_KEY_SETTINGS_HINT[provider] ?? 'Settings → API keys';
  if (provider === 'openai-compatible') {
    return (
      'No OpenAI-compatible endpoint or key is configured. ' +
      `Add the endpoint URL (and key, if it needs one) in ${hint} first — ` +
      'live voice needs a reachable realtime endpoint, and the app keeps working in mock mode without it.'
    );
  }
  const name = provider === 'gemini' ? 'Gemini Live' : 'OpenAI Realtime';
  return (
    `No API key is configured for ${name}. ` +
    `Add the provider's own API key in ${hint} first — ` +
    'live voice is bring-your-own-key, and the app keeps working in mock mode without it.'
  );
}

/** Thrown by a transport's `connect()` when no key is available. */
export class MissingRealtimeKeyError extends Error {
  readonly provider: string;
  readonly code = 'missing-realtime-key';

  constructor(provider: string) {
    super(realtimeKeyMissingMessage(provider));
    this.name = 'MissingRealtimeKeyError';
    this.provider = provider;
  }
}

/** True when the error is a missing-realtime-key error. */
export function isMissingRealtimeKeyError(err: unknown): err is MissingRealtimeKeyError {
  return err instanceof MissingRealtimeKeyError;
}

// ---------------------------------------------------------------------------
// Health snapshot
// ---------------------------------------------------------------------------

/** Coarse health status for one realtime adapter. */
export type TransportHealthStatus = 'unknown' | 'healthy' | 'degraded' | 'down';

/** One adapter's health, as the UI renders it (no key material). */
export interface TransportHealth {
  provider: string;
  status: TransportHealthStatus;
  /** True when a usable key (or endpoint URL) is configured. */
  keyConfigured: boolean;
  /** True when the socket is currently open. */
  connected: boolean;
  /** Last connect latency (ms), null when never connected. */
  connectLatencyMs: number | null;
  /** Last time-to-first-audio (ms), null when no audio arrived yet. */
  firstAudioLatencyMs: number | null;
  /** Consecutive failed connect attempts since the last success. */
  failedAttempts: number;
  /** Plain-language reason for a non-healthy status ('' when healthy). */
  detail: string;
  /** True when this is the mock fallback, not a live adapter. */
  mock?: boolean;
  /** When this snapshot was taken (wall clock). */
  at: number;
}

/**
 * Derive a health status from the facts a transport already has.
 * Rules (explicit, so the UI never has to guess):
 *   - no key configured → `down`, "no key yet"
 *   - connected + first audio seen → `healthy`
 *   - connected but no audio yet → `degraded`, "connected, waiting for audio"
 *   - not connected + failed attempts > 0 → `down`, "connection failed"
 *   - not connected + never tried → `unknown`
 * A slow connect (> 5 s) or slow first audio (> 3 s) downgrades
 * `healthy` to `degraded` with the latency in the detail.
 */
export function deriveTransportHealth(input: {
  provider: string;
  keyConfigured: boolean;
  connected: boolean;
  connectLatencyMs: number | null;
  firstAudioLatencyMs: number | null;
  failedAttempts: number;
}): TransportHealth {
  const { provider, keyConfigured, connected, connectLatencyMs, firstAudioLatencyMs, failedAttempts } = input;
  let status: TransportHealthStatus;
  let detail = '';
  if (!keyConfigured) {
    status = 'down';
    detail = realtimeKeyMissingMessage(provider);
  } else if (connected && firstAudioLatencyMs !== null) {
    if ((connectLatencyMs ?? 0) > 5000 || firstAudioLatencyMs > 3000) {
      status = 'degraded';
      detail = `Slow live path (connect ${connectLatencyMs ?? '?'}ms, first audio ${firstAudioLatencyMs}ms).`;
    } else {
      status = 'healthy';
    }
  } else if (connected) {
    status = 'degraded';
    detail = 'Connected, waiting for the first audio from the server.';
  } else if (failedAttempts > 0) {
    status = 'down';
    detail = `Connection failed (${failedAttempts} attempt(s) since the last success).`;
  } else {
    status = 'unknown';
    detail = 'Not connected yet.';
  }
  return {
    provider,
    status,
    keyConfigured,
    connected,
    connectLatencyMs,
    firstAudioLatencyMs,
    failedAttempts,
    detail,
    at: Date.now(),
  };
}

/** Latency above which a connect is reported as slow (ms). */
export const TRANSPORT_SLOW_CONNECT_MS = 5000;
/** Latency above which first audio is reported as slow (ms). */
export const TRANSPORT_SLOW_FIRST_AUDIO_MS = 3000;
