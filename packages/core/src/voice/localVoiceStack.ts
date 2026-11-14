/**
 * Local voice stack (v1.02, Team T5 — realtime voice v2).
 *
 * The one place that wires the local speech engines together for a
 * realtime call that does NOT go through a provider realtime
 * endpoint: local STT (whisper.cpp via `ChunkedWhisperStt`, chunked
 * so long utterances do not cut mid-word) in, local TTS
 * (`TtsQueue`, sentence by sentence so a barge-in can cut it
 * mid-reply) out. Nothing here is a new engine — it composes the
 * engines that already exist (voice/localStt.ts,
 * voice/whisperStream.ts, voice/tts.ts, voice/ttsQueue.ts) and
 * reports honestly when one of them is missing on this machine:
 *
 *   - STT unavailable (no whisper binary/model) → `transcribe()`
 *     throws a clear error and `getStatus()` says `stt: 'missing'`;
 *     the caller falls back to provider STT (voice/dictation.ts)
 *     instead of returning a guessed transcript.
 *   - TTS unavailable (no engine) → `speak()` reports
 *     `spoken: false` with the reason; the transcript still flows.
 *   - Mock engines (`MockLocalSttEngine` / `MockTtsEngine`) are
 *     first-class: a stack built on them reports `mode: 'mock'`,
 *     so the panel can say so and never present mock speech as
 *     local speech.
 *
 * The stack is synchronous to construct and async to use; the
 * `VoiceSessionV2` wrapper owns one optionally, for the local
 * fallback path of a voice call.
 */
import type { LocalSttEngine } from './localStt';
import { MockLocalSttEngine, detectLocalStt } from './localStt';
import { ChunkedWhisperStt } from './whisperStream';
import { isValidPcm16Frame } from './audio';
import type { TtsQueueStopResult } from './ttsQueue';
import { TtsQueue } from './ttsQueue';
import type { TtsEngineStatus } from './tts';
import { MockTtsEngine, TtsHarness } from './tts';

/** How the stack is speaking / listening right now. */
export type LocalVoiceStackMode = 'local' | 'mock' | 'mixed' | 'unavailable';

/** Readiness snapshot for the panel / diagnostics. */
export interface LocalVoiceStackStatus {
  mode: LocalVoiceStackMode;
  stt: { id: string; available: boolean; reason: string | null };
  tts: { available: boolean; engineId: string | null; engines: TtsEngineStatus[] };
  /** True while the TTS queue is speaking a sentence. */
  speaking: boolean;
  /** Sentences spoken so far on this stack. */
  spokenSentences: number;
  /** Sentences dropped by stops so far on this stack. */
  droppedSentences: number;
}

export interface LocalVoiceStackOptions {
  /** STT engine. Defaults to `detectLocalStt()` (whisper-cli). */
  sttEngine?: LocalSttEngine;
  /** Chunk long audio before transcribing. Default true. */
  chunkedStt?: boolean;
  /** TTS queue. Defaults to a fresh `TtsQueue`. */
  ttsQueue?: TtsQueue;
  /** TTS harness behind the queue. Defaults to `new TtsHarness()`. */
  ttsHarness?: TtsHarness;
  /** BCP-47 language hint for STT. Default 'en'. */
  language?: string;
  /** Sample rate of the PCM16 fed to `transcribe()`. Default 16000. */
  sampleRateHz?: number;
}

export class LocalVoiceStack {
  private readonly sttEngine: LocalSttEngine;
  private readonly chunked: ChunkedWhisperStt;
  private readonly useChunked: boolean;
  private readonly ttsQueue: TtsQueue;
  private readonly ttsHarness: TtsHarness;
  private readonly language: string;
  private readonly sampleRateHz: number;

  constructor(options: LocalVoiceStackOptions = {}) {
    this.sttEngine = options.sttEngine ?? detectLocalStt();
    this.chunked = new ChunkedWhisperStt(this.sttEngine);
    this.useChunked = options.chunkedStt ?? true;
    this.ttsHarness = options.ttsHarness ?? new TtsHarness();
    this.ttsQueue = options.ttsQueue ?? new TtsQueue({ harness: this.ttsHarness });
    this.language = options.language ?? 'en';
    this.sampleRateHz = options.sampleRateHz ?? 16_000;
  }

  /** True when the STT engine can transcribe on this machine. */
  isSttAvailable(): boolean {
    try {
      return this.sttEngine.isAvailable();
    } catch {
      return false;
    }
  }

  /** True when at least one TTS engine is available. */
  async isTtsAvailable(): Promise<boolean> {
    try {
      return (await this.ttsHarness.status()).available;
    } catch {
      return false;
    }
  }

  /** True while the TTS queue is speaking a sentence. */
  isSpeaking(): boolean {
    return this.ttsQueue.isSpeaking();
  }

  /** Sentences spoken / dropped so far (queue counters). */
  getTtsCounts(): { spoken: number; dropped: number; queued: number } {
    return {
      spoken: this.ttsQueue.spokenSentences,
      dropped: this.ttsQueue.droppedSentences,
      queued: this.ttsQueue.queuedCount,
    };
  }

  /**
   * Transcribe one PCM16 buffer (16 kHz mono by default). Long
   * audio is chunked (overlap-deduped) when `chunkedStt` is on.
   * Throws when the engine is unavailable or the audio is invalid
   * — never returns a guessed transcript.
   */
  async transcribe(pcm16: Uint8Array, opts: { language?: string } = {}): Promise<string> {
    if (!isValidPcm16Frame(pcm16)) {
      throw new Error('LocalVoiceStack: audio must be a non-empty even-length PCM16 buffer.');
    }
    const language = opts.language ?? this.language;
    if (this.useChunked) {
      const result = await this.chunked.transcribeChunked(pcm16, {
        sampleRateHz: this.sampleRateHz,
        language,
      });
      return result.text;
    }
    return this.sttEngine.transcribe(pcm16, { sampleRateHz: this.sampleRateHz, language });
  }

  /**
   * Speak text locally, sentence by sentence (barge-in can cut it
   * mid-reply via `stopSpeaking()`). Returns the sentence count
   * enqueued; 0 when the text is empty. Speaking is best-effort:
   * the queue still accepts the text when no TTS engine is
   * available, and the harness reports the failure per sentence.
   */
  speak(text: string): number {
    const clean = String(text ?? '').trim();
    if (!clean) return 0;
    return this.ttsQueue.enqueue(clean);
  }

  /** Stop local speech now (the barge-in path). */
  async stopSpeaking(): Promise<TtsQueueStopResult> {
    return this.ttsQueue.stop();
  }

  /** Last measured TTS stop latency (ms), null when never stopped. */
  getLastTtsStopLatencyMs(): number | null {
    return this.ttsQueue.lastStopLatency;
  }

  /** Readiness snapshot (see `LocalVoiceStackStatus`). */
  async getStatus(): Promise<LocalVoiceStackStatus> {
    let sttAvailable = false;
    let sttReason: string | null = null;
    try {
      sttAvailable = this.sttEngine.isAvailable();
      sttReason = this.sttEngine.status().reason ?? null;
    } catch (err) {
      sttReason = err instanceof Error ? err.message : 'STT status failed.';
    }
    let ttsStatus: { available: boolean; engineId: string | null; engines: TtsEngineStatus[] } = {
      available: false,
      engineId: null,
      engines: [],
    };
    try {
      ttsStatus = await this.ttsHarness.status();
    } catch {
      // TTS status is best-effort; the stack still reports STT.
    }
    const sttMock = this.sttEngine instanceof MockLocalSttEngine;
    const ttsMock = ttsStatus.engines.length > 0 && ttsStatus.engines.every((e) => e.id === 'mock');
    const mode: LocalVoiceStackMode =
      !sttAvailable && !ttsStatus.available
        ? 'unavailable'
        : sttMock && ttsMock
          ? 'mock'
          : sttMock || ttsMock
            ? 'mixed'
            : 'local';
    const counts = this.getTtsCounts();
    return {
      mode,
      stt: { id: this.sttEngine.id, available: sttAvailable, reason: sttReason },
      tts: ttsStatus,
      speaking: this.isSpeaking(),
      spokenSentences: counts.spoken,
      droppedSentences: counts.dropped,
    };
  }
}

/** Build a stack on mock engines (tests / $0 demo without audio). */
export function createMockLocalVoiceStack(options: { script?: string[] } = {}): LocalVoiceStack {
  return new LocalVoiceStack({
    sttEngine: new MockLocalSttEngine(options.script ?? ['hello world']),
    ttsHarness: new TtsHarness([new MockTtsEngine()]),
  });
}
