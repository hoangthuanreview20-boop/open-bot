/**
 * EventLogView — read the harness event log (v0.90a, Team G).
 *
 * One bot's turn/tool-call history from the NDJSON ThreadLog
 * (IPC `harness:thread-log`, paginated, filterable by kind) plus an
 * optional live tail (IPC `harness:event`, forwarded from the
 * coordinator child's harness bus). The thread of a bot is its bot id
 * — the same thread the loop and the CLI drivers write to.
 *
 * Data is read-only and already sanitised upstream (tool_call carries
 * only the tool name + argument key names, strings are truncated, and
 * secret-shaped values are redacted by `sanitizeHarnessPayload`), so
 * this screen never renders a secret. The expandable payload dump
 * shows exactly that sanitised payload, nothing raw.
 *
 * v0.93b: paging + live tail share one merge (`eventLogMerge.ts`) —
 * a live event already on screen is never shown twice when a later
 * page/resync re-fetches it, and the list stays chronological when a
 * "load more" page lands after a live append. Switching bots bumps a
 * load generation and clears the list synchronously, so a slow page
 * for the old bot cannot overwrite the new bot's log. The live tail
 * retries its subscribe when preload is not ready yet and resyncs
 * the NDJSON tail (30s tick, window focus, reconnect) for entries
 * the channel dropped — only entries newer than the gap baseline,
 * so the resync never auto-loads unpaged history.
 *
 * IPC goes through the `callOpenBot` helper (the TraceView pattern):
 * try the channel name first, then the camelCase spelling; when
 * preload has not exposed the method yet it returns null and the UI
 * reports "unavailable" instead of crashing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BotConfigLike, HarnessEventKindView, HarnessEventView, HarnessStatusView, HarnessThreadLogEntryView, HarnessThreadLogView } from '../types';
import { useT } from '../i18n/useT';
import { appendLiveEventLogEntries, eventLogEntryKey, mergeEventLogEntries } from './eventLogMerge';

async function callOpenBot<T>(channel: string, camel: string, ...args: unknown[]): Promise<T | null> {
  const api = window.openBot as unknown as Record<string, unknown>;
  const fn = api[channel] ?? api[camel];
  if (typeof fn !== 'function') return null;
  return (fn as (...a: unknown[]) => Promise<T>).apply(window.openBot, args);
}

const PAGE_LIMIT = 100;
/** Live list cap — oldest live entries drop off so the list stays bounded. */
const LIVE_CAP = 500;
/** Live tail resync tick — re-read the tail of the NDJSON log for
 * entries the live channel may have dropped (see resyncFromLog). */
const LIVE_RESYNC_MS = 30_000;
/** Retry delay while the live channel is not exposed yet (preload
 * not ready at mount) — the tail reconnects instead of staying dead. */
const LIVE_RETRY_MS = 2_000;
/** Max pages one resync fetches, so a tick never walks a huge log. */
const RESYNC_MAX_PAGES = 2;

const ALL_KINDS: HarnessEventKindView[] = [
  'text',
  'tool_call',
  'result',
  'error',
  'abort',
  'approval_request',
  'approval_denied',
  'permission_request',
  'permission_denied',
  'approval_decision',
  'lifecycle',
];

const KIND_COLORS: Record<HarnessEventKindView, string> = {
  text: '#0369a1',
  tool_call: '#7c3aed',
  result: '#15803d',
  error: '#b91c1c',
  abort: '#b45309',
  approval_request: '#be185d',
  approval_denied: '#b91c1c',
  permission_request: '#be185d',
  permission_denied: '#b91c1c',
  approval_decision: '#15803d',
  lifecycle: '#475569',
};

function kindLabel(t: ReturnType<typeof useT>, kind: HarnessEventKindView): string {
  switch (kind) {
    case 'text':
      return t('eventlog.kind.text');
    case 'tool_call':
      return t('eventlog.kind.tool_call');
    case 'result':
      return t('eventlog.kind.result');
    case 'error':
      return t('eventlog.kind.error');
    case 'abort':
      return t('eventlog.kind.abort');
    case 'approval_request':
      return t('eventlog.kind.approval_request');
    case 'approval_denied':
      return t('eventlog.kind.approval_denied');
    case 'permission_request':
      return t('eventlog.kind.permission_request');
    case 'permission_denied':
      return t('eventlog.kind.permission_denied');
    case 'approval_decision':
      return t('eventlog.kind.approval_decision');
    case 'lifecycle':
      return t('eventlog.kind.lifecycle');
    default:
      return kind;
  }
}

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

/** One-line summary of a sanitised payload (never renders raw secrets). */
function summarize(entry: HarnessThreadLogEntryView): string {
  const p = entry.payload;
  switch (entry.kind) {
    case 'text':
      return truncateDisplay(asString(p['text']), 500);
    case 'tool_call': {
      const keys = asStringList(p['argKeys']);
      return keys.length > 0 ? `${asString(p['tool'])}(${keys.join(', ')})` : asString(p['tool']);
    }
    case 'result': {
      const ok = p['ok'] === true ? 'ok' : 'error';
      const out = truncateDisplay(asString(p['output']), 300);
      return out ? `${asString(p['tool'])} · ${ok} · ${out}` : `${asString(p['tool'])} · ${ok}`;
    }
    case 'error':
      return truncateDisplay(asString(p['message']), 500);
    case 'abort':
      return '';
    case 'approval_request':
    case 'permission_request': {
      const detail = asString(p['detail']);
      return detail ? `${asString(p['method'])} · ${detail}` : asString(p['method']);
    }
    case 'approval_denied': {
      const tool = asString(p['tool']);
      if (tool) return tool;
      const detail = asString(p['detail']);
      return detail ? `${asString(p['method'])} · ${detail}` : asString(p['method']);
    }
    case 'approval_decision': {
      const allowed = p['allowed'] === true ? 'allow' : 'deny';
      const reason = asString(p['reason']);
      return reason
        ? `${asString(p['method'])} · ${allowed} · ${reason}`
        : `${asString(p['method'])} · ${allowed}`;
    }
    case 'lifecycle': {
      const phase = asString(p['phase']);
      const status = asString(p['status']);
      return status ? `${phase} · ${status}` : phase;
    }
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

interface Props {
  bots: BotConfigLike[];
  botId?: string | null;
  onBack: () => void;
  onSelectBot: (botId: string) => void;
}

export default function EventLogView({ bots, botId, onBack, onSelectBot }: Props) {
  const t = useT();
  const selectedBotId = botId ?? bots[0]?.id ?? null;
  const [entries, setEntries] = useState<HarnessThreadLogEntryView[]>([]);
  const [total, setTotal] = useState(0);
  const [pageOffset, setPageOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<HarnessStatusView | null>(null);
  const [activeKinds, setActiveKinds] = useState<ReadonlySet<HarnessEventKindView>>(
    () => new Set(ALL_KINDS),
  );
  const [liveTail, setLiveTail] = useState(true);
  const [liveConnected, setLiveConnected] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement | null>(null);
  // Live events append while the user pages through history — the
  // IPC offset must only count rows loaded from the log, never live
  // rows, or "load more" would skip entries.
  const loadedCountRef = useRef(0);
  // Generation counter for paged loads: a load started for bot A (or
  // filter set A) that resolves after the user switched to bot B must
  // not overwrite bot B's list with bot A's stale rows. Every fresh
  // load bumps the generation; a response with an old generation is
  // dropped. (v0.93b — before this, a slow first page could win the
  // race and show the previous bot's log under the new bot's name.)
  const loadGenRef = useRef(0);
  // Mirror of `total` for callbacks/intervals that cannot read state.
  const totalRef = useRef(0);
  // Newest `at` seen through the LIVE channel for this bot (ISO
  // strings compare chronologically). The resync baseline: entries
  // newer than this may have been dropped by the channel.
  const lastLiveAtRef = useRef('');
  // When the live channel went down (ISO time). On reconnect the
  // resync merges entries written since then — entries older than
  // this are paged history, not a gap, and must NOT be auto-loaded
  // (that would defeat the 100-row first page).
  const downSinceRef = useRef('');
  // Resyncs never overlap: a slow tick does not stack another fetch.
  const resyncingRef = useRef(false);
  // Keys of the entries currently DISPLAYED (mirrored from state by
  // effect below). The live callback consults it so an event already
  // shown via paging is not appended a second time. It mirrors the
  // display only — never history — so a refresh can bring a live
  // entry back through the resync instead of blocking it forever.
  const displayedKeysRef = useRef<ReadonlySet<string>>(new Set());

  // Keep the displayed-keys mirror in sync (runs after every commit).
  useEffect(() => {
    displayedKeysRef.current = new Set(entries.map(eventLogEntryKey));
  }, [entries]);

  const loadPage = useCallback(
    async (offset: number, append: boolean) => {
      if (!selectedBotId) return;
      const gen = loadGenRef.current;
      if (append) setLoadingMore(true);
      else {
        setLoading(true);
        // Fresh load replaces the list: clear synchronously so the
        // previous bot's rows never linger under the new bot's name
        // while the IPC round-trip is in flight.
        setEntries([]);
        setTotal(0);
        totalRef.current = 0;
      }
      setError('');
      try {
        const kinds = activeKinds.size === ALL_KINDS.length ? undefined : [...activeKinds];
        const page = await callOpenBot<HarnessThreadLogView>(
          'harness:thread-log',
          'getHarnessThreadLog',
          {
            threadId: selectedBotId,
            limit: PAGE_LIMIT,
            offset,
            ...(kinds !== undefined ? { kinds } : {}),
          },
        );
        // Stale response (bot/filter changed mid-flight) — drop it.
        if (gen !== loadGenRef.current) return;
        if (page === null) {
          setError(t('eventlog.unavailable'));
          if (!append) setEntries([]);
          return;
        }
        if (append) {
          // A live event may already be on screen AND in this page
          // (it is written to the same NDJSON file) — merge dedupes
          // it and keeps the list chronological instead of appending
          // older rows after the newer live row.
          setEntries((prev) => mergeEventLogEntries(prev, page.entries));
        } else {
          setEntries(page.entries);
        }
        setTotal(page.total);
        totalRef.current = page.total;
        loadedCountRef.current = offset + page.entries.length;
        setPageOffset(offset + page.entries.length);
      } catch (e) {
        if (gen !== loadGenRef.current) return;
        setError(e instanceof Error ? e.message : t('eventlog.loadError'));
        if (!append) setEntries([]);
      } finally {
        // Only the current generation may clear the spinner — a stale
        // load finishing must not hide the fresh load's spinner.
        if (gen === loadGenRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [selectedBotId, activeKinds, t],
  );

  // Fresh load: bump the generation (kills in-flight loads for the
  // previous bot/filter), reset paging + expansion + live baseline,
  // then load page 1. Used by the bot/filter effect and the Refresh
  // button — one path, so refresh cannot lose the race either.
  const startFreshLoad = useCallback(() => {
    loadGenRef.current += 1;
    loadedCountRef.current = 0;
    lastLiveAtRef.current = '';
    setPageOffset(0);
    setExpanded(new Set());
    void loadPage(0, false);
  }, [loadPage]);

  // Fresh load when the bot or the kind filter changes.
  useEffect(() => {
    startFreshLoad();
  }, [startFreshLoad]);

  /**
   * Resync — re-read the TAIL of the NDJSON log for entries the live
   * channel may have dropped, and merge them (dedupe + chronological
   * order + live cap, like a live append).
   *
   * Only entries with `at >= baselineAt` are merged. The baseline is
   * either the moment the channel went down (reconnect catch-up: the
   * gap is exactly the entries written since then) or the newest live
   * event seen so far (periodic tick: anything newer than that never
   * arrived through the channel). Entries older than the baseline are
   * paged history — merging them would silently load rows the user
   * has not asked for yet and defeat the 100-row first page.
   *
   * What this does NOT recover: events the coordinator child never
   * persisted (it died mid-run before writing them). Those never
   * reached the disk log, so no re-read can find them — the resync
   * only closes the gap between "persisted" and "displayed".
   * Best-effort: a failed tick is silent, the next tick retries.
   */
  const resyncFromLog = useCallback(
    async (baselineAt: string) => {
      if (!selectedBotId || baselineAt === '') return;
      if (resyncingRef.current) return;
      resyncingRef.current = true;
      try {
        const kinds = activeKinds.size === ALL_KINDS.length ? undefined : [...activeKinds];
        let offset = Math.max(0, totalRef.current - PAGE_LIMIT);
        for (let page = 0; page < RESYNC_MAX_PAGES; page += 1) {
          const res = await callOpenBot<HarnessThreadLogView>(
            'harness:thread-log',
            'getHarnessThreadLog',
            {
              threadId: selectedBotId,
              limit: PAGE_LIMIT,
              offset,
              ...(kinds !== undefined ? { kinds } : {}),
            },
          );
          if (res === null) return;
          setTotal(res.total);
          totalRef.current = res.total;
          const missed = res.entries.filter((e) => e.at >= baselineAt);
          if (missed.length > 0) {
            setEntries((prev) => appendLiveEventLogEntries(prev, missed, LIVE_CAP));
            for (const e of missed) {
              if (e.at > lastLiveAtRef.current) lastLiveAtRef.current = e.at;
            }
          }
          // Walk forward while the known total says more rows exist
          // past this page (the total used for the first offset may
          // have been stale because live events arrived since).
          if (offset + res.entries.length >= res.total || res.entries.length === 0) break;
          offset += res.entries.length;
        }
      } catch {
        // Best-effort: the next tick / focus / reconnect retries.
      } finally {
        resyncingRef.current = false;
      }
    },
    [selectedBotId, activeKinds],
  );

  // Harness status line (instances + pending permissions).
  useEffect(() => {
    let alive = true;
    void callOpenBot<HarnessStatusView>('harness:status', 'getHarnessStatus')
      .then((s) => {
        if (alive && s !== null) setStatus(s);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // Live tail: subscribe to the sanitised harness event stream while
  // enabled. Only events for the selected thread and an active kind
  // are appended; the list is capped so a long run cannot grow it
  // without bound.
  //
  // v0.93b — reconnect + no lost entries:
  // - If preload has not exposed `onHarnessEvent` yet (mount race),
  //   retry every LIVE_RETRY_MS instead of giving up silently; the
  //   status line shows "reconnecting" while down.
  // - On (re)subscribe, catch up from the NDJSON log: baseline is
  //   when the channel went down (or the newest live event seen so
  //   far) — see resyncFromLog. A first subscribe with no baseline
  //   skips the resync (there is no gap to close yet).
  // - A live event already on screen (fetched by paging/resync) is
  //   skipped via displayedKeysRef, so the total only grows for a
  //   genuinely new row. (The merge inside setEntries dedupes as a
  //   second line of defence; the total can still overcount by 1 in
  //   the rare same-tick double delivery, and the next resync or
  //   refresh corrects it from the server total.)
  useEffect(() => {
    if (!liveTail || !selectedBotId) {
      setLiveConnected(false);
      return undefined;
    }
    const api = window.openBot as unknown as {
      onHarnessEvent?: (cb: (event: HarnessEventView) => void) => () => void;
    };
    let stopped = false;
    let unsubscribe: (() => void) | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const trySubscribe = (): void => {
      if (stopped) return;
      if (typeof api.onHarnessEvent !== 'function') {
        setLiveConnected(false);
        if (downSinceRef.current === '') downSinceRef.current = new Date().toISOString();
        retryTimer = setTimeout(trySubscribe, LIVE_RETRY_MS);
        return;
      }
      unsubscribe = api.onHarnessEvent((event) => {
        if (event.threadId !== selectedBotId) return;
        if (event.at > lastLiveAtRef.current) lastLiveAtRef.current = event.at;
        if (!activeKinds.has(event.kind)) return;
        const entry: HarnessThreadLogEntryView = {
          at: event.at,
          botId: event.botId,
          threadId: event.threadId,
          kind: event.kind,
          payload: event.payload,
          ...(event.engine !== undefined ? { engine: event.engine } : {}),
        };
        if (displayedKeysRef.current.has(eventLogEntryKey(entry))) return;
        setEntries((prev) => appendLiveEventLogEntries(prev, [entry], LIVE_CAP));
        setTotal((prev) => prev + 1);
        totalRef.current += 1;
      });
      setLiveConnected(true);
      const baseline = downSinceRef.current !== '' ? downSinceRef.current : lastLiveAtRef.current;
      downSinceRef.current = '';
      if (baseline !== '') void resyncFromLog(baseline);
    };
    trySubscribe();
    return () => {
      stopped = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      unsubscribe?.();
      setLiveConnected(false);
    };
  }, [liveTail, selectedBotId, activeKinds, resyncFromLog]);

  // Periodic + focus resync while the tail is on: if the channel
  // silently dropped an event (coordinator child restarted, main
  // forwarded nothing during the gap), the next tick re-reads the
  // tail of the log and merges what is newer than the last live
  // event seen. Gated on a baseline — with no live event seen yet
  // there is nothing provably missed, and an un-gated merge would
  // auto-load unpaged history. Cheap when healthy: one IPC read
  // that merges nothing (dedupe drops every row already shown).
  useEffect(() => {
    if (!liveTail || !selectedBotId) return undefined;
    const tick = (): void => {
      if (lastLiveAtRef.current !== '') void resyncFromLog(lastLiveAtRef.current);
    };
    const timer = setInterval(tick, LIVE_RESYNC_MS);
    const onFocus = (): void => tick();
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') tick();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [liveTail, selectedBotId, resyncFromLog]);

  // Live tail auto-scrolls to the newest entry.
  useEffect(() => {
    if (!liveTail) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, liveTail]);

  const toggleKind = (kind: HarnessEventKindView): void => {
    setActiveKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
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

  const selectedBot = bots.find((b) => b.id === selectedBotId) ?? null;

  return (
    <div className="panel">
      <button className="btn secondary" onClick={onBack}>{t('eventlog.back')}</button>
      <h2>{t('eventlog.title')}</h2>
      <p>{t('eventlog.intro')}</p>
      {status && (
        <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
          {t('eventlog.statusLine', {
            instances: String(status.instances.length),
            pending: String(status.pendingPermissions.length),
          })}
        </p>
      )}

      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <label htmlFor="eventlog-bot">{t('eventlog.selectBot')}</label>
        <select
          id="eventlog-bot"
          value={selectedBotId ?? ''}
          onChange={(e) => onSelectBot(e.target.value)}
          disabled={bots.length === 0}
        >
          {bots.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn secondary"
          onClick={() => setLiveTail((v) => !v)}
          aria-pressed={liveTail}
        >
          {t('eventlog.liveTail')} {liveTail ? '●' : '○'}
        </button>
        {liveTail && (
          <span data-testid="eventlog-live-status" style={{ color: 'var(--text-dim)', fontSize: 13 }}>
            {liveConnected ? t('eventlog.liveConnected') : t('eventlog.liveReconnecting')}
          </span>
        )}
        <button
          className="btn secondary"
          onClick={startFreshLoad}
          disabled={loading || !selectedBotId}
        >
          {t('eventlog.refresh')}
        </button>
      </div>

      <p style={{ margin: '0 0 8px', color: 'var(--text-dim)', fontSize: 13 }}>
        {t('eventlog.filterKinds')}
      </p>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {ALL_KINDS.map((kind) => {
          const active = activeKinds.has(kind);
          return (
            <button
              key={kind}
              type="button"
              className="btn secondary"
              aria-pressed={active}
              onClick={() => toggleKind(kind)}
              style={{
                borderColor: active ? KIND_COLORS[kind] : undefined,
                opacity: active ? 1 : 0.45,
              }}
            >
              {kindLabel(t, kind)}
            </button>
          );
        })}
      </div>

      {loading && <p>{t('eventlog.loading')}</p>}
      {error && <p className="error">{error}</p>}

      {!selectedBot && !loading && !error && <p className="empty">{t('eventlog.noBot')}</p>}
      {selectedBot && !loading && entries.length === 0 && !error && (
        <p className="empty">{t('eventlog.empty')}</p>
      )}

      {entries.length > 0 && (
        <>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>
              {t('eventlog.count', { count: String(entries.length), total: String(total) })}
            </span>
          </div>
          <div
            ref={listRef}
            style={{ maxHeight: 480, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}
          >
            <ul className="task-list" style={{ margin: 0 }}>
              {entries.map((entry) => {
                // Stable per-entry key (not the row index: merges and
                // sorts move rows, and an index key would leak the
                // expanded state across bots and across pages).
                const key = eventLogEntryKey(entry);
                const isOpen = expanded.has(key);
                return (
                  <li key={key}>
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span>
                        <span
                          className="badge"
                          style={{ background: KIND_COLORS[entry.kind], color: '#fff', marginRight: 8 }}
                        >
                          {kindLabel(t, entry.kind)}
                        </span>
                        <strong>{summarize(entry)}</strong>
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                        {formatTime(entry.at)}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
                      {entry.botId} · {entry.threadId}
                      {entry.engine !== undefined && entry.engine !== '' ? ` · ${entry.engine}` : ''}
                    </div>
                    <button
                      type="button"
                      className="btn secondary"
                      style={{ marginTop: 6, padding: '2px 8px', fontSize: 12 }}
                      onClick={() => toggleExpanded(key)}
                    >
                      {isOpen ? t('eventlog.hidePayload') : t('eventlog.showPayload')}
                    </button>
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
                        {JSON.stringify(entry.payload, null, 2)}
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
                onClick={() => void loadPage(pageOffset, true)}
                disabled={loadingMore}
              >
                {t('eventlog.loadMore')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
