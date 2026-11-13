/**
 * RealtimeSession — one duplex realtime voice conversation (v0.95,
 * Đội D3).
 *
 * The layer above a `RealtimeTransport` (voice/adapters.ts) that owns
 * everything provider-independent:
 *
 *   - Conversation state machine:
 *       idle -> connecting -> listening <-> speaking -> closed
 *       (with `interrupted` as a momentary state on barge-in and
 *       `reconnecting` while a dropped transport is redialled).
 *   - Audio duplex: mic frames in (via an `AudioSource` or pushed
 *     with `pushAudioFrame()`), model audio out (via an `AudioSink`
 *     and/or `audio` events). Mic audio is chunked into 100 ms
 *     frames and resampled to the transport's input rate (16 kHz
 *     mic -> 24 kHz for OpenAI, 16 kHz passthrough for Gemini).
 *   - Barge-in: while the model is speaking, user speech — heard by
 *     the server VAD (`speech_started`) or by the local VAD
 *     (`local_vad` mode) — cancels the response
 *     (`response.cancel` / Gemini `activityStart`), flushes the
 *     playback queue, and returns to `listening`. A manual
 *     `interrupt()` does the same from the UI.
 *   - Turn-taking: `server_vad` (default — the server commits on
 *     silence), `local_vad` (the local energy VAD ends the turn:
 *     commit + request response), `push_to_talk` (audio is only
 *     sent while the talk button is held; releasing commits).
 *   - Reconnect: for transports that do not reconnect themselves
 *     (Gemini), the session redials with backoff (default 5
 *     attempts, 1 s doubling to 10 s). OpenAI's transport
 *     reconnects itself (RealtimeClient's 20-attempt redial); the
 *     session only mirrors its state.
 *   - Events: every transcript / audio / state / interruption /
 *     turn / tool-call is emitted to `onEvent` (the main process
 *     forwards these to the renderer and the event log — the same
 *     sink shape the voice call already uses).
 *
 * The session also implements the `VoiceRealtimeClient` interface
 * (voice/session.ts), so a `VoiceCallSession` can be driven by a
 * `RealtimeSession` instead of a raw `RealtimeClient` — the call
 * wiring does not need to know which one it has.
 *
 * Mock-first: every external end (transport, source, sink) is
 * injectable, so tests drive the whole state machine with fake
 * WebSockets and scripted mic audio — no network, no sound card.
 *
 * v0.96 (Đội T5 — voice live): the session now (a) resolves the
 * provider key at connect time through `options.keyResolver` (a
 * Vault closure from main — no key, the transport throws
 * MissingRealtimeKeyError and the caller falls back to mock);
 * (b) persists the transcript + counters to disk through
 * `options.sessionStore` and resumes them on reconnect (transcript
 * only — never the socket); (c) stops the local TTS queue on
 * barge-in (`options.ttsQueue`), so the local voice dies with the
 * response; (d) exposes `getLatencyStats()` / `getHealth()` from
 * the transport for the per-adapter UI.
 */
import type {
  AudioEvent,
  RealtimeConfig,
  RealtimeProvider,
  RealtimeSessionEvent,
  RealtimeSessionEventSink,
  RealtimeSessionState,
  RealtimeState,
  RealtimeToolCall,
  TranscriptEvent,
  TurnTakingMode,
} from './types';
import {
  GEMINI_LIVE_INPUT_SAMPLE_RATE_HZ,
  OPENAI_REALTIME_INPUT_SAMPLE_RATE_HZ,
  REALTIME_FRAME_BYTES_16K,
  REALTIME_MIC_SAMPLE_RATE_HZ,
} from './types';
import type { AudioSink, AudioSource } from './audio';
import { isValidPcm16Frame, LocalVad, Pcm16Chunker, resamplePcm16 } from './audio';
import type { RealtimeTransport, RealtimeTransportCallbacks, RealtimeTransportConfig } from './adapters';
import { createRealtimeTransport } from './adapters';
import { RealtimeClient } from './realtime';
import type { LatencySummary, TransportHealth } from './transportHealth';
import type { TtsQueue } from './ttsQueue';
import {
  buildVoiceTranscriptEntry,
  createVoiceSessionRecord,
  newVoiceSessionId,
  type VoiceSessionRecord,
  type VoiceSessionStore,
  type VoiceTranscriptEntry,
} from './voicePersistence';

/** Default session-level reconnect attempts (Gemini transport). */
export const REALTIME_SESSION_DEFAULT_MAX_RECONNECTS = 5;
/** Default base reconnect delay (ms); doubled per attempt. */
export const REALTIME_SESSION_DEFAULT_RECONNECT_DELAY_MS = 1_000;
/** Default reconnect backoff cap (ms). */
export const REALTIME_SESSION_DEFAULT_RECONNECT_MAX_DELAY_MS = 10_000;

export type RealtimeTransportFactory = (
  callbacks: RealtimeTransportCallbacks,
) => RealtimeTransport;

export interface RealtimeSessionOptions {
  provider: RealtimeProvider;
  /** Turn-taking mode. Default 'server_vad'. */
  turnMode?: TurnTakingMode;
  /** Inject the transport (tests). Defaults to `createRealtimeTransport`. */
  transportFactory?: RealtimeTransportFactory;
  /** Mic source; when absent, the caller pushes frames itself. */
  audioSource?: AudioSource | null;
  /** Speaker sink; when absent, audio only leaves as events. */
  audioSink?: AudioSink | null;
  /** Local VAD speech threshold (RMS 0..1). Default 0.02. */
  vadThreshold?: number;
  /** Local VAD hangover (ms). Default 300. */
  vadHangoverMs?: number;
  /** Max session-level reconnects (Gemini only). Default 5. */
  maxReconnectAttempts?: number;
  /** Base reconnect delay (ms). Default 1000. */
  reconnectDelayMs?: number;
  /** Reconnect backoff cap (ms). Default 10000. */
  reconnectMaxDelayMs?: number;
  /**
   * Local TTS hook (voice/tts.ts `TtsHarness.speak`): when set, the
   * final transcript of each model turn is also spoken locally.
   * OFF by default — providers that stream audio already speak, and
   * speaking the transcript as well would double the voice. Meant
   * for text-only transports / local fallback modes.
   */
  speakFinalTranscript?: (text: string) => void | Promise<void>;
  /**
   * Local TTS queue (v0.96, voice/ttsQueue.ts): when set, the final
   * transcript of each model turn is enqueued sentence by sentence
   * instead of `speakFinalTranscript`, and a barge-in stops the
   * queue as well as the transport response. Takes precedence over
   * `speakFinalTranscript` when both are set.
   */
  ttsQueue?: TtsQueue;
  /**
   * Resolve the provider key from the app Vault at connect time
   * (v0.96 — a closure over the keyStore / media keys in main).
   * Passed through to the transport; without a key the transport
   * throws MissingRealtimeKeyError and the caller falls back to
   * mock. Never a key value itself.
   */
  keyResolver?: () => string | null;
  /**
   * Persist the session transcript + counters to disk (v0.96,
   * voice/voicePersistence.ts). When set, the session saves on
   * every final transcript and on disconnect; `persistSessionId`
   * resumes an earlier session's transcript (socket NOT restored).
   */
  sessionStore?: VoiceSessionStore;
  /** Session id to resume / save as. Default: a fresh id. */
  persistSessionId?: string;
  /** Bot this session belongs to (stored with the record). */
  botId?: string;
  /** Sink for session events. Never throws into the session. */
  onEvent?: RealtimeSessionEventSink;
}

export class RealtimeSession {
  private readonly provider: RealtimeProvider;
  private turnMode: TurnTakingMode;
  private readonly transportFactory: RealtimeTransportFactory;
  private readonly audioSource: AudioSource | null;
  private readonly audioSink: AudioSink | null;
  private readonly vad: LocalVad;
  private readonly chunker: Pcm16Chunker;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly speakFinalTranscript:
    | ((text: string) => void | Promise<void>)
    | undefined;
  private readonly ttsQueue: TtsQueue | undefined;
  private readonly keyResolver: (() => string | null) | undefined;
  private readonly sessionStore: VoiceSessionStore | undefined;
  private readonly botId: string | undefined;
  private onEvent: RealtimeSessionEventSink | undefined;
  /** Id of the persisted session (fresh or resumed). */
  private sessionId: string;
  /** Persisted record for this session (null when no store). */
  private persistedRecord: VoiceSessionRecord | null = null;
  /** Transcript lines (restored + live), for the UI + persistence. */
  private transcriptLines: VoiceTranscriptEntry[] = [];
  private transcriptSeq = 0;

  private transport: RealtimeTransport | null = null;
  private config: RealtimeTransportConfig | null = null;
  private state: RealtimeSessionState = 'idle';
  private closedIntentionally = false;
  private disposed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while the talk button is held (push_to_talk mode). */
  private talkHeld = false;
  /** Barge-ins handled in this session (for the UI counter). */
  private bargeInCount = 0;
  /** Completed turns (user + model) in this session. */
  private turnCount = 0;
  /** True while the model is mid-response (audio or transcript). */
  private modelResponding = false;
  /** Mic frames seen since connect (diagnostics). */
  private micFrames = 0;

  constructor(options: RealtimeSessionOptions) {
    this.provider = options.provider;
    this.turnMode = options.turnMode ?? 'server_vad';
    this.transportFactory =
      options.transportFactory ?? ((cb) => createRealtimeTransport(options.provider, cb));
    this.audioSource = options.audioSource ?? null;
    this.audioSink = options.audioSink ?? null;
    this.maxReconnectAttempts =
      options.maxReconnectAttempts ?? REALTIME_SESSION_DEFAULT_MAX_RECONNECTS;
    this.reconnectDelayMs =
      options.reconnectDelayMs ?? REALTIME_SESSION_DEFAULT_RECONNECT_DELAY_MS;
    this.reconnectMaxDelayMs =
      options.reconnectMaxDelayMs ?? REALTIME_SESSION_DEFAULT_RECONNECT_MAX_DELAY_MS;
    this.speakFinalTranscript = options.speakFinalTranscript;
    this.ttsQueue = options.ttsQueue;
    this.keyResolver = options.keyResolver;
    this.sessionStore = options.sessionStore;
    this.botId = options.botId;
    this.sessionId = options.persistSessionId ?? newVoiceSessionId();
    this.onEvent = options.onEvent;
    this.vad = new LocalVad({
      threshold: options.vadThreshold,
      hangoverMs: options.vadHangoverMs,
      callbacks: {
        onSpeechStart: () => this.handleLocalSpeechStart(),
        onSpeechEnd: () => this.handleLocalSpeechEnd(),
      },
    });
    this.chunker = new Pcm16Chunker(REALTIME_FRAME_BYTES_16K);
  }

  // -- state --------------------------------------------------------------

  getState(): RealtimeSessionState {
    return this.state;
  }

  isConnected(): boolean {
    return this.transport?.isConnected() ?? false;
  }

  getTurnMode(): TurnTakingMode {
    return this.turnMode;
  }

  /** Switch turn-taking mode mid-session (applies to the next turn;
   *  the server-VAD flag is only sent at connect for OpenAI). */
  setTurnMode(mode: TurnTakingMode): void {
    if (mode !== 'server_vad' && mode !== 'local_vad' && mode !== 'push_to_talk') {
      throw new Error(`RealtimeSession: unknown turn mode ${JSON.stringify(mode)}.`);
    }
    this.turnMode = mode;
    this.talkHeld = false;
  }

  getBargeInCount(): number {
    return this.bargeInCount;
  }

  getTurnCount(): number {
    return this.turnCount;
  }

  /** Current mic level (RMS 0..1) for the UI meter. */
  getMicLevel(): number {
    return this.vad.level;
  }

  getMicFrames(): number {
    return this.micFrames;
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  /** Id of the persisted session (fresh or resumed). */
  getSessionId(): string {
    return this.sessionId;
  }

  /** Transcript lines so far (restored + live), oldest first. */
  getTranscriptLines(): VoiceTranscriptEntry[] {
    return this.transcriptLines.map((l) => ({ ...l }));
  }

  /** Latency summaries from the transport ('' when none / no transport). */
  getLatencyStats(): LatencySummary[] {
    try {
      return this.transport?.getLatencyStats?.() ?? [];
    } catch {
      return [];
    }
  }

  /** Health snapshot from the transport (null when no transport). */
  getHealth(): TransportHealth | null {
    try {
      return this.transport?.getHealth?.() ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Record one final user transcript line (from the local STT
   * pipeline or the provider's input transcription). Persisted
   * with the session and visible via `getTranscriptLines()`.
   */
  recordUserTranscript(text: string): void {
    const clean = String(text ?? '').trim();
    if (!clean) return;
    this.appendTranscriptLine('user', clean);
  }

  // -- lifecycle ----------------------------------------------------------

  /**
   * Open the session. Resolves when the transport is connected (for
   * Gemini: after `setupComplete`). The mic source, when attached,
   * starts producing frames. Connecting twice while connected is a
   * no-op success.
   */
  async connect(config: RealtimeConfig): Promise<void> {
    if (this.disposed) {
      throw new Error('RealtimeSession: session is disposed.');
    }
    if (this.transport?.isConnected()) return;
    const fullConfig: RealtimeTransportConfig = {
      ...config,
      provider: this.provider,
      turnMode: this.turnMode,
      keyResolver: this.keyResolver,
      // OpenAI: local_vad / push_to_talk need manual turns, so the
      // server VAD must be off; Gemini ignores this field.
      ...(this.provider !== 'gemini'
        ? { turnDetection: this.turnMode === 'server_vad' ? 'server_vad' : 'none' }
        : {}),
    };
    this.config = fullConfig;
    this.closedIntentionally = false;
    this.reconnectAttempts = 0;
    this.setState('connecting');
    const transport = this.transportFactory(this.buildCallbacks());
    this.transport = transport;
    try {
      await transport.connect(fullConfig);
    } catch (err) {
      this.transport = null;
      this.setState('idle');
      throw err;
    }
    this.restorePersistedSession();
    this.setState('listening');
    this.audioSource?.start((frame) => this.pushAudioFrame(frame));
  }

  /** Hang up. Idempotent; stops reconnects and the mic source. */
  disconnect(): void {
    this.closedIntentionally = true;
    this.clearReconnectTimer();
    this.audioSource?.stop();
    this.chunker.flush();
    this.vad.reset();
    if (this.transport) {
      try {
        this.transport.disconnect();
      } catch {
        // Socket already gone.
      }
      this.transport = null;
    }
    // The TTS queue dies with the session (barge-in path: stop the
    // local voice too, so it does not keep talking after hangup).
    try {
      void this.ttsQueue?.stop();
    } catch {
      // Best-effort — the session is ending either way.
    }
    this.setState('closed');
    this.savePersistedSession('closed');
  }

  /** Drop the whole session (used when the bot is deleted). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disconnect();
    this.onEvent = undefined;
  }

  // -- VoiceRealtimeClient surface (so VoiceCallSession can use this) ---

  /** Send one PCM16 mic frame (16 kHz mono). Validated; the frame
   *  is VAD-scanned, chunked to 100 ms, resampled to the transport
   *  rate and forwarded — unless push_to_talk is on and the talk
   *  button is not held, in which case it is dropped. Throws when
   *  not connected or on an invalid frame. */
  sendAudio(frame: Uint8Array): void {
    this.pushAudioFrame(frame);
  }

  /** Push one mic frame into the session (same as `sendAudio`). */
  pushAudioFrame(frame: Uint8Array): void {
    if (!isValidPcm16Frame(frame)) {
      throw new Error(
        'RealtimeSession: audio frame must be a non-empty even-length PCM16 buffer.',
      );
    }
    if (!this.transport?.isConnected()) {
      throw new Error('RealtimeSession: not connected — call connect() first.');
    }
    this.micFrames += 1;
    this.vad.feed(frame);
    if (this.turnMode === 'push_to_talk' && !this.talkHeld) return;
    for (const chunk of this.chunker.push(frame)) {
      this.sendTransportAudio(chunk);
    }
  }

  /** End the current utterance: flush the partial frame, commit the
   *  buffer and ask the model to respond. Throws when not connected. */
  commitAudio(): void {
    if (!this.transport?.isConnected()) {
      throw new Error('RealtimeSession: not connected — call connect() first.');
    }
    const left = this.chunker.flush();
    if (left.length > 0) this.sendTransportAudio(left);
    this.commitTurn();
  }

  /** Ask the model to respond (OpenAI only; a no-op for Gemini). */
  requestResponse(): void {
    if (!this.transport?.isConnected()) {
      throw new Error('RealtimeSession: not connected — call connect() first.');
    }
    this.transport.requestResponse();
  }

  /** Answer one function call the model made. Throws when not connected. */
  sendToolResult(callId: string, output: string): void {
    if (!this.transport?.isConnected()) {
      throw new Error('RealtimeSession: not connected — call connect() first.');
    }
    this.transport.sendToolResult(callId, output);
  }

  // -- turn-taking ----------------------------------------------------------

  /**
   * Hold the talk button (push_to_talk mode). Returns false when the
   * session is not in push_to_talk mode or not connected.
   */
  startTalk(): boolean {
    if (this.turnMode !== 'push_to_talk' || !this.transport?.isConnected()) return false;
    this.talkHeld = true;
    return true;
  }

  /**
   * Release the talk button: the turn is committed (flush + commit
   * + request response). Returns false when the session is not in
   * push_to_talk mode or not connected.
   */
  endTalk(): boolean {
    if (this.turnMode !== 'push_to_talk' || !this.transport?.isConnected()) return false;
    this.talkHeld = false;
    this.commitTurn();
    return true;
  }

  /**
   * Interrupt the model now (UI interrupt button). Cancels the
   * response, flushes playback and returns to listening. Returns
   * false when the model was not speaking.
   */
  interrupt(): boolean {
    return this.bargeIn('manual');
  }

  // -- internals ----------------------------------------------------------

  private buildCallbacks(): RealtimeTransportCallbacks {
    return {
      onTranscript: (e: TranscriptEvent) => {
        this.emit({ kind: 'transcript', text: e.text, isFinal: e.isFinal, at: Date.now() });
        if (e.isFinal) {
          this.appendTranscriptLine('model', e.text);
          if (this.ttsQueue) {
            // Sentence-by-sentence local voice (barge-in can cut it
            // mid-reply); never throws into the session.
            try {
              this.ttsQueue.enqueue(e.text);
            } catch {
              // TTS is best-effort; a failed enqueue must not break the call.
            }
          } else if (this.speakFinalTranscript) {
            try {
              const r = this.speakFinalTranscript(e.text);
              if (r instanceof Promise) r.catch(() => undefined);
            } catch {
              // TTS is best-effort; a failed speak must not break the call.
            }
          }
        }
      },
      onAudio: (e: AudioEvent) => {
        this.modelResponding = true;
        this.setState('speaking');
        if (this.audioSink) {
          try {
            this.audioSink.play(e.audio);
          } catch {
            // A broken sink must not break the call.
          }
        }
        this.emit({
          kind: 'audio',
          audioBase64: Buffer.from(e.audio).toString('base64'),
          sampleRateHz: this.transport?.outputSampleRateHz ?? 24_000,
          at: Date.now(),
        });
      },
      onToolCall: (call: RealtimeToolCall) => {
        this.emit({ kind: 'toolcall', call, at: Date.now() });
      },
      onError: (err: Error) => {
        this.emit({ kind: 'error', message: err.message, at: Date.now() });
      },
      onStateChange: (state: RealtimeState) => {
        this.handleTransportState(state);
      },
      onSpeechStarted: () => {
        // Server VAD heard the user. While the model speaks this is
        // a barge-in; while listening it just marks the user's turn.
        if (this.modelResponding || this.state === 'speaking') {
          this.bargeIn('server_vad');
        }
      },
      onSpeechStopped: () => {
        // Server VAD heard the user stop; with server_vad the server
        // auto-creates the response — nothing to do here.
      },
      onResponseDone: () => {
        this.endModelTurn();
      },
      onInterrupted: () => {
        // Gemini server-side interruption.
        if (this.modelResponding || this.state === 'speaking') {
          this.bargeIn('server_vad');
        }
      },
    };
  }

  private handleTransportState(state: RealtimeState): void {
    switch (state) {
      case 'connected':
        this.reconnectAttempts = 0;
        if (this.state === 'connecting' || this.state === 'reconnecting') {
          this.setState('listening');
        }
        break;
      case 'connecting':
        if (this.state === 'idle') this.setState('connecting');
        break;
      case 'reconnecting':
        this.setState('reconnecting');
        break;
      case 'closed':
        if (this.closedIntentionally || this.disposed) {
          this.setState('closed');
          return;
        }
        // Unexpected drop.
        if (this.transport?.handlesReconnect) {
          // The transport redials itself and only reports 'closed'
          // when its own budget is spent (or the close was
          // terminal) — so a 'closed' here means it gave up.
          this.setState('closed');
          return;
        }
        this.scheduleReconnect();
        break;
      case 'idle':
        if (!this.closedIntentionally) this.setState('idle');
        break;
    }
  }

  private scheduleReconnect(): void {
    if (this.closedIntentionally || this.disposed || !this.config) {
      this.setState('closed');
      return;
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.setState('closed');
      this.emit({
        kind: 'error',
        message: `RealtimeSession: connection lost, gave up after ${this.maxReconnectAttempts} reconnect attempt(s).`,
        at: Date.now(),
      });
      return;
    }
    if (this.reconnectTimer !== null) return;
    this.reconnectAttempts += 1;
    const delay = RealtimeClient.redialDelayMs(
      this.reconnectAttempts,
      this.reconnectDelayMs,
      this.reconnectMaxDelayMs,
    );
    this.setState('reconnecting');
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedIntentionally || this.disposed) return;
      this.setState('connecting');
      const transport = this.transportFactory(this.buildCallbacks());
      this.transport = transport;
      transport.connect(this.config as RealtimeTransportConfig).then(
        () => {
          this.reconnectAttempts = 0;
          this.setState('listening');
          this.audioSource?.start((frame) => this.pushAudioFrame(frame));
        },
        () => {
          // The transport reports via onError/onStateChange; a
          // failed reconnect attempt ends closed -> schedule again
          // until the budget is spent.
          if (!this.closedIntentionally && !this.disposed) {
            this.scheduleReconnect();
          }
        },
      );
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Barge-in: cancel the model's response, flush playback, return to
   * listening. Returns false when the model was not speaking (nothing
   * to interrupt).
   */
  private bargeIn(source: 'server_vad' | 'local_vad' | 'manual'): boolean {
    if (!this.modelResponding && this.state !== 'speaking') return false;
    this.modelResponding = false;
    this.bargeInCount += 1;
    try {
      this.transport?.cancelResponse();
    } catch {
      // The transport may already be gone; the local flush still runs.
    }
    try {
      this.audioSink?.clear();
    } catch {
      // A broken sink must not break the call.
    }
    // v0.96: the local TTS queue dies with the response — the user
    // interrupted the voice, so the voice stops now (<200 ms
    // budget, measured by the queue), not at the next sentence.
    try {
      void this.ttsQueue?.stop();
    } catch {
      // Best-effort — the transport cancel already ran.
    }
    this.setState('interrupted');
    this.emit({ kind: 'interrupted', source, at: Date.now() });
    this.setState('listening');
    return true;
  }

  private endModelTurn(): void {
    if (!this.modelResponding && this.state !== 'speaking') return;
    this.modelResponding = false;
    this.turnCount += 1;
    this.emit({ kind: 'turn', speaker: 'model', at: Date.now() });
    if (this.state === 'speaking') this.setState('listening');
  }

  private commitTurn(): void {
    if (!this.transport?.isConnected()) return;
    try {
      this.transport.commitAudio();
    } catch {
      return;
    }
    // OpenAI manual turns need an explicit response request; Gemini
    // responds on activityEnd / VAD and ignores requestResponse.
    if (this.provider !== 'gemini') {
      try {
        this.transport.requestResponse();
      } catch {
        // Already gone — nothing to do.
      }
    }
    this.turnCount += 1;
    this.emit({ kind: 'turn', speaker: 'user', at: Date.now() });
  }

  private handleLocalSpeechStart(): void {
    // Local VAD heard the user start. While the model speaks this is
    // a barge-in (local_vad mode only — in server_vad mode the
    // server's own speech_started event owns barge-in, so the local
    // detector stays silent to avoid double-cancelling).
    if (this.turnMode === 'local_vad' && (this.modelResponding || this.state === 'speaking')) {
      this.bargeIn('local_vad');
    }
  }

  private handleLocalSpeechEnd(): void {
    // Local VAD heard the user stop. In local_vad mode that ends the
    // turn: commit + ask the model to respond. In push_to_talk mode
    // the button release owns the commit; in server_vad mode the
    // server owns it.
    if (this.turnMode !== 'local_vad') return;
    if (!this.transport?.isConnected()) return;
    if (this.modelResponding || this.state === 'speaking') return;
    const left = this.chunker.flush();
    if (left.length > 0) this.sendTransportAudio(left);
    this.commitTurn();
  }

  private sendTransportAudio(frame: Uint8Array): void {
    const transport = this.transport;
    if (!transport?.isConnected()) return;
    const rate = transport.inputSampleRateHz;
    const out =
      rate === REALTIME_MIC_SAMPLE_RATE_HZ ? frame : resamplePcm16(frame, REALTIME_MIC_SAMPLE_RATE_HZ, rate);
    try {
      transport.sendAudio(out);
    } catch {
      // A failed send must not break the session; the transport
      // reports the drop via onError/onStateChange.
    }
  }

  private setState(state: RealtimeSessionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit({ kind: 'state', state, at: Date.now() });
  }

  /**
   * Append one final transcript line (in memory + on disk when a
   * store is set). Never throws — persistence must not break a
   * live call.
   */
  private appendTranscriptLine(speaker: 'user' | 'model', text: string): void {
    const clean = String(text ?? '').trim();
    if (!clean) return;
    this.transcriptSeq += 1;
    const entry = buildVoiceTranscriptEntry(this.sessionId, this.transcriptSeq, speaker, clean);
    this.transcriptLines.push(entry);
    if (!this.sessionStore) return;
    try {
      if (!this.persistedRecord) {
        this.persistedRecord = createVoiceSessionRecord({
          sessionId: this.sessionId,
          provider: this.provider,
          turnMode: this.turnMode,
          botId: this.botId,
        });
      }
      this.persistedRecord.transcript.push(entry);
      this.persistedRecord.bargeInCount = this.bargeInCount;
      this.persistedRecord.turnCount = this.turnCount;
      this.persistedRecord.state = this.state;
      this.sessionStore.save(this.persistedRecord);
    } catch {
      // Disk failures degrade silently — the call keeps running.
    }
  }

  /**
   * Restore a persisted session after connect (v0.96): the
   * transcript + counters come back, the socket does not. A fresh
   * id starts an empty record instead.
   */
  private restorePersistedSession(): void {
    if (!this.sessionStore) return;
    try {
      const resumed = this.sessionStore.resume(this.sessionId);
      if (resumed) {
        this.persistedRecord = resumed;
        this.transcriptLines = resumed.transcript.map((l) => ({ ...l }));
        this.transcriptSeq = resumed.transcript.length;
        this.bargeInCount = resumed.bargeInCount;
        this.turnCount = resumed.turnCount;
        return;
      }
      this.persistedRecord = createVoiceSessionRecord({
        sessionId: this.sessionId,
        provider: this.provider,
        turnMode: this.turnMode,
        botId: this.botId,
      });
      this.sessionStore.save(this.persistedRecord);
    } catch {
      // A broken store must not break the call.
      this.persistedRecord = null;
    }
  }

  /** Save the final record on disconnect (endedAt + counters). */
  private savePersistedSession(state: string): void {
    if (!this.sessionStore || !this.persistedRecord) return;
    try {
      this.persistedRecord.endedAt = Date.now();
      this.persistedRecord.state = state;
      this.persistedRecord.bargeInCount = this.bargeInCount;
      this.persistedRecord.turnCount = this.turnCount;
      this.persistedRecord.transcript = this.transcriptLines;
      this.sessionStore.save(this.persistedRecord);
    } catch {
      // Disk failures degrade silently.
    }
  }

  private emit(event: RealtimeSessionEvent): void {
    const sink = this.onEvent;
    if (!sink) return;
    try {
      sink(event);
    } catch {
      // A throwing sink must not break the call.
    }
  }
}

/** Input sample rate each provider expects (for the session's
 *  resampler — kept next to the session for tests). */
export const REALTIME_PROVIDER_INPUT_RATES: Record<RealtimeProvider, number> = {
  openai: OPENAI_REALTIME_INPUT_SAMPLE_RATE_HZ,
  gemini: GEMINI_LIVE_INPUT_SAMPLE_RATE_HZ,
  'openai-compatible': OPENAI_REALTIME_INPUT_SAMPLE_RATE_HZ,
};
