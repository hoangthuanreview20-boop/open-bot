/**
 * Local TTS queue (v0.96, Đội T5 — voice live).
 *
 * v0.95's `TtsHarness.speak()` speaks one utterance and `stop()`
 * kills it, but a realtime session needs more: a long model reply
 * must be spoken sentence by sentence (so barge-in can cut it off
 * mid-reply instead of waiting for the whole paragraph), and the
 * queue must die fast when the user starts talking.
 *
 *   enqueue(text) ──▶ splitIntoSentences ──▶ [s1, s2, s3, …]
 *        speak s1 → speak s2 → … (one engine call at a time)
 *        stop() / bargeIn() ──▶ kill the sentence speaking now,
 *        drop the rest of the queue, report how fast it died.
 *
 * Rules (explicit, so the queue never talks over the user):
 *   - Sentences are split on `. ! ? …` and on `:`/`;` inside very
 *     long sentences (> 120 chars), so a pause lands at least every
 *     ~120 chars. Abbreviations (`Mr.`, `Dr.`, `e.g.`, `v.v.`)
 *     do not split — they are on an allow-list, not guessed.
 *   - `stop()` is the barge-in path: it kills the in-flight
 *     engine process AND drops the queued sentences. The returned
 *     `stopLatencyMs` is the wall time from the `stop()` call until
 *     the in-flight `speak()` promise settled with `'stopped'`
 *     (the real measure of "how fast did the voice die"), and the
 *     queue records the last value for the UI/latency stats. A
 *     `TtsQueue` built on the mock engine stops instantly; on
 *     eSpeak NG the kill is a SIGKILL, so the settle is normally
 *     well under 200 ms — the test asserts exactly that.
 *   - `enqueue()` while speaking appends (the reply keeps flowing);
 *     `speakNow()` (used for the interrupt acknowledgement) clears
 *     the queue first, then speaks.
 *   - The queue never throws: an engine failure ends the current
 *     utterance with `onError` and the queue moves on.
 *   - The queue speaks through a `TtsHarness` (system engine
 *     first, mock fallback) — the same harness the rest of the app
 *     uses, so voice selection / rate options behave identically.
 */
import { TtsHarness, stripMarkdownForSpeech, type TtsSpeakOptions } from './tts';

/** One sentence the queue is about to speak (or has spoken). */
export interface QueuedSentence {
  /** Sentence text (cleaned for speech). */
  text: string;
  /** Options for this sentence (voice / rate / lang). */
  opts?: TtsSpeakOptions;
  /** When it was enqueued (wall clock). */
  enqueuedAt: number;
  /** When it finished speaking (wall clock), null while pending. */
  spokenAt: number | null;
  /** True when this sentence was dropped by a stop. */
  dropped: boolean;
}

/** Result of a barge-in stop. */
export interface TtsQueueStopResult {
  /** True when something was actually speaking or queued. */
  stopped: boolean;
  /** Sentences dropped from the queue (not spoken). */
  droppedSentences: number;
  /**
   * Wall time (ms) from the stop() call until the in-flight
   * speak() settled. 0 when nothing was speaking. The <200 ms
   * barge-in budget is measured on this number.
   */
  stopLatencyMs: number;
}

/** Queue callbacks. */
export interface TtsQueueCallbacks {
  /** A sentence started speaking. */
  onSentenceStart?: (sentence: QueuedSentence) => void;
  /** A sentence finished speaking. */
  onSentenceDone?: (sentence: QueuedSentence) => void;
  /** The queue went idle (nothing left to speak). */
  onIdle?: () => void;
  /** An engine failure while speaking one sentence. */
  onError?: (error: Error) => void;
}

/** Options for the TTS queue. */
export interface TtsQueueOptions {
  /** Harness to speak through. Default: a fresh `TtsHarness()`. */
  harness?: TtsHarness;
  /** Default speak options (voice / rate / lang) for every sentence. */
  defaultOpts?: TtsSpeakOptions;
  /** Max sentences split from one enqueue (default 200). */
  maxSentences?: number;
  /** Callbacks. */
  callbacks?: TtsQueueCallbacks;
}

/** Long sentences are also split on these marks (see header). */
const LONG_SENTENCE_SPLIT_CHARS = 120;

/** Abbreviations that must NOT end a sentence. */
export const TTS_ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'vs', 'e.g', 'i.e', 'etc', 'no', 'v.v', 'vd', 'tp', 'p',
]);

/**
 * Split text into speakable sentences. Splits after `. ! ? …`
 * (and `...`) when followed by whitespace/end; a sentence longer
 * than 120 chars is also split at `, ; :` boundaries. Markdown is
 * stripped first (the engine would read the syntax otherwise).
 * Abbreviation periods are protected with a placeholder before
 * splitting (`Dr.` never ends a sentence) and restored after.
 * Returns [] for empty text.
 */
export function splitIntoSentences(text: string): string[] {
  const clean = stripMarkdownForSpeech(text ?? '');
  if (!clean) return [];
  const ABBR_DOT = '\uE000';
  const protectedText = clean.replace(
    new RegExp(`\\b(${[...TTS_ABBREVIATIONS].map((a) => a.replace(/\./g, '\\.')).join('|')})\\.`, 'gi'),
    `$1${ABBR_DOT}`,
  );
  const sentences: string[] = [];
  // First pass: split on sentence terminators.
  const re = /[^.!?…]+(?:[.!?…]+["'”’)]?|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(protectedText)) !== null) {
    const raw = m[0].replaceAll(ABBR_DOT, '.').trim();
    if (!raw) continue;
    sentences.push(raw);
  }
  // If the regex found nothing usable (e.g. no terminator at all),
  // the whole text is one sentence.
  if (sentences.length === 0) return [clean];
  // Second pass: a sentence that is still very long gets split at
  // commas / semicolons / colons so a pause lands regularly.
  const out: string[] = [];
  for (const s of sentences) {
    if (s.length <= LONG_SENTENCE_SPLIT_CHARS) {
      out.push(s);
      continue;
    }
    const parts = s.split(/(?<=[,;:])\s+/);
    let acc = '';
    for (const part of parts) {
      if (!acc) {
        acc = part;
        continue;
      }
      if ((acc + ' ' + part).length > LONG_SENTENCE_SPLIT_CHARS) {
        out.push(acc.trim());
        acc = part;
      } else {
        acc = `${acc} ${part}`;
      }
    }
    if (acc.trim()) out.push(acc.trim());
  }
  return out.filter((s) => s.length > 0);
}

/** Barge-in budget: the voice must die within this many ms. */
export const TTS_BARGE_IN_BUDGET_MS = 200;

export class TtsQueue {
  private readonly harness: TtsHarness;
  private readonly defaultOpts?: TtsSpeakOptions;
  private readonly maxSentences: number;
  private readonly callbacks: TtsQueueCallbacks;
  private queue: QueuedSentence[] = [];
  /** True while one sentence is being spoken. */
  private speaking = false;
  /** Serial pump: at most one loop runs at a time. */
  private pumpRunning = false;
  /** Bumped by every stop(): the pump exits when it sees a new epoch. */
  private stopEpoch = 0;
  /** Last measured stop latency (ms), null when never stopped. */
  private lastStopLatencyMs: number | null = null;
  /** Sentences spoken so far. */
  private spokenCount = 0;
  /** Sentences dropped by stops so far. */
  private droppedCount = 0;

  constructor(options: TtsQueueOptions = {}) {
    this.harness = options.harness ?? new TtsHarness();
    this.defaultOpts = options.defaultOpts;
    this.maxSentences = Math.max(1, options.maxSentences ?? 200);
    this.callbacks = options.callbacks ?? {};
  }

  /** True while a sentence is being spoken. */
  isSpeaking(): boolean {
    return this.speaking;
  }

  /** Sentences still queued (not counting the one speaking). */
  get queuedCount(): number {
    return this.queue.length;
  }

  /** Sentences spoken so far. */
  get spokenSentences(): number {
    return this.spokenCount;
  }

  /** Sentences dropped by stops so far. */
  get droppedSentences(): number {
    return this.droppedCount;
  }

  /** Last measured stop latency (ms), null when never stopped. */
  get lastStopLatency(): number | null {
    return this.lastStopLatencyMs;
  }

  /**
   * Enqueue text for speaking (sentence by sentence). Returns the
   * number of sentences queued. Empty text queues nothing.
   */
  enqueue(text: string, opts?: TtsSpeakOptions): number {
    const sentences = splitIntoSentences(text).slice(0, this.maxSentences);
    const now = Date.now();
    for (const s of sentences) {
      this.queue.push({
        text: s,
        opts: opts ?? this.defaultOpts,
        enqueuedAt: now,
        spokenAt: null,
        dropped: false,
      });
    }
    if (sentences.length > 0) void this.pump();
    return sentences.length;
  }

  /**
   * Clear the queue and speak this text instead (interrupt
   * acknowledgement, alerts). Returns the sentences queued.
   */
  async speakNow(text: string, opts?: TtsSpeakOptions): Promise<number> {
    await this.stop();
    return this.enqueue(text, opts);
  }

  /**
   * Barge-in: kill the sentence speaking now and drop the rest of
   * the queue. `stopLatencyMs` measures the call until the
   * in-flight speak() settled (the pump's `speaking` flag clears
   * when the engine's speak() promise resolves `'stopped'`) — the
   * number the <200 ms budget is judged on. Never throws;
   * `{ stopped: false }` when idle.
   */
  async stop(): Promise<TtsQueueStopResult> {
    const started = Date.now();
    const wasSpeaking = this.speaking;
    const queued = this.queue.length;
    this.stopEpoch += 1;
    for (const s of this.queue) {
      s.dropped = true;
      this.droppedCount += 1;
    }
    this.queue = [];
    let stopped = false;
    if (wasSpeaking) {
      try {
        stopped = (await this.harness.stop()).stopped;
      } catch {
        stopped = false;
      }
      // Wait for the in-flight speak() to settle ('stopped'):
      // the pump clears `speaking` right after it resolves. Cap
      // the wait so a wedged engine cannot hang barge-in.
      const deadline = Date.now() + 1000;
      while (this.speaking && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2));
      }
    }
    const stopLatencyMs = wasSpeaking ? Date.now() - started : 0;
    if (wasSpeaking) this.lastStopLatencyMs = stopLatencyMs;
    return {
      stopped: stopped || queued > 0 || wasSpeaking,
      droppedSentences: queued,
      stopLatencyMs,
    };
  }

  /** Alias for `stop()` — the barge-in entry point the session calls. */
  async bargeIn(): Promise<TtsQueueStopResult> {
    return this.stop();
  }

  /** Wait until the queue is idle (nothing speaking or queued). */
  async drain(): Promise<void> {
    while (this.speaking || this.queue.length > 0 || this.pumpRunning) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  // -- internals ----------------------------------------------------------

  /** Serial pump: speak queued sentences one at a time. */
  private async pump(): Promise<void> {
    if (this.pumpRunning) return;
    this.pumpRunning = true;
    const epoch = this.stopEpoch;
    try {
      while (this.queue.length > 0) {
        if (this.stopEpoch !== epoch) break;
        const sentence = this.queue.shift();
        if (!sentence) break;
        this.speaking = true;
        try {
          this.callbacks.onSentenceStart?.(sentence);
        } catch {
          // A throwing callback must not break the queue.
        }
        let result: { spoken: boolean; reason?: string };
        try {
          result = await this.harness.speak(sentence.text, sentence.opts);
        } catch (err) {
          result = { spoken: false, reason: err instanceof Error ? err.message : 'engine-error' };
          try {
            this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
          } catch {
            // A throwing callback must not break the queue.
          }
        }
        this.speaking = false;
        if (this.stopEpoch !== epoch) {
          // Killed mid-sentence: count it dropped, do not report it
          // as spoken, and stop pumping.
          sentence.dropped = true;
          this.droppedCount += 1;
          break;
        }
        sentence.spokenAt = Date.now();
        if (result.spoken) this.spokenCount += 1;
        try {
          this.callbacks.onSentenceDone?.(sentence);
        } catch {
          // A throwing callback must not break the queue.
        }
      }
    } finally {
      this.speaking = false;
      this.pumpRunning = false;
      if (this.queue.length === 0) {
        try {
          this.callbacks.onIdle?.();
        } catch {
          // A throwing callback must not break the queue.
        }
      }
    }
  }
}
