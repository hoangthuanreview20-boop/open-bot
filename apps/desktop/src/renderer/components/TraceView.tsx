/**
 * TraceView — replay one run as a timeline of spans (v0.10, P0-6).
 *
 * The trace list (newest first) comes from IPC `traces:list`; one
 * trace's spans come from `traces:get`. Data is read-only from the
 * local JSONL file in userData — the renderer never writes traces,
 * and spans only carry sanitised summaries, so this screen never
 * sees an API key or token.
 *
 * IPC goes through the `callOpenBot` helper (the SettingsView/TeamView
 * pattern): try the channel name first, then the camelCase spelling;
 * when preload has not exposed the method yet it returns null and
 * the UI reports "unavailable" instead of crashing.
 */
import { useCallback, useEffect, useState } from 'react';
import type { TraceDetailView, TraceSpanView, TraceSummaryView } from '../types';
import { useT } from '../i18n/useT';

async function callOpenBot<T>(channel: string, camel: string, ...args: unknown[]): Promise<T | null> {
  const api = window.openBot as unknown as Record<string, unknown>;
  const fn = api[channel] ?? api[camel];
  if (typeof fn !== 'function') return null;
  return (fn as (...a: unknown[]) => Promise<T>).apply(window.openBot, args);
}

const KIND_COLORS: Record<TraceSpanView['kind'], string> = {
  llm: '#7c3aed',
  tool: '#0369a1',
  handoff: '#b45309',
  guardrail: '#be185d',
  approval: '#15803d',
  error: '#b91c1c',
};

const KIND_LABELS: Record<TraceSpanView['kind'], string> = {
  llm: 'LLM',
  tool: 'Tool',
  handoff: 'Handoff',
  guardrail: 'Guardrail',
  approval: 'Approval',
  error: 'Error',
};

function formatMs(ms: number | null): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatTime(epochMs: number): string {
  try {
    return new Date(epochMs).toLocaleString();
  } catch {
    return String(epochMs);
  }
}

function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

interface Props {
  onBack: () => void;
  /** When set, only traces of this bot are listed. */
  botId?: string | null;
}

export default function TraceView({ onBack, botId }: Props) {
  const t = useT();
  const [traces, setTraces] = useState<TraceSummaryView[]>([]);
  const [selected, setSelected] = useState<TraceDetailView | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const list = await callOpenBot<TraceSummaryView[]>(
        'traces:list',
        'listTraces',
        botId ? { botId, limit: 100 } : { limit: 100 },
      );
      if (list === null) {
        setError(t('trace.unavailable'));
        setTraces([]);
      } else {
        setTraces(list);
        setError('');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('trace.loadError'));
      setTraces([]);
    } finally {
      setLoading(false);
    }
  }, [botId, t]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const openTrace = async (traceId: string) => {
    setDetailLoading(true);
    setError('');
    try {
      const detail = await callOpenBot<TraceDetailView>('traces:get', 'getTrace', { traceId });
      if (detail === null) {
        setError(t('trace.notFound'));
        setSelected(null);
      } else {
        setSelected(detail);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('trace.loadError'));
      setSelected(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const traceStart = selected ? selected.startedAt : 0;
  const traceTotal = selected?.durationMs ?? 0;

  /** v0.33 (P0-6): total tokens of a trace (0 when the trace predates token totals). */
  const totalTokens = (tr: TraceSummaryView | TraceDetailView): number =>
    (tr.totalInputTokens ?? 0) + (tr.totalOutputTokens ?? 0);

  return (
    <div className="panel">
      <button className="btn secondary" onClick={onBack}>{t('trace.back')}</button>
      <h2>{t('trace.title')}</h2>
      <p>{t('trace.intro')}</p>
      {loading && <p>{t('trace.loading')}</p>}
      {error && <p className="error">{error}</p>}

      {!selected && !loading && traces.length === 0 && !error && (
        <p className="empty">
          {t('trace.emptyLine1')}
          <br />
          {t('trace.emptyLine2')}
        </p>
      )}

      {!selected && traces.length > 0 && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>
              {t('trace.count', { count: String(traces.length) })}
            </span>
            <button className="btn secondary" onClick={() => void loadList()} disabled={loading}>
              {t('trace.refresh')}
            </button>
          </div>
          <ul className="task-list">
            {traces.map((tr) => (
              <li key={tr.traceId}>
                <button
                  type="button"
                  onClick={() => void openTrace(tr.traceId)}
                  style={{
                    all: 'unset',
                    display: 'block',
                    width: '100%',
                    cursor: 'pointer',
                  }}
                >
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <strong>run {shortId(tr.runId)}</strong>
                    <span className={`badge ${tr.status === 'ok' ? 'done' : tr.status === 'error' ? 'failed' : 'running'}`}>
                      {t(`trace.status.${tr.status}`)}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 4 }}>
                    {formatTime(tr.startedAt)} · {formatMs(tr.durationMs)} ·{' '}
                    {t('trace.spanCount', { count: String(tr.spanCount) })} · {tr.kinds.map((k) => KIND_LABELS[k]).join(', ')}
                    {totalTokens(tr) > 0 && <> · {t('trace.tokens', { count: String(totalTokens(tr)) })}</>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                    bot {shortId(tr.botId)} · trace {shortId(tr.traceId)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {selected && (
        <section>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <button className="btn secondary" onClick={() => setSelected(null)}>
              {t('trace.backToList')}
            </button>
            <button className="btn secondary" onClick={() => void openTrace(selected.traceId)} disabled={detailLoading}>
              {t('trace.refresh')}
            </button>
          </div>
          <h3 style={{ margin: '12px 0 4px' }}>run {shortId(selected.runId)}</h3>
          <p style={{ margin: '0 0 12px', color: 'var(--text-dim)', fontSize: 13 }}>
            {formatTime(selected.startedAt)} · {t('trace.totalTime', { time: formatMs(selected.durationMs) })} ·{' '}
            {t('trace.spanCount', { count: String(selected.spans.length) })}
            {totalTokens(selected) > 0 && <> · {t('trace.tokens', { count: String(totalTokens(selected)) })}</>}
          </p>
          {detailLoading && <p>{t('trace.loading')}</p>}
          {selected.spans.length === 0 && !detailLoading && <p className="empty">{t('trace.noSpans')}</p>}
          <ul className="task-list">
            {[...selected.spans]
              .sort((a, b) => a.startedAt - b.startedAt)
              .map((span) => {
                const offset = traceTotal > 0 ? Math.max(0, span.startedAt - traceStart) : 0;
                const widthPct =
                  traceTotal > 0 && span.durationMs !== null
                    ? Math.max(1.5, (span.durationMs / traceTotal) * 100)
                    : 1.5;
                return (
                  <li key={span.id}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span>
                        <span
                          className="badge"
                          style={{
                            background: KIND_COLORS[span.kind],
                            color: '#fff',
                            marginRight: 8,
                          }}
                        >
                          {KIND_LABELS[span.kind]}
                        </span>
                        <strong>{span.name}</strong>
                      </span>
                      <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                        +{formatMs(offset)} · {formatMs(span.durationMs)} ·{' '}
                        {span.status === 'ok'
                          ? '✓'
                          : span.status === 'error'
                            ? `✗ ${t('trace.status.error')}`
                            : span.status === 'blocked'
                              ? `⊘ ${t('trace.status.blocked')}`
                              : t('trace.status.running')}
                      </span>
                    </div>
                    {/* Timeline bar: position + length relative to the whole trace. */}
                    <div
                      style={{
                        height: 6,
                        borderRadius: 3,
                        background: 'var(--border)',
                        margin: '8px 0 4px',
                        position: 'relative',
                      }}
                    >
                      <div
                        style={{
                          position: 'absolute',
                          left: `${traceTotal > 0 ? (offset / traceTotal) * 100 : 0}%`,
                          width: `${widthPct}%`,
                          height: '100%',
                          borderRadius: 3,
                          background: KIND_COLORS[span.kind],
                        }}
                      />
                    </div>
                    {span.inputSummary && (
                      <p style={{ margin: '4px 0', fontSize: 13, wordBreak: 'break-word' }}>
                        <span style={{ color: 'var(--text-dim)' }}>{t('trace.input')}: </span>
                        {span.inputSummary}
                      </p>
                    )}
                    {span.outputSummary && (
                      <p style={{ margin: '4px 0', fontSize: 13, wordBreak: 'break-word' }}>
                        <span style={{ color: 'var(--text-dim)' }}>{t('trace.output')}: </span>
                        {span.outputSummary}
                      </p>
                    )}
                    {span.error && <p className="error" style={{ margin: '4px 0' }}>{span.error}</p>}
                    {span.attributes && Object.keys(span.attributes).length > 0 && (
                      <p style={{ margin: '4px 0', fontSize: 12, color: 'var(--text-dim)' }}>
                        {Object.entries(span.attributes)
                          .map(([k, v]) => `${k}=${String(v)}`)
                          .join(' · ')}
                      </p>
                    )}
                  </li>
                );
              })}
          </ul>
        </section>
      )}
    </div>
  );
}
