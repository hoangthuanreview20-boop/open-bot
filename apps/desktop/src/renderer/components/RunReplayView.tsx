/**
 * RunReplayView — replay a run from the event-sourced run log (v1.01, Team T1).
 *
 * Left: run list (newest first, with status + event/tool/file/error
 * counts). Right: the selected run's event timeline — filter by event
 * type, click a row to see its payload, fork from any event, pause /
 * resume a running run, export JSONL, verify the hash chain, and view
 * the replayed state of the run.
 *
 * Data flows through IPC `runlog:*` (the coordinator child reads the
 * store under `<userDataDir>/run-logs/`). Payloads are already
 * sanitised in core (no secrets, tool args keep key names only), so
 * the UI renders them directly.
 * IPC goes through the `callOpenBot` helper (the EventLogView pattern):
 * try the channel name first, then the camelCase spelling; when
 * preload is not ready yet it returns null and the UI reports
 * "unavailable" instead of crashing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  RunLogEventView,
  RunLogMetaView,
  RunLogVerificationView,
  RunReplayStateView,
} from '../types';
import { useT } from '../i18n/useT';

async function callOpenBot<T>(channel: string, camel: string, ...args: unknown[]): Promise<T | null> {
  const api = window.openBot as unknown as Record<string, unknown>;
  const fn = api[channel] ?? api[camel];
  if (typeof fn !== 'function') return null;
  return (fn as (...a: unknown[]) => Promise<T>).apply(window.openBot, args);
}

const PAGE_LIMIT = 100;

/** Every event type of the run log (see `packages/core/src/event-log/types.ts`). */
const ALL_TYPES = [
  'run.started',
  'run.prompt',
  'model.response',
  'tool.call',
  'tool.result',
  'file.change',
  'compile.error',
  'run.paused',
  'run.resumed',
  'run.forked',
  'run.completed',
  'run.failed',
  'run.aborted',
  'approval.request',
  'approval.decision',
  'checkpoint.saved',
] as const;

type RunEventTypeView = (typeof ALL_TYPES)[number];

const TYPE_COLORS: Record<RunEventTypeView, string> = {
  'run.started': '#475569',
  'run.prompt': '#0369a1',
  'model.response': '#0369a1',
  'tool.call': '#7c3aed',
  'tool.result': '#15803d',
  'file.change': '#b45309',
  'compile.error': '#b91c1c',
  'run.paused': '#b45309',
  'run.resumed': '#15803d',
  'run.forked': '#7c3aed',
  'run.completed': '#15803d',
  'run.failed': '#b91c1c',
  'run.aborted': '#b45309',
  'approval.request': '#be185d',
  'approval.decision': '#15803d',
  'checkpoint.saved': '#475569',
};

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function truncateDisplay(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

type TFn = (key: string, params?: Record<string, string>) => string;

/** Run status label (static t() so the i18n test can scan the key). */
function statusLabel(t: TFn, status: RunLogMetaView['status']): string {
  switch (status) {
    case 'running':
      return t('runlog.status.running');
    case 'paused':
      return t('runlog.status.paused');
    case 'completed':
      return t('runlog.status.completed');
    case 'failed':
      return t('runlog.status.failed');
    case 'aborted':
      return t('runlog.status.aborted');
    case 'forked':
      return t('runlog.status.forked');
    default:
      return status;
  }
}

/** One-line summary of an event (payload already sanitised). */
function summarizeEvent(t: TFn, event: RunLogEventView): string {
  const p = event.payload;
  switch (event.type) {
    case 'run.started': {
      const parent = asString(p['parentRunId']);
      return parent
        ? t('runlog.summary.forkedFrom', { parent, seq: String(p['forkFromSeq'] ?? '') })
        : asString(p['title']);
    }
    case 'run.prompt':
      return truncateDisplay(asString(p['text']), 300);
    case 'model.response': {
      const calls = Array.isArray(p['toolCalls'])
        ? (p['toolCalls'] as Array<Record<string, unknown>>)
            .map((c) => asString(c['tool']))
            .filter((s) => s !== '')
        : [];
      const text = truncateDisplay(asString(p['text']), 200);
      return calls.length > 0 ? `${text}${text ? ' · ' : ''}→ ${calls.join(', ')}` : text;
    }
    case 'tool.call': {
      const keys = asStringList(p['argKeys']);
      return keys.length > 0 ? `${asString(p['tool'])}(${keys.join(', ')})` : asString(p['tool']);
    }
    case 'tool.result': {
      const out = truncateDisplay(asString(p['outputPreview']), 200);
      return out ? `${asString(p['tool'])} · ${asString(p['status'])} · ${out}` : `${asString(p['tool'])} · ${asString(p['status'])}`;
    }
    case 'file.change':
      return `${asString(p['kind'])} ${asString(p['path'])}`;
    case 'compile.error':
      return truncateDisplay(asString(p['firstError']), 300);
    case 'run.paused':
    case 'run.resumed':
      return asString(p['reason']);
    case 'run.forked':
      return `${asString(p['side'])} ↔ ${asString(p['otherRunId'])} @seq ${String(p['atSeq'] ?? '')}`;
    case 'run.completed':
      return truncateDisplay(asString(p['finalText']), 200);
    case 'run.failed':
    case 'run.aborted':
      return truncateDisplay(asString(p['message']), 300);
    case 'approval.request':
      return asString(p['tool']);
    case 'approval.decision':
      return `${asString(p['tool'])} · ${p['allowed'] === true ? 'allow' : 'deny'}`;
    case 'checkpoint.saved':
      return t('runlog.summary.checkpoint', {
        step: String(p['step'] ?? ''),
        messages: String(p['messages'] ?? ''),
      });
    default:
      return '';
  }
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function statusColor(status: RunLogMetaView['status']): string {
  switch (status) {
    case 'completed':
      return '#15803d';
    case 'failed':
      return '#b91c1c';
    case 'paused':
      return '#b45309';
    case 'aborted':
      return '#b45309';
    case 'running':
      return '#0369a1';
    default:
      return '#475569';
  }
}

interface Props {
  onBack: () => void;
}

export default function RunReplayView({ onBack }: Props) {
  const t = useT();
  const [runs, setRuns] = useState<RunLogMetaView[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunLogEventView[]>([]);
  const [total, setTotal] = useState(0);
  const [pageOffset, setPageOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [activeTypes, setActiveTypes] = useState<ReadonlySet<string>>(() => new Set(ALL_TYPES));
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [verification, setVerification] = useState<RunLogVerificationView | null>(null);
  const [replay, setReplay] = useState<RunReplayStateView | null>(null);
  const [showReplay, setShowReplay] = useState(false);
  const loadGenRef = useRef(0);

  const loadRuns = useCallback(async () => {
    setRunsLoading(true);
    setError('');
    try {
      const list = await callOpenBot<RunLogMetaView[]>('runlog:list', 'listRunLogs');
      if (list === null) {
        setError(t('runlog.unavailable'));
        return;
      }
      setRuns(list);
      if (selectedRunId === null && list.length > 0) setSelectedRunId(list[0]!.runId);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('runlog.loadError'));
    } finally {
      setRunsLoading(false);
    }
  }, [selectedRunId, t]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  const loadPage = useCallback(
    async (runId: string, offset: number, append: boolean) => {
      const gen = loadGenRef.current;
      if (append) setLoadingMore(true);
      else {
        setLoading(true);
        setEvents([]);
        setTotal(0);
        setVerification(null);
        setReplay(null);
        setShowReplay(false);
      }
      setError('');
      try {
        const types = activeTypes.size === ALL_TYPES.length ? undefined : [...activeTypes];
        const page = await callOpenBot<{ events: RunLogEventView[]; total: number; corruptLines: number }>(
          'runlog:read',
          'getRunLog',
          { runId, ...(types !== undefined ? { query: { types, limit: PAGE_LIMIT, offset } } : { query: { limit: PAGE_LIMIT, offset } }) },
        );
        if (gen !== loadGenRef.current) return;
        if (page === null) {
          setError(t('runlog.unavailable'));
          if (!append) setEvents([]);
          return;
        }
        if (append) setEvents((prev) => [...prev, ...page.events]);
        else setEvents(page.events);
        setTotal(page.total);
        setPageOffset(offset + page.events.length);
        if (page.corruptLines > 0) {
          setError(t('runlog.corruptLines', { count: String(page.corruptLines) }));
        }
      } catch (e) {
        if (gen !== loadGenRef.current) return;
        setError(e instanceof Error ? e.message : t('runlog.loadError'));
        if (!append) setEvents([]);
      } finally {
        if (gen === loadGenRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [activeTypes, t],
  );

  // Load events + verify + replay when the run or filter changes.
  useEffect(() => {
    if (!selectedRunId) return;
    loadGenRef.current += 1;
    setPageOffset(0);
    setExpanded(new Set());
    void loadPage(selectedRunId, 0, false);
    void callOpenBot<RunLogVerificationView | null>('runlog:verify', 'verifyRunLog', { runId: selectedRunId })
      .then((v) => {
        if (v !== null) setVerification(v);
      })
      .catch(() => undefined);
    void callOpenBot<RunReplayStateView | null>('runlog:replay', 'replayRunLog', { runId: selectedRunId })
      .then((r) => {
        if (r !== null) setReplay(r);
      })
      .catch(() => undefined);
  }, [selectedRunId, loadPage]);

  const selectedRun = runs.find((r) => r.runId === selectedRunId) ?? null;

  const refreshAll = useCallback(() => {
    setNotice('');
    void loadRuns();
    if (selectedRunId) {
      loadGenRef.current += 1;
      void loadPage(selectedRunId, 0, false);
    }
  }, [loadRuns, loadPage, selectedRunId]);

  const doPauseResume = useCallback(
    async (action: 'pause' | 'resume') => {
      if (!selectedRunId) return;
      setNotice('');
      setError('');
      try {
        const res = await callOpenBot<{ runId: string; changed: boolean; seq: number }>(
          `runlog:${action}`,
          action === 'pause' ? 'pauseRunLog' : 'resumeRunLog',
          { runId: selectedRunId },
        );
        if (res === null) {
          setError(t('runlog.unavailable'));
          return;
        }
        setNotice(
          action === 'pause'
            ? t('runlog.pausedNotice', { seq: String(res.seq) })
            : t('runlog.resumedNotice', { seq: String(res.seq) }),
        );
        refreshAll();
      } catch (e) {
        setError(e instanceof Error ? e.message : t('runlog.loadError'));
      }
    },
    [selectedRunId, refreshAll, t],
  );

  const doFork = useCallback(
    async (fromSeq?: number) => {
      if (!selectedRunId) return;
      setNotice('');
      setError('');
      try {
        const res = await callOpenBot<{ childRunId: string; copiedEvents: number }>(
          'runlog:fork',
          'forkRunLog',
          { runId: selectedRunId, ...(fromSeq !== undefined ? { fromSeq } : {}) },
        );
        if (res === null) {
          setError(t('runlog.unavailable'));
          return;
        }
        setNotice(t('runlog.forkedNotice', { child: res.childRunId, count: String(res.copiedEvents) }));
        setSelectedRunId(res.childRunId);
        void loadRuns();
      } catch (e) {
        setError(e instanceof Error ? e.message : t('runlog.loadError'));
      }
    },
    [selectedRunId, loadRuns, t],
  );

  const doExport = useCallback(async () => {
    if (!selectedRunId) return;
    setNotice('');
    setError('');
    try {
      const res = await callOpenBot<{ runId: string; jsonl: string }>('runlog:export', 'exportRunLog', {
        runId: selectedRunId,
      });
      if (res === null) {
        setError(t('runlog.unavailable'));
        return;
      }
      const blob = new Blob([res.jsonl], { type: 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${selectedRunId}.jsonl`;
      a.click();
      URL.revokeObjectURL(url);
      setNotice(t('runlog.exportedNotice'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('runlog.loadError'));
    }
  }, [selectedRunId, t]);

  const toggleType = (type: string): void => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const toggleExpanded = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="panel">
      <button className="btn secondary" onClick={onBack}>{t('runlog.back')}</button>
      <h2>{t('runlog.title')}</h2>
      <p>{t('runlog.intro')}</p>

      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <button className="btn secondary" onClick={refreshAll} disabled={runsLoading}>
          {t('runlog.refresh')}
        </button>
        {verification !== null && (
          <span
            data-testid="runlog-verify"
            style={{ color: verification.ok ? '#15803d' : '#b91c1c', fontSize: 13 }}
          >
            {verification.ok
              ? t('runlog.verifyOk', { count: String(verification.eventCount) })
              : t('runlog.verifyBad', { seq: String(verification.firstBadSeq ?? 0) })}
          </span>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {notice && <p style={{ color: '#15803d' }}>{notice}</p>}

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {/* Run list */}
        <div style={{ minWidth: 260, maxWidth: 320, flex: '0 0 300px' }}>
          <h3 style={{ marginTop: 0 }}>{t('runlog.runs')}</h3>
          {runsLoading && <p>{t('runlog.loading')}</p>}
          {!runsLoading && runs.length === 0 && !error && <p className="empty">{t('runlog.noRuns')}</p>}
          <ul className="task-list" style={{ margin: 0, maxHeight: 560, overflowY: 'auto' }}>
            {runs.map((run) => (
              <li
                key={run.runId}
                onClick={() => setSelectedRunId(run.runId)}
                style={{
                  cursor: 'pointer',
                  borderColor: run.runId === selectedRunId ? '#0369a1' : undefined,
                  background: run.runId === selectedRunId ? 'var(--bg)' : undefined,
                }}
              >
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
                    {run.title ?? run.runId.slice(0, 12)}
                  </strong>
                  <span className="badge" style={{ background: statusColor(run.status), color: '#fff' }}>
                    {statusLabel(t, run.status)}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
                  {run.botId} · {formatTime(run.startedAt)}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                  {t('runlog.runStats', {
                    events: String(run.eventCount),
                    tools: String(run.toolCalls),
                    files: String(run.fileChanges),
                    errors: String(run.errors),
                  })}
                </div>
                {run.parentRunId && (
                  <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                    {t('runlog.forkedFrom', { parent: run.parentRunId.slice(0, 12) })}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>

        {/* Event timeline of the selected run */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {selectedRun && (
            <>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                <button
                  className="btn secondary"
                  onClick={() => void doPauseResume('pause')}
                  disabled={selectedRun.status !== 'running'}
                >
                  {t('runlog.pause')}
                </button>
                <button
                  className="btn secondary"
                  onClick={() => void doPauseResume('resume')}
                  disabled={selectedRun.status !== 'paused'}
                >
                  {t('runlog.resume')}
                </button>
                <button className="btn secondary" onClick={() => void doFork()}>
                  {t('runlog.fork')}
                </button>
                <button className="btn secondary" onClick={() => void doExport()}>
                  {t('runlog.export')}
                </button>
                <button
                  className="btn secondary"
                  onClick={() => setShowReplay((v) => !v)}
                  aria-pressed={showReplay}
                >
                  {t('runlog.showReplay')}
                </button>
              </div>

              <p style={{ margin: '0 0 8px', color: 'var(--text-dim)', fontSize: 13 }}>
                {t('runlog.filterTypes')}
              </p>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                {ALL_TYPES.map((type) => {
                  const active = activeTypes.has(type);
                  return (
                    <button
                      key={type}
                      type="button"
                      className="btn secondary"
                      aria-pressed={active}
                      onClick={() => toggleType(type)}
                      style={{
                        borderColor: active ? TYPE_COLORS[type] : undefined,
                        opacity: active ? 1 : 0.45,
                        fontSize: 12,
                        padding: '2px 8px',
                      }}
                    >
                      {type}
                    </button>
                  );
                })}
              </div>

              {showReplay && replay && (
                <div
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: 12,
                    marginBottom: 12,
                    fontSize: 13,
                  }}
                >
                  <h3 style={{ marginTop: 0 }}>{t('runlog.replayTitle')}</h3>
                  <p style={{ margin: '4px 0' }}>
                    {t('runlog.replayPrompt', { prompt: replay.prompt || '—' })}
                  </p>
                  <p style={{ margin: '4px 0', color: 'var(--text-dim)' }}>
                    {t('runlog.replayStats', {
                      steps: String(replay.steps),
                      tools: String(replay.toolCalls.length),
                      tokens: String(replay.tokensUsed),
                      errors: String(replay.errors.length),
                    })}
                  </p>
                  <p style={{ margin: '4px 0', color: 'var(--text-dim)', wordBreak: 'break-all' }}>
                    {t('runlog.replayDigest', { digest: replay.digest.slice(0, 16) })}
                  </p>
                  {replay.errors.length > 0 && (
                    <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
                      {replay.errors.map((e, i) => (
                        <li key={i} style={{ color: '#b91c1c' }}>{e}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {loading && <p>{t('runlog.loading')}</p>}
              {!loading && events.length === 0 && !error && <p className="empty">{t('runlog.empty')}</p>}
              {events.length > 0 && (
                <>
                  <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>
                      {t('runlog.count', { count: String(events.length), total: String(total) })}
                    </span>
                  </div>
                  <div
                    style={{ maxHeight: 480, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}
                  >
                    <ul className="task-list" style={{ margin: 0 }}>
                      {events.map((event) => {
                        const key = `${event.runId}:${event.seq}`;
                        const isOpen = expanded.has(key);
                        return (
                          <li key={key}>
                            <div className="row" style={{ justifyContent: 'space-between' }}>
                              <span>
                                <span
                                  className="badge"
                                  style={{ background: TYPE_COLORS[event.type as RunEventTypeView] ?? '#475569', color: '#fff', marginRight: 8 }}
                                >
                                  {event.type}
                                </span>
                                <strong>#{event.seq}</strong> {summarizeEvent(t, event)}
                              </span>
                              <span style={{ fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                                {formatTime(event.at)}
                              </span>
                            </div>
                            <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                              <button
                                type="button"
                                className="btn secondary"
                                style={{ padding: '2px 8px', fontSize: 12 }}
                                onClick={() => toggleExpanded(key)}
                              >
                                {isOpen ? t('runlog.hidePayload') : t('runlog.showPayload')}
                              </button>
                              <button
                                type="button"
                                className="btn secondary"
                                style={{ padding: '2px 8px', fontSize: 12 }}
                                onClick={() => void doFork(event.seq)}
                                title={t('runlog.forkFromHereTitle')}
                              >
                                {t('runlog.forkFromHere')}
                              </button>
                            </div>
                            {isOpen && (
                              <pre
                                style={{
                                  margin: '8px 0 0',
                                  padding: 8,
                                  background: 'var(--bg)',
                                  borderRadius: 6,
                                  fontSize: 12,
                                  overflowX: 'auto',
                                  whiteSpace: 'pre-wrap',
                                  wordBreak: 'break-word',
                                }}
                              >
                                {JSON.stringify(event.payload, null, 2)}
                              </pre>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                  {pageOffset < total && (
                    <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
                      <button
                        className="btn secondary"
                        onClick={() => void loadPage(selectedRun.runId, pageOffset, true)}
                        disabled={loadingMore}
                      >
                        {t('runlog.loadMore')}
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
          {!selectedRun && !runsLoading && runs.length > 0 && (
            <p className="empty">{t('runlog.selectRun')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
