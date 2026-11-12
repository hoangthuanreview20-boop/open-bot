/**
 * Run tracing — v0.10 (P0-6, research-a2a-claudecode-frameworks.md §6.2).
 *
 * OpenAI Agents SDK keeps a structured trace per run (one span per LLM
 * call, tool call, handoff, guardrail decision); open-bot had none, so a
 * bad run could only be debugged from scattered logs + chat history.
 * This module is the local-first equivalent: a `Tracer` collects spans
 * for one run in memory, and `TraceStore` (store.ts) persists finished
 * traces as JSONL under userData. Nothing is sent anywhere.
 *
 * SECRET RULE — spans only ever carry SUMMARIES, and every summary is
 * sanitised before it is stored (see `sanitizeSummary`): object keys
 * that look like credentials (`apiKey`, `token`, `secret`, `password`,
 * `authorization`, …) become `'<redacted>'`, `Bearer <token>` shapes
 * and known `sk-…` / `xai-…` key shapes are redacted, and known secret
 * values passed in via `TracerOptions.secrets` are replaced literally.
 * The loop/coordinator wiring that emits spans (loop.ts, coordinator.ts)
 * is deliberately NOT part of this change — it lands separately and
 * only has to call `startSpan` / `finishSpan` / `save`.
 *
 * No file access here: the tracer is pure in-memory + injectable clock,
 * so it is unit-testable without Electron or a userData dir.
 */

import { randomUUID } from 'node:crypto';
import { redactBearer, redactSecrets, REDACTED } from '../util/redact';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What kind of work a span records. Matches the P0-6 list + `error`. */
export type SpanKind = 'llm' | 'tool' | 'handoff' | 'guardrail' | 'approval' | 'error';

/** A span that is still open, finished cleanly, finished with an error, or blocked by a guardrail/approval. */
export type SpanStatus = 'ok' | 'error' | 'pending' | 'blocked';

/** Overall outcome of a finished trace. */
export type TraceStatus = 'ok' | 'error' | 'running';

/** One timed step inside a run. All payloads are summaries, never raw secrets (see header). */
export interface TraceSpan {
  id: string;
  traceId: string;
  runId: string;
  botId: string;
  kind: SpanKind;
  /** Short label, e.g. the tool name, the model id, or `transfer_to_researcher`. */
  name: string;
  /** Epoch ms (from the tracer clock) when the span started. */
  startedAt: number;
  /** Epoch ms when the span finished, or null while it is still open. */
  endedAt: number | null;
  /** `endedAt - startedAt` in ms, or null while the span is still open. */
  durationMs: number | null;
  status: SpanStatus;
  /** Sanitised + truncated summary of the span input (tool args, prompt excerpt, …). */
  inputSummary?: string;
  /** Sanitised + truncated summary of the span output (tool result excerpt, …). */
  outputSummary?: string;
  /** Error message (sanitised) when `status === 'error'`. */
  error?: string;
  /** Id of the enclosing span, when this span was started inside another one. */
  parentSpanId?: string;
  /** Small flat attributes (model, token counts, guardrail verdict, …). Values are sanitised like summaries. */
  attributes?: Record<string, string | number | boolean>;
}

/** One run, as a list of spans in start order. */
export interface Trace {
  traceId: string;
  runId: string;
  botId: string;
  /** Epoch ms of the earliest span (or tracer creation when there are no spans). */
  startedAt: number;
  /** Epoch ms of the latest finished span, or null while the run is still going. */
  endedAt: number | null;
  durationMs: number | null;
  status: TraceStatus;
  /** Token usage summed over finished spans that reported it (LLM spans). */
  totalInputTokens: number;
  /** Token usage summed over finished spans that reported it (LLM spans). */
  totalOutputTokens: number;
  spans: TraceSpan[];
}

// ---------------------------------------------------------------------------
// Sanitisation (never let a secret reach a span)
// ---------------------------------------------------------------------------

/** Summaries are excerpts, not full payloads. */
export const MAX_SUMMARY_CHARS = 500;
/** How deep `sanitizeValue` walks nested objects/arrays before truncating. */
export const MAX_SANITIZE_DEPTH = 4;

/** Object keys whose value is always a credential. */
export const SECRET_KEY_RE =
  /api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|password|passwd|pwd|auth|credential|bearer|private[-_]?key|session[-_]?key/i;

/**
 * v0.33 (P0-6): attribute keys that look like credentials to
 * `SECRET_KEY_RE` but are really numeric token COUNTS, not secrets
 * (`inputTokens` contains "token"). `sanitizeValue` must never redact
 * their values, or trace token totals would always read 0.
 */
export const TOKEN_COUNT_KEYS: ReadonlySet<string> = new Set(['inputTokens', 'outputTokens']);

/** Provider key shapes (`sk-…`, `xai-…`, `sk-ant-…`) even when the exact value is unknown. */
const KNOWN_KEY_SHAPE_RE = /\b(?:sk-ant|sk|xai)-[A-Za-z0-9_-]{8,}\b/g;
/** `apiKey: <value>` / `token=<value>` / `password: <value>` shapes inside free text. */
const KEY_VALUE_SHAPE_RE =
  /\b(api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|passwd|token)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi;

/**
 * Sanitise one string: redact known secret values, Bearer shapes and
 * known key shapes, then truncate to `MAX_SUMMARY_CHARS`.
 */
export function sanitizeText(text: string, secrets: string[] = []): string {
  if (typeof text !== 'string') return '';
  let out = redactBearer(redactSecrets(text, secrets));
  out = out.replace(KNOWN_KEY_SHAPE_RE, REDACTED);
  out = out.replace(KEY_VALUE_SHAPE_RE, (_m, key: string) => `${key}=${REDACTED}`);
  if (out.length > MAX_SUMMARY_CHARS) {
    out = `${out.slice(0, MAX_SUMMARY_CHARS)}… [truncated]`;
  }
  return out;
}

/**
 * Recursively sanitise an arbitrary value for a span summary: object
 * keys matching `SECRET_KEY_RE` become `'<redacted>'`, strings are run
 * through `sanitizeText`, other scalars pass through. Depth-capped so
 * a deeply nested / cyclic-ish payload cannot blow up the trace.
 */
export function sanitizeValue(value: unknown, secrets: string[] = [], depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeText(value, secrets);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_SANITIZE_DEPTH) {
    return sanitizeText(typeof value === 'object' ? JSON.stringify(value) ?? '' : String(value), secrets);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeValue(item, secrets, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // v0.33: token-count keys (inputTokens/outputTokens) are numeric
      // counters, not credentials — never redact them (see TOKEN_COUNT_KEYS).
      out[key] =
        SECRET_KEY_RE.test(key) && !TOKEN_COUNT_KEYS.has(key)
          ? REDACTED
          : sanitizeValue(item, secrets, depth + 1);
    }
    return out;
  }
  return sanitizeText(String(value), secrets);
}

/**
 * Turn any value into a span summary string: strings are sanitised
 * directly, anything else is JSON-stringified after `sanitizeValue`
 * (unstringifiable values fall back to `String(value)`).
 */
export function summarize(value: unknown, secrets: string[] = []): string {
  if (typeof value === 'string') return sanitizeText(value, secrets);
  if (value === undefined) return '';
  try {
    return sanitizeText(JSON.stringify(sanitizeValue(value, secrets)) ?? '', secrets);
  } catch {
    return sanitizeText(String(value), secrets);
  }
}

// ---------------------------------------------------------------------------
// Tracer
// ---------------------------------------------------------------------------

export interface TracerOptions {
  /** Defaults to a fresh uuid (one trace per run). */
  traceId?: string;
  /** The run this trace belongs to (coordinator run id). */
  runId: string;
  /** The bot whose run this is. */
  botId: string;
  /** Clock override (tests). Defaults to `() => Date.now()`. */
  now?: () => number;
  /** Secret values that must never appear in a summary (API keys, tokens, …). */
  secrets?: string[];
}

export interface StartSpanOptions {
  /** Span input (tool args, prompt excerpt, …) — stored only as a sanitised summary. */
  input?: unknown;
  /** Id of the enclosing span, for nested spans. */
  parentSpanId?: string;
  /** Small flat attributes (model, token counts, verdict, …). */
  attributes?: Record<string, string | number | boolean>;
}

/** Handle returned by `startSpan`: the span plus finish helpers. */
export interface SpanHandle {
  span: TraceSpan;
  /** Finish cleanly with an optional output summary. */
  finish: (output?: unknown) => TraceSpan;
  /** Finish as failed with an error (message is sanitised). */
  fail: (error: unknown) => TraceSpan;
  /** Finish as blocked (guardrail / approval denied the step). */
  block: (reason?: string) => TraceSpan;
  /**
   * v0.33 (P0-6): merge extra attributes into the span (sanitised like
   * startSpan attributes). For values known only when the span ends —
   * e.g. an LLM span's token usage — call this before finish/fail, so
   * the trace totals (see `toTrace`) pick them up. No-op on a span
   * that is already finished.
   */
  setAttributes: (attributes: Record<string, string | number | boolean>) => void;
}

/** A store-shaped sink `save()` accepts (structural — no import cycle with store.ts). */
export interface TraceSink {
  appendTrace: (trace: Trace) => void;
}

/** New trace id (uuid). One trace per run; the coordinator assigns it. */
export function createTraceId(): string {
  return randomUUID();
}

function requireNonEmpty(value: string, what: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Tracer needs a non-empty ${what}.`);
  }
  return value;
}

export class Tracer {
  readonly traceId: string;
  readonly runId: string;
  readonly botId: string;
  private readonly now: () => number;
  private readonly secrets: string[];
  private readonly createdAt: number;
  private readonly spanList: TraceSpan[] = [];
  /** v0.33 (P0-6): token totals, accumulated as spans finish (see `accumulateTokens`). */
  private totalInputTokens = 0;
  private totalOutputTokens = 0;

  constructor(options: TracerOptions) {
    this.traceId = options.traceId ?? createTraceId();
    this.runId = requireNonEmpty(options.runId, 'runId');
    this.botId = requireNonEmpty(options.botId, 'botId');
    this.now = options.now ?? (() => Date.now());
    this.secrets = Array.isArray(options.secrets) ? options.secrets : [];
    this.createdAt = this.now();
  }

  /** Spans in start order (a copy — mutating it does not affect the tracer). */
  get spans(): TraceSpan[] {
    return [...this.spanList];
  }

  /** Number of spans recorded so far (open + finished). */
  get spanCount(): number {
    return this.spanList.length;
  }

  /**
   * v0.33 (P0-6): token totals accumulated so far (finished spans only).
   */
  get totals(): { inputTokens: number; outputTokens: number } {
    return { inputTokens: this.totalInputTokens, outputTokens: this.totalOutputTokens };
  }

  /**
   * v0.33 (P0-6, fork-execution): a child tracer for one fork subagent
   * — same trace/run/bot ids, same clock and same known secrets, but
   * its own span list. The loop hands it to the fork child and, when
   * the fork finishes, copies only the child's TOKEN TOTALS onto the
   * fork's handoff span (see `executeForkSkills`): the child's raw
   * spans never enter the parent trace — a subagent returns a summary,
   * not its raw context — and a timed-out/errored child can never
   * leave a pending/error span that mislabels the parent run's trace
   * as 'running'/'error'.
   */
  childTracer(): Tracer {
    return new Tracer({
      traceId: this.traceId,
      runId: this.runId,
      botId: this.botId,
      now: this.now,
      secrets: [...this.secrets],
    });
  }

  /**
   * Start a span. The returned handle finishes it; `finishSpan` /
   * `failSpan` do the same by id for callers that only keep the id.
   */
  startSpan(kind: SpanKind, name: string, options: StartSpanOptions = {}): SpanHandle {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('Tracer.startSpan needs a non-empty span name.');
    }
    const span: TraceSpan = {
      id: randomUUID(),
      traceId: this.traceId,
      runId: this.runId,
      botId: this.botId,
      kind,
      name,
      startedAt: this.now(),
      endedAt: null,
      durationMs: null,
      status: 'pending',
    };
    if (options.input !== undefined) span.inputSummary = summarize(options.input, this.secrets);
    if (options.parentSpanId) span.parentSpanId = options.parentSpanId;
    if (options.attributes) {
      span.attributes = sanitizeValue(options.attributes, this.secrets) as Record<
        string,
        string | number | boolean
      >;
    }
    this.spanList.push(span);
    const handle: SpanHandle = {
      span,
      // `?? span`: the span was just created (pending), so finish/fail/
      // block always return it — the fallback only covers the
      // already-finished second call, which returns the span as-is.
      finish: (output?: unknown) => this.finishSpan(span.id, output) ?? span,
      fail: (error: unknown) => this.failSpan(span.id, error) ?? span,
      block: (reason?: string) => this.blockSpan(span.id, reason) ?? span,
      // v0.33 (P0-6): attributes known only at finish time (token
      // usage). Sanitised; ignored once the span is finished.
      setAttributes: (attributes) => {
        if (span.status !== 'pending') return;
        const clean = sanitizeValue(attributes, this.secrets) as Record<
          string,
          string | number | boolean
        >;
        span.attributes = { ...(span.attributes ?? {}), ...clean };
      },
    };
    return handle;
  }

  /**
   * Record an already-finished span in one call (for spans timed by
   * the caller, e.g. a tool call measured around an await). Returns
   * the stored span. `startedAt`/`endedAt` are epoch ms; when omitted
   * they default to now (zero duration).
   */
  completeSpan(
    kind: SpanKind,
    name: string,
    options: StartSpanOptions & {
      output?: unknown;
      error?: unknown;
      startedAt?: number;
      endedAt?: number;
    } = {},
  ): TraceSpan {
    const handle = this.startSpan(kind, name, options);
    const span = handle.span;
    if (typeof options.startedAt === 'number') span.startedAt = options.startedAt;
    if (options.error !== undefined && options.error !== null) {
      return this.failSpan(span.id, options.error, options.endedAt) ?? span;
    }
    return this.finishSpan(span.id, options.output, options.endedAt) ?? span;
  }

  /**
   * v0.33 (P0-6): fold a finished span's token attributes into the
   * run totals. Only numeric `inputTokens`/`outputTokens` count; a
   * span finished twice is a no-op in the finishers below, so it can
   * never be counted twice.
   */
  private accumulateTokens(span: TraceSpan): void {
    const input = span.attributes?.['inputTokens'];
    const output = span.attributes?.['outputTokens'];
    if (typeof input === 'number' && Number.isFinite(input) && input > 0) {
      this.totalInputTokens += Math.floor(input);
    }
    if (typeof output === 'number' && Number.isFinite(output) && output > 0) {
      this.totalOutputTokens += Math.floor(output);
    }
  }

  /**
   * Finish a span by id. Returns the span, or null when the id is
   * unknown (already-finished spans are left untouched — finishing
   * twice is a no-op that returns the span as-is).
   */
  finishSpan(spanId: string, output?: unknown, endedAt?: number): TraceSpan | null {
    const span = this.spanList.find((s) => s.id === spanId);
    if (!span || span.status !== 'pending') return span ?? null;
    span.endedAt = typeof endedAt === 'number' ? endedAt : this.now();
    span.durationMs = Math.max(0, span.endedAt - span.startedAt);
    span.status = 'ok';
    if (output !== undefined) span.outputSummary = summarize(output, this.secrets);
    this.accumulateTokens(span);
    return span;
  }

  /** Finish a span as failed. The error message is sanitised; Error objects contribute their message. */
  failSpan(spanId: string, error: unknown, endedAt?: number): TraceSpan | null {
    const span = this.spanList.find((s) => s.id === spanId);
    if (!span || span.status !== 'pending') return span ?? null;
    span.endedAt = typeof endedAt === 'number' ? endedAt : this.now();
    span.durationMs = Math.max(0, span.endedAt - span.startedAt);
    span.status = 'error';
    span.error = sanitizeText(
      error instanceof Error ? error.message : typeof error === 'string' ? error : String(error),
      this.secrets,
    );
    this.accumulateTokens(span);
    return span;
  }

  /** Finish a span as blocked (a guardrail tripped or an approval was denied). */
  blockSpan(spanId: string, reason?: string): TraceSpan | null {
    const span = this.spanList.find((s) => s.id === spanId);
    if (!span || span.status !== 'pending') return span ?? null;
    span.endedAt = this.now();
    span.durationMs = Math.max(0, span.endedAt - span.startedAt);
    span.status = 'blocked';
    if (reason !== undefined) span.outputSummary = summarize(reason, this.secrets);
    this.accumulateTokens(span);
    return span;
  }

  /**
   * Snapshot the run as a finished `Trace`. Open spans stay open
   * (`endedAt: null`, `status: 'pending'`) and the trace status is
   * 'running' unless a span errored (then 'error') or `status` is
   * given explicitly. Spans are returned in start order.
   */
  toTrace(status?: TraceStatus): Trace {
    const spans = [...this.spanList].sort((a, b) => a.startedAt - b.startedAt);
    const startedAt = spans.length > 0 ? spans[0].startedAt : this.createdAt;
    const finished = spans.filter((s) => s.endedAt !== null);
    const endedAt = finished.length > 0 ? Math.max(...finished.map((s) => s.endedAt as number)) : null;
    return {
      traceId: this.traceId,
      runId: this.runId,
      botId: this.botId,
      startedAt,
      endedAt,
      durationMs: endedAt !== null ? Math.max(0, endedAt - startedAt) : null,
      status:
        status ??
        (spans.some((s) => s.status === 'error')
          ? 'error'
          : spans.some((s) => s.status === 'pending')
            ? 'running'
            : 'ok'),
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      spans,
    };
  }

  /**
   * Persist the finished trace through a store (or any
   * `TraceSink`). Returns the trace that was stored.
   */
  save(sink: TraceSink, status?: TraceStatus): Trace {
    const trace = this.toTrace(status);
    sink.appendTrace(trace);
    return trace;
  }
}
