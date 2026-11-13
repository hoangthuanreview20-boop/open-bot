/**
 * InternetDataView (v0.95, Team D1) — RSS/Atom feeds + watched pages.
 *
 * Reads and writes the same `<userData>/internet-data.json` state
 * the `feed_*` / `watch_*` agent tools use, through IPC
 * `internet-data:*` in main (main fetches directly, so "Check now"
 * works even when no bot is running). A watch change also arrives
 * live on `internet:watch-changed` (from a `watch_check` run or a
 * UI check) and shows as a banner + reloads the list.
 *
 * Progressive disclosure: the everyday actions (subscribe, read,
 * watch, check now) are on the surface; per-watch internals (last
 * content hash, last error, stored summary lines) sit behind a
 * <details> element.
 *
 * Every display string goes through i18n (`internet.*`); the file
 * contains no hard-coded Vietnamese (see tests/i18n.test.mjs).
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  InternetDataStateView,
  InternetFeedItemView,
  InternetWatchChangedPayloadView,
} from '../types';
import { useT } from '../i18n/useT';

interface Props {
  onBack: () => void;
}

function formatTime(ts?: number): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
}

export default function InternetDataView({ onBack }: Props) {
  const t = useT();
  const [tab, setTab] = useState<'feeds' | 'watches'>('feeds');
  const [data, setData] = useState<InternetDataStateView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedUrl, setFeedUrl] = useState('');
  const [feedTitle, setFeedTitle] = useState('');
  const [watchUrl, setWatchUrl] = useState('');
  const [watchInterval, setWatchInterval] = useState('60');
  const [openFeedId, setOpenFeedId] = useState<string | null>(null);
  const [feedItems, setFeedItems] = useState<Record<string, InternetFeedItemView[]>>({});
  const [feedItemsTitle, setFeedItemsTitle] = useState<Record<string, string>>({});
  const [readingFeedId, setReadingFeedId] = useState<string | null>(null);
  const [checkingWatchId, setCheckingWatchId] = useState<string | null>(null);
  const [lastChange, setLastChange] = useState<InternetWatchChangedPayloadView | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await window.openBot.getInternetData());
    } catch (e) {
      setError(e instanceof Error ? e.message : t('internet.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (typeof window.openBot.onInternetWatchChanged !== 'function') return undefined;
    return window.openBot.onInternetWatchChanged((payload) => {
      setLastChange(payload);
      void load();
    });
  }, [load]);

  const subscribe = async () => {
    const url = feedUrl.trim();
    if (!url || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await window.openBot.subscribeInternetFeed(url, feedTitle.trim() || undefined);
      setData(result.state);
      setFeedUrl('');
      setFeedTitle('');
      setNotice(t('internet.subscribed', { count: String(result.itemCount) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('internet.loadError'));
    } finally {
      setBusy(false);
    }
  };

  const unsubscribe = async (feed: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      setData(await window.openBot.unsubscribeInternetFeed(feed));
      setNotice(t('internet.unsubscribed'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('internet.loadError'));
    } finally {
      setBusy(false);
    }
  };

  const readFeed = async (feed: string) => {
    if (openFeedId === feed) {
      setOpenFeedId(null);
      return;
    }
    setReadingFeedId(feed);
    setError('');
    try {
      const result = await window.openBot.readInternetFeed(feed, 10);
      setFeedItems((prev) => ({ ...prev, [feed]: result.items }));
      setFeedItemsTitle((prev) => ({ ...prev, [feed]: result.title }));
      setOpenFeedId(feed);
      const fresh = await window.openBot.getInternetData();
      setData(fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('internet.loadError'));
    } finally {
      setReadingFeedId(null);
    }
  };

  const addWatch = async () => {
    const url = watchUrl.trim();
    if (!url || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const interval = Number.parseInt(watchInterval, 10);
      const result = await window.openBot.addInternetWatch(
        url,
        Number.isFinite(interval) ? interval : undefined,
      );
      setData(result.state);
      setWatchUrl('');
      setNotice(t('internet.watchAdded'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('internet.loadError'));
    } finally {
      setBusy(false);
    }
  };

  const removeWatch = async (watch: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      setData(await window.openBot.removeInternetWatch(watch));
      setNotice(t('internet.watchRemoved'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('internet.loadError'));
    } finally {
      setBusy(false);
    }
  };

  const checkWatches = async (watch?: string) => {
    setCheckingWatchId(watch ?? '__all__');
    setError('');
    setNotice('');
    try {
      const result = await window.openBot.checkInternetWatches(watch);
      setData(result.state);
      const changed = result.events.filter((e) => e.changed).length;
      setNotice(t('internet.checkedSummary', {
        checked: String(result.events.length),
        changed: String(changed),
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('internet.loadError'));
    } finally {
      setCheckingWatchId(null);
    }
  };

  const feeds = data?.feeds ?? [];
  const watches = data?.watches ?? [];

  return (
    <div>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <button className="btn secondary" onClick={onBack}>
          {t('internet.back')}
        </button>
        <h2 style={{ margin: 0 }}>{t('internet.title')}</h2>
      </div>
      <p className="hint">{t('internet.intro')}</p>
      <p className="hint">{t('internet.braveNote')}</p>
      {lastChange && (
        <p data-testid="internet-change-banner">
          {t('internet.changedBanner', { url: lastChange.url })}
        </p>
      )}
      {loading && <p>{t('internet.loading')}</p>}
      {error && <p className="error">{error}</p>}
      {notice && <p>{notice}</p>}
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <button
          className={tab === 'feeds' ? 'btn' : 'btn secondary'}
          onClick={() => setTab('feeds')}
        >
          {t('internet.feedsTab')}
        </button>
        <button
          className={tab === 'watches' ? 'btn' : 'btn secondary'}
          onClick={() => setTab('watches')}
        >
          {t('internet.watchesTab')}
        </button>
      </div>
      {tab === 'feeds' && (
        <div>
          <div className="row" style={{ gap: 8, marginBottom: 12 }}>
            <input
              style={{ flex: 2, minWidth: 200 }}
              value={feedUrl}
              onChange={(e) => setFeedUrl(e.target.value)}
              placeholder={t('internet.feedUrlPlaceholder')}
              aria-label={t('internet.feedUrlPlaceholder')}
            />
            <input
              style={{ flex: 1, minWidth: 120 }}
              value={feedTitle}
              onChange={(e) => setFeedTitle(e.target.value)}
              placeholder={t('internet.feedTitlePlaceholder')}
              aria-label={t('internet.feedTitlePlaceholder')}
            />
            <button className="btn" disabled={busy || !feedUrl.trim()} onClick={() => void subscribe()}>
              {busy ? t('internet.subscribing') : t('internet.subscribe')}
            </button>
          </div>
          {feeds.length === 0 && !loading && <p className="hint">{t('internet.noFeeds')}</p>}
          {feeds.map((feed) => (
            <div key={feed.id} className="card" style={{ marginBottom: 8 }}>
              <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <strong>{feed.title}</strong>
                  <div className="hint" style={{ overflowWrap: 'anywhere' }}>{feed.url}</div>
                  <div className="hint">
                    {feed.lastCheckedAt
                      ? t('internet.lastChecked', { time: formatTime(feed.lastCheckedAt) })
                      : t('internet.neverChecked')}
                    {feed.lastItemCount !== undefined
                      ? ` — ${t('internet.itemCount', { count: String(feed.lastItemCount) })}`
                      : ''}
                  </div>
                </div>
                <div className="row" style={{ gap: 8, flexShrink: 0 }}>
                  <button
                    className="btn secondary"
                    disabled={readingFeedId === feed.id}
                    onClick={() => void readFeed(feed.id)}
                  >
                    {readingFeedId === feed.id ? t('internet.reading') : t('internet.read')}
                  </button>
                  <button
                    className="btn secondary"
                    disabled={busy}
                    onClick={() => void unsubscribe(feed.id)}
                  >
                    {t('internet.unsubscribe')}
                  </button>
                </div>
              </div>
              {openFeedId === feed.id && (
                <div style={{ marginTop: 8 }}>
                  <strong>{feedItemsTitle[feed.id] ?? feed.title}</strong>
                  {(feedItems[feed.id] ?? []).length === 0 && (
                    <p className="hint">{t('internet.noItems')}</p>
                  )}
                  {(feedItems[feed.id] ?? []).map((item) => (
                    <div key={item.id} style={{ marginTop: 8 }}>
                      <div>
                        <strong>{item.title}</strong>
                        {item.published ? ` (${item.published})` : ''}
                      </div>
                      <div className="hint" style={{ overflowWrap: 'anywhere' }}>{item.link}</div>
                      {item.summary && <div>{item.summary.slice(0, 300)}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {tab === 'watches' && (
        <div>
          <div className="row" style={{ gap: 8, marginBottom: 12 }}>
            <input
              style={{ flex: 2, minWidth: 200 }}
              value={watchUrl}
              onChange={(e) => setWatchUrl(e.target.value)}
              placeholder={t('internet.watchUrlPlaceholder')}
              aria-label={t('internet.watchUrlPlaceholder')}
            />
            <label>
              {t('internet.intervalLabel')}{' '}
              <input
                style={{ width: 72 }}
                type="number"
                min={5}
                max={1440}
                value={watchInterval}
                onChange={(e) => setWatchInterval(e.target.value)}
                aria-label={t('internet.intervalLabel')}
              />
            </label>
            <button className="btn" disabled={busy || !watchUrl.trim()} onClick={() => void addWatch()}>
              {busy ? t('internet.watching') : t('internet.watch')}
            </button>
            <button
              className="btn secondary"
              disabled={checkingWatchId !== null}
              onClick={() => void checkWatches()}
            >
              {checkingWatchId === '__all__' ? t('internet.checking') : t('internet.checkAll')}
            </button>
          </div>
          {watches.length === 0 && !loading && <p className="hint">{t('internet.noWatches')}</p>}
          {watches.map((watch) => (
            <div key={watch.id} className="card" style={{ marginBottom: 8 }}>
              <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <strong style={{ overflowWrap: 'anywhere' }}>{watch.url}</strong>
                  <div className="hint">
                    {t('internet.everyMinutes', { count: String(watch.intervalMinutes) })}
                    {' — '}
                    {watch.lastCheckedAt
                      ? t('internet.lastChecked', { time: formatTime(watch.lastCheckedAt) })
                      : t('internet.neverChecked')}
                    {watch.lastChangedAt
                      ? ` — ${t('internet.lastChanged', { time: formatTime(watch.lastChangedAt) })}`
                      : ''}
                  </div>
                  {watch.lastError && <div className="error">{watch.lastError}</div>}
                </div>
                <div className="row" style={{ gap: 8, flexShrink: 0 }}>
                  <button
                    className="btn secondary"
                    disabled={checkingWatchId !== null}
                    onClick={() => void checkWatches(watch.id)}
                  >
                    {checkingWatchId === watch.id ? t('internet.checking') : t('internet.checkNow')}
                  </button>
                  <button
                    className="btn secondary"
                    disabled={busy}
                    onClick={() => void removeWatch(watch.id)}
                  >
                    {t('internet.remove')}
                  </button>
                </div>
              </div>
              <details style={{ marginTop: 8 }}>
                <summary>{t('internet.advanced')}</summary>
                <div className="hint">
                  {watch.lastHash
                    ? t('internet.lastHash', { hash: watch.lastHash.slice(0, 16) })
                    : t('internet.noBaseline')}
                </div>
                {watch.lastSummary && (
                  <div className="hint" style={{ whiteSpace: 'pre-wrap' }}>
                    {watch.lastSummary.slice(0, 1000)}
                  </div>
                )}
              </details>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
