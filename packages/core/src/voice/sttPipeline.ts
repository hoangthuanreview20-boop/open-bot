/**
 * Local STT pipeline (v0.96, Đội T5 — voice live).
 *
 * Connects the pieces v0.95 left separate: the energy VAD
 * (`LocalVad`), the whisper CLI engine (`WhisperCliSttEngine`) and
 * the caller that wants text. One pipeline, one job:
 *
 *   mic PCM16 frames in → VAD decides speech / silence →
 *   a speech segment is accumulated → on speech end the segment
 *   goes to the STT engine → text out, with timing.
 *
 *   feed(frame) ──▶ LocalVad ──▶ segment buffer ──▶ engine.transcribe()
 *        ▲  speech start: begin segment       speech end: transcribe
 *        │  silence: keep buffering while speaking
 *
 * Rules (explicit, so the pipeline never transcribes noise):
 *   - A segment only starts on a VAD speech-start; frames before
 *     that are dropped (no pre-roll — the VAD fires within one
 *     20 ms window of speech, so pre-roll buys almost nothing).
 *   - A segment shorter than `minSegmentMs` (default 300 ms) is
 *     discarded as a blip (door slam, mic pop) — the engine is
 *     never woken for it.
 *   - A segment longer than `maxSegmentMs` (default 30 s) is cut
 *     and transcribed mid-speech, then a new segment starts, so a
 *     long monologue still produces text while the user talks.
 *   - Transcription runs one at a time (a queue): while one
 *     segment is being transcribed, the next segment keeps
 *     accumulating. A failed transcription is reported via
 *     `onError` and counted — it never kills the pipeline.
 *   - `flush()` ends the current segment now (push-to-talk release,
 *     session end) and transcribes it if it is long enough.
 *
 * WER: `wordErrorRate(reference, hypothesis)` is the standard
 * word-level Levenshtein error rate used to score the pipeline
 * against a known sentence (e.g. audio synthesised by eSpeak NG
 * from a known text, transcribed back by whisper). Normalisation
 * (lowercase, strip punctuation) is shared with the test so the
 * number is reproducible.
 */
import { LocalVad, isValidPcm16Frame, pcm16Rms, type LocalVadCallbacks } from './audio';
import { LOCAL_VAD_DEFAULT_THRESHOLD } from './audio';
import type { LocalSttEngine } from './localStt';

/** One completed local transcription. */
export interface SttSegmentResult {
  /** Transcribed text (trimmed; '' when the engine heard nothing). */
  text: string;
  /** Speech duration of the segment (ms). */
  segmentMs: number;
  /** Audio bytes transcribed. */
  bytes: number;
  /** Wall-clock time the engine took (ms). */
  transcribeMs: number;
  /** When the segment ended (wall clock). */
  at: number;
}

/** Pipeline callbacks. */
export interface SttPipelineCallbacks {
  /** A segment finished transcribing. */
  onResult?: (result: SttSegmentResult) => void;
  /** A segment was discarded (too short) or a transcription failed. */
  onError?: (error: Error) => void;
  /** VAD speech started (for the mic meter / UI). */
  onSpeechStart?: () => void;
  /** VAD speech ended (for the mic meter / UI). */
  onSpeechEnd?: () => void;
}

/** Options for the STT pipeline. */
export interface SttPipelineOptions {
  /** STT engine (whisper CLI, mock, …). Required. */
  engine: LocalSttEngine;
  /** Sample rate of the fed PCM16 frames (Hz). Default 16000. */
  sampleRateHz?: number;
  /** VAD speech threshold (RMS 0..1). Default 0.02. */
  vadThreshold?: number;
  /** VAD hangover (ms). Default 300. */
  vadHangoverMs?: number;
  /** Language hint passed to the engine (e.g. 'en', 'vi'). Default 'en'. */
  language?: string;
  /** Segments shorter than this are discarded (ms). Default 300. */
  minSegmentMs?: number;
  /** Segments longer than this are cut mid-speech (ms). Default 30000. */
  maxSegmentMs?: number;
  /** Callbacks. */
  callbacks?: SttPipelineCallbacks;
}

/** Default minimum speech segment (ms) — shorter is a blip. */
export const STT_PIPELINE_DEFAULT_MIN_SEGMENT_MS = 300;
/** Default maximum speech segment (ms) — longer is cut mid-speech. */
export const STT_PIPELINE_DEFAULT_MAX_SEGMENT_MS = 30_000;
/** Default sample rate for pipeline input (Hz). */
export const STT_PIPELINE_DEFAULT_SAMPLE_RATE_HZ = 16_000;

export class LocalSttPipeline {
  private readonly engine: LocalSttEngine;
  private readonly sampleRateHz: number;
  private readonly language: string;
  private readonly minSegmentMs: number;
  private readonly maxSegmentMs: number;
  /** VAD speech threshold — also gates segment accumulation (below). */
  private readonly vadThreshold: number;
  private readonly callbacks: SttPipelineCallbacks;
  private readonly vad: LocalVad;
  /** PCM16 bytes of the segment currently accumulating. */
  private segment: Uint8Array[] = [];
  private segmentBytes = 0;
  private segmentStartedAt = 0;
  /** Transcriptions running / queued (serialised). */
  private queue: Promise<void> = Promise.resolve();
  private queueDepth = 0;
  /** Segments transcribed so far. */
  private segmentsDone = 0;
  /** Segments discarded as too short. */
  private segmentsDiscarded = 0;
  /** Transcription failures so far. */
  private failures = 0;
  private disposed = false;

  constructor(options: SttPipelineOptions) {
    if (!options.engine) {
      throw new Error('LocalSttPipeline: an STT engine is required.');
    }
    this.engine = options.engine;
    this.sampleRateHz = options.sampleRateHz ?? STT_PIPELINE_DEFAULT_SAMPLE_RATE_HZ;
    this.language = options.language ?? 'en';
    this.minSegmentMs = options.minSegmentMs ?? STT_PIPELINE_DEFAULT_MIN_SEGMENT_MS;
    this.maxSegmentMs = options.maxSegmentMs ?? STT_PIPELINE_DEFAULT_MAX_SEGMENT_MS;
    this.vadThreshold = options.vadThreshold ?? LOCAL_VAD_DEFAULT_THRESHOLD;
    this.callbacks = options.callbacks ?? {};
    const vadCallbacks: LocalVadCallbacks = {
      onSpeechStart: () => this.handleSpeechStart(),
      onSpeechEnd: () => this.handleSpeechEnd(),
    };
    this.vad = new LocalVad({
      threshold: options.vadThreshold,
      hangoverMs: options.vadHangoverMs,
      sampleRateHz: this.sampleRateHz,
      callbacks: vadCallbacks,
    });
  }

  /** True while the VAD hears speech. */
  isSpeaking(): boolean {
    return this.vad.isSpeaking();
  }

  /** RMS of the most recent window (0..1) — mic level for the UI. */
  get micLevel(): number {
    return this.vad.level;
  }

  /** Segments transcribed so far. */
  get transcribedCount(): number {
    return this.segmentsDone;
  }

  /** Segments discarded as too short. */
  get discardedCount(): number {
    return this.segmentsDiscarded;
  }

  /** Transcription failures so far. */
  get failureCount(): number {
    return this.failures;
  }

  /** Transcriptions currently queued (0 when idle). */
  get pendingCount(): number {
    return this.queueDepth;
  }

  /** True when the engine behind this pipeline is available. */
  isEngineAvailable(): boolean {
    try {
      return this.engine.isAvailable();
    } catch {
      return false;
    }
  }

  /** Engine status (binary / model / reason) for the UI. */
  engineStatus(): ReturnType<LocalSttEngine['status']> {
    return this.engine.status();
  }

  /**
   * Feed one PCM16 mic frame. The VAD decides speech/silence;
   * speech frames accumulate into the current segment. A segment
   * that grows past `maxSegmentMs` is cut and transcribed now.
   * Throws on an invalid frame.
   */
  feed(frame: Uint8Array): void {
    if (this.disposed) {
      throw new Error('LocalSttPipeline: pipeline is disposed.');
    }
    if (!isValidPcm16Frame(frame)) {
      throw new Error('LocalSttPipeline: frame must be a non-empty even-length PCM16 buffer.');
    }
    this.vad.feed(frame);
    if (!this.vad.isSpeaking() && this.segment.length === 0) return;
    // Only loud frames join the segment: the VAD stays "speaking"
    // through its hangover, so the silence frames inside the
    // hangover would otherwise inflate the segment (a 100 ms blip
    // + 300 ms hangover would look like 400 ms of speech and get
    // transcribed). Quiet frames between words are dropped the
    // same way — the engine tolerates the gaps.
    if (pcm16Rms(frame) < this.vadThreshold) return;
    this.segment.push(new Uint8Array(frame));
    this.segmentBytes += frame.length;
    if (this.segmentStartedAt === 0) this.segmentStartedAt = Date.now();
    const segmentMs = (this.segmentBytes / 2 / this.sampleRateHz) * 1000;
    if (segmentMs >= this.maxSegmentMs) {
      this.cutSegment();
    }
  }

  /**
   * End the current segment now and transcribe it (if long enough).
   * Call on push-to-talk release or session end. Safe to call with
   * no segment in progress (no-op).
   */
  flush(): void {
    if (this.segment.length === 0) return;
    this.cutSegment();
  }

  /**
   * Wait until every queued transcription has finished. Resolves
   * immediately when the queue is empty.
   */
  async drain(): Promise<void> {
    await this.queue;
  }

  /** Drop the pipeline state (new session / new turn). */
  reset(): void {
    this.segment = [];
    this.segmentBytes = 0;
    this.segmentStartedAt = 0;
    this.vad.reset();
  }

  /** Stop accepting frames; queued transcriptions still finish. */
  dispose(): void {
    this.disposed = true;
    this.reset();
  }

  // -- internals ----------------------------------------------------------

  private handleSpeechStart(): void {
    this.segmentStartedAt = Date.now();
    try {
      this.callbacks.onSpeechStart?.();
    } catch {
      // A throwing callback must not break the pipeline.
    }
  }

  private handleSpeechEnd(): void {
    try {
      this.callbacks.onSpeechEnd?.();
    } catch {
      // A throwing callback must not break the pipeline.
    }
    this.cutSegment();
  }

  /** Cut the accumulated segment and transcribe it (or discard it). */
  private cutSegment(): void {
    if (this.segment.length === 0) return;
    const bytes = this.segmentBytes;
    const segmentMs = (bytes / 2 / this.sampleRateHz) * 1000;
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const part of this.segment) {
      joined.set(part, offset);
      offset += part.length;
    }
    this.segment = [];
    this.segmentBytes = 0;
    this.segmentStartedAt = 0;
    if (segmentMs < this.minSegmentMs) {
      this.segmentsDiscarded += 1;
      return;
    }
    this.enqueueTranscribe(joined, segmentMs, bytes);
  }

  /** Serialise transcriptions: one engine call at a time. */
  private enqueueTranscribe(pcm16: Uint8Array, segmentMs: number, bytes: number): void {
    this.queueDepth += 1;
    const run = this.queue.then(async () => {
      const started = Date.now();
      try {
        const text = await this.engine.transcribe(pcm16, {
          sampleRateHz: this.sampleRateHz,
          language: this.language,
        });
        this.segmentsDone += 1;
        const result: SttSegmentResult = {
          text: (text ?? '').trim(),
          segmentMs: Math.round(segmentMs),
          bytes,
          transcribeMs: Date.now() - started,
          at: Date.now(),
        };
        try {
          this.callbacks.onResult?.(result);
        } catch {
          // A throwing callback must not break the pipeline.
        }
      } catch (err) {
        this.failures += 1;
        try {
          this.callbacks.onError?.(
            err instanceof Error ? err : new Error(String(err)),
          );
        } catch {
          // A throwing callback must not break the pipeline.
        }
      } finally {
        this.queueDepth -= 1;
      }
    });
    // The chain must never reject (a failure is reported via
    // onError, not by breaking the queue for later segments).
    this.queue = run.catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Word error rate
// ---------------------------------------------------------------------------

/** Normalise text for WER: lowercase, strip punctuation, collapse space. */
export function normalizeTranscriptForWer(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[.,!?;:…"“”‘’'()[\]{}<>/*\\|@#%^&*_+=~`$]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word-level Levenshtein distance (substitutions + deletions + insertions). */
function wordLevenshtein(a: string[], b: string[]): { distance: number; substitutions: number; deletions: number; insertions: number } {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = distance between a[0..i) and b[0..j).
  const dp: number[][] = [];
  for (let i = 0; i <= n; i++) {
    dp.push(new Array<number>(m + 1).fill(0));
    (dp[i] as number[])[0] = i;
  }
  for (let j = 0; j <= m; j++) {
    (dp[0] as number[])[j] = j;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      (dp[i] as number[])[j] = Math.min(
        (dp[i - 1] as number[])[j] as number + 1,
        (dp[i] as number[])[j - 1] as number + 1,
        (dp[i - 1] as number[])[j - 1] as number + cost,
      );
    }
  }
  // Walk back to count the operation kinds.
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      i -= 1;
      j -= 1;
    } else if (
      i > 0 &&
      j > 0 &&
      (dp[i] as number[])[j] === (dp[i - 1] as number[])[j - 1] + 1
    ) {
      substitutions += 1;
      i -= 1;
      j -= 1;
    } else if (i > 0 && (dp[i] as number[])[j] === (dp[i - 1] as number[])[j] + 1) {
      deletions += 1;
      i -= 1;
    } else {
      insertions += 1;
      j -= 1;
    }
  }
  return {
    distance: (dp[n] as number[])[m] as number,
    substitutions,
    deletions,
    insertions,
  };
}

/** Word error rate between a reference and a hypothesis transcript. */
export interface WordErrorRate {
  /** distance / reference words (0 = perfect, 1 = every word wrong). */
  wer: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  refWords: number;
  hypWords: number;
}

/**
 * Word error rate of `hypothesis` against `reference`. Both are
 * normalised (case/punctuation-insensitive) first. An empty
 * reference scores 1 when the hypothesis is non-empty, 0 when
 * both are empty.
 */
export function wordErrorRate(reference: string, hypothesis: string): WordErrorRate {
  const refText = normalizeTranscriptForWer(reference);
  const hypText = normalizeTranscriptForWer(hypothesis);
  const ref = refText ? refText.split(' ') : [];
  const hyp = hypText ? hypText.split(' ') : [];
  if (ref.length === 0) {
    return {
      wer: hyp.length === 0 ? 0 : 1,
      substitutions: 0,
      deletions: 0,
      insertions: hyp.length,
      refWords: 0,
      hypWords: hyp.length,
    };
  }
  const { distance, substitutions, deletions, insertions } = wordLevenshtein(ref, hyp);
  return {
    wer: Math.round((distance / ref.length) * 1000) / 1000,
    substitutions,
    deletions,
    insertions,
    refWords: ref.length,
    hypWords: hyp.length,
  };
}
