/**
 * @open-bot/core tracing — public surface for the tracing module (v0.10, P0-6).
 *
 * `Tracer` collects spans for one run in memory; `TraceStore` persists
 * finished traces as JSONL under userData. See tracer.ts / store.ts.
 */

export {
  Tracer,
  createTraceId,
  sanitizeText,
  sanitizeValue,
  summarize,
  MAX_SUMMARY_CHARS,
  MAX_SANITIZE_DEPTH,
  SECRET_KEY_RE,
} from './tracer';
export type {
  SpanHandle,
  SpanKind,
  SpanStatus,
  StartSpanOptions,
  Trace,
  TraceSink,
  TraceSpan,
  TraceStatus,
  TracerOptions,
} from './tracer';

export {
  TraceStore,
  TRACES_FILE,
  DEFAULT_MAX_TRACES,
  MAX_SPANS_PER_TRACE,
} from './store';
export type { ListTracesFilter, TraceStoreOptions, TraceSummary } from './store';
