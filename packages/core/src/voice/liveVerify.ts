/**
 * Live verification runner (v0.98, Đội T5 — voice live).
 *
 * One call that re-proves the whole voice-live stack on this
 * machine and returns a structured, JSON-safe report:
 *
 *   runVoiceLiveVerification({ … }) → VoiceLiveVerificationReport
 *
 *   endpoints  — unauthenticated probes of both realtime
 *                endpoints (no key sent).
 *   gemini     — connector model probe + readiness (only when
 *                `probeGemini: true`; uses the real key through
 *                the connector — the same path the 2026-11-09
 *                live test used).
 *   localProxy — the loopback Gemini REST proxy (up/down).
 *   whisper    — WER benchmark over caller-supplied cases
 *                (chunked engine, threads configurable) + the
 *                engine status (binary/model/reason).
 *   bargeIn    — the mock barge-in probe on a caller-supplied
 *                session factory (real session code, mock
 *                transport — see turnTaking.ts).
 *
 * Every section is optional and independent: a section that was
 * not asked for reports `skipped`, a section that failed reports
 * the reason instead of aborting the run. `summarize…()` turns
 * the report into the one-paragraph verdict the docs carry.
 * The test file drives it with fakes (deterministic) and with
 * the real machine (live numbers); `scripts/voice-live-verify.mjs`
 * runs it from the command line.
 */
import type { LocalSttEngine } from './localStt';
import { detectLocalStt } from './localStt';
import { ChunkedWhisperStt, runWerBenchmark, type WerBenchmarkCase, type WerBenchmarkResult } from './whisperStream';
import {
  probeRealtimeEndpoints,
  probeGeminiLiveReadiness,
  probeLocalProxy,
  type EndpointProbeResult,
  type GeminiLiveReadiness,
  type LocalProxyProbeResult,
  type ConnectorRunner,
  type FetchLike,
} from './liveProbe';
import {
  runMockBargeInProbe,
  type BargeInProbeOptions,
  type BargeInProbeResult,
} from './turnTaking';

/** Status of one verification section. */
export type VerificationSectionStatus = 'pass' | 'fail' | 'skipped';

/** One section's outcome (shape shared by every section). */
export interface VerificationSection {
  status: VerificationSectionStatus;
  /** One-line verdict for this section. */
  detail: string;
}

/** Whole-run report (JSON-safe). */
export interface VoiceLiveVerificationReport {
  /** Endpoint probes (Gemini + OpenAI REST bases). */
  endpoints: VerificationSection & {
    gemini: EndpointProbeResult | null;
    openai: EndpointProbeResult | null;
  };
  /** Gemini connector + Live readiness (skipped unless asked). */
  gemini: VerificationSection & {
    readiness: GeminiLiveReadiness | null;
  };
  /** Local Gemini REST proxy (loopback). */
  localProxy: VerificationSection & {
    probe: LocalProxyProbeResult | null;
  };
  /** Local STT engine status + WER benchmark (skipped without cases). */
  whisper: VerificationSection & {
    engineId: string | null;
    binaryPath: string | null;
    modelPath: string | null;
    benchmark: WerBenchmarkResult | null;
  };
  /** Mock barge-in probe (skipped without a session factory). */
  bargeIn: VerificationSection & {
    probe: BargeInProbeResult | null;
  };
  /** Total wall-clock time of the run (ms). */
  totalMs: number;
  /** Sections that passed / ran. */
  passedSections: number;
  /** Sections that ran (pass + fail). */
  ranSections: number;
  /** When the run started (wall clock). */
  at: number;
}

/** Inputs for `runVoiceLiveVerification`. */
export interface VoiceLiveVerificationOptions {
  /** Probe both realtime endpoints (default true). */
  probeEndpoints?: boolean;
  /** Run the Gemini connector + readiness check (default false — slow). */
  probeGemini?: boolean;
  /** Probe the local Gemini REST proxy (default true). */
  probeProxy?: boolean;
  /** WER benchmark cases (default: none → whisper section reports the engine status only). */
  whisperCases?: WerBenchmarkCase[];
  /** STT engine for the benchmark (default: `detectLocalStt()`). */
  sttEngine?: LocalSttEngine;
  /** Whisper threads for the benchmark (default 2 on this VM). */
  whisperThreads?: number;
  /** Barge-in probe options (default: none → section skipped). */
  bargeInProbe?: Omit<BargeInProbeOptions, 'budgetMs'> & { budgetMs?: number };
  /** Fetch implementation for the probes (injectable in tests). */
  fetchImpl?: FetchLike;
  /** Connector-helper runner (injectable in tests). */
  connectorRunner?: ConnectorRunner;
  /** Probe timeout (ms). Default 10_000 (endpoints/proxy). */
  timeoutMs?: number;
}

function skippedSection(detail: string): VerificationSection {
  return { status: 'skipped', detail };
}

/**
 * Run the verification. Sections run sequentially (the whisper
 * benchmark is CPU-heavy — parallel runs would thrash the 1.5
 * CPUs and corrupt each other's timings). Never throws for a
 * failed section: failures are reported, not raised.
 */
export async function runVoiceLiveVerification(
  options: VoiceLiveVerificationOptions = {},
): Promise<VoiceLiveVerificationReport> {
  const at = Date.now();
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const probeEndpoints = options.probeEndpoints ?? true;
  const probeProxy = options.probeProxy ?? true;
  const probeGemini = options.probeGemini ?? false;

  // --- endpoints ------------------------------------------------------
  let endpoints: VoiceLiveVerificationReport['endpoints'];
  if (!probeEndpoints) {
    endpoints = { ...skippedSection('Endpoint probes skipped (probeEndpoints: false).'), gemini: null, openai: null };
  } else {
    try {
      const { gemini, openai } = await probeRealtimeEndpoints({ fetchImpl: options.fetchImpl, timeoutMs });
      const bothUp = gemini.reachable && openai.reachable;
      endpoints = {
        status: bothUp ? 'pass' : 'fail',
        detail: bothUp
          ? `Both realtime endpoints answer (Gemini ${gemini.latencyMs}ms, OpenAI ${openai.latencyMs}ms).`
          : `Endpoint probe failed — Gemini reachable=${gemini.reachable}, OpenAI reachable=${openai.reachable}.`,
        gemini,
        openai,
      };
    } catch (err) {
      endpoints = {
        status: 'fail',
        detail: `Endpoint probes threw: ${err instanceof Error ? err.message : String(err)}`,
        gemini: null,
        openai: null,
      };
    }
  }

  // --- gemini connector + readiness ------------------------------------
  let gemini: VoiceLiveVerificationReport['gemini'];
  if (!probeGemini) {
    gemini = { ...skippedSection('Gemini readiness skipped (probeGemini: false).'), readiness: null };
  } else {
    try {
      const readiness = await probeGeminiLiveReadiness({
        runner: options.connectorRunner,
        fetchImpl: options.fetchImpl,
        timeoutMs: 30_000,
      });
      gemini = {
        status: readiness.liveReady ? 'pass' : 'fail',
        detail: readiness.detail,
        readiness,
      };
    } catch (err) {
      gemini = {
        status: 'fail',
        detail: `Gemini readiness threw: ${err instanceof Error ? err.message : String(err)}`,
        readiness: null,
      };
    }
  }

  // --- local proxy ------------------------------------------------------
  let localProxy: VoiceLiveVerificationReport['localProxy'];
  if (!probeProxy) {
    localProxy = { ...skippedSection('Local proxy probe skipped (probeProxy: false).'), probe: null };
  } else {
    try {
      const probe = await probeLocalProxy({ fetchImpl: options.fetchImpl, timeoutMs: 3000 });
      localProxy = {
        status: probe.up ? 'pass' : 'fail',
        detail: probe.up
          ? `Local Gemini proxy is up on 127.0.0.1:${probe.port} (${probe.latencyMs}ms).`
          : `Local Gemini proxy is down — ${probe.error}`,
        probe,
      };
    } catch (err) {
      localProxy = {
        status: 'fail',
        detail: `Local proxy probe threw: ${err instanceof Error ? err.message : String(err)}`,
        probe: null,
      };
    }
  }

  // --- whisper ----------------------------------------------------------
  let whisper: VoiceLiveVerificationReport['whisper'];
  try {
    const engine = options.sttEngine ?? detectLocalStt();
    const status = engine.status();
    const cases = options.whisperCases ?? [];
    if (cases.length === 0) {
      whisper = {
        status: status.available ? 'pass' : 'fail',
        detail: status.available
          ? `Local STT ready (${status.engineId}) — no benchmark cases supplied, engine status only.`
          : `Local STT unavailable — ${status.reason ?? 'no reason given'}`,
        engineId: status.engineId,
        binaryPath: status.binaryPath,
        modelPath: status.modelPath,
        benchmark: null,
      };
    } else if (!status.available) {
      whisper = {
        status: 'fail',
        detail: `Local STT unavailable — cannot run the ${cases.length}-case WER benchmark: ${status.reason ?? 'no reason given'}`,
        engineId: status.engineId,
        binaryPath: status.binaryPath,
        modelPath: status.modelPath,
        benchmark: null,
      };
    } else {
      const chunked = new ChunkedWhisperStt(engine);
      const benchmark = await runWerBenchmark(chunked, cases, {
        language: 'en',
        threads: options.whisperThreads ?? 2,
        timeoutMs: 180_000,
      });
      whisper = {
        status: benchmark.meanWer <= 0.6 ? 'pass' : 'fail',
        detail:
          `WER benchmark: ${benchmark.caseCount} case(s), mean WER ${benchmark.meanWer}, ` +
          `max WER ${benchmark.maxWer}, ${benchmark.totalMs}ms.`,
        engineId: status.engineId,
        binaryPath: status.binaryPath,
        modelPath: status.modelPath,
        benchmark,
      };
    }
  } catch (err) {
    whisper = {
      status: 'fail',
      detail: `Whisper section threw: ${err instanceof Error ? err.message : String(err)}`,
      engineId: null,
      binaryPath: null,
      modelPath: null,
      benchmark: null,
    };
  }

  // --- barge-in ---------------------------------------------------------
  let bargeIn: VoiceLiveVerificationReport['bargeIn'];
  if (!options.bargeInProbe) {
    bargeIn = { ...skippedSection('Barge-in probe skipped (no session factory supplied).'), probe: null };
  } else {
    try {
      const probe = await runMockBargeInProbe(options.bargeInProbe);
      const m = probe.measurement;
      bargeIn = {
        status: m !== null && m.withinBudget && probe.backToListening ? 'pass' : 'fail',
        detail:
          m !== null
            ? `Barge-in measured ${m.totalMs}ms (budget ${m.withinBudget ? 'met' : 'MISSED'}), ` +
              `back to listening: ${probe.backToListening}, TTS stop: ${probe.ttsStopLatencyMs ?? 'n/a'}ms.`
            : 'Barge-in probe produced no measurement (interrupt did not fire).',
        probe,
      };
    } catch (err) {
      bargeIn = {
        status: 'fail',
        detail: `Barge-in probe threw: ${err instanceof Error ? err.message : String(err)}`,
        probe: null,
      };
    }
  }

  const sections = [endpoints, gemini, localProxy, whisper, bargeIn];
  const ran = sections.filter((s) => s.status !== 'skipped');
  return {
    endpoints,
    gemini,
    localProxy,
    whisper,
    bargeIn,
    totalMs: Date.now() - started,
    passedSections: ran.filter((s) => s.status === 'pass').length,
    ranSections: ran.length,
    at,
  };
}

/**
 * One-paragraph verdict for a report (the line the docs carry).
 * Lists each ran section as pass/fail; skipped sections are not
 * counted (they were not asked for).
 */
export function summarizeVoiceLiveVerification(report: VoiceLiveVerificationReport): string {
  const lines = [
    `endpoints: ${report.endpoints.status} — ${report.endpoints.detail}`,
    `gemini: ${report.gemini.status} — ${report.gemini.detail}`,
    `local proxy: ${report.localProxy.status} — ${report.localProxy.detail}`,
    `whisper: ${report.whisper.status} — ${report.whisper.detail}`,
    `barge-in: ${report.bargeIn.status} — ${report.bargeIn.detail}`,
  ];
  return (
    `Voice live verification: ${report.passedSections}/${report.ranSections} sections passed ` +
    `in ${report.totalMs}ms.\n` +
    lines.map((l) => `  - ${l}`).join('\n')
  );
}
