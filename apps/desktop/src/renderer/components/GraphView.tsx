/**
 * GraphView — temporal knowledge graph UI (v0.98, Team T1).
 *
 * View/search/delete facts in the temporal knowledge graph, review
 * quarantine (conflicting/suspicious facts awaiting the user), share
 * the graph with another bot, configure + run the sleep agent. All
 * local: the graph lives in `<workspace>/.open-bot/memory-graph.json`,
 * hybrid search runs over IPC `memory-graph:*` (vector embeddings
 * never reach the renderer).
 *
 * Props follow the MemoryBlocksView pattern (bots + botId +
 * onSelectBot). Mounted inside MemoryView under the "Knowledge graph"
 * tab.
 */
import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';
import type {
  BotConfigLike,
  GraphEntityView,
  GraphFactView,
  GraphQuarantineView,
  GraphSearchHitView,
  GraphShareView,
  GraphSleepConfigView,
  GraphSleepRunView,
  GraphStatsView,
} from '../types';

interface Props {
  bots: BotConfigLike[];
  botId: string | null;
  onSelectBot: (id: string) => void;
}

export default function GraphView({ bots, botId, onSelectBot }: Props) {
  const t = useT();
  const [facts, setFacts] = useState<GraphFactView[]>([]);
  const [entities, setEntities] = useState<GraphEntityView[]>([]);
  const [stats, setStats] = useState<GraphStatsView | null>(null);
  const [quarantine, setQuarantine] = useState<GraphQuarantineView[]>([]);
  const [shares, setShares] = useState<GraphShareView[]>([]);
  const [sleepConfig, setSleepConfig] = useState<GraphSleepConfigView | null>(null);
  const [sleepRuns, setSleepRuns] = useState<GraphSleepRunView[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState<GraphSearchHitView[] | null>(null);
  const [searchSources, setSearchSources] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState('active');
  const [history, setHistory] = useState<GraphFactView[] | null>(null);
  const [historyFactId, setHistoryFactId] = useState('');
  const [shareTargetId, setShareTargetId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState('');

  const activeBot = bots.find((b) => b.id === botId) ?? bots[0] ?? null;

  const load = async (id: string | null) => {
    if (!id) {
      setFacts([]);
      setEntities([]);
      setStats(null);
      setQuarantine([]);
      setShares([]);
      setSleepConfig(null);
      setSleepRuns([]);
      setSearchHits(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [factList, entityList, st, q, sh, sleep] = await Promise.all([
        window.openBot.listMemoryGraphFacts({ botId: id, status: statusFilter }),
        window.openBot.listMemoryGraphEntities({ botId: id }),
        window.openBot.getMemoryGraphStats({ botId: id }),
        window.openBot.reviewMemoryGraphQuarantine({ botId: id, action: 'list' }),
        window.openBot.shareMemoryGraph({ botId: id, action: 'list' }),
        window.openBot.getMemoryGraphSleep({ botId: id, action: 'status' }),
      ]);
      setFacts(factList);
      setEntities(entityList);
      setStats(st);
      setQuarantine(Array.isArray(q) ? q : []);
      setShares(Array.isArray(sh) ? (sh as GraphShareView[]) : []);
      if (sleep && 'config' in sleep) {
        setSleepConfig(sleep.config);
        setSleepRuns(sleep.runs ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryGraph.loadError'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(botId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId, statusFilter]);

  const reload = () => load(botId);

  const doSearch = async () => {
    if (!botId || searchQuery.trim() === '') return;
    setError('');
    try {
      const result = await window.openBot.searchMemoryGraph({ botId, query: searchQuery.trim() });
      setSearchHits(result.hits);
      setSearchSources(result.sourcesUsed);
      if (result.notes.length > 0) setNotice(result.notes.join(' '));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryGraph.searchError'));
    }
  };

  const doQuarantine = async (id: string, action: 'approve' | 'reject') => {
    if (!botId) return;
    setError('');
    try {
      await window.openBot.reviewMemoryGraphQuarantine({ botId, action, id });
      setNotice(action === 'approve' ? t('memoryGraph.quarantineApproved') : t('memoryGraph.quarantineRejected'));
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryGraph.quarantineError'));
    }
  };

  const doDelete = async (id: string) => {
    if (!botId) return;
    setError('');
    try {
      await window.openBot.deleteMemoryGraphFact({ botId, factId: id });
      setConfirmDeleteId('');
      setNotice(t('memoryGraph.deleted'));
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryGraph.deleteError'));
    }
  };

  const doHistory = async (factId: string) => {
    if (!botId) return;
    setError('');
    try {
      const h = await window.openBot.getMemoryGraphHistory({ botId, factId });
      setHistory(h);
      setHistoryFactId(factId);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryGraph.historyError'));
    }
  };

  const doShare = async () => {
    if (!botId || !shareTargetId) return;
    setError('');
    try {
      await window.openBot.shareMemoryGraph({ botId, action: 'share', targetBotId: shareTargetId, readOnly: true });
      setNotice(t('memoryGraph.sharedMsg'));
      setShareTargetId('');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryGraph.shareError'));
    }
  };

  const doSleepConfigure = async (enabled: boolean) => {
    if (!botId) return;
    setError('');
    try {
      const res = await window.openBot.getMemoryGraphSleep({ botId, action: 'configure', enabled });
      if (res && 'config' in res) setSleepConfig(res.config);
      setNotice(enabled ? t('memoryGraph.sleepEnabled') : t('memoryGraph.sleepDisabled'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryGraph.sleepError'));
    }
  };

  const doSleepRun = async () => {
    if (!botId) return;
    setError('');
    try {
      const res = await window.openBot.getMemoryGraphSleep({ botId, action: 'run' });
      if (res && 'episodesExamined' in res) {
        setNotice(
          t('memoryGraph.sleepRunDone', {
            examined: res.episodesExamined,
            added: res.added,
            updated: res.updated,
            quarantined: res.quarantined,
          }),
        );
      }
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryGraph.sleepError'));
    }
  };

  if (!activeBot) {
    return <p className="hint">{t('memoryGraph.noBot')}</p>;
  }

  return (
    <div data-testid="memory-graph-view">
      <p className="hint">{t('memoryGraph.intro')}</p>
      <p className="hint">{t('memoryGraph.localOnly')}</p>
      {stats && (
        <p className="hint" data-testid="memory-graph-stats">
          {t('memoryGraph.status', {
            facts: stats.activeFacts,
            entities: stats.entities,
            episodes: stats.episodes,
            unprocessed: stats.unprocessedEpisodes,
            quarantine: stats.pendingQuarantine,
          })}
        </p>
      )}
      <div className="row">
        <label>
          {t('memoryGraph.bot')}
          <select
            value={activeBot.id}
            data-testid="memory-graph-bot-select"
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
          {t('memoryGraph.statusFilter')}
          <select
            value={statusFilter}
            data-testid="memory-graph-status-filter"
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="active">{t('memoryGraph.statusActive')}</option>
            <option value="superseded">{t('memoryGraph.statusSuperseded')}</option>
            <option value="deleted">{t('memoryGraph.statusDeleted')}</option>
          </select>
        </label>
      </div>

      <div className="row">
        <input
          value={searchQuery}
          data-testid="memory-graph-search-input"
          placeholder={t('memoryGraph.searchPlaceholder')}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void doSearch();
          }}
        />
        <button className="btn secondary" data-testid="memory-graph-search-button" onClick={() => void doSearch()}>
          {t('memoryGraph.searchButton')}
        </button>
      </div>
      {searchHits !== null && (
        <div data-testid="memory-graph-search-results">
          <p className="hint">
            {t('memoryGraph.searchSources', { sources: searchSources.join(', ') || '—' })}
          </p>
          {searchHits.length === 0 ? (
            <p className="hint">{t('memoryGraph.searchEmpty')}</p>
          ) : (
            <ul>
              {searchHits.map((h) => (
                <li key={h.id} data-testid={`memory-graph-hit-${h.id}`}>
                  {h.displayText} · {t('memoryGraph.score', { score: h.score.toFixed(3) })} · {h.sources.join('+')}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {loading ? (
        <p className="hint">{t('memoryGraph.loading')}</p>
      ) : (
        <>
          <h3>{t('memoryGraph.factsTitle')}</h3>
          {facts.length === 0 ? (
            <p className="hint">{t('memoryGraph.empty')}</p>
          ) : (
            <ul>
              {facts.map((f) => (
                <li key={f.id} data-testid={`memory-graph-fact-${f.id}`}>
                  {f.displayText}
                  {' · '}
                  {t('memoryGraph.confidence', { value: f.confidence.toFixed(2) })}
                  {' · '}
                  {f.validFrom.slice(0, 10)}
                  {f.validUntil ? ` → ${f.validUntil.slice(0, 10)}` : ''}
                  {' '}
                  <button
                    className="btn secondary"
                    data-testid={`memory-graph-history-${f.id}`}
                    onClick={() => void doHistory(f.id)}
                  >
                    {t('memoryGraph.history')}
                  </button>
                  {' '}
                  {confirmDeleteId === f.id ? (
                    <button
                      className="btn secondary"
                      data-testid={`memory-graph-delete-confirm-${f.id}`}
                      onClick={() => void doDelete(f.id)}
                    >
                      {t('memoryGraph.deleteConfirm')}
                    </button>
                  ) : (
                    <button
                      className="btn secondary"
                      data-testid={`memory-graph-delete-${f.id}`}
                      onClick={() => setConfirmDeleteId(f.id)}
                    >
                      {t('memoryGraph.delete')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {history !== null && (
            <div data-testid="memory-graph-history-view">
              <h4>{t('memoryGraph.historyTitle')}</h4>
              <ul>
                {history.map((f) => (
                  <li key={f.id}>
                    {f.displayText} · {f.status} · {f.validFrom.slice(0, 10)}
                    {f.validUntil ? ` → ${f.validUntil.slice(0, 10)}` : ''}
                  </li>
                ))}
              </ul>
              <button
                className="btn secondary"
                data-testid="memory-graph-history-close"
                onClick={() => {
                  setHistory(null);
                  setHistoryFactId('');
                }}
              >
                {t('memoryGraph.close')}
              </button>
              <span>{historyFactId}</span>
            </div>
          )}

          <h3>{t('memoryGraph.entitiesTitle')}</h3>
          {entities.length === 0 ? (
            <p className="hint">{t('memoryGraph.entitiesEmpty')}</p>
          ) : (
            <p className="hint" data-testid="memory-graph-entities">
              {entities.map((e) => `${e.name} (${e.factCount})`).join(' · ')}
            </p>
          )}

          <h3>{t('memoryGraph.quarantineTitle')}</h3>
          {quarantine.length === 0 ? (
            <p className="hint">{t('memoryGraph.quarantineEmpty')}</p>
          ) : (
            <ul>
              {quarantine.map((q) => (
                <li key={q.id} data-testid={`memory-graph-quarantine-${q.id}`}>
                  {q.candidate.subjectName} —{q.candidate.predicate}→ {q.candidate.objectText}
                  {' · '}
                  {t(`memoryGraph.quarantineReason.${q.reason}`)}
                  {' · '}
                  {q.detail}
                  {' '}
                  <button
                    className="btn secondary"
                    data-testid={`memory-graph-quarantine-approve-${q.id}`}
                    onClick={() => void doQuarantine(q.id, 'approve')}
                  >
                    {t('memoryGraph.approve')}
                  </button>
                  {' '}
                  <button
                    className="btn secondary"
                    data-testid={`memory-graph-quarantine-reject-${q.id}`}
                    onClick={() => void doQuarantine(q.id, 'reject')}
                  >
                    {t('memoryGraph.reject')}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <h3>{t('memoryGraph.shareTitle')}</h3>
          <div className="row">
            <select
              value={shareTargetId}
              data-testid="memory-graph-share-target"
              onChange={(e) => setShareTargetId(e.target.value)}
            >
              <option value="">{t('memoryGraph.chooseBot')}</option>
              {bots
                .filter((b) => b.id !== activeBot.id)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
            </select>
            <button
              className="btn secondary"
              data-testid="memory-graph-share-button"
              onClick={() => void doShare()}
              disabled={!shareTargetId}
            >
              {t('memoryGraph.share')}
            </button>
          </div>
          {shares.length > 0 && (
            <p className="hint" data-testid="memory-graph-shares">
              {t('memoryGraph.sharedWith', { bots: shares.map((s) => s.targetBotId).join(', ') })}
            </p>
          )}

          <h3>{t('memoryGraph.sleepTitle')}</h3>
          {sleepConfig && (
            <p className="hint" data-testid="memory-graph-sleep-status">
              {t('memoryGraph.sleepStatus', {
                enabled: sleepConfig.enabled ? t('memoryGraph.sleepOn') : t('memoryGraph.sleepOff'),
                afterTurns: sleepConfig.afterTurns,
              })}
            </p>
          )}
          <div className="row">
            <button
              className="btn secondary"
              data-testid="memory-graph-sleep-run"
              onClick={() => void doSleepRun()}
            >
              {t('memoryGraph.sleepRun')}
            </button>
            {sleepConfig && (
              <button
                className="btn secondary"
                data-testid="memory-graph-sleep-toggle"
                onClick={() => void doSleepConfigure(!sleepConfig.enabled)}
              >
                {sleepConfig.enabled ? t('memoryGraph.sleepDisable') : t('memoryGraph.sleepEnable')}
              </button>
            )}
          </div>
          {sleepRuns.length > 0 && (
            <ul>
              {sleepRuns.slice(0, 5).map((r) => (
                <li key={r.at} data-testid="memory-graph-sleep-run-log">
                  {r.at.slice(0, 19).replace('T', ' ')} · {r.trigger} · +{r.added} ~{r.updated} −{r.deleted} Q{r.quarantined}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {error !== '' && <p className="error">{error}</p>}
      {notice !== '' && <p className="hint">{notice}</p>}
    </div>
  );
}
