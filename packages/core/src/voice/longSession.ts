/**
 * Long voice session (v1.02, Team T5 — realtime voice v2).
 *
 * A realtime voice call can run for a long time: dozens of turns of
 * spoken dialogue. The raw transcript grows without bound, and a
 * realtime model only sees a bounded context window — so a long call
 * either blows the budget or silently forgets the beginning. This
 * module owns the transcript of one long call and keeps it inside a
 * character budget:
 *
 *   addTurn() ──▶ turn log ──▶ over budget? ──▶ compact()
 *                                        (summary + recent turns only)
 *
 * Compaction replaces the oldest turns with a short running summary.
 * The default summarizer is extractive and local (no model call):
 * it keeps the first user request of the compacted span, the
 * questions asked, and the longest substantive lines, so the summary
 * stays faithful to what was actually said. A caller that has a
 * model available can inject an async `summarizer` — `compact()`
 * awaits it, and the extractive summary is kept as the fallback
 * when the model call fails or returns nothing usable.
 *
 * Nothing here touches the network or the socket: it is a pure
 * transcript store the `VoiceSessionV2` wrapper feeds from the
 * session's final-transcript events. Snapshot/restore round-trips
 * through JSON so a long call can survive a reconnect or an app
 * restart (the socket itself is never restored — see
 * voice/voicePersistence.ts for the same rule).
 */

/** One spoken turn in a long voice session. */
export interface VoiceTurn {
  /** Monotonic sequence number inside the session (1-based). */
  seq: number;
  /** Who spoke. */
  speaker: 'user' | 'model';
  /** Final transcript text of the turn (never interim). */
  text: string;
  /** Wall-clock time the turn was recorded (ms since epoch). */
  at: number;
  /** Media items attached to this turn (see voice/mediaContext.ts). */
  mediaIds?: string[];
  /** True when the model was cut off mid-reply by a barge-in. */
  interrupted?: boolean;
  /** True when `text` is only the part spoken before the cut-off. */
  partial?: boolean;
}

/** A summary produced by compacting a span of turns. */
export interface VoiceSessionSummary {
  /** Turn seqs covered by this summary (inclusive). */
  fromSeq: number;
  toSeq: number;
  /** Summary text. */
  text: string;
  /** How the summary was produced. */
  source: 'extractive' | 'model';
  /** When the summary was written (ms since epoch). */
  at: number;
}

/** Events a long session emits (never throws into the caller). */
export type LongVoiceSessionEvent =
  | { kind: 'turn'; turn: VoiceTurn; at: number }
  | {
      kind: 'summary';
      summary: VoiceSessionSummary;
      compactedTurns: number;
      at: number;
    };

export type LongVoiceSessionEventSink = (event: LongVoiceSessionEvent) => void;

/** A model-backed summarizer: turn the given turns into a short
 *  summary (plain text, a few sentences). Return null/'' when it
 *  cannot summarise — the extractive fallback is used instead. */
export type VoiceSummarizer = (turns: readonly VoiceTurn[]) => Promise<string | null>;

/** Stats for the panel / diagnostics. */
export interface LongVoiceSessionStats {
  /** Turns recorded so far (including compacted-away ones). */
  totalTurns: number;
  /** Turns still held in full (not yet compacted). */
  liveTurns: number;
  /** Turns replaced by summaries so far. */
  compactedTurns: number;
  /** Compactions performed so far. */
  compactions: number;
  /** Characters held in live turns. */
  liveChars: number;
  /** Characters held in summaries. */
  summaryChars: number;
  /** Budget this session compacts against (chars). */
  budgetChars: number;
  /** True when the session currently holds a summary. */
  hasSummary: boolean;
}

/** Default context budget: ~8k chars of live transcript. */
export const LONG_SESSION_DEFAULT_BUDGET_CHARS = 8_000;
/** Recent turns always kept in full, even under compaction. */
export const LONG_SESSION_DEFAULT_KEEP_TURNS = 10;
/** Max lines the extractive summary keeps per compacted span. */
export const LONG_SESSION_SUMMARY_MAX_LINES = 8;
/** Max chars of one line kept in the extractive summary. */
export const LONG_SESSION_SUMMARY_MAX_LINE_CHARS = 240;

export interface LongVoiceSessionOptions {
  /** Context budget (chars of live turns + summaries). Default 8000. */
  maxContextChars?: number;
  /** Recent turns always kept in full. Default 10. */
  keepRecentTurns?: number;
  /** Optional model-backed summarizer (see `VoiceSummarizer`). */
  summarizer?: VoiceSummarizer;
  /** Inject the clock (tests). Defaults to `Date.now`. */
  clock?: () => number;
  /** Event sink. Never throws into the session. */
  onEvent?: LongVoiceSessionEventSink;
}

/**
 * Extractive summary of a span of turns: no model, no network.
 * Keeps, in order: the first user turn (what the user asked for),
 * every question line, and the longest substantive model lines —
 * capped at `LONG_SESSION_SUMMARY_MAX_LINES` lines. Each line is
 * prefixed with its speaker so the summary stays attributable.
 * Pure and deterministic, so tests can assert on it exactly.
 */
export function extractiveSummary(turns: readonly VoiceTurn[]): string {
  if (turns.length === 0) return '';
  const lines: string[] = [];
  const seen = new Set<string>();
  const push = (speaker: string, text: string) => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    lines.push(`${speaker === 'user' ? 'User' : 'Bot'}: ${clean.slice(0, LONG_SESSION_SUMMARY_MAX_LINE_CHARS)}`);
  };
  // The first user turn anchors the span (what the call was about).
  const firstUser = turns.find((t) => t.speaker === 'user');
  if (firstUser) push('user', firstUser.text);
  // Questions carry the intent of the span.
  for (const t of turns) {
    if (lines.length >= LONG_SESSION_SUMMARY_MAX_LINES) break;
    if (t.text.includes('?')) push(t.speaker, t.text);
  }
  // Longest remaining lines carry the substance.
  const rest = [...turns]
    .filter((t) => t !== firstUser && !t.text.includes('?'))
    .sort((a, b) => b.text.length - a.text.length);
  for (const t of rest) {
    if (lines.length >= LONG_SESSION_SUMMARY_MAX_LINES) break;
    push(t.speaker, t.text);
  }
  return lines.join('\n');
}

export class LongVoiceSession {
  private readonly maxContextChars: number;
  private readonly keepRecentTurns: number;
  private readonly summarizer: VoiceSummarizer | undefined;
  private readonly clock: () => number;
  private readonly onEvent: LongVoiceSessionEventSink | undefined;
  private turns: VoiceTurn[] = [];
  private summaries: VoiceSessionSummary[] = [];
  private seq = 0;
  private totalTurns = 0;
  private compactedTurns = 0;
  private compactions = 0;

  constructor(options: LongVoiceSessionOptions = {}) {
    this.maxContextChars = Math.max(
      1,
      options.maxContextChars ?? LONG_SESSION_DEFAULT_BUDGET_CHARS,
    );
    this.keepRecentTurns = Math.max(1, options.keepRecentTurns ?? LONG_SESSION_DEFAULT_KEEP_TURNS);
    this.summarizer = options.summarizer;
    this.clock = options.clock ?? Date.now;
    this.onEvent = options.onEvent;
  }

  /** Turns recorded so far (live only — compacted turns are gone). */
  getTurns(): VoiceTurn[] {
    return this.turns.map((t) => ({ ...t }));
  }

  /** Summaries produced so far (oldest first). */
  getSummaries(): VoiceSessionSummary[] {
    return this.summaries.map((s) => ({ ...s }));
  }

  /** Characters currently held (live turns + summaries). */
  getContextChars(): number {
    return (
      this.turns.reduce((n, t) => n + t.text.length, 0) +
      this.summaries.reduce((n, s) => n + s.text.length, 0)
    );
  }

  getStats(): LongVoiceSessionStats {
    return {
      totalTurns: this.totalTurns,
      liveTurns: this.turns.length,
      compactedTurns: this.compactedTurns,
      compactions: this.compactions,
      liveChars: this.turns.reduce((n, t) => n + t.text.length, 0),
      summaryChars: this.summaries.reduce((n, s) => n + s.text.length, 0),
      budgetChars: this.maxContextChars,
      hasSummary: this.summaries.length > 0,
    };
  }

  /** True when the held context is over budget and compaction helps
   *  (there are more live turns than the keep-window). */
  needsCompaction(): boolean {
    return (
      this.getContextChars() > this.maxContextChars &&
      this.turns.length > this.keepRecentTurns
    );
  }

  /**
   * Record one final turn. Empty text is ignored. When the session
   * goes over budget, the oldest turns (beyond the keep-window) are
   * compacted immediately with the extractive summarizer, so the
   * session never grows unbounded even when no model summarizer is
   * configured. Returns the recorded turn, or null when ignored.
   */
  addTurn(
    speaker: 'user' | 'model',
    text: string,
    opts: { mediaIds?: string[]; interrupted?: boolean; partial?: boolean } = {},
  ): VoiceTurn | null {
    const clean = String(text ?? '').trim();
    if (!clean) return null;
    const turn: VoiceTurn = {
      seq: (this.seq += 1),
      speaker,
      text: clean,
      at: this.clock(),
      ...(opts.mediaIds && opts.mediaIds.length > 0 ? { mediaIds: [...opts.mediaIds] } : {}),
      ...(opts.interrupted ? { interrupted: true } : {}),
      ...(opts.partial ? { partial: true } : {}),
    };
    this.turns.push(turn);
    this.totalTurns += 1;
    this.emit({ kind: 'turn', turn: { ...turn }, at: turn.at });
    if (this.needsCompaction()) this.compactSync();
    return { ...turn };
  }

  /**
   * Compact the oldest turns (beyond the keep-window) into one
   * summary, synchronously, with the extractive summarizer. Returns
   * the summary, or null when there was nothing worth compacting.
   */
  compactSync(): VoiceSessionSummary | null {
    if (this.turns.length <= this.keepRecentTurns) return null;
    const span = this.turns.slice(0, this.turns.length - this.keepRecentTurns);
    if (span.length === 0) return null;
    const text = extractiveSummary(span);
    if (!text) return null;
    const summary: VoiceSessionSummary = {
      fromSeq: span[0].seq,
      toSeq: span[span.length - 1].seq,
      text,
      source: 'extractive',
      at: this.clock(),
    };
    this.applySummary(summary, span.length);
    return { ...summary };
  }

  /**
   * Compact with the injected model summarizer when one is set (and
   * it returns usable text); otherwise falls back to the extractive
   * summary. The model summary replaces the same span. Returns the
   * summary, or null when there was nothing worth compacting.
   */
  async compact(): Promise<VoiceSessionSummary | null> {
    if (this.turns.length <= this.keepRecentTurns) return null;
    const span = this.turns.slice(0, this.turns.length - this.keepRecentTurns);
    if (span.length === 0) return null;
    let text = '';
    let source: VoiceSessionSummary['source'] = 'extractive';
    if (this.summarizer) {
      try {
        const modelText = await this.summarizer(span.map((t) => ({ ...t })));
        if (modelText && modelText.trim()) {
          text = modelText.trim().slice(0, LONG_SESSION_SUMMARY_MAX_LINES * LONG_SESSION_SUMMARY_MAX_LINE_CHARS);
          source = 'model';
        }
      } catch {
        // Model summarizer failed — extractive fallback below.
      }
    }
    if (!text) text = extractiveSummary(span);
    if (!text) return null;
    const summary: VoiceSessionSummary = {
      fromSeq: span[0].seq,
      toSeq: span[span.length - 1].seq,
      text,
      source,
      at: this.clock(),
    };
    this.applySummary(summary, span.length);
    return { ...summary };
  }

  /**
   * The context block the model sees: running summaries first, then
   * the live turns in order. Short enough to paste into session
   * instructions or a turn prefix; empty when nothing was said yet.
   */
  getContextBlock(): string {
    const parts: string[] = [];
    if (this.summaries.length > 0) {
      parts.push(
        'Earlier in this call (summarised):\n' +
          this.summaries.map((s) => s.text).join('\n'),
      );
    }
    if (this.turns.length > 0) {
      parts.push(
        'Recent turns:\n' +
          this.turns
            .map((t) => `${t.speaker === 'user' ? 'User' : 'Bot'}${t.partial ? ' (cut off)' : ''}: ${t.text}`)
            .join('\n'),
      );
    }
    return parts.join('\n\n');
  }

  /** JSON snapshot (turns + summaries + counters) for persistence. */
  snapshot(): { turns: VoiceTurn[]; summaries: VoiceSessionSummary[]; seq: number; totalTurns: number; compactedTurns: number; compactions: number } {
    return {
      turns: this.getTurns(),
      summaries: this.getSummaries(),
      seq: this.seq,
      totalTurns: this.totalTurns,
      compactedTurns: this.compactedTurns,
      compactions: this.compactions,
    };
  }

  /** Restore from a snapshot (as produced by `snapshot()`). Unknown
   *  shapes are ignored — a corrupt snapshot never breaks the call. */
  restore(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (!Array.isArray(v.turns) || !Array.isArray(v.summaries)) return false;
    const turns = (v.turns as unknown[]).filter(
      (t): t is VoiceTurn =>
        !!t && typeof t === 'object' &&
        typeof (t as VoiceTurn).seq === 'number' &&
        ((t as VoiceTurn).speaker === 'user' || (t as VoiceTurn).speaker === 'model') &&
        typeof (t as VoiceTurn).text === 'string',
    );
    const summaries = (v.summaries as unknown[]).filter(
      (s): s is VoiceSessionSummary =>
        !!s && typeof s === 'object' && typeof (s as VoiceSessionSummary).text === 'string',
    );
    this.turns = turns.map((t) => ({ ...t }));
    this.summaries = summaries.map((s) => ({ ...s }));
    this.seq = typeof v.seq === 'number' ? v.seq : turns.reduce((m, t) => Math.max(m, t.seq), 0);
    this.totalTurns = typeof v.totalTurns === 'number' ? v.totalTurns : turns.length;
    this.compactedTurns = typeof v.compactedTurns === 'number' ? v.compactedTurns : 0;
    this.compactions = typeof v.compactions === 'number' ? v.compactions : 0;
    return true;
  }

  private applySummary(summary: VoiceSessionSummary, spanLength: number): void {
    this.turns.splice(0, spanLength);
    this.summaries.push(summary);
    this.compactedTurns += spanLength;
    this.compactions += 1;
    this.emit({ kind: 'summary', summary: { ...summary }, compactedTurns: spanLength, at: summary.at });
  }

  private emit(event: LongVoiceSessionEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // A throwing sink must not break the call.
    }
  }
}
