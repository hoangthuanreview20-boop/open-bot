/**
 * Realtime audio plumbing (v0.95, Đội D3).
 *
 * Everything between the microphone / speaker and the realtime
 * transport, kept provider-agnostic:
 *
 *   - PCM16 helpers: validate frames, compute RMS energy, resample
 *     16 kHz <-> 24 kHz by linear interpolation, and accumulate
 *     small mic frames into 100 ms transport frames
 *     (`Pcm16Chunker`).
 *   - `LocalVad`: an energy-based voice activity detector. It is
 *     deliberately simple (RMS threshold + hangover) — it only has
 *     to decide "the user started / stopped speaking" for
 *     turn-taking in `local_vad` mode and for barge-in; the server
 *     VAD stays the default. No model, no native dependency, so it
 *     runs on the headless VM and in tests.
 *   - `AudioSource` / `AudioSink`: the duplex ends a
 *     `RealtimeSession` talks to. The real ends live in the
 *     renderer (AudioWorklet mic capture, AudioContext playback)
 *     and in main (IPC); here the contracts plus deterministic
 *     mocks for tests. The VM has no sound card, so a real
 *     microphone/speaker pair cannot be exercised here — the mocks
 *     are the testable surface.
 */
import {
  REALTIME_FRAME_BYTES_16K,
  REALTIME_FRAME_MS,
  REALTIME_MIC_SAMPLE_RATE_HZ,
} from './types';

/** Bytes per 16-bit mono sample. */
export const PCM16_BYTES_PER_SAMPLE = 2;

/** Default VAD speech threshold (RMS, 0..1 for int16-normalised
 *  samples). Speech in a quiet room through a laptop mic is
 *  typically 0.05–0.3; silence / room noise stays below ~0.01. */
export const LOCAL_VAD_DEFAULT_THRESHOLD = 0.02;
/** Default VAD hangover: speech is only "ended" after this much
 *  continuous silence (ms). */
export const LOCAL_VAD_DEFAULT_HANGOVER_MS = 300;
/** VAD analyses audio in windows of this length (ms). */
export const LOCAL_VAD_WINDOW_MS = 20;

/** True when `frame` is a non-empty, even-length PCM16 buffer. */
export function isValidPcm16Frame(frame: unknown): frame is Uint8Array {
  return frame instanceof Uint8Array && frame.length > 0 && frame.length % 2 === 0;
}

/** Read sample `i` of a PCM16 little-endian frame as -1..1. */
export function pcm16Sample(frame: Uint8Array, i: number): number {
  const lo = frame[i * 2] ?? 0;
  const hi = frame[i * 2 + 1] ?? 0;
  let v = (hi << 8) | lo;
  if (v >= 0x8000) v -= 0x10000;
  return v / 32768;
}

/**
 * RMS energy (0..1) of a PCM16 frame. 0 is digital silence; a sine
 * at full scale is ~0.707. Pure function — the VAD and the mic-level
 * meter both use it.
 */
export function pcm16Rms(frame: Uint8Array): number {
  if (frame.length < 2) return 0;
  const n = frame.length / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm16Sample(frame, i);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/** Write a -1..1 sample into `frame` at index `i` (clamped, int16 LE). */
function writePcm16Sample(frame: Uint8Array, i: number, value: number): void {
  const clamped = Math.max(-1, Math.min(1, value));
  const v = Math.round(clamped * 32767);
  const u = v < 0 ? v + 0x10000 : v;
  frame[i * 2] = u & 0xff;
  frame[i * 2 + 1] = (u >> 8) & 0xff;
}

/**
 * Resample PCM16 mono by linear interpolation. Used to upsample mic
 * audio 16 kHz -> 24 kHz for the OpenAI transport (which expects
 * 24 kHz) and to downsample 24 kHz -> 16 kHz when a consumer needs
 * 16 kHz. Integer rates only; `fromHz` and `toHz` must be positive.
 * Output length is `round(inSamples * toHz / fromHz)` samples.
 */
export function resamplePcm16(frame: Uint8Array, fromHz: number, toHz: number): Uint8Array {
  if (!isValidPcm16Frame(frame)) {
    throw new Error('resamplePcm16: frame must be a non-empty even-length PCM16 buffer.');
  }
  if (!Number.isInteger(fromHz) || fromHz <= 0 || !Number.isInteger(toHz) || toHz <= 0) {
    throw new Error('resamplePcm16: sample rates must be positive integers.');
  }
  if (fromHz === toHz) return new Uint8Array(frame);
  const inSamples = frame.length / 2;
  const outSamples = Math.max(1, Math.round((inSamples * toHz) / fromHz));
  const out = new Uint8Array(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const pos = (i * fromHz) / toHz;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = pcm16Sample(frame, Math.min(idx, inSamples - 1));
    const b = pcm16Sample(frame, Math.min(idx + 1, inSamples - 1));
    writePcm16Sample(out, i, a + (b - a) * frac);
  }
  return out;
}

/**
 * Build a PCM16 frame of `samples` sine samples at `amplitude`
 * (0..1) — test / mock audio. `frequencyHz` defaults to 440 Hz at
 * 16 kHz.
 */
export function sinePcm16Frame(
  samples: number,
  amplitude = 0.2,
  frequencyHz = 440,
  sampleRateHz = REALTIME_MIC_SAMPLE_RATE_HZ,
): Uint8Array {
  const out = new Uint8Array(samples * 2);
  for (let i = 0; i < samples; i++) {
    writePcm16Sample(
      out,
      i,
      amplitude * Math.sin((2 * Math.PI * frequencyHz * i) / sampleRateHz),
    );
  }
  return out;
}

/** Silence frame: `samples` zero samples. */
export function silencePcm16Frame(samples: number): Uint8Array {
  return new Uint8Array(samples * 2);
}

/**
 * Accumulate small mic frames into fixed 100 ms transport frames.
 * The renderer worklet posts ~20–50 ms frames; the transports want
 * one `sendAudio` per 100 ms. Partial data is held until a full
 * frame is ready; `flush()` returns the leftover (possibly empty)
 * for end-of-turn commits. Throws on invalid frames.
 */
export class Pcm16Chunker {
  private readonly frameBytes: number;
  private pending = new Uint8Array(0);

  constructor(frameBytes: number = REALTIME_FRAME_BYTES_16K) {
    if (!Number.isInteger(frameBytes) || frameBytes <= 0 || frameBytes % 2 !== 0) {
      throw new Error('Pcm16Chunker: frameBytes must be a positive even integer.');
    }
    this.frameBytes = frameBytes;
  }

  /** Feed a mic frame; returns the whole 100 ms frames now ready. */
  push(frame: Uint8Array): Uint8Array[] {
    if (!isValidPcm16Frame(frame)) {
      throw new Error('Pcm16Chunker: frame must be a non-empty even-length PCM16 buffer.');
    }
    const joined = new Uint8Array(this.pending.length + frame.length);
    joined.set(this.pending, 0);
    joined.set(frame, this.pending.length);
    const out: Uint8Array[] = [];
    let offset = 0;
    while (joined.length - offset >= this.frameBytes) {
      out.push(joined.slice(offset, offset + this.frameBytes));
      offset += this.frameBytes;
    }
    this.pending = joined.slice(offset);
    return out;
  }

  /** Leftover bytes (< one frame) and reset. */
  flush(): Uint8Array {
    const left = this.pending;
    this.pending = new Uint8Array(0);
    return left;
  }

  /** Bytes currently held (< one frame). */
  get pendingBytes(): number {
    return this.pending.length;
  }
}

/** Local VAD callbacks. */
export interface LocalVadCallbacks {
  /** Fired once when speech starts (after silence). */
  onSpeechStart?: () => void;
  /** Fired once when speech ends (after `hangoverMs` of silence). */
  onSpeechEnd?: () => void;
}

/**
 * Energy-based voice activity detector.
 *
 * Feed it 20 ms windows (any length works — it slices internally);
 * it reports speech when the window RMS crosses `threshold`, and
 * ends speech only after `hangoverMs` of continuous sub-threshold
 * audio, so short pauses inside a sentence do not end the turn.
 * `isSpeaking` is the current state; `level` is the last RMS, for
 * the mic-level meter in the UI.
 */
export class LocalVad {
  private readonly threshold: number;
  private readonly hangoverMs: number;
  private readonly windowSamples: number;
  private readonly sampleRateHz: number;
  private readonly callbacks: LocalVadCallbacks;
  private speaking = false;
  private silenceMs = 0;
  private leftover = new Uint8Array(0);
  private lastLevel = 0;

  constructor(options: {
    threshold?: number;
    hangoverMs?: number;
    windowMs?: number;
    sampleRateHz?: number;
    callbacks?: LocalVadCallbacks;
  } = {}) {
    this.threshold = options.threshold ?? LOCAL_VAD_DEFAULT_THRESHOLD;
    this.hangoverMs = options.hangoverMs ?? LOCAL_VAD_DEFAULT_HANGOVER_MS;
    const windowMs = options.windowMs ?? LOCAL_VAD_WINDOW_MS;
    const sampleRateHz = options.sampleRateHz ?? REALTIME_MIC_SAMPLE_RATE_HZ;
    this.sampleRateHz = sampleRateHz;
    this.windowSamples = Math.max(1, Math.round((sampleRateHz * windowMs) / 1000));
    this.callbacks = options.callbacks ?? {};
  }

  /** True while speech is in progress. */
  isSpeaking(): boolean {
    return this.speaking;
  }

  /** RMS of the most recent window (0..1) — mic level for the UI. */
  get level(): number {
    return this.lastLevel;
  }

  /**
   * Feed PCM16 audio (any length). Windows are analysed in order;
   * a window straddling the end of this chunk is held for the next
   * `feed()` call. Throws on invalid frames.
   */
  feed(frame: Uint8Array): void {
    if (!isValidPcm16Frame(frame)) {
      throw new Error('LocalVad: frame must be a non-empty even-length PCM16 buffer.');
    }
    const joined = new Uint8Array(this.leftover.length + frame.length);
    joined.set(this.leftover, 0);
    joined.set(frame, this.leftover.length);
    const windowBytes = this.windowSamples * 2;
    let offset = 0;
    while (joined.length - offset >= windowBytes) {
      this.analyseWindow(joined.slice(offset, offset + windowBytes));
      offset += windowBytes;
    }
    this.leftover = joined.slice(offset);
  }

  /** Reset state (new turn / new session). */
  reset(): void {
    this.speaking = false;
    this.silenceMs = 0;
    this.leftover = new Uint8Array(0);
    this.lastLevel = 0;
  }

  private analyseWindow(window: Uint8Array): void {
    const rms = pcm16Rms(window);
    this.lastLevel = rms;
    const windowMs = (window.length / 2 / this.sampleRateHz) * 1000;
    if (rms >= this.threshold) {
      this.silenceMs = 0;
      if (!this.speaking) {
        this.speaking = true;
        this.callbacks.onSpeechStart?.();
      }
      return;
    }
    if (!this.speaking) return;
    this.silenceMs += windowMs;
    if (this.silenceMs >= this.hangoverMs) {
      this.speaking = false;
      this.silenceMs = 0;
      this.callbacks.onSpeechEnd?.();
    }
  }
}

// ---------------------------------------------------------------------------
// Audio source / sink contracts
// ---------------------------------------------------------------------------

/** One end of the duplex input: produces mic PCM16 frames. */
export interface AudioSource {
  /** Sample rate of the frames this source emits (Hz). */
  readonly sampleRateHz: number;
  /** Start producing frames (calls `onFrame` per frame). */
  start(onFrame: (frame: Uint8Array) => void): void;
  /** Stop producing frames. */
  stop(): void;
}

/** One end of the duplex output: consumes model PCM16 frames. */
export interface AudioSink {
  /** Sample rate of the frames this sink expects (Hz). */
  readonly sampleRateHz: number;
  /** Queue one frame for playback. */
  play(frame: Uint8Array): void;
  /** Drop everything queued but not yet played (barge-in). */
  clear(): void;
  /** Bytes currently queued. */
  get queuedBytes(): number;
}

/**
 * Deterministic mock mic: plays a script of speech/silence segments
 * as 100 ms frames. `pump()` emits the next frame synchronously
 * (tests drive it by hand — no timers, no sound card); `start()`
 * with an interval also works for live-ish demos. Speech frames are
 * a 440 Hz sine at amplitude 0.2 (RMS ~0.14, well above the default
 * VAD threshold); silence frames are zeros.
 */
export class MockAudioSource implements AudioSource {
  readonly sampleRateHz: number;
  private readonly frames: Uint8Array[];
  private index = 0;
  private onFrame: ((frame: Uint8Array) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param segments script, e.g. `[{ speech: true, frames: 5 },
   *   { speech: false, frames: 10 }]` — 5 frames of speech then 10
   *   of silence. Empty script = silence forever.
   * @param frameMs length of one emitted frame (default 100 ms).
   */
  constructor(
    segments: Array<{ speech: boolean; frames: number }> = [],
    private readonly frameMs: number = REALTIME_FRAME_MS,
    sampleRateHz: number = REALTIME_MIC_SAMPLE_RATE_HZ,
  ) {
    this.sampleRateHz = sampleRateHz;
    const samplesPerFrame = Math.round((sampleRateHz * frameMs) / 1000);
    this.frames = [];
    for (const seg of segments) {
      for (let i = 0; i < seg.frames; i++) {
        this.frames.push(
          seg.speech
            ? sinePcm16Frame(samplesPerFrame, 0.2, 440, sampleRateHz)
            : silencePcm16Frame(samplesPerFrame),
        );
      }
    }
  }

  /** Emit the next scripted frame (silence once the script ends). */
  pump(): Uint8Array {
    const samplesPerFrame = Math.round((this.sampleRateHz * this.frameMs) / 1000);
    const frame =
      this.frames[this.index] ?? silencePcm16Frame(samplesPerFrame);
    this.index += 1;
    this.onFrame?.(new Uint8Array(frame));
    return new Uint8Array(frame);
  }

  /** Frames already emitted. */
  get emittedFrames(): number {
    return this.index;
  }

  start(onFrame: (frame: Uint8Array) => void): void {
    this.onFrame = onFrame;
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.pump(), this.frameMs);
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as { unref(): void }).unref();
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.onFrame = null;
  }
}

/**
 * Deterministic mock speaker: records every frame it is given.
 * `clear()` (barge-in) drops the queue and counts the flush, so
 * tests can assert the playback queue was actually emptied.
 */
export class MockAudioSink implements AudioSink {
  readonly sampleRateHz: number;
  private queue: Uint8Array[] = [];
  /** Total bytes ever played (queued), including flushed ones. */
  totalBytes = 0;
  /** How many times `clear()` was called. */
  clears = 0;
  /** Bytes dropped by `clear()` calls, in total. */
  flushedBytes = 0;

  constructor(sampleRateHz: number = 24_000) {
    this.sampleRateHz = sampleRateHz;
  }

  play(frame: Uint8Array): void {
    if (!isValidPcm16Frame(frame)) {
      throw new Error('MockAudioSink: frame must be a non-empty even-length PCM16 buffer.');
    }
    this.queue.push(new Uint8Array(frame));
    this.totalBytes += frame.length;
  }

  clear(): void {
    this.clears += 1;
    for (const f of this.queue) this.flushedBytes += f.length;
    this.queue = [];
  }

  get queuedBytes(): number {
    return this.queue.reduce((n, f) => n + f.length, 0);
  }

  /** Frames currently queued (copies). */
  get queuedFrames(): Uint8Array[] {
    return this.queue.map((f) => new Uint8Array(f));
  }
}
