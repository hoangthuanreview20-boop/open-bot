/**
 * MemoryV2View — memory v2 management (v0.97, Team T4).
 *
 * Three sections on one screen, all local:
 *  - Hybrid search: one query box over long-term memories, memory
 *    blocks and the temporal graph, with a per-result explanation of
 *    which signal matched (semantic / keyword / graph).
 *  - Temporal graph: entities + relations with validity windows,
 *    trust scores and quarantine flags.
 *  - Sleep agent: config (enabled, steps threshold), steps since the
 *    last run, last run report, and a manual run button. Runs are
 *    background work — the button only starts one, it never blocks
 *    the chat.
 *  - Provenance / quota: per-bot usage vs caps, so the user can see
 *    how full memory is before it starts refusing new facts.
 *
 * Props follow the MemoryBlocksView pattern (bots + botId +
 * onSelectBot). Mounted inside MemoryView under the "Memory v2" tab.
 */
import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';
import type {
  BotConfigLike,
  MemoryV2GraphView,
  MemoryV2ProvenanceView,
  MemoryV2SearchView,
  MemoryV2SleepView,
} from '../types';

interface Props {
  bots: BotConfigLike[];
  botId: string | null;
  onSelectBot: (id: string) => void;
}

export default function MemoryV2View({ bots, botId, onSelectBot }: Props) {
  const t = useT();
  const [graph, setGraph] = useState<MemoryV2GraphView | null>(null);
  const [sleep, setSleep] = useState<MemoryV2SleepView | null>(null);
  const [provenance, setProvenance] = useState<MemoryV2ProvenanceView | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<MemoryV2SearchView | null>(null);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const activeBot = bots.find((b) => b.id === botId) ?? bots[0] ?? null;

  const load = async (id: string | null) => {
    if (!id) {
      setGraph(null);
      setSleep(null);
      setProvenance(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [g, s, p] = await Promise.all([
        window.openBot.getMemoryV2Graph({ botId: id }),
        window.openBot.getMemoryV2Sleep({ botId: id, action: 'status' }),
        window.openBot.getMemoryV2Provenance({ botId: id }),
      ]);
      setGraph(g);
      setSleep(s);
      setProvenance(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryV2.loadError'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(activeBot?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBot?.id]);

  const refresh = () => {
    setNotice('');
    void load(activeBot?.id ?? null);
  };

  const runSearch = async () => {
    if (!activeBot || query.trim() === '') return;
    setSearching(true);
    setError('');
    try {
      const result = await window.openBot.searchMemoryV2({ botId: activeBot.id, query: query.trim(), topK: 10 });
      setSearch(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryV2.searchError'));
    } finally {
      setSearching(false);
    }
  };

  const toggleSleep = async () => {
    if (!activeBot || !sleep?.config) return;
    setError('');
    try {
      const next = await window.openBot.getMemoryV2Sleep({
        botId: activeBot.id,
        action: 'configure',
        enabled: !sleep.config.enabled,
      });
      setSleep((prev) => (prev ? { ...prev, config: next.config } : prev));
      setNotice(t('memoryV2.sleepUpdated'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryV2.saveError'));
    }
  };

  const runSleepNow = async () => {
    if (!activeBot) return;
    setError('');
    try {
      const result = await window.openBot.getMemoryV2Sleep({ botId: activeBot.id, action: 'run' });
      setSleep((prev) => (prev ? { ...prev, lastReport: result.report ?? prev.lastReport, stepsSinceLastRun: 0 } : prev));
      setNotice(t('memoryV2.sleepRan', { stored: result.report?.factsStored ?? 0 }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryV2.saveError'));
    }
  };

  if (!activeBot) {
    return <p>{t('memory.noBot')}</p>;
  }

  return (
    <div>
      <div className="row">
        <label>
          {t('memory.bot')}
          <select value={activeBot.id} onChange={(e) => onSelectBot(e.target.value)}>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" data-testid="memory-v2-refresh" onClick={refresh}>
          {t('memoryV2.refresh')}
        </button>
      </div>
      {loading && <p>{t('memory.loading')}</p>}
      {error !== '' && <p className="error">{error}</p>}
      {notice !== '' && <p>{notice}</p>}

      <h3>{t('memoryV2.searchTitle')}</h3>
      <div className="row">
        <input
          data-testid="memory-v2-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runSearch();
          }}
          placeholder={t('memoryV2.searchPlaceholder')}
          aria-label={t('memoryV2.searchTitle')}
        />
        <button type="button" data-testid="memory-v2-search-button" onClick={() => void runSearch()} disabled={searching || query.trim() === ''}>
          {searching ? t('memory.loading') : t('memoryV2.search')}
        </button>
      </div>
      {search && (
        <div>
          <p>
            {t('memoryV2.searchResults', { count: search.hits.length })}
            {!search.semanticAvailable && ` (${t('memoryV2.keywordOnly')})`}
          </p>
          {search.hits.map((hit) => (
            <div key={hit.id} className="card">
              <div>
                <strong>{hit.kind}</strong> — {hit.text}
              </div>
              <div>
                {t('memoryV2.score')}: {hit.score.toFixed(2)} · {hit.explanation}
              </div>
            </div>
          ))}
        </div>
      )}

      <h3>{t('memoryV2.sleepTitle')}</h3>
      {sleep?.config && (
        <div className="card">
          <p>
            {t('memoryV2.sleepEnabled')}: {sleep.config.enabled ? t('memoryV2.yes') : t('memoryV2.no')}
            {' · '}
            {t('memoryV2.stepsThreshold')}: {sleep.config.stepsThreshold}
            {' · '}
            {t('memoryV2.stepsSinceRun')}: {sleep.stepsSinceLastRun ?? 0}
          </p>
          <div className="row">
            <button type="button" data-testid="memory-v2-sleep-toggle" onClick={() => void toggleSleep()}>
              {sleep.config.enabled ? t('memoryV2.disableSleep') : t('memoryV2.enableSleep')}
            </button>
            <button type="button" data-testid="memory-v2-sleep-run" onClick={() => void runSleepNow()}>
              {t('memoryV2.runSleepNow')}
            </button>
          </div>
          {sleep.lastReport && (
            <p>
              {t('memoryV2.lastRun')}: {sleep.lastReport.ranAt} —{' '}
              {t('memoryV2.sleepSummary', {
                stored: sleep.lastReport.factsStored,
                flagged: sleep.lastReport.factsFlagged,
                contradictions: sleep.lastReport.contradictionsFound,
                entities: sleep.lastReport.graphEntitiesAdded,
                relations: sleep.lastReport.graphRelationsAdded,
              })}
            </p>
          )}
        </div>
      )}

      <h3>{t('memoryV2.graphTitle')}</h3>
      {graph && (
        <div>
          <p>
            {t('memoryV2.graphStats', { entities: graph.stats.entities, relations: graph.stats.relations })}
            {graph.stats.quarantinedEntities > 0 && ` · ${t('memoryV2.quarantined', { count: graph.stats.quarantinedEntities })}`}
          </p>
          {graph.entities.slice(0, 20).map((entity) => (
            <div key={entity.id} className="card">
              <div>
                <strong>{entity.name}</strong> ({entity.type})
                {entity.quarantined && ` — ${t('memoryV2.quarantinedLabel')}`}
              </div>
              {entity.description !== '' && <div>{entity.description}</div>}
              <div>
                {t('memoryV2.trust')}: {entity.trust.toFixed(2)}
                {entity.validFrom && ` · ${t('memoryV2.validFrom')}: ${entity.validFrom.slice(0, 10)}`}
                {entity.validTo && ` · ${t('memoryV2.validTo')}: ${entity.validTo.slice(0, 10)}`}
              </div>
            </div>
          ))}
          {graph.relations.slice(0, 20).map((relation) => {
            const from = graph.entities.find((e) => e.id === relation.fromEntityId)?.name ?? relation.fromEntityId;
            const to = graph.entities.find((e) => e.id === relation.toEntityId)?.name ?? relation.toEntityId;
            return (
              <div key={relation.id}>
                {from} — {relation.label} —&gt; {to}
                {relation.detail !== '' && ` (${relation.detail})`}
              </div>
            );
          })}
        </div>
      )}

      <h3>{t('memoryV2.quotaTitle')}</h3>
      {provenance && (
        <p>
          {t('memoryV2.quotaUsage', {
            items: provenance.usage.items,
            maxItems: provenance.quota.maxItems,
            chars: provenance.usage.chars,
            maxChars: provenance.quota.maxChars,
          })}
          {!provenance.quotaOk && ` — ${t('memoryV2.quotaExceeded')}`}
        </p>
      )}
    </div>
  );
}
