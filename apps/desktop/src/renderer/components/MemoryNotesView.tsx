/**
 * MemoryNotesView — evolving notes UI (v1.01, Team T5).
 *
 * List / search / create / revisit notes, view version history + links +
 * backlinks, link suggestions, conflict review, graph (SVG) + timeline,
 * run a synthetic memory benchmark. All local: notes live in
 * `<workspace>/.open-bot/memory-notes.json`, via IPC `memory-notes:*`
 * (no vector embedding).
 *
 * Props follow the GraphView pattern (bots + botId + onSelectBot).
 * Mounted inside MemoryView under the "Evolving notes" tab.
 */
import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';
import type {
  BenchmarkReportView,
  BotConfigLike,
  LinkSuggestionView,
  NoteConflictView,
  NoteTimelineEventView,
  NotesGraphView,
  NotesStatsView,
  NoteView,
} from '../types';

interface Props {
  bots: BotConfigLike[];
  botId: string | null;
  onSelectBot: (id: string) => void;
}

const NOTE_KINDS = ['fact', 'preference', 'event', 'project', 'person', 'place', 'idea', 'other'] as const;

function kindLabel(t: ReturnType<typeof useT>, kind: string): string {
  const key = `notes.kind${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
  return t(key);
}

function linkKindLabel(t: ReturnType<typeof useT>, kind: string): string {
  if (kind === 'part-of') return t('notes.linkKindPartOf');
  if (kind === 'related') return t('notes.linkKindRelated');
  if (kind === 'supports') return t('notes.linkKindSupports');
  if (kind === 'contradicts') return t('notes.linkKindContradicts');
  if (kind === 'supersedes') return t('notes.linkKindSupersedes');
  return kind;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** Simple circular layout for the SVG graph (no external library). */
function circleLayout(count: number, width: number, height: number): Array<{ x: number; y: number }> {
  const cx = width / 2;
  const cy = height / 2;
  const rx = width / 2 - 50;
  const ry = height / 2 - 40;
  if (count === 1) return [{ x: cx, y: cy }];
  return Array.from({ length: count }, (_, i) => {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2;
    return { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) };
  });
}

export default function MemoryNotesView({ bots, botId, onSelectBot }: Props) {
  const t = useT();
  const [notes, setNotes] = useState<NoteView[]>([]);
  const [stats, setStats] = useState<NotesStatsView | null>(null);
  const [conflicts, setConflicts] = useState<NoteConflictView[]>([]);
  const [graph, setGraph] = useState<NotesGraphView | null>(null);
  const [timeline, setTimeline] = useState<NoteTimelineEventView[]>([]);
  const [benchmark, setBenchmark] = useState<BenchmarkReportView | null>(null);
  const [query, setQuery] = useState('');
  const [searchHits, setSearchHits] = useState<NoteView[] | null>(null);
  const [orphansOnly, setOrphansOnly] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [selected, setSelected] = useState<{ note: NoteView; backlinks: Array<{ fromId: string; fromTitle: string; kind: string }> } | null>(null);
  const [suggestions, setSuggestions] = useState<LinkSuggestionView[]>([]);
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [newKind, setNewKind] = useState('fact');
  const [newTags, setNewTags] = useState('');
  const [newAutoLink, setNewAutoLink] = useState(true);
  const [revisitText, setRevisitText] = useState('');
  const [loading, setLoading] = useState(true);
  const [benchRunning, setBenchRunning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState('');
  const [showGraph, setShowGraph] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);

  const activeBot = bots.find((b) => b.id === botId) ?? bots[0] ?? null;

  const load = async (id: string | null) => {
    if (!id) {
      setNotes([]);
      setStats(null);
      setConflicts([]);
      setGraph(null);
      setTimeline([]);
      setSelected(null);
      setSelectedId('');
      setSearchHits(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [list, conflictsRes] = await Promise.all([
        window.openBot.listMemoryNotes({ botId: id, orphans: orphansOnly }),
        window.openBot.reviewMemoryNoteConflicts({ botId: id, action: 'list' }),
      ]);
      if ('notes' in list) {
        setNotes(list.notes);
        setStats(list.stats);
      } else {
        setNotes(list.orphans);
        setStats(null);
      }
      setConflicts(conflictsRes.conflicts ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('notes.loadError'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(botId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId, orphansOnly]);

  const reload = () => load(botId);

  const doSearch = async () => {
    if (!botId || query.trim() === '') {
      setSearchHits(null);
      return;
    }
    setError('');
    try {
      const result = await window.openBot.searchMemoryNotes({ botId, query: query.trim() });
      setSearchHits(result.hits);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('notes.loadError'));
    }
  };

  const doCreate = async () => {
    if (!botId || newTitle.trim() === '' || newBody.trim() === '') return;
    setError('');
    try {
      const result = await window.openBot.createMemoryNote({
        botId,
        title: newTitle.trim(),
        body: newBody.trim(),
        kind: newKind,
        tags: newTags.split(',').map((s) => s.trim()).filter(Boolean),
        autoLink: newAutoLink,
      });
      setNewTitle('');
      setNewBody('');
      setNewTags('');
      setNotice(
        result.linkSuggestions.length > 0
          ? `${t('notes.createdOk')} (${result.linkSuggestions.length} link suggestions)`
          : t('notes.createdOk'),
      );
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('notes.loadError'));
    }
  };

  const doSelect = async (id: string) => {
    if (!botId) return;
    setSelectedId(id);
    setSuggestions([]);
    setRevisitText('');
    setError('');
    try {
      const detail = await window.openBot.getMemoryNote({ botId, noteId: id, includeVersions: true });
      setSelected(detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('notes.loadError'));
    }
  };

  const doSuggestLinks = async () => {
    if (!botId || !selectedId) return;
    setError('');
    try {
      const result = await window.openBot.suggestMemoryNoteLinks({ botId, noteId: selectedId });
      setSuggestions(result.suggestions);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('notes.loadError'));
    }
  };

  const doAddLink = async (targetId: string, kind: string) => {
    if (!botId || !selectedId) return;
    setError('');
    try {
      await window.openBot.linkMemoryNote({ botId, noteId: selectedId, targetId, kind });
      setNotice(t('notes.linkAdded'));
      await doSelect(selectedId);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('notes.loadError'));
    }
  };

  const doRevisit = async (mode: 'apply' | 'analyze') => {
    if (!botId || !selectedId || revisitText.trim() === '') return;
    setError('');
    try {
      const result = await window.openBot.revisitMemoryNote({ botId, noteId: selectedId, newText: revisitText.trim(), mode });
      if (mode === 'analyze') {
        setNotice(result.analysis ? `${result.analysis.decision}: ${result.analysis.explanation}` : '');
        return;
      }
      if (result.decision === 'contradiction') {
        setNotice(t('notes.conflictCreated'));
      } else {
        setNotice(t('notes.revisitOk'));
      }
      setRevisitText('');
      await doSelect(selectedId);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('notes.loadError'));
    }
  };

  const doDelete = async (id: string) => {
    if (!botId) return;
    setError('');
    try {
      await window.openBot.deleteMemoryNote({ botId, noteId: id });
      setConfirmDeleteId('');
      setNotice(t('notes.deletedOk'));
      if (selectedId === id) {
        setSelected(null);
        setSelectedId('');
      }
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('notes.loadError'));
    }
  };

  const doRestore = async (id: string) => {
    if (!botId) return;
    setError('');
    try {
      await window.openBot.restoreMemoryNote({ botId, noteId: id });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('notes.loadError'));
    }
  };

  const doResolveConflict = async (id: string, resolution: 'supersede' | 'merge' | 'keep-both') => {
    if (!botId) return;
    setError('');
    try {
      await window.openBot.reviewMemoryNoteConflicts({ botId, action: 'resolve', id, resolution });
      setNotice(t('notes.revisitOk'));
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('notes.loadError'));
    }
  };

  const doDismissConflict = async (id: string) => {
    if (!botId) return;
    setError('');
    try {
      await window.openBot.reviewMemoryNoteConflicts({ botId, action: 'dismiss', id });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('notes.loadError'));
    }
  };

  const doToggleGraph = async () => {
    if (!botId) return;
    if (showGraph) {
      setShowGraph(false);
      return;
    }
    setError('');
    try {
      const g = await window.openBot.getMemoryNotesGraph({ botId });
      setGraph(g);
      setShowGraph(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('notes.loadError'));
    }
  };

  const doToggleTimeline = async () => {
    if (!botId) return;
    if (showTimeline) {
      setShowTimeline(false);
      return;
    }
    setError('');
    try {
      const res = await window.openBot.getMemoryNotesTimeline({ botId });
      setTimeline(res.events);
      setShowTimeline(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('notes.loadError'));
    }
  };

  const doBenchmark = async () => {
    setBenchRunning(true);
    setError('');
    try {
      const result = await window.openBot.runMemoryNotesBenchmark({ seed: 10101, personas: 10, topK: 10 });
      if ('metrics' in result) setBenchmark(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('notes.loadError'));
    } finally {
      setBenchRunning(false);
    }
  };

  const doImport = async () => {
    if (!botId) return;
    setError('');
    try {
      await window.openBot.importMemoryNotes({ botId, source: 'both' });
      setNotice(t('notes.imported'));
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('notes.loadError'));
    }
  };

  const visibleNotes = searchHits ?? notes;
  const graphPositions = graph ? circleLayout(graph.nodes.length, 640, 360) : [];

  return (
    <div data-testid="memory-notes-view">
      <p className="hint">{t('notes.intro')}</p>
      <div className="row" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          aria-label="bot"
          value={botId ?? ''}
          onChange={(e) => onSelectBot(e.target.value)}
        >
          {bots.map((b) => (
            <option key={b.id} value={b.id}>{b.name ?? b.id}</option>
          ))}
        </select>
        <button className="btn secondary" data-testid="notes-import" onClick={() => void doImport()} disabled={!botId}>
          {t('notes.import')}
        </button>
        <button className="btn secondary" data-testid="notes-graph-toggle" onClick={() => void doToggleGraph()} disabled={!botId}>
          {t('notes.graph')}
        </button>
        <button className="btn secondary" data-testid="notes-timeline-toggle" onClick={() => void doToggleTimeline()} disabled={!botId}>
          {t('notes.timeline')}
        </button>
      </div>
      {stats && (
        <p className="hint" data-testid="notes-stats">
          {t('notes.stats')}: {stats.active} active · {stats.totalLinks} links · {stats.orphans} orphans
          {stats.topHub ? ` · ${t('notes.hub')}: ${stats.topHub.title} (${stats.topHub.degree})` : ''}
          {stats.pendingConflicts > 0 ? ` · ${t('notes.conflicts')}: ${stats.pendingConflicts}` : ''}
        </p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="hint" role="status">{notice}</p>}
      {!activeBot && <p className="hint">{t('notes.noBot')}</p>}
      {loading && <p className="hint">{t('notes.loading')}</p>}

      {conflicts.length > 0 && (
        <section>
          <h3>{t('notes.conflicts')} ({conflicts.length})</h3>
          {conflicts.map((c) => (
            <div key={c.id} className="card" data-testid={`notes-conflict-${c.id}`}>
              <p><strong>{c.noteTitle}</strong> — {c.detail}</p>
              <p className="hint">{c.newText}</p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn secondary" onClick={() => void doResolveConflict(c.id, 'supersede')}>{t('notes.resolve')} (supersede)</button>
                <button className="btn secondary" onClick={() => void doResolveConflict(c.id, 'merge')}>{t('notes.resolve')} (merge)</button>
                <button className="btn secondary" onClick={() => void doResolveConflict(c.id, 'keep-both')}>{t('notes.resolve')} (keep-both)</button>
                <button className="btn secondary" onClick={() => void doDismissConflict(c.id)}>{t('notes.dismiss')}</button>
              </div>
            </div>
          ))}
        </section>
      )}

      <section>
        <h3>{t('notes.createTitle')}</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            aria-label={t('notes.titleLabel')}
            placeholder={t('notes.titlePlaceholder')}
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <textarea
            aria-label={t('notes.bodyLabel')}
            placeholder={t('notes.bodyPlaceholder')}
            value={newBody}
            onChange={(e) => setNewBody(e.target.value)}
            rows={3}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select aria-label={t('notes.kindLabel')} value={newKind} onChange={(e) => setNewKind(e.target.value)}>
              {NOTE_KINDS.map((k) => (
                <option key={k} value={k}>{kindLabel(t, k)}</option>
              ))}
            </select>
            <input
              aria-label={t('notes.tagsLabel')}
              placeholder={t('notes.tagsLabel')}
              value={newTags}
              onChange={(e) => setNewTags(e.target.value)}
            />
            <label>
              <input type="checkbox" checked={newAutoLink} onChange={(e) => setNewAutoLink(e.target.checked)} /> {t('notes.autoLink')}
            </label>
            <button className="btn" data-testid="notes-save" onClick={() => void doCreate()} disabled={!botId || newTitle.trim() === '' || newBody.trim() === ''}>
              {t('notes.save')}
            </button>
          </div>
        </div>
      </section>

      <section>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            aria-label={t('notes.searchPlaceholder')}
            placeholder={t('notes.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doSearch();
            }}
          />
          <button className="btn secondary" data-testid="notes-search" onClick={() => void doSearch()}>{t('notes.searchButton')}</button>
          <label>
            <input type="checkbox" checked={orphansOnly} onChange={(e) => setOrphansOnly(e.target.checked)} /> {t('notes.orphansOnly')}
          </label>
        </div>
        {visibleNotes.length === 0 && !loading && <p className="hint">{t('notes.empty')}</p>}
        <ul>
          {visibleNotes.map((note) => (
            <li key={note.id} data-testid={`notes-item-${note.id}`}>
              <button className="btn secondary" onClick={() => void doSelect(note.id)}>
                {note.title}
              </button>{' '}
              <span className="hint">
                {kindLabel(t, note.kind)} · v{note.version} · {note.links.length} links
                {note.tags.length > 0 ? ` · ${note.tags.join(', ')}` : ''}
                {note.status !== 'active' ? ` · ${note.status}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {selected && (
        <section data-testid="notes-detail">
          <h3>{selected.note.title}</h3>
          <p className="hint">
            {kindLabel(t, selected.note.kind)} · v{selected.note.version} · {t('notes.created')}: {formatDate(selected.note.createdAt)} · {t('notes.updated')}: {formatDate(selected.note.updatedAt)}
          </p>
          <p style={{ whiteSpace: 'pre-wrap' }}>{selected.note.body}</p>
          {selected.note.supersededBy && (
            <p className="hint">{t('notes.supersededBy')}: {selected.note.supersededBy}</p>
          )}
          {selected.note.supersedes && (
            <p className="hint">{t('notes.supersedes')}: {selected.note.supersedes}</p>
          )}
          <h4>{t('notes.links')} ({selected.note.links.length})</h4>
          {selected.note.links.length === 0 && <p className="hint">—</p>}
          <ul>
            {selected.note.links.map((l, i) => (
              <li key={`${l.targetId}-${l.kind}-${i}`}>
                {linkKindLabel(t, l.kind)} → {l.targetId} ({l.weight.toFixed(2)}{l.auto ? ', auto' : ''})
              </li>
            ))}
          </ul>
          <h4>{t('notes.backlinks')} ({selected.backlinks.length})</h4>
          <ul>
            {selected.backlinks.map((b) => (
              <li key={b.fromId}>
                <button className="btn secondary" onClick={() => void doSelect(b.fromId)}>{b.fromTitle}</button>{' '}
                <span className="hint">{linkKindLabel(t, b.kind)}</span>
              </li>
            ))}
          </ul>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn secondary" data-testid="notes-suggest-links" onClick={() => void doSuggestLinks()}>{t('notes.suggestLinks')}</button>
            {selected.note.status === 'deleted' ? (
              <button className="btn secondary" onClick={() => void doRestore(selected.note.id)}>{t('notes.restore')}</button>
            ) : (
              <>
                {confirmDeleteId === selected.note.id ? (
                  <button className="btn" onClick={() => void doDelete(selected.note.id)}>{t('notes.delete')}?</button>
                ) : (
                  <button className="btn secondary" onClick={() => setConfirmDeleteId(selected.note.id)}>{t('notes.delete')}</button>
                )}
              </>
            )}
            <button className="btn secondary" onClick={() => { setSelected(null); setSelectedId(''); }}>{t('notes.close')}</button>
          </div>
          {suggestions.length > 0 && (
            <ul>
              {suggestions.map((s) => (
                <li key={s.targetId}>
                  {s.targetTitle} ({s.score.toFixed(2)} — {s.reason})
                  <button className="btn secondary" onClick={() => void doAddLink(s.targetId, s.kind)}>{t('notes.linkAdded')}</button>
                </li>
              ))}
            </ul>
          )}
          {selected.note.versions && selected.note.versions.length > 0 && (
            <>
              <h4>{t('notes.versions')} ({selected.note.versions.length})</h4>
              <ul>
                {selected.note.versions.map((v) => (
                  <li key={v.version}>
                    <strong>v{v.version}</strong> ({v.reason}, {formatDate(v.createdAt)}): {v.title} — {v.body.slice(0, 200)}
                  </li>
                ))}
              </ul>
            </>
          )}
          <h4>{t('notes.revisit')}</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <textarea
              aria-label={t('notes.revisitPlaceholder')}
              placeholder={t('notes.revisitPlaceholder')}
              value={revisitText}
              onChange={(e) => setRevisitText(e.target.value)}
              rows={2}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn secondary" onClick={() => void doRevisit('analyze')}>{t('notes.analyze')}</button>
              <button className="btn" onClick={() => void doRevisit('apply')} disabled={revisitText.trim() === ''}>{t('notes.revisitApply')}</button>
            </div>
          </div>
        </section>
      )}

      {showGraph && graph && (
        <section data-testid="notes-graph">
          <h3>{t('notes.graph')} ({graph.nodeCount} nodes, {graph.edgeCount} edges)</h3>
          {graph.nodeCount === 0 && <p className="hint">{t('notes.graphEmpty')}</p>}
          {graph.nodeCount > 0 && (
            <svg width={640} height={360} role="img" aria-label={t('notes.graph')} style={{ maxWidth: '100%', border: '1px solid #ccc' }}>
              {graph.edges.map((e, i) => {
                const from = graph.nodes.findIndex((n) => n.id === e.from);
                const to = graph.nodes.findIndex((n) => n.id === e.to);
                if (from < 0 || to < 0) return null;
                const p1 = graphPositions[from];
                const p2 = graphPositions[to];
                return <line key={i} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={e.auto ? '#999' : '#333'} strokeDasharray={e.auto ? '4 3' : undefined} />;
              })}
              {graph.nodes.map((n, i) => (
                <g key={n.id}>
                  <circle cx={graphPositions[i].x} cy={graphPositions[i].y} r={14 + Math.min(10, n.degree * 2)} fill="#bcd6ff" stroke="#333" />
                  <text x={graphPositions[i].x} y={graphPositions[i].y + 4} textAnchor="middle" fontSize={10}>{n.title.slice(0, 12)}</text>
                </g>
              ))}
            </svg>
          )}
          <ul>
            {graph.nodes.map((n) => (
              <li key={n.id}>
                {n.title} [{n.kind}] — degree {n.degree}
                {graph.edges.filter((e) => e.from === n.id).map((e) => {
                  const target = graph.nodes.find((x) => x.id === e.to);
                  return target ? ` · ${linkKindLabel(t, e.kind)} → ${target.title}` : '';
                })}
              </li>
            ))}
          </ul>
        </section>
      )}

      {showTimeline && (
        <section data-testid="notes-timeline">
          <h3>{t('notes.timeline')}</h3>
          {timeline.length === 0 && <p className="hint">{t('notes.timelineEmpty')}</p>}
          <ul>
            {timeline.map((e, i) => (
              <li key={`${e.at}-${i}`}>{formatDate(e.at)} — <strong>{e.noteTitle}</strong>: {e.detail}</li>
            ))}
          </ul>
        </section>
      )}

      <section data-testid="notes-benchmark">
        <h3>{t('notes.benchmark')}</h3>
        <p className="hint">{t('notes.benchmarkIntro')}</p>
        <button className="btn secondary" data-testid="notes-run-benchmark" onClick={() => void doBenchmark()} disabled={benchRunning}>
          {benchRunning ? t('notes.running') : t('notes.runBenchmark')}
        </button>
        {!benchmark && !benchRunning && <p className="hint">{t('notes.benchmarkEmpty')}</p>}
        {benchmark && (
          <table>
            <thead>
              <tr>
                <th>{t('notes.tasks')}</th>
                <th>R@1</th>
                <th>R@3</th>
                <th>R@5</th>
                <th>R@10</th>
                <th>{t('notes.mrr')}</th>
                <th>{t('notes.accuracy')}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>overall ({benchmark.metrics.overall.taskCount})</td>
                <td>{benchmark.metrics.overall.recallAt1}</td>
                <td>{benchmark.metrics.overall.recallAt3}</td>
                <td>{benchmark.metrics.overall.recallAt5}</td>
                <td>{benchmark.metrics.overall.recallAt10}</td>
                <td>{benchmark.metrics.overall.mrr}</td>
                <td>{benchmark.metrics.overall.accuracy}</td>
              </tr>
              {Object.entries(benchmark.metrics.byKind).map(([kind, m]) => (
                <tr key={kind}>
                  <td>{kind} ({m.taskCount})</td>
                  <td>{m.recallAt1}</td>
                  <td>{m.recallAt3}</td>
                  <td>{m.recallAt5}</td>
                  <td>{m.recallAt10}</td>
                  <td>{m.mrr}</td>
                  <td>{m.accuracy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {benchmark && (
          <p className="hint">
            {t('notes.seed')}: {benchmark.suiteSeed} · {t('notes.personas')}: 10 · {benchmark.methodNote}
          </p>
        )}
      </section>
    </div>
  );
}
