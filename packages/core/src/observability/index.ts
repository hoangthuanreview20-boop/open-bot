/**
 * Observability — public surface of `packages/core/src/observability/`.
 *
 * Local-only, OpenTelemetry-flavoured: cost estimates on top of the
 * built-in price table, OTel JSON export to a local file (never sent
 * anywhere), and read-only queries over the trace store.
 */
export { estimateCostDetailed, formatUsd, isKnownModel, isLocalModel, sumCosts } from './cost';
export type { CostDetail } from './cost';
export {
  OtelExporter,
  estimateSpanCost,
  estimateTraceCost,
  readOtelTraces,
  recordApprovalEvent,
  recordCancelEvent,
  recordRetryEvent,
  recordSpanEvent,
  spanToOtel,
  traceToOtel,
} from './otel';
export type { OtelResourceSpan, OtelSpan } from './otel';
export { TraceQuery } from './query';
export type { DayBucket, ModelCost, SpanTimelineEntry, TraceAggregate, TraceQueryFilter } from './query';
