/**
 * Telemetry egress đã ẩn danh (P0-2, theo flag `sand_anonymized_egress_telemetry` của Grok Bot).
 *
 * Chỉ đếm — KHÔNG BAO GIỜ ghi URL, host, path, query, secret hay nội
 * dung request/response. Snapshot chỉ chứa số đếm theo kind + context
 * (context là 'agent' | 'local-service' | 'github-checkout', không
 * phải dữ liệu nhạy cảm). An toàn để ship ra ngoài / ghi log.
 */
import type { EgressContext, EgressErrorKind } from './types';

export type EgressTelemetryKind = EgressErrorKind | 'allowed';

export interface EgressTelemetrySnapshot {
  allowed: number;
  blocked: number;
  unconfigured: number;
  unreachable: number;
  invalid_response: number;
  /** Số đếm theo context — chỉ là nhãn ('agent', 'local-service', 'github-checkout'). */
  byContext: Record<string, number>;
  /** Tổng số lần kiểm tra. */
  total: number;
}

function emptySnapshot(): EgressTelemetrySnapshot {
  return {
    allowed: 0,
    blocked: 0,
    unconfigured: 0,
    unreachable: 0,
    invalid_response: 0,
    byContext: {},
    total: 0,
  };
}

export class EgressTelemetry {
  private counts: EgressTelemetrySnapshot = emptySnapshot();

  /** Ghi một lần kiểm tra egress. Chỉ nhận kind + context — không nhận URL/host. */
  record(kind: EgressTelemetryKind, context: EgressContext): void {
    this.counts[kind] += 1;
    this.counts.total += 1;
    this.counts.byContext[context] = (this.counts.byContext[context] ?? 0) + 1;
  }

  /** Snapshot số đếm (bản copy — mutate snapshot không ảnh hưởng bộ đếm). */
  snapshot(): EgressTelemetrySnapshot {
    return {
      ...this.counts,
      byContext: { ...this.counts.byContext },
    };
  }

  /** Reset toàn bộ bộ đếm về 0. */
  reset(): void {
    this.counts = emptySnapshot();
  }
}

/** Instance global dùng mặc định bởi `checkEgress`/`checkEgressSync` khi caller không truyền telemetry riêng. */
export const defaultEgressTelemetry = new EgressTelemetry();
