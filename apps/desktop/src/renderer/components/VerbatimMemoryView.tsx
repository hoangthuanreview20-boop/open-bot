/**
 * VerbatimMemoryView — verbatim memory management (v1.01, Team T4).
 *
 * View / search / delete verbatim records of one bot (plus shared
 * records — botId '' means shared). Everything local: records live in
 * `<workspace>/.open-bot/verbatim` (SQLite by default, JSONL fallback),
 * semantic recall runs via local Ollama; embedding vectors are NEVER
 * shown in the UI.
 *
 * - Search: hybrid recall (BM25 + embedding when Ollama runs) with a
 *   score per hit and a note when keyword fallback was used.
 * - List: newest first, wing/room filter, "show more" pagination.
 * - Delete: two-step confirmation (no window.confirm).
 * - Export: download a JSON file (no vectors).
 * - No inline text editing: editing verbatim text would rewrite
 *   history — to change it, delete and save again (via tool / MCP /
 *   autosave).
 *
 * Props follow the MemoryV2View pattern. Mounted inside MemoryView
 * under the "Verbatim" tab.
 */
import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';
import type {
  BotConfigLike,
  VerbatimConsolidateView,
  VerbatimRecordView,
  VerbatimSearchHitView,
  VerbatimSearchView,
  VerbatimStatsView,
} from '../types';

interface Props {
  bots: BotConfigLike[];
  botId: string | null;
  onSelectBot: (id: string) => void;
}

const PAGE_SIZE = 50;

type Row = VerbatimRecordView & { score?: number; keywordScore?: number; semanticScore?: number };

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export default function VerbatimMemoryView({ bots, botId, onSelectBot }: Props) {
  const t = useT();
  const [stats, setStats] = useState<VerbatimStatsView | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [wing, setWing] = useState('');
  const [room, setRoom] = useState('');
  const [searchResult, setSearchResult] = useState<VerbatimSearchView | null>(null);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState('');
  const [consolidate, setConsolidate] = useState<VerbatimConsolidateView | null>(null);
  const [consolidating, setConsolidating] = useState(false);
  const [confirmDedup, setConfirmDedup] = useState(false);

  const activeBot = bots.find((b) => b.id === botId) ?? bots[0] ?? null;

  const load = async (id: string | null, w: string, r: string) => {
    if (!id) {
      setStats(null);
      setRows([]);
      setTotal(0);
      setSearchResult(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    setSearchResult(null);
    try {
      const [st, list] = await Promise.all([
        window.openBot.getVerbatimMemoryStats({ botId: id }),
        window.openBot.listVerbatimMemories({
          botId: id,
          limit: PAGE_SIZE,
          ...(w.trim() ? { wing: w.trim() } : {}),
          ...(r.trim() ? { room: r.trim() } : {}),
        }),
      ]);
      setStats(st);
      setRows(list.records);
      setTotal(list.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('verbatim.loadError'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(activeBot?.id ?? null, wing, room);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBot?.id]);

  const refresh = () => {
    setNotice('');
    setQuery('');
    void load(activeBot?.id ?? null, wing, room);
  };

  const applyFilter = () => {
    setNotice('');
    void load(activeBot?.id ?? null, wing, room);
  };

  const runSearch = async () => {
    if (!activeBot || query.trim() === '') return;
    setSearching(true);
    setError('');
    try {
      const result = await window.openBot.searchVerbatimMemories({
        botId: activeBot.id,
        query: query.trim(),
        limit: 10,
        ...(wing.trim() ? { wing: wing.trim() } : {}),
        ...(room.trim() ? { room: room.trim() } : {}),
      });
      setSearchResult(result);
      setRows(result.hits);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('verbatim.searchError'));
    } finally {
      setSearching(false);
    }
  };

  const clearSearch = () => {
    setQuery('');
    setSearchResult(null);
    void load(activeBot?.id ?? null, wing, room);
  };

  const loadMore = async () => {
    if (!activeBot || searchResult) return;
    setLoadingMore(true);
    setError('');
    try {
      const list = await window.openBot.listVerbatimMemories({
        botId: activeBot.id,
        limit: PAGE_SIZE,
        offset: rows.length,
        ...(wing.trim() ? { wing: wing.trim() } : {}),
        ...(room.trim() ? { room: room.trim() } : {}),
      });
      setRows((prev) => [...prev, ...list.records]);
      setTotal(list.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('verbatim.loadError'));
    } finally {
      setLoadingMore(false);
    }
  };

  const deleteRecord = async (id: string) => {
    if (!activeBot) return;
    setError('');
    try {
      const result = await window.openBot.deleteVerbatimMemory({ botId: activeBot.id, id });
      if (result.deleted) {
        setRows((prev) => prev.filter((r) => r.id !== id));
        setTotal((prev) => Math.max(0, prev - 1));
        setStats((prev) => (prev ? { ...prev, total: Math.max(0, prev.total - 1) } : prev));
        setNotice(t('verbatim.deleted'));
      }
      setConfirmDeleteId('');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('verbatim.deleteError'));
    }
  };

  const exportAll = async () => {
    if (!activeBot) return;
    setError('');
    try {
      const json = await window.openBot.exportVerbatimMemories({ botId: activeBot.id });
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `verbatim-memories-${activeBot.id}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setNotice(t('verbatim.exported'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('verbatim.exportError'));
    }
  };

  const backfillAll = async () => {
    if (!activeBot) return;
    setError('');
    setNotice('');
    try {
      const result = await window.openBot.backfillVerbatimMemories({ botId: activeBot.id });
      setNotice(
        t('verbatim.backfilled', {
          embedded: String(result.embedded),
          skipped: String(result.skipped),
          failed: String(result.failed),
        }),
      );
      void load(activeBot.id, wing, room);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('verbatim.backfillError'));
    }
  };

  const runConsolidate = async () => {
    if (!activeBot) return;
    setConsolidating(true);
    setError('');
    setNotice('');
    setConfirmDedup(false);
    try {
      const report = await window.openBot.consolidateVerbatimMemories({
        botId: activeBot.id,
        ...(wing.trim() ? { wing: wing.trim() } : {}),
      });
      setConsolidate(report);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('verbatim.consolidateError'));
    } finally {
      setConsolidating(false);
    }
  };

  const applyDedup = async () => {
    if (!activeBot) return;
    setError('');
    try {
      const result = await window.openBot.applyVerbatimDedup({
        botId: activeBot.id,
        ...(wing.trim() ? { wing: wing.trim() } : {}),
      });
      setNotice(t('verbatim.dedupApplied', { deleted: String(result.deleted) }));
      setConsolidate(null);
      setConfirmDedup(false);
      void load(activeBot.id, wing, room);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('verbatim.dedupError'));
    }
  };

  if (!activeBot) {
    return (
      <div>
        <p className="hint">{t('verbatim.noBot')}</p>
      </div>
    );
  }

  return (
    <div>
      <h3>{t('verbatim.title')}</h3>
      <p className="hint">{t('verbatim.intro')}</p>
      <p className="hint">{t('verbatim.localOnly')}</p>

      {stats && (
        <p className="hint" data-testid="verbatim-stats">
          {t('verbatim.statsLine', {
            total: String(stats.total),
            embedded: String(stats.embedded),
            backend: stats.backend,
            ollama: stats.ollamaAvailable ? t('verbatim.ollamaOn') : t('verbatim.ollamaOff'),
          })}
        </p>
      )}
      {stats && Object.keys(stats.byWing).length > 0 && (
        <p className="hint" data-testid="verbatim-by-wing">
          {t('verbatim.byWing')}:{' '}
          {Object.entries(stats.byWing)
            .map(([w, n]) => `${w} (${n})`)
            .join(' · ')}
        </p>
      )}
      {stats && Object.keys(stats.bySource).length > 0 && (
        <p className="hint" data-testid="verbatim-by-source">
          {t('verbatim.bySource')}:{' '}
          {Object.entries(stats.bySource)
            .map(([s, n]) => `${s} (${n})`)
            .join(' · ')}
        </p>
      )}

      <div className="row">
        <label>
          {t('verbatim.bot')}
          <select
            data-testid="verbatim-bot"
            value={activeBot.id}
            onChange={(e) => onSelectBot(e.target.value)}
          >
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('verbatim.wing')}
          <input
            data-testid="verbatim-wing"
            value={wing}
            onChange={(e) => setWing(e.target.value)}
            placeholder={t('verbatim.wingPlaceholder')}
          />
        </label>
        <label>
          {t('verbatim.room')}
          <input
            data-testid="verbatim-room"
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            placeholder={t('verbatim.roomPlaceholder')}
          />
        </label>
        <button className="btn secondary" data-testid="verbatim-filter" onClick={applyFilter}>
          {t('verbatim.filter')}
        </button>
      </div>

      <div className="row">
        <input
          data-testid="verbatim-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runSearch();
          }}
          placeholder={t('verbatim.searchPlaceholder')}
        />
        <button
          className="btn"
          data-testid="verbatim-search-btn"
          onClick={() => void runSearch()}
          disabled={searching || query.trim() === ''}
        >
          {searching ? t('verbatim.searching') : t('verbatim.search')}
        </button>
        {searchResult && (
          <button className="btn secondary" data-testid="verbatim-clear-search" onClick={clearSearch}>
            {t('verbatim.clearSearch')}
          </button>
        )}
        <button className="btn secondary" data-testid="verbatim-export" onClick={() => void exportAll()}>
          {t('verbatim.export')}
        </button>
        <button className="btn secondary" data-testid="verbatim-backfill" onClick={() => void backfillAll()}>
          {t('verbatim.backfill')}
        </button>
        <button
          className="btn secondary"
          data-testid="verbatim-consolidate"
          onClick={() => void runConsolidate()}
          disabled={consolidating}
        >
          {consolidating ? t('verbatim.loading') : t('verbatim.consolidate')}
        </button>
      </div>

      {consolidate && (
        <div className="card" data-testid="verbatim-consolidate-report">
          <p className="hint">
            {t('verbatim.consolidateSummary', {
              examined: String(consolidate.examined),
              removable: String(consolidate.removable),
              groups: String(consolidate.groups.length),
              near: String(consolidate.nearDuplicates.length),
            })}
          </p>
          {consolidate.groups.slice(0, 5).map((g) => (
            <div key={g.key}>
              <p className="verbatim-text">{t('verbatim.keep')}: {g.keep.text}</p>
              {g.duplicates.map((d) => (
                <p key={d.id} className="hint">
                  {t('verbatim.duplicate')}: {d.text}
                </p>
              ))}
            </div>
          ))}
          {consolidate.removable > 0 &&
            (confirmDedup ? (
              <div className="row">
                <span>{t('verbatim.dedupConfirm')}</span>
                <button className="btn danger" data-testid="verbatim-dedup-confirm" onClick={() => void applyDedup()}>
                  {t('verbatim.dedupApply')}
                </button>
                <button className="btn secondary" onClick={() => setConfirmDedup(false)}>
                  {t('verbatim.cancel')}
                </button>
              </div>
            ) : (
              <button className="btn secondary" data-testid="verbatim-dedup" onClick={() => setConfirmDedup(true)}>
                {t('verbatim.dedupApply')}
              </button>
            ))}
        </div>
      )}

      {searchResult && (
        <p className="hint" data-testid="verbatim-search-note">
          {searchResult.usedFallback
            ? t('verbatim.usedFallback', { reason: searchResult.fallbackReason ?? '' })
            : t('verbatim.usedSemantic', { candidates: String(searchResult.candidates) })}
        </p>
      )}

      {loading && <p className="hint">{t('verbatim.loading')}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="notice">{notice}</p>}

      {!loading && rows.length === 0 && (
        <p className="hint" data-testid="verbatim-empty">
          {searchResult ? t('verbatim.noResults') : t('verbatim.empty')}
        </p>
      )}

      <ul className="list" data-testid="verbatim-list">
        {rows.map((row: Row) => (
          <li key={row.id} className="card" data-testid={`verbatim-row-${row.id}`}>
            <p className="verbatim-text">{row.text}</p>
            <p className="hint">
              {row.wing} / {row.room}
              {row.drawer ? ` / ${row.drawer}` : ''}
              {row.tags.length > 0 ? ` · ${row.tags.join(', ')}` : ''}
            </p>
            <p className="hint">
              {t('verbatim.source')}: {row.source} · {formatDate(row.createdAt)}
              {row.score !== undefined ? ` · ${t('verbatim.score')}: ${row.score.toFixed(3)}` : ''}
              {row.semanticScore !== undefined ? ` (${t('verbatim.semantic')}: ${row.semanticScore.toFixed(3)})` : ''}
            </p>
            {confirmDeleteId === row.id ? (
              <div className="row">
                <span>{t('verbatim.deleteConfirm')}</span>
                <button
                  className="btn danger"
                  data-testid={`verbatim-delete-confirm-${row.id}`}
                  onClick={() => void deleteRecord(row.id)}
                >
                  {t('verbatim.delete')}
                </button>
                <button className="btn secondary" onClick={() => setConfirmDeleteId('')}>
                  {t('verbatim.cancel')}
                </button>
              </div>
            ) : (
              <button
                className="btn secondary"
                data-testid={`verbatim-delete-${row.id}`}
                onClick={() => setConfirmDeleteId(row.id)}
              >
                {t('verbatim.delete')}
              </button>
            )}
          </li>
        ))}
      </ul>

      {!searchResult && rows.length > 0 && rows.length < total && (
        <button
          className="btn secondary"
          data-testid="verbatim-more"
          onClick={() => void loadMore()}
          disabled={loadingMore}
        >
          {loadingMore ? t('verbatim.loading') : t('verbatim.showMore', { shown: String(rows.length), total: String(total) })}
        </button>
      )}
      {!searchResult && rows.length > 0 && (
        <button className="btn secondary" onClick={refresh}>
          {t('verbatim.refresh')}
        </button>
      )}
    </div>
  );
}

// Re-export for tests that import the hit shape.
export type { VerbatimSearchHitView };
