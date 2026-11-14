/**
 * Barge-in v2 (v1.02, Team T5 — realtime voice v2).
 *
 * v0.95/v0.98 barge-in is binary: any speech while the model speaks
 * cancels the response immediately. In a real call that misfires:
 * the model's own first syllables, a cough, or a half-second "uh-huh"
 * cut a reply the user wanted to hear, and the cut-off reply is
 * lost — the transcript pretends the model never started it. This
 * controller sits in front of the cancel and decides, per speech
 * event:
 *
 *   - Grace window: speech inside the first `graceMs` of a model
 *     reply is ignored — the model just started, the user is almost
 *     certainly reacting to the *previous* turn, not interrupting
 *     this one.
 *   - Debounce: speech shorter than `minSpeechMs` is a blip (cough,
 *     mic bump), not an interruption.
 *   - Partial turns: when a reply IS cut, the text spoken so far is
 *     kept as a `partial` model turn (via `takePartialTurn()`), so
 *     the long session still knows what the user heard.
 *   - Resume policy: after an interrupt the caller chooses
 *     `resume` (the model continues the cut reply on the next turn)
 *     or `restart` (the reply is dropped and the user starts over).
 *     The policy is recorded on the decision so the UI can show it.
 *
 * Timing still goes through the v0.98 `TurnTakingMeter` (detect →
 * cancel → flush → listening, 500 ms budget) — this module decides
 * *whether* to interrupt, the meter measures *how fast* it went.
 * The controller is pure logic with an injectable clock: no socket,
 * no audio, no TTS. The session calls `noteSpeech()` and acts on
 * the returned decision.
 */
import {
  TurnTakingMeter,
  type BargeInMeasurement,
  type BargeInSource,
  type TurnTakingStats,
} from './turnTaking';

/** Speech inside the first N ms of a model reply is ignored. */
export const BARGE_IN_V2_DEFAULT_GRACE_MS = 800;
/** Speech shorter than N ms is a blip, not an interruption. */
export const BARGE_IN_V2_DEFAULT_MIN_SPEECH_MS = 150;
/** Max chars of a cut-off reply kept as the partial turn. */
export const BARGE_IN_V2_MAX_PARTIAL_CHARS = 2_000;

/** What to do with a cut-off reply on the next turn. */
export type BargeInResumePolicy = 'resume' | 'restart';

/** Why a speech event did or did not interrupt. */
export type BargeInV2Reason =
  | 'ok'
  | 'not-speaking'
  | 'grace'
  | 'too-short'
  | 'already-interrupting';

/** One decision: interrupt the model, or ignore this speech. */
export interface BargeInV2Decision {
  action: 'interrupt' | 'ignore';
  reason: BargeInV2Reason;
  /** Where the speech was heard. */
  source: BargeInSource;
  /** ms into the current model reply when speech was heard. */
  speechAtMs: number | null;
  /** Resume policy that applies when action is `interrupt`. */
  resumePolicy: BargeInResumePolicy;
  /** When the decision was made (clock ms). */
  at: number;
}

/** A cut-off model reply, kept so the transcript stays truthful. */
export interface PartialModelTurn {
  /** Text spoken before the cut-off (may be ''). */
  text: string;
  /** ms into the reply when it was cut. */
  cutAtMs: number;
  /** Where the interruption was detected. */
  source: BargeInSource;
  /** When it was cut (clock ms). */
  at: number;
}

export interface BargeInV2Options {
  /** Grace window (ms). Default 800. */
  graceMs?: number;
  /** Minimum speech length (ms) that counts as an interruption. Default 150. */
  minSpeechMs?: number;
  /** Resume policy after an interrupt. Default 'restart'. */
  resumePolicy?: BargeInResumePolicy;
  /** Turn-taking meter (timing). Defaults to a fresh meter. */
  meter?: TurnTakingMeter;
  /** Inject the clock (tests). Defaults to `Date.now`. */
  clock?: () => number;
}

export class BargeInController {
  private readonly graceMs: number;
  private readonly minSpeechMs: number;
  private readonly resumePolicy: BargeInResumePolicy;
  private readonly meter: TurnTakingMeter;
  private readonly clock: () => number;
  /** When the current model reply started (clock ms), null when the
   *  model is not speaking. */
  private modelSpeechStartedAt: number | null = null;
  /** Interim text of the model reply in progress (for partials). */
  private interimModelText = '';
  /** True while a barge-in round-trip is in flight. */
  private interrupting = false;
  /** Age (ms) of the model reply when the current interrupt was
   *  decided — kept so the partial turn records where it was cut. */
  private interruptReplyAgeMs: number | null = null;
  /** Cut-off replies kept this session (oldest first). */
  private partialTurns: PartialModelTurn[] = [];
  /** Ignored speech events, by reason (diagnostics). */
  private ignored: Record<BargeInV2Reason, number> = {
    ok: 0,
    'not-speaking': 0,
    grace: 0,
    'too-short': 0,
    'already-interrupting': 0,
  };
  /** Interrupts decided so far. */
  private interruptCount = 0;

  constructor(options: BargeInV2Options = {}) {
    this.graceMs = Math.max(0, options.graceMs ?? BARGE_IN_V2_DEFAULT_GRACE_MS);
    this.minSpeechMs = Math.max(0, options.minSpeechMs ?? BARGE_IN_V2_DEFAULT_MIN_SPEECH_MS);
    this.resumePolicy = options.resumePolicy ?? 'restart';
    this.meter = options.meter ?? new TurnTakingMeter();
    this.clock = options.clock ?? Date.now;
  }

  /** True while the model is mid-reply. */
  isModelSpeaking(): boolean {
    return this.modelSpeechStartedAt !== null;
  }

  /** True while a barge-in round-trip decided here is in flight. */
  isInterrupting(): boolean {
    return this.interrupting;
  }

  /**
   * Keep the cut-off reply as a partial turn when the interruption
   * was decided elsewhere (the session's own server-VAD barge-in):
   * no meter was begun here, so there is no measurement — only the
   * text spoken so far. Returns null when the model was not
   * speaking or nothing was spoken yet.
   */
  takeExternalPartial(source: BargeInSource): PartialModelTurn | null {
    if (this.modelSpeechStartedAt === null) return null;
    const partial: PartialModelTurn = {
      text: this.interimModelText.slice(0, BARGE_IN_V2_MAX_PARTIAL_CHARS),
      cutAtMs: this.clock() - this.modelSpeechStartedAt,
      source,
      at: this.clock(),
    };
    this.partialTurns.push(partial);
    this.modelSpeechStartedAt = null;
    this.interimModelText = '';
    return { ...partial };
  }

  getResumePolicy(): BargeInResumePolicy {
    return this.resumePolicy;
  }

  getInterruptCount(): number {
    return this.interruptCount;
  }

  getIgnoredCounts(): Record<BargeInV2Reason, number> {
    return { ...this.ignored };
  }

  /** Cut-off replies kept so far (oldest first). */
  getPartialTurns(): PartialModelTurn[] {
    return this.partialTurns.map((p) => ({ ...p }));
  }

  getBargeInStats(): TurnTakingStats {
    return this.meter.stats();
  }

  getLastBargeIn(): BargeInMeasurement | null {
    return this.meter.last();
  }

  getBargeInMeasurements(): BargeInMeasurement[] {
    return this.meter.all();
  }

  /** The model started a reply (audio or transcript arrived). */
  modelSpeechStarted(now?: number): void {
    this.modelSpeechStartedAt = now ?? this.clock();
    this.interimModelText = '';
    this.interrupting = false;
    this.interruptReplyAgeMs = null;
  }

  /** Interim text of the reply in progress (feeds partial turns). */
  noteModelTranscript(text: string, isFinal: boolean): void {
    if (isFinal) {
      this.interimModelText = '';
      this.modelSpeechStartedAt = null;
      return;
    }
    this.interimModelText = String(text ?? '');
  }

  /** The model finished its reply cleanly (no interruption). */
  modelSpeechEnded(): void {
    this.modelSpeechStartedAt = null;
    this.interimModelText = '';
    this.interrupting = false;
  }

  /**
   * User speech was heard. Returns the decision; the caller only
   * cancels the response when `action` is `interrupt`. `speechMs`
   * is how long the user has been speaking so far (0 when unknown
   * — treated as long enough, the VAD already fired).
   */
  noteSpeech(
    source: BargeInSource,
    opts: { speechMs?: number; now?: number } = {},
  ): BargeInV2Decision {
    const now = opts.now ?? this.clock();
    const base: Omit<BargeInV2Decision, 'action' | 'reason'> = {
      source,
      speechAtMs: this.modelSpeechStartedAt === null ? null : now - this.modelSpeechStartedAt,
      resumePolicy: this.resumePolicy,
      at: now,
    };
    if (this.interrupting) {
      this.ignored['already-interrupting'] += 1;
      return { ...base, action: 'ignore', reason: 'already-interrupting' };
    }
    if (this.modelSpeechStartedAt === null) {
      this.ignored['not-speaking'] += 1;
      return { ...base, action: 'ignore', reason: 'not-speaking' };
    }
    const speechMs = opts.speechMs ?? Number.POSITIVE_INFINITY;
    if (speechMs < this.minSpeechMs) {
      this.ignored['too-short'] += 1;
      return { ...base, action: 'ignore', reason: 'too-short' };
    }
    if (now - this.modelSpeechStartedAt < this.graceMs) {
      this.ignored.grace += 1;
      return { ...base, action: 'ignore', reason: 'grace' };
    }
    this.interrupting = true;
    this.interruptCount += 1;
    this.interruptReplyAgeMs = now - this.modelSpeechStartedAt;
    this.meter.begin(source);
    return { ...base, action: 'interrupt', reason: 'ok' };
  }

  /**
   * The caller sent the cancel to the transport. Call right after
   * cancelling so the meter can time the cancel leg.
   */
  cancelSent(): void {
    this.meter.markCancelSent();
  }

  /** Playback was flushed (sink emptied / TTS stopped). */
  playbackFlushed(): void {
    this.meter.markFlushed();
  }

  /**
   * The session is listening again: finish the measurement, keep
   * the cut-off reply as a partial turn, and return both. Call even
   * when no barge-in was in flight (returns nulls then).
   */
  backToListening(): { measurement: BargeInMeasurement | null; partial: PartialModelTurn | null } {
    const measurement = this.meter.finish();
    let partial: PartialModelTurn | null = null;
    if (measurement) {
      partial = {
        text: this.interimModelText.slice(0, BARGE_IN_V2_MAX_PARTIAL_CHARS),
        cutAtMs: this.interruptReplyAgeMs ?? 0,
        source: measurement.source,
        at: this.clock(),
      };
      this.partialTurns.push(partial);
      partial = { ...partial };
    }
    this.modelSpeechStartedAt = null;
    this.interimModelText = '';
    this.interrupting = false;
    this.interruptReplyAgeMs = null;
    return { measurement, partial };
  }

  /** Take (and clear) the latest partial turn, if any. */
  takePartialTurn(): PartialModelTurn | null {
    const p = this.partialTurns.pop();
    return p ? { ...p } : null;
  }

  /** Reset all state (new call). Measurements are dropped too. */
  reset(): void {
    this.modelSpeechStartedAt = null;
    this.interimModelText = '';
    this.interrupting = false;
    this.interruptReplyAgeMs = null;
    this.partialTurns = [];
    this.interruptCount = 0;
    this.ignored = {
      ok: 0,
      'not-speaking': 0,
      grace: 0,
      'too-short': 0,
      'already-interrupting': 0,
    };
  }
}
