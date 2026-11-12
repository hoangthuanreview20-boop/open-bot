/**
 * RealtimeClient — voice realtime over WebSocket.
 *
 * Implements the PUBLIC OpenAI Realtime API wire shape (see
 * voice/types.ts for why this contract, not xAI's internal protocol):
 *
 *   client → server: `session.update` (after open), then per audio chunk
 *                      `input_audio_buffer.append` { audio: base64 PCM16 }
 *   server → client: `session.created` / `session.updated`,
 *                      `response.audio_transcript.delta` / `.done`,
 *                      `response.audio.delta` (base64 PCM16 out),
 *                      `response.function_call_arguments.done`,
 *                      `error`
 *
 * The socket is injected (`config.socketFactory`, defaulting to the
 * global `WebSocket`) — no hard dependency on the `ws` package, and
 * fully mockable in tests.
 *
 * Redial policy (P0-1, REA deep-dive §5.2 — architecture constants
 * learned from the static analysis of Grok Bot 0.79.3, re-implemented
 * here on the public OpenAI Realtime contract): up to 20 redial
 * attempts, 15s dial timeout per attempt, backoff 1s doubling to a 10s
 * cap, and a separate budget of 3 redials for "silent path" drops (a
 * connection that closed without ever delivering a server message).
 * Close codes 1008 (policy) and 4001 (superseded — a newer session
 * replaced this one) are terminal and never redial. `disconnect()` is
 * intentional: it stops reconnecting.
 */
import type {
  AudioEvent,
  RealtimeCallbacks,
  RealtimeConfig,
  RealtimeState,
  RealtimeToolCall,
  TranscriptEvent,
  WebSocketFactory,
  WebSocketLike,
} from './types';
import {
  VOICE_CALL_POLICY_CLOSE_CODE,
  VOICE_CALL_SUPERSEDED_CLOSE_CODE,
  VOICE_REDIAL_DIAL_TIMEOUT_MS,
  VOICE_REDIAL_INITIAL_DELAY_MS,
  VOICE_REDIAL_MAX_ATTEMPTS,
  VOICE_REDIAL_MAX_DELAY_MS,
  VOICE_REDIAL_MAX_SILENT_PATH_REDIALS,
} from './types';

export const DEFAULT_MAX_RECONNECT_ATTEMPTS = VOICE_REDIAL_MAX_ATTEMPTS;
export const DEFAULT_RECONNECT_DELAY_MS = VOICE_REDIAL_INITIAL_DELAY_MS;
/** Default per-attempt dial timeout (ms). Re-exported for callers/tests. */
export const DEFAULT_DIAL_TIMEOUT_MS = VOICE_REDIAL_DIAL_TIMEOUT_MS;
/** Default backoff cap for redials (ms). */
export const DEFAULT_MAX_REDIAL_DELAY_MS = VOICE_REDIAL_MAX_DELAY_MS;
/** Default max redials for silent-path drops. */
export const DEFAULT_MAX_SILENT_PATH_REDIALS = VOICE_REDIAL_MAX_SILENT_PATH_REDIALS;

/** WebSocket readyState values (mirrors the standard constants). */
const WS_OPEN = 1;

interface SessionMessage {
  type: string;
  [key: string]: unknown;
}

function defaultSocketFactory(url: string): WebSocketLike {
  const WS = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!WS) {
    throw new Error('RealtimeClient: no WebSocket available — pass config.socketFactory.');
  }
  return new WS(url);
}

export class RealtimeClient {
  private readonly callbacks: RealtimeCallbacks;
  private socket: WebSocketLike | null = null;
  private config: RealtimeConfig | null = null;
  private socketFactory: WebSocketFactory = defaultSocketFactory;
  private state: RealtimeState = 'idle';
  /** Consecutive reconnect attempts for the current session. */
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** True after disconnect() — suppresses reconnect. */
  private closedIntentionally = false;
  /** Redials spent on "silent path" drops (session closed without ever
   *  delivering a server message). Reset to 0 as soon as any message
   *  arrives — a path that speaks is not silent. */
  private silentPathRedials = 0;
  /** True once the current socket has delivered any server message. */
  private sessionHadActivity = false;
  /** Dial-timeout timer for the socket currently opening. */
  private dialTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Reject callback of the socket currently opening, if any. Held so
   * disconnect()/supersede() can settle a pending connect() instead of
   * leaving it hanging forever: supersede() detaches the socket's
   * handlers, so without this the dial would never resolve or reject.
   * Cleared whenever the open settles (open / error / close / timeout).
   */
  private pendingOpenReject: ((error: Error) => void) | null = null;
  /**
   * Session generation. Incremented by connect()/disconnect()/
   * supersede(): a socket from an older generation that opens late
   * (after its session was superseded or disconnected) is ignored
   * instead of resurrecting a dead session.
   */
  private epoch = 0;
  /** Accumulated transcript text for the current response. */
  private currentTranscript = '';
  /** Accumulated tool-call arguments, keyed by call id. */
  private pendingToolCalls = new Map<string, { name: string; argsText: string }>();

  constructor(callbacks: RealtimeCallbacks = {}) {
    this.callbacks = callbacks;
  }

  /** Current connection state. */
  getState(): RealtimeState {
    return this.state;
  }

  /** True while the socket is open. */
  isConnected(): boolean {
    return this.state === 'connected' && this.socket?.readyState === WS_OPEN;
  }

  /** Reconnect attempts used so far for the current session (0 after a clean connect). */
  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  /** Silent-path redials spent so far (drops with no server message). */
  getSilentPathRedials(): number {
    return this.silentPathRedials;
  }

  /**
   * Pure backoff for redial attempt N (1-based): the initial delay
   * doubles each attempt, capped at `maxDelayMs`. Exported so the
   * policy is testable without waiting on real timers:
   * `redialDelayMs(1, 1000, 10000) === 1000`,
   * `redialDelayMs(5, 1000, 10000) === 10000`.
   */
  static redialDelayMs(
    attempt: number,
    initialDelayMs: number,
    maxDelayMs: number,
  ): number {
    return Math.min(maxDelayMs, initialDelayMs * 2 ** (Math.max(1, attempt) - 1));
  }

  /** Register/replace the transcript handler. Returns an unsubscribe fn. */
  onTranscript(cb: (event: TranscriptEvent) => void): () => void {
    this.callbacks.onTranscript = cb;
    return () => {
      if (this.callbacks.onTranscript === cb) this.callbacks.onTranscript = undefined;
    };
  }

  /** Register/replace the tool-call handler. Returns an unsubscribe fn. */
  onToolCall(cb: (call: RealtimeToolCall) => void): () => void {
    this.callbacks.onToolCall = cb;
    return () => {
      if (this.callbacks.onToolCall === cb) this.callbacks.onToolCall = undefined;
    };
  }

  /** Register/replace the error handler. Returns an unsubscribe fn. */
  onError(cb: (error: Error) => void): () => void {
    this.callbacks.onError = cb;
    return () => {
      if (this.callbacks.onError === cb) this.callbacks.onError = undefined;
    };
  }

  /** Register/replace the audio-output handler. Returns an unsubscribe fn. */
  onAudio(cb: (event: AudioEvent) => void): () => void {
    this.callbacks.onAudio = cb;
    return () => {
      if (this.callbacks.onAudio === cb) this.callbacks.onAudio = undefined;
    };
  }

  /**
   * Open the realtime session. Resolves when the socket opens (the
   * `session.update` is sent right after); rejects if the socket errors
   * before opening. A rejected connect does NOT start the reconnect loop
   * — the caller retries (e.g. from the UI); reconnects only happen for
   * drops of an established session.
   */
  async connect(config: RealtimeConfig): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      throw new Error('RealtimeClient: already connected or connecting.');
    }
    this.config = config;
    this.socketFactory = config.socketFactory ?? defaultSocketFactory;
    this.closedIntentionally = false;
    this.epoch += 1;
    this.reconnectAttempts = 0;
    this.silentPathRedials = 0;
    this.sessionHadActivity = false;
    this.currentTranscript = '';
    this.pendingToolCalls.clear();
    await this.openSocket();
  }

  /**
   * Supersede this session: a newer session has replaced this one, so
   * the old connection must stop cleanly and never redial or fight the
   * new one for the call. Closes the socket with the superseded close
   * code (4001) and suppresses any pending reconnect, exactly like an
   * intentional disconnect — except a later `connect()` on this client
   * still works (the supersede only ends this session, not the client).
   * Idempotent.
   */
  supersede(): void {
    this.closedIntentionally = true;
    this.epoch += 1;
    this.clearReconnectTimer();
    this.clearDialTimer();
    this.rejectPendingOpen();
    this.setState('closed');
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      try {
        socket.close(VOICE_CALL_SUPERSEDED_CLOSE_CODE, 'superseded');
      } catch {
        // Socket already gone — nothing to do.
      }
      this.detachSocket(socket);
    }
    this.currentTranscript = '';
    this.pendingToolCalls.clear();
  }

  /**
   * Send one audio chunk (PCM16 bytes) to the server. Throws when not
   * connected. The caller chunks microphone audio (e.g. ~100 ms frames)
   * and calls this per frame.
   */
  sendAudio(chunk: Uint8Array | ArrayBuffer): void {
    if (!this.isConnected() || !this.socket) {
      throw new Error('RealtimeClient: not connected — call connect() first.');
    }
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    this.send({ type: 'input_audio_buffer.append', audio: Buffer.from(bytes).toString('base64') });
  }

  /** Tell the server the current utterance is complete. */
  commitAudio(): void {
    if (!this.isConnected()) {
      throw new Error('RealtimeClient: not connected — call connect() first.');
    }
    this.send({ type: 'input_audio_buffer.commit' });
  }

  /** Ask the model to produce a response for the buffered audio. */
  requestResponse(): void {
    if (!this.isConnected()) {
      throw new Error('RealtimeClient: not connected — call connect() first.');
    }
    this.send({ type: 'response.create' });
  }

  /**
   * Answer one function call the model made: send the tool result
   * back as a `function_call_output` item, then ask the model to
   * respond so it can speak the result. Every call the model makes
   * must be answered this way, or the realtime conversation stalls.
   * Throws when not connected.
   */
  sendToolResult(callId: string, output: string): void {
    if (!this.isConnected()) {
      throw new Error('RealtimeClient: not connected — call connect() first.');
    }
    this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output },
    });
    this.send({ type: 'response.create' });
  }

  /** Close the session. Idempotent; stops any pending reconnect. */
  disconnect(): void {
    this.closedIntentionally = true;
    this.epoch += 1;
    this.clearReconnectTimer();
    this.clearDialTimer();
    this.rejectPendingOpen();
    this.setState('closed');
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Socket already gone — nothing to do.
      }
      this.detachSocket(this.socket);
      this.socket = null;
    }
    this.currentTranscript = '';
    this.pendingToolCalls.clear();
  }

  // -- internals ----------------------------------------------------------

  private setState(state: RealtimeState): void {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }

  private openSocket(): Promise<void> {
    const config = this.config;
    if (!config) throw new Error('RealtimeClient: missing config.');
    this.setState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');
    this.sessionHadActivity = false;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const epoch = this.epoch;
      this.pendingOpenReject = reject;
      const socket = this.socketFactory(config.url);
      this.socket = socket;
      const dialTimeoutMs = config.dialTimeoutMs ?? VOICE_REDIAL_DIAL_TIMEOUT_MS;
      // A socket that never opens within the dial timeout counts as one
      // spent redial attempt: close it, report, and let the reconnect
      // path (or the initial caller) decide what happens next.
      this.clearDialTimer();
      this.dialTimer = setTimeout(() => {
        this.dialTimer = null;
        if (settled || this.socket !== socket) return;
        settled = true;
        this.pendingOpenReject = null;
        this.socket = null;
        this.detachSocket(socket);
        try {
          socket.close();
        } catch {
          // Already gone.
        }
        const error = new Error(
          `RealtimeClient: dial timed out after ${dialTimeoutMs}ms.`,
        );
        this.callbacks.onError?.(error);
        this.setState('idle');
        reject(error);
      }, dialTimeoutMs);
      socket.onopen = () => {
        if (settled) return;
        // The session ended (disconnect/supersede) while dialing: this
        // socket belongs to a dead generation — drop it instead of
        // resurrecting the session.
        if (epoch !== this.epoch) {
          settled = true;
          this.pendingOpenReject = null;
          this.clearDialTimer();
          this.detachSocket(socket);
          try {
            socket.close();
          } catch {
            // Already gone.
          }
          reject(new Error('RealtimeClient: session ended before opening.'));
          return;
        }
        settled = true;
        this.pendingOpenReject = null;
        this.clearDialTimer();
        this.reconnectAttempts = 0;
        this.setState('connected');
        this.sendSessionUpdate();
        resolve();
      };
      socket.onerror = (event) => {
        const error = new Error(
          `RealtimeClient: socket error${this.describeEvent(event)}`,
        );
        if (!settled) {
          settled = true;
          this.pendingOpenReject = null;
          this.clearDialTimer();
          this.callbacks.onError?.(error);
          this.setState('idle');
          reject(error);
          return;
        }
        // Error on an established socket is followed by onclose; the
        // reconnect decision lives there, so don't double-report here.
      };
      socket.onclose = (event) => {
        if (this.socket !== socket) return; // stale socket from a previous attempt
        this.socket = null;
        this.clearDialTimer();
        if (this.closedIntentionally) {
          this.setState('closed');
          return;
        }
        // Unexpected drop: reconnect (unless this close already settled
        // a failed initial connect — then the caller owns the retry).
        if (!settled) {
          settled = true;
          this.pendingOpenReject = null;
          const error = new Error(
            `RealtimeClient: connection closed before opening (code ${event?.code ?? '?'})`,
          );
          this.callbacks.onError?.(error);
          this.setState('idle');
          reject(error);
          return;
        }
        // Terminal close codes never redial: the server refused the
        // call by policy (1008), or this session was superseded by a
        // newer one (4001) — redialing would fight the new session.
        const code = event?.code;
        if (
          code === VOICE_CALL_POLICY_CLOSE_CODE ||
          code === VOICE_CALL_SUPERSEDED_CLOSE_CODE
        ) {
          this.setState('closed');
          this.callbacks.onError?.(
            new Error(
              `RealtimeClient: connection closed with terminal code ${code} — not redialing.`,
            ),
          );
          return;
        }
        // Silent path: the session dropped without ever delivering a
        // server message. It has its own, much smaller redial budget.
        if (!this.sessionHadActivity) {
          this.silentPathRedials += 1;
          const maxSilent = config.maxSilentPathRedials ?? VOICE_REDIAL_MAX_SILENT_PATH_REDIALS;
          if (this.silentPathRedials > maxSilent) {
            this.setState('closed');
            this.callbacks.onError?.(
              new Error(
                `RealtimeClient: connection lost on a silent path, gave up after ${maxSilent} silent-path redial(s).`,
              ),
            );
            return;
          }
        }
        this.scheduleReconnect();
      };
      socket.onmessage = (event) => {
        this.handleMessage(event.data);
      };
    });
  }

  private describeEvent(event: unknown): string {
    if (event && typeof event === 'object' && 'message' in event) {
      const message = (event as { message?: unknown }).message;
      if (typeof message === 'string' && message) return `: ${message}`;
    }
    return '';
  }

  private scheduleReconnect(): void {
    const config = this.config;
    const maxAttempts = config?.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    if (this.closedIntentionally || !config) {
      this.setState('closed');
      return;
    }
    if (this.reconnectAttempts >= maxAttempts) {
      this.setState('closed');
      this.callbacks.onError?.(
        new Error(
          `RealtimeClient: connection lost, gave up after ${maxAttempts} reconnect attempt(s).`,
        ),
      );
      return;
    }
    // A reconnect may already be scheduled (e.g. a socket that fires
    // both onerror and onclose for one drop) — never double-book it.
    if (this.reconnectTimer !== null) return;
    this.reconnectAttempts += 1;
    const baseDelay = config.reconnectDelayMs ?? VOICE_REDIAL_INITIAL_DELAY_MS;
    const maxDelay = config.reconnectMaxDelayMs ?? VOICE_REDIAL_MAX_DELAY_MS;
    const delay = RealtimeClient.redialDelayMs(this.reconnectAttempts, baseDelay, maxDelay);
    this.setState('reconnecting');
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedIntentionally) return;
      this.openSocket().catch(() => {
        // openSocket reports via onError/onclose; a failed reconnect
        // attempt ends in onclose → scheduleReconnect again, until the
        // attempt budget is spent. If onclose never fires (factory
        // threw synchronously), treat it as one spent attempt here.
        if (!this.closedIntentionally && this.socket === null) {
          this.scheduleReconnect();
        }
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearDialTimer(): void {
    if (this.dialTimer !== null) {
      clearTimeout(this.dialTimer);
      this.dialTimer = null;
    }
  }

  /**
   * Settle a connect() that is still dialing because its session just
   * ended (disconnect/supersede). Without this the caller would wait
   * forever: the socket's handlers are detached on teardown, so no
   * socket event can ever settle the promise afterwards.
   */
  private rejectPendingOpen(): void {
    const reject = this.pendingOpenReject;
    this.pendingOpenReject = null;
    reject?.(new Error('RealtimeClient: session ended before opening.'));
  }

  private send(message: SessionMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  private sendSessionUpdate(): void {
    const config = this.config;
    if (!config) return;
    this.send({
      type: 'session.update',
      session: {
        ...(config.model ? { model: config.model } : {}),
        ...(config.voice ? { voice: config.voice } : {}),
        ...(config.instructions ? { instructions: config.instructions } : {}),
        ...(config.tools ? { tools: config.tools } : {}),
        input_audio_format: config.inputAudioFormat ?? 'pcm16',
        output_audio_format: config.outputAudioFormat ?? 'pcm16',
        turn_detection: { type: 'server_vad' },
      },
    });
  }

  private detachSocket(socket: WebSocketLike): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let message: SessionMessage;
    try {
      message = JSON.parse(data) as SessionMessage;
    } catch {
      return; // ignore non-JSON frames
    }
    if (typeof message.type !== 'string') return;
    // Any well-formed server message proves the path is alive: a drop
    // after this point is not a "silent path" drop.
    this.sessionHadActivity = true;
    this.silentPathRedials = 0;
    switch (message.type) {
      case 'session.created':
      case 'session.updated':
        // Session acknowledged; nothing to surface yet.
        break;
      case 'response.audio_transcript.delta': {
        const delta = typeof message.delta === 'string' ? message.delta : '';
        this.currentTranscript += delta;
        this.callbacks.onTranscript?.({ text: this.currentTranscript, isFinal: false });
        break;
      }
      case 'response.audio_transcript.done': {
        const text =
          typeof message.transcript === 'string' ? message.transcript : this.currentTranscript;
        this.currentTranscript = text;
        this.callbacks.onTranscript?.({ text, isFinal: true });
        this.currentTranscript = '';
        break;
      }
      case 'response.audio.delta': {
        const base64 = typeof message.delta === 'string' ? message.delta : '';
        if (base64 && this.callbacks.onAudio) {
          this.callbacks.onAudio({ audio: new Uint8Array(Buffer.from(base64, 'base64')) });
        }
        break;
      }
      case 'response.function_call_arguments.delta': {
        const callId = typeof message.call_id === 'string' ? message.call_id : '';
        const itemId = typeof message.item_id === 'string' ? message.item_id : '';
        const id = callId || itemId;
        const delta = typeof message.delta === 'string' ? message.delta : '';
        if (!id) break;
        const pending = this.pendingToolCalls.get(id) ?? { name: '', argsText: '' };
        pending.argsText += delta;
        this.pendingToolCalls.set(id, pending);
        break;
      }
      case 'response.function_call_arguments.done': {
        const callId = typeof message.call_id === 'string' ? message.call_id : '';
        const itemId = typeof message.item_id === 'string' ? message.item_id : '';
        const id = callId || itemId;
        const name = typeof message.name === 'string' ? message.name : '';
        const rawArgs = typeof message.arguments === 'string' ? message.arguments : '';
        const pending = this.pendingToolCalls.get(id);
        const argsText = rawArgs || pending?.argsText || '{}';
        this.pendingToolCalls.delete(id);
        let args: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(argsText);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          }
        } catch {
          args = { _raw: argsText };
        }
        this.callbacks.onToolCall?.({ id, name: name || pending?.name || 'unknown', args });
        break;
      }
      case 'error': {
        const detail =
          message.error && typeof message.error === 'object'
            ? (message.error as { message?: unknown }).message
            : message.error;
        this.callbacks.onError?.(
          new Error(`RealtimeClient: server error — ${typeof detail === 'string' ? detail : JSON.stringify(detail ?? message)}`),
        );
        break;
      }
      default:
        // Unknown event types are ignored (forward-compatible).
        break;
    }
  }
}
