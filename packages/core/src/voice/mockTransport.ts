/**
 * Mock realtime transport (v0.96, Đội T5 — voice live).
 *
 * The fallback when the user has no key: the app must keep working
 * at $0 with no key screen blocking the door, so a realtime session
 * with no Vault key (and no custom URL) runs on this transport
 * instead of failing. It speaks the same `RealtimeTransport`
 * interface as the live adapters, so the session, the barge-in and
 * the UI all behave identically — only the "model" is scripted:
 *
 *   connect() resolves immediately (no socket, no network) →
 *   commitAudio() / requestResponse() "answers" with the next
 *   scripted reply (transcript + a short sine tone as audio, so
 *   the playback path is exercised) → onResponseDone().
 *
 *   cancelResponse() drops a reply that is still "speaking".
 *   sendToolResult() answers with the next scripted reply, like a
 *   model that just got its tool result back.
 *
 * The script is configurable (tests drive exact replies); the
 * default reply says plainly that this is mock mode and where the
 * key goes. `getHealth()` reports `mock: true` so the panel can
 * say so — a mock is never presented as a live adapter.
 */
import type {
  AudioEvent,
  RealtimeProvider,
  RealtimeState,
  RealtimeToolCall,
  TranscriptEvent,
} from './types';
import { REALTIME_OUTPUT_SAMPLE_RATE_HZ } from './types';
import type { RealtimeTransport, RealtimeTransportCallbacks, RealtimeTransportConfig } from './adapters';
import { sinePcm16Frame } from './audio';
import { LatencyStats, type LatencySummary, type TransportHealth } from './transportHealth';

/** One scripted mock reply (text + optional tone length). */
export interface MockRealtimeReply {
  /** What the mock "model" says. */
  text: string;
  /** Tone length (ms) played as model audio. Default 500. */
  audioMs?: number;
}

/** Default mock reply — says plainly this is mock mode. */
export const MOCK_REALTIME_DEFAULT_REPLY: MockRealtimeReply = {
  text: 'Hello — this is mock realtime mode. Add an API key in Settings → API keys to talk to a live model.',
  audioMs: 500,
};

/** Options for the mock transport. */
export interface MockRealtimeTransportOptions {
  /** Scripted replies, in order (last repeats). Default: one default reply. */
  script?: MockRealtimeReply[];
  /** Delay (ms) before a reply starts. Default 50. */
  replyDelayMs?: number;
}

export class MockRealtimeTransport implements RealtimeTransport {
  readonly provider: RealtimeProvider;
  readonly inputSampleRateHz = 16_000;
  readonly outputSampleRateHz = REALTIME_OUTPUT_SAMPLE_RATE_HZ;
  readonly handlesReconnect = false;
  private readonly callbacks: RealtimeTransportCallbacks;
  private readonly script: MockRealtimeReply[];
  private readonly replyDelayMs: number;
  private readonly latency = new LatencyStats();
  private state: RealtimeState = 'idle';
  private replyIndex = 0;
  private replyTimer: ReturnType<typeof setTimeout> | null = null;
  private connectedAt = 0;

  constructor(
    callbacks: RealtimeTransportCallbacks = {},
    options: MockRealtimeTransportOptions = {},
    provider: RealtimeProvider = 'openai',
  ) {
    this.callbacks = callbacks;
    this.provider = provider;
    this.script = options.script && options.script.length > 0 ? options.script : [MOCK_REALTIME_DEFAULT_REPLY];
    this.replyDelayMs = Math.max(0, options.replyDelayMs ?? 50);
  }

  getState(): RealtimeState {
    return this.state;
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  async connect(_config: RealtimeTransportConfig): Promise<void> {
    if (this.state === 'connected') {
      throw new Error('MockRealtimeTransport: already connected.');
    }
    const started = Date.now();
    this.state = 'connected';
    this.connectedAt = started;
    this.latency.record('connect', Date.now() - started);
    this.callbacks.onStateChange?.('connected');
  }

  disconnect(): void {
    this.clearReplyTimer();
    this.state = 'closed';
    this.callbacks.onStateChange?.('closed');
  }

  sendAudio(_chunk: Uint8Array | ArrayBuffer): void {
    if (!this.isConnected()) {
      throw new Error('MockRealtimeTransport: not connected — call connect() first.');
    }
    // Audio is accepted and ignored — the mock answers on commit.
  }

  /** End the turn: the mock answers with the next scripted reply. */
  commitAudio(): void {
    if (!this.isConnected()) {
      throw new Error('MockRealtimeTransport: not connected — call connect() first.');
    }
    this.scheduleReply();
  }

  /** Ask for a reply (same as commit for the mock). */
  requestResponse(): void {
    if (!this.isConnected()) {
      throw new Error('MockRealtimeTransport: not connected — call connect() first.');
    }
    this.scheduleReply();
  }

  /** Barge-in: drop a reply that is still waiting to start. */
  cancelResponse(): void {
    if (!this.isConnected()) {
      throw new Error('MockRealtimeTransport: not connected — call connect() first.');
    }
    this.clearReplyTimer();
  }

  /** Answer a tool call: the mock replies with the next scripted line. */
  sendToolResult(_callId: string, _output: string): void {
    if (!this.isConnected()) {
      throw new Error('MockRealtimeTransport: not connected — call connect() first.');
    }
    this.scheduleReply();
  }

  /** Latency summaries ('connect' only — no network). */
  getLatencyStats(): LatencySummary[] {
    return this.latency.allSummaries();
  }

  /**
   * Health: a mock is healthy by design (it always works), but it
   * reports `mock: true` + `keyConfigured: false` so the UI never
   * presents it as a live adapter.
   */
  getHealth(): TransportHealth {
    const connect = this.latency.summary('connect');
    return {
      provider: this.provider,
      status: 'healthy',
      keyConfigured: false,
      connected: this.isConnected(),
      connectLatencyMs: connect?.lastMs ?? null,
      firstAudioLatencyMs: null,
      failedAttempts: 0,
      detail: 'Mock mode — no live key configured. Add an API key in Settings → API keys for live voice.',
      at: Date.now(),
      mock: true,
    };
  }

  /** Replies served so far (for tests). */
  get repliesServed(): number {
    return this.replyIndex;
  }

  // -- internals ----------------------------------------------------------

  private scheduleReply(): void {
    this.clearReplyTimer();
    const reply = this.script[Math.min(this.replyIndex, this.script.length - 1)] as MockRealtimeReply;
    this.replyIndex += 1;
    this.replyTimer = setTimeout(() => {
      this.replyTimer = null;
      if (!this.isConnected()) return;
      const audioMs = reply.audioMs ?? 500;
      const samples = Math.round((REALTIME_OUTPUT_SAMPLE_RATE_HZ * audioMs) / 1000);
      const audio = sinePcm16Frame(samples, 0.15, 440, REALTIME_OUTPUT_SAMPLE_RATE_HZ);
      const audioEvent: AudioEvent = { audio };
      this.callbacks.onAudio?.(audioEvent);
      const transcript: TranscriptEvent = { text: reply.text, isFinal: true };
      this.callbacks.onTranscript?.(transcript);
      this.callbacks.onResponseDone?.();
    }, this.replyDelayMs);
    if (typeof this.replyTimer === 'object' && this.replyTimer !== null && 'unref' in this.replyTimer) {
      (this.replyTimer as { unref(): void }).unref();
    }
  }

  private clearReplyTimer(): void {
    if (this.replyTimer !== null) {
      clearTimeout(this.replyTimer);
      this.replyTimer = null;
    }
  }
}

/** True when the transport is the mock fallback (not a live adapter). */
export function isMockRealtimeTransport(transport: RealtimeTransport): boolean {
  return transport instanceof MockRealtimeTransport;
}
