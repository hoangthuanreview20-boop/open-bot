/**
 * OpenTelemetry-style export, local-only (v1.02 rescue port of the
 * v0.99 work).
 *
 * `traceToOtel()` converts a finished open-bot trace into the OTel
 * JSON shape (resource, 32-hex traceId / 16-hex spanId derived from
 * the uuids, unix-nano timestamps, attributes, events, status) so
 * external tools can read it. Nothing is ever sent over the network:
 * `OtelExporter` only appends to a local JSONL file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Trace, TraceSpan } from '../tracing/tracer';
import { estimateCostDetailed } from './cost';

/** One OTel span in JSON form. */
export interface OtelSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string; boolValue?: boolean } }>;
  events: Array<{ name: string; timeUnixNano: string; attributes?: Array<{ key: string; value: { stringValue?: string } }> }>;
  status: { code: string; message?: string };
}

/** One OTel resource span (a whole trace). */
export interface OtelResourceSpan {
  resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
  scopeSpans: Array<{ scope: { name: string; version: string }; spans: OtelSpan[] }>;
}

/** OTel span kinds by open-bot span kind. */
const OTEL_KIND_BY_SPAN_KIND: Record<string, string> = {
  llm: 'SPAN_KIND_CLIENT',
  tool: 'SPAN_KIND_INTERNAL',
  router: 'SPAN_KIND_INTERNAL',
  handoff: 'SPAN_KIND_PRODUCER',
  guardrail: 'SPAN_KIND_INTERNAL',
  approval: 'SPAN_KIND_INTERNAL',
  error: 'SPAN_KIND_INTERNAL',
};

function toHex(value: string, length: number): string {
  const hex = value.replace(/-/g, '').toLowerCase().replace(/[^0-9a-f]/g, '0');
  return (hex + '0'.repeat(length)).slice(0, length);
}

function toNano(epochMs: number | null, fallbackMs: number): string {
  const ms = epochMs ?? fallbackMs;
  return String(BigInt(Math.max(0, Math.floor(ms))) * 1_000_000n);
}

function attributesToOtel(attributes?: Record<string, string | number | boolean>): OtelSpan['attributes'] {
  if (!attributes) return [];
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value:
      typeof value === 'number'
        ? { intValue: String(Math.trunc(value)) }
        : typeof value === 'boolean'
          ? { boolValue: value }
          : { stringValue: String(value) },
  }));
}

/** Convert one span (events carried on the span). */
export function spanToOtel(span: TraceSpan): OtelSpan {
  const endedAt = span.endedAt ?? span.startedAt;
  return {
    traceId: toHex(span.traceId, 32),
    spanId: toHex(span.id, 16),
    ...(span.parentSpanId ? { parentSpanId: toHex(span.parentSpanId, 16) } : {}),
    name: `${span.kind}:${span.name}`,
    kind: OTEL_KIND_BY_SPAN_KIND[span.kind] ?? 'SPAN_KIND_INTERNAL',
    startTimeUnixNano: toNano(span.startedAt, span.startedAt),
    endTimeUnixNano: toNano(endedAt, span.startedAt),
    attributes: attributesToOtel(span.attributes),
    events: (span.events ?? []).map((event) => ({
      name: event.name,
      timeUnixNano: toNano(event.at, span.startedAt),
      ...(event.attributes
        ? { attributes: Object.entries(event.attributes).map(([key, value]) => ({ key, value: { stringValue: String(value) } })) }
        : {}),
    })),
    status: {
      code: span.status === 'error' ? 'STATUS_CODE_ERROR' : span.status === 'ok' ? 'STATUS_CODE_OK' : 'STATUS_CODE_UNSET',
      ...(span.error ? { message: span.error } : {}),
    },
  };
}

/** Convert a whole trace to OTel resource spans. */
export function traceToOtel(trace: Trace): OtelResourceSpan {
  return {
    resource: {
      attributes: [
        { key: 'service.name', value: { stringValue: 'open-bot' } },
        { key: 'openbot.run_id', value: { stringValue: trace.runId } },
        { key: 'openbot.bot_id', value: { stringValue: trace.botId } },
      ],
    },
    scopeSpans: [
      {
        scope: { name: 'open-bot.tracer', version: '1.02.0' },
        spans: trace.spans.map(spanToOtel),
      },
    ],
  };
}

/** Estimated USD cost of one span (LLM spans with model + token attributes). */
export function estimateSpanCost(span: TraceSpan): number | null {
  const model = span.attributes?.model;
  const input = span.attributes?.inputTokens;
  const output = span.attributes?.outputTokens;
  if (typeof model !== 'string' || typeof input !== 'number' || typeof output !== 'number') return null;
  return estimateCostDetailed(model, input, output).costUsd;
}

/** Estimated USD cost of a whole trace (sums known spans; unknown spans contribute 0). */
export function estimateTraceCost(trace: Trace): number {
  return trace.spans.reduce((sum, span) => sum + (estimateSpanCost(span) ?? 0), 0);
}

/** Append an event to a span (mutates the span's `events` list). */
export function recordSpanEvent(span: TraceSpan, name: string, attributes?: Record<string, string | number | boolean>): void {
  span.events = [...(span.events ?? []), { name, at: Date.now(), ...(attributes ? { attributes } : {}) }];
}

/** Record an approval event on a span. */
export function recordApprovalEvent(span: TraceSpan, decision: string, toolName?: string): void {
  recordSpanEvent(span, 'approval', { decision, ...(toolName ? { tool: toolName } : {}) });
}

/** Record a retry event on a span. */
export function recordRetryEvent(span: TraceSpan, attempt: number, reason?: string): void {
  recordSpanEvent(span, 'retry', { attempt, ...(reason ? { reason } : {}) });
}

/** Record a cancellation event on a span. */
export function recordCancelEvent(span: TraceSpan, reason?: string): void {
  recordSpanEvent(span, 'cancel', { ...(reason ? { reason } : {}) });
}

/** Appends OTel traces to a local JSONL file (never sends them anywhere). */
export class OtelExporter {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  exportTrace(trace: Trace): OtelResourceSpan {
    const otel = traceToOtel(trace);
    fs.appendFileSync(this.filePath, `${JSON.stringify(otel)}\n`, 'utf8');
    return otel;
  }
}

/** Read exported OTel traces back (newest first, bad lines skipped). */
export function readOtelTraces(filePath: string, limit = 50): OtelResourceSpan[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const out: OtelResourceSpan[] = [];
  for (const line of raw.split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) out.push(parsed as OtelResourceSpan);
    } catch {
      // Bad line: skip.
    }
    if (out.length >= limit) break;
  }
  return out;
}
