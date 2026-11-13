/**
 * Realtime provider adapters (v0.95, Đội D3).
 *
 * One common transport interface; one adapter per provider wire
 * protocol. The session layer (`RealtimeSession`) only ever sees
 * `RealtimeTransport` — it never parses provider JSON.
 *
 * Wire shapes (public docs only — see docs/voice-realtime-v095.md;
 * no live calls were made while writing this, and nothing is copied
 * from any repo):
 *
 * OpenAI Realtime — `wss://api.openai.com/v1/realtime?model=<model>`
 *   (auth: bearer header via the socket factory; the global
 *   WebSocket cannot send headers, so main passes a factory that
 *   injects the key, or the key goes in the URL query for
 *   OpenAI-compatible endpoints that accept it). Session:
 *   `session.update` -> `input_audio_buffer.append` (base64 PCM16
 *   24 kHz) -> `response.audio.delta` / `response.audio_transcript.*`
 *   -> `response.function_call_arguments.done`. Barge-in:
 *   `input_audio_buffer.speech_started` -> `response.cancel`.
 *   Implemented by wrapping the existing `RealtimeClient`
 *   (voice/realtime.ts) — its reconnect/redial policy is reused
 *   as-is, so this transport reports `handlesReconnect: true`.
 *
 * Gemini Live (Developer API) —
 *   `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=<key>`
 *   (key in the query string, NOT a header). Session: `setup`
 *   { model: "models/<live-model>", generationConfig:
 *   { responseModalities: ["AUDIO"], speechConfig }, systemInstruction,
 *   tools } -> wait `setupComplete` before sending anything else ->
 *   `realtimeInput` { mediaChunks: [{ mimeType: "audio/pcm;rate=16000",
 *   data: base64 }] } -> `serverContent` { modelTurn: { parts: [
 *   { inlineData: { mimeType: "audio/pcm;rate=24000", data } }] },
 *   outputTranscription, turnComplete, interrupted }.
 *   Tool calls arrive as `toolCall.functionCalls[]` (or as a
 *   `functionCall` part inside `modelTurn`) and are answered with
 *   `toolResponse.functionResponses[]` carrying the original call id.
 *   Barge-in is server-driven: `serverContent.interrupted === true`.
 *   Default model is the GA native-audio model
 *   `gemini-live-2.5-flash-native-audio`; only `*-live-*` /
 *   `*-native-audio*` models support `bidiGenerateContent` — a
 *   plain text model (e.g. `gemini-2.5-flash`) is rejected by the
 *   server. This transport has no built-in reconnect
 *   (`handlesReconnect: false`); the session reconnects it.
 *
 * Live status: BOTH adapters are mock-verified only (fake WebSocket
 * in tests). No live call has been made from this machine — there is
 * no OpenAI key on it, and the Gemini key lives only in the
 * connector store and is never copied into code, files or tests.
 * See docs/voice-realtime-v095.md § "Live limits".
 */
import type {
  AudioEvent,
  RealtimeCallbacks,
  RealtimeConfig,
  RealtimeProvider,
  RealtimeState,
  RealtimeToolCall,
  TranscriptEvent,
  TurnTakingMode,
  WebSocketFactory,
  WebSocketLike,
} from './types';
import {
  GEMINI_LIVE_INPUT_SAMPLE_RATE_HZ,
  OPENAI_REALTIME_INPUT_SAMPLE_RATE_HZ,
  REALTIME_OUTPUT_SAMPLE_RATE_HZ,
  VOICE_REDIAL_DIAL_TIMEOUT_MS,
} from './types';
import { RealtimeClient } from './realtime';

/** Default OpenAI Realtime WebSocket endpoint (model in query). */
export const OPENAI_REALTIME_WS_URL = 'wss://api.openai.com/v1/realtime';
/** Default OpenAI Realtime model. */
export const OPENAI_REALTIME_DEFAULT_MODEL = 'gpt-4o-realtime-preview';
/** Default Gemini Live WebSocket endpoint (Developer API, key in query). */
export const GEMINI_LIVE_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
/** Default Gemini Live model (GA native-audio model). */
export const GEMINI_LIVE_DEFAULT_MODEL = 'gemini-live-2.5-flash-native-audio';
/** Default Gemini Live voice (prebuilt voice name). */
export const GEMINI_LIVE_DEFAULT_VOICE = 'Puck';
/** Default OpenAI Realtime voice. */
export const OPENAI_REALTIME_DEFAULT_VOICE = 'alloy';

/** Build the OpenAI Realtime WebSocket URL for a model. */
export function buildOpenAiRealtimeUrl(model: string = OPENAI_REALTIME_DEFAULT_MODEL): string {
  return `${OPENAI_REALTIME_WS_URL}?model=${encodeURIComponent(model)}`;
}

/** Build the Gemini Live WebSocket URL for an API key. The key is a
 *  `?key=` query param, NOT a header. Callers must never log the
 *  returned URL. */
export function buildGeminiLiveUrl(apiKey: string): string {
  return `${GEMINI_LIVE_WS_URL}?key=${encodeURIComponent(apiKey)}`;
}

/** Config a transport connects with. Extends the existing
 *  `RealtimeConfig` with the provider + turn-taking mode the session
 *  chose; `url` overrides the provider default URL. */
export interface RealtimeTransportConfig extends RealtimeConfig {
  provider: RealtimeProvider;
  turnMode?: TurnTakingMode;
}

/** Transport-level callbacks: the common `RealtimeCallbacks` plus
 *  `onInterrupted`, fired when the server reports a barge-in
 *  (Gemini `serverContent.interrupted`; OpenAI reports it as
 *  `onSpeechStarted` instead). */
export interface RealtimeTransportCallbacks extends RealtimeCallbacks {
  onInterrupted?: () => void;
}

/**
 * One realtime provider behind a common interface. The session
 * drives this; the adapter translates to/from the provider wire.
 */
export interface RealtimeTransport {
  readonly provider: RealtimeProvider;
  /** PCM16 input rate the provider expects (Hz). */
  readonly inputSampleRateHz: number;
  /** PCM16 output rate the provider streams (Hz). */
  readonly outputSampleRateHz: number;
  /** True when the transport reconnects itself after a drop
   *  (OpenAI — RealtimeClient's redial policy). False means the
   *  session owns reconnect (Gemini). */
  readonly handlesReconnect: boolean;
  connect(config: RealtimeTransportConfig): Promise<void>;
  disconnect(): void;
  sendAudio(chunk: Uint8Array | ArrayBuffer): void;
  commitAudio(): void;
  requestResponse(): void;
  cancelResponse(): void;
  sendToolResult(callId: string, output: string): void;
  isConnected(): boolean;
  getState(): RealtimeState;
}

function defaultSocketFactory(url: string): WebSocketLike {
  const WS = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!WS) {
    throw new Error('RealtimeTransport: no WebSocket available — pass config.socketFactory.');
  }
  return new WS(url);
}

function toBytes(chunk: Uint8Array | ArrayBuffer): Uint8Array {
  return chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
}

// ---------------------------------------------------------------------------
// OpenAI Realtime transport (wraps the existing RealtimeClient)
// ---------------------------------------------------------------------------

export class OpenAiRealtimeTransport implements RealtimeTransport {
  readonly provider: RealtimeProvider = 'openai';
  readonly inputSampleRateHz = OPENAI_REALTIME_INPUT_SAMPLE_RATE_HZ;
  readonly outputSampleRateHz = REALTIME_OUTPUT_SAMPLE_RATE_HZ;
  readonly handlesReconnect = true;
  private readonly client: RealtimeClient;

  constructor(callbacks: RealtimeTransportCallbacks = {}) {
    this.client = new RealtimeClient(callbacks);
  }

  async connect(config: RealtimeTransportConfig): Promise<void> {
    const model = config.model ?? OPENAI_REALTIME_DEFAULT_MODEL;
    await this.client.connect({
      ...config,
      url: config.url ?? buildOpenAiRealtimeUrl(model),
      model,
      voice: config.voice ?? OPENAI_REALTIME_DEFAULT_VOICE,
    });
  }

  disconnect(): void {
    this.client.disconnect();
  }

  sendAudio(chunk: Uint8Array | ArrayBuffer): void {
    this.client.sendAudio(toBytes(chunk));
  }

  commitAudio(): void {
    this.client.commitAudio();
  }

  requestResponse(): void {
    this.client.requestResponse();
  }

  cancelResponse(): void {
    this.client.cancelResponse();
  }

  sendToolResult(callId: string, output: string): void {
    this.client.sendToolResult(callId, output);
  }

  isConnected(): boolean {
    return this.client.isConnected();
  }

  getState(): RealtimeState {
    return this.client.getState();
  }
}

// ---------------------------------------------------------------------------
// Gemini Live transport (own WebSocket client — different wire)
// ---------------------------------------------------------------------------

interface GeminiMessage {
  [key: string]: unknown;
}

const WS_OPEN = 1;

/**
 * Gemini Live adapter. Translates the BidiGenerateContent JSON wire
 * into the common transport callbacks. Setup is gated on
 * `setupComplete`: `connect()` resolves only after the server
 * accepts the setup, and no audio is sent before that.
 */
export class GeminiLiveTransport implements RealtimeTransport {
  readonly provider: RealtimeProvider = 'gemini';
  readonly inputSampleRateHz = GEMINI_LIVE_INPUT_SAMPLE_RATE_HZ;
  readonly outputSampleRateHz = REALTIME_OUTPUT_SAMPLE_RATE_HZ;
  readonly handlesReconnect = false;
  private readonly callbacks: RealtimeTransportCallbacks;
  private socket: WebSocketLike | null = null;
  private socketFactory: WebSocketFactory = defaultSocketFactory;
  private state: RealtimeState = 'idle';
  private config: RealtimeTransportConfig | null = null;
  private dialTimer: ReturnType<typeof setTimeout> | null = null;
  private closedIntentionally = false;
  private setupComplete = false;
  private activityStarted = false;
  private currentTranscript = '';
  private toolCallSeq = 0;
  /** call id -> function name, for answering tool calls. */
  private pendingToolCalls = new Map<string, string>();

  constructor(callbacks: RealtimeTransportCallbacks = {}) {
    this.callbacks = callbacks;
  }

  getState(): RealtimeState {
    return this.state;
  }

  isConnected(): boolean {
    return this.state === 'connected' && this.socket?.readyState === WS_OPEN;
  }

  async connect(config: RealtimeTransportConfig): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      throw new Error('GeminiLiveTransport: already connected or connecting.');
    }
    if (!config.apiKey && !config.url) {
      throw new Error(
        'GeminiLiveTransport: an API key is required (put it in the app Vault; it is sent as ?key= and never logged).',
      );
    }
    this.config = config;
    this.socketFactory = config.socketFactory ?? defaultSocketFactory;
    this.closedIntentionally = false;
    this.setupComplete = false;
    this.activityStarted = false;
    this.currentTranscript = '';
    this.pendingToolCalls.clear();
    const url = config.url ?? buildGeminiLiveUrl(config.apiKey ?? '');
    this.setState('connecting');
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = this.socketFactory(url);
      this.socket = socket;
      const dialTimeoutMs = config.dialTimeoutMs ?? VOICE_REDIAL_DIAL_TIMEOUT_MS;
      this.clearDialTimer();
      this.dialTimer = setTimeout(() => {
        this.dialTimer = null;
        if (settled || this.socket !== socket) return;
        settled = true;
        this.socket = null;
        this.detachSocket(socket);
        try {
          socket.close();
        } catch {
          // Already gone.
        }
        const error = new Error(`GeminiLiveTransport: dial timed out after ${dialTimeoutMs}ms.`);
        this.callbacks.onError?.(error);
        this.setState('idle');
        reject(error);
      }, dialTimeoutMs);
      socket.onopen = () => {
        if (settled) return;
        // The session ended while dialing — drop this socket.
        if (this.closedIntentionally) {
          settled = true;
          this.pendingReject = null;
          this.clearDialTimer();
          this.detachSocket(socket);
          try {
            socket.close();
          } catch {
            // Already gone.
          }
          reject(new Error('GeminiLiveTransport: session ended before opening.'));
          return;
        }
        this.sendSetup();
        // Do NOT settle yet: connect() resolves on setupComplete.
      };
      socket.onerror = (event) => {
        const error = new Error(
          `GeminiLiveTransport: socket error${this.describeEvent(event)}`,
        );
        if (!settled) {
          settled = true;
          this.pendingReject = null;
          this.clearDialTimer();
          this.callbacks.onError?.(error);
          this.setState('idle');
          reject(error);
        }
      };
      socket.onclose = (event) => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.clearDialTimer();
        if (this.closedIntentionally) {
          this.setState('closed');
          return;
        }
        if (!settled) {
          settled = true;
          this.pendingReject = null;
          const error = new Error(
            `GeminiLiveTransport: connection closed before setup completed (code ${event?.code ?? '?'})`,
          );
          this.callbacks.onError?.(error);
          this.setState('idle');
          reject(error);
          return;
        }
        // Drop of an established session: the session (not this
        // transport) owns reconnect — report closed and let it retry.
        this.setState('closed');
        this.callbacks.onError?.(
          new Error(
            `GeminiLiveTransport: connection closed (code ${event?.code ?? '?'}) — session will retry.`,
          ),
        );
      };
      socket.onmessage = (event) => {
        const done = this.handleMessage(event.data);
        if (done === 'setupComplete' && !settled) {
          settled = true;
          this.pendingReject = null;
          this.clearDialTimer();
          this.setState('connected');
          resolve();
        }
      };
      this.pendingReject = reject;
    });
  }

  disconnect(): void {
    this.closedIntentionally = true;
    this.clearDialTimer();
    this.setState('closed');
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Socket already gone.
      }
      this.detachSocket(this.socket);
      this.socket = null;
    }
    this.setupComplete = false;
    this.activityStarted = false;
    this.currentTranscript = '';
    this.pendingToolCalls.clear();
  }

  sendAudio(chunk: Uint8Array | ArrayBuffer): void {
    if (!this.isConnected() || !this.socket) {
      throw new Error('GeminiLiveTransport: not connected — call connect() first.');
    }
    if (!this.setupComplete) {
      throw new Error('GeminiLiveTransport: setup not complete — audio not accepted yet.');
    }
    const bytes = toBytes(chunk);
    this.send({
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: `audio/pcm;rate=${this.inputSampleRateHz}`,
            data: Buffer.from(bytes).toString('base64'),
          },
        ],
      },
    });
  }

  /**
   * End the current user turn. In server_vad mode this is a no-op
   * (the server's VAD decides); in local_vad / push_to_talk mode it
   * sends `activityEnd`, which tells the server the user stopped.
   */
  commitAudio(): void {
    if (!this.isConnected()) {
      throw new Error('GeminiLiveTransport: not connected — call connect() first.');
    }
    if (this.config?.turnMode === 'server_vad' || !this.config?.turnMode) return;
    if (!this.activityStarted) return;
    this.activityStarted = false;
    this.send({ realtimeInput: { activityEnd: {} } });
  }

  /** Gemini responds on VAD / activityEnd — nothing to request. */
  requestResponse(): void {
    if (!this.isConnected()) {
      throw new Error('GeminiLiveTransport: not connected — call connect() first.');
    }
  }

  /**
   * Barge-in: the Live API interrupts generation when user activity
   * starts (`activityHandling: START_OF_ACTIVITY_INTERRUPTS` is the
   * default), so signal activity start. The session also flushes
   * its local playback queue. Best-effort per the public docs —
   * mock-verified only, not live-verified.
   */
  cancelResponse(): void {
    if (!this.isConnected()) {
      throw new Error('GeminiLiveTransport: not connected — call connect() first.');
    }
    this.activityStarted = true;
    this.send({ realtimeInput: { activityStart: {} } });
  }

  sendToolResult(callId: string, output: string): void {
    if (!this.isConnected()) {
      throw new Error('GeminiLiveTransport: not connected — call connect() first.');
    }
    const name = this.pendingToolCalls.get(callId);
    this.pendingToolCalls.delete(callId);
    if (!name) {
      throw new Error(`GeminiLiveTransport: unknown tool call id ${callId}.`);
    }
    this.send({
      toolResponse: {
        functionResponses: [{ id: callId, name, response: { result: output } }],
      },
    });
  }

  // -- internals ----------------------------------------------------------

  /** Reject callback of the socket currently opening, if any. Held
   *  so disconnect() can settle a pending connect() instead of
   *  leaving it hanging. */
  private pendingReject: ((error: Error) => void) | null = null;

  private setState(state: RealtimeState): void {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }

  private send(message: GeminiMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  private detachSocket(socket: WebSocketLike): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
  }

  private clearDialTimer(): void {
    if (this.dialTimer !== null) {
      clearTimeout(this.dialTimer);
      this.dialTimer = null;
    }
  }

  private describeEvent(event: unknown): string {
    if (event && typeof event === 'object' && 'message' in event) {
      const message = (event as { message?: unknown }).message;
      if (typeof message === 'string' && message) return `: ${message}`;
    }
    return '';
  }

  /** The `setup` frame: first message after open. */
  private sendSetup(): void {
    const config = this.config;
    if (!config) return;
    const model = config.model ?? GEMINI_LIVE_DEFAULT_MODEL;
    const modelName = model.startsWith('models/') ? model : `models/${model}`;
    const tools = (config.tools ?? []).map((t) => {
      const fn = t as { name?: unknown; description?: unknown; parameters?: unknown };
      return {
        functionDeclarations: [
          {
            name: typeof fn.name === 'string' ? fn.name : 'unknown',
            description: typeof fn.description === 'string' ? fn.description : '',
            parameters: fn.parameters ?? { type: 'object', properties: {} },
          },
        ],
      };
    });
    this.send({
      setup: {
        model: modelName,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: config.voice ?? GEMINI_LIVE_DEFAULT_VOICE },
            },
          },
        },
        ...(config.instructions
          ? { systemInstruction: { parts: [{ text: config.instructions }] } }
          : {}),
        ...(tools.length > 0 ? { tools } : {}),
      },
    });
  }

  /**
   * Handle one server frame. Returns `'setupComplete'` when the
   * setup handshake finished (so `connect()` can resolve).
   */
  private handleMessage(data: unknown): 'setupComplete' | void {
    if (typeof data !== 'string') return;
    let message: GeminiMessage;
    try {
      message = JSON.parse(data) as GeminiMessage;
    } catch {
      return;
    }
    if ('setupComplete' in message) {
      this.setupComplete = true;
      return 'setupComplete';
    }
    if (typeof message.goAway === 'object' && message.goAway !== null) {
      const timeLeft = (message.goAway as { timeLeft?: unknown }).timeLeft;
      this.callbacks.onError?.(
        new Error(
          `GeminiLiveTransport: server asked to go away${typeof timeLeft === 'string' ? ` (time left: ${timeLeft})` : ''} — reconnect to resume.`,
        ),
      );
      return;
    }
    const toolCall = message.toolCall as
      | { functionCalls?: Array<{ id?: unknown; name?: unknown; args?: unknown }> }
      | undefined;
    if (toolCall && Array.isArray(toolCall.functionCalls)) {
      for (const fn of toolCall.functionCalls) {
        this.emitToolCall(fn);
      }
    }
    const serverContent = message.serverContent as
      | {
          modelTurn?: { parts?: Array<Record<string, unknown>> };
          outputTranscription?: { text?: unknown };
          inputTranscription?: { text?: unknown };
          turnComplete?: unknown;
          interrupted?: unknown;
        }
      | undefined;
    if (!serverContent || typeof serverContent !== 'object') return;
    if (serverContent.interrupted === true) {
      this.currentTranscript = '';
      this.callbacks.onInterrupted?.();
    }
    const parts = serverContent.modelTurn?.parts ?? [];
    for (const part of parts) {
      const inline = part.inlineData as { mimeType?: unknown; data?: unknown } | undefined;
      if (inline && typeof inline.data === 'string' && inline.data) {
        this.callbacks.onAudio?.({
          audio: new Uint8Array(Buffer.from(inline.data, 'base64')),
        });
      }
      if (typeof part.text === 'string' && part.text) {
        this.emitTranscript(part.text, false);
      }
      const fn = part.functionCall as { name?: unknown; args?: unknown } | undefined;
      if (fn && typeof fn === 'object') this.emitToolCall(fn);
    }
    const outText = serverContent.outputTranscription?.text;
    if (typeof outText === 'string' && outText) {
      this.emitTranscript(outText, false);
    }
    const inText = serverContent.inputTranscription?.text;
    if (typeof inText === 'string' && inText) {
      // The user's own words, transcribed: its own final line, not
      // mixed into the model's accumulating reply.
      this.callbacks.onTranscript?.({ text: inText, isFinal: true });
    }
    if (serverContent.turnComplete === true) {
      if (this.currentTranscript) {
        this.callbacks.onTranscript?.({ text: this.currentTranscript, isFinal: true });
        this.currentTranscript = '';
      }
      this.callbacks.onSpeechStopped?.();
    }
  }

  private emitTranscript(delta: string, isFinal: boolean): void {
    this.currentTranscript += delta;
    const event: TranscriptEvent = { text: this.currentTranscript, isFinal };
    this.callbacks.onTranscript?.(event);
  }

  private emitToolCall(fn: { id?: unknown; name?: unknown; args?: unknown }): void {
    const name = typeof fn.name === 'string' ? fn.name : 'unknown';
    const id =
      typeof fn.id === 'string' && fn.id ? fn.id : `${name}-${++this.toolCallSeq}`;
    let args: Record<string, unknown> = {};
    if (fn.args && typeof fn.args === 'object' && !Array.isArray(fn.args)) {
      args = fn.args as Record<string, unknown>;
    } else if (typeof fn.args === 'string') {
      try {
        const parsed: unknown = JSON.parse(fn.args);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        args = { _raw: fn.args };
      }
    }
    this.pendingToolCalls.set(id, name);
    const call: RealtimeToolCall = { id, name, args };
    this.callbacks.onToolCall?.(call);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the transport for a provider. `openai-compatible` reuses the
 * OpenAI wire (any endpoint that speaks it) — the caller supplies
 * the endpoint URL in `config.url` at connect time.
 */
export function createRealtimeTransport(
  provider: RealtimeProvider,
  callbacks: RealtimeTransportCallbacks = {},
): RealtimeTransport {
  switch (provider) {
    case 'openai':
    case 'openai-compatible':
      return new OpenAiRealtimeTransport(callbacks);
    case 'gemini':
      return new GeminiLiveTransport(callbacks);
    default:
      throw new Error(`createRealtimeTransport: unknown provider ${String(provider)}.`);
  }
}
