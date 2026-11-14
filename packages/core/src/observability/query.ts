/**
 * Trace queries — filter, aggregate, and time-bucket finished traces
 * (v1.02 rescue port of the v0.99 work).
 *
 * `TraceQuery` reads from a `TraceStore` (local JSONL) and answers
 * the questions the Traces UI asks: which traces match, how much
 * did they cost, which spans were slow or failed, and how does cost
 * break down by day / bot / model. All computation is local and
 * read-only.
 */

import type { Trace, TraceSpan } from '../tracing/tracer';
import type { TraceStore } from '../tracing/store';
import { estimateSpanCost, estimateTraceCost } from './otel';
import { estimateCostDetailed } from './cost';

export interface TraceQueryFilter {
  botId?: string;
  runId?: string;
  /** Only traces starting at or after this epoch ms. */
  fromMs?: number;
  /** Only traces starting at or before this epoch ms. */
  toMs?: number;
  /** Only traces with status 'error'. */
  onlyErrors?: boolean;
  /** Only traces with a span of this kind. */
  kind?: string;
  /** Only traces lasting at least this long (ms). */
  minDurationMs?: number;
  /** Max traces returned (newest first). */
  limit?: number;
}

export interface TraceAggregate {
  count: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  maxDurationMs: number;
  errorCount: number;
}

export interface DayBucket {
  /** Local date (YYYY-MM-DD). */
  day: string;
  traces: number;
  costUsd: number;
}

export interface ModelCost {
  model: string;
  calls: number;
  costUsd: number;
  /** False when the model has no known price (cost reads 0). */
  known: boolean;
}

export interface SpanTimelineEntry {
  span: TraceSpan;
  /** Offset from the trace start (ms). */
  offsetMs: number;
  /** Width as a fraction of the trace duration (0..1). */
  width: number;
  /** Nesting depth (parent chain length). */
  depth: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

function localDay(epochMs: number): string {
  const date = new Date(epochMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Read-only queries over a TraceStore. */
export class TraceQuery {
  private readonly store: TraceStore;

  constructor(store: TraceStore) {
    this.store = store;
  }

  /** All traces matching the filter (newest first). */
  query(filter: TraceQueryFilter = {}): Trace[] {
    const summaries = this.store.listTraces({
      ...(filter.botId ? { botId: filter.botId } : {}),
      ...(filter.runId ? { runId: filter.runId } : {}),
    });
    const traces: Trace[] = [];
    for (const summary of summaries) {
      const trace = this.store.getTrace(summary.traceId);
      if (!trace) continue;
      if (filter.fromMs !== undefined && trace.startedAt < filter.fromMs) continue;
      if (filter.toMs !== undefined && trace.startedAt > filter.toMs) continue;
      if (filter.onlyErrors && trace.status !== 'error') continue;
      if (filter.kind && !trace.spans.some((s) => s.kind === filter.kind)) continue;
      if (filter.minDurationMs !== undefined && (trace.durationMs ?? 0) < filter.minDurationMs) continue;
      traces.push(trace);
    }
    traces.sort((a, b) => b.startedAt - a.startedAt);
    return filter.limit !== undefined ? traces.slice(0, filter.limit) : traces;
  }

  /** Aggregate statistics over the filtered traces. */
  aggregate(filter: TraceQueryFilter = {}): TraceAggregate {
    const traces = this.query(filter);
    const durations = traces
      .map((t) => t.durationMs ?? 0)
      .filter((d) => d > 0)
      .sort((a, b) => a - b);
    return {
      count: traces.length,
      totalInputTokens: traces.reduce((sum, t) => sum + t.totalInputTokens, 0),
      totalOutputTokens: traces.reduce((sum, t) => sum + t.totalOutputTokens, 0),
      totalCostUsd: traces.reduce((sum, t) => sum + estimateTraceCost(t), 0),
      avgDurationMs: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
      p50DurationMs: percentile(durations, 50),
      p95DurationMs: percentile(durations, 95),
      maxDurationMs: durations.length > 0 ? durations[durations.length - 1] : 0,
      errorCount: traces.filter((t) => t.status === 'error').length,
    };
  }

  /** One aggregate row per bot. */
  aggregateByBot(filter: TraceQueryFilter = {}): Array<{ botId: string } & TraceAggregate> {
    const traces = this.query(filter);
    const byBot = new Map<string, Trace[]>();
    for (const trace of traces) {
      const list = byBot.get(trace.botId) ?? [];
      list.push(trace);
      byBot.set(trace.botId, list);
    }
    return [...byBot.entries()].map(([botId, botTraces]) => ({
      botId,
      ...this.aggregateTraces(botTraces),
    }));
  }

  /** Trace count + cost per local day. */
  bucketByDay(filter: TraceQueryFilter = {}): DayBucket[] {
    const byDay = new Map<string, DayBucket>();
    for (const trace of this.query(filter)) {
      const day = localDay(trace.startedAt);
      const bucket = byDay.get(day) ?? { day, traces: 0, costUsd: 0 };
      bucket.traces++;
      bucket.costUsd += estimateTraceCost(trace);
      byDay.set(day, bucket);
    }
    return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  }

  /** Estimated cost per model (unknown models listed with known: false). */
  costByModel(filter: TraceQueryFilter = {}): ModelCost[] {
    const byModel = new Map<string, ModelCost>();
    for (const trace of this.query(filter)) {
      for (const span of trace.spans) {
        if (span.kind !== 'llm') continue;
        const model = typeof span.attributes?.model === 'string' ? span.attributes.model : 'unknown';
        const input = typeof span.attributes?.inputTokens === 'number' ? span.attributes.inputTokens : 0;
        const output = typeof span.attributes?.outputTokens === 'number' ? span.attributes.outputTokens : 0;
        const cost = estimateSpanCost(span) ?? 0;
        const row = byModel.get(model) ?? {
          model,
          calls: 0,
          costUsd: 0,
          known: estimateCostDetailed(model, 0, 0).known,
        };
        row.calls++;
        row.costUsd += cost;
        byModel.set(model, row);
      }
    }
    return [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd);
  }

  /** Spans slower than `minDurationMs` (newest trace first). */
  findSlowSpans(filter: TraceQueryFilter, minDurationMs: number): Array<{ trace: Trace; span: TraceSpan }> {
    const out: Array<{ trace: Trace; span: TraceSpan }> = [];
    for (const trace of this.query(filter)) {
      for (const span of trace.spans) {
        if ((span.durationMs ?? 0) >= minDurationMs) out.push({ trace, span });
      }
    }
    return out;
  }

  /** Spans with status 'error'. */
  findErrorSpans(filter: TraceQueryFilter = {}): Array<{ trace: Trace; span: TraceSpan }> {
    const out: Array<{ trace: Trace; span: TraceSpan }> = [];
    for (const trace of this.query(filter)) {
      for (const span of trace.spans) {
        if (span.status === 'error') out.push({ trace, span });
      }
    }
    return out;
  }

  /** Timeline entries for one trace (offset/width/depth for the UI). */
  timeline(trace: Trace): SpanTimelineEntry[] {
    const total = trace.durationMs ?? Math.max(1, ...trace.spans.map((s) => (s.endedAt ?? s.startedAt) - trace.startedAt));
    const byId = new Map(trace.spans.map((s) => [s.id, s]));
    const depthOf = (span: TraceSpan): number => {
      let depth = 0;
      let current = span;
      while (current.parentSpanId && byId.has(current.parentSpanId) && depth < 50) {
        depth++;
        current = byId.get(current.parentSpanId)!;
      }
      return depth;
    };
    return trace.spans.map((span) => ({
      span,
      offsetMs: span.startedAt - trace.startedAt,
      width: total > 0 ? Math.min(1, (span.durationMs ?? 0) / total) : 0,
      depth: depthOf(span),
    }));
  }

  private aggregateTraces(traces: Trace[]): TraceAggregate {
    const durations = traces
      .map((t) => t.durationMs ?? 0)
      .filter((d) => d > 0)
      .sort((a, b) => a - b);
    return {
      count: traces.length,
      totalInputTokens: traces.reduce((sum, t) => sum + t.totalInputTokens, 0),
      totalOutputTokens: traces.reduce((sum, t) => sum + t.totalOutputTokens, 0),
      totalCostUsd: traces.reduce((sum, t) => sum + estimateTraceCost(t), 0),
      avgDurationMs: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
      p50DurationMs: percentile(durations, 50),
      p95DurationMs: percentile(durations, 95),
      maxDurationMs: durations.length > 0 ? durations[durations.length - 1] : 0,
      errorCount: traces.filter((t) => t.status === 'error').length,
    };
  }
}
