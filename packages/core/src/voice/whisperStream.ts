/**
 * Chunked + streaming local STT (v0.98, Đội T5 — voice live).
 *
 * v0.96's `WhisperCliSttEngine` transcribes one utterance in one
 * whisper-cli run, and `LocalSttPipeline` cuts speech into VAD
 * segments. Two gaps remained, both fixed here:
 *
 *   1. Long audio: a 60 s utterance in one whisper run is slow
 *      and (on this 1.5-CPU VM) risks the 120 s timeout, while
 *      whisper's own context window degrades on very long input.
 *      `ChunkedWhisperStt` splits long audio into overlapping
 *      windows (default 30 s, 1 s overlap), transcribes each
 *      window, and joins them with word-level overlap dedupe
 *      (`dedupeChunkOverlap`) so the repeated second at each
 *      boundary is not transcribed twice.
 *   2. Silence boundaries: `splitAudioOnSilence()` cuts PCM16
 *      into speech spans at quiet gaps (RMS window analysis,
 *      pure — no engine needed), so a recording with pauses
 *      becomes clean segments *before* the engine runs, instead
 *      of one window that starts mid-word.
 *
 * `runWerBenchmark()` scores an engine against known-reference
 * audio (e.g. eSpeak NG synthesising a sentence, transcribed
 * back by whisper) — the same harness the live test uses, so the
 * WER number in `docs/voice-live-v098.md` is reproducible from
 * the test file, not hand-measured.
 *
 * `StreamingSttSession` ties the pieces together for a live
 * call: mic frames in → the VAD pipeline segments speech →
 * each segment goes through the chunked engine → partial/final
 * results out with per-segment timing, plus an eval report
 * (segments, mean transcribe latency, rolling WER when the
 * caller supplies references for its test sentences).
 */
import { LocalVad, isValidPcm16Frame, pcm16Rms } from './audio';
import type { LocalSttEngine, LocalSttTranscribeOptions } from './localStt';
import { LocalSttPipeline, wordErrorRate, type WordErrorRate } from './sttPipeline';

/** Default chunk length for chunked transcription (ms). */
export const WHISPER_CHUNK_MS = 30_000;
/** Default overlap between chunks (ms) — deduped on join. */
export const WHISPER_CHUNK_OVERLAP_MS = 1000;
/** Max words compared when deduping a chunk boundary. */
export const WHISPER_OVERLAP_MAX_WORDS = 12;

// ---------------------------------------------------------------------------
// Silence splitting (pure — no engine)
// ---------------------------------------------------------------------------

/** One speech span inside a longer PCM16 buffer. */
export interface AudioSegment {
  /** Start sample (16-bit samples, not bytes). */
  startSample: number;
  /** End sample (exclusive). */
  endSample: number;
  /** Start time (ms). */
  startMs: number;
  /** End time (ms). */
  endMs: number;
  /** PCM16 bytes of the span (a copy). */
  pcm16: Uint8Array;
}

/** Options for `splitAudioOnSilence`. */
export interface SilenceSplitOptions {
  /** Sample rate of the PCM16 (Hz). Default 16000. */
  sampleRateHz?: number;
  /** RMS below this is silence (0..1). Default 0.02. */
  silenceThreshold?: number;
  /** Quiet gap that ends a span (ms). Default 400. */
  minSilenceMs?: number;
  /** Spans shorter than this are dropped as blips (ms). Default 200. */
  minSegmentMs?: number;
  /** Analysis window (ms). Default 20. */
  windowMs?: number;
}

/**
 * Cut PCM16 into speech spans at quiet gaps. Windows are RMS
 * analysed in order; a span starts at the first loud window and
 * ends after `minSilenceMs` of continuous quiet (the trailing
 * silence is not part of the span). Spans shorter than
 * `minSegmentMs` are dropped. Pure — runs on synthetic audio in
 * tests with no engine.
 */
export function splitAudioOnSilence(
  pcm16: Uint8Array,
  options: SilenceSplitOptions = {},
): AudioSegment[] {
  if (!isValidPcm16Frame(pcm16)) {
    throw new Error('splitAudioOnSilence: audio must be a non-empty even-length PCM16 buffer.');
  }
  const sampleRateHz = options.sampleRateHz ?? 16_000;
  const threshold = options.silenceThreshold ?? 0.02;
  const minSilenceMs = options.minSilenceMs ?? 400;
  const minSegmentMs = options.minSegmentMs ?? 200;
  const windowMs = options.windowMs ?? 20;
  const windowSamples = Math.max(1, Math.round((sampleRateHz * windowMs) / 1000));
  const totalSamples = pcm16.length / 2;
  const minSilenceWindows = Math.max(1, Math.ceil(minSilenceMs / windowMs));
  const segments: AudioSegment[] = [];
  let spanStart: number | null = null;
  let quietWindows = 0;
  let lastLoudEnd = 0;
  const closeSpan = (endSample: number): void => {
    if (spanStart === null) return;
    const durationMs = ((endSample - spanStart) / sampleRateHz) * 1000;
    if (durationMs >= minSegmentMs) {
      segments.push({
        startSample: spanStart,
        endSample,
        startMs: Math.round((spanStart / sampleRateHz) * 1000),
        endMs: Math.round((endSample / sampleRateHz) * 1000),
        pcm16: pcm16.slice(spanStart * 2, endSample * 2),
      });
    }
    spanStart = null;
  };
  for (let start = 0; start < totalSamples; start += windowSamples) {
    const end = Math.min(totalSamples, start + windowSamples);
    const window = pcm16.slice(start * 2, end * 2);
    const loud = pcm16Rms(window) >= threshold;
    if (loud) {
      if (spanStart === null) spanStart = start;
      lastLoudEnd = end;
      quietWindows = 0;
    } else if (spanStart !== null) {
      quietWindows += 1;
      if (quietWindows >= minSilenceWindows) {
        closeSpan(lastLoudEnd);
        quietWindows = 0;
      }
    }
  }
  closeSpan(lastLoudEnd);
  return segments;
}

// ---------------------------------------------------------------------------
// Overlap dedupe (pure — word-level suffix/prefix match)
// ---------------------------------------------------------------------------

/**
 * Drop the words at the start of `next` that repeat the end of
 * `prev` (the overlap window was transcribed twice). Finds the
 * longest suffix of `prev` (up to `maxWords`) that is also a
 * prefix of `next`, case/punctuation-insensitive, and returns
 * `next` with that prefix removed. Returns `next` unchanged when
 * there is no overlap.
 */
export function dedupeChunkOverlap(prev: string, next: string, maxWords: number = WHISPER_OVERLAP_MAX_WORDS): string {
  const prevWords = String(prev ?? '').trim().split(/\s+/).filter(Boolean);
  const nextWords = String(next ?? '').trim().split(/\s+/).filter(Boolean);
  if (prevWords.length === 0 || nextWords.length === 0) return next;
  const norm = (w: string): string => w.toLowerCase().replace(/[.,!?;:…"“”‘’'()[\]{}]/g, '');
  const limit = Math.min(maxWords, prevWords.length, nextWords.length);
  for (let n = limit; n >= 1; n--) {
    const suffix = prevWords.slice(-n).map(norm);
    const prefix = nextWords.slice(0, n).map(norm);
    let match = true;
    for (let i = 0; i < n; i++) {
      if (suffix[i] !== prefix[i] || !suffix[i]) {
        match = false;
        break;
      }
    }
    if (match) return nextWords.slice(n).join(' ');
  }
  return next;
}

// ---------------------------------------------------------------------------
// Chunked transcription
// ---------------------------------------------------------------------------

/** One chunk's transcription. */
export interface WhisperChunkResult {
  /** Chunk index (0-based). */
  index: number;
  /** Chunk start (ms into the original audio). */
  startMs: number;
  /** Chunk end (ms into the original audio). */
  endMs: number;
  /** Transcribed text for this chunk (overlap-deduped, trimmed). */
  text: string;
  /** Wall-clock time the engine took for this chunk (ms). */
  transcribeMs: number;
  /** Audio bytes in this chunk. */
  bytes: number;
}

/** Result of a chunked transcription. */
export interface ChunkedWhisperResult {
  /** Joined text (chunks deduped + joined with spaces). */
  text: string;
  /** Per-chunk results (in order). */
  chunks: WhisperChunkResult[];
  /** Chunks transcribed. */
  chunkCount: number;
  /** Total wall-clock time (ms). */
  totalMs: number;
}

/** Options for chunked transcription. */
export interface ChunkedWhisperOptions extends LocalSttTranscribeOptions {
  /** Chunk length (ms). Default 30_000. */
  chunkMs?: number;
  /** Overlap between chunks (ms). Default 1000. */
  overlapMs?: number;
  /** Max words compared at a boundary. Default 12. */
  overlapMaxWords?: number;
}

/**
 * Chunked whisper: long audio in overlapping windows, one engine
 * call per window, joined with overlap dedupe. Short audio (one
 * chunk) is a single engine call — identical to calling the
 * engine directly. Throws when the engine is unavailable.
 */
export class ChunkedWhisperStt {
  private readonly engine: LocalSttEngine;

  constructor(engine: LocalSttEngine) {
    if (!engine) throw new Error('ChunkedWhisperStt: an STT engine is required.');
    this.engine = engine;
  }

  /** True when the engine behind this transcriber is available. */
  isAvailable(): boolean {
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
   * Transcribe PCM16, chunking when it is longer than `chunkMs`.
   * Chunks are transcribed sequentially (one whisper process at a
   * time — the VM has 1.5 CPUs and parallel whisper runs would
   * thrash). Empty/blank audio returns '' without waking the
   * engine.
   */
  async transcribeChunked(
    pcm16: Uint8Array,
    options: ChunkedWhisperOptions = {},
  ): Promise<ChunkedWhisperResult> {
    if (!this.isAvailable()) {
      throw new Error(`ChunkedWhisperStt: ${this.engine.status().reason ?? 'local STT unavailable.'}`);
    }
    if (!isValidPcm16Frame(pcm16)) {
      throw new Error('ChunkedWhisperStt: audio must be a non-empty even-length PCM16 buffer.');
    }
    const sampleRateHz = options.sampleRateHz ?? 16_000;
    const language = options.language ?? 'en';
    const chunkMs = Math.max(1000, options.chunkMs ?? WHISPER_CHUNK_MS);
    const overlapMs = Math.min(Math.max(0, options.overlapMs ?? WHISPER_CHUNK_OVERLAP_MS), Math.floor(chunkMs / 2));
    const overlapMaxWords = options.overlapMaxWords ?? WHISPER_OVERLAP_MAX_WORDS;
    const started = Date.now();
    const totalSamples = pcm16.length / 2;
    const chunkSamples = Math.round((sampleRateHz * chunkMs) / 1000);
    const overlapSamples = Math.round((sampleRateHz * overlapMs) / 1000);
    const stepSamples = Math.max(1, chunkSamples - overlapSamples);
    const chunks: WhisperChunkResult[] = [];
    let joined = '';
    for (let start = 0, index = 0; start < totalSamples; start += stepSamples, index++) {
      const end = Math.min(totalSamples, start + chunkSamples);
      const slice = pcm16.slice(start * 2, end * 2);
      const chunkStarted = Date.now();
      const raw = await this.engine.transcribe(new Uint8Array(slice), {
        sampleRateHz,
        language,
        timeoutMs: options.timeoutMs,
        threads: options.threads,
      });
      const deduped = index === 0 ? raw.trim() : dedupeChunkOverlap(joined, raw.trim(), overlapMaxWords);
      chunks.push({
        index,
        startMs: Math.round((start / sampleRateHz) * 1000),
        endMs: Math.round((end / sampleRateHz) * 1000),
        text: deduped,
        transcribeMs: Date.now() - chunkStarted,
        bytes: slice.length,
      });
      joined = joined ? `${joined} ${deduped}`.trim() : deduped;
      if (end >= totalSamples) break;
    }
    return { text: joined, chunks, chunkCount: chunks.length, totalMs: Date.now() - started };
  }

  /**
   * Segment-first transcription: split on silence, then chunk
   * any span longer than `chunkMs`. Short recordings with pauses
   * become one engine call per span (no mid-word window cuts);
   * long monologues still get chunked. Returns the joined text
   * plus per-span chunk counts.
   */
  async transcribeSegmented(
    pcm16: Uint8Array,
    options: ChunkedWhisperOptions & SilenceSplitOptions = {},
  ): Promise<ChunkedWhisperResult & { segmentCount: number }> {
    if (!this.isAvailable()) {
      throw new Error(`ChunkedWhisperStt: ${this.engine.status().reason ?? 'local STT unavailable.'}`);
    }
    const started = Date.now();
    const segments = splitAudioOnSilence(pcm16, options);
    if (segments.length === 0) {
      return { text: '', chunks: [], chunkCount: 0, totalMs: Date.now() - started, segmentCount: 0 };
    }
    const allChunks: WhisperChunkResult[] = [];
    const texts: string[] = [];
    for (const segment of segments) {
      const res = await this.transcribeChunked(segment.pcm16, options);
      texts.push(res.text);
      allChunks.push(...res.chunks);
    }
    return {
      text: texts.filter(Boolean).join(' ').trim(),
      chunks: allChunks,
      chunkCount: allChunks.length,
      totalMs: Date.now() - started,
      segmentCount: segments.length,
    };
  }
}

// ---------------------------------------------------------------------------
// WER benchmark (reproducible scoring against known references)
// ---------------------------------------------------------------------------

/** One benchmark case: known speech + its reference text. */
export interface WerBenchmarkCase {
  /** Case name (e.g. 'hello-world'). */
  name: string;
  /** Reference text the audio speaks. */
  reference: string;
  /** PCM16 audio of the reference (16 kHz mono). */
  pcm16: Uint8Array;
}

/** One benchmark case scored. */
export interface WerBenchmarkCaseResult extends WordErrorRate {
  name: string;
  reference: string;
  hypothesis: string;
  transcribeMs: number;
}

/** Whole-benchmark result. */
export interface WerBenchmarkResult {
  /** Per-case results (in input order). */
  cases: WerBenchmarkCaseResult[];
  /** Mean WER across cases (0 = perfect). */
  meanWer: number;
  /** Worst-case WER. */
  maxWer: number;
  /** Cases run. */
  caseCount: number;
  /** Total wall-clock time (ms). */
  totalMs: number;
}

/**
 * Score an engine against known-reference audio: transcribe each
 * case and compute its WER. The engine is used as-is (chunked or
 * direct — the caller picks by passing a `ChunkedWhisperStt` or
 * any `LocalSttEngine`). A case that throws is recorded with
 * wer 1 and the error in `hypothesis` (prefixed `ERROR: `), so
 * one bad case never aborts the benchmark.
 */
export async function runWerBenchmark(
  engine: LocalSttEngine | ChunkedWhisperStt,
  cases: WerBenchmarkCase[],
  options: LocalSttTranscribeOptions & { chunked?: boolean } = {},
): Promise<WerBenchmarkResult> {
  const started = Date.now();
  const results: WerBenchmarkCaseResult[] = [];
  for (const c of cases) {
    const caseStarted = Date.now();
    let hypothesis = '';
    try {
      if (engine instanceof ChunkedWhisperStt) {
        hypothesis = (await engine.transcribeChunked(c.pcm16, options)).text;
      } else {
        hypothesis = await engine.transcribe(c.pcm16, options);
      }
    } catch (err) {
      hypothesis = `ERROR: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
    }
    const wer = wordErrorRate(c.reference, hypothesis);
    results.push({
      name: c.name,
      reference: c.reference,
      hypothesis,
      transcribeMs: Date.now() - caseStarted,
      ...wer,
    });
  }
  const meanWer =
    results.length === 0
      ? 0
      : Math.round((results.reduce((n, r) => n + r.wer, 0) / results.length) * 1000) / 1000;
  const maxWer = results.reduce((n, r) => Math.max(n, r.wer), 0);
  return { cases: results, meanWer, maxWer, caseCount: results.length, totalMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Streaming session (live call: frames in, results out)
// ---------------------------------------------------------------------------

/** One streaming result (a VAD segment transcribed). */
export interface StreamingSttResult {
  /** Transcribed text (trimmed). */
  text: string;
  /** Speech duration of the segment (ms). */
  segmentMs: number;
  /** Wall-clock time the engine took (ms). */
  transcribeMs: number;
  /** When the segment ended (wall clock). */
  at: number;
  /** Segment index (0-based, per session). */
  index: number;
}

/** Streaming session callbacks. */
export interface StreamingSttCallbacks {
  /** A segment finished transcribing. */
  onResult?: (result: StreamingSttResult) => void;
  /** A segment failed to transcribe. */
  onError?: (error: Error) => void;
  /** VAD speech started / ended (mic meter / UI). */
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
}

/** Options for a streaming session. */
export interface StreamingSttOptions {
  /** Engine (whisper CLI, mock, …) or a chunked transcriber. */
  engine: LocalSttEngine | ChunkedWhisperStt;
  /** Sample rate of fed frames (Hz). Default 16000. */
  sampleRateHz?: number;
  /** VAD threshold (RMS 0..1). Default 0.02. */
  vadThreshold?: number;
  /** VAD hangover (ms). Default 300. */
  vadHangoverMs?: number;
  /** Language hint (e.g. 'en', 'vi'). Default 'en'. */
  language?: string;
  /** Min segment (ms). Default 300. */
  minSegmentMs?: number;
  /** Max segment before a mid-speech cut (ms). Default 30000. */
  maxSegmentMs?: number;
  /** Callbacks. */
  callbacks?: StreamingSttCallbacks;
}

/** Eval report for a streaming session. */
export interface StreamingSttEvalReport {
  /** Segments transcribed so far. */
  segments: number;
  /** Segments that failed. */
  failures: number;
  /** Mean transcribe latency (ms), 0 when none. */
  meanTranscribeMs: number;
  /** Mean WER over eval-scored segments (null when none scored). */
  meanWer: number | null;
  /** Last result text ('' when none). */
  lastText: string;
}

/**
 * Live streaming STT session: mic frames in (via `feed()`), VAD
 * segments out through the pipeline, each segment transcribed by
 * the (chunked) engine. Thin over `LocalSttPipeline` — the added
 * value is the per-segment result index, the eval report, and
 * `scoreReference()` for live WER tracking in tests: when the
 * caller knows what a segment *should* say, the session records
 * the WER instead of guessing.
 */
export class StreamingSttSession {
  private readonly pipeline: LocalSttPipeline;
  private readonly callbacks: StreamingSttCallbacks;
  private readonly chunked: ChunkedWhisperStt | null;
  private readonly engine: LocalSttEngine;
  private readonly language: string;
  private readonly sampleRateHz: number;
  private resultIndex = 0;
  private transcribeLatencies: number[] = [];
  private evalWers: number[] = [];
  private lastText = '';
  private disposed = false;

  constructor(options: StreamingSttOptions) {
    if (!options.engine) throw new Error('StreamingSttSession: an STT engine is required.');
    this.callbacks = options.callbacks ?? {};
    this.language = options.language ?? 'en';
    this.sampleRateHz = options.sampleRateHz ?? 16_000;
    this.chunked = options.engine instanceof ChunkedWhisperStt ? options.engine : null;
    this.engine =
      options.engine instanceof ChunkedWhisperStt
        ? new ChunkedEngineAdapter(options.engine)
        : options.engine;
    const callbacks = this.callbacks;
    this.pipeline = new LocalSttPipeline({
      engine: this.engine,
      sampleRateHz: this.sampleRateHz,
      vadThreshold: options.vadThreshold,
      vadHangoverMs: options.vadHangoverMs,
      language: this.language,
      minSegmentMs: options.minSegmentMs,
      maxSegmentMs: options.maxSegmentMs,
      callbacks: {
        onResult: (r) => {
          this.transcribeLatencies.push(r.transcribeMs);
          this.lastText = r.text;
          const result: StreamingSttResult = {
            text: r.text,
            segmentMs: r.segmentMs,
            transcribeMs: r.transcribeMs,
            at: r.at,
            index: this.resultIndex++,
          };
          try {
            callbacks.onResult?.(result);
          } catch {
            // A throwing callback must not break the session.
          }
        },
        onError: (err) => {
          try {
            callbacks.onError?.(err);
          } catch {
            // A throwing callback must not break the session.
          }
        },
        onSpeechStart: () => {
          try {
            callbacks.onSpeechStart?.();
          } catch {
            // Ignore.
          }
        },
        onSpeechEnd: () => {
          try {
            callbacks.onSpeechEnd?.();
          } catch {
            // Ignore.
          }
        },
      },
    });
  }

  /** True while the VAD hears speech. */
  isSpeaking(): boolean {
    return this.pipeline.isSpeaking();
  }

  /** RMS of the most recent window (0..1) — mic level for the UI. */
  get micLevel(): number {
    return this.pipeline.micLevel;
  }

  /** Segments transcribed so far. */
  get transcribedCount(): number {
    return this.pipeline.transcribedCount;
  }

  /** Transcription failures so far. */
  get failureCount(): number {
    return this.pipeline.failureCount;
  }

  /** Feed one PCM16 mic frame. Throws on an invalid frame. */
  feed(frame: Uint8Array): void {
    if (this.disposed) throw new Error('StreamingSttSession: session is disposed.');
    this.pipeline.feed(frame);
  }

  /** End the current segment now and transcribe it (if long enough). */
  flush(): void {
    this.pipeline.flush();
  }

  /** Wait until every queued transcription has finished. */
  async drain(): Promise<void> {
    await this.pipeline.drain();
  }

  /**
   * Score the last result against a known reference (eval mode):
   * records the WER for `getEvalReport()`. Returns the WER (or
   * null when nothing was transcribed yet).
   */
  scoreReference(reference: string): WordErrorRate | null {
    if (!this.lastText) return null;
    const wer = wordErrorRate(reference, this.lastText);
    this.evalWers.push(wer.wer);
    return wer;
  }

  /** Eval report: segments, latencies, rolling WER. */
  getEvalReport(): StreamingSttEvalReport {
    const meanTranscribeMs =
      this.transcribeLatencies.length === 0
        ? 0
        : Math.round(
            (this.transcribeLatencies.reduce((n, v) => n + v, 0) /
              this.transcribeLatencies.length) *
              10,
          ) / 10;
    return {
      segments: this.pipeline.transcribedCount,
      failures: this.pipeline.failureCount,
      meanTranscribeMs,
      meanWer:
        this.evalWers.length === 0
          ? null
          : Math.round(
              (this.evalWers.reduce((n, v) => n + v, 0) / this.evalWers.length) * 1000,
            ) / 1000,
      lastText: this.lastText,
    };
  }

  /** Stop accepting frames; queued transcriptions still finish. */
  dispose(): void {
    this.disposed = true;
    this.pipeline.dispose();
  }
}

/**
 * Adapts a `ChunkedWhisperStt` to the plain `LocalSttEngine`
 * interface so the VAD pipeline can use it: each segment is
 * transcribed chunked (long segments get windowed + deduped).
 * Exposed for tests; the session uses it internally.
 */
export class ChunkedEngineAdapter implements LocalSttEngine {
  readonly id: string;

  constructor(private readonly chunked: ChunkedWhisperStt) {
    this.id = 'chunked-whisper';
  }

  isAvailable(): boolean {
    return this.chunked.isAvailable();
  }

  status(): ReturnType<LocalSttEngine['status']> {
    return this.chunked.engineStatus();
  }

  async transcribe(pcm16: Uint8Array, opts?: LocalSttTranscribeOptions): Promise<string> {
    return (await this.chunked.transcribeChunked(pcm16, opts)).text;
  }
}
