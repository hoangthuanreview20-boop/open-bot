/**
 * MemoryView — long-term memory management (v0.95, Team D4).
 *
 * List / search / view / edit / delete memories of one bot (plus shared
 * memories), export to JSON. Everything local: memories live in
 * `<workspace>/.open-bot/memories.json`, embeddings via local Ollama
 * (nomic-embed-text); embedding vectors are NEVER shown in the UI.
 *
 * Props follow the CanvasView/AutomationsView pattern (bots + botId +
 * onSelectBot + onBack). Inline edit: value + tags (comma-separated).
 * Delete asks for confirmation in two steps (no window.confirm).
 */
import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';
import type { BotConfigLike, MemoryEntryView } from '../types';
import MemoryBlocksView from './MemoryBlocksView';
import MemoryV2View from './MemoryV2View';
import GraphView from './GraphView';
import MemoryNotesView from './MemoryNotesView';
import VerbatimMemoryView from './VerbatimMemoryView';
import MemoryV3View from './MemoryV3View';

interface Props {
  bots: BotConfigLike[];
  botId: string | null;
  onBack: () => void;
  onSelectBot: (id: string) => void;
}

function parseTags(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(',')) {
    const item = part.trim().toLowerCase();
    if (item === '' || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

export default function MemoryView({ bots, botId, onBack, onSelectBot }: Props) {
  const t = useT();
  const [entries, setEntries] = useState<MemoryEntryView[]>([]);
  const [status, setStatus] = useState<{ total: number; embedded: number; ollamaAvailable: boolean; embeddingModel: string } | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState('');
  const [editValue, setEditValue] = useState('');
  const [editTags, setEditTags] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState('');
  const [notice, setNotice] = useState('');
  // v0.96 (Team T1): memory blocks tab — same MemoryView screen.
  // v0.96 (Team T1): memory blocks tab — same MemoryView screen.
  // v0.97 (Team T4): memory v2 tab (graph + hybrid search + sleep agent).
  // v0.98 (Team T1): knowledge graph tab.
  // v1.01 (Team T4): verbatim memory tab (verbatim, local-first).
  // v1.01 (Team T5): evolving notes tab.
  // v1.02 (Team T2): memory v3 tab (block conflicts, temporal contradictions, block history).
  const [tab, setTab] = useState<'memories' | 'blocks' | 'v2' | 'graph' | 'verbatim' | 'notes' | 'v3'>('memories');

  const activeBot = bots.find((b) => b.id === botId) ?? bots[0] ?? null;

  const load = async (id: string | null, q: string) => {
    if (!id) {
      setEntries([]);
      setStatus(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [list, st] = await Promise.all([
        window.openBot.listMemories({ botId: id, ...(q.trim() ? { query: q.trim() } : {}) }),
        window.openBot.getMemoryStatus({ botId: id }),
      ]);
      setEntries(list);
      setStatus(st);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memory.loadError'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(activeBot?.id ?? null, '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBot?.id]);

  const search = () => {
    setNotice('');
    void load(activeBot?.id ?? null, query);
  };

  const startEdit = (entry: MemoryEntryView) => {
    setEditingId(entry.id);
    setEditValue(entry.value);
    setEditTags(entry.tags.join(', '));
    setConfirmDeleteId('');
    setNotice('');
  };

  const saveEdit = async (entry: MemoryEntryView) => {
    if (!activeBot) return;
    setError('');
    try {
      const updated = await window.openBot.updateMemory({
        botId: activeBot.id,
        id: entry.id,
        value: editValue,
        tags: parseTags(editTags),
      });
      setEntries((prev) => prev.map((e) => (e.id === entry.id ? updated : e)));
      setEditingId('');
      setNotice(t('memory.updated'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memory.saveError'));
    }
  };

  const remove = async (entry: MemoryEntryView) => {
    if (!activeBot) return;
    setError('');
    try {
      const res = await window.openBot.deleteMemory({ botId: activeBot.id, id: entry.id });
      if (res.deleted) {
        setEntries((prev) => prev.filter((e) => e.id !== entry.id));
        setNotice(t('memory.deleted'));
      } else {
        setError(t('memory.deleteError'));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memory.deleteError'));
    } finally {
      setConfirmDeleteId('');
    }
  };

  const exportAll = async () => {
    if (!activeBot) return;
    setError('');
    try {
      const json = await window.openBot.exportMemories({ botId: activeBot.id });
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `open-bot-memories-${activeBot.id}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setNotice(t('memory.exported'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memory.exportError'));
    }
  };

  const scopeLabel = (entry: MemoryEntryView): string =>
    entry.botId === '' ? t('memory.shared') : (bots.find((b) => b.id === entry.botId)?.name ?? entry.botId);

  return (
    <div className="main">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>{t('memory.title')}</h2>
        <button className="btn secondary" data-testid="memory-back" onClick={onBack}>
          {t('memory.back')}
        </button>
      </div>
      <p className="hint">{t('memory.intro')}</p>
      <p className="hint">{t('memory.localOnly')}</p>
      <div className="row" data-testid="memory-tabs">
        <button
          className="btn secondary"
          data-testid="memory-tab-memories"
          onClick={() => setTab('memories')}
          disabled={tab === 'memories'}
        >
          {t('memory.tabMemories')}
        </button>
        <button
          className="btn secondary"
          data-testid="memory-tab-blocks"
          onClick={() => setTab('blocks')}
          disabled={tab === 'blocks'}
        >
          {t('memory.tabBlocks')}
        </button>
        <button
          className="btn secondary"
          data-testid="memory-tab-v2"
          onClick={() => setTab('v2')}
          disabled={tab === 'v2'}
        >
          {t('memory.tabV2')}
        </button>
        <button
          className="btn secondary"
          data-testid="memory-tab-graph"
          onClick={() => setTab('graph')}
          disabled={tab === 'graph'}
        >
          {t('memory.tabGraph')}
        </button>
        <button
          className="btn secondary"
          data-testid="memory-tab-verbatim"
          onClick={() => setTab('verbatim')}
          disabled={tab === 'verbatim'}
        >
          {t('memory.tabVerbatim')}
        </button>
        <button
          className="btn secondary"
          data-testid="memory-tab-notes"
          onClick={() => setTab('notes')}
          disabled={tab === 'notes'}
        >
          {t('memory.tabNotes')}
        </button>
        <button
          className="btn secondary"
          data-testid="memory-tab-v3"
          onClick={() => setTab('v3')}
          disabled={tab === 'v3'}
        >
          {t('memory.tabV3')}
        </button>
      </div>
      {tab === 'verbatim' ? (
        <VerbatimMemoryView bots={bots} botId={botId} onSelectBot={onSelectBot} />
      ) : tab === 'v3' ? (
        <MemoryV3View bots={bots} botId={botId} onSelectBot={onSelectBot} />
      ) : tab === 'v2' ? (
        <MemoryV2View bots={bots} botId={botId} onSelectBot={onSelectBot} />
      ) : tab === 'blocks' ? (
        <MemoryBlocksView bots={bots} botId={botId} onSelectBot={onSelectBot} />
      ) : tab === 'graph' ? (
        <GraphView bots={bots} botId={botId} onSelectBot={onSelectBot} />
      ) : tab === 'notes' ? (
        <MemoryNotesView bots={bots} botId={botId} onSelectBot={onSelectBot} />
      ) : (
        <>
      {status && (
        <p className="hint" data-testid="memory-status">
          {t('memory.status', {
            total: status.total,
            embedded: status.embedded,
            ollama: status.ollamaAvailable ? t('memory.ollamaOn') : t('memory.ollamaOff'),
            model: status.embeddingModel,
          })}
        </p>
      )}
      <div className="row">
        <label>
          {t('memory.bot')}
          <select
            value={activeBot?.id ?? ''}
            data-testid="memory-bot-select"
            onChange={(e) => onSelectBot(e.target.value)}
          >
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label style={{ flex: 1 }}>
          {t('memory.search')}
          <input
            type="text"
            value={query}
            data-testid="memory-search"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') search();
            }}
            placeholder={t('memory.searchPlaceholder')}
          />
        </label>
        <button className="btn secondary" data-testid="memory-search-btn" onClick={search}>
          {t('memory.searchButton')}
        </button>
        <button className="btn secondary" data-testid="memory-export" onClick={() => void exportAll()} disabled={!activeBot}>
          {t('memory.export')}
        </button>
      </div>
      {loading && <p className="hint" data-testid="memory-loading">{t('memory.loading')}</p>}
      {error && <p className="error">{error}</p>}
      {notice && <p className="hint" data-testid="memory-notice">{notice}</p>}
      {!loading && !activeBot && <p className="hint">{t('memory.noBot')}</p>}
      {!loading && activeBot && entries.length === 0 && (
        <p className="hint" data-testid="memory-empty">{t('memory.empty')}</p>
      )}
      {!loading && entries.length > 0 && (
        <ul data-testid="memory-list">
          {entries.map((entry) => (
            <li key={entry.id} className="card" data-testid={`memory-row-${entry.id}`}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>{entry.key}</strong>
                <span className="hint">{scopeLabel(entry)}</span>
              </div>
              {editingId === entry.id ? (
                <>
                  <textarea
                    value={editValue}
                    data-testid={`memory-edit-value-${entry.id}`}
                    onChange={(e) => setEditValue(e.target.value)}
                    rows={3}
                  />
                  <label>
                    {t('memory.tags')}
                    <input
                      type="text"
                      value={editTags}
                      data-testid={`memory-edit-tags-${entry.id}`}
                      onChange={(e) => setEditTags(e.target.value)}
                      placeholder={t('memory.tagsPlaceholder')}
                    />
                  </label>
                  <div className="row">
                    <button className="btn" data-testid={`memory-save-${entry.id}`} onClick={() => void saveEdit(entry)}>
                      {t('memory.save')}
                    </button>
                    <button className="btn secondary" onClick={() => setEditingId('')}>
                      {t('memory.cancel')}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p>{entry.value}</p>
                  <p className="hint">
                    {entry.tags.length > 0 ? `${t('memory.tags')}: ${entry.tags.join(', ')} · ` : ''}
                    {t('memory.confidence')}: {entry.confidence.toFixed(2)}
                  </p>
                  <div className="row">
                    <button className="btn secondary" data-testid={`memory-edit-${entry.id}`} onClick={() => startEdit(entry)}>
                      {t('memory.edit')}
                    </button>
                    {confirmDeleteId === entry.id ? (
                      <>
                        <button className="btn" data-testid={`memory-delete-confirm-${entry.id}`} onClick={() => void remove(entry)}>
                          {t('memory.deleteConfirm')}
                        </button>
                        <button className="btn secondary" onClick={() => setConfirmDeleteId('')}>
                          {t('memory.cancel')}
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn secondary"
                        data-testid={`memory-delete-${entry.id}`}
                        onClick={() => setConfirmDeleteId(entry.id)}
                      >
                        {t('memory.delete')}
                      </button>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
        </>
      )}
    </div>
  );
}
