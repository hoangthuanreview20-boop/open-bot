/**
 * Voice diagnostics (v0.98, Đội T5 — voice live).
 *
 * One JSON-serialisable report that answers, for the Settings →
 * Voice diagnostics view, "can this machine do live voice right
 * now, and if not, what exactly is missing?":
 *
 *   collectVoiceDiagnostics({ keyGate, sttEngine, probe? })
 *     → VoiceDiagnosticsReport
 *
 *   - `realtime`: the key-gate decision per provider (live/mock,
 *     source, settings hint — no key material) + the Gemini Live
 *     readiness probe when the caller supplies it (connector
 *     models + endpoint reachability — a live check, run on
 *     demand, not on every render).
 *   - `localStt`: the whisper probe (`detectLocalStt()` status:
 *     binary/model found or the exact reason) + the chunked
 *     transcriber's availability.
 *   - `turnTaking`: barge-in stats from a session meter when the
 *     caller passes one (count / mean / p95 / breaches), so the
 *     report shows measured turn-taking, not just config.
 *   - `summary`: one line per subsystem (`ready` / `mock` /
 *     `missing`), plus the single most useful next step
 *     (`nextStep`) — the thing the UI shows first.
 *
 * Nothing here touches the network by itself: the readiness
 * probe is an explicit input (main runs it on demand via
 * `probeGeminiLiveReadiness()`), and every other field is local
 * state. The report is safe to log and to send to the renderer.
 */
import type { RealtimeProvider } from './types';
import type { KeyGateDecision, RealtimeKeyGate } from './keyGate';
import type { GeminiLiveReadiness } from './liveProbe';
import type { LocalSttEngine } from './localStt';
import { detectLocalStt } from './localStt';
import type { TurnTakingStats } from './turnTaking';
import { emptyTurnTakingStats } from './turnTaking';

/** Readiness of one subsystem. */
export type VoiceSubsystemReadiness = 'ready' | 'mock' | 'missing';

/** Diagnostics for the realtime leg (per provider). */
export interface VoiceRealtimeDiagnostics {
  /** Gate decision per provider (no key material). */
  providers: Record<RealtimeProvider, KeyGateDecision>;
  /** Providers that can go live right now. */
  liveProviders: RealtimeProvider[];
  /** Gemini Live readiness probe (undefined when not probed). */
  geminiLiveReadiness?: GeminiLiveReadiness;
  /** Overall realtime readiness. */
  readiness: VoiceSubsystemReadiness;
}

/** Diagnostics for the local STT leg. */
export interface VoiceSttDiagnostics {
  /** Whisper probe (binary / model / reason). */
  engineId: string | null;
  binaryPath: string | null;
  modelPath: string | null;
  available: boolean;
  reason: string;
  /** Overall local-STT readiness. */
  readiness: VoiceSubsystemReadiness;
}

/** The whole voice diagnostics report (JSON-safe). */
export interface VoiceDiagnosticsReport {
  /** Realtime leg. */
  realtime: VoiceRealtimeDiagnostics;
  /** Local STT leg. */
  localStt: VoiceSttDiagnostics;
  /** Measured turn-taking (empty stats when no session meter). */
  turnTaking: TurnTakingStats;
  /** One-line verdict per leg, for the UI. */
  summary: {
    realtime: string;
    localStt: string;
    turnTaking: string;
  };
  /** The single most useful next step ('' when everything is ready). */
  nextStep: string;
  /** When the report was built (wall clock). */
  at: number;
}

/** Inputs for `collectVoiceDiagnostics`. */
export interface VoiceDiagnosticsInput {
  /** App key gate (Vault resolvers registered by main). */
  keyGate: RealtimeKeyGate;
  /** Local STT engine (default: `detectLocalStt()`). */
  sttEngine?: LocalSttEngine;
  /** Custom realtime endpoint URLs (openai-compatible). */
  urls?: Partial<Record<RealtimeProvider, string>>;
  /** Gemini Live readiness probe (run on demand by the caller). */
  geminiLiveReadiness?: GeminiLiveReadiness;
  /** Barge-in stats from a live session meter (optional). */
  turnTakingStats?: TurnTakingStats;
}

/**
 * Build the diagnostics report. Pure local state except for the
 * optional readiness probe the caller already ran. Never throws
 * on a broken engine/gate — a subsystem that cannot even be
 * probed reports `missing` with the reason.
 */
export function collectVoiceDiagnostics(input: VoiceDiagnosticsInput): VoiceDiagnosticsReport {
  const at = Date.now();
  let providers: Record<RealtimeProvider, KeyGateDecision>;
  try {
    providers = input.keyGate.decideAll(input.urls ?? {});
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // The gate itself is broken — every provider reports missing.
    const missing = (provider: RealtimeProvider): KeyGateDecision => ({
      provider,
      mode: 'mock',
      source: 'none',
      keyConfigured: false,
      needsKey: true,
      settingsHint: 'Settings → API keys',
      reason: `Key gate failed: ${reason}`,
      at,
    });
    providers = { openai: missing('openai'), gemini: missing('gemini'), 'openai-compatible': missing('openai-compatible') };
  }
  const liveProviders = (Object.keys(providers) as RealtimeProvider[]).filter(
    (p) => providers[p]?.mode === 'live',
  );
  const realtimeReadiness: VoiceSubsystemReadiness =
    liveProviders.length > 0 ? 'ready' : 'mock';
  const realtime: VoiceRealtimeDiagnostics = {
    providers,
    liveProviders,
    ...(input.geminiLiveReadiness ? { geminiLiveReadiness: input.geminiLiveReadiness } : {}),
    readiness: realtimeReadiness,
  };

  let stt: VoiceSttDiagnostics;
  try {
    const engine = input.sttEngine ?? detectLocalStt();
    const status = engine.status();
    stt = {
      engineId: status.engineId,
      binaryPath: status.binaryPath,
      modelPath: status.modelPath,
      available: status.available,
      reason: status.available
        ? `Local STT ready (${status.engineId}, model ${status.modelPath?.split('/').pop() ?? '?'}) — mic audio never leaves this machine.`
        : (status.reason ?? 'Local STT unavailable.'),
      readiness: status.available ? 'ready' : 'missing',
    };
  } catch (err) {
    stt = {
      engineId: null,
      binaryPath: null,
      modelPath: null,
      available: false,
      reason: `Local STT probe failed: ${err instanceof Error ? err.message : String(err)}`,
      readiness: 'missing',
    };
  }

  const turnTaking = input.turnTakingStats ?? emptyTurnTakingStats();
  const summary = {
    realtime:
      realtimeReadiness === 'ready'
        ? `Live voice ready on ${liveProviders.join(', ')} — mock fallback for the rest.`
        : 'No live provider configured — realtime voice runs in mock mode.',
    localStt: stt.reason,
    turnTaking:
      turnTaking.count === 0
        ? 'No barge-in measured yet — interrupt the bot once to measure turn-taking.'
        : turnTaking.breaches === 0
          ? `Turn-taking measured: ${turnTaking.count} barge-in(s), mean ${turnTaking.meanMs}ms, p95 ${turnTaking.p95Ms}ms (budget ${turnTaking.budgetMs}ms).`
          : `Turn-taking measured: ${turnTaking.count} barge-in(s), ${turnTaking.breaches} over the ${turnTaking.budgetMs}ms budget (p95 ${turnTaking.p95Ms}ms).`,
  };
  let nextStep = '';
  if (realtimeReadiness !== 'ready') {
    nextStep = 'Add a provider API key in Settings → API keys for live voice (mock mode works meanwhile).';
  } else if (!stt.available) {
    nextStep = 'Install whisper.cpp (see docs/voice-live-v096.md) to enable local STT without a provider.';
  } else if (turnTaking.count === 0) {
    nextStep = 'Start a realtime session and interrupt the bot once to measure turn-taking live.';
  }
  return { realtime, localStt: stt, turnTaking, summary, nextStep, at };
}

/**
 * One-line verdict for a report (the line the UI shows first).
 * `ready` only when live voice AND local STT are both up.
 */
export function voiceDiagnosticsVerdict(report: VoiceDiagnosticsReport): VoiceSubsystemReadiness {
  if (report.realtime.readiness === 'ready' && report.localStt.readiness === 'ready') {
    return 'ready';
  }
  if (report.realtime.readiness === 'ready' || report.localStt.readiness === 'ready') {
    return 'mock';
  }
  return 'missing';
}
