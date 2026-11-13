/**
 * AG-UI event bus (v0.97, Team T3).
 *
 * A small, synchronous, best-effort fan-out bus for AG-UI events. It is
 * deliberately separate from the harness bus: harness events describe
 * what CLI drivers and the loop did (already sanitised, NDJSON-logged),
 * while AG-UI events describe what the *user should see* — the run
 * lifecycle, streaming text, tool progress, shared state and
 * generative-UI requests. The runtime emitter (runtime.ts) bridges the
 * two when a run is served by an API provider.
 *
 * Guarantees:
 * - `publish` never throws: a throwing handler is counted and skipped,
 *   an invalid event is dropped and counted, never delivered.
 * - Every published event gets a per-run monotonic `sequence` (the bus
 *   keeps one counter per runId), so consumers can spot gaps.
 * - A bounded replay buffer (per run, newest N events) lets a late
 *   subscriber — an SSE client that reconnects, a renderer panel opened
 *   mid-run — catch up without re-running anything. The buffer is
 *   in-memory only; restarting the app drops it (runs are ephemeral).
 * - Subscribers filter by runId / botId / threadId / types / minSequence.
 * - Silent runs (automations / dreams) never reach this bus: the
 *   emitter checks the silent flag before publishing, exactly like the
 *   harness forwarder does.
 */

import { validateAgUiEvent } from './validate';
import type { AgUiEvent, AgUiEventFilter, AgUiEventHandler } from './types';

/** Default number of events kept per run in the replay buffer. */
export const AG_UI_REPLAY_BUFFER_PER_RUN = 200;
/** Hard cap on runs kept in the replay buffer (oldest run evicted first). */
export const AG_UI_REPLAY_MAX_RUNS = 50;

export interface AgUiBusStats {
  published: number;
  delivered: number;
  droppedInvalid: number;
  handlerErrors: number;
  subscribers: number;
  bufferedRuns: number;
  bufferedEvents: number;
}

interface SubscriberEntry {
  filter: AgUiEventFilter;
  handler: AgUiEventHandler;
}

function eventMatchesFilter(event: AgUiEvent, filter: AgUiEventFilter): boolean {
  if (filter.runId !== undefined && filter.runId !== event.runId) return false;
  if (filter.botId !== undefined && filter.botId !== event.botId) return false;
  if (filter.threadId !== undefined && filter.threadId !== event.threadId) return false;
  if (filter.types !== undefined && !filter.types.includes(event.type)) return false;
  if (
    filter.minSequence !== undefined &&
    (event.sequence === undefined || event.sequence < filter.minSequence)
  ) {
    return false;
  }
  return true;
}

export class AgUiEventBus {
  private readonly subscribers = new Set<SubscriberEntry>();
  /** Per-run sequence counters (runId -> next sequence number). */
  private readonly sequences = new Map<string, number>();
  /** Per-run replay buffers (runId -> events, oldest first). */
  private readonly buffers = new Map<string, AgUiEvent[]>();
  private publishedTotal = 0;
  private deliveredTotal = 0;
  private droppedInvalidTotal = 0;
  private handlerErrorsTotal = 0;
  private readonly replayPerRun: number;
  private readonly replayMaxRuns: number;

  constructor(opts?: { replayPerRun?: number; replayMaxRuns?: number }) {
    this.replayPerRun =
      opts?.replayPerRun !== undefined && opts.replayPerRun > 0
        ? Math.floor(opts.replayPerRun)
        : AG_UI_REPLAY_BUFFER_PER_RUN;
    this.replayMaxRuns =
      opts?.replayMaxRuns !== undefined && opts.replayMaxRuns > 0
        ? Math.floor(opts.replayMaxRuns)
        : AG_UI_REPLAY_MAX_RUNS;
  }

  /** Total events published (including ones with no subscriber). */
  get totalPublished(): number {
    return this.publishedTotal;
  }

  /** Total events dropped because they failed validation. */
  get totalDroppedInvalid(): number {
    return this.droppedInvalidTotal;
  }

  /** Total handler throws swallowed by the bus. */
  get totalHandlerErrors(): number {
    return this.handlerErrorsTotal;
  }

  /** Current subscriber count. */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Number of runs with a non-empty replay buffer. */
  get bufferedRunCount(): number {
    return this.buffers.size;
  }

  get stats(): AgUiBusStats {
    let bufferedEvents = 0;
    for (const events of this.buffers.values()) bufferedEvents += events.length;
    return {
      published: this.publishedTotal,
      delivered: this.deliveredTotal,
      droppedInvalid: this.droppedInvalidTotal,
      handlerErrors: this.handlerErrorsTotal,
      subscribers: this.subscribers.size,
      bufferedRuns: this.buffers.size,
      bufferedEvents,
    };
  }

  /**
   * Subscribe to events matching `filter`. Returns an unsubscribe
   * function (idempotent). The handler runs synchronously inside
   * `publish`; it must not throw (the bus swallows and counts throws)
   * and must not publish back into the same bus synchronously.
   */
  subscribe(filter: AgUiEventFilter, handler: AgUiEventHandler): () => void {
    const entry: SubscriberEntry = {
      filter: { ...filter, ...(filter.types ? { types: [...filter.types] } : {}) },
      handler,
    };
    this.subscribers.add(entry);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.subscribers.delete(entry);
    };
  }

  /**
   * Publish one event. The event is validated first (invalid events
   * are dropped and counted, never delivered); a valid event gets its
   * per-run `sequence`, is appended to the run's replay buffer, then
   * fanned out to matching subscribers. Never throws.
   *
   * Returns the published event (with `sequence` set), or `null` when
   * the event was dropped as invalid.
   */
  publish(event: AgUiEvent): AgUiEvent | null {
    let cleaned: AgUiEvent;
    try {
      cleaned = validateAgUiEvent(event);
    } catch {
      this.droppedInvalidTotal += 1;
      return null;
    }
    const next = this.sequences.get(cleaned.runId) ?? 0;
    this.sequences.set(cleaned.runId, next + 1);
    const withSequence: AgUiEvent = { ...cleaned, sequence: next };
    this.appendToBuffer(withSequence);
    this.publishedTotal += 1;
    for (const { filter, handler } of [...this.subscribers]) {
      if (!eventMatchesFilter(withSequence, filter)) continue;
      try {
        handler(withSequence);
        this.deliveredTotal += 1;
      } catch {
        this.handlerErrorsTotal += 1;
      }
    }
    return withSequence;
  }

  /**
   * Replay buffered events for a run, in sequence order. `fromSequence`
   * (inclusive) skips older events — an SSE client passes its last
   * received sequence + 1 here. Returns a copy; mutating it cannot
   * corrupt the buffer.
   */
  replay(runId: string, fromSequence = 0): AgUiEvent[] {
    const buffered = this.buffers.get(runId);
    if (!buffered) return [];
    return buffered
      .filter((event) => (event.sequence ?? 0) >= fromSequence)
      .map((event) => ({ ...event, data: { ...event.data } }));
  }

  /** Replay buffered events for a run that match `filter` (types etc.). */
  replayFiltered(runId: string, filter: AgUiEventFilter): AgUiEvent[] {
    return this.replay(runId, filter.minSequence ?? 0).filter((event) =>
      eventMatchesFilter(event, filter),
    );
  }

  /** Last buffered event of a run, or `undefined` when the run is unknown. */
  lastEvent(runId: string): AgUiEvent | undefined {
    const buffered = this.buffers.get(runId);
    if (!buffered || buffered.length === 0) return undefined;
    return buffered[buffered.length - 1];
  }

  /** Run ids currently in the replay buffer, oldest first. */
  bufferedRunIds(): string[] {
    return [...this.buffers.keys()];
  }

  /** Drop the replay buffer (and sequence counter) of one run. */
  clearRun(runId: string): void {
    this.buffers.delete(runId);
    this.sequences.delete(runId);
  }

  /** Drop every replay buffer and sequence counter. Subscribers stay. */
  clearAll(): void {
    this.buffers.clear();
    this.sequences.clear();
  }

  private appendToBuffer(event: AgUiEvent): void {
    let buffer = this.buffers.get(event.runId);
    if (!buffer) {
      buffer = [];
      this.buffers.set(event.runId, buffer);
      // Evict the oldest run when the cap is hit, so one busy bot
      // cannot grow the buffer without bound.
      while (this.buffers.size > this.replayMaxRuns) {
        const oldest = this.buffers.keys().next().value;
        if (oldest === undefined) break;
        if (oldest === event.runId) break;
        this.buffers.delete(oldest);
        this.sequences.delete(oldest);
      }
    }
    buffer.push(event);
    while (buffer.length > this.replayPerRun) buffer.shift();
  }
}

/** Match helper exported for the SSE layer and for tests. */
export function agUiEventMatchesFilter(event: AgUiEvent, filter: AgUiEventFilter): boolean {
  return eventMatchesFilter(event, filter);
}
