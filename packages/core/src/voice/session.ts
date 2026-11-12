/**
 * VoiceCallSession — one voice call for one bot (v0.56).
 *
 * This is the wiring the desktop main process owns: it binds ONE
 * `RealtimeClient` (the audio connection) to ONE `VoiceCallHarness`
 * (the server side that executes the voice-call toolset and owns the
 * surface register), and it owns the surface registry for that bot.
 *
 * Flow (all original code on the public OpenAI Realtime contract —
 * see voice/types.ts for why that contract, not xAI's internal one):
 *
 *   renderer --IPC voice:surface-register--> session.registerSurface()
 *   renderer --IPC voice:connect-----------> session.connect()
 *     -> harness builds session instructions (base prompt + surface
 *        guidance for the surface on record) and the 10 voice-call
 *        function definitions -> RealtimeClient session.update
 *   mic PCM16 --IPC voice:audio--> session.sendAudio() (even-length
 *     PCM16 frames only; odd/empty frames are rejected, never sent)
 *   server tool call -> harness.executeTool() (served / unknown_tool /
 *     invalid_input) -> session sends the outcome back as
 *     `conversation.item.create` (function_call_output) +
 *     `response.create`, so the model can speak the result; a served
 *     `end_call` hangs up afterwards.
 *   server transcript/audio/error -> session emits a VoiceSessionEvent
 *     to its sink (the main process forwards it to the renderer);
 *     every event carries the bot id, the current surface, and the
 *     surface ids registered for that bot, so a surface only ever
 *     sees events for its own bot.
 *
 * The session never touches the agent's general tool registry: the
 * only tools the model sees during a call are the ten voice-call
 * tools, bound to exactly the handlers its caller supplied. The
 * client is injectable (`clientFactory`) so tests can drive the whole
 * wiring with a mock — no live connection is ever needed here.
 */
import { randomUUID } from 'node:crypto';
import type {
  RealtimeCallbacks,
  RealtimeConfig,
  RealtimeState,
  RealtimeToolCall,
  TranscriptEvent,
  VoiceCallHarnessOutcome,
  VoiceSurface,
} from './types';
import { VOICE_CALL_REQUEST_CHAR_LIMIT, isVoiceSurface } from './types';
import { RealtimeClient as RealRealtimeClient } from './realtime';
import { VoiceCallHarness } from './harness';
import type { VoiceCallToolHandlers } from './callTools';

/** The realtime-client surface a session needs. `RealtimeClient`
 *  satisfies this structurally; tests inject a mock with the same
 *  methods. */
export interface VoiceRealtimeClient {
  connect(config: RealtimeConfig): Promise<void>;
  disconnect(): void;
  sendAudio(chunk: Uint8Array | ArrayBuffer): void;
  commitAudio(): void;
  requestResponse(): void;
  sendToolResult(callId: string, output: string): void;
  isConnected(): boolean;
  getState(): RealtimeState;
}

export type VoiceRealtimeClientFactory = (
  callbacks: RealtimeCallbacks,
) => VoiceRealtimeClient;

/** Which renderer view a surface registration belongs to. `chat` is
 *  the normal chat view; `call` is a dedicated full-screen call view
 *  (not built yet — the registry already distinguishes them so a
 *  future call view can register without changing this module). */
export type VoiceSurfaceView = 'chat' | 'call';

/** One registered surface: a screen the user is looking at while on
 *  a voice call with one bot. */
export interface VoiceSurfaceRegistration {
  surfaceId: string;
  botId: string;
  surface: VoiceSurface;
  view: VoiceSurfaceView;
  registeredAt: number;
}

/** Events a session emits to its sink (the desktop main process).
 *  Every event carries the bot id plus the surface on record and the
 *  ids of all surfaces registered for that bot at emit time. */
export type VoiceSessionEvent =
  | {
      kind: 'transcript';
      botId: string;
      text: string;
      isFinal: boolean;
      surface: VoiceSurface;
      surfaceIds: string[];
    }
  | {
      kind: 'audio';
      botId: string;
      audioBase64: string;
      surface: VoiceSurface;
      surfaceIds: string[];
    }
  | {
      kind: 'toolcall';
      botId: string;
      call: RealtimeToolCall;
      outcome: VoiceCallHarnessOutcome;
      surface: VoiceSurface;
      surfaceIds: string[];
    }
  | {
      kind: 'error';
      botId: string;
      message: string;
      surface: VoiceSurface;
      surfaceIds: string[];
    }
  | {
      kind: 'state';
      botId: string;
      state: RealtimeState;
      surface: VoiceSurface;
      surfaceIds: string[];
    }
  | {
      kind: 'surface';
      botId: string;
      surfaces: VoiceSurfaceRegistration[];
      surface: VoiceSurface;
      surfaceIds: string[];
    };

/** A session event without the fields `emit()` fills in itself
 *  (current surface + registered surface ids). Distributive so each
 *  union member keeps its own payload fields. */
type VoiceSessionEventInput = VoiceSessionEvent extends infer E
  ? E extends unknown
    ? Omit<E, 'surface' | 'surfaceIds'>
    : never
  : never;

export interface VoiceCallSessionOptions {
  botId: string;
  /** Voice-call tool handlers bound by the caller (the desktop main
   *  process binds them to its own bot state). A tool with no handler
   *  is not runnable in this call. */
  handlers?: VoiceCallToolHandlers;
  /** Surface the call starts on. Default 'desk'. */
  surface?: VoiceSurface;
  /** Inject the realtime client (tests). Defaults to a real
   *  `RealtimeClient`. */
  clientFactory?: VoiceRealtimeClientFactory;
  /** Sink for session events. Never throws into the session: a
   *  throwing sink is caught and reported as an `error` event. */
  onEvent?: (event: VoiceSessionEvent) => void;
}

export class VoiceCallSession {
  readonly botId: string;
  private readonly harness: VoiceCallHarness;
  private readonly clientFactory: VoiceRealtimeClientFactory;
  private onEvent: ((event: VoiceSessionEvent) => void) | undefined;
  private client: VoiceRealtimeClient | null = null;
  private readonly surfaces = new Map<string, VoiceSurfaceRegistration>();
  private disposed = false;

  constructor(options: VoiceCallSessionOptions) {
    this.botId = options.botId;
    this.harness = new VoiceCallHarness(options.handlers ?? {}, {
      surface: options.surface ?? 'desk',
    });
    this.clientFactory =
      options.clientFactory ??
      ((callbacks: RealtimeCallbacks) => new RealRealtimeClient(callbacks));
    this.onEvent = options.onEvent;
  }

  // -- surface register ---------------------------------------------------

  /** Register a surface for this bot (a renderer view opening). The
   *  newly registered surface becomes the surface on record, so the
   *  model's spoken replies are shaped for the screen the user is
   *  looking at now. Throws on an unknown surface. */
  registerSurface(
    surface: unknown,
    view: VoiceSurfaceView = 'chat',
  ): VoiceSurfaceRegistration {
    if (!isVoiceSurface(surface)) {
      throw new Error(
        `VoiceCallSession: unknown surface ${JSON.stringify(surface)}.`,
      );
    }
    if (view !== 'chat' && view !== 'call') {
      throw new Error(`VoiceCallSession: unknown surface view ${JSON.stringify(view)}.`);
    }
    const registration: VoiceSurfaceRegistration = {
      surfaceId: `vs-${randomUUID()}`,
      botId: this.botId,
      surface,
      view,
      registeredAt: Date.now(),
    };
    this.surfaces.set(registration.surfaceId, registration);
    this.harness.setSurface(surface);
    this.emit({ kind: 'surface', botId: this.botId, surfaces: this.listSurfaces() });
    return { ...registration };
  }

  /** Unregister a surface (a renderer view closing). The surface on
   *  record falls back to the most recently registered remaining
   *  surface, or 'desk' when none remain. Returns false when the id
   *  was never registered. */
  unregisterSurface(surfaceId: string): boolean {
    if (!this.surfaces.delete(surfaceId)) return false;
    const remaining = [...this.surfaces.values()];
    const current = remaining[remaining.length - 1];
    this.harness.setSurface(current?.surface ?? 'desk');
    this.emit({ kind: 'surface', botId: this.botId, surfaces: this.listSurfaces() });
    return true;
  }

  /** Surfaces registered for this bot, in registration order. */
  listSurfaces(): VoiceSurfaceRegistration[] {
    return [...this.surfaces.values()].map((s) => ({ ...s }));
  }

  /** True when at least one surface is registered for this bot. */
  hasSurfaces(): boolean {
    return this.surfaces.size > 0;
  }

  /** The surface on record (drives session instructions + reply cap). */
  getSurface(): VoiceSurface {
    return this.harness.getSurface();
  }

  /** Max spoken-reply length (chars) for the surface on record. */
  getMaxReplyChars(): number {
    return this.harness.getMaxReplyChars();
  }

  /** Shorten a spoken reply to what the surface on record allows. */
  shortenForSurface(text: string): string {
    return this.harness.shortenForSurface(text);
  }

  /** The harness for this call (tests / introspection). */
  getHarness(): VoiceCallHarness {
    return this.harness;
  }

  // -- call lifecycle -----------------------------------------------------

  /** True while the realtime socket is open. */
  isConnected(): boolean {
    return this.client?.isConnected() ?? false;
  }

  getState(): RealtimeState {
    return this.client?.getState() ?? 'idle';
  }

  /**
   * Open the voice call. The session instructions are the bot's base
   * instructions plus the surface guidance for the surface on record,
   * and the model is offered exactly the ten voice-call tools — the
   * general agent tool registry is never exposed during a call.
   * Connecting twice while connected is a no-op success.
   */
  async connect(config: RealtimeConfig): Promise<void> {
    if (this.disposed) {
      throw new Error('VoiceCallSession: session is disposed.');
    }
    if (this.client?.isConnected()) return;
    const client = this.clientFactory({
      onTranscript: (e: TranscriptEvent) => {
        this.emit({ kind: 'transcript', botId: this.botId, text: e.text, isFinal: e.isFinal });
      },
      onAudio: (e) => {
        this.emit({
          kind: 'audio',
          botId: this.botId,
          audioBase64: Buffer.from(e.audio).toString('base64'),
        });
      },
      onToolCall: (call) => {
        void this.handleToolCall(call);
      },
      onError: (err) => {
        this.emit({ kind: 'error', botId: this.botId, message: err.message });
      },
      onStateChange: (state) => {
        this.emit({ kind: 'state', botId: this.botId, state });
      },
    });
    this.client = client;
    try {
      await client.connect({
        ...config,
        instructions: this.harness.buildSessionInstructions(config.instructions ?? ''),
        tools: this.harness.toRealtimeFunctionDefinitions(),
      });
    } catch (err) {
      this.client = null;
      throw err;
    }
  }

  /**
   * Send one PCM16 audio frame (16 kHz mono, as captured by the
   * renderer's AudioWorklet). The frame must be a non-empty
   * `Uint8Array` with an even byte length — odd-length input is not
   * whole 16-bit samples and is rejected instead of being sent
   * half-decoded. Throws when not connected.
   */
  sendAudio(frame: Uint8Array): void {
    if (!(frame instanceof Uint8Array)) {
      throw new Error('VoiceCallSession: audio frame must be a Uint8Array of PCM16 samples.');
    }
    if (frame.length === 0) {
      throw new Error('VoiceCallSession: audio frame is empty.');
    }
    if (frame.length % 2 !== 0) {
      throw new Error('VoiceCallSession: PCM16 audio must have an even byte length (16-bit samples).');
    }
    if (!this.client?.isConnected()) {
      throw new Error('VoiceCallSession: not connected — call connect() first.');
    }
    this.client.sendAudio(frame);
  }

  /** End the current utterance: commit the buffer + ask the model to respond. */
  commitAudio(): void {
    if (!this.client?.isConnected()) {
      throw new Error('VoiceCallSession: not connected — call connect() first.');
    }
    this.client.commitAudio();
    this.client.requestResponse();
  }

  /**
   * Hang up: close the realtime connection. Surface registrations
   * are kept — the user may call again from the same view without
   * re-registering. Idempotent.
   */
  disconnect(): void {
    if (this.client) {
      try {
        this.client.disconnect();
      } catch {
        // Socket already gone — nothing to do.
      }
      this.client = null;
    }
    this.emit({ kind: 'state', botId: this.botId, state: 'closed' });
  }

  /**
   * Drop the whole session: hang up and forget every surface
   * registration (used when the bot is deleted). The session cannot
   * be used afterwards.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disconnect();
    this.surfaces.clear();
    this.harness.setSurface('desk');
    this.onEvent = undefined;
  }

  // -- internals ----------------------------------------------------------

  /**
   * One tool call from the model: run it through the harness, tell
   * the surface what happened, and send the outcome back to the
   * realtime server as a function output so the model can speak the
   * result. Unknown/invalid calls still get an error output — the
   * realtime conversation stalls if a call is never answered. A
   * served `end_call` hangs up after the result is sent.
   */
  private async handleToolCall(call: RealtimeToolCall): Promise<void> {
    const outcome = await this.harness.executeTool(call.name, call.args);
    this.emit({ kind: 'toolcall', botId: this.botId, call, outcome });
    const outputText =
      outcome.kind === 'served'
        ? truncateToolOutput(outcome.output)
        : `error: ${outcome.error ?? outcome.kind}`;
    const client = this.client;
    if (client?.isConnected() && call.id) {
      try {
        client.sendToolResult(call.id, outputText);
      } catch (err) {
        this.emit({
          kind: 'error',
          botId: this.botId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (outcome.kind === 'served' && outcome.tool === 'end_call') {
      this.disconnect();
    }
  }

  private emit(event: VoiceSessionEventInput): void {
    const sink = this.onEvent;
    if (!sink) return;
    const full: VoiceSessionEvent = {
      ...event,
      surface: this.harness.getSurface(),
      surfaceIds: [...this.surfaces.keys()],
    } as VoiceSessionEvent;
    try {
      sink(full);
    } catch (err) {
      // A throwing sink must not break the call; report it once as an
      // error event (via a direct call so a broken sink cannot loop).
      try {
        sink({
          kind: 'error',
          botId: this.botId,
          message: err instanceof Error ? err.message : String(err),
          surface: this.harness.getSurface(),
          surfaceIds: [...this.surfaces.keys()],
        });
      } catch {
        // Sink is broken — drop it silently rather than crashing.
      }
    }
  }
}

/**
 * Tool outputs travel back over the realtime connection, which cannot
 * carry large results: stringify small values as-is, and cap the text
 * at the voice-call request char limit (the same budget the request
 * side already enforces).
 */
export function truncateToolOutput(output: unknown): string {
  const text =
    typeof output === 'string'
      ? output
      : (() => {
          try {
            return JSON.stringify(output) ?? String(output);
          } catch {
            return String(output);
          }
        })();
  return text.length > VOICE_CALL_REQUEST_CHAR_LIMIT
    ? `${text.slice(0, VOICE_CALL_REQUEST_CHAR_LIMIT)}…`
    : text;
}
