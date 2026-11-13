/**
 * Voice realtime — shared types.
 *
 * NOTE on protocol: the static analysis of Grok Bot 0.79.3
 * (docs/GROK-BOT-ANALYSIS.md §3 #8) only established that its realtime
 * voice call goes over a WebSocket to `wss://api.x.ai/` — the internal
 * realtime protocol of xAI / Grok Bot is NOT in the static analysis, so
 * it cannot be reproduced here. This module therefore implements the
 * PUBLIC OpenAI Realtime API wire shape as its contract (session →
 * audio in/out → transcript → tool call), which is the open standard
 * other providers (OpenAI, xAI's public realtime API, any
 * OpenAI-compatible realtime endpoint) speak. Any provider whose
 * realtime endpoint follows that shape can plug in by giving
 * RealtimeClient its WebSocket URL; nothing here depends on xAI-
 * specific behaviour. No code, text or asset of xAI/Cursor is copied.
 *
 * Audio is PCM16 mono (16 kHz in, 24 kHz out by default — the OpenAI
 * Realtime defaults); the renderer captures with MediaRecorder and the
 * main process converts to PCM16 before calling `sendAudio` (see
 * docs/v04-worker3-integration.md).
 */

/** Minimal WebSocket surface RealtimeClient needs. Deliberately small so
 *  tests can inject a mock and so the client never depends on the `ws`
 *  npm package: in Electron main / Node 22+ the global `WebSocket`
 *  satisfies this interface. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
}

/** Factory that creates the underlying socket. Defaults to the global
 *  `WebSocket`; inject a mock in tests or a `ws`-backed adapter. */
export type WebSocketFactory = (url: string, protocols?: string | string[]) => WebSocketLike;

export type RealtimeState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface RealtimeConfig {
  /**
   * Realtime WebSocket URL, e.g. `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview`.
   * Optional since v0.95 (Đội D3): the Gemini adapter builds its URL
   * from the API key when no URL is given.
   */
  url?: string;
  /** Bearer token for the realtime endpoint. Never logged. */
  apiKey?: string;
  /** Model for the realtime session (provider-specific). */
  model?: string;
  /** Voice for spoken replies (provider-specific, e.g. "alloy"). */
  voice?: string;
  /** Extra headers the factory may need (only used by factories that
   *  support them — the global WebSocket cannot send custom headers;
   *  providers that need auth headers normally take the key in the URL
   *  query or a subprotocol instead). */
  headers?: Record<string, string>;
  /** Max reconnect attempts after an unexpected drop. Default 20
   *  (VOICE_REDIAL_MAX_ATTEMPTS — redial policy, P0-1). */
  maxReconnectAttempts?: number;
  /** Base delay (ms) before the first reconnect; doubled each attempt
   *  up to `reconnectMaxDelayMs`. Default 1000. */
  reconnectDelayMs?: number;
  /** Backoff cap (ms) for reconnects. Default 10000. */
  reconnectMaxDelayMs?: number;
  /** Per-attempt dial timeout (ms): a socket that never opens within
   *  this long counts as one spent attempt. Default 15000. */
  dialTimeoutMs?: number;
  /** Max redials for "silent path" drops (a connection that closed
   *  without ever delivering a server message). Default 3. */
  maxSilentPathRedials?: number;
  /** Inject the socket (tests / `ws` adapter). Defaults to global WebSocket. */
  socketFactory?: WebSocketFactory;
  /** Session instructions sent on `session.update` after connect. */
  instructions?: string;
  /** Function definitions offered to the model in `session.update`
   *  (v0.56: the voice-call toolset from VoiceCallHarness — the only
   *  tools the model sees during a voice call). */
  tools?: Array<Record<string, unknown>>;
  /** Input audio format. Default "pcm16". */
  inputAudioFormat?: string;
  /** Output audio format. Default "pcm16". */
  outputAudioFormat?: string;
  /**
   * v0.95 (Đội D3): turn detection for the session. Default
   * `'server_vad'` (the server commits on silence). `'none'` means
   * manual turns — the client commits with `input_audio_buffer.commit`
   * + `response.create` (local_vad / push_to_talk modes).
   */
  turnDetection?: 'server_vad' | 'none';
}

/** One transcript update from the server. `isFinal` is true on the
 *  `...transcript.done` event; delta events carry partial text. */
export interface TranscriptEvent {
  /** Full accumulated transcript text for this response so far. */
  text: string;
  isFinal: boolean;
}

/** A tool call requested by the realtime model
 *  (`response.function_call_arguments.done`). */
export interface RealtimeToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Raw audio bytes coming back from the server (`response.audio.delta`,
 *  base64-decoded). The renderer plays them (e.g. via AudioContext). */
export interface AudioEvent {
  /** PCM16 bytes (see `outputAudioFormat`). */
  audio: Uint8Array;
}

export interface RealtimeCallbacks {
  onTranscript?: (event: TranscriptEvent) => void;
  onToolCall?: (call: RealtimeToolCall) => void;
  /** Audio chunks for playback; absent when the caller only wants text. */
  onAudio?: (event: AudioEvent) => void;
  onError?: (error: Error) => void;
  onStateChange?: (state: RealtimeState) => void;
  /** v0.95 (Đội D3): server VAD heard the user start speaking
   *  (`input_audio_buffer.speech_started`). The session uses it for
   *  barge-in while the model is speaking. */
  onSpeechStarted?: () => void;
  /** v0.95 (Đội D3): server VAD heard the user stop speaking
   *  (`input_audio_buffer.speech_stopped`). */
  onSpeechStopped?: () => void;
  /** v0.95 (Đội D3): the model finished a response (`response.done`).
   *  The session uses it to end the model's turn. */
  onResponseDone?: () => void;
}

/** Options for voice-memo transcription (see voice/memo.ts). */
export interface TranscriptionOptions {
  /** Base URL of an OpenAI-compatible API, e.g. `https://api.openai.com/v1`
   *  or the local Ollama-compatible endpoint. The request goes to
   *  `{baseUrl}/audio/transcriptions`. */
  baseUrl: string;
  /** Bearer token; omitted for local endpoints (Ollama needs none). */
  apiKey?: string;
  /** STT model, e.g. "whisper-1". Default "whisper-1". */
  model?: string;
  /** BCP-47 language hint, e.g. "vi". Omit to let the server detect. */
  language?: string;
  /** Extra request timeout (ms). Default 120_000. */
  timeoutMs?: number;
  /** Inject fetch (tests). Defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** MIME type sent for the audio part. Default "audio/webm" (voice memo).
   *  Dictation (voice/dictation.ts) sends PCM16 wrapped in WAV and passes
   *  "audio/wav" here so the STT server picks the right decoder. */
  audioMimeType?: string;
  /** Filename sent for the audio part. Default "voice-memo.webm". */
  fileName?: string;
}

// ---------------------------------------------------------------------------
// Voice redial policy (P0-1, REA deep-dive §5.2)
// ---------------------------------------------------------------------------
//
// Architecture constants learned from the static analysis of Grok Bot
// 0.79.3 (docs/rea-grokbot-deep-dive.md §5.2): the reference client
// redials up to 20 times with a 1s→10s backoff, a 15s dial timeout per
// attempt, and a separate budget of 3 redials for a "silent path"
// (a connection that drops without ever delivering a message). Close
// codes 1008 (policy) and 4001 (superseded — a newer session replaced
// this one) are terminal: they must NOT trigger a redial. The numbers
// are the only thing taken from that analysis; the implementation here
// is original, on top of the public OpenAI Realtime contract.

/** Max redial attempts after an unexpected drop. Default 20. */
export const VOICE_REDIAL_MAX_ATTEMPTS = 20;
/** Per-attempt dial timeout: a socket that never opens within this long
 *  counts as one spent attempt. Default 15_000 ms. */
export const VOICE_REDIAL_DIAL_TIMEOUT_MS = 15_000;
/** Backoff before the first redial. Default 1_000 ms. */
export const VOICE_REDIAL_INITIAL_DELAY_MS = 1_000;
/** Backoff cap: delay doubles per attempt but never exceeds this. */
export const VOICE_REDIAL_MAX_DELAY_MS = 10_000;
/** Max redials for "silent path" drops (connection closed without ever
 *  delivering a server message). Default 3. */
export const VOICE_REDIAL_MAX_SILENT_PATH_REDIALS = 3;
/** WebSocket close code: the call was refused by policy. Terminal. */
export const VOICE_CALL_POLICY_CLOSE_CODE = 1008;
/** WebSocket close code: this session was superseded by a newer one.
 *  Terminal — the old connection must stop cleanly, not fight the new
 *  one for the call. */
export const VOICE_CALL_SUPERSEDED_CLOSE_CODE = 4001;

// ---------------------------------------------------------------------------
// Voice surface register (P0-1, REA deep-dive §5.5)
// ---------------------------------------------------------------------------

/** Screen/context the user is looking at while on a voice call. The
 *  spoken reply must fit what they can already see: on a desk screen
 *  they see the transcript/diff/editor, so the voice answer stays short
 *  (file name + key numbers, no long paths, no repeated verbal receipts
 *  — earcons cover those); in a car there is no screen at all, so it
 *  must be shorter still. */
export type VoiceSurface = 'desk' | 'web' | 'phone' | 'carplay' | 'headphones';

export const VOICE_SURFACES: readonly VoiceSurface[] = [
  'desk',
  'web',
  'phone',
  'carplay',
  'headphones',
];

/** Max spoken-reply length (chars) per surface. CarPlay is the
 *  tightest: driving, no screen to fall back on. */
export const VOICE_SURFACE_MAX_REPLY_CHARS: Record<VoiceSurface, number> = {
  desk: 600,
  web: 400,
  phone: 280,
  carplay: 160,
  headphones: 280,
};

/** Short instruction per surface, injected into the realtime session
 *  instructions so the model shapes its spoken replies. Written
 *  originally for open-bot (not copied from any reference client). */
export const VOICE_SURFACE_GUIDANCE: Record<VoiceSurface, string> = {
  desk: 'The user can see the chat transcript, diff, and editor on screen. Keep spoken replies concise: name the key file or identifier and the key numbers, skip full directory paths, skip long lists unless they ask for a walkthrough, and do not repeat what is already visible as a verbal receipt.',
  web: 'The user is on the web client and can see the chat transcript on screen. Keep spoken replies short: give the outcome and the one or two facts that matter, skip long paths and lists.',
  phone: 'The user is on a phone with a small screen. Keep spoken replies very short: one outcome, one key fact at a time, no paths, no lists unless asked.',
  carplay: 'The user is driving with CarPlay and cannot look at a screen. Keep spoken replies extremely short: only the outcome and what they need to do next, in one or two short sentences.',
  headphones: 'The user is listening on headphones with no screen in front of them. Keep spoken replies short and self-contained: state the outcome and the key facts out loud, since nothing is visible to fall back on.',
};

/** True when `value` is a known voice surface. */
export function isVoiceSurface(value: unknown): value is VoiceSurface {
  return typeof value === 'string' && (VOICE_SURFACES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Voice-call toolset (P0-1, REA deep-dive §5.3)
// ---------------------------------------------------------------------------

/** Tools available ONLY inside a voice call. They are deliberately NOT
 *  part of the agent's general tool registry: a voice call is a
 *  different interaction (short spoken turns, no screen to show a file
 *  diff on), so the model gets this small set — nudge the working agent,
 *  peek at agents/runs/changes, recall/search past text, stay silent,
 *  switch agent, transfer, or hang up. */
export type VoiceCallToolName =
  | 'nudge'
  | 'peek_agents'
  | 'peek_runs'
  | 'peek_changes'
  | 'recall_texts'
  | 'search_conversations'
  | 'stay_silent'
  | 'switch_agent'
  | 'transfer'
  | 'end_call';

/** Max total chars across all string arguments of one voice-call tool
 *  request. The realtime connection cannot carry large tool results,
 *  so requests stay small by construction. */
export const VOICE_CALL_REQUEST_CHAR_LIMIT = 4000;

/** One voice-call tool definition with its per-field char limits. */
export interface VoiceCallToolDefinition {
  name: VoiceCallToolName;
  description: string;
  /** Per-argument char limit (string args only). */
  parameters: Record<string, { charLimit: number; required?: boolean }>;
  /** Max total chars across all string arguments. */
  maxRequestChars: number;
}

export const VOICE_CALL_TOOL_DEFINITIONS: readonly VoiceCallToolDefinition[] = [
  {
    name: 'nudge',
    description: 'Nudge the agent that is currently working: hand it a short task or check what it is doing.',
    parameters: { task: { charLimit: 2000, required: true }, to: { charLimit: 200 } },
    maxRequestChars: VOICE_CALL_REQUEST_CHAR_LIMIT,
  },
  {
    name: 'peek_agents',
    description: 'List what each agent is currently doing.',
    parameters: { filter: { charLimit: 200 } },
    maxRequestChars: VOICE_CALL_REQUEST_CHAR_LIMIT,
  },
  {
    name: 'peek_runs',
    description: 'List the runs currently in progress.',
    parameters: { query: { charLimit: 200 } },
    maxRequestChars: VOICE_CALL_REQUEST_CHAR_LIMIT,
  },
  {
    name: 'peek_changes',
    description: 'List recent file changes made by the working agent.',
    parameters: { file: { charLimit: 500 } },
    maxRequestChars: VOICE_CALL_REQUEST_CHAR_LIMIT,
  },
  {
    name: 'recall_texts',
    description: 'Recall recent text messages from the conversation.',
    parameters: { query: { charLimit: 500 } },
    maxRequestChars: VOICE_CALL_REQUEST_CHAR_LIMIT,
  },
  {
    name: 'search_conversations',
    description: 'Search past conversations for something said before.',
    parameters: {
      query: { charLimit: 500, required: true },
      scope: { charLimit: 200 },
      quote: { charLimit: 1000 },
      context: { charLimit: 2000 },
    },
    maxRequestChars: VOICE_CALL_REQUEST_CHAR_LIMIT,
  },
  {
    name: 'stay_silent',
    description: 'Stay silent on this turn instead of speaking a reply.',
    parameters: { reason: { charLimit: 200 } },
    maxRequestChars: VOICE_CALL_REQUEST_CHAR_LIMIT,
  },
  {
    name: 'switch_agent',
    description: 'Switch the voice call to a different agent.',
    parameters: { target: { charLimit: 200, required: true } },
    maxRequestChars: VOICE_CALL_REQUEST_CHAR_LIMIT,
  },
  {
    name: 'transfer',
    description: 'Transfer the call to another agent or destination.',
    parameters: { target: { charLimit: 200, required: true } },
    maxRequestChars: VOICE_CALL_REQUEST_CHAR_LIMIT,
  },
  {
    name: 'end_call',
    description: 'End the voice call.',
    parameters: { reason: { charLimit: 200 } },
    maxRequestChars: VOICE_CALL_REQUEST_CHAR_LIMIT,
  },
];

/** Max search hits returned by `search_conversations` in a voice call. */
export const VOICE_CALL_SEARCH_HIT_LIMIT = 10;

// ---------------------------------------------------------------------------
// Voice-call harness outcomes (P0-1, REA deep-dive §5.4)
// ---------------------------------------------------------------------------

/** Outcome of executing one voice-call tool through the harness:
 *  `served` (ran and returned output), `unknown_tool` (no such
 *  voice-call tool, or no handler bound for it in this call), or
 *  `invalid_input` (arguments failed validation, or the tool itself
 *  failed while running — details in `error`). */
export type VoiceCallHarnessOutcomeKind = 'served' | 'unknown_tool' | 'invalid_input';

export interface VoiceCallHarnessOutcome {
  kind: VoiceCallHarnessOutcomeKind;
  /** Tool that was requested (even when unknown). */
  tool: string;
  /** Handler output, present only when kind is `served`. */
  output?: unknown;
  /** Human-readable reason, present when kind is not `served`. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Voice-call chimes / earcons (P0-1, REA deep-dive §5.3)
// ---------------------------------------------------------------------------

/** Earcon notes (frequencies in Hz) the renderer plays with WebAudio:
 *  a rising two-note chime when a call connects, a falling one when it
 *  ends. Short audio cues stand in for repetitive verbal receipts
 *  while on a call. */
export const VOICE_CALL_CHIME_NOTES: Record<'connect' | 'disconnect', readonly number[]> = {
  connect: [880, 1174.66],
  disconnect: [659.25, 440],
};

/** Options for STT dictation (see voice/dictation.ts). Extends the
 *  memo transcription options with the PCM16 sample rate. */
export interface DictationOptions extends TranscriptionOptions {
  /** Sample rate of the PCM16 audio in Hz. Default 16000. */
  sampleRateHz?: number;
  /** Max buffered PCM16 bytes per dictation session. Default 25 MB. */
  maxBytes?: number;
}

// ---------------------------------------------------------------------------
// Realtime session (v0.95, Đội D3 — voice realtime duplex)
// ---------------------------------------------------------------------------
//
// `RealtimeClient` (voice/realtime.ts) already speaks the OpenAI
// Realtime wire; the session layer above it (voice/realtimeSession.ts)
// owns the conversation state machine, barge-in and turn-taking, and
// the pluggable audio source/sink. The provider adapters
// (voice/adapters.ts) translate each provider's wire into one common
// transport interface, so the session never sees provider wire
// shapes. Audio constants below come from the providers' public docs
// (OpenAI Realtime: PCM16 24 kHz in/out; Gemini Live: PCM16 16 kHz
// in, 24 kHz out) — see docs/voice-realtime-v095.md.

/** Realtime voice provider. `openai-compatible` covers any endpoint
 *  that speaks the OpenAI Realtime wire shape. */
export type RealtimeProvider = 'openai' | 'gemini' | 'openai-compatible';

export const REALTIME_PROVIDERS: readonly RealtimeProvider[] = [
  'openai',
  'gemini',
  'openai-compatible',
];

/** True when `value` names a realtime provider. */
export function isRealtimeProvider(value: unknown): value is RealtimeProvider {
  return typeof value === 'string' && (REALTIME_PROVIDERS as readonly string[]).includes(value);
}

/** How turns are decided in a realtime session. */
export type TurnTakingMode =
  /** The server's VAD decides turn boundaries (default). The client
   *  streams mic audio continuously; the server commits on silence
   *  and fires `speech_started` for barge-in. */
  | 'server_vad'
  /** A local energy VAD (voice/audio.ts) decides: speech start while
   *  the model speaks is a barge-in; speech end commits the turn. */
  | 'local_vad'
  /** Mic audio is only sent while the user holds the talk button;
   *  releasing it commits the turn. */
  | 'push_to_talk';

export const TURN_TAKING_MODES: readonly TurnTakingMode[] = [
  'server_vad',
  'local_vad',
  'push_to_talk',
];

/** True when `value` names a turn-taking mode. */
export function isTurnTakingMode(value: unknown): value is TurnTakingMode {
  return typeof value === 'string' && (TURN_TAKING_MODES as readonly string[]).includes(value);
}

/** Conversation state of a `RealtimeSession`. Distinct from the
 *  socket state (`RealtimeState`): a session can be `listening`
 *  while the socket is `connected`, and `interrupted` is a
 *  momentary state — the session returns to `listening` once the
 *  barge-in is handled and playback is flushed. */
export type RealtimeSessionState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'speaking'
  | 'interrupted'
  | 'reconnecting'
  | 'closed';

/** Mic sample rate (Hz) the renderer captures (AudioWorklet). */
export const REALTIME_MIC_SAMPLE_RATE_HZ = 16_000;
/** PCM16 input rate the OpenAI Realtime API expects. */
export const OPENAI_REALTIME_INPUT_SAMPLE_RATE_HZ = 24_000;
/** PCM16 input rate the Gemini Live API expects. */
export const GEMINI_LIVE_INPUT_SAMPLE_RATE_HZ = 16_000;
/** PCM16 output rate both providers stream back. */
export const REALTIME_OUTPUT_SAMPLE_RATE_HZ = 24_000;
/** Audio is forwarded to the transport in frames of this length. */
export const REALTIME_FRAME_MS = 100;
/** Bytes in one 100 ms PCM16 mono frame at 16 kHz. */
export const REALTIME_FRAME_BYTES_16K = (REALTIME_MIC_SAMPLE_RATE_HZ * REALTIME_FRAME_MS) / 1000 * 2;
/** Bytes in one 100 ms PCM16 mono frame at 24 kHz. */
export const REALTIME_FRAME_BYTES_24K = (REALTIME_OUTPUT_SAMPLE_RATE_HZ * REALTIME_FRAME_MS) / 1000 * 2;

/** One event a `RealtimeSession` emits to its sink (the desktop main
 *  process forwards these to the renderer / event log). Transcript
 *  and audio events reuse the shapes the voice call already emits;
 *  `interrupted` / `turn` / `state` are new in v0.95. */
export type RealtimeSessionEvent =
  | { kind: 'transcript'; text: string; isFinal: boolean; at: number }
  | { kind: 'audio'; audioBase64: string; sampleRateHz: number; at: number }
  | { kind: 'state'; state: RealtimeSessionState; at: number }
  | {
      kind: 'interrupted';
      /** Where the barge-in was detected: the server's VAD or the
       *  local VAD (or the user pressing the interrupt button). */
      source: 'server_vad' | 'local_vad' | 'manual';
      at: number;
    }
  | {
      kind: 'turn';
      /** `user` when the user finished a turn, `model` when the
       *  model finished speaking. */
      speaker: 'user' | 'model';
      at: number;
    }
  | { kind: 'toolcall'; call: RealtimeToolCall; at: number }
  | { kind: 'error'; message: string; at: number };

/** Sink for `RealtimeSession` events. Never throws into the session. */
export type RealtimeSessionEventSink = (event: RealtimeSessionEvent) => void;
