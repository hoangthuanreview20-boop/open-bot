/**
 * Voice session v2 (v1.02, Team T5 — realtime voice v2).
 *
 * Composition, not a rewrite: one `RealtimeSession` (v0.95, the
 * duplex call + its own server-VAD barge-in) plus the three v1.02
 * pieces around it:
 *
 *   - `LongVoiceSession` — the call's transcript, kept inside a
 *     character budget by auto-compaction (summaries + recent
 *     turns). Final model transcripts feed it automatically; user
 *     turns arrive via `noteUserTurn()` (local STT path) or
 *     `transcribeLocal()`.
 *   - `BargeInController` — the manual / local-VAD interrupt path
 *     with grace window + debounce + partial-turn keeping. The
 *     session's own server-VAD barge-in still runs inside the
 *     session; this wrapper only records its partial turn (via the
 *     `interrupted` event) so the two paths never double-cancel.
 *   - `VoiceMediaContext` — images/video attached to the call,
 *     described by a `MediaDescriber` (mock by default, vision-API
 *     when configured) and folded into the session instructions
 *     as a context block.
 *   - `LocalVoiceStack` (optional) — local STT/TTS for the call
 *     when no provider realtime endpoint is in use.
 *
 * Events: every `RealtimeSession` event is forwarded unchanged, plus
 * v2 kinds (`summary`, `media-attached`, `media-described`,
 * `media-answer`, `barge-in-v2`). The session instructions sent at
 * `connect()` are the caller's base instructions plus the live
 * context block (long-session summary + media block), so the model
 * hears the call history and sees the attached media from the first
 * turn. Media attached mid-call emits `media-attached` — the main
 * process can push the rebuilt instructions with a `session.update`
 * (this wrapper cannot, the session has no update-instructions API).
 */
import type {
  RealtimeConfig,
  RealtimeSessionEvent,
  RealtimeSessionState,
} from './types';
import { RealtimeSession, type RealtimeSessionOptions } from './realtimeSession';
import {
  LongVoiceSession,
  type LongVoiceSessionOptions,
} from './longSession';
import {
  BargeInController,
  type BargeInResumePolicy,
  type BargeInV2Decision,
} from './bargeInV2';
import type { BargeInSource } from './turnTaking';
import {
  VoiceMediaContext,
  type MediaAnswer,
  type MediaDescriber,
  type VoiceMediaInput,
  type VoiceMediaItem,
} from './mediaContext';
import type { LocalVoiceStack } from './localVoiceStack';
import type { VoiceTurn } from './longSession';

/** Extra events the v2 wrapper emits (on top of the session's). */
export type VoiceSessionV2Event =
  | RealtimeSessionEvent
  | {
      kind: 'summary';
      /** Summary text that replaced the oldest turns. */
      text: string;
      compactedTurns: number;
      at: number;
    }
  | { kind: 'media-attached'; item: VoiceMediaItem; at: number }
  | { kind: 'media-described'; item: VoiceMediaItem; at: number }
  | { kind: 'media-answer'; answer: MediaAnswer; at: number }
  | {
      kind: 'barge-in-v2';
      decision: BargeInV2Decision | null;
      /** Round-trip measurement when this wrapper decided the interrupt. */
      measurementMs: number | null;
      /** Text the model had spoken before being cut ('' when none). */
      partialText: string;
      at: number;
    };

export type VoiceSessionV2EventSink = (event: VoiceSessionV2Event) => void;

export interface VoiceSessionV2Options {
  /** Options for the inner `RealtimeSession` (provider, turn mode,
   *  transport factory, audio source/sink, ...). */
  session: RealtimeSessionOptions;
  /** Long-session options (budget, keep-window, summarizer). */
  longSession?: LongVoiceSessionOptions;
  /** Grace window (ms) before a barge-in counts. Default 800. */
  bargeInGraceMs?: number;
  /** Minimum speech length (ms) that counts as a barge-in. Default 150. */
  bargeInMinSpeechMs?: number;
  /** What happens to a cut-off reply. Default 'restart'. */
  bargeInResumePolicy?: BargeInResumePolicy;
  /** Media describer (mock by default — no network, no key). */
  mediaDescriber?: MediaDescriber;
  /** Max media items held in the session. Default 5. */
  maxMediaItems?: number;
  /** Local STT/TTS stack for the no-provider fallback path. */
  localStack?: LocalVoiceStack;
  /** Inject the clock (tests) — shared by the long session, the
   *  barge-in controller and the media context. Defaults to `Date.now`. */
  clock?: () => number;
  /** Event sink (session events + v2 events). */
  onEvent?: VoiceSessionV2EventSink;
}

export class VoiceSessionV2 {
  private readonly session: RealtimeSession;
  private readonly longSession: LongVoiceSession;
  private readonly bargeIn: BargeInController;
  private readonly media: VoiceMediaContext;
  private readonly localStack: LocalVoiceStack | undefined;
  private readonly onEvent: VoiceSessionV2EventSink | undefined;
  /** Base instructions passed at connect (before context blocks). */
  private baseInstructions = '';

  constructor(options: VoiceSessionV2Options) {
    this.localStack = options.localStack;
    this.longSession = new LongVoiceSession({
      ...options.longSession,
      clock: options.clock ?? options.longSession?.clock,
      onEvent: (e) => {
        if (e.kind === 'summary') {
          this.emit({ kind: 'summary', text: e.summary.text, compactedTurns: e.compactedTurns, at: e.at });
        }
      },
    });
    this.bargeIn = new BargeInController({
      graceMs: options.bargeInGraceMs,
      minSpeechMs: options.bargeInMinSpeechMs,
      resumePolicy: options.bargeInResumePolicy,
      clock: options.clock,
    });
    this.media = new VoiceMediaContext({
      describer: options.mediaDescriber,
      maxItems: options.maxMediaItems,
      clock: options.clock,
    });
    this.onEvent = options.onEvent;
    this.session = new RealtimeSession({
      ...options.session,
      onEvent: (e) => this.handleSessionEvent(e),
    });
  }

  // -- passthroughs -------------------------------------------------------

  getState(): RealtimeSessionState {
    return this.session.getState();
  }

  isConnected(): boolean {
    return this.session.isConnected();
  }

  getSessionId(): string {
    return this.session.getSessionId();
  }

  getTurnCount(): number {
    return this.session.getTurnCount();
  }

  /**
   * Barge-ins handled in this call. The inner session owns the
   * count: a v2-decided interrupt flows through
   * `session.interrupt()`, so it is already included — adding the
   * controller's count on top would double-count it. (A v2
   * decision whose cancel never landed because the model had
   * already stopped is visible in `getBargeInV2Stats().count`
   * instead.)
   */
  getBargeInCount(): number {
    return this.session.getBargeInCount();
  }

  sendAudio(frame: Uint8Array): void {
    this.session.sendAudio(frame);
  }

  pushAudioFrame(frame: Uint8Array): void {
    this.session.pushAudioFrame(frame);
  }

  commitAudio(): void {
    this.session.commitAudio();
  }

  requestResponse(): void {
    this.session.requestResponse();
  }

  sendToolResult(callId: string, output: string): void {
    this.session.sendToolResult(callId, output);
  }

  startTalk(): boolean {
    return this.session.startTalk();
  }

  endTalk(): boolean {
    return this.session.endTalk();
  }

  setTurnMode(mode: Parameters<RealtimeSession['setTurnMode']>[0]): void {
    this.session.setTurnMode(mode);
  }

  getLatencyStats(): ReturnType<RealtimeSession['getLatencyStats']> {
    return this.session.getLatencyStats();
  }

  getHealth(): ReturnType<RealtimeSession['getHealth']> {
    return this.session.getHealth();
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * Open the call. The instructions sent are the caller's base
   * instructions plus the live context block (long-session summary
   * + attached-media block), so the model starts with the history.
   */
  async connect(config: RealtimeConfig): Promise<void> {
    this.baseInstructions = config.instructions ?? '';
    await this.session.connect({
      ...config,
      instructions: this.getSessionInstructions(),
    });
  }

  /** Hang up: session + local speech die together. */
  disconnect(): void {
    try {
      void this.localStack?.stopSpeaking();
    } catch {
      // Best-effort — the session is ending either way.
    }
    this.bargeIn.modelSpeechEnded();
    this.session.disconnect();
  }

  dispose(): void {
    this.disconnect();
    this.session.dispose();
  }

  // -- long session ---------------------------------------------------------

  /** Live turns + summaries, as the model would see them. */
  getContextBlock(): string {
    const parts = [this.longSession.getContextBlock(), this.media.buildMediaContextBlock()]
      .filter((p) => p.length > 0);
    return parts.join('\n\n');
  }

  /** Full instructions for (re)connect: base + context block. */
  getSessionInstructions(): string {
    const block = this.getContextBlock();
    if (!block) return this.baseInstructions;
    return this.baseInstructions
      ? `${this.baseInstructions}\n\n${block}`
      : block;
  }

  getLongSessionStats(): ReturnType<LongVoiceSession['getStats']> {
    return this.longSession.getStats();
  }

  getLongSessionTurns(): VoiceTurn[] {
    return this.longSession.getTurns();
  }

  /** JSON snapshot of the long session (turns + summaries). */
  snapshotLongSession(): ReturnType<LongVoiceSession['snapshot']> {
    return this.longSession.snapshot();
  }

  restoreLongSession(value: unknown): boolean {
    return this.longSession.restore(value);
  }

  /**
   * Record a final user turn (from local STT or provider input
   * transcription). Media attached since the last turn can be
   * linked by passing their ids.
   */
  noteUserTurn(text: string, mediaIds?: string[]): VoiceTurn | null {
    const turn = this.longSession.addTurn('user', text, mediaIds ? { mediaIds } : {});
    if (turn) this.session.recordUserTranscript(text);
    return turn;
  }

  /** Transcribe with the local stack, then record the user turn. */
  async transcribeLocal(pcm16: Uint8Array): Promise<string> {
    if (!this.localStack) {
      throw new Error('VoiceSessionV2: no local voice stack configured.');
    }
    const text = await this.localStack.transcribe(pcm16);
    if (text.trim()) this.noteUserTurn(text);
    return text;
  }

  /** Speak text through the local TTS stack (no-provider path). */
  speakLocal(text: string): number {
    if (!this.localStack) return 0;
    return this.localStack.speak(text);
  }

  // -- barge-in v2 ----------------------------------------------------------

  /**
   * User speech was heard on the local / manual path. When the
   * controller decides to interrupt, the session is interrupted
   * (cancel + flush) and the cut-off reply is kept as a partial
   * turn. Returns the decision — `ignore` means the session was
   * left alone (grace window, blip, or the model not speaking).
   */
  noteUserSpeech(
    source: BargeInSource,
    opts: { speechMs?: number } = {},
  ): BargeInV2Decision {
    const decision = this.bargeIn.noteSpeech(source, opts);
    if (decision.action === 'interrupt') {
      // The cancel goes out inside session.interrupt() (which emits
      // 'interrupted' synchronously); mark it sent first so the
      // meter's cancel leg is timed, not left blank.
      this.bargeIn.cancelSent();
      const interrupted = this.session.interrupt();
      if (!interrupted) {
        // The model stopped between the decision and the cancel:
        // finish the dangling measurement so the meter stays clean.
        this.bargeIn.backToListening();
      } else {
        // The session emits 'interrupted' synchronously inside
        // interrupt(), and the handler below finishes the meter.
        try {
          void this.localStack?.stopSpeaking();
        } catch {
          // Local TTS stop is best-effort.
        }
      }
    }
    return decision;
  }

  /** UI interrupt button: same path as local speech, source manual. */
  interrupt(): BargeInV2Decision {
    return this.noteUserSpeech('manual');
  }

  getBargeInV2Stats(): ReturnType<BargeInController['getBargeInStats']> {
    return this.bargeIn.getBargeInStats();
  }

  getBargeInV2Ignored(): Record<string, number> {
    return this.bargeIn.getIgnoredCounts();
  }

  getPartialTurns(): ReturnType<BargeInController['getPartialTurns']> {
    return this.bargeIn.getPartialTurns();
  }

  // -- media ----------------------------------------------------------------

  /** Attach media to the call (validated; see mediaContext). */
  attachMedia(input: VoiceMediaInput): ReturnType<VoiceMediaContext['attach']> {
    const result = this.media.attach(input);
    if (result.ok) {
      this.emit({ kind: 'media-attached', item: { ...result.item }, at: Date.now() });
    }
    return result;
  }

  removeMedia(id: string): boolean {
    return this.media.remove(id);
  }

  listMedia(): VoiceMediaItem[] {
    return this.media.list();
  }

  getMediaContextBlock(): string {
    return this.media.buildMediaContextBlock();
  }

  getMediaDescriberName(): string {
    return this.media.getDescriberName();
  }

  /** Describe one attached item (or all pending ones). */
  async describeMedia(id?: string): Promise<void> {
    const before = new Map(this.media.list().map((i) => [i.id, i.status]));
    await this.media.describe(id);
    for (const item of this.media.list()) {
      if (item.status === 'described' && before.get(item.id) !== 'described') {
        this.emit({ kind: 'media-described', item: { ...item }, at: Date.now() });
      }
    }
  }

  /**
   * Ask a question about attached media. The question is recorded
   * as a user turn and the answer as a model turn, so the long
   * session keeps the exchange.
   */
  async askAboutMedia(question: string, itemId?: string): Promise<MediaAnswer | null> {
    const answer = await this.media.askAboutMedia(question, itemId);
    if (!answer) return null;
    this.noteUserTurn(question, [answer.itemId]);
    this.longSession.addTurn('model', answer.answer, { mediaIds: [answer.itemId] });
    this.emit({ kind: 'media-answer', answer: { ...answer }, at: answer.at });
    return { ...answer };
  }

  // -- internals ------------------------------------------------------------

  private handleSessionEvent(event: RealtimeSessionEvent): void {
    switch (event.kind) {
      case 'audio': {
        // First audio chunk of a reply starts the controller's
        // grace window (controller clock — injectable in tests);
        // later chunks must not reset it.
        if (!this.bargeIn.isModelSpeaking()) this.bargeIn.modelSpeechStarted();
        break;
      }
      case 'transcript': {
        this.bargeIn.noteModelTranscript(event.text, event.isFinal);
        if (event.isFinal && event.text.trim()) {
          this.longSession.addTurn('model', event.text);
        }
        break;
      }
      case 'turn': {
        if (event.speaker === 'model') this.bargeIn.modelSpeechEnded();
        break;
      }
      case 'interrupted': {
        // The session cut the reply (its own server/local VAD path,
        // or this wrapper's noteUserSpeech above — both arrive here
        // synchronously). Finish the controller's measurement when
        // it decided the interrupt; otherwise keep the partial
        // from the text spoken so far.
        let partialText = '';
        let measurementMs: number | null = null;
        if (this.bargeIn.isInterrupting()) {
          this.bargeIn.playbackFlushed();
          const done = this.bargeIn.backToListening();
          measurementMs = done.measurement ? done.measurement.totalMs : null;
          partialText = done.partial ? done.partial.text : '';
        } else {
          const partial = this.bargeIn.takeExternalPartial(event.source);
          partialText = partial ? partial.text : '';
        }
        if (partialText) {
          this.longSession.addTurn('model', partialText, { interrupted: true, partial: true });
        }
        // Forward the v2 event AFTER the session's own event, so a
        // listener sees 'interrupted' first, then the decision.
        this.emit(event);
        this.emit({
          kind: 'barge-in-v2',
          decision: null,
          measurementMs,
          partialText,
          at: event.at,
        });
        return;
      }
      default:
        break;
    }
    this.emit(event);
  }

  private emit(event: VoiceSessionV2Event): void {
    try {
      this.onEvent?.(event);
    } catch {
      // A throwing sink must not break the call.
    }
  }
}
